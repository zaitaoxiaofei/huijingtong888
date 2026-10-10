import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const service = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

test("tenant-scoped listing publish and project reads are enabled without opening mutations", () => {
  const session = { tenant: { id: 42, slug: "company-a" } };
  for (const [method, parts] of [
    ["POST", ["api", "listing", "publish-tasks", "12", "retry"]],
    ["POST", ["api", "listing", "drafts", "batch-publish"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, false);
  assert.equal(tenantIsolationDecision(session, ["api", "listing", "publish-tasks"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "listing", "publish-tasks", "12"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "listing", "publish-records"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "listing", "publish-records", "12"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "listing", "draft-projects"], "GET").allowed, true);
  for (const [method, parts] of [
    ["POST", ["api", "listing", "publish-records", "12", "refresh"]],
    ["POST", ["api", "listing", "publish-records", "12", "retry"]],
    ["DELETE", ["api", "listing", "publish-records", "batch-delete"]],
    ["POST", ["api", "listing", "publish-records", "unknown"]]
  ]) assert.equal(tenantIsolationDecision(session, parts, method).allowed, false);
  assert.equal(tenantIsolationDecision(session, ["api", "listing", "publish-records", "12"], "DELETE").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "listing", "publish-records", "batch-delete"], "POST").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "listing", "publish-records", "12", "draft"], "POST").allowed, true);
  assert.equal(tenantIsolationDecision(session, ["api", "listing", "publish-records", "not-numeric", "draft"], "POST").allowed, false);
});

test("publish task reads, writes, retries, and record joins are tenant-bound", () => {
  const create = service.slice(service.indexOf("async function createListingPublishTask"), service.indexOf("export async function listingPublishTasks"));
  const list = service.slice(service.indexOf("export async function listingPublishTasks"), service.indexOf("export async function listingPublishTaskDetail"));
  const detail = service.slice(service.indexOf("export async function listingPublishTaskDetail"), service.indexOf("async function claimListingPublishTaskItemForRetry"));
  const retry = service.slice(service.indexOf("export async function retryListingPublishTask"), service.indexOf("async function processListingDraftBatchPublishTask"));
  const publish = service.slice(service.indexOf("export async function publishListingDraftsToOzon("), service.indexOf("export async function publishListingDraftsToOzonSync"));
  const recordList = service.slice(service.indexOf("export async function listingPublishRecords"), service.indexOf("export async function listingDraftProjects"));
  const projects = service.slice(service.indexOf("export async function listingDraftProjects"), service.indexOf("export async function listingPublishRecordDetail"));
  const recordDetail = service.slice(service.indexOf("export async function listingPublishRecordDetail"), service.indexOf("export async function refreshListingPublishRecord"));

  assert.match(create, /const tenantId = listingTenantId\(session\)/);
  assert.match(create, /existingListingPublishTaskByRequestId\(requestId, session\)/);
  assert.match(create, /COALESCE\(tenant_id, 'admin'\) = \?/);
  assert.match(create, /INSERT INTO listing_publish_tasks\s*\(tenant_id,/);
  assert.match(create, /INSERT INTO listing_publish_task_items\s*\(tenant_id,/);
  assert.match(list, /COALESCE\(t\.tenant_id, 'admin'\) = \?/);
  assert.match(list, /creator_members\.tenant_id = \?/);
  assert.match(list, /readOnlyListingPublishTaskStats\(ids, tenantId\)/);
  assert.match(detail, /t\.id = \? AND COALESCE\(t\.tenant_id, 'admin'\) = \?/);
  assert.match(detail, /creator_members\.tenant_id = \?/);
  assert.match(detail, /i\.publish_task_id = \? AND COALESCE\(i\.tenant_id, 'admin'\) = \?/);
  assert.match(detail, /COALESCE\(r\.tenant_id, 'admin'\) = COALESCE\(i\.tenant_id, 'admin'\)/);
  assert.match(retry, /WHERE id IN \(\$\{shopIds\.map\(\(\) => "\?"\)\.join\(","\)\}\).*COALESCE\(tenant_id, 'admin'\) = \?/s);
  assert.match(retry, /claimListingPublishTaskItemForRetry\(item\.id, tenantId\)/);
  assert.match(retry, /updateListingPublishTaskItem\(item\.id, \{[\s\S]*?\}, tenantId\)/);
  assert.match(publish, /const tenantId = listingTenantId\(session\)/);
  assert.match(publish, /COALESCE\(tenant_id, 'admin'\) = \?/);
  assert.match(publish, /COALESCE\(tenant_id, 'admin'\) = \?\s*`/);
  assert.match(recordList, /const tenantId = listingTenantId\(session\)/);
  assert.match(recordList, /COALESCE\(r\.tenant_id, 'admin'\) = \?/);
  assert.match(recordList, /COALESCE\(s\.tenant_id, 'admin'\) = COALESCE\(r\.tenant_id, 'admin'\)/);
  assert.match(recordList, /creator_members\.tenant_id = \?/);
  assert.match(recordList, /\$\{fromSql\}[\s\S]*LIMIT \?\s*`, \[\.\.\.params, limit\]\)/);
  assert.match(projects, /listingPublishProjectCandidates\(query, candidateLimit, session\)/);
  assert.match(projects, /COALESCE\(r\.tenant_id, 'admin'\) = \?/);
  assert.match(projects, /COALESCE\(s\.tenant_id, 'admin'\) = COALESCE\(r\.tenant_id, 'admin'\)/);
  assert.match(projects, /COALESCE\(d\.tenant_id, 'admin'\) = \?/);
  assert.match(projects, /draft_creator_members\.tenant_id = \?/);
  assert.match(recordDetail, /const tenantId = listingTenantId\(session\)/);
  assert.match(recordDetail, /COALESCE\(s\.tenant_id, 'admin'\) = COALESCE\(r\.tenant_id, 'admin'\)/);
  assert.match(recordDetail, /s\.id IS NOT NULL/);
  assert.match(recordDetail, /r\.id = \? AND r\.status <> 'deleted' AND COALESCE\(r\.tenant_id, 'admin'\) = \?/);

  const deleteOne = service.slice(service.indexOf("export async function deleteListingPublishRecord("), service.indexOf("export async function deleteListingPublishRecords"));
  const deleteMany = service.slice(service.indexOf("export async function deleteListingPublishRecords"), service.indexOf("export async function updateListingCategoryTemplate"));
  assert.match(deleteOne, /const tenantId = listingTenantId\(session\)/);
  assert.match(deleteOne, /SELECT id FROM listing_publish_records WHERE id = \? AND status <> 'deleted' AND \$\{tenantScope\}/);
  assert.match(deleteOne, /WHERE id = \? AND status <> 'deleted' AND \$\{tenantScope\}/);
  assert.match(deleteMany, /const tenantId = listingTenantId\(session\)/);
  assert.match(deleteMany, /id IN \(\$\{placeholders\}\) AND \$\{tenantScope\}/);
  assert.match(deleteMany, /\[\.\.\.ids, tenantId\]/);

  const saveDraft = service.slice(service.indexOf("export async function saveListingPublishRecordDraft"), service.indexOf("export async function deleteListingPublishRecord"));
  assert.match(saveDraft, /const tenantId = listingTenantId\(session\)/);
  assert.match(saveDraft, /WHERE r\.id = \? AND r\.status <> 'deleted' AND \$\{tenantScope\} AND s\.id IS NOT NULL/);
  assert.match(saveDraft, /COALESCE\(s\.tenant_id, 'admin'\) = COALESCE\(r\.tenant_id, 'admin'\)/);
  assert.match(saveDraft, /status NOT IN \('submitted', 'processing', 'resubmitting', 'ozon_status_pending'\)/);
  assert.match(saveDraft, /AND \$\{tenantWriteScope\} AND updated_at = \?[\s\S]*?AND request_json <=> \? AND offer_id <=> \?/);
  assert.match(saveDraft, /Number\(id\), tenantId, record\.updated_at, record\.request_json, record\.offer_id/);
  assert.match(saveDraft, /Number\(saveResult\?\.affectedRows \|\| 0\) === 0/);
  assert.match(saveDraft, /if \(!updated\) throw listingPublishRecordNotFoundError\(\)/);
});
