"""Multi-user music experience: isolation, shared editorial permissions, versions and recap accuracy."""

import io
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from app.db import session_scope
from app.models import PlayEvent, Track, utcnow

pytest_plugins = ["tests.test_nextcloud_api"]


async def test_personal_notes_lyrics_tags_are_owner_only(cloud):
    client, _ = cloud
    unknown = await client.get("/api/music/track", params={"ref": "dz:777"})
    assert not unknown.json()["can_confirm_version"]
    assert (await client.put("/api/music/version", json={"ref": "dz:777", "status": "original"})).status_code == 422
    text = {
        "note": "Private road trip",
        "tags": ["Night", "night", " Road "],
        "plain_lyrics": "Personal test words",
        "artist": "Artist",
        "title": "Track",
    }
    saved = await client.put("/api/music/personal", params={"ref": "dz:100"}, json=text)
    assert saved.status_code == 200, saved.text
    mine = await client.get("/api/music/track", params={"ref": "dz:100"})
    assert mine.json()["personal"]["tags"] == ["night", "road"]
    assert mine.json()["lyrics"]["plain"] == "Personal test words"
    assert "no-store" in mine.headers["cache-control"]
    other = await client.get("/api/music/track", params={"ref": "dz:100"}, headers={"x-test-user": "2"})
    assert other.json()["personal"] == {} and other.json()["lyrics"]["plain"] == ""
    assert (await client.get("/api/music/notes", headers={"x-test-user": "2"})).json() == []
    assert len((await client.get("/api/music/notes", params={"tag": "road", "q": "trip"})).json()) == 1
    assert (await client.get("/api/music/notes", params={"tag": "other"})).json() == []
    # Verified library/catalog alias gives the account one annotation.
    async with session_scope() as s:
        s.add(
            Track(
                uid="test-song",
                path="Artist/song.mp3",
                nd_song_id="song",
                deezer_track_id="100",
                artist="Artist",
                title="Track",
                fingerprint="artist|track",
            )
        )
        await s.commit()
    alias = await client.get("/api/music/track", params={"ref": "nd:song"})
    assert alias.json()["personal"]["note"] == "Private road trip"
    assert alias.json()["can_confirm_version"] and alias.json()["version_ref"] == "nd:song"


async def test_shared_editorial_requires_admin_and_personal_override_wins(cloud):
    client, _ = cloud
    body = {
        "plain_lyrics": "Shared test words",
        "synced_lyrics": "[00:01.00]Shared test line",
        "source": "https://lrclib.net/api/get/1",
    }
    denied = await client.put("/api/music/lyrics", params={"ref": "dz:100"}, json=body, headers={"x-test-user": "2"})
    assert denied.status_code == 403
    assert (await client.put("/api/music/lyrics", params={"ref": "dz:100"}, json=body)).status_code == 200
    assert (await client.get("/api/music/track", params={"ref": "dz:100"}, headers={"x-test-user": "2"})).json()[
        "lyrics"
    ]["synced"] == body["synced_lyrics"]
    assert (
        await client.put("/api/music/personal", params={"ref": "dz:100"}, json={"plain_lyrics": "My test override"})
    ).status_code == 200
    assert (await client.get("/api/music/track", params={"ref": "dz:100"})).json()["lyrics"][
        "plain"
    ] == "My test override"
    assert (
        await client.put("/api/music/lyrics", params={"ref": "dz:100"}, json={"source": "javascript:alert(1)"})
    ).status_code == 422


async def test_preferences_are_per_user_and_original_routing_never_changes_shared_pick(cloud, monkeypatch):
    from app import listen
    from app.api.listen import _choose
    from app.models import User

    client, _ = cloud
    candidate = SimpleNamespace(provider="soundcloud", provider_id="edited-file")
    edited = SimpleNamespace(kind="full", ref="dz:100", candidate=candidate)
    original = SimpleNamespace(
        kind="full",
        ref="file:soundcloud:original-file",
        candidate=SimpleNamespace(provider="soundcloud", provider_id="original-file"),
    )
    chooser = AsyncMock(side_effect=lambda ref, **kw: edited if ref == "dz:100" else original)
    monkeypatch.setattr(listen, "choose", chooser)
    monkeypatch.setitem(listen._choices, "dz:100", edited)
    result = await client.put(
        "/api/music/version",
        json={
            "ref": "file:soundcloud:edited-file",
            "status": "edited",
            "original_ref": "file:soundcloud:original-file",
        },
    )
    assert result.status_code == 200, result.text
    assert (
        await client.put(
            "/api/music/version", json={"ref": "dz:100", "status": "original"}, headers={"x-test-user": "2"}
        )
    ).status_code == 403
    assert (
        await client.put("/api/music/preferences", json={"prefer_original": True, "radio_mode": "discover"})
    ).status_code == 200
    assert (await client.get("/api/music/preferences", headers={"x-test-user": "2"})).json()["prefer_original"] is False
    assert (await _choose("dz:100", user=User(id=1))) is original
    assert (await _choose("dz:100", user=User(id=2))) is edited
    assert listen._choices["dz:100"] is edited
    assert (await client.get("/api/music/track", params={"ref": "dz:100"})).json()[
        "version_ref"
    ] == "file:soundcloud:edited-file"
    assert (await client.put("/api/music/preferences", json={"eq_gains": [99] * 6})).status_code == 422
    assert (await client.put("/api/music/preferences", json={"crossfade_s": 11})).status_code == 422
    # No confirmed original: explicitly stop instead of silently playing the edited version.
    await client.put("/api/music/version", json={"ref": "file:soundcloud:edited-file", "status": "edited"})
    with pytest.raises(Exception) as error:
        await _choose("dz:100", user=User(id=1))
    assert error.value.status_code == 409


async def test_profile_permissions_safe_cover_and_public_read(cloud):
    client, _ = cloud
    profile = {
        "biography": "Band biography",
        "members": ["Member A"],
        "related": ["Project B"],
        "source": "https://example.org/info",
    }
    assert (
        await client.put(
            "/api/music/profile/artist", params={"ref": "dz:1"}, json=profile, headers={"x-test-user": "2"}
        )
    ).status_code == 403
    assert (await client.put("/api/music/profile/artist", params={"ref": "dz:1"}, json=profile)).status_code == 200
    assert (await client.get("/api/music/profile/artist", params={"ref": "dz:1"}, headers={"x-test-user": "2"})).json()[
        "members"
    ] == ["Member A"]
    raw = io.BytesIO()
    Image.new("RGB", (1200, 800), (40, 70, 90)).save(raw, "PNG")
    uploaded = await client.post("/api/music/cover", files={"file": ("cover.png", raw.getvalue(), "image/png")})
    assert uploaded.status_code == 200 and uploaded.json()["cover_url"].startswith("data:image/jpeg;base64,")
    assert (
        await client.put(
            "/api/music/profile/album", params={"ref": "dz:2"}, json={"cover_url": uploaded.json()["cover_url"]}
        )
    ).status_code == 200
    assert (
        await client.post("/api/music/cover", files={"file": ("x.svg", b'<svg onload="x"/>', "image/svg+xml")})
    ).status_code == 422
    assert (
        await client.put(
            "/api/music/profile/album", params={"ref": "dz:2"}, json={"cover_url": "https://untrusted.test/a.png"}
        )
    ).status_code == 422


async def test_lyrics_provider_404_success_and_failure_are_bounded(cloud):
    client, mock = cloud
    route = mock.get("https://lrclib.net/api/get").respond(
        200, json={"id": 1, "plainLyrics": "Test line", "syncedLyrics": "[00:01.20]Test line"}
    )
    found = await client.get("/api/music/lyrics/find", params={"artist": "Artist", "title": "Song", "duration": 100})
    assert found.status_code == 200 and found.json()["found"]
    assert route.calls.last.request.url.params["duration"] == "100"
    route.respond(404)
    assert (await client.get("/api/music/lyrics/find", params={"artist": "A", "title": "S"})).json() == {"found": False}
    route.respond(200, content=b"x" * 256001)
    assert (await client.get("/api/music/lyrics/find", params={"artist": "A", "title": "S"})).status_code == 502
    route.respond(200, json=[])
    assert (await client.get("/api/music/lyrics/find", params={"artist": "A", "title": "S"})).status_code == 502


async def test_personal_recap_uses_measured_attempts_and_never_other_user(cloud):
    client, _ = cloud
    now = utcnow().replace(day=5, hour=12, minute=0, second=0, microsecond=0)
    # Always choose a past month so the server's current time includes all events.
    now = (now.replace(day=1) - timedelta(days=1)).replace(day=5)
    async with session_scope() as s:
        for user in (1, 2):
            for i, (kind, ms) in enumerate([("start", 0), ("progress", 40000), ("finish", 60000)]):
                s.add(
                    PlayEvent(
                        user_id=user,
                        event_id=f"{user}-{i}",
                        ts=now + timedelta(seconds=i * 40),
                        kind=kind,
                        ref=f"dz:{user}",
                        target_type="track",
                        playback_id="same-attempt",
                        device_id="web",
                        listened_ms=ms,
                        duration_s=60,
                        client="pwa",
                        track_metadata={"artist": f"Artist {user}", "title": f"Song {user}"},
                    )
                )
        await s.commit()
    result = await client.get("/api/music/recap", params={"month": now.strftime("%Y-%m"), "timezone": "UTC"})
    assert result.status_code == 200, result.text
    assert result.json()["totals"]["listened_ms"] == 60000
    assert "Artist 2" not in result.text and "Song 2" not in result.text
    assert "no-store" in result.headers["cache-control"]
    assert (await client.get("/api/music/recap", params={"month": "2026-13"})).status_code == 422
    assert (
        await client.get("/api/music/recap", params={"month": now.strftime("%Y-%m"), "timezone": "not/a/zone"})
    ).status_code == 422


async def test_search_version_labels_and_download_preference_are_consistent(cloud, monkeypatch, tmp_path):
    from app.jobs import downloads
    from app.providers.base import TrackQuery
    from app.services import svc
    from tests.support import FakeProvider, cand

    client, _ = cloud
    candidates = [cand(name, "https://cdn.test/a.mp3", provider="demo") for name in ("edited", "unknown", "original")]
    provider = FakeProvider("demo", candidates)
    monkeypatch.setitem(svc.providers, "demo", provider)
    for name, status in [("edited", "edited"), ("original", "original")]:
        assert (
            await client.put("/api/music/version", json={"ref": f"file:demo:{name}", "status": status})
        ).status_code == 200
    search = await client.get("/api/search/providers", params={"q": "A - Song", "provider": "demo"})
    assert search.status_code == 200, search.text
    assert search.json()["versions"] == {"file:demo:edited": "edited", "file:demo:original": "original"}
    await client.put("/api/music/preferences", json={"prefer_original": True})
    raw = tmp_path / "source.mp3"
    raw.write_bytes(b"fake audio")
    provider.fetch = AsyncMock(return_value=raw)
    monkeypatch.setattr(downloads, "update_item", AsyncMock())
    monkeypatch.setattr(downloads, "import_downloaded", AsyncMock())
    monkeypatch.setattr(downloads.probe, "postcheck", AsyncMock(return_value=SimpleNamespace(ok=True)))
    query = TrackQuery(artist="A", title="Song")
    result = await downloads.try_candidates(1, 1, query, {}, candidates, tmp_path, False)
    assert result[0] and provider.fetch.call_args.args[0].provider_id == "original"
    provider.fetch.reset_mock()
    result = await downloads.try_candidates(1, 2, query, {}, candidates, tmp_path, False)
    assert result[0] and provider.fetch.call_args.args[0].provider_id == "edited"
    provider.fetch.reset_mock()
    result = await downloads.try_candidates(1, 1, query, {}, candidates[:1], tmp_path, False)
    assert not result[0] and not provider.fetch.called
