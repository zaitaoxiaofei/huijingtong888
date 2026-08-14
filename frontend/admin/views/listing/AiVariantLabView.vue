<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Camera, Collection, DocumentChecked, Picture, Plus, Refresh } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import { generateAiVideo } from "../../api/tools/aiImageGenerator.js";
import { shanghaiDateTimeText } from "../../utils/shanghai-date";
import { uploadListingMedia } from "../../api/tools/imageCropper";
import AiProductImportDialog from "../../components/listing/AiProductImportDialog.vue";

const route = useRoute();
const currentStep = ref("material");
const planTableRef = ref(null);
const queueTableRef = ref(null);
const selectedPlanRows = ref([]);
const viewportHeight = ref(typeof window === "undefined" ? 900 : window.innerHeight);
let generationPollTimer = 0;
let generationPollPending = false;
let draftSaveBatchPollTimer = 0;
const rowPreparationTasks = new Map();
const rowVideoTasks = new Map();
const queuedRowPreparationTasks = new Map();
const preparedRowImageSignatures = new Map();
const restoredBatchAssetJobs = new Set();
const rowPreparationQueue = [];
const rowImageQueueing = reactive({});
const rowImageUploading = reactive({});
const BACKGROUND_DRAFT_PREPARATION_CONCURRENCY = 10;
const BROWSER_VIDEO_CONCURRENCY = 10;
const DRAFT_SAVE_REQUEST_TARGET_BYTES = 8 * 1024 * 1024;
const OFFER_ID_GENERATION_CONCURRENCY = 6;
const DRAFT_SAVE_SUBMIT_CONCURRENCY = 3;
let activeBackgroundDraftPreparations = 0;

const running = reactive({
  analyze: false,
  batchPlan: false,
  imageExecute: false,
  offerIds: false,
  saveTemplate: false,
  saveCaseRow: "",
  saveDrafts: false,
  saveDraftStage: "",
  rowImage: "",
  rowRichContent: "",
  rowVideo: ""
});

const importDialogRef = ref(null);
const routeImportLoading = ref(false);
const history = reactive({ visible: false, loading: false, restoring: "", jobs: [] });

const batchCopyEdit = reactive({
  visible: false,
  title: "",
  tags: "",
  description: ""
});

const promptReview = reactive({
  visible: false,
  loading: false,
  rowKeys: []
});

const quickCaseImport = reactive({
  active: false,
  caseNo: "",
  targetCount: 0
});
const draftSaveProgress = reactive({ batchNo: "", status: "", total: 0, success: 0, failed: 0 });
const UNKNOWN_FACT_RE = /(^|[\s,;:()[\]{}"'`|/\\-])(uncertain|unknown|not\s+sure|not\s+visible|unclear|n\/a|na|null|undefined|未识别|不确定|未知|无法判断|看不清|不清楚)(?=$|[\s,;:()[\]{}"'`|/\\-])/i;
const INTERNAL_COPY_LEAK_RE = /(исходн(?:ого|ому|ой|ую)|проверенн(?:ые|ых)\s+факт|только\s+целевая\s+модель|меняется\s+только|source\s+(?:product|item|card)|original\s+(?:product|item|card)|verified\s+facts|only\s+the\s+target\s+model|原商品|原始商品|原卡片|源商品|已验证事实|只改(?:变)?车型|仅改变车型)/i;

const material = reactive({
  sourceType: "",
  productName: "",
  sourceSku: "",
  sourceTitle: "",
  sourceTags: "",
  sourceDescription: "",
  templateId: "",
  mainImageUrl: "",
  mainImageDataUrl: "",
  imageName: "",
  detailImages: [],
  videoUrls: [],
  richContentJson: "",
  templatePayload: null,
  sourceDraftId: "",
  sourceShopIds: [],
  includeDetailImages: false,
  sourceVariantValue: "",
  targetInput: "",
  variantGoal: "vehicle_model_swap",
  useAiPlan: true,
  operatorNote: "",
  imageConcurrency: 20
});

const templateDraft = reactive({
  templateKey: "generic_vehicle_accessory_variant",
  templateName: "通用车型配件裂变案例",
  userNote: "车型、Logo、背景车裂变；产品主体、材质、数量、结构保持不变。"
});

const state = reactive({
  shops: [],
  analysis: null,
  analysisNo: "",
  batchJob: null,
  batchItems: [],
  planRows: [],
  batchDryRun: null,
  savedTemplateKey: ""
});

const vehicleCatalog = reactive({
  loading: false,
  tags: [],
  brands: [],
  activeTags: [],
  activeBrand: "",
  addVisible: false,
  addSaving: false,
  addForm: { brand: "", model: "", tags: [] }
});
const recognitionEditing = reactive({ fixed: false, variable: false, forbidden: false });
const manualTargetExpanded = ref(false);

const workflowSteps = [
  { key: "material", title: "导入素材", desc: "选择母 SKU 和主图" },
  { key: "recognize", title: "识别产品", desc: "确认固定事实和可变事实" },
  { key: "plan", title: "计划确认", desc: "确认车型任务和文案计划" },
  { key: "generate", title: "开始生成", desc: "按选中任务排队生成" }
];
const operatorRulePresets = [
  {
    key: "vehicle_full",
    label: "车型完整裂变",
    hint: "汽车品牌、车型型号、背景车辆和产品上的品牌/车型标识都可以随目标车型变化；产品主体、材质、数量、结构不变，商品标题、标签、描述重新生成。",
    note: "背景车辆、主图车型标题、产品上的车型或品牌标识允许随目标车型变化；商品标题、标签、描述重新生成；产品主体、材质、数量、结构不变。"
  },
  {
    key: "vehicle_same_brand",
    label: "同品牌车型裂变",
    hint: "锁定整个产品本体以及产品表面的 Logo、品牌标识、车型字样、印刷文字和图案；只允许修改产品外部的主图标题/型号文本；允许修改背景车辆车型。",
    note: "锁定整个产品本体，产品上的 Logo、品牌标识、车型字样、印刷文字和图案一律不变；只允许修改产品外部的主图标题/型号文本；允许修改背景车辆车型；商品标题、标签、描述重新生成。"
  },
  {
    key: "image_title_only",
    label: "只换主图车型标题",
    hint: "只修改图片里的车型标题/型号文字；产品主体、汽车品牌 Logo、背景和商品图片不变，但商品标题、标签、描述重新生成。",
    note: "主图只改车型标题，产品主体、产品品牌标识和背景不变；商品标题、标签、描述重新生成。"
  },
  {
    key: "brand_logo_only_vehicle_fission",
    label: "跨品牌文字替换",
    hint: "支持 HAVAL、CHERY 等混合目标车型；品牌和车型只使用清晰文本，不生成或仿制官方 Logo、车标、徽章或商标图形；目标型号不印到产品上。",
    note: "跨品牌车型裂变：产品主体、材质、数量、结构和产品上的型号文字不变；可编辑品牌区域只写目标品牌纯文本，禁止生成、复制或仿制官方 Logo、车标、徽章、符号或商标图形；目标型号不得印到产品上；主图标题和背景车辆改为目标完整车型；商品标题、标签、描述重新生成。"
  }
];

const sourceModel = computed(() => firstTarget(material.sourceVariantValue));
const targetModels = computed(() => {
  const source = sourceModel.value.toLowerCase();
  return parseTargets(material.targetInput).filter((item) => item.toLowerCase() !== source);
});
const hasSourceImage = computed(() => Boolean(material.mainImageDataUrl || material.mainImageUrl));
const canAnalyze = computed(() => hasSourceImage.value);
const canPlan = computed(() => Boolean((state.analysis || canAnalyze.value) && targetModels.value.length));
const textCost = computed(() => Number(state.batchJob?.estimated_text_cost_cny || 0));
const imageRequestUnitCost = 0.038;
const estimatedImageRequestCost = computed(() => Number((displayStats.value.total * imageRequestUnitCost).toFixed(3)));
const selectedCount = computed(() => selectedPlanRows.value.length || state.planRows.filter((row) => row.selected).length);
const displayStats = computed(() => {
  const items = state.planRows.length ? state.planRows : (state.batchItems || []);
  return {
    planned: items.filter((item) => item.status === "planned").length,
    queued: items.filter((item) => item.status === "queued_image").length,
    generating: items.filter((item) => item.status === "generating_image").length,
    providerPending: items.filter((item) => item.status === "provider_pending").length,
    done: items.filter((item) => item.status === "image_done").length,
    failed: items.filter((item) => item.status === "failed").length,
    total: items.length
  };
});
const generationActive = computed(() => String(state.batchJob?.status || "") === "generating_images" || displayStats.value.generating > 0 || displayStats.value.queued > 0 || displayStats.value.providerPending > 0);
const backendImageConcurrency = computed(() => Math.max(1, Number(
  state.batchJob?.queue?.effective_image_concurrency
  || state.batchJob?.result_json?.effective_image_concurrency
  || state.batchJob?.result_json?.image_concurrency
  || state.batchJob?.image_concurrency
  || material.imageConcurrency
  || 1
)));
const estimatedBatchSeconds = computed(() => Math.ceil(Math.max(0, selectedItemNosForRun().length || selectedCount.value || displayStats.value.queued || displayStats.value.planned || state.planRows.length || 0) / backendImageConcurrency.value) * 300);
const estimatedBatchText = computed(() => formatDurationText(estimatedBatchSeconds.value));
const queueTableHeight = computed(() => Math.min(780, Math.max(560, viewportHeight.value - 330)));
const recognitionBuckets = computed(() => buildRecognitionBuckets(state.analysis));
const operatorRulePreview = computed(() => buildOperatorRulePreview());
const activeOperatorRulePresetKey = computed(() => operatorRulePresets.find((preset) => preset.note === material.operatorNote)?.key || "");
function normalizeOperatorNote(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const plannedOperatorNote = computed(() => normalizeOperatorNote(state.planRows[0]?.raw?.image_edit_contract?.operator_instructions?.source));
const operatorRulesNeedReplan = computed(() => Boolean(
  state.planRows.length
  && normalizeOperatorNote(material.operatorNote) !== plannedOperatorNote.value
));
const selectedShopNames = computed(() => normalizeShopIds(material.sourceShopIds || [])
  .map((shopId) => state.shops.find((shop) => String(shop.id) === String(shopId))?.name || "")
  .filter(Boolean));
const filteredVehicleBrands = computed(() => vehicleCatalog.brands.map((brand) => {
  const models = (brand.models || []).filter((model) => !vehicleCatalog.activeTags.length || vehicleCatalog.activeTags.every((tag) => model.tags?.includes(tag)));
  return { ...brand, models };
}).filter((brand) => brand.models.length));
const activeVehicleBrand = computed(() => filteredVehicleBrands.value.find((brand) => brand.name === vehicleCatalog.activeBrand) || filteredVehicleBrands.value[0] || null);

const DESCRIPTION_MIN_LENGTH = 350;
const DESCRIPTION_MAX_LENGTH = 500;

onMounted(() => {
  updateViewportHeight();
  window.addEventListener("resize", updateViewportHeight);
  void loadShops();
  void loadVehicleCatalog();
  void autoImportRouteCase();
  void autoImportRouteMaterial();
});

async function loadVehicleCatalog() {
  vehicleCatalog.loading = true;
  try {
    const result = await apiClient.get("/api/ai-variant-lab/vehicle-catalog", { noCache: true });
    vehicleCatalog.tags = result.tags || [];
    vehicleCatalog.brands = result.brands || [];
    if (!filteredVehicleBrands.value.some((brand) => brand.name === vehicleCatalog.activeBrand)) vehicleCatalog.activeBrand = filteredVehicleBrands.value[0]?.name || "";
  } catch (error) {
    ElMessage.error(error.message || "车型库加载失败");
  } finally {
    vehicleCatalog.loading = false;
  }
}

function toggleVehicleTag(tagKey) {
  const index = vehicleCatalog.activeTags.indexOf(tagKey);
  if (index >= 0) vehicleCatalog.activeTags.splice(index, 1);
  else vehicleCatalog.activeTags.push(tagKey);
  if (!filteredVehicleBrands.value.some((brand) => brand.name === vehicleCatalog.activeBrand)) vehicleCatalog.activeBrand = filteredVehicleBrands.value[0]?.name || "";
}

function targetIsSelected(fullName) {
  return targetModels.value.some((target) => target.toLowerCase() === String(fullName || "").toLowerCase());
}

function isSourceVehicleModel(fullName) {
  const source = String(sourceModel.value || "").trim().toLowerCase();
  const value = String(fullName || "").trim().toLowerCase();
  return Boolean(source && value === source);
}

function setTargetModels(values = []) {
  material.targetInput = uniqueList(values.map((value) => String(value || "").trim()).filter(Boolean)).join("\n");
}

function toggleVehicleModel(model) {
  if (isSourceVehicleModel(model.fullName)) return;
  const current = targetModels.value;
  setTargetModels(targetIsSelected(model.fullName) ? current.filter((item) => item.toLowerCase() !== model.fullName.toLowerCase()) : [...current, model.fullName]);
}

function addActiveBrandModels() {
  if (!activeVehicleBrand.value) return;
  setTargetModels([...targetModels.value, ...activeVehicleBrand.value.models.map((model) => model.fullName)]);
}

function removeTargetModel(target) {
  setTargetModels(targetModels.value.filter((item) => item.toLowerCase() !== String(target || "").toLowerCase()));
}

function recognitionSummary(key) {
  const values = recognitionBuckets.value[key] || [];
  return values.slice(0, 8);
}

function openAddVehicleCatalog() {
  vehicleCatalog.addForm = { brand: vehicleCatalog.activeBrand || "", model: "", tags: [...vehicleCatalog.activeTags] };
  vehicleCatalog.addVisible = true;
}

async function saveVehicleCatalogEntry() {
  if (!String(vehicleCatalog.addForm.brand || "").trim()) {
    ElMessage.warning("请填写汽车品牌");
    return;
  }
  vehicleCatalog.addSaving = true;
  try {
    await apiClient.post("/api/ai-variant-lab/vehicle-catalog", vehicleCatalog.addForm);
    vehicleCatalog.addVisible = false;
    await loadVehicleCatalog();
    ElMessage.success("车型库数据已添加");
  } catch (error) {
    ElMessage.error(error.message || "添加车型失败");
  } finally {
    vehicleCatalog.addSaving = false;
  }
}

function updateViewportHeight() {
  viewportHeight.value = window.innerHeight || viewportHeight.value;
}

async function autoImportRouteMaterial() {
  if (String(route.query.autoImport || "") !== "1") return;
  const routeSource = routeImportSource();
  const routeId = routeImportId(routeSource);
  if (!routeSource || !routeId) return;
  routeImportLoading.value = true;
  try {
    const detail = await apiClient.get(routeImportDetailUrl(routeSource, routeId), { noCache: true });
    applyImportedMaterial(normalizeImportCandidate(detail || {}, routeSource, 0));
    ElMessage.success(`已从${sourceLabel(routeSource)}导入裂变素材`);
  } catch (error) {
    ElMessage.error(error.message || "导入裂变素材失败");
  } finally {
    routeImportLoading.value = false;
  }
}

async function autoImportRouteCase() {
  if (String(route.query.source || "") !== "case") return;
  const caseNo = String(route.query.caseNo || route.query.case_no || "").trim();
  const targets = parseTargets(route.query.caseTargets || route.query.targets || route.query.targetModels);
  if (!caseNo || !targets.length) return;
  currentStep.value = "generate";
  quickCaseImport.active = true;
  quickCaseImport.caseNo = caseNo;
  quickCaseImport.targetCount = targets.length;
  running.batchPlan = true;
  try {
    const result = await apiClient.get(`/api/ai-variant-lab/cases/${encodeURIComponent(caseNo)}`, { noCache: true });
    await importCaseForQuickVariant(result.case, targets, {
      offerPrefix: String(route.query.offerPrefix || "").trim()
    });
    ElMessage.success(`已从案例生成 ${targets.length} 个裂变队列，可直接检查并开始生成。`);
  } catch (error) {
    ElMessage.error(error.message || "从案例进入 AI 裂变失败");
  } finally {
    running.batchPlan = false;
    quickCaseImport.active = false;
  }
}

function routeImportSource() {
  const source = String(route.query.source || "");
  if (source === "listing_draft") return "draft";
  if (source === "collector_box") return "collector";
  if (source === "online_product") return "online";
  if (source === "listing_record") return "record";
  return "";
}

function routeImportId(source) {
  if (source === "draft") return firstRouteId(route.query.draftId || route.query.draftIds);
  if (source === "collector") return firstRouteId(route.query.collectorSku || route.query.sourceId);
  if (source === "online") return firstRouteId(route.query.onlineProductId || route.query.sourceId);
  if (source === "record") return firstRouteId(route.query.listingRecordId || route.query.recordId || route.query.sourceId);
  return "";
}

function routeImportDetailUrl(source, id) {
  const encoded = encodeURIComponent(id);
  if (source === "draft") return `/api/listing/drafts/${encoded}`;
  if (source === "collector") return `/api/listing/collector-box/${encoded}`;
  if (source === "online") return `/api/online-products/${encoded}/edit-draft`;
  if (source === "record") return `/api/listing/publish-records/${encoded}`;
  return "";
}

function firstRouteId(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || "").split(",").map((item) => item.trim()).find(Boolean) || "";
}

async function loadShops() {
  try {
    const shops = await apiClient.get("/api/shops", { noCache: true });
    state.shops = Array.isArray(shops) ? shops.filter((shop) => shop.status !== "deleted") : [];
  } catch {
    state.shops = [];
  }
}

function stepIndex(key) {
  return workflowSteps.findIndex((step) => step.key === key);
}

function goStep(key) {
  currentStep.value = key;
}

function parseTargets(value) {
  const seen = new Set();
  return String(value || "")
    .split(/[,\n;，；、/|]+/)
    .map((item) => item.trim())
    .filter((item) => {
      if (!item || seen.has(item.toLowerCase())) return false;
      seen.add(item.toLowerCase());
      return true;
    });
}

function firstTarget(value) {
  return parseTargets(value)[0] || String(value || "").trim();
}

function hasVehicleModel(value) {
  return /\b[A-ZА-ЯЁ]+\s*[A-Z]?\d{1,2}[A-Z]?\b/i.test(String(value || ""));
}

function openImportDialog(source) {
  importDialogRef.value?.open(source, { defaultDraftScope: source === "draft" ? "mine" : "all" });
}

function handleDialogImport(row) {
  applyImportedMaterial(row);
  ElMessage.success("已导入母素材");
}

function applyImportedMaterial(row) {
  material.sourceType = row.source;
  material.productName = row.title || row.sourceSku || "母商品";
  material.sourceSku = row.sourceSku || row.sourceId || "";
  material.sourceTitle = row.title || "";
  material.sourceTags = Array.isArray(row.tags) ? row.tags.join(" ") : String(row.tags || "");
  material.sourceDescription = row.description || "";
  material.templateId = row.templateId || "";
  material.mainImageUrl = row.imageUrl || "";
  material.mainImageDataUrl = "";
  material.imageName = row.imageUrl ? "imported image" : "";
  material.detailImages = normalizeImageList(row.detailImages || []).filter((url) => url && url !== material.mainImageUrl);
  material.videoUrls = normalizeStringList(row.videoUrls || []);
  material.richContentJson = row.richContentJson || "";
  material.templatePayload = row.templatePayload || null;
  material.sourceDraftId = row.source === "draft" ? String(row.sourceDraftId || row.sourceId || "").trim() : "";
  material.sourceShopIds = normalizeShopIds(row.sourceShopIds || []);
  if (row.sourceVariantValue) material.sourceVariantValue = row.sourceVariantValue;
  resetPlanState();
}

function normalizeImportRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function normalizeImportCandidate(row = {}, source = "collector", index = 0) {
  const payload = parseMaybeJson(row.template_payload_json) || parseMaybeJson(row.template_payload) || parseMaybeJson(row.templatePayload) || parseMaybeJson(row.template_snapshot) || parseMaybeJson(row.templateSnapshot) || parseMaybeJson(row.listing_template) || parseMaybeJson(row.listingTemplate) || parseMaybeJson(row.editable_payload) || parseMaybeJson(row.editablePayload) || parseMaybeJson(row.payload) || {};
  const editablePayload = payload.editable_payload || payload.editablePayload || parseMaybeJson(row.editable_payload_json) || parseMaybeJson(row.editable_payload) || parseMaybeJson(row.editablePayload) || {};
  const normalized = row.normalized || payload.normalized || {};
  const productDetail = row.productDetail || row.product_detail || normalized.productDetail || normalized.product_detail || {};
  const normalizedPayload = normalized.payload || {};
  const normalizedEditable = normalized.editPayload || normalized.edit_payload || normalized.editable_payload || {};
  const manualFacts = parseMaybeJson(row.manual_facts_json) || parseMaybeJson(row.manual_facts) || row.manualFacts || {};
  const firstVariant = Array.isArray(editablePayload.variants) ? editablePayload.variants[0] : (Array.isArray(payload.variants) ? payload.variants[0] : null);
  const draftCurrentImageList = source === "draft" ? firstNonEmptyImageList([
    row.effective_images,
    row.effectiveImages,
    row.draft_variant_images_json,
    firstVariant?.images,
    row.draft_template_images_json,
    editablePayload.images,
    row.draft_variant_primary_image,
    row.list_image_url,
    row.listImageUrl,
    row.draft_template_primary_image
  ]) : [];
  const sourceImageList = firstNonEmptyImageList([
    row.source_images,
    row.source_images_json,
    row.images,
    row.image_urls,
    row.image_url,
    row.main_image_url,
    row.primary_image,
    row.productImage,
    row.mainImage
  ]);
  const templateImageList = firstNonEmptyImageList([
    editablePayload.images,
    payload.images,
    payload.image_urls,
    productDetail.images,
    normalized.images,
    normalizedPayload.images,
    firstVariant?.images,
    payload.productImage,
    payload.mainImage,
    payload.image_url
  ]);
  const templateOnlyImages = templateImageList.filter((url) => !sourceImageList.includes(url));
  const fallbackImageList = templateOnlyImages.length ? templateOnlyImages : (templateImageList.length ? templateImageList : sourceImageList);
  const imageList = draftCurrentImageList.length ? draftCurrentImageList : fallbackImageList;
  const explicitDetailImages = firstNonEmptyImageList([
    row.detail_image_urls,
    row.detailImageUrls,
    row.detail_images,
    row.detailImages,
    payload.detail_image_urls,
    payload.detailImageUrls,
    payload.detail_images,
    payload.detailImages,
    editablePayload.detail_image_urls,
    editablePayload.detailImageUrls,
    editablePayload.detail_images,
    editablePayload.detailImages,
    normalized.detail_image_urls,
    normalized.detailImageUrls,
    normalized.detail_images,
    normalized.detailImages,
    normalizedPayload.detail_image_urls,
    normalizedPayload.detailImageUrls,
    normalizedPayload.detail_images,
    normalizedPayload.detailImages,
    normalizedEditable.detail_image_urls,
    normalizedEditable.detailImageUrls,
    normalizedEditable.detail_images,
    normalizedEditable.detailImages,
    productDetail.detail_image_urls,
    productDetail.detailImageUrls,
    productDetail.detail_images,
    productDetail.detailImages,
    firstVariant?.detail_image_urls,
    firstVariant?.detailImageUrls,
    firstVariant?.detail_images,
    firstVariant?.detailImages
  ]);
  const title = firstValue(editablePayload.title, firstVariant?.title, firstVariant?.name, manualFacts.title, payload.title, payload.name, row.title, row.name, row.product_name, row.subject, payload.product_name);
  const description = firstValue(row.description, row.description_text, row.selling_points, payload.description, payload.selling_points);
  const tags = normalizeTags(firstValue(row.tags, row.keywords, payload.tags, payload.keywords));
  const sourceSku = String(firstValue(row.sku, row.offer_id, row.product_id, row.id, payload.sku, payload.offer_id) || "").trim();
  const sourceRaw = payload.source_raw || payload.sourceRaw || editablePayload.source_raw || editablePayload.sourceRaw || {};
  const sourceShopIds = normalizeShopIds([
    row.shop_ids,
    row.shopIds,
    row.shop_id,
    row.shopId,
    row.source_shop_id,
    row.sourceShopId,
    payload.shop_ids,
    payload.shopIds,
    payload.shop_id,
    payload.shopId,
    payload.source_shop_id,
    payload.sourceShopId,
    editablePayload.shop_ids,
    editablePayload.shopIds,
    editablePayload.shop_id,
    editablePayload.shopId,
    editablePayload.source_shop_id,
    editablePayload.sourceShopId,
    sourceRaw.shop_ids,
    sourceRaw.shopIds,
    sourceRaw.shop_id,
    sourceRaw.shopId,
    sourceRaw.source_shop_id,
    sourceRaw.sourceShopId
  ]);
  const templateId = String(firstValue(
    row.template_id,
    row.templateId,
    row.listing_template_id,
    row.listingTemplateId,
    payload.template_id,
    payload.templateId,
    sourceRaw.source_template_id,
    sourceRaw.sourceTemplateId,
    sourceRaw.ai_variant_draft?.source_template_id,
    sourceRaw.ai_variant_draft?.sourceTemplateId
  ) || "").trim();
  const richContentJson = String(firstValue(
    row.rich_content_json,
    row.richContentJson,
    payload.rich_content_json,
    payload.richContentJson,
    editablePayload.rich_content_json,
    editablePayload.richContentJson,
    firstVariant?.rich_content_json,
    firstVariant?.richContentJson
  ) || "").trim();
  const videoUrls = uniqueList(normalizeStringList(firstValue(
    row.video_urls,
    row.videoUrls,
    row.videos,
    row.originalVideos,
    payload.video_urls,
    payload.videoUrls,
    payload.videos,
    payload.originalVideos,
    editablePayload.video_urls,
    editablePayload.videoUrls,
    editablePayload.videos,
    firstVariant?.video_urls,
    firstVariant?.videoUrls,
    firstVariant?.videos
  )));
  return {
    id: `${source}-${sourceSku || index}`,
    index,
    source,
    sourceId: source === "draft" ? String(row.id || "").trim() : sourceSku || row.id || "",
    sourceDraftId: source === "draft" ? String(row.id || sourceSku || "").trim() : "",
    sourceShopIds,
    sourceSku,
    title: title || `商品 ${index + 1}`,
    description,
    tags,
    templateId,
    imageUrl: imageList[0] || "",
    detailImages: uniqueList(imageList.length > 1 ? imageList.slice(1) : explicitDetailImages).filter((url) => url && url !== imageList[0]),
    videoUrls,
    richContentJson,
    templatePayload: payload,
    status: String(firstValue(row.status, payload.status, editablePayload.status) || "").trim(),
    sourceVariantValue: inferVehicleModel([title, tags.join(" "), description].join(" ")),
    raw: row
  };
}

function isImportCandidateVisible(row) {
  if (!row) return false;
  const status = String(row.status || row.raw?.status || "").trim().toLowerCase();
  if (["deleted", "removed", "archived"].includes(status)) return false;
  return Boolean(row.title || row.imageUrl);
}

function firstValue(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
    if (value && typeof value === "object") return value;
    if (String(value ?? "").trim()) return value;
  }
  return "";
}

function firstNonEmptyImageList(values = []) {
  for (const value of values) {
    const images = uniqueList(normalizeImageList(value));
    if (images.length) return images;
  }
  return [];
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function normalizeImageList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => normalizeImageList(item)).filter(Boolean);
  if (value && typeof value === "object") return normalizeImageList(value.url || value.image_url || value.imageUrl || value.src || value.previewUrl || value.publishUrl || "");
  const text = String(value || "").trim();
  if (!text) return [];
  const parsed = parseMaybeJson(text);
  if (parsed) return normalizeImageList(parsed);
  return text.split(/\s*\|\|\s*|\r?\n|,\s*/).map((item) => item.trim()).filter(Boolean);
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => {
    if (item && typeof item === "object") return String(item.url || item.src || item.video_url || item.videoUrl || "").trim();
    return String(item || "").trim();
  }).filter(Boolean);
  const text = String(value || "").trim();
  if (!text) return [];
  const parsed = parseMaybeJson(text);
  if (parsed) return normalizeStringList(parsed);
  return text.split(/\s*\|\|\s*|\r?\n|,\s*/).map((item) => item.trim()).filter(Boolean);
}

function normalizeShopIds(value) {
  const raw = Array.isArray(value) ? value.flatMap((item) => normalizeShopIds(item)) : [value];
  const seen = new Set();
  return raw
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .filter((item) => {
      const key = String(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function uniqueList(list = []) {
  const seen = new Set();
  return list.filter((item) => {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 12);
  const text = String(value || "").trim();
  if (!text) return [];
  const parsed = parseMaybeJson(text);
  if (parsed) return normalizeTags(parsed);
  return text.split(/[\s,，、]+/).map((item) => item.trim()).filter(Boolean).slice(0, 12);
}

function inferVehicleModel(text = "") {
  const match = String(text || "").match(/\b(TENET|BELGEE|HAVAL|CHERY|JAECOO|GEELY|OMODA|EXEED|CHANGAN|TOYOTA|HONDA|BMW|MERCEDES|LADA|KIA|HYUNDAI)\s*([A-Z]?\d{1,2}[A-Z]?|TIGGO\s*\d|JOLION|DARGO|X\d{2}|J\d)\b/i);
  return match ? `${match[1].toUpperCase()} ${String(match[2]).replace(/\s+/g, " ").toUpperCase()}` : "";
}

function sourceLabel(source) {
  if (source === "collector") return "采集箱";
  if (source === "draft") return "草稿箱";
  if (source === "online") return "在线商品";
  if (source === "record") return "上架记录";
  return "素材";
}

function resetPlanState() {
  state.analysis = null;
  state.analysisNo = "";
  state.batchJob = null;
  state.batchItems = [];
  state.planRows = [];
  state.batchDryRun = null;
  selectedPlanRows.value = [];
}

function sourceImagePayload() {
  if (material.mainImageDataUrl) return { imageDataUrl: material.mainImageDataUrl };
  if (material.mainImageUrl) return { imageUrl: material.mainImageUrl };
  return {};
}

function sourceProductPayload() {
  return {
    sourceProductId: material.sourceSku,
    sourceProductInfo: {
      name: material.productName,
      sku: material.sourceSku,
      title: material.sourceTitle,
      tags: material.sourceTags,
      description: material.sourceDescription,
      detailImages: material.detailImages,
      videoUrls: material.videoUrls,
      richContentJson: material.richContentJson,
      includeDetailImages: material.includeDetailImages
    }
  };
}

function workbenchSnapshot() {
  return {
    version: 1,
    material: {
      sourceType: material.sourceType,
      productName: material.productName,
      sourceSku: material.sourceSku,
      sourceTitle: material.sourceTitle,
      sourceTags: material.sourceTags,
      sourceDescription: material.sourceDescription,
      templateId: material.templateId,
      mainImageUrl: material.mainImageUrl,
      mainImageDataUrl: material.mainImageDataUrl,
      imageName: material.imageName,
      detailImages: material.detailImages,
      videoUrls: material.videoUrls,
      richContentJson: material.richContentJson,
      templatePayload: material.templatePayload,
      sourceDraftId: material.sourceDraftId,
      sourceShopIds: material.sourceShopIds,
      includeDetailImages: material.includeDetailImages,
      sourceVariantValue: material.sourceVariantValue,
      targetInput: material.targetInput,
      variantGoal: material.variantGoal,
      useAiPlan: material.useAiPlan,
      operatorNote: material.operatorNote,
      imageConcurrency: material.imageConcurrency
    },
    analysis: state.analysis,
    analysisNo: state.analysisNo,
    templateDraft: { ...templateDraft }
  };
}

function selectedRowsForRun() {
  const currentRowsByKey = new Map(state.planRows.map((row) => [row.item_no || row.target_variant_value, row]));
  const selectedRows = selectedPlanRows.value
    .map((row) => currentRowsByKey.get(row.item_no || row.target_variant_value))
    .filter(Boolean);
  const rows = selectedRows.length ? selectedRows : state.planRows.filter((row) => row.selected);
  return rows.length ? rows : state.planRows;
}

function selectedItemNosForRun() {
  return selectedRowsForRun().map((row) => row.item_no || row.target_variant_value).filter(Boolean);
}

function itemOverridesForRun() {
  return selectedRowsForRun().map((row) => ({
    item_no: row.item_no,
    target_variant_value: row.target_variant_value,
    mainImagePlan: row.mainImagePlan,
    titlePlan: row.titlePlan,
    tagsPlan: row.tagsPlan,
    descriptionPlan: row.descriptionPlan,
    richTextPlan: row.richTextPlan,
    display_zh: {
      main_image_plan: row.mainImagePlan,
      title_plan: row.titlePlan,
      tags_plan: row.tagsPlan,
      description_plan: row.descriptionPlan,
      rich_content_plan: row.richTextPlan
    }
  }));
}

function copyOverridesForRun(rows = selectedRowsForRun()) {
  return rows.map((row) => {
    const target = row.target_variant_value || "";
    return {
      item_no: row.item_no,
      target_variant_value: target,
      main_image_plan: row.mainImagePlan || "",
      operator_note: material.operatorNote || "",
      final_image_prompt_en: row.promptReviewed ? row.finalImagePrompt || "" : "",
      final_negative_prompt_en: row.promptReviewed ? row.finalNegativePrompt || "" : "",
      title_ru: rowTitleOutput(row),
      tags_ru: rowTagsOutput(row),
      description_ru: rowDescriptionOutput(row)
    };
  });
}

async function analyzeVariantImage() {
  if (!canAnalyze.value) {
    ElMessage.warning("请先导入素材，或临时上传一张母图。");
    return;
  }
  const payload = {
    ...sourceImagePayload(),
    ...sourceProductPayload(),
    businessMode: "vehicle_model_variant",
    operatorGoal: "请用中文识别汽车用品主图，区分固定事实和车型、Logo、背景等可变事实。",
    operatorNote: material.operatorNote
  };
  const history = await apiClient.post("/api/ai-variant-lab/analysis/lookup", payload).catch(() => null);
  if (history?.reused && await confirmUseHistoryAnalysis(history)) {
    applyVariantAnalysisResult(history);
    ElMessage.success("已复用历史产品识别");
    return;
  }
  running.analyze = true;
  try {
    const result = await apiClient.post("/api/ai-variant-lab/analyze-image", {
      ...payload,
      forceAnalyze: true
    });
    applyVariantAnalysisResult(result);
    ElMessage.success("产品识别完成");
  } catch (error) {
    ElMessage.error(error.message || "产品识别失败");
  } finally {
    running.analyze = false;
  }
}

async function confirmUseHistoryAnalysis(history = {}) {
  try {
    await ElMessageBox.confirm(
      `找到 ${history.reused_at ? `更新于 ${history.reused_at} 的` : "一条"}历史识别记录。是否直接复用？`,
      "发现历史识别",
      {
        type: "info",
        confirmButtonText: "复用历史识别",
        cancelButtonText: "重新识别",
        distinguishCancelAndClose: true
      }
    );
    return true;
  } catch {
    return false;
  }
}

function applyVariantAnalysisResult(result = {}) {
  state.analysis = normalizeRecognitionAnalysis(result.analysis || {});
  state.analysisNo = result.analysis_no;
  const detectedSource = firstTarget(state.analysis?.source_variant_value);
  if (hasVehicleModel(detectedSource) && !material.sourceVariantValue) material.sourceVariantValue = detectedSource;
  currentStep.value = "recognize";
}

async function createBatchPlan() {
  if (!canPlan.value) {
    ElMessage.warning("请先完成素材导入，并填写目标车型。");
    return;
  }
  running.batchPlan = true;
  try {
    const result = await apiClient.post("/api/ai-variant-lab/batch-plan", {
      analysis: editableAnalysisForPlan(),
      analysisNo: state.analysisNo || undefined,
      ...(!state.analysis ? sourceImagePayload() : {}),
      ...sourceProductPayload(),
      sourceVariantValue: sourceModel.value,
      targetModels: targetModels.value,
      templateKey: templateDraft.templateKey,
      variantType: material.variantGoal,
      useAiPlan: material.useAiPlan,
      operatorNote: material.operatorNote,
      workbenchSnapshot: workbenchSnapshot()
    });
    state.batchJob = result;
    state.batchItems = result.items || [];
    state.planRows = (result.items || []).map(toPlanRow);
    state.batchDryRun = null;
    currentStep.value = "plan";
    await loadBatchJobDetail(result.job_no, { silent: true });
    await nextTick();
    toggleAllPlanRows(true);
    ElMessage.success(`已生成 ${state.planRows.length} 个车型计划`);
  } catch (error) {
    ElMessage.error(error.message || "批量计划生成失败");
  } finally {
    running.batchPlan = false;
  }
}

async function importCaseForQuickVariant(caseRow = {}, targets = [], options = {}) {
  const caseJson = caseRow.case_json || {};
  const snapshot = caseJson.listing_template_snapshot || {};
  const media = snapshot.media_context || {};
  const assets = caseJson.sample_assets || {};
  const productFacts = caseJson.product_facts || {};
  const contract = caseJson.variant_contract || {};
  const sourceValue = caseRow.source_value || caseJson.source_value || contract.source_value || "";
  const successValue = caseRow.success_target_value || caseJson.success_target_value || contract.success_target_value || "";
  const sourceImage = assets.source_image_url || normalizeImageList(media.images || [])[0] || "";
  const templatePayload = snapshot.template_payload || null;

  resetPlanState();
  material.sourceType = "case";
  material.productName = caseRow.product_subject_name || productFacts.product_subject_name || productFacts.product_type || caseRow.case_name || "案例模板商品";
  material.sourceSku = caseRow.case_no || "";
  material.sourceTitle = material.productName;
  material.sourceTags = "";
  material.sourceDescription = tagsTextForCase(productFacts.keep_facts || productFacts.fixed_facts_zh || []);
  material.templateId = snapshot.source_template_id || "";
  material.mainImageUrl = sourceImage;
  material.mainImageDataUrl = "";
  material.imageName = sourceImage ? "case source image" : "";
  material.detailImages = uniqueList(normalizeImageList(media.detail_images || []).filter((url) => url && url !== sourceImage));
  material.videoUrls = uniqueList(normalizeStringList(media.videos || assets.video_urls || []));
  material.richContentJson = media.rich_content_json || caseJson.sample_outputs?.rich_content_ru || "";
  material.templatePayload = templatePayload;
  material.sourceDraftId = snapshot.source_draft_id || "";
  material.sourceShopIds = normalizeShopIds(snapshot.source_shop_ids || []);
  material.sourceVariantValue = sourceValue || successValue || "";
  material.targetInput = targets.join("\n");
  material.variantGoal = caseRow.variant_type || caseJson.variant_type || contract.variant_type || "vehicle_model_swap";
  material.useAiPlan = true;
  material.operatorNote = contract.operator_note || "";

  state.analysis = normalizeRecognitionAnalysis({
    product_type: productFacts.product_type || caseRow.product_subject_name || "",
    product_subject: productFacts.product_subject_name || productFacts.product_type || caseRow.product_subject_name || "",
    source_variant_value: sourceValue || successValue || "",
    recommended_variant_mode: material.variantGoal,
    keep_facts: productFacts.keep_facts || productFacts.fixed_facts_zh || [],
    changeable_facts: productFacts.changeable_facts || productFacts.variable_facts_zh || contract.replace_zones || [],
    forbidden_changes: productFacts.forbidden_changes || contract.preserve_zones || [],
    display_zh: {
      fixed_facts: productFacts.fixed_facts_zh || productFacts.keep_facts || [],
      variable_facts: productFacts.variable_facts_zh || productFacts.changeable_facts || contract.replace_zones || [],
      forbidden_changes: productFacts.forbidden_changes || contract.preserve_zones || []
    }
  });

  const plan = await apiClient.post("/api/ai-variant-lab/batch-plan", {
    analysis: editableAnalysisForPlan(),
    ...sourceImagePayload(),
    ...sourceProductPayload(),
    sourceVariantValue: sourceModel.value || sourceValue || successValue,
    targetModels: targets,
    templateKey: templateDraft.templateKey,
    variantType: material.variantGoal,
    useAiPlan: true,
    operatorNote: [
      material.operatorNote,
      "从案例库复用产品事实、模板资产和变量契约。",
      "请为每个新目标重新生成俄语标题、标签、描述和主图计划，不要照抄案例样例文案。",
      "标题、标签、描述必须围绕当前目标值，不得残留案例源值或成功样例目标值。"
    ].filter(Boolean).join("\n")
  });
  state.batchJob = plan;
  state.batchItems = plan.items || [];
  state.planRows = (plan.items || []).map(toPlanRow);
  applyCaseMetadataToRows(state.planRows, caseJson, { sourceValue, successValue, offerPrefix: options.offerPrefix });
  state.batchDryRun = null;
  currentStep.value = "generate";
  await nextTick();
  toggleAllPlanRows(true);
}

function applyCaseMetadataToRows(rows = [], caseJson = {}, options = {}) {
  const staleValues = caseVariantStaleValues(caseJson, options);
  const offerPrefix = String(options.offerPrefix || "").trim();
  rows.forEach((row) => {
    if (offerPrefix) {
      row.offerPrefix = offerPrefix;
      row.offerId = "";
    }
    row.raw = {
      ...(row.raw || {}),
      copy_source: "case_library_ai_plan",
      case_template: {
        case_no: caseJson.case_no || "",
        case_name: caseJson.case_name || "",
        stale_values: staleValues
      }
    };
  });
}

function caseVariantStaleValues(caseJson = {}, options = {}) {
  const contract = caseJson.variant_contract || {};
  const sampleRows = Array.isArray(caseJson.sample_rows) ? caseJson.sample_rows : [];
  const rawValues = [
    options.successValue,
    options.sourceValue,
    caseJson.success_target_value,
    caseJson.source_value,
    contract.success_target_value,
    contract.source_value,
    ...sampleRows.flatMap((row) => [row.target_variant_value, row.source_variant_value])
  ];
  return uniqueList(rawValues.flatMap((value) => {
    const text = String(value || "").trim();
    if (!text) return [];
    return [
      text,
      text.replace(/_/g, " "),
      text.replace(/\s+/g, "_"),
      ...text.split(/[\s_-]+/).filter((part) => part.length >= 3)
    ];
  })).filter((item) => item.length >= 2);
}

function tagsTextForCase(value) {
  return Array.isArray(value) ? value.join(" ") : String(value || "");
}

function toPlanRow(item, index) {
  const display = item.display_zh || item.display || {};
  const target = item.target_variant_value || item.targetVariantValue || "";
  const titleText = initialRowTitleText(item, target);
  const tagsText = initialRowTagsText(item, target);
  const descriptionText = initialRowDescriptionText(item, target);
  return {
    selected: true,
    item_no: item.item_no,
    sort_order: item.sort_order || index + 1,
    target_variant_value: target,
    mainImagePlan: display.main_image_plan || `主图中产品主体、材质、结构和数量不变，只调整可变车型线索、车牌或背景车型为 ${target}。`,
    titlePlan: display.title_plan || `标题替换为 ${target} 对应车型，保留产品类型、材质和数量信息。`,
    tagsPlan: display.tags_plan || `标签包含 ${target}、产品类型、汽车用品和使用场景关键词。`,
    descriptionPlan: display.description_plan || `描述围绕 ${target} 的真实产品用途生成，保留产品主体、材质、数量和结构。`,
    richTextPlan: display.rich_content_plan || `富文本突出真实产品用途、目标车型和产品结构，不改成其他品类。`,
    status: item.status || "planned",
    imageResult: item.image_result_json || {},
    assets: item.assets || {},
    richContentStatus: "",
    videoStatus: "",
    finalImagePrompt: item.image_edit_prompt_en || "",
    finalNegativePrompt: item.negative_prompt_en || "",
    promptReviewed: item.image_prompt_reviewed === true,
    titleText,
    tagsText,
    descriptionText,
    originalTitleText: titleText,
    originalTagsText: tagsText,
    originalDescriptionText: descriptionText,
    manualTitle: "",
    manualTags: "",
    manualDescription: "",
    offerId: String(item.offer_id || item.offerId || "").trim(),
    errorMessage: item.error_message || "",
    listingDraftId: item.listing_draft_id || "",
    draftSaveStatus: "",
    raw: item
  };
}

function toggleAllPlanRows(checked) {
  planTableRef.value?.clearSelection();
  if (!checked) {
    selectedPlanRows.value = [];
    state.planRows.forEach((row) => { row.selected = false; });
    return;
  }
  state.planRows.forEach((row) => {
    row.selected = true;
    planTableRef.value?.toggleRowSelection(row, true);
  });
  selectedPlanRows.value = state.planRows.slice();
}

async function selectFailedPlanRows() {
  const failedRows = state.planRows.filter((row) => row.status === "failed");
  if (!failedRows.length) {
    ElMessage.info("当前没有失败任务。");
    return;
  }
  const failedKeys = new Set(failedRows.map((row) => row.item_no || row.target_variant_value));
  const allFailedSelected = failedRows.every((row) => selectedPlanRows.value.some((selected) => (selected.item_no || selected.target_variant_value) === (row.item_no || row.target_variant_value)));
  if (allFailedSelected) {
    failedRows.forEach((row) => {
      row.selected = false;
      planTableRef.value?.toggleRowSelection(row, false);
      queueTableRef.value?.toggleRowSelection(row, false);
    });
    selectedPlanRows.value = selectedPlanRows.value.filter((row) => !failedKeys.has(row.item_no || row.target_variant_value));
    ElMessage.info("已取消选择失败任务。");
    return;
  }
  planTableRef.value?.clearSelection();
  queueTableRef.value?.clearSelection();
  state.planRows.forEach((row) => { row.selected = false; });
  failedRows.forEach((row) => {
    row.selected = true;
    planTableRef.value?.toggleRowSelection(row, true);
    queueTableRef.value?.toggleRowSelection(row, true);
  });
  selectedPlanRows.value = failedRows;
  try {
    await ElMessageBox.confirm(
      `已选择 ${failedRows.length} 个失败任务。重新生成会发起 ${failedRows.length} 次新的图片请求，服务商可能按每次约 ¥${imageRequestUnitCost.toFixed(3)} 再次计费。是否立即重新生成？`,
      "重新生成失败项",
      { type: "warning", confirmButtonText: "立即重新生成", cancelButtonText: "仅保留选择" }
    );
    await executeBatchImages({ retryFailed: true });
  } catch (error) {
    if (error !== "cancel") throw error;
  }
}

function onPlanSelectionChange(rows) {
  selectedPlanRows.value = rows;
  const selected = new Set(rows.map((row) => row.item_no || row.target_variant_value));
  state.planRows.forEach((row) => { row.selected = selected.has(row.item_no || row.target_variant_value); });
}

function syncRowTarget(row) {
  const target = String(row.target_variant_value || "").trim();
  const previous = String(row.raw?.target_variant_value || "").trim();
  row.target_variant_value = target;
  row.raw = {
    ...(row.raw || {}),
    target_variant_value: target
  };
  if (previous && target && previous !== target) {
    row.offerId = "";
    row.titleText = replaceSpecificVariantText(rowTitleOutput(row), previous, target);
    row.tagsText = replaceSpecificVariantText(rowTagsOutput(row).join(" "), previous, target);
    row.descriptionText = replaceSpecificVariantText(rowDescriptionOutput(row), previous, target);
  }
}

function offerIdPrefix(row) {
  const explicitPrefix = String(row?.offerPrefix || "").trim();
  if (explicitPrefix) return explicitPrefix;
  const target = String(row.target_variant_value || "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase()
    .slice(0, 36);
  return `VAR-${target || "ITEM"}`;
}

async function generateOfferIds(rows = selectedRowsForRun()) {
  const targets = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!targets.length) {
    ElMessage.warning("请先选择要生成货号的车型。");
    return false;
  }
  running.offerIds = true;
  try {
    const used = uniqueList(state.planRows.map((row) => row.offerId).filter(Boolean));
    await runWithConcurrency(targets, OFFER_ID_GENERATION_CONCURRENCY, async (row) => {
      const result = await apiClient.post("/api/listing/generate-offer-id", {
        prefix: offerIdPrefix(row),
        existingIds: used
      });
      const offerId = String(result.offerId || result.offer_id || "").trim();
      if (!offerId) throw new Error(`车型 ${row.target_variant_value || "-"} 未生成货号`);
      row.offerId = offerId;
      used.push(offerId);
    });
    ElMessage.success(`已生成 ${targets.length} 个唯一货号`);
    return true;
  } catch (error) {
    ElMessage.error(error.message || "批量生成货号失败");
    return false;
  } finally {
    running.offerIds = false;
  }
}

function deletePlanRow(row) {
  const key = row.item_no || row.target_variant_value;
  state.planRows = state.planRows.filter((item) => (item.item_no || item.target_variant_value) !== key);
  selectedPlanRows.value = selectedPlanRows.value.filter((item) => (item.item_no || item.target_variant_value) !== key);
  state.batchItems = state.batchItems.filter((item) => (item.item_no || item.target_variant_value) !== key);
  ElMessage.success("已从本次队列移除");
}

function openBatchCopyEdit() {
  if (!state.planRows.length) {
    ElMessage.warning("请先生成批量计划。");
    return;
  }
  batchCopyEdit.title = "";
  batchCopyEdit.tags = "";
  batchCopyEdit.description = "";
  batchCopyEdit.visible = true;
}

function applyBatchCopyEdit() {
  const rows = selectedRowsForRun();
  if (!rows.length) {
    ElMessage.warning("请先选择要覆盖文案的车型。");
    return;
  }
  const hasInput = [batchCopyEdit.title, batchCopyEdit.tags, batchCopyEdit.description]
    .some((value) => String(value || "").trim());
  if (!hasInput) {
    ElMessage.warning("请至少填写一个要覆盖的字段。");
    return;
  }
  rows.forEach((row) => {
    const target = row.target_variant_value || "";
    const title = renderManualCopyTemplate(batchCopyEdit.title, target);
    const tags = renderManualCopyTemplate(batchCopyEdit.tags, target);
    const description = renderManualCopyTemplate(batchCopyEdit.description, target);
    if (title) row.titleText = title;
    if (tags) row.tagsText = tags;
    if (description) row.descriptionText = description;
  });
  batchCopyEdit.visible = false;
  ElMessage.success(`已覆盖 ${rows.length} 个车型的文案`);
}

function renderManualCopyTemplate(value = "", target = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.replace(/\{model\}/gi, target);
}

async function openPromptReview(rows = selectedRowsForRun()) {
  if (!state.batchJob?.job_no) {
    ElMessage.warning("请先生成批量计划。");
    return;
  }
  const reviewRows = Array.isArray(rows) && rows.length ? rows : selectedRowsForRun();
  promptReview.rowKeys = reviewRows.map((row) => row.item_no || row.target_variant_value).filter(Boolean);
  promptReview.loading = true;
  try {
    const result = await apiClient.post("/api/ai-variant-lab/batch-run-images", {
      jobNo: state.batchJob.job_no,
      ...sourceImagePayload(),
      execute: false,
      itemNos: reviewRows.map((row) => row.item_no || row.target_variant_value).filter(Boolean),
      itemOverrides: copyOverridesForRun(reviewRows),
      limit: state.planRows.length || 20,
      ratio: "3:4",
      imageConcurrency: backendImageConcurrency.value
    });
    state.batchDryRun = result;
    applyPromptReviewResults(result.results || []);
    await loadBatchJobDetail(state.batchJob.job_no);
    promptReview.visible = true;
  } catch (error) {
    ElMessage.error(error.message || "读取最终提示词失败");
  } finally {
    promptReview.loading = false;
  }
}

function applyPromptReviewResults(results = []) {
  const rowByKey = new Map();
  state.planRows.forEach((row) => {
    if (row.item_no) rowByKey.set(row.item_no, row);
    if (row.target_variant_value) rowByKey.set(row.target_variant_value, row);
  });
  results.forEach((item) => {
    const row = rowByKey.get(item.item_no) || rowByKey.get(item.target_variant_value);
    if (!row) return;
    row.finalImagePrompt = item.image_edit_prompt_en || row.finalImagePrompt || "";
    row.finalNegativePrompt = item.negative_prompt_en || row.finalNegativePrompt || "";
  });
}

function promptReviewRows() {
  const keys = new Set(promptReview.rowKeys);
  const rows = keys.size
    ? state.planRows.filter((row) => keys.has(row.item_no || row.target_variant_value))
    : selectedRowsForRun();
  return rows.filter(Boolean);
}

function savePromptReview() {
  promptReviewRows().forEach((row) => {
    row.promptReviewed = true;
  });
  promptReview.visible = false;
  ElMessage.success("提示词调整已保留，开始生成或重生主图时会使用当前版本。");
}

async function executeBatchImages(options = {}) {
  if (!state.batchJob?.job_no) {
    ElMessage.warning("请先生成批量计划。");
    return;
  }
  if (!options.retryFailed) {
    await ElMessageBox.confirm(`将按当前队列在后台并发生成，预计最长约 ${estimatedBatchText.value}。每次图片请求可能计费；失败后重试属于新请求，可能再次计费。确认继续？`, "开始生成", {
      type: "warning",
      confirmButtonText: "确认生成",
      cancelButtonText: "先不生成"
    });
  }
  running.imageExecute = true;
  startGenerationPolling();
  try {
    const result = await apiClient.post("/api/ai-variant-lab/batch-run-images", {
      jobNo: state.batchJob.job_no,
      ...sourceImagePayload(),
      execute: true,
      itemNos: selectedItemNosForRun(),
      itemOverrides: copyOverridesForRun(),
      limit: state.planRows.length || 20,
      ratio: "3:4",
      imageConcurrency: backendImageConcurrency.value
    });
    await loadBatchJobDetail(state.batchJob.job_no);
    if (result.background || result.queued) {
      ElMessage.success(`已进入后台生成队列，预计最长约 ${formatDurationText(result.estimated_seconds || estimatedBatchSeconds.value)}。`);
    } else if (result.summary?.failed) {
      ElMessage.warning(`生成完成，但有 ${result.summary.failed} 个任务失败，请查看失败原因。`);
    } else {
      ElMessage.success("生成任务已执行");
    }
  } catch (error) {
    if (error !== "cancel") ElMessage.error(error.message || "执行生成失败");
  } finally {
    running.imageExecute = false;
    await loadBatchJobDetail(state.batchJob?.job_no, { silent: true });
    if (!generationActive.value) stopGenerationPolling();
  }
}

async function resumePendingImages() {
  if (!state.batchJob?.job_no) return;
  running.imageExecute = true;
  startGenerationPolling();
  try {
    const result = await apiClient.post("/api/ai-variant-lab/batch-resume-images", {
      jobNo: state.batchJob.job_no
    });
    await loadBatchJobDetail(state.batchJob.job_no);
    ElMessage.success(result.resumed_count
      ? `已继续拉回 ${result.resumed_count} 个服务商任务，不会重复提交生图。`
      : "任务仍在后台拉回，无需重新提交生图。");
  } catch (error) {
    ElMessage.error(error.message || "继续拉回图片失败");
  } finally {
    running.imageExecute = false;
  }
}

function startGenerationPolling() {
  stopGenerationPolling();
  if (!state.batchJob?.job_no) return;
  generationPollTimer = window.setInterval(() => {
    if (generationPollPending) return;
    generationPollPending = true;
    void loadBatchJobDetail(state.batchJob?.job_no, { silent: true, summaryOnly: true })
      .finally(() => { generationPollPending = false; });
  }, 4000);
}

function stopGenerationPolling() {
  if (!generationPollTimer) return;
  window.clearInterval(generationPollTimer);
  generationPollTimer = 0;
  generationPollPending = false;
}

async function loadBatchJobDetail(jobNo, options = {}) {
  if (!jobNo) return;
  let detail = null;
  try {
    const summaryQuery = options.summaryOnly ? "?summary=1" : "?full=1";
    detail = await apiClient.get(`/api/ai-variant-lab/batch-jobs/${encodeURIComponent(jobNo)}${summaryQuery}`, { noCache: true });
  } catch (error) {
    if (!options.silent) throw error;
    return;
  }
  state.batchJob = { ...(state.batchJob || {}), ...(detail.job || {}), queue: detail.queue || state.batchJob?.queue || null };
  if (options.summaryOnly) {
    const itemByNo = new Map((detail.items || []).map((item) => [item.item_no, item]));
    state.planRows.forEach((row) => {
      const item = itemByNo.get(row.item_no);
      if (!item) return;
      const previousStatus = row.status;
      const previousImageUrl = resultImageUrl(row);
      row.status = item.status || row.status;
      row.errorMessage = item.error_message || "";
      if (item.image_result_json?.generatedImages?.length) row.imageResult = item.image_result_json;
      const currentImageUrl = resultImageUrl(row);
      if (currentImageUrl && (previousStatus !== "image_done" || previousImageUrl !== currentImageUrl)) {
        void queueGeneratedRowPreparation(row, { silent: true, generateVideo: true }).catch(() => {});
      }
    });
    if (!generationActive.value && generationPollTimer) {
      stopGenerationPolling();
      await loadBatchJobDetail(jobNo, { silent: true });
    }
    return;
  }
  state.batchItems = detail.items || [];
  const itemByNo = new Map(state.batchItems.map((item) => [item.item_no, item]));
  state.planRows.forEach((row) => {
    const item = itemByNo.get(row.item_no);
    if (!item) return;
    const previousStatus = row.status;
    const previousImageUrl = resultImageUrl(row);
    row.status = item.status || row.status;
    row.errorMessage = item.error_message || "";
    row.imageResult = item.image_result_json || {};
    row.raw = { ...(row.raw || {}), ...(item.item_json || {}), persisted: item };
    const currentImageUrl = resultImageUrl(row);
    if (currentImageUrl && (previousStatus !== "image_done" || previousImageUrl !== currentImageUrl)) {
      void queueGeneratedRowPreparation(row, { silent: true, generateVideo: true }).catch(() => {});
    }
  });
  if (!generationActive.value && generationPollTimer) {
    stopGenerationPolling();
    await restorePersistedBatchAssets(jobNo);
    const generatedRows = selectedRowsForRun().filter((row) => resultImageUrl(row));
    if (generatedRows.length) {
      await prepareGeneratedRowsForDraft(generatedRows, { silent: true, generateVideo: true });
      generatedRows.forEach((row) => { row.regenerateDownstream = false; });
    }
  }
}

async function restorePersistedBatchAssets(jobNo) {
  const batchNo = String(jobNo || "").trim();
  if (!batchNo || restoredBatchAssetJobs.has(batchNo)) return;
  const fieldKeys = ["main_image", "title", "tags", "description", "rich_content", "video"];
  let groups;
  try {
    groups = await Promise.all(fieldKeys.map((fieldKey) => {
      const params = new URLSearchParams({ sourceBatchId: batchNo, fieldKey, compact: "1", limit: "200" });
      return apiClient.get(`/api/listing/ai-variant-assets?${params.toString()}`, { noCache: true });
    }));
  } catch {
    return;
  }
  const rowByResultId = new Map(state.planRows.map((row) => [rowResultId(row), row]));
  groups.flat().forEach((item) => {
    const row = rowByResultId.get(String(item.result_id || item.resultId || "").trim());
    const fieldKey = String(item.field_key || item.fieldKey || "").trim();
    if (!row || !fieldKey || !item.asset) return;
    row.assets = { ...(row.assets || {}), [fieldKey]: row.assets?.[fieldKey] || item.asset };
  });
  restoredBatchAssetJobs.add(batchNo);
}

async function openHistory() {
  history.visible = true;
  history.loading = true;
  try {
    const result = await apiClient.get("/api/ai-variant-lab/batch-jobs?limit=50", { noCache: true });
    history.jobs = Array.isArray(result?.jobs) ? result.jobs : [];
  } catch (error) {
    ElMessage.error(error.message || "裂变记录加载失败");
  } finally {
    history.loading = false;
  }
}

async function restoreHistoryJob(job) {
  const jobNo = String(job?.job_no || "").trim();
  if (!jobNo || history.restoring) return;
  history.restoring = jobNo;
  try {
    const detail = await apiClient.get(`/api/ai-variant-lab/batch-jobs/${encodeURIComponent(jobNo)}?full=1`, { noCache: true });
    const snapshot = detail.job?.request_json?.workbench_snapshot || {};
    const savedMaterial = snapshot.material || {};
    if (Object.keys(savedMaterial).length) Object.assign(material, savedMaterial);
    else {
      const restoredSource = await restoreLegacyHistorySource(detail.job);
      if (!restoredSource) {
        material.sourceSku = detail.job?.source_product_id || "";
        material.mainImageUrl = detail.job?.result_json?.source_image_url || "";
        material.mainImageDataUrl = "";
      }
      material.sourceVariantValue = detail.job?.source_variant_value || material.sourceVariantValue || "";
      material.targetInput = (detail.job?.request_json?.target_variant_values || []).join("\n");
    }
    if (snapshot.templateDraft) Object.assign(templateDraft, snapshot.templateDraft);
    state.analysis = snapshot.analysis ? normalizeRecognitionAnalysis(snapshot.analysis) : null;
    state.analysisNo = snapshot.analysisNo || detail.job?.analysis_no || "";
    state.batchJob = { ...(detail.job || {}), queue: detail.queue || null };
    state.batchItems = detail.items || [];
    state.planRows = state.batchItems.map((item, index) => toPlanRow({
      ...(item.item_json || {}),
      item_no: item.item_no,
      target_variant_value: item.target_variant_value,
      status: item.status,
      image_result_json: item.image_result_json,
      error_message: item.error_message,
      sort_order: item.sort_order
    }, index));
    currentStep.value = "generate";
    history.visible = false;
    await nextTick();
    toggleAllPlanRows(true);
    if (generationActive.value) startGenerationPolling();
    else await restorePersistedBatchAssets(jobNo);
    if (material.templatePayload) ElMessage.success(`已恢复裂变记录 ${jobNo}，可继续保存草稿。`);
    else ElMessage.warning("已恢复旧任务的生成结果；未找到对应母商品模板，保存草稿前请重新导入母商品。");
  } catch (error) {
    ElMessage.error(error.message || "裂变记录恢复失败");
  } finally {
    history.restoring = "";
  }
}

async function restoreLegacyHistorySource(job = {}) {
  const sourceId = String(job.source_product_id || "").trim();
  if (!/^\d+$/.test(sourceId)) return false;
  try {
    const draft = await apiClient.get(`/api/listing/drafts/${encodeURIComponent(sourceId)}`, { noCache: true });
    const candidate = normalizeImportCandidate(draft || {}, "draft", 0);
    if (!candidate.templatePayload || !Object.keys(candidate.templatePayload).length) return false;
    applyImportedMaterial(candidate);
    return true;
  } catch {
    return false;
  }
}

function historyStatusText(status) {
  return ({
    planned: "待生成",
    image_dry_run: "已预检",
    generating_images: "生成中",
    provider_pending: "等待服务商",
    image_done: "已完成",
    partially_generated: "部分完成",
    partially_failed: "部分失败",
    failed: "失败"
  })[status] || status || "未知";
}

function historyStatusType(status) {
  if (status === "image_done") return "success";
  if (["failed", "partially_failed"].includes(status)) return "danger";
  if (status === "generating_images") return "warning";
  if (status === "provider_pending") return "warning";
  return "info";
}

function historyProductText(job) {
  return job?.request_json?.workbench_snapshot?.material?.productName || job?.source_product_id || "未记录母商品";
}

function historyPersonText(job) {
  return job?.created_by_name || (job?.created_by_person_id ? `人员 ${job.created_by_person_id}` : "未记录");
}

onUnmounted(() => {
  window.removeEventListener("resize", updateViewportHeight);
  stopGenerationPolling();
  if (draftSaveBatchPollTimer) window.clearTimeout(draftSaveBatchPollTimer);
});

async function saveTemplate() {
  if (!state.batchJob || !state.planRows.length) {
    ElMessage.warning("请先生成并确认批量计划。");
    return;
  }
  const rows = selectedPlanRows.value.length ? selectedPlanRows.value : state.planRows.filter((row) => row.selected);
  if (!rows.length) {
    ElMessage.warning("请先勾选要保存为案例的车型，或在单行操作里点击保存案例。");
    return;
  }
  running.saveTemplate = true;
  try {
    const results = [];
    for (const row of rows) {
      results.push(await saveCaseRow(row, { silent: true }));
    }
    state.savedTemplateKey = results.at(-1)?.case_no || "";
    ElMessage.success(`已保存 ${results.length} 个案例`);
  } catch (error) {
    ElMessage.error(error.message || "保存案例失败");
  } finally {
    running.saveTemplate = false;
  }
}

async function saveCaseRow(row, options = {}) {
  if (!row) return null;
  running.saveCaseRow = rowResultId(row);
  try {
    await persistGeneratedRowAssets(row);
    const result = await apiClient.post("/api/ai-variant-lab/cases", buildSaveCasePayload([row]));
    await verifySavedCase(result.case_no);
    state.savedTemplateKey = result.case_no;
    if (!options.silent) ElMessage.success(`已保存 ${row.target_variant_value || "当前车型"} 案例，可到裂变案例查看`);
    return result;
  } finally {
    running.saveCaseRow = "";
  }
}

async function verifySavedCase(caseNo) {
  const key = String(caseNo || "").trim();
  if (!key) throw new Error("保存接口没有返回案例编号，请检查后端案例库接口。");
  try {
    await apiClient.get(`/api/ai-variant-lab/cases/${encodeURIComponent(key)}`, { noCache: true });
  } catch (error) {
    throw new Error(`保存请求已返回，但案例库未读到该案例（${key}）。请确认后端服务已更新并重启。`);
  }
}

function buildSaveCasePayload(rows = selectedRowsForRun()) {
  const sourceRows = rows.length ? rows : selectedRowsForRun();
  const sampleRows = sourceRows.map((row) => ({
    item_no: row.item_no || "",
    target_variant_value: row.target_variant_value || "",
    status: row.status || "",
    generated_main_image_url: rowMainImageDraftUrl(row) || "",
    generated_main_image_original_url: resultImageUrl(row) || "",
    image_result: row.imageResult || {},
    assets: row.assets || {},
    final_image_prompt_en: row.finalImagePrompt || row.raw?.final_image_prompt_en || row.raw?.image_edit_prompt_en || "",
    negative_prompt_en: row.finalNegativePrompt || row.raw?.final_negative_prompt_en || row.raw?.negative_prompt_en || "",
    title_ru: rowTitleOutput(row),
    tags_ru: rowTagsOutput(row),
    description_ru: rowDescriptionOutput(row),
    rich_content_json: rowRichContentOutput(row),
    video_urls: rowVideoUrls(row),
    prompt_snapshot: promptSnapshot(row),
    row_snapshot: lightRowSnapshot(row)
  }));
  const successfulRow = sampleRows.find((row) => row.generated_main_image_url || row.status === "image_done") || sampleRows[0] || {};
  const templatePayload = material.templatePayload || null;
  const targetSuffix = successfulRow.target_variant_value ? ` - ${successfulRow.target_variant_value}` : "";
  return {
    caseNo: "",
    caseName: `${templateDraft.templateName}${targetSuffix}`,
    categoryKey: templateDraft.templateKey || "generic_vehicle_accessory_variant",
    status: "active",
    variantType: material.variantGoal,
    variableSlot: material.variantGoal === "vehicle_model_swap" ? "vehicle_model" : "variant_value",
    sourceValue: sourceModel.value,
    successTargetValue: successfulRow.target_variant_value || "",
    productFacts: {
      product_type: state.analysis?.product_type || state.analysis?.product_subject || material.productName || "",
      product_subject_name: state.analysis?.product_subject || state.analysis?.product_type || material.productName || "",
      keep_facts: state.analysis?.keep_facts || [],
      changeable_facts: state.analysis?.changeable_facts || [],
      forbidden_changes: state.analysis?.forbidden_changes || [],
      fixed_facts_zh: chineseFacts(state.analysis?.keep_facts),
      variable_facts_zh: chineseFacts(state.analysis?.changeable_facts)
    },
    variantContract: {
      variant_type: material.variantGoal,
      variable_slot: material.variantGoal === "vehicle_model_swap" ? "vehicle_model" : "variant_value",
      source_value: sourceModel.value,
      success_target_value: successfulRow.target_variant_value || "",
      replace_zones: ["large_title_text", "model_text", "license_plate_text", "background_vehicle_cues", "logo_or_badge_text"],
      preserve_zones: ["product_body", "shape", "material", "quantity", "color_scheme", "layout"],
      operator_note: material.operatorNote || ""
    },
    listingTemplateSnapshot: {
      source_draft_id: material.sourceDraftId || "",
      source_template_id: material.templateId || "",
      source_shop_ids: normalizeShopIds(material.sourceShopIds || []),
      template_payload: templatePayload,
      editable_payload: parseMaybeJson(templatePayload?.editable_payload || templatePayload?.editablePayload) || null,
      category_context: {
        ozon_category_id: templatePayload?.ozon_category_id || templatePayload?.ozonCategoryId || "",
        ozon_type_id: templatePayload?.ozon_type_id || templatePayload?.ozonTypeId || "",
        ozon_description_category_id: templatePayload?.ozon_description_category_id || templatePayload?.ozonDescriptionCategoryId || ""
      },
      media_context: {
        images: uniqueList([material.mainImageUrl, ...material.detailImages].filter(Boolean)),
        detail_images: uniqueList(material.detailImages || []),
        videos: uniqueList(material.videoUrls || []),
        rich_content_json: material.richContentJson || ""
      }
    },
    sourceTrace: {
      analysis_no: state.analysisNo || state.batchJob?.analysis_no || "",
      batch_job_no: state.batchJob?.job_no || "",
      source_type: material.sourceType || "",
      listing_draft_id: material.sourceDraftId || "",
      listing_template_id: material.templateId || "",
      source_product_id: material.sourceSku || ""
    },
    sampleOutputs: {
      final_image_prompt_en: successfulRow.final_image_prompt_en || "",
      negative_prompt_en: successfulRow.negative_prompt_en || "",
      title_ru: successfulRow.title_ru || "",
      tags_ru: successfulRow.tags_ru || [],
      description_ru: successfulRow.description_ru || "",
      rich_content_ru: successfulRow.rich_content_json || ""
    },
    sampleAssets: {
      source_image_url: material.mainImageUrl || "",
      generated_main_image_url: successfulRow.generated_main_image_url || "",
      reference_images: uniqueList([material.mainImageUrl, ...material.detailImages].filter(Boolean)),
      video_urls: successfulRow.video_urls || []
    },
    sampleRows,
    userNote: templateDraft.userNote
  };
}

async function saveSelectedRowsToDrafts() {
  if (running.saveDrafts) return;
  const rows = selectedRowsForRun();
  if (!rows.length) {
    ElMessage.warning("请先选择要保存到草稿箱的车型。");
    return;
  }
  const missingMainImageRows = rows.filter((row) => !resultImageUrl(row));
  if (missingMainImageRows.length) {
    ElMessage.warning(`${missingMainImageRows.length} 个车型主图未生成成功，将先使用母图保存草稿，失败原因会保留在草稿记录中。`);
  }
  running.saveDrafts = true;
  running.saveDraftStage = "准备保存素材";
  if (!material.templateId && !material.templatePayload) {
    ElMessage.warning("当前母素材缺少上架模板。请优先从草稿箱或已有上架模板导入母商品。");
    running.saveDrafts = false;
    running.saveDraftStage = "";
    return;
  }
  const missingOfferRows = rows.filter((row) => !String(row.offerId || "").trim());
  if (missingOfferRows.length && !await generateOfferIds(missingOfferRows)) {
    running.saveDrafts = false;
    running.saveDraftStage = "";
    return;
  }
  try {
    await prepareGeneratedRowsForDraft(rows, { silent: true, generateVideo: false, throwOnError: true });
  } catch (error) {
    running.saveDrafts = false;
    running.saveDraftStage = "";
    ElMessage.error(error?.message || "保存前素材准备失败，请稍后重试");
    return;
  }
  running.saveDraftStage = "检查质量提示";
  const qualityIssues = rows.flatMap((row) => rowQualityIssues(row).map((issue) => `${row.target_variant_value}: ${issue}`));
  if (qualityIssues.length) {
    try {
      await ElMessageBox.confirm(
        `有 ${qualityIssues.length} 个质量提示，建议先修正或重新生成。\n\n${qualityIssues.slice(0, 8).join("\n")}${qualityIssues.length > 8 ? "\n..." : ""}\n\n仍然继续保存到草稿箱吗？`,
        "质量闸门提示",
        {
          type: "warning",
          confirmButtonText: "继续保存",
          cancelButtonText: "先不保存"
        }
      );
    } catch {
      running.saveDrafts = false;
      running.saveDraftStage = "";
      return;
    }
  }
  running.saveDraftStage = "正在保存草稿";
  try {
    rows.forEach((row) => { row.draftSaveStatus = "queued"; });
    const chunks = buildDraftSaveRequestChunks(rows);
    const batches = new Array(chunks.length);
    await runWithConcurrency(chunks.map((chunk, index) => ({ chunk, index })), DRAFT_SAVE_SUBMIT_CONCURRENCY, async ({ chunk, index }) => {
      const batch = await apiClient.post("/api/ai-variant-draft-save/batches", { items: chunk.items });
      batches[index] = { batchNo: batch.batch_no || "", rows: chunk.rows };
    });
    Object.assign(draftSaveProgress, { batchNo: batches.map((item) => item.batchNo).filter(Boolean).join(","), status: "queued", total: rows.length, success: 0, failed: 0 });
    ElMessage.success(`已将 ${rows.length} 个草稿拆成 ${batches.length} 批提交，后台将继续完成，可继续操作页面。`);
    void monitorDraftSaveBatches(batches);
  } catch (error) {
    rows.forEach((row) => {
      if (row.draftSaveStatus === "queued") row.draftSaveStatus = "failed";
    });
    ElMessage.error(error?.message || "批量保存任务提交失败，请稍后重试");
  } finally {
    running.saveDrafts = false;
    running.saveDraftStage = "";
  }
}

function buildDraftSaveRequestChunks(rows = []) {
  const chunks = [];
  let current = { rows: [], items: [], bytes: 12 };
  for (const row of rows) {
    const item = buildListingDraftPayload(row);
    const itemBytes = new TextEncoder().encode(JSON.stringify(item)).length + 1;
    if (current.items.length && current.bytes + itemBytes > DRAFT_SAVE_REQUEST_TARGET_BYTES) {
      chunks.push(current);
      current = { rows: [], items: [], bytes: 12 };
    }
    current.rows.push(row);
    current.items.push(item);
    current.bytes += itemBytes;
  }
  if (current.items.length) chunks.push(current);
  return chunks;
}

async function monitorDraftSaveBatches(batches = []) {
  const activeBatches = batches.filter((batch) => batch.batchNo && batch.rows.length);
  if (!activeBatches.length) return;
  if (draftSaveBatchPollTimer) window.clearTimeout(draftSaveBatchPollTimer);
  const poll = async () => {
    try {
      const results = await Promise.all(activeBatches.map(async (entry) => ({
        entry,
        batch: await apiClient.get(`/api/ai-variant-draft-save/batches/${encodeURIComponent(entry.batchNo)}`, { noCache: true })
      })));
      let success = 0;
      let failed = 0;
      let total = 0;
      let allFinished = true;
      results.forEach(({ entry, batch }) => {
        success += Number(batch.success_count || 0);
        failed += Number(batch.failed_count || 0);
        total += Number(batch.total_count || entry.rows.length);
        if (!["completed", "partial", "failed"].includes(batch.status)) allFinished = false;
        (batch.items || []).forEach((item, index) => {
          const row = entry.rows[index];
          if (!row) return;
          row.draftSaveStatus = item.status === "completed" ? "saved" : item.status === "failed" ? "failed" : "saving";
          row.errorMessage = item.error_message || row.errorMessage || "";
          if (item.result_draft_id) row.listingDraftId = item.result_draft_id;
        });
      });
      const status = allFinished ? (failed ? (success ? "partial" : "failed") : "completed") : "running";
      Object.assign(draftSaveProgress, { status, total, success, failed });
      if (allFinished) {
        if (success) ElMessage.success(`后台已完成 ${success}/${total} 个草稿保存${failed ? `，${failed} 个失败` : ""}。`);
        if (failed) ElMessage.warning(`${failed} 个草稿保存失败，请查看对应行的失败原因后重试。`);
        return;
      }
    } catch {
      // The persisted batch remains recoverable; a later page refresh can resume viewing it.
    }
    draftSaveBatchPollTimer = window.setTimeout(poll, 3000);
  };
  await poll();
}

function isOfferIdConflictError(error) {
  return /offer[_\s-]*id|货号/i.test(error?.message || "") && /已存在|重复|exist|duplicate|used|not unique/i.test(error?.message || "");
}

async function saveRowToDraftWithOfferRetry(row) {
  try {
    return await apiClient.post("/api/listing/drafts/ai-variant-lightweight", buildListingDraftPayload(row));
  } catch (error) {
    if (!isOfferIdConflictError(error)) throw error;
    const previousOfferId = row.offerId || "";
    row.offerId = "";
    const generated = await generateOfferIds([row]);
    if (!generated) {
      row.offerId = previousOfferId;
      throw error;
    }
    return await apiClient.post("/api/listing/drafts/ai-variant-lightweight", buildListingDraftPayload(row));
  }
}

function buildListingDraftPayload(row) {
  const item = row.raw || {};
  const imageUrl = rowMainImageDraftUrl(row) || material.mainImageUrl || material.mainImageDataUrl;
  const detailImages = normalizeImageList(material.detailImages || []);
  const draftImages = uniqueList([imageUrl, ...detailImages].filter(Boolean));
  const target = row.target_variant_value || item.target_variant_value || "";
  const resultId = row.item_no || `${state.batchJob?.job_no || "ai-variant"}-${target}`;
  const title = rowTitleOutput(row);
  const tags = rowTagsOutput(row);
  const description = rowDescriptionOutput(row);
  const richContentJson = rowRichContentOutput(row);
  const videoUrls = rowVideoUrls(row);
  const videoCoverUrls = rowVideoCoverUrls(row);
  const offerId = String(row.offerId || "").trim();
  return {
    template_id: material.templateId,
    template_payload: material.templatePayload || null,
    source_draft_id: material.sourceDraftId || "",
    shop_ids: normalizeShopIds(material.sourceShopIds || []),
    product_name: title,
    offer_id: offerId,
    internal_code: offerId,
    source_images: draftImages,
    source_urls: "",
    spec: target,
    patch: {
      title,
      offer_id: offerId,
      description,
      tags,
      images: draftImages,
      video_cover_urls: videoCoverUrls,
      video_urls: videoUrls,
      rich_content_json: richContentJson
    },
    manual_facts: {
      ai_optimization_result_id: resultId,
      ai_variant_lab_job_no: state.batchJob?.job_no || "",
      ai_variant_lab_item_no: row.item_no || "",
      source_variant_value: sourceModel.value,
      target_variant_value: target,
      image_generation_status: row.status,
      image_generation_error: row.errorMessage || "",
      source_main_image_url: material.mainImageUrl || "",
      generated_main_image_url: rowMainImageDraftUrl(row) || "",
      source_product_id: material.sourceSku,
      source_product_title: material.sourceTitle,
      reused_detail_images_count: detailImages.length,
      generated_video_urls_count: videoUrls.length,
      generated_video_cover_urls_count: videoCoverUrls.length,
      reused_rich_content: Boolean(richContentJson)
    },
    ai_optimization: {
      result_id: resultId,
      source: "ai_variant_lab",
      job_no: state.batchJob?.job_no || "",
      target_variant_value: target,
      image_result: row.imageResult || {},
      draft_note: resultImageUrl(row) ? "使用 AI 裂变生成主图" : "主图生成未成功，草稿暂用母图，后续需重试主图"
    },
    changed_fields: ["offer_id", "title", "description", "tags", "images", "rich_content", "video_urls"]
  };
}

function replaceVariantText(value, target) {
  const source = sourceModel.value;
  let text = String(value || "").trim();
  if (!text) return "";
  if (source) text = text.replaceAll(source, target);
  return text;
}

function replaceSpecificVariantText(value, source, target) {
  let text = String(value || "").trim();
  const from = String(source || "").trim();
  const to = String(target || "").trim();
  if (!text || !from || !to || from === to) return text;
  return text.replaceAll(from, to);
}

function initialRowTitleText(item = {}, target = "") {
  const candidates = [
    item.title_ru,
    item.persisted?.title_ru,
    replaceVariantText(material.sourceTitle, target),
    `${target} ${material.productName}`.trim()
  ];
  return candidates.map((value) => normalizeDraftCopyText(value)).find((value) => isValidDraftTitle(value, target)) || `${target} ${safeProductNameForCopy()}`.trim();
}

function initialRowTagsText(item = {}, target = "") {
  if (Array.isArray(item.tags_ru) && item.tags_ru.length) return item.tags_ru.filter(isBuyerFacingCopyText).join(" ");
  const sourceTags = parseTagsForDraft(material.sourceTags).map((tag) => replaceVariantText(tag, target)).filter(isBuyerFacingCopyText);
  return uniqueList([...sourceTags, ...parseTagsForDraft(target)]).slice(0, 20).join(" ");
}

function initialRowDescriptionText(item = {}, target = "") {
  const candidates = [
    item.description_ru,
    item.persisted?.description_ru,
    replaceVariantText(material.sourceDescription, target)
  ];
  return candidates.map((value) => normalizeDraftDescription(value)).find((value) => isValidDraftDescription(value, target)) || buildFallbackDraftDescription(target);
}

function rowTitleOutput(row) {
  const item = row.raw || {};
  const target = row.target_variant_value || item.target_variant_value || "";
  const candidates = [
    row.titleText !== undefined ? renderManualCopyTemplate(row.titleText, target) : "",
    row.manualTitle ? renderManualCopyTemplate(row.manualTitle, target) : "",
    item.title_ru,
    item.persisted?.title_ru,
    replaceVariantText(material.sourceTitle, target),
    `${target} ${safeProductNameForCopy()}`.trim()
  ];
  return candidates.map((value) => normalizeDraftCopyText(value)).find((value) => isValidDraftTitle(value, target)) || `${target} ${safeProductNameForCopy()}`.trim();
}

function rowTagsOutput(row) {
  const item = row.raw || {};
  const target = row.target_variant_value || item.target_variant_value || "";
  if (row.tagsText !== undefined) return parseTagsForDraft(renderManualCopyTemplate(row.tagsText, target)).filter(isBuyerFacingCopyText).slice(0, 25);
  if (row.manualTags) return parseTagsForDraft(renderManualCopyTemplate(row.manualTags, target)).filter(isBuyerFacingCopyText).slice(0, 25);
  if (Array.isArray(item.tags_ru) && item.tags_ru.length) return item.tags_ru.filter(isBuyerFacingCopyText);
  const sourceTags = parseTagsForDraft(material.sourceTags).map((tag) => replaceVariantText(tag, target)).filter(isBuyerFacingCopyText);
  return uniqueList([...sourceTags, ...parseTagsForDraft(target)]).slice(0, 20);
}

function rowDescriptionOutput(row) {
  const item = row.raw || {};
  const target = row.target_variant_value || item.target_variant_value || "";
  const candidates = [
    row.descriptionText !== undefined ? renderManualCopyTemplate(row.descriptionText, target) : "",
    row.manualDescription ? renderManualCopyTemplate(row.manualDescription, target) : "",
    item.description_ru,
    item.persisted?.description_ru,
    replaceVariantText(material.sourceDescription, target)
  ];
  const valid = candidates.map((value) => normalizeDraftDescription(value)).find((value) => isValidDraftDescription(value, target));
  return valid || buildFallbackDraftDescription(target);
}

function rowRichContentOutput(row) {
  const mainImageUrl = rowMainImageDraftUrl(row);
  const assetJson = row.assets?.rich_content?.json || row.assets?.rich_content?.richContentJson || "";
  if (assetJson) return rewriteRichContentMainImage(assetJson, mainImageUrl);
  return mainImageUrl ? buildRowRichContentJson(row) : "";
}

function rewriteRichContentMainImage(value, imageUrl) {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  const nextImage = String(imageUrl || "").trim();
  if (!json || !nextImage) return json || "";
  try {
    const payload = JSON.parse(json);
    rewriteRichContentImageNode(payload, nextImage);
    return JSON.stringify(payload, null, 2);
  } catch {
    return json;
  }
}

function rewriteRichContentImageNode(value, imageUrl) {
  if (Array.isArray(value)) {
    value.forEach((item) => rewriteRichContentImageNode(item, imageUrl));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.img && typeof value.img === "object") {
    value.img.src = imageUrl;
    value.img.srcMobile = imageUrl;
  }
  Object.values(value).forEach((item) => rewriteRichContentImageNode(item, imageUrl));
}

function normalizeDraftDescription(value) {
  return normalizeDraftCopyText(value);
}

function normalizeDraftCopyText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hasUnknownFactText(value) {
  return UNKNOWN_FACT_RE.test(normalizeDraftCopyText(value));
}

function hasInternalCopyLeak(value) {
  return INTERNAL_COPY_LEAK_RE.test(normalizeDraftCopyText(value));
}

function isBuyerFacingCopyText(value) {
  const text = normalizeDraftCopyText(value);
  return Boolean(text && !hasUnknownFactText(text) && !hasInternalCopyLeak(text));
}

function isValidDraftTitle(value, target = "") {
  const text = normalizeDraftCopyText(value);
  if (!text || containsChinese(text) || !isBuyerFacingCopyText(text)) return false;
  if (hasSourceModelLeak(text, target)) return false;
  const targetText = String(target || "").trim().toLowerCase();
  return !targetText || text.toLowerCase().includes(targetText);
}

function isValidDraftDescription(value, target = "") {
  const text = normalizeDraftDescription(value);
  if (!text || containsChinese(text) || !isBuyerFacingCopyText(text)) return false;
  if (text.length < DESCRIPTION_MIN_LENGTH || text.length > DESCRIPTION_MAX_LENGTH) return false;
  const targetText = String(target || "").trim().toLowerCase();
  return !targetText || text.toLowerCase().includes(targetText);
}

function buildFallbackDraftDescription(target = "") {
  const model = String(target || "").trim() || "вашего автомобиля";
  const sourceText = [material.sourceTitle, material.productName, state.analysis?.product_subject_ru, state.analysis?.product_type].filter(Boolean).join(" ");
  const subject = /sill|threshold|порог|накладк|дверн/i.test(sourceText)
    ? "Защитные накладки на пороги автомобиля"
    : /подлокотник/i.test(sourceText)
      ? "Органайзер в подлокотник"
      : "Автомобильный аксессуар";
  const text = /порог|накладк/i.test(subject)
    ? `${subject} для ${model} предназначены для защиты дверных проемов и зоны посадки от царапин, потертостей и следов обуви. Аксессуар аккуратно дополняет интерьер автомобиля, помогает поддерживать чистоту в зоне порогов и не требует изменения штатных элементов. Накладки подходят для ежедневной эксплуатации, уменьшают следы повседневного износа и помогают сохранить ухоженный внешний вид салона.`
    : `${subject} для ${model} подходит для ежедневного использования в автомобиле и аккуратно дополняет салон. Аксессуар помогает поддерживать порядок, защищать поверхность от повседневного износа и сохранить опрятный внешний вид без сложной доработки. Описание не включает неподтвержденные размеры, сертификаты, гарантийные обещания или дополнительные совместимости.`;
  if (text.length <= DESCRIPTION_MAX_LENGTH) return text;
  return text.slice(0, DESCRIPTION_MAX_LENGTH - 3).replace(/\s+\S*$/, "").trimEnd() + "...";
}

function safeProductNameForCopy() {
  return isBuyerFacingCopyText(material.productName) ? material.productName : "Автомобильный аксессуар";
}

function rowVideoUrls(row) {
  const generatedVideo = row.imageResult?.generatedVideo || {};
  const assetUrl = row.assets?.video?.publishUrl || row.assets?.video?.url || row.assets?.video?.videoUrl
    || generatedVideo.publishUrl || generatedVideo.publish_url || generatedVideo.url || "";
  return uniqueList([assetUrl].filter(Boolean));
}

function rowVideoCoverUrls(row) {
  return rowVideoUrls(row);
}

function rowQualityIssues(row) {
  const issues = [];
  const target = String(row.target_variant_value || "").trim();
  const title = rowTitleOutput(row);
  const tags = rowTagsOutput(row);
  const description = rowDescriptionOutput(row);
  if (!title) issues.push("标题为空");
  if (containsChinese(title)) issues.push("标题包含中文");
  if (!isBuyerFacingCopyText(title)) issues.push("标题包含未识别占位词或内部规则话术");
  if (tags.length < 20) issues.push(`标签不足 20 个（当前 ${tags.length} 个）`);
  if (tags.length > 25) issues.push(`标签超过 25 个（当前 ${tags.length} 个）`);
  if (tags.some((tag) => containsChinese(tag))) issues.push("标签包含中文");
  if (tags.some((tag) => !isBuyerFacingCopyText(tag))) issues.push("标签包含未识别占位词或内部规则话术");
  if (tags.some((tag) => String(tag || "").length > 25)) issues.push("存在超过 25 字符的标签");
  if (tags.some((tag) => /\s/.test(String(tag || "")))) issues.push("标签包含空格，建议用下划线");
  if (description.length < DESCRIPTION_MIN_LENGTH) issues.push(`简介少于 ${DESCRIPTION_MIN_LENGTH} 字符（当前 ${description.length}）`);
  if (description.length > DESCRIPTION_MAX_LENGTH) issues.push(`简介超过 ${DESCRIPTION_MAX_LENGTH} 字符（当前 ${description.length}）`);
  if (containsChinese(description)) issues.push("简介包含中文");
  if (!isBuyerFacingCopyText(description)) issues.push("简介包含未识别占位词或内部规则话术");
  if (hasSourceModelLeak([title, tags.join(" "), description].join(" "), target, row)) issues.push("文案里残留源车型或其他车型");
  return uniqueList(issues);
}

function rowQualityState(row) {
  const issues = rowQualityIssues(row);
  if (!issues.length) return { type: "success", text: "通过", issues };
  const blocking = issues.some((issue) => /标签|简介|残留/.test(issue));
  return { type: blocking ? "warning" : "info", text: `${issues.length}项提示`, issues };
}

function containsChinese(value) {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

function hasSourceModelLeak(text, target, row = null) {
  const targetValue = String(target || "").trim().toLowerCase();
  const candidates = uniqueList([sourceModel.value, material.sourceVariantValue, ...sourceTitleVehicleAliases(material.sourceTitle, sourceModel.value || material.sourceVariantValue), ...(row?.raw?.case_template?.stale_values || []), ...parseTargets(material.targetInput)])
    .map((item) => String(item || "").trim())
    .filter((item) => item && item.toLowerCase() !== targetValue);
  return candidates.some((item) => item.length >= 3 && containsExactModelText(text, item));
}

function sourceTitleVehicleAliases(sourceTitle = "", sourceValue = "") {
  const title = String(sourceTitle || "").trim();
  const source = String(sourceValue || "").trim();
  if (!title || !source) return [];
  const escaped = source.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const match = title.match(new RegExp(`${escaped}((?:\\s*[/|]\\s*[A-Za-z0-9-]+(?:\\s+(?:Pro|Plus|Max))?)*)`, "iu"));
  return match?.[1] ? [...match[1].matchAll(/[/|]\s*([A-Za-z0-9-]+(?:\s+(?:Pro|Plus|Max))?)/giu)].map((item) => item[1].trim()) : [];
}

function containsExactModelText(text = "", model = "") {
  const escaped = String(model || "").trim().split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return Boolean(escaped && new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(String(text || "")));
}

function parseTagsForDraft(value) {
  return String(value || "")
    .split(/[,，、;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 25);
}

function shortList(list, limit = 6) {
  return Array.isArray(list) ? list.slice(0, limit) : [];
}

function chineseFacts(list) {
  const facts = shortList(list, 20).map((item) => {
    const text = String(item || "");
    if (/4|four|комплект/i.test(text)) return "保持 4 件套数量不变";
    if (/black|base|черн/i.test(text)) return "保持黑色底座和产品结构不变";
    if (/metal|stainless|brushed|нержав|steel/i.test(text)) return "保持不锈钢/金属拉丝质感不变";
    if (/TENET|T4|T5|T7|T8|model|logo|plate|авто/i.test(text)) return "车型、Logo、车牌和背景车属于可变内容";
    if (/sill|threshold|наклад/i.test(text) && !/not|isn't|не является|это не/i.test(text)) return "产品类型识别为汽车门槛条";
    return text;
  });
  const seen = new Set();
  return facts.filter((item) => {
    const key = String(item || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function normalizeRecognitionAnalysis(analysis = {}) {
  const buckets = classifyRecognitionFacts([
    ...toEditableLines(analysis.display_zh?.fixed_facts),
    ...toEditableLines(analysis.display_zh?.variable_facts),
    ...toEditableLines(analysis.display_zh?.forbidden_changes),
    ...toEditableLines(analysis.keep_facts),
    ...toEditableLines(analysis.changeable_facts),
    ...toEditableLines(analysis.forbidden_changes)
  ]);
  return {
    ...analysis,
    keep_facts: buckets.fixed,
    changeable_facts: buckets.variable,
    forbidden_changes: buckets.forbidden,
    display_zh: {
      ...(analysis.display_zh || {}),
      fixed_facts: buckets.fixed,
      variable_facts: buckets.variable,
      forbidden_changes: buckets.forbidden
    }
  };
}

function buildRecognitionBuckets(analysis = {}) {
  if (!analysis) return { fixed: [], variable: [], forbidden: [] };
  return {
    fixed: toEditableLines(analysis.display_zh?.fixed_facts || analysis.keep_facts),
    variable: toEditableLines(analysis.display_zh?.variable_facts || analysis.changeable_facts),
    forbidden: toEditableLines(analysis.display_zh?.forbidden_changes || analysis.forbidden_changes)
  };
}

function editableAnalysisForPlan() {
  if (!state.analysis) return undefined;
  const buckets = recognitionBuckets.value;
  return {
    ...state.analysis,
    keep_facts: buckets.fixed,
    changeable_facts: buckets.variable,
    forbidden_changes: buckets.forbidden,
    display_zh: {
      ...(state.analysis.display_zh || {}),
      fixed_facts: buckets.fixed,
      variable_facts: buckets.variable,
      forbidden_changes: buckets.forbidden
    }
  };
}

function buildOperatorRulePreview() {
  const backendRules = state.planRows[0]?.raw?.image_edit_contract?.operator_instructions;
  const backendRulesMatchCurrentNote = Boolean(
    backendRules?.source
    && normalizeOperatorNote(backendRules.source) === normalizeOperatorNote(material.operatorNote)
  );
  const rules = backendRulesMatchCurrentNote ? backendRules : parseOperatorRulePreview(material.operatorNote);
  const labels = {
    image_title: "主图车型标题 / 型号文字",
    product_identity: "产品车型 / 品牌标识",
    product_body: "产品主体",
    background: "背景与背景车辆",
    listing_title: "商品标题",
    tags: "商品标签",
    description: "商品描述",
    rich_content: "富文本"
  };
  const mapLabels = (values = []) => values.map((value) => labels[value] || value);
  return {
    source: rules.source || "",
    editable: mapLabels(rules.image_edit_scope),
    locked: mapLabels(rules.image_locked_scope),
    copy: mapLabels(rules.copy_generation_scope),
    resolvedByBackend: backendRulesMatchCurrentNote
  };
}

function applyOperatorRulePreset(preset) {
  if (preset.key === "brand_logo_only_vehicle_fission") material.variantGoal = preset.key;
  material.operatorNote = preset.note;
  reconcileRecognitionFactsWithOperatorRule();
}

function reconcileRecognitionFactsWithOperatorRule() {
  if (!state.analysis || !/Logo.{0,20}(?:不变|保持|保留|不改)|(?:不变|保持|保留|不改).{0,20}Logo|锁定整个产品本体/i.test(material.operatorNote)) return;
  const fixedLogoRule = "产品本体及其 Logo、品牌标识、车型字样、印刷文字和图案全部保持不变";
  const stripLogo = (value = "") => String(value || "")
    .replace(/(?:产品(?:本体|上的|表面)?的?)?(?:品牌\s*)?(?:Logo|LOGO|logo|标识|车标|品牌标识|车型字样|印刷文字|印字|图案)(?:\/品牌标识)?(?:\s*[“\"']?[^、,，；;]{0,20}[”\"']?)?[、,，和及与/]*/g, "")
    .replace(/^[、,，和及与/\s]+|[、,，和及与/\s]+$/g, "")
    .trim();
  const buckets = buildRecognitionBuckets(state.analysis);
  buckets.fixed = uniqueList([...buckets.fixed, fixedLogoRule]);
  buckets.variable = buckets.variable.map(stripLogo).filter((item) => item && !/^(?:属于|可以|允许|可|随|跟随|变化|替换|修改)/.test(item));
  updateRecognitionBucket("fixed", buckets.fixed);
  updateRecognitionBucket("variable", buckets.variable);
}

function parseOperatorRulePreview(value = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const editable = [];
  const locked = [];
  const copy = [];
  const add = (list, item) => { if (!list.includes(item)) list.push(item); };
  if (!text) return { image_edit_scope: [], image_locked_scope: [], copy_generation_scope: [], source: "" };
  if (/(?:主图.{0,12}(只|仅).{0,8}(改|换|替换)|(只|仅).{0,8}(改|换|替换).{0,8}主图).{0,8}(标题|型号文字|车型文字)/i.test(text)) {
    add(editable, "image_title");
    add(locked, "product_body");
    add(locked, "background");
  }
  if (/(背景|背景车辆|背景车型).{0,12}(允许|可以|随|跟随|改|换|变化)/i.test(text) || /(改变|修改|替换|调整).{0,8}(背景|背景车辆|背景车型)/i.test(text)) add(editable, "background");
  if (/(产品上的|产品).{0,8}(车型|品牌)?(标识|logo|Logo|LOGO|车标).{0,12}(允许|可以|随|跟随|改|换|变化)/i.test(text)) add(editable, "product_identity");
  if (/(商品|产品).{0,8}(标题).{0,8}(重新生成|重写|跟随|变化)/i.test(text) || /标题.{0,8}(重新生成|重写)/i.test(text)) add(copy, "listing_title");
  if (/标签.{0,8}(重新生成|重写|跟随|变化)/i.test(text)) add(copy, "tags");
  if (/(描述|简介).{0,8}(重新生成|重写|跟随|变化)/i.test(text)) add(copy, "description");
  if (/标题.{0,12}标签.{0,12}(描述|简介).{0,12}(重新生成|重写|跟随|变化|更新)/i.test(text)) {
    add(copy, "listing_title");
    add(copy, "tags");
    add(copy, "description");
  }
  if (/(产品主体|产品本体|实物主体|产品).{0,8}(不变|保持不变|不要改)/i.test(text)) add(locked, "product_body");
  if (/(产品上的|产品表面|产品).{0,12}(车型|品牌)?(标识|logo|Logo|LOGO|车标|车型字样|印刷文字|印字|图案).{0,12}(一律不变|不变|保持不变|不要改)/i.test(text)) add(locked, "product_identity");
  if (/锁定整个产品本体|产品全锁/i.test(text)) {
    add(locked, "product_body");
    add(locked, "product_identity");
  }
  if (/(背景|场景).{0,8}(不变|保持不变|不要改)/i.test(text)) add(locked, "background");
  if (editable.includes("background")) {
    const lockedBackgroundIndex = locked.indexOf("background");
    if (lockedBackgroundIndex >= 0) locked.splice(lockedBackgroundIndex, 1);
  }
  if (locked.includes("product_identity")) {
    const editableIdentityIndex = editable.indexOf("product_identity");
    if (editableIdentityIndex >= 0) editable.splice(editableIdentityIndex, 1);
  }
  const orderedCopy = ["listing_title", "tags", "description", "rich_content"].filter((field) => copy.includes(field));
  return { image_edit_scope: editable, image_locked_scope: locked, copy_generation_scope: orderedCopy, source: text };
}

function updateRecognitionBucket(key, value) {
  if (!state.analysis) return;
  const lines = toEditableLines(value);
  const display = { ...(state.analysis.display_zh || {}) };
  if (key === "fixed") {
    state.analysis.keep_facts = lines;
    display.fixed_facts = lines;
  } else if (key === "variable") {
    state.analysis.changeable_facts = lines;
    display.variable_facts = lines;
  } else if (key === "forbidden") {
    state.analysis.forbidden_changes = lines;
    display.forbidden_changes = lines;
  }
  state.analysis.display_zh = display;
}

function recognitionBucketText(key) {
  return recognitionBuckets.value[key].join("\n");
}

function toEditableLines(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/\n+/);
  return uniqueList(list.map((item) => String(item || "").replace(/^[-*•\s]+/, "").trim()).filter(Boolean)).slice(0, 20);
}

function classifyRecognitionFacts(items = []) {
  const buckets = { fixed: [], variable: [], forbidden: [] };
  for (const raw of toEditableLines(items)) {
    const text = normalizeRecognitionFactText(raw);
    if (isForbiddenRecognitionFact(text)) buckets.forbidden.push(text);
    else if (isVariableRecognitionFact(text)) buckets.variable.push(text);
    else buckets.fixed.push(text);
  }
  return {
    fixed: uniqueList(buckets.fixed).slice(0, 10),
    variable: uniqueList(buckets.variable).slice(0, 10),
    forbidden: uniqueList(buckets.forbidden).slice(0, 10)
  };
}

function normalizeRecognitionFactText(value = "") {
  const text = String(value || "").trim();
  if (/4|four|комплект/i.test(text)) return "保持 4 件套数量不变";
  if (/black|base|черн/i.test(text)) return "保持黑色底座和产品结构不变";
  if (/metal|stainless|brushed|нержав|steel/i.test(text)) return "保持不锈钢/金属拉丝质感不变";
  if (/sill|threshold|наклад/i.test(text) && !/not|isn't|не является|это не/i.test(text)) return "产品类型识别为汽车门槛条";
  if (/TENET|T4|T5|T7|T8|model|logo|plate|车牌|背景车|авто/i.test(text)) return "车型、Logo、车牌和背景车属于可变内容";
  return text;
}

function isVariableRecognitionFact(value = "") {
  return /车型|车牌|背景车|Logo|标识|车标|model|plate|badge|logo|background|TENET|T4|T5|T7|T8/i.test(value);
}

function isForbiddenRecognitionFact(value = "") {
  return /不得|不能|禁止|不要|不允许|不可|must not|do not|forbid/i.test(value)
    && !isVariableRecognitionFact(value);
}

function statusTagType(status) {
  if (status === "image_done") return "success";
  if (status === "failed") return "danger";
  if (status === "generating_image") return "warning";
  if (status === "queued_image") return "warning";
  if (status === "provider_pending") return "warning";
  return "info";
}

function moduleSteps(row) {
  const imageDone = Boolean(resultImageUrl(row));
  const imageQueued = row.status === "queued_image";
  const imageGenerating = row.status === "generating_image";
  const imageProviderPending = row.status === "provider_pending";
  const failed = row.status === "failed";
  const hasRich = Boolean(rowRichContentOutput(row));
  const hasVideo = rowVideoUrls(row).length > 0;
  const draftSaved = Boolean(row.listingDraftId);
  const draftSaving = row.draftSaveStatus === "saving";
  const copyState = rowCopyState(row);
  return [
    { key: "image", label: "主图", type: imageDone ? "success" : (imageQueued || imageGenerating || imageProviderPending ? "warning" : (failed ? "danger" : "info")), text: imageDone ? "已生成" : (imageQueued ? "排队中" : (imageProviderPending ? "服务商生成中，可继续拉回" : (imageGenerating ? "生成中" : (failed ? "失败" : "待生成")))) },
    { key: "title", label: "标题", type: rowTitleOutput(row) ? copyState.type : "info", text: rowTitleOutput(row) ? copyState.text : "待补充" },
    { key: "tags", label: "标签", type: rowTagsOutput(row).length ? copyState.type : "info", text: rowTagsOutput(row).length ? copyState.text : "待补充" },
    { key: "description", label: "描述", type: rowDescriptionOutput(row) ? copyState.type : "info", text: rowDescriptionOutput(row) ? copyState.text : "待补充" },
    { key: "rich", label: "富文本", type: hasRich ? "success" : "info", text: hasRich ? "已准备" : "待生成" },
    { key: "media", label: "详情/视频", type: material.detailImages.length || hasVideo ? "success" : "info", text: `${material.detailImages.length}图/${rowVideoUrls(row).length}视频` },
    { key: "draft", label: "草稿", type: draftSaved ? "success" : (draftSaving ? "warning" : (row.draftSaveStatus === "failed" ? "danger" : "info")), text: draftSaved ? "已保存" : (draftSaving ? "保存中" : (row.draftSaveStatus === "failed" ? "失败" : "未保存")) }
  ];
}

function rowCopyState(row) {
  if (rowCopyEdited(row)) return { type: "success", text: "手动覆盖" };
  const source = String(row.raw?.copy_source || row.raw?.copy_contract?.product_fact_guard?.applied ? "compiled_product_dna" : "").trim();
  if (source === "compiled_product_dna") return { type: "warning", text: "事实重写" };
  return { type: "success", text: "AI计划" };
}

function rowCopyEdited(row) {
  return normalizeEditableCopy(row.titleText) !== normalizeEditableCopy(row.originalTitleText)
    || normalizeEditableCopy(row.tagsText) !== normalizeEditableCopy(row.originalTagsText)
    || normalizeEditableCopy(row.descriptionText) !== normalizeEditableCopy(row.originalDescriptionText)
    || Boolean(row.manualTitle || row.manualTags || row.manualDescription);
}

function normalizeEditableCopy(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function statusText(status) {
  return { planned: "待生成", queued_image: "排队中", generating_image: "生成中", image_done: "已完成", failed: "失败" }[status] || "待生成";
}

function rowStatusText(row) {
  if (row?.status === "failed" && /超时|timeout|aborted/i.test(row.errorMessage || "")) return "超时失败";
  return statusText(row?.status);
}

function formatDurationText(seconds = 0) {
  const total = Math.max(0, Math.ceil(Number(seconds || 0)));
  if (!total) return "0 分钟";
  const minutes = Math.ceil(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function firstGeneratedImage(result = {}) {
  const images = [
    ...(Array.isArray(result.croppedImages) ? result.croppedImages : []),
    ...(Array.isArray(result.generatedImages) ? result.generatedImages : [])
  ];
  return images.find((item) => item?.url) || null;
}

function resultImageUrl(row) {
  return firstGeneratedImage(row.imageResult)?.url || "";
}

function rowMainImageDraftUrl(row) {
  const asset = row.assets?.main_image || {};
  return asset.publishUrl || asset.url || asset.localUrl || asset.downloadUrl || resultImageUrl(row) || "";
}

function rowVideoUsesCurrentMainImage(row) {
  const asset = row.assets?.video || {};
  const sourceImageUrl = String(asset.sourceImageUrl || asset.source_image_url || row.imageResult?.generatedVideo?.sourceImageUrl || "").trim();
  const currentMainImageUrl = String(rowMainImageDraftUrl(row) || "").trim();
  return Boolean(sourceImageUrl && currentMainImageUrl && sourceImageUrl === currentMainImageUrl);
}

function mainImageAssetMatches(row, imageUrl) {
  const asset = row.assets?.main_image || {};
  const candidates = [
    asset.originalAiFileUrl,
    asset.url,
    asset.publishUrl,
    asset.localUrl,
    asset.downloadUrl
  ].map((item) => String(item || "").trim()).filter(Boolean);
  return candidates.includes(String(imageUrl || "").trim());
}

function resultDownloadUrl(row) {
  return row.imageResult?.zipUrl || resultImageUrl(row) || "";
}

function rowResultId(row) {
  const target = row.target_variant_value || row.raw?.target_variant_value || "";
  return row.item_no || `${state.batchJob?.job_no || "ai-variant"}-${target}`;
}

function rowImageActionKey(row) {
  return rowResultId(row);
}

function isRowImageQueueing(row) {
  return Boolean(rowImageQueueing[rowImageActionKey(row)]);
}

function isRowImageUploading(row) {
  return Boolean(rowImageUploading[rowImageActionKey(row)]);
}

function isRowImageBusy(row) {
  return isRowImageQueueing(row) || row.status === "queued_image" || row.status === "generating_image";
}

function lightRowSnapshot(row) {
  return {
    item_no: row.item_no || "",
    target_variant_value: row.target_variant_value || "",
    status: row.status || "",
    title: rowTitleOutput(row),
    tags: rowTagsOutput(row),
    description: rowDescriptionOutput(row),
    source_main_image_url: material.mainImageUrl || "",
    generated_main_image_url: rowMainImageDraftUrl(row) || "",
    generated_main_image_original_url: resultImageUrl(row) || ""
  };
}

function promptSnapshot(row) {
  return {
    source_variant_value: sourceModel.value,
    target_variant_value: row.target_variant_value || "",
    main_image_plan: row.mainImagePlan || "",
    title_plan: row.titlePlan || "",
    tags_plan: row.tagsPlan || "",
    description_plan: row.descriptionPlan || "",
    rich_content_plan: row.richTextPlan || ""
  };
}

async function saveRowAsset(row, fieldKey, asset, fieldStatus = "generated") {
  if (!row || !fieldKey) return null;
  const result = await apiClient.post("/api/listing/ai-variant-assets", {
    source_module: "ai_variant_lab",
    workbench_id: state.batchJob?.job_no || "ai-variant-lab",
    source_batch_id: state.batchJob?.job_no || "",
    result_id: rowResultId(row),
    source_product_id: material.sourceSku || "",
    product_name: rowTitleOutput(row),
    variant_target: row.target_variant_value || "",
    listing_draft_id: row.listingDraftId || 0,
    listing_template_id: material.templateId || 0,
    field_key: fieldKey,
    field_status: fieldStatus,
    asset,
    prompt_snapshot: promptSnapshot(row),
    row_snapshot: lightRowSnapshot(row),
    error_message: row.errorMessage || ""
  });
  row.assets = { ...(row.assets || {}), [fieldKey]: result?.asset || asset };
  return result;
}

async function persistGeneratedRowAssets(row) {
  if (!row || !resultImageUrl(row)) return;
  const imageUrl = resultImageUrl(row);
  if (!mainImageAssetMatches(row, imageUrl)) {
    await saveRowAsset(row, "main_image", {
      url: imageUrl,
      downloadUrl: resultDownloadUrl(row),
      originalAiFileUrl: imageUrl,
      sourceImageUrl: material.mainImageUrl || material.mainImageDataUrl || "",
      imageResult: row.imageResult || {}
    }, "generated");
  }
  await Promise.all([
    !row.assets?.title?.text ? saveRowAsset(row, "title", { text: rowTitleOutput(row) }, "planned") : null,
    !row.assets?.tags?.tags?.length ? saveRowAsset(row, "tags", { tags: rowTagsOutput(row) }, "planned") : null,
    !row.assets?.description?.text ? saveRowAsset(row, "description", { text: rowDescriptionOutput(row) }, "planned") : null
  ]);
}

function buildRowRichContentJson(row) {
  const imageUrl = rowMainImageDraftUrl(row);
  const text = rowDescriptionOutput(row);
  if (!imageUrl || !text) return "";
  return JSON.stringify({
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
              alt: rowTitleOutput(row),
              position: "width_full",
              positionMobile: "width_full",
              widthMobile: 1024,
              heightMobile: 1536
            },
            title: {
              items: [{ type: "text", content: rowTitleOutput(row) }],
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
  }, null, 2);
}

async function generateRowRichContent(row, options = {}) {
  await persistGeneratedRowAssets(row);
  const json = buildRowRichContentJson(row);
  if (!json) {
    if (!options.silent) ElMessage.warning("请先生成主图，并确认标题和描述不为空。");
    return;
  }
  row.richContentStatus = "saving";
  try {
    await saveRowAsset(row, "rich_content", { json, sourceImageUrl: rowMainImageDraftUrl(row) }, "generated");
    row.richContentStatus = "done";
    if (!options.silent) ElMessage.success("富文本已生成并记录。");
  } catch (error) {
    row.richContentStatus = "failed";
    row.errorMessage = error.message || row.errorMessage || "富文本保存失败";
    if (!options.silent) ElMessage.error(row.errorMessage);
  }
}

async function generateRowVideo(row, options = {}) {
  await persistGeneratedRowAssets(row);
  const imageUrl = rowMainImageDraftUrl(row);
  if (!imageUrl) {
    if (!options.silent) ElMessage.warning("请先生成主图，再生成视频。");
    return;
  }
  const key = rowResultId(row);
  if (rowVideoTasks.has(key)) return rowVideoTasks.get(key);
  const task = (async () => {
    running.rowVideo = key;
    row.videoStatus = "generating";
    try {
      const result = await generateAiVideo({
        imageUrl,
        sourceId: key,
        title: rowTitleOutput(row)
      }, { sourceModule: "ai_variant_lab_video", listingVariantMedia: true });
      const videoUrl = result.video?.publishUrl || result.video?.publish_url || "";
      if (!videoUrl) throw new Error("视频服务未返回公网物料地址");
      const asset = {
        url: videoUrl,
        publishUrl: videoUrl,
        sourceImageUrl: imageUrl,
        video: result.video || null,
        cover: result.cover || null
      };
      await saveRowAsset(row, "video", asset, "generated");
      row.videoStatus = "done";
      if (!options.silent) ElMessage.success("视频已生成并记录。");
    } catch (error) {
      row.videoStatus = "failed";
      row.errorMessage = error.message || row.errorMessage || "视频生成失败";
      if (!options.silent) ElMessage.error(row.errorMessage);
      if (options.throwOnError) throw error;
    } finally {
      if (running.rowVideo === key) running.rowVideo = "";
    }
  })();
  rowVideoTasks.set(key, task);
  try {
    return await task;
  } finally {
    rowVideoTasks.delete(key);
  }
}

async function prepareGeneratedRowForDraft(row, options = {}) {
  if (!row || !resultImageUrl(row)) return;
  const key = rowResultId(row);
  if (rowPreparationTasks.has(key)) return rowPreparationTasks.get(key);
  const task = (async () => {
    await persistGeneratedRowAssets(row);
    if (!row.assets?.rich_content?.json && !row.assets?.rich_content?.richContentJson) {
      await generateRowRichContent(row, options);
    }
    if (options.generateVideo !== false && (!rowVideoUrls(row).length || !rowVideoUsesCurrentMainImage(row))) {
      await generateRowVideo(row, options);
    }
  })();
  rowPreparationTasks.set(key, task);
  try {
    return await task;
  } finally {
    rowPreparationTasks.delete(key);
  }
}

async function prepareGeneratedRowsForDraft(rows = [], options = {}) {
  await Promise.all(rows.map((row) => queueGeneratedRowPreparation(row, options)));
}

function queueGeneratedRowPreparation(row, options = {}) {
  if (!row || !resultImageUrl(row)) return Promise.resolve();
  const key = rowResultId(row);
  const imageSignature = resultImageUrl(row);
  if (preparedRowImageSignatures.get(key) === imageSignature) return Promise.resolve();
  const pending = queuedRowPreparationTasks.get(key);
  if (pending) return pending;
  let resolveTask;
  let rejectTask;
  const task = new Promise((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });
  queuedRowPreparationTasks.set(key, task);
  rowPreparationQueue.push({ row, options, resolveTask, rejectTask, key });
  void drainGeneratedRowPreparationQueue();
  void task.finally(() => queuedRowPreparationTasks.delete(key)).catch(() => {});
  void task.then(() => preparedRowImageSignatures.set(key, imageSignature)).catch(() => {});
  return task;
}

async function drainGeneratedRowPreparationQueue() {
  while (activeBackgroundDraftPreparations < BACKGROUND_DRAFT_PREPARATION_CONCURRENCY && rowPreparationQueue.length) {
    const next = rowPreparationQueue.shift();
    activeBackgroundDraftPreparations += 1;
    void prepareGeneratedRowForDraft(next.row, next.options)
      .then(next.resolveTask, next.rejectTask)
      .finally(() => {
        activeBackgroundDraftPreparations -= 1;
        void drainGeneratedRowPreparationQueue();
      });
  }
}

async function ensureGeneratedRowVideos(rows = [], options = {}) {
  await runWithConcurrency(rows, BROWSER_VIDEO_CONCURRENCY, async (row) => {
    if (!row || !resultImageUrl(row)) return;
    if (!rowVideoUrls(row).length || !rowVideoUsesCurrentMainImage(row)) {
      await generateRowVideo(row, { ...options, throwOnError: true });
    }
    if (!rowVideoUrls(row).length || !rowVideoUsesCurrentMainImage(row)) {
      throw new Error(`${row.target_variant_value || "当前车型"} 的视频生成未完成，已停止保存草稿。请查看该行失败原因后重试。`);
    }
  });
}

async function runWithConcurrency(items = [], concurrency = 2, worker) {
  const queue = [...items];
  const workerCount = Math.min(Math.max(1, concurrency), queue.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item) await worker(item);
    }
  }));
}

async function regenerateRowMainImage(row) {
  if (!state.batchJob?.job_no) return;
  const key = rowImageActionKey(row);
  rowImageQueueing[key] = true;
  try {
    row.assets = { ...(row.assets || {}) };
    delete row.assets.main_image;
    delete row.assets.video;
    delete row.assets.rich_content;
    row.videoStatus = "pending";
    row.richContentStatus = "pending";
    row.regenerateDownstream = true;
    const result = await apiClient.post("/api/ai-variant-lab/batch-run-images", {
      jobNo: state.batchJob.job_no,
      ...sourceImagePayload(),
      execute: true,
      force: true,
      itemNos: [row.item_no || row.target_variant_value],
      itemOverrides: copyOverridesForRun([row]),
      limit: state.planRows.length || 20,
      ratio: "3:4",
      imageConcurrency: backendImageConcurrency.value
    });
    row.status = "queued_image";
    row.imageResult = {};
    row.errorMessage = "";
    startGenerationPolling();
    if (result.background || result.queued) {
      ElMessage.success("已加入主图生成队列，可继续提交其它行。");
    } else if (row.status === "failed") {
      ElMessage.error(row.errorMessage || "主图重新生成失败");
    } else {
      await prepareGeneratedRowForDraft(row, { silent: true, generateVideo: true });
      row.regenerateDownstream = false;
      ElMessage.success("主图、视频、视频封面和富文本已重新生成。");
    }
  } catch (error) {
    row.errorMessage = error.message || row.errorMessage || "主图重新生成失败";
    ElMessage.error(row.errorMessage);
  } finally {
    delete rowImageQueueing[key];
  }
}

function uploadRowMainImageRequest(row) {
  return async (options) => {
    if (!state.batchJob?.job_no || !row?.item_no) {
      const error = new Error("请先生成批量计划，再上传本行主图。");
      options.onError?.(error);
      ElMessage.warning(error.message);
      return;
    }
    const key = rowImageActionKey(row);
    rowImageUploading[key] = true;
    try {
      const uploaded = await uploadListingMedia(options.file, {
        source_module: "ai_variant_lab",
        role: "manual_main_image",
        workbench_id: state.batchJob.job_no,
        result_id: key
      });
      const media = uploaded.asset || uploaded.media || uploaded.file || uploaded;
      const imageUrl = media.publishUrl || media.publish_url || media.url || media.previewUrl || uploaded.url || "";
      if (!imageUrl) throw new Error("上传成功，但未返回可用于草稿的图片地址。");
      const previewUrl = media.previewUrl || media.preview_url || imageUrl;
      const name = media.name || media.fileName || options.file?.name || "manual-main-image";
      const persisted = await apiClient.post("/api/ai-variant-lab/batch-items/manual-image", {
        jobNo: state.batchJob.job_no,
        itemNo: row.item_no,
        url: imageUrl,
        publishUrl: imageUrl,
        previewUrl,
        name
      });
      row.status = "image_done";
      row.errorMessage = "";
      row.imageResult = persisted.image_result || {
        manual_upload: true,
        generatedImages: [{ url: imageUrl, publishUrl: imageUrl, previewUrl, name, source: "manual_upload" }]
      };
      await saveRowAsset(row, "main_image", {
        url: imageUrl,
        publishUrl: imageUrl,
        previewUrl,
        downloadUrl: imageUrl,
        originalAiFileUrl: imageUrl,
        sourceImageUrl: material.mainImageUrl || material.mainImageDataUrl || "",
        imageResult: row.imageResult,
        manualUpload: true
      }, "manual");
      await loadBatchJobDetail(state.batchJob.job_no, { silent: true });
      options.onSuccess?.(persisted);
      ElMessage.success("已上传并设为本行主图。");
    } catch (error) {
      row.errorMessage = error.message || row.errorMessage || "主图上传失败";
      options.onError?.(error);
      ElMessage.error(row.errorMessage);
    } finally {
      delete rowImageUploading[key];
    }
  };
}
</script>

<template>
  <div class="ai-lab-page">
    <header class="lab-header">
      <div>
        <h1>AI裂变</h1>
        <p>测试页：验证从一个母 SKU 到多个目标车型的半自动闭环，稳定后再接入正式 AI 裂变。</p>
      </div>
      <div class="header-tools">
        <el-button :icon="Collection" @click="openHistory">裂变记录</el-button>
        <div class="header-stats">
          <div><span>目标车型</span><strong>{{ targetModels.length }}</strong></div>
          <div><span>已选任务</span><strong>{{ selectedCount }}</strong></div>
          <div><span>文案成本</span><strong>¥{{ textCost.toFixed(4) }}</strong><small>不含图片请求</small></div>
        </div>
      </div>
    </header>

        <section class="workflow-card">
          <el-steps :active="stepIndex(currentStep)" finish-status="success" align-center>
            <el-step v-for="step in workflowSteps" :key="step.key" :title="step.title" :description="step.desc" @click="goStep(step.key)" />
          </el-steps>
        </section>

    <el-dialog
      v-model="history.visible"
      title="AI 裂变记录"
      width="min(1040px, calc(100vw - 32px))"
      class="variant-history-dialog"
      append-to-body
      destroy-on-close
    >
      <el-table v-loading="history.loading" :data="history.jobs" row-key="job_no" max-height="560" empty-text="暂无裂变记录">
        <el-table-column label="更新时间" width="176">
          <template #default="{ row }">{{ shanghaiDateTimeText(row.updated_at, { assumeUtcWhenNaive: true }) }}</template>
        </el-table-column>
        <el-table-column label="操作人员" width="120" show-overflow-tooltip>
          <template #default="{ row }">{{ historyPersonText(row) }}</template>
        </el-table-column>
        <el-table-column label="母商品" min-width="190" show-overflow-tooltip>
          <template #default="{ row }">{{ historyProductText(row) }}</template>
        </el-table-column>
        <el-table-column prop="source_variant_value" label="源车型" width="130" show-overflow-tooltip />
        <el-table-column prop="target_count" label="目标数" width="80" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }"><el-tag :type="historyStatusType(row.status)" effect="light">{{ historyStatusText(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :loading="history.restoring === row.job_no" @click="restoreHistoryJob(row)">恢复</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

        <section v-show="currentStep === 'material'" class="step-panel">
          <div class="step-heading">
            <span class="step-index">1</span>
            <div>
              <h2>导入母素材</h2>
              <p>从草稿箱选择需要裂变的母商品素材。</p>
            </div>
            <el-button type="primary" :disabled="!canAnalyze" :loading="running.analyze" :icon="Camera" @click="analyzeVariantImage">识别产品</el-button>
          </div>

          <div class="material-layout">
            <div class="import-panel">
              <div class="import-actions">
                <el-button type="primary" :icon="DocumentChecked" @click="openImportDialog('draft')">从草稿箱导入</el-button>
              </div>
              <div class="material-card" :class="{ empty: !material.productName }">
                <img v-if="material.mainImageDataUrl || material.mainImageUrl" :src="material.mainImageDataUrl || material.mainImageUrl" alt="母图">
                <div v-else class="image-placeholder"><el-icon><Picture /></el-icon><span>待导入主图</span></div>
                <div class="material-meta">
                  <strong>{{ material.productName || "未选择商品素材" }}</strong>
                  <span>{{ material.sourceSku || "导入后展示 SKU / 草稿 / 采集记录编号" }}</span>
                  <em>{{ material.sourceTitle || "导入后带入标题、标签、描述等基础信息" }}</em>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section v-show="currentStep === 'recognize'" class="step-panel">
          <div class="step-heading">
            <span class="step-index">2</span>
            <div>
              <h2>产品识别结果</h2>
              <p>主界面只展示中文判断；底层俄语/英文提示词作为技术详情保留。</p>
            </div>
            <el-button type="primary" :loading="running.batchPlan" :disabled="!canPlan" :icon="DocumentChecked" @click="createBatchPlan">
              AI 生成{{ targetModels.length ? ` ${targetModels.length} 个车型` : "" }}批量计划
            </el-button>
          </div>

          <div v-if="state.analysis" class="recognition-facts-grid">
            <section>
              <div class="fact-heading"><h3>固定不变</h3><el-button link type="primary" size="small" @click="recognitionEditing.fixed = !recognitionEditing.fixed">{{ recognitionEditing.fixed ? "收起" : "编辑" }}</el-button></div>
              <div v-if="!recognitionEditing.fixed" class="fact-summary">
                <el-tag v-for="item in recognitionSummary('fixed')" :key="item" size="small" effect="plain">{{ item }}</el-tag>
                <span v-if="!recognitionSummary('fixed').length">暂无固定事实</span>
              </div>
              <el-input
                v-else
                :model-value="recognitionBucketText('fixed')"
                type="textarea"
                :rows="6"
                placeholder="产品主体、材质、颜色、数量、结构、用途等不能被裂变改变的事实"
                @update:model-value="(value) => updateRecognitionBucket('fixed', value)"
              />
            </section>
            <section>
              <div class="fact-heading"><h3>允许变化</h3><el-button link type="primary" size="small" @click="recognitionEditing.variable = !recognitionEditing.variable">{{ recognitionEditing.variable ? "收起" : "编辑" }}</el-button></div>
              <div v-if="!recognitionEditing.variable" class="fact-summary variable">
                <el-tag v-for="item in recognitionSummary('variable')" :key="item" size="small" type="primary" effect="plain">{{ item }}</el-tag>
                <span v-if="!recognitionSummary('variable').length">暂无可变事实</span>
              </div>
              <el-input
                v-else
                :model-value="recognitionBucketText('variable')"
                type="textarea"
                :rows="6"
                placeholder="车型、Logo、车牌、背景车型、可替换文字等裂变变量"
                @update:model-value="(value) => updateRecognitionBucket('variable', value)"
              />
            </section>
            <section>
              <div class="fact-heading"><h3>禁止变化</h3><el-button link type="primary" size="small" @click="recognitionEditing.forbidden = !recognitionEditing.forbidden">{{ recognitionEditing.forbidden ? "收起" : "编辑" }}</el-button></div>
              <div v-if="!recognitionEditing.forbidden" class="fact-summary forbidden">
                <el-tag v-for="item in recognitionSummary('forbidden')" :key="item" size="small" type="danger" effect="plain">{{ item }}</el-tag>
                <span v-if="!recognitionSummary('forbidden').length">暂无禁止规则</span>
              </div>
              <el-input
                v-else
                :model-value="recognitionBucketText('forbidden')"
                type="textarea"
                :rows="6"
                placeholder="绝对不能改变的规则，例如不能改变产品类型、材质、数量、结构"
                @update:model-value="(value) => updateRecognitionBucket('forbidden', value)"
              />
            </section>
          </div>
          <el-empty v-else description="请先导入素材并点击识别产品" :image-size="90" />

          <section v-if="state.analysis" class="variant-rule-workspace">
              <div class="variant-rule-toolbar">
                <div><strong>裂变规则</strong><span>选择一个预设，系统会自动生成图片与文案约束。</span></div>
                <el-checkbox v-model="material.useAiPlan">AI 精修计划</el-checkbox>
              </div>
              <div class="rule-preset-actions segmented">
                <el-tooltip v-for="preset in operatorRulePresets" :key="preset.key" :content="preset.hint" placement="top" :show-after="250">
                <button type="button" :class="{ active: activeOperatorRulePresetKey === preset.key }" @click="applyOperatorRulePreset(preset)"><strong>{{ preset.label }}</strong><span>{{ preset.key === 'vehicle_full' ? '品牌与型号都变' : preset.key === 'vehicle_same_brand' ? '产品全锁，只换标题与背景车' : preset.key === 'brand_logo_only_vehicle_fission' ? '只写品牌文字，型号不上产品' : '产品与背景不变' }}</span></button>
                </el-tooltip>
              </div>
              <div class="rule-preview-heading">
                <strong>最终规则</strong>
                <el-tag size="small" effect="plain" :type="operatorRulePreview.resolvedByBackend ? 'success' : 'info'">{{ operatorRulePreview.resolvedByBackend ? "后端最终规则" : "根据人工备注预览" }}</el-tag>
              </div>
              <p v-if="!operatorRulePreview.source">选择裂变规则后，这里会显示最终变化范围。</p>
              <div v-else class="rule-preview-grid">
                <div><span>主图允许变化</span><strong>{{ operatorRulePreview.editable.join("、") || "沿用车型裂变默认规则" }}</strong></div>
                <div><span>主图保持不变</span><strong>{{ operatorRulePreview.locked.join("、") || "未增加人工锁定" }}</strong></div>
                <div><span>重新生成商品文案</span><strong>{{ operatorRulePreview.copy.join("、") || "沿用默认文案规则" }}</strong></div>
              </div>
              <details class="special-rule-details">
                <summary>补充特殊要求</summary>
                <el-input v-model="material.operatorNote" type="textarea" :rows="3" placeholder="预设规则会自动生成；只在本次有额外要求时继续补充。" />
              </details>
          </section>

          <section v-if="state.analysis" class="vehicle-target-picker" v-loading="vehicleCatalog.loading">
            <div class="vehicle-picker-heading">
              <div><strong>目标车型</strong><span>先筛选车型范围，再按品牌或具体型号加入任务。{{ sourceModel ? `母车型：${sourceModel}（不重复生成）` : "" }}</span></div>
              <div class="vehicle-heading-actions"><span>已选 {{ targetModels.length }} 个</span><el-button :icon="Plus" size="small" @click="openAddVehicleCatalog">新增车型</el-button></div>
            </div>
            <div class="vehicle-tag-toolbar">
              <button v-for="tag in vehicleCatalog.tags" :key="tag.key" type="button" :class="{ active: vehicleCatalog.activeTags.includes(tag.key) }" @click="toggleVehicleTag(tag.key)">{{ tag.label }}</button>
              <button v-if="vehicleCatalog.activeTags.length" type="button" class="clear-filter" @click="vehicleCatalog.activeTags = []">清除筛选</button>
            </div>
            <div class="vehicle-picker-grid">
              <div class="vehicle-brand-column">
                <div class="column-heading"><strong>汽车品牌</strong><span>{{ filteredVehicleBrands.length }}</span></div>
                <button v-for="brand in filteredVehicleBrands" :key="brand.name" type="button" :class="{ active: activeVehicleBrand?.name === brand.name }" @click="vehicleCatalog.activeBrand = brand.name"><span>{{ brand.name }}</span><em>{{ brand.models.length }}</em></button>
              </div>
              <div class="vehicle-model-column">
                <div class="column-heading">
                  <strong>{{ activeVehicleBrand?.name || "具体型号" }}</strong>
                  <el-button v-if="activeVehicleBrand" size="small" type="primary" plain @click="addActiveBrandModels">加入当前品牌全部型号</el-button>
                </div>
                <div class="vehicle-model-options">
                  <el-checkbox v-for="model in activeVehicleBrand?.models || []" :key="model.id" :disabled="isSourceVehicleModel(model.fullName)" :model-value="targetIsSelected(model.fullName)" @change="toggleVehicleModel(model)">
                    <span>{{ model.label || model.name }}<em v-if="isSourceVehicleModel(model.fullName)">母车型</em></span><small>{{ isSourceVehicleModel(model.fullName) ? "当前母车型，不重复生成" : [model.priority, model.ozonCompetition ? `Ozon竞争：${model.ozonCompetition}` : "", ...model.tags.map((tag) => vehicleCatalog.tags.find((item) => item.key === tag)?.label)].filter(Boolean).join(" · ") }}</small>
                  </el-checkbox>
                </div>
              </div>
            </div>
            <div class="selected-targets-bar">
              <div class="selected-targets-heading"><strong>已选目标</strong><div><el-button v-if="targetModels.length" link type="danger" size="small" @click="setTargetModels([])">清空</el-button><el-button link type="primary" size="small" @click="manualTargetExpanded = !manualTargetExpanded">{{ manualTargetExpanded ? "收起手工输入" : "手工补充" }}</el-button></div></div>
              <div class="selected-target-chips">
                <el-tag v-for="target in targetModels" :key="target" closable effect="plain" @close="removeTargetModel(target)">{{ target }}</el-tag>
                <span v-if="!targetModels.length">还没有选择目标车型</span>
              </div>
              <el-input v-if="manualTargetExpanded" v-model="material.targetInput" type="textarea" :rows="3" placeholder="一行一个完整车型，例如 HAVAL Jolion、TENET T7。" />
            </div>
          </section>
        </section>

        <section v-show="currentStep === 'plan'" class="step-panel">
          <div class="step-heading">
            <span class="step-index">3</span>
            <div><h2>计划确认表</h2><p>默认全选。每行都可以人工改主图计划、标题、标签和描述，确认后再进入生成队列。</p></div>
            <div class="step-actions">
              <el-button @click="toggleAllPlanRows(true)">全选</el-button>
              <el-button @click="toggleAllPlanRows(false)">全不选</el-button>
              <el-button :loading="running.offerIds" @click="generateOfferIds()">一键生成货号</el-button>
              <el-button type="primary" :disabled="operatorRulesNeedReplan" @click="goStep('generate')">进入生成</el-button>
            </div>
          </div>

          <el-alert
            v-if="operatorRulesNeedReplan"
            title="人工备注已变化，请返回识别产品步骤重新生成批量计划"
            description="当前计划仍使用修改前的图片与文案契约，为避免旧规则进入生图队列，预检和生成已暂停。"
            type="warning"
            show-icon
            :closable="false"
            class="rule-replan-alert"
          />

          <el-table ref="planTableRef" :data="state.planRows" border class="plan-table" row-key="item_no" height="560" @selection-change="onPlanSelectionChange">
            <el-table-column type="selection" width="46" fixed="left" />
            <el-table-column label="目标车型" width="170" fixed="left"><template #default="{ row }"><el-input v-model="row.target_variant_value" size="small" @change="syncRowTarget(row)" /></template></el-table-column>
            <el-table-column label="货号 / offer_id" width="230"><template #default="{ row }"><el-input v-model="row.offerId" size="small" placeholder="点击一键生成，可手动修改" /></template></el-table-column>
            <el-table-column label="主图计划" min-width="260"><template #default="{ row }"><el-input v-model="row.mainImagePlan" type="textarea" :rows="3" /></template></el-table-column>
            <el-table-column label="标题计划" min-width="240"><template #default="{ row }"><el-input v-model="row.titlePlan" type="textarea" :rows="3" /></template></el-table-column>
            <el-table-column label="标签计划" min-width="220"><template #default="{ row }"><el-input v-model="row.tagsPlan" type="textarea" :rows="3" /></template></el-table-column>
            <el-table-column label="描述计划" min-width="260"><template #default="{ row }"><el-input v-model="row.descriptionPlan" type="textarea" :rows="3" /></template></el-table-column>
            <el-table-column label="状态" width="100" align="center"><template #default="{ row }"><el-tag :type="statusTagType(row.status)" effect="light">{{ statusText(row.status) }}</el-tag></template></el-table-column>
            <el-table-column label="操作" width="150" fixed="right"><template #default="{ row }"><div class="inline-actions"><el-button size="small" type="danger" plain @click="deletePlanRow(row)">删除</el-button><el-popover width="520" trigger="click"><pre>{{ row.raw }}</pre><template #reference><el-button size="small">查看</el-button></template></el-popover></div></template></el-table-column>
          </el-table>
        </section>

        <section v-show="currentStep === 'generate'" class="step-panel">
          <div class="step-heading">
            <span class="step-index">4</span>
            <!-- 后台逐条生成已升级为后台并发生成 -->
            <div><h2>生成队列</h2><p>后台并发生成，单张 API 结果最长等待 5 分钟，当前预计最长约 {{ estimatedBatchText }}。</p></div>
            <div class="step-actions generate-actions">
              <div class="action-group action-group--status">
                <el-tag type="info" effect="plain">后台并发 {{ backendImageConcurrency }}</el-tag>
                <el-tag type="warning" effect="plain">图片请求约 ¥{{ imageRequestUnitCost.toFixed(3) }}/次</el-tag>
              </div>
              <div class="action-group">
                <el-button type="danger" plain :disabled="!displayStats.failed || running.imageExecute" @click="selectFailedPlanRows">重试失败项（{{ displayStats.failed }}）</el-button>
                <el-button v-if="displayStats.providerPending" type="warning" plain :loading="running.imageExecute" @click="resumePendingImages">继续等待 / 拉回（{{ displayStats.providerPending }}）</el-button>
                <el-button :loading="promptReview.loading" :disabled="quickCaseImport.active || !state.batchJob" @click="openPromptReview">查看提示词</el-button>
                <el-button :disabled="quickCaseImport.active || !state.batchJob" @click="openBatchCopyEdit">批量改文案</el-button>
                <el-button type="primary" :loading="running.imageExecute" :disabled="quickCaseImport.active || !state.batchJob || operatorRulesNeedReplan" @click="executeBatchImages()">生成选中项</el-button>
              </div>
              <div class="action-group action-group--save">
                <el-button type="success" :loading="running.saveDrafts" :disabled="quickCaseImport.active || !state.batchJob || running.saveDrafts" @click="saveSelectedRowsToDrafts">{{ running.saveDraftStage || "保存到草稿箱" }}</el-button>
                <el-button :icon="Collection" :loading="running.saveTemplate" :disabled="quickCaseImport.active || !state.batchJob" @click="saveTemplate">保存选中案例</el-button>
              </div>
            </div>
          </div>
          <el-alert
            v-if="operatorRulesNeedReplan"
            title="人工备注已变化，当前生成队列已暂停"
            description="请返回识别产品步骤重新生成批量计划，确认新的后端最终规则后再开始生成。"
            type="warning"
            show-icon
            :closable="false"
            class="rule-replan-alert"
          />
          <el-alert
            v-if="draftSaveProgress.batchNo"
            :title="`草稿保存：${draftSaveProgress.success}/${draftSaveProgress.total} 已完成${draftSaveProgress.failed ? `，${draftSaveProgress.failed} 失败` : ''}`"
            :description="draftSaveProgress.status === 'completed' ? '已保存完成，可关闭当前页面。' : '后台正在保存，关闭页面不会取消任务。'"
            :type="draftSaveProgress.failed ? 'warning' : draftSaveProgress.status === 'completed' ? 'success' : 'info'"
            show-icon
            :closable="false"
            class="rule-replan-alert"
          />
          <el-alert
            title="货号无需提前生成"
            description="保存到草稿箱时会自动为缺少货号的车型生成唯一 offer_id；如遇重复也会自动更换，不会覆盖其他商品。"
            type="info"
            show-icon
            :closable="false"
            class="queue-logic-alert"
          />

          <div v-if="quickCaseImport.active" class="quick-case-loading">
            <div>
              <strong>正在根据案例准备生成队列</strong>
              <p>后台正在读取案例资产，并让 AI 为 {{ quickCaseImport.targetCount || "多个" }} 个新目标重新生成标题、标签、描述和主图计划。完成后会直接显示生成队列。</p>
            </div>
            <el-progress :percentage="100" :indeterminate="true" :duration="2" />
          </div>

          <div v-if="!quickCaseImport.active" class="generate-summary">
            <div><span>任务总数</span><strong>{{ displayStats.total }}</strong></div>
            <div><span>待生成</span><strong>{{ displayStats.planned }}</strong></div>
            <div><span>排队中</span><strong>{{ displayStats.queued }}</strong></div>
            <div><span>生成中</span><strong>{{ displayStats.generating }}</strong></div>
            <div><span>服务商处理中</span><strong>{{ displayStats.providerPending }}</strong></div>
            <div><span>后台并发</span><strong>{{ backendImageConcurrency }}</strong></div>
            <div><span>已完成</span><strong>{{ displayStats.done }}</strong></div>
            <div><span>失败</span><strong>{{ displayStats.failed }}</strong></div>
          </div>

          <el-table v-if="!quickCaseImport.active" ref="queueTableRef" :data="state.planRows" border class="queue-table" row-key="item_no" :height="queueTableHeight" @selection-change="onPlanSelectionChange">
            <el-table-column type="selection" width="46" fixed="left" />
            <el-table-column label="目标车型" width="170" fixed="left"><template #default="{ row }"><el-input v-model="row.target_variant_value" size="small" @change="syncRowTarget(row)" /></template></el-table-column>
            <el-table-column label="货号 / offer_id" width="230"><template #default="{ row }"><el-input v-model="row.offerId" size="small" placeholder="必填，保存草稿时覆盖" /></template></el-table-column>
            <el-table-column label="主图结果" width="150" align="center">
              <template #default="{ row }">
                <el-image
                  v-if="resultImageUrl(row)"
                  class="result-thumb"
                  :src="resultImageUrl(row)"
                  :preview-src-list="[resultImageUrl(row)]"
                  preview-teleported
                  fit="cover"
                />
                <el-tag v-else :type="statusTagType(row.status)">{{ rowStatusText(row) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="模块进度" min-width="360">
              <template #default="{ row }">
                <div class="module-progress">
                  <el-tag v-for="step in moduleSteps(row)" :key="step.key" :type="step.type" effect="light">
                    {{ step.label }}：{{ step.text }}
                  </el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="标题" min-width="300">
              <template #default="{ row }"><el-input v-model="row.titleText" type="textarea" :rows="2" placeholder="输入或修改俄语标题" /></template>
            </el-table-column>
            <el-table-column label="标签" min-width="320">
              <template #default="{ row }"><el-input v-model="row.tagsText" type="textarea" :rows="2" placeholder="#tag_1 #tag_2" /></template>
            </el-table-column>
            <el-table-column label="描述" min-width="420">
              <template #default="{ row }"><el-input v-model="row.descriptionText" type="textarea" :rows="3" placeholder="输入或修改俄语描述" /></template>
            </el-table-column>
            <el-table-column label="质量" width="150" align="center">
              <template #default="{ row }">
                <el-popover width="360" trigger="click">
                  <div class="quality-popover">
                    <p v-if="!rowQualityState(row).issues.length">标题、标签、简介基础规则已通过。</p>
                    <p v-for="issue in rowQualityState(row).issues" :key="issue">{{ issue }}</p>
                  </div>
                  <template #reference>
                    <el-tag :type="rowQualityState(row).type" effect="light">{{ rowQualityState(row).text }}</el-tag>
                  </template>
                </el-popover>
              </template>
            </el-table-column>
            <el-table-column label="富文本 / 详情资源" min-width="220">
              <template #default="{ row }">
                <div class="media-reuse-cell">
                  <span>富文本：{{ rowRichContentOutput(row) ? "有" : "无" }}</span>
                  <span>详情图：{{ material.detailImages.length }}</span>
                  <span>视频：{{ rowVideoUrls(row).length }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="190" align="center">
              <template #default="{ row }">
                <div class="queue-status-stack">
                  <el-tag :type="statusTagType(row.status)" effect="light">{{ rowStatusText(row) }}</el-tag>
                  <el-button size="small" :loading="promptReview.loading" @click="openPromptReview([row])">看提示词</el-button>
                  <el-button size="small" :loading="row.richContentStatus === 'saving'" :disabled="!resultImageUrl(row)" @click="generateRowRichContent(row)">富文本</el-button>
                  <el-button size="small" :loading="running.rowVideo === rowResultId(row)" :disabled="!rowMainImageDraftUrl(row)" @click="generateRowVideo(row)">视频</el-button>
                  <el-tag v-if="row.draftSaveStatus === 'saving'" type="warning" effect="light">保存中</el-tag>
                  <el-tag v-else-if="row.draftSaveStatus === 'failed'" type="danger" effect="light">草稿失败</el-tag>
                  <el-popover v-if="row.errorMessage" width="420" trigger="click">
                    <p class="error-message">{{ row.errorMessage }}</p>
                    <template #reference><el-button size="small" type="danger" plain>失败原因</el-button></template>
                  </el-popover>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150" align="center" fixed="right">
              <template #default="{ row }">
                <div class="queue-action-stack">
                  <el-button size="small" :loading="isRowImageQueueing(row)" :disabled="isRowImageBusy(row)" @click="regenerateRowMainImage(row)">重生主图</el-button>
                  <el-upload
                    :show-file-list="false"
                    accept="image/jpeg,image/png,image/webp"
                    :http-request="uploadRowMainImageRequest(row)"
                  >
                    <el-button size="small" plain :loading="isRowImageUploading(row)">上传主图</el-button>
                  </el-upload>
                  <el-button size="small" type="primary" plain :loading="running.saveCaseRow === rowResultId(row)" @click="saveCaseRow(row)">保存案例</el-button>
                  <el-button v-if="resultDownloadUrl(row)" size="small" tag="a" :href="resultDownloadUrl(row)" target="_blank">下载</el-button>
                  <el-button size="small" type="danger" plain @click="deletePlanRow(row)">删除</el-button>
                  <el-button v-if="row.listingDraftId" size="small" type="success" tag="a" :href="`/admin.html#/listing-automation?draftId=${row.listingDraftId}&source=listing_draft`" target="_blank">打开草稿</el-button>
                </div>
              </template>
            </el-table-column>
          </el-table>

          <div v-if="!quickCaseImport.active" class="case-save-hint">
            案例请在单行操作里保存，或勾选多个车型后点击“保存选中案例”。“保存到草稿箱”才会生成可继续编辑和上架的商品草稿。
          </div>
        </section>

    <AiProductImportDialog ref="importDialogRef" confirm-text="导入为母素材" @import="handleDialogImport" />

    <el-dialog v-model="vehicleCatalog.addVisible" title="新增品牌 / 车型" width="520px" destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="汽车品牌"><el-input v-model="vehicleCatalog.addForm.brand" placeholder="例如 HAVAL" /></el-form-item>
        <el-form-item label="具体型号"><el-input v-model="vehicleCatalog.addForm.model" placeholder="例如 Jolion；留空时只新增品牌" /></el-form-item>
        <el-form-item label="车型标签">
          <el-checkbox-group v-model="vehicleCatalog.addForm.tags">
            <el-checkbox v-for="tag in vehicleCatalog.tags" :key="tag.key" :value="tag.key">{{ tag.label }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="vehicleCatalog.addVisible = false">取消</el-button>
        <el-button type="primary" :loading="vehicleCatalog.addSaving" @click="saveVehicleCatalogEntry">保存到车型库</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="batchCopyEdit.visible" title="批量覆盖标题 / 标签 / 描述" width="760px" destroy-on-close>
      <div class="copy-edit-dialog">
        <p>应用到当前选中的车型；未选择时应用到全部队列。字段留空则保留原生成结果。可使用 {model} 代表目标车型。</p>
        <label><span>标题</span><el-input v-model="batchCopyEdit.title" placeholder="例如：Защитные накладки на пороги для {model}, ABS пластик" /></label>
        <label><span>标签</span><el-input v-model="batchCopyEdit.tags" type="textarea" :rows="4" placeholder="#накладки_на_пороги #защита_порогов #для_{model}" /></label>
        <label><span>描述</span><el-input v-model="batchCopyEdit.description" type="textarea" :rows="7" placeholder="输入俄语描述，建议 350-500 字符。" /></label>
      </div>
      <template #footer>
        <el-button @click="batchCopyEdit.visible = false">取消</el-button>
        <el-button type="primary" @click="applyBatchCopyEdit">应用覆盖</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="promptReview.visible" title="主图最终提示词审核" width="1080px" destroy-on-close>
      <div class="prompt-review-dialog">
        <p>这里展示后端预检后将用于主图生成的最终提示词。可直接调整不合理内容；保存后，开始生成和单行重生主图都会使用当前版本。</p>
        <el-table :data="promptReviewRows()" border height="560" class="prompt-review-table">
          <el-table-column label="目标车型" width="150" fixed="left">
            <template #default="{ row }"><strong>{{ row.target_variant_value }}</strong></template>
          </el-table-column>
          <el-table-column label="主图最终提示词" min-width="540">
            <template #default="{ row }">
              <el-input v-model="row.finalImagePrompt" type="textarea" :rows="8" placeholder="最终发送给生图模型的主图提示词" />
            </template>
          </el-table-column>
          <el-table-column label="负向提示词" min-width="360">
            <template #default="{ row }">
              <el-input v-model="row.finalNegativePrompt" type="textarea" :rows="8" placeholder="不要生成的内容" />
            </template>
          </el-table-column>
        </el-table>
      </div>
      <template #footer>
        <el-button @click="promptReview.visible = false">取消</el-button>
        <el-button type="primary" @click="savePromptReview">保存提示词</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.ai-lab-page { display: flex; flex-direction: column; gap: 14px; color: #172033; }
.lab-header, .workflow-card, .step-panel { background: #fff; border: 1px solid #d9e2ef; border-radius: 8px; }
.lab-header { display: flex; justify-content: space-between; gap: 24px; padding: 18px 20px; }
.header-tools { display: flex; align-items: flex-start; gap: 14px; }
.lab-header h1 { margin: 0; font-size: 24px; font-weight: 750; letter-spacing: 0; }
.lab-header p { margin: 6px 0 0; color: #65748a; line-height: 1.5; }
.header-stats { display: grid; grid-template-columns: repeat(3, minmax(96px, 1fr)); gap: 10px; min-width: 360px; }
.header-stats > div, .generate-summary > div { padding: 12px; background: #f6f8fb; border: 1px solid #dfe7f2; border-radius: 8px; }
.header-stats span, .generate-summary span { display: block; color: #69778c; font-size: 12px; }
.header-stats strong, .generate-summary strong { display: block; margin-top: 4px; font-size: 20px; }
.workflow-card { padding: 16px 18px; margin-bottom: 12px; }
.workflow-card :deep(.el-step__title) { cursor: pointer; }
.step-panel { padding: 18px; }
.step-heading { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
.step-heading h2 { margin: 0; font-size: 18px; letter-spacing: 0; }
.step-heading p { margin: 5px 0 0; color: #697386; line-height: 1.5; }
.step-heading > .el-button, .step-heading > .el-tag, .step-actions { margin-left: auto; }
.step-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.generate-actions { max-width: min(1180px, 72vw); align-items: center; row-gap: 10px; }
.action-group { display: flex; align-items: center; gap: 8px; padding-left: 10px; border-left: 1px solid #dbe3ee; }
.action-group:first-child { padding-left: 0; border-left: 0; }
.action-group--status { margin-right: 2px; }
.action-group--save { padding: 6px 8px 6px 10px; border-radius: 8px; background: #f0f9eb; }
.header-stats small { display: block; margin-top: 2px; color: #94a3b8; font-size: 11px; font-weight: 400; }
.queue-logic-alert { margin-bottom: 12px; }
.plan-action { display: grid; justify-items: end; gap: 6px; margin-left: auto; max-width: 360px; text-align: right; }
.plan-action span, .plan-mode-note { color: #64748b; font-size: 12px; line-height: 1.45; }
.plan-mode-note { margin-top: -4px; font-style: normal; }
.step-index { width: 30px; height: 30px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 50%; background: #1677ff; color: #fff; font-weight: 700; }
.material-layout { display: block; }
.import-panel { display: grid; gap: 12px; }
.import-actions { display: flex; }
.material-card { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 12px; align-items: center; padding: 12px; border: 1px solid #e1e8f2; border-radius: 8px; background: #f8fafc; }
.material-card.empty { color: #718096; }
.material-card img, .image-placeholder { width: 88px; height: 112px; border-radius: 6px; }
.material-card img { object-fit: cover; }
.image-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; background: #eef3f9; font-size: 12px; }
.material-meta, .import-meta { min-width: 0; display: grid; gap: 5px; }
.material-meta strong, .material-meta span, .material-meta em, .import-meta strong, .import-meta span, .import-meta em { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.material-meta em, .import-meta em { color: #64748b; font-style: normal; font-size: 12px; }
.recognition-facts-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid #e1e8f2; border-radius: 6px; overflow: hidden; }
.recognition-facts-grid section { min-height: 104px; padding: 12px 14px; background: #fff; border-right: 1px solid #e1e8f2; }
.recognition-facts-grid section:last-child { border-right: 0; }
.recognition-facts-grid h3 { margin: 0; font-size: 14px; }
.fact-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.fact-summary { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.fact-summary > span:not(.el-tag) { color: #94a3b8; font-size: 12px; }
.fact-summary :deep(.el-tag) { max-width: 100%; height: auto; min-height: 24px; padding: 3px 7px; white-space: normal; line-height: 1.35; }
ul { margin: 0; padding-left: 18px; color: #35435a; font-size: 13px; line-height: 1.6; }
.form-stack { display: grid; gap: 10px; }
.form-stack label { color: #506178; font-size: 12px; }
.variant-rule-workspace { margin-top: 12px; padding: 14px; border-top: 1px solid #e1e8f2; border-bottom: 1px solid #e1e8f2; background: #fbfcfe; }
.variant-rule-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.variant-rule-toolbar > div { display: grid; gap: 3px; }
.variant-rule-toolbar span { color: #64748b; font-size: 12px; }
.rule-preview-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.rule-preset-actions.segmented { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0; margin-top: 12px; border: 1px solid #cfd9e7; border-radius: 6px; overflow: hidden; }
.rule-preset-actions.segmented button { display: grid; gap: 3px; min-height: 52px; padding: 8px 10px; border: 0; border-right: 1px solid #cfd9e7; background: #fff; color: #334155; cursor: pointer; text-align: left; }
.rule-preset-actions.segmented button:last-child { border-right: 0; }
.rule-preset-actions.segmented button.active { background: #eaf4ff; color: #1267c4; box-shadow: inset 0 -2px #1677ff; }
.rule-preset-actions.segmented button span { color: #718096; font-size: 11px; }
.rule-preview-heading { margin-top: 14px; }
.variant-rule-workspace > p { margin: 8px 0 0; color: #64748b; font-size: 12px; line-height: 1.5; }
.rule-preview-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 8px; border: 1px solid #e1e8f2; border-radius: 6px; overflow: hidden; }
.rule-preview-grid > div { display: grid; gap: 4px; padding: 9px 11px; border-right: 1px solid #e1e8f2; background: #fff; }
.rule-preview-grid > div:last-child { border-right: 0; }
.rule-preview-grid span { color: #64748b; font-size: 12px; }
.rule-preview-grid strong { color: #263449; font-size: 13px; line-height: 1.5; }
.special-rule-details { margin-top: 10px; color: #475569; font-size: 12px; }
.special-rule-details summary { width: max-content; cursor: pointer; color: #1677ff; }
.special-rule-details :deep(.el-textarea) { margin-top: 8px; }
.vehicle-target-picker { margin-top: 12px; padding-top: 14px; border-top: 1px solid #dbe5ef; background: #fff; }
.vehicle-picker-heading, .column-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.vehicle-picker-heading > div { display: grid; gap: 3px; }
.vehicle-picker-heading span { color: #64748b; font-size: 12px; }
.vehicle-heading-actions { display: flex !important; align-items: center; gap: 10px !important; }
.vehicle-tag-toolbar { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
.vehicle-tag-toolbar button { padding: 6px 10px; border: 1px solid #d5deea; border-radius: 5px; background: #fff; color: #475569; cursor: pointer; }
.vehicle-tag-toolbar button.active { border-color: #89bfff; background: #eaf4ff; color: #1267c4; }
.vehicle-tag-toolbar button.clear-filter { border-color: transparent; color: #64748b; }
.vehicle-picker-grid { display: grid; grid-template-columns: 240px minmax(0, 1fr); min-height: 250px; margin-top: 10px; border-top: 1px solid #e1e8f2; border-bottom: 1px solid #e1e8f2; }
.vehicle-brand-column, .vehicle-model-column { min-width: 0; padding: 10px; }
.vehicle-brand-column { border-right: 1px solid #e1e8f2; background: #fbfcfe; }
.vehicle-brand-column button { border: 1px solid transparent; border-radius: 5px; background: transparent; color: #334155; cursor: pointer; text-align: left; }
.vehicle-brand-column button.active { border-color: #9cc8ff; background: #eaf4ff; color: #1267c4; }
.vehicle-brand-column { max-height: 320px; overflow: auto; }
.vehicle-brand-column > button { width: 100%; display: flex; justify-content: space-between; gap: 8px; padding: 7px 8px; margin-top: 4px; }
.vehicle-brand-column em { color: #64748b; font-size: 11px; font-style: normal; }
.vehicle-model-column { max-height: 320px; overflow: auto; }
.vehicle-model-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
.vehicle-model-options :deep(.el-checkbox) { height: auto; min-height: 44px; margin: 0; padding: 7px 9px; border: 1px solid #e1e8f2; border-radius: 5px; align-items: flex-start; }
.vehicle-model-options :deep(.el-checkbox__label) { min-width: 0; display: grid; gap: 2px; white-space: normal; }
.vehicle-model-options em { margin-left: 5px; color: #94a3b8; font-size: 10px; font-style: normal; }
.vehicle-model-options small { color: #7b8798; font-size: 10px; }
.selected-targets-bar { padding: 10px 0; border-bottom: 1px solid #e1e8f2; }
.selected-targets-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.selected-target-chips { display: flex; flex-wrap: wrap; gap: 6px; min-height: 28px; margin-top: 6px; align-items: center; }
.selected-target-chips > span:not(.el-tag) { color: #94a3b8; font-size: 12px; }
.selected-targets-bar :deep(.el-textarea) { margin-top: 8px; }
.rule-replan-alert { margin-bottom: 12px; }
.plan-table :deep(.el-table__header th), .queue-table :deep(.el-table__header th) { background: #f8fafc; color: #334155; font-weight: 700; }
.plan-table :deep(.el-textarea__inner) { min-height: 74px !important; font-size: 12px; line-height: 1.45; }
.result-thumb { width: 72px; height: 96px; border-radius: 6px; border: 1px solid #dbe5ef; background: #f8fafc; }
.module-progress { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.module-progress :deep(.el-tag) { margin: 0; }
.media-reuse-cell { display: grid; gap: 4px; color: #475569; font-size: 12px; line-height: 1.4; }
.queue-status-stack, .queue-action-stack { min-height: 108px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; }
.queue-status-stack :deep(.el-button), .queue-action-stack :deep(.el-button) { width: 96px; margin-left: 0; }
.queue-action-stack :deep(.el-upload) { width: 96px; }
.quality-popover { display: grid; gap: 6px; color: #475569; line-height: 1.5; }
.quality-popover p { margin: 0; }
.error-message { margin: 0; color: #b42318; line-height: 1.6; word-break: break-word; }
pre { max-height: 320px; overflow: auto; margin: 0; white-space: pre-wrap; font-size: 12px; color: #506178; }
.generate-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 12px; }
.quick-case-loading { display: grid; gap: 14px; padding: 18px; margin-bottom: 12px; border: 1px solid #cfe0f5; border-radius: 8px; background: #f8fbff; }
.quick-case-loading strong { display: block; margin-bottom: 6px; color: #172033; font-size: 15px; }
.quick-case-loading p { margin: 0; color: #64748b; line-height: 1.6; }
.case-save-hint { margin-top: 12px; padding: 10px 12px; border: 1px solid #dbe5ef; border-radius: 8px; background: #f8fafc; color: #64748b; font-size: 12px; line-height: 1.6; }
.import-dialog-body { display: grid; gap: 12px; }
.import-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; }
.import-thumb { width: 64px; height: 84px; object-fit: cover; border-radius: 6px; }
.copy-edit-dialog { display: grid; gap: 12px; }
.copy-edit-dialog p { margin: 0; color: #64748b; line-height: 1.6; }
.copy-edit-dialog label { display: grid; gap: 6px; color: #334155; font-size: 13px; font-weight: 700; }
.prompt-review-dialog { display: grid; gap: 12px; }
.prompt-review-dialog p { margin: 0; color: #64748b; line-height: 1.6; }
.prompt-review-table :deep(.el-textarea__inner) { font-size: 12px; line-height: 1.5; }
@media (max-width: 1280px) {
  .material-layout { grid-template-columns: 1fr; }
  .vehicle-model-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .import-actions, .generate-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
  .lab-header, .header-tools, .recognition-facts-grid, .rule-preview-grid, .import-actions, .generate-summary, .import-toolbar { display: grid; grid-template-columns: 1fr; }
  .recognition-facts-grid section, .rule-preview-grid > div { border-right: 0; border-bottom: 1px solid #e1e8f2; }
  .recognition-facts-grid section:last-child, .rule-preview-grid > div:last-child { border-bottom: 0; }
  .rule-preset-actions.segmented { display: flex; overflow-x: auto; }
  .rule-preset-actions.segmented button { flex: 0 0 176px; border-right: 1px solid #cfd9e7; border-bottom: 0; }
  .vehicle-picker-grid { grid-template-columns: 1fr; }
  .vehicle-brand-column { border-right: 0; border-bottom: 1px solid #e1e8f2; }
  .vehicle-model-options { grid-template-columns: 1fr; }
  .header-stats { min-width: 0; grid-template-columns: 1fr; }
  .step-heading { display: grid; }
  .step-actions { margin-left: 0; justify-content: flex-start; }
  .plan-action { justify-items: start; margin-left: 0; max-width: none; text-align: left; }
}
</style>

