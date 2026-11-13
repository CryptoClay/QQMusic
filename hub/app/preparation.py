"""Bounded queue look-ahead and passive playback preparation status."""

import asyncio

WARM_BYTES = 64 * 1024 * 1024
_jobs: dict[int, tuple[list[str], asyncio.Task]] = {}
_slots = None


def status(ref: str) -> dict:
    from app import listen

    c = listen._choices.get(ref)
    if ref in listen._inflight or c is None:
        return {"stage": "checking", "progress": None}
    if c.kind == "library" or (c.local and c.local.is_file()):
        return {"stage": "ready", "progress": 1}
    if ref in listen._fetching:
        return {"stage": "preparing", "progress": listen._local_progress.get(ref)}
    cp = listen._copies.get(ref)
    if cp:
        if cp.done:
            return {"stage": "ready", "progress": 1}
        if cp.failed and not isinstance(cp.failed, listen._DownloadRequired):
            return {"stage": "error", "progress": None}
        return {"stage": "preparing", "progress": min(0.99, cp.have / cp.size) if cp.size else None}
    return {"stage": "checking", "progress": None}


def prepare(user_id: int, refs: list[str]) -> int:
    from app import listen

    refs = list(dict.fromkeys(refs))[:2]
    old = _jobs.get(user_id)
    if old and old[0] == refs:
        return len(refs)
    if old:
        old[1].cancel()
    if not refs:
        _jobs.pop(user_id, None)
        return 0
    _jobs[user_id] = refs, listen._spawn(_warm(refs), background=True)
    return len(refs)


async def _warm(refs: list[str]) -> None:
    from app import listen

    global _slots

    if _slots is None:
        _slots = asyncio.Semaphore(2)
    async with _slots:
        remaining = WARM_BYTES
        for ref in refs:
            if remaining <= 0:
                break
            cp = None
            try:
                c = await listen.choose(ref, background=True, full_only=True)
                if c.kind != "full" or not c.candidate:
                    continue
                duration = c.duration_s or c.candidate.duration_s
                if not duration or duration > 900 or duration * (c.candidate.bitrate_kbps or 320) * 125 > remaining:
                    continue
                provider = listen.svc.providers.get(c.candidate.provider)
                if not listen._downloads_only(c):
                    cp = listen._server_copy(c, background=True)
                    cp.byte_limit = remaining
                    await cp.until(cp.settled)
                    remaining -= cp.have
                    if cp.done:
                        continue
                    if not isinstance(cp.failed, listen._DownloadRequired):
                        continue
                if remaining > 0 and getattr(provider, "bounded_fetch", False):
                    path = await listen._predownload(c, max_bytes=remaining)
                    remaining -= path.stat().st_size
            except asyncio.CancelledError:
                if cp and cp.task and cp.prio.background and not cp.readers:
                    cp.task.cancel()
                job = listen._fetching.get(ref)
                if job and job.prio.background:
                    job.task.cancel()
                raise
            except Exception:
                continue  # foreground playback reports the error or retries without the warm-up budget


def reset():
    global _slots
    for _, task in _jobs.values():
        task.cancel()
    _jobs.clear()
    _slots = None
