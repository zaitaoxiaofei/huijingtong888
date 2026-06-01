<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Refresh, Search } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import { buildAdTasks, evaluateAdSku, summarizeAdDashboard, toneType } from "./ad-rules";
import PageFooterPagination from "../../components/PageFooterPagination.vue";

const loading = ref(false);
const syncing = ref(false);
const detailLoading = ref(false);
const detailVisible = ref(false);
const profitDetailVisible = ref(false);
const strategyDialogVisible = ref(false);
const strategySubmitting = ref(false);
const activeTab = ref("dashboard");
const shops = ref([]);
const summary = ref({});
const quality = ref(null);
const detailRows = ref([]);
const trendRows = ref([]);
const currentRow = ref(null);
const strategyForm = reactive({
  mode: "bid",
  bidRub: 0,
  targetCir: 0
});
const state = reactive({
  rows: [],
  total: 0,
  page: 1,
  pageSize: 20,
  sortBy: "spend_rub",
  sortOrder: "descending",
  filters: {
    shopId: "",
    from: dateDaysAgo(6),
    to: todayKey(),
    keyword: "",
    adStatus: "active",
    adStage: "all",
    adType: "all"
  }
});
const tableFilters = reactive({
  action: "",
  diagnosis: "",
  sortProp: "",
  sortOrder: ""
});

const enrichedRows = computed(() => state.rows.map((row) => ({ ...row, evaluation: evaluateAdSku(row) })));
const filteredRows = computed(() => enrichedRows.value.filter(matchesFilters));
const settledRows = computed(() => filteredRows.value.filter((row) => !isAdPending(row)));
const pendingRows = computed(() => filteredRows.value.filter(isAdPending));
const filteredSummary = computed(() => summarizeRows(settledRows.value));
const dashboard = computed(() => summarizeAdDashboard(settledRows.value));
const tasks = computed(() => buildAdTasks(settledRows.value));
const prioritizedTasks = computed(() => [...tasks.value]
  .map((task) => ({ ...task, priorityScore: taskPriorityScore(task), priorityLabel: taskPriorityLabel(taskPriorityScore(task)) }))
  .sort((a, b) => b.priorityScore - a.priorityScore));
const taskPages = reactive({
  pending: 1,
  processing: 1,
  done: 1,
  pageSize: 5
});
const taskColumns = computed(() => [
  { key: "pending", label: "待处理", rows: prioritizedTasks.value },
  { key: "processing", label: "处理中", rows: [] },
  { key: "done", label: "已完成", rows: [] }
]);
const tableFilteredRows = computed(() => filteredRows.value.filter(matchesTableFilters));
const tableSortedRows = computed(() => {
  const rows = [...tableFilteredRows.value];
  const prop = tableFilters.sortProp;
  const order = tableFilters.sortOrder;
  if (!prop || !order) return rows.sort((a, b) => priorityRank(a) - priorityRank(b));
  const direction = order === "ascending" ? 1 : -1;
  return rows.sort((a, b) => {
    const diff = tableSortValue(a, prop) - tableSortValue(b, prop);
    if (diff !== 0) return diff * direction;
    return priorityRank(a) - priorityRank(b);
  });
});
const pagedRows = computed(() => {
  const sorted = tableSortedRows.value;
  const start = (state.page - 1) * state.pageSize;
  return sorted.slice(start, start + state.pageSize);
});
const diagnosisOptions = computed(() => {
  const values = [...new Set(filteredRows.value.map((row) => primaryTag(row).label).filter(Boolean))];
  return values.map((value) => ({ value, label: value }));
});
const storeSpendRank = computed(() => {
  const map = new Map();
  for (const row of settledRows.value) {
    const key = String(row.shop_id || row.shop_name || "unknown");
    const current = map.get(key) || {
      shop_id: row.shop_id,
      shop_name: row.shop_name || "未知店铺",
      spend: 0,
      revenue: 0,
      clicks: 0,
      addToCart: 0,
      impressions: 0,
      orders: 0,
      skuCount: new Set()
    };
    current.spend += Number(row.evaluation.metrics.spend || 0);
    current.revenue += Number(row.evaluation.metrics.revenue || 0);
    current.clicks += Number(row.evaluation.metrics.clicks || 0);
    current.addToCart += Number(row.evaluation.metrics.addToCart || 0);
    current.impressions += Number(row.evaluation.metrics.impressions || 0);
    current.orders += Number(row.evaluation.metrics.orders || 0);
    current.skuCount.add(String(row.ozon_sku || ""));
    map.set(key, current);
  }
  return [...map.values()]
    .map((item) => ({
      ...item,
      skuTotal: item.skuCount.size,
      roas: item.spend > 0 ? item.revenue / item.spend : 0,
      ctr: item.impressions > 0 ? item.clicks / item.impressions : 0,
      cr: item.clicks > 0 ? item.orders / item.clicks : 0
    }))
    .sort((a, b) => b.spend - a.spend);
});
const highSpendSkuRank = computed(() => [...settledRows.value]
  .sort((a, b) => b.evaluation.metrics.spend - a.evaluation.metrics.spend));
const maxStoreCompare = computed(() => Math.max(1, ...storeSpendRank.value.flatMap((item) => [item.spend, item.revenue])));
const maxSkuCompare = computed(() => Math.max(1, ...highSpendSkuRank.value.flatMap((row) => [
  row.evaluation.metrics.spend,
  row.evaluation.metrics.revenue
])));
const ctrTopRows = computed(() => [...settledRows.value].sort((a, b) => b.evaluation.metrics.ctr - a.evaluation.metrics.ctr).slice(0, 5));
const trendSeries = computed(() => {
  const map = new Map();
  const scopedTrendRows = trendRows.value
    .map((row) => ({ ...row, evaluation: evaluateAdSku(row) }))
    .filter((row) => matchesFilters(row) && !isAdPending(row));
  for (const row of scopedTrendRows) {
    const date = String(row.date_key || "").slice(0, 10);
    if (!date) continue;
    const current = map.get(date) || { date, spend: 0, revenue: 0, clicks: 0, addToCart: 0, impressions: 0, orders: 0 };
    current.spend += Number(row.spend_rub || 0);
    current.revenue += Number(row.revenue_rub || 0);
    current.clicks += Number(row.clicks || 0);
    current.addToCart += Number(row.add_to_cart || 0);
    current.impressions += Number(row.impressions || 0);
    current.orders += Number(row.orders || 0);
    map.set(date, current);
  }
  return [...map.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((item) => ({
      ...item,
      roas: item.spend > 0 ? item.revenue / item.spend : 0,
      ctr: item.impressions > 0 ? item.clicks / item.impressions : 0,
      cr: item.clicks > 0 ? item.orders / item.clicks : 0
    }));
});
const trendMax = computed(() => ({
  spend: Math.max(1, ...trendSeries.value.map((item) => item.spend)),
  roas: Math.max(1, ...trendSeries.value.map((item) => item.roas)),
  ctr: Math.max(0.01, ...trendSeries.value.map((item) => item.ctr)),
  cr: Math.max(0.01, ...trendSeries.value.map((item) => item.cr))
}));
const qualitySummary = computed(() => quality.value?.summary || {});
const qualityIssues = computed(() => Array.isArray(quality.value?.issues) ? quality.value.issues.slice(0, 3) : []);
const qualityStatus = computed(() => {
  if (!quality.value) return { type: "info", label: "同步状态待检查" };
  if (quality.value.status === "danger") return { type: "danger", label: "同步高风险" };
  if (quality.value.status === "warning") return { type: "warning", label: "同步需复核" };
  return { type: "success", label: "同步正常" };
});
const pendingRatioText = computed(() => percent(qualitySummary.value.pendingRatio || 0));
const pendingRowsText = computed(() => `${integer(qualitySummary.value.pendingRows || pendingRows.value.length)} 行 / ${integer(qualitySummary.value.pendingSkuCount || 0)} SKU`);
const settledRowsText = computed(() => `${integer(qualitySummary.value.settledRows || settledRows.value.length)} 行已返回`);
const todoModules = computed(() => [
  {
    key: "stop",
    title: "停广告",
    desc: "亏本/烧钱先复核",
    action: "筛选待停",
    tone: "danger",
    rows: settledRows.value.filter(rowNeedsStop)
  },
  {
    key: "budget",
    title: "加预算",
    desc: "高回报 SKU 放量",
    action: "筛选机会",
    tone: "success",
    rows: settledRows.value.filter(rowCanScale)
  },
  {
    key: "accounting",
    title: "补充核算信息",
    desc: "补成本/绑定/利润",
    action: "筛选缺口",
    tone: "warning",
    rows: settledRows.value.filter(rowNeedsAccounting)
  },
  {
    key: "optimize",
    title: "优化 SKU",
    desc: "进 AI 素材优化",
    action: "筛选优化",
    tone: "primary",
    rows: settledRows.value.filter(rowNeedsOptimization)
  }
]);
const activeTodoModule = computed(() => todoModules.value.find((item) => item.key === tableFilters.action) || null);

const countMainImageTasks = computed(() => settledRows.value.filter((row) => row.evaluation.tags.some((tag) => tag.label.includes("主图"))).length);
const countDetailTasks = computed(() => settledRows.value.filter((row) => row.evaluation.tags.some((tag) => tag.label.includes("转化"))).length);
const averageCpc = computed(() => Number(filteredSummary.value.clicks || 0) ? Number(filteredSummary.value.spend_rub || 0) / Number(filteredSummary.value.clicks || 1) : 0);
const riskSkuCount = computed(() => settledRows.value.filter((row) => ["pause", "optimize"].includes(row.evaluation.status.key)).length);
const storeHealth = computed(() => ({
  score: dashboard.value.averageScore,
  label: dashboard.value.averageScore >= 78 ? "表现稳定" : dashboard.value.averageScore >= 60 ? "需观察" : dashboard.value.averageScore >= 35 ? "存在风险" : "高风险",
  tone: scoreTone(dashboard.value.averageScore)
}));

const aiConclusion = computed(() => {
  if (!filteredRows.value.length) return "当前筛选范围内还没有广告数据，请先同步 Ozon 广告。";
  return `已按已返回报表计算，排除 ${integer(pendingRows.value.length)} 条待返回数据。`;
});

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function money(value) {
  return `RUB ${Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function rub(value) {
  return Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function integer(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function decimal(value) {
  return Number(value || 0).toFixed(2);
}

function plainPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function compactMoney(value) {
  return Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

function campaignStrategyText(row = {}) {
  const strategy = String(row.campaign_strategies || row.campaign_strategy || "").trim();
  const bid = Number(row.campaign_bid_rub || 0);
  const targetCir = Number(row.campaign_target_cir || 0);
  if (strategy.includes("TARGET_CIR")) return `目标广告费用份额${targetCir > 0 ? ` ${targetCir}%` : ""}`;
  if (strategy.includes("TARGET_BIDS")) return `按点击出价${bid > 0 ? ` ${rub(bid)} RUB` : ""}`;
  if (strategy.includes("TOP_PROMOTION")) return `登上顶端${bid > 0 ? ` ${rub(bid)} RUB` : ""}`;
  if (strategy) return strategy;
  const payment = String(row.campaign_payment_types || row.campaign_payment_type || "").trim();
  if (payment.includes("CPC")) return `按点击付费${bid > 0 ? ` ${rub(bid)} RUB` : ""}`;
  return "\u5f85\u540c\u6b65";
}

function campaignStrategyMode(row = {}) {
  const strategy = String(row.campaign_strategies || row.campaign_strategy || "").trim();
  if (strategy.includes("TARGET_CIR")) return "targetCir";
  if (strategy.includes("TARGET_BIDS") || strategy.includes("TOP_PROMOTION")) return "bid";
  const payment = String(row.campaign_payment_types || row.campaign_payment_type || "").trim();
  if (payment.includes("CPC")) return "bid";
  return Number(row.campaign_target_cir || 0) > 0 ? "targetCir" : "bid";
}

function campaignPlacementText(row = {}) {
  const raw = String(row.campaign_placements || row.campaign_placement || "").trim();
  if (!raw) return "\u6295\u653e\u4f4d\u7f6e\u5f85\u540c\u6b65";
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (item === "PLACEMENT_SEARCH_AND_CATEGORY") return "搜索与推荐";
      if (item === "PLACEMENT_TOP_PROMOTION") return "登上顶端";
      if (item === "PLACEMENT_SEARCH") return "搜索";
      if (item === "PLACEMENT_CATEGORY") return "类目";
      return item;
    })
    .join(" / ");
}

function budgetCompactText(row = {}) {
  const budget = Number(row.campaign_budget_rub || 0);
  if (budget <= 0) return "\u5f85\u540c\u6b65";
  return `${compactMoney(budget)} RUB`;
}

function adFeeShareText(row = {}) {
  const spend = Number(row.evaluation?.metrics?.spend || row.spend_rub || 0);
  const revenue = Number(row.evaluation?.metrics?.revenue || row.revenue_rub || 0);
  if (revenue <= 0) return spend > 0 ? "\u65e0\u9500\u552e\u989d" : "0.0%";
  return plainPercent(spend / revenue);
}

function funnelText(row = {}) {
  const impressions = Number(row.evaluation?.metrics?.impressions || row.impressions || 0);
  const clicks = Number(row.evaluation?.metrics?.clicks || row.clicks || 0);
  const addToCart = Number(row.evaluation?.metrics?.addToCart || row.add_to_cart || 0);
  const addToCartAvailable = Boolean(row.evaluation?.metrics?.addToCartAvailable || Number(row.add_to_cart_available || 0) > 0);
  const orders = Number(row.evaluation?.metrics?.orders || row.orders || 0);
  return `${integer(impressions)} / ${integer(clicks)} / ${addToCartAvailable ? integer(addToCart) : "未返回"} / ${integer(orders)}`;
}

function salesCompactText(row = {}) {
  const units = Number(row.units || row.evaluation?.metrics?.orders || 0);
  const revenue = Number(row.evaluation?.metrics?.revenue || row.revenue_rub || 0);
  return `${integer(units)} \u4ef6 / ${compactMoney(revenue)} RUB`;
}

function isAdPending(row = {}) {
  return Boolean(row.data_pending)
    || Number(row.pending_rows || 0) > 0
    || String(row.source || "") === "ozon_performance_pending";
}

function summarizeRows(rows = []) {
  const total = rows.reduce((acc, row) => {
    const metrics = row.evaluation?.metrics || evaluateAdSku(row).metrics;
    acc.spend_rub += Number(metrics.spend || row.spend_rub || 0);
    acc.revenue_rub += Number(metrics.revenue || row.revenue_rub || 0);
    acc.impressions += Number(metrics.impressions || row.impressions || 0);
    acc.clicks += Number(metrics.clicks || row.clicks || 0);
    acc.add_to_cart += Number(metrics.addToCart || row.add_to_cart || 0);
    acc.add_to_cart_available = acc.add_to_cart_available || Number(metrics.addToCartAvailable || row.add_to_cart_available || 0);
    acc.orders += Number(metrics.orders || row.orders || 0);
    acc.units += Number(row.units || 0);
    return acc;
  }, { spend_rub: 0, revenue_rub: 0, impressions: 0, clicks: 0, add_to_cart: 0, add_to_cart_available: 0, orders: 0, units: 0 });
  return {
    ...total,
    ctr: total.impressions ? total.clicks / total.impressions : 0,
    conversion_rate: total.clicks ? total.orders / total.clicks : 0,
    acos: total.revenue_rub ? total.spend_rub / total.revenue_rub : 0,
    roas: total.spend_rub ? total.revenue_rub / total.spend_rub : 0
  };
}

function taskPriorityScore(task) {
  let score = 0;
  if (task.type === "stop_loss") score += 100;
  if (task.type === "main_image") score += 80;
  if (task.type === "detail_page") score += 70;
  if (task.type === "budget") score += 45;
  score += Math.max(0, 100 - Number(task.healthScore || 0));
  return score;
}

function taskPriorityLabel(score) {
  if (score >= 130) return "P0 高危";
  if (score >= 95) return "P1 优先";
  if (score >= 70) return "P2 常规";
  return "P3 观察";
}

function pagedTasks(column) {
  return column.rows.slice(0, taskPages.pageSize);
}

function trendValue(row, metric) {
  if (metric === "spend") return Number(row.spend || 0);
  if (metric === "roas") return Number(row.roas || 0);
  if (metric === "ctr") return Number(row.ctr || 0);
  if (metric === "cr") return Number(row.cr || 0);
  return 0;
}

function trendLabel(row, metric) {
  if (metric === "spend") return money(row.spend);
  if (metric === "roas") return decimal(row.roas);
  if (metric === "ctr") return percent(row.ctr);
  if (metric === "cr") return percent(row.cr);
  return "";
}

function trendBarHeight(row, metric) {
  const max = Number(trendMax.value[metric] || 1);
  return `${Math.max(8, Math.min(100, (trendValue(row, metric) / max) * 100))}%`;
}

function scoreTone(score) {
  if (score >= 78) return "success";
  if (score >= 60) return "warning";
  if (score >= 35) return "orange";
  return "danger";
}

function matchesFilters(row, options = {}) {
  if (!options.ignoreShop && state.filters.shopId && String(row.shop_id || row.shop_name) !== state.filters.shopId) return false;
  const keyword = String(state.filters.keyword || "").trim().toLowerCase();
  if (keyword) {
    const haystack = [row.ozon_sku, row.product_name, row.offer_id, row.shop_name, row.ad_types].join(" ").toLowerCase();
    if (!haystack.includes(keyword)) return false;
  }
  if (state.filters.adStatus === "active") return campaignStatus(row).key === "active";
  if (state.filters.adStatus === "closed") return campaignStatus(row).key === "closed";
  if (state.filters.adStatus !== "all" && row.evaluation.status.key !== state.filters.adStatus) return false;
  if (state.filters.adStage !== "all" && row.evaluation.stage.key !== state.filters.adStage) return false;
  if (state.filters.adType !== "all" && !String(row.ad_types || "").toLowerCase().includes(state.filters.adType.toLowerCase())) return false;
  return true;
}

function matchesTableFilters(row) {
  if (tableFilters.action) {
    if (tableFilters.action === "stop" && !rowNeedsStop(row)) return false;
    if (tableFilters.action === "budget" && !rowCanScale(row)) return false;
    if (tableFilters.action === "accounting" && !rowNeedsAccounting(row)) return false;
    if (tableFilters.action === "optimize" && !rowNeedsOptimization(row)) return false;
  }
  if (tableFilters.diagnosis && primaryTag(row).label !== tableFilters.diagnosis) return false;
  return true;
}

function rowNeedsStop(row = {}) {
  if (isAdPending(row)) return false;
  const metrics = row.evaluation?.metrics || evaluateAdSku(row).metrics;
  return row.evaluation?.status?.key === "pause"
    || (Number(metrics.spend || 0) >= 300 && Number(metrics.orders || 0) === 0)
    || (Number(metrics.spend || 0) > 0 && Number(metrics.roas || 0) > 0 && Number(metrics.roas || 0) < 1);
}

function rowCanScale(row = {}) {
  if (isAdPending(row)) return false;
  const metrics = row.evaluation?.metrics || evaluateAdSku(row).metrics;
  return row.evaluation?.status?.key === "scale"
    || (Number(metrics.roas || 0) >= 4 && Number(metrics.cr || 0) >= 0.03 && Number(metrics.orders || 0) > 0);
}

function rowNeedsAccounting(row = {}) {
  if (isAdPending(row)) return false;
  return row.gross_margin_rate == null
    || row.ad_net_profit_rate == null
    || !Number(row.product_id || 0)
    || !Number(row.model_purchase_cost_cny || row.product_purchase_cost || 0);
}

function rowNeedsOptimization(row = {}) {
  if (isAdPending(row)) return false;
  const tags = row.evaluation?.tags || [];
  return row.evaluation?.status?.key === "optimize"
    || tags.some((tag) => ["主图", "转化", "低CTR", "低CR"].some((keyword) => String(tag.label || "").includes(keyword)));
}

function tableSortValue(row, prop) {
  if (prop === "roas") return Number(row.evaluation.metrics.roas || 0);
  if (prop === "ctr") return Number(row.evaluation.metrics.ctr || 0);
  if (prop === "cr") return Number(row.evaluation.metrics.cr || 0);
  if (prop === "cpc") return Number(row.evaluation.metrics.cpc || 0);
  if (prop === "feeShare") return Number(row.evaluation.metrics.acos || 0);
  if (prop === "add_to_cart") return Number(row.evaluation.metrics.addToCart || 0);
  if (prop === "acos") return Number(row.evaluation.metrics.acos || 0);
  if (prop === "healthScore") return Number(row.evaluation.healthScore || 0);
  if (prop === "spend_rub") return Number(row.evaluation.metrics.spend || 0);
  if (prop === "campaign_budget_rub") return Number(row.campaign_budget_rub || 0);
  if (prop === "units") return Number(row.units || 0);
  return Number(row[prop] || 0);
}

function resetTablePage() {
  state.page = 1;
}

function activateTodoModule(key) {
  tableFilters.action = tableFilters.action === key ? "" : key;
  tableFilters.diagnosis = "";
  resetTablePage();
}

function clearActionFilter() {
  tableFilters.action = "";
  resetTablePage();
}

function campaignStatus(row) {
  const states = String(row.latest_campaign_states || row.campaign_states || row.campaign_state || "").toLowerCase();
  if (!states) return { key: "unknown", label: "状态未知", tone: "info" };
  const closedWords = ["stopped", "stop", "archived", "archive", "deleted", "finished", "inactive", "disabled", "ended"];
  const activeWords = ["running", "active", "enabled", "started", "moderation"];
  const tokens = states.split(/[^a-z0-9]+/).filter(Boolean);
  if (activeWords.some((word) => tokens.includes(word))) return { key: "active", label: "投放中", tone: "success" };
  if (closedWords.some((word) => tokens.includes(word))) return { key: "closed", label: "已关闭", tone: "info" };
  return { key: "unknown", label: states.slice(0, 24), tone: "info" };
}

function priorityRank(row) {
  const key = row.evaluation.status.key;
  if (key === "pause") return 1;
  if (key === "optimize") return 2;
  if (row.evaluation.tags.some((tag) => tag.label.includes("主图"))) return 3;
  if (key === "scale") return 4;
  return 5;
}

function rowClassName({ row }) {
  if (row.evaluation.status.key === "pause") return "ad-row-danger";
  if (row.evaluation.status.key === "scale") return "ad-row-success";
  if (row.evaluation.tags.some((tag) => tag.label.includes("主图"))) return "ad-row-warning";
  return "";
}

function primaryTag(row) {
  const status = row.evaluation.status;
  if (status.key === "scale") return { label: "🚀 可加预算", tone: "primary" };
  if (status.key === "pause") return { label: "❌ 建议暂停", tone: "danger" };
  const highClick = row.evaluation.tags.find((tag) => tag.label.includes("高点击低转化"));
  if (highClick) return highClick;
  const image = row.evaluation.tags.find((tag) => tag.label.includes("主图"));
  if (image) return { label: "⚠ CTR偏低", tone: "warning" };
  if (row.evaluation.stage.key === "testing") return { label: "🧪 测款中", tone: "warning" };
  if (row.evaluation.healthScore >= 78) return { label: "🔥 表现稳定", tone: "success" };
  return { label: row.evaluation.diagnosis || "👀 继续观察", tone: status.tone };
}

function primaryAction(row) {
  if (campaignStatus(row).key === "closed") return { label: "已关闭", type: "info", action: () => openDetails(row) };
  const labels = row.evaluation.tags.map((tag) => tag.label).join(" ");
  if (row.evaluation.status.key === "pause") return { label: "暂停广告", type: "danger", action: () => openStrategyDialog(row) };
  if (row.evaluation.status.key === "scale") return { label: "加预算", type: "primary", action: () => previewOnly("加预算需要人工确认，当前版本不会自动操作 Ozon。") };
  if (labels.includes("主图")) return { label: "优化主图", type: "warning", action: () => goMaterialCenter(row) };
  if (labels.includes("转化")) return { label: "优化详情页", type: "warning", action: () => goMaterialCenter(row) };
  if (row.evaluation.stage.key === "testing") return { label: "继续观察", type: "info", action: () => openDetails(row) };
  return { label: "查看详情", type: "primary", action: () => openDetails(row) };
}

function previewOnly(message) {
  ElMessage.info(message);
}

function progressWidth(value, max) {
  return `${Math.max(3, Math.min(100, (Number(value || 0) / Math.max(1, Number(max || 1))) * 100))}%`;
}

function budgetRemaining(row) {
  return Math.max(0, Number(row.campaign_budget_rub || 0) - Number(row.evaluation?.metrics?.spend || row.spend_rub || 0));
}

function budgetText(row) {
  const budget = Number(row.campaign_budget_rub || 0);
  if (budget <= 0) return "预算待同步";
  return `预算 ${rub(budget)} / 剩余 ${rub(budgetRemaining(row))}`;
}

function readableCampaignStatus(row) {
  const status = campaignStatus(row);
  if (status.key !== "unknown") return status;
  const raw = String(row.latest_campaign_states || row.campaign_states || row.campaign_state || "").toLowerCase();
  const labels = {
    campaign_state_inactive: "已关闭",
    inactive: "已关闭",
    stopped: "已关闭",
    archived: "已归档",
    finished: "已结束",
    active: "投放中",
    running: "投放中",
    enabled: "投放中",
    moderation: "审核中"
  };
  const match = Object.entries(labels).find(([key]) => raw.includes(key));
  return match ? { key: status.key, label: match[1], tone: status.tone } : { ...status, label: raw ? "状态未知" : status.label };
}

function compactPercentOrPending(value) {
  return value == null || value === "" ? "待接入" : percent(value);
}

function moneyCny(value) {
  return `CNY ${rub(value)}`;
}

function grossProfitCny(row = {}) {
  return Number(row.model_profit_cny ?? 0);
}

function adSpendCny(row = {}) {
  return Number(row.ad_spend_cny ?? 0);
}

function profitDetailValue(value) {
  return value == null || value === "" ? "待接入" : moneyCny(value);
}

function adNetProfitFormulaText(row = {}) {
  if (row.ad_net_profit_cny == null) return "广告净利润：待接入利润模型，暂时无法计算。";
  return `广告净利润 = 广告订单预估利润 ${moneyCny(row.ad_model_profit_cny || 0)} - 广告花费折算 ${moneyCny(adSpendCny(row))} = ${moneyCny(row.ad_net_profit_cny)}`;
}

function adNetProfitRateFormulaText(row = {}) {
  if (row.ad_net_profit_rate == null) return "广告净利润率：没有广告销售额时不计算。";
  return `广告净利润率 = 广告净利润 ${moneyCny(row.ad_net_profit_cny || 0)} / 广告销售额 ${moneyCny(row.ad_revenue_cny || 0)} = ${percent(row.ad_net_profit_rate)}`;
}

function profitModelStatusText(row = {}) {
  const status = row.profit_model_status || "";
  if (status === "estimated_without_ad_cost") return "已接入利润预估模型";
  if (status === "missing_inventory_binding") return "未绑定库存产品，暂无法套用预估模型";
  if (status === "missing_sale_price") return "缺少广告销售额/本地售价，暂无法套用预估模型";
  return "待接入";
}

function adProfitStatusText(row = {}) {
  const status = row.ad_profit_status || "";
  if (status === "current_range_ad_orders") return "当前筛选时间内广告订单";
  if (status === "no_ad_orders") return "当前筛选时间内无广告订单";
  if (status === "missing_profit_model") return "有广告订单，但利润模型待接入";
  return "待接入";
}

function openProfitDetails(row) {
  currentRow.value = row;
  profitDetailVisible.value = true;
}

function openStrategyDialog(row) {
  currentRow.value = row;
  strategyForm.mode = campaignStrategyMode(row);
  strategyForm.bidRub = Number(row.campaign_bid_rub || 0);
  strategyForm.targetCir = Number(row.campaign_target_cir || 0);
  strategyDialogVisible.value = true;
}

async function saveStrategySetting() {
  const row = currentRow.value;
  if (!row) return;
  const payload = {
    shop_id: row.shop_id,
    campaign_id: row.campaign_id,
    ozon_sku: row.ozon_sku,
    mode: strategyForm.mode,
    bid_rub: Number(strategyForm.bidRub || 0),
    target_cir: Number(strategyForm.targetCir || 0),
    from: state.filters.from,
    to: state.filters.to
  };
  if (!payload.campaign_id) return ElMessage.warning("当前 SKU 缺少广告活动 ID，请先同步 Ozon 广告");
  if (payload.mode === "bid" && payload.bid_rub <= 0) return ElMessage.warning("请输入有效点击出价");
  if (payload.mode === "targetCir" && payload.target_cir <= 0) return ElMessage.warning("请输入有效目标广告费用份额");
  strategySubmitting.value = true;
  try {
    await apiClient.post("/api/advertising/campaign/product-setting", payload);
    ElMessage.success("广告策略参数已提交到 Ozon");
    strategyDialogVisible.value = false;
    await loadRows();
  } catch (error) {
    ElMessage.error(error.message || "广告策略参数更新失败");
  } finally {
    strategySubmitting.value = false;
  }
}

async function stopCampaign(row) {
  if (!row.campaign_id) return ElMessage.warning("当前 SKU 缺少广告活动 ID，请先同步 Ozon 广告");
  await ElMessageBox.confirm(`确认停投广告「${row.campaign_name || row.campaign_id}」吗？`, "停投广告", {
    type: "warning",
    confirmButtonText: "确认停投",
    cancelButtonText: "取消"
  });
  strategySubmitting.value = true;
  try {
    await apiClient.post("/api/advertising/campaign/stop", {
      shop_id: row.shop_id,
      campaign_id: row.campaign_id,
      from: state.filters.from,
      to: state.filters.to
    });
    ElMessage.success("停投请求已提交到 Ozon");
    strategyDialogVisible.value = false;
    await loadRows();
  } catch (error) {
    ElMessage.error(error.message || "停投广告失败");
  } finally {
    strategySubmitting.value = false;
  }
}

function metricTrendText() {
  return "较7日均值";
}

async function bootstrap() {
  loading.value = true;
  try {
    const shopPayload = await apiClient.get("/api/shops");
    shops.value = Array.isArray(shopPayload) ? shopPayload : (shopPayload?.rows || []);
    await loadRows();
  } catch (error) {
    ElMessage.error(error.message || "广告系统初始化失败");
  } finally {
    loading.value = false;
  }
}

function buildParams(options = {}) {
  const params = new URLSearchParams({
    page: "1",
    pageSize: "1000",
    sortBy: state.sortBy,
    sortOrder: state.sortOrder === "ascending" ? "asc" : "desc"
  });
  if (options.includeShop !== false && state.filters.shopId) params.set("shopId", state.filters.shopId);
  if (state.filters.from) params.set("from", state.filters.from);
  if (state.filters.to) params.set("to", state.filters.to);
  return params;
}

async function loadRows() {
  loading.value = true;
  try {
    const params = buildParams();
    const [listPayload, summaryPayload, detailsPayload, qualityPayload] = await Promise.all([
      apiClient.get(`/api/advertising/daily?${params.toString()}`),
      apiClient.get(`/api/advertising/daily/summary?${params.toString()}`),
      apiClient.get(`/api/advertising/daily/details?${params.toString()}`),
      apiClient.get(`/api/advertising/daily/quality?${params.toString()}`)
    ]);
    state.rows = Array.isArray(listPayload?.rows) ? listPayload.rows : [];
    state.total = Number(listPayload?.total || state.rows.length);
    summary.value = summaryPayload || {};
    trendRows.value = Array.isArray(detailsPayload?.rows) ? detailsPayload.rows : [];
    quality.value = qualityPayload || null;
  } catch (error) {
    ElMessage.error(error.message || "广告数据加载失败");
  } finally {
    loading.value = false;
  }
}

async function syncFromOzon() {
  syncing.value = true;
  try {
    const result = await apiClient.post("/api/advertising/daily/sync", {
      shop_id: state.filters.shopId || undefined,
      from: state.filters.from,
      to: state.filters.to,
      include_inactive: true
    });
    if (Array.isArray(result.errors) && result.errors.length) {
      ElMessage.warning(result.errors.join("；"));
    } else {
      const scope = state.filters.shopId ? "当前店铺" : "全部已配置店铺";
      ElMessage.success(`已同步${scope} ${result.imported || 0} 行 Ozon 广告数据`);
    }
    await loadRows();
  } catch (error) {
    ElMessage.error(error.message || "同步 Ozon 广告失败");
  } finally {
    syncing.value = false;
  }
}

function handleSearch() {
  state.page = 1;
  loadRows();
}

function handleReset() {
  state.page = 1;
  Object.assign(state.filters, {
    shopId: "",
    from: dateDaysAgo(6),
    to: todayKey(),
    keyword: "",
    adStatus: "active",
    adStage: "all",
    adType: "all"
  });
  Object.assign(tableFilters, {
    action: "",
    diagnosis: "",
    sortProp: "",
    sortOrder: ""
  });
  loadRows();
}

function handleSortChange({ prop, order }) {
  tableFilters.sortProp = prop || "";
  tableFilters.sortOrder = order || "";
  resetTablePage();
}

async function openDetails(row) {
  currentRow.value = row;
  detailRows.value = [];
  detailVisible.value = true;
  detailLoading.value = true;
  try {
    const params = buildParams();
    params.set("shopId", String(row.shop_id || ""));
    params.set("ozon_sku", String(row.ozon_sku || ""));
    const payload = await apiClient.get(`/api/advertising/daily/details?${params.toString()}`);
    detailRows.value = Array.isArray(payload?.rows) ? payload.rows.map((item) => ({ ...item, evaluation: evaluateAdSku(item) })) : [];
  } catch (error) {
    ElMessage.error(error.message || "广告明细加载失败");
  } finally {
    detailLoading.value = false;
  }
}

function goMaterialCenter(row) {
  const sku = encodeURIComponent(row?.ozon_sku || "");
  window.location.hash = `/asset-variant-center?sku=${sku}`;
}

onMounted(bootstrap);
</script>

<template>
  <div class="ad-dashboard-page">
    <section class="filter-card">
      <el-form class="filter-form" inline>
        <el-form-item label="店铺">
          <el-select v-model="state.filters.shopId" filterable clearable placeholder="全部店铺" style="width: 176px">
            <el-option label="全部店铺" value="" />
            <el-option v-for="shop in shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
          </el-select>
        </el-form-item>
        <el-form-item label="开始"><el-date-picker v-model="state.filters.from" type="date" value-format="YYYY-MM-DD" style="width: 142px" /></el-form-item>
        <el-form-item label="结束"><el-date-picker v-model="state.filters.to" type="date" value-format="YYYY-MM-DD" style="width: 142px" /></el-form-item>
        <el-form-item label="关键词"><el-input v-model="state.filters.keyword" clearable placeholder="SKU / 商品 / 活动" style="width: 190px" @keyup.enter="handleSearch" /></el-form-item>
        <el-form-item label="状态">
          <el-select v-model="state.filters.adStatus" style="width: 118px">
            <el-option label="全部" value="all" />
            <el-option label="投放中" value="active" />
            <el-option label="正常" value="normal" />
            <el-option label="需观察" value="watch" />
            <el-option label="建议优化" value="optimize" />
            <el-option label="建议暂停" value="pause" />
            <el-option label="可加预算" value="scale" />
            <el-option label="已关闭" value="closed" />
          </el-select>
        </el-form-item>
        <el-form-item label="阶段">
          <el-select v-model="state.filters.adStage" style="width: 104px">
            <el-option label="全部" value="all" />
            <el-option label="测款" value="testing" />
            <el-option label="放量" value="scale" />
            <el-option label="稳定" value="stable" />
            <el-option label="止损" value="stop_loss" />
          </el-select>
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="state.filters.adType" style="width: 96px">
            <el-option label="全部" value="all" />
            <el-option label="CPC" value="cpc" />
            <el-option label="CPM" value="cpm" />
            <el-option label="CPA" value="cpa" />
            <el-option label="SKU" value="sku" />
          </el-select>
        </el-form-item>
      </el-form>
      <div class="filter-actions">
        <el-button type="primary" :icon="Search" :loading="loading" @click="handleSearch">查询</el-button>
        <el-button @click="handleReset">重置</el-button>
        <el-button type="success" :loading="syncing" @click="syncFromOzon">同步 Ozon 广告</el-button>
        <el-button type="primary" :icon="Refresh" :loading="loading" @click="loadRows">刷新</el-button>
      </div>
    </section>

    <section class="sync-quality-card">
      <div class="sync-quality-main">
        <el-tag :type="qualityStatus.type" effect="light">{{ qualityStatus.label }}</el-tag>
        <strong>同步可信度 {{ quality?.score ?? "--" }} 分</strong>
        <span>核心 KPI 已排除待返回报表：{{ settledRowsText }}</span>
      </div>
      <div class="sync-quality-metrics">
        <div><span>待 Ozon 返回</span><strong>{{ pendingRowsText }}</strong></div>
        <div><span>占位比例</span><strong>{{ pendingRatioText }}</strong></div>
        <div><span>覆盖店铺</span><strong>{{ quality?.coveredShopCount ?? 0 }} / {{ quality?.expectedShopCount ?? 0 }}</strong></div>
      </div>
      <div v-if="qualityIssues.length" class="sync-quality-issues">
        <el-tag v-for="issue in qualityIssues" :key="issue.key" :type="issue.severity === 'danger' ? 'danger' : issue.severity === 'warning' ? 'warning' : 'info'" effect="plain">
          {{ issue.message }}
        </el-tag>
      </div>
    </section>

    <el-tabs v-model="activeTab" class="ad-tabs">
      <el-tab-pane label="广告驾驶舱" name="dashboard">
        <div class="tab-pane-stack">
    <section class="decision-layer">
      <div class="health-card" :class="storeHealth.tone">
        <div class="health-title">
          <span>今日广告健康度</span>
          <el-tag :type="toneType(storeHealth.tone)" effect="light">{{ storeHealth.label }}</el-tag>
        </div>
        <div class="health-score">
          <span>健康分</span>
          <strong>{{ storeHealth.score }}</strong>
          <i><b :style="{ width: `${storeHealth.score}%` }"></b></i>
        </div>
        <div class="health-metrics">
          <div><span>ROAS</span><strong>{{ decimal(filteredSummary.roas) }}</strong></div>
          <div><span>CTR</span><strong>{{ percent(filteredSummary.ctr) }}</strong></div>
          <div><span>CR</span><strong>{{ percent(filteredSummary.conversion_rate) }}</strong></div>
          <div><span>ACOS</span><strong>{{ percent(filteredSummary.acos) }}</strong></div>
        </div>
        <p>{{ aiConclusion }}</p>
      </div>
      <div class="todo-panel">
        <div class="panel-head">
          <strong>今日待办</strong>
          <span>点击筛选下方 SKU</span>
        </div>
        <div class="todo-module-grid">
          <button
            v-for="item in todoModules"
            :key="item.key"
            type="button"
            class="todo-module"
            :class="[item.tone, { active: tableFilters.action === item.key }]"
            @click="activateTodoModule(item.key)"
          >
            <span>{{ item.title }}</span>
            <strong>{{ item.rows.length }}</strong>
            <small>{{ item.desc }}</small>
          </button>
        </div>
      </div>
    </section>

    <section class="sku-panel">
      <div class="panel-head">
        <strong>SKU广告管理</strong>
        <span v-if="activeTodoModule">{{ activeTodoModule.title }}：{{ activeTodoModule.rows.length }} 个 SKU <el-button link type="primary" @click="clearActionFilter">清除</el-button></span>
        <span v-else>高风险自动置顶，只显示主诊断和主动作</span>
      </div>
      <el-table
        v-loading="loading"
        :data="pagedRows"
        stripe
        height="540"
        table-layout="fixed"
        class="erp-data-table ad-table"
        :row-class-name="rowClassName"
        @sort-change="handleSortChange"
      >
        <el-table-column type="expand" width="44">
          <template #default="{ row }">
            <div class="expand-grid">
              <div><span>状态</span><strong>{{ readableCampaignStatus(row).label }}</strong></div>
              <div><span>广告销售额</span><strong>{{ money(row.evaluation.metrics.revenue) }}</strong></div>
              <div class="profit-card">
                <span>毛利率</span>
                <strong>{{ compactPercentOrPending(row.gross_margin_rate) }}</strong>
                <el-button link type="primary" size="small" @click.stop="openProfitDetails(row)">查看详情</el-button>
              </div>
              <div class="profit-card">
                <span>广告净利润率</span>
                <strong>{{ compactPercentOrPending(row.ad_net_profit_rate) }}</strong>
                <el-button link type="primary" size="small" @click.stop="openProfitDetails(row)">查看详情</el-button>
              </div>
              <div class="profit-card">
                <span>广告净利润</span>
                <strong>{{ row.ad_net_profit_cny == null ? "待接入" : `CNY ${rub(row.ad_net_profit_cny)}` }}</strong>
                <el-button link type="primary" size="small" @click.stop="openProfitDetails(row)">查看详情</el-button>
              </div>
              <div><span>点击成本</span><strong>{{ money(row.evaluation.metrics.cpc) }}</strong></div>
              <div><span>ROAS</span><strong>{{ decimal(row.evaluation.metrics.roas) }}</strong></div>
              <div><span>ACOS</span><strong>{{ percent(row.evaluation.metrics.acos) }}</strong></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="SKU / 商品" min-width="310" fixed="left">
          <template #default="{ row }">
            <div class="product-cell">
              <div class="thumb">
                <el-image
                  v-if="row.image_url"
                  :src="row.image_url"
                  fit="cover"
                  :preview-src-list="[row.image_url]"
                  :initial-index="0"
                  preview-teleported
                />
                <span v-else>无图</span>
              </div>
              <div>
                <strong>{{ row.ozon_sku }}</strong>
                <el-tag v-if="isAdPending(row)" size="small" type="warning" effect="plain">Ozon 报表待返回</el-tag>
                <span>{{ row.product_name || row.offer_id || "未同步商品信息" }}</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="92" align="center">
          <template #default="{ row }">
            <el-tag :type="toneType(readableCampaignStatus(row).tone)" effect="light" round size="small">{{ readableCampaignStatus(row).label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="策略" width="110">
          <template #default="{ row }">
            <span class="strategy-cell">{{ campaignStrategyText(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="投放位置" width="118">
          <template #default="{ row }">
            <span class="strategy-cell">{{ campaignPlacementText(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="campaign_budget_rub" label="预算" width="110" sortable="custom" align="right">
          <template #default="{ row }">
            <div class="compact-metric-cell">
              <strong>{{ budgetCompactText(row) }}</strong>
              <span>{{ budgetRemaining(row) ? `剩 ${compactMoney(budgetRemaining(row))}` : "" }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="feeShare" label="费用份额" width="110" align="right" sortable="custom">
          <template #default="{ row }">
            <div class="compact-metric-cell">
              <strong>{{ adFeeShareText(row) }}</strong>
              <span>{{ compactMoney(row.evaluation.metrics.spend) }} RUB</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="cpc" label="平均点击费" width="118" align="right" sortable="custom">
          <template #default="{ row }">
            <div class="compact-metric-cell">
              <strong>{{ money(row.evaluation.metrics.cpc) }}</strong>
              <span>{{ integer(row.evaluation.metrics.clicks) }} 次点击</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="units" label="销量 / 销售额" width="150" align="right" sortable="custom">
          <template #default="{ row }">
            <div class="compact-metric-cell">
              <strong>{{ salesCompactText(row) }}</strong>
              <span>广告归因</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="spend_rub" label="费用" width="112" sortable="custom" align="right">
          <template #default="{ row }">
            <strong class="number-cell">{{ compactMoney(row.evaluation.metrics.spend) }} RUB</strong>
          </template>
        </el-table-column>
        <el-table-column label="转化漏斗" width="185" align="right">
          <template #default="{ row }">
            <div class="compact-metric-cell">
              <strong>{{ funnelText(row) }}</strong>
              <span>展示 / 点击 / 加购 / 订单</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="ctr" label="点击率" width="95" align="right" sortable="custom">
          <template #default="{ row }">
            <strong class="number-cell">{{ percent(row.evaluation.metrics.ctr) }}</strong>
          </template>
        </el-table-column>
        <el-table-column prop="healthScore" label="健康分" width="95" align="center" sortable="custom">
          <template #default="{ row }"><strong :class="`score-${scoreTone(row.evaluation.healthScore)}`">{{ row.evaluation.healthScore }}</strong></template>
        </el-table-column>
        <el-table-column label="主诊断" width="170">
          <template #header>
            <el-select v-model="tableFilters.diagnosis" clearable filterable size="small" placeholder="主诊断" class="table-filter-select" @change="resetTablePage">
              <el-option v-for="item in diagnosisOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </template>
          <template #default="{ row }">
            <el-tooltip placement="top" :content="row.evaluation.tags.map((tag) => tag.label).join(' / ')">
              <el-tag :type="toneType(primaryTag(row).tone)" effect="light">{{ primaryTag(row).label }}</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="AI建议" min-width="230">
          <template #default="{ row }"><span class="short-advice">{{ row.evaluation.suggestions[0] }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button link :type="primaryAction(row).type" @click="primaryAction(row).action">{{ primaryAction(row).label }}</el-button>
              <el-button link type="warning" @click="openStrategyDialog(row)">调价/停投</el-button>
              <el-button link type="primary" @click="openDetails(row)">详情</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <div class="ad-table-footer">
        <span>共 {{ tableFilteredRows.length }} 个 SKU</span>
        <PageFooterPagination
          :total="tableFilteredRows.length"
          :page="state.page"
          :page-size="state.pageSize"
          compact
          @update:page="state.page = $event"
          @update:pageSize="state.pageSize = $event; resetTablePage()"
        />
      </div>
    </section>

        </div>
      </el-tab-pane>
      <el-tab-pane label="花费总览" name="insights">
        <div class="tab-pane-stack">
    <section class="spend-overview-panel">
      <div class="panel-head">
        <strong>广告花费总览</strong>
        <span>{{ state.filters.from }} ~ {{ state.filters.to }}，随当前店铺、关键词和状态筛选联动</span>
      </div>
      <div class="spend-overview-grid">
        <div class="spend-card">
          <div class="sub-panel-head">
            <strong>店铺花费排行</strong>
            <span>看各店铺广告预算消耗</span>
          </div>
          <div v-if="!storeSpendRank.length" class="empty-state">暂无店铺广告数据</div>
          <div v-else class="spend-list">
            <div v-for="shop in storeSpendRank" :key="shop.shop_id || shop.shop_name" class="spend-row">
              <div>
                <strong>{{ shop.shop_name }}</strong>
                <span>{{ shop.skuTotal }} 个SKU / ROAS {{ decimal(shop.roas) }} / CTR {{ percent(shop.ctr) }}</span>
              </div>
              <div class="spend-bars">
                <div class="spend-bar-line cost">
                  <span>花费</span>
                  <i><b :style="{ width: progressWidth(shop.spend, maxStoreCompare) }"></b></i>
                  <em>{{ money(shop.spend) }}</em>
                </div>
                <div class="spend-bar-line revenue">
                  <span>收益</span>
                  <i><b :style="{ width: progressWidth(shop.revenue, maxStoreCompare) }"></b></i>
                  <em>{{ money(shop.revenue) }}</em>
                </div>
              </div>
              <em class="compare-delta" :class="{ positive: shop.revenue >= shop.spend, negative: shop.revenue < shop.spend }">
                差额 {{ shop.revenue >= shop.spend ? "+" : "-" }}{{ money(Math.abs(shop.revenue - shop.spend)).replace("RUB ", "") }}
              </em>
            </div>
          </div>
        </div>
        <div class="spend-card">
          <div class="sub-panel-head">
            <strong>高花费 SKU</strong>
            <span>优先复核烧钱 SKU 和放量 SKU</span>
          </div>
          <div v-if="!highSpendSkuRank.length" class="empty-state">暂无 SKU 广告数据</div>
          <div v-else class="spend-list">
            <div v-for="row in highSpendSkuRank" :key="`${row.shop_id}-${row.ozon_sku}`" class="spend-row sku">
              <div class="spend-product">
                <div class="thumb compact">
                  <el-image
                    v-if="row.image_url"
                    :src="row.image_url"
                    fit="cover"
                    :preview-src-list="[row.image_url]"
                    :initial-index="0"
                    preview-teleported
                  />
                  <span v-else>无图</span>
                </div>
                <div>
                  <strong>{{ row.ozon_sku }}</strong>
                  <span>{{ row.product_name || row.offer_id || "未同步商品信息" }}</span>
                  <small>{{ row.shop_name }} / ROAS {{ decimal(row.evaluation.metrics.roas) }} / 订单 {{ integer(row.evaluation.metrics.orders) }}</small>
                </div>
              </div>
              <div class="spend-bars">
                <div class="spend-bar-line cost">
                  <span>花费</span>
                  <i><b :style="{ width: progressWidth(row.evaluation.metrics.spend, maxSkuCompare) }"></b></i>
                  <em>{{ money(row.evaluation.metrics.spend) }}</em>
                </div>
                <div class="spend-bar-line revenue">
                  <span>收益</span>
                  <i><b :style="{ width: progressWidth(row.evaluation.metrics.revenue, maxSkuCompare) }"></b></i>
                  <em>{{ money(row.evaluation.metrics.revenue) }}</em>
                </div>
              </div>
              <em class="compare-delta" :class="{ positive: row.evaluation.metrics.revenue >= row.evaluation.metrics.spend, negative: row.evaluation.metrics.revenue < row.evaluation.metrics.spend }">
                差额 {{ row.evaluation.metrics.revenue >= row.evaluation.metrics.spend ? "+" : "-" }}{{ money(Math.abs(row.evaluation.metrics.revenue - row.evaluation.metrics.spend)).replace("RUB ", "") }}
              </em>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="bottom-layer">
      <div class="ranking-panel">
        <div class="panel-head"><strong>排行榜</strong><span>快速找机会和风险</span></div>
        <div class="rank-grid">
          <div>
            <h3>ROAS Top 5</h3>
            <div v-for="row in dashboard.bestRows" :key="`roas-${row.ozon_sku}`" class="rank-row with-product">
              <div class="rank-product">
                <div class="thumb mini">
                  <el-image v-if="row.image_url" :src="row.image_url" fit="cover" :preview-src-list="[row.image_url]" :initial-index="0" preview-teleported />
                  <span v-else>无图</span>
                </div>
                <div><strong>{{ row.ozon_sku }}</strong><span>{{ row.product_name || row.offer_id || "未同步商品信息" }}</span></div>
              </div>
              <i><b :style="{ width: progressWidth(row.evaluation.metrics.roas, 8) }"></b></i><em>{{ decimal(row.evaluation.metrics.roas) }}</em>
            </div>
          </div>
          <div>
            <h3>CTR Top 5</h3>
            <div v-for="row in ctrTopRows" :key="`ctr-${row.ozon_sku}`" class="rank-row with-product">
              <div class="rank-product">
                <div class="thumb mini">
                  <el-image v-if="row.image_url" :src="row.image_url" fit="cover" :preview-src-list="[row.image_url]" :initial-index="0" preview-teleported />
                  <span v-else>无图</span>
                </div>
                <div><strong>{{ row.ozon_sku }}</strong><span>{{ row.product_name || row.offer_id || "未同步商品信息" }}</span></div>
              </div>
              <i><b :style="{ width: progressWidth(row.evaluation.metrics.ctr, 0.08) }"></b></i><em>{{ percent(row.evaluation.metrics.ctr) }}</em>
            </div>
          </div>
          <div>
            <h3>风险 SKU Top 5</h3>
            <div v-for="row in dashboard.highRisk" :key="`risk-${row.ozon_sku}`" class="rank-row with-product danger">
              <div class="rank-product">
                <div class="thumb mini">
                  <el-image v-if="row.image_url" :src="row.image_url" fit="cover" :preview-src-list="[row.image_url]" :initial-index="0" preview-teleported />
                  <span v-else>无图</span>
                </div>
                <div><strong>{{ row.ozon_sku }}</strong><span>{{ row.product_name || row.offer_id || "未同步商品信息" }}</span></div>
              </div>
              <i><b :style="{ width: progressWidth(100 - row.evaluation.healthScore, 100) }"></b></i><em>{{ row.evaluation.healthScore }}</em>
            </div>
          </div>
        </div>
      </div>
      <div class="trend-panel">
        <div class="panel-head"><strong>趋势分析</strong><span>按当前日期范围汇总每日广告数据</span></div>
        <div class="trend-grid">
          <div v-for="metric in ['spend', 'roas', 'ctr', 'cr']" :key="metric" class="trend-card">
            <span>{{ { spend: '花费趋势', roas: 'ROAS趋势', ctr: 'CTR趋势', cr: 'CR趋势' }[metric] }}</span>
            <div v-if="trendSeries.length" class="mini-bars">
              <el-tooltip v-for="row in trendSeries" :key="`${metric}-${row.date}`" placement="top" :content="`${row.date}：${trendLabel(row, metric)}`">
                <b :style="{ height: trendBarHeight(row, metric) }"></b>
              </el-tooltip>
            </div>
            <em v-else>暂无趋势数据</em>
          </div>
        </div>
      </div>
    </section>

        </div>
      </el-tab-pane>
      <el-tab-pane label="优化任务" name="tasks">
        <div class="tab-pane-stack">
    <section class="task-board">
      <div class="panel-head"><strong>广告优化任务看板</strong><span>任务交互预留，不自动操作广告</span></div>
      <div class="task-columns">
        <div v-for="column in taskColumns" :key="column.key" class="task-column">
          <div class="task-column-head">
            <h3>{{ column.label }}</h3>
            <span>{{ column.rows.length }} 项</span>
          </div>
          <template v-if="column.rows.length">
            <div v-for="task in pagedTasks(column)" :key="task.id" class="task-card">
              <div class="task-product">
                <div class="thumb compact">
                  <el-image
                    v-if="task.imageUrl"
                    :src="task.imageUrl"
                    fit="cover"
                    :preview-src-list="[task.imageUrl]"
                    :initial-index="0"
                    preview-teleported
                  />
                  <span v-else>无图</span>
                </div>
                <div>
                  <strong>{{ task.title }}</strong>
                  <span>{{ task.sku }} / {{ task.shop }}</span>
                  <small>{{ task.productName || "未同步商品信息" }}</small>
                </div>
              </div>
              <el-tag size="small" :type="task.priorityScore >= 130 ? 'danger' : task.priorityScore >= 95 ? 'warning' : 'info'" effect="light">{{ task.priorityLabel }}</el-tag>
              <small>{{ task.reason }}</small>
              <p>{{ task.suggestions[0] }}</p>
              <el-button size="small" @click="goMaterialCenter({ ozon_sku: task.sku })">去处理</el-button>
            </div>
          </template>
          <div v-else class="empty-state">暂无任务</div>
        </div>
      </div>
    </section>

        </div>
      </el-tab-pane>
    </el-tabs>

    <el-drawer v-model="detailVisible" size="900px" title="SKU广告详情">
      <div v-if="currentRow" class="drawer-stack">
        <section class="drawer-product">
          <div class="thumb large">
            <el-image
              v-if="currentRow.image_url"
              :src="currentRow.image_url"
              fit="cover"
              :preview-src-list="[currentRow.image_url]"
              :initial-index="0"
              preview-teleported
            />
            <span v-else>无图</span>
          </div>
          <div>
            <strong>{{ currentRow.ozon_sku }}</strong>
            <span>{{ currentRow.product_name || currentRow.offer_id || "未同步商品信息" }}</span>
            <small>{{ currentRow.shop_name }} / {{ currentRow.evaluation.stage.label }} / {{ readableCampaignStatus(currentRow).label }}</small>
          </div>
        </section>
        <section class="drawer-metrics">
          <div><span>ROAS</span><strong>{{ decimal(currentRow.evaluation.metrics.roas) }}</strong></div>
          <div><span>CTR</span><strong>{{ percent(currentRow.evaluation.metrics.ctr) }}</strong></div>
          <div><span>CR</span><strong>{{ percent(currentRow.evaluation.metrics.cr) }}</strong></div>
          <div><span>ACOS</span><strong>{{ percent(currentRow.evaluation.metrics.acos) }}</strong></div>
          <div><span>CPC</span><strong>{{ money(currentRow.evaluation.metrics.cpc) }}</strong></div>
          <div><span>花费</span><strong>{{ money(currentRow.evaluation.metrics.spend) }}</strong></div>
          <div><span>加购</span><strong>{{ integer(currentRow.evaluation.metrics.addToCart) }}</strong></div>
          <div><span>订单</span><strong>{{ integer(currentRow.evaluation.metrics.orders) }}</strong></div>
        </section>
        <section class="drawer-ai">
          <h3>AI诊断</h3>
          <p><b>当前问题：</b>{{ currentRow.evaluation.diagnosis }}</p>
          <p><b>判断原因：</b>{{ currentRow.evaluation.tags.map((tag) => tag.label).join(" / ") }}</p>
          <p><b>建议操作：</b>{{ currentRow.evaluation.suggestions.join("；") }}</p>
        </section>
        <section class="trend-grid drawer-trends">
          <div><span>近7天 ROAS</span><em>预留趋势图</em></div>
          <div><span>近7天 CTR</span><em>预留趋势图</em></div>
          <div><span>近7天 CR</span><em>预留趋势图</em></div>
          <div><span>近7天花费</span><em>预留趋势图</em></div>
        </section>
        <section class="drawer-actions">
          <el-button type="warning" @click="goMaterialCenter(currentRow)">创建主图优化任务</el-button>
          <el-button type="warning" @click="goMaterialCenter(currentRow)">创建详情页优化任务</el-button>
          <el-button @click="previewOnly('已标记为处理，当前版本仅前端预留。')">标记已处理</el-button>
          <el-button type="primary" @click="goMaterialCenter(currentRow)">跳转素材裂变中心</el-button>
        </section>
        <el-table :data="detailRows" v-loading="detailLoading" stripe>
          <el-table-column prop="date_key" label="日期" width="110" />
          <el-table-column prop="campaign_name" label="广告活动" min-width="220" />
          <el-table-column prop="ad_type" label="策略" width="100" />
          <el-table-column label="花费" width="120" align="right"><template #default="{ row }">{{ money(row.spend_rub) }}</template></el-table-column>
          <el-table-column prop="impressions" label="展示" width="100" align="right" />
          <el-table-column prop="clicks" label="点击" width="90" align="right" />
          <el-table-column prop="add_to_cart" label="加购" width="90" align="right" />
          <el-table-column label="CTR" width="90" align="right"><template #default="{ row }">{{ percent(row.ctr) }}</template></el-table-column>
          <el-table-column prop="orders" label="订单" width="80" align="right" />
          <el-table-column label="ROAS" width="90" align="right"><template #default="{ row }">{{ decimal(row.roas) }}</template></el-table-column>
        </el-table>
      </div>
    </el-drawer>

    <el-dialog v-model="strategyDialogVisible" title="广告策略参数" width="520px">
      <div v-if="currentRow" class="strategy-dialog">
        <section class="drawer-product">
          <div class="thumb compact">
            <el-image v-if="currentRow.image_url" :src="currentRow.image_url" fit="cover" />
            <span v-else>无图</span>
          </div>
          <div>
            <strong>{{ currentRow.ozon_sku }}</strong>
            <span>{{ currentRow.product_name || currentRow.offer_id || "未同步商品信息" }}</span>
            <small>{{ campaignStrategyText(currentRow) }} / {{ campaignPlacementText(currentRow) }}</small>
          </div>
        </section>
        <el-form label-width="132px" class="strategy-form">
          <el-form-item label="调整类型">
            <el-segmented v-model="strategyForm.mode" :options="[{ label: '点击出价', value: 'bid' }, { label: '广告费用份额', value: 'targetCir' }]" />
          </el-form-item>
          <el-form-item v-if="strategyForm.mode === 'bid'" label="当前点击出价">
            <el-input-number v-model="strategyForm.bidRub" :min="0" :precision="2" :step="0.1" controls-position="right" />
            <span class="form-suffix">RUB</span>
          </el-form-item>
          <el-form-item v-else label="目标费用份额">
            <el-input-number v-model="strategyForm.targetCir" :min="0" :precision="1" :step="1" controls-position="right" />
            <span class="form-suffix">%</span>
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="strategyDialogVisible = false">取消</el-button>
        <el-button v-if="currentRow" type="danger" plain :loading="strategySubmitting" @click="stopCampaign(currentRow)">停投广告</el-button>
        <el-button type="primary" :loading="strategySubmitting" @click="saveStrategySetting">保存到 Ozon</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="profitDetailVisible" title="利润计算详情" width="620px">
      <div v-if="currentRow" class="profit-detail-dialog">
        <section class="drawer-product">
          <div class="thumb compact">
            <el-image v-if="currentRow.image_url" :src="currentRow.image_url" fit="cover" />
            <span v-else>无图</span>
          </div>
          <div>
            <strong>{{ currentRow.ozon_sku }}</strong>
            <span>{{ currentRow.product_name || currentRow.offer_id || "未同步商品信息" }}</span>
            <small>{{ currentRow.shop_name || "未知店铺" }}</small>
          </div>
        </section>
        <section class="profit-detail-grid">
          <div><span>模型状态</span><strong>{{ profitModelStatusText(currentRow) }}</strong></div>
          <div><span>广告利润口径</span><strong>{{ adProfitStatusText(currentRow) }}</strong></div>
          <div><span>计算数量</span><strong>{{ integer(currentRow.model_quantity || currentRow.units || currentRow.orders || 0) }}</strong></div>
          <div><span>广告订单数量</span><strong>{{ integer(currentRow.ad_order_quantity || 0) }}</strong></div>
          <div><span>预估单价</span><strong>{{ profitDetailValue(currentRow.model_sale_price_cny) }}</strong></div>
          <div><span>预估销售额</span><strong>{{ profitDetailValue(currentRow.model_revenue_cny) }}</strong></div>
          <div><span>广告销售额</span><strong>{{ profitDetailValue(currentRow.ad_revenue_cny) }}</strong></div>
          <div><span>采购成本/件</span><strong>{{ profitDetailValue(currentRow.model_purchase_cost_cny) }}</strong></div>
          <div><span>国内运费/件</span><strong>{{ profitDetailValue(currentRow.model_domestic_shipping_cny) }}</strong></div>
          <div><span>国际运费/件</span><strong>{{ profitDetailValue(currentRow.model_international_shipping_cny) }}</strong></div>
          <div><span>佣金/件</span><strong>{{ profitDetailValue(currentRow.model_commission_cny) }}</strong></div>
          <div><span>支付手续费/件</span><strong>{{ profitDetailValue(currentRow.model_payment_fee_cny) }}</strong></div>
          <div><span>提现服务费/件</span><strong>{{ profitDetailValue(currentRow.model_withdrawal_fee_cny) }}</strong></div>
          <div><span>退货损耗/件</span><strong>{{ profitDetailValue(currentRow.model_return_loss_cny) }}</strong></div>
          <div><span>包装费/件</span><strong>{{ profitDetailValue(currentRow.model_packaging_cost_cny) }}</strong></div>
          <div><span>预估净利润（不含广告）</span><strong>{{ profitDetailValue(currentRow.model_profit_cny) }}</strong></div>
          <div><span>毛利率（不含广告）</span><strong>{{ compactPercentOrPending(currentRow.gross_margin_rate) }}</strong></div>
          <div><span>广告订单预估利润</span><strong>{{ profitDetailValue(currentRow.ad_model_profit_cny) }}</strong></div>
          <div><span>广告花费折算</span><strong>{{ moneyCny(adSpendCny(currentRow)) }}</strong></div>
          <div><span>广告净利润</span><strong>{{ currentRow.ad_net_profit_cny == null ? "待接入" : moneyCny(currentRow.ad_net_profit_cny) }}</strong></div>
          <div><span>广告净利润率</span><strong>{{ compactPercentOrPending(currentRow.ad_net_profit_rate) }}</strong></div>
        </section>
        <section class="profit-detail-formulas">
          <p>{{ adNetProfitFormulaText(currentRow) }}</p>
          <p>{{ adNetProfitRateFormulaText(currentRow) }}</p>
        </section>
        <p class="profit-formula">口径：毛利率复用库存产品利润预估模型，广告费率按 0 计算，包含采购、国内运费、国际运费、佣金、支付/提现费用、退货损耗和包装费。广告净利润 = 当前筛选时间内广告订单预估利润 - 当前筛选时间内广告花费；广告净利润率 = 广告净利润 / 当前筛选时间内广告销售额。没有广告销售额时净利润率不计算。</p>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.ad-dashboard-page {
  width: 100%;
  max-width: none;
  margin: 0 auto;
  padding-bottom: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.filter-card,
.sync-quality-card,
.health-card,
.mini-card,
.todo-panel,
.sku-panel,
.spend-overview-panel,
.ranking-panel,
.trend-panel,
.task-board {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.04);
}

.filter-actions,
.row-actions,
.drawer-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.filter-card {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 10px 12px 4px;
}

.filter-form {
  flex: 1 1 auto;
  min-width: 0;
}

.filter-form :deep(.el-form-item) {
  margin-right: 8px;
  margin-bottom: 6px;
}

.filter-form :deep(.el-form-item__label) {
  padding-right: 6px;
}

.filter-actions {
  flex: 0 0 auto;
  justify-content: flex-end;
  flex-wrap: wrap;
  padding-bottom: 6px;
}

.filter-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.sync-quality-card {
  display: grid;
  grid-template-columns: minmax(320px, 1fr) auto minmax(280px, 1fr);
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
}

.sync-quality-main,
.sync-quality-issues {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.sync-quality-main strong {
  color: #0f172a;
  font-size: 14px;
}

.sync-quality-main span {
  color: #64748b;
  font-size: 12px;
}

.sync-quality-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(92px, 1fr));
  gap: 8px;
}

.sync-quality-metrics div {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 6px 8px;
  background: #f8fafc;
}

.sync-quality-metrics span {
  display: block;
  color: #64748b;
  font-size: 11px;
}

.sync-quality-metrics strong {
  display: block;
  color: #0f172a;
  font-size: 13px;
}

.ad-tabs {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 0 16px 16px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.04);
}

.ad-tabs :deep(.el-tabs__header) {
  margin-bottom: 16px;
}

.tab-pane-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.health-card {
  display: grid;
  grid-template-columns: 116px minmax(0, 1fr);
  grid-template-areas:
    "title title"
    "score metrics"
    "copy copy";
  align-content: center;
  column-gap: 10px;
  row-gap: 4px;
  padding: 7px 10px;
  border-left: 0;
}

.health-card.success { box-shadow: inset 4px 0 0 #16a34a, 0 8px 24px rgba(15, 23, 42, 0.04); }
.health-card.warning { box-shadow: inset 4px 0 0 #eab308, 0 8px 24px rgba(15, 23, 42, 0.04); }
.health-card.orange { box-shadow: inset 4px 0 0 #f97316, 0 8px 24px rgba(15, 23, 42, 0.04); }
.health-card.danger { box-shadow: inset 4px 0 0 #dc2626, 0 8px 24px rgba(15, 23, 42, 0.04); }

.health-title,
.panel-head,
.table-footer {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}

.health-title {
  grid-area: title;
  min-width: 0;
}

.health-title span,
.panel-head span {
  color: #6b7280;
  font-size: 12px;
}

.health-score {
  grid-area: score;
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: end;
  gap: 4px 8px;
  margin: 0;
  min-width: 0;
  padding: 0;
  border-radius: 0;
  background: transparent;
  border: 0;
}

.health-score strong {
  color: #111827;
  font-size: 26px;
  line-height: 1;
  grid-column: 1;
  grid-row: 1;
}

.health-score span {
  color: #6b7280;
  margin-bottom: 0;
  font-size: 12px;
  grid-column: 2;
  grid-row: 1;
  align-self: center;
}

.health-score i {
  grid-column: 1 / 3;
  display: block;
  height: 5px;
  border-radius: 999px;
  overflow: hidden;
  background: #e2e8f0;
}

.health-score b {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: #2563eb;
}

.health-card.success .health-score b { background: #16a34a; }
.health-card.warning .health-score b { background: #eab308; }
.health-card.orange .health-score b { background: #f97316; }
.health-card.danger .health-score b { background: #dc2626; }

.health-metrics {
  grid-area: metrics;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  margin: 0;
  align-self: center;
}

.health-metrics div,
.drawer-metrics div,
.expand-grid div {
  background: #f9fafb;
  border: 1px solid #edf2f7;
  border-radius: 7px;
  padding: 4px 7px;
}

.health-metrics div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.health-metrics span,
.drawer-metrics span,
.expand-grid span {
  display: block;
  color: #6b7280;
  font-size: 12px;
}

.health-metrics strong,
.drawer-metrics strong,
.expand-grid strong {
  display: block;
  margin-top: 0;
  color: #111827;
}

.health-card p {
  grid-area: copy;
  margin: 0;
  color: #374151;
  line-height: 1.2;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.decision-layer {
  display: grid;
  grid-template-columns: minmax(360px, 0.42fr) minmax(520px, 0.58fr);
  gap: 12px;
  align-items: start;
}

.bottom-layer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(420px, 1fr);
  gap: 16px;
}

.todo-panel,
.sku-panel,
.spend-overview-panel,
.ranking-panel,
.trend-panel,
.task-board {
  padding: 16px;
}

.decision-layer .todo-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 8px 10px;
}

.decision-layer .health-card,
.decision-layer .todo-panel {
  height: auto;
}

.panel-head {
  margin-bottom: 6px;
}

.panel-head strong {
  color: #111827;
  font-size: 15px;
}

.todo-module-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 7px;
}

.todo-module {
  min-width: 0;
  height: 44px;
  padding: 5px 8px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  text-align: left;
  cursor: pointer;
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: 16px 14px;
  gap: 1px 8px;
  transition: border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
}

.todo-module:hover,
.todo-module.active {
  transform: translateY(-1px);
  box-shadow: 0 8px 18px rgba(15, 23, 42, 0.08);
}

.todo-module span {
  color: #111827;
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
  line-height: 16px;
}

.todo-module strong {
  color: #111827;
  font-size: 20px;
  line-height: 1;
  grid-row: 1 / 3;
  grid-column: 2;
  align-self: center;
}

.todo-module small {
  color: #64748b;
  font-size: 11px;
  line-height: 14px;
  grid-column: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.todo-module.danger { background: #fff1f2; border-color: #fecdd3; }
.todo-module.warning { background: #fffbeb; border-color: #fde68a; }
.todo-module.success { background: #f0fdf4; border-color: #bbf7d0; }
.todo-module.primary { background: #eff6ff; border-color: #bfdbfe; }
.todo-module.active { border-color: #2563eb; }

.product-cell,
.drawer-product {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.thumb {
  width: 48px;
  height: 64px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #f8fafc;
  overflow: hidden;
  display: grid;
  place-items: center;
  color: #9ca3af;
  font-size: 12px;
  flex: 0 0 auto;
}

.thumb.large {
  width: 96px;
  height: 128px;
}

.thumb.compact {
  width: 42px;
  height: 56px;
  border-radius: 7px;
}

.product-cell .thumb {
  width: 64px;
  height: 84px;
  border-radius: 8px;
}

.thumb.mini {
  width: 36px;
  height: 48px;
  border-radius: 6px;
}

.thumb .el-image {
  width: 100%;
  height: 100%;
  cursor: zoom-in;
}

.thumb :deep(.el-image),
.thumb :deep(.el-image__wrapper),
.thumb :deep(.el-image__inner) {
  width: 100% !important;
  height: 100% !important;
  display: block !important;
}

.thumb :deep(.el-image__inner) {
  object-fit: cover !important;
  object-position: center !important;
}

.product-cell strong,
.product-cell span,
.drawer-product strong,
.drawer-product span,
.drawer-product small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.product-cell span,
.drawer-product span,
.drawer-product small,
.short-advice {
  color: #6b7280;
  font-size: 12px;
}

.metric-header {
  cursor: help;
  border-bottom: 1px dotted #94a3b8;
  color: #334155;
  font-weight: 700;
}

.spend-metric-cell,
.formula-metric,
.compact-metric-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  line-height: 1.25;
}

.spend-metric-cell strong,
.formula-metric strong,
.compact-metric-cell strong,
.number-cell {
  color: #111827;
  font-size: 13px;
  font-weight: 700;
}

.spend-metric-cell strong {
  font-size: 14px;
}

.spend-metric-cell span,
.formula-metric span,
.compact-metric-cell span {
  color: #64748b;
  font-size: 11px;
}

.spend-metric-cell span {
  white-space: nowrap;
}

.strategy-cell {
  display: block;
  color: #111827;
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.table-filter-select {
  width: 100%;
}

.ad-table :deep(.el-table__column-filter-trigger) {
  display: none;
}

.ad-table :deep(.el-table__row) {
  height: 88px;
}

.ad-table :deep(.el-table__cell) {
  padding: 8px 0;
}

.ad-table :deep(.cell) {
  padding: 0 8px;
  line-height: 1.35;
}

.ad-table :deep(.el-table__header .cell) {
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
}

.ad-table :deep(.ad-row-danger) {
  --el-table-tr-bg-color: #fff5f5;
}

.ad-table :deep(.ad-row-success) {
  --el-table-tr-bg-color: #f0fdf4;
}

.ad-table :deep(.ad-row-warning) {
  --el-table-tr-bg-color: #fffbeb;
}

.expand-grid,
.drawer-metrics,
.trend-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  padding: 12px;
}

.expand-grid {
  grid-template-columns: repeat(8, minmax(118px, 1fr));
  gap: 8px;
  padding: 10px 12px;
}

.expand-grid div {
  min-height: 50px;
  padding: 8px 10px;
}

.expand-grid strong {
  font-size: 13px;
}

.profit-card :deep(.el-button) {
  margin-top: 2px;
  padding: 0;
  height: 18px;
  font-size: 11px;
}

.strategy-dialog {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.strategy-form :deep(.el-input-number) {
  width: 180px;
}

.form-suffix {
  margin-left: 8px;
  color: #64748b;
  font-size: 12px;
}

.profit-detail-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.profit-detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.profit-detail-grid div {
  background: #f9fafb;
  border: 1px solid #edf2f7;
  border-radius: 8px;
  padding: 10px;
}

.profit-detail-grid span {
  display: block;
  color: #6b7280;
  font-size: 12px;
}

.profit-detail-grid strong {
  display: block;
  margin-top: 4px;
  color: #111827;
}

.profit-detail-formulas {
  display: grid;
  gap: 8px;
}

.profit-detail-formulas p {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #eef6ff;
  color: #1e3a8a;
  font-size: 13px;
  line-height: 1.6;
}

.profit-formula {
  margin: 0;
  color: #475569;
  font-size: 12px;
  line-height: 1.7;
}

.score-success { color: #16a34a; }
.score-warning { color: #ca8a04; }
.score-orange { color: #ea580c; }
.score-danger { color: #dc2626; }

.table-footer {
  padding-top: 12px;
  color: #6b7280;
}

.spend-overview-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.spend-card {
  background: #f8fafc;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  height: 430px;
  min-width: 0;
}

.spend-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
  scrollbar-gutter: stable;
}

.sub-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 12px;
}

.sub-panel-head strong {
  color: #111827;
  font-size: 14px;
}

.sub-panel-head span {
  color: #64748b;
  font-size: 12px;
}

.spend-row {
  display: grid;
  grid-template-columns: minmax(230px, 0.9fr) minmax(260px, 1.4fr) 118px;
  gap: 12px;
  align-items: center;
  min-height: 72px;
  padding: 8px 0;
  border-bottom: 1px solid #e5e7eb;
}

.spend-row:last-child {
  border-bottom: 0;
}

.spend-row strong,
.spend-row span,
.spend-row small {
  display: block;
}

.spend-row strong {
  color: #111827;
}

.spend-row span {
  margin-top: 3px;
  color: #64748b;
  font-size: 12px;
}

.spend-row small {
  margin-top: 2px;
  color: #94a3b8;
  font-size: 12px;
}

.spend-bars {
  display: grid;
  gap: 7px;
  min-width: 0;
}

.spend-bar-line {
  display: grid;
  grid-template-columns: 36px minmax(88px, 1fr) 108px;
  gap: 8px;
  align-items: center;
  min-width: 0;
}

.spend-bar-line span {
  margin: 0;
  color: #64748b;
  font-size: 12px;
}

.spend-product,
.task-product {
  display: flex;
  gap: 10px;
  align-items: center;
  min-width: 0;
}

.spend-product > div:last-child,
.task-product > div:last-child {
  min-width: 0;
}

.spend-product strong,
.spend-product span,
.spend-product small,
.task-product strong,
.task-product span,
.task-product small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.spend-row i {
  height: 8px;
  border-radius: 999px;
  background: #e2e8f0;
  overflow: hidden;
}

.spend-row b {
  display: block;
  height: 100%;
  background: #2563eb;
}

.spend-row.sku b {
  background: #f97316;
}

.spend-bar-line.cost b,
.spend-row.sku .spend-bar-line.cost b {
  background: #2563eb;
}

.spend-bar-line.revenue b,
.spend-row.sku .spend-bar-line.revenue b {
  background: #16a34a;
}

.spend-bar-line em {
  font-size: 12px;
  font-weight: 650;
}

.spend-row em {
  color: #111827;
  font-style: normal;
  font-weight: 700;
  text-align: right;
}

.compare-delta {
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 12px;
}

.compare-delta.positive {
  color: #047857;
  background: #d1fae5;
}

.compare-delta.negative {
  color: #b91c1c;
  background: #fee2e2;
}

.rank-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
}

.rank-grid h3,
.task-column h3 {
  margin: 0 0 10px;
  color: #374151;
  font-size: 14px;
}

.rank-row {
  display: grid;
  grid-template-columns: 112px 1fr 56px;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
  color: #374151;
  font-size: 12px;
}

.rank-row.with-product {
  grid-template-columns: minmax(150px, 1fr) 70px 52px;
  min-height: 54px;
}

.rank-product {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
}

.rank-product > div:last-child {
  min-width: 0;
}

.rank-product strong,
.rank-product span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rank-product strong {
  color: #111827;
}

.rank-product span {
  color: #64748b;
  font-size: 12px;
}

.rank-row i {
  height: 8px;
  border-radius: 999px;
  background: #eef2ff;
  overflow: hidden;
}

.rank-row b {
  display: block;
  height: 100%;
  background: #2563eb;
}

.rank-row em {
  color: #111827;
  font-style: normal;
  font-weight: 700;
  text-align: right;
}

.rank-row.danger b {
  background: #dc2626;
}

.trend-grid > div {
  min-height: 96px;
  background: #f8fafc;
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: #64748b;
}

.trend-card .mini-bars {
  width: 100%;
  height: 58px;
  display: flex;
  align-items: end;
  justify-content: center;
  gap: 3px;
  margin-top: 10px;
}

.mini-bars b {
  display: block;
  width: 7px;
  min-height: 8px;
  border-radius: 4px 4px 0 0;
  background: #2563eb;
}

.trend-grid span {
  color: #334155;
  font-weight: 600;
}

.trend-grid em {
  margin-top: 5px;
  font-style: normal;
  font-size: 12px;
}

.task-columns {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.task-column {
  background: #f8fafc;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 12px;
  height: 560px;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.task-column-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 10px;
}

.task-column-head span {
  color: #64748b;
  font-size: 12px;
}

.task-card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 9px;
  margin-bottom: 8px;
}

.task-card .task-product {
  margin-bottom: 6px;
}

.task-card strong,
.task-card span,
.task-card small {
  display: block;
}

.task-card span,
.task-card small,
.task-card p {
  color: #6b7280;
  font-size: 12px;
}

.task-card p {
  margin: 6px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-card > small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drawer-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.drawer-product,
.drawer-ai,
.drawer-actions {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px;
}

.drawer-ai h3 {
  margin: 0 0 10px;
}

.drawer-ai p {
  margin: 0 0 8px;
  color: #374151;
  line-height: 1.7;
}

.empty-state {
  color: #9ca3af;
  text-align: center;
  padding: 20px 0;
}

@media (max-width: 1366px) {
  .overview-layer,
  .bottom-layer {
    grid-template-columns: 1fr;
  }

  .decision-layer {
    grid-template-columns: minmax(340px, 0.42fr) minmax(500px, 0.58fr);
  }

  .compact-metrics,
  .rank-grid,
  .task-columns {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .spend-overview-grid {
    grid-template-columns: 1fr;
  }

}

@media (max-width: 1100px) {
  .decision-layer {
    grid-template-columns: 1fr;
  }

  .sync-quality-card {
    grid-template-columns: 1fr;
  }
}
</style>
