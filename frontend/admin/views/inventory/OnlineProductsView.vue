<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { loadShopDictionary } from "../../utils/shop-dictionary";
import { openAiProductMaterialOptimizerWindow, openAiVariantLabWindow } from "../../utils/ai-variant-lab-window";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import { createLatestRequestGate } from "../../utils/request-gate";
import { createRouteQuerySync } from "../../utils/route-query-sync.js";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import ProductTitleLink from "../../components/ProductTitleLink.vue";
import { ozonBuyerProductLinkFromRow } from "../../utils/product-links";

const route = useRoute();
const router = useRouter();
let syncingRoute = false;
let onlineProductSyncPollTimer = 0;
let productLimitsLoadedShopId = null;
const listRequestGate = createLatestRequestGate();
const warehouseCacheByShop = new Map();
let dictionaryLoaded = false;
let batchStockSnapshotKey = "";
let batchStockSnapshotRows = [];

const loading = ref(false);
const syncLoading = ref(false);
const stockSyncLoading = ref(false);
const openingEditId = ref(0);
const bindDialogVisible = ref(false);
const bindSubmitting = ref(false);
const stockDialogVisible = ref(false);
const stockSubmitting = ref(false);
const warehousesLoading = ref(false);
const productOptionsLoading = ref(false);
const productLimitLoading = ref(false);

function defaultStatusFilter() {
  return route.name === "batch-stock-update" ? "ready_for_sale" : "all";
}

const state = reactive({
  onlineProducts: [],
  total: 0,
  statusCounts: {},
  shops: [],
  products: [],
  people: [],
  productLimits: [],
  productLimitsFetchedAt: "",
  selectedIds: [],
  selectedRows: [],
  warehouses: [],
  filters: {
    shopId: "all",
    status: defaultStatusFilter(),
    name: "",
    offer: "",
    page: 1,
    pageSize: 20
  }
});

const bindForm = reactive({
  online_product_id: null,
  product_id: "",
  person_id: ""
});

const stockForm = reactive({
  shop_id: "",
  warehouse_id: "",
  stock: 888
});

const statusLabels = [
  ["all", "全部状态"],
  ["ready_for_sale", "准备销售"],
  ["zero_stock", "0库存待补"],
  ["selling", "销售中"],
  ["ready", "待上架"],
  ["error", "异常"],
  ["moderation", "审核中"],
  ["hidden", "已下架"],
  ["archived", "已归档"],
  ["other", "其他"]
];

const statusOptions = computed(() => statusLabels.map(([value, label]) => ({
  value,
  label,
  count: Number(state.statusCounts?.[value] || 0)
})).filter((item) => item.value === "all" || item.count > 0 || item.value === state.filters.status));

const pagedRows = computed(() => state.onlineProducts);
const stockDialogShopName = computed(() => {
  const shopId = Number(stockForm.shop_id || 0);
  return state.shops.find((shop) => Number(shop.id) === shopId)?.name || "当前店铺";
});
const stockDialogWarehouseName = computed(() => {
  const warehouseId = String(stockForm.warehouse_id || "");
  const warehouse = state.warehouses.find((item) => String(item.warehouse_id) === warehouseId);
  return warehouse ? `${warehouse.name || "Ozon 仓库"} / ${warehouse.warehouse_id}` : "未选择";
});
const stockPresetValues = [888, 500, 100, 0];
const showProductLimitPanel = computed(() => route.name === "batch-stock-update");
const productLimitSummary = computed(() => {
  const rows = Array.isArray(state.productLimits) ? state.productLimits.filter((item) => item?.ok) : [];
  if (!rows.length) return null;
  if (state.filters.shopId !== "all") {
    const row = rows.find((item) => String(item.shop_id) === String(state.filters.shopId)) || rows[0];
    return {
      label: row.shop_name || `店铺 ${row.shop_id}`,
      totalRemaining: row.limit?.total?.remaining,
      createRemaining: row.limit?.daily_create?.remaining,
      updateRemaining: row.limit?.daily_update?.remaining
    };
  }
  const sum = (selector) => rows.reduce((total, row) => {
    const value = Number(selector(row));
    return Number.isFinite(value) ? total + value : total;
  }, 0);
  return {
    label: `${rows.length}个店铺`,
    totalRemaining: sum((row) => row.limit?.total?.remaining),
    createRemaining: sum((row) => row.limit?.daily_create?.remaining),
    updateRemaining: sum((row) => row.limit?.daily_update?.remaining)
  };
});

function money(value) {
  return Number(value || 0).toFixed(2);
}

function integer(value) {
  return Math.round(Number(value || 0)).toLocaleString("zh-CN");
}

function dateText(value) {
  return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true });
}

function limitNumber(value) {
  return Number.isFinite(Number(value)) ? integer(value) : "--";
}

function limitPercent(bucket = {}) {
  const usage = Number(bucket.usage);
  const max = Number(bucket.limit);
  if (!Number.isFinite(usage) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((usage / max) * 100)));
}

function limitStatusType(bucket = {}) {
  const remaining = Number(bucket.remaining);
  const max = Number(bucket.limit);
  if (!Number.isFinite(remaining) || !Number.isFinite(max) || max <= 0) return "";
  if (remaining <= 0) return "danger";
  if (remaining / max <= 0.1) return "warning";
  return "success";
}

function limitProgressStatus(bucket = {}) {
  const type = limitStatusType(bucket);
  if (type === "danger") return "exception";
  return type;
}

function ozonBuyerProductLinkFor(row) {
  return ozonBuyerProductLinkFromRow(row);
}

function parseOnlineProductRaw(row) {
  const raw = row?.raw_json;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function realOzonSkuFromValue(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "0" || text.startsWith("__MISSING_SKU__:")) return "";
  return /^\d+$/.test(text) ? text : "";
}

function displayedOzonSku(row) {
  const raw = parseOnlineProductRaw(row);
  return (
    realOzonSkuFromValue(raw?.sku)
    || realOzonSkuFromValue(raw?.fbo_sku)
    || realOzonSkuFromValue(raw?.fbs_sku)
    || realOzonSkuFromValue(raw?.product_sku)
    || realOzonSkuFromValue(raw?.productSku)
    || realOzonSkuFromValue(raw?.ozon_sku)
    || realOzonSkuFromValue(row?.ozon_sku)
    || ""
  );
}

function onlineStatusKey(row) {
  const status = String(row.status || "").toLowerCase();
  const visibility = String(row.visibility || "").toLowerCase();
  const hasStockSnapshot = Number(row.stock_snapshot_count || 0) > 0;
  const isOzonSupplyState = status.includes("ready") || status.includes("created") || visibility.includes("empty_stock") || visibility.includes("ready_to_supply") || visibility.includes("to_supply");
  const hasRealSku = Boolean(displayedOzonSku(row));
  const fbsAvailable = Number(row.fbs_available || 0);
  const fbsPresent = Number(row.fbs_present || 0);
  if (Number(row.archived || 0) || status.includes("archive") || visibility.includes("archive")) return "archived";
  if (status.includes("error") || status.includes("fail") || visibility.includes("failed") || visibility.includes("banned")) return "error";
  if (status.includes("moder") || status.includes("edit") || status.includes("validation") || visibility.includes("pending")) return "moderation";
  if (visibility.includes("hidden") || visibility.includes("blocked") || visibility.includes("removed_from_sale") || status.includes("hidden") || status.includes("offline")) return "hidden";
  if (
    hasRealSku
    && isOzonSupplyState
    && hasStockSnapshot
    && (fbsAvailable > 0 || fbsPresent > 0)
  ) return "selling";
  if (
    hasRealSku
    && isOzonSupplyState
    && hasStockSnapshot
    && fbsAvailable <= 0
  ) return "zero_stock";
  if (
    isOzonSupplyState
    && !hasRealSku
  ) return "ready";
  if (status.includes("ready") || status.includes("created") || visibility.includes("ready_to_supply") || visibility.includes("empty_stock")) return "ready";
  if (status.includes("online") || status.includes("active") || status.includes("sell") || visibility.includes("in_sale") || visibility.includes("visible") || visibility.includes("moderated")) return "selling";
  return "other";
}

function onlineStatusType(row) {
  const key = onlineStatusKey(row);
  if (key === "zero_stock") return "warning";
  if (key === "selling") return "success";
  if (key === "ready") return "primary";
  if (key === "error") return "danger";
  if (key === "moderation") return "warning";
  if (key === "hidden" || key === "archived") return "info";
  return "";
}

function onlineStatusLabel(row) {
  return statusOptions.value.find((item) => item.value === onlineStatusKey(row))?.label || "其他";
}

function stockSyncText(row) {
  if (!Number(row.stock_snapshot_count || 0)) return "未同步";
  return dateText(row.stock_synced_at);
}

function asPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function onlineProductsQueryString() {
  const params = new URLSearchParams({
    paged: "1",
    page: String(state.filters.page),
    pageSize: String(state.filters.pageSize),
    shopId: String(state.filters.shopId || "all"),
    status: String(state.filters.status || "all")
  });
  const name = String(state.filters.name || "").trim();
  const offer = String(state.filters.offer || "").trim();
  if (name) params.set("name", name);
  if (offer) params.set("offer", offer);
  return params.toString();
}

function batchStockSnapshotQueryString() {
  const params = new URLSearchParams({ shopId: String(state.filters.shopId || "all") });
  const name = String(state.filters.name || "").trim();
  const offer = String(state.filters.offer || "").trim();
  if (name) params.set("name", name);
  if (offer) params.set("offer", offer);
  return params.toString();
}

function batchStockFilteredRows() {
  const eligibleRows = batchStockSnapshotRows.filter((row) => {
    const status = onlineStatusKey(row);
    return Boolean(displayedOzonSku(row)) && !["archived", "hidden"].includes(status);
  });
  const status = String(state.filters.status || "all");
  if (status === "all") return eligibleRows;
  if (status === "ready_for_sale") return eligibleRows.filter((row) => ["ready", "zero_stock"].includes(onlineStatusKey(row)));
  return eligibleRows.filter((row) => onlineStatusKey(row) === status);
}

function batchStockStatusCounts(rows = []) {
  const counts = { all: rows.length, ready_for_sale: 0, zero_stock: 0, selling: 0, ready: 0, error: 0, moderation: 0, hidden: 0, archived: 0, other: 0 };
  for (const row of rows) {
    const status = onlineStatusKey(row);
    counts[Object.hasOwn(counts, status) ? status : "other"] += 1;
  }
  counts.ready_for_sale = Number(counts.ready || 0) + Number(counts.zero_stock || 0);
  return counts;
}

function applyBatchStockSnapshotPage() {
  const filteredRows = batchStockFilteredRows();
  const start = (state.filters.page - 1) * state.filters.pageSize;
  state.onlineProducts = filteredRows.slice(start, start + state.filters.pageSize);
  state.total = filteredRows.length;
  state.statusCounts = batchStockStatusCounts(batchStockSnapshotRows.filter((row) => (
    Boolean(displayedOzonSku(row)) && !["archived", "hidden"].includes(onlineStatusKey(row))
  )));
  state.selectedIds = [];
  state.selectedRows = [];
}

function invalidateBatchStockSnapshot() {
  batchStockSnapshotKey = "";
  batchStockSnapshotRows = [];
}

async function loadPageData(options = {}) {
  const requestToken = listRequestGate.next();
  loading.value = true;
  try {
    const snapshotKey = batchStockSnapshotQueryString();
    const useSnapshot = showProductLimitPanel.value;
    const productsRequest = useSnapshot && !options.forceSnapshot && batchStockSnapshotKey === snapshotKey
      ? Promise.resolve(batchStockSnapshotRows)
      : apiClient.get(`/api/online-products?${useSnapshot ? snapshotKey : onlineProductsQueryString()}`);
    const requests = [productsRequest, loadShopDictionary()];
    if (!dictionaryLoaded) requests.push(apiClient.get("/api/people"));
    const [onlineProducts, shops, people] = await Promise.all(requests);
    if (!listRequestGate.isLatest(requestToken)) return;
    if (useSnapshot) {
      batchStockSnapshotRows = Array.isArray(onlineProducts) ? onlineProducts : [];
      batchStockSnapshotKey = snapshotKey;
      applyBatchStockSnapshotPage();
    } else {
      state.onlineProducts = Array.isArray(onlineProducts?.rows) ? onlineProducts.rows : [];
      state.total = Number(onlineProducts?.total || 0);
      state.statusCounts = onlineProducts?.statusCounts || {};
    }
    state.shops = Array.isArray(shops) ? shops : [];
    if (!dictionaryLoaded) {
      state.people = Array.isArray(people) ? people.filter((item) => Number(item.active) !== 0) : [];
      dictionaryLoaded = true;
    }
    if (showProductLimitPanel.value) void loadProductLimits();
  } catch (error) {
    if (!listRequestGate.isLatest(requestToken)) return;
    ElMessage.error(error.message || "在线商品加载失败");
  } finally {
    if (listRequestGate.isLatest(requestToken)) loading.value = false;
  }
}

function handleSearch() {
  state.filters.page = 1;
  syncRouteQuery("manual");
  loadPageData();
}

function handleReset() {
  state.filters.shopId = "all";
  state.filters.status = defaultStatusFilter();
  state.filters.name = "";
  state.filters.offer = "";
  state.filters.page = 1;
  syncRouteQuery("manual");
  loadPageData();
}

function handlePageChange(page) {
  state.filters.page = page;
  if (showProductLimitPanel.value && batchStockSnapshotKey) applyBatchStockSnapshotPage();
  else loadPageData();
}

function handlePageSizeChange(size) {
  state.filters.pageSize = size;
  state.filters.page = 1;
  if (showProductLimitPanel.value && batchStockSnapshotKey) applyBatchStockSnapshotPage();
  else loadPageData();
}

function setStatus(value) {
  state.filters.status = value;
  state.filters.page = 1;
  loadPageData();
}

function selectionChanged(rows) {
  state.selectedIds = rows.map((row) => Number(row.id));
  state.selectedRows = rows;
}

function selectedShopIdForStock() {
  if (state.filters.shopId !== "all") return Number(state.filters.shopId);
  const shopIds = [...new Set(state.selectedRows.map((row) => Number(row.shop_id || 0)).filter(Boolean))];
  return shopIds.length === 1 ? shopIds[0] : 0;
}

async function loadWarehousesForStock(shopId, force = false) {
  const normalizedShopId = String(shopId || "");
  if (!force && warehouseCacheByShop.has(normalizedShopId)) {
    state.warehouses = warehouseCacheByShop.get(normalizedShopId);
    stockForm.warehouse_id = state.warehouses[0]?.warehouse_id ? String(state.warehouses[0].warehouse_id) : "";
    return;
  }
  warehousesLoading.value = true;
  try {
    const result = await apiClient.get(`/api/online-products/warehouses?shop_id=${encodeURIComponent(shopId)}`);
    state.warehouses = Array.isArray(result?.warehouses) ? result.warehouses : [];
    warehouseCacheByShop.set(normalizedShopId, state.warehouses);
    stockForm.warehouse_id = state.warehouses[0]?.warehouse_id ? String(state.warehouses[0].warehouse_id) : "";
  } catch (error) {
    state.warehouses = [];
    stockForm.warehouse_id = "";
    ElMessage.error(error.message || "Ozon 仓库加载失败");
  } finally {
    warehousesLoading.value = false;
  }
}

async function loadProductLimits(force = false) {
  if (!showProductLimitPanel.value) return;
  const requestedShopId = String(state.filters.shopId || "all");
  if (!force && productLimitsLoadedShopId === requestedShopId) return;
  productLimitsLoadedShopId = requestedShopId;
  productLimitLoading.value = true;
  try {
    const params = new URLSearchParams();
    if (state.filters.shopId !== "all") params.set("shop_id", String(state.filters.shopId));
    const result = await apiClient.get(`/api/online-products/limits${params.toString() ? `?${params.toString()}` : ""}`);
    state.productLimits = Array.isArray(result?.rows) ? result.rows : [];
    state.productLimitsFetchedAt = result?.fetched_at || "";
  } catch (error) {
    productLimitsLoadedShopId = null;
    state.productLimits = [];
    state.productLimitsFetchedAt = "";
    ElMessage.error(error.message || "Ozon 店铺链接额度加载失败");
  } finally {
    productLimitLoading.value = false;
  }
}

function applyStockPreset(value) {
  stockForm.stock = value;
}

async function openBatchStockDialog() {
  if (!state.selectedIds.length) {
    ElMessage.warning("请选择需要更新库存的在线商品");
    return;
  }
  const shopId = selectedShopIdForStock();
  if (!shopId) {
    ElMessage.warning("批量改库存需要选择同一个店铺的商品");
    return;
  }
  stockForm.shop_id = String(shopId);
  stockForm.stock = 888;
  state.warehouses = [];
  stockForm.warehouse_id = "";
  stockDialogVisible.value = true;
  await loadWarehousesForStock(shopId);
}

async function submitBatchStock() {
  if (!stockForm.warehouse_id) {
    ElMessage.warning("请选择 Ozon 仓库");
    return;
  }
  const stock = Math.max(0, Math.round(Number(stockForm.stock || 0)));
  stockSubmitting.value = true;
  try {
    const result = await apiClient.post("/api/online-products/batch-stock", {
      online_product_ids: state.selectedIds,
      shop_id: Number(stockForm.shop_id),
      warehouse_id: stockForm.warehouse_id,
      stock
    });
    ElMessage.success(`已更新 ${result?.target_count || 0} 个商品库存为 ${stock}`);
    stockDialogVisible.value = false;
    invalidateBatchStockSnapshot();
    await loadPageData({ forceSnapshot: true });
  } catch (error) {
    ElMessage.error(error.message || "批量改库存失败");
  } finally {
    stockSubmitting.value = false;
  }
}

async function ensureProductOptions(row = null) {
  if (state.products.length) return;
  productOptionsLoading.value = true;
  try {
    const params = new URLSearchParams({ paged: "1", page: "1", pageSize: "100" });
    const query = row?.product_name || row?.name || row?.offer_id || "";
    if (query) params.set("query", query);
    const result = await apiClient.get(`/api/products?${params.toString()}`);
    state.products = Array.isArray(result?.rows) ? result.rows : [];
  } catch (error) {
    ElMessage.error(error.message || "加载库存商品候选失败");
  } finally {
    productOptionsLoading.value = false;
  }
}

async function openBindDialog(row) {
  bindForm.online_product_id = Number(row.id);
  bindForm.product_id = row.product_id ? String(row.product_id) : "";
  bindForm.person_id = "";
  await ensureProductOptions(row);
  bindDialogVisible.value = true;
}

function applyRouteState() {
  syncingRoute = true;
  try {
    state.filters.shopId = String(route.query.shopId || "all");
    state.filters.status = String(route.query.status || defaultStatusFilter());
    state.filters.name = String(route.query.name || "");
    state.filters.offer = String(route.query.offer || "");
    state.filters.page = asPositiveInt(route.query.page, 1);
    state.filters.pageSize = asPositiveInt(route.query.pageSize, 20);
  } finally {
    syncingRoute = false;
  }
}

const syncRouteQuery = createRouteQuerySync({
  route,
  router,
  isSyncingRoute: () => syncingRoute,
  buildQuery(mode) {
    const includeTextFilters = mode === "manual";
    return {
      shopId: state.filters.shopId !== "all" ? state.filters.shopId : undefined,
      status: state.filters.status !== "all" ? state.filters.status : undefined,
      name: includeTextFilters ? state.filters.name || undefined : undefined,
      offer: includeTextFilters ? state.filters.offer || undefined : undefined,
      page: state.filters.page > 1 ? String(state.filters.page) : undefined,
      pageSize: state.filters.pageSize !== 20 ? String(state.filters.pageSize) : undefined
    };
  }
});

async function submitBind() {
  if (!bindForm.online_product_id || !bindForm.product_id) {
    ElMessage.warning("请选择要绑定的库存商品");
    return;
  }
  bindSubmitting.value = true;
  try {
    await apiClient.post("/api/online-products/bind", {
      online_product_id: bindForm.online_product_id,
      product_id: Number(bindForm.product_id),
      person_id: bindForm.person_id ? Number(bindForm.person_id) : null
    });
    ElMessage.success("在线商品已绑定库存");
    bindDialogVisible.value = false;
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "绑定库存失败");
  } finally {
    bindSubmitting.value = false;
  }
}

async function createProductFromOnline(row) {
  try {
    await apiClient.post("/api/online-products/create-product", {
      online_product_id: row.id,
      person_id: state.people[0]?.id || null
    });
    ElMessage.success("已根据在线商品创建库存产品");
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "创建库存产品失败");
  }
}

function openOnlineProductAiWorkbench(row, mode = "optimization") {
  if (!row?.id) return;
  if (mode === "variant") {
    openAiVariantLabWindow({
      tabTitle: `AI裂变 · ${row.offer_id || row.name || row.id}`,
      onlineProductId: String(row.id),
      source: "online_product",
      autoImport: "1",
      importAt: String(Date.now())
    });
    return;
  }
  openAiProductMaterialOptimizerWindow({
    tabTitle: `AI优化 · ${row.offer_id || row.name || row.id}`,
    onlineProductId: String(row.id),
    source: "online_product",
    autoImport: "1",
    importAt: String(Date.now())
  });
}

async function archiveOnlineProduct(row) {
  try {
    await ElMessageBox.confirm(`确认归档在线商品「${row.name || row.ozon_sku}」吗？`, "归档确认", {
      type: "warning",
      confirmButtonText: "确认归档",
      cancelButtonText: "取消"
    });
    await apiClient.post("/api/online-products/action", {
      online_product_id: row.id,
      action: "archive"
    });
    ElMessage.success("在线商品已归档");
    await loadPageData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "归档在线商品失败");
  }
}

async function syncOnlineProducts(mode = "pending_listing") {
  syncLoading.value = true;
  try {
    const pendingListing = mode === "pending_listing";
    const payload = pendingListing ? { pending_listing: true, scope: "pending_listing", concurrency: 5 } : {};
    if (state.filters.shopId !== "all") payload.shop_id = Number(state.filters.shopId);
    const result = await apiClient.post("/api/sync/online-products", payload);
    if (result?.started === false && result?.running) {
      ElMessage.warning("商品拉取任务已在后台运行，请等待当前任务完成");
      startOnlineProductSyncPolling();
      return;
    }
    ElMessage.success(pendingListing ? "已开始后台拉取待上架商品" : "已开始后台拉取商品");
    startOnlineProductSyncPolling();
  } catch (error) {
    ElMessage.error(error.message || "拉取 Ozon 商品失败");
    stopOnlineProductSyncPolling();
  }
}

async function syncOzonStocks() {
  stockSyncLoading.value = true;
  try {
    const payload = state.filters.shopId !== "all" ? { shop_id: Number(state.filters.shopId) } : {};
    const result = await apiClient.post("/api/sync/ozon-stocks", payload);
    const fetched = Number(result?.fetched || 0);
    const upserted = Number(result?.upserted || 0);
    if (result?.errors?.length) {
      ElMessage.warning(`库存同步完成，更新 ${upserted} 条，部分店铺有错误`);
    } else {
      ElMessage.success(`库存同步完成，拉取 ${fetched} 条，更新 ${upserted} 条`);
    }
    invalidateBatchStockSnapshot();
    await loadPageData({ forceSnapshot: true });
  } catch (error) {
    ElMessage.error(error.message || "同步 Ozon 库存失败");
  } finally {
    stockSyncLoading.value = false;
  }
}

function stopOnlineProductSyncPolling() {
  if (!onlineProductSyncPollTimer) return;
  window.clearInterval(onlineProductSyncPollTimer);
  onlineProductSyncPollTimer = 0;
}

async function pollOnlineProductSyncStatus() {
  try {
    const result = await apiClient.get("/api/sync/online-products/status", { routeScoped: false });
    if (result?.running) {
      syncLoading.value = true;
      return;
    }
    stopOnlineProductSyncPolling();
    syncLoading.value = false;
    if (result?.error) {
      ElMessage.error(result.error || "拉取 Ozon 商品失败");
      return;
    }
    const taskName = result?.scope === "pending_listing" ? "待上架商品拉取" : "Ozon 商品拉取";
    const syncResult = result?.result || {};
    const selectedShopId = Number(result?.payload?.shop_id || 0);
    const selectedShop = (syncResult.shops || []).find((shop) => Number(shop.shop_id) === selectedShopId);
    const detail = selectedShop
      ? `，Ozon 返回 ${Number(selectedShop.candidates || selectedShop.fetched || 0)} 条，过滤已有库存 ${Number(selectedShop.filtered_out || 0)} 条`
      : "";
    if (syncResult.errors?.length) {
      ElMessage.warning(`${taskName}部分失败：${syncResult.errors.join("；")}`);
    } else {
      ElMessage.success(`${taskName}完成，更新 ${Number(syncResult.upserted || 0)} 条${detail}`);
    }
    invalidateBatchStockSnapshot();
    await loadPageData({ forceSnapshot: true });
  } catch (error) {
    stopOnlineProductSyncPolling();
    syncLoading.value = false;
    ElMessage.error(error.message || "获取商品拉取状态失败");
  }
}

function startOnlineProductSyncPolling() {
  stopOnlineProductSyncPolling();
  syncLoading.value = true;
  void pollOnlineProductSyncStatus();
  onlineProductSyncPollTimer = window.setInterval(() => {
    void pollOnlineProductSyncStatus();
  }, 2500);
}

watch(() => route.query, applyRouteState, { deep: true });
watch(() => route.name, () => {
  applyRouteState();
  state.filters.page = 1;
  void loadPageData();
});
watch(
  () => [state.filters.shopId, state.filters.status, state.filters.page, state.filters.pageSize],
  syncRouteQuery
);

onMounted(async () => {
  applyRouteState();
  await loadPageData();
  try {
    const status = await apiClient.get("/api/sync/online-products/status", { routeScoped: false });
    if (status?.running) startOnlineProductSyncPolling();
  } catch {}
  const openAction = String(route.query.action || "");
  const onlineProductId = Number(route.query.onlineProductId || 0);
  if (openAction === "bind" && onlineProductId) {
    const row = state.onlineProducts.find((item) => Number(item.id) === onlineProductId);
    if (row) await openBindDialog(row);
  }
});

onBeforeUnmount(() => {
  stopOnlineProductSyncPolling();
});

onActivated(async () => {
  try {
    const status = await apiClient.get("/api/sync/online-products/status", { routeScoped: false });
    if (status?.running) startOnlineProductSyncPolling();
  } catch {}
});

onDeactivated(stopOnlineProductSyncPolling);
</script>

<template>
  <div class="page-stack online-products-page erp-paged-page">
    <el-card shadow="never" class="page-card online-products-card erp-paged-card">
      <div class="online-toolbar online-toolbar-sticky">
        <div class="online-toolbar-main">
          <el-form inline>
            <el-form-item label="店铺">
              <el-select v-model="state.filters.shopId" style="width: 180px">
                <el-option label="全部店铺" value="all" />
                <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
              </el-select>
            </el-form-item>
            <el-form-item label="商品名称">
              <el-input v-model="state.filters.name" placeholder="商品名称" clearable style="width: 220px" @keyup.enter="handleSearch" />
            </el-form-item>
            <el-form-item label="货号 / Ozon SKU">
              <el-input v-model="state.filters.offer" placeholder="货号 / Ozon SKU" clearable style="width: 220px" @keyup.enter="handleSearch" />
            </el-form-item>
            <el-form-item>
              <el-button class="erp-btn erp-btn-primary" type="primary" @click="handleSearch">查询</el-button>
              <el-button class="erp-btn erp-btn-secondary" @click="handleReset">重置</el-button>
            </el-form-item>
            <el-form-item>
              <el-button class="erp-btn erp-btn-primary" type="primary" :loading="syncLoading" @click="syncOnlineProducts('pending_listing')">
                拉取待上架商品
              </el-button>
              <el-button class="erp-btn erp-btn-secondary" :loading="stockSyncLoading" @click="syncOzonStocks">
                刷新库存数量
              </el-button>
              <el-button class="erp-btn erp-btn-secondary" :disabled="!state.selectedIds.length" @click="openBatchStockDialog">
                批量改库存
              </el-button>
            </el-form-item>
          </el-form>

          <el-popover v-if="showProductLimitPanel" placement="bottom-end" trigger="click" width="760">
            <template #reference>
              <el-button class="shop-limit-trigger" :loading="productLimitLoading">
                <span>链接空间</span>
                <strong v-if="productLimitSummary">总剩余 {{ limitNumber(productLimitSummary.totalRemaining) }}</strong>
                <small v-if="productLimitSummary">创建剩余 {{ limitNumber(productLimitSummary.createRemaining) }}</small>
              </el-button>
            </template>
            <div class="shop-limit-popover">
              <div class="shop-limit-panel-head">
                <strong>店铺链接空间</strong>
                <span class="muted-text">来自 Ozon 商品额度接口</span>
                <span v-if="state.productLimitsFetchedAt" class="muted-text">更新 {{ dateText(state.productLimitsFetchedAt) }}</span>
                <el-button link type="primary" :loading="productLimitLoading" @click="loadProductLimits(true)">刷新</el-button>
              </div>
              <el-table v-if="state.productLimits.length" :data="state.productLimits" size="small" border class="shop-limit-table" max-height="300">
                <el-table-column label="店铺" min-width="160" fixed="left">
                  <template #default="{ row }">
                    <div class="cell-stack">
                      <strong>{{ row.shop_name || `店铺 ${row.shop_id}` }}</strong>
                      <el-tag v-if="!row.ok" type="danger" effect="light">额度获取失败</el-tag>
                      <el-tag v-else :type="limitStatusType(row.limit?.total)" effect="light">总剩余 {{ limitNumber(row.limit?.total?.remaining) }}</el-tag>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column label="总链接空间" min-width="200">
                  <template #default="{ row }">
                    <div v-if="row.ok" class="shop-limit-metric">
                      <div><span>剩余</span><strong>{{ limitNumber(row.limit?.total?.remaining) }}</strong><span>/ 上限 {{ limitNumber(row.limit?.total?.limit) }}</span></div>
                      <el-progress :percentage="limitPercent(row.limit?.total)" :status="limitProgressStatus(row.limit?.total)" :stroke-width="8" :show-text="false" />
                      <small>已用 {{ limitNumber(row.limit?.total?.usage) }}</small>
                    </div>
                    <span v-else class="muted-text">{{ row.error || "Ozon 未返回额度" }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="今日创建" min-width="170">
                  <template #default="{ row }">
                    <div v-if="row.ok" class="shop-limit-metric shop-limit-metric-compact">
                      <div><span>剩余</span><strong>{{ limitNumber(row.limit?.daily_create?.remaining) }}</strong><span>/ 上限 {{ limitNumber(row.limit?.daily_create?.limit) }}</span></div>
                      <small>已用 {{ limitNumber(row.limit?.daily_create?.usage) }}</small>
                    </div>
                    <span v-else class="muted-text">--</span>
                  </template>
                </el-table-column>
                <el-table-column label="今日更新" min-width="170">
                  <template #default="{ row }">
                    <div v-if="row.ok" class="shop-limit-metric shop-limit-metric-compact">
                      <div><span>剩余</span><strong>{{ limitNumber(row.limit?.daily_update?.remaining) }}</strong><span>/ 上限 {{ limitNumber(row.limit?.daily_update?.limit) }}</span></div>
                      <small>已用 {{ limitNumber(row.limit?.daily_update?.usage) }}</small>
                    </div>
                    <span v-else class="muted-text">--</span>
                  </template>
                </el-table-column>
              </el-table>
              <el-empty v-else description="暂无店铺链接额度" :image-size="56" />
            </div>
          </el-popover>
        </div>

        <div class="status-tabs">
          <el-tag
            v-for="item in statusOptions"
            :key="item.value"
            :type="state.filters.status === item.value ? 'primary' : 'info'"
            effect="light"
            class="status-tab-tag"
            @click="setStatus(item.value)"
          >
            {{ item.label }} {{ item.count }}
          </el-tag>
        </div>
      </div>

      <div class="online-table-wrap erp-table-scroll">
        <el-table v-loading="loading" :data="pagedRows" stripe border class="erp-data-table" @selection-change="selectionChanged">
          <el-table-column type="selection" width="48" fixed="left" />
          <el-table-column label="店铺 / 状态" min-width="160" fixed="left">
            <template #default="{ row }">
              <div class="cell-stack">
                <strong>{{ row.shop_name || "-" }}</strong>
                <el-tag :type="onlineStatusType(row)">{{ onlineStatusLabel(row) }}</el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="Ozon SKU / Offer ID" min-width="220">
            <template #default="{ row }">
              <div class="cell-stack">
                <strong>{{ displayedOzonSku(row) || "未返回 SKU" }}</strong>
                <span class="muted-text">Offer ID: {{ row.offer_id || "-" }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="商品信息" min-width="320">
            <template #default="{ row }">
              <div class="product-cell">
                <ProductImagePreview :src="row.primary_image || row.image_url" />
                <div class="cell-stack">
                  <ProductTitleLink :title="row.name || row.ozon_sku || '-'" :href="ozonBuyerProductLinkFor(row)" :lines="2" />
                  <span class="muted-text">Ozon SKU: {{ displayedOzonSku(row) || "未返回 SKU" }}</span>
                  <span class="muted-text">在线商品 ID: {{ row.id }}</span>
                  <span class="muted-text">
                    Ozon Product ID:
                    <a
                      v-if="ozonBuyerProductLinkFor(row)"
                      :href="ozonBuyerProductLinkFor(row)"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="muted-text"
                      @click.stop
                    >
                      {{ row.ozon_product_id || "-" }}
                    </a>
                    <template v-else>{{ row.ozon_product_id || "-" }}</template>
                  </span>
                  <span class="muted-text">Offer ID: {{ row.offer_id || "-" }}</span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="售价" width="120" align="right">
            <template #default="{ row }">{{ money(row.sale_price) }}</template>
          </el-table-column>
          <el-table-column label="FBS库存" width="150" align="center">
            <template #default="{ row }">
              <div class="stock-cell">
                <strong :class="{ 'is-zero-stock': Number(row.fbs_available || 0) <= 0 && Number(row.stock_snapshot_count || 0) > 0 }">
                  {{ Number(row.stock_snapshot_count || 0) ? integer(row.fbs_available) : "--" }}
                </strong>
                <span>现货 {{ Number(row.stock_snapshot_count || 0) ? integer(row.fbs_present) : "--" }}</span>
                <small>{{ stockSyncText(row) }}</small>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="绑定库存" min-width="220">
            <template #default="{ row }">
              <div v-if="row.product_id" class="cell-stack">
                <strong>{{ row.product_name || "-" }}</strong>
                <span class="muted-text">{{ row.product_code || "-" }}</span>
              </div>
              <span v-else class="muted-text">未绑定库存产品</span>
            </template>
          </el-table-column>
          <el-table-column label="上架时间" min-width="160">
            <template #default="{ row }">{{ dateText(row.published_at || row.ozon_updated_at || row.synced_at || row.updated_at) }}</template>
          </el-table-column>
          <el-table-column label="最后同步时间" min-width="160">
            <template #default="{ row }">{{ dateText(row.synced_at || row.updated_at) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="470" fixed="right">
            <template #default="{ row }">
              <div class="erp-inline-actions">
                <el-button class="erp-btn-link" link type="primary" :loading="openingEditId === Number(row.id)" @click="openOnlineProductEditor(row)">编辑上架</el-button>
                <el-button class="erp-btn-link" link type="primary" @click="openOnlineProductAiWorkbench(row, 'optimization')">AI优化</el-button>
                <el-button class="erp-btn-link" link type="primary" @click="openOnlineProductAiWorkbench(row, 'variant')">AI裂变</el-button>
                <el-button class="erp-btn-link" link type="primary" @click="openBindDialog(row)">去绑定</el-button>
                <el-button class="erp-btn-link" link @click="createProductFromOnline(row)">创建库存</el-button>
                <el-button class="erp-btn-link erp-btn-link-danger" link type="danger" @click="archiveOnlineProduct(row)">归档商品</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <PageFooterPagination
        class="online-footer"
        :total="state.total"
        :page="state.filters.page"
        :page-size="state.filters.pageSize"
        @update:page="handlePageChange"
        @update:pageSize="handlePageSizeChange"
      />
    </el-card>

    <el-dialog v-model="bindDialogVisible" title="绑定 SKU 到库存产品" width="680px" align-center class="erp-centered-dialog" destroy-on-close>
      <el-form label-width="110px">
        <el-form-item label="库存商品">
          <el-select v-model="bindForm.product_id" filterable :loading="productOptionsLoading" placeholder="选择库存商品" style="width: 100%">
            <el-option
              v-for="product in state.products"
              :key="product.id"
              :label="`${product.name} / ${product.inventory_id || product.code || product.id}`"
              :value="String(product.id)"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="负责人">
          <el-select v-model="bindForm.person_id" filterable clearable placeholder="选择负责人" style="width: 100%">
            <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="String(person.id)" />
          </el-select>
        </el-form-item>
      </el-form>

      <template #footer>
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="bindDialogVisible = false">取消</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="bindSubmitting" @click="submitBind">确认绑定</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="stockDialogVisible" title="批量更新 Ozon 库存" width="760px" align-center class="stock-dialog erp-centered-dialog" destroy-on-close>
      <div class="stock-dialog-body">
        <div class="stock-summary-strip">
          <div class="stock-summary-item">
            <span class="stock-summary-label">店铺</span>
            <strong>{{ stockDialogShopName }}</strong>
          </div>
          <div class="stock-summary-item">
            <span class="stock-summary-label">已选商品</span>
            <strong>{{ state.selectedIds.length }}</strong>
          </div>
          <div class="stock-summary-item">
            <span class="stock-summary-label">目标库存</span>
            <strong>{{ Number(stockForm.stock || 0) }}</strong>
          </div>
        </div>

        <div class="stock-form-grid">
          <section class="stock-field-panel stock-field-panel-wide">
            <div class="stock-field-head">
              <div>
                <div class="stock-field-title">Ozon 仓库</div>
                <div class="stock-field-subtitle">{{ stockDialogWarehouseName }}</div>
              </div>
              <el-button class="erp-btn erp-btn-secondary" :loading="warehousesLoading" @click="loadWarehousesForStock(stockForm.shop_id, true)">
                刷新仓库
              </el-button>
            </div>
            <el-select
              v-model="stockForm.warehouse_id"
              filterable
              :loading="warehousesLoading"
              placeholder="选择要写入库存的 Ozon 仓库"
              class="stock-warehouse-select"
            >
              <el-option
                v-for="warehouse in state.warehouses"
                :key="warehouse.warehouse_id"
                :label="`${warehouse.name || 'Ozon 仓库'} / ${warehouse.warehouse_id}`"
                :value="String(warehouse.warehouse_id)"
              >
                <div class="warehouse-option">
                  <strong>{{ warehouse.name || "Ozon 仓库" }}</strong>
                  <span>{{ warehouse.warehouse_id }}</span>
                </div>
              </el-option>
            </el-select>
          </section>

          <section class="stock-field-panel">
            <div class="stock-field-title">上架数量</div>
            <el-input-number v-model="stockForm.stock" :min="0" :step="1" :precision="0" controls-position="right" class="stock-quantity-input" />
            <div class="stock-presets">
              <el-button
                v-for="value in stockPresetValues"
                :key="value"
                size="small"
                :type="Number(stockForm.stock) === value ? 'primary' : ''"
                @click="applyStockPreset(value)"
              >
                {{ value }}
              </el-button>
            </div>
          </section>

          <section class="stock-field-panel stock-field-confirm">
            <div class="stock-field-title">提交内容</div>
            <div class="stock-confirm-line">
              <span>仓库</span>
              <strong>{{ stockDialogWarehouseName }}</strong>
            </div>
            <div class="stock-confirm-line">
              <span>数量</span>
              <strong>{{ Number(stockForm.stock || 0) }}</strong>
            </div>
          </section>
        </div>
      </div>

      <template #footer>
        <div class="erp-dialog-footer stock-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="stockDialogVisible = false">取消</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="stockSubmitting" :disabled="warehousesLoading || !stockForm.warehouse_id" @click="submitBatchStock">
            确认更新 {{ state.selectedIds.length }} 个商品
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.online-products-page { min-height: 0; }
.online-products-card :deep(.el-card__body) { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.online-toolbar { display: grid; gap: 12px; padding: 8px 0 14px; }
.online-toolbar-sticky { position: sticky; top: 0; z-index: 3; background: var(--erp-surface); }
.online-toolbar-main { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.online-toolbar-main :deep(.el-form) { flex: 1; min-width: 0; }
.status-tabs { display: flex; flex-wrap: wrap; gap: 8px; }
.status-tab-tag { cursor: pointer; user-select: none; }
.shop-limit-trigger {
  min-width: 220px;
  height: 32px;
  display: inline-flex;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
}
.shop-limit-trigger strong { color: var(--el-color-success); font-size: 12px; }
.shop-limit-trigger small { color: var(--erp-text-secondary); font-size: 12px; }
.shop-limit-popover { display: grid; gap: 10px; }
.shop-limit-panel-head { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.shop-limit-table { width: 100%; }
.shop-limit-metric { display: grid; gap: 6px; min-width: 0; }
.shop-limit-metric div { display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px; color: var(--erp-text-secondary); font-size: 12px; }
.shop-limit-metric strong { color: var(--erp-text-primary); font-size: 16px; line-height: 1.2; }
.shop-limit-metric small { color: var(--erp-text-secondary); font-size: 12px; }
.shop-limit-metric-compact { gap: 3px; }
.online-table-wrap { flex: 1; min-height: 0; overflow: auto; }
.online-footer { margin-top: auto; }
.cell-stack { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.muted-text { color: var(--erp-text-secondary); font-size: 12px; line-height: 1.5; }
.product-cell { display: flex; align-items: flex-start; gap: 12px; }
.product-thumb { width: 64px; height: 84px; border-radius: 8px; border: 1px solid var(--erp-border); background: #fff; flex-shrink: 0; overflow: hidden; }
.stock-cell { display: grid; gap: 2px; justify-items: center; line-height: 1.35; }
.stock-cell strong { color: var(--erp-text-primary); font-size: 16px; }
.stock-cell strong.is-zero-stock { color: var(--el-color-danger); }
.stock-cell span,
.stock-cell small { color: var(--erp-text-secondary); font-size: 12px; }
.stock-dialog :deep(.el-dialog__body) { padding: 0 24px 8px; }
.stock-dialog-body { display: grid; gap: 16px; min-height: 260px; }
.stock-summary-strip {
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--erp-border);
  border-radius: 8px;
  background: var(--erp-bg);
}
.stock-summary-item { display: grid; gap: 4px; min-width: 0; }
.stock-summary-item strong { color: var(--erp-text-primary); font-size: 18px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stock-summary-label { color: var(--erp-text-secondary); font-size: 12px; }
.stock-form-grid { display: grid; grid-template-columns: minmax(240px, 0.8fr) minmax(0, 1.4fr); gap: 14px; }
.stock-field-panel {
  display: grid;
  gap: 12px;
  align-content: start;
  padding: 16px;
  border: 1px solid var(--erp-border);
  border-radius: 8px;
  background: var(--erp-surface);
}
.stock-field-panel-wide { grid-column: 1 / -1; }
.stock-field-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.stock-field-title { color: var(--erp-text-primary); font-weight: 700; line-height: 1.3; }
.stock-field-subtitle { margin-top: 4px; color: var(--erp-text-secondary); font-size: 12px; line-height: 1.4; }
.stock-warehouse-select { width: 100%; }
.stock-warehouse-select :deep(.el-select__wrapper) { min-height: 44px; }
.warehouse-option { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-width: 0; }
.warehouse-option strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.warehouse-option span { color: var(--erp-text-secondary); font-size: 12px; flex-shrink: 0; }
.stock-quantity-input { width: 100%; }
.stock-quantity-input :deep(.el-input-number__decrease),
.stock-quantity-input :deep(.el-input-number__increase) { width: 40px; }
.stock-quantity-input :deep(.el-input__wrapper) { min-height: 48px; }
.stock-quantity-input :deep(.el-input__inner) { font-size: 18px; font-weight: 700; }
.stock-presets { display: flex; flex-wrap: wrap; gap: 8px; }
.stock-presets :deep(.el-button) { margin-left: 0; }
.stock-confirm-line { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 16px; color: var(--erp-text-secondary); }
.stock-confirm-line strong { color: var(--erp-text-primary); overflow-wrap: anywhere; }
.stock-dialog-footer { padding-top: 8px; }
@media (max-width: 820px) {
  .stock-summary-strip,
  .stock-form-grid { grid-template-columns: 1fr; }
}
</style>

