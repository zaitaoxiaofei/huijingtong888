<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api";
import VariantTaskHeader from "../../components/listing/variant-workbench/VariantTaskHeader.vue";
import VariantTypeSelector from "../../components/listing/variant-workbench/VariantTypeSelector.vue";
import VariantTargetManager from "../../components/listing/variant-workbench/VariantTargetManager.vue";
import VariantStrategyPanel from "../../components/listing/variant-workbench/VariantStrategyPanel.vue";
import VariantPromptTemplatePanel from "../../components/listing/variant-workbench/VariantPromptTemplatePanel.vue";
import VariantPreviewPanel from "../../components/listing/variant-workbench/VariantPreviewPanel.vue";
import VariantResultPool from "../../components/listing/variant-workbench/VariantResultPool.vue";
import { listAiPromptTemplates, renderAiPromptTemplate } from "../../api/settings/aiPromptTemplates";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const generating = ref(false);
const writingBack = ref(false);

const variantTypes = [
  { value: "same_model_main_image", title: "同车型主图裂变", shortTitle: "主图裂变", description: "车型不变，批量生成多套主图方案。" },
  { value: "multi_model", title: "同款多车型裂变", shortTitle: "多车型", description: "同款产品换品牌、车型、标题和主图。" },
  { value: "logo_text_replace", title: "Logo/文字替换裂变", shortTitle: "文字替换", description: "保持构图，只替换 logo、车型或品牌字样。" }
];

const commonTemplates = [
  { brand: "TENET", models: ["T4", "T7", "T8"] },
  { brand: "BELGEE", models: ["X50", "X70"] },
  { brand: "HAVAL", models: ["Jolion", "F7", "Dargo"] },
  { brand: "CHERY", models: ["TIGGO 4", "TIGGO 7", "TIGGO 8"] },
  { brand: "JAECOO", models: ["J7", "J8"] }
];

const state = reactive({
  products: [],
  people: [],
  suppliers: [],
  promptTemplates: [],
  selectedBase: null,
  taskId: "",
  taskStatus: "draft",
  variantType: "multi_model",
  targets: [],
  mainImagePlans: [],
  previews: [],
  results: [],
  strategy: {
    mainImageStyle: "高端原厂风",
    customPrompt: "",
    detailImageStrategy: "inherit",
    copyStrategy: {
      title: true,
      tags: true,
      description: true
    },
    writeBackMode: "auto",
    generateVideo: false
  },
  promptConfig: {
    templateId: null,
    ratio: "3:4",
    imageCount: 1,
    userPrompt: "",
    positivePromptOverride: "",
    negativePromptOverride: ""
  }
});

const writeBackDialog = reactive({
  visible: false,
  rows: []
});

const promptDialog = reactive({
  visible: false,
  loading: false,
  target: null,
  positivePrompt: "",
  negativePrompt: "",
  missingVariables: []
});

const currentType = computed(() => variantTypes.find((item) => item.value === state.variantType) || variantTypes[0]);
const generatedCount = computed(() => state.results.filter((item) => item.status !== "deleted").length);
const writtenBackCount = computed(() => state.results.filter((item) => item.writeBackStatus === "written_back").length);
const selectedPromptTemplate = computed(() => state.promptTemplates.find((item) => item.id === state.promptConfig.templateId));
const activeTargets = computed(() => {
  if (state.variantType === "same_model_main_image") {
    return state.mainImagePlans.map((plan) => ({
      id: plan.id,
      brand: inferBrand(state.selectedBase?.vehicle_model) || "BASE",
      model: state.selectedBase?.vehicle_model || plan.name,
      displayName: plan.name,
      kind: "plan",
      style: plan.style || state.strategy.mainImageStyle,
      logoText: state.selectedBase?.vehicle_model || "",
      writeBackEnabled: plan.writeBackEnabled
    }));
  }
  return state.targets;
});

function normalizeRows(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

function normalizeImageList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {
    // Keep delimiter parsing as a fallback.
  }
  return text.split(/\r?\n|[,，]/).map((item) => item.trim()).filter(Boolean);
}

function money(value) {
  return Number(value || 0).toFixed(1);
}

function inferBrand(text) {
  const match = String(text || "").match(/\b(TENET|BELGEE|HAVAL|CHERY|JAECOO|GEELY|OMODA|EXEED|CHANGAN)\b/i);
  return match ? match[1].toUpperCase() : "";
}

function targetDisplayName(target = {}) {
  return target.displayName || [target.brand, target.model].filter(Boolean).join(" ") || state.selectedBase?.vehicle_model || "";
}

function productKindFromBaseName(name = "") {
  const text = String(name || "");
  if (/钥匙|key/i.test(text)) return "钥匙保护壳";
  if (/门槛|迎宾|不锈钢|踏板/i.test(text)) return text.includes("不锈钢") ? "不锈钢门槛条" : "门槛条";
  if (/贴纸|车贴/i.test(text)) return "车贴";
  if (/膜|保护膜/i.test(text)) return "保护膜";
  if (/扶手/i.test(text)) return "扶手箱配件";
  const cleaned = text
    .replace(/\b(TENET|BELGEE|HAVAL|CHERY|JAECOO|GEELY|OMODA|EXEED|CHANGAN)\b/gi, "")
    .replace(/通用|适用于|汽车用品/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "汽车用品";
}

function buildVariantProductName(target = {}) {
  const displayName = targetDisplayName(target);
  const kind = productKindFromBaseName(state.selectedBase?.name || "");
  return [displayName, kind].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function replaceVehicleWords(text = "", target = {}) {
  const base = state.selectedBase || {};
  const targetName = targetDisplayName(target);
  const targetBrand = target.brand || inferBrand(targetName);
  const fromValues = [
    base.vehicle_model,
    inferBrand(base.vehicle_model),
    inferBrand(base.name),
    "通用"
  ].filter(Boolean);
  let next = String(text || "");
  fromValues.forEach((value) => {
    next = next.replace(new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), targetName);
  });
  if (targetBrand && !next.includes(targetBrand)) next = `${targetBrand} ${next}`;
  return next.replace(/\s+/g, " ").trim();
}

function parseBrandModel(text) {
  const clean = String(text || "").trim().replace(/\s+/g, " ");
  if (!clean) return null;
  const [brand, ...rest] = clean.split(" ");
  return {
    id: `target-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    brand: brand?.toUpperCase() || "",
    model: rest.join(" ") || "",
    displayName: clean,
    logoText: clean,
    replaceFromText: state.selectedBase?.vehicle_model || "",
    replaceToText: clean,
    writeBackEnabled: true,
    status: "pending"
  };
}

function ensureStarterTargets() {
  if (!state.mainImagePlans.length) {
    state.mainImagePlans.push({
      id: `plan-${Date.now()}`,
      name: "高端原厂风",
      style: "高端原厂风",
      writeBackEnabled: false
    });
  }
  if (!state.targets.length) {
    ["TENET T4", "TENET T7", "BELGEE X70"].map(parseBrandModel).filter(Boolean).forEach((item) => state.targets.push(item));
  }
  syncPreviewShells();
}

function syncPreviewShells() {
  const existing = new Map(state.previews.map((item) => [item.targetId, item]));
  state.previews = activeTargets.value.map((target) => existing.get(target.id) || createPreviewShell(target));
}

function createPreviewShell(target) {
  return {
    id: `preview-${target.id}`,
    targetId: target.id,
    brand: target.brand,
    model: target.model,
    displayName: target.displayName || [target.brand, target.model].filter(Boolean).join(" "),
    title: "",
    tags: [],
    description: "",
    mainImageUrl: "",
    status: "pending",
    stage: "待生成",
    errorMessage: "",
    progress: 0
  };
}

async function loadBootstrap() {
  loading.value = true;
  try {
    const [products, people, suppliers, promptTemplates] = await Promise.all([
      apiClient.get("/api/products/selection?paged=1&page=1&pageSize=200", { noCache: true }),
      apiClient.get("/api/people", { noCache: true }),
      apiClient.get("/api/suppliers?paged=1&page=1&pageSize=200", { noCache: true }),
      listAiPromptTemplates()
    ]);
    state.products = normalizeRows(products);
    state.people = Array.isArray(people) ? people : [];
    state.suppliers = normalizeRows(suppliers);
    state.promptTemplates = Array.isArray(promptTemplates) ? promptTemplates : [];
    applyDefaultPromptTemplate();
    const baseId = Number(route.query.baseSelectionId || route.query.productId || 0);
    if (baseId) {
      state.selectedBase = await apiClient.get(`/api/products/${baseId}`, { noCache: true });
    } else {
      const firstProduct = state.products[0] || null;
      state.selectedBase = firstProduct?.id ? await apiClient.get(`/api/products/${firstProduct.id}`, { noCache: true }) : firstProduct;
    }
    state.taskId = `VT-${Date.now().toString(36).toUpperCase()}`;
    ensureStarterTargets();
  } catch (error) {
    ElMessage.error(error.message || "主图裂变工作台加载失败");
  } finally {
    loading.value = false;
  }
}

function applyDefaultPromptTemplate() {
  const scene = state.variantType === "logo_text_replace" ? "logo_text_replace" : "main_image_variant";
  const template = state.promptTemplates.find((item) => item.scene === scene && item.is_default && item.enabled)
    || state.promptTemplates.find((item) => item.scene === scene && item.enabled);
  if (!state.promptConfig.templateId && template) {
    state.promptConfig.templateId = template.id;
    state.promptConfig.ratio = template.default_ratio || "3:4";
    state.promptConfig.imageCount = Number(template.default_count || 1);
  }
}

function setVariantType(value) {
  state.variantType = value;
  state.promptConfig.templateId = null;
  applyDefaultPromptTemplate();
  syncPreviewShells();
}

function addTargets(rows) {
  rows.map((row) => typeof row === "string" ? parseBrandModel(row) : row).filter(Boolean).forEach((row) => {
    state.targets.push({
      id: row.id || `target-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      brand: row.brand || row.targetBrand || "",
      model: row.model || row.targetModel || "",
      displayName: row.displayName || [row.brand, row.model].filter(Boolean).join(" "),
      logoText: row.logoText || row.displayName || "",
      replaceFromText: row.replaceFromText || state.selectedBase?.vehicle_model || "",
      replaceToText: row.replaceToText || row.displayName || "",
      writeBackEnabled: row.writeBackEnabled !== false,
      status: "pending"
    });
  });
  syncPreviewShells();
}

function addMainImagePlan(plan) {
  state.mainImagePlans.push({
    id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: plan?.name || state.strategy.mainImageStyle,
    style: plan?.style || state.strategy.mainImageStyle,
    writeBackEnabled: state.strategy.writeBackMode === "auto"
  });
  syncPreviewShells();
}

function removeTarget(id) {
  if (state.variantType === "same_model_main_image") {
    state.mainImagePlans = state.mainImagePlans.filter((item) => item.id !== id);
  } else {
    state.targets = state.targets.filter((item) => item.id !== id);
  }
  state.previews = state.previews.filter((item) => item.targetId !== id);
}

function reorderTargets(ids) {
  const reorder = (rows) => ids.map((id) => rows.find((item) => item.id === id)).filter(Boolean);
  if (state.variantType === "same_model_main_image") state.mainImagePlans = reorder(state.mainImagePlans);
  else state.targets = reorder(state.targets);
  syncPreviewShells();
}

function saveDraft() {
  localStorage.setItem("mainImageVariantDraft", JSON.stringify({
    taskId: state.taskId,
    variantType: state.variantType,
    targets: state.targets,
    mainImagePlans: state.mainImagePlans,
    strategy: state.strategy,
    savedAt: new Date().toISOString()
  }));
  ElMessage.success("草稿已保存");
}

function pauseTask() {
  state.taskStatus = generating.value ? "paused" : state.taskStatus;
  generating.value = false;
  ElMessage.info("任务已暂停");
}

async function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function mockImageUrl(seed) {
  return `https://dummyimage.com/900x900/101827/e5f3ff.png&text=${encodeURIComponent(seed || "AI Variant")}`;
}

function buildPromptVariables(target = {}) {
  const base = state.selectedBase || {};
  return {
    product_name: base.name || "",
    brand: inferBrand(base.vehicle_model || base.name || ""),
    vehicle_model: base.vehicle_model || "",
    target_brand: target.brand || inferBrand(target.displayName || target.model || ""),
    target_model: target.model || target.displayName || "",
    material: base.material || "",
    color: base.color || "",
    selling_points: base.selling_points || "",
    ozon_category: base.ozon_category_name || base.ozon_category_id || "",
    main_image_style: target.style || state.strategy.mainImageStyle || "",
    source_image_url: base.image_url || "",
    replace_from_text: target.replaceFromText || base.vehicle_model || "",
    replace_to_text: target.replaceToText || targetDisplayName(target),
    logo_text: target.logoText || targetDisplayName(target),
    user_prompt: state.promptConfig.userPrompt || state.strategy.customPrompt || "",
    ratio: state.promptConfig.ratio || "3:4"
  };
}

async function renderPromptForTarget(target = {}) {
  const template = selectedPromptTemplate.value;
  if (!template) {
    return {
      finalPositivePrompt: [
        buildVariantProductName(target),
        targetDisplayName(target),
        state.strategy.mainImageStyle,
        state.promptConfig.userPrompt
      ].filter(Boolean).join("\n"),
      finalNegativePrompt: "",
      missingVariables: []
    };
  }
  return renderAiPromptTemplate({
    templateId: template.id,
    variables: buildPromptVariables(target),
    positivePrompt: state.promptConfig.positivePromptOverride || undefined,
    negativePrompt: state.promptConfig.negativePromptOverride || undefined
  });
}

async function generateVariantMainImage(target) {
  await wait(280);
  return state.selectedBase?.image_url || mockImageUrl(`${target.displayName} ${state.strategy.mainImageStyle}`);
}

async function generateVariantTitle(target) {
  await wait(180);
  if (state.variantType === "same_model_main_image") return `${state.selectedBase?.name || "汽车用品"} ${target.displayName} 主图方案`;
  return buildVariantProductName(target);
}

async function generateVariantTags(target) {
  await wait(120);
  return ["Ozon", "汽车用品", target.brand, target.model, state.selectedBase?.material, state.strategy.mainImageStyle].filter(Boolean).slice(0, 8);
}

async function generateVariantDescription(target) {
  await wait(160);
  const baseDescription = state.selectedBase?.selling_points || "继承母商品卖点";
  return `${replaceVehicleWords(baseDescription, target)}。AI 已按 ${targetDisplayName(target)} 和 ${state.strategy.mainImageStyle} 生成裂变素材预览。`;
}

async function generateVariantPreview(target, preview) {
  preview.status = "generating";
  preview.stage = "主图生成中";
  preview.progress = 18;
  preview.mainImageUrl = await generateVariantMainImage(target);
  const promptResult = await renderPromptForTarget(target);
  preview.finalPositivePrompt = promptResult.finalPositivePrompt;
  preview.finalNegativePrompt = promptResult.finalNegativePrompt;
  preview.progress = 46;
  preview.stage = "标题生成中";
  preview.title = await generateVariantTitle(target);
  preview.progress = 68;
  preview.stage = "标签生成中";
  preview.tags = await generateVariantTags(target);
  preview.progress = 86;
  preview.stage = "描述生成中";
  preview.description = await generateVariantDescription(target);
  preview.progress = 100;
  preview.stage = "已完成";
  preview.status = "success";
  return preview;
}

async function startGenerate() {
  if (!state.selectedBase) {
    ElMessage.warning("请先从选品表选择母商品");
    return;
  }
  syncPreviewShells();
  if (!activeTargets.value.length) {
    ElMessage.warning("请先添加目标车型或主图方案");
    return;
  }
  generating.value = true;
  state.taskStatus = "generating";
  for (const target of activeTargets.value) {
    if (!generating.value) break;
    const preview = state.previews.find((item) => item.targetId === target.id) || createPreviewShell(target);
    try {
      await generateVariantPreview(target, preview);
      upsertResultFromPreview(target, preview);
    } catch (error) {
      preview.status = "failed";
      preview.stage = "失败";
      preview.errorMessage = error.message || "生成失败";
    }
  }
  generating.value = false;
  state.taskStatus = state.previews.some((item) => item.status === "failed") ? "partial_success" : "success";
}

async function regenerateTarget(targetId) {
  const target = activeTargets.value.find((item) => item.id === targetId);
  const preview = state.previews.find((item) => item.targetId === targetId);
  if (!target || !preview) return;
  await generateVariantPreview(target, preview);
  upsertResultFromPreview(target, preview);
  ElMessage.success("已重新生成");
}

function upsertResultFromPreview(target, preview) {
  const base = state.selectedBase || {};
  const existing = state.results.find((item) => item.targetId === target.id);
  const generatedDetailImageUrls = preview.generatedDetailImageUrls || [];
  const generatedTailImageUrls = preview.generatedTailImageUrls || [];
  const result = {
    id: existing?.id || `result-${target.id}`,
    targetId: target.id,
    resultId: existing?.resultId || `VR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    productName: state.variantType === "same_model_main_image" ? preview.title : buildVariantProductName(target),
    brand: target.brand || inferBrand(base.vehicle_model),
    model: target.model || base.vehicle_model,
    displayName: targetDisplayName(target),
    mainImageUrl: preview.mainImageUrl,
    mainImageSource: preview.mainImageUrl ? "generated" : "inherited",
    inheritDetailImages: state.strategy.detailImageStrategy === "inherit",
    generatedDetailImageUrls,
    generatedTailImageUrls,
    detailImageSource: generatedDetailImageUrls.length ? "generated" : "inherited",
    tailImageSource: generatedTailImageUrls.length ? "generated" : "inherited",
    detailImageCount: normalizeImageList(base.detail_image_urls).length,
    titleStatus: preview.title ? "已完成" : "待生成",
    tagStatus: preview.tags?.length ? "已完成" : "待生成",
    videoStatus: state.strategy.generateVideo ? "待生成" : "跳过",
    writeBackStatus: existing?.writeBackStatus || "pending",
    writeBackEnabled: state.strategy.writeBackMode === "auto" || target.writeBackEnabled,
    purchasePrice: Number(base.purchase_cost || 0),
    salePrice: Number(base.air_sale_price_rmb || base.sale_price_rmb || 0),
    title: preview.title,
    tags: preview.tags,
    description: preview.description,
    promptTemplateId: state.promptConfig.templateId,
    generationRatio: state.promptConfig.ratio || "3:4",
    finalPositivePrompt: preview.finalPositivePrompt || "",
    finalNegativePrompt: preview.finalNegativePrompt || "",
    targetStatus: existing?.targetStatus || "generated",
    status: "success"
  };
  if (existing) Object.assign(existing, result);
  else state.results.unshift(result);
}

function resolveResultTarget(result) {
  return activeTargets.value.find((item) => item.id === result?.targetId) || {};
}

function inheritedDetailImagesForResult(result) {
  const baseImages = normalizeImageList(state.selectedBase?.detail_image_urls);
  return result.generatedDetailImageUrls?.length ? result.generatedDetailImageUrls : baseImages;
}

function materialAssetStatusForResult(result) {
  return result.status === "success" ? "generated" : "pending_review";
}

function logisticsRuleText(base = state.selectedBase || {}) {
  return base.logistics_rule_name || base.shipping_method || base.logistics_rule_id || "-";
}

function buildSelectionPayloadFromResult(result) {
  const base = state.selectedBase || {};
  const target = resolveResultTarget(result);
  const productName = result.productName || buildVariantProductName(target);
  const targetVehicle = result.displayName || targetDisplayName(target);
  return {
    name: productName,
    image_url: result.mainImageUrl || base.image_url || "",
    detail_image_urls: inheritedDetailImagesForResult(result),
    material: base.material || "",
    color: base.color || "",
    vehicle_model: targetVehicle,
    selling_points: base.selling_points || "",
    purchase_url: base.purchase_url || "",
    supplier_note: [
      base.supplier_note,
      result.description ? `裂变描述：${result.description}` : "",
      result.tags?.length ? `裂变标签：${result.tags.join(" / ")}` : "",
      `来源母商品 ${base.selection_id || base.id}`,
      `裂变任务 ${state.taskId}`,
      `裂变结果 ${result.resultId || result.id}`
    ].filter(Boolean).join("；"),
    source_platform: base.source_platform || "1688",
    supplier_id: base.supplier_id || null,
    owner_person_id: base.owner_person_id || null,
    shipping_method: base.shipping_method || "air_land",
    logistics_rule_id: base.logistics_rule_id || null,
    ozon_category_id: base.ozon_category_id || "",
    ozon_description_category_id: base.ozon_description_category_id || null,
    ozon_type_id: base.ozon_type_id || null,
    ozon_category_name: base.ozon_category_name || "",
    purchase_cost: Number(base.purchase_cost || 0),
    domestic_shipping: Number(base.domestic_shipping || 0),
    handling_fee: Number(base.handling_fee || 0),
    purchase_quantity: Number(base.purchase_quantity || 1),
    package_weight_g: Number(base.package_weight_g || 0),
    length_cm: Number(base.length_cm || 30),
    width_cm: Number(base.width_cm || 20),
    height_cm: Number(base.height_cm || 10),
    air_sale_price_rmb: result.salePrice,
    sale_price_rmb: result.salePrice,
    listing_price_rub: Number(base.listing_price_rub || 0),
    exchange_rate: Number(base.exchange_rate || 11.32),
    desired_profit_mode: base.desired_profit_mode || "margin",
    desired_profit_value: Number(base.desired_profit_value || 20),
    advertising_rate: Number(base.advertising_rate || 0),
    return_rate: Number(base.return_rate || 0.05),
    product_type: "selection",
    selection_status: "draft",
    source_selection_id: base.id,
    variant_task_id: state.taskId,
    variant_result_id: result.resultId || result.id,
    variant_type: state.variantType,
    is_variant_generated: 1,
    material_asset_status: materialAssetStatusForResult(result),
    generated_title: result.title || productName,
    generated_tags: result.tags || [],
    generated_description: result.description || replaceVehicleWords(base.selling_points || "", target)
  };
}

async function writeBackSelection(result) {
  const payload = buildSelectionPayloadFromResult(result);
  return await apiClient.post("/api/products", payload);
}

async function writeBackResult(result) {
  if (!result) return;
  if (result.writeBackStatus === "written_back") {
    ElMessage.warning("该裂变结果已回写到选品表");
    return;
  }
  writingBack.value = true;
  result.writeBackStatus = "writing";
  try {
    const created = await writeBackSelection(result);
    result.createdSelectionId = created?.id || created?.product?.id || null;
    result.writeBackStatus = "written_back";
    result.targetStatus = "written_back";
    const target = state.targets.find((item) => item.id === result.targetId);
    const plan = state.mainImagePlans.find((item) => item.id === result.targetId);
    if (target) target.status = "written_back";
    if (plan) plan.status = "written_back";
    ElMessage.success("已回写选品表");
  } catch (error) {
    result.writeBackStatus = "failed";
    ElMessage.error(error.message || "回写失败");
  } finally {
    writingBack.value = false;
  }
}

function buildWriteBackConfirmRow(result) {
  const target = resolveResultTarget(result);
  return {
    resultId: result.id,
    checked: result.writeBackEnabled !== false,
    result,
    productName: result.productName || buildVariantProductName(target),
    brand: result.brand || target.brand || "",
    model: result.displayName || targetDisplayName(target),
    mainImageSource: result.mainImageSource === "generated" ? "新生成" : "继承母商品",
    detailImageSource: result.detailImageSource === "generated" ? "新生成" : "继承母商品",
    purchasePrice: result.purchasePrice,
    salePrice: result.salePrice,
    logisticsRule: logisticsRuleText(),
    ozonCategory: state.selectedBase?.ozon_category_name || state.selectedBase?.ozon_category_id || "-",
    owner: state.selectedBase?.owner_name || state.selectedBase?.owner_person_id || "-",
    assetStatus: materialAssetStatusForResult(result)
  };
}

function requestWriteBackResult(result) {
  if (!result) return;
  if (result.writeBackStatus === "written_back") {
    ElMessage.warning("该裂变结果已回写到选品表");
    return;
  }
  writeBackDialog.rows = [buildWriteBackConfirmRow(result)];
  writeBackDialog.visible = true;
}

function requestWriteBackAll() {
  const rows = state.results.filter((item) => item.status !== "deleted" && item.writeBackStatus !== "written_back");
  if (!rows.length) {
    ElMessage.warning("没有可回写的生成结果，已回写结果不会重复回写");
    return;
  }
  writeBackDialog.rows = rows.map(buildWriteBackConfirmRow);
  writeBackDialog.visible = true;
}

async function confirmWriteBackRows() {
  const rows = writeBackDialog.rows.filter((row) => row.checked).map((row) => row.result);
  if (!rows.length) {
    ElMessage.warning("请至少勾选一个结果回写");
    return;
  }
  for (const row of rows) await writeBackResult(row);
  writeBackDialog.visible = false;
}

function deleteResult(id) {
  const row = state.results.find((item) => item.id === id);
  if (row) row.status = "deleted";
}

function enterListing() {
  ElMessage.info("批量进入上架流程已预留，后续接入店铺批量上架。");
}

async function openPromptPreview() {
  const target = activeTargets.value[0] || {
    id: "preview-target",
    brand: inferBrand(state.selectedBase?.vehicle_model || state.selectedBase?.name || ""),
    model: state.selectedBase?.vehicle_model || "",
    displayName: state.selectedBase?.vehicle_model || state.selectedBase?.name || ""
  };
  promptDialog.visible = true;
  promptDialog.loading = true;
  promptDialog.target = target;
  try {
    const result = await renderPromptForTarget(target);
    promptDialog.positivePrompt = result.finalPositivePrompt || "";
    promptDialog.negativePrompt = result.finalNegativePrompt || "";
    promptDialog.missingVariables = result.missingVariables || [];
  } catch (error) {
    ElMessage.error(error.message || "Prompt 预览失败");
  } finally {
    promptDialog.loading = false;
  }
}

function savePromptOverrideForTask() {
  state.promptConfig.positivePromptOverride = promptDialog.positivePrompt;
  state.promptConfig.negativePromptOverride = promptDialog.negativePrompt;
  promptDialog.visible = false;
  ElMessage.success("已应用到本次裂变任务");
}

function openPromptLibrary() {
  router.push("/settings/prompts");
}

function backToSelection() {
  const query = {};
  const baseSelectionId = String(route.query.baseSelectionId || "").trim();
  const source = String(route.query.source || "").trim();
  if (baseSelectionId) query.productId = baseSelectionId;
  if (baseSelectionId) query.openEdit = "1";
  if (source === "selection" && baseSelectionId) query.tabTitle = `选品池 · ID ${baseSelectionId}`;
  router.push({ path: "/selection", query });
}

onMounted(loadBootstrap);
</script>

<template>
  <div v-loading="loading" class="ai-variant-workbench">
    <VariantTaskHeader
      :base-product="state.selectedBase"
      :variant-type-label="currentType.title"
      :task-status="state.taskStatus"
      :generated-count="generatedCount"
      :written-back-count="writtenBackCount"
      :generating="generating"
      :writing-back="writingBack"
      @save-draft="saveDraft"
      @start-generate="startGenerate"
      @pause-task="pauseTask"
      @write-back-all="requestWriteBackAll"
      @back="backToSelection"
    />

    <section class="variant-board">
      <aside class="config-column">
        <VariantTypeSelector
          :model-value="state.variantType"
          :types="variantTypes"
          @update:model-value="setVariantType"
        />

        <VariantTargetManager
          :variant-type="state.variantType"
          :targets="state.targets"
          :main-image-plans="state.mainImagePlans"
          :products="state.products"
          :templates="commonTemplates"
          :selected-base="state.selectedBase"
          @add-targets="addTargets"
          @add-plan="addMainImagePlan"
          @remove="removeTarget"
          @reorder="reorderTargets"
        />

        <VariantStrategyPanel v-model="state.strategy" :variant-type="state.variantType" />

        <VariantPromptTemplatePanel
          v-model="state.promptConfig"
          :templates="state.promptTemplates"
          :variant-type="state.variantType"
          @preview="openPromptPreview"
          @open-library="openPromptLibrary"
        />
      </aside>

      <main class="preview-column">
        <VariantPreviewPanel
          :previews="state.previews"
          :generating="generating"
          @regenerate="regenerateTarget"
        />
      </main>
    </section>

    <VariantResultPool
      :results="state.results"
      @write-back="requestWriteBackResult"
      @write-back-all="requestWriteBackAll"
      @enter-listing="enterListing"
      @delete="deleteResult"
      @regenerate="regenerateTarget"
    />

    <el-dialog v-model="promptDialog.visible" title="预览 / 编辑本次 Prompt" width="960px" align-center>
      <div v-loading="promptDialog.loading" class="prompt-preview-dialog">
        <el-alert
          v-if="promptDialog.missingVariables.length"
          type="warning"
          show-icon
          :closable="false"
          :title="`缺失变量：${promptDialog.missingVariables.join(', ')}`"
        />
        <el-form label-position="top">
          <el-form-item label="最终正向 Prompt">
            <el-input v-model="promptDialog.positivePrompt" type="textarea" :rows="12" />
          </el-form-item>
          <el-form-item label="最终负向 Prompt">
            <el-input v-model="promptDialog.negativePrompt" type="textarea" :rows="8" />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="promptDialog.visible = false">取消</el-button>
        <el-button @click="state.promptConfig.positivePromptOverride = ''; state.promptConfig.negativePromptOverride = ''; promptDialog.visible = false">恢复模板默认</el-button>
        <el-button type="primary" @click="savePromptOverrideForTask">应用到本次任务</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="writeBackDialog.visible" title="确认回写选品估价表" width="1180px" align-center>
      <el-table :data="writeBackDialog.rows" border stripe max-height="520" class="writeback-confirm-table">
        <el-table-column label="是否回写" width="96" align="center">
          <template #default="{ row }">
            <el-switch v-model="row.checked" :disabled="row.result.writeBackStatus === 'written_back'" />
          </template>
        </el-table-column>
        <el-table-column prop="productName" label="商品名称" min-width="240" />
        <el-table-column prop="brand" label="目标品牌" min-width="110" />
        <el-table-column prop="model" label="目标车型" min-width="150" />
        <el-table-column prop="mainImageSource" label="主图来源" width="110" />
        <el-table-column prop="detailImageSource" label="详情图来源" width="120" />
        <el-table-column label="采购价" width="100" align="right">
          <template #default="{ row }">¥{{ money(row.purchasePrice) }}</template>
        </el-table-column>
        <el-table-column label="售价" width="100" align="right">
          <template #default="{ row }">¥{{ money(row.salePrice) }}</template>
        </el-table-column>
        <el-table-column prop="logisticsRule" label="物流规则" min-width="130" />
        <el-table-column prop="ozonCategory" label="Ozon 类目" min-width="180" />
        <el-table-column prop="owner" label="负责人" min-width="110" />
        <el-table-column prop="assetStatus" label="素材状态" width="110" />
      </el-table>
      <template #footer>
        <el-button @click="writeBackDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="writingBack" @click="confirmWriteBackRows">确认回写</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.ai-variant-workbench {
  min-height: 100%;
  padding: 0 0 24px;
  background:
    radial-gradient(circle at 12% 0%, rgba(64, 158, 255, 0.10), transparent 34%),
    linear-gradient(180deg, #f5f8fc 0%, #eef3f8 100%);
}

.variant-board {
  display: grid;
  grid-template-columns: minmax(360px, 40%) minmax(0, 60%);
  gap: 16px;
  padding: 16px;
  align-items: start;
}

.config-column,
.preview-column {
  display: grid;
  gap: 14px;
  min-width: 0;
}

.preview-column {
  position: sticky;
  top: 116px;
  max-height: calc(100vh - 132px);
  overflow: auto;
  padding-right: 4px;
}

.prompt-preview-dialog {
  display: grid;
  gap: 12px;
}

@media (max-width: 1280px) {
  .variant-board {
    grid-template-columns: 1fr;
  }

  .preview-column {
    position: static;
    max-height: none;
  }
}
</style>
