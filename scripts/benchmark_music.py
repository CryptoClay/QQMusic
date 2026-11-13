"""Isolated multi-user queue/import/API exercise. Never opens the configured production database.

Run from a Hub environment: PYTHONPATH=hub python scripts/benchmark_music.py --users 6 --tracks 8 --workers 8
Uses generated silent WAV files, private temporary folders and ASGI requests; no external music is downloaded.
"""

import argparse
import asyncio
import json
import os
import statistics
import tempfile
import time
import wave
from collections import Counter
from datetime import timedelta
from pathlib import Path


async def exercise(args, root):
    from cryptography.fernet import Fernet

    os.environ.update(
        DATA_DIR=str(root / "data"),
        MUSIC_ROOT=str(root / "music"),
        CONFIG_FILE=str(root / "absent.yaml"),
        HUB_SECRET_KEY=Fernet.generate_key().decode(),
        DISABLE_BACKGROUND="true",
        EMBEDDER_URL="",
        NAVIDROME_URL="http://benchmark.invalid",
        NAVIDROME_ADMIN_USER="benchmark",
        NAVIDROME_ADMIN_PASSWORD="unused",
        SMTP_HOST="",
        LLM_API_KEY="",
        LOG_LEVEL="ERROR",
    )
    import httpx
    from sqlalchemy import func, select

    from app.config import get_settings
    from app.db import dispose, session_scope
    from app.jobs import queue
    from app.library.importer import ImportSpec, import_file
    from app.main import create_app
    from app.models import DownloadBatch, DownloadControl, DownloadItem, Job, Session, Track, User, UserPolicy, utcnow
    from app.security import encrypt, new_token

    app = create_app()
    get_settings().cfg.jobs.workers = args.workers
    active, peaks, claimed, latencies, failures = Counter(), Counter(), Counter(), [], []
    tokens = []
    async with app.router.lifespan_context(app):
        async with session_scope() as s:
            for uid in range(1, args.users + 1):
                s.add(User(id=uid, nd_username=f"bench-{uid}", nd_password_enc=encrypt("unused"), is_admin=uid == 1))
                await s.flush()
                token, digest = new_token()
                tokens.append(token)
                s.add(Session(id=digest, user_id=uid, expires_at=utcnow() + timedelta(hours=1)))
                s.add(UserPolicy(user_id=uid, parallel=1, max_queue=args.tracks * 2, storage_mb=100, upload_mb=1))
                batch = DownloadBatch(user_id=uid, origin="manual")
                s.add(batch)
                await s.flush()
                for number in range(args.tracks):
                    item = DownloadItem(
                        user_id=uid,
                        batch_id=batch.id,
                        query_json={"query": {"artist": f"Artist {uid}", "title": f"Track {number}"}},
                    )
                    s.add(item)
                    await s.flush()
                    await queue.enqueue(s, "download_item", {"item_id": item.id})
            s.add(DownloadControl(user_id=args.users, paused=True))

        async def download(job):
            iid = job.payload_json["item_id"]
            claimed[iid] += 1
            async with session_scope() as s:
                item = await s.get(DownloadItem, iid)
                uid = item.user_id
                item.status = "downloading"
            active[uid] += 1
            peaks[uid] = max(peaks[uid], active[uid])
            try:
                await asyncio.sleep(0.015)
                path = root / f"{iid}.wav"
                with wave.open(str(path), "wb") as audio:
                    audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
                    audio.writeframes(b"\0\0" * 2000)
                async with session_scope() as s:
                    track = await import_file(
                        s,
                        path,
                        ImportSpec(
                            artist=f"Artist {uid}",
                            title=f"Track {iid}",
                            album=f"Album {uid}",
                            album_artist=f"Artist {uid}",
                            added_by=uid,
                            codec="wav",
                            duration_s=1,
                        ),
                    )
                    item = await s.get(DownloadItem, iid)
                    item.track_id = track.id
                    item.status = "done"
                    item.progress = 1
            finally:
                active[uid] -= 1

        queue._handlers["download_item"] = download
        done = 0
        stop = asyncio.Event()

        async def worker(number):
            nonlocal done
            while not stop.is_set():
                job = await queue._claim(f"benchmark-{number}")
                if not job:
                    await asyncio.sleep(0.005)
                    continue
                await queue.run_job(job)
                done += 1
                if done >= args.users * args.tracks:
                    stop.set()

        clients = [
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://benchmark.test",
                cookies={"qqmusic_session": token},
            )
            for token in tokens
        ]

        async def api_load(uid):
            client = clients[uid - 1]
            for iteration in range(args.requests):
                started = time.perf_counter()
                response = await client.get("/api/downloads/control")
                latencies.append((time.perf_counter() - started) * 1000)
                if response.status_code != 200:
                    failures.append(f"control:{response.status_code}")
                    continue
                own = response.json()["items"]
                async with session_scope() as s:
                    foreign = set(await s.scalars(select(DownloadItem.id).where(DownloadItem.user_id != uid)))
                if set(map(int, own)) & foreign:
                    failures.append("account leak")
                if iteration == 0:
                    response = await client.put(
                        "/api/music/personal", params={"ref": "dz:1"}, json={"note": f"private-{uid}"}
                    )
                    if response.status_code != 200:
                        failures.append("note write")
                notes = await client.get("/api/music/notes")
                if notes.status_code != 200 or any(n["note"] != f"private-{uid}" for n in notes.json()):
                    failures.append("private note leak")
                await asyncio.sleep(0.005)

        started = time.perf_counter()
        tasks = [asyncio.create_task(worker(i)) for i in range(args.workers)]
        loads = [asyncio.create_task(api_load(uid)) for uid in range(1, args.users + 1)]
        try:
            await asyncio.sleep(0.1)
            if active[args.users] or any(uid == args.users for uid in peaks):
                failures.append("paused queue started")
            response = await clients[-1].put("/api/downloads/control", json={"paused": False})
            if response.status_code != 200:
                failures.append("resume failed")
            await asyncio.wait_for(asyncio.gather(*tasks, *loads), timeout=90)
        finally:
            stop.set()
            for task in [*tasks, *loads]:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, *loads, return_exceptions=True)
            for client in clients:
                await client.aclose()
        elapsed = time.perf_counter() - started
        async with session_scope() as s:
            tracks = await s.scalar(select(func.count()).select_from(Track))
            jobs = Counter((await s.scalars(select(Job.status))).all())
            paths = list(await s.scalars(select(Track.path)))
        if tracks != args.users * args.tracks or jobs.get("failed", 0):
            failures.append("incomplete imports")
        if max(peaks.values(), default=0) > 1:
            failures.append("parallel budget exceeded")
        if max(claimed.values(), default=0) > 1:
            failures.append("job claimed twice")
        if not all((root / "music" / "library" / path).is_file() for path in paths):
            failures.append("missing imported file")
        ordered = sorted(latencies)
        result = {
            "users": args.users,
            "tracks": tracks,
            "workers": args.workers,
            "measured_queue_reads": len(latencies),
            "total_api_requests": len(latencies) * 2 + args.users + 1,
            "elapsed_s": round(elapsed, 3),
            "imports_per_s": round(tracks / elapsed, 2),
            "api_median_ms": round(statistics.median(ordered), 2),
            "api_p95_ms": round(ordered[int((len(ordered) - 1) * 0.95)], 2),
            "max_parallel_per_user": max(peaks.values(), default=0),
            "duplicate_claims": sum(max(0, n - 1) for n in claimed.values()),
            "jobs": dict(jobs),
            "failures": failures,
            "isolated": True,
        }
    await dispose()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--users", type=int, default=6)
    parser.add_argument("--tracks", type=int, default=8)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--requests", type=int, default=20)
    args = parser.parse_args()
    if not all(1 <= n <= 100 for n in (args.users, args.tracks, args.workers, args.requests)):
        parser.error("All workload sizes must be between 1 and 100")
    with tempfile.TemporaryDirectory(prefix="qqmusic-benchmark-") as directory:
        result = asyncio.run(exercise(args, Path(directory)))
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(bool(result["failures"]))


if __name__ == "__main__":
    main()
