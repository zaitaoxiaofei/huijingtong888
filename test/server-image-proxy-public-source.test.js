import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import vm from "node:vm";
import test from "node:test";
import { isManagedPublicImageSource } from "../src/services/server-image-request.js";
import { createImageReadCacheWriter } from "../src/services/image-read-cache.js";

const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const start = source.indexOf("async function fetchRemoteImagePayload(");
const end = source.indexOf("function acquireImageProxyFetchSlot(", start);
const implementation = source.slice(start, end);
const canonical = `https://bucket.example/listing-media/aa/${"a".repeat(64)}.png`;

test("actual image proxy grants SDK access only to canonical public managed images", async () => {
  for (const [url, expected] of [
    [canonical, "managed"],
    [canonical.replace("listing-media", "ai-task-media"), "public"],
    [canonical.replace("listing-media", "team-attachments"), "public"],
    [canonical.replace("listing-media", "database-archives"), "public"],
    [`${canonical}?Signature=original`, "public"],
    [`${canonical}?x-oss-process=image/resize,w_100`, "public"],
    [canonical.replace("bucket.example", "external.example"), "public"]
  ]) {
    const calls = [];
    let acquired = 0, released = 0;
    const context = vm.createContext({
      AbortController, setTimeout, clearTimeout,
      IMAGE_PROXY_FETCH_TIMEOUT_MS: 6000, IMAGE_PROXY_MAX_RESPONSE_BYTES: 20 * 1024 * 1024,
      acquireImageProxyFetchSlot: async () => { acquired++; },
      releaseImageProxyFetchSlot: () => { released++; },
      isManagedPublicImageSource: target => isManagedPublicImageSource(target, { isManaged: value => value.startsWith("https://bucket.example/") }),
      readManagedOssObject: async (target, options) => {
        calls.push("managed"); assert.equal(target, canonical);
        assert.equal(options.maxBytes, 20 * 1024 * 1024);
        return { buffer: Buffer.from("image"), contentType: "image/png" };
      },
      requestPublicImage: async target => { calls.push("public"); assert.equal(target, url); return null; }
    });
    vm.runInContext(implementation, context);
    const result = await context.fetchRemoteImagePayload(url);
    assert.deepEqual(calls, [expected]);
    if (expected === "public") assert.equal(result, null);
    assert.equal(acquired, 1); assert.equal(released, 1);
  }
});

test("actual proxy disk reads reject mismatched image/metadata pairs and preserve fresh/stale semantics", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proxy-pair-integrity-"));
  try {
    const context = vm.createContext({
      Buffer, Date, fs, path, createHash,
      imageProxyCacheDir: directory,
      imageProxyCacheWriter: createImageReadCacheWriter(directory, { maxBytes: 1024 * 1024 }),
      IMAGE_PROXY_MAX_CACHE_BYTES: 8 * 1024 * 1024,
      IMAGE_PROXY_CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000
    });
    vm.runInContext(source.slice(source.indexOf("function imageProxyCacheKey("), source.indexOf("function sendRemoteImageBuffer(")), context);
    const original = Buffer.from("original");
    await context.writeCachedRemoteImage(canonical, { buffer: original, contentType: "image/png" });
    assert.deepEqual((await context.readCachedRemoteImage(canonical)).buffer, original);
    const { dataPath } = context.imageProxyCachePaths(canonical);
    await fs.writeFile(dataPath, "tampered");
    assert.equal(await context.readCachedRemoteImage(canonical), null);
    await context.writeCachedRemoteImage(canonical, { buffer: original, contentType: "image/png" });
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await fs.utimes(dataPath, old, old);
    assert.equal(await context.readCachedRemoteImage(canonical), null);
    assert.deepEqual((await context.readCachedRemoteImage(canonical, { allowStale: true })).buffer, original);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
