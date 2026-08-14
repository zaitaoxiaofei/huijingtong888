import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
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

test("publish record table reads lightweight list summaries instead of request payloads", () => {
  const records = source.match(/export async function listingPublishRecords[\s\S]*?export async function listingDraftProjects/)?.[0] || "";
  const listSelect = records.match(/const listRecordSelectSql = `[\s\S]*?`;/)?.[0] || "";
  assert.match(listSelect, /JSON_EXTRACT\(r\.list_summary_json, '\$\.name'\)/);
  assert.match(listSelect, /JSON_EXTRACT\(r\.list_summary_json, '\$\.primary_image'\)/);
  assert.doesNotMatch(listSelect, /JSON_EXTRACT\(r\.request_json/);
});
