<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { InfoFilled, MagicStick, Plus, Search, UploadFilled, View } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import { loadShopDictionary } from "../../utils/shop-dictionary";
import { uploadListingMedia, withImageToken } from "../../api/tools/imageCropper";
import { generateAiVideo } from "../../api/tools/aiImageGenerator.js";
import OzonCategorySelect from "../../components/listing/OzonCategorySelect.vue";
const OzonRichContentEditor = defineAsyncComponent(() => import("../../components/listing/OzonRichContentEditor.vue"));

const loading = ref(false);
const searchingSku = ref(false);
const copyingSku = ref(false);
const creatingDraft = ref(false);
const generatingCopies = ref(false);
const uploadingImage = ref(false);
const generatingVariantCovers = ref(false);
const generatingVariantVideos = ref(false);
const repairingListingMedia = ref(false);
const loadingTemplate = ref(false);
const savingTemplate = ref(false);
const refreshingCopy = ref(false);
const aiGenerating = ref(false);
const validatingPublish = ref(false);
const publishingToOzon = ref(false);
const collectorTemplateApplied = ref(false);
const showApiDebug = ref(false);
const richEditorVisible = ref(false);
const richEditorContext = reactive({
  row: null,
  field: null
});
const sourceRawOmitted = ref(false);
const draftImagesManuallyEdited = ref(false);
const ATTRIBUTE_OPTION_LOAD_LIMIT = 2000;
const COLOR_ATTRIBUTE_OPTION_LOAD_LIMIT = 2000;
const COLOR_ATTRIBUTE_IDS = new Set(["10096", "22814"]);
const COLOR_ATTRIBUTE_EXCLUDED_IDS = new Set(["7202", "23249", "4384", "11650"]);
const COLOR_ATTRIBUTE_NAME_KEYWORDS = ["color", "colour", "\u0446\u0432\u0435\u0442", "\u989c\u8272", "\u5546\u54c1\u989c\u8272"];
const COLOR_ATTRIBUTE_EXCLUDED_NAME_KEYWORDS = [
  "quantity",
  "count",
  "pcs",
  "piece",
  "pieces",
  "unit",
  "units",
  "\u6570\u91cf",
  "\u4ef6\u6570",
  "\u5546\u54c1\u6570\u91cf",
  "\u8ba1\u91cf\u5355\u4f4d",
  "\u7edf\u4e00\u8ba1\u91cf\u5355\u4f4d",
  "\u0448\u0442\u0443\u043a",
  "\u043a\u043e\u043b\u0438\u0447\u0435\u0441\u0442\u0432\u043e"
];
const attributeValueLoading = reactive({});
const attributeValueLoadTried = reactive({});
const attributeValueCache = reactive({});
const recordDraftApplied = ref(false);
const templateKeyword = ref("");
const selectedVariantRows = ref([]);
const variantTablePage = ref(1);
const VARIANT_TABLE_PAGE_SIZE = 25;
const importingCollected = ref(false);
const materialSearching = ref(false);
const materialReferencing = ref(false);
const referencedMaterialPackage = ref(null);
const route = useRoute();
const router = useRouter();
const workbenchId = computed(() => String(route.query.workbenchId || "").trim());
const routeDraftIds = computed(() => Array.from(new Set(
  String(route.query.draftIds || route.query.draftId || "")
    .split(",")
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
)));
const isBatchDraftEdit = computed(() => routeDraftIds.value.length > 1);
const listingWorkbenchDraftStorageKey = computed(() => `listing-workbench-draft:${workbenchId.value || "default"}`);
let listingDraftSaveTimer = null;
let listingWorkbenchReady = false;
let restoringListingWorkbenchDraft = false;
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
  activeTab: "sku",
  draggingImageIndex: -1,
  dragOverImageIndex: -1
});
const variantVideoEditor = reactive({
  visible: false,
  row: null,
  field: "video_urls",
  title: "视频管理"
});
const variantFieldMode = reactive({
  title: false,
  weight: true,
  dimensions: true,
  tags: true
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
  id: "",
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

const textVariantPolicy = reactive({
  enabled: false,
  baseShopId: "",
  style: "light",
  fields: ["title", "tags", "description"],
  shopStyles: {}
});

const textVariantStyleOptions = [
  { label: "轻量差异化", value: "light" },
  { label: "高点击率", value: "ctr" },
  { label: "场景化", value: "scene" },
  { label: "材质卖点", value: "material" }
];

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
  currency_code: "CNY",
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
  rawJson: "{}",
  updated_at: ""
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
  result: null,
  failedOnly: false
});

const publishCategoryHealth = computed(() => publishValidation.result?.category_health || null);
const publishSubmitResults = computed(() => Array.isArray(publishSubmit.result?.results) ? publishSubmit.result.results : []);
const publishSubmitFailedResults = computed(() => publishSubmitResults.value.filter((item) => item?.ok === false));
const publishSubmitVisibleResults = computed(() => publishSubmit.failedOnly ? publishSubmitFailedResults.value : publishSubmitResults.value);
const publishSubmitSuccessCount = computed(() => publishSubmitResults.value.filter((item) => item?.ok).length);
const publishSubmitFailedCount = computed(() => publishSubmitFailedResults.value.length);
const selectedTemplate = computed(() => state.templates.find((item) => Number(item.id) === Number(draftForm.template_id)) || null);
const collectorSourceSku = computed(() => String(route.query.collectorSku || "").trim());
const collectedCategoryHint = ref("");
const hasValidOzonCategory = computed(() => {
  const descriptionCategoryId = Number(templateEditor.description_category_id || 0);
  const typeId = Number(templateEditor.type_id || 0);
  const categoryId = String(templateEditor.ozon_category_id || "").trim().toLowerCase();
  return descriptionCategoryId > 0 && typeId > 0 && !categoryId.startsWith("frontend:");
});
const categoryAttributesLocked = computed(() => !hasValidOzonCategory.value);
const selectedDraft = computed(() => state.drafts.find((item) => Number(item.id) === Number(state.selectedDraftId)) || null);
const readyCopyCount = computed(() => state.copies.filter((item) => item.validation?.level === "green").length);
const blockedCopyCount = computed(() => state.copies.filter((item) => item.validation?.level === "red").length);
const hiddenAttributeFields = computed(() => dedupeAttributeFields(templateEditor.attributes).sort(sortSchemaAttributeFields));
const requiredSchemaAttributeFields = computed(() => hiddenAttributeFields.value.filter((item) => item.required));
const optionalSchemaAttributeFields = computed(() => hiddenAttributeFields.value.filter((item) => !item.required));
const recommendedOptionalAttributeFields = computed(() => optionalSchemaAttributeFields.value.filter(isRecommendedAttributeField));
const mainAttributeFields = computed(() => optionalSchemaAttributeFields.value);
const selectedCopyJob = computed(() => state.copyJobs.find((item) => Number(item.id) === Number(state.selectedCopyJobId)) || null);
const selectedTextVariantShops = computed(() => draftForm.shop_ids
  .map((shopId) => state.shops.find((shop) => String(shop.id) === String(shopId)) || { id: shopId, name: `店铺 ${shopId}` }));
const variantAttributeFields = computed(() => templateEditor.attributes.filter((field) => isVariantAttributeField(field)));
const visibleVariantAttributeFields = computed(() => filterDuplicateVariantColorFields(dedupeVariantAttributeFields([
  ...variantAttributeFields.value,
  ...autoVariantAxisFields.value
])));
const visibleNonColorVariantAttributeFields = computed(() => visibleVariantAttributeFields.value.filter((field) => !isColorAttributeField(field)));
const flatSkuAttributeFields = computed(() => {
  const variantKeys = new Set(visibleVariantAttributeFields.value
    .flatMap((field) => [attributeFieldKey(field), canonicalAttributeKey(field)])
    .filter(Boolean));
  const byKey = new Map();
  templateEditor.attributes
    .filter((field) => !isColorAttributeField(field))
    .forEach((field) => {
      const key = canonicalAttributeKey(field) || attributeFieldKey(field);
      if (!key || variantKeys.has(key) || shouldSkipFlatSkuAttributeField(field) || byKey.has(key)) return;
      byKey.set(key, field);
  });
  return dedupeAttributeFields(Array.from(byKey.values())).sort(sortFlatSkuAttributeFields);
});
const flatSkuMainAttributeFields = computed(() => flatSkuAttributeFields.value.filter((field) => flatSkuAttributeGroupKey(field) === "main"));
const flatSkuProductAttributeFields = computed(() => flatSkuAttributeFields.value.filter((field) => flatSkuAttributeGroupKey(field) === "product"));
const flatSkuOtherAttributeFields = computed(() => flatSkuAttributeFields.value.filter((field) => flatSkuAttributeGroupKey(field) === "other"));
const hasFlatSkuVariantFeatureColumns = computed(() =>
  Boolean(variantColorAttribute.value || showLegacyVariantColorColumn.value)
  || visibleNonColorVariantAttributeFields.value.length > 0
  || showCollectedVariantOptionColumn.value
  || showLegacyVariantSpecColumn.value
);
const hasFlatSkuMainAttributeColumns = computed(() =>
  true
);
const mediaSummaryAttribute = computed(() => ensureFixedVariantAttribute("summary"));
const mediaRichContentAttribute = computed(() => ensureFixedVariantAttribute("richJson"));
const showCollectedVariantOptionColumn = computed(() =>
  visibleVariantAttributeFields.value.length === 0 && variantFieldHasDiverged("spec")
);
const collectedVariantOptionLabel = computed(() => variantSpecLooksLikeColor() ? "颜色" : "变体属性");
const collectedVariantOptionOptions = computed(() => {
  const colorMode = variantSpecLooksLikeColor();
  const values = templateEditor.variants
    .map((row) => String(row.spec || "").trim())
    .filter(Boolean);
  return Array.from(new Set(values)).map((value) => ({
    value,
    label: colorMode ? (translateColorValue(value) || value) : value
  }));
});
const showLegacyVariantColorColumn = computed(() =>
  visibleVariantAttributeFields.value.length === 0
  && !showCollectedVariantOptionColumn.value
  && variantFieldHasDiverged("color")
);
const showLegacyVariantSpecColumn = computed(() =>
  visibleVariantAttributeFields.value.length === 0
  && !showCollectedVariantOptionColumn.value
  && variantFieldHasDiverged("spec")
);
const activeVariantAttributeKeys = computed(() => new Set(
  visibleVariantAttributeFields.value.map((field) => attributeFieldKey(field)).filter(Boolean)
));
const hasVariantAttributeAxis = computed(() =>
  activeVariantAttributeKeys.value.size > 0
  || showLegacyVariantColorColumn.value
  || showCollectedVariantOptionColumn.value
);
const variantTablePageCount = computed(() => Math.max(1, Math.ceil(templateEditor.variants.length / VARIANT_TABLE_PAGE_SIZE)));
const variantPageRows = computed(() => {
  const start = (variantTablePage.value - 1) * VARIANT_TABLE_PAGE_SIZE;
  return templateEditor.variants.slice(start, start + VARIANT_TABLE_PAGE_SIZE);
});
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
    || Number(route.query.draftId || 0)
    || String(route.query.recordDraft || "").trim()
    || String(route.query.recordId || "").trim()
    || String(route.query.collectorSku || "").trim()
  );
}

function createWorkbenchId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureListingWorkbenchRouteId() {
  if (workbenchId.value) return;
  await router.replace({
    query: {
      ...route.query,
      workbenchId: createWorkbenchId()
    }
  }).catch(() => {});
}

function clonePlain(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function hasSavedListingWorkbenchDraft() {
  try {
    return Boolean(localStorage.getItem(listingWorkbenchDraftStorageKey.value));
  } catch {
    return false;
  }
}

function createListingWorkbenchDraftSnapshot() {
  return {
    version: 1,
    step: state.step,
    selectedCopyJobId: state.selectedCopyJobId,
    selectedDraftId: state.selectedDraftId,
    searchedProduct: clonePlain(state.searchedProduct, null),
    copies: clonePlain(state.copies, []),
    copyForm: clonePlain(copyForm, {}),
    draftForm: clonePlain(draftForm, {}),
    textVariantPolicy: clonePlain(textVariantPolicy, {}),
    templateEditor: clonePlain(templateEditor, {}),
    sourceRawOmitted: sourceRawOmitted.value,
    savedAt: new Date().toISOString()
  };
}

function hasMeaningfulListingWorkbenchDraft(snapshot = createListingWorkbenchDraftSnapshot()) {
  const editor = snapshot.templateEditor || {};
  const draft = snapshot.draftForm || {};
  return Boolean(
    editor.id
    || editor.title
    || editor.template_name
    || editor.category_name
    || editor.images?.length
    || editor.variants?.length
    || draft.product_name
    || draft.source_images?.length
    || snapshot.copies?.length
  );
}

function restoreListingWorkbenchDraft() {
  let parsed = null;
  try {
    const raw = localStorage.getItem(listingWorkbenchDraftStorageKey.value);
    if (!raw) return false;
    parsed = JSON.parse(raw);
  } catch {
    localStorage.removeItem(listingWorkbenchDraftStorageKey.value);
    return false;
  }
  if (!parsed || parsed.version !== 1) return false;
  restoringListingWorkbenchDraft = true;
  try {
    Object.assign(copyForm, parsed.copyForm || {});
    Object.assign(draftForm, parsed.draftForm || {});
    Object.assign(textVariantPolicy, parsed.textVariantPolicy || {});
    if (!textVariantPolicy.shopStyles || typeof textVariantPolicy.shopStyles !== "object") textVariantPolicy.shopStyles = {};
    syncTextVariantShopStyles();
    Object.assign(templateEditor, parsed.templateEditor || {});
    templateEditor.color = normalizeColorValuesForField(templateEditor.color || "", variantColorAttribute.value || {}).join(", ");
    templateEditor.variants = Array.isArray(templateEditor.variants)
      ? templateEditor.variants.map((row) => sanitizeVariantColorFields(row, variantColorAttribute.value || {}))
      : [];
    state.step = parsed.step || "edit";
    state.selectedCopyJobId = parsed.selectedCopyJobId ?? state.selectedCopyJobId;
    state.selectedDraftId = parsed.selectedDraftId ?? state.selectedDraftId;
    state.searchedProduct = parsed.searchedProduct || null;
    state.copies = Array.isArray(parsed.copies) ? parsed.copies : [];
    sourceRawOmitted.value = Boolean(parsed.sourceRawOmitted);
    return true;
  } finally {
    restoringListingWorkbenchDraft = false;
  }
}

function saveListingWorkbenchDraft() {
  if (!listingWorkbenchReady || restoringListingWorkbenchDraft || !workbenchId.value) return;
  const snapshot = createListingWorkbenchDraftSnapshot();
  try {
    if (!hasMeaningfulListingWorkbenchDraft(snapshot)) {
      localStorage.removeItem(listingWorkbenchDraftStorageKey.value);
      return;
    }
    localStorage.setItem(listingWorkbenchDraftStorageKey.value, JSON.stringify(snapshot));
  } catch {
    // Keep editing available even if browser storage is full.
  }
}

function scheduleListingWorkbenchDraftSave() {
  if (!listingWorkbenchReady || restoringListingWorkbenchDraft || !workbenchId.value) return;
  if (listingDraftSaveTimer) window.clearTimeout(listingDraftSaveTimer);
  listingDraftSaveTimer = window.setTimeout(() => {
    listingDraftSaveTimer = null;
    saveListingWorkbenchDraft();
  }, 1500);
}

function trackListingWorkbenchEdit() {
  scheduleListingWorkbenchDraftSave();
}

async function loadListingWorkbenchCollections() {
  if (hasListingBootstrapParams()) return;
  const [templates, drafts, copyJobs] = await Promise.all([
    apiClient.get("/api/listing/templates", { noCache: true }).catch(handleListingApiMissing),
    apiClient.get("/api/listing/drafts?paged=1&lightweight=1&page=1&pageSize=24", { noCache: true }).catch(handleListingApiMissing),
    apiClient.get("/api/listing/copy-jobs", { noCache: true }).catch(handleListingApiMissing)
  ]);
  state.templates = Array.isArray(templates) ? templates : [];
  state.drafts = Array.isArray(drafts)
    ? drafts
    : Array.isArray(drafts?.rows)
      ? drafts.rows
      : [];
  state.copyJobs = Array.isArray(copyJobs) ? copyJobs : [];
  if (!state.selectedCopyJobId && state.copyJobs[0]) state.selectedCopyJobId = state.copyJobs[0].id;
}

async function loadAll() {
  const hasBootstrap = hasListingBootstrapParams();
  const hasLocalDraft = hasSavedListingWorkbenchDraft();
  if (!hasBootstrap && !hasLocalDraft) {
    const shops = await loadShopDictionary();
    state.shops = Array.isArray(shops) ? shops.filter((shop) => shop.status !== "deleted") : [];
    if (!copyForm.shop_id && state.shops[0]) copyForm.shop_id = state.shops[0].id;
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
    const draftId = Number(route.query.draftId || 0);
    const recordId = Number(route.query.recordId || 0);
    const hasRecordDraft = Boolean(String(route.query.recordDraft || "").trim());
    const needsOnlyRouteRecord = Boolean(templateId || draftId || recordId || hasRecordDraft);
    const routeTemplateRequest = templateId
      ? apiClient.get(`/api/listing/templates/${templateId}?mode=editor`, { noCache: true }).catch(handleListingApiMissing)
      : Promise.resolve(null);
    const routeDraftRequest = draftId
      ? Promise.all(routeDraftIds.value.map((id) => (
        apiClient.get(`/api/listing/drafts/${id}`, { noCache: true }).catch(handleListingApiMissing)
      )))
      : Promise.resolve(null);
    const routeRecordRequest = recordId
      ? apiClient.get(`/api/listing/publish-records/${recordId}`, { noCache: true }).catch(handlePublishRecordRouteMissing)
      : Promise.resolve(null);
    const [shops, routeTemplate, routeDraft, routeRecord] = await Promise.all([
      loadShopDictionary(),
      routeTemplateRequest,
      routeDraftRequest,
      routeRecordRequest
    ]);
    state.shops = Array.isArray(shops) ? shops.filter((shop) => shop.status !== "deleted") : [];
    if (!copyForm.shop_id && state.shops[0]) copyForm.shop_id = state.shops[0].id;
    if (!hasBootstrap && hasLocalDraft && restoreListingWorkbenchDraft()) return;
    if (!hasBootstrap) {
      newBlankTemplate();
      state.templates = [];
      state.drafts = [];
      state.copyJobs = [];
      state.copies = [];
      state.selectedCopyJobId = null;
      state.selectedDraftId = null;
      state.searchedProduct = null;
      state.step = "edit";
      loadListingWorkbenchCollections().catch(() => {});
      return;
    }
    if (routeTemplate?.id) {
      state.templates = [routeTemplate, ...state.templates.filter((item) => Number(item.id) !== Number(routeTemplate.id))];
    }
    if (routeDraft?.id) {
      state.drafts = [routeDraft, ...state.drafts.filter((item) => Number(item.id) !== Number(routeDraft.id))];
    }
    await applyTemplateFromRoute(routeTemplate, { safeOpen: true });
    await applyListingDraftFromRoute(Array.isArray(routeDraft) ? routeDraft[0] : routeDraft);
    if (Array.isArray(routeDraft) && routeDraft.length > 1) {
      await applyBatchListingDraftsFromRoute(routeDraft);
    }
    await applyRecordDraftFromRoute();
    await applyPublishRecordFromRoute(routeRecord);
    if (!needsOnlyRouteRecord) loadListingWorkbenchCollections().catch(() => {});
  } finally {
    loading.value = false;
  }
}

async function applyTemplateFromRoute(routeTemplate = null, options = {}) {
  if (collectorTemplateApplied.value) return;
  const templateId = Number(route.query.templateId || 0);
  if (!templateId || templateEditor.id) return;
  const template = routeTemplate?.id ? routeTemplate : state.templates.find((item) => Number(item.id) === templateId);
  if (!template) return;
  collectorTemplateApplied.value = true;
  fillTemplateEditor(template, options);
  draftForm.template_id = template.id;
  state.step = "edit";
  await hydrateLoadedCategorySchema();
  ElMessage.success("已载入采集箱数据，请在商品上架页继续编辑");
}

async function applyListingDraftFromRoute(routeDraft = null) {
  const draftId = Number(route.query.draftId || 0);
  if (!draftId) return;
  const draft = routeDraft?.id ? routeDraft : state.drafts.find((item) => Number(item.id) === draftId);
  if (!draft) {
    ElMessage.warning("草稿不存在或已被删除");
    return;
  }
  state.selectedDraftId = draft.id;
  if (Number(route.query.draftId || 0) !== Number(draft.id)) {
    await router.replace({
      query: {
        ...route.query,
        draftId: draft.id
      }
    }).catch(() => {});
  }
  state.drafts = [draft, ...state.drafts.filter((item) => Number(item.id) !== Number(draft.id))];
  const templateId = Number(draft.template_id || 0);
  if (draft.template_payload || draft.templatePayload) {
    fillTemplateEditor(draft.template_payload || draft.templatePayload, { safeOpen: true });
  } else if (templateId) {
    const template = await apiClient.get(`/api/listing/templates/${templateId}?mode=editor`, { noCache: true }).catch(handleListingApiMissing);
    if (template?.id) {
      state.templates = [template, ...state.templates.filter((item) => Number(item.id) !== Number(template.id))];
      fillTemplateEditor(template, { safeOpen: true });
    }
  }
  await hydrateLoadedCategorySchema();
  templateEditor.weight_g = Number(draft.weight_g || templateEditor.weight_g || 0);
  Object.assign(draftForm, {
    id: draft.id || "",
    template_id: draft.template_id || draftForm.template_id,
    product_name: draft.product_name || "",
    internal_code: draft.internal_code || "",
    source_urls: Array.isArray(draft.source_urls) ? draft.source_urls.join("\n") : "",
    source_images: (Array.isArray(draft.source_images) ? draft.source_images : []).map((item) => {
      const url = typeof item === "string" ? item : item?.url || "";
      return { name: typeof item === "string" ? item : item?.name || url, url };
    }).filter((item) => item.url),
    cost_price: Number(draft.cost_price || 0),
    sale_price: Number(draft.sale_price || 0),
    length_cm: Number(draft.length_cm || 0),
    width_cm: Number(draft.width_cm || 0),
    height_cm: Number(draft.height_cm || 0),
    weight_g: Number(draft.weight_g || 0),
    color: draft.color || "",
    spec: draft.spec || "",
    quantity: Number(draft.quantity || 0)
  });
  // A saved draft owns its image selection; do not replace it with template defaults on the next save.
  draftImagesManuallyEdited.value = draftForm.source_images.length > 0;
  state.step = "shops";
  ElMessage.success("已载入草稿，可继续选择店铺并上架");
}

function draftCategoryKey(draft = {}) {
  const template = draft.template_payload || draft.templatePayload || {};
  const editable = template.editable_payload || template.editablePayload || {};
  const ozonParts = String(template.ozon_category_id || editable.ozon_category_id || "").split(":");
  const descriptionCategoryId = Number(editable.description_category_id || template.description_category_id || ozonParts[0] || 0);
  const typeId = Number(editable.type_id || template.type_id || ozonParts[1] || 0);
  return descriptionCategoryId > 0 && typeId > 0 ? `${descriptionCategoryId}:${typeId}` : "";
}

function batchDraftVariant(draft = {}, index = 0) {
  const template = draft.template_payload || draft.templatePayload || {};
  const editable = template.editable_payload || template.editablePayload || {};
  const variants = Array.isArray(editable.variants) ? editable.variants : Array.isArray(template.variants) ? template.variants : [];
  const sourceVariant = variants[0] || {};
  const localAttributes = Array.isArray(editable.attributes)
    ? editable.attributes
    : Array.isArray(template.attributes) ? template.attributes : [];
  const localTagAttribute = localAttributes.find((item) => (
    Number(item?.attribute_id || item?.id || 0) === 23171
    || /产品标签|主题标签|主图标签|tag|тег|ключев/i.test(String(item?.name || item?.attribute_name || ""))
  ));
  const draftTags = splitTagValue(
    sourceVariant.main_tags
    || sourceVariant.hashtags
    || sourceVariant.tags
    || editable.logistics?.tags
    || localTagAttribute?.value
    || ""
  );
  const effectiveImages = normalizeEditorImages(
    draft.effective_images
    || draft.effectiveImages
    || sourceVariant.images
    || editable.images
    || template.images
    || draft.source_images
    || []
  );
  const row = normalizeEditorVariants([{
    ...sourceVariant,
    sku: sourceVariant.sku || draft.internal_code || "",
    source_sku: sourceVariant.source_sku || sourceVariant.sku || draft.internal_code || "",
    offer_id: sourceVariant.offer_id || draft.internal_code || "",
    name: sourceVariant.name || sourceVariant.title || draft.product_name || "",
    title: sourceVariant.title || sourceVariant.name || draft.product_name || "",
    images: effectiveImages,
    cost_price: Number(sourceVariant.cost_price || draft.cost_price || 0),
    price: Number(sourceVariant.price || draft.sale_price || 0),
    color: sourceVariant.color || draft.color || "",
    spec: sourceVariant.spec || draft.spec || "",
    stock: Number(sourceVariant.stock || draft.quantity || 0),
    main_tags: draftTags,
    weight_g: Number(sourceVariant.weight_g || draft.weight_g || 0),
    length_mm: Number(sourceVariant.length_mm || draft.length_cm * 10 || 0),
    width_mm: Number(sourceVariant.width_mm || draft.width_cm * 10 || 0),
    height_mm: Number(sourceVariant.height_mm || draft.height_cm * 10 || 0)
  }])[0];
  return {
    ...row,
    id: `draft-variant-${draft.id}`,
    _draft_id: Number(draft.id),
    _template_id: Number(draft.template_id || 0),
    _draft_updated_at: draft.updated_at || "",
    _draft_source_urls: Array.isArray(draft.source_urls) ? draft.source_urls : [],
    _draft_ai_payload: clonePlain(draft.ai_payload || {}, {}),
    _draft_manual_facts: clonePlain(draft.manual_facts || {}, {}),
    _draft_index: index
  };
}

async function applyBatchListingDraftsFromRoute(drafts = []) {
  const rows = drafts.filter((draft) => draft?.id);
  if (rows.length !== routeDraftIds.value.length) {
    throw new Error("部分草稿不存在或无权访问，已停止批量编辑");
  }
  const categoryKeys = Array.from(new Set(rows.map(draftCategoryKey)));
  if (categoryKeys.length !== 1 || !categoryKeys[0]) {
    throw new Error("批量编辑仅支持相同 Ozon 类目的草稿，请重新选择");
  }
  templateEditor.variants = rows.map(batchDraftVariant);
  ensureIndependentVariantFields({ useCommonFallback: false });
  state.drafts = rows;
  state.selectedDraftId = rows[0].id;
  draftImagesManuallyEdited.value = false;
  state.step = "edit";
  ElMessage.success(`已按多变体方式载入 ${rows.length} 个同类目草稿`);
}

async function applyRecordDraftFromRoute() {
  if (recordDraftApplied.value) return;
  const key = String(route.query.recordDraft || "");
  if (!key) return;
  recordDraftApplied.value = true;
  try {
    const draft = JSON.parse(sessionStorage.getItem(key) || "{}");
    if (!draft?.template) throw new Error("empty draft");
    fillTemplateEditor(draft.template, { safeOpen: true });
    const shopId = draft.shop_id || draft.template?.source_raw?.shop_id || "";
    draftForm.shop_ids = shopId ? [shopId] : [];
    await hydrateLoadedCategorySchema();
    ElMessage.success("已从上架记录载入可编辑草稿");
  } catch {
    ElMessage.error("上架记录草稿读取失败，请从上架记录重新进入");
  }
}

async function applyPublishRecordFromRoute(routeRecord = null) {
  if (recordDraftApplied.value) return;
  const recordId = Number(route.query.recordId || 0);
  if (!recordId) return;
  recordDraftApplied.value = true;
  const record = routeRecord?.id ? routeRecord : null;
  if (!record) {
    ElMessage.error("上架记录不存在或已被删除");
    return;
  }
  const template = buildTemplateFromPublishRecord(record);
  if (!template?.editable_payload && !template?.title) {
    ElMessage.error("上架记录缺少可编辑模板数据");
    return;
  }
  fillTemplateEditor(template, { safeOpen: true });
  const shopId = record.shop_id || template.source_raw?.shop_id || template.editable_payload?.source_raw?.shop_id || "";
  draftForm.shop_ids = shopId ? [shopId] : [];
  state.step = "edit";
  await hydrateLoadedCategorySchema();
  ElMessage.success(`已从上架记录 ${recordId} 载入可编辑草稿`);
}

function buildTemplateFromPublishRecord(row = {}) {
  const snapshot = clonePlain(row.template_snapshot, null);
  if (snapshot?.editable_payload) {
    const editable = snapshot.editable_payload || {};
    const sourceRaw = clonePlain(snapshot.source_raw || editable.source_raw || {}, {});
    sourceRaw.record_id = row.id;
    sourceRaw.shop_id = row.shop_id;
    sourceRaw.from_publish_record = true;
    if (!sourceRaw.offer_id) sourceRaw.offer_id = row.offer_id || editable.sku || "";
    return {
      ...snapshot,
      id: "",
      updated_at: row.updated_at || "",
      template_name: snapshot.template_name || `上架记录 ${row.id} / ${row.offer_id || editable.sku || ""}`,
      source_raw: sourceRaw,
      editable_payload: {
        ...editable,
        source_raw: sourceRaw
      }
    };
  }
  const payload = clonePlain(row.request, { items: [] });
  const item = Array.isArray(payload.items) ? payload.items[0] || {} : {};
  const images = [item.primary_image, ...(Array.isArray(item.images) ? item.images : [])]
    .filter(Boolean)
    .map((url, index) => ({ url, sort_order: index + 1 }));
  const attrs = Array.isArray(item.attributes) ? item.attributes : [];
  const richJson = item.rich_content_json || publishRecordAttributeValue(item, [11254], ["JSON", "Rich", "rich"]);
  const tags = splitTagValue(publishRecordAttributeValue(item, [23171, 10096], ["标签", "tag", "тег", "ключ"]));
  const modelName = publishRecordAttributeValue(item, [9048], ["型号", "Модель"]) || `MODEL-${String(item.offer_id || row.offer_id || row.id || Date.now()).replace(/[^a-z0-9]+/gi, "").slice(-10).toUpperCase()}`;
  const enrichedAttrs = normalizeEditorAttributes(attrs);
  upsertPublishRecordAttribute(enrichedAttrs, [9048], ["型号", "Модель"], { name: "型号名称", attribute_id: 9048, value: modelName, required: true, source: "publish_record" });
  if (tags.length) upsertPublishRecordAttribute(enrichedAttrs, [23171], ["标签", "tag", "тег", "ключ"], { name: "产品标签", attribute_id: 23171, value: tags.join(","), values: tags, type: "multiselect", source: "publish_record" });
  if (richJson) upsertPublishRecordAttribute(enrichedAttrs, [11254], ["JSON", "Rich", "rich"], { name: "JSON富内容", attribute_id: 11254, value: richJson, type: "rich_json", source: "publish_record" });
  const sourceRaw = { ...payload, record_id: row.id, shop_id: row.shop_id, offer_id: item.offer_id || row.offer_id || "", from_publish_record: true };
  return {
    id: "",
    updated_at: row.updated_at || "",
    ozon_category_id: item.description_category_id && item.type_id ? `${item.description_category_id}:${item.type_id}` : "",
    category_name: row.category_name || item.category_name || "",
    template_name: `上架记录 ${row.id} / ${item.offer_id || row.offer_id || ""}`,
    title: item.name || row.product_name || "",
    description: item.description || "",
    attributes: enrichedAttrs,
    images,
    source_raw: sourceRaw,
    editable_payload: {
      sku: item.offer_id || row.offer_id || "",
      title: item.name || row.product_name || "",
      description: item.description || "",
      description_category_id: item.description_category_id || "",
      type_id: item.type_id || "",
      legacy_category_id: item.description_category_id && item.type_id ? `${item.description_category_id}:${item.type_id}` : "",
      price: { value: Number(item.price || row.price || 0), old_price: Number(item.old_price || row.old_price || 0), currency_code: item.currency_code || row.currency_code || "CNY", vat: item.vat || "0" },
      dimensions: { length_cm: Number(item.depth || 0) / 10, width_cm: Number(item.width || 0) / 10, height_cm: Number(item.height || 0) / 10, weight_g: Number(item.weight || 0) },
      logistics: { color: item.color || "", spec: item.material || "", quantity: item.quantity || "" },
      rich_content_json: richJson,
      category_name: row.category_name || item.category_name || "",
      attributes: enrichedAttrs,
      images,
      variants: [{
        id: `record-${row.id}`,
        sku: item.offer_id || row.offer_id || "",
        offer_id: item.offer_id || row.offer_id || "",
        title: item.name || row.product_name || "",
        images,
        video_urls: publishRecordVideoUrls(item),
        video_cover_urls: publishRecordVideoCoverUrls(item),
        price: Number(item.price || row.price || 0),
        old_price: Number(item.old_price || row.old_price || 0),
        weight_g: Number(item.weight || 0),
        length_mm: Number(item.depth || 0),
        width_mm: Number(item.width || 0),
        height_mm: Number(item.height || 0),
        stock: Number(item.stock || 0)
      }],
      source_raw: sourceRaw
    }
  };
}

function publishRecordAttributeValue(item = {}, ids = [], names = []) {
  const attrs = Array.isArray(item.attributes) ? item.attributes : [];
  for (const attr of attrs) {
    const attrId = Number(attr?.id || attr?.attribute_id || 0);
    const name = String(attr?.name || attr?.attribute_name || "").toLowerCase();
    if (!ids.some((id) => Number(id) === attrId) && !names.some((needle) => name.includes(String(needle).toLowerCase()))) continue;
    const values = Array.isArray(attr.values) ? attr.values : [];
    const firstValue = values.map((value) => value?.value || value?.name || value?.text || value).filter(Boolean)[0];
    return String(attr.value || firstValue || "").trim();
  }
  return "";
}

function upsertPublishRecordAttribute(attributes, ids = [], names = [], payload = {}) {
  const existing = attributes.find((item) => {
    const attrId = Number(item?.attribute_id || item?.id || 0);
    const name = String(item?.name || "").toLowerCase();
    return ids.some((id) => Number(id) === attrId) || names.some((needle) => name.includes(String(needle).toLowerCase()));
  });
  if (existing) Object.assign(existing, payload);
  else attributes.push(payload);
}

function publishRecordVideoUrls(item = {}) {
  const direct = [
    item.video_url,
    ...(Array.isArray(item.video_urls) ? item.video_urls : []),
    ...(Array.isArray(item.videos) ? item.videos : [])
  ].filter(Boolean);
  if (direct.length) return [...new Set(direct.map((url) => String(url || "").trim()).filter(Boolean))].slice(0, 1);
  const complexGroups = Array.isArray(item.complex_attributes) ? item.complex_attributes : [];
  const urls = [];
  for (const group of complexGroups) {
    for (const attr of Array.isArray(group?.attributes) ? group.attributes : []) {
      for (const value of Array.isArray(attr?.values) ? attr.values : []) {
        const text = String(value?.value || value?.file_url || value?.url || "").trim();
        if (/\.(mp4|mov|webm)(\?|$)/i.test(text)) urls.push(text);
      }
    }
  }
  return [...new Set(urls)].slice(0, 1);
}

function publishRecordVideoCoverUrls(item = {}) {
  const direct = [
    item.video_cover_url,
    item.cover_video_url,
    ...(Array.isArray(item.video_cover_urls) ? item.video_cover_urls : []),
    ...(Array.isArray(item.cover_video_urls) ? item.cover_video_urls : [])
  ].filter(Boolean);
  if (direct.length) {
    return [...new Set(direct.map((url) => String(url || "").trim()).filter((url) => /\.(jpe?g|png|webp)(\?|$)/i.test(url)))].slice(0, 1);
  }
  const complexGroups = Array.isArray(item.complex_attributes) ? item.complex_attributes : [];
  const urls = [];
  for (const group of complexGroups) {
    for (const attr of Array.isArray(group?.attributes) ? group.attributes : []) {
      const attrId = Number(attr?.id || attr?.attribute_id || 0);
      if (attrId && attrId !== 21845) continue;
      for (const value of Array.isArray(attr?.values) ? attr.values : []) {
        const text = String(value?.value || value?.file_url || value?.url || "").trim();
        if (/\.(jpe?g|png|webp)(\?|$)/i.test(text)) urls.push(text);
      }
    }
  }
  return [...new Set(urls)].slice(0, 1);
}

async function hydrateLoadedCategorySchema() {
  if (!templateEditor.description_category_id || !templateEditor.type_id) return;
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
  } catch {
    // Category naming is optional; the attribute schema can still be hydrated by category IDs.
  }
  try {
    const params = new URLSearchParams({
      description_category_id: String(templateEditor.description_category_id),
      type_id: String(templateEditor.type_id),
      language: "ZH_HANS",
      value_limit: "120"
    });
    const attributes = await apiClient.get(`/api/listing/ozon-category-attributes?${params.toString()}`, { noCache: true });
    if (Array.isArray(attributes) && attributes.length) mergeOzonCategoryAttributes(attributes);
  } catch {
    // Keep the loaded business values usable when the shared Ozon schema cache is unavailable.
  }
}

function handleListingApiMissing(error) {
  if (error?.status === 404) {
    ElMessage.error("编辑上架后端接口未生效，请重启或重新部署服务端进程");
    return [];
  }
  throw error;
}

function handlePublishRecordRouteMissing(error) {
  const message = String(error?.payload?.error || error?.message || "");
  if (error?.status === 404 || message.includes("\u4e0a\u67b6\u8bb0\u5f55\u4e0d\u5b58\u5728")) return null;
  return handleListingApiMissing(error);
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
  ensureTextVariantBaseShop();
}

function clearSelectedShops() {
  draftForm.shop_ids = [];
  textVariantPolicy.baseShopId = "";
}

function ensureTextVariantBaseShop() {
  if (!draftForm.shop_ids.length) {
    textVariantPolicy.baseShopId = "";
    return;
  }
  if (!draftForm.shop_ids.some((id) => String(id) === String(textVariantPolicy.baseShopId))) {
    textVariantPolicy.baseShopId = draftForm.shop_ids[0];
  }
  syncTextVariantShopStyles();
}

function syncTextVariantShopStyles() {
  const selected = new Set(draftForm.shop_ids.map((id) => String(id)));
  Object.keys(textVariantPolicy.shopStyles || {}).forEach((shopId) => {
    if (!selected.has(String(shopId))) delete textVariantPolicy.shopStyles[shopId];
  });
  draftForm.shop_ids.forEach((shopId) => {
    const key = String(shopId);
    if (!textVariantPolicy.shopStyles[key]) textVariantPolicy.shopStyles[key] = textVariantPolicy.style || "light";
  });
}

function setAllTextVariantStyles(style) {
  textVariantPolicy.style = style;
  draftForm.shop_ids.forEach((shopId) => {
    if (String(shopId) !== String(textVariantPolicy.baseShopId)) {
      textVariantPolicy.shopStyles[String(shopId)] = style;
    }
  });
}

async function handleOzonCategorySelected(category) {
  if (!category) return;
  templateEditor.ozon_category_id = category.ozon_category_id || `${category.description_category_id}:${category.type_id}`;
  templateEditor.description_category_id = category.description_category_id || category.descriptionCategoryId || "";
  templateEditor.type_id = category.type_id || category.typeId || "";
  templateEditor.category_name = category.path_zh || category.pathZh || category.name_zh || category.nameZh || category.label || category.name_ru || "";
  collectedCategoryHint.value = "";
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
    ElMessage.success(`已同步 ${result.saved || 0} 个类目属性`);
  } finally {
    loadingTemplate.value = false;
  }
}

async function syncFullCategorySchema(options = {}) {
  if (!templateEditor.description_category_id || !templateEditor.type_id) {
    if (!options.silent) ElMessage.warning("Please select an Ozon category first");
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
    if (!options.silent) ElMessage.success(`Full schema synced: ${result.saved || 0} attributes, ${result.values_saved || 0} values`);
  } finally {
    loadingTemplate.value = false;
  }
}

async function ensureFullCategoryAttributesLoaded() {
  if (!templateEditor.description_category_id || !templateEditor.type_id) return;
  await hydrateLoadedCategorySchema();
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

function pruneVariantDynamicAttributesToSchema(fields = []) {
  const allowedKeys = new Set(fields.flatMap((field) => [
    String(field.attribute_id || "").trim(),
    String(field.name || "").trim()
  ]).filter(Boolean));
  templateEditor.variants.forEach((row) => {
    const current = row?.dynamic_attributes;
    if (!current || Array.isArray(current) || typeof current !== "object") return;
    row.dynamic_attributes = Object.fromEntries(Object.entries(current).filter(([key, entry]) => {
      const attributeId = String(entry?.attribute_id || entry?.id || key || "").trim();
      const name = String(entry?.name || entry?.attribute_name || "").trim();
      return allowedKeys.has(attributeId) || allowedKeys.has(name);
    }));
  });
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
      values: mergeAttributeOptions(schema.values || [], existing?.values || []),
      selected_values: mergeAttributeOptions(existing?.selected_values || [], schema.selected_values || []),
      source: existing?.source && existing.source !== "manual" ? existing.source : schema.source
    };
  });
  templateEditor.attributes = merged;
  pruneVariantDynamicAttributesToSchema(merged);
  Object.keys(variantFieldMode).forEach((key) => {
    if (key.startsWith("attr:") && !merged.some((field) => variantAttributeModeKey(field) === key)) delete variantFieldMode[key];
  });
  applyOzonAttributeMappings();
}

async function selectTemplate(template) {
  if (!template?.id) return;
  loadingTemplate.value = true;
  try {
    const detail = await apiClient.get(`/api/listing/templates/${template.id}?mode=editor`, { noCache: true });
    fillTemplateEditor(detail);
    draftForm.template_id = detail.id;
    await ensureFullCategoryAttributesLoaded();
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
    currency_code: "CNY",
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
    rawJson: "{}",
    updated_at: ""
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

function fillTemplateEditor(template, options = {}) {
  const safeOpen = Boolean(options.safeOpen);
  const editable = template.editable_payload || {};
  const price = editable.price || {};
  const dimensions = editable.dimensions || {};
  const logistics = editable.logistics || {};
  const ozonCategoryValue = template.ozon_category_id || editable.ozon_category_id || "";
  const ozonCategoryParts = String(ozonCategoryValue || "").split(":");
  const categoryDiagnostics = editable.normalization_diagnostics?.category || template.source_raw?.normalization_diagnostics?.category || {};
  const categoryNeedsConfirmation = String(ozonCategoryValue || "").startsWith("pending:")
    || String(ozonCategoryValue || "").startsWith("frontend:")
    || categoryDiagnostics.confidence === "manual_confirmation_required";
  const mergedAttributeSource = [
    ...(Array.isArray(template.category_attributes) ? template.category_attributes : []),
    ...(Array.isArray(editable.attributes) ? editable.attributes : []),
    ...(Array.isArray(template.attributes) ? template.attributes : [])
  ];
  const attrs = dedupeAttributeFields(normalizeEditorAttributes(
    mergedAttributeSource.length
      ? mergedAttributeSource
      : firstNonEmptyArray(template.attributes, editable.attributes, template.category_attributes)
  ));
  templateEditor.id = template.id || "";
  collectedCategoryHint.value = categoryNeedsConfirmation ? String(template.category_name || editable.category_name || categoryDiagnostics.name || "").trim() : "";
  templateEditor.ozon_category_id = categoryNeedsConfirmation ? "" : ozonCategoryValue;
  templateEditor.description_category_id = categoryNeedsConfirmation ? "" : (editable.description_category_id || template.description_category_id || template.descriptionCategoryId || ozonCategoryParts[0] || "");
  templateEditor.type_id = categoryNeedsConfirmation ? "" : (editable.type_id || template.type_id || template.typeId || ozonCategoryParts[1] || "");
  templateEditor.legacy_category_id = editable.legacy_category_id || template.legacy_category_id || template.category_id || "";
  templateEditor.category_name = categoryNeedsConfirmation ? "" : (template.category_name || editable.category_name || "");
  templateEditor.template_name = template.template_name || "";
  templateEditor.source_ozon_sku = template.source_ozon_sku || editable.sku || "";
  templateEditor.title = template.title || editable.title || template.template_name || "";
  templateEditor.description = template.description || editable.description || "";
  templateEditor.price_value = Number(price.value || 0);
  templateEditor.old_price = Number(price.old_price || 0);
  templateEditor.currency_code = price.currency_code || "CNY";
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
  if (isAiOptimizationTemplate(template) && templateEditor.images.length && templateEditor.variants.length) {
    templateEditor.variants[0].images = templateEditor.images.map((item, index) => ({ ...item, sort_order: index + 1 }));
  }
  if (!templateEditor.variants.length && (templateEditor.title || templateEditor.images.length)) {
    addVariantRow();
    seedVariantModelValue(templateEditor.variants[0], editable, fixedForm.value.model);
  }
  ensureIndependentVariantFields();
  sourceRawOmitted.value = safeOpen || Boolean(template.source_raw_omitted);
  if (!safeOpen) {
    templateEditor.rawJson = sourceRawOmitted.value ? "" : JSON.stringify(template.source_raw || editable.source_raw || editable.raw_request || {}, null, 2);
  } else {
    templateEditor.rawJson = "";
  }
  templateEditor.updated_at = template.updated_at || "";
}

function syncEditorImagesFromSavedDraft(draft = {}) {
  const manualFacts = draft.manual_facts || draft.manualFacts || {};
  const templatePayload = draft.template_payload || draft.templatePayload || {};
  const editablePayload = templatePayload.editable_payload || templatePayload.editablePayload || {};
  const draftSourceImages = normalizeEditorImages(draft.source_images || []);
  const savedVariants = Array.isArray(manualFacts.variants) ? manualFacts.variants : [];
  const editableVariants = Array.isArray(editablePayload.variants) ? editablePayload.variants : [];
  const templateVariants = Array.isArray(templatePayload.variants) ? templatePayload.variants : [];
  const savedVariantImages = [
    ...editableVariants.flatMap((item) => Array.isArray(item?.images) ? item.images : []),
    ...templateVariants.flatMap((item) => Array.isArray(item?.images) ? item.images : [])
  ];
  const savedImages = normalizeEditorImages(
    draftSourceImages.length ? draftSourceImages
    : savedVariantImages.length ? savedVariantImages
    : editablePayload.images
    || templatePayload.images
    || manualFacts.images
    || []
  );
  if (savedImages.length || draftImagesManuallyEdited.value) {
    templateEditor.images = savedImages;
    draftForm.source_images = savedImages.map((item) => ({ name: item.name || item.url, url: item.url })).filter((item) => item.url);
    draftImagesManuallyEdited.value = draftForm.source_images.length > 0;
  }
  // The current draft template is authoritative. Collector-derived manual facts are
  // only a legacy fallback and commonly contain just the original first variant.
  const variantImageSources = editableVariants.length ? editableVariants : (templateVariants.length ? templateVariants : savedVariants);
  if (!variantImageSources.length) return;
  templateEditor.variants = templateEditor.variants.map((row, index) => {
    const saved = variantImageSources.find((item) => (
      (item.offer_id && item.offer_id === row.offer_id)
      || (item.sku && item.sku === row.sku)
      || (item.source_sku && item.source_sku === row.source_sku)
    )) || variantImageSources[index];
    if (!saved) return row;
    const manuallyEdited = Boolean(saved.images_manually_edited || saved.image_edit_intent === "manual");
    if (!Array.isArray(saved.images)) return row;
    return {
      ...row,
      images: normalizeEditorImages(saved.images || []),
      images_manually_edited: manuallyEdited || row.images_manually_edited,
      image_edit_intent: manuallyEdited ? "manual" : row.image_edit_intent
    };
  });
}

function firstNonEmptyArray(...values) {
  return values.find((value) => Array.isArray(value) && value.length) || [];
}

function isAiOptimizationTemplate(template = {}) {
  const sourceType = String(template.source_type || template.sourceType || "").toLowerCase();
  const editable = template.editable_payload || template.editablePayload || {};
  const sourceRaw = template.source_raw || template.sourceRaw || editable.source_raw || editable.sourceRaw || {};
  return sourceType.includes("ai_optimization")
    || Boolean(sourceRaw.ai_optimization || sourceRaw.aiOptimization)
    || Boolean(editable.ai_optimization || editable.aiOptimization);
}

function applyTemplateAttributeFallbacks(editable = {}, logistics = {}) {
  const summary = getAttributeByIdsOrNames([4191], ["简介", "Description", "Аннотация", "Описание"], templateEditor.description || editable.description || "");
  const richJson = editable.rich_content_json || getAttributeByNames(["JSON富内容", "Rich", "rich"], "");
  const brand = logistics.brand || getAttributeByNames(["品牌", "Бренд"], "");
  const model = normalizeModelNameValue(getAttributeByIdsOrNames([9048], ["型号名称", "Модель"], "") || logistics.model || logistics.modelName || "") || buildParentModelName();
  const tags = logistics.tags?.length ? normalizeOzonTagList(logistics.tags) : normalizeOzonTagList(getAttributeByNames(["产品标签", "主题标签", "主图标签", "ключевые слова", "тег"], ""));
  if (summary && !templateEditor.description) templateEditor.description = summary;
  if (brand) setAttributeByNames(["品牌", "Бренд"], brand, { name: "品牌", required: true });
  if (model) {
    templateEditor.spec = templateEditor.spec || model;
    setAttributeByIdsOrNames([9048], ["型号名称", "Модель"], model, { name: "型号名称", required: true, attribute_id: 9048 });
  }
  if (tags.length) setAttributeByNames(["产品标签", "主题标签", "主图标签", "ключевые слова", "тег"], tags.join(","), { name: "产品标签" });
  if (summary) setAttributeByIdsOrNames([4191], ["简介", "Description", "Аннотация", "Описание"], summary, { name: "简介", attribute_id: 4191 });
  if (richJson) setAttributeByNames(["JSON富内容", "Rich", "rich"], richJson, { name: "JSON富内容" });
}

function normalizeEditorAttributes(attributes) {
  return (Array.isArray(attributes) ? attributes : []).map((item, index) => ({
    name: item?.name_zh || item?.nameZh || item?.name || "",
    value: normalizeIncomingAttributeValue(item),
    label: item?.label || item?.display_value_zh || "",
    display_value_zh: item?.display_value_zh || "",
    type: normalizeAttributeType(item),
    required: Boolean(item?.required || item?.is_required),
    attribute_id: item?.attribute_id || item?.id || "",
    dictionary_id: item?.dictionary_id || "",
    is_collection: Boolean(item?.is_collection),
    group: item?.group || "",
    hint: item?.hint || "",
    source: item?.source || "ozon_copy",
    values: Array.isArray(item?.values) ? item.values.slice(0, 120) : [],
    selected_values: Array.isArray(item?.selected_values || item?.selectedValues)
      ? (item.selected_values || item.selectedValues).slice()
      : [],
    raw: item?.raw || item,
    sort_order: Number(item?.sort_order || index + 1)
  }));
}

function normalizeIncomingAttributeValue(item = {}) {
  if (item?.value !== undefined && item?.value !== null && item.value !== "") return item.value;
  if (item?.is_collection || String(item?.type || "").toLowerCase() === "multiselect") return [];
  return "";
}

function attributeFieldKey(field = {}) {
  return String(field.attribute_id || field.name || field.sort_order || "");
}

function canonicalAttributeKey(field = {}) {
  const id = String(field.attribute_id || field.id || "").trim();
  const name = compactAttributeText(field.name || field.attribute_name || field.raw?.name || "");
  if (id === "85" || /^品牌$|^brand$|бренд/.test(name)) return "fixed:brand";
  if (id === "9048" || /型号名称|^型号$|^model$|модель/.test(name)) return "fixed:model";
  if (id === "23171" || /产品标签|主题标签|主图标签|tag|тег|ключев/.test(name)) return "fixed:tags";
  if (id === "4191" || /^简介$|description|аннотац|описан/.test(name)) return "fixed:summary";
  if (id === "11254" || /json富内容|rich/.test(name)) return "fixed:rich-json";
  if (id) return `id:${id}`;
  if (!name) return "";
  return `name:${name}`;
}

function shouldSkipFlatSkuAttributeField(field = {}) {
  const key = canonicalAttributeKey(field);
  return key === "fixed:brand"
    || key === "fixed:model"
    || key === "fixed:tags"
    || key === "fixed:summary"
    || key === "fixed:rich-json";
}

function isRichContentAttributeField(field = {}) {
  return canonicalAttributeKey(field) === "fixed:rich-json";
}

function mergeAttributeFieldInto(target = {}, source = {}) {
  if (!hasAttributeValue(target) && hasAttributeValue(source)) target.value = cloneVariantValue(source.value);
  target.required = Boolean(target.required || source.required || source.is_required);
  target.dictionary_id = target.dictionary_id || source.dictionary_id || "";
  target.attribute_id = target.attribute_id || source.attribute_id || source.id || "";
  target.type = target.type || source.type || normalizeAttributeType(source);
  target.values = mergeAttributeOptions(target.values || [], source.values || []);
  target.selected_values = mergeAttributeOptions(target.selected_values || [], source.selected_values || source.selectedValues || []);
  target.source = target.source || source.source || "";
  target.sort_order = Math.min(Number(target.sort_order || Infinity), Number(source.sort_order || Infinity));
  return target;
}

function dedupeAttributeFields(fields = []) {
  const byKey = new Map();
  fields.forEach((field) => {
    const key = canonicalAttributeKey(field) || attributeFieldKey(field);
    if (!key) return;
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, field);
      return;
    }
    const preferIncoming = (!hasAttributeValue(previous) && hasAttributeValue(field))
      || (!previous.required && field.required);
    const keep = preferIncoming ? field : previous;
    const merge = preferIncoming ? previous : field;
    byKey.set(key, mergeAttributeFieldInto(keep, merge));
  });
  return Array.from(byKey.values());
}

function variantAttributeModeKey(field = {}) {
  return `attr:${attributeFieldKey(field)}`;
}

function isVariantAttributeField(field = {}) {
  return Boolean(variantFieldMode[variantAttributeModeKey(field)]);
}

function ensureVariantDynamicAttributes(row = {}) {
  if (!row.dynamic_attributes || Array.isArray(row.dynamic_attributes) || typeof row.dynamic_attributes !== "object") row.dynamic_attributes = {};
  return row.dynamic_attributes;
}

function variantDynamicAttributeKey(field = {}) {
  return String(field.attribute_id || field.name || field.sort_order || "");
}

function normalizeVariantAttributeValueForField(value, field = {}) {
  if (field.type === "multiselect" || field.is_collection) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === "") return [];
    return splitTagValue(String(value || ""));
  }
  return value ?? "";
}

function variantAttributeEntry(row = {}, field = {}) {
  const map = ensureVariantDynamicAttributes(row);
  const key = variantDynamicAttributeKey(field);
  if (!map[key] || typeof map[key] !== "object" || Array.isArray(map[key])) {
    map[key] = {
      attribute_id: field.attribute_id || "",
      name: field.name || "",
      value: normalizeVariantAttributeValueForField(field.value, field)
    };
  }
  map[key].attribute_id = map[key].attribute_id || field.attribute_id || "";
  map[key].name = map[key].name || field.name || "";
  return map[key];
}

function getVariantAttributeValue(row = {}, field = {}) {
  return variantAttributeEntry(row, field).value;
}

function setVariantAttributeValue(row = {}, field = {}, value) {
  const nextValue = isColorAttributeField(field) ? normalizeColorValuesForField(value, field) : value;
  variantAttributeEntry(row, field).value = normalizeVariantAttributeValueForField(nextValue, field);
}

function variantAttributeSelectModelValue(row = {}, field = {}) {
  const value = getVariantAttributeValue(row, field);
  return isColorAttributeField(field) ? normalizeColorValuesForField(value, field) : value;
}

function updateVariantAttributeSelectValue(row = {}, field = {}, value) {
  const normalizedValue = field.type === "multiselect" || field.is_collection
    ? Array.from(new Set(normalizeArray(value).map((item) => String(item ?? "").trim()).filter(Boolean)))
    : value;
  const entry = variantAttributeEntry(row, field);
  entry.value = normalizeVariantAttributeValueForField(normalizedValue, field);
  const selectedOptions = normalizeArray(entry.value)
    .map((item) => findAttributeOptionByValue(field, item))
    .filter(Boolean);
  entry.selected_values = dedupeAttributeOptions(selectedOptions);
  delete entry.selectedValues;
  const displayLabel = entry.selected_values.map((option) => displayAttributeOptionLabel(option, field)).filter(Boolean).join(", ");
  entry.label = displayLabel;
  entry.display_value_zh = displayLabel;
  if (isColorAttributeField(field)) {
    row.color_values = normalizeColorValuesForField(normalizedValue, field);
    row.color = normalizeColorForPayload(row);
  }
}

function attributeOptionModelValue(option = {}) {
  return option?.value ?? option?.label ?? option?.name ?? option?.text ?? "";
}

function attributeOptionSearchTexts(option = {}) {
  if (option === undefined || option === null) return [];
  if (typeof option !== "object") return [option];
  return [
    option.value,
    option.label,
    option.name,
    option.text,
    option.display_value,
    option.display_value_zh,
    option.displayValueZh,
    option.name_zh,
    option.label_zh,
    option.labelZh,
    option.zh,
    option.cn,
    option.dictionary_value_id,
    option.id,
    option.value_id,
    option.raw?.value,
    option.raw?.label,
    option.raw?.name,
    option.raw?.text,
    option.raw?.display_value,
    option.raw?.display_value_zh,
    option.raw?.displayValueZh,
    option.raw?.name_zh,
    option.raw?.label_zh,
    option.raw?.labelZh,
    option.raw?.zh,
    option.raw?.cn
  ];
}

function findAttributeOptionByValue(field = {}, value = "") {
  const target = String(value ?? "").trim();
  if (!target) return null;
  const matches = renderedAttributeOptions(field).filter((option) =>
    attributeOptionSearchTexts(option).some((candidate) => String(candidate ?? "").trim() === target)
  );
  if (!matches.length) return null;
  return matches.find((option) => hasReadableAttributeOptionLabel(option)) || matches[0];
}

function attributeEditorModelValue(field = {}) {
  if (field.type === "multiselect" || field.is_collection) {
    return normalizeArray(field.value)
      .map((value) => attributeOptionModelValue(findAttributeOptionByValue(field, value) || { value }))
      .filter((value) => value !== undefined && value !== null && value !== "");
  }
  const matched = findAttributeOptionByValue(field, field.value);
  return matched ? attributeOptionModelValue(matched) : (field.value ?? "");
}

function updateAttributeEditorValue(field = {}, value) {
  field.value = value;
}

function attributeEditorOptionLabel(option = {}, field = {}) {
  return field.type === "multiselect" ? displayAttributeOptionLabel(option, field) : attributeOptionModelValue(option);
}

function variantAttributeDisplayText(row = {}, field = {}) {
  const entry = variantAttributeEntry(row, field);
  const selectedValues = Array.isArray(entry.selected_values || entry.selectedValues) ? (entry.selected_values || entry.selectedValues) : [];
  if (selectedValues.length) {
    const labels = selectedValues.map((item) => localizeAttributeDisplayText(item?.display_value_zh || item?.label || item?.value || item?.name || item?.text || "", field)).filter(Boolean);
    if (labels.length) return labels.join(", ");
  }
  if (entry.display_value_zh || entry.label) return localizeAttributeDisplayText(entry.display_value_zh || entry.label || "", field);
  const value = entry.value;
  const values = Array.isArray(value) ? value : [value];
  const labels = values.map((item) => {
    if (item && typeof item === "object") return localizeAttributeDisplayText(item.display_value_zh || item.label || item.value || item.name || item.text || "", field);
    const text = String(item || "").trim();
    if (!text) return "";
    const matchedById = renderedAttributeOptions(field).find((option) =>
      [option?.dictionary_value_id, option?.id, option?.value_id].some((id) => String(id || "") === text)
    );
    if (matchedById) return displayAttributeOptionLabel(matchedById, field);
    const matchedByValue = findAttributeOptionByValue(field, text);
    return matchedByValue ? displayAttributeOptionLabel(matchedByValue, field) : text;
  }).filter(Boolean);
  return labels.join(", ") || "未填写";
}

function openVariantRichContentEditor(row = {}, field = {}) {
  richEditorContext.row = row;
  richEditorContext.field = field;
  richEditorVisible.value = true;
}

const richEditorModelValue = computed(() => {
  if (richEditorContext.row && richEditorContext.field) {
    return String(getVariantAttributeValue(richEditorContext.row, richEditorContext.field) || "");
  }
  return fixedForm.value.richJson;
});

function updateRichEditorModelValue(value = "") {
  if (richEditorContext.row && richEditorContext.field) {
    updateVariantAttributeSelectValue(richEditorContext.row, richEditorContext.field, value);
    return;
  }
  updateFixedField("richJson", value);
}

function updateRichEditorVisible(visible) {
  richEditorVisible.value = visible;
  if (!visible) {
    richEditorContext.row = null;
    richEditorContext.field = null;
  }
}

function flatSkuAttributeOptions(row = {}, field = {}) {
  const dictionaryOptions = attributeValueLoading[attributeFieldKey(field)]
    ? selectedAttributeOptions(field)
    : renderedAttributeOptions(field);
  const currentValues = normalizeArray(variantAttributeSelectModelValue(row, field))
    .map((value) => {
      const text = String(value ?? "").trim();
      return findAttributeOptionByValue(field, text) || (text ? { value: text, label: localizeAttributeDisplayText(text, field) } : null);
    })
    .filter(Boolean)
    .filter((option) => !isColorAttributeField(field) || isUsableColorOption(option, field))
    .filter((option) => !dictionaryOptions.includes(option));
  return dedupeAttributeOptions([
    ...dictionaryOptions.filter((option) => !isColorAttributeField(field) || isUsableColorOption(option, field)),
    ...currentValues
  ]);
}

function applyCleanRecordAttributeFallbacks(editable = {}, logistics = {}) {
  const summary = getAttributeByIdsOrNames([4191], ["简介", "Description", "Аннотация", "Описание"], templateEditor.description || editable.description || "");
  const richJson = editable.rich_content_json || getAttributeByNames(["JSON富内容", "Rich", "rich"], "");
  const brand = logistics.brand || getAttributeByNames(["品牌", "Бренд"], "");
  const model = normalizeModelNameValue(getAttributeByIdsOrNames([9048], ["型号名称", "Модель"], "") || logistics.model || logistics.modelName || "") || buildParentModelName();
  const tags = logistics.tags?.length ? normalizeOzonTagList(logistics.tags) : normalizeOzonTagList(getAttributeByNames(["产品标签", "主题标签", "主图标签", "ключевые слова", "тег"], ""));
  if (summary && !templateEditor.description) templateEditor.description = summary;
  if (brand) setAttributeByNames(["品牌", "Бренд"], brand, { name: "品牌", required: true });
  if (model) {
    templateEditor.spec = templateEditor.spec || model;
    setAttributeByIdsOrNames([9048], ["型号名称", "Модель"], model, { name: "型号名称", required: true, attribute_id: 9048 });
  }
  if (tags.length) setAttributeByNames(["产品标签", "主题标签", "主图标签", "ключевые слова", "тег"], tags.join(","), { name: "产品标签" });
  if (summary) setAttributeByIdsOrNames([4191], ["简介", "Description", "Аннотация", "Описание"], summary, { name: "简介", attribute_id: 4191 });
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
  const selectedKeys = new Set();
  const values = [
    ...(Array.isArray(field.selected_values) ? field.selected_values : []),
    ...(Array.isArray(field.selectedValues) ? field.selectedValues : []),
    ...(Array.isArray(field.values) ? field.values : [])
  ];
  [
    ...(Array.isArray(field.selected_values) ? field.selected_values : []),
    ...(Array.isArray(field.selectedValues) ? field.selectedValues : [])
  ].forEach((option) => {
    const key = attributeOptionDedupeKey(option);
    if (key) selectedKeys.add(key);
  });
  const byKey = new Map();
  values.forEach((option) => {
    const key = attributeOptionDedupeKey(option);
    if (!key) return;
    const previous = byKey.get(key);
    if (!previous || attributeOptionZhScore(option) > attributeOptionZhScore(previous)) byKey.set(key, option);
  });
  const deduped = removeRawDictionaryAliases(Array.from(byKey.values()));
  return deduped
    .sort((left, right) => compareRenderedAttributeOptions(left, right, field, selectedKeys));
}

function normalizeAttributeOptionAlias(value = "") {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function removeRawDictionaryAliases(options = []) {
  const dictionaryAliases = new Set(options
    .filter((option) => Number(option?.dictionary_value_id || option?.id || option?.value_id || 0))
    .flatMap(attributeOptionSearchTexts)
    .map(normalizeAttributeOptionAlias)
    .filter(Boolean));
  if (!dictionaryAliases.size) return options;
  return options.filter((option) => {
    if (Number(option?.dictionary_value_id || option?.id || option?.value_id || 0)) return true;
    const aliases = attributeOptionSearchTexts(option).map(normalizeAttributeOptionAlias).filter(Boolean);
    return !aliases.some((alias) => dictionaryAliases.has(alias));
  });
}

function attributeOptionDedupeKey(option = {}) {
  return String(option?.dictionary_value_id || option?.id || option?.value_id || option?.value || option?.label || "").trim();
}

function compareRenderedAttributeOptions(left = {}, right = {}, field = {}, selectedKeys = new Set()) {
  const leftSelected = selectedKeys.has(attributeOptionDedupeKey(left));
  const rightSelected = selectedKeys.has(attributeOptionDedupeKey(right));
  if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
  const attrId = Number(field.attribute_id || field.id || 0);
  const leftText = attributeOptionText(left);
  const rightText = attributeOptionText(right);
  if (attrId === 7202 && /^\d+$/.test(leftText) && /^\d+$/.test(rightText)) {
    return Number(leftText) - Number(rightText);
  }
  return leftText.localeCompare(rightText, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
}

function attributeOptionText(option = {}) {
  if (option === undefined || option === null) return "";
  if (typeof option !== "object") return String(option || "").trim();
  return String(
    option.display_value_zh
    ?? option.displayValueZh
    ?? option.label_zh
    ?? option.labelZh
    ?? option.zh
    ?? option.cn
    ?? option.label
    ?? option.name
    ?? option.text
    ?? option.display_value
    ?? option.raw?.display_value_zh
    ?? option.raw?.displayValueZh
    ?? option.raw?.label_zh
    ?? option.raw?.labelZh
    ?? option.raw?.zh
    ?? option.raw?.cn
    ?? option.raw?.label
    ?? option.raw?.name
    ?? option.raw?.text
    ?? option.raw?.display_value
    ?? option.value
    ?? option.id
    ?? option.dictionary_value_id
    ?? ""
  ).trim();
}

function cleanAttributeOptionLabel(value = "") {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function hasChineseText(value = "") {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function attributeOptionZhScore(option = {}) {
  const label = [
    option.display_value_zh,
    option.displayValueZh,
    option.label_zh,
    option.labelZh,
    option.zh,
    option.cn,
    option.label,
    option.value
  ].map(cleanAttributeOptionLabel).find(Boolean) || "";
  return (hasChineseText(label) ? 100 : 0) + (String(option.display_value_zh || "").trim() ? 10 : 0);
}

function attributeOptionLabel(option = {}) {
  if (!option || typeof option !== "object") return attributeOptionText(option);
  const candidates = [
    option.display_value_zh,
    option.displayValueZh,
    option.label_zh,
    option.labelZh,
    option.zh,
    option.cn,
    option.label,
    option.name,
    option.text,
    option.display_value,
    option.raw?.display_value_zh,
    option.raw?.displayValueZh,
    option.raw?.label_zh,
    option.raw?.labelZh,
    option.raw?.zh,
    option.raw?.cn,
    option.raw?.label,
    option.raw?.name,
    option.raw?.text,
    option.raw?.display_value
  ].map(cleanAttributeOptionLabel).filter(Boolean);
  return candidates.find(hasChineseText) || cleanAttributeOptionLabel(option.label || option.name || option.text || option.display_value || option.value || "");
}

function hasReadableAttributeOptionLabel(option = {}) {
  const label = attributeOptionLabel(option);
  return Boolean(label && !/^\d+$/.test(label));
}

function displayAttributeOptionLabel(option = {}, field = {}) {
  const optionId = String(option?.dictionary_value_id || option?.id || option?.value_id || "").trim();
  const optionValue = normalizeAttributeOptionAlias(attributeOptionModelValue(option));
  const localizedSelected = selectedAttributeOptions(field).find((selected) => {
    const selectedId = String(selected?.dictionary_value_id || selected?.id || selected?.value_id || "").trim();
    if (optionId && selectedId) return optionId === selectedId;
    return optionValue && attributeOptionSearchTexts(selected)
      .map(normalizeAttributeOptionAlias)
      .includes(optionValue);
  });
  const selectedLabel = attributeOptionLabel(localizedSelected);
  const label = hasChineseText(selectedLabel) ? selectedLabel : attributeOptionLabel(option);
  if (label) return localizeAttributeDisplayText(label, field);
  const dictId = option?.dictionary_value_id || option?.id || option?.value_id;
  return dictId ? "待同步字典值" : localizeAttributeDisplayText(attributeOptionText(option), field);
}

function selectedAttributeOptions(item = {}) {
  const selectedValues = [
    ...(Array.isArray(item.selected_values) ? item.selected_values : []),
    ...(Array.isArray(item.selectedValues) ? item.selectedValues : [])
  ];
  if (selectedValues.length) return selectedValues;
  const currentValues = Array.isArray(item.value) ? item.value : [item.value];
  const currentSet = new Set(currentValues.map((value) => String(value || "").trim()).filter(Boolean));
  if (!currentSet.size) return [];
  return (Array.isArray(item.values) ? item.values : []).filter((option) => {
    const candidates = attributeOptionSearchTexts(option).map((value) => String(value || "").trim()).filter(Boolean);
    return candidates.some((value) => currentSet.has(value));
  });
}

function normalizeAttributeForPayload(item = {}) {
  const { selected_values, selectedValues, values, raw, ...payloadItem } = item;
  const selectedPayloadValues = selectedAttributeOptions(item)
    .map((option) => ({
      dictionary_value_id: Number(option?.dictionary_value_id || option?.id || option?.value_id || 0) || undefined,
      value: String(option?.value || option?.label || option?.name || option?.text || "").trim()
    }))
    .filter((option) => option.dictionary_value_id || option.value);
  const value = Array.isArray(item.value) ? item.value.filter(Boolean) : item.value;
  if (Number(payloadItem.attribute_id || payloadItem.id || 0) === 23171 || isTopicTagAttribute(payloadItem)) {
    const tags = normalizeOzonTagList(value || selectedPayloadValues.map((option) => option.value));
    return {
      ...payloadItem,
      name: payloadItem.name || "产品标签",
      attribute_id: 23171,
      type: "multiselect",
      value: tags,
      values: tags.map((tag) => ({ value: tag }))
    };
  }
  return { ...payloadItem, value, values: selectedPayloadValues };
}

const editorCurrencyCode = computed(() => String(templateEditor.currency_code || "CNY").trim().toUpperCase() || "CNY");

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

function hasExplicitColorAttributeName(field = {}) {
  const text = attributeTextBag(field);
  return COLOR_ATTRIBUTE_NAME_KEYWORDS.some((keyword) => text.includes(compactAttributeText(keyword)));
}

function isDisallowedColorAttributeField(field = {}) {
  const id = String(field.attribute_id || field.id || "").trim();
  if (COLOR_ATTRIBUTE_EXCLUDED_IDS.has(id)) return true;
  const text = attributeTextBag(field);
  return COLOR_ATTRIBUTE_EXCLUDED_NAME_KEYWORDS.some((keyword) => text.includes(compactAttributeText(keyword)));
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
  const strongIds = kind === "color" ? new Set(["10096", "22814"]) : new Set(["4295", "4298", "4299"]);
  const weakIds = new Set([]);
  const candidates = kind === "color"
    ? dedupeVariantAttributeFields([
      ...templateEditor.attributes,
      ...variantDynamicAttributeFields()
    ])
    : templateEditor.attributes;
  const positive = kind === "color"
    ? ["color", "colour", "цвет", "цветтовара", "основнойцвет", "расцветка", "окраска", "颜色", "颜色分类"]
    : ["size", "размер", "размерпроизводителя", "размернаясетка", "规格", "尺寸", "尺码", "容量", "款式", "套装", "комплект", "набор", "объем", "объём", "volume", "capacity"];
  const negative = kind === "color"
    ? ["размер", "size", "модель", "model", "тип", "type", "название", "наименование", "title", "name", "материал", "material", "品牌", "бренд"]
    : ["цвет", "color", "colour", "материал", "material", "бренд", "brand", "颜色", "model", "модель", "型号", "型号名称", "название", "наименование", "title", "name"];
  const ranked = candidates.map((field) => {
    const text = attributeTextBag(field);
    const id = Number(field.attribute_id || 0);
    if (excludeIds.has(String(id))) return { field, score: -100 };
    if (kind === "spec" && id === 9048) return { field, score: -100 };
    const isStrongColorField = kind === "color" && strongIds.has(String(id));
    const hasExplicitColorName = kind === "color" && hasExplicitColorAttributeName(field);
    if (kind === "color" && (isDisallowedColorAttributeField(field) || (!isStrongColorField && !hasExplicitColorName))) {
      return { field, score: -100 };
    }
    const hasDictionary = Number(field.dictionary_id || 0) || (Array.isArray(field.values) && field.values.length);
    if (!hasDictionary && !isStrongColorField && !hasExplicitColorName) return { field, score: -100 };
    let score = 0;
    if (strongIds.has(String(id))) score += 100;
    if (hasExplicitColorName) score += 60;
    if (weakIds.has(String(id))) score += 12;
    if (field.required) score += 4;
    if (Array.isArray(field.values) && field.values.length) score += 8;
    score += variantOptionQuality(field, kind);
    positive.forEach((keyword) => { if (text.includes(compactAttributeText(keyword))) score += 18; });
    negative.forEach((keyword) => { if (text.includes(compactAttributeText(keyword))) score -= 40; });
    if (kind === "spec" && text.includes(compactAttributeText("модель"))) score -= 80;
    if (kind === "color" && weakIds.has(String(id)) && !positive.some((keyword) => text.includes(compactAttributeText(keyword)))) score -= 45;
    return { field, score };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score);
  return ranked[0]?.field || null;
}

const variantColorAttribute = computed(() => findVariantDictionaryAttribute("color"));
const variantSpecAttribute = computed(() => findVariantDictionaryAttribute("spec", {
  excludeIds: [variantColorAttribute.value?.attribute_id, 9048]
}));
const autoVariantAxisFields = computed(() => {
  const manualKeys = new Set(variantAttributeFields.value.map((field) => attributeFieldKey(field)));
  return dedupeVariantAttributeFields([
    ...templateEditor.attributes,
    ...variantDynamicAttributeFields()
  ])
    .filter((field) => !manualKeys.has(attributeFieldKey(field)))
    .filter(isAutoVariantAxisField);
});

function variantDynamicAttributeFields() {
  const byKey = new Map();
  templateEditor.variants.forEach((row) => {
    const map = row?.dynamic_attributes || row?.dynamicAttributes || {};
    if (!map || typeof map !== "object" || Array.isArray(map)) return;
    Object.entries(map).forEach(([key, entry]) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
      const attributeId = String(entry.attribute_id || entry.id || (/^\d+$/.test(String(key)) ? key : "") || "").trim();
      const fieldKey = attributeId || String(entry.name || entry.attribute_name || key || "").trim();
      if (!fieldKey) return;
      const previous = byKey.get(fieldKey) || {};
      byKey.set(fieldKey, mergeVariantDynamicAttributeField(previous, {
        name: entry.name || entry.attribute_name || previous.name || key,
        attribute_id: attributeId || previous.attribute_id || "",
        type: entry.type || previous.type || (entry.dictionary_id || entry.values?.length || entry.selected_values?.length ? "select" : "text"),
        dictionary_id: entry.dictionary_id || previous.dictionary_id || "",
        is_collection: Boolean(entry.is_collection || previous.is_collection),
        values: [
          ...(previous.values || []),
          ...(Array.isArray(entry.selected_values) ? entry.selected_values : []),
          ...(Array.isArray(entry.selectedValues) ? entry.selectedValues : []),
          ...(Array.isArray(entry.values) ? entry.values : [])
        ],
        source: entry.source || previous.source || "variant_dynamic_attribute",
        sort_order: previous.sort_order || templateEditor.attributes.length + byKey.size + 1
      }));
    });
  });
  return [...byKey.values()];
}

function mergeVariantDynamicAttributeField(previous = {}, next = {}) {
  return {
    ...previous,
    ...next,
    values: dedupeAttributeOptions([...(previous.values || []), ...(next.values || [])])
  };
}

function dedupeAttributeOptions(options = []) {
  const byKey = new Map();
  options.forEach((option) => {
    const key = String(option?.dictionary_value_id || option?.id || option?.value_id || option?.value || option?.label || "").trim();
    if (!key) return;
    const previous = byKey.get(key);
    if (!previous || attributeOptionZhScore(option) > attributeOptionZhScore(previous)) byKey.set(key, option);
  });
  return Array.from(byKey.values());
}

function dedupeVariantAttributeFields(fields = []) {
  const seen = new Set();
  return fields.filter((field) => {
    const key = canonicalAttributeKey(field) || attributeFieldKey(field);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function filterDuplicateVariantColorFields(fields = []) {
  const colorFields = fields.filter(isColorAttributeField);
  if (colorFields.length <= 1) return fields;
  const keep = colorFields
    .map((field) => ({ field, score: variantColorAxisQualityScore(field) }))
    .sort((left, right) => right.score - left.score)[0]?.field;
  const keepKey = attributeFieldKey(keep || {});
  return fields.filter((field) => !isColorAttributeField(field) || attributeFieldKey(field) === keepKey);
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function variantColorAxisQualityScore(field = {}) {
  const values = templateEditor.variants.map((row) => variantAttributeDisplayText(row, field)).filter(Boolean);
  const uniqueCount = new Set(values).size;
  const entries = templateEditor.variants.map((row) => findVariantDynamicAttributeEntry(row, field)).filter(Boolean);
  const zhCount = entries.filter((entry) => String(entry.display_value_zh || entry.label || "").trim()).length;
  const selectedIdCount = entries.flatMap((entry) => normalizeArray(entry.selected_values || entry.selectedValues || entry.values))
    .filter((item) => Number(item?.dictionary_value_id || item?.id || item?.value_id || 0))
    .length;
  const repairedCount = entries.filter((entry) => String(entry.source || "").includes("repair")).length;
  const id = Number(field.attribute_id || field.id || 0);
  return uniqueCount * 100 + zhCount * 10 + selectedIdCount * 4 + repairedCount * 20 + (COLOR_ATTRIBUTE_IDS.has(String(id)) ? 8 : 0);
}

function isAutoVariantAxisField(field = {}) {
  if (!field || !templateEditor.variants.length) return false;
  const id = Number(field.attribute_id || field.id || 0);
  if ([85, 9048, 23171, 4191, 11254].includes(id)) return false;
  if (isOriginCountryAttribute(field) || isMaterialAttribute(field)) return false;
  if (isColorAttributeField(field)) {
    return hasDivergedVariantAttributeValue(field) || variantFieldHasDiverged("color") || templateEditor.variants.some((row) => normalizeColorValues(row.color_values?.length ? row.color_values : row.color).length);
  }
  if (!field.attribute_id || !Number(field.dictionary_id || 0)) return false;
  return hasDivergedVariantAttributeValue(field);
}

function hasDivergedVariantAttributeValue(field = {}) {
  const values = templateEditor.variants
    .map((row) => normalizedVariantAttributeAxisValue(row, field))
    .filter(Boolean);
  return new Set(values).size > 1;
}

function normalizedVariantAttributeAxisValue(row = {}, field = {}) {
  const value = rawVariantDynamicAttributeValue(row, field);
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => {
      if (item && typeof item === "object") {
        return String(item.dictionary_value_id || item.id || item.value_id || item.value || item.label || item.name || item.text || "").trim();
      }
      return String(item || "").trim();
    })
    .filter(Boolean)
    .sort()
    .join("|");
}

function findVariantDynamicAttributeEntry(row = {}, field = {}) {
  const map = row?.dynamic_attributes || row?.dynamicAttributes || {};
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const targetId = String(field.attribute_id || field.id || "").trim();
  if (targetId) {
    for (const [key, entry] of Object.entries(map)) {
      const entryId = String(entry?.attribute_id || entry?.id || (/^\d+$/.test(String(key)) ? key : "")).trim();
      if (entryId === targetId || String(key || "").trim() === targetId) return entry;
    }
    return null;
  }
  const targetName = compactAttributeText(field.name || field.attribute_name || field.raw?.name || "");
  if (!targetName) return null;
  for (const [key, entry] of Object.entries(map)) {
    const entryName = compactAttributeText(entry?.name || entry?.attribute_name || key);
    if (entryName && (entryName.includes(targetName) || targetName.includes(entryName))) return entry;
  }
  return null;
}

function rawVariantDynamicAttributeValue(row = {}, field = {}) {
  const entry = findVariantDynamicAttributeEntry(row, field);
  return entry?.value ?? entry?.values ?? "";
}

function variantDictionaryOptions(field = {}) {
  return renderedAttributeOptions(field)
    .map((option) => String(option?.value || option?.label || "").trim())
    .filter(Boolean);
}

const SPEC_TRANSLATIONS = [
  ["универсальный", "通用"],
  ["универсальная", "通用"],
  ["универсальное", "通用"],
  ["комплект", "套装"],
  ["набор", "套装"],
  ["левый", "左"],
  ["левая", "左"],
  ["правый", "右"],
  ["правая", "右"],
  ["передний", "前"],
  ["передняя", "前"],
  ["задний", "后"],
  ["задняя", "后"]
];

function translateSpecValue(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  let translated = text;
  SPEC_TRANSLATIONS.forEach(([source, target]) => {
    translated = translated.replace(new RegExp(source, "gi"), target);
  });
  return translated;
}

function parentModelValue() {
  return String(getAttributeByIdsOrNames([9048], ["型号名称", "Модель"], "") || "").trim();
}

function isParentModelSpecValue(value = "") {
  const text = String(value || "").trim();
  const model = parentModelValue();
  return Boolean(text && model && text === model);
}

function variantSpecOptions(row = {}) {
  const values = [row.spec, ...variantDictionaryOptions(variantSpecAttribute.value || {})]
    .map((value) => String(value || "").trim())
    .filter((value) => value && !isParentModelSpecValue(value));
  return Array.from(new Set(values)).map((value) => ({
    value,
    label: translateSpecValue(value) || value
  }));
}

const COLOR_TRANSLATIONS = [
  ["черно-серый", "黑灰"],
  ["черно-белый", "黑白"],
  ["бело-черный", "白黑"],
  ["серебристый", "银色"],
  ["золотистый", "金色"],
  ["прозрачный", "透明"],
  ["разноцветный", "多色"],
  ["черный", "黑色"],
  ["чёрный", "黑色"],
  ["белый", "白色"],
  ["серый", "灰色"],
  ["красный", "红色"],
  ["синий", "蓝色"],
  ["голубой", "浅蓝色"],
  ["зеленый", "绿色"],
  ["зелёный", "绿色"],
  ["желтый", "黄色"],
  ["жёлтый", "黄色"],
  ["оранжевый", "橙色"],
  ["розовый", "粉色"],
  ["фиолетовый", "紫色"],
  ["коричневый", "棕色"],
  ["бежевый", "米色"],
  ["бордовый", "酒红色"],
  ["black", "黑色"],
  ["white", "白色"],
  ["gray", "灰色"],
  ["grey", "灰色"],
  ["red", "红色"],
  ["blue", "蓝色"],
  ["green", "绿色"],
  ["yellow", "黄色"],
  ["orange", "橙色"],
  ["pink", "粉色"],
  ["purple", "紫色"],
  ["brown", "棕色"],
  ["beige", "米色"],
  ["silver", "\u94f6\u8272"],
  ["silvery", "\u94f6\u8272"]
];

const ORIGIN_COUNTRY_TRANSLATIONS = [
  ["китай", "中国"],
  ["china", "中国"],
  ["chinese", "中国"],
  ["россия", "俄罗斯"],
  ["russia", "俄罗斯"],
  ["турция", "土耳其"],
  ["turkey", "土耳其"],
  ["индия", "印度"],
  ["india", "印度"]
];

const MATERIAL_TRANSLATIONS = [
  ["каучук", "橡胶"],
  ["rubber", "橡胶"],
  ["резина", "橡胶"],
  ["plastic", "塑料"],
  ["пластик", "塑料"],
  ["abs", "ABS塑料"],
  ["pvc", "PVC"],
  ["metal", "金属"],
  ["металл", "金属"],
  ["steel", "钢"],
  ["сталь", "钢"],
  ["aluminum", "铝"],
  ["алюминий", "铝"],
  ["leather", "皮革"],
  ["кожа", "皮革"],
  ["silicone", "硅胶"],
  ["силикон", "硅胶"]
];

function translateColorToken(token = "") {
  const text = String(token || "").trim();
  if (!text) return "";
  const normalized = text.toLowerCase();
  const exact = COLOR_TRANSLATIONS.find(([source]) => normalized === source);
  if (exact) return exact[1];
  const found = COLOR_TRANSLATIONS.find(([source]) => normalized.includes(source));
  return found ? found[1] : text;
}

function translateColorValue(value = "") {
  const parts = normalizeColorValues(value);
  if (!parts.length) return "";
  const translated = parts.map(translateColorToken).filter(Boolean);
  return Array.from(new Set(translated)).join(" / ");
}

function translateByDictionary(value = "", dictionary = []) {
  const text = String(value || "").trim();
  if (!text) return "";
  const normalized = text.toLowerCase();
  const exact = dictionary.find(([source]) => normalized === source);
  if (exact) return exact[1];
  const found = dictionary.find(([source]) => normalized.includes(source));
  return found ? found[1] : text;
}

function localizeAttributeDisplayText(value = "", field = {}) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (isColorAttributeField(field)) return translateColorValue(text) || text;
  if (isOriginCountryAttribute(field)) return translateByDictionary(text, ORIGIN_COUNTRY_TRANSLATIONS);
  if (isMaterialAttribute(field)) return translateByDictionary(text, MATERIAL_TRANSLATIONS);
  return text;
}

function normalizeColorValues(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/\s*[,，;；]\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isNumericOnlyText(value = "") {
  return /^\d+(?:[.,]\d+)?$/.test(String(value || "").trim());
}

function isQuantityLikeColorToken(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  if (isNumericOnlyText(text)) return true;
  return /^\d+(?:[.,]\d+)?\s*(pcs?|шт|штук|件|个|只|套|片|枚|支|pack|packs?|set|sets?)$/i.test(text);
}

function isUsableColorOption(option = {}, field = {}) {
  if (!option) return false;
  const modelValue = attributeOptionModelValue(option);
  const label = displayAttributeOptionLabel(option, field);
  if (isQuantityLikeColorToken(modelValue) && (!label || isQuantityLikeColorToken(label))) return false;
  if (isQuantityLikeColorToken(label)) return false;
  return true;
}

function normalizeColorValuesForField(value, field = {}) {
  return normalizeColorValues(value)
    .map((item) => {
      const matched = findAttributeOptionByValue(field, item);
      if (matched && isUsableColorOption(matched, field)) return attributeOptionModelValue(matched);
      return item;
    })
    .filter((item) => {
      if (!isQuantityLikeColorToken(item)) return true;
      const matched = findAttributeOptionByValue(field, item);
      return Boolean(matched && isUsableColorOption(matched, field));
    });
}

function normalizeColorForPayload(row = {}) {
  const values = normalizeColorValuesForField(row.color_values?.length ? row.color_values : row.color, variantColorAttribute.value || {});
  return values.join(", ");
}

function sanitizeVariantColorFields(row = {}, field = variantColorAttribute.value || {}) {
  if (!row || typeof row !== "object") return row;
  const values = normalizeColorValuesForField(row.color_values?.length ? row.color_values : row.color, field);
  row.color_values = values;
  row.color = values.join(", ");
  return row;
}

function variantColorOptions(row = {}, field = variantColorAttribute.value || {}) {
  const dictionaryOptions = mergeAttributeOptions(
    renderedAttributeOptions(field || {}),
    cachedAttributeOptionsForField(field || {})
  );
  if (dictionaryOptions.length) {
    return dictionaryOptions
      .filter((option) => isUsableColorOption(option, field))
      .map((option) => {
        const value = attributeOptionModelValue(option);
        return {
          value,
          label: displayAttributeOptionLabel(option, field) || translateColorValue(value) || value
        };
      })
      .filter((option) => option.value);
  }
  const values = [
    ...normalizeColorValues(row.color),
    ...normalizeColorValues(row.color_values),
    ...normalizeColorValues(getVariantAttributeValue(row, field))
  ].filter((value) => !isQuantityLikeColorToken(value));
  return Array.from(new Set(values.filter(Boolean))).map((value) => ({ value, label: translateColorValue(value) || value }));
}

function syncVariantColor(row) {
  if (!row) return;
  sanitizeVariantColorFields(row, variantColorAttribute.value || {});
  if (variantColorAttribute.value) setVariantAttributeValue(row, variantColorAttribute.value, row.color_values);
}

function updateVariantColorAttribute(row = {}, field = {}, value = []) {
  row.color_values = normalizeColorValuesForField(value, field);
  row.color = normalizeColorForPayload(row);
  setVariantAttributeValue(row, field, row.color_values);
}

function ensureVariantDictionaryOptions(field = {}, visible = true) {
  if (!field) return;
  ensureAttributeValuesLoaded(field, visible);
}

function attributeValueCacheKey(field = {}) {
  return [
    templateEditor.description_category_id,
    templateEditor.type_id,
    field.attribute_id,
    isColorAttributeField(field) ? "color" : "default"
  ].map((item) => String(item || "").trim()).join(":");
}

function isColorAttributeField(field = {}) {
  const id = String(field.attribute_id || field.id || "").trim();
  if (isDisallowedColorAttributeField(field)) return false;
  if (COLOR_ATTRIBUTE_IDS.has(id)) return true;
  return hasExplicitColorAttributeName(field);
}

function normalizeDynamicAttributeEntries(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([key, val]) => ({
    ...(val && typeof val === "object" && !Array.isArray(val) ? val : {}),
    attribute_id: /^\d+$/.test(String(key)) ? key : "",
    name: val?.name || val?.attribute_name || key,
    value: val?.value ?? val
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
      : ["size", "размер", "规格", "尺寸", "尺码", "容量", "款式", "套装", "комплект", "набор", "объем", "объём", "volume", "capacity"].some((keyword) => text.includes(compactAttributeText(keyword)));
  });
  return String(unwrapDynamicAttributeValue(fallback?.value ?? fallback?.values)).trim();
}

async function ensureAttributeValuesLoaded(field = {}, visible = true) {
  const colorField = isColorAttributeField(field);
  if (!visible || !Number(field.attribute_id || 0) || (!colorField && !Number(field.dictionary_id || 0))) return;
  if (!templateEditor.description_category_id || !templateEditor.type_id) return;
  const key = attributeFieldKey(field);
  const cacheKey = attributeValueCacheKey(field);
  if (Array.isArray(attributeValueCache[cacheKey])) {
    if (attributeValueCache[cacheKey].length) field.values = mergeAttributeOptions(field.values || [], attributeValueCache[cacheKey]);
    if (attributeValueCache[cacheKey].length) return;
  }
  if (attributeValueLoading[key]) return;
  attributeValueLoading[key] = true;
  attributeValueLoadTried[cacheKey] = true;
  try {
    const params = new URLSearchParams({
      description_category_id: String(templateEditor.description_category_id),
      type_id: String(templateEditor.type_id),
      attribute_id: String(field.attribute_id),
      limit: String(colorField ? COLOR_ATTRIBUTE_OPTION_LOAD_LIMIT : ATTRIBUTE_OPTION_LOAD_LIMIT)
    });
    if (colorField) params.set("cache_hint", "color");
    const values = await apiClient.get(`/api/listing/ozon-attribute-values?${params.toString()}`, { noCache: true });
    attributeValueCache[cacheKey] = Array.isArray(values) ? values : [];
    if (Array.isArray(values) && values.length) field.values = mergeAttributeOptions(field.values || [], values);
  } catch (error) {
    delete attributeValueLoadTried[cacheKey];
    delete attributeValueCache[cacheKey];
    ElMessage.warning(`属性选项加载失败，可重新打开下拉重试：${error?.message || "Ozon 接口暂不可用"}`);
  } finally {
    attributeValueLoading[key] = false;
  }
}

function cachedAttributeOptionsForField(field = {}) {
  const cacheKey = attributeValueCacheKey(field);
  return Array.isArray(attributeValueCache[cacheKey]) ? attributeValueCache[cacheKey] : [];
}

function mergeAttributeOptions(current = [], incoming = []) {
  return dedupeAttributeOptions([
    ...(Array.isArray(current) ? current : []),
    ...(Array.isArray(incoming) ? incoming : [])
  ]);
}

function isAttributeOptionLoading(field = {}) {
  return Boolean(attributeValueLoading[attributeFieldKey(field)]);
}

function isRecommendedAttributeField(field = {}) {
  const name = String(field.name || "").toLowerCase();
  const keywords = [
    "color", "colour", "material", "country", "warranty", "quantity", "oem", "pdf", "video",
    "颜色", "材质", "材料", "原产国", "制造国", "保修", "数量", "适配", "车型", "配置", "备件", "零件", "位置",
    "цвет", "屑邪褌械褉懈邪谢", "褋褌褉邪薪邪", "谐邪褉邪薪褌", "泻芯谢懈褔械褋褌胁芯", "屑芯写械谢褜", "邪胁褌芯屑芯斜"
  ];
  return keywords.some((keyword) => name.includes(keyword));
}

function highRiskOzonAttributeRank(field = {}) {
  if (isColorAttributeField(field)) return 30;
  if (isOriginCountryAttribute(field)) return 20;
  if (isMaterialAttribute(field)) return 10;
  return 0;
}

function sortSchemaAttributeFields(a = {}, b = {}) {
  return Number(b.required) - Number(a.required)
    || highRiskOzonAttributeRank(b) - highRiskOzonAttributeRank(a)
    || Number(isRecommendedAttributeField(b)) - Number(isRecommendedAttributeField(a))
    || Number(!hasAttributeValue(a)) - Number(!hasAttributeValue(b))
    || Number(a.sort_order || 0) - Number(b.sort_order || 0);
}

function flatSkuAttributeGroupRank(field = {}) {
  const id = Number(field.attribute_id || field.id || 0);
  if ([85, 9048, 23171, 4389, 7199, 8229].includes(id)) return 300;
  if (isOriginCountryAttribute(field) || isMaterialAttribute(field) || isCategoryTypeAttribute(field) || isTopicTagAttribute(field)) return 280;
  if (field.required) return 220;
  if (isRecommendedAttributeField(field)) return 160;
  return 0;
}

function flatSkuAttributeGroupLabel(field = {}) {
  const key = flatSkuAttributeGroupKey(field);
  if (key === "main") return "主要";
  if (key === "product") return "产品";
  return "其它";
}

function flatSkuAttributeGroupKey(field = {}) {
  const rank = flatSkuAttributeGroupRank(field);
  if (rank >= 280) return "main";
  if (rank >= 160) return "product";
  return "other";
}

function sortFlatSkuAttributeFields(a = {}, b = {}) {
  return flatSkuAttributeGroupRank(b) - flatSkuAttributeGroupRank(a)
    || Number(b.required) - Number(a.required)
    || Number(!hasAttributeValue(a)) - Number(!hasAttributeValue(b))
    || Number(a.sort_order || 0) - Number(b.sort_order || 0);
}

function formatFlatAttributeValue(value, field = {}) {
  if (Array.isArray(value)) return value.map((item) => formatFlatAttributeValue(item, field)).filter(Boolean).join(", ");
  if (value && typeof value === "object") {
    return localizeAttributeDisplayText(value.display_value_zh || value.label || value.value || value.name || value.text || "", field);
  }
  return localizeAttributeDisplayText(String(value ?? "").trim(), field);
}

function attributeDisplayText(field = {}) {
  const selected = selectedAttributeOptions(field);
  if (selected.length) {
    const labels = selected.map((option) => displayAttributeOptionLabel(option, field)).filter(Boolean);
    if (labels.length) return labels.join(", ");
  }
  return formatFlatAttributeValue(field.value, field) || "未填写";
}

function flatSkuAttributeDisplayText(row = {}, field = {}) {
  const variantEntry = findVariantDynamicAttributeEntry(row, field);
  if (variantEntry) {
    const selected = normalizeArray(variantEntry.selected_values || variantEntry.selectedValues);
    if (selected.length) {
      const labels = selected.map((option) => formatFlatAttributeValue(option, field)).filter(Boolean);
      if (labels.length) return labels.join(", ");
    }
    const valueText = formatFlatAttributeValue(variantEntry.value, field);
    if (valueText) return valueText;
  }
  return attributeDisplayText(field);
}

function fixedFlatSkuFieldDisplayText(key, row = {}) {
  if (key === "brand") return formatFlatAttributeValue(fixedForm.value.brand) || "未填写";
  if (key === "model") return formatFlatAttributeValue(fixedForm.value.model) || "未填写";
  if (key === "tags") {
    const tags = variantFieldMode.tags ? row.main_tags : fixedForm.value.tags;
    return formatFlatAttributeValue(tags) || "未填写";
  }
  if (key === "summary") return formatFlatAttributeValue(fixedForm.value.summary) || "未填写";
  if (key === "weight") {
    const value = variantFieldMode.weight ? row.weight_g : templateEditor.weight_g;
    return value ? `${value} g` : "未填写";
  }
  if (key === "dimensions") {
    if (variantFieldMode.dimensions) {
      const values = [row.length_mm, row.width_mm, row.height_mm].map((item) => Number(item || 0));
      return values.some(Boolean) ? `${values[0] || 0} x ${values[1] || 0} x ${values[2] || 0} mm` : "未填写";
    }
    const values = [templateEditor.length_cm, templateEditor.width_cm, templateEditor.height_cm].map((item) => Number(item || 0));
    return values.some(Boolean) ? `${values[0] || 0} x ${values[1] || 0} x ${values[2] || 0} cm` : "未填写";
  }
  return "未填写";
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
  if (fixedForm.value.tags?.length) setAttributeByIdsOrNames([23171], ["产品标签", "主题标签", "主图标签", "ключевые слова", "тег"], fixedForm.value.tags.join(","), { name: "产品标签", attribute_id: 23171, type: "multiselect", source: "fixed_form" });
  if (fixedForm.value.summary) setAttributeByIdsOrNames([4191], ["简介", "Description", "Аннотация", "Описание"], fixedForm.value.summary, { name: "简介", attribute_id: 4191, source: "fixed_form" });
  if (fixedForm.value.richJson) setAttributeByNames(["JSON富内容", "Rich", "rich"], fixedForm.value.richJson, { name: "JSON富内容", source: "fixed_form" });
}

const fixedForm = computed({
  get() {
    return {
      brand: getAttributeByNames(["品牌", "Бренд"], "无品牌"),
      model: getAttributeByIdsOrNames([9048], ["型号名称", "Модель"], ""),
      tags: normalizeOzonTagList(getAttributeByNames(["产品标签", "主题标签", "主图标签", "ключевые слова", "тег"], "")),
      summary: getAttributeByIdsOrNames([4191], ["简介", "Description", "Аннотация", "Описание"], ""),
      richJson: getAttributeByNames(["JSON富内容", "Rich", "rich"], "")
    };
  },
  set(value) {
    setAttributeByNames(["品牌", "Бренд"], value.brand, { name: "品牌", required: true });
    setAttributeByIdsOrNames([9048], ["型号名称", "Модель"], value.model, { name: "型号名称", required: true, attribute_id: 9048 });
    setAttributeByIdsOrNames([23171], ["产品标签", "主题标签", "主图标签", "ключевые слова", "тег"], (value.tags || []).join(","), { name: "产品标签", attribute_id: 23171, type: "multiselect", source: "fixed_form" });
    setAttributeByIdsOrNames([4191], ["简介", "Description", "Аннотация", "Описание"], value.summary, { name: "简介", attribute_id: 4191 });
    setAttributeByNames(["JSON富内容", "Rich", "rich"], value.richJson, { name: "JSON富内容" });
  }
});

const fixedVariantAttributeDefinitions = {
  model: {
    ids: [9048],
    names: ["型号名称", "型号", "Модель"],
    defaults: { name: "型号名称", required: true, attribute_id: 9048, type: "text", source: "fixed_form" }
  },
  summary: {
    ids: [4191],
    names: ["简介", "Description", "Аннотация", "Описание"],
    defaults: { name: "简介", attribute_id: 4191, type: "textarea", source: "fixed_form" }
  },
  richJson: {
    ids: [11254],
    names: ["JSON富内容", "Rich", "rich"],
    defaults: { name: "JSON富内容", attribute_id: 11254, type: "rich_json", source: "fixed_form" }
  }
};

function fixedVariantAttributeDefinition(key) {
  return fixedVariantAttributeDefinitions[key] || null;
}

function findAttributeByIdsOrNames(ids = [], names = []) {
  const idSet = new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id || "")).filter(Boolean));
  if (idSet.size) {
    const byId = templateEditor.attributes.find((item) => idSet.has(String(item.attribute_id || item.id || "")));
    if (byId) return byId;
  }
  const list = expandAttributeNameAliases(Array.isArray(names) ? names : [names]);
  return templateEditor.attributes.find((item) => list.some((name) => name && String(item.name || "").includes(name))) || null;
}

function ensureFixedVariantAttribute(key) {
  const definition = fixedVariantAttributeDefinition(key);
  if (!definition) return null;
  const existing = findAttributeByIdsOrNames(definition.ids, definition.names);
  if (existing) {
    Object.entries(definition.defaults || {}).forEach(([field, value]) => {
      if ((existing[field] === undefined || existing[field] === null || existing[field] === "") && value !== undefined) existing[field] = value;
    });
    return existing;
  }
  const value = fixedForm.value[key] ?? "";
  const attr = {
    ...definition.defaults,
    value,
    required: Boolean(definition.defaults?.required),
    dictionary_id: definition.defaults?.dictionary_id || "",
    values: definition.defaults?.values || [],
    sort_order: templateEditor.attributes.length + 1
  };
  templateEditor.attributes.push(attr);
  return attr;
}

function variantModelAttribute() {
  return ensureFixedVariantAttribute("model");
}

function variantModelValue(row = {}) {
  const field = variantModelAttribute();
  return field ? String(getVariantAttributeValue(row, field) || "") : "";
}

function updateVariantModelValue(row = {}, value = "") {
  const field = variantModelAttribute();
  if (field) setVariantAttributeValue(row, field, value);
}

function seedVariantModelValue(row = {}, source = {}, fallback = fixedForm.value.model) {
  const field = variantModelAttribute();
  if (!field) return;
  const existing = normalizeModelNameValue(unwrapDynamicAttributeValue(rawVariantDynamicAttributeValue(row, field)));
  const sourceAttribute = normalizeDynamicAttributeEntries(source.dynamic_attributes || source.dynamicAttributes || source.attributes || source.attribute_values)
    .find((entry) => String(entry.attribute_id || entry.id || "") === "9048" || /型号|model|модель/i.test(String(entry.name || entry.attribute_name || "")));
  const reused = [sourceAttribute?.value ?? sourceAttribute?.values, source.model_name, source.modelName, source.model, source.vendor_model, source.vendorModel, fallback, source.spec]
    .map(unwrapDynamicAttributeValue)
    .map(normalizeModelNameValue)
    .find(Boolean) || "";
  setVariantAttributeValue(row, field, existing || reused);
}

function isFixedVariantAttributeFieldEnabled(key) {
  const field = ensureFixedVariantAttribute(key);
  return field ? isVariantAttributeField(field) : false;
}

function toggleFixedVariantAttributeField(key) {
  const field = ensureFixedVariantAttribute(key);
  if (!field) return;
  isVariantAttributeField(field) ? disableVariantAttribute(field) : enableVariantAttribute(field);
}

function splitTagValue(value) {
  if (Array.isArray(value)) return value.flatMap((item) => splitTagValue(item));
  return String(value || "")
    .replace(/#/g, " #")
    .split(/[\s,，;；、|/\\]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeTagList(value) {
  const parts = Array.isArray(value)
    ? value.flatMap((item) => splitTagValue(item))
    : splitTagValue(value);
  return Array.from(new Set(parts.map((item) => String(item || "").trim()).filter(Boolean)));
}

function normalizeOzonTagToken(value = "") {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text.replace(/^#+/, "");
  text = text.replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!text || /[\u3400-\u9fff]/u.test(text)) return "";
  if (!/[\p{L}\p{N}]/u.test(text)) return "";
  return `#${text}`.slice(0, 80);
}

function normalizeOzonTagList(value, limit = 20) {
  return Array.from(new Set(normalizeTagList(value).map(normalizeOzonTagToken).filter(Boolean))).slice(0, limit);
}

function tagClipboardText(event) {
  return event?.clipboardData?.getData?.("text/plain") || event?.clipboardData?.getData?.("text") || "";
}

function showTagNormalizeMessage(before = [], after = []) {
  const beforeCount = normalizeTagList(before).length;
  const removedCount = Math.max(0, beforeCount - after.length);
  if (removedCount > 0) {
    ElMessage.warning(`已整理为 ${after.length}/20 个 Ozon 标签，过滤 ${removedCount} 个无效或重复项`);
  }
}

function updateFixedTags(value) {
  const tags = normalizeOzonTagList(value);
  updateFixedField("tags", tags);
  showTagNormalizeMessage(value, tags);
}

function updateVariantTags(row = {}, value) {
  const tags = normalizeOzonTagList(value);
  row.main_tags = tags;
  showTagNormalizeMessage(value, tags);
}

function handleFixedTagsPaste(event) {
  const text = tagClipboardText(event);
  if (!text) return;
  event.preventDefault();
  updateFixedTags([...(fixedForm.value.tags || []), text]);
}

function handleVariantTagsPaste(row = {}, event) {
  const text = tagClipboardText(event);
  if (!text) return;
  event.preventDefault();
  updateVariantTags(row, [...(row.main_tags || []), text]);
}

function normalizeFixedTags() {
  updateFixedTags(fixedForm.value.tags || []);
}

function normalizeVariantTagsForRow(row = {}) {
  updateVariantTags(row, row.main_tags || []);
}

function clearFixedTags() {
  updateFixedField("tags", []);
}

function clearAllFixedTags() {
  updateFixedField("tags", []);
}

function clearVariantTags(row = {}) {
  row.main_tags = [];
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
  if (Number(item?.dictionary_id || 0)) return "select";
  if (Array.isArray(item?.values) && item.values.length) return "select";
  return "text";
}

function normalizeEditorImages(images) {
  return (Array.isArray(images) ? images : []).map((item, index) => {
    const source = typeof item === "string" ? { url: item } : (item || {});
    const url = source.url || source.publishUrl || source.publish_url || source.previewUrl || source.preview_url || "";
    return {
      url,
      previewUrl: source.previewUrl || source.preview_url || source.thumbnail_url || "",
      publishUrl: source.publishUrl || source.publish_url || "",
      type: source.type || source.role || "",
      role: source.role || source.type || "",
      name: source.name || url,
      outputPath: source.outputPath || source.output_path || "",
      sort_order: Number(source.sort_order || index + 1)
    };
  }).filter((item) => item.url);
}

function normalizeVariantVideoFields(item = {}) {
  const coverLinks = normalizeVariantLinks(item?.video_cover_urls || item?.cover_video_urls || item?.cover_video || "")
    .filter((url) => /\.(mp4|mov|webm)(\?|$)/i.test(url));
  const skuLinks = normalizeVariantLinks(item?.video_urls || item?.videos || item?.video_url || "")
    .filter((url) => /\.(mp4|mov|webm)(\?|$)/i.test(url));
  const cover = coverLinks[0] || "";
  const video = skuLinks[0] || "";
  return {
    video_cover_urls: cover ? [cover] : [],
    video_urls: video ? [video] : []
  };
}

function normalizeEditorVariants(variants) {
  const colorAttribute = findVariantDictionaryAttribute("color");
  const specAttribute = findVariantDictionaryAttribute("spec", { excludeIds: [colorAttribute?.attribute_id, 9048] });
  return (Array.isArray(variants) ? variants : []).map((item, index) => {
    const videoFields = normalizeVariantVideoFields(item);
    const dynamicSpec = extractVariantDynamicAttribute(item, specAttribute, "spec");
    const savedSpec = String(item?.spec || "").trim();
    const row = {
    id: item?.id || `variant-${Date.now().toString(36)}-${index}`,
    sku: item?.sku || item?.source_sku || "",
    source_sku: item?.source_sku || item?.sku || "",
    source_offer_id: item?.source_offer_id || item?.seller_offer_id || "",
    offer_id: item?.offer_id || "",
    name: item?.name || item?.title || templateEditor.title || "",
    title: item?.title || item?.name || templateEditor.title || "",
    images: normalizeEditorImages(item?.images || (item?.primary_image ? [item.primary_image].concat(item?.images || []) : [])),
    video_cover_urls: videoFields.video_cover_urls,
    video_urls: videoFields.video_urls,
    barcode: item?.barcode || "",
    cost_price: Number(item?.cost_price || 0),
    price: Number(item?.price || 0),
    old_price: Number(item?.old_price || 0),
    price_strategy_mode: item?.price_strategy_mode || item?.priceStrategyMode || "",
    price_strategy_applied: Boolean(item?.price_strategy_applied || item?.priceStrategyApplied),
    color: normalizeColorValuesForField(item?.color || extractVariantDynamicAttribute(item, colorAttribute, "color") || "", colorAttribute || {}).join(", "),
    color_values: normalizeColorValuesForField(item?.color_values || item?.colors || item?.color || extractVariantDynamicAttribute(item, colorAttribute, "color") || "", colorAttribute || {}),
    spec: isParentModelSpecValue(savedSpec) ? (dynamicSpec || "") : (savedSpec || dynamicSpec || ""),
    main_tags: splitTagValue(item?.main_tags || item?.hashtags || item?.tags || ""),
    weight_g: Number(item?.weight_g || templateEditor.weight_g || 0),
    length_mm: normalizeVariantDimensionMm(item?.length_mm, item?.depth, item?.length_cm, templateEditor.length_cm),
    width_mm: normalizeVariantDimensionMm(item?.width_mm, item?.width, item?.width_cm, templateEditor.width_cm),
    height_mm: normalizeVariantDimensionMm(item?.height_mm, item?.height, item?.height_cm, templateEditor.height_cm),
    stock: Number(item?.stock || 0),
    dynamic_attributes: clonePlain(item?.dynamic_attributes || item?.dynamicAttributes || {}, {}),
    sort_order: Number(item?.sort_order || index + 1)
    };
    sanitizeVariantColorFields(row, colorAttribute || {});
    seedVariantModelValue(row, item);
    return row;
  });
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
  return (options) => uploadMediaIntoList(options, ensureVariantOwnImages(row), "image", () => markVariantImagesEdited(row));
}

function uploadVariantVideoRequest(row, field, expectedType = "video") {
  return (options) => uploadMediaIntoLinks(options, ensureVariantLinks(row, field), expectedType);
}

async function uploadMediaIntoList(options, targetList, expectedType, onAdded) {
  try {
    uploadingImage.value = true;
    const result = await uploadListingMedia(options.file);
    if (expectedType && result.mediaType !== expectedType) throw new Error(expectedType === "image" ? "请上传图片文件" : "请上传视频文件");
    const image = {
      url: result.publishUrl || result.url || result.previewUrl,
      previewUrl: result.previewUrl || result.url,
      name: result.name || options.file?.name || "",
      sort_order: targetList.length + 1
    };
    targetList.push(image);
    onAdded?.(image);
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
    targetList.splice(0, targetList.length, result.publishUrl || result.url || result.previewUrl);
    options.onSuccess?.(result);
    ElMessage.success("素材已上传");
  } catch (error) {
    options.onError?.(error);
    ElMessage.error(error.message || "素材上传失败");
  } finally {
    uploadingImage.value = false;
  }
}

function normalizeRepairedImageItems(images = []) {
  return (Array.isArray(images) ? images : [])
    .map((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const url = String(item.url || item.previewUrl || item.value || "").trim();
        return url ? { ...item, url, sort_order: item.sort_order || index + 1 } : null;
      }
      const url = String(item || "").trim();
      return url ? { url, name: "", sort_order: index + 1 } : null;
    })
    .filter(Boolean);
}

function variantMediaRepairSourceCount(row = {}) {
  return [
    ...(Array.isArray(row.images) ? row.images : []),
    ...ensureVariantLinks(row, "video_cover_urls"),
    ...ensureVariantLinks(row, "video_urls")
  ].filter((item) => variantImageUrl(item) || String(item || "").trim()).length;
}

async function repairVariantMediaRow(row, options = {}) {
  if (!row) return { replacements: [], unresolved: [] };
  const result = await apiClient.post("/api/listing/media/repair", {
    images: Array.isArray(row.images) ? row.images : [],
    video_cover_urls: ensureVariantLinks(row, "video_cover_urls"),
    video_urls: ensureVariantLinks(row, "video_urls"),
    sourceId: row.offer_id || row.sku || row.source_sku || row.id || templateEditor.id || ""
  });
  row.images = normalizeRepairedImageItems(result.images || row.images);
  row.video_cover_urls = Array.isArray(result.video_cover_urls) ? result.video_cover_urls : row.video_cover_urls;
  row.video_urls = Array.isArray(result.video_urls) ? result.video_urls : row.video_urls;
  if (result.changed) markVariantImagesEdited(row);
  if (!options.silent) {
    syncDraftImagesFromVariantImages();
    const fixed = result.replacements?.length || 0;
    const failed = result.unresolved?.length || 0;
    if (fixed) ElMessage.success(`已修复 ${fixed} 个素材地址`);
    else if (failed) ElMessage.warning(`还有 ${failed} 个素材地址未能自动修复`);
    else ElMessage.success("当前素材地址已符合 Ozon 识别规则");
  }
  return result;
}

async function repairCurrentVariantMedia() {
  const row = variantImageEditor.row || variantVideoEditor.row;
  if (!row) return;
  repairingListingMedia.value = true;
  try {
    await repairVariantMediaRow(row);
  } catch (error) {
    ElMessage.error(error.message || "素材地址修复失败");
  } finally {
    repairingListingMedia.value = false;
  }
}

async function repairAllListingMedia() {
  const rows = templateEditor.variants || [];
  const hasTemplateImages = templateEditor.images.some((item) => variantImageUrl(item));
  const hasVariantMedia = rows.some((row) => variantMediaRepairSourceCount(row));
  if (!hasTemplateImages && !hasVariantMedia) {
    ElMessage.warning("请先准备图片或视频素材");
    return;
  }
  repairingListingMedia.value = true;
  let fixed = 0;
  let failed = 0;
  try {
    if (hasTemplateImages) {
      const result = await apiClient.post("/api/listing/media/repair", {
        images: templateEditor.images,
        sourceId: templateEditor.id || draftForm.internal_code || ""
      });
      templateEditor.images = normalizeRepairedImageItems(result.images || templateEditor.images);
      fixed += result.replacements?.length || 0;
      failed += result.unresolved?.length || 0;
    }
    for (const row of rows) {
      if (!variantMediaRepairSourceCount(row)) continue;
      const result = await repairVariantMediaRow(row, { silent: true });
      fixed += result.replacements?.length || 0;
      failed += result.unresolved?.length || 0;
    }
    syncDraftImagesFromVariantImages();
    if (fixed) ElMessage.success(`已修复 ${fixed} 个素材地址`);
    else if (failed) ElMessage.warning(`还有 ${failed} 个素材地址未能自动修复`);
    else ElMessage.success("图片和视频地址已符合 Ozon 识别规则");
  } catch (error) {
    ElMessage.error(error.message || "素材地址修复失败");
  } finally {
    repairingListingMedia.value = false;
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
  if (isBatchDraftEdit.value) {
    ElMessage.warning("批量草稿编辑中，每一行固定对应一个草稿，不能新增行");
    return;
  }
  const row = {
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
    color: normalizeColorValuesForField(templateEditor.color || "", variantColorAttribute.value || {}).join(", "),
    color_values: normalizeColorValuesForField(templateEditor.color || "", variantColorAttribute.value || {}),
    spec: templateEditor.spec || "",
    main_tags: fixedForm.value.tags || [],
    weight_g: Number(templateEditor.weight_g || 0),
    length_mm: cmToMm(templateEditor.length_cm),
    width_mm: cmToMm(templateEditor.width_cm),
    height_mm: cmToMm(templateEditor.height_cm),
    stock: Number(templateEditor.quantity || 0),
    dynamic_attributes: {},
    sort_order: templateEditor.variants.length + 1
  };
  seedVariantModelValue(row, {}, "");
  templateEditor.variants.push(row);
}

function removeVariantRow(row) {
  if (isBatchDraftEdit.value) {
    ElMessage.warning("批量草稿编辑中不能删除草稿行");
    return;
  }
  const index = templateEditor.variants.findIndex((item) => item.id === row?.id);
  if (index >= 0) templateEditor.variants.splice(index, 1);
}

function duplicateVariantRow(row) {
  if (isBatchDraftEdit.value) {
    ElMessage.warning("批量草稿编辑中不能复制草稿行");
    return;
  }
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
    main_tags: Array.isArray(row.main_tags) ? row.main_tags.slice() : [],
    color_values: normalizeColorValuesForField(row.color_values?.length ? row.color_values : row.color, variantColorAttribute.value || {}),
    dynamic_attributes: clonePlain(row.dynamic_attributes || {}, {})
  };
  updateVariantModelValue(copy, "");
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

function offerIdRandomToken(length = 4) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  }
  return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function offerIdSourceToken(row = {}) {
  const raw = [
    row.source_sku,
    row.source_offer_id,
    templateEditor.source_ozon_sku,
    templateEditor.id,
    draftForm.internal_code,
    collectorSourceSku.value,
    templateEditor.title
  ].map((value) => String(value || "").trim()).find(Boolean);
  if (!raw) return `NEW${Date.now().toString(36).toUpperCase().slice(-4)}`;
  const cleaned = cleanOfferIdPart(raw, "");
  return cleaned || stableStringHash(raw).slice(0, 10);
}

function offerIdShopToken() {
  const shopId = draftForm.shop_ids[0] || copyForm.shop_id || "";
  return shopId ? `S${cleanOfferIdPart(shopId, "0").slice(0, 8)}` : "S0";
}

function productTypeAbbr(value = "") {
  const words = String(value || "").match(/[A-Za-z0-9]+/g) || [];
  if (!words.length) return "SKU";
  if (words.length === 1) return words[0].slice(0, 5).toUpperCase();
  return words.slice(0, 4).map((word) => word[0]).join("").toUpperCase();
}

function generateLocalOfferId(existingIds = new Set(), index = 0, row = {}) {
  const { brand, productType } = offerIdPrefix();
  const brandToken = cleanOfferIdPart(brand).slice(0, 12);
  const typeToken = cleanOfferIdPart(productTypeAbbr(productType), "SKU").slice(0, 8);
  const sourceToken = offerIdSourceToken(row).slice(0, 18);
  const variantToken = `V${String(Math.max(0, index) + 1).padStart(3, "0")}`;
  const timeToken = Date.now().toString(36).toUpperCase().slice(-5);
  const prefix = `${brandToken}-${typeToken}-${sourceToken}-${offerIdShopToken()}-${variantToken}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `${prefix}-${timeToken}-${offerIdRandomToken(4)}`.slice(0, 128);
    if (!existingIds.has(id)) {
      existingIds.add(id);
      return id;
    }
  }
  const fallback = `${prefix}-${timeToken}-${stableStringHash(`${sourceToken}:${index}:${Math.random()}`).slice(0, 6)}`.slice(0, 128);
  existingIds.add(fallback);
  return fallback;
}

function generateVariantOfferId(row) {
  if (!row) return;
  const existingIds = new Set(templateEditor.variants.map((item) => String(item.offer_id || "").trim()).filter(Boolean));
  existingIds.delete(String(row.offer_id || "").trim());
  row.offer_id = generateLocalOfferId(existingIds, templateEditor.variants.indexOf(row), row);
}

function generateAllVariantOfferIds() {
  const rows = templateEditor.variants;
  if (!rows.length) {
    ElMessage.warning("请先添加变体");
    return;
  }
  const existingIds = new Set();
  rows.forEach((row) => {
    row.offer_id = generateLocalOfferId(existingIds, templateEditor.variants.indexOf(row), row);
  });
  ElMessage.success(`已重新生成 ${rows.length} 个货号 / offer_id`);
}

function generateLocalModelName(existingNames = new Set(), index = 0, row = {}) {
  const raw = row.offer_id || row.source_offer_id || row.source_sku || row.sku || templateEditor.source_ozon_sku || templateEditor.title;
  const sourceToken = cleanOfferIdPart(raw, "MODEL").slice(0, 48);
  const variantToken = `V${String(Math.max(0, index) + 1).padStart(3, "0")}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = `MODEL-${sourceToken}-${variantToken}-${offerIdRandomToken(4)}`.slice(0, 128);
    if (!existingNames.has(value)) {
      existingNames.add(value);
      return value;
    }
  }
  return `MODEL-${sourceToken}-${variantToken}-${Date.now().toString(36).toUpperCase()}`.slice(0, 128);
}

function generateVariantModelName(row) {
  if (!row) return;
  const existingNames = new Set(templateEditor.variants.map(variantModelValue).filter(Boolean));
  existingNames.delete(variantModelValue(row));
  updateVariantModelValue(row, generateLocalModelName(existingNames, templateEditor.variants.indexOf(row), row));
}

function generateAllVariantModelNames() {
  const rows = templateEditor.variants;
  if (!rows.length) {
    ElMessage.warning("请先添加变体");
    return;
  }
  const existingNames = new Set();
  rows.forEach((row, index) => {
    updateVariantModelValue(row, generateLocalModelName(existingNames, index, row));
  });
  ElMessage.success(`已重新生成 ${rows.length} 个型号名称`);
}

function handleVariantSelectionChange(rows) {
  const selectedById = new Map(selectedVariantRows.value.map((row) => [row.id, row]));
  const currentPageIds = new Set(variantPageRows.value.map((row) => row.id));
  currentPageIds.forEach((id) => selectedById.delete(id));
  (rows || []).forEach((row) => selectedById.set(row.id, row));
  selectedVariantRows.value = templateEditor.variants.filter((row) => selectedById.has(row.id));
}

function variantTableIndex(index) {
  return (variantTablePage.value - 1) * VARIANT_TABLE_PAGE_SIZE + index + 1;
}

function removeSelectedVariants() {
  if (isBatchDraftEdit.value) {
    ElMessage.warning("批量草稿编辑中不能删除草稿行");
    return;
  }
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
  const firstColorValues = field === "color" ? cloneVariantValue(first.color_values || normalizeColorValuesForField(first.color, variantColorAttribute.value || {})) : null;
  templateEditor.variants.forEach((row, index) => {
    if (index === 0) return;
    row[field] = cloneVariantValue(value);
    if (field === "color") {
      row.color_values = cloneVariantValue(firstColorValues);
      syncVariantColor(row);
    }
  });
  ElMessage.success("已同步首行内容");
}

function applyFirstVariantVideoMedia(field = "video_urls") {
  const first = templateEditor.variants[0];
  if (!first) {
    ElMessage.warning("请先添加首行变体");
    return;
  }
  const source = [
    ...ensureVariantLinks(first, field),
    ...ensureVariantLinks(first, field === "video_cover_urls" ? "video_urls" : "video_cover_urls")
  ].find(Boolean);
  if (!source) {
    ElMessage.warning("请先在首行上传或填写视频");
    return;
  }
  templateEditor.variants.forEach((row) => {
    row.video_cover_urls = [source];
    row.video_urls = [source];
  });
  ElMessage.success(`已同步 ${templateEditor.variants.length} 个变体的视频封面和视频`);
}

function variantPrimaryImageUrl(row = {}) {
  const ownImage = ensureVariantOwnImages(row).find((image) => variantImageUrl(image));
  if (ownImage) return variantImageUrl(ownImage);
  const templateImage = templateEditor.images.find((image) => variantImageUrl(image));
  return templateImage ? variantImageUrl(templateImage) : "";
}

async function generateVariantMedia(row, field) {
  const imageUrl = variantPrimaryImageUrl(row);
  if (!imageUrl) throw new Error(`${row.name || row.sku || "当前变体"} 缺少主图`);
  const result = await generateAiVideo({
    imageUrl,
    sourceId: row.offer_id || row.sku || row.source_sku || row.id,
    title: row.title || row.name || templateEditor.title || templateEditor.template_name
  }, { sourceModule: "listing_variant_media", listingVariantMedia: true });
  const videoUrl = result.video?.publishUrl || result.cover?.publishUrl || "";
  if (!videoUrl) throw new Error(`${row.name || row.sku || "当前变体"} 未获得公网视频地址`);
  row.video_cover_urls = [videoUrl];
  row.video_urls = [videoUrl];
}

async function generateAllVariantMedia(field) {
  const rows = templateEditor.variants.filter((row) => row.sku || row.name || ensureVariantOwnImages(row).length);
  if (!rows.length) {
    ElMessage.warning("请先添加变体");
    return;
  }
  const loadingRef = field === "video_cover_urls" ? generatingVariantCovers : generatingVariantVideos;
  loadingRef.value = true;
  let done = 0;
  const failures = [];
  try {
    for (const row of rows) {
      try {
        await generateVariantMedia(row, field);
        done += 1;
      } catch (error) {
        failures.push(error.message || "生成失败");
      }
    }
    if (failures.length) {
      ElMessage.warning(`已生成 ${done} 个，${failures.length} 个失败：${failures[0]}`);
    } else {
      ElMessage.success(`已生成 ${done} 个变体视频，并同步到视频封面和视频`);
    }
  } finally {
    loadingRef.value = false;
  }
}

function applyFirstVariantTitleToRow(row) {
  const first = templateEditor.variants[0];
  if (!first || !row || row === first) return;
  row.title = cloneVariantValue(first.title);
}

function doubleVariantPriceField(field) {
  let changed = 0;
  templateEditor.variants.forEach((row) => {
    const base = field === "old_price" ? Number(row.price || 0) : Number(row[field] || 0);
    if (!Number.isFinite(base) || base <= 0) return;
    row[field] = Number((base * 2).toFixed(2));
    changed += 1;
  });
  if (changed) ElMessage.success(`已处理 ${changed} 行`);
  else ElMessage.warning("没有可处理的价格");
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
        if (field === "color") {
          row.color_values = normalizeColorValuesForField(value, variantColorAttribute.value || {});
          syncVariantColor(row);
        }
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
    if (field === "color") {
      row.color_values = normalizeColorValuesForField(value, variantColorAttribute.value || {});
      syncVariantColor(row);
    }
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
  const nextEnabled = Boolean(enabled);
  if (!nextEnabled && variantFieldHasDiverged(field)) {
    ElMessage.warning("该字段在变体里已有多个值，不能直接回退为公共字段，请先手动统一后再回退");
    return;
  }
  variantFieldMode[field] = nextEnabled;
  if (!variantFieldMode[field]) {
    moveVariantFieldBackToCommon(field);
    return;
  }
  if (field === "title") {
    templateEditor.variants.forEach((row) => {
      row.title = row.title || templateEditor.title;
    });
    templateEditor.title = "";
  } else if (field === "weight") {
    templateEditor.variants.forEach((row) => {
      row.weight_g = Number(row.weight_g || templateEditor.weight_g || 0);
    });
    templateEditor.weight_g = 0;
  } else if (field === "dimensions") {
    templateEditor.variants.forEach((row) => {
      row.length_mm = Number(row.length_mm || cmToMm(templateEditor.length_cm) || 0);
      row.width_mm = Number(row.width_mm || cmToMm(templateEditor.width_cm) || 0);
      row.height_mm = Number(row.height_mm || cmToMm(templateEditor.height_cm) || 0);
    });
    templateEditor.length_cm = 0;
    templateEditor.width_cm = 0;
    templateEditor.height_cm = 0;
  } else if (field === "tags") {
    templateEditor.variants.forEach((row) => {
      row.main_tags = Array.isArray(row.main_tags) && row.main_tags.length ? row.main_tags : fixedForm.value.tags.slice();
    });
    updateFixedField("tags", []);
  } else if (String(field || "").startsWith("attr:")) {
    const attr = templateEditor.attributes.find((item) => variantAttributeModeKey(item) === field);
    if (!attr) return;
    templateEditor.variants.forEach((row) => {
      setVariantAttributeValue(row, attr, getVariantAttributeValue(row, attr) || cloneVariantValue(attr.value));
    });
  }
}

function disableVariantField(field) {
  setVariantFieldMode(field, false);
}

function normalizedVariantFieldValue(row = {}, field = "") {
  if (field === "title") return String(row.title || "").trim();
  if (field === "weight") return String(Number(row.weight_g || 0));
  if (field === "dimensions") return [row.length_mm, row.width_mm, row.height_mm].map((value) => Number(value || 0)).join("x");
  if (field === "tags") return (Array.isArray(row.main_tags) ? row.main_tags : splitTagValue(row.main_tags)).map((item) => String(item || "").trim()).filter(Boolean).sort().join("|");
  if (String(field || "").startsWith("attr:")) {
    const attr = templateEditor.attributes.find((item) => variantAttributeModeKey(item) === field);
    const value = attr ? getVariantAttributeValue(row, attr) : "";
    if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean).sort().join("|");
    return String(value || "").trim();
  }
  return String(row[field] || "").trim();
}

function variantFieldHasDiverged(field) {
  const values = templateEditor.variants
    .map((row) => normalizedVariantFieldValue(row, field))
    .filter((value) => value && value !== "0" && value !== "0x0x0");
  return new Set(values).size > 1;
}

function variantSpecLooksLikeColor() {
  const values = templateEditor.variants
    .map((row) => String(row.spec || "").trim())
    .filter(Boolean);
  if (!values.length) return false;
  const colorLikeCount = values.filter(isColorLikeText).length;
  return colorLikeCount >= Math.ceil(values.length * 0.6);
}

function isColorLikeText(value = "") {
  const tokens = normalizeColorValues(value).map((item) => item.toLowerCase());
  if (!tokens.length) return false;
  const colorWords = [
    "бел", "черн", "чёрн", "золот", "серебр", "сер", "красн", "син", "голуб", "зелен", "зелён",
    "желт", "жёлт", "оранж", "роз", "фиолет", "корич", "беж", "бордов", "хром", "металлик",
    "black", "white", "gray", "grey", "red", "blue", "green", "yellow", "orange", "pink", "purple", "brown", "beige", "silver", "silvery",
    "黑", "白", "灰", "红", "蓝", "绿", "黄", "橙", "粉", "紫", "棕", "金", "银", "透明"
  ];
  return tokens.every((token) => colorWords.some((word) => token.includes(word)));
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
  } else if (String(field || "").startsWith("attr:")) {
    const attr = templateEditor.attributes.find((item) => variantAttributeModeKey(item) === field);
    const value = attr
      ? rows.map((row) => getVariantAttributeValue(row, attr)).find((item) => Array.isArray(item) ? item.length : String(item || "").trim())
      : null;
    if (attr && value !== null && value !== undefined) {
      attr.value = cloneVariantValue(value);
      rows.forEach((row) => {
        if (row.dynamic_attributes && typeof row.dynamic_attributes === "object" && !Array.isArray(row.dynamic_attributes)) {
          delete row.dynamic_attributes[variantDynamicAttributeKey(attr)];
        }
      });
    }
  }
  ElMessage.success("已合并为公共字段");
}

function enableVariantAttribute(field = {}) {
  setVariantFieldMode(variantAttributeModeKey(field), true);
}

function disableVariantAttribute(field = {}) {
  setVariantFieldMode(variantAttributeModeKey(field), false);
}

function applyFirstVariantAttribute(field = {}) {
  const first = templateEditor.variants[0];
  if (!first) return;
  const value = cloneVariantValue(getVariantAttributeValue(first, field));
  templateEditor.variants.forEach((row, index) => {
    if (index === 0) return;
    setVariantAttributeValue(row, field, cloneVariantValue(value));
    if (isColorAttributeField(field)) {
      row.color_values = normalizeColorValuesForField(value, field);
      row.color = normalizeColorForPayload(row);
    }
  });
  ElMessage.success("已同步首行属性");
}

function applyFirstFlatSharedField() {
  ElMessage.success("这是公共属性，所有 SKU 已共用同一值");
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

function markVariantImagesEdited(row) {
  if (!row) return;
  row.images_manually_edited = true;
  row.image_edit_intent = "manual";
}

function openVariantImageEditor(row) {
  ensureVariantOwnImages(row);
  variantImageEditor.row = row;
  variantImageEditor.activeTab = "sku";
  variantImageEditor.draggingImageIndex = -1;
  variantImageEditor.dragOverImageIndex = -1;
  variantImageEditor.visible = true;
}

function variantImageUrl(image) {
  return String(image?.previewUrl || image?.url || image || "").trim();
}

function isVariantImageSelected(image) {
  const url = variantImageUrl(image);
  return url && ensureVariantOwnImages(variantImageEditor.row).some((item) => variantImageUrl(item) === url);
}

function toggleVariantImageSelection(image) {
  const url = variantImageUrl(image);
  if (!url) return;
  const images = ensureVariantOwnImages(variantImageEditor.row);
  const index = images.findIndex((item) => variantImageUrl(item) === url);
  if (index >= 0) {
    images.splice(index, 1);
    markVariantImagesEdited(variantImageEditor.row);
    return;
  }
  images.push({
    ...image,
    url,
    sort_order: images.length + 1
  });
  markVariantImagesEdited(variantImageEditor.row);
}

function variantImageLibrary() {
  const sources = variantImageLibrarySources(variantImageEditor.activeTab);
  return dedupeImages(sources)
    .filter((item) => item.url)
    .map((item, index) => ({ ...item, sort_order: item.sort_order || index + 1 }));
}

function variantImageLibrarySources(tab = "sku") {
  const currentImages = ensureVariantOwnImages(variantImageEditor.row);
  if (tab === "sku") return currentImages.filter((image, index) => isSkuImageCandidate(image, index, currentImages.length));
  if (tab === "detail") return templateDetailImageCandidates();
  if (tab === "network") return networkImageCandidates();
  if (tab === "ai") return aiGeneratedImageCandidates();
  return currentImages;
}

function isSkuImageCandidate(image = {}, index = 0, total = 0) {
  const role = String(image.type || image.role || image.name || image.outputPath || "").toLowerCase();
  if (/detail|tail|details|rich/.test(role)) return false;
  return index === 0 || /main|sku|variant/.test(role) || total <= 1;
}

function isDetailImageCandidate(image = {}, index = 0, total = 0) {
  const role = String(image.type || image.role || image.name || image.outputPath || "").toLowerCase();
  if (/main|sku/.test(role) && !/detail/.test(role)) return false;
  if (/detail|details|rich/.test(role)) return true;
  return index > 0 && index < Math.max(total - 1, 1);
}

function templateDetailImageCandidates() {
  const templateImages = templateEditor.images.filter((image, index) => isDetailImageCandidate(image, index, templateEditor.images.length));
  const variantImages = templateEditor.variants.flatMap((row) => {
    const images = Array.isArray(row.images) ? row.images : [];
    return images.filter((image, index) => isDetailImageCandidate(image, index, images.length));
  });
  return [...templateImages, ...variantImages];
}

function networkImageCandidates() {
  return templateEditor.images
    .filter((image) => /^https?:\/\//i.test(variantImageUrl(image)))
    .filter((image) => !String(image.type || image.role || image.outputPath || "").toLowerCase().includes("detail"));
}

function aiGeneratedImageCandidates() {
  const rows = [variantImageEditor.row, ...templateEditor.variants].filter(Boolean);
  const sources = rows.flatMap((row) => [
    row.generatedMainImageUrl,
    row.generated_main_image_url,
    ...(Array.isArray(row.generatedDetailImages) ? row.generatedDetailImages : []),
    ...(Array.isArray(row.generated_detail_images) ? row.generated_detail_images : [])
  ]);
  return sources.map((url, index) => ({
    url: String(url || "").trim(),
    name: `AI ${index + 1}`,
    type: "ai",
    role: "ai"
  })).filter((item) => item.url);
}

function variantSelectedPreviewList() {
  return ensureVariantOwnImages(variantImageEditor.row)
    .map((item) => variantImageUrl(item))
    .filter(Boolean)
    .map((url) => withImageToken(url));
}

function confirmVariantImageEditor() {
  if (!variantImageEditor.row) return;
  markVariantImagesEdited(variantImageEditor.row);
  variantImageEditor.row.images = dedupeImages(ensureVariantOwnImages(variantImageEditor.row))
    .filter((item) => variantImageUrl(item))
    .map((item, index) => ({
      ...item,
      url: variantImageUrl(item),
      sort_order: index + 1
    }));
  syncDraftImagesFromVariantImages();
  variantImageEditor.visible = false;
  ElMessage.success("已更新 SKU 图片");
}

function addCurrentLibraryImagesToVariant() {
  if (!variantImageEditor.row) return;
  markVariantImagesEdited(variantImageEditor.row);
  const images = ensureVariantOwnImages(variantImageEditor.row);
  const existing = new Set(images.map((item) => variantImageUrl(item)).filter(Boolean));
  for (const image of variantImageLibrary()) {
    const url = variantImageUrl(image);
    if (!url || existing.has(url)) continue;
    images.push({
      ...image,
      url,
      sort_order: images.length + 1
    });
    existing.add(url);
  }
}

function clearVariantImages() {
  if (!variantImageEditor.row) return;
  markVariantImagesEdited(variantImageEditor.row);
  ensureVariantOwnImages(variantImageEditor.row).splice(0);
  syncDraftImagesFromVariantImages();
}

function syncDraftImagesFromVariantImages() {
  // SKU images are isolated per variant. They must never become draft-level source images.
}

function ensureIndependentVariantFields(options = {}) {
  const useCommonFallback = options.useCommonFallback !== false;
  const commonTags = useCommonFallback ? fixedForm.value.tags.slice() : [];
  templateEditor.variants.forEach((row) => {
    if ((!Array.isArray(row.main_tags) || !row.main_tags.length) && commonTags.length) row.main_tags = commonTags.slice();
    if (useCommonFallback && !Number(row.weight_g || 0)) row.weight_g = Number(templateEditor.weight_g || 0);
    if (useCommonFallback && !Number(row.length_mm || 0)) row.length_mm = Number(cmToMm(templateEditor.length_cm) || 0);
    if (useCommonFallback && !Number(row.width_mm || 0)) row.width_mm = Number(cmToMm(templateEditor.width_cm) || 0);
    if (useCommonFallback && !Number(row.height_mm || 0)) row.height_mm = Number(cmToMm(templateEditor.height_cm) || 0);
  });
  ["tags", "weight", "dimensions"].forEach((field) => {
    if (!variantFieldMode[field]) setVariantFieldMode(field, true);
  });
}

function addVariantImageLink() {
  markVariantImagesEdited(variantImageEditor.row);
  const images = ensureVariantOwnImages(variantImageEditor.row);
  images.push({ url: "", name: "", sort_order: images.length + 1 });
  draftImagesManuallyEdited.value = true;
}

function syncVariantImageLink(image) {
  markVariantImagesEdited(variantImageEditor.row);
  syncDraftImagesFromVariantImages();
}

function removeVariantImage(index) {
  markVariantImagesEdited(variantImageEditor.row);
  const images = ensureVariantOwnImages(variantImageEditor.row);
  images.splice(index, 1);
  syncDraftImagesFromVariantImages();
}

function startVariantImageDrag(index) {
  variantImageEditor.draggingImageIndex = index;
  variantImageEditor.dragOverImageIndex = index;
}

function finishVariantImageDrag() {
  variantImageEditor.draggingImageIndex = -1;
  variantImageEditor.dragOverImageIndex = -1;
}

function reorderVariantImage(fromIndex, toIndex) {
  const images = ensureVariantOwnImages(variantImageEditor.row);
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= images.length || toIndex >= images.length) {
    finishVariantImageDrag();
    return;
  }
  const [image] = images.splice(fromIndex, 1);
  markVariantImagesEdited(variantImageEditor.row);
  images.splice(toIndex, 0, image);
  images.forEach((item, index) => {
    item.sort_order = index + 1;
  });
  syncDraftImagesFromVariantImages();
  finishVariantImageDrag();
}

function useTemplateImagesForVariant() {
  if (!variantImageEditor.row) return;
  markVariantImagesEdited(variantImageEditor.row);
  variantImageEditor.row.images = templateEditor.images.filter((item) => item.url).map((item, index) => ({ ...item, sort_order: index + 1 }));
  syncDraftImagesFromVariantImages();
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
  if ((field === "video_cover_urls" || field === "video_urls") && row[field].length > 1) row[field].splice(1);
  return row[field];
}

function variantPreviewVideos(row, field) {
  return ensureVariantLinks(row, field).filter(Boolean).slice(0, 1);
}

function variantVideoOverflow(row, field) {
  return Math.max(ensureVariantLinks(row, field).filter(Boolean).length - 1, 0);
}

function openVariantVideoEditor(row, field, title) {
  ensureVariantLinks(row, field);
  variantVideoEditor.row = row;
  variantVideoEditor.field = field;
  variantVideoEditor.title = title;
  variantVideoEditor.visible = true;
}

function addVariantVideoLink() {
  const links = ensureVariantLinks(variantVideoEditor.row, variantVideoEditor.field);
  if (!links.length) links.push("");
}

function setPrimaryVariantVideo(value) {
  const links = ensureVariantLinks(variantVideoEditor.row, variantVideoEditor.field);
  links.splice(0, links.length, value);
}

function clearVariantVideos() {
  const links = ensureVariantLinks(variantVideoEditor.row, variantVideoEditor.field);
  links.splice(0, links.length);
}

function removeVariantVideoLink(index) {
  ensureVariantLinks(variantVideoEditor.row, variantVideoEditor.field).splice(0, 1);
}

function richContentImageUrl(position = "last", row = null) {
  const rowImages = row && Array.isArray(row.images) ? row.images.filter((item) => item?.url) : [];
  const variantImages = templateEditor.variants
    .flatMap((row) => Array.isArray(row.images) ? row.images : [])
    .filter((item) => item?.url);
  const templateImages = templateEditor.images.filter((item) => item?.url);
  const images = [...rowImages, ...variantImages, ...templateImages];
  const picked = position === "first" ? images[0] : images.at(-1);
  return picked?.url || "";
}

function generateRichContentJson(position = "last", row = null, field = null) {
  const imageUrl = richContentImageUrl(position, row);
  const rowSummary = row && mediaSummaryAttribute.value ? getVariantAttributeValue(row, mediaSummaryAttribute.value) : "";
  const text = String(row?.description || rowSummary || fixedForm.value.summary || templateEditor.description || "").trim();
  if (!imageUrl) {
    ElMessage.warning(position === "first" ? "请先准备首图或商品图片" : "请先准备尾图或商品图片");
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
              alt: row?.name || templateEditor.title || "",
              position: "width_full",
              positionMobile: "width_full",
              widthMobile: 1024,
              heightMobile: 1536
            },
            title: {
              items: [{ type: "text", content: row?.name || templateEditor.title || "" }],
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
  if (row && field) updateVariantAttributeSelectValue(row, field, json);
  else updateRichEditorModelValue(json);
  ElMessage.success(position === "first" ? "已用首图生成 JSON 富内容" : "已用尾图生成 JSON 富内容");
  return json;
}

function generateVariantRichContentJson(row = {}, field = {}, position = "last") {
  generateRichContentJson(position, row, field);
}

function handleRichEditorSave(value) {
  updateRichEditorModelValue(value);
  ElMessage.success("Ozon 图文富内容已更新");
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
      return applyAiValueToAttribute(attr, value) ? 1 : 0;
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
        if (applyAiValueToAttribute(item, value)) changed += 1;
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
  return normalizeOzonTagList(value);
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

function applyAiValueToAttribute(attr = {}, value) {
  const normalized = normalizeAttributeAiValue(value, attr);
  const hasDictionary = (attr.type === "select" || attr.type === "multiselect") && Array.isArray(attr.values) && attr.values.length;
  if (hasDictionary && (Array.isArray(normalized) ? !normalized.length : !String(normalized || "").trim())) {
    return false;
  }
  attr.value = normalized;
  return hasAttributeValue(attr);
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
      ? await updateTemplateWithConflictRetry(payload, { retryOnConflict: true })
      : await apiClient.post("/api/listing/templates", payload);
    fillTemplateEditor(saved);
    state.templates = [saved, ...state.templates.filter((item) => Number(item.id) !== Number(saved.id))];
    draftForm.template_id = saved.id;
    ElMessage.success(creating ? "新模板已创建" : "模板已保存");
  } catch (error) {
    if (error?.status === 409) {
      ElMessage.error(error.message || "模板已被其他用户保存，请刷新后再继续编辑");
      return;
    }
    throw error;
  } finally {
    savingTemplate.value = false;
  }
}

async function updateTemplateWithConflictRetry(payload = {}, options = {}) {
  const id = templateEditor.id;
  if (!id) return null;
  const requestPayload = options.skipVersionCheck ? { ...payload, updated_at: "" } : payload;
  try {
    return await apiClient.put(`/api/listing/templates/${id}`, requestPayload);
  } catch (error) {
    if (error?.status !== 409 || !options.retryOnConflict) throw error;
    const latest = await apiClient.get(`/api/listing/templates/${id}?mode=editor`, { noCache: true, routeScoped: false });
    return apiClient.put(`/api/listing/templates/${id}`, {
      ...payload,
      updated_at: latest?.updated_at || ""
    });
  }
}

async function saveCurrentTemplateSnapshot(options = {}) {
  if (!templateEditor.id) return null;
  ensureTemplateName();
  const payload = buildTemplatePayload();
  const saved = await updateTemplateWithConflictRetry(payload, { retryOnConflict: true, skipVersionCheck: Boolean(collectorSourceSku.value) });
  fillTemplateEditor(saved);
  state.templates = [saved, ...state.templates.filter((item) => Number(item.id) !== Number(saved.id))];
  draftForm.template_id = saved.id;
  saveListingWorkbenchDraft();
  if (collectorSourceSku.value) {
    await saveCollectorBoxEditSnapshot(payload).catch((error) => {
      if (!options.silentCollectorWarning) ElMessage.warning(error.message || "采集箱编辑状态同步失败，但上架模板已保存");
    });
  }
  return saved;
}

async function ensureListingTemplateForDraft() {
  if (templateEditor.id) {
    draftForm.template_id = templateEditor.id;
    return templateEditor.id;
  }
  const routeTemplateId = Number(route.query.templateId || 0);
  if (routeTemplateId) {
    const existing = await apiClient.get(`/api/listing/templates/${routeTemplateId}?mode=editor`, { noCache: true }).catch(() => null);
    if (existing?.id) {
      fillTemplateEditor(existing, { safeOpen: true });
      draftForm.template_id = existing.id;
      return existing.id;
    }
  }
  ensureTemplateName();
  if (!String(templateEditor.ozon_category_id || "").trim() || !String(templateEditor.category_name || "").trim()) {
    throw new Error("请先选择 Ozon 类目；系统将自动创建上架商品模板并保存草稿");
  }
  const saved = await apiClient.post("/api/listing/templates", buildTemplatePayload());
  fillTemplateEditor(saved);
  state.templates = [saved, ...state.templates.filter((item) => Number(item.id) !== Number(saved.id))];
  draftForm.template_id = saved.id;
  return saved.id;
}

async function saveCollectorBoxEditSnapshot(templatePayload = buildTemplatePayload()) {
  const sku = collectorSourceSku.value;
  if (!sku) return null;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 18000);
  try {
    return await apiClient.put(`/api/listing/collector-box/${encodeURIComponent(sku)}/edit`, {
      edit_payload: templatePayloadToCollectorBoxEditPayload(templatePayload)
    }, { signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("采集箱编辑状态同步超时，请稍后重试保存");
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function templatePayloadToCollectorBoxEditPayload(payload = {}) {
  const editable = payload.editable_payload || {};
  const price = editable.price || {};
  const dimensions = editable.dimensions || {};
  const logistics = editable.logistics || {};
  const variants = Array.isArray(editable.variants) ? editable.variants : [];
  const firstVariantDimensions = firstVariantPackageValues(variants);
  const variantImages = variants.flatMap((item) => Array.isArray(item.images) ? item.images : []);
  const images = payload.images?.length
    ? payload.images
    : variantImages;
  const sourceImages = variantImages.length ? variantImages : images;
  return {
    ...editable,
    title: payload.title || editable.title || "",
    template_name: payload.template_name || templateEditor.template_name || "",
    category_name: payload.category_name || editable.category_name || "",
    ozon_category_id: payload.ozon_category_id || editable.category_id || "",
    description_category_id: editable.description_category_id || templateEditor.description_category_id || "",
    type_id: editable.type_id || templateEditor.type_id || "",
    brand: fixedForm.value.brand || "",
    model: templateEditor.spec || "",
    color: logistics.color || templateEditor.color || "",
    tags: fixedForm.value.tags || [],
    description: payload.description || editable.description || "",
    price: Number(price.value || templateEditor.price_value || 0),
    old_price: Number(price.old_price || templateEditor.old_price || 0),
    currency: price.currency_code || templateEditor.currency_code || "CNY",
    length_cm: Number(firstVariantDimensions.length_cm || dimensions.length_cm || templateEditor.length_cm || 0),
    width_cm: Number(firstVariantDimensions.width_cm || dimensions.width_cm || templateEditor.width_cm || 0),
    height_cm: Number(firstVariantDimensions.height_cm || dimensions.height_cm || templateEditor.height_cm || 0),
    weight_g: Number(firstVariantDimensions.weight_g || dimensions.weight_g || templateEditor.weight_g || 0),
    images: dedupeImages(images),
    source_images: dedupeImages(sourceImages),
    variants,
    attributes: payload.attributes || editable.attributes || [],
    source_sku: templateEditor.source_ozon_sku || collectorSourceSku.value || "",
    product_url: payload.source_raw?.product_url || payload.source_raw?.collected_product?.product_url || ""
  };
}

async function validatePublishPayload() {
  validatingPublish.value = true;
  try {
    applyOzonAttributeMappings();
    const payload = buildTemplatePayload();
    payload.include_category_health = true;
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
    template.include_category_health = true;
    const result = await apiClient.post("/api/listing/templates/publish-to-ozon", {
      template,
      shop_ids: draftForm.shop_ids,
      text_variant_policy: {
        enabled: Boolean(textVariantPolicy.enabled && draftForm.shop_ids.length > 1),
        base_shop_id: textVariantPolicy.baseShopId || draftForm.shop_ids[0] || "",
        style: textVariantPolicy.style,
        shop_styles: textVariantPolicy.shopStyles,
        fields: textVariantPolicy.fields
      },
      source_record_id: template.source_raw?.record_id || route.query.recordId || "",
      source_draft_id: template.source_raw?.listing_draft_id || draftForm.id || route.query.draftId || "",
      source_collector_sku: collectorSourceSku.value || template.source_raw?.source_sku || ""
    });
    publishSubmit.result = result;
    publishSubmit.failedOnly = Boolean(result?.results?.some((item) => item?.ok === false));
    publishSubmit.visible = true;
    if (result.ok) ElMessage.success("已创建上架处理记录，系统将在后台提交 Ozon");
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

function openPublishSubmitRecord(row = {}) {
  if (!row.record_id) {
    ElMessage.warning("这条结果还没有生成可查看的发布记录");
    return;
  }
  router.push({
    name: "listing-publish-records",
    query: {
      recordId: row.record_id,
      status: row.ok ? "all" : "failed",
      shopId: row.shop_id || "all"
    }
  });
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
  const attributes = templateEditor.attributes
    .filter((item) => item.name || item.value)
    .map((item) => normalizeAttributeForPayload(item));
  const payloadTitle = templateEditor.variants.find((item) => item.name || item.title)?.name || templateEditor.variants.find((item) => item.title)?.title || templateEditor.title || templateEditor.template_name;
  const variants = templateEditor.variants
    .filter((item) => item.sku || item.name)
    .map((item) => ({
      ...item,
      price_strategy_mode: item.price_strategy_mode || "finalized",
      price_strategy_applied: true,
      color: normalizeColorForPayload(item),
      title: item.name || item.title || templateEditor.title,
      weight_g: variantFieldMode.weight ? item.weight_g : Number(templateEditor.weight_g || 0),
      length_mm: variantFieldMode.dimensions ? item.length_mm : cmToMm(templateEditor.length_cm),
      width_mm: variantFieldMode.dimensions ? item.width_mm : cmToMm(templateEditor.width_cm),
      height_mm: variantFieldMode.dimensions ? item.height_mm : cmToMm(templateEditor.height_cm),
      main_tags: variantFieldMode.tags ? item.main_tags : fixedForm.value.tags,
      dynamic_attributes: Object.fromEntries(Object.entries(item.dynamic_attributes || {}).map(([key, attribute]) => [
        key,
        normalizeAttributeForPayload(attribute)
      ]))
    }));
  const firstVariantDimensions = firstVariantPackageValues(variants);
  const payload = {
    ozon_category_id: templateEditor.ozon_category_id,
    category_name: templateEditor.category_name,
    updated_at: templateEditor.updated_at || "",
    shop_ids: draftForm.shop_ids,
    template_name: templateEditor.template_name,
    title: payloadTitle,
    description: templateEditor.description,
    attributes,
    images,
    editable_payload: {
      sku: templateEditor.source_ozon_sku,
      title: payloadTitle,
      description: templateEditor.description,
      category_id: templateEditor.ozon_category_id,
      description_category_id: templateEditor.description_category_id,
      type_id: templateEditor.type_id,
      legacy_category_id: templateEditor.legacy_category_id,
      category_name: templateEditor.category_name,
      price: {
        value: Number(templateEditor.price_value || 0),
        old_price: Number(templateEditor.old_price || 0),
        currency_code: templateEditor.currency_code || "CNY",
        vat: templateEditor.vat || "0",
        strategy_mode: "finalized",
        strategy_applied: true
      },
      dimensions: {
        length_cm: Number(firstVariantDimensions.length_cm || templateEditor.length_cm || 0),
        width_cm: Number(firstVariantDimensions.width_cm || templateEditor.width_cm || 0),
        height_cm: Number(firstVariantDimensions.height_cm || templateEditor.height_cm || 0),
        weight_g: Number(firstVariantDimensions.weight_g || templateEditor.weight_g || 0)
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
  const firstVariantDimensions = firstVariantPackageValues();
  draftForm.length_cm = Number(firstVariantDimensions.length_cm || templateEditor.length_cm || 0);
  draftForm.width_cm = Number(firstVariantDimensions.width_cm || templateEditor.width_cm || 0);
  draftForm.height_cm = Number(firstVariantDimensions.height_cm || templateEditor.height_cm || 0);
  draftForm.weight_g = Number(firstVariantDimensions.weight_g || templateEditor.weight_g || 0);
  draftForm.color = templateEditor.color || "";
  draftForm.spec = templateEditor.spec || "";
  draftForm.quantity = Number(templateEditor.quantity || 0);
  const variantImages = templateEditor.variants.flatMap((variant) => Array.isArray(variant.images) ? variant.images : []);
  const images = templateEditor.images.length ? templateEditor.images : variantImages;
  draftForm.source_images = dedupeImages(images).map((item) => ({ name: item.name || item.url, url: item.url }));
  draftImagesManuallyEdited.value = false;
  state.step = "edit";
}

function syncDraftImagesFromTemplateIfEmpty() {
  if (draftImagesManuallyEdited.value) return;
  if (draftForm.source_images.length) return;
  const variantImages = templateEditor.variants.flatMap((variant) => Array.isArray(variant.images) ? variant.images : []);
  const images = templateEditor.images.length ? templateEditor.images : variantImages;
  draftForm.source_images = dedupeImages(images).map((item) => ({ name: item.name || item.url, url: item.url }));
}

function syncDraftImagesFromTemplateForExistingDraft() {
  if (draftImagesManuallyEdited.value) return;
  if (!Number(draftForm.id || state.selectedDraftId || route.query.draftId || 0)) return;
  const variantImages = templateEditor.variants.flatMap((variant) => Array.isArray(variant.images) ? variant.images : []);
  const images = templateEditor.images.length ? templateEditor.images : variantImages;
  const sourceImages = dedupeImages(images);
  if (!sourceImages.length) return;
  draftForm.source_images = sourceImages.map((item) => ({ name: item.name || item.url, url: item.url }));
}

function currentEditorImagesForDraftSave() {
  const templateImages = Array.isArray(templateEditor.images) ? templateEditor.images : [];
  const draftImages = normalizeEditorImages(draftForm.source_images || []);
  const existingDraftId = Number(draftForm.id || state.selectedDraftId || route.query.draftId || 0);
  if (draftImagesManuallyEdited.value || (existingDraftId && draftImages.length)) return dedupeImages(draftImages);
  if (templateImages.some((item) => item?.url)) return dedupeImages(normalizeEditorImages(templateImages));
  return dedupeImages(draftImages);
}

function syncDraftImagesForSave() {
  const sourceImages = currentEditorImagesForDraftSave();
  draftForm.source_images = sourceImages.map((item) => ({ name: item.name || item.url, url: item.url })).filter((item) => item.url);
  return sourceImages;
}

function buildDraftTemplatePayloadForSave() {
  const payload = buildTemplatePayload();
  const draftImages = currentEditorImagesForDraftSave();
  if (!draftImages.length) return payload;
  payload.images = draftImages;
  payload.editable_payload = {
    ...(payload.editable_payload || {}),
    images: draftImages
  };
  return payload;
}

function firstVariantPackageValues(variants = templateEditor.variants) {
  const row = (Array.isArray(variants) ? variants : []).find((item) => (
    Number(item?.weight_g || 0)
    || Number(item?.length_mm || 0)
    || Number(item?.width_mm || 0)
    || Number(item?.height_mm || 0)
  )) || {};
  return {
    length_cm: Number(row.length_mm || 0) / 10,
    width_cm: Number(row.width_mm || 0) / 10,
    height_cm: Number(row.height_mm || 0) / 10,
    weight_g: Number(row.weight_g || 0)
  };
}

function stripBatchDraftMetadata(row = {}) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("_draft_")));
}

function buildBatchDraftUpdateItems() {
  const expectedIds = routeDraftIds.value;
  const rows = templateEditor.variants || [];
  const actualIds = rows.map((row) => Number(row._draft_id || 0));
  if (rows.length !== expectedIds.length || actualIds.some((id) => !expectedIds.includes(id))) {
    throw new Error("批量编辑行与原草稿已不一致，请刷新后重试");
  }
  const commonTemplate = buildTemplatePayload();
  return rows.map((row) => {
    const draftId = Number(row._draft_id);
    const variant = stripBatchDraftMetadata(commonTemplate.editable_payload.variants.find((item) => Number(item._draft_id) === draftId) || row);
    const images = dedupeImages(normalizeEditorImages(row.images || [])).map((item, index) => ({
      ...item,
      sort_order: index + 1
    }));
    variant.images = images;
    variant.images_manually_edited = true;
    variant.image_edit_intent = "manual";
    const templatePayload = {
      ...commonTemplate,
      id: Number(row._template_id || 0),
      title: variant.name || variant.title || commonTemplate.title,
      images,
      editable_payload: {
        ...(commonTemplate.editable_payload || {}),
        title: variant.name || variant.title || commonTemplate.editable_payload?.title || "",
        sku: variant.sku || variant.offer_id || "",
        images,
        variants: [variant]
      }
    };
    return {
      id: draftId,
      listing_draft_id: draftId,
      updated_at: row._draft_updated_at || "",
      template_id: Number(row._template_id || 0),
      product_name: variant.name || variant.title || "",
      internal_code: variant.offer_id || variant.sku || "",
      source_urls: row._draft_source_urls || [],
      source_images: images.map((item) => item.url),
      cost_price: Number(variant.cost_price || 0),
      sale_price: Number(variant.price || templateEditor.price_value || 0),
      length_cm: Number(variant.length_mm || 0) / 10,
      width_cm: Number(variant.width_mm || 0) / 10,
      height_cm: Number(variant.height_mm || 0) / 10,
      weight_g: Number(variant.weight_g || 0),
      color: normalizeColorForPayload(variant),
      spec: variant.spec || "",
      quantity: Number(variant.stock || 0),
      manual_facts: row._draft_manual_facts || {},
      ai_payload: row._draft_ai_payload || {},
      template_payload: templatePayload
    };
  });
}

async function saveBatchListingDrafts() {
  const items = buildBatchDraftUpdateItems();
  if (items.some((item) => !item.template_id || !item.product_name)) {
    throw new Error("每个草稿都必须保留模板、标题和 SKU 信息");
  }
  const result = await apiClient.post("/api/listing/drafts/batch-update", { items });
  const savedRows = Array.isArray(result?.items) ? result.items : [];
  const savedById = new Map(savedRows.map((draft) => [Number(draft.id), draft]));
  templateEditor.variants = templateEditor.variants.map((row, index) => {
    const saved = savedById.get(Number(row._draft_id));
    return {
      ...row,
      _draft_updated_at: saved?.updated_at || row._draft_updated_at,
      _draft_index: index
    };
  });
  state.drafts = savedRows.length ? savedRows : state.drafts;
  saveListingWorkbenchDraft();
  ElMessage.success(`已按草稿 ID 保存 ${items.length} 个草稿`);
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

function ensureDraftFormFromTemplate() {
  const firstVariant = templateEditor.variants.find((item) => item.name || item.title || item.sku) || {};
  const firstVariantDimensions = firstVariantPackageValues();
  draftForm.template_id = draftForm.template_id || templateEditor.id || "";
  draftForm.product_name = String(
    draftForm.product_name
    || templateEditor.title
    || templateEditor.template_name
    || firstVariant.title
    || firstVariant.name
    || firstVariant.sku
    || ""
  ).trim();
  draftForm.sale_price = Number(draftForm.sale_price || templateEditor.price_value || firstVariant.price || 0);
  draftForm.length_cm = Number(draftForm.length_cm || firstVariantDimensions.length_cm || templateEditor.length_cm || 0);
  draftForm.width_cm = Number(draftForm.width_cm || firstVariantDimensions.width_cm || templateEditor.width_cm || 0);
  draftForm.height_cm = Number(draftForm.height_cm || firstVariantDimensions.height_cm || templateEditor.height_cm || 0);
  draftForm.weight_g = Number(draftForm.weight_g || firstVariantDimensions.weight_g || templateEditor.weight_g || 0);
  draftForm.color = draftForm.color || templateEditor.color || normalizeColorForPayload(firstVariant);
  draftForm.spec = draftForm.spec || templateEditor.spec || firstVariant.spec || "";
  draftForm.quantity = Number(draftForm.quantity || templateEditor.quantity || firstVariant.stock || 0);
  if (!draftImagesManuallyEdited.value && !draftForm.source_images.length) {
    const variantImages = templateEditor.variants.flatMap((variant) => Array.isArray(variant.images) ? variant.images : []);
    const images = templateEditor.images.length ? templateEditor.images : variantImages;
    draftForm.source_images = dedupeImages(images).map((item) => ({ name: item.name || item.url, url: item.url }));
  }
}

async function uploadImageRequest(options) {
  uploadingImage.value = true;
  try {
    const result = await uploadListingMedia(options.file, { source_module: "listing_draft", role: "draft_source_image" });
    draftForm.source_images.push({
      name: result.name || options.file.name,
      url: result.publishUrl || result.url || result.previewUrl,
      previewUrl: result.previewUrl || result.url,
      assetId: result.assetId || ""
    });
    draftImagesManuallyEdited.value = true;
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
  const recordId = Number(route.query.recordId || 0);
  if (recordId) {
    creatingDraft.value = true;
    try {
      applyOzonAttributeMappings();
      const template = buildTemplatePayload();
      const updated = await apiClient.post(`/api/listing/publish-records/${recordId}/draft`, {
        template,
        updated_at: templateEditor.updated_at || ""
      });
      templateEditor.updated_at = updated.updated_at || templateEditor.updated_at || "";
      ElMessage.success("已保存到当前上架记录，未提交 Ozon");
    } catch (error) {
      ElMessage.error(error.message || "保存上架记录草稿失败");
    } finally {
      creatingDraft.value = false;
    }
    return;
  }
  if (isBatchDraftEdit.value) {
    creatingDraft.value = true;
    try {
      applyOzonAttributeMappings();
      await saveBatchListingDrafts();
    } catch (error) {
      ElMessage.error(error.message || "批量保存草稿失败");
    } finally {
      creatingDraft.value = false;
    }
    return;
  }
  ensureDraftFormFromTemplate();
  if (!draftForm.template_id) {
    try {
      await ensureListingTemplateForDraft();
      ensureDraftFormFromTemplate();
    } catch (error) {
      ElMessage.warning(error.message || "上架商品模板创建失败，请检查 Ozon 类目后重试");
      return;
    }
  }
  if (!draftForm.product_name) {
    ElMessage.warning("请先填写标题或 SKU 名称，再保存草稿");
    return;
  }
  creatingDraft.value = true;
  try {
    applyOzonAttributeMappings();
    draftForm.sale_price = Number(templateEditor.price_value || templateEditor.variants.find((item) => Number(item.price || 0) > 0)?.price || draftForm.sale_price || 0);
    const preservedDraftImages = normalizeEditorImages(draftForm.source_images || []);
    const hasPreservedDraftImages = preservedDraftImages.length > 0;
    await saveCurrentTemplateSnapshot();
    if (hasPreservedDraftImages) {
      draftForm.source_images = preservedDraftImages.map((item) => ({ name: item.name || item.url, url: item.url }));
      draftImagesManuallyEdited.value = true;
    }
    syncDraftImagesFromTemplateIfEmpty();
    syncDraftImagesFromTemplateForExistingDraft();
    syncDraftImagesForSave();
    const currentDraftId = Number(draftForm.id || state.selectedDraftId || route.query.draftId || 0);
    const templatePayload = buildDraftTemplatePayloadForSave();
    const draftPayload = {
      ...draftForm,
      id: currentDraftId || draftForm.id || "",
      listing_draft_id: currentDraftId || draftForm.id || "",
      source_images: draftForm.source_images.map((item) => item.url),
      template_payload: templatePayload
    };
    const created = currentDraftId
      ? await apiClient.put(`/api/listing/drafts/${currentDraftId}`, draftPayload)
      : await apiClient.post("/api/listing/drafts", draftPayload);
    state.drafts = [created, ...state.drafts.filter((item) => Number(item.id) !== Number(created.id))];
    state.selectedDraftId = created.id;
    draftForm.id = created.id;
    if (Number(route.query.draftId || 0) !== Number(created.id)) {
      await router.replace({
        query: {
          ...route.query,
          draftId: created.id,
          recordId: undefined,
          recordDraft: undefined
        }
      }).catch(() => {});
    }
    syncEditorImagesFromSavedDraft(created);
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
  } catch (error) {
    ElMessage.error(error.message || "保存草稿失败");
  } finally {
    creatingDraft.value = false;
  }
}

async function saveCurrentToDraft() {
  syncDraftImagesFromTemplateIfEmpty();
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
  draftImagesManuallyEdited.value = true;
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

function categoryHealthTagType(status) {
  if (status === "success") return "success";
  if (status === "error") return "danger";
  return "warning";
}

function categoryHealthAlertType(health = {}) {
  if (health.level === "green") return "success";
  if (health.level === "red") return "error";
  return "warning";
}

function categoryHealthTitle(health = {}) {
  if (health.level === "green") return "类目缓存诊断通过";
  if (health.level === "red") return "类目缓存存在阻断项";
  return "类目缓存需要复核";
}

function categoryHealthMissingText(health = {}) {
  const list = health.missing_required_attributes || [];
  if (!list.length) return "";
  return list.map((item) => item.name || item.attribute_id).filter(Boolean).join("，");
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

watch(
  () => [state.step, state.selectedCopyJobId, state.selectedDraftId],
  scheduleListingWorkbenchDraftSave
);

watch(
  () => templateEditor.variants.length,
  () => {
    if (variantTablePage.value > variantTablePageCount.value) variantTablePage.value = variantTablePageCount.value;
  }
);

watch(
  () => draftForm.shop_ids.slice(),
  () => ensureTextVariantBaseShop(),
  { deep: true }
);

onMounted(async () => {
  await ensureListingWorkbenchRouteId();
  try {
    await loadAll();
  } catch (error) {
    ElMessage.error(error.message || "加载草稿失败，请返回草稿箱重试");
  }
  listingWorkbenchReady = true;
  saveListingWorkbenchDraft();
});

onBeforeUnmount(() => {
  if (!listingDraftSaveTimer) return;
  window.clearTimeout(listingDraftSaveTimer);
  listingDraftSaveTimer = null;
  saveListingWorkbenchDraft();
});
</script>

<template>
  <div class="copy-page" @input.capture="trackListingWorkbenchEdit" @change.capture="trackListingWorkbenchEdit" @click.capture="trackListingWorkbenchEdit">
    <OzonRichContentEditor
      v-if="richEditorVisible"
      :model-value="richEditorModelValue"
      :visible="richEditorVisible"
      :title="templateEditor.title"
      @update:model-value="updateRichEditorModelValue"
      @update:visible="updateRichEditorVisible"
      @save="handleRichEditorSave"
    />

    <section class="copy-header">
      <div v-if="loading" class="route-loading-strip">正在载入草稿数据...</div>
      <div v-if="collectorSourceSku" class="collector-source-bar">
        <div>
          <span>采集箱来源</span>
          <strong :title="`SKU ${collectorSourceSku}`">SKU {{ collectorSourceSku }}</strong>
        </div>
        <el-button size="small" @click="backToCollectorBox">返回采集箱</el-button>
      </div>
      <div class="header-actions">
        <el-button type="success" :loading="aiGenerating" @click="runFieldAi({ name: 'all', type: 'attributeFill' })">AI 一键生成文案</el-button>
        <el-button :loading="creatingDraft" @click="createDraft">保存草稿</el-button>
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
              <el-button type="primary" :loading="publishingTemplate" @click="publishTemplate">准备发布</el-button>
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
                <el-form-item label="文案变体">
                  <div class="text-variant-panel">
                    <div class="text-variant-main">
                      <el-switch v-model="textVariantPolicy.enabled" :disabled="draftForm.shop_ids.length < 2" active-text="多店铺发布时启用" />
                      <span>{{ draftForm.shop_ids.length < 2 ? "选择两个以上店铺后可用" : "基准店铺不改，其他店铺轻量优化标题、标签和简介" }}</span>
                    </div>
                    <div v-if="textVariantPolicy.enabled" class="text-variant-controls">
                      <div class="text-variant-batch">
                        <span>批量策略</span>
                        <el-select :model-value="textVariantPolicy.style" placeholder="批量设置其他店铺" @update:model-value="setAllTextVariantStyles">
                          <el-option v-for="item in textVariantStyleOptions" :key="item.value" :label="item.label" :value="item.value" />
                        </el-select>
                      </div>
                      <el-checkbox-group v-model="textVariantPolicy.fields">
                        <el-checkbox label="title">标题</el-checkbox>
                        <el-checkbox label="tags">标签</el-checkbox>
                        <el-checkbox label="description">简介</el-checkbox>
                      </el-checkbox-group>
                      <div class="text-variant-shop-list">
                        <div v-for="shop in selectedTextVariantShops" :key="shop.id" class="text-variant-shop-row">
                          <span>{{ shop.name }}</span>
                          <el-radio
                            :model-value="textVariantPolicy.baseShopId"
                            :label="shop.id"
                            @update:model-value="textVariantPolicy.baseShopId = $event; syncTextVariantShopStyles()"
                          >
                            原版保留
                          </el-radio>
                          <el-select
                            v-if="String(shop.id) !== String(textVariantPolicy.baseShopId)"
                            v-model="textVariantPolicy.shopStyles[String(shop.id)]"
                            placeholder="选择策略"
                          >
                            <el-option v-for="item in textVariantStyleOptions" :key="item.value" :label="item.label" :value="item.value" />
                          </el-select>
                          <em v-else>不改当前页面文案</em>
                        </div>
                      </div>
                    </div>
                  </div>
                </el-form-item>
                <el-form-item label="产品类目" required>
                  <div class="category-selection-stack">
                    <el-alert
                      v-if="collectedCategoryHint"
                      type="warning"
                      :closable="false"
                      show-icon
                      :title="`采集参考类目：${collectedCategoryHint}。该类目尚未确认，请重新选择正式 Ozon 类目。`"
                    />
                    <OzonCategorySelect
                      v-model="templateEditor.ozon_category_id"
                      :shop-id="copyForm.shop_id"
                      :display-label="templateEditor.category_name"
                      placeholder="必须重新选择 Ozon 中文类目"
                      :show-sync="false"
                      @select="handleOzonCategorySelected"
                    />
                  </div>
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
              </div>
            </section>

            <section class="editor-block variants-block">
              <div class="section-line">
                <div>
                  <h3>Ozon 商品表格</h3>
                </div>
                <div class="section-actions variant-actions">
                  <el-button :disabled="categoryAttributesLocked" :loading="loadingTemplate" @click="syncFullCategorySchema">同步 Ozon 字段</el-button>
                  <el-button :disabled="categoryAttributesLocked || isBatchDraftEdit" type="primary" :icon="Plus" @click="addVariantRow">添加变体</el-button>
                  <el-button :disabled="!templateEditor.variants.length" @click="generateAllVariantOfferIds">一键生成货号</el-button>
                  <el-dropdown trigger="click">
                    <el-button>批量操作</el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item @click="applyFirstVariantField('images')">图片同首行</el-dropdown-item>
                        <el-dropdown-item @click="applyFirstVariantField('title')">标题同首行</el-dropdown-item>
                        <el-dropdown-item @click="applyFirstVariantField('price')">售价同首行</el-dropdown-item>
                        <el-dropdown-item @click="applyFirstVariantField('old_price')">划线价同首行</el-dropdown-item>
                        <el-dropdown-item @click="applyFirstVariantField('main_tags')">标签同首行</el-dropdown-item>
                        <el-dropdown-item divided :disabled="!selectedVariantRows.length || isBatchDraftEdit" @click="removeSelectedVariants">删除选中变体</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                  <el-button :loading="repairingListingMedia" @click="repairAllListingMedia">修复素材地址</el-button>
                </div>
              </div>
              <el-alert
                v-if="isBatchDraftEdit"
                type="info"
                :closable="false"
                show-icon
                :title="`正在批量编辑 ${routeDraftIds.length} 个同类目草稿`"
                description="每一行固定对应一个原草稿；保存时会按草稿 ID 分别覆盖，不会合并成一个草稿。"
              />
              <el-alert
                v-if="categoryAttributesLocked"
                class="category-attribute-lock-alert"
                type="warning"
                :closable="false"
                show-icon
                title="产品的 Ozon 类目未填写完整，商品属性暂不可编辑"
                description="缺少 description_category_id 或 type_id，或者当前仍是 frontend: 临时类目。请先在上方选择真实 Ozon 产品类目，系统同步类目属性后再填写。"
              />
              <el-table
                :data="variantPageRows"
                :class="{ 'category-attributes-locked': categoryAttributesLocked }"
                :inert="categoryAttributesLocked"
                border
                stripe
                class="variant-table dense-variant-table"
                row-key="id"
                :scrollbar-always-on="true"
                @selection-change="handleVariantSelectionChange"
              >
                <el-table-column type="selection" width="46" fixed="left" reserve-selection />
                <el-table-column type="index" :index="variantTableIndex" label="序号" width="64" fixed="left" align="center" />
                <el-table-column label="商品信息" fixed="left">
                <el-table-column width="210" fixed="left">
                  <template #header>
                    <div class="variant-col-header">
                      <span><em>*</em> 货号 / offer_id</span>
                      <el-button link size="small" @click="generateAllVariantOfferIds">一键生成</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <div class="offer-id-cell">
                      <el-input v-model="row.offer_id" size="small" :placeholder="row.source_offer_id ? `原货号：${row.source_offer_id}` : '新 offer_id'" />
                      <el-button size="small" @click="generateVariantOfferId(row)">生成</el-button>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column width="230" fixed="left">
                  <template #header>
                    <div class="variant-col-header">
                      <span>SKU 名称</span>
                      <el-button link size="small" @click="applyFirstVariantField('name')">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <div class="variant-name-cell">
                      <strong>{{ row.source_sku ? `[SKU:${row.source_sku}]` : row.sku || "新变体" }}</strong>
                      <el-input v-model="row.name" size="small" placeholder="变体名称" />
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
                  <template #default="{ row, $index }">
                    <div class="variant-title-cell">
                      <el-input v-model="row.title" size="small" />
                      <el-button v-if="$index > 0" size="small" @click="applyFirstVariantTitleToRow(row)">同首行</el-button>
                    </div>
                  </template>
                </el-table-column>
                </el-table-column>
                <el-table-column label="媒体">
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
                    </div>
                  </template>
                </el-table-column>
                <el-table-column width="170">
                  <template #header>
                    <div class="variant-col-header">
                      <span>视频封面</span>
                      <el-button link size="small" @click="applyFirstVariantVideoMedia('video_cover_urls')">同首行</el-button>
                      <el-button link size="small" :loading="generatingVariantCovers" @click="generateAllVariantMedia('video_cover_urls')">一键生成</el-button>
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
                    </div>
                  </template>
                </el-table-column>
                <el-table-column width="170">
                  <template #header>
                    <div class="variant-col-header">
                      <span>视频</span>
                      <el-button link size="small" @click="applyFirstVariantVideoMedia('video_urls')">同首行</el-button>
                      <el-button link size="small" :loading="generatingVariantVideos" @click="generateAllVariantMedia('video_urls')">一键生成</el-button>
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
                    </div>
                  </template>
                </el-table-column>
                <el-table-column v-if="mediaSummaryAttribute" width="260">
                  <template #header>
                    <div class="variant-col-header">
                      <span>简介</span>
                      <el-button link size="small" @click="applyFirstVariantAttribute(mediaSummaryAttribute)">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <el-input
                      :model-value="variantAttributeSelectModelValue(row, mediaSummaryAttribute)"
                      size="small"
                      type="textarea"
                      :rows="2"
                      @update:model-value="updateVariantAttributeSelectValue(row, mediaSummaryAttribute, $event)"
                    />
                  </template>
                </el-table-column>
                <el-table-column v-if="!variantFieldMode.tags" width="240">
                  <template #header>
                    <div class="variant-col-header">
                      <span>#产品标签</span>
                      <el-button link size="small" @click="applyFirstFlatSharedField">同首行</el-button>
                    </div>
                  </template>
                  <template #default>
                    <div class="variant-tags-cell media-tags-cell">
                      <el-select :model-value="fixedForm.tags" multiple filterable allow-create default-first-option collapse-tags collapse-tags-tooltip size="small" @paste="handleFixedTagsPaste" @update:model-value="updateFixedTags">
                        <el-option v-for="tag in fixedForm.tags" :key="tag" :label="tag" :value="tag" />
                      </el-select>
                      <span class="ozon-tag-count compact" :class="{ 'is-full': fixedForm.tags.length >= 20 }">{{ fixedForm.tags.length }}/20</span>
                      <el-button link type="danger" :disabled="!fixedForm.tags.length" @click="clearAllFixedTags">清空全部</el-button>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column v-if="variantFieldMode.tags" width="280">
                  <template #header>
                    <div class="variant-col-header">
                      <span>#产品标签</span>
                      <el-button link size="small" @click="applyFirstVariantField('main_tags')">同首行</el-button>
                      <el-button link size="small" :loading="aiGenerating" @click="runVariantColumnAi('main_tags')">AI</el-button>
                      <el-button link size="small" type="danger" @click="disableVariantField('tags')">-</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <div class="variant-tags-cell media-tags-cell">
                      <el-select :model-value="row.main_tags" multiple filterable allow-create default-first-option collapse-tags collapse-tags-tooltip size="small" @paste="handleVariantTagsPaste(row, $event)" @update:model-value="updateVariantTags(row, $event)">
                        <el-option v-for="tag in row.main_tags" :key="tag" :label="tag" :value="tag" />
                      </el-select>
                      <span class="ozon-tag-count compact" :class="{ 'is-full': row.main_tags?.length >= 20 }">{{ row.main_tags?.length || 0 }}/20</span>
                      <el-tooltip content="按 Ozon 规则整理标签">
                        <el-button link :icon="MagicStick" :disabled="!row.main_tags?.length" @click="normalizeVariantTagsForRow(row)" />
                      </el-tooltip>
                      <el-button link type="danger" :disabled="!row.main_tags?.length" @click="clearVariantTags(row)">清空</el-button>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column v-if="mediaRichContentAttribute" width="260">
                  <template #header>
                    <div class="variant-col-header">
                      <span>JSON富内容</span>
                      <el-button link size="small" @click="applyFirstVariantAttribute(mediaRichContentAttribute)">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <div class="rich-attribute-cell">
                      <el-button class="flat-attribute-value" link @click="openVariantRichContentEditor(row, mediaRichContentAttribute)">
                        {{ flatSkuAttributeDisplayText(row, mediaRichContentAttribute) }}
                      </el-button>
                      <div class="rich-attribute-actions">
                        <el-button link size="small" @click="generateVariantRichContentJson(row, mediaRichContentAttribute, 'first')">首图生成</el-button>
                        <el-button link size="small" @click="generateVariantRichContentJson(row, mediaRichContentAttribute, 'last')">尾图生成</el-button>
                      </div>
                    </div>
                  </template>
                </el-table-column>
                </el-table-column>
                <el-table-column v-if="hasFlatSkuVariantFeatureColumns" label="变体特征">
                <el-table-column v-if="variantColorAttribute || showLegacyVariantColorColumn" width="180">
                  <template #header>
                    <div class="variant-col-header">
                      <span>颜色</span>
                      <el-button link size="small" @click="applyFirstVariantField('color')">同首行</el-button>
                      <el-button link size="small" :loading="aiGenerating" @click="runVariantColumnAi('color')">AI</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <el-select
                      v-if="variantColorAttribute"
                      :model-value="variantAttributeSelectModelValue(row, variantColorAttribute)"
                      size="small"
                      multiple
                      filterable
                      clearable
                      default-first-option
                      collapse-tags
                      collapse-tags-tooltip
                      :loading="isAttributeOptionLoading(variantColorAttribute || {})"
                      @visible-change="ensureVariantDictionaryOptions(variantColorAttribute, $event)"
                      @update:model-value="updateVariantColorAttribute(row, variantColorAttribute, $event)"
                    >
                      <el-option v-for="option in variantColorOptions(row, variantColorAttribute)" :key="option.value" :label="option.label" :value="option.value" />
                    </el-select>
                    <el-select
                      v-else
                      v-model="row.color_values"
                      size="small"
                      multiple
                      filterable
                      clearable
                      default-first-option
                      collapse-tags
                      collapse-tags-tooltip
                      @change="syncVariantColor(row)"
                    >
                      <el-option v-for="option in variantColorOptions(row)" :key="option.value" :label="option.label" :value="option.value" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column v-for="field in visibleNonColorVariantAttributeFields" :key="`variant-attr-${attributeFieldKey(field)}`" width="220">
                  <template #header>
                    <div class="variant-col-header">
                      <span>{{ field.name || "属性" }}</span>
                      <el-button link size="small" @click="applyFirstVariantAttribute(field)">同首行</el-button>
                      <el-button link size="small" type="danger" @click="disableVariantAttribute(field)">-</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <el-select
                      v-if="field.type === 'select'"
                      :model-value="variantAttributeSelectModelValue(row, field)"
                      class="flat-attribute-control"
                      filterable
                      clearable
                      size="small"
                      :loading="isAttributeOptionLoading(field)"
                      @visible-change="ensureAttributeValuesLoaded(field, $event)"
                      @update:model-value="updateVariantAttributeSelectValue(row, field, $event)"
                    >
                      <el-option v-for="option in flatSkuAttributeOptions(row, field)" :key="option.id || option.value" :label="displayAttributeOptionLabel(option, field)" :value="attributeOptionModelValue(option)" />
                    </el-select>
                    <el-select
                      v-else-if="field.type === 'multiselect' || field.is_collection"
                      :model-value="variantAttributeSelectModelValue(row, field)"
                      class="flat-attribute-control"
                      multiple
                      filterable
                      default-first-option
                      collapse-tags
                      collapse-tags-tooltip
                      size="small"
                      :loading="isAttributeOptionLoading(field)"
                      @visible-change="ensureAttributeValuesLoaded(field, $event)"
                      @update:model-value="updateVariantAttributeSelectValue(row, field, $event)"
                    >
                      <el-option v-for="option in flatSkuAttributeOptions(row, field)" :key="option.id || option.value" :label="displayAttributeOptionLabel(option, field)" :value="attributeOptionModelValue(option)" />
                    </el-select>
                    <el-input-number v-else-if="field.type === 'number'" :model-value="Number(variantAttributeSelectModelValue(row, field) || 0)" class="flat-attribute-control" :controls="false" size="small" @update:model-value="updateVariantAttributeSelectValue(row, field, $event)" />
                    <el-switch v-else-if="field.type === 'boolean'" :model-value="Boolean(variantAttributeSelectModelValue(row, field))" @update:model-value="updateVariantAttributeSelectValue(row, field, $event)" />
                    <el-input v-else :model-value="variantAttributeSelectModelValue(row, field)" class="flat-attribute-control" size="small" @update:model-value="updateVariantAttributeSelectValue(row, field, $event)" />
                  </template>
                </el-table-column>
                <el-table-column v-if="showCollectedVariantOptionColumn" width="190">
                  <template #header>
                    <div class="variant-col-header">
                      <span>{{ collectedVariantOptionLabel }}</span>
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
                    >
                      <el-option v-for="option in collectedVariantOptionOptions" :key="option.value" :label="option.label" :value="option.value" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column v-if="showLegacyVariantSpecColumn" width="180">
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
                      :loading="isAttributeOptionLoading(variantSpecAttribute || {})"
                      @visible-change="ensureVariantDictionaryOptions(variantSpecAttribute, $event)"
                    >
                      <el-option v-for="option in variantSpecOptions(row)" :key="option.value" :label="option.label" :value="option.value" />
                    </el-select>
                  </template>
                </el-table-column>
                </el-table-column>
                <el-table-column label="价格">
                <el-table-column width="150">
                  <template #header>
                    <div class="variant-col-header">
                      <span>售价</span>
                      <el-button link size="small" @click="applyFirstVariantField('price')">同首行</el-button>
                      <el-button link size="small" @click="doubleVariantPriceField('price')">*2</el-button>
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
                      <el-button link size="small" @click="doubleVariantPriceField('old_price')">*2</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <div class="money-cell">
                      <el-input-number v-model="row.old_price" :min="0" :controls="false" size="small" />
                      <span>{{ editorCurrencyCode }}</span>
                    </div>
                  </template>
                </el-table-column>
                </el-table-column>
                <el-table-column width="140">
                  <template #header>
                    <div class="variant-col-header">
                      <span>品牌</span>
                      <el-button link size="small" @click="applyFirstFlatSharedField">同首行</el-button>
                    </div>
                  </template>
                  <template #default>
                    <el-select :model-value="fixedForm.brand" filterable allow-create default-first-option size="small" @update:model-value="updateFixedField('brand', $event)">
                      <el-option label="无品牌" value="无品牌" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column width="220">
                  <template #header>
                    <div class="variant-col-header">
                      <span>型号名称</span>
                      <el-button link size="small" @click="generateAllVariantModelNames">一键生成</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <div class="offer-id-cell">
                      <el-input :model-value="variantModelValue(row)" size="small" placeholder="复用来源或手动填写" @update:model-value="updateVariantModelValue(row, $event)" />
                      <el-button size="small" @click="generateVariantModelName(row)">生成</el-button>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column v-if="!variantFieldMode.weight" width="130">
                  <template #header>
                    <div class="variant-col-header">
                      <span>包装重量</span>
                      <el-button link size="small" @click="applyFirstFlatSharedField">同首行</el-button>
                    </div>
                  </template>
                  <template #default>
                    <div class="money-cell flat-unit-cell">
                      <el-input-number v-model="templateEditor.weight_g" :min="0" :controls="false" size="small" />
                      <span>g</span>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column v-if="!variantFieldMode.dimensions" width="230">
                  <template #header>
                    <div class="variant-col-header">
                      <span>包装尺寸</span>
                      <el-button link size="small" @click="applyFirstFlatSharedField">同首行</el-button>
                    </div>
                  </template>
                  <template #default>
                    <div class="flat-dimensions-cell">
                      <el-input-number v-model="templateEditor.length_cm" :min="0" :controls="false" size="small" />
                      <span>x</span>
                      <el-input-number v-model="templateEditor.width_cm" :min="0" :controls="false" size="small" />
                      <span>x</span>
                      <el-input-number v-model="templateEditor.height_cm" :min="0" :controls="false" size="small" />
                    </div>
                  </template>
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
                <el-table-column v-for="field in flatSkuMainAttributeFields" :key="`flat-main-attr-${attributeFieldKey(field)}`" :width="isRichContentAttributeField(field) ? 260 : 180">
                  <template #header>
                    <div class="variant-col-header">
                      <span>{{ flatSkuAttributeGroupLabel(field) }} · {{ field.name || "属性" }}</span>
                      <el-button link size="small" @click="applyFirstVariantAttribute(field)">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <div v-if="isRichContentAttributeField(field)" class="rich-attribute-cell">
                      <el-button class="flat-attribute-value" link @click="openVariantRichContentEditor(row, field)">
                        {{ flatSkuAttributeDisplayText(row, field) }}
                      </el-button>
                      <div class="rich-attribute-actions">
                        <el-button link size="small" @click="generateVariantRichContentJson(row, field, 'first')">首图生成</el-button>
                        <el-button link size="small" @click="generateVariantRichContentJson(row, field, 'last')">尾图生成</el-button>
                      </div>
                    </div>
                    <el-select
                      v-else-if="field.type === 'select'"
                      :model-value="variantAttributeSelectModelValue(row, field)"
                      class="flat-attribute-control"
                      filterable
                      clearable
                      size="small"
                      :loading="isAttributeOptionLoading(field)"
                      @visible-change="ensureAttributeValuesLoaded(field, $event)"
                      @update:model-value="updateVariantAttributeSelectValue(row, field, $event)"
                    >
                      <el-option v-for="option in flatSkuAttributeOptions(row, field)" :key="option.id || option.value" :label="displayAttributeOptionLabel(option, field)" :value="attributeOptionModelValue(option)" />
                    </el-select>
                    <el-select
                      v-else-if="field.type === 'multiselect' || field.is_collection"
                      :model-value="variantAttributeSelectModelValue(row, field)"
                      class="flat-attribute-control"
                      multiple
                      filterable
                      default-first-option
                      collapse-tags
                      collapse-tags-tooltip
                      size="small"
                      :loading="isAttributeOptionLoading(field)"
                      @visible-change="ensureAttributeValuesLoaded(field, $event)"
                      @update:model-value="updateVariantAttributeSelectValue(row, field, $event)"
                    >
                      <el-option v-for="option in flatSkuAttributeOptions(row, field)" :key="option.id || option.value" :label="displayAttributeOptionLabel(option, field)" :value="attributeOptionModelValue(option)" />
                    </el-select>
                    <el-input-number v-else-if="field.type === 'number'" :model-value="Number(variantAttributeSelectModelValue(row, field) || 0)" class="flat-attribute-control" :controls="false" size="small" @update:model-value="updateVariantAttributeSelectValue(row, field, $event)" />
                    <el-switch v-else-if="field.type === 'boolean'" :model-value="Boolean(variantAttributeSelectModelValue(row, field))" @update:model-value="updateVariantAttributeSelectValue(row, field, $event)" />
                    <el-input v-else :model-value="variantAttributeSelectModelValue(row, field)" class="flat-attribute-control" size="small" @update:model-value="updateVariantAttributeSelectValue(row, field, $event)" />
                  </template>
                </el-table-column>
                <el-table-column v-for="field in flatSkuProductAttributeFields" :key="`flat-product-attr-${attributeFieldKey(field)}`" :width="isRichContentAttributeField(field) ? 260 : 180">
                  <template #header>
                    <div class="variant-col-header">
                      <span>{{ flatSkuAttributeGroupLabel(field) }} · {{ field.name || "属性" }}</span>
                      <el-button link size="small" @click="applyFirstVariantAttribute(field)">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <div v-if="isRichContentAttributeField(field)" class="rich-attribute-cell">
                      <el-button class="flat-attribute-value" link @click="openVariantRichContentEditor(row, field)">
                        {{ flatSkuAttributeDisplayText(row, field) }}
                      </el-button>
                      <div class="rich-attribute-actions">
                        <el-button link size="small" @click="generateVariantRichContentJson(row, field, 'first')">首图生成</el-button>
                        <el-button link size="small" @click="generateVariantRichContentJson(row, field, 'last')">尾图生成</el-button>
                      </div>
                    </div>
                    <el-select
                      v-else-if="field.type === 'select'"
                      :model-value="variantAttributeSelectModelValue(row, field)"
                      class="flat-attribute-control"
                      filterable
                      clearable
                      size="small"
                      :loading="isAttributeOptionLoading(field)"
                      @visible-change="ensureAttributeValuesLoaded(field, $event)"
                      @update:model-value="updateVariantAttributeSelectValue(row, field, $event)"
                    >
                      <el-option v-for="option in flatSkuAttributeOptions(row, field)" :key="option.id || option.value" :label="displayAttributeOptionLabel(option, field)" :value="attributeOptionModelValue(option)" />
                    </el-select>
                    <el-select
                      v-else-if="field.type === 'multiselect' || field.is_collection"
                      :model-value="variantAttributeSelectModelValue(row, field)"
                      class="flat-attribute-control"
                      multiple
                      filterable
                      default-first-option
                      collapse-tags
                      collapse-tags-tooltip
                      size="small"
                      :loading="isAttributeOptionLoading(field)"
                      @visible-change="ensureAttributeValuesLoaded(field, $event)"
                      @update:model-value="updateVariantAttributeSelectValue(row, field, $event)"
                    >
                      <el-option v-for="option in flatSkuAttributeOptions(row, field)" :key="option.id || option.value" :label="displayAttributeOptionLabel(option, field)" :value="attributeOptionModelValue(option)" />
                    </el-select>
                    <el-input-number v-else-if="field.type === 'number'" :model-value="Number(variantAttributeSelectModelValue(row, field) || 0)" class="flat-attribute-control" :controls="false" size="small" @update:model-value="updateVariantAttributeSelectValue(row, field, $event)" />
                    <el-switch v-else-if="field.type === 'boolean'" :model-value="Boolean(variantAttributeSelectModelValue(row, field))" @update:model-value="updateVariantAttributeSelectValue(row, field, $event)" />
                    <el-input v-else :model-value="variantAttributeSelectModelValue(row, field)" class="flat-attribute-control" size="small" @update:model-value="updateVariantAttributeSelectValue(row, field, $event)" />
                  </template>
                </el-table-column>
                <el-table-column v-for="field in flatSkuOtherAttributeFields" :key="`flat-other-attr-${attributeFieldKey(field)}`" :width="isRichContentAttributeField(field) ? 260 : 180">
                  <template #header>
                    <div class="variant-col-header">
                      <span>{{ flatSkuAttributeGroupLabel(field) }} · {{ field.name || "属性" }}</span>
                      <el-button link size="small" @click="applyFirstVariantAttribute(field)">同首行</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <div v-if="isRichContentAttributeField(field)" class="rich-attribute-cell">
                      <el-button class="flat-attribute-value" link @click="openVariantRichContentEditor(row, field)">
                        {{ flatSkuAttributeDisplayText(row, field) }}
                      </el-button>
                      <div class="rich-attribute-actions">
                        <el-button link size="small" @click="generateVariantRichContentJson(row, field, 'first')">首图生成</el-button>
                        <el-button link size="small" @click="generateVariantRichContentJson(row, field, 'last')">尾图生成</el-button>
                      </div>
                    </div>
                    <el-select
                      v-else-if="field.type === 'select'"
                      :model-value="variantAttributeSelectModelValue(row, field)"
                      class="flat-attribute-control"
                      filterable
                      clearable
                      size="small"
                      :loading="isAttributeOptionLoading(field)"
                      @visible-change="ensureAttributeValuesLoaded(field, $event)"
                      @update:model-value="updateVariantAttributeSelectValue(row, field, $event)"
                    >
                      <el-option v-for="option in flatSkuAttributeOptions(row, field)" :key="option.id || option.value" :label="displayAttributeOptionLabel(option, field)" :value="attributeOptionModelValue(option)" />
                    </el-select>
                    <el-select
                      v-else-if="field.type === 'multiselect' || field.is_collection"
                      :model-value="variantAttributeSelectModelValue(row, field)"
                      class="flat-attribute-control"
                      multiple
                      filterable
                      default-first-option
                      collapse-tags
                      collapse-tags-tooltip
                      size="small"
                      :loading="isAttributeOptionLoading(field)"
                      @visible-change="ensureAttributeValuesLoaded(field, $event)"
                      @update:model-value="updateVariantAttributeSelectValue(row, field, $event)"
                    >
                      <el-option v-for="option in flatSkuAttributeOptions(row, field)" :key="option.id || option.value" :label="displayAttributeOptionLabel(option, field)" :value="attributeOptionModelValue(option)" />
                    </el-select>
                    <el-input-number v-else-if="field.type === 'number'" :model-value="Number(variantAttributeSelectModelValue(row, field) || 0)" class="flat-attribute-control" :controls="false" size="small" @update:model-value="updateVariantAttributeSelectValue(row, field, $event)" />
                    <el-switch v-else-if="field.type === 'boolean'" :model-value="Boolean(variantAttributeSelectModelValue(row, field))" @update:model-value="updateVariantAttributeSelectValue(row, field, $event)" />
                    <el-input v-else :model-value="variantAttributeSelectModelValue(row, field)" class="flat-attribute-control" size="small" @update:model-value="updateVariantAttributeSelectValue(row, field, $event)" />
                  </template>
                </el-table-column>
                <el-table-column v-if="false" width="150">
                  <template #header>
                    <div class="variant-col-header">
                      <span>售价</span>
                      <el-button link size="small" @click="applyFirstVariantField('price')">同首行</el-button>
                      <el-button link size="small" @click="doubleVariantPriceField('price')">*2</el-button>
                    </div>
                  </template>
                  <template #default="{ row }">
                    <div class="money-cell">
                      <el-input-number v-model="row.price" :min="0" :controls="false" size="small" />
                      <span>{{ editorCurrencyCode }}</span>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column v-if="false" width="150">
                  <template #header>
                    <div class="variant-col-header">
                      <span>划线价</span>
                      <el-button link size="small" @click="applyFirstVariantField('old_price')">同首行</el-button>
                      <el-button link size="small" @click="doubleVariantPriceField('old_price')">*2</el-button>
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
                      <el-button link :disabled="isBatchDraftEdit" @click="duplicateVariantRow(row)">复制</el-button>
                      <el-button link type="danger" :disabled="isBatchDraftEdit" @click="removeVariantRow(row)">删除</el-button>
                    </div>
                  </template>
                </el-table-column>
              </el-table>
              <div v-if="templateEditor.variants.length > VARIANT_TABLE_PAGE_SIZE" class="variant-table-pagination">
                <span>共 {{ templateEditor.variants.length }} 个变体</span>
                <el-pagination
                  v-model:current-page="variantTablePage"
                  :page-size="VARIANT_TABLE_PAGE_SIZE"
                  :total="templateEditor.variants.length"
                  background
                  layout="prev, pager, next"
                />
              </div>
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

    <el-drawer v-if="attributeDrawer.visible" v-model="attributeDrawer.visible" title="属性详情" size="460px">
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

    <el-dialog v-if="variantImageEditor.visible" v-model="variantImageEditor.visible" title="SKU图片编辑" width="min(1680px, 94vw)" top="3vh" class="variant-image-dialog" destroy-on-close>
      <div v-if="variantImageEditor.row" class="variant-image-workbench">
        <aside class="variant-image-panel">
          <div class="variant-image-tools">
            <el-upload multiple :show-file-list="false" accept="image/jpeg,image/png,image/webp" :http-request="uploadVariantImagesRequest(variantImageEditor.row)">
              <el-button type="primary" :loading="uploadingImage">上传图片</el-button>
            </el-upload>
            <el-button @click="useTemplateImagesForVariant">使用模板图片</el-button>
            <el-button @click="addVariantImageLink">新增链接</el-button>
            <el-button :loading="repairingListingMedia" @click="repairCurrentVariantMedia">修复地址</el-button>
          </div>
          <div class="variant-image-grid selected-grid">
            <div
              v-for="(image, imageIndex) in ensureVariantOwnImages(variantImageEditor.row)"
              :key="`${image.url}-${imageIndex}`"
              class="variant-image-card selected-card"
              :class="{
                dragging: variantImageEditor.draggingImageIndex === imageIndex,
                'drag-over': variantImageEditor.dragOverImageIndex === imageIndex && variantImageEditor.draggingImageIndex !== imageIndex
              }"
              draggable="true"
              @dragstart="startVariantImageDrag(imageIndex)"
              @dragover.prevent="variantImageEditor.dragOverImageIndex = imageIndex"
              @drop="reorderVariantImage(variantImageEditor.draggingImageIndex, imageIndex)"
              @dragend="finishVariantImageDrag"
            >
              <el-image
                v-if="image.url"
                class="variant-selected-image"
                :src="withImageToken(image.previewUrl || image.url)"
                :alt="image.name || 'SKU image'"
                :preview-src-list="variantSelectedPreviewList()"
                :initial-index="imageIndex"
                fit="cover"
                preview-teleported
                hide-on-click-modal
              />
              <div v-else class="variant-image-empty">图片链接</div>
              <el-input v-model="image.url" size="small" placeholder="https://..." @change="syncVariantImageLink(image)" />
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
                  <el-dropdown-item @click="addCurrentLibraryImagesToVariant">全选图库</el-dropdown-item>
                  <el-dropdown-item @click="clearVariantImages">清空选择</el-dropdown-item>
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

    <el-dialog v-if="variantVideoEditor.visible" v-model="variantVideoEditor.visible" :title="variantVideoEditor.title" width="760px" top="12vh" class="variant-video-dialog" destroy-on-close>
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
          <el-button :loading="repairingListingMedia" @click="repairCurrentVariantMedia">修复地址</el-button>
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

    <el-drawer v-if="collectedImport.visible" v-model="collectedImport.visible" title="导入 Ozon 前台采集数据" size="720px">
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

    <el-drawer v-if="showApiDebug" v-model="showApiDebug" title="Ozon 接口调试" size="720px">
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

    <el-drawer v-if="publishValidation.visible" v-model="publishValidation.visible" title="发布前校验" size="760px">
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
        <section v-if="publishCategoryHealth" class="category-health-section">
          <h3>类目诊断</h3>
          <el-alert
            :type="categoryHealthAlertType(publishCategoryHealth)"
            :title="categoryHealthTitle(publishCategoryHealth)"
            :closable="false"
            show-icon
          />
          <div class="category-health-checks">
            <el-tag
              v-for="check in publishCategoryHealth.checks || []"
              :key="check.key"
              :type="categoryHealthTagType(check.status)"
              effect="plain"
            >
              {{ check.label }}：{{ check.detail }}
            </el-tag>
          </div>
          <el-alert
            v-if="categoryHealthMissingText(publishCategoryHealth)"
            type="error"
            :closable="false"
            :title="`缺失 Ozon 必填属性：${categoryHealthMissingText(publishCategoryHealth)}`"
          />
          <el-table
            v-if="publishCategoryHealth.dictionary_attributes?.length"
            :data="publishCategoryHealth.dictionary_attributes"
            border
            size="small"
          >
            <el-table-column prop="name" label="字典属性" min-width="180" />
            <el-table-column prop="attribute_id" label="属性 ID" width="110" />
            <el-table-column prop="value_count" label="缓存值" width="90" />
            <el-table-column prop="synced_at" label="同步时间" min-width="160" />
          </el-table>
        </section>
        <section>
          <h3>Ozon Payload 预览</h3>
          <el-input :model-value="prettyJson(publishValidation.result.payload)" type="textarea" :rows="18" readonly />
        </section>
      </div>
    </el-drawer>

    <el-drawer v-if="publishSubmit.visible" v-model="publishSubmit.visible" title="Ozon 提交结果" size="760px">
      <div v-if="publishSubmit.result" class="publish-validation">
        <el-alert
          :type="publishSubmit.result.ok ? 'success' : 'warning'"
          :title="publishSubmit.result.ok ? '已提交到 Ozon' : '提交未完成'"
          :closable="false"
          show-icon
        />
        <section>
          <div class="publish-result-toolbar">
            <h3>店铺结果</h3>
            <div class="publish-result-summary">
              <el-tag type="success" effect="plain">成功 {{ publishSubmitSuccessCount }}</el-tag>
              <el-tag :type="publishSubmitFailedCount ? 'danger' : 'info'" effect="plain">失败 {{ publishSubmitFailedCount }}</el-tag>
              <el-switch
                v-model="publishSubmit.failedOnly"
                :disabled="!publishSubmitFailedCount"
                active-text="只看失败"
              />
            </div>
          </div>
          <el-table :data="publishSubmitVisibleResults" border>
            <el-table-column prop="shop_name" label="店铺" min-width="150" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.ok ? 'success' : 'danger'" effect="plain">{{ row.ok ? "成功" : "失败" }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="task_id" label="Task ID" min-width="130" />
            <el-table-column prop="error" label="错误" min-width="260" show-overflow-tooltip />
            <el-table-column prop="fix_tip" label="建议" min-width="240" show-overflow-tooltip />
            <el-table-column label="Ozon 明细" min-width="260" show-overflow-tooltip>
              <template #default="{ row }">
                <span>{{ row.import_error_summary?.items?.[0]?.raw_message || row.import_error_summary?.summary || "-" }}</span>
              </template>
            </el-table-column>
            <el-table-column label="处理" width="120" fixed="right">
              <template #default="{ row }">
                <el-button class="erp-btn-link" link type="primary" :icon="View" @click="openPublishSubmitRecord(row)">查看记录</el-button>
              </template>
            </el-table-column>
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
.category-selection-stack {
  display: grid;
  gap: 8px;
  width: 100%;
}

.copy-page { display: flex; flex-direction: column; gap: 0; height: 100%; min-height: 0; overflow-y: auto; overflow-x: hidden; background: #fff; }
.copy-header { position: sticky; top: 0; z-index: 20; display: flex; justify-content: flex-end; align-items: center; gap: 12px; padding: 10px 24px; margin: -16px -16px 0; background: rgba(255, 255, 255, 0.98); border-bottom: 1px solid #eef0f5; backdrop-filter: blur(8px); }
.route-loading-strip { position: absolute; left: 24px; bottom: -29px; height: 28px; display: inline-flex; align-items: center; padding: 0 12px; border: 1px solid #bfdbfe; border-radius: 6px; background: #eff6ff; color: #1d4ed8; font-size: 12px; font-weight: 700; box-shadow: 0 8px 18px rgba(37, 99, 235, 0.12); }
.copy-header h1, .section-heading h2 { margin: 0; }
.copy-header p, .section-heading p { margin: 6px 0 0; color: var(--el-text-color-secondary); }
.collector-source-bar { margin-right: auto; display: flex; align-items: center; gap: 12px; padding: 8px 12px; border: 1px solid var(--el-color-primary-light-7); border-radius: 8px; background: var(--el-color-primary-light-9); min-width: 240px; max-width: min(520px, 48vw); flex: 0 1 auto; }
.collector-source-bar div { min-width: 0; display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; }
.collector-source-bar span { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.2; }
.collector-source-bar strong { color: var(--el-text-color-primary); font-size: 13px; line-height: 1.25; overflow-wrap: anywhere; word-break: break-word; }
.collector-source-bar .el-button { flex: 0 0 auto; }
.copy-header .header-actions { width: auto; flex: 0 0 auto; }
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
.schema-missing-strip { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; color: var(--el-text-color-secondary); font-size: 12px; }
.missing-required-strip { max-width: 980px; margin: 0 auto 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px; border: 1px solid var(--el-color-danger-light-7); border-radius: 8px; background: var(--el-color-danger-light-9); }
.copy-form { display: flex; flex-direction: column; }
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
.field-with-tools { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto auto auto auto; align-items: center; gap: 8px; width: 100%; }
.field-with-tools.wide-tools { grid-template-columns: minmax(0, 1fr) auto auto auto; align-items: flex-start; }
.rich-json-actions { display: flex; flex-direction: column; gap: 8px; min-width: 108px; }
.rich-json-actions .el-button { width: 100%; margin-left: 0; justify-content: center; }
.rich-json-actions .el-button + .el-button { margin-left: 0; }
.private-field-toggle { min-width: 38px; height: 32px; padding-left: 8px; padding-right: 8px; border-color: #6c63ff; color: #5b54ef; }
.unit-input, .dimension-row { display: flex; align-items: center; gap: 8px; width: 100%; }
.shop-select-box { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px; width: 100%; }
.text-variant-panel { display: grid; gap: 8px; width: 100%; }
.text-variant-main { display: flex; align-items: center; gap: 12px; color: #64748b; font-size: 13px; }
.text-variant-controls { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; align-items: stretch; }
.text-variant-batch { display: grid; grid-template-columns: 72px minmax(180px, 260px); align-items: center; gap: 8px; color: #64748b; font-size: 13px; }
.text-variant-controls :deep(.el-checkbox-group) { display: flex; flex-wrap: wrap; gap: 8px 14px; }
.text-variant-shop-list { display: grid; gap: 6px; max-width: 580px; }
.text-variant-shop-row { display: grid; grid-template-columns: minmax(150px, 1fr) 92px minmax(160px, 220px); align-items: center; gap: 8px; min-height: 32px; }
.text-variant-shop-row > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.text-variant-shop-row em { color: #94a3b8; font-style: normal; font-size: 13px; }
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
.attribute-name-cell { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.attribute-name-cell strong { color: #111827; font-size: 13px; line-height: 1.3; overflow-wrap: anywhere; }
.attribute-name-cell span { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.2; }
.attribute-actions-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.attribute-table-actions { display: flex; align-items: center; justify-content: center; gap: 6px; flex-wrap: wrap; }
.load-more-attributes { display: flex; justify-content: center; margin: 8px 0 4px; }
.more-attributes-hint { padding: 10px 0 0 120px; color: var(--el-text-color-secondary); font-size: 13px; }
.variant-table { max-width: 100%; min-width: 2200px; border: 1px solid #e3e8f1; border-radius: 12px; overflow: hidden; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.05); }
.dense-variant-table { width: 100%; border-color: #e7e9f0; --el-table-row-hover-bg-color: #f5f8ff; --el-table-current-row-bg-color: #f1f5ff; }
.dense-variant-table :deep(.el-table__header th) { background: #fbfcfe; color: #1f2937; font-weight: 700; border-color: #e6eaf1; }
.dense-variant-table :deep(.el-table__header tr:first-child th) { background: #eef3fa; color: #53657d; font-size: 12px; letter-spacing: 0.04em; }
.dense-variant-table :deep(.el-table__cell) { vertical-align: middle; }
.dense-variant-table :deep(.el-table__body .el-table__cell) { padding-top: 8px; padding-bottom: 8px; border-color: #edf0f5; transition: background-color 0.15s ease; }
.dense-variant-table :deep(.el-table__body tr.el-table__row--striped td.el-table__cell) { background: #fcfdff; }
.dense-variant-table :deep(.el-table__body tr:hover > td.el-table__cell) { background: #f5f8ff !important; }
.dense-variant-table :deep(.el-table-fixed-column--left.is-last-column::before) { width: 8px; box-shadow: 5px 0 10px rgba(15, 23, 42, 0.08); }
.dense-variant-table :deep(.cell) { padding-left: 8px; padding-right: 8px; }
.dense-variant-table :deep(.el-input-number) { width: 100%; }
.dense-variant-table :deep(.el-select__wrapper),
.dense-variant-table :deep(.el-input__wrapper) { min-height: 32px; border-radius: 7px; background: #fff; }
.dense-variant-table :deep(.el-textarea__inner) { border-radius: 7px; line-height: 1.45; resize: none; }
.main-info-block { order: 1; max-width: 760px; margin-left: auto; margin-right: auto; }
.variants-block { order: 2; width: 100%; max-width: none; margin: 18px 0 0; overflow-x: auto; padding-top: 18px; }
.category-attribute-lock-alert { margin-bottom: 12px; }
.category-attributes-locked :deep(.el-table__body-wrapper) { pointer-events: none; opacity: 0.58; }
.variants-block > .section-line { position: relative; display: grid; grid-template-columns: 1fr auto 1fr; max-width: 100%; margin: 0 0 10px; align-items: center; }
.variants-block > .section-line > div:first-child { grid-column: 2; justify-self: center; }
.variants-block > .section-line h3 { text-align: center; margin: 0; }
.variants-block > .section-line .variant-actions { grid-column: 3; justify-self: end; padding: 5px; border: 1px solid #e5e9f0; border-radius: 9px; background: #f8fafc; }
.variants-block :deep(.el-table__empty-block) { min-height: 48px; }
.variant-table-pagination { display: flex; align-items: center; justify-content: flex-end; gap: 14px; min-width: 2200px; padding: 12px 14px; border: 1px solid #e3e8f1; border-top: 0; border-radius: 0 0 12px 12px; background: #fff; color: var(--el-text-color-secondary); font-size: 13px; }
.variant-col-header { min-height: 44px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; line-height: 1.2; text-align: center; font-weight: 700; }
.variant-col-header em { color: var(--el-color-danger); font-style: normal; margin-right: 2px; }
.variant-col-header .el-button { height: 18px; padding: 0; font-size: 12px; }
.flat-attribute-header { min-height: 44px; display: grid; place-items: center; text-align: center; line-height: 1.2; font-weight: 700; }
.flat-attribute-value { width: 100%; min-height: 30px; border: 0; border-radius: 6px; padding: 4px 8px; background: transparent; color: #1f2937; text-align: center; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.flat-attribute-value:hover { background: #f4f7fb; color: var(--el-color-primary); }
.flat-attribute-value.text-left { text-align: left; }
.flat-attribute-control { width: 100%; }
.rich-attribute-cell { display: flex; flex-direction: column; gap: 4px; align-items: stretch; }
.rich-attribute-actions { display: flex; justify-content: center; gap: 8px; }
.rich-attribute-actions .el-button + .el-button { margin-left: 0; }
.flat-unit-cell :deep(.el-input__wrapper) { padding-right: 24px; }
.flat-dimensions-cell { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 5px; }
.flat-dimensions-cell span { color: #8a94a6; font-size: 12px; font-weight: 700; }
.variant-name-cell { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.variant-name-cell > .el-input:nth-of-type(2) { display: none; }
.variant-name-cell strong { display: block; color: var(--el-text-color-primary); font-size: 12px; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.variant-title-cell { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px; }
.variant-title-cell .el-button { margin: 0; padding-left: 8px; padding-right: 8px; }
.variant-tags-cell { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; align-items: center; gap: 6px; }
.media-tags-cell { min-height: 58px; align-content: center; }
.variant-tags-cell .el-button { margin: 0; padding-left: 4px; padding-right: 4px; }
.ozon-tag-count { min-width: 40px; text-align: center; color: var(--el-text-color-secondary); font-size: 12px; font-weight: 700; }
.ozon-tag-count.compact { min-width: 34px; }
.ozon-tag-count.is-full { color: var(--el-color-warning); }
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
.variant-image-card { display: grid; grid-template-rows: 1fr 32px 26px; gap: 8px; align-content: start; min-height: 0; padding: 10px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; background: var(--el-fill-color-extra-light); overflow: hidden; }
.variant-image-card :deep(.erp-image-preview--square) { width: 100%; min-width: 100%; max-width: 100%; height: auto; min-height: 0; max-height: none; aspect-ratio: 1; flex-basis: auto; border-radius: 6px; }
.variant-selected-image { width: 100%; min-width: 0; aspect-ratio: 1; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; overflow: hidden; background: var(--el-fill-color-light); cursor: zoom-in; }
.variant-selected-image :deep(.el-image__inner) { width: 100%; height: 100%; object-fit: cover; display: block; }
.variant-image-empty { display: grid; place-items: center; width: 100%; aspect-ratio: 1; border: 1px dashed var(--el-border-color); border-radius: 6px; color: var(--el-text-color-secondary); background: var(--el-bg-color); }
.variant-image-card :deep(.el-input__wrapper) { min-height: 32px; }
.variant-image-card :deep(.el-input__inner) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.variant-image-dialog :deep(.el-dialog) { display: flex; flex-direction: column; max-width: calc(100vw - 80px); max-height: calc(100vh - 48px); overflow: hidden; }
.variant-image-dialog :deep(.el-dialog__body) { display: flex; flex: 1 1 auto; min-height: 0; padding: 0; overflow: hidden; }
.variant-image-dialog :deep(.el-dialog__footer) { flex: 0 0 auto; padding: 12px 20px; border-top: 1px solid var(--el-border-color-lighter); background: #fff; }
.variant-image-workbench { display: grid; grid-template-columns: minmax(640px, 2fr) minmax(360px, 1fr); width: 100%; height: min(680px, max(360px, calc(100vh - 190px))); max-height: 100%; min-height: 0; border-top: 1px solid var(--el-border-color-lighter); overflow: hidden; }
.variant-image-panel { min-height: 0; padding: 16px; overflow-y: auto; overscroll-behavior: contain; border-right: 1px solid var(--el-border-color-lighter); background: #fff; }
.variant-image-tools { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; margin: -16px -16px 12px; padding: 16px; flex-wrap: wrap; background: rgba(255, 255, 255, 0.96); border-bottom: 1px solid var(--el-border-color-lighter); backdrop-filter: blur(8px); }
.selected-grid { grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); align-items: start; }
.selected-card { position: relative; border-color: #ded8ff; background: #fbfaff; transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease, background 0.16s ease; }
.selected-card[draggable="true"] { cursor: grab; }
.selected-card.dragging { opacity: 0.62; cursor: grabbing; transform: scale(0.96); box-shadow: 0 10px 24px rgba(67, 56, 202, 0.18); }
.selected-card.drag-over { border-color: #6c5ce7; background: #f3f0ff; transform: translateY(-3px); box-shadow: 0 0 0 2px rgba(108, 92, 231, 0.16); }
.selected-card.drag-over::before { content: ""; position: absolute; inset: 8px auto 8px -4px; width: 4px; border-radius: 999px; background: #6c5ce7; }
.variant-card-footer { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; min-width: 0; }
.variant-card-footer .el-tag { max-width: 100%; min-width: 0; overflow: hidden; }
.variant-card-footer :deep(.el-tag__content) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.variant-image-library { min-height: 0; padding: 16px; overflow-y: auto; overscroll-behavior: contain; background: #fff; }
.library-tabs { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 14px; border-bottom: 1px solid var(--el-border-color-lighter); margin: -16px -16px 14px; padding: 12px 16px 0; background: rgba(255, 255, 255, 0.96); backdrop-filter: blur(8px); }
.library-tabs > .el-tabs { flex: 1 1 auto; min-width: 0; }
.library-tabs :deep(.el-tabs__header) { margin: 0; }
.library-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 10px; padding-bottom: 20px; }
.library-image-card { position: relative; display: grid; gap: 6px; padding: 0; border: 1px solid #dfe3ee; border-radius: 8px; background: #fff; overflow: hidden; cursor: pointer; text-align: left; color: var(--el-text-color-regular); }
.library-image-card img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; background: var(--el-fill-color-light); }
.library-image-card span { padding: 0 10px 10px; font-size: 12px; color: var(--el-text-color-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.library-image-card.selected { border-color: #6c5ce7; box-shadow: 0 0 0 2px rgba(108, 92, 231, 0.15); }
.library-image-card.selected::after { content: "✓"; position: absolute; right: 8px; bottom: 8px; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; color: #fff; background: #6c5ce7; font-weight: 800; }
@media (max-width: 1100px) {
  .variant-image-workbench { grid-template-columns: minmax(0, 3fr) minmax(300px, 2fr); }
  .selected-grid { grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); }
}
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
.publish-result-toolbar { flex-basis: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.publish-result-toolbar h3 { flex-basis: auto; }
.publish-result-summary { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.category-health-section { align-items: stretch; }
.category-health-section > * { flex-basis: 100%; }
.category-health-checks { display: flex; flex-wrap: wrap; gap: 8px; }
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
  .sku-toolbar, .template-search-row, .collected-import-grid, .category-meta-grid { grid-template-columns: 1fr; }
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
