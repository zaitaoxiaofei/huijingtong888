import assert from "node:assert/strict";
import test from "node:test";

import { archiveRemoteMediaObjectUrl } from "../src/services/object-storage.js";
import { compactOnlineProductRawJson, prepareOnlineProductMediaForStorage } from "../src/services/online-product-media-storage.js";

const ossEnv = {
  OSS_ENABLED: "true",
  OSS_REGION: "oss-cn-heyuan",
  OSS_BUCKET: "erp-test",
  OSS_ACCESS_KEY_ID: "test-id",
  OSS_ACCESS_KEY_SECRET: "test-secret"
};

test("remote product media is stored once by content hash", async () => {
  const puts = [];
  const storedKeys = new Set();
  const client = {
    head: async (key) => {
      if (storedKeys.has(key)) return { status: 200 };
      const error = new Error("missing");
      error.status = 404;
      throw error;
    },
    putStream: async (key, stream) => {
      storedKeys.add(key);
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      puts.push({ key, buffer: Buffer.concat(chunks) });
    }
  };
  const fetchImpl = async () => new Response(Buffer.from("same-image"), {
    status: 200,
    headers: { "content-type": "image/jpeg", "content-length": "10" }
  });
  const first = await archiveRemoteMediaObjectUrl("https://example.com/a.jpg", { env: ossEnv, client, fetchImpl });
  const second = await archiveRemoteMediaObjectUrl("https://example.com/b.jpg", { env: ossEnv, client, fetchImpl });
  assert.equal(first, second);
  assert.equal(puts.length, 1);
  assert.match(first, /^https:\/\/erp-test\.oss-cn-heyuan\.aliyuncs\.com\/product-media\//);
});

test("online product media uses OSS URLs and compacts duplicate raw media", async () => {
  const managed = "https://erp-test.oss-cn-heyuan.aliyuncs.com/product-media/aa/existing.jpg";
  const result = await prepareOnlineProductMediaForStorage({
    image_url: managed,
    primary_image: managed,
    images_json: JSON.stringify([managed, managed]),
    raw_json: JSON.stringify({ sku: "123", images: [managed], primary_image: managed, status: "online", nested: { videos: ["x"] } })
  }, { env: ossEnv });
  assert.equal(result.image_url, managed);
  assert.deepEqual(JSON.parse(result.images_json), [managed]);
  assert.deepEqual(JSON.parse(result.raw_json), { sku: "123", status: "online", nested: {} });
});

test("OSS-disabled development keeps remote URLs while still removing duplicate raw media", async () => {
  const url = "https://example.com/product.jpg";
  const result = await prepareOnlineProductMediaForStorage({
    image_url: url,
    images_json: JSON.stringify([url]),
    raw_json: JSON.stringify({ sku: "456", images: [url] })
  }, { env: { OSS_ENABLED: "false" } });
  assert.equal(result.image_url, url);
  assert.deepEqual(JSON.parse(result.images_json), [url]);
  assert.deepEqual(JSON.parse(result.raw_json), { sku: "456" });
});

test("media archival failure keeps the remote URL and does not abort product sync", async () => {
  const url = "https://cdn.example.com/restricted.jpg";
  const result = await prepareOnlineProductMediaForStorage({
    image_url: url,
    images_json: JSON.stringify([url])
  }, {
    env: ossEnv,
    fetchImpl: async () => new Response("forbidden", { status: 403 })
  });
  assert.equal(result.image_url, url);
  assert.deepEqual(JSON.parse(result.images_json), [url]);
});

test("raw JSON compaction tolerates invalid input", () => {
  assert.equal(compactOnlineProductRawJson("not-json"), "");
});

function mediaFixture({ fetchHook, headHook, putHook } = {}) {
  const downloads = [], uploads = [], heads = [], stored = new Set();
  const options = {
    env: ossEnv,
    client: {
      async head(key) {
        heads.push(key); if (headHook) await headHook(key);
        if (!stored.has(key)) throw Object.assign(new Error("missing"), { status: 404 });
        return {};
      },
      async putStream(key, stream) {
        for await (const chunk of stream) assert.ok(chunk.length);
        uploads.push(key); stored.add(key); if (putHook) await putHook(key);
      }
    },
    fetchImpl: async (url, request) => {
      downloads.push(url); if (fetchHook) { const response = await fetchHook(url, request); if (response) return response; }
      const buffer = Buffer.from(url);
      return new Response(buffer, { headers: { "content-type": "image/jpeg", "content-length": String(buffer.length) } });
    }
  };
  return { options, downloads, uploads, heads };
}
const productImages = (urls, raw = {}) => ({ primary_image: urls[0] || "", image_url: urls[0] || "", images_json: JSON.stringify(urls), raw_json: JSON.stringify({ sku: "fixture", ...raw }) });
const assets = item => JSON.parse(item.raw_json)._erp_source_assets || [];

test("persisted server-owned mappings avoid downloading unchanged Ozon images on the next sync", async () => {
  const f = mediaFixture(), urls = ["https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"];
  const first = await prepareOnlineProductMediaForStorage(productImages(urls), f.options);
  const second = await prepareOnlineProductMediaForStorage(productImages(urls), { ...f.options, previousItem: first });
  assert.deepEqual(f.downloads, urls); assert.equal(f.uploads.length, 2);
  assert.deepEqual(JSON.parse(second.images_json), JSON.parse(first.images_json));
  assert.deepEqual(assets(second).map(row => row.source_url), urls);
  assert.ok(assets(second).every(row => row.stored_url.startsWith("https://erp-test.oss-cn-heyuan.aliyuncs.com/product-media/")));
});

test("image archival runs at most three downloads concurrently while preserving authoritative output order", async () => {
  let active = 0, maximum = 0;
  const urls = Array.from({ length: 10 }, (_value, index) => `https://cdn.example.com/order-${index}.jpg`);
  const f = mediaFixture({ fetchHook: async url => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, url === urls[0] ? 15 : 5));
    active--;
  } });
  const result = await prepareOnlineProductMediaForStorage(productImages(urls), f.options);
  assert.equal(maximum, 3); assert.equal(f.downloads.length, 10);
  assert.deepEqual(assets(result).map(row => row.source_url), urls);
  assert.deepEqual(JSON.parse(result.images_json), assets(result).map(row => row.stored_url));
});

test("new images download normally while reordered/deleted authoritative images never revive old media", async () => {
  const f = mediaFixture(), a = "https://cdn.example.com/a.jpg", b = "https://cdn.example.com/b.jpg", c = "https://cdn.example.com/c.jpg";
  const first = await prepareOnlineProductMediaForStorage(productImages([a, b]), f.options);
  const initialImages = JSON.parse(first.images_json);
  const reordered = await prepareOnlineProductMediaForStorage(productImages([b, a]), { ...f.options, previousItem: first });
  assert.deepEqual(JSON.parse(reordered.images_json), [initialImages[1], initialImages[0]]);
  const changed = await prepareOnlineProductMediaForStorage(productImages([c, b]), { ...f.options, previousItem: reordered });
  assert.deepEqual(f.downloads, [a, b, c]);
  assert.deepEqual(assets(changed).map(row => row.source_url), [c, b]);
  assert.equal(JSON.parse(changed.images_json)[1], initialImages[1]);
  assert.equal(JSON.parse(changed.images_json).includes(initialImages[0]), false);
  const emptied = await prepareOnlineProductMediaForStorage(productImages([]), { ...f.options, previousItem: changed });
  assert.equal(emptied.primary_image, ""); assert.deepEqual(JSON.parse(emptied.images_json), []); assert.deepEqual(assets(emptied), []);
});

test("incoming mapping metadata and a previous foreign OSS host cannot redirect authoritative images", async () => {
  const f = mediaFixture(), url = "https://cdn.example.com/new.jpg";
  const forged = "https://erp-test.oss-cn-heyuan.aliyuncs.com/product-media/aa/forged.jpg";
  const previousItem = { raw_json: JSON.stringify({ _erp_source_assets: [{ source_url: url, stored_url: "https://foreign.oss-cn-heyuan.aliyuncs.com/a.jpg" }] }) };
  const result = await prepareOnlineProductMediaForStorage(productImages([url], { _erp_source_assets: [{ source_url: url, stored_url: forged }] }), { ...f.options, previousItem });
  assert.deepEqual(f.downloads, [url]); assert.notEqual(result.primary_image, forged);
  assert.deepEqual(assets(result), [{ source_url: url, stored_url: result.primary_image }]);
  const disabled = await prepareOnlineProductMediaForStorage(productImages([url], { _erp_source_assets: [{ source_url: url, stored_url: forged }] }), { env: { OSS_ENABLED: "false" } });
  assert.deepEqual(assets(disabled), []); assert.equal(disabled.primary_image, url);
});

test("a task-local cache shares successful in-flight downloads and stays bounded", async () => {
  const f = mediaFixture(), cache = new Map(), url = "https://cdn.example.com/shared.jpg";
  const [a, b] = await Promise.all([1, 2].map(() => prepareOnlineProductMediaForStorage(productImages([url]), { ...f.options, cache })));
  assert.equal(a.primary_image, b.primary_image); assert.equal(f.downloads.length, 1); assert.equal(f.uploads.length, 1);
  await prepareOnlineProductMediaForStorage(productImages([url]), { ...f.options, cache });
  assert.equal(f.downloads.length, 1);
  for (let index = 0; index < 500; index++) cache.set(`https://cdn.example.com/cached-${index}.jpg`, a.primary_image);
  cache.delete(url);
  await prepareOnlineProductMediaForStorage(productImages([url]), { ...f.options, cache });
  assert.ok(cache.size <= 500); assert.equal(f.downloads.length, 2);
});

test("failed archival keeps the current source URL and is retried rather than cached as success", async () => {
  let fail = true;
  const f = mediaFixture({ fetchHook: () => fail ? new Response("forbidden", { status: 403 }) : null });
  const cache = new Map(), url = "https://cdn.example.com/retry.jpg";
  const first = await prepareOnlineProductMediaForStorage(productImages([url]), { ...f.options, cache });
  assert.equal(first.primary_image, url); assert.equal(cache.size, 0); assert.deepEqual(assets(first), []);
  fail = false;
  const retried = await prepareOnlineProductMediaForStorage(productImages([url]), { ...f.options, cache, previousItem: first });
  assert.notEqual(retried.primary_image, url); assert.equal(f.downloads.length, 2); assert.equal(f.uploads.length, 1); assert.equal(cache.size, 1);
});

test("a cache hit still checks the current caller's authority", async () => {
  const f = mediaFixture(), url = "https://cdn.example.com/guarded-cache.jpg", cache = new Map();
  await prepareOnlineProductMediaForStorage(productImages([url]), { ...f.options, cache });
  const denied = new Error("Membership revoked");
  await assert.rejects(prepareOnlineProductMediaForStorage(productImages([url]), { ...f.options, cache, beforeRequest: () => { throw denied; } }), error => error === denied);
  assert.equal(f.downloads.length, 1); assert.equal(f.uploads.length, 1);
});

test("authority revoked after download headers is not swallowed by remote-media fallback", async () => {
  let revoked = false;
  const denied = new Error("Operations duty revoked"), cache = new Map();
  const f = mediaFixture({ fetchHook: () => { revoked = true; } });
  await assert.rejects(prepareOnlineProductMediaForStorage(productImages(["https://cdn.example.com/revoked.jpg"]), {
    ...f.options, cache, beforeRequest: () => { if (revoked) throw denied; }
  }), error => error === denied);
  assert.equal(f.downloads.length, 1); assert.equal(f.heads.length, 0); assert.equal(f.uploads.length, 0); assert.equal(cache.size, 0);
});

test("authority revoked after image bytes arrive stops before any OSS request", async () => {
  let revoked = false, reads = 0;
  const denied = new Error("Access revoked during image read");
  const f = mediaFixture({ fetchHook: () => new Response(new ReadableStream({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(Buffer.from("fixture image"));
      else { revoked = true; controller.close(); }
    }
  }), { headers: { "content-type": "image/jpeg" } }) });
  await assert.rejects(prepareOnlineProductMediaForStorage(productImages(["https://cdn.example.com/read-revoked.jpg"]), {
    ...f.options, beforeRequest: () => { if (revoked) throw denied; }
  }), error => error === denied);
  assert.equal(revoked, true); assert.equal(f.heads.length, 0); assert.equal(f.uploads.length, 0);
});

test("legacy OSS storage errors still preserve the seller URL when no business authority was revoked", async () => {
  const f = mediaFixture({ headHook: () => { throw Object.assign(new Error("OSS forbidden"), { status: 403 }); } });
  const url = "https://cdn.example.com/storage-unavailable.jpg";
  const result = await prepareOnlineProductMediaForStorage(productImages([url]), f.options);
  assert.equal(result.primary_image, url); assert.deepEqual(assets(result), []); assert.equal(f.uploads.length, 0);
});

test("authority revoked by an OSS lookup blocks upload and completion checks reject post-upload revocation", async () => {
  for (const point of ["head", "upload"]) {
    let revoked = false;
    const denied = Object.assign(new Error("Subscription revoked"), { statusCode: 403 }), cache = new Map();
    const f = mediaFixture({ headHook: () => { if (point === "head") revoked = true; }, putHook: () => { if (point === "upload") revoked = true; } });
    await assert.rejects(prepareOnlineProductMediaForStorage(productImages([`https://cdn.example.com/revoked-${point}.jpg`]), {
      ...f.options, cache, beforeRequest: () => { if (revoked) throw denied; }
    }), error => error === denied);
    assert.equal(f.uploads.length, point === "head" ? 0 : 1); assert.equal(cache.size, 0);
  }
});

test("task abort signals stop media before external I/O and after an in-flight download", async () => {
  for (const point of ["before", "download"]) {
    const controller = new AbortController(), cancelled = new Error("Task cancelled");
    const f = mediaFixture({ fetchHook: (_url, request) => {
      assert.equal(request.signal instanceof AbortSignal, true);
      if (point === "download") controller.abort(cancelled);
    } });
    if (point === "before") controller.abort(cancelled);
    await assert.rejects(prepareOnlineProductMediaForStorage(productImages(["https://cdn.example.com/abort.jpg"]), { ...f.options, signal: controller.signal }), error => error === cancelled);
    assert.equal(f.downloads.length, point === "before" ? 0 : 1); assert.equal(f.uploads.length, 0);
  }
});

test("task cancellation aborts an unfinished image stream instead of waiting for its download timeout", async () => {
  const controller = new AbortController(), reason = new Error("Cancel streaming download");
  let cancelled = false;
  const f = mediaFixture({ fetchHook: () => {
    setTimeout(() => controller.abort(reason), 10);
    return new Response(new ReadableStream({
      start(stream) { stream.enqueue(Buffer.from("partial")); },
      cancel() { cancelled = true; }
    }), { headers: { "content-type": "image/jpeg" } });
  } });
  await assert.rejects(prepareOnlineProductMediaForStorage(productImages(["https://cdn.example.com/stream-abort.jpg"]), { ...f.options, signal: controller.signal }), error => error === reason);
  assert.equal(cancelled, true); assert.equal(f.heads.length, 0); assert.equal(f.uploads.length, 0);
});

test("plain authorization errors from a shared in-flight download cannot become fallback success", async () => {
  let revoked = false;
  const denied = new Error("Member removed"), f = mediaFixture({ fetchHook: () => { revoked = true; } }), cache = new Map();
  const options = { ...f.options, cache, beforeRequest: () => { if (revoked) throw denied; } };
  const result = await Promise.allSettled([1, 2].map(() => prepareOnlineProductMediaForStorage(productImages(["https://cdn.example.com/shared-denied.jpg"]), options)));
  assert.ok(result.every(row => row.status === "rejected" && row.reason === denied));
  assert.equal(f.downloads.length, 1); assert.equal(f.uploads.length, 0); assert.equal(cache.size, 0);
});

test("rejected response headers release the unread media body before returning the original error", async () => {
  for (const [status, length, message] of [[200, "100", /exceeds 5 bytes/], [503, "1", /HTTP 503/]]) {
    let cancelled = 0;
    const f = mediaFixture({ fetchHook: () => new Response(new ReadableStream({
      cancel() { cancelled++; throw new Error("Cancellation cleanup must not replace the download error"); }
    }), { status, headers: { "content-type": "image/jpeg", "content-length": length } }) });
    await assert.rejects(archiveRemoteMediaObjectUrl("https://cdn.example.com/rejected.jpg", { ...f.options, maxBytes: 5 }), message);
    assert.equal(cancelled, 1); assert.equal(f.heads.length, 0); assert.equal(f.uploads.length, 0);
  }
});

test("an absent media response body rejects without issuing OSS requests", async () => {
  const f = mediaFixture({ fetchHook: () => new Response(null, { status: 204 }) });
  await assert.rejects(archiveRemoteMediaObjectUrl("https://cdn.example.com/empty.jpg", f.options), /Downloaded media is empty/);
  assert.equal(f.heads.length, 0); assert.equal(f.uploads.length, 0);
});

test("a batch of oversized images cannot accumulate unread streams beyond its three download slots", async () => {
  let active = 0, maximum = 0;
  const f = mediaFixture({ fetchHook: () => {
    active++; maximum = Math.max(maximum, active);
    return new Response(new ReadableStream({ cancel() { active--; } }), {
      headers: { "content-type": "image/jpeg", "content-length": "100" }
    });
  } });
  const images = Array.from({ length: 40 }, (_, index) => `https://cdn.example.com/oversized-${index}.jpg`);
  const result = await prepareOnlineProductMediaForStorage(productImages(images), { ...f.options, maxBytes: 5 });
  assert.deepEqual(JSON.parse(result.images_json), images, "The existing seller-URL fallback remains unchanged");
  assert.ok(maximum <= 3); assert.equal(active, 0);
  assert.equal(f.heads.length, 0); assert.equal(f.uploads.length, 0);
});
