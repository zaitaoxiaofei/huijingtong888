import test from "node:test";
import assert from "node:assert/strict";

import {
  downloadRemoteImageForOzon,
  isLikelyRemoteImageUrl,
  verifyRemoteImagesReadyForOzon
} from "../src/services/listing-media-readiness.js";

test("listing media readiness recognizes image URLs without treating videos as images", () => {
  assert.equal(isLikelyRemoteImageUrl("https://erp.example/uploads/listing-media/main.png"), true);
  assert.equal(isLikelyRemoteImageUrl("https://erp.example/uploads/listing-media/main.JPG?v=1"), true);
  assert.equal(isLikelyRemoteImageUrl("https://erp.example/uploads/listing-media/demo.mp4"), false);
});

test("full image download rejects a truncated response body", async () => {
  const result = await downloadRemoteImageForOzon("https://erp.example/main.png", {
    fetchImpl: async () => new Response(new Uint8Array(10), {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": "20"
      }
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "incomplete_body");
  assert.equal(result.downloadedBytes, 10);
});

test("image readiness retries and requires two consecutive complete downloads", async () => {
  let calls = 0;
  const payload = new Uint8Array(2048);
  const result = await verifyRemoteImagesReadyForOzon(["https://erp.example/main.png"], {
    attempts: 3,
    requiredConsecutiveSuccesses: 2,
    retryDelayMs: 0,
    waitImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response("unavailable", { status: 503 });
      return new Response(payload, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(payload.byteLength)
        }
      });
    }
  });

  assert.equal(calls, 3);
  assert.equal(result.ok, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].consecutiveSuccesses, 2);
});

test("image readiness reports URLs that never become fully downloadable", async () => {
  const url = "https://erp.example/broken.png";
  const result = await verifyRemoteImagesReadyForOzon([url], {
    attempts: 3,
    requiredConsecutiveSuccesses: 2,
    retryDelayMs: 0,
    waitImpl: async () => {},
    fetchImpl: async () => new Response("error", { status: 502 })
  });

  assert.equal(result.ok, 0);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failedUrls, [url]);
  assert.equal(result.results[0].attempts, 3);
});

test("all shops share the full-download connection limit", async () => {
  let active = 0, peak = 0;
  const fetchImpl = async () => {
    active++;
    peak = Math.max(peak, active);
    return { ok: true, status: 200, headers: new Headers({ "content-type": "image/png", "content-length": "1" }),
      arrayBuffer: async () => { await new Promise(resolve => setTimeout(resolve, 5)); active--; return new Uint8Array(1); } };
  };
  const shops = await Promise.all(Array.from({ length: 6 }, (_, index) => verifyRemoteImagesReadyForOzon([`https://example.com/shop-${index}.png`], {
    attempts: 2, requiredConsecutiveSuccesses: 2, retryDelayMs: 0, waitImpl: async () => {}, fetchImpl
  })));
  assert.equal(peak, 2);
  assert.ok(shops.every(shop => shop.ok === 1));
});

let fixtureNumber = 0;
function publicImageFixture() {
  const bucket = `readiness-fixture-${++fixtureNumber}`;
  let clock = 1_000_000, calls = 0;
  const env = { OSS_ENABLED: "true", OSS_REGION: "oss-cn-heyuan", OSS_BUCKET: bucket,
    OSS_ACCESS_KEY_ID: "fixture", OSS_ACCESS_KEY_SECRET: "fixture" };
  const origin = `https://${bucket}.oss-cn-heyuan.aliyuncs.com`;
  const url = (index = 0, prefix = "listing-media") => {
    const hash = index.toString(16).padStart(64, "0");
    return `${origin}/${prefix}/${hash.slice(0, 2)}/${hash}.jpg`;
  };
  const response = (responseUrl = url()) => Object.defineProperty(new Response(new Uint8Array(16), { status: 200,
    headers: { "content-type": "image/jpeg", "content-length": "16" } }), "url", { value: responseUrl });
  const options = { env, now: () => clock, attempts: 3, requiredConsecutiveSuccesses: 2,
    retryDelayMs: 0, waitImpl: async () => {}, fetchImpl: async (_url, request) => {
      calls++;
      assert.equal(request.method, "GET");
      assert.equal(request.headers.Range, undefined);
      return response(_url);
    } };
  return { url, options, response, origin, calls: () => calls, advance: ms => { clock += ms; } };
}

test("immutable public OSS images reuse two complete checks until the fixed five minute expiry", async () => {
  const fixture = publicImageFixture(), url = fixture.url();
  const first = await verifyRemoteImagesReadyForOzon([url], fixture.options);
  assert.equal(first.ok, 1); assert.equal(first.results[0].consecutiveSuccesses, 2);
  assert.equal(fixture.calls(), 2);
  first.results[0].ok = false;
  first.results[0].downloadedBytes = 0;
  fixture.advance(299999);
  const cached = await verifyRemoteImagesReadyForOzon([url], fixture.options);
  assert.equal(cached.ok, 1); assert.equal(cached.results[0].downloadedBytes, 16);
  assert.equal(fixture.calls(), 2, "reads do not extend the original verification expiry");
  fixture.advance(1);
  assert.equal((await verifyRemoteImagesReadyForOzon([url], fixture.options)).ok, 1);
  assert.equal(fixture.calls(), 4);
});

test("a different complete-download policy performs its own verification", async () => {
  const fixture = publicImageFixture(), url = fixture.url();
  await verifyRemoteImagesReadyForOzon([url], fixture.options);
  const stricter = await verifyRemoteImagesReadyForOzon([url], { ...fixture.options, requiredConsecutiveSuccesses: 3 });
  assert.equal(stricter.results[0].consecutiveSuccesses, 3);
  assert.equal(fixture.calls(), 5);
});

test("cached public-read evidence still requires each current caller's permission", async () => {
  const fixture = publicImageFixture(), url = fixture.url();
  await verifyRemoteImagesReadyForOzon([url], fixture.options);
  let checks = 0;
  const allowed = await verifyRemoteImagesReadyForOzon([url], { ...fixture.options, beforeRequest: async () => { checks++; } });
  assert.equal(allowed.ok, 1); assert.equal(checks, 2);
  const denied = await verifyRemoteImagesReadyForOzon([url], { ...fixture.options,
    beforeRequest: async () => { throw new Error("fixture member revoked"); } });
  assert.equal(denied.failed, 1); assert.match(denied.results[0].error, /revoked/);
  assert.equal(fixture.calls(), 2);
});

for (const revoked of [false, true]) test(`concurrent public checks share a whole verification while the joining caller is ${revoked ? "revoked" : "authorized"}`, async () => {
  const fixture = publicImageFixture(), url = fixture.url();
  let release, started, leaderCalls = 0, joinerCalls = 0, joinerChecks = 0, joinerActive = true;
  const gate = new Promise(resolve => { release = resolve; });
  const firstRequest = new Promise(resolve => { started = resolve; });
  const first = verifyRemoteImagesReadyForOzon([url], { ...fixture.options, beforeRequest: async () => {}, fetchImpl: async () => {
    leaderCalls++;
    if (leaderCalls === 1) { started(); await gate; }
    return fixture.response();
  } });
  await firstRequest;
  const second = verifyRemoteImagesReadyForOzon([url], { ...fixture.options,
    beforeRequest: async () => { joinerChecks++; if (!joinerActive) throw new Error("fixture joining member revoked"); },
    fetchImpl: async () => { joinerCalls++; return fixture.response(); } });
  await new Promise(resolve => setImmediate(resolve));
  if (revoked) joinerActive = false;
  release();
  const [leader, joiner] = await Promise.all([first, second]);
  assert.equal(leader.ok, 1); assert.equal(joiner.ok, revoked ? 0 : 1);
  if (revoked) assert.match(joiner.results[0].error, /revoked/);
  assert.equal(joinerChecks, 2); assert.equal(leaderCalls, 2); assert.equal(joinerCalls, 0);
});

test("revocation during the leader's download cannot authorize or cache a successful result", async () => {
  const fixture = publicImageFixture(), url = fixture.url();
  let active = true, requests = 0;
  const result = await verifyRemoteImagesReadyForOzon([url], { ...fixture.options,
    beforeRequest: async () => { if (!active) throw new Error("fixture leader revoked"); },
    fetchImpl: async () => { requests++; active = false; return fixture.response(); } });
  assert.equal(result.failed, 1); assert.equal(requests, 1);
  assert.equal((await verifyRemoteImagesReadyForOzon([url], fixture.options)).ok, 1);
  assert.equal(fixture.calls(), 2, "the later authorized caller performs both complete checks");
});

test("failed and truncated public responses are not retained and retry on the next submission", async () => {
  for (const truncated of [false, true]) {
    const fixture = publicImageFixture(), url = fixture.url();
    let calls = 0, healthy = false;
    const options = { ...fixture.options, fetchImpl: async () => {
      calls++;
      if (healthy) return fixture.response();
      return truncated ? new Response(new Uint8Array(8), { status: 200, headers: { "content-type": "image/jpeg", "content-length": "16" } })
        : new Response("unavailable", { status: 503 });
    } };
    const failed = await verifyRemoteImagesReadyForOzon([url], options);
    assert.equal(failed.failed, 1); assert.equal(calls, 3);
    healthy = true;
    assert.equal((await verifyRemoteImagesReadyForOzon([url], options)).ok, 1);
    assert.equal(calls, 5);
    await verifyRemoteImagesReadyForOzon([url], options);
    assert.equal(calls, 5);
  }
});

test("external, mutable, private, signed and transformed images do not share public-read evidence", async () => {
  const fixture = publicImageFixture();
  const urls = [fixture.url().replace(fixture.origin, "https://external.example"),
    `${fixture.origin}/listing-media/mutable.jpg`, fixture.url(0, "ai-task-media"),
    `${fixture.url()}?signature=fixture`, `${fixture.url()}?x-oss-process=image/resize,w_180`,
    `${fixture.url()}#fragment`, fixture.url().replace("https:", "http:"),
    fixture.url().replace(".aliyuncs.com/", ".aliyuncs.com:444/")];
  for (const url of urls) {
    const before = fixture.calls();
    await Promise.all([verifyRemoteImagesReadyForOzon([url], fixture.options), verifyRemoteImagesReadyForOzon([url], fixture.options)]);
    await verifyRemoteImagesReadyForOzon([url], fixture.options);
    assert.equal(fixture.calls() - before, 6, url);
  }
});

test("a complete public response redirected away from the immutable URL is never cached", async () => {
  const fixture = publicImageFixture(), url = fixture.url();
  let calls = 0;
  const options = { ...fixture.options, fetchImpl: async () => {
    calls++;
    return fixture.response("https://external.example/mutable.jpg");
  } };
  assert.equal((await verifyRemoteImagesReadyForOzon([url], options)).ok, 1);
  assert.equal((await verifyRemoteImagesReadyForOzon([url], options)).ok, 1);
  assert.equal(calls, 4);
});

test("the bounded public verification cache evicts the least recently used URL", async () => {
  const fixture = publicImageFixture();
  for (let index = 0; index < 500; index++) await verifyRemoteImagesReadyForOzon([fixture.url(index)], fixture.options);
  assert.equal(fixture.calls(), 1000);
  await verifyRemoteImagesReadyForOzon([fixture.url(0)], fixture.options);
  await verifyRemoteImagesReadyForOzon([fixture.url(500)], fixture.options);
  await verifyRemoteImagesReadyForOzon([fixture.url(0)], fixture.options);
  assert.equal(fixture.calls(), 1002);
  await verifyRemoteImagesReadyForOzon([fixture.url(1)], fixture.options);
  assert.equal(fixture.calls(), 1004);
});
