<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { Search } from "@element-plus/icons-vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
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
  {
    value: "multi_model",
    title: "同款多车型裂变",
    shortTitle: "多车型",
    description: "一套参考图和材质卖点，批量替换品牌、车型、logo 文案并生成商品草稿。"
  },
  {
    value: "logo_text_replace",
    title: "Logo / 文字替换裂变",
    shortTitle: "Logo 替换",
    description: "保持构图、材质、颜色一致，只替换车标、车型字样或适配信息。"
  },
  {
    value: "same_model_main_image",
    title: "同车型主图方案裂变",
    shortTitle: "主图方案",
    description: "车型不变，批量生成白底、场景、质感等不同主图方案。"
  }
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
    mainImageStyle: "高级原厂风",
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

const importDialog = reactive({
  visible: false,
  source: "collector",
  loading: false,
  keyword: "",
  rows: [],
  selectedIds: []
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
const importDialogTitle = computed(() => {
  const names = { collector: "从采集箱选择导入", draft: "从草稿箱选择导入", online: "从在线商品选择导入" };
  return names[importDialog.source] || "选择导入商品";
});
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
  if (Array.isArray(value)) return value.map((item) => typeof item === "string"
    ? item
    : (item?.url || item?.image_url || item?.imageUrl || item?.src || item?.preview_url || item?.previewUrl || item?.publish_url || item?.publishUrl || "")
  ).filter(Boolean);
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return normalizeImageList(parsed);
  } catch {
    // Keep delimiter parsing as a fallback for old data.
  }
  return text.split(/\s*\|\|\s*|\r?\n|[,，]/).map((item) => item.trim()).filter(Boolean);
}

function parseMaybeJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function plainClone(value, fallback = {}) {
  if (value == null) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function firstFilled(...values) {
  return values.find((value) => {
    if (Array.isArray(value)) return value.length;
    return String(value ?? "").trim();
  }) ?? "";
}

function sourcePayloads(row = {}) {
  const edited = [
    parseMaybeJson(row.templateSnapshot),
    parseMaybeJson(row.template_snapshot),
    parseMaybeJson(row.listingTemplate),
    parseMaybeJson(row.listing_template),
    parseMaybeJson(row.editPayload),
    parseMaybeJson(row.edit_payload),
    parseMaybeJson(row.editablePayload),
    parseMaybeJson(row.editable_payload)
  ].filter((item) => item && typeof item === "object");
  const raw = [
    row,
    parseMaybeJson(row.rawPayload),
    parseMaybeJson(row.raw_payload),
    parseMaybeJson(row.raw_json),
    parseMaybeJson(row.raw),
    parseMaybeJson(row.payload),
    parseMaybeJson(row.draft_payload),
    parseMaybeJson(row.source_payload),
    parseMaybeJson(row.request_json),
    parseMaybeJson(row.follow_payload),
    parseMaybeJson(row.material_payload),
    parseMaybeJson(row.collected_payload)
  ].filter((item) => item && typeof item === "object");
  const base = [...edited, ...raw];
  return [
    ...base,
    ...base.flatMap((item) => [
      parseMaybeJson(item.editPayload),
      parseMaybeJson(item.edit_payload),
      parseMaybeJson(item.editablePayload),
      parseMaybeJson(item.editable_payload),
      parseMaybeJson(item.payload),
      parseMaybeJson(item.rawPayload),
      parseMaybeJson(item.raw_payload),
      parseMaybeJson(item.source_raw),
      parseMaybeJson(item.templateSnapshot),
      parseMaybeJson(item.template_snapshot),
      parseMaybeJson(item.listingTemplate),
      parseMaybeJson(item.listing_template)
    ]).filter((item) => item && typeof item === "object")
  ];
}

function payloadValue(payloads, keys = []) {
  for (const payload of payloads) {
    for (const key of keys) {
      const value = payload?.[key];
      if (Array.isArray(value) ? value.length : String(value ?? "").trim()) return value;
    }
  }
  return "";
}

function payloadImages(payloads, keys = []) {
  for (const payload of payloads) {
    for (const key of keys) {
      const images = normalizeImageList(payload?.[key]);
      if (images.length) return images;
    }
  }
  return [];
}

function sourceAssetImages(payloads = []) {
  return payloadImages(payloads, [
    "source_images",
    "sourceImages",
    "user_images",
    "userImages",
    "uploaded_images",
    "uploadedImages",
    "imported_images",
    "importedImages"
  ]);
}

function editableAssetPayloads(row = {}) {
  return [
    parseMaybeJson(row.editPayload),
    parseMaybeJson(row.edit_payload),
    parseMaybeJson(row.editablePayload),
    parseMaybeJson(row.editable_payload)
  ].filter((item) => item && typeof item === "object");
}

function editableVariantAssetImages(row = {}) {
  return editableAssetPayloads(row)
    .flatMap((payload) => Array.isArray(payload.variants || payload.editorVariants || payload.editor_variants)
      ? (payload.variants || payload.editorVariants || payload.editor_variants)
      : [])
    .flatMap((variant) => normalizeImageList(variant?.images || variant?.image_urls || variant?.imageUrls || []));
}

function payloadAttributeValue(payloads = [], namePatterns = []) {
  const patterns = namePatterns.map((item) => item instanceof RegExp ? item : new RegExp(String(item), "i"));
  for (const payload of payloads) {
    const rows = [
      payload?.attributes,
      payload?.ozon_attributes,
      payload?.ozonAttributes,
      payload?.complex_attributes,
      payload?.complexAttributes,
      payload?.editable_payload?.attributes,
      payload?.editablePayload?.attributes
    ].flatMap((item) => Array.isArray(item) ? item : []);
    for (const row of rows) {
      const name = String(row?.name || row?.attribute_name || row?.attributeName || row?.label || row?.id || "").trim();
      if (!patterns.some((pattern) => pattern.test(name))) continue;
      const value = firstFilled(
        row?.value,
        row?.values?.map((item) => item?.value || item?.label || item?.name || item).filter(Boolean).join(", "),
        row?.dictionary_value,
        row?.dictionaryValue,
        row?.text
      );
      if (String(value || "").trim()) return value;
    }
  }
  return "";
}

function inferVehicleModels(text = "") {
  const found = new Set();
  const source = String(text || "").replace(/#/g, " ");
  const brandPattern = "(TENET|BELGEE|HAVAL|CHERY|JAECOO|GEELY|OMODA|EXEED|CHANGAN|TOYOTA|HONDA|BMW|MERCEDES|LADA|KIA|HYUNDAI)";
  const modelPattern = "([A-Z]?\\d{1,2}[A-Z]?|TIGGO\\s*\\d(?:\\s*(?:PRO|PLUS|KUNPENG))?|JOLION|DARGO|X\\d{2}|J\\d)";
  for (const match of source.matchAll(new RegExp(`${brandPattern}[\\s_-]*${modelPattern}`, "gi"))) {
    found.add(`${match[1].toUpperCase()} ${String(match[2]).replace(/\s+/g, " ").toUpperCase()}`);
  }
  for (const match of source.matchAll(/\b(TIGGO\s*\d(?:\s*(?:PRO|PLUS|KUNPENG))?|JOLION|DARGO|X\d{2}|T\d{1,2}[A-Z]?|J\d)\b/gi)) {
    const model = String(match[1]).replace(/\s+/g, " ").toUpperCase();
    const brand = inferBrand(source);
    found.add([brand, model].filter(Boolean).join(" "));
  }
  return [...found].filter(Boolean);
}

function inferSimpleValue(text = "", patterns = []) {
  const source = String(text || "");
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return String(match[1]).trim();
  }
  return "";
}

function parseCategoryIds(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parseCategoryIds(parsed);
  } catch {
    // Split plain category paths below.
  }
  return text.split(/\s*(?:>|\/|,|，)\s*/).map((item) => item.trim()).filter(Boolean);
}

function categoryMetaFromPayloads(payloads = []) {
  let descriptionCategoryId = String(payloadValue(payloads, [
    "description_category_id",
    "descriptionCategoryId",
    "ozon_description_category_id",
    "ozonDescriptionCategoryId"
  ]) || "").trim();
  let typeId = String(payloadValue(payloads, ["type_id", "typeId", "ozon_type_id", "ozonTypeId"]) || "").trim();
  const categoryIds = parseCategoryIds(payloadValue(payloads, ["category_ids", "categoryIds"]));
  if (!descriptionCategoryId && categoryIds.length >= 2) descriptionCategoryId = categoryIds[categoryIds.length - 2];
  if (!typeId && categoryIds.length) typeId = categoryIds[categoryIds.length - 1];
  const ozonCategoryId = String(payloadValue(payloads, [
    "ozon_category_id",
    "ozonCategoryId",
    "category_id",
    "categoryId"
  ]) || (descriptionCategoryId && typeId ? `${descriptionCategoryId}:${typeId}` : "")).trim();
  return {
    ozonCategoryId,
    descriptionCategoryId,
    typeId,
    categoryName: String(payloadValue(payloads, [
      "ozon_category_name",
      "ozonCategoryName",
      "category_name",
      "categoryName",
      "category",
      "product_type"
    ]) || "").trim()
  };
}

function splitTags(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return splitTags(parsed);
  } catch {
    // Plain text tags are handled below.
  }
  return text.split(/\s*[,，、]\s*/).map((item) => item.trim()).filter(Boolean).slice(0, 8);
}

function money(value) {
  return Number(value || 0).toFixed(1);
}

function inferBrand(text) {
  const match = String(text || "").match(/\b(TENET|BELGEE|HAVAL|CHERY|JAECOO|GEELY|OMODA|EXEED|CHANGAN|TOYOTA|HONDA|BMW|MERCEDES|LADA|KIA|HYUNDAI)\b/i);
  return match ? match[1].toUpperCase() : "";
}

function normalizeTemplateImages(images = []) {
  return normalizeImageList(images).map((url, index) => ({ url, sort_order: index + 1 }));
}

function normalizeTemplateSnapshot(snapshot = null, product = {}) {
  const source = plainClone(snapshot, null);
  if (!source || typeof source !== "object") return null;
  const editable = plainClone(source.editable_payload || source.editablePayload || {}, {});
  const fallbackImageInput = [
    ...(Array.isArray(product.detailImages) ? product.detailImages : []),
    product.imageUrl,
    product.image_url
  ].filter(Boolean);
  const images = Array.isArray(source.images)
    ? source.images
    : normalizeTemplateImages(editable.images || fallbackImageInput);
  const attributes = Array.isArray(source.attributes)
    ? source.attributes
    : (Array.isArray(editable.attributes) ? editable.attributes : []);
  return {
    ...source,
    ozon_category_id: source.ozon_category_id || source.ozonCategoryId || editable.category_id || product.ozonCategoryId || product.ozon_category_id || "",
    description_category_id: source.description_category_id || editable.description_category_id || product.descriptionCategoryId || product.ozon_description_category_id || "",
    type_id: source.type_id || editable.type_id || product.typeId || product.ozon_type_id || "",
    legacy_category_id: source.legacy_category_id || editable.legacy_category_id || product.legacyCategoryId || "",
    category_name: source.category_name || source.categoryName || editable.category_name || product.category || product.ozon_category_name || "AI 商品裂变",
    template_name: source.template_name || source.templateName || editable.template_name || product.name || product.title || "AI 商品裂变模板",
    title: source.title || editable.title || product.title || product.name || "",
    description: source.description || editable.description || product.description || "",
    attributes,
    images,
    source_raw: source.source_raw || source.sourceRaw || editable.source_raw || product.raw || {},
    editable_payload: {
      ...editable,
      title: source.title || editable.title || product.title || product.name || "",
      description: source.description || editable.description || product.description || "",
      category_name: source.category_name || source.categoryName || editable.category_name || product.category || "",
      attributes,
      images
    }
  };
}

function extractTemplateSnapshotFromPayloads(payloads = [], product = {}) {
  for (const payload of payloads) {
    const candidate = payload?.template_snapshot
      || payload?.templateSnapshot
      || payload?.template
      || payload?.listing_template
      || payload?.listingTemplate;
    const normalized = normalizeTemplateSnapshot(candidate, product);
    if (normalized) return normalized;
    if (payload?.editable_payload || payload?.editablePayload) {
      const normalizedEditable = normalizeTemplateSnapshot(payload, product);
      if (normalizedEditable) return normalizedEditable;
    }
  }
  return null;
}

function inferCategory(row = {}) {
  const text = `${row.ozon_category_name || row.category || row.categoryName || row.product_type || row.name || row.product_name || ""}`;
  if (/trunk|багаж|后备箱/i.test(text)) return "后备箱垫";
  if (/steering|руль|方向盘/i.test(text)) return "方向盘套";
  if (/mat|коврик|脚垫/i.test(text)) return "汽车脚垫";
  if (/key|брелок|钥匙/i.test(text)) return "汽车钥匙扣";
  return row.ozon_category_name || row.category || row.categoryName || "汽车用品";
}

function sourceText(source) {
  if (source === "collector") return "采集箱";
  if (source === "draft") return "草稿箱";
  if (source === "online") return "在线商品";
  if (source === "selection") return "选品池";
  return "商品";
}

function normalizeProduct(row = {}, source = "collector", index = 0) {
  const payloads = sourcePayloads(row);
  const categoryMeta = categoryMetaFromPayloads(payloads);
  const name = firstFilled(payloadValue(payloads, ["name", "product_name", "title", "subject", "sku_name", "skuName", "offer_name"]), `商品 ${index + 1}`);
  const rawTags = payloadValue(payloads, ["tags", "keywords", "hashtags", "selling_points"]);
  const description = payloadValue(payloads, ["description", "description_text", "short_description", "summary", "content", "selling_points", "annotation"]);
  const title = payloadValue(payloads, ["title", "name", "product_name", "subject"]) || name;
  const searchableText = [
    name,
    title,
    rawTags,
    description,
    categoryMeta.categoryName,
    payloadAttributeValue(payloads, [/车型|适用|model|vehicle|авто|марка/i])
  ].filter(Boolean).join(" ");
  const inferredModels = inferVehicleModels(searchableText);
  const model = payloadValue(payloads, ["vehicle_model", "model", "target_model", "car_model"])
    || payloadAttributeValue(payloads, [/车型|适用车型|model|vehicle/i])
    || inferredModels[0]
    || "";
  const brand = payloadValue(payloads, ["vehicle_brand", "brand"])
    || payloadAttributeValue(payloads, [/品牌|brand|марка/i])
    || inferBrand(`${name} ${model} ${rawTags}`)
    || "";
  const userAssetImages = sourceAssetImages(payloads);
  const editedVariantAssetImages = editableVariantAssetImages(row);
  const editedAssetImages = payloadImages(editableAssetPayloads(row), ["images", "image_urls", "imageUrls", "images_json", "media_assets"]);
  const imageList = userAssetImages.length
    ? userAssetImages
    : editedVariantAssetImages.length
      ? editedVariantAssetImages
    : editedAssetImages.length
      ? editedAssetImages
    : payloadImages(payloads, ["image_url", "main_image_url", "primary_image", "cover_image", "cover", "images", "image_urls", "imageUrls", "images_json", "media_assets"]);
  const allImages = userAssetImages.length
    ? userAssetImages
    : editedVariantAssetImages.length
      ? editedVariantAssetImages
    : editedAssetImages.length
      ? editedAssetImages
    : payloadImages(payloads, ["detail_image_urls", "detailImageUrls", "detail_images", "detailImages", "rich_content_images", "images", "image_urls", "imageUrls", "images_json", "media_assets"]);
  const detailImages = allImages.filter((image, imageIndex) => imageIndex > 0 || image !== imageList[0]);
  const tags = splitTags(rawTags).length ? splitTags(rawTags) : [brand, model, inferCategory(row)].filter(Boolean);
  const material = firstFilled(
    row.material,
    payloadValue(payloads, ["material", "material_name", "materialName"]),
    payloadAttributeValue(payloads, [/材质|材料|material|материал/i]),
    inferSimpleValue(searchableText, [/材质[:：]\s*([^,，;；\n]+)/i, /\b(ABS|EVA|TPU|PVC|нержавеющая сталь|экокожа|кожа)\b/i])
  );
  const color = firstFilled(
    row.color,
    payloadValue(payloads, ["color", "colour", "color_name", "colorName"]),
    payloadAttributeValue(payloads, [/颜色|color|colour|цвет/i]),
    inferSimpleValue(searchableText, [/颜色[:：]\s*([^,，;；\n]+)/i, /\b(black|white|red|blue|silver|черный|белый|красный|синий|серебристый)\b/i])
  );
  const quantity = firstFilled(
    row.quantity,
    payloadValue(payloads, ["quantity", "qty", "count"]),
    payloadAttributeValue(payloads, [/数量|件数|quantity|qty|count|количество/i]),
    inferSimpleValue(searchableText, [/(\d+)\s*(?:шт|pcs|pieces|件|个|只)\b/i])
  );
  const sourceKey = source === "collector"
    ? (row.sku || row.code || row.id || index)
    : (row.id || row.selection_id || row.sku || row.code || index);
  const product = {
    id: `${source}-${sourceKey}`,
    sourceId: sourceKey || "",
    source,
    name,
    category: categoryMeta.categoryName || inferCategory(row),
    ozonCategoryId: categoryMeta.ozonCategoryId,
    descriptionCategoryId: categoryMeta.descriptionCategoryId,
    typeId: categoryMeta.typeId,
    legacyCategoryId: payloadValue(payloads, ["legacy_category_id", "legacyCategoryId"]),
    brand,
    model: model || inferBrand(name) || "",
    vehicle_model: model,
    compatibleModels: inferredModels,
    vehicle_brand: brand,
    imageUrl: imageList[0] || row.image_url || "",
    image_url: imageList[0] || row.image_url || "",
    detailImages,
    detail_image_urls: detailImages,
    title,
    tags,
    description,
    selling_points: description,
    material,
    color,
    quantity,
    raw: row,
    tone: ["blue", "green", "amber", "slate"][index % 4]
  };
  product.templateSnapshot = extractTemplateSnapshotFromPayloads(payloads, product);
  return product;
}

function targetDisplayName(target = {}) {
  return target.displayName || [target.brand, target.model].filter(Boolean).join(" ") || state.selectedBase?.vehicle_model || "";
}

function productKindFromBaseName(name = "") {
  const text = String(name || "");
  if (/key|брелок|钥匙|钥匙扣/i.test(text)) return "汽车钥匙扣";
  if (/порог|накладк|门槛|踏板|不锈钢/i.test(text)) return text.includes("不锈钢") ? "不锈钢门槛条" : "汽车门槛条";
  if (/коврик|脚垫|后备箱垫/i.test(text)) return "汽车垫";
  if (/贴纸|车贴/i.test(text)) return "汽车贴纸";
  const cleaned = text
    .replace(/\b(TENET|BELGEE|HAVAL|CHERY|JAECOO|GEELY|OMODA|EXEED|CHANGAN|TOYOTA|HONDA|BMW|MERCEDES|LADA|KIA|HYUNDAI)\b/gi, "")
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
      name: "高级原厂风",
      style: "高级原厂风",
      writeBackEnabled: false
    });
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
    const promptTemplates = await listAiPromptTemplates();
    state.promptTemplates = Array.isArray(promptTemplates) ? promptTemplates : [];
    applyDefaultPromptTemplate();
    const baseId = Number(route.query.baseSelectionId || route.query.productId || 0);
    if (baseId) {
      const row = await apiClient.get(`/api/products/${baseId}`, { noCache: true });
      state.selectedBase = normalizeProduct(row, "selection", 0);
    }
    state.taskId = `VT-${Date.now().toString(36).toUpperCase()}`;
    ensureStarterTargets();
  } catch (error) {
    ElMessage.error(error.message || "商品裂变工作台加载失败");
  } finally {
    loading.value = false;
  }
}

async function openImportDialog(source) {
  importDialog.source = source;
  importDialog.visible = true;
  importDialog.selectedIds = [];
  await loadImportCandidates();
}

async function loadImportCandidates() {
  const source = importDialog.source;
  importDialog.loading = true;
  try {
    const params = new URLSearchParams({ paged: "1", page: "1", pageSize: "12" });
    if (importDialog.keyword.trim()) params.set("query", importDialog.keyword.trim());
    const url = source === "collector"
      ? `/api/listing/collector-box?${params.toString()}`
      : source === "draft"
        ? `/api/listing/drafts?${params.toString()}`
        : `/api/online-products?${params.toString()}`;
    const payload = await apiClient.get(url, { noCache: true });
    const rows = normalizeRows(payload);
    importDialog.rows = rows.map((row, index) => normalizeProduct(row, source, index)).filter((item) => item.name);
    if (!importDialog.rows.length) ElMessage.warning(`${sourceText(source)}暂无可导入的数据`);
  } catch (error) {
    importDialog.rows = [];
    ElMessage.error(error.message || `${sourceText(source)}加载失败`);
  } finally {
    importDialog.loading = false;
  }
}

function toggleImportCandidate(id) {
  importDialog.selectedIds = importDialog.selectedIds.includes(id)
    ? importDialog.selectedIds.filter((item) => item !== id)
    : [...importDialog.selectedIds, id];
}

async function hydrateImportProduct(product, index) {
  try {
    if (product.source === "collector" && product.sourceId) {
      const detail = await apiClient.get(`/api/listing/collector-box/${encodeURIComponent(product.sourceId)}`, { noCache: true });
      return normalizeProduct({ ...product.raw, ...detail }, "collector", index);
    }
    if (product.source === "draft" && product.raw?.template_id) {
      const [draftDetail, template] = await Promise.all([
        product.sourceId
          ? apiClient.get(`/api/listing/drafts/${encodeURIComponent(product.sourceId)}`, { noCache: true }).catch(() => null)
          : Promise.resolve(null),
        apiClient.get(`/api/listing/templates/${encodeURIComponent(product.raw.template_id)}`, { noCache: true }).catch(() => null)
      ]);
      return normalizeProduct({
        ...product.raw,
        ...(draftDetail || {}),
        template_snapshot: draftDetail?.template_snapshot || draftDetail?.template || template
      }, "draft", index);
    }
    if (product.source === "online" && product.sourceId) {
      const draft = await apiClient.get(`/api/online-products/${encodeURIComponent(product.sourceId)}/edit-draft`, { noCache: true });
      return normalizeProduct({ ...product.raw, ...draft, template_snapshot: draft?.template || draft?.template_snapshot }, "online", index);
    }
  } catch {
    return product;
  }
  return product;
}

async function confirmImport() {
  const selected = importDialog.rows.filter((item) => importDialog.selectedIds.includes(item.id));
  if (!selected.length) {
    ElMessage.warning("请先勾选要导入的记录");
    return;
  }
  importDialog.loading = true;
  const hydrated = await Promise.all(selected.map(hydrateImportProduct));
  importDialog.loading = false;
  state.products = hydrated;
  state.selectedBase = hydrated[0] || null;
  importDialog.visible = false;
  syncPreviewShells();
  ElMessage.success(`已导入 ${hydrated.length} 个商品，当前母商品已切换为第一条`);
}

function visualText(product = {}) {
  return [product.brand, product.model, product.category].filter(Boolean).join("\n");
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
    promptConfig: state.promptConfig,
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
        "Use the source product as reference.",
        "Keep material, color, structure and selling points unchanged.",
        `Target vehicle/logo: ${targetDisplayName(target)}`,
        `Style: ${target.style || state.strategy.mainImageStyle}`,
        state.promptConfig.userPrompt || state.strategy.customPrompt
      ].filter(Boolean).join("\n"),
      finalNegativePrompt: "wrong vehicle model, wrong logo, changed material, distorted product, unreadable text",
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
  await wait(180);
  return state.selectedBase?.image_url || "";
}

async function generateVariantTitle(target) {
  await wait(120);
  if (state.variantType === "same_model_main_image") return `${state.selectedBase?.name || "汽车用品"} ${target.displayName} 主图方案`;
  return buildVariantProductName(target);
}

async function generateVariantTags(target) {
  await wait(90);
  return ["Ozon", "汽车用品", target.brand, target.model, state.selectedBase?.material, state.strategy.mainImageStyle].filter(Boolean).slice(0, 8);
}

async function generateVariantDescription(target) {
  await wait(110);
  const baseDescription = state.selectedBase?.selling_points || state.selectedBase?.description || "继承母商品材质、颜色、尺寸和核心卖点。";
  return `${replaceVehicleWords(baseDescription, target)} 已按 ${targetDisplayName(target)} 生成独立标题、标签和素材提示词。`;
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

function resultImages(result = {}) {
  return [
    result.mainImageUrl,
    ...inheritedDetailImagesForResult(result)
  ].filter(Boolean);
}

function buildFallbackListingTemplatePayload(result = {}) {
  const base = state.selectedBase || {};
  const target = resolveResultTarget(result);
  const title = result.title || result.productName || buildVariantProductName(target);
  const description = result.description || replaceVehicleWords(base.selling_points || base.description || "", target);
  const images = resultImages(result).map((url, index) => ({ url, sort_order: index + 1 }));
  const attributes = [
    base.material ? { name: "material", value: base.material } : null,
    base.color ? { name: "color", value: base.color } : null,
    targetDisplayName(target) ? { name: "vehicle_model", value: targetDisplayName(target) } : null,
    result.tags?.length ? { name: "tags", values: result.tags } : null
  ].filter(Boolean);
  const editablePayload = {
    title,
    description,
    category_name: base.category || base.ozon_category_name || "AI 商品裂变",
    attributes,
    images,
    variants: [{
      sku: [base.sourceId || base.id, targetDisplayName(target)].filter(Boolean).join("-").slice(0, 128),
      title,
      name: title,
      images,
      price: base.raw?.price || base.raw?.sale_price || base.sale_price_rmb || base.air_sale_price_rmb || 0,
      hashtags: result.tags || []
    }],
    ai_variant: {
      result_id: result.id,
      task_id: state.taskId,
      variant_type: state.variantType,
      target: targetDisplayName(target),
      prompt: {
        positive: result.finalPositivePrompt || "",
        negative: result.finalNegativePrompt || ""
      }
    },
    source_raw: {
      source_type: base.source || "asset_variant",
      source_id: base.sourceId || base.id || "",
      product: base,
      result
    }
  };
  return {
    ozon_category_id: base.ozonCategoryId || base.ozon_category_id || "",
    description_category_id: base.descriptionCategoryId || base.ozon_description_category_id || "",
    type_id: base.typeId || base.ozon_type_id || "",
    legacy_category_id: base.legacyCategoryId || "",
    category_name: editablePayload.category_name,
    template_name: `AI商品裂变 / ${targetDisplayName(target) || title}`.slice(0, 120),
    source_type: "asset_variant",
    source_ozon_sku: String(base.sourceId || base.id || "").trim(),
    source_raw: editablePayload.source_raw,
    ai_rules: {
      variantType: state.variantType,
      strategy: state.strategy,
      promptConfig: state.promptConfig
    },
    image_rules: {
      mainImageStyle: state.strategy.mainImageStyle,
      detailImages: state.strategy.detailImageStrategy,
      negativePrompt: result.finalNegativePrompt || ""
    },
    title_prompt: result.finalPositivePrompt || "",
    description_prompt: result.finalPositivePrompt || "",
    editable_payload: editablePayload,
    title,
    description,
    attributes,
    images
  };
}

function mergeTemplateWithVariantResult(result = {}) {
  const base = state.selectedBase || {};
  const target = resolveResultTarget(result);
  const snapshot = normalizeTemplateSnapshot(base.templateSnapshot, base);
  if (!snapshot) return buildFallbackListingTemplatePayload(result);
  const template = plainClone(snapshot, {});
  const editable = plainClone(template.editable_payload, {});
  const title = result.title || result.productName || template.title || editable.title || base.title || base.name || "";
  const description = result.description || template.description || editable.description || base.description || "";
  const images = resultImages(result).length
    ? resultImages(result).map((url, index) => ({ url, sort_order: index + 1 }))
    : (Array.isArray(template.images) ? template.images : normalizeTemplateImages(editable.images || base.imageUrl));
  const attributes = plainClone(template.attributes || editable.attributes || [], []);
  const variants = Array.isArray(editable.variants) && editable.variants.length
    ? plainClone(editable.variants, []).map((variant, index) => index === 0
      ? {
          ...variant,
          title: title || variant.title || variant.name || "",
          name: title || variant.name || variant.title || "",
          images: images.length ? images : variant.images,
          hashtags: result.tags?.length ? result.tags : variant.hashtags
        }
      : variant)
    : [{
        sku: [base.sourceId || base.id, targetDisplayName(target)].filter(Boolean).join("-").slice(0, 128),
        title,
        name: title,
        images,
        price: base.raw?.price || base.raw?.sale_price || 0,
        hashtags: result.tags || []
      }];
  const aiVariant = {
    result_id: result.id,
    task_id: state.taskId,
    variant_type: state.variantType,
    target: targetDisplayName(target),
    prompt: {
      positive: result.finalPositivePrompt || "",
      negative: result.finalNegativePrompt || ""
    }
  };
  return {
    ...template,
    id: "",
    ozon_category_id: template.ozon_category_id || base.ozonCategoryId || base.ozon_category_id || "",
    description_category_id: template.description_category_id || editable.description_category_id || base.descriptionCategoryId || base.ozon_description_category_id || "",
    type_id: template.type_id || editable.type_id || base.typeId || base.ozon_type_id || "",
    legacy_category_id: template.legacy_category_id || editable.legacy_category_id || base.legacyCategoryId || "",
    category_name: template.category_name || editable.category_name || base.category || base.ozon_category_name || "AI 商品裂变",
    template_name: `AI商品裂变 / ${template.template_name || targetDisplayName(target) || title}`.slice(0, 120),
    source_type: "asset_variant",
    source_ozon_sku: String(template.source_ozon_sku || base.sourceId || base.id || "").trim(),
    source_raw: {
      ...(template.source_raw || editable.source_raw || {}),
      ai_variant: aiVariant,
      original_template_snapshot: snapshot
    },
    ai_rules: {
      ...(template.ai_rules || {}),
      variantType: state.variantType,
      strategy: state.strategy,
      promptConfig: state.promptConfig
    },
    image_rules: {
      ...(template.image_rules || {}),
      mainImageStyle: state.strategy.mainImageStyle,
      detailImages: state.strategy.detailImageStrategy,
      negativePrompt: result.finalNegativePrompt || template.image_rules?.negativePrompt || ""
    },
    title_prompt: result.finalPositivePrompt || template.title_prompt || "",
    description_prompt: result.finalPositivePrompt || template.description_prompt || "",
    editable_payload: {
      ...editable,
      title,
      description,
      category_name: template.category_name || editable.category_name || base.category || "",
      attributes,
      images,
      variants,
      ai_variant: aiVariant,
      source_raw: {
        ...(editable.source_raw || template.source_raw || {}),
        ai_variant: aiVariant
      }
    },
    title,
    description,
    attributes,
    images
  };
}

function buildListingDraftPayload(result = {}, template = {}) {
  const base = state.selectedBase || {};
  const target = resolveResultTarget(result);
  const editable = template.editable_payload || {};
  const sourceImages = normalizeImageList(template.images || editable.images || resultImages(result));
  const logistics = editable.logistics || {};
  const dimensions = editable.dimensions || {};
  const price = editable.price || {};
  return {
    template_id: template.id,
    product_name: result.title || template.title || editable.title || result.productName || "",
    internal_code: [base.brand || base.vehicle_brand, targetDisplayName(target), base.sourceId || base.id].filter(Boolean).join("-"),
    source_images: sourceImages,
    source_urls: base.raw?.url || base.raw?.product_url || base.raw?.source_url || "",
    cost_price: Number(base.raw?.cost_price || base.raw?.costPrice || base.purchase_cost || 0),
    sale_price: Number(price.value || base.raw?.sale_price || base.raw?.price || base.raw?.salePrice || base.sale_price_rmb || 0),
    length_cm: Number(dimensions.length_cm || base.raw?.length_cm || base.length_cm || 0),
    width_cm: Number(dimensions.width_cm || base.raw?.width_cm || base.width_cm || 0),
    height_cm: Number(dimensions.height_cm || base.raw?.height_cm || base.height_cm || 0),
    weight_g: Number(dimensions.weight_g || base.raw?.weight_g || base.package_weight_g || 0),
    color: base.color || logistics.color || "",
    spec: targetDisplayName(target) || logistics.spec || base.model || "",
    quantity: Number(logistics.quantity || base.quantity || base.raw?.quantity || 1),
    manual_facts: {
      ai_variant_result_id: result.id,
      source_template_snapshot: base.templateSnapshot || null,
      merged_template_snapshot: template,
      title: result.title,
      tags: result.tags,
      description: result.description,
      strategy: state.strategy,
      promptConfig: state.promptConfig
    }
  };
}

async function saveResultToListingDraft(result = {}) {
  if (result.listingDraftId && result.listingTemplateId) return result;
  const base = state.selectedBase || {};
  if (!base.templateSnapshot && base.source === "collector" && base.sourceId) {
    const prepared = await apiClient.post(
      `/api/listing/collector-box/${encodeURIComponent(base.sourceId)}/create-listing-template`,
      { compact: false }
    );
    const snapshot = prepared?.template || prepared?.template_snapshot || null;
    if (snapshot) base.templateSnapshot = normalizeTemplateSnapshot(snapshot, base);
  }
  const template = await apiClient.post("/api/listing/templates", mergeTemplateWithVariantResult(result));
  const draft = await apiClient.post("/api/listing/drafts", buildListingDraftPayload(result, template));
  result.listingTemplateId = template.id;
  result.listingDraftId = draft.id;
  result.writeBackStatus = "written_back";
  result.targetStatus = "written_back";
  result.writeBackText = `已保存上架草稿 #${draft.id}`;
  return result;
}

async function writeBackResult(result) {
  if (!result) return;
  if (result.writeBackStatus === "written_back") {
    ElMessage.warning("该裂变结果已保存为上架草稿");
    return;
  }
  writingBack.value = true;
  result.writeBackStatus = "writing";
  try {
    await saveResultToListingDraft(result);
    const target = state.targets.find((item) => item.id === result.targetId);
    const plan = state.mainImagePlans.find((item) => item.id === result.targetId);
    if (target) target.status = "written_back";
    if (plan) plan.status = "written_back";
    ElMessage.success("已保存上架草稿");
  } catch (error) {
    result.writeBackStatus = "failed";
    ElMessage.error(error.message || "保存上架草稿失败");
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
    ElMessage.warning("该裂变结果已保存为上架草稿");
    return;
  }
  writeBackDialog.rows = [buildWriteBackConfirmRow(result)];
  writeBackDialog.visible = true;
}

function requestWriteBackAll() {
  const rows = state.results.filter((item) => item.status !== "deleted" && item.writeBackStatus !== "written_back");
  if (!rows.length) {
    ElMessage.warning("没有可保存的生成结果，已保存结果不会重复保存");
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
  state.results = state.results.filter((item) => item.id !== id);
}

async function enterListing(targetRow = null) {
  const row = targetRow || state.results.find((item) => item.status !== "deleted" && item.listingTemplateId) || state.results.find((item) => item.status !== "deleted");
  if (!row) {
    ElMessage.warning("请先生成裂变结果");
    return;
  }
  if (!row.listingTemplateId) {
    writingBack.value = true;
    try {
      await saveResultToListingDraft(row);
    } catch (error) {
      ElMessage.error(error.message || "保存上架草稿失败");
      return;
    } finally {
      writingBack.value = false;
    }
  }
  window.location.hash = `/listing-automation?templateId=${encodeURIComponent(row.listingTemplateId)}`;
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

    <section class="source-toolbar">
      <div>
        <span>母商品数据源</span>
        <strong>{{ state.selectedBase?.name || "请先导入母商品" }}</strong>
        <em>{{ state.selectedBase ? `${sourceText(state.selectedBase.source)} · ${state.selectedBase.category || "-"} · ${state.selectedBase.sourceId || "-"}` : "与 AI 优化新版一致：采集箱 / 草稿箱 / 在线商品" }}</em>
      </div>
      <div>
        <el-button :icon="Search" @click="openImportDialog('collector')">从采集箱选择</el-button>
        <el-button :icon="Search" @click="openImportDialog('draft')">从草稿箱选择</el-button>
        <el-button :icon="Search" @click="openImportDialog('online')">从在线商品选择</el-button>
      </div>
    </section>

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

    <el-dialog v-model="importDialog.visible" :title="importDialogTitle" width="920px" align-center>
      <div class="import-dialog-body">
        <div class="import-toolbar">
          <el-input
            v-model="importDialog.keyword"
            clearable
            placeholder="按商品名、SKU、车型搜索"
            @keyup.enter="loadImportCandidates"
          />
          <el-button :icon="Search" :loading="importDialog.loading" @click="loadImportCandidates">查询</el-button>
          <el-button
            :disabled="!importDialog.rows.length"
            @click="importDialog.selectedIds = importDialog.rows.map((item) => item.id)"
          >
            全选本页
          </el-button>
        </div>
        <div class="import-list" v-loading="importDialog.loading">
          <button
            v-for="item in importDialog.rows"
            :key="item.id"
            type="button"
            class="import-row"
            :class="{ active: importDialog.selectedIds.includes(item.id) }"
            @click="toggleImportCandidate(item.id)"
          >
            <span class="check-dot">{{ importDialog.selectedIds.includes(item.id) ? "✓" : "" }}</span>
            <ProductImagePreview
              v-if="item.imageUrl"
              class="import-thumb"
              :src="item.imageUrl"
              fit="cover"
              size="portrait"
            />
            <span v-else class="visual" :class="item.tone">{{ visualText(item) }}</span>
            <span class="import-meta">
              <strong>{{ item.name }}</strong>
              <em>{{ sourceText(item.source) }} · {{ item.category }} · {{ item.sourceId || "-" }}</em>
              <small>{{ item.tags.join(" / ") }}</small>
            </span>
          </button>
          <el-empty v-if="!importDialog.loading && !importDialog.rows.length" description="暂无可选择记录" />
        </div>
      </div>
      <template #footer>
        <span class="import-footer-text">已选择 {{ importDialog.selectedIds.length }} 条记录</span>
        <el-button @click="importDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="confirmImport">导入选中记录</el-button>
      </template>
    </el-dialog>

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

    <el-dialog v-model="writeBackDialog.visible" title="确认保存上架草稿" width="1180px" align-center>
      <el-table :data="writeBackDialog.rows" border stripe max-height="520" class="writeback-confirm-table">
        <el-table-column label="是否保存" width="96" align="center">
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
        <el-button type="primary" :loading="writingBack" @click="confirmWriteBackRows">确认保存草稿</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.ai-variant-workbench {
  min-height: 100%;
  padding: 0 0 24px;
  background: linear-gradient(180deg, #f5f8fc 0%, #eef3f8 100%);
}

.source-toolbar {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin: 16px 16px 0;
  padding: 12px 14px;
  border: 1px solid #dbe5ef;
  border-radius: 10px;
  background: #fff;
}

.source-toolbar > div:first-child {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.source-toolbar span {
  color: #2563eb;
  font-size: 12px;
  font-weight: 800;
}

.source-toolbar strong {
  overflow: hidden;
  color: #0f172a;
  font-size: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-toolbar em {
  color: #64748b;
  font-size: 12px;
  font-style: normal;
}

.source-toolbar > div:last-child {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
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

.import-dialog-body {
  display: grid;
  gap: 12px;
}

.import-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
}

.import-list {
  max-height: 520px;
  overflow: auto;
  display: grid;
  gap: 8px;
  padding-right: 4px;
}

.import-row {
  display: grid;
  grid-template-columns: 18px 74px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 9px;
  text-align: left;
  border: 1px solid #dce5ef;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
}

.import-row.active {
  border-color: #2563eb;
  background: #eff6ff;
}

.check-dot {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border: 1px solid #93b7ee;
  border-radius: 50%;
  color: #2563eb;
  font-weight: 800;
}

.import-thumb {
  width: 74px;
  height: 82px;
}

.visual {
  white-space: pre-line;
  display: grid;
  place-items: center;
  text-align: center;
  border-radius: 7px;
  font-weight: 800;
  line-height: 1.25;
  width: 74px;
  height: 82px;
  font-size: 11px;
  color: #1e3a8a;
  background: linear-gradient(135deg, #dbeafe, #f8fafc);
}

.import-meta {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.import-meta strong {
  overflow: hidden;
  color: #0f172a;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-meta em,
.import-meta small,
.import-footer-text {
  color: #64748b;
  font-size: 12px;
  font-style: normal;
}

@media (max-width: 1280px) {
  .variant-board {
    grid-template-columns: 1fr;
  }

  .preview-column {
    position: static;
    max-height: none;
  }

  .source-toolbar,
  .import-toolbar {
    grid-template-columns: 1fr;
  }

  .source-toolbar {
    display: grid;
  }
}
</style>
