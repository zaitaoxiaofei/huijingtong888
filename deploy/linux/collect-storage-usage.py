#!/usr/bin/python3
"""Root-owned, fixed-scope filesystem counters. No application imports or credentials."""
import datetime
import errno
import json
import os
import re
import stat
import subprocess
import sys
import tempfile

OUTPUT_DIRECTORY = "/run/ozon-erp-monitor"
OUTPUT_PATH = OUTPUT_DIRECTORY + "/storage-usage.json"
PATHS = {
    "mysql": "/var/lib/mysql",
    "uploads": "/opt/ozon-erp/shared/uploads",
    "backups": "/opt/ozon-erp/shared/backups",
    "releases": "/opt/ozon-erp/releases",
    "logs": "/var/log",
}
MAX_SAFE_INTEGER = 9007199254740991


def checked_bytes(value):
    if type(value) is not int or not 0 <= value <= MAX_SAFE_INTEGER:
        raise ValueError("INVALID_MEASUREMENT")
    return value


def directory_bytes(target):
    result = subprocess.run(["/usr/bin/du", "-sk", "--", target], check=True,
                            capture_output=True, text=True, timeout=30,
                            env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
    token = result.stdout.strip().split()[0] if result.stdout.strip() else ""
    if not re.fullmatch(r"[0-9]+", token):
        raise ValueError("INVALID_MEASUREMENT")
    return checked_bytes(int(token) * 1024)


def binlog_bytes():
    total = 0
    with os.scandir(PATHS["mysql"]) as entries:
        for entry in entries:
            if re.fullmatch(r"binlog\.[0-9]+", entry.name) and entry.is_file(follow_symlinks=False):
                total += checked_bytes(entry.stat(follow_symlinks=False).st_size)
    return checked_bytes(total)


def collect():
    metrics, errors = {}, {}
    for key in [*PATHS, "binlog"]:
        try:
            metrics[key] = binlog_bytes() if key == "binlog" else directory_bytes(PATHS[key])
        except Exception as error:
            metrics[key] = None
            code = errno.errorcode.get(getattr(error, "errno", None), "COLLECTION_FAILED")
            if isinstance(error, subprocess.TimeoutExpired):
                code = "ETIMEDOUT"
            elif isinstance(error, ValueError):
                code = "INVALID_MEASUREMENT"
            errors[key] = {"code": code}
    return {"version": 1, "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "metrics": metrics, "errors": errors}


def publish(snapshot):
    directory = os.lstat(OUTPUT_DIRECTORY)
    if not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0 or directory.st_mode & 0o022:
        raise PermissionError("Output directory must be root-owned and not writable by the application")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=OUTPUT_DIRECTORY,
                                         prefix=".storage-", delete=False) as output:
            temporary = output.name
            json.dump(snapshot, output, separators=(",", ":"), allow_nan=False)
            output.write("\n")
            output.flush()
            os.fchmod(output.fileno(), 0o644)
            os.fsync(output.fileno())
        os.replace(temporary, OUTPUT_PATH)
        temporary = None
    finally:
        if temporary:
            os.unlink(temporary)


if __name__ == "__main__":
    if len(sys.argv) != 1 or not hasattr(os, "geteuid") or os.geteuid() != 0:
        sys.exit("Run the installed root-owned collector without arguments")
    snapshot = collect()
    publish(snapshot)
    print(json.dumps({"status": "incomplete" if snapshot["errors"] else "complete",
                      "errors": snapshot["errors"]}))
