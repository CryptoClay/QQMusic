"""Full recovery round-trip, WAL capture, secret decryption and archive tampering."""

import importlib.util
import io
import json
import sqlite3
import tarfile
from pathlib import Path

import pytest
from cryptography.exceptions import InvalidTag
from cryptography.fernet import Fernet


@pytest.fixture
def recovery():
    script = Path(__file__).resolve().parents[2] / "scripts/recovery.py"
    if not script.is_file():
        pytest.skip("Mount full repository to test recovery tool")
    spec = importlib.util.spec_from_file_location("qqmusic_recovery", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_full_recovery_with_wal_and_encrypted_connections(tmp_path, recovery):
    secret = Fernet.generate_key()
    cipher = Fernet(secret)
    hub = tmp_path / "hub"
    nd = tmp_path / "nd"
    music = tmp_path / "music"
    settings = tmp_path / "settings"
    for path in (hub, nd, music / "library", settings):
        path.mkdir(parents=True)
    (music / "library/song.mp3").write_bytes(b"media" * 10000)
    (music / ".youtube-cookies.txt").write_text("private test cookies")
    (settings / ".env").write_text("HUB_SECRET_KEY=" + secret.decode())
    (settings / "config.yaml").write_text("sources: {}")
    (settings / "navidrome.toml").write_text('LogLevel="info"')
    with sqlite3.connect(hub / "hub.sqlite3") as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE users (nd_password_enc TEXT)")
        db.execute("INSERT INTO users VALUES (?)", (cipher.encrypt(b"user password").decode(),))
        db.execute("CREATE TABLE nextcloud_connections (password_enc TEXT)")
        db.execute("INSERT INTO nextcloud_connections VALUES (?)", (cipher.encrypt(b"cloud password").decode(),))
        db.execute("CREATE TABLE share_links (token_enc TEXT)")
        db.execute("INSERT INTO share_links VALUES (?)", (cipher.encrypt(b"test-only-share-token").decode(),))
        db.execute("CREATE TABLE nextcloud_playlists (items_json TEXT)")
        db.execute(
            "INSERT INTO nextcloud_playlists VALUES (?)",
            (json.dumps([{"url_enc": cipher.encrypt(b"https://cloud.test/private").decode()}]),),
        )
        db.commit()
        with sqlite3.connect(nd / "navidrome.db") as nav:
            nav.execute("CREATE TABLE media_file (id TEXT)")
        archive = tmp_path / "backup.qqm"
        recovery.backup(
            hub,
            nd,
            music,
            settings / ".env",
            settings / "config.yaml",
            settings / "navidrome.toml",
            archive,
            "long backup passphrase",
        )
    assert b"private test cookies" not in archive.read_bytes()
    result = recovery.restore(archive, tmp_path / "restored", "long backup passphrase")
    assert result["library_files"] == 1 and result["decrypted_secrets"] == 4
    assert (tmp_path / "restored/music/library/song.mp3").read_bytes() == b"media" * 10000
    with pytest.raises(ValueError):
        recovery.restore(archive, tmp_path / "restored", "long backup passphrase")
    with pytest.raises(InvalidTag):
        recovery.restore(archive, tmp_path / "wrong", "different long password")
    assert not (tmp_path / "wrong").exists()
    damaged = bytearray(archive.read_bytes())
    damaged[80] ^= 1
    archive.write_bytes(damaged)
    with pytest.raises(InvalidTag):
        recovery.restore(archive, tmp_path / "damaged", "long backup passphrase")
    assert not (tmp_path / "damaged").exists()
    (tmp_path / "restored/music/library/song.mp3").write_bytes(b"broken")
    with pytest.raises(ValueError):
        recovery.verify(tmp_path / "restored")


@pytest.mark.parametrize("name", ["../escape", "/absolute", "folder\\escape"])
def test_recovery_rejects_archive_traversal(tmp_path, recovery, name):
    raw = tmp_path / "unsafe.tar"
    with tarfile.open(raw, "w") as tar:
        item = tarfile.TarInfo(name)
        item.size = 1
        tar.addfile(item, io.BytesIO(b"x"))
    archive = tmp_path / "unsafe.qqm"
    recovery.crypt(raw, archive, "long backup passphrase")
    with pytest.raises(ValueError):
        recovery.restore(archive, tmp_path / "restored", "long backup passphrase")
    assert not (tmp_path / "restored").exists()
