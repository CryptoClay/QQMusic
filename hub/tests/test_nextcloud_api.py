"""Personal WebDAV credentials, owner-bound files, revocation and ranged playback."""

import json
import time

import httpx
import pytest
import respx
from fastapi import HTTPException, Request

from app.auth import current_user
from app.db import session_scope
from app.models import NextcloudConnection, User
from app.security import decrypt, encrypt
from tests.test_nextcloud import response

CONFIG = {'server_url': 'https://cloud.example', 'username': 'alice', 'password': 'private-app-password', 'folder': 'Music'}
DAV = '/remote.php/dav/files/alice/Music/'


@pytest.fixture
async def cloud(hub_env):
    from app.main import create_app

    app = create_app()
    users = {1: User(id=1, nd_username='admin', nd_password_enc=encrypt('p'), is_admin=True),
             2: User(id=2, nd_username='other', nd_password_enc=encrypt('p'), is_admin=False)}

    async def identity(request: Request):
        uid = request.headers.get('x-test-user', '')
        if uid not in ('1', '2'):
            raise HTTPException(401, 'Sign in')
        return users[int(uid)]

    app.dependency_overrides[current_user] = identity
    async with app.router.lifespan_context(app):
        async with session_scope() as s:
            s.add_all(users.values())
            await s.commit()
        with respx.mock(assert_all_called=False) as mock:
            mock.route(method='PROPFIND', host='cloud.example').respond(207, text=response([
                (DAV, True, ''), (DAV + 'Artist%20-%20Song.mp3', False, '10'),
            ]))

            def audio(request):
                start, end = (0, 9)
                if value := request.headers.get('range'):
                    a, b = value.removeprefix('bytes=').split('-')
                    start, end = int(a), int(b) if b else 9
                return httpx.Response(206 if 'range' in request.headers else 200,
                    headers={'Content-Type': 'audio/mpeg', 'Content-Length': str(end - start + 1),
                             'Content-Range': f'bytes {start}-{end}/10', 'Accept-Ranges': 'bytes'},
                    stream=httpx.ByteStream(b'0123456789'[start:end + 1]))

            mock.route(method='GET', host='cloud.example').mock(side_effect=audio)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://hub.test',
                                         headers={'x-test-user': '1'}) as client:
                yield client, mock


async def setup(client):
    result = await client.put('/api/nextcloud/connection', json=CONFIG)
    assert result.status_code == 200, result.text
    found = await client.get('/api/nextcloud/files', params={'q': 'Artist - Song'})
    assert found.status_code == 200, found.text
    return found.json()['files'][0]['id']


async def test_credentials_encrypted_and_connection_private(cloud):
    client, _ = cloud
    token = await setup(client)
    result = await client.get('/api/nextcloud/connection')
    assert result.json()['has_password'] and 'no-store' in result.headers['cache-control']
    assert CONFIG['password'] not in result.text and 'password_enc' not in result.text
    assert 'cloud.example' not in token and 'Song' not in token
    async with session_scope() as s:
        saved = await s.get(NextcloudConnection, 1)
        assert saved.password_enc != CONFIG['password'] and decrypt(saved.password_enc) == CONFIG['password']
    assert (await client.post('/api/nextcloud/test')).status_code == 200
    # Empty password retains it only for the same server and username.
    assert (await client.put('/api/nextcloud/connection', json={**CONFIG, 'password': ''})).status_code == 200
    assert (await client.put('/api/nextcloud/connection', json={**CONFIG, 'username': 'bob', 'password': ''})).status_code == 422


async def test_owner_only_audio_and_download_with_range(cloud):
    client, mock = cloud
    token = await setup(client)
    played = await client.get('/api/nextcloud/audio', params={'file': token}, headers={'Range': 'bytes=2-5'})
    assert played.status_code == 206 and played.content == b'2345'
    assert played.headers['content-range'] == 'bytes 2-5/10' and 'no-store' in played.headers['cache-control']
    downloaded = await client.get('/api/nextcloud/audio', params={'file': token, 'download': 1})
    assert downloaded.content == b'0123456789' and 'attachment;' in downloaded.headers['content-disposition']
    before = len(mock.calls)
    assert (await client.get('/api/nextcloud/connection', headers={'x-test-user': '2'})).json()['connected'] is False
    assert (await client.put('/api/nextcloud/connection', headers={'x-test-user': '2'},
                             json={**CONFIG, 'username': 'bob'})).status_code == 200
    denied = await client.get('/api/nextcloud/audio', params={'file': token}, headers={'x-test-user': '2'})
    assert denied.status_code == 404 and len(mock.calls) == before


async def test_ordinary_user_cannot_proxy_arbitrary_server(cloud):
    client, mock = cloud
    result = await client.put('/api/nextcloud/connection', headers={'x-test-user': '2'}, json=CONFIG)
    assert result.status_code == 403 and not mock.calls
    await client.put('/api/nextcloud/connection', json=CONFIG)
    result = await client.put('/api/nextcloud/connection', headers={'x-test-user': '2'},
                              json={**CONFIG, 'server_url': 'https://other.example'})
    assert result.status_code == 403 and not mock.calls


async def test_disconnect_and_configuration_change_revoke_file_tokens(cloud):
    client, _ = cloud
    token = await setup(client)
    await client.put('/api/nextcloud/connection', json={**CONFIG, 'folder': 'Other', 'password': ''})
    assert (await client.get('/api/nextcloud/audio', params={'file': token})).status_code == 404
    await client.delete('/api/nextcloud/connection')
    assert (await client.get('/api/nextcloud/audio', params={'file': token})).status_code == 404
    async with session_scope() as s:
        assert await s.get(NextcloudConnection, 1) is None


async def test_bad_expired_and_foreign_path_tokens_never_reach_upstream(cloud):
    client, mock = cloud
    token = await setup(client)
    data = json.loads(decrypt(token))
    before = len(mock.calls)
    for value in ['forged', 'некорректно', encrypt(json.dumps({**data, 'expires': time.time() - 1})),
                  encrypt(json.dumps({**data, 'url': 'https://evil.example/secret.mp3'}))]:
        assert (await client.get('/api/nextcloud/audio', params={'file': value})).status_code == 404
    assert len(mock.calls) == before


@pytest.mark.parametrize('kind', ['redirect', 'oversized', 'html', 'auth'])
async def test_unusable_audio_is_rejected_without_leaking_credentials(cloud, kind):
    client, mock = cloud
    token = await setup(client)
    replies = {
        'redirect': httpx.Response(302, headers={'Location': 'https://evil.example/'}),
        'oversized': httpx.Response(206, headers={'Content-Range': 'bytes 0-9/999999999', 'Content-Type': 'audio/mpeg'}),
        'html': httpx.Response(200, text='<html>sign in</html>', headers={'Content-Type': 'text/html'}),
        'auth': httpx.Response(401),
    }
    mock.route(method='GET', host='cloud.example').mock(return_value=replies[kind])
    result = await client.get('/api/nextcloud/audio', params={'file': token})
    assert result.status_code == (413 if kind == 'oversized' else 502)
    assert CONFIG['password'] not in result.text
    assert not any(call.request.url.host == 'evil.example' for call in mock.calls)


@pytest.mark.parametrize('range_value', ['bytes=0-1,3-4', 'bytes=999999999-1000000000', 'bytes=9-2'])
async def test_invalid_ranges_and_anonymous_requests(cloud, range_value):
    client, mock = cloud
    token = await setup(client)
    before = len(mock.calls)
    result = await client.get('/api/nextcloud/audio', params={'file': token}, headers={'Range': range_value})
    assert result.status_code == 416 and len(mock.calls) == before
    result = await client.get('/api/nextcloud/connection', headers={'x-test-user': ''})
    assert result.status_code == 401
