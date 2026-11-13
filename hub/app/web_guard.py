"""Same-origin browser writes and bounded public authentication abuse protection."""

from collections import deque
from time import monotonic
from urllib.parse import urlsplit

from cryptography.fernet import Fernet
from starlette.responses import JSONResponse

from app.config import get_settings

AUTH_PATHS = {
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/email/code",
    "/api/auth/email/register",
    "/api/auth/google",
}


def validate_public_settings(settings):
    if not getattr(settings, "public_mode", False):
        return
    url = urlsplit(settings.public_hub_url)
    if (
        url.scheme != "https"
        or not url.hostname
        or url.username
        or url.password
        or url.query
        or url.fragment
        or url.path not in ("", "/")
    ):
        raise ValueError("PUBLIC_MODE requires an HTTPS PUBLIC_HUB_URL origin")
    if not settings.hub_secret_key:
        raise ValueError("PUBLIC_MODE requires HUB_SECRET_KEY")
    if origin_of(settings.public_hub_url) is None:
        raise ValueError("Invalid public origin")
    Fernet(settings.hub_secret_key.encode())


def origin_of(value):
    try:
        url = urlsplit(value)
        if (
            url.scheme not in ("http", "https")
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
            or url.path not in ("", "/")
        ):
            return None
        host = url.hostname.lower()
        if ":" in host:
            host = "[" + host + "]"
        port = url.port
        suffix = "" if port is None or port == {"http": 80, "https": 443}[url.scheme] else ":" + str(port)
        return url.scheme + "://" + host + suffix
    except ValueError:
        return None


class WebGuard:
    def __init__(self, app):
        self.app = app
        self.attempts = {}

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        settings = get_settings()
        public = getattr(settings, "public_mode", False)
        headers = {k.decode("latin1").lower(): v.decode("latin1") for k, v in scope.get("headers", [])}
        host = headers.get("host", "")
        expected = settings.public_hub_url.rstrip("/") if public else f"{scope.get('scheme', 'http')}://{host}"
        path, method = scope["path"], scope["method"]

        async def reject(status, message):
            response = JSONResponse({"detail": message}, status_code=status, headers={"Cache-Control": "no-store"})
            await response(scope, receive, send)

        if public:
            try:
                hostname = urlsplit("http://" + host).hostname
                allowed = hostname == urlsplit(expected).hostname
            except ValueError:
                allowed = False
            local_health = path == "/healthz" and method == "GET" and host.split(":")[0] in ("127.0.0.1", "localhost")
            if not allowed and not local_health:
                return await reject(400, "Недопустимый адрес сервера")
        if path.startswith("/api/") and method not in ("GET", "HEAD", "OPTIONS"):
            origin = headers.get("origin")
            # Native clients may omit Origin. Browser cross-site writes never receive this exemption.
            if (origin and origin_of(origin) != origin_of(expected)) or headers.get("sec-fetch-site") == "cross-site":
                return await reject(403, "Запрос с другого сайта запрещён")
            if public and path in AUTH_PATHS:
                now = monotonic()
                key = (scope.get("client") or ("unknown",))[0]
                for address in list(self.attempts):
                    if not self.attempts[address] or self.attempts[address][-1] <= now - 60:
                        del self.attempts[address]
                if key not in self.attempts and len(self.attempts) >= 4096:
                    return await reject(429, "Слишком много попыток входа")
                bucket = self.attempts.setdefault(key, deque())
                while bucket and bucket[0] <= now - 60:
                    bucket.popleft()
                if len(bucket) >= settings.public_login_limit:
                    return await reject(429, "Слишком много попыток входа, подождите минуту")
                bucket.append(now)

        async def secure_send(message):
            if message["type"] == "http.response.start":
                response_headers = list(message.get("headers", []))
                response_headers += [
                    (b"x-content-type-options", b"nosniff"),
                    (b"referrer-policy", b"strict-origin-when-cross-origin"),
                ]
                if public:
                    response_headers += [
                        (b"x-frame-options", b"DENY"),
                        (b"content-security-policy", b"frame-ancestors 'none'; object-src 'none'; base-uri 'self'"),
                    ]
                    if scope.get("scheme") == "https":
                        response_headers.append((b"strict-transport-security", b"max-age=31536000"))
                message = {**message, "headers": response_headers}
            await send(message)

        await self.app(scope, receive, secure_send)
