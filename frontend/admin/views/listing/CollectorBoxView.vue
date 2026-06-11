<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, MagicStick, Refresh, Search } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import ProductTitleLink from "../../components/ProductTitleLink.vue";

const route = useRoute();
const router = useRouter();
const collectorWorkbenchReady = ref(false);
let collectorWorkbenchSaveTimer = 0;
const COLLECTOR_WORKBENCH_STORAGE_PREFIX = "collectorBoxWorkbenchState:";
const collectorWorkbenchId = computed(() => String(route.query.workbenchId || "").trim());
const collectorWorkbenchStorageKey = computed(() => `${COLLECTOR_WORKBENCH_STORAGE_PREFIX}${collectorWorkbenchId.value || "default"}`);

function createAiWorkbenchId() {
  return `aiwb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createListingWorkbenchId() {
  return `liwb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSelectionWorkbenchId() {
  return `selwb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createCollectorWorkbenchId() {
  return `colwb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureCollectorWorkbenchRouteId() {
  if (collectorWorkbenchId.value) return;
  router.replace({
    query: {
      ...route.query,
      workbenchId: createCollectorWorkbenchId()
    }
  }).catch(() => {});
}

function collectorTabTitle() {
  const routeSku = String(route.query.sku || "").trim();
  const detailSku = String(detail.value?.sku || "").trim();
  const keyword = String(state.filters.query || "").trim();
  if (routeSku) return `采集箱 · ${routeSku}`;
  if (detailSku) return `采集箱 · ${detailSku}`;
  if (keyword) return `采集箱 · ${keyword.slice(0, 18)}`;
  return "采集箱";
}

function syncCollectorWorkbenchTabTitle() {
  const nextTitle = collectorTabTitle();
  if (String(route.query.tabTitle || "").trim() === nextTitle) return;
  router.replace({
    query: {
      ...route.query,
      tabTitle: nextTitle
    }
  }).catch(() => {});
}

function saveCollectorWorkbenchState() {
  if (!collectorWorkbenchId.value) return;
  window.clearTimeout(collectorWorkbenchSaveTimer);
  collectorWorkbenchSaveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(collectorWorkbenchStorageKey.value, JSON.stringify({
        filters: state.filters,
        detailVisible: detailVisible.value,
        detailSku: detail.value?.sku || "",
        savedAt: new Date().toISOString()
      }));
    } catch (error) {
      console.warn("saveCollectorWorkbenchState failed", error);
    }
  }, 120);
}

function restoreCollectorWorkbenchState() {
  try {
    const raw = localStorage.getItem(collectorWorkbenchStorageKey.value)
      || localStorage.getItem("collectorBoxWorkbenchState");
    if (!raw) return null;
    const parsed = JSON.parse(raw || "{}");
    if (parsed?.filters) Object.assign(state.filters, parsed.filters);
    detailVisible.value = Boolean(parsed?.detailVisible);
    return String(parsed?.detailSku || "").trim();
  } catch {
    localStorage.removeItem(collectorWorkbenchStorageKey.value);
    return null;
  }
}

const loading = ref(false);
const detailLoading = ref(false);
const creatingSku = ref("");
const creatingTemplateSku = ref("");
const deletingSku = ref("");
const batchDeleting = ref(false);
const detailVisible = ref(false);
const detail = ref(null);
const detailDiagnostics = ref(null);
const detailDiagnosticsLoading = ref(false);
const rawPayloadPreviewLoaded = ref(false);
const rawPayloadPreviewText = ref("");
const selectionDialogVisible = ref(false);
const selectionDialogLoading = ref(false);
const selectionDialogRow = ref(null);
const selectionVariantRows = ref([]);
const selectedSelectionVariants = ref([]);
const selectionVariantTable = ref(null);

const state = reactive({
  rows: [],
  selectedRows: [],
  total: 0,
  summary: {},
  filters: {
    query: "",
    status: "all",
    page: 1,
    pageSize: 20
  }
});

const statusOptions = [
  { label: "全部", value: "all" },
  { label: "今日采集", value: "today" },
  { label: "待处理", value: "collected" },
  { label: "已编辑", value: "edited" },
  { label: "已建上架模板", value: "listing_template_created" },
  { label: "已入选品池", value: "selection_created" }
];

const detailPayload = computed(() => detail.value?.payload || {});
const rawPayload = computed(() => detail.value?.rawPayload || detail.value?.raw_payload || {});
const detailTemplateSnapshot = computed(() => detail.value?.templateSnapshot || detail.value?.template_snapshot || detail.value?.listingTemplate || detail.value?.listing_template || {});
const detailImages = computed(() => {
  const templateEditable = detailTemplateSnapshot.value.editable_payload || detailTemplateSnapshot.value.editablePayload || {};
  const editPayload = detail.value?.editPayload || detail.value?.edit_payload || {};
  const groups = [
    [
      ...normalizeImageValues(detailTemplateSnapshot.value.images),
      ...normalizeImageValues(templateEditable.images)
    ],
    normalizeImageValues(editPayload.images || editPayload.image_urls || editPayload.imageUrls),
    normalizeImageValues(detailPayload.value.images),
    normalizeImageValues(rawPayload.value.images || rawPayload.value.image_urls || rawPayload.value.imageUrls),
    [detail.value?.image_url, rawPayload.value.productImage, rawPayload.value.mainImage]
  ];
  const values = groups.find((items) => items.some((item) => imageUrlValue(item))) || [];
  return [...new Set(values.map(imageUrlValue).filter(Boolean))].slice(0, 12);
});
const detailDimensions = computed(() => {
  const dimensions = detailPayload.value.dimensions || rawPayload.value.dimensions || {};
  return {
    length: firstFilled([dimensions.length, dimensions.length_cm, rawPayload.value.length, rawPayload.value.length_cm]),
    width: firstFilled([dimensions.width, dimensions.width_cm, rawPayload.value.width, rawPayload.value.width_cm]),
    height: firstFilled([dimensions.height, dimensions.height_cm, rawPayload.value.height, rawPayload.value.height_cm]),
    weight: firstFilled([dimensions.weight, dimensions.weight_g, rawPayload.value.weight, rawPayload.value.weight_g])
  };
});
const listingPreviewFields = computed(() => [
  { label: "商品标题", value: detail.value?.title || detailPayload.value.productTitle || rawPayload.value.title },
  { label: "Ozon SKU", value: detail.value?.sku },
  { label: "产品类目", value: detail.value?.category_name || detailPayload.value.category || rawPayload.value.categoryName || rawPayload.value.category },
  { label: "来源链接", value: detail.value?.product_url || detailPayload.value.productUrl, type: "link" },
  { label: "采集日期", value: detail.value?.collect_date },
  { label: "当前状态", value: statusText(detail.value || {}) }
]);
const footerSummary = computed(() => `第 ${state.filters.page} 页`);
const selectionVariantCount = computed(() => selectedSelectionVariants.value.length || selectionVariantRows.value.length || 1);

function loadRawPayloadPreview() {
  rawPayloadPreviewText.value = JSON.stringify(rawPayload.value || detail.value?.payload || {}, null, 2);
  rawPayloadPreviewLoaded.value = true;
}

function firstFilled(values) {
  return values.find((value) => value !== null && value !== undefined && value !== "") ?? "";
}

function normalizeImageValues(value) {
  return Array.isArray(value) ? value : (value ? [value] : []);
}

function imageUrlValue(item) {
  if (item && typeof item === "object") return String(item.url || item.src || "").trim();
  return String(item || "").trim();
}

function formatNumber(value, digits = 0) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return number.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatPercent(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "-";
  return `${(number * 100).toFixed(2)}%`;
}

function formatDimension(value, unit) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "-";
  return `${formatNumber(number)} ${unit}`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const text = String(value);
  return text.length > 16 ? text.slice(0, 16) : text;
}

function skuCount(row) {
  return Number(row?.sku_count || row?.skuCount || row?.variant_count || row?.variantCount || 1);
}

const selectedSkus = computed(() => state.selectedRows.map((row) => String(row?.sku || "").trim()).filter(Boolean));

function collectorCategoryLabel(row = {}) {
  return String(
    row?.category_name
    || row?.category_hint
    || row?.editPayload?.category_name
    || row?.editPayload?.categoryName
    || row?.editPayload?.category3
    || row?.editPayload?.category
    || ""
  ).trim() || "未识别类目";
}

function productTitle(row) {
  return String(row?.title || (row?.sku ? `Ozon ${row.sku}` : "")).trim();
}

function productBuyerLink(row) {
  return row?.product_url || (row?.sku ? `https://www.ozon.ru/product/${encodeURIComponent(row.sku)}/` : "");
}

function statusText(row) {
  const map = {
    collected: "待处理",
    edited: "已编辑",
    listing_template_created: "已建上架模板",
    selection_created: "已入选品池"
  };
  return map[row?.status] || "待处理";
}

function statusType(row) {
  if (row?.status === "selection_created" || row?.status === "listing_template_created") return "success";
  if (row?.status === "edited") return "primary";
  return "warning";
}

function diagnosticsType(result = {}) {
  if (!result || detailDiagnosticsLoading.value) return "info";
  if (Number(result.summary?.blockers || 0)) return "danger";
  if (Number(result.summary?.warnings || 0)) return "warning";
  return "success";
}

function diagnosticsTitle(result = {}) {
  if (detailDiagnosticsLoading.value) return "正在体检字段映射";
  if (!result) return "尚未体检字段映射";
  if (Number(result.summary?.blockers || 0)) return "存在阻断项";
  if (Number(result.summary?.warnings || 0)) return "存在需复核项";
  return "映射基础可用";
}

function diagnosticsSummary(result = {}) {
  const summary = result?.summary || {};
  if (!result) return "打开商品详情后自动检查类目、必填属性和字典值。";
  return [
    `评分 ${Number(result.score || 0)}`,
    `必填缺 ${Number(summary.missing_required || 0)}`,
    `字典未绑定 ${Number(summary.dictionary_unresolved || 0)}`,
    `非当前类目 ${Number(summary.outside_category || 0)}`
  ].join(" / ");
}

function diagnosticIssueType(level = "") {
  if (level === "blocker") return "danger";
  if (level === "warning") return "warning";
  return "info";
}

function buildQuery(options = {}) {
  const params = new URLSearchParams();
  params.set("page", String(state.filters.page));
  params.set("pageSize", String(state.filters.pageSize));
  if (options.summaryMode) params.set("summaryMode", String(options.summaryMode));
  if (state.filters.query.trim()) params.set("query", state.filters.query.trim());
  if (state.filters.status !== "all") params.set("status", state.filters.status);
  return params;
}

async function loadRows(options = {}) {
  loading.value = true;
  try {
    const result = await apiClient.get(`/api/listing/collector-box?${buildQuery(options).toString()}`, { noCache: true });
    state.rows = result.rows || [];
    state.selectedRows = [];
    state.total = Number(result.total || 0);
    if (result.summary) state.summary = result.summary;
  } catch (error) {
    ElMessage.error(error.message || "采集箱加载失败");
  } finally {
    loading.value = false;
  }
}

function search() {
  state.filters.page = 1;
  loadRows();
}

function resetFilters() {
  state.filters.query = "";
  state.filters.status = "all";
  state.filters.page = 1;
  loadRows();
}

async function openDetail(row) {
  detailVisible.value = true;
  detail.value = null;
  detailDiagnostics.value = null;
  rawPayloadPreviewLoaded.value = false;
  rawPayloadPreviewText.value = "";
  detailLoading.value = true;
  try {
    detail.value = await apiClient.get(`/api/listing/collector-box/${encodeURIComponent(row.sku)}`, { noCache: true });
    loadDetailDiagnostics(row.sku).catch(() => {});
  } catch (error) {
    ElMessage.error(error.message || "详情加载失败");
  } finally {
    detailLoading.value = false;
  }
}

async function loadDetailDiagnostics(sku) {
  if (!sku) return;
  detailDiagnosticsLoading.value = true;
  try {
    detailDiagnostics.value = await apiClient.get(`/api/listing/collector-box/${encodeURIComponent(sku)}/diagnostics`, { noCache: true });
  } catch (error) {
    detailDiagnostics.value = {
      ok: false,
      score: 0,
      summary: { issues: 1, blockers: 1, warnings: 0 },
      issues: [{
        level: "blocker",
        title: "体检失败",
        message: error.message || "无法生成映射体检结果"
      }]
    };
  } finally {
    detailDiagnosticsLoading.value = false;
  }
}

async function ensureDetail(row) {
  if (detail.value?.sku === row?.sku) return detail.value;
  return await apiClient.get(`/api/listing/collector-box/${encodeURIComponent(row.sku)}`, { noCache: true });
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function normalizeVariantKey(row = {}, index = 0) {
  return String(row.sku || row.source_sku || row.offer_id || row.variantId || row.variant_id || row.id || index).trim();
}

function collectSelectionVariantRows(source = {}) {
  const payload = source.payload || {};
  const raw = source.rawPayload || source.raw_payload || {};
  const editPayload = source.editPayload || source.edit_payload || {};
  const candidates = [
    ...normalizeArray(source.editorVariants || source.editor_variants || editPayload.editorVariants || editPayload.editor_variants || payload.editorVariants || raw.editorVariants),
    ...normalizeArray(source.rows || editPayload.rows || payload.rows || raw.rows),
    ...normalizeArray(source.variants || source.variantRows || editPayload.variants || payload.variants || raw.variants),
    ...normalizeArray(source.offers || source.children || source.products || payload.offers || raw.offers || raw.products),
    ...normalizeArray(source.skus || payload.skus || raw.skus).map((item) => (typeof item === "string" ? { sku: item } : item))
  ];
  const byKey = new Map();
  candidates.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const key = normalizeVariantKey(item, index);
    if (!key || byKey.has(key)) return;
    const images = normalizeArray(item.images || item.image_urls || item.imageUrls);
    byKey.set(key, {
      key,
      sku: String(item.sku || item.source_sku || key).trim(),
      title: String(item.title || item.name || source.title || "").trim(),
      price: item.price || item.cardPrice || item.sell_price || source.price || "",
      image: item.coverImage || item.cover_image || item.primary_image || item.mainImage || images[0] || source.image_url || "",
      raw: item
    });
  });
  if (byKey.size) return [...byKey.values()];
  return [{
    key: String(source.sku || "main"),
    sku: String(source.sku || ""),
    title: String(source.title || ""),
    price: source.price || "",
    image: source.image_url || "",
    raw: { sku: source.sku, title: source.title }
  }];
}

async function openSelectionDialog(row) {
  if (!row?.sku) return;
  creatingSku.value = row.sku;
  try {
    const fullDetail = await ensureDetail(row);
    selectionDialogRow.value = fullDetail;
    selectionVariantRows.value = collectSelectionVariantRows(fullDetail);
    selectedSelectionVariants.value = [...selectionVariantRows.value];
    selectionDialogVisible.value = true;
    await nextTick();
    selectionVariantRows.value.forEach((item) => selectionVariantTable.value?.toggleRowSelection(item, true));
  } catch (error) {
    ElMessage.error(error.message || "选品创建预览加载失败");
  } finally {
    creatingSku.value = "";
  }
}

async function openEdit(row) {
  await createListingTemplate(row);
}

function openAiWorkbench(row, mode = "optimization") {
  if (!row?.sku) return;
  router.push({
    name: mode === "variant" ? "asset-variant-center-wizard" : "ai-optimization-workbench-v2",
    query: {
      workbenchId: createAiWorkbenchId(),
      collectorSku: String(row.sku),
      source: "collector_box",
      autoImport: "1"
    }
  });
}

function handleSelectionChange(rows) {
  state.selectedRows = rows || [];
}

function openOzon(row) {
  const url = productBuyerLink(row);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}

async function createListingTemplate(row) {
  if (!row?.sku) return;
  creatingTemplateSku.value = row.sku;
  try {
    if (row.listing_template_id) {
      router.push({ path: "/listing-automation", query: { workbenchId: createListingWorkbenchId(), templateId: row.listing_template_id, collectorSku: row.sku } });
      return;
    }
    const result = await apiClient.post(`/api/listing/collector-box/${encodeURIComponent(row.sku)}/create-listing-template`, {
      openMode: "listing_editor",
      compact: true
    });
    ElMessage.success(result?.reused ? "已载入已有上架模板" : "已生成上架编辑模板");
    const templateId = result?.template?.id;
    if (templateId) router.push({ path: "/listing-automation", query: { workbenchId: createListingWorkbenchId(), templateId, collectorSku: row.sku } });
    loadRows().catch(() => {});
  } catch (error) {
    ElMessage.error(error.message || "创建上架模板失败");
  } finally {
    creatingTemplateSku.value = "";
  }
}

async function createSelection(row) {
  if (!row?.sku) return;
  const selected = selectedSelectionVariants.value.length ? selectedSelectionVariants.value : selectionVariantRows.value;
  if (!selected.length) {
    ElMessage.warning("请至少保留一个变体");
    return;
  }
  creatingSku.value = row.sku;
  selectionDialogLoading.value = true;
  try {
    const result = await apiClient.post(`/api/listing/collector-box/${encodeURIComponent(row.sku)}/create-selection`, {
      variantCount: selected.length,
      variantSelections: selected.map((item) => ({
        key: item.key,
        sku: item.sku,
        selected: true
      }))
    });
    ElMessage.success(`已生成 ${result?.created_count || selected.length || 1} 个选品池草稿`);
    selectionDialogVisible.value = false;
    await loadRows();
    if (result?.product?.id || result?.id) {
      router.push({
        path: "/selection",
        query: {
          workbenchId: createSelectionWorkbenchId(),
          tabTitle: `选品池 · ${row.sku}`,
          productId: result.product?.id || result.id
        }
      });
    }
  } catch (error) {
    ElMessage.error(error.message || "加入选品池失败");
  } finally {
    creatingSku.value = "";
    selectionDialogLoading.value = false;
  }
}

async function deleteRow(row) {
  if (!row?.sku) return;
  await ElMessageBox.confirm(`确认删除采集商品 ${row.sku}？删除后列表不再显示。`, "删除采集商品", {
    confirmButtonText: "删除",
    cancelButtonText: "取消",
    type: "warning"
  });
  deletingSku.value = row.sku;
  try {
    await apiClient.delete(`/api/listing/collector-box/${encodeURIComponent(row.sku)}`);
    ElMessage.success("已删除采集商品");
    await loadRows();
  } catch (error) {
    ElMessage.error(error.message || "删除失败");
  } finally {
    deletingSku.value = "";
  }
}

async function batchDeleteRows() {
  const skus = selectedSkus.value;
  if (!skus.length) return;
  await ElMessageBox.confirm(`确认删除选中的 ${skus.length} 个采集商品？`, "批量删除", {
    confirmButtonText: "批量删除",
    cancelButtonText: "取消",
    type: "warning"
  });
  batchDeleting.value = true;
  try {
    await apiClient.delete("/api/listing/collector-box", {
      body: JSON.stringify({ skus })
    });
    ElMessage.success(`已删除 ${skus.length} 个采集商品`);
    await loadRows();
  } catch (error) {
    ElMessage.error(error.message || "批量删除失败");
  } finally {
    batchDeleting.value = false;
  }
}
watch(() => [state.filters.page, state.filters.pageSize], loadRows);

watch(
  [
    () => JSON.stringify(state.filters),
    () => detailVisible.value,
    () => detail.value?.sku || ""
  ],
  () => {
    if (!collectorWorkbenchReady.value) return;
    saveCollectorWorkbenchState();
  }
);

watch(
  [
    () => route.query.sku,
    () => detail.value?.sku || ""
  ],
  () => {
    if (!collectorWorkbenchReady.value || !collectorWorkbenchId.value) return;
    syncCollectorWorkbenchTabTitle();
  }
);

onMounted(() => {
  ensureCollectorWorkbenchRouteId();
  const restoredDetailSku = restoreCollectorWorkbenchState();
  if (route.query.sku) state.filters.query = String(route.query.sku);
  loadRows({ summaryMode: "skip" }).then(async () => {
    const nextSku = String(route.query.sku || restoredDetailSku || "").trim();
    if (!nextSku || !detailVisible.value) return;
    const row = state.rows.find((item) => String(item?.sku || "").trim() === nextSku);
    if (row) await openDetail(row);
    collectorWorkbenchReady.value = true;
  });
  if (!collectorWorkbenchReady.value) collectorWorkbenchReady.value = true;
  syncCollectorWorkbenchTabTitle();
});
</script>

<template>
  <div class="page-stack collector-box-page">
    <el-card shadow="never" class="page-card erp-paged-card collector-list-card">
      <div class="collector-toolbar">
        <div class="collector-filter-row">
          <el-input v-model="state.filters.query" clearable placeholder="搜索 SKU 或商品标题" class="collector-search" @keyup.enter="search" />
          <el-select v-model="state.filters.status" class="collector-status-filter" @change="search">
            <el-option v-for="option in statusOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
          <el-button type="primary" :icon="Search" :loading="loading" @click="search">搜索</el-button>
          <el-button :icon="Refresh" @click="resetFilters">重置</el-button>
        </div>
        <div class="collector-toolbar-actions">
          <el-button
            type="danger"
            plain
            :icon="Delete"
            :disabled="!selectedSkus.length"
            :loading="batchDeleting"
            @click="batchDeleteRows"
          >
            批量删除
          </el-button>
        </div>
      </div>

      <el-table
        v-loading="loading"
        :data="state.rows"
        stripe
        border
        class="erp-data-table collector-table"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" width="42" align="center" fixed="left" />
        <el-table-column label="图片" width="92" align="center" fixed="left">
          <template #default="{ row }">
            <ProductImagePreview :src="row.image_url" />
          </template>
        </el-table-column>
        <el-table-column label="商品信息" min-width="360" fixed="left">
          <template #default="{ row }">
            <div class="product-main table-title-cell">
              <ProductTitleLink :title="productTitle(row)" :href="productBuyerLink(row)" :lines="2" />
              <span>{{ collectorCategoryLabel(row) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="价格" width="130" align="center">
          <template #default="{ row }">{{ formatNumber(row.price, 2) }} {{ row.currency }}</template>
        </el-table-column>
        <el-table-column label="SKU数量" width="100" align="center">
          <template #default="{ row }">{{ skuCount(row) }}</template>
        </el-table-column>
        <el-table-column label="来源平台" width="120" align="center">
          <template #default>ozon</template>
        </el-table-column>
        <el-table-column label="销量/浏览" width="150" align="center">
          <template #default="{ row }">
            <span>{{ formatNumber(row.sold_count) }} / {{ formatNumber(row.view_count) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120" align="center">
          <template #default="{ row }">
            <el-tag :type="statusType(row)" effect="plain">{{ statusText(row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="150" align="center">
          <template #default="{ row }">{{ formatDateTime(row.created_at || row.collect_date) }}</template>
        </el-table-column>
        <el-table-column label="更新时间" width="150" align="center">
          <template #default="{ row }">{{ formatDateTime(row.updated_at || row.edited_at || row.collected_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="580" fixed="right" align="center">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button
                size="small"
                type="primary"
                plain
                :loading="creatingTemplateSku === row.sku"
                @click="openEdit(row)"
              >
                编辑商品
              </el-button>
              <el-button
                size="small"
                type="success"
                plain
                :icon="MagicStick"
                @click="openAiWorkbench(row, 'optimization')"
              >
                AI优化
              </el-button>
              <el-button
                size="small"
                type="success"
                plain
                :icon="MagicStick"
                @click="openAiWorkbench(row, 'variant')"
              >
                AI裂变
              </el-button>
              <el-button size="small" plain @click="openDetail(row)">查看详情</el-button>
              <el-button size="small" plain @click="openOzon(row)">打开 Ozon</el-button>
              <el-button
                size="small"
                type="warning"
                plain
                :loading="creatingSku === row.sku"
                :disabled="row.status === 'selection_created'"
                @click="openSelectionDialog(row)"
              >
                创建选品
              </el-button>
              <el-button
                size="small"
                type="danger"
                plain
                :loading="deletingSku === row.sku"
                @click="deleteRow(row)"
              >
                删除
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <PageFooterPagination
        v-model:page="state.filters.page"
        v-model:page-size="state.filters.pageSize"
        :total="state.total"
        :summary="footerSummary"
      />
    </el-card>

    <el-drawer v-model="detailVisible" title="商品详情" size="860px" class="collector-detail-drawer">
      <div v-loading="detailLoading" class="detail-drawer">
        <template v-if="detail">
          <section class="listing-preview-hero">
            <ProductImagePreview :src="detailImages[0] || detail.image_url" size="square" />
            <div class="listing-preview-hero__main">
              <div class="listing-preview-title">
                <h3>{{ detail.title || `Ozon ${detail.sku}` }}</h3>
                <el-tag :type="statusType(detail)" effect="plain">{{ statusText(detail) }}</el-tag>
              </div>
              <p>{{ collectorCategoryLabel(detail || {}) }}</p>
              <div class="listing-preview-actions">
                <el-button @click="openOzon(detail)">打开 Ozon</el-button>
                <el-button
                  type="primary"
                  plain
                  :loading="creatingTemplateSku === detail.sku"
                  @click="openEdit(detail)"
                >
                  编辑商品
                </el-button>
                <el-button
                  type="warning"
                  :disabled="detail.status === 'selection_created'"
                  :loading="creatingSku === detail.sku"
                  @click="openSelectionDialog(detail)"
                >
                  创建选品
                </el-button>
              </div>
            </div>
          </section>

          <section class="listing-panel">
            <div class="listing-panel__head">
              <h4>商品信息</h4>
              <span>从采集箱同步的商品基础信息，可用于创建选品或继续编辑。</span>
            </div>
            <div class="listing-field-grid">
              <div v-for="field in listingPreviewFields" :key="field.label" class="listing-field">
                <span>{{ field.label }}</span>
                <a v-if="field.type === 'link' && field.value" :href="field.value" target="_blank" rel="noopener noreferrer">{{ field.value }}</a>
                <strong v-else>{{ field.value || "-" }}</strong>
              </div>
            </div>
          </section>

          <section class="listing-panel diagnostics-panel" v-loading="detailDiagnosticsLoading">
            <div class="listing-panel__head">
              <h4>映射体检</h4>
              <el-tag :type="diagnosticsType(detailDiagnostics)" effect="plain">{{ diagnosticsTitle(detailDiagnostics) }}</el-tag>
            </div>
            <div class="diagnostics-summary">
              <strong>{{ diagnosticsSummary(detailDiagnostics) }}</strong>
              <span v-if="detailDiagnostics?.category?.description_category_id">
                Ozon 类目 {{ detailDiagnostics.category.description_category_id }}:{{ detailDiagnostics.category.type_id }}
              </span>
              <span v-else>未确认 Ozon 后台类目</span>
            </div>
            <div v-if="detailDiagnostics?.issues?.length" class="diagnostics-issues">
              <el-tag
                v-for="(issue, index) in detailDiagnostics.issues.slice(0, 8)"
                :key="`${issue.code}-${index}`"
                :type="diagnosticIssueType(issue.level)"
                effect="plain"
              >
                {{ issue.title }}：{{ issue.message }}
              </el-tag>
            </div>
          </section>

          <section class="listing-panel">
            <div class="listing-panel__head">
              <h4>销售表现</h4>
              <span>采集商品的基础销售、浏览和尺寸信息。</span>
            </div>
            <div class="metric-grid">
              <div class="metric-card">
                <span>价格</span>
                <strong>{{ formatNumber(detail.price, 2) }} {{ detail.currency || "RUB" }}</strong>
              </div>
              <div class="metric-card">
                <span>销量</span>
                <strong>{{ formatNumber(detail.sold_count) }}</strong>
              </div>
              <div class="metric-card">
                <span>浏览</span>
                <strong>{{ formatNumber(detail.view_count) }}</strong>
              </div>
              <div class="metric-card">
                <span>转化率</span>
                <strong>{{ formatPercent(detail.conversion_rate) }}</strong>
              </div>
            </div>
            <div class="listing-field-grid compact">
              <div class="listing-field">
                <span>长</span>
                <strong>{{ formatDimension(detailDimensions.length, "cm") }}</strong>
              </div>
              <div class="listing-field">
                <span>宽</span>
                <strong>{{ formatDimension(detailDimensions.width, "cm") }}</strong>
              </div>
              <div class="listing-field">
                <span>高</span>
                <strong>{{ formatDimension(detailDimensions.height, "cm") }}</strong>
              </div>
              <div class="listing-field">
                <span>重量</span>
                <strong>{{ formatDimension(detailDimensions.weight, "g") }}</strong>
              </div>
            </div>
          </section>

          <section class="listing-panel">
            <div class="listing-panel__head">
              <h4>商品图片</h4>
              <span>{{ detailImages.length ? `${detailImages.length} 张图片` : "暂无图片" }}</span>
            </div>
            <div v-if="detailImages.length" class="image-strip">
              <ProductImagePreview v-for="image in detailImages" :key="image" :src="image" size="square" />
            </div>
            <el-empty v-else description="暂无图片" :image-size="72" />
          </section>

          <el-collapse class="raw-collapse">
            <el-collapse-item title="原始数据" name="raw">
              <el-button v-if="!rawPayloadPreviewLoaded" class="erp-btn erp-btn-secondary" @click="loadRawPayloadPreview">加载原始数据</el-button>
              <pre v-else class="payload-preview">{{ rawPayloadPreviewText }}</pre>
            </el-collapse-item>
          </el-collapse>
        </template>
      </div>
    </el-drawer>

    <el-dialog
      v-model="selectionDialogVisible"
      title="选择入池变体"
      width="820px"
      class="selection-variant-dialog"
    >
      <div class="selection-dialog-summary">
        <strong>将裂变成 {{ selectionVariantCount }} 个选品草稿</strong>
        <span>默认保留全部变体，每个草稿会带入对应变体的图片、尺寸、重量、俄语标题、标签、描述和可复用属性。</span>
      </div>
      <el-table
        ref="selectionVariantTable"
        :data="selectionVariantRows"
        border
        row-key="key"
        class="selection-variant-table"
        @selection-change="selectedSelectionVariants = $event"
      >
        <el-table-column type="selection" width="48" />
        <el-table-column label="图片" width="88" align="center">
          <template #default="{ row }">
            <ProductImagePreview :src="row.image" size="square" />
          </template>
        </el-table-column>
        <el-table-column label="变体" min-width="320">
          <template #default="{ row }">
            <div class="variant-preview-cell">
              <strong>{{ row.title || row.sku || "未命名变体" }}</strong>
              <span>{{ row.sku || "-" }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="价格" width="120" align="center">
          <template #default="{ row }">{{ formatNumber(row.price, 2) }}</template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="selectionDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="selectionDialogLoading"
          :disabled="!selectedSelectionVariants.length"
          @click="createSelection(selectionDialogRow)"
        >
          生成草稿
        </el-button>
      </template>
    </el-dialog>

  </div>
</template>

<style scoped>
.collector-toolbar,
.collector-filter-row,
.collector-toolbar-actions,
.product-cell,
.listing-preview-hero,
.listing-preview-title,
.listing-preview-actions,
.row-actions {
  display: flex;
  align-items: center;
}

.collector-list-card {
  overflow: hidden;
}

.collector-toolbar {
  justify-content: space-between;
  gap: 16px;
  padding: 2px 0 14px;
}

.collector-filter-row {
  flex: 1;
  gap: 10px;
  min-width: 0;
}

.collector-toolbar-actions {
  justify-content: flex-end;
  gap: 8px;
  margin-left: auto;
}

.collector-search {
  width: min(360px, 38vw);
}

.collector-status-filter {
  width: 150px;
}

.product-cell {
  gap: 12px;
  min-width: 0;
}

.product-main {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.table-title-cell {
  padding-right: 12px;
}

.listing-preview-title h3 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.product-main strong {
  display: -webkit-box;
  overflow: hidden;
  max-width: 100%;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-height: 1.35;
}

.product-main span,
.product-main em,
.collector-table small {
  color: var(--el-text-color-secondary);
  font-style: normal;
}

.collector-table :deep(.el-table__cell) {
  padding: 8px 0;
}

.collector-table :deep(.el-table__header th) {
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-regular);
  font-weight: 600;
}

.row-actions {
  justify-content: center;
  gap: 6px;
  flex-wrap: nowrap;
  white-space: nowrap;
}

.row-actions .el-button {
  margin-left: 0;
  padding-inline: 8px;
}

.detail-drawer {
  min-height: 320px;
}

.listing-preview-hero {
  align-items: flex-start;
  gap: 18px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.listing-preview-hero__main {
  display: grid;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.listing-preview-title {
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.listing-preview-title h3 {
  margin: 0;
  font-size: 18px;
}

.listing-preview-hero p {
  margin: 0;
  color: var(--el-text-color-secondary);
}

.listing-preview-actions {
  gap: 10px;
  justify-content: flex-end;
}

.listing-panel {
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-bg-color);
}

.listing-panel__head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.listing-panel__head h4 {
  margin: 0;
  font-size: 15px;
}

.listing-panel__head span,
.listing-field span,
.metric-card span {
  color: var(--el-text-color-secondary);
}

.listing-field-grid,
.metric-grid {
  display: grid;
  gap: 10px;
}

.listing-field-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.listing-field-grid.compact,
.metric-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.listing-field,
.metric-card {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 12px;
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
}

.listing-field strong,
.listing-field a,
.metric-card strong {
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.listing-field a {
  color: var(--el-color-primary);
}

.metric-card strong {
  font-size: 18px;
}

.image-strip {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 10px;
}

.diagnostics-panel {
  border-color: var(--el-color-warning-light-5);
  background: var(--el-color-warning-light-9);
}

.diagnostics-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  color: var(--el-text-color-secondary);
}

.diagnostics-summary strong {
  color: var(--el-text-color-primary);
}

.diagnostics-issues {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.selection-dialog-summary {
  display: grid;
  gap: 6px;
  margin-bottom: 14px;
  color: var(--el-text-color-secondary);
}

.selection-dialog-summary strong {
  color: var(--el-text-color-primary);
  font-size: 15px;
}

.selection-variant-table {
  width: 100%;
}

.variant-preview-cell {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.variant-preview-cell strong,
.variant-preview-cell span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.variant-preview-cell span {
  color: var(--el-text-color-secondary);
}

.raw-collapse {
  margin-top: 16px;
}

.payload-preview {
  max-height: 320px;
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-size: 12px;
  line-height: 1.55;
}

@media (max-width: 760px) {
  .collector-toolbar,
  .collector-filter-row,
  .collector-toolbar-actions,
  .listing-preview-hero,
  .listing-panel__head {
    align-items: stretch;
    flex-direction: column;
  }

  .collector-toolbar-actions {
    margin-left: 0;
  }

  .collector-search,
  .collector-status-filter {
    width: 100%;
  }

  .listing-field-grid,
  .listing-field-grid.compact,
  .metric-grid {
    grid-template-columns: 1fr;
  }
}
</style>
