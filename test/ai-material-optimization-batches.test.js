import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const batchService = fs.readFileSync(new URL("../src/services/ai-material-optimization-batches.js", import.meta.url), "utf8");
const batchSchema = fs.readFileSync(new URL("../src/services/ai-material-optimization-schema.js", import.meta.url), "utf8");
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
  assert.match(batchSchema, /CREATE TABLE IF NOT EXISTS ai_material_optimization_batches/);
  assert.match(batchSchema, /CREATE TABLE IF NOT EXISTS ai_material_optimization_items/);
  assert.match(batchService, /recoverAiMaterialOptimizationBatchesOnStartup/);
  assert.match(batchService, /unknown_review/);
  assert.match(batchService, /checkpoint\.text_pending/);
  assert.match(batchService, /restoreBusinessTaskSession\(item.tenant_id, item.created_by_person_id\)/);
  assert.match(batchService, /aiImageOptimizerConfirmAnalysis/);
  assert.match(batchService, /aiImageOptimizerConfirmPlan/);
  assert.match(batchService, /createAiVariantListingDraftLightweight/);
  assert.match(batchService, /clone_source_draft: true/);
});

test("material optimization requires operator-confirmed product facts for every draft", () => {
  assert.match(batchSchema, /operator_facts_json LONGTEXT/);
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
  assert.match(batchService, /Promise\.allSettled\(\[detailPromise, copyPromise\]\)/);
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

test("credit reconciliation preserves the original material image task and sibling results for recovery", async () => {
  const start = batchService.indexOf("async function generateOptimizedImage("), end = batchService.indexOf("\nasync function mapWithConcurrency", start);
  for (const code of ["AI_CREDIT_RESULT_PENDING", "AI_CREDIT_RECONCILIATION_REQUIRED"]) {
    let checkpoint = { images: { detail: { state: "completed", url: "https://fixture.invalid/retained.png" } } };
    const requests = [], item = { id: 42, tenant_id: "2" };
    let reconciled = false;
    const generate = vm.runInNewContext(`(${batchService.slice(start, end)})`, {
      mysqlQuery: async (_sql, params) => { assert.deepEqual(Array.from(params), ["2", 42]); return [{ checkpoint_json: JSON.stringify(checkpoint) }]; },
      parseJson: JSON.parse,
      assertMaterialActor: async value => assert.equal(value, item),
      statusError: (message, status) => Object.assign(new Error(message), { status }),
      saveCheckpoint: async (_item, patch) => { checkpoint = { ...checkpoint, ...patch, images: { ...checkpoint.images, ...patch.images } }; },
      generateImages: async payload => {
        requests.push(payload);
        if (!reconciled) throw Object.assign(new Error("Original credit task requires review"), { code, creditTaskId: "original-credit-task" });
        return { taskId: "original-credit-task", generatedImages: [{ url: "https://fixture.invalid/recovered.png" }] };
      }
    });
    await assert.rejects(generate("https://fixture.invalid/source.png", "Preserve product", "Product", item, "main"), { code });
    assert.equal(checkpoint.images.main.credit_task_id, "original-credit-task");
    assert.equal(checkpoint.images.main.state, "submitting");
    assert.equal(checkpoint.images.detail.url, "https://fixture.invalid/retained.png");
    // A recovered worker must reach the original credit operation, rather than
    // failing its preflight as an unlinked, unknown supplier submission.
    reconciled = true;
    assert.equal(await generate("https://fixture.invalid/source.png", "Preserve product", "Product", item, "main"), "https://fixture.invalid/recovered.png");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].idempotencyKey, "material:42:main");
    assert.equal(requests[1].idempotencyKey, requests[0].idempotencyKey);
    assert.equal(checkpoint.images.main.task_id, "original-credit-task");
    assert.equal(checkpoint.images.detail.url, "https://fixture.invalid/retained.png");
  }
});

test("generation records label the paused credit recovery state without raw status values", () => {
  const view = fs.readFileSync(new URL("../frontend/admin/views/listing/AiGenerationRecordsView.vue", import.meta.url), "utf8");
  const declaration = view.match(/const labels=(\{[^\n]+\});/)[1];
  const labels = vm.runInNewContext(`(${declaration})`);
  assert.equal(labels.reconciliation_required, "待人工核对");
});
