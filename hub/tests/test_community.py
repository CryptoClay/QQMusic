import asyncio
import io
import uuid
import wave
from datetime import timedelta

import httpx
import pytest
from sqlalchemy import func, select

from tests.test_library_care import care as care


async def collection(client, name="Together"):
    r = await client.post("/api/community/playlists", json={"name": name})
    assert r.status_code == 200, r.text
    return r.json()


async def patch(client, row, **values):
    return await client.patch(f"/api/community/playlists/{row['id']}", json={"revision": row["revision"], **values})


async def share(client, **body):
    r = await client.post("/api/community/shares", json={"kind": "track", "id": "nd:nd1", **body})
    assert r.status_code == 200, r.text
    return r.json(), r.json()["url"].split("/s/")[1]


async def test_collaboration_roles_conflicts_and_removal(care):
    owner, editor, stranger = care["user"], care["other"], care["admin"]
    row = await collection(owner)
    path = f"/api/community/playlists/{row['id']}"
    assert (await stranger.get(path)).status_code == 404  # admin is not an implicit collaborator
    r = await patch(owner, row, username="other-admin", role="listener")
    assert r.status_code == 200, r.text
    row = r.json()
    assert (await editor.get(path)).status_code == 200
    assert (await patch(editor, row, name="Hijack")).status_code == 403
    r = await patch(owner, row, username="other-admin", role="editor")
    old = row
    row = r.json()
    assert (await patch(owner, old, name="Stale edit")).status_code == 409
    r = await patch(editor, row, items=[{"ref": "nd:nd1", "title": "Song", "artist": "Band"}])
    assert r.status_code == 200, r.text
    row = r.json()
    assert (await patch(editor, row, username="admin", role="editor")).status_code == 403
    row = (await patch(owner, row, username="other-admin", role="remove")).json()
    assert (await editor.get(path)).status_code == 404
    assert len((await owner.get(path)).json()["items"]) == 1


async def test_requests_are_private_approved_once_and_notify_ready_once(care):
    from app.db import session_scope
    from app.models import DownloadItem, InboxMessage, MusicRequest

    r = await care["user"].post("/api/community/requests", json={"artist": "Band", "title": "Wish"})
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    duplicate = await care["user"].post("/api/community/requests", json={"artist": "Band", "title": "Wish"})
    assert duplicate.json()["id"] == rid
    assert (await care["other"].get("/api/community/requests")).json()[0]["user_id"] == 2  # admin overview
    decision = f"/api/community/requests/{rid}/decision"
    assert (await care["user"].post(decision, json={"action": "approve"})).status_code == 403
    r = await care["admin"].post(decision, json={"action": "approve"})
    assert r.status_code == 200 and r.json()["status"] == "preparing", r.text
    assert (await care["admin"].post(decision, json={"action": "approve"})).status_code == 409
    async with session_scope() as s:
        request = await s.get(MusicRequest, rid)
        item = await s.scalar(select(DownloadItem).where(DownloadItem.batch_id == request.batch_id))
        item.status, item.track_id = "done", 1
    for _ in range(2):
        inbox = await care["user"].get("/api/community/inbox")
        assert inbox.status_code == 200, inbox.text
    assert (await care["user"].get("/api/community/requests")).json()[0]["status"] == "ready"
    async with session_scope() as s:
        assert await s.scalar(select(func.count()).select_from(InboxMessage).where(
            InboxMessage.user_id == 2, InboxMessage.text.like("Готово:%"))) == 1
    await care["admin"].post("/api/community/inbox/read", json=[])
    assert (await care["user"].get("/api/community/inbox")).json()["unread"] == 2
    await care["user"].post("/api/community/inbox/read", json=[])
    assert (await care["user"].get("/api/community/inbox")).json()["unread"] == 0


async def test_resume_is_private_and_rejects_account_switch(care):
    body = {"account": 2, "label": "Laptop", "queue": [{"ref": "nd:nd1", "title": "Song"}], "index": 0, "position": 37}
    path = "/api/community/resume/device-test"
    assert (await care["user"].put(path, json=body)).status_code == 200
    assert (await care["admin"].get("/api/community/resume")).json() == []
    assert (await care["admin"].put(path, json=body)).status_code == 409
    rows = (await care["user"].get("/api/community/resume")).json()
    assert rows[0]["position"] == 37 and rows[0]["label"] == "Laptop"
    assert (await care["user"].put(path, json=body | {"index": 2})).status_code == 422
    await care["admin"].delete(path)
    assert len((await care["user"].get("/api/community/resume")).json()) == 1


async def test_version_preference_does_not_change_other_users(care):
    from types import SimpleNamespace

    from app.api.music import preferred_ref
    from app.db import session_scope
    from app.models import User

    body = {"name": "Song versions", "members": [{"track_id": 1, "kind": "original"}, {"track_id": 2, "kind": "clean"}]}
    assert (await care["user"].post("/api/community/versions", json=body)).status_code == 403
    r = await care["admin"].post("/api/community/versions", json=body)
    assert r.status_code == 200, r.text
    gid = r.json()["id"]
    r = await care["user"].put(f"/api/community/versions/{gid}/preference", json={"track_id": 2})
    assert r.status_code == 200, r.text
    assert (await care["admin"].get("/api/community/versions")).json()[0]["preferred_track_id"] is None
    assert (await care["user"].put(f"/api/community/versions/{gid}/preference", json={"track_id": 3})).status_code == 409
    async with session_scope() as s:
        user, admin = await s.get(User, 2), await s.get(User, 1)
    choice = SimpleNamespace(ref="nd:nd1", nd_song_id="nd1")
    assert await preferred_ref(user, choice) == "nd:nd2"
    assert await preferred_ref(admin, choice) == "nd:nd1"


async def test_public_link_scope_range_revoke_and_encrypted_storage(care):
    from app.db import session_scope
    from app.models import ShareLink

    row, token = await share(care["user"])
    async with httpx.AsyncClient(transport=care["user"]._transport, base_url="http://public.test") as anon:
        info = await anon.get("/api/public/" + token)
        assert info.status_code == 200, info.text
        data = info.json()
        assert not any(k in str(data) for k in ("password", "token_enc", "path", "note"))
        audio = await anon.get(data["tracks"][0]["stream_url"], headers={"Range": "bytes=0-31"})
        assert audio.status_code == 206 and len(audio.content) == 32
        assert (await anon.get(f"/api/public/{token}/audio/not-in-snapshot")).status_code == 404
        assert (await care["admin"].delete(f"/api/community/shares/{row['id']}")).status_code == 404
        async with session_scope() as s:
            stored = await s.get(ShareLink, row["id"])
            assert stored.token_hash != token and token not in stored.token_enc
        assert (await care["user"].get("/api/community/shares")).json()[0]["url"] == row["url"]
        await care["user"].delete(f"/api/community/shares/{row['id']}")
        assert (await anon.get("/api/public/" + token)).status_code == 404
        assert (await anon.get(data["tracks"][0]["stream_url"])).status_code == 404


async def test_member_link_removal_and_archive_revoke_access(care):
    owner, member = care["user"], care["other"]
    row = await collection(owner)
    row = (await patch(owner, row, items=[{"ref": "nd:nd1", "title": "Song", "artist": "Band"}],
                       username="other-admin", role="listener")).json()
    _link, token = await share(owner, kind="collection", id=str(row["id"]), access="members")
    async with httpx.AsyncClient(transport=owner._transport, base_url="http://public.test") as anon:
        assert (await anon.get("/api/public/" + token)).status_code == 403
    assert (await member.get("/api/public/" + token)).status_code == 200
    row = (await patch(owner, row, username="other-admin", role="remove")).json()
    assert (await member.get("/api/public/" + token)).status_code == 403
    await patch(owner, row, archived=True)
    assert (await owner.get("/api/public/" + token)).status_code == 404


async def test_expiry_and_recycled_database_id_cannot_expose_new_file(care):
    from app.db import session_scope
    from app.models import ShareLink, Track, utcnow

    link, token = await share(care["user"])
    original_uid = (await care["user"].get("/api/public/" + token)).json()["tracks"][0]["uid"]
    async with session_scope() as s:
        old = await s.get(Track, 1)
        path = old.path
        await s.delete(old)
        await s.flush()
        s.add(Track(id=1, uid=str(uuid.uuid4()), path=path, artist="Private", title="New recording", fingerprint="new"))
    assert (await care["user"].get(f"/api/public/{token}/audio/{original_uid}")).status_code == 404
    async with session_scope() as s:
        (await s.get(ShareLink, link["id"])).expires_at = utcnow() - timedelta(seconds=1)
    assert (await care["user"].get("/api/public/" + token)).status_code == 404


async def test_queue_limits_are_atomic_and_upload_limit_cleans_partial_file(care):
    from app.db import session_scope
    from app.models import DownloadItem

    r = await care["admin"].put("/api/community/limits/users/2", json={"max_queue": 1, "upload_mb": 1})
    assert r.status_code == 200, r.text
    assert (await care["user"].put("/api/community/limits/users/2", json={})).status_code == 403
    assert (await care["user"].get("/api/community/limits/users")).status_code == 403
    body = {"items": [{"artist": "Band", "title": "New"}]}
    results = await asyncio.gather(care["user"].post("/api/downloads", json=body), care["user"].post("/api/downloads", json=body))
    assert sorted(r.status_code for r in results) == [200, 429], [(r.status_code, r.text) for r in results]
    async with session_scope() as s:
        assert await s.scalar(select(func.count()).select_from(DownloadItem).where(DownloadItem.user_id == 2)) == 1
    audio = io.BytesIO()
    with wave.open(audio, "wb") as f:
        f.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        f.writeframes(b"\0\0" * (1024 * 1024))
    r = await care["user"].post("/api/uploads", files={"files": ("large.wav", audio.getvalue(), "audio/wav")})
    assert r.status_code == 413, r.text
    assert not list((care["music"] / "staging" / "uploads" / "2").glob("*.wav"))


async def test_storage_budget_blocks_upload_and_import_before_library_move(care):
    from fastapi import HTTPException

    from app.db import session_scope
    from app.library.importer import ImportSpec, import_file
    from app.models import Track

    r = await care["admin"].put("/api/community/limits/users/2", json={"storage_mb": 1})
    assert r.status_code == 200, r.text
    audio = io.BytesIO()
    with wave.open(audio, "wb") as f:
        f.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        f.writeframes(b"\0\0" * 600000)
    r = await care["user"].post("/api/uploads", files={"files": ("large.wav", audio.getvalue(), "audio/wav")})
    assert r.status_code == 413, r.text
    source = care["music"] / "staging" / "too-large.wav"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(audio.getvalue())
    with pytest.raises(HTTPException) as exc:
        async with session_scope() as s:
            await import_file(s, source, ImportSpec(artist="Band", title="Large", album_id=1, added_by=2))
    assert exc.value.status_code == 413 and source.exists()
    async with session_scope() as s:
        assert await s.scalar(select(func.count()).select_from(Track)) == 3
    assert len(list((care["music"] / "library").rglob("*.wav"))) == 3


async def test_parallel_limit_is_enforced_by_atomic_job_claim(care):
    from app.db import session_scope
    from app.jobs.queue import _claim, _finish, enqueue
    from app.models import DownloadBatch, DownloadItem, UserPolicy

    async with session_scope() as s:
        s.add(UserPolicy(user_id=2, parallel=1))
        for uid in (2, 2, 1):
            batch = DownloadBatch(user_id=uid, origin="test")
            s.add(batch)
            await s.flush()
            item = DownloadItem(batch_id=batch.id, user_id=uid, query_json={})
            s.add(item)
            await s.flush()
            await enqueue(s, "download_item", {"item_id": item.id})
    first, second = await _claim("worker-a"), await _claim("worker-b")
    assert first.payload_json["item_id"] == 1
    assert second.payload_json["item_id"] == 3  # does not take the second slot from user 2
    assert await _claim("worker-c") is None
    await _finish(first.id, ok=True)
    assert (await _claim("worker-c")).payload_json["item_id"] == 2


async def test_version_group_can_be_revised_and_unlinked_without_deleting_audio(care):
    from app.db import session_scope
    from app.models import Track

    body = {"name": "Versions", "members": [{"track_id": 1, "kind": "original"}, {"track_id": 2, "kind": "clean"}]}
    row = (await care["admin"].post("/api/community/versions", json=body)).json()
    path = f"/api/community/versions/{row['id']}"
    assert (await care["admin"].put(path, json=body | {"revision": row["revision"], "name": "Revised"})).status_code == 200
    assert (await care["admin"].put(path, json=body | {"revision": row["revision"]})).status_code == 409
    assert (await care["user"].delete(path)).status_code == 403
    assert (await care["admin"].delete(path)).status_code == 200
    assert (await care["user"].get("/api/community/versions")).json() == []
    async with session_scope() as s:
        assert await s.scalar(select(func.count()).select_from(Track)) == 3
    assert all(p.exists() for p in care["paths"])


async def test_single_file_limit_also_applies_to_download_import(care):
    from fastapi import HTTPException

    from app.db import session_scope
    from app.library.importer import ImportSpec, import_file

    await care["admin"].put("/api/community/limits/users/2", json={"upload_mb": 1})
    path = care["music"] / "staging" / "download.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as f:
        f.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        f.writeframes(b"\0\0" * 600000)
    with pytest.raises(HTTPException) as error:
        async with session_scope() as s:
            await import_file(s, path, ImportSpec(artist="Band", title="Too large", album_id=1, added_by=2))
    assert error.value.status_code == 413 and "лимита" in error.value.detail
    assert path.exists()


async def test_approval_over_queue_budget_rolls_back_request_and_batch(care):
    from app.db import session_scope
    from app.models import DownloadBatch, MusicRequest

    await care["admin"].put("/api/community/limits/users/2", json={"max_queue": 1})
    r = await care["user"].post("/api/downloads", json={"items": [{"artist": "Band", "title": "First"}]})
    assert r.status_code == 200, r.text
    row = (await care["user"].post("/api/community/requests", json={"artist": "Band", "title": "Second"})).json()
    r = await care["admin"].post(f"/api/community/requests/{row['id']}/decision", json={"action": "approve"})
    assert r.status_code == 429, r.text
    async with session_scope() as s:
        assert (await s.get(MusicRequest, row["id"])).status == "pending"
        assert await s.scalar(select(func.count()).select_from(DownloadBatch)) == 1


async def test_concurrent_multi_file_imports_do_not_invert_database_and_library_locks(care):
    import shutil

    from app.db import session_scope
    from app.library.importer import ImportSpec, import_file
    from app.models import Track

    staging = care["music"] / "staging"
    staging.mkdir(parents=True, exist_ok=True)
    sources = [staging / f"concurrent-{i}.wav" for i in range(3)]
    for path in sources:
        shutil.copyfile(care["paths"][0], path)
    async def batch():
        async with session_scope() as s:
            for i in (0, 1):
                await import_file(s, sources[i], ImportSpec(artist="Batch", title=f"Song {i}", album_id=1, added_by=2))
                await asyncio.sleep(0)
    async def other_user():
        async with session_scope() as s:
            await import_file(s, sources[2], ImportSpec(artist="Other", title="Concurrent", album_id=1, added_by=3))
    await asyncio.wait_for(asyncio.gather(batch(), other_user()), timeout=5)
    async with session_scope() as s:
        assert await s.scalar(select(func.count()).select_from(Track)) == 6
    assert all(not p.exists() for p in sources)


async def test_share_snapshot_does_not_expand_and_private_file_refs_are_rejected(care):
    owner = care["user"]
    row = await collection(owner)
    song = {"ref": "nd:nd1", "title": "One", "artist": "Band"}
    row = (await patch(owner, row, items=[song])).json()
    _link, token = await share(owner, kind="collection", id=str(row["id"]))
    await patch(owner, row, items=[song, song | {"ref": "nd:nd2"}])
    assert len((await owner.get("/api/public/" + token)).json()["tracks"]) == 1
    row = (await owner.get(f"/api/community/playlists/{row['id']}")).json()
    assert (await patch(owner, row, items=[song | {"ref": "file:private-secret"}])).status_code == 422
    assert (await owner.post("/api/community/shares", json={"kind": "track", "id": "file:private-secret"})).status_code == 409
    await patch(owner, row, archived=True)
    row = (await owner.get(f"/api/community/playlists/{row['id']}")).json()
    assert (await patch(owner, row, name="Not while archived")).status_code == 409
    assert (await patch(owner, row, archived=False)).status_code == 200


async def test_retry_routes_cannot_bypass_queue_budget(care):
    from app.db import session_scope
    from app.models import DownloadItem

    r = await care["user"].post("/api/downloads", json={"items": [
        {"artist": "Band", "title": "One new"}, {"artist": "Band", "title": "Two new"}]})
    assert r.status_code == 200, r.text
    await care["admin"].put("/api/community/limits/users/2", json={"max_queue": 1})
    async with session_scope() as s:
        (await s.get(DownloadItem, 2)).status = "failed"
    single = await care["user"].post("/api/downloads/items/2/retry", json={})
    assert single.status_code == 429, single.text
    batch = await care["user"].post("/api/downloads/retry-batch", json={"ids": [2]})
    assert batch.status_code == 429, batch.text
    async with session_scope() as s:
        assert (await s.get(DownloadItem, 2)).status == "failed"


async def test_failed_multi_file_upload_cleans_every_file_and_database_row(care):
    from app.db import session_scope
    from app.models import Upload

    await care["admin"].put("/api/community/limits/users/2", json={"storage_mb": 1})
    data = io.BytesIO()
    with wave.open(data, "wb") as f:
        f.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        f.writeframes(b"\0\0" * 300000)
    r = await care["user"].post("/api/uploads", files=[
        ("files", ("first.wav", data.getvalue(), "audio/wav")),
        ("files", ("second.wav", data.getvalue(), "audio/wav"))])
    assert r.status_code == 413, r.text
    async with session_scope() as s:
        assert await s.scalar(select(func.count()).select_from(Upload).where(Upload.user_id == 2)) == 0
    assert not list((care["music"] / "staging" / "uploads" / "2").glob("*.wav"))


async def test_cancelled_upload_waits_for_file_descriptor_then_cleans_up(care, monkeypatch):
    import threading

    from app.api import uploads
    from app.db import session_scope
    from app.models import Upload

    started, release = threading.Event(), threading.Event()
    original = uploads._copy_limited
    def slow_copy(*args):
        started.set()
        release.wait(timeout=3)
        return original(*args)
    monkeypatch.setattr(uploads, "_copy_limited", slow_copy)
    task = asyncio.create_task(care["user"].post("/api/uploads", files={
        "files": ("cancelled.wav", care["paths"][0].read_bytes(), "audio/wav")}))
    assert await asyncio.to_thread(started.wait, 2)
    task.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    async with session_scope() as s:
        assert await s.scalar(select(func.count()).select_from(Upload)) == 0
    assert not list((care["music"] / "staging" / "uploads" / "2").glob("*.wav"))


async def test_usage_measures_pre_migration_files_without_changing_audio(care):
    from app.db import session_scope
    from app.models import Track

    original = care["paths"][0].read_bytes()
    async with session_scope() as s:
        track = await s.get(Track, 1)
        track.added_by, track.size_bytes = 2, None
    response = await care["user"].get("/api/community/limits")
    assert response.status_code == 200, response.text
    assert response.json()["used_bytes"] == len(original)
    assert response.json()["storage_mb"] == 0
    assert care["paths"][0].read_bytes() == original
