"""Account isolation, literal local search, version identity and sanitized operational data."""
from sqlalchemy import select

from tests.test_library_care import care as care


async def test_welcome_preserves_sound_settings_and_is_account_scoped(care):
    client = care["user"]
    assert not (await client.get("/api/experience/home")).json()["welcome_done"]
    assert (await client.put("/api/music/preferences", json={"prefer_original": True})).status_code == 200
    assert (await client.put("/api/experience/welcome")).status_code == 200
    assert (await client.get("/api/music/preferences")).json()["prefer_original"]
    assert (await client.get("/api/experience/home")).json()["welcome_done"]
    await client.put("/api/music/preferences", json={"crossfade_s": 3})
    assert (await client.get("/api/experience/home")).json()["welcome_done"]
    assert not (await care["admin"].get("/api/experience/home")).json()["welcome_done"]


async def test_home_never_exposes_other_devices_or_playlists(care):
    from app.db import session_scope
    from app.models import CommunityPlaylist, ResumeState

    async with session_scope() as s:
        s.add_all([CommunityPlaylist(owner_id=1, name="private", items_json=[], members_json={}),
                   CommunityPlaylist(owner_id=1, name="shared", items_json=[], members_json={"2": "listener"}),
                   ResumeState(user_id=1, device="private-device", data_json={"queue": []}),
                   ResumeState(user_id=2, device="own-device", data_json={"queue": [], "position": 12})])
    r = await care["user"].get("/api/experience/home")
    assert r.headers["cache-control"] == "private, no-store"
    assert r.json()["resume"]["device"] == "own-device"
    assert [p["name"] for p in r.json()["playlists"]] == ["shared"]
    assert "private-device" not in r.text


async def test_local_search_quality_availability_unicode_and_literal_wildcards(care):
    from app.db import session_scope
    from app.models import Track

    async with session_scope() as s:
        tracks = list(await s.scalars(select(Track).order_by(Track.id)))
        tracks[0].artist, tracks[0].title, tracks[0].codec = "Кино", "Группа крови", "flac"
        tracks[1].title, tracks[1].codec = "100%_song", "mp3"
    care["paths"][2].unlink()
    c = care["user"]
    r = await c.get("/api/search/library", params={"q": "КИНО крови", "quality": "lossless", "available": True})
    assert r.status_code == 200, r.text
    assert r.json()["total"] == 1 and r.json()["tracks"][0]["available"]
    assert (await c.get("/api/search/library", params={"q": "%_"})).json()["total"] == 1
    assert (await c.get("/api/search/library", params={"available": True})).json()["total"] == 2
    assert (await c.get("/api/search/library", params={"limit": 1})).json()["next_offset"] == 1
    assert (await c.get("/api/search/library", params={"quality": "bad"})).status_code == 422
    from app.api.search import search_library
    async with session_scope() as s:
        assert len(await search_library(s, "%_")) == 1


async def test_server_admin_only_and_never_returns_secret_exception_text(care, monkeypatch):
    async def ping():
        return True
    monkeypatch.setattr("app.api.system._navidrome_ok", ping)
    from app.db import session_scope
    from app.models import DownloadBatch, DownloadItem

    async with session_scope() as s:
        batch = DownloadBatch(user_id=2, origin="manual", title="test")
        s.add(batch)
        await s.flush()
        s.add(DownloadItem(batch_id=batch.id, user_id=2, query_json={"query": {"artist": "Band", "title": "Song"}},
                           status="failed", error="403 https://secret.example/?token=secret-token"))
    assert (await care["user"].get("/api/experience/server")).status_code == 403
    r = await care["admin"].get("/api/experience/server")
    assert r.status_code == 200, r.text
    assert r.json()["failures"][0]["reason"] == "forbidden"
    assert r.json()["failures"][0]["title"] == "Song"
    assert "secret-token" not in r.text and str(care["music"]) not in r.text
    assert r.json()["downloads"]["failed"] == 1
    assert len(r.json()["disks"]) == 2


def test_catalog_duplicate_recording_preserves_clean_and_live_versions():
    from app.api.search import _unique
    from app.catalog.models import CatalogTrack

    base = {"source": "dz", "title": "Song", "artist": "Band", "isrc": "ISRC1", "duration_s": 180}
    tracks = [CatalogTrack(**{**base, "id": str(i), "ref": f"dz:{i}", **overrides}) for i, overrides in enumerate(
        ({}, {}, {"title": "Song (Live)"}, {"explicit": False}, {"duration_s": 190}), 1)]
    assert [t.ref for t in _unique(tracks)] == ["dz:1", "dz:3", "dz:4", "dz:5"]
