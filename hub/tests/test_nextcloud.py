from pathlib import Path

import httpx
import pytest

from app.providers.base import Candidate, ProviderError, TrackQuery
from app.providers.nextcloud import NextcloudProvider

ROOT = 'https://cloud.example/remote.php/dav/files/alice/Music/'


def response(entries):
    rows = ''.join(f'<d:response><d:href>{href}</d:href><d:propstat><d:prop><d:resourcetype>{"<d:collection/>" if is_dir else ""}</d:resourcetype><d:getcontentlength>{size}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' for href, is_dir, size in entries)
    return f'<d:multistatus xmlns:d="DAV:">{rows}</d:multistatus>'


@pytest.mark.asyncio
async def test_search_and_fetch_read_only(tmp_path: Path):
    calls = []
    def handle(req):
        calls.append(req)
        assert req.headers['authorization'].startswith('Basic ')
        if req.method == 'PROPFIND':
            assert req.headers['depth'] == '1'
            return httpx.Response(207, text=response([('/remote.php/dav/files/alice/Music/', True, ''), ('/remote.php/dav/files/alice/Music/Artist%20-%20Song.mp3', False, '5')]))
        return httpx.Response(200, content=b'abcde')
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        p = NextcloudProvider(ROOT, 'alice', 'private-token', client=client)
        found = await p.search(TrackQuery(artist='Artist', title='Song'))
        assert len(found) == 1
        assert found[0].artist == 'Artist' and found[0].title == 'Song'
        assert 'private-token' not in found[0].model_dump_json() and ROOT not in found[0].model_dump_json()
        progress = []
        file = await p.fetch(found[0], tmp_path, on_progress=progress.append)
        assert file.read_bytes() == b'abcde' and progress[-1] == 1
        assert [x.method for x in calls] == ['PROPFIND', 'GET']
        await p.aclose()
        assert not client.is_closed


@pytest.mark.parametrize('url', ['http://cloud.example/dav/', 'https://user:pass@cloud.example/dav/', 'https://cloud.example/dav/?token=secret', 'https://cloud.example/dav/%2e%2e/other'])
def test_invalid_configuration(url):
    with pytest.raises(ValueError):
        NextcloudProvider(url, 'a', 'b')


@pytest.mark.asyncio
async def test_reject_host_escape_redirect_and_untrusted_candidates(tmp_path):
    def handle(req):
        return httpx.Response(207, text=response([
            ('https://evil.example/a/Artist%20-%20Song.mp3', False, '3'),
            ('/remote.php/dav/files/alice/Other/Artist%20-%20Song.mp3', False, '3'),
            ('/remote.php/dav/files/alice/Music/%252e%252e/Artist%20-%20Song.mp3', False, '3'),
            ('/remote.php/dav/files/alice/Music/Artist%20-%20Song.mp3', False, '3'),
        ])) if req.method == 'PROPFIND' else httpx.Response(302, headers={'Location': 'https://evil.example/'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle), follow_redirects=True) as client:
        p = NextcloudProvider(ROOT, 'a', 'secret', client=client)
        found = await p.search(TrackQuery(artist='Artist', title='Song'))
        assert len(found) == 1
        with pytest.raises(ProviderError):
            await p.fetch(found[0], tmp_path)
        assert not list(tmp_path.iterdir())
        with pytest.raises(ProviderError):
            await p.fetch(Candidate(provider='nextcloud', provider_id='forged', artist='', title='', page_url='https://evil.example'), tmp_path)


@pytest.mark.asyncio
async def test_file_limit_and_recursion(tmp_path):
    seen = []
    def handle(req):
        seen.append(req.url.path)
        if req.method == 'GET':
            return httpx.Response(200, content=b'123456')
        return httpx.Response(207, text=response([
            (str(req.url), True, ''),
            ('/remote.php/dav/files/alice/Music/sub/', True, ''),
            ('/remote.php/dav/files/alice/Music/Artist%20-%20Song.mp3', False, ''),
        ]))
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        p = NextcloudProvider(ROOT, 'a', 'b', client=client, max_depth=0, max_file_bytes=5)
        found = await p.search(TrackQuery(artist='Artist', title='Song'))
        assert len(found) == 1 and len(seen) == 1
        with pytest.raises(ProviderError):
            await p.fetch(found[0], tmp_path)
        assert not list(tmp_path.iterdir())


async def test_settings_build_webdav_subpath_and_encode_names():
    from app.config import Settings

    settings = Settings(nextcloud_url='https://cloud.example/nextcloud/', nextcloud_user='alice@example.com',
                        nextcloud_password='private-token', nextcloud_folder='Музыка/Рок')
    assert 'private-token' not in repr(settings)
    async with httpx.AsyncClient() as client:
        p = NextcloudProvider.from_settings(settings, client=client)
        assert p._base == ('https://cloud.example/nextcloud/remote.php/dav/files/alice%40example.com/'
                           '%D0%9C%D1%83%D0%B7%D1%8B%D0%BA%D0%B0/%D0%A0%D0%BE%D0%BA/')


@pytest.mark.parametrize('folder', ['../Other', 'Music/../../Other', 'Music\\Other'])
def test_settings_reject_folder_escape(folder):
    from app.config import Settings

    with pytest.raises(ValueError):
        NextcloudProvider.from_settings(Settings(nextcloud_url='https://cloud.example', nextcloud_user='a',
                                                nextcloud_password='secret', nextcloud_folder=folder))


@pytest.mark.parametrize('xml', ['<!DOCTYPE x [<!ENTITY x "expanded">]><x>&x;</x>', '<broken'])
async def test_invalid_xml_is_rejected(xml):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(207, text=xml))) as client:
        p = NextcloudProvider(ROOT, 'a', 'b', client=client)
        with pytest.raises(ProviderError):
            await p.search(TrackQuery(artist='Artist', title='Song'))
