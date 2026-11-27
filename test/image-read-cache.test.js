import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createImageReadCacheWriter } from "../src/services/image-read-cache.js";

const name = value => `${value.toString(16).padStart(64, "0")}.webp`;
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-read-cache-"));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("cache writes remain atomic and bounded, and a full cache is reconsidered later", async () => fixture(async root => {
  let now = Date.now();
  const writer = createImageReadCacheWriter(root, { maxBytes: 8, now: () => now });
  assert.equal(await writer.write([{ name: name(1), buffer: Buffer.from("12345678") }]), true);
  assert.equal(await writer.write([{ name: name(2), buffer: Buffer.from("x") }]), false);
  assert.deepEqual(await fs.readdir(root), [name(1)]);
  await fs.unlink(path.join(root, name(1)));
  assert.equal(await writer.write([{ name: name(2), buffer: Buffer.from("x") }]), false);
  now += 60001;
  assert.equal(await writer.write([{ name: name(2), buffer: Buffer.from("x") }]), true);
  assert.equal((await fs.readFile(path.join(root, name(2)))).toString(), "x");
  assert.deepEqual(await fs.readdir(root), [name(2)]);
}));

test("a saturated cache reclaims at most 100 expired final hash files per minute", async () => fixture(async root => {
  let now = Date.now();
  const old = new Date(now - 8 * 24 * 60 * 60 * 1000);
  for (let index = 1; index <= 105; index++) {
    await fs.writeFile(path.join(root, name(index)), "x");
    await fs.utimes(path.join(root, name(index)), old, old);
  }
  const writer = createImageReadCacheWriter(root, { maxBytes: 1000, now: () => now });
  assert.equal(await writer.write([{ name: name(106), buffer: Buffer.from("new") }]), true);
  assert.equal((await fs.readdir(root)).length, 6);
  assert.equal(await writer.write([{ name: name(107), buffer: Buffer.from("new") }]), true);
  assert.equal((await fs.readdir(root)).length, 7);
  now += 60001;
  assert.equal(await writer.write([{ name: name(108), buffer: Buffer.from("new") }]), true);
  assert.deepEqual((await fs.readdir(root)).sort(), [name(106), name(107), name(108)].sort());
}));

test("temporary writes and unrecognized files are never swept", async () => fixture(async root => {
  const staging = `${name(1)}.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp`;
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await fs.writeFile(path.join(root, staging), "in progress");
  await fs.utimes(path.join(root, staging), old, old);
  const writer = createImageReadCacheWriter(root, { maxBytes: 1000 });
  assert.equal(await writer.write([{ name: name(2), buffer: Buffer.from("new") }]), true);
  assert.equal((await fs.readFile(path.join(root, staging))).toString(), "in progress");
  await fs.writeFile(path.join(root, "operator-note.txt"), "keep");
  assert.equal(await writer.write([{ name: name(3), buffer: Buffer.from("new") }]), false);
  assert.equal((await fs.readFile(path.join(root, "operator-note.txt"))).toString(), "keep");
  assert.equal(await writer.write([{ name: "../escape.webp", buffer: Buffer.from("bad") }]), false);
}));

test("cache write bursts retain no waiting image buffers and preserve existing atomic data", async () => fixture(async root => {
  const writer = createImageReadCacheWriter(root, { maxBytes: 1024 });
  const writes = Array.from({ length: 100 }, (_, index) => writer.write([{ name: name(index), buffer: Buffer.from("content") }]));
  const results = await Promise.all(writes);
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(await fs.readdir(root), [name(0)]);
  assert.equal(await writer.write([{ name: name(0), buffer: Buffer.from("replaced") }]), true);
  assert.equal((await fs.readFile(path.join(root, name(0)))).toString(), "replaced");
}));

test("cache budgets include file counts and refuse symlinks without touching their targets", async t => fixture(async root => {
  const countWriter = createImageReadCacheWriter(root, { maxBytes: 1000, maxFiles: 1 });
  assert.equal(await countWriter.write([{ name: name(1), buffer: Buffer.from("one") }]), true);
  assert.equal(await countWriter.write([{ name: name(2), buffer: Buffer.from("two") }]), false);
  const outside = path.join(root, "..", `${path.basename(root)}-outside`);
  await fs.writeFile(outside, "private original");
  try {
    try { await fs.symlink(outside, path.join(root, name(3))); }
    catch (error) { if (error.code === "EPERM") { t.diagnostic("Windows disallows file symlink creation; count budget assertions passed"); return; } throw error; }
    const writer = createImageReadCacheWriter(root, { maxBytes: 1000 });
    assert.equal(await writer.write([{ name: name(4), buffer: Buffer.from("new") }]), false);
    assert.equal((await fs.readFile(outside)).toString(), "private original");
    assert.equal((await fs.lstat(path.join(root, name(3)))).isSymbolicLink(), true);
  } finally { await fs.unlink(outside); }
}));

test("a hash-named hard link cannot authorize cache sweeping or writes", async () => fixture(async root => {
  const outside = path.join(root, "..", `${path.basename(root)}-original`);
  await fs.writeFile(outside, "keep original");
  try {
    await fs.link(outside, path.join(root, name(1)));
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(root, name(1)), old, old);
    const writer = createImageReadCacheWriter(root, { maxBytes: 1000 });
    assert.equal(await writer.write([{ name: name(2), buffer: Buffer.from("new") }]), false);
    assert.equal(await fs.readFile(outside, "utf8"), "keep original");
    assert.equal((await fs.lstat(path.join(root, name(1)))).nlink, 2);
  } finally { await fs.unlink(outside); }
}));
