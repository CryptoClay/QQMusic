"""Queue control ownership, finite retries, reviewed multi-file metadata changes and rollback."""

import asyncio
import base64
import io
from datetime import date

import httpx
import pytest
from PIL import Image
from sqlalchemy import select

from tests.test_library_care import care as care


async def items_for_users():
    from app.db import session_scope
    from app.jobs.queue import enqueue
    from app.models import DownloadBatch, DownloadItem

    result = []
    async with session_scope() as s:
        for uid in (1, 2):
            batch = DownloadBatch(user_id=uid, origin="manual")
            s.add(batch)
            await s.flush()
            item = DownloadItem(
                user_id=uid, batch_id=batch.id, query_json={"query": {"artist": "Band", "title": "Song"}}
            )
            s.add(item)
            await s.flush()
            job = await enqueue(s, "download_item", {"item_id": item.id}, max_attempts=3)
            result.append((item.id, job.id))
    return result


async def test_pause_is_persistent_account_scoped_and_does_not_block_other_users(care):
    from app.db import session_scope
    from app.jobs.queue import _claim, _next_wakeup_in
    from app.models import DownloadControl

    entries = await items_for_users()
    assert (await care["user"].put("/api/downloads/control", json={"paused": True})).status_code == 200
    r = await care["user"].get("/api/downloads/control")
    assert r.json()["paused"] and set(r.json()["items"]) == {str(entries[1][0])}
    assert not (await care["admin"].get("/api/downloads/control")).json()["paused"]
    job = await _claim("first")
    assert job.id == entries[0][1]
    assert await _claim("second") is None
    assert await _next_wakeup_in() > 0
    async with session_scope() as s:
        assert (await s.get(DownloadControl, 2)).paused
    await care["user"].put("/api/downloads/control", json={"paused": False})
    assert (await _claim("second")).id == entries[1][1]


async def test_priority_is_owned_and_changes_claim_order(care):
    from app.jobs.queue import _claim

    entries = await items_for_users()
    url = f"/api/downloads/items/{entries[1][0]}/priority"
    assert (await care["admin"].post(url, json={"priority": 100})).status_code == 404
    assert (await care["user"].post(url, json={"priority": 100})).status_code == 200
    assert (await _claim("test")).id == entries[1][1]
    assert (await care["user"].post(url, json={"priority": 50})).status_code == 409


async def test_simultaneous_manual_retries_create_one_job(care):
    from app.db import session_scope
    from app.models import DownloadItem, Job

    entries = await items_for_users()
    item_id, job_id = entries[1]
    async with session_scope() as s:
        (await s.get(DownloadItem, item_id)).status = "failed"
        (await s.get(Job, job_id)).status = "failed"
    responses = await asyncio.gather(
        *(care["user"].post(f"/api/downloads/items/{item_id}/retry", json={}) for _ in range(6))
    )
    assert sum(r.status_code == 200 for r in responses) == 1
    assert all(r.status_code in (200, 409) for r in responses)
    async with session_scope() as s:
        jobs = list(await s.scalars(select(Job).where(Job.kind == "download_item", Job.status == "queued")))
        assert sum(j.payload_json["item_id"] == item_id for j in jobs) == 1


@pytest.mark.parametrize(
    "error,retry",
    [
        (httpx.ReadTimeout("slow"), True),
        (RuntimeError("HTTP 503 temporary outage"), True),
        (ValueError("bad tags"), False),
        (RuntimeError("403 not a bot"), False),
        (RuntimeError("unknown programmer failure"), False),
        (PermissionError("disk"), False),
    ],
)
async def test_download_job_retries_only_known_temporary_errors(care, monkeypatch, error, retry):
    from app.db import session_scope
    from app.jobs import queue
    from app.models import Job

    await items_for_users()
    failed = []

    async def handler(job):
        raise error

    async def failure(job, exc):
        failed.append(job.id)

    monkeypatch.setitem(queue._handlers, "download_item", handler)
    monkeypatch.setitem(queue._failure_hooks, "download_item", failure)
    job = await queue._claim("retry")
    await queue.run_job(job)
    async with session_scope() as s:
        stored = await s.get(Job, job.id)
        assert stored.status == ("queued" if retry else "failed")
        assert failed == ([] if retry else [job.id])
        assert stored.attempts == 1


async def review(care, action, id=1, **kwargs):
    result = await care["admin"].post("/api/library/preview", json={"action": action, "id": id, **kwargs})
    assert result.status_code == 200, result.text
    return result.json()


async def test_bulk_numbering_uses_reviewed_order_and_keeps_track_identity(care):
    from app.db import session_scope
    from app.library import tagger
    from app.library.importer import library_abs
    from app.models import Track

    async with session_scope() as s:
        before = {t.id: t.uid for t in await s.scalars(select(Track))}
    p = await review(care, "number", ids=[2, 1], fields={"start": 4, "disc_no": 2})
    assert p["track_count"] == 2 and p["changes"][0]["after"] == 4
    assert (await care["admin"].post("/api/library/apply", json={"token": p["token"]})).status_code == 200
    async with session_scope() as s:
        a, b = await s.get(Track, 2), await s.get(Track, 1)
        assert (a.track_no, b.track_no, a.disc_no, b.disc_no) == (4, 5, 2, 2)
        assert a.uid == before[2] and b.uid == before[1]
        tags = tagger.read_tags(library_abs(a.path))
        assert tags["track_no"] == 4


async def test_full_release_date_survives_other_album_edits(care):
    from app.db import session_scope
    from app.library import tagger
    from app.library.importer import library_abs
    from app.models import Album, Track

    for fields in ({"release_date": "2001-04-03"}, {"genre": "New genre"}):
        p = await review(care, "album", fields=fields)
        r = await care["admin"].post("/api/library/apply", json={"token": p["token"]})
        assert r.status_code == 200, r.text
    async with session_scope() as s:
        assert (await s.get(Album, 1)).release_date == date(2001, 4, 3)
        assert tagger.read_tags(library_abs((await s.get(Track, 1)).path))["date"] == "2001-04-03"


async def test_cover_preview_does_not_write_and_stale_cover_is_rejected(care):
    from app.db import session_scope
    from app.library.importer import album_reldir, library_abs
    from app.models import Album

    image = io.BytesIO()
    Image.new("RGB", (32, 32), "orange").save(image, format="PNG")
    p = await review(care, "cover", fields={"cover_data": base64.b64encode(image.getvalue()).decode()})
    assert p["cover_preview"].startswith("data:image/jpeg;base64,")
    async with session_scope() as s:
        path = library_abs(album_reldir(await s.get(Album, 1))) / "cover.jpg"
    assert not path.exists()
    path.write_bytes(b"changed")
    assert (await care["admin"].post("/api/library/apply", json={"token": p["token"]})).status_code == 409
    assert path.read_bytes() == b"changed"


async def test_multi_file_metadata_failure_restores_files_and_database(care, monkeypatch):
    from app.db import session_scope
    from app.library import editor
    from app.models import Track

    before = [p.read_bytes() for p in care["paths"]]
    original = editor.update_track
    calls = 0

    async def fail_second(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("test disk failure")
        return await original(*args, **kwargs)

    p = await review(care, "tracks", ids=[1, 2], fields={"artist": "Changed"})
    monkeypatch.setattr(editor, "update_track", fail_second)
    result = await care["admin"].post("/api/library/apply", json={"token": p["token"]})
    assert result.status_code == 500
    assert [p.read_bytes() for p in care["paths"]] == before
    async with session_scope() as s:
        assert (await s.get(Track, 1)).artist == "Band"


async def test_disconnect_during_reviewed_write_finishes_before_session_closes(care, monkeypatch):
    from app.db import session_scope
    from app.library import editor
    from app.models import Track

    entered, proceed = asyncio.Event(), asyncio.Event()
    original = editor.update_track

    async def slow_write(*args, **kwargs):
        entered.set()
        await proceed.wait()
        return await original(*args, **kwargs)

    p = await review(care, "tracks", ids=[1, 2], fields={"artist": "Updated"})
    monkeypatch.setattr(editor, "update_track", slow_write)
    request = asyncio.create_task(care["admin"].post("/api/library/apply", json={"token": p["token"]}))
    await asyncio.wait_for(entered.wait(), 3)
    request.cancel()
    await asyncio.sleep(0)
    assert not request.done()
    proceed.set()
    with pytest.raises(asyncio.CancelledError):
        await request
    async with session_scope() as s:
        assert (await s.get(Track, 1)).artist == "Updated"
        assert (await s.get(Track, 2)).artist == "Updated"


async def test_reviewed_cover_keeps_uuid_and_updates_actual_storage_sizes(care):
    from app.db import session_scope
    from app.library.importer import library_abs
    from app.models import Track

    image = io.BytesIO()
    Image.new("RGB", (64, 64), "orange").save(image, format="PNG")
    async with session_scope() as s:
        identity = {t.id: t.uid for t in await s.scalars(select(Track))}
    p = await review(care, "cover", fields={"cover_data": base64.b64encode(image.getvalue()).decode()})
    result = await care["admin"].post("/api/library/apply", json={"token": p["token"]})
    assert result.status_code == 200, result.text
    async with session_scope() as s:
        for track in await s.scalars(select(Track).where(Track.album_id == 1)):
            assert track.uid == identity[track.id]
            assert track.size_bytes == library_abs(track.path).stat().st_size
