import { createHash } from "node:crypto";
import { validateMaterialAnalysis, validateMaterialPlan, validateMaterialReview, createMaterialCopyValidator } from "./ai-credit-material-contracts.js";

const invalid = message => Object.assign(new Error(message), { status: 409, statusCode: 409, code: "AI_MATERIAL_STAGE_INVALID" });
const hash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

// Pure preparation only: no database, provider, reservation or settlement.
// The caller must first load and authorize these persisted server-side rows.
export function prepareAiMaterialStages(item, { draft, operatorFacts = {} }) {
  const tenantKey = String(item?.tenant_id || "");
  if (!(tenantKey === "admin" || /^[1-9][0-9]*$/.test(tenantKey)) || !Number.isSafeInteger(Number(item.created_by_person_id)) || Number(item.created_by_person_id) < 1
    || !/^[A-Za-z0-9_-]{1,64}$/.test(item.batch_no || "") || !/^[A-Za-z0-9_-]{1,64}$/.test(item.item_no || "")) throw invalid("素材阶段缺少已保存的企业、操作人或批次编号");
  if (!draft || Number(item.source_draft_id) !== Number(draft.id) || !Number.isSafeInteger(Number(draft.id)) || Number(draft.id) < 1) throw invalid("素材阶段来源草稿不一致");
  if (!["main_only", "full"].includes(item.optimization_scope)) throw invalid("素材交付范围无效");
  const images = draft.effective_images;
  if (!Array.isArray(images) || !images.length || images.some(image => typeof image !== "string" || !image.trim())) throw invalid("来源草稿缺少经过确认的有效图片");
  // Fail before a future quote if the final copy cannot be checked reliably.
  if (item.optimization_scope === "full") createMaterialCopyValidator({ draft, operatorFacts });
  const deliveryKey = `material:${tenantKey}:${item.batch_no}:${item.item_no}:delivery`;
  const sourceDefinition = { title: draft.product_name || "", categoryName: draft.category_name || "", templateId: draft.template_id || null,
    manualFacts: draft.manual_facts || draft.manual_facts_json || null,
    templateSha256: hash(JSON.stringify(canonical(draft.template_payload || draft.template_payload_json || null))) };
  const phase = (name, kind) => Object.freeze({ id: `${hash(deliveryKey)}:${name}`, name, kind,
    billing: "internal_only", customerResultCount: 0 });
  const stages = [phase("analysis", "vision"), phase("plan", "text"), phase("main", "image"), phase("review-main", "vision")];
  if (item.optimization_scope === "full") {
    for (let index = 0; index < Math.min(6, images.length - 1); index++) stages.push(phase(`detail-${index}`, "image"));
    stages.push(phase("copy-main", "text"));
  }
  return Object.freeze({ version: "material-delivery-v1", deliveryKey, tenantKey, actorId: Number(item.created_by_person_id),
    sourceDraftId: Number(draft.id), deliverable: item.optimization_scope, customerQuoteUnits: 1,
    inputSha256: hash(JSON.stringify(canonical({ draftId: draft.id, sourceDefinition, images, operatorFacts, scope: item.optimization_scope }))), stages: Object.freeze(stages) });
}

export function validatePreparedMaterialStage(prepared, stageName, content, { draft, operatorFacts = {} } = {}) {
  const stage = prepared?.stages?.find(stage => stage.name === stageName);
  if (!stage || stage.billing !== "internal_only" || stage.customerResultCount !== 0) throw invalid("素材阶段不属于原交付任务");
  const validators = { analysis: validateMaterialAnalysis, plan: validateMaterialPlan, "review-main": validateMaterialReview };
  if (stageName === "copy-main") {
    if (Number(draft?.id) !== prepared.sourceDraftId) throw invalid("文案来源与原交付任务不一致");
    validators[stageName] = createMaterialCopyValidator({ draft, operatorFacts });
  }
  // Images require the existing owned-file/hash/pixel boundary in the future
  // composite executor. A URL is deliberately not accepted by this text module.
  const accepted = Boolean(validators[stageName]?.(content));
  return { accepted, customerResultCount: 0, finalDeliveryAccepted: false };
}
