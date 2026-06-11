import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runtimeSource = readFileSync(new URL("../src/services/mysql-runtime-services.js", import.meta.url), "utf8");
const listingSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");

test("runtime online product edit draft uses listing standardizer wrapper", () => {
  assert.match(runtimeSource, /onlineProductListingEditDraft/);
  assert.match(runtimeSource, /onlineProductEditDraft:\s*onlineProductListingEditDraft/);
});

test("online product listing edit draft standardizes template before returning", () => {
  assert.match(listingSource, /export async function onlineProductListingEditDraft/);
  assert.match(listingSource, /onlineProductEditDraftMysql\(targetId\)/);
  assert.match(listingSource, /latestPublishRecordTemplateSnapshotForOnlineProduct/);
  assert.match(listingSource, /listing_publish_record_snapshot/);
  assert.match(listingSource, /standardizeListingTemplatePayload/);
  assert.match(listingSource, /sourceType:\s*"online_product_live"/);
  assert.match(listingSource, /mapping_diagnostics:\s*standardizedTemplate\.mapping_diagnostics/);
});

test("online product edit draft prefers latest saved publish record template snapshot", () => {
  assert.match(listingSource, /async function latestPublishRecordTemplateSnapshotForOnlineProduct/);
  assert.match(listingSource, /template_snapshot_json IS NOT NULL/);
  assert.match(listingSource, /ORDER BY updated_at DESC, id DESC/);
  assert.match(listingSource, /offer_id = \?/);
  assert.match(listingSource, /source_product_id = \?/);
  assert.match(listingSource, /ozon_product_id = \?/);
  assert.match(listingSource, /template: normalizeTemplatePayload\(snapshot\)/);
});
