"""Internet Archive provider: public files only, bounded search and safe URLs."""
import httpx
import pytest

from app.providers.base import ProviderError, TrackQuery
from app.providers.internet_archive import InternetArchiveProvider


@pytest.fixture
def archive():
    calls = []

    def handle(request):
        calls.append(request)
        if request.url.path == "/advancedsearch.php":
            return httpx.Response(200, json={"response": {"docs": [{"identifier": "item-1"}, {"identifier": "private"}]}})
        if request.url.path == "/metadata/private":
            return httpx.Response(200, json={"metadata": {"mediatype": "audio", "private": "true"}, "files": []})
        if request.url.path == "/metadata/item-1":
            return httpx.Response(200, json={"metadata": {"mediatype": "audio", "creator": "Artist"}, "files": [
                {"name": "folder/Artist - Song #1.mp3", "length": "3:21", "bitrate": "192000"},
                {"name": "secret.mp3", "private": "true"}, {"name": "../escape.mp3"},
                {"name": "sample.mp3", "sample": "true"}, {"name": "picture.jpg"},
            ]})
        if request.url.path.startswith("/download/"):
            return httpx.Response(200, content=b"x" * 120000, headers={"content-type": "audio/mpeg"})
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    provider = InternetArchiveProvider(client=client)
    provider.limiter.interval = 0
    return provider, calls, client


async def test_search_public_audio_and_encode_urls(archive):
    provider, calls, client = archive
    try:
        result = await provider.search(TrackQuery(artist='Artist "x"', title='Song: *'), 10)
        assert len(result) == 1
        c = result[0]
        assert c.artist == "Artist" and c.title == "Song #1" and c.duration_s == 201 and c.bitrate_kbps == 192
        assert c.download_url == "https://archive.org/download/item-1/folder/Artist%20-%20Song%20%231.mp3"
        assert len(calls) == 3
        assert '\\"' in calls[0].url.params["q"] and '\\*' in calls[0].url.params["q"]
        stream = await provider.stream(c)
        assert stream.url == c.download_url and stream.media_type == "audio/mpeg"
    finally:
        await client.aclose()


async def test_download_and_reject_tampered_file(archive, tmp_path):
    provider, _, client = archive
    try:
        c = (await provider.search(TrackQuery(artist="Artist", title="Song")))[0]
        path = await provider.fetch(c, tmp_path)
        assert path.read_bytes() == b"x" * 120000 and path.suffix == ".mp3"
        bad = c.model_copy(update={"extra": {"identifier": "item-1", "filename": "../secret.mp3"}})
        with pytest.raises(ProviderError):
            await provider.stream(bad)
    finally:
        await client.aclose()


async def test_search_limit_and_provider_error(archive):
    provider, calls, client = archive
    try:
        assert await provider.search(TrackQuery(artist="", title="")) == []
        assert calls == []
        result = await provider.search(TrackQuery(artist="Artist Song", title=""), 1)
        assert len(result) == 1 and len(calls) == 2
        assert "(Artist Song)" in calls[0].url.params["q"]
    finally:
        await client.aclose()


async def test_failed_item_does_not_hide_other_items(archive, monkeypatch):
    provider, _, client = archive
    original = provider._json

    async def fake_json(url, **kwargs):
        if url.endswith("advancedsearch.php"):
            return {"response": {"docs": [{"identifier": "bad"}, {"identifier": "item-1"}]}}
        if url.endswith("/bad"):
            raise ProviderError("item unavailable")
        return await original(url, **kwargs)

    monkeypatch.setattr(provider, "_json", fake_json)
    try:
        result = await provider.search(TrackQuery(artist="Artist Song", title=""))
        assert len(result) == 1 and result[0].title == "Song #1"
    finally:
        await client.aclose()


async def test_timeout_keeps_candidates_from_previous_items(archive, monkeypatch):
    provider, _, client = archive
    original = provider._json

    async def fake_json(url, **kwargs):
        if url.endswith("advancedsearch.php"):
            return {"response": {"docs": [{"identifier": "item-1"}, {"identifier": "slow"}]}}
        if url.endswith("/slow"):
            raise TimeoutError()
        return await original(url, **kwargs)

    monkeypatch.setattr(provider, "_json", fake_json)
    try:
        result = await provider.search(TrackQuery(artist="Artist Song", title=""))
        assert len(result) == 1 and result[0].title == "Song #1"
    finally:
        await client.aclose()


@pytest.mark.parametrize('flag', ['is_dark', 'nodownload', 'no_download', 'access-restricted-item'])
async def test_unavailable_collections_are_not_offered(flag):
    def handle(request):
        if request.url.path == '/advancedsearch.php':
            return httpx.Response(200, json={'response': {'docs': [{'identifier': 'item'}]}})
        return httpx.Response(200, json={'metadata': {'mediatype': 'audio', 'creator': 'Artist', flag: ['true']},
                                         'files': [{'name': 'Song.mp3'}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        provider = InternetArchiveProvider(client=client)
        provider.limiter.interval = 0
        assert await provider.search(TrackQuery(artist='Artist', title='Song')) == []


@pytest.mark.parametrize('payload', [{}, {'response': None}, {'response': []}, {'response': {'docs': None}}])
async def test_malformed_search_response(payload):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload))) as client:
        provider = InternetArchiveProvider(client=client)
        assert await provider.search(TrackQuery(artist='Artist', title='Song')) == []


async def test_track_at_end_of_album_is_ranked_before_result_limit():
    def handle(request):
        if request.url.path == '/advancedsearch.php':
            return httpx.Response(200, json={'response': {'docs': [{'identifier': 'album'}]}})
        return httpx.Response(200, json={'metadata': {'mediatype': 'audio', 'creator': 'Artist'},
            'files': [{'name': f'{i}.mp3', 'title': f'Other track {i}'} for i in range(20)]
                     + [{'name': 'last.mp3', 'title': 'Wanted song'}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        provider = InternetArchiveProvider(client=client)
        provider.limiter.interval = 0
        [found] = await provider.search(TrackQuery(artist='Artist', title='Wanted song'), limit=1)
        assert found.title == 'Wanted song'
