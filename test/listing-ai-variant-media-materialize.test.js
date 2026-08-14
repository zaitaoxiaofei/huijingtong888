import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const serviceSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const aiVariantLabSource = readFileSync(new URL("../src/services/ai-variant-lab.js", import.meta.url), "utf8");

test("AI variant templates materialize media before template insert", () => {
  assert.match(serviceSource, /let payload = normalizeTemplatePayload\(body\)/);
  assert.match(serviceSource, /payload = await materializeAiOptimizationTemplateMedia\(payload, session\)/);
  assert.match(serviceSource, /payload = await materializeListingTemplateMediaForDraftSafety\(payload, session\)/);
  assert.match(serviceSource, /assertTemplateMediaIsPublishable\(payload, "模板"\)/);
  assert.match(serviceSource, /async function materializeAiOptimizationTemplateMedia/);
  assert.match(serviceSource, /async function materializeListingTemplateMediaForDraftSafety/);
  assert.match(serviceSource, /syncAiOptimizationTemplateImages\(/);
  assert.match(serviceSource, /registerListingMediaAsset\(/);
  assert.match(serviceSource, /ensureListingMediaPublicUrl\(/);
});

test("AI variant drafts materialize source images before draft insert", () => {
  assert.match(serviceSource, /await materializeListingDraftMediaForDraftSafety\(\s*await materializeAiOptimizationDraftMedia\(normalizeDraftPayload\(body\), session\),\s*session\s*\)/);
  assert.match(serviceSource, /assertDraftMediaIsPublishable\(payload, "草稿"\)/);
  assert.match(serviceSource, /source_images: sourceImages/);
  assert.match(serviceSource, /role: "draft_source_image"/);
});

test("draft saves skip media materialization when every media URL is already public", () => {
  const safetySource = serviceSource.match(/async function materializeListingDraftMediaForDraftSafety[\s\S]*?function assertNoEmbeddedMediaForPersistence/)?.[0] || "";
  assert.match(safetySource, /const mediaUrls = normalizedDraftMediaUrls\(normalized\)/);
  assert.match(safetySource, /mediaUrls\.every\(\(url\) => isPublishableMediaUrlForOzon\(url\)\)/);
  assert.match(safetySource, /assertNoEmbeddedMediaForPersistence\(normalized, "listing draft"\)/);
  assert.match(safetySource, /backend\.draft\.media\.fast_path/);
  assert.match(safetySource, /return normalized/);
});

test("global draft safety warns on local or preview media without blocking drafts", () => {
  assert.match(serviceSource, /function assertTemplateMediaIsPublishable/);
  assert.match(serviceSource, /function assertDraftMediaIsPublishable/);
  assert.match(serviceSource, /function findNonPublishableMediaUrls/);
  assert.match(serviceSource, /function isPublishableMediaUrlForOzon/);
  assert.match(serviceSource, /!isPublishableMediaUrlForOzon\(item\)/);
  assert.match(serviceSource, /if \(\s*\/\^https:\\\/\\\/\//);
  assert.match(serviceSource, /test\(value\)\) return true/);
  assert.match(serviceSource, /status: "already_https_media"/);
  assert.match(serviceSource, /if \(\s*\/\^http:\\\/\\\/\//);
  assert.match(serviceSource, /continuing without local media blocking/);
  assert.match(serviceSource, /return false/);
  assert.doesNotMatch(serviceSource, /禁止保存草稿。请先完成图片公网发布/);
});

test("publish media repair is reusable and runs before Ozon submit", () => {
  assert.match(serviceSource, /export async function repairOzonPublishPayloadMedia/);
  assert.match(serviceSource, /collectPublishPayloadMediaUrls\(payload\)/);
  assert.match(serviceSource, /await materializeListingMediaUrl\(url,/);
  assert.match(serviceSource, /replacePayloadMediaUrls\(payload, replacements\)/);
  assert.match(serviceSource, /const mediaRepair = await repairOzonPublishPayloadMedia\(shopPayload/);
  assert.match(serviceSource, /function assertPublishPayloadHasOnlyPublicMedia\(payload = \{\}, validation = null\)/);
  assert.match(serviceSource, /throw error;/);
  assert.match(serviceSource, /assertPublishPayloadHasOnlyPublicMedia\(finalPayload\)/);
  assert.match(serviceSource, /sourceModule: "listing_publish"/);
  assert.match(serviceSource, /sourceModule: "listing_publish_record_submit"/);
  assert.match(serviceSource, /sourceModule: "listing_publish_retry"/);
  assert.match(serviceSource, /media_repair_summary/);
  assert.match(serviceSource, /function collectLocalImportMedia\(payload = \{\}\) \{\s*return collectPublishPayloadMediaUrls\(payload\)\.filter\(isLocalImportMedia\);/);
});

test("listing editor media repair reuses materialization for images and videos", () => {
  assert.match(serviceSource, /export async function repairListingEditorMedia/);
  assert.match(serviceSource, /source_module: body\.sourceModule \|\| body\.source_module \|\| "listing_editor_media_repair"/);
  assert.match(serviceSource, /if \(isPublishableMediaUrlForOzon\(sourceUrl\)\) return sourceUrl/);
  assert.match(serviceSource, /await materializeListingMediaUrl\(sourceUrl, \{ \.\.\.metadata, role \}, session, urlMap\)/);
  assert.match(serviceSource, /video_cover_urls: videoCoverUrls/);
  assert.match(serviceSource, /video_urls: videoUrls/);
});

test("historical AI media repair also sweeps local listing media and localhost draft URLs", () => {
  assert.match(serviceSource, /source_images_json LIKE '%\/uploads\/listing-media\/%'/);
  assert.match(serviceSource, /template_payload_json LIKE '%localhost%'/);
  assert.match(serviceSource, /template_payload_json LIKE '%127\.0\.0\.1%'/);
  assert.match(serviceSource, /payload = await materializeListingDraftMediaForDraftSafety\(payload, session\)/);
  assert.match(serviceSource, /payload = sanitizeDraftMediaPayload\(await rewriteDraftPayloadToRegisteredPublicMedia\(payload\)\)/);
});

test("AI file URLs are normalized into fetchable sources before media registration", () => {
  assert.match(serviceSource, /function normalizeListingMediaSourceUrl/);
  assert.match(serviceSource, /value\.startsWith\("\/api\/ai\/file\/"\)/);
  assert.match(serviceSource, /new URL\(value, normalizeListingMediaSourceBaseUrl\(\)\)\.toString\(\)/);
  assert.match(serviceSource, /const fetchableUrl = normalizeListingMediaSourceUrl\(value\)/);
  assert.match(serviceSource, /return resolvePreviewAiTaskMedia\(taskId, scope, filename\)/);
  assert.match(serviceSource, /function resolvePreviewAiTaskMedia/);
  assert.match(serviceSource, /dist", "preview", "uploads"/);
});

test("listing media public sync has a bounded timeout", () => {
  assert.match(serviceSource, /const LISTING_MEDIA_PUBLIC_SYNC_TIMEOUT_MS = Math\.max\(10000, Math\.min\(180000, Number\(config\.listingMediaPublicSyncTimeoutMs \|\| 60000\)\)\)/);
  assert.match(serviceSource, /signal: AbortSignal\.timeout\(LISTING_MEDIA_PUBLIC_SYNC_TIMEOUT_MS\)/);
});

test("AI variant save path emits segmented performance logs", () => {
  assert.match(serviceSource, /function logAiVariantSavePerf/);
  assert.match(serviceSource, /backend\.template\.materialize_media/);
  assert.match(serviceSource, /backend\.draft\.normalize_and_materialize/);
  assert.match(serviceSource, /backend\.media\.url/);
  assert.match(serviceSource, /backend\.media\.public_sync/);
});

test("AI variant persistence accepts managed OSS media without a local filesystem URL", () => {
  const managedOssFastPath = serviceSource.match(/if \(isManagedOssObjectUrl\(sourceUrl\) && !isManagedOssObjectUrl\(sourceUrl, \{ prefix: "ai-unused" \}\)\) \{[\s\S]*?status: "managed_oss_media",[\s\S]*?\n  \}/)?.[0] || "";
  assert.match(managedOssFastPath, /localUrl: ""/);
  assert.match(managedOssFastPath, /publishUrl: sourceUrl/);
  assert.doesNotMatch(managedOssFastPath, /promoted\./);
  assert.match(aiVariantLabSource, /!persisted\?\.finalUrl \|\| \(!persisted\?\.publishUrl && !persisted\?\.localUrl\)/);
});

test("AI variant asset records materialize temporary AI file URLs", () => {
  assert.match(serviceSource, /const payload = await normalizeListingAiVariantAssetPayloadForSave\(normalizeListingAiVariantAssetPayload\(body, session\), session\)/);
  assert.match(serviceSource, /async function normalizeListingAiVariantAssetPayloadForSave\(payload = \{\}, session = null\)/);
  assert.match(serviceSource, /payload\.field_key !== "main_image"/);
  assert.match(serviceSource, /\/\\\/api\\\/ai\\\/file\\\//);
  assert.match(serviceSource, /await materializeListingMediaUrlRecord\(sourceUrl/);
  assert.match(serviceSource, /role: "ai_variant_main_image"/);
  assert.match(serviceSource, /originalAiFileUrl/);
  assert.match(serviceSource, /const stableExistingUrl = \[asset\.publishUrl, asset\.localUrl, asset\.downloadUrl\]/);
  assert.match(serviceSource, /const normalizedUrl = finalUrl \|\| stableExistingUrl \|\| ""/);
  assert.match(serviceSource, /url: normalizedUrl/);
  assert.match(serviceSource, /materializationStatus/);
  assert.match(serviceSource, /listingMediaAssetId/);
});

test("AI variant asset writes are atomic and safe under concurrent video saves", () => {
  const saveSource = serviceSource.match(/export async function saveListingAiVariantAsset[\s\S]*?async function normalizeListingAiVariantAssetPayloadForSave/)?.[0] || "";
  assert.match(saveSource, /ON DUPLICATE KEY UPDATE/);
  assert.match(saveSource, /id = LAST_INSERT_ID\(id\)/);
  assert.match(saveSource, /status = 'active'/);
  assert.doesNotMatch(saveSource, /SELECT id FROM listing_ai_variant_assets/);
});

test("AI variant lightweight draft save materializes AI media before draft insert and protects sibling variants", () => {
  assert.match(serviceSource, /export async function createAiVariantListingDraftLightweight/);
  assert.match(serviceSource, /backend\.ai_variant_light_draft\.start/);
  assert.match(serviceSource, /function findExistingAiVariantDraft/);
  assert.match(serviceSource, /manual_facts_json LIKE \? OR ai_payload_json LIKE \?/);
  const lightweightSource = serviceSource.match(/export async function createAiVariantListingDraftLightweight[\s\S]*?function applyAiVariantDraftPatch/)?.[0] || "";
  assert.match(lightweightSource, /materializeAiOptimizationDraftMedia/);
  assert.match(lightweightSource, /template_payload:/);
  assert.match(lightweightSource, /assertAiVariantDraftHasNoTemporaryImages\(payload\)/);
  assert.match(lightweightSource, /manualFacts = objectValue\(payload\.manual_facts \|\| manualFacts\)/);
  assert.match(serviceSource, /forceDraftTemplateImages\(materializedTemplatePayload, sourceImages\)/);
  assert.match(lightweightSource, /findDuplicateAiMaterialOptimizerDraft\(body, session\)/);
  assert.match(serviceSource, /source_main_image_url/);
  assert.match(serviceSource, /该产品使用相同主图的素材优化草稿已存在/);
  assert.match(lightweightSource, /optimizationSource === "ai_product_material_optimizer"[\s\S]*\? "copy"/);
  assert.match(lightweightSource, /explicit material-optimizer type must win/);
  assert.match(serviceSource, /SET development_type = 'copy'[\s\S]*ai_product_material_optimizer/);
  assert.match(serviceSource, /SET development_type = 'copy', vehicle_brand = '', vehicle_model = '', vehicle_model_key = ''/);
});

test("AI variant draft save rejects temporary AI image URLs that failed to materialize", () => {
  assert.match(serviceSource, /function assertAiVariantDraftHasNoTemporaryImages/);
  assert.match(serviceSource, /AI 裂变图片未能保存到永久素材库/);
});

test("AI variant offer ids override the source SKU and stay globally unique", () => {
  const lightweightSource = serviceSource.match(/export async function createAiVariantListingDraftLightweight[\s\S]*?function applyAiVariantDraftPatch/)?.[0] || "";
  assert.match(serviceSource, /function normalizeListingOfferId/);
  assert.match(serviceSource, /async function listingOfferIdExistsGlobally/);
  assert.match(lightweightSource, /AI 裂变草稿缺少货号 offer_id/);
  assert.match(lightweightSource, /internal_code: offerId/);
  assert.match(lightweightSource, /listingOfferIdExistsGlobally\(offerId/);
  assert.match(serviceSource, /next\.offer_id = offerId/);
  assert.match(serviceSource, /offer_id: offerId, offerId/);
});

test("AI variant lightweight draft save writes an editable template snapshot", () => {
  const lightweightSource = serviceSource.match(/export async function createAiVariantListingDraftLightweight[\s\S]*?function applyAiVariantDraftPatch/)?.[0] || "";
  assert.match(serviceSource, /function normalizeAiVariantSourceTemplateSnapshot/);
  assert.match(serviceSource, /function mergeAiVariantTemplateSnapshot/);
  assert.match(lightweightSource, /normalizeAiVariantSourceTemplateSnapshot\(body, templateId\)/);
  assert.match(lightweightSource, /mergeAiVariantTemplateSnapshot\(template, snapshotTemplate\)/);
  assert.doesNotMatch(lightweightSource, /Source listing template not found/);
  assert.match(lightweightSource, /upsertAiVariantListingDraftTemplate\(/);
  assert.match(lightweightSource, /payload\.template_id = draftTemplateId/);
  assert.match(serviceSource, /source_type, source_ozon_sku, source_raw_json,[\s\S]*'ai_optimization_v2_lightweight'/);
  assert.match(serviceSource, /function syncAiVariantTextAttributes/);
  assert.match(serviceSource, /item\.value = normalizedValue/);
  assert.match(serviceSource, /SELECT id, template_id[\s\S]*FROM listing_drafts/);
});

test("AI variant lightweight draft save keeps generated descriptions on SKU variants", () => {
  assert.match(serviceSource, /function syncAiVariantVariantDescription/);
  assert.match(serviceSource, /attribute_id: existing\.attribute_id \|\| 4191/);
  assert.match(serviceSource, /value: text/);
  assert.match(serviceSource, /values: \[\{ value: text \}\]/);
  assert.match(serviceSource, /attributes: syncAiVariantTextAttributes\(variant\.attributes \|\| \[\], \{ description: text \}\)/);
  assert.match(serviceSource, /dynamicAttributes: nextDynamicAttributes/);
  assert.match(serviceSource, /return syncAiVariantVariantDescription\(nextVariant, description\)/);
});

test("AI variant lightweight draft save inherits shop copies from selected or source draft shops", () => {
  const lightweightSource = serviceSource.match(/export async function createAiVariantListingDraftLightweight[\s\S]*?function applyAiVariantDraftPatch/)?.[0] || "";
  assert.match(serviceSource, /async function resolveAiVariantDraftShopIds/);
  assert.match(serviceSource, /function normalizeAiVariantDraftShopIds/);
  assert.match(serviceSource, /body\.shop_ids \|\| body\.shopIds/);
  assert.match(serviceSource, /body\.source_draft_id \|\| body\.sourceDraftId/);
  assert.match(serviceSource, /FROM listing_shop_copies/);
  assert.match(lightweightSource, /await resolveAiVariantDraftShopIds\(body\)/);
  assert.match(lightweightSource, /await generateListingShopCopies\(draftId, \{ shop_ids: shopIds \}, session\)/);
  assert.match(lightweightSource, /detail\.shop_copy_count = shopCopies\.length/);
  assert.match(lightweightSource, /detail\.shop_copy_error = shopCopyError/);
});

test("AI variant drafts prefer current draft snapshots and merge SKU facts", () => {
  assert.match(serviceSource, /function mergeAiVariantAttributeSources/);
  assert.match(serviceSource, /snapshotVariants\.flatMap\(\(variant\) => collectVariantDynamicAttributeEntries\(variant\)\)/);
  assert.match(serviceSource, /function mergeAiVariantSnapshotVariants/);
  assert.match(serviceSource, /\.\.\.objectValue\(snapshotVariant\.dynamic_attributes/);
  assert.match(serviceSource, /function resolveAiVariantInheritedQuantity/);
  assert.match(serviceSource, /dynamic\["7202"\]\?\.value/);
  assert.match(serviceSource, /\[7202, 23249\]\.includes\(attrId\)/);
  assert.match(serviceSource, /\.map\(normalizeReliablePackageWeightG\)/);
});

test("AI variant lightweight draft save rejects corrupted question-mark text", () => {
  assert.match(serviceSource, /function hasBrokenAiVariantDraftText/);
  assert.match(serviceSource, /\\\?\{3,\}/);
  assert.match(serviceSource, /assertAiVariantDraftTextReadable\(\{ title, description \}\)/);
  assert.match(serviceSource, /AI variant draft text is corrupted/);
});

test("AI material optimizer draft clone selects the requested source variant", () => {
  assert.match(serviceSource, /body\.source_variant_key \|\| body\.sourceVariantKey/);
  assert.match(serviceSource, /variantSelectionKey\(variant, index\) === sourceVariantKey/);
  assert.match(serviceSource, /sourceVariants\[sourceVariantIndex\]/);
  assert.match(serviceSource, /已停止保存以避免继承错误变体/);
});

test("AI variant draft detail repairs stale base template references", () => {
  assert.match(serviceSource, /function repairAiVariantDraftTemplateReference/);
  assert.match(serviceSource, /template_source_type/);
  assert.match(serviceSource, /source\.includes\("ai_optimization_v2_lightweight"\)/);
  assert.match(serviceSource, /function aiVariantDraftTemplatePayloadLooksIncomplete/);
  assert.match(serviceSource, /function findCollectorTemplateForAiVariantDraft/);
  assert.match(serviceSource, /ozon_plugin_collected_products/);
  assert.match(serviceSource, /UPDATE listing_drafts[\s\S]*SET template_id = \?/);
  assert.match(serviceSource, /if \(repaired\) return assertDraftAccess\(draftId, session, false\)/);
});
