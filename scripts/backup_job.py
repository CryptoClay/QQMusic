"""Scheduled, encrypted recovery backup. Default is a dry run; --run opts into a maintenance window."""

import argparse
import hashlib
import json
import os
import re
import subprocess
import uuid
from datetime import UTC, datetime
from pathlib import Path


class Docker:
    def call(self, args, env=None):
        result = subprocess.run(
            ["docker", *args], env=env, capture_output=True, text=True, timeout=21600
        )
        if result.returncode:
            raise RuntimeError(
                "Docker operation failed; inspect container/service health"
            )
        return result.stdout

    def inspect(self, name):
        return json.loads(self.call(["inspect", name]))[0]


def load_config(path):
    config = json.loads(Path(path).read_text(encoding="utf-8"))
    for key in ("project", "destination", "passphrase_file"):
        config[key] = Path(config[key]).expanduser().resolve()
    if not 1 <= int(config.get("keep", 7)) <= 90:
        raise ValueError("keep must be 1..90")
    for key in ("hub_container", "navidrome_container"):
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", config[key]):
            raise ValueError("Invalid container name")
    return config


def file_hash(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def update_index(destination, records):
    temporary = destination / (".backup-index-" + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(records, indent=2), encoding="utf-8")
    temporary.replace(destination / ".qqmusic-backup-index.json")


def prune(destination, records, keep):
    remaining = list(records)
    for record in records[:-keep]:
        name = record["file"]
        if not re.fullmatch(r"qqmusic-[0-9TZ]+-[a-f0-9]{8}\.qqm", name):
            raise ValueError("Invalid retention entry")
        path = destination / name
        if path.resolve().parent != destination.resolve() or path.is_symlink():
            raise ValueError("Unsafe retention path")
        if path.exists():
            if file_hash(path) != record["sha256"]:
                raise ValueError("Retention archive was modified; preserved")
            path.unlink()
        remaining.remove(record)
    update_index(destination, remaining)
    return remaining


def perform(config, docker=None):
    docker = docker or Docker()
    destination, project = config["destination"], config["project"]
    hub = docker.inspect(config["hub_container"])
    nd = docker.inspect(config["navidrome_container"])
    music = next(m for m in hub["Mounts"] if m["Destination"] == "/music")
    nd_data = next(m for m in nd["Mounts"] if m["Destination"] == "/data")
    source_root = Path(music["Source"]).resolve()
    if (
        destination == source_root
        or source_root in destination.parents
        or destination == project
        or project in destination.parents
    ):
        raise ValueError("Backups must live outside project and music folders")
    key = config["passphrase_file"]
    if key.is_symlink() or (os.name != "nt" and key.stat().st_mode & 0o077):
        raise ValueError("Passphrase file must be private (chmod 600)")
    docker.call(["image", "inspect", config.get("image", "qqmusic-hub:local")])
    password = key.read_text(encoding="utf-8").rstrip("\r\n")
    if len(password) < 16:
        raise ValueError("Passphrase must contain at least 16 characters")
    destination.mkdir(parents=True, exist_ok=True)
    lock = destination / ".qqmusic-backup.lock"
    with lock.open("x", encoding="utf-8") as handle:
        handle.write(str(os.getpid()))
    try:
        index = destination / ".qqmusic-backup-index.json"
        records = (
            json.loads(index.read_text(encoding="utf-8")) if index.exists() else []
        )
        name = (
            "qqmusic-"
            + datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
            + "-"
            + uuid.uuid4().hex[:8]
            + ".qqm"
        )
        running = [
            name
            for name, item in (
                (config["hub_container"], hub),
                (config["navidrome_container"], nd),
            )
            if item["State"]["Running"]
        ]
        env = {**os.environ, "QQM_BACKUP_PASSPHRASE": password}
        try:
            # Freeze writes consistently across both databases and music, then always restore prior running state.
            if running:
                docker.call(["stop", "--time", "60", *running])
            docker.call(
                [
                    "run",
                    "--rm",
                    "--network",
                    "none",
                    "--volumes-from",
                    config["hub_container"] + ":ro",
                    "-v",
                    str(nd_data["Source"]) + ":/source/navidrome:ro",
                    "-v",
                    str(project) + ":/project:ro",
                    "-v",
                    str(destination) + ":/output",
                    "-e",
                    "QQM_BACKUP_PASSPHRASE",
                    "--entrypoint",
                    "python",
                    config.get("image", "qqmusic-hub:local"),
                    "/project/scripts/recovery.py",
                    "backup",
                    "--hub-data",
                    "/data",
                    "--navidrome-data",
                    "/source/navidrome",
                    "--music-root",
                    "/music",
                    "--env-file",
                    "/project/.env",
                    "--config",
                    "/project/config.yaml",
                    "--nd-config",
                    "/project/navidrome/navidrome.toml",
                    "--output",
                    "/output/" + name,
                ],
                env=env,
            )
        finally:
            if running:
                docker.call(["start", *running])
        archive = destination / name
        records.append(
            {
                "file": name,
                "sha256": file_hash(archive),
                "bytes": archive.stat().st_size,
            }
        )
        update_index(destination, records)
        remaining = prune(destination, records, int(config.get("keep", 7)))
        return {
            "archive": name,
            "retained": len(remaining),
            "sha256": records[-1]["sha256"],
        }
    finally:
        lock.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument(
        "--run",
        action="store_true",
        help="Allow stopping Hub/Navidrome for a consistent backup",
    )
    args = parser.parse_args()
    try:
        config = load_config(args.config)
        if args.run:
            result = perform(config)
        else:
            result = {
                "dry_run": True,
                "destination": str(config["destination"]),
                "keep": config.get("keep", 7),
                "maintenance": "Stops Hub/Navidrome during archive capture; restores previous running state",
                "enabled": False,
            }
        print(json.dumps(result))
    except Exception as error:
        raise SystemExit(
            "Scheduled backup failed (" + type(error).__name__ + "). No secrets logged."
        ) from None


if __name__ == "__main__":
    main()
