#!/usr/bin/env python3
"""Deterministically package the committed plugin, never a working-tree overlay."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--release-sha", required=True, help="Exact verified merged remote release commit")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]

def git(*parts):
    return subprocess.check_output(["git", *parts], cwd=root)

sha = git("rev-parse", "HEAD").decode().strip()
if sha != args.release_sha:
    raise SystemExit("HEAD does not match the reviewed release SHA")
remote = git("rev-parse", "origin/release/2026.10.21-task-brand").decode().strip()
if remote != sha:
    raise SystemExit("Build must use the exact fetched remote release head")
archive = git("archive", "--format=tar", sha, "pdd-invoice-assistant")
prefix = "pdd-invoice-assistant/"
files = {}
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
    for entry in tar:
        if entry.isfile() and entry.name.startswith(prefix):
            files[entry.name[len(prefix):]] = tar.extractfile(entry).read()
manifest = json.loads(files["manifest.json"])
version = manifest["version"]
files["release.json"] = (json.dumps({"version": version, "releaseSha": sha, "channel": "local-pilot"}, ensure_ascii=False, indent=2) + "\n").encode()
args.output.mkdir(parents=True, exist_ok=True)
destination = args.output / f"pdd-invoice-assistant-{version}.zip"
with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
    for name, content in sorted(files.items()):
        entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        bundle.writestr(entry, content)
with zipfile.ZipFile(destination) as bundle:
    assert json.loads(bundle.read("manifest.json"))["version"] == version
    assert json.loads(bundle.read("release.json"))["releaseSha"] == sha
    assert not bundle.testzip()
digest = hashlib.sha256(destination.read_bytes()).hexdigest()
destination.with_suffix(".zip.sha256").write_text(f"{digest}  {destination.name}\n", encoding="utf-8")
print(json.dumps({"package": str(destination), "version": version, "releaseSha": sha, "sha256": digest}, ensure_ascii=False, indent=2))
