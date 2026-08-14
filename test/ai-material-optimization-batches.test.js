import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const batchService = fs.readFileSync(new URL("../src/services/ai-material-optimization-batches.js", import.meta.url), "utf8");
const routes = fs.readFileSync(new URL("../src/server/routes/aiVariantLab.js", import.meta.url), "utf8");
const draftBox = fs.readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8");
const recordsView = fs.readFileSync(new URL("../frontend/admin/views/listing/AiMaterialOptimizationRecordsView.vue", import.meta.url), "utf8");
const optimizerService = fs.readFileSync(new URL("../src/services/ai-variant-lab.js", import.meta.url), "utf8");
const imageWorkflow = fs.readFileSync(new URL("../src/server/services/ai/aiWorkflowService.js", import.meta.url), "utf8");

test("draft batch material optimization submits a backend batch without opening the optimizer page", () => {
  assert.match(draftBox, /post\("\/api\/ai-material-optimization\/batches"/);
  assert.match(draftBox, /name: "ai-material-optimization-records"/);
  assert.doesNotMatch(draftBox, /autoBatch: "1"/);
});

test("material optimization batches persist item stages and recover running work", () => {
  assert.match(batchService, /CREATE TABLE IF NOT EXISTS ai_material_optimization_batches/);
  assert.match(batchService, /CREATE TABLE IF NOT EXISTS ai_material_optimization_items/);
  assert.match(batchService, /recoverAiMaterialOptimizationBatchesOnStartup/);
  assert.match(batchService, /SET status = 'queued'.*WHERE status = 'running'/s);
  assert.match(batchService, /aiImageOptimizerConfirmAnalysis/);
  assert.match(batchService, /aiImageOptimizerConfirmPlan/);
  assert.match(batchService, /createAiVariantListingDraftLightweight/);
  assert.match(batchService, /clone_source_draft: true/);
});

test("material optimization requires operator-confirmed product facts for every draft", () => {
  assert.match(batchService, /operator_facts_json LONGTEXT/);
  assert.match(batchService, /normalizeOperatorFacts/);
  assert.match(batchService, /operatorFactsReady/);
  assert.match(batchService, /product_title_zh/);
  assert.match(batchService, /selling_points_zh/);
  assert.match(batchService, /operator_product_facts: operatorFacts/);
  assert.match(draftBox, /batchMaterialOptimization\.facts/);
  assert.match(draftBox, /确认本行商品事实准确/);
});

test("full material optimization overlaps copy generation with bounded detail image concurrency", () => {
  assert.match(batchService, /const DETAIL_IMAGE_CONCURRENCY = 3/);
  assert.match(batchService, /mapWithConcurrency\(source\.detailImages\.slice\(0, 6\), DETAIL_IMAGE_CONCURRENCY/);
  assert.match(batchService, /Promise\.all\(\[detailPromise, copyPromise\]\)/);
  assert.doesNotMatch(batchService, /for \(const \[index, image\] of source\.detailImages\.slice\(0, 6\)\.entries\(\)\)/);
});

test("material optimization records expose progress, results and retry", () => {
  assert.match(routes, /GET \/api\/ai-material-optimization\/batches/);
  assert.match(routes, /retryAiMaterialOptimizationItem/);
  assert.match(recordsView, /progress_percent/);
  assert.match(recordsView, /result_draft_id/);
  assert.match(recordsView, /失败任务已重新排队/);
  assert.match(recordsView, /关闭页面不会中断/);
});

test("material optimization reads ERP listing media locally instead of fetching its public domain", () => {
  assert.match(optimizerService, /resolveLocalPublicImageFile\(imageUrl\)/);
  assert.match(optimizerService, /uploads\/listing-media\//);
  assert.match(imageWorkflow, /resolveLocalPublicSourceImage\(value, pathname\)/);
  assert.match(imageWorkflow, /return \{ filePath, contentType, filename: path\.basename\(filePath\), source: value \}/);
  assert.doesNotMatch(imageWorkflow, /fsSync\.readFileSync\(filePath\)/);
});

test("material optimization materializes selected images before it exposes a draft save preview", () => {
  assert.match(optimizerService, /materializeListingMediaAssetUrl\(sourceUrl/);
  assert.match(optimizerService, /materialized_url_map/);
});

test("material optimization network fallback keeps Russian headline and selling-point requirements", () => {
  assert.match(batchService, /Add a clearly readable Russian product headline/);
  assert.match(batchService, /Add exactly 2 or 3 short Russian benefit captions/);
  assert.match(batchService, /main_overlay_ru/);
  assert.doesNotMatch(batchService, /Do not invent accessories, claims, logos, certifications or text/);
});
