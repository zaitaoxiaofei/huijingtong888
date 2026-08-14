import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

test("batch listing publish claims each pending task item before building its payload", () => {
  const batchSource = source.match(/async function processListingDraftBatchPublishTask[\s\S]*?export async function publishListingDraftsToOzon/)?.[0] || "";
  assert.match(source, /async function claimListingPublishTaskItemForSubmit\(itemId = 0\)/);
  assert.match(source, /WHERE id = \?\s+FOR UPDATE/);
  assert.match(batchSource, /const claim = await claimListingPublishTaskItemForSubmit\(taskItemId\)/);
  assert.ok(batchSource.indexOf("claimListingPublishTaskItemForSubmit(taskItemId)") < batchSource.indexOf("buildShopPublishPayloadForOzon"));
});

test("duplicate publish-record keys recover the existing task record for retries", () => {
  const retryClaimSource = source.match(/async function claimListingPublishTaskItemForRetry[\s\S]*?async function claimListingPublishTaskItemForSubmit/)?.[0] || "";
  assert.match(retryClaimSource, /WHERE publish_task_item_id = \? AND status <> 'deleted'/);
  assert.match(retryClaimSource, /record_id = COALESCE\(\?, record_id\)/);
  assert.match(source, /WHERE publish_task_item_id = \? AND status <> 'deleted'/);
  assert.match(source, /reused: true/);
});

test("task retries preserve Ozon failures instead of treating them as submitted", () => {
  const taskStatusSource = source.match(/function normalizePublishTaskItemRow[\s\S]*?async function markInterruptedListingPublishTaskItems/)?.[0] || "";
  const recordSyncSource = source.match(/async function syncListingPublishTaskItemsFromRecords[\s\S]*?async function refreshListingPublishTaskStats/)?.[0] || "";
  assert.match(taskStatusSource, /\["imported", "published", "success", "failed", "ozon_status_error"/);
  assert.match(taskStatusSource, /\["interrupted", "failed"\]\.includes\(storedStatus\)/);
  assert.match(recordSyncSource, /WHEN r\.status IN \('failed', 'ozon_status_error'\) THEN 'failed'[\s\S]*?WHEN COALESCE\(r\.task_id, ''\) <> '' OR r\.response_json IS NOT NULL THEN 'submitted'/);
});
