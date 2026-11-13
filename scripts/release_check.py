"""Read-only release preflight. Uses disposable Compose settings, never the working .env."""

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def check_docs(root=ROOT):
    failures = []
    for path in [root / "README.md", *sorted((root / "docs").glob("*.md"))]:
        text = path.read_text(encoding="utf-8")
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
            target = target.split("#", 1)[0].strip("<>")
            if not target or target.startswith(("http:", "https:", "mailto:", "/")):
                continue
            if not (path.parent / target).is_file():
                failures.append(str(path.relative_to(root)) + ": " + target)
    if failures:
        raise ValueError("Broken documentation links: " + ", ".join(failures))
    return True


def check_public_compose(root=ROOT):
    with tempfile.TemporaryDirectory(prefix="qqmusic-release-") as temp:
        folder = Path(temp)
        (folder / "deploy").mkdir()
        for name in (
            "docker-compose.yml",
            "deploy/compose.public.yml",
            "deploy/Caddyfile",
        ):
            shutil.copyfile(root / name, folder / name)
        (folder / ".env").write_text(
            "HUB_SECRET_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nND_PASSWORDENCRYPTIONKEY="
            + ("a" * 32)
            + "\nMUSIC_ROOT=/tmp/qqmusic-release-music\nQQM_DOMAIN=music.example.test\n",
            encoding="utf-8",
        )
        env = {
            **os.environ,
            "COMPOSE_PROFILES": "",
            "QQM_DOMAIN": "music.example.test",
            "MUSIC_ROOT": "/tmp/qqmusic-release-music",
            "HUB_SECRET_KEY": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "ND_PASSWORDENCRYPTIONKEY": "a" * 32,
        }
        result = subprocess.run(
            [
                "docker",
                "compose",
                "-f",
                str(folder / "docker-compose.yml"),
                "-f",
                str(folder / "deploy/compose.public.yml"),
                "config",
                "--format",
                "json",
            ],
            cwd=folder,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if result.returncode:
            raise RuntimeError(
                "Public Compose validation failed; check Docker Compose version"
            )
        model = json.loads(result.stdout)
        for name in ("hub", "navidrome", "youtube-pot", "embedder"):
            for port in model["services"].get(name, {}).get("ports", []):
                if port.get("host_ip") not in ("127.0.0.1", "::1"):
                    raise ValueError("An upstream service is exposed publicly")
        published = {str(p["published"]) for p in model["services"]["caddy"]["ports"]}
        if published != {"80", "443"}:
            raise ValueError("Unexpected public proxy ports")
        if model["services"]["hub"]["environment"]["PUBLIC_MODE"] != "true":
            raise ValueError("Public mode is not enabled by override")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-config", action="store_true")
    args = parser.parse_args()
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-rc\.\d+)?", version):
        raise SystemExit("Invalid VERSION")
    tracked = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.splitlines()
    forbidden = {".env", "config.yaml", ".youtube-cookies.txt"}
    if forbidden.intersection(tracked):
        raise SystemExit("Private configuration is tracked")
    result = {
        "version": version,
        "documentation": check_docs(),
        "private_settings_untracked": True,
    }
    if args.public_config:
        result["public_compose"] = check_public_compose()
    print(json.dumps(result))


if __name__ == "__main__":
    main()
