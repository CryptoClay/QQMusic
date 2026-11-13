"""Persistent user notifications and request progress, without third-party messaging."""
from sqlalchemy import select, update

from app.events import bus
from app.models import DownloadItem, InboxMessage, Job, MusicRequest, Track, utcnow


async def message(s, user_id, text, target="/requests"):
    s.add(InboxMessage(user_id=user_id, text=text[:1000], target=target))


async def reconcile_requests(s, batch_id=None):
    stmt = select(MusicRequest).where(MusicRequest.status == "preparing")
    if batch_id is not None:
        stmt = stmt.where(MusicRequest.batch_id == batch_id)
    for request in list(await s.scalars(stmt)):
        items = list(await s.scalars(select(DownloadItem).where(DownloadItem.batch_id == request.batch_id)))
        status = None
        if items and all(i.status == "done" and i.track_id for i in items):
            linked = await s.scalar(select(Track.nd_song_id).where(Track.id == items[0].track_id))
            if linked:
                status = "ready"
        elif items and all(i.status in {"done", "failed", "needs_review", "cancelled"} for i in items):
            status = "failed"
        elif not items:
            failed = await s.scalar(select(Job.id).where(Job.kind == "expand_batch", Job.status == "failed",
                Job.payload_json["batch_id"].as_integer() == request.batch_id).limit(1))
            if failed:
                status = "failed"
        if not status:
            continue
        changed = await s.execute(update(MusicRequest).where(MusicRequest.id == request.id,
            MusicRequest.status == "preparing").values(status=status, updated_at=utcnow()))
        if changed.rowcount:
            text = f"Готово: {request.artist} — {request.title}" if status == "ready" else f"Не удалось подготовить: {request.artist} — {request.title}"
            await message(s, request.user_id, text)


def community_changed(user_id):
    bus.publish(user_id, "community", {"changed": True})
