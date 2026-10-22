import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../src/server/routes/listingAutomation.js", import.meta.url), "utf8");
const viewSource = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");
const developmentReviewViewSource = readFileSync(new URL("../frontend/admin/views/team/ProductDevelopmentCenterView.vue", import.meta.url), "utf8");

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
  assert.match(viewSource, /const cacheKey = `\$\{requestScope\}:\$\{requestUrl\}`/);
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
  assert.match(drafts, /const tenantScope = "CONVERT\(COALESCE\(d\.tenant_id, 'admin'\) USING utf8mb4\) COLLATE utf8mb4_unicode_ci = CONVERT\(\? USING utf8mb4\) COLLATE utf8mb4_unicode_ci"/);
  assert.match(drafts, /listing_category_templates t ON t\.id = d\.template_id AND \$\{relatedTenantScope\("t"\)\}/);
  assert.match(drafts, /resolveMappedMediaInValue\(normalizeDraftRow\(item\)\)/);
  assert.match(source, /effective_images: effectiveMedia\.images/);
});

test("development review returns published shop SKUs and order and unit counts", () => {
  const review = source.match(/async function attachDevelopmentReviewSkus\([\s\S]*?export async function listingDraftDetail/)?.[0] || "";
  assert.match(review, /r\.status IN \('imported', 'published', 'success'\)/);
  assert.match(review, /op\.product_id AS inventory_product_id/);
  assert.match(review, /buildOrderOutcomeSql\("o", "mysql"\)/);
  assert.match(review, /orderOutcome\.effectiveSale/);
  assert.match(review, /orderOutcome\.afterDeliveryReturn/);
  assert.match(review, /COUNT\(DISTINCT CASE WHEN \$\{effectiveBusinessSale\} THEN o\.id END\) AS order_count/);
  assert.match(review, /SUM\(CASE WHEN \$\{effectiveBusinessSale\} THEN oi\.quantity ELSE 0 END\)/);
  assert.doesNotMatch(review, /LOWER\(o\.status\) NOT IN/);
  assert.match(review, /COLLATE utf8mb4_unicode_ci/);
  assert.match(review, /draft\.published_skus = skusByDraft/);
  assert.match(review, /COALESCE\(NULLIF\(r\.draft_id, 0\), i\.draft_id\) AS draft_id/);
  assert.match(review, /draft\.published_shops = stores/);
  assert.match(review, /draft\.publish_records = stores\.filter/);
  assert.doesNotMatch(review, /AND r\.status IN \('imported', 'published', 'success'\)\s+AND TRIM\(COALESCE\(r\.ozon_sku/);
  assert.match(review, /CONVERT\(op\.offer_id USING utf8mb4\) COLLATE utf8mb4_unicode_ci = CONVERT\(r\.offer_id USING utf8mb4\) COLLATE utf8mb4_unicode_ci/);
  assert.match(review, /CONVERT\(COALESCE\(d\.tenant_id, 'admin'\) USING utf8mb4\) COLLATE utf8mb4_unicode_ci = CONVERT\(\? USING utf8mb4\) COLLATE utf8mb4_unicode_ci/);
  assert.match(review, /CONVERT\(COALESCE\(r\.tenant_id, 'admin'\) USING utf8mb4\) COLLATE utf8mb4_unicode_ci/);
  assert.match(review, /inventory\.name AS inventory_product_name/);
  const reviewEndpoint = source.match(/export async function listingDevelopmentReview\([\s\S]*?async function attachDevelopmentReviewSkus/)?.[0] || "";
  assert.match(reviewEndpoint, /paged: "1", page: "1", pageSize: "100", lightweight: includeVariants \? "0" : "1", includeReviewSkus: "1"/);
  assert.match(reviewEndpoint, /buildOrderOutcomeSql\("o", "mysql"\)/);
  assert.match(reviewEndpoint, /COUNT\(DISTINCT CASE WHEN \$\{effectiveBusinessSale\} THEN o\.id END\)/);
  assert.match(reviewEndpoint, /SUM\(CASE WHEN \$\{effectiveBusinessSale\} THEN oi\.quantity ELSE 0 END\)/);
  assert.match(reviewEndpoint, /sales_by_task/);
  assert.match(routeSource, /POST \/api\/listing\/development-review/);
  assert.match(viewSource, /reviewDraftIds\) params\.set\("ids", reviewDraftIds\)/);
});

test("development review loads effective draft images, people, and variant details on demand", () => {
  const review = source.match(/export async function listingDevelopmentReview\([\s\S]*?async function attachDevelopmentReviewSkus/)?.[0] || "";
  const lightweightDrafts = source.match(/if \(paged && lightweight\)[\s\S]*?const rowsSql = lightweight/)?.[0] || "";
  assert.match(review, /include_variants/);
  assert.match(review, /lightweight: includeVariants \? "0" : "1"/);
  assert.match(review, /draft\.variants = normalizeArray/);
  assert.match(lightweightDrafts, /JSON_EXTRACT\(d\.template_payload_json, '\$\.editable_payload\.variants\[0\]\.images'\)/);
  assert.match(lightweightDrafts, /pageRows\.map\(\(item\) => normalizeDraftRow\(item\)\)/);
  assert.match(source, /effective_images: effectiveMedia\.images/);
  assert.match(developmentReviewViewSource, /loadReviewCatalogs/);
  assert.match(developmentReviewViewSource, /<el-table-column type="expand"/);
  assert.match(developmentReviewViewSource, /reviewTaskDetailRows\(row\)/);
  assert.match(developmentReviewViewSource, /reviewPersonAvatar\(row,'creator'\)/);
  assert.match(developmentReviewViewSource, /openTaskModelDraftPicker\(row, model\)/);
  assert.match(developmentReviewViewSource, /sales\.set\(Number\(task\.id\), result\?\.sales_by_task\?\.\[task\.id\]/);
  const taskRows = readFileSync(new URL("../src/services/team-tasks.js", import.meta.url), "utf8");
  assert.match(taskRows, /creator\.name AS created_by_name/);
  assert.match(taskRows, /created_by_avatar_url: row\.created_by_avatar_url/);
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

test("publish records filter by Beijing update days and summarize every variant SKU", () => {
  const records = source.match(/export async function listingPublishRecords[\s\S]*?export async function listingDraftProjects/)?.[0] || "";
  assert.match(viewSource, /params\.set\("startUpdatedDate", state\.updatedRange\[0\]\)/);
  assert.match(viewSource, /params\.set\("endUpdatedDate", state\.updatedRange\[1\]\)/);
  assert.match(records, /r\.updated_at >= \?/);
  assert.match(records, /r\.updated_at < DATE_ADD\(\?, INTERVAL 1 DAY\)/);
  assert.match(records, /T00:00:00\+08:00/);
  assert.match(records, /AS variant_count/);
  assert.match(records, /AS sku_count/);
  assert.match(viewSource, /function hasSyncedSku\(row\)/);
  assert.match(viewSource, /v-if="hasSyncedSku\(row\)" link type="primary" @click="openSkuReview\(row\)"/);
  assert.match(viewSource, /@click="editInListingAutomation\(row\)"/);
});
