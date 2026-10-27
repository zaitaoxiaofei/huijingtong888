import fs from "node:fs/promises";
import { createReadStream, fstatSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { inspectAiCreditResultBackup } from "./ai-credit-result-backup.mjs";

export const RELEASE_BACKUP_ROOT = "/opt/ozon-erp/shared/backups/identity-releases";
export const RELEASE_LOCK_FILE = "/var/lock/ozon-erp-release.lock";
const SQL_NAME = /^pre-release-([A-Za-z0-9][A-Za-z0-9._-]*)-(\d{8}T\d{6}Z)-([1-9]\d*)\.sql\.gz$/;
const PIN_FORMAT = "ozon-release-backup-pin";
const companion = name => name.slice(0, -7) + ".ai-results.jsonl.gz";
const pinName = name => name + ".pin.json";

async function noLinks(target, allowMissing = false) {
  let current = path.parse(target).root;
  for (const segment of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Symbolic-link backup path refused"); }
    catch (error) { if (allowMissing && error.code === "ENOENT") return false; throw error; }
  }
  return true;
}

function backupRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value
    || path.basename(value) !== "identity-releases" || path.basename(path.dirname(value)) !== "backups"
    || path.basename(path.dirname(path.dirname(value))) !== "shared") throw new Error("Expected an absolute shared/backups/identity-releases directory");
  return value;
}

async function identity(file, directory = false) {
  const info = await fs.lstat(file, { bigint: true });
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n)) {
    throw new Error("Backup paths must be ordinary files or directories without links: " + path.basename(file));
  }
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(":");
}

async function privateJson(file, maximum = 64 * 1024) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || !info.size) throw new Error("Invalid backup protection metadata: " + path.basename(file));
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function syncDirectory(directory) {
  let handle;
  try { handle = await fs.open(directory, "r"); await handle.sync(); }
  catch (error) { if (process.platform !== "win32" || !["EISDIR", "EPERM", "EINVAL", "ENOTSUP"].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}

export function releaseBackupLockMatches(named, opened, info) {
  if (!named.isFile() || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino) return false;
  const locks = info.matchAll(/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+-?\d+\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s+0\s+EOF\s*$/gim);
  return [...locks].some(match => BigInt(match[1]) === opened.ino);
}

export async function assertReleaseBackupLock(fd) {
  if (process.platform !== "linux" || !Number.isSafeInteger(fd) || fd < 3) throw new Error("A verified Linux release lock descriptor is required");
  const named = await fs.lstat(RELEASE_LOCK_FILE, { bigint: true });
  const opened = fstatSync(fd, { bigint: true });
  const info = await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8");
  if (!releaseBackupLockMatches(named, opened, info)) throw new Error("Inherited descriptor does not hold the exclusive release lock");
}

async function inUse(files) {
  if (process.platform !== "linux") throw new Error("Linux process reference inspection is required");
  const selected = new Set(files), found = [];
  const missing = error => ["ENOENT", "ESRCH"].includes(error.code);
  for (const pid of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let descriptors;
    try { descriptors = await fs.readdir(`/proc/${pid}/fd`); } catch (error) { if (missing(error)) continue; throw error; }
    for (const fd of descriptors) {
      let target;
      try { target = await fs.readlink(`/proc/${pid}/fd/${fd}`); } catch (error) { if (missing(error)) continue; throw error; }
      if (selected.has(target.replace(/ \(deleted\)$/, ""))) found.push({ pid, file: path.basename(target) });
    }
    for (const name of ["cmdline", "maps"]) {
      let text;
      try { text = await fs.readFile(`/proc/${pid}/${name}`, "utf8"); } catch (error) { if (missing(error)) continue; throw error; }
      for (const file of selected) if (text.includes(file)) found.push({ pid, file: path.basename(file) });
    }
  }
  return found;
}

async function inspect(root) {
  await noLinks(root);
  const identities = { [root]: await identity(root, true) }, pairs = [], ignored = [], pins = new Map();
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("Symbolic link inside release backups");
    if (entry.name.includes(".partial")) throw new Error("Incomplete release backup exists; inspect it before pruning");
    if (entry.name.startsWith("pre-release-") && entry.name.endsWith(".sql.gz") && !SQL_NAME.test(entry.name)) throw new Error("Unexpected release backup name");
  }
  for (const entry of entries.filter(item => SQL_NAME.test(item.name))) {
    const match = SQL_NAME.exec(entry.name), sql = path.join(root, entry.name), ai = path.join(root, companion(entry.name));
    identities[sql] = await identity(sql);
    try { identities[ai] = await identity(ai); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      ignored.push({ file: entry.name, reason: "unpaired_sql_preserved" });
      continue;
    }
    pairs.push({ sql: entry.name, ai: companion(entry.name), release: match[1], timestamp: match[2], bytes: (await fs.stat(sql)).size + (await fs.stat(ai)).size });
  }
  for (const entry of entries.filter(item => item.name.endsWith(".sql.gz.pin.json"))) {
    const file = path.join(root, entry.name), name = entry.name.slice(0, -9), pair = pairs.find(item => item.sql === name);
    identities[file] = await identity(file);
    const pin = await privateJson(file);
    if (!pair || pin.format !== PIN_FORMAT || pin.version !== 1 || pin.backup !== name || pin.release !== pair.release
      || typeof pin.reason !== "string" || !pin.reason.trim()) throw new Error("Invalid or missing pinned backup pair: " + entry.name);
    pins.set(name, ["explicit_pin"]);
  }
  const maintenance = path.join(path.dirname(path.dirname(root)), "maintenance", "ai-media-retention");
  if (await noLinks(maintenance, true)) {
    identities[maintenance] = await identity(maintenance, true);
    for (const entry of await fs.readdir(maintenance, { withFileTypes: true })) {
      if (!entry.name.endsWith(".manifest.json")) continue;
      const release = entry.name.slice(0, -14), file = path.join(maintenance, entry.name);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(release)) throw new Error("Invalid maintenance manifest name");
      identities[file] = await identity(file);
      const manifest = await privateJson(file, 64 * 1024 * 1024);
      if (manifest.format !== "ai-media-retention-v1") throw new Error("Unrecognized maintenance manifest; refusing backup deletion");
      const matches = pairs.filter(pair => pair.release === release);
      if (!matches.length) throw new Error("Maintenance recovery backup pair is missing for release " + release);
      for (const pair of matches) pins.set(pair.sql, [...(pins.get(pair.sql) || []), "maintenance:" + entry.name]);
    }
  }
  pairs.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.sql.localeCompare(a.sql));
  for (const entry of entries) {
    if (entry.name.endsWith(".ai-results.jsonl.gz") && !pairs.some(pair => pair.ai === entry.name)) ignored.push({ file: entry.name, reason: "orphan_ai_preserved" });
  }
  const kept = pairs.filter((pair, index) => index < 2 || pins.has(pair.sql)).map(pair => ({ ...pair, reasons: [...(pairs.indexOf(pair) < 2 ? ["latest"] : []), ...(pins.get(pair.sql) || [])] }));
  const candidates = pairs.filter(pair => !kept.some(item => item.sql === pair.sql));
  return { kept, candidates, ignored, identities };
}

async function verifyPair(root, pair) {
  await pipeline(createReadStream(path.join(root, pair.sql)), createGunzip(), new Writable({ write(chunk, encoding, done) { done(); } }));
  const ai = await inspectAiCreditResultBackup({ input: path.join(root, pair.ai) });
  return { sql: pair.sql, ai: pair.ai, files: ai.files, content_sha256: ai.content_sha256 };
}

async function unchanged(before) {
  for (const [file, value] of Object.entries(before.identities)) {
    if (await identity(file, file.endsWith(path.sep + "identity-releases") || file.endsWith(path.sep + "ai-media-retention")) !== value) throw new Error("Backup or protection metadata changed during verification");
  }
}

// Safety hooks allow isolated filesystem tests; the CLI always uses real Linux checks.
export async function pruneReleaseBackups({ root = RELEASE_BACKUP_ROOT, apply = false, lockFd } = {}, safety = {}) {
  root = backupRoot(root);
  if (typeof apply !== "boolean") throw new Error("apply must be an explicit boolean");
  const locked = () => (safety.assertLock || assertReleaseBackupLock)(lockFd);
  const references = safety.findInUse || inUse;
  await locked();
  const before = await inspect(root);
  const report = { mode: apply ? "apply" : "audit", kept: before.kept, candidates: before.candidates, ignored: before.ignored, verified: [], deleted: [], reclaimedBytes: 0 };
  const targets = before.candidates.flatMap(pair => [path.join(root, pair.sql), path.join(root, pair.ai)]);
  if (targets.length && (await references(targets)).length) throw new Error("A release backup is in use");
  if (!apply || !before.candidates.length) return report;
  if (before.kept.length < 2) throw new Error("At least two complete backup pairs must be retained");
  for (const pair of before.kept) report.verified.push(await verifyPair(root, pair));
  await unchanged(before);
  if (JSON.stringify(await inspect(root)) !== JSON.stringify(before)) throw new Error("Backup selection changed during verification");
  const protectedFiles = before.kept.flatMap(pair => [path.join(root, pair.sql), path.join(root, pair.ai)]);
  for (const pair of before.candidates) {
    await locked();
    await noLinks(root);
    const files = [path.join(root, pair.sql), path.join(root, pair.ai)];
    if ((await references(files)).length) throw new Error("A release backup became active");
    for (const file of files) if (await identity(file) !== before.identities[file]) throw new Error("Backup changed before deletion");
    for (const file of files) {
      await locked();
      for (const protectedFile of protectedFiles) if (await identity(protectedFile) !== before.identities[protectedFile]) throw new Error("A retained backup changed before unlink");
      if (await identity(file) !== before.identities[file]) throw new Error("Backup changed before unlink");
      const bytes = (await fs.stat(file)).size;
      await fs.unlink(file);
      report.deleted.push(path.basename(file)); report.reclaimedBytes += bytes;
      safety.onRemoved?.({ file: path.basename(file), bytes });
    }
    await syncDirectory(root);
  }
  return report;
}

export async function pinReleaseBackup({ root = RELEASE_BACKUP_ROOT, backup, reason, apply = false, lockFd } = {}, safety = {}) {
  root = backupRoot(root);
  if (typeof apply !== "boolean") throw new Error("apply must be an explicit boolean");
  if (typeof backup !== "string" || path.dirname(backup) !== root || !SQL_NAME.test(path.basename(backup))
    || typeof reason !== "string" || !reason.trim() || reason.length > 2000) throw new Error("An exact backup path and nonempty pin reason are required");
  const locked = () => (safety.assertLock || assertReleaseBackupLock)(lockFd);
  await locked();
  const snapshot = await inspect(root), pair = [...snapshot.kept, ...snapshot.candidates].find(item => item.sql === path.basename(backup));
  if (!pair) throw new Error("The requested backup pair is incomplete or missing");
  const output = path.join(root, pinName(pair.sql));
  if (!apply) return { mode: "audit", pin: path.basename(output), backup: pair.sql };
  await verifyPair(root, pair);
  await unchanged(snapshot);
  const data = { format: PIN_FORMAT, version: 1, backup: pair.sql, release: pair.release, reason, created_at: new Date().toISOString() };
  const temporary = `${output}.${randomUUID()}.partial`;
  let ownsTemporary = false;
  try {
    await locked();
    const handle = await fs.open(temporary, "wx", 0o600); ownsTemporary = true;
    try { await handle.writeFile(JSON.stringify(data) + "\n", "utf8"); await handle.sync(); } finally { await handle.close(); }
    try { await fs.link(temporary, output); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await privateJson(output);
      if (existing.format !== PIN_FORMAT || existing.version !== 1 || existing.backup !== pair.sql || existing.release !== pair.release) throw new Error("Existing pin metadata conflicts");
    }
    await syncDirectory(root);
    return { mode: "apply", pin: path.basename(output), backup: pair.sql };
  } finally { if (ownsTemporary) { await fs.unlink(temporary); await syncDirectory(root); } }
}
