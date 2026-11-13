"""Private remote playback: ownership, retries, one-time delivery and stale commands."""

import asyncio
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import update

from tests.test_library_care import care as care


def command(action="play", **kw):
    return {"request_id": str(uuid.uuid4()), "action": action, **kw}


async def register(care, enabled=True):
    c = care["user"]
    r = await c.put(
        "/api/player/devices/target",
        json={
            "account": 2,
            "name": "Computer",
            "enabled": enabled,
            "state": {"track": {"ref": "nd:nd1", "title": "Song", "artist": "Band"}, "phase": "paused"},
        },
    )
    assert r.status_code == 200, r.text
    return c


async def test_private_even_from_another_admin_and_wrong_account(care):
    c = await register(care)
    own = await c.get("/api/player/devices")
    assert own.status_code == 200 and own.json()[0]["online"]
    assert "no-store" in own.headers["cache-control"]
    for key in ("admin", "other"):
        other = care[key]
        assert (await other.get("/api/player/devices")).json() == []
        assert (await other.post("/api/player/devices/target/commands", json=command())).status_code == 404
        assert (await other.post("/api/player/devices/target/poll")).status_code == 404
    assert (await c.put("/api/player/devices/target", json={"account": 1, "name": "x", "state": {}})).status_code == 409
    r = await c.post("/api/player/devices/target/commands", json=command())
    id = r.json()["id"]
    assert (await care["admin"].get(f"/api/player/commands/{id}")).status_code == 404
    assert (await c.put(f"/api/player/devices/target/commands/{id}", json={"status": "done"})).status_code == 404


async def test_idempotent_retry_conflicting_request_and_once_only_poll(care):
    c = await register(care)
    body = command()
    a, b = await asyncio.gather(*(c.post("/api/player/devices/target/commands", json=body) for _ in range(2)))
    assert a.status_code == b.status_code == 200
    assert a.json()["id"] == b.json()["id"]
    conflict = await c.post("/api/player/devices/target/commands", json={**body, "action": "next"})
    assert conflict.status_code == 409
    polls = await asyncio.gather(*(c.post("/api/player/devices/target/poll") for _ in range(2)))
    delivered = [cmd for r in polls for cmd in r.json()["commands"]]
    assert len(delivered) == 1 and delivered[0]["action"] == "play"
    id = delivered[0]["id"]
    assert (
        await c.put(f"/api/player/devices/target/commands/{id}", json={"status": "blocked", "result": "Autoplay"})
    ).status_code == 200
    assert (await c.get(f"/api/player/commands/{id}")).json() == {"status": "blocked", "result": "Autoplay"}
    assert (await c.post("/api/player/devices/target/poll")).json() == {"commands": []}


async def test_disabled_offline_and_expired_commands_never_replay(care):
    from app.db import session_scope
    from app.models import PlaybackCommand, PlaybackDevice, utcnow

    c = await register(care, False)
    assert (await c.post("/api/player/devices/target/commands", json=command())).status_code == 409
    await register(care)
    first = (await c.post("/api/player/devices/target/commands", json=command())).json()["id"]
    await register(care, False)
    assert (await c.get(f"/api/player/commands/{first}")).json()["status"] == "expired"
    await register(care)
    second = (await c.post("/api/player/devices/target/commands", json=command())).json()["id"]
    async with session_scope() as s:
        await s.execute(
            update(PlaybackCommand)
            .where(PlaybackCommand.id == second)
            .values(expires_at=utcnow() - timedelta(seconds=1))
        )
    assert (await c.post("/api/player/devices/target/poll")).json()["commands"] == []
    assert (await c.get(f"/api/player/commands/{second}")).json()["status"] == "expired"
    async with session_scope() as s:
        await s.execute(update(PlaybackDevice).values(seen_at=utcnow() - timedelta(seconds=46)))
    assert not (await c.get("/api/player/devices")).json()[0]["online"]
    assert (await c.post("/api/player/devices/target/commands", json=command())).status_code == 409


@pytest.mark.parametrize(
    "body",
    [
        command("volume", value=2),
        command("seek"),
        command("load"),
        command("load", queue=[{"ref": "nd:nd1", "title": "Song", "artist": "Band"}], index=1),
        command("pause", queue=[{"ref": "nd:nd1", "title": "Song", "artist": "Band"}]),
    ],
)
async def test_invalid_control_payloads(care, body):
    c = await register(care)
    assert (await c.post("/api/player/devices/target/commands", json=body)).status_code == 422


async def test_seek_cannot_target_a_replaced_track_and_load_is_valid(care):
    c = await register(care)
    assert (
        await c.post("/api/player/devices/target/commands", json=command("seek", value=12, expected_ref="nd:old"))
    ).status_code == 409
    assert (
        await c.post("/api/player/devices/target/commands", json=command("seek", value=12, expected_ref="nd:nd1"))
    ).status_code == 200
    body = command("load", queue=[{"ref": "nd:nd2", "title": "Other", "artist": "Band"}], position=5)
    assert (await c.post("/api/player/devices/target/commands", json=body)).status_code == 200
    first = (await c.post("/api/player/devices/target/poll")).json()["commands"][0]
    second = (await c.post("/api/player/devices/target/poll")).json()["commands"][0]
    assert first["action"] == "seek" and second["action"] == "load" and second["position"] == 5
