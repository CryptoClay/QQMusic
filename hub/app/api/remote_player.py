"""Private opt-in remote playback. Commands expire and are delivered at most once."""

from datetime import timedelta
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.community import PRIVATE
from app.api.devices import ResumeSong
from app.auth import current_user
from app.db import get_session
from app.events import bus
from app.models import PlaybackCommand, PlaybackDevice, User, utcnow

router = APIRouter(prefix="/api/player", tags=["player"])


class State(BaseModel):
    model_config = ConfigDict(extra="forbid")
    track: ResumeSong | None = None
    phase: Literal["playing", "paused", "loading", "resolving", "ended", "error"] = "paused"
    position: float = Field(default=0, ge=0, le=86400, allow_inf_nan=False)
    duration: float = Field(default=0, ge=0, le=86400, allow_inf_nan=False)
    volume: float = Field(default=1, ge=0, le=1, allow_inf_nan=False)


class Presence(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account: int
    name: str = Field(min_length=1, max_length=100)
    enabled: bool = False
    state: State


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    action: Literal["play", "pause", "next", "prev", "seek", "volume", "load"]
    value: float | None = Field(default=None, ge=0, le=86400, allow_inf_nan=False)
    queue: list[ResumeSong] = Field(default_factory=list, max_length=200)
    index: int = Field(default=0, ge=0, lt=200)
    position: float = Field(default=0, ge=0, le=86400, allow_inf_nan=False)
    expected_ref: str | None = Field(default=None, max_length=4096)

    @model_validator(mode="after")
    def valid(self):
        if self.action in ("seek", "volume") and self.value is None:
            raise ValueError("Value required")
        if self.action == "volume" and self.value > 1:
            raise ValueError("Volume must be 0..1")
        if self.action == "load" and (not self.queue or self.index >= len(self.queue)):
            raise ValueError("Select a valid queue entry")
        if self.action != "load" and self.queue:
            raise ValueError("Queue is only accepted for load")
        return self


def device_id(value):
    if not 1 <= len(value) <= 100 or not all(c.isascii() and (c.isalnum() or c in "-_") for c in value):
        raise HTTPException(422, "Некорректное устройство")
    return value


async def own_device(s, user, device):
    row = await s.get(PlaybackDevice, (user.id, device_id(device)))
    if row is None:
        raise HTTPException(404, "Устройство не найдено")
    return row


@router.get("/devices")
async def devices(
    response: Response, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")
):
    response.headers.update(PRIVATE)
    now = utcnow()
    return [
        {
            "device": d.device,
            "name": d.name,
            "enabled": d.enabled,
            "online": d.seen_at > now - timedelta(seconds=45),
            "seen_at": d.seen_at,
            "state": d.state_json,
        }
        for d in await s.scalars(
            select(PlaybackDevice)
            .where(PlaybackDevice.user_id == user.id, PlaybackDevice.seen_at > now - timedelta(days=1))
            .order_by(PlaybackDevice.seen_at.desc())
            .limit(20)
        )
    ]


@router.put("/devices/{device}")
async def presence(
    device: str,
    body: Presence,
    user: User = Depends(current_user),
    s: AsyncSession = Depends(get_session, scope="function"),
):
    device_id(device)
    if body.account != user.id:
        raise HTTPException(409, "Аккаунт изменился")
    await s.execute(update(User).where(User.id == user.id).values(last_seen_at=User.last_seen_at))
    count = await s.scalar(
        select(func.count())
        .select_from(PlaybackDevice)
        .where(PlaybackDevice.user_id == user.id, PlaybackDevice.seen_at > utcnow() - timedelta(seconds=45))
    )
    if count >= 20 and not await s.get(PlaybackDevice, (user.id, device)):
        raise HTTPException(429, "Слишком много открытых плееров")
    data = {
        "name": body.name.strip() or "Браузер",
        "enabled": body.enabled,
        "state_json": body.state.model_dump(),
        "seen_at": utcnow(),
    }
    await s.execute(
        insert(PlaybackDevice)
        .values(user_id=user.id, device=device, **data)
        .on_conflict_do_update(index_elements=["user_id", "device"], set_=data)
    )
    if not body.enabled:
        await s.execute(
            update(PlaybackCommand)
            .where(
                PlaybackCommand.user_id == user.id,
                PlaybackCommand.device == device,
                PlaybackCommand.status == "pending",
            )
            .values(status="expired", result="Управление выключено")
        )
    await s.execute(
        delete(PlaybackCommand).where(
            PlaybackCommand.user_id == user.id, PlaybackCommand.created_at < utcnow() - timedelta(days=1)
        )
    )
    await s.execute(
        delete(PlaybackDevice).where(
            PlaybackDevice.user_id == user.id, PlaybackDevice.seen_at < utcnow() - timedelta(days=1)
        )
    )
    return {"ok": True}


@router.post("/devices/{device}/commands")
async def command(
    device: str,
    body: Command,
    user: User = Depends(current_user),
    s: AsyncSession = Depends(get_session, scope="function"),
):
    await s.execute(update(User).where(User.id == user.id).values(last_seen_at=User.last_seen_at))
    target = await own_device(s, user, device)
    payload = body.model_dump(mode="json", exclude={"request_id", "action"})
    previous = await s.scalar(
        select(PlaybackCommand).where(
            PlaybackCommand.user_id == user.id, PlaybackCommand.request_id == str(body.request_id)
        )
    )
    if previous:
        if previous.device != device or previous.action != body.action or previous.payload_json != payload:
            raise HTTPException(409, "Этот запрос уже использован")
        return {"id": previous.id, "status": previous.status}
    if not target.enabled or target.seen_at < utcnow() - timedelta(seconds=45):
        raise HTTPException(409, "Устройство недоступно или управление выключено")
    if (
        body.action == "seek"
        and body.expected_ref
        and body.expected_ref != (target.state_json.get("track") or {}).get("ref")
    ):
        raise HTTPException(409, "Трек на устройстве уже сменился")
    count = await s.scalar(
        select(func.count())
        .select_from(PlaybackCommand)
        .where(PlaybackCommand.user_id == user.id, PlaybackCommand.created_at > utcnow() - timedelta(minutes=1))
    )
    if count >= 60:
        raise HTTPException(429, "Слишком много команд, подождите минуту")
    row = PlaybackCommand(
        user_id=user.id,
        device=device,
        request_id=str(body.request_id),
        action=body.action,
        payload_json=payload,
        expires_at=utcnow() + timedelta(seconds=15),
    )
    s.add(row)
    await s.flush()
    await s.commit()
    bus.publish(user.id, "player", {"device": device})
    return {"id": row.id, "status": "pending"}


@router.post("/devices/{device}/poll")
async def poll(
    device: str,
    response: Response,
    user: User = Depends(current_user),
    s: AsyncSession = Depends(get_session, scope="function"),
):
    response.headers.update(PRIVATE)
    await s.execute(update(User).where(User.id == user.id).values(last_seen_at=User.last_seen_at))
    target = await own_device(s, user, device)
    if not target.enabled or target.seen_at < utcnow() - timedelta(seconds=45):
        return {"commands": []}
    now = utcnow()
    await s.execute(
        update(PlaybackCommand)
        .where(
            PlaybackCommand.user_id == user.id,
            PlaybackCommand.device == device,
            PlaybackCommand.status == "pending",
            PlaybackCommand.expires_at <= now,
        )
        .values(status="expired")
    )
    # One claim per poll, so controls execute in their original order and never replay after reconnect.
    candidate = (
        select(PlaybackCommand.id)
        .where(
            PlaybackCommand.user_id == user.id,
            PlaybackCommand.device == device,
            PlaybackCommand.status == "pending",
            PlaybackCommand.expires_at > now,
        )
        .order_by(PlaybackCommand.id)
        .limit(1)
        .scalar_subquery()
    )
    row = await s.scalar(
        update(PlaybackCommand)
        .where(PlaybackCommand.id == candidate, PlaybackCommand.status == "pending")
        .values(status="delivered")
        .returning(PlaybackCommand)
    )
    return {
        "commands": [{"id": row.id, "action": row.action, "expires_at": row.expires_at, **row.payload_json}]
        if row
        else []
    }


class Acknowledge(BaseModel):
    status: Literal["done", "blocked", "failed"]
    result: str = Field(default="", max_length=200)


@router.put("/devices/{device}/commands/{command_id}")
async def acknowledge(
    device: str,
    command_id: int,
    body: Acknowledge,
    user: User = Depends(current_user),
    s: AsyncSession = Depends(get_session, scope="function"),
):
    await own_device(s, user, device)
    updated = await s.scalar(
        update(PlaybackCommand)
        .where(
            PlaybackCommand.id == command_id,
            PlaybackCommand.user_id == user.id,
            PlaybackCommand.device == device,
            PlaybackCommand.status == "delivered",
        )
        .values(status=body.status, result=body.result)
        .returning(PlaybackCommand.id)
    )
    if updated is None:
        raise HTTPException(404, "Команда не найдена")
    return {"ok": True}


@router.get("/commands/{command_id}")
async def command_state(
    command_id: int,
    response: Response,
    user: User = Depends(current_user),
    s: AsyncSession = Depends(get_session, scope="function"),
):
    response.headers.update(PRIVATE)
    row = await s.get(PlaybackCommand, command_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(404, "Команда не найдена")
    return {
        "status": "expired" if row.status in ("pending", "delivered") and row.expires_at < utcnow() else row.status,
        "result": row.result,
    }
