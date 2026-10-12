import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../src/server/routes/listingAutomation.js", import.meta.url), "utf8");
const viewSource = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");

test("collector box batches publish statistics for the visible page", () => {
  const section = source.match(/export async function collectorBoxProducts[\s\S]*?export async function collectorBoxProductDetail/)?.[0] || "";
  assert.match(section, /source_collector_sku IN \(\$\{pageSkus\.map/);
  assert.doesNotMatch(section, /SELECT r\.status FROM listing_publish_records/);
});

test("lightweight draft pages resolve media mappings in one batch", () => {
  const section = source.match(/if \(paged && lightweight\)[\s\S]*?const rowsSql = lightweight/)?.[0] || "";
  assert.match(section, /resolveMappedMediaInValue\(normalizedPageRows\)/);
  assert.doesNotMatch(section, /Promise\.all\(pageRows\.map/);
});

test("publish record and task lists run count and page reads concurrently", () => {
  const tasks = source.match(/export async function listingPublishTasks[\s\S]*?export async function listingPublishTaskDetail/)?.[0] || "";
  const records = source.match(/export async function listingPublishRecords[\s\S]*?export async function listingDraftProjects/)?.[0] || "";
  assert.match(tasks, /const \[countRow, rows\] = await Promise\.all/);
  assert.match(records, /const \[countRow, rows\] = await Promise\.all/);
});

test("publish record and task pages restore bounded fresh snapshots", () => {
  assert.match(viewSource, /const LIST_CACHE_MAX_ENTRIES = 30/);
  assert.match(viewSource, /const publishTaskListCache = new Map\(\)/);
  assert.match(viewSource, /const cacheKey = requestUrl/);
  assert.match(viewSource, /taskLoading\.value = !hasFreshCache/);
});

test("publish task reads avoid full schema warmup and large record payloads", () => {
  const tasks = source.match(/export async function listingPublishTasks[\s\S]*?async function claimListingPublishTaskItemForRetry/)?.[0] || "";
  assert.match(source, /async function ensurePublishTaskReadSchema/);
  assert.match(tasks, /await ensurePublishTaskReadSchema\(\)/);
  assert.match(tasks, /const fromSql = `\s*FROM listing_publish_tasks t/);
  assert.match(tasks, /\(r\.response_json IS NOT NULL\) AS record_has_response/);
  assert.doesNotMatch(tasks, /r\.response_json AS record_response_json/);
  assert.match(tasks, /COALESCE\(i\.error_json, r\.error_json\) AS effective_error_json/);
});

test("draft and publish record lists avoid full schema warmup", () => {
  const drafts = source.match(/export async function listingDrafts[\s\S]*?export async function listingDraftDetail/)?.[0] || "";
  const records = source.match(/export async function listingPublishRecords[\s\S]*?export async function listingDraftProjects/)?.[0] || "";
  assert.match(source, /async function ensureListingListReadSchema/);
  assert.match(drafts, /await ensureListingListReadSchema\(\)/);
  assert.match(records, /await ensureListingListReadSchema\(\)/);
});

test("development review can fetch linked drafts with authoritative image and publish summaries", () => {
  const drafts = source.match(/export async function listingDrafts\(query = \{\}, session\)[\s\S]*?export async function listingDraftDetail/)?.[0] || "";
  assert.match(drafts, /requestedIds/);
  assert.match(drafts, /d\.id IN \(\$\{placeholders\}\)/);
  assert.match(drafts, /AS source_product_id/);
  assert.match(drafts, /AS sku_count/);
  assert.match(drafts, /AS publish_success_count/);
  assert.match(drafts, /resolveMappedMediaInValue\(normalizeDraftRow\(item\)\)/);
  assert.match(source, /effective_images: effectiveMedia\.images/);
});

test("development review returns published shop SKUs and order and unit counts", () => {
  const review = source.match(/async function attachDevelopmentReviewSkus\([\s\S]*?export async function listingDraftDetail/)?.[0] || "";
  assert.match(review, /r\.status IN \('imported', 'published', 'success'\)/);
  assert.match(review, /op\.product_id AS inventory_product_id/);
  assert.match(review, /COUNT\(DISTINCT o\.id\) AS order_count/);
  assert.match(review, /SUM\(oi\.quantity\)/);
  assert.match(review, /LOWER\(o\.status\) NOT IN \('cancelled'/);
  assert.match(review, /COLLATE utf8mb4_unicode_ci/);
  assert.match(review, /draft\.published_skus = skusByDraft/);
  assert.match(review, /COALESCE\(NULLIF\(r\.draft_id, 0\), i\.draft_id\) AS draft_id/);
  assert.match(review, /draft\.published_shops = stores/);
  assert.match(review, /draft\.publish_records = stores\.filter/);
  assert.doesNotMatch(review, /AND r\.status IN \('imported', 'published', 'success'\)\s+AND TRIM\(COALESCE\(r\.ozon_sku/);
  assert.match(review, /op\.offer_id = r\.offer_id/);
  const reviewEndpoint = source.match(/export async function listingDevelopmentReview\([\s\S]*?async function attachDevelopmentReviewSkus/)?.[0] || "";
  assert.match(reviewEndpoint, /paged: "1", page: "1", pageSize: "100", lightweight: "1", includeReviewSkus: "1"/);
  assert.match(reviewEndpoint, /COUNT\(DISTINCT o\.id\)/);
  assert.match(reviewEndpoint, /SUM\(oi\.quantity\)/);
  assert.match(reviewEndpoint, /sales_by_task/);
  assert.match(routeSource, /POST \/api\/listing\/development-review/);
  assert.match(viewSource, /reviewDraftIds\) params\.set\("ids", reviewDraftIds\)/);
});

test("manual online listing sync narrows database writes to the selected offers", () => {
  const sync = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const syncRoutes = readFileSync(new URL("../src/server/routes/sync.js", import.meta.url), "utf8");
  assert.match(sync, /requestedOfferIds/);
  assert.match(sync, /requestedOfferIds\.includes\(String\(item\.offer_id/);
  assert.match(syncRoutes, /publish_offers/);
});

test("publish record table reads lightweight list summaries instead of request payloads", () => {
  const records = source.match(/export async function listingPublishRecords[\s\S]*?export async function listingDraftProjects/)?.[0] || "";
  const listSelect = records.match(/const listRecordSelectSql = `[\s\S]*?`;/)?.[0] || "";
  assert.match(records, /const fromSql = \(includeCategory\) => `/);
  assert.match(records, /SELECT COUNT\(\*\) AS total \$\{fromSql\(Boolean\(keyword \|\| categoryPath\)\)\}/);
  assert.match(records, /\$\{fromSql\(true\)\}/);
  assert.match(listSelect, /JSON_EXTRACT\(r\.list_summary_json, '\$\.name'\)/);
  assert.match(listSelect, /JSON_EXTRACT\(r\.list_summary_json, '\$\.primary_image'\)/);
  assert.doesNotMatch(listSelect, /JSON_EXTRACT\(r\.request_json/);
});
