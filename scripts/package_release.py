"""Package the committed candidate only after completed soak evidence; no automatic publication."""

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

from release_check import ROOT, check_docs


def validate_soak(path):
    report = json.loads(Path(path).read_text(encoding="utf-8"))
    if not report.get("completed") or report.get("failures"):
        raise ValueError("Soak did not complete successfully")
    if report.get("elapsed_seconds", 0) < 7200 or report.get("duration_seconds", 0) < 7200:
        raise ValueError("Two hours of real-time evidence required")
    if report.get("audio_progress_seconds", 0) < 5760:
        raise ValueError("Insufficient measured audio progress")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--soak-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "reports/package")
    args = parser.parse_args()
    validate_soak(args.soak_report)
    check_docs()
    status = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, check=True)
    if status.stdout.strip():
        raise SystemExit("Commit changes before packaging")
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()
    args.output.mkdir(parents=True, exist_ok=True)
    archive = args.output / ("QQMusic-" + version + ".zip")
    if archive.exists():
        raise SystemExit("Archive already exists")
    subprocess.run(
        [
            "git",
            "archive",
            "--format=zip",
            "--prefix=QQMusic-" + version + "/",
            "--output",
            str(archive.resolve()),
            "HEAD",
        ],
        cwd=ROOT,
        check=True,
    )
    with archive.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    (args.output / "SHA256SUMS").write_text(digest + "  " + archive.name + "\n", encoding="utf-8")
    (args.output / "release.json").write_text(
        json.dumps({"version": version, "commit": commit, "sha256": digest, "candidate": "-rc." in version}, indent=2),
        encoding="utf-8",
    )
    print(json.dumps({"version": version, "commit": commit, "archive": archive.name, "sha256": digest}))


if __name__ == "__main__":
    main()
