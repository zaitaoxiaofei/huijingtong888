import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { requestServerImage } from "../src/services/server-image-request.js";

const image = { buffer: Buffer.from("image"), contentType: "image/png" };
const ownUrl = (prefix = "listing-media") => `https://bucket.example/${prefix}/aa/${"a".repeat(64)}.png`;

test("server image reads use the managed SDK for public content-addressed images with caller bounds", async () => {
  for (const prefix of ["listing-media", "product-media", "collector-media", "ai-unused", "video-source"]) {
    const calls = [], controller = new AbortController();
    let checks = 0;
    const result = await requestServerImage(ownUrl(prefix), { maxBytes: 1024, timeoutMs: 17000, signal: controller.signal,
      beforeRequest: async () => { checks++; } }, {
      isManaged: () => true,
      readManaged: async (url, options) => { calls.push([url, options]); return image; },
      request: async () => assert.fail("Managed image reads must not use public HTTP")
    });
    assert.equal(result, image);
    assert.deepEqual(calls, [[ownUrl(prefix), { maxBytes: 1024, timeoutMs: 17000 }]]);
    assert.equal(checks, 2);
  }
});

test("a managed SDK error is returned without public fallback", async () => {
  const failure = Object.assign(new Error("internal connection timeout"), { code: "ETIMEDOUT" });
  await assert.rejects(requestServerImage(ownUrl(), {}, { isManaged: () => true,
    readManaged: async () => { throw failure; }, request: async () => assert.fail("No public fallback") }), error => error === failure);
});

test("legacy, signed and transformed public own-bucket images retain unauthenticated URL behavior", async () => {
  for (const url of ["https://bucket.example/listing-media/mutable.png", "https://bucket.example/historical/source.png",
    `${ownUrl()}?Expires=123&Signature=original`, `${ownUrl()}?x-oss-process=image/resize,w_100`]) {
    const options = { maxBytes: 1024, signal: new AbortController().signal };
    const result = await requestServerImage(url, options, { isManaged: () => true,
      readManaged: async () => assert.fail("Noncanonical image URLs must not gain SDK credentials or lose URL query semantics"),
      request: async (value, received) => { assert.equal(value, url); assert.equal(received, options); return image; } });
    assert.equal(result, image);
  }
});

test("private own-bucket images cannot bypass an unauthenticated HTTP denial through SDK credentials", async () => {
  for (const prefix of ["ai-task-media", "team-attachments", "database-archives"]) {
    let publicReads = 0;
    const result = await requestServerImage(ownUrl(prefix), {}, { isManaged: () => true,
      readManaged: async () => assert.fail("Private images require an owner route"),
      request: async () => { publicReads++; return null; } });
    assert.equal(result, null);
    assert.equal(publicReads, 1);
    const denied = Object.assign(new Error("HTTP 403"), { statusCode: 403 });
    await assert.rejects(requestServerImage(ownUrl(prefix), {}, { isManaged: () => true,
      readManaged: async () => assert.fail("An HTTP denial cannot authorize SDK access"),
      request: async () => { throw denied; } }), error => error === denied);
  }
});

test("credential-bearing and alternate-port own-bucket URLs retain the public reader safety rejection", async () => {
  for (const url of [ownUrl().replace("https://", "https://user:password@"), ownUrl().replace("bucket.example", "bucket.example:8443")]) {
    const denied = new Error("Image URL must use a public HTTP service");
    await assert.rejects(requestServerImage(url, {}, { isManaged: () => true,
      readManaged: async () => assert.fail("These URLs must not gain SDK credentials"), request: async () => { throw denied; } }), error => error === denied);
  }
});

test("external requests retain their complete public DNS, redirect and timeout options", async () => {
  const options = { signal: new AbortController().signal, maxBytes: 2345, headers: { Referer: "https://www.ozon.ru/" }, redirects: 2 };
  const result = await requestServerImage("https://outside.example/source.png", options, {
    isManaged: () => false, readManaged: async () => assert.fail("No SDK for an external host"),
    request: async (url, received) => { assert.equal(url, "https://outside.example/source.png"); assert.equal(received, options); return image; }
  });
  assert.equal(result, image);
});

test("abort and revoked authority are checked before access and after a managed response", async () => {
  const controller = new AbortController(), cancelled = new Error("cancelled");
  controller.abort(cancelled);
  await assert.rejects(requestServerImage(ownUrl(), { signal: controller.signal }, {
    isManaged: () => true, readManaged: async () => assert.fail("Cancelled before read")
  }), error => error === cancelled);
  const second = new AbortController();
  await assert.rejects(requestServerImage(ownUrl(), { signal: second.signal }, {
    isManaged: () => true, readManaged: async () => { second.abort(cancelled); return image; }
  }), error => error === cancelled);
  let revoked = false;
  const denied = Object.assign(new Error("permission revoked"), { statusCode: 403 });
  await assert.rejects(requestServerImage(ownUrl(), { beforeRequest: async () => { if (revoked) throw denied; } }, {
    isManaged: () => true, readManaged: async () => { revoked = true; return image; }
  }), error => error === denied);
});

test("managed content still needs a nonempty image body within the configured bound", async () => {
  for (const response of [null, { ...image, buffer: Buffer.alloc(0) }, { ...image, buffer: Buffer.alloc(11) }, { ...image, contentType: "text/html" }]) {
    assert.equal(await requestServerImage(ownUrl(), { maxBytes: 10 }, { isManaged: () => true, readManaged: async () => response,
      request: async () => assert.fail("Bad managed content must not trigger public fallback") }), null);
  }
  for (const message of ["OSS object exceeds 10 bytes", "OSS object is empty"]) {
    assert.equal(await requestServerImage(ownUrl(), { maxBytes: 10 }, { isManaged: () => true,
      readManaged: async () => { throw new Error(message); }, request: async () => assert.fail("No fallback for rejected managed bodies") }), null);
  }
});

function actualFunction(file, name) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const found = source.match(new RegExp(`^(?:export )?async function ${name}\\([^]*?^}`, "m"));
  assert.ok(found, name);
  return found[0].replace(/^export /, "");
}

test("video source validation keeps its existing error when the server reader rejects image bytes", async () => {
  const context = vm.createContext({ AbortSignal, Error, withMediaCacheLease: action => action(), assertAssetExecutionAccess: async () => {},
    requestServerImage: async () => null });
  vm.runInContext(actualFunction("../src/services/asset-variant-engine.js", "fetchImageBuffer"), context);
  await assert.rejects(context.fetchImageBuffer(ownUrl()), { code: "REMOTE_IMAGE_UNAVAILABLE", statusCode: 400 });
});

test("AI references, video inputs and optimizer composition execute the shared managed reader", async () => {
  const cases = [
    ["../src/server/services/ai/aiWorkflowService.js", "fetchSourceImageResponse", async result => assert.equal(await result.text(), "image")],
    ["../src/services/asset-variant-engine.js", "fetchImageBuffer", async result => assert.deepEqual(result, image.buffer)],
    ["../src/services/ai-variant-lab.js", "fetchImageAsDataUrl", async result => assert.equal(result, `data:image/png;base64,${image.buffer.toString("base64")}`)]
  ];
  for (const [file, name, verify] of cases) {
    let managedReads = 0;
    const context = vm.createContext({ Buffer, Response, AbortSignal, URL, Error,
      withMediaCacheLease: action => action(), assertAssetExecutionAccess: async () => {},
      AI_SOURCE_IMAGE_FETCH_TIMEOUT_MS: 20000, sourceImageFetchHeaders: () => ({ Accept: "image/*" }),
      statusError: (message, status) => Object.assign(new Error(message), { status }),
      requestServerImage: (url, options) => requestServerImage(url, options, { isManaged: () => true,
        readManaged: async (value, limits) => {
          assert.equal(value, ownUrl());
          assert.equal(limits.maxBytes, 20 * 1024 * 1024);
          assert.equal(limits.timeoutMs, 20000);
          managedReads++;
          return image;
        }, request: async () => assert.fail("These actual callers must not fetch the own-bucket public URL") })
    });
    vm.runInContext(actualFunction(file, name), context);
    await verify(await context[name](ownUrl()));
    assert.equal(managedReads, 1, name);
  }
});
