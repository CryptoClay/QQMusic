"""Read-only WebDAV source for a single, operator-configured Nextcloud account.

The provider is deliberately not registered automatically. Give each user a separate instance:
credentials and private filenames must never be shared between users through a global provider cache.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import re
import tempfile
from collections import deque
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit
from xml.etree import ElementTree as ET

import httpx

from app.providers.base import Candidate, ProviderError, StreamSource, TrackQuery

_DAV = '{DAV:}'
_AUDIO = {'.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wav'}
_MAX_XML = 2 * 1024 * 1024


class NextcloudProvider:
    """Bounded PROPFIND traversal and authenticated GET; no remote writes or redirects.

    base_url is the full WebDAV collection URL, e.g. https://cloud.example/remote.php/dav/files/user/Music/.
    HTTPS is required by default. Credentials are scoped to this instance and never exposed in Candidate.
    Candidate ids are opaque and valid only for the lifetime of this instance.
    """
    name = 'nextcloud'
    # The shared listening pipeline follows redirects and cannot enforce our byte limit; predownload via fetch instead.
    streams = False

    def __init__(self, base_url: str, username: str, password: str, *, client: httpx.AsyncClient | None = None,
                 allow_http: bool = False, max_depth: int = 4, max_entries: int = 2000,
                 max_file_bytes: int = 500 * 1024 * 1024) -> None:
        p = urlsplit(base_url)
        if (p.scheme not in ({'http', 'https'} if allow_http else {'https'}) or not p.hostname or p.username is not None
                or p.password is not None or p.query or p.fragment or not username or not password):
            raise ValueError('Invalid Nextcloud configuration')
        if not (0 <= max_depth <= 10 and 1 <= max_entries <= 10000 and 1 <= max_file_bytes <= 2 * 1024**3):
            raise ValueError('Invalid Nextcloud limits')
        try:
            port = p.port
        except ValueError:
            raise ValueError('Invalid Nextcloud configuration') from None
        self._origin = (p.scheme.lower(), p.hostname.lower(), port or (443 if p.scheme == 'https' else 80))
        root = self._clean_path(p.path or '/')
        self._root = root.rstrip('/') + '/'
        self._base = urlunsplit((p.scheme, p.netloc, self._root, '', ''))
        self._auth = httpx.BasicAuth(username, password)
        self._client = client or httpx.AsyncClient(timeout=30, follow_redirects=False)
        self._owns_client = client is None
        self._max_depth, self._max_entries, self._max_file_bytes = max_depth, max_entries, max_file_bytes
        self._items: dict[str, str] = {}

    @classmethod
    def from_settings(cls, settings, **kwargs) -> NextcloudProvider:
        """Build a standalone connection. This does not register it in the shared service."""
        base = urlsplit(settings.nextcloud_url)
        if (base.scheme != 'https' or not base.hostname or base.username is not None
                or base.password is not None or base.query or base.fragment
                or not settings.nextcloud_user or not settings.nextcloud_password):
            raise ValueError('Set NEXTCLOUD_URL, NEXTCLOUD_USER and NEXTCLOUD_PASSWORD')
        folder = settings.nextcloud_folder.strip('/')
        if any(x in ('.', '..') or '\\' in x or any(ord(c) < 32 for c in x) for x in folder.split('/')):
            raise ValueError('Invalid NEXTCLOUD_FOLDER')
        path = base.path.rstrip('/') + '/remote.php/dav/files/' + quote(settings.nextcloud_user, safe='') + '/'
        if folder:
            path += '/'.join(quote(x, safe='') for x in folder.split('/')) + '/'
        return cls(urlunsplit((base.scheme, base.netloc, path, '', '')),
                   settings.nextcloud_user, settings.nextcloud_password, **kwargs)

    @staticmethod
    def _clean_path(path: str) -> str:
        # Decode each segment exactly once; reject encoded separators, traversal and double encoding.
        parts = path.split('/')
        decoded = [unquote(x, errors='strict') for x in parts]
        if any(x in ('.', '..') or '/' in x or '\\' in x or '%' in x or any(ord(c) < 32 for c in x) for x in decoded):
            raise ValueError('Unsafe WebDAV path')
        return '/'.join(quote(x, safe='') for x in decoded)

    def _resolve(self, href: str, current: str) -> str:
        if not href or '\\' in href or any(ord(c) < 32 for c in href):
            raise ValueError('Unsafe WebDAV href')
        p = urlsplit(urljoin(current, href))
        try:
            origin = (p.scheme.lower(), (p.hostname or '').lower(), p.port or (443 if p.scheme == 'https' else 80))
        except ValueError:
            raise ValueError('Unsafe WebDAV href') from None
        if origin != self._origin or p.username is not None or p.password is not None or p.query or p.fragment:
            raise ValueError('Unsafe WebDAV href')
        path = self._clean_path(p.path)
        if path != self._root.rstrip('/') and not path.startswith(self._root):
            raise ValueError('WebDAV href outside configured collection')
        return urlunsplit((p.scheme, p.netloc, path, '', ''))

    async def _list(self, url: str) -> list[tuple[str, bool, int | None]]:
        try:
            async with self._client.stream('PROPFIND', url, auth=self._auth, follow_redirects=False,
                                           headers={'Depth': '1', 'Content-Type': 'application/xml'},
                                           content=b'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>') as response:
                if response.status_code != 207:
                    raise ProviderError('Nextcloud directory unavailable')
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > _MAX_XML:
                        raise ProviderError('Nextcloud response too large')
            xml = raw.decode('utf-8-sig')
            if re.search(r'<!\s*(DOCTYPE|ENTITY)', xml, re.I):
                raise ProviderError('Invalid Nextcloud response')
            root = ET.fromstring(xml)
            if root.tag != _DAV + 'multistatus':
                raise ProviderError('Invalid Nextcloud response')
            out = []
            for entry in root.findall(_DAV + 'response'):
                if len(out) >= self._max_entries:
                    raise ProviderError('Nextcloud entry limit exceeded')
                href = entry.findtext(_DAV + 'href')
                prop = next((x.find(_DAV + 'prop') for x in entry.findall(_DAV + 'propstat')
                             if re.search(r'\s200(?:\s|$)', x.findtext(_DAV + 'status') or '')), None)
                if not href or prop is None:
                    continue
                try:
                    target = self._resolve(href, url)
                except ValueError:
                    continue
                typ = prop.find(_DAV + 'resourcetype')
                collection = typ is not None and typ.find(_DAV + 'collection') is not None
                length = prop.findtext(_DAV + 'getcontentlength')
                size = int(length) if length and length.isdigit() else None
                out.append((target, collection, size))
            return out
        except ProviderError:
            raise
        except (httpx.HTTPError, ET.ParseError, ValueError):
            raise ProviderError('Nextcloud directory unavailable') from None

    async def search(self, q: TrackQuery, limit: int = 10) -> list[Candidate]:
        try:
            async with asyncio.timeout(5.0):
                return await self._search(q, limit)
        except TimeoutError:
            raise ProviderError('Nextcloud search timed out') from None

    async def _search(self, q: TrackQuery, limit: int) -> list[Candidate]:
        if limit <= 0:
            return []
        words = [s.strip().casefold() for s in (q.artist, q.title) if s.strip()]
        if not words:
            return []
        queue = deque([(self._base, 0)])
        seen: set[str] = set()
        result: list[Candidate] = []
        inspected = 0
        while queue and len(result) < min(limit, 100):
            url, depth = queue.popleft()
            if url in seen:
                continue
            seen.add(url)
            for target, is_dir, size in await self._list(url):
                inspected += 1
                if inspected > self._max_entries:
                    return result
                if len(seen) + len(queue) >= self._max_entries:
                    return result
                if target.rstrip('/') == url.rstrip('/'):
                    continue
                if is_dir:
                    target = target.rstrip('/') + '/'
                    if depth < self._max_depth and target not in seen and target not in (x[0] for x in queue):
                        queue.append((target, depth + 1))
                    continue
                filename = unquote(urlsplit(target).path.rsplit('/', 1)[-1])
                stem, ext = os.path.splitext(filename)
                if ext.lower() not in _AUDIO or (size is not None and size > self._max_file_bytes):
                    continue
                if not all(word in stem.casefold() for word in words):
                    continue
                artist, sep, title = stem.partition(' - ')
                if not sep:
                    artist, title = q.artist, stem
                key = hashlib.sha256(target.encode()).hexdigest()
                if key not in self._items and len(self._items) >= self._max_entries:
                    self._items.pop(next(iter(self._items)))
                self._items[key] = target
                result.append(Candidate(provider=self.name, provider_id=key, artist=artist, title=title,
                                        page_url='nextcloud:' + key))
                if len(result) >= min(limit, 100):
                    return result
        return result

    async def enrich(self, c: Candidate) -> Candidate:
        self._candidate_url(c)
        return c.model_copy(update={'enriched': True})

    def _candidate_url(self, c: Candidate) -> str:
        if c.provider != self.name or c.provider_id not in self._items:
            raise ProviderError('Nextcloud file is unavailable; search again')
        return self._resolve(self._items[c.provider_id], self._base)

    async def fetch(self, c: Candidate, dest_dir: Path, on_progress=None) -> Path:
        url = self._candidate_url(c)
        suffix = Path(unquote(urlsplit(url).path)).suffix.lower()
        if suffix not in _AUDIO:
            raise ProviderError('Unsupported Nextcloud file')
        await asyncio.to_thread(dest_dir.mkdir, parents=True, exist_ok=True)
        fd, path = tempfile.mkstemp(prefix='nextcloud-', suffix=suffix, dir=dest_dir)
        target = Path(path)
        try:
            with os.fdopen(fd, 'wb') as out:
                async with self._client.stream('GET', url, auth=self._auth, follow_redirects=False) as response:
                    if response.status_code != 200:
                        raise ProviderError('Nextcloud file unavailable')
                    length = response.headers.get('content-length', '')
                    total = int(length) if length.isdigit() else None
                    if total is not None and total > self._max_file_bytes:
                        raise ProviderError('Nextcloud file exceeds size limit')
                    size = 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > self._max_file_bytes:
                            raise ProviderError('Nextcloud file exceeds size limit')
                        out.write(chunk)
                        if on_progress and total:
                            on_progress(min(1.0, size / total))
            return target
        except BaseException as exc:
            await asyncio.to_thread(target.unlink, missing_ok=True)
            if not isinstance(exc, Exception) or isinstance(exc, ProviderError):
                raise
            raise ProviderError('Nextcloud file unavailable') from None

    async def stream(self, c: Candidate) -> StreamSource:
        raise ProviderError('Nextcloud files must be downloaded before playback')

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()


async def _check(query: str, limit: int, dest: Path | None) -> None:
    from app.config import get_settings

    provider = NextcloudProvider.from_settings(get_settings())
    try:
        artist, sep, title = query.partition(' - ')
        found = await provider.search(TrackQuery(artist=artist.strip(), title=title.strip() if sep else ''), limit)
        print(f'Найдено файлов: {len(found)}')
        for candidate in found:
            print(f'{candidate.artist} — {candidate.title}')
            if dest is not None:
                path = await provider.fetch(candidate, dest)
                print(f'Сохранено: {path.name}')
    finally:
        await provider.aclose()


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser(description='Проверка личной папки Nextcloud без подключения к общему каталогу')
    parser.add_argument('query', help='Исполнитель - Трек или часть имени файла')
    parser.add_argument('--limit', type=int, default=5, choices=range(1, 101), metavar='1..100')
    parser.add_argument('--dest', type=Path, help='Необязательно: скачать найденные файлы в локальную папку')
    args = parser.parse_args()
    try:
        asyncio.run(_check(args.query, args.limit, args.dest))
    except (ValueError, ProviderError) as error:
        parser.exit(1, f'{error}\n')
