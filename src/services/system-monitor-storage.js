import fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const STORAGE_SNAPSHOT_PATH = "/run/ozon-erp-monitor/storage-usage.json";
export const STORAGE_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;
export const MONITORED_PATHS = Object.freeze({
  mysql: "/var/lib/mysql",
  uploads: "/opt/ozon-erp/shared/uploads",
  backups: "/opt/ozon-erp/shared/backups",
  releases: "/opt/ozon-erp/releases",
  logs: "/var/log"
});
export const STORAGE_METRICS = Object.freeze([...Object.keys(MONITORED_PATHS), "binlog"]);

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function checkedBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw failure("INVALID_MEASUREMENT");
  return value;
}

function errorCode(error) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "COLLECTION_FAILED";
}

export function validateStorageSnapshot(snapshot, nowMs = Date.now()) {
  const capturedMs = Date.parse(snapshot?.capturedAt);
  if (snapshot?.version !== 1 || !Number.isFinite(capturedMs)
    || capturedMs > nowMs + 60_000) throw failure("INVALID_SNAPSHOT");
  if (nowMs - capturedMs > STORAGE_SNAPSHOT_MAX_AGE_MS) throw failure("STALE_SNAPSHOT");
  const metrics = {};
  const errors = {};
  for (const key of STORAGE_METRICS) {
    if (snapshot.metrics?.[key] === null && typeof snapshot.errors?.[key]?.code === "string"
      && /^[A-Z][A-Z0-9_]{0,63}$/.test(snapshot.errors[key].code)) {
      metrics[key] = null;
      errors[key] = { code: snapshot.errors[key].code };
    } else {
      metrics[key] = checkedBytes(snapshot.metrics?.[key]);
      if (snapshot.errors?.[key]) throw failure("INVALID_SNAPSHOT");
    }
  }
  return { metrics, collection: {
    version: 1, source: "root_snapshot", capturedAt: snapshot.capturedAt,
    status: Object.keys(errors).length ? "incomplete" : "complete", errors
  } };
}

async function readRootSnapshot(fsApi, platform) {
  // The parent directory must remain root-owned so the application cannot swap the file.
  const directory = await fsApi.lstat("/run/ozon-erp-monitor");
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || (platform === "linux" && (directory.uid !== 0 || (directory.mode & 0o022)))) {
    throw failure("UNTRUSTED_SNAPSHOT");
  }
  const file = await fsApi.open(STORAGE_SNAPSHOT_PATH, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024
      || (platform === "linux" && (stat.uid !== 0 || (stat.mode & 0o022)))) {
      throw failure("UNTRUSTED_SNAPSHOT");
    }
    return JSON.parse(await file.readFile({ encoding: "utf8" }));
  } finally {
    await file.close();
  }
}

export async function collectStorageUsage({ fsApi = fs, runFile = execFileAsync,
  now = Date.now, platform = process.platform } = {}) {
  let snapshotError;
  try {
    return validateStorageSnapshot(await readRootSnapshot(fsApi, platform), now());
  } catch (error) {
    snapshotError = errorCode(error);
  }
  const metrics = {};
  const errors = {};
  async function measure(key, action) {
    try { metrics[key] = checkedBytes(await action()); }
    catch (error) { metrics[key] = null; errors[key] = { code: errorCode(error) }; }
  }
  await Promise.all([
    ...Object.entries(MONITORED_PATHS).map(([key, target]) => measure(key, async () => {
      const { stdout } = await runFile("du", ["-sk", "--", target], { timeout: 30_000, maxBuffer: 1024 * 1024 });
      const token = String(stdout).trim().split(/\s+/)[0];
      if (!/^\d+$/.test(token)) throw failure("INVALID_MEASUREMENT");
      return checkedBytes(Number(token) * 1024);
    })),
    measure("binlog", async () => {
      const entries = await fsApi.readdir(MONITORED_PATHS.mysql, { withFileTypes: true });
      const files = entries.filter(entry => entry.isFile() && /^binlog\.\d+$/.test(entry.name));
      const stats = await Promise.all(files.map(entry => fsApi.stat(`${MONITORED_PATHS.mysql}/${entry.name}`)));
      return stats.reduce((sum, stat) => sum + checkedBytes(stat.size), 0);
    })
  ]);
  return { metrics, collection: {
    version: 1, source: "direct", capturedAt: new Date(now()).toISOString(),
    status: Object.keys(errors).length ? "incomplete" : "complete", errors, rootSnapshotError: snapshotError
  } };
}

export function storageMetricValue(row, column, metric, collection) {
  if (collection?.errors && Object.hasOwn(collection.errors, metric)) return null;
  const value = Number(row[column]);
  return Number.isFinite(value) ? value : null;
}
