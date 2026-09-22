import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const view = readFileSync(new URL("../frontend/admin/views/listing/AiVariantLabView.vue", import.meta.url), "utf8");
const service = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const extract = (source, name) => source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))?.[0];
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function preparation({ persist, video }) {
  return new Function("rowPreparationTasks", "resultImageUrl", "rowResultId", "persistGeneratedRowAssets", "generateRowRichContent", "rowVideoUrls", "rowVideoUsesCurrentMainImage", "generateRowVideo", "runWithConcurrency", "BACKGROUND_DRAFT_PREPARATION_CONCURRENCY", "queueGeneratedRowPreparation", `
    ${extract(view, "prepareGeneratedRowForDraft")}
    ${extract(view, "prepareGeneratedRowsForDraft")}
    return { prepareGeneratedRowForDraft, prepareGeneratedRowsForDraft };
  `)(new Map(), (row) => row.image, (row) => row.id, persist, async (row) => { row.assets = { rich_content: { json: "rich" } }; }, () => [], () => false, video, (rows, limit, fn) => Promise.all(rows.map(fn)), 10, () => { throw new Error("Save must not wait in the video queue"); });
}

test("saving reuses required asset persistence but does not wait for an ongoing video", async () => {
  const assets = deferred();
  const video = deferred();
  let persistCalls = 0;
  let videoCalls = 0;
  const api = preparation({ persist: () => { persistCalls++; return assets.promise; }, video: () => { videoCalls++; return video.promise; } });
  const row = { id: "one", image: "/main.jpg" };
  const background = api.prepareGeneratedRowForDraft(row, { generateVideo: true });
  let saved = false;
  const saving = api.prepareGeneratedRowsForDraft([row], { generateVideo: false }).then(() => { saved = true; });
  await new Promise(setImmediate);
  assert.equal(saved, false, "saving must wait for required image persistence");
  assets.resolve();
  await new Promise(setImmediate);
  assert.equal(saved, true, "saving must finish while the video is still pending");
  assert.equal(persistCalls, 1);
  assert.equal(videoCalls, 1);
  video.resolve();
  await Promise.all([background, saving]);
});

test("asset preparation failures block saving and can be retried", async () => {
  let attempts = 0;
  const api = preparation({ persist: async () => { if (++attempts === 1) throw new Error("Image upload failed"); }, video: async () => {} });
  const row = { id: "one", image: "/main.jpg" };
  await assert.rejects(api.prepareGeneratedRowsForDraft([row], { generateVideo: false }), /Image upload failed/);
  await api.prepareGeneratedRowsForDraft([row], { generateVideo: false });
  assert.equal(attempts, 2);
});

test("draft source saves omit the repeated template while template-only imports retain it", () => {
  const template = { editable_payload: { title: "Source", variants: [] }, source_raw: { history: "x".repeat(524000) } };
  const material = { sourceDraftId: "9", templateId: 1, templatePayload: template, detailImages: [], sourceShopIds: [] };
  const make = new Function("material", "rowMainImageDraftUrl", "normalizeImageList", "uniqueList", "state", "rowTitleOutput", "rowTagsOutput", "rowDescriptionOutput", "rowRichContentOutput", "rowVideoUrls", "rowVideoCoverUrls", "normalizeShopIds", "sourceModel", "resultImageUrl", `${extract(view, "buildListingDraftPayload")}; return buildListingDraftPayload;`)(material, () => "/main.jpg", (v) => v, (v) => v, { batchJob: { job_no: "batch" } }, () => "Title", () => [], () => "Description", () => "rich", () => ["/video.mp4"], () => ["/video.mp4"], (v) => v, { value: "Source" }, () => "/main.jpg");
  const row = { item_no: "item", offerId: "sku", target_variant_value: "Target" };
  const compact = make(row);
  assert.equal(compact.template_payload, null);
  assert.equal(compact.source_draft_id, "9");
  assert.deepEqual(compact.patch.video_urls, ["/video.mp4"]);
  material.sourceDraftId = "";
  const full = make(row);
  assert.deepEqual(full.template_payload, template);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(full)) / 100);
});

test("backend restores the current draft snapshot when compact AI lab requests omit it", async () => {
  const seen = [];
  const stop = new Error("snapshot verified");
  const current = { editable_payload: { title: "Current saved draft", images: ["/current.jpg"] } };
  const create = new Function("aiVariantSaveTraceId", "logAiVariantSavePerf", "ensureListingAutomationSchema", "findDuplicateAiMaterialOptimizerDraft", "row", "parseJson", "normalizeTemplateRow", "normalizeAiVariantSourceTemplateSnapshot", "mergeAiVariantTemplateSnapshot", "ensureAiVariantDraftVideoMedia", "objectValue", `${extract(service, "createAiVariantListingDraftLightweight")}; return createAiVariantListingDraftLightweight;`)(() => "trace", () => {}, async () => {}, async () => null, async (sql) => sql.includes("listing_drafts") ? { template_payload_json: JSON.stringify(current), template_id: 1 } : { id: 1 }, (v, fallback) => v ? JSON.parse(v) : fallback, () => ({ editable_payload: { title: "Old category template" } }), (body) => { seen.push(body.template_payload); return body.template_payload; }, (base, snapshot) => ({ ...base, ...snapshot }), async () => { throw stop; }, (v) => v || {});
  await assert.rejects(create({ source_draft_id: 9, template_id: 1, template_payload: null, ai_optimization: { source: "ai_variant_lab" } }), (error) => error === stop);
  assert.deepEqual(seen, [current, current]);
});

test("draft image and template materialization share a per-save URL cache", async () => {
  const mapRef = [];
  const materialize = new Function("objectValue", "aiVariantSaveTraceId", "logAiVariantSavePerf", "normalizeStringList", "materializeListingMediaUrlList", "materializeAiOptimizationTemplateMedia", "forceDraftTemplateImages", "rewriteMediaUrlsWithMap", `${extract(service, "materializeAiOptimizationDraftMedia")}; return materializeAiOptimizationDraftMedia;`)((v) => v || {}, () => "", () => {}, (v) => v || [], async (urls, meta, session, map) => { map.set("/temporary.jpg", "https://media.example/permanent.jpg"); mapRef.push(map); return ["https://media.example/permanent.jpg"]; }, async (payload, session, map) => { assert.equal(map, mapRef[0]); assert.equal(map.get("/temporary.jpg"), "https://media.example/permanent.jpg"); return payload; }, (payload) => payload, (v) => v);
  await materialize({ ai_payload: { source: "ai_optimization" }, source_images: ["/temporary.jpg"], template_payload: { images: ["/temporary.jpg"] } });
});

test("batch watermark cache shares common details per shop while retaining distinct main images", async () => {
  let calls = 0;
  const watermark = new Function("watermarkListingMedia", `${extract(service, "watermarkListingMediaForSaveBatch")}; return watermarkListingMediaForSaveBatch;`)(async (body) => {
    calls++;
    await new Promise(setImmediate);
    return { images: [{ publishUrl: `https://media.example/${body.shop_id}/${body.images[0].url}` }] };
  });
  const cache = new Map();
  const jobs = [];
  for (let row = 0; row < 4; row++) {
    for (const shopId of [1, 2]) jobs.push(watermark({ shop_id: shopId, images: [{ url: `main-${row}` }, { url: "shared-detail-1" }, { url: "shared-detail-2" }, { url: "shared-detail-3" }] }, { id: shopId, watermark_path: `watermark-${shopId}` }, null, cache));
  }
  const results = await Promise.all(jobs);
  assert.equal(calls, 14, "8 unique main images plus 6 shared detail/shop combinations, instead of 32 renders");
  assert.ok(results.every((r) => r.images.length === 4));
  assert.equal(results[0].images[1], results[2].images[1]);
  assert.notEqual(results[0].images[0], results[2].images[0]);
  assert.notEqual(results[0].images[1], results[1].images[1]);
  await watermark({ shop_id: 1, images: [{ url: "shared-detail-1" }] }, { id: 1, watermark_path: "changed-watermark" }, null, cache);
  assert.equal(calls, 15);
});

test("failed watermark tasks are removed from the batch cache so retries can succeed", async () => {
  let calls = 0;
  const watermark = new Function("watermarkListingMedia", `${extract(service, "watermarkListingMediaForSaveBatch")}; return watermarkListingMediaForSaveBatch;`)(async () => {
    if (++calls === 1) throw new Error("Upload failed");
    return { images: [{ publishUrl: "https://media.example/final.jpg" }] };
  });
  const cache = new Map();
  const body = { shop_id: 1, images: [{ url: "main" }] };
  const shop = { id: 1, watermark_path: "watermark" };
  await assert.rejects(watermark(body, shop, null, cache), /Upload failed/);
  const result = await watermark(body, shop, null, cache);
  assert.equal(calls, 2);
  assert.equal(result.images[0].publishUrl, "https://media.example/final.jpg");
});

test("background save returns IDs without hydrating the full draft editor response", async () => {
  const creator = extract(service, "createAiVariantListingDraftLightweight");
  const tail = creator.slice(creator.lastIndexOf("  stageStarted = Date.now();"), -1);
  let reads = 0;
  const complete = new Function("options", "listingDraft", `return (async () => {
    let stageStarted;
    const logAiVariantSavePerf = () => {}, traceId = "trace", totalStarted = Date.now();
    const draftId = 12, templateId = 3, payload = { template_id: 4 }, shopCopies = [{ id: 1 }, { id: 2 }], shopCopyError = "", session = {};
    ${tail}
  })();`);
  const summary = await complete({ summaryOnly: true }, async () => { reads++; return {}; });
  assert.equal(summary.id, 12);
  assert.equal(summary.shop_copy_count, 2);
  assert.equal(reads, 0);
  await complete({}, async () => { reads++; return {}; });
  assert.equal(reads, 1);
});
