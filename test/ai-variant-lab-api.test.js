import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { aiProductMaterialOptimizerPrepareTemplate, applyOperatorFactOverrides, buildImageEditContract, buildOzonVariantTitle, buildVariantTitleFromSource, parseOperatorInstructions, removeSourceModelFromProductSubject } from "../src/services/ai-variant-lab.js";

const ROOT = path.resolve(".");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("operator instructions separate main-image scope from regenerated listing copy", () => {
  const rules = parseOperatorInstructions("主图只改车型标题，产品主体和背景不变；商品标题、标签、描述重新生成。");
  assert.deepEqual(rules.image_edit_scope, ["image_title"]);
  assert.deepEqual(rules.image_locked_scope, ["product_body", "background"]);
  assert.deepEqual(rules.copy_generation_scope, ["listing_title", "tags", "description"]);
});

test("AI variant product subjects remove the source vehicle without damaging target prefixes", () => {
  assert.equal(removeSourceModelFromProductSubject("Чехол для ключа TENET T4", "TENET T4"), "Чехол для ключа");
  assert.equal(removeSourceModelFromProductSubject("Чехол для TENET T4", "TENET T4"), "Чехол");
  assert.equal(removeSourceModelFromProductSubject("Чехол для ключа TENET T4L", "TENET T4"), "Чехол для ключа TENET T4L");
});

test("AI variant fallback titles contain only the target vehicle", () => {
  const analysis = {
    source_variant_value: "TENET T4",
    product_subject_ru: "Чехол для ключа TENET T4",
    product_fact_contract: { product_subject_ru: "Чехол для ключа TENET T4" },
    visible_texts: ["глянцевое покрытие"]
  };
  assert.equal(
    buildOzonVariantTitle("EXEED VX", analysis, { sourceVariantValue: "TENET T4" }),
    "Чехол для ключа EXEED VX, глянцевое покрытие"
  );
  assert.equal(
    buildOzonVariantTitle("TENET T4L", analysis, { sourceVariantValue: "TENET T4" }),
    "Чехол для ключа TENET T4L, глянцевое покрытие"
  );
});

test("AI variant titles preserve the complete source title while replacing only the vehicle", () => {
  const sourceTitle = "Чехол для ключа TENET T4, защитный TPU-кейс, глянцевый, тонкий, не мешает сигналу";
  assert.equal(
    buildVariantTitleFromSource(sourceTitle, "TENET T4", "EXEED VX"),
    "Чехол для ключа EXEED VX, защитный TPU-кейс, глянцевый, тонкий, не мешает сигналу"
  );
  assert.equal(
    buildVariantTitleFromSource(sourceTitle, "TENET T4", "TENET T4L"),
    "Чехол для ключа TENET T4L, защитный TPU-кейс, глянцевый, тонкий, не мешает сигналу"
  );
});

test("AI variant titles replace the complete slash-separated source model group", () => {
  const sourceTitle = "Защитный TPU-чехол для ключа TENET T4 / T4L с ремешком, черный автомобильный брелок";
  assert.equal(
    buildVariantTitleFromSource(sourceTitle, "TENET T4", "CHERY Tiggo 4 Pro"),
    "Защитный TPU-чехол для ключа CHERY Tiggo 4 Pro с ремешком, черный автомобильный брелок"
  );
});

test("operator instruction parser stays broad and does not depend on sticker wording", () => {
  const rules = parseOperatorInstructions("只改主图型号文字，实物本体保持不变；标题、标签和描述跟随目标车型更新。");
  assert.deepEqual(rules.image_edit_scope, ["image_title"]);
  assert.ok(rules.image_locked_scope.includes("product_body"));
  assert.deepEqual(rules.copy_generation_scope, ["listing_title", "tags", "description"]);
});

test("ai variant lab shows the interpreted operator rule before generation", () => {
  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");
  assert.match(view, /最终规则/);
  assert.match(view, /主图允许变化/);
  assert.match(view, /主图保持不变/);
  assert.match(view, /重新生成商品文案/);
  assert.match(view, /后端最终规则/);
  assert.match(view, /image_edit_contract\?\.operator_instructions/);
});

test("vehicle presets produce distinct enforceable image contracts", () => {
  const full = buildImageEditContract({
    variantType: "vehicle_model_swap",
    fallback: { operatorNote: "背景车辆、主图车型标题、产品上的车型或品牌标识允许随目标车型变化；商品标题、标签、描述重新生成；产品主体、材质、数量、结构不变。" }
  });
  assert.ok(full.replace_zones.includes("background_vehicle_cues"));
  assert.ok(full.replace_zones.includes("editable_brand_text"));

  const sameBrand = buildImageEditContract({
    variantType: "vehicle_model_swap",
    fallback: { operatorNote: "锁定整个产品本体，产品上的 Logo、品牌标识、车型字样、印刷文字和图案一律不变；只允许修改产品外部的主图标题/型号文本；允许修改背景车辆车型；商品标题、标签、描述重新生成。" }
  });
  assert.ok(sameBrand.replace_zones.includes("background_vehicle_cues"));
  assert.ok(sameBrand.replace_zones.includes("model_text"));
  assert.ok(!sameBrand.replace_zones.includes("logo_or_badge_text"));
  assert.ok(sameBrand.preserve_zones.includes("logo_or_badge_text"));

  const titleOnly = buildImageEditContract({
    variantType: "vehicle_model_swap",
    fallback: { operatorNote: "主图只改车型标题，产品主体、产品品牌标识和背景不变；商品标题、标签、描述重新生成。" }
  });
  assert.deepEqual(titleOnly.replace_zones, ["large_title_text", "model_text"]);
  assert.ok(titleOnly.preserve_zones.includes("background"));
  assert.ok(titleOnly.preserve_zones.includes("logo_or_badge_text"));

  const brandLogoOnly = buildImageEditContract({ variantType: "brand_logo_only_vehicle_fission", source: "CHERY Tiggo 7 Pro Max", target: "HAVAL H6" });
  assert.ok(brandLogoOnly.replace_zones.includes("background_vehicle_cues"));
  assert.ok(brandLogoOnly.replace_zones.includes("editable_brand_text"));
  assert.ok(brandLogoOnly.preserve_zones.includes("product_printed_model_text"));
  assert.equal(brandLogoOnly.logo_policy.mode, "plain_text_only");
  assert.equal(brandLogoOnly.logo_policy.official_logo_graphics, "forbid");
  assert.equal(brandLogoOnly.logo_policy.brand_asset_reference, "forbid");
  assert.equal(brandLogoOnly.logo_policy.target_model_on_product, "forbid");

  const brandLogoWithProtectedModelText = buildImageEditContract({
    variantType: "brand_logo_only_vehicle_fission",
    source: "BELGEE S50",
    target: "BMW X3",
    fallback: { operatorNote: "产品上的型号文字不变；产品品牌 Logo 必须替换为目标品牌 Logo，目标型号不得印到产品上。" }
  });
  assert.ok(brandLogoWithProtectedModelText.replace_zones.includes("editable_brand_text"));
  assert.ok(!brandLogoWithProtectedModelText.replace_zones.includes("logo_or_badge_text"));
  assert.equal(brandLogoWithProtectedModelText.logo_policy.preserve_product_printed_logo, false);
});

test("AI variant generation is disconnected from brand assets and forbids official logo graphics", () => {
  const service = read("src/services/ai-variant-lab.js");
  const routes = read("src/server/routes/aiVariantLab.js");
  const runtimeServices = read("src/services/mysql-runtime-services.js");
  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");
  assert.doesNotMatch(service, /ai-brand-assets|resolveAiBrandAssets|registered_asset|official-style brand mark/);
  assert.doesNotMatch(routes, /brand-assets|aiBrandAssets|registerAiBrandAsset/);
  assert.doesNotMatch(runtimeServices, /ai-brand-assets|aiBrandAssets|registerAiBrandAsset/);
  assert.match(service, /plain_text_only/);
  assert.match(service, /never generate, copy, reconstruct, imitate, or use a reference image for an official automotive logo/);
  assert.match(view, /跨品牌文字替换/);
  assert.match(view, /只使用清晰文本/);
});

test("same-brand operator rule removes product logo from variable recognition facts", () => {
  const analysis = applyOperatorFactOverrides({
    keep_facts: ["保持产品结构不变"],
    changeable_facts: ["车型、Logo、车牌和背景车属于可变内容", "产品表面印字 TANK 可变"],
    display_zh: {
      fixed_facts: ["保持产品结构不变"],
      variable_facts: ["车型、Logo、车牌和背景车属于可变内容"]
    }
  }, "锁定整个产品本体，产品上的 Logo、品牌标识、车型字样、印刷文字和图案一律不变；只允许修改产品外部的主图标题/型号文本；允许修改背景车辆车型。");
  assert.ok(analysis.keep_facts.includes("产品本体及其 Logo、品牌标识、车型字样、印刷文字和图案全部保持不变"));
  assert.ok(analysis.changeable_facts.some((fact) => /车型/.test(fact) && /背景车/.test(fact)));
  assert.ok(analysis.changeable_facts.every((fact) => !/Logo|品牌标识/.test(fact)));
});

test("negated sill-plate facts never become stable sill-plate prompt facts", () => {
  const service = read("src/services/ai-variant-lab.js");
  assert.match(service, /function isAffirmedSillPlateFact/);
  assert.match(service, /不是\|并非\|非\|不属于\|不得改成\|不要改成/);
  assert.match(service, /if \(isAffirmedSillPlateFact\(text\)\) facts\.push\("car door sill protector \/ sill plate product"\)/);
  const contract = buildImageEditContract({
    variantType: "vehicle_model_swap",
    source: "TENET T7",
    target: "TENET T4",
    keepFacts: ["这是汽车座椅靠背防踢垫/收纳挂袋，不是门槛条"],
    analysis: {
      product_type: "car seat back protector organizer",
      product_subject_ru: "Защитная накидка-органайзер на спинку сиденья автомобиля"
    }
  });
  assert.ok(contract.stable_facts.every((fact) => !/sill|threshold/i.test(fact)));
  assert.ok(contract.stable_facts.some((fact) => /car seat back protector organizer/i.test(fact)));
  assert.ok(contract.stable_facts.some((fact) => /kick mat organizer/i.test(fact)));
});

test("locked product identity wins over an adjacent change phrase", () => {
  const rules = parseOperatorInstructions("产品上的 Logo 不变；只改变车型型号、背景车辆和主图车型标题。");
  assert.ok(rules.image_locked_scope.includes("product_identity"));
  assert.ok(!rules.image_edit_scope.includes("product_identity"));
});

test("variant preset tooltips explain brand and model behavior", () => {
  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");
  assert.match(view, /锁定整个产品本体/);
  assert.match(view, /车型字样、印刷文字和图案/);
  assert.match(view, /产品全锁，只换标题与背景车/);
  assert.match(view, /:content="preset\.hint"/);
});

test("changing operator rules invalidates stale plans before image generation", () => {
  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");
  assert.match(view, /const operatorRulesNeedReplan = computed/);
  assert.match(view, /backendRulesMatchCurrentNote/);
  assert.match(view, /人工备注已变化，请返回识别产品步骤重新生成批量计划/);
  assert.match(view, /function normalizeOperatorNote\(value = ""\)/);
  assert.match(view, /replace\(\/\\s\+\/g, " "\)\.trim\(\)/);
  assert.match(view, /normalizeOperatorNote\(material\.operatorNote\) !== plannedOperatorNote\.value/);
  assert.match(view, /!state\.batchJob \|\| operatorRulesNeedReplan/);
});

test("ai variant lab uses compact recognition rows and a cross-filter vehicle picker", () => {
  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");
  assert.match(view, /class="recognition-facts-grid"/);
  assert.match(view, /class="variant-rule-workspace"/);
  assert.doesNotMatch(view, /源车型（母图原车型，只填一个）/);
  assert.match(view, /车型标签/);
  assert.match(view, /汽车品牌/);
  assert.match(view, /加入当前品牌全部型号/);
  assert.match(view, /新增品牌 \/ 车型/);
});

test("vehicle catalog persists document models, tags, and user additions", () => {
  const service = read("src/services/ai-vehicle-catalog.js");
  const routes = read("src/server/routes/aiVariantLab.js");
  assert.match(service, /CREATE TABLE IF NOT EXISTS ai_vehicle_catalog/);
  assert.match(service, /\["HAVAL", \["Jolion"/);
  assert.match(service, /\["CHERY", \["Tiggo 4 Pro"/);
  assert.match(service, /\["TENET", \["T7"/);
  assert.match(service, /hot_new/);
  assert.match(service, /hot_new_energy/);
  assert.match(service, /新能源热门车型/);
  assert.match(service, /"GEELY EX5 EM-I"/);
  assert.match(service, /"GAC S7"/);
  assert.match(service, /"EXEED EXLANTIX ET"/);
  assert.match(service, /"EVOLUTE I-SPACE"/);
  assert.match(service, /"LYNK & CO 900"/);
  assert.match(service, /function isLatinVehicleBrand/);
  assert.match(service, /汽车品牌必须使用俄罗斯市场可识别的英文名称/);
  assert.match(service, /hot_used/);
  assert.match(service, /source, created_by_person_id/);
  assert.match(service, /RUSSIA_CHINA_VEHICLE_ANCHORS/);
  assert.match(service, /\["JELAND", "J7", \["JAECOO J7", "探索06"\]/);
  assert.match(service, /\["VOLGA", "K40", \["GEELY ATLAS", "博越L", "BOYUE L"\]/);
  assert.match(service, /\["ESTEO", "V27", \["ICAR V27", "ICAUR V27", "奇瑞ICAR V27"\]/);
  assert.match(service, /aliases_json/);
  assert.match(service, /search_keywords_json/);
  assert.match(routes, /GET \/api\/ai-variant-lab\/vehicle-catalog/);
  assert.match(routes, /POST \/api\/ai-variant-lab\/vehicle-catalog/);
});

test("vehicle picker explains and disables the recognized source model", () => {
  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");
  assert.match(view, /母车型：\$\{sourceModel\}（不重复生成）/);
  assert.match(view, /:disabled="isSourceVehicleModel\(model\.fullName\)"/);
  assert.match(view, /当前母车型，不重复生成/);
});

test("ai provider exposes a multimodal vision call with text fallback", () => {
  const source = read("src/services/ai-provider-settings.js");
  assert.match(source, /export async function visionWithAiProvider/);
  assert.match(source, /route:\s*"vision"/);
  assert.match(source, /fallbackRoute:\s*"text"/);
  assert.match(source, /normalizeVisionMessages/);
  assert.match(source, /type === "image_url"/);
  assert.match(source, /apiMode/);
  assert.match(source, /callOpenAiResponses/);
  assert.match(source, /messagesToResponsesInput/);
  assert.match(source, /allowImageOnly/);
  assert.match(source, /change2pro-image2/);
  assert.match(source, /api\.change2pro\.com/);
  assert.match(source, /function isCustomProviderKey/);
  assert.match(source, /\^custom_/);
  assert.match(source, /providerPreset\(provider\)/);
});

test("ai variant lab service stores analysis, plans, templates, and avoids image spend in prompt preflight", () => {
  const source = read("src/services/ai-variant-lab.js");
  assert.match(source, /CREATE TABLE IF NOT EXISTS ai_variant_lab_analyses/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS ai_variant_lab_plans/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS ai_variant_templates/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS ai_variant_template_cases/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS ai_variant_case_templates/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS ai_variant_case_runs/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS ai_variant_lab_batch_jobs/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS ai_variant_lab_batch_items/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS ai_image_optimizer_jobs/);
  assert.match(source, /export async function aiVariantLabAnalyzeImage/);
  assert.match(source, /export async function aiVariantLabPlanVariant/);
  assert.match(source, /export async function aiVariantLabBatchPlan/);
  assert.match(source, /export async function aiVariantLabBatchRunImages/);
  assert.match(source, /export async function aiImageOptimizerAnalyze/);
  assert.match(source, /export async function aiImageOptimizerPlan/);
  assert.match(source, /export async function aiProductMaterialOptimizerPrepareTemplate/);
  assert.match(source, /function resolveOptimizerImageInputs/);
  assert.match(source, /function shouldReuseAnalysis/);
  assert.match(source, /function findReusableVariantAnalysis/);
  assert.match(source, /function findReusableOptimizerAnalysis/);
  assert.match(source, /function latestAnalysisRow/);
  assert.match(source, /export async function aiVariantLabAnalysisLookup/);
  assert.match(source, /export async function aiImageOptimizerAnalysisLookup/);
  assert.match(source, /body\.lookupOnly \|\| body\.lookup_only/);
  assert.match(source, /body\.reuseAnalysis \|\| body\.reuse_analysis/);
  assert.match(source, /reused_from: "history"/);
  assert.match(source, /export async function aiVariantLabSaveTemplate/);
  assert.match(source, /export async function aiVariantLabSaveCase/);
  assert.match(source, /export async function aiVariantLabCases/);
  assert.match(source, /export async function aiVariantLabCaseDetail/);
  assert.match(source, /export async function aiVariantLabDeleteCase/);
  assert.match(source, /status <> 'deleted'/);
  assert.match(source, /SELECT COUNT\(\*\) AS total/);
  assert.match(source, /LIMIT \? OFFSET \?/);
  assert.match(source, /pageSize/);
  assert.match(source, /dry_run/);
  assert.match(source, /execute === true/);
});

test("ai variant lab routes are registered in server and runtime services", () => {
  const routes = read("src/server/routes/aiVariantLab.js");
  assert.match(routes, /POST \/api\/ai-variant-lab\/analyze-image/);
  assert.match(routes, /POST \/api\/ai-variant-lab\/analysis\/lookup/);
  assert.match(routes, /POST \/api\/ai-variant-lab\/plan-variant/);
  assert.match(routes, /POST \/api\/ai-variant-lab\/batch-plan/);
  assert.match(routes, /POST \/api\/ai-variant-lab\/batch-run-images/);
  assert.match(routes, /GET \/api\/ai-variant-lab\/batch-jobs/);
  assert.match(routes, /POST \/api\/ai-variant-lab\/optimize\/analyze/);
  assert.match(routes, /POST \/api\/ai-variant-lab\/optimize\/analysis\/lookup/);
  assert.match(routes, /POST \/api\/ai-variant-lab\/optimize\/plan/);
  assert.match(routes, /POST \/api\/ai-variant-lab\/optimize\/prepare-template/);
  assert.match(routes, /POST \/api\/ai-variant-lab\/save-template/);
  assert.match(routes, /POST \/api\/ai-variant-lab\/cases/);
  assert.match(routes, /GET \/api\/ai-variant-lab\/cases/);
  assert.match(routes, /req\.method === "DELETE" && parts\[2\] === "cases"/);
  assert.match(routes, /GET \/api\/ai-variant-lab\/templates/);
  assert.match(routes, /aiVariantLabCaseDetail/);
  assert.match(routes, /aiVariantLabDeleteCase/);
  assert.match(routes, /handleAiVariantLabRestRoute/);

  const server = read("src/server.js");
  assert.match(server, /createAiVariantLabRoutes/);
  assert.match(server, /handleAiVariantLabRestRoute/);

  const services = read("src/services/mysql-runtime-services.js");
  assert.match(services, /aiVariantLabAnalyzeImage/);
  assert.match(services, /aiVariantLabAnalysisLookup/);
  assert.match(services, /aiVariantLabBatchPlan/);
  assert.match(services, /aiVariantLabBatchRunImages/);
  assert.match(services, /aiImageOptimizerAnalyze/);
  assert.match(services, /aiImageOptimizerAnalysisLookup/);
  assert.match(services, /aiProductMaterialOptimizerPrepareTemplate/);
  assert.match(services, /aiVariantLabPlanVariant/);
  assert.match(services, /aiVariantLabSaveCase/);
  assert.match(services, /aiVariantLabCases/);
  assert.match(services, /aiVariantLabCaseDetail/);
  assert.match(services, /aiVariantLabDeleteCase/);
  assert.match(services, /aiVariantLabTemplates/);
});

test("variant analysis history lookup does not select optimizer-only status column", () => {
  const source = read("src/services/ai-variant-lab.js");

  assert.match(source, /includeStatus = false/);
  assert.match(source, /source_image_url\$\{includeStatus \? ", status" : ""\}/);
  assert.match(source, /table: "ai_image_optimizer_jobs",[\s\S]*includeStatus: true/);
});

test("vision provider retries transient upstream failures and returns provider context", () => {
  const source = read("src/services/ai-provider-settings.js");

  assert.match(source, /\[500, 502, 503, 504\]\.includes\(firstStatus\)/);
  assert.match(source, /function visionProviderError/);
  assert.match(source, /视觉识别服务失败：\$\{provider\} \/ \$\{model\}/);
});

test("ai variant case library saves template snapshots and has frontend entry", () => {
  const service = read("src/services/ai-variant-lab.js");
  const routes = read("src/server/routes/aiVariantLab.js");
  const labView = read("frontend/admin/views/listing/AiVariantLabView.vue");
  const caseView = read("frontend/admin/views/listing/AiVariantCaseLibraryView.vue");
  const repairScript = read("scripts/repair-ai-variant-case-images.mjs");
  const layout = read("frontend/admin/layouts/AdminLayout.vue");
  const standaloneWindow = read("frontend/admin/utils/ai-variant-lab-window.js");
  const router = read("frontend/admin/router/index.js");
  const navigation = read("frontend/admin/constants/navigation.js");

  assert.match(service, /function buildVariantCaseFromBody/);
  assert.match(service, /listing_template_snapshot/);
  assert.match(service, /template_payload/);
  assert.match(service, /sample_outputs/);
  assert.match(service, /sample_assets/);
  assert.match(routes, /parts\[2\] === "cases"/);
  assert.match(routes, /services\.aiVariantLabDeleteCase/);
  assert.match(labView, /apiClient\.post\("\/api\/ai-variant-lab\/cases"/);
  assert.match(labView, /function verifySavedCase/);
  assert.match(labView, /\/api\/ai-variant-lab\/cases\/\$\{encodeURIComponent\(key\)\}/);
  assert.match(labView, /后端服务已更新并重启/);
  assert.match(labView, /function buildSaveCasePayload/);
  assert.match(labView, /async function saveCaseRow/);
  assert.match(labView, /await persistGeneratedRowAssets\(row\)/);
  assert.match(labView, /generated_main_image_url: rowMainImageDraftUrl\(row\)/);
  assert.match(labView, /generated_main_image_original_url: resultImageUrl\(row\)/);
  assert.match(labView, /保存选中案例/);
  assert.match(labView, /@click="saveCaseRow\(row\)">保存案例/);
  assert.match(labView, /class="queue-table"[\s\S]*:height="queueTableHeight"[\s\S]*@selection-change="onPlanSelectionChange"/);
  assert.match(labView, /const queueTableHeight = computed/);
  assert.match(labView, /label="状态"[\s\S]*class="queue-status-stack"/);
  assert.match(labView, /label="操作"[\s\S]*class="queue-action-stack"/);
  assert.doesNotMatch(labView, /状态\/操作/);
  assert.doesNotMatch(labView, /label="图片优化"/);
  assert.doesNotMatch(labView, /optimizer-grid/);
  assert.match(labView, /案例请在单行操作里保存/);
  assert.doesNotMatch(labView, /class="template-box"/);
  assert.doesNotMatch(labView, /placeholder="案例名称"/);
  assert.match(labView, /template_payload: templatePayload/);
  assert.match(labView, /source_draft_id: material\.sourceDraftId/);
  assert.match(labView, /title_ru: rowTitleOutput\(row\)/);
  assert.match(labView, /tags_ru: rowTagsOutput\(row\)/);
  assert.match(labView, /description_ru: rowDescriptionOutput\(row\)/);
  assert.match(caseView, /AI裂变案例库/);
  assert.match(caseView, /\/api\/ai-variant-lab\/cases/);
  assert.match(caseView, /apiClient\.delete\(`\/api\/ai-variant-lab\/cases\/\$\{encodeURIComponent\(caseNo\)\}`\)/);
  assert.match(caseView, /function deleteCase/);
  assert.match(caseView, /shanghaiDateTimeText/);
  assert.match(caseView, /快速裂变/);
  assert.match(caseView, /加载失败/);
  assert.match(caseView, /function firstStableUrl/);
  assert.match(caseView, /isTemporaryAiImageUrl/);
  assert.match(caseView, /firstSample\.assets\?\.main_image\?\.publishUrl/);
  assert.match(repairScript, /ai_variant_case_templates/);
  assert.match(repairScript, /listing_ai_variant_assets/);
  assert.match(repairScript, /materializeListingMediaAssetUrl/);
  assert.match(repairScript, /generated_main_image_asset_url/);
  assert.match(caseView, /el-dialog/);
  assert.match(caseView, /PageFooterPagination/);
  assert.match(caseView, /case-library-footer/);
  assert.match(caseView, /pagination\.total/);
  assert.match(caseView, /changePageSize/);
  assert.match(caseView, /:height="tableHeight"/);
  assert.doesNotMatch(caseView, /el-drawer/);
  assert.match(caseView, /openAiVariantLabWindow/);
  assert.match(caseView, /source: "case"/);
  assert.match(caseView, /caseTargets: targets\.join\("\\n"\)/);
  assert.match(labView, /async function autoImportRouteCase/);
  assert.match(labView, /async function importCaseForQuickVariant/);
  assert.match(labView, /const quickCaseImport = reactive/);
  assert.match(labView, /quickCaseImport\.active = true/);
  assert.match(labView, /currentStep\.value = "generate"/);
  assert.match(labView, /正在根据案例准备生成队列/);
  assert.match(labView, /v-if="quickCaseImport\.active"/);
  assert.match(labView, /currentStep\.value = "generate"/);
  assert.match(labView, /useAiPlan: true/);
  assert.match(labView, /copy_source: "case_library_ai_plan"/);
  assert.match(labView, /function applyCaseMetadataToRows/);
  assert.match(labView, /function caseVariantStaleValues/);
  assert.match(labView, /不得残留案例源值或成功样例目标值/);
  assert.doesNotMatch(labView, /function buildCaseTagsText/);
  assert.doesNotMatch(labView.match(/async function importCaseForQuickVariant[\s\S]*?function toPlanRow/)?.[0] || "", /#накладки_на_пороги/);
  assert.match(labView, /\.split\(\/\[,，、;\\s\]\+\//);
  assert.match(standaloneWindow, /openAiVariantLabWindow/);
  assert.match(standaloneWindow, /standalone: "1"/);
  assert.match(standaloneWindow, /window\.open\(url, "_blank"/);
  assert.doesNotMatch(standaloneWindow, /window\.location\.href/);
  assert.match(layout, /standaloneMode/);
  assert.match(layout, /openAiVariantLabWindow\(\{ source: "menu" \}\)/);
  assert.match(standaloneWindow, /openAiProductMaterialOptimizerWindow/);
  assert.match(standaloneWindow, /\/admin\.html#\/ai-product-material-optimizer/);
  assert.match(layout, /openAiProductMaterialOptimizerWindow\(\{ source: "menu" \}\)/);
  assert.match(router, /AiVariantCaseLibraryView/);
  assert.match(router, /ai-variant-cases/);
  assert.match(navigation, /AI裂变案例库/);
});

test("ai provider settings can add named custom compatible providers", () => {
  const view = read("frontend/admin/views/settings/AiProviderSettingsView.vue");

  assert.match(view, /const providerOptions = computed/);
  assert.match(view, /savedProviders\.value\?\.\[option\.value\]\?\.name \|\| option\.label/);
  assert.match(view, /providerProfileFromImageChannel/);
  assert.match(view, /cleanChannelProviderName/);
  assert.match(view, /imageEffectiveConcurrency/);
  assert.match(view, /imageChannelCapacity/);
  assert.match(view, /实际生效并发/);
  assert.match(view, /includeImageProviderPool/);
  assert.match(view, /saveConfig\(\{ includeImageProviderPool: false \}\)/);
  assert.match(view, /function createProviderProfile/);
  assert.match(view, /custom_\$\{Date\.now\(\)\.toString\(36\)\}/);
  assert.match(view, /v-for="item in providerOptions"/);
  assert.match(view, /v-for="option in providerOptions"/);
  assert.match(view, /新增自定义/);
});

test("product material optimizer has an isolated frontend route and navigation entry", () => {
  const router = read("frontend/admin/router/index.js");
  const navigation = read("frontend/admin/constants/navigation.js");
  const view = read("frontend/admin/views/listing/AiProductMaterialOptimizerView.vue");

  assert.match(router, /AiProductMaterialOptimizerView/);
  assert.match(router, /ai-product-material-optimizer/);
  assert.match(navigation, /AI商品素材优化/);
  assert.match(view, /finalImageSlots/);
  assert.match(view, /v-show="currentStep === 'material'"/);
  assert.match(view, /v-show="currentStep === 'recognize'"/);
  assert.match(view, /v-show="currentStep === 'plan'"/);
  assert.match(view, /v-show="currentStep === 'generate'"/);
  assert.match(view, /v-show="currentStep === 'select'"/);
  assert.match(view, /class="material-layout"/);
  assert.match(view, /从采集箱导入/);
  assert.match(view, /从草稿箱导入/);
  assert.match(view, /从在线商品导入/);
  assert.match(view, /按建议生成结果/);
  assert.match(view, /确认识别结果，进入优化建议/);
  assert.match(view, /确认优化建议，进入生成结果/);
  assert.match(view, /确认生成结果，选择图片位/);
  assert.match(view, /返回上一步/);
  assert.match(view, /class="result-table"/);
  assert.match(view, /主图结果/);
  assert.match(view, /详情图结果/);
  assert.match(view, /状态\/操作/);
  assert.match(view, /function openImportDialog/);
  assert.match(view, /function loadImportRows/);
  assert.match(view, /function confirmImportMaterial/);
  assert.match(view, /function hydrateImportCandidate/);
  assert.match(view, /import \{ useRoute \} from "vue-router"/);
  assert.match(view, /const route = useRoute\(\)/);
  assert.match(view, /void autoImportRouteMaterial\(\)/);
  assert.match(view, /async function autoImportRouteMaterial/);
  assert.match(view, /function routeImportSource/);
  assert.match(view, /source === "listing_draft"/);
  assert.match(view, /source === "collector_box"/);
  assert.match(view, /source === "online_product"/);
  assert.match(view, /source === "listing_record"/);
  assert.match(view, /function routeImportDetailUrl/);
  assert.match(view, /\/api\/listing\/drafts\/\$\{encoded\}/);
  assert.match(view, /\/api\/listing\/collector-box\/\$\{encoded\}/);
  assert.match(view, /\/api\/online-products\/\$\{encoded\}\/edit-draft/);
  assert.match(view, /\/api\/listing\/publish-records\/\$\{encoded\}/);
  assert.match(view, /sourceId: source === "draft" \? String\(row\.id \|\| ""\)\.trim\(\) : sourceSku \|\| row\.id \|\| ""/);
  assert.match(view, /function generateMaterialResults/);
  assert.match(view, /\/api\/listing\/collector-box\?\$\{params\.toString\(\)\}/);
  assert.match(view, /\/api\/listing\/drafts\?\$\{params\.toString\(\)\}/);
  assert.match(view, /\/api\/online-products\?\$\{params\.toString\(\)\}/);
  assert.match(view, /\/api\/online-products\/\$\{encodeURIComponent\(row\.sourceId\)\}\/edit-draft/);
  assert.match(view, /导入为素材/);
  assert.doesNotMatch(view, /notifyImportSource/);
  assert.match(view, /function analyzeMaterial/);
  assert.match(view, /function planMaterial/);
  assert.match(view, /\/api\/ai-variant-lab\/optimize\/analyze/);
  assert.match(view, /\/api\/ai-variant-lab\/optimize\/plan/);
  assert.match(view, /\/api\/ai-variant-lab\/optimize\/prepare-template/);
  assert.doesNotMatch(view, /ListingAutomationView/);
});

test("product material optimizer analyze keeps multi-image context explicit", () => {
  const source = read("src/services/ai-variant-lab.js");
  const view = read("frontend/admin/views/listing/AiProductMaterialOptimizerView.vue");

  assert.match(source, /resolveOptimizerImageInputs\(body\)/);
  assert.match(source, /imageInputs\.map\(\(item\) => \(\{ type: "image_url"/);
  assert.match(source, /Treat the first image as the default main image/);
  assert.match(source, /later images as detail\/reference material/);
  assert.match(source, /You may read source titles, tags, descriptions, and visible image text in English, Russian, or Chinese/);
  assert.match(source, /All operator-facing analysis fields must be written in Simplified Chinese/);
  assert.match(source, /display_zh must include recognition_summary, product_type, fixed_facts, main_image_observation, detail_image_observation, recommended_action/);
  assert.match(source, /const analysis = normalizeOptimizerAnalysis\(parseJsonObject/);
  assert.match(source, /function normalizeOptimizerAnalysis/);
  assert.match(source, /function normalizeOptimizerAnalysisDisplayZh/);
  assert.match(source, /const reusable = shouldReuseAnalysis\(body\)[\s\S]*findReusableOptimizerAnalysis/);
  assert.match(source, /if \(body\.lookupOnly \|\| body\.lookup_only\) \{[\s\S]*findReusableOptimizerAnalysis/);
  assert.match(view, /sourceProductId: form\.sourceSku/);
  assert.match(view, /sourceImageUrl: form\.mainImageUrl \|\| mainImagePreview\.value/);
  assert.match(view, /apiClient\.post\("\/api\/ai-variant-lab\/optimize\/analysis\/lookup", payload\)/);
  assert.match(view, /await confirmUseHistoryAnalysis\(history\)/);
  assert.match(view, /forceAnalyze: true/);
  assert.match(view, /ElMessageBox\.confirm/);
  assert.match(view, /confirmButtonText: "复用历史识别"/);
  assert.match(view, /cancelButtonText: "重新识别"/);
  assert.match(view, /function applyMaterialAnalysisResult/);
  assert.match(source, /slice\(0, 8\)/);
});

test("product material optimizer locks operator-confirmed Chinese product facts before AI", () => {
  const service = read("src/services/ai-variant-lab.js");
  const view = read("frontend/admin/views/listing/AiProductMaterialOptimizerView.vue");

  assert.match(view, /productTitleZh/);
  assert.match(view, /sellingPointsZh/);
  assert.match(view, /productFactsConfirmed/);
  assert.match(view, /operatorFacts: operatorProductFacts\.value/);
  assert.match(view, /至少 2 条真实卖点/);
  assert.match(view, /描述没有包含已确认的适配车型或适用对象/);
  assert.match(service, /OPERATOR-CONFIRMED PRODUCT FACTS \(highest priority\)/);
  assert.match(service, /operator_confirmed_facts/);
});

test("product material optimizer allows slow multi-image vision responses", () => {
  const source = read("src/services/ai-variant-lab.js");
  const view = read("frontend/admin/views/listing/AiProductMaterialOptimizerView.vue");

  assert.match(source, /timeoutMs:\s*180_000/);
  assert.match(view, /recognitionProgress\.elapsedSeconds >= 150/);
});

test("AI variant lab allows slow product recognition responses", () => {
  const source = read("src/services/ai-variant-lab.js");
  const analyzeHandler = source.match(/export async function aiVariantLabAnalyzeImage[\s\S]*?export async function aiVariantLabAnalysisLookup/)?.[0] || "";

  assert.match(analyzeHandler, /timeoutMs:\s*180_000/);
});

test("product material optimizer allows slow generation plan responses", () => {
  const source = read("src/services/ai-variant-lab.js");
  const planHandler = source.match(/export async function aiImageOptimizerPlan[\s\S]*?export async function aiImageOptimizerReviewImage/)?.[0] || "";

  assert.match(planHandler, /timeoutMs:\s*180_000/);
});

test("product material optimizer retries transient generation plan failures", () => {
  const source = read("src/services/ai-variant-lab.js");

  assert.match(source, /callOptimizerPlanWithRetry\(planRequest\)/);
  assert.match(source, /\[500, 502, 503, 504\]\.includes\(status\)/);
  assert.match(source, /return await chatWithAiProvider\(payload\)/);
});

test("product material optimizer allows slow downstream generation stages", () => {
  const service = read("src/services/ai-variant-lab.js");
  const view = read("frontend/admin/views/listing/AiProductMaterialOptimizerView.vue");
  const api = read("frontend/admin/api/tools/aiImageGenerator.js");
  const workflow = read("src/server/services/ai/aiWorkflowService.js");
  const reviewHandler = service.match(/export async function aiImageOptimizerReviewImage[\s\S]*?export async function aiImageOptimizerComposeText/)?.[0] || "";

  assert.match(reviewHandler, /timeoutMs:\s*180_000/);
  assert.match(view, /MATERIAL_IMAGE_WAIT_MS = 20 \* 60 \* 1000/);
  assert.match(view, /MATERIAL_COPY_WAIT_MS = 10 \* 60 \* 1000/);
  assert.match(view, /MATERIAL_VIDEO_WAIT_MS = 30 \* 60 \* 1000/);
  assert.match(view, /aiTimeoutMs: 180_000/);
  assert.match(api, /Number\(options\.timeoutMs \|\| 10 \* 60 \* 1000\)/);
  assert.match(workflow, /payload\.aiTimeoutMs \|\| payload\.ai_timeout_ms/);
});

test("legacy AI optimization route imports online products and listing drafts", () => {
  const view = read("frontend/admin/views/settings/PromptLibraryView.vue");
  assert.match(view, /importOnlineProductFromRoute\(\)/);
  assert.match(view, /importListingDraftFromRoute\(\)/);
  assert.match(view, /watch\(\(\) => \[route\.query\.onlineProductId, route\.query\.source, route\.query\.autoImport, route\.query\.importAt\]/);
  assert.match(view, /watch\(\(\) => \[route\.query\.draftId, route\.query\.draftIds, route\.query\.source, route\.query\.autoImport, route\.query\.importAt\]/);
  assert.match(view, /async function importOnlineProductFromRoute/);
  assert.match(view, /\/api\/online-products\/\$\{encodeURIComponent\(onlineProductId\)\}\/edit-draft/);
  assert.match(view, /applyOnlineProductSource\(detail \|\| \{\}\)/);
  assert.match(view, /async function importListingDraftFromRoute/);
  assert.match(view, /firstRouteId\(route\.query\.draftId \|\| route\.query\.draftIds\)/);
  assert.match(view, /\/api\/listing\/drafts\/\$\{encodeURIComponent\(draftId\)\}/);
  assert.match(view, /function applyListingDraftSource/);
  assert.match(view, /task\.sourceLabel = `草稿 #\$\{detail\.id \|\| ""\}/);
  assert.match(view, /sourceSubmitMode\.value = "asset_only"/);
});

test("product material optimizer recognition view uses Chinese display nodes", () => {
  const view = read("frontend/admin/views/listing/AiProductMaterialOptimizerView.vue");

  assert.match(view, /const recognitionFactRows = computed\(\(\) => analysisNodeRows\("fixed_facts"\)\)/);
  assert.match(view, /const recognitionProblemRows = computed/);
  assert.match(view, /const recognitionForbiddenRows = computed\(\(\) => analysisNodeRows\("forbidden_changes"\)\)/);
  assert.match(view, /function analysisNodeRows/);
  assert.match(view, /v-if="recognitionFactRows\.length"/);
  assert.match(view, /v-for="item in recognitionFactRows"/);
  assert.match(view, /v-if="recognitionProblemRows\.length"/);
  assert.match(view, /v-for="item in recognitionProblemRows"/);
  assert.match(view, /v-if="recognitionForbiddenRows\.length"/);
  assert.match(view, /v-for="item in recognitionForbiddenRows"/);
  assert.doesNotMatch(view, /v-for="item in state\.analysis\.keep_facts"/);
  assert.doesNotMatch(view, /v-for="item in state\.analysis\.current_problems"/);
});

test("product material optimizer plans operator suggestions by listing node in Chinese", () => {
  const service = read("src/services/ai-variant-lab.js");
  const view = read("frontend/admin/views/listing/AiProductMaterialOptimizerView.vue");

  assert.match(service, /You may use English for image_optimization_prompt_en and negative_prompt_en/);
  assert.match(service, /All operator-facing plan fields must be Simplified Chinese/);
  assert.match(service, /display_zh must include main_image_plan, detail_image_plan, title_plan, tags_plan, description_plan/);
  assert.match(service, /function normalizeOptimizerDisplayZh/);
  assert.match(service, /main_image_plan: cleanText/);
  assert.match(service, /detail_image_plan: cleanText/);
  assert.match(service, /description_plan: cleanText/);
  assert.match(view, /const mainImageSuggestionRows = computed/);
  assert.match(view, /const detailImageSuggestionRows = computed/);
  assert.match(view, /const titleSuggestionRows = computed/);
  assert.match(view, /const tagSuggestionRows = computed/);
  assert.match(view, /const descriptionSuggestionRows = computed/);
  assert.match(view, /function planNodeRows/);
  assert.match(view, /function firstPlanNodeText/);
  assert.match(view, /title: state\.generated\?\.title \|\| form\.title/);
  assert.match(view, /title: firstPlanNodeText\("title_plan", form\.title\)/);
  assert.match(view, /tags: planNodeRows\("tags_plan", splitLines\(form\.tags\)\)/);
  assert.match(view, /description: firstPlanNodeText\("description_plan", form\.description\)/);
  assert.match(view, /<h4>主图建议<\/h4>/);
  assert.match(view, /<h4>详情图方案<\/h4>/);
  assert.match(view, /<h4>标题建议<\/h4>/);
  assert.match(view, /<h4>标签建议<\/h4>/);
  assert.match(view, /<h4>描述建议<\/h4>/);
  assert.doesNotMatch(view, /<h4>图片建议<\/h4>/);
  assert.doesNotMatch(view, /<h4>文字建议<\/h4>/);
});

test("product material optimizer plan includes a normalized coherent suite storyboard", () => {
  const service = read("src/services/ai-variant-lab.js");
  assert.match(service, /suite_storyboard must contain 4 to 5 ordered image-shot objects/);
  assert.match(service, /function normalizeOptimizerStoryboard\(value = \[\]\)/);
  assert.match(service, /composition_en/);
  assert.match(service, /must_show_en/);
  assert.match(service, /shots\[0\]\.role = "main"/);
});

test("product material optimizer exposes strict post-generation image review", () => {
  const service = read("src/services/ai-variant-lab.js");
  const routes = read("src/server/routes/aiVariantLab.js");
  assert.match(routes, /POST \/api\/ai-variant-lab\/optimize\/review-image/);
  assert.match(service, /export async function aiImageOptimizerReviewImage/);
  assert.match(service, /function optimizerImageReviewSystemPrompt\(\)/);
  assert.match(service, /function normalizeOptimizerImageReview\(value = \{\}\)/);
  assert.match(service, /wrong color, wrong quantity, distorted geometry/);
  assert.match(service, /Reject omitted, paraphrased, misspelled, duplicated, truncated, unreadable or invented copy/);
  assert.match(service, /the product must remain dominant, the title must be immediately readable on mobile/);
});

test("product material optimizer persists confirmed recognition plan and generated result nodes", () => {
  const service = read("src/services/ai-variant-lab.js");
  const routes = read("src/server/routes/aiVariantLab.js");
  assert.match(routes, /POST \/api\/ai-variant-lab\/optimize\/analysis\/confirm/);
  assert.match(routes, /POST \/api\/ai-variant-lab\/optimize\/plan\/confirm/);
  assert.match(routes, /POST \/api\/ai-variant-lab\/optimize\/result/);
  assert.match(routes, /parts\[3\] === "jobs"/);
  assert.match(service, /status = 'analysis_confirmed'/);
  assert.match(service, /plan_json = NULL, result_json = NULL/);
  assert.match(service, /status = 'plan_confirmed'/);
  assert.match(service, /export async function aiImageOptimizerSaveResult/);
  assert.match(service, /export async function aiImageOptimizerJobDetail/);
});

test("product material optimizer composes safe Russian text with sharp", () => {
  const service = read("src/services/ai-variant-lab.js");
  const routes = read("src/server/routes/aiVariantLab.js");
  assert.match(routes, /POST \/api\/ai-variant-lab\/optimize\/compose-text/);
  assert.match(service, /export async function aiImageOptimizerComposeText/);
  assert.match(service, /function optimizerTextOverlaySvg/);
  assert.match(service, /DejaVu Sans, Arial, sans-serif/);
  assert.match(service, /resolveUploadSubdir\("listing-media"\)/);
});

test("product material optimizer normalizes multiple main visual directions", () => {
  const service = read("src/services/ai-variant-lab.js");
  assert.match(service, /main_visual_directions must contain 2 distinct but conservative objects/);
  assert.match(service, /function normalizeMainVisualDirections\(value = \[\]\)/);
  assert.match(service, /Bright premium studio presentation/);
  assert.match(service, /Premium contextual presentation/);
});

test("product material optimizer plans a verified commercial main-image overlay", () => {
  const service = read("src/services/ai-variant-lab.js");
  assert.match(service, /main_overlay_ru must contain title_ru, compatibility_ru, and benefits_ru/);
  assert.match(service, /function normalizeMainOverlayRu\(value = \{\}\)/);
  assert.match(service, /benefits_ru: toArray/);
  assert.match(service, /bullets = \[\]/);
});

test("product material optimizer plans category-aware copy and visual language", () => {
  const service = read("src/services/ai-variant-lab.js");
  assert.match(service, /decision_context must contain exact_product_subtype/);
  assert.match(service, /copy_strategy must contain exact_subject_ru/);
  assert.match(service, /visual_language must contain tone, headline_style, hierarchy/);
  assert.match(service, /typography_direction_en/);
  assert.match(service, /Reject generic headings that could be reused unchanged/);
});

test("AI variant offer ids use VAR business prefixes without AI branding", () => {
  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");
  const listingService = read("src/services/listing-automation.js");
  assert.match(view, /return `VAR-\$\{target \|\| "ITEM"\}`/);
  assert.doesNotMatch(view, /return `AI-\$\{target/);
  assert.match(listingService, /payload\.internal_code = `VAR-\$\{Date\.now\(\)\.toString\(36\)\}`/);
});

test("material optimizer job numbers use module prefixes without AI branding", () => {
  const service = read("src/services/ai-variant-lab.js");
  assert.match(service, /makeNo\("OPTJOB"\)/);
  assert.doesNotMatch(service, /makeNo\("AIO"\)/);
});

test("product material optimizer always normalizes Russian detail-image explanations", () => {
  const service = read("src/services/ai-variant-lab.js");
  assert.match(service, /overlay_text_ru is mandatory for every suite_storyboard item/);
  assert.match(service, /function fallbackStoryboardOverlayRu\(role = "benefit"\)/);
  assert.match(service, /Материалы и качество/);
  assert.match(service, /Простая установка/);
});

test("product material optimizer writes composed images to the served listing-media root", () => {
  const service = read("src/services/ai-variant-lab.js");
  assert.match(service, /path\.resolve\("public", "uploads", "listing-media"\)/);
  assert.match(service, /fs\.promises\.writeFile\(path\.join\(root, filename\), composedBuffer\)/);
  assert.match(service, /timeoutMs: 45_000/);
});

test("product material optimizer prepares durable final image slots before saving a draft", () => {
  const service = read("src/services/ai-variant-lab.js");
  const view = read("frontend/admin/views/listing/AiProductMaterialOptimizerView.vue");
  assert.match(service, /materializeListingMediaAssetUrl\(sourceUrl/);
  assert.match(service, /materialized_url_map/);
  assert.match(view, /function applyMaterializedImageUrls/);
});

test("product material optimizer uses final image slots for Ozon images without publishing candidates", async () => {
  const result = await aiProductMaterialOptimizerPrepareTemplate({
    candidates: [
      { candidate_id: "original_main", url: "https://cdn.example.test/original-main.jpg", kind: "main", source: "original" },
      { candidate_id: "optimized_main", url: "https://cdn.example.test/optimized-main.jpg", kind: "main", source: "optimized" },
      { candidate_id: "unused_scene", url: "https://cdn.example.test/unused-scene.jpg", kind: "scene", source: "generated" }
    ],
    finalImageSlots: [
      { candidate_id: "optimized_main", sort_order: 1 },
      { url: "https://cdn.example.test/detail-a.jpg", sort_order: 2 }
    ],
    textResults: {
      title: "Optimized title",
      tags: ["#ozon_tag"],
      description: "Optimized description"
    }
  });

  assert.equal(result.publish_preview.primary_image, "https://cdn.example.test/optimized-main.jpg");
  assert.deepEqual(result.publish_preview.images, [
    "https://cdn.example.test/optimized-main.jpg",
    "https://cdn.example.test/detail-a.jpg"
  ]);
  assert.equal(result.template_patch.images.length, 2);
  assert.equal(result.template_patch.images.some((item) => item.url.includes("unused-scene")), false);
  assert.equal(result.template_patch.editable_payload.images[0].url, "https://cdn.example.test/optimized-main.jpg");
  assert.equal(result.template_patch.editable_payload.title, "Optimized title");
});

test("product material optimizer does not overwrite manually edited variant images", async () => {
  const result = await aiProductMaterialOptimizerPrepareTemplate({
    candidates: [
      { candidate_id: "optimized_main", url: "https://cdn.example.test/optimized-main.jpg", kind: "main", source: "optimized" }
    ],
    finalImageSlots: [
      { candidate_id: "optimized_main", sort_order: 1 }
    ],
    templatePayload: {
      editable_payload: {
        variants: [
          {
            sku: "SKU-1",
            images_manually_edited: true,
            images: [{ url: "https://cdn.example.test/manual-sku.jpg", sort_order: 1 }]
          }
        ]
      }
    }
  });

  assert.equal(result.template_patch.images[0].url, "https://cdn.example.test/optimized-main.jpg");
  assert.equal(result.template_patch.editable_payload.variants[0].images[0].url, "https://cdn.example.test/manual-sku.jpg");
});

test("ai variant lab batch flow supports low-cost planning, selected rows, and operator edits", () => {
  const service = read("src/services/ai-variant-lab.js");
  assert.match(service, /body\.useAiPlan === false/);
  assert.match(service, /deterministic-template/);
  assert.match(service, /buildFallbackBatchItems/);
  assert.match(service, /itemNos \|\| body\.item_nos \|\| body\.selectedItemNos/);
  assert.match(service, /normalizeItemOverrides/);
  assert.match(service, /applyItemOverride/);
  assert.match(service, /display_zh/);
  assert.match(service, /rows\.filter\(\(row\) => selectedKeys\.has\(row\.item_no\)/);
  assert.match(service, /description_ru must be Russian, 350 to 500 characters, never shorter than 350 characters/);
  assert.match(service, /const DEFAULT_TEMPLATE_KEY = "generic_vehicle_accessory_variant"/);
  assert.match(service, /const SILL_PLATE_TEMPLATE_KEY = "sill_plate_vehicle_variant"/);
  assert.match(service, /function hasForbiddenCategoryLeak/);
  assert.match(service, /productSubjectRu\(analysis, fallback\)/);
  assert.match(service, /защиты дверных проемов/);

  assert.match(service, /product_fact_contract/);
  assert.match(service, /buildProductFactContract/);
  assert.match(service, /enforceCopyItemProductFacts/);
  assert.match(service, /const UNKNOWN_FACT_RE/);
  assert.match(service, /function applyProductFactGate/);
  assert.match(service, /Only confirmed facts may enter generation prompts/);
  assert.match(service, /function hasCopyPlaceholderLeak/);
  assert.match(service, /function hasInternalCopyLeak/);
  assert.match(service, /function buildBuyerFacingVariantDescription/);
  assert.match(service, /Unknown or uncertain attributes must be omitted/);
  assert.match(service, /Never write placeholder words such as uncertain/);
  assert.match(service, /isBuyerFacingCopyText\(text\)/);
  assert.doesNotMatch(service.match(/function buildBuyerFacingVariantDescription[\s\S]*?function buildLegacyOzonVariantDescription/)?.[0] || "", /исходн|проверенн|uncertain|unknown/);
  assert.match(service, /Main-image recognition facts are the source of truth/);
  assert.match(service, /Template title, tags, and description are supplemental style references only/);
  assert.match(service, /Generated copy did not align with main-image product facts/);

  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");
  assert.match(view, /import \{ useRoute \} from "vue-router"/);
  assert.match(view, /const route = useRoute\(\)/);
  assert.match(view, /void autoImportRouteMaterial\(\)/);
  assert.match(view, /async function autoImportRouteMaterial/);
  assert.match(view, /String\(route\.query\.autoImport \|\| ""\) !== "1"/);
  assert.match(view, /const routeSource = routeImportSource\(\)/);
  assert.match(view, /const routeId = routeImportId\(routeSource\)/);
  assert.match(view, /function routeImportSource/);
  assert.match(view, /source === "listing_draft"/);
  assert.match(view, /source === "collector_box"/);
  assert.match(view, /source === "online_product"/);
  assert.match(view, /source === "listing_record"/);
  assert.match(view, /function routeImportId/);
  assert.match(view, /route\.query\.draftId \|\| route\.query\.draftIds/);
  assert.match(view, /route\.query\.collectorSku \|\| route\.query\.sourceId/);
  assert.match(view, /route\.query\.onlineProductId \|\| route\.query\.sourceId/);
  assert.match(view, /route\.query\.listingRecordId \|\| route\.query\.recordId \|\| route\.query\.sourceId/);
  assert.match(view, /function routeImportDetailUrl/);
  assert.match(view, /\/api\/listing\/drafts\/\$\{encoded\}/);
  assert.match(view, /\/api\/listing\/collector-box\/\$\{encoded\}/);
  assert.match(view, /\/api\/online-products\/\$\{encoded\}\/edit-draft/);
  assert.match(view, /\/api\/listing\/publish-records\/\$\{encoded\}/);
  assert.match(view, /已从\$\{sourceLabel\(routeSource\)\}导入裂变素材/);
  assert.match(view, /sourceId: source === "draft" \? String\(row\.id \|\| ""\)\.trim\(\) : sourceSku \|\| row\.id \|\| ""/);
  assert.match(view, /useAiPlan: true/);
  assert.match(view, /function selectedItemNosForRun/);
  assert.match(view, /function itemOverridesForRun/);
  assert.match(view, /function copyOverridesForRun/);
  assert.match(view, /从采集箱导入/);
  assert.match(view, /导入为母素材/);
  assert.match(view, /调用 AI 精修计划（较慢）/);
  assert.match(view, /AI生成批量计划/);
  assert.match(view, /快速生成批量计划/);
  assert.match(view, /计划确认表/);
  assert.match(view, /itemNos: selectedItemNosForRun\(\)/);
  assert.doesNotMatch(view, /function dryRunBatchImages/);
  assert.doesNotMatch(view, /生成队列预检|重新预检/);
  assert.match(view, /imageConcurrency: 20/);
  assert.match(view, /itemOverrides: copyOverridesForRun\(\)/);
  assert.match(view, /itemOverrides: copyOverridesForRun\(\[row\]\)/);
  assert.match(view, /row\.raw = \{ \.\.\.\(row\.raw \|\| \{\}\), \.\.\.\(item\.item_json \|\| \{\}\), persisted: item \}/);
  assert.match(view, /batchCopyEdit = reactive/);
  assert.match(view, /function openBatchCopyEdit/);
  assert.match(view, /function applyBatchCopyEdit/);
  assert.match(view, /renderManualCopyTemplate/);
  assert.match(view, /row\.titleText/);
  assert.match(view, /row\.tagsText/);
  assert.match(view, /row\.descriptionText/);
  assert.match(view, /manualTitle: ""/);
  assert.match(view, /manualTags: ""/);
  assert.match(view, /manualDescription: ""/);
  assert.match(view, /v-model="row\.titleText"/);
  assert.match(view, /v-model="row\.descriptionText"/);
  assert.match(view, /function syncRowTarget/);
  assert.match(view, /function deletePlanRow/);
  assert.match(view, /v-model="row\.target_variant_value"/);
  assert.match(view, /@click="deletePlanRow\(row\)">删除/);
  assert.match(view, /批量改文案/);
  assert.match(view, /templateKey: "generic_vehicle_accessory_variant"/);
  assert.match(view, /variantType: material\.variantGoal/);
  assert.match(view, /categoryKey: templateDraft\.templateKey \|\| "generic_vehicle_accessory_variant"/);
});

test("ai variant lab recognition facts are editable and starter fields stay empty", () => {
  const service = read("src/services/ai-variant-lab.js");
  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");

  assert.match(view, /targetInput: ""/);
  assert.match(view, /operatorNote: ""/);
  assert.doesNotMatch(view, /targetInput: "TENET T5/);
  assert.doesNotMatch(view, /operatorNote: "产品主体/);
  assert.match(view, /const recognitionBuckets = computed/);
  assert.match(view, /function normalizeRecognitionAnalysis/);
  assert.match(view, /function updateRecognitionBucket/);
  assert.match(view, /@update:model-value="\s*\(value\) => updateRecognitionBucket\('fixed', value\)"/);
  assert.match(view, /@update:model-value="\s*\(value\) => updateRecognitionBucket\('variable', value\)"/);
  assert.match(view, /@update:model-value="\s*\(value\) => updateRecognitionBucket\('forbidden', value\)"/);
  assert.match(view, /analysis: editableAnalysisForPlan\(\)/);
  assert.match(view, /placeholder="选填。比如：贴纸上的 Logo 不动/);
  assert.match(service, /Do not put source vehicle model/);
  assert.match(service, /Do not put product type, material, color, quantity, structure/);
});

test("ai variant lab defaults to AI copy planning and preserves sill plate subject in fallback", () => {
  const service = read("src/services/ai-variant-lab.js");
  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");
  assert.match(view, /useAiPlan: true/);
  assert.match(service, /sill\|threshold\|door/);
  assert.match(service, /Защитные накладки на пороги автомобиля/);
  assert.match(service, /защита порогов/);
  assert.match(service, /дверных проемов/);
  assert.match(service, /function isSillPlateProduct/);
  assert.doesNotMatch(service.match(/function buildOzonVariantDescription[\s\S]*?function isValidOzonVariantDescription/)?.[0] || "", /держать нужные мелочи/);
  assert.doesNotMatch(view.match(/function buildFallbackDraftDescription[\s\S]*?function rowVideoUrls/)?.[0] || "", /держать нужные мелочи/);
  assert.match(service, /subject && lower\.includes\(subject\.toLowerCase\(\)\)/);
});

test("ai variant lab image pool prioritizes higher weighted channels", () => {
  const service = read("src/services/ai-variant-lab.js");
  assert.match(service, /function prioritizeRuntimeChannels/);
  assert.match(service, /clampInteger\(right\.channel\.weight \|\| 1, 1, 20, 1\)/);
  assert.match(service, /const channels = prioritizeRuntimeChannels\(runtimeChannels\.filter\(Boolean\)\)/);
  assert.match(service, /const channels = prioritizeRuntimeChannels\(runtimeChannels\.length \? runtimeChannels : \[\]\)/);
  assert.match(service, /preferredChannel\.dispatchMode === "speed"/);
  assert.match(service, /return \[preferredChannel\]/);
});

test("ai variant lab recovers stale background image jobs after deployment", () => {
  const service = read("src/services/ai-variant-lab.js");
  assert.match(service, /function recoverStaleBatchImageJobs/);
  assert.match(service, /function recoverStaleBatchImageJob/);
  assert.match(service, /status = 'generating_images'/);
  assert.match(service, /SET status = 'queued_image'/);
  assert.match(service, /staleImageJobSeconds/);
  assert.match(service, /继续使用原任务号拉图|继续拉回图片/);
});

test("ai variant lab splits slash-separated vehicle models into individual target tasks", () => {
  const service = read("src/services/ai-variant-lab.js");
  assert.match(service, /split\(\S*\[,\S*\\n;，；、\/\|\]\+/);

  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");
  assert.match(view, /function firstTarget/);
  assert.match(view, /state\.analysis = normalizeRecognitionAnalysis\(result\.analysis \|\| \{\}\)/);
  assert.match(view, /const detectedSource = firstTarget\(state\.analysis\?\.source_variant_value\)/);
  assert.match(view, /hasVehicleModel\(detectedSource\)/);
  assert.match(view, /!material\.sourceVariantValue/);
  assert.match(view, /filter\(\(item\) => item\.toLowerCase\(\) !== source\)/);
  assert.match(view, /源车型（母图原车型，只填一个）/);
  assert.match(view, /filter\(\(item\) => item\.toLowerCase\(\) !== source\)/);
});

test("ai variant lab generation results expose preview, errors, and accurate failed status", () => {
  const service = read("src/services/ai-variant-lab.js");
  assert.match(service, /summary\.failed > 0/);
  assert.match(service, /partially_failed/);
  assert.match(service, /"failed"/);
  assert.match(service, /forceRegenerate/);
  assert.match(service, /status IN \('planned', 'queued_image', 'failed', 'image_done'\)/);
  assert.match(service, /status = 'queued_image'/);
  assert.match(service, /function fetchNextQueuedBatchImageRow/);
  assert.match(service, /function batchImageQueueStats/);
  assert.match(service, /image_result_json = NULL/);
  assert.match(service, /const AI_VARIANT_IMAGE_TIMEOUT_MS = 300_000/);
  assert.doesNotMatch(service, /IMAGE_POOL_MAX_CONCURRENCY/);
  assert.match(service, /const runningBatchImageJobs = new Set\(\)/);
  assert.match(service, /const pendingBatchImageJobWakeups = new Set\(\)/);
  assert.match(service, /adaptiveAiImageConcurrency/);
  assert.match(service, /aiImageRuntimeMetrics/);
  assert.match(service, /global_active_image_requests/);
  assert.match(service, /global_waiting_image_requests/);
  assert.match(service, /JSON\.stringify\(\{ attempts, elapsedMs, failedAt:/);
  assert.match(service, /function startBatchImageBackgroundJob/);
  assert.match(service, /pendingBatchImageJobWakeups\.add\(jobNo\)/);
  assert.match(service, /queued: true/);
  assert.match(service, /background: true/);
  assert.match(service, /aiImageRuntimePoolConfig/);
  assert.match(service, /generateImagesWithChannelRetry/);
  assert.doesNotMatch(service, /generateListingVariantMediaFromImage/);
  assert.doesNotMatch(service, /generatedVideo/);
  assert.match(service, /const hasChannelPool = runtimeChannels\.some/);
  assert.match(service, /const channelCapacity = runtimeChannels\.reduce/);
  assert.match(service, /const poolMaxConcurrency = hasChannelPool/);
  assert.match(service, /positiveInteger\(runtimeChannels\.find\(\(channel\) => channel\.poolMaxConcurrency\)\?\.poolMaxConcurrency \|\| channelCapacity/);
  assert.match(service, /positiveInteger\(channel\.maxConcurrency \|\| 1, 1\)/);
  assert.match(service, /Math\.min\(poolMaxConcurrency, channelCapacity/);
  assert.match(service, /buildWeightedChannelWorkers/);
  assert.doesNotMatch(service, /channel\.maxConcurrency \|\| 1, 1, 8, 1/);
  assert.match(service, /image_concurrency: concurrency/);
  assert.match(service, /effective_image_concurrency/);
  assert.match(service, /image_pool_max_concurrency: poolMaxConcurrency/);
  assert.match(service, /image_channel_capacity: channelCapacity/);
  assert.match(service, /aiVariantLabManualImageResult/);
  assert.match(service, /manual_upload: true/);
  assert.match(service, /function formatImageGenerationError/);
  assert.match(service, /function isInternalAiTaskImageUrl/);
  assert.match(service, /if \(isInternalAiTaskImageUrl\(imageUrl\)\) return imageUrl/);
  assert.match(service, /生成等待超过 300 秒/);
  assert.match(service, /图片生成 API 结果等待窗口为 300 秒，网络上传和结果回传另计/);

  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");
  assert.match(view, /uploadListingMedia/);
  assert.match(view, /function resultImageUrl/);
  assert.match(view, /row\.imageResult\?\.generatedVideo/);
  assert.match(view, /function resultDownloadUrl/);
  assert.match(view, /function regenerateRowMainImage/);
  assert.match(view, /function uploadRowMainImageRequest/);
  assert.match(view, /\/api\/ai-variant-lab\/batch-items\/manual-image/);
  assert.match(view, /function rowStatusText/);
  assert.match(view, /超时失败/);
  assert.match(view, /function formatDurationText/);
  assert.match(view, /后台逐条生成/);
  assert.match(view, /单张 API 结果最长等待 5 分钟/);
  assert.match(view, /force: true/);
  assert.match(view, /queued_image/);
  assert.match(view, /后台并发/);
  assert.match(view, /上传主图/);
  assert.doesNotMatch(view, /v-model="material\.imageConcurrency"/);
  assert.match(view, /失败原因/);
  assert.match(view, /row\.errorMessage/);
  assert.match(view, /row\.imageResult/);
  assert.match(view, /案例请在单行操作里保存/);
  assert.match(view, /function hasVehicleModel/);
});

test("ai variant lab can save selected variant rows to listing drafts", () => {
  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");
  assert.match(view, /templateId: ""/);
  assert.match(view, /function saveSelectedRowsToDrafts/);
  assert.match(view, /\/api\/listing\/drafts\/ai-variant-lightweight/);
  assert.match(view, /apiClient\.get\("\/api\/shops"/);
  assert.match(view, /sourceShopIds: \[\]/);
  assert.doesNotMatch(view, /v-model="material\.sourceShopIds"/);
  assert.doesNotMatch(view, /临时上传母图/);
  assert.doesNotMatch(view, /识别时附带详情图和商品文本信息/);
  assert.match(view, /function buildListingDraftPayload/);
  assert.match(view, /parseMaybeJson\(row\.listing_template\) \|\| parseMaybeJson\(row\.listingTemplate\)/);
  assert.match(view, /template_payload: material\.templatePayload \|\| null/);
  assert.match(view, /source_draft_id: material\.sourceDraftId \|\| ""/);
  assert.match(view, /shop_ids: normalizeShopIds\(material\.sourceShopIds \|\| \[\]\)/);
  assert.match(view, /material\.sourceShopIds = normalizeShopIds\(row\.sourceShopIds \|\| \[\]\)/);
  assert.doesNotMatch(view, /payload\.id\) \|\| ""\)\.trim\(\)/);
  assert.match(view, /\/api\/listing\/ai-variant-assets/);
  assert.match(view, /function saveRowAsset/);
  assert.match(view, /field_key: fieldKey/);
  assert.match(view, /"main_image"/);
  assert.match(view, /"rich_content"/);
  assert.match(view, /"video"/);
  assert.match(view, /\/api\/listing\/variant-media\/generate/);
  assert.match(view, /function buildRowRichContentJson/);
  assert.match(view, /widgetName: "raShowcase"/);
  assert.match(view, /async function prepareGeneratedRowForDraft/);
  assert.match(view, /!row\.assets\?\.rich_content\?\.json && !row\.assets\?\.rich_content\?\.richContentJson/);
  assert.match(view, /await generateRowRichContent\(row, options\)/);
  assert.match(view, /await generateRowVideo\(row, options\)/);
  assert.match(view, /await prepareGeneratedRowsForDraft\(rows, \{ silent: true, generateVideo: true, throwOnError: true \}\)/);
  assert.match(view, /await prepareGeneratedRowsForDraft\(generatedRows, \{ silent: true, generateVideo: true \}\)/);
  assert.match(view, /apiClient\.post\("\/api\/ai-variant-draft-save\/batches"/);
  assert.match(view, /function monitorDraftSaveBatch/);
  assert.match(view, /后台将分批完成，可继续操作页面/);
  assert.match(view, /saveDraftStage: ""/);
  assert.match(view, /running\.saveDraftStage = "准备保存素材"/);
  assert.match(view, /running\.saveDraftStage = `正在保存草稿 \$\{success\}\/\$\{rows\.length\}`/);
  const persistAssets = view.match(/async function persistGeneratedRowAssets[\s\S]*?function buildRowRichContentJson/)?.[0] || "";
  assert.match(persistAssets, /await saveRowAsset\(row, "main_image"/);
  assert.match(persistAssets, /await Promise\.all\(\[/);
  assert.match(persistAssets, /saveRowAsset\(row, "title"/);
  assert.match(persistAssets, /saveRowAsset\(row, "tags"/);
  assert.match(persistAssets, /saveRowAsset\(row, "description"/);
  assert.match(view, /function rowVideoUsesCurrentMainImage/);
  assert.match(view, /function rowVideoCoverUrls/);
  assert.match(view, /video_cover_urls: videoCoverUrls/);
  assert.match(view, /delete row\.assets\.main_image/);
  assert.match(view, /delete row\.assets\.video/);
  assert.match(view, /delete row\.assets\.rich_content/);
  assert.match(view, /row\.regenerateDownstream = true/);
  assert.match(view, /prepareGeneratedRowsForDraft\(generatedRows, \{ silent: true, generateVideo: true \}\)/);
  assert.match(view, /prepareGeneratedRowsForDraft\(rows, \{ silent: true, generateVideo: true, throwOnError: true \}\)/);
  assert.match(view, /ensureGeneratedRowVideos\(rows, \{ silent: true, throwOnError: true \}\)/);
  assert.match(view, /function ensureGeneratedRowVideos/);
  assert.match(view, /视频生成未完成，已停止保存草稿/);
  assert.match(view, /options\.generateVideo !== false/);
  assert.match(view, /if \(options\.throwOnError\) throw error/);
  assert.match(view, /const imageUrl = rowMainImageDraftUrl\(row\)/);
  assert.match(view, /sourceImageUrl: imageUrl/);
  assert.match(view, /options\.generateVideo !== false && \(!rowVideoUrls\(row\)\.length \|\| !rowVideoUsesCurrentMainImage\(row\)\)/);
  assert.match(view, /ai_variant_lab_job_no/);
  assert.match(view, /保存到草稿箱/);
  assert.match(view, /打开草稿/);
  assert.match(view, /保存到草稿箱.*才会生成可继续编辑和上架的商品草稿/s);
  const draftPayloadSource = view.match(/function buildListingDraftPayload[\s\S]*?function replaceVariantText/)?.[0] || "";
  assert.doesNotMatch(draftPayloadSource, /quantity:\s*1/);
  assert.match(view, /const rowPreparationTasks = new Map\(\)/);
  assert.match(view, /const rowVideoTasks = new Map\(\)/);
  assert.match(view, /function offerIdPrefix/);
  assert.match(view, /async function generateOfferIds/);
  assert.match(view, /row\.offerPrefix = offerPrefix/);
  assert.match(view, /const explicitPrefix = String\(row\?\.offerPrefix \|\| ""\)\.trim\(\)/);
  assert.doesNotMatch(view, /row\.offerId = `\$\{options\.offerPrefix\}-\$\{index \+ 1\}`/);
  assert.match(view, /function isOfferIdConflictError/);
  assert.match(view, /async function saveRowToDraftWithOfferRetry/);
  assert.match(view, /row\.offerId = ""/);
  assert.match(view, /await generateOfferIds\(\[row\]\)/);
  assert.match(view, /一键生成货号/);
  assert.match(view, /货号 \/ offer_id/);
  assert.match(draftPayloadSource, /offer_id: offerId/);
  assert.match(draftPayloadSource, /internal_code: offerId/);
  assert.match(draftPayloadSource, /changed_fields: \["offer_id"/);
  assert.match(view, /draft\.shop_copy_error/);
  assert.match(view, /店铺副本生成失败/);
  assert.match(view, /未选择目标店铺/);
});

test("ai variant lab prepares permanent draft media while image batches are still completing", () => {
  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");
  assert.match(view, /const BACKGROUND_DRAFT_PREPARATION_CONCURRENCY = 10/);
  assert.match(view, /queueGeneratedRowPreparation\(row, \{ silent: true, generateVideo: true \}\)/);
  assert.match(view, /await Promise\.all\(rows\.map\(\(row\) => queueGeneratedRowPreparation\(row, options\)\)\)/);
  assert.match(view, /while \(activeBackgroundDraftPreparations < BACKGROUND_DRAFT_PREPARATION_CONCURRENCY/);
});

test("ai variant draft saves are persisted, rate-limited, and recoverable", () => {
  const service = read("src/services/ai-variant-draft-save-batches.js");
  const routes = read("src/server/routes/aiVariantLab.js");
  const runtime = read("src/services/mysql-runtime-services.js");
  const server = read("src/server.js");
  assert.match(service, /CREATE TABLE IF NOT EXISTS ai_variant_draft_save_batches/);
  assert.match(service, /CREATE TABLE IF NOT EXISTS ai_variant_draft_save_items/);
  assert.match(service, /AI_VARIANT_DRAFT_SAVE_CONCURRENCY \|\| 8/);
  assert.match(service, /adaptiveDraftSaveConcurrency/);
  assert.match(service, /const BATCH_INSERT_CHUNK_SIZE = 20/);
  assert.match(service, /withMysqlTransaction/);
  assert.match(service, /payloads\.slice\(offset, offset \+ BATCH_INSERT_CHUNK_SIZE\)/);
  assert.match(service, /chunk\.map\(\(\) => "\(\?, \?, \?, \?\)"\)/);
  assert.match(service, /SELECT item_no, status, stage, progress_percent, result_draft_id/);
  assert.doesNotMatch(service, /SELECT \* FROM ai_variant_draft_save_items WHERE batch_no/);
  assert.match(service, /payload_json LONGTEXT NOT NULL/);
  assert.match(service, /WHERE status = 'running'/);
  assert.match(service, /createAiVariantListingDraftLightweight/);
  assert.match(service, /createWithOfferRetry/);
  assert.match(routes, /POST \/api\/ai-variant-draft-save\/batches/);
  assert.match(routes, /parts\[1\] === "ai-variant-draft-save"/);
  assert.match(runtime, /createAiVariantDraftSaveBatch/);
  assert.match(server, /recoverAiVariantDraftSaveBatchesOnStartup/);
});

test("ai variant lab persists and restores recoverable fission records", () => {
  const service = read("src/services/ai-variant-lab.js");
  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");
  assert.match(service, /workbench_snapshot:\s*nonEmptyObjectValue\(body\.workbenchSnapshot/);
  assert.match(service, /j\.created_by_person_id, p\.name AS created_by_name/);
  assert.match(view, /workbenchSnapshot:\s*workbenchSnapshot\(\)/);
  assert.match(view, />裂变记录<\/el-button>/);
  assert.match(view, /restoreHistoryJob\(row\)/);
  assert.match(view, /const restoredBatchAssetJobs = new Set\(\)/);
  assert.match(view, /async function restorePersistedBatchAssets\(jobNo\)/);
  assert.match(view, /sourceBatchId: batchNo, fieldKey, compact: "1", limit: "200"/);
  assert.match(view, /await restorePersistedBatchAssets\(jobNo\)/);
  assert.match(view, /restoreLegacyHistorySource\(detail\.job\)/);
  assert.match(view, /shanghaiDateTimeText\(row\.updated_at/);
  assert.match(view, /<el-dialog[\s\S]*title="AI 裂变记录"/);
  assert.doesNotMatch(view, /<el-drawer[^>]*title="AI 裂变记录"/);
  assert.match(view, /label="操作人员"/);
  assert.match(view, /historyPersonText\(row\)/);
  assert.match(service, /materializeListingMediaAssetUrl/);
  assert.match(service, /persistAiVariantImageResult\(imageResult/);
  assert.match(service, /arrayValue\(images\)\.map/);
  assert.match(service, /\.\.\.arrayValue\(durableResult\.generatedImages\)/);
  assert.doesNotMatch(service, /\.\.\.toArray\(durableResult\.generatedImages\)/);
  assert.match(service, /durable:\s*true/);
  assert.match(service, /p\.name AS created_by_name/);
});

test("ai variant lab applies operator-reviewed image instructions and global baseline before generation", () => {
  const service = read("src/services/ai-variant-lab.js");
  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");

  assert.match(service, /GLOBAL_IMAGE_BASELINE_NEGATIVE_RULES/);
  assert.match(service, /IMAGE_TEMPLATE_PROFILES/);
  assert.match(service, /No Chinese text or Chinese characters/);
  assert.match(service, /No marketplace names or platform-sensitive words/);
  assert.match(service, /finalizeBatchImageItemForRun\(persistedItem\)/);
  assert.match(service, /composeFinalImagePromptForRun/);
  assert.match(service, /function buildImageEditContract/);
  assert.match(service, /function buildImageEditContractPrompt/);
  assert.match(service, /image_edit_contract/);
  assert.match(service, /large_title_text/);
  assert.match(service, /logo_or_badge_text/);
  assert.match(service, /Only allowed new readable text/);
  assert.match(service, /Do not add new English descriptions/);
  assert.match(service, /No missing existing large title area/);
  assert.match(service, /Keep the full original frame\/canvas, aspect ratio, product scale, margins, and all image edges visible/);
  assert.match(service, /Preserve existing selling-point text blocks, feature icons, pictograms, badges, arrows, dividers, labels, decorative modules/);
  assert.match(service, /Existing readable text, selling-point copy, labels, icons, pictograms, and badge modules from the reference image are not new text/);
  assert.match(service, /No cropped frame/);
  assert.match(service, /No missing existing selling point text blocks/);
  assert.match(service, /Prompt priority order: global baseline rules > user instructions > recognized product facts > matched visual template > draft AI prompt/);
  assert.match(service, /Matched visual template guidance, layout only/);
  assert.match(service, /buildImageTemplateGuidance/);
  assert.match(service, /buildImageProductTruthRules/);
  assert.match(service, /imagePromptPriorityContract/);
  assert.match(service, /templateRuleLooksLikeProductFact/);
  assert.match(service, /Template guidance may control layout, composition, visual hierarchy, and style only/);
  assert.match(service, /If template guidance conflicts with recognized product facts, follow recognized product facts/);
  assert.match(service, /Final operator-reviewed instructions below have higher priority than the draft prompt/);
  assert.match(service, /buildUserInstructionConstraintsEn/);
  assert.match(service, /extractProtectedElementsFromChineseInstruction/);
  assert.match(service, /extractEditableElementsFromChineseInstruction/);
  assert.match(service, /Do not replace, translate, repaint, remove, deform, redesign, or obscure the user-protected elements/);
  assert.match(service, /fake official authorization/);
  assert.match(service, /unsupported warranty/);
  assert.match(service, /exaggerated claims/);
  assert.match(service, /layout_key: layoutKey/);

  assert.match(view, /main_image_plan: row\.mainImagePlan/);
  assert.match(view, /operator_note: material\.operatorNote/);
  assert.match(view, /itemOverrides: copyOverridesForRun\(\)/);
  assert.doesNotMatch(view, /产品 Logo、车牌、背景车型和可见车型文字替换/);
});

test("ai variant lab compiles listing copy from recognized product DNA", () => {
  const service = read("src/services/ai-variant-lab.js");
  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");

  assert.match(service, /function buildCopyProductDna/);
  assert.match(service, /copyMaterialRu/);
  assert.match(service, /copyFinishRu/);
  assert.match(service, /copyQuantityRu/);
  assert.match(service, /product_dna: productDna/);
  assert.match(service, /copy_product_dna: productDna/);
  assert.match(service, /compiled_product_dna/);
  assert.match(service, /ABS пластик/);
  assert.match(service, /карбоновая фактура/);
  assert.match(service, /глянцевое покрытие/);
  assert.doesNotMatch(service.match(/function buildOzonVariantDescription[\s\S]*?function isValidOzonVariantDescription/)?.[0] || "", /карбоновую фактуру и количество исходного товара/);

  assert.match(view, /function rowCopyState/);
  assert.match(view, /const UNKNOWN_FACT_RE/);
  assert.match(view, /function isBuyerFacingCopyText/);
  assert.match(view, /function isValidDraftTitle/);
  assert.match(view, /标题包含未识别占位词或内部规则话术/);
  assert.match(view, /简介包含未识别占位词或内部规则话术/);
  assert.match(view, /手动覆盖/);
  assert.match(view, /事实重写/);
  assert.match(view, /AI计划/);
});

test("ai variant lab imports template detail media and keeps generated descriptions authoritative", () => {
  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");
  const richContentOutput = view.slice(
    view.indexOf("function rowRichContentOutput"),
    view.indexOf("function rowVideoUrls")
  );
  assert.match(view, /const explicitDetailImages = firstNonEmptyImageList\(\[/);
  assert.match(view, /row\.detail_image_urls/);
  assert.match(view, /payload\.detailImageUrls/);
  assert.match(view, /editablePayload\.detail_image_urls/);
  assert.match(view, /normalizedPayload\.detailImageUrls/);
  assert.match(view, /normalizedEditable\.detail_image_urls/);
  assert.match(view, /productDetail\.detailImages/);
  assert.match(view, /firstVariant\?\.detailImages/);
  assert.match(view, /row\.draft_variant_images_json/);
  assert.match(view, /firstVariant\?\.images/);
  assert.match(view, /const imageList = draftCurrentImageList\.length \? draftCurrentImageList : fallbackImageList/);
  assert.match(view, /const sourceImageList = firstNonEmptyImageList\(\[/);
  assert.match(view, /const templateImageList = firstNonEmptyImageList\(\[/);
  assert.match(view, /const templateOnlyImages = templateImageList\.filter/);
  assert.match(view, /row\.productImage/);
  assert.match(view, /payload\.mainImage/);
  assert.match(view, /detailImages: uniqueList\(imageList\.length > 1 \? imageList\.slice\(1\) : explicitDetailImages\)/);
  assert.doesNotMatch(view, /const imageList = uniqueList\(normalizeImageList\(firstValue\(/);
  assert.match(view, /payload\.videos/);
  assert.match(view, /firstVariant\?\.videos/);
  assert.match(view, /const DESCRIPTION_MIN_LENGTH = 350/);
  assert.match(view, /const DESCRIPTION_MAX_LENGTH = 500/);
  assert.match(view, /function isValidDraftDescription/);
  assert.match(view, /function buildFallbackDraftDescription/);
  assert.doesNotMatch(view, /return item\.description_ru \|\| replaceVariantText\(material\.sourceDescription, target\) \|\| row\.descriptionPlan/);
  assert.doesNotMatch(richContentOutput, /row\.richTextPlan \|\| ""/);
});

test("AI material images are persisted and detail generation has a source fallback", () => {
  const tasks = read("src/services/ai-generation-tasks.js");
  const workflow = read("src/server/services/ai/aiWorkflowService.js");
  const view = read("frontend/admin/views/listing/AiProductMaterialOptimizerView.vue");
  assert.match(tasks, /persistGeneratedImageOutput\(output, input, fieldKey\)/);
  assert.match(tasks, /ensureAssetVariantImagePublishUrl\(sourceUrl/);
  assert.match(workflow, /resolveSourceImageWithFallback\(payload\)/);
  assert.match(view, /initialPayload\.fallbackSourceImageUrl/);
});

test("AI variant lab history list does not load full workbench snapshots", () => {
  const service = read("src/services/ai-variant-lab.js");
  assert.match(service, /JSON_UNQUOTE\(JSON_EXTRACT\(j\.request_json, '\$\.workbench_snapshot\.material\.productName'\)\) AS history_product_name/);
  assert.match(service, /request_json:\s*row\.history_product_name\s*\?/);
  const listBlock = service.slice(service.indexOf("export async function aiVariantLabBatchJobs"), service.indexOf("export async function aiVariantLabBatchJobDetail"));
  assert.doesNotMatch(listBlock, /j\.request_json, j\.result_json/);
});

test("AI variant lab can select failed rows and avoids overlapping heavy polling", () => {
  const view = read("frontend/admin/views/listing/AiVariantLabView.vue");
  assert.match(view, /function selectFailedPlanRows\(\)/);
  assert.match(view, /row\.status === "failed"/);
  assert.match(view, /重试失败项（\{\{ displayStats\.failed \}\}）/);
  assert.match(view, /if \(generationPollPending\) return/);
  assert.match(view, /\}, 4000\)/);
  assert.match(view, /previousStatus !== "image_done" \|\| previousImageUrl !== currentImageUrl/);
  const regenerateBlock = view.slice(view.indexOf("async function regenerateRowMainImage"), view.indexOf("function uploadRowMainImageRequest"));
  assert.doesNotMatch(regenerateBlock, /await loadBatchJobDetail/);
});


