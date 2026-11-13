"""Reviewed shared-library edits: identity, permissions, stale data and file rollback."""
import hashlib
import uuid
import wave
from datetime import timedelta

import httpx
import pytest
from sqlalchemy import select


@pytest.fixture
async def care(hub_env):
    from app.db import dispose, session_scope
    from app.library.importer import album_reldir, library_abs
    from app.library.tagger import TagData, write_tags
    from app.main import create_app
    from app.models import Album, Session, Track, User, utcnow
    from app.security import new_token

    tokens = []
    paths = []
    async with session_scope() as s:
        for username, admin in (("admin", True), ("listener", False), ("other-admin", True)):
            u = User(nd_username=username, nd_password_enc="unused", is_admin=admin)
            s.add(u)
            await s.flush()
            token, digest = new_token()
            tokens.append(token)
            s.add(Session(id=digest, user_id=u.id, expires_at=utcnow() + timedelta(days=1)))
        albums = [Album(uid=str(uuid.uuid4()), title="Record", album_artist="Band", year=2000, genre="Rock")
                  for _ in range(2)]
        s.add_all(albums)
        await s.flush()
        for i, (title, duration, album) in enumerate((("Song", 180, albums[0]), ("Song", 182, albums[0]),
                                                     ("Song (Live)", 180, albums[1])), 1):
            path = library_abs(album_reldir(album)) / f"{i}.wav"
            path.parent.mkdir(parents=True, exist_ok=True)
            with wave.open(str(path), "wb") as file:
                file.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
                file.writeframes(b"\0\0" * 8000)
            uid = str(uuid.uuid4())
            write_tags(path, TagData(title=title, artist="Band", track_uid=uid, album_uid=album.uid,
                                     genre="Rock", track_no=i, date="2000"))
            s.add(Track(uid=uid, album_id=album.id, path=path.relative_to(hub_env / "library").as_posix(),
                        nd_song_id=f"nd{i}", artist="Band", title=title, album="Record", album_artist="Band",
                        duration_s=duration, explicit=True, year=2000, genre="Rock", track_no=i,
                        fingerprint=f"band|{title}", locked=False))
            paths.append(path)
    clients = [httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(), raise_app_exceptions=False),
                                base_url="http://care.test", cookies={"qqmusic_session": token}) for token in tokens]
    try:
        yield {"admin": clients[0], "user": clients[1], "other": clients[2], "paths": paths, "music": hub_env}
    finally:
        for client in clients:
            await client.aclose()
        await dispose()


def checksum(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


async def preview(c, action="track", id=1, **kw):
    response = await c.post("/api/library/preview", json={"action": action, "id": id, **kw})
    assert response.status_code == 200, response.text
    return response.json()


async def test_report_distinguishes_live_and_reading_does_not_change_audio(care):
    before = [checksum(p) for p in care["paths"]]
    r = await care["admin"].get("/api/library/health")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["tracks"] == 3 and data["missing"] == data["unlinked"] == 0
    assert data["duplicate_groups"] == 1
    assert [t["id"] for t in data["duplicates"][0]["tracks"]] == [1, 2]
    assert data["album_group_count"] == 1
    assert before == [checksum(p) for p in care["paths"]]


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/library/health", None),
    ("POST", "/api/library/preview", {"action": "track", "id": 1, "fields": {"title": "Changed"}}),
    ("POST", "/api/library/apply", {"token": "wrong"}),
    ("PATCH", "/api/library/tracks/1", {"title": "Changed"}),
    ("PATCH", "/api/library/albums/1", {"title": "Changed"}),
    ("POST", "/api/library/albums/merge", {"source_ids": [2], "target_id": 1}),
    ("DELETE", "/api/library/tracks/1", None),
])
async def test_listener_cannot_change_shared_library(care, method, path, body):
    assert (await care["user"].request(method, path, json=body)).status_code == 403


async def test_review_then_clear_tags_keeps_track_uuid(care):
    from app.db import session_scope
    from app.library.tagger import read_tag_fields
    from app.models import Track

    c = care["admin"]
    original = care["paths"][0]
    before = checksum(original)
    uid = read_tag_fields(original)["track_uid"]
    p = await preview(c, fields={"title": "Corrected", "track_no": None, "genre": None, "explicit": None})
    assert p["can_apply"] and checksum(original) == before
    r = await c.post("/api/library/apply", json={"token": p["token"]})
    assert r.status_code == 200, r.text
    async with session_scope() as s:
        t = await s.get(Track, 1)
        assert t.title == "Corrected" and t.genre is None and t.track_no is None and t.explicit is None
        path = care["music"] / "library" / t.path
        tags = read_tag_fields(path)
        assert tags["track_uid"] == uid
        assert not tags.get("genre") and not tags.get("track_no") and tags.get("explicit") is None
    assert (await c.post("/api/library/apply", json={"token": p["token"]})).status_code == 409


@pytest.mark.parametrize("change", ["file", "database", "directory"])
async def test_stale_preview_is_rejected(care, change):
    from app.db import session_scope
    from app.models import Track

    c = care["admin"]
    p = await preview(c, fields={"title": "Changed"})
    if change == "file":
        with care["paths"][0].open("ab") as f:
            f.write(b"changed")
    elif change == "database":
        async with session_scope() as s:
            (await s.get(Track, 1)).title = "Someone edited this"
    else:
        (care["paths"][0].parent / "new-file.txt").write_text("new")
    r = await c.post("/api/library/apply", json={"token": p["token"]})
    assert r.status_code == 409, r.text


async def test_missing_file_blocks_edit_and_token_is_bound_to_admin(care):
    p = await preview(care["admin"], fields={"title": "Changed"})
    assert (await care["other"].post("/api/library/apply", json={"token": p["token"]})).status_code == 409
    care["paths"][0].unlink()
    p = await preview(care["admin"], fields={"title": "Changed"})
    assert not p["can_apply"]
    assert (await care["admin"].post("/api/library/apply", json={"token": p["token"]})).status_code == 409


async def test_failed_second_file_restores_first_file_and_database(care, monkeypatch):
    from app.db import session_scope
    from app.library import tagger
    from app.models import Album, Track

    before = {p: p.read_bytes() for p in care["paths"]}
    p = await preview(care["admin"], action="album", fields={"title": "Renamed"})
    real_write = tagger.write_tags
    writes = 0
    def fail_second(*args, **kwargs):
        nonlocal writes
        writes += 1
        if writes == 2:
            raise OSError("simulated disk failure")
        return real_write(*args, **kwargs)
    monkeypatch.setattr(tagger, "write_tags", fail_second)
    r = await care["admin"].post("/api/library/apply", json={"token": p["token"]})
    assert r.status_code == 500
    assert all(path.read_bytes() == data for path, data in before.items())
    assert len(list((care["music"] / "library").rglob("*.wav"))) == 3
    async with session_scope() as s:
        assert (await s.get(Album, 1)).title == "Record"
        assert all((care["music"] / "library" / t.path).is_file() for t in await s.scalars(select(Track)))


async def test_merge_preserves_every_file_and_uuid(care):
    from app.db import session_scope
    from app.library.tagger import read_tag_fields
    from app.models import Album, Track

    uids = {read_tag_fields(p)["track_uid"] for p in care["paths"]}
    p = await preview(care["admin"], action="merge", ids=[2])
    assert p["track_count"] == 1
    r = await care["admin"].post("/api/library/apply", json={"token": p["token"]})
    assert r.status_code == 200, r.text
    async with session_scope() as s:
        tracks = list(await s.scalars(select(Track)))
        assert len(tracks) == 3 and all(t.album_id == 1 for t in tracks)
        assert await s.get(Album, 2) is None
        assert {read_tag_fields(care["music"] / "library" / t.path)["track_uid"] for t in tracks} == uids


@pytest.mark.parametrize("fields", [{"title": "  "}, {"year": 10000}, {"track_no": -1},
                                     {"genre": "x" * 129}, {"path": "../outside.wav"}])
async def test_invalid_edits_do_not_produce_preview(care, fields):
    before = [checksum(p) for p in care["paths"]]
    r = await care["admin"].post("/api/library/preview", json={"action": "track", "id": 1, "fields": fields})
    assert r.status_code == 422
    assert before == [checksum(p) for p in care["paths"]]


async def test_expired_preview_cannot_be_applied(care):
    import json

    from app.security import decrypt, encrypt

    p = await preview(care["admin"], fields={"title": "Changed"})
    data = json.loads(decrypt(p["token"]))
    data["expires"] = 0
    r = await care["admin"].post("/api/library/apply", json={"token": encrypt(json.dumps(data))})
    assert r.status_code == 409


async def test_clear_album_genre_and_year_reaches_every_file(care):
    from app.db import session_scope
    from app.library.tagger import read_tag_fields
    from app.models import Track

    p = await preview(care["admin"], action="album", fields={"genre": None, "year": None})
    r = await care["admin"].post("/api/library/apply", json={"token": p["token"]})
    assert r.status_code == 200, r.text
    async with session_scope() as s:
        tracks = await s.scalars(select(Track).where(Track.album_id == 1))
        for t in tracks:
            assert t.year is None and t.genre is None
            tags = read_tag_fields(care["music"] / "library" / t.path)
            assert not tags.get("date") and not tags.get("genre")
