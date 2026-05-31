<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  Flame,
  PackageCheck,
  RefreshCw,
  Sparkles,
  Target,
  Zap
} from "lucide-vue-next";
import { apiClient } from "../utils/api";

const router = useRouter();
const loading = ref(false);
const refreshing = ref(false);
const hasDashboardLoaded = ref(false);
let dashboardSnapshotRefreshTimer = null;
const dashboard = ref({
  summary: {},
  commerce: {
    today: {},
    yesterday: {},
    advertising: { today: {}, yesterday: {} }
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
const profitTrend = computed(() => commerce.value.profit_trend || {});
const aftersalesLoss = computed(() => summary.value.aftersales_loss || {});
const fbpOpportunitySummary = computed(() => summary.value.fbp_opportunities || {});
const commerceShops = computed(() => Array.isArray(commerce.value.shops) ? commerce.value.shops : []);
const adShops = computed(() => Array.isArray(adToday.value.shops) ? adToday.value.shops : []);
const fbpAlerts = computed(() => Array.isArray(dashboard.value.alerts?.fbp) ? dashboard.value.alerts.fbp : []);
const fbpShortageAlerts = computed(() => fbpAlerts.value.filter((item) => ["out_of_stock", "within_7_days", "within_30_days"].includes(item.alert_type)));
const fbpSlowAlerts = computed(() => fbpAlerts.value.filter((item) => ["over_60_days", "no_sales"].includes(item.alert_type)));
const fbpOutOfStockCount = computed(() => fbpAlerts.value.filter((item) => item.alert_type === "out_of_stock").length);
const fbpWithin7Count = computed(() => fbpAlerts.value.filter((item) => item.alert_type === "within_7_days").length);
const fbpWithin30Count = computed(() => fbpAlerts.value.filter((item) => item.alert_type === "within_30_days").length);
const procurementRows = computed(() => Array.isArray(dashboard.value.alerts?.procurement) ? dashboard.value.alerts.procurement : []);
const initialDashboardLoading = computed(() => loading.value && !hasDashboardLoaded.value);
const dashboardUpdating = computed(() => refreshing.value && hasDashboardLoaded.value);

const urgentCount = computed(() => Number(summary.value.urgent_count || 0));
const stockWarningCount = computed(() => Number(summary.value.warning_count || 0));
const fbpShortageCount = computed(() => fbpShortageAlerts.value.length);
const fbpSlowCount = computed(() => fbpSlowAlerts.value.length);
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
    { label: "断货风险", value: metricNumber(fbpWithin30Count.value, "个"), alertType: "within_30_days" },
    { label: "库存滞缓", value: metricNumber(fbpSlowCount.value, "个"), alertType: "slow" },
    {
      label: "推荐备货FBP",
      value: metricNumber(fbpOpportunitySummary.value.total, "个"),
      route: "/inventory/fbp-opportunities",
      query: {}
    }
  ];
}

function aftersalesQuery(bucket = "all", openDetail = false) {
  const query = {
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
    from: dateKey,
    to: dateKey,
    shopId: "all",
    bucket,
    detailBucket: bucket
  };
}

function aftersalesLossRows() {
  return [
    {
      label: "本月总损失",
      value: metricMoney(aftersalesLoss.value.total_estimated_loss_cny),
      route: "/profit/aftersales",
      query: aftersalesQuery("all")
    },
    {
      label: "拒收/未取",
      value: metricMoney(aftersalesLoss.value.rejected_unclaimed_loss_cny),
      route: "/profit/aftersales",
      query: aftersalesQuery("rejected_unclaimed", true)
    },
    {
      label: "不合适/错发/破损",
      value: metricMoney(aftersalesLoss.value.unsuitable_wrong_damaged_loss_cny),
      route: "/profit/aftersales",
      query: aftersalesQuery("unsuitable_wrong_damaged", true)
    },
    {
      label: "质量问题",
      value: metricMoney(aftersalesLoss.value.quality_issue_loss_cny),
      route: "/profit/aftersales",
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
const adTooltipPopperOptions = {
  modifiers: [
    { name: "offset", options: { offset: [0, 8] } },
    { name: "flip", options: { fallbackPlacements: ["bottom", "top", "right", "left"] } },
    { name: "preventOverflow", options: { boundary: "viewport", padding: 12 } }
  ]
};

const profitDelta = computed(() => delta(today.value.profit, yesterday.value.profit));
const roiDelta = computed(() => delta(adToday.value.roi, adYesterday.value.roi));
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
  if (Number(today.value.profit || 0) < 0 || Number(adToday.value.roi || 0) < 1) return "danger";
  if (urgentCount.value || stockWarningCount.value > 0 || adCostJump.value) return "warning";
  return "success";
});

const operationReminder = computed(() => {
  const parts = [];
  if (Number(adToday.value.roi || 0) < 1) parts.push("广告ROI偏低");
  if (fbpShortageCount.value > 0) parts.push("FBP断货风险");
  if (fbpSlowCount.value > 0) parts.push("FBP库存滞缓");
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
    path: "/profit",
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
    path: "/profit/aftersales",
    query: todayAftersalesQuery("pre_fulfillment_cancel"),
    breakdownTitle: "各店铺今日取消",
    breakdown: shopBreakdown(commerceShops.value, "cancelled_revenue", metricMoney)
  },
  {
    label: "退货件数",
    value: metricNumber(today.value.return_quantity, " 件"),
    note: `${metricNumber(today.value.return_orders, " 单")} / ${metricMoney(today.value.return_revenue)}`,
    direction: Number(today.value.return_quantity || 0) > 0 ? "down" : "flat",
    icon: AlertTriangle,
    path: "/profit/aftersales",
    query: todayAftersalesQuery("rejected_unclaimed"),
    breakdownTitle: "各店铺今日退货",
    breakdown: shopBreakdown(commerceShops.value, "return_revenue", metricMoney)
  },
  {
    label: "待回款",
    value: metricMoney(today.value.pending_profit),
    note: "利润待确认",
    direction: "flat",
    icon: PackageCheck,
    path: "/profit",
    breakdownTitle: "各店铺待回款",
    breakdown: shopBreakdown(commerceShops.value, "pending_profit", metricMoney)
  },
  {
    label: "广告消耗",
    value: metricMoney(adToday.value.spend_cny),
    note: adDataFreshness.value.text,
    direction: adDataFreshness.value.direction,
    icon: Target,
    path: "/advertising/daily",
    breakdownTitle: "各店铺广告消耗",
    breakdown: shopBreakdown(adShops.value, "spend_cny", metricMoney)
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
    path: "/profit/aftersales"
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
    secondaryPath: "/asset-variant-center/create"
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
    reason: `${procurementCount.value} 个待采购商品`,
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
    route: "/profit/aftersales",
    query: aftersalesQuery("all"),
    icon: RefreshCw,
    items: aftersalesLossRows()
  },
  {
    title: "利润趋势",
    route: "/profit",
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
      ["待采购", metricNumber(procurementCount.value, "个")],
      ["下一步", opportunityCards.value[0]?.primary || "观察"]
    ]
  }
]);

async function loadDashboard(options = {}) {
  const forceRefresh = options === true || options?.refresh === true;
  const snapshotOnly = options?.snapshotOnly === true;
  const showInitialLoading = !hasDashboardLoaded.value;
  if (showInitialLoading) {
    loading.value = true;
  } else {
    refreshing.value = true;
  }
  try {
    const url = forceRefresh
      ? `/api/dashboard?refresh=1&_=${Date.now()}`
      : snapshotOnly
        ? `/api/dashboard?snapshotOnly=1&_=${Date.now()}`
        : "/api/dashboard";
    const res = await apiClient.get(url, forceRefresh ? { noCache: true, cache: "no-store" } : {});
    dashboard.value = {
      ...dashboard.value,
      ...(res || {}),
      commerce: {
        ...dashboard.value.commerce,
        ...(res?.commerce || {}),
        advertising: {
          ...dashboard.value.commerce.advertising,
          ...(res?.commerce?.advertising || {})
        }
      },
      alerts: {
        ...dashboard.value.alerts,
        ...(res?.alerts || {})
      }
    };
    hasDashboardLoaded.value = true;
    if (!forceRefresh && !snapshotOnly) scheduleDashboardSnapshotReload();
  } catch (error) {
    console.error(error);
    if (!showInitialLoading && !forceRefresh) return;
    ElMessage.error("首页摘要加载失败");
  } finally {
    if (showInitialLoading) {
      loading.value = false;
    } else {
      refreshing.value = false;
    }
  }
}

function scheduleDashboardSnapshotReload() {
  if (dashboardSnapshotRefreshTimer) window.clearTimeout(dashboardSnapshotRefreshTimer);
  dashboardSnapshotRefreshTimer = window.setTimeout(() => {
    dashboardSnapshotRefreshTimer = null;
    loadDashboard({ snapshotOnly: true });
  }, 2500);
}

function refreshDashboard() {
  loadDashboard({ refresh: true });
}

onMounted(loadDashboard);

onBeforeUnmount(() => {
  if (dashboardSnapshotRefreshTimer) window.clearTimeout(dashboardSnapshotRefreshTimer);
});
</script>

<template>
  <section v-loading="initialDashboardLoading" class="commerce-dashboard" :class="{ 'is-updating': dashboardUpdating }">
    <div class="hero-grid">
      <div class="operating-card" :class="`is-${businessTone}`">
        <div class="operating-card__top">
          <div>
            <div class="brand-pill">
              <Activity :size="14" />
              Ozon经营驾驶舱
            </div>
            <h1>今日经营总览</h1>
            <p>利润与广告 ROI 优先，AI 只提示关键经营信号。</p>
          </div>
          <span v-if="dashboardUpdating" class="refresh-status">
            <RefreshCw :size="13" />
            更新中
          </span>
          <el-button class="ghost-button" size="small" :loading="loading || refreshing" @click="refreshDashboard">
            <RefreshCw :size="14" />
            刷新
          </el-button>
        </div>

        <div class="hero-core-grid">
          <article class="primary-metric profit-card" @click="open('/profit')">
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
        </div>

        <div class="secondary-metric-grid">
          <el-tooltip v-for="item in secondaryMetrics" :key="item.label" placement="top" effect="light" popper-class="shop-breakdown-tooltip">
            <template #content>
              <div class="shop-breakdown">
                <h4>{{ item.breakdownTitle }}</h4>
                <div v-for="row in item.breakdown" :key="`${item.label}-${row.shop_name}`">
                  <span>{{ row.shop_name }}</span>
                  <strong>{{ row.text }}</strong>
                </div>
              </div>
            </template>
            <button type="button" @click="open(item.path, item.query || {})">
              <component :is="item.icon" :size="16" />
              <span>{{ item.label }}</span>
              <strong>{{ item.value }}</strong>
              <small :class="`is-${item.direction}`">{{ item.note }}</small>
            </button>
          </el-tooltip>
        </div>

        <div class="business-reminder">
          <Zap :size="15" />
          <span>今日提醒：{{ operationReminder }}</span>
        </div>

        <div class="hero-insight-grid">
          <section class="health-panel hero-health-panel">
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
                  <template v-for="row in card.items" :key="row.alertType || row.label || row[0]">
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
  position: relative;
  min-height: 100%;
  padding: 12px;
  background: #f5f7fb;
  color: #1f2937;
}

button {
  font: inherit;
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
  color: #111827;
  background: #f8c36a;
  font-size: 12px;
}

.hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  align-items: stretch;
}

.operating-card {
  position: relative;
  overflow: hidden;
  min-height: 0;
  padding: 14px;
  border: 1px solid #eef1f6;
  border-radius: 12px;
  color: #1f2937;
  background: #ffffff;
  box-shadow: 0 4px 14px rgba(31, 41, 55, 0.04);
}

.operating-card.is-danger {
  background: #ffffff;
}

.operating-card.is-warning {
  background: #ffffff;
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

.operating-card__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

.brand-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  margin-bottom: 8px;
  padding: 4px 10px;
  border: 1px solid #dedbff;
  border-radius: 999px;
  color: #6258f6;
  background: #f0efff;
  font-size: 12px;
  font-weight: 700;
}

.operating-card h1 {
  margin: 0;
  color: #1f2937;
  font-size: 22px;
  font-weight: 700;
  line-height: 1.18;
  letter-spacing: 0;
}

.operating-card p {
  margin: 6px 0 0;
  color: #7b8497;
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
  color: #4b5563;
  background: #f3f5f9;
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
  --el-button-border-color: #e7eaf3;
  --el-button-text-color: #4b5563;
  --el-button-hover-bg-color: #f0efff;
  --el-button-hover-border-color: #6258f6;
  --el-button-hover-text-color: #6258f6;
}

.hero-core-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(220px, 1fr));
  gap: 10px;
  margin-bottom: 10px;
}

.primary-metric,
.ai-signal-panel,
.secondary-metric-grid button {
  border: 1px solid #eef1f6;
  border-radius: 10px;
  background: #ffffff;
  box-shadow: none;
}

.primary-metric {
  min-height: 124px;
  padding: 16px;
  cursor: pointer;
}

.profit-card {
  background: #ffffff;
}

.roi-card {
  background: #ffffff;
}

.inventory-value-card {
  background: #ffffff;
}

.metric-label {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #7b8497;
  font-size: 13px;
  font-weight: 700;
}

.primary-metric strong {
  display: block;
  margin-top: 12px;
  color: #f97316;
  font-size: 36px;
  line-height: 1;
}

.roi-card strong {
  color: #60a5fa;
}

.inventory-value-card strong {
  color: #14b8a6;
}

.metric-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.metric-footer em {
  padding: 3px 8px;
  border-radius: 999px;
  color: #7b8497;
  background: #f3f5f9;
  font-size: 12px;
  font-style: normal;
}

.metric-footer .freshness {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 3px 8px;
  border-radius: 999px;
  background: #f3f5f9;
  font-size: 12px;
  font-weight: 800;
}

.metric-footer .freshness.is-success {
  color: #15803d;
  background: #ecfdf3;
}

.metric-footer .freshness.is-warning {
  color: #b45309;
  background: #fff7e6;
}

.metric-footer .freshness.is-danger {
  color: #ef4444;
  background: #fff1f1;
}

.delta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 700;
}

.delta.is-up,
.secondary-metric-grid small.is-up {
  color: #22c55e;
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
  background: #f59e0b;
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
  color: #6258f6;
}

.secondary-metric-grid span,
.pressure-card span {
  display: block;
  margin-top: 8px;
  color: #7b8497;
  font-size: 12px;
}

:global(.shop-breakdown-tooltip) {
  max-width: 280px;
  border: 0 !important;
  border-radius: 10px !important;
  box-shadow: 0 16px 34px rgba(15, 23, 42, 0.18) !important;
}

:global(.ad-breakdown-tooltip) {
  max-width: min(720px, calc(100vw - 32px));
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
}

:global(.shop-breakdown strong) {
  color: #0f172a;
  white-space: nowrap;
}

:global(.ad-breakdown) {
  width: min(680px, calc(100vw - 48px));
  min-width: 0;
}

:global(.ad-breakdown-table) {
  display: block !important;
  width: 100%;
  gap: 0;
}

:global(.ad-breakdown-row) {
  display: grid !important;
  grid-template-columns: minmax(112px, 1.5fr) repeat(6, minmax(58px, 0.75fr));
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid #eef2f7;
}

:global(.ad-breakdown-head) {
  padding-top: 0;
  color: #64748b;
  font-size: 11px;
  font-weight: 800;
}

:global(.ad-breakdown-row strong),
:global(.ad-breakdown-row b),
:global(.ad-breakdown-row span) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.ad-breakdown-row strong) {
  color: #334155;
  font-size: 12px;
}

:global(.ad-breakdown-row b) {
  color: #0f172a;
  font-size: 12px;
  text-align: right;
}

:global(.ad-breakdown-head span) {
  text-align: right;
}

:global(.ad-breakdown-head span:first-child) {
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
  margin-top: 10px;
  padding: 0 12px;
  border: 1px solid #ffe6a6;
  border-radius: 8px;
  color: #b45309;
  background: #fff7e6;
  font-size: 13px;
  font-weight: 600;
}


.hero-insight-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  margin-top: 10px;
}

.hero-health-panel {
  padding: 14px;
  border: 1px solid #eef1f6;
  border-radius: 12px;
  background: #ffffff;
  box-shadow: none;
}

.hero-health-panel {
  box-shadow: none;
}

.hero-health-panel .section-heading {
  margin-bottom: 10px;
}

.hero-health-panel .section-heading h2 {
  color: #6258f6;
  font-size: 14px;
  font-weight: 600;
}

.hero-health-panel .section-heading span {
  color: #7b8497;
}

.hero-insight-grid .health-grid {
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
}

.hero-insight-grid .health-card {
  border: 1px solid #eef1f6;
  border-radius: 10px;
  background: #ffffff;
  box-shadow: none;
}

.hero-insight-grid .health-card {
  min-height: 118px;
  padding: 12px;
}

.hero-insight-grid .health-card svg {
  color: #6258f6;
  opacity: 1;
}

.hero-insight-grid .health-card strong {
  color: #1f2937;
  font-size: 13px;
}

.hero-insight-grid .health-card dt {
  color: #7b8497;
}

.hero-insight-grid .health-card dd {
  color: #4b5563;
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
  border: 1px solid #eef1f6;
  background: #ffffff;
  box-shadow: none;
}

.hero-insight-grid .health-card {
  border: 1px solid #eef1f6;
  background: #ffffff;
}

.hero-insight-grid .health-card svg {
  color: #6258f6;
  opacity: 1;
}

.hero-insight-grid .health-card > div {
  flex-direction: column;
  align-items: flex-start;
  gap: 7px;
  margin-bottom: 12px;
}

.hero-insight-grid .health-card > div svg {
  width: 28px;
  height: 28px;
  padding: 5px;
  border-radius: 8px;
  background: #f0efff;
}

.hero-insight-grid .health-card strong {
  color: #1f2937;
}

.hero-insight-grid .health-card dt {
  color: #7b8497;
}

.hero-insight-grid .health-card dd {
  color: #4b5563;
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
  background: #fff7ed;
}

.compact-item.is-amber {
  background: #fefce8;
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
  color: #78350f;
  background: #fbbf24;
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
  gap: 12px;
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
}

.health-card-row:hover .health-card-label,
.health-card-row:hover .health-card-value {
  color: #6258f6;
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
  .ops-grid {
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
  .health-grid {
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
}

@media (max-width: 640px) {
  .commerce-dashboard {
    padding: 12px;
  }

  .operating-card {
    padding: 16px;
  }

  .hero-core-grid,
  .secondary-metric-grid,
  .ai-advice-strip,
  .ops-grid,
  .health-grid {
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
