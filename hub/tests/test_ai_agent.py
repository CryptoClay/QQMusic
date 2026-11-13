"""Unit coverage for the retained assistant module and its tools, without exposing its former HTTP API."""

from __future__ import annotations

import json
import uuid

import httpx
import pytest
import respx

from tests.support import app_client

LLM = "https://llm.test/v1"


def tool_call(tool: str, **args) -> dict:
    return {"id": f"call_{tool}_{uuid.uuid4().hex[:6]}", "type": "function",
            "function": {"name": tool, "arguments": json.dumps(args, ensure_ascii=False)}}


def completion(content: str = "", calls: list[dict] | None = None) -> dict:
    msg: dict = {"role": "assistant", "content": content}
    if calls:
        msg["tool_calls"] = calls
    return {"id": "x", "object": "chat.completion", "created": 0, "model": "m",
            "choices": [{"index": 0, "finish_reason": "tool_calls" if calls else "stop", "message": msg}]}


SONGS = {"ndA": ("Кино", "Группа крови"), "ndB": ("ДДТ", "Осень"), "ndC": ("Сплин", "Выхода нет")}


@pytest.fixture
async def env(hub_env, monkeypatch):
    from app import config
    from app.main import create_app

    monkeypatch.setenv("LLM_API_KEY", "test-key")
    monkeypatch.setenv("LLM_BASE_URL", LLM)
    config.get_settings.cache_clear()
    state: dict = {"playlists": {"pl1": {"name": "Тест", "songs": ["ndA", "ndB"]}}, "stars": ["ndA", "ndB", "ndC"],
                   "deleted": [], "script": [], "llm_requests": []}

    def song(i: str) -> dict:
        return {"id": i, "artist": SONGS[i][0], "title": SONGS[i][1]}

    def nd_handler(request: httpx.Request) -> httpx.Response:
        ep = request.url.path.rsplit("/", 1)[-1]
        p = request.url.params

        def reply(**body) -> httpx.Response:
            return httpx.Response(200, json={"subsonic-response": {"status": "ok", "version": "1.16.1", **body}})

        if ep == "getUser":
            return reply(user={"adminRole": True})
        if ep == "getPlaylists":
            return reply(playlists={"playlist": [{"id": k, "name": v["name"], "songCount": len(v["songs"]),
                                                  "owner": "admin"} for k, v in state["playlists"].items()]})
        if ep == "getPlaylist":
            pl = state["playlists"][p["id"]]
            return reply(playlist={"id": p["id"], "name": pl["name"], "entry": [song(i) for i in pl["songs"]]})
        if ep == "createPlaylist":
            pid = p.get("playlistId") or f"pl{len(state['playlists']) + 1}"
            name = p.get("name") or state["playlists"][pid]["name"]
            state["playlists"][pid] = {"name": name, "songs": p.get_list("songId")}
            return reply(playlist={"id": pid, "name": name})
        if ep == "updatePlaylist":
            pl = state["playlists"][p["playlistId"]]
            for i in sorted(map(int, p.get_list("songIndexToRemove")), reverse=True):
                del pl["songs"][i]
            pl["songs"] += p.get_list("songIdToAdd")
            pl["name"] = p.get("name") or pl["name"]
            return reply()
        if ep == "deletePlaylist":
            state["deleted"].append(p["id"])
            state["playlists"].pop(p["id"])
            return reply()
        if ep in ("star", "unstar"):
            ids = p.get_list("id")
            state["stars"] = [x for x in state["stars"] if x not in ids] + (ids if ep == "star" else [])
            return reply()
        if ep == "getStarred2":
            return reply(starred2={"song": [song(i) for i in state["stars"]]})
        if ep == "getAlbumList2":
            return reply(albumList2={"album": []})
        return reply()

    def llm_handler(request: httpx.Request) -> httpx.Response:
        state["llm_requests"].append(json.loads(request.content))
        if not state["script"]:  # the model stopped answering (400: the client does not retry)
            return httpx.Response(400, json={"error": {"message": "no more"}})
        return httpx.Response(200, json=state["script"].pop(0))

    app = create_app()
    async with app.router.lifespan_context(app):
        with respx.mock(assert_all_called=False) as mock:
            mock.route(host="navidrome.test").mock(side_effect=nd_handler)
            mock.post(f"{LLM}/chat/completions").mock(side_effect=llm_handler)
            async with app_client(app) as client:
                yield {"client": client, "state": state, "yandex": await yandex_import()}


async def yandex_import() -> dict:
    """A done Yandex import whose «Мне нравится» (newest first: Осень, Группа крови) starred ndA and ndB."""
    from app.db import session_scope
    from app.matching.normalize import fingerprint
    from app.models import Import, ImportCollection, ImportItem, Track, User

    async with session_scope() as s:
        user = (await s.execute(User.__table__.select())).first()
        imp = Import(user_id=user.id, source="yandex", method="token", status="done", account="ivan",
                     options_json={"liked": ["ndA", "ndB"]})
        s.add(imp)
        await s.flush()
        likes = ImportCollection(import_id=imp.id, kind="likes", external_id="likes", title="Мне нравится")
        s.add(likes)
        await s.flush()
        for pos, nd_id in enumerate(["ndB", "ndA"]):
            artist, title = SONGS[nd_id]
            t = Track(uid=str(uuid.uuid4()), path=f"{artist}/{title}.mp3", nd_song_id=nd_id, artist=artist,
                      title=title, fingerprint=fingerprint(artist, title))
            s.add(t)
            await s.flush()
            s.add(ImportItem(import_id=imp.id, collection_id=likes.id, position=pos, external_id=str(pos),
                             raw_json={"artist": artist, "title": title}, status="done", match="exact",
                             track_id=t.id))
        return {"import_id": imp.id, "likes_id": likes.id}


async def chat(env, text: str, *script: dict) -> dict:
    from sqlalchemy import select
    from app.ai.agent import run_chat
    from app.db import session_scope
    from app.models import User

    env["state"]["script"] = list(script)
    async with session_scope() as s:
        user = (await s.execute(select(User))).scalar_one()
        result = await run_chat(s, user, [{"role": "user", "content": text}])
    assert env["state"]["script"] == [], "the model was not asked every scripted step"
    return result


@pytest.mark.parametrize("size", [5000, 5001])
def test_message_text_limit(size):
    from fastapi import HTTPException
    from app.ai.limits import validate_message_text

    text = "🎵" * size
    if size == 5000:
        validate_message_text(text)
    else:
        with pytest.raises(HTTPException) as error:
            validate_message_text(text)
        assert error.value.status_code == 400


async def test_daily_limit_and_admin_exemption(env):
    from fastapi import HTTPException
    from sqlalchemy import select
    from app.ai.limits import reserve_message
    from app.db import session_scope
    from app.models import User

    async with session_scope() as s:
        user = (await s.execute(select(User))).scalar_one()
        for _ in range(7):
            await reserve_message(s, user)
        user.is_admin = False
        await s.commit()
        for _ in range(5):
            await reserve_message(s, user)
        with pytest.raises(HTTPException) as error:
            await reserve_message(s, user)
        assert error.value.status_code == 429
        assert int(error.value.headers["Retry-After"]) > 0


def tool_results(env) -> list[dict]:
    return [json.loads(m["content"]) for m in env["state"]["llm_requests"][-1]["messages"] if m["role"] == "tool"]


async def test_moves_yandex_likes_into_a_playlist_without_asking(env):
    likes = f"import_collection:{env['yandex']['likes_id']}"
    out = await chat(
        env, "То что было добавлено импортом из яндекс музыки в понравившиеся убрать в отдельный плейлист",
        completion(calls=[tool_call("account_overview")]),
        completion(calls=[tool_call("create_playlist", name="Яндекс Музыка", songs_from=likes),
                          tool_call("unstar", songs_from=likes)]),
        completion("Готово: 2 трека в плейлисте «Яндекс Музыка», ♥ снято."),
    )
    state = env["state"]
    new = next(v for v in state["playlists"].values() if v["name"] == "Яндекс Музыка")
    assert new["songs"] == ["ndB", "ndA"]  # Yandex's order: the newest like first
    assert state["stars"] == ["ndC"]  # the user's own ♥ stays
    assert out["done"] == ["Создан плейлист «Яндекс Музыка»: 2 трека", "♥ снято: 2 трека"]
    assert out["actions"] == [] and "task_id" not in out
    overview = tool_results(env)[0]
    assert overview["starred"] == {"songs": 3, "songs_from_imports": 2, "albums": 0, "artists": 0}
    coll = overview["imports"][0]["collections"]
    assert coll["cols"][:5] == ["collection_id", "kind", "title", "selected", "items"]
    assert coll["rows"][0][:5] == [env["yandex"]["likes_id"], "likes", "Мне нравится", True, "done:2"]


async def test_starred_songs_name_the_import_that_starred_them(env):
    await chat(env, "что из яндекса?", completion(calls=[tool_call("list_starred", only="imports")]),
               completion("Два трека."))
    res = tool_results(env)[0]
    assert res["cols"] == ["song_id", "song", "album", "import_id"]
    assert [r[:2] + r[3:] for r in res["rows"]] == [["ndA", "Кино — Группа крови", env["yandex"]["import_id"]],
                                                    ["ndB", "ДДТ — Осень", env["yandex"]["import_id"]]]


async def test_removes_songs_from_a_playlist_and_renames_it(env):
    out = await chat(env, "убери Осень из Тест и назови его Рок",
                     completion(calls=[tool_call("remove_from_playlist", playlist_id="pl1", song_ids=["ndB"]),
                                       tool_call("rename_playlist", playlist_id="pl1", name="Рок")]),
                     completion("Готово."))
    assert env["state"]["playlists"]["pl1"] == {"name": "Рок", "songs": ["ndA"]}
    assert out["done"] == ["Из плейлиста «Тест» убрано 1 трек", "Плейлист «Тест» переименован в «Рок»"]


async def test_deleting_a_playlist_waits_for_confirmation(env):
    out = await chat(env, "удали плейлист Тест", completion(calls=[tool_call("delete_playlist", playlist_ids=["pl1"])]),
                     completion("Удалю после подтверждения."))
    assert env["state"]["deleted"] == []
    assert out["actions"] == [{"type": "delete_playlist", "playlist_id": "pl1", "name": "Тест"}]
    assert out["summary"] == "Удалить плейлист «Тест»"
    from fastapi import HTTPException
    from sqlalchemy import select
    from app.ai.agent import confirm_chat
    from app.db import session_scope
    from app.models import AssistantTask, User

    async with session_scope() as s:
        user = (await s.execute(select(User))).scalar_one()
        task = await s.get(AssistantTask, out["task_id"])
        with pytest.raises(HTTPException) as error:
            await confirm_chat(s, user, task, "wrong")
        assert error.value.status_code == 403
        result = await confirm_chat(s, user, task, out["confirm_token"])
    assert result == {"ok": True, "playlists_deleted": ["pl1"], "tracks_deleted": 0}
    assert env["state"]["deleted"] == ["pl1"]


@pytest.mark.parametrize("args", [{"songs_from": "everything"}, {"songs_from": "import_collection:999"}],
                         ids=["unknown-source", "foreign-collection"])
async def test_a_bad_song_set_is_an_error_for_the_model(env, args):
    out = await chat(env, "поставь ♥", completion(calls=[tool_call("star", **args)]), completion("Не вышло."))
    assert "error" in tool_results(env)[0]
    assert out["done"] == [] and env["state"]["stars"] == ["ndA", "ndB", "ndC"]


async def test_changes_made_stay_listed_when_the_model_stops_answering(env):
    out = await chat(env, "♥", completion(calls=[tool_call("star", song_ids=["ndA"])]))
    assert out["done"] == ["♥ поставлено: 1 трек"]
