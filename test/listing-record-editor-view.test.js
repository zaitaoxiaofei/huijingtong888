import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../frontend/admin/views/listing/ListingRecordEditorView.vue", import.meta.url), "utf8");
const publishRecordsSource = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");
const collectorBoxSource = readFileSync(new URL("../frontend/admin/views/listing/CollectorBoxView.vue", import.meta.url), "utf8");
const listingAutomationSource = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");
const aiOptimizationWorkbenchSource = readFileSync(new URL("../frontend/admin/views/listing/AiOptimizationWorkbenchV2.vue", import.meta.url), "utf8");
const assetVariantCenterSource = readFileSync(new URL("../frontend/admin/views/listing/AssetVariantCenter.vue", import.meta.url), "utf8");
const aiWorkbenchProxySource = readFileSync(new URL("../public/ai-workbench-proxy/assets/AiOptimizationWorkbenchV2-BDMw-MxS-codex-empty-boundary-20260613110500.js", import.meta.url), "utf8");
const listingAutomationRouteSource = readFileSync(new URL("../src/server/routes/listingAutomation.js", import.meta.url), "utf8");
const listingAutomationServiceSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const mysqlRuntimeServicesSource = readFileSync(new URL("../src/services/mysql-runtime-services.js", import.meta.url), "utf8");
const assetVariantServiceSource = readFileSync(new URL("../src/services/asset-variant-engine.js", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../frontend/admin/router/index.js", import.meta.url), "utf8");
const navigationSource = readFileSync(new URL("../frontend/admin/constants/navigation.js", import.meta.url), "utf8");

test("listing record editor loads standardized template snapshot before raw request", () => {
  assert.match(source, /function buildTemplateFromDetailRow\(row\)/);
  assert.match(source, /const snapshot = plainClone\(row\.template_snapshot, null\)/);
  assert.match(source, /if \(snapshot\?\.editable_payload\)/);
  assert.match(source, /sourceRaw\.from_publish_record = true/);
  assert.match(source, /template,/);
});

test("listing record editor has a safe local clone helper for snapshot drafts", () => {
  assert.match(source, /function plainClone\(value, fallback = null\)/);
  assert.match(source, /JSON\.parse\(JSON\.stringify\(value\)\)/);
});

test("listing automation loads publish records directly from recordId routes", () => {
  assert.match(listingAutomationSource, /const routeRecordRequest = recordId/);
  assert.match(listingAutomationSource, /apiClient\.get\(`\/api\/listing\/publish-records\/\$\{recordId\}`[\s\S]*catch\(handlePublishRecordRouteMissing\)/);
  assert.match(listingAutomationSource, /function handlePublishRecordRouteMissing\(error\)/);
  assert.match(listingAutomationSource, /message\.includes\("\\u4e0a\\u67b6\\u8bb0\\u5f55\\u4e0d\\u5b58\\u5728"\)/);
  assert.match(listingAutomationSource, /async function applyPublishRecordFromRoute\(routeRecord = null\)/);
  assert.match(listingAutomationSource, /function buildTemplateFromPublishRecord\(row = \{\}\)/);
  assert.match(listingAutomationServiceSource, /function listingPublishRecordNotFoundError\(\)/);
  assert.match(listingAutomationServiceSource, /error\.status = 404/);
});

test("listing automation saves record drafts without requiring a local sku template", () => {
  assert.match(listingAutomationSource, /const recordId = Number\(route\.query\.recordId/);
  assert.match(listingAutomationSource, /apiClient\.post\(`\/api\/listing\/publish-records\/\$\{recordId\}\/draft`/);
  assert.match(listingAutomationSource, /未提交 Ozon/);
  assert.match(listingAutomationRouteSource, /parts\[2\] === "publish-records" && parts\[3\] && parts\[4\] === "draft"/);
  assert.match(listingAutomationRouteSource, /services\.saveListingPublishRecordDraft/);
  assert.match(listingAutomationServiceSource, /export async function saveListingPublishRecordDraft/);
  assert.match(listingAutomationServiceSource, /UPDATE listing_publish_records[\s\S]*template_snapshot_json/);
});

test("publish record drawer gates large technical JSON behind explicit loading", () => {
  assert.match(publishRecordsSource, /drawerPayloadCache/);
  assert.match(publishRecordsSource, /drawerResponseCache/);
  assert.match(publishRecordsSource, /technicalJsonLoaded:\s*false/);
  assert.match(publishRecordsSource, /function loadDrawerTechnicalJson\(\)/);
  assert.match(publishRecordsSource, /v-if="drawer\.technicalJsonLoaded"/);
  assert.doesNotMatch(publishRecordsSource, /drawer\.payloadText\s*=\s*JSON\.stringify\(payload, null, 2\);\s*drawer\.visible = true/s);
  assert.doesNotMatch(publishRecordsSource, /:model-value="prettyJson\(\{ response: drawer\.row\.response, error: drawer\.row\.error \}\)"/);
});

test("listing drafts and publish records are split into separate menu routes", () => {
  assert.match(navigationSource, /key: "listing-records", label: "草稿箱", route: "\/listing-records"/);
  assert.match(navigationSource, /key: "listing-publish-records", label: "上架记录", route: "\/listing-publish-records"/);
  assert.match(routeSource, /name: "listing-records"[\s\S]*recordMode: "drafts"/);
  assert.match(routeSource, /name: "listing-publish-records"[\s\S]*recordMode: "publish"/);
  assert.match(publishRecordsSource, /params\.set\("view", "drafts"\)/);
  assert.match(publishRecordsSource, /\/api\/listing\/publish-records/);
});

test("listing draft box supports deleting single and selected drafts", () => {
  assert.match(publishRecordsSource, /apiClient\.delete\(`\/api\/listing\/drafts\/\$\{row\.id\}`\)/);
  assert.match(publishRecordsSource, /Promise\.all\(rows\.map\(\(row\) => apiClient\.delete\(`\/api\/listing\/drafts\/\$\{row\.id\}`\)\)\)/);
  assert.match(publishRecordsSource, /v-if="isDraftMode"[\s\S]*批量去上架/);
  assert.match(publishRecordsSource, /@click="batchDeleteRecords">批量删除/);
  assert.match(listingAutomationRouteSource, /req\.method === "DELETE" && parts\[2\] === "drafts" && parts\[3\]/);
  assert.match(listingAutomationRouteSource, /services\.deleteListingDraft\(Number\(parts\[3\]\), req\._session\)/);
  assert.match(listingAutomationServiceSource, /export async function deleteListingDraft\(id, session = null\)/);
  assert.match(listingAutomationServiceSource, /UPDATE listing_drafts[\s\S]*SET status = 'deleted'/);
});

test("listing draft box can send selected drafts to AI variant workbench", () => {
  assert.match(publishRecordsSource, /function batchOpenAiVariantWorkbench\(\)/);
  assert.match(publishRecordsSource, /name:\s*"asset-variant-center-wizard"/);
  assert.match(publishRecordsSource, /draftId:\s*String\(first\.id\)/);
  assert.match(publishRecordsSource, /draftIds:\s*rows\.map\(\(row\) => row\.id\)\.join\(","\)/);
  assert.match(publishRecordsSource, /@click="batchOpenAiVariantWorkbench">AI裂变/);
});

test("publish record deletion reloads a valid page and uses batch endpoint", () => {
  assert.match(publishRecordsSource, /async function reloadRecordsAfterDelete\(deletedCount = 1\)/);
  assert.match(publishRecordsSource, /if \(state\.page > lastPage\) state\.page = lastPage/);
  assert.match(publishRecordsSource, /await loadRecords\(\)/);
  assert.match(publishRecordsSource, /apiClient\.post\("\/api\/listing\/publish-records\/batch-delete", \{ ids: \[\.\.\.ids\] \}\)/);
  assert.match(listingAutomationRouteSource, /"POST \/api\/listing\/publish-records\/batch-delete"/);
  assert.match(listingAutomationServiceSource, /export async function deleteListingPublishRecords/);
  assert.match(mysqlRuntimeServicesSource, /deleteListingPublishRecords/);
  assert.match(listingAutomationServiceSource, /WHERE status <> 'deleted' AND id IN \(\$\{placeholders\}\)/);
});

test("collector box does not persist or render large raw payloads by default", () => {
  assert.doesNotMatch(collectorBoxSource, /detail:\s*detail\.value\s*\|\|\s*null/);
  assert.doesNotMatch(collectorBoxSource, /detail\.value\s*=\s*parsed\?\.detail\s*\|\|\s*null/);
  assert.match(collectorBoxSource, /rawPayloadPreviewLoaded/);
  assert.match(collectorBoxSource, /function loadRawPayloadPreview\(\)/);
  assert.match(collectorBoxSource, /v-if="!rawPayloadPreviewLoaded"/);
  assert.doesNotMatch(collectorBoxSource, /<pre class="payload-preview">\{\{ JSON\.stringify/);
});

test("listing draft list keeps heavy draft payloads out of list rows", () => {
  const draftProjectListSource = listingAutomationServiceSource.match(/async function listingDraftProjectCandidates[\s\S]*?export async function listingPublishRecordDetail/)?.[0] || "";
  assert.doesNotMatch(draftProjectListSource, /SELECT d\.\*, t\.category_name/);
  assert.match(draftProjectListSource, /'\{\}' AS manual_facts_json,\s*'\{\}' AS ai_payload_json/);
});

test("listing automation can generate variant video covers and videos from main images", () => {
  assert.match(listingAutomationRouteSource, /POST \/api\/listing\/variant-media\/generate/);
  assert.match(listingAutomationRouteSource, /services\.generateListingVariantMediaFromImage/);
  assert.match(listingAutomationSource, /function variantPrimaryImageUrl/);
  assert.match(listingAutomationSource, /function applyFirstVariantVideoMedia/);
  assert.match(listingAutomationSource, /applyFirstVariantVideoMedia\('video_cover_urls'\)/);
  assert.match(listingAutomationSource, /applyFirstVariantVideoMedia\('video_urls'\)/);
  assert.match(listingAutomationSource, /generateAllVariantMedia\('video_cover_urls'\)/);
  assert.match(listingAutomationSource, /generateAllVariantMedia\('video_urls'\)/);
  assert.match(listingAutomationSource, /row\.video_cover_urls = \[videoUrl\]/);
  assert.match(listingAutomationSource, /row\.video_urls = \[videoUrl\]/);
  assert.match(listingAutomationSource, /uploadVariantVideoRequest\(variantVideoEditor\.row, variantVideoEditor\.field, 'video'\)/);
  assert.match(assetVariantServiceSource, /export async function generateListingVariantMediaFromImage/);
  assert.match(assetVariantServiceSource, /cover: video/);
});

test("listing automation supports safe multi-shop text variants", () => {
  assert.match(listingAutomationSource, /const textVariantPolicy = reactive\(\{/);
  assert.match(listingAutomationSource, /text_variant_policy/);
  assert.match(listingAutomationSource, /base_shop_id/);
  assert.match(listingAutomationSource, /shop_styles/);
  assert.match(listingAutomationSource, /selectedTextVariantShops/);
  assert.match(listingAutomationSource, /textVariantStyleOptions/);
  assert.match(listingAutomationServiceSource, /normalizeShopTextVariantPolicy/);
  assert.match(listingAutomationServiceSource, /shopStyles/);
  assert.match(listingAutomationServiceSource, /textVariantStyleForShop/);
  assert.match(listingAutomationServiceSource, /applyShopTextVariantToPayload/);
  assert.match(listingAutomationServiceSource, /applyShopTextVariantToItem/);
  assert.match(listingAutomationServiceSource, /setOzonAttributeValues\(item\.attributes, 4191/);
  assert.match(listingAutomationServiceSource, /setOzonAttributeValues\(item\.attributes, 23171/);
});

test("draft box can batch publish drafts with multi-shop text variant policy", () => {
  assert.match(publishRecordsSource, /batchListing = reactive\(\{[\s\S]*textVariantEnabled/);
  assert.match(publishRecordsSource, /buildBatchTextVariantPolicy/);
  assert.match(publishRecordsSource, /selectedBatchTextVariantShops/);
  assert.match(publishRecordsSource, /批量上架草稿/);
  assert.match(publishRecordsSource, /批量上架/);
  assert.doesNotMatch(publishRecordsSource, /生成等待上架副本/);
  assert.doesNotMatch(publishRecordsSource, /打开上架页<\/el-button>/);
  assert.match(publishRecordsSource, /router\.push\(\{ name: "listing-publish-records", query: \{ status: "processing" \} \}\)/);
  assert.match(publishRecordsSource, /\/api\/listing\/drafts\/batch-publish/);
  assert.match(listingAutomationRouteSource, /"POST \/api\/listing\/drafts\/batch-publish"/);
  assert.match(listingAutomationRouteSource, /services\.publishListingDraftsToOzon/);
  assert.match(listingAutomationServiceSource, /export async function publishListingDraftsToOzon/);
  assert.match(listingAutomationServiceSource, /backgroundListingPublishTasks/);
  assert.match(listingAutomationServiceSource, /runBackgroundListingPublish/);
  assert.match(listingAutomationServiceSource, /initialStatus: "processing"/);
  assert.match(listingAutomationServiceSource, /draftId,/);
  assert.match(listingAutomationServiceSource, /template_payload_json LONGTEXT NULL/);
  assert.match(listingAutomationServiceSource, /template_payload: templatePayload && Object\.keys\(templatePayload\)\.length \? templatePayload : null/);
  assert.match(listingAutomationServiceSource, /if \(draft\.template_payload\)/);
  assert.match(listingAutomationServiceSource, /normalizeTemplatePayload\(payload\.template_payload\)/);
  assert.match(listingAutomationServiceSource, /buildPublishTemplateFromListingDraft/);
  assert.match(listingAutomationServiceSource, /const userFacts = objectValue\(manualFacts\.user_facts/);
  assert.match(listingAutomationServiceSource, /userFacts\.price/);
  assert.match(listingAutomationServiceSource, /rich_content_json: richContentJson/);
  assert.match(listingAutomationServiceSource, /userFacts\.variants \|\| manualFacts\.variants/);
  assert.match(listingAutomationServiceSource, /normalizeAttributeValuesForOzon\(item\)\.length/);
  assert.match(listingAutomationServiceSource, /text_variant_policy/);
  assert.match(mysqlRuntimeServicesSource, /publishListingDraftsToOzon/);
});

test("listing automation publishes operator-entered prices as finalized", () => {
  assert.match(listingAutomationSource, /price_strategy_mode:\s*item\.price_strategy_mode \|\| "finalized"/);
  assert.match(listingAutomationSource, /price_strategy_applied:\s*true/);
  assert.match(listingAutomationSource, /strategy_mode:\s*"finalized"/);
  assert.match(listingAutomationSource, /strategy_applied:\s*true/);
});

test("listing publish service does not auto-multiply operator prices", () => {
  assert.doesNotMatch(listingAutomationServiceSource, /OZON_PUBLISH_PRICE_MULTIPLIER/);
  assert.doesNotMatch(listingAutomationServiceSource, /OZON_PUBLISH_OLD_PRICE_MULTIPLIER/);
  assert.doesNotMatch(listingAutomationServiceSource, /internalPrice\s*\*\s*2/);
  assert.doesNotMatch(listingAutomationServiceSource, /publishPrice\s*\*\s*2/);
});

test("listing automation normalizes pasted tags and persists color attribute edits", () => {
  assert.match(listingAutomationSource, /function normalizeTagList\(value\)/);
  assert.match(listingAutomationSource, /value\.flatMap\(\(item\) => splitTagValue\(item\)\)/);
  assert.match(listingAutomationSource, /\.replace\(\s*\/#\/g,\s*" #"\s*\)/);
  assert.match(listingAutomationSource, /\.split\(\/\[\\s,，;；\|\/、\\n\\r\\t\]\+\/\)/);
  assert.match(listingAutomationSource, /@update:model-value="updateFixedTags"/);
  assert.match(listingAutomationSource, /@update:model-value="updateVariantTags\(row, \$event\)"/);
  assert.match(listingAutomationSource, /function clearFixedTags\(\)/);
  assert.match(listingAutomationSource, /function clearAllFixedTags\(\)/);
  assert.match(listingAutomationSource, /@click="clearAllFixedTags">清空全部/);
  assert.match(listingAutomationSource, /function clearVariantTags\(row = \{\}\)/);
  assert.match(listingAutomationSource, /if \(isColorAttributeField\(field\)\)/);
  assert.match(listingAutomationSource, /if \(variantColorAttribute\.value\) setVariantAttributeValue\(row, variantColorAttribute\.value, row\.color_values\)/);
  assert.match(listingAutomationSource, /const COLOR_ATTRIBUTE_IDS = new Set\(\["10096", "22814"\]\)/);
  assert.match(listingAutomationSource, /isColorAttributeField\(field\)[\s\S]*variantFieldHasDiverged\("color"\)/);
  assert.doesNotMatch(listingAutomationSource.match(/function fixedAttributeNames\(\) \{[\s\S]*?\n\}/)?.[0] || "", /"颜色"/);
  assert.match(listingAutomationServiceSource, /const COLOR_ATTRIBUTE_IDS = new Set\(\[10096, 22814\]\)/);
  assert.match(listingAutomationServiceSource, /const attributes = normalizeAttributes\(input\.attributes/);
  assert.match(listingAutomationServiceSource, /const variants = normalizeArray\(input\.variants/);
});

test("listing automation edits variant color attributes inline instead of drawer only", () => {
  assert.match(listingAutomationSource, /function updateVariantColorAttribute\(row = \{\}, field = \{\}, value = \[\]\)/);
  assert.match(listingAutomationSource, /row\.color_values = normalizeColorValues\(value\);[\s\S]*setVariantAttributeValue\(row, field, row\.color_values\)/);
  assert.match(listingAutomationSource, /v-if="isColorAttributeField\(field\)"[\s\S]*@update:model-value="updateVariantColorAttribute\(row, field, \$event\)"/);
  assert.match(listingAutomationSource, /v-else type="button" class="variant-attribute-summary" @click="openVariantAttributeEditor\(row, field\)"/);
  assert.match(listingAutomationSource, /if \(isColorAttributeField\(field\)\) \{[\s\S]*row\.color_values = normalizeColorValues\(value\);[\s\S]*row\.color = normalizeColorForPayload\(row\);/);
});

test("listing automation draft save persists edited collector templates first", () => {
  assert.match(listingAutomationSource, /async function saveCurrentTemplateSnapshot/);
  assert.match(listingAutomationSource, /async function updateTemplateWithConflictRetry\(payload = \{\}, options = \{\}\)/);
  assert.match(listingAutomationSource, /const requestPayload = options\.skipVersionCheck \? \{ \.\.\.payload, updated_at: "" \} : payload/);
  assert.match(listingAutomationSource, /if \(error\?\.status !== 409 \|\| !options\.retryOnConflict\) throw error/);
  assert.match(listingAutomationSource, /apiClient\.get\(`\/api\/listing\/templates\/\$\{id\}\?mode=editor`/);
  assert.match(listingAutomationSource, /updated_at: latest\?\.updated_at \|\| ""/);
  assert.match(listingAutomationSource, /updateTemplateWithConflictRetry\(payload, \{ retryOnConflict: true, skipVersionCheck: Boolean\(collectorSourceSku\.value\) \}\)/);
  assert.match(listingAutomationSource, /async function saveCollectorBoxEditSnapshot/);
  assert.match(listingAutomationSource, /apiClient\.put\(`\/api\/listing\/collector-box\/\$\{encodeURIComponent\(sku\)\}\/edit`/);
  assert.match(listingAutomationSource, /const controller = new AbortController\(\)/);
  assert.match(listingAutomationSource, /controller\.abort\(\), 18000/);
  assert.match(listingAutomationSource, /采集箱编辑状态同步超时，请稍后重试保存/);
  assert.match(listingAutomationSource, /function templatePayloadToCollectorBoxEditPayload/);
  assert.match(listingAutomationSource, /function buildDraftTemplatePayloadForSave\(\)/);
  assert.match(listingAutomationSource, /template_payload: templatePayload/);
  assert.match(listingAutomationSource, /if \(draft\.template_payload \|\| draft\.templatePayload\)/);
  assert.match(listingAutomationSource, /await saveCurrentTemplateSnapshot\(\);[\s\S]*syncDraftImagesFromTemplateIfEmpty\(\);[\s\S]*apiClient\.post\("\/api\/listing\/drafts"/);
  assert.match(listingAutomationRouteSource, /services\.saveCollectorBoxEdit/);
  assert.match(mysqlRuntimeServicesSource, /saveCollectorBoxEdit/);
});

test("AI variant import prefers edited collector images over original collected image", () => {
  const sourcePayloads = assetVariantCenterSource.match(/function sourcePayloads\(row = \{\}\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(sourcePayloads, /const edited = \[/);
  assert.ok(sourcePayloads.indexOf("parseMaybeJson(row.editPayload)") < sourcePayloads.indexOf("row,"), "edited payloads must be inspected before the raw collector row");
  assert.match(assetVariantCenterSource, /function editableAssetPayloads\(row = \{\}\)/);
  assert.match(assetVariantCenterSource, /function editableVariantAssetImages\(row = \{\}\)/);
  assert.match(assetVariantCenterSource, /const userAssetImages = sourceAssetImages\(payloads\)/);
  assert.match(assetVariantCenterSource, /const editedVariantAssetImages = editableVariantAssetImages\(row\)/);
  assert.match(assetVariantCenterSource, /const editedAssetImages = payloadImages\(editableAssetPayloads\(row\), \["images"/);
  assert.match(assetVariantCenterSource, /const imageList = userAssetImages\.length\s*\?\s*userAssetImages\s*:\s*editedVariantAssetImages\.length\s*\?\s*editedVariantAssetImages\s*:\s*editedAssetImages\.length/s);
  assert.match(aiWorkbenchProxySource, /sourceImages=rs\(r,\[`source_images`,`sourceImages`,`user_images`,`userImages`,`uploaded_images`,`uploadedImages`,`imported_images`,`importedImages`\]\)/);
  assert.match(aiWorkbenchProxySource, /variantImages=.*?flatMap.*?imageUrls/s);
  assert.match(aiWorkbenchProxySource, /p=sourceImages\.length\?sourceImages:variantImages\.length\?variantImages:rs\(r,\[`image_url`,`main_image_url`,`primary_image`,`cover_image`,`cover`,`images`/);
  assert.match(listingAutomationServiceSource, /function collectorBoxDisplayImageUrl/);
  assert.match(listingAutomationServiceSource, /const editedImages = normalizeImages\(editPayload\.images/);
  assert.match(listingAutomationServiceSource, /userAssetImages,[\s\S]*editedVariantImages,[\s\S]*editedImages,[\s\S]*templateImages/);
  assert.match(listingAutomationSource, /source_images: dedupeImages\(sourceImages\)/);
  assert.match(listingAutomationServiceSource, /image_url: imageUrl/);
  assert.match(listingAutomationServiceSource, /original_image_url: String\(row\.image_url \|\| ""\)/);
  assert.match(listingAutomationServiceSource, /listing_template_id, edit_payload_json, edited_at/);
});

test("AI variant import from publish records prefers the published request image", () => {
  assert.match(aiWorkbenchProxySource, /\$o\(e,\{preferRaw:t===`listing`\}\)/);
  assert.match(aiWorkbenchProxySource, /i=t\.preferRaw\?\[\.\.\.r,\.\.\.n\]:\[\.\.\.n,\.\.\.r\]/);
});

test("AI variant asset records are persisted server-side for later recovery", () => {
  assert.match(listingAutomationServiceSource, /CREATE TABLE IF NOT EXISTS listing_ai_variant_assets/);
  assert.match(listingAutomationServiceSource, /UNIQUE KEY uq_listing_ai_variant_asset_result_field \(result_id, field_key\)/);
  assert.match(listingAutomationServiceSource, /export async function listingAiVariantAssets/);
  assert.match(listingAutomationServiceSource, /export async function saveListingAiVariantAsset/);
  assert.match(listingAutomationServiceSource, /normalizeListingAiVariantAssetPayload/);
  assert.match(listingAutomationServiceSource, /UPDATE listing_ai_variant_assets/);
  assert.match(listingAutomationRouteSource, /GET \/api\/listing\/ai-variant-assets/);
  assert.match(listingAutomationRouteSource, /POST \/api\/listing\/ai-variant-assets/);
});

test("listing automation publish media preview applies shop watermark and tail templates", () => {
  assert.match(listingAutomationServiceSource, /const LISTING_PUBLISH_SHOP_SELECT/);
  assert.match(listingAutomationServiceSource, /watermark_path, watermark_name, watermark_position/);
  assert.match(listingAutomationServiceSource, /export async function prepareListingTemplatePublishMediaPreview/);
  assert.match(listingAutomationServiceSource, /applyShopWatermarkedImagesToPayload\(defaultedPayload, shop, session\)/);
  assert.match(listingAutomationServiceSource, /appendTailImageToPayload\(watermarkedPayload, tailImageUrl\)/);
  assert.match(listingAutomationServiceSource, /FROM asset_tail_templates/);
  assert.match(listingAutomationServiceSource, /is_default DESC/);
  assert.match(listingAutomationServiceSource, /materializeShopTailImageForPublish/);
  assert.match(listingAutomationServiceSource, /role: "tail_template"/);
  assert.doesNotMatch(listingAutomationServiceSource, /Number\(options\.xPercent \|\| 75\) \/ 100 - wmWidth \/ 2/);
  assert.doesNotMatch(listingAutomationServiceSource, /Number\(options\.yPercent \|\| 75\) \/ 100 - wmHeight \/ 2/);
});
