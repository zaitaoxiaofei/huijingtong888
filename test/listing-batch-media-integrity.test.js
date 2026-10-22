import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";
import { isLikelyRemoteImageUrl, verifyRemoteImagesReadyForOzon } from "../src/services/listing-media-readiness.js";

const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const declarations = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body.map(node => node.declaration || node);
const functions = declarations.filter(node => node.type === "FunctionDeclaration").map(node => source.slice(node.start, node.end)).join("\n");
function service(extra = {}) {
  const context = vm.createContext({ URL, Buffer, AbortSignal, console, LOCAL_DICTIONARY_DISPLAY_ZH: new Map(),
    config: { listingMediaPublicBaseUrl: "https://erp.example" },
    LISTING_PUBLISH_MEDIA_PREWARM_LIMIT: 1, LISTING_PUBLISH_MEDIA_CHECK_CONCURRENCY: 2,
    listingMediaReachabilityCache: new Map(), LISTING_MEDIA_REACHABILITY_CACHE_TTL_MS: 60000, LISTING_MEDIA_REACHABILITY_CACHE_MAX_ENTRIES: 100,
    isManagedOssObjectUrl: value => new URL(value).host === "managed.example",
    isLikelyRemoteImageUrl,
    verifyRemoteImagesReadyForOzon: (urls, options) => verifyRemoteImagesReadyForOzon(urls, { ...options, waitImpl: async () => {} }),
    ...extra });
  // Function declarations have no module initializer, database or provider side
  // effects. All image, authority, mapping and rich-content helpers remain real.
  vm.runInContext(functions, context);
  return context;
}
const clone = value => JSON.parse(JSON.stringify(value));
const urls = (prefix, count = 8) => Array.from({ length: count }, (_, i) => `https://source.example/${prefix}-${i}.jpg`);
const payload = images => ({ items: [{ primary_image: images[0], images: images.slice(1), attributes: [] }] });
const prepared = images => images.map((source_url, i) => ({ source_url, publishUrl: `https://managed.example/output-${i}.jpg` }));

test("eight prepared images remain ordered and complete without mutating either input", () => {
  const context = service(), images = urls("a"), input = payload(images), ready = prepared(images);
  const before = JSON.stringify([input, ready]);
  const result = context.applyPreparedDraftShopMedia(input, ready, images);
  assert.equal(result.reused, true);
  assert.deepEqual(clone([result.payload.items[0].primary_image, ...result.payload.items[0].images]), ready.map(item => item.publishUrl));
  assert.equal(JSON.stringify([input, ready]), before);
  assert.equal(context.applyPreparedDraftShopMedia(input, []).reused, false);
});

test("changed counts, equal-count reorder, replaced images and old clients fail before any truncation", () => {
  const context = service(), images = urls("a");
  for (const [current, ready] of [
    [images.slice(0, 4), prepared(images)], [images, prepared(images.slice(0, 4))],
    [[images[1], images[0], ...images.slice(2)], prepared(images)],
    [[...images.slice(0, 7), "https://source.example/replaced.jpg"], prepared(images)],
    [images, prepared(images).map(({ publishUrl }) => ({ publishUrl }))]
  ]) assert.throws(() => context.applyPreparedDraftShopMedia(payload(current), ready, current), { code: "LISTING_PREPARED_MEDIA_CHANGED", status: 409 });
  const duplicated = prepared(images); duplicated[2].publishUrl = duplicated[1].publishUrl;
  assert.throws(() => context.applyPreparedDraftShopMedia(payload(images), duplicated, images), { code: "LISTING_PREPARED_MEDIA_DUPLICATED" });
});

test("shared images across variants reuse an exact source mapping, including public URL normalization", () => {
  const context = service(), images = urls("a"), normalized = urls("public");
  const input = { items: [payload(normalized).items[0], payload(normalized).items[0]] };
  const result = context.applyPreparedDraftShopMedia(input, prepared(images), images);
  assert.equal(result.payload.items.length, 2);
  assert.deepEqual(clone(result.payload.items[0]), clone(result.payload.items[1]));
  assert.equal(result.payload.items[0].images.length, 7);
});

function browser() {
  const source = readFileSync(new URL("../frontend/admin/utils/browser-watermark-batch.js", import.meta.url), "utf8");
  const cache = new Map(), uploads = [];
  const context = vm.createContext({ TextEncoder, Uint8Array, crypto: webcrypto,
    setTimeout: fn => { queueMicrotask(fn); return 0; },
    localStorage: { getItem: key => cache.get(key), setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) },
    uploadListingMedia: async (file, metadata) => {
      await new Promise(resolve => setImmediate(resolve));
      uploads.push(metadata.source_id);
      return { publishUrl: `https://managed.example/${encodeURIComponent(file.sourceUrl)}.jpg` };
    } });
  vm.runInContext(source.replace(/^import[^;]*;\r?\n/m, "").replaceAll("export ", ""), context);
  context.renderWatermarkedFile = async task => ({ sourceUrl: task.sourceUrl });
  return { context, uploads, cache };
}

test("two concurrent drafts and cached reordering retain their own eight source positions", async () => {
  const { context, uploads } = browser(), imagesA = urls("a"), imagesB = urls("b");
  const shops = [{ id: 4, watermarkPath: "/watermark.png" }];
  const result = await context.prepareBrowserWatermarkJobs({ jobs: [
    { productId: "draft-1", images: imagesA, shops }, { productId: "draft-2", images: imagesB, shops }
  ] });
  for (const [id, images] of [[1, imagesA], [2, imagesB]]) {
    const ready = result[`draft-${id}`][4];
    assert.deepEqual(clone(ready.map(item => item.source_url)), images);
    assert.equal(ready.length, 8);
    assert.ok(ready.every((item, index) => decodeURIComponent(item.publishUrl).includes(images[index])));
  }
  assert.equal(uploads.length, 16);
  const reordered = [...imagesA].reverse();
  const cached = await context.prepareBrowserWatermarkJobs({ jobs: [{ productId: "draft-3", images: reordered, shops }] });
  assert.deepEqual(clone(cached["draft-3"][4].map(item => item.source_url)), reordered);
  assert.equal(uploads.length, 16);
});

test("a failed batch image rejects the whole browser preparation rather than returning a partial manifest", async () => {
  const { context } = browser();
  context.uploadListingMedia = async () => { throw new Error("fixture upload failed"); };
  await assert.rejects(context.prepareBrowserWatermarkJobs({ jobs: [{ productId: "draft-1", images: urls("a"), shops: [{ id: 4, watermarkPath: "/watermark.png" }] }] }), /upload failed/);
});

test("only duplicate outputs within one draft and shop are recovered once from the original sources", async () => {
  const { context, cache } = browser(), imagesA = urls("a"), imagesB = urls("b"), recovered = [];
  let uploads = 0, active = 0, maxActive = 0;
  context.uploadListingMedia = async file => {
    uploads++;
    return { publishUrl: [imagesA[1], imagesA[2]].includes(file.sourceUrl) ? "https://managed.example/bad-cached.jpg" : `https://managed.example/${encodeURIComponent(file.sourceUrl)}.jpg` };
  };
  context.watermarkListingMedia = async body => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setImmediate(resolve));
    recovered.push(body);
    active--;
    return { images: [{ publishUrl: `https://managed.example/recovered-${encodeURIComponent(body.images[0].url)}.jpg` }] };
  };
  const jobs = [{ productId: "draft-1", images: imagesA, shops: [{ id: 4, watermarkPath: "/w.png" }] },
    { productId: "draft-2", images: imagesB, shops: [{ id: 4, watermarkPath: "/w.png" }] }];
  const result = await context.prepareBrowserWatermarkJobs({ jobs });
  assert.deepEqual(recovered.map(body => body.images[0].url), [imagesA[1], imagesA[2]]);
  assert.ok(recovered.every(body => body.shopId === 4 && body.sourceId.startsWith("draft-1:")));
  assert.deepEqual(clone(result["draft-2"][4].map(item => item.source_url)), imagesB);
  assert.equal(new Set(result["draft-1"][4].map(item => item.publishUrl)).size, 8);
  assert.equal(maxActive, 1);
  assert.ok([...cache.values()].every(value => !value.includes("bad-cached.jpg")));
  await context.prepareBrowserWatermarkJobs({ jobs });
  assert.equal(uploads, 16); assert.equal(recovered.length, 2, "Recovered cache does not cause another retry pass");
});

test("identical source content that remains duplicated after one recovery pass stops the whole batch", async () => {
  const { context, cache } = browser(); let recovered = 0;
  context.uploadListingMedia = async () => ({ publishUrl: "https://managed.example/duplicate.jpg" });
  context.watermarkListingMedia = async () => { recovered++; return { images: [{ publishUrl: "https://managed.example/still-duplicate.jpg" }] }; };
  await assert.rejects(context.prepareBrowserWatermarkJobs({ jobs: [{ productId: "draft-1", images: urls("a", 2), shops: [{ id: 4, watermarkPath: "/w.png" }] }] }), /仍为相同素材/);
  assert.equal(recovered, 2); assert.equal(cache.size, 0);
});

test("canvas strict source URLs include existing relative and same-origin proxy URLs", () => {
  const { context } = browser(); context.URL = URL; context.window = { location: { origin: "https://erp.example" } };
  for (const input of ["https://source.example/a.jpg", "/api/image-proxy?url=https%3A%2F%2Fsource.example%2Fa.jpg",
    "https://erp.example/api/image-proxy?url=https%3A%2F%2Fsource.example%2Fa.jpg&require_original=0"]) {
    const output = new URL(context.toCanvasReadableUrl(input), "https://erp.example");
    assert.equal(output.searchParams.get("require_original"), "1");
    assert.equal(output.searchParams.get("url"), "https://source.example/a.jpg");
  }
  assert.equal(context.toCanvasReadableUrl("/uploads/listing-media/own.jpg"), "/uploads/listing-media/own.jpg");
});

test("failed strict image proxies use original-source server fallback and never upload a placeholder", async () => {
  const { context } = browser(), reads = [], fallbacks = []; let uploads = 0;
  context.URL = URL; context.window = { location: { origin: "https://erp.example" } }; context.withImageToken = value => value;
  context.setTimeout = (callback, delay) => { if (delay < 30000) queueMicrotask(callback); return 0; };
  context.Image = class {
    set src(value) { reads.push(value); queueMicrotask(() => value.includes("/api/image-proxy") ? this.onerror() : this.onload()); }
  };
  const render = parse(readFileSync(new URL("../frontend/admin/utils/browser-watermark-batch.js", import.meta.url), "utf8"), { ecmaVersion: "latest", sourceType: "module" }).body
    .find(node => node.type === "FunctionDeclaration" && node.id.name === "renderWatermarkedFile");
  const browserSource = readFileSync(new URL("../frontend/admin/utils/browser-watermark-batch.js", import.meta.url), "utf8");
  vm.runInContext(browserSource.slice(render.start, render.end), context);
  context.uploadListingMedia = async () => { uploads++; throw new Error("A proxy placeholder must never be uploaded"); };
  context.watermarkListingMedia = async body => {
    fallbacks.push(body.images[0].url);
    return { images: [{ publishUrl: `https://managed.example/${encodeURIComponent(body.images[0].url)}.jpg` }] };
  };
  const images = ["https://source.example/a.jpg", "https://source.example/b.jpg"];
  const jobs = images.map((image, index) => ({ productId: `draft-${index}`, images: [image], shops: [{ id: 4, watermarkPath: "/w.png" }] }));
  const result = await context.prepareBrowserWatermarkJobs({ jobs });
  assert.equal(uploads, 0); assert.deepEqual([...fallbacks].sort(), [...images].sort());
  assert.ok(reads.filter(value => value.includes("/api/image-proxy")).every(value => new URL(value, "https://erp.example").searchParams.get("require_original") === "1"));
  assert.notEqual(result["draft-0"][4][0].publishUrl, result["draft-1"][4][0].publishUrl);
  context.watermarkListingMedia = async () => { throw new Error("Original source unavailable"); };
  await assert.rejects(context.prepareBrowserWatermarkJobs({ jobs: [{ productId: "failed", images: ["https://source.example/unavailable.jpg"], shops: [{ id: 4, watermarkPath: "/w.png" }] }] }), /图片处理失败/);
  assert.equal(uploads, 0);
});

test("all managed OSS and actual image URLs are fully checked even past the former prewarm limit", async () => {
  const requests = [], context = service({ requestPublicMedia: async (url, options) => {
    await options.beforeRequest?.(); requests.push({ url, method: options.method });
    return { ok: true, status: 200, buffer: Buffer.from("fixture"), headers: new Headers({ "content-type": "image/jpeg", "content-length": "7" }) };
  } });
  const images = Array.from({ length: 8 }, (_, i) => `https://managed.example/image-${i}.jpg`);
  images[7] = "https://external.example/no-extension";
  const input = payload(images), before = JSON.stringify(input);
  await context.assertPublishPayloadMediaReachable(input);
  assert.equal(requests.filter(item => item.method === "GET").length, 16);
  assert.ok(images.every(url => requests.filter(item => item.url === url && item.method === "GET").length === 2));
  assert.equal(JSON.stringify(input), before);
});

test("one unavailable image blocks the complete publish payload and never trims it into partial success", async () => {
  const images = Array.from({ length: 8 }, (_, i) => `https://managed.example/image-${i}.jpg`);
  const context = service({ requestPublicMedia: async (url, options) => {
    await options.beforeRequest?.();
    return { ok: url !== images[4], status: url === images[4] ? 503 : 200, buffer: Buffer.from("fixture"), headers: new Headers({ "content-type": "image/jpeg", "content-length": "7" }) };
  } });
  const input = payload(images), before = JSON.stringify(input);
  await assert.rejects(context.assertPublishPayloadMediaReachable(input), error => error.status === 400 && error.unreachable_media.some(url => url.includes("image-4.jpg")));
  assert.equal(JSON.stringify(input), before);
});

test("repeated final output URLs are blocked in the server preparation path before any media or Ozon request", async () => {
  let calls = 0;
  const context = service({ requestPublicMedia: async () => { calls++; throw new Error("must not request"); } });
  const images = urls("a"); images[4] = images[1];
  await assert.rejects(context.assertPublishPayloadMediaReachable(payload(images)), { code: "LISTING_PUBLISH_IMAGES_DUPLICATED" });
  assert.equal(calls, 0);
});
