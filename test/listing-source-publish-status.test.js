import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const serviceSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");
const draftsViewSource = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");
const collectorViewSource = readFileSync(new URL("../frontend/admin/views/listing/CollectorBoxView.vue", import.meta.url), "utf8");

test("listing editor submits draft and collector source identifiers", () => {
  assert.match(editorSource, /source_draft_id:\s*template\.source_raw\?\.listing_draft_id/);
  assert.match(editorSource, /source_collector_sku:\s*collectorSourceSku\.value/);
});

test("publish records persist source identifiers without a blocking startup backfill", () => {
  assert.match(serviceSource, /source_collector_sku, publish_task_id/);
  assert.doesNotMatch(serviceSource, /UPDATE listing_publish_records\s+SET draft_id = COALESCE/s);
});

test("draft and collector inboxes expose a separate publish status", () => {
  assert.match(serviceSource, /AS publish_status/);
  assert.match(draftsViewSource, /label="上架状态"/);
  assert.match(collectorViewSource, /label="上架状态"/);
  assert.match(draftsViewSource, /尚未提交到 Ozon/);
  assert.match(collectorViewSource, /尚未提交到 Ozon/);
});
