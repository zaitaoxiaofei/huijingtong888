import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../frontend/admin/views/listing/AiOptimizationWorkbenchV2.vue", import.meta.url), "utf8");

test("AI variant step two keeps variable input visible and uses a field prompt matrix", () => {
  assert.match(source, /class="confirm-diy-grid"/);
  assert.match(source, /class="confirm-column target-workbench-column"/);
  assert.match(source, /class="confirm-column prompt-plan-column"/);
  assert.match(source, /class="confirm-summary-card"/);
  assert.match(source, /VARIANT_TARGET_PAGE_SIZE = 10/);
  assert.match(source, /pagedVariantTargetCards/);
  assert.match(source, /searchVariantPromptTemplates/);
  assert.match(source, /DEFAULT_WATERMARK_SAFE_AREA/);
  assert.match(source, /DEFAULT_VARIANT_FIELD_PROMPTS/);
  assert.match(source, /effectiveFieldManualPrompt/);
});

test("AI variant result step renders rows in a table layout", () => {
  assert.match(source, /class="variant-result-table"/);
  assert.match(source, /v-if="resultTableShowsField\('mainImage'\)"/);
  assert.match(source, /v-if="resultTableShowsField\('detailImages'\)"/);
  assert.match(source, /v-if="resultTableShowsField\('title'\)"/);
  assert.match(source, /v-if="resultTableShowsField\('tags'\)"/);
  assert.match(source, /v-if="resultTableShowsField\('description'\)"/);
  assert.match(source, /v-if="resultTableShowsField\('richText'\)"/);
  assert.match(source, /v-if="resultTableShowsField\('video'\)"/);
  assert.match(source, /function resultTableShowsField/);
  assert.match(source, /class="variant-video-cell"/);
  assert.match(source, /v-for="workRow in workRows"/);
});

test("AI variant generation fields default to every asset field", () => {
  assert.match(source, /const DEFAULT_GENERATION_FIELDS = resultFieldOptions\.map\(\(item\) => item\.key\)/);
  assert.match(source, /const generationFields = ref\(\[\.\.\.DEFAULT_GENERATION_FIELDS\]\)/);
  assert.match(source, /function defaultSelectedFields\(\) \{\s+return \[\.\.\.DEFAULT_GENERATION_FIELDS\];\s+\}/);
  assert.match(source, /setGenerationFields\(\[\.\.\.DEFAULT_GENERATION_FIELDS\]\)/);
});

test("AI variant video state keeps timeout, local preview, and publishable URLs explicit", () => {
  assert.match(source, /const VIDEO_GENERATION_TIMEOUT_MS = 60000/);
  assert.match(source, /postWithTimeout\("\/api\/asset-variant-engine\/generate-video"/);
  assert.match(source, /status: "failed"/);
  assert.match(source, /status: publishUrl \? "generated" : "local_ready"/);
  assert.match(source, /label: publishUrl \? "主图视频已生成" : "视频已生成，待公网同步"/);
  assert.match(source, /const publishUrl = uploaded\.publishUrl \|\| uploaded\.publish_url/);
  assert.match(source, /publishUrl,/);
  assert.match(source, /function rowListingVideoFields/);
  assert.match(source, /const videoFields = rowListingVideoFields\(row\)/);
  assert.match(source, /editable_payload: \{[\s\S]*\.\.\.videoFields/);
  assert.match(source, /video_urls: \[videoUrl\]/);
  assert.match(source, /video_cover_urls: \[videoUrl\]/);
});

test("AI variant draft save uses limited concurrency and shows progress", () => {
  assert.match(source, /const LISTING_DRAFT_SAVE_CONCURRENCY = 2/);
  assert.match(source, /const saveProgress = reactive/);
  assert.match(source, /await runLimited\(rows, async \(row\) =>/);
  assert.match(source, /Math\.min\(LISTING_DRAFT_SAVE_CONCURRENCY, rows\.length\)/);
  assert.match(source, /class="save-progress"/);
  assert.match(source, /saveProgress\.done \/ saveProgress\.total/);
});

test("AI variant draft save emits frontend performance segments", () => {
  assert.match(source, /const saveTraceId = row\.saveTraceId \|\| `ai-save-/);
  assert.match(source, /\[ai-variant-save-perf\]/);
  assert.match(source, /LISTING_TEMPLATE_SAVE_TIMEOUT_MS = 90000/);
  assert.match(source, /LISTING_DRAFT_SAVE_TIMEOUT_MS = 90000/);
  assert.match(source, /function rowBaseTemplateId/);
  assert.match(source, /function buildLightweightListingDraftPayload/);
  assert.match(source, /\/api\/listing\/drafts\/ai-variant-lightweight/);
  assert.match(source, /frontend\.lightweight_draft\.create\.start/);
  assert.match(source, /frontend\.template\.create\.start/);
  assert.match(source, /frontend\.template\.create/);
  assert.match(source, /frontend\.draft\.create\.start/);
  assert.match(source, /frontend\.draft\.create/);
  assert.match(source, /frontend\.save\.done/);
  assert.match(source, /postWithTimeout\(\s*"\/api\/listing\/templates"/);
  assert.match(source, /postWithTimeout\(\s*"\/api\/listing\/drafts"/);
});

test("AI variant generated fields are persisted as recoverable asset records", () => {
  assert.match(source, /function recordAiVariantAsset/);
  assert.match(source, /\/api\/listing\/ai-variant-assets/);
  assert.match(source, /field_key: field/);
  assert.match(source, /asset: aiVariantAssetValue\(row, field\)/);
  assert.match(source, /await recordAiVariantAsset\(row, field, "generated"\)/);
  assert.match(source, /await recordAiVariantAsset\(row, field, "failed"/);
  assert.match(source, /await recordAiVariantAsset\(row, "video", "generated"\)/);
  assert.match(source, /await recordGeneratedAssets\(row\)/);
  assert.doesNotMatch(source, /if \(row\.listingDraftId\) return row/);
});

test("AI variant asset history drawer can recover a single generated field", () => {
  assert.match(source, /const assetHistory = reactive/);
  assert.match(source, /function openAssetHistory/);
  assert.match(source, /function applyAssetToRow/);
  assert.match(source, /function assetHistoryPreview/);
  assert.match(source, /<el-drawer v-model="assetHistory\.visible" title="AI 裂变资产历史"/);
  assert.match(source, /@click="openAssetHistory\(\)">资产历史/);
  assert.match(source, /@click="openAssetHistory\(drawer\.row\)">找回历史资产/);
  assert.match(source, /@click="applyAssetToRow\(asset\)">应用到结果/);
  assert.match(source, /row\.writeBackText = "资产已找回，待保存草稿"/);
});
