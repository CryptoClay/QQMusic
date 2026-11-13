"""Queue ownership/idempotency, preparation budget and private cloud library."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from sqlalchemy import select

from app.db import session_scope
from app.models import DownloadBatch, DownloadItem, Job, NextcloudPlaylist
from app.security import decrypt
from tests.test_nextcloud_api import CONFIG, setup

pytest_plugins = ["tests.test_nextcloud_api"]


async def test_cloud_browse_metadata_and_private_playlist(cloud):
    client, _ = cloud
    token = await setup(client)
    browse = await client.get("/api/nextcloud/browse")
    assert browse.status_code == 200 and browse.json()["files"][0]["title"] == "Song"
    assert "no-store" in browse.headers["cache-control"]
    meta = await client.get("/api/nextcloud/metadata", params={"file": token})
    assert meta.status_code == 200 and meta.json()["artist"] == "Artist"
    created = await client.post("/api/nextcloud/playlists", json={"name": "Private", "files": [token]})
    assert created.status_code == 200, created.text
    pid = created.json()["id"]
    async with session_scope() as s:
        row = await s.get(NextcloudPlaylist, pid)
        assert "cloud.example" not in str(row.items_json)
        assert decrypt(row.items_json[0]["url_enc"]).endswith("Song.mp3")
    added = await client.post(f"/api/nextcloud/playlists/{pid}/items", json={"name": "Private", "files": [token]})
    assert added.status_code == 200, added.text
    lists = (await client.get("/api/nextcloud/playlists")).json()
    assert len(lists[0]["files"]) == 2 and lists[0]["available"]
    assert (await client.put("/api/nextcloud/connection", headers={"x-test-user": "2"}, json=CONFIG)).status_code == 200
    assert (await client.get("/api/nextcloud/playlists", headers={"x-test-user": "2"})).json() == []
    assert (await client.delete(f"/api/nextcloud/playlists/{pid}", headers={"x-test-user": "2"})).status_code == 404
    assert (
        await client.get("/api/nextcloud/browse", params={"folder": token}, headers={"x-test-user": "2"})
    ).status_code == 404
    await client.put("/api/nextcloud/connection", json={**CONFIG, "folder": "Other"})
    assert not (await client.get("/api/nextcloud/playlists")).json()[0]["available"]
    assert (await client.delete(f"/api/nextcloud/playlists/{pid}")).status_code == 200


async def test_bulk_retry_owned_atomic_idempotent_and_priority(cloud):
    client, _ = cloud
    async with session_scope() as s:
        batches = [DownloadBatch(user_id=uid, origin="search") for uid in (1, 2)]
        s.add_all(batches)
        await s.flush()
        items = [
            DownloadItem(batch_id=batches[0].id, user_id=1, query_json={}, status=status)
            for status in ("failed", "needs_review", "failed", "done")
        ]
        items.append(DownloadItem(batch_id=batches[1].id, user_id=2, query_json={}, status="failed"))
        s.add_all(items)
        await s.flush()
        ids = [item.id for item in items]
        s.add_all(
            [
                Job(kind="download_item", payload_json={"item_id": ids[0]}, status="queued"),
                Job(kind="download_item", payload_json={"item_id": ids[2]}, status="running"),
            ]
        )
        await s.commit()
    assert (await client.post("/api/downloads/retry-batch", json={"ids": [ids[0], ids[4]]})).status_code == 404
    result = await client.post("/api/downloads/retry-batch", json={"ids": ids[:4]})
    assert result.status_code == 200, result.text
    assert result.json() == {"queued": 2, "skipped": 2}
    assert (await client.post("/api/downloads/retry-batch", json={"ids": ids[:4]})).json()["queued"] == 0
    assert (await client.post(f"/api/downloads/items/{ids[0]}/priority")).json()["updated"] == 1
    assert (await client.post(f"/api/downloads/items/{ids[4]}/priority")).status_code == 404
    async with session_scope() as s:
        jobs = (await s.execute(select(Job).where(Job.status == "queued"))).scalars().all()
        assert len(jobs) == 2
        assert next(j for j in jobs if j.payload_json["item_id"] == ids[0]).priority == 100


async def test_warm_budget_and_status(hub_env, monkeypatch):
    from app import listen, preparation

    preparation.reset()
    candidate = SimpleNamespace(duration_s=1, bitrate_kbps=1, provider="demo")
    choice = SimpleNamespace(kind="full", candidate=candidate, duration_s=1, local=None)
    calls = []

    class Copy:
        have = 40
        done = True
        failed = None
        byte_limit = None

        async def until(self, condition):
            calls.append(self.byte_limit)

        def settled(self):
            return True

    monkeypatch.setattr(preparation, "WARM_BYTES", 64)
    monkeypatch.setattr(listen, "choose", AsyncMock(return_value=choice))
    monkeypatch.setattr(listen, "_downloads_only", lambda c: False)
    monkeypatch.setattr(listen, "_server_copy", lambda c, **kw: Copy())
    # Estimate must fit the small test budget.
    candidate.bitrate_kbps = 0.1
    await preparation._warm(["a", "b"])
    assert calls == [64, 24]
    listen._choices["test"] = choice
    listen._fetching["test"] = object()
    listen._local_progress["test"] = 0.4
    assert preparation.status("test") == {"stage": "preparing", "progress": 0.4}
    listen._choices.pop("test")
    listen._fetching.pop("test")
    listen._local_progress.pop("test")
    assert preparation.status("missing")["stage"] == "checking"
    preparation.reset()


async def test_prepare_replaces_and_cancels(hub_env, monkeypatch):
    from app import listen, preparation

    preparation.reset()
    monkeypatch.setattr(preparation, "_warm", lambda refs: asyncio.sleep(10))
    assert preparation.prepare(1, ["a", "b"]) == 2
    task = preparation._jobs[1][1]
    assert preparation.prepare(1, ["a", "b"]) == 2 and preparation._jobs[1][1] is task
    assert preparation.prepare(1, []) == 0
    await asyncio.sleep(0)
    assert task.cancelled()
    await listen.reset()


def test_cloud_reads_embedded_tags_and_resizes_cover(tmp_path):
    from mutagen.id3 import APIC, ID3, TALB, TIT2, TPE1

    from app.api.cloud_library import read_tags
    from tests.test_flow import jpeg_bytes, make_mp3

    path = make_mp3(tmp_path / "tagged.mp3")
    tags = ID3(path)
    tags.add(TIT2(encoding=3, text="Название"))
    tags.add(TPE1(encoding=3, text="Исполнитель"))
    tags.add(TALB(encoding=3, text="Альбом"))
    tags.add(APIC(encoding=3, mime="image/jpeg", type=3, data=jpeg_bytes()))
    tags.save(path)
    result = read_tags(path.read_bytes())
    assert result["title"] == "Название" and result["artist"] == "Исполнитель"
    assert result["album"] == "Альбом" and result["cover_url"].startswith("data:image/jpeg;base64,")
    assert result["duration_s"] > 3


async def test_source_observations_are_sanitized_and_check_is_admin_only(cloud):
    from app.services import svc
    from app.source_status import _states, record

    client, _ = cloud
    name = next(iter(svc.providers))
    try:
        record(name, "audio", False, "403 https://private.test?token=secret")
        result = await client.get("/api/system/sources")
        assert result.status_code == 200
        assert "secret" not in result.text and "private.test" not in result.text
        source = next(row for row in result.json()["sources"] if row["name"] == name)
        assert source["audio"]["reason"] == "forbidden"
        assert (await client.post("/api/system/sources/check", headers={"x-test-user": "2"})).status_code == 403
        assert (await client.get("/api/listen/status", params={"ref": "dz:1"})).status_code == 200
        assert (await client.post("/api/listen/prepare", json={"refs": ["a", "b", "c"]})).status_code == 422
    finally:
        _states.clear()
