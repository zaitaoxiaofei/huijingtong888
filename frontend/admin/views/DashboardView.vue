<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  Flame,
  PackageCheck,
  RefreshCw,
  Sparkles,
  Target,
  Truck,
  Zap
} from "lucide-vue-next";
import { apiClient } from "../utils/api";
import { openAiProductMaterialOptimizerWindow, openAiVariantLabWindow } from "../utils/ai-variant-lab-window";
import { shanghaiDateKey } from "../utils/shanghai-date.js";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const refreshing = ref(false);
const snapshotBuilding = ref(false);
const hasDashboardLoaded = ref(false);
const overviewPanelsLoading = ref(false);
const shopProductLimits = ref([]);
const topSkus = ref([]);
const selectedDate = ref(/^\d{4}-\d{2}-\d{2}$/.test(String(route.query.date || "")) ? String(route.query.date) : shanghaiDateKey());
let dashboardSnapshotRefreshTimer = null;
let dashboardSnapshotRefreshAttempts = 0;
let dashboardRequestSeq = 0;
const DASHBOARD_SESSION_CACHE_PREFIX = "erp:dashboard:last-success:";

const dashboard = ref({
  summary: {},
  commerce: {
    today: {},
    yesterday: {},
    advertising: { today: {}, yesterday: {}, month: {} }
  },
  alerts: {
    fbp: [],
    fbs: [],
    procurement: []
  }
});

const summary = computed(() => dashboard.value.summary || {});
const commerce = computed(() => dashboard.value.commerce || {});
const today = computed(() => commerce.value.today || {});
const yesterday = computed(() => commerce.value.yesterday || {});
const adToday = computed(() => commerce.value.advertising?.today || {});
const adYesterday = computed(() => commerce.value.advertising?.yesterday || {});
const adMonth = computed(() => commerce.value.advertising?.month || {});
const profitTrend = computed(() => commerce.value.profit_trend || {});
const aftersalesLoss = computed(() => summary.value.aftersales_loss || {});
const monthShippingCost = computed(() => summary.value.month_shipping_cost || {});
const monthOrderOutcomes = computed(() => summary.value.month_order_outcomes || {});
const fbpOpportunitySummary = computed(() => summary.value.fbp_opportunities || {});
const commerceShops = computed(() => Array.isArray(commerce.value.shops) ? commerce.value.shops : []);
const adShops = computed(() => Array.isArray(adToday.value.shops) ? adToday.value.shops : []);
const adMonthShops = computed(() => Array.isArray(adMonth.value.shops) ? adMonth.value.shops : []);
const fbpAlerts = computed(() => Array.isArray(dashboard.value.alerts?.fbp) ? dashboard.value.alerts.fbp : []);
const fbpShortageAlerts = computed(() => fbpAlerts.value.filter((item) => ["out_of_stock", "within_7_days", "within_15_days"].includes(item.alert_type)));
const fbpOutOfStockCount = computed(() => fbpAlerts.value.filter((item) => item.alert_type === "out_of_stock").length);
const fbpWithin7Count = computed(() => fbpAlerts.value.filter((item) => item.alert_type === "within_7_days").length);
const fbpWithin15Count = computed(() => fbpAlerts.value.filter((item) => item.alert_type === "within_15_days").length);
const procurementRows = computed(() => Array.isArray(dashboard.value.alerts?.procurement) ? dashboard.value.alerts.procurement : []);
const dashboardUpdating = computed(() => (refreshing.value || snapshotBuilding.value) && hasDashboardLoaded.value);
const todayDateKey = computed(() => shanghaiDateKey());
const isTodaySelected = computed(() => selectedDate.value === todayDateKey.value);
const availableLimitRows = computed(() => shopProductLimits.value.map((row) => {
  const total = row?.limit?.total || {};
  const dailyCreate = row?.limit?.daily_create || {};
  return {
    shop_id: row.shop_id,
    shop_name: row.shop_name || `店铺 ${row.shop_id || ""}`.trim(),
    total_available: Number(total.remaining || 0),
    total_limit: Number(total.limit || 0),
    today_available: Number(dailyCreate.remaining || 0),
    today_limit: Number(dailyCreate.limit || 0),
    today_usage: Number(dailyCreate.usage || 0),
    ok: row.ok !== false && dailyCreate.remaining !== null && dailyCreate.remaining !== undefined
  };
}));
const maxAvailableLimit = computed(() => Math.max(1, ...availableLimitRows.value.map((row) => row.today_available)));
const selectedDateText = computed(() => {
  const [year, month, day] = selectedDate.value.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
});

function clearDashboardSnapshotReload() {
  if (!dashboardSnapshotRefreshTimer) return;
  window.clearTimeout(dashboardSnapshotRefreshTimer);
  dashboardSnapshotRefreshTimer = null;
}

function readDashboardSessionCache(dateKey) {
  try {
    const cached = JSON.parse(window.sessionStorage?.getItem(`${DASHBOARD_SESSION_CACHE_PREFIX}${dateKey}`) || "null");
    return cached && typeof cached === "object" ? cached : null;
  } catch {
    return null;
  }
}

function writeDashboardSessionCache(dateKey, payload) {
  try {
    window.sessionStorage?.setItem(`${DASHBOARD_SESSION_CACHE_PREFIX}${dateKey}`, JSON.stringify(payload));
  } catch {
    // Storage may be unavailable in privacy mode; live requests still work.
  }
}

function waitForDashboardRetry(delay) {
  return new Promise((resolve) => window.setTimeout(resolve, delay));
}

async function getDashboardWithRetry(url, options = {}, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await apiClient.get(url, {
        ...options,
        dedupe: false
      });
    } catch (error) {
      lastError = error;
      const transientNetworkError = error instanceof TypeError || /fetch|network|connection|socket/i.test(String(error?.message || ""));
      if (!transientNetworkError || attempt >= retries) throw error;
      await waitForDashboardRetry(350 * (attempt + 1));
    }
  }
  throw lastError;
}

function mergeDashboardPayload(payload) {
  dashboard.value = {
    ...dashboard.value,
    ...(payload || {}),
    summary: {
      ...dashboard.value.summary,
      ...(payload?.summary || {})
    },
    commerce: {
      ...dashboard.value.commerce,
      ...(payload?.commerce || {}),
      advertising: {
        ...dashboard.value.commerce.advertising,
        ...(payload?.commerce?.advertising || {})
      }
    },
    alerts: {
      ...dashboard.value.alerts,
      ...(payload?.alerts || {})
    }
  };
}

async function applyDashboardDate(value) {
  const next = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || next > todayDateKey.value) return;
  selectedDate.value = next;
  refreshing.value = hasDashboardLoaded.value;
  snapshotBuilding.value = false;
  dashboard.value = {
    summary: {},
    commerce: { today: {}, yesterday: {}, advertising: { today: {}, yesterday: {}, month: {} } },
    alerts: { fbp: [], fbs: [], procurement: [] }
  };
  topSkus.value = [];
  clearDashboardSnapshotReload();
  dashboardSnapshotRefreshAttempts = 0;
  await router.replace({ path: route.path, query: { ...route.query, date: next } });
  if (selectedDate.value !== next) return;
  await loadDashboard({ dateKey: next });
}

function disableFutureDashboardDate(value) {
  return shanghaiDateKey(value) > todayDateKey.value;
}

function shiftDashboardDate(offset) {
  const cursor = new Date(`${selectedDate.value}T12:00:00+08:00`);
  cursor.setUTCDate(cursor.getUTCDate() + Number(offset || 0));
  const next = shanghaiDateKey(cursor);
  if (!next || next > todayDateKey.value) return;
  applyDashboardDate(next);
}

function resetDashboardDate() {
  if (isTodaySelected.value) return;
  applyDashboardDate(todayDateKey.value);
}

const urgentCount = computed(() => Number(summary.value.urgent_count || 0));
const stockWarningCount = computed(() => Number(summary.value.warning_count || 0));
const fbpShortageCount = computed(() => fbpShortageAlerts.value.length);
const procurementCount = computed(() => Number(summary.value.procurement_count || 0));
const firstStockAlert = computed(() => fbpAlerts.value[0] || {});
const firstProcurement = computed(() => procurementRows.value[0] || {});

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function numberText(value) {
  return new Intl.NumberFormat("zh-CN").format(Math.round(Number(value || 0)));
}

function moneyText(value) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function metricMoney(value) {
  return hasValue(value) ? `¥ ${moneyText(value)}` : "待接入";
}

function metricNumber(value, suffix = "") {
  return hasValue(value) ? `${numberText(value)}${suffix}` : "待接入";
}

function decimalText(value, digits = 2) {
  return hasValue(value) ? Number(value || 0).toFixed(digits) : "待接入";
}

function percentText(value) {
  return hasValue(value) ? `${(Number(value || 0) * 100).toFixed(1)}%` : "待接入";
}

function ratioText(value) {
  return hasValue(value) ? `${Number(value || 0).toFixed(2)}x` : "待接入";
}

function limitBarWidth(value) {
  return `${Math.max(3, (Number(value || 0) / maxAvailableLimit.value) * 100)}%`;
}

function skuImageList(row) {
  return row?.image_url ? [row.image_url] : [];
}

function firstMetricNumber(...values) {
  const matched = values.find((value) => hasValue(value));
  return hasValue(matched) ? Number(matched || 0) : null;
}

function shortTimeText(value) {
  if (!hasValue(value)) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function hoursSince(value) {
  if (!hasValue(value)) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, (Date.now() - time) / 3600000);
}

function delta(current, previous) {
  const now = Number(current || 0);
  const before = Number(previous || 0);
  if (!before && !now) return { text: "持平", direction: "flat" };
  if (!before) return { text: "+100%", direction: "up" };
  const rate = (now - before) / Math.abs(before);
  return {
    text: `${rate >= 0 ? "+" : ""}${(rate * 100).toFixed(1)}%`,
    direction: rate >= 0 ? "up" : "down"
  };
}

function profitTrendDelta(value, baseline = today.value.profit, label = "较今日") {
  if (!hasValue(value) || !hasValue(baseline)) return { text: `${label}待接入`, direction: "flat" };
  const result = delta(value, baseline);
  const rateText = result.text.replace(/^\+/, "");
  return {
    text: result.direction === "flat" ? `${label} 0.0%` : `${label} ${result.direction === "up" ? "↑" : "↓"}${rateText}`,
    direction: result.direction
  };
}

function profitTrendRow(label, value, comparison = profitTrendDelta(value)) {
  return {
    label,
    value: metricMoney(value),
    delta: comparison.text,
    direction: comparison.direction
  };
}

function signalWidth(value, max, min = 8) {
  if (!hasValue(value)) return 12;
  return Math.min(100, Math.max(min, (Number(value || 0) / max) * 100));
}

function open(path, query = {}) {
  if (path === "/inventory/alerts") {
    router.push({ path: "/inventory/fbp", query: fbpAlertQuery(null, query.alertType || query.alert_type || "all") });
    return;
  }
  if (path === "/asset-variant-center/create" || path === "/asset-variant-center/wizard" || path === "/ai-variant-lab") {
    openAiVariantLabWindow(query);
    return;
  }
  if (path === "/ai-product-material-optimizer") {
    openAiProductMaterialOptimizerWindow(query);
    return;
  }
  router.push({ path, query });
}

function fbpAlertQuery(row = firstStockAlert.value, alertType = "all") {
  const queryText = row ? String(row?.ozon_sku || row?.offer_id || row?.product_name || row?.inventory_id || "").trim() : "";
  return {
    ...(queryText ? { query: queryText } : {}),
    ...(row?.shop_id ? { shopId: String(row.shop_id) } : {}),
    ...(alertType && alertType !== "all" ? { alertType } : {}),
    sortKey: "fbp_available",
    sortDir: "asc"
  };
}

function fbpRiskRows() {
  return [
    { label: "严重断货", value: metricNumber(fbpOutOfStockCount.value, "个"), alertType: "out_of_stock" },
    { label: "即将断货", value: metricNumber(fbpWithin7Count.value, "个"), alertType: "within_7_days" },
    { label: "15天风险", value: metricNumber(fbpWithin15Count.value, "个"), alertType: "within_15_days" },
    {
      label: "推荐备货FBP",
      value: metricNumber(fbpOpportunitySummary.value.total, "个"),
      route: "/inventory/fbp-opportunities",
      query: {}
    }
  ];
}

function aftersalesQuery(bucket = "all", openDetail = false) {
  const period = billingPeriodQuery();
  const query = {
    ...period,
    tab: "aftersales",
    from: aftersalesLoss.value.from || commerce.value.date_key || "",
    to: aftersalesLoss.value.to || commerce.value.date_key || "",
    shopId: "all",
    bucket
  };
  if (openDetail && bucket !== "all") query.detailBucket = bucket;
  return query;
}

function todayAftersalesQuery(bucket) {
  const dateKey = commerce.value.date_key || "";
  return {
    ...billingPeriodQuery(),
    tab: "aftersales",
    from: dateKey,
    to: dateKey,
    shopId: "all",
    bucket,
    detailBucket: bucket
  };
}

function billingPeriodQuery(extra = {}) {
  const [year, month] = selectedDate.value.split("-");
  return { year, month: String(Number(month)), ...extra };
}

function aftersalesLossRows() {
  return [
    {
      label: "本月总损失",
      value: metricMoney(aftersalesLoss.value.total_estimated_loss_cny),
      route: "/profit/monthly-billing",
      query: aftersalesQuery("all")
    },
    {
      label: "拒收/未取",
      value: metricMoney(aftersalesLoss.value.rejected_unclaimed_loss_cny),
      route: "/profit/monthly-billing",
      query: aftersalesQuery("rejected_unclaimed", true)
    },
    {
      label: "不合适/错发/破损",
      value: metricMoney(aftersalesLoss.value.unsuitable_wrong_damaged_loss_cny),
      route: "/profit/monthly-billing",
      query: aftersalesQuery("unsuitable_wrong_damaged", true)
    },
    {
      label: "质量问题",
      value: metricMoney(aftersalesLoss.value.quality_issue_loss_cny),
      route: "/profit/monthly-billing",
      query: aftersalesQuery("quality_issue", true)
    }
  ];
}

function shopBreakdown(source, valueKey, formatter, suffixLabel = "") {
  const rows = (source || []).map((item) => ({
    shop_name: item.shop_name || `店铺 ${item.shop_id || ""}`.trim(),
    value: item[valueKey],
    text: formatter(item[valueKey])
  }));
  if (!rows.length) return [{ shop_name: "店铺明细", text: suffixLabel || "暂无数据" }];
  return rows;
}

function shopOutcomeBreakdown(source, outcomeKey, emptyLabel = "暂无数据") {
  const quantityKey = `${outcomeKey}_quantity`;
  const ordersKey = `${outcomeKey}_orders`;
  const revenueKey = `${outcomeKey}_revenue`;
  const rows = (source || [])
    .map((item) => {
      const quantity = Number(item?.[quantityKey] || 0);
      const orders = Number(item?.[ordersKey] || 0);
      const revenue = Number(item?.[revenueKey] || 0);
      return {
        shop_name: item.shop_name || `店铺 ${item.shop_id || ""}`.trim(),
        quantity,
        orders,
        revenue,
        text: `${metricNumber(quantity, " 件")} / ${metricNumber(orders, " 单")} / ${metricMoney(revenue)}`
      };
    })
    .sort((a, b) => (
      (b.quantity - a.quantity) ||
      (b.orders - a.orders) ||
      (b.revenue - a.revenue)
    ));
  if (!rows.length) return [{ shop_name: "店铺明细", text: emptyLabel }];
  return rows;
}

function todaySalesBreakdown() {
  return [
    { shop_name: "总销售额", text: metricMoney(today.value.total_revenue ?? today.value.revenue) },
    { shop_name: "有效销售额", text: metricMoney(today.value.effective_revenue ?? today.value.revenue) },
    { shop_name: "取消销售额", text: metricMoney(today.value.cancelled_revenue) },
    { shop_name: "退货/拒收销售额", text: metricMoney(today.value.return_revenue) }
  ];
}

function todayOrdersBreakdown() {
  const total = Number(today.value.order_count || 0);
  const effective = Number(today.value.effective_orders || 0);
  const cancelled = Number(today.value.cancelled_orders || 0);
  const returned = Number(today.value.return_orders || 0);
  const other = Math.max(0, total - effective - cancelled - returned);
  return [
    { shop_name: "总订单数", text: metricNumber(total, " 单") },
    { shop_name: "有效订单数", text: metricNumber(effective, " 单") },
    { shop_name: "取消订单数", text: metricNumber(cancelled, " 单") },
    { shop_name: "退货/拒收订单数", text: metricNumber(returned, " 单") },
    { shop_name: "其他/进行中", text: metricNumber(other, " 单") }
  ];
}

function adMetricRow(label, source) {
  return {
    label,
    revenue: metricMoney(source?.revenue_cny),
    spend: metricMoney(source?.spend_cny),
    roi: decimalText(source?.roi),
    clicks: metricNumber(source?.clicks),
    conversion: percentText(source?.conversion_rate),
    orders: metricNumber(source?.orders)
  };
}

const adBreakdownTableRows = computed(() => {
  const rows = [adMetricRow("全部店铺", adToday.value)];
  adShops.value.forEach((shop) => {
    rows.push(adMetricRow(shop.shop_name || `店铺 ${shop.shop_id || ""}`.trim(), shop));
  });
  return rows;
});
const adMonthSpendBreakdownRows = computed(() => {
  const rows = [
    {
      label: "全部店铺",
      spend: metricMoney(adMonth.value.spend_cny),
      roi: decimalText(adMonth.value.roi),
      orders: metricNumber(adMonth.value.orders, " 单")
    }
  ];
  adMonthShops.value.forEach((shop) => {
    rows.push({
      label: shop.shop_name || `店铺 ${shop.shop_id || ""}`.trim(),
      spend: metricMoney(shop.spend_cny),
      roi: decimalText(shop.roi),
      orders: metricNumber(shop.orders, " 单")
    });
  });
  return rows;
});
const adMonthPendingDates = computed(() => Array.isArray(adMonth.value.pending_dates) ? adMonth.value.pending_dates : []);
const adMonthQuality = computed(() => {
  const pendingRows = Number(adMonth.value.pending_rows || 0);
  const pendingDateCount = Number(adMonth.value.pending_date_count || adMonthPendingDates.value.length || 0);
  if (pendingRows > 0) {
    return {
      text: `报表未齐 ${pendingDateCount}天/${pendingRows}行`,
      tone: "danger",
      detail: `Ozon广告报表仍有待返回行，当前展示为已返回值 ${metricMoney(adMonth.value.returned_spend_cny ?? adMonth.value.spend_cny)}，不可当最终月累计。`
    };
  }
  if (String(adMonth.value.to || "") === String(commerce.value.date_key || "")) {
    return {
      text: "含今日数据",
      tone: "warning",
      detail: "今日广告报表可能仍在沉淀，最终值以Ozon返回为准。"
    };
  }
  return {
    text: "报表完整",
    tone: "success",
    detail: "当前范围内未发现待返回广告报表行。"
  };
});
const adMonthSpendDisplay = computed(() => {
  const value = adMonth.value.returned_spend_cny ?? adMonth.value.spend_cny;
  return Number(adMonth.value.pending_rows || 0) > 0 ? `${metricMoney(value)}*` : metricMoney(value);
});
const adTooltipPopperOptions = {
  modifiers: [
    { name: "offset", options: { offset: [0, 8] } },
    { name: "flip", options: { fallbackPlacements: ["bottom", "top", "right", "left"] } },
    { name: "preventOverflow", options: { boundary: "viewport", padding: 12 } }
  ]
};

const profitDelta = computed(() => delta(today.value.profit, yesterday.value.profit));
const monthProfitDelta = computed(() => delta(profitTrend.value.month_total_profit, profitTrend.value.previous_month_total_profit));
const monthRevenueDelta = computed(() => delta(profitTrend.value.month_total_revenue, profitTrend.value.previous_month_total_revenue));
const monthEffectiveOrders = computed(() => firstMetricNumber(
  profitTrend.value.month_effective_orders,
  monthOrderOutcomes.value.effective_orders,
  monthShippingCost.value.order_count
));
const previousMonthEffectiveOrders = computed(() => firstMetricNumber(profitTrend.value.previous_month_effective_orders));
const monthCancelledOrders = computed(() => firstMetricNumber(profitTrend.value.month_cancelled_orders, monthOrderOutcomes.value.cancelled_orders));
const previousMonthCancelledOrders = computed(() => firstMetricNumber(profitTrend.value.previous_month_cancelled_orders));
const monthCancelledQuantity = computed(() => firstMetricNumber(profitTrend.value.month_cancelled_quantity, monthOrderOutcomes.value.cancelled_quantity));
const monthReturnOrders = computed(() => firstMetricNumber(profitTrend.value.month_return_orders, monthOrderOutcomes.value.return_orders));
const previousMonthReturnOrders = computed(() => firstMetricNumber(profitTrend.value.previous_month_return_orders));
const monthReturnQuantity = computed(() => firstMetricNumber(profitTrend.value.month_return_quantity, monthOrderOutcomes.value.return_quantity));
const monthEffectiveOrderDelta = computed(() => delta(monthEffectiveOrders.value, previousMonthEffectiveOrders.value));
const monthCancelledOrderDelta = computed(() => delta(monthCancelledOrders.value, previousMonthCancelledOrders.value));
const monthReturnOrderDelta = computed(() => delta(monthReturnOrders.value, previousMonthReturnOrders.value));
const roiDelta = computed(() => delta(adToday.value.roi, adYesterday.value.roi));
const adSpendDelta = computed(() => delta(adToday.value.spend_cny, adYesterday.value.spend_cny));
const salesDelta = computed(() => delta(today.value.effective_revenue ?? today.value.revenue, yesterday.value.effective_revenue ?? yesterday.value.revenue));
const effectiveOrderDelta = computed(() => delta(today.value.effective_orders, yesterday.value.effective_orders));
const adCostJump = computed(() => Number(adToday.value.spend_cny || 0) > Number(adYesterday.value.spend_cny || 0) * 1.3);
const adDataFreshness = computed(() => {
  const syncedAt = adToday.value.last_synced_at || adToday.value.last_updated_at || "";
  const hours = hoursSince(syncedAt);
  const isTodayData = !commerce.value.advertising?.latest_date_key || commerce.value.advertising?.is_latest_today !== false;
  if (!hasValue(adToday.value.roi) && !hasValue(adToday.value.spend_cny)) {
    return { text: "广告数据待接入", direction: "down", tone: "danger", stale: true };
  }
  if (!isTodayData) {
    return { text: `非今日数据 ${adToday.value.date_key || commerce.value.advertising?.latest_date_key || ""}`.trim(), direction: "down", tone: "danger", stale: true };
  }
  if (hours === null) return { text: "同步时间未知", direction: "down", tone: "warning", stale: true };
  const timeText = shortTimeText(syncedAt);
  if (hours >= 3) return { text: `${timeText} 同步，数据延迟`, direction: "down", tone: "danger", stale: true };
  if (hours >= 1.5) return { text: `${timeText} 同步，可能延迟`, direction: "flat", tone: "warning", stale: true };
  return { text: `${timeText} 已同步`, direction: "up", tone: "success", stale: false };
});
const fbpInventoryQuantityText = computed(() => {
  if (!hasValue(summary.value.fbp_inventory_quantity)) return "FBP货值";
  return `FBP ${numberText(summary.value.fbp_inventory_quantity)}件`;
});
const monthShippingCostState = computed(() => {
  if (!hasValue(monthShippingCost.value.purchase_cost)) return "成本待接入";
  if (!hasValue(monthShippingCost.value.purchase_cost_ratio)) return "销售额待接入";
  return `采购占比 ${percentText(monthShippingCost.value.purchase_cost_ratio)}`;
});
const monthFreightCostState = computed(() => {
  if (!hasValue(monthShippingCost.value.shipping_cost)) return "运费待接入";
  if (!hasValue(monthShippingCost.value.shipping_cost_ratio)) return "销售额待接入";
  return `运费占比 ${percentText(monthShippingCost.value.shipping_cost_ratio)}`;
});
const monthPurchaseCostShops = computed(() => Array.isArray(monthShippingCost.value.shops) ? monthShippingCost.value.shops : []);
const monthPurchaseCostBreakdownRows = computed(() => {
  const rows = [
    {
      label: "全部店铺",
      revenue: metricMoney(monthShippingCost.value.revenue),
      purchaseCost: metricMoney(monthShippingCost.value.purchase_cost),
      ratio: percentText(monthShippingCost.value.purchase_cost_ratio),
      orders: metricNumber(monthShippingCost.value.order_count, " 单")
    }
  ];
  monthPurchaseCostShops.value.forEach((shop) => {
    rows.push({
      label: shop.shop_name || `店铺 ${shop.shop_id || ""}`.trim(),
      revenue: metricMoney(shop.revenue),
      purchaseCost: metricMoney(shop.purchase_cost),
      ratio: percentText(shop.purchase_cost_ratio),
      orders: metricNumber(shop.order_count, " 单")
    });
  });
  return rows;
});
const monthFreightCostBreakdownRows = computed(() => {
  const rows = [
    {
      label: "全部店铺",
      revenue: metricMoney(monthShippingCost.value.revenue),
      freightCost: metricMoney(monthShippingCost.value.shipping_cost),
      ratio: percentText(monthShippingCost.value.shipping_cost_ratio),
      orders: metricNumber(monthShippingCost.value.order_count, " 单")
    }
  ];
  monthPurchaseCostShops.value.forEach((shop) => {
    rows.push({
      label: shop.shop_name || `店铺 ${shop.shop_id || ""}`.trim(),
      revenue: metricMoney(shop.revenue),
      freightCost: metricMoney(shop.shipping_cost),
      ratio: percentText(shop.shipping_cost_ratio),
      orders: metricNumber(shop.order_count, " 单")
    });
  });
  return rows;
});
const fbpOpportunityText = computed(() => {
  const total = Number(fbpOpportunitySummary.value.total || 0);
  const qty = Number(fbpOpportunitySummary.value.suggested_total_qty || 0);
  return total ? `${numberText(total)} 个SKU / ${numberText(qty)}件` : "暂无推荐";
});

const profitState = computed(() => {
  const profit = Number(today.value.profit || 0);
  if (!hasValue(today.value.profit)) return "利润数据待接入";
  if (profit < 0) return "今日亏损";
  if (profit > 0) return "今日盈利";
  return "盈亏持平";
});

const roiState = computed(() => {
  const roi = Number(adToday.value.roi || 0);
  if (!hasValue(adToday.value.roi)) return "ROI待接入";
  if (roi >= 2) return "广告优秀";
  if (roi >= 1) return "广告健康";
  if (roi > 0) return "广告偏低";
  return "待观察";
});

const businessTone = computed(() => {
  if (Number(today.value.profit || 0) < 0 || (hasValue(adToday.value.roi) && Number(adToday.value.roi || 0) < 1)) return "danger";
  if (urgentCount.value || stockWarningCount.value > 0 || adCostJump.value) return "warning";
  return "success";
});

const operationReminder = computed(() => {
  const parts = [];
  if (hasValue(adToday.value.roi) && Number(adToday.value.roi || 0) < 1) parts.push("广告ROI偏低");
  if (fbpShortageCount.value > 0) parts.push("FBP断货风险");
  if (Number(today.value.cancelled_orders || 0) > 0) parts.push("退款待处理");
  if (!parts.length) return "经营状态稳定，继续关注可放量商品";
  return parts.join(" + ");
});

const secondaryMetrics = computed(() => [
  {
    label: "今日有效销售额",
    value: metricMoney(today.value.effective_revenue ?? today.value.revenue),
    note: `较昨日 ${salesDelta.value.text}`,
    direction: salesDelta.value.direction,
    icon: CircleDollarSign,
    path: "/profit/monthly-billing",
    breakdownTitle: "今日销售额构成",
    breakdown: todaySalesBreakdown()
  },
  {
    label: "今日有效订单",
    value: metricNumber(today.value.effective_orders, " 单"),
    note: `总计 ${metricNumber(today.value.order_count, " 单")}`,
    direction: effectiveOrderDelta.value.direction,
    icon: ClipboardList,
    path: "/orders",
    breakdownTitle: "今日订单构成",
    breakdown: todayOrdersBreakdown()
  },
  {
    label: "今日取消",
    value: metricNumber(today.value.cancelled_quantity, " 件"),
    note: `${metricNumber(today.value.cancelled_orders, " 单")} / ${metricMoney(today.value.cancelled_revenue)}`,
    direction: Number(today.value.cancelled_quantity || 0) > 0 ? "down" : "flat",
    icon: RefreshCw,
    path: "/profit/monthly-billing",
    query: todayAftersalesQuery("pre_fulfillment_cancel"),
    breakdownTitle: "各店铺今日取消",
    breakdown: shopOutcomeBreakdown(commerceShops.value, "cancelled")
  },
  {
    label: "退货件数",
    value: metricNumber(today.value.return_quantity, " 件"),
    note: `${metricNumber(today.value.return_orders, " 单")} / ${metricMoney(today.value.return_revenue)}`,
    direction: Number(today.value.return_quantity || 0) > 0 ? "down" : "flat",
    icon: AlertTriangle,
    path: "/profit/monthly-billing",
    query: todayAftersalesQuery("rejected_unclaimed"),
    breakdownTitle: "各店铺今日退货",
    breakdown: shopOutcomeBreakdown(commerceShops.value, "return")
  },
  {
    label: "广告ROI",
    value: decimalText(adToday.value.roi),
    note: adDataFreshness.value.text,
    direction: roiDelta.value.direction,
    icon: Target,
    path: "/advertising/daily",
    breakdownTitle: "各店铺广告ROI",
    breakdown: shopBreakdown(adShops.value, "roi", (value) => decimalText(value))
  },
  {
    label: "当月采购成本",
    value: metricMoney(monthShippingCost.value.purchase_cost),
    note: monthShippingCostState.value,
    direction: Number(monthShippingCost.value.purchase_cost_ratio || 0) <= 0.45 ? "up" : "down",
    icon: PackageCheck,
    path: "/profit/monthly-billing",
    breakdownTitle: "当月采购成本构成",
    breakdown: [
      { shop_name: "有效销售订单", text: metricNumber(monthShippingCost.value.order_count, " 单") },
      { shop_name: "销售件数", text: metricNumber(monthShippingCost.value.item_quantity, " 件") },
      { shop_name: "当月销售额", text: metricMoney(monthShippingCost.value.revenue) },
      { shop_name: "采购成本占比", text: percentText(monthShippingCost.value.purchase_cost_ratio) }
    ]
  }
]);

const signalBars = computed(() => [
  {
    label: "CTR",
    value: percentText(adToday.value.ctr),
    width: signalWidth(adToday.value.ctr, 0.04),
    tone: Number(adToday.value.ctr || 0) >= 0.02 ? "good" : "warn"
  },
  {
    label: "ROI",
    value: decimalText(adToday.value.roi),
    width: signalWidth(adToday.value.roi, 3),
    tone: Number(adToday.value.roi || 0) >= 1 ? "good" : "danger"
  },
  {
    label: "转化率",
    value: percentText(adToday.value.conversion_rate),
    width: signalWidth(adToday.value.conversion_rate, 0.08),
    tone: Number(adToday.value.conversion_rate || 0) >= 0.03 ? "good" : "warn"
  },
  {
    label: "广告消耗",
    value: metricMoney(adToday.value.spend_cny),
    width: signalWidth(adToday.value.spend_cny, 5000),
    tone: adCostJump.value ? "warn" : "blue"
  }
]);

const anomalyCards = computed(() => [
  {
    title: "广告亏损商品",
    count: Number(adToday.value.spend_cny || 0) > Number(adToday.value.revenue_cny || 0) ? 1 : 0,
    reason: "ROI低于安全线",
    action: "去处理",
    tone: "danger",
    icon: Target,
    path: "/advertising/daily"
  },
  {
    title: "CTR下降商品",
    count: Number(adToday.value.impressions || 0) && Number(adToday.value.ctr || 0) < 0.01 ? 1 : 0,
    reason: "点击率低于阈值",
    action: "去优化",
    tone: "warning",
    icon: AlertTriangle,
    path: "/advertising/daily"
  },
  {
    title: "退款待处理订单",
    count: Number(today.value.cancelled_orders || 0),
    reason: "售后影响店铺评分",
    action: "去处理",
    tone: "amber",
    icon: RefreshCw,
    path: "/profit/monthly-billing",
    query: { tab: "aftersales" }
  }
]);

const opportunityCards = computed(() => [
  {
    product: firstStockAlert.value.display_name || firstStockAlert.value.product_name || "高潜力商品",
    reason: Number(adToday.value.roi || 0) >= 2 ? `ROI ${decimalText(adToday.value.roi)}，具备放量基础` : "CTR 高于平均，但曝光不足",
    advice: "增加广告预算",
    icon: Flame,
    primary: "去放量",
    secondary: "AI优化",
    primaryPath: "/advertising/daily",
    secondaryPath: "/ai-variant-lab"
  },
  {
    product: "高加购低成交商品",
    reason: `${numberText(adToday.value.add_to_cart)} 次加购信号`,
    advice: "补充详情图",
    icon: Target,
    primary: "生成图",
    secondary: "看广告",
    primaryPath: "/tools/ecommerce-image-splitter",
    secondaryPath: "/advertising/daily"
  },
  {
    product: firstProcurement.value.product_name || "高利润可放量商品",
    reason: `${procurementCount.value} 个待入库商品`,
    advice: "优先补有销量 SKU",
    icon: PackageCheck,
    primary: "去采购",
    secondary: "看库存",
    primaryPath: "/purchase-list",
    secondaryPath: "/inventory/alerts"
  }
]);

const healthCards = computed(() => [
  {
    title: "广告健康",
    route: "/advertising/daily",
    icon: Target,
    items: [
      ["ROAS", decimalText(adToday.value.roi)],
      ["CTR", percentText(adToday.value.ctr)],
      ["CR", percentText(adToday.value.conversion_rate)],
      ["ACOS", Number(adToday.value.revenue_cny || 0) ? percentText(Number(adToday.value.spend_cny || 0) / Number(adToday.value.revenue_cny || 1)) : "待接入"],
      ["异常SKU", anomalyCards.value[0].count]
    ]
  },
  {
    title: "售后损失",
    route: "/profit/monthly-billing",
    query: aftersalesQuery("all"),
    icon: RefreshCw,
    items: aftersalesLossRows()
  },
  {
    title: "利润趋势",
    route: "/profit/monthly-billing",
    icon: CircleDollarSign,
    items: [
      profitTrendRow("昨日利润", yesterday.value.profit),
      profitTrendRow("近7天平均", profitTrend.value.seven_day_average_profit),
      profitTrendRow("本月平均", profitTrend.value.month_average_profit),
      profitTrendRow("当月利润", profitTrend.value.month_total_profit, profitTrendDelta(profitTrend.value.month_total_profit, profitTrend.value.previous_month_total_profit, "较上月")),
      profitTrendRow("上月利润", profitTrend.value.previous_month_total_profit, { text: "", direction: "flat" }),
      profitTrendRow("季度平均", profitTrend.value.quarter_average_profit)
    ]
  },
  {
    title: "FBP库存风险",
    route: "/inventory/alerts",
    icon: Boxes,
    items: fbpRiskRows()
  },
]);

const dashboardInsightCards = computed(() => [
  ...["利润趋势", "广告健康", "售后损失", "FBP库存风险"]
    .map((title) => healthCards.value.find((card) => card.title === title))
    .filter(Boolean),
  {
    title: "AI异常",
    route: anomalyCards.value.find((item) => Number(item.count || 0) > 0)?.path || "/advertising/daily",
    icon: AlertTriangle,
    items: [
      ["广告亏损", metricNumber(anomalyCards.value[0]?.count || 0, "个")],
      ["CTR下降", metricNumber(anomalyCards.value[1]?.count || 0, "个")],
      ["售后待处理", metricNumber(anomalyCards.value[2]?.count || 0, "个")],
      ["优先处理", anomalyCards.value.find((item) => Number(item.count || 0) > 0)?.action || "暂无"]
    ]
  },
  {
    title: "AI机会",
    route: opportunityCards.value[0]?.primaryPath || "/advertising/daily",
    icon: Flame,
    items: [
      ["高ROI放量", opportunityCards.value[0]?.product ? "1个" : "0个"],
      ["加购信号", metricNumber(adToday.value.add_to_cart, "次")],
      ["待入库", metricNumber(procurementCount.value, "个")],
      ["下一步", opportunityCards.value[0]?.primary || "观察"]
    ]
  }
]);

async function loadDashboard(options = {}) {
  const requestSeq = ++dashboardRequestSeq;
  const dateKey = String(options?.dateKey || selectedDate.value).slice(0, 10);
  const forceRefresh = options === true || options?.refresh === true;
  const snapshotOnly = options?.snapshotOnly === true;
  if (!hasDashboardLoaded.value) {
    const cached = readDashboardSessionCache(dateKey);
    if (cached) {
      mergeDashboardPayload(cached);
      hasDashboardLoaded.value = true;
    }
  }
  if (!snapshotOnly) loadOverviewPanels(dateKey);
  if (!snapshotOnly) dashboardSnapshotRefreshAttempts = 0;
  const showInitialLoading = !hasDashboardLoaded.value;
  if (showInitialLoading) {
    loading.value = true;
  } else {
    refreshing.value = true;
  }
  try {
    const dateParam = `date=${encodeURIComponent(dateKey)}`;
    const url = forceRefresh
      ? `/api/dashboard?${dateParam}&refresh=1&_=${Date.now()}`
      : snapshotOnly
        ? `/api/dashboard?${dateParam}&snapshotOnly=1&_=${Date.now()}`
        : `/api/dashboard?${dateParam}`;
    const res = await getDashboardWithRetry(url, {
      ...(forceRefresh ? { noCache: true, cache: "no-store" } : {}),
      routeScoped: false
    });
    if (requestSeq !== dashboardRequestSeq || dateKey !== selectedDate.value) return;
    snapshotBuilding.value = res?.snapshot?.status === "building";
    mergeDashboardPayload(res);
    hasDashboardLoaded.value = true;
    if (res?.snapshot?.status !== "building") writeDashboardSessionCache(dateKey, res);
    if (res?.snapshot?.status === "building" && dashboardSnapshotRefreshAttempts < 20) {
      dashboardSnapshotRefreshAttempts += 1;
      scheduleDashboardSnapshotReload(1500);
    } else if (!forceRefresh && !snapshotOnly) {
      dashboardSnapshotRefreshAttempts = 1;
      scheduleDashboardSnapshotReload(2500);
    }
  } catch (error) {
    console.error(error);
    if (requestSeq === dashboardRequestSeq && !forceRefresh && dashboardSnapshotRefreshAttempts < 20) {
      dashboardSnapshotRefreshAttempts += 1;
      scheduleDashboardSnapshotReload(Math.min(1500 * dashboardSnapshotRefreshAttempts, 6000));
    }
    if (hasDashboardLoaded.value || (!showInitialLoading && !forceRefresh)) return;
    ElMessage.error("首页摘要加载失败");
  } finally {
    if (requestSeq !== dashboardRequestSeq) return;
    if (showInitialLoading) {
      loading.value = false;
    } else {
      refreshing.value = false;
    }
  }
}

async function loadOverviewPanels(dateKey = selectedDate.value) {
  overviewPanelsLoading.value = true;
  try {
    const rankingParams = new URLSearchParams({
      dimension: "sku",
      from: dateKey,
      to: dateKey,
      page: "1",
      pageSize: "10",
      sortBy: "revenue",
      sortOrder: "desc",
      fast: "1"
    });
    const limitsRequest = getDashboardWithRetry("/api/online-products/limits", { noCache: true, routeScoped: false }).then((result) => {
      if (dateKey !== selectedDate.value) return;
      shopProductLimits.value = Array.isArray(result?.rows) ? result.rows : [];
    });
    const rankingRequest = getDashboardWithRetry(`/api/profit-ranking?${rankingParams.toString()}`, { routeScoped: false }).then((result) => {
      if (dateKey !== selectedDate.value) return;
      topSkus.value = Array.isArray(result?.rows) ? result.rows.slice(0, 10) : [];
    });
    const fbpOpportunityRequest = getDashboardWithRetry("/api/fbp-opportunities?page=1&pageSize=1", { routeScoped: false }).then((result) => {
      if (dateKey !== selectedDate.value) return;
      dashboard.value.summary = {
        ...dashboard.value.summary,
        fbp_opportunities: result?.summary || {}
      };
    });
    await Promise.allSettled([limitsRequest, rankingRequest, fbpOpportunityRequest]);
  } finally {
    if (dateKey === selectedDate.value) overviewPanelsLoading.value = false;
  }
}

function scheduleDashboardSnapshotReload(delay = 2500) {
  clearDashboardSnapshotReload();
  dashboardSnapshotRefreshTimer = window.setTimeout(() => {
    dashboardSnapshotRefreshTimer = null;
    loadDashboard({ snapshotOnly: true });
  }, delay);
}

function refreshDashboard() {
  loadDashboard({ refresh: true });
}

onMounted(() => {
  loadDashboard();
});

onBeforeUnmount(() => {
  clearDashboardSnapshotReload();
});
</script>

<template>
  <section class="commerce-dashboard" :class="{ 'is-updating': loading || dashboardUpdating }">
    <div class="hero-grid">
      <div class="operating-card" :class="`is-${businessTone}`">
        <div class="operating-card__top">
          <div>
            <h1>经营总览</h1>
          </div>
          <div class="dashboard-date-control" aria-label="经营日期选择">
            <span class="dashboard-date-control__label"><CalendarDays :size="14" />数据日期</span>
            <el-button class="dashboard-date-control__arrow" text aria-label="前一天" @click="shiftDashboardDate(-1)">
              <ChevronLeft :size="16" />
            </el-button>
            <el-date-picker
              v-model="selectedDate"
              class="dashboard-date-picker"
              type="date"
              format="YYYY年MM月DD日"
              value-format="YYYY-MM-DD"
              :clearable="false"
              :editable="false"
              :disabled-date="disableFutureDashboardDate"
              aria-label="选择经营日期"
              @change="applyDashboardDate"
            />
            <el-button class="dashboard-date-control__arrow" text aria-label="后一天" :disabled="isTodaySelected" @click="shiftDashboardDate(1)">
              <ChevronRight :size="16" />
            </el-button>
            <el-button class="dashboard-date-control__today" text :disabled="isTodaySelected" @click="resetDashboardDate">今天</el-button>
          </div>
          <span v-if="loading || dashboardUpdating" class="refresh-status">
            <RefreshCw :size="13" />
            更新中
          </span>
          <el-button class="ghost-button" size="small" :loading="loading || refreshing" @click="refreshDashboard">
            <RefreshCw :size="14" />
            刷新
          </el-button>
        </div>

        <div class="hero-core-grid today-core-grid">
          <article class="primary-metric profit-card" @click="open('/profit/monthly-billing', billingPeriodQuery())">
            <div class="metric-label">
              <CircleDollarSign :size="16" />
              今日利润
            </div>
            <strong>{{ metricMoney(today.profit) }}</strong>
            <div class="metric-footer">
              <span :class="`delta is-${profitDelta.direction}`">
                <ArrowUpRight v-if="profitDelta.direction === 'up'" :size="14" />
                <ArrowDownRight v-else-if="profitDelta.direction === 'down'" :size="14" />
                较昨日 {{ profitDelta.text }}
              </span>
              <em>{{ profitState }}</em>
            </div>
          </article>

          <el-tooltip placement="bottom" effect="light" popper-class="shop-breakdown-tooltip">
            <template #content>
              <div class="shop-breakdown">
                <h4>今日销售额构成</h4>
                <div v-for="row in todaySalesBreakdown()" :key="`today-sales-${row.shop_name}`">
                  <span>{{ row.shop_name }}</span>
                  <strong>{{ row.text }}</strong>
                </div>
              </div>
            </template>
            <article class="primary-metric today-sales-card" @click="open('/profit/monthly-billing', billingPeriodQuery())">
              <div class="metric-label">
                <CircleDollarSign :size="16" />
                今日有效营业额
              </div>
              <strong>{{ metricMoney(today.effective_revenue ?? today.revenue) }}</strong>
              <div class="metric-footer">
                <span :class="`delta is-${salesDelta.direction}`">
                  <ArrowUpRight v-if="salesDelta.direction === 'up'" :size="14" />
                  <ArrowDownRight v-else-if="salesDelta.direction === 'down'" :size="14" />
                  较昨日 {{ salesDelta.text }}
                </span>
                <em>有效销售</em>
              </div>
            </article>
          </el-tooltip>

          <el-tooltip placement="bottom" effect="light" popper-class="shop-breakdown-tooltip">
            <template #content>
              <div class="shop-breakdown">
                <h4>今日订单构成</h4>
                <div v-for="row in todayOrdersBreakdown()" :key="`today-orders-${row.shop_name}`">
                  <span>{{ row.shop_name }}</span>
                  <strong>{{ row.text }}</strong>
                </div>
              </div>
            </template>
            <article class="primary-metric today-orders-card" @click="open('/orders')">
              <div class="metric-label">
                <ClipboardList :size="16" />
                今日有效订单
              </div>
              <strong>{{ metricNumber(today.effective_orders, " 单") }}</strong>
              <div class="metric-footer">
                <span :class="`delta is-${effectiveOrderDelta.direction}`">
                  <ArrowUpRight v-if="effectiveOrderDelta.direction === 'up'" :size="14" />
                  <ArrowDownRight v-else-if="effectiveOrderDelta.direction === 'down'" :size="14" />
                  较昨日 {{ effectiveOrderDelta.text }}
                </span>
                <em>总计 {{ metricNumber(today.order_count, " 单") }}</em>
              </div>
            </article>
          </el-tooltip>

          <el-tooltip placement="bottom" effect="light" popper-class="shop-breakdown-tooltip">
            <template #content>
              <div class="shop-breakdown">
                <h4>各店铺今日取消</h4>
                <div v-for="row in shopOutcomeBreakdown(commerceShops, 'cancelled')" :key="`today-cancel-${row.shop_name}`">
                  <span>{{ row.shop_name }}</span>
                  <strong>{{ row.text }}</strong>
                </div>
              </div>
            </template>
            <article class="primary-metric today-cancel-card" @click="open('/profit/monthly-billing', todayAftersalesQuery('pre_fulfillment_cancel'))">
              <div class="metric-label">
                <RefreshCw :size="16" />
                今日取消
              </div>
              <strong>{{ metricNumber(today.cancelled_quantity, " 件") }}</strong>
              <div class="metric-footer">
                <span class="delta is-flat">{{ metricNumber(today.cancelled_orders, " 单") }}</span>
                <em>{{ metricMoney(today.cancelled_revenue) }}</em>
              </div>
            </article>
          </el-tooltip>

          <el-tooltip placement="bottom" effect="light" popper-class="shop-breakdown-tooltip">
            <template #content>
              <div class="shop-breakdown">
                <h4>各店铺今日退货</h4>
                <div v-for="row in shopOutcomeBreakdown(commerceShops, 'return')" :key="`today-return-${row.shop_name}`">
                  <span>{{ row.shop_name }}</span>
                  <strong>{{ row.text }}</strong>
                </div>
              </div>
            </template>
            <article class="primary-metric today-return-card" @click="open('/profit/monthly-billing', todayAftersalesQuery('rejected_unclaimed'))">
              <div class="metric-label">
                <AlertTriangle :size="16" />
                退货件数
              </div>
              <strong>{{ metricNumber(today.return_quantity, " 件") }}</strong>
              <div class="metric-footer">
                <span class="delta is-flat">{{ metricNumber(today.return_orders, " 单") }}</span>
                <em>{{ metricMoney(today.return_revenue) }}</em>
              </div>
            </article>
          </el-tooltip>

          <el-tooltip placement="bottom" effect="light" popper-class="shop-breakdown-tooltip ad-breakdown-tooltip" :popper-options="adTooltipPopperOptions">
            <template #content>
              <div class="shop-breakdown ad-breakdown">
                <h4>广告概览</h4>
                <div class="ad-breakdown-table">
                  <div class="ad-breakdown-row ad-breakdown-head">
                    <span>店铺</span>
                    <span>收入</span>
                    <span>消耗</span>
                    <span>ROI</span>
                    <span>点击</span>
                    <span>转化率</span>
                    <span>订单</span>
                  </div>
                  <div v-for="row in adBreakdownTableRows" :key="row.label" class="ad-breakdown-row">
                    <strong>{{ row.label }}</strong>
                    <b>{{ row.revenue }}</b>
                    <b>{{ row.spend }}</b>
                    <b>{{ row.roi }}</b>
                    <b>{{ row.clicks }}</b>
                    <b>{{ row.conversion }}</b>
                    <b>{{ row.orders }}</b>
                  </div>
                </div>
              </div>
            </template>
            <article class="primary-metric roi-card" @click="open('/advertising/daily')">
              <div class="metric-label">
                <Target :size="16" />
                广告ROI
              </div>
              <strong>{{ decimalText(adToday.roi) }}</strong>
              <div class="metric-subline">
                <span>当日广告花费</span>
                <div class="metric-subline-value">
                  <b>{{ metricMoney(adToday.spend_cny) }}</b>
                  <small :class="`is-${adSpendDelta.direction}`">较昨日 {{ adSpendDelta.text }}</small>
                </div>
              </div>
              <div class="metric-footer">
                <span :class="`delta is-${roiDelta.direction}`">
                  <ArrowUpRight v-if="roiDelta.direction === 'up'" :size="14" />
                  <ArrowDownRight v-else-if="roiDelta.direction === 'down'" :size="14" />
                  较昨日 {{ roiDelta.text }}
                </span>
                <em>{{ roiState }}</em>
                <small :class="`freshness is-${adDataFreshness.tone}`">{{ adDataFreshness.text }}</small>
              </div>
            </article>
          </el-tooltip>
        </div>

        <div class="hero-core-grid month-core-grid compact-month-grid">
          <article class="primary-metric today-sales-card" @click="open('/profit/monthly-billing', billingPeriodQuery())">
            <div class="metric-label">
              <CircleDollarSign :size="16" />
              当月销售额
            </div>
            <strong>{{ metricMoney(profitTrend.month_total_revenue) }}</strong>
            <div class="metric-footer">
              <span :class="`delta is-${monthRevenueDelta.direction}`">
                <ArrowUpRight v-if="monthRevenueDelta.direction === 'up'" :size="14" />
                <ArrowDownRight v-else-if="monthRevenueDelta.direction === 'down'" :size="14" />
                较上月 {{ monthRevenueDelta.text }}
              </span>
              <em>有效销售</em>
            </div>
          </article>

          <article class="primary-metric month-profit-card" @click="open('/profit/monthly-billing', billingPeriodQuery())">
            <div class="metric-label">
              <CircleDollarSign :size="16" />
              当月利润
            </div>
            <strong>{{ metricMoney(profitTrend.month_total_profit) }}</strong>
            <div class="metric-footer">
              <span :class="`delta is-${monthProfitDelta.direction}`">
                <ArrowUpRight v-if="monthProfitDelta.direction === 'up'" :size="14" />
                <ArrowDownRight v-else-if="monthProfitDelta.direction === 'down'" :size="14" />
                较上月 {{ monthProfitDelta.text }}
              </span>
              <em>本月累计</em>
            </div>
          </article>

          <el-tooltip placement="bottom" effect="light" popper-class="shop-breakdown-tooltip month-ad-spend-tooltip" :popper-options="adTooltipPopperOptions">
            <template #content>
              <div class="shop-breakdown month-ad-spend-breakdown">
                <h4>当月各店铺广告花费</h4>
                <p class="ad-quality-note" :class="`is-${adMonthQuality.tone}`">{{ adMonthQuality.detail }}</p>
                <div v-if="adMonthPendingDates.length" class="ad-quality-dates">
                  <span v-for="item in adMonthPendingDates.slice(-6)" :key="item.date_key">
                    {{ item.date_key }}：{{ item.pending_rows }}行待返回
                  </span>
                </div>
                <div class="month-ad-spend-table">
                  <div class="month-ad-spend-row month-ad-spend-head">
                    <span>店铺</span>
                    <span>广告花费</span>
                    <span>ROI</span>
                    <span>订单</span>
                  </div>
                  <div v-for="row in adMonthSpendBreakdownRows" :key="row.label" class="month-ad-spend-row">
                    <strong>{{ row.label }}</strong>
                    <b>{{ row.spend }}</b>
                    <b>{{ row.roi }}</b>
                    <b>{{ row.orders }}</b>
                  </div>
                </div>
              </div>
            </template>
            <article class="primary-metric roi-card month-ad-spend-card" @click="open('/advertising/daily')">
              <div class="metric-label">
                <Target :size="16" />
                当月广告花费
              </div>
              <strong>{{ adMonthSpendDisplay }}</strong>
              <div class="metric-footer">
                <span :class="`delta is-${adMonthQuality.tone === 'danger' ? 'down' : adMonthQuality.tone === 'success' ? 'up' : 'flat'}`">{{ adMonthQuality.text }}</span>
                <em>{{ metricNumber(adMonth.shop_count, " 店") }}</em>
              </div>
            </article>
          </el-tooltip>

          <el-tooltip placement="bottom" effect="light" popper-class="shop-breakdown-tooltip purchase-breakdown-tooltip" :popper-options="adTooltipPopperOptions">
            <template #content>
              <div class="shop-breakdown purchase-breakdown">
                <h4>当月采购成本占比</h4>
                <div class="purchase-breakdown-table">
                  <div class="purchase-breakdown-row purchase-breakdown-head">
                    <span>店铺</span>
                    <span>销售额</span>
                    <span>采购成本</span>
                    <span>占比</span>
                    <span>订单</span>
                  </div>
                  <div v-for="row in monthPurchaseCostBreakdownRows" :key="row.label" class="purchase-breakdown-row">
                    <strong>{{ row.label }}</strong>
                    <b>{{ row.revenue }}</b>
                    <b>{{ row.purchaseCost }}</b>
                    <b>{{ row.ratio }}</b>
                    <b>{{ row.orders }}</b>
                  </div>
                </div>
              </div>
            </template>
            <article class="primary-metric inventory-ratio-card" @click="open('/profit/monthly-billing', billingPeriodQuery())">
              <div class="metric-label">
                <PackageCheck :size="16" />
                当月采购成本
              </div>
              <strong>{{ metricMoney(monthShippingCost.purchase_cost) }}</strong>
              <div class="metric-footer">
                <span class="delta is-flat">{{ monthShippingCostState }}</span>
                <em>占当月销售额</em>
              </div>
            </article>
          </el-tooltip>

          <el-tooltip placement="bottom" effect="light" popper-class="shop-breakdown-tooltip purchase-breakdown-tooltip" :popper-options="adTooltipPopperOptions">
            <template #content>
              <div class="shop-breakdown purchase-breakdown">
                <h4>当月运费占比</h4>
                <div class="purchase-breakdown-table">
                  <div class="purchase-breakdown-row purchase-breakdown-head">
                    <span>店铺</span>
                    <span>销售额</span>
                    <span>运费</span>
                    <span>占比</span>
                    <span>订单</span>
                  </div>
                  <div v-for="row in monthFreightCostBreakdownRows" :key="row.label" class="purchase-breakdown-row">
                    <strong>{{ row.label }}</strong>
                    <b>{{ row.revenue }}</b>
                    <b>{{ row.freightCost }}</b>
                    <b>{{ row.ratio }}</b>
                    <b>{{ row.orders }}</b>
                  </div>
                </div>
              </div>
            </template>
            <article class="primary-metric shipping-cost-card" @click="open('/profit/monthly-billing', billingPeriodQuery())">
              <div class="metric-label">
                <Truck :size="16" />
                当月运费
              </div>
              <strong>{{ metricMoney(monthShippingCost.shipping_cost) }}</strong>
              <div class="metric-footer">
                <span class="delta is-flat">{{ monthFreightCostState }}</span>
                <em>占当月销售额</em>
              </div>
            </article>
          </el-tooltip>

          <article class="primary-metric inventory-value-card" @click="open('/inventory/fbp')">
            <div class="metric-label">
              <Boxes :size="16" />
              库存占用金额
            </div>
            <strong>{{ metricMoney(summary.fbp_inventory_value) }}</strong>
            <div class="metric-footer">
              <span class="delta is-flat">{{ fbpInventoryQuantityText }}</span>
              <em>FBP货值</em>
            </div>
          </article>

          <article class="primary-metric today-orders-card" @click="open('/orders')">
            <div class="metric-label">
              <ClipboardList :size="16" />
              当月有效订单
            </div>
            <strong>{{ metricNumber(monthEffectiveOrders, " 单") }}</strong>
            <div class="metric-footer">
              <span :class="`delta is-${monthEffectiveOrderDelta.direction}`">
                <ArrowUpRight v-if="monthEffectiveOrderDelta.direction === 'up'" :size="14" />
                <ArrowDownRight v-else-if="monthEffectiveOrderDelta.direction === 'down'" :size="14" />
                较上月 {{ monthEffectiveOrderDelta.text }}
              </span>
              <em>本月累计</em>
            </div>
          </article>

          <article class="primary-metric today-cancel-card" @click="open('/profit/monthly-billing', todayAftersalesQuery('pre_fulfillment_cancel'))">
            <div class="metric-label">
              <RefreshCw :size="16" />
              当月取消订单
            </div>
            <strong>{{ metricNumber(monthCancelledOrders, " 单") }}</strong>
            <div class="metric-footer">
              <span :class="`delta is-${monthCancelledOrderDelta.direction}`">较上月 {{ monthCancelledOrderDelta.text }}</span>
              <em>{{ metricNumber(monthCancelledQuantity, " 件") }}</em>
            </div>
          </article>

          <article class="primary-metric today-return-card" @click="open('/profit/monthly-billing', todayAftersalesQuery('rejected_unclaimed'))">
            <div class="metric-label">
              <AlertTriangle :size="16" />
              当月退货订单
            </div>
            <strong>{{ metricNumber(monthReturnOrders, " 单") }}</strong>
            <div class="metric-footer">
              <span :class="`delta is-${monthReturnOrderDelta.direction}`">较上月 {{ monthReturnOrderDelta.text }}</span>
              <em>{{ metricNumber(monthReturnQuantity, " 件") }}</em>
            </div>
          </article>
        </div>

        <div class="business-reminder">
          <Zap :size="15" />
          <span>今日提醒：{{ operationReminder }}</span>
        </div>

        <div class="dashboard-overview-grid">
          <section class="overview-panel top-sku-panel">
            <div class="overview-panel-heading">
              <div>
                <span>Top Products</span>
                <h2>Top 10 SKU</h2>
              </div>
              <small>{{ selectedDateText }} · 按销售额排序</small>
            </div>
            <div v-if="topSkus.length" class="top-sku-list">
              <article v-for="(row, index) in topSkus" :key="`${row.shop_id}-${row.ozon_sku}`" class="top-sku-item">
                <b class="sku-rank">{{ index + 1 }}</b>
                <el-image
                  class="sku-image"
                  :src="row.image_url"
                  fit="cover"
                  :preview-src-list="skuImageList(row)"
                  :initial-index="0"
                  preview-teleported
                >
                  <template #error><span>无图</span></template>
                </el-image>
                <div class="sku-copy">
                  <strong :title="row.product_name || row.ozon_sku">{{ row.product_name || row.ozon_sku || "未命名商品" }}</strong>
                  <small>{{ row.shop_name }} · SKU {{ row.ozon_sku || "--" }}</small>
                </div>
                <div class="sku-sales">
                  <span>销量<strong>{{ numberText(row.item_quantity) }} 件</strong></span>
                  <span>销售额<strong>{{ metricMoney(row.revenue) }}</strong></span>
                </div>
              </article>
            </div>
            <el-skeleton v-else-if="overviewPanelsLoading" :rows="6" animated />
            <el-empty v-else description="所选日期暂无 SKU 销售数据" :image-size="72" />
          </section>

          <section class="overview-panel shop-limit-panel">
            <div class="overview-panel-heading">
              <div>
                <span>Listing Capacity</span>
                <h2>店铺上架额度</h2>
              </div>
              <small>今日额度优先</small>
            </div>
            <div v-if="availableLimitRows.length" class="limit-chart">
              <article v-for="row in availableLimitRows" :key="row.shop_id" class="limit-chart-row">
                <div class="limit-chart-label">
                  <strong>{{ row.shop_name }}</strong>
                  <span v-if="row.ok">今日已用 {{ numberText(row.today_usage) }}</span>
                  <span v-else>额度暂不可用</span>
                </div>
                <div class="limit-chart-value">
                  <div class="limit-chart-track">
                    <i v-if="row.ok" :style="{ width: limitBarWidth(row.today_available) }"></i>
                  </div>
                  <strong>{{ row.ok ? numberText(row.today_available) : "--" }}</strong>
                </div>
                <div v-if="row.ok" class="limit-chart-meta">
                  <span>今日可用 / {{ numberText(row.today_limit) }}</span>
                  <span>总可用 {{ numberText(row.total_available) }} / {{ numberText(row.total_limit) }}</span>
                </div>
              </article>
            </div>
            <el-skeleton v-else-if="overviewPanelsLoading" :rows="5" animated />
            <el-empty v-else description="暂无店铺额度数据" :image-size="72" />
          </section>
        </div>

        <div class="hero-insight-grid is-summary-only">
          <section class="health-panel hero-health-panel hero-health-panel--compact">
            <div class="section-heading">
              <span>Business Health</span>
              <h2>经营健康摘要</h2>
            </div>
            <div class="health-grid">
              <article
                v-for="card in dashboardInsightCards"
                :key="card.title"
                role="button"
                tabindex="0"
                class="health-card"
                @click="open(card.route, card.query || {})"
                @keydown.enter.prevent="open(card.route, card.query || {})"
                @keydown.space.prevent="open(card.route, card.query || {})"
              >
                <div>
                  <component :is="card.icon" :size="18" />
                  <strong>{{ card.title }}</strong>
                </div>
                <div class="health-card-list">
                  <template v-for="row in (card.items || []).slice(0, 3)" :key="row.alertType || row.label || row[0]">
                    <button
                      v-if="row.alertType || row.route"
                      type="button"
                      class="health-card-row"
                      @click.stop="open(row.route || '/inventory/alerts', row.query || { alertType: row.alertType })"
                    >
                      <span class="health-card-label">{{ row.label || row[0] }}</span>
                      <span class="health-card-value">
                        <span>{{ row.value || row[1] }}</span>
                        <small v-if="row.delta" :class="`is-${row.direction || 'flat'}`">{{ row.delta }}</small>
                      </span>
                    </button>
                    <div v-else class="health-card-row is-static">
                      <span class="health-card-label">{{ row.label || row[0] }}</span>
                      <span class="health-card-value">
                        <span>{{ row.value || row[1] }}</span>
                        <small v-if="row.delta" :class="`is-${row.direction || 'flat'}`">{{ row.delta }}</small>
                      </span>
                    </div>
                  </template>
                </div>
              </article>
            </div>
          </section>

        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.commerce-dashboard {
  --dashboard-bg: #f6f8fc;
  --dashboard-surface: #ffffff;
  --dashboard-surface-soft: #f8fafd;
  --dashboard-border: #e5eaf2;
  --dashboard-border-strong: rgba(37, 99, 235, 0.28);
  --dashboard-text: #0f172a;
  --dashboard-muted: #64748b;
  --dashboard-text-light: #94a3b8;
  --dashboard-hover-shadow: 0 12px 30px rgba(15, 23, 42, 0.09);
  --dashboard-card-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
  --metric-accent: #2563eb;
  --metric-profit: #059669;
  --metric-revenue: #059669;
  --metric-orders: #2563eb;
  --metric-neutral: #0f172a;
  --metric-danger: #ef4444;
  --metric-cost: #d97706;
  --metric-logistics: #2563eb;
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 100%;
  height: 100%;
  padding: 24px;
  background:
    radial-gradient(circle at 10% 0%, rgba(37, 99, 235, 0.08) 0, rgba(37, 99, 235, 0) 30%),
    linear-gradient(180deg, #f8fafd 0%, var(--dashboard-bg) 100%) !important;
  color: var(--dashboard-text);
  box-sizing: border-box;
}

.commerce-dashboard::before,
.commerce-dashboard::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.commerce-dashboard::before {
  z-index: 0;
  opacity: 0.2;
  background-image:
    linear-gradient(rgba(37, 99, 235, 0.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(37, 99, 235, 0.05) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.62), transparent 64%);
}

.commerce-dashboard::after {
  display: none;
}

button {
  font: inherit;
}

.dashboard-overview-grid {
  display: grid;
  grid-template-columns: minmax(720px, 8fr) minmax(300px, 2fr);
  gap: 24px;
  margin-top: 24px;
}

.overview-panel {
  min-width: 0;
  padding: 24px;
  border: 1px solid var(--dashboard-border);
  border-radius: 18px;
  background: var(--dashboard-surface);
  box-shadow: var(--dashboard-card-shadow);
}

.overview-panel-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 22px;
}

.overview-panel-heading span {
  color: #2563eb;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.overview-panel-heading h2 {
  margin: 5px 0 0;
  font-size: 20px;
}

.overview-panel-heading small {
  color: var(--dashboard-muted);
  text-align: right;
}

.limit-chart {
  display: grid;
  gap: 16px;
}

.limit-chart-row {
  display: grid;
  gap: 7px;
  padding-bottom: 12px;
  border-bottom: 1px solid #edf1f7;
}

.limit-chart-row:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}

.limit-chart-label,
.limit-chart-value {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.limit-chart-label strong {
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.limit-chart-label span {
  flex: none;
  color: var(--dashboard-muted);
  font-size: 12px;
}

.limit-chart-meta {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--dashboard-muted);
  font-size: 11px;
}

.limit-chart-track {
  flex: 1;
  height: 12px;
  overflow: hidden;
  border-radius: 999px;
  background: #e9eef7;
}

.limit-chart-track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #2563eb, #60a5fa);
  box-shadow: 0 2px 8px rgba(37, 99, 235, 0.24);
}

.limit-chart-value > strong {
  width: 66px;
  color: #1d4ed8;
  font-size: 18px;
  text-align: right;
}

.top-sku-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(5, auto);
  grid-auto-flow: column;
  gap: 10px;
}

.top-sku-item {
  display: grid;
  grid-template-columns: 28px 64px minmax(0, 1fr) 88px;
  align-items: center;
  gap: 12px;
  min-height: 84px;
  padding: 6px 12px;
  border: 1px solid #edf1f7;
  border-radius: 14px;
  background: #fbfcfe;
  box-sizing: content-box;
}

.sku-rank {
  color: #94a3b8;
  font-size: 15px;
  text-align: center;
}

.top-sku-item:nth-child(-n + 3) .sku-rank {
  color: #2563eb;
  font-size: 20px;
}

.sku-image {
  width: 64px;
  height: 84px;
  border-radius: 10px;
  background: #eef2f7;
}

.sku-image :deep(.el-image__error) {
  color: #94a3b8;
  font-size: 12px;
}

.sku-copy {
  display: grid;
  align-content: center;
  min-width: 0;
  gap: 6px;
}

.sku-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sku-copy strong {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  color: var(--dashboard-text);
  font-size: 14px;
  line-height: 1.45;
}

.sku-copy small {
  color: var(--dashboard-muted);
  font-size: 12px;
}

.sku-sales {
  display: grid;
  align-content: center;
  gap: 12px;
  padding-left: 12px;
  border-left: 1px solid #e5eaf2;
}

.sku-sales span {
  display: grid;
  gap: 3px;
  color: var(--dashboard-muted);
  font-size: 11px;
  text-align: right;
}

.sku-sales strong {
  color: var(--dashboard-text);
  font-size: 14px;
}

.ai-floating-entry {
  position: fixed;
  right: 22px;
  bottom: 26px;
  z-index: 20;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border: 0;
  border-radius: 999px;
  color: #fff;
  background: #111827;
  box-shadow: 0 18px 34px rgba(15, 23, 42, 0.26);
  cursor: pointer;
}

.ai-floating-entry b {
  display: grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  border-radius: 999px;
  color: #0f172a;
  background: #bfdbfe;
  font-size: 12px;
}

.hero-grid {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  flex: 0 0 auto;
  gap: 10px;
  align-items: start;
  min-height: auto;
}

.operating-card {
  position: relative;
  overflow: visible;
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  min-height: auto;
  padding: 14px;
  border: 1px solid var(--dashboard-border) !important;
  border-radius: 12px;
  color: var(--dashboard-text);
  background: #ffffff !important;
  box-shadow: var(--dashboard-card-shadow) !important;
}

.operating-card.is-danger {
  background: #ffffff !important;
}

.operating-card.is-warning {
  background: #ffffff !important;
}

.operating-card::before {
  display: none;
}

.operating-card__top,
.hero-core-grid,
.secondary-metric-grid,
.business-reminder,
.hero-insight-grid {
  position: relative;
  z-index: 1;
}

.hero-insight-grid.is-summary-only {
  grid-template-columns: minmax(0, 1fr);
}

.operating-card__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}

.operating-card__top > div:first-child {
  flex: 1 1 360px;
  min-width: 0;
}

.dashboard-date-control {
  display: inline-flex;
  align-items: center;
  height: 36px;
  padding: 0 5px 0 10px;
  overflow: hidden;
  border: 1px solid var(--dashboard-border);
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 3px 10px rgba(15, 23, 42, 0.05);
}

.dashboard-date-control__label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding-right: 8px;
  color: var(--dashboard-muted);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.dashboard-date-control__arrow,
.dashboard-date-control__today {
  height: 28px;
  margin: 0;
  border-radius: 7px;
  color: #475569;
}

.dashboard-date-control__arrow {
  width: 28px;
  padding: 0;
}

.dashboard-date-control__today {
  padding: 0 8px;
  color: #2563eb;
  font-size: 12px;
  font-weight: 700;
}

.dashboard-date-picker {
  width: 148px !important;
}

.dashboard-date-picker :deep(.el-input__wrapper) {
  padding: 0 7px;
  box-shadow: none !important;
  background: transparent;
}

.dashboard-date-picker :deep(.el-input__prefix) {
  display: none;
}

.dashboard-date-picker :deep(.el-input__inner) {
  color: var(--dashboard-text);
  font-size: 13px;
  font-weight: 700;
  text-align: center;
}

.operating-card h1 {
  margin: 0;
  color: var(--dashboard-text);
  font-size: 22px;
  font-weight: 700;
  line-height: 1.18;
  letter-spacing: 0;
}

.operating-card p {
  margin: 6px 0 0;
  color: var(--dashboard-muted);
  font-size: 13px;
}

.refresh-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 26px;
  margin-left: auto;
  padding: 3px 9px;
  border-radius: 999px;
  color: #475569;
  background: #f3f7fb;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.refresh-status svg {
  animation: dashboard-refresh-spin 0.9s linear infinite;
}

@keyframes dashboard-refresh-spin {
  to {
    transform: rotate(360deg);
  }
}

.ghost-button {
  height: 32px;
  border-radius: 8px;
  --el-button-bg-color: #ffffff;
  --el-button-border-color: var(--dashboard-border);
  --el-button-text-color: #4b5563;
  --el-button-hover-bg-color: #eef6ff;
  --el-button-hover-border-color: #93c5fd;
  --el-button-hover-text-color: #1d4ed8;
  transition: all 0.18s ease;
}

.ghost-button:hover {
  box-shadow: 0 6px 18px rgba(37, 99, 235, 0.12);
  transform: translateY(-1px);
}

.hero-core-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(150px, 1fr));
  gap: 10px;
  align-items: stretch;
  margin-bottom: 10px;
}

.today-core-grid {
  grid-template-columns: repeat(6, minmax(0, 1fr));
}

.month-core-grid {
  grid-template-columns: repeat(9, minmax(0, 1fr));
  grid-auto-rows: 82px;
  margin-bottom: 12px;
}

.primary-metric,
.ai-signal-panel,
.secondary-metric-grid button {
  border: 1px solid var(--dashboard-border) !important;
  border-radius: 12px;
  background: var(--dashboard-surface) !important;
  box-shadow: var(--dashboard-card-shadow) !important;
}

.primary-metric {
  position: relative;
  overflow: hidden;
  min-width: 0;
  min-height: 104px;
  padding: 13px 15px;
  cursor: pointer;
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease, background 0.18s ease;
}

.today-core-grid .primary-metric {
  min-height: 126px;
  height: 126px;
}

.primary-metric::before {
  display: none;
}

.primary-metric:hover {
  border-color: var(--dashboard-border-strong) !important;
  box-shadow: var(--dashboard-hover-shadow) !important;
  background: #ffffff !important;
  transform: translateY(-2px);
}

.compact-month-grid .primary-metric {
  min-height: 82px;
  height: 82px;
  padding: 9px 11px;
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.045) !important;
}

.compact-month-grid .month-ad-spend-card {
  height: 82px;
  min-height: 82px;
  padding: 9px 11px;
}

.compact-month-grid .month-ad-spend-card strong {
  margin-top: 7px;
  font-size: 21px;
}

.compact-month-grid .month-ad-spend-card .metric-footer {
  margin-top: 8px;
}

.compact-month-grid .metric-label {
  font-size: 12px;
  font-weight: 650;
}

.compact-month-grid .metric-footer {
  gap: 5px;
  margin-top: 8px;
}

.compact-month-grid .metric-footer em,
.compact-month-grid .delta {
  font-size: 11px;
}

.profit-card {
  background: #ffffff;
  --metric-accent: var(--metric-profit);
}

.roi-card {
  background: #ffffff;
  --metric-accent: var(--metric-orders);
}

.today-sales-card {
  background: #ffffff;
  --metric-accent: var(--metric-revenue);
}

.today-orders-card {
  background: #ffffff;
  --metric-accent: var(--metric-orders);
}

.today-cancel-card {
  background: #ffffff;
  --metric-accent: var(--metric-danger);
}

.today-return-card {
  background: #ffffff;
  --metric-accent: var(--metric-danger);
}

.month-profit-card {
  background: #ffffff;
  --metric-accent: var(--metric-profit);
}

.inventory-value-card {
  background: #ffffff;
  --metric-accent: var(--metric-logistics);
}

.inventory-ratio-card {
  background: #ffffff;
  --metric-accent: var(--metric-cost);
}

.shipping-cost-card {
  background: #ffffff;
  --metric-accent: var(--metric-logistics);
}

.metric-label {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--dashboard-muted);
  font-size: 13px;
  font-weight: 700;
}

.metric-label svg {
  color: #2563eb;
}

.primary-metric strong {
  display: block;
  margin-top: 10px;
  color: var(--dashboard-text);
  font-size: 29px;
  font-weight: 700;
  line-height: 1;
}

.today-core-grid .primary-metric strong {
  font-size: 29px;
}

.compact-month-grid .primary-metric strong {
  margin-top: 7px;
  color: #334155 !important;
  font-size: 21px;
  font-weight: 700;
}

.profit-card strong {
  color: var(--metric-profit) !important;
}

.roi-card strong {
  color: var(--metric-orders) !important;
}

.today-sales-card strong {
  color: var(--metric-revenue) !important;
}

.today-orders-card strong {
  color: var(--metric-orders) !important;
}

.today-cancel-card strong {
  color: var(--metric-danger) !important;
}

.today-return-card strong {
  color: var(--metric-danger) !important;
}

.month-profit-card strong {
  color: var(--metric-profit) !important;
}

.inventory-value-card strong {
  color: var(--metric-logistics) !important;
}

.inventory-ratio-card strong {
  color: var(--metric-cost) !important;
}

.shipping-cost-card strong {
  color: var(--metric-logistics) !important;
}

.today-core-grid .profit-card strong,
.today-core-grid .today-sales-card strong {
  color: var(--metric-revenue) !important;
}

.today-core-grid .today-orders-card strong,
.today-core-grid .roi-card strong {
  color: var(--metric-orders) !important;
}

.today-core-grid .today-cancel-card strong,
.today-core-grid .today-return-card strong {
  color: var(--metric-danger) !important;
}

.compact-month-grid .inventory-ratio-card strong,
.compact-month-grid .shipping-cost-card strong {
  color: var(--metric-cost) !important;
}

.compact-month-grid .today-orders-card strong,
.compact-month-grid .inventory-value-card strong {
  color: #2563eb !important;
}

.compact-month-grid .today-cancel-card strong,
.compact-month-grid .today-return-card strong {
  color: #dc2626 !important;
}

.metric-footer {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  min-width: 0;
  overflow: hidden;
}

.metric-footer > * {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metric-subline {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-top: 8px;
  color: #64748b;
  font-size: 12px;
}

.today-core-grid .roi-card .metric-subline {
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
  font-size: 11px;
}

.today-core-grid .roi-card .metric-subline b {
  font-size: 12px;
}

.today-core-grid .roi-card .metric-subline-value {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 5px;
}

.today-core-grid .roi-card .metric-subline-value small {
  max-width: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.today-core-grid .roi-card .metric-footer {
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 7px;
  overflow: visible;
}

.today-core-grid .roi-card .metric-footer > * {
  max-width: none;
  overflow: visible;
  white-space: nowrap;
}

.metric-subline span {
  min-width: 0;
}

.metric-subline b {
  flex-shrink: 0;
  color: #0f172a;
  font-size: 14px;
  font-weight: 700;
}

.metric-subline-value {
  display: grid;
  justify-items: end;
  gap: 2px;
}

.metric-subline-value small {
  font-size: 11px;
  font-weight: 700;
}

.metric-subline-value small.is-up {
  color: #10b981;
}

.metric-subline-value small.is-down {
  color: #ef4444;
}

.metric-subline-value small.is-flat {
  color: #64748b;
}

.metric-footer em {
  padding: 3px 8px;
  border: 1px solid #e5eaf2;
  border-radius: 999px;
  color: #64748b;
  background: #f9fafb;
  font-size: 12px;
  font-style: normal;
  font-weight: 700;
}

.metric-footer .freshness {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  min-height: 22px;
  padding: 3px 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: #f9fafb;
  font-size: 12px;
  font-weight: 800;
}

.metric-footer .freshness.is-success {
  color: #047857;
  background: #ecfdf5;
  border-color: #bbf7d0;
}

.metric-footer .freshness.is-warning {
  color: #b45309;
  background: #fffbeb;
  border-color: #fde68a;
}

.metric-footer .freshness.is-danger {
  color: #dc2626;
  background: #fef2f2;
  border-color: #fecaca;
}

.delta {
  display: inline-flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 700;
}

.delta.is-up,
.secondary-metric-grid small.is-up {
  color: #10b981;
}

.delta.is-down,
.secondary-metric-grid small.is-down {
  color: #ef4444;
}

.delta.is-flat,
.secondary-metric-grid small.is-flat {
  color: #7b8497;
}

.ai-signal-panel {
  padding: 14px;
}

.signal-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  color: #dbeafe;
  font-size: 13px;
  font-weight: 800;
}

.signal-row + .signal-row {
  margin-top: 11px;
}

.signal-row div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 5px;
  color: #9fb0c7;
  font-size: 12px;
}

.signal-row b {
  color: #f8fafc;
}

.signal-row i {
  display: block;
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.2);
}

.signal-row em {
  display: block;
  height: 100%;
  border-radius: inherit;
}

.signal-row em.is-good {
  background: #34d399;
}

.signal-row em.is-warn {
  background: #64748b;
}

.signal-row em.is-danger {
  background: #fb7185;
}

.signal-row em.is-blue {
  background: #60a5fa;
}

.secondary-metric-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
}

.secondary-metric-grid button {
  min-height: 86px;
  padding: 12px;
  color: #1f2937;
  text-align: left;
  cursor: pointer;
}

.secondary-metric-grid button svg {
  color: #2563eb;
}

.secondary-metric-grid span,
.pressure-card span {
  display: block;
  margin-top: 8px;
  color: #7b8497;
  font-size: 12px;
}

:global(.shop-breakdown-tooltip) {
  max-width: min(380px, calc(100vw - 32px));
  border: 1px solid #e5e7eb !important;
  border-radius: 10px !important;
  box-shadow: 0 16px 34px rgba(15, 23, 42, 0.14) !important;
}

:global(.ad-breakdown-tooltip) {
  max-width: min(720px, calc(100vw - 32px));
}

:global(.purchase-breakdown-tooltip) {
  max-width: min(620px, calc(100vw - 32px));
}

:global(.month-ad-spend-tooltip) {
  max-width: min(520px, calc(100vw - 32px));
}

:global(.shop-breakdown) {
  min-width: 220px;
}

:global(.shop-breakdown h4) {
  margin: 0 0 6px;
  color: #0f172a;
  font-size: 13px;
}

:global(.shop-breakdown div) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 6px 0;
  border-top: 1px solid #eef2f7;
  color: #64748b;
  font-size: 12px;
  transition: background 0.18s ease, color 0.18s ease;
}

:global(.shop-breakdown strong) {
  max-width: 180px;
  color: #0f172a;
  text-align: right;
  white-space: normal;
  line-height: 1.45;
}

:global(.shop-breakdown div:hover) {
  background: #f8fafc;
}

:global(.ad-breakdown) {
  width: min(680px, calc(100vw - 48px));
  min-width: 0;
}

:global(.purchase-breakdown) {
  width: min(580px, calc(100vw - 48px));
  min-width: 0;
}

:global(.month-ad-spend-breakdown) {
  width: min(480px, calc(100vw - 48px));
  min-width: 0;
}

:global(.ad-breakdown-table) {
  display: block !important;
  width: 100%;
  gap: 0;
}

:global(.purchase-breakdown-table) {
  display: block !important;
  width: 100%;
  gap: 0;
}

:global(.month-ad-spend-table) {
  display: block !important;
  width: 100%;
  gap: 0;
}

:global(.ad-quality-note) {
  margin: -4px 0 8px;
  font-size: 12px;
  line-height: 1.5;
  color: #64748b;
}

:global(.ad-quality-note.is-danger) {
  color: #b91c1c;
}

:global(.ad-quality-note.is-warning) {
  color: #b45309;
}

:global(.ad-quality-note.is-success) {
  color: #047857;
}

:global(.ad-quality-dates) {
  display: flex !important;
  flex-wrap: wrap;
  justify-content: flex-start !important;
  gap: 6px !important;
  margin: 0 0 10px;
  padding: 0 !important;
  border-top: 0 !important;
}

:global(.ad-quality-dates span) {
  padding: 4px 7px;
  border: 1px solid rgba(248, 113, 113, 0.28);
  border-radius: 6px;
  background: rgba(254, 242, 242, 0.9);
  color: #991b1b;
  font-size: 12px;
  line-height: 1.2;
}

:global(.ad-breakdown-row) {
  display: grid !important;
  grid-template-columns: minmax(112px, 1.5fr) repeat(6, minmax(58px, 0.75fr));
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid #eef2f7;
  transition: background 0.18s ease;
}

:global(.purchase-breakdown-row) {
  display: grid !important;
  grid-template-columns: minmax(112px, 1.35fr) repeat(4, minmax(70px, 0.8fr));
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid #eef2f7;
  transition: background 0.18s ease;
}

:global(.month-ad-spend-row) {
  display: grid !important;
  grid-template-columns: minmax(128px, 1.45fr) repeat(3, minmax(72px, 0.8fr));
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid #eef2f7;
  transition: background 0.18s ease;
}

:global(.ad-breakdown-row:not(.ad-breakdown-head):hover),
:global(.purchase-breakdown-row:not(.purchase-breakdown-head):hover),
:global(.month-ad-spend-row:not(.month-ad-spend-head):hover) {
  background: #f8fafc;
}

:global(.ad-breakdown-head) {
  padding-top: 0;
  color: #64748b;
  font-size: 11px;
  font-weight: 800;
}

:global(.purchase-breakdown-head) {
  padding-top: 0;
  color: #64748b;
  font-size: 11px;
  font-weight: 800;
}

:global(.month-ad-spend-head) {
  padding-top: 0;
  color: #64748b;
  font-size: 11px;
  font-weight: 800;
}

:global(.ad-breakdown-row strong),
:global(.ad-breakdown-row b),
:global(.ad-breakdown-row span),
:global(.purchase-breakdown-row strong),
:global(.purchase-breakdown-row b),
:global(.purchase-breakdown-row span),
:global(.month-ad-spend-row strong),
:global(.month-ad-spend-row b),
:global(.month-ad-spend-row span) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.ad-breakdown-row strong),
:global(.purchase-breakdown-row strong),
:global(.month-ad-spend-row strong) {
  color: #334155;
  font-size: 12px;
}

:global(.ad-breakdown-row b),
:global(.purchase-breakdown-row b),
:global(.month-ad-spend-row b) {
  color: #0f172a;
  font-size: 12px;
  text-align: right;
}

:global(.ad-breakdown-head span),
:global(.purchase-breakdown-head span),
:global(.month-ad-spend-head span) {
  text-align: right;
}

:global(.ad-breakdown-head span:first-child),
:global(.purchase-breakdown-head span:first-child),
:global(.month-ad-spend-head span:first-child) {
  text-align: left;
}

.secondary-metric-grid strong {
  display: block;
  margin-top: 8px;
  color: #1f2937;
  font-size: 22px;
  font-weight: 700;
}

.secondary-metric-grid small {
  display: block;
  margin-top: 6px;
  color: #7b8497;
  font-size: 12px;
}

.business-reminder {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  margin-top: 8px;
  padding: 0 12px;
  border: 1px solid #dbeafe;
  border-radius: 8px;
  color: #1e40af;
  background: linear-gradient(90deg, #eff6ff 0%, #ffffff 100%);
  font-size: 13px;
  font-weight: 600;
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.04);
}


.hero-insight-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  flex: 0 0 auto;
  gap: 10px;
  margin-top: 10px;
  min-height: auto;
}

.hero-health-panel {
  display: flex;
  flex-direction: column;
  min-height: auto;
  padding: 10px;
  border: 1px solid var(--dashboard-border);
  border-radius: 12px;
  background: var(--dashboard-surface);
  box-shadow: var(--dashboard-card-shadow);
}

.hero-health-panel .section-heading {
  margin-bottom: 8px;
}

.hero-health-panel .section-heading h2 {
  color: #1d4ed8;
  font-size: 14px;
  font-weight: 600;
}

.hero-health-panel .section-heading span {
  color: var(--dashboard-muted);
}

.hero-insight-grid .health-grid {
  grid-template-columns: repeat(6, minmax(0, 1fr));
  flex: 0 0 auto;
  gap: 7px;
  min-height: auto;
}

.hero-insight-grid .health-card {
  border: 1px solid var(--dashboard-border) !important;
  border-radius: 10px;
  background: var(--dashboard-surface) !important;
  box-shadow: var(--dashboard-card-shadow) !important;
  transition: all 0.18s ease;
}

.hero-insight-grid .health-card {
  min-height: 72px;
  padding: 8px;
}

.hero-insight-grid .health-card:hover {
  border-color: var(--dashboard-border-strong) !important;
  box-shadow: var(--dashboard-hover-shadow) !important;
  transform: translateY(-2px);
}

.hero-insight-grid .health-card svg {
  color: #1d4ed8;
  opacity: 1;
}

.hero-insight-grid .health-card strong {
  color: var(--dashboard-text);
  font-size: 13px;
}

.hero-insight-grid .health-card dt {
  color: var(--dashboard-muted);
}

.hero-insight-grid .health-card dd {
  color: #475569;
}

.hero-rail {
  display: grid;
  gap: 12px;
}

.rail-panel,
.action-panel,
.pressure-panel,
.health-panel,
.ai-advice-strip {
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.86);
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.08);
}

.hero-insight-grid .hero-health-panel {
  border: 1px solid var(--dashboard-border);
  background: var(--dashboard-surface);
  box-shadow: var(--dashboard-card-shadow);
}

.hero-insight-grid .health-card {
  border: 1px solid var(--dashboard-border) !important;
  background: var(--dashboard-surface) !important;
}

.hero-insight-grid .health-card svg {
  color: #1d4ed8;
  opacity: 1;
}

.hero-insight-grid .health-card > div {
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  margin-bottom: 7px;
}

.hero-insight-grid .health-card > div svg {
  width: 22px;
  height: 22px;
  padding: 4px;
  border-radius: 8px;
  background: #eff6ff;
  color: #2563eb;
}

.hero-insight-grid .health-card strong {
  color: var(--dashboard-text);
}

.hero-insight-grid .health-card dt {
  color: var(--dashboard-muted);
}

.hero-insight-grid .health-card dd {
  color: #4b5563;
}

.command-center-panel {
  padding: 12px;
  border: 1px solid var(--dashboard-border);
  border-radius: 12px;
  background: var(--dashboard-surface);
  box-shadow: var(--dashboard-card-shadow);
}

.command-heading {
  align-items: center;
  margin-bottom: 10px;
}

.command-heading__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.command-shop-select {
  width: 150px;
}

.command-heading h2 {
  color: #0f172a;
  font-size: 15px;
}

.command-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 5px 7px;
  color: #64748b;
  font-size: 12px;
}

.command-summary b {
  color: #0f172a;
}

.command-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  align-items: start;
  gap: 8px;
}

.command-card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid #e5eaf2;
  border-radius: 8px;
  background: #ffffff;
}

.command-card__head {
  display: grid;
  width: 100%;
  min-height: 54px;
  gap: 2px;
  padding: 10px;
  border: 0;
  background: #f8fafc;
  text-align: left;
  cursor: pointer;
}

.command-card__head span {
  overflow: hidden;
  color: #64748b;
  font-size: 11px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-card__head strong {
  color: #0f172a;
  font-size: 14px;
  line-height: 1.2;
}

.command-card__list {
  display: grid;
  max-height: 430px;
  overflow: auto;
  padding: 6px;
}

.command-row {
  display: grid;
  grid-template-areas:
    "product actions"
    "reason actions";
  grid-template-columns: minmax(0, 1fr) 76px;
  align-items: center;
  min-height: 92px;
  gap: 7px 9px;
  padding: 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  text-align: left;
}

.command-row + .command-row {
  border-top: 1px solid #eef2f7;
  border-radius: 0;
}

.command-row:hover {
  background: #f8fafc;
}

.command-product {
  grid-area: product;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  align-items: center;
  width: 100%;
  min-width: 0;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.command-product img,
.command-product__placeholder {
  width: 36px;
  aspect-ratio: 3 / 4;
  height: auto;
  border-radius: 7px;
  object-fit: cover;
}

.command-product__placeholder {
  display: grid;
  place-items: center;
  color: #64748b;
  background: #eef2f7;
  font-size: 15px;
  font-weight: 800;
}

.command-product__info {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.command-product__info strong {
  display: -webkit-box;
  overflow: hidden;
  color: #0f172a;
  font-size: 12px;
  line-height: 1.28;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.command-product__info small {
  overflow: hidden;
  color: #64748b;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-reason {
  grid-area: reason;
  min-width: 0;
  padding: 5px 7px;
  border-radius: 6px;
  color: #475569;
  background: #f8fafc;
  font-size: 11px;
  line-height: 1.35;
}

.command-reason span {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.command-row__actions {
  grid-area: actions;
  display: flex;
  flex-direction: column;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.command-module {
  width: 100%;
  overflow: hidden;
  text-align: center;
  color: #64748b;
  font-size: 11px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-icon-button,
.command-action-button {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid #dbe4f0;
  border-radius: 7px;
  color: #2563eb;
  background: #ffffff;
  cursor: pointer;
}

.command-icon-button {
  width: 32px;
  height: 28px;
}

.command-action-button {
  gap: 4px;
  width: 72px;
  height: 28px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 700;
}

.command-icon-button:hover,
.command-action-button:hover {
  border-color: #bfdbfe;
  background: #eff6ff;
}

.command-empty {
  padding: 12px 8px;
  color: #94a3b8;
  font-size: 12px;
}

.command-card--danger .command-card__head {
  background: #fff1f2;
}

.command-card--success .command-card__head {
  background: #f0fdf4;
}

.command-card--warning .command-card__head {
  background: #fffbeb;
}

.command-card--primary .command-card__head {
  background: #eff6ff;
}

.command-card--muted .command-card__head {
  background: #f1f5f9;
}

.command-card--review .command-card__head {
  background: #f5f3ff;
}

.rail-panel {
  padding: 16px;
}

.panel-heading,
.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 14px;
}

.panel-heading span,
.section-heading span {
  display: block;
  color: #64748b;
  font-size: 12px;
  font-weight: 800;
}

.panel-heading h2,
.section-heading h2 {
  margin: 2px 0 0;
  color: #0f172a;
  font-size: 18px;
  line-height: 1.2;
}

.compact-list,
.opportunity-list,
.action-list,
.drawer-task-list {
  display: grid;
  gap: 10px;
}

.compact-item,
.opportunity-list article,
.action-item {
  display: grid;
  align-items: center;
  gap: 10px;
  border-radius: 10px;
  background: #f8fafc;
}

.compact-item {
  grid-template-columns: auto 1fr auto;
  padding: 11px;
}

.compact-item.is-danger {
  background: #fff1f2;
}

.compact-item.is-warning {
  background: #f1f5f9;
}

.compact-item.is-amber {
  background: #f8fafc;
}

.compact-item strong,
.opportunity-copy strong,
.action-item strong {
  color: #0f172a;
  font-size: 14px;
}

.compact-item p,
.opportunity-copy p,
.action-item p {
  margin: 3px 0 0;
  color: #64748b;
  font-size: 12px;
}

.opportunity-list article {
  grid-template-columns: auto 1fr;
  padding: 12px;
  background: linear-gradient(135deg, #f0fdf4, #f8fafc);
}

.opportunity-copy small {
  display: block;
  margin: 5px 0 9px;
  color: #15803d;
  font-size: 12px;
}

.ai-advice-strip {
  display: grid;
  grid-template-columns: 240px repeat(3, minmax(0, 1fr));
  gap: 10px;
  align-items: stretch;
  margin-top: 10px;
  padding: 12px;
}

.section-heading.compact {
  display: block;
  margin: 0;
}

.ai-advice-strip button {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 54px;
  padding: 12px;
  border: 0;
  border-radius: 10px;
  color: #1e293b;
  background: #eef4ff;
  text-align: left;
  cursor: pointer;
}

.ai-advice-strip button svg {
  flex: 0 0 auto;
  color: #2563eb;
}

.ops-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr);
  gap: 10px;
  margin-top: 10px;
}

.ops-grid-single {
  grid-template-columns: minmax(0, 1fr);
}

.action-panel,
.pressure-panel,
.health-panel {
  padding: 12px;
}

.action-item {
  grid-template-columns: 44px 1fr auto;
  padding: 10px;
}

.action-item b {
  display: grid;
  place-items: center;
  height: 32px;
  border-radius: 999px;
  color: #64748b;
  background: #e2e8f0;
  font-size: 12px;
}

.action-item.is-danger b {
  color: #fff;
  background: #e11d48;
}

.action-item.is-warning b {
  color: #334155;
  background: #cbd5e1;
}

.pressure-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.pressure-card {
  min-height: 88px;
  padding: 13px;
  border: 0;
  border-radius: 10px;
  background: #f8fafc;
  text-align: left;
  cursor: pointer;
}

.pressure-card strong {
  display: block;
  margin-top: 8px;
  color: #0f172a;
  font-size: 22px;
}

.pressure-card small {
  display: block;
  margin-top: 4px;
  color: #64748b;
}

.pressure-card.is-danger strong {
  color: #e11d48;
}

.pressure-card.is-warning strong {
  color: #d97706;
}

.pressure-card.is-blue strong {
  color: #2563eb;
}

.pressure-card.is-muted strong {
  color: #94a3b8;
}

.health-panel {
  margin-top: 14px;
}

.health-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 9px;
}

.health-card {
  align-content: start;
  align-self: stretch;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  padding: 12px;
  border: 1px solid #eef1f6;
  border-radius: 10px;
  background: #ffffff;
  text-align: left;
  cursor: pointer;
}

.health-card > div {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: #1f2937;
}

.health-card-list {
  display: grid;
  gap: 8px;
  margin: 0;
}

.health-card-label,
.health-card-value {
  margin: 0;
  font-size: 12px;
}

.health-card-list {
  grid-template-columns: 1fr auto;
}

.health-card-row {
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: 1fr auto;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
  border-radius: 7px;
  transition: background 0.18s ease, color 0.18s ease;
}

.health-card-row.is-static {
  cursor: default;
}

.health-card-row:not(.is-static):hover {
  background: #f1f5ff;
}

.health-card-row:hover .health-card-label,
.health-card-row:hover .health-card-value {
  color: #1d4ed8;
}

.health-card-label {
  color: #7b8497;
}

.health-card-value {
  color: #4b5563;
  font-weight: 600;
}

.health-card-value {
  display: inline-flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
  white-space: nowrap;
}

.health-card-value small {
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}

.health-card-value small.is-up {
  color: #22c55e;
}

.health-card-value small.is-down {
  color: #ef4444;
}

.health-card-value small.is-flat {
  color: #7b8497;
}

.drawer-intro {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-radius: 10px;
  color: #1e293b;
  background: #eef4ff;
}

.drawer-task-list {
  margin-top: 14px;
}

.drawer-task-list article {
  padding: 14px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
}

.drawer-task-list span {
  color: #2563eb;
  font-size: 12px;
  font-weight: 800;
}

.drawer-task-list h3 {
  margin: 6px 0 8px;
  color: #0f172a;
  font-size: 16px;
}

.drawer-task-list p,
.drawer-task-list small {
  display: block;
  margin: 5px 0;
  color: #64748b;
}

.drawer-task-list div {
  margin-top: 12px;
}

@media (max-width: 1280px) {
  .hero-grid,
  .ops-grid,
  .dashboard-overview-grid {
    grid-template-columns: 1fr;
  }

  .hero-rail {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

}

@media (max-width: 980px) {
  .hero-core-grid,
  .secondary-metric-grid,
  .ai-advice-strip,
  .health-grid,
  .command-grid {
    grid-template-columns: 1fr 1fr;
  }

  .ai-signal-panel,
  .section-heading.compact {
    grid-column: 1 / -1;
  }

  .hero-rail,
  .pressure-grid {
    grid-template-columns: 1fr;
  }

  .top-sku-list {
    grid-template-columns: 1fr;
    grid-template-rows: none;
    grid-auto-flow: row;
  }
}

@media (max-width: 640px) {
  .commerce-dashboard {
    padding: 12px;
  }

  .overview-panel {
    padding: 18px;
  }

  .overview-panel-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .overview-panel-heading small {
    text-align: left;
  }

  .top-sku-item {
    grid-template-columns: 24px 54px minmax(0, 1fr) 76px;
    gap: 9px;
    min-height: 72px;
    padding-inline: 8px;
  }

  .sku-image {
    width: 54px;
    height: 72px;
  }

  .sku-sales {
    gap: 8px;
    padding-left: 8px;
  }

  .operating-card {
    padding: 16px;
  }

  .hero-core-grid,
  .secondary-metric-grid,
  .ai-advice-strip,
  .ops-grid,
  .health-grid,
  .command-grid {
    grid-template-columns: 1fr;
  }

  .primary-metric strong {
    font-size: 34px;
  }

  .action-item,
  .compact-item {
    grid-template-columns: 1fr;
  }
}
</style>
