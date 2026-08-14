import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../frontend/admin/views/listing/ListingRecordEditorView.vue", import.meta.url), "utf8");
const publishRecordsSource = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");
const collectorBoxSource = readFileSync(new URL("../frontend/admin/views/listing/CollectorBoxView.vue", import.meta.url), "utf8");
const listingAutomationSource = readFileSync(new URL("../frontend/admin/views/listing/ListingAutomationView.vue", import.meta.url), "utf8");
const aiOptimizationWorkbenchSource = readFileSync(new URL("../frontend/admin/views/listing/AiOptimizationWorkbenchV2.vue", import.meta.url), "utf8");
const aiVariantLabSource = readFileSync(new URL("../frontend/admin/views/listing/AiVariantLabView.vue", import.meta.url), "utf8");
const assetVariantCenterSource = readFileSync(new URL("../frontend/admin/views/listing/AssetVariantCenter.vue", import.meta.url), "utf8");
const aiWorkbenchProxySource = readFileSync(new URL("../public/ai-workbench-proxy/assets/AiOptimizationWorkbenchV2-BDMw-MxS-codex-empty-boundary-20260613110500.js", import.meta.url), "utf8");
const materialCenterSource = readFileSync(new URL("../frontend/admin/views/settings/MaterialCenterView.vue", import.meta.url), "utf8");
const listingAutomationRouteSource = readFileSync(new URL("../src/server/routes/listingAutomation.js", import.meta.url), "utf8");
const listingAutomationServiceSource = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const staticHandlerSource = readFileSync(new URL("../src/http/static.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const mysqlRuntimeServicesSource = readFileSync(new URL("../src/services/mysql-runtime-services.js", import.meta.url), "utf8");
const assetVariantServiceSource = readFileSync(new URL("../src/services/asset-variant-engine.js", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../frontend/admin/router/index.js", import.meta.url), "utf8");
const navigationSource = readFileSync(new URL("../frontend/admin/constants/navigation.js", import.meta.url), "utf8");
const adminLayoutSource = readFileSync(new URL("../frontend/admin/layouts/AdminLayout.vue", import.meta.url), "utf8");

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
  assert.match(publishRecordsSource, /route\.meta\?\.recordMode === "publish" \? "publish" : "drafts"/);
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

test("listing draft box offers a direct quick-create entry", () => {
  assert.match(publishRecordsSource, /function quickCreateDraft\(\)/);
  assert.match(publishRecordsSource, /path: "\/listing-automation"[\s\S]*quickCreate: "1"/);
  assert.match(publishRecordsSource, /快速创建草稿/);
});

test("listing quick-create loads shops before initializing a blank draft", () => {
  const blankDraftSource = listingAutomationSource.match(/if \(!hasBootstrap && !hasLocalDraft\) \{[\s\S]*?return;\s*\}/)?.[0] || "";
  assert.match(blankDraftSource, /const shops = await loadShopDictionary\(\)/);
  assert.match(blankDraftSource, /state\.shops = Array\.isArray\(shops\)/);
  assert.ok(blankDraftSource.indexOf("loadShopDictionary") < blankDraftSource.indexOf("newBlankTemplate"));
});

test("listing editor automatically creates or restores its listing template before creating a draft", () => {
  assert.match(listingAutomationSource, /async function ensureListingTemplateForDraft\(\)/);
  assert.match(listingAutomationSource, /apiClient\.get\(`\/api\/listing\/templates\/\$\{routeTemplateId\}\?mode=editor`/);
  assert.match(listingAutomationSource, /apiClient\.post\("\/api\/listing\/templates", buildTemplatePayload\(\)\)/);
  assert.match(listingAutomationSource, /await ensureListingTemplateForDraft\(\)/);
  assert.doesNotMatch(listingAutomationSource, /请先添加 SKU 模板/);
});

test("listing draft box can send selected drafts to AI variant workbench", () => {
  assert.match(publishRecordsSource, /function batchOpenAiVariantWorkbench\(\)/);
  assert.match(publishRecordsSource, /openAiVariantLabWindow\(\{/);
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
  assert.match(draftProjectListSource, /SELECT\s+d\.id\s+\$\{fromSql\}[\s\S]*ORDER BY d\.updated_at DESC, d\.id DESC[\s\S]*LIMIT \?/);
  assert.match(draftProjectListSource, /AND d\.id IN \(\$\{ids\.map\(\(\) => "\?"\)\.join\(","\)\}\)/);
  assert.match(listingAutomationServiceSource, /function normalizeDraftProjectCandidateRow\(row\)/);
  assert.match(listingAutomationServiceSource, /delete normalized\.template_payload_json/);
  assert.match(draftProjectListSource, /d\.template_payload_json/);
  assert.match(draftProjectListSource, /'\{\}' AS manual_facts_json,\s*'\{\}' AS ai_payload_json/);
});

test("listing draft detail hydrates Chinese dictionary display values", () => {
  const detailSource = listingAutomationServiceSource.match(/async function listingDraft\(id, session\)[\s\S]*?async function assertDraftAccess/)?.[0] || "";
  assert.match(detailSource, /hydrateTemplateSelectedDictionaryValues\(draft\.template_payload\)/);
  assert.match(detailSource, /hydrateTemplateDictionaryDisplayValues/);
  assert.match(detailSource, /template_payload: templatePayload/);
  const normalizeEditorSource = listingAutomationSource.match(/function normalizeEditorAttributes\(attributes\)[\s\S]*?function normalizeIncomingAttributeValue/)?.[0] || "";
  assert.match(normalizeEditorSource, /display_value_zh: item\?\.display_value_zh/);
  assert.match(normalizeEditorSource, /selected_values: Array\.isArray\(item\?\.selected_values \|\| item\?\.selectedValues\)/);
  const optionLabelSource = listingAutomationSource.match(/function displayAttributeOptionLabel\(option = \{\}, field = \{\}\)[\s\S]*?function selectedAttributeOptions/)?.[0] || "";
  assert.match(optionLabelSource, /const localizedSelected = selectedAttributeOptions\(field\)\.find/);
  assert.match(optionLabelSource, /hasChineseText\(selectedLabel\) \? selectedLabel : attributeOptionLabel\(option\)/);
});

test("listing draft list prefers the saved draft images before template fallback images", () => {
  assert.match(listingAutomationServiceSource, /COALESCE\([\s\S]*?'\$\.editable_payload\.variants\[0\]\.primary_image'[\s\S]*?'\$\.editable_payload\.variants\[0\]\.images\[0\]\.url'[\s\S]*?\) AS draft_variant_primary_image/s);
  assert.match(listingAutomationServiceSource, /JSON_EXTRACT\(d\.template_payload_json, '\$\.editable_payload\.variants\[0\]\.images'\) AS draft_variant_images_json/);
  assert.match(listingAutomationServiceSource, /COALESCE\([\s\S]*?'\$\.editable_payload\.primary_image'[\s\S]*?'\$\.editable_payload\.images\[0\]\.url'[\s\S]*?\) AS draft_template_primary_image/s);
  assert.match(listingAutomationServiceSource, /function draftProjectDisplayImages\(row = \{\}\)/);
  assert.match(listingAutomationServiceSource, /\.\.\.sourceImages,[\s\S]*row\.draft_variant_primary_image,[\s\S]*row\.draft_template_primary_image/s);
  assert.match(listingAutomationServiceSource, /const images = draftProjectDisplayImages\(row\)/);
});

test("record preview only downgrades cross-origin localhost uploads as weak images", () => {
  assert.match(publishRecordsSource, /function isWeakPreviewImageUrl\(url = ""\)/);
  assert.match(publishRecordsSource, /if \(parsed\.origin === window\.location\.origin\) return false/);
  assert.match(publishRecordsSource, /if \(!parsed\.pathname\.startsWith\("\/uploads\/"\)\) return false/);
  assert.match(publishRecordsSource, /return \["localhost", "127\.0\.0\.1", "\[::1\]"\]\.includes\(parsed\.hostname\)/);
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

test("listing automation can repair Ozon media URLs from the image and video area", () => {
  assert.match(listingAutomationRouteSource, /POST \/api\/listing\/media\/repair/);
  assert.match(listingAutomationRouteSource, /services\.repairListingEditorMedia/);
  assert.match(listingAutomationServiceSource, /export async function repairListingEditorMedia/);
  assert.match(mysqlRuntimeServicesSource, /repairListingEditorMedia/);
  assert.match(listingAutomationSource, /const repairingListingMedia = ref\(false\)/);
  assert.match(listingAutomationSource, /apiClient\.post\("\/api\/listing\/media\/repair"/);
  assert.match(listingAutomationSource, /function repairAllListingMedia\(\)/);
  assert.match(listingAutomationSource, /function repairCurrentVariantMedia\(\)/);
  assert.match(listingAutomationSource, /@click="repairAllListingMedia">修复素材地址/);
  assert.match(listingAutomationSource, /@click="repairCurrentVariantMedia">修复地址/);
  assert.match(listingAutomationSource, /row\.video_cover_urls = Array\.isArray\(result\.video_cover_urls\)/);
  assert.match(listingAutomationSource, /row\.video_urls = Array\.isArray\(result\.video_urls\)/);
  assert.match(listingAutomationSource, /syncDraftImagesFromVariantImages\(\)/);
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
  assert.match(listingAutomationServiceSource, /failureMode/);
  assert.match(listingAutomationServiceSource, /LISTING_TEXT_VARIANT_ITEM_CONCURRENCY/);
  assert.match(listingAutomationServiceSource, /generateShopTextVariantsForItems/);
  assert.match(listingAutomationServiceSource, /Return valid JSON only with key items/);
  assert.match(listingAutomationServiceSource, /preserve each index exactly/);
  assert.match(listingAutomationServiceSource, /textVariantStyleForShop/);
  assert.match(listingAutomationServiceSource, /applyShopTextVariantToPayload/);
  assert.match(listingAutomationServiceSource, /applyShopTextVariantToItem/);
  assert.match(listingAutomationServiceSource, /buildSafeRuleBasedShopTextVariant/);
  assert.match(listingAutomationServiceSource, /const fallback = buildSafeRuleBasedShopTextVariant\(item, shop, policy, index\)/);
  assert.match(listingAutomationServiceSource, /containsMojibakeText\(text\)/);
  assert.match(listingAutomationServiceSource, /const tags = normalizeOzonHashtags\(input\.tags \|\| input\.keywords \|\| "", 20\)/);
  assert.match(listingAutomationServiceSource, /function publishOzonTagAttributeValues\(value = \[\], limit = 20\)/);
  assert.match(listingAutomationServiceSource, /refreshSystemOzonRichContentAttribute\(item\)/);
  assert.match(listingAutomationServiceSource, /setOzonAttributeValues\(item\.attributes, 4191/);
  assert.match(listingAutomationServiceSource, /setOzonAttributeValues\(item\.attributes, 23171/);
});

test("draft batch publish exposes safe AI text failure handling and bounded concurrency", () => {
  assert.match(publishRecordsSource, /textVariantFailureMode: "block"/);
  assert.match(publishRecordsSource, /failure_mode: batchListing\.textVariantFailureMode/);
  assert.match(listingAutomationServiceSource, /await mapWithConcurrency\(shops, LISTING_PUBLISH_SHOP_CONCURRENCY, async \(shop\) =>/);
  assert.match(listingAutomationServiceSource, /LISTING_TEXT_VARIANT_ITEM_CONCURRENCY/);
  assert.match(listingAutomationServiceSource, /const variants = await generateShopTextVariantsForItems\(next\.items, shop, shopPolicy\)/);
  assert.match(listingAutomationServiceSource, /if \(policy\.failureMode === "block"\)/);
});

test("draft batch publish prefers current editable attributes and defines every text variant style", () => {
  assert.match(listingAutomationServiceSource, /const attributes = mergeListingPublishAttributes\(template\.attributes, editable\.attributes\);/);
  assert.match(listingAutomationServiceSource, /value: editableHasSelection \? editable\.value : current\.value/);
  assert.match(listingAutomationServiceSource, /title: String\(editable\.title \|\| template\.title/);
  assert.match(listingAutomationServiceSource, /description: String\(editable\.description \|\| template\.description/);
  assert.match(listingAutomationServiceSource, /function shopTextVariantStyleInstruction\(style = "light"\)/);
  assert.match(listingAutomationServiceSource, /Make only small wording changes so this remains recognizably the same listing/);
  assert.match(listingAutomationServiceSource, /Improve click appeal while staying factual/);
  assert.match(listingAutomationServiceSource, /Differentiate the copy through supported usage scenarios/);
  assert.match(listingAutomationServiceSource, /Differentiate the copy through the stated material/);
  assert.match(listingAutomationServiceSource, /shopTextVariantStyleInstruction\(policy\.style\)/);
});

test("draft box can batch publish drafts with multi-shop text variant policy", () => {
  assert.match(publishRecordsSource, /batchListing = reactive\(\{[\s\S]*textVariantEnabled/);
  assert.match(publishRecordsSource, /textVariantFailureMode: "block"/);
  assert.match(publishRecordsSource, /failure_mode: batchListing\.textVariantFailureMode/);
  assert.match(publishRecordsSource, /阻断该店铺/);
  assert.match(publishRecordsSource, /buildBatchTextVariantPolicy/);
  assert.match(publishRecordsSource, /selectedBatchTextVariantShops/);
  assert.match(publishRecordsSource, /批量上架草稿/);
  assert.match(publishRecordsSource, /批量上架/);
  assert.doesNotMatch(publishRecordsSource, /生成等待上架副本/);
  assert.doesNotMatch(publishRecordsSource, /打开上架页<\/el-button>/);
  assert.match(publishRecordsSource, /query = result\?\.task\?\.id[\s\S]*\{ tab: "tasks", taskId: String\(result\.task\.id\) \}/);
  assert.match(publishRecordsSource, /if \(isPublishMode\.value\) publishView\.value = route\.query\.tab === "tasks" \? "tasks" : "records"/);
  assert.match(publishRecordsSource, /watch\(\(\) => route\.query\.taskId[\s\S]*loadPublishTasks\(\);[\s\S]*openTaskDrawer\(\{ id: Number\(route\.query\.taskId\) \}\)/);
  assert.match(publishRecordsSource, /<el-tab-pane label="上架任务" name="tasks"/);
  assert.match(publishRecordsSource, /\/api\/listing\/publish-tasks/);
  assert.match(publishRecordsSource, /\/api\/listing\/drafts\/batch-publish/);
  assert.match(listingAutomationRouteSource, /"POST \/api\/listing\/drafts\/batch-publish"/);
  assert.match(listingAutomationRouteSource, /"GET \/api\/listing\/publish-tasks"/);
  assert.match(listingAutomationRouteSource, /services\.retryListingPublishTask/);
  assert.match(listingAutomationRouteSource, /services\.publishListingDraftsToOzon/);
  assert.match(listingAutomationServiceSource, /export async function publishListingDraftsToOzon/);
  assert.match(listingAutomationServiceSource, /CREATE TABLE IF NOT EXISTS listing_publish_tasks/);
  assert.match(listingAutomationServiceSource, /CREATE TABLE IF NOT EXISTS listing_publish_task_items/);
  assert.match(listingAutomationServiceSource, /publishTaskId: publishTask\.id/);
  assert.match(listingAutomationServiceSource, /publishTaskItemId: taskItemId/);
  assert.match(listingAutomationServiceSource, /publish_task_item_id BIGINT NULL/);
  assert.match(listingAutomationServiceSource, /uq_listing_publish_record_task_item/);
  assert.match(publishRecordsSource, /request_id: batchListing\.requestId/);
  assert.match(listingAutomationServiceSource, /existingListingPublishTaskByRequestId/);
  assert.match(listingAutomationServiceSource, /uq_listing_publish_tasks_request/);
  assert.match(listingAutomationServiceSource, /\["failed", "interrupted"\]/);
  assert.doesNotMatch(listingAutomationServiceSource, /\["failed", "interrupted", "pending", "preparing", "processing"\]/);
  assert.match(listingAutomationServiceSource, /sourceRecordId: Number\(item\.record_id \|\| 0\)/);
  assert.match(listingAutomationServiceSource, /updateExisting: Boolean\(item\.record_id\)/);
  assert.match(publishRecordsSource, /function taskCanRetry/);
  assert.match(publishRecordsSource, /:disabled="!taskCanRetry\(row\)"/);
  assert.match(listingAutomationServiceSource, /item_complex_attributes_json/);
  assert.match(listingAutomationServiceSource, /Math\.max\(prioritizedImages\.length, listImageCount\)/);
  assert.match(listingAutomationServiceSource, /async function processListingDraftBatchPublishTask/);
  assert.match(listingAutomationServiceSource, /runBackgroundListingPublish\(`draft batch publish task \$\{publishTask\.id\}`[\s\S]*processListingDraftBatchPublishTask/);
  assert.match(listingAutomationServiceSource, /queued: totalItems/);
  assert.match(listingAutomationServiceSource, /backgroundListingPublishTasks/);
  assert.match(listingAutomationServiceSource, /runBackgroundListingPublish/);
  assert.match(listingAutomationServiceSource, /await mapWithConcurrency\(shops, LISTING_PUBLISH_SHOP_CONCURRENCY, async \(shop\) =>/);
  assert.match(listingAutomationServiceSource, /initialStatus: "processing"/);
  assert.match(listingAutomationServiceSource, /draftId,/);
  assert.match(listingAutomationServiceSource, /assertDraftAccess\(draftId, session, false\)/);
  assert.match(listingAutomationServiceSource, /template_payload_json LONGTEXT NULL/);
  assert.match(listingAutomationServiceSource, /template_payload: templatePayload && Object\.keys\(templatePayload\)\.length \? templatePayload : null/);
  assert.match(listingAutomationServiceSource, /if \(draft\.template_payload\)/);
  assert.match(listingAutomationServiceSource, /buildPublishTemplateFromListingDraft\(draft = \{\}, session = null\)/);
  assert.match(listingAutomationServiceSource, /buildPublishTemplateFromListingDraft/);
  assert.match(listingAutomationServiceSource, /const userFacts = objectValue\(manualFacts\.user_facts/);
  assert.match(listingAutomationServiceSource, /userFacts\.price/);
  assert.match(listingAutomationServiceSource, /rich_content_json: richContentJson/);
  assert.match(listingAutomationServiceSource, /userFacts\.variants \|\| manualFacts\.variants/);
  assert.match(listingAutomationServiceSource, /normalizeAttributeValuesForOzon\(item\)\.length/);
  assert.match(listingAutomationServiceSource, /buildSystemOzonRichContentJson\(\{[\s\S]*imageUrl: baseImages\[0\]/);
  assert.match(listingAutomationServiceSource, /function hasRequiredAttributeValueForPublish\(attr = \{\}, facts = \{\}\)/);
  assert.match(listingAutomationServiceSource, /function isTitleLikeRequiredAttribute\(attr = \{\}\)/);
  assert.match(listingAutomationServiceSource, /return \/title\|name\|название\|заголовок\|наименование\|标题\|商品标题\//);
  assert.match(listingAutomationServiceSource, /function missingRequiredAttributeMessage\(attr = \{\}\)/);
  assert.match(listingAutomationServiceSource, /`缺少必填属性：\$\{label/);
  assert.doesNotMatch(listingAutomationServiceSource, /errors\.push\(`缂哄皯蹇呭～灞炴€э細/);
  assert.match(listingAutomationServiceSource, /Number\(item\.attribute_id\) === 11254 \? \{ \.\.\.item, value: safeRichContent \|\| sanitizeOzonRichContentJson\(item\.value, safeDescription\) \}/);
  assert.doesNotMatch(listingAutomationServiceSource, /sanitizeOzonRichContentJson\(item\.value \|\| safeRichContent/);
  assert.match(listingAutomationServiceSource, /function systemOzonRichContentForPublishItem\(item = \{\}\)/);
  assert.match(listingAutomationServiceSource, /function refreshSystemOzonRichContentAttribute\(item = \{\}\)/);
  assert.match(listingAutomationServiceSource, /const systemRichContent = systemOzonRichContentForPublishItem\(item\)/);
  assert.match(listingAutomationServiceSource, /if \(systemRichContent\) byId\.set\(11254/);
  assert.match(listingAutomationServiceSource, /refreshSystemOzonRichContentAttribute\(nextItem\)/);
  assert.match(listingAutomationServiceSource, /version: 0\.3/);
  assert.match(listingAutomationServiceSource, /widthMobile: 1024/);
  assert.match(listingAutomationServiceSource, /const previewTags = cleanPublishOzonTagList/);
  assert.match(listingAutomationServiceSource, /if \(previewTags\.length\) setOzonAttributeValues\(attrs, 23171, publishOzonTagAttributeValues\(previewTags\)\)/);
  assert.match(listingAutomationServiceSource, /text_variant_policy/);
  assert.match(mysqlRuntimeServicesSource, /publishListingDraftsToOzon/);
  assert.match(mysqlRuntimeServicesSource, /listingPublishTasks/);
  assert.match(mysqlRuntimeServicesSource, /listingPublishTaskDetail/);
  assert.match(mysqlRuntimeServicesSource, /retryListingPublishTask/);
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
  assert.match(listingAutomationSource, /\.split\(\/\[\\s,，;；、\|\/\\\\\]\+\/\)/);
  assert.match(listingAutomationSource, /function handleFixedTagsPaste\(event\)/);
  assert.match(listingAutomationSource, /function handleVariantTagsPaste\(row = \{\}, event\)/);
  assert.match(listingAutomationSource, /function normalizeFixedTags\(\)/);
  assert.match(listingAutomationSource, /function normalizeVariantTagsForRow\(row = \{\}\)/);
  assert.match(listingAutomationSource, /function normalizeAiTags\(value\) \{\s*return normalizeOzonTagList\(value\);/);
  assert.match(listingAutomationSource, /@paste="handleFixedTagsPaste"[\s\S]*@update:model-value="updateFixedTags"/);
  assert.match(listingAutomationSource, /@paste="handleVariantTagsPaste\(row, \$event\)"[\s\S]*@update:model-value="updateVariantTags\(row, \$event\)"/);
  assert.match(listingAutomationSource, /fixedForm\.tags\.length }}\/20/);
  assert.match(listingAutomationSource, /row\.main_tags\?\.length \|\| 0 }}\/20/);
  assert.match(listingAutomationSource, /按 Ozon 规则整理标签/);
  assert.match(listingAutomationSource, /function clearFixedTags\(\)/);
  assert.match(listingAutomationSource, /function clearAllFixedTags\(\)/);
  assert.match(listingAutomationSource, /@click="clearAllFixedTags">清空全部/);
  assert.match(listingAutomationSource, /function clearVariantTags\(row = \{\}\)/);
  assert.match(listingAutomationSource, /if \(isColorAttributeField\(field\)\)/);
  assert.match(listingAutomationSource, /function sanitizeVariantColorFields\(row = \{\}, field = variantColorAttribute\.value \|\| \{\}\)/);
  assert.match(listingAutomationSource, /if \(variantColorAttribute\.value\) setVariantAttributeValue\(row, variantColorAttribute\.value, row\.color_values\)/);
  assert.match(listingAutomationSource, /const COLOR_ATTRIBUTE_IDS = new Set\(\["10096", "22814"\]\)/);
  assert.match(listingAutomationSource, /isColorAttributeField\(field\)[\s\S]*variantFieldHasDiverged\("color"\)/);
  assert.match(listingAutomationServiceSource, /const COLOR_ATTRIBUTE_IDS = new Set\(\[10096, 22814\]\)/);
  assert.match(listingAutomationServiceSource, /const attributes = normalizeAttributes\(input\.attributes/);
  assert.match(listingAutomationServiceSource, /const variants = normalizeArray\(input\.variants/);
});

test("listing automation edits variant color attributes inline instead of drawer only", () => {
  assert.match(listingAutomationSource, /function updateVariantColorAttribute\(row = \{\}, field = \{\}, value = \[\]\)/);
  assert.match(listingAutomationSource, /row\.color_values = normalizeColorValuesForField\(value, field\);[\s\S]*setVariantAttributeValue\(row, field, row\.color_values\)/);
  assert.match(listingAutomationSource, /<span>颜色<\/span>[\s\S]*v-if="variantColorAttribute"[\s\S]*@update:model-value="updateVariantColorAttribute\(row, variantColorAttribute, \$event\)"/);
  assert.match(listingAutomationSource, /v-for="field in visibleNonColorVariantAttributeFields"[\s\S]*class="flat-attribute-control"[\s\S]*@update:model-value="updateVariantAttributeSelectValue\(row, field, \$event\)"/);
  assert.doesNotMatch(listingAutomationSource, /SKU属性编辑/);
  assert.match(listingAutomationSource, /if \(isColorAttributeField\(field\)\) \{[\s\S]*row\.color_values = normalizeColorValuesForField\(normalizedValue, field\);[\s\S]*row\.color = normalizeColorForPayload\(row\);/);
  assert.match(listingAutomationSource, /return matches\.find\(\(option\) => hasReadableAttributeOptionLabel\(option\)\) \|\| matches\[0\]/);
  assert.match(listingAutomationSource, /option\.display_value_zh[\s\S]*option\.label[\s\S]*option\.name[\s\S]*option\.text[\s\S]*option\.value/);
  assert.match(listingAutomationSource, /function normalizeColorValuesForField\(value, field = \{\}\)/);
  assert.match(listingAutomationSource, /function isQuantityLikeColorToken\(value = ""\)/);
  assert.match(listingAutomationSource, /templateEditor\.variants = Array\.isArray\(templateEditor\.variants\)[\s\S]*sanitizeVariantColorFields\(row, variantColorAttribute\.value \|\| \{\}\)/);
  assert.match(listingAutomationSource, /sanitizeVariantColorFields\(row, colorAttribute \|\| \{\}\);[\s\S]*seedVariantModelValue\(row, item\)/);
  assert.match(listingAutomationSource, /\.filter\(\(option\) => isUsableColorOption\(option, field\)\)/);
  assert.doesNotMatch(listingAutomationSource, /v-if="variantColorAttribute"[\s\S]{0,500}allow-create/);
});

test("listing automation maps only explicit Ozon color attributes to the fixed color column", () => {
  assert.match(listingAutomationSource, /const COLOR_ATTRIBUTE_EXCLUDED_IDS = new Set\(\["7202", "23249", "4384", "11650"\]\)/);
  assert.match(listingAutomationSource, /const COLOR_ATTRIBUTE_NAME_KEYWORDS = \["color", "colour", "\\u0446\\u0432\\u0435\\u0442", "\\u989c\\u8272", "\\u5546\\u54c1\\u989c\\u8272"\]/);
  assert.match(listingAutomationSource, /function hasExplicitColorAttributeName\(field = \{\}\)/);
  assert.match(listingAutomationSource, /function isDisallowedColorAttributeField\(field = \{\}\)/);
  assert.match(listingAutomationSource, /const candidates = kind === "color"[\s\S]*\.\.\.templateEditor\.attributes,[\s\S]*\.\.\.variantDynamicAttributeFields\(\)/);
  assert.match(listingAutomationSource, /if \(kind === "color" && \(isDisallowedColorAttributeField\(field\) \|\| \(!isStrongColorField && !hasExplicitColorName\)\)\)/);
  assert.match(listingAutomationSource, /if \(!hasDictionary && !isStrongColorField && !hasExplicitColorName\) return \{ field, score: -100 \};/);
  assert.match(listingAutomationSource, /if \(isDisallowedColorAttributeField\(field\)\) return false;[\s\S]*return hasExplicitColorAttributeName\(field\);/);
});

test("listing automation loads color dictionary options for dynamic color attributes", () => {
  assert.match(listingAutomationSource, /const colorField = isColorAttributeField\(field\);[\s\S]*\(!colorField && !Number\(field\.dictionary_id \|\| 0\)\)/);
  assert.match(listingAutomationSource, /function cachedAttributeOptionsForField\(field = \{\}\)/);
  assert.match(listingAutomationSource, /const dictionaryOptions = mergeAttributeOptions\([\s\S]*renderedAttributeOptions\(field \|\| \{\}\),[\s\S]*cachedAttributeOptionsForField\(field \|\| \{\}\)/);
});

test("listing automation draft tabs close without stale workbench cache blocking", () => {
  assert.match(adminLayoutSource, /tab\?\.route\?\.query\?\.draftId \|\| tab\?\.route\?\.query\?\.templateId \|\| tab\?\.route\?\.query\?\.recordId \|\| tab\?\.route\?\.query\?\.recordDraft/);
  assert.match(adminLayoutSource, /clearWorkbenchDraftForTab\(tab\);[\s\S]*return false;/);
});

test("listing automation renders all Ozon attributes while deduping repeated fields", () => {
  assert.match(listingAutomationSource, /const activeVariantAttributeKeys = computed\(\(\) => new Set\(/);
  assert.match(listingAutomationSource, /visibleVariantAttributeFields\.value\.map\(\(field\) => attributeFieldKey\(field\)\)/);
  assert.match(listingAutomationSource, /function dedupeAttributeFields\(fields = \[\]\) \{/);
  assert.match(listingAutomationSource, /function canonicalAttributeKey\(field = \{\}\) \{/);
  assert.match(listingAutomationSource, /id === "11254" \|\| \/json富内容\|rich\/\.test\(name\)/);
  assert.match(listingAutomationSource, /const key = canonicalAttributeKey\(field\) \|\| attributeFieldKey\(field\)/);
  assert.match(listingAutomationSource, /const hiddenAttributeFields = computed\(\(\) => dedupeAttributeFields\(templateEditor\.attributes\)\.sort\(sortSchemaAttributeFields\)/);
  assert.match(listingAutomationSource, /return dedupeAttributeFields\(Array\.from\(byKey\.values\(\)\)\)\.sort\(sortFlatSkuAttributeFields\)/);
  assert.match(listingAutomationSource, /const hasVariantAttributeAxis = computed\(\(\) =>/);
  assert.match(listingAutomationSource, /activeVariantAttributeKeys\.value\.size > 0/);
  assert.match(listingAutomationSource, /showLegacyVariantColorColumn\.value/);
  assert.match(listingAutomationSource, /showCollectedVariantOptionColumn\.value/);
  assert.doesNotMatch(listingAutomationSource, /function shouldHideSharedAttributeField/);
  assert.doesNotMatch(listingAutomationSource, /function isFixedAttributeField/);
  assert.doesNotMatch(listingAutomationSource, /function fixedAttributeNames/);
  assert.doesNotMatch(listingAutomationSource, /filter\(\(item\) => !shouldHideSharedAttributeField\(item\)\)/);
});

test("listing automation matches Ozon dictionary selections by localized labels", () => {
  assert.match(listingAutomationSource, /function attributeOptionSearchTexts\(option = \{\}\) \{/);
  assert.match(listingAutomationSource, /option\.display_value_zh/);
  assert.match(listingAutomationSource, /option\.name_zh/);
  assert.match(listingAutomationSource, /option\.raw\?\.display_value_zh/);
  assert.match(listingAutomationSource, /function attributeEditorModelValue\(field = \{\}\) \{/);
  assert.match(listingAutomationSource, /findAttributeOptionByValue\(field, field\.value\)/);
  assert.match(listingAutomationSource, /const candidates = attributeOptionSearchTexts\(option\)/);
  assert.match(listingAutomationSource, /function highRiskOzonAttributeRank\(field = \{\}\) \{/);
  assert.match(listingAutomationSource, /if \(isColorAttributeField\(field\)\) return 30/);
  assert.match(listingAutomationSource, /highRiskOzonAttributeRank\(b\) - highRiskOzonAttributeRank\(a\)/);
});

test("listing automation displays color origin and material options in Chinese", () => {
  assert.match(listingAutomationSource, /\["black", "黑色"\]/);
  assert.match(listingAutomationSource, /\["brown", "棕色"\]/);
  assert.match(listingAutomationSource, /const ORIGIN_COUNTRY_TRANSLATIONS = \[/);
  assert.match(listingAutomationSource, /\["китай", "中国"\]/);
  assert.match(listingAutomationSource, /const MATERIAL_TRANSLATIONS = \[/);
  assert.match(listingAutomationSource, /\["каучук", "橡胶"\]/);
  assert.match(listingAutomationSource, /function localizeAttributeDisplayText\(value = "", field = \{\}\)/);
  assert.match(listingAutomationSource, /if \(isColorAttributeField\(field\)\) return translateColorValue\(text\) \|\| text/);
  assert.match(listingAutomationSource, /if \(isOriginCountryAttribute\(field\)\) return translateByDictionary\(text, ORIGIN_COUNTRY_TRANSLATIONS\)/);
  assert.match(listingAutomationSource, /if \(isMaterialAttribute\(field\)\) return translateByDictionary\(text, MATERIAL_TRANSLATIONS\)/);
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

test("listing draft save keeps current editor images instead of stale collected source images", () => {
  const draftSavePayloadSource = listingAutomationSource.match(/function buildDraftTemplatePayloadForSave\(\)[\s\S]*?function dedupeImages/)?.[0] || "";
  assert.match(listingAutomationSource, /function currentEditorImagesForDraftSave\(\)/);
  assert.match(listingAutomationSource, /const existingDraftId = Number\(draftForm\.id \|\| state\.selectedDraftId \|\| route\.query\.draftId \|\| 0\)/);
  assert.match(listingAutomationSource, /if \(draftImagesManuallyEdited\.value \|\| \(existingDraftId && draftImages\.length\)\) return dedupeImages\(draftImages\)/);
  assert.match(listingAutomationSource, /if \(templateImages\.some\(\(item\) => item\?\.url\)\) return dedupeImages\(normalizeEditorImages\(templateImages\)\)/);
  assert.match(listingAutomationSource, /function syncDraftImagesForSave\(\)/);
  assert.match(listingAutomationSource, /draftForm\.source_images = sourceImages\.map\(\(item\) => \(\{ name: item\.name \|\| item\.url, url: item\.url \}\)\)\.filter\(\(item\) => item\.url\)/);
  assert.match(listingAutomationSource, /await saveCurrentTemplateSnapshot\(\);[\s\S]*syncDraftImagesForSave\(\);[\s\S]*const templatePayload = buildDraftTemplatePayloadForSave\(\)/);
  assert.match(listingAutomationSource, /const draftImages = currentEditorImagesForDraftSave\(\)/);
  assert.match(listingAutomationSource, /draftImagesManuallyEdited\.value = draftForm\.source_images\.length > 0/);
  assert.doesNotMatch(draftSavePayloadSource, /variants\s*=\s*\(payload\.editable_payload\.variants \|\| \[\]\)\.map/);
  assert.doesNotMatch(draftSavePayloadSource, /const draftImages = normalizeEditorImages\(draftForm\.source_images \|\| \[\]\)/);
});

test("listing draft restore keeps saved draft images ahead of template and variant images", () => {
  assert.match(listingAutomationSource, /const draftSourceImages = normalizeEditorImages\(draft\.source_images \|\| \[\]\)/);
  assert.match(listingAutomationSource, /const editableVariants = Array\.isArray\(editablePayload\.variants\) \? editablePayload\.variants : \[\]/);
  assert.match(listingAutomationSource, /const templateVariants = Array\.isArray\(templatePayload\.variants\) \? templatePayload\.variants : \[\]/);
  assert.match(listingAutomationSource, /const savedVariantImages = \[[\s\S]*editableVariants\.flatMap[\s\S]*templateVariants\.flatMap[\s\S]*\]/);
  assert.match(listingAutomationSource, /draftSourceImages\.length \? draftSourceImages[\s\S]*: savedVariantImages\.length \? savedVariantImages/);
  assert.match(listingAutomationSource, /const preservedDraftImages = normalizeEditorImages\(draftForm\.source_images \|\| \[\]\)/);
  assert.match(listingAutomationSource, /await saveCurrentTemplateSnapshot\(\);[\s\S]*?draftForm\.source_images = preservedDraftImages/);
});

test("listing draft save never duplicates when an existing draft id is present", () => {
  assert.match(listingAutomationSource, /const currentDraftId = Number\(draftForm\.id \|\| state\.selectedDraftId \|\| route\.query\.draftId \|\| 0\)/);
  assert.match(listingAutomationSource, /id: currentDraftId \|\| draftForm\.id \|\| ""/);
  assert.match(listingAutomationSource, /listing_draft_id: currentDraftId \|\| draftForm\.id \|\| ""/);
  assert.match(listingAutomationServiceSource, /const requestedDraftId = draftIdFromPayload\(body\)/);
  assert.match(listingAutomationServiceSource, /if \(requestedDraftId\) return updateListingDraft\(requestedDraftId, body, session\)/);
  assert.match(listingAutomationServiceSource, /function draftIdFromPayload\(body = \{\}\)/);
});

test("listing draft list displays the edited template payload price", () => {
  const draftProjectListSource = listingAutomationServiceSource.match(/async function listingDraftProjectCandidates[\s\S]*?export async function listingPublishRecordDetail/)?.[0] || "";
  assert.match(draftProjectListSource, /d\.template_payload_json/);
  assert.match(listingAutomationServiceSource, /normalized\.draft_variant_price = firstNonEmptyString/);
  assert.match(listingAutomationServiceSource, /normalized\.draft_template_price = firstNonEmptyString/);
  assert.match(listingAutomationServiceSource, /const draftPrice = draftProjectDisplayPrice\(row\)/);
  assert.match(listingAutomationServiceSource, /const projectedPrice = numberFromOzonValue\(row\.draft_variant_price \|\| row\.draft_template_price \|\| 0\)/);
  assert.match(listingAutomationServiceSource, /price: draftPrice \|\| ""/);
  assert.match(listingAutomationServiceSource, /function draftProjectDisplayPrice\(row = \{\}\)/);
  assert.match(listingAutomationServiceSource, /const firstVariant = objectValue\(normalizeArray\(editable\.variants \|\| templatePayload\.variants\)\[0\]\)/);
  assert.match(listingAutomationServiceSource, /typeof firstVariant\.price === "number"/);
  assert.match(listingAutomationServiceSource, /firstVariant\.price_value/);
  assert.match(listingAutomationServiceSource, /row\.sale_price/);
});

test("draft batch publish blocks local media before Ozon submit", () => {
  assert.match(listingAutomationServiceSource, /const blockingErrors = normalizeArray\(validation\.errors\);/);
  assert.match(listingAutomationServiceSource, /Local \/uploads URLs cannot be fetched by Ozon/);
  const draftBatchSource = listingAutomationServiceSource.match(/async function processListingDraftBatchPublishTask[\s\S]*?export async function publishListingDraftsToOzon/)?.[0] || "";
  assert.match(draftBatchSource, /assertPublishPayloadHasOnlyPublicMedia\(shopPayload, validation\)/);
  assert.doesNotMatch(draftBatchSource, /await assertPublishPayloadMediaReachable\(shopPayload, validation\)/);
  assert.doesNotMatch(draftBatchSource, /filter\(\(message\) => !String\(message \|\| ""\)\.includes\("Local \/uploads URLs cannot be fetched by Ozon"\)\)/);
});

test("listing draft media prefers registered public URLs over local preview URLs", () => {
  assert.match(listingAutomationServiceSource, /async function listingMediaRegisteredPublishUrl\(url = ""\)/);
  assert.match(listingAutomationServiceSource, /WHERE preview_url = \? AND publish_url IS NOT NULL AND publish_url <> ''/);
  assert.match(listingAutomationServiceSource, /async function rewriteDraftPayloadToRegisteredPublicMedia\(payload = \{\}\)/);
  assert.match(listingAutomationServiceSource, /rewriteDraftPayloadToRegisteredPublicMedia\(\s*await materializeListingDraftMediaForDraftSafety\(\s*await materializeAiOptimizationDraftMedia\(normalizeDraftPayload\(body\), session\)/);
  assert.match(listingAutomationServiceSource, /draft = sanitizeDraftMediaPayload\(await rewriteDraftPayloadToRegisteredPublicMedia\(\s*await materializeListingDraftMediaForDraftSafety\(\s*await materializeAiOptimizationDraftMedia\(draft, session\)/);
  assert.doesNotMatch(listingAutomationServiceSource, /\(\?:https\?:\\\/\\\/\(\?:localhost\|127\\\.0\\\.0\\\.1\|\\\[::1\\\]\)/);
  const collectLocalUrlsSource = listingAutomationServiceSource.match(/function collectListingMediaLocalUrls[\s\S]*?async function listingMediaPublishUrlMapForPayload/)?.[0] || "";
  const rewriteLocalUrlsSource = listingAutomationServiceSource.match(/function rewriteListingMediaLocalUrls[\s\S]*?async function rewriteDraftPayloadToRegisteredPublicMedia/)?.[0] || "";
  assert.match(collectLocalUrlsSource, /!isLocalImportMedia\(match\[0\]\).*continue/);
  assert.match(rewriteLocalUrlsSource, /!isLocalImportMedia\(match\).*return publishableListingMediaUrl\(match\)/);
});

test("listing draft uploads use publishable listing media instead of cropper temp URLs", () => {
  assert.match(listingAutomationSource, /const result = await uploadListingMedia\(options\.file, \{ source_module: "listing_draft", role: "draft_source_image" \}\)/);
  assert.match(listingAutomationSource, /url: result\.publishUrl \|\| result\.url \|\| result\.previewUrl/);
  assert.match(listingAutomationSource, /assetId: result\.assetId \|\| ""/);
  assert.doesNotMatch(listingAutomationSource, /uploadCropperImage\(options\.file\)/);
});

test("legacy cropper temp draft images are materialized before Ozon publish", () => {
  assert.match(listingAutomationServiceSource, /async function resolveLocalImageCropperMedia\(url = ""\)/);
  assert.match(listingAutomationServiceSource, /\/api\/tools\/image-cropper\/file\//);
  assert.match(listingAutomationServiceSource, /"uploads", "temp", "image-cropper"/);
  assert.match(listingAutomationServiceSource, /const cropperFile = await resolveLocalImageCropperMedia\(value\)/);
});

test("legacy AI temp draft images can be repaired from local or LAN URLs", () => {
  const aiRouteSource = readFileSync(new URL("../src/server/routes/aiImageRoutes.js", import.meta.url), "utf8");
  assert.match(aiRouteSource, /scope: "generated"/);
  assert.match(aiRouteSource, /filename: parts\.slice\(4\)\.map\(decodeURIComponent\)\.join\("\/"\)/);
  assert.match(listingAutomationServiceSource, /function isKnownAppMediaHost/);
  assert.match(listingAutomationServiceSource, /\^192\\\.168\\\./);
  assert.match(listingAutomationServiceSource, /const legacyMatch = match \? null : \/\^\\\/api\\\/ai\\\/file/);
  assert.match(listingAutomationServiceSource, /const scope = match \? decodeURIComponent\(match\[2\]\) : "generated"/);
});

test("publish media URL failures are recorded after creating publish records", () => {
  const directPublishSource = listingAutomationServiceSource.match(/export async function publishListingTemplateToOzon[\s\S]*?export async function publishListingDraftsToOzon/)?.[0] || "";
  const draftBatchSource = listingAutomationServiceSource.match(/async function processListingDraftBatchPublishTask[\s\S]*?export async function publishListingDraftsToOzon/)?.[0] || "";
  assert.ok(directPublishSource.indexOf("recordId = await preparePublishRecordForSubmit") < directPublishSource.indexOf("assertPublishPayloadHasOnlyPublicMedia(shopPayload, validation)"));
  assert.ok(draftBatchSource.indexOf("recordId = await preparePublishRecordForSubmit") < draftBatchSource.indexOf("assertPublishPayloadHasOnlyPublicMedia(shopPayload, validation)"));
  assert.match(draftBatchSource, /SET status = 'failed', error_json = \?, updated_at = CURRENT_TIMESTAMP/);
});

test("listing media publish path optimizes images and verifies complete downloads before Ozon submit", () => {
  assert.match(staticHandlerSource, /const isListingMediaAsset = \/\^\\\/uploads\\\/listing-media\\\/\[\^\/\]\+\$\/i/);
  assert.match(staticHandlerSource, /CDN-Cache-Control"\] = "public, max-age=31536000, immutable"/);
  assert.match(listingAutomationServiceSource, /async function optimizeListingImageForPublish/);
  assert.match(listingAutomationServiceSource, /const optimizedMedia = await optimizeListingImageForPublish\(file\.buffer/);
  assert.match(listingAutomationServiceSource, /const optimizedMedia = await optimizeListingImageForPublish\(sourceBuffer/);
  assert.match(listingAutomationServiceSource, /const optimizedMedia = await optimizeListingImageForPublish\(source\.buffer/);
  assert.match(listingAutomationServiceSource, /const optimizedMedia = await optimizeListingImageForPublish\(output/);
  assert.match(listingAutomationServiceSource, /async function prewarmPublishMediaUrls/);
  assert.match(listingAutomationServiceSource, /verifyRemoteImagesReadyForOzon\(imageUrls/);
  assert.match(listingAutomationServiceSource, /mapWithConcurrency\(otherUrls, LISTING_PUBLISH_MEDIA_CHECK_CONCURRENCY/);
  assert.match(listingAutomationServiceSource, /const prewarm = await prewarmPublishMediaUrls\(mediaUrls\)/);
});

test("Ozon seller media upload jobs are claimable by the collector plugin", () => {
  assert.match(listingAutomationRouteSource, /POST \/api\/listing\/media\/ozon-upload-jobs/);
  assert.match(serverSource, /server-publish" && parts\[3\] === "media-upload-jobs" && parts\[4\] === "claim"/);
  assert.match(serverSource, /completeServerPublishMediaUploadJob\(parts\[4\], parts\[5\]/);
  assert.match(mysqlRuntimeServicesSource, /createOzonSellerMediaUploadJobs/);
  assert.match(mysqlRuntimeServicesSource, /claimServerPublishMediaUploadJobs/);
  assert.match(mysqlRuntimeServicesSource, /completeServerPublishMediaUploadJob/);
  assert.match(listingAutomationServiceSource, /CREATE TABLE IF NOT EXISTS listing_ozon_seller_media_upload_jobs/);
  assert.match(listingAutomationServiceSource, /source_hash VARCHAR\(128\) NOT NULL DEFAULT ''/);
  assert.match(listingAutomationServiceSource, /SELECT GET_LOCK\(\?, 5\) AS locked/);
  assert.match(listingAutomationServiceSource, /export async function claimServerPublishMediaUploadJobs/);
  assert.match(listingAutomationServiceSource, /lease_until = DATE_ADD\(CURRENT_TIMESTAMP, INTERVAL \? SECOND\)/);
  assert.match(listingAutomationServiceSource, /export async function completeServerPublishMediaUploadJob/);
  assert.match(listingAutomationServiceSource, /uploaded_url = \?/);
});

test("Ozon publish reuses uploaded seller media URLs before submitting", () => {
  assert.match(listingAutomationServiceSource, /async function prepareOzonSellerMediaForPublishPayload/);
  assert.match(listingAutomationServiceSource, /isOzonSellerHostedMediaUrl/);
  assert.match(listingAutomationServiceSource, /waitForOzonSellerMediaJobs\(initialJobs/);
  assert.match(listingAutomationServiceSource, /OZON_SELLER_MEDIA_REPLACEMENT_INCOMPLETE/);
  assert.match(listingAutomationServiceSource, /function publishPayloadMediaUrlsFromValue/);
  assert.match(listingAutomationServiceSource, /parsed = JSON\.parse\(raw\)/);
  assert.match(listingAutomationServiceSource, /replacePayloadMediaUrls\(payload, replacements\)/);
  assert.match(listingAutomationServiceSource, /next\.split\(from\)\.join\(to\)/);
  assert.doesNotMatch(listingAutomationServiceSource, /publishing continues with public media URLs as fallback/);
  assert.doesNotMatch(listingAutomationServiceSource, /appendOzonSellerMediaPendingWarning/);
  assert.match(listingAutomationServiceSource, /prepareOzonSellerMediaForPublishPayload\(mediaRepair\.payload/);
});

test("listing media assets enqueue Ozon seller upload without blocking local media use", () => {
  assert.match(listingAutomationServiceSource, /async function enqueueOzonSellerMediaUploadForListingAsset/);
  assert.match(listingAutomationServiceSource, /await enqueueOzonSellerMediaUploadForListingAsset\(asset, session\)\.catch/);
  assert.match(listingAutomationServiceSource, /sourceUrl,\s*\n\s*kind,\s*\n\s*mimeType/);
  assert.match(listingAutomationServiceSource, /sourceModule: asset\.source_module/);
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
  assert.match(listingAutomationServiceSource, /editPayload: parseCollectedPayloadJson\(detail\.edit_payload_json\)/);
});

test("AI variant import from publish records prefers the published request image", () => {
  assert.match(aiWorkbenchProxySource, /\$o\(e,\{preferRaw:t===`listing`\}\)/);
  assert.match(aiWorkbenchProxySource, /i=t\.preferRaw\?\[\.\.\.r,\.\.\.n\]:\[\.\.\.n,\.\.\.r\]/);
});

test("AI variant asset records are persisted server-side for later recovery", () => {
  assert.match(listingAutomationServiceSource, /CREATE TABLE IF NOT EXISTS listing_ai_variant_assets/);
  assert.match(listingAutomationServiceSource, /UNIQUE KEY uq_listing_ai_variant_asset_result_field_owner \(result_id, field_key, owner_scope\)/);
  assert.match(listingAutomationServiceSource, /where\.push\("created_by_person_id = \?"\)/);
  assert.match(listingAutomationServiceSource, /export async function listingAiVariantAssets/);
  assert.match(listingAutomationServiceSource, /const fieldKey = cleanText\(query\.fieldKey \|\| query\.field_key \|\| "", 64\)/);
  assert.match(listingAutomationServiceSource, /where\.push\("field_key = \?"\)/);
  assert.match(listingAutomationServiceSource, /export async function saveListingAiVariantAsset/);
  assert.match(listingAutomationServiceSource, /normalizeListingAiVariantAssetPayload/);
  assert.match(listingAutomationServiceSource, /UPDATE listing_ai_variant_assets/);
  assert.match(listingAutomationRouteSource, /GET \/api\/listing\/ai-variant-assets/);
  assert.match(listingAutomationRouteSource, /POST \/api\/listing\/ai-variant-assets/);
});

test("AI variant draft reuse is isolated by the current operator", () => {
  const findExistingSource = listingAutomationServiceSource.match(/async function findExistingAiVariantDraft[\s\S]*?function cloneJsonValue/)?.[0] || "";
  assert.match(findExistingSource, /const ownerId = personId\(session\)/);
  assert.match(findExistingSource, /created_by_person_id <=> \?/);
  assert.match(listingAutomationServiceSource, /findExistingAiVariantDraft\(payload, aiPayload, session\)/);
  assert.match(listingAutomationServiceSource, /owner_scope BIGINT GENERATED ALWAYS AS \(COALESCE\(created_by_person_id, 0\)\) STORED/);
  assert.match(listingAutomationServiceSource, /dropMysqlIndexIfExists\("listing_ai_variant_assets", "uq_listing_ai_variant_asset_result_field"\)/);
});

test("AI variant writeback only sends fields selected in the preview dialog", () => {
  assert.match(aiWorkbenchProxySource, /s=new Set\(sa\.fields\|\|\[\]\)/);
  assert.match(aiWorkbenchProxySource, /changed_fields:c/);
  assert.match(aiWorkbenchProxySource, /\.\.\.\(s\.has\(`title`\)\?\{title:e\.title\}:\{\}\)/);
  assert.match(aiWorkbenchProxySource, /\.\.\.\(s\.has\(`tags`\)\?\{tags:e\.tags\}:\{\}\)/);
  assert.match(aiWorkbenchProxySource, /\.\.\.\(s\.has\(`description`\)\?\{description:e\.description\}:\{\}\)/);
  assert.doesNotMatch(aiWorkbenchProxySource, /patch:\{title:e\.title,tags:e\.tags,description:e\.description/);
});

test("AI variant lightweight drafts sync generated main image into SKU images", () => {
  assert.match(aiVariantLabSource, /function rowMainImageDraftUrl\(row\)/);
  assert.match(aiVariantLabSource, /const imageUrl = rowMainImageDraftUrl\(row\) \|\| material\.mainImageUrl/);
  assert.match(aiVariantLabSource, /row\.assets = \{ \.\.\.\(row\.assets \|\| \{\}\), \[fieldKey\]: result\?\.asset \|\| asset \}/);
  assert.match(listingAutomationServiceSource, /function syncAiVariantDraftPrimaryImages\(editable = \{\}, images = \[\]\)/);
  assert.match(listingAutomationServiceSource, /next\.primary_image = normalizedImages\[0\]\?\.url/);
  assert.match(listingAutomationServiceSource, /primary_image: normalizedImages\[0\]\?\.url \|\| variant\.primary_image/);
  assert.match(listingAutomationServiceSource, /editable = syncAiVariantDraftPrimaryImages\(editable, images\)/);
  assert.match(listingAutomationServiceSource, /let nextEditable = syncAiVariantDraftPrimaryImages\(\{/);
});

test("material center shows AI variant generated main images", () => {
  assert.match(materialCenterSource, /api\/listing\/ai-variant-assets\?\$\{params\.toString\(\)\}/);
  assert.match(materialCenterSource, /field_key:\s*"main_image"/);
  assert.match(materialCenterSource, /repair_temp_ai:\s*"1"/);
  assert.match(materialCenterSource, /const aiMainImageAssets = ref\(\[\]\)/);
  assert.match(materialCenterSource, /const selectedMaterialRows = ref\(\[\]\)/);
  assert.match(materialCenterSource, /const selectedShopRows = ref\(\[\]\)/);
  assert.match(materialCenterSource, /let materialLoadSeq = 0/);
  assert.match(materialCenterSource, /if \(activeTab\.value === "main"\) \{[\s\S]*await loadMainAssets\(common, seq\)/);
  assert.match(materialCenterSource, /else \{[\s\S]*await loadShopAssets\(common, seq\)/);
  assert.match(materialCenterSource, /async function loadMainAssets\(common = \{\}, seq = materialLoadSeq\)/);
  assert.match(materialCenterSource, /async function loadShopAssets\(common = \{\}, seq = materialLoadSeq\)/);
  assert.match(materialCenterSource, /if \(seq !== materialLoadSeq\) return/);
  assert.doesNotMatch(materialCenterSource, /const \[materialRows, shopRows, bootstrap\] = await Promise\.all/);
  assert.match(materialCenterSource, /void refreshAiMainImageAssets\(common\)/);
  assert.doesNotMatch(materialCenterSource, /const aiRows = await loadAiMainImageAssets\(common\)/);
  assert.match(materialCenterSource, /let aiMainImageRequestSeq = 0/);
  assert.match(materialCenterSource, /if \(seq !== aiMainImageRequestSeq\) return/);
  assert.match(materialCenterSource, /limit: String\(Math\.min\(Math\.max\(Number\(pager\.main\.pageSize \|\| 20\), 1\), 50\)\)/);
  assert.match(materialCenterSource, /function normalizeAiMainImageAssetRows\(rows = \[\]\)/);
  assert.match(materialCenterSource, /const url = firstDisplayableAiAssetUrl\(asset\)/);
  assert.match(materialCenterSource, /function firstDisplayableAiAssetUrl\(asset = \{\}\)/);
  assert.match(materialCenterSource, /function displayableAiAssetUrl\(value = ""\)/);
  assert.match(materialCenterSource, /\/\^\\\/api\\\/ai\\\/file\\\//);
  assert.match(materialCenterSource, /sourceAiAssetId: row\.id/);
  assert.match(materialCenterSource, /function mergeMaterialRows\(baseRows = \[\], aiRows = \[\]\)/);
  assert.match(materialCenterSource, /materialAssets\.value = mergeMaterialRows\(baseRows, aiMainImageAssets\.value\)/);
  assert.match(materialCenterSource, /materialAssets\.value = mergeMaterialRows\(materialAssets\.value\.filter\(\(row\) => !isAiVariantAssetRow\(row\)\), rows\)/);
  assert.match(materialCenterSource, /function isAiVariantAssetRow\(item = \{\}\)/);
  assert.match(materialCenterSource, /v-if="!isAiVariantAssetRow\(row\)"/);
  assert.match(materialCenterSource, /function handleSelectionChange\(kind, rows = \[\]\)/);
  assert.match(materialCenterSource, /@selection-change="handleSelectionChange\('shop', \$event\)"/);
  assert.match(materialCenterSource, /@selection-change="handleSelectionChange\('main', \$event\)"/);
  assert.match(materialCenterSource, /function deleteAiVariantAssetRows\(rows = \[\]\)/);
  assert.match(materialCenterSource, /apiClient\.post\("\/api\/listing\/ai-variant-assets\/batch-delete", \{ ids \}\)/);
  assert.match(materialCenterSource, /function deleteSelectedMaterialAssets\(\)/);
  assert.match(materialCenterSource, /function deleteSelectedShopAssets\(\)/);
  assert.match(materialCenterSource, /class="material-batch-bar"/);
  assert.match(materialCenterSource, /\.material-batch-bar/);
  assert.match(listingAutomationRouteSource, /POST \/api\/listing\/ai-variant-assets\/batch-delete/);
  assert.match(listingAutomationServiceSource, /export async function deleteListingAiVariantAssets/);
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

test("listing media watermark fallback is globally serialized to protect API capacity", () => {
  assert.match(listingAutomationServiceSource, /const LISTING_WATERMARK_CONCURRENCY = 1/);
  assert.match(listingAutomationServiceSource, /withListingWatermarkSlot\(\(\) => processListingMediaWatermark\(body, session\)\)/);
  assert.match(listingAutomationServiceSource, /pendingListingWatermarkJobs\.shift\(\)\?\.\(\)/);
});

test("listing publish tail images are materialized through public listing media", () => {
  const tailSource = listingAutomationServiceSource.match(/async function materializeShopTailImageForPublish[\s\S]*?async function resolveShopTailImageLocalPath/)?.[0] || "";
  assert.match(tailSource, /ensureListingMediaPublicUrl/);
  assert.match(tailSource, /role: "tail_template"/);
  assert.match(tailSource, /Tail image could not be converted to a public listing media URL/);
  assert.match(tailSource, /Tail image is not publicly reachable/);
  assert.doesNotMatch(tailSource, /if \(!localPath\) return normalizeShopTailImageUrl\(raw\)/);
});

test("listing publish blocks unreachable public media before Ozon submit", () => {
  const reachabilitySource = listingAutomationServiceSource.match(/async function assertPublishPayloadMediaReachable[\s\S]*?export async function publishListingTemplateToOzon/)?.[0] || "";
  assert.match(listingAutomationServiceSource, /verifyRemoteImagesReadyForOzon\(imageUrls/);
  assert.match(listingAutomationServiceSource, /requiredConsecutiveSuccesses: 2/);
  assert.match(reachabilitySource, /prewarm\.failed_urls/);
  assert.match(reachabilitySource, /Public media is not fully downloadable; Ozon submit was blocked/);
  assert.match(reachabilitySource, /validation\.errors/);
  assert.match(reachabilitySource, /validation\.ok = false/);
  assert.match(reachabilitySource, /throw error/);
  assert.doesNotMatch(reachabilitySource, /validation\.warnings = \[\.\.\.normalizeArray\(validation\.warnings\), message\]/);
});
