import assert from "node:assert/strict";
import test from "node:test";
import { collectStorageUsage, validateStorageSnapshot, STORAGE_METRICS,
  STORAGE_SNAPSHOT_MAX_AGE_MS, STORAGE_SNAPSHOT_PATH } from "../src/services/system-monitor-storage.js";

// All database operations below are injected; importing the service only needs valid configuration.
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_NAME ||= "system_monitor_unit_tests";
process.env.DB_USER ||= "unused_test_account";
const { captureSystemMonitorSnapshotWith, normalizeSystemMonitorSnapshot } = await import("../src/services/system-monitoring.js");

const now = Date.parse("2026-10-27T08:00:00Z");
const snapshot = () => ({ version: 1, capturedAt: new Date(now).toISOString(),
  metrics: Object.fromEntries(STORAGE_METRICS.map((key, index) => [key, 1024 * index])), errors: {} });
const denied = () => Object.assign(new Error("permission denied"), { code: "EACCES" });
function snapshotFs(value, { uid = 0, mode = 0o644 } = {}) {
  return {
    lstat: async () => ({ uid: 0, mode: 0o755, isDirectory: () => true, isSymbolicLink: () => false }),
    open: async path => {
      assert.equal(path, STORAGE_SNAPSHOT_PATH);
      return { stat: async () => ({ uid, mode, size: 500, isFile: () => true }),
        readFile: async () => JSON.stringify(value), close: async () => {} };
    },
    readdir: async () => { throw denied(); }
  };
}
const deniedDu = async (_command, _args) => { throw denied(); };

test("fresh root snapshots provide protected counters without privileged application commands", async () => {
  const result = await collectStorageUsage({ fsApi: snapshotFs(snapshot()), platform: "linux", now: () => now,
    runFile: async () => { assert.fail("direct command must not execute"); } });
  assert.deepEqual(result.metrics, snapshot().metrics);
  assert.equal(result.collection.source, "root_snapshot");
  assert.equal(result.collection.status, "complete");
  assert.equal(result.metrics.mysql, 0); // A successfully measured zero remains distinguishable from missing data.
});

test("permission failures become unknown metrics and explicit errors, never measured zeroes", async () => {
  const result = await collectStorageUsage({ fsApi: { lstat: async () => { throw denied(); },
    readdir: async () => { throw denied(); } }, runFile: deniedDu, now: () => now });
  for (const key of STORAGE_METRICS) {
    assert.equal(result.metrics[key], null);
    assert.equal(result.collection.errors[key].code, "EACCES");
  }
  assert.equal(result.collection.status, "incomplete");
  assert.equal(result.collection.rootSnapshotError, "EACCES");
});

test("stale root snapshots are rejected instead of reusing old counters", async () => {
  const stale = snapshot();
  stale.capturedAt = new Date(now - STORAGE_SNAPSHOT_MAX_AGE_MS - 1).toISOString();
  const result = await collectStorageUsage({ fsApi: snapshotFs(stale), platform: "linux", runFile: deniedDu, now: () => now });
  assert.equal(result.metrics.mysql, null);
  assert.equal(result.collection.rootSnapshotError, "STALE_SNAPSHOT");
  assert.equal(result.collection.source, "direct");
});

test("root collector partial failures stay explicit even when the snapshot file is fresh", async () => {
  const partial = snapshot();
  partial.metrics.mysql = null;
  partial.errors.mysql = { code: "EACCES" };
  const result = await collectStorageUsage({ fsApi: snapshotFs(partial), platform: "linux", now: () => now,
    runFile: async () => assert.fail("partial root data must retain its error") });
  assert.equal(result.metrics.mysql, null);
  assert.equal(result.collection.status, "incomplete");
  assert.equal(result.collection.errors.mysql.code, "EACCES");
  assert.equal(result.metrics.logs, partial.metrics.logs);
});

test("untrusted ownership or writable root snapshot files are not accepted", async () => {
  for (const permissions of [{ uid: 1000 }, { mode: 0o666 }]) {
    const result = await collectStorageUsage({ fsApi: snapshotFs(snapshot(), permissions), platform: "linux",
      now: () => now, runFile: deniedDu });
    assert.equal(result.collection.rootSnapshotError, "UNTRUSTED_SNAPSHOT");
    assert.equal(result.metrics.mysql, null);
  }
});

test("application-writable or symlinked snapshot directories cannot supply privileged measurements", async () => {
  for (const directory of [{ uid: 1000, mode: 0o755 }, { uid: 0, mode: 0o777 }, { uid: 0, mode: 0o755, symlink: true }]) {
    const fsApi = snapshotFs(snapshot());
    fsApi.lstat = async () => ({ ...directory, isDirectory: () => true, isSymbolicLink: () => Boolean(directory.symlink) });
    fsApi.open = async () => assert.fail("untrusted parent must be rejected before opening the file");
    const result = await collectStorageUsage({ fsApi, platform: "linux", now: () => now, runFile: deniedDu });
    assert.equal(result.collection.rootSnapshotError, "UNTRUSTED_SNAPSHOT");
    assert.equal(result.metrics.mysql, null);
  }
});

test("a symlinked snapshot file or partial du failure is reported instead of trusted", async () => {
  const fsApi = snapshotFs(snapshot());
  fsApi.open = async () => { throw Object.assign(new Error(), { code: "ELOOP" }); };
  const result = await collectStorageUsage({ fsApi, platform: "linux", now: () => now,
    runFile: async () => { throw Object.assign(new Error("du failed"), { code: 1, stdout: "99999\t/partial" }); } });
  assert.equal(result.collection.rootSnapshotError, "ELOOP");
  assert.equal(result.metrics.mysql, null);
  assert.equal(result.collection.errors.mysql.code, "COLLECTION_FAILED");
});

test("missing directories and invalid du output cannot masquerade as an empty directory", async () => {
  const result = await collectStorageUsage({ fsApi: { lstat: async () => { throw Object.assign(new Error(), { code: "ENOENT" }); },
    readdir: async () => [] }, now: () => now,
    runFile: async (_command, args) => {
      if (args.at(-1) === "/var/lib/mysql") throw Object.assign(new Error(), { code: "ENOENT" });
      if (args.at(-1) === "/var/log") return { stdout: "not-a-number" };
      return { stdout: "0\t/directory\n" };
    } });
  assert.equal(result.metrics.mysql, null);
  assert.equal(result.collection.errors.mysql.code, "ENOENT");
  assert.equal(result.metrics.logs, null);
  assert.equal(result.collection.errors.logs.code, "INVALID_MEASUREMENT");
  assert.equal(result.metrics.uploads, 0);
  assert.equal(result.metrics.binlog, 0);
});

test("invalid snapshot counters and future timestamps are rejected", () => {
  for (const invalid of [-1, "123", Number.MAX_SAFE_INTEGER + 1, null]) {
    const value = snapshot(); value.metrics.mysql = invalid;
    assert.throws(() => validateStorageSnapshot(value, now));
  }
  const future = snapshot(); future.capturedAt = new Date(now + 60_001).toISOString();
  assert.throws(() => validateStorageSnapshot(future, now), { code: "INVALID_SNAPSHOT" });
});

test("incomplete capture persists quality metadata and returns null through the existing API shape", async () => {
  const storage = validateStorageSnapshot({ ...snapshot(), metrics: { ...snapshot().metrics, mysql: null },
    errors: { mysql: { code: "EACCES" } } }, now);
  const statements = [];
  const warnings = [];
  const result = await captureSystemMonitorSnapshotWith({
    prepare: async () => {}, readDisk: async () => ({ blocks: 100, bsize: 1024 ** 3, bavail: 80 }),
    readStorage: async () => storage, readTables: async () => [{ tableName: "orders", totalBytes: 512 }],
    query: async () => [{ disk_used_bytes: 20 * 1024 ** 3 }],
    execute: async (sql, values) => { statements.push({ sql, values }); return { insertId: 7 }; },
    now: () => new Date(now), warn: (...args) => warnings.push(args)
  });
  assert.equal(result.status, "partial");
  assert.equal(result.severity, "warning");
  assert.equal(warnings.length, 1);
  const values = statements[0].values;
  assert.equal(values.length, 16);
  assert.equal(values[6], 0); // NOT NULL compatibility storage is never exposed as a successful measurement.
  const row = normalizeSystemMonitorSnapshot({ id: 7, mysql_bytes: values[6], binlog_bytes: values[7],
    uploads_bytes: values[8], backups_bytes: values[9], releases_bytes: values[10], logs_bytes: values[11],
    severity: values[14], details_json: values[15] });
  assert.equal(row.mysqlBytes, null);
  assert.equal(row.binlogBytes, storage.metrics.binlog);
  assert.equal(row.storageCollection.errors.mysql.code, "EACCES");
  assert.deepEqual(row.topTables, [{ tableName: "orders", totalBytes: 512 }]);
  assert.match(statements[1].sql, /DELETE FROM system_monitor_snapshots/);
  assert.equal(statements[1].values[0], 180);
});

test("complete captures retain all measured values and legacy snapshot fields remain readable", async () => {
  const warnings = [];
  const result = await captureSystemMonitorSnapshotWith({ prepare: async () => {},
    readDisk: async () => ({ blocks: 100, bsize: 1024 ** 3, bavail: 80 }),
    readStorage: async () => validateStorageSnapshot(snapshot(), now), readTables: async () => [],
    query: async () => [], execute: async () => ({ insertId: 8 }), now: () => new Date(now),
    warn: (...args) => warnings.push(args) });
  assert.equal(result.status, "success");
  assert.equal(result.severity, "normal");
  assert.deepEqual(warnings, []);
  assert.equal(normalizeSystemMonitorSnapshot({ mysql_bytes: 99, details_json: "{}" }).mysqlBytes, 99);
});
