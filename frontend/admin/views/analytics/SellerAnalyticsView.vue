<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, Refresh, Search, VideoPlay } from "@element-plus/icons-vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import {
  batchDeleteSellerAnalyticsSnapshots,
  createSellerAnalyticsCollectRun,
  deleteSellerAnalyticsCollectRun,
  deleteSellerAnalyticsSnapshot,
  getSellerAnalyticsAnalysis,
  getSellerAnalyticsCollectRuns,
  getSellerAnalyticsSnapshots,
  retrySellerAnalyticsCollectRun
} from "../../api/sellerAnalytics";
import { apiClient } from "../../utils/api";

const ANALYTICS_PAGE_SIZE = 30;
const DATE_CACHE_KEY = "ozon-erp:seller-analytics:date-filter";
const sourceTabs = [
  { label: "全部页签", value: "" },
  { label: "数据概览", value: "overview" },
  { label: "所有指标", value: "all_metrics" },
  { label: "销售漏斗", value: "funnel" },
  { label: "热销榜单", value: "hot" },
  { label: "搜索", value: "search" },
  { label: "ABC", value: "abc" },
  { label: "需要推广", value: "need_promotion" },
  { label: "卡片质量", value: "card_quality" }
];
const periods = [
  { label: "今天", value: "today" },
  { label: "昨天", value: "yesterday" },
  { label: "近 7 天", value: "7d" },
  { label: "近 28 天", value: "28d" },
  { label: "本季度", value: "quarter" },
  { label: "今年", value: "year" },
  { label: "自定义", value: "custom" }
];
const metricGroups = [
  {
    title: "销售",
    children: [
      { key: "revenue", label: "订购金额", unit: " ₽", dynamicsKey: "revenueDynamics", tooltip: "已订购商品的总价格，取消和退货包括在内。第二个数字为与前期相比的动态。" },
      { key: "revenueShare", label: "订单金额份额", type: "percent", percentPrecision: 0, dynamicsKey: "revenueShareDynamics", tooltip: "商品在当前订单总额中的占比。第二个数字为与前期相比的动态。" },
      { key: "orderedUnits", label: "已订购商品", dynamicsKey: "orderedUnitsDynamics", tooltip: "买家已订购的商品数量。第二个数字为与前期相比的动态。" },
      { key: "deliveredUnits", label: "已送货商品", dynamicsKey: "deliveredUnitsDynamics", tooltip: "已送达买家的商品数量。第二个数字为与前期相比的动态。" },
      { key: "convOrderToAccepted", label: "订单到认购转化", type: "percent", percentPrecision: 0, dynamicsKey: "convOrderToAcceptedDynamics", tooltip: "认购商品数量与订购数量之间的比率。接口没有直接返回时，ERP 使用（订购 - 取消 - 退货）/ 订购本地计算。" },
      { key: "acceptedUnits", label: "已认购商品", dynamicsKey: "acceptedUnitsDynamics", tooltip: "最终认购的商品数量。接口没有直接返回时，ERP 使用订购数量减去取消和退货本地计算。" },
      { key: "cancelledUnits", label: "已取消商品", dynamicsKey: "cancelledUnitsDynamics", tooltip: "在下单日期口径下被取消的商品数量。第二个数字为与前期相比的动态。" },
      { key: "returnedUnits", label: "已退货商品", dynamicsKey: "returnedUnitsDynamics", tooltip: "在下单日期口径下被退货的商品数量。第二个数字为与前期相比的动态。" },
      { key: "cancelledUnitsByOrderDate", label: "已取消商品（下单日）", dynamicsKey: "cancelledUnitsByOrderDateDynamics", tooltip: "按下单日期统计的取消商品数量。第二个数字为与前期相比的动态。" },
      { key: "returnedUnitsByOrderDate", label: "已退货商品（下单日）", dynamicsKey: "returnedUnitsByOrderDateDynamics", tooltip: "按下单日期统计的退货商品数量。第二个数字为与前期相比的动态。" }
    ]
  },
  {
    title: "曝光 / 搜索",
    children: [
      { key: "searchPosition", label: "搜索位置", dynamicsKey: "searchPositionDynamics", lowerIsBetter: true, tooltip: "商品曾在搜索结果和 Ozon 目录中显示的平均位置，筛选器和排序后均纳入计算。数值为 0 时表示该期间内商品没有展示过。" },
      { key: "totalViews", label: "总展示次数", dynamicsKey: "totalViewsDynamics", tooltip: "买家看到商品的总次数，包含 Ozon 页面展示和商品卡片访问。第二个数字为与前期相比的动态。" },
      { key: "searchViews", label: "搜索/目录展示", dynamicsKey: "searchViewsDynamics", tooltip: "买家在搜索结果和 Ozon 目录中看到商品的次数。第二个数字为与前期相比的动态。" },
      { key: "convSearchViewsToPdp", label: "搜索/目录进卡转化", type: "percent", dynamicsKey: "convSearchViewsToPdpDynamics", tooltip: "商品卡片浏览次数与搜索结果和目录中的展示次数之间的比率。第二个数字为与前期相比的动态。" }
    ]
  },
  {
    title: "商品卡片",
    children: [
      { key: "pdpViews", label: "商品卡片访问", dynamicsKey: "pdpViewsDynamics", tooltip: "买家转至商品卡片的次数。第二个数字为与前期相比的动态。" },
      { key: "convViewsToOrder", label: "总展示到订单转化", type: "percent", dynamicsKey: "convViewsToOrderDynamics", tooltip: "订单与 Ozon 所有页面中商品展示次数之间的比率。第二个数字为与前期相比的动态。" },
      { key: "convPdpViewsToCart", label: "卡片加购转化", type: "percent", dynamicsKey: "convPdpViewsToCartDynamics", tooltip: "从商品卡片中添加至购物车的次数与商品卡片展示次数之间的比率。第二个数字为与前期相比的动态。" }
    ]
  },
  {
    title: "购物车",
    children: [
      { key: "searchAddToCart", label: "搜索加购", dynamicsKey: "searchAddToCartDynamics", tooltip: "商品从搜索结果和目录中被添加至购物车的次数。第二个数字为与前期相比的动态。" },
      { key: "pdpAddToCart", label: "卡片加购", dynamicsKey: "pdpAddToCartDynamics", tooltip: "商品从商品卡片被添加到购物车的次数。第二个数字为与前期相比的动态。" },
      { key: "totalAddToCart", label: "加购总计", dynamicsKey: "totalAddToCartDynamics", tooltip: "商品从各入口被添加到购物车的总次数。第二个数字为与前期相比的动态。" },
      { key: "convSearchViewsToCart", label: "搜索到加购转化", type: "percent", dynamicsKey: "convSearchViewsToCartDynamics", tooltip: "添加至购物车的次数与搜索结果和目录中的展示次数之间的比率。第二个数字为与前期相比的动态。" },
      { key: "convTotalViewsToCart", label: "总加购转化", type: "percent", dynamicsKey: "convTotalViewsToCartDynamics", tooltip: "所有添加至购物车的次数与商品总展示次数之间的比率。第二个数字为与前期相比的动态。" },
      { key: "convHitsToCartToOrder", label: "购物车到订单转化", type: "percent", dynamicsKey: "convHitsToCartToOrderDynamics", tooltip: "订单与添加至购物车次数之间的比率。第二个数字为与前期相比的动态。" }
    ]
  },
  {
    title: "价格 / ABC / 推广",
    children: [
      { key: "abcAnalysis", label: "ABC分析", type: "abcPair", tooltip: "根据订购金额和订购数量划分的 ABC 等级。第一个为金额等级，第二个为数量等级。" },
      { key: "abcRevenue", label: "金额 ABC", type: "text", tooltip: "按订购金额贡献划分的 ABC 等级：A 通常贡献最高，B 次之，C 较低。" },
      { key: "abcQuantity", label: "数量 ABC", type: "text", tooltip: "按订购数量划分的 ABC 等级，用于区分高频成交商品和低频商品。" },
      { key: "avgPrice", label: "平均价格", unit: " ₽", dynamicsKey: "avgPriceDynamics", tooltip: "该周期商品的平均成交价格。第二个数字为与前期相比的动态。" },
      { key: "discountShare", label: "折扣占比", type: "percent", percentPrecision: 0, dynamicsKey: "discountShareDynamics", tooltip: "根据您的价格计算的折扣占比。第二个数字为与前期相比的动态。" },
      { key: "discountShareMedian", label: "中位价折扣", type: "percent", percentPrecision: 0, dynamicsKey: "discountShareMedianDynamics", tooltip: "相对中位价格计算的折扣占比。第二个数字为与前期相比的动态。" },
      { key: "priceIndex", label: "价格指数", type: "priceIndex", tooltip: "当前价格竞争力标记，例如有利、不利或没有指数。" },
      { key: "promotionDays", label: "促销天数", type: "daysInPeriod", tooltip: "商品在所选周期内处于促销活动中的天数。只展示 Ozon 接口返回的 daysInPromo，不再用折扣占比推断。" },
      { key: "drr", label: "广告收入占比", type: "percent", percentPrecision: 0, dynamicsKey: "drrDynamics", tooltip: "总推广支出与订购金额之间的比率。第二个数字为与前期相比的动态。" },
      { key: "cpcPromotionDays", label: "推广天数", type: "daysInPeriod", tooltip: "商品在所选周期内有按点击付费推广的天数。只展示 Ozon 接口返回的 daysInTrafarets。" },
      { key: "reviewCount", label: "评价", tooltip: "商品评价数量；当前 analytics 接口未返回时显示 0。" },
      { key: "productRating", label: "商品评级", tooltip: "商品评分；当前 analytics 接口未返回时显示 0。" }
    ]
  },
  {
    title: "库存",
    children: [
      { key: "lastStock", label: "当前库存", tooltip: "采集数据中返回的最近库存值。" },
      { key: "stockoutDays", label: "缺货天数", tooltip: "当前周期内商品缺货的天数。" },
      { key: "recommendedSupply", label: "建议补货", tooltip: "Ozon 返回的建议补货数量。" }
    ]
  }
];
const metricKeysBySourceTab = {
  overview: ["revenue", "searchPosition", "searchViews", "pdpViews", "convPdpViewsToCart", "orderedUnits", "cancelledUnitsByOrderDate", "returnedUnitsByOrderDate"],
  funnel: ["revenue", "searchViews", "pdpViews", "pdpAddToCart", "orderedUnits"],
  hot: ["revenue", "orderedUnits"],
  search: ["searchPosition", "searchViews", "orderedUnits"],
  abc: ["abcAnalysis", "revenue", "revenueShare", "totalViews", "orderedUnits", "avgPrice", "discountShare", "priceIndex", "drr"],
  need_promotion: ["searchPosition", "totalViews", "pdpViews", "convPdpViewsToCart", "orderedUnits"],
  card_quality: ["revenue", "pdpViews", "convPdpViewsToCart", "orderedUnits"]
};

const loading = ref(false);
const collecting = ref(false);
const activePane = ref("diagnosis");
const shops = ref([]);
const analysis = ref({ summary: {}, products: [], focusProducts: [], recommendations: [], totalsRow: null, totalsBySource: {} });
const snapshots = ref([]);
const collectRuns = ref([]);
const selectedSnapshotIds = ref([]);
const rawDialog = reactive({ visible: false, title: "", content: "" });
const funnelDialog = reactive({ visible: false, row: null });
const selectedIssueInsight = reactive({ visible: false, item: null });
const state = reactive({
  page: 1,
  sortKey: "score",
  sortOrder: "desc",
  filters: {
    shopId: "",
    tabKey: "",
    periodKey: "7d",
    dateRange: [],
    keyword: ""
  }
});
let pollTimer = 0;

const periodParams = computed(() => {
  const params = { period_key: state.filters.periodKey };
  if (state.filters.periodKey === "custom" && state.filters.dateRange?.length === 2) {
    params.date_from = state.filters.dateRange[0];
    params.date_to = state.filters.dateRange[1];
  }
  return params;
});
const summary = computed(() => analysis.value?.summary || {});
const totalProductCount = computed(() => Number(summary.value.productCount || 0));
const nextCollectPage = computed(() => Math.max(1, Number(summary.value.nextCollectPage || 1)));
const products = computed(() => Array.isArray(analysis.value?.products) ? analysis.value.products : []);
const tableProducts = computed(() => (
  analysis.value?.totalsRow ? [analysis.value.totalsRow, ...products.value] : products.value
));
const visibleMetricGroups = computed(() => {
  const rows = tableProducts.value;
  const allowedKeys = metricKeysBySourceTab[state.filters.tabKey] ? new Set(metricKeysBySourceTab[state.filters.tabKey]) : null;
  return metricGroups
    .map((group) => ({
      ...group,
      children: group.children.filter((metric) => {
        if (state.filters.tabKey === "all_metrics" && ["abcAnalysis", "abcRevenue", "abcQuantity"].includes(metric.key)) return false;
        if (allowedKeys && !allowedKeys.has(metric.key)) return false;
        return rows.some((product) => {
          if (metric.type === "abcPair") {
            return hasMetricValue(product.metrics, "abcRevenue") || hasMetricValue(product.metrics, "abcQuantity");
          }
          return hasMetricValue(product.metrics, metric.key) || hasMetricValue(product.metrics, metric.dynamicsKey);
        });
      })
    }))
    .filter((group) => group.children.length > 0);
});
const focusProducts = computed(() => Array.isArray(analysis.value?.focusProducts) ? analysis.value.focusProducts : []);
const recommendations = computed(() => Array.isArray(analysis.value?.recommendations) ? analysis.value.recommendations : []);
const runningRun = computed(() => collectRuns.value.find((run) => ["pending", "running"].includes(run.status)));
const progressPercent = computed(() => {
  const run = runningRun.value;
  if (!run) return 0;
  const total = Math.max(1, Number(run.request_count || 0));
  return Math.round(((Number(run.completed_count || 0) + Number(run.failed_count || 0)) / total) * 100);
});
const latestText = computed(() => formatDateTime(summary.value.latestCapturedAt));
const periodHint = computed(() => {
  const range = state.filters.periodKey === "custom" && state.filters.dateRange?.length === 2
    ? `${state.filters.dateRange[0]} ~ ${state.filters.dateRange[1]}`
    : periods.find((item) => item.value === state.filters.periodKey)?.label || state.filters.periodKey;
  return `${range} · 本地第 ${state.page} 页 · 已采集 ${summary.value.collectedPageCount || 0} 页`;
});
const actionInsights = computed(() => {
  const rows = (focusProducts.value.length ? focusProducts.value : products.value).filter((row) => !row.isTotalsRow);
  const labelOf = (row) => row.product_name || row.offer_id || row.sku || "-";
  const insight = ({ key, title, tone, emptyText, match, text }) => {
    const matched = rows
      .filter(match)
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(b.metrics?.revenue || 0) - Number(a.metrics?.revenue || 0));
    return {
      key,
      title,
      tone: matched.length ? tone : "success",
      count: matched.length,
      text: matched[0] ? text(matched[0], labelOf(matched[0])) : emptyText,
      products: matched,
      previewProducts: matched.slice(0, 3)
    };
  };
  return [
    insight({
      key: "high",
      title: "先处理",
      tone: "danger",
      emptyText: "暂无高优先级商品",
      match: (row) => row.priority === "high",
      text: (row, label) => `${label}：${row.recommendations?.[0]?.action || "查看诊断"}`
    }),
    insight({
      key: "low-exposure",
      title: "搜不到/曝光低",
      tone: "warning",
      emptyText: "暂无明显曝光不足",
      match: (row) => ((row.metrics?.searchViews || row.metrics?.totalViews || 0) < 20) && (row.metrics?.orderedUnits || 0) <= 0,
      text: (row, label) => `${label} 需要校准类目、类型和核心属性`
    }),
    insight({
      key: "no-click",
      title: "有流量无点击",
      tone: "warning",
      emptyText: "暂无明显点击浪费",
      match: (row) => ((row.metrics?.searchViews || 0) >= 100 || (row.metrics?.totalViews || 0) >= 200) && (row.metrics?.pdpViews || 0) <= 10,
      text: (row, label) => `${label} 有曝光但卡片访问少`
    }),
    insight({
      key: "traffic",
      title: "有流量无成交",
      tone: "warning",
      emptyText: "暂无明显流量浪费",
      match: (row) => ((row.metrics?.searchViews || 0) >= 100 || (row.metrics?.totalViews || 0) >= 200) && (row.metrics?.orderedUnits || 0) <= 0,
      text: (row, label) => `${label} 需要拆查点击、加购和下单三段`
    }),
    insight({
      key: "card",
      title: "卡片承接弱",
      tone: "warning",
      emptyText: "卡片转化暂未见明显异常",
      match: (row) => (row.metrics?.pdpViews || 0) >= 20 && Number(row.metrics?.convPdpViewsToCart || 0) < 5,
      text: (row, label) => `${label} 卡片访问不低但加购弱`
    }),
    insight({
      key: "order",
      title: "加购未下单",
      tone: "danger",
      emptyText: "暂无明显加购流失",
      match: (row) => (row.metrics?.addToCart || row.metrics?.totalAddToCart || 0) > 0 && (row.metrics?.orderedUnits || 0) <= 0,
      text: (row, label) => `${label} 需要检查价格、运费、优惠门槛和配送`
    }),
    insight({
      key: "decline",
      title: "销量下滑",
      tone: "danger",
      emptyText: "暂无明显下滑信号",
      match: (row) => Number(row.metrics?.revenueDynamics || 0) <= -50 || Number(row.metrics?.orderedUnitsDynamics || 0) <= -50,
      text: (row, label) => `${label} 近期下滑明显`
    }),
    insight({
      key: "stock",
      title: "库存风险",
      tone: "warning",
      emptyText: "暂无补货风险",
      match: (row) => (row.metrics?.stockoutDays || 0) > 0 || (row.metrics?.recommendedSupply || 0) > 0,
      text: (row, label) => `${label} 存在断货/补货信号`
    }),
    insight({
      key: "profit",
      title: "利润风险",
      tone: "danger",
      emptyText: "暂无明显利润风险",
      match: (row) => row.recommendations?.some((item) => item.type === "利润表现"),
      text: (row, label) => `${label} 需要检查售价、折扣、成本或广告空间`
    }),
    insight({
      key: "after-sale",
      title: "售后风险",
      tone: "warning",
      emptyText: "暂无明显售后风险",
      match: (row) => row.recommendations?.some((item) => item.type === "售后表现"),
      text: (row, label) => `${label} 需要检查描述、尺寸、包装或质量`
    })
  ].sort((a, b) => Number(b.count || 0) - Number(a.count || 0));
});
const maxActionInsightCount = computed(() => Math.max(1, ...actionInsights.value.map((item) => Number(item.count || 0))));
const quadrantStats = computed(() => {
  const rows = focusProducts.value.length ? focusProducts.value : products.value;
  const exposureValues = rows.map((row) => Number(row.metrics?.totalViews || row.metrics?.searchViews || row.metrics?.pdpViews || 0));
  const orderValues = rows.map((row) => Number(row.metrics?.orderedUnits || row.metrics?.acceptedUnits || 0));
  const exposureMedian = median(exposureValues);
  const orderMedian = median(orderValues);
  const result = [
    { key: "scale", label: "放量", count: 0, tone: "success" },
    { key: "conversion", label: "优化转化", count: 0, tone: "warning" },
    { key: "traffic", label: "补流量", count: 0, tone: "primary" },
    { key: "low", label: "低优先级", count: 0, tone: "info" }
  ];
  for (const row of rows) {
    const exposure = Number(row.metrics?.totalViews || row.metrics?.searchViews || row.metrics?.pdpViews || 0);
    const orders = Number(row.metrics?.orderedUnits || row.metrics?.acceptedUnits || 0);
    const bucket = exposure >= exposureMedian && orders >= orderMedian
      ? "scale"
      : exposure >= exposureMedian
        ? "conversion"
        : orders >= orderMedian
          ? "traffic"
          : "low";
    result.find((item) => item.key === bucket).count += 1;
  }
  return result;
});

function todayKey(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function median(values) {
  const list = values.filter((item) => Number.isFinite(item)).sort((a, b) => a - b);
  if (!list.length) return 0;
  return list[Math.floor(list.length / 2)];
}

function loadCachedFilter() {
  try {
    const cached = JSON.parse(localStorage.getItem(DATE_CACHE_KEY) || "{}");
    if (cached.periodKey) state.filters.periodKey = cached.periodKey;
    if (Array.isArray(cached.dateRange)) state.filters.dateRange = cached.dateRange;
  } catch {}
}

function cacheFilter() {
  localStorage.setItem(DATE_CACHE_KEY, JSON.stringify({
    periodKey: state.filters.periodKey,
    dateRange: state.filters.dateRange
  }));
}

async function loadShops() {
  shops.value = (await apiClient.get("/api/shops")).filter((shop) => shop.status !== "deleted");
  const first = shops.value.find((shop) => shop.is_default || shop.default) || shops.value[0];
  if (!state.filters.shopId && first) state.filters.shopId = String(first.id);
}

async function refreshData(silent = false) {
  if (!silent) loading.value = true;
  try {
    cacheFilter();
    const params = {
      ...periodParams.value,
      tab_key: state.filters.tabKey,
      keyword: state.filters.keyword,
      page: state.page,
      product_limit: ANALYTICS_PAGE_SIZE,
      sort_key: state.sortKey,
      sort_order: state.sortOrder,
      limit: 1000
    };
    const [nextAnalysis, nextSnapshots, nextRuns] = await Promise.all([
      getSellerAnalyticsAnalysis(params),
      getSellerAnalyticsSnapshots({ ...periodParams.value, limit: 100 }),
      getSellerAnalyticsCollectRuns({ limit: 30 })
    ]);
    analysis.value = nextAnalysis || analysis.value;
    snapshots.value = Array.isArray(nextSnapshots) ? nextSnapshots : [];
    collectRuns.value = Array.isArray(nextRuns) ? nextRuns : [];
  } finally {
    loading.value = false;
  }
}

function handleSearch() {
  state.page = 1;
  refreshData();
}

function handlePageChange(page) {
  state.page = Math.max(1, Number(page || 1));
  refreshData();
}

async function handleCollect(page = nextCollectPage.value) {
  if (state.filters.keyword.trim()) {
    ElMessage.info("关键词搜索只查询已保存数据，不创建插件采集批次");
    return refreshData();
  }
  const targetPage = Math.max(1, Number(page || nextCollectPage.value || 1));
  collecting.value = true;
  try {
    const result = await createSellerAnalyticsCollectRun({
      ...periodParams.value,
      source_keys: state.filters.tabKey ? [state.filters.tabKey] : sourceTabs.slice(1).map((item) => item.value),
      page: targetPage,
      store_id: state.filters.shopId,
      company_id: state.filters.shopId
    });
    ElMessage.success(result?.data?.reused ? "已存在进行中的采集批次" : "已创建采集批次，请保持插件开启");
    await refreshData(true);
  } finally {
    collecting.value = false;
  }
}

async function collectNextPage() {
  await handleCollect(nextCollectPage.value);
}

async function retryRun(row) {
  const result = await retrySellerAnalyticsCollectRun(row.id);
  ElMessage.success(`已重置 ${result?.data?.resetCount || 0} 个请求`);
  await refreshData(true);
}

async function removeRun(row) {
  await ElMessageBox.confirm("删除未完成采集批次？成功批次不能删除。", "删除批次", { type: "warning" });
  await deleteSellerAnalyticsCollectRun(row.id);
  ElMessage.success("已删除批次");
  await refreshData(true);
}

async function removeSnapshot(row) {
  await ElMessageBox.confirm("删除该快照会同步删除解析出的商品指标。", "删除快照", { type: "warning" });
  await deleteSellerAnalyticsSnapshot(row.id);
  ElMessage.success("已删除快照");
  await refreshData(true);
}

async function removeSelectedSnapshots() {
  if (!selectedSnapshotIds.value.length) return;
  await ElMessageBox.confirm(`批量删除 ${selectedSnapshotIds.value.length} 条快照？`, "批量删除", { type: "warning" });
  await batchDeleteSellerAnalyticsSnapshots(selectedSnapshotIds.value);
  selectedSnapshotIds.value = [];
  ElMessage.success("已批量删除");
  await refreshData(true);
}

function showRaw(row) {
  rawDialog.title = row.source_button_label || row.tab_key || "源数据";
  rawDialog.content = JSON.stringify(parseJson(row.response_body || row.raw_data), null, 2);
  rawDialog.visible = true;
}

function showFunnel(row) {
  funnelDialog.row = row;
  funnelDialog.visible = true;
}

function openIssueInsight(item) {
  selectedIssueInsight.item = item;
  selectedIssueInsight.visible = true;
}

function recommendationTone(item) {
  const text = `${item?.type || ""} ${item?.action || ""} ${item?.reason || ""}`;
  if (/利润|成本|DRR|价格|广告/.test(text)) return "danger";
  if (/库存|补货|断货/.test(text)) return "warning";
  if (/搜索|曝光|流量|搜不到/.test(text)) return "traffic";
  if (/转化|点击|卡片|加购|下单/.test(text)) return "conversion";
  if (/售后|退货|取消|评价|评分/.test(text)) return "after-sale";
  return "info";
}

function recommendationTagType(item) {
  const tone = recommendationTone(item);
  if (tone === "danger") return "danger";
  if (tone === "warning") return "warning";
  if (tone === "traffic") return "primary";
  if (tone === "conversion") return "success";
  return "info";
}

function parseJson(value) {
  if (!value) return value;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatMetric(value, type = "") {
  if (value === undefined || value === null || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (type === "money") return `${number.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ₽`;
  if (type === "percent") return `${number.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`;
  if (type === "int") return Math.round(number).toLocaleString("zh-CN");
  return number.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function formatPercent(value, options = {}) {
  if (value === undefined || value === null || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  const precision = Number.isFinite(Number(options.precision)) ? Number(options.precision) : 2;
  const prefix = options.sign && number > 0 ? "+" : "";
  return `${prefix}${number.toLocaleString("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: precision })}%`;
}

function getFirstMetricValue(metrics, keys) {
  for (const key of keys) {
    const value = metrics?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function getProductFunnelStages(row) {
  const metrics = row?.metrics || {};
  return [
    { key: "exposure", label: "曝光", value: getFirstMetricValue(metrics, ["totalViews", "searchViews"]), helper: "总展示/搜索展示" },
    { key: "click", label: "点击", value: getFirstMetricValue(metrics, ["pdpViews"]), helper: "商品卡片访问" },
    { key: "cart", label: "加购", value: getFirstMetricValue(metrics, ["totalAddToCart", "pdpAddToCart", "searchAddToCart"]), helper: "加购总计/入口加购" },
    { key: "order", label: "下单", value: getFirstMetricValue(metrics, ["orderedUnits"]), helper: "已订购商品" },
    { key: "repeat", label: "复购", value: row?.customerProfile?.repeatOrderCount ?? 0, helper: "本地订单识别到的重复客户订单" }
  ];
}

function formatFunnelRate(current, previous) {
  const currentNumber = Number(current);
  const previousNumber = Number(previous);
  if (!Number.isFinite(currentNumber) || !Number.isFinite(previousNumber) || previousNumber <= 0) return "-";
  return formatPercent((currentNumber / previousNumber) * 100, { precision: 1 });
}

function getProductFunnelRates(stages) {
  const valueOf = (key) => Number(stages.find((item) => item.key === key)?.value || 0);
  const exposure = valueOf("exposure");
  const click = valueOf("click");
  const cart = valueOf("cart");
  const order = valueOf("order");
  return [
    { key: "exposureClick", label: "曝光点击率", compactLabel: "曝点", value: formatFunnelRate(click, exposure), helper: "点击 / 曝光" },
    { key: "clickCart", label: "点击加购率", compactLabel: "点加", value: formatFunnelRate(cart, click), helper: "加购 / 点击" },
    { key: "clickOrder", label: "点击转化率", compactLabel: "点转", value: formatFunnelRate(order, click), helper: "下单 / 点击" },
    { key: "exposureOrder", label: "曝光转化率", compactLabel: "曝转", value: formatFunnelRate(order, exposure), helper: "下单 / 曝光" },
    { key: "cartOrder", label: "加购转化率", compactLabel: "加转", value: formatFunnelRate(order, cart), helper: "下单 / 加购" }
  ];
}

function isVisibleFunnelRate(rate) {
  const number = Number.parseFloat(String(rate?.value || "").replace(",", "."));
  return Boolean(rate && rate.value !== "-" && Number.isFinite(number) && number > 0);
}

function productFunnelData(row) {
  const stages = getProductFunnelStages(row);
  const rates = getProductFunnelRates(stages);
  const rateByKey = rates.reduce((result, item) => {
    result[item.key] = item;
    return result;
  }, {});
  return {
    stages,
    rates,
    rateByKey,
    max: Math.max(1, Number(stages[0]?.value || 0)),
    hasAny: stages.some((item) => Number(item.value || 0) > 0)
  };
}

function funnelStageWidth(stage, max) {
  const value = Number(stage?.value || 0);
  return value > 0 ? Math.max(8, Math.round((value / Math.max(1, Number(max || 1))) * 100)) : 4;
}

function formatPriceIndex(value) {
  const raw = String(value || "").trim();
  if (!raw) return "-";
  const labels = {
    favorable: "有利",
    unfavorable: "不利",
    equal: "持平",
    none: "无指数",
    no_index: "没有指数"
  };
  return labels[raw] || raw;
}

function formatDaysInPeriod(value, periodDays) {
  if (value === undefined || value === null || value === "") return "-";
  const total = Number.isFinite(Number(periodDays)) ? Number(periodDays) : null;
  return total ? `${formatMetric(value, "int")}${formatMetric(total, "int")}中的` : formatMetric(value, "int");
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getMetricTone(value, rules = {}) {
  const number = toFiniteNumber(value);
  if (number === null) return "";
  if (rules.danger !== undefined && number <= rules.danger) return "danger";
  if (rules.warning !== undefined && number <= rules.warning) return "warning";
  if (rules.highDanger !== undefined && number >= rules.highDanger) return "danger";
  if (rules.highWarning !== undefined && number >= rules.highWarning) return "warning";
  if (rules.success !== undefined && number >= rules.success) return "success";
  return "";
}

function metricToneClass(tone) {
  return tone ? `seller-tone seller-tone--${tone}` : "";
}

function hasMetricValue(metrics, key) {
  if (!metrics || !key) return false;
  const value = metrics[key];
  return value !== undefined && value !== null && value !== "";
}

function formatMetricCell(row, metric) {
  const value = row.metrics?.[metric.key];
  if (metric.type === "percent") return formatPercent(value, { precision: metric.percentPrecision });
  if (metric.type === "priceIndex") return formatPriceIndex(value);
  if (metric.type === "text") return value || "-";
  if (metric.type === "daysInPeriod") return formatDaysInPeriod(value, row.metrics?.periodDays);
  return `${formatMetric(value)}${value !== undefined && value !== null && value !== "" ? metric.unit || "" : ""}`;
}

function metricValueClass(row, metric) {
  const value = row.metrics?.[metric.key];
  const tone = metric.type === "priceIndex" && String(value || "") === "unfavorable"
    ? "danger"
    : metric.key === "stockoutDays" || metric.key === "recommendedSupply"
      ? getMetricTone(value, { highWarning: 1 })
      : metric.lowerIsBetter
        ? getMetricTone(value, { highWarning: 100 })
        : "";
  return metricToneClass(tone);
}

function metricDynamicsClass(row, metric) {
  const dynamics = row.metrics?.[metric.dynamicsKey];
  const tone = metric.lowerIsBetter
    ? getMetricTone(dynamics, { danger: 1, success: -1 })
    : getMetricTone(dynamics, { danger: -50, warning: -1, success: 1 });
  return metricToneClass(tone);
}

function abcGradeClass(value) {
  const grade = String(value || "").trim().toUpperCase();
  if (grade === "A") return "seller-abc-badge seller-abc-badge--a";
  if (grade === "B") return "seller-abc-badge seller-abc-badge--b";
  if (grade === "C") return "seller-abc-badge seller-abc-badge--c";
  return "seller-abc-badge seller-abc-badge--empty";
}

function formatDateTime(value) {
  if (!value) return "-";
  return String(value).replace("T", " ").slice(0, 19);
}

function priorityType(priority) {
  if (priority === "high") return "danger";
  if (priority === "medium") return "warning";
  return "info";
}

function priorityLabel(priority) {
  if (priority === "high") return "高";
  if (priority === "medium") return "中";
  return "低";
}

function statusType(status) {
  if (status === "success") return "success";
  if (status === "failed") return "danger";
  if (status === "running") return "warning";
  return "info";
}

function rowKey(row) {
  return row.productKey || row.sku || row.offer_id || row.product_id || row.product_name || "totals";
}

function tableRowClassName({ row }) {
  if (row.isTotalsRow) return "seller-product-table__row--totals";
  if (row.priority === "high") return "seller-product-table__row--high";
  if (row.priority === "medium") return "seller-product-table__row--medium";
  return "";
}

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(() => {
    if (runningRun.value) refreshData(true).catch(() => {});
  }, 2500);
}

function stopPolling() {
  window.clearInterval(pollTimer);
  pollTimer = 0;
}

watch(() => runningRun.value?.id, startPolling);
onMounted(async () => {
  loadCachedFilter();
  if (!state.filters.dateRange?.length) state.filters.dateRange = [todayKey(-6), todayKey(-1)];
  await loadShops();
  await refreshData();
  startPolling();
});
onBeforeUnmount(stopPolling);
</script>

<template>
  <div class="seller-analytics-page">
    <section class="seller-toolbar">
      <div class="seller-toolbar__filters">
        <el-select v-model="state.filters.shopId" class="seller-filter seller-filter--shop" placeholder="店铺">
          <el-option v-for="shop in shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
        </el-select>
        <el-select v-model="state.filters.periodKey" class="seller-filter" @change="handleSearch">
          <el-option v-for="item in periods" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-date-picker
          v-if="state.filters.periodKey === 'custom'"
          v-model="state.filters.dateRange"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="开始日期"
          end-placeholder="结束日期"
          class="seller-filter seller-filter--date"
          @change="handleSearch"
        />
        <el-input v-model="state.filters.keyword" clearable class="seller-filter seller-filter--keyword" placeholder="商品、SKU、建议" @keyup.enter="handleSearch">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
      </div>
      <div class="seller-toolbar__actions">
        <el-button :icon="Search" @click="handleSearch">查询</el-button>
        <el-button :icon="Refresh" @click="refreshData()">刷新</el-button>
      </div>
    </section>

    <section class="seller-source-tabs">
      <button
        v-for="item in sourceTabs"
        :key="item.value || 'all'"
        type="button"
        :class="{ 'is-active': state.filters.tabKey === item.value }"
        @click="state.filters.tabKey = item.value; handleSearch()"
      >
        {{ item.label }}
      </button>
    </section>

    <section class="seller-period-hint">
      <div>
        <strong>{{ periodHint }}</strong>
        <span>最近回传：{{ latestText }}</span>
      </div>
      <el-progress v-if="runningRun" :percentage="progressPercent" :stroke-width="8" class="seller-collect-progress" />
    </section>

    <section class="seller-summary-grid">
      <div class="seller-summary-item"><span>快照</span><strong>{{ summary.snapshotCount || 0 }}</strong></div>
      <div class="seller-summary-item"><span>商品</span><strong>{{ summary.productCount || 0 }}</strong></div>
      <div class="seller-summary-item"><span>高优先级</span><strong>{{ summary.highPriorityCount || 0 }}</strong></div>
      <div class="seller-summary-item"><span>订购金额</span><strong>{{ formatMetric(summary.revenue, "money") }}</strong></div>
      <div class="seller-summary-item"><span>订购数</span><strong>{{ formatMetric(summary.orderedUnits, "int") }}</strong></div>
      <div class="seller-summary-item"><span>曝光</span><strong>{{ formatMetric(summary.totalViews, "int") }}</strong></div>
    </section>

    <section class="seller-insights">
      <div class="seller-insight">
        <header>
          <strong>行动问题分布</strong>
          <span>当前日期范围内的问题数量和代表商品。</span>
        </header>
        <el-tooltip
          v-for="item in actionInsights"
          :key="item.key"
          placement="right"
          popper-class="seller-action-tooltip-popper"
          :disabled="!item.previewProducts.length"
        >
          <template #content>
            <div class="seller-action-tooltip">
              <strong>{{ item.title }}：{{ formatMetric(item.count, "int") }}</strong>
              <span>{{ item.text }}</span>
              <div v-for="product in item.previewProducts" :key="rowKey(product)" class="seller-action-tooltip-product">
                <ProductImagePreview :src="product.image_url" fit="cover" size="small" />
                <div>
                  <strong>{{ product.product_name || product.offer_id || product.sku || "-" }}</strong>
                  <em>{{ product.offer_id || product.sku || "-" }}</em>
                </div>
              </div>
            </div>
          </template>
          <button
            type="button"
            :class="[`seller-action-bar seller-action-bar--${item.tone}`, { 'seller-action-bar--empty': Number(item.count || 0) <= 0 }]"
            @click="openIssueInsight(item)"
          >
            <span>{{ item.title }}</span>
            <div><i v-if="Number(item.count || 0) > 0" :style="{ width: `${Math.round((Number(item.count || 0) / maxActionInsightCount) * 100)}%` }"></i></div>
            <strong>{{ item.count }}</strong>
          </button>
        </el-tooltip>
      </div>
      <div class="seller-insight">
        <header>流量-成交四象限</header>
        <div class="seller-quadrants">
          <div v-for="item in quadrantStats" :key="item.key" :class="`seller-quadrant seller-quadrant--${item.tone}`">
            <span>{{ item.label }}</span>
            <strong>{{ item.count }}</strong>
          </div>
        </div>
      </div>
    </section>

    <el-tabs v-model="activePane" class="seller-tabs">
      <el-tab-pane label="商品诊断" name="diagnosis">
        <div class="seller-table-actions seller-table-actions--pagination">
          <div class="seller-pagination-summary">
            <span>每页 {{ ANALYTICS_PAGE_SIZE }} 条</span>
            <span>服务器已有 {{ totalProductCount }} 个商品</span>
            <span>当前返回 {{ products.length }} 条</span>
          </div>
          <div class="seller-pagination-controls">
            <el-pagination
              v-model:current-page="state.page"
              background
              :page-size="ANALYTICS_PAGE_SIZE"
              :total="totalProductCount"
              layout="prev, pager, next, jumper"
              @current-change="handlePageChange"
            />
            <el-button type="primary" :icon="VideoPlay" :loading="collecting" @click="collectNextPage">采集下一页（第 {{ nextCollectPage }} 页）</el-button>
          </div>
        </div>
        <el-table v-loading="loading" :data="tableProducts" :row-key="rowKey" :row-class-name="tableRowClassName" height="620" class="seller-product-table">
          <el-table-column label="商品" min-width="300" fixed>
            <template #default="{ row }">
              <div class="seller-product-cell">
                <ProductImagePreview v-if="!row.isTotalsRow" :src="row.image_url" fit="cover" size="portrait" />
                <div>
                  <strong>{{ row.product_name || row.offer_id || row.sku || "总计" }}</strong>
                  <span v-if="!row.isTotalsRow">货号：{{ row.offer_id || "-" }}</span>
                  <span v-if="!row.isTotalsRow">SKU：{{ row.sku || "-" }}</span>
                  <span v-if="!row.isTotalsRow">Product ID：{{ row.product_id || "-" }}</span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="在线商品" width="110" align="center">
            <template #default="{ row }">
              <span v-if="row.isTotalsRow">-</span>
              <el-tooltip v-else :content="`售价 ${formatMetric(row.metrics?.onlinePrice, 'money')}，评级 ${formatMetric(row.metrics?.contentRatingScore)}`">
                <el-tag :type="row.metrics?.onlinePrice ? 'success' : 'info'" effect="light">{{ row.metrics?.onlinePrice ? "在线数据" : "未关联" }}</el-tag>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="行为漏斗" width="360">
            <template #default="{ row }">
              <span v-if="row.isTotalsRow">-</span>
              <button v-else type="button" class="seller-funnel-button" @click="showFunnel(row)">
                <template v-for="funnel in [productFunnelData(row)]" :key="rowKey(row)">
                  <div v-if="funnel.hasAny" class="seller-funnel seller-funnel--compact">
                    <div class="seller-funnel-flow">
                      <div class="seller-funnel-overall-rate">
                        <svg class="seller-funnel-left-arrows" viewBox="0 0 96 132" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                          <g v-if="isVisibleFunnelRate(funnel.rateByKey.exposureOrder)" class="seller-funnel-left-arrow seller-funnel-left-arrow--exposureOrder">
                            <path d="M88 23C44 23 40 113 72 113" />
                            <path d="M63 106L73 113L63 120" />
                          </g>
                          <g v-if="isVisibleFunnelRate(funnel.rateByKey.clickOrder)" class="seller-funnel-left-arrow seller-funnel-left-arrow--clickOrder">
                            <path d="M88 53C52 53 48 113 72 113" />
                            <path d="M63 106L73 113L63 120" />
                          </g>
                          <g v-if="isVisibleFunnelRate(funnel.rateByKey.cartOrder)" class="seller-funnel-left-arrow seller-funnel-left-arrow--cartOrder">
                            <path d="M88 83C60 83 56 113 72 113" />
                            <path d="M63 106L73 113L63 120" />
                          </g>
                        </svg>
                        <el-tooltip v-for="rate in [funnel.rateByKey.exposureOrder, funnel.rateByKey.clickOrder, funnel.rateByKey.cartOrder]" :key="rate?.key" :content="`${rate?.label}：${rate?.value}；${rate?.helper}`" placement="top" :disabled="!isVisibleFunnelRate(rate)">
                          <span v-if="isVisibleFunnelRate(rate)" :class="`seller-funnel-rate seller-funnel-rate--left seller-funnel-rate--${rate.key}`">
                            <span class="seller-funnel-rate-text"><em>{{ rate.compactLabel }}</em><strong>{{ rate.value }}</strong></span>
                          </span>
                        </el-tooltip>
                      </div>
                      <div class="seller-funnel-stages">
                        <div v-for="(stage, index) in funnel.stages" :key="stage.key" class="seller-funnel-stage">
                          <div class="seller-funnel-label">
                            <span>{{ stage.label }}</span>
                            <strong>{{ formatMetric(stage.value || 0, "int") }}</strong>
                          </div>
                          <el-tooltip :content="`${stage.label}：${formatMetric(stage.value || 0, 'int')}；${stage.helper}${index > 0 ? `；上一步转化 ${formatFunnelRate(stage.value, funnel.stages[index - 1]?.value)}` : ''}`" placement="top">
                            <div class="seller-funnel-track">
                              <div :class="`seller-funnel-bar seller-funnel-bar--${stage.key}`" :style="{ width: `${funnelStageWidth(stage, funnel.max)}%` }"></div>
                            </div>
                          </el-tooltip>
                        </div>
                      </div>
                      <div class="seller-funnel-side-rates">
                        <el-tooltip v-for="rate in [funnel.rateByKey.exposureClick, funnel.rateByKey.clickCart]" :key="rate?.key" :content="`${rate?.label}：${rate?.value}；${rate?.helper}`" placement="top" :disabled="!isVisibleFunnelRate(rate)">
                          <span v-if="isVisibleFunnelRate(rate)" :class="`seller-funnel-rate seller-funnel-rate--right seller-funnel-rate--${rate.key}`">
                            <svg class="seller-funnel-rate-arrow" viewBox="0 0 46 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                              <path d="M1 4C38 4 38 28 8 38" />
                              <path d="M11 32L8 38L14 40" />
                            </svg>
                            <span class="seller-funnel-rate-text"><em>{{ rate.compactLabel }}</em><strong>{{ rate.value }}</strong></span>
                          </span>
                        </el-tooltip>
                      </div>
                    </div>
                  </div>
                  <span v-else>-</span>
                </template>
              </button>
            </template>
          </el-table-column>
          <el-table-column v-if="state.filters.tabKey === 'all_metrics'" label="ABC分析" width="118" align="center">
            <template #default="{ row }">
              <div class="seller-abc-cell">
                <span :class="abcGradeClass(row.metrics?.abcRevenue)">{{ row.metrics?.abcRevenue || "-" }}</span>
                <span :class="abcGradeClass(row.metrics?.abcQuantity)">{{ row.metrics?.abcQuantity || "-" }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="来源" width="150">
            <template #default="{ row }">
              <span v-if="row.isTotalsRow">-</span>
              <template v-else>
                <el-tag v-for="source in row.sourceLabels || []" :key="source" class="seller-source-tag">{{ source }}</el-tag>
              </template>
            </template>
          </el-table-column>
          <el-table-column label="诊断" width="130">
            <template #default="{ row }">
              <span v-if="row.isTotalsRow">-</span>
              <template v-else>
                <el-tag :type="priorityType(row.priority)" effect="light">{{ priorityLabel(row.priority) }}优先级</el-tag>
                <div class="seller-score">诊断分 {{ row.score || 0 }}</div>
              </template>
            </template>
          </el-table-column>
          <el-table-column v-for="group in visibleMetricGroups" :key="group.title" :label="group.title" align="center">
            <el-table-column v-for="metric in group.children" :key="metric.key" :width="metric.type === 'priceIndex' ? 120 : 132" align="right">
              <template #header>
                <el-tooltip :content="metric.tooltip || metric.label" placement="top">
                  <span class="seller-metric-title">{{ metric.label }}</span>
                </el-tooltip>
              </template>
              <template #default="{ row }">
                <div v-if="metric.type === 'abcPair'" class="seller-abc-cell">
                  <span :class="abcGradeClass(row.metrics?.abcRevenue)">{{ row.metrics?.abcRevenue || "-" }}</span>
                  <span :class="abcGradeClass(row.metrics?.abcQuantity)">{{ row.metrics?.abcQuantity || "-" }}</span>
                </div>
                <div v-else class="seller-metric-cell">
                  <strong :class="metricValueClass(row, metric)">{{ formatMetricCell(row, metric) }}</strong>
                  <em v-if="metric.dynamicsKey && row.metrics?.[metric.dynamicsKey] !== undefined && row.metrics?.[metric.dynamicsKey] !== null" :class="metricDynamicsClass(row, metric)">
                    {{ formatPercent(row.metrics?.[metric.dynamicsKey], { precision: 0, sign: true }) }}
                  </em>
                </div>
              </template>
            </el-table-column>
          </el-table-column>
          <el-table-column label="优化建议" min-width="260">
            <template #default="{ row }">
              <span v-if="row.isTotalsRow">-</span>
              <div v-else class="seller-rec-list">
                <span v-for="item in row.recommendations || []" :key="`${item.type}-${item.action}`">{{ item.type }}：{{ item.action }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="最近回传" width="170">
            <template #default="{ row }">{{ formatDateTime(row.latestCapturedAt) }}</template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="优化建议" name="recommendations">
        <el-table :data="recommendations" height="620">
          <el-table-column label="商品" min-width="260">
            <template #default="{ row }">
              <div class="seller-product-cell seller-product-cell--compact">
                <ProductImagePreview :src="row.image_url" fit="cover" size="small" />
                <div><strong>{{ row.product_name || row.offer_id || row.sku }}</strong><span>{{ row.offer_id || row.sku || "-" }}</span></div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="优先级" width="110"><template #default="{ row }"><el-tag :type="priorityType(row.priority)">{{ priorityLabel(row.priority) }}</el-tag></template></el-table-column>
          <el-table-column prop="type" label="维度" width="120" />
          <el-table-column prop="action" label="建议" min-width="260" />
          <el-table-column prop="reason" label="原因" min-width="320" />
          <el-table-column prop="evidence" label="依据" min-width="180" />
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="回传快照" name="snapshots">
        <div class="seller-table-actions">
          <el-button type="danger" :icon="Delete" :disabled="!selectedSnapshotIds.length" @click="removeSelectedSnapshots">批量删除</el-button>
        </div>
        <el-table :data="snapshots" height="620" @selection-change="selectedSnapshotIds = $event.map((row) => row.id)">
          <el-table-column type="selection" width="48" />
          <el-table-column prop="source_button_label" label="页签" width="120" />
          <el-table-column prop="source" label="来源" width="190" />
          <el-table-column prop="request_method" label="方法" width="80" />
          <el-table-column prop="response_status" label="状态" width="90" />
          <el-table-column prop="request_url" label="接口" min-width="360" show-overflow-tooltip />
          <el-table-column prop="period_key" label="周期" width="130" />
          <el-table-column label="采集时间" width="170"><template #default="{ row }">{{ formatDateTime(row.captured_at) }}</template></el-table-column>
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="showRaw(row)">源数据</el-button>
              <el-button link type="danger" @click="removeSnapshot(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="采集批次" name="runs">
        <el-table :data="collectRuns" height="620">
          <el-table-column prop="id" label="批次 ID" min-width="260" show-overflow-tooltip />
          <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="statusType(row.status)">{{ row.status }}</el-tag></template></el-table-column>
          <el-table-column prop="period_key" label="周期" width="110" />
          <el-table-column label="日期" width="210"><template #default="{ row }">{{ row.current_period?.date_from }} ~ {{ row.current_period?.date_to }}</template></el-table-column>
          <el-table-column label="进度" width="160"><template #default="{ row }">{{ row.completed_count || 0 }}/{{ row.request_count || 0 }}，失败 {{ row.failed_count || 0 }}</template></el-table-column>
          <el-table-column label="创建时间" width="170"><template #default="{ row }">{{ formatDateTime(row.created_at) }}</template></el-table-column>
          <el-table-column label="更新时间" width="170"><template #default="{ row }">{{ formatDateTime(row.updated_at) }}</template></el-table-column>
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" :disabled="row.status === 'success'" @click="retryRun(row)">重试</el-button>
              <el-button link type="danger" :disabled="row.status === 'success'" @click="removeRun(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="rawDialog.visible" :title="rawDialog.title" width="760px">
      <pre class="seller-raw">{{ rawDialog.content }}</pre>
    </el-dialog>

    <el-dialog
      v-model="selectedIssueInsight.visible"
      :title="selectedIssueInsight.item ? `${selectedIssueInsight.item.title}（${selectedIssueInsight.item.count}）` : ''"
      width="860px"
    >
      <div v-if="selectedIssueInsight.item" class="seller-focus-modal">
        <p>{{ selectedIssueInsight.item.text }}</p>
        <el-empty v-if="!selectedIssueInsight.item.products.length" description="暂无对应商品" />
        <div v-else class="seller-focus-modal-list">
          <div v-for="product in selectedIssueInsight.item.products" :key="rowKey(product)" class="seller-focus-modal-product">
            <div class="seller-product-cell">
              <ProductImagePreview :src="product.image_url" fit="cover" size="portrait" />
              <div>
                <strong>{{ product.product_name || product.offer_id || product.sku || "未命名商品" }}</strong>
                <span>货号：{{ product.offer_id || "-" }}</span>
                <span>SKU：{{ product.sku || "-" }}</span>
              </div>
            </div>
            <div class="seller-focus-modal-recs">
              <div v-if="!(product.recommendations || []).length">-</div>
              <div v-else class="seller-rec-list">
                <div
                  v-for="rec in product.recommendations || []"
                  :key="`${rec.type}-${rec.action}`"
                  :class="['seller-rec-item', `seller-rec-item--${recommendationTone(rec)}`]"
                >
                  <el-tag :type="recommendationTagType(rec)" effect="light" round>{{ rec.type || "建议" }}</el-tag>
                  <div class="seller-rec-item__body">
                    <strong>{{ rec.action || "-" }}</strong>
                    <span v-if="rec.reason">{{ rec.reason }}</span>
                    <em v-if="rec.evidence" class="seller-rec-item__evidence">{{ rec.evidence }}</em>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </el-dialog>

    <el-dialog
      v-model="funnelDialog.visible"
      :title="funnelDialog.row ? `${funnelDialog.row.product_name || funnelDialog.row.offer_id || funnelDialog.row.sku || '商品'} 行为漏斗` : ''"
      width="760px"
    >
      <div v-if="funnelDialog.row" class="seller-funnel-modal">
        <div class="seller-product-cell">
          <ProductImagePreview :src="funnelDialog.row.image_url" fit="cover" size="portrait" />
          <div>
            <strong>{{ funnelDialog.row.product_name || funnelDialog.row.offer_id || funnelDialog.row.sku || "未命名商品" }}</strong>
            <span>货号：{{ funnelDialog.row.offer_id || "-" }}</span>
            <span>SKU：{{ funnelDialog.row.sku || "-" }}</span>
          </div>
        </div>
        <template v-for="funnel in [productFunnelData(funnelDialog.row)]" :key="rowKey(funnelDialog.row)">
          <div v-if="funnel.hasAny" class="seller-funnel">
            <div class="seller-funnel-flow">
              <div class="seller-funnel-overall-rate">
                <svg class="seller-funnel-left-arrows" viewBox="0 0 96 132" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                  <g v-if="isVisibleFunnelRate(funnel.rateByKey.exposureOrder)" class="seller-funnel-left-arrow seller-funnel-left-arrow--exposureOrder">
                    <path d="M88 23C44 23 40 113 72 113" />
                    <path d="M63 106L73 113L63 120" />
                  </g>
                  <g v-if="isVisibleFunnelRate(funnel.rateByKey.clickOrder)" class="seller-funnel-left-arrow seller-funnel-left-arrow--clickOrder">
                    <path d="M88 53C52 53 48 113 72 113" />
                    <path d="M63 106L73 113L63 120" />
                  </g>
                  <g v-if="isVisibleFunnelRate(funnel.rateByKey.cartOrder)" class="seller-funnel-left-arrow seller-funnel-left-arrow--cartOrder">
                    <path d="M88 83C60 83 56 113 72 113" />
                    <path d="M63 106L73 113L63 120" />
                  </g>
                </svg>
                <el-tooltip v-for="rate in [funnel.rateByKey.exposureOrder, funnel.rateByKey.clickOrder, funnel.rateByKey.cartOrder]" :key="rate?.key" :content="`${rate?.label}：${rate?.value}；${rate?.helper}`" placement="top" :disabled="!isVisibleFunnelRate(rate)">
                  <span v-if="isVisibleFunnelRate(rate)" :class="`seller-funnel-rate seller-funnel-rate--left seller-funnel-rate--${rate.key}`">
                    <span class="seller-funnel-rate-text"><em>{{ rate.label }}</em><strong>{{ rate.value }}</strong></span>
                  </span>
                </el-tooltip>
              </div>
              <div class="seller-funnel-stages">
                <div v-for="(stage, index) in funnel.stages" :key="stage.key" class="seller-funnel-stage">
                  <div class="seller-funnel-label">
                    <span>{{ stage.label }}</span>
                    <strong>{{ formatMetric(stage.value || 0, "int") }}</strong>
                  </div>
                  <el-tooltip :content="`${stage.label}：${formatMetric(stage.value || 0, 'int')}；${stage.helper}${index > 0 ? `；上一步转化 ${formatFunnelRate(stage.value, funnel.stages[index - 1]?.value)}` : ''}`" placement="top">
                    <div class="seller-funnel-track">
                      <div :class="`seller-funnel-bar seller-funnel-bar--${stage.key}`" :style="{ width: `${funnelStageWidth(stage, funnel.max)}%` }"></div>
                    </div>
                  </el-tooltip>
                </div>
              </div>
              <div class="seller-funnel-side-rates">
                <el-tooltip v-for="rate in [funnel.rateByKey.exposureClick, funnel.rateByKey.clickCart]" :key="rate?.key" :content="`${rate?.label}：${rate?.value}；${rate?.helper}`" placement="top" :disabled="!isVisibleFunnelRate(rate)">
                  <span v-if="isVisibleFunnelRate(rate)" :class="`seller-funnel-rate seller-funnel-rate--right seller-funnel-rate--${rate.key}`">
                    <svg class="seller-funnel-rate-arrow" viewBox="0 0 46 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                      <path d="M1 4C38 4 38 28 8 38" />
                      <path d="M11 32L8 38L14 40" />
                    </svg>
                    <span class="seller-funnel-rate-text"><em>{{ rate.label }}</em><strong>{{ rate.value }}</strong></span>
                  </span>
                </el-tooltip>
              </div>
            </div>
          </div>
          <el-empty v-else description="暂无行为漏斗数据" />
        </template>
        <div class="seller-funnel-hint">
          <span>路径：曝光 → 点击 → 加购 → 下单 → 复购</span>
          <span>复购来自本地订单中同一客户重复购买的识别结果；没有订单画像时显示 0。</span>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.seller-analytics-page { display: flex; flex-direction: column; gap: 14px; }
.seller-toolbar { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
.seller-toolbar__filters, .seller-toolbar__actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.seller-filter { width: 132px; }
.seller-filter--shop { width: 180px; }
.seller-filter--date { width: 250px; }
.seller-filter--keyword { width: 260px; }
.seller-source-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.seller-source-tabs button { border: 1px solid var(--el-border-color); background: var(--el-bg-color); border-radius: 6px; padding: 7px 11px; cursor: pointer; color: var(--el-text-color-regular); }
.seller-source-tabs button.is-active { border-color: var(--el-color-primary); color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.seller-period-hint { display: flex; align-items: center; justify-content: space-between; gap: 16px; color: var(--el-text-color-secondary); }
.seller-period-hint strong { margin-right: 12px; color: var(--el-text-color-primary); }
.seller-collect-progress { width: 280px; }
.seller-summary-grid { display: grid; grid-template-columns: repeat(6, minmax(120px, 1fr)); gap: 10px; }
.seller-summary-item { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 12px; background: var(--el-bg-color); }
.seller-summary-item span { display: block; color: var(--el-text-color-secondary); font-size: 12px; }
.seller-summary-item strong { display: block; margin-top: 6px; font-size: 20px; }
.seller-insights { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.seller-insight { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 12px; background: var(--el-bg-color); }
.seller-insight header { display: grid; gap: 3px; font-weight: 700; margin-bottom: 10px; }
.seller-insight header span { color: var(--el-text-color-secondary); font-size: 12px; font-weight: 400; }
.seller-bar { display: grid; grid-template-columns: 100px 1fr 40px; gap: 10px; align-items: center; margin: 8px 0; }
.seller-bar div { height: 8px; border-radius: 99px; background: var(--el-fill-color-light); overflow: hidden; }
.seller-bar i { display: block; height: 100%; background: var(--el-color-primary); }
.seller-action-bar { width: 100%; display: grid; grid-template-columns: 100px minmax(0, 1fr) 40px; gap: 10px; align-items: center; margin: 8px 0; padding: 0; border: 0; background: transparent; color: var(--el-text-color-primary); cursor: pointer; text-align: left; }
.seller-action-bar > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seller-action-bar > div { height: 12px; border-radius: 99px; background: var(--el-fill-color-light); overflow: hidden; }
.seller-action-bar i { display: block; height: 100%; border-radius: 0 8px 8px 0; transition: width .2s ease; }
.seller-action-bar strong { font-size: 13px; }
.seller-action-bar--danger i { background: #ff4d4f; }
.seller-action-bar--warning i { background: #faad14; }
.seller-action-bar--success i { background: #52c41a; }
.seller-action-bar--empty > div { background: var(--el-fill-color-lighter); }
.seller-action-bar:hover > div { box-shadow: inset 0 0 0 1px var(--el-border-color); }
.seller-action-tooltip { display: grid; gap: 8px; max-width: 340px; color: #f8fafc; }
.seller-action-tooltip > span { color: #cbd5e1; white-space: normal; }
.seller-action-tooltip-product { display: flex; gap: 8px; align-items: center; min-width: 0; }
.seller-action-tooltip-product div { min-width: 0; }
.seller-action-tooltip-product strong, .seller-action-tooltip-product em { display: block; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seller-action-tooltip-product em { color: #fbbf24; font-style: normal; font-weight: 700; }
.seller-quadrants { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
.seller-quadrant { border: 1px solid var(--el-border-color); border-radius: 8px; padding: 12px; display: flex; justify-content: space-between; }
.seller-quadrant--success { background: var(--el-color-success-light-9); }
.seller-quadrant--warning { background: var(--el-color-warning-light-9); }
.seller-quadrant--primary { background: var(--el-color-primary-light-9); }
.seller-quadrant--info { background: var(--el-fill-color-light); }
.seller-table-actions { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; color: var(--el-text-color-secondary); }
.seller-table-actions--pagination { gap: 12px; flex-wrap: wrap; }
.seller-pagination-summary { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-size: 13px; }
.seller-pagination-controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.seller-product-table :deep(.el-table__row) { height: 88px; }
.seller-product-table :deep(.seller-product-table__row--totals) { background: #fffdf1; font-weight: 700; }
.seller-product-table :deep(.seller-product-table__row--high) { background: #fff8f7; }
.seller-product-table :deep(.seller-product-table__row--medium) { background: #fffaf0; }
.seller-product-cell { display: flex; gap: 10px; align-items: center; min-width: 0; }
.seller-product-cell strong, .seller-product-cell span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seller-product-cell span { color: var(--el-text-color-secondary); font-size: 12px; margin-top: 2px; }
.seller-product-cell--compact { min-height: 48px; }
.seller-source-tag { margin: 0 4px 4px 0; }
.seller-score { margin-top: 6px; color: var(--el-text-color-secondary); font-size: 12px; }
.seller-metric-title { display: inline-flex; max-width: 112px; align-items: center; justify-content: flex-end; white-space: normal; line-height: 1.2; }
.seller-metric-cell { display: flex; min-height: 42px; flex-direction: column; align-items: flex-end; justify-content: center; line-height: 1.35; }
.seller-metric-cell strong { color: var(--el-text-color-primary); font-size: 13px; }
.seller-metric-cell em { margin-top: 2px; font-style: normal; font-size: 12px; color: var(--el-text-color-secondary); }
.seller-tone--success { color: var(--el-color-success) !important; }
.seller-tone--warning { color: var(--el-color-warning) !important; }
.seller-tone--danger { color: var(--el-color-danger) !important; }
.seller-abc-cell { display: inline-flex; gap: 5px; align-items: center; justify-content: center; }
.seller-abc-badge { min-width: 24px; border-radius: 4px; padding: 1px 6px; text-align: center; font-weight: 700; line-height: 20px; background: var(--el-fill-color-light); color: var(--el-text-color-secondary); }
.seller-abc-badge--a { background: var(--el-color-success-light-8); color: var(--el-color-success); }
.seller-abc-badge--b { background: var(--el-color-warning-light-8); color: var(--el-color-warning); }
.seller-abc-badge--c { background: var(--el-color-danger-light-8); color: var(--el-color-danger); }
.seller-rec-list { display: flex; flex-direction: column; gap: 6px; font-size: 12px; line-height: 1.35; }
.seller-rec-item { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 8px; align-items: start; padding: 7px 8px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; background: var(--el-fill-color-extra-light); }
.seller-rec-item .el-tag { width: max-content; max-width: 88px; margin-top: 1px; }
.seller-rec-item__body { display: grid; gap: 3px; min-width: 0; }
.seller-rec-item__body strong { color: var(--el-text-color-primary); font-size: 13px; }
.seller-rec-item__body span,
.seller-rec-item__evidence { color: var(--el-text-color-secondary); font-style: normal; overflow-wrap: anywhere; }
.seller-rec-item--danger { border-color: #ffd6d9; background: #fff6f7; }
.seller-rec-item--warning { border-color: #ffe4b8; background: #fffaf0; }
.seller-rec-item--traffic { border-color: #bfdbfe; background: #eff6ff; }
.seller-rec-item--conversion { border-color: #c7efd3; background: #f0fdf4; }
.seller-rec-item--after-sale { border-color: #ddd6fe; background: #f5f3ff; }
.seller-raw { max-height: 560px; overflow: auto; padding: 12px; border-radius: 8px; background: var(--el-fill-color-light); white-space: pre-wrap; word-break: break-word; }
.seller-focus-modal { display: grid; gap: 12px; }
.seller-focus-modal > p { margin: 0; color: var(--el-text-color-regular); }
.seller-focus-modal-list { display: grid; gap: 10px; max-height: 620px; overflow: auto; }
.seller-focus-modal-product { display: grid; grid-template-columns: minmax(260px, 320px) minmax(0, 1fr); gap: 12px; align-items: start; padding: 10px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; background: var(--el-bg-color); }
.seller-focus-modal-recs { min-width: 0; }
.seller-funnel-button { width: 100%; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.seller-funnel-button:hover .seller-funnel-track { border-color: #91caff; }
.seller-funnel { display: grid; gap: 8px; min-width: 0; }
.seller-funnel--compact { gap: 4px; }
.seller-funnel-flow { display: grid; grid-template-columns: 96px minmax(0, 1fr) 132px; gap: 6px; align-items: stretch; min-width: 0; }
.seller-funnel--compact .seller-funnel-flow { grid-template-columns: 88px minmax(0, 1fr) 108px; gap: 4px; }
.seller-funnel-stages { display: grid; gap: 8px; min-width: 0; }
.seller-funnel--compact .seller-funnel-stages { gap: 4px; }
.seller-funnel-stage { display: grid; gap: 3px; min-width: 0; }
.seller-funnel-label { display: grid; grid-template-columns: 54px minmax(42px, 1fr); gap: 6px; align-items: center; color: #64748b; font-size: 12px; line-height: 16px; }
.seller-funnel--compact .seller-funnel-label { grid-template-columns: 42px minmax(32px, 1fr); }
.seller-funnel-label strong { overflow: hidden; color: #111827; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.seller-funnel-track { height: 7px; overflow: hidden; border: 1px solid #e2e8f0; border-radius: 999px; background: #f8fafc; }
.seller-funnel-bar { height: 100%; border-radius: inherit; }
.seller-funnel-bar--exposure { background: #2563eb; }
.seller-funnel-bar--click { background: #0f766e; }
.seller-funnel-bar--cart { background: #ca8a04; }
.seller-funnel-bar--order { background: #dc2626; }
.seller-funnel-bar--repeat { background: #7c3aed; }
.seller-funnel-overall-rate,
.seller-funnel-side-rates { position: relative; min-width: 0; }
.seller-funnel-left-arrows { position: absolute; top: 0; right: 0; width: 96px; height: 132px; overflow: visible; fill: none; pointer-events: none; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2.8; }
.seller-funnel--compact .seller-funnel-left-arrows { width: 88px; }
.seller-funnel-left-arrow--exposureOrder { stroke: #2563eb; }
.seller-funnel-left-arrow--clickOrder { stroke: #0f766e; }
.seller-funnel-left-arrow--cartOrder { stroke: #ca8a04; }
.seller-funnel-rate { position: absolute; display: grid; min-width: 0; align-items: center; gap: 3px; color: #64748b; font-size: 12px; line-height: 14px; }
.seller-funnel-rate--left { right: 0; width: 96px; grid-template-columns: 36px minmax(0, 1fr); }
.seller-funnel-rate--right { left: 0; width: 140px; grid-template-columns: 48px minmax(0, 1fr); }
.seller-funnel-rate--exposureClick { top: 21px; height: 28px; }
.seller-funnel-rate--clickCart { top: 51px; height: 28px; }
.seller-funnel-rate--clickOrder { top: 56px; height: 46px; }
.seller-funnel-rate--cartOrder { top: 92px; height: 10px; }
.seller-funnel-rate--exposureOrder { top: 22px; height: 80px; }
.seller-funnel-rate-arrow { display: block; width: 100%; height: 100%; overflow: visible; fill: none; stroke: #9aa8b8; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2.4; }
.seller-funnel-rate--left .seller-funnel-rate-arrow { justify-self: end; }
.seller-funnel-rate--left.seller-funnel-rate--exposureOrder .seller-funnel-rate-arrow,
.seller-funnel-rate--left.seller-funnel-rate--clickOrder .seller-funnel-rate-arrow,
.seller-funnel-rate--left.seller-funnel-rate--cartOrder .seller-funnel-rate-arrow { width: 56px; }
.seller-funnel-rate--exposureClick .seller-funnel-rate-arrow,
.seller-funnel-rate--exposureOrder .seller-funnel-rate-arrow { stroke: #2563eb; }
.seller-funnel-rate--exposureClick .seller-funnel-rate-text,
.seller-funnel-rate--exposureOrder .seller-funnel-rate-text,
.seller-funnel-rate--exposureClick .seller-funnel-rate-text strong,
.seller-funnel-rate--exposureOrder .seller-funnel-rate-text strong { color: #2563eb; }
.seller-funnel-rate--clickOrder .seller-funnel-rate-arrow,
.seller-funnel-rate--clickCart .seller-funnel-rate-arrow { stroke: #0f766e; }
.seller-funnel-rate--clickOrder .seller-funnel-rate-text,
.seller-funnel-rate--clickCart .seller-funnel-rate-text,
.seller-funnel-rate--clickOrder .seller-funnel-rate-text strong,
.seller-funnel-rate--clickCart .seller-funnel-rate-text strong { color: #0f766e; }
.seller-funnel-rate--cartOrder .seller-funnel-rate-arrow { stroke: #ca8a04; }
.seller-funnel-rate--cartOrder .seller-funnel-rate-text,
.seller-funnel-rate--cartOrder .seller-funnel-rate-text strong { color: #ca8a04; }
.seller-funnel-rate-text { display: grid; grid-template-columns: 1fr; gap: 0; min-width: 0; align-items: center; }
.seller-funnel-rate--left .seller-funnel-rate-text { align-self: start; text-align: right; }
.seller-funnel-rate--right .seller-funnel-rate-text { position: absolute; left: 54px; align-self: auto; }
.seller-funnel-rate--right.seller-funnel-rate--exposureClick .seller-funnel-rate-text { top: -14px; }
.seller-funnel-rate--right.seller-funnel-rate--clickCart .seller-funnel-rate-text { top: -10px; }
.seller-funnel--compact .seller-funnel-rate { font-size: 11px; line-height: 13px; }
.seller-funnel--compact .seller-funnel-rate--left { width: 88px; grid-template-columns: 34px minmax(0, 1fr); }
.seller-funnel--compact .seller-funnel-rate--right { width: 112px; grid-template-columns: 38px minmax(0, 1fr); }
.seller-funnel--compact .seller-funnel-rate--right .seller-funnel-rate-text { left: 42px; }
.seller-funnel--compact .seller-funnel-rate--right.seller-funnel-rate--exposureClick .seller-funnel-rate-text { top: -12px; }
.seller-funnel--compact .seller-funnel-rate--right.seller-funnel-rate--clickCart .seller-funnel-rate-text { top: -8px; }
.seller-funnel--compact .seller-funnel-rate--exposureClick { top: 21px; height: 24px; }
.seller-funnel--compact .seller-funnel-rate--clickCart { top: 51px; height: 24px; }
.seller-funnel--compact .seller-funnel-rate--clickOrder { top: 52px; height: 40px; }
.seller-funnel--compact .seller-funnel-rate--cartOrder { top: 82px; height: 10px; }
.seller-funnel--compact .seller-funnel-rate--exposureOrder { top: 22px; height: 70px; }
.seller-funnel--compact .seller-funnel-rate-arrow { stroke-width: 2.6; }
.seller-funnel--compact .seller-funnel-rate--left.seller-funnel-rate--exposureOrder .seller-funnel-rate-arrow,
.seller-funnel--compact .seller-funnel-rate--left.seller-funnel-rate--clickOrder .seller-funnel-rate-arrow,
.seller-funnel--compact .seller-funnel-rate--left.seller-funnel-rate--cartOrder .seller-funnel-rate-arrow { width: 48px; }
.seller-funnel-rate em,
.seller-funnel-rate strong { overflow: hidden; font-style: normal; text-overflow: ellipsis; white-space: nowrap; }
.seller-funnel-rate strong { flex: none; color: inherit; }
.seller-funnel-modal { display: grid; gap: 16px; }
.seller-funnel-hint { display: grid; gap: 4px; color: #64748b; font-size: 12px; }

@media (max-width: 1200px) {
  .seller-toolbar { align-items: flex-start; flex-direction: column; }
  .seller-summary-grid { grid-template-columns: repeat(3, 1fr); }
  .seller-insights { grid-template-columns: 1fr; }
}
</style>
