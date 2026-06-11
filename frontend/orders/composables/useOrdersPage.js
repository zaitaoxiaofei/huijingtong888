import { computed, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../admin/utils/api.js";
import { shanghaiDateDaysAgo, shanghaiDateKey } from "../../admin/utils/shanghai-date.js";
import {
  bulkPrepareOrders,
  bulkPrintOrders,
  changeOrderMarkFilter,
  changeOrderPageSize,
  changeOrderPrintView,
  changeOrderStatus,
  createOrderProcurementRequests,
  fetchOrderDetail,
  handleMoreOrderAction,
  jumpToStockProduct,
  openBindProduct,
  openBindProductFromOrder,
  openCreateProduct,
  openCreateProductFromOrder,
  openQualityRules,
  openOrderProfit,
  openProcurement,
  previewOrderProcurement,
  prevOrderPage,
  recalculateOrderProfit,
  resetRecentDates,
  saveOrderMark,
  saveQualityRules,
  submitOrderFilters,
  nextOrderPage
} from "../services/orders-service.js";

const SHOPS_CACHE_TTL_MS = 5 * 60 * 1000;
const LOGISTICS_OPTIONS_CACHE_TTL_MS = 10 * 60 * 1000;
const ORDERS_META_DELAY_MS = 1200;
const DEFAULT_ORDER_STATUS = "awaiting_packaging";
const ORDER_STATUS_TAB_PREFERENCE_KEY = "orders.status_tabs";
let shopsCache = {
  rows: [],
  timestamp: 0
};
let logisticsOptionsCache = {
  rows: [],
  timestamp: 0
};
let ordersMetaTimer = 0;

const STATUS_TABS = [
  { value: "awaiting_packaging", label: "等待备货" },
  { value: "awaiting_deliver", label: "等待发货" },
  { value: "delivering", label: "运输中" },
  { value: "delivered", label: "已签收" },
  { value: "cancelled", label: "已取消" },
  { value: "dispute", label: "有争议" },
  { value: "all", label: "全部订单" },
  { value: "unbound", label: "待绑定库存" }
];
const DEFAULT_STATUS_TAB_ORDER = STATUS_TABS.map((item) => item.value);

const MARK_OPTIONS = [
  { value: "", label: "无标记", color: "none", filterable: false },
  { value: "quality", label: "质检单", color: "red", filterable: true },
  { value: "urgent", label: "紧急订单", color: "red", filterable: true },
  { value: "follow", label: "待跟进", color: "orange", filterable: true },
  { value: "issue", label: "有问题", color: "yellow", filterable: true },
  { value: "solved", label: "已解决", color: "green", filterable: true },
  { value: "vip", label: "重要客户", color: "cyan", filterable: true },
  { value: "special", label: "特殊处理", color: "purple", filterable: true },
  { value: "other", label: "其他", color: "gray", filterable: true }
];

const PRINT_VIEWS = [
  { value: "all", label: "全部" },
  { value: "inventory", label: "按库存顺序打印" },
  { value: "printed", label: "已打印" },
  { value: "unprinted", label: "未打印" }
];

const MORE_ACTIONS = [
  { value: "recalculate-profit", label: "重算利润" },
  { value: "print-selected", label: "打印所选" },
  { value: "prepare-selected", label: "备货所选" }
];

const DEFAULT_LOGISTICS_METHOD_OPTIONS = [
  { value: "all", label: "全部物流" },
  { value: "cel_air_land_1_500g", label: "CEL 陆空 1-500g" },
  { value: "cel_land_1_500g", label: "CEL 陆运 1-500g" },
  { value: "postal_1_500g", label: "邮政 1-500g" },
  { value: "hunchun_2", label: "hunchun 2" },
  { value: "cel_land_500_25000g", label: "CEL 陆运 500-25000g" },
  { value: "cel_land_2_30kg", label: "CEL 陆运 2-30kg" },
  { value: "cel_land_0_5_30kg", label: "CEL 陆运 0.5-30kg" },
  { value: "cel_land_1_2000g", label: "CEL 陆运 1-2000g" },
  { value: "guoo_light_land", label: "GUOO 超级轻小件" }
];

const DEFAULT_PAGE_SIZE = 20;
const AWAITING_PACKAGING_STATES = ["awaiting_registration", "acceptance_in_progress", "awaiting_approve", "awaiting_packaging", "posting_created", "posting_awaiting_registration", "posting_acceptance_in_progress"];
const AWAITING_DELIVER_STATES = ["awaiting_deliver", "posting_registered", "sent_by_seller", "posting_ready_for_pickup", "posting_transferred_to_courier_service", "posting_transferring", "posting_in_carriage", "posting_transferring_to_delivery"];
const DELIVERING_KEYWORDS = ["delivering", "transferring", "carriage", "pickup", "sorting", "customs", "shipped", "sent", "on_way", "posting_in_carriage", "posting_transferring", "发往", "已上网", "发走"];

function createDefaultFilters(defaultFrom, defaultTo) {
  return {
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    status: DEFAULT_ORDER_STATUS,
    shopId: "all",
    logisticsMethod: "all",
    dateFrom: defaultFrom,
    dateTo: defaultTo,
    searchType: "order",
    searchQuery: "",
    markFilter: "all",
    printView: "all",
    printFilter: "all",
    sortMode: "ordered"
  };
}

function normalizePrintState(filters = {}) {
  const printView = String(filters.printView || "all");
  const printFilter = printView === "printed"
    ? "printed"
    : printView === "unprinted"
      ? "unprinted"
      : "all";
  const sortMode = printView === "inventory" ? "inventory" : "ordered";
  return { printView, printFilter, sortMode };
}

function friendlyPrepareError(error) {
  const message = String(error?.message || error || "");
  const lower = message.toLowerCase();
  if (lower.includes("awaiting_deliver") || lower.includes("already") || lower.includes("not in process") || lower.includes("invalid status") || lower.includes("has_incorrect_status")) {
    return "备货失败：这个订单状态已经变化，请刷新订单列表后重试。";
  }
  if (lower.includes("fbp") || lower.includes("warehouse")) {
    return "备货失败：这个订单可能是 FBP 仓发订单，不需要在本地备货。";
  }
  return `备货失败：${message || "未知错误"}`;
}

function orderTabKey(row = {}) {
  const values = [row.status, row.tracking_stage].map((value) => String(value || "").toLowerCase());
  if (values.some((value) => AWAITING_PACKAGING_STATES.includes(value))) return "awaiting_packaging";
  if (values.some((value) => AWAITING_DELIVER_STATES.includes(value))) return "awaiting_deliver";
  const text = [row.status, row.tracking_stage, row.logistics_status].map((value) => String(value || "").toLowerCase()).join(" ");
  if (DELIVERING_KEYWORDS.some((keyword) => text.includes(keyword))) return "delivering";
  return "all";
}

async function fetchShopsCached(force = false) {
  if (!force && shopsCache.rows.length && Date.now() - shopsCache.timestamp < SHOPS_CACHE_TTL_MS) {
    return shopsCache.rows;
  }
  const shops = await apiClient.get("/api/shops");
  shopsCache = {
    rows: Array.isArray(shops) ? shops : [],
    timestamp: Date.now()
  };
  return shopsCache.rows;
}

export function useOrdersPage() {
  const loading = ref(false);
  const selectedOrderIds = ref(new Set());
  const orderSyncAbort = ref(null);
  const orderSyncCancelReason = ref("");
  const ordersListAbort = ref(null);
  const ordersMetaAbort = ref(null);
  const logisticsOptionsAbort = ref(null);
  const logisticsOptionsPromise = ref(null);
  const ordersLoadToken = ref(0);
  const statusTabOrder = ref([...DEFAULT_STATUS_TAB_ORDER]);
  const defaultTo = shanghaiDateKey();
  const defaultFrom = shanghaiDateDaysAgo(90);

  function normalizeStatusTabOrder(order = []) {
    const validValues = new Set(DEFAULT_STATUS_TAB_ORDER);
    const selected = Array.isArray(order)
      ? order.map((item) => String(item || "")).filter((item) => validValues.has(item))
      : [];
    return [...new Set([...selected, ...DEFAULT_STATUS_TAB_ORDER])];
  }

  function statusTabMetaMap() {
    return new Map(STATUS_TABS.map((item) => [item.value, item]));
  }

  function buildStatusTabs(counts = {}, total = 0) {
    const byValue = statusTabMetaMap();
    return normalizeStatusTabOrder(statusTabOrder.value).map((value) => byValue.get(value)).filter(Boolean).map((item) => ({
      ...item,
      count: Number(counts?.[item.value] || (item.value === "all" ? total || 0 : 0))
    }));
  }

  function applyStatusTabOrder(order = []) {
    statusTabOrder.value = normalizeStatusTabOrder(order);
    vm.statusTabs = buildStatusTabs(vm.meta.counts || {}, Number(vm.meta.total || 0));
  }

  async function loadStatusTabPreference() {
    try {
      const result = await apiClient.get(`/api/user-preferences?${new URLSearchParams({ key: ORDER_STATUS_TAB_PREFERENCE_KEY }).toString()}`, { noCache: true });
      const order = Array.isArray(result?.value?.order) ? result.value.order : [];
      applyStatusTabOrder(order);
      return statusTabOrder.value;
    } catch (error) {
      console.warn("load order status tab preference failed", error);
      applyStatusTabOrder(DEFAULT_STATUS_TAB_ORDER);
      return statusTabOrder.value;
    }
  }

  async function saveStatusTabPreference(order = []) {
    const normalized = normalizeStatusTabOrder(order);
    applyStatusTabOrder(normalized);
    await apiClient.post("/api/user-preferences", {
      key: ORDER_STATUS_TAB_PREFERENCE_KEY,
      value: { order: normalized }
    });
    return normalized;
  }

  function buildOrdersParams(filters = {}, extra = {}) {
    return new URLSearchParams({
      paged: "1",
      page: String(filters.page || 1),
      pageSize: String(filters.pageSize || DEFAULT_PAGE_SIZE),
      status: filters.status || DEFAULT_ORDER_STATUS,
      shopId: filters.shopId || "all",
      logisticsMethod: filters.logisticsMethod || "all",
      dateFrom: filters.dateFrom || "",
      dateTo: filters.dateTo || "",
      searchType: filters.searchType || "order",
      searchQuery: filters.searchQuery || "",
      markFilter: filters.markFilter || "all",
      printView: filters.printView || "all",
      printFilter: filters.printFilter || "all",
      sortMode: filters.sortMode || "ordered",
      ...extra
    });
  }

  const vm = reactive({
    title: "我的订单",
    subtitle: "订单管理工作台",
    rows: [],
    shops: [],
    statusTabs: buildStatusTabs({}, 0),
    markOptions: MARK_OPTIONS,
    printViews: PRINT_VIEWS,
    logisticsMethodOptions: DEFAULT_LOGISTICS_METHOD_OPTIONS,
    moreActions: MORE_ACTIONS,
    syncStatus: "",
    syncRunning: false,
    filters: createDefaultFilters(defaultFrom, defaultTo),
    meta: {
      total: 0,
      counts: {}
    }
  });

  const totalPages = computed(() => Math.max(1, Math.ceil((vm.meta.total || 0) / (vm.filters.pageSize || DEFAULT_PAGE_SIZE))));
  const totalLabel = computed(() => `${vm.meta.total || 0} 条订单`);
  const activeStatusLabel = computed(() => vm.statusTabs.find((item) => item.value === vm.filters.status)?.label || "等待备货");

  function patch(payload = {}) {
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(payload, key);

    if (hasOwn("title")) vm.title = String(payload.title || vm.title);
    if (hasOwn("subtitle")) vm.subtitle = String(payload.subtitle || vm.subtitle);
    if (hasOwn("rows")) vm.rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (hasOwn("shops")) vm.shops = Array.isArray(payload.shops) ? payload.shops : [];
    if (hasOwn("statusTabs")) vm.statusTabs = Array.isArray(payload.statusTabs) ? payload.statusTabs : [];
    if (hasOwn("markOptions")) vm.markOptions = Array.isArray(payload.markOptions) ? payload.markOptions : [];
    if (hasOwn("printViews")) vm.printViews = Array.isArray(payload.printViews) ? payload.printViews : [];
    if (hasOwn("logisticsMethodOptions")) vm.logisticsMethodOptions = Array.isArray(payload.logisticsMethodOptions) ? payload.logisticsMethodOptions : [];
    if (hasOwn("moreActions")) vm.moreActions = Array.isArray(payload.moreActions) ? payload.moreActions : [];
    if (hasOwn("syncStatus")) vm.syncStatus = String(payload.syncStatus || "");
    if (hasOwn("syncRunning")) vm.syncRunning = Boolean(payload.syncRunning);

    if (hasOwn("filters")) {
      const filters = {
        ...createDefaultFilters(defaultFrom, defaultTo),
        ...(payload.filters || {})
      };
      const normalizedPrint = normalizePrintState(filters);
      vm.filters = {
        page: Number(filters.page || 1),
        pageSize: Number(filters.pageSize || DEFAULT_PAGE_SIZE),
        status: String(filters.status || DEFAULT_ORDER_STATUS),
        shopId: String(filters.shopId || "all"),
        logisticsMethod: String(filters.logisticsMethod || "all"),
        dateFrom: String(filters.dateFrom || defaultFrom),
        dateTo: String(filters.dateTo || defaultTo),
        searchType: String(filters.searchType || "order"),
        searchQuery: String(filters.searchQuery || ""),
        markFilter: String(filters.markFilter || "all"),
        printView: normalizedPrint.printView,
        printFilter: normalizedPrint.printFilter,
        sortMode: normalizedPrint.sortMode
      };
    }

    if (hasOwn("meta")) {
      const nextTotalSource = payload.meta?.total ?? vm.meta.total ?? vm.rows.length;
      vm.meta = {
        total: Number(nextTotalSource || 0),
        counts: payload.meta?.counts || {}
      };
    }
  }

  async function loadOrdersMeta(filtersSnapshot, requestToken) {
    window.clearTimeout(ordersMetaTimer);
    ordersMetaAbort.value?.abort();
    const controller = new AbortController();
    ordersMetaAbort.value = controller;
    try {
      const metaParams = buildOrdersParams(filtersSnapshot, {
        includeRows: "0",
        includeCounts: "1",
        includeLogisticsOptions: "0"
      });
      const result = await apiClient.get(`/api/orders?${metaParams.toString()}`, { signal: controller.signal });
      if (controller.signal.aborted || ordersLoadToken.value !== requestToken) return;
      const counts = result?.counts || {};
      patch({
        statusTabs: buildStatusTabs(counts, Number(counts?.all ?? vm.meta.total ?? 0)),
        meta: {
          total: vm.meta.total,
          counts
        }
      });
    } catch (error) {
      if (error?.name === "AbortError") return;
      console.warn("loadOrdersMeta failed", error);
    } finally {
      if (ordersMetaAbort.value === controller) {
        ordersMetaAbort.value = null;
      }
    }
  }

  async function loadOrders(options = {}) {
    ordersListAbort.value?.abort();
    ordersMetaAbort.value?.abort();
    const controller = new AbortController();
    ordersListAbort.value = controller;
    const requestToken = ordersLoadToken.value + 1;
    ordersLoadToken.value = requestToken;
    loading.value = true;
    try {
      const filtersSnapshot = { ...vm.filters };
      const params = buildOrdersParams(filtersSnapshot, {
        includeCounts: options.includeCounts ? "1" : "0",
        includeLogisticsOptions: "0"
      });
      const shopsPromise = fetchShopsCached().catch((error) => {
        console.warn("fetch shops for orders failed", error);
        return vm.shops;
      });
      const result = await apiClient.get(`/api/orders?${params.toString()}`, { signal: controller.signal });
      if (controller.signal.aborted || ordersLoadToken.value !== requestToken) return;

      const total = Number(result.total || 0);
      const counts = result?.counts || vm.meta.counts || {};

      patch({
        rows: Array.isArray(result.rows) ? result.rows : [],
        shops: vm.shops,
        markOptions: MARK_OPTIONS,
        printViews: PRINT_VIEWS,
        moreActions: MORE_ACTIONS,
        syncStatus: "",
        syncRunning: false,
        filters: {
          ...filtersSnapshot,
          page: Number(result.page || filtersSnapshot.page || 1),
          pageSize: Number(result.pageSize || filtersSnapshot.pageSize || DEFAULT_PAGE_SIZE)
        },
        statusTabs: buildStatusTabs(counts, Number(counts?.all ?? total)),
        meta: { total, counts }
      });
      loading.value = false;
      void shopsPromise.then((shops) => {
        if (controller.signal.aborted || ordersLoadToken.value !== requestToken) return;
        if (Array.isArray(shops)) patch({ shops });
      });
      window.clearTimeout(ordersMetaTimer);
      if (!options.includeCounts) {
        ordersMetaTimer = window.setTimeout(() => {
          void loadOrdersMeta(filtersSnapshot, requestToken);
        }, ORDERS_META_DELAY_MS);
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
      if (error?.status === 401) ElMessage.error("登录已失效，请重新登录");
      else ElMessage.error(error?.message || "加载订单失败");
      throw error;
    } finally {
      if (ordersListAbort.value === controller) {
        ordersListAbort.value = null;
        loading.value = false;
      }
    }
  }

  function finishOrderSync() {
    orderSyncAbort.value = null;
    orderSyncCancelReason.value = "";
    vm.syncRunning = false;
  }

  function applyPreparedOrdersLocally(orderIds = [], result = {}) {
    const updatedOrders = Array.isArray(result?.updated_orders) && result.updated_orders.length
      ? result.updated_orders
      : (Array.isArray(result?.order_ids) ? result.order_ids : orderIds).map((id) => ({
          id,
          status: "awaiting_deliver",
          tracking_stage: "awaiting_deliver",
          logistics_status: "awaiting_deliver",
          tracking_number: ""
        }));
    const successfulIds = updatedOrders.map((item) => Number(item?.id || 0)).filter(Boolean);
    if (!successfulIds.length) return;

    const successfulIdSet = new Set(successfulIds);
    const updatedOrderMap = new Map(updatedOrders.map((item) => [Number(item?.id || 0), item]));
    const isAwaitingPackagingView = vm.filters.status === "awaiting_packaging";
    let removedCount = 0;
    let updatedVisibleCount = 0;
    const countAdjustments = {};

    const nextRows = (Array.isArray(vm.rows) ? vm.rows : []).reduce((rows, row) => {
      const rowId = Number(row?.id || 0);
      if (!successfulIdSet.has(rowId)) {
        rows.push(row);
        return rows;
      }

      updatedVisibleCount += 1;
      const incoming = updatedOrderMap.get(rowId) || {};
      const previousTabKey = orderTabKey(row);
      const updatedRow = {
        ...row,
        status: incoming.status || "awaiting_deliver",
        tracking_stage: incoming.tracking_stage || incoming.status || "awaiting_deliver",
        logistics_status: incoming.logistics_status || incoming.tracking_stage || incoming.status || "awaiting_deliver",
        tracking_number: incoming.tracking_number || row?.tracking_number || row?.posting_number || row?.order_number || ""
      };
      const nextTabKey = orderTabKey(updatedRow);
      if (previousTabKey !== nextTabKey) {
        countAdjustments[previousTabKey] = Number(countAdjustments[previousTabKey] || 0) - 1;
        countAdjustments[nextTabKey] = Number(countAdjustments[nextTabKey] || 0) + 1;
      }

      if (isAwaitingPackagingView) {
        removedCount += 1;
        return rows;
      }

      rows.push(updatedRow);
      return rows;
    }, []);

    if (!removedCount && !updatedVisibleCount) return;

    for (const id of successfulIdSet) {
      selectedOrderIds.value.delete(id);
    }

    const currentCounts = vm.meta?.counts || {};
    const nextCounts = { ...currentCounts };
    for (const [key, delta] of Object.entries(countAdjustments)) {
      if (!Object.prototype.hasOwnProperty.call(nextCounts, key)) continue;
      nextCounts[key] = Math.max(0, Number(nextCounts[key] || 0) + Number(delta || 0));
    }
    const nextTotal = isAwaitingPackagingView
      ? Math.max(0, Number(vm.meta?.total || 0) - removedCount)
      : Number(vm.meta?.total || 0);

    patch({
      rows: nextRows,
      statusTabs: buildStatusTabs(nextCounts, nextTotal),
      meta: {
        total: nextTotal,
        counts: nextCounts
      }
    });
  }

  async function runOrderSync(url, body, messages) {
    if (vm.syncRunning) {
      ElMessage.warning("当前已有订单同步任务在执行");
      return null;
    }
    vm.syncRunning = true;
    vm.syncStatus = messages.running;
    const controller = new AbortController();
    orderSyncAbort.value = controller;
    orderSyncCancelReason.value = "";
    const timeout = window.setTimeout(() => {
      orderSyncCancelReason.value = "timeout";
      controller.abort();
    }, 5 * 60 * 1000);
    try {
      const result = await apiClient.post(url, body, { signal: controller.signal });
      vm.syncStatus = messages.refreshing;
      await loadOrders({ includeCounts: true });
      vm.syncStatus = messages.success(result);
      ElMessage.success(messages.successToast(result));
      return result;
    } catch (error) {
      if (error?.name === "AbortError") {
        vm.syncStatus = orderSyncCancelReason.value === "timeout"
          ? "本次同步超过 5 分钟，已自动停止。建议缩小时间范围后重试。"
          : "已取消本次订单同步。";
        ElMessage.warning(vm.syncStatus);
        return null;
      }
      vm.syncStatus = `${messages.failurePrefix}${error.message || "未知错误"}`;
      ElMessage.error(vm.syncStatus);
      throw error;
    } finally {
      window.clearTimeout(timeout);
      finishOrderSync();
    }
  }

  async function runPrepareOrders(orderIds = []) {
    const ids = Array.isArray(orderIds) ? orderIds.map(Number).filter(Boolean) : [];
    if (!ids.length) {
      ElMessage.warning("请先选择订单");
      return null;
    }
    try {
      const result = await bulkPrepareOrders(ids);
      applyPreparedOrdersLocally(ids, result);
      const alreadyShippedCount = Number(result?.already_shipped_count || 0);
      if (alreadyShippedCount > 0) {
        const normalCount = Math.max(0, ids.length - alreadyShippedCount);
        if (normalCount > 0) {
          ElMessage.success(`已处理 ${ids.length} 个订单，其中 ${alreadyShippedCount} 个订单已在其他系统备货，状态已刷新`);
        } else {
          ElMessage.success(alreadyShippedCount > 1 ? `已有 ${alreadyShippedCount} 个订单在其他系统完成备货，状态已刷新` : "订单已在其他系统完成备货，状态已刷新");
        }
      } else {
        ElMessage.success(ids.length > 1 ? `已提交 ${ids.length} 个订单备货` : "备货完成，订单已进入等待发货");
      }
      return result;
    } catch (error) {
      ElMessage.error(friendlyPrepareError(error));
      return null;
    }
  }

  async function runPrintOrders(orderIds = [], options = {}) {
    const ids = Array.isArray(orderIds) ? orderIds.map(Number).filter(Boolean) : [];
    if (!ids.length) {
      ElMessage.warning("请选择需要打印的订单");
      return null;
    }
    try {
      const result = await bulkPrintOrders(ids, options);
      await loadOrders({ includeCounts: true });
      if (result?.cancelled) {
        ElMessage.info("已取消确认，订单未标记为已打印");
        return result;
      }
      const failures = Array.isArray(result?.failures) ? result.failures : [];
      if (failures.length) {
        const failedText = failures
          .map((item) => item.posting_number || item.id)
          .filter(Boolean)
          .slice(0, 3)
          .join("、");
        ElMessage.warning(`已生成 ${result?.count || 0} 个面单，${failures.length} 个失败：${failedText}${failures.length > 3 ? "..." : ""}`);
      } else {
        ElMessage.success(ids.length > 1 ? `已生成 ${ids.length} 个订单面单` : "面单已生成");
      }
      return result;
    } catch (error) {
      ElMessage.error(`打印失败：${error?.message || "未知错误"}`);
      return null;
    }
  }

  async function loadLogisticsOptions({ force = false } = {}) {
    if (!force && logisticsOptionsCache.rows.length && Date.now() - logisticsOptionsCache.timestamp < LOGISTICS_OPTIONS_CACHE_TTL_MS) {
      patch({ logisticsMethodOptions: logisticsOptionsCache.rows });
      return logisticsOptionsCache.rows;
    }
    if (logisticsOptionsPromise.value) return logisticsOptionsPromise.value;

    logisticsOptionsAbort.value?.abort();
    const controller = new AbortController();
    logisticsOptionsAbort.value = controller;
    const filtersSnapshot = { ...vm.filters, logisticsMethod: "all" };
    const params = buildOrdersParams(filtersSnapshot, {
      includeRows: "0",
      includeCounts: "0",
      includeLogisticsOptions: "1"
    });

    logisticsOptionsPromise.value = apiClient
      .get(`/api/orders?${params.toString()}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return vm.logisticsMethodOptions;
        const rows = Array.isArray(result?.logisticsMethodOptions) && result.logisticsMethodOptions.length > 1
          ? result.logisticsMethodOptions
          : DEFAULT_LOGISTICS_METHOD_OPTIONS;
        logisticsOptionsCache = {
          rows,
          timestamp: Date.now()
        };
        patch({ logisticsMethodOptions: rows });
        return rows;
      })
      .catch((error) => {
        if (error?.name === "AbortError") return vm.logisticsMethodOptions;
        console.warn("loadLogisticsOptions failed", error);
        return vm.logisticsMethodOptions;
      })
      .finally(() => {
        if (logisticsOptionsAbort.value === controller) {
          logisticsOptionsAbort.value = null;
        }
        logisticsOptionsPromise.value = null;
      });

    return logisticsOptionsPromise.value;
  }

  function selectedIdsInCurrentRowOrder() {
    const selected = selectedOrderIds.value instanceof Set ? selectedOrderIds.value : new Set();
    const selectedIds = new Set([...selected].map(Number).filter(Boolean));
    const ordered = (vm.rows || [])
      .map((row) => Number(row.id))
      .filter((id) => id && selectedIds.has(id));
    const visible = new Set(ordered);
    const hidden = [...selectedIds].filter((id) => !visible.has(id));
    return [...ordered, ...hidden];
  }

  return {
    vm,
    loading,
    selectedOrderIds,
    totalPages,
    totalLabel,
    activeStatusLabel,
    patch,
    loadOrders,
    loadLogisticsOptions,
    submitFilters: async (nextFilters = null) => {
      if (nextFilters && typeof nextFilters === "object") {
        vm.filters = {
          ...vm.filters,
          ...nextFilters
        };
      }
      await submitOrderFilters(vm.filters);
      await loadOrders({ includeCounts: true });
    },
    changeStatus: (status) => {
      vm.filters = {
        ...vm.filters,
        status,
        page: 1,
        markFilter: "all",
        printView: "all",
        printFilter: "all",
        sortMode: "ordered"
      };
      return Promise.resolve(changeOrderStatus(status)).then(loadOrders);
    },
    changePrintView: (view) => {
      const nextView = vm.filters.printView === view ? "all" : view;
      const normalizedPrint = normalizePrintState({ printView: nextView });
      vm.filters = {
        ...vm.filters,
        printView: normalizedPrint.printView,
        printFilter: normalizedPrint.printFilter,
        sortMode: normalizedPrint.sortMode,
        markFilter: "all",
        page: 1
      };
      return Promise.resolve(changeOrderPrintView(nextView)).then(loadOrders);
    },
    changeMarkFilter: (value) => {
      vm.filters = {
        ...vm.filters,
        markFilter: vm.filters.markFilter === value ? "all" : value,
        printView: "all",
        printFilter: "all",
        sortMode: "ordered",
        page: 1
      };
      return Promise.resolve(changeOrderMarkFilter(value)).then(loadOrders);
    },
    changePageSize: async (pageSize) => {
      vm.filters = { ...vm.filters, pageSize, page: 1 };
      await changeOrderPageSize(pageSize);
      await loadOrders();
    },
    changePage: async (page) => {
      const nextPageNumber = Math.min(totalPages.value, Math.max(1, Number(page || 1)));
      vm.filters = { ...vm.filters, page: nextPageNumber };
      await loadOrders();
    },
    prevPage: async () => {
      vm.filters = { ...vm.filters, page: Math.max(1, Number(vm.filters.page || 1) - 1) };
      await prevOrderPage();
      await loadOrders();
    },
    nextPage: async () => {
      vm.filters = { ...vm.filters, page: Number(vm.filters.page || 1) + 1 };
      await nextOrderPage();
      await loadOrders();
    },
    syncRecent: async () => {
      const body = { from_latest: true, fallback_days: 7, overlap_minutes: 15 };
      if (vm.filters.shopId && vm.filters.shopId !== "all") body.shop_id = vm.filters.shopId;
      return runOrderSync("/api/sync/ozon/incremental", body, {
        running: "正在从 Ozon 拉取本地最新订单之后的新订单，请勿重复点击。",
        refreshing: "拉取完成，正在刷新订单列表...",
        success: (result) => `新订单拉取完成：拉取 ${result?.fetched || 0} 单，新增 ${result?.inserted || 0} 单，更新 ${result?.updated || 0} 单。`,
        successToast: (result) => `已拉取 ${result?.fetched || 0} 单新订单`,
        failurePrefix: "拉取新订单失败："
      });
    },
    syncAll: async () => {
      const body = {
        from: vm.filters.dateFrom || "",
        to: vm.filters.dateTo || ""
      };
      if (vm.filters.shopId && vm.filters.shopId !== "all") body.shop_id = vm.filters.shopId;
      return runOrderSync("/api/sync/ozon", body, {
        running: `正在同步 ${vm.filters.dateFrom || "开始日期"} 到 ${vm.filters.dateTo || "结束日期"} 的订单，请勿重复点击。`,
        refreshing: "同步完成，正在刷新订单列表...",
        success: (result) => `当前范围同步完成：拉取 ${result?.fetched || 0} 单，新增 ${result?.inserted || 0} 单，更新 ${result?.updated || 0} 单。`,
        successToast: (result) => `已同步 ${result?.fetched || 0} 单订单`,
        failurePrefix: "同步当前范围失败："
      });
    },
    cancelSync: () => {
      if (!orderSyncAbort.value) {
        ElMessage.warning("当前没有正在执行的订单同步任务");
        return null;
      }
      orderSyncCancelReason.value = "user";
      vm.syncStatus = "正在取消本次订单同步，请稍候...";
      orderSyncAbort.value.abort();
      return null;
    },
    bulkPrint: (orderIds = [], options = {}) => runPrintOrders(orderIds, options),
    bulkPrepare: (orderIds = []) => runPrepareOrders(orderIds),
    openQualityRules: () => openQualityRules(),
    saveQualityRules: (payload) => saveQualityRules(payload),
    resetRecentDates: () => resetRecentDates(),
    handleMoreAction: async (action) => {
      if (action === "recalculate-profit") return apiClient.post("/api/orders/recalculate-profits", {});
      if (action === "print-selected") return runPrintOrders(selectedIdsInCurrentRowOrder());
      if (action === "prepare-selected") return runPrepareOrders(selectedIdsInCurrentRowOrder());
      return handleMoreOrderAction(action);
    },
    fetchOrderDetail: (orderId) => fetchOrderDetail(orderId),
    openOrderProfit: (orderId) => openOrderProfit(orderId),
    prepareSingleOrder: (orderId) => runPrepareOrders([orderId]),
    previewOrderProcurement: (orderId) => previewOrderProcurement(orderId),
    createOrderProcurementRequests: (orderId, payload = {}) => createOrderProcurementRequests(orderId, payload),
    printSingleOrder: (orderId) => runPrintOrders([orderId]),
    recalculateOrderProfit: (orderId) => recalculateOrderProfit(orderId),
    saveOrderMark: (orderId, markType) => saveOrderMark(orderId, markType),
    openBindProduct: (onlineId) => openBindProduct(onlineId),
    openBindProductFromOrder: (orderId, sku) => openBindProductFromOrder(orderId, sku),
    openCreateProduct: (onlineId, orderId, sku) => openCreateProduct(onlineId, orderId, sku),
    openCreateProductFromOrder: (orderId, sku) => openCreateProductFromOrder(orderId, sku),
    jumpToStockProduct: (productId) => jumpToStockProduct(productId),
    openProcurement: (productId) => openProcurement(productId),
    loadStatusTabPreference,
    saveStatusTabPreference,
    defaultStatusTabOrder: DEFAULT_STATUS_TAB_ORDER,
    statusTabOrder,
    defaultFrom,
    defaultTo
  };
}
