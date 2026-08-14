import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const listingSource = fs.readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const aiTaskSource = fs.readFileSync(new URL("../src/services/ai-generation-tasks.js", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const configSource = fs.readFileSync(new URL("../src/config.js", import.meta.url), "utf8");
const scheduledJobSource = fs.readFileSync(new URL("../src/services/scheduled-jobs.js", import.meta.url), "utf8");
const mysqlCutoverSource = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const assetVariantSource = fs.readFileSync(new URL("../src/services/asset-variant-engine.js", import.meta.url), "utf8");
const aiVariantDraftSaveSource = fs.readFileSync(new URL("../src/services/ai-variant-draft-save-batches.js", import.meta.url), "utf8");

test("listing persistence blocks embedded image and video base64 after OSS materialization", () => {
  assert.match(listingSource, /function assertNoEmbeddedMediaForPersistence/);
  assert.match(listingSource, /data:\(\?:image\|video\)/);
  assert.match(listingSource, /EMBEDDED_MEDIA_PERSISTENCE_BLOCKED/);
  assert.match(listingSource, /assertNoEmbeddedMediaForPersistence\(shopPayload, "listing publish request"\)/);
});

test("collector-box reads do not wait for the full listing schema warmup", () => {
  assert.match(listingSource, /async function ensureCollectorBoxReadSchema/);
  assert.match(listingSource, /SELECT 1 FROM ozon_plugin_collected_products LIMIT 0/);
  assert.match(listingSource, /export async function collectorBoxProducts[\s\S]{0,120}await ensureCollectorBoxReadSchema\(\)/);
  assert.match(listingSource, /export async function collectorBoxProductDetail[\s\S]{0,140}await ensureCollectorBoxReadSchema\(\)/);
});

test("publish snapshots do not duplicate collector source raw payloads", () => {
  assert.match(listingSource, /function compactListingPublishSnapshot/);
  assert.match(listingSource, /key !== "source_raw" && key !== "sourceRaw"/);
  assert.match(listingSource, /compactListingPublishSnapshot\(compactTemplateForEditor\(await standardizeListingTemplatePayload/);
});

test("template and draft persistence strips duplicated source raw payloads", () => {
  assert.match(listingSource, /function compactListingSourceProvenance/);
  assert.match(listingSource, /function compactListingPersistencePayload/);
  assert.match(listingSource, /JSON\.stringify\(compactListingSourceProvenance\(payload\.source_raw\)\)/);
  assert.match(listingSource, /JSON\.stringify\(compactListingPersistencePayload\(templatePayload \|\| \{\}\)\)/);
  assert.match(listingSource, /JSON\.stringify\(compactListingPersistencePayload\(aiPayload\)\)/);
});

test("asset variant template persistence strips duplicated collector payloads", () => {
  assert.match(assetVariantSource, /function compactAssetVariantSourceProvenance/);
  assert.match(assetVariantSource, /function compactAssetVariantPersistencePayload/);
  assert.match(assetVariantSource, /JSON\.stringify\(compactAssetVariantSourceProvenance\(templatePayload\.source_raw \|\| sourceRaw\)\)/);
  assert.match(assetVariantSource, /JSON\.stringify\(compactAssetVariantPersistencePayload\(templatePayload\.editable_payload \|\| editablePayload\)\)/);
});

test("successful AI variant draft saves discard completed queue payloads without breaking retries", () => {
  assert.match(aiVariantDraftSaveSource, /status = 'completed'[\s\S]{0,180}payload_json = '\{\}'/);
  assert.doesNotMatch(
    aiVariantDraftSaveSource.match(/SET status = 'failed'[\s\S]{0,220}/)?.[0] || "",
    /payload_json = '\{\}'/
  );
  assert.match(aiVariantDraftSaveSource, /const payload = JSON\.parse\(item\.payload_json \|\| "\{\}"\)/);
});

test("AI variant asset snapshots persist only bounded operational fields", () => {
  assert.match(listingSource, /function compactListingAiVariantPromptSnapshot/);
  assert.match(listingSource, /function compactListingAiVariantRowSnapshot/);
  assert.match(listingSource, /prompt_snapshot: compactListingAiVariantPromptSnapshot/);
  assert.match(listingSource, /row_snapshot: compactListingAiVariantRowSnapshot/);
  assert.doesNotMatch(
    listingSource.match(/function compactListingAiVariantPromptSnapshot[\s\S]*?\n}\n/)?.[0] || "",
    /promptVariables|sourceProduct|template_snapshot_json|productDNA/
  );
});

test("AI terminal task history is deleted in bounded batches after 30 days", () => {
  assert.match(aiTaskSource, /export async function cleanupAiGenerationTaskHistory/);
  assert.match(aiTaskSource, /status IN \('completed', 'failed', 'cancelled'\)/);
  assert.match(aiTaskSource, /retentionDays \|\| options\.retention_days \|\| 30/);
  assert.match(serverSource, /key: "ai_generation_history_cleanup"/);
  assert.match(serverSource, /config: \{ retentionDays: 30, batchSize: 1000 \}/);
});

test("scheduled job logs default to seven day retention", () => {
  assert.match(scheduledJobSource, /options\.successDays \|\| 7/);
  assert.match(scheduledJobSource, /options\.detailDays \|\| 7/);
  assert.match(serverSource, /successDays: 7,[\s\S]*detailDays: 7/);
});

test("new online product sync archives media before MySQL persistence", () => {
  assert.match(mysqlCutoverSource, /await prepareOnlineProductMediaForStorage\(item\)/);
  assert.match(mysqlCutoverSource, /buildOnlineProductPayload\(shopId, storageItem\)/);
  assert.match(mysqlCutoverSource, /mapWithConcurrencyMysql\(matchingItems, 2,/);
});

test("order sync reuses archived online-product media and compacts raw snapshots", () => {
  assert.match(mysqlCutoverSource, /const onlineSnapshot = await upsertOnlineProductFromOrderItemMysql\(shop, item\)/);
  assert.match(mysqlCutoverSource, /image_url: onlineSnapshot\?\.image_url \|\| ""/);
  assert.match(mysqlCutoverSource, /compactOnlineProductRawJson\(posting\)/);
});

test("order history exposes an exact business fingerprint before any dedupe is enabled", () => {
  assert.match(mysqlCutoverSource, /import \{ config \} from "\.\.\/config\.js"/);
  assert.match(mysqlCutoverSource, /function orderStatusHistoryBusinessFingerprintMysql/);
  assert.match(mysqlCutoverSource, /function orderStatusHistoryRowFingerprintMysql/);
  assert.match(mysqlCutoverSource, /payload\.delivery_date_begin \|\| null/);
  assert.match(mysqlCutoverSource, /payload\.warehouse_name \|\| ""/);
  assert.match(mysqlCutoverSource, /await recordOrderStatusHistoryMysql\(shop, posting, orderId, lifecycle, "sync", exists\)/);
  assert.match(configSource, /ORDER_HISTORY_DEDUPE_MODE/);
  assert.match(configSource, /\["off", "shadow", "enabled"\], "off"/);
  assert.match(mysqlCutoverSource, /dedupeMode !== "off"/);
  assert.match(mysqlCutoverSource, /dedupeMode === "enabled"/);
  assert.match(mysqlCutoverSource, /comparison failed; preserving history write/);
  assert.match(mysqlCutoverSource, /FORCE INDEX \(idx_order_status_history_order_time\)/);
  assert.match(mysqlCutoverSource, /function orderHistoryStateMayBeUnchangedMysql/);
  assert.match(mysqlCutoverSource, /orderHistoryStateMayBeUnchangedMysql\(previousOrder, payload\)/);
  assert.match(mysqlCutoverSource, /recordOrderStatusHistoryMysql\(shop, posting, orderId, lifecycle, "sync", exists\)/);
  assert.match(mysqlCutoverSource, /dedupe: \{[\s\S]{0,160}orderHistoryDedupeMetricsMysql/);
});

test("product merge undo history stores only fields consumed by the existing undo workflow", () => {
  assert.match(mysqlCutoverSource, /function compactProductMergeUndoSnapshotMysql/);
  for (const field of [
    "id", "name", "selection_id", "image_url", "purchase_url", "supplier_id", "logistics_rule_id",
    "purchase_cost", "package_weight_g", "listing_price_rub", "desired_profit_mode", "owner_person_id",
    "selection_status", "active", "parent_product_id"
  ]) assert.match(mysqlCutoverSource, new RegExp(`"${field}"`));
  assert.match(mysqlCutoverSource, /JSON\.stringify\(compactProductMergeUndoSnapshotMysql\(targetProduct\)\)/);
  assert.match(mysqlCutoverSource, /sourceProducts\.map\(\(product\) => compactProductMergeUndoSnapshotMysql\(product\)\)/);
});
