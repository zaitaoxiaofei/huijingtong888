import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pinReleaseBackup, pruneReleaseBackups, RELEASE_BACKUP_ROOT, RELEASE_LOCK_FILE } from "./lib/release-backup-retention.mjs";

export function parseReleaseBackupArgs(args) {
  const options = { root: RELEASE_BACKUP_ROOT, apply: false };
  const seen = new Set();
  for (const argument of args) {
    const match = /^(--apply|--root|--lock-fd|--pin-backup|--reason)(?:=(.*))?$/.exec(argument);
    if (!match || seen.has(match[1]) || (match[1] === "--apply" ? match[2] !== undefined : !match[2])) throw new Error("Unknown, duplicate or incomplete release backup option");
    seen.add(match[1]);
    if (match[1] === "--apply") options.apply = true;
    else if (match[1] === "--lock-fd") {
      if (!/^[1-9]\d*$/.test(match[2]) || Number(match[2]) < 3 || !Number.isSafeInteger(Number(match[2]))) throw new Error("Invalid inherited lock descriptor");
      options.lockFd = Number(match[2]);
    } else options[({ "--root": "root", "--pin-backup": "backup", "--reason": "reason" })[match[1]]] = match[2];
  }
  if (Boolean(options.backup) !== Boolean(options.reason)) throw new Error("--pin-backup and --reason must be supplied together");
  return options;
}

export async function runReleaseBackupCli(args) {
  const options = parseReleaseBackupArgs(args);
  if (process.platform !== "linux") throw new Error("Release backup maintenance requires Linux");
  if (options.lockFd === undefined) {
    const handle = await fs.open(RELEASE_LOCK_FILE, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      // Fixed shell program; user values are positional arguments, never shell code.
      const stdio = Array.from({ length: 10 }, (_, index) => index < 3 ? "inherit" : "ignore"); stdio[9] = handle.fd;
      const child = spawn("bash", ["--noprofile", "--norc", "-c", 'flock -n -x 9 || exit 75; exec "$@"',
        "release-backup-lock", process.execPath, fileURLToPath(import.meta.url), ...args, "--lock-fd=9"], { stdio });
      return await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => code === 0 ? resolve(null) : reject(new Error(`Release backup lock or operation failed (${signal || code})`))); });
    } finally { await handle.close(); }
  }
  const safety = { onRemoved: item => console.log(JSON.stringify({ event: "release_backup_removed", ...item })) };
  return options.backup ? pinReleaseBackup(options, safety) : pruneReleaseBackups(options, safety);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReleaseBackupCli(process.argv.slice(2)).then(report => { if (report) console.log(JSON.stringify(report)); })
    .catch(error => { console.error(JSON.stringify({ event: "release_backup_retention_failed", error: error.message })); process.exitCode = 1; });
}
