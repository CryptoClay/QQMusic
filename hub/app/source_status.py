"""Process-lifetime source observations. No URLs, tokens or exception text are retained."""

from datetime import UTC, datetime

_states: dict[str, dict] = {}


def reason(message: str) -> str:
    text = message.lower()
    if "cookies" in text or "сессия" in text:
        return "session"
    if "not a bot" in text or "не робот" in text:
        return "login"
    if "403" in text or "forbidden" in text:
        return "forbidden"
    if "429" in text or "ограничил" in text:
        return "limited"
    if "ssl" in text or "tls" in text:
        return "tls"
    return "unavailable"


def record(name: str, kind: str, ok: bool, error: str = ""):
    state = _states.setdefault(name, {})
    state[kind] = {"ok": ok, "at": datetime.now(UTC).isoformat(), "reason": None if ok else reason(error)}
    if not ok:
        state['last_issue'] = {**state[kind], 'kind': kind}


def snapshot(name: str) -> dict:
    return dict(_states.get(name, {}))
