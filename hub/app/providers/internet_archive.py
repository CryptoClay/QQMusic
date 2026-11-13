"""Public Internet Archive audio files, searched via advancedsearch and item metadata.

Only unrestricted audio items and downloadable, non-private full files are returned. Availability and
rights information comes from Archive metadata; callers must independently assess reuse rights.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import re
from pathlib import Path
from urllib.parse import quote

import httpx
from rapidfuzz.fuzz import WRatio

from app.matching.normalize import normalize_title
from app.net import RateLimiter, make_client, request_with_backoff
from app.providers.base import Candidate, ProviderError, StreamSource, TrackQuery
from app.providers.hitmoz import download_audio

BASE = "https://archive.org"
MAX_ITEMS = 8
MAX_RESULTS = 30
FORMATS = {".mp3": "audio/mpeg", ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".m4a": "audio/mp4"}


def _truth(value: object) -> bool:
    if isinstance(value, list):
        return any(_truth(entry) for entry in value)
    return str(value or "").strip().lower() in {"1", "true", "yes"}


def _text(value: object) -> str:
    if isinstance(value, list):
        value = value[0] if value else ""
    return str(value or "").strip()


def _duration(value: object) -> int | None:
    try:
        parts = str(value).split(":")
        total = 0.0
        for part in parts:
            total = total * 60 + float(part)
        return int(total) if 0 < total < 86400 else None
    except (ValueError, TypeError, OverflowError):
        return None


def _file_url(identifier: str, filename: str) -> str:
    return f"{BASE}/download/{quote(identifier, safe='')}/{quote(filename, safe='/')}"


def _candidate(identifier: str, metadata: dict, f: dict) -> Candidate | None:
    name = _text(f.get("name"))
    ext = Path(name).suffix.lower()
    if not name or ext not in FORMATS or _truth(f.get("private")) or _truth(f.get("restricted")):
        return None
    if any(part in ("", ".", "..") for part in name.split("/")) or "\\" in name or any(ord(c) < 32 for c in name):
        return None
    # Archive's samples, derivatives such as spectrograms, and explicit no-download entries are not full songs.
    if _truth(f.get("sample")) or _truth(f.get("no_download")) or "sample" in _text(f.get("format")).lower():
        return None
    artist = _text(f.get("creator")) or _text(metadata.get("creator"))
    title = _text(f.get("title"))
    if not title:
        title = Path(name).stem
        if " - " in title:
            file_artist, title = title.split(" - ", 1)
            artist = file_artist.strip() or artist
    if not artist or not title.strip():
        return None
    token = base64.urlsafe_b64encode((identifier + "\0" + name).encode()).decode().rstrip("=")
    bitrate = _text(f.get("bitrate"))
    try:
        kbps = int(float(bitrate) / (1000 if float(bitrate) > 1000 else 1)) if bitrate else None
    except (ValueError, OverflowError):
        kbps = None
    return Candidate(provider="internet_archive", provider_id=token, artist=artist, title=title.strip(),
                     duration_s=_duration(f.get("length")), bitrate_kbps=kbps,
                     album=_text(f.get("album")) or None, page_url=f"{BASE}/details/{quote(identifier, safe='')}",
                     download_url=_file_url(identifier, name), enriched=True,
                     extra={"identifier": identifier, "filename": name, "media_type": FORMATS[ext]})


class InternetArchiveProvider:
    name = "internet_archive"
    streams = True

    def __init__(self, cfg=None, client: httpx.AsyncClient | None = None):
        self.client = client or make_client()
        self._own_client = client is None
        self.limiter = RateLimiter(getattr(cfg, "rate_per_sec", 1.0))
        self.download_sem = asyncio.Semaphore(max(1, min(4, getattr(cfg, "max_parallel_downloads", 2))))

    async def _json(self, url: str, *, params: dict | None = None) -> dict:
        try:
            async with asyncio.timeout(2.0):
                response = await request_with_backoff(self.client, "GET", url, params=params, limiter=self.limiter,
                                                      retries=0)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError("expected object")
            return data
        except (httpx.HTTPError, ValueError, TimeoutError) as e:
            raise ProviderError(f"Internet Archive: {e}") from e

    async def search(self, q: TrackQuery, limit: int = 10) -> list[Candidate]:
        out: list[Candidate] = []
        try:
            # Leave time for ranking before the listening pipeline's 6 s deadline.
            async with asyncio.timeout(5.0):
                await self._search(q, limit, out)
        except TimeoutError:
            pass  # preserve candidates from earlier items
        return out

    async def _search(self, q: TrackQuery, limit: int, out: list[Candidate]) -> None:
        limit = max(0, min(limit, MAX_RESULTS))
        if not limit or not (q.artist.strip() or q.title.strip()):
            return
        # Escape Lucene syntax; the Files tab sends its entire query in artist with an empty title.
        def literal(value: str) -> str:
            return re.sub(r'([+\-&|!(){}\[\]^"~*?:\\/])', r'\\\1', value.strip())
        terms = [f"({literal(value)})" for value in (q.artist, q.title) if value.strip()]
        query = "mediatype:audio AND " + " AND ".join(terms)
        data = await self._json(f"{BASE}/advancedsearch.php", params={"q": query, "fl[]": "identifier",
                                "rows": min(MAX_ITEMS, limit), "page": 1, "output": "json"})
        response = data.get("response")
        docs = response.get("docs", []) if isinstance(response, dict) else []
        seen: set[str] = set()
        for doc in docs[:MAX_ITEMS] if isinstance(docs, list) else []:
            ident = _text(doc.get("identifier")) if isinstance(doc, dict) else ""
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", ident) or ident in seen:
                continue
            seen.add(ident)
            try:
                item = await self._json(f"{BASE}/metadata/{quote(ident, safe='')}")
            except ProviderError:
                continue
            meta = item.get("metadata") or {}
            if not isinstance(meta, dict) or _text(meta.get("mediatype")) != "audio":
                continue
            if any(_truth(item.get(k)) or _truth(meta.get(k)) for k in ("private", "restricted", "noindex", "access-restricted-item", "is_dark", "nodownload", "no_download")):
                continue
            files = item.get("files") or []
            if not isinstance(files, list):
                continue
            candidates = [c for f in files if isinstance(f, dict) and (c := _candidate(ident, meta, f))]
            # A collection can contain an entire concert/album. Find the requested song before
            # applying the small listening limit, rather than returning only its first tracks.
            needle = normalize_title(q.title or q.artist).latin
            candidates.sort(key=lambda c: WRatio(needle, normalize_title(
                c.title if q.title else f"{c.artist} {c.title}").latin), reverse=True)
            out.extend(candidates[:limit - len(out)])
            if len(out) >= limit:
                return

    async def enrich(self, c: Candidate) -> Candidate:
        return c.model_copy(update={"enriched": True})

    def _url(self, c: Candidate) -> tuple[str, str]:
        if c.provider != self.name:
            raise ProviderError("Internet Archive: неверный источник")
        ident, filename = c.extra.get("identifier"), c.extra.get("filename")
        if not isinstance(ident, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", ident):
            raise ProviderError("Internet Archive: неверный идентификатор")
        if (not isinstance(filename, str) or not filename or "\\" in filename
                or any(p in ("", ".", "..") for p in filename.split("/")) or any(ord(c) < 32 for c in filename)):
            raise ProviderError("Internet Archive: неверное имя файла")
        ext = Path(filename).suffix.lower()
        if ext not in FORMATS:
            raise ProviderError("Internet Archive: неподдерживаемый формат")
        return _file_url(ident, filename), FORMATS[ext]

    async def stream(self, c: Candidate) -> StreamSource:
        url, media_type = self._url(c)
        await self.limiter.wait()
        return StreamSource(url=url, client=self.client, media_type=media_type)

    async def fetch(self, c: Candidate, dest_dir: Path, on_progress=None) -> Path:
        url, _ = self._url(c)
        ext = Path(c.extra["filename"]).suffix.lower()
        name = hashlib.sha256(c.provider_id.encode()).hexdigest()[:24]
        async with self.download_sem:
            return await download_audio(self.client, url, Path(dest_dir) / f"internet_archive_{name}{ext}",
                                        limiter=self.limiter, retries=1, label="Internet Archive", on_progress=on_progress)

    async def aclose(self) -> None:
        if self._own_client:
            await self.client.aclose()
