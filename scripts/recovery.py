"""Encrypted, verified QQMusic recovery archive. Run with the Hub's Python environment.

No services are stopped. SQLite backup() includes committed WAL transactions; media
should be idle during capture (a changing file aborts capture). See docs/recovery.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MAGIC = b"QQMREC01"
CHUNK = 1024 * 1024


def key(password: str, salt: bytes) -> bytes:
    if len(password) < 16:
        raise ValueError("Use a backup passphrase of at least 16 characters")
    return Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(password.encode())


def crypt(source: Path, target: Path, password: str, *, decrypt: bool = False):
    with source.open("rb") as src, target.open("xb") as dst:
        os.chmod(target, 0o600)
        if decrypt:
            header = src.read(36)
            if len(header) != 36 or header[:8] != MAGIC:
                raise ValueError("Invalid recovery archive")
            src.seek(-16, 2)
            tag = src.read(16)
            end = src.tell() - 16
            src.seek(36)
            ctx = Cipher(algorithms.AES(key(password, header[8:24])), modes.GCM(header[24:], tag)).decryptor()
        else:
            header = MAGIC + os.urandom(16) + os.urandom(12)
            dst.write(header)
            ctx = Cipher(algorithms.AES(key(password, header[8:24])), modes.GCM(header[24:])).encryptor()
            end = source.stat().st_size
        ctx.authenticate_additional_data(header)
        while src.tell() < end:
            dst.write(ctx.update(src.read(min(CHUNK, end - src.tell()))))
        dst.write(ctx.finalize())
        if not decrypt:
            dst.write(ctx.tag)


def digest(path: Path) -> str:
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def snapshot(source: Path, target: Path):
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink() or not source.is_file():
        raise ValueError("Missing or symlinked recovery source")
    with sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True) as src, sqlite3.connect(target) as dst:
        src.backup(dst)


def backup(
    hub_data: Path,
    navidrome_data: Path,
    music_root: Path,
    env_file: Path,
    config: Path,
    nd_config: Path,
    output: Path,
    password: str,
) -> dict:
    if output.exists():
        raise ValueError("Output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="qqmusic-recovery-") as temp:
        root = Path(temp)
        stage = root / "files"
        stage.mkdir(mode=0o700)
        snapshot(hub_data / "hub.sqlite3", stage / "hub/hub.sqlite3")
        snapshot(navidrome_data / "navidrome.db", stage / "navidrome/navidrome.db")
        entries = {}
        with tarfile.open(root / "archive.tar", "w") as tar:

            def add(source, name):
                if source.is_symlink() or not source.is_file():
                    raise ValueError("Symlinks are not supported in recovery archives")
                before = source.stat()
                checksum = digest(source)
                tar.add(source, arcname=name, recursive=False)
                after = source.stat()
                if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    raise ValueError("Source changed during backup; retry while uploads are idle")
                entries[name] = {"sha256": checksum, "bytes": before.st_size}

            for path in stage.rglob("*"):
                if path.is_file():
                    add(path, path.relative_to(stage).as_posix())
            for source, name in [
                (env_file, "settings/.env"),
                (config, "settings/config.yaml"),
                (nd_config, "settings/navidrome.toml"),
            ]:
                add(source, name)
            library = music_root / "library"
            if not library.is_dir():
                raise ValueError("Library directory missing")
            for path in sorted(library.rglob("*")):
                if path.is_symlink():
                    raise ValueError("Library contains symlinks")
                if path.is_file():
                    add(path, "music/" + path.relative_to(music_root).as_posix())
            cookies = music_root / ".youtube-cookies.txt"
            if cookies.exists():
                add(cookies, "music/.youtube-cookies.txt")
            manifest = stage / "manifest.json"
            manifest.write_text(json.dumps({"version": 1, "files": entries}, ensure_ascii=False), encoding="utf-8")
            tar.add(manifest, arcname="manifest.json")
        # Exclusive final creation; errors never leave a usable-looking partial archive.
        partial = output.with_name(output.name + ".partial")
        try:
            crypt(root / "archive.tar", partial, password)
            os.link(partial, output)
        finally:
            partial.unlink(missing_ok=True)
    return {
        "files": len(entries),
        "bytes": sum(item["bytes"] for item in entries.values()),
        "archive_bytes": output.stat().st_size,
    }


def restore(archive: Path, destination: Path, password: str) -> dict:
    if destination.exists():
        raise ValueError("Restore destination must not exist")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="qqmusic-restore-", dir=destination.parent) as temp:
        root = Path(temp)
        # Authenticate the ENTIRE archive before extracting anything.
        crypt(archive, root / "archive.tar", password, decrypt=True)
        stage = root / "restored"
        stage.mkdir(mode=0o700)
        with tarfile.open(root / "archive.tar", "r") as tar:
            seen = set()
            for member in tar:
                path = PurePosixPath(member.name)
                if (
                    not member.isfile()
                    or path.is_absolute()
                    or ".." in path.parts
                    or "\\" in member.name
                    or member.name in seen
                    or not path.parts
                ):
                    raise ValueError("Unsafe archive entry")
                seen.add(member.name)
                tar.extract(member, stage, filter="data")
        result = verify(stage)
        # Directory rename is unreliable across Docker Desktop bind mounts on Windows.
        # Claim the destination exclusively and copy only the already verified files.
        destination.mkdir(mode=0o700)
        try:
            for source in stage.rglob("*"):
                target = destination / source.relative_to(stage)
                if source.is_dir():
                    target.mkdir(mode=0o700, exist_ok=True)
                else:
                    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    with source.open("rb") as src, target.open("xb") as dst:
                        os.chmod(target, 0o600)
                        shutil.copyfileobj(src, dst, CHUNK)
        except BaseException:
            shutil.rmtree(destination)
            raise
        return result


def verify(destination: Path) -> dict:
    manifest = json.loads((destination / "manifest.json").read_text(encoding="utf-8"))
    if manifest["version"] != 1:
        raise ValueError("Unsupported manifest")
    entries = manifest["files"]
    actual = {p.relative_to(destination).as_posix() for p in destination.rglob("*") if p.is_file()} - {"manifest.json"}
    if actual != set(entries):
        raise ValueError("Manifest file list mismatch")
    for name, info in entries.items():
        path = destination / name
        if path.is_symlink() or path.stat().st_size != info["bytes"] or digest(path) != info["sha256"]:
            raise ValueError("Recovery file checksum mismatch")
    databases = {}
    for name, relative in [("hub", "hub/hub.sqlite3"), ("navidrome", "navidrome/navidrome.db")]:
        with sqlite3.connect((destination / relative).resolve().as_uri() + "?mode=ro", uri=True) as db:
            if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise ValueError("SQLite integrity check failed")
            databases[name] = len(db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall())
    # Load key without logging configuration or decrypted credentials.
    from dotenv import dotenv_values

    values = dotenv_values(destination / "settings/.env")
    cipher = Fernet(values["HUB_SECRET_KEY"].encode())
    decrypted = 0
    with sqlite3.connect(destination / "hub/hub.sqlite3") as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table, column in [("users", "nd_password_enc"), ("nextcloud_connections", "password_enc")]:
            if table in tables:
                for (value,) in db.execute(f"SELECT {column} FROM {table}"):
                    if value:
                        cipher.decrypt(value.encode())
                        decrypted += 1
        if "nextcloud_playlists" in tables:
            for (items,) in db.execute("SELECT items_json FROM nextcloud_playlists"):
                for item in json.loads(items):
                    cipher.decrypt(item["url_enc"].encode())
                    decrypted += 1
    return {
        "verified_files": len(entries),
        "library_files": sum(n.startswith("music/library/") for n in entries),
        "databases": databases,
        "decrypted_secrets": decrypted,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    capture = sub.add_parser("backup")
    for field in ("hub-data", "navidrome-data", "music-root", "env-file", "config", "nd-config", "output"):
        capture.add_argument("--" + field, type=Path, required=True)
    extract = sub.add_parser("restore")
    extract.add_argument("--archive", type=Path, required=True)
    extract.add_argument("--destination", type=Path, required=True)
    check = sub.add_parser("verify")
    check.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--passphrase-env", default="QQM_BACKUP_PASSPHRASE")
    args = vars(parser.parse_args())
    command = args.pop("command")
    env = args.pop("passphrase_env")
    try:
        if command == "verify":
            result = verify(**args)
        else:
            result = globals()[command](**args, password=os.environ[env])
        print(json.dumps(result))
    except Exception as error:
        # Never print provider URLs, file contents, environment values or crypto exceptions.
        parser.exit(1, f"Recovery operation failed ({type(error).__name__}). Check inputs and passphrase.\n")


if __name__ == "__main__":
    main()
