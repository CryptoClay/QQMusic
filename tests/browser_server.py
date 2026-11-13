"""Disposable acceptance server. Fake Navidrome only; real Hub, SQLite, migrations and audio. Never loads .env."""

# Environment must be set before importing the application.
# ruff: noqa: E402
import argparse
import asyncio
import atexit
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import respx
import uvicorn
from cryptography.fernet import Fernet

test_root = tempfile.TemporaryDirectory(prefix="qqmusic-browser-")
atexit.register(test_root.cleanup)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hub"))
root = Path(test_root.name)
music = root / "music"
data = root / "data"
static = root / "static"
web_build = Path(__file__).resolve().parents[1] / "hub/app/static"
if not (web_build / "index.html").is_file():
    raise RuntimeError("Build the web before starting acceptance server")
shutil.copytree(web_build, static)
os.environ.update(
    STATIC_DIR=str(static),
    PUBLIC_MODE="false",
    PUBLIC_HUB_URL="",
    PUBLIC_MUSIC_URL="",
    SMTP_HOST="",
    GOOGLE_CLIENT_ID="",
    MUSIC_ROOT=str(music),
    DATA_DIR=str(data),
    CONFIG_FILE=str(root / "absent.yaml"),
    HUB_SECRET_KEY=Fernet.generate_key().decode(),
    NAVIDROME_URL="http://navidrome.demo",
    NAVIDROME_ADMIN_USER="admin",
    NAVIDROME_ADMIN_PASSWORD="test",
    DISABLE_BACKGROUND="true",
    LOG_LEVEL="ERROR",
)
from app.db import session_scope
from app.library.importer import album_reldir, library_abs
from app.library.tagger import TagData, write_tags
from app.main import create_app
from app.models import (
    Album,
    CommunityPlaylist,
    InboxMessage,
    MusicRequest,
    Track,
    User,
    UserPolicy,
    VersionGroup,
    VersionMember,
)
from app.security import encrypt

app = create_app()
original = app.router.lifespan_context
songs = []


@asynccontextmanager
async def lifespan(application):
    async with original(application):
        async with session_scope() as s:
            for username, admin in [
                ("admin", True),
                ("listener", False),
                ("editor", False),
            ]:
                s.add(
                    User(
                        nd_username=username,
                        nd_password_enc=encrypt("test"),
                        is_admin=admin,
                    )
                )
            a = Album(
                uid=str(uuid.uuid4()),
                title="После полуночи",
                album_artist="Далёкие берега",
                year=2026,
            )
            s.add(a)
            await s.flush()
            template = root / "silence.mp3"
            await asyncio.to_thread(
                subprocess.run,
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=44100:cl=stereo",
                    "-t",
                    "200",
                    "-q:a",
                    "9",
                    str(template),
                ],
                check=True,
            )
            for i, title in enumerate(
                ["Северный свет", "Останься до утра", "Тише города"], 1
            ):
                p = library_abs(album_reldir(a)) / f"{i}.mp3"
                p.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(template, p)
                uid = str(uuid.uuid4())
                write_tags(
                    p,
                    TagData(
                        title=title,
                        artist="Далёкие берега",
                        album=a.title,
                        track_uid=uid,
                        album_uid=a.uid,
                    ),
                )
                t = Track(
                    uid=uid,
                    album_id=a.id,
                    path=p.relative_to(music / "library").as_posix(),
                    nd_song_id=f"nd{i}",
                    artist="Далёкие берега",
                    title=title,
                    album=a.title,
                    album_artist="Далёкие берега",
                    fingerprint="group|" + title,
                    duration_s=200,
                    codec="mp3",
                    size_bytes=p.stat().st_size,
                    added_by=2,
                )
                s.add(t)
                songs.append(
                    {
                        "id": f"nd{i}",
                        "title": title,
                        "artist": "Далёкие берега",
                        "album": a.title,
                        "duration": 200,
                        "path": t.path,
                    }
                )
            from PIL import Image, ImageDraw

            image = Image.new("RGB", (600, 600))
            pixels = image.load()
            for yy in range(600):
                for xx in range(600):
                    glow = max(
                        0, 1 - (((xx - 350) / 420) ** 2 + ((yy - 245) / 360) ** 2)
                    )
                    pixels[xx, yy] = (
                        int(12 + glow * 35),
                        int(28 + glow * 95),
                        int(36 + glow * 90),
                    )
            draw = ImageDraw.Draw(image)
            draw.ellipse((130, 100, 470, 440), fill=(224, 167, 104))
            draw.rectangle((0, 350, 600, 600), fill=(13, 29, 36))
            for yy in range(352, 490, 12):
                draw.line((50, yy, 550, yy), fill=(36, 65, 67), width=3)
            draw.text((44, 45), "AFTER MIDNIGHT", fill=(229, 232, 222))
            draw.text((44, 535), "DISTANT SHORES  /  2026", fill=(198, 207, 199))
            image.save(library_abs(album_reldir(a)) / "cover.jpg", quality=92)
            from app.models import MusicEditorial

            s.add(
                MusicEditorial(
                    key="lyrics:nd:nd1",
                    data_json={
                        "plain_lyrics": "Город засыпает в тишине\nСеверный свет горит в окне\nМы остаёмся здесь до утра\nДальше дорога, дальше ветра"
                    },
                )
            )
            await s.flush()
            g = VersionGroup(name="Песня: разные версии")
            s.add(g)
            await s.flush()
            s.add_all(
                [
                    VersionMember(track_id=1, group_id=g.id, kind="original"),
                    VersionMember(track_id=2, group_id=g.id, kind="clean"),
                ]
            )
            s.add(
                CommunityPlaylist(
                    owner_id=1,
                    name="Музыка вместе",
                    members_json={"2": "listener", "3": "editor"},
                    items_json=[
                        {
                            "ref": "nd:nd1",
                            "title": "Песня",
                            "artist": "Далёкие берега",
                            "duration_s": 10,
                        }
                    ],
                )
            )
            s.add(
                MusicRequest(user_id=2, artist="Далёкие берега", title="Новый альбом")
            )
            s.add(
                InboxMessage(
                    user_id=2,
                    text="Вас пригласили в совместный плейлист",
                    target="/community-playlist/1",
                )
            )
            s.add(
                UserPolicy(
                    user_id=2, max_queue=5, storage_mb=100, upload_mb=10, parallel=1
                )
            )
        yield


app.router.lifespan_context = lifespan


def nd(request):
    p = request.url.params
    user = p.get("u", "admin")
    salt = p.get("s", "")
    valid = hashlib.md5(("test" + salt).encode()).hexdigest() == p.get("t")
    if not valid or user not in ("admin", "listener", "editor"):
        return httpx.Response(
            200,
            json={
                "subsonic-response": {
                    "status": "failed",
                    "error": {"code": 40, "message": "wrong password"},
                }
            },
        )
    ep = request.url.path.rsplit("/", 1)[-1]
    body = {"status": "ok", "version": "1.16.1"}
    if ep == "getUser":
        body["user"] = {"username": user, "adminRole": user == "admin"}
    elif ep == "getPlaylists":
        body["playlists"] = {
            "playlist": [
                {
                    "id": str(i),
                    "name": "Ночной маршрут " + str(i),
                    "songCount": 90,
                    "duration": 18000,
                }
                for i in range(1, 17)
            ]
        }
    elif ep == "getPlaylist":
        body["playlist"] = {
            "id": p.get("id"),
            "name": "Ночной маршрут " + p.get("id", "1"),
            "songCount": 90,
            "duration": 18000,
            "entry": songs * 30,
        }
    elif ep == "getStarred2":
        body["starred2"] = {"song": [], "album": [], "artist": []}
    elif ep == "getArtists":
        body["artists"] = {"index": []}
    elif ep == "getAlbumList2":
        body["albumList2"] = {
            "album": [
                {
                    "id": "album1",
                    "name": "После полуночи",
                    "artist": "Далёкие берега",
                    "coverArt": "album1",
                    "songCount": 3,
                    "duration": 600,
                    "year": 2026,
                }
            ]
        }
    elif ep == "getCoverArt":
        return httpx.Response(
            200,
            content=next((music / "library").rglob("cover.jpg")).read_bytes(),
            headers={"content-type": "image/jpeg"},
        )
    elif ep == "search3":
        body["searchResult3"] = {"song": songs}
    elif ep == "getSong":
        body["song"] = next((s for s in songs if s["id"] == p.get("id")), songs[0])
    return httpx.Response(200, json={"subsonic-response": body})


with respx.mock(assert_all_called=False, assert_all_mocked=True) as mock:
    mock.route(host="navidrome.demo").mock(side_effect=nd)
    mock.route().mock(
        return_value=httpx.Response(
            503, json={"error": "External network disabled in fixture"}
        )
    )
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18082)
    args = parser.parse_args()
    uvicorn.run(
        app, host="0.0.0.0", port=args.port, log_level="error", access_log=False
    )
