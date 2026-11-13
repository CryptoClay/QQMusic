"""Private cloud browsing, bounded metadata reads, encrypted playlist references."""

import asyncio
import base64
import hashlib
import io
import json
import time
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit

import httpx
import mutagen
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from PIL import Image
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.nextcloud import PRIVATE, connection_for, provider_for
from app.auth import current_user
from app.db import get_session
from app.models import NextcloudPlaylist, User
from app.providers.base import ProviderError
from app.security import decrypt, encrypt

router = APIRouter(prefix="/api/nextcloud", tags=["nextcloud"])
AUDIO = {".mp3", ".flac", ".m4a", ".aac", ".opus", ".ogg", ".wav"}


def token(connection, user, url):
    return encrypt(
        json.dumps({"user": user.id, "revision": connection.revision, "url": url, "expires": int(time.time()) + 43200})
    )


def resolve(value, connection, user, provider):
    try:
        data = json.loads(decrypt(value))
        if data["user"] != user.id or data["revision"] != connection.revision or data["expires"] < time.time():
            raise ValueError
        return provider._resolve(data["url"], provider._base)
    except (ValueError, RuntimeError, KeyError, TypeError):
        raise HTTPException(404, "Файл недоступен. Выполните поиск заново") from None


def file_out(url, connection, user):
    name = unquote(urlsplit(url).path.rsplit("/", 1)[-1])
    artist, sep, title = PurePosixPath(name).stem.partition(" - ")
    return {"id": token(connection, user, url), "artist": artist if sep else "", "title": title if sep else artist}


def scope(connection):
    return hashlib.sha256(
        json.dumps([connection.server_url, connection.username, connection.folder]).encode()
    ).hexdigest()


@router.get("/browse")
async def browse(
    response: Response,
    folder: str | None = Query(None, max_length=8192),
    user: User = Depends(current_user),
    s: AsyncSession = Depends(get_session, scope="function"),
):
    connection = await connection_for(s, user)
    provider = provider_for(connection)
    try:
        url = resolve(folder, connection, user, provider) if folder else provider._base
        url = url.rstrip("/") + "/"
        async with asyncio.timeout(6):
            entries = await provider._list(url)
        folders = []
        files = []
        for target, is_dir, size in entries:
            if target.rstrip("/") == url.rstrip("/"):
                continue
            if is_dir:
                folders.append(
                    {
                        "id": token(connection, user, target.rstrip("/") + "/"),
                        "name": unquote(urlsplit(target).path.rstrip("/").rsplit("/", 1)[-1]),
                    }
                )
            elif PurePosixPath(urlsplit(target).path).suffix.lower() in AUDIO and (
                size is None or size <= 500 * 1024**2
            ):
                files.append(file_out(target, connection, user))
        response.headers.update(PRIVATE)
        return {"folders": folders, "files": files}
    except (ProviderError, TimeoutError):
        raise HTTPException(502, "Не удалось открыть папку Nextcloud") from None
    finally:
        await provider.aclose()


def read_tags(raw):
    result = {}
    try:
        media = mutagen.File(io.BytesIO(raw))
        if media is None:
            return result
        tags = media.tags or {}
        for field, keys in {
            "title": ["TIT2", "title", "\xa9nam"],
            "artist": ["TPE1", "artist", "\xa9ART"],
            "album": ["TALB", "album", "\xa9alb"],
        }.items():
            for key in keys:
                if key in tags:
                    value = tags[key]
                    value = value[0] if isinstance(value, list) else str(value)
                    result[field] = str(value)[:512]
                    break
        if getattr(media, "info", None) and getattr(media.info, "length", 0) > 0:
            result["duration_s"] = media.info.length
        covers = [frame.data for frame in tags.values() if getattr(frame, "FrameID", None) == "APIC"]
        covers += [picture.data for picture in getattr(media, "pictures", [])[:1]]
        if covers and len(covers[0]) <= 512 * 1024:
            with Image.open(io.BytesIO(covers[0])) as image:
                if image.width * image.height <= 16_000_000:
                    image.thumbnail((384, 384))
                    output = io.BytesIO()
                    image.convert("RGB").save(output, "JPEG", quality=80)
                    result["cover_url"] = "data:image/jpeg;base64," + base64.b64encode(output.getvalue()).decode()
    except Exception:
        pass  # partial MP4/large tags are optional; file-name metadata remains available
    return result


@router.get("/metadata")
async def metadata(
    response: Response,
    file: str = Query(max_length=8192),
    user: User = Depends(current_user),
    s: AsyncSession = Depends(get_session, scope="function"),
):
    connection = await connection_for(s, user)
    provider = provider_for(connection)
    try:
        url = resolve(file, connection, user, provider)
        if PurePosixPath(urlsplit(url).path).suffix.lower() not in AUDIO:
            raise HTTPException(400, "Не аудиофайл")
        async with asyncio.timeout(8):
            async with provider._client.stream(
                "GET",
                url,
                auth=provider._auth,
                follow_redirects=False,
                headers={"Range": "bytes=0-1048575", "Accept-Encoding": "identity"},
            ) as upstream:
                if upstream.status_code not in (200, 206):
                    raise HTTPException(502, "Не удалось прочитать теги")
                raw = bytearray()
                async for chunk in upstream.aiter_bytes(65536):
                    raw.extend(chunk[: 1048576 - len(raw)])
                    if len(raw) >= 1048576:
                        break
        result = file_out(url, connection, user)
        result.pop("id")
        result.update(await asyncio.to_thread(read_tags, bytes(raw)))
        response.headers.update(PRIVATE)
        return result
    except (httpx.HTTPError, TimeoutError):
        raise HTTPException(502, "Nextcloud не ответил при чтении тегов") from None
    finally:
        await provider.aclose()


class PlaylistIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    files: list[str] = Field(default_factory=list, max_length=100)


async def playlist_item(s, user, playlist_id):
    item = await s.get(NextcloudPlaylist, playlist_id)
    if item is None or item.user_id != user.id:
        raise HTTPException(404, "Плейлист не найден")
    return item


def store_files(values, connection, user, provider):
    result = []
    for value in values:
        url = resolve(value, connection, user, provider)
        if PurePosixPath(urlsplit(url).path).suffix.lower() not in AUDIO:
            raise HTTPException(400, "Не аудиофайл")
        result.append({"url_enc": encrypt(url)})
    return result


@router.get("/playlists")
async def playlists(
    response: Response, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")
):
    connection = await connection_for(s, user)
    provider = provider_for(connection)
    try:
        rows = (
            await s.execute(
                select(NextcloudPlaylist).where(NextcloudPlaylist.user_id == user.id).order_by(NextcloudPlaylist.id)
            )
        ).scalars()
        result = []
        for row in rows:
            files = []
            if row.scope == scope(connection):
                for entry in row.items_json:
                    try:
                        url = provider._resolve(decrypt(entry["url_enc"]), provider._base)
                        files.append(file_out(url, connection, user))
                    except (ValueError, RuntimeError, KeyError):
                        continue
            result.append({"id": row.id, "name": row.name, "files": files, "available": row.scope == scope(connection)})
        response.headers.update(PRIVATE)
        return result
    finally:
        await provider.aclose()


@router.post("/playlists")
async def create_playlist(
    body: PlaylistIn, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")
):
    connection = await connection_for(s, user)
    provider = provider_for(connection)
    try:
        count = await s.scalar(
            select(func.count()).select_from(NextcloudPlaylist).where(NextcloudPlaylist.user_id == user.id)
        )
        if count >= 100:
            raise HTTPException(409, "Достигнут лимит личных плейлистов")
        row = NextcloudPlaylist(
            user_id=user.id,
            name=body.name.strip() or "Плейлист",
            scope=scope(connection),
            items_json=store_files(body.files, connection, user, provider),
        )
        s.add(row)
        await s.commit()
        return {"id": row.id}
    finally:
        await provider.aclose()


@router.post("/playlists/{playlist_id}/items")
async def add_items(
    playlist_id: int,
    body: PlaylistIn,
    user: User = Depends(current_user),
    s: AsyncSession = Depends(get_session, scope="function"),
):
    connection = await connection_for(s, user)
    row = await playlist_item(s, user, playlist_id)
    provider = provider_for(connection)
    try:
        if row.scope != scope(connection):
            raise HTTPException(409, "Плейлист относится к другому подключению")
        if len(row.items_json) + len(body.files) > 100:
            raise HTTPException(409, "В плейлисте может быть до 100 треков")
        result = await s.execute(
            update(NextcloudPlaylist)
            .where(NextcloudPlaylist.id == row.id, NextcloudPlaylist.items_json == row.items_json)
            .values(items_json=[*row.items_json, *store_files(body.files, connection, user, provider)])
            .execution_options(synchronize_session=False)
        )
        if not result.rowcount:
            raise HTTPException(409, "Плейлист уже изменён. Повторите добавление")
        await s.commit()
        return {"ok": True}
    finally:
        await provider.aclose()


@router.delete("/playlists/{playlist_id}")
async def delete_playlist(
    playlist_id: int, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")
):
    row = await playlist_item(s, user, playlist_id)
    await s.delete(row)
    await s.commit()
    return {"ok": True}
