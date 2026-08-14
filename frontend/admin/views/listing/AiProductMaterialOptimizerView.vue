<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Camera, Connection, Delete, DocumentChecked, Files, Picture, Refresh, UploadFilled } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api.js";
import AiProductImportDialog from "../../components/listing/AiProductImportDialog.vue";
import { generateAiCommerceCopy, generateAiImages, generateAiVideo, withImageToken } from "../../api/tools/aiImageGenerator.js";
import { normalizeImportVariants } from "../../utils/ai-product-import.js";

const currentStep = ref("material");
const route = useRoute();
const running = reactive({ analyze: false, plan: false, confirmAnalysis: false, confirmPlan: false, generate: false, prepare: false, saveDraft: false, batchSource: false, autoOptimize: false, stage: "" });
const importDialogRef = ref(null);
const routeImportLoading = ref(false);

const form = reactive({
  sourceType: "",
  productName: "",
  sourceSku: "",
  mainImageUrl: "",
  mainImageDataUrl: "",
  imageName: "",
  detailImageText: "",
  title: "",
  tags: "",
  description: "",
  userNote: "",
  productTitleZh: "",
  sellingPointsZh: "",
  compatibilityZh: "",
  forbiddenFactsZh: "",
  productFactsConfirmed: false,
  optimizationScope: "full",
  imageConcurrency: 6,
  templatePayloadText: "",
  templateId: "",
  sourceDraftId: "",
  sourceShopIds: []
});

const state = reactive({
  candidates: [],
  finalImageSlots: [],
  analysis: null,
  optimizerJobNo: "",
  plan: null,
  analysisConfirmed: false,
  planConfirmed: false,
  generated: null,
  prepareResult: null,
  savedDraftId: "",
  savedDraftIds: [],
  generationPlan: null
});
const sourceTasks = ref([]);
const activeSourceTaskId = ref("");
const selectedSourceTaskIds = ref([]);
const workflowError = ref("");
const recognitionProgress = reactive({ status: "idle", elapsedSeconds: 0, message: "等待开始识别" });
const planProgress = reactive({ status: "idle", message: "等待生成建议" });
let recognitionProgressTimer = 0;
const promptReviewDialog = reactive({ visible: false });
const MATERIAL_IMAGE_WAIT_MS = 20 * 60 * 1000;
const MATERIAL_COPY_WAIT_MS = 10 * 60 * 1000;
const MATERIAL_VIDEO_WAIT_MS = 30 * 60 * 1000;

const planEditor = reactive({ main: "", detail: "", title: "", tags: "", description: "", forbidden: "" });
const promptEditor = reactive({
  imageGlobalRules: "Lock the exact product body, shape, material, color, quantity and verified compatibility facts, but visibly redesign the commercial presentation. The new image must use a substantially different background, composition, camera framing, lighting, spacing and visual hierarchy. Do not merely remove a watermark or clean the source image. Do not invent accessories, certifications, logos or unsupported claims. Remove every Chinese character and Chinese label inherited from source images. Never render Chinese, random text, watermarks or platform logos.",
  textGlobalRules: "Generate buyer-facing Russian Ozon copy only. Preserve verified product facts. Do not output planning commentary, Chinese text, invented specifications, certifications or unsupported compatibility claims.",
  mainImage: "",
  detailImages: ""
});

const steps = [
  { key: "material", title: "导入素材", desc: "检查商品与原始图片" },
  { key: "recognize", title: "AI 识别", desc: "锁定产品事实" },
  { key: "plan", title: "生成计划", desc: "确认主图文案与套图分镜" },
  { key: "generate", title: "生成结果", desc: "查看结果并保存草稿" }
];
const draggedSlotIndex = ref(-1);
const imageReviewCache = new Map();

const selectedImageCount = computed(() => state.finalImageSlots.filter((item) => item.url).length);
const typographyIncomplete = computed(() => state.finalImageSlots.some((slot) => {
  const candidate = state.candidates.find((item) => item.candidate_id === slot.candidate_id);
  return candidate?.source === "optimized" && candidate.typography_status !== "done";
}));
const canPrepare = computed(() => state.finalImageSlots.some((item) => item.url));
const mainImagePreview = computed(() => form.mainImageDataUrl || form.mainImageUrl);
const operatorSellingPoints = computed(() => splitLines(form.sellingPointsZh));
const operatorProductFacts = computed(() => ({
  product_title_zh: String(form.productTitleZh || "").trim(),
  selling_points_zh: operatorSellingPoints.value,
  compatibility_zh: splitLines(form.compatibilityZh),
  forbidden_facts_zh: splitLines(form.forbiddenFactsZh),
  confirmed_by_operator: form.productFactsConfirmed === true
}));
const productFactsReady = computed(() => Boolean(
  operatorProductFacts.value.product_title_zh
  && operatorProductFacts.value.selling_points_zh.length >= 2
  && operatorProductFacts.value.confirmed_by_operator
));
const canAnalyze = computed(() => Boolean(
  (mainImagePreview.value || state.candidates.some((item) => item.url)) && productFactsReady.value
));
const canPlan = computed(() => Boolean(state.analysis && state.analysisConfirmed));
const canGenerate = computed(() => Boolean(state.plan && state.planConfirmed));
const activeStepIndex = computed(() => {
  if (currentStep.value === "material") return 0;
  if (currentStep.value === "recognize") return 1;
  if (currentStep.value === "plan") return 2;
  return 3;
});
const detailImageCount = computed(() => splitLines(form.detailImageText).length);
const generatedCandidateCount = computed(() => state.candidates.filter((item) => item.source === "optimized").length);
const mainVisualCandidates = computed(() => state.candidates.filter((item) => item.source === "optimized" && item.kind === "main" && item.url));
const RUSSIAN_TEXT_RE = /[А-Яа-яЁё]/u;
const DEFAULT_MAIN_OVERLAY_RU = {
  title: "Автомобильный аксессуар",
  compatibility: "Практичное решение для автомобиля",
  benefits: ["Продуманная конструкция", "Удобное использование"]
};
const mainOverlayPlan = computed(() => {
  const overlay = state.plan?.main_overlay_ru || {};
  const titleCandidates = [overlay.title_ru, form.title, state.analysis?.product_subject_ru];
  const title = titleCandidates.find((item) => RUSSIAN_TEXT_RE.test(String(item || ""))) || DEFAULT_MAIN_OVERLAY_RU.title;
  const compatibility = RUSSIAN_TEXT_RE.test(String(overlay.compatibility_ru || ""))
    ? overlay.compatibility_ru
    : DEFAULT_MAIN_OVERLAY_RU.compatibility;
  const benefits = (Array.isArray(overlay.benefits_ru) ? overlay.benefits_ru : [])
    .filter((item) => RUSSIAN_TEXT_RE.test(String(item || "")))
    .slice(0, 3);
  for (const fallback of DEFAULT_MAIN_OVERLAY_RU.benefits) {
    if (benefits.length >= 2) break;
    if (!benefits.includes(fallback)) benefits.push(fallback);
  }
  return { title, compatibility, benefits };
});
const copyStrategy = computed(() => state.plan?.copy_strategy || {});
const visualLanguage = computed(() => state.plan?.visual_language || {});
const storyboardPreview = computed(() => optimizerStoryboard());
const mainDirectionPreview = computed(() => mainVisualDirections());
const generationPlanBlockers = computed(() => {
  const blockers = [];
  if (!RUSSIAN_TEXT_RE.test(mainOverlayPlan.value.title)) blockers.push("主图缺少俄语商品标题");
  if (!RUSSIAN_TEXT_RE.test(mainOverlayPlan.value.compatibility)) blockers.push("主图缺少俄语适配型号或目标人群说明");
  if (mainOverlayPlan.value.benefits.filter((item) => RUSSIAN_TEXT_RE.test(item)).length < 2) blockers.push("主图至少需要 2 个俄语卖点");
  const missingDetailText = form.optimizationScope === "main_only"
    ? []
    : storyboardPreview.value.filter((shot, index) => shot.role !== "main" && !RUSSIAN_TEXT_RE.test(detailOverlayText(shot, index)));
  if (missingDetailText.length) blockers.push(`${missingDetailText.length} 张详情图缺少俄语文字说明`);
  return blockers;
});
const recognitionFactRows = computed(() => analysisNodeRows("fixed_facts"));
const recognitionProblemRows = computed(() => analysisNodeRows("main_image_observation", state.analysis?.display_zh?.detail_image_observation));
const recognitionForbiddenRows = computed(() => analysisNodeRows("forbidden_changes"));
const mainImageSuggestionRows = computed(() => planNodeRows("main_image_plan", state.plan?.optimization_goals));
const detailImageSuggestionRows = computed(() => planNodeRows("detail_image_plan"));
const titleSuggestionRows = computed(() => planNodeRows("title_plan", state.plan?.title_improvement_prompt_zh));
const tagSuggestionRows = computed(() => planNodeRows("tags_plan", state.plan?.tags_improvement_prompt_zh));
const descriptionSuggestionRows = computed(() => planNodeRows("description_plan", state.plan?.description_improvement_prompt_zh));
const planTargets = computed(() => [
  { key: "main", title: "主图方向", detail: "2 个主视觉方向，自动优选 1 个", ready: Boolean(state.plan?.main_image_plan) },
  { key: "details", title: "详情图套图", detail: `${Math.max(0, storyboardPreview.value.filter((shot) => shot.role !== "main").length)} 个详情分镜和俄语说明`, ready: storyboardPreview.value.length > 1 },
  { key: "copy", title: "俄语商品文案", detail: "标题、适配信息、卖点、标签和描述", ready: Boolean(state.plan?.main_overlay_ru) },
  { key: "video", title: "商品视频", detail: "使用最终主图和新文案生成视频封面与视频", ready: true }
].map((item) => ({ ...item, status: planProgress.status === "running" ? "running" : planProgress.status === "failed" ? "failed" : state.plan ? "done" : "ready" })));
const generatedResultRows = computed(() => {
  const optimized = state.candidates.filter((item) => item.url && item.source === "optimized");
  const fallback = state.candidates.filter((item) => item.url);
  const images = optimized.length ? optimized : fallback;
  const variants = state.generated?.variants?.length ? state.generated.variants : [{ key: "A", mainImage: images[0]?.url || "", images: images.map((item) => item.url), title: state.generated?.title, tags: state.generated?.tags, description: state.generated?.description, videoUrls: state.generated?.videoUrls, richContentJson: state.generated?.richContentJson }];
  return variants.map((variant) => ({
    variantKey: variant.key,
    id: "current-product-material",
    productName: form.productName || form.title || "当前商品",
    sourceSku: form.sourceSku || "-",
    mainImage: variant.mainImage || variant.images?.[0] || "",
    detailImages: (variant.images || images.map((item) => item.url)).slice(1),
    title: variant.title || state.generated?.title || form.title || "",
    tags: variant.tags?.length ? variant.tags : (state.generated?.tags?.length ? state.generated.tags : splitLines(form.tags)),
    description: variant.description || state.generated?.description || form.description || "",
    videoUrls: variant.videoUrls || [],
    richContentJson: variant.richContentJson || "",
    status: variant.saveStatus === "done" ? "已保存" : variant.saveStatus === "failed" ? "保存失败" : state.generated ? "已生成" : "待生成"
  }));
});

onMounted(() => {
  void autoImportRouteMaterial();
});

onUnmounted(() => window.clearInterval(recognitionProgressTimer));

async function autoImportRouteMaterial() {
  if (String(route.query.autoImport || "") !== "1") return;
  const routeSource = routeImportSource();
  const routeIds = routeImportIds(routeSource);
  if (!routeSource || !routeIds.length) return;
  routeImportLoading.value = true;
  try {
    const imported = [];
    const failed = [];
    for (const [index, routeId] of routeIds.entries()) {
      try {
        const detail = await apiClient.get(routeImportDetailUrl(routeSource, routeId), { noCache: true });
        const candidate = normalizeImportCandidate(detail || {}, routeSource, index);
        if (!candidate.imageUrl) throw new Error("缺少主图");
        if (routeSource === "draft" && !candidate.templateId && !candidate.templatePayload?.id) throw new Error("缺少上架模板");
        imported.push(candidate);
      } catch (error) {
        failed.push(`${routeId}：${error.message || "加载失败"}`);
      }
    }
    imported.forEach((candidate, index) => handleDialogImport(candidate, { append: index > 0, silent: true }));
    if (!imported.length) throw new Error(`没有可优化的草稿${failed.length ? `（${failed.join("；")}）` : ""}`);
    ElMessage.success(`已从${sourceLabel(routeSource)}导入 ${imported.length} 个草稿${failed.length ? `，跳过 ${failed.length} 个` : ""}`);
  } catch (error) {
    ElMessage.error(error.message || "导入素材失败");
  } finally {
    routeImportLoading.value = false;
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

function routeImportIds(source) {
  let value = "";
  if (source === "draft") value = route.query.draftIds || route.query.draftId;
  if (source === "collector") value = route.query.collectorSku || route.query.sourceId;
  if (source === "online") value = route.query.onlineProductId || route.query.sourceId;
  if (source === "record") value = route.query.listingRecordId || route.query.recordId || route.query.sourceId;
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  return [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))].slice(0, 20);
}

function routeImportDetailUrl(source, id) {
  const encoded = encodeURIComponent(id);
  if (source === "draft") return `/api/listing/drafts/${encoded}`;
  if (source === "collector") return `/api/listing/collector-box/${encoded}`;
  if (source === "online") return `/api/online-products/${encoded}/edit-draft`;
  if (source === "record") return `/api/listing/publish-records/${encoded}`;
  return "";
}

function splitLines(value = "") {
  return String(value || "").split(/[\s,，；;]+/).map((item) => item.trim()).filter(Boolean);
}

function analysisNodeRows(key, fallback = []) {
  const display = state.analysis?.display_zh || state.analysis?.displayZh || {};
  const value = display[key] || state.analysis?.[key] || fallback;
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "").split(/[\n；;]+/).map((item) => item.trim()).filter(Boolean);
}

function planNodeRows(key, fallback = []) {
  const display = state.plan?.display_zh || state.plan?.displayZh || {};
  const value = display[key] || state.plan?.[key] || fallback;
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "").split(/[\n；;]+/).map((item) => item.trim()).filter(Boolean);
}

function firstPlanNodeText(key, fallback = "") {
  return planNodeRows(key, fallback).join("；");
}

function candidateKey(prefix, index) {
  return `${prefix}_${Date.now().toString(36)}_${index + 1}`;
}

function goStep(step) {
  currentStep.value = step;
}

function openImportDialog(source) {
  importDialogRef.value?.open(source);
}

function handleDialogImport(row, options = {}) {
  const tasks = normalizeImportVariants(row).map((item, index) => ({
    ...item,
    taskId: `${item.source || "material"}-${item.sourceDraftId || item.sourceId || "source"}-${item.sourceVariantKey || index}`,
    status: "pending",
    draftId: "",
    error: "",
    workspace: null
  }));
  sourceTasks.value = options.append ? [...sourceTasks.value, ...tasks] : tasks;
  selectedSourceTaskIds.value = sourceTasks.value.map((item) => item.taskId);
  if (tasks[0] && (!options.append || !activeSourceTaskId.value)) activateSourceTask(tasks[0], { saveCurrent: false });
  if (!options.silent) ElMessage.success(tasks.length > 1 ? `已拆分为 ${tasks.length} 个独立变体任务` : "已导入素材");
}

function activateSourceTask(task, options = {}) {
  if (!task) return;
  if (options.saveCurrent !== false) saveActiveTaskWorkspace();
  activeSourceTaskId.value = task.taskId;
  if (task.workspace) restoreTaskWorkspace(task.workspace);
  else applyImportedMaterial(task);
}

function saveActiveTaskWorkspace() {
  const task = sourceTasks.value.find((item) => item.taskId === activeSourceTaskId.value);
  if (!task) return;
  task.workspace = {
    form: JSON.parse(JSON.stringify(form)),
    state: JSON.parse(JSON.stringify(state)),
    planEditor: JSON.parse(JSON.stringify(planEditor)),
    promptEditor: JSON.parse(JSON.stringify(promptEditor)),
    step: currentStep.value
  };
}

function restoreTaskWorkspace(workspace) {
  Object.assign(form, workspace.form || {});
  Object.assign(state, workspace.state || {});
  Object.assign(planEditor, workspace.planEditor || {});
  Object.assign(promptEditor, workspace.promptEditor || {});
  currentStep.value = workspace.step || "material";
}

function toggleSourceTask(taskId, checked) {
  const selected = new Set(selectedSourceTaskIds.value);
  if (checked) selected.add(taskId);
  else selected.delete(taskId);
  selectedSourceTaskIds.value = [...selected];
}

function removeSourceTask(taskId) {
  if (running.batchSource) return;
  const index = sourceTasks.value.findIndex((item) => item.taskId === taskId);
  if (index < 0) return;
  const removingActive = activeSourceTaskId.value === taskId;
  sourceTasks.value.splice(index, 1);
  selectedSourceTaskIds.value = selectedSourceTaskIds.value.filter((id) => id !== taskId);
  if (sourceTasks.value.length && removingActive) {
    const next = sourceTasks.value[Math.min(index, sourceTasks.value.length - 1)];
    activateSourceTask(next, { saveCurrent: false });
  } else if (!sourceTasks.value.length) {
    activeSourceTaskId.value = "";
    clearImportedMaterial();
  }
  ElMessage.success("已移除该变体任务");
}

function clearImportedMaterial() {
  Object.assign(form, {
    sourceType: "",
    productName: "",
    sourceSku: "",
    mainImageUrl: "",
    mainImageDataUrl: "",
    imageName: "",
    detailImageText: "",
    title: "",
    tags: "",
    description: "",
    productTitleZh: "",
    sellingPointsZh: "",
    compatibilityZh: "",
    forbiddenFactsZh: "",
    productFactsConfirmed: false,
    templatePayloadText: "",
    templateId: "",
    sourceDraftId: "",
    sourceShopIds: []
  });
  resetGeneratedState();
}

async function runSelectedSourceTasks(options = {}) {
  const tasks = sourceTasks.value.filter((item) => selectedSourceTaskIds.value.includes(item.taskId));
  if (!tasks.length) return ElMessage.warning("请至少选择一个变体任务");
  if (!options.skipConfirmation) {
    try {
      await ElMessageBox.confirm(
        `将按顺序优化 ${tasks.length} 个变体，并为每个变体生成独立草稿。图片和视频生成会消耗模型额度，是否继续？`,
        "批量优化确认",
        { confirmButtonText: "开始批量优化", cancelButtonText: "取消", type: "warning" }
      );
    } catch {
      return;
    }
  }
  running.batchSource = true;
  let completed = 0;
  for (const task of tasks) {
    try {
      task.status = "running";
      task.error = "";
      activateSourceTask(task);
      currentStep.value = "generate";
      importMaterial({ navigate: false });
      await analyzeMaterial({ auto: true });
      if (!state.analysis) throw new Error(`${task.sourceSku} 产品识别失败`);
      if (!state.analysisConfirmed) await confirmAnalysisNode();
      if (!state.analysisConfirmed) throw new Error(`${task.sourceSku} 产品识别自动确认失败`);
      await planMaterial();
      if (!state.plan) throw new Error(`${task.sourceSku} 优化建议生成失败`);
      await confirmPlanNode();
      if (!state.planConfirmed) throw new Error(`${task.sourceSku} 优化方案自动确认失败`);
      await generateMaterialResults();
      if (!state.generated) throw new Error(`${task.sourceSku} 素材生成失败`);
      await prepareTemplate({ navigate: false });
      if (!state.prepareResult) throw new Error(`${task.sourceSku} 保存预览生成失败`);
      await saveGeneratedDraft({ singleVariant: options.skipConfirmation });
      if (!state.savedDraftId) throw new Error(`${task.sourceSku} 草稿保存失败`);
      task.status = "done";
      task.draftId = state.savedDraftId;
      completed += 1;
      saveActiveTaskWorkspace();
    } catch (error) {
      task.status = "failed";
      task.error = error.message || "批量优化失败";
      saveActiveTaskWorkspace();
    }
  }
  running.batchSource = false;
  const failed = tasks.length - completed;
  if (completed) ElMessage.success(`批量优化完成：成功 ${completed} 个，失败 ${failed} 个`);
  else ElMessage.error(`批量优化失败：${failed} 个任务均未生成草稿`);
}

function sourceTaskStatusLabel(status) {
  return { pending: "待处理", running: "处理中", done: "已完成", failed: "失败" }[status] || "待处理";
}

function sourceTaskStatusType(status) {
  return { running: "warning", done: "success", failed: "danger" }[status] || "info";
}

function applyImportedMaterial(row) {
  form.sourceType = row.source;
  form.productName = row.title || row.sourceSku || "商品素材";
  form.sourceSku = row.sourceSku || row.sourceId || "";
  form.title = row.title || "";
  form.productTitleZh = row.title || "";
  form.sellingPointsZh = "";
  form.compatibilityZh = "";
  form.forbiddenFactsZh = "";
  form.productFactsConfirmed = false;
  form.tags = Array.isArray(row.tags) ? row.tags.join(" ") : String(row.tags || "");
  form.description = row.description || "";
  form.mainImageUrl = row.imageUrl || "";
  form.mainImageDataUrl = "";
  form.imageName = row.imageUrl ? "已导入主图" : "";
  form.detailImageText = normalizeImageList(row.detailImages || []).filter((url) => url && url !== form.mainImageUrl).join("\n");
  form.templatePayloadText = row.templatePayload && Object.keys(row.templatePayload).length
    ? JSON.stringify(row.templatePayload, null, 2)
    : "";
  form.templateId = row.templateId || "";
  form.sourceDraftId = row.sourceDraftId || "";
  form.sourceShopIds = Array.isArray(row.sourceShopIds) ? row.sourceShopIds : [];
  resetGeneratedState();
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
  const firstVariant = Array.isArray(editablePayload.variants) ? editablePayload.variants[0] : (Array.isArray(payload.variants) ? payload.variants[0] : null);
  const imageList = uniqueList(normalizeImageList(firstValue(
    row.image_url,
    row.main_image_url,
    row.primary_image,
    row.source_images,
    row.source_images_json,
    row.images,
    row.image_urls,
    payload.image_url,
    payload.images,
    payload.image_urls,
    editablePayload.images,
    productDetail.images,
    normalized.images,
    normalizedPayload.images,
    firstVariant?.images
  )));
  const explicitDetailImages = uniqueList(normalizeImageList([
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
  ]));
  const title = firstValue(row.title, row.name, row.product_name, row.subject, payload.title, payload.name, payload.product_name);
  const description = firstValue(row.description, row.description_text, row.selling_points, payload.description, payload.selling_points);
  const tags = normalizeTags(firstValue(row.tags, row.keywords, payload.tags, payload.keywords));
  const sourceSku = String(firstValue(row.sku, row.offer_id, row.product_id, row.id, payload.sku, payload.offer_id) || "").trim();
  const templateId = String(firstValue(row.template_id, row.templateId, row.listing_template_id, row.listingTemplateId, payload.template_id, payload.templateId, payload.id) || "").trim();
  return {
    id: `${source}-${sourceSku || index}`,
    index,
    source,
    sourceId: source === "draft" ? String(row.id || "").trim() : sourceSku || row.id || "",
    sourceSku,
    title: title || `商品 ${index + 1}`,
    description,
    tags,
    templateId,
    imageUrl: imageList[0] || "",
    detailImages: uniqueList([...explicitDetailImages, ...imageList.slice(1)]).filter((url) => url && url !== imageList[0]),
    templatePayload: payload,
    status: String(firstValue(row.status, payload.status, editablePayload.status) || "").trim(),
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
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 25);
  const text = String(value || "").trim();
  if (!text) return [];
  const parsed = parseMaybeJson(text);
  if (parsed) return normalizeTags(parsed);
  return text.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean).slice(0, 25);
}

function sourceLabel(source) {
  if (source === "collector") return "采集箱";
  if (source === "draft") return "草稿箱";
  if (source === "online") return "在线商品";
  if (source === "record") return "上架记录";
  return "素材";
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

async function onSourceImageChange(uploadFile) {
  const file = uploadFile.raw || uploadFile;
  if (!file) return;
  form.imageName = file.name || "本地主图";
  form.mainImageDataUrl = await fileToDataUrl(file);
  form.mainImageUrl = "";
  resetGeneratedState();
}

function resetGeneratedState() {
  state.candidates = [];
  state.finalImageSlots = [];
  state.analysis = null;
  state.analysisConfirmed = false;
  state.optimizerJobNo = "";
  state.plan = null;
  state.planConfirmed = false;
  state.generated = null;
  state.generationPlan = null;
  planProgress.status = "idle";
  planProgress.message = "等待生成建议";
  state.prepareResult = null;
  state.savedDraftId = "";
  state.savedDraftIds = [];
  Object.assign(planEditor, { main: "", detail: "", title: "", tags: "", description: "", forbidden: "" });
  promptEditor.mainImage = "";
  promptEditor.detailImages = "";
}

function importMaterial(options = {}) {
  const candidates = [];
  const mainUrl = form.mainImageDataUrl || form.mainImageUrl.trim();
  if (mainUrl) {
    candidates.push({
      candidate_id: candidateKey("main", 0),
      url: mainUrl,
      kind: "main",
      source: "original",
      status: "ready",
      version: 1,
      title: form.imageName || "原始主图"
    });
  }
  splitLines(form.detailImageText).forEach((url, index) => {
    candidates.push({
      candidate_id: candidateKey("detail", index),
      url,
      kind: "detail",
      source: "original",
      status: "ready",
      version: 1,
      title: `原始详情图 ${index + 1}`
    });
  });
  if (!candidates.length) {
    ElMessage.warning("请先导入主图或详情图");
    return;
  }
  state.candidates = candidates;
  state.finalImageSlots = candidates.map((item, index) => ({
    slot: index + 1,
    role: index === 0 ? "main" : "detail",
    url: item.url,
    candidate_id: item.candidate_id,
    source: item.source,
    sort_order: index + 1
  }));
  state.prepareResult = null;
  if (options.navigate !== false) currentStep.value = "recognize";
}

async function confirmMaterialAndOptimize(options = {}) {
  workflowError.value = "";
  running.autoOptimize = true;
  currentStep.value = "recognize";
  try {
    if (options.reimport !== false || !state.candidates.length) importMaterial({ navigate: false });
    if (!state.analysis) {
      running.stage = "正在识别产品事实";
      await analyzeMaterial({ auto: true });
    }
    if (!state.analysis) return markWorkflowStopped("产品识别未完成，请检查素材后继续优化");
    currentStep.value = "recognize";
  } finally {
    running.autoOptimize = false;
    running.stage = "";
  }
}

function markWorkflowStopped(message) {
  workflowError.value = message;
  return false;
}

function continueMaterialOptimization() {
  return confirmMaterialAndOptimize({ reimport: false });
}

function removeDetailCandidate(candidateId) {
  const candidate = state.candidates.find((item) => item.candidate_id === candidateId);
  if (!candidate || candidate.kind === "main") return;
  state.candidates = state.candidates.filter((item) => item.candidate_id !== candidateId);
  form.detailImageText = state.candidates
    .filter((item) => item.kind === "detail" && item.source !== "optimized" && item.url)
    .map((item) => item.url)
    .join("\n");
  state.finalImageSlots = state.finalImageSlots
    .filter((item) => item.candidate_id !== candidateId)
    .map((item, index) => ({ ...item, slot: index + 1, sort_order: index + 1 }));
  state.analysis = null;
  state.analysisConfirmed = false;
  state.optimizerJobNo = "";
  state.plan = null;
  state.planConfirmed = false;
  state.generated = null;
  state.generationPlan = null;
  state.prepareResult = null;
  state.savedDraftId = "";
  Object.assign(planEditor, { main: "", detail: "", title: "", tags: "", description: "", forbidden: "" });
  promptEditor.mainImage = "";
  promptEditor.detailImages = "";
  ElMessage.success("已移除该详情图，请重新识别产品");
}

async function analyzeMaterial(options = {}) {
  if (!productFactsReady.value) {
    ElMessage.warning("请先填写中文精确产品名称和至少 2 条真实卖点，并确认这些商品事实");
    return;
  }
  if (!canAnalyze.value) {
    ElMessage.warning("请先导入主图或详情图");
    return;
  }
  if (!state.candidates.length) importMaterial();
  const payload = {
    candidates: state.candidates,
    sourceProductId: form.sourceSku,
    sourceImageUrl: form.mainImageUrl || mainImagePreview.value,
    title: form.title,
    tags: splitLines(form.tags),
    description: form.description,
    operatorFacts: operatorProductFacts.value,
    goal: "识别商品主体，锁定不能改变的产品事实。输入可以包含英文或俄语，但产品识别、问题、建议等用户可见内容必须用中文输出。"
  };
  const history = await apiClient.post("/api/ai-variant-lab/optimize/analysis/lookup", payload).catch(() => null);
  if (history?.reused && (options.auto || await confirmUseHistoryAnalysis(history))) {
    applyMaterialAnalysisResult(history);
    ElMessage.success("已复用历史产品识别");
    return;
  }
  running.analyze = true;
  workflowError.value = "";
  startRecognitionProgress();
  try {
    const result = await apiClient.post("/api/ai-variant-lab/optimize/analyze", {
      ...payload,
      forceAnalyze: true
    });
    applyMaterialAnalysisResult(result);
    finishRecognitionProgress("awaiting_confirmation", "识别完成，等待你检查并确认结果");
    ElMessage.success("产品识别完成");
  } catch (error) {
    const timedOut = Number(error?.status || 0) === 504 || /timeout|超时/i.test(error?.message || "");
    workflowError.value = timedOut ? "产品识别超时，AI 服务本次未及时返回。素材和已保存节点不会丢失，请点击右上角重新识别。" : (error.message || "产品识别失败");
    finishRecognitionProgress("failed", workflowError.value);
    ElMessage.error(error.message || "产品识别失败");
  } finally {
    running.analyze = false;
  }
}

function startRecognitionProgress() {
  window.clearInterval(recognitionProgressTimer);
  recognitionProgress.status = "running";
  recognitionProgress.elapsedSeconds = 0;
  recognitionProgress.message = `正在读取 ${state.candidates.filter((item) => item.url).length || 1} 张商品图片并调用视觉模型`;
  recognitionProgressTimer = window.setInterval(() => {
    recognitionProgress.elapsedSeconds += 1;
    if (recognitionProgress.elapsedSeconds >= 150) recognitionProgress.message = "AI 正在整理产品事实，接近超时上限，请继续等待";
    else if (recognitionProgress.elapsedSeconds >= 60) recognitionProgress.message = "多图识别仍在处理中，AI 正在核对各图片中的产品事实";
    else if (recognitionProgress.elapsedSeconds >= 12) recognitionProgress.message = "AI 正在识别产品主体、材质、数量和不可变事实";
  }, 1000);
}

function finishRecognitionProgress(status, message) {
  window.clearInterval(recognitionProgressTimer);
  recognitionProgress.status = status;
  recognitionProgress.message = message;
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

function applyMaterialAnalysisResult(result = {}) {
  state.analysis = result.analysis;
  state.optimizerJobNo = result.job_no || "";
  state.analysisConfirmed = result.status === "analysis_confirmed" || result.analysis_confirmed === true;
  state.planConfirmed = false;
  state.plan = null;
  state.generated = null;
  state.generationPlan = null;
  recognitionProgress.status = state.analysisConfirmed ? "confirmed" : "awaiting_confirmation";
  recognitionProgress.message = state.analysisConfirmed ? "已恢复确认过的识别节点" : "识别完成，等待你检查并确认结果";
}

async function confirmAnalysisNode() {
  if (!state.analysis || !state.optimizerJobNo) return ElMessage.warning("请先完成产品识别");
  running.confirmAnalysis = true;
  try {
    const result = await apiClient.post("/api/ai-variant-lab/optimize/analysis/confirm", {
      jobNo: state.optimizerJobNo,
      analysis: state.analysis
    });
    state.analysis = result.analysis;
    state.analysisConfirmed = true;
    recognitionProgress.status = "confirmed";
    recognitionProgress.message = "识别结果已确认并保存，可以进入生成建议";
    state.plan = null;
    state.planConfirmed = false;
    state.generationPlan = null;
    currentStep.value = "plan";
    ElMessage.success("识别节点已保存，可以生成建议");
  } catch (error) {
    ElMessage.error(error.message || "保存识别节点失败");
  } finally {
    running.confirmAnalysis = false;
  }
}

async function planMaterial() {
  if (!canPlan.value) {
    ElMessage.warning("请先识别产品");
    return;
  }
  running.plan = true;
  workflowError.value = "";
  planProgress.status = "running";
  planProgress.message = "正在生成主图方向、详情分镜和俄语文案计划";
  try {
    const result = await apiClient.post("/api/ai-variant-lab/optimize/plan", {
      jobNo: state.optimizerJobNo,
      analysis: state.analysis,
      operatorNote: form.userNote,
      operatorFacts: operatorProductFacts.value,
      goal: "生成商品素材优化方案，按主图建议、详情图方案、标题建议、标签建议、描述建议分别输出中文建议，并保护产品事实不变。",
      optimizationLevel: "medium"
    });
    state.plan = result.plan;
    state.planConfirmed = false;
    applyPlanEditors(result.plan);
    planProgress.status = "done";
    planProgress.message = "建议已生成，请检查各项目标后确认保存";
    ElMessage.success("优化建议已生成");
  } catch (error) {
    workflowError.value = error.message || "生成优化建议失败";
    planProgress.status = "failed";
    planProgress.message = workflowError.value;
    ElMessage.error(error.message || "生成优化建议失败");
  } finally {
    running.plan = false;
  }
}

async function confirmPlanNode() {
  if (!state.plan || !state.optimizerJobNo) return ElMessage.warning("请先生成建议");
  if (generationPlanBlockers.value.length) return ElMessage.error(`生成计划不完整：${generationPlanBlockers.value.join("；")}`);
  running.confirmPlan = true;
  try {
    const confirmedPlan = {
      ...state.plan,
      operator_edits: JSON.parse(JSON.stringify(planEditor)),
      confirmed_generation_modules: JSON.parse(JSON.stringify(state.generationPlan?.modules || []))
    };
    const result = await apiClient.post("/api/ai-variant-lab/optimize/plan/confirm", {
      jobNo: state.optimizerJobNo,
      analysis: state.analysis,
      plan: confirmedPlan
    });
    state.plan = result.plan;
    state.planConfirmed = true;
    prepareGenerationPlan();
    currentStep.value = "generate";
    ElMessage.success("生成建议已保存，请确认后按计划生成");
  } catch (error) {
    ElMessage.error(error.message || "保存生成建议失败");
  } finally {
    running.confirmPlan = false;
  }
}

function applyPlanEditors(plan = {}) {
  planEditor.main = planNodeRows("main_image_plan", plan?.optimization_goals).join("\n");
  planEditor.detail = planNodeRows("detail_image_plan").join("\n");
  planEditor.title = planNodeRows("title_plan", plan?.title_improvement_prompt_zh).join("\n");
  planEditor.tags = planNodeRows("tags_plan").join("\n");
  planEditor.description = planNodeRows("description_plan", plan?.description_improvement_prompt_zh).join("\n");
  planEditor.forbidden = (Array.isArray(plan?.forbidden_changes) ? plan.forbidden_changes : []).join("\n");
  promptEditor.mainImage = [plan?.image_optimization_prompt_en, planEditor.main].filter(Boolean).join("\n\n");
  promptEditor.detailImages = planEditor.detail;
}

function prepareGenerationPlan() {
  const originals = state.candidates.filter((item) => item.url && item.source !== "optimized");
  const mainSource = originals.find((item) => item.kind === "main") || originals[0];
  const detailSources = form.optimizationScope === "main_only" ? [] : originals.filter((item) => item !== mainSource);
  const mainOnly = form.optimizationScope === "main_only";
  state.generationPlan = {
    confirmed: false,
    imageConcurrency: Math.min(6, Math.max(1, Number(form.imageConcurrency || 6))),
    modules: [
      { id: "main", name: "主图", summary: "生成 2 个方向并自动优选，备选图保留", prompt: buildImageGenerationPayload(mainSource, "main", 0).finalPrompt, status: "ready", enabled: true, error: "" },
      { id: "details", name: "详情图套图", summary: detailSources.length ? `按统一主视觉生成 ${detailSources.length} 张详情图` : "继承原详情图", prompts: detailSources.map((source, index) => buildImageGenerationPayload(source, "detail", index).finalPrompt), status: detailSources.length ? "ready" : "skipped", enabled: detailSources.length > 0, error: "" },
      { id: "copy", name: "商品文案", summary: mainOnly ? "继承原文案" : "一次生成标题、标签和描述", prompt: promptEditor.textGlobalRules, status: mainOnly ? "skipped" : "ready", enabled: !mainOnly, error: "" },
      { id: "video", name: "商品视频", summary: mainOnly ? "继承原视频" : "主图和文案完成后立即生成", prompt: "Use the generated main image and final product copy to create the product video.", status: mainOnly ? "skipped" : "ready", enabled: !mainOnly, error: "" },
      { id: "assemble", name: "富文本组装", summary: mainOnly ? "继承原富文本" : "使用最终主图和新描述组装富文本；程序化俄语排版仅作为手动兜底", prompt: "Assemble rich content from the final model-designed images and generated copy.", status: mainOnly ? "skipped" : "ready", enabled: !mainOnly, error: "" }
    ]
  };
  workflowError.value = "";
}

function generationModule(id) {
  return state.generationPlan?.modules?.find((item) => item.id === id);
}

function setGenerationModuleStatus(id, status, error = "") {
  const module = generationModule(id);
  if (!module) return;
  module.status = status;
  module.error = error;
}

function plannedImagePayload(source, role, index) {
  const payload = buildImageGenerationPayload(source, role, index);
  const module = generationModule(role === "main" ? "main" : "details");
  const plannedPrompt = role === "main" ? module?.prompt : module?.prompts?.[index];
  if (plannedPrompt) payload.finalPrompt = plannedPrompt;
  return payload;
}

function generationStatusLabel(status) {
  return { ready: "待确认", waiting: "等待依赖", running: "生成中", done: "已完成", partial: "部分失败", failed: "失败", skipped: "已跳过" }[status] || "待确认";
}

function generationStatusType(status) {
  return { ready: "info", waiting: "warning", running: "warning", done: "success", partial: "warning", failed: "danger", skipped: "info" }[status] || "info";
}

function planTargetStatusLabel(status) {
  return { ready: "待生成", running: "生成中", done: "已完成", failed: "失败" }[status] || "待生成";
}

async function retryGenerationModule(moduleId) {
  if (running.generate || !state.generated) return;
  const originals = state.candidates.filter((item) => item.url && item.source === "original");
  const mainSource = originals.find((item) => item.kind === "main") || originals[0];
  const details = originals.filter((item) => item !== mainSource);
  setGenerationModuleStatus(moduleId, "running");
  running.generate = true;
  try {
    if (moduleId === "main") {
      const result = await generateMainVisualOptions(mainSource);
      const image = result?.url || "";
      if (!image) throw new Error("主图生成接口未返回图片");
      let candidate = { ...buildGeneratedCandidate(mainSource, image, "main", 0), ...imageModelTypographyReview(result.review), quality_score: result.review?.score || 0, review_pass: result.review?.pass === true, selected_by_ai: true, visual_direction: result.direction?.title_zh || "" };
      let alternatives = result.alternatives || [];
      [candidate] = await composeGeneratedImageText([candidate], state.generated.title);
      alternatives = await composeGeneratedImageText(alternatives, state.generated.title);
      state.finalImageSlots.splice(0, 1, { slot: 1, role: "main", url: candidate.url, candidate_id: candidate.candidate_id, source: candidate.source, sort_order: 1 });
      state.candidates.push(candidate, ...alternatives);
      state.generated.automaticMainCandidateId = candidate.candidate_id;
    } else if (moduleId === "details") {
      const concurrency = Math.min(6, Math.max(1, Number(state.generationPlan.imageConcurrency || 6)));
      const results = await runWithConcurrency(details, concurrency, async (source, index) => {
        const result = await generateReviewedImage(source, "detail", index, state.finalImageSlots[0]?.url || "");
        const image = result?.url || "";
        if (!image) throw new Error(`详情图 ${index + 1} 未返回图片`);
        return { ...buildGeneratedCandidate(source, image, "detail", index), ...imageModelTypographyReview(result.review) };
      });
      state.finalImageSlots.splice(1, state.finalImageSlots.length - 1, ...results.map((candidate, index) => ({ slot: index + 2, role: "detail", url: candidate.url, candidate_id: candidate.candidate_id, source: candidate.source, sort_order: index + 2 })));
      state.candidates.push(...results);
    } else if (moduleId === "copy") {
      const copy = await generateValidatedCommerceCopy(state.finalImageSlots[0]?.url || "");
      state.generated.title = copy.titles?.[0] || form.title;
      state.generated.tags = copy.tags?.length ? copy.tags : splitLines(form.tags);
      state.generated.description = copy.description || form.description;
    } else if (moduleId === "video") {
      const video = await generateOptimizerVideo(state.finalImageSlots[0]?.url || "", { titles: [state.generated.title], tags: state.generated.tags, description: state.generated.description });
      state.generated.videoUrls = video.url ? [video.url] : [];
      state.generated.videoCoverUrls = video.url ? [video.url] : [];
      state.generated.videoError = video.error || "";
      if (!video.url) throw new Error(video.error || "视频生成失败");
    } else if (moduleId === "assemble") {
      state.generated.richContentJson = buildOptimizerRichContent(state.finalImageSlots.map((item) => item.url), state.generated.title, state.generated.description);
    }
    if (["main", "details", "copy", "assemble"].includes(moduleId)) {
      state.generated.richContentJson = buildOptimizerRichContent(state.finalImageSlots.map((item) => item.url), state.generated.title, state.generated.description);
    }
    setGenerationModuleStatus(moduleId, "done");
    ElMessage.success(`${generationModule(moduleId)?.name || "模块"}已重新生成`);
  } catch (error) {
    setGenerationModuleStatus(moduleId, "failed", error.message || "重新生成失败");
    workflowError.value = `${generationModule(moduleId)?.name || "模块"}重新生成失败：${error.message || "未知错误"}`;
  } finally {
    running.generate = false;
  }
}

async function confirmPlanAndGenerate() {
  if (generationPlanBlockers.value.length) {
    ElMessage.error(`生成计划不完整：${generationPlanBlockers.value.join("；")}`);
    return;
  }
  await confirmPlanNode();
}

async function generateMaterialResults() {
  if (!canGenerate.value) return ElMessage.warning("请先完成识别并生成计划");
  if (!state.generationPlan) prepareGenerationPlan();
  state.generationPlan.confirmed = true;
  workflowError.value = "";
  running.generate = true;
  try {
    const originals = state.candidates.filter((item) => item.url && item.source !== "optimized");
    const mainSource = originals.find((item) => item.kind === "main") || originals[0];
    const importedDetails = originals.filter((item) => item !== mainSource);
    const mainEnabled = generationModule("main")?.enabled !== false;
    const detailsEnabled = generationModule("details")?.enabled !== false;
    const copyEnabled = generationModule("copy")?.enabled !== false;
    const videoEnabled = generationModule("video")?.enabled !== false;
    const detailSources = form.optimizationScope === "main_only" || !detailsEnabled ? [] : importedDetails;
    const concurrency = Math.min(6, Math.max(1, Number(state.generationPlan.imageConcurrency || form.imageConcurrency || 6)));
    let detailDone = 0;
    let mainAlternativeCandidates = [];
    setGenerationModuleStatus("main", mainEnabled ? "running" : "skipped");
    setGenerationModuleStatus("details", detailSources.length ? "running" : "skipped");
    setGenerationModuleStatus("copy", copyEnabled ? "running" : "skipped");
    running.stage = `主图、详情套图（并发 ${concurrency}）和整套文案正在同时生成`;

    const mainPromise = (mainEnabled ? generateMainVisualOptions(mainSource) : Promise.resolve(null))
      .then((result) => {
        if (!mainEnabled) return { image: mainSource?.url || "", candidate: mainSource, error: "" };
        const image = result?.url || "";
        if (!image) throw new Error("主图生成接口未返回图片");
        mainAlternativeCandidates = result.alternatives || [];
        const candidate = { ...buildGeneratedCandidate(mainSource, image, "main", 0), ...imageModelTypographyReview(result.review), quality_score: result.review?.score || 0, review_pass: result.review?.pass === true, selected_by_ai: true, visual_direction: result.direction?.title_zh || "", was_retried: result.retried === true };
        checkpointGeneratedCandidate(candidate, "main", 0);
        mainAlternativeCandidates.forEach((item) => upsertGeneratedCandidate(item));
        setGenerationModuleStatus("main", "done");
        return { image, candidate, error: "" };
      })
      .catch((error) => {
        setGenerationModuleStatus("main", "failed", error.message || "主图生成失败");
        return { image: "", candidate: null, error: error.message || "主图生成失败" };
      });

    const detailPromise = mainPromise.then((main) => runWithConcurrency(detailSources, concurrency, async (source, index) => {
      try {
        const result = await generateReviewedImage(source, "detail", index, main.image);
        const image = result?.url || "";
        if (!image) throw new Error(`详情图 ${index + 1} 未返回图片`);
        const candidate = { ...buildGeneratedCandidate(source, image, "detail", index), ...imageModelTypographyReview(result.review), quality_score: result.review?.score || 0, review_pass: result.review?.pass === true, was_retried: result.retried === true };
        checkpointGeneratedCandidate(candidate, "detail", index);
        return { candidate, error: "" };
      } catch (error) {
        return { candidate: null, error: error.message || `详情图 ${index + 1} 生成失败` };
      } finally {
        detailDone += 1;
        running.stage = `详情套图 ${detailDone}/${detailSources.length}，主图和文案并行处理中`;
      }
    })).then((results) => {
      const errors = results.filter((item) => item.error).map((item) => item.error);
      const status = !results.length ? "skipped" : errors.length === results.length ? "failed" : errors.length ? "partial" : "done";
      setGenerationModuleStatus("details", status, errors.join("；"));
      return results;
    });

    const copyPromise = (copyEnabled ? generateValidatedCommerceCopy(mainSource?.url || "") : Promise.resolve({}))
      .then((copy) => {
        if (copyEnabled) setGenerationModuleStatus("copy", "done");
        return { copy, error: "" };
      })
      .catch((error) => {
        setGenerationModuleStatus("copy", "failed", error.message || "商品文案生成失败");
        return { copy: {}, error: error.message || "商品文案生成失败" };
      });

    setGenerationModuleStatus("video", videoEnabled ? "waiting" : "skipped");
    const videoPromise = Promise.all([mainPromise, copyPromise]).then(async ([main, copyResult]) => {
      if (!videoEnabled) return [];
      const copy = copyResult.copy || {};
      const title = copy.titles?.[0] || form.title;
      const mainOptions = [main.candidate, ...mainAlternativeCandidates].filter((item) => item?.url).slice(0, 2);
      if (!mainOptions.length) {
        setGenerationModuleStatus("video", "skipped", "主图失败，视频未启动");
        return [];
      }
      setGenerationModuleStatus("video", "running");
      const videos = await Promise.all(mainOptions.map(async (option) => {
        try {
          return await generateOptimizerVideo(option.url, copy, { title, tags: copy.tags || [], description: copy.description || form.description });
        } catch (error) {
          return { url: "", error: error.message || "视频生成失败" };
        }
      }));
      const failed = videos.filter((item) => !item?.url);
      setGenerationModuleStatus("video", failed.length === videos.length ? "failed" : failed.length ? "partial" : "done", failed.map((item) => item.error).filter(Boolean).join("；"));
      return videos;
    });

    const [main, detailResults, copyResult] = await Promise.all([mainPromise, detailPromise, copyPromise]);
    let generatedImages = [main.candidate || mainSource];
    if (form.optimizationScope === "main_only") generatedImages.push(...importedDetails);
    else detailResults.forEach((result, index) => generatedImages.push(result.candidate || detailSources[index]));
    const copy = copyResult.copy || {};
    const title = copy.titles?.[0] || form.title;
    const tags = copy.tags?.length ? copy.tags : splitLines(form.tags);
    const description = copy.description || form.description;
    setGenerationModuleStatus("assemble", "running");
    const typographyFailed = [...generatedImages, ...mainAlternativeCandidates].filter((item) => item.source === "optimized" && item.typography_status !== "done");
    const richContentJson = form.optimizationScope === "main_only" ? "" : buildOptimizerRichContent(generatedImages.map((item) => item.url), title, description);
    setGenerationModuleStatus("assemble", form.optimizationScope === "main_only" ? "skipped" : (typographyFailed.length ? "partial" : "done"), typographyFailed.length ? `${typographyFailed.length} 张图片俄语排版失败，可重试俄语排版` : "");
    const videoUrls = [];
    const videoCoverUrls = [];
    const mainOptions = [main.candidate, ...mainAlternativeCandidates].filter((item) => item?.url).slice(0, 2);
    state.candidates = [...originals, ...generatedImages, ...mainAlternativeCandidates];
    state.finalImageSlots = generatedImages.map((item, index) => ({
      slot: index + 1,
      role: index === 0 ? "main" : "detail",
      url: item.url,
      candidate_id: item.candidate_id,
      source: item.source,
      sort_order: index + 1
    }));
    state.generated = {
      imageCount: generatedImages.length,
      title, tags, description, richContentJson, videoUrls, videoCoverUrls,
      copyQualityStatus: copy.qualityStatus || "unknown", copyQualityIssues: copy.qualityIssues || [], copyRewriteCount: Number(copy.rewriteCount || 0),
      videoPending: videoEnabled, videoError: "", typographyFailed: typographyFailed.length,
      automaticMainCandidateId: generatedImages[0]?.candidate_id || "",
      variants: mainOptions.map((option, index) => ({
        key: index === 0 ? "A" : "B",
        mainImage: option.url,
        mainCandidateId: option.candidate_id,
        images: [option.url, ...generatedImages.slice(1).map((item) => item.url)].filter(Boolean),
        richContentJson: form.optimizationScope === "main_only" ? "" : buildOptimizerRichContent([option.url, ...generatedImages.slice(1).map((item) => item.url)], title, description),
        videoUrls: [], videoCoverUrls: [], videoPending: videoEnabled, videoError: "", draftId: "", saveStatus: "ready", saveError: ""
      }))
    };
    const failed = state.generationPlan.modules.filter((item) => ["failed", "partial"].includes(item.status));
    await apiClient.post("/api/ai-variant-lab/optimize/result", {
      jobNo: state.optimizerJobNo,
      partial: failed.length > 0,
      result: {
        generated: state.generated,
        candidates: state.candidates,
        finalImageSlots: state.finalImageSlots,
        generationPlan: state.generationPlan
      }
    });
    workflowError.value = failed.length ? `${failed.map((item) => item.name).join("、")}未完全成功，可单独重试失败模块` : "";
    ElMessage.success(`生成批次完成：${generatedImages.length} 个图片位已就绪，视频在后台继续生成`);
    void videoPromise.then(async (videos) => {
      if (!state.generated) return;
      state.generated.variants = (state.generated.variants || []).map((variant, index) => {
        const video = videos[index] || {};
        return { ...variant, videoUrls: video.url ? [video.url] : [], videoCoverUrls: video.url ? [video.url] : [], videoPending: false, videoError: video.error || "" };
      });
      const firstVideo = videos[0] || {};
      state.generated.videoUrls = firstVideo.url ? [firstVideo.url] : [];
      state.generated.videoCoverUrls = firstVideo.url ? [firstVideo.url] : [];
      state.generated.videoPending = false;
      state.generated.videoError = videos.map((item) => item.error).filter(Boolean).join("；");
      await apiClient.post("/api/ai-variant-lab/optimize/result", {
        jobNo: state.optimizerJobNo,
        partial: state.generationPlan.modules.some((item) => ["failed", "partial"].includes(item.status)),
        result: { generated: state.generated, candidates: state.candidates, finalImageSlots: state.finalImageSlots, generationPlan: state.generationPlan }
      }).catch(() => {});
    });
  } catch (error) {
    const preserved = state.candidates.filter((item) => item.source === "optimized" && item.url).length;
    workflowError.value = `${error.message || "生成商品素材失败"}${preserved ? `；已保留 ${preserved} 张成功素材，可单独重试失败模块` : ""}`;
    ElMessage.error(workflowError.value);
  } finally {
    running.generate = false;
    running.stage = "";
  }
}

async function generateMaterialResultsLegacy() {
  if (!canGenerate.value) {
    ElMessage.warning("请先生成优化建议");
    return;
  }
  running.generate = true;
  try {
    const originalCandidates = state.candidates.filter((item) => item.url && item.source !== "optimized");
    const generatedImages = [];
    const mainSource = originalCandidates.find((item) => item.kind === "main") || originalCandidates[0];
    running.stage = "正在生成 1 张新主图";
    const mainGeneration = await generateReviewedImage(mainSource, "main", 0);
    const mainImage = mainGeneration.url;
    if (!mainImage) throw new Error("主图生成接口未返回图片");
    generatedImages.push(buildGeneratedCandidate(mainSource, mainImage, "main", 0));

    const importedDetails = originalCandidates.filter((item) => item !== mainSource);
    const detailSources = form.optimizationScope === "main_only" ? [] : importedDetails.slice(0, 4);
    let detailDone = 0;
    const detailPromise = runWithConcurrency(detailSources, 2, async (source, index) => {
      const detailGeneration = await generateReviewedImage(detailSources[index], "detail", index, mainImage);
      const detailImage = detailGeneration.url;
      detailDone += 1;
      running.stage = `生成详情图 ${detailDone}/${detailSources.length}`;
      return detailImage ? buildGeneratedCandidate(source, detailImage, "detail", index) : null;
    });
    running.stage = "正在按新主图和商品事实生成标题、标签与描述";
    const copyPromise = generateValidatedCommerceCopy(mainImage);
    const [detailCandidates, copy] = await Promise.all([detailPromise, copyPromise]);
    generatedImages.push(...(form.optimizationScope === "main_only" ? importedDetails : detailCandidates.filter(Boolean)));
    const title = copy.titles?.[0] || form.title;
    const tags = copy.tags?.length ? copy.tags : splitLines(form.tags);
    const description = copy.description || form.description;
    const composedImages = await composeGeneratedImageText(generatedImages, title);
    generatedImages.splice(0, generatedImages.length, ...composedImages);
    const richContentJson = buildOptimizerRichContent(generatedImages.map((item) => item.url), title, description);
    running.stage = "正在按新主图和最终文案生成视频";
    const video = await generateOptimizerVideo(mainImage, copy, { title, tags, description });
    const videoUrls = video.url ? [video.url] : [];
    const videoCoverUrls = video.url ? [video.url] : [];
    const videoError = video.error;
    if (videoError) ElMessage.warning(`图片和文案已生成，但${videoError}`);
    const optimizedCandidates = generatedImages;
    state.candidates = [...originalCandidates, ...optimizedCandidates];
    state.finalImageSlots = (optimizedCandidates.length ? optimizedCandidates : originalCandidates).map((item, index) => ({
      slot: index + 1,
      role: index === 0 ? "main" : "detail",
      url: item.url,
      candidate_id: item.candidate_id,
      source: item.source,
      sort_order: index + 1
    }));
    state.generated = {
      imageCount: optimizedCandidates.length,
      title,
      tags,
      description,
      richContentJson,
      videoUrls,
      videoCoverUrls,
      videoError
    };
    ElMessage.success(`已真实生成 ${optimizedCandidates.length} 张新图片和完整商品文案`);
  } catch (error) {
    workflowError.value = error.message || "生成商品素材失败";
    ElMessage.error(error.message || "生成商品素材失败");
  } finally {
    running.generate = false;
    running.stage = "";
  }
}

function buildProductTruthContext() {
  return {
    operatorFacts: operatorProductFacts.value,
    sourceTitle: form.title,
    sourceDescription: form.description,
    sourceTags: splitLines(form.tags),
    operatorRequirements: form.userNote,
    verifiedFacts: analysisNodeRows("fixed_facts"),
    forbiddenChanges: [
      ...analysisNodeRows("forbidden_changes"),
      ...splitLines(planEditor.forbidden)
    ],
    optimizationPlan: {
      mainImage: planEditor.main,
      title: planEditor.title,
      tags: planEditor.tags,
      description: planEditor.description
    }
  };
}

function buildCopyGenerationPayload(generatedMainImageUrl = "") {
  const productTruth = buildProductTruthContext();
  const exactIdentity = [form.productTitleZh, form.compatibilityZh, ...operatorSellingPoints.value, ...analysisNodeRows("fixed_facts")].filter(Boolean).join("；");
  return {
    productName: form.productTitleZh || form.productName || form.title,
    title: form.title,
    tags: splitLines(form.tags),
    summary: form.description,
    sellingPoints: analysisNodeRows("fixed_facts").join("；"),
    exactProductIdentity: exactIdentity,
    mainImageOverlayPlan: mainOverlayPlan.value,
    copyStrategy: copyStrategy.value,
    optimizationTarget: form.userNote || "提高 Ozon 点击率和转化率，同时保持产品事实不变",
    rules: [
      promptEditor.textGlobalRules,
      "PROMPT PRIORITY: global rules and verified product facts are highest priority; operator requirements are second; AI optimization suggestions are third. When instructions conflict, always discard the lower-priority instruction.",
      "Treat productTruth as the single source of truth. The title must identify the exact product, verified compatibility, color and set quantity before secondary benefits.",
      "Never reduce the product to a generic category such as auto accessory, car product or universal item. Name the exact product subtype and form factor visible in the verified facts.",
      "Reject a title or selling point when replacing the exact product name with another product from the same category would leave the sentence equally valid. Rewrite it with product-specific facts.",
      "Do not use empty generic phrases such as high quality, premium quality, durable material, stylish design, practical solution, protects and decorates, or improves the experience unless tied to a verified concrete product fact.",
      `Follow this product-specific information order and copy policy: ${JSON.stringify(copyStrategy.value)}`,
      "The Russian title must include the exact product subtype, exact verified compatible model or audience, and the strongest verified differentiator. Include material, color or set quantity when verified and commercially useful.",
      "Generate 20 to 25 precise Russian search tags covering the exact product subtype, compatible model, use case, verified construction and verified benefits. Do not pad the list with unrelated generic traffic words.",
      "The description must explain what the exact product is, who or which verified model it fits, how it is used, and 2 to 4 verified benefits. Every claim must trace to productTruth or mainImageOverlayPlan.",
      "Generate tags, description and rich-content wording for that same exact product; do not drift to a generic auto accessory.",
      `SECOND PRIORITY - operator requirements: ${form.userNote || "No additional operator requirements."}`,
      "THIRD PRIORITY - AI optimization suggestions follow. Use them only when they do not conflict with global rules, verified facts or operator requirements.",
      planEditor.title,
      planEditor.tags,
      planEditor.description,
      planEditor.forbidden
    ].filter(Boolean),
    sourceContext: { analysis: state.analysis, plan: state.plan, generatedMainImageUrl, productTruth }
  };
}

function canonicalCopyToken(value = "") {
  return String(value || "").toLowerCase().replace(/^#+/, "").replace(/[_\s-]+/g, "").replace(/[^a-zа-яё0-9]/giu, "");
}

function significantCopyTokens(value = "") {
  return String(value || "").toLowerCase().match(/[a-zа-яё0-9]{3,}/giu) || [];
}

function commerceCopyQualityIssues(copy = {}) {
  const title = String(copy.titles?.[0] || copy.title || "").trim();
  const tags = Array.isArray(copy.tags) ? copy.tags.map((item) => String(item || "").trim()).filter(Boolean) : [];
  const description = String(copy.description || "").trim();
  const issues = [];
  const exactSubject = String(copyStrategy.value.exact_subject_ru || mainOverlayPlan.value.title || "").trim();
  const exactCompatibility = String(mainOverlayPlan.value.compatibility || "").trim();
  const subjectTokens = significantCopyTokens(exactSubject).filter((item) => !/^\d+$/.test(item));
  const compatibilityTokens = significantCopyTokens(exactCompatibility).filter((item) => !/^\d+$/.test(item));
  const titleTokens = new Set(significantCopyTokens(title));
  const genericTitle = /(автоаксессуар\s+для\s+автомобиля|прочный\s+материал|стильн(?:ый|ое|ая)\s+дизайн|практичн(?:ое|ый)\s+решени|высокое\s+качество|premium quality|high quality)/iu;
  if (!title) issues.push("标题为空");
  if (genericTitle.test(title)) issues.push("标题包含可套用于任意商品的泛化表达");
  if (subjectTokens.length && !subjectTokens.some((item) => titleTokens.has(item))) issues.push("标题没有明确写出精确商品子类");
  const canonicalTags = tags.map(canonicalCopyToken).filter(Boolean);
  if (new Set(canonicalTags).size !== canonicalTags.length) issues.push("标签存在同义或格式化重复");
  if (tags.length < 12) issues.push("有效精准标签不足 12 个");
  if (tags.length > 25) issues.push("标签超过 25 个");
  const genericTag = /^(#)?(автоаксессуар|автоаксессуары|товар|покупка|качество|стиль|дляавто)$/iu;
  if (tags.some((item) => genericTag.test(item.replace(/[_\s-]+/g, "")))) issues.push("标签包含无搜索区分度的泛化词");
  const tagTokens = new Set(significantCopyTokens(tags.join(" ")));
  const descriptionTokens = new Set(significantCopyTokens(description));
  const titleTokensForFacts = new Set(significantCopyTokens(title));
  if (compatibilityTokens.length && !compatibilityTokens.some((item) => titleTokensForFacts.has(item))) issues.push("标题没有包含已确认的适配车型或适用对象");
  if (subjectTokens.length && !subjectTokens.some((item) => tagTokens.has(item))) issues.push("标签没有覆盖精确商品类型");
  if (compatibilityTokens.length && !compatibilityTokens.some((item) => tagTokens.has(item))) issues.push("标签没有覆盖已确认的适配车型或适用对象");
  if (!description) issues.push("描述为空");
  if (subjectTokens.length && !subjectTokens.some((item) => descriptionTokens.has(item))) issues.push("描述没有明确说明精确商品类型");
  if (compatibilityTokens.length && !compatibilityTokens.some((item) => descriptionTokens.has(item))) issues.push("描述没有包含已确认的适配车型或适用对象");
  return issues;
}

function sanitizeCommerceCopy(copy = {}) {
  const seen = new Set();
  const tags = (Array.isArray(copy.tags) ? copy.tags : []).filter((item) => {
    const key = canonicalCopyToken(item);
    if (!key || seen.has(key) || /^(автоаксессуар|автоаксессуары|товар|покупка|качество|стиль|дляавто)$/iu.test(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 25);
  const issues = commerceCopyQualityIssues({ ...copy, tags });
  const generatedTitle = String(copy.titles?.[0] || copy.title || "").trim();
  const title = issues.some((item) => /标题/.test(item)) ? mainOverlayPlan.value.title : generatedTitle;
  return { ...copy, title, titles: [title].filter(Boolean), tags, qualityIssues: issues };
}

async function generateValidatedCommerceCopy(generatedMainImageUrl = "") {
  const payload = buildCopyGenerationPayload(generatedMainImageUrl);
  const first = sanitizeCommerceCopy(await generateAiCommerceCopy({ ...payload, aiTimeoutMs: 180_000 }, { timeoutMs: MATERIAL_COPY_WAIT_MS }));
  if (!first.qualityIssues.length) return { ...first, qualityStatus: "passed", rewriteCount: 0 };
  const rewritten = sanitizeCommerceCopy(await generateAiCommerceCopy({
    ...payload,
    aiTimeoutMs: 180_000,
    title: first.titles?.[0] || payload.title,
    tags: first.tags,
    previousRejectedCopy: first,
    rules: [
      ...(payload.rules || []),
      `QUALITY GATE REJECTED THE PREVIOUS COPY: ${first.qualityIssues.join("; ")}. Rewrite only the title, tags and description. Do not repeat the rejected wording.`,
      "The result must pass every quality issue listed above while preserving verified product truth."
    ]
  }, { timeoutMs: MATERIAL_COPY_WAIT_MS }));
  return { ...rewritten, qualityStatus: rewritten.qualityIssues.length ? "fallback" : "passed", rewriteCount: 1 };
}

async function generateOptimizerVideo(mainImage, copy = {}, finalCopy = {}) {
  try {
    const title = copy.titles?.[0] || form.title;
    const result = await generateAiVideo({
      imageUrl: mainImage,
      title,
      productName: form.productName || title,
      sourceId: form.sourceSku || form.sourceDraftId,
      description: finalCopy.description || copy.description || form.description,
      tags: finalCopy.tags || copy.tags || splitLines(form.tags),
      productTruth: buildProductTruthContext(),
      coverImageUrl: mainImage
    }, { sourceModule: "ai_product_material_optimizer", timeoutMs: MATERIAL_VIDEO_WAIT_MS });
    return { url: result?.video?.publishUrl || result?.video?.previewUrl || result?.video?.url || "", error: "" };
  } catch (error) {
    return { url: "", error: error.message || "视频生成失败" };
  }
}

async function runWithConcurrency(items = [], concurrency = 1, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, run));
  return results;
}

async function generateReviewedImage(source, role, index, visualAnchorUrl = "") {
  const initialPayload = plannedImagePayload(source, role, index);
  if (visualAnchorUrl) {
    initialPayload.sourceImageUrl = visualAnchorUrl.startsWith("data:") ? visualAnchorUrl : withImageToken(visualAnchorUrl);
    const fallbackUrl = source?.url || "";
    if (fallbackUrl) initialPayload.fallbackSourceImageUrl = fallbackUrl.startsWith("data:") ? fallbackUrl : withImageToken(fallbackUrl);
  }
  const initialResult = await generateAiImages(initialPayload, { timeoutMs: MATERIAL_IMAGE_WAIT_MS });
  const initialUrl = generatedImageUrl(initialResult);
  if (!initialUrl) return { url: "", review: null, retried: false };
  const review = await reviewGeneratedImage(source, role, index, initialUrl, visualAnchorUrl);
  if (review.pass || !review.corrections_en) return { url: initialUrl, review, retried: false };
  running.stage = role === "main" ? "主图复检未通过，正在定向修正" : `详情图 ${index + 1} 复检未通过，正在定向修正`;
  const retryPayload = {
    ...initialPayload,
    finalPrompt: sanitizeImagePrompt([
      initialPayload.finalPrompt,
      "QUALITY REVIEW CORRECTION - fix these material defects while preserving all valid product details and the established visual style:",
      review.corrections_en
    ].join("\n\n"))
  };
  try {
    const retryResult = await generateAiImages(retryPayload, { timeoutMs: MATERIAL_IMAGE_WAIT_MS });
    const retryUrl = generatedImageUrl(retryResult) || initialUrl;
    const retryReview = retryUrl === initialUrl ? review : await reviewGeneratedImage(source, role, index, retryUrl, visualAnchorUrl);
    return { url: retryUrl, review: retryReview, retried: true };
  } catch (error) {
    console.warn("AI material correction retry failed; preserving initial image", error);
    return { url: initialUrl, review, retried: false };
  }
}

function mainVisualDirections() {
  const rows = Array.isArray(state.plan?.main_visual_directions) ? state.plan.main_visual_directions : [];
  return rows.length >= 2 ? rows.slice(0, 3) : [
    { title_zh: "明亮棚拍", direction_en: "Bright premium studio presentation with a soft neutral background, crisp product separation, natural shadow and generous spacing." },
    { title_zh: "场景质感", direction_en: "Premium contextual presentation with subtle automotive environment cues, controlled depth, realistic lighting and a clearly dominant product." }
  ];
}

async function generateMainVisualOptions(source) {
  const directions = mainVisualDirections().slice(0, 2);
  running.stage = `正在生成 ${directions.length} 个主视觉方向`;
  const options = await runWithConcurrency(directions, 2, async (direction, index) => {
    const payload = plannedImagePayload(source, "main", 0);
    try {
      payload.finalPrompt = sanitizeImagePrompt([
        payload.finalPrompt,
        `MAIN VISUAL DIRECTION ${index + 1}: ${direction.direction_en}`,
        "Keep the exact verified product unchanged. Vary only the commercial presentation."
      ].join("\n\n"));
      const result = await generateAiImages(payload, { timeoutMs: MATERIAL_IMAGE_WAIT_MS });
      const url = generatedImageUrl(result);
      if (!url) throw new Error("主图方向未返回图片");
      const review = await reviewGeneratedImage(source, "main", 0, url);
      return { url, review, direction, payload, error: "" };
    } catch (error) {
      return { url: "", review: { pass: false, score: 0, corrections_en: "" }, direction, payload, error: error.message || `主图方向 ${index + 1} 生成失败` };
    }
  });
  const valid = options.filter((item) => item.url).sort((left, right) => {
    if (left.review.pass !== right.review.pass) return left.review.pass ? -1 : 1;
    return Number(right.review.score || 0) - Number(left.review.score || 0);
  });
  if (!valid.length) return { url: "", alternatives: [] };
  let selected = valid[0];
  const alternatives = valid.slice(1).map((item, index) => ({
    ...buildGeneratedCandidate(source, item.url, "main", index + 1),
    ...imageModelTypographyReview(item.review),
    title: `主图备选：${item.direction.title_zh || index + 2}`,
    prompt_summary: `${item.direction.title_zh || "备选方向"}；视觉复检 ${item.review.score || 0} 分`
  }));
  if (!selected.review.pass && selected.review.corrections_en) {
    running.stage = "最佳主视觉仍有实质问题，正在定向修正一次";
    const retryPayload = {
      ...selected.payload,
      finalPrompt: sanitizeImagePrompt([selected.payload.finalPrompt, "QUALITY REVIEW CORRECTION:", selected.review.corrections_en].join("\n\n"))
    };
    const retryResult = await generateAiImages(retryPayload, { timeoutMs: MATERIAL_IMAGE_WAIT_MS });
    const retryUrl = generatedImageUrl(retryResult);
    if (retryUrl) {
      alternatives.unshift({
        ...buildGeneratedCandidate(source, selected.url, "main", 0),
        ...imageModelTypographyReview(selected.review),
        title: `主图备选：${selected.direction.title_zh || "初始优选"}`,
        prompt_summary: `${selected.direction.title_zh || "初始优选"}；纠偏前版本`
      });
      const retryReview = await reviewGeneratedImage(source, "main", 0, retryUrl);
      selected = { ...selected, url: retryUrl, review: retryReview };
    }
  }
  return { url: selected.url, review: selected.review, direction: selected.direction, alternatives, retried: alternatives.some((item) => /纠偏前版本/.test(item.prompt_summary || "")) };
}

async function reviewGeneratedImage(source, role, index, generatedImageUrl, visualAnchorUrl = "") {
  const shot = storyboardShot(role, index) || {};
  const reviewKey = JSON.stringify({
    generatedImageUrl: String(generatedImageUrl || "").split("?")[0],
    visualAnchorUrl: String(visualAnchorUrl || source?.url || "").split("?")[0],
    role,
    index,
    required_copy_ru: shot.required_copy_ru || shot.overlay_text_ru || ""
  });
  if (imageReviewCache.has(reviewKey)) return imageReviewCache.get(reviewKey);
  try {
    const result = await apiClient.post("/api/ai-variant-lab/optimize/review-image", {
      generatedImageUrl: withImageToken(generatedImageUrl),
      referenceImageUrl: withImageToken(visualAnchorUrl || source?.url || form.mainImageUrl || mainImagePreview.value),
      role,
      shot: {
        ...shot,
        required_copy_ru: role === "main" ? {
          title: mainOverlayPlan.value.title,
          compatibility: mainOverlayPlan.value.compatibility,
          benefits: mainOverlayPlan.value.benefits.slice(0, 3)
        } : { explanation: detailOverlayText(storyboardShot(role, index), index) }
      },
      verifiedFacts: analysisNodeRows("fixed_facts"),
      forbiddenChanges: [...analysisNodeRows("forbidden_changes"), ...splitLines(planEditor.forbidden)]
    });
    const review = result.review || { pass: true, score: 0, issues_zh: [], corrections_en: "" };
    imageReviewCache.set(reviewKey, review);
    return review;
  } catch (error) {
    console.warn("AI material image review skipped", error);
    return { pass: true, score: 0, issues_zh: [], corrections_en: "" };
  }
}

async function composeGeneratedImageText(candidates, title) {
  return Promise.all(candidates.map(async (candidate, index) => {
    const shot = index === 0 ? storyboardShot("main", 0) : storyboardShot("detail", index - 1);
    const overlayText = index === 0 ? title : detailOverlayText(shot, index - 1);
    if (!overlayText || candidate.source !== "optimized") return candidate;
    try {
      const result = await apiClient.post("/api/ai-variant-lab/optimize/compose-text", {
        imageUrl: withImageToken(candidate.url),
        ...(index === 0 ? {
          title: overlayText,
          subtitle: mainOverlayPlan.value.compatibility,
          bullets: mainOverlayPlan.value.benefits
        } : { text: overlayText }),
        placement: index === 0 ? "top" : "bottom"
      });
      return result.url ? { ...candidate, url: result.url, typography_status: "done", typography_error: "", prompt_summary: `${candidate.prompt_summary || ""}；俄语文字已确定性排版` } : { ...candidate, typography_status: "failed", typography_error: "排版接口未返回图片" };
    } catch (error) {
      console.warn("AI material text composition skipped", error);
      return { ...candidate, typography_status: "failed", typography_error: error.message || "俄语排版失败" };
    }
  }));
}

function optimizerStoryboard() {
  const rows = Array.isArray(state.plan?.suite_storyboard)
    ? state.plan.suite_storyboard
    : Array.isArray(state.plan?.display_zh?.suite_storyboard) ? state.plan.display_zh.suite_storyboard : [];
  return rows.filter((item) => item && typeof item === "object");
}

function storyboardShot(role, index) {
  const rows = optimizerStoryboard();
  if (role === "main") return rows.find((item) => item.role === "main") || rows[0] || null;
  const details = rows.filter((item) => item.role !== "main");
  return details[index % Math.max(1, details.length)] || null;
}

function detailOverlayText(shot, index) {
  const value = String(shot?.overlay_text_ru || "").trim();
  if (value) return value;
  return ["Материалы и качество", "Простая установка", "Преимущества товара", "Внимание к деталям"][index % 4];
}

function buildImageGenerationPayload(source, role, index, visualAnchorUrl = "") {
  const sourceUrl = source?.url || form.mainImageUrl || mainImagePreview.value;
  const basePrompt = String(role === "main" ? promptEditor.mainImage : promptEditor.detailImages || promptEditor.mainImage).trim();
  const shot = storyboardShot(role, index);
  const rolePrompt = role === "main"
    ? "Create one clearly new premium marketplace hero image. Keep the product faithful and make its identity immediately understandable on mobile. Design the Russian headline, compatibility line and selling points as an integrated part of the composition with strong commercial hierarchy. Rebuild the background, layout, camera framing, lighting, shadows, spacing and visual hierarchy so the result is visibly different from the source. A watermark-removal-only or cleanup-only result is unacceptable."
    : [
      "Create a product feature detail image showing material, finish and construction clearly.",
      "Create an installation or real-use scenario detail image without inventing unsupported accessories.",
      "Create a benefit-focused detail image with clean visual hierarchy and no invented claims.",
      "Create a close-up detail image emphasizing verified structure and craftsmanship."
    ][index % 4];
  const storyboardPrompt = shot ? [
    `SHOT ROLE: ${shot.role || role}.`,
    `SHOT OBJECTIVE: ${shot.objective_zh || shot.objective || "Solve one buyer question using verified product facts."}`,
    `COMPOSITION: ${shot.composition_en || shot.composition || rolePrompt}`,
    `MUST SHOW: ${shot.must_show_en || shot.must_show || "Only verified product facts."}`,
    `TYPOGRAPHY ROLE: ${shot.typography_role || (role === "main" ? "identity" : role)}.`,
    `TYPOGRAPHY DIRECTION: ${shot.typography_direction_en || "Fit the wording to this shot without repeating a universal template."}`
  ].join("\n") : rolePrompt;
  const suiteContinuity = role === "main"
    ? "Establish the visual identity for the full product image set: background family, lighting direction, camera language, product scale, spacing and hierarchy."
    : "The reference image is the approved main visual for this same product. Preserve its exact product identity and continue its background family, lighting direction, camera language, product scale, spacing and hierarchy. Create a complementary detail shot, not another hero image.";
  const operatorPrompt = form.userNote || "Improve conversion while preserving product truth.";
  const requiredCopy = role === "main"
    ? {
      title: mainOverlayPlan.value.title,
      compatibility: mainOverlayPlan.value.compatibility,
      benefits: mainOverlayPlan.value.benefits.slice(0, 3)
    }
    : { explanation: detailOverlayText(shot, index) };
  const languageGuard = [
    "MANDATORY TYPOGRAPHY RULE: Remove every source-image caption, badge and marketing label outside the physical product.",
    "Render the following buyer-facing Russian copy directly into the final image, verbatim and fully legible. Do not translate, paraphrase, misspell, omit or invent any text:",
    JSON.stringify(requiredCopy),
    `PRODUCT-SPECIFIC VISUAL LANGUAGE: ${JSON.stringify(visualLanguage.value)}.`,
    "Use professional native ecommerce typography integrated with the visual composition. Keep the product dominant. Use a clear information hierarchy with no more than two font weights unless the visual-language plan explicitly requires otherwise.",
    "Do not use the same oversized bold black heading, underline, equal icon grid, caption position or poster template across the image set. Typography composition must respond to this shot's subject, negative space and buyer question.",
    "Avoid generic headings that could describe any product. Keep every rendered phrase specific to the exact product or the exact fact shown in this frame.",
    "Do not render Chinese, unrelated text, pseudo-text, watermarks or marketplace logos."
  ].join("\n");
  const aspectRatioGuard = [
    "MANDATORY OUTPUT ASPECT RATIO: The final image canvas must be exactly 3:4 (width:height).",
    "Compose the complete scene for a 3:4 portrait canvas from the start. Do not output 2:3, 9:16, or any other aspect ratio.",
    "Do not achieve 3:4 by cropping, stretching, squeezing, or cutting off the product, typography, background, or any edge of the composition. Keep all required content fully visible inside the 3:4 canvas."
  ].join("\n");
  return {
    finalPrompt: sanitizeImagePrompt([
      "STRICT PROMPT PRIORITY: 1) GLOBAL RULES AND VERIFIED PRODUCT FACTS; 2) OPERATOR REQUIREMENTS; 3) AI OPTIMIZATION SUGGESTIONS. If any instructions conflict, ignore the lower-priority instruction.",
      aspectRatioGuard,
      `HIGHEST PRIORITY - global rules: ${promptEditor.imageGlobalRules}`,
      `HIGHEST PRIORITY - verified product facts: ${JSON.stringify(buildProductTruthContext())}`,
      `SECOND PRIORITY - operator requirements: ${operatorPrompt}`,
      `THIRD PRIORITY - AI optimization suggestions: ${basePrompt}`,
      storyboardPrompt,
      suiteContinuity,
      languageGuard
    ].filter(Boolean).join("\n\n")),
    sourceImageUrl: (visualAnchorUrl || sourceUrl).startsWith("data:") ? (visualAnchorUrl || sourceUrl) : withImageToken(visualAnchorUrl || sourceUrl),
    ratio: "3:4",
    imageCount: 1,
    autoCrop: false
  };
}

function sanitizeImagePrompt(value = "") {
  return String(value || "")
    .replace(/[\ufffd\u952f\u9416\u920b\u93c3]/gu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function generatedImageUrl(result = {}) {
  const image = result.generatedImages?.[0] || result.croppedImages?.[0] || {};
  return image.publishUrl || image.publish_url || image.previewUrl || image.preview_url || image.url || "";
}

function previewMediaUrl(url = "") {
  const value = String(url || "").trim();
  if (!value || /[?&]token=/i.test(value)) return value;
  try {
    const parsed = new URL(value, window.location.origin);
    return parsed.pathname.startsWith("/api/") ? withImageToken(value) : value;
  } catch {
    return value.startsWith("/api/") ? withImageToken(value) : value;
  }
}

function applyMaterializedImageUrls(result = {}) {
  const urlMap = result.materialized_url_map || {};
  const rewriteUrl = (url) => urlMap[url] || url;
  if (!Object.keys(urlMap).length) return;
  state.candidates = state.candidates.map((candidate) => ({ ...candidate, url: rewriteUrl(candidate.url) }));
  state.finalImageSlots = (result.final_image_slots || state.finalImageSlots).map((slot, index) => ({
    ...slot, slot: index + 1, sort_order: index + 1, role: index === 0 ? "main" : "detail", url: rewriteUrl(slot.url)
  }));
  if (!state.generated) return;
  state.generated.richContentJson = rewriteImageUrlsInText(state.generated.richContentJson, urlMap);
  state.generated.variants = (state.generated.variants || []).map((variant) => ({
    ...variant,
    mainImage: rewriteUrl(variant.mainImage),
    images: (variant.images || []).map(rewriteUrl),
    richContentJson: rewriteImageUrlsInText(variant.richContentJson, urlMap)
  }));
}

function rewriteImageUrlsInText(value, urlMap) {
  let next = String(value || "");
  Object.entries(urlMap).forEach(([sourceUrl, finalUrl]) => { next = next.split(sourceUrl).join(finalUrl); });
  return next;
}

function buildGeneratedCandidate(source, url, role, index) {
  return {
    ...source,
    url,
    candidate_id: candidateKey(role === "main" ? "optimized_main" : "optimized_detail", index),
    kind: role,
    source: "optimized",
    source_candidate_id: source?.candidate_id || "",
    version: Number(source?.version || 1) + 1,
    title: role === "main" ? "AI 新主图" : `AI 新详情图 ${index + 1}`,
    prompt_summary: `${state.plan?.image_optimization_prompt_en || "按识别结果和人工备注生成"}；俄语文案由 image2 直接设计`,
    typography_status: "pending_review",
    typography_source: "image_model"
  };
}

function imageModelTypographyReview(review) {
  return {
    typography_status: review?.pass === true ? "done" : "failed",
    typography_error: review?.pass === true ? "" : (review?.issues_zh || []).join("；") || "俄语文案或版式未通过视觉审核"
  };
}

function upsertGeneratedCandidate(candidate) {
  if (!candidate?.candidate_id) return;
  const existingIndex = state.candidates.findIndex((item) => item.candidate_id === candidate.candidate_id);
  if (existingIndex >= 0) state.candidates.splice(existingIndex, 1, candidate);
  else state.candidates.push(candidate);
}

function checkpointGeneratedCandidate(candidate, role, index) {
  upsertGeneratedCandidate(candidate);
  const slotIndex = role === "main" ? 0 : index + 1;
  const slot = { slot: slotIndex + 1, role: role === "main" ? "main" : "detail", url: candidate.url, candidate_id: candidate.candidate_id, source: candidate.source, sort_order: slotIndex + 1 };
  if (slotIndex < state.finalImageSlots.length) state.finalImageSlots.splice(slotIndex, 1, slot);
  else state.finalImageSlots.splice(slotIndex, 0, slot);
  refreshSlotOrder();
  if (!state.generated) state.generated = { imageCount: 0, title: form.title, tags: splitLines(form.tags), description: form.description, richContentJson: "", videoUrls: [], videoCoverUrls: [], videoError: "", automaticMainCandidateId: "" };
  state.generated.imageCount = state.candidates.filter((item) => item.source === "optimized" && item.url).length;
  if (role === "main") state.generated.automaticMainCandidateId = candidate.candidate_id;
  saveActiveTaskWorkspace();
}

function buildOptimizerRichContent(imageUrls, title, description) {
  const images = (Array.isArray(imageUrls) ? imageUrls : [imageUrls]).filter(Boolean);
  if (!images.length || !description) return "";
  return JSON.stringify({
    content: images.slice(0, 1).map((imageUrl) => ({ widgetName: "raShowcase", type: "billboard", blocks: [{
      imgLink: "",
      img: { src: imageUrl, srcMobile: imageUrl, alt: title, position: "width_full", positionMobile: "width_full", widthMobile: 1024, heightMobile: 1536 },
      title: { items: [{ type: "text", content: title }], size: "size4", align: "left", color: "color1" },
      text: { items: [{ type: "text", content: description }], size: "size2", align: "left", color: "color1" }
    }] })),
    version: 0.3
  }, null, 2);
}

function moveSlot(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= state.finalImageSlots.length) return;
  const [item] = state.finalImageSlots.splice(index, 1);
  state.finalImageSlots.splice(target, 0, item);
  refreshSlotOrder();
}

function removeSlot(index) {
  state.finalImageSlots.splice(index, 1);
  refreshSlotOrder();
}

function selectMainVisual(candidate) {
  if (!candidate?.url || !state.finalImageSlots.length) return;
  state.finalImageSlots.splice(0, 1, { slot: 1, role: "main", url: candidate.url, candidate_id: candidate.candidate_id, source: candidate.source, sort_order: 1 });
  refreshSlotOrder();
  state.prepareResult = null;
  if (state.generated) {
    state.generated.richContentJson = buildOptimizerRichContent(state.finalImageSlots.map((item) => item.url), state.generated.title, state.generated.description);
  }
}

function buildOptimizationEvaluation() {
  const generated = state.candidates.filter((item) => item.source === "optimized");
  const selectedIds = new Set(state.finalImageSlots.map((item) => item.candidate_id).filter(Boolean));
  const selectedMainCandidateId = state.finalImageSlots[0]?.candidate_id || "";
  const automaticMainCandidateId = state.generated?.automaticMainCandidateId || "";
  return {
    schema_version: 1,
    main_option_count: mainVisualCandidates.value.length,
    automatic_main_candidate_id: automaticMainCandidateId,
    selected_main_candidate_id: selectedMainCandidateId,
    main_manually_overridden: Boolean(automaticMainCandidateId && selectedMainCandidateId && automaticMainCandidateId !== selectedMainCandidateId),
    generated_candidate_count: generated.length,
    selected_generated_count: generated.filter((item) => selectedIds.has(item.candidate_id)).length,
    retry_count: generated.filter((item) => item.was_retried).length,
    review_pass_count: generated.filter((item) => item.review_pass).length,
    candidates: generated.map((item) => ({
      candidate_id: item.candidate_id,
      kind: item.kind,
      quality_score: Number(item.quality_score || 0),
      review_pass: item.review_pass === true,
      was_retried: item.was_retried === true,
      selected: selectedIds.has(item.candidate_id),
      visual_direction: item.visual_direction || ""
    }))
  };
}

function refreshSlotOrder() {
  state.finalImageSlots.forEach((slot, slotIndex) => {
    slot.slot = slotIndex + 1;
    slot.sort_order = slotIndex + 1;
    slot.role = slotIndex === 0 ? "main" : "detail";
  });
}

function startSlotDrag(index) {
  draggedSlotIndex.value = index;
}

function dropSlot(targetIndex) {
  const sourceIndex = draggedSlotIndex.value;
  draggedSlotIndex.value = -1;
  if (sourceIndex < 0 || sourceIndex === targetIndex) return;
  const [item] = state.finalImageSlots.splice(sourceIndex, 1);
  state.finalImageSlots.splice(targetIndex, 0, item);
  refreshSlotOrder();
  state.prepareResult = null;
}

function parseTemplatePayload() {
  const text = form.templatePayloadText.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("模板 JSON 格式不正确");
  }
}

async function prepareTemplate(options = {}) {
  if (!canPrepare.value) {
    ElMessage.warning("请先选择最终图片位");
    return;
  }
  running.prepare = true;
  try {
    const result = await apiClient.post("/api/ai-variant-lab/optimize/prepare-template", {
      candidates: state.candidates,
      finalImageSlots: state.finalImageSlots,
      sourceProductId: form.sourceSku || form.sourceDraftId,
      optimizerJobNo: state.optimizerJobNo,
      templatePayload: parseTemplatePayload(),
      textResults: {
        title: state.generated?.title || form.title,
        tags: state.generated?.tags || splitLines(form.tags),
        description: state.generated?.description || form.description
      },
      userNote: form.userNote,
      plan: state.plan || {
        mode: "product_material_optimization",
        preview_only: true
      }
    });
    applyMaterializedImageUrls(result);
    state.prepareResult = result;
    if (options.navigate !== false) currentStep.value = "save";
    ElMessage.success("保存预览已生成");
  } catch (error) {
    ElMessage.error(error.message || "生成保存预览失败");
  } finally {
    running.prepare = false;
  }
}

async function saveResultToDraft() {
  await prepareTemplate({ navigate: false });
  if (!state.prepareResult) return;
  await saveGeneratedDraft();
}

async function saveGeneratedDraft(options = {}) {
  if (!state.prepareResult || !state.generated) return ElMessage.warning("请先完成真实生成并生成保存预览");
  if (!form.templateId && !parseTemplatePayload()?.id) return ElMessage.warning("当前素材缺少上架模板，请从草稿箱导入后再保存");
  running.saveDraft = true;
  state.savedDraftIds = [];
  try {
    const variantLimit = options.singleVariant ? 1 : 2;
    const variants = (state.generated.variants?.length ? state.generated.variants : [{ key: "A", images: state.finalImageSlots.map((item) => item.url).filter(Boolean), mainImage: state.finalImageSlots[0]?.url, richContentJson: state.generated.richContentJson, videoUrls: state.generated.videoUrls, videoCoverUrls: state.generated.videoCoverUrls }]).slice(0, variantLimit);
    const results = [];
    for (const variant of variants) {
      const offer = await apiClient.post("/api/listing/generate-offer-id", { prefix: `OPT-${variant.key}`, existingIds: [] });
      const offerId = String(offer.offerId || offer.offer_id || "").trim();
      const images = (variant.images || []).filter(Boolean);
      const mainOnly = form.optimizationScope === "main_only";
      const draftPatch = mainOnly
        ? { offer_id: offerId, images }
        : {
            title: state.generated.title,
            offer_id: offerId,
            description: state.generated.description,
            tags: state.generated.tags,
            images,
            rich_content_json: variant.richContentJson || state.generated.richContentJson,
            video_urls: variant.videoUrls || [],
            video_cover_urls: variant.videoCoverUrls || []
          };
      try {
        const draft = await apiClient.post("/api/listing/drafts/ai-variant-lightweight", {
      template_id: form.templateId,
      template_payload: state.prepareResult.template_patch,
      source_draft_id: form.sourceDraftId || "",
      source_variant_key: sourceTasks.value.find((item) => item.taskId === activeSourceTaskId.value)?.sourceVariantKey || "",
      source_variant_index: sourceTasks.value.find((item) => item.taskId === activeSourceTaskId.value)?.sourceVariantIndex ?? 0,
      clone_source_draft: true,
      development_type: "copy",
      shop_ids: form.sourceShopIds,
      product_name: `${state.generated.title} · ${variant.key}`,
      offer_id: offerId,
      internal_code: offerId,
      source_images: images,
      patch: draftPatch,
      manual_facts: {
        operator_product_facts: operatorProductFacts.value,
        source_product_id: form.sourceSku,
        source_draft_id: form.sourceDraftId,
        source_main_image_url: variant.mainImage || images[0] || "",
        main_candidate_id: variant.mainCandidateId || "",
        operator_note: form.userNote,
        optimizer_job_no: state.optimizerJobNo,
        generated_image_count: images.length,
        variant_key: variant.key,
        video_generation_error: variant.videoError || ""
      },
      ai_optimization: { source: "ai_product_material_optimizer", job_no: state.optimizerJobNo, analysis: state.analysis, plan: state.plan, evaluation: buildOptimizationEvaluation() },
      changed_fields: mainOnly ? ["offer_id", "images"] : ["offer_id", "title", "description", "tags", "images", "rich_content", "video_urls"]
        });
        const draftId = draft.id || draft.draft_id || "";
        variant.draftId = draftId;
        variant.saveStatus = "done";
        results.push(draftId);
      } catch (error) {
        variant.saveStatus = "failed";
        variant.saveError = error.message || "保存失败";
      }
    }
    state.savedDraftIds = results.filter(Boolean);
    state.savedDraftId = state.savedDraftIds[0] || "";
    const activeTask = sourceTasks.value.find((item) => item.taskId === activeSourceTaskId.value);
    if (activeTask) {
      activeTask.status = "done";
      activeTask.draftId = state.savedDraftIds.join(",");
      activeTask.error = "";
      saveActiveTaskWorkspace();
    }
    if (!state.savedDraftIds.length) throw new Error("两套草稿均保存失败");
    ElMessage.success(`已保存 ${state.savedDraftIds.length} 套复制草稿到草稿箱`);
  } catch (error) {
    ElMessage.error(error.message || "保存草稿失败");
  } finally {
    running.saveDraft = false;
  }
}
</script>

<template>
  <div class="material-optimizer-page">
    <div class="optimizer-header">
      <div>
        <h2>AI优化</h2>
        <p>按步骤完成素材导入、产品识别、建议生成、候选结果、Ozon 图片位和保存预览。</p>
      </div>
    </div>

    <el-steps :active="activeStepIndex" finish-status="success" class="optimizer-steps">
      <el-step v-for="step in steps" :key="step.key" :title="step.title" :description="step.desc" />
    </el-steps>

    <section v-show="currentStep === 'material'" class="step-panel">
      <div class="step-heading">
        <span class="step-index">1</span>
        <div>
          <h2>导入素材</h2>
          <p>先选择一个商品来源。导入后只检查素材是否正确，不在这一步做优化。</p>
        </div>
        <div class="step-heading-actions">
          <el-button type="primary" :loading="running.autoOptimize" :disabled="!canAnalyze" :icon="Camera" @click="confirmMaterialAndOptimize">确认素材并开始优化</el-button>
        </div>
      </div>

      <div v-if="sourceTasks.length" class="source-task-queue">
        <div class="block-heading">
          <strong>源变体任务</strong>
          <span>每个变体独立使用自己的 SKU、主图、详情图和草稿继承上下文。</span>
        </div>
        <div class="source-task-toolbar">
          <span>已选择 {{ selectedSourceTaskIds.length }} / {{ sourceTasks.length }}</span>
          <el-button
            v-if="sourceTasks.length > 1"
            type="primary"
            :loading="running.batchSource"
            :disabled="!selectedSourceTaskIds.length"
            @click="runSelectedSourceTasks"
          >批量优化并保存草稿</el-button>
        </div>
        <div class="source-task-list">
          <div
            v-for="task in sourceTasks"
            :key="task.taskId"
            class="source-task-row"
            :class="{ active: task.taskId === activeSourceTaskId }"
            @click="activateSourceTask(task)"
          >
            <el-checkbox
              :model-value="selectedSourceTaskIds.includes(task.taskId)"
              :disabled="running.batchSource"
              @click.stop
              @change="(checked) => toggleSourceTask(task.taskId, checked)"
            />
            <el-image v-if="task.imageUrl" :src="previewMediaUrl(task.imageUrl)" fit="cover" :preview-src-list="[previewMediaUrl(task.imageUrl)]" preview-teleported @click.stop />
            <div>
              <strong>{{ task.title }}</strong>
              <span>{{ task.sourceSku || task.sourceVariantKey }} · {{ task.detailImages.length }} 张详情图</span>
              <em v-if="task.error">{{ task.error }}</em>
            </div>
            <el-tag :type="sourceTaskStatusType(task.status)" effect="light">{{ sourceTaskStatusLabel(task.status) }}</el-tag>
            <el-button v-if="task.draftId" size="small" tag="a" :href="`/admin.html#/listing-automation?draftId=${task.draftId}`" target="_blank" @click.stop>草稿 {{ task.draftId }}</el-button>
            <el-tooltip content="移除该变体" placement="top">
              <el-button class="source-task-remove" circle type="danger" plain :icon="Delete" :disabled="running.batchSource" aria-label="移除该变体" @click.stop="removeSourceTask(task.taskId)" />
            </el-tooltip>
          </div>
        </div>
      </div>

      <div class="material-layout">
        <div class="import-panel">
          <div class="block-heading">
            <strong>素材来源</strong>
            <span>从已有商品导入，或临时补充主图链接。</span>
          </div>
          <div class="import-actions">
            <el-button :icon="Files" @click="openImportDialog('collector')">从采集箱导入</el-button>
            <el-button :icon="DocumentChecked" @click="openImportDialog('draft')">从草稿箱导入</el-button>
            <el-button :icon="Connection" @click="openImportDialog('online')">从在线商品导入</el-button>
            <el-upload :auto-upload="false" :show-file-list="false" accept="image/*" :on-change="onSourceImageChange">
              <el-button :icon="UploadFilled">临时上传主图</el-button>
            </el-upload>
          </div>

          <div class="material-card" :class="{ empty: !mainImagePreview }">
            <img v-if="mainImagePreview" :src="mainImagePreview" alt="商品主图">
            <div v-else class="image-placeholder"><el-icon><Picture /></el-icon><span>待导入主图</span></div>
            <div class="material-meta">
              <strong>{{ form.productName || form.title || "未选择商品素材" }}</strong>
              <span>{{ form.sourceSku || "导入后显示 SKU / 草稿 / 采集记录编号" }}</span>
              <em>{{ detailImageCount }} 张详情图，{{ form.title ? "已带入标题" : "暂未带入标题" }}</em>
            </div>
          </div>
        </div>

      </div>

      <div class="material-optimization-settings product-facts-confirmation">
        <div class="section-title">
          <strong>先确认商品文本事实</strong>
          <span>以下中文内容是标题、标签、描述和图片文字的最高优先级依据，AI 只能围绕这些事实优化。</span>
        </div>
        <label>
          <span>中文精确产品名称（必填）</span>
          <el-input
            v-model="form.productTitleZh"
            placeholder="例如：奇瑞瑞虎8 Pro车门防踢垫"
            @input="form.productFactsConfirmed = false"
          />
        </label>
        <label>
          <span>适配车型 / 适用对象</span>
          <el-input
            v-model="form.compatibilityZh"
            type="textarea"
            :rows="2"
            placeholder="每行一个，例如：奇瑞瑞虎8 Pro 2022–2025款"
            @input="form.productFactsConfirmed = false"
          />
        </label>
        <label>
          <span>中文核心卖点（至少 2 条）</span>
          <el-input
            v-model="form.sellingPointsZh"
            type="textarea"
            :rows="4"
            placeholder="每行一条，只填写可以确认的材质、数量、安装方式、用途或结构卖点"
            @input="form.productFactsConfirmed = false"
          />
        </label>
        <label>
          <span>禁止 AI 编写的内容</span>
          <el-input
            v-model="form.forbiddenFactsZh"
            type="textarea"
            :rows="3"
            placeholder="例如：不能写成门槛条；不能写金属材质；不能声称官方授权"
            @input="form.productFactsConfirmed = false"
          />
        </label>
        <el-checkbox v-model="form.productFactsConfirmed">
          我已确认以上产品名称和卖点真实准确，后续俄语文案与图片文字必须以此为准
        </el-checkbox>
        <el-alert
          v-if="!productFactsReady"
          title="请填写精确产品名称、至少 2 条真实卖点并勾选确认，之后才能开始 AI 识别。"
          type="warning"
          show-icon
          :closable="false"
        />
      </div>

      <el-collapse class="advanced-fields">
        <el-collapse-item title="高级字段（导入异常时再展开修改）" name="advanced">
          <div class="text-layout">
            <label><span>商品名称</span><el-input v-model="form.productName" /></label>
            <label><span>SKU / 草稿编号</span><el-input v-model="form.sourceSku" /></label>
            <label><span>主图链接</span><el-input v-model="form.mainImageUrl" clearable @change="resetGeneratedState" /></label>
            <label><span>详情图链接</span><el-input v-model="form.detailImageText" type="textarea" :rows="3" placeholder="每行一张；选中的详情图会一起进入识别和候选池" /></label>
            <label><span>标题</span><el-input v-model="form.title" /></label>
            <label><span>标签</span><el-input v-model="form.tags" type="textarea" :rows="3" placeholder="空格分隔，例如 #TENET_T4 #органайзер #автоаксессуары" /></label>
            <label><span>描述</span><el-input v-model="form.description" type="textarea" :rows="4" /></label>
            <label><span>原模板 JSON</span><el-input v-model="form.templatePayloadText" type="textarea" :rows="4" /></label>
          </div>
        </el-collapse-item>
      </el-collapse>
      <div class="material-optimization-settings">
        <label>
          <span>优化范围</span>
          <el-segmented v-model="form.optimizationScope" :options="[
            { label: '完整优化：主图 + 详情图', value: 'full' },
            { label: '轻量优化：只改主图', value: 'main_only' }
          ]" />
        </label>
        <label>
          <span>人工优化备注</span>
          <el-input v-model="form.userNote" type="textarea" :rows="3" placeholder="补充希望优化的方向，以及不能改变的产品事实。" />
        </label>
      </div>
      <div class="step-footer">
        <span>确认每个变体的主图和详情图正确后，再开始识别与生成。</span>
      </div>
    </section>

    <section v-show="currentStep === 'recognize'" class="step-panel">
      <div class="step-heading">
        <span class="step-index">2</span>
        <div>
          <h2>识别产品</h2>
          <p>AI 会先锁定产品主体、颜色、结构、数量等不能改变的内容，再决定哪些背景和文案可以优化。</p>
        </div>
        <div class="step-heading-actions">
          <el-button v-if="!state.analysis" type="primary" :loading="running.analyze" :disabled="!canAnalyze" @click="analyzeMaterial">{{ workflowError ? "重新识别" : "识别产品" }}</el-button>
          <el-button v-else-if="!state.analysisConfirmed" type="primary" :loading="running.confirmAnalysis" @click="confirmAnalysisNode">确认并保存识别结果</el-button>
          <el-button v-else type="primary" @click="goStep('plan')">进入生成建议</el-button>
        </div>
      </div>

      <el-alert v-if="workflowError" :title="workflowError" type="error" show-icon :closable="false" class="step-alert" />

      <div class="block-heading">
        <strong>识别素材</strong>
        <span>主图优先，详情图作为辅助参考。</span>
      </div>
      <div class="recognition-progress" :class="`is-${recognitionProgress.status}`">
        <div class="recognition-progress-main">
          <span class="recognition-progress-dot" aria-hidden="true"></span>
          <div>
            <strong>{{ recognitionProgress.status === "running" ? "AI 识别进行中" : recognitionProgress.status === "awaiting_confirmation" ? "识别结果已生成" : recognitionProgress.status === "confirmed" ? "识别节点已确认" : recognitionProgress.status === "failed" ? "识别未完成" : "等待开始识别" }}</strong>
            <span>{{ recognitionProgress.message }}</span>
          </div>
        </div>
        <span v-if="recognitionProgress.status === 'running'" class="recognition-progress-time">已等待 {{ recognitionProgress.elapsedSeconds }} 秒</span>
        <span v-else-if="recognitionProgress.status === 'awaiting_confirmation'" class="recognition-progress-next">请检查下方结果后确认</span>
      </div>
      <div class="candidate-grid">
        <div v-for="item in state.candidates" :key="item.candidate_id" class="candidate-tile">
          <el-tooltip v-if="item.kind !== 'main' && item.source !== 'optimized'" content="移除详情图" placement="top">
            <el-button
              class="candidate-remove"
              circle
              type="danger"
              :icon="Delete"
              aria-label="移除详情图"
              @click.stop="removeDetailCandidate(item.candidate_id)"
            />
          </el-tooltip>
          <el-image :src="previewMediaUrl(item.url)" fit="cover" :preview-src-list="[previewMediaUrl(item.url)]" preview-teleported />
          <div class="candidate-meta">
            <strong>{{ item.title || item.kind }}</strong>
            <span>{{ item.source }} / v{{ item.version }}</span>
          </div>
        </div>
      </div>

      <div class="block-heading">
        <strong>识别结果</strong>
        <span>先确认不能改变的产品事实，再进入优化建议。</span>
      </div>
      <div class="insight-grid">
        <div>
          <h4>产品事实锁定</h4>
          <ul v-if="recognitionFactRows.length">
            <li v-for="item in recognitionFactRows" :key="item">{{ item }}</li>
          </ul>
          <el-empty v-else description="点击识别后展示" />
        </div>
        <div>
          <h4>当前问题</h4>
          <ul v-if="recognitionProblemRows.length">
            <li v-for="item in recognitionProblemRows" :key="item">{{ item }}</li>
          </ul>
          <el-empty v-else description="等待识别" />
        </div>
        <div>
          <h4>禁止改变</h4>
          <ul v-if="recognitionForbiddenRows.length">
            <li v-for="item in recognitionForbiddenRows" :key="item">{{ item }}</li>
          </ul>
          <el-empty v-else description="等待识别" />
        </div>
      </div>
      <div class="step-footer">
        <span>{{ state.analysisConfirmed ? "识别节点已确认并保存。" : state.analysis ? "请检查识别结果，确认后保存到数据库。" : "点击识别后会在本页展示结果。" }}</span>
        <div class="step-actions">
          <el-button @click="goStep('material')">返回上一步</el-button>
        </div>
      </div>
    </section>

    <section v-show="currentStep === 'plan'" class="step-panel">
      <div class="step-heading">
        <span class="step-index">3</span>
        <div>
          <h2>生成计划</h2>
          <p>先确认主图信息层级、视觉方向、详情图分镜和执行模块；确认后才会调用付费生成。</p>
        </div>
        <div class="step-heading-actions">
          <el-button v-if="!state.plan" type="primary" :loading="running.plan" :disabled="!canPlan" @click="planMaterial">生成建议</el-button>
          <el-button v-else type="primary" :loading="running.confirmPlan" :disabled="generationPlanBlockers.length > 0" @click="confirmPlanAndGenerate">确认并保存生成计划</el-button>
        </div>
      </div>

      <el-alert v-if="running.plan" title="正在整理商品事实并生成完整蓝图" type="warning" show-icon :closable="false" class="step-alert" />
      <el-alert v-else-if="!state.plan" title="尚未生成建议，请点击右上角“生成建议”" type="info" show-icon :closable="false" class="step-alert" />
      <el-alert v-if="workflowError && !running.plan" :title="workflowError" type="error" show-icon :closable="false" class="step-alert" />
      <section class="plan-target-panel">
        <div class="block-heading">
          <strong>本次生成目标</strong>
          <span>{{ planProgress.message }}</span>
        </div>
        <div class="plan-target-grid">
          <article v-for="target in planTargets" :key="target.key" :class="`is-${target.status}`">
            <div>
              <strong>{{ target.title }}</strong>
              <span>{{ target.detail }}</span>
            </div>
            <el-tag :type="generationStatusType(target.status)" effect="light">{{ planTargetStatusLabel(target.status) }}</el-tag>
            <el-button v-if="target.status === 'failed'" size="small" type="primary" plain :loading="running.plan" @click="planMaterial">重试建议</el-button>
          </article>
        </div>
      </section>
      <section v-if="state.plan" class="generation-blueprint">
        <div class="generation-blueprint-heading">
          <div><strong>本次生成蓝图</strong><span>以下内容会直接控制图片、文案和套图生成</span></div>
          <el-tag type="success" effect="light">计划就绪</el-tag>
        </div>
        <div class="main-copy-blueprint">
          <span>主图信息层级</span>
          <strong>{{ mainOverlayPlan.title }}</strong>
          <em>{{ mainOverlayPlan.compatibility }}</em>
          <div>
            <b v-for="benefit in mainOverlayPlan.benefits" :key="benefit">{{ benefit }}</b>
            <b v-if="!mainOverlayPlan.benefits.length">等待已验证卖点</b>
          </div>
        </div>
        <div class="blueprint-section">
          <span>主视觉方向</span>
          <div class="direction-plan-grid">
            <article v-for="(direction, index) in mainDirectionPreview" :key="`${direction.title_zh}-${index}`">
              <i>{{ index + 1 }}</i><div><strong>{{ direction.title_zh }}</strong><span>{{ direction.direction_en }}</span></div>
            </article>
          </div>
        </div>
        <div class="blueprint-section">
          <span>套图分镜</span>
          <div class="storyboard-plan-grid">
            <article v-for="(shot, index) in storyboardPreview" :key="`${shot.role}-${index}`">
              <i>{{ index + 1 }}</i><strong>{{ shot.title_zh || shot.role }}</strong><span>{{ shot.objective_zh }}</span><em v-if="shot.overlay_text_ru">{{ shot.overlay_text_ru }}</em>
            </article>
          </div>
        </div>
      </section>

      <el-alert
        v-if="state.plan && generationPlanBlockers.length"
        :title="`计划暂不能执行：${generationPlanBlockers.join('；')}`"
        type="error"
        show-icon
        :closable="false"
        class="step-alert"
      />

      <div v-if="state.generationPlan" class="generation-plan-panel">
        <div class="generation-plan-heading">
          <div><strong>执行模块</strong><span>可关闭本次不需要生成的模块</span></div>
          <label><span>图片并发</span><el-input-number v-model="state.generationPlan.imageConcurrency" :min="1" :max="6" controls-position="right" /></label>
        </div>
        <div class="generation-plan-list">
          <div v-for="module in state.generationPlan.modules" :key="module.id" class="generation-plan-row">
            <el-checkbox v-model="module.enabled" :disabled="module.id === 'assemble'" />
            <div><strong>{{ module.name }}</strong><span>{{ module.summary }}</span></div>
            <el-tag type="info" effect="light">待执行</el-tag>
            <el-button size="small" @click="promptReviewDialog.visible = true">查看提示词</el-button>
          </div>
        </div>
      </div>
      <div class="step-footer">
        <span>{{ state.plan ? "计划已生成；确认后才会开始真实生成并产生模型费用。" : running.plan ? "正在生成建议，请稍候。" : "生成目标已列出，点击右上角生成建议。" }}</span>
        <div class="step-actions">
          <el-button @click="goStep('recognize')">返回上一步</el-button>
        </div>
      </div>
    </section>

    <section v-show="currentStep === 'generate'" class="step-panel">
      <div class="step-heading">
        <span class="step-index">4</span>
        <div>
          <h2>生成结果</h2>
          <p>按建议一键生成图片候选和文字预览。生成结果先进入候选池，不会直接覆盖模板图片位。</p>
        </div>
        <div class="step-heading-actions">
          <el-button v-if="!state.generated && !state.generationPlan" type="primary" :loading="running.autoOptimize" :disabled="running.autoOptimize || !canAnalyze" @click="continueMaterialOptimization">继续识别并生成计划</el-button>
          <el-button v-else-if="!state.generated" type="primary" :loading="running.generate" :disabled="running.generate || !canGenerate" @click="generateMaterialResults">按已保存计划开始生成</el-button>
          <el-button v-else type="primary" :loading="running.prepare || running.saveDraft" :disabled="!canPrepare" @click="saveResultToDraft">保存到草稿箱</el-button>
        </div>
      </div>

      <el-collapse v-if="state.analysis || state.plan" class="prompt-review">
        <el-collapse-item title="识别结果与优化建议审核" name="review">
          <div class="insight-grid">
            <div><h4>产品事实锁定</h4><ul><li v-for="item in recognitionFactRows" :key="item">{{ item }}</li></ul></div>
            <div><h4>主图建议</h4><el-input v-model="planEditor.main" type="textarea" :rows="6" /></div>
            <div><h4>详情图建议</h4><el-input v-model="planEditor.detail" type="textarea" :rows="6" /></div>
          </div>
        </el-collapse-item>
      </el-collapse>

      <div v-if="state.generationPlan" class="generation-plan-panel">
        <div class="generation-plan-heading">
          <div><strong>执行进度</strong><span>各模块完成后会立即更新，失败模块不会中断其他模块。</span></div>
        </div>
        <div class="generation-plan-list">
          <div v-for="module in state.generationPlan.modules" :key="module.id" class="generation-plan-row">
            <div><strong>{{ module.name }}</strong><span>{{ module.summary }}</span><em v-if="module.error">{{ module.error }}</em></div>
            <el-tag :type="generationStatusType(module.status)" effect="light">{{ generationStatusLabel(module.status) }}</el-tag>
            <el-button v-if="state.generated && module.enabled" size="small" :loading="module.status === 'running'" @click="retryGenerationModule(module.id)">重新生成</el-button>
          </div>
        </div>
      </div>

      <div class="block-heading">
        <strong>生成结果表</strong>
        <span>真实调用图片、文案和视频模型；不是复制原图预览。</span>
      </div>
      <div class="result-review-toolbar">
        <span>提示词默认隐藏，生成或重新生成时仍使用当前审核版本。</span>
        <el-button :disabled="!state.plan" @click="promptReviewDialog.visible = true">查看 / 修改提示词</el-button>
      </div>
      <el-alert v-if="workflowError" :title="workflowError" type="error" show-icon :closable="false" class="step-alert">
        <template #default>
          <el-button type="danger" plain :loading="running.autoOptimize" @click="continueMaterialOptimization">从当前阶段继续优化</el-button>
        </template>
      </el-alert>
      <el-alert v-if="typographyIncomplete" title="部分图片没有通过俄语文案审核，仍可保存当前结果；建议之后单独重新生成对应主图或详情图。" type="warning" show-icon :closable="false" class="step-alert" />
      <el-alert v-if="state.generated?.copyQualityIssues?.length" :title="`标题/标签已自动重写并启用精确标题兜底：${state.generated.copyQualityIssues.join('；')}`" type="warning" show-icon :closable="false" class="step-alert" />
      <el-alert v-if="running.autoOptimize || running.generate" :title="running.stage || '正在识别并生成商品素材'" type="warning" show-icon :closable="false" class="step-alert" />
      <el-table :data="generatedResultRows" border class="result-table">
        <el-table-column label="商品" width="180" fixed="left">
          <template #default="{ row }">
            <div class="result-product">
              <strong>{{ row.productName }}</strong>
              <span>{{ row.sourceSku }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="主图结果" width="132" align="center">
          <template #default="{ row }">
            <el-image v-if="row.mainImage" class="result-thumb" :src="previewMediaUrl(row.mainImage)" fit="cover" :preview-src-list="[previewMediaUrl(row.mainImage)]" preview-teleported />
            <span v-else class="muted-text">待生成</span>
          </template>
        </el-table-column>
        <el-table-column label="详情图结果" width="160" align="center">
          <template #default="{ row }">
            <div v-if="row.detailImages.length" class="detail-preview-stack">
              <el-image v-for="url in row.detailImages.slice(0, 3)" :key="url" class="detail-thumb" :src="previewMediaUrl(url)" fit="cover" :preview-src-list="row.detailImages.map(previewMediaUrl)" preview-teleported />
              <span v-if="row.detailImages.length > 3">+{{ row.detailImages.length - 3 }}</span>
            </div>
            <span v-else class="muted-text">无详情图</span>
          </template>
        </el-table-column>
        <el-table-column label="标题" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">{{ row.title || "待生成标题" }}</template>
        </el-table-column>
        <el-table-column label="标签" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">{{ row.tags.length ? row.tags.join(" ") : "待生成标签" }}</template>
        </el-table-column>
        <el-table-column label="描述" min-width="320" show-overflow-tooltip>
          <template #default="{ row }">{{ row.description || "待生成描述" }}</template>
        </el-table-column>
        <el-table-column label="富文本/视频" width="130" align="center">
          <template #default="{ row }">
            <div class="module-progress">
              <el-tag :type="row.richContentJson ? 'success' : 'info'" effect="light">富文本</el-tag>
              <el-tag :type="row.videoUrls?.length ? 'success' : 'info'" effect="light">视频</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态/操作" width="190" fixed="right" align="center">
          <template #default="{ row }">
            <div class="result-actions">
              <el-tag :type="row.status === '保存失败' ? 'danger' : (row.status === '已保存' ? 'success' : 'info')" effect="light">方案 {{ row.variantKey }}：{{ row.status }}</el-tag>
              <el-button v-if="state.generated" size="small" @click="generateMaterialResults">重新生成</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="state.finalImageSlots.length" class="result-slot-editor">
        <div v-if="mainVisualCandidates.length > 1" class="main-direction-strip">
          <div class="main-direction-heading">
            <strong>主视觉方向</strong>
            <span>系统已按复检分自动选择，可手动改选</span>
          </div>
          <button
            v-for="candidate in mainVisualCandidates"
            :key="candidate.candidate_id"
            type="button"
            class="main-direction-option"
            :class="{ active: state.finalImageSlots[0]?.candidate_id === candidate.candidate_id }"
            @click="selectMainVisual(candidate)"
          >
            <el-image :src="previewMediaUrl(candidate.url)" fit="cover" />
            <span>{{ candidate.visual_direction || candidate.title || "主图方向" }}</span>
            <em>{{ candidate.quality_score ? `${candidate.quality_score} 分` : "待评分" }}</em>
          </button>
        </div>
        <div class="block-heading">
          <strong>图片顺序</strong>
          <span>按住图片拖拽排序；第一张自动作为主图，其余作为详情图。</span>
        </div>
        <div class="slot-drag-grid">
          <div
            v-for="(slot, index) in state.finalImageSlots"
            :key="slot.candidate_id || slot.url"
            class="slot-drag-card"
            draggable="true"
            @dragstart="startSlotDrag(index)"
            @dragover.prevent
            @drop.prevent="dropSlot(index)"
            @dragend="draggedSlotIndex = -1"
          >
            <span class="slot-index">{{ index + 1 }}</span>
            <el-image :src="previewMediaUrl(slot.url)" fit="cover" :preview-src-list="[previewMediaUrl(slot.url)]" preview-teleported />
            <strong>{{ index === 0 ? "主图" : `详情图 ${index}` }}</strong>
            <el-button size="small" type="danger" plain @click="removeSlot(index)">移除</el-button>
          </div>
        </div>
      </div>
      <div class="step-footer">
        <span>{{ state.generated ? "结果已进入候选池，下一步选择 Ozon 图片位。" : "点击生成后会在上方表格展示结果。" }}</span>
        <div class="step-actions">
          <el-button @click="goStep('plan')">返回生成计划</el-button>
        </div>
      </div>
    </section>

    <section v-if="false" class="step-panel">
      <div class="step-heading">
        <span class="step-index">5</span>
        <div>
          <h2>选择 Ozon 图片位</h2>
          <p>只有这里保留的图片会写入模板和上架图片。候选池会保存参考，不会被 Ozon 当作上架图。</p>
        </div>
      </div>

      <el-alert
        :title="`已生成 ${generatedCandidateCount} 张候选图，当前选择 ${selectedImageCount} 个 Ozon 图片位`"
        type="info"
        show-icon
        :closable="false"
        class="step-alert"
      />

      <div class="slot-list">
        <div v-for="(slot, index) in state.finalImageSlots" :key="`${slot.url}-${index}`" class="slot-row">
          <span class="slot-index">{{ index + 1 }}</span>
          <el-image :src="previewMediaUrl(slot.url)" fit="cover" :preview-src-list="[previewMediaUrl(slot.url)]" preview-teleported />
          <div class="slot-body">
            <strong>{{ index === 0 ? "主图" : "详情图" }}</strong>
            <span>{{ slot.url }}</span>
          </div>
          <el-button-group>
            <el-button size="small" :disabled="index === 0" @click="moveSlot(index, -1)">上移</el-button>
            <el-button size="small" :disabled="index === state.finalImageSlots.length - 1" @click="moveSlot(index, 1)">下移</el-button>
            <el-button size="small" type="danger" plain @click="removeSlot(index)">移除</el-button>
          </el-button-group>
        </div>
        <el-empty v-if="!state.finalImageSlots.length" description="暂无最终图片位" />
      </div>
      <div class="step-footer">
        <span>这里的顺序就是保存给 Ozon 的图片顺序。</span>
        <div class="step-actions">
          <el-button @click="goStep('generate')">返回上一步</el-button>
          <el-button type="primary" :loading="running.prepare" :disabled="!canPrepare" @click="prepareTemplate">生成保存预览</el-button>
        </div>
      </div>
    </section>

    <section v-if="false" class="step-panel">
      <div class="step-heading">
        <span class="step-index">5</span>
        <div>
          <h2>保存预览</h2>
          <p>检查主图位、详情图顺序、俄语文案、富文本和视频，然后保存为可继续编辑和上架的草稿。</p>
        </div>
      </div>

      <el-descriptions v-if="state.prepareResult" :column="3" border>
        <el-descriptions-item label="主图">{{ state.prepareResult.publish_preview.primary_image }}</el-descriptions-item>
        <el-descriptions-item label="图片数量">{{ state.prepareResult.publish_preview.image_count }}</el-descriptions-item>
        <el-descriptions-item label="图片来源">{{ state.prepareResult.publish_preview.uses_final_image_slots ? "最终图片位" : "-" }}</el-descriptions-item>
      </el-descriptions>
      <el-input
        v-if="state.prepareResult"
        :model-value="JSON.stringify(state.prepareResult.template_patch, null, 2)"
        type="textarea"
        :rows="12"
        readonly
        class="preview-json"
      />
      <el-empty v-else description="尚未生成保存预览" />
      <div class="step-footer">
        <span>{{ state.savedDraftId ? `已保存草稿 ${state.savedDraftId}` : "保存前可以返回图片位调整顺序。" }}</span>
        <div class="step-actions">
          <el-button @click="goStep('generate')">返回生成结果</el-button>
          <el-button v-if="state.savedDraftId" type="success" tag="a" :href="`/admin.html#/listing-automation?draftId=${state.savedDraftId}&source=ai_product_material_optimizer`" target="_blank">打开草稿</el-button>
          <el-button type="primary" :loading="running.saveDraft" :disabled="!state.prepareResult || !state.generated" @click="saveGeneratedDraft">保存到草稿箱</el-button>
        </div>
      </div>
    </section>

    <AiProductImportDialog ref="importDialogRef" confirm-text="导入为素材" @import="handleDialogImport" />
    <el-dialog v-model="promptReviewDialog.visible" title="提示词审核" width="920px" destroy-on-close>
      <div class="prompt-editor-grid prompt-dialog-grid">
        <label><span>图片全局规则提示词</span><el-input v-model="promptEditor.imageGlobalRules" type="textarea" :rows="6" /></label>
        <label><span>文本全局规则提示词</span><el-input v-model="promptEditor.textGlobalRules" type="textarea" :rows="6" /></label>
        <label v-if="generationModule('main')"><span>最终主图提示词</span><el-input v-model="generationModule('main').prompt" type="textarea" :rows="8" /></label>
        <label v-else><span>主图建议提示词</span><el-input v-model="promptEditor.mainImage" type="textarea" :rows="8" /></label>
        <template v-if="generationModule('details')?.prompts?.length">
          <label v-for="(_, index) in generationModule('details').prompts" :key="`detail-prompt-${index}`">
            <span>最终详情图 {{ index + 1 }} 提示词</span>
            <el-input v-model="generationModule('details').prompts[index]" type="textarea" :rows="7" />
          </label>
        </template>
        <label v-else><span>详情图建议提示词</span><el-input v-model="promptEditor.detailImages" type="textarea" :rows="8" /></label>
      </div>
      <template #footer>
        <el-button @click="promptReviewDialog.visible = false">关闭</el-button>
        <el-button v-if="state.generated" type="primary" :disabled="!state.plan" @click="promptReviewDialog.visible = false; generateMaterialResults()">按当前提示词重新生成</el-button>
        <el-button v-else type="primary" @click="promptReviewDialog.visible = false">确认提示词</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.material-optimizer-page {
  padding: 18px;
  color: #1f2937;
  background: #f6f8fb;
  min-height: calc(100vh - 48px);
}

.optimizer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.optimizer-header h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
}

.optimizer-header p {
  margin: 4px 0 0;
  color: #6b7280;
}

.optimizer-steps {
  padding: 14px 16px;
  margin-bottom: 14px;
  border: 1px solid #e6ebf2;
  border-radius: 8px;
  background: #fff;
}

.step-panel {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  padding: 0;
  overflow: hidden;
}

.step-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid #edf1f6;
  background: #fbfcfe;
}

.step-heading > div {
  min-width: 0;
}

.step-heading h2 {
  margin: 0;
  font-size: 18px;
}

.step-heading p {
  margin: 4px 0 0;
  color: #6b7280;
}

.step-heading-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex: 0 0 auto;
  margin-left: auto;
}

.block-heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 0 0 10px;
}

.recognition-progress {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 0 18px 14px;
  padding: 12px 14px;
  border: 1px solid #dbe3ed;
  border-radius: 6px;
  background: #f8fafc;
}

.recognition-progress-main,
.recognition-progress-main > div {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.recognition-progress-main > div {
  align-items: flex-start;
  flex-direction: column;
  gap: 2px;
}

.recognition-progress-main span,
.recognition-progress-time,
.recognition-progress-next {
  color: #64748b;
  font-size: 12px;
}

.recognition-progress-dot {
  width: 10px;
  height: 10px;
  flex: 0 0 10px;
  border-radius: 50%;
  background: #94a3b8;
}

.recognition-progress.is-running .recognition-progress-dot {
  background: #2563eb;
  box-shadow: 0 0 0 4px rgb(37 99 235 / 14%);
  animation: recognition-pulse 1.2s ease-in-out infinite;
}

.recognition-progress.is-awaiting_confirmation,
.recognition-progress.is-confirmed { border-color: #a7d7bc; background: #f0fdf4; }
.recognition-progress.is-awaiting_confirmation .recognition-progress-dot,
.recognition-progress.is-confirmed .recognition-progress-dot { background: #16a34a; }
.recognition-progress.is-failed { border-color: #fecaca; background: #fff7f7; }
.recognition-progress.is-failed .recognition-progress-dot { background: #dc2626; }

@keyframes recognition-pulse {
  50% { opacity: 0.45; }
}

.block-heading strong {
  color: #111827;
  font-size: 14px;
}

.block-heading span {
  color: #6b7280;
  font-size: 12px;
}

.step-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: 0 0 auto;
}

.step-index {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: #1677ff;
  color: #fff;
  font-weight: 700;
}

.step-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  margin-top: 16px;
  border-top: 1px solid #edf1f6;
  background: #fbfcfe;
}

.step-footer > span {
  color: #6b7280;
  font-size: 13px;
}

.material-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  align-items: start;
  padding: 18px 18px 14px;
}

.material-optimization-settings {
  display: grid;
  grid-template-columns: minmax(320px, 0.8fr) minmax(0, 1.2fr);
  gap: 14px;
  padding: 14px 18px;
  border-top: 1px solid #e5e7eb;
}

.material-optimization-settings label {
  min-width: 0;
  display: grid;
  align-content: start;
  gap: 7px;
}

.material-optimization-settings label > span {
  color: #334155;
  font-size: 13px;
  font-weight: 700;
}

.source-task-queue {
  border-bottom: 1px solid #e5e7eb;
  padding-bottom: 12px;
}

.source-task-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 18px 10px;
}

.source-task-toolbar > span {
  color: #64748b;
  font-size: 13px;
}

.source-task-list {
  display: grid;
  gap: 6px;
  padding: 0 18px;
}

.source-task-row {
  display: grid;
  grid-template-columns: auto 52px minmax(0, 1fr) auto auto 32px;
  align-items: center;
  gap: 10px;
  min-height: 68px;
  padding: 7px 10px;
  border: 1px solid #dbe3ed;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
}

.source-task-row.active {
  border-color: #409eff;
  box-shadow: inset 3px 0 #409eff;
}

.source-task-row .el-image {
  width: 48px;
  height: 56px;
  border-radius: 4px;
}

.source-task-row > div {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.source-task-row strong,
.source-task-row span,
.source-task-row em {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-task-row span {
  color: #64748b;
  font-size: 12px;
}

.source-task-row em {
  color: #f56c6c;
  font-size: 12px;
  font-style: normal;
}

.import-panel {
  display: grid;
  gap: 12px;
}

.import-actions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.material-card {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  padding: 12px;
  border: 1px solid #e1e8f2;
  border-radius: 8px;
  background: #f8fafc;
}

.material-card.empty {
  color: #718096;
}

.material-card img,
.image-placeholder {
  width: 88px;
  height: 112px;
  border-radius: 6px;
}

.material-card img {
  object-fit: cover;
}

.image-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #eef3f9;
  font-size: 12px;
}

.material-meta {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.material-meta strong,
.material-meta span,
.material-meta em {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.material-meta em {
  color: #6b7280;
  font-size: 12px;
  font-style: normal;
}

.compact-form,
.text-layout,
.target-box {
  display: grid;
  gap: 10px;
}

.text-layout {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.advanced-fields {
  margin: 0 18px;
  border: 1px solid #edf1f6;
  border-radius: 8px;
  overflow: hidden;
}

.advanced-fields :deep(.el-collapse-item__header) {
  height: 42px;
  padding: 0 12px;
  background: #fbfcfe;
  color: #64748b;
  font-size: 13px;
  font-weight: 600;
}

.advanced-fields :deep(.el-collapse-item__content) {
  padding: 12px;
}

.target-box {
  padding: 0 18px 14px;
}

.step-panel > .block-heading {
  padding: 0 18px;
}

.text-layout label,
.target-box label {
  display: grid;
  gap: 6px;
  color: #374151;
  font-size: 13px;
}

.source-preview {
  width: 100%;
  max-height: 320px;
  object-fit: contain;
  display: block;
}

.upload-icon {
  font-size: 28px;
  color: #60718a;
}

.upload-title {
  margin-top: 8px;
  font-weight: 700;
}

.candidate-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 10px;
  padding: 0 18px 14px;
}

.candidate-tile {
  position: relative;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  overflow: hidden;
  background: #f9fafb;
}

.candidate-remove {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 2;
  width: 28px;
  height: 28px;
  box-shadow: 0 1px 4px rgb(0 0 0 / 24%);
}

.candidate-tile .el-image {
  width: 100%;
  aspect-ratio: 1;
  display: block;
}

.main-direction-strip { margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--el-border-color-lighter); }
.main-direction-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.main-direction-heading span { color: var(--el-text-color-secondary); font-size: 13px; }
.main-direction-option { display: inline-grid; grid-template-columns: 52px minmax(100px, 1fr) auto; align-items: center; width: min(280px, 100%); min-height: 58px; margin: 0 10px 10px 0; padding: 3px 10px 3px 3px; border: 1px solid var(--el-border-color); border-radius: 6px; background: var(--el-fill-color-blank); color: var(--el-text-color-primary); text-align: left; cursor: pointer; }
.main-direction-option.active { border-color: var(--el-color-primary); box-shadow: 0 0 0 1px var(--el-color-primary) inset; }
.main-direction-option .el-image { width: 52px; height: 52px; border-radius: 4px; }
.main-direction-option span { padding: 0 8px; overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.main-direction-option em { color: var(--el-text-color-secondary); font-size: 12px; font-style: normal; }

.candidate-meta {
  display: grid;
  gap: 2px;
  padding: 8px;
}

.candidate-meta strong,
.candidate-meta span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.candidate-meta span {
  color: #6b7280;
  font-size: 12px;
}

.slot-list {
  display: grid;
  gap: 10px;
  padding: 0 18px;
}

.insight-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 0 18px;
}

.insight-grid > div {
  min-width: 0;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 10px;
  background: #f9fafb;
}

.insight-grid h4 {
  margin: 0 0 8px;
  font-size: 14px;
}

.insight-grid :deep(.el-textarea__inner) {
  min-height: 176px !important;
  line-height: 1.6;
}

.prompt-review {
  margin: 0 18px 14px;
  border: 1px solid #dbe5ef;
  border-radius: 8px;
  overflow: hidden;
}

.prompt-review :deep(.el-collapse-item__header) {
  padding: 0 14px;
  background: #f8fafc;
  font-weight: 700;
}

.prompt-review :deep(.el-collapse-item__content) {
  padding: 14px;
}

.prompt-editor-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.prompt-editor-grid label {
  display: grid;
  gap: 6px;
  color: #334155;
  font-size: 13px;
  font-weight: 700;
}

.insight-grid ul {
  margin: 0;
  padding-left: 18px;
  color: #374151;
  line-height: 1.7;
}

.result-table :deep(.el-table__header th) {
  background: #f8fafc;
  color: #334155;
  font-weight: 700;
}

.result-table {
  width: calc(100% - 36px);
  margin: 0 18px;
}

.result-review-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0 18px 12px;
  padding: 10px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #f8fafc;
}

.generation-plan-panel {
  margin: 0 18px 14px;
  border: 1px solid #dbe3ed;
  border-radius: 6px;
  overflow: hidden;
  background: #fff;
}

.plan-target-panel {
  padding-bottom: 16px;
  border-bottom: 1px solid #edf1f6;
}

.plan-target-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 0 18px;
}

.plan-target-grid article {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  min-height: 62px;
  padding: 10px 12px;
  border: 1px solid #dbe3ed;
  border-radius: 6px;
  background: #fff;
}

.plan-target-grid article > div {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.plan-target-grid article span {
  color: #64748b;
  font-size: 12px;
}

.plan-target-grid article.is-running { border-color: #bfdbfe; background: #f8fbff; }
.plan-target-grid article.is-done { border-color: #bbf7d0; background: #f7fff9; }
.plan-target-grid article.is-failed { border-color: #fecaca; background: #fff7f7; }

.generation-blueprint { margin: 14px 18px; border: 1px solid var(--el-border-color-light); background: var(--el-fill-color-blank); }
.generation-blueprint-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; border-bottom: 1px solid var(--el-border-color-lighter); }
.generation-blueprint-heading > div { display: grid; gap: 3px; }
.generation-blueprint-heading span, .blueprint-section > span { color: var(--el-text-color-secondary); font-size: 13px; }
.main-copy-blueprint { display: grid; gap: 6px; padding: 14px; border-bottom: 1px solid var(--el-border-color-lighter); }
.main-copy-blueprint > span { color: var(--el-text-color-secondary); font-size: 12px; }
.main-copy-blueprint > strong { font-size: 17px; line-height: 1.4; }
.main-copy-blueprint > em { color: var(--el-color-primary); font-style: normal; font-weight: 600; }
.main-copy-blueprint > div { display: flex; flex-wrap: wrap; gap: 8px; }
.main-copy-blueprint b { padding: 4px 8px; border-left: 3px solid var(--el-color-success); background: var(--el-fill-color-light); font-size: 13px; font-weight: 600; }
.blueprint-section { display: grid; gap: 9px; padding: 12px 14px; border-bottom: 1px solid var(--el-border-color-lighter); }
.direction-plan-grid, .storyboard-plan-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px; }
.direction-plan-grid article, .storyboard-plan-grid article { position: relative; display: grid; gap: 4px; min-height: 74px; padding: 10px 10px 10px 38px; border: 1px solid var(--el-border-color-lighter); background: var(--el-fill-color-lighter); }
.direction-plan-grid i, .storyboard-plan-grid i { position: absolute; top: 10px; left: 10px; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: var(--el-color-primary); color: #fff; font-size: 11px; font-style: normal; }
.direction-plan-grid span, .storyboard-plan-grid span { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.45; }
.storyboard-plan-grid em { color: var(--el-color-primary); font-size: 12px; font-style: normal; }

.generation-plan-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px;
  border-bottom: 1px solid #e5e7eb;
  background: #f8fafc;
}

.generation-plan-heading > div,
.generation-plan-heading label,
.generation-plan-row > div {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.generation-plan-heading span,
.generation-plan-row span {
  color: #64748b;
  font-size: 12px;
}

.generation-plan-list {
  display: grid;
}

.generation-plan-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 10px;
  min-height: 58px;
  padding: 8px 12px;
  border-bottom: 1px solid #eef2f7;
}

.generation-plan-row:last-child {
  border-bottom: 0;
}

.generation-plan-row em {
  overflow: hidden;
  color: #f56c6c;
  font-size: 12px;
  font-style: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-review-toolbar span {
  color: #64748b;
  font-size: 13px;
}

.prompt-dialog-grid {
  padding: 0;
}

.result-slot-editor {
  margin-top: 14px;
}

.slot-drag-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 10px;
  padding: 0 18px 14px;
}

.slot-drag-card {
  position: relative;
  display: grid;
  gap: 7px;
  padding: 8px;
  border: 1px solid #dbe3ed;
  border-radius: 6px;
  background: #fff;
  cursor: grab;
}

.slot-drag-card:active {
  cursor: grabbing;
}

.slot-drag-card .el-image {
  width: 100%;
  aspect-ratio: 3 / 4;
  border-radius: 4px;
}

.slot-drag-card .slot-index {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 2;
}

.result-product {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.result-product strong,
.result-product span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-product span,
.muted-text {
  color: #6b7280;
  font-size: 12px;
}

.result-thumb {
  width: 72px;
  height: 96px;
  border-radius: 6px;
  border: 1px solid #dbe5ef;
  background: #f8fafc;
}

.detail-preview-stack {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.detail-thumb {
  width: 42px;
  height: 56px;
  border-radius: 5px;
  border: 1px solid #dbe5ef;
  background: #f8fafc;
}

.result-actions {
  min-height: 64px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.step-alert {
  margin: 0 18px 12px;
}

.slot-row {
  display: grid;
  grid-template-columns: 34px 72px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 8px;
}

.slot-index {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #eef2ff;
  color: #3730a3;
  font-weight: 700;
}

.slot-row .el-image {
  width: 72px;
  aspect-ratio: 1;
  border-radius: 6px;
  overflow: hidden;
  background: #f3f4f6;
}

.slot-body {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.slot-body span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #6b7280;
  font-size: 12px;
}

.preview-json {
  width: calc(100% - 36px);
  margin: 12px 18px 0;
}

.step-panel > .el-descriptions {
  width: calc(100% - 36px);
  margin: 0 18px;
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

.import-thumb {
  width: 64px;
  height: 84px;
  object-fit: cover;
  border-radius: 6px;
}

.import-meta {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.import-meta strong,
.import-meta span,
.import-meta em {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-meta em {
  color: #64748b;
  font-size: 12px;
  font-style: normal;
}

@media (max-width: 980px) {
  .material-layout,
  .text-layout,
  .insight-grid,
  .plan-target-grid,
  .prompt-editor-grid {
    grid-template-columns: 1fr;
  }

  .import-actions {
    grid-template-columns: 1fr;
  }

  .step-heading {
    display: grid;
  }

  .step-heading-actions {
    width: 100%;
    margin-left: 0;
    justify-content: stretch;
  }

  .step-heading-actions .el-button {
    width: 100%;
  }

  .import-toolbar {
    grid-template-columns: 1fr;
  }

  .step-actions {
    margin-left: 0;
    justify-content: flex-start;
    flex-wrap: wrap;
  }

  .slot-row {
    grid-template-columns: 28px 64px minmax(0, 1fr);
  }

  .slot-row .el-button-group {
    grid-column: 1 / -1;
  }
}
</style>
