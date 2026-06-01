<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { InfoFilled, Plus, Search, UploadFilled } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import { uploadCropperImage, uploadListingMedia, withImageToken } from "../../api/tools/imageCropper";
import OzonCategorySelect from "../../components/listing/OzonCategorySelect.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";

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
const collectorTemplateApplied = ref(false);
const showMoreAttributes = ref(false);
const optionalAttributeVisibleLimit = ref(24);
const showApiDebug = ref(false);
const sourceRawOmitted = ref(false);
const ATTRIBUTE_OPTION_RENDER_LIMIT = 60;
const attributeValueLoading = reactive({});
const recordDraftApplied = ref(false);
const templateKeyword = ref("");
const selectedVariantRows = ref([]);
const importingCollected = ref(false);
const materialSearching = ref(false);
const materialReferencing = ref(false);
const referencedMaterialPackage = ref(null);
const route = useRoute();
const router = useRouter();
const materialSearch = reactive({
  keyword: "",
  name: "",
  shopId: "",
  brand: "",
  model: "",
  productType: "",
  results: []
});
const variantImageEditor = reactive({
  visible: false,
  row: null,
  selectedUrls: [],
  activeTab: "sku"
});
const variantVideoEditor = reactive({
  visible: false,
  row: null,
  field: "video_urls",
  title: "视频管理"
});
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
const collectorSourceSku = computed(() => String(route.query.collectorSku || "").trim());
const selectedDraft = computed(() => state.drafts.find((item) => Number(item.id) === Number(state.selectedDraftId)) || null);
const readyCopyCount = computed(() => state.copies.filter((item) => item.validation?.level === "green").length);
const blockedCopyCount = computed(() => state.copies.filter((item) => item.validation?.level === "red").length);
const hiddenAttributeFields = computed(() => templateEditor.attributes
  .filter((item) => !isFixedAttributeField(item))
  .slice()
  .sort(sortSchemaAttributeFields));
const requiredSchemaAttributeFields = computed(() => hiddenAttributeFields.value.filter((item) => item.required));
const optionalSchemaAttributeFields = computed(() => hiddenAttributeFields.value.filter((item) => !item.required));
const recommendedOptionalAttributeFields = computed(() => optionalSchemaAttributeFields.value.filter(isRecommendedAttributeField));
const mainAttributeFields = computed(() => {
  if (showMoreAttributes.value) return optionalSchemaAttributeFields.value.slice(0, optionalAttributeVisibleLimit.value);
  return [];
});
const hiddenAttributeCount = computed(() => Math.max(optionalSchemaAttributeFields.value.length - mainAttributeFields.value.length, 0));
const missingRequiredAttributes = computed(() => templateEditor.attributes.filter((item) => item.required && !hasAttributeValue(item)));
const filledRequiredAttributeCount = computed(() => templateEditor.attributes.filter((item) => item.required && hasAttributeValue(item)).length);
const requiredAttributeCount = computed(() => templateEditor.attributes.filter((item) => item.required).length);
const schemaAttributeCount = computed(() => templateEditor.attributes.filter((item) => item.attribute_id).length);
const filledSchemaAttributeCount = computed(() => templateEditor.attributes.filter((item) => item.attribute_id && hasAttributeValue(item)).length);
const missingOptionalSchemaAttributes = computed(() => templateEditor.attributes.filter((item) => item.attribute_id && !item.required && !hasAttributeValue(item)));
const dictionarySchemaAttributes = computed(() => templateEditor.attributes.filter((item) => Number(item.dictionary_id || 0)));
const filledDictionaryAttributeCount = computed(() => dictionarySchemaAttributes.value.filter((item) => hasAttributeValue(item)).length);
const schemaQualityScore = computed(() => {
  const total = Math.max(schemaAttributeCount.value, 1);
  const requiredPenalty = missingRequiredAttributes.value.length * 8;
  const base = Math.round((filledSchemaAttributeCount.value / total) * 100);
  return Math.max(0, Math.min(100, base - requiredPenalty));
});
const schemaQualityCards = computed(() => [
  {
    label: "Schema",
    value: `${filledSchemaAttributeCount.value}/${schemaAttributeCount.value}`,
    detail: templateEditor.description_category_id && templateEditor.type_id ? `${templateEditor.description_category_id}:${templateEditor.type_id}` : "No Ozon category",
    tone: schemaAttributeCount.value ? "ok" : "warn"
  },
  {
    label: "Required",
    value: `${filledRequiredAttributeCount.value}/${requiredAttributeCount.value}`,
    detail: missingRequiredAttributes.value.length ? `${missingRequiredAttributes.value.length} missing` : "Complete",
    tone: missingRequiredAttributes.value.length ? "danger" : "ok"
  },
  {
    label: "Dictionary",
    value: `${filledDictionaryAttributeCount.value}/${dictionarySchemaAttributes.value.length}`,
    detail: "Local Ozon dictionary cache",
    tone: dictionarySchemaAttributes.value.length && filledDictionaryAttributeCount.value < dictionarySchemaAttributes.value.length ? "warn" : "ok"
  },
  {
    label: "Quality",
    value: `${schemaQualityScore.value}/100`,
    detail: schemaQualityScore.value >= 95 ? "95+ target reached" : `${Math.max(0, 95 - schemaQualityScore.value)} points to 95`,
    tone: schemaQualityScore.value >= 95 ? "ok" : "warn"
  }
]);
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
const missingVariantOfferIds = computed(() => templateEditor.variants.filter((item) => !String(item.offer_id || "").trim()));
const filteredTemplates = computed(() => {
  const keyword = String(templateKeyword.value || "").trim().toLowerCase();
  if (!keyword) return state.templates.slice(0, 8);
  return state.templates.filter((item) => {
    return [item.template_name, item.category_name, item.source_ozon_sku, item.title]
      .some((value) => String(value || "").toLowerCase().includes(keyword));
  }).slice(0, 12);
});

function hasListingBootstrapParams() {
  return Boolean(
    Number(route.query.templateId || 0)
    || String(route.query.recordDraft || "").trim()
    || String(route.query.recordId || "").trim()
    || String(route.query.collectorSku || "").trim()
  );
}

async function loadAll() {
  if (!hasListingBootstrapParams()) {
    newBlankTemplate();
    state.templates = [];
    state.drafts = [];
    state.copyJobs = [];
    state.copies = [];
    state.selectedCopyJobId = null;
    state.selectedDraftId = null;
    state.searchedProduct = null;
    state.step = "edit";
    return;
  }
  loading.value = true;
  try {
    const templateId = Number(route.query.templateId || 0);
    const routeTemplateRequest = templateId
      ? apiClient.get(`/api/listing/templates/${templateId}?mode=editor`, { noCache: true }).catch(handleListingApiMissing)
      : Promise.resolve(null);
    const templatesRequest = templateId
      ? Promise.resolve([])
      : apiClient.get("/api/listing/templates", { noCache: true }).catch(handleListingApiMissing);
    const draftsRequest = templateId
      ? Promise.resolve([])
      : apiClient.get("/api/listing/drafts", { noCache: true }).catch(handleListingApiMissing);
    const copyJobsRequest = templateId
      ? Promise.resolve([])
      : apiClient.get("/api/listing/copy-jobs", { noCache: true }).catch(handleListingApiMissing);
    const [shops, templates, drafts, copyJobs, routeTemplate] = await Promise.all([
      apiClient.get("/api/shops"),
      templatesRequest,
      draftsRequest,
      copyJobsRequest,
      routeTemplateRequest
    ]);
    state.shops = Array.isArray(shops) ? shops.filter((shop) => shop.status !== "deleted") : [];
    state.templates = routeTemplate?.id
      ? [routeTemplate, ...(Array.isArray(templates) ? templates : []).filter((item) => Number(item.id) !== Number(routeTemplate.id))]
      : (Array.isArray(templates) ? templates : []);
    state.drafts = Array.isArray(drafts) ? drafts : [];
    state.copyJobs = Array.isArray(copyJobs) ? copyJobs : [];
    if (!copyForm.shop_id && state.shops[0]) copyForm.shop_id = state.shops[0].id;
    if (!state.selectedCopyJobId && state.copyJobs[0]) state.selectedCopyJobId = state.copyJobs[0].id;
    await applyTemplateFromRoute(routeTemplate);
    applyRecordDraftFromRoute();
  } finally {
    loading.value = false;
  }
}

async function applyTemplateFromRoute(routeTemplate = null) {
  if (collectorTemplateApplied.value) return;
  const templateId = Number(route.query.templateId || 0);
  if (!templateId || templateEditor.id) return;
  const template = routeTemplate?.id ? routeTemplate : state.templates.find((item) => Number(item.id) === templateId);
  if (!template) return;
  collectorTemplateApplied.value = true;
  fillTemplateEditor(template);
  draftForm.template_id = template.id;
  state.step = "edit";
  showMoreAttributes.value = false;
  optionalAttributeVisibleLimit.value = 40;
  ElMessage.success("已载入采集箱数据，请在商品上架页继续编辑");
}

async function applyRecordDraftFromRoute() {
  if (recordDraftApplied.value) return;
  const key = String(route.query.recordDraft || "");
  if (!key) return;
  recordDraftApplied.value = true;
  try {
    const draft = JSON.parse(sessionStorage.getItem(key) || "{}");
    if (!draft?.template) throw new Error("empty draft");
    fillTemplateEditor(draft.template);
    const shopId = draft.shop_id || draft.template?.source_raw?.shop_id || "";
    draftForm.shop_ids = shopId ? [shopId] : [];
    showMoreAttributes.value = false;
    if (templateEditor.description_category_id && templateEditor.type_id) await hydrateRecordDraftCategory();
    ElMessage.success("已从上架记录载入可编辑草稿");
  } catch {
    ElMessage.error("上架记录草稿读取失败，请从上架记录重新进入");
  }
}

async function hydrateRecordDraftCategory() {
  try {
    const params = new URLSearchParams({
      q: `${templateEditor.description_category_id} ${templateEditor.type_id}`,
      limit: "5"
    });
    const categories = await apiClient.get(`/api/listing/ozon-categories?${params.toString()}`, { noCache: true });
    const matched = (Array.isArray(categories) ? categories : []).find((item) =>
      Number(item.descriptionCategoryId || item.description_category_id) === Number(templateEditor.description_category_id)
      && Number(item.typeId || item.type_id) === Number(templateEditor.type_id)
    );
    if (matched) {
      templateEditor.category_name = matched.pathZh || matched.path_zh || matched.nameZh || matched.name_zh || matched.label || templateEditor.category_name;
      templateEditor.ozon_category_id = matched.ozonCategoryId || matched.ozon_category_id || templateEditor.ozon_category_id;
    }
    await syncSelectedCategoryAttributes();
  } catch {
    // Category cache is optional for record drafts; keep the editor usable if it is unavailable.
  }
}

function handleListingApiMissing(error) {
  if (error?.status === 404) {
    ElMessage.error("编辑上架后端接口未生效，请重启或重新部署服务端进程");
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
        throw new Error("编辑上架后端接口未生效，请重启或重新部署服务端进程");
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
  ElMessage.info("Ozon 复制任务还在处理中，稍后点击刷新可继续回填");
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
  return job.status || "鏈煡";
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
  templateEditor.category_name = category.path_zh || category.pathZh || category.name_zh || category.nameZh || category.label || category.name_ru || "";
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
      language: "ZH_HANS",
      sync_values: false,
      value_limit: 30,
      return_value_limit: 30
    });
    mergeOzonCategoryAttributes(result.attributes || []);
    optionalAttributeVisibleLimit.value = 24;
    showMoreAttributes.value = false;
    ElMessage.success(`已同步 ${result.saved || 0} 个类目属性`);
  } finally {
    loadingTemplate.value = false;
  }
}

async function syncFullCategorySchema() {
  if (!templateEditor.description_category_id || !templateEditor.type_id) {
    ElMessage.warning("Please select an Ozon category first");
    return;
  }
  loadingTemplate.value = true;
  try {
    const result = await apiClient.post("/api/listing/ozon-category-attributes/sync", {
      shop_id: copyForm.shop_id || undefined,
      description_category_id: templateEditor.description_category_id,
      type_id: templateEditor.type_id,
      language: "ZH_HANS",
      sync_values: true,
      value_limit: 80,
      return_value_limit: 50
    });
    mergeOzonCategoryAttributes(result.attributes || []);
    optionalAttributeVisibleLimit.value = 40;
    showMoreAttributes.value = true;
    ElMessage.success(`Full schema synced: ${result.saved || 0} attributes, ${result.values_saved || 0} values`);
  } finally {
    loadingTemplate.value = false;
  }
}

async function searchMaterialPackages() {
  materialSearching.value = true;
  try {
    const params = new URLSearchParams();
    Object.entries({
      keyword: materialSearch.keyword || undefined,
      name: materialSearch.name || undefined,
      shopId: materialSearch.shopId || undefined,
      brand: materialSearch.brand || undefined,
      model: materialSearch.model || undefined,
      productType: materialSearch.productType || undefined,
      page: 1,
      pageSize: 12
    }).forEach(([key, value]) => {
      if (value !== undefined && value !== "") params.set(key, value);
    });
    const result = await apiClient.get(`/api/material-packages/search?${params.toString()}`, { noCache: true });
    materialSearch.results = result.items || [];
  } catch (error) {
    ElMessage.error(error.message || "素材包搜索失败");
  } finally {
    materialSearching.value = false;
  }
}

async function referenceMaterialPackage(item) {
  if (!item?.id) return;
  materialReferencing.value = true;
  try {
    const detail = await apiClient.get(`/api/material-packages/${item.id}`, { noCache: true });
    const template = detail.template || detail;
    referencedMaterialPackage.value = detail;
    state.templates = [template, ...state.templates.filter((row) => Number(row.id) !== Number(template.id))];
    await selectTemplate(template);
    showMoreAttributes.value = false;
    ElMessage.success("素材包已引用到当前上架");
  } catch (error) {
    ElMessage.error(error.message || "素材包引用失败");
  } finally {
    materialReferencing.value = false;
  }
}

function startManualListing() {
  referencedMaterialPackage.value = null;
  if (!templateEditor.id) newBlankTemplate();
  ElMessage.success("已切换为手动创建上架，表单可继续编辑");
}

function mergeOzonCategoryAttributes(schemaAttrs = []) {
  const currentById = new Map(templateEditor.attributes.map((item) => [String(item.attribute_id || ""), item]).filter(([key]) => key));
  const currentByName = new Map(templateEditor.attributes.map((item) => [String(item.name || "").trim(), item]).filter(([key]) => key));
  const merged = normalizeEditorAttributes(schemaAttrs).map((schema) => {
    const existing = currentById.get(String(schema.attribute_id || "")) || currentByName.get(String(schema.name || "").trim());
    const existingHasValue = existing && hasAttributeValue(existing);
    return {
      ...schema,
      value: existingHasValue ? existing.value : schema.value,
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
  applyOzonAttributeMappings();
}

async function selectTemplate(template) {
  if (!template?.id) return;
  loadingTemplate.value = true;
  try {
    const detail = await apiClient.get(`/api/listing/templates/${template.id}?mode=editor`, { noCache: true });
    fillTemplateEditor(detail);
    draftForm.template_id = detail.id;
  } finally {
    loadingTemplate.value = false;
  }
}

function newBlankTemplate() {
  sourceRawOmitted.value = false;
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

function ensureTemplateName() {
  if (String(templateEditor.template_name || "").trim()) return;
  const base = templateEditor.title || templateEditor.category_name || fixedForm.value.model || "Listing template";
  templateEditor.template_name = `${base}`.slice(0, 120);
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
  const attrs = normalizeEditorAttributes(firstNonEmptyArray(
    template.attributes,
    editable.attributes,
    template.category_attributes
  ));
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
  applyCleanRecordAttributeFallbacks(editable, logistics);
  applyOzonAttributeMappings();
  templateEditor.images = normalizeEditorImages(template.images || editable.images || []);
  templateEditor.variants = normalizeEditorVariants(editable.variants || template.variants || []);
  if (!templateEditor.variants.length && (templateEditor.title || templateEditor.images.length)) addVariantRow();
  sourceRawOmitted.value = Boolean(template.source_raw_omitted);
  templateEditor.rawJson = sourceRawOmitted.value ? "" : JSON.stringify(template.source_raw || editable.source_raw || editable.raw_request || {}, null, 2);
}

function firstNonEmptyArray(...values) {
  return values.find((value) => Array.isArray(value) && value.length) || [];
}

function applyTemplateAttributeFallbacks(editable = {}, logistics = {}) {
  const summary = getAttributeByNames(["简介", "Аннотация", "Описание"], templateEditor.description || editable.description || "");
  const richJson = editable.rich_content_json || getAttributeByNames(["JSON富内容", "Rich", "rich"], "");
  const brand = logistics.brand || getAttributeByNames(["品牌", "Бренд"], "");
  const model = normalizeModelNameValue(getAttributeByIdsOrNames([9048], ["型号名称", "Модель"], "") || logistics.model || logistics.modelName || "") || buildParentModelName();
  const tags = logistics.tags?.length ? logistics.tags : splitTagValue(getAttributeByNames(["产品标签", "主题标签", "主图标签", "ключевые слова", "тег"], ""));
  if (summary && !templateEditor.description) templateEditor.description = summary;
  if (brand) setAttributeByNames(["品牌", "Бренд"], brand, { name: "品牌", required: true });
  if (model) {
    templateEditor.spec = templateEditor.spec || model;
    setAttributeByIdsOrNames([9048], ["型号名称", "Модель"], model, { name: "型号名称", required: true, attribute_id: 9048 });
  }
  if (tags.length) setAttributeByNames(["产品标签", "主题标签", "主图标签", "ключевые слова", "тег"], tags.join(","), { name: "产品标签" });
  if (summary) setAttributeByNames(["简介", "Аннотация", "Описание"], summary, { name: "简介" });
  if (richJson) setAttributeByNames(["JSON富内容", "Rich", "rich"], richJson, { name: "JSON富内容" });
}

function normalizeEditorAttributes(attributes) {
  return (Array.isArray(attributes) ? attributes : []).map((item, index) => ({
    name: item?.name || "",
    value: normalizeIncomingAttributeValue(item),
    type: normalizeAttributeType(item),
    required: Boolean(item?.required || item?.is_required),
    attribute_id: item?.attribute_id || item?.id || "",
    dictionary_id: item?.dictionary_id || "",
    is_collection: Boolean(item?.is_collection),
    group: item?.group || "",
    hint: item?.hint || "",
    source: item?.source || "ozon_copy",
    values: Array.isArray(item?.values) ? item.values.slice(0, 120) : [],
    raw: item?.raw || item,
    sort_order: Number(item?.sort_order || index + 1)
  }));
}

function normalizeIncomingAttributeValue(item = {}) {
  if (item?.value !== undefined && item?.value !== null && item.value !== "") return item.value;
  if (item?.is_collection || String(item?.type || "").toLowerCase() === "multiselect") return [];
  return "";
}

function fixedAttributeNames() {
  return ["标题", "品牌", "包装重量", "包装尺寸", "重量", "尺寸", "型号", "型号名称", "产品标签", "主题标签", "主图标签", "简介", "JSON富内容", "颜色"];
}

function attributeFieldKey(field = {}) {
  return String(field.attribute_id || field.name || field.sort_order || "");
}

function applyCleanRecordAttributeFallbacks(editable = {}, logistics = {}) {
  const summary = getAttributeByNames(["简介", "Аннотация", "Описание"], templateEditor.description || editable.description || "");
  const richJson = editable.rich_content_json || getAttributeByNames(["JSON富内容", "Rich", "rich"], "");
  const brand = logistics.brand || getAttributeByNames(["品牌", "Бренд"], "");
  const model = normalizeModelNameValue(getAttributeByIdsOrNames([9048], ["型号名称", "Модель"], "") || logistics.model || logistics.modelName || "") || buildParentModelName();
  const tags = logistics.tags?.length ? logistics.tags : splitTagValue(getAttributeByNames(["产品标签", "主题标签", "主图标签", "ключевые слова", "тег"], ""));
  if (summary && !templateEditor.description) templateEditor.description = summary;
  if (brand) setAttributeByNames(["品牌", "Бренд"], brand, { name: "品牌", required: true });
  if (model) {
    templateEditor.spec = templateEditor.spec || model;
    setAttributeByIdsOrNames([9048], ["型号名称", "Модель"], model, { name: "型号名称", required: true, attribute_id: 9048 });
  }
  if (tags.length) setAttributeByNames(["产品标签", "主题标签", "主图标签", "ключевые слова", "тег"], tags.join(","), { name: "产品标签" });
  if (summary) setAttributeByNames(["简介", "Аннотация", "Описание"], summary, { name: "简介" });
  if (richJson) setAttributeByNames(["JSON富内容", "Rich", "rich"], richJson, { name: "JSON富内容" });
}

function normalizeModelNameValue(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^(tpu|abs|pvc|pp|pc|pet)$/i.test(text)) return "";
  if (/热塑|弹性体|塑料|材料|材质|кожа|пластик|материал|термо/i.test(text)) return "";
  return text;
}

function buildParentModelName() {
  const raw = [templateEditor.source_ozon_sku, templateEditor.id, draftForm.internal_code, templateEditor.title]
    .map((value) => String(value || "").trim())
    .find(Boolean);
  if (!raw) return `MODEL-${Date.now().toString(36).toUpperCase()}`;
  const compact = raw.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 36);
  return `MODEL-${compact || stableStringHash(raw)}`;
}

function stableStringHash(value = "") {
  let hash = 0;
  for (const char of String(value || "")) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(36).toUpperCase();
}

function renderedAttributeOptions(field = {}) {
  const values = Array.isArray(field.values) ? field.values : [];
  return values.slice(0, ATTRIBUTE_OPTION_RENDER_LIMIT);
}

const editorCurrencyCode = computed(() => String(templateEditor.currency_code || "RUB").trim().toUpperCase() || "RUB");

function attributeNameText(field = {}) {
  return String(field.name || field.attribute_name || field.raw?.name || "").trim().toLowerCase();
}

function compactAttributeText(value = "") {
  return String(value || "").toLowerCase().replace(/[\s_\-/:：()（）]+/g, "");
}

function attributeTextBag(field = {}) {
  return [
    field.name,
    field.attribute_name,
    field.raw?.name,
    field.raw?.attribute_name,
    field.hint,
    field.raw?.hint
  ].map(compactAttributeText).filter(Boolean).join("|");
}

function variantOptionQuality(field = {}, kind = "color") {
  const values = Array.isArray(field.values) ? field.values : [];
  if (!values.length) return 0;
  const sample = values.slice(0, 20).map((option) => String(option?.value || option?.label || "").trim()).filter(Boolean);
  if (!sample.length) return 0;
  const averageLength = sample.reduce((sum, value) => sum + value.length, 0) / sample.length;
  const longTextCount = sample.filter((value) => value.length > 38 || value.split(/\s+/).length > 5).length;
  const commaListCount = sample.filter((value) => value.includes(",") || value.includes("，")).length;
  let score = 0;
  if (averageLength <= 24) score += 8;
  if (averageLength > 44) score -= 14;
  if (longTextCount >= Math.ceil(sample.length * 0.35)) score -= 18;
  if (kind === "spec" && commaListCount >= Math.ceil(sample.length * 0.35)) score -= 12;
  if (kind === "color" && commaListCount) score += 4;
  return score;
}

function findVariantDictionaryAttribute(kind = "color", options = {}) {
  const excludeIds = new Set((options.excludeIds || []).map((id) => String(id || "")));
  const strongIds = kind === "color" ? new Set(["10096"]) : new Set(["4295", "4298", "4299"]);
  const weakIds = kind === "color" ? new Set(["8229"]) : new Set(["9048"]);
  const positive = kind === "color"
    ? ["color", "colour", "цвет", "цветтовара", "основнойцвет", "расцветка", "окраска", "颜色", "颜色分类"]
    : ["size", "размер", "размерпроизводителя", "model", "модель", "型号", "型号名称", "规格", "尺寸"];
  const negative = kind === "color"
    ? ["размер", "size", "модель", "model", "тип", "type", "название", "наименование", "title", "name", "материал", "material", "品牌", "бренд"]
    : ["цвет", "color", "colour", "материал", "material", "бренд", "brand", "颜色"];
  const ranked = templateEditor.attributes.map((field) => {
    const text = attributeTextBag(field);
    const id = Number(field.attribute_id || 0);
    if (excludeIds.has(String(id))) return { field, score: -100 };
    const hasDictionary = Number(field.dictionary_id || 0) || (Array.isArray(field.values) && field.values.length);
    if (!hasDictionary) return { field, score: -100 };
    let score = 0;
    if (strongIds.has(String(id))) score += 100;
    if (weakIds.has(String(id))) score += 12;
    if (field.required) score += 4;
    if (Array.isArray(field.values) && field.values.length) score += 8;
    score += variantOptionQuality(field, kind);
    positive.forEach((keyword) => { if (text.includes(compactAttributeText(keyword))) score += 18; });
    negative.forEach((keyword) => { if (text.includes(compactAttributeText(keyword))) score -= 40; });
    if (kind === "spec" && text.includes(compactAttributeText("модель")) && !text.includes(compactAttributeText("размер"))) score -= 8;
    if (kind === "color" && weakIds.has(String(id)) && !positive.some((keyword) => text.includes(compactAttributeText(keyword)))) score -= 45;
    return { field, score };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score);
  return ranked[0]?.field || null;
}

const variantColorAttribute = computed(() => findVariantDictionaryAttribute("color"));
const variantSpecAttribute = computed(() => findVariantDictionaryAttribute("spec", {
  excludeIds: [variantColorAttribute.value?.attribute_id]
}));

function variantDictionaryOptions(field = {}) {
  return renderedAttributeOptions(field)
    .map((option) => String(option?.value || option?.label || "").trim())
    .filter(Boolean);
}

function ensureVariantDictionaryOptions(field = {}, visible = true) {
  if (!field) return;
  ensureAttributeValuesLoaded(field, visible);
}

function normalizeDynamicAttributeEntries(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([key, val]) => ({
    attribute_id: /^\d+$/.test(String(key)) ? key : "",
    name: val?.name || val?.attribute_name || key,
    value: val?.value ?? val?.values ?? val
  }));
}

function unwrapDynamicAttributeValue(value) {
  if (Array.isArray(value)) return value.map(unwrapDynamicAttributeValue).filter(Boolean).join(", ");
  if (value && typeof value === "object") return value.value ?? value.name ?? value.label ?? value.text ?? "";
  return value ?? "";
}

function extractVariantDynamicAttribute(item = {}, field = null, kind = "color") {
  const entries = normalizeDynamicAttributeEntries(item.dynamic_attributes || item.attributes || item.attribute_values);
  if (!entries.length) return "";
  const targetId = String(field?.attribute_id || "");
  const targetName = compactAttributeText(field?.name || field?.raw?.name || "");
  const fallback = entries.find((entry) => {
    const entryId = String(entry.attribute_id || entry.id || "");
    const entryName = compactAttributeText(entry.name || entry.attribute_name || "");
    if (targetId && entryId === targetId) return true;
    if (targetName && entryName && (entryName.includes(targetName) || targetName.includes(entryName))) return true;
    const text = compactAttributeText(`${entry.name || ""}|${entry.attribute_name || ""}`);
    return kind === "color"
      ? ["color", "цвет", "颜色"].some((keyword) => text.includes(compactAttributeText(keyword)))
      : ["size", "размер", "model", "модель", "型号", "规格"].some((keyword) => text.includes(compactAttributeText(keyword)));
  });
  return String(unwrapDynamicAttributeValue(fallback?.value ?? fallback?.values)).trim();
}

function attributeHasMoreOptions(field = {}) {
  return Array.isArray(field.values) && field.values.length > ATTRIBUTE_OPTION_RENDER_LIMIT;
}

async function ensureAttributeValuesLoaded(field = {}, visible = true) {
  if (!visible || !Number(field.dictionary_id || 0) || !Number(field.attribute_id || 0)) return;
  if (!templateEditor.description_category_id || !templateEditor.type_id) return;
  if (Array.isArray(field.values) && field.values.length > ATTRIBUTE_OPTION_RENDER_LIMIT) return;
  const key = attributeFieldKey(field);
  if (attributeValueLoading[key]) return;
  attributeValueLoading[key] = true;
  try {
    const params = new URLSearchParams({
      description_category_id: String(templateEditor.description_category_id),
      type_id: String(templateEditor.type_id),
      attribute_id: String(field.attribute_id),
      limit: "120"
    });
    const values = await apiClient.get(`/api/listing/ozon-attribute-values?${params.toString()}`, { noCache: true });
    if (Array.isArray(values) && values.length) field.values = values;
  } catch {
    // Keep the editor responsive even when a large dictionary fails to load.
  } finally {
    attributeValueLoading[key] = false;
  }
}

function isFixedAttributeField(field = {}) {
  const name = String(field.name || "").toLowerCase();
  return (isCategoryTypeAttribute(field) && hasAttributeValue(field))
    || (isTopicTagAttribute(field) && (hasAttributeValue(field) || fixedForm.value.tags.length))
    || fixedAttributeNames().some((keyword) => keyword && name.includes(String(keyword).toLowerCase()));
}

function isRecommendedAttributeField(field = {}) {
  const name = String(field.name || "").toLowerCase();
  const keywords = [
    "material", "country", "warranty", "quantity", "oem", "pdf", "video",
    "材质", "材料", "制造国", "保修", "数量", "适配", "车型", "配置", "备件", "零件", "位置",
    "屑邪褌械褉懈邪谢", "褋褌褉邪薪邪", "谐邪褉邪薪褌", "泻芯谢懈褔械褋褌胁芯", "屑芯写械谢褜", "邪胁褌芯屑芯斜"
  ];
  return keywords.some((keyword) => name.includes(keyword));
}

function sortSchemaAttributeFields(a = {}, b = {}) {
  return Number(b.required) - Number(a.required)
    || Number(isRecommendedAttributeField(b)) - Number(isRecommendedAttributeField(a))
    || Number(!hasAttributeValue(a)) - Number(!hasAttributeValue(b))
    || Number(a.sort_order || 0) - Number(b.sort_order || 0);
}

function getAttributeByNames(names, fallback = "") {
  const list = expandAttributeNameAliases(Array.isArray(names) ? names : [names]);
  return templateEditor.attributes.find((item) => list.some((name) => String(item.name || "").includes(name)))?.value || fallback;
}

function getAttributeByIdsOrNames(ids = [], names = [], fallback = "") {
  const idSet = new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id || "")).filter(Boolean));
  const byId = templateEditor.attributes.find((item) => idSet.has(String(item.attribute_id || item.id || "")));
  if (byId?.value !== undefined && byId.value !== null && byId.value !== "") return byId.value;
  return getAttributeByNames(names, fallback);
}

function setAttributeByNames(names, value, defaults = {}) {
  const list = expandAttributeNameAliases(Array.isArray(names) ? names : [names]);
  const existing = templateEditor.attributes.find((item) => list.some((name) => String(item.name || "").includes(name)));
  if (existing) {
    existing.value = value;
    if (defaults.required) existing.required = true;
    if (defaults.attribute_id && !existing.attribute_id) existing.attribute_id = defaults.attribute_id;
    if (defaults.dictionary_id && !existing.dictionary_id) existing.dictionary_id = defaults.dictionary_id;
    if (defaults.source && !existing.source) existing.source = defaults.source;
    return;
  }
  templateEditor.attributes.push({
    name: defaults.name || list[0],
    value,
    type: defaults.type || "text",
    required: Boolean(defaults.required),
    attribute_id: defaults.attribute_id || "",
    dictionary_id: defaults.dictionary_id || "",
    values: defaults.values || [],
    source: "fixed_form",
    sort_order: templateEditor.attributes.length + 1
  });
}

function setAttributeByIdsOrNames(ids = [], names = [], value, defaults = {}) {
  const idSet = new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id || "")).filter(Boolean));
  const existingById = templateEditor.attributes.find((item) => idSet.has(String(item.attribute_id || item.id || "")));
  if (existingById) {
    existingById.value = value;
    if (defaults.required) existingById.required = true;
    if (defaults.source && !existingById.source) existingById.source = defaults.source;
    return;
  }
  setAttributeByNames(names, value, defaults);
}

function syncFixedFormAttributes() {
  const brand = String(fixedForm.value.brand || "").trim() || "无品牌";
  setAttributeByNames(["品牌", "Бренд"], brand, { name: "品牌", required: true, attribute_id: 85, source: "fixed_form" });
  if (fixedForm.value.model) setAttributeByIdsOrNames([9048], ["型号名称", "Модель"], fixedForm.value.model, { name: "型号名称", required: true, attribute_id: 9048, source: "fixed_form" });
  if (fixedForm.value.tags?.length) setAttributeByNames(["产品标签", "主题标签", "主图标签", "ключевые слова", "тег"], fixedForm.value.tags.join(","), { name: "产品标签", attribute_id: 23171, source: "fixed_form" });
  if (fixedForm.value.summary) setAttributeByNames(["简介", "Аннотация", "Описание"], fixedForm.value.summary, { name: "简介", source: "fixed_form" });
  if (fixedForm.value.richJson) setAttributeByNames(["JSON富内容", "Rich", "rich"], fixedForm.value.richJson, { name: "JSON富内容", source: "fixed_form" });
}

const fixedForm = computed({
  get() {
    return {
      brand: getAttributeByNames(["品牌", "Бренд"], "无品牌"),
      model: getAttributeByIdsOrNames([9048], ["型号名称", "Модель"], ""),
      tags: splitTagValue(getAttributeByNames(["产品标签", "主题标签", "主图标签", "ключевые слова", "тег"], "")),
      summary: getAttributeByNames(["简介", "Аннотация", "Описание"], ""),
      richJson: getAttributeByNames(["JSON富内容", "Rich", "rich"], "")
    };
  },
  set(value) {
    setAttributeByNames(["品牌", "Бренд"], value.brand, { name: "品牌", required: true });
    setAttributeByIdsOrNames([9048], ["型号名称", "Модель"], value.model, { name: "型号名称", required: true, attribute_id: 9048 });
    setAttributeByNames(["产品标签", "主题标签", "主图标签", "ключевые слова", "тег"], (value.tags || []).join(","), { name: "产品标签" });
    setAttributeByNames(["简介", "Аннотация", "Описание"], value.summary, { name: "简介" });
    setAttributeByNames(["JSON富内容", "Rich", "rich"], value.richJson, { name: "JSON富内容" });
  }
});

function splitTagValue(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[\s,，;；|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}
function cmToMm(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 10) : 0;
}

function updateFixedField(key, value) {
  fixedForm.value = { ...fixedForm.value, [key]: value };
}

function normalizeAttributeType(item) {
  if (item?.is_collection) return "multiselect";
  const type = String(item?.type || "").toLowerCase();
  if (["select", "multiselect", "textarea", "number", "boolean", "rich_json"].includes(type)) return type;
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
  const colorAttribute = findVariantDictionaryAttribute("color");
  const specAttribute = findVariantDictionaryAttribute("spec", { excludeIds: [colorAttribute?.attribute_id] });
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
    color: item?.color || extractVariantDynamicAttribute(item, colorAttribute, "color") || "",
    spec: item?.spec || extractVariantDynamicAttribute(item, specAttribute, "spec") || "",
    main_tags: splitTagValue(item?.main_tags || item?.hashtags || item?.tags || ""),
    weight_g: Number(item?.weight_g || templateEditor.weight_g || 0),
    length_mm: normalizeVariantDimensionMm(item?.length_mm, item?.depth, item?.length_cm, templateEditor.length_cm),
    width_mm: normalizeVariantDimensionMm(item?.width_mm, item?.width, item?.width_cm, templateEditor.width_cm),
    height_mm: normalizeVariantDimensionMm(item?.height_mm, item?.height, item?.height_cm, templateEditor.height_cm),
    stock: Number(item?.stock || 0),
    dynamic_attributes: item?.dynamic_attributes || {},
    sort_order: Number(item?.sort_order || index + 1)
  }));
}

function normalizeVariantDimensionMm(mmValue, legacyMmValue, cmValue, fallbackCmValue) {
  const mm = Number(mmValue || legacyMmValue || 0);
  if (Number.isFinite(mm) && mm > 0) return mm;
  return cmToMm(cmValue || fallbackCmValue || 0);
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
    length_mm: cmToMm(templateEditor.length_cm),
    width_mm: cmToMm(templateEditor.width_cm),
    height_mm: cmToMm(templateEditor.height_cm),
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
    name: row.name ? `${row.name} 鍓湰` : templateEditor.title || "",
    title: row.title ? `${row.title} 鍓湰` : templateEditor.title || "",
    images: Array.isArray(row.images) ? row.images.map((item) => ({ ...item })) : [],
    video_cover_urls: Array.isArray(row.video_cover_urls) ? row.video_cover_urls.slice() : [],
    video_urls: Array.isArray(row.video_urls) ? row.video_urls.slice() : [],
    main_tags: Array.isArray(row.main_tags) ? row.main_tags.slice() : []
  };
  if (index >= 0) templateEditor.variants.splice(index + 1, 0, copy);
  else templateEditor.variants.push(copy);
}

function offerIdPrefix() {
  const brand = String(fixedForm.value.brand || "").trim().replace(/\s+/g, "-").toUpperCase() || "OZON";
  const productType = String(templateEditor.category_name || templateEditor.template_name || "").trim();
  return { brand, productType };
}

function cleanOfferIdPart(value = "", fallback = "OZON") {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/_+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase();
  return (normalized || fallback).slice(0, 24);
}

function productTypeAbbr(value = "") {
  const words = String(value || "").match(/[A-Za-z0-9]+/g) || [];
  if (!words.length) return "SKU";
  if (words.length === 1) return words[0].slice(0, 5).toUpperCase();
  return words.slice(0, 4).map((word) => word[0]).join("").toUpperCase();
}

function generateLocalOfferId(existingIds = new Set(), index = 0) {
  const { brand, productType } = offerIdPrefix();
  const prefix = `${cleanOfferIdPart(brand)}-${cleanOfferIdPart(productTypeAbbr(productType), "SKU")}`;
  for (let offset = 0; offset < 1000; offset += 1) {
    const suffix = String(index + offset + 1).padStart(3, "0");
    const id = `${prefix}-${suffix}`;
    if (!existingIds.has(id)) {
      existingIds.add(id);
      return id;
    }
  }
  const fallback = `${prefix}-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  existingIds.add(fallback);
  return fallback;
}

function generateVariantOfferId(row) {
  if (!row) return;
  const existingIds = new Set(templateEditor.variants.map((item) => String(item.offer_id || "").trim()).filter(Boolean));
  existingIds.delete(String(row.offer_id || "").trim());
  row.offer_id = generateLocalOfferId(existingIds, templateEditor.variants.indexOf(row));
}

function generateMissingVariantOfferIds() {
  const rows = templateEditor.variants.filter((item) => !String(item.offer_id || "").trim());
  if (!rows.length) {
    ElMessage.success("所有变体都有货号 / offer_id");
    return;
  }
  const existingIds = new Set(templateEditor.variants.map((item) => String(item.offer_id || "").trim()).filter(Boolean));
  rows.forEach((row, index) => {
    row.offer_id = generateLocalOfferId(existingIds, templateEditor.variants.indexOf(row) + index);
  });
  ElMessage.success(`已生成 ${rows.length} 个货号 / offer_id`);
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

async function runVariantColumnAi(field) {
  if (!templateEditor.variants.length) {
    ElMessage.warning("请先添加变体");
    return;
  }
  aiGenerating.value = true;
  try {
    const request = normalizeAiFieldRequest({ name: variantAiFieldLabel(field), target: `variant.${field}`, type: inferVariantDeepSeekType(field) });
    const result = await callDeepSeekGenerate(request.aiType, {
      ...buildDeepSeekContext(request),
      targetVariantField: field
    });
    const changed = applyVariantColumnAiResult(field, normalizeDeepSeekResponse(result));
    if (!changed) {
      ElMessage.warning("DeepSeek 已返回，但没有匹配到变体列内容");
      return;
    }
    ElMessage.success(`DeepSeek 已回填变体列：${variantAiFieldLabel(field)}`);
  } catch (error) {
    ElMessage.error(error.message || "DeepSeek 生成失败");
  } finally {
    aiGenerating.value = false;
  }
}

function variantAiFieldLabel(field) {
  const map = { title: "标题", main_tags: "产品标签", color: "颜色", spec: "规格/型号" };
  return map[field] || field;
}
function inferVariantDeepSeekType(field) {
  if (field === 'title') return 'title';
  if (field === 'main_tags') return 'tags';
  return 'attributeFill';
}

function applyVariantColumnAiResult(field, result = {}) {
  const rows = Array.isArray(result.variants) ? result.variants : Array.isArray(result.rows) ? result.rows : [];
  let changed = 0;
  if (rows.length) {
    rows.forEach((item, index) => {
      const row = templateEditor.variants[index];
      if (!row) return;
      const value = item[field] ?? item.value ?? item.title ?? item.name ?? item.color ?? item.spec ?? item.tags ?? item.main_tags;
      if (value !== undefined && value !== null && value !== "") {
        row[field] = field === "main_tags" ? normalizeAiTags(value) : value;
        changed += 1;
      }
    });
    return changed;
  }
  const lines = String(result.content || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (!lines.length) return 0;
  templateEditor.variants.forEach((row, index) => {
    const value = lines[index] || lines[0];
    row[field] = field === "main_tags" ? normalizeAiTags(value) : value;
    changed += 1;
  });
  return changed;
}
function expandAttributeNameAliases(names = []) {
  const list = names.map((name) => String(name || "")).filter(Boolean);
  const text = list.join("|");
  const add = (items) => items.forEach((item) => { if (!list.includes(item)) list.push(item); });
  if (/品牌|Бренд/i.test(text)) add(["品牌", "Бренд"]);
  if (/型号|Модель/i.test(text)) add(["型号名称", "型号", "Модель"]);
  if (/标签|tag|тег|ключ/i.test(text)) add(["产品标签", "主题标签", "主图标签", "tag", "тег", "ключевые слова"]);
  if (/简介|Аннотация|Описание/i.test(text)) add(["简介", "Аннотация", "Описание"]);
  if (/JSON|富内容|rich/i.test(text)) add(["JSON富内容", "Rich", "rich"]);
  if (/材料|材质|material|материал/i.test(text)) add(["材料", "材质", "material", "материал"]);
  return list;
}

function enableVariantField(field) {
  setVariantFieldMode(field, !variantFieldMode[field]);
}

function setVariantFieldMode(field, enabled) {
  variantFieldMode[field] = Boolean(enabled);
  if (!variantFieldMode[field]) {
    moveVariantFieldBackToCommon(field);
    return;
  }
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
      row.length_mm = Number(row.length_mm || cmToMm(templateEditor.length_cm) || 0);
      row.width_mm = Number(row.width_mm || cmToMm(templateEditor.width_cm) || 0);
      row.height_mm = Number(row.height_mm || cmToMm(templateEditor.height_cm) || 0);
    });
  } else if (field === "tags") {
    templateEditor.variants.forEach((row) => {
      row.main_tags = Array.isArray(row.main_tags) && row.main_tags.length ? row.main_tags : fixedForm.value.tags.slice();
    });
  }
}

function disableVariantField(field) {
  setVariantFieldMode(field, false);
}

function moveVariantFieldBackToCommon(field) {
  const rows = templateEditor.variants || [];
  if (field === "title") {
    const value = rows.map((row) => row.title).find((value) => String(value || "").trim());
    if (value) templateEditor.title = value;
  } else if (field === "weight") {
    const value = rows.map((row) => Number(row.weight_g || 0)).find((value) => value > 0);
    if (value) templateEditor.weight_g = value;
  } else if (field === "dimensions") {
    const row = rows.find((item) => Number(item.length_mm || 0) || Number(item.width_mm || 0) || Number(item.height_mm || 0));
    if (row) {
      templateEditor.length_cm = Number(row.length_mm || 0) / 10 || Number(templateEditor.length_cm || 0);
      templateEditor.width_cm = Number(row.width_mm || 0) / 10 || Number(templateEditor.width_cm || 0);
      templateEditor.height_cm = Number(row.height_mm || 0) / 10 || Number(templateEditor.height_cm || 0);
    }
  } else if (field === "tags") {
    const value = rows.map((row) => row.main_tags).find((value) => Array.isArray(value) && value.length);
    if (value) updateFixedField("tags", value.slice());
  }
  ElMessage.success("已合并为公共字段");
}

function cloneVariantValue(value) {
  if (Array.isArray(value)) return value.map((item) => (item && typeof item === "object" ? { ...item } : item));
  if (value && typeof value === "object") return { ...value };
  return value;
}

function variantPreviewImages(row) {
  const images = Array.isArray(row?.images) && row.images.length ? row.images : templateEditor.images.slice(0, 1);
  const filtered = images.filter((item) => item?.url);
  if (filtered.length <= 3) return filtered;
  return [filtered[0], filtered[1], filtered[filtered.length - 1]];
}

function variantImageOverflow(row) {
  const images = Array.isArray(row?.images) && row.images.length ? row.images : templateEditor.images.slice(0, 1);
  return Math.max(images.filter((item) => item?.url).length - 3, 0);
}

function variantPreviewList(row) {
  const images = Array.isArray(row?.images) && row.images.length ? row.images : templateEditor.images.slice(0, 1);
  return images.filter((item) => item?.url).map((item) => item.previewUrl || item.url);
}

function ensureVariantOwnImages(row) {
  if (!row) return [];
  if (!Array.isArray(row.images)) row.images = [];
  return row.images;
}

function openVariantImageEditor(row) {
  ensureVariantOwnImages(row);
  variantImageEditor.row = row;
  variantImageEditor.selectedUrls = ensureVariantOwnImages(row).map((item) => item.url).filter(Boolean);
  variantImageEditor.activeTab = "sku";
  variantImageEditor.visible = true;
}

function variantImageUrl(image) {
  return String(image?.previewUrl || image?.url || image || "").trim();
}

function isVariantImageSelected(image) {
  const url = variantImageUrl(image);
  return url && variantImageEditor.selectedUrls.includes(url);
}

function toggleVariantImageSelection(image) {
  const url = variantImageUrl(image);
  if (!url) return;
  const index = variantImageEditor.selectedUrls.indexOf(url);
  if (index >= 0) variantImageEditor.selectedUrls.splice(index, 1);
  else variantImageEditor.selectedUrls.push(url);
}

function variantImageLibrary() {
  const sources = [
    ...ensureVariantOwnImages(variantImageEditor.row),
    ...templateEditor.images,
    ...templateEditor.variants.flatMap((row) => Array.isArray(row.images) ? row.images : [])
  ];
  return dedupeImages(sources).filter((item) => item.url).map((item, index) => ({ ...item, sort_order: item.sort_order || index + 1 }));
}

function confirmVariantImageEditor() {
  if (!variantImageEditor.row) return;
  const byUrl = new Map(variantImageLibrary().map((item) => [variantImageUrl(item), item]));
  variantImageEditor.row.images = variantImageEditor.selectedUrls.map((url, index) => ({
    ...(byUrl.get(url) || {}),
    url,
    sort_order: index + 1
  }));
  variantImageEditor.visible = false;
  ElMessage.success("已更新 SKU 图片");
}

function addVariantImageLink() {
  const images = ensureVariantOwnImages(variantImageEditor.row);
  images.push({ url: "", name: "", sort_order: images.length + 1 });
}

function removeVariantImage(index) {
  const images = ensureVariantOwnImages(variantImageEditor.row);
  images.splice(index, 1);
}

function useTemplateImagesForVariant() {
  if (!variantImageEditor.row) return;
  variantImageEditor.row.images = templateEditor.images.filter((item) => item.url).map((item, index) => ({ ...item, sort_order: index + 1 }));
  variantImageEditor.selectedUrls = variantImageEditor.row.images.map((item) => item.url).filter(Boolean);
  ElMessage.success("已使用模板图片");
}

function variantMediaRoleLabel(index, total) {
  if (index === 0) return "首图";
  if (index === total - 1) return "尾图";
  return `详情${index}`;
}

function ensureVariantLinks(row, field) {
  if (!row) return [];
  if (!Array.isArray(row[field])) row[field] = normalizeVariantLinks(row[field] || "");
  return row[field];
}

function variantPreviewVideos(row, field) {
  return ensureVariantLinks(row, field).filter(Boolean).slice(0, 2);
}

function variantVideoOverflow(row, field) {
  return Math.max(ensureVariantLinks(row, field).filter(Boolean).length - 2, 0);
}

function openVariantVideoEditor(row, field, title) {
  ensureVariantLinks(row, field);
  variantVideoEditor.row = row;
  variantVideoEditor.field = field;
  variantVideoEditor.title = title;
  variantVideoEditor.visible = true;
}

function addVariantVideoLink() {
  ensureVariantLinks(variantVideoEditor.row, variantVideoEditor.field).push("");
}

function setPrimaryVariantVideo(value) {
  const links = ensureVariantLinks(variantVideoEditor.row, variantVideoEditor.field);
  if (links.length) links[0] = value;
  else links.push(value);
}

function clearVariantVideos() {
  const links = ensureVariantLinks(variantVideoEditor.row, variantVideoEditor.field);
  links.splice(0, links.length);
}

function removeVariantVideoLink(index) {
  ensureVariantLinks(variantVideoEditor.row, variantVideoEditor.field).splice(index, 1);
}

function richContentImageUrl() {
  const variantTail = templateEditor.variants
    .flatMap((row) => Array.isArray(row.images) ? row.images : [])
    .filter((item) => item?.url)
    .at(-1);
  const templateTail = templateEditor.images.filter((item) => item?.url).at(-1);
  return (variantTail || templateTail)?.url || templateEditor.images.find((item) => item?.url)?.url || "";
}

function generateRichContentJson() {
  const imageUrl = richContentImageUrl();
  const text = String(fixedForm.value.summary || templateEditor.description || "").trim();
  if (!imageUrl) {
    ElMessage.warning("请先准备尾图或商品图片");
    return "";
  }
  if (!text) {
    ElMessage.warning("请先填写俄语简介");
    return "";
  }
  const rich = {
    content: [
      {
        widgetName: "raShowcase",
        type: "billboard",
        blocks: [
          {
            imgLink: "",
            img: {
              src: imageUrl,
              srcMobile: imageUrl,
              alt: templateEditor.title || "",
              position: "width_full",
              positionMobile: "width_full",
              widthMobile: 1024,
              heightMobile: 1536
            },
            title: {
              items: [{ type: "text", content: templateEditor.title || "" }],
              size: "size4",
              align: "left",
              color: "color1"
            },
            text: {
              size: "size2",
              align: "left",
              color: "color1",
              items: [{ type: "text", content: text }]
            }
          }
        ]
      }
    ],
    version: 0.3
  };
  const json = JSON.stringify(rich, null, 2);
  updateFixedField("richJson", json);
  ElMessage.success("已生成 JSON 富内容");
  return json;
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

function currentShopName() {
  const id = draftForm.shop_ids[0] || copyForm.shop_id || '';
  return state.shops.find((shop) => String(shop.id) === String(id))?.name || '';
}

function applyRuleBasedAttributeDefaults(fields = templateEditor.attributes) {
  let filled = 0;
  for (const field of fields) {
    if (!field || hasAttributeValue(field)) continue;
    if (shouldSkipAiAttribute(field)) continue;
    const value = ruleBasedAttributeValue(field);
    if (value === undefined || value === null || value === '') continue;
    field.value = normalizeAttributeAiValue(value, field);
    filled += 1;
  }
  return filled;
}

function ruleBasedAttributeValue(field = {}) {
  const name = String(field.name || '').toLowerCase();
  const shopName = currentShopName();
  const candidates = [];
  if (/seller|vendor|code|\u5356\u5bb6|\u4f9b\u5e94\u5546|\u5e97\u94fa|\u4ee3\u7801/.test(name) && shopName) candidates.push(shopName);
  if (/warranty|guarantee|\u4fdd\u8d28|\u4fdd\u4fee|\u6709\u6548\u671f|\u0441\u0440\u043e\u043a/.test(name)) candidates.push('30 \u0434\u043d\u0435\u0439', '30');
  if (/country|\u5236\u9020\u56fd|\u539f\u4ea7\u56fd|\u56fd\u5bb6/.test(name)) candidates.push('\u041a\u0438\u0442\u0430\u0439', 'China', '\u4e2d\u56fd');
  if (/brand|\u54c1\u724c/.test(name)) candidates.push(fixedForm.value.brand || '\u041d\u0435\u0442 \u0431\u0440\u0435\u043d\u0434\u0430');
  if (/model|\u578b\u53f7|\u6a21\u578b/.test(name)) candidates.push(fixedForm.value.model || templateEditor.spec);
  if (/quantity|\u6570\u91cf/.test(name)) candidates.push('1');
  if (/material|\u6750\u8d28|\u6750\u6599/.test(name)) candidates.push(getAttributeByNames(['material', '\u6750\u8d28', '\u6750\u6599'], ''));
  return chooseAttributeCandidate(field, candidates);
}

function chooseAttributeCandidate(field = {}, candidates = []) {
  const cleanCandidates = candidates.map((item) => String(item || '').trim()).filter(Boolean);
  if (!cleanCandidates.length) return '';
  const options = Array.isArray(field.values) ? field.values : [];
  if (options.length) {
    for (const candidate of cleanCandidates) {
      const hit = options.find((option) => {
        const text = String(option.value || option.label || '').toLowerCase();
        const needle = candidate.toLowerCase();
        return text === needle || text.includes(needle) || needle.includes(text);
      });
      if (hit) return hit.value || hit.label;
    }
    return '';
  }
  return cleanCandidates[0];
}

function normalizedText(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function categoryLeafName() {
  const raw = String(templateEditor.category_name || "").replace(/\([^)]*\)/g, "");
  const parts = raw.split(/[/>|]/).map((item) => item.trim()).filter(Boolean);
  return parts[parts.length - 1] || raw.trim();
}

function isCategoryTypeAttribute(field = {}) {
  const name = normalizedText(field.name);
  if (!name || /\bid\b/.test(name)) return false;
  return /(^|\s)type($|\s)|\u0432\u0438\u0434|\u0442\u0438\u043f|\u7c7b\u578b|\u4ea7\u54c1\u7c7b\u578b|\u5546\u54c1\u7c7b\u578b/.test(name);
}

function isTopicTagAttribute(field = {}) {
  const name = normalizedText(field.name);
  return /topic tag|subject tag|theme tag|tags?|\u0442\u0435\u0433|\u043a\u043b\u044e\u0447\u0435\u0432|\u4e3b\u9898\u6807\u7b7e|\u4ea7\u54c1\u6807\u7b7e|\u5546\u54c1\u6807\u7b7e|\u5173\u952e\u8bcd/.test(name);
}

function isOriginCountryAttribute(field = {}) {
  const name = normalizedText(field.name);
  return /origin country|country of origin|manufactur.*country|country|\u0441\u0442\u0440\u0430\u043d\u0430|\u0438\u0437\u0433\u043e\u0442\u043e\u0432|\u5236\u9020\u56fd|\u539f\u4ea7\u56fd|\u751f\u4ea7\u56fd|\u56fd\u5bb6/.test(name);
}

function isMaterialAttribute(field = {}) {
  const name = normalizedText(field.name);
  return /material|\u043c\u0430\u0442\u0435\u0440\u0438\u0430\u043b|\u6750\u6599|\u6750\u8d28/.test(name);
}

function isProductCodeAttribute(field = {}) {
  const name = normalizedText(field.name);
  if (/offer|sku|barcode|pdf|file|\u6587\u4ef6|\u6761\u5f62\u7801/.test(name)) return false;
  return /seller.*code|vendor.*code|product.*code|article|vendor code|\u0430\u0440\u0442\u0438\u043a\u0443\u043b|\u5356\u5bb6.*\u4ee3\u7801|\u4ea7\u54c1.*\u4ee3\u7801|\u5546\u54c1.*\u4ee3\u7801|\u4f9b\u5e94\u5546.*\u4ee3\u7801/.test(name);
}

function isPdfAttribute(field = {}) {
  const name = normalizedText(field.name);
  return /pdf|file|certificate|manual|instruction|\u0444\u0430\u0439\u043b|\u0441\u0435\u0440\u0442\u0438\u0444|\u0438\u043d\u0441\u0442\u0440\u0443\u043a|\u6587\u4ef6|\u8bc1\u4e66|\u8bf4\u660e\u4e66/.test(name);
}

function shouldSkipAiAttribute(field = {}) {
  return isPdfAttribute(field);
}

function applyMappedValue(field, candidates = []) {
  if (!field || hasAttributeValue(field)) return false;
  let value = chooseAttributeCandidate(field, candidates);
  if (!value && Array.isArray(field.values) && field.values.length === 1) {
    value = field.values[0]?.value || field.values[0]?.label || "";
  }
  if (!value) return false;
  field.value = normalizeAttributeAiValue(value, field);
  return hasAttributeValue(field);
}

function applyOzonAttributeMappings() {
  const tags = fixedForm.value.tags || [];
  const categoryLeaf = categoryLeafName();
  const shopName = currentShopName();
  for (const field of templateEditor.attributes) {
    if (!field) continue;
    if (isCategoryTypeAttribute(field)) {
      applyMappedValue(field, [categoryLeaf, templateEditor.category_name]);
    } else if (isTopicTagAttribute(field)) {
      if (!tags.length && hasAttributeValue(field)) {
        updateFixedField("tags", splitTagValue(field.value));
      } else {
        applyMappedValue(field, [tags.join(",")]);
      }
    } else if (isOriginCountryAttribute(field)) {
      applyMappedValue(field, ["\u041a\u0438\u0442\u0430\u0439", "China", "\u4e2d\u56fd"]);
    } else if (isProductCodeAttribute(field)) {
      applyMappedValue(field, [shopName]);
    } else if (isMaterialAttribute(field)) {
      applyMappedValue(field, [
        getAttributeByNames(["material", "\u6750\u8d28", "\u6750\u6599"], ""),
        templateEditor.spec
      ]);
    }
  }
}

function runFieldAiPlaceholder(field) {
  ElMessage.info(`${field.name || "当前字段"} 的 AI 自动填写会在 AI 配置完成后启用`);
}

async function runDeepSeekFieldAi(field = {}) {
  const normalizedField = normalizeAiFieldRequest(field);
  aiGenerating.value = true;
  try {
    if (normalizedField.attributeField && shouldSkipAiAttribute(normalizedField.attributeField)) {
      ElMessage.warning("PDF / 文件类属性暂不由 AI 填写，请保留为空或手动上传");
      return;
    }
    const targetFields = normalizedField.attributeField
      ? [normalizedField.attributeField]
      : normalizedField.aiType === "attributeFill"
        ? templateEditor.attributes.filter((item) => item.required && !hasAttributeValue(item) && !shouldSkipAiAttribute(item))
        : [];
    applyRuleBasedAttributeDefaults(targetFields);
    const result = await callDeepSeekGenerate(normalizedField.aiType, buildDeepSeekContext(normalizedField));
    const aiResult = normalizeDeepSeekResponse(result);
    const changed = applyListingAiResult(aiResult, normalizedField);
    if (!changed) {
      ElMessage.warning("DeepSeek 已返回，但没有匹配到可回填内容，请换一个字段或检查提示词配置");
      return;
    }
    ElMessage.success(`DeepSeek 已回填：${normalizedField.label || normalizedField.name || "当前字段"}`);
  } catch (error) {
    ElMessage.error(error.message || "DeepSeek 生成失败，请检查 AI 配置");
  } finally {
    aiGenerating.value = false;
  }
}

async function callDeepSeekGenerate(type, context) {
  return apiClient.post("/api/ai/deepseek/generate", { type, context });
}

function normalizeAiFieldRequest(field = {}) {
  const name = String(field.name || field.label || "all");
  const target = String(field.target || "").trim();
  const aiType = inferDeepSeekType(field);
  return {
    ...field,
    name,
    label: field.label || name,
    target,
    aiType,
    outputContract: aiOutputContract(aiType, field)
  };
}

function inferDeepSeekType(field = {}) {
  const directType = String(field.type || "").trim();
  const allowed = new Set(["listingForm", "title", "keywords", "tags", "description", "shortDescription", "categorySuggest", "attributeFill", "translateRu", "optimizeSeo", "imageCopy"]);
  if (allowed.has(directType)) return directType;
  const name = String(field.name || "").toLowerCase();
  const target = String(field.target || "").toLowerCase();
  if (!name || name === "all") return "listingForm";
  if (/标题|title/.test(name) || target === "title") return "title";
  if (/标签|tag|keyword|关键词/.test(name) || target === "tags") return "tags";
  if (/简介|卖点|summary|short/.test(name) || target === "summary") return "shortDescription";
  if (/json|富内容|rich/.test(name) || target === "richjson") return "description";
  if (/类目|category/.test(name)) return "categorySuggest";
  return "attributeFill";
}

function aiOutputContract(type, field = {}) {
  if (type === "listingForm") {
    return {
      content: "one sentence status summary",
      fields: {
        title: "Russian Ozon title",
        model: "random stable model name / vendor model, not material",
        tags: ["#russian_tag"],
        summary: "100-150 Russian words, SEO-aligned with title/tags/selling points/use scene",
        richJson: "Ozon rich-content JSON string using tail image plus SEO-aligned copy",
        attributes: { "attribute_id_or_name": "value chosen from options when options exist" },
        variants: [{ index: 0, title: "", color: "", spec: "", main_tags: [] }]
      }
    };
  }
  if (type === "title") return { content: "Russian title", fields: { title: "Russian title" } };
  if (type === "tags" || type === "keywords") return { content: "tags", fields: { tags: ["#tag"] } };
  if (type === "shortDescription") return { content: "Russian description", fields: { summary: "100-150 Russian words aligned with title, tags, selling points and use scenes" } };
  if (type === "description") return { content: "Russian text or rich JSON", fields: { richJson: "Ozon rich-content JSON string with tail image and SEO-aligned text", summary: "Russian description aligned with title and tags" } };
  if (field.attributeField) return { content: "attribute value", fields: { value: "value", attributes: { [field.attributeField.attribute_id || field.attributeField.name || "attribute"]: "value" } } };
  return { content: "attribute values", fields: { attributes: { "attribute_id_or_name": "value" } } };
}

function buildDeepSeekContext(field = {}) {
  const payload = buildTemplatePayload();
  const targetAttribute = field.attributeField ? serializeAiAttribute(field.attributeField, true) : null;
  return {
    target: {
      type: field.aiType || inferDeepSeekType(field),
      name: field.name || "all",
      path: field.target || "",
      outputContract: field.outputContract || aiOutputContract(field.aiType || inferDeepSeekType(field), field),
      attribute: targetAttribute
    },
    marketplace: "Ozon Russia",
    language: "Russian",
    materialPackage: referencedMaterialPackage.value,
    form: payload,
    fixedFields: {
      shopNames: draftForm.shop_ids.map((id) => state.shops.find((shop) => String(shop.id) === String(id))?.name).filter(Boolean),
      categoryName: templateEditor.category_name,
      ozonCategoryId: templateEditor.ozon_category_id,
      title: templateEditor.title,
      brand: fixedForm.value.brand,
      model: fixedForm.value.model,
      tags: fixedForm.value.tags,
      summary: fixedForm.value.summary,
      dimensionsCm: {
        length: Number(templateEditor.length_cm || 0),
        width: Number(templateEditor.width_cm || 0),
        height: Number(templateEditor.height_cm || 0),
        weightG: Number(templateEditor.weight_g || 0)
      }
    },
    sourceHints: {
      productType: templateEditor.category_name,
      material: getAttributeByNames(["材质", "材料", "material", "материал"], ""),
      compatibleCars: getAttributeByNames(["适配", "车型", "vehicle", "автомобиль"], ""),
      color: templateEditor.color || templateEditor.variants.find((item) => item.color)?.color || "",
      spec: templateEditor.spec || templateEditor.variants.find((item) => item.spec)?.spec || ""
    },
    media: {
      images: [
        ...templateEditor.images,
        ...templateEditor.variants.flatMap((item) => item.images || [])
      ].filter((item) => item?.url).slice(0, 40),
      tailImageUrl: richContentImageUrl()
    },
    ozonCategory: {
      ozon_category_id: templateEditor.ozon_category_id,
      description_category_id: templateEditor.description_category_id,
      type_id: templateEditor.type_id,
      name: templateEditor.category_name
    },
    attributes: templateEditor.attributes.filter((item) => !shouldSkipAiAttribute(item)).map((item) => serializeAiAttribute(item)),
    variants: templateEditor.variants.map((row, index) => ({
      index,
      id: row.id,
      sku: row.sku,
      offer_id: row.offer_id,
      title: row.title || templateEditor.title,
      name: row.name,
      color: row.color,
      spec: row.spec,
      tags: row.main_tags,
      price: row.price,
      old_price: row.old_price
    })),
    aiRules: [
      "Return valid JSON only. No markdown, no explanation.",
      "Russian buyer-facing text must be natural Russian for Ozon.",
      "For option/dictionary attributes, choose exactly one of the provided option values. Do not invent new option values.",
      "Do not put material into model name. Model name should be a generated model/article style value when needed.",
      "Tags must start with #, use Russian words or underscore phrases, max 20 tags.",
      "Summary should be 100-150 Russian words when requested and should naturally connect the title, tags, selling points, material, compatible vehicle/use scene and buyer benefits.",
      "JSON rich content should use the tail image plus SEO-aligned Russian copy. The copy must reinforce the same intent as the title and tags, not a generic description.",
      "Use natural Ozon search phrases from tags in summary/rich content without keyword stuffing.",
      "Use Нет бренда for no brand. Do not invent a real brand.",
      "Do not fill PDF/file/manual/certificate attributes. Return empty string for unknown fields."
    ]
  };
}

function serializeAiAttribute(item = {}, includeRaw = false) {
  return {
    attribute_id: item.attribute_id,
    name: item.name,
    value: item.value,
    required: item.required,
    type: item.type,
    dictionary_id: item.dictionary_id,
    inputMode: Array.isArray(item.values) && item.values.length ? "choose_from_values" : "free_text_or_empty",
    values: (item.values || []).slice(0, includeRaw ? 80 : 30).map((option) => ({
      id: option.id || option.dictionary_value_id,
      value: option.value,
      label: option.label || option.display_value_zh || option.value
    }))
  };
}

function normalizeDeepSeekResponse(result = {}) {
  const data = result?.data || result || {};
  const fields = data.fields && typeof data.fields === "object" ? data.fields : {};
  return {
    content: String(data.content || "").trim(),
    ...fields
  };
}

async function runFieldAi(field = {}) {
  await runDeepSeekFieldAi(field);
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
  let fenced = "";
  const fenceStart = raw.indexOf("```");
  if (fenceStart >= 0) {
    const fenceEnd = raw.indexOf("```", fenceStart + 3);
    if (fenceEnd > fenceStart) {
      fenced = raw.slice(fenceStart + 3, fenceEnd).replace(/^json\s*/i, "").trim();
    }
  }
  const objectStart = raw.indexOf("{");
  const objectEnd = raw.lastIndexOf("}");
  const objectText = objectStart >= 0 && objectEnd > objectStart ? raw.slice(objectStart, objectEnd + 1) : "";
  const candidate = fenced || objectText || raw;
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("AI 返回内容不是有效 JSON，请重试");
  }
}

function applyListingAiResult(result = {}, field = {}) {
  const fieldName = String(field.name || "");
  const target = String(field.target || "").trim();
  const applyAll = !fieldName || fieldName === "all" || field.aiType === "listingForm";
  const content = String(result.content || "").trim();
  const attr = field.attributeField || (field.attribute_id || templateEditor.attributes.includes(field) ? field : null);
  let changed = 0;

  if (attr) {
    if (shouldSkipAiAttribute(attr)) return 0;
    const value = extractAttributeAiValue(result, attr, content);
    if (value !== undefined && value !== null && value !== "") {
      attr.value = normalizeAttributeAiValue(value, attr);
      return hasAttributeValue(attr) ? 1 : 0;
    }
  }

  const titleValue = firstAiValue(result, ["title", "name"], target === "title" || field.aiType === "title" ? content : "");
  if ((applyAll || target === "title" || /标题|title/i.test(fieldName)) && titleValue) {
    templateEditor.title = String(titleValue).trim();
    changed += 1;
  }

  const modelValue = firstAiValue(result, ["model", "modelName", "vendorModel", "article"]);
  if ((applyAll || target === "model" || /型号|model/i.test(fieldName)) && modelValue) {
    updateFixedField("model", String(modelValue).trim());
    changed += 1;
  }

  const tagValue = result.tags ?? result.keywords ?? (target === "tags" || field.aiType === "tags" ? content : null);
  if ((applyAll || target === "tags" || /标签|tag|keyword|关键词/i.test(fieldName)) && tagValue) {
    const tags = normalizeAiTags(tagValue);
    if (tags.length) {
      updateFixedField("tags", tags);
      changed += 1;
    }
  }

  const summaryValue = firstAiValue(result, ["summary", "shortDescription", "description"], target === "summary" || field.aiType === "shortDescription" ? content : "");
  if ((applyAll || target === "summary" || /简介|卖点|summary|description/i.test(fieldName)) && summaryValue) {
    updateFixedField("summary", String(summaryValue).trim());
    templateEditor.description = String(summaryValue).trim();
    changed += 1;
  }

  const richValue = result.richJson ?? result.rich_json ?? result.richContent ?? (target === "richJson" ? content : null);
  if ((applyAll || target === "richJson" || /json|rich|富内容/i.test(fieldName)) && richValue) {
    updateFixedField("richJson", typeof richValue === "string" ? richValue : JSON.stringify(richValue, null, 2));
    changed += 1;
  } else if ((applyAll || /json|rich|富内容/i.test(fieldName)) && fixedForm.value.summary && richContentImageUrl()) {
    generateRichContentJson();
    changed += 1;
  }

  if (result.attributes && typeof result.attributes === "object") {
    for (const item of templateEditor.attributes) {
      if (shouldSkipAiAttribute(item)) continue;
      const byId = item.attribute_id ? result.attributes[item.attribute_id] ?? result.attributes[String(item.attribute_id)] : undefined;
      const byName = result.attributes[item.name];
      const value = byId ?? byName;
      if (value !== undefined && value !== null && value !== "") {
        item.value = normalizeAttributeAiValue(value, item);
        if (hasAttributeValue(item)) changed += 1;
      }
    }
  }

  if ((applyAll || target.startsWith("variant.")) && Array.isArray(result.variants) && result.variants.length) {
    changed += applyVariantAiRows(result.variants);
  }

  return changed;
}
function firstAiValue(result = {}, keys = [], fallback = '') {
  for (const key of keys) {
    const value = result[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function normalizeAiTags(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return splitTagValue(String(value || ''));
}

function extractAttributeAiValue(result = {}, attr = {}, content = '') {
  if (result.value !== undefined) return result.value;
  if (result.attribute_value !== undefined) return result.attribute_value;
  if (result.attributes && typeof result.attributes === 'object') {
    const byId = attr.attribute_id ? result.attributes[attr.attribute_id] : undefined;
    const byName = result.attributes[attr.name];
    if (byId !== undefined) return byId;
    if (byName !== undefined) return byName;
  }
  return content;
}

function normalizeAttributeAiValue(value, attr = {}) {
  if ((attr.type === 'select' || attr.type === 'multiselect') && Array.isArray(attr.values) && attr.values.length) {
    const incoming = Array.isArray(value) ? value : splitTagValue(String(value || ''));
    const matched = incoming.map((item) => chooseAttributeCandidate(attr, [item])).filter(Boolean);
    if (attr.type === 'multiselect') return matched;
    return matched[0] || '';
  }
  if (attr.type === 'multiselect') return Array.isArray(value) ? value : splitTagValue(String(value || ''));
  return value;
}

function applyVariantAiRows(rows = []) {
  const byKey = new Map(templateEditor.variants.map((item, index) => [variantAiRowKey(item, index), item]));
  let changed = 0;
  rows.forEach((item, index) => {
    const row = byKey.get(variantAiRowKey(item, index)) || templateEditor.variants[index];
    if (!row) return;
    if (item.title || item.name) { row.title = String(item.title || item.name); changed += 1; }
    if (item.name) { row.name = String(item.name); changed += 1; }
    if (item.color) { row.color = String(item.color); changed += 1; }
    if (item.spec) { row.spec = String(item.spec); changed += 1; }
    if (item.tags || item.main_tags) { row.main_tags = normalizeAiTags(item.tags || item.main_tags); changed += 1; }
  });
  return changed;
}
function variantAiRowKey(row = {}, index = 0) {
  return String(row.offer_id || row.source_offer_id || row.sku || row.id || index);
}
async function saveTemplateEditor() {
  ensureTemplateName();
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
    applyOzonAttributeMappings();
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
    applyOzonAttributeMappings();
    const template = buildTemplatePayload();
    const result = await apiClient.post("/api/listing/templates/publish-to-ozon", {
      template,
      shop_ids: draftForm.shop_ids,
      source_record_id: template.source_raw?.record_id || route.query.recordId || ""
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
  applyOzonAttributeMappings();
  syncFixedFormAttributes();
  if (!fixedForm.value.richJson && (fixedForm.value.summary || templateEditor.description) && richContentImageUrl()) {
    generateRichContentJson();
  }
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
      length_mm: variantFieldMode.dimensions ? item.length_mm : cmToMm(templateEditor.length_cm),
      width_mm: variantFieldMode.dimensions ? item.width_mm : cmToMm(templateEditor.width_cm),
      height_mm: variantFieldMode.dimensions ? item.height_mm : cmToMm(templateEditor.height_cm),
      main_tags: variantFieldMode.tags ? item.main_tags : fixedForm.value.tags
    }));
  const payload = {
    ozon_category_id: templateEditor.ozon_category_id,
    category_name: templateEditor.category_name,
    shop_ids: draftForm.shop_ids,
    template_name: templateEditor.template_name,
    title: templateEditor.title,
    description: templateEditor.description,
    attributes,
    images,
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
      variants
    }
  };
  if (!sourceRawOmitted.value) {
    payload.source_raw = sourceRaw;
    payload.editable_payload.source_raw = sourceRaw;
  }
  return payload;
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
    applyOzonAttributeMappings();
    const created = await apiClient.post("/api/listing/drafts", {
      ...draftForm,
      source_images: draftForm.source_images.map((item) => item.url)
    });
    state.drafts.unshift(created);
    state.selectedDraftId = created.id;
    if (draftForm.shop_ids.length) {
      state.copies = await apiClient.post(`/api/listing/drafts/${created.id}/shop-copies`, {
        shop_ids: draftForm.shop_ids
      });
      state.step = "review";
      ElMessage.success(`已保存草稿，并按 ${state.copies.length} 个店铺生成上架记录`);
      return;
    }
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

function backToCollectorBox() {
  router.push({ path: "/collector-box" });
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
      <div v-if="collectorSourceSku" class="collector-source-bar">
        <div>
          <span>采集箱来源</span>
          <strong>SKU {{ collectorSourceSku }}</strong>
        </div>
        <el-button size="small" @click="backToCollectorBox">返回采集箱</el-button>
      </div>
      <div class="header-actions">
        <el-button @click="loadAll">刷新</el-button>
        <el-button type="success" :loading="aiGenerating" @click="runFieldAi({ name: 'all', type: 'attributeFill' })">AI 一键生成文案</el-button>
        <el-button @click="validatePublishPayload">检查上架</el-button>
        <el-button @click="saveTemplateEditor">创建模板</el-button>
        <el-button @click="createDraft">保存草稿</el-button>
        <el-button type="primary" @click="validatePublishPayload">准备发布</el-button>
        <el-button type="danger" :loading="publishingToOzon" @click="publishTemplateToOzon">提交 Ozon</el-button>
      </div>
    </section>

    <div class="copy-layout">
      <main class="main-column">
        <section class="copy-card" v-loading="loadingTemplate">
          <div v-if="false" class="section-heading template-heading">
            <div>
              <h2>模板编辑</h2>
              <p>复制出来的商品卡或本地模板会完整沉淀在这里，没有选择模板时也可以直接新建填写。</p>
            </div>
            <div class="template-actions">
              <el-button type="success" :loading="aiGenerating" @click="runFieldAi()">AI 一键生成文案</el-button>
              <el-button @click="saveTemplate">保存模板</el-button>
              <el-button @click="saveDraft">保存到草稿箱</el-button>
              <el-button type="primary" :loading="publishingTemplate" @click="publishTemplate">鍑嗗鍙戝竷</el-button>
            </div>
          </div>

          <el-form label-width="116px" class="copy-form">
            <section class="editor-block main-info-block">
              <h3>主要信息</h3>
              <div class="form-shell">
                <el-form-item label="上架店铺">
                  <div class="shop-select-box">
                    <el-select v-model="draftForm.shop_ids" multiple filterable collapse-tags collapse-tags-tooltip placeholder="可多选目标店铺">
                      <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="shop.id" />
                    </el-select>
                    <el-button @click="selectAllShops">全选</el-button>
                    <el-button @click="clearSelectedShops">清空</el-button>
                  </div>
                </el-form-item>
                <el-form-item label="产品类目" required>
                  <OzonCategorySelect
                    v-model="templateEditor.ozon_category_id"
                    :shop-id="copyForm.shop_id"
                    :display-label="templateEditor.category_name"
                    placeholder="搜索或选择 Ozon 中文类目"
                    :show-sync="false"
                    @select="handleOzonCategorySelected"
                  />
                </el-form-item>
                <div v-if="false" class="category-meta-grid category-diagnostics">
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
                <el-form-item v-if="false" label="上架店铺">
                  <div class="shop-select-box">
                    <el-select v-model="draftForm.shop_ids" multiple filterable collapse-tags collapse-tags-tooltip placeholder="可多选目标店铺">
                      <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="shop.id" />
                    </el-select>
                    <el-button @click="selectAllShops">全选</el-button>
                    <el-button @click="clearSelectedShops">清空</el-button>
                  </div>
                </el-form-item>
                <el-form-item v-if="false" label="产品类目" required>
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
                    <el-button class="private-field-toggle" :type="variantFieldMode.weight ? 'primary' : 'default'" @click="enableVariantField('weight')">{{ variantFieldMode.weight ? "-" : "+" }}</el-button>
                    <el-button circle :icon="InfoFilled" @click="openAttributeDetail({ name: '包装重量', value: templateEditor.weight_g, type: 'number', required: true, source: 'fixed_form' })" />
                  </div>
                </el-form-item>
                <el-form-item label="包装尺寸" required>
                  <div class="dimension-row">
                    <el-input-number v-model="templateEditor.length_cm" :min="0" :controls="false" />
                    <span>cm</span>
                    <el-input-number v-model="templateEditor.width_cm" :min="0" :controls="false" />
                    <span>cm</span>
                    <el-input-number v-model="templateEditor.height_cm" :min="0" :controls="false" />
                    <span>cm</span>
                    <span class="field-note">页面单位是厘米，提交 Ozon 时自动转毫米</span>
                    <el-button class="private-field-toggle" :type="variantFieldMode.dimensions ? 'primary' : 'default'" @click="enableVariantField('dimensions')">{{ variantFieldMode.dimensions ? "-" : "+" }}</el-button>
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
                    <el-button class="private-field-toggle" :type="variantFieldMode.tags ? 'primary' : 'default'" @click="enableVariantField('tags')">{{ variantFieldMode.tags ? "-" : "+" }}</el-button>
                    <el-button circle @click="runFieldAi({ name: '产品标签' })">AI</el-button>
                    <el-button circle :icon="InfoFilled" @click="openAttributeDetail({ name: '产品标签', value: fixedForm.tags, type: 'multiselect', required: false, source: 'fixed_form' })" />
                  </div>
                </el-form-item>
                <el-form-item label="简介">
                  <div class="field-with-tools wide-tools">
                    <el-input :model-value="fixedForm.summary" type="textarea" :rows="4" placeholder="商品描述、营销文案" @update:model-value="updateFixedField('summary', $event)" />
                    <el-button circle @click="runFieldAi({ name: '简介' })">AI</el-button>
                    <el-button circle :icon="InfoFilled" @click="openAttributeDetail({ name: '简介', value: fixedForm.summary, type: 'textarea', required: false, source: 'fixed_form' })" />
                  </div>
                </el-form-item>
                <el-form-item label="JSON富内容">
                  <div class="field-with-tools wide-tools">
                    <el-input :model-value="fixedForm.richJson" type="textarea" :rows="5" placeholder="JSON富内容" @update:model-value="updateFixedField('richJson', $event)" />
                    <el-button @click="generateRichContentJson">尾图+简介生成</el-button>
                    <el-button circle :icon="InfoFilled" @click="openAttributeDetail({ name: 'JSON富内容', value: fixedForm.richJson, type: 'rich_json', required: false, source: 'fixed_form' })" />
                  </div>
                </el-form-item>

                <div v-if="requiredSchemaAttributeFields.length" class="schema-required-panel">
                  <div class="subsection-title">
                    <h3>Ozon 必填属性</h3>
                    <el-button size="small" :loading="aiGenerating" @click="runFieldAi({ name: 'Ozon 必填属性', type: 'attributeFill' })">DeepSeek 补全</el-button>
                  </div>
                  <el-form-item v-for="(field, index) in requiredSchemaAttributeFields" :key="`${field.attribute_id || field.name}-required-${index}`" :required="field.required" :label="field.name || '未命名属性'">
                    <div class="field-with-tools">
                      <el-select v-if="field.type === 'select'" v-model="field.value" filterable clearable :loading="attributeValueLoading[attributeFieldKey(field)]" @visible-change="ensureAttributeValuesLoaded(field, $event)">
                        <el-option v-for="option in renderedAttributeOptions(field)" :key="option.id || option.value" :label="option.value" :value="option.value" />
                        <el-option v-if="attributeHasMoreOptions(field)" disabled :value="`__more_${field.attribute_id}`" :label="`仅显示前 ${ATTRIBUTE_OPTION_RENDER_LIMIT} 个选项，输入关键词可继续筛选`" />
                      </el-select>
                      <el-select v-else-if="field.type === 'multiselect'" v-model="field.value" multiple filterable allow-create default-first-option :loading="attributeValueLoading[attributeFieldKey(field)]" @visible-change="ensureAttributeValuesLoaded(field, $event)">
                        <el-option v-for="option in renderedAttributeOptions(field)" :key="option.id || option.value" :label="option.value" :value="option.value" />
                        <el-option v-if="attributeHasMoreOptions(field)" disabled :value="`__more_${field.attribute_id}`" :label="`仅显示前 ${ATTRIBUTE_OPTION_RENDER_LIMIT} 个选项，输入关键词可继续筛选`" />
                      </el-select>
                      <el-input-number v-else-if="field.type === 'number'" v-model="field.value" :controls="false" />
                      <el-switch v-else-if="field.type === 'boolean'" v-model="field.value" />
                      <el-input v-else-if="field.type === 'textarea'" v-model="field.value" type="textarea" :rows="3" />
                      <el-input v-else v-model="field.value" />
                      <el-tag :type="attributeStatusType(field)" effect="plain">{{ attributeStatusText(field) }}</el-tag>
                      <el-button circle @click="runFieldAi({ ...field, type: 'attributeFill', attributeField: field })">AI</el-button>
                      <el-button circle :icon="InfoFilled" @click="openAttributeDetail(field)" />
                    </div>
                  </el-form-item>
                </div>
                <div v-if="mainAttributeFields.length" class="schema-required-panel schema-optional-panel">
                  <div class="subsection-title">
                    <h3>Ozon 类目属性</h3>
                    <el-button v-if="hiddenAttributeCount > 0" size="small" @click="optionalAttributeVisibleLimit += 24">继续显示 {{ Math.min(24, hiddenAttributeCount) }} 项</el-button>
                  </div>
                  <el-form-item v-for="(field, index) in mainAttributeFields" :key="`${field.attribute_id || field.name}-optional-${index}`" :required="field.required" :label="field.name || '未命名属性'">
                    <div class="field-with-tools">
                      <el-select v-if="field.type === 'select'" v-model="field.value" filterable clearable :loading="attributeValueLoading[attributeFieldKey(field)]" @visible-change="ensureAttributeValuesLoaded(field, $event)">
                        <el-option v-for="option in renderedAttributeOptions(field)" :key="option.id || option.value" :label="option.value" :value="option.value" />
                        <el-option v-if="attributeHasMoreOptions(field)" disabled :value="`__more_${field.attribute_id}`" :label="`仅显示前 ${ATTRIBUTE_OPTION_RENDER_LIMIT} 个选项，输入关键词可继续筛选`" />
                      </el-select>
                      <el-select v-else-if="field.type === 'multiselect'" v-model="field.value" multiple filterable allow-create default-first-option :loading="attributeValueLoading[attributeFieldKey(field)]" @visible-change="ensureAttributeValuesLoaded(field, $event)">
                        <el-option v-for="option in renderedAttributeOptions(field)" :key="option.id || option.value" :label="option.value" :value="option.value" />
                        <el-option v-if="attributeHasMoreOptions(field)" disabled :value="`__more_${field.attribute_id}`" :label="`仅显示前 ${ATTRIBUTE_OPTION_RENDER_LIMIT} 个选项，输入关键词可继续筛选`" />
                      </el-select>
                      <el-input-number v-else-if="field.type === 'number'" v-model="field.value" :controls="false" />
                      <el-switch v-else-if="field.type === 'boolean'" v-model="field.value" />
                      <el-input v-else-if="field.type === 'textarea'" v-model="field.value" type="textarea" :rows="3" />
                      <el-input v-else v-model="field.value" />
                      <el-tag :type="attributeStatusType(field)" effect="plain">{{ attributeStatusText(field) }}</el-tag>
                      <el-button circle @click="runFieldAi({ ...field, type: 'attributeFill', attributeField: field })">AI</el-button>
                      <el-button circle :icon="InfoFilled" @click="openAttributeDetail(field)" />
                    </div>
                  </el-form-item>
                </div>
                <div v-else-if="showMoreAttributes" class="schema-required-panel schema-optional-panel empty-schema-panel">
                  <div class="subsection-title">
                    <h3>Ozon 类目属性</h3>
                    <el-button size="small" :loading="loadingTemplate" @click="syncFullCategorySchema">同步类目属性</el-button>
                  </div>
                  <el-empty description="当前模板没有可展开的隐藏属性，请先同步当前 Ozon 类目的属性模板。" />
                </div>
              </div>
            </section>

            <section class="editor-block variants-block">
              <div class="section-line">
                <div>
                  <h3>变体设置</h3>
                </div>
                <div class="section-actions variant-actions">
                  <el-button type="primary" :icon="Plus" @click="addVariantRow">添加变体</el-button>
                  <el-button :disabled="!missingVariantOfferIds.length" @click="generateMissingVariantOfferIds">一键生成货号</el-button>
                  <el-dropdown trigger="click">
                    <el-button>批量操作</el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item @click="applyFirstVariantField('images')">图片同首行</el-dropdown-item>
                        <el-dropdown-item @click="applyFirstVariantField('price')">售价同首行</el-dropdown-item>
                        <el-dropdown-item @click="applyFirstVariantField('old_price')">划线价同首行</el-dropdown-item>
                        <el-dropdown-item @click="applyFirstVariantField('main_tags')">标签同首行</el-dropdown-item>
                        <el-dropdown-item divided :disabled="!selectedVariantRows.length" @click="removeSelectedVariants">删除选中变体</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </div>
              </div>
              <el-table
                :data="templateEditor.variants"
                border
                class="variant-table dense-variant-table"
                row-key="id"
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
                    </div>
                  </template>
                </el-table-column>
                <el-table-column width="210">
                  <template #header>
                    <div class="variant-col-header">
                      <span><em>*</em> 货号 / offer_id</span>
                      <el-button link size="small" @click="generateMissingVariantOfferIds">一键生成</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <div class="offer-id-cell">
                      <el-input v-model="row.offer_id" size="small" :placeholder="row.source_offer_id ? `原货号：${row.source_offer_id}` : '新 offer_id'" />
                      <el-button size="small" @click="generateVariantOfferId(row)">生成</el-button>
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
                    <div class="variant-media-cell" @click="openVariantImageEditor(row)">
                      <div v-if="variantPreviewImages(row).length" class="variant-thumb-stack">
                        <button
                          v-for="(image, imageIndex) in variantPreviewImages(row)"
                          :key="`${image.url}-${imageIndex}`"
                          type="button"
                          class="variant-thumb-button"
                          @click.stop="openVariantImageEditor(row)"
                        >
                          <img :src="withImageToken(image.previewUrl || image.url)" :alt="image.name || row.name" loading="lazy" />
                        </button>
                        <span v-if="variantImageOverflow(row)" class="variant-image-more">+{{ variantImageOverflow(row) }}</span>
                      </div>
                      <button v-else type="button" class="variant-media-empty" @click.stop="openVariantImageEditor(row)">图片</button>
                      <div class="variant-media-actions">
                        <el-button link size="small" @click.stop="openVariantImageEditor(row)">编辑</el-button>
                        <el-upload multiple :show-file-list="false" accept="image/jpeg,image/png,image/webp" :http-request="uploadVariantImagesRequest(row)">
                          <el-button link size="small" :loading="uploadingImage" @click.stop>上传</el-button>
                        </el-upload>
                      </div>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column width="170">
                  <template #header>
                    <div class="variant-col-header">
                      <span>视频封面</span>
                      <el-button link size="small" @click="applyFirstVariantField('video_cover_urls')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <div class="variant-media-cell" @click="openVariantVideoEditor(row, 'video_cover_urls', '视频封面编辑')">
                      <div v-if="variantPreviewVideos(row, 'video_cover_urls').length" class="variant-video-strip">
                        <video
                          v-for="(url, videoIndex) in variantPreviewVideos(row, 'video_cover_urls')"
                          :key="`${url}-${videoIndex}`"
                          :src="withImageToken(url)"
                          muted
                          preload="metadata"
                        />
                        <span v-if="variantVideoOverflow(row, 'video_cover_urls')" class="variant-image-more">+{{ variantVideoOverflow(row, 'video_cover_urls') }}</span>
                      </div>
                      <button v-else type="button" class="variant-video-empty-chip" @click.stop="openVariantVideoEditor(row, 'video_cover_urls', '视频封面编辑')">封面</button>
                      <div class="variant-media-actions">
                        <el-button link size="small" @click.stop="openVariantVideoEditor(row, 'video_cover_urls', '视频封面编辑')">编辑</el-button>
                        <el-upload class="inline-upload" :show-file-list="false" accept="video/mp4,video/quicktime,video/webm" :http-request="uploadVariantVideoRequest(row, 'video_cover_urls', 'video')">
                          <el-button link size="small" :loading="uploadingImage" @click.stop>上传</el-button>
                        </el-upload>
                      </div>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column width="170">
                  <template #header>
                    <div class="variant-col-header">
                      <span>视频</span>
                      <el-button link size="small" @click="applyFirstVariantField('video_urls')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <div class="variant-media-cell" @click="openVariantVideoEditor(row, 'video_urls', 'SKU视频编辑')">
                      <div v-if="variantPreviewVideos(row, 'video_urls').length" class="variant-video-strip">
                        <video
                          v-for="(url, videoIndex) in variantPreviewVideos(row, 'video_urls')"
                          :key="`${url}-${videoIndex}`"
                          :src="withImageToken(url)"
                          muted
                          preload="metadata"
                        />
                        <span v-if="variantVideoOverflow(row, 'video_urls')" class="variant-image-more">+{{ variantVideoOverflow(row, 'video_urls') }}</span>
                      </div>
                      <button v-else type="button" class="variant-video-empty-chip" @click.stop="openVariantVideoEditor(row, 'video_urls', 'SKU视频编辑')">视频</button>
                      <div class="variant-media-actions">
                        <el-button link size="small" @click.stop="openVariantVideoEditor(row, 'video_urls', 'SKU视频编辑')">编辑</el-button>
                        <el-upload class="inline-upload" :show-file-list="false" accept="video/mp4,video/quicktime,video/webm" :http-request="uploadVariantVideoRequest(row, 'video_urls', 'video')">
                          <el-button link size="small" :loading="uploadingImage" @click.stop>上传</el-button>
                        </el-upload>
                      </div>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column v-if="variantFieldMode.title" width="320">
                  <template #header>
                    <div class="variant-col-header">
                      <span><em>*</em> 标题</span>
                      <el-button link size="small" @click="applyFirstVariantField('title')">同首行</el-button>
                      <el-button link size="small" :loading="aiGenerating" @click="runVariantColumnAi('title')">AI</el-button>
                      <el-button link size="small" type="danger" @click="disableVariantField('title')">-</el-button>
                    </div>
                  </template>
                  <template #default="{ row }"><el-input v-model="row.title" size="small" /></template>
                </el-table-column>
                <el-table-column v-if="variantFieldMode.weight" width="130">
                  <template #header>
                    <div class="variant-col-header">
                      <span><em>*</em> 包装重量(g)</span>
                      <el-button link size="small" @click="applyFirstVariantField('weight_g')">同首行</el-button>
                      <el-button link size="small" type="danger" @click="disableVariantField('weight')">-</el-button>
                    </div>
                  </template>
                  <template #default="{ row }"><el-input-number v-model="row.weight_g" :min="0" :controls="false" size="small" /></template>
                </el-table-column>
                <el-table-column v-if="variantFieldMode.dimensions" width="130">
                  <template #header>
                    <div class="variant-col-header">
                      <span><em>*</em> 包装长(mm)</span>
                      <el-button link size="small" @click="applyFirstVariantField('length_mm')">同首行</el-button>
                      <el-button link size="small" type="danger" @click="disableVariantField('dimensions')">-</el-button>
                    </div>
                  </template>
                  <template #default="{ row }"><el-input-number v-model="row.length_mm" :min="0" :controls="false" size="small" /></template>
                </el-table-column>
                <el-table-column v-if="variantFieldMode.dimensions" width="130">
                  <template #header>
                    <div class="variant-col-header">
                      <span><em>*</em> 包装宽(mm)</span>
                      <el-button link size="small" @click="applyFirstVariantField('width_mm')">同首行</el-button>
                      <el-button link size="small" type="danger" @click="disableVariantField('dimensions')">-</el-button>
                    </div>
                  </template>
                  <template #default="{ row }"><el-input-number v-model="row.width_mm" :min="0" :controls="false" size="small" /></template>
                </el-table-column>
                <el-table-column v-if="variantFieldMode.dimensions" width="130">
                  <template #header>
                    <div class="variant-col-header">
                      <span><em>*</em> 包装高(mm)</span>
                      <el-button link size="small" @click="applyFirstVariantField('height_mm')">同首行</el-button>
                      <el-button link size="small" type="danger" @click="disableVariantField('dimensions')">-</el-button>
                    </div>
                  </template>
                  <template #default="{ row }"><el-input-number v-model="row.height_mm" :min="0" :controls="false" size="small" /></template>
                </el-table-column>
                <el-table-column v-if="variantFieldMode.tags" width="190">
                  <template #header>
                    <div class="variant-col-header">
                      <span>#产品标签</span>
                      <el-button link size="small" @click="applyFirstVariantField('main_tags')">同首行</el-button>
                      <el-button link size="small" :loading="aiGenerating" @click="runVariantColumnAi('main_tags')">AI</el-button>
                      <el-button link size="small" type="danger" @click="disableVariantField('tags')">-</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <el-select v-model="row.main_tags" multiple filterable allow-create default-first-option collapse-tags collapse-tags-tooltip size="small">
                      <el-option v-for="tag in row.main_tags" :key="tag" :label="tag" :value="tag" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column width="160">
                  <template #header>
                    <div class="variant-col-header">
                      <span>颜色</span>
                      <el-button link size="small" @click="applyFirstVariantField('color')">同首行</el-button>
                      <el-button link size="small" :loading="aiGenerating" @click="runVariantColumnAi('color')">AI</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <el-select
                      v-model="row.color"
                      size="small"
                      filterable
                      allow-create
                      clearable
                      default-first-option
                      :loading="attributeValueLoading[attributeFieldKey(variantColorAttribute || {})]"
                      @visible-change="ensureVariantDictionaryOptions(variantColorAttribute, $event)"
                    >
                      <el-option v-for="option in variantDictionaryOptions(variantColorAttribute || {})" :key="option" :label="option" :value="option" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column width="180">
                  <template #header>
                    <div class="variant-col-header">
                      <span>规格/型号</span>
                      <el-button link size="small" @click="applyFirstVariantField('spec')">同首行</el-button>
                      <el-button link size="small" :loading="aiGenerating" @click="runVariantColumnAi('spec')">AI</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <el-select
                      v-model="row.spec"
                      size="small"
                      filterable
                      allow-create
                      clearable
                      default-first-option
                      :loading="attributeValueLoading[attributeFieldKey(variantSpecAttribute || {})]"
                      @visible-change="ensureVariantDictionaryOptions(variantSpecAttribute, $event)"
                    >
                      <el-option v-for="option in variantDictionaryOptions(variantSpecAttribute || {})" :key="option" :label="option" :value="option" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column width="150">
                  <template #header>
                    <div class="variant-col-header">
                      <span>售价</span>
                      <el-button link size="small" @click="applyFirstVariantField('price')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <div class="money-cell">
                      <el-input-number v-model="row.price" :min="0" :controls="false" size="small" />
                      <span>{{ editorCurrencyCode }}</span>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column width="150">
                  <template #header>
                    <div class="variant-col-header">
                      <span>划线价</span>
                      <el-button link size="small" @click="applyFirstVariantField('old_price')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <div class="money-cell">
                      <el-input-number v-model="row.old_price" :min="0" :controls="false" size="small" />
                      <span>{{ editorCurrencyCode }}</span>
                    </div>
                  </template>
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

            <div v-if="false" class="subsection-title">
              <h3>模板图片</h3>
              <div class="section-actions">
                <el-upload multiple :show-file-list="false" accept="image/jpeg,image/png,image/webp" :http-request="uploadTemplateImagesRequest">
                  <el-button size="small" type="primary" :loading="uploadingImage">上传图片</el-button>
                </el-upload>
                <el-button size="small" @click="addTemplateImageRow">新增图片链接</el-button>
              </div>
            </div>
            <el-table v-if="false" :data="templateEditor.images" border>
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
            <div v-if="false && templateEditor.images.length" class="image-strip template-preview">
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

    <el-dialog v-model="variantImageEditor.visible" title="SKU图片编辑" width="1180px" top="5vh" class="variant-image-dialog" destroy-on-close>
      <div v-if="variantImageEditor.row" class="variant-image-workbench">
        <aside class="variant-image-panel">
          <div class="variant-image-tools">
            <el-upload multiple :show-file-list="false" accept="image/jpeg,image/png,image/webp" :http-request="uploadVariantImagesRequest(variantImageEditor.row)">
              <el-button type="primary" :loading="uploadingImage">上传图片</el-button>
            </el-upload>
            <el-button @click="useTemplateImagesForVariant">使用模板图片</el-button>
            <el-button @click="addVariantImageLink">新增链接</el-button>
          </div>
          <div class="variant-image-grid selected-grid">
            <div v-for="(image, imageIndex) in ensureVariantOwnImages(variantImageEditor.row)" :key="`${image.url}-${imageIndex}`" class="variant-image-card selected-card">
              <ProductImagePreview v-if="image.url" :src="image.previewUrl || image.url" :preview-list="variantPreviewList(variantImageEditor.row)" size="square" fit="cover" />
              <div v-else class="variant-image-empty">图片链接</div>
              <el-input v-model="image.url" size="small" placeholder="https://..." />
              <div class="variant-card-footer">
                <el-tag size="small" effect="plain">{{ image.name || variantMediaRoleLabel(imageIndex, ensureVariantOwnImages(variantImageEditor.row).length) }}</el-tag>
                <el-button link type="danger" @click="removeVariantImage(imageIndex)">删除</el-button>
              </div>
            </div>
          </div>
        </aside>
        <section class="variant-image-library">
          <div class="library-tabs">
            <el-tabs v-model="variantImageEditor.activeTab">
              <el-tab-pane label="采集SKU图片" name="sku" />
              <el-tab-pane label="采集详情图片" name="detail" />
              <el-tab-pane label="网络图片" name="network" />
              <el-tab-pane label="AI生图记录" name="ai" />
            </el-tabs>
            <el-dropdown trigger="click">
              <el-button>批量操作</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="variantImageEditor.selectedUrls = variantImageLibrary().map((item) => item.url)">全选图库</el-dropdown-item>
                  <el-dropdown-item @click="variantImageEditor.selectedUrls = []">清空选择</el-dropdown-item>
                  <el-dropdown-item @click="useTemplateImagesForVariant">模板图覆盖</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
          <div class="library-grid">
            <button
              v-for="(image, imageIndex) in variantImageLibrary()"
              :key="`${image.url}-${imageIndex}`"
              type="button"
              class="library-image-card"
              :class="{ selected: isVariantImageSelected(image) }"
              @click="toggleVariantImageSelection(image)"
            >
              <img :src="withImageToken(image.previewUrl || image.url)" :alt="image.name || 'SKU image'" />
              <span>{{ image.name || `${imageIndex + 1}` }}</span>
            </button>
          </div>
        </section>
      </div>
      <template #footer>
        <el-button @click="variantImageEditor.visible = false">取消</el-button>
        <el-button type="primary" @click="confirmVariantImageEditor">确认</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="variantVideoEditor.visible" :title="variantVideoEditor.title" width="760px" top="12vh" class="variant-video-dialog" destroy-on-close>
      <div v-if="variantVideoEditor.row" class="variant-image-editor">
        <div class="variant-video-rules">
          <p>格式：MP4、MOV</p>
          <p>大小不能超过 20 MB</p>
          <p>不超过30秒</p>
        </div>
        <div class="variant-video-entry">
          <el-upload :show-file-list="false" accept="video/mp4,video/quicktime,video/webm" :http-request="uploadVariantVideoRequest(variantVideoEditor.row, variantVideoEditor.field, 'video')">
            <el-button type="primary" :loading="uploadingImage">上传视频</el-button>
          </el-upload>
          <span>或</span>
          <el-input
            :model-value="ensureVariantLinks(variantVideoEditor.row, variantVideoEditor.field)[0] || ''"
            placeholder="输入视频 URL 地址"
            @update:model-value="setPrimaryVariantVideo"
          >
            <template #append>
              <el-button @click="clearVariantVideos">清除</el-button>
            </template>
          </el-input>
          <el-button @click="addVariantVideoLink">新增链接</el-button>
        </div>
        <div class="variant-video-list">
          <div v-for="(url, videoIndex) in ensureVariantLinks(variantVideoEditor.row, variantVideoEditor.field)" :key="`${url}-${videoIndex}`" class="variant-video-card">
            <video v-if="url" class="variant-editor-video" :src="withImageToken(url)" controls preload="metadata" />
            <div v-else class="variant-video-empty">视频链接</div>
            <el-input
              :model-value="url"
              placeholder="https://..."
              @update:model-value="ensureVariantLinks(variantVideoEditor.row, variantVideoEditor.field)[videoIndex] = $event"
            />
            <el-button link type="danger" @click="removeVariantVideoLink(videoIndex)">删除</el-button>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button @click="variantVideoEditor.visible = false">取消</el-button>
        <el-button type="primary" @click="variantVideoEditor.visible = false">确认</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="collectedImport.visible" title="导入 Ozon 前台采集数据" size="720px">
      <div class="collected-import">
        <el-alert
          type="info"
          :closable="false"
          title="可把 Ozon 前台采集到的 normalized/editPayload/followEditPayload JSON 转成本地模板。"
        />
        <el-form label-position="top">
          <el-form-item label="本地模板名">
            <el-input v-model="collectedImport.template_name" placeholder="不填则使用采集到的标题" />
          </el-form-item>
          <div class="collected-import-grid">
            <el-form-item label="Ozon 类目 ID">
              <el-input v-model="collectedImport.ozon_category_id" placeholder="采集 JSON 没有类目时需要手动填写" />
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
.copy-page { display: flex; flex-direction: column; gap: 0; height: 100%; min-height: 0; overflow-y: auto; overflow-x: hidden; background: #fff; }
.copy-header { position: sticky; top: 0; z-index: 20; display: flex; justify-content: flex-end; align-items: center; gap: 12px; padding: 10px 24px; margin: -16px -16px 0; background: rgba(255, 255, 255, 0.98); border-bottom: 1px solid #eef0f5; backdrop-filter: blur(8px); }
.copy-header h1, .section-heading h2 { margin: 0; }
.copy-header p, .section-heading p { margin: 6px 0 0; color: var(--el-text-color-secondary); }
.collector-source-bar { margin-right: auto; display: flex; align-items: center; gap: 12px; padding: 8px 12px; border: 1px solid var(--el-color-primary-light-7); border-radius: 8px; background: var(--el-color-primary-light-9); min-width: 0; }
.collector-source-bar div { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.collector-source-bar span { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.2; }
.collector-source-bar strong { color: var(--el-text-color-primary); font-size: 13px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
.header-actions, .search-row, .shop-row, .stat-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; width: 100%; }
.header-actions .el-button { margin-left: 0; height: 32px; border-radius: 6px; }
.progress-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; background: var(--el-fill-color-light); padding: 12px; border-radius: 8px; }
.progress-item { height: 42px; display: grid; place-items: center; border-radius: 8px; color: var(--el-text-color-secondary); font-weight: 700; }
.progress-item.active { background: var(--el-bg-color); color: var(--el-color-primary); box-shadow: var(--el-box-shadow-light); }
.copy-layout { display: block; }
.main-column { display: flex; flex-direction: column; gap: 0; }
.copy-card { background: #fff; border: 0; border-radius: 0; padding: 0 24px 32px; }
.source-card { padding: 14px; }
.source-grid { display: grid; grid-template-columns: minmax(360px, 1.15fr) minmax(320px, 0.9fr) minmax(360px, 1fr); gap: 14px; align-items: stretch; }
.source-panel { min-width: 0; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 14px; background: var(--el-fill-color-extra-light); }
.source-panel-heading { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 10px; }
.source-panel-heading h2 { margin: 0; font-size: 16px; }
.source-panel-heading p { margin: 2px 0 0; color: var(--el-text-color-secondary); font-size: 12px; }
.section-heading { margin-bottom: 14px; }
.sku-toolbar { display: grid; grid-template-columns: 150px minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.sku-input { min-width: 0; }
.source-shop-select { width: 100%; }
.source-empty { min-height: 76px; display: flex; align-items: center; color: var(--el-text-color-secondary); font-size: 13px; border: 1px dashed var(--el-border-color); border-radius: 8px; padding: 12px; margin-top: 12px; background: var(--el-bg-color); }
.material-search-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.material-source-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.referenced-package { display: flex; flex-direction: column; gap: 3px; margin-top: 10px; padding: 8px 10px; border: 1px solid var(--el-color-success-light-5); border-radius: 8px; background: var(--el-color-success-light-9); font-size: 12px; }
.referenced-package span { color: var(--el-text-color-secondary); }
.material-package-list { display: flex; flex-direction: column; gap: 8px; max-height: 292px; overflow: auto; margin-top: 10px; }
.material-package-card { display: flex; flex-direction: column; gap: 4px; padding: 10px; border: 1px solid var(--el-border-color-light); border-radius: 8px; background: var(--el-bg-color); }
.material-package-card strong, .material-package-card span, .material-package-card small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.material-package-card span, .material-package-card small { color: var(--el-text-color-secondary); font-size: 12px; }
.package-missing { display: flex; flex-wrap: wrap; gap: 4px; }
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
.schema-quality-panel { max-width: 980px; margin: 0 auto 12px; border: 1px solid var(--el-border-color-light); border-radius: 8px; padding: 12px; background: var(--el-fill-color-extra-light); }
.schema-quality-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.schema-quality-header h3 { margin: 0 0 4px; font-size: 15px; text-align: left; }
.schema-quality-header p { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; }
.schema-quality-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.schema-quality-card { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 8px 10px; background: var(--el-bg-color); min-width: 0; }
.schema-quality-card span, .schema-quality-card small { display: block; color: var(--el-text-color-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.schema-quality-card strong { display: block; margin: 3px 0; font-size: 16px; color: var(--el-text-color-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.schema-quality-card.is-ok { border-color: var(--el-color-success-light-5); }
.schema-quality-card.is-warn { border-color: var(--el-color-warning-light-5); }
.schema-quality-card.is-danger { border-color: var(--el-color-danger-light-5); }
.schema-missing-strip { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; color: var(--el-text-color-secondary); font-size: 12px; }
.missing-required-strip { max-width: 980px; margin: 0 auto 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px; border: 1px solid var(--el-color-danger-light-7); border-radius: 8px; background: var(--el-color-danger-light-9); }
.editor-block { padding: 28px 0 14px; }
.editor-block + .editor-block { border-top: 0; margin-top: 12px; }
.editor-block h3 { margin: 0 0 22px; font-size: 18px; line-height: 1.2; text-align: center; font-weight: 700; color: #111827; }
.form-shell { max-width: 760px; margin: 0 auto; }
.form-shell :deep(.el-form-item) { margin-bottom: 18px; }
.form-shell :deep(.el-form-item__label) { justify-content: flex-end; color: #1f2937; font-size: 13px; }
.category-meta-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; width: 100%; margin-bottom: 12px; }
.category-meta-grid :deep(.el-form-item) { margin-bottom: 0; }
.legacy-category-meta { display: none; }
.section-line { display: flex; justify-content: space-between; align-items: center; gap: 16px; max-width: 760px; margin: 0 auto 20px; }
.section-line h3 { text-align: left; margin: 0; font-size: 18px; font-weight: 700; color: #111827; }
.section-line p { display: none; }
.section-actions { display: flex; align-items: center; gap: 8px; }
.variant-actions { padding: 4px; border: 1px solid #e7e9f2; border-radius: 8px; background: rgba(250, 251, 255, 0.92); flex-wrap: wrap; justify-content: flex-end; }
.variant-actions .el-button { margin-left: 0; }
.field-with-tools { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto auto; align-items: center; gap: 8px; width: 100%; }
.field-with-tools.wide-tools { grid-template-columns: minmax(0, 1fr) auto auto; align-items: flex-start; }
.private-field-toggle { min-width: 38px; height: 32px; padding-left: 8px; padding-right: 8px; border-color: #6c63ff; color: #5b54ef; }
.unit-input, .dimension-row { display: flex; align-items: center; gap: 8px; width: 100%; }
.shop-select-box { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px; width: 100%; }
.unit-input .el-input-number { flex: 1; }
.dimension-row .el-input-number { min-width: 0; flex: 1; }
.unit-input span, .dimension-row span { color: var(--el-text-color-secondary); }
.field-note { color: var(--el-color-danger) !important; white-space: nowrap; }
.ozon-editor :deep(.el-input__wrapper),
.ozon-editor :deep(.el-textarea__inner),
.ozon-editor :deep(.el-select__wrapper) {
  border-radius: 6px;
  box-shadow: 0 0 0 1px #dfe3ec inset;
}
.ozon-editor :deep(.el-input__wrapper:hover),
.ozon-editor :deep(.el-textarea__inner:hover),
.ozon-editor :deep(.el-select__wrapper:hover) {
  box-shadow: 0 0 0 1px #cbd2df inset;
}
.ozon-editor :deep(.el-button.is-circle) {
  border-color: #6c63ff;
  color: #5b54ef;
}
.hidden-attributes-panel { margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--el-border-color); }
.schema-required-panel { margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--el-border-color); }
.load-more-attributes { display: flex; justify-content: center; margin: 8px 0 4px; }
.more-attributes-hint { padding: 10px 0 0 120px; color: var(--el-text-color-secondary); font-size: 13px; }
.variant-table { max-width: 100%; min-width: 1180px; border-radius: 8px; overflow: hidden; }
.dense-variant-table { width: 100%; border-color: #e7e9f0; }
.dense-variant-table :deep(.el-table__header th) { background: #fafafa; color: #111827; font-weight: 700; }
.dense-variant-table :deep(.el-table__cell) { vertical-align: middle; }
.dense-variant-table :deep(.el-table__body .el-table__cell) { padding-top: 10px; padding-bottom: 10px; }
.dense-variant-table :deep(.cell) { padding-left: 8px; padding-right: 8px; }
.dense-variant-table :deep(.el-input-number) { width: 100%; }
.dense-variant-table :deep(.el-select__wrapper),
.dense-variant-table :deep(.el-input__wrapper) { min-height: 32px; border-radius: 7px; }
.main-info-block { max-width: 760px; margin-left: auto; margin-right: auto; }
.variants-block { width: min(1780px, calc(100vw - 96px)); max-width: 100%; margin: 12px auto 0; overflow-x: auto; padding-top: 24px; }
.variants-block > .section-line { position: relative; display: grid; grid-template-columns: 1fr auto 1fr; max-width: 100%; margin: 0 0 10px; align-items: center; }
.variants-block > .section-line > div:first-child { grid-column: 2; justify-self: center; }
.variants-block > .section-line h3 { text-align: center; margin: 0; }
.variants-block > .section-line .variant-actions { grid-column: 3; justify-self: end; }
.variants-block :deep(.el-table__empty-block) { min-height: 48px; }
.variant-col-header { min-height: 44px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; line-height: 1.2; text-align: center; font-weight: 700; }
.variant-col-header em { color: var(--el-color-danger); font-style: normal; margin-right: 2px; }
.variant-col-header .el-button { height: 18px; padding: 0; font-size: 12px; }
.variant-name-cell { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.variant-name-cell > .el-input:nth-of-type(2) { display: none; }
.variant-name-cell strong { display: block; color: var(--el-text-color-primary); font-size: 12px; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.offer-id-cell { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px; }
.money-cell { position: relative; display: block; }
.money-cell :deep(.el-input__wrapper) { padding-right: 42px; }
.money-cell span { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); min-width: 28px; height: 20px; display: inline-flex; align-items: center; justify-content: flex-end; color: #8a94a6; font-size: 12px; font-weight: 700; pointer-events: none; }
.variant-media-cell { display: grid; gap: 7px; min-height: 76px; align-content: center; justify-items: center; cursor: pointer; padding: 2px 0; }
.variant-thumb-stack, .variant-video-strip { display: flex; align-items: center; justify-content: center; gap: 4px; min-height: 44px; width: 100%; }
.variant-thumb-button { width: 44px; height: 44px; padding: 0; border: 1px solid var(--el-border-color-lighter); border-radius: 4px; overflow: hidden; background: var(--el-fill-color-light); cursor: pointer; }
.variant-thumb-button img { width: 100%; height: 100%; object-fit: cover; display: block; }
.variant-image-more { width: 28px; height: 28px; border-radius: 999px; display: grid; place-items: center; background: rgba(31, 41, 55, 0.38); color: #fff; font-size: 12px; font-weight: 800; }
.variant-media-empty, .variant-video-empty-chip { width: 76px; height: 44px; border: 1px dashed var(--el-border-color); border-radius: 6px; background: var(--el-fill-color-extra-light); color: var(--el-text-color-secondary); cursor: pointer; }
.variant-video-empty-chip { font-size: 13px; }
.variant-media-actions { display: inline-flex; align-items: center; justify-content: center; gap: 0; height: 22px; padding: 0 6px; border-radius: 999px; background: transparent; }
.variant-media-actions .el-button { height: 22px; padding: 0 5px; color: #344054; font-size: 12px; font-weight: 600; }
.variant-media-actions .el-button:hover { color: var(--el-color-primary); background: transparent; }
.variant-media-actions :deep(.el-upload) { display: inline-flex; align-items: center; }
.variant-media-actions :deep(.el-upload)::before { content: ""; width: 1px; height: 11px; margin: 0 5px 0 1px; background: var(--el-border-color); }
.variant-image-editor { display: flex; flex-direction: column; gap: 12px; }
.variant-editor-thumb { width: 58px; height: 58px; border-radius: 6px; border: 1px solid var(--el-border-color-light); background: var(--el-fill-color-light); }
.variant-image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.variant-image-card { display: grid; gap: 8px; align-content: start; padding: 10px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; background: var(--el-fill-color-extra-light); }
.variant-image-card :deep(.erp-image-preview--square) { width: 100%; min-width: 100%; max-width: 100%; height: auto; min-height: 0; max-height: none; aspect-ratio: 1; flex-basis: auto; border-radius: 6px; }
.variant-image-empty { display: grid; place-items: center; width: 100%; aspect-ratio: 1; border: 1px dashed var(--el-border-color); border-radius: 6px; color: var(--el-text-color-secondary); background: var(--el-bg-color); }
.variant-image-dialog :deep(.el-dialog) { max-width: calc(100vw - 96px); }
.variant-image-dialog :deep(.el-dialog__body) { padding: 0; }
.variant-image-workbench { display: grid; grid-template-columns: minmax(310px, 40%) minmax(420px, 1fr); min-height: 500px; max-height: calc(100vh - 240px); border-top: 1px solid var(--el-border-color-lighter); border-bottom: 1px solid var(--el-border-color-lighter); overflow: hidden; }
.variant-image-panel { padding: 16px; overflow: auto; border-right: 1px solid var(--el-border-color-lighter); background: #fff; }
.variant-image-tools { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.selected-grid { grid-template-columns: repeat(auto-fill, minmax(128px, 1fr)); }
.selected-card { border-color: #ded8ff; background: #fbfaff; }
.variant-card-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.variant-image-library { padding: 16px; overflow: auto; background: #fff; }
.library-tabs { display: flex; align-items: center; justify-content: space-between; gap: 14px; border-bottom: 1px solid var(--el-border-color-lighter); margin-bottom: 14px; }
.library-tabs :deep(.el-tabs__header) { margin: 0; }
.library-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 12px; }
.library-image-card { position: relative; display: grid; gap: 6px; padding: 0; border: 1px solid #dfe3ee; border-radius: 8px; background: #fff; overflow: hidden; cursor: pointer; text-align: left; color: var(--el-text-color-regular); }
.library-image-card img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; background: var(--el-fill-color-light); }
.library-image-card span { padding: 0 10px 10px; font-size: 12px; color: var(--el-text-color-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.library-image-card.selected { border-color: #6c5ce7; box-shadow: 0 0 0 2px rgba(108, 92, 231, 0.15); }
.library-image-card.selected::after { content: "✓"; position: absolute; right: 8px; bottom: 8px; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; color: #fff; background: #6c5ce7; font-weight: 800; }
.variant-video-strip video { width: 58px; height: 42px; border-radius: 4px; object-fit: cover; border: 1px solid var(--el-border-color-light); background: #101828; }
.variant-video-list { display: grid; gap: 12px; }
.variant-video-card { display: grid; grid-template-columns: 180px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 10px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; background: var(--el-fill-color-extra-light); }
.variant-editor-video { width: 180px; max-height: 110px; border-radius: 6px; background: #101828; }
.variant-video-empty { display: grid; place-items: center; width: 180px; height: 96px; border: 1px dashed var(--el-border-color); border-radius: 6px; color: var(--el-text-color-secondary); background: var(--el-bg-color); }
.variant-video-dialog :deep(.el-dialog__body) { padding-top: 22px; }
.variant-video-rules { display: grid; gap: 8px; margin-bottom: 18px; color: #697386; line-height: 1.5; }
.variant-video-rules p { margin: 0; }
.variant-video-entry { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; align-items: center; gap: 12px; margin-bottom: 14px; }
.inline-upload { margin-top: 6px; }
.variant-sub-input { margin-top: 6px; }
.variant-row-actions { display: flex; justify-content: center; gap: 10px; }
.variant-row-actions .el-button { margin: 0; font-weight: 600; }
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
  .sku-toolbar, .template-search-row, .collected-import-grid, .category-meta-grid, .template-health-grid, .schema-quality-grid { grid-template-columns: 1fr; }
  .schema-quality-header { flex-direction: column; }
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


