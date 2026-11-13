"""Revocable snapshot capabilities; anonymous clients never use the authenticated resolver."""
import mimetypes
import re
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.community import PRIVATE, collection_for, role_of
from app.api.library_care import safe_path
from app.auth import current_user, user_navidrome
from app.db import get_session
from app.models import CommunityPlaylist, ShareLink, Track, User, utcnow
from app.security import decrypt, encrypt, hash_token, new_token

router = APIRouter(tags=["sharing"])


class ShareIn(BaseModel):
    kind: Literal["track", "collection", "nd-playlist"]
    id: str = Field(min_length=1, max_length=100)
    access: Literal["public", "members"] = "public"
    hours: int = Field(default=168, ge=1, le=720)


@router.post("/api/community/shares")
async def create_share(body: ShareIn, user: User = Depends(current_user),
                       s: AsyncSession = Depends(get_session, scope="function")):
    collection_id = None
    if body.kind == "collection":
        if not body.id.isdecimal():
            raise HTTPException(422, "Некорректный плейлист")
        collection = await collection_for(s, int(body.id), user)
        if collection.owner_id != user.id or collection.archived:
            raise HTTPException(403, "Ссылкой управляет владелец действующего плейлиста")
        collection_id = collection.id
        refs = [t["ref"] for t in collection.items_json]
        name = collection.name
    elif body.kind == "nd-playlist":
        nd = user_navidrome(user)
        try:
            source = await nd.get_playlist(body.id)
        finally:
            await nd.aclose()
        if source.get("owner") != user.nd_username:
            raise HTTPException(403, "Можно поделиться только своим плейлистом")
        refs = ["nd:" + t["id"] for t in source.get("entry", [])]
        name = source.get("name") or "Плейлист"
    else:
        refs = [body.id if ":" in body.id else "nd:" + body.id]
        name = "Трек"
    if body.access == "members" and collection_id is None:
        raise HTTPException(422, "Доступ участникам возможен только для совместного плейлиста")
    if not 1 <= len(refs) <= 500:
        raise HTTPException(422, "В ссылке должно быть от 1 до 500 треков")
    tracks = []
    for ref in refs:
        if not ref.startswith(("nd:", "dz:")):
            raise HTTPException(409, "Сначала добавьте все треки в локальную библиотеку")
        column = Track.nd_song_id if ref.startswith("nd:") else Track.deezer_track_id
        track = await s.scalar(select(Track).where(column == ref.split(":", 1)[1]).order_by(Track.id))
        if not track or not safe_path(track.path).is_file():
            raise HTTPException(409, "Один из файлов недоступен. Сначала скачайте и проверьте треки")
        # UUID, never a recyclable SQLite integer id or a client-supplied path.
        tracks.append(track.uid)
        if body.kind == "track":
            name = f"{track.artist} — {track.title}"
    await s.execute(update(User).where(User.id == user.id).values(last_seen_at=User.last_seen_at))
    count = await s.scalar(select(func.count()).select_from(ShareLink).where(ShareLink.owner_id == user.id))
    if count >= 1000:
        raise HTTPException(409, "Достигнут лимит истории общих ссылок: 1000 записей")
    token, digest = new_token()
    row = ShareLink(owner_id=user.id, token_hash=digest, token_enc=encrypt(token), name=name[:200], access=body.access,
                    collection_id=collection_id, tracks_json=tracks, expires_at=utcnow() + timedelta(hours=body.hours))
    s.add(row)
    await s.flush()
    return {"id": row.id, "url": "/#/s/" + token, "expires_at": row.expires_at,
            "access": row.access, "track_count": len(tracks)}


@router.get("/api/community/shares")
async def own_shares(response: Response, user: User = Depends(current_user),
                     s: AsyncSession = Depends(get_session, scope="function")):
    response.headers.update(PRIVATE)
    rows = await s.scalars(select(ShareLink).where(ShareLink.owner_id == user.id).order_by(ShareLink.id.desc()).limit(200))
    return [{"id": r.id, "name": r.name, "access": r.access, "expires_at": r.expires_at,
             "url": "/#/s/" + decrypt(r.token_enc) if r.token_enc and not r.revoked and r.expires_at > utcnow() else None,
             "revoked": r.revoked, "expired": r.expires_at <= utcnow(), "track_count": len(r.tracks_json)} for r in rows]


@router.delete("/api/community/shares/{share_id}")
async def revoke(share_id: int, user: User = Depends(current_user),
                  s: AsyncSession = Depends(get_session, scope="function")):
    result = await s.execute(update(ShareLink).where(ShareLink.id == share_id, ShareLink.owner_id == user.id).values(revoked=True))
    if not result.rowcount:
        raise HTTPException(404, "Ссылка не найдена")
    return {"ok": True}


async def optional_user(request: Request, response: Response,
                        s: AsyncSession = Depends(get_session, scope="function")):
    try:
        return await current_user(request, response, s)
    except HTTPException as exc:
        if exc.status_code != 401:
            raise
        return None


async def available_link(s, token, user):
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,100}", token):
        raise HTTPException(404, "Ссылка недоступна")
    row = await s.scalar(select(ShareLink).where(ShareLink.token_hash == hash_token(token)))
    if not row or row.revoked or row.expires_at <= utcnow():
        raise HTTPException(404, "Ссылка отозвана или срок действия истёк")
    if row.access == "members":
        collection = await s.get(CommunityPlaylist, row.collection_id) if row.collection_id else None
        if not user or not collection or collection.archived or not role_of(collection, user):
            raise HTTPException(403, "Ссылка доступна только участникам плейлиста. Войдите в свой аккаунт")
    return row


@router.get("/api/public/{token}")
async def public_info(token: str, response: Response, user: User | None = Depends(optional_user),
                      s: AsyncSession = Depends(get_session, scope="function")):
    row = await available_link(s, token, user)
    response.headers.update(PRIVATE | {"Referrer-Policy": "no-referrer"})
    tracks = {t.uid: t for t in await s.scalars(select(Track).where(Track.uid.in_(row.tracks_json)))}
    return {"name": row.name, "access": row.access, "expires_at": row.expires_at,
            "tracks": [{"uid": uid, "title": tracks[uid].title if uid in tracks else "Файл недоступен",
                        "artist": tracks[uid].artist if uid in tracks else "",
                        "duration_s": tracks[uid].duration_s if uid in tracks else None,
                        "available": uid in tracks and safe_path(tracks[uid].path).is_file(),
                        "stream_url": f"/api/public/{token}/audio/{uid}"} for uid in row.tracks_json]}


@router.head("/api/public/{token}/audio/{uid}", include_in_schema=False)
@router.get("/api/public/{token}/audio/{uid}")
async def public_audio(token: str, uid: str, user: User | None = Depends(optional_user),
                       s: AsyncSession = Depends(get_session, scope="function")):
    row = await available_link(s, token, user)
    if uid not in row.tracks_json:
        raise HTTPException(404, "Трек не входит в эту ссылку")
    track = await s.scalar(select(Track).where(Track.uid == uid))
    if not track or not safe_path(track.path).is_file():
        raise HTTPException(404, "Файл больше не доступен")
    path = safe_path(track.path)
    return FileResponse(path, media_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                        headers=PRIVATE | {"Referrer-Policy": "no-referrer"})
