"""The rename must preserve valid sessions and revoke both cookie names on logout."""
from datetime import timedelta

import httpx
import pytest


@pytest.mark.asyncio
async def test_legacy_session_is_promoted_and_logout_revokes_both(hub_env):
    from app.db import dispose, session_scope
    from app.main import create_app
    from app.models import Session, User, utcnow
    from app.security import new_token

    old_token, old_hash = new_token()
    other_token, other_hash = new_token()
    async with session_scope() as s:
        user = User(nd_username="legacy", nd_password_enc="unused")
        s.add(user)
        await s.flush()
        for digest in (old_hash, other_hash):
            s.add(Session(id=digest, user_id=user.id, expires_at=utcnow() + timedelta(days=1)))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()), base_url="http://hub.test") as c:
            c.cookies.set("hm_session", old_token)
            response = await c.get("/api/auth/me")
            assert response.status_code == 200
            assert c.cookies.get("qqmusic_session") == old_token
            assert any("hm_session=" in value and "Max-Age=0" in value for value in response.headers.get_list("set-cookie"))
            c.cookies.clear()
            c.cookies.set("qqmusic_session", old_token)
            c.cookies.set("hm_session", other_token)
            response = await c.post("/api/auth/logout")
            assert response.status_code == 200
            assert len(response.headers.get_list("set-cookie")) == 2
            async with session_scope() as s:
                assert await s.get(Session, old_hash) is None
                assert await s.get(Session, other_hash) is None
            c.cookies.clear()
            c.cookies.set("hm_session", old_token)
            assert (await c.get("/api/auth/me")).status_code == 401
    finally:
        await dispose()
