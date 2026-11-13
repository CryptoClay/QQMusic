"""Optional per-user budgets. Zero inherits the existing unrestricted behaviour."""
import asyncio
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy import func, or_, select, update

from app.config import get_settings
from app.models import DownloadItem, Track, Upload, UserPolicy, utcnow

ACTIVE = ("queued", "searching", "downloading", "tagging", "importing")
MIB = 1024 * 1024


def queued_count(user_id):
    return select(func.count(DownloadItem.id)).where(DownloadItem.user_id == user_id,
                                                    DownloadItem.status.in_(ACTIVE)).scalar_subquery()


def stored_bytes(user_id, exclude_upload=None):
    library = select(func.coalesce(func.sum(Track.size_bytes), 0)).where(Track.added_by == user_id).scalar_subquery()
    staged = select(func.coalesce(func.sum(Upload.size), 0)).where(
        Upload.user_id == user_id, Upload.status.in_(("uploaded", "failed")),
        Upload.created_at >= utcnow() - timedelta(days=7))
    if exclude_upload:
        staged = staged.where(Upload.staging_path != exclude_upload)
    return library + staged.scalar_subquery()


async def queue_budget(s, user_id, count):
    if not count:
        return
    # A guarded write serializes the check and subsequent inserts in SQLite;
    # no in-memory counter can drift after cancellation or a process restart.
    result = await s.execute(update(UserPolicy).where(UserPolicy.user_id == user_id,
        or_(UserPolicy.max_queue == 0, queued_count(user_id) + count <= UserPolicy.max_queue))
        .values(max_queue=UserPolicy.max_queue).returning(UserPolicy.user_id),
        execution_options={"synchronize_session": False})
    if result.first() is None and await s.get(UserPolicy, user_id):
        raise HTTPException(429, "Достигнут лимит очереди загрузок. Дождитесь завершения текущих заданий")


async def storage_budget(s, user_id, size, exclude_upload=None):
    if not user_id:
        return
    result = await s.execute(update(UserPolicy).where(UserPolicy.user_id == user_id,
        or_(UserPolicy.upload_mb == 0, size <= UserPolicy.upload_mb * MIB),
        or_(UserPolicy.storage_mb == 0, stored_bytes(user_id, exclude_upload) + size <= UserPolicy.storage_mb * MIB))
        .values(storage_mb=UserPolicy.storage_mb).returning(UserPolicy.user_id),
        execution_options={"synchronize_session": False})
    if result.first() is None:
        policy = await s.get(UserPolicy, user_id)
        if policy and policy.upload_mb and size > policy.upload_mb * MIB:
            raise HTTPException(413, f"Файл больше вашего лимита: {policy.upload_mb} МиБ")
        if policy:
            raise HTTPException(413, "Недостаточно места в вашей квоте. Обратитесь к администратору")


async def usage(s, user_id):
    unknown = list(await s.scalars(select(Track).where(Track.added_by == user_id, Track.size_bytes.is_(None))))
    if unknown:
        def measure():
            root = get_settings().library_dir.resolve()
            sizes = {}
            for track in unknown:
                path = (root / track.path).resolve()
                try:
                    sizes[track.id] = path.stat().st_size if path.is_relative_to(root) and path.is_file() else 0
                except OSError:
                    sizes[track.id] = 0
            return sizes
        for track_id, size in (await asyncio.to_thread(measure)).items():
            await s.execute(update(Track).where(Track.id == track_id, Track.size_bytes.is_(None)).values(size_bytes=size))
    policy = await s.get(UserPolicy, user_id)
    return {"max_queue": policy.max_queue if policy else 0, "storage_mb": policy.storage_mb if policy else 0,
            "upload_mb": policy.upload_mb if policy else 0, "parallel": policy.parallel if policy else 0,
            "queued": await s.scalar(select(queued_count(user_id))),
            "used_bytes": await s.scalar(select(stored_bytes(user_id)))}
