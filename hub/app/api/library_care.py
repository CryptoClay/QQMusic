"""Admin library inspection and reviewed edits. A preview never writes files or rows."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import shutil
import tempfile
import time
import unicodedata
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path, PurePosixPath
from types import SimpleNamespace
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import AlbumPatchIn, TrackPatchIn
from app.auth import admin_user
from app.config import get_settings
from app.db import get_session
from app.events import bus
from app.jobs.downloads import enqueue_scan
from app.jobs.queue import notify
from app.library import editor, tagger
from app.library.importer import album_reldir, begin_library_write, library_abs, library_lock
from app.models import Album, Track, User
from app.security import decrypt, encrypt

router = APIRouter(prefix="/api/library", tags=["library"])


class EditIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["track", "tracks", "number", "cover", "album", "merge", "move"]
    id: int = Field(gt=0)
    ids: list[int] = Field(default_factory=list, max_length=500)
    fields: dict = Field(default_factory=dict)


class ApplyIn(BaseModel):
    token: str = Field(min_length=1, max_length=1500000)


def key(value: str) -> str:
    # Do not drop live/remix/clean/uncensored markers or featured artists.
    return " ".join(unicodedata.normalize("NFKC", value).casefold().replace("ё", "е").split())


def row(obj) -> dict:
    return {c.name: getattr(obj, c.name) for c in obj.__table__.columns}


def safe_path(relative) -> Path:
    root = get_settings().library_dir.resolve()
    path = library_abs(relative).resolve()
    if not path.is_relative_to(root) or path == root:
        raise HTTPException(409, "Путь файла выходит за пределы библиотеки")
    return path


def file_state(relative) -> dict:
    path = safe_path(relative)
    try:
        st = path.stat()
        return {"path": str(relative), "size": st.st_size, "mtime": st.st_mtime_ns, "present": path.is_file()}
    except FileNotFoundError:
        return {"path": str(relative), "present": False}


@router.get("/health")
async def health(offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200),
                 user: User = Depends(admin_user), s: AsyncSession = Depends(get_session, scope="function")):
    tracks = list((await s.scalars(select(Track).order_by(Track.id))).all())
    albums = list((await s.scalars(select(Album).order_by(Album.id))).all())
    def inspect():
        groups = defaultdict(list)
        issues = []
        size = 0
        for t in tracks:
            try:
                state = file_state(t.path)
            except HTTPException:
                state = {"present": False}
            size += state.get("size", 0)
            if not state["present"] or not t.nd_song_id:
                issues.append({"id": t.id, "album_id": t.album_id, "title": t.title, "artist": t.artist,
                               "missing": not state["present"], "unlinked": not t.nd_song_id})
            if key(t.artist) and key(t.title):
                groups[(key(t.artist), key(t.title), t.explicit)].append(t)
        duplicates = []
        for group in groups.values():
            # Unknown durations stay separate; avoid transitive 180~183~186 matches.
            ordered = sorted(group, key=lambda t: (t.duration_s is None, t.duration_s or 0, t.id))
            clusters: list[list[Track]] = []
            for t in ordered:
                if not clusters or ((t.duration_s is None) != (clusters[-1][0].duration_s is None)) or (
                    t.duration_s is not None and t.duration_s - clusters[-1][0].duration_s > 3
                ):
                    clusters.append([])
                clusters[-1].append(t)
            for items in clusters:
                if len(items) > 1:
                    duplicates.append({"title": items[0].title, "artist": items[0].artist,
                                       "reason": "Похожи по тегам и длительности; аудио может отличаться",
                                       "tracks": [{"id": t.id, "album_id": t.album_id, "title": t.title,
                                                   "artist": t.artist, "album": t.album, "duration_s": t.duration_s,
                                                   "codec": t.codec, "bitrate_kbps": t.bitrate_kbps,
                                                   "path": t.path, "locked": t.locked} for t in items]})
        album_groups = defaultdict(list)
        for a in albums:
            album_groups[(key(a.album_artist), key(a.title), a.year)].append(a)
        repeated_albums = [[{"id": a.id, "title": a.title, "artist": a.album_artist, "year": a.year}
                            for a in group] for group in album_groups.values() if len(group) > 1]
        return {"tracks": len(tracks), "albums": len(albums), "bytes": size,
                "missing": sum(x["missing"] for x in issues), "unlinked": sum(x["unlinked"] for x in issues),
                "duplicate_groups": len(duplicates), "duplicates": duplicates[offset:offset + limit],
                "album_groups": repeated_albums[offset:offset + limit], "album_group_count": len(repeated_albums),
                "issues": issues[offset:offset + limit], "issue_count": len(issues), "offset": offset, "limit": limit}
    return await asyncio.to_thread(inspect)


@router.get('/metadata')
async def metadata(response: Response, q: str = Query('', max_length=512), offset: int = Query(0, ge=0),
                   user: User = Depends(admin_user), s: AsyncSession = Depends(get_session, scope='function')):
    response.headers.update({'Cache-Control': 'private, no-store', 'Vary': 'Cookie'})
    tracks = list(await s.scalars(select(Track).order_by(Track.album_artist, Track.album_id, Track.disc_no, Track.track_no, Track.id)))
    albums = {a.id: a for a in await s.scalars(select(Album))}
    def inspect():
        words = q.casefold().split()
        rows, variants = [], defaultdict(list)
        for track in tracks:
            variants[key(track.artist)].append(track)
            if not all(w in f'{track.artist} {track.title} {track.album or ""}'.casefold() for w in words):
                continue
            album = albums.get(track.album_id)
            cover = bool(album and safe_path(str(album_reldir(album)) + '/cover.jpg').is_file())
            rows.append({'id': track.id, 'artist': track.artist, 'title': track.title, 'album_id': track.album_id,
                         'album': track.album, 'track_no': track.track_no, 'disc_no': track.disc_no,
                         'year': track.year, 'genre': track.genre,
                         'release_date': album.release_date if album else None, 'has_cover': cover})
        aliases = [{'names': sorted({t.artist for t in group}), 'ids': [t.id for t in group][:500], 'total': len(group)}
                   for group in variants.values() if len({t.artist for t in group}) > 1]
        return {'tracks': rows[offset:offset + 100], 'total': len(rows), 'next_offset': offset + 100 if offset + 100 < len(rows) else None,
                'variants': aliases[:30], 'missing_numbers': sum(not t['track_no'] or not t['disc_no'] for t in rows),
                'missing_years': sum(not t['year'] for t in rows), 'missing_covers': len({t['album_id'] for t in rows if not t['has_cover']})}
    return await asyncio.to_thread(inspect)


async def plan(s: AsyncSession, body: EditIn):
    if body.action in {"track", "tracks", "album"}:
        schema = AlbumPatchIn if body.action == "album" else TrackPatchIn
        unknown = set(body.fields) - set(schema.model_fields)
        if unknown:
            raise HTTPException(422, "Неизвестные поля редактирования")
        try:
            fields = schema.model_validate(body.fields).model_dump(exclude_unset=True)
        except ValueError as exc:
            raise HTTPException(422, "Проверьте значения полей") from exc
        for name in ("title", "artist", "album_artist"):
            if name in fields:
                if not isinstance(fields[name], str) or not fields[name].strip() or len(fields[name]) > 512:
                    raise HTTPException(422, "Название и исполнитель не могут быть пустыми")
                fields[name] = fields[name].strip()
        for name in ("year", "track_no", "disc_no"):
            value = fields.get(name)
            if value is not None and not 1 <= value <= 9999:
                raise HTTPException(422, "Год и номера должны быть от 1 до 9999")
        if isinstance(fields.get("genre"), str):
            fields["genre"] = fields["genre"].strip() or None
            if fields["genre"] and len(fields["genre"]) > 128:
                raise HTTPException(422, "Жанр не должен превышать 128 символов")
        if not fields:
            raise HTTPException(422, "Нет изменений")
    elif body.action == "number":
        if set(body.fields) - {"start", "disc_no"}:
            raise HTTPException(422, "Неизвестные поля нумерации")
        fields = dict(body.fields)
        if type(fields.get("start")) is not int or not 1 <= fields["start"] <= 9999:
            raise HTTPException(422, "Укажите начальный номер от 1 до 9999")
        if fields.get("disc_no") is not None and (type(fields['disc_no']) is not int or not 1 <= fields['disc_no'] <= 9999):
            raise HTTPException(422, "Номер диска от 1 до 9999")
    elif body.action == "cover":
        encoded = body.fields.get("cover_data", "")
        if set(body.fields) != {"cover_data"} or not isinstance(encoded, str) or len(encoded) > 1000000:
            raise HTTPException(422, "Выберите изображение до 750 КБ")
        try:
            image = base64.b64decode(encoded, validate=True)
            prepared = await asyncio.to_thread(tagger.prepare_cover, image)
        except (ValueError, OSError) as exc:
            raise HTTPException(422, "Не удалось прочитать обложку") from exc
        fields = {"cover": prepared}
    else:
        fields = {}
        if body.fields or not body.ids or any(i <= 0 for i in body.ids):
            raise HTTPException(422, "Выберите записи для объединения или переноса")
    albums = list((await s.scalars(select(Album).execution_options(populate_existing=True))).all())
    tracks = list((await s.scalars(select(Track).execution_options(populate_existing=True))).all())
    by_album = {a.id: a for a in albums}
    by_track = {t.id: t for t in tracks}
    if body.action in {"track", "tracks", "number"}:
        if body.id not in by_track:
            raise HTTPException(404, "Трек не найден")
        ids = list(dict.fromkeys(body.ids)) if body.action != "track" else [body.id]
        if not ids or not set(ids) <= by_track.keys() or (len(ids) != len(body.ids) and body.action != 'track'):
            raise HTTPException(422, "Выберите существующие треки без повторов")
        affected = [by_track[i] for i in ids]
        if body.action == 'number' and fields['start'] + len(ids) - 1 > 9999:
            raise HTTPException(422, "Номер трека превысит 9999")
        target = None
        album_ids = {t.album_id for t in affected} - {None}
    else:
        target = by_album.get(body.id)
        if not target:
            raise HTTPException(404, "Альбом не найден")
        if body.action == "merge":
            if body.id in body.ids or not set(body.ids) <= by_album.keys():
                raise HTTPException(422, "Проверьте выбранные альбомы")
            album_ids = {body.id, *body.ids}
            affected = [t for t in tracks if t.album_id in body.ids]
        elif body.action == "move":
            if not set(body.ids) <= by_track.keys():
                raise HTTPException(404, "Один из треков больше не существует")
            affected = [by_track[i] for i in sorted(set(body.ids))]
            album_ids = {body.id, *(t.album_id for t in affected)} - {None}
        else:
            album_ids = {body.id}
            affected = [t for t in tracks if t.album_id == body.id]
    if body.action == 'album':
        if fields.get('release_date'):
            if 'year' in fields and fields['year'] != fields['release_date'].year:
                raise HTTPException(422, 'Год не совпадает с датой релиза')
            fields['year'] = fields['release_date'].year
        elif 'year' in fields and target.release_date and fields['year'] != target.release_date.year:
            fields['release_date'] = None
    if len(affected) > 500:
        raise HTTPException(422, "Редактируйте не более 500 треков за раз")
    related = [t for t in tracks if t.album_id in album_ids or t.id in {x.id for x in affected}]
    related_albums = [a for a in albums if a.id in album_ids]
    paths = {t.path for t in related}
    directories = {str(album_reldir(a)) for a in related_albums}
    if body.action == "album":
        future = SimpleNamespace(**(row(target) | fields))
        directories.add(str(album_reldir(future)))
    for directory in directories:
        paths.add(directory + "/cover.jpg")
        parent = PurePosixPath(directory).parent
        while str(parent) != ".":
            paths.add(str(parent / "cover.jpg"))
            parent = parent.parent
    def snapshot():
        states = [file_state(p) for p in sorted(paths)]
        entries = {d: sorted(p.name for p in safe_path(d).iterdir()) if safe_path(d).is_dir() else []
                   for d in sorted(directories)}
        raw = {"tracks": [row(t) for t in related], "albums": [row(a) for a in related_albums],
               "files": states, "directories": entries}
        digest = hashlib.sha256(json.dumps(raw, sort_keys=True, default=str).encode()).hexdigest()
        return digest, states
    digest, states = await asyncio.to_thread(snapshot)
    missing = [t.path for t in affected if not next(x for x in states if x["path"] == t.path)["present"]]
    changes = []
    if body.action in {"track", "album"}:
        obj = affected[0] if body.action == "track" else target
        changes = [{"field": k, "before": getattr(obj, k), "after": v} for k, v in fields.items() if getattr(obj, k) != v]
    elif body.action in {'tracks', 'number'}:
        for index, track in enumerate(affected):
            values = fields if body.action == 'tracks' else {'track_no': fields['start'] + index,
                **({'disc_no': fields['disc_no']} if fields.get('disc_no') is not None else {})}
            changes.extend({'field': name, 'before': getattr(track, name), 'after': value,
                            'track': f'{track.artist} — {track.title}'} for name, value in values.items() if getattr(track, name) != value)
    elif body.action == 'cover':
        changes = [{'field': 'cover', 'before': 'Текущая обложка', 'after': 'Выбранное изображение'}]
    else:
        changes = [{"field": "album", "before": t.album, "after": target.title} for t in affected]
    return {"digest": digest, "fields": fields, "affected": affected, "target": target,
            "albums": related_albums, "states": states, "changes": changes, "missing": missing}


@router.post("/preview")
async def preview(body: EditIn, user: User = Depends(admin_user),
                  s: AsyncSession = Depends(get_session, scope="function")):
    async with library_lock:
        p = await plan(s, body)
    token = encrypt(json.dumps({"user": user.id, "expires": time.time() + 600,
                                "body": body.model_dump(), "digest": p["digest"]}))
    warnings = ["Изменения затрагивают общую библиотеку. Файлы и UUID треков сохраняются."]
    if body.action in {"merge", "move"}:
        warnings.append("Треки перейдут в выбранный альбом. Альбомные лайки и ссылки могут потребовать обновления.")
        warnings.append("Похожие треки останутся отдельными файлами: версии и записи в плейлистах не удаляются.")
    if body.action == "album" and any(c["field"] == "genre" for c in p["changes"]):
        warnings.append("Изменение жанра альбома применяется ко всем его трекам.")
    if p["missing"]:
        warnings.append("Некоторые файлы отсутствуют. Восстановите их перед применением изменений.")
    target = p["target"]
    return {"target_album": {"id": target.id, "title": target.title, "artist": target.album_artist} if target else None,
            "token": token, "action": body.action, "track_count": len(p["affected"]),
            "changes": p["changes"], "warnings": warnings,
            "cover_preview": 'data:image/jpeg;base64,' + base64.b64encode(p['fields']['cover']).decode() if body.action == 'cover' else None, "can_apply": not p["missing"],
            "tracks": [{"id": t.id, "title": t.title, "artist": t.artist, "path": t.path} for t in p["affected"]]}


@asynccontextmanager
async def file_backups(originals: set[Path], staging: Path):
    backup = Path(tempfile.mkdtemp(prefix="library-edit-", dir=staging))
    copies = {path: backup / str(i) for i, path in enumerate(sorted(originals))}
    try:
        manifest = [{"path": str(path.relative_to(get_settings().library_dir.resolve())), "copy": copy.name}
                    for path, copy in copies.items()]
        await asyncio.to_thread((backup / "manifest.json").write_text, json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        for source, dest in copies.items():
            await asyncio.to_thread(shutil.copy2, source, dest)
        yield copies
    except Exception:
        logging.getLogger(__name__).error("Library edit failed; retained recovery files in %s", backup)
        raise
    else:
        await asyncio.to_thread(shutil.rmtree, backup)


@router.post("/apply")
async def apply(body: ApplyIn, user: User = Depends(admin_user),
                s: AsyncSession = Depends(get_session, scope="function")):
    # Once approved, finish either the commit or the file rollback even if the
    # browser disconnects during a threaded tag write. Keep its DB session alive.
    task = asyncio.create_task(apply_review(body, user, s))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if task.done() and not task.cancelled():
            task.exception()  # retrieve a rollback failure before propagating disconnect
        raise


async def apply_review(body: ApplyIn, user: User, s: AsyncSession):
    try:
        data = json.loads(decrypt(body.token))
        operation = EditIn.model_validate(data["body"])
        if data["user"] != user.id or data["expires"] < time.time():
            raise ValueError("expired")
    except (ValueError, RuntimeError, KeyError, TypeError) as exc:
        raise HTTPException(409, "Предпросмотр истёк. Проверьте изменения заново") from exc
    await begin_library_write(s)
    async with library_lock:
        p = await plan(s, operation)
        if p["digest"] != data["digest"] or p["missing"]:
            raise HTTPException(409, "Библиотека изменилась. Откройте предпросмотр заново")
        # Keep pre-edit file copies until the database transaction commits. Roll back
        # retags/moves too if a later file fails; SQLite rollback alone is insufficient.
        names = {t.path for t in p["affected"]}
        names.update(x["path"] for x in p["states"] if x["path"].endswith("/cover.jpg"))
        saved_states = [x for x in p["states"] if x["path"] in names and x["present"]]
        originals = {safe_path(x["path"]) for x in saved_states}
        staging = get_settings().staging_dir
        staging.mkdir(parents=True, exist_ok=True)
        needed = sum(x.get("size", 0) for x in saved_states)
        if shutil.disk_usage(staging).free < needed + 16 * 1024 * 1024:
            raise HTTPException(409, "Недостаточно места для временной копии перед редактированием")
        async with file_backups(originals, staging) as copies:
            rollback_paths = None
            try:
                if operation.action == "track":
                    await editor.update_track(s, p["affected"][0], _locked=True, **p["fields"])
                elif operation.action == "album":
                    await editor.update_album(s, p["target"], _locked=True, **p["fields"])
                elif operation.action == "cover":
                    await editor.set_album_cover(s, p["target"], p['fields']['cover'], _locked=True)
                elif operation.action in {'tracks', 'number'}:
                    for index, track in enumerate(p['affected']):
                        fields = p['fields'] if operation.action == 'tracks' else {'track_no': p['fields']['start'] + index,
                            **({'disc_no': p['fields']['disc_no']} if p['fields'].get('disc_no') is not None else {})}
                        await editor.update_track(s, track, _locked=True, **fields)
                elif operation.action == "merge":
                    await editor.merge_albums(s, operation.ids, p["target"], _locked=True)
                else:
                    await editor.move_tracks(s, operation.ids, p["target"], _locked=True)
                rollback_paths = {safe_path(t.path) for t in p["affected"]}
                rollback_paths.update(safe_path(str(album_reldir(a)) + "/cover.jpg") for a in p["albums"])
                await enqueue_scan(s)
                await s.commit()
            except Exception:
                created = rollback_paths
                if created is None:
                    created = {safe_path(t.path) for t in p["affected"]}
                    created.update(safe_path(str(album_reldir(a)) + "/cover.jpg") for a in p["albums"])
                for path in created - originals:
                    if path.is_file():
                        await asyncio.to_thread(path.unlink)
                for original, copy in copies.items():
                    original.parent.mkdir(parents=True, exist_ok=True)
                    await asyncio.to_thread(shutil.copy2, copy, original)
                raise
    notify()
    bus.publish(user.id, "library", {"kind": "changed"})
    return {"ok": True, "album_id": p["target"].id if p["target"] else p["affected"][0].album_id}
