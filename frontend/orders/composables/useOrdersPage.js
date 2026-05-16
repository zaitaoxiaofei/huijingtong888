import { computed, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../admin/utils/api.js";
import {
  bulkPrepareOrders,
  bulkPrintOrders,
  changeOrderMarkFilter,
  changeOrderPageSize,
  changeOrderPrintView,
  changeOrderStatus,
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
  prevOrderPage,
  printSingleOrder,
  recalculateOrderProfit,
  resetRecentDates,
  saveOrderMark,
  saveQualityRules,
  submitOrderFilters,
  nextOrderPage
} from "../services/orders-service.js";

const STATUS_TABS = [
  { value: "all", label: "全部订单" },
  { value: "awaiting_packaging", label: "等待备货" },
  { value: "awaiting_deliver", label: "等待发货" },
  { value: "delivering", label: "运输中" },
  { value: "dispute", label: "有争议" },
  { value: "delivered", label: "已签收" },
  { value: "cancelled", label: "已取消" },
  { value: "unbound", label: "待绑定库存" }
];

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

function createDefaultFilters(defaultFrom, defaultTo) {
  return {
    page: 1,
    pageSize: 30,
    status: "all",
    shopId: "all",
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
    : printView === "unprinted" || printView === "inventory"
      ? "unprinted"
      : "all";
  const sortMode = printView === "inventory" ? "inventory" : "ordered";
  return { printView, printFilter, sortMode };
}

function friendlyPrepareError(error) {
  const message = String(error?.message || error || "");
  const lower = message.toLowerCase();
  if (lower.includes("awaiting_deliver") || lower.includes("already") || lower.includes("not in process") || lower.includes("invalid status")) {
    return "备货失败：这个订单可能已经备货过了，请先同步订单刷新状态。";
  }
  if (lower.includes("fbp") || lower.includes("warehouse")) {
    return "备货失败：这个订单可能是 FBP 仓发订单，不需要在本地备货。";
  }
  return `备货失败：${message || "未知错误"}`;
}

export function useOrdersPage() {
  const loading = ref(false);
  const selectedOrderIds = ref(new Set());
  const orderSyncAbort = ref(null);
  const orderSyncCancelReason = ref("");
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const defaultFrom = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const vm = reactive({
    title: "我的订单",
    subtitle: "订单管理工作台",
    rows: [],
    shops: [],
    statusTabs: [],
    markOptions: [],
    printViews: [],
    moreActions: [],
    syncStatus: "",
    syncRunning: false,
    filters: createDefaultFilters(defaultFrom, defaultTo),
    meta: {
      total: 0,
      counts: {}
    }
  });

  const totalPages = computed(() => Math.max(1, Math.ceil((vm.meta.total || 0) / (vm.filters.pageSize || 30))));
  const totalLabel = computed(() => `${vm.meta.total || 0} 条订单`);
  const activeStatusLabel = computed(() => vm.statusTabs.find((item) => item.value === vm.filters.status)?.label || "全部订单");

  function patch(payload = {}) {
    const filters = {
      ...createDefaultFilters(defaultFrom, defaultTo),
      ...(payload.filters || {})
    };
    const normalizedPrint = normalizePrintState(filters);

    vm.title = String(payload.title || vm.title);
    vm.subtitle = String(payload.subtitle || vm.subtitle);
    vm.rows = Array.isArray(payload.rows) ? payload.rows : [];
    vm.shops = Array.isArray(payload.shops) ? payload.shops : [];
    vm.statusTabs = Array.isArray(payload.statusTabs) ? payload.statusTabs : [];
    vm.markOptions = Array.isArray(payload.markOptions) ? payload.markOptions : [];
    vm.printViews = Array.isArray(payload.printViews) ? payload.printViews : [];
    vm.moreActions = Array.isArray(payload.moreActions) ? payload.moreActions : [];
    vm.syncStatus = String(payload.syncStatus || "");
    vm.syncRunning = Boolean(payload.syncRunning);
    vm.filters = {
      page: Number(filters.page || 1),
      pageSize: Number(filters.pageSize || 30),
      status: String(filters.status || "all"),
      shopId: String(filters.shopId || "all"),
      dateFrom: String(filters.dateFrom || defaultFrom),
      dateTo: String(filters.dateTo || defaultTo),
      searchType: String(filters.searchType || "order"),
      searchQuery: String(filters.searchQuery || ""),
      markFilter: String(filters.markFilter || "all"),
      printView: normalizedPrint.printView,
      printFilter: normalizedPrint.printFilter,
      sortMode: normalizedPrint.sortMode
    };
    vm.meta = {
      total: Number(payload.meta?.total || vm.rows.length || 0),
      counts: payload.meta?.counts || {}
    };
  }

  async function loadOrders() {
    loading.value = true;
    try {
      const params = new URLSearchParams({
        paged: "1",
        page: String(vm.filters.page || 1),
        pageSize: String(vm.filters.pageSize || 30),
        status: vm.filters.status || "all",
        shopId: vm.filters.shopId || "all",
        dateFrom: vm.filters.dateFrom || "",
        dateTo: vm.filters.dateTo || "",
        searchType: vm.filters.searchType || "order",
        searchQuery: vm.filters.searchQuery || "",
        markFilter: vm.filters.markFilter || "all",
        printView: vm.filters.printView || "all",
        printFilter: vm.filters.printFilter || "all",
        sortMode: vm.filters.sortMode || "ordered"
      });
      const [result, shops] = await Promise.all([
        apiClient.get(`/api/orders?${params.toString()}`),
        apiClient.get("/api/shops")
      ]);

      patch({
        rows: Array.isArray(result.rows) ? result.rows : [],
        shops: Array.isArray(shops) ? shops : [],
        statusTabs: STATUS_TABS.map((item) => ({
          ...item,
          count: Number(result.counts?.[item.value] || (item.value === "all" ? result.total || 0 : 0))
        })),
        markOptions: MARK_OPTIONS,
        printViews: PRINT_VIEWS,
        moreActions: MORE_ACTIONS,
        syncStatus: "",
        syncRunning: false,
        filters: {
          ...vm.filters,
          page: Number(result.page || vm.filters.page || 1),
          pageSize: Number(result.pageSize || vm.filters.pageSize || 30)
        },
        meta: { total: Number(result.total || 0), counts: result.counts || {} }
      });
    } catch (error) {
      if (error?.status === 401) ElMessage.error("登录已失效，请重新登录");
      else ElMessage.error(error?.message || "加载订单失败");
      throw error;
    } finally {
      loading.value = false;
    }
  }

  function finishOrderSync() {
    orderSyncAbort.value = null;
    orderSyncCancelReason.value = "";
    vm.syncRunning = false;
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
      await loadOrders();
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
      await loadOrders();
      ElMessage.success(ids.length > 1 ? `已提交 ${ids.length} 个订单备货` : "备货完成，订单已进入等待发货");
      return result;
    } catch (error) {
      ElMessage.error(friendlyPrepareError(error));
      throw error;
    }
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
    submitFilters: async () => {
      await submitOrderFilters(vm.filters);
      await loadOrders();
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
    syncRecent: async () => (
      runOrderSync("/api/sync/ozon/incremental", { recent_days: 7 }, {
        running: "正在从 Ozon 拉取最近 7 天的新订单，请勿重复点击。",
        refreshing: "拉取完成，正在刷新订单列表...",
        success: (result) => `最近 7 天订单同步完成：拉取 ${result?.fetched || 0} 单，新增 ${result?.inserted || 0} 单，更新 ${result?.updated || 0} 单。`,
        successToast: (result) => `已同步 ${result?.fetched || 0} 单订单`,
        failurePrefix: "拉取新订单失败："
      })
    ),
    syncAll: async () => {
      const body = {
        from: vm.filters.dateFrom || "",
        to: vm.filters.dateTo || ""
      };
      if (vm.filters.shopId && vm.filters.shopId !== "all") body.shop_id = vm.filters.shopId;
      return runOrderSync("/api/sync/ozon", body, {
        running: `正在同步 ${vm.filters.dateFrom || "开始日期"} 到 ${vm.filters.dateTo || "结束日期"} 的订单，请勿重复点击。`,
        refreshing: "同步完成，正在刷新订单列表...",
        success: (result) => `订单同步完成：拉取 ${result?.fetched || 0} 单，新增 ${result?.inserted || 0} 单，更新 ${result?.updated || 0} 单。`,
        successToast: (result) => `已同步 ${result?.fetched || 0} 单订单`,
        failurePrefix: "同步订单失败："
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
    bulkPrint: (orderIds = []) => bulkPrintOrders(orderIds),
    bulkPrepare: (orderIds = []) => runPrepareOrders(orderIds),
    openQualityRules: () => openQualityRules(),
    saveQualityRules: (payload) => saveQualityRules(payload),
    resetRecentDates: () => resetRecentDates(),
    handleMoreAction: async (action) => {
      if (action === "recalculate-profit") return apiClient.post("/api/orders/recalculate-profits", {});
      if (action === "print-selected") return bulkPrintOrders([...selectedOrderIds.value]);
      if (action === "prepare-selected") return runPrepareOrders([...selectedOrderIds.value]);
      return handleMoreOrderAction(action);
    },
    fetchOrderDetail: (orderId) => fetchOrderDetail(orderId),
    openOrderProfit: (orderId) => openOrderProfit(orderId),
    prepareSingleOrder: (orderId) => runPrepareOrders([orderId]),
    printSingleOrder: (orderId) => printSingleOrder(orderId),
    recalculateOrderProfit: (orderId) => recalculateOrderProfit(orderId),
    saveOrderMark: (orderId, markType) => saveOrderMark(orderId, markType),
    openBindProduct: (onlineId) => openBindProduct(onlineId),
    openBindProductFromOrder: (orderId, sku) => openBindProductFromOrder(orderId, sku),
    openCreateProduct: (onlineId, orderId, sku) => openCreateProduct(onlineId, orderId, sku),
    openCreateProductFromOrder: (orderId, sku) => openCreateProductFromOrder(orderId, sku),
    jumpToStockProduct: (productId) => jumpToStockProduct(productId),
    openProcurement: (productId) => openProcurement(productId),
    defaultFrom,
    defaultTo
  };
}
