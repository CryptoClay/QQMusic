import importlib.util
from pathlib import Path

import pytest


@pytest.fixture
def job():
    path = Path(__file__).resolve().parents[2] / "scripts/backup_job.py"
    spec = importlib.util.spec_from_file_location("backup_job", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeDocker:
    def __init__(self, destination, fail=False):
        self.calls = []
        self.destination = destination
        self.fail = fail

    def inspect(self, name):
        return {
            "State": {"Running": name == "hub"},
            "Mounts": [
                {"Destination": "/music", "Source": "/separate/music"},
                {"Destination": "/data", "Source": "/separate/nd"},
            ],
        }

    def call(self, args, env=None):
        self.calls.append(args)
        if args[0] == "run":
            if self.fail:
                raise RuntimeError("backup failed")
            assert env["QQM_BACKUP_PASSPHRASE"] == "a very long test password"
            (self.destination / Path(args[-1]).name).write_bytes(b"encrypted fixture")
        return ""


def config(tmp_path):
    key = tmp_path / "key"
    key.write_text("a very long test password")
    key.chmod(0o600)
    return {
        "project": tmp_path / "project",
        "destination": tmp_path / "backups",
        "passphrase_file": key,
        "hub_container": "hub",
        "navidrome_container": "nd",
        "keep": 1,
    }


def test_backup_restores_only_previously_running_services_and_retains_owned_archives(tmp_path, job):
    settings = config(tmp_path)
    docker = FakeDocker(settings["destination"])
    first = job.perform(settings, docker)
    second = job.perform(settings, docker)
    assert ["stop", "--time", "60", "hub"] in docker.calls
    assert ["start", "hub"] in docker.calls
    assert not (settings["destination"] / first["archive"]).exists()
    assert (settings["destination"] / second["archive"]).exists()
    assert not (settings["destination"] / ".qqmusic-backup.lock").exists()


def test_failed_backup_always_restarts_services_without_pruning(tmp_path, job):
    settings = config(tmp_path)
    docker = FakeDocker(settings["destination"], True)
    with pytest.raises(RuntimeError):
        job.perform(settings, docker)
    assert docker.calls[-1] == ["start", "hub"]
    assert not (settings["destination"] / ".qqmusic-backup.lock").exists()


def test_retention_rejects_path_escape_and_modified_archives(tmp_path, job):
    with pytest.raises(ValueError):
        job.prune(tmp_path, [{"file": "../important", "sha256": "x"}, {"file": "keep"}], 1)
    name = "qqmusic-20261114T000000Z-abcdef01.qqm"
    (tmp_path / name).write_bytes(b"changed")
    with pytest.raises(ValueError):
        job.prune(tmp_path, [{"file": name, "sha256": "wrong"}, {"file": "keep"}], 1)
    assert (tmp_path / name).exists()
