<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { InfoFilled, Plus, Search, UploadFilled } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import { uploadCropperImage, uploadListingMedia, withImageToken } from "../../api/tools/imageCropper";
import OzonCategorySelect from "../../components/listing/OzonCategorySelect.vue";

const loading = ref(false);
const searchingSku = ref(false);
const copyingSku = ref(false);
const creatingDraft = ref(false);
const generatingCopies = ref(false);
const uploadingImage = ref(false);
const loadingTemplate = ref(false);
const savingTemplate = ref(false);
const refreshingCopy = ref(false);
const aiGenerating = ref(false);
const validatingPublish = ref(false);
const publishingToOzon = ref(false);
const showMoreAttributes = ref(false);
const showApiDebug = ref(false);
const templateKeyword = ref("");
const selectedVariantRows = ref([]);
const importingCollected = ref(false);
const variantFieldMode = reactive({
  title: false,
  weight: false,
  dimensions: false,
  tags: false
});

const state = reactive({
  step: "copy",
  shops: [],
  templates: [],
  drafts: [],
  copies: [],
  copyJobs: [],
  selectedCopyJobId: null,
  selectedDraftId: null,
  searchedProduct: null
});

const copyForm = reactive({
  shop_id: "",
  sku: "3743961788",
  template_name: "",
  name: "",
  price: 1
});

const draftForm = reactive({
  template_id: "",
  product_name: "",
  internal_code: "",
  source_images: [],
  source_urls: "",
  cost_price: 0,
  sale_price: 0,
  length_cm: 0,
  width_cm: 0,
  height_cm: 0,
  weight_g: 0,
  color: "",
  spec: "",
  quantity: 0,
  shop_ids: []
});

const templateEditor = reactive({
  id: "",
  ozon_category_id: "",
  description_category_id: "",
  type_id: "",
  legacy_category_id: "",
  category_name: "",
  template_name: "",
  source_ozon_sku: "",
  title: "",
  description: "",
  price_value: 0,
  old_price: 0,
  currency_code: "RUB",
  vat: "0",
  length_cm: 0,
  width_cm: 0,
  height_cm: 0,
  weight_g: 0,
  color: "",
  spec: "",
  quantity: 0,
  attributes: [],
  images: [],
  variants: [],
  rawJson: "{}"
});

const attributeDrawer = reactive({
  visible: false,
  field: null
});

const collectedImport = reactive({
  visible: false,
  rawJson: "",
  template_name: "",
  ozon_category_id: "",
  category_name: ""
});

const publishValidation = reactive({
  visible: false,
  result: null
});

const publishSubmit = reactive({
  visible: false,
  result: null
});

const selectedTemplate = computed(() => state.templates.find((item) => Number(item.id) === Number(draftForm.template_id)) || null);
const selectedDraft = computed(() => state.drafts.find((item) => Number(item.id) === Number(state.selectedDraftId)) || null);
const readyCopyCount = computed(() => state.copies.filter((item) => item.validation?.level === "green").length);
const blockedCopyCount = computed(() => state.copies.filter((item) => item.validation?.level === "red").length);
const mainAttributeFields = computed(() => {
  if (showMoreAttributes.value) return hiddenAttributeFields.value;
  return hiddenAttributeFields.value.slice(0, 6);
});
const hiddenAttributeFields = computed(() => templateEditor.attributes
  .filter((item) => !fixedAttributeNames().some((name) => item.name.includes(name)))
  .slice()
  .sort((a, b) => Number(b.required) - Number(a.required) || Number(!hasAttributeValue(a)) - Number(!hasAttributeValue(b)) || Number(a.sort_order || 0) - Number(b.sort_order || 0)));
const hiddenAttributeCount = computed(() => Math.max(hiddenAttributeFields.value.length - mainAttributeFields.value.length, 0));
const missingRequiredAttributes = computed(() => templateEditor.attributes.filter((item) => item.required && !hasAttributeValue(item)));
const filledRequiredAttributeCount = computed(() => templateEditor.attributes.filter((item) => item.required && hasAttributeValue(item)).length);
const requiredAttributeCount = computed(() => templateEditor.attributes.filter((item) => item.required).length);
const templateHealthCards = computed(() => [
  {
    label: "Ozon后台类目",
    value: templateEditor.description_category_id && templateEditor.type_id ? "已带出" : "未带出",
    detail: templateEditor.description_category_id && templateEditor.type_id
      ? `${templateEditor.description_category_id}:${templateEditor.type_id}`
      : "需要Ozon详情或采集数据",
    tone: templateEditor.description_category_id && templateEditor.type_id ? "ok" : "warn"
  },
  {
    label: "必填属性",
    value: `${filledRequiredAttributeCount.value}/${requiredAttributeCount.value}`,
    detail: missingRequiredAttributes.value.length ? `缺 ${missingRequiredAttributes.value.length} 项` : "已填写",
    tone: missingRequiredAttributes.value.length ? "danger" : "ok"
  },
  {
    label: "富文本",
    value: fixedForm.value.richJson ? "已带入" : "未带入",
    detail: fixedForm.value.summary ? "简介可用" : "简介为空",
    tone: fixedForm.value.richJson || fixedForm.value.summary ? "ok" : "warn"
  },
  {
    label: "变体",
    value: `${templateEditor.variants.length} 个`,
    detail: templateEditor.variants.some((item) => item.images?.length) ? "含图片" : "缺图片",
    tone: templateEditor.variants.length ? "ok" : "warn"
  }
]);
const selectedCopyJob = computed(() => state.copyJobs.find((item) => Number(item.id) === Number(state.selectedCopyJobId)) || null);
const filteredTemplates = computed(() => {
  const keyword = String(templateKeyword.value || "").trim().toLowerCase();
  if (!keyword) return state.templates.slice(0, 8);
  return state.templates.filter((item) => {
    return [item.template_name, item.category_name, item.source_ozon_sku, item.title]
      .some((value) => String(value || "").toLowerCase().includes(keyword));
  }).slice(0, 12);
});

async function loadAll() {
  loading.value = true;
  try {
    const [shops, templates, drafts, copyJobs] = await Promise.all([
      apiClient.get("/api/shops", { noCache: true }),
      apiClient.get("/api/listing/templates", { noCache: true }).catch(handleListingApiMissing),
      apiClient.get("/api/listing/drafts", { noCache: true }).catch(handleListingApiMissing),
      apiClient.get("/api/listing/copy-jobs", { noCache: true }).catch(handleListingApiMissing)
    ]);
    state.shops = Array.isArray(shops) ? shops.filter((shop) => shop.status !== "deleted") : [];
    state.templates = Array.isArray(templates) ? templates : [];
    state.drafts = Array.isArray(drafts) ? drafts : [];
    state.copyJobs = Array.isArray(copyJobs) ? copyJobs : [];
    if (!copyForm.shop_id && state.shops[0]) copyForm.shop_id = state.shops[0].id;
    if (!state.selectedCopyJobId && state.copyJobs[0]) state.selectedCopyJobId = state.copyJobs[0].id;
  } finally {
    loading.value = false;
  }
}

function handleListingApiMissing(error) {
  if (error?.status === 404) {
    ElMessage.error("编辑上架后端接口未生效，请重启/重新部署服务端进程");
    return [];
  }
  throw error;
}

async function searchSku() {
  const sku = String(copyForm.sku || "").trim();
  if (!sku) {
    ElMessage.warning("请输入 Ozon 前台 SKU");
    return;
  }
  searchingSku.value = true;
  try {
    state.searchedProduct = {
      sku,
      name: sku === "3743961788" ? "Чехол брелка автосигнализации, 1 шт." : `Ozon SKU ${sku}`,
      category: sku === "3743961788" ? "汽车防盗器遥控器套" : "等待复制后从 Ozon 带出类目",
      rating: sku === "3743961788" ? "4.8" : "",
      note: "点击添加后，系统会调用店铺 API 复制商品卡，并把返回结构保存为本地模板。"
    };
    copyForm.template_name = copyForm.template_name || `SKU ${sku} 模板`;
    copyForm.name = copyForm.name || state.searchedProduct.name;
  } finally {
    searchingSku.value = false;
  }
}

async function addCopiedProduct() {
  if (!state.searchedProduct) await searchSku();
  if (!copyForm.shop_id) {
    ElMessage.warning("请选择用于复制的店铺");
    return;
  }
  if (!String(copyForm.template_name || "").trim()) {
    ElMessage.warning("请先填写本地模板名称");
    return;
  }
  copyingSku.value = true;
  try {
    const result = await apiClient.post("/api/listing/copy-from-sku", {
      shop_id: copyForm.shop_id,
      sku: copyForm.sku,
      template_name: copyForm.template_name,
      name: copyForm.name || state.searchedProduct?.name,
      price: copyForm.price
    }).catch((error) => {
      if (error?.status === 404) {
        throw new Error("编辑上架后端接口未生效，请重启/重新部署服务端进程");
      }
      throw error;
    });
    if (result.template) {
      state.templates = [result.template, ...state.templates.filter((item) => Number(item.id) !== Number(result.template.id))];
      await selectTemplate(result.template);
    }
    if (result.job?.id) state.selectedCopyJobId = result.job.id;
    if (result.job) state.copyJobs = [result.job, ...state.copyJobs.filter((item) => Number(item.id) !== Number(result.job.id))];
    draftForm.product_name = state.searchedProduct?.name || copyForm.name || "";
    draftForm.sale_price = Number(copyForm.price || 0);
    ElMessage.success(result.reused ? "已更新已有 SKU 模板" : "已添加模板，下面可以直接编辑");
    if (result.job?.id) await refreshCopyResultUntilReady(result.job.id).catch(() => {});
  } finally {
    copyingSku.value = false;
  }
}

async function refreshCopyResultUntilReady(jobId) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await delay(1600 + attempt * 900);
    const result = await refreshCopyResult(jobId, { silent: true, returnResult: true });
    const status = String(result?.job?.status || "").toLowerCase();
    const hasTemplateData = Boolean(result?.template?.editable_payload?.description_category_id || result?.template?.category_attributes?.length);
    if (status === "template_synced" || hasTemplateData) {
      ElMessage.success("已同步 Ozon 类目、属性和变体信息");
      return result;
    }
  }
  ElMessage.info("Ozon 复制任务还在处理中，稍后点刷新可继续回填");
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshCopyResult(jobId = state.selectedCopyJobId, options = {}) {
  if (!jobId) {
    ElMessage.warning("请先添加复制商品");
    return;
  }
  refreshingCopy.value = true;
  try {
    const result = await apiClient.post(`/api/listing/copy-jobs/${jobId}/refresh`, {});
    if (result.job) {
      state.copyJobs = [result.job, ...state.copyJobs.filter((item) => Number(item.id) !== Number(result.job.id))];
      state.selectedCopyJobId = result.job.id;
    }
    if (result.template) {
      state.templates = [result.template, ...state.templates.filter((item) => Number(item.id) !== Number(result.template.id))];
      await selectTemplate(result.template);
      if (!options.silent) ElMessage.success("已刷新 Ozon 复制结果并回填模板");
    } else if (!options.silent) {
      ElMessage.info("Ozon 复制任务还在处理中，稍后再刷新");
    }
    if (options.returnResult) return result;
  } finally {
    refreshingCopy.value = false;
  }
}

function copyJobType(job) {
  if (!job) return "info";
  if (job.status === "template_synced") return "success";
  if (String(job.status || "").includes("fail")) return "danger";
  if (job.detail_error) return "warning";
  if (job.status === "imported") return "warning";
  return "info";
}

function copyJobStatusText(job) {
  if (!job) return "未创建";
  if (job.status === "template_synced") return "已回填模板";
  if (job.status === "imported") return "复制成功，待回填详情";
  if (job.detail_error) return "详情回填失败";
  if (job.status === "submitted") return "Ozon处理中";
  return job.status || "未知";
}

function prettyJson(value) {
  try {
    return JSON.stringify(value || {}, null, 2);
  } catch {
    return "{}";
  }
}

function selectAllShops() {
  draftForm.shop_ids = state.shops.filter((shop) => shop.status !== "deleted").map((shop) => shop.id);
}

function clearSelectedShops() {
  draftForm.shop_ids = [];
}

async function handleOzonCategorySelected(category) {
  if (!category) return;
  templateEditor.ozon_category_id = category.ozon_category_id || `${category.description_category_id}:${category.type_id}`;
  templateEditor.description_category_id = category.description_category_id || category.descriptionCategoryId || "";
  templateEditor.type_id = category.type_id || category.typeId || "";
  templateEditor.category_name = category.label || category.name_zh || category.name_ru || "";
  await syncSelectedCategoryAttributes();
}

async function syncSelectedCategoryAttributes() {
  if (!templateEditor.description_category_id || !templateEditor.type_id) {
    ElMessage.warning("请先选择 Ozon 真实类目");
    return;
  }
  loadingTemplate.value = true;
  try {
    const result = await apiClient.post("/api/listing/ozon-category-attributes/sync", {
      shop_id: copyForm.shop_id || undefined,
      description_category_id: templateEditor.description_category_id,
      type_id: templateEditor.type_id,
      language: "ZH_HANS"
    });
    mergeOzonCategoryAttributes(result.attributes || []);
    ElMessage.success(`已同步 ${result.saved || 0} 个类目属性`);
  } finally {
    loadingTemplate.value = false;
  }
}

function mergeOzonCategoryAttributes(schemaAttrs = []) {
  const currentById = new Map(templateEditor.attributes.map((item) => [String(item.attribute_id || ""), item]).filter(([key]) => key));
  const currentByName = new Map(templateEditor.attributes.map((item) => [String(item.name || "").trim(), item]).filter(([key]) => key));
  const merged = normalizeEditorAttributes(schemaAttrs).map((schema) => {
    const existing = currentById.get(String(schema.attribute_id || "")) || currentByName.get(String(schema.name || "").trim());
    return {
      ...schema,
      value: existing?.value ?? "",
      values: existing?.values?.length ? existing.values : schema.values,
      source: existing?.source && existing.source !== "manual" ? existing.source : schema.source
    };
  });
  const extras = templateEditor.attributes.filter((item) => {
    if (item.attribute_id && merged.some((schema) => String(schema.attribute_id) === String(item.attribute_id))) return false;
    if (item.name && merged.some((schema) => String(schema.name).trim() === String(item.name).trim())) return false;
    return item.value || item.name;
  });
  templateEditor.attributes = [...merged, ...extras];
}

async function selectTemplate(template) {
  if (!template?.id) return;
  loadingTemplate.value = true;
  try {
    const detail = await apiClient.get(`/api/listing/templates/${template.id}`, { noCache: true });
    fillTemplateEditor(detail);
    draftForm.template_id = detail.id;
  } finally {
    loadingTemplate.value = false;
  }
}

function newBlankTemplate() {
  Object.assign(templateEditor, {
    id: "",
    ozon_category_id: "",
    description_category_id: "",
    type_id: "",
    legacy_category_id: "",
    category_name: "",
    template_name: "",
    source_ozon_sku: "",
    title: "",
    description: "",
    price_value: 0,
    old_price: 0,
    currency_code: "RUB",
    vat: "0",
    length_cm: 0,
    width_cm: 0,
    height_cm: 0,
    weight_g: 0,
    color: "",
    spec: "",
    quantity: 0,
    attributes: normalizeEditorAttributes([
      { name: "品牌", value: "无品牌", required: true, source: "fixed_form" },
      { name: "型号名称", value: "", required: true, source: "fixed_form" },
      { name: "产品标签", value: "", required: false, source: "fixed_form" },
      { name: "简介", value: "", required: false, source: "fixed_form" },
      { name: "JSON富内容", value: "", required: false, source: "fixed_form" }
    ]),
    images: [],
    variants: [],
    rawJson: "{}"
  });
  draftForm.template_id = "";
}

function openCollectedImport() {
  collectedImport.visible = true;
  collectedImport.rawJson = "";
  collectedImport.template_name = "";
  collectedImport.ozon_category_id = templateEditor.ozon_category_id || "";
  collectedImport.category_name = templateEditor.category_name || "";
}

async function importCollectedProductJson() {
  let parsed;
  try {
    parsed = JSON.parse(collectedImport.rawJson || "{}");
  } catch {
    ElMessage.error("采集 JSON 格式不正确");
    return;
  }
  importingCollected.value = true;
  try {
    const result = await apiClient.post("/api/listing/templates/from-collected", {
      ...parsed,
      template_name: collectedImport.template_name || parsed.template_name || parsed.local_template_name,
      ozon_category_id: collectedImport.ozon_category_id || parsed.ozon_category_id || parsed.description_category_id,
      category_name: collectedImport.category_name || parsed.category_name || parsed.category
    });
    if (result.template) {
      state.templates = [result.template, ...state.templates.filter((item) => Number(item.id) !== Number(result.template.id))];
      await selectTemplate(result.template);
    }
    collectedImport.visible = false;
    ElMessage.success(result.reused ? "已用采集数据更新模板" : "已从采集数据创建模板");
  } finally {
    importingCollected.value = false;
  }
}

function fillTemplateEditor(template) {
  const editable = template.editable_payload || {};
  const price = editable.price || {};
  const dimensions = editable.dimensions || {};
  const logistics = editable.logistics || {};
  const attrs = normalizeEditorAttributes(template.attributes || editable.attributes || []);
  templateEditor.id = template.id || "";
  templateEditor.ozon_category_id = template.ozon_category_id || "";
  templateEditor.description_category_id = editable.description_category_id || "";
  templateEditor.type_id = editable.type_id || "";
  templateEditor.legacy_category_id = editable.legacy_category_id || "";
  templateEditor.category_name = template.category_name || editable.category_name || "";
  templateEditor.template_name = template.template_name || "";
  templateEditor.source_ozon_sku = template.source_ozon_sku || editable.sku || "";
  templateEditor.title = template.title || editable.title || template.template_name || "";
  templateEditor.description = template.description || editable.description || "";
  templateEditor.price_value = Number(price.value || 0);
  templateEditor.old_price = Number(price.old_price || 0);
  templateEditor.currency_code = price.currency_code || "RUB";
  templateEditor.vat = price.vat || "0";
  templateEditor.length_cm = Number(dimensions.length_cm || 0);
  templateEditor.width_cm = Number(dimensions.width_cm || 0);
  templateEditor.height_cm = Number(dimensions.height_cm || 0);
  templateEditor.weight_g = Number(dimensions.weight_g || 0);
  templateEditor.color = logistics.color || "";
  templateEditor.spec = logistics.spec || "";
  templateEditor.quantity = Number(logistics.quantity || 0);
  templateEditor.attributes = attrs;
  applyTemplateAttributeFallbacks(editable, logistics);
  templateEditor.images = normalizeEditorImages(template.images || editable.images || []);
  templateEditor.variants = normalizeEditorVariants(editable.variants || template.variants || []);
  if (!templateEditor.variants.length && (templateEditor.title || templateEditor.images.length)) addVariantRow();
  templateEditor.rawJson = JSON.stringify(template.source_raw || editable.source_raw || editable.raw_request || {}, null, 2);
}

function applyTemplateAttributeFallbacks(editable = {}, logistics = {}) {
  const summary = getAttributeByNames(["简介", "Аннотация", "Описание"], templateEditor.description || editable.description || "");
  const richJson = editable.rich_content_json || getAttributeByNames(["JSON富内容", "Rich", "rich"], "");
  const brand = logistics.brand || getAttributeByNames(["品牌", "Бренд"], "");
  const model = logistics.spec || getAttributeByNames(["型号", "Модель"], "");
  const tags = logistics.tags?.length ? logistics.tags : splitTagValue(getAttributeByNames(["产品标签", "主图标签", "ключевые слова", "тег"], ""));
  if (summary && !templateEditor.description) templateEditor.description = summary;
  if (brand) setAttributeByNames(["品牌", "Бренд"], brand, { name: "品牌", required: true });
  if (model) {
    templateEditor.spec = templateEditor.spec || model;
    setAttributeByNames(["型号", "Модель"], model, { name: "型号名称", required: true });
  }
  if (tags.length) setAttributeByNames(["产品标签", "主图标签", "ключевые слова", "тег"], tags.join(","), { name: "产品标签" });
  if (summary) setAttributeByNames(["简介", "Аннотация", "Описание"], summary, { name: "简介" });
  if (richJson) setAttributeByNames(["JSON富内容", "Rich", "rich"], richJson, { name: "JSON富内容" });
}

function normalizeEditorAttributes(attributes) {
  return (Array.isArray(attributes) ? attributes : []).map((item, index) => ({
    name: item?.name || "",
    value: item?.value || "",
    type: normalizeAttributeType(item),
    required: Boolean(item?.required || item?.is_required),
    attribute_id: item?.attribute_id || "",
    dictionary_id: item?.dictionary_id || "",
    is_collection: Boolean(item?.is_collection),
    group: item?.group || "",
    hint: item?.hint || "",
    source: item?.source || "ozon_copy",
    values: Array.isArray(item?.values) ? item.values : [],
    raw: item?.raw || item,
    sort_order: Number(item?.sort_order || index + 1)
  }));
}

function fixedAttributeNames() {
  return ["标题", "品牌", "包装重量", "包装尺寸", "重量", "尺寸", "型号", "产品标签", "主图标签", "简介", "JSON富内容", "颜色"];
}

function getAttributeByNames(names, fallback = "") {
  const list = Array.isArray(names) ? names : [names];
  return templateEditor.attributes.find((item) => list.some((name) => String(item.name || "").includes(name)))?.value || fallback;
}

function setAttributeByNames(names, value, defaults = {}) {
  const list = Array.isArray(names) ? names : [names];
  const existing = templateEditor.attributes.find((item) => list.some((name) => String(item.name || "").includes(name)));
  if (existing) {
    existing.value = value;
    return;
  }
  templateEditor.attributes.push({
    name: defaults.name || list[0],
    value,
    type: defaults.type || "text",
    required: Boolean(defaults.required),
    values: defaults.values || [],
    source: "fixed_form",
    sort_order: templateEditor.attributes.length + 1
  });
}

const fixedForm = computed({
  get() {
    return {
      brand: getAttributeByNames(["品牌", "Бренд"], "无品牌"),
      model: getAttributeByNames(["型号", "Модель"], ""),
      tags: splitTagValue(getAttributeByNames(["产品标签", "主图标签", "ключевые слова", "тег"], "")),
      summary: getAttributeByNames(["简介", "Аннотация", "Описание"], ""),
      richJson: getAttributeByNames(["JSON富内容", "Rich", "rich"], "")
    };
  },
  set(value) {
    setAttributeByNames(["品牌", "Бренд"], value.brand, { name: "品牌", required: true });
    setAttributeByNames(["型号", "Модель"], value.model, { name: "型号名称", required: true });
    setAttributeByNames(["产品标签", "主图标签", "ключевые слова", "тег"], (value.tags || []).join(","), { name: "产品标签" });
    setAttributeByNames(["简介", "Аннотация", "Описание"], value.summary, { name: "简介" });
    setAttributeByNames(["JSON富内容", "Rich", "rich"], value.richJson, { name: "JSON富内容" });
  }
});

function splitTagValue(value) {
  if (Array.isArray(value)) return value;
  return String(value || "").split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean);
}

function updateFixedField(key, value) {
  fixedForm.value = { ...fixedForm.value, [key]: value };
}

function normalizeAttributeType(item) {
  if (item?.is_collection) return "multiselect";
  const type = String(item?.type || "").toLowerCase();
  if (["select", "multiselect", "textarea", "number", "boolean"].includes(type)) return type;
  if (Array.isArray(item?.values) && item.values.length) return "select";
  return "text";
}

function normalizeEditorImages(images) {
  return (Array.isArray(images) ? images : []).map((item, index) => ({
    url: item?.url || "",
    name: item?.name || "",
    sort_order: Number(item?.sort_order || index + 1)
  }));
}

function normalizeEditorVariants(variants) {
  return (Array.isArray(variants) ? variants : []).map((item, index) => ({
    id: item?.id || `variant-${Date.now().toString(36)}-${index}`,
    sku: item?.sku || item?.source_sku || "",
    source_sku: item?.source_sku || item?.sku || "",
    source_offer_id: item?.source_offer_id || item?.seller_offer_id || "",
    offer_id: item?.offer_id || "",
    name: item?.name || item?.title || templateEditor.title || "",
    title: item?.title || item?.name || templateEditor.title || "",
    images: normalizeEditorImages(item?.images || (item?.primary_image ? [item.primary_image].concat(item?.images || []) : [])),
    video_cover_urls: normalizeVariantLinks(item?.video_cover_urls || item?.cover_video_urls || item?.cover_video || ""),
    video_urls: normalizeVariantLinks(item?.video_urls || item?.videos || item?.video_url || ""),
    barcode: item?.barcode || "",
    cost_price: Number(item?.cost_price || 0),
    price: Number(item?.price || 0),
    old_price: Number(item?.old_price || 0),
    color: item?.color || "",
    spec: item?.spec || "",
    main_tags: splitTagValue(item?.main_tags || item?.hashtags || item?.tags || ""),
    weight_g: Number(item?.weight_g || templateEditor.weight_g || 0),
    length_mm: Number(item?.length_mm || item?.depth || item?.length_cm || templateEditor.length_cm || 0),
    width_mm: Number(item?.width_mm || item?.width || item?.width_cm || templateEditor.width_cm || 0),
    height_mm: Number(item?.height_mm || item?.height || item?.height_cm || templateEditor.height_cm || 0),
    stock: Number(item?.stock || 0),
    dynamic_attributes: item?.dynamic_attributes || {},
    sort_order: Number(item?.sort_order || index + 1)
  }));
}

function normalizeVariantLinks(value) {
  if (Array.isArray(value)) return value.map((item) => String(item?.url || item || "").trim()).filter(Boolean);
  return String(value || "").split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

function addAttributeRow() {
  templateEditor.attributes.push({ name: "", value: "", type: "text", required: false, attribute_id: "", values: [], source: "manual", sort_order: templateEditor.attributes.length + 1 });
}

function removeAttributeRow(index) {
  templateEditor.attributes.splice(index, 1);
}

function addTemplateImageRow() {
  templateEditor.images.push({ url: "", name: "", sort_order: templateEditor.images.length + 1 });
}

function removeTemplateImageRow(index) {
  templateEditor.images.splice(index, 1);
}

async function uploadTemplateImagesRequest(options) {
  await uploadMediaIntoList(options, templateEditor.images, "image");
}

function uploadVariantImagesRequest(row) {
  return (options) => uploadMediaIntoList(options, row.images, "image");
}

function uploadVariantVideoRequest(row, field, expectedType = "video") {
  return (options) => uploadMediaIntoLinks(options, row[field], expectedType);
}

async function uploadMediaIntoList(options, targetList, expectedType) {
  try {
    uploadingImage.value = true;
    const result = await uploadListingMedia(options.file);
    if (expectedType && result.mediaType !== expectedType) throw new Error(expectedType === "image" ? "请上传图片文件" : "请上传视频文件");
    targetList.push({
      url: result.publishUrl || result.url || result.previewUrl,
      previewUrl: result.previewUrl || result.url,
      name: result.name || options.file?.name || "",
      sort_order: targetList.length + 1
    });
    options.onSuccess?.(result);
    ElMessage.success("素材已上传");
  } catch (error) {
    options.onError?.(error);
    ElMessage.error(error.message || "素材上传失败");
  } finally {
    uploadingImage.value = false;
  }
}

async function uploadMediaIntoLinks(options, targetList, expectedType) {
  try {
    uploadingImage.value = true;
    const result = await uploadListingMedia(options.file);
    if (expectedType && result.mediaType !== expectedType) throw new Error(expectedType === "image" ? "请上传图片文件" : "请上传视频文件");
    targetList.push(result.publishUrl || result.url || result.previewUrl);
    options.onSuccess?.(result);
    ElMessage.success("素材已上传");
  } catch (error) {
    options.onError?.(error);
    ElMessage.error(error.message || "素材上传失败");
  } finally {
    uploadingImage.value = false;
  }
}

function useTemplateImagesForAllVariants() {
  const images = templateEditor.images.filter((item) => item.url).slice(0, 15);
  if (!images.length) {
    ElMessage.warning("请先上传模板图片");
    return;
  }
  templateEditor.variants.forEach((row) => {
    row.images = images.map((item) => ({ ...item }));
  });
  ElMessage.success("已把模板图片同步到全部变体");
}

function addVariantRow() {
  templateEditor.variants.push({
    id: `variant-${Date.now().toString(36)}-${templateEditor.variants.length}`,
    sku: "",
    source_sku: "",
    source_offer_id: "",
    offer_id: "",
    name: templateEditor.title || "",
    title: templateEditor.title || "",
    images: templateEditor.images.slice(0, 6),
    video_cover_urls: [],
    video_urls: [],
    barcode: "",
    cost_price: 0,
    price: Number(templateEditor.price_value || 0),
    old_price: Number(templateEditor.old_price || 0),
    color: templateEditor.color || "",
    spec: templateEditor.spec || "",
    main_tags: fixedForm.value.tags || [],
    weight_g: Number(templateEditor.weight_g || 0),
    length_mm: Number(templateEditor.length_cm || 0),
    width_mm: Number(templateEditor.width_cm || 0),
    height_mm: Number(templateEditor.height_cm || 0),
    stock: Number(templateEditor.quantity || 0),
    dynamic_attributes: {},
    sort_order: templateEditor.variants.length + 1
  });
}

function removeVariantRow(index) {
  templateEditor.variants.splice(index, 1);
}

function duplicateVariantRow(row) {
  const index = templateEditor.variants.findIndex((item) => item.id === row.id);
  const copy = {
    ...row,
    id: `variant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    sku: "",
    offer_id: "",
    name: row.name ? `${row.name} 副本` : templateEditor.title || "",
    title: row.title ? `${row.title} 副本` : templateEditor.title || "",
    images: Array.isArray(row.images) ? row.images.map((item) => ({ ...item })) : [],
    video_cover_urls: Array.isArray(row.video_cover_urls) ? row.video_cover_urls.slice() : [],
    video_urls: Array.isArray(row.video_urls) ? row.video_urls.slice() : [],
    main_tags: Array.isArray(row.main_tags) ? row.main_tags.slice() : []
  };
  if (index >= 0) templateEditor.variants.splice(index + 1, 0, copy);
  else templateEditor.variants.push(copy);
}

function handleVariantSelectionChange(rows) {
  selectedVariantRows.value = rows || [];
}

function removeSelectedVariants() {
  const selectedIds = new Set(selectedVariantRows.value.map((row) => row.id));
  if (!selectedIds.size) {
    ElMessage.warning("请先选择要删除的变体");
    return;
  }
  templateEditor.variants = templateEditor.variants.filter((row) => !selectedIds.has(row.id));
  selectedVariantRows.value = [];
}

function applyFirstVariantField(field) {
  const first = templateEditor.variants[0];
  if (!first) return;
  const value = cloneVariantValue(first[field]);
  templateEditor.variants.forEach((row, index) => {
    if (index === 0) return;
    row[field] = cloneVariantValue(value);
  });
  ElMessage.success("已同步首行内容");
}

function enableVariantField(field) {
  variantFieldMode[field] = true;
  if (field === "title") {
    templateEditor.variants.forEach((row) => {
      row.title = row.title || templateEditor.title;
    });
  } else if (field === "weight") {
    templateEditor.variants.forEach((row) => {
      row.weight_g = Number(row.weight_g || templateEditor.weight_g || 0);
    });
  } else if (field === "dimensions") {
    templateEditor.variants.forEach((row) => {
      row.length_mm = Number(row.length_mm || templateEditor.length_cm || 0);
      row.width_mm = Number(row.width_mm || templateEditor.width_cm || 0);
      row.height_mm = Number(row.height_mm || templateEditor.height_cm || 0);
    });
  } else if (field === "tags") {
    templateEditor.variants.forEach((row) => {
      row.main_tags = Array.isArray(row.main_tags) && row.main_tags.length ? row.main_tags : fixedForm.value.tags.slice();
    });
  }
}

function cloneVariantValue(value) {
  if (Array.isArray(value)) return value.map((item) => (item && typeof item === "object" ? { ...item } : item));
  if (value && typeof value === "object") return { ...value };
  return value;
}

function variantPreviewImages(row) {
  const images = Array.isArray(row?.images) && row.images.length ? row.images : templateEditor.images;
  return images.filter((item) => item?.url).slice(0, 3);
}

function variantImageOverflow(row) {
  const images = Array.isArray(row?.images) && row.images.length ? row.images : templateEditor.images;
  return Math.max(images.filter((item) => item?.url).length - 3, 0);
}

function variantLinkText(value) {
  return Array.isArray(value) ? value.join("\n") : String(value || "");
}

function openAttributeDetail(field) {
  attributeDrawer.field = field;
  attributeDrawer.visible = true;
}

function hasAttributeValue(field) {
  if (Array.isArray(field.value)) return field.value.length > 0;
  return String(field.value ?? "").trim() !== "";
}

function attributeStatusType(field) {
  if (field.required && !hasAttributeValue(field)) return "danger";
  if (field.required) return "success";
  return "info";
}

function attributeStatusText(field) {
  if (field.required && !hasAttributeValue(field)) return "缺失";
  if (field.required) return "必填";
  return "可选";
}

function runFieldAiPlaceholder(field) {
  ElMessage.info(`${field.name || "当前字段"} 的 AI 自动填写会在 AI 配置完成后启用`);
}

async function runFieldAi(field = {}) {
  if (!templateEditor.id) {
    ElMessage.warning("请先选择或复制一个上架模板");
    return;
  }
  aiGenerating.value = true;
  try {
    const result = await apiClient.post("/api/ai-provider/chat", {
      temperature: 0.25,
      messages: [
        { role: "system", content: "你只返回一个有效 JSON 对象，不要 Markdown，不要解释，不要寒暄。" },
        { role: "user", content: buildListingAiPrompt(field) }
      ]
    });
    const generated = parseAiJson(result.content);
    applyListingAiResult(generated, field);
    ElMessage.success("AI 已回填上架文案");
  } catch (error) {
    ElMessage.error(error.message || "AI 生成失败，请检查 AI 配置");
  } finally {
    aiGenerating.value = false;
  }
}

function buildListingAiPrompt(field = {}) {
  const context = {
    targetField: field.name || "all",
    marketplace: "Ozon Russia",
    language: "Russian",
    category: templateEditor.category_name,
    sourceTitle: templateEditor.title,
    brand: fixedForm.value.brand,
    model: fixedForm.value.model,
    tags: fixedForm.value.tags,
    description: fixedForm.value.summary || templateEditor.description,
    dimensionsMm: {
      length: Number(templateEditor.length_cm || 0),
      width: Number(templateEditor.width_cm || 0),
      height: Number(templateEditor.height_cm || 0),
      weightG: Number(templateEditor.weight_g || 0)
    },
    variants: templateEditor.variants.slice(0, 12).map((item) => ({
      sku: item.sku,
      name: item.name,
      color: item.color,
      price: item.price,
      cost: item.cost_price
    })),
    attributes: templateEditor.attributes.slice(0, 60).map((item) => ({
      name: item.name,
      value: item.value,
      required: item.required
    }))
  };
  return [
    "你是俄罗斯 Ozon 电商上架运营助手。请基于商品信息生成可直接回填的上架字段。",
    "必须只返回 JSON，不要 Markdown，不要解释。",
    "俄文内容要自然、适合 Ozon；不要虚构品牌；无品牌时使用 Нет бренда。",
    "标题包含品类、用途、数量或关键规格，避免堆砌关键词。",
    "主题标签返回 8-14 个俄文标签，带 #，避免重复。",
    "简介返回 2-4 句俄文营销描述。",
    "richJson 返回一个 JSON 字符串，可包含 blocks 数组，每个 block 有 title/text。",
    JSON.stringify({
      title: "string",
      model: "string",
      tags: ["#tag"],
      summary: "string",
      richJson: "{\"blocks\":[{\"title\":\"\",\"text\":\"\"}]}",
      variants: [{ sku: "string", name: "string", color: "string" }]
    }),
    "商品上下文：",
    JSON.stringify(context)
  ].join("\n");
}

function parseAiJson(content) {
  const raw = String(content || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("AI 返回内容不是有效 JSON，请重试");
  }
}

function applyListingAiResult(result = {}, field = {}) {
  const fieldName = String(field.name || "");
  const applyAll = !fieldName || fieldName === "all";
  if ((applyAll || fieldName.includes("标题") || fieldName.includes("鏍囬")) && result.title) {
    templateEditor.title = String(result.title).trim();
  }
  if ((applyAll || fieldName.includes("型号") || fieldName.includes("鍨嬪")) && result.model) {
    updateFixedField("model", String(result.model).trim());
  }
  if ((applyAll || fieldName.includes("标签") || fieldName.includes("鏍囩")) && Array.isArray(result.tags)) {
    updateFixedField("tags", result.tags.map((item) => String(item || "").trim()).filter(Boolean));
  }
  if ((applyAll || fieldName.includes("简介") || fieldName.includes("绠€")) && result.summary) {
    updateFixedField("summary", String(result.summary).trim());
    templateEditor.description = String(result.summary).trim();
  }
  if ((applyAll || fieldName.includes("JSON")) && result.richJson) {
    updateFixedField("richJson", typeof result.richJson === "string" ? result.richJson : JSON.stringify(result.richJson, null, 2));
  }
  if (applyAll && Array.isArray(result.variants) && result.variants.length) {
    const bySku = new Map(templateEditor.variants.map((item) => [String(item.sku || ""), item]));
    for (const item of result.variants) {
      const row = bySku.get(String(item.sku || ""));
      if (!row) continue;
      if (item.name) row.name = String(item.name);
      if (item.color) row.color = String(item.color);
    }
  }
}

async function saveTemplateEditor() {
  if (!String(templateEditor.ozon_category_id || "").trim() || !String(templateEditor.category_name || "").trim()) {
    ElMessage.warning("请先填写 Ozon 类目 ID 和产品类目");
    return;
  }
  if (!String(templateEditor.template_name || "").trim()) {
    ElMessage.warning("请先填写本地模板名称");
    return;
  }
  savingTemplate.value = true;
  try {
    const payload = buildTemplatePayload();
    const creating = !templateEditor.id;
    const saved = templateEditor.id
      ? await apiClient.put(`/api/listing/templates/${templateEditor.id}`, payload)
      : await apiClient.post("/api/listing/templates", payload);
    fillTemplateEditor(saved);
    state.templates = [saved, ...state.templates.filter((item) => Number(item.id) !== Number(saved.id))];
    draftForm.template_id = saved.id;
    ElMessage.success(creating ? "新模板已创建" : "模板已保存");
  } finally {
    savingTemplate.value = false;
  }
}

async function validatePublishPayload() {
  validatingPublish.value = true;
  try {
    const payload = buildTemplatePayload();
    const result = await apiClient.post("/api/listing/templates/validate-publish", payload);
    publishValidation.result = result;
    publishValidation.visible = true;
    if (result.ok) ElMessage.success("当前模板已通过基础发布校验");
    else ElMessage.warning(`还有 ${result.errors?.length || 0} 个阻断项需要处理`);
  } finally {
    validatingPublish.value = false;
  }
}

async function publishTemplateToOzon() {
  if (!draftForm.shop_ids.length) {
    ElMessage.warning("请先选择要上架的店铺");
    return;
  }
  await ElMessageBox.confirm(
    "系统会按当前模板向已选店铺提交 Ozon /v3/product/import。提交前会再次校验类目、必填属性、图片和价格。",
    "确认正式提交 Ozon",
    { type: "warning", confirmButtonText: "提交", cancelButtonText: "取消" }
  );
  publishingToOzon.value = true;
  try {
    const template = buildTemplatePayload();
    const result = await apiClient.post("/api/listing/templates/publish-to-ozon", {
      template,
      shop_ids: draftForm.shop_ids
    });
    publishSubmit.result = result;
    publishSubmit.visible = true;
    if (result.ok) ElMessage.success("已提交到 Ozon，等待 import/info 返回最终结果");
    else ElMessage.warning("Ozon 提交未成功，请查看返回结果");
  } catch (error) {
    const validation = error?.validation || error?.payload?.validation;
    if (validation) {
      publishValidation.result = validation;
      publishValidation.visible = true;
    }
    ElMessage.error(error.message || "提交 Ozon 失败");
  } finally {
    publishingToOzon.value = false;
  }
}

function buildTemplatePayload() {
  let sourceRaw = {};
  try {
    sourceRaw = JSON.parse(templateEditor.rawJson || "{}");
  } catch {
    sourceRaw = {};
  }
  const images = templateEditor.images.filter((item) => item.url);
  const attributes = templateEditor.attributes.filter((item) => item.name || item.value);
  const variants = templateEditor.variants
    .filter((item) => item.sku || item.name)
    .map((item) => ({
      ...item,
      title: variantFieldMode.title ? item.title : templateEditor.title,
      weight_g: variantFieldMode.weight ? item.weight_g : Number(templateEditor.weight_g || 0),
      length_mm: variantFieldMode.dimensions ? item.length_mm : Number(templateEditor.length_cm || 0),
      width_mm: variantFieldMode.dimensions ? item.width_mm : Number(templateEditor.width_cm || 0),
      height_mm: variantFieldMode.dimensions ? item.height_mm : Number(templateEditor.height_cm || 0),
      main_tags: variantFieldMode.tags ? item.main_tags : fixedForm.value.tags
    }));
  return {
    ozon_category_id: templateEditor.ozon_category_id,
    category_name: templateEditor.category_name,
    shop_ids: draftForm.shop_ids,
    template_name: templateEditor.template_name,
    title: templateEditor.title,
    description: templateEditor.description,
    attributes,
    images,
    source_raw: sourceRaw,
    editable_payload: {
      sku: templateEditor.source_ozon_sku,
      title: templateEditor.title,
      description: templateEditor.description,
      category_id: templateEditor.ozon_category_id,
      description_category_id: templateEditor.description_category_id,
      type_id: templateEditor.type_id,
      legacy_category_id: templateEditor.legacy_category_id,
      category_name: templateEditor.category_name,
      price: {
        value: Number(templateEditor.price_value || 0),
        old_price: Number(templateEditor.old_price || 0),
        currency_code: templateEditor.currency_code || "RUB",
        vat: templateEditor.vat || "0"
      },
      dimensions: {
        length_cm: Number(templateEditor.length_cm || 0),
        width_cm: Number(templateEditor.width_cm || 0),
        height_cm: Number(templateEditor.height_cm || 0),
        weight_g: Number(templateEditor.weight_g || 0)
      },
      logistics: {
        color: templateEditor.color,
        spec: templateEditor.spec,
        quantity: Number(templateEditor.quantity || 0)
      },
      attributes,
      images,
      variants,
      source_raw: sourceRaw
    }
  };
}

function applyTemplateToDraft() {
  if (!templateEditor.id) {
    ElMessage.warning("请先选择模板");
    return;
  }
  draftForm.template_id = templateEditor.id;
  draftForm.product_name = templateEditor.title || templateEditor.template_name || "";
  draftForm.sale_price = Number(templateEditor.price_value || draftForm.sale_price || 0);
  draftForm.length_cm = Number(templateEditor.length_cm || 0);
  draftForm.width_cm = Number(templateEditor.width_cm || 0);
  draftForm.height_cm = Number(templateEditor.height_cm || 0);
  draftForm.weight_g = Number(templateEditor.weight_g || 0);
  draftForm.color = templateEditor.color || "";
  draftForm.spec = templateEditor.spec || "";
  draftForm.quantity = Number(templateEditor.quantity || 0);
  const variantImages = templateEditor.variants.flatMap((variant) => Array.isArray(variant.images) ? variant.images : []);
  const images = templateEditor.images.length ? templateEditor.images : variantImages;
  draftForm.source_images = dedupeImages(images).map((item) => ({ name: item.name || item.url, url: item.url }));
  state.step = "edit";
}

function dedupeImages(images = []) {
  const seen = new Set();
  return images.filter((item) => {
    const url = String(item?.url || "").trim();
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

async function uploadImageRequest(options) {
  uploadingImage.value = true;
  try {
    const result = await uploadCropperImage(options.file);
    draftForm.source_images.push({
      name: result.originalFilename || options.file.name,
      url: result.previewUrl,
      taskId: result.taskId
    });
    options.onSuccess?.(result);
    ElMessage.success("图片已上传");
  } catch (error) {
    options.onError?.(error);
    ElMessage.error(error.message || "图片上传失败");
  } finally {
    uploadingImage.value = false;
  }
}

async function createDraft() {
  if (!draftForm.template_id) {
    ElMessage.warning("请先添加 SKU 模板");
    state.step = "copy";
    return;
  }
  creatingDraft.value = true;
  try {
    const created = await apiClient.post("/api/listing/drafts", {
      ...draftForm,
      source_images: draftForm.source_images.map((item) => item.url)
    });
    state.drafts.unshift(created);
    state.selectedDraftId = created.id;
    state.step = "shops";
    ElMessage.success("上架资料已保存");
  } finally {
    creatingDraft.value = false;
  }
}

async function saveCurrentToDraft() {
  applyTemplateToDraft();
  await createDraft();
}

async function generateCopies() {
  if (!state.selectedDraftId) {
    ElMessage.warning("请先保存上架资料");
    return;
  }
  if (!draftForm.shop_ids.length) {
    ElMessage.warning("请选择要上架的店铺");
    return;
  }
  generatingCopies.value = true;
  try {
    state.copies = await apiClient.post(`/api/listing/drafts/${state.selectedDraftId}/shop-copies`, {
      shop_ids: draftForm.shop_ids
    });
    state.step = "review";
    ElMessage.success("已生成多店铺上架副本");
  } finally {
    generatingCopies.value = false;
  }
}

function removeImage(index) {
  draftForm.source_images.splice(index, 1);
}

function validationType(row) {
  if (row.validation?.level === "green") return "success";
  if (row.validation?.level === "yellow") return "warning";
  if (row.validation?.level === "red") return "danger";
  return "info";
}

function validationLabel(row) {
  if (row.validation?.level === "green") return "可上架";
  if (row.validation?.level === "yellow") return "需复核";
  if (row.validation?.level === "red") return "阻断";
  return "未检查";
}

function copyIssues(row) {
  return [...(row.validation?.errors || []), ...(row.validation?.warnings || [])].join("；") || "-";
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

onMounted(loadAll);
</script>

<template>
  <div class="copy-page" v-loading="loading">
    <section class="copy-header">
      <div>
        <h1>编辑上架</h1>
      </div>
      <div class="header-actions">
        <el-button type="primary" @click="loadAll">刷新</el-button>
      </div>
    </section>

    <div class="copy-layout">
      <main class="main-column">
        <section class="copy-card source-card">
          <div class="source-grid">
            <div class="source-panel">
              <div class="source-panel-heading">
                <h2>通过 Ozon SKU 复制</h2>
                <p>适合把线上商品解析成本地模板。</p>
              </div>
              <div class="sku-toolbar">
                <el-select v-model="copyForm.shop_id" filterable placeholder="源店铺" class="source-shop-select">
                  <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="shop.id" />
                </el-select>
                <el-input v-model="copyForm.sku" class="sku-input" placeholder="Ozon 前台 SKU">
                  <template #prefix><el-icon><Search /></el-icon></template>
                </el-input>
                <el-button :loading="searchingSku" @click="searchSku">搜索</el-button>
              </div>
              <div v-if="state.searchedProduct" class="product-result compact-result">
                <div class="result-image">OZON</div>
                <div class="result-main">
                  <h3>{{ state.searchedProduct.name }}</h3>
                  <p>SKU {{ state.searchedProduct.sku }}</p>
                  <p>{{ state.searchedProduct.category }}</p>
                </div>
                <div class="template-name-box">
                  <el-input v-model="copyForm.template_name" placeholder="本地模板名称" />
                  <el-button type="primary" :icon="Plus" :loading="copyingSku" @click="addCopiedProduct">添加/更新模板</el-button>
                </div>
              </div>
              <div v-else class="source-empty">
                <span>可以先不搜索，直接从右侧选本地模板，或在下方新建空模板。</span>
              </div>
            </div>

            <div class="source-panel template-picker">
              <div class="source-panel-heading">
                <h2>本地模板快速选择</h2>
                <p>按中文模板名、类目、源 SKU 或标题搜索。</p>
              </div>
              <div class="template-search-row">
                <el-input v-model="templateKeyword" placeholder="搜索模板名 / 类目 / SKU / 标题" clearable>
                  <template #prefix><el-icon><Search /></el-icon></template>
                </el-input>
                <el-button @click="newBlankTemplate">新建空模板</el-button>
                <el-button type="primary" plain @click="openCollectedImport">导入采集JSON</el-button>
              </div>
              <div class="template-card-list">
                <button
                  v-for="template in filteredTemplates"
                  :key="template.id"
                  type="button"
                  class="template-mini-card"
                  :class="{ active: Number(templateEditor.id) === Number(template.id) }"
                  @click="selectTemplate(template)"
                >
                  <strong>{{ template.template_name || "未命名模板" }}</strong>
                  <span>{{ template.category_name || "未填写类目" }}</span>
                  <small>SKU {{ template.source_ozon_sku || "-" }} / {{ template.title || "-" }}</small>
                </button>
                <el-empty v-if="!filteredTemplates.length" description="暂无匹配模板" />
              </div>
            </div>
          </div>
        </section>

        <section class="copy-card" v-loading="loadingTemplate">
          <div class="section-heading template-heading">
            <div>
              <h2>模板编辑</h2>
              <p>复制出来的商品卡或本地模板会完整沉淀在这里；没有选择模板时也可以直接新建填写。</p>
            </div>
            <div class="template-actions">
              <el-button type="success" :disabled="!templateEditor.id" :loading="aiGenerating" @click="runFieldAi({ name: 'all' })">AI 一键生成文案</el-button>
              <el-button :loading="validatingPublish" @click="validatePublishPayload">检查上架</el-button>
              <el-button :loading="savingTemplate" @click="saveTemplateEditor">{{ templateEditor.id ? "保存模板" : "创建模板" }}</el-button>
              <el-button :disabled="!templateEditor.id" :loading="creatingDraft" @click="saveCurrentToDraft">保存到草稿箱</el-button>
              <el-button type="primary" :disabled="!templateEditor.id" @click="applyTemplateToDraft">准备发布</el-button>
              <el-button type="danger" :loading="publishingToOzon" @click="publishTemplateToOzon">正式提交 Ozon</el-button>
            </div>
          </div>
          <el-form label-position="left" label-width="120px" :model="templateEditor" class="ozon-editor">
            <section class="template-health-grid">
              <div v-for="card in templateHealthCards" :key="card.label" class="template-health-card" :class="`is-${card.tone}`">
                <span>{{ card.label }}</span>
                <strong>{{ card.value }}</strong>
                <small>{{ card.detail }}</small>
              </div>
            </section>
            <div v-if="missingRequiredAttributes.length" class="missing-required-strip">
              <strong>缺失必填：</strong>
              <el-tag v-for="field in missingRequiredAttributes.slice(0, 8)" :key="field.attribute_id || field.name" type="danger" effect="plain">
                {{ field.name }}
              </el-tag>
              <span v-if="missingRequiredAttributes.length > 8">+{{ missingRequiredAttributes.length - 8 }}</span>
            </div>
            <section class="editor-block variants-block">
              <h3>主要信息</h3>
              <div class="form-shell">
                <el-form-item label="本地模板名" required>
                  <el-input v-model="templateEditor.template_name" placeholder="例如：不锈钢门槛条标准模板" />
                </el-form-item>
                <el-form-item label="Ozon 真实类目" required>
                  <OzonCategorySelect
                    v-model="templateEditor.ozon_category_id"
                    :shop-id="copyForm.shop_id"
                    @select="handleOzonCategorySelected"
                  />
                </el-form-item>
                <div class="category-meta-grid category-diagnostics">
                  <el-form-item label="后台类目ID">
                    <el-input :model-value="templateEditor.description_category_id || '未选择'" readonly />
                  </el-form-item>
                  <el-form-item label="商品类型ID">
                    <el-input :model-value="templateEditor.type_id || '未选择'" readonly />
                  </el-form-item>
                  <el-form-item label="属性数">
                    <el-input :model-value="`${templateEditor.attributes.length} / schema ${selectedTemplate?.category_attributes?.length || 0}`" readonly />
                  </el-form-item>
                </div>
                <el-form-item label="上架店铺">
                  <div v-if="false" class="category-meta-grid legacy-category-meta">
                    <el-form-item label="描述类目ID">
                      <el-input v-model="templateEditor.description_category_id" placeholder="description_category_id" />
                    </el-form-item>
                    <el-form-item label="类型ID">
                      <el-input v-model="templateEditor.type_id" placeholder="type_id" />
                    </el-form-item>
                    <el-form-item label="属性数">
                      <el-input :model-value="`${templateEditor.attributes.length} / schema ${selectedTemplate?.category_attributes?.length || 0}`" readonly />
                    </el-form-item>
                  </div>
                  <div class="shop-select-box">
                    <el-select v-model="draftForm.shop_ids" multiple filterable collapse-tags collapse-tags-tooltip placeholder="可多选目标店铺">
                      <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="shop.id" />
                    </el-select>
                    <el-button @click="selectAllShops">全选</el-button>
                    <el-button @click="clearSelectedShops">清空</el-button>
                  </div>
                </el-form-item>
                <el-form-item label="产品类目" required>
                  <div class="field-with-tools">
                    <el-input v-model="templateEditor.category_name" />
                    <el-button :loading="loadingTemplate" @click="syncSelectedCategoryAttributes">同步属性</el-button>
                  </div>
                </el-form-item>
                <el-form-item label="标题" required>
                  <div class="field-with-tools">
                    <el-input v-model="templateEditor.title" />
                    <el-button circle :type="variantFieldMode.title ? 'primary' : 'default'" @click="enableVariantField('title')">+</el-button>
                    <el-button circle :icon="InfoFilled" @click="openAttributeDetail({ name: '标题', value: templateEditor.title, type: 'text', required: true, source: 'main' })" />
                    <el-button circle @click="runFieldAi({ name: '标题' })">AI</el-button>
                  </div>
                </el-form-item>
                <el-form-item label="品牌" required>
                  <el-select :model-value="fixedForm.brand" filterable allow-create default-first-option @update:model-value="updateFixedField('brand', $event)">
                    <el-option label="无品牌" value="无品牌" />
                  </el-select>
                </el-form-item>
                <el-form-item label="包装重量" required>
                  <div class="unit-input">
                    <el-input-number v-model="templateEditor.weight_g" :min="0" :controls="false" />
                    <span>g</span>
                    <span class="field-note">注意单位是克</span>
                    <el-button circle :type="variantFieldMode.weight ? 'primary' : 'default'" @click="enableVariantField('weight')">+</el-button>
                    <el-button circle :icon="InfoFilled" @click="openAttributeDetail({ name: '包装重量', value: templateEditor.weight_g, type: 'number', required: true, source: 'fixed_form' })" />
                  </div>
                </el-form-item>
                <el-form-item label="包装尺寸" required>
                  <div class="dimension-row">
                    <el-input-number v-model="templateEditor.length_cm" :min="0" :controls="false" />
                    <span>mm</span>
                    <el-input-number v-model="templateEditor.width_cm" :min="0" :controls="false" />
                    <span>mm</span>
                    <el-input-number v-model="templateEditor.height_cm" :min="0" :controls="false" />
                    <span>mm</span>
                    <span class="field-note">注意单位是毫米</span>
                    <el-button circle :type="variantFieldMode.dimensions ? 'primary' : 'default'" @click="enableVariantField('dimensions')">+</el-button>
                  </div>
                </el-form-item>
              </div>
            </section>

            <section class="editor-block">
              <div class="section-line">
                <div>
                  <h3>产品属性</h3>
                  <p>这里是固定必填信息；“填写更多属性”只展开类目不同导致的隐藏字段。</p>
                </div>
                <div class="section-actions">
                  <el-button type="primary" @click="showMoreAttributes = !showMoreAttributes">{{ showMoreAttributes ? "收起属性" : "填写更多属性" }}</el-button>
                </div>
              </div>
              <div class="form-shell">
                <el-form-item label="型号名称" required>
                  <div class="field-with-tools">
                    <el-input :model-value="fixedForm.model" @update:model-value="updateFixedField('model', $event)" />
                    <el-button circle @click="runFieldAi({ name: '型号名称' })">AI</el-button>
                    <el-button circle :icon="InfoFilled" @click="openAttributeDetail({ name: '型号名称', value: fixedForm.model, type: 'text', required: true, source: 'fixed_form' })" />
                  </div>
                </el-form-item>
                <el-form-item label="产品标签">
                  <div class="field-with-tools">
                    <el-select :model-value="fixedForm.tags" multiple filterable allow-create default-first-option @update:model-value="updateFixedField('tags', $event)">
                      <el-option v-for="tag in fixedForm.tags" :key="tag" :label="tag" :value="tag" />
                    </el-select>
                    <el-button circle :type="variantFieldMode.tags ? 'primary' : 'default'" @click="enableVariantField('tags')">+</el-button>
                    <el-button circle @click="runFieldAi({ name: '产品标签' })">AI</el-button>
                    <el-button circle :icon="InfoFilled" @click="openAttributeDetail({ name: '产品标签', value: fixedForm.tags, type: 'multiselect', required: false, source: 'fixed_form' })" />
                  </div>
                </el-form-item>
                <el-form-item label="简介">
                  <div class="field-with-tools wide-tools">
                    <el-input :model-value="fixedForm.summary" type="textarea" :rows="4" placeholder="商品描述、营销文本" @update:model-value="updateFixedField('summary', $event)" />
                    <el-button circle @click="runFieldAi({ name: '简介' })">AI</el-button>
                    <el-button circle :icon="InfoFilled" @click="openAttributeDetail({ name: '简介', value: fixedForm.summary, type: 'textarea', required: false, source: 'fixed_form' })" />
                  </div>
                </el-form-item>
                <el-form-item label="JSON富内容">
                  <div class="field-with-tools wide-tools">
                    <el-input :model-value="fixedForm.richJson" type="textarea" :rows="5" placeholder="JSON富内容" @update:model-value="updateFixedField('richJson', $event)" />
                    <el-button circle :icon="InfoFilled" @click="openAttributeDetail({ name: 'JSON富内容', value: fixedForm.richJson, type: 'rich_json', required: false, source: 'fixed_form' })" />
                  </div>
                </el-form-item>

                <el-collapse-transition>
                  <div v-show="showMoreAttributes" class="hidden-attributes-panel">
                    <div class="subsection-title">
                      <h3>隐藏属性</h3>
                      <el-button size="small" @click="addAttributeRow">新增隐藏属性</el-button>
                    </div>
                    <el-form-item v-for="(field, index) in mainAttributeFields" :key="`${field.attribute_id || field.name}-${index}`" :required="field.required" :label="field.name || '未命名属性'">
                      <div class="field-with-tools">
                        <el-select v-if="field.type === 'select'" v-model="field.value" filterable clearable>
                          <el-option v-for="option in field.values" :key="option.id || option.value" :label="option.value" :value="option.value" />
                        </el-select>
                        <el-select v-else-if="field.type === 'multiselect'" v-model="field.value" multiple filterable allow-create default-first-option>
                          <el-option v-for="option in field.values" :key="option.id || option.value" :label="option.value" :value="option.value" />
                        </el-select>
                        <el-input-number v-else-if="field.type === 'number'" v-model="field.value" :controls="false" />
                        <el-switch v-else-if="field.type === 'boolean'" v-model="field.value" />
                        <el-input v-else-if="field.type === 'textarea'" v-model="field.value" type="textarea" :rows="3" />
                        <el-input v-else v-model="field.value" />
                        <el-tag :type="attributeStatusType(field)" effect="plain">{{ attributeStatusText(field) }}</el-tag>
                        <el-button circle :icon="InfoFilled" @click="openAttributeDetail(field)" />
                        <el-button link type="danger" @click="removeAttributeRow(templateEditor.attributes.indexOf(field))">删除</el-button>
                      </div>
                    </el-form-item>
                    <el-empty v-if="!hiddenAttributeFields.length" description="当前类目暂无隐藏属性" />
                  </div>
                </el-collapse-transition>
                <div v-if="!showMoreAttributes && hiddenAttributeCount" class="more-attributes-hint">还有 {{ hiddenAttributeCount }} 个类目隐藏属性。</div>
              </div>
            </section>

            <section class="editor-block">
              <div class="section-line">
                <div>
                  <h3>变体设置</h3>
                  <p>按 Ozon 上架表格习惯横向编辑，表头“同首行”会把第一行该列同步到其它变体。</p>
                </div>
                <div class="section-actions">
                  <el-button type="primary" :icon="Plus" @click="addVariantRow">添加变体</el-button>
                  <el-button @click="useTemplateImagesForAllVariants">模板图同步全部</el-button>
                  <el-button :disabled="!selectedVariantRows.length" @click="removeSelectedVariants">批量删除变体</el-button>
                </div>
              </div>
              <el-table
                :data="templateEditor.variants"
                border
                class="variant-table dense-variant-table"
                row-key="id"
                max-height="520"
                :scrollbar-always-on="true"
                @selection-change="handleVariantSelectionChange"
              >
                <el-table-column type="selection" width="46" fixed="left" />
                <el-table-column type="index" label="序号" width="64" fixed="left" align="center" />
                <el-table-column label="SKU 名称" width="230" fixed="left">
                  <template #default="{ row }">
                    <div class="variant-name-cell">
                      <strong>{{ row.source_sku ? `[SKU:${row.source_sku}]` : row.sku || "新变体" }}</strong>
                      <el-input v-model="row.name" size="small" placeholder="变体名称" />
                      <el-input v-model="row.offer_id" size="small" :placeholder="row.source_offer_id ? `原货号：${row.source_offer_id}` : '新 offer_id'" />
                    </div>
                  </template>
                </el-table-column>
                <el-table-column width="190">
                  <template #header>
                    <div class="variant-col-header">
                      <span><em>*</em> 图片</span>
                      <el-button link size="small" @click="applyFirstVariantField('images')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <div class="variant-images">
                      <img v-for="(image, imageIndex) in variantPreviewImages(row)" :key="`${image.url}-${imageIndex}`" :src="withImageToken(image.previewUrl || image.url)" :alt="image.name || row.name" />
                      <span v-if="variantImageOverflow(row)" class="variant-image-more">+{{ variantImageOverflow(row) }}</span>
                      <el-button v-if="!variantPreviewImages(row).length" size="small" @click="row.images = templateEditor.images.slice(0, 6)">用模板图</el-button>
                      <el-upload multiple :show-file-list="false" accept="image/jpeg,image/png,image/webp" :http-request="uploadVariantImagesRequest(row)">
                        <el-button size="small" :loading="uploadingImage">上传</el-button>
                      </el-upload>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column width="140">
                  <template #header>
                    <div class="variant-col-header">
                      <span>视频封面</span>
                      <el-button link size="small" @click="applyFirstVariantField('video_cover_urls')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <el-input
                      :model-value="variantLinkText(row.video_cover_urls)"
                      type="textarea"
                      :rows="2"
                      size="small"
                      placeholder="每行一个链接"
                      @update:model-value="row.video_cover_urls = normalizeVariantLinks($event)"
                    />
                    <el-upload class="inline-upload" :show-file-list="false" accept="video/mp4,video/quicktime,video/webm" :http-request="uploadVariantVideoRequest(row, 'video_cover_urls', 'video')">
                      <el-button size="small" :loading="uploadingImage">上传视频</el-button>
                    </el-upload>
                  </template>
                </el-table-column>
                <el-table-column width="140">
                  <template #header>
                    <div class="variant-col-header">
                      <span>视频</span>
                      <el-button link size="small" @click="applyFirstVariantField('video_urls')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <el-input
                      :model-value="variantLinkText(row.video_urls)"
                      type="textarea"
                      :rows="2"
                      size="small"
                      placeholder="每行一个链接"
                      @update:model-value="row.video_urls = normalizeVariantLinks($event)"
                    />
                    <el-upload class="inline-upload" :show-file-list="false" accept="video/mp4,video/quicktime,video/webm" :http-request="uploadVariantVideoRequest(row, 'video_urls', 'video')">
                      <el-button size="small" :loading="uploadingImage">上传视频</el-button>
                    </el-upload>
                  </template>
                </el-table-column>
                <el-table-column v-if="variantFieldMode.title" width="320">
                  <template #header>
                    <div class="variant-col-header">
                      <span><em>*</em> 标题</span>
                      <el-button link size="small" @click="applyFirstVariantField('title')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }"><el-input v-model="row.title" size="small" /></template>
                </el-table-column>
                <el-table-column v-if="variantFieldMode.weight" width="130">
                  <template #header>
                    <div class="variant-col-header">
                      <span><em>*</em> 包装重量(g)</span>
                      <el-button link size="small" @click="applyFirstVariantField('weight_g')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }"><el-input-number v-model="row.weight_g" :min="0" :controls="false" size="small" /></template>
                </el-table-column>
                <el-table-column v-if="variantFieldMode.dimensions" width="130">
                  <template #header>
                    <div class="variant-col-header">
                      <span><em>*</em> 包装长(mm)</span>
                      <el-button link size="small" @click="applyFirstVariantField('length_mm')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }"><el-input-number v-model="row.length_mm" :min="0" :controls="false" size="small" /></template>
                </el-table-column>
                <el-table-column v-if="variantFieldMode.dimensions" width="130">
                  <template #header>
                    <div class="variant-col-header">
                      <span><em>*</em> 包装宽(mm)</span>
                      <el-button link size="small" @click="applyFirstVariantField('width_mm')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }"><el-input-number v-model="row.width_mm" :min="0" :controls="false" size="small" /></template>
                </el-table-column>
                <el-table-column v-if="variantFieldMode.dimensions" width="130">
                  <template #header>
                    <div class="variant-col-header">
                      <span><em>*</em> 包装高(mm)</span>
                      <el-button link size="small" @click="applyFirstVariantField('height_mm')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }"><el-input-number v-model="row.height_mm" :min="0" :controls="false" size="small" /></template>
                </el-table-column>
                <el-table-column v-if="variantFieldMode.tags" width="190">
                  <template #header>
                    <div class="variant-col-header">
                      <span>#产品标签</span>
                      <el-button link size="small" @click="applyFirstVariantField('main_tags')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <el-select v-model="row.main_tags" multiple filterable allow-create default-first-option collapse-tags collapse-tags-tooltip size="small">
                      <el-option v-for="tag in row.main_tags" :key="tag" :label="tag" :value="tag" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column width="150">
                  <template #header>
                    <div class="variant-col-header">
                      <span>颜色</span>
                      <el-button link size="small" @click="applyFirstVariantField('color')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }"><el-input v-model="row.color" size="small" /></template>
                </el-table-column>
                <el-table-column width="170">
                  <template #header>
                    <div class="variant-col-header">
                      <span>规格/型号</span>
                      <el-button link size="small" @click="applyFirstVariantField('spec')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }"><el-input v-model="row.spec" size="small" /></template>
                </el-table-column>
                <el-table-column width="140">
                  <template #header>
                    <div class="variant-col-header">
                      <span>售价</span>
                      <el-button link size="small" @click="applyFirstVariantField('price')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }"><el-input-number v-model="row.price" :min="0" :controls="false" size="small" /></template>
                </el-table-column>
                <el-table-column width="140">
                  <template #header>
                    <div class="variant-col-header">
                      <span>划线价</span>
                      <el-button link size="small" @click="applyFirstVariantField('old_price')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }"><el-input-number v-model="row.old_price" :min="0" :controls="false" size="small" /></template>
                </el-table-column>
                <el-table-column v-if="false" width="120">
                  <template #header>
                    <div class="variant-col-header">
                      <span>库存</span>
                      <el-button link size="small" @click="applyFirstVariantField('stock')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }"><el-input-number v-model="row.stock" :min="0" :controls="false" size="small" /></template>
                </el-table-column>
                <el-table-column v-if="false" label="条码" width="160">
                  <template #default="{ row }"><el-input v-model="row.barcode" size="small" /></template>
                </el-table-column>
                <el-table-column label="操作" width="110" fixed="right" align="center">
                  <template #default="{ row, $index }">
                    <div class="variant-row-actions">
                      <el-button link @click="duplicateVariantRow(row)">复制</el-button>
                      <el-button link type="danger" @click="removeVariantRow($index)">删除</el-button>
                    </div>
                  </template>
                </el-table-column>
              </el-table>
              <el-empty v-if="!templateEditor.variants.length" description="暂无变体，可添加一行作为批量编辑框架" />
            </section>

            <div class="subsection-title">
              <h3>模板图片</h3>
              <div class="section-actions">
                <el-upload multiple :show-file-list="false" accept="image/jpeg,image/png,image/webp" :http-request="uploadTemplateImagesRequest">
                  <el-button size="small" type="primary" :loading="uploadingImage">上传图片</el-button>
                </el-upload>
                <el-button size="small" @click="addTemplateImageRow">新增图片链接</el-button>
              </div>
            </div>
            <el-table :data="templateEditor.images" border>
              <el-table-column label="图片链接" min-width="320">
                <template #default="{ row }"><el-input v-model="row.url" /></template>
              </el-table-column>
              <el-table-column label="备注" min-width="140">
                <template #default="{ row }"><el-input v-model="row.name" /></template>
              </el-table-column>
              <el-table-column label="操作" width="90">
                <template #default="{ $index }"><el-button link type="danger" @click="removeTemplateImageRow($index)">删除</el-button></template>
              </el-table-column>
            </el-table>
            <div v-if="templateEditor.images.length" class="image-strip template-preview">
              <div v-for="(image, index) in templateEditor.images.filter((item) => item.url)" :key="`${image.url}-${index}`" class="image-tile">
                <img :src="withImageToken(image.previewUrl || image.url)" :alt="image.name || image.url" />
              </div>
            </div>
          </el-form>
        </section>

      </main>

    </div>

    <el-drawer v-model="attributeDrawer.visible" title="属性详情" size="460px">
      <div v-if="attributeDrawer.field" class="attribute-detail">
        <h3>{{ attributeDrawer.field.name }}</h3>
        <el-descriptions :column="1" border>
          <el-descriptions-item label="属性 ID">{{ attributeDrawer.field.attribute_id || "-" }}</el-descriptions-item>
          <el-descriptions-item label="字段类型">{{ attributeDrawer.field.type || "text" }}</el-descriptions-item>
          <el-descriptions-item label="是否必填">{{ attributeDrawer.field.required ? "是" : "否" }}</el-descriptions-item>
          <el-descriptions-item label="是否多值">{{ attributeDrawer.field.is_collection ? "是" : "否" }}</el-descriptions-item>
          <el-descriptions-item label="字典 ID">{{ attributeDrawer.field.dictionary_id || "-" }}</el-descriptions-item>
          <el-descriptions-item label="来源">{{ attributeDrawer.field.source || "-" }}</el-descriptions-item>
          <el-descriptions-item label="提示">{{ attributeDrawer.field.hint || "-" }}</el-descriptions-item>
        </el-descriptions>
        <div v-if="attributeDrawer.field.values?.length" class="detail-options">
          <h4>可选值</h4>
          <el-tag v-for="option in attributeDrawer.field.values.slice(0, 40)" :key="option.id || option.value" effect="plain">{{ option.value }}</el-tag>
        </div>
        <h4>原始 JSON</h4>
        <el-input :model-value="JSON.stringify(attributeDrawer.field.raw || attributeDrawer.field, null, 2)" type="textarea" :rows="12" readonly />
      </div>
    </el-drawer>

    <el-drawer v-model="collectedImport.visible" title="导入 Ozon 前台采集数据" size="720px">
      <div class="collected-import">
        <el-alert
          type="info"
          :closable="false"
          title="参考项目通过 Ozon 前台 widgetStates 采集到的 normalized/editPayload/followEditPayload JSON，可以在这里转成本地模板。"
        />
        <el-form label-position="top">
          <el-form-item label="本地模板名">
            <el-input v-model="collectedImport.template_name" placeholder="不填则使用采集到的标题" />
          </el-form-item>
          <div class="collected-import-grid">
            <el-form-item label="Ozon 类目 ID">
              <el-input v-model="collectedImport.ozon_category_id" placeholder="采集 JSON 没有类目时需手动填写" />
            </el-form-item>
            <el-form-item label="产品类目">
              <el-input v-model="collectedImport.category_name" placeholder="例如：汽车门槛条" />
            </el-form-item>
          </div>
          <el-form-item label="采集 JSON">
            <el-input v-model="collectedImport.rawJson" type="textarea" :rows="18" placeholder="粘贴参考项目插件采集出的 normalized 或 editPayload JSON" />
          </el-form-item>
        </el-form>
        <div class="drawer-actions">
          <el-button @click="collectedImport.visible = false">取消</el-button>
          <el-button type="primary" :loading="importingCollected" @click="importCollectedProductJson">导入并生成模板</el-button>
        </div>
      </div>
    </el-drawer>

    <el-drawer v-model="showApiDebug" title="Ozon 接口调试" size="720px">
      <div v-if="selectedCopyJob" class="api-debug">
        <el-alert type="info" :closable="false" title="这里用于确认 Ozon 每一步真实返回，后续字段映射按这里的数据来定。" />
        <el-descriptions :column="2" border>
          <el-descriptions-item label="任务 ID">{{ selectedCopyJob.task_id || "-" }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ copyJobStatusText(selectedCopyJob) }}</el-descriptions-item>
          <el-descriptions-item label="Offer ID">{{ selectedCopyJob.offer_id || "-" }}</el-descriptions-item>
          <el-descriptions-item label="Product ID">{{ selectedCopyJob.product_id || "-" }}</el-descriptions-item>
          <el-descriptions-item label="已取详情">{{ selectedCopyJob.has_product_detail ? "是" : "否" }}</el-descriptions-item>
          <el-descriptions-item label="模板已同步">{{ selectedCopyJob.template_synced ? "是" : "否" }}</el-descriptions-item>
        </el-descriptions>

        <el-tabs class="debug-tabs">
          <el-tab-pane label="1 请求 import-by-sku">
            <el-input :model-value="prettyJson(selectedCopyJob.request)" type="textarea" :rows="14" readonly />
          </el-tab-pane>
          <el-tab-pane label="2 返回 import/info">
            <el-input :model-value="prettyJson(selectedCopyJob.response)" type="textarea" :rows="14" readonly />
          </el-tab-pane>
          <el-tab-pane label="3 商品详情">
            <el-input :model-value="prettyJson(selectedCopyJob.product_detail)" type="textarea" :rows="14" readonly />
          </el-tab-pane>
          <el-tab-pane label="4 当前模板解析">
            <el-input :model-value="prettyJson({ category_id: templateEditor.ozon_category_id, category_name: templateEditor.category_name, title: templateEditor.title, images: templateEditor.images, attributes: templateEditor.attributes, variants: templateEditor.variants })" type="textarea" :rows="14" readonly />
          </el-tab-pane>
        </el-tabs>
      </div>
      <el-empty v-else description="暂无选中的复制任务" />
    </el-drawer>

    <el-drawer v-model="publishValidation.visible" title="发布前校验" size="760px">
      <div v-if="publishValidation.result" class="publish-validation">
        <el-alert
          :type="publishValidation.result.ok ? 'success' : 'error'"
          :title="publishValidation.result.ok ? '基础校验通过' : '还有阻断项'"
          :closable="false"
          show-icon
        />
        <section v-if="publishValidation.result.errors?.length">
          <h3>阻断项</h3>
          <el-tag v-for="item in publishValidation.result.errors" :key="item" type="danger" effect="plain">{{ item }}</el-tag>
        </section>
        <section v-if="publishValidation.result.warnings?.length">
          <h3>提醒</h3>
          <el-tag v-for="item in publishValidation.result.warnings" :key="item" type="warning" effect="plain">{{ item }}</el-tag>
        </section>
        <section>
          <h3>Ozon Payload 预览</h3>
          <el-input :model-value="prettyJson(publishValidation.result.payload)" type="textarea" :rows="18" readonly />
        </section>
      </div>
    </el-drawer>

    <el-drawer v-model="publishSubmit.visible" title="Ozon 提交结果" size="760px">
      <div v-if="publishSubmit.result" class="publish-validation">
        <el-alert
          :type="publishSubmit.result.ok ? 'success' : 'warning'"
          :title="publishSubmit.result.ok ? '已提交到 Ozon' : '提交未完成'"
          :closable="false"
          show-icon
        />
        <section>
          <h3>店铺结果</h3>
          <el-table :data="publishSubmit.result.results || []" border>
            <el-table-column prop="shop_name" label="店铺" min-width="150" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.ok ? 'success' : 'danger'" effect="plain">{{ row.ok ? "成功" : "失败" }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="task_id" label="Task ID" min-width="130" />
            <el-table-column prop="error" label="错误" min-width="260" show-overflow-tooltip />
          </el-table>
        </section>
        <section>
          <h3>返回明细</h3>
          <el-input :model-value="prettyJson(publishSubmit.result)" type="textarea" :rows="18" readonly />
        </section>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.copy-page { display: flex; flex-direction: column; gap: 16px; }
.copy-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.copy-header h1, .section-heading h2 { margin: 0; }
.copy-header p, .section-heading p { margin: 6px 0 0; color: var(--el-text-color-secondary); }
.header-actions, .search-row, .shop-row, .stat-row { display: flex; align-items: center; gap: 12px; }
.progress-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; background: var(--el-fill-color-light); padding: 12px; border-radius: 8px; }
.progress-item { height: 42px; display: grid; place-items: center; border-radius: 8px; color: var(--el-text-color-secondary); font-weight: 700; }
.progress-item.active { background: var(--el-bg-color); color: var(--el-color-primary); box-shadow: var(--el-box-shadow-light); }
.copy-layout { display: block; }
.main-column { display: flex; flex-direction: column; gap: 16px; }
.copy-card { background: var(--el-bg-color); border: 1px solid var(--el-border-color-light); border-radius: 8px; padding: 16px; }
.source-card { padding: 14px; }
.source-grid { display: grid; grid-template-columns: minmax(360px, 0.95fr) minmax(420px, 1.25fr); gap: 14px; align-items: stretch; }
.source-panel { min-width: 0; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 14px; background: var(--el-fill-color-extra-light); }
.source-panel-heading { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 10px; }
.source-panel-heading h2 { margin: 0; font-size: 16px; }
.source-panel-heading p { margin: 2px 0 0; color: var(--el-text-color-secondary); font-size: 12px; }
.section-heading { margin-bottom: 14px; }
.sku-toolbar { display: grid; grid-template-columns: 150px minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.sku-input { min-width: 0; }
.source-shop-select { width: 100%; }
.source-empty { min-height: 76px; display: flex; align-items: center; color: var(--el-text-color-secondary); font-size: 13px; border: 1px dashed var(--el-border-color); border-radius: 8px; padding: 12px; margin-top: 12px; background: var(--el-bg-color); }
.template-search-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; align-items: center; }
.template-card-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; max-height: 194px; overflow: auto; padding: 2px; margin-top: 10px; }
.template-mini-card { appearance: none; border: 1px solid var(--el-border-color-light); border-radius: 8px; background: var(--el-bg-color); padding: 10px; text-align: left; cursor: pointer; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.template-mini-card:hover, .template-mini-card.active { border-color: var(--el-color-primary); box-shadow: 0 0 0 2px var(--el-color-primary-light-9); }
.template-mini-card strong, .template-mini-card span, .template-mini-card small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.template-mini-card strong { color: var(--el-text-color-primary); font-size: 13px; }
.template-mini-card span { color: var(--el-text-color-regular); font-size: 12px; }
.template-mini-card small { color: var(--el-text-color-secondary); font-size: 12px; }
.template-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.template-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.ozon-editor { max-width: 100%; margin: 0 auto; }
.template-health-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 4px auto 12px; max-width: 980px; }
.template-health-card { border: 1px solid var(--el-border-color-light); border-radius: 8px; padding: 10px 12px; background: var(--el-fill-color-extra-light); min-width: 0; }
.template-health-card span, .template-health-card small { display: block; color: var(--el-text-color-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.template-health-card strong { display: block; margin: 4px 0 2px; font-size: 17px; color: var(--el-text-color-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.template-health-card.is-ok { border-color: var(--el-color-success-light-5); background: var(--el-color-success-light-9); }
.template-health-card.is-warn { border-color: var(--el-color-warning-light-5); background: var(--el-color-warning-light-9); }
.template-health-card.is-danger { border-color: var(--el-color-danger-light-5); background: var(--el-color-danger-light-9); }
.missing-required-strip { max-width: 980px; margin: 0 auto 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px; border: 1px solid var(--el-color-danger-light-7); border-radius: 8px; background: var(--el-color-danger-light-9); }
.editor-block { padding: 18px 0 8px; }
.editor-block + .editor-block { border-top: 1px solid var(--el-border-color-lighter); margin-top: 12px; }
.editor-block h3 { margin: 0 0 18px; font-size: 18px; text-align: center; }
.form-shell { max-width: 740px; margin: 0 auto; }
.category-meta-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; width: 100%; margin-bottom: 12px; }
.category-meta-grid :deep(.el-form-item) { margin-bottom: 0; }
.legacy-category-meta { display: none; }
.section-line { display: flex; justify-content: space-between; align-items: center; gap: 16px; max-width: 980px; margin: 0 auto 16px; }
.section-line h3 { text-align: left; margin: 0 0 4px; }
.section-line p { margin: 0; color: var(--el-text-color-secondary); }
.section-actions { display: flex; align-items: center; gap: 8px; }
.field-with-tools { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto auto; align-items: center; gap: 8px; width: 100%; }
.field-with-tools.wide-tools { grid-template-columns: minmax(0, 1fr) auto auto; align-items: flex-start; }
.unit-input, .dimension-row { display: flex; align-items: center; gap: 8px; width: 100%; }
.shop-select-box { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px; width: 100%; }
.unit-input .el-input-number { flex: 1; }
.dimension-row .el-input-number { min-width: 0; flex: 1; }
.unit-input span, .dimension-row span { color: var(--el-text-color-secondary); }
.field-note { color: var(--el-color-danger) !important; white-space: nowrap; }
.hidden-attributes-panel { margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--el-border-color); }
.more-attributes-hint { padding: 10px 0 0 120px; color: var(--el-text-color-secondary); font-size: 13px; }
.variant-table { max-width: 100%; min-width: 1180px; }
.dense-variant-table { width: 100%; }
.dense-variant-table :deep(.el-table__header th) { background: var(--el-fill-color-lighter); }
.dense-variant-table :deep(.el-table__cell) { vertical-align: top; }
.dense-variant-table :deep(.cell) { padding-left: 8px; padding-right: 8px; }
.dense-variant-table :deep(.el-input-number) { width: 100%; }
.variants-block { max-width: min(1680px, calc(100vw - 180px)); margin-left: auto; margin-right: auto; overflow-x: auto; }
.variant-col-header { min-height: 44px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; line-height: 1.2; text-align: center; font-weight: 700; }
.variant-col-header em { color: var(--el-color-danger); font-style: normal; margin-right: 2px; }
.variant-col-header .el-button { height: 18px; padding: 0; font-size: 12px; }
.variant-name-cell { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.variant-name-cell strong { display: block; color: var(--el-text-color-primary); font-size: 12px; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.variant-images { display: flex; align-items: center; gap: 4px; min-height: 46px; }
.variant-images img { width: 42px; height: 42px; border-radius: 4px; object-fit: cover; border: 1px solid var(--el-border-color-light); background: var(--el-fill-color-light); }
.variant-image-more { width: 28px; height: 28px; border-radius: 999px; display: grid; place-items: center; background: rgba(31, 41, 55, 0.38); color: #fff; font-size: 12px; font-weight: 800; }
.inline-upload { margin-top: 6px; }
.variant-sub-input { margin-top: 6px; }
.variant-row-actions { display: flex; justify-content: center; gap: 8px; }
.attribute-detail h3 { margin: 0 0 16px; }
.attribute-detail h4 { margin: 18px 0 10px; }
.detail-options { display: flex; flex-wrap: wrap; gap: 8px; }
.api-debug { display: flex; flex-direction: column; gap: 14px; }
.publish-validation { display: flex; flex-direction: column; gap: 16px; }
.publish-validation section { display: flex; flex-wrap: wrap; gap: 8px; }
.publish-validation h3 { flex-basis: 100%; margin: 0; }
.collected-import { display: flex; flex-direction: column; gap: 14px; }
.collected-import-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.drawer-actions { display: flex; justify-content: flex-end; gap: 8px; }
.debug-tabs { margin-top: 4px; }
.subsection-title { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 12px 0 8px; }
.subsection-title h3 { margin: 0; font-size: 15px; }
.search-row .el-select { width: 240px; }
.search-row .el-input { flex: 1; }
.search-row.compact .el-input { flex: 1; }
.product-result { display: grid; grid-template-columns: 130px minmax(0, 1fr) auto; align-items: center; gap: 16px; margin-top: 16px; border: 1px solid var(--el-border-color-light); border-radius: 18px; padding: 16px; }
.compact-result { grid-template-columns: 86px minmax(0, 1fr) auto; border-radius: 8px; padding: 12px; background: var(--el-bg-color); }
.template-name-box { min-width: 360px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
.result-image { height: 130px; display: grid; place-items: center; border-radius: 12px; background: linear-gradient(135deg, #eef5ff, #ffffff); color: var(--el-color-primary); font-weight: 800; font-size: 22px; }
.compact-result .result-image { height: 86px; font-size: 18px; }
.result-main h3 { margin: 0 0 8px; font-size: 18px; }
.result-main p { margin: 4px 0; color: var(--el-text-color-secondary); }
.result-note { font-size: 12px; }
.result-actions { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.full-button { width: 100%; margin-top: 10px; }
.el-input-number { width: 100%; }
.upload-icon { font-size: 28px; color: var(--el-color-primary); }
.image-strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; margin-bottom: 14px; }

@media (max-width: 1100px) {
  .source-grid { grid-template-columns: 1fr; }
  .template-card-list { grid-template-columns: 1fr; max-height: none; }
  .sku-toolbar, .template-search-row, .collected-import-grid, .category-meta-grid, .template-health-grid { grid-template-columns: 1fr; }
}
.template-preview { margin-top: 12px; }
.image-tile { position: relative; aspect-ratio: 1; border: 1px solid var(--el-border-color-light); border-radius: 8px; overflow: hidden; background: var(--el-fill-color-light); }
.image-tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
.image-tile button { position: absolute; right: 6px; bottom: 6px; border: 0; border-radius: 6px; padding: 4px 8px; background: rgba(0,0,0,.62); color: #fff; cursor: pointer; }
.shop-row .el-select { flex: 1; }
.template-list { display: flex; flex-direction: column; gap: 8px; }
.template-list.embedded { margin-top: 10px; max-height: 260px; overflow: auto; }
.template-list button { text-align: left; border: 1px solid var(--el-border-color-light); background: var(--el-bg-color); border-radius: 8px; padding: 10px 12px; cursor: pointer; }
.template-list button.active { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.template-list button strong, .template-list button span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.template-list button span { margin-top: 4px; color: var(--el-text-color-secondary); font-size: 12px; }
@media (max-width: 1200px) {
  .copy-layout { grid-template-columns: 1fr; }
  .progress-row { grid-template-columns: repeat(2, 1fr); }
  .compact-result { grid-template-columns: 86px minmax(0, 1fr); }
  .template-name-box { grid-column: 1 / -1; min-width: 0; }
}
</style>
