import assert from "node:assert/strict";
import test from "node:test";
import { prepareAiMaterialStages, validatePreparedMaterialStage } from "../src/services/ai-material-stage-preparation.js";

const item = { tenant_id: "2", created_by_person_id: 7, batch_no: "MAT-SAVED", item_no: "MAT-SAVED-10", source_draft_id: 10, optimization_scope: "main_only", attempts: 1 };
const input = { draft: { id: 10, effective_images: ["https://fixture.invalid/main.png"] }, operatorFacts: { product_title_zh: "汽车钥匙保护壳", confirmed_by_operator: true } };

test("one final deliverable quote has stable internal stages across worker restarts", () => {
  const first = prepareAiMaterialStages(item, input), recovered = prepareAiMaterialStages({ ...item, attempts: 9 }, structuredClone(input));
  assert.deepEqual(first, recovered);
  assert.equal(first.customerQuoteUnits, 1);
  assert.ok(first.stages.every(stage => stage.billing === "internal_only" && stage.customerResultCount === 0));
  assert.deepEqual(first.stages.map(stage => stage.name), ["analysis", "plan", "main", "review-main"]);
  assert.notEqual(first.deliveryKey, prepareAiMaterialStages({ ...item, tenant_id: "3" }, input).deliveryKey);
  assert.notEqual(first.inputSha256, prepareAiMaterialStages(item, { ...input, operatorFacts: { ...input.operatorFacts, quantity: 2 } }).inputSha256);
  assert.notEqual(first.inputSha256, prepareAiMaterialStages(item, { ...input, draft: { ...input.draft, product_name: "changed source" } }).inputSha256);
});

test("a full reviewed package retains one customer deliverable, including detail and copy stages", () => {
  const full = prepareAiMaterialStages({ ...item, optimization_scope: "full" }, {
    draft: { ...input.draft, product_name: "Чехол для ключа TENET T4, силикон, 1 шт.", effective_images: ["https://fixture.invalid/main.png", "https://fixture.invalid/detail.png"] },
    operatorFacts: { ...input.operatorFacts, selling_points_zh: ["硅胶材质", "一件装"], compatibility_zh: ["TENET T4"] }
  });
  assert.equal(full.customerQuoteUnits, 1);
  assert.deepEqual(full.stages.slice(-2).map(stage => stage.name), ["detail-0", "copy-main"]);
  assert.ok(full.stages.every(stage => stage.customerResultCount === 0));
});

test("valid negative review is an accepted internal result and never a customer settlement", () => {
  const prepared = prepareAiMaterialStages(item, input);
  const review = { pass: false, score: 30, issues_zh: ["商品主体发生变化"], corrections_en: "Restore the exact source product.", checks: {} };
  assert.deepEqual(validatePreparedMaterialStage(prepared, "review-main", JSON.stringify(review)), { accepted: true, customerResultCount: 0, finalDeliveryAccepted: false });
  assert.equal(validatePreparedMaterialStage(prepared, "review-main", "{}").accepted, false);
  assert.equal(validatePreparedMaterialStage(prepared, "main", "https://fixture.invalid/image.png").accepted, false);
  assert.throws(() => validatePreparedMaterialStage(prepared, "not-a-stage", "{}"), { code: "AI_MATERIAL_STAGE_INVALID" });
});

test("preparation rejects unowned legacy identities, draft mismatch and unsupported final-copy contract", () => {
  for (const changed of [{ tenant_id: "legacy_review" }, { created_by_person_id: 0 }, { item_no: "" }, { source_draft_id: 99 }]) {
    assert.throws(() => prepareAiMaterialStages({ ...item, ...changed }, input), { code: "AI_MATERIAL_STAGE_INVALID" });
  }
  assert.throws(() => prepareAiMaterialStages({ ...item, optimization_scope: "full" }, { ...input, draft: { ...input.draft, product_name: "Generic unknown product" }, operatorFacts: { product_title_zh: "未知品类", confirmed_by_operator: true } }), { code: "AI_CREDIT_CAPABILITY_DISABLED" });
});
