"""User budgets, private device snapshots and explicit track version preferences."""
import asyncio
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from sqlalchemy import delete, select, update
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app import budgets
from app.api.community import PRIVATE
from app.api.library_care import safe_path
from app.auth import admin_user, current_user
from app.db import get_session
from app.models import ResumeState, Track, User, UserPolicy, VersionGroup, VersionMember, VersionPreference, utcnow

router = APIRouter(prefix="/api/community", tags=["community"])


@router.get("/library-search")
async def library_search(response: Response, q: str = Query("", max_length=200), user: User = Depends(current_user),
                         s: AsyncSession = Depends(get_session, scope="function")):
    response.headers.update(PRIVATE)
    stmt = select(Track).where(Track.nd_song_id.is_not(None))
    for word in q.strip().split():
        stmt = stmt.where((Track.artist + " " + Track.title).icontains(word, autoescape=True))
    return [{"id": t.id, "ref": "nd:" + t.nd_song_id, "title": t.title, "artist": t.artist,
             "duration_s": t.duration_s, "codec": t.codec, "bitrate_kbps": t.bitrate_kbps}
            for t in await s.scalars(stmt.order_by(Track.artist, Track.title, Track.id).limit(50))]


class Policy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    max_queue: int = Field(default=0, ge=0, le=100000)
    storage_mb: int = Field(default=0, ge=0, le=10000000)
    upload_mb: int = Field(default=0, ge=0, le=100000)
    parallel: int = Field(default=0, ge=0, le=64)


@router.get("/limits")
async def own_limits(response: Response, user: User = Depends(current_user),
                     s: AsyncSession = Depends(get_session, scope="function")):
    response.headers.update(PRIVATE)
    return await budgets.usage(s, user.id)


@router.get("/limits/users")
async def all_limits(response: Response, user: User = Depends(admin_user),
                     s: AsyncSession = Depends(get_session, scope="function")):
    response.headers.update(PRIVATE)
    return [{"id": u.id, "username": u.nd_username, **await budgets.usage(s, u.id)}
            for u in await s.scalars(select(User).order_by(User.id))]


@router.put("/limits/users/{user_id}")
async def set_limits(user_id: int, body: Policy, user: User = Depends(admin_user),
                     s: AsyncSession = Depends(get_session, scope="function")):
    if not await s.get(User, user_id):
        raise HTTPException(404, "Пользователь не найден")
    tracks = list(await s.scalars(select(Track).where(Track.added_by == user_id)))
    def sizes():
        result = {}
        for t in tracks:
            try:
                result[t.id] = safe_path(t.path).stat().st_size
            except (OSError, HTTPException):
                result[t.id] = 0
        return result
    for tid, size in (await asyncio.to_thread(sizes)).items():
        await s.execute(update(Track).where(Track.id == tid).values(size_bytes=size))
    await s.execute(insert(UserPolicy).values(user_id=user_id, **body.model_dump()).on_conflict_do_update(
        index_elements=["user_id"], set_=body.model_dump()))
    return await budgets.usage(s, user_id)


class ResumeSong(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ref: str = Field(min_length=3, max_length=4096, pattern=r"^(?:nd|dz|hm|mb|file):\S+$")
    title: str = Field(default="Трек", max_length=512)
    artist: str = Field(default="", max_length=512)
    duration_s: int | None = Field(default=None, ge=0, le=86400)


class Snapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account: int
    label: str = Field(default="Браузер", min_length=1, max_length=100)
    queue: list[ResumeSong] = Field(min_length=1, max_length=200)
    index: int = Field(ge=0, lt=200)
    position: float = Field(ge=0, le=86400, allow_inf_nan=False)

    @model_validator(mode="after")
    def current_track(self):
        if self.index >= len(self.queue):
            raise ValueError("Queue index out of bounds")
        duration = self.queue[self.index].duration_s
        if duration:
            self.position = min(self.position, max(0, duration - 1))
        return self


@router.get("/resume")
async def snapshots(response: Response, user: User = Depends(current_user),
                    s: AsyncSession = Depends(get_session, scope="function")):
    response.headers.update(PRIVATE)
    return [{"device": r.device, "updated_at": r.updated_at, **r.data_json}
            for r in await s.scalars(select(ResumeState).where(ResumeState.user_id == user.id)
                                    .order_by(ResumeState.updated_at.desc()).limit(10))]


@router.put("/resume/{device}")
async def save_snapshot(device: str, body: Snapshot, user: User = Depends(current_user),
                        s: AsyncSession = Depends(get_session, scope="function")):
    if not 1 <= len(device) <= 100 or not all(c.isalnum() or c in "-_" for c in device):
        raise HTTPException(422, "Некорректный идентификатор устройства")
    if body.account != user.id:
        raise HTTPException(409, "Аккаунт изменился. Обновите страницу")
    data = body.model_dump()
    await s.execute(insert(ResumeState).values(user_id=user.id, device=device, data_json=data, updated_at=utcnow())
        .on_conflict_do_update(index_elements=["user_id", "device"], set_={"data_json": data, "updated_at": utcnow()}))
    stale = list(await s.scalars(select(ResumeState.device).where(ResumeState.user_id == user.id)
                                .order_by(ResumeState.updated_at.desc(), ResumeState.device).offset(10)))
    if stale:
        await s.execute(delete(ResumeState).where(ResumeState.user_id == user.id, ResumeState.device.in_(stale)))
    return {"ok": True}


@router.delete("/resume/{device}")
async def forget_snapshot(device: str, user: User = Depends(current_user),
                          s: AsyncSession = Depends(get_session, scope="function")):
    await s.execute(delete(ResumeState).where(ResumeState.user_id == user.id, ResumeState.device == device))
    return {"ok": True}


class Member(BaseModel):
    track_id: int = Field(gt=0)
    kind: Literal["original", "clean", "live", "remix", "acoustic", "other"]


class GroupIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=512)]
    members: list[Member] = Field(min_length=2, max_length=20)
    revision: int | None = Field(default=None, ge=1)


class PreferenceIn(BaseModel):
    track_id: int | None = Field(default=None, gt=0)


async def group_out(s, group, user):
    members = (await s.execute(select(VersionMember, Track).join(Track, Track.id == VersionMember.track_id)
                               .where(VersionMember.group_id == group.id).order_by(Track.id))).all()
    pref = await s.get(VersionPreference, (user.id, group.id))
    return {"id": group.id, "name": group.name, "revision": group.revision,
            "preferred_track_id": pref.track_id if pref else None,
            "members": [{"track_id": t.id, "kind": m.kind, "ref": "nd:" + t.nd_song_id if t.nd_song_id else None,
                         "title": t.title, "artist": t.artist, "codec": t.codec,
                         "bitrate_kbps": t.bitrate_kbps, "duration_s": t.duration_s} for m, t in members]}


@router.get("/versions")
async def groups(response: Response, user: User = Depends(current_user),
                 s: AsyncSession = Depends(get_session, scope="function")):
    response.headers.update(PRIVATE)
    return [await group_out(s, g, user) for g in await s.scalars(select(VersionGroup).order_by(VersionGroup.id.desc()))]


async def write_group(s, body, group_id=None):
    ids = [m.track_id for m in body.members]
    if len(ids) != len(set(ids)):
        raise HTTPException(422, "Трек указан несколько раз")
    found = list(await s.scalars(select(Track.id).where(Track.id.in_(ids))))
    if set(found) != set(ids):
        raise HTTPException(404, "Трек не найден")
    other = select(VersionMember.track_id).where(VersionMember.track_id.in_(ids))
    if group_id:
        other = other.where(VersionMember.group_id != group_id)
    if await s.scalar(other.limit(1)):
        raise HTTPException(409, "Один из треков уже связан с другой группой версий")
    if group_id:
        result = await s.execute(update(VersionGroup).where(VersionGroup.id == group_id,
            VersionGroup.revision == body.revision).values(name=body.name, revision=VersionGroup.revision + 1))
        if not result.rowcount:
            raise HTTPException(409, "Группа изменилась. Обновите страницу")
        await s.execute(delete(VersionMember).where(VersionMember.group_id == group_id))
        await s.execute(delete(VersionPreference).where(VersionPreference.group_id == group_id,
                                                       VersionPreference.track_id.not_in(ids)))
        group = await s.get(VersionGroup, group_id, populate_existing=True)
    else:
        group = VersionGroup(name=body.name)
        s.add(group)
        await s.flush()
    s.add_all(VersionMember(track_id=m.track_id, group_id=group.id, kind=m.kind) for m in body.members)
    await s.flush()
    return group


@router.post("/versions")
async def new_group(body: GroupIn, user: User = Depends(admin_user),
                    s: AsyncSession = Depends(get_session, scope="function")):
    await s.execute(update(User).where(User.id == user.id).values(last_seen_at=User.last_seen_at))
    return await group_out(s, await write_group(s, body), user)


@router.put("/versions/{group_id}")
async def edit_group(group_id: int, body: GroupIn, user: User = Depends(admin_user),
                     s: AsyncSession = Depends(get_session, scope="function")):
    await s.execute(update(User).where(User.id == user.id).values(last_seen_at=User.last_seen_at))
    return await group_out(s, await write_group(s, body, group_id), user)


@router.put("/versions/{group_id}/preference")
async def choose_version(group_id: int, body: PreferenceIn, user: User = Depends(current_user),
                         s: AsyncSession = Depends(get_session, scope="function")):
    group = await s.get(VersionGroup, group_id)
    if not group:
        raise HTTPException(404, "Группа не найдена")
    if body.track_id is None:
        await s.execute(delete(VersionPreference).where(VersionPreference.user_id == user.id,
                                                        VersionPreference.group_id == group_id))
    else:
        member = await s.get(VersionMember, body.track_id)
        track = await s.get(Track, body.track_id)
        if not member or member.group_id != group_id or not track or not track.nd_song_id:
            raise HTTPException(409, "Выберите доступную версию из этой группы")
        await s.execute(insert(VersionPreference).values(user_id=user.id, group_id=group_id, track_id=body.track_id)
            .on_conflict_do_update(index_elements=["user_id", "group_id"], set_={"track_id": body.track_id}))
    return await group_out(s, group, user)


@router.delete("/versions/{group_id}")
async def unlink_versions(group_id: int, user: User = Depends(admin_user),
                          s: AsyncSession = Depends(get_session, scope="function")):
    await s.execute(delete(VersionGroup).where(VersionGroup.id == group_id))
    return {"ok": True}
