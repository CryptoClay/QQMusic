"""Listening to catalog tracks before downloading them (see app/listen.py)."""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from app import listen
from app.api.schemas import ListenOut, ListenPrefetchIn, ListenPrefetchOut
from app.auth import current_user
from app.models import User

router = APIRouter(prefix="/api/listen", tags=["listen"])


class PrepareIn(BaseModel):
    refs: list[str] = Field(default_factory=list, max_length=2)


@router.get("/status")
async def preparation_status(ref: str, user: User = Depends(current_user)):
    from app.preparation import status
    return JSONResponse(status(ref), headers={'Cache-Control': 'no-store'})


@router.post("/prepare")
async def prepare(body: PrepareIn, user: User = Depends(current_user)):
    from app.preparation import prepare
    return {"queued": prepare(user.id, body.refs)}


async def _choose(ref: str, *, full_only: bool = False, user: User | None = None, background: bool = False) -> listen.Choice:
    try:
        from app.api.music import preferred_ref
        seen = set()
        for _ in range(4):
            if ref in seen:
                raise HTTPException(409, 'Проверьте ссылки подтверждённых версий: обнаружен цикл')
            seen.add(ref)
            choice = await listen.choose(ref, full_only=full_only, background=background)
            target = await preferred_ref(user, choice) if user else ref
            if target == ref:
                return choice
            ref = target
        raise HTTPException(409, 'Слишком много переходов между версиями трека')
    except listen.ListenError as e:
        raise HTTPException(e.status, str(e)) from e


@router.get("", response_model=ListenOut)
async def resolve(ref: str, full: bool = False, user: User = Depends(current_user)):
    """Picks the file; full=1 excludes preview and carries that requirement into stream_url."""
    c = await _choose(ref, full_only=full, user=user)
    cand = c.candidate
    return ListenOut(
        ref=c.ref,
        kind=c.kind,
        artist=c.artist,
        title=c.title,
        duration_s=c.duration_s,
        provider=cand.provider if cand else None,
        bitrate_kbps=cand.bitrate_kbps if cand else None,
        page_url=cand.page_url if cand else None,
        nd_song_id=c.nd_song_id,
        stream_url=f"/api/listen/stream?ref={quote(c.ref, safe='')}{'&full=1' if full else ''}",
    )


@router.post("/prefetch", response_model=ListenPrefetchOut)
async def prefetch(body: ListenPrefetchIn, user: User = Depends(current_user)):
    """The tracks on the user's screen, top first: the Hub picks their files in the background (replaces the
    previous list)."""
    return ListenPrefetchOut(queued=listen.prefetch(user.id, body.refs))


@router.get("/preview")
async def preview(ref: str, request: Request, user: User = Depends(current_user)):
    """Proxy the catalog preview only; does not resolve or record a full-track listen."""
    try:
        choice = await listen.choose_preview(ref)
        response, source = await listen.open_stream(choice, request.headers.get("range"))
        media = listen._upstream_media(choice, response, source)
    except listen.ListenError as e:
        raise HTTPException(e.status, str(e)) from e
    headers = {**media.headers, "accept-ranges": "bytes", "cache-control": "no-store",
               "X-QQMusic-Listen-Kind": "preview", "X-HomeMusic-Listen-Kind": "preview"}
    if media.body is None:
        return Response(status_code=media.status, headers=headers)
    return StreamingResponse(media.body, status_code=media.status, headers=headers, media_type=media.media_type,
                             background=BackgroundTask(media.close) if media.close else None)


@router.get("/stream")
async def stream(ref: str, request: Request, q: str | None = None, full: bool = False, user: User = Depends(current_user)):
    """Audio of the chosen file (Range → 206): the library file, the server copy of the picked file (read while
    it downloads), the copy of a file of a source without plain HTTP audio, or a preview proxied from its source.
    `q=mobile`: the light variant for a metered network (Opus copy of a heavy file, `app.light`); the answer says
    which variant it is in `X-HomeMusic-Variant`."""
    rng = request.headers.get("range") or ""
    # the app loads the next tracks of its queue ahead (`X-HomeMusic-Prefetch`): that is no listen yet, its
    # `start` event is (app/api/plays.py), and its server copy waits for those of played tracks
    ahead = request.headers.get("x-qqmusic-prefetch", request.headers.get("x-homemusic-prefetch")) == "1"
    try:
        selected = await _choose(ref, full_only=full, user=user, background=ahead)
        m = await listen.open_media(selected.ref, rng or None, ahead=ahead, quality=q, full_only=full)
    except listen.ListenError as e:
        raise HTTPException(e.status, str(e)) from e
    if m.choice.kind == "full" and not ahead and (not rng or rng.startswith("bytes=0-")):
        from app.imports.core import listened

        await listened(user.id, ref)  # a track of an economy import is downloaded once listened to
    variant = {"X-QQMusic-Listen-Kind": m.choice.kind, "X-HomeMusic-Listen-Kind": m.choice.kind}
    if m.variant:
        variant["X-QQMusic-Variant"] = m.variant
        variant["X-HomeMusic-Variant"] = m.variant
    if m.path is not None:
        return FileResponse(m.path, media_type=m.media_type, headers={"Cache-Control": "no-store", **variant})
    headers = {**m.headers, "accept-ranges": "bytes", "cache-control": "no-store", **variant}
    if m.body is None:
        return Response(status_code=m.status, headers=headers)
    return StreamingResponse(m.body, status_code=m.status, headers=headers, media_type=m.media_type,
                             background=BackgroundTask(m.close) if m.close else None)
