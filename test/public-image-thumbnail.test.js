import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { createPublicImageThumbnailService } from "../src/services/public-image-thumbnail.js";

const env = { OSS_ENABLED: "true", OSS_INTERNAL_READ: "true", OSS_BUCKET: "public-images", OSS_REGION: "oss-cn-heyuan", OSS_ACCESS_KEY_ID: "fixture", OSS_ACCESS_KEY_SECRET: "fixture" };
const source = await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#1177bb" } }).png().toBuffer();
const url = `https://public-images.oss-cn-heyuan.aliyuncs.com/listing-media/aa/${createHash("sha256").update(source).digest("hex")}.png`;
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
async function fixture(action) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "public-image-thumbnail-"));
  try { await action(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("real list derivatives are small WebP, retain composition, and reuse a persisted cache across service instances", async () => fixture(async directory => {
  let reads = 0;
  const readSource = async (target, options) => {
    assert.equal(target, url); assert.equal(options.maxBytes, 20 * 1024 * 1024); assert.equal(options.timeoutMs, 6000);
    reads++; return { buffer: source, contentType: "image/png" };
  };
  const service = createPublicImageThumbnailService({ env, cacheDirectory: directory, readSource });
  const result = await service.get(url);
  assert.equal(result.cacheState, "MISS"); assert.equal(result.contentType, "image/webp");
  const metadata = await sharp(result.buffer).metadata();
  assert.equal(metadata.width, 180); assert.equal(metadata.height, 240);
  assert.ok(result.buffer.length < source.length / 2); assert.ok(result.buffer.length <= 512 * 1024);
  assert.equal((await sharp(source).metadata()).width, 900, "stored/published original remains full size");
  const next = createPublicImageThumbnailService({ env, cacheDirectory: directory, readSource });
  assert.equal((await next.get(url)).cacheState, "HIT"); assert.equal(reads, 1);
  assert.equal((await fs.readdir(directory)).length, 1);
}));

test("private, external, signed, transformed and local URLs fail before SDK/cache access", async () => fixture(async directory => {
  const service = createPublicImageThumbnailService({ env, cacheDirectory: directory, readSource: async () => assert.fail("No privileged read") });
  for (const target of [url.replace("listing-media", "ai-task-media"), url.replace("listing-media", "team-attachments"), url.replace("listing-media", "database-archives"),
    url.replace("public-images.", "another-bucket."), url + "?Signature=signed", url + "?x-oss-process=image/resize,w_10", url + "#fragment",
    "http://127.0.0.1/private.png", "https://169.254.169.254/latest/meta-data", url.replace("https://", "https://user:pass@"), url.replace(".aliyuncs.com", ".aliyuncs.com:8443"),
    "https://example.com/listing-media/aa/" + "a".repeat(64) + ".png", url.replace("/aa/", "/%2e%2e/")]) {
    await assert.rejects(service.get(target), failure => failure.status === 400);
  }
  assert.deepEqual(await fs.readdir(directory), []);
}));

test("without explicit internal reads a miss never shifts origin downloads onto public OSS egress", async () => fixture(async directory => {
  const service = createPublicImageThumbnailService({ env: { ...env, OSS_INTERNAL_READ: "false" }, cacheDirectory: directory, readSource: async () => assert.fail("No public SDK fallback") });
  await assert.rejects(service.get(url), failure => failure.code === "IMAGE_THUMBNAIL_INTERNAL_REQUIRED" && failure.status === 503);
  assert.deepEqual(await fs.readdir(directory), []);
}));

test("only four bounded width variants are accepted and preview inputs are not repurposed", async () => fixture(async directory => {
  let reads = 0;
  const service = createPublicImageThumbnailService({ env, cacheDirectory: directory, readSource: async () => { reads++; return { buffer: source, contentType: "image/png" }; } });
  for (const width of [0, -1, 1, 179, 361, 999999, NaN, Infinity, "180"]) await assert.rejects(service.get(url, { width }), failure => failure.status === 400);
  assert.equal(reads, 0);
  for (const width of [128, 180, 256, 360]) {
    const result = await service.get(url, { width }); const metadata = await sharp(result.buffer).metadata();
    assert.ok(metadata.width <= width); assert.ok(metadata.height <= Math.ceil(width * 4 / 3));
  }
  assert.equal(reads, 4);
}));

test("matching requests share one source read and CPU work", async () => fixture(async directory => {
  let finish, reads = 0;
  const service = createPublicImageThumbnailService({ env, cacheDirectory: directory, readSource: async () => { reads++; return new Promise(resolve => { finish = () => resolve({ buffer: source, contentType: "image/png" }); }); } });
  const work = Array.from({ length: 30 }, () => service.get(url));
  while (!finish) await turn(); assert.equal(reads, 1); finish();
  const results = await Promise.all(work); assert.ok(results.every(value => value === results[0]));
}));

test("decode admission bounds active/queued images and releases slots after a queued timeout", async () => fixture(async directory => {
  let finish, reads = 0;
  const service = createPublicImageThumbnailService({ env, cacheDirectory: directory, concurrency: 1, queuedLimit: 1, queueTimeoutMs: 10,
    readSource: async () => { reads++; if (reads === 1) return new Promise(resolve => { finish = () => resolve({ buffer: source, contentType: "image/png" }); }); return { buffer: source, contentType: "image/png" }; } });
  const running = service.get(url, { width: 128 }); while (!finish) await turn();
  const queued = assert.rejects(service.get(url, { width: 180 }), failure => failure.status === 503);
  await turn(); await assert.rejects(service.get(url, { width: 256 }), failure => failure.status === 503);
  await queued; assert.equal(reads, 1); finish(); await running;
  assert.equal((await service.get(url, { width: 360 })).cacheState, "MISS"); assert.equal(reads, 2);
}));

test("source byte/hash/format bounds reject unsafe bodies and failures cool down without permanent retry suppression", async () => fixture(async directory => {
  let reads = 0, now = Date.now();
  let body = { buffer: Buffer.alloc(20 * 1024 * 1024 + 1), contentType: "image/png" };
  const service = createPublicImageThumbnailService({ env, cacheDirectory: directory, now: () => now, readSource: async () => { reads++; return body; } });
  await assert.rejects(service.get(url), failure => failure.status === 422);
  await assert.rejects(service.get(url), failure => failure.status === 422); assert.equal(reads, 1);
  now += 15001; body = { buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///private"/></svg>'), contentType: "image/svg+xml" };
  await assert.rejects(service.get(url), failure => failure.status === 422); assert.equal(reads, 2);
  now += 15001; body = { buffer: Buffer.from(source), contentType: "image/png" }; body.buffer[body.buffer.length - 1] ^= 1;
  await assert.rejects(service.get(url), failure => failure.code === "IMAGE_THUMBNAIL_SOURCE_MISMATCH");
  assert.deepEqual(await fs.readdir(directory), []);
  now += 15001; body = { buffer: source, contentType: "image/png" };
  assert.equal((await service.get(url)).cacheState, "MISS");
}));

test("oversized dimensions are rejected before thumbnail encoding", async () => fixture(async directory => {
  const wide = await sharp({ create: { width: 12001, height: 1, channels: 3, background: "white" } }).png().toBuffer();
  const target = url.replace(/\/[a-f0-9]{64}\.png$/, `/${createHash("sha256").update(wide).digest("hex")}.png`);
  const service = createPublicImageThumbnailService({ env, cacheDirectory: directory, readSource: async () => ({ buffer: wide, contentType: "image/png" }) });
  await assert.rejects(service.get(target), failure => failure.status === 422);
  assert.deepEqual(await fs.readdir(directory), []);
}));

test("a MIME-spoofed SVG cannot enter the raster decoder", async () => fixture(async directory => {
  const body = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>');
  const target = url.replace(/\/[a-f0-9]{64}\.png$/, `/${createHash("sha256").update(body).digest("hex")}.png`);
  const service = createPublicImageThumbnailService({ env, cacheDirectory: directory, readSource: async () => ({ buffer: body, contentType: "image/png" }) });
  await assert.rejects(service.get(target), failure => failure.status === 422 && failure.code === "IMAGE_THUMBNAIL_SOURCE_UNSUPPORTED");
  assert.deepEqual(await fs.readdir(directory), []);
}));

test("upstream errors cannot expose OSS request credentials through route error messages", async () => fixture(async directory => {
  const upstream = Object.assign(new Error("private SDK request details"), { statusCode: 503, request: { authorization: "fixture-secret" } });
  const service = createPublicImageThumbnailService({ env, cacheDirectory: directory, readSource: async () => { throw upstream; } });
  await assert.rejects(service.get(url), failure => failure.status === 502 && failure.code === "IMAGE_THUMBNAIL_SOURCE_UNAVAILABLE"
    && !failure.message.includes("private SDK") && failure.request === undefined);
}));

test("landscape derivatives preserve the full source aspect instead of cropping it into the list box", async () => fixture(async directory => {
  const body = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#cc7700" } }).png().toBuffer();
  const target = url.replace(/\/[a-f0-9]{64}\.png$/, `/${createHash("sha256").update(body).digest("hex")}.png`);
  const service = createPublicImageThumbnailService({ env, cacheDirectory: directory, readSource: async () => ({ buffer: body, contentType: "image/png" }) });
  const result = await service.get(target); const metadata = await sharp(result.buffer).metadata();
  assert.equal(metadata.width, 180); assert.equal(metadata.height, 90);
}));

test("expired cache is regenerated and never changes the original source", async () => fixture(async directory => {
  let now = Date.now(), reads = 0;
  const originalHash = createHash("sha256").update(source).digest("hex");
  const service = createPublicImageThumbnailService({ env, cacheDirectory: directory, now: () => now, readSource: async () => { reads++; return { buffer: source, contentType: "image/png" }; } });
  await service.get(url); now += 8 * 24 * 60 * 60 * 1000;
  assert.equal((await service.get(url)).cacheState, "MISS"); assert.equal(reads, 2);
  assert.equal(createHash("sha256").update(source).digest("hex"), originalHash);
}));
