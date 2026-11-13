import importlib.util
import json
from pathlib import Path

import pytest


def test_public_documentation_links_and_version():
    root = Path(__file__).resolve().parents[2]
    module_path = root / "scripts/release_check.py"
    spec = importlib.util.spec_from_file_location("release_check", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.check_docs(root)
    assert (root / "VERSION").read_text().strip()


def test_retired_product_pages_are_not_shipped():
    root = Path(__file__).resolve().parents[2]
    for name in ("Assistant.tsx", "AssistantChat.tsx", "AssistantTask.tsx"):
        assert not (root / "web/src/pages" / name).exists()
    assert not (root / "web/mock").exists() or not list((root / "web/mock").glob("*.ts"))


@pytest.mark.parametrize(
    "change",
    [
        {"completed": False},
        {"failures": ["stalled"]},
        {"elapsed_seconds": 7199},
        {"duration_seconds": 60},
        {"audio_progress_seconds": 5759},
    ],
)
def test_candidate_rejects_incomplete_soak(tmp_path, monkeypatch, change):
    root = Path(__file__).resolve().parents[2]
    monkeypatch.syspath_prepend(str(root / "scripts"))
    from package_release import validate_soak

    report = {
        "completed": True,
        "failures": [],
        "elapsed_seconds": 7201,
        "duration_seconds": 7200,
        "audio_progress_seconds": 7000,
    }
    report.update(change)
    path = tmp_path / "soak.json"
    path.write_text(json.dumps(report), encoding="utf-8")
    with pytest.raises(ValueError):
        validate_soak(path)


def test_candidate_accepts_completed_two_hour_soak(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[2]
    monkeypatch.syspath_prepend(str(root / "scripts"))
    from package_release import validate_soak

    report = {
        "completed": True,
        "failures": [],
        "elapsed_seconds": 7201,
        "duration_seconds": 7200,
        "audio_progress_seconds": 7000,
    }
    path = tmp_path / "soak.json"
    path.write_text(json.dumps(report), encoding="utf-8")
    assert validate_soak(path) == report
