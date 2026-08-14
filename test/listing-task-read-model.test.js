import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const listingAutomationSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const mysqlCutoverSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const publishRecordsSource = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");
const collectorBoxSource = readFileSync(new URL("../frontend/admin/views/listing/CollectorBoxView.vue", import.meta.url), "utf8");
const selectionSource = readFileSync(new URL("../frontend/admin/views/selection/SelectionView.vue", import.meta.url), "utf8");

test("listing task list derives progress through a read-only task-item summary", () => {
  const taskListSource = listingAutomationSource.match(/export async function listingPublishTasks[\s\S]*?export async function listingPublishTaskDetail/)?.[0] || "";
  assert.match(listingAutomationSource, /async function readOnlyListingPublishTaskStats\(taskIds = \[\]\)/);
  assert.match(taskListSource, /const statsByTaskId = await readOnlyListingPublishTaskStats\(ids\)/);
  assert.doesNotMatch(taskListSource, /markInterruptedListingPublishTaskItems\(/);
  assert.doesNotMatch(taskListSource, /syncListingPublishTaskItemsFromRecords\(/);
  assert.doesNotMatch(taskListSource, /refreshListingPublishTaskStats\(/);
});

test("listing task progress uses Ozon submission evidence instead of Ozon result status", () => {
  assert.match(listingAutomationSource, /progress_percent: total \? Math\.round\(\(submitted \/ total\) \* 100\) : 0/);
  assert.match(listingAutomationSource, /COALESCE\(r\.task_id, ''\) <> '' OR r\.response_json IS NOT NULL THEN 'submitted'/);
  assert.match(listingAutomationSource, /submittedToOzon\s*\?\s*"submitted"/);
  assert.match(listingAutomationSource, /storedStatus === "submitted"\s*\?\s*"processing"/);
  assert.match(listingAutomationSource, /const allowedRetryStatuses = new Set\(\["failed", "interrupted"\]\)/);
});

test("stale local submitted rows without Ozon evidence become retryable interruptions", () => {
  const interruptionSource = listingAutomationSource.match(/async function markInterruptedListingPublishTaskItems[\s\S]*?async function syncListingPublishTaskItemsFromRecords/)?.[0] || "";
  const syncSource = listingAutomationSource.match(/async function syncListingPublishTaskItemsFromRecords[\s\S]*?async function refreshListingPublishTaskStats/)?.[0] || "";
  const retryClaimSource = listingAutomationSource.match(/async function claimListingPublishTaskItemForRetry[\s\S]*?async function claimListingPublishTaskItemForSubmit/)?.[0] || "";

  assert.match(interruptionSource, /i\.status IN \('pending', 'preparing', 'processing', 'submitted'\)/);
  assert.match(interruptionSource, /r\.task_id, ''\) = '' AND r\.response_json IS NULL/);
  assert.match(interruptionSource, /r\.updated_at END\) <= DATE_SUB\(NOW\(\), INTERVAL 30 MINUTE\)/);
  assert.match(syncSource, /r\.status IN \('submitted', 'processing', 'resubmitting', 'ozon_status_pending'\)[\s\S]*r\.task_id/);
  assert.match(retryClaimSource, /record_task_id/);
  assert.match(retryClaimSource, /if \(String\(item\.record_task_id \|\| ""\)\.trim\(\) \|\| item\.record_response_json\) return null/);
});

test("task refresh qualifies status columns after joining publish records", () => {
  const refreshSource = listingAutomationSource.match(/async function refreshListingPublishTaskStats[\s\S]*?async function readOnlyListingPublishTaskStats/)?.[0] || "";
  assert.match(refreshSource, /CASE WHEN i\.status IN \('pending', 'preparing'\)/);
  assert.doesNotMatch(refreshSource, /CASE WHEN status IN/);
});

test("listing task rows expose direct time-person-shop display inputs", () => {
  assert.match(listingAutomationSource, /p\.name AS created_by_name/);
  assert.match(listingAutomationSource, /GROUP_CONCAT\(DISTINCT shop_name ORDER BY shop_name SEPARATOR '_'\) AS task_shop_names/);
  const taskListSource = listingAutomationSource.match(/export async function listingPublishTasks[\s\S]*?export async function listingPublishTaskDetail/)?.[0] || "";
  assert.doesNotMatch(taskListSource, /SELECT GROUP_CONCAT/);
});

test("listing tasks default to the current person, support selecting another person, and can retry cross-person failures", () => {
  const taskListSource = listingAutomationSource.match(/export async function listingPublishTasks[\s\S]*?export async function listingPublishTaskDetail/)?.[0] || "";
  assert.match(taskListSource, /t\.created_by_person_id = \?/);
  assert.match(taskListSource, /const viewerId = personId\(session\)/);
  assert.match(taskListSource, /query\.creatorId \|\| query\.creator_id/);
  const retrySource = listingAutomationSource.match(/export async function retryListingPublishTask[\s\S]*?async function processListingDraftBatchPublishTask/)?.[0] || "";
  assert.doesNotMatch(retrySource, /created_by_person_id.*personId\(session\)/);
  assert.match(retrySource, /const allowedRetryStatuses = new Set\(\["failed", "interrupted"\]\)/);
});

test("draft, publish, and selection pages filter by person while collector box remains shared", () => {
  assert.match(publishRecordsSource, /v-model="state\.creatorId" filterable placeholder="人员"/);
  assert.match(publishRecordsSource, /const currentPersonId = computed/);
  assert.doesNotMatch(collectorBoxSource, /v-model="state\.filters\.creatorId"/);
  assert.match(selectionSource, /ownerPersonId: String\(authStore\.user\?\.id \|\| ""\)/);
  assert.match(selectionSource, /ownerPersonId: String\(state\.filters\.ownerPersonId \|\| currentUserPersonId\.value \|\| "all"\)/);
  assert.match(listingAutomationSource, /r\.created_by_person_id = \?/);
});

test("order status counts are queried directly instead of using a process-local cache", () => {
  const countSource = mysqlCutoverSource.match(/async function orderPagedSqlCountsMysql[\s\S]*?export async function ordersPagedMysql/)?.[0] || "";
  assert.match(countSource, /const row = await mysqlQueryOne/);
  assert.doesNotMatch(countSource, /getCachedMasterData\(/);
  assert.doesNotMatch(countSource, /orders:counts:/);
});
