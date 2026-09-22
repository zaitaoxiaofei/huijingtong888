#!/usr/bin/env python3
"""Record production health and release identity without loading app credentials."""
import datetime
import json
import pathlib
import subprocess
import sys
import urllib.request

expected, previous = sys.argv[1:3]
root = pathlib.Path("/opt/ozon-erp")
state_path = root / "shared/release-monitor/status.json"


def http_status(url):
    try:
        with urllib.request.urlopen(url, timeout=8) as response:
            return response.status
    except Exception:
        return 0


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


old = read_json(state_path)
current = (root / "current").resolve()
service = subprocess.run(
    ["systemctl", "is-active", "ozon-erp"], capture_output=True, text=True, timeout=10
).stdout.strip()
ready = http_status("http://127.0.0.1:3000/api/ready")
public = http_status("https://erp.hjt888.xyz/api/ready")
healthy = service == "active" and ready == 200 and public == 200
release = read_json(current / "public/release.json")
state = {
    "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "expected_version": expected,
    "active_release": current.name,
    "published_version": release.get("version"),
    "version_matches": current.name == expected and release.get("version") == expected,
    "service": service,
    "ready_http": ready,
    "public_http": public,
    "healthy": healthy,
    "consecutive_failures": 0 if healthy else int(old.get("consecutive_failures", 0)) + 1,
    "previous_release": previous,
    "rollback_available": (root / "releases" / previous / "node_modules").is_dir(),
}
temporary = state_path.with_suffix(".tmp")
temporary.write_text(json.dumps(state, ensure_ascii=False) + "\n", encoding="utf-8")
temporary.replace(state_path)
if any(old.get(key) != state[key] for key in ("healthy", "active_release", "version_matches", "rollback_available")):
    print(json.dumps(state, ensure_ascii=False))
