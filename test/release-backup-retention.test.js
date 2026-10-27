import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gzipSync } from "node:zlib";
import { backupAiCreditResults } from "../scripts/lib/ai-credit-result-backup.mjs";
import { assertReleaseBackupLock, pinReleaseBackup, pruneReleaseBackups, releaseBackupLockMatches } from "../scripts/lib/release-backup-retention.mjs";
import { parseReleaseBackupArgs } from "../scripts/prune-release-backups.mjs";

const safety = { assertLock: async () => {}, findInUse: async () => [] };
async function fixture(t) {
  const temporary = await fs.realpath(os.tmpdir());
  const base = await fs.mkdtemp(path.join(temporary, "ozon-release-retention-"));
  assert.equal(path.dirname(base), temporary);
  assert.ok(path.basename(base).startsWith("ozon-release-retention-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "shared", "backups", "identity-releases");
  const maintenance = path.join(base, "shared", "maintenance", "ai-media-retention");
  const privateRoot = path.join(base, "private");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(privateRoot, "1"), { recursive: true });
  await fs.writeFile(path.join(privateRoot, "1", "11111111-1111-4111-8111-111111111111.json"), '{"result":"private fixture"}');
  const versions = ["old-code", "2026.10.27-ops-tools-774b18d", "middle-code", "recent-code", "latest-code"];
  const pairs = [];
  for (let index = 0; index < versions.length; index++) {
    const sql = path.join(root, `pre-release-${versions[index]}-20261027T01010${index + 1}Z-${index + 100}.sql.gz`);
    const ai = sql.slice(0, -7) + ".ai-results.jsonl.gz";
    await fs.writeFile(sql, gzipSync("CREATE TABLE fixture (id INT);\n"));
    await backupAiCreditResults({ root: privateRoot, output: ai });
    pairs.push({ sql, ai, release: versions[index] });
  }
  const maintain = async pair => {
    await fs.mkdir(maintenance, { recursive: true });
    await fs.writeFile(path.join(maintenance, pair.release + ".manifest.json"), '{"format":"ai-media-retention-v1"}');
  };
  return { base, root, maintenance, pairs, maintain };
}
const exists = async file => fs.lstat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const names = files => files.map(file => path.basename(file));

test("audit is read-only; apply verifies the latest two complete pairs and is idempotent", async t => {
  const { root, pairs } = await fixture(t);
  const audit = await pruneReleaseBackups({ root }, safety);
  assert.equal(audit.mode, "audit");
  assert.deepEqual(audit.kept.map(pair => pair.sql), names([pairs[4].sql, pairs[3].sql]));
  assert.equal(audit.candidates.length, 3);
  assert.equal(audit.verified.length, 0);
  assert.ok(await exists(pairs[0].sql));
  const result = await pruneReleaseBackups({ root, apply: true }, safety);
  assert.equal(result.verified.length, 2);
  assert.equal(result.deleted.length, 6);
  assert.ok(result.reclaimedBytes > 0);
  for (const pair of pairs.slice(0, 3)) assert.equal(await exists(pair.sql), false);
  assert.equal((await pruneReleaseBackups({ root, apply: true }, safety)).deleted.length, 0);
});

test("maintenance manifest automatically protects 774b18d and the manifest itself", async t => {
  const { root, pairs, maintenance, maintain } = await fixture(t);
  await maintain(pairs[1]);
  const result = await pruneReleaseBackups({ root, apply: true }, safety);
  assert.equal(result.kept.length, 3);
  assert.ok(result.kept.find(pair => pair.sql === path.basename(pairs[1].sql)).reasons.some(reason => reason.startsWith("maintenance:")));
  assert.ok(await exists(pairs[1].sql)); assert.ok(await exists(pairs[1].ai));
  assert.ok(await exists(path.join(maintenance, pairs[1].release + ".manifest.json")));
});

test("explicit pin defaults to audit, writes private durable metadata only when applied, and replays", async t => {
  const { root, pairs } = await fixture(t), backup = pairs[0].sql;
  await pinReleaseBackup({ root, backup, reason: "reviewed data migration" }, safety);
  assert.equal(await exists(backup + ".pin.json"), false);
  await pinReleaseBackup({ root, backup, reason: "reviewed data migration", apply: true }, safety);
  const before = await fs.readFile(backup + ".pin.json");
  await pinReleaseBackup({ root, backup, reason: "reviewed data migration", apply: true }, safety);
  assert.deepEqual(await fs.readFile(backup + ".pin.json"), before);
  const result = await pruneReleaseBackups({ root, apply: true }, safety);
  assert.ok(await exists(backup)); assert.ok(await exists(pairs[0].ai));
  assert.equal(result.kept.length, 3);
  assert.ok((await fs.readdir(root)).every(name => !name.includes(".partial")));
});

test("a truncated retained SQL or AI archive blocks every deletion", async t => {
  for (const kind of ["sql", "ai"]) {
    const { root, pairs } = await fixture(t);
    const target = pairs[4][kind], original = await fs.readFile(target);
    await fs.writeFile(target, original.subarray(0, original.length - 6));
    await assert.rejects(pruneReleaseBackups({ root, apply: true }, safety));
    for (const pair of pairs.slice(0, 3)) assert.ok(await exists(pair.sql));
  }
});

test("corrupt pinned pair blocks pruning even when the latest two are valid", async t => {
  const { root, pairs } = await fixture(t);
  await pinReleaseBackup({ root, backup: pairs[0].sql, reason: "historical recovery", apply: true }, safety);
  await fs.writeFile(pairs[0].sql, "not gzip");
  await assert.rejects(pruneReleaseBackups({ root, apply: true }, safety));
  assert.ok(await exists(pairs[1].sql));
});

test("partial backups, unknown release names, and broken pin metadata fail closed", async t => {
  for (const [name, content] of [["pre-release-incomplete.sql.gz.partial", "unfinished"],
    ["pre-release-not-a-release.sql.gz", "unknown"], ["PIN", "invalid"]]) {
    const { root, pairs } = await fixture(t);
    await fs.writeFile(path.join(root, name === "PIN" ? path.basename(pairs[0].sql) + ".pin.json" : name), content);
    await assert.rejects(pruneReleaseBackups({ root, apply: true }, safety));
    assert.ok(await exists(pairs[0].sql));
  }
});

test("unpaired SQL, orphan AI and unrelated backup files are preserved", async t => {
  const { root, pairs } = await fixture(t);
  await fs.unlink(pairs[0].ai);
  const orphan = path.join(root, "pre-release-orphan.ai-results.jsonl.gz"), other = path.join(root, "manual-repair.sql.gz");
  await fs.writeFile(orphan, "untouched"); await fs.writeFile(other, "untouched");
  const result = await pruneReleaseBackups({ root, apply: true }, safety);
  assert.ok(await exists(pairs[0].sql)); assert.ok(await exists(orphan)); assert.ok(await exists(other));
  assert.equal(result.ignored.length, 2);
});

test("a failed backup without its AI companion does not displace either latest complete pair", async t => {
  const { root, pairs } = await fixture(t);
  const failed = path.join(root, "pre-release-failed-20261027T230000Z-900.sql.gz");
  await fs.writeFile(failed, gzipSync("incomplete release snapshot"));
  const result = await pruneReleaseBackups({ root, apply: true }, safety);
  assert.deepEqual(result.kept.map(pair => pair.sql), names([pairs[4].sql, pairs[3].sql]));
  assert.ok(await exists(failed));
});

test("missing maintenance recovery pairs and malformed maintenance evidence block pruning", async t => {
  const { root, pairs, maintenance, maintain } = await fixture(t);
  await maintain(pairs[1]); await fs.unlink(pairs[1].ai);
  await assert.rejects(pruneReleaseBackups({ root, apply: true }, safety), /recovery backup pair is missing/);
  await fs.writeFile(path.join(maintenance, pairs[1].release + ".manifest.json"), "broken");
  await assert.rejects(pruneReleaseBackups({ root, apply: true }, safety));
  assert.ok(await exists(pairs[0].sql));
});

test("symbolic-link directories, linked ancestors and hard-linked backup files are rejected", async t => {
  const { base, root, pairs } = await fixture(t);
  const outside = path.join(base, "outside"); await fs.mkdir(outside);
  const alias = path.join(root, "alias");
  await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(pruneReleaseBackups({ root, apply: true }, safety), /Symbolic link/);
  await fs.unlink(alias);
  const ancestor = path.join(base, "alias");
  await fs.symlink(path.join(base, "shared"), ancestor, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(pruneReleaseBackups({ root: path.join(ancestor, "backups", "identity-releases"), apply: true }, safety), /absolute shared/);
  await fs.link(pairs[0].sql, path.join(outside, "hard-linked.sql.gz"));
  await assert.rejects(pruneReleaseBackups({ root, apply: true }, safety), /without links/);
  assert.ok(await exists(pairs[0].sql));
});

test("active backup references and missing or lost release locks stop deletion", async t => {
  const { root, pairs } = await fixture(t);
  await assert.rejects(pruneReleaseBackups({ root, apply: true }, { ...safety, findInUse: async () => [{ pid: "123", file: "fixture" }] }), /in use/);
  let checks = 0;
  await assert.rejects(pruneReleaseBackups({ root, apply: true }, { ...safety, assertLock: async () => { if (++checks > 1) throw new Error("lock lost"); } }), /lock lost/);
  await assert.rejects(assertReleaseBackupLock(undefined), /descriptor/);
  assert.ok(await exists(pairs[0].sql));
});

test("changed archive bytes and newly added maintenance references are detected before unlink", async t => {
  for (const change of ["archive", "maintenance"]) {
    const { root, pairs, maintain } = await fixture(t);
    let changed = false;
    const findInUse = async () => {
      if (!changed) { changed = true; if (change === "archive") await fs.appendFile(pairs[0].sql, "changed"); else await maintain(pairs[0]); }
      return [];
    };
    await assert.rejects(pruneReleaseBackups({ root, apply: true }, { ...safety, findInUse }), /changed/);
    assert.ok(await exists(pairs[0].sql));
  }
});

test("a protected SQL without a companion cannot be pinned", async t => {
  const { root, pairs } = await fixture(t);
  await fs.unlink(pairs[0].ai);
  await assert.rejects(pinReleaseBackup({ root, backup: pairs[0].sql, reason: "maintenance", apply: true }, safety), /incomplete or missing/);
  assert.equal(await exists(pairs[0].sql + ".pin.json"), false);
});

test("a retained pair changed after initial verification still stops the first unlink", async t => {
  const { root, pairs } = await fixture(t);
  let checks = 0;
  const findInUse = async () => { if (++checks === 2) await fs.appendFile(pairs[4].sql, "changed"); return []; };
  await assert.rejects(pruneReleaseBackups({ root, apply: true }, { ...safety, findInUse }), /retained backup changed/);
  assert.ok(await exists(pairs[0].sql));
  await assert.rejects(pruneReleaseBackups({ root, apply: "false" }, safety), /explicit boolean/);
});

test("CLI rejects unsafe or ambiguous options and never accepts an unverified lock assertion", () => {
  assert.equal(parseReleaseBackupArgs([]).apply, false);
  assert.deepEqual(parseReleaseBackupArgs(["--apply", "--lock-fd=9"]).lockFd, 9);
  for (const args of [["--apply", "--apply"], ["--lock-fd=2"], ["--lock-held"], ["--reason=alone"], ["--pin-backup=/tmp/a.sql.gz"], ["--apply=false"]]) {
    assert.throws(() => parseReleaseBackupArgs(args));
  }
});

test("inherited lock proof requires the same regular inode and an exclusive whole-file FLOCK", () => {
  const named = { dev: 19n, ino: 11691n, isFile: () => true, isSymbolicLink: () => false };
  const opened = { dev: 19n, ino: 11691n };
  const line = "pos:\t0\nflags:\t0102001\nlock:\t1: FLOCK ADVISORY WRITE 359 00:13:11691 0 EOF\n";
  assert.equal(releaseBackupLockMatches(named, opened, line), true);
  assert.equal(releaseBackupLockMatches(named, opened, line.replace("359", "-1")), true);
  for (const info of ["pos: 0\n", line.replace("WRITE", "READ"), line.replace("FLOCK", "POSIX"),
    line.replace("11691 0 EOF", "11692 0 EOF"), line.replace(" 0 EOF", " 1 EOF")]) {
    assert.equal(releaseBackupLockMatches(named, opened, info), false);
  }
  assert.equal(releaseBackupLockMatches(named, { ...opened, ino: 7n }, line), false);
  assert.equal(releaseBackupLockMatches({ ...named, isSymbolicLink: () => true }, opened, line), false);
});
