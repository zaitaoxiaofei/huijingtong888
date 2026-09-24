import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const contentSource = readFileSync(new URL("../ozon-erp-collector-plugin/content.js", import.meta.url), "utf8");
const backgroundSource = readFileSync(new URL("../ozon-erp-collector-plugin/background.js", import.meta.url), "utf8");
const collectorSource = readFileSync(new URL("../ozon-erp-collector-plugin/collector.js", import.meta.url), "utf8");
const sellerBridgeSource = readFileSync(new URL("../ozon-erp-collector-plugin/seller-bridge-content.js", import.meta.url), "utf8");

test("manual add to collector box waits for full detail before syncing", () => {
  const fnStart = contentSource.indexOf("async function addCurrentPreviewToCollectorBox");
  const fnEnd = contentSource.indexOf("async function ensureCurrentProductInCollectorBox", fnStart);
  const fnSource = contentSource.slice(fnStart, fnEnd);
  assert.ok(fnStart > 0 && fnEnd > fnStart);
  assert.match(fnSource, /正在采集完整详情、全部变体和图片/);
  assert.match(fnSource, /await withTimeoutReject\(/);
  assert.match(fnSource, /collectFullDetailPayloadForCollectorBox\(sku\)/);
  assert.match(fnSource, /syncCollectedProductToCollectorBox\(payload, requestContext\)/);
  assert.match(fnSource, /采集完成：\$\{variantCount\} 个变体、\$\{imageCount\} 张图片/);
  assert.doesNotMatch(contentSource, /buildFastCollectorBoxPayload/);
  assert.doesNotMatch(contentSource, /scheduleFullCollectorBoxBackfill/);
});

test("full collector-box collection has a bounded timeout and six concurrent variant requests", () => {
  assert.match(contentSource, /COLLECTOR_BOX_FULL_DETAIL_TIMEOUT_MS = 150000/);
  assert.match(contentSource, /runDetailAutoFeature\(\{ concurrency: 6 \}\)/);
  assert.match(collectorSource, /options\.concurrency \|\| 6/);
  assert.match(collectorSource, /String\(variant\.sku\) === String\(seedDetail\.sku \|\| seedSku\)/);
});

test("full-detail collection reuses the seed response and overlaps rich-description loading", () => {
  assert.match(collectorSource, /const seedDetail = options\.seedDetail \|\| await fetchProductDetail/);
  assert.match(collectorSource, /const descriptionPromise = withTimeout\(/);
  assert.match(collectorSource, /seedDetail: productDetail/);
  assert.match(collectorSource, /const descriptionResult = await descriptionPromise/);
});

test("collector-box sync sends URL-only media references", () => {
  const fnStart = contentSource.indexOf("async function syncCollectedProductToCollectorBox");
  const fnEnd = contentSource.indexOf("async function waitForCollectedSnapshot", fnStart);
  const fnSource = contentSource.slice(fnStart, fnEnd);
  assert.match(fnSource, /timeoutMs: 30000/);
  assert.match(contentSource, /function buildUrlOnlyCollectorPayload/);
  assert.match(fnSource, /media_storage_mode: 'remote_url_reference'/);
});

test("fast collector-box cache remains eligible for full detail refresh", () => {
  const fnStart = contentSource.indexOf("function canReuseCollectedDetail");
  const fnEnd = contentSource.indexOf("function normalizeCachedProductImages", fnStart);
  const fnSource = contentSource.slice(fnStart, fnEnd);
  assert.match(fnSource, /ozon_plugin_fast_add_to_box/);
  assert.match(fnSource, /return false/);
});

test("collector plugin preserves official Ozon category type id through seller sync", () => {
  const contentPayloadStart = contentSource.indexOf("function buildCollectedProductListPayload");
  const contentPayloadEnd = contentSource.indexOf("async function collectListPayloadFromDetail", contentPayloadStart);
  const contentPayloadSource = contentSource.slice(contentPayloadStart, contentPayloadEnd);
  const backgroundDisplayStart = backgroundSource.indexOf("function buildCollectedProductDisplayPayload");
  const backgroundDisplayEnd = backgroundSource.indexOf("async function emitAutoCollectListProgress", backgroundDisplayStart);
  const backgroundDisplaySource = backgroundSource.slice(backgroundDisplayStart, backgroundDisplayEnd);
  assert.ok(contentPayloadStart > 0 && contentPayloadEnd > contentPayloadStart);
  assert.ok(backgroundDisplayStart > 0 && backgroundDisplayEnd > backgroundDisplayStart);
  assert.match(contentPayloadSource, /'type_id'/);
  assert.match(backgroundDisplaySource, /'type_id'/);
  assert.match(contentSource, /description_type_dict_value \|\| item\.descriptionTypeDictValue \|\| item\.type_id \|\| item\.typeId/);
  assert.match(contentSource, /sellerPatch\.description_type_dict_value/);
  assert.match(backgroundSource, /function normalizeSellerTypeId/);
  assert.match(backgroundSource, /source\.description_type_dict_value/);
  assert.match(backgroundSource, /const sellerTypeId = normalizeSellerTypeId\(variant\)/);
  assert.match(backgroundSource, /if \(sellerTypeId\) result\.type_id = sellerTypeId/);
  assert.match(collectorSource, /function normalizeSellerTypeId/);
  assert.match(collectorSource, /source\.description_type_dict_value/);
  assert.match(collectorSource, /const sellerTypeId = normalizeSellerTypeId\(variant\)/);
  assert.match(collectorSource, /if \(sellerTypeId\) result\.type_id = sellerTypeId/);
  assert.match(backgroundSource, /result\.type_id = String\(categoryIds\[categoryIds\.length - 1\]\)/);
  assert.match(backgroundSource, /else if \(hasFilledValue\(item\.type_id\)\) result\.type_id = item\.type_id/);
  assert.match(collectorSource, /result\.type_id = String\(categoryIds\[categoryIds\.length - 1\]\)/);
  assert.match(collectorSource, /else if \(hasFilledValue\(item\.type_id\)\) result\.type_id = item\.type_id/);
});

test("collector plugin always writes collected prices as CNY", () => {
  const payloadStart = contentSource.indexOf("function buildEditorSourcePayload");
  const payloadEnd = contentSource.indexOf("function buildCollectedProductListPayload", payloadStart);
  const payloadSource = contentSource.slice(payloadStart, payloadEnd);
  assert.ok(payloadStart > 0 && payloadEnd > payloadStart);
  assert.match(payloadSource, /priceCurrency: 'CNY'/);
  assert.match(payloadSource, /currency: 'CNY'/);
  assert.doesNotMatch(payloadSource, /priceCurrency:[\s\S]{0,120}'RUB'/);
  assert.doesNotMatch(payloadSource, /currency:[\s\S]{0,120}'RUB'/);
  assert.match(collectorSource, /function detectCurrency\(value, fallback = 'CNY'\)/);
  assert.doesNotMatch(collectorSource, /productDetail\.currency \|\| 'RUB'/);
});

test("collector plugin uploads server publish media through seller bridge", () => {
  assert.match(backgroundSource, /SERVER_PUBLISH_MEDIA_SIDECAR_ALARM_NAME/);
  assert.match(backgroundSource, /server-publish\/media-upload-jobs\/claim/);
  assert.match(backgroundSource, /completeServerPublishMediaUploadJob/);
  assert.match(backgroundSource, /crossTabOzonMediaUpload/);
  assert.match(backgroundSource, /OZON_ERP_MEDIA_UPLOAD/);
  assert.match(backgroundSource, /scheduleServerPublishMediaSidecar\(\)/);
  assert.match(sellerBridgeSource, /api\/images\/synchronous\/validate_raw/);
  assert.match(sellerBridgeSource, /api\/media-storage\/upload-file/);
  assert.match(sellerBridgeSource, /function runMediaUploadRequest/);
  assert.match(sellerBridgeSource, /formData\.append\('image'/);
  assert.match(sellerBridgeSource, /formData\.append\('body'/);
});
