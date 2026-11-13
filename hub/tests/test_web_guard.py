from types import SimpleNamespace

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI

from app.web_guard import WebGuard, validate_public_settings


@pytest.fixture
async def public_client(monkeypatch):
    settings = SimpleNamespace(
        public_mode=True, public_hub_url="https://music.example.test", hub_secret_key="configured", public_login_limit=3
    )
    monkeypatch.setattr("app.web_guard.get_settings", lambda: settings)
    app = FastAPI()
    app.add_middleware(WebGuard)

    @app.api_route("/{path:path}", methods=["GET", "POST"])
    def endpoint(path):
        return {"ok": True}

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://music.example.test"
    ) as client:
        yield client


async def test_same_origin_writes_and_private_headers(public_client):
    r = await public_client.post("/api/auth/login", headers={"Origin": "https://music.example.test"})
    assert r.status_code == 200
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "max-age" in r.headers["strict-transport-security"]
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
    assert (await public_client.post("/api/auth/login", headers={"Origin": "https://evil.test"})).status_code == 403
    assert (await public_client.post("/api/auth/login", headers={"Origin": "null"})).status_code == 403
    assert (await public_client.post("/api/auth/login", headers={"Sec-Fetch-Site": "cross-site"})).status_code == 403


async def test_auth_rate_limit_and_host_guard(public_client):
    for _ in range(3):
        assert (await public_client.post("/api/auth/login")).status_code == 200
    assert (await public_client.post("/api/auth/login")).status_code == 429
    assert (await public_client.get("/api/auth/me")).status_code == 200
    assert (await public_client.post("/api/auth/logout")).status_code == 200
    assert (await public_client.get("/api/auth/me", headers={"Host": "evil.test"})).status_code == 400
    assert (await public_client.get("/healthz", headers={"Host": "127.0.0.1:8080"})).status_code == 200


def test_public_mode_requires_https_origin_and_secret():
    for url in (
        "http://music.test",
        "https://music.test/path",
        "https://user:pass@music.test",
        "https://music.test?x=1",
    ):
        with pytest.raises(ValueError):
            validate_public_settings(
                SimpleNamespace(public_mode=True, public_hub_url=url, hub_secret_key=Fernet.generate_key().decode())
            )
    validate_public_settings(
        SimpleNamespace(
            public_mode=True, public_hub_url="https://music.test", hub_secret_key=Fernet.generate_key().decode()
        )
    )
    with pytest.raises(ValueError):
        validate_public_settings(
            SimpleNamespace(public_mode=True, public_hub_url="https://music.test", hub_secret_key="")
        )
