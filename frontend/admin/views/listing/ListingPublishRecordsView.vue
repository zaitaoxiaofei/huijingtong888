<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuthStore } from "../../stores/auth.js";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, Edit, MagicStick, Plus, Refresh, Search, VideoCamera, View } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import { prepareBrowserWatermarkJobs } from "../../utils/browser-watermark-batch";
import { loadShopDictionary } from "../../utils/shop-dictionary";
import { openAiProductMaterialOptimizerWindow, openAiVariantLabWindow } from "../../utils/ai-variant-lab-window";
import { withImageToken } from "../../api/tools/imageCropper";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import ProductTitleLink from "../../components/ProductTitleLink.vue";
import { ozonBuyerProductLinkFromRow } from "../../utils/product-links";
import { shanghaiDateTimeText } from "../../utils/shanghai-date";
import {
  developmentTypeOptions,
  developmentTypeTagType,
  normalizeDevelopmentType,
  vehicleModelText
} from "../../utils/product-development-meta";

const loading = ref(false);
const refreshingId = ref(null);
const detailLoadingId = ref(null);
const retrying = ref(false);
const deletingId = ref(null);
const batchRefreshing = ref(false);
const batchDeleting = ref(false);
const selectedRows = ref([]);
const activeRepairTarget = ref("");
const developmentSavingDraftId = ref(null);
const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();
const currentPersonId = computed(() => String(authStore.user?.personId || authStore.user?.person_id || authStore.user?.id || ""));
const publishView = ref(route.query.tab === "tasks" ? "tasks" : "records");
const recordImagePlaceholder = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='84' viewBox='0 0 64 84'%3E%3Crect width='64' height='84' rx='8' fill='%23f3f6fb'/%3E%3Cpath d='M14 56l13-16 9 10 7-8 11 14H14z' fill='%23c7d0dd'/%3E%3Ccircle cx='25' cy='30' r='5' fill='%23c7d0dd'/%3E%3C/svg%3E";
let drawerPayloadCache = null;
let drawerResponseCache = null;
const DRAFT_LIST_CACHE_TTL_MS = 30 * 1000;
const LIST_CACHE_MAX_ENTRIES = 30;
const draftListCache = new Map();
const publishTaskListCache = new Map();
let recordsRequestSeq = 0;
let publishTasksRequest = null;

function setBoundedListCache(cache, key, result) {
  if (cache.size >= LIST_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, { timestamp: Date.now(), result });
}

function createListingWorkbenchId() {
  return `liwb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function quickCreateDraft() {
  router.push({
    path: "/listing-automation",
    query: {
      workbenchId: createListingWorkbenchId(),
      quickCreate: "1"
    }
  });
}

function createListingPublishRequestId() {
  return `lpr-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
}

const state = reactive({
  rows: [],
  shops: [],
  people: [],
  query: "",
  nameQuery: "",
  shopId: "all",
  creatorId: currentPersonId.value,
  developmentType: "all",
  status: "all",
  quality: "all",
  page: 1,
  pageSize: 20,
  total: 0
});

const drawer = reactive({
  visible: false,
  row: null,
  technicalJsonLoaded: false,
  payloadText: "",
  responseText: "",
  form: {
    name: "",
    offer_id: "",
    price: "",
    old_price: "",
    primary_image: "",
    imagesText: "",
    videoUrlsText: ""
  }
});

const batchListing = reactive({
  visible: false,
  publishing: false,
  shopIds: [],
  textVariantEnabled: true,
  baseShopId: "",
  textVariantStyle: "light",
  textVariantFields: ["title", "tags", "description"],
  textVariantFailureMode: "block",
  shopStyles: {},
  requestId: "",
  browserPreparing: false,
  browserCompleted: 0,
  browserTotal: 0,
  result: null
});

const batchMaterialOptimization = reactive({
  visible: false,
  submitting: false,
  scope: "main_only",
  facts: []
});

const taskState = reactive({
  rows: [],
  query: "",
  creatorId: currentPersonId.value,
  status: "all",
  page: 1,
  pageSize: 20,
  total: 0
});

const taskLoading = ref(false);
const taskViewer = ref({ person_name: "当前用户" });
const taskRetryingId = ref(null);
const taskDrawer = reactive({
  visible: false,
  loading: false,
  task: null
});

const textVariantStyleOptions = [
  { label: "轻量差异化", value: "light" },
  { label: "高点击率", value: "ctr" },
  { label: "场景化", value: "scene" },
  { label: "材质卖点", value: "material" }
];

const pageMode = computed(() => route.meta?.recordMode === "publish" ? "publish" : "drafts");
const isDraftMode = computed(() => pageMode.value === "drafts");
const isPublishMode = computed(() => pageMode.value === "publish");
const isTaskMode = computed(() => isPublishMode.value && publishView.value === "tasks");
const filteredRows = computed(() => state.rows);
const selectedDraftRows = computed(() => isDraftMode.value ? selectedRows.value.filter((row) => row.row_type === "draft") : []);
const selectedPublishRows = computed(() => selectedRows.value.filter((row) => row?.id && row.row_type !== "draft"));
const batchPublishFailedResults = computed(() => Array.isArray(batchListing.result?.results)
  ? batchListing.result.results.filter((item) => item && item.ok === false)
  : []);
const drawerTitle = computed(() => isDraftMode.value ? "草稿项目详情" : "上架记录详情");
const statusOptions = computed(() => isDraftMode.value
  ? [
    { label: "全部状态", value: "all" },
    { label: "编辑中", value: "editing" },
    { label: "待上架", value: "waiting" }
  ]
  : [
    { label: "全部状态", value: "all" },
    { label: "上架成功", value: "success" },
    { label: "等待处理", value: "processing" },
    { label: "上架失败", value: "failed" }
  ]);

const taskStatusOptions = [
  { label: "全部任务", value: "all" },
  { label: "进行中", value: "running" },
  { label: "部分完成", value: "partial" },
  { label: "已完成", value: "completed" },
  { label: "失败", value: "failed" },
  { label: "已中断", value: "interrupted" }
];

function applyRouteStatusFilter() {
  const status = String(route.query.status || "").trim();
  if (!status) return;
  if (statusOptions.value.some((option) => option.value === status)) {
    state.status = status;
  }
}

function applyRouteShopFilter() {
  const shopId = String(route.query.shopId || "").trim();
  if (!shopId) return;
  state.shopId = shopId === "all" ? "all" : shopId;
}

async function openRoutePublishRecord() {
  if (!isPublishMode.value) return;
  const recordId = Number(route.query.recordId || 0);
  if (!recordId) return;
  const row = state.rows.find((item) => Number(item.id) === recordId) || {
    id: recordId,
    row_type: "publish_record"
  };
  await openDrawer(row);
}

function matchesStatusFilter(status, filter) {
  if (!filter || filter === "all") return true;
  if (filter === "editing") return status === "editing";
  if (filter === "waiting") return status === "waiting";
  if (filter === "success") return isSuccessStatus(status);
  if (filter === "processing") return ["submitted", "processing", "resubmitting", "ozon_status_pending"].includes(status);
  if (filter === "failed") return ["failed", "ozon_status_error"].includes(status);
  return status === filter;
}

const summary = computed(() => {
  const rows = state.rows;
  return {
    total: rows.length,
    success: rows.filter((row) => isSuccessStatus(row.status)).length,
    processing: rows.filter((row) => ["submitted", "processing", "resubmitting", "ozon_status_pending"].includes(row.status)).length,
    failed: rows.filter((row) => row.status === "failed").length,
    editing: rows.filter((row) => row.status === "editing").length,
    waiting: rows.filter((row) => row.status === "waiting").length,
    quality90: rows.filter((row) => Number(row.quality_score || 0) >= 90).length
  };
});

async function loadRecords() {
  const requestSeq = ++recordsRequestSeq;
  const endpoint = isPublishMode.value ? "/api/listing/publish-records" : "/api/listing/drafts";
  const params = new URLSearchParams({
    paged: "1",
    page: String(state.page),
    pageSize: String(state.pageSize),
    status: state.status,
    quality: state.quality,
    includePayload: "0"
  });
  if (isDraftMode.value) {
    params.set("lightweight", "1");
    params.set("projectOnly", "1");
    params.set("sortBy", "created_at");
  }
  if (state.query.trim()) params.set("query", state.query.trim());
  if (state.nameQuery.trim()) params.set("nameQuery", state.nameQuery.trim());
  if (state.shopId !== "all") params.set("shopId", String(state.shopId));
  if (state.creatorId !== "all") {
    const creatorId = String(state.creatorId);
    if (creatorId) params.set("creatorId", creatorId);
  }
  if (isDraftMode.value && state.developmentType !== "all") params.set("developmentType", String(state.developmentType));
  const requestUrl = `${endpoint}?${params.toString()}`;
  const cacheKey = requestUrl;
  const cached = cacheKey ? draftListCache.get(cacheKey) : null;
  const hasFreshCache = Boolean(cached && Date.now() - cached.timestamp < DRAFT_LIST_CACHE_TTL_MS);
  if (hasFreshCache) applyDraftListResult(cached.result);
  loading.value = !hasFreshCache;
  try {
    const result = await apiClient.get(requestUrl, { noCache: true });
    if (requestSeq !== recordsRequestSeq) return;
    setBoundedListCache(draftListCache, cacheKey, result);
    applyDraftListResult(result);
  } finally {
    if (requestSeq === recordsRequestSeq) loading.value = false;
  }
}

function applyDraftListResult(result = {}) {
  state.rows = (Array.isArray(result?.rows) ? result.rows : []).map(normalizeDraftProjectFallback);
  state.total = Number(result?.total || state.rows.length);
  state.page = Number(result?.page || state.page);
  state.pageSize = Number(result?.pageSize || state.pageSize);
  selectedRows.value = [];
}

async function updateDraftDevelopmentType(row, value) {
  if (!row?.id) return;
  const previous = normalizeDevelopmentType(row.development_type);
  row.development_type = normalizeDevelopmentType(value, previous);
  developmentSavingDraftId.value = row.id;
  try {
    const updated = await apiClient.put(`/api/listing/drafts/${row.id}/development-meta`, {
      development_type: row.development_type,
      vehicle_brand: row.vehicle_brand || "",
      vehicle_model: row.vehicle_model || ""
    });
    Object.assign(row, normalizeDraftProjectFallback(updated || {}));
    ElMessage.success("开发类型已更新");
  } catch (error) {
    row.development_type = previous;
    ElMessage.error(error.message || "开发类型保存失败");
  } finally {
    developmentSavingDraftId.value = null;
  }
}

async function refreshToolbarRecords() {
  if (isDraftMode.value) draftListCache.clear();
  if (isPublishMode.value && selectedPublishRows.value.length) {
    await batchRefreshRecords();
    return;
  }
  await loadRecords();
  ElMessage.success("列表已刷新");
}

async function loadPublishTasks() {
  const query = taskState.query.trim();
  const key = [taskState.page, taskState.pageSize, taskState.creatorId, taskState.status, query].join("|");
  if (publishTasksRequest?.key === key) return publishTasksRequest.promise;
  const promise = (async () => {
    const cached = publishTaskListCache.get(key);
    const hasFreshCache = Boolean(cached && Date.now() - cached.timestamp < DRAFT_LIST_CACHE_TTL_MS);
    if (hasFreshCache) {
      const cachedResult = cached.result || {};
      taskState.rows = Array.isArray(cachedResult.rows) ? cachedResult.rows : [];
      taskViewer.value = cachedResult.viewer || taskViewer.value;
      taskState.total = Number(cachedResult.total || taskState.rows.length);
    }
    taskLoading.value = !hasFreshCache;
    try {
      const params = new URLSearchParams({
        page: String(taskState.page),
        pageSize: String(taskState.pageSize),
        creatorId: taskState.creatorId,
        status: taskState.status
      });
      if (query) params.set("query", query);
      const result = await apiClient.get(`/api/listing/publish-tasks?${params.toString()}`, {
        noCache: true,
        routeScoped: false
      });
      setBoundedListCache(publishTaskListCache, key, result);
      taskState.rows = Array.isArray(result?.rows) ? result.rows : [];
      taskViewer.value = result?.viewer || { person_name: "当前用户" };
      if (!taskState.creatorId && result?.viewer?.person_id) {
        taskState.creatorId = String(result.viewer.person_id);
      }
      taskState.total = Number(result?.total || taskState.rows.length);
      taskState.page = Number(result?.page || taskState.page);
      taskState.pageSize = Number(result?.pageSize || taskState.pageSize);
    } finally {
      taskLoading.value = false;
      if (publishTasksRequest?.key === key) publishTasksRequest = null;
    }
  })();
  publishTasksRequest = { key, promise };
  return promise;
}

function searchPublishTasks() {
  taskState.page = 1;
  loadPublishTasks();
}

function handleTaskPageChange(page) {
  taskState.page = page;
  loadPublishTasks();
}

function handleTaskPageSizeChange(size) {
  taskState.pageSize = Number(size || 20);
  taskState.page = 1;
  loadPublishTasks();
}

function resetTaskFilters() {
  taskState.query = "";
  taskState.creatorId = String(taskViewer.value?.person_id || currentPersonId.value || "all");
  taskState.status = "all";
  taskState.page = 1;
  loadPublishTasks();
}

async function openTaskDrawer(row) {
  if (!row?.id) return;
  taskDrawer.loading = true;
  taskDrawer.visible = true;
  try {
    taskDrawer.task = await apiClient.get(`/api/listing/publish-tasks/${encodeURIComponent(row.id)}`, { noCache: true });
  } finally {
    taskDrawer.loading = false;
  }
}

function taskCanRetry(row = {}) {
  return Number(row.failed_count || 0) + Number(row.interrupted_count || 0) > 0;
}

async function retryPublishTask(row) {
  const taskId = Number(row?.id || taskDrawer.task?.id || 0);
  if (!taskId || !taskCanRetry(row || taskDrawer.task)) return;
  taskRetryingId.value = taskId;
  try {
    const task = await apiClient.get(`/api/listing/publish-tasks/${encodeURIComponent(taskId)}`, { noCache: true });
    const candidates = (Array.isArray(task?.items) ? task.items : [])
      .filter((item) => ["failed", "interrupted"].includes(String(item.status || "")));
    if (!candidates.length) {
      ElMessage.warning("没有可重试的失败或中断项");
      return;
    }
    const bootstrap = await apiClient.get("/api/asset-variant-engine/bootstrap", { noCache: true });
    const shopIds = new Set(candidates.map((item) => Number(item.shop_id)).filter(Boolean));
    const shops = (Array.isArray(bootstrap?.shops) ? bootstrap.shops : [])
      .filter((shop) => shopIds.has(Number(shop.id)))
      .map((shop) => ({
        id: Number(shop.id),
        name: String(shop.name || `店铺 ${shop.id}`),
        watermarkPath: String(shop.watermarkPath || shop.watermark_path || shop.logoUrl || ""),
        watermarkPosition: String(shop.watermarkPosition || shop.watermark_position || "bottom-right"),
        watermarkXPercent: Number(shop.watermarkXPercent ?? shop.watermark_x_percent ?? 75),
        watermarkYPercent: Number(shop.watermarkYPercent ?? shop.watermark_y_percent ?? 75),
        watermarkScalePercent: Number(shop.watermarkScalePercent ?? shop.watermark_scale_percent ?? 22),
        watermarkOpacityPercent: Number(shop.watermarkOpacityPercent ?? shop.watermark_opacity_percent ?? 82)
      }));
    if (shops.length !== shopIds.size) throw new Error("部分重试店铺的浏览器素材配置加载失败");
    const shopById = new Map(shops.map((shop) => [shop.id, shop]));
    const draftIds = [...new Set(candidates.map((item) => Number(item.draft_id)).filter(Boolean))];
    const drafts = await mapFrontendConcurrency(draftIds, 10, (draftId) => apiClient.get(`/api/listing/drafts/${draftId}`, { noCache: true }));
    const draftById = new Map(drafts.map((draft, index) => [draftIds[index], draft]));
    const mediaJobs = candidates.map((item) => {
      const draft = draftById.get(Number(item.draft_id));
      const images = [...new Set(draftListImages(draft).filter(Boolean))];
      if (!images.length) throw new Error(`草稿 ${item.draft_id} 没有可处理的商品图片`);
      return { productId: `retry-${item.id}`, images, shops: [shopById.get(Number(item.shop_id))] };
    });
    batchListing.browserPreparing = true;
    const preparedByItem = await prepareBrowserWatermarkJobs({
      jobs: mediaJobs,
      onProgress(progress) {
        batchListing.browserCompleted = Number(progress.completed || 0);
        batchListing.browserTotal = Number(progress.total || 0);
      }
    });
    const preparedMediaByDraftShop = {};
    for (const item of candidates) {
      const prepared = preparedByItem[`retry-${item.id}`] || {};
      preparedMediaByDraftShop[`${Number(item.draft_id)}:${Number(item.shop_id)}`] = prepared[String(item.shop_id)] || [];
    }
    const result = await apiClient.post(`/api/listing/publish-tasks/${encodeURIComponent(taskId)}/retry`, {
      item_ids: candidates.map((item) => item.id),
      browser_prepared_media: true,
      prepared_media_by_draft_shop: preparedMediaByDraftShop
    });
    const queued = Number(result?.summary?.queued || 0);
    const failed = Number(result?.summary?.failed || 0);
    if (queued) ElMessage.success(`已重新提交 ${queued} 个失败或中断项`);
    else ElMessage.warning("没有可重试的失败或中断项");
    if (failed) ElMessage.warning(`${failed} 条重试创建失败，请查看任务明细`);
    await loadPublishTasks();
    if (taskDrawer.visible) await openTaskDrawer({ id: taskId });
  } finally {
    batchListing.browserPreparing = false;
    taskRetryingId.value = null;
  }
}

async function mapFrontendConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function openTaskRecord(recordId) {
  if (!recordId) return;
  taskDrawer.visible = false;
  publishView.value = "records";
  router.push({ name: "listing-publish-records", query: { recordId: String(recordId) } });
}

function taskStatusType(status) {
  const value = String(status || "");
  if (value === "completed" || value === "success") return "success";
  if (value === "partial" || value === "submitted" || value === "processing" || value === "preparing") return "warning";
  if (value === "failed" || value === "interrupted") return "danger";
  if (value === "running" || value === "pending") return "primary";
  return "info";
}

function taskStatusText(status) {
  const map = {
    running: "进行中",
    partial: "部分完成",
    completed: "已完成",
    failed: "失败",
    interrupted: "已中断",
    empty: "无明细"
  };
  return map[status] || status || "未知";
}

function taskItemStatusText(status) {
  const map = {
    pending: "待开始",
    preparing: "准备中",
    processing: "提交中",
    submitted: "已提交 Ozon",
    success: "上架成功",
    failed: "上架失败",
    interrupted: "已中断"
  };
  return map[status] || status || "未知";
}

async function reloadRecordsAfterDelete(deletedCount = 1) {
  draftListCache.clear();
  const remainingTotal = Math.max(0, Number(state.total || 0) - Number(deletedCount || 0));
  const lastPage = Math.max(1, Math.ceil(remainingTotal / Number(state.pageSize || 20)));
  if (state.page > lastPage) state.page = lastPage;
  await loadRecords();
}

async function loadShops() {
  const rows = await loadShopDictionary();
  state.shops = Array.isArray(rows)
    ? rows
      .filter((shop) => String(shop.status || "").toLowerCase() !== "deleted")
      .map((shop) => ({
        id: String(shop.id),
        name: String(shop.name || `店铺 ${shop.id}`)
      }))
    : [];
}

async function loadPeople() {
  const rows = await apiClient.get("/api/people");
  state.people = Array.isArray(rows)
    ? rows
      .filter((person) => Number(person.active ?? 1) !== 0)
      .map((person) => ({
        id: String(person.id),
        name: String(person.name || person.username || `人员 ${person.id}`)
      }))
    : [];
  if (!state.creatorId) state.creatorId = currentPersonId.value || "all";
}

function handleSelectionChange(rows) {
  selectedRows.value = rows;
}

function resetFilters() {
  state.query = "";
  state.nameQuery = "";
  state.shopId = "all";
  state.creatorId = currentPersonId.value || "all";
  state.developmentType = "all";
  state.status = "all";
  state.quality = "all";
  state.developmentType = "all";
  state.page = 1;
  loadRecords();
}

function resetModeFilters() {
  state.status = "all";
  state.quality = "all";
  state.creatorId = currentPersonId.value || "all";
  state.developmentType = "all";
  state.page = 1;
  selectedRows.value = [];
  loadRecords();
}

function resetModeFiltersFromRoute() {
  if (isPublishMode.value) publishView.value = route.query.tab === "tasks" ? "tasks" : "records";
  state.status = "all";
  state.quality = "all";
  state.page = 1;
  selectedRows.value = [];
  applyRouteStatusFilter();
  if (isTaskMode.value) loadPublishTasks();
  else loadRecords();
}

function searchRecords() {
  state.page = 1;
  loadRecords();
}

function handlePageChange(page) {
  state.page = page;
  loadRecords();
}

function handlePageSizeChange(size) {
  state.pageSize = Number(size || 20);
  state.page = 1;
  loadRecords();
}

function statusType(status) {
  if (status === "editing") return "info";
  if (status === "waiting") return "warning";
  if (isSuccessStatus(status)) return "success";
  if (["submitted", "processing", "resubmitting", "ozon_status_pending"].includes(status)) return "warning";
  if (status === "ozon_status_error") return "danger";
  if (status === "failed") return "danger";
  return "info";
}

function statusText(status) {
  const map = {
    imported: "商品卡已创建",
    published: "商品卡已创建",
    success: "上架成功",
    editing: "编辑中",
    waiting: "等待上架",
    submitted: "已提交 Ozon",
    processing: "Ozon处理中",
    resubmitting: "重新提交中",
    ozon_status_pending: "待Ozon返回任务明细",
    ozon_status_error: "Ozon状态同步失败",
    failed: "上架失败"
  };
  return map[status] || status || "未知";
}

function draftPublishStatusText(row = {}) {
  const total = Number(row.publish_record_count || 0);
  const success = Number(row.publish_success_count || 0);
  const failed = Number(row.publish_failed_count || 0);
  if (success > 0 && success < total) return "部分上架";
  if (success > 0) return "上架成功";
  if (failed > 0 && failed >= total) return "上架失败";
  return row.publish_status ? statusText(row.publish_status) : "未上架";
}

function draftPublishStatusType(row = {}) {
  if (Number(row.publish_success_count || 0) > 0 && Number(row.publish_success_count || 0) < Number(row.publish_record_count || 0)) return "warning";
  if (Number(row.publish_success_count || 0) > 0) return "success";
  return row.publish_status ? statusType(row.publish_status) : "info";
}

function publishFailureReason(row = {}) {
  return row.error_summary || row.error?.message || "";
}

function publishFailureFixTip(row = {}) {
  return row.error_fix_tip || row.error?.fix_tip || "";
}

function publishImportErrorItems(row = {}) {
  return Array.isArray(row.import_errors) ? row.import_errors : [];
}

function repairTargetForImportError(item = {}) {
  const text = [
    item.field,
    item.code,
    item.message,
    item.raw_message,
    item.fix_tip
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  if (/offer|offer_id|sku|артикул/.test(text)) return "offer_id";
  if (/old_price|old price|discount|划线/.test(text)) return "old_price";
  if (/price|цена|стоим/.test(text)) return "price";
  if (/primary_image|main image|главн|主图/.test(text)) return "primary_image";
  if (/image|photo|picture|фото|изображ|图片/.test(text)) return "images";
  if (/video|видео|视频/.test(text)) return "video";
  if (/name|title|назван|标题/.test(text)) return "name";
  if (/category|type_id|description_category_id|类目|категор/.test(text)) return "category";
  if (/attribute|attributes|attr|характерист|属性/.test(text)) return "attributes";
  return "general";
}

function repairTargetLabel(target = "general") {
  const map = {
    name: "标题",
    offer_id: "Offer ID",
    price: "售价",
    old_price: "划线价",
    primary_image: "主图 URL",
    images: "附图 URL",
    video: "视频 URL",
    category: "类目",
    attributes: "Ozon 属性",
    general: "通用问题"
  };
  return map[target] || map.general;
}

function repairIssuesForRow(row = {}) {
  return publishImportErrorItems(row).map((item, index) => {
    const target = repairTargetForImportError(item);
    return {
      ...item,
      index,
      target,
      target_label: repairTargetLabel(target),
      text: item.raw_message || item.message || item.code || "Ozon 返回了未归类的问题",
      fix_tip: item.fix_tip || publishFailureFixTip(row) || ""
    };
  });
}

const drawerRepairIssues = computed(() => repairIssuesForRow(drawer.row || {}));
const drawerRepairTargets = computed(() => new Set(drawerRepairIssues.value.map((item) => item.target)));

function hasRepairTarget(target) {
  return drawerRepairTargets.value.has(target);
}

function repairFieldClass(target) {
  return {
    "repair-field-warning": hasRepairTarget(target),
    "repair-field-active": activeRepairTarget.value === target
  };
}

async function focusRepairIssue(issue = {}) {
  activeRepairTarget.value = issue.target || "general";
  await nextTick();
  const targetId = `repair-field-${activeRepairTarget.value}`;
  const element = document.getElementById(targetId) || document.querySelector(".repair-panel");
  element?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function isSuccessStatus(status) {
  return ["imported", "published", "success"].includes(status);
}

function publishRecordProductTitle(row) {
  return row?.product_name || row?.offer_id || "-";
}

function publishRecordBuyerLink(row) {
  return ozonBuyerProductLinkFromRow(row);
}

function qualityType(score) {
  const value = Number(score || 0);
  if (value >= 90) return "success";
  if (value >= 75) return "warning";
  if (value > 0) return "danger";
  return "info";
}

function qualitySourceText(source) {
  const value = String(source || "");
  if (value.includes("ozon_rating_by_sku")) return "Ozon真实评分";
  if (value.includes("ozon_rating_waiting_sku")) return "等待Ozon返回SKU";
  if (value.includes("ozon_rating_pending")) return "等待Ozon评分";
  if (value.includes("ozon_rating_error")) return "Ozon评分同步失败";
  if (value.includes("local_estimate")) return "未返回";
  return value || "未返回";
}

function recordPriceText(row = {}) {
  const price = Number(row.price || 0);
  const oldPrice = Number(row.old_price || 0);
  const currency = row.currency_code || "CNY";
  if (!price) return "-";
  return oldPrice && oldPrice !== price
    ? `${price} ${currency} / 划线 ${oldPrice}`
    : `${price} ${currency}`;
}

function creatorText(row = {}) {
  const name = String(row.created_by_name || row.creator_name || row.createdByName || "").trim();
  if (name) return name;
  const id = String(row.created_by_person_id || row.createdByPersonId || "").trim();
  return id ? `ID ${id}` : "-";
}

function normalizeDraftProjectFallback(row = {}) {
  const rowType = row.row_type || (row.request ? "publish_record" : "draft");
  const draftImages = rowType === "draft" ? draftListImages(row) : row.images;
  const draftPrice = row.draft_variant_price || row.draft_template_price || row.price || row.sale_price || "";
  const draftStatus = rowType === "draft"
    ? (Number(row.shop_copy_count || 0) > 0 ? "waiting" : "editing")
    : row.status;
  const normalized = {
    ...row,
    row_type: rowType,
    row_key: row.row_key || `${rowType === "draft" ? "draft" : "record"}-${row.id}`,
    status: draftStatus,
    source_label: row.source_label || (rowType === "draft" ? "商品上架" : "上架记录"),
    creator_name: creatorText(row),
    shop_name: row.shop_name || (rowType === "draft"
      ? (Number(row.shop_copy_count || 0) > 0 ? `Shop copies: ${row.shop_copy_count}` : "Draft not assigned")
      : ""),
    offer_id: row.offer_id || row.internal_code || (rowType === "draft" ? `DRAFT-${row.id}` : ""),
    images: draftImages,
    image_count: Number(row.image_count || draftImages?.length || 0),
    video_urls: Array.isArray(row.video_urls) ? row.video_urls : [],
    price: rowType === "draft" ? draftPrice : (row.price || ""),
    currency_code: row.currency_code || "CNY"
  };
  normalized.preview_candidates = rawRecordPreviewCandidates(normalized);
  return {
    ...normalized,
    primary_image: normalized.primary_image || normalized.preview_candidates[0] || ""
  };
}

function draftListImages(row = {}) {
  const sourceImages = Array.isArray(row.source_images)
    ? row.source_images.map((item) => typeof item === "string" ? item : item?.url || item?.image_url || item?.imageUrl || item?.src || "")
    : [];
  return [
    row.primary_image,
    row.draft_variant_primary_image,
    row.draft_template_primary_image,
    ...sourceImages
  ].map((item) => String(item || "").trim()).filter(Boolean);
}

function compactDateTime(value = "") {
  return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true }).replace(/:00$/, "");
}

function taskDisplayName(row = {}) {
  const time = compactDateTime(row.created_at).replace(/[- :]/g, "");
  const person = String(row.created_by_name || "未知人员").trim();
  const shops = String(row.task_shop_names || "全部店铺").trim();
  return `${time}_${person}_${shops}`;
}

async function loadPublishRecordDetail(row) {
  if (row?.row_type === "draft") return row;
  if (row?.request?.items) return row;
  detailLoadingId.value = row.id;
  try {
    const detail = await apiClient.get(`/api/listing/publish-records/${row.id}`, { noCache: true });
    const index = state.rows.findIndex((item) => Number(item.id) === Number(detail.id));
    if (index >= 0) state.rows[index] = { ...state.rows[index], ...detail };
    return index >= 0 ? state.rows[index] : detail;
  } finally {
    detailLoadingId.value = null;
  }
}

async function editInListingAutomation(row) {
  if (!row?.id) return;
  if (row.row_type === "draft") {
    router.push({
      name: "listing-automation",
      query: {
        workbenchId: createListingWorkbenchId(),
        tabTitle: `商品上架 · 草稿 ${row.id}`,
        draftId: row.id,
        returnTo: router.currentRoute.value.fullPath
      }
    });
    return;
  }
  router.push({
    name: "listing-automation",
    query: {
      workbenchId: createListingWorkbenchId(),
      tabTitle: `商品上架 · 记录 ${row.id}`,
      recordId: row.id,
      returnTo: router.currentRoute.value.fullPath
    }
  });
}

function openAiWorkbench(row, mode = "optimization") {
  if (!row?.id) return;
  const sourceQuery = row.row_type === "draft"
    ? { draftId: String(row.id), source: "listing_draft" }
    : { listingRecordId: String(row.id), source: "listing_record" };
  if (mode === "variant") {
    openAiVariantLabWindow({
      tabTitle: `AI裂变 · ${row.row_type === "draft" ? "草稿" : "记录"} ${row.id}`,
      ...sourceQuery,
      autoImport: "1",
      importAt: String(Date.now()),
      returnTo: router.currentRoute.value.fullPath
    });
    return;
  }
  openAiProductMaterialOptimizerWindow({
    tabTitle: `AI优化 · ${row.row_type === "draft" ? "草稿" : "记录"} ${row.id}`,
    ...sourceQuery,
    autoImport: "1",
    importAt: String(Date.now()),
    returnTo: router.currentRoute.value.fullPath
  });
}

function batchOpenAiVariantWorkbench() {
  const rows = selectedDraftRows.value;
  if (!rows.length) {
    ElMessage.warning("请先选择要 AI 裂变的草稿");
    return;
  }
  const first = rows[0];
  openAiVariantLabWindow({
    tabTitle: rows.length > 1 ? `AI裂变 · ${rows.length} 个草稿` : `AI裂变 · 草稿 ${first.id}`,
    source: "listing_draft",
    draftId: String(first.id),
    draftIds: rows.map((row) => row.id).join(","),
    autoImport: "1",
    importAt: String(Date.now()),
    returnTo: router.currentRoute.value.fullPath
  });
}

function openBatchMaterialOptimization() {
  const rows = selectedDraftRows.value;
  if (!rows.length) return ElMessage.warning("请先选择要优化的草稿");
  if (rows.length > 20) return ElMessage.warning("单次最多选择 20 个草稿");
  batchMaterialOptimization.scope = "main_only";
  batchMaterialOptimization.facts = rows.map((row) => ({
    draftId: Number(row.id),
    productTitleZh: String(row.product_name || row.title || row.draft_name || "").trim(),
    compatibilityZh: "",
    sellingPointsZh: "",
    forbiddenFactsZh: "",
    confirmed: false
  }));
  batchMaterialOptimization.visible = true;
}

async function submitBatchMaterialOptimization() {
  const draftIds = selectedDraftRows.value.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);
  if (!draftIds.length) return ElMessage.warning("没有可提交的草稿");
  const invalidFacts = batchMaterialOptimization.facts.filter((item) => (
    !String(item.productTitleZh || "").trim()
    || String(item.sellingPointsZh || "").split(/[\n；;]+/).map((value) => value.trim()).filter(Boolean).length < 2
    || item.confirmed !== true
  ));
  if (invalidFacts.length) return ElMessage.warning(`还有 ${invalidFacts.length} 个草稿未填写并确认精确产品名称和至少 2 条卖点`);
  batchMaterialOptimization.submitting = true;
  try {
    const result = await apiClient.post("/api/ai-material-optimization/batches", {
      draftIds,
      optimizationScope: batchMaterialOptimization.scope,
      items: batchMaterialOptimization.facts.map((item) => ({
        draftId: item.draftId,
        operatorFacts: {
          product_title_zh: String(item.productTitleZh || "").trim(),
          compatibility_zh: String(item.compatibilityZh || "").split(/[\n；;]+/).map((value) => value.trim()).filter(Boolean),
          selling_points_zh: String(item.sellingPointsZh || "").split(/[\n；;]+/).map((value) => value.trim()).filter(Boolean),
          forbidden_facts_zh: String(item.forbiddenFactsZh || "").split(/[\n；;]+/).map((value) => value.trim()).filter(Boolean),
          confirmed_by_operator: true
        }
      }))
    });
    batchMaterialOptimization.visible = false;
    selectedRows.value = [];
    ElMessage.success(`素材优化批次 ${result.batch_no} 已提交后台`);
    await router.push({ name: "ai-material-optimization-records", query: { batchNo: result.batch_no } });
  } catch (error) {
    ElMessage.error(error.message || "批量素材优化提交失败");
  } finally {
    batchMaterialOptimization.submitting = false;
  }
}

function buildTemplateFromRecord(row) {
  const snapshot = plainClone(row.template_snapshot, null);
  if (snapshot?.editable_payload) {
    const editable = snapshot.editable_payload || {};
    const sourceRaw = plainClone(snapshot.source_raw || editable.source_raw || {}, {});
    sourceRaw.record_id = row.id;
    sourceRaw.shop_id = row.shop_id;
    sourceRaw.from_publish_record = true;
    if (!sourceRaw.offer_id) sourceRaw.offer_id = row.offer_id || editable.sku || "";
    return {
      ...snapshot,
      id: "",
      template_name: snapshot.template_name || `上架记录 ${row.id} / ${row.offer_id || editable.sku || ""}`,
      source_raw: sourceRaw,
      editable_payload: {
        ...editable,
        source_raw: sourceRaw
      }
    };
  }
  const payload = plainClone(row.request, { items: [] });
  const item = payload.items?.[0] || {};
  const images = [item.primary_image, ...(item.images || [])].filter(Boolean).map((url, index) => ({ url, sort_order: index + 1 }));
  const videoUrls = extractVideoUrls(item);
  const modelName = generatedModelName(row, item);
  const productTags = extractProductTags(item);
  const richJson = extractRichContentJson(item);
  const material = extractAttributeValue(item, ["材料", "材质", "material", "материал"], [7199]) || item.material || "";
  const categoryName = row.category_name || row.category_name_zh || row.path_zh || item.category_name || item.description_category_name || "";
  const variant = {
    id: `record-${row.id}`,
    sku: item.offer_id || row.offer_id || "",
    offer_id: item.offer_id || row.offer_id || "",
    name: item.name || row.product_name || "",
    title: item.name || row.product_name || "",
    images,
    video_urls: videoUrls,
    video_cover_urls: videoUrls,
    price: Number(item.price || row.price || 0),
    old_price: Number(item.old_price || row.old_price || 0),
    color: item.color || "",
    material,
    quantity: item.quantity || "",
    weight_g: Number(item.weight || 0),
    length_mm: Number(item.depth || 0),
    width_mm: Number(item.width || 0),
    height_mm: Number(item.height || 0),
    stock: Number(item.stock || 0)
  };
  return {
    id: "",
    ozon_category_id: item.description_category_id && item.type_id ? `${item.description_category_id}:${item.type_id}` : "",
    category_name: categoryName,
    template_name: `上架记录 ${row.id} / ${item.offer_id || row.offer_id || ""}`,
    title: item.name || row.product_name || "",
    description: item.description || "",
    attributes: enrichRecordAttributes(item.attributes || [], { modelName, productTags, material, richJson }),
    images,
    source_raw: { ...payload, record_id: row.id, shop_id: row.shop_id, offer_id: item.offer_id || row.offer_id || "", from_publish_record: true },
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
      category_name: categoryName,
      attributes: enrichRecordAttributes(item.attributes || [], { modelName, productTags, material, richJson }),
      images,
      variants: [variant],
      source_raw: { ...payload, record_id: row.id, shop_id: row.shop_id, from_publish_record: true }
    }
  };
}

function enrichRecordAttributes(attributes = [], { modelName = "", productTags = [], material = "", richJson = "" } = {}) {
  const next = plainClone(attributes, []);
  upsertRecordAttribute(next, ["型号名称", "型号", "Модель"], { name: "型号名称", value: modelName, required: true, source: "publish_record" });
  if (productTags.length) upsertRecordAttribute(next, ["产品标签", "主题标签", "主图标签", "tag", "тег", "ключ"], { name: "产品标签", value: productTags.join(","), values: productTags, source: "publish_record" });
  if (material) upsertRecordAttribute(next, ["材料", "材质", "material", "материал"], { name: "材料", value: material, source: "publish_record" });
  if (richJson) upsertRecordAttribute(next, ["JSON富内容", "Rich", "rich"], { name: "JSON富内容", attribute_id: 11254, value: richJson, type: "rich_json", source: "publish_record" });
  return next;
}

function upsertRecordAttribute(attributes, names, payload) {
  const existing = attributes.find((item) => names.some((name) => String(item?.name || "").toLowerCase().includes(String(name).toLowerCase())));
  if (existing) Object.assign(existing, payload);
  else attributes.push(payload);
}

function generatedModelName(row, item = {}) {
  const seed = String(item.offer_id || row.offer_id || row.id || Date.now()).replace(/[^a-zA-Z0-9]+/g, "").slice(-10).toUpperCase();
  return `M-${seed || Date.now().toString(36).toUpperCase()}`;
}

function extractProductTags(item = {}) {
  const raw = extractAttributeValue(item, ["产品标签", "主题标签", "主图标签", "tag", "тег", "ключ"], [10096, 23171]);
  return String(raw || "")
    .split(/[\s,，;；]+/)
    .map((value) => String(value || "").trim().replace(/^#+/, ""))
    .map((value) => value.replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, ""))
    .filter((value) => value && !/[\u3400-\u9fff]/u.test(value) && /[\p{L}\p{N}]/u.test(value))
    .map((value) => `#${value}`.slice(0, 80))
    .filter((value, index, list) => list.indexOf(value) === index)
    .slice(0, 20);
}

function extractAttributeValue(item = {}, names = [], ids = []) {
  const attrs = Array.isArray(item.attributes) ? item.attributes : [];
  for (const attr of attrs) {
    const name = String(attr?.name || attr?.attribute_name || "").toLowerCase();
    const attrId = Number(attr?.id || attr?.attribute_id || 0);
    const matchesName = names.some((needle) => name.includes(String(needle).toLowerCase()));
    const matchesId = ids.some((id) => Number(id) === attrId);
    if (!matchesName && !matchesId) continue;
    const values = Array.isArray(attr.values) ? attr.values : [];
    const first = values.map((value) => value?.value || value?.name || value?.text || value).filter(Boolean)[0];
    return String(attr.value || first || "").trim();
  }
  return "";
}

function extractRichContentJson(item = {}) {
  if (item.rich_content_json) return String(item.rich_content_json || "");
  const direct = extractAttributeValue(item, ["JSON富内容", "Rich", "rich"], [11254]);
  if (direct) return direct;
  const complexGroups = Array.isArray(item.complex_attributes) ? item.complex_attributes : [];
  for (const group of complexGroups) {
    const attrs = Array.isArray(group.attributes) ? group.attributes : [];
    const richAttr = attrs.find((attr) => String(attr?.id || "").toLowerCase() === "rich_content_json" || Number(attr?.id || 0) === 11254);
    const value = richAttr?.values?.[0]?.value;
    if (value) return String(value);
  }
  return "";
}

async function openDrawer(row) {
  if (row?.row_type === "draft") {
    editInListingAutomation(row);
    return;
  }
  const detail = await loadPublishRecordDetail(row);
  const payload = plainClone(detail.request, { items: [] });
  const item = payload.items?.[0] || {};
  drawer.row = detail;
  drawerPayloadCache = payload;
  drawerResponseCache = { response: detail.response, error: detail.error };
  drawer.technicalJsonLoaded = false;
  activeRepairTarget.value = "";
  drawer.payloadText = "";
  drawer.responseText = "";
  drawer.form = {
    name: item.name || "",
    offer_id: item.offer_id || "",
    price: item.price || "",
    old_price: item.old_price || "",
    primary_image: item.primary_image || "",
    imagesText: (item.images || []).join("\n"),
    videoUrlsText: extractVideoUrls(item).join("\n")
  };
  drawer.visible = true;
}

function plainClone(value, fallback = {}) {
  try {
    return JSON.parse(JSON.stringify(value ?? fallback));
  } catch {
    return fallback;
  }
}

function applyFormToPayload() {
  const payload = drawer.technicalJsonLoaded
    ? JSON.parse(drawer.payloadText || "{}")
    : plainClone(drawerPayloadCache || {}, {});
  if (!Array.isArray(payload.items) || !payload.items[0]) payload.items = [{}];
  const item = payload.items[0];
  item.name = drawer.form.name;
  item.offer_id = drawer.form.offer_id;
  item.price = String(drawer.form.price || "");
  item.old_price = String(drawer.form.old_price || drawer.form.price || "");
  item.primary_image = drawer.form.primary_image;
  item.images = splitLines(drawer.form.imagesText);
  setVideoUrls(item, splitLines(drawer.form.videoUrlsText));
  drawerPayloadCache = payload;
  if (drawer.technicalJsonLoaded) drawer.payloadText = JSON.stringify(payload, null, 2);
  return payload;
}

function loadDrawerTechnicalJson() {
  drawer.payloadText = JSON.stringify(drawerPayloadCache || {}, null, 2);
  drawer.responseText = JSON.stringify(drawerResponseCache || {}, null, 2);
  drawer.technicalJsonLoaded = true;
}

async function retryRecord() {
  if (!drawer.row?.id) return;
  let payload;
  try {
    payload = applyFormToPayload();
  } catch {
    ElMessage.error("技术 JSON 格式不正确");
    return;
  }
  retrying.value = true;
  try {
    const updated = await apiClient.post(`/api/listing/publish-records/${drawer.row.id}/retry`, {
      payload,
      updated_at: drawer.row.updated_at || ""
    });
    drawerResponseCache = { response: updated.response, error: updated.error };
    if (drawer.technicalJsonLoaded) drawer.responseText = JSON.stringify(drawerResponseCache, null, 2);
    const index = state.rows.findIndex((row) => Number(row.id) === Number(updated.id));
    if (index >= 0) state.rows[index] = updated;
    drawer.visible = false;
    ElMessage.success("已重新提交 Ozon，可稍后刷新状态");
  } finally {
    retrying.value = false;
  }
}

async function refreshRecord(row) {
  if (row?.row_type === "draft") {
    await loadRecords();
    return;
  }
  refreshingId.value = row.id;
  try {
    const updated = await apiClient.post(`/api/listing/publish-records/${row.id}/refresh`, {});
    const index = state.rows.findIndex((item) => Number(item.id) === Number(updated.id));
    if (index >= 0) state.rows[index] = updated;
    ElMessage.success("状态已刷新");
  } finally {
    refreshingId.value = null;
  }
}

async function batchRefreshRecords() {
  const rows = selectedRows.value.filter((row) => row?.id && row.row_type !== "draft");
  if (!rows.length) {
    ElMessage.warning("请先选择要刷新的上架记录");
    return;
  }
  batchRefreshing.value = true;
  try {
    let success = 0;
    for (const row of rows) {
      const updated = await apiClient.post(`/api/listing/publish-records/${row.id}/refresh`, {});
      const index = state.rows.findIndex((item) => Number(item.id) === Number(updated.id));
      if (index >= 0) state.rows[index] = updated;
      success += 1;
    }
    ElMessage.success(`已刷新 ${success} 条上架记录`);
  } finally {
    batchRefreshing.value = false;
  }
}

async function deleteRecord(row) {
  if (row?.row_type === "draft") {
    await ElMessageBox.confirm(
      "删除后该草稿不再显示，未提交的等待上架副本也会同步移除。",
      "确认删除草稿",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
    );
    deletingId.value = row.id;
    try {
      await apiClient.delete(`/api/listing/drafts/${row.id}`);
      ElMessage.success("草稿已删除");
      await reloadRecordsAfterDelete(1);
    } finally {
      deletingId.value = null;
    }
    return;
  }
  await ElMessageBox.confirm(
    "删除后这条上架记录不会再显示在列表里，已经在 Ozon 上架的商品不会被下架。",
    "确认删除上架记录",
    { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
  );
  deletingId.value = row.id;
  try {
    await apiClient.delete(`/api/listing/publish-records/${row.id}`);
    ElMessage.success("上架记录已删除");
    await reloadRecordsAfterDelete(1);
  } finally {
    deletingId.value = null;
  }
}

async function batchDeleteRecords() {
  const rows = isDraftMode.value
    ? selectedDraftRows.value
    : selectedRows.value.filter((row) => row?.id && row.row_type !== "draft");
  if (!rows.length) {
    ElMessage.warning(isDraftMode.value ? "请先选择要删除的草稿" : "请先选择要删除的上架记录");
    return;
  }
  if (isDraftMode.value) {
    await ElMessageBox.confirm(
      `确认删除选中的 ${rows.length} 个草稿？未提交的等待上架副本也会同步移除。`,
      "批量删除草稿",
      { type: "warning", confirmButtonText: "批量删除", cancelButtonText: "取消" }
    );
    batchDeleting.value = true;
    try {
      const ids = new Set(rows.map((row) => Number(row.id)));
      await Promise.all(rows.map((row) => apiClient.delete(`/api/listing/drafts/${row.id}`)));
      selectedRows.value = [];
      ElMessage.success(`已删除 ${ids.size} 个草稿`);
      await reloadRecordsAfterDelete(ids.size);
    } finally {
      batchDeleting.value = false;
    }
    return;
  }
  await ElMessageBox.confirm(
    `确认删除选中的 ${rows.length} 条上架记录？已经在 Ozon 上架的商品不会被下架。`,
    "批量删除上架记录",
    { type: "warning", confirmButtonText: "批量删除", cancelButtonText: "取消" }
  );
  batchDeleting.value = true;
  try {
    const ids = new Set(rows.map((row) => Number(row.id)));
    await apiClient.post("/api/listing/publish-records/batch-delete", { ids: [...ids] });
    selectedRows.value = [];
    ElMessage.success(`已删除 ${ids.size} 条上架记录`);
    await reloadRecordsAfterDelete(ids.size);
  } finally {
    batchDeleting.value = false;
  }
}

function openBatchListingDialog() {
  const rows = selectedDraftRows.value;
  if (!rows.length) {
    ElMessage.warning("请先选择编辑中或等待上架的草稿");
    return;
  }
  batchListing.shopIds = state.shops.map((shop) => shop.id).slice(0, 1);
  batchListing.requestId = createListingPublishRequestId();
  batchListing.result = null;
  ensureBatchTextVariantBaseShop();
  batchListing.visible = true;
}

function selectedBatchTextVariantShops() {
  const selected = new Set(batchListing.shopIds.map((id) => String(id)));
  return state.shops.filter((shop) => selected.has(String(shop.id)));
}

function ensureBatchTextVariantBaseShop() {
  if (!batchListing.shopIds.length) {
    batchListing.baseShopId = "";
    batchListing.shopStyles = {};
    return;
  }
  if (!batchListing.shopIds.some((id) => String(id) === String(batchListing.baseShopId))) {
    batchListing.baseShopId = batchListing.shopIds[0];
  }
  syncBatchTextVariantShopStyles();
}

function syncBatchTextVariantShopStyles() {
  const selected = new Set(batchListing.shopIds.map((id) => String(id)));
  Object.keys(batchListing.shopStyles || {}).forEach((shopId) => {
    if (!selected.has(String(shopId))) delete batchListing.shopStyles[shopId];
  });
  batchListing.shopIds.forEach((shopId) => {
    const key = String(shopId);
    if (!batchListing.shopStyles[key]) batchListing.shopStyles[key] = batchListing.textVariantStyle || "light";
  });
}

function setAllBatchTextVariantStyles(style) {
  batchListing.textVariantStyle = style;
  batchListing.shopIds.forEach((shopId) => {
    if (String(shopId) !== String(batchListing.baseShopId)) {
      batchListing.shopStyles[String(shopId)] = style;
    }
  });
}

function buildBatchTextVariantPolicy() {
  return {
    enabled: Boolean(batchListing.textVariantEnabled && batchListing.shopIds.length > 1),
    base_shop_id: batchListing.baseShopId || batchListing.shopIds[0] || "",
    style: batchListing.textVariantStyle,
    shop_styles: batchListing.shopStyles,
    fields: batchListing.textVariantFields,
    failure_mode: batchListing.textVariantFailureMode
  };
}

async function publishBatchListingDrafts() {
  const rows = selectedDraftRows.value;
  if (!rows.length) {
    ElMessage.warning("请先选择编辑中或等待上架的草稿");
    return;
  }
  if (!batchListing.shopIds.length) {
    ElMessage.warning("请选择要上架的店铺");
    return;
  }
  await ElMessageBox.confirm(
    `将按 ${rows.length} 个草稿 x ${batchListing.shopIds.length} 个店铺正式提交到 Ozon。提交前会逐个校验图片、视频、类目和必填属性。`,
    "确认批量上架",
    { type: "warning", confirmButtonText: "批量上架", cancelButtonText: "取消" }
  );
  batchListing.publishing = true;
  batchListing.browserPreparing = true;
  batchListing.browserCompleted = 0;
  batchListing.browserTotal = 0;
  batchListing.result = null;
  try {
    const bootstrap = await apiClient.get("/api/asset-variant-engine/bootstrap", { noCache: true });
    const selectedShopIds = new Set(batchListing.shopIds.map(Number));
    const selectedShops = (Array.isArray(bootstrap?.shops) ? bootstrap.shops : [])
      .filter((shop) => selectedShopIds.has(Number(shop.id)))
      .map((shop) => ({
        id: Number(shop.id),
        name: String(shop.name || `店铺 ${shop.id}`),
        watermarkPath: String(shop.watermarkPath || shop.watermark_path || shop.logoUrl || ""),
        watermarkPosition: String(shop.watermarkPosition || shop.watermark_position || "bottom-right"),
        watermarkXPercent: Number(shop.watermarkXPercent ?? shop.watermark_x_percent ?? 75),
        watermarkYPercent: Number(shop.watermarkYPercent ?? shop.watermark_y_percent ?? 75),
        watermarkScalePercent: Number(shop.watermarkScalePercent ?? shop.watermark_scale_percent ?? 22),
        watermarkOpacityPercent: Number(shop.watermarkOpacityPercent ?? shop.watermark_opacity_percent ?? 82)
      }));
    if (selectedShops.length !== selectedShopIds.size) throw new Error("部分目标店铺的浏览器素材配置加载失败");
    const mediaJobs = rows.map((row) => {
      const images = [...new Set(draftListImages(row).filter(Boolean))];
      if (!images.length) throw new Error(`草稿 ${row.id} 没有可处理的商品图片`);
      return { productId: `draft-${row.id}`, images, shops: selectedShops };
    });
    const preparedByDraft = await prepareBrowserWatermarkJobs({
      jobs: mediaJobs,
      onProgress(progress) {
        batchListing.browserCompleted = Number(progress.completed || 0);
        batchListing.browserTotal = Number(progress.total || 0);
      }
    });
    const preparedMediaByDraftShop = {};
    for (const row of rows) {
      const prepared = preparedByDraft[`draft-${row.id}`] || {};
      for (const shop of selectedShops) {
        preparedMediaByDraftShop[`${Number(row.id)}:${shop.id}`] = prepared[String(shop.id)] || prepared[shop.id] || [];
      }
    }
    batchListing.browserPreparing = false;
    const result = await apiClient.post("/api/listing/drafts/batch-publish", {
      draft_ids: rows.map((row) => row.id),
      shop_ids: batchListing.shopIds,
      request_id: batchListing.requestId,
      text_variant_policy: buildBatchTextVariantPolicy(),
      prepared_media_by_draft_shop: preparedMediaByDraftShop
    });
    batchListing.result = result;
    const success = Number(result?.summary?.queued || result?.summary?.success || 0);
    const failed = Number(result?.summary?.failed || 0);
    if (success) {
      ElMessage.success(`已创建 ${success} 条上架任务，状态会在上架记录中更新`);
      batchListing.visible = false;
      const query = result?.task?.id
        ? { tab: "tasks", taskId: String(result.task.id) }
        : { tab: "tasks" };
      await router.push({ name: "listing-publish-records", query });
    } else {
      ElMessage.error("批量上架任务创建失败，请查看结果");
    }
    if (failed && success) ElMessage.warning(`${failed} 条任务创建失败，请查看结果`);
  } finally {
    batchListing.browserPreparing = false;
    batchListing.publishing = false;
  }
}

function guardBatchBrowserPublishClose(event) {
  if (!batchListing.browserPreparing) return;
  event.preventDefault();
  event.returnValue = "";
}

function batchOpenDraftsForListing() {
  const rows = selectedDraftRows.value;
  if (!rows.length) {
    ElMessage.warning("请先选择编辑中或等待上架的草稿");
    return;
  }
  const first = rows[0];
  router.push({
    name: "listing-automation",
    query: {
      workbenchId: createListingWorkbenchId(),
      tabTitle: rows.length > 1 ? `商品上架 · ${rows.length} 个草稿` : `商品上架 · 草稿 ${first.id}`,
      draftId: first.id,
      draftIds: rows.map((row) => row.id).join(","),
      returnTo: router.currentRoute.value.fullPath
    }
  });
}

function extractVideoUrls(item = {}) {
  return (item.complex_attributes || [])
    .flatMap((group) => group.attributes || [])
    .filter((attr) => Number(attr.id || 0) === 21841)
    .flatMap((attr) => attr.values || [])
    .map((value) => String(value.value || "").trim())
    .filter(Boolean);
}

function setVideoUrls(item, urls = []) {
  const others = (item.complex_attributes || []).filter((group) => {
    const attrs = group.attributes || [];
    return !attrs.some((attr) => [21841, 21837].includes(Number(attr.id || 0)));
  });
  if (urls.length) {
    others.push({
      attributes: [
        { complex_id: 100001, id: 21841, values: urls.map((url) => ({ value: url })) },
        { complex_id: 100001, id: 21837, values: urls.map((url, index) => ({ value: videoName(url, index) })) }
      ]
    });
  }
  item.complex_attributes = others;
}

function videoName(url, index) {
  try {
    return new URL(url).pathname.split("/").pop()?.replace(/\.[^.]+$/, "") || `video_${index + 1}`;
  } catch {
    return `video_${index + 1}`;
  }
}

function splitLines(value) {
  return String(value || "").split(/\r?\n|,|，/).map((item) => item.trim()).filter(Boolean);
}

function previewImageUrl(url = "") {
  if (url && typeof url === "object") {
    return previewImageUrl(url.url || url.image_url || url.imageUrl || url.src || url.link || url.href || url.file_name || "");
  }
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.origin === window.location.origin && parsed.pathname.startsWith("/uploads/")) return withImageToken(`${parsed.pathname}${parsed.search}`);
    } catch {
      return value;
    }
  }
  if (value.startsWith("/")) return withImageToken(value);
  return value;
}

function isWeakPreviewImageUrl(url = "") {
  const value = String(url || "").trim();
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.origin === window.location.origin) return false;
    if (!parsed.pathname.startsWith("/uploads/")) return false;
    return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function rawRecordPreviewCandidates(row = {}) {
  return [
    row.primary_image,
    ...(Array.isArray(row.images) ? row.images : []),
    row.fallback_image
  ]
    .map(previewImageUrl)
    .filter(Boolean)
    .sort((left, right) => Number(isWeakPreviewImageUrl(left)) - Number(isWeakPreviewImageUrl(right)));
}

function recordPreviewCandidates(row = {}) {
  return Array.isArray(row.preview_candidates) ? row.preview_candidates : rawRecordPreviewCandidates(row);
}

function recordPreviewImage(row = {}) {
  return recordPreviewCandidates(row)[0] || "";
}

function handleRecordImageError(event, row = {}) {
  const image = event?.currentTarget;
  if (!image) return;
  const candidates = recordPreviewCandidates(row);
  const currentIndex = Number(image.dataset.previewIndex || 0);
  const next = candidates[currentIndex + 1];
  if (next) {
    image.dataset.previewIndex = String(currentIndex + 1);
    image.src = next;
    return;
  }
  image.dataset.previewIndex = String(candidates.length);
  image.src = recordImagePlaceholder;
}

function handlePublishViewChange(name) {
  publishView.value = name || "records";
  const query = { ...route.query };
  if (publishView.value === "tasks") query.tab = "tasks";
  else delete query.tab;
  delete query.taskId;
  router.replace({ name: route.name, query });
  if (publishView.value === "tasks") Promise.all([loadPeople(), loadPublishTasks()]);
  else loadRecords();
}

onMounted(async () => {
  window.addEventListener("beforeunload", guardBatchBrowserPublishClose);
  publishView.value = route.query.tab === "tasks" ? "tasks" : "records";
  applyRouteStatusFilter();
  applyRouteShopFilter();
  if (isTaskMode.value) {
    await Promise.all([loadPeople(), loadPublishTasks()]);
    if (route.query.taskId) await openTaskDrawer({ id: Number(route.query.taskId) });
  } else {
    await Promise.all([loadShops(), loadPeople(), loadRecords()]);
    await openRoutePublishRecord();
  }
});

onBeforeUnmount(() => window.removeEventListener("beforeunload", guardBatchBrowserPublishClose));

watch(pageMode, () => {
  resetModeFiltersFromRoute();
  if (!state.people.length) loadPeople();
});

watch(() => route.query.tab, () => {
  const next = route.query.tab === "tasks" ? "tasks" : "records";
  if (publishView.value === next) return;
  publishView.value = next;
  if (isTaskMode.value) Promise.all([loadPeople(), loadPublishTasks()]);
  else loadRecords();
});

watch(() => route.query.status, () => {
  if (isTaskMode.value) return;
  applyRouteStatusFilter();
  state.page = 1;
  loadRecords();
});

watch(() => route.query.shopId, () => {
  if (isTaskMode.value) return;
  applyRouteShopFilter();
  state.page = 1;
  loadRecords();
});

watch(() => route.query.recordId, () => {
  if (isTaskMode.value) return;
  openRoutePublishRecord();
});

watch(() => route.query.taskId, () => {
  if (!isTaskMode.value) return;
  loadPublishTasks();
  if (route.query.taskId) openTaskDrawer({ id: Number(route.query.taskId) });
});
</script>

<template>
  <div class="page-stack publish-records-page erp-paged-page">
    <el-tabs v-if="isPublishMode" v-model="publishView" class="publish-view-tabs" @tab-change="handlePublishViewChange">
      <el-tab-pane label="上架记录" name="records" />
      <el-tab-pane label="上架任务" name="tasks" />
    </el-tabs>

    <template v-if="!isTaskMode">
    <section class="toolbar-panel">
      <div class="toolbar-filters">
        <el-input v-model="state.nameQuery" :prefix-icon="Search" clearable placeholder="名称 / offer_id" @keyup.enter="searchRecords" @clear="searchRecords" />
        <el-select v-model="state.shopId" filterable placeholder="店铺" @change="searchRecords">
          <el-option label="全部店铺" value="all" />
          <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="shop.id" />
        </el-select>
        <el-select v-model="state.creatorId" filterable placeholder="人员" @change="searchRecords">
          <el-option label="全部人员" value="all" />
          <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="person.id" />
        </el-select>
        <el-select v-if="isDraftMode" v-model="state.developmentType" placeholder="类型" @change="searchRecords">
          <el-option label="全部类型" value="all" />
          <el-option v-for="option in developmentTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <el-input v-model="state.query" clearable placeholder="offer / product id / 类目" @keyup.enter="searchRecords" @clear="searchRecords" />
        <el-select v-model="state.status" placeholder="状态" @change="searchRecords">
          <el-option v-for="option in statusOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <el-select v-if="isPublishMode" v-model="state.quality" placeholder="评分" @change="searchRecords">
          <el-option label="全部评分" value="all" />
          <el-option label="85分以下" value="lt85" />
          <el-option label="85分以上" value="gte85" />
          <el-option label="90分以上" value="gte90" />
        </el-select>
      </div>
      <div class="toolbar-actions">
        <el-button v-if="isDraftMode" class="erp-btn erp-btn-primary" type="primary" :icon="Plus" @click="quickCreateDraft">快速创建草稿</el-button>
        <span class="selection-count">已选 {{ selectedRows.length }} / 当前 {{ filteredRows.length }}</span>
        <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Search" @click="searchRecords">查询</el-button>
        <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" :loading="loading || batchRefreshing" @click="refreshToolbarRecords">
          {{ isPublishMode && selectedPublishRows.length ? "同步选中状态" : "刷新列表" }}
        </el-button>
        <el-button v-if="isDraftMode" class="erp-btn erp-btn-primary" type="primary" :disabled="!selectedDraftRows.length" @click="openBatchListingDialog">批量去上架</el-button>
        <el-button v-if="isDraftMode" class="erp-btn erp-btn-secondary" type="primary" plain :icon="Edit" :disabled="selectedDraftRows.length < 2" @click="batchOpenDraftsForListing">批量编辑</el-button>
        <el-button v-if="isDraftMode" class="erp-btn erp-btn-secondary" type="primary" plain :icon="MagicStick" :disabled="!selectedDraftRows.length" @click="openBatchMaterialOptimization">批量优化</el-button>
        <el-button v-if="isDraftMode" class="erp-btn erp-btn-secondary" type="primary" plain :icon="MagicStick" :disabled="!selectedDraftRows.length" @click="batchOpenAiVariantWorkbench">AI裂变</el-button>
        <el-button class="erp-btn erp-btn-danger" type="danger" plain :icon="Delete" :loading="batchDeleting" :disabled="!selectedRows.length" @click="batchDeleteRecords">批量删除</el-button>
        <el-button class="erp-btn erp-btn-secondary" @click="resetFilters">重置</el-button>
      </div>
    </section>

    <div class="publish-table-wrap erp-table-scroll">
      <el-table
        v-loading="loading"
        :data="filteredRows"
        border
        stripe
        class="erp-data-table publish-table"
        row-key="row_key"
        @selection-change="handleSelectionChange"
      >
      <el-table-column type="selection" width="44" fixed="left" />
      <el-table-column label="商品" min-width="420">
        <template #default="{ row }">
          <div class="record-product">
            <ProductImagePreview
              :src="recordPreviewImage(row) || recordImagePlaceholder"
              :preview-list="recordPreviewCandidates(row)"
              size="portrait"
              fit="cover"
              :proxy-remote="false"
            />
            <div>
              <ProductTitleLink :title="publishRecordProductTitle(row)" :href="publishRecordBuyerLink(row)" :lines="2" />
              <span>{{ row.offer_id }}</span>
              <span v-if="vehicleModelText(row)" class="muted-text">{{ vehicleModelText(row) }}</span>
              <em>{{ row.image_count || 0 }} 图 / {{ row.video_urls?.length || 0 }} 视频</em>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column v-if="isDraftMode" label="开发类型" width="116" align="center">
        <template #default="{ row }">
          <el-select
            :model-value="normalizeDevelopmentType(row.development_type)"
            size="small"
            class="development-type-select"
            :loading="developmentSavingDraftId === row.id"
            @change="(value) => updateDraftDevelopmentType(row, value)"
          >
            <el-option
              v-for="option in developmentTypeOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            >
              <el-tag :type="developmentTypeTagType(option.value)" effect="plain" size="small">{{ option.label }}</el-tag>
            </el-option>
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="人员" min-width="116" prop="creator_name" show-overflow-tooltip />
      <el-table-column label="店铺" min-width="136" prop="shop_name" show-overflow-tooltip />
      <el-table-column label="来源" min-width="126" prop="source_label" show-overflow-tooltip />
      <el-table-column :label="isDraftMode ? '草稿状态' : '状态'" min-width="112">
        <template #default="{ row }">
          <el-tag :type="statusType(row.status)" effect="plain">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column v-if="isDraftMode" label="上架状态" min-width="128">
        <template #default="{ row }">
          <el-tooltip :content="row.publish_record_count ? `关联 ${row.publish_record_count} 条上架记录` : '尚未提交到 Ozon'" placement="top">
            <el-tag :type="draftPublishStatusType(row)" effect="plain">{{ draftPublishStatusText(row) }}</el-tag>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column v-if="isPublishMode" label="失败原因" min-width="220">
        <template #default="{ row }">
          <div v-if="publishFailureReason(row)" class="failure-cell">
            <strong>{{ publishFailureReason(row) }}</strong>
            <span v-if="publishFailureFixTip(row)">{{ publishFailureFixTip(row) }}</span>
            <em v-if="publishImportErrorItems(row).length">
              {{ publishImportErrorItems(row)[0].field || publishImportErrorItems(row)[0].code || "Ozon 明细" }}：
              {{ publishImportErrorItems(row)[0].raw_message || publishImportErrorItems(row)[0].message }}
            </em>
          </div>
          <span v-else-if="row.row_type === 'draft'" class="muted-text">草稿可继续编辑或选择店铺上架</span>
          <span v-else class="muted-text">-</span>
        </template>
      </el-table-column>
      <el-table-column v-if="isPublishMode" label="内容评分" width="150">
        <template #default="{ row }">
          <div class="quality-cell">
            <el-tag :type="qualityType(row.quality_score)" effect="plain">{{ row.quality_score ? `${row.quality_score} 分` : "未返回" }}</el-tag>
            <span>{{ qualitySourceText(row.quality_source) }}</span>
            <el-tooltip v-if="row.quality_issues?.length" placement="top" :content="row.quality_issues.join('；')">
              <em>缺项 {{ row.quality_issues.length }}</em>
            </el-tooltip>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="售价" min-width="132">
        <template #default="{ row }">
          <span class="price-cell">{{ recordPriceText(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="isDraftMode ? '生成时间' : '更新时间'" min-width="152">
        <template #default="{ row }">
          <span class="record-text nowrap">{{ compactDateTime(isDraftMode ? row.created_at : (row.updated_at || row.created_at)) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" min-width="360" class-name="record-actions-column">
        <template #default="{ row }">
          <div class="row-actions">
            <el-button class="erp-btn-link" link type="primary" :icon="Edit" :disabled="detailLoadingId === row.id" @click="editInListingAutomation(row)">编辑</el-button>
            <el-button class="erp-btn-link" link type="primary" :icon="MagicStick" @click="openAiWorkbench(row, 'optimization')">AI优化</el-button>
            <el-button class="erp-btn-link" link type="primary" :icon="MagicStick" @click="openAiWorkbench(row, 'variant')">AI裂变</el-button>
            <el-button class="erp-btn-link-danger" link type="danger" :icon="Delete" :disabled="deletingId === row.id" @click="deleteRecord(row)">删除</el-button>
          </div>
        </template>
      </el-table-column>
      </el-table>
    </div>

    <PageFooterPagination
      :total="state.total"
      :page="state.page"
      :page-size="state.pageSize"
      @update:page="handlePageChange"
      @update:pageSize="handlePageSizeChange"
    />
    </template>

    <template v-else>
      <section class="toolbar-panel task-toolbar-panel">
        <div class="toolbar-filters task-toolbar-filters">
          <el-input v-model="taskState.query" :prefix-icon="Search" clearable placeholder="任务编号 / 草稿 / 店铺" @keyup.enter="searchPublishTasks" @clear="searchPublishTasks" />
          <el-select v-model="taskState.creatorId" filterable placeholder="任务人员" @change="searchPublishTasks">
            <el-option label="全部人员" value="all" />
            <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="person.id" />
          </el-select>
          <el-select v-model="taskState.status" placeholder="任务状态" @change="searchPublishTasks">
            <el-option v-for="option in taskStatusOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
        </div>
        <div class="toolbar-actions">
          <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Search" @click="searchPublishTasks">查询</el-button>
          <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" :loading="taskLoading" @click="loadPublishTasks">刷新</el-button>
          <el-button class="erp-btn erp-btn-secondary" @click="resetTaskFilters">重置</el-button>
        </div>
      </section>

      <div class="publish-table-wrap erp-table-scroll">
        <el-table
          v-loading="taskLoading"
          :data="taskState.rows"
          border
          stripe
          class="erp-data-table publish-task-table"
          row-key="id"
        >
          <el-table-column label="任务" min-width="220">
            <template #default="{ row }">
              <div class="task-title-cell">
                <strong>{{ taskDisplayName(row) }}</strong>
                <span>{{ row.task_no || `任务 ${row.id}` }} · {{ row.draft_count }} 草稿 x {{ row.shop_count }} 店铺</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="进度" min-width="280">
            <template #default="{ row }">
              <div class="task-progress-cell">
                <el-progress :percentage="row.progress_percent || 0" :stroke-width="8" />
                <div class="task-counts">
                  <el-tag type="primary" effect="plain">已提交 {{ row.submitted_count || 0 }}</el-tag>
                  <el-tag type="success" effect="plain">Ozon成功 {{ row.result_success_count ?? row.success_count ?? 0 }}</el-tag>
                  <el-tag :type="row.result_failed_count ? 'danger' : 'info'" effect="plain">Ozon失败 {{ row.result_failed_count || 0 }}</el-tag>
                  <el-tag :type="row.failed_count ? 'danger' : 'info'" effect="plain">未提交失败 {{ row.failed_count || 0 }}</el-tag>
                  <el-tag :type="row.interrupted_count ? 'danger' : 'info'" effect="plain">中断 {{ row.interrupted_count || 0 }}</el-tag>
                  <el-tag type="warning" effect="plain">处理中 {{ row.processing_count || 0 }}</el-tag>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="112">
            <template #default="{ row }">
              <el-tag :type="taskStatusType(row.status)" effect="plain">{{ taskStatusText(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="创建人" min-width="120" prop="created_by_name" show-overflow-tooltip />
          <el-table-column label="创建时间" min-width="152">
            <template #default="{ row }">
              <span class="record-text nowrap">{{ compactDateTime(row.created_at) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="更新时间" min-width="152">
            <template #default="{ row }">
              <span class="record-text nowrap">{{ compactDateTime(row.updated_at || row.created_at) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" min-width="220">
            <template #default="{ row }">
              <div class="row-actions">
                <el-button class="erp-btn-link" link type="primary" :icon="View" @click="openTaskDrawer(row)">明细</el-button>
                <el-button class="erp-btn-link" link type="primary" :icon="Refresh" :loading="taskRetryingId === row.id" :disabled="!taskCanRetry(row)" @click="retryPublishTask(row)">重试失败 / 中断项</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <PageFooterPagination
        :total="taskState.total"
        :page="taskState.page"
        :page-size="taskState.pageSize"
        @update:page="handleTaskPageChange"
        @update:pageSize="handleTaskPageSizeChange"
      />
    </template>

    <el-drawer v-model="drawer.visible" :title="drawerTitle" size="760px">
      <div v-if="drawer.row" class="record-drawer">
        <section class="drawer-hero">
          <ProductImagePreview
            :src="recordPreviewImage(drawer.row) || recordImagePlaceholder"
            :preview-list="recordPreviewCandidates(drawer.row)"
            size="portrait"
            fit="cover"
            proxy-remote
          />
          <div>
            <el-tag :type="statusType(drawer.row.status)" effect="plain">{{ statusText(drawer.row.status) }}</el-tag>
            <strong>{{ drawer.form.name }}</strong>
            <span>{{ drawer.row.shop_name }} / {{ drawer.row.offer_id }}</span>
          </div>
        </section>

        <el-alert
          v-if="publishFailureReason(drawer.row)"
          type="error"
          :title="publishFailureReason(drawer.row)"
          :description="publishFailureFixTip(drawer.row)"
          show-icon
          :closable="false"
        />
        <section v-if="drawerRepairIssues.length" class="repair-panel">
          <div class="repair-panel-head">
            <strong>Ozon 修复导航</strong>
            <span>{{ drawerRepairIssues.length }} 个问题，可逐项定位处理</span>
          </div>
          <div class="repair-issue-list">
            <button
              v-for="issue in drawerRepairIssues"
              :key="`${issue.target}-${issue.index}`"
              type="button"
              class="repair-issue"
              :class="{ active: activeRepairTarget === issue.target }"
              @click="focusRepairIssue(issue)"
            >
              <el-tag :type="issue.target === 'general' || issue.target === 'attributes' || issue.target === 'category' ? 'warning' : 'danger'" effect="plain">
                {{ issue.target_label }}
              </el-tag>
              <span>{{ issue.text }}</span>
              <em v-if="issue.fix_tip">{{ issue.fix_tip }}</em>
            </button>
          </div>
        </section>
        <el-table
          v-if="publishImportErrorItems(drawer.row).length"
          :data="publishImportErrorItems(drawer.row)"
          border
          size="small"
        >
          <el-table-column prop="offer_id" label="Offer ID" min-width="130" />
          <el-table-column prop="field" label="字段" min-width="120" />
          <el-table-column prop="code" label="代码" min-width="120" />
          <el-table-column prop="raw_message" label="Ozon 原因" min-width="260" show-overflow-tooltip />
          <el-table-column prop="fix_tip" label="建议" min-width="220" show-overflow-tooltip />
        </el-table>

        <el-form label-width="96px">
          <el-form-item id="repair-field-name" label="标题" :class="repairFieldClass('name')">
            <el-input v-model="drawer.form.name" />
          </el-form-item>
          <el-form-item id="repair-field-offer_id" label="Offer ID" :class="repairFieldClass('offer_id')">
            <el-input v-model="drawer.form.offer_id" />
          </el-form-item>
          <el-form-item id="repair-field-price" label="售价" :class="repairFieldClass('price')">
            <el-input v-model="drawer.form.price" />
          </el-form-item>
          <el-form-item id="repair-field-old_price" label="划线价" :class="repairFieldClass('old_price')">
            <el-input v-model="drawer.form.old_price" />
          </el-form-item>
          <el-form-item id="repair-field-primary_image" label="主图 URL" :class="repairFieldClass('primary_image')">
            <el-input v-model="drawer.form.primary_image" type="textarea" :rows="2" />
          </el-form-item>
          <el-form-item id="repair-field-images" label="附图 URL" :class="repairFieldClass('images')">
            <el-input v-model="drawer.form.imagesText" type="textarea" :rows="5" placeholder="每行一个图片 URL" />
          </el-form-item>
          <el-form-item id="repair-field-video" label="视频 URL" :class="repairFieldClass('video')">
            <el-input v-model="drawer.form.videoUrlsText" type="textarea" :rows="4" placeholder="每行一个视频公网 URL，重试时会替换原视频" />
          </el-form-item>
        </el-form>

        <el-collapse>
          <el-collapse-item title="技术 JSON">
            <div class="technical-json-toolbar">
              <el-button v-if="!drawer.technicalJsonLoaded" class="erp-btn erp-btn-secondary" :icon="View" @click="loadDrawerTechnicalJson">加载技术 JSON</el-button>
            </div>
            <el-input v-if="drawer.technicalJsonLoaded" v-model="drawer.payloadText" type="textarea" :rows="18" />
            <el-empty v-else description="技术 JSON 较大，默认不渲染；需要查看或手改时再加载。" />
          </el-collapse-item>
          <el-collapse-item title="Ozon 返回 / 错误">
            <el-input v-if="drawer.technicalJsonLoaded" v-model="drawer.responseText" type="textarea" :rows="14" readonly />
            <el-empty v-else description="返回明细按需加载，避免大 JSON 卡住页面。" />
          </el-collapse-item>
        </el-collapse>

        <div class="drawer-actions">
          <el-button class="erp-btn erp-btn-secondary" :icon="VideoCamera" @click="applyFormToPayload">同步到技术 JSON</el-button>
          <el-button class="erp-btn erp-btn-danger" type="danger" :icon="Edit" :loading="retrying" @click="retryRecord">保存并重新提交</el-button>
        </div>
      </div>
    </el-drawer>

    <el-drawer v-model="taskDrawer.visible" title="上架任务明细" size="920px">
      <div v-loading="taskDrawer.loading" class="task-drawer">
        <template v-if="taskDrawer.task">
          <section class="task-drawer-summary">
            <div>
              <strong>{{ taskDisplayName(taskDrawer.task) }}</strong>
              <span>{{ taskDrawer.task.draft_count }} 个草稿 / {{ taskDrawer.task.shop_count }} 个店铺 / {{ taskDrawer.task.total_count }} 个上架项</span>
            </div>
            <el-tag :type="taskStatusType(taskDrawer.task.status)" effect="plain">{{ taskStatusText(taskDrawer.task.status) }}</el-tag>
          </section>
          <section class="task-drawer-progress">
            <el-progress :percentage="taskDrawer.task.progress_percent || 0" :stroke-width="9" />
            <div class="task-counts">
              <el-tag type="primary" effect="plain">已提交 {{ taskDrawer.task.submitted_count || 0 }}</el-tag>
              <el-tag type="success" effect="plain">Ozon成功 {{ taskDrawer.task.result_success_count ?? taskDrawer.task.success_count ?? 0 }}</el-tag>
              <el-tag :type="taskDrawer.task.result_failed_count ? 'danger' : 'info'" effect="plain">Ozon失败 {{ taskDrawer.task.result_failed_count || 0 }}</el-tag>
              <el-tag :type="taskDrawer.task.failed_count ? 'danger' : 'info'" effect="plain">未提交失败 {{ taskDrawer.task.failed_count || 0 }}</el-tag>
              <el-tag :type="taskDrawer.task.interrupted_count ? 'danger' : 'info'" effect="plain">中断 {{ taskDrawer.task.interrupted_count || 0 }}</el-tag>
              <el-tag type="warning" effect="plain">处理中 {{ taskDrawer.task.processing_count || 0 }}</el-tag>
            </div>
            <el-button
              class="erp-btn erp-btn-primary"
              type="primary"
              :icon="Refresh"
              :loading="taskRetryingId === taskDrawer.task.id"
              :disabled="!taskCanRetry(taskDrawer.task)"
              @click="retryPublishTask(taskDrawer.task)"
            >
              重试失败 / 中断项
            </el-button>
          </section>
          <el-table :data="taskDrawer.task.items || []" border stripe class="erp-data-table publish-task-item-table">
            <el-table-column label="草稿" min-width="220">
              <template #default="{ row }">
                <div class="task-title-cell">
                  <strong>{{ row.draft_name || `草稿 ${row.draft_id}` }}</strong>
                  <span>ID {{ row.draft_id }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="店铺" min-width="150" prop="shop_name" show-overflow-tooltip />
            <el-table-column label="状态" width="128">
              <template #default="{ row }">
                <el-tag :type="taskStatusType(row.status)" effect="plain">{{ taskItemStatusText(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="上架记录" min-width="136">
              <template #default="{ row }">
                <el-button v-if="row.record_id" class="erp-btn-link" link type="primary" @click="openTaskRecord(row.record_id)">
                  记录 #{{ row.record_id }}
                </el-button>
                <span v-else class="muted-text">未生成</span>
              </template>
            </el-table-column>
            <el-table-column label="失败原因" min-width="260">
              <template #default="{ row }">
                <div v-if="row.error_summary" class="failure-cell">
                  <strong>{{ row.error_summary }}</strong>
                  <span v-if="row.error_fix_tip">{{ row.error_fix_tip }}</span>
                </div>
                <span v-else class="muted-text">-</span>
              </template>
            </el-table-column>
            <el-table-column label="更新时间" min-width="152">
              <template #default="{ row }">
                <span class="record-text nowrap">{{ compactDateTime(row.updated_at || row.created_at) }}</span>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </div>
    </el-drawer>

    <el-dialog v-model="batchListing.visible" title="批量上架草稿" width="560px">
      <el-form label-width="92px">
        <el-form-item label="草稿数量">
          <span class="record-text">已选择 {{ selectedDraftRows.length }} 个草稿项目</span>
        </el-form-item>
        <el-form-item label="目标店铺">
          <el-select v-model="batchListing.shopIds" multiple filterable collapse-tags collapse-tags-tooltip placeholder="请选择店铺" @change="ensureBatchTextVariantBaseShop">
            <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="shop.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="文案变体">
          <div class="batch-text-variant-panel">
            <div class="batch-text-variant-main">
              <el-switch v-model="batchListing.textVariantEnabled" :disabled="batchListing.shopIds.length < 2" active-text="多店铺发布时启用" />
              <span>{{ batchListing.shopIds.length < 2 ? "选择两个以上店铺后可用" : "基准店铺保留原文，其他店铺按策略轻量改写" }}</span>
            </div>
            <div v-if="batchListing.textVariantEnabled" class="batch-text-variant-controls">
              <div class="batch-text-variant-row">
                <span>批量策略</span>
                <el-select :model-value="batchListing.textVariantStyle" placeholder="批量设置其他店铺" @update:model-value="setAllBatchTextVariantStyles">
                  <el-option v-for="item in textVariantStyleOptions" :key="item.value" :label="item.label" :value="item.value" />
                </el-select>
              </div>
              <el-checkbox-group v-model="batchListing.textVariantFields">
                <el-checkbox label="title">标题</el-checkbox>
                <el-checkbox label="tags">标签</el-checkbox>
                <el-checkbox label="description">简介</el-checkbox>
              </el-checkbox-group>
              <div class="batch-text-variant-row">
                <span>AI失败时</span>
                <el-radio-group v-model="batchListing.textVariantFailureMode">
                  <el-radio-button label="block">阻断该店铺</el-radio-button>
                  <el-radio-button label="keep_original">沿用原文</el-radio-button>
                </el-radio-group>
              </div>
              <div class="batch-text-variant-shops">
                <div v-for="shop in selectedBatchTextVariantShops()" :key="shop.id" class="batch-text-variant-shop">
                  <span>{{ shop.name }}</span>
                  <el-radio
                    :model-value="batchListing.baseShopId"
                    :label="shop.id"
                    @update:model-value="batchListing.baseShopId = $event; syncBatchTextVariantShopStyles()"
                  >
                    原版保留
                  </el-radio>
                  <el-select
                    v-if="String(shop.id) !== String(batchListing.baseShopId)"
                    v-model="batchListing.shopStyles[String(shop.id)]"
                    placeholder="选择策略"
                  >
                    <el-option v-for="item in textVariantStyleOptions" :key="item.value" :label="item.label" :value="item.value" />
                  </el-select>
                  <em v-else>不改当前文案</em>
                </div>
              </div>
            </div>
          </div>
        </el-form-item>
      </el-form>
      <el-alert
        v-if="batchListing.browserPreparing"
        type="info"
        show-icon
        :closable="false"
        :title="`浏览器正在以并发 10 处理批量素材：${batchListing.browserCompleted}/${batchListing.browserTotal}`"
      />
      <el-alert
        v-if="batchListing.result"
        class="batch-publish-result"
        :type="batchListing.result.ok ? 'success' : 'warning'"
        :title="`提交结果：成功 ${batchListing.result.summary?.success || 0}，失败 ${batchListing.result.summary?.failed || 0}`"
        show-icon
        :closable="false"
      >
        <template v-if="batchPublishFailedResults.length" #default>
          <div class="batch-publish-failures">
            <div
              v-for="(item, index) in batchPublishFailedResults"
              :key="`${item.draft_id || 'draft'}-${item.shop_id || 'shop'}-${index}`"
              class="batch-publish-failure-item"
            >
              <div class="batch-publish-failure-title">
                {{ item.draft_name || `草稿 ${item.draft_id || '-'}` }}
                <span v-if="item.shop_name"> / {{ item.shop_name }}</span>
              </div>
              <div class="batch-publish-failure-reason">{{ item.error || "任务创建失败" }}</div>
              <div v-if="item.fix_tip" class="batch-publish-failure-tip">建议：{{ item.fix_tip }}</div>
            </div>
          </div>
        </template>
      </el-alert>
      <template #footer>
        <el-button @click="batchListing.visible = false">取消</el-button>
        <el-button type="primary" :loading="batchListing.publishing" @click="publishBatchListingDrafts">批量上架</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="batchMaterialOptimization.visible" title="批量优化草稿" width="960px">
      <el-form label-width="92px">
        <el-form-item label="草稿数量">
          <span class="record-text">已选择 {{ selectedDraftRows.length }} 个草稿，系统将复制生成新草稿，不修改原草稿。</span>
        </el-form-item>
        <el-form-item label="优化方向">
          <el-segmented v-model="batchMaterialOptimization.scope" :options="[
            { label: '只优化主图', value: 'main_only' },
            { label: '全部优化', value: 'full' }
          ]" />
        </el-form-item>
        <el-form-item label="商品事实">
          <div class="batch-material-facts">
            <div v-for="item in batchMaterialOptimization.facts" :key="item.draftId" class="batch-material-fact-row">
              <strong>草稿 {{ item.draftId }}</strong>
              <el-input v-model="item.productTitleZh" placeholder="中文精确产品名称（必填）" @input="item.confirmed = false" />
              <el-input v-model="item.compatibilityZh" placeholder="适配车型 / 适用对象" @input="item.confirmed = false" />
              <el-input v-model="item.sellingPointsZh" type="textarea" :rows="2" placeholder="至少 2 条真实卖点，每行一条" @input="item.confirmed = false" />
              <el-input v-model="item.forbiddenFactsZh" type="textarea" :rows="2" placeholder="禁止 AI 编写的内容" @input="item.confirmed = false" />
              <el-checkbox v-model="item.confirmed">确认本行商品事实准确</el-checkbox>
            </div>
          </div>
        </el-form-item>
      </el-form>
      <el-alert
        title="提交后由后台自动完成识别、审批、生成、质检和复制草稿，可在素材优化记录中持续查看。"
        type="info"
        show-icon
        :closable="false"
      />
      <template #footer>
        <el-button @click="batchMaterialOptimization.visible = false">取消</el-button>
        <el-button type="primary" :loading="batchMaterialOptimization.submitting" @click="submitBatchMaterialOptimization">开始批量优化</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.publish-records-page { gap: 12px; min-height: 0; }
.batch-material-facts { width: 100%; max-height: 520px; overflow: auto; display: grid; gap: 10px; }
.batch-material-fact-row { display: grid; grid-template-columns: 100px 1.1fr 1fr 1.3fr 1.3fr; gap: 8px; align-items: start; padding: 10px; border: 1px solid #e5eaf3; border-radius: 8px; }
.batch-material-fact-row strong { line-height: 32px; }
.batch-material-fact-row .el-checkbox { grid-column: 2 / -1; }
.publish-view-tabs {
  flex: 0 0 auto;
  padding: 0 2px;
}
.publish-view-tabs :deep(.el-tabs__header) { margin: 0; }
.record-product span, .record-product em, .drawer-hero span, .muted-text { color: #697386; font-size: 12px; }
.toolbar-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid #e5eaf3;
  border-radius: 8px;
  background: #fff;
  padding: 10px 12px;
}
.toolbar-filters {
  display: grid;
  grid-template-columns: 190px 140px 140px 120px minmax(180px, 1fr) 120px;
  gap: 10px;
  flex: 1;
  min-width: 0;
}
.toolbar-filters > * { width: 100%; min-width: 0; }
.task-toolbar-filters {
  grid-template-columns: minmax(260px, 420px) 160px 140px;
  flex: 0 1 620px;
}
.toolbar-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: nowrap;
  white-space: nowrap;
}
.batch-text-variant-panel { width: 100%; display: flex; flex-direction: column; gap: 10px; }
.batch-text-variant-main, .batch-text-variant-row, .batch-text-variant-shop {
  display: flex;
  align-items: center;
  gap: 10px;
}
.batch-text-variant-main span, .batch-text-variant-shop em { color: #697386; font-size: 12px; font-style: normal; }
.batch-text-variant-controls { display: flex; flex-direction: column; gap: 10px; padding: 10px; border: 1px solid #e5eaf3; border-radius: 6px; background: #f8fbff; }
.batch-text-variant-row > span { color: #1f2d3d; font-size: 12px; }
.batch-text-variant-row .el-select { width: 180px; }
.batch-text-variant-shops { display: flex; flex-direction: column; gap: 8px; max-height: 190px; overflow: auto; }
.batch-text-variant-shop { justify-content: space-between; padding: 8px 10px; border: 1px solid #edf1f7; border-radius: 6px; background: #fff; }
.batch-text-variant-shop > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.batch-text-variant-shop .el-select { width: 150px; }
.batch-publish-result { margin-top: 10px; }
.batch-publish-failures { margin-top: 8px; display: grid; gap: 8px; }
.batch-publish-failure-item {
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.72);
  border: 1px solid rgba(230, 162, 60, 0.22);
}
.batch-publish-failure-title { color: #303133; font-weight: 600; }
.batch-publish-failure-reason,
.batch-publish-failure-tip { margin-top: 4px; color: #606266; line-height: 1.5; }
.selection-count {
  color: #697386;
  font-size: 12px;
  white-space: nowrap;
}
.publish-table-wrap {
  flex: 1 1 auto;
}
.publish-table {
  width: 100%;
}
.publish-task-table,
.publish-task-item-table { width: 100%; }
.task-title-cell,
.task-progress-cell,
.task-drawer,
.task-drawer-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.task-title-cell strong {
  color: #1f2d3d;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.task-title-cell span {
  color: #697386;
  font-size: 12px;
}
.task-counts {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.task-drawer { gap: 14px; }
.task-drawer-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid #e5eaf3;
  border-radius: 8px;
  background: #f8fafc;
}
.task-drawer-summary div {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.task-drawer-summary strong { color: #1f2d3d; font-size: 16px; }
.task-drawer-summary span { color: #697386; font-size: 12px; }
.task-drawer-progress {
  padding: 12px;
  border: 1px solid #e5eaf3;
  border-radius: 8px;
  background: #fff;
}
.record-product { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 10px; align-items: center; max-width: 100%; }
.record-product :deep(.erp-image-preview) { width: 56px; height: 74px; }
.drawer-hero img { width: 64px; height: 84px; object-fit: cover; border-radius: 8px; border: 1px solid #edf1f7; background: #f8fafc; }
.record-product div, .drawer-hero div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.record-product strong { overflow-wrap: anywhere; }
.record-product span,
.record-product em {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.record-text,
.price-cell,
.failure-cell strong,
.failure-cell span,
.quality-cell span,
.quality-cell em {
  color: #475467;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.45;
}
.record-text.nowrap { white-space: nowrap; }
.price-cell { display: inline-block; overflow-wrap: anywhere; }
.quality-cell { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.quality-cell em { font-style: normal; }
.failure-cell { display: flex; flex-direction: column; gap: 4px; line-height: 1.35; }
.failure-cell strong { overflow-wrap: anywhere; }
.failure-cell span { overflow-wrap: anywhere; }
.failure-cell em { color: #8a94a6; font-size: 12px; font-style: normal; overflow-wrap: anywhere; }
.row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 6px 12px;
  min-width: 0;
}
.row-actions :deep(.el-button) { margin-left: 0; }
.record-drawer { display: flex; flex-direction: column; gap: 16px; }
.drawer-hero { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 12px; align-items: center; padding: 12px; border: 1px solid #e5eaf3; border-radius: 8px; background: #f8fafc; }
.drawer-hero strong { font-size: 16px; overflow-wrap: anywhere; }
.repair-panel { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid #f0d28a; border-radius: 8px; background: #fffaf0; }
.repair-panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.repair-panel-head strong { color: #8a5a00; }
.repair-panel-head span { color: #8a94a6; font-size: 12px; }
.repair-issue-list { display: grid; gap: 8px; }
.repair-issue { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 10px; align-items: start; width: 100%; padding: 9px 10px; border: 1px solid #f2dba7; border-radius: 8px; background: #fff; color: #303133; text-align: left; cursor: pointer; }
.repair-issue:hover,
.repair-issue.active { border-color: #e6a23c; background: #fff7e6; }
.repair-issue span { overflow-wrap: anywhere; line-height: 1.4; }
.repair-issue em { grid-column: 2; color: #697386; font-size: 12px; font-style: normal; line-height: 1.4; overflow-wrap: anywhere; }
.repair-field-warning { padding: 8px; border-radius: 8px; background: #fffaf0; }
.repair-field-active { box-shadow: inset 0 0 0 2px #e6a23c; }
.drawer-actions { display: flex; justify-content: flex-end; gap: 10px; position: sticky; bottom: 0; background: #fff; padding-top: 12px; }
.technical-json-toolbar { display: flex; justify-content: flex-start; margin-bottom: 10px; }
.development-type-select { width: 92px; }
@media (max-width: 1280px) {
  .toolbar-panel {
    align-items: stretch;
    flex-direction: column;
  }
  .toolbar-filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
