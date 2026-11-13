"""Music requests, persistent inbox and revision-checked collaborative playlists."""
from datetime import timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import admin_user, current_user, user_navidrome
from app.community import community_changed, message, reconcile_requests
from app.db import get_session
from app.jobs.downloads import create_items
from app.jobs.queue import enqueue, notify
from app.models import CommunityPlaylist, DownloadBatch, InboxMessage, MusicRequest, ShareLink, Track, User, utcnow
from app.providers.base import TrackQuery

router = APIRouter(prefix="/api/community", tags=["community"])
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=512)]
Ref = Annotated[str, Field(max_length=200, pattern=r"^(?:nd|dz|hm|mb):[A-Za-z0-9_.-]+$")]
PRIVATE = {"Cache-Control": "private, no-store", "Vary": "Cookie"}


class RequestIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    artist: Text
    title: Text
    ref: Ref | None = None
    kind: Literal["track", "album"] = "track"

    @model_validator(mode="after")
    def album_ref(self):
        if self.kind == "album" and (not self.ref or not self.ref.startswith(("dz:", "hm:"))):
            raise ValueError("Album request requires a catalog album ref")
        return self


class Decision(BaseModel):
    action: Literal["approve", "reject"]
    note: str = Field(default="", max_length=1000)


def request_out(row, username=""):
    return {"id": row.id, "user_id": row.user_id, "username": username, "kind": row.kind,
            "artist": row.artist, "title": row.title, "ref": row.ref, "status": row.status,
            "note": row.note, "batch_id": row.batch_id, "created_at": row.created_at, "updated_at": row.updated_at}


@router.get("/requests")
async def requests(response: Response, user: User = Depends(current_user),
                   s: AsyncSession = Depends(get_session, scope="function")):
    await reconcile_requests(s)
    response.headers.update(PRIVATE)
    stmt = select(MusicRequest, User.nd_username).join(User, User.id == MusicRequest.user_id)
    if not user.is_admin:
        stmt = stmt.where(MusicRequest.user_id == user.id)
    rows = (await s.execute(stmt.order_by(MusicRequest.updated_at.desc(), MusicRequest.id.desc()).limit(200))).all()
    return [request_out(r, name) for r, name in rows]


@router.post("/requests")
async def new_request(body: RequestIn, user: User = Depends(current_user),
                      s: AsyncSession = Depends(get_session, scope="function")):
    await s.execute(update(User).where(User.id == user.id).values(last_seen_at=User.last_seen_at))
    previous = await s.scalar(select(MusicRequest).where(MusicRequest.user_id == user.id,
        MusicRequest.artist == body.artist, MusicRequest.title == body.title, MusicRequest.kind == body.kind,
        MusicRequest.status.in_(("pending", "preparing"))))
    if previous:
        return request_out(previous, user.nd_username)
    count = await s.scalar(select(func.count()).select_from(MusicRequest).where(
        MusicRequest.user_id == user.id, MusicRequest.created_at >= utcnow() - timedelta(days=1)))
    if count >= 50:
        raise HTTPException(429, "Не более 50 заявок в сутки")
    row = MusicRequest(user_id=user.id, **body.model_dump())
    s.add(row)
    await s.flush()
    for admin in await s.scalars(select(User.id).where(User.is_admin.is_(True), User.id != user.id)):
        await message(s, admin, f"Новая заявка: {body.artist} — {body.title}")
    await s.commit()
    community_changed(user.id)
    return request_out(row, user.nd_username)


@router.post("/requests/{request_id}/decision")
async def decide(request_id: int, body: Decision, user: User = Depends(admin_user),
                 s: AsyncSession = Depends(get_session, scope="function")):
    changed = await s.execute(update(MusicRequest).where(MusicRequest.id == request_id,
        MusicRequest.status.in_(("pending", "failed"))).values(status="preparing" if body.action == "approve" else "rejected",
        note=body.note, updated_at=utcnow()).returning(MusicRequest.id))
    if changed.first() is None:
        raise HTTPException(409, "Заявка уже обработана или не найдена")
    row = await s.get(MusicRequest, request_id, populate_existing=True)
    if body.action == "approve":
        if row.ref and row.ref.startswith("nd:"):
            track = await s.scalar(select(Track).where(Track.nd_song_id == row.ref[3:]))
            if not track:
                raise HTTPException(404, "Трек больше не доступен в библиотеке")
            row.status = "ready"
        else:
            batch = DownloadBatch(user_id=row.user_id, origin="request", title=f"{row.artist} — {row.title}")
            s.add(batch)
            await s.flush()
            row.batch_id = batch.id
            if row.kind == "album":
                await enqueue(s, "expand_batch", {"batch_id": batch.id, "album_refs": [row.ref], "track_refs": []})
            else:
                meta = {"track_ref": row.ref} if row.ref else {}
                if row.ref and row.ref.startswith("dz:"):
                    meta["deezer_track_id"] = row.ref[3:]
                await create_items(s, batch, [(TrackQuery(artist=row.artist, title=row.title), meta, None)])
    await message(s, row.user_id, f"Заявка: {row.artist} — {row.title}. " +
                  ("Музыка доступна" if row.status == "ready" else "Принята в загрузку" if body.action == "approve" else "Отклонена"))
    await s.commit()
    notify()
    community_changed(row.user_id)
    return request_out(row)


@router.delete("/requests/{request_id}")
async def cancel_request(request_id: int, user: User = Depends(current_user),
                         s: AsyncSession = Depends(get_session, scope="function")):
    changed = await s.execute(update(MusicRequest).where(MusicRequest.id == request_id,
        MusicRequest.user_id == user.id, MusicRequest.status == "pending").values(status="cancelled", updated_at=utcnow()))
    if not changed.rowcount:
        raise HTTPException(409, "Можно отменить только свою необработанную заявку")
    return {"ok": True}


@router.get("/inbox")
async def inbox(response: Response, user: User = Depends(current_user),
                s: AsyncSession = Depends(get_session, scope="function")):
    await reconcile_requests(s)
    response.headers.update(PRIVATE)
    rows = list(await s.scalars(select(InboxMessage).where(InboxMessage.user_id == user.id)
                               .order_by(InboxMessage.id.desc()).limit(100)))
    return {"unread": await s.scalar(select(func.count()).select_from(InboxMessage).where(
        InboxMessage.user_id == user.id, InboxMessage.read_at.is_(None))),
        "messages": [{"id": r.id, "text": r.text, "target": r.target, "created_at": r.created_at,
                      "read": r.read_at is not None} for r in rows]}


@router.post("/inbox/read")
async def read_inbox(ids: list[int], user: User = Depends(current_user),
                     s: AsyncSession = Depends(get_session, scope="function")):
    if len(ids) > 100:
        raise HTTPException(422, "Не более 100 уведомлений")
    stmt = update(InboxMessage).where(InboxMessage.user_id == user.id)
    if ids:
        stmt = stmt.where(InboxMessage.id.in_(ids))
    await s.execute(stmt.values(read_at=utcnow()))
    return {"ok": True}


class SongIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ref: Ref
    title: Text
    artist: Text
    duration_s: int | None = Field(default=None, ge=0, le=86400)


class CollectionIn(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    nd_playlist_id: str | None = Field(default=None, max_length=100)


class CollectionPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)] | None = None
    items: list[SongIn] | None = Field(default=None, max_length=500)
    username: str | None = Field(default=None, min_length=1, max_length=128)
    role: Literal["listener", "editor", "remove"] = "listener"
    archived: bool | None = None


def role_of(collection, user):
    return "owner" if collection.owner_id == user.id else (collection.members_json or {}).get(str(user.id))


async def collection_for(s, collection_id, user):
    row = await s.get(CommunityPlaylist, collection_id)
    if not row or not role_of(row, user):
        raise HTTPException(404, "Совместный плейлист не найден")
    return row


async def collection_out(s, row, user):
    ids = {row.owner_id, *(int(k) for k in row.members_json)}
    names = dict((await s.execute(select(User.id, User.nd_username).where(User.id.in_(ids)))).all())
    return {"id": row.id, "name": row.name, "owner_id": row.owner_id, "role": role_of(row, user),
            "revision": row.revision, "archived": row.archived, "items": row.items_json,
            "updated_at": row.updated_at,
            "members": [{"id": uid, "username": names.get(uid, "Удалённый аккаунт"),
                         "role": "owner" if uid == row.owner_id else row.members_json[str(uid)]} for uid in sorted(ids)]}


@router.get("/playlists")
async def collections(response: Response, archived: bool = False, user: User = Depends(current_user),
                      s: AsyncSession = Depends(get_session, scope="function")):
    response.headers.update(PRIVATE)
    rows = await s.scalars(select(CommunityPlaylist).where(CommunityPlaylist.archived == archived)
                           .order_by(CommunityPlaylist.updated_at.desc()))
    return [await collection_out(s, row, user) for row in rows if role_of(row, user)]


@router.post("/playlists")
async def new_collection(body: CollectionIn, user: User = Depends(current_user),
                         s: AsyncSession = Depends(get_session, scope="function")):
    await s.execute(update(User).where(User.id == user.id).values(last_seen_at=User.last_seen_at))
    count = await s.scalar(select(func.count()).select_from(CommunityPlaylist).where(CommunityPlaylist.owner_id == user.id))
    if count >= 100:
        raise HTTPException(409, "Не более 100 совместных плейлистов")
    items = []
    if body.nd_playlist_id:
        nd = user_navidrome(user)
        try:
            source = await nd.get_playlist(body.nd_playlist_id)
        finally:
            await nd.aclose()
        if source.get("owner") != user.nd_username:
            raise HTTPException(403, "Можно перенести только свой плейлист")
        if len(source.get("entry", [])) > 500:
            raise HTTPException(422, "Не более 500 треков")
        items = [SongIn(ref="nd:" + t["id"], title=t.get("title") or "Трек", artist=t.get("artist") or "Неизвестный исполнитель",
                        duration_s=t.get("duration")).model_dump() for t in source.get("entry", [])]
    row = CommunityPlaylist(owner_id=user.id, name=body.name, items_json=items)
    s.add(row)
    await s.flush()
    return await collection_out(s, row, user)


@router.get("/playlists/{collection_id}")
async def get_collection(collection_id: int, response: Response, user: User = Depends(current_user),
                         s: AsyncSession = Depends(get_session, scope="function")):
    response.headers.update(PRIVATE)
    return await collection_out(s, await collection_for(s, collection_id, user), user)


@router.patch("/playlists/{collection_id}")
async def patch_collection(collection_id: int, body: CollectionPatch, user: User = Depends(current_user),
                           s: AsyncSession = Depends(get_session, scope="function")):
    row = await collection_for(s, collection_id, user)
    role = role_of(row, user)
    if role == "listener" or ((body.username is not None or body.archived is not None) and role != "owner"):
        raise HTTPException(403, "Недостаточно прав для изменения плейлиста")
    if row.archived and not (role == "owner" and body.archived is False):
        raise HTTPException(409, "Сначала восстановите плейлист из архива")
    values = {"revision": row.revision + 1, "updated_at": utcnow()}
    if body.name is not None:
        values["name"] = body.name
    if body.items is not None:
        values["items_json"] = [t.model_dump() for t in body.items]
    if body.archived is not None:
        values["archived"] = body.archived
    invited = None
    if body.username is not None:
        invited = await s.scalar(select(User).where(User.nd_username == body.username.strip()))
        if not invited or invited.id == row.owner_id:
            raise HTTPException(404, "Участник не найден или уже является владельцем")
        members = dict(row.members_json)
        if body.role == "remove":
            members.pop(str(invited.id), None)
        else:
            members[str(invited.id)] = body.role
        if len(members) > 50:
            raise HTTPException(422, "Не более 50 участников")
        values["members_json"] = members
    changed = await s.execute(update(CommunityPlaylist).where(CommunityPlaylist.id == row.id,
        CommunityPlaylist.revision == body.revision).values(**values), execution_options={"synchronize_session": False})
    if not changed.rowcount:
        raise HTTPException(409, "Плейлист изменился. Обновите страницу перед сохранением")
    if invited:
        await message(s, invited.id, f"Доступ к плейлисту «{row.name}» изменён: {body.role}", f"/community-playlist/{row.id}")
    if body.archived:
        await s.execute(update(ShareLink).where(ShareLink.collection_id == row.id).values(revoked=True))
    await s.refresh(row)
    await s.commit()
    for uid in {row.owner_id, *(int(k) for k in row.members_json)}:
        community_changed(uid)
    return await collection_out(s, row, user)
