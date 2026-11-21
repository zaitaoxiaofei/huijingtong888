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

test("internal timeouts retry through the same internal OSS route with fresh bounded attempts", async () => {
  const routes = [], delays = [], retries = [];
  const result = await downloadListingSourceImage(url, { ...noWait, internal: true, isManaged: () => true,
    onRetry: event => retries.push(event),
    waitImpl: async ms => delays.push(ms), readManaged: async (_url, options) => {
      routes.push([options.internal, options.timeoutMs]);
      assert.equal(options.maxBytes, 30 * 1024 * 1024);
      if (routes.length < 3) throw Object.assign(new Error("request timed out"), { status: -1, code: "ConnectionTimeoutError" });
      return image;
    }, request: async () => assert.fail("Internal OSS failure must not fall back to a public URL request") });
  assert.equal(result.buffer.length, 5);
  assert.deepEqual(routes, [[true, 15000], [true, 45000], [true, 45000]]);
  assert.deepEqual(delays, [1000, 2000]);
  assert.deepEqual(retries.map(event => event.route), ["oss_internal", "oss_internal"]);
});

test("exhausted internal failures report the error without making a public attempt", async () => {
  const routes = [];
  await assert.rejects(downloadListingSourceImage(url, { ...noWait, internal: true, isManaged: () => true,
    readManaged: async (_url, options) => { routes.push(options.internal); throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); },
    request: async () => assert.fail("No public fallback is authorized")
  }), { code: "LISTING_SOURCE_IMAGE_DOWNLOAD_FAILED", attempts: 3 });
  assert.deepEqual(routes, [true, true, true]);
});

test("unconfigured local environments retain public OSS reads and configured environments use the shared internal policy", async () => {
  const previous = process.env.OSS_INTERNAL_READ;
  try {
    for (const [configured, expected] of [[undefined, false], ["false", false], ["1", true], [" TRUE ", true]]) {
      if (configured === undefined) delete process.env.OSS_INTERNAL_READ;
      else process.env.OSS_INTERNAL_READ = configured;
      const routes = [], retries = [];
      await downloadListingSourceImage(url, { ...noWait, isManaged: () => true,
        onRetry: event => retries.push(event.route),
        readManaged: async (_url, options) => {
          routes.push(options.internal);
          if (routes.length === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
          return image;
        } });
      assert.deepEqual(routes, [expected, expected]);
      assert.deepEqual(retries, [expected ? "oss_internal" : "oss_public"]);
    }
  } finally {
    if (previous === undefined) delete process.env.OSS_INTERNAL_READ;
    else process.env.OSS_INTERNAL_READ = previous;
  }
});

test("internal response completion rechecks authority before returning downloaded image bytes", async () => {
  let revoked = false, calls = 0;
  const denied = Object.assign(new Error("revoked"), { status: 403 });
  await assert.rejects(downloadListingSourceImage(url, { ...noWait, internal: true, isManaged: () => true,
    beforeRequest: async () => { if (revoked) throw denied; },
    readManaged: async () => { calls++; revoked = true; return image; }
  }), error => error === denied);
  assert.equal(calls, 1);
});

test("public image transient failures retry twice and recover without changing the URL or size boundary", async () => {
  const signals = [];
  let calls = 0;
  const result = await downloadListingSourceImage(url, { ...noWait, internal: true, isManaged: () => false,
    readManaged: async () => assert.fail("External images must retain the public request boundary"), request: async (value, options) => {
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

test("cancellation during the retry delay stops both managed and public readers", async () => {
  for (const managed of [true, false]) {
    const controller = new AbortController();
    const cancelled = new Error("operation cancelled");
    let calls = 0;
    const fail = async () => { calls++; throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); };
    await assert.rejects(downloadListingSourceImage(url, { ...noWait, internal: true, isManaged: () => managed,
      beforeRequest: async () => controller.signal.throwIfAborted(), readManaged: fail, request: fail,
      waitImpl: async () => controller.abort(cancelled) }), error => error === cancelled);
    assert.equal(calls, 1);
  }
});


test("authenticated reads cover known public image namespaces without granting private or legacy paths SDK credentials", () => {
  const env = { OSS_ENABLED: "true", OSS_REGION: "oss-cn-heyuan", OSS_BUCKET: "example-bucket", OSS_ACCESS_KEY_ID: "test-id", OSS_ACCESS_KEY_SECRET: "test-secret" };
  const host = "example-bucket.oss-cn-heyuan.aliyuncs.com";
  const key = `listing-media/aa/${"a".repeat(64)}.png`;
  for (const prefix of ["listing-media", "product-media", "collector-media", "ai-unused", "video-source"]) {
    assert.equal(isManagedListingSourceImage(`https://${host}/${prefix}/aa/${"a".repeat(64)}.png`, { env }), true);
  }
  for (const value of [`https://${host}/ai-task-media/aa/${"a".repeat(64)}.png`, `https://${host}/team-attachments/private.png`,
    `https://${host}/listing-media/mutable.png`, `https://foreign.example/${key}`, `https://user:password@${host}/${key}`,
    `https://${host}:8443/${key}`, `http://${host}/${key}`, `https://${host}/${key}?Signature=original`,
    `https://${host}/${key}?x-oss-process=image/resize,w_100`]) assert.equal(isManagedListingSourceImage(value, { env }), false);
});

test("listing downloads route all canonical public image namespaces internally and preserve legacy query semantics", async () => {
  const env = { OSS_ENABLED: "true", OSS_REGION: "oss-cn-heyuan", OSS_BUCKET: "example-bucket", OSS_ACCESS_KEY_ID: "test-id", OSS_ACCESS_KEY_SECRET: "test-secret" };
  const base = "https://example-bucket.oss-cn-heyuan.aliyuncs.com";
  const classify = value => isManagedListingSourceImage(value, { env });
  for (const prefix of ["listing-media", "product-media", "collector-media", "ai-unused", "video-source"]) {
    const value = `${base}/${prefix}/aa/${"a".repeat(64)}.png`;
    const result = await downloadListingSourceImage(value, { ...noWait, internal: true, isManaged: classify,
      readManaged: async (received, options) => { assert.equal(received, value); assert.equal(options.internal, true); return image; },
      request: async () => assert.fail("Canonical public media should use internal OSS") });
    assert.equal(result.buffer, image.buffer);
  }
  for (const value of [`${base}/listing-media/legacy.png`, `${base}/listing-media/aa/${"a".repeat(64)}.png?Signature=original`,
    `${base}/listing-media/aa/${"a".repeat(64)}.png?x-oss-process=image/resize,w_100`]) {
    const result = await downloadListingSourceImage(value, { ...noWait, internal: true, isManaged: classify,
      readManaged: async () => assert.fail("The authenticated SDK must not discard public query behavior"),
      request: async received => { assert.equal(received, value); return image; } });
    assert.equal(result.buffer, image.buffer);
  }
});
