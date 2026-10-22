import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";
import { isLikelyRemoteImageUrl, verifyRemoteImagesReadyForOzon } from "../src/services/listing-media-readiness.js";

const readerSource = readFileSync(new URL("../src/http/public-image-request.js", import.meta.url), "utf8")
  .replace(/^import[^;]*;\r?\n/gm, "").replaceAll("export ", "");

// Exercise the actual URL parser, DNS checks, pinned lookup, redirects and
// stream bounds. No real DNS, listener, socket, HTTP or external media is used.
function networkFixture({ responses = [], resolve } = {}) {
  const network = [], lookups = [], streams = [];
  const dns = resolve || (async () => [{ address: "8.8.8.8", family: 4 }]);
  class ResponseStream extends Readable {
    constructor(spec) {
      super(); this.statusCode = spec.status ?? 200;
      this.on("error", () => {});
      this.headers = { "content-type": "video/mp4", ...(spec.headers || {}) };
      this.spec = spec; this.parts = [...(spec.chunks || [Buffer.from("fixture-media")])];
      this.bodyReads = 0; this.bodyBytes = 0;
    }
    _read() {
      this.bodyReads++;
      if (this.spec.forbidBody) { this.destroy(new Error("HEAD must never read a response body")); return; }
      const chunk = this.parts.shift();
      if (!chunk) { this.push(null); return; }
      this.bodyBytes += chunk.length; this.push(chunk);
    }
  }
  const request = (value, options, callback) => {
    const url = new URL(value);
    const entry = { url: url.href, method: options.method || "GET", headers: options.headers, options, pins: [] };
    network.push(entry);
    const req = new EventEmitter(); let dispatched = false;
    req.destroy = error => { if (error) queueMicrotask(() => req.emit("error", error)); return req; };
    req.setTimeout = () => req;
    req.end = () => {
      if (dispatched) return req;
      dispatched = true;
      queueMicrotask(async () => {
        try {
          for (const all of [false, true]) await new Promise((done, fail) => options.lookup(url.hostname, { all }, (error, address, family) => {
            if (error) return fail(error);
            entry.pins.push(all ? address.map(row => row.address) : [address, family]); done();
          }));
          if (options.signal?.aborted) { req.destroy(options.signal.reason); return; }
          const spec = responses[network.indexOf(entry)] || {};
          if (spec.beforeResponse) await spec.beforeResponse();
          if (spec.hang) return;
          const response = new ResponseStream(spec); streams.push(response);
          await callback(response);
        } catch (error) { req.destroy(error); }
      });
      return req;
    };
    if (options.signal) options.signal.addEventListener("abort", () => req.destroy(options.signal.reason), { once: true });
    return req;
  };
  const transport = { request, get: (...args) => request(...args).end() };
  const context = vm.createContext({ Buffer, URL, AbortSignal, http: transport, https: transport, isIP,
    lookup: async (host, options) => { lookups.push({ host, options }); return dns(host, options); } });
  vm.runInContext(readerSource, context);
  assert.equal(typeof context.requestPublicMedia, "function", "The shared bounded media reader must be implemented");
  return { context, network, lookups, streams };
}

const mediaOptions = extra => ({ maxBytes: 1024, signal: AbortSignal.timeout(1000), ...extra });
const url = "https://media.example/video.mp4";

test("public listing reader rejects private, metadata, alternate numeric and mapped addresses before connecting", async () => {
  for (const value of ["http://127.0.0.1/a", "http://2130706433/a", "http://0177.0.0.1/a", "http://10.0.0.1/a", "http://172.16.0.1/a",
    "http://192.168.0.1/a", "http://169.254.169.254/latest/meta-data/", "http://100.64.0.1/a", "http://[::1]/a", "http://[::ffff:127.0.0.1]/a", "http://[fd00:ec2::254]/a"]) {
    const fixture = networkFixture();
    await assert.rejects(fixture.context.requestPublicMedia(value, mediaOptions()), undefined, value);
    assert.equal(fixture.network.length, 0, value);
  }
});

test("public media rejects unsafe URL schemes, credentials, ports, and mixed private DNS answers", async () => {
  for (const value of ["file:///private/video.mp4", "https://user:pass@media.example/a", "http://media.example:3000/a"]) {
    const fixture = networkFixture();
    await assert.rejects(fixture.context.requestPublicMedia(value, mediaOptions()));
    assert.equal(fixture.network.length, 0);
  }
  const fixture = networkFixture({ resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }] });
  await assert.rejects(fixture.context.requestPublicMedia(url, mediaOptions()));
  assert.equal(fixture.network.length, 0);
});

test("validated DNS is pinned to both actual socket lookup forms and cannot rebind", async () => {
  let resolutions = 0;
  const fixture = networkFixture({ resolve: async () => [{ address: ++resolutions === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }] });
  const response = await fixture.context.requestPublicMedia(url, mediaOptions());
  assert.equal(response.buffer.toString(), "fixture-media");
  assert.equal(fixture.lookups.length, 1);
  assert.equal(resolutions, 1, "The HTTP transport must use the checked address instead of performing a second DNS resolution");
  assert.equal(fixture.network[0].options.agent, false);
  assert.deepEqual(fixture.network[0].pins.map(row => Array.from(row)), [["8.8.8.8", 4], ["8.8.8.8"]]);
});

test("public video MIME is supported while the existing image-only API still rejects video", async () => {
  const video = networkFixture();
  const response = await video.context.requestPublicMedia(url, mediaOptions());
  assert.equal(response.ok, true); assert.equal(response.status, 200);
  assert.equal(response.contentType, "video/mp4"); assert.ok(response.buffer.length);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  const image = networkFixture();
  assert.equal(await image.context.requestPublicImage(url, mediaOptions()), null);
});

test("HEAD probes preserve video headers without consuming or buffering a huge body", async () => {
  const fixture = networkFixture({ responses: [{ forbidBody: true, headers: { "content-length": "10737418240", "cache-control": "public,max-age=10" } }] });
  const response = await fixture.context.requestPublicMedia(url, mediaOptions({ method: "HEAD" }));
  assert.equal(response.ok, true); assert.equal(response.status, 200);
  assert.equal(fixture.network[0].method, "HEAD");
  assert.equal(fixture.streams[0].bodyReads, 0); assert.equal(fixture.streams[0].bodyBytes, 0);
  assert.equal(response.buffer?.length || 0, 0);
  assert.equal(response.headers.get("content-length"), "10737418240");
});

test("full media GET rejects advertised oversize bodies before allocation", async () => {
  const fixture = networkFixture({ responses: [{ forbidBody: true, headers: { "content-length": "4096" } }] });
  const response = await fixture.context.requestPublicMedia(url, mediaOptions());
  assert.equal(response, null); assert.equal(fixture.streams[0].bodyReads, 0);
  assert.equal(fixture.streams[0].destroyed, true);
});

test("full media GET rejects an oversized chunked stream rather than returning a partial upload", async () => {
  const fixture = networkFixture({ responses: [{ chunks: [Buffer.alloc(600), Buffer.alloc(600), Buffer.alloc(600)] }] });
  const response = await fixture.context.requestPublicMedia(url, mediaOptions());
  assert.equal(response, null); assert.equal(fixture.streams[0].destroyed, true);
});

test("Range probes remain bounded when a public video server ignores Range", async () => {
  const fixture = networkFixture({ responses: [{ headers: { "content-length": "10737418240" }, chunks: [Buffer.alloc(2048), Buffer.alloc(2048)] }] });
  const response = await fixture.context.requestPublicMedia(url, mediaOptions({ headers: { Range: "bytes=0-1023" }, allowPartialBody: true }));
  assert.equal(response.ok, true); assert.equal(response.status, 200);
  assert.equal(response.buffer.length, 1024); assert.equal(response.truncated, true);
  assert.equal(fixture.streams[0].destroyed, true);
  assert.equal(fixture.network[0].headers.Range, "bytes=0-1023");
});

test("public redirects revalidate DNS and reject a private or metadata destination", async () => {
  for (const location of ["http://127.0.0.1/private", "http://169.254.169.254/latest/meta-data/"]) {
    const fixture = networkFixture({ responses: [{ status: 302, headers: { location } }] });
    await assert.rejects(fixture.context.requestPublicMedia(url, mediaOptions()));
    assert.equal(fixture.network.length, 1);
  }
  const fixture = networkFixture({ resolve: async host => [{ address: host === "media.example" ? "8.8.8.8" : "10.0.0.1", family: 4 }],
    responses: [{ status: 307, headers: { location: "https://redirect.example/video.mp4" } }] });
  await assert.rejects(fixture.context.requestPublicMedia(url, mediaOptions()));
  assert.equal(fixture.network.length, 1);
});

test("same-host redirects cannot use a public first answer followed by a private answer", async () => {
  let resolutions = 0;
  const fixture = networkFixture({ resolve: async () => [{ address: ++resolutions === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }],
    responses: [{ status: 302, headers: { location: "/redirected-video.mp4" } }] });
  await assert.rejects(fixture.context.requestPublicMedia(url, mediaOptions()));
  assert.equal(resolutions, 2); assert.equal(fixture.network.length, 1);
});

test("public redirects preserve HEAD/Range limits and have a finite redirect budget", async () => {
  const fixture = networkFixture({ responses: [{ status: 302, headers: { location: "/next" } }, { forbidBody: true }] });
  const result = await fixture.context.requestPublicMedia(url, mediaOptions({ method: "HEAD", headers: { Range: "bytes=0-1023" } }));
  assert.equal(result.ok, true);
  assert.deepEqual(fixture.network.map(row => row.method), ["HEAD", "HEAD"]);
  assert.ok(fixture.network.every(row => row.headers.Range === "bytes=0-1023"));
  const loop = networkFixture({ responses: Array.from({ length: 3 }, () => ({ status: 302, headers: { location: "/again" } })) });
  await assert.rejects(loop.context.requestPublicMedia(url, mediaOptions({ redirects: 1 })), /redirect/i);
  assert.equal(loop.network.length, 2);
});

for (const tenant of ["default", "A", "B"]) {
  test(`${tenant} execution checks its own actor before DNS and before every pinned connection`, async () => {
    const fixture = networkFixture({ responses: [{ status: 302, headers: { location: "/final" } }, {}] });
    const contexts = [];
    const result = await fixture.context.requestPublicMedia(url, mediaOptions({ beforeRequest: async () => contexts.push({ tenant, person: 7 }) }));
    assert.equal(result.ok, true); assert.equal(fixture.network.length, 2);
    assert.equal(contexts.length, 4);
    assert.ok(contexts.every(row => row.tenant === tenant && row.person === 7));
  });
}

test("revoked actor prevents DNS, connection after DNS, and a redirect's next request", async () => {
  const denied = () => { throw Object.assign(new Error("fixture authority revoked"), { statusCode: 403 }); };
  const initial = networkFixture();
  await assert.rejects(initial.context.requestPublicMedia(url, mediaOptions({ beforeRequest: denied })), /revoked/);
  assert.equal(initial.lookups.length, 0); assert.equal(initial.network.length, 0);
  let checks = 0;
  const duringDns = networkFixture();
  await assert.rejects(duringDns.context.requestPublicMedia(url, mediaOptions({ beforeRequest: async () => { if (++checks === 2) denied(); } })), /revoked/);
  assert.equal(duringDns.lookups.length, 1); assert.equal(duringDns.network.length, 0);
  const redirect = networkFixture({ responses: [{ status: 302, headers: { location: "/next" } }] });
  checks = 0;
  await assert.rejects(redirect.context.requestPublicMedia(url, mediaOptions({ beforeRequest: async () => { if (++checks === 3) denied(); } })), /revoked/);
  assert.equal(redirect.lookups.length, 1); assert.equal(redirect.network.length, 1);
});

test("an abort deadline rejects a stalled pinned request", async () => {
  const fixture = networkFixture({ responses: [{ hang: true }] });
  const controller = new AbortController();
  const pending = fixture.context.requestPublicMedia(url, mediaOptions({ signal: controller.signal }));
  setImmediate(() => controller.abort(new Error("fixture media deadline")));
  await assert.rejects(pending, /deadline/);
  assert.equal(fixture.network.length, 1);
});

// The caller-level tests below load individual real listing functions. They
// must forward the actor guard through HEAD, Range, cache and download paths.
const listingSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const declarations = parse(listingSource, { ecmaVersion: "latest", sourceType: "module" }).body.map(node => node.declaration || node);
function listingFunction(name) {
  const node = declarations.find(node => node.type === "FunctionDeclaration" && node.id.name === name);
  assert.ok(node, "Missing listing implementation: " + name);
  return listingSource.slice(node.start, node.end);
}

function listingFixture(network, overrides = {}) {
  const context = vm.createContext({ URL, Buffer, Date, Number, String, Object, Array, Map, Set, AbortSignal, path,
    requestPublicMedia: network.context.requestPublicMedia,
    listingMediaReachabilityCache: new Map(),
    LISTING_MEDIA_REACHABILITY_CACHE_MAX_ENTRIES: 100,
    LISTING_MEDIA_REACHABILITY_CACHE_TTL_MS: 60000,
    LISTING_PUBLISH_MEDIA_PREWARM_LIMIT: 10,
    LISTING_PUBLISH_MEDIA_CHECK_CONCURRENCY: 1,
    LISTING_MEDIA_MAX_BYTES: 200 * 1024 * 1024,
    config: { listingMediaPublicBaseUrl: "https://media.example", appBaseUrl: "https://erp.example" },
    listingPublishExecutionGuards: new WeakMap(),
    currentAiTenantSession: () => null,
    authorizeBusinessTaskSession: async value => value,
    assertBusinessTaskPermission: value => { if (!value.roles.includes("operations")) throw new Error("fixture role revoked"); },
    resolveListingMediaLocalPath: () => "",
    resolveLocalAiTaskMedia: async () => null,
    resolveLocalImageCropperMedia: async () => null,
    normalizeArray: value => Array.isArray(value) ? value : [],
    isLikelyRemoteImageUrl,
    verifyRemoteImagesReadyForOzon: (urls, options) => verifyRemoteImagesReadyForOzon(urls, { ...options, waitImpl: async () => {} }),
    ...overrides });
  for (const name of ["assertListingPublishExecution", "readListingMediaBuffer", "normalizeListingMediaSourceUrl", "normalizeListingMediaSourceBaseUrl", "normalizedListingMediaSourceProtocol",
    "cacheReachableListingMedia", "inspectRemoteMediaUrlForOzon", "isReachableRemoteMediaUrl", "isListingMediaPublicUrl", "uniqueStringValues", "mapWithConcurrency", "prewarmPublishMediaUrls"]) {
    vm.runInContext(listingFunction(name), context);
  }
  return context;
}

for (const [tenant, slug] of [[1, "default"], [2, "A"], [3, "B"]]) {
  test(`listing download restores explicit ${slug} operations context before DNS and after response`, async () => {
    const network = networkFixture();
    const contexts = [];
    const session = { personId: 7, roles: ["operations"], tenant: { id: tenant, slug } };
    const listing = listingFixture(network, { authorizeBusinessTaskSession: async value => {
      contexts.push([value.tenant.id, value.personId]); return value;
    } });
    const response = await listing.readListingMediaBuffer(url, session);
    assert.equal(response.contentType, "video/mp4"); assert.equal(response.buffer.toString(), "fixture-media");
    assert.equal(response.filename, "video.mp4"); assert.equal(network.network.length, 1);
    assert.ok(contexts.length >= 4, "Initial, DNS, connection and final read must be authorized");
    assert.ok(contexts.every(row => row[0] === tenant && row[1] === 7));
  });
}

test("listing download denies unresolved private task media without making a public or loopback request", async () => {
  for (const value of ["/api/ai/file/foreign/image.png", "https://erp.example/api/ai/file/foreign/image.png", "/api/tools/image-cropper/file/foreign/image.png"]) {
    const network = networkFixture();
    const listing = listingFixture(network);
    await assert.rejects(listing.readListingMediaBuffer(value, { personId: 7, roles: ["operations"], tenant: { id: 2, slug: "A" } }), /authenticated owner/);
    assert.equal(network.network.length, 0); assert.equal(network.lookups.length, 0);
  }
});

test("listing download withholds in-flight public bytes if the member is revoked during response", async () => {
  let active = true;
  const network = networkFixture({ responses: [{ beforeResponse: async () => { active = false; } }] });
  const listing = listingFixture(network, { authorizeBusinessTaskSession: async value => {
    if (!active) throw Object.assign(new Error("fixture membership revoked"), { statusCode: 403 }); return value;
  } });
  await assert.rejects(listing.readListingMediaBuffer(url, { personId: 7, roles: ["operations"], tenant: { id: 2, slug: "A" } }), /revoked/);
  assert.equal(network.network.length, 1);
});

test("listing probes HEAD first and fall back to a bounded video Range GET on HTTP 405", async () => {
  const network = networkFixture({ responses: [{ status: 405, forbidBody: true }, { status: 206, headers: { "content-length": "999999999" }, chunks: [Buffer.alloc(2048)] }] });
  const listing = listingFixture(network); let checks = 0;
  const response = await listing.inspectRemoteMediaUrlForOzon(url, { beforeRequest: async () => { checks++; } });
  assert.equal(response.ok, true); assert.equal(response.status, 206); assert.equal(response.contentType, "video/mp4");
  assert.deepEqual(network.network.map(row => row.method), ["HEAD", "GET"]);
  assert.equal(network.network[1].headers.Range, "bytes=0-1023"); assert.equal(network.streams[0].bodyReads, 0);
  assert.ok(checks >= 7);
});

test("listing reachability cache still checks the current actor and does not cache a denied request", async () => {
  const network = networkFixture({ responses: [{ forbidBody: true }] });
  const listing = listingFixture(network); const checks = [];
  const first = await listing.inspectRemoteMediaUrlForOzon(url, { beforeRequest: async () => checks.push("A") });
  assert.equal(first.ok, true);
  const second = await listing.inspectRemoteMediaUrlForOzon(url, { beforeRequest: async () => checks.push("B") });
  assert.equal(second.ok, true); assert.equal(second.cached, true); assert.equal(checks.at(-1), "B");
  await assert.rejects(listing.inspectRemoteMediaUrlForOzon(url, { beforeRequest: async () => { throw new Error("fixture cached actor revoked"); } }), /revoked/);
  assert.equal(network.network.length, 1); assert.equal(network.lookups.length, 1);
});

test("revocation after failed HEAD stops the fallback Range request", async () => {
  let active = true;
  const network = networkFixture({ responses: [{ status: 405, beforeResponse: async () => { active = false; } }] });
  const listing = listingFixture(network);
  const result = await listing.inspectRemoteMediaUrlForOzon(url, { beforeRequest: async () => { if (!active) throw new Error("fixture probe actor revoked"); } });
  assert.equal(result.ok, false); assert.match(result.error, /revoked/);
  assert.equal(network.network.length, 1);
  assert.equal(listing.listingMediaReachabilityCache.size, 0);
});

test("prewarm keeps two complete image downloads and bounded video Range while using the safe reader", async () => {
  const network = networkFixture({ responses: [
    { headers: { "content-type": "image/jpeg", "content-length": "3" }, chunks: [Buffer.from("img")] },
    { headers: { "content-type": "image/jpeg", "content-length": "3" }, chunks: [Buffer.from("img")] },
    { headers: { "content-length": "10737418240" }, chunks: [Buffer.alloc(2048)] }
  ] });
  const listing = listingFixture(network); let checks = 0;
  const response = await listing.prewarmPublishMediaUrls(["https://media.example/uploads/listing-media/image.jpg", "https://media.example/uploads/listing-media/video.mp4"], { beforeRequest: async () => { checks++; } });
  assert.equal(response.total, 2); assert.equal(response.ok, 2); assert.equal(response.failed, 0);
  assert.equal(network.network.length, 3); assert.equal(network.lookups.length, 3);
  assert.ok(network.network.slice(0, 2).every(row => row.headers["User-Agent"] === "OzonMediaReadiness/1.0" && !row.headers.Range));
  assert.deepEqual(network.streams.slice(0, 2).map(row => row.bodyBytes), [3, 3]);
  assert.equal(network.network[2].headers.Range, "bytes=0-1023"); assert.equal(network.streams[2].destroyed, true);
  assert.ok(checks >= 9);
});

test("prewarm revocation prevents retries and the next video's network request", async () => {
  let active = true;
  const network = networkFixture({ responses: [{ headers: { "content-type": "image/jpeg" }, beforeResponse: async () => { active = false; } }] });
  const listing = listingFixture(network);
  const response = await listing.prewarmPublishMediaUrls(["https://media.example/uploads/listing-media/image.jpg", "https://media.example/uploads/listing-media/video.mp4"], {
    beforeRequest: async () => { if (!active) throw new Error("fixture prewarm actor revoked"); }
  });
  assert.equal(response.total, 2); assert.equal(response.failed, 2); assert.equal(response.ok, 0);
  assert.equal(network.network.length, 1); assert.equal(network.lookups.length, 1);
});
