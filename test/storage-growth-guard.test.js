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
const remoteReleaseSource = fs.readFileSync(new URL("../deploy/linux/remote-release.sh", import.meta.url), "utf8");
const memoryTuningSource = fs.readFileSync(new URL("../deploy/linux/apply-ecs-memory-tuning.sh", import.meta.url), "utf8");

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

test("publish records rebuild editor snapshots instead of persisting a duplicate full template", () => {
  assert.match(listingSource, /const templateSnapshotJson = null/);
  assert.match(listingSource, /item\.template_snapshot_json = JSON\.stringify\(compactListingPublishSnapshot/);
  assert.doesNotMatch(listingSource, /SET template_snapshot_json = \?, updated_at = CURRENT_TIMESTAMP\s+WHERE id = \? AND \(template_snapshot_json IS NULL/);
  assert.match(listingSource, /SET request_json = \?, template_snapshot_json = NULL/);
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

test("terminal publish records compact reproducible editor snapshots in bounded hourly batches", () => {
  assert.match(listingSource, /export async function compactListingPublishRecordStorage/);
  assert.match(listingSource, /snapshotRetentionDays[\s\S]{0,900}LIMIT \?/);
  assert.match(serverSource, /key: "listing_publish_storage_compaction"[\s\S]{0,260}intervalMinutes: 60/);
  assert.match(serverSource, /key: "listing_publish_storage_compaction"[\s\S]{0,360}snapshotRetentionDays: 7, limit: 500/);
});

test("stale Ozon publish tasks reconcile by offer before becoming retryable failures", () => {
  assert.match(listingSource, /task not found/i);
  assert.match(listingSource, /ageMs < 24 \* 60 \* 60 \* 1000/);
  assert.match(listingSource, /expired_task_discovered_on_ozon/);
  assert.match(listingSource, /OZON_IMPORT_TASK_EXPIRED/);
  assert.match(listingSource, /images: uniqueStringValues\(\[\.\.\.\(images\.slice\(1\)\)/);
  assert.match(listingSource, /maxAgeDays \|\| 60/);
  assert.match(serverSource, /key: "listing_publish_record_sync"[\s\S]{0,320}limit: 20,[\s\S]{0,100}maxAgeDays: 60/);
  assert.match(scheduledJobSource, /VALUES\(job_key\) = 'listing_publish_record_sync'[\s\S]{0,180}maxAgeDays/);
});

test("interrupted batch preparation also releases the matching unsubmitted publish record", () => {
  assert.match(listingSource, /JOIN listing_publish_task_items i ON i\.record_id = r\.id/);
  assert.match(listingSource, /r\.status = 'failed'/);
  assert.match(listingSource, /COALESCE\(r\.task_id, ''\) = ''[\s\S]{0,80}r\.response_json IS NULL/);
});

test("image proxy degrades through stale cache or a successful placeholder instead of returning 502", () => {
  assert.match(serverSource, /readCachedRemoteImage\(target, \{ allowStale: true \}\)/);
  assert.match(serverSource, /sendRemoteImageBuffer\(res, stale, "STALE"\)/);
  assert.doesNotMatch(serverSource, /function sendImageProxyUnavailable/);
});

test("small ECS disks warn before remaining capacity becomes urgent", () => {
  const monitorSource = fs.readFileSync(new URL("../src/services/system-monitoring.js", import.meta.url), "utf8");
  assert.match(monitorSource, /WARNING_USAGE_PERCENT = 65/);
  assert.match(monitorSource, /CRITICAL_USAGE_PERCENT = 80/);
  assert.match(monitorSource, /WARNING_AVAILABLE_BYTES = 10 \* 1024 \*\* 3/);
  assert.match(monitorSource, /severityFor\(usagePercent, availableBytes, dailyGrowthBytes\)/);
});

test("ECS memory tuning keeps failover while bounding caches and swap pressure", () => {
  assert.match(remoteReleaseSource, /PORT='\$candidate_port'[\s\S]{0,220}--max-old-space-size=384/);
  assert.match(memoryTuningSource, /max_connections = 60/);
  assert.match(memoryTuningSource, /table_open_cache = 2000/);
  assert.match(memoryTuningSource, /vm\.swappiness = 10/);
  assert.match(memoryTuningSource, /mysqld --validate-config/);
  assert.match(memoryTuningSource, /systemctl restart mysql/);
  assert.match(memoryTuningSource, /api\/ready/);
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
