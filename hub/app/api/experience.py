"""Account welcome state, personal home shortcuts and passive server overview."""
import asyncio
import shutil

from fastapi import APIRouter, Depends, Response
from sqlalchemy import func, or_, select, text
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.community import PRIVATE, role_of
from app.auth import admin_user, current_user
from app.budgets import ACTIVE
from app.config import get_settings
from app.db import get_session
from app.models import CommunityPlaylist, DownloadItem, Job, MusicPreferences, MusicRequest, ResumeState, User
from app.services import svc
from app.source_status import reason, snapshot

router = APIRouter(prefix="/api/experience", tags=["experience"])


@router.get("/home")
async def home(response: Response, user: User = Depends(current_user),
               s: AsyncSession = Depends(get_session, scope="function")):
    response.headers.update(PRIVATE)
    preferences = await s.get(MusicPreferences, user.id)
    resume = await s.scalar(select(ResumeState).where(ResumeState.user_id == user.id)
                            .order_by(ResumeState.updated_at.desc()).limit(1))
    playlists = [p for p in await s.scalars(select(CommunityPlaylist).where(
        CommunityPlaylist.archived.is_(False), or_(CommunityPlaylist.owner_id == user.id,
        func.json_extract(CommunityPlaylist.members_json, f'$."{user.id}"').in_(("editor", "listener"))))
        .order_by(CommunityPlaylist.updated_at.desc(), CommunityPlaylist.id.desc()).limit(6)) if role_of(p, user)]
    return {"welcome_done": bool(preferences and preferences.data_json.get("welcome_done")),
            "resume": {"device": resume.device, "updated_at": resume.updated_at, **resume.data_json} if resume else None,
            "playlists": [{"id": p.id, "name": p.name, "count": len(p.items_json)} for p in playlists[:6]],
            "requests_pending": await s.scalar(select(func.count()).select_from(MusicRequest).where(
                MusicRequest.user_id == user.id, MusicRequest.status.in_(("pending", "preparing"))))}


@router.put("/welcome")
async def complete_welcome(response: Response, user: User = Depends(current_user),
                           s: AsyncSession = Depends(get_session, scope="function")):
    response.headers.update(PRIVATE)
    # JSON update preserves sound preferences, including concurrent edits from another browser.
    await s.execute(insert(MusicPreferences).values(user_id=user.id, data_json={"welcome_done": True})
                    .on_conflict_do_update(index_elements=["user_id"], set_={
                        "data_json": func.json_set(MusicPreferences.data_json, "$.welcome_done", text("json('true')"))}))
    return {"ok": True}


@router.get("/server")
async def server(response: Response, user: User = Depends(admin_user),
                 s: AsyncSession = Depends(get_session, scope="function")):
    from app.api.system import _navidrome_ok

    response.headers.update(PRIVATE)
    cfg = get_settings()
    def disks():
        result = []
        for name, path in (("Музыка", cfg.library_dir), ("База и настройки", cfg.data_dir)):
            try:
                disk = shutil.disk_usage(path)
                result.append({"name": name, "total": disk.total, "used": disk.used, "free": disk.free})
            except OSError:
                result.append({"name": name, "total": None, "used": None, "free": None})
        return result
    counts = dict((await s.execute(select(DownloadItem.status, func.count()).group_by(DownloadItem.status))).all())
    jobs = dict((await s.execute(select(Job.status, func.count()).group_by(Job.status))).all())
    failures = list(await s.scalars(select(DownloadItem).where(DownloadItem.status == "failed")
                                    .order_by(DownloadItem.updated_at.desc(), DownloadItem.id.desc()).limit(10)))
    disk_info, navidrome = await asyncio.gather(asyncio.to_thread(disks), _navidrome_ok())
    return {"disks": disk_info, "navidrome": navidrome, "downloads": counts, "jobs": jobs,
            "active": sum(counts.get(status, 0) for status in ACTIVE),
            "sources": [{"name": name, **snapshot(name)} for name in svc.providers],
            "failures": [{"id": item.id, "title": str((item.query_json.get("query") or item.query_json).get("title") or "Без названия")[:512],
                          "artist": str((item.query_json.get("query") or item.query_json).get("artist") or "")[:512],
                          "reason": reason(item.error or ""), "updated_at": item.updated_at} for item in failures]}
