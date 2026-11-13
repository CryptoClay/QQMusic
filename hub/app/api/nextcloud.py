"""Personal WebDAV files: no shared provider registry, library, or listening cache."""

from __future__ import annotations

import asyncio
import json
import mimetypes
import re
import time
import uuid
from pathlib import PurePosixPath
from types import SimpleNamespace
from urllib.parse import quote, unquote, urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import current_user
from app.config import get_settings
from app.db import get_session
from app.models import NextcloudConnection, User
from app.providers.base import ProviderError, TrackQuery
from app.providers.nextcloud import NextcloudProvider
from app.security import decrypt, encrypt

router = APIRouter(prefix="/api/nextcloud", tags=["nextcloud"])
PRIVATE = {"Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer"}
MAX_BYTES = 500 * 1024 * 1024


class ConnectionIn(BaseModel):
    server_url: str = Field(max_length=2048)
    username: str = Field(min_length=1, max_length=255)
    password: str = Field(default="", max_length=4096, repr=False)
    folder: str = Field(default="Music", max_length=1024)


def server_url(value: str) -> str:
    try:
        p = urlsplit(value.strip())
        if (p.scheme != "https" or not p.hostname or p.username is not None or p.password is not None
                or p.query or p.fragment or any(ord(c) < 33 for c in p.netloc)):
            raise ValueError
        _ = p.port  # validate malformed ports
        path = NextcloudProvider._clean_path(p.path).rstrip("/")
        return urlunsplit(("https", p.netloc.lower(), path, "", ""))
    except (ValueError, UnicodeError):
        raise HTTPException(422, "Укажите HTTPS-адрес сервера без логина, пароля и параметров") from None


async def allowed_servers(s: AsyncSession) -> list[str]:
    # Only the operator/admin can introduce a new server (including a home-network host).
    # Other users may supply their own credentials, never arbitrary internal proxy targets.
    rows = (await s.execute(select(NextcloudConnection.server_url).join(User)
                            .where(User.is_admin.is_(True)))).scalars().all()
    if configured := get_settings().nextcloud_url:
        rows = [*rows, server_url(configured)]
    return sorted(set(rows))


async def authorize_server(s: AsyncSession, user: User, url: str) -> None:
    if not user.is_admin and url not in await allowed_servers(s):
        raise HTTPException(403, "Этот сервер ещё не добавлен администратором")


def provider_for(connection: NextcloudConnection) -> NextcloudProvider:
    return NextcloudProvider.from_settings(SimpleNamespace(
        nextcloud_url=connection.server_url, nextcloud_user=connection.username,
        nextcloud_password=decrypt(connection.password_enc), nextcloud_folder=connection.folder,
    ))


async def connection_for(s: AsyncSession, user: User) -> NextcloudConnection:
    connection = await s.get(NextcloudConnection, user.id)
    if connection is None:
        raise HTTPException(404, "Подключите Nextcloud в настройках")
    await authorize_server(s, user, connection.server_url)
    return connection


@router.get("/connection")
async def get_connection(response: Response, user: User = Depends(current_user),
                         s: AsyncSession = Depends(get_session, scope="function")):
    response.headers.update(PRIVATE)
    connection = await s.get(NextcloudConnection, user.id)
    return {"connected": connection is not None, "server_url": connection.server_url if connection else "",
            "username": connection.username if connection else "", "folder": connection.folder if connection else "Music",
            "has_password": connection is not None, "allowed_servers": await allowed_servers(s),
            "can_add_server": user.is_admin}


@router.put("/connection")
async def save_connection(body: ConnectionIn, response: Response, user: User = Depends(current_user),
                          s: AsyncSession = Depends(get_session, scope="function")):
    url = server_url(body.server_url)
    await authorize_server(s, user, url)
    previous = await s.get(NextcloudConnection, user.id)
    password = body.password
    if not password and previous and previous.server_url == url and previous.username == body.username.strip():
        password = decrypt(previous.password_enc)
    if not password:
        raise HTTPException(422, "Введите пароль приложения Nextcloud")
    connection = NextcloudConnection(user_id=user.id, server_url=url, username=body.username.strip(),
                                     folder=body.folder.strip("/"), password_enc=encrypt(password), revision=str(uuid.uuid4()))
    try:
        provider = provider_for(connection)
    except ValueError:
        raise HTTPException(422, "Проверьте адрес, имя пользователя и путь к папке") from None
    await provider.aclose()
    if previous:
        for key in ("server_url", "username", "folder", "password_enc", "revision"):
            setattr(previous, key, getattr(connection, key))
    else:
        s.add(connection)
    await s.commit()
    response.headers.update(PRIVATE)
    return {"ok": True}


@router.delete("/connection")
async def disconnect(response: Response, user: User = Depends(current_user),
                     s: AsyncSession = Depends(get_session, scope="function")):
    await s.execute(delete(NextcloudConnection).where(NextcloudConnection.user_id == user.id))
    await s.commit()
    response.headers.update(PRIVATE)
    return {"ok": True}


@router.post("/test")
async def test_connection(response: Response, user: User = Depends(current_user),
                          s: AsyncSession = Depends(get_session, scope="function")):
    provider = provider_for(await connection_for(s, user))
    try:
        async with asyncio.timeout(6):
            await provider._list(provider._base)
    except (ProviderError, TimeoutError):
        raise HTTPException(502, "Nextcloud не ответил: проверьте адрес, папку и пароль приложения") from None
    finally:
        await provider.aclose()
    response.headers.update(PRIVATE)
    return {"ok": True}


@router.get("/files")
async def search_files(response: Response, q: str = Query(min_length=1, max_length=512),
                       user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")):
    connection = await connection_for(s, user)
    provider = provider_for(connection)
    artist, sep, title = q.partition(" - ")
    try:
        found = await provider.search(TrackQuery(artist=artist.strip(), title=title.strip() if sep else ""), limit=30)
        files = []
        for candidate in found:
            token = encrypt(json.dumps({"user": user.id, "revision": connection.revision,
                                       "url": provider._candidate_url(candidate), "expires": int(time.time()) + 12 * 3600}))
            files.append({"id": token, "artist": candidate.artist, "title": candidate.title})
    except ProviderError:
        raise HTTPException(502, "Не удалось найти файлы Nextcloud: проверьте подключение или сузьте поиск") from None
    finally:
        await provider.aclose()
    response.headers.update(PRIVATE)
    return {"files": files}


@router.get("/audio")
async def audio(request: Request, file: str = Query(min_length=1, max_length=8192), download: bool = False,
                user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")):
    connection = await connection_for(s, user)
    provider = provider_for(connection)
    upstream = None
    try:
        try:
            data = json.loads(decrypt(file))
            if (data["user"] != user.id or data["revision"] != connection.revision
                    or data["expires"] < time.time()):
                raise ValueError
            url = provider._resolve(data["url"], provider._base)
            filename = unquote(urlsplit(url).path.rsplit("/", 1)[-1])
            if PurePosixPath(filename).suffix.lower() not in {'.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wav'}:
                raise ValueError
        except (RuntimeError, ValueError, KeyError, TypeError):
            raise HTTPException(404, "Файл недоступен. Выполните поиск заново") from None
        headers = {"Accept-Encoding": "identity"}
        if value := request.headers.get("range"):
            if len(value) > 64 or not re.fullmatch(r"bytes=(?:\d+-\d*|-\d+)", value):
                raise HTTPException(416, "Неверный диапазон")
            start, end = value.removeprefix("bytes=").split("-")
            if ((start and int(start) >= MAX_BYTES) or (end and int(end) >= MAX_BYTES)
                    or (start and end and int(start) > int(end))):
                raise HTTPException(416, "Диапазон превышает размер допустимого файла")
            headers["Range"] = value
        upstream = await provider._client.send(
            provider._client.build_request("GET", url, headers=headers), auth=provider._auth,
            stream=True, follow_redirects=False)
        if upstream.status_code == 416:
            result = {**PRIVATE}
            if content_range := upstream.headers.get("content-range"):
                result["Content-Range"] = content_range
            await upstream.aclose()
            await provider.aclose()
            return Response(status_code=416, headers=result)
        if upstream.status_code not in (200, 206):
            raise HTTPException(502, "Nextcloud не отдал файл. Проверьте подключение")
        length = upstream.headers.get("content-length", "")
        total = (upstream.headers.get("content-range", "").rpartition("/")[2] if upstream.status_code == 206 else length)
        if upstream.status_code == 206 and not total.isdigit():
            raise HTTPException(502, "Nextcloud не сообщил размер аудиофайла")
        if total.isdigit() and int(total) > MAX_BYTES:
            raise HTTPException(413, "Файл Nextcloud превышает 500 MiB")
        content_type = upstream.headers.get("content-type", "").split(";")[0].lower()
        if content_type and not (content_type.startswith("audio/") or content_type == "application/octet-stream"):
            raise HTTPException(502, "Nextcloud вернул страницу вместо аудиофайла")
        result = {**PRIVATE, "X-Content-Type-Options": "nosniff"}
        for header in ("content-range", "content-length", "accept-ranges"):
            if value := upstream.headers.get(header):
                result[header] = value
        if download:
            result["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(filename, safe="")
    except BaseException as error:
        if upstream is not None:
            await upstream.aclose()
        await provider.aclose()
        if isinstance(error, httpx.HTTPError):
            raise HTTPException(502, "Соединение с Nextcloud прервалось") from None
        raise

    async def chunks():
        size = 0
        try:
            async for chunk in upstream.aiter_raw():
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ProviderError("Nextcloud file limit exceeded")
                yield chunk
        except httpx.HTTPError:
            raise ProviderError("Nextcloud audio connection interrupted") from None
        finally:
            await upstream.aclose()
            await provider.aclose()

    return StreamingResponse(chunks(), status_code=upstream.status_code, headers=result,
                             media_type=mimetypes.guess_type(filename)[0] or "application/octet-stream")
