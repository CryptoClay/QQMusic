"""Shared musical context; strictly owner-scoped annotations, playback preferences and recaps."""

import asyncio
import base64
import calendar
import io
from datetime import datetime, timedelta
from typing import Annotated, Literal
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from PIL import Image, ImageOps
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import admin_user, current_user
from app.db import get_session, session_scope
from app.insights import analytics, launches, names
from app.models import (
    DownloadItem,
    MusicEditorial,
    MusicPreferences,
    MusicPrivate,
    Track,
    User,
    VersionMember,
    VersionPreference,
    utcnow,
)

router = APIRouter(prefix="/api/music", tags=["music"])
Ref = Annotated[str, Field(min_length=3, max_length=200, pattern=r"^(?:dz|hm|mb|nd|file):[^\s]+$")]
Text = Annotated[str, Field(max_length=40000)]
Tag = Annotated[str, Field(min_length=1, max_length=40)]
PRIVATE = {"Cache-Control": "private, no-store", "Vary": "Cookie"}


class Preferences(BaseModel):
    prefer_original: bool = False
    radio_mode: Literal["normal", "favorites", "discover"] = "normal"
    eq_enabled: bool = False
    eq_gains: list[float] = Field(default_factory=lambda: [0] * 6, min_length=6, max_length=6)
    normalization: bool = False
    crossfade_s: float = Field(default=0, ge=0, le=10)

    @field_validator("eq_gains")
    @classmethod
    def gains(cls, values):
        if any(not -12 <= value <= 12 for value in values):
            raise ValueError("Each band must be between -12 and 12 dB")
        return values


class Personal(BaseModel):
    note: str = Field(default="", max_length=4000)
    tags: list[Tag] = Field(default_factory=list, max_length=20)
    plain_lyrics: Text = ""
    synced_lyrics: Text = ""
    artist: str = Field(default="", max_length=512)
    title: str = Field(default="", max_length=512)
    lyrics_source: str = Field(default="", max_length=2048)

    @field_validator("lyrics_source")
    @classmethod
    def lyrics_url(cls, value):
        if value and (urlsplit(value).scheme != "https" or not urlsplit(value).hostname):
            raise ValueError("Source must be an HTTPS URL")
        return value

    @field_validator("tags")
    @classmethod
    def unique_tags(cls, values):
        return list(dict.fromkeys(value.strip().lower() for value in values if value.strip()))


class Lyrics(BaseModel):
    plain_lyrics: Text = ""
    synced_lyrics: Text = ""
    source: str = Field(default="", max_length=2048)

    @field_validator("source")
    @classmethod
    def source_url(cls, value):
        if value and (urlsplit(value).scheme != "https" or not urlsplit(value).hostname):
            raise ValueError("Source must be an HTTPS URL")
        return value


class Version(BaseModel):
    ref: Ref
    status: Literal["unknown", "original", "edited"] = "unknown"
    note: str = Field(default="", max_length=2000)
    original_ref: Ref | None = None


class Profile(BaseModel):
    biography: str = Field(default="", max_length=12000)
    members: list[Annotated[str, Field(max_length=200)]] = Field(default_factory=list, max_length=100)
    related: list[Annotated[str, Field(max_length=200)]] = Field(default_factory=list, max_length=30)
    source: str = Field(default="", max_length=2048)
    cover_url: str = Field(default="", max_length=400000)

    @field_validator("source")
    @classmethod
    def source_url(cls, value):
        return Lyrics.source_url(value)

    @field_validator("cover_url")
    @classmethod
    def cover(cls, value):
        if value:
            if not value.startswith("data:image/jpeg;base64,"):
                raise ValueError("Upload the cover using the cover endpoint")
            try:
                image = Image.open(io.BytesIO(base64.b64decode(value.split(",", 1)[1], validate=True)))
                if image.format != "JPEG" or image.width > 1024 or image.height > 1024:
                    raise ValueError
                image.verify()
            except Exception:
                raise ValueError("Invalid cover") from None
        return value


async def editorial(s, key):
    row = await s.get(MusicEditorial, key)
    return row.data_json if row else {}


async def put_editorial(s, key, data, user):
    await s.execute(
        insert(MusicEditorial)
        .values(key=key, data_json=data, updated_by=user.id, updated_at=utcnow())
        .on_conflict_do_update(
            index_elements=["key"], set_={"data_json": data, "updated_by": user.id, "updated_at": utcnow()}
        )
    )


async def canonical(s, ref):
    if ref.startswith("nd:"):
        track = await s.scalar(select(Track).where(Track.nd_song_id == ref[3:]))
        if track and track.deezer_track_id:
            return "dz:" + track.deezer_track_id
    return ref


def version_ref(ref, choice=None):
    from app import listen

    choice = choice or listen._choices.get(ref)
    if choice and choice.kind == "full" and choice.candidate:
        return f"file:{choice.candidate.provider}:{choice.candidate.provider_id}"
    return ref


async def stored_version_ref(s, ref, choice=None):
    direct = version_ref(ref, choice)
    if direct != ref or ref.startswith("file:"):
        return direct
    column = Track.nd_song_id if ref.startswith("nd:") else Track.deezer_track_id
    if not ref.startswith(("nd:", "dz:")):
        return ref
    track = await s.scalar(select(Track).where(column == ref.split(":", 1)[1]).order_by(Track.id.desc()))
    if track:
        item = await s.scalar(
            select(DownloadItem)
            .where(DownloadItem.track_id == track.id, DownloadItem.chosen_candidate_json.is_not(None))
            .order_by(DownloadItem.id.desc())
        )
        if item:
            candidate = item.chosen_candidate_json
            if candidate.get("provider") and candidate.get("provider_id"):
                return f"file:{candidate['provider']}:{candidate['provider_id']}"
        if track.nd_song_id:
            return "nd:" + track.nd_song_id
    return ref


async def preferred_ref(user, choice):
    """A preference never mutates the shared resolver cache or another user's pick."""
    async with session_scope() as s:
        track = None
        if getattr(choice, "nd_song_id", None):
            track = await s.scalar(select(Track).where(Track.nd_song_id == choice.nd_song_id))
        elif choice.ref.startswith("dz:"):
            track = await s.scalar(select(Track).where(Track.deezer_track_id == choice.ref[3:]).order_by(Track.id))
        member = await s.get(VersionMember, track.id) if track else None
        selected = await s.get(VersionPreference, (user.id, member.group_id)) if member else None
        if selected and selected.track_id:
            target = await s.get(Track, selected.track_id)
            target_member = await s.get(VersionMember, selected.track_id)
            if target and target.nd_song_id and target_member and target_member.group_id == member.group_id:
                return "nd:" + target.nd_song_id
        pref = await s.get(MusicPreferences, user.id)
        if not pref or not pref.data_json.get("prefer_original"):
            return choice.ref
        version = await editorial(s, "version:" + await stored_version_ref(s, choice.ref, choice))
        if version.get("status") != "edited":
            return choice.ref
        target = version.get("original_ref")
        if not target or target == choice.ref:
            raise HTTPException(
                409,
                "Эта версия изменена. Подтверждённый оригинал пока не указан; можно изменить предпочтение в настройках музыки",
            )
        return target


@router.get("/preferences")
async def preferences(
    response: Response, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")
):
    row = await s.get(MusicPreferences, user.id)
    response.headers.update(PRIVATE)
    return Preferences.model_validate(row.data_json if row else {})


@router.put("/preferences")
async def save_preferences(
    body: Preferences, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")
):
    data = body.model_dump()
    await s.execute(
        insert(MusicPreferences)
        .values(user_id=user.id, data_json=data)
        .on_conflict_do_update(index_elements=["user_id"], set_={"data_json": data})
    )
    await s.commit()
    return data


@router.get("/track")
async def track(
    response: Response,
    ref: Ref,
    played_ref: Ref | None = None,
    user: User = Depends(current_user),
    s: AsyncSession = Depends(get_session, scope="function"),
):
    song = await canonical(s, ref)
    shared = await editorial(s, "track:" + song)
    row = await s.get(MusicPrivate, (user.id, song))
    personal = row.data_json if row else {}
    own = bool(personal.get("synced_lyrics") or personal.get("plain_lyrics"))
    vref = await stored_version_ref(s, played_ref or ref)
    version = await editorial(s, "version:" + vref)
    response.headers.update(PRIVATE)
    return {
        "ref": song,
        "shared": shared,
        "personal": personal,
        "version_ref": vref,
        "can_confirm_version": vref.startswith(("file:", "nd:")),
        "version": version or {"status": "unknown"},
        "lyrics": {
            "plain": (personal if own else shared).get("plain_lyrics", ""),
            "synced": (personal if own else shared).get("synced_lyrics", ""),
            "source": (personal.get("lyrics_source") or "Личный текст") if own else shared.get("source", ""),
        },
    }


@router.put("/personal")
async def personal(
    body: Personal,
    ref: Ref,
    user: User = Depends(current_user),
    s: AsyncSession = Depends(get_session, scope="function"),
):
    ref = await canonical(s, ref)
    data = body.model_dump()
    await s.execute(
        insert(MusicPrivate)
        .values(user_id=user.id, ref=ref, data_json=data, updated_at=utcnow())
        .on_conflict_do_update(index_elements=["user_id", "ref"], set_={"data_json": data, "updated_at": utcnow()})
    )
    await s.commit()
    return {"ok": True}


@router.get("/notes")
async def notes(
    response: Response,
    q: str = Query("", max_length=512),
    tag: str = Query("", max_length=40),
    user: User = Depends(current_user),
    s: AsyncSession = Depends(get_session, scope="function"),
):
    rows = await s.stream_scalars(
        select(MusicPrivate)
        .where(MusicPrivate.user_id == user.id)
        .order_by(MusicPrivate.updated_at.desc())
        .execution_options(yield_per=100)
    )
    result = []
    async for row in rows:
        data = row.data_json
        if tag and tag.strip().lower() not in data.get("tags", []):
            continue
        if (
            q
            and q.lower()
            not in " ".join(
                [data.get("note", ""), data.get("artist", ""), data.get("title", ""), *data.get("tags", [])]
            ).lower()
        ):
            continue
        if data.get("note") or data.get("tags"):
            result.append(
                {
                    "ref": row.ref,
                    **{key: data.get(key, [] if key == "tags" else "") for key in ("note", "tags", "artist", "title")},
                }
            )
            if len(result) >= 200:
                break
    await rows.close()
    response.headers.update(PRIVATE)
    return result[:200]


@router.put("/lyrics")
async def save_lyrics(
    body: Lyrics, ref: Ref, user: User = Depends(admin_user), s: AsyncSession = Depends(get_session, scope="function")
):
    await put_editorial(s, "track:" + await canonical(s, ref), body.model_dump(), user)
    await s.commit()
    return {"ok": True}


@router.put("/version")
async def save_version(
    body: Version, user: User = Depends(admin_user), s: AsyncSession = Depends(get_session, scope="function")
):
    if not body.ref.startswith(("file:", "nd:")) or (
        body.original_ref and not body.original_ref.startswith(("file:", "nd:"))
    ):
        raise HTTPException(422, "Подтвердите конкретный файл из поиска или библиотеки")
    if body.original_ref == body.ref:
        raise HTTPException(422, "Оригинал должен ссылаться на другую версию")
    await put_editorial(s, "version:" + body.ref, body.model_dump(exclude={"ref"}), user)
    await s.commit()
    return {"ok": True}


@router.get("/lyrics/find")
async def find_lyrics(
    artist: str = Query(min_length=1, max_length=512),
    title: str = Query(min_length=1, max_length=512),
    duration: int | None = Query(None, ge=1, le=3600),
    user: User = Depends(current_user),
):
    params = {"artist_name": artist, "track_name": title}
    if duration:
        params["duration"] = str(duration)
    try:
        async with (
            asyncio.timeout(8),
            httpx.AsyncClient(
                timeout=8, follow_redirects=False, headers={"User-Agent": "QQMusic/0.1 (self-hosted music library)"}
            ) as client,
        ):
            async with client.stream("GET", "https://lrclib.net/api/get", params=params) as result:
                if result.status_code == 404:
                    return {"found": False}
                result.raise_for_status()
                raw = bytearray()
                async for chunk in result.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > 256000:
                        raise ValueError
            import json

            data = json.loads(raw)
            if not isinstance(data, dict) or any(
                data.get(field) is not None and not isinstance(data[field], str)
                for field in ("plainLyrics", "syncedLyrics")
            ):
                raise ValueError
        return {
            "found": True,
            "plain_lyrics": str(data.get("plainLyrics") or "")[:40000],
            "synced_lyrics": str(data.get("syncedLyrics") or "")[:40000],
            "source": f"https://lrclib.net/api/get/{int(data['id'])}",
            "instrumental": bool(data.get("instrumental")),
        }
    except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError):
        raise HTTPException(502, "Сервис текстов сейчас недоступен. Можно добавить текст вручную") from None


@router.get("/profile/{kind}")
async def profile(
    kind: Literal["artist", "album"],
    response: Response,
    ref: Ref,
    user: User = Depends(current_user),
    s: AsyncSession = Depends(get_session, scope="function"),
):
    response.headers.update(PRIVATE)
    return await editorial(s, kind + ":" + ref)


@router.put("/profile/{kind}")
async def save_profile(
    kind: Literal["artist", "album"],
    body: Profile,
    ref: Ref,
    user: User = Depends(admin_user),
    s: AsyncSession = Depends(get_session, scope="function"),
):
    await put_editorial(s, kind + ":" + ref, body.model_dump(), user)
    await s.commit()
    return {"ok": True}


def cover_bytes(raw):
    with Image.open(io.BytesIO(raw)) as image:
        if image.width * image.height > 16_000_000:
            raise ValueError
        image = ImageOps.exif_transpose(image)
        image.thumbnail((512, 512))
        out = io.BytesIO()
        image.convert("RGB").save(out, "JPEG", quality=85)
        return "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode()


@router.post("/cover")
async def cover(file: UploadFile = File(), user: User = Depends(admin_user)):
    raw = await file.read(4 * 1024 * 1024 + 1)
    try:
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError
        return {"cover_url": await asyncio.to_thread(cover_bytes, raw)}
    except Exception:
        raise HTTPException(422, "Загрузите изображение до 4 MiB и 16 мегапикселей") from None


@router.get("/recap")
async def recap(
    response: Response,
    month: str = Query(pattern=r"^\d{4}-\d{2}$"),
    timezone: str = Query("UTC", max_length=80),
    user: User = Depends(current_user),
    s: AsyncSession = Depends(get_session, scope="function"),
):
    try:
        start = datetime.strptime(month, "%Y-%m").date()
        if not 1970 <= start.year <= utcnow().year + 1:
            raise ValueError
        end = start.replace(day=calendar.monthrange(start.year, start.month)[1])
        analytics.bounds(start, end, timezone)
    except (ValueError, KeyError):
        raise HTTPException(422, "Проверьте месяц и часовой пояс") from None
    now = utcnow()
    history = await launches.load(s, user.id, now)
    result = await analytics.listening(s, user, start, end, timezone, now, h=history)
    heard = {}
    counts = {}
    for attempt in history.attempts:
        if attempt.heard_at:
            heard[attempt.key] = attempt
            counts[attempt.key] = counts.get(attempt.key, 0) + 1
    forgotten = [a for key, a in heard.items() if counts[key] >= 2 and a.heard_at < now - timedelta(days=30)]
    forgotten = sorted(forgotten, key=lambda a: a.heard_at)[:12]
    resolved = await names.resolve(s, [(a.ref, a.nd_song_id) for a in forgotten])
    result["forgotten"] = [resolved[f"nd:{a.nd_song_id}" if a.nd_song_id else a.ref].out() for a in forgotten]
    response.headers.update(PRIVATE)
    return {
        key: result[key]
        for key in ("period", "totals", "by_day", "top_tracks", "top_artists", "discoveries", "forgotten")
    }
