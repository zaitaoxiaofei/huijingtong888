import test from "node:test";
import assert from "node:assert/strict";
import { downloadListingSourceImage, isManagedListingSourceImage, isTransientImageDownloadError } from "../src/services/listing-image-download.js";

const image = { buffer: Buffer.from("image"), contentType: "image/png" };
const url = "https://bucket.example/listing-media/source.png";
const noWait = { waitImpl: async () => {}, onRetry() {} };

test("owned images use the internal authenticated reader and never the public URL reader", async () => {
  const calls = [];
  const result = await downloadListingSourceImage(url, { ...noWait, internal: true, isManaged: () => true,
    readManaged: async (_url, options) => { calls.push(options); return image; },
    request: async () => { throw new Error("credentials must not reach arbitrary public hosts"); } });
  assert.equal(result.buffer.toString(), "image");
  assert.equal(calls[0].internal, true);
  assert.equal(calls[0].timeoutMs, 15000);
});

test("internal timeouts fall back to authenticated public OSS with a fresh bounded attempt", async () => {
  const routes = [], delays = [];
  const result = await downloadListingSourceImage(url, { ...noWait, internal: true, isManaged: () => true,
    waitImpl: async ms => delays.push(ms), readManaged: async (_url, options) => {
      routes.push([options.internal, options.timeoutMs]);
      if (routes.length === 1) throw Object.assign(new Error("request timed out"), { status: -1, code: "ConnectionTimeoutError" });
      return image;
    } });
  assert.equal(result.buffer.length, 5);
  assert.deepEqual(routes, [[true, 15000], [false, 45000]]);
  assert.deepEqual(delays, [1000]);
});

test("public image transient failures retry twice and recover without changing the URL or size boundary", async () => {
  const signals = [];
  let calls = 0;
  const result = await downloadListingSourceImage(url, { ...noWait, isManaged: () => false, request: async (value, options) => {
    assert.equal(value, url);
    assert.equal(options.maxBytes, 30 * 1024 * 1024);
    signals.push(options.signal);
    calls++;
    if (calls < 3) throw Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" });
    return { ...image, ok: true, headers: { get: () => "5" } };
  } });
  assert.equal(result.buffer.length, 5);
  assert.equal(calls, 3);
  assert.equal(new Set(signals).size, 3);
});

test("404, invalid content and permission failures are not blindly retried", async () => {
  for (const response of [{ ok: false, status: 404 }, { buffer: Buffer.from("text"), contentType: "text/html" }, null]) {
    let calls = 0;
    await assert.rejects(downloadListingSourceImage(url, { ...noWait, isManaged: () => false,
      request: async () => { calls++; return response; } }), { code: "LISTING_SOURCE_IMAGE_DOWNLOAD_FAILED", attempts: 1 });
    assert.equal(calls, 1);
  }
  let calls = 0;
  const denied = Object.assign(new Error("revoked"), { status: 403 });
  await assert.rejects(downloadListingSourceImage(url, { ...noWait, isManaged: () => false,
    beforeRequest: async () => { throw denied; }, request: async () => { calls++; return image; } }), error => error === denied);
  assert.equal(calls, 0);
});

test("a partial body is retried, and exhausted failures name the source image without query secrets", async () => {
  let calls = 0;
  await assert.rejects(downloadListingSourceImage(`${url}?token=secret`, { ...noWait, isManaged: () => false,
    request: async () => { calls++; return { ...image, headers: { get: () => "10" } }; } }), error => {
    assert.equal(error.code, "LISTING_SOURCE_IMAGE_DOWNLOAD_FAILED");
    assert.equal(error.attempts, 3);
    assert.ok(error.message.includes(url));
    assert.ok(!error.message.includes("secret"));
    return true;
  });
  assert.equal(calls, 3);
  assert.equal(isTransientImageDownloadError({ status: 403, code: "RequestError" }), false);
});

test("authority revoked between retries stops before another download", async () => {
  let revoked = false, calls = 0;
  await assert.rejects(downloadListingSourceImage(url, { ...noWait, isManaged: () => false,
    beforeRequest: async () => { if (revoked) throw Object.assign(new Error("revoked"), { status: 403 }); },
    request: async () => { calls++; throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); },
    waitImpl: async () => { revoked = true; } }), { status: 403 });
  assert.equal(calls, 1);
});


test("authenticated reads cannot turn private, mutable, foreign or credential-bearing URLs into public listing images", () => {
  const env = { OSS_ENABLED: "true", OSS_REGION: "oss-cn-heyuan", OSS_BUCKET: "example-bucket", OSS_ACCESS_KEY_ID: "test-id", OSS_ACCESS_KEY_SECRET: "test-secret" };
  const host = "example-bucket.oss-cn-heyuan.aliyuncs.com";
  const key = `listing-media/aa/${"a".repeat(64)}.png`;
  assert.equal(isManagedListingSourceImage(`https://${host}/${key}`, { env }), true);
  for (const value of [`https://${host}/ai-unused/aa/${"a".repeat(64)}.png`, `https://${host}/team-attachments/private.png`,
    `https://${host}/listing-media/mutable.png`, `https://foreign.example/${key}`, `https://user:password@${host}/${key}`,
    `https://${host}:8443/${key}`, `http://${host}/${key}`]) assert.equal(isManagedListingSourceImage(value, { env }), false);
});
