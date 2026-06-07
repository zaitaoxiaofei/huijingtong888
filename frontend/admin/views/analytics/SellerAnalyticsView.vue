<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Refresh, Search, VideoPlay } from "@element-plus/icons-vue";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import { useAuthStore } from "../../stores/auth";
import {
  createSellerAnalyticsCollectRun,
  deleteSellerAnalyticsCollectRun,
  getSellerAnalyticsAnalysis,
  getSellerAnalyticsAuthBindingStatus,
  getSellerAnalyticsCollectRuns,
  getSellerAnalyticsPluginStatus,
  getSellerAnalyticsSnapshots,
  prepareSellerAnalyticsPlugin,
  retrySellerAnalyticsCollectRun,
  validateSellerAnalyticsPluginStatus
} from "../../api/sellerAnalytics";
import { apiClient } from "../../utils/api";

const ANALYTICS_PAGE_SIZE = 30;
const FILTER_CACHE_KEY_PREFIX = "ozon-erp:seller-analytics:filters";
const DAILY_SYNC_PERIOD_KEYS = ["7d", "28d"];
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
const authStore = useAuthStore();
const metricKeysBySourceTab = {
  overview: ["revenue", "searchPosition", "searchViews", "pdpViews", "convPdpViewsToCart", "orderedUnits", "cancelledUnitsByOrderDate", "returnedUnitsByOrderDate"],
  funnel: ["revenue", "searchViews", "pdpViews", "pdpAddToCart", "orderedUnits"],
  hot: ["revenue", "orderedUnits"],
  search: ["searchPosition", "searchViews", "orderedUnits"],
  abc: ["abcAnalysis", "revenue", "revenueShare", "totalViews", "orderedUnits", "avgPrice", "discountShare", "priceIndex", "drr"],
  need_promotion: ["searchPosition", "totalViews", "pdpViews", "convPdpViewsToCart", "orderedUnits"],
  card_quality: ["revenue", "pdpViews", "convPdpViewsToCart", "orderedUnits"]
};
const compactMetricColumns = [
  {
    key: "sales",
    label: "销售",
    sortProp: "metric:revenue",
    width: 152,
    items: [
      { label: "金额", key: "revenue", type: "money", dynamicsKey: "revenueDynamics", help: "当前周期已订购商品金额。为 0 通常表示该商品本周期没有下单金额。" },
      { label: "占比", key: "revenueShare", type: "percent", percentPrecision: 0, dynamicsKey: "revenueShareDynamics", help: "该商品订购金额占全店当前筛选结果的比例。" },
      { label: "下单", key: "orderedUnits", type: "int", dynamicsKey: "orderedUnitsDynamics", help: "买家已下单的商品件数。" },
      { label: "成交", key: "acceptedUnits", type: "int", dynamicsKey: "acceptedUnitsDynamics", help: "最终认购/有效成交件数；接口未直接返回时由本地按订购、取消、退货估算。" }
    ]
  },
  {
    key: "traffic",
    label: "流量搜索",
    sortProp: "metric:totalViews",
    width: 150,
    items: [
      { label: "位置", key: "searchPosition", lowerIsBetter: true, dynamicsKey: "searchPositionDynamics", help: "搜索/目录平均展示位置，数字越小越靠前；0 表示周期内没有展示位置数据。" },
      { label: "曝光", keys: ["totalViews", "searchViews"], type: "int", dynamicsKey: "totalViewsDynamics", help: "买家看到商品的总次数，优先展示总曝光，没有总曝光时用搜索曝光。" },
      { label: "搜索", key: "searchViews", type: "int", dynamicsKey: "searchViewsDynamics", help: "商品在搜索结果或目录里被看到的次数。" },
      { label: "进卡率", key: "convSearchViewsToPdp", type: "percent", dynamicsKey: "convSearchViewsToPdpDynamics", help: "搜索/目录曝光进入商品卡片的比例，不是次数。" }
    ]
  },
  {
    key: "card",
    label: "商品卡片",
    sortProp: "metric:pdpViews",
    width: 150,
    items: [
      { label: "访问", key: "pdpViews", type: "int", dynamicsKey: "pdpViewsDynamics", help: "买家真正打开商品卡片的次数，也就是进卡后的访问量。" },
      { label: "卡加购", key: "pdpAddToCart", type: "int", dynamicsKey: "pdpAddToCartDynamics", help: "从商品卡片页面加入购物车的次数。" },
      { label: "总加购", key: "totalAddToCart", type: "int", dynamicsKey: "totalAddToCartDynamics", help: "所有入口加购总次数，包含搜索和商品卡片等入口。" },
      { label: "加购率", key: "convPdpViewsToCart", type: "percent", dynamicsKey: "convPdpViewsToCartDynamics", help: "商品卡片访问转为加购的比例。" }
    ]
  },
  {
    key: "quality",
    label: "成交质量",
    sortProp: "metric:convHitsToCartToOrder",
    width: 146,
    items: [
      { label: "车转单", key: "convHitsToCartToOrder", type: "percent", dynamicsKey: "convHitsToCartToOrderDynamics", help: "加购后最终下单的比例。" },
      { label: "送达", key: "deliveredUnits", type: "int", dynamicsKey: "deliveredUnitsDynamics", help: "已送达买家的商品件数。" },
      { label: "取消", keys: ["cancelledUnitsByOrderDate", "cancelledUnits"], type: "int", dynamicsKey: "cancelledUnitsDynamics", warningIfPositive: true, help: "周期内取消件数，越高越需要检查价格、库存或履约。" },
      { label: "退货", keys: ["returnedUnitsByOrderDate", "returnedUnits"], type: "int", dynamicsKey: "returnedUnitsDynamics", warningIfPositive: true, help: "周期内退货件数，越高越需要检查描述、尺码、质量或包装。" }
    ]
  },
  {
    key: "pricePromo",
    label: "价格推广",
    sortProp: "metric:avgPrice",
    width: 146,
    items: [
      { label: "均价", key: "avgPrice", type: "money", dynamicsKey: "avgPriceDynamics", help: "当前周期平均成交价格。" },
      { label: "折扣", key: "discountShare", type: "percent", percentPrecision: 0, dynamicsKey: "discountShareDynamics", help: "当前价格折扣占比。" },
      { label: "价指", key: "priceIndex", type: "priceIndex", help: "Ozon 返回的价格竞争力标记。" },
      { label: "DRR", key: "drr", type: "percent", percentPrecision: 0, dynamicsKey: "drrDynamics", warningIfPositive: true, help: "广告支出占订购金额比例，越高越要看利润空间。" }
    ]
  },
  {
    key: "stock",
    label: "库存利润",
    sortProp: "metric:lastStock",
    width: 138,
    items: [
      { label: "库存", key: "lastStock", type: "int", help: "最近一次采集到的库存。" },
      { label: "缺货", key: "stockoutDays", type: "daysInPeriod", warningIfPositive: true, help: "当前周期缺货天数。" },
      { label: "补货", key: "recommendedSupply", type: "int", warningIfPositive: true, help: "Ozon 建议补货数量。" },
      { label: "评分", key: "productRating", help: "商品评分；接口没有返回时会显示 0 或空值。" }
    ]
  }
];
const tableMetricColumns = [
  { key: "searchPosition", label: "位置", width: 84, sortProp: "metric:searchPosition", item: { key: "searchPosition", lowerIsBetter: true, dynamicsKey: "searchPositionDynamics", help: "搜索/目录平均展示位置，数字越小越靠前。" } },
  { key: "exposure", label: "曝光", width: 104, sortProp: "metric:totalViews", item: { keys: ["totalViews", "searchViews"], type: "int", dynamicsKey: "totalViewsDynamics", help: "买家看到商品的总次数，优先展示总曝光，没有总曝光时用搜索曝光。" } },
  { key: "pdpViews", label: "进卡", width: 96, sortProp: "metric:pdpViews", item: { key: "pdpViews", type: "int", dynamicsKey: "pdpViewsDynamics", help: "买家打开商品卡片的次数。" } },
  { key: "totalAddToCart", label: "加购", width: 96, sortProp: "metric:totalAddToCart", item: { keys: ["totalAddToCart", "pdpAddToCart", "searchAddToCart"], type: "int", dynamicsKey: "totalAddToCartDynamics", help: "所有入口加购总次数。" } },
  { key: "orderedUnits", label: "下单", width: 92, sortProp: "metric:orderedUnits", item: { key: "orderedUnits", type: "int", dynamicsKey: "orderedUnitsDynamics", help: "买家已下单的商品件数。" } },
  { key: "convHitsToCartToOrder", label: "成交率", width: 96, sortProp: "metric:convHitsToCartToOrder", item: { key: "convHitsToCartToOrder", type: "percent", dynamicsKey: "convHitsToCartToOrderDynamics", hideWhenEmpty: true, help: "加购后最终下单的比例。" } },
  { key: "revenue", label: "金额", width: 112, sortProp: "metric:revenue", item: { key: "revenue", type: "money", dynamicsKey: "revenueDynamics", help: "当前周期已订购商品金额。" } },
  { key: "acceptedUnits", label: "成交", width: 92, sortProp: "metric:acceptedUnits", item: { key: "acceptedUnits", type: "int", dynamicsKey: "acceptedUnitsDynamics", help: "最终认购/有效成交件数。" } },
  { key: "avgPrice", label: "均价", width: 98, sortProp: "metric:avgPrice", item: { key: "avgPrice", type: "money", dynamicsKey: "avgPriceDynamics", help: "当前周期平均成交价格。" } },
  { key: "drr", label: "DRR", width: 86, sortProp: "metric:drr", item: { key: "drr", type: "percent", percentPrecision: 0, dynamicsKey: "drrDynamics", warningIfPositive: true, hideWhenEmpty: true, help: "广告支出占订购金额比例。" } },
  { key: "discountShare", label: "折扣", width: 86, sortProp: "metric:discountShare", item: { key: "discountShare", type: "percent", percentPrecision: 0, dynamicsKey: "discountShareDynamics", hideWhenEmpty: true, help: "当前价格折扣占比。" } },
  { key: "priceIndex", label: "价指", width: 88, sortProp: "metric:priceIndex", item: { key: "priceIndex", type: "priceIndex", hideWhenEmpty: true, help: "Ozon 返回的价格竞争力标记。" } },
  { key: "cancelledUnits", label: "取消", width: 84, sortProp: "metric:cancelledUnitsByOrderDate", item: { keys: ["cancelledUnitsByOrderDate", "cancelledUnits"], type: "int", dynamicsKey: "cancelledUnitsDynamics", warningIfPositive: true, help: "周期内取消件数。" } },
  { key: "returnedUnits", label: "退货", width: 84, sortProp: "metric:returnedUnitsByOrderDate", item: { keys: ["returnedUnitsByOrderDate", "returnedUnits"], type: "int", dynamicsKey: "returnedUnitsDynamics", warningIfPositive: true, help: "周期内退货件数。" } },
  { key: "productRating", label: "评分", width: 82, sortProp: "metric:productRating", item: { key: "productRating", hideWhenEmpty: true, help: "商品评分；接口没有返回时会显示 0 或空值。" } }
];

const loading = ref(false);
const metaLoading = ref(false);
const collecting = ref(false);
const bindingAuth = ref(false);
const activePane = ref("metrics");
const shops = ref([]);
const analysis = ref({ summary: {}, products: [], focusProducts: [], recommendations: [], totalsRow: null, totalsBySource: {} });
const snapshots = ref([]);
const collectRuns = ref([]);
const pluginStatus = ref(null);
const pluginValidation = ref(null);
const authBindingStatus = ref(null);
const selectedSnapshotIds = ref([]);
const metaLoaded = reactive({ snapshots: false, runs: false });
const rawDialog = reactive({ visible: false, title: "", content: "" });
const funnelDialog = reactive({ visible: false, row: null });
const selectedIssueInsight = reactive({ visible: false, item: null });
const prepareFlow = reactive({
  tone: "info",
  title: "一键同步待准备",
  detail: "点击同步后会自动打开 Ozon graphs，并校验当前 Ozon 店铺是否和 ERP 店铺一致。"
});
const state = reactive({
  page: 1,
  sortKey: "metric:revenue",
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
let pluginPollTimer = 0;
let lastNotifiedRunId = "";

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

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
const visibleTableMetricColumns = computed(() => {
  const rows = tableProducts.value.filter((row) => !row.isTotalsRow);
  if (!rows.length) return tableMetricColumns;
  return tableMetricColumns.filter((column) => {
    if (!column.item?.hideWhenEmpty) return true;
    return rows.some((row) => hasDisplayMetricValue(row, column.item));
  });
});
const focusProducts = computed(() => Array.isArray(analysis.value?.focusProducts) ? analysis.value.focusProducts : []);
const recommendations = computed(() => Array.isArray(analysis.value?.recommendations) ? analysis.value.recommendations : []);
const runningRun = computed(() => collectRuns.value.find((run) => ["pending", "running"].includes(run.status)));
const latestCurrentPeriodRun = computed(() => {
  const currentRange = periodParams.value;
  return collectRuns.value.find((run) => {
    if (!run) return false;
    if (state.filters.periodKey !== "custom") return run.period_key === state.filters.periodKey;
    return run.current_period?.date_from === currentRange.date_from && run.current_period?.date_to === currentRange.date_to;
  }) || collectRuns.value[0] || null;
});
const progressPercent = computed(() => {
  const run = runningRun.value;
  if (!run) return 0;
  const total = Math.max(1, Number(run.request_count || 0));
  return Math.round(((Number(run.completed_count || 0) + Number(run.failed_count || 0)) / total) * 100);
});
const collectStatus = computed(() => {
  const run = runningRun.value || latestCurrentPeriodRun.value;
  if (!run) {
    return {
      tone: "info",
      title: "暂无采集批次",
      detail: "当前店铺还没有采集记录，可点击同步当前区间。"
    };
  }
  const total = Math.max(1, Number(run.request_count || 0));
  const done = Number(run.completed_count || 0) + Number(run.failed_count || 0);
  const period = run.period_key === "28d" ? "近 28 天" : run.period_key === "7d" ? "近 7 天" : run.period_key || "当前周期";
  if (["pending", "running"].includes(run.status)) {
    return {
      tone: "warning",
      title: "正在采集",
      detail: `${period} · 已完成 ${done}/${total}`
    };
  }
  if (run.status === "success") {
    return {
      tone: "success",
      title: "当前店铺采集完成",
      detail: `${period} · 已完成 ${Number(run.completed_count || 0)}/${total} · ${formatDateTime(run.updated_at)}`
    };
  }
  if (run.status === "failed") {
    return {
      tone: "danger",
      title: "采集未完全完成",
      detail: `${period} · 成功 ${Number(run.completed_count || 0)} · 失败 ${Number(run.failed_count || 0)}`
    };
  }
  return {
    tone: "info",
    title: "等待采集",
    detail: `${period} · ${done}/${total}`
  };
});
const latestText = computed(() => formatDateTime(summary.value.latestCapturedAt));
const selectedShop = computed(() => shops.value.find((shop) => String(shop.id) === String(state.filters.shopId)) || null);
const selectedStoreId = computed(() => getShopSellerStoreId(selectedShop.value) || String(state.filters.shopId || ""));
const selectedShopLabel = computed(() => selectedShop.value?.name || "未选择店铺");
const pluginCompanyLabel = computed(() => pluginStatus.value?.current_company_id || pluginValidation.value?.current_company_id || "待识别");
const directSyncStatus = computed(() => {
  const binding = authBindingStatus.value || {};
  if (binding.bound && !binding.stale) {
    return {
      tone: "success",
      title: "后端直连已绑定",
      detail: binding.last_ok_at ? `最近直连成功 ${formatDateTime(binding.last_ok_at)}` : "后端可直接用店铺授权采集"
    };
  }
  if (binding.bound && binding.stale) {
    return {
      tone: "warning",
      title: "后端授权已过期",
      detail: "请打开 Ozon 分析页，插件会自动续授权"
    };
  }
  return {
    tone: "warning",
    title: "需要首次绑定授权",
    detail: "点击首次绑定后，插件会自动打开 Ozon 并绑定当前店铺 Cookie"
  };
});
const currentErpBaseUrl = computed(() => {
  if (typeof window === "undefined" || !window.location?.origin) return "";
  return String(window.location.origin || "").trim();
});
const skipPluginValidation = computed(() => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(currentErpBaseUrl.value));
const localPluginSetupHint = computed(() => {
  const base = currentErpBaseUrl.value;
  if (!base) return "";
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base)) return "";
  return `当前你打开的是本地系统，请在店铺分析插件里把 ERP 地址改成 ${base}，保存后回到 seller.ozon.ru/app/analytics 停留几秒再试。`;
});
const recommendationRows = computed(() => (
  recommendations.value
    .filter(Boolean)
    .map((row, index) => ({
      ...row,
      recommendationKey: row.recommendationKey || `${row.productKey || row.sku || row.offer_id || "recommendation"}-${row.type || "type"}-${row.action || index}`,
      product_name: row.product_name || row.productName || row.title || "",
      offer_id: row.offer_id || row.offerId || "",
      sku: row.sku || row.ozon_sku || row.ozonSku || "",
      image_url: row.image_url || row.imageUrl || "",
      priority: row.priority || "low",
      score: Number(row.score || 0) || 0,
      type: row.type || row.dimension || "建议",
      action: row.action || row.title || row.reason || "-",
      reason: row.reason || row.message || "",
      evidence: row.evidence || row.detail || ""
    }))
));
const pluginSyncStatus = computed(() => {
  const validation = pluginValidation.value || {};
  const status = pluginStatus.value || {};
  const binding = authBindingStatus.value || {};
  if (binding.bound && !binding.stale) {
    return {
      tone: "success",
      title: "后端直连可用",
      detail: status.current_company_id && String(status.current_company_id) !== String(selectedStoreId.value || "")
        ? `Ozon 页面当前是 ${status.current_company_id}，但本店铺已绑定授权，同步无需切换页面。`
        : "本店铺已绑定授权，同步无需打开或切换 Ozon 页面。",
      blocked: false
    };
  }
  if (validation.ok) {
    return {
      tone: "success",
      title: "店铺已对齐",
      detail: "当前店铺可直接采集",
      blocked: false
    };
  }
  if (validation.code === "company_mismatch") {
    return {
      tone: "danger",
      title: "店铺未对齐",
      detail: "请先切到与系统一致的 Ozon 店铺",
      blocked: true
    };
  }
  if (validation.code === "seller_tab_missing") {
    return {
      tone: "warning",
      title: "未打开分析页",
      detail: "请打开 seller.ozon.ru/app/analytics",
      blocked: true
    };
  }
  if (validation.code === "missing_plugin_company") {
    return {
      tone: "warning",
      title: "未识别当前店铺",
      detail: "请在 Ozon 分析页停留几秒或刷新页面",
      blocked: true
    };
  }
  if (validation.code === "plugin_offline") {
    return {
      tone: "info",
      title: "插件未连上",
      detail: skipPluginValidation.value ? "本地调试允许继续，但建议打开插件确认店铺" : "请确认插件已开启并保持分析页打开",
      blocked: !skipPluginValidation.value
    };
  }
  return {
    tone: "info",
    title: "等待校验",
    detail: skipPluginValidation.value ? "本地调试允许继续，页面仍会显示真实店铺识别结果" : "正在识别当前店铺",
    blocked: !skipPluginValidation.value
  };
});
const periodHint = computed(() => {
  return state.filters.periodKey === "custom" && state.filters.dateRange?.length === 2
    ? `${state.filters.dateRange[0]} ~ ${state.filters.dateRange[1]}`
    : periods.find((item) => item.value === state.filters.periodKey)?.label || state.filters.periodKey;
});
const overviewMetrics = computed(() => analysis.value?.totalsRow?.metrics || {});
const productFooterSummary = computed(() => {
  const total = totalProductCount.value;
  const start = total ? ((state.page - 1) * ANALYTICS_PAGE_SIZE) + 1 : 0;
  const end = total ? Math.min(total, (state.page - 1) * ANALYTICS_PAGE_SIZE + products.value.length) : 0;
  const source = state.filters.tabKey ? sourceTabs.find((item) => item.value === state.filters.tabKey)?.label : "全部页签";
  return `${source || "全部页签"} · 第 ${state.page} 页 · 当前 ${start}-${end} / ${total} 个商品`;
});
const overviewFunnelStages = computed(() => {
  const metrics = overviewMetrics.value || {};
  return [
    {
      key: "exposure",
      label: "曝光",
      value: summary.value.totalViews ?? metrics.totalViews ?? metrics.searchViews ?? 0,
      type: "int"
    },
    {
      key: "pdp",
      label: "访问",
      value: metrics.pdpViews ?? metrics.cardViews ?? 0,
      type: "int",
      rate: formatFunnelRate(metrics.pdpViews ?? metrics.cardViews, summary.value.totalViews ?? metrics.totalViews ?? metrics.searchViews)
    },
    {
      key: "cart",
      label: "加购",
      value: metrics.totalAddToCart ?? metrics.addToCart ?? 0,
      type: "int",
      rate: formatFunnelRate(metrics.totalAddToCart ?? metrics.addToCart, metrics.pdpViews ?? metrics.cardViews)
    },
    {
      key: "order",
      label: "订购",
      value: summary.value.orderedUnits ?? metrics.orderedUnits ?? 0,
      type: "int",
      rate: formatFunnelRate(summary.value.orderedUnits ?? metrics.orderedUnits, metrics.totalAddToCart ?? metrics.addToCart)
    }
  ];
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

function getShopSellerStoreId(shop = {}) {
  return String(
    shop.seller_company_id ||
    shop.sellerCompanyId ||
    shop.ozon_company_id ||
    shop.ozonCompanyId ||
    shop.ozon_client_id ||
    shop.ozonClientId ||
    shop.store_client_id ||
    shop.storeClientId ||
    shop.client_id ||
    shop.clientId ||
    shop.company_id ||
    shop.companyId ||
    shop.id ||
    ""
  ).trim();
}

function normalizeShopOption(shop = {}) {
  const id = String(shop.id || shop.shop_id || shop.shopId || "").trim();
  const name = String(
    shop.name ||
    shop.shop_name ||
    shop.shopName ||
    shop.shopLabel ||
    shop.label ||
    (id ? `店铺 ${id}` : "未命名店铺")
  ).trim();
  return {
    ...shop,
    id,
    shop_id: shop.shop_id ?? shop.shopId ?? id,
    shopId: shop.shopId ?? shop.shop_id ?? id,
    name,
    shop_name: shop.shop_name || name,
    shopName: shop.shopName || name,
    shopLabel: shop.shopLabel || name,
    label: shop.label || name
  };
}

function loadCachedFilter() {
  try {
    const cached = JSON.parse(localStorage.getItem(filterCacheKey()) || "{}");
    if (cached.shopId) state.filters.shopId = String(cached.shopId);
    if (cached.tabKey !== undefined) state.filters.tabKey = String(cached.tabKey || "");
    if (cached.periodKey) state.filters.periodKey = cached.periodKey;
    if (Array.isArray(cached.dateRange)) state.filters.dateRange = cached.dateRange;
    if (cached.keyword !== undefined) state.filters.keyword = String(cached.keyword || "");
    if (cached.sortKey) state.sortKey = String(cached.sortKey);
    if (cached.sortOrder) state.sortOrder = String(cached.sortOrder) === "asc" ? "asc" : "desc";
    if (Number(cached.page) > 0) state.page = Math.max(1, Number(cached.page));
    if (cached.activePane) activePane.value = String(cached.activePane);
  } catch {}
}

function cacheFilter() {
  localStorage.setItem(filterCacheKey(), JSON.stringify({
    shopId: state.filters.shopId,
    tabKey: state.filters.tabKey,
    periodKey: state.filters.periodKey,
    dateRange: state.filters.dateRange,
    keyword: state.filters.keyword,
    page: state.page,
    sortKey: state.sortKey,
    sortOrder: state.sortOrder,
    activePane: activePane.value
  }));
}

function filterCacheKey() {
  const user = authStore.user || {};
  const userKey = String(user.id || user.person_id || user.username || user.name || "anonymous").trim() || "anonymous";
  return `${FILTER_CACHE_KEY_PREFIX}:${userKey}`;
}

function markMetaStale() {
  metaLoaded.snapshots = false;
  metaLoaded.runs = false;
  selectedSnapshotIds.value = [];
}

async function loadShops() {
  shops.value = (await apiClient.get("/api/shops"))
    .filter((shop) => shop && shop.status !== "deleted")
    .map((shop) => normalizeShopOption(shop));
  if (state.filters.shopId && !shops.value.some((shop) => String(shop.id) === String(state.filters.shopId))) {
    state.filters.shopId = "";
  }
  const first = shops.value.find((shop) => shop.is_default || shop.default) || shops.value[0];
  if (!state.filters.shopId && first) state.filters.shopId = String(first.id);
}

async function refreshData(silent = false) {
  if (!silent) loading.value = true;
  try {
    cacheFilter();
    markMetaStale();
    const params = {
      ...periodParams.value,
      tab_key: state.filters.tabKey,
      keyword: state.filters.keyword,
      store_id: selectedStoreId.value,
      page: state.page,
      product_limit: ANALYTICS_PAGE_SIZE,
      focus_limit: 200,
      sort_key: state.sortKey,
      sort_order: state.sortOrder,
      limit: 1000
    };
    const nextAnalysis = await getSellerAnalyticsAnalysis(params);
    analysis.value = nextAnalysis || analysis.value;
    await loadRunsMeta(true);
    await loadActiveMetaPane(true);
  } finally {
    loading.value = false;
  }
}

async function loadSnapshotsMeta(silent = false) {
  if (!silent) metaLoading.value = true;
  try {
    const nextSnapshots = await getSellerAnalyticsSnapshots({ ...periodParams.value, store_id: selectedStoreId.value, limit: 100 });
    snapshots.value = Array.isArray(nextSnapshots) ? nextSnapshots : [];
    metaLoaded.snapshots = true;
  } finally {
    metaLoading.value = false;
  }
}

async function loadRunsMeta(silent = false) {
  if (!silent) metaLoading.value = true;
  try {
    const nextRuns = await getSellerAnalyticsCollectRuns({ store_id: selectedStoreId.value, limit: 30 });
    collectRuns.value = Array.isArray(nextRuns) ? nextRuns : [];
    metaLoaded.runs = true;
  } finally {
    metaLoading.value = false;
  }
}

async function loadPluginStatus() {
  pluginStatus.value = await getSellerAnalyticsPluginStatus().catch(() => pluginStatus.value);
  return pluginStatus.value;
}

async function loadAuthBindingStatus() {
  authBindingStatus.value = await getSellerAnalyticsAuthBindingStatus({
    shop_id: state.filters.shopId,
    store_id: selectedStoreId.value,
    company_id: selectedStoreId.value
  }).catch(() => authBindingStatus.value);
  return authBindingStatus.value;
}

async function loadPluginValidation() {
  pluginValidation.value = await validateSellerAnalyticsPluginStatus({
    shop_id: state.filters.shopId,
    store_id: selectedStoreId.value,
    company_id: selectedStoreId.value,
    shop_name: selectedShop.value?.name || ""
  }).catch(() => pluginValidation.value);
  return pluginValidation.value;
}

async function loadActiveMetaPane(silent = false) {
  if (activePane.value === "snapshots" && !metaLoaded.snapshots) return loadSnapshotsMeta(silent);
  if (activePane.value === "runs" && !metaLoaded.runs) return loadRunsMeta(silent);
  return null;
}

function handleSearch() {
  state.page = 1;
  Promise.all([refreshData(), loadPluginStatus(), loadPluginValidation(), loadAuthBindingStatus()]).catch(() => {});
}

function handlePeriodChange() {
  if (state.filters.periodKey === "custom" && !state.filters.dateRange?.length) {
    state.filters.dateRange = [todayKey(-6), todayKey(-1)];
  }
  handleSearch();
}

function handleCustomDateRangeChange() {
  if (state.filters.dateRange?.length === 2) {
    state.filters.periodKey = "custom";
  }
  handleSearch();
}

function handlePageChange(page) {
  state.page = Math.max(1, Number(page || 1));
  refreshData();
}

function metricSortProp(metric) {
  return metric?.key ? `metric:${metric.key}` : "";
}

function compactMetricSortProp(column) {
  return column?.sortProp || "metric:revenue";
}

function handleSortChange({ prop, order }) {
  state.page = 1;
  state.sortKey = prop || "metric:revenue";
  state.sortOrder = order === "ascending" ? "asc" : "desc";
  refreshData();
}

function collectSourceKeys() {
  return state.filters.tabKey ? [state.filters.tabKey] : sourceTabs.slice(1).map((item) => item.value);
}

function buildCollectPayload(overrides = {}) {
  return {
    ...periodParams.value,
    source_keys: collectSourceKeys(),
    shop_id: state.filters.shopId,
    store_id: selectedStoreId.value,
    company_id: selectedStoreId.value,
    ...overrides
  };
}

async function ensureCollectReady() {
  try {
    const binding = await loadAuthBindingStatus();
    const bindingStoreId = String(binding?.store_id || binding?.company_id || "");
    const selectedId = String(selectedStoreId.value || "");
    const pluginStatusNow = await loadPluginStatus().catch(() => pluginStatus.value);
    if (binding?.bound && !binding.stale && bindingStoreId && bindingStoreId === selectedId && pluginStatusNow?.plugin_online !== false) {
      prepareFlow.tone = "success";
      prepareFlow.title = "插件跨店采集已就绪";
      prepareFlow.detail = binding.last_ok_at
        ? `系统将用已登录 Ozon 页面按目标店铺同步，最近成功 ${formatDateTime(binding.last_ok_at)}。`
        : "系统将用已登录 Ozon 页面按目标店铺同步，不要求当前后台切到同一店铺。";
      return true;
    }
    if (!binding?.bound || binding.stale) {
      bindCurrentShopAuth().catch(() => null);
      prepareFlow.tone = "warning";
      prepareFlow.title = "需要建立授权池";
      prepareFlow.detail = "当前店铺还没有可用后端直连授权，插件会打开 Ozon 绑定 Cookie，完成后后续同步不再跳转。";
    }
    if (skipPluginValidation.value) return true;
    prepareFlow.tone = "warning";
    prepareFlow.title = "正在准备 Ozon 分析页";
    prepareFlow.detail = "插件会自动打开 seller.ozon.ru/app/analytics/graphs，并识别当前 Ozon 店铺。";
    await prepareSellerAnalyticsPlugin({
      shop_id: state.filters.shopId,
      store_id: selectedStoreId.value,
      company_id: selectedStoreId.value,
      shop_name: selectedShop.value?.name || ""
    }).catch(() => null);
    ElMessage.info("正在自动打开 Ozon 分析页并校验店铺，请稍候");
    let validation = null;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      validation = await loadPluginValidation();
      await Promise.all([loadPluginStatus(), loadAuthBindingStatus()]);
      if (validation?.ok) {
        prepareFlow.tone = "success";
        prepareFlow.title = "Ozon 店铺已对齐";
        prepareFlow.detail = "当前 Ozon 店铺和 ERP 选择店铺一致，正在创建同步任务。";
        return true;
      }
      if (validation?.code === "company_mismatch") {
        prepareFlow.tone = "danger";
        prepareFlow.title = "需要切换 Ozon 店铺";
        prepareFlow.detail = validation?.detail || "当前 Ozon 店铺和 ERP 选择店铺不一致，请在 Ozon 后台切换到目标店铺。";
        break;
      }
      prepareFlow.detail = validation?.detail || "正在等待插件打开 graphs 页面并识别当前店铺。";
      await wait(3000);
    }
    if (validation?.ok) return true;
    if (validation?.code !== "company_mismatch") {
      prepareFlow.tone = "warning";
      prepareFlow.title = "Ozon 页面还没准备好";
      prepareFlow.detail = validation?.detail || "请确认插件已开启；如果 Ozon 没有自动打开，请重新点击一键同步。";
    }
    ElMessage.warning(validation?.message || "当前插件状态还不能启动采集");
    const title = validation?.code === "company_mismatch" ? "店铺未对齐" : "暂时不能启动采集";
    const extraHint = validation?.code === "plugin_offline" ? localPluginSetupHint.value : "";
    const detail = [validation?.message, validation?.detail, extraHint].filter(Boolean).join("\n\n") || "请检查插件和 Ozon 分析页后再试。";
    await ElMessageBox.alert(detail, title, {
      type: "warning",
      confirmButtonText: "知道了"
    });
    return false;
  } catch (error) {
    await ElMessageBox.alert(
      `启动采集前的插件校验失败：${error?.message || error}\n\n请确认插件已开启，并打开对应店铺的 seller.ozon.ru/app/analytics 页面后再试。`,
      "校验失败",
      {
        type: "error",
        confirmButtonText: "知道了"
      }
    );
    return false;
  }
}

async function bindCurrentShopAuth() {
  bindingAuth.value = true;
  prepareFlow.tone = "warning";
  prepareFlow.title = "正在绑定店铺授权";
  prepareFlow.detail = "插件会自动打开 Ozon 分析页，读取当前店铺 Cookie 并回传 ERP。";
  try {
    await prepareSellerAnalyticsPlugin({
      shop_id: state.filters.shopId,
      store_id: selectedStoreId.value,
      company_id: selectedStoreId.value,
      shop_name: selectedShop.value?.name || "",
      bind_auth_only: true
    }).catch(() => null);
    ElMessage.info("正在打开 Ozon 完成首次授权绑定，请确认当前 Ozon 店铺和 ERP 选择店铺一致");
    const deadline = Date.now() + 120000;
    let validation = null;
    while (Date.now() < deadline) {
      validation = await loadPluginValidation();
      const binding = await loadAuthBindingStatus();
      await loadPluginStatus();
      if (binding?.bound && !binding.stale && String(binding.store_id || binding.company_id || "") === String(selectedStoreId.value || "")) {
        prepareFlow.tone = "success";
        prepareFlow.title = "店铺授权已绑定";
        prepareFlow.detail = "后续可直接用后端直连同步，除非 Ozon 登录过期或切换账号。";
        ElMessage.success("当前店铺授权已绑定");
        return true;
      }
      if (validation?.code === "company_mismatch") {
        prepareFlow.tone = "danger";
        prepareFlow.title = "需要切换 Ozon 店铺";
        prepareFlow.detail = validation?.detail || "当前 Ozon 店铺和 ERP 选择店铺不一致，请先在 Ozon 切换到目标店铺。";
        await ElMessageBox.alert(prepareFlow.detail, "店铺未对齐", {
          type: "warning",
          confirmButtonText: "知道了"
        });
        return false;
      }
      prepareFlow.detail = validation?.detail || "正在等待插件回传当前店铺授权，请保持 Ozon 页面打开。";
      await wait(3000);
    }
    prepareFlow.tone = "warning";
    prepareFlow.title = "授权绑定未完成";
    prepareFlow.detail = "没有收到当前店铺授权，请确认店铺数据分析插件已更新到 1.0.23，且 Ozon 已登录并切到该店铺。";
    await ElMessageBox.alert(prepareFlow.detail, "首次绑定未完成", {
      type: "warning",
      confirmButtonText: "知道了"
    });
    return false;
  } finally {
    bindingAuth.value = false;
  }
}

async function handleCollect(page = nextCollectPage.value) {
  if (state.filters.keyword.trim()) {
    ElMessage.info("关键词搜索只查询已保存数据，不创建插件采集批次");
    return refreshData();
  }
  if (!(await ensureCollectReady())) return;
  const targetPage = Math.max(1, Number(page || nextCollectPage.value || 1));
  collecting.value = true;
  try {
    const result = await createSellerAnalyticsCollectRun(buildCollectPayload({
      page: targetPage,
    }));
    ElMessage.success(result?.data?.reused ? "已存在进行中的采集批次，插件会继续同步" : "已创建采集批次，插件会在已登录的 Ozon 页面中同步");
    await Promise.all([refreshData(true), loadRunsMeta(true)]);
  } finally {
    collecting.value = false;
  }
}

async function collectNextPage() {
  await handleCollect(nextCollectPage.value);
}

async function collectFullStore() {
  if (state.filters.keyword.trim()) {
    ElMessage.info("关键词搜索只查询已保存数据，不创建插件采集批次");
    return refreshData();
  }
  if (!(await ensureCollectReady())) return;
  collecting.value = true;
  try {
    const result = await createSellerAnalyticsCollectRun(buildCollectPayload({
      auto_all_pages: true,
      full_store: true
    }));
    ElMessage.success(result?.data?.reused ? "已存在进行中的全店采集批次，插件会继续同步" : "已创建全店自动采集，插件会在已登录的 Ozon 页面中同步");
    await Promise.all([refreshData(true), loadRunsMeta(true)]);
  } finally {
    collecting.value = false;
  }
}

async function collectDailyDefaultPeriods() {
  if (state.filters.keyword.trim()) {
    ElMessage.info("关键词搜索只查询已保存数据，不创建插件采集批次");
    return refreshData();
  }
  if (!(await ensureCollectReady())) return;
  collecting.value = true;
  try {
    const results = [];
    for (const periodKey of DAILY_SYNC_PERIOD_KEYS) {
      results.push(await createSellerAnalyticsCollectRun(buildCollectPayload({
        period_key: periodKey,
        auto_all_pages: true,
        full_store: true
      })));
    }
    const reusedCount = results.filter((result) => result?.data?.reused).length;
    ElMessage.success(reusedCount
      ? `已创建/复用 ${DAILY_SYNC_PERIOD_KEYS.length} 个日常同步批次，其中 ${reusedCount} 个已在进行中`
      : "已创建近 7 天和近 28 天全店同步批次");
    await Promise.all([refreshData(true), loadRunsMeta(true)]);
  } finally {
    collecting.value = false;
  }
}

async function retryRun(row) {
  const result = await retrySellerAnalyticsCollectRun(row.id);
  ElMessage.success(`已重置 ${result?.data?.resetCount || 0} 个请求`);
  await Promise.all([refreshData(true), loadRunsMeta(true)]);
}

async function removeRun(row) {
  await ElMessageBox.confirm("删除未完成采集批次？成功批次不能删除。", "删除批次", { type: "warning" });
  await deleteSellerAnalyticsCollectRun(row.id);
  ElMessage.success("已删除批次");
  await Promise.all([refreshData(true), loadRunsMeta(true)]);
}

async function removeSnapshot(row) {
  await ElMessageBox.confirm("删除该快照会同步删除解析出的商品指标。", "删除快照", { type: "warning" });
  await deleteSellerAnalyticsSnapshot(row.id);
  ElMessage.success("已删除快照");
  await Promise.all([refreshData(true), loadSnapshotsMeta(true)]);
}

async function removeSelectedSnapshots() {
  if (!selectedSnapshotIds.value.length) return;
  await ElMessageBox.confirm(`批量删除 ${selectedSnapshotIds.value.length} 条快照？`, "批量删除", { type: "warning" });
  await batchDeleteSellerAnalyticsSnapshots(selectedSnapshotIds.value);
  selectedSnapshotIds.value = [];
  ElMessage.success("已批量删除");
  await Promise.all([refreshData(true), loadSnapshotsMeta(true)]);
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

function topRecommendation(row) {
  return Array.isArray(row?.recommendations) ? row.recommendations[0] : null;
}

function recommendationTooltipText(row) {
  const items = Array.isArray(row?.recommendations) ? row.recommendations : [];
  if (!items.length) return "暂无优化建议";
  return items
    .slice(0, 2)
    .map((item) => {
      const title = item.type ? `${item.type}：${item.action || "需要核对"}` : item.action || "需要核对";
      const reason = item.reason ? `原因：${shortTooltipText(item.reason, 120)}` : "";
      const evidence = item.evidence ? `依据：${shortTooltipText(item.evidence, 140)}` : "";
      return [title, reason, evidence].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function shortTooltipText(value, limit = 60) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
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

function compactMetricRawValue(row, item) {
  return getFirstMetricValue(row.metrics, item.keys || [item.key]);
}

function hasDisplayMetricValue(row, item) {
  const value = compactMetricRawValue(row, item);
  if (value === undefined || value === null || value === "") return false;
  if (item.type === "priceIndex") {
    const raw = String(value || "").trim().toLowerCase();
    return Boolean(raw && !["none", "no_index", "-", "0"].includes(raw));
  }
  const number = Number(value);
  if (Number.isFinite(number)) return number !== 0;
  return String(value || "").trim() !== "-";
}

function formatCompactMetric(row, item) {
  const value = compactMetricRawValue(row, item);
  if (item.type === "money") return formatMetric(value, "money");
  if (item.type === "percent") return formatPercent(value, { precision: item.percentPrecision });
  if (item.type === "priceIndex") return formatPriceIndex(value);
  if (item.type === "daysInPeriod") return formatDaysInPeriod(value, row.metrics?.periodDays);
  if (item.type === "int") return formatMetric(value, "int");
  return formatMetric(value);
}

function compactMetricHelp(item) {
  return item.help || item.label;
}

function compactMetricValueClass(row, item) {
  const value = compactMetricRawValue(row, item);
  const tone = item.type === "priceIndex" && String(value || "") === "unfavorable"
    ? "danger"
    : item.warningIfPositive
      ? getMetricTone(value, { highWarning: 1 })
      : item.lowerIsBetter
        ? getMetricTone(value, { highWarning: 100 })
        : "";
  return metricToneClass(tone);
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

function statusLabel(status) {
  if (status === "success") return "已完成";
  if (status === "failed") return "有失败";
  if (status === "running") return "采集中";
  if (status === "pending") return "等待采集";
  return status || "未知状态";
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

function startPluginPolling() {
  stopPluginPolling();
  pluginPollTimer = window.setInterval(() => {
    Promise.all([loadPluginStatus(), loadPluginValidation(), loadAuthBindingStatus()]).catch(() => {});
  }, 5000);
}

function stopPluginPolling() {
  window.clearInterval(pluginPollTimer);
  pluginPollTimer = 0;
}

watch(() => runningRun.value?.id, startPolling);
watch(latestCurrentPeriodRun, (run, previousRun) => {
  const wasActive = previousRun?.id === run?.id && ["pending", "running"].includes(previousRun?.status);
  if (!run || run.status !== "success" || !wasActive || lastNotifiedRunId === run.id) return;
  lastNotifiedRunId = run.id;
  ElMessage.success("当前店铺采集完成，可以直接查看本地分析数据");
});
watch(activePane, () => {
  loadActiveMetaPane().catch(() => {});
});
onMounted(async () => {
  loadCachedFilter();
  if (!state.filters.dateRange?.length) state.filters.dateRange = [todayKey(-6), todayKey(-1)];
  await loadShops();
  await refreshData();
  await Promise.all([loadPluginStatus().catch(() => {}), loadPluginValidation().catch(() => {}), loadAuthBindingStatus().catch(() => {})]);
  startPolling();
  startPluginPolling();
});
onBeforeUnmount(() => {
  stopPolling();
  stopPluginPolling();
});
</script>

<template>
  <div class="seller-analytics-page">
    <div class="seller-sticky-head">
      <section class="seller-toolbar">
        <div class="seller-toolbar__filters">
          <el-select v-model="state.filters.shopId" class="seller-filter seller-filter--shop" placeholder="店铺" @change="handleSearch">
            <el-option v-for="shop in shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
          </el-select>
          <el-select v-model="state.filters.periodKey" class="seller-filter" @change="handlePeriodChange">
            <el-option v-for="item in periods" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-date-picker
            v-model="state.filters.dateRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            class="seller-filter seller-filter--date"
            @change="handleCustomDateRangeChange"
          />
          <el-input v-model="state.filters.keyword" clearable class="seller-filter seller-filter--keyword" placeholder="商品、SKU、建议" @keyup.enter="handleSearch">
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
        </div>
        <div class="seller-toolbar__query">
          <el-button :icon="Search" @click="handleSearch">查询</el-button>
          <el-button :icon="Refresh" @click="refreshData()">刷新</el-button>
        </div>
        <el-select
          v-model="state.filters.tabKey"
          class="seller-filter seller-filter--source"
          placeholder="数据来源"
          @change="handleSearch"
        >
          <template #prefix>数据来源</template>
          <el-option v-for="item in sourceTabs" :key="item.value || 'all'" :label="item.label" :value="item.value" />
        </el-select>
        <span class="seller-toolbar__divider" aria-hidden="true"></span>
        <div class="seller-toolbar__collect">
          <el-button type="primary" :icon="VideoPlay" :loading="collecting" @click="collectFullStore">同步当前区间</el-button>
        </div>
      </section>

      <section class="seller-sync-assistant" :class="`seller-sync-assistant--${pluginSyncStatus.tone}`">
        <div class="seller-sync-assistant__copy">
          <strong>免跳转同步助手</strong>
          <span>选择 ERP 店铺后，系统会自动唤起 Ozon 分析页、识别当前 Ozon 店铺，并在店铺一致后开始同步。</span>
        </div>
        <div class="seller-sync-assistant__steps">
          <div>
            <span>ERP 店铺</span>
            <strong>{{ selectedShopLabel }}</strong>
            <em>ID {{ selectedStoreId || "-" }}</em>
          </div>
          <div>
            <span>插件识别</span>
            <strong>{{ pluginSyncStatus.title }}</strong>
            <em>Ozon 店铺 {{ pluginCompanyLabel }}</em>
          </div>
          <div>
            <span>后端直连</span>
            <strong>{{ directSyncStatus.title }}</strong>
            <em>{{ directSyncStatus.detail }}</em>
          </div>
        </div>
        <div class="seller-sync-assistant__actions">
          <el-button
            v-if="!authBindingStatus?.bound || authBindingStatus?.stale"
            type="warning"
            size="large"
            :loading="bindingAuth"
            @click="bindCurrentShopAuth"
          >
            首次绑定授权
          </el-button>
          <el-button size="large" :loading="metaLoading" @click="loadPluginValidation">重新识别店铺</el-button>
        </div>
        <div class="seller-sync-assistant__progress">
          <div class="seller-sync-assistant__progress-row" :class="`seller-sync-assistant__progress-row--${prepareFlow.tone}`">
            <el-tag :type="prepareFlow.tone === 'danger' ? 'danger' : prepareFlow.tone === 'success' ? 'success' : prepareFlow.tone === 'warning' ? 'warning' : 'info'" effect="light">
              {{ prepareFlow.title }}
            </el-tag>
            <span>{{ prepareFlow.detail }}</span>
          </div>
          <div class="seller-sync-assistant__progress-row" :class="`seller-sync-assistant__progress-row--${collectStatus.tone}`">
            <el-tag :type="collectStatus.tone === 'danger' ? 'danger' : collectStatus.tone === 'success' ? 'success' : collectStatus.tone === 'warning' ? 'warning' : 'info'" effect="light">
              {{ collectStatus.title }}
            </el-tag>
            <span>{{ collectStatus.detail }}</span>
            <strong v-if="runningRun">{{ progressPercent }}%</strong>
          </div>
          <el-progress v-if="runningRun" :percentage="progressPercent" :show-text="false" :stroke-width="6" class="seller-sync-assistant__progress-bar" />
        </div>
      </section>

      <section class="seller-ozon-overview">
        <div class="seller-ozon-overview__head">
          <div class="seller-ozon-overview__summary">
            <strong>经营概览</strong>
            <span>{{ periodHint }}</span>
          </div>
        </div>
        <div class="seller-ozon-metrics">
          <div class="seller-ozon-money">
            <span>订购金额</span>
            <strong>{{ formatMetric(summary.revenue, "money") }}</strong>
            <em>订购数 {{ formatMetric(summary.orderedUnits, "int") }}</em>
          </div>
          <div class="seller-ozon-funnel">
            <div v-for="stage in overviewFunnelStages" :key="stage.key" class="seller-ozon-funnel-stage">
              <span>{{ stage.label }}</span>
              <strong>{{ formatMetric(stage.value, stage.type) }}</strong>
              <em v-if="stage.rate">{{ stage.rate }}</em>
            </div>
          </div>
        </div>
      </section>
    </div>

    <div class="seller-workspace-scroll">
    <el-tabs v-model="activePane" class="seller-tabs seller-tabs--workbench">
      <el-tab-pane label="商品诊断" name="diagnosis">
        <el-table v-loading="loading" :data="tableProducts" :row-key="rowKey" :row-class-name="tableRowClassName" height="100%" class="seller-product-table seller-product-table--compact" @sort-change="handleSortChange">
          <el-table-column label="商品" min-width="320" fixed>
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
          <el-table-column label="诊断" prop="score" sortable="custom" width="150">
            <template #default="{ row }">
              <span v-if="row.isTotalsRow">-</span>
              <template v-else>
                <el-tag :type="priorityType(row.priority)" effect="light">{{ priorityLabel(row.priority) }}优先级</el-tag>
                <div class="seller-score">诊断分 {{ row.score || 0 }}</div>
              </template>
            </template>
          </el-table-column>
          <el-table-column label="优化建议" min-width="420">
            <template #default="{ row }">
              <span v-if="row.isTotalsRow">-</span>
              <template v-else>
                <el-tooltip :content="recommendationTooltipText(row)" placement="top" popper-class="seller-rec-tooltip">
                  <div class="seller-rec-summary" :class="`seller-rec-summary--${recommendationTone(topRecommendation(row))}`">
                    <el-tag :type="recommendationTagType(topRecommendation(row))" effect="light" round>{{ topRecommendation(row)?.type || "建议" }}</el-tag>
                    <span>{{ topRecommendation(row)?.action || "-" }}</span>
                  </div>
                </el-tooltip>
              </template>
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
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="行动项" name="actions">
        <section class="seller-insights seller-insights--workbench">
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
            <header>
              <strong>流量-成交四象限</strong>
              <span>按当前商品集的曝光和订购中位数分组。</span>
            </header>
            <div class="seller-quadrants">
              <div v-for="item in quadrantStats" :key="item.key" :class="`seller-quadrant seller-quadrant--${item.tone}`">
                <span>{{ item.label }}</span>
                <strong>{{ item.count }}</strong>
              </div>
            </div>
          </div>
        </section>
      </el-tab-pane>

      <el-tab-pane label="指标明细" name="metrics">
        <el-table
          v-loading="loading"
          :data="tableProducts"
          :row-key="rowKey"
          :row-class-name="tableRowClassName"
          :default-sort="{ prop: state.sortKey, order: state.sortOrder === 'asc' ? 'ascending' : 'descending' }"
          height="100%"
          class="seller-product-table"
          @sort-change="handleSortChange"
        >
          <el-table-column label="商品" width="360" fixed>
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
          <el-table-column
            v-for="column in visibleTableMetricColumns"
            :key="column.key"
            :label="column.label"
            :prop="column.sortProp"
            :min-width="column.width"
            align="right"
            sortable="custom"
          >
            <template #default="{ row }">
              <el-tooltip :content="compactMetricHelp(column.item)" placement="top" popper-class="seller-compact-tooltip">
                <div class="seller-flat-metric">
                  <strong :class="compactMetricValueClass(row, column.item)">{{ formatCompactMetric(row, column.item) }}</strong>
                  <em v-if="column.item.dynamicsKey && row.metrics?.[column.item.dynamicsKey] !== undefined && row.metrics?.[column.item.dynamicsKey] !== null" :class="metricDynamicsClass(row, column.item)">
                    {{ formatPercent(row.metrics?.[column.item.dynamicsKey], { precision: 0, sign: true }) }}
                  </em>
                </div>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="诊断" prop="score" sortable="custom" width="112">
            <template #default="{ row }">
              <span v-if="row.isTotalsRow">-</span>
              <el-tooltip v-else :content="recommendationTooltipText(row)" placement="top" popper-class="seller-rec-tooltip">
                <div class="seller-diagnosis-chip">
                  <el-tag :type="priorityType(row.priority)" effect="light">{{ priorityLabel(row.priority) }}优先级</el-tag>
                  <div class="seller-score">诊断分 {{ row.score || 0 }}</div>
                </div>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="优化建议" min-width="150">
            <template #default="{ row }">
              <span v-if="row.isTotalsRow">-</span>
              <el-tooltip v-else :content="recommendationTooltipText(row)" placement="top" popper-class="seller-rec-tooltip">
                <el-tag v-if="topRecommendation(row)" :type="recommendationTagType(topRecommendation(row))" effect="light" class="seller-rec-tag">
                  {{ topRecommendation(row).type }}
                </el-tag>
                <span v-else>-</span>
              </el-tooltip>
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
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="优化建议" name="recommendations">
        <el-table :data="recommendationRows" height="100%">
          <el-table-column label="商品" min-width="260">
            <template #default="{ row }">
              <div class="seller-product-cell seller-product-cell--compact">
                <ProductImagePreview :src="row.image_url" fit="cover" size="small" />
                <div><strong>{{ row.product_name || row.offer_id || row.sku || "未命名商品" }}</strong><span>{{ row.offer_id || row.sku || "-" }}</span></div>
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

    </el-tabs>
    </div>

    <PageFooterPagination
      class="seller-global-footer"
      compact
      :total="totalProductCount"
      :page="state.page"
      :page-size="ANALYTICS_PAGE_SIZE"
      :page-sizes="[ANALYTICS_PAGE_SIZE]"
      :summary="productFooterSummary"
      @update:page="handlePageChange"
    />

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
                <template v-for="rate in [funnel.rateByKey.exposureOrder, funnel.rateByKey.clickOrder, funnel.rateByKey.cartOrder]" :key="rate?.key">
                  <el-tooltip v-if="isVisibleFunnelRate(rate)" :content="`${rate?.label}：${rate?.value}；${rate?.helper}`" placement="top">
                    <span :class="`seller-funnel-rate seller-funnel-rate--left seller-funnel-rate--${rate.key}`">
                      <span class="seller-funnel-rate-text"><em>{{ rate.label }}</em><strong>{{ rate.value }}</strong></span>
                    </span>
                  </el-tooltip>
                </template>
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
                <template v-for="rate in [funnel.rateByKey.exposureClick, funnel.rateByKey.clickCart]" :key="rate?.key">
                  <el-tooltip v-if="isVisibleFunnelRate(rate)" :content="`${rate?.label}：${rate?.value}；${rate?.helper}`" placement="top">
                    <span :class="`seller-funnel-rate seller-funnel-rate--right seller-funnel-rate--${rate.key}`">
                      <svg class="seller-funnel-rate-arrow" viewBox="0 0 46 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                        <path d="M1 4C38 4 38 28 8 38" />
                        <path d="M11 32L8 38L14 40" />
                      </svg>
                      <span class="seller-funnel-rate-text"><em>{{ rate.label }}</em><strong>{{ rate.value }}</strong></span>
                    </span>
                  </el-tooltip>
                </template>
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
.seller-analytics-page { display: flex; flex-direction: column; gap: 8px; height: calc(100dvh - 96px); min-height: 0; overflow: hidden; }
.seller-sticky-head { position: sticky; top: 0; z-index: 20; display: flex; flex: 0 0 auto; flex-direction: column; gap: 6px; padding-bottom: 2px; background: var(--el-bg-color); }
.seller-toolbar { display: flex; gap: 10px; align-items: center; min-width: 0; overflow-x: auto; scrollbar-width: none; white-space: nowrap; }
.seller-toolbar::-webkit-scrollbar { display: none; }
.seller-toolbar__filters, .seller-toolbar__query, .seller-toolbar__collect { display: flex; gap: 8px; align-items: center; min-width: 0; flex-wrap: nowrap; }
.seller-toolbar__filters { flex: 0 0 auto; }
.seller-toolbar__query, .seller-toolbar__collect { flex: 0 0 auto; }
.seller-toolbar__divider { width: 1px; height: 24px; background: var(--el-border-color); flex: 0 0 auto; }
.seller-filter { width: 132px; }
.seller-filter--shop { width: 180px; }
.seller-filter--date { width: 250px; }
.seller-filter--keyword { width: 260px; }
.seller-filter--source { width: 156px; }
.seller-source-tabs { display: flex; gap: 6px; min-width: 0; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; flex: 0 1 auto; }
.seller-source-tabs::-webkit-scrollbar { display: none; }
.seller-source-tabs--inline { align-self: center; align-items: center; height: 32px; }
.seller-source-tabs button { flex: 0 0 auto; height: 32px; border: 1px solid var(--el-border-color); background: var(--el-bg-color); border-radius: 6px; padding: 0 11px; cursor: pointer; color: var(--el-text-color-regular); font-size: 14px; line-height: 30px; white-space: nowrap; }
.seller-source-tabs button.is-active { border-color: var(--el-color-primary); color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.seller-sync-assistant { display: grid; grid-template-columns: minmax(170px, 240px) minmax(330px, 1fr) auto minmax(260px, 360px); gap: 10px; align-items: center; padding: 9px 12px; border: 1px solid rgba(37, 99, 235, 0.18); border-radius: 12px; background: radial-gradient(circle at 0% 0%, rgba(59, 130, 246, 0.14), transparent 30%), linear-gradient(135deg, #eff6ff 0%, #f8fafc 52%, #ecfeff 100%); box-shadow: 0 10px 24px rgba(15, 23, 42, 0.06); }
.seller-sync-assistant--success { border-color: rgba(34, 197, 94, 0.3); background: radial-gradient(circle at 0% 0%, rgba(34, 197, 94, 0.16), transparent 30%), linear-gradient(135deg, #f0fdf4 0%, #f8fafc 52%, #ecfeff 100%); }
.seller-sync-assistant--warning { border-color: rgba(245, 158, 11, 0.32); background: radial-gradient(circle at 0% 0%, rgba(245, 158, 11, 0.18), transparent 30%), linear-gradient(135deg, #fffbeb 0%, #f8fafc 52%, #eff6ff 100%); }
.seller-sync-assistant--danger { border-color: rgba(239, 68, 68, 0.28); background: radial-gradient(circle at 0% 0%, rgba(239, 68, 68, 0.16), transparent 30%), linear-gradient(135deg, #fef2f2 0%, #f8fafc 52%, #eff6ff 100%); }
.seller-sync-assistant__copy { display: grid; gap: 3px; min-width: 0; }
.seller-sync-assistant__copy strong { color: #0f172a; font-size: 16px; letter-spacing: .01em; }
.seller-sync-assistant__copy span { overflow: hidden; color: #475569; font-size: 12px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.seller-sync-assistant__steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; min-width: 0; }
.seller-sync-assistant__steps > div { display: grid; gap: 2px; min-width: 0; padding: 6px 8px; border: 1px solid rgba(148, 163, 184, 0.18); border-radius: 9px; background: rgba(255, 255, 255, 0.72); backdrop-filter: blur(6px); }
.seller-sync-assistant__steps span { color: #64748b; font-size: 12px; }
.seller-sync-assistant__steps strong { overflow: hidden; color: #0f172a; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.seller-sync-assistant__steps em { overflow: hidden; color: #64748b; font-size: 12px; font-style: normal; text-overflow: ellipsis; white-space: nowrap; }
.seller-sync-assistant__actions { display: flex; gap: 8px; justify-content: flex-end; white-space: nowrap; }
.seller-sync-assistant__progress { display: grid; gap: 5px; min-width: 0; padding: 7px 9px; border: 1px solid rgba(148, 163, 184, 0.18); border-radius: 10px; background: rgba(255, 255, 255, 0.66); }
.seller-sync-assistant__progress-row { display: flex; gap: 6px; align-items: center; min-width: 0; color: #64748b; font-size: 12px; }
.seller-sync-assistant__progress-row .el-tag { flex: 0 0 auto; }
.seller-sync-assistant__progress-row span { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seller-sync-assistant__progress-row strong { flex: 0 0 auto; color: #0f172a; font-size: 13px; }
.seller-sync-assistant__progress-row--success span { color: var(--el-color-success); }
.seller-sync-assistant__progress-row--warning span { color: var(--el-color-warning); }
.seller-sync-assistant__progress-row--danger span { color: var(--el-color-danger); }
.seller-sync-assistant__progress-bar { width: 100%; }
.seller-ozon-overview { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 6px; align-items: stretch; overflow: hidden; flex: 0 0 auto; padding: 5px 7px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; background: var(--el-bg-color); }
.seller-ozon-overview__head { display: flex; min-width: 0; color: var(--el-text-color-secondary); }
.seller-ozon-overview__summary { display: grid; gap: 2px; align-content: center; min-width: 0; }
.seller-ozon-overview__head strong { color: var(--el-text-color-primary); font-size: 14px; }
.seller-ozon-overview__head span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.seller-plugin-status { display: grid; gap: 8px; min-width: 0; }
.seller-plugin-status .el-tag { width: fit-content; }
.seller-plugin-status > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.seller-plugin-status--success > span { color: var(--el-color-success); }
.seller-plugin-status--warning > span { color: var(--el-color-warning); }
.seller-plugin-status--danger > span { color: var(--el-color-danger); }
.seller-collect-panel { display: grid; flex: 0 0 280px; gap: 8px; align-content: start; min-width: 240px; padding: 10px 12px; border-radius: 10px; background: linear-gradient(180deg, #f8fbff 0%, #f4f7fb 100%); border: 1px solid rgba(191, 219, 254, 0.55); }
.seller-collect-panel > strong { color: var(--el-text-color-primary); font-size: 14px; }
.seller-collect-status { display: grid; gap: 8px; min-width: 0; }
.seller-collect-status > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: normal; line-height: 1.45; }
.seller-collect-status--success > span { color: var(--el-color-success); }
.seller-collect-status--warning > span { color: var(--el-color-warning); }
.seller-collect-status--danger > span { color: var(--el-color-danger); }
.seller-ozon-metrics { display: grid; grid-template-columns: minmax(178px, 220px) minmax(0, 1fr); gap: 6px; align-items: stretch; min-width: 0; }
.seller-ozon-money { display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-areas: "label value" "sub sub"; gap: 1px 8px; align-items: center; min-height: 38px; padding: 5px 8px; border-radius: 7px; border: 1px solid rgba(148, 163, 184, 0.16); background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7); }
.seller-ozon-money span,
.seller-ozon-funnel-stage span { color: var(--el-text-color-secondary); font-size: 12px; }
.seller-ozon-money span { grid-area: label; }
.seller-ozon-money strong { grid-area: value; overflow: hidden; color: var(--el-text-color-primary); font-size: 18px; line-height: 1.1; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.seller-ozon-money em,
.seller-ozon-funnel-stage em { color: var(--el-text-color-secondary); font-style: normal; font-size: 12px; }
.seller-ozon-money em { grid-area: sub; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seller-ozon-funnel { display: grid; grid-template-columns: repeat(4, minmax(112px, 1fr)); align-items: stretch; overflow: hidden; border: 1px solid var(--el-border-color-lighter); border-radius: 7px; background: #fff; }
.seller-ozon-funnel-stage { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "label rate" "value rate"; gap: 1px 8px; align-items: center; min-height: 38px; padding: 5px 8px; background: linear-gradient(90deg, #ffffff 0%, #f8fbff 100%); }
.seller-ozon-funnel-stage + .seller-ozon-funnel-stage { border-left: 1px solid var(--el-border-color-lighter); }
.seller-ozon-funnel-stage + .seller-ozon-funnel-stage::before { content: ""; position: absolute; left: -7px; top: 50%; width: 12px; height: 12px; border-top: 1px solid var(--el-border-color); border-right: 1px solid var(--el-border-color); background: #fff; transform: translateY(-50%) rotate(45deg); }
.seller-ozon-funnel-stage span { grid-area: label; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seller-ozon-funnel-stage strong { grid-area: value; overflow: hidden; color: var(--el-text-color-primary); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.seller-ozon-funnel-stage em { grid-area: rate; align-self: center; justify-self: end; color: #64748b; font-size: 12px; }
.seller-collect-progress { width: 100%; }
.seller-insights { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.seller-insights--workbench { display: grid; margin-top: 4px; }
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
.seller-workspace-scroll { min-height: 0; flex: 1 1 auto; overflow: hidden; }
.seller-tabs { height: 100%; min-height: 0; }
.seller-tabs :deep(.el-tabs__content) { height: calc(100% - 42px); min-height: 0; overflow: hidden; }
.seller-tabs :deep(.el-tab-pane) { height: 100%; min-height: 0; overflow: hidden; }
.seller-tabs :deep(.el-table) { height: 100% !important; }
.seller-tabs :deep(.el-table__header-wrapper),
.seller-tabs :deep(.el-table__fixed-header-wrapper),
.seller-tabs :deep(.el-table__fixed-right .el-table__fixed-header-wrapper) { z-index: 6; }
.seller-tabs--workbench :deep(.el-tabs__header) { position: relative; z-index: 10; margin-bottom: 8px; background: var(--el-bg-color); }
.seller-tabs--workbench :deep(.el-tabs__nav) { display: flex; }
.seller-tabs--workbench :deep(#tab-metrics) { order: 1; }
.seller-tabs--workbench :deep(#tab-actions) { order: 2; }
.seller-tabs--workbench :deep(#tab-diagnosis) { order: 3; }
.seller-tabs--workbench :deep(#tab-recommendations) { order: 4; }
.seller-global-footer { flex: 0 0 auto; margin-top: 0; border-radius: 0 0 12px 12px; }
.seller-global-footer :deep(.erp-footer-pagination__meta) { font-size: 12px; }
.seller-global-footer :deep(.erp-footer-pagination__actions) { gap: 8px; }
.seller-global-footer :deep(.el-pagination) { --el-pagination-button-width: 28px; --el-pagination-button-height: 28px; }
.seller-global-footer :deep(.el-pagination button),
.seller-global-footer :deep(.el-pagination .el-pager li) { min-width: 28px; height: 28px; border-radius: 8px; }
.seller-table-actions { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; color: var(--el-text-color-secondary); }
.seller-product-table :deep(.el-table__row) { height: 90px; background: #fff; }
.seller-product-table :deep(.el-table__cell) { padding: 4px 0; }
.seller-product-table--compact :deep(.el-table__row) { height: 58px; }
.seller-product-table--compact :deep(.el-table__cell) { padding: 5px 0; }
.seller-product-table :deep(.seller-product-table__row--totals) { background: #fffdf5; font-weight: 700; }
.seller-product-table :deep(.seller-product-table__row--high) { background: #fffafa; }
.seller-product-table :deep(.seller-product-table__row--medium) { background: #fffdf8; }
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
.seller-compact-metrics { display: grid; gap: 0; min-width: 0; padding: 0; }
.seller-compact-metric { display: grid; grid-template-columns: 34px minmax(44px, 1fr) 30px; gap: 4px; align-items: baseline; min-width: 0; min-height: 19px; color: #7a8494; font-size: 11px; line-height: 18px; }
.seller-compact-metric + .seller-compact-metric { border-top: 1px solid rgba(226, 232, 240, 0.72); }
.seller-compact-metric span,
.seller-compact-metric strong,
.seller-compact-metric em { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seller-compact-metric strong { color: #1f2937; font-size: 12px; font-weight: 650; text-align: right; }
.seller-compact-metric em { color: #8a94a6; font-style: normal; font-size: 10px; text-align: right; }
.seller-compact-metric__label { cursor: help; text-decoration: underline dotted transparent; text-underline-offset: 3px; }
.seller-compact-metric__label:hover { color: var(--el-color-primary); text-decoration-color: currentColor; }
.seller-compact-tooltip { max-width: 320px; line-height: 1.45; }
.seller-flat-metric { display: grid; justify-items: end; gap: 2px; min-width: 0; line-height: 20px; }
.seller-flat-metric strong,
.seller-flat-metric em { overflow: hidden; max-width: 100%; text-overflow: ellipsis; white-space: nowrap; }
.seller-flat-metric strong { color: #111827; font-size: 14px; font-weight: 750; }
.seller-flat-metric em { color: #7b8797; font-size: 12px; font-style: normal; }
.seller-diagnosis-chip { display: inline-grid; gap: 4px; cursor: help; }
.seller-tone--success { color: #43845a !important; }
.seller-tone--warning { color: #9a6a18 !important; }
.seller-tone--danger { color: #a64646 !important; }
.seller-abc-cell { display: inline-flex; gap: 5px; align-items: center; justify-content: center; }
.seller-abc-badge { min-width: 24px; border-radius: 4px; padding: 1px 6px; text-align: center; font-weight: 700; line-height: 20px; background: var(--el-fill-color-light); color: var(--el-text-color-secondary); }
.seller-abc-badge--a { background: var(--el-color-success-light-8); color: var(--el-color-success); }
.seller-abc-badge--b { background: var(--el-color-warning-light-8); color: var(--el-color-warning); }
.seller-abc-badge--c { background: var(--el-color-danger-light-8); color: var(--el-color-danger); }
.seller-rec-list { display: flex; flex-direction: column; gap: 6px; font-size: 12px; line-height: 1.35; }
.seller-rec-summary { display: flex; align-items: center; gap: 8px; min-width: 0; line-height: 24px; }
.seller-rec-summary .el-tag { flex: 0 0 auto; max-width: 96px; }
.seller-rec-summary span { min-width: 0; overflow: hidden; color: var(--el-text-color-primary); text-overflow: ellipsis; white-space: nowrap; }
.seller-rec-summary--danger span { color: var(--el-color-danger); }
.seller-rec-summary--warning span { color: var(--el-color-warning); }
.seller-rec-summary--traffic span { color: var(--el-color-primary); }
.seller-rec-summary--conversion span { color: var(--el-color-success); }
.seller-rec-tooltip { max-width: 520px; white-space: pre-line; line-height: 1.55; overflow-wrap: anywhere; }
.seller-compact-tooltip { max-width: 360px; white-space: normal; line-height: 1.55; overflow-wrap: anywhere; }
:global(.seller-rec-tooltip),
:global(.seller-compact-tooltip) {
  max-width: min(560px, calc(100vw - 48px));
  border: 1px solid #dbe3ef !important;
  border-radius: 10px !important;
  background: #fff !important;
  color: #1f2937 !important;
  box-shadow: 0 14px 34px rgba(15, 23, 42, 0.14) !important;
  white-space: pre-line !important;
  line-height: 1.55 !important;
  overflow-wrap: anywhere !important;
}
:global(.seller-rec-tooltip .el-popper__arrow::before),
:global(.seller-compact-tooltip .el-popper__arrow::before) {
  background: #fff !important;
  border-color: #dbe3ef !important;
}
.seller-rec-tag { max-width: 96px; }
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
.seller-conversion-chain { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; align-items: stretch; min-width: 0; }
.seller-conversion-step { position: relative; display: grid; gap: 2px; min-width: 0; min-height: 58px; padding: 7px 8px; border: 1px solid #e2e8f0; border-radius: 9px; background: #fff; }
.seller-conversion-step + .seller-conversion-step::before { content: ""; position: absolute; left: -8px; top: 50%; width: 9px; height: 9px; border-top: 1px solid #cbd5e1; border-right: 1px solid #cbd5e1; background: #fff; transform: translateY(-50%) rotate(45deg); }
.seller-conversion-step span,
.seller-conversion-step strong,
.seller-conversion-step em { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seller-conversion-step span { color: #64748b; font-size: 11px; line-height: 14px; }
.seller-conversion-step strong { color: #0f172a; font-size: 13px; line-height: 16px; }
.seller-conversion-step em { align-self: end; color: #64748b; font-size: 11px; font-style: normal; line-height: 14px; }
.seller-conversion-step--exposure { border-left: 3px solid #93c5fd; }
.seller-conversion-step--click { border-left: 3px solid #5eead4; }
.seller-conversion-step--cart { border-left: 3px solid #fcd34d; }
.seller-conversion-step--order { border-left: 3px solid #fca5a5; }
.seller-funnel { display: grid; gap: 8px; min-width: 0; }
.seller-funnel--compact { gap: 4px; }
.seller-funnel-flow { display: grid; grid-template-columns: 96px minmax(0, 1fr) 132px; gap: 6px; align-items: stretch; min-width: 0; }
.seller-funnel--compact .seller-funnel-flow { grid-template-columns: 96px minmax(0, 1fr) 118px; gap: 6px; }
.seller-funnel-stages { display: grid; gap: 8px; min-width: 0; }
.seller-funnel--compact .seller-funnel-stages { gap: 4px; }
.seller-funnel-stage { display: grid; gap: 3px; min-width: 0; }
.seller-funnel-label { display: grid; grid-template-columns: 54px minmax(42px, 1fr); gap: 6px; align-items: center; color: #64748b; font-size: 12px; line-height: 16px; }
.seller-funnel--compact .seller-funnel-label { grid-template-columns: 42px minmax(48px, 1fr); }
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
.seller-funnel--compact .seller-funnel-left-arrows { width: 96px; }
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
.seller-funnel--compact .seller-funnel-rate--left { width: 96px; grid-template-columns: 38px minmax(0, 1fr); }
.seller-funnel--compact .seller-funnel-rate--right { width: 118px; grid-template-columns: 42px minmax(0, 1fr); }
.seller-funnel--compact .seller-funnel-rate--right .seller-funnel-rate-text { left: 46px; }
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
  .seller-sync-assistant { grid-template-columns: 1fr; align-items: stretch; }
  .seller-sync-assistant__actions { justify-content: flex-start; flex-wrap: wrap; }
  .seller-ozon-overview { flex-direction: column; }
  .seller-ozon-overview__head { min-width: 0; max-width: none; }
  .seller-ozon-metrics { grid-template-columns: 122px minmax(0, 1fr); }
  .seller-collect-panel { min-width: 0; }
  .seller-insights { grid-template-columns: 1fr; }
}
</style>
