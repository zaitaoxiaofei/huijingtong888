<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Plus, Refresh, Search } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";

const MODE_ITEMS = [
  { key: "official", label: "Ozon 官方活动" },
  { key: "seller", label: "卖家自建促销" }
];

const SELLER_STATUS_OPTIONS = [
  { label: "全部状态", value: "" },
  { label: "进行中", value: "ACTIVE" },
  { label: "已计划", value: "PLANNED" },
  { label: "已暂停", value: "PAUSED" },
  { label: "已结束", value: "ENDED" }
];

const PRODUCT_PAGE_SIZE = 100;
const AUTO_CLEANUP_ACTION_IDS = [3684628, 3702380];
const AUTO_CLEANUP_INTERVAL_MINUTES = 30;

const SELLER_STATUS_META = {
  ACTIVE: { label: "进行中", type: "success" },
  PLANNED: { label: "已计划", type: "primary" },
  PAUSED: { label: "已暂停", type: "warning" },
  ENDED: { label: "已结束", type: "info" },
  ARCHIVED: { label: "已归档", type: "info" }
};

const ACTION_TYPE_ZH = {
  DISCOUNT: "折扣",
  VOUCHER_DISCOUNT: "促销码折扣",
  DISCOUNT_WITH_CONDITION: "满额折扣",
  INSTALLMENT: "免息分期",
  INDIVIDUAL_DISCOUNT_BY_PRODUCTS: "卖家积分",
  OZON_ACCOUNT_DISCOUNT: "Ozon 银行卡折扣",
  MULTI_LEVEL_DISCOUNT_ON_AMOUNT: "多级满额折扣",
  STOCK_DISCOUNT: "库存折扣",
  PROMO: "促销",
  MEGA_PROMO: "大促",
  DISCOUNT_TYPE_PERCENT: "百分比折扣",
  DISCOUNT_TYPE_AMOUNT: "金额折扣"
};

const TITLE_REPLACEMENTS = [
  ["Распродажа", "大促"],
  ["распродажа", "大促"],
  ["Акция", "活动"],
  ["акция", "活动"],
  ["Скидка", "折扣"],
  ["скидка", "折扣"],
  ["Скидки", "折扣"],
  ["скидки", "折扣"],
  ["Выгода", "优惠"],
  ["выгода", "优惠"],
  ["Супер", "超级"],
  ["супер", "超级"],
  ["Товары", "商品"],
  ["товары", "商品"],
  ["Неделя", "周"],
  ["неделя", "周"],
  ["Весна", "春季"],
  ["Лето", "夏季"],
  ["Осень", "秋季"],
  ["Зима", "冬季"],
  ["Черная пятница", "黑色星期五"],
  ["11.11", "双十一"],
  ["New Year", "新年"],
  ["Новый год", "新年"]
];

const state = reactive({
  shops: [],
  storeId: "",
  mode: "official",
  sellerStatus: "",
  search: "",
  syncPercent: 50,
  actions: [],
  selectedActionId: "",
  productsModalOpen: false,
  productScope: "candidates",
  selectedRowKeys: [],
  editValues: {},
  productPagers: {
    candidates: createEmptyProductPager(),
    joined: createEmptyProductPager()
  },
  cleanupConfig: createEmptyCleanupConfig(),
  actionsLoading: false,
  productsLoading: false,
  submitting: false,
  submittingProductKey: "",
  cleanupLoading: false,
  cleanupSaving: false
});

const selectedAction = computed(() => state.actions.find((row) => String(getActionId(row)) === String(state.selectedActionId)) || null);
const currentPager = computed(() => state.productScope === "joined" ? state.productPagers.joined : state.productPagers.candidates);
const visibleProducts = computed(() => getPagerRows(currentPager.value));
const candidateTotal = computed(() => getPagerDisplayTotal(state.productPagers.candidates, getKnownProductsTotal(selectedAction.value, "candidates")));
const joinedTotal = computed(() => getPagerDisplayTotal(state.productPagers.joined, getKnownProductsTotal(selectedAction.value, "joined")));

function createEmptyProductPager() {
  return {
    current: 1,
    pageSize: PRODUCT_PAGE_SIZE,
    pages: {},
    cursors: { 1: null },
    pageHasNext: {}
  };
}

function createEmptyCleanupConfig(storeId = "") {
  return {
    storeId: String(storeId || ""),
    storeName: "",
    enabled: false,
    actionIds: AUTO_CLEANUP_ACTION_IDS.slice(),
    intervalMinutes: AUTO_CLEANUP_INTERVAL_MINUTES,
    lastRunAt: "",
    lastError: "",
    lastResult: null,
    taskEnabled: false,
    taskRunning: false
  };
}

function normalizeCleanupConfig(payload, storeId = "") {
  const base = createEmptyCleanupConfig(storeId);
  const raw = payload && typeof payload === "object" ? payload : {};
  const actionIds = Array.isArray(raw.actionIds)
    ? raw.actionIds.map(Number).filter((item) => Number.isFinite(item) && item > 0)
    : [];
  return {
    ...base,
    storeId: String(raw.storeId || base.storeId || ""),
    storeName: String(raw.storeName || ""),
    enabled: raw.enabled === true,
    actionIds: actionIds.length ? actionIds : base.actionIds,
    intervalMinutes: Number(raw.intervalMinutes) > 0 ? Number(raw.intervalMinutes) : base.intervalMinutes,
    lastRunAt: String(raw.lastRunAt || ""),
    lastError: String(raw.lastError || ""),
    lastResult: raw.lastResult && typeof raw.lastResult === "object" ? raw.lastResult : null,
    taskEnabled: raw.taskEnabled === true,
    taskRunning: raw.taskRunning === true
  };
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (num) => (num < 10 ? `0${num}` : String(num));
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function numberText(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "-";
  return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function getActionId(row) {
  return state.mode === "seller" ? row?.action_id : row?.id;
}

function getRawActionTitle(row) {
  if (state.mode === "seller") return row?.title || row?.name || row?.action_parameters?.title || row?.action_parameters?.name || `活动 ${row?.action_id || "-"}`;
  return row?.title || row?.name || `活动 ${row?.id || "-"}`;
}

function localizeActionTitle(row) {
  const raw = String(getRawActionTitle(row) || "").trim();
  if (!raw) return "-";
  let translated = raw;
  for (const [from, to] of TITLE_REPLACEMENTS) translated = translated.split(from).join(to);
  return translated;
}

function getActionType(row) {
  const raw = state.mode === "seller" ? row?.action_type || row?.action_parameters?.action_type || row?.type : row?.action_type || row?.discount_type;
  const key = String(raw || "").trim();
  return ACTION_TYPE_ZH[key] || key || "-";
}

function getSellerActionStatus(row) {
  return String(row?.status || row?.action_parameters?.status || "").trim().toUpperCase();
}

function statusMeta(row) {
  const status = getSellerActionStatus(row);
  return SELLER_STATUS_META[status] || { label: status || "-", type: "info" };
}

function getProductKey(row) {
  if (state.mode === "seller") {
    const sku = Array.isArray(row?.sku) ? row.sku[0] : row?.sku;
    return String(sku || row?.product_id || getOfferId(row) || row?.name || "unknown");
  }
  return String(row?.product_id || row?.id || getOfferId(row) || row?.name || "unknown");
}

function getProductId(row) {
  return row?.product_id ?? row?.id ?? row?.productId;
}

function getFirstSku(row) {
  if (Array.isArray(row?.sku)) return row.sku[0];
  if (Array.isArray(row?.skus)) return row.skus[0];
  return row?.sku ?? row?.fbo_sku ?? row?.fbs_sku;
}

function getSkuText(row) {
  const value = row?.sku ?? row?.skus ?? row?.fbo_sku ?? row?.fbs_sku;
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  return value || "-";
}

function getOfferId(row) {
  return row?.offer_id || row?.offerId || row?.offer || row?.external_id || "";
}

function getProductImage(row) {
  if (typeof row?.image_url === "string" && row.image_url) return row.image_url;
  if (typeof row?.image === "string" && row.image) return row.image;
  if (typeof row?.primary_image === "string" && row.primary_image) return row.primary_image;
  if (Array.isArray(row?.primary_image) && row.primary_image[0]) return row.primary_image[0];
  if (Array.isArray(row?.images) && row.images[0]) return row.images[0];
  if (typeof row?.photo === "string" && row.photo) return row.photo;
  if (typeof row?.picture === "string" && row.picture) return row.picture;
  if (Array.isArray(row?.pictures) && row.pictures[0]) return row.pictures[0];
  return "";
}

function getOfficialActionAddMode(row) {
  const key = String(row?.add_mode || "").trim().toUpperCase();
  if (key === "AUTO") return { label: "自动添加", type: "warning" };
  if (key === "MANUAL") return { label: "手动添加", type: "primary" };
  return { label: key || "未知", type: "info" };
}

function normalizeActions(payload) {
  if (state.mode === "seller") return Array.isArray(payload?.actions) ? payload.actions : [];
  return Array.isArray(payload?.result) ? payload.result : Array.isArray(payload?.actions) ? payload.actions : [];
}

function normalizeProducts(payload) {
  if (state.mode === "seller") return Array.isArray(payload?.products) ? payload.products : [];
  const result = payload?.result || {};
  return Array.isArray(result.products) ? result.products : Array.isArray(payload?.products) ? payload.products : [];
}

function getProductsCursor(payload) {
  return state.mode === "seller" ? payload?.cursor : payload?.result?.last_id;
}

function getProductsHasNext(payload) {
  if (state.mode === "seller") return Boolean(payload?.has_next);
  return Boolean(getProductsCursor(payload));
}

function getPagerRows(pager, page = pager?.current || 1) {
  return Array.isArray(pager?.pages?.[page]) ? pager.pages[page] : [];
}

function getKnownProductsTotal(action, scope) {
  const raw = scope === "joined" ? action?.participating_products_count ?? action?.sku_count : action?.potential_products_count;
  const total = Number(raw);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

function getPagerDisplayTotal(pager, totalHint) {
  const knownTotal = Number(totalHint);
  if (Number.isFinite(knownTotal) && knownTotal >= 0) return knownTotal;
  const pageNumbers = Object.keys(pager?.pages || {}).map(Number).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!pageNumbers.length) return 0;
  const lastLoadedPage = pageNumbers[pageNumbers.length - 1];
  const loadedTotal = (lastLoadedPage - 1) * (pager?.pageSize || PRODUCT_PAGE_SIZE) + getPagerRows(pager, lastLoadedPage).length;
  return pager?.pageHasNext?.[lastLoadedPage] ? loadedTotal + 1 : loadedTotal;
}

function buildEditValue(row) {
  if (state.mode === "seller") {
    return {
      discount_percent: row?.discount_percent ?? "",
      currency: row?.currency || "RUB"
    };
  }
  return {
    action_price: row?.action_price || row?.max_action_price || row?.alert_max_action_price || "",
    stock: row?.stock ?? row?.min_stock ?? ""
  };
}

function mergeRowsIntoEditValues(rows = []) {
  for (const row of rows) {
    const key = getProductKey(row);
    state.editValues[key] = { ...(state.editValues[key] || {}), ...buildEditValue(row) };
  }
}

function updateEditValue(key, patch) {
  state.editValues[key] = { ...(state.editValues[key] || {}), ...patch };
}

function resetProducts() {
  state.productPagers = {
    candidates: createEmptyProductPager(),
    joined: createEmptyProductPager()
  };
  state.productScope = "candidates";
  state.selectedRowKeys = [];
  state.editValues = {};
}

async function loadShops() {
  try {
    const payload = await apiClient.get("/api/shops", { noCache: true });
    state.shops = Array.isArray(payload) ? payload : payload?.rows || [];
    if (!state.storeId && state.shops[0]) state.storeId = String(state.shops[0].id);
  } catch (error) {
    state.shops = [];
    ElMessage.error(`加载店铺失败：${error.message || "unknown"}`);
  }
}

async function loadCleanupConfig() {
  if (!state.storeId) {
    state.cleanupConfig = createEmptyCleanupConfig();
    return;
  }
  state.cleanupLoading = true;
  try {
    const payload = await apiClient.get(`/api/ozon/actions/cleanup-config?storeId=${encodeURIComponent(state.storeId)}`, { noCache: true });
    state.cleanupConfig = normalizeCleanupConfig(payload, state.storeId);
  } catch (error) {
    state.cleanupConfig = createEmptyCleanupConfig(state.storeId);
    ElMessage.error(`加载自动清理状态失败：${error.message || "unknown"}`);
  } finally {
    state.cleanupLoading = false;
  }
}

async function saveCleanupEnabled(enabled) {
  if (!state.storeId) {
    ElMessage.warning("请先选择店铺");
    return;
  }
  const previous = {
    ...state.cleanupConfig,
    actionIds: state.cleanupConfig.actionIds.slice(),
    lastResult: state.cleanupConfig.lastResult ? { ...state.cleanupConfig.lastResult } : null
  };
  state.cleanupConfig = { ...state.cleanupConfig, enabled };
  state.cleanupSaving = true;
  try {
    const payload = await apiClient.post("/api/ozon/actions/cleanup-config", { storeId: state.storeId, enabled });
    state.cleanupConfig = normalizeCleanupConfig(payload?.config, state.storeId);
    ElMessage.success(enabled ? "已开启当前店铺自动清理配置" : "已关闭当前店铺自动清理配置");
  } catch (error) {
    state.cleanupConfig = previous;
    ElMessage.error(`保存自动清理配置失败：${error.message || "unknown"}`);
  } finally {
    state.cleanupSaving = false;
  }
}

async function loadActions() {
  if (!state.storeId) {
    ElMessage.warning("请选择店铺");
    return;
  }
  state.actionsLoading = true;
  resetProducts();
  try {
    const payload = await apiClient.post("/api/ozon/actions/list", {
      storeId: state.storeId,
      mode: state.mode,
      limit: 100,
      offset: 0,
      status: state.mode === "seller" && state.sellerStatus ? [state.sellerStatus] : undefined,
      search: state.mode === "seller" ? state.search : undefined
    });
    state.actions = normalizeActions(payload);
    state.selectedActionId = state.actions[0] ? String(getActionId(state.actions[0])) : "";
  } catch (error) {
    state.actions = [];
    state.selectedActionId = "";
    ElMessage.error(`拉取活动失败：${error.message || "unknown"}`);
  } finally {
    state.actionsLoading = false;
  }
}

async function fetchProductPage(scope, targetPage, basePager) {
  const nextPager = {
    current: basePager.current || 1,
    pageSize: basePager.pageSize || PRODUCT_PAGE_SIZE,
    pages: { ...(basePager.pages || {}) },
    cursors: { 1: null, ...(basePager.cursors || {}) },
    pageHasNext: { ...(basePager.pageHasNext || {}) }
  };
  const fetchedRows = [];
  for (let pageNo = 1; pageNo <= targetPage; pageNo += 1) {
    if (nextPager.pages[pageNo]) continue;
    if (pageNo > 1 && !nextPager.cursors[pageNo]) break;
    const body = {
      storeId: state.storeId,
      mode: state.mode,
      actionId: state.selectedActionId,
      limit: nextPager.pageSize,
      ...(state.mode === "seller"
        ? { cursor: pageNo > 1 ? nextPager.cursors[pageNo] : undefined }
        : { lastId: pageNo > 1 ? nextPager.cursors[pageNo] : undefined })
    };
    const payload = await apiClient.post(scope === "joined" ? "/api/ozon/actions/products" : "/api/ozon/actions/candidates", body);
    const rows = normalizeProducts(payload);
    const nextCursor = getProductsCursor(payload);
    nextPager.pages[pageNo] = rows;
    nextPager.pageHasNext[pageNo] = getProductsHasNext(payload);
    if (nextPager.pageHasNext[pageNo] && nextCursor) nextPager.cursors[pageNo + 1] = nextCursor;
    else delete nextPager.cursors[pageNo + 1];
    fetchedRows.push(...rows);
    if (pageNo < targetPage && !nextPager.pageHasNext[pageNo]) break;
  }
  const loadedPages = Object.keys(nextPager.pages).map(Number).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  nextPager.current = nextPager.pages[targetPage] ? targetPage : loadedPages[loadedPages.length - 1] || 1;
  return { pager: nextPager, fetchedRows };
}

async function loadProducts({ scope = "candidates", page = 1, loadBoth = false } = {}) {
  if (!state.storeId || !state.selectedActionId) {
    ElMessage.warning("请先选择店铺和活动");
    return;
  }
  state.productsLoading = true;
  try {
    if (loadBoth) {
      const [candidateResult, joinedResult] = await Promise.all([
        fetchProductPage("candidates", 1, createEmptyProductPager()),
        fetchProductPage("joined", 1, createEmptyProductPager()).catch(() => ({ pager: createEmptyProductPager(), fetchedRows: [] }))
      ]);
      state.productPagers = {
        candidates: candidateResult.pager,
        joined: joinedResult.pager
      };
      state.selectedRowKeys = [];
      mergeRowsIntoEditValues([...candidateResult.fetchedRows, ...joinedResult.fetchedRows]);
      state.productScope = getPagerRows(candidateResult.pager, 1).length ? "candidates" : "joined";
      return;
    }
    const basePager = state.productPagers[scope] || createEmptyProductPager();
    if (basePager.pages[page]) {
      state.productPagers[scope] = { ...basePager, current: page };
      state.selectedRowKeys = [];
      return;
    }
    const result = await fetchProductPage(scope, page, basePager);
    state.productPagers[scope] = result.pager;
    mergeRowsIntoEditValues(result.fetchedRows);
    state.selectedRowKeys = [];
  } catch (error) {
    ElMessage.error(`拉取活动商品失败：${error.message || "unknown"}`);
    if (loadBoth) resetProducts();
  } finally {
    state.productsLoading = false;
  }
}

function openProducts(row) {
  state.selectedActionId = String(getActionId(row));
  state.productsModalOpen = true;
  void loadProducts({ loadBoth: true });
}

function fillPercentPrice() {
  if (!visibleProducts.value.length) {
    ElMessage.warning("请先拉取商品");
    return;
  }
  const percent = Number(state.syncPercent);
  if (!Number.isFinite(percent) || percent <= 0) {
    ElMessage.warning("请输入有效百分比");
    return;
  }
  for (const row of visibleProducts.value) {
    const key = getProductKey(row);
    if (state.mode === "seller") {
      updateEditValue(key, { discount_percent: percent, currency: row?.currency || state.editValues[key]?.currency || "RUB" });
    } else {
      const price = Number(row?.price ?? row?.base_price ?? row?.old_price ?? 0);
      updateEditValue(key, {
        action_price: price ? Number((price * (percent / 100)).toFixed(2)) : "",
        stock: state.editValues[key]?.stock ?? row?.stock ?? row?.min_stock ?? 0
      });
    }
  }
  ElMessage.success(state.mode === "seller" ? `已批量设置 ${percent}% 折扣` : `已按当前价 ${percent}% 批量填入活动价`);
}

function buildSubmitProducts(rows) {
  return rows.map((row) => {
    const key = getProductKey(row);
    const values = state.editValues[key] || {};
    if (state.mode === "seller") {
      return {
        sku: getFirstSku(row),
        discount_percent: values.discount_percent,
        currency: values.currency || row?.currency || "RUB"
      };
    }
    return {
      product_id: getProductId(row),
      action_price: values.action_price,
      stock: values.stock
    };
  });
}

function hasInvalidSubmitProduct(products) {
  return products.some((row) => state.mode === "seller" ? !Number(row.sku) : !Number(row.product_id) || !Number(row.action_price));
}

async function submitSelected() {
  const rows = visibleProducts.value.filter((row) => state.selectedRowKeys.includes(getProductKey(row)));
  if (!rows.length) {
    ElMessage.warning("请先选择商品");
    return;
  }
  const products = buildSubmitProducts(rows);
  if (hasInvalidSubmitProduct(products)) {
    ElMessage.warning(state.mode === "seller" ? "已选商品缺少有效 SKU" : "已选商品必须填写有效活动价");
    return;
  }
  await ElMessageBox.confirm(`即将提交 ${products.length} 个商品到活动「${localizeActionTitle(selectedAction.value)}」，确认继续吗？`, state.productScope === "joined" ? "确认保存活动设置" : "确认加入活动", {
    type: "warning",
    confirmButtonText: state.productScope === "joined" ? "保存修改" : "加入活动",
    cancelButtonText: "取消"
  });
  state.submitting = true;
  try {
    await apiClient.post("/api/ozon/actions/products/add", { storeId: state.storeId, mode: state.mode, actionId: state.selectedActionId, products });
    ElMessage.success(state.productScope === "joined" ? `已保存 ${products.length} 个商品的活动设置` : `已提交 ${products.length} 个商品到活动`);
    await loadProducts({ loadBoth: true });
  } catch (error) {
    ElMessage.error(`提交失败：${error.message || "unknown"}`);
  } finally {
    state.submitting = false;
  }
}

async function submitSingleProduct(row) {
  const key = getProductKey(row);
  const products = buildSubmitProducts([row]);
  if (hasInvalidSubmitProduct(products)) {
    ElMessage.warning(state.mode === "seller" ? "当前商品缺少有效 SKU" : "当前商品必须填写有效活动价");
    return;
  }
  state.submittingProductKey = key;
  try {
    await apiClient.post("/api/ozon/actions/products/add", { storeId: state.storeId, mode: state.mode, actionId: state.selectedActionId, products });
    ElMessage.success(state.productScope === "joined" ? "当前商品活动设置已更新" : "当前商品已加入活动");
    await loadProducts({ loadBoth: true });
  } catch (error) {
    ElMessage.error(`提交失败：${error.message || "unknown"}`);
  } finally {
    state.submittingProductKey = "";
  }
}

async function removeSelected() {
  const rows = visibleProducts.value.filter((row) => state.selectedRowKeys.includes(getProductKey(row)));
  if (!rows.length) {
    ElMessage.warning("请先选择商品");
    return;
  }
  await ElMessageBox.confirm(`即将从活动「${localizeActionTitle(selectedAction.value)}」中移除 ${rows.length} 个商品，确认继续吗？`, "确认移除商品", {
    type: "warning",
    confirmButtonText: "移除",
    cancelButtonText: "取消",
    confirmButtonClass: "el-button--danger"
  });
  state.submitting = true;
  try {
    const products = rows.map((row) => ({ product_id: getProductId(row), sku: getFirstSku(row) }));
    await apiClient.post("/api/ozon/actions/products/remove", { storeId: state.storeId, mode: state.mode, actionId: state.selectedActionId, products });
    ElMessage.success(`已移除 ${rows.length} 个商品`);
    await loadProducts({ loadBoth: true });
  } catch (error) {
    ElMessage.error(`移除商品失败：${error.message || "unknown"}`);
  } finally {
    state.submitting = false;
  }
}

async function toggleSellerAction(row, enabled) {
  await ElMessageBox.confirm(`确认${enabled ? "启用" : "暂停"}活动「${localizeActionTitle(row)}」？`, enabled ? "启用促销活动" : "暂停促销活动", {
    type: "warning",
    confirmButtonText: enabled ? "启用" : "暂停",
    cancelButtonText: "取消"
  });
  try {
    await apiClient.post("/api/ozon/actions/activity/toggle", { storeId: state.storeId, actionId: getActionId(row), enabled });
    ElMessage.success(enabled ? "活动已启用" : "活动已暂停");
    await loadActions();
  } catch (error) {
    ElMessage.error(`${enabled ? "启用" : "暂停"}活动失败：${error.message || "unknown"}`);
  }
}

async function archiveSellerAction(row) {
  await ElMessageBox.confirm(`确认归档活动「${localizeActionTitle(row)}」？归档后不会再出现在常用活动列表中。`, "归档促销活动", {
    type: "warning",
    confirmButtonText: "归档",
    cancelButtonText: "取消",
    confirmButtonClass: "el-button--danger"
  });
  try {
    await apiClient.post("/api/ozon/actions/activity/archive", { storeId: state.storeId, actionId: getActionId(row) });
    ElMessage.success("活动已归档");
    await loadActions();
  } catch (error) {
    ElMessage.error(`归档活动失败：${error.message || "unknown"}`);
  }
}

function cleanupResultSummary(config) {
  if (config?.lastError) return `最近失败：${config.lastError}`;
  const total = Number(config?.lastResult?.removedCount || 0);
  const summaries = Array.isArray(config?.lastResult?.actionSummaries) ? config.lastResult.actionSummaries : [];
  if (!summaries.length) return total > 0 ? `最近移除 ${total} 个自动添加商品` : "最近执行未发现需要移除的自动添加商品";
  const detail = summaries.map((item) => `${item.actionId}: ${Number(item.removedCount || 0)}`).join(" / ");
  return total > 0 ? `最近移除 ${total} 个自动添加商品（${detail}）` : `最近执行完成（${detail}）`;
}

watch(() => state.storeId, async () => {
  await loadCleanupConfig();
  await loadActions();
});

watch(() => state.mode, async () => {
  state.selectedActionId = "";
  state.actions = [];
  resetProducts();
  await loadActions();
});

watch(() => state.sellerStatus, async () => {
  if (state.mode === "seller") await loadActions();
});

onMounted(async () => {
  await loadShops();
});
</script>

<template>
  <div class="ozon-actions-view">
    <section class="ozon-actions-toolbar">
      <div class="toolbar-title">
        <h1>活动管理</h1>
        <span>管理 Ozon 官方活动和卖家自建促销商品。</span>
      </div>
      <div class="toolbar-filters">
        <el-select v-model="state.storeId" filterable placeholder="选择店铺" class="store-select">
          <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
        </el-select>
        <el-select v-if="state.mode === 'seller'" v-model="state.sellerStatus" class="status-select">
          <el-option v-for="item in SELLER_STATUS_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-input v-if="state.mode === 'seller'" v-model="state.search" clearable placeholder="搜索活动，至少 3 个字符" class="search-input" @keyup.enter="loadActions">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Search" :loading="state.actionsLoading" @click="loadActions">拉取活动</el-button>
      </div>
    </section>

    <section class="ozon-actions-cleanup">
      <div>
        <strong>自动删活动商品</strong>
        <span>仅针对当前店铺的官方活动 {{ state.cleanupConfig.actionIds.join(" / ") }}，配置会保存在后台。</span>
        <small>后台任务：{{ state.cleanupConfig.taskEnabled ? (state.cleanupConfig.taskRunning ? "正在执行" : "已启用") : "未启用" }}；最近执行：{{ state.cleanupConfig.lastRunAt ? formatDate(state.cleanupConfig.lastRunAt) : "-" }}</small>
        <small>{{ cleanupResultSummary(state.cleanupConfig) }}</small>
      </div>
      <div class="cleanup-actions">
        <el-switch
          v-model="state.cleanupConfig.enabled"
          :disabled="!state.storeId"
          :loading="state.cleanupSaving"
          active-text="开启"
          inactive-text="关闭"
          @change="saveCleanupEnabled"
        />
        <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" :loading="state.cleanupLoading" :disabled="!state.storeId" @click="loadCleanupConfig">刷新</el-button>
      </div>
    </section>

    <section class="ozon-actions-tabs">
      <el-segmented v-model="state.mode" :options="MODE_ITEMS.map((item) => ({ label: item.label, value: item.key }))" />
    </section>

    <section class="ozon-actions-table">
      <div class="section-head">
        <div>
          <h2>活动列表</h2>
          <span>{{ state.mode === "seller" ? "卖家自建促销活动" : "Ozon 官方可参与活动" }}</span>
        </div>
        <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" :loading="state.actionsLoading" @click="loadActions">刷新</el-button>
      </div>
      <el-table
        v-loading="state.actionsLoading"
        :data="state.actions"
        border
        stripe
        height="calc(100vh - 390px)"
        empty-text="暂无活动，请先拉取"
        row-key="id"
        :row-class-name="({ row }) => String(getActionId(row)) === String(state.selectedActionId) ? 'selected-action-row' : ''"
        @row-click="openProducts"
      >
        <el-table-column label="活动" min-width="360">
          <template #default="{ row }">
            <div class="action-title">
              <strong>{{ localizeActionTitle(row) }}</strong>
              <small v-if="localizeActionTitle(row) !== getRawActionTitle(row)">原文：{{ getRawActionTitle(row) }}</small>
              <small>ID: {{ getActionId(row) || "-" }}</small>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="类型" min-width="220">
          <template #default="{ row }">
            <el-tag>{{ getActionType(row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag v-if="state.mode !== 'seller'" type="primary">官方活动</el-tag>
            <el-tag v-else :type="statusMeta(row).type">{{ statusMeta(row).label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="190">
          <template #default="{ row }">
            <div class="time-cell">
              <span>起: {{ formatDate(row?.date_start || row?.start_at || row?.starts_at || row?.start_date).split(" ")[0] }}</span>
              <span>止: {{ formatDate(row?.date_end || row?.end_at || row?.ends_at || row?.end_date).split(" ")[0] }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="数量" width="150">
          <template #default="{ row }">
            <div class="time-cell">
              <span>可: {{ numberText(row?.potential_products_count) }}</span>
              <span>已: {{ numberText(row?.participating_products_count ?? row?.sku_count) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button class="erp-btn-link" link type="primary" @click.stop="openProducts(row)">管理商品</el-button>
            <el-dropdown v-if="state.mode === 'seller'" trigger="click" @command="(cmd) => cmd === 'pause' ? toggleSellerAction(row, false) : cmd === 'resume' ? toggleSellerAction(row, true) : archiveSellerAction(row)">
              <el-button class="erp-btn-link" link type="primary" @click.stop>更多</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-if="getSellerActionStatus(row) === 'ACTIVE'" command="pause">暂停活动</el-dropdown-item>
                  <el-dropdown-item v-if="['PAUSED', 'PLANNED'].includes(getSellerActionStatus(row))" command="resume">启用活动</el-dropdown-item>
                  <el-dropdown-item command="archive">归档活动</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-dialog v-model="state.productsModalOpen" width="min(1480px, 96vw)" class="ozon-products-dialog" destroy-on-close>
      <template #header>
        <div class="dialog-head">
          <h2>{{ selectedAction ? localizeActionTitle(selectedAction) : "活动商品" }}</h2>
          <span>可参加 {{ candidateTotal }} 个 / 已参加 {{ joinedTotal }} 个</span>
        </div>
      </template>

      <div class="products-panel">
        <el-tabs v-model="state.productScope" @tab-change="(scope) => loadProducts({ scope, page: 1 })">
          <el-tab-pane :label="`可参加商品 (${candidateTotal})`" name="candidates" />
          <el-tab-pane :label="`已参加商品 (${joinedTotal})`" name="joined" />
        </el-tabs>

        <div class="product-actions">
          <el-button class="erp-btn erp-btn-secondary" :loading="state.productsLoading" @click="loadProducts({ loadBoth: true })">重新拉取</el-button>
          <el-input-number v-model="state.syncPercent" :min="1" :max="99" :precision="0" />
          <el-button class="erp-btn erp-btn-secondary" :disabled="!visibleProducts.length" @click="fillPercentPrice">{{ state.mode === "seller" ? "一键折扣" : "一键填活动价" }}</el-button>
          <el-button class="erp-btn erp-btn-danger" type="danger" :disabled="!state.selectedRowKeys.length || state.productScope !== 'joined'" :loading="state.submitting" @click="removeSelected">
            移除商品{{ state.selectedRowKeys.length && state.productScope === "joined" ? `(${state.selectedRowKeys.length})` : "" }}
          </el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :icon="Plus" :disabled="!state.selectedRowKeys.length" :loading="state.submitting" @click="submitSelected">
            {{ state.productScope === "joined" ? "保存修改" : "加入活动" }}{{ state.selectedRowKeys.length ? `(${state.selectedRowKeys.length})` : "" }}
          </el-button>
        </div>

        <p v-if="state.mode === 'official'" class="product-hint">官方活动支持单条提交，改完一行后可直接点“单条加入”或“单条更新”。</p>

        <el-table
          v-loading="state.productsLoading"
          :data="visibleProducts"
          border
          height="calc(100vh - 380px)"
          :row-key="getProductKey"
          empty-text="暂无活动商品"
          @selection-change="(rows) => state.selectedRowKeys = rows.map(getProductKey)"
        >
          <el-table-column type="selection" width="44" />
          <el-table-column label="商品" min-width="460">
            <template #default="{ row }">
              <div class="product-cell">
                <div class="product-image">
                  <img v-if="getProductImage(row)" :src="getProductImage(row)" alt="" />
                  <span v-else>无图</span>
                </div>
                <div class="product-meta">
                  <strong>{{ row?.name || getOfferId(row) || `商品 ${getProductId(row) || getFirstSku(row) || "-"}` }}</strong>
                  <small>Offer ID: {{ getOfferId(row) || "-" }}</small>
                  <small>商品 ID: {{ getProductId(row) || "-" }}</small>
                  <small>SKU: {{ getSkuText(row) }}</small>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="价格" width="170">
            <template #default="{ row }">
              <div class="time-cell">
                <span>当前: {{ numberText(row?.price ?? row?.base_price) }}</span>
                <span>建议: {{ numberText(row?.action_price ?? row?.max_action_price) }}</span>
                <span v-if="row?.min_seller_price != null">最低: {{ numberText(row.min_seller_price) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column v-if="state.mode === 'official'" label="添加方式" width="120">
            <template #default="{ row }">
              <el-tag v-if="state.productScope === 'joined'" :type="getOfficialActionAddMode(row).type">{{ getOfficialActionAddMode(row).label }}</el-tag>
              <el-tag v-else type="info">-</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="活动设置" width="360">
            <template #default="{ row }">
              <div v-if="state.mode === 'seller'" class="edit-inputs">
                <label>
                  <span>折扣</span>
                  <el-input-number
                    :model-value="state.editValues[getProductKey(row)]?.discount_percent"
                    :min="0"
                    :max="99"
                    :precision="2"
                    @update:model-value="(value) => updateEditValue(getProductKey(row), { discount_percent: value })"
                  />
                </label>
              </div>
              <div v-else class="edit-inputs">
                <label>
                  <span>活动价</span>
                  <el-input-number
                    :model-value="state.editValues[getProductKey(row)]?.action_price"
                    :min="0"
                    :precision="2"
                    @update:model-value="(value) => updateEditValue(getProductKey(row), { action_price: value })"
                  />
                </label>
                <label>
                  <span>库存</span>
                  <el-input-number
                    :model-value="state.editValues[getProductKey(row)]?.stock"
                    :min="0"
                    :precision="0"
                    @update:model-value="(value) => updateEditValue(getProductKey(row), { stock: value })"
                  />
                </label>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag :type="state.productScope === 'joined' || row?.is_active ? 'success' : 'info'">
                {{ state.productScope === "joined" || row?.is_active ? "已参加" : "可参加" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="state.mode === 'official'" label="单条提交" width="120" fixed="right">
            <template #default="{ row }">
              <el-button class="erp-btn-link" link type="primary" :loading="state.submittingProductKey === getProductKey(row)" @click="submitSingleProduct(row)">
                {{ state.productScope === "joined" ? "单条更新" : "单条加入" }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>

        <div class="products-footer">
          <span>每页 {{ currentPager.pageSize }} 条，当前页 {{ visibleProducts.length }} 条。</span>
          <el-pagination
            layout="prev, pager, next"
            :current-page="currentPager.current"
            :page-size="currentPager.pageSize"
            :total="state.productScope === 'joined' ? joinedTotal : candidateTotal"
            :disabled="state.productsLoading"
            @current-change="(page) => loadProducts({ scope: state.productScope, page })"
          />
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.ozon-actions-view {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 100%;
}

.ozon-actions-toolbar,
.ozon-actions-cleanup,
.ozon-actions-tabs,
.ozon-actions-table {
  border: 1px solid var(--erp-border);
  border-radius: 8px;
  background: var(--erp-surface);
  box-shadow: var(--erp-shadow);
}

.ozon-actions-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 16px 18px;
}

.toolbar-title h1,
.section-head h2,
.dialog-head h2 {
  margin: 0;
  color: var(--erp-text);
  font-size: 18px;
  font-weight: 800;
}

.toolbar-title span,
.section-head span,
.dialog-head span,
.ozon-actions-cleanup span,
.ozon-actions-cleanup small {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.toolbar-filters,
.section-head,
.product-actions,
.products-footer,
.cleanup-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.store-select {
  width: 240px;
}

.status-select {
  width: 150px;
}

.search-input {
  width: 240px;
}

.ozon-actions-cleanup {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
}

.ozon-actions-cleanup > div:first-child,
.action-title,
.time-cell,
.product-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.ozon-actions-tabs {
  padding: 10px 16px;
}

.ozon-actions-table {
  padding: 16px;
}

.section-head {
  justify-content: space-between;
  margin-bottom: 12px;
}

.action-title strong {
  color: var(--erp-text);
  font-size: 14px;
  line-height: 1.35;
}

.action-title small,
.time-cell span,
.product-meta small,
.product-hint {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

:deep(.selected-action-row td) {
  background: var(--erp-primary-soft) !important;
}

.dialog-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.products-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.product-actions {
  justify-content: flex-end;
  flex-wrap: wrap;
}

.product-hint {
  margin: -4px 0 0;
}

.product-cell {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.product-image {
  flex: 0 0 64px;
  width: 64px;
  height: 64px;
  border: 1px solid var(--erp-border);
  border-radius: 8px;
  background: var(--erp-surface-alt);
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.product-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.product-meta strong {
  color: var(--erp-text);
  font-size: 13px;
  line-height: 1.35;
  display: block;
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.edit-inputs {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.edit-inputs label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.edit-inputs :deep(.el-input-number) {
  width: 142px;
}

.products-footer {
  justify-content: space-between;
  color: var(--erp-text-secondary);
  font-size: 12px;
}
</style>
