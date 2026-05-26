<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { Refresh, Search } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import { buildAdTasks, evaluateAdSku, summarizeAdDashboard, toneType } from "./ad-rules";

const loading = ref(false);
const syncing = ref(false);
const detailLoading = ref(false);
const detailVisible = ref(false);
const profitDetailVisible = ref(false);
const activeTab = ref("dashboard");
const shops = ref([]);
const summary = ref({});
const detailRows = ref([]);
const trendRows = ref([]);
const currentRow = ref(null);
const state = reactive({
  rows: [],
  total: 0,
  page: 1,
  pageSize: 30,
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
  diagnosis: "",
  sortProp: "",
  sortOrder: ""
});

const enrichedRows = computed(() => state.rows.map((row) => ({ ...row, evaluation: evaluateAdSku(row) })));
const filteredRows = computed(() => enrichedRows.value.filter(matchesFilters));
const filteredSummary = computed(() => summarizeRows(filteredRows.value));
const dashboard = computed(() => summarizeAdDashboard(filteredRows.value));
const tasks = computed(() => buildAdTasks(filteredRows.value));
const prioritizedTasks = computed(() => [...tasks.value]
  .map((task) => ({ ...task, priorityScore: taskPriorityScore(task), priorityLabel: taskPriorityLabel(taskPriorityScore(task)) }))
  .sort((a, b) => b.priorityScore - a.priorityScore));
const taskPages = reactive({
  pending: 1,
  processing: 1,
  done: 1,
  pageSize: 10
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
  for (const row of filteredRows.value) {
    const key = String(row.shop_id || row.shop_name || "unknown");
    const current = map.get(key) || {
      shop_id: row.shop_id,
      shop_name: row.shop_name || "未知店铺",
      spend: 0,
      revenue: 0,
      clicks: 0,
      impressions: 0,
      orders: 0,
      skuCount: new Set()
    };
    current.spend += Number(row.evaluation.metrics.spend || 0);
    current.revenue += Number(row.evaluation.metrics.revenue || 0);
    current.clicks += Number(row.evaluation.metrics.clicks || 0);
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
const highSpendSkuRank = computed(() => [...filteredRows.value]
  .sort((a, b) => b.evaluation.metrics.spend - a.evaluation.metrics.spend)
  .slice(0, 8));
const maxStoreCompare = computed(() => Math.max(1, ...storeSpendRank.value.flatMap((item) => [item.spend, item.revenue])));
const maxSkuCompare = computed(() => Math.max(1, ...highSpendSkuRank.value.flatMap((row) => [
  row.evaluation.metrics.spend,
  row.evaluation.metrics.revenue
])));
const ctrTopRows = computed(() => [...filteredRows.value].sort((a, b) => b.evaluation.metrics.ctr - a.evaluation.metrics.ctr).slice(0, 5));
const trendSeries = computed(() => {
  const map = new Map();
  const scopedTrendRows = trendRows.value
    .map((row) => ({ ...row, evaluation: evaluateAdSku(row) }))
    .filter(matchesFilters);
  for (const row of scopedTrendRows) {
    const date = String(row.date_key || "").slice(0, 10);
    if (!date) continue;
    const current = map.get(date) || { date, spend: 0, revenue: 0, clicks: 0, impressions: 0, orders: 0 };
    current.spend += Number(row.spend_rub || 0);
    current.revenue += Number(row.revenue_rub || 0);
    current.clicks += Number(row.clicks || 0);
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

const todoItems = computed(() => {
  const dash = dashboard.value;
  return [
    {
      key: "main-image",
      text: `优先优化 ${countMainImageTasks.value} 个低 CTR 商品主图`,
      action: "创建任务",
      tone: "warning",
      rows: filteredRows.value.filter((row) => row.evaluation.tags.some((tag) => tag.label.includes("主图")))
    },
    {
      key: "pause",
      text: `复核 ${dash.pause.length} 个高风险 SKU 是否暂停广告`,
      action: "查看SKU",
      tone: "danger",
      rows: dash.pause
    },
    {
      key: "detail",
      text: `为 ${countDetailTasks.value} 个低转化 SKU 优化详情页`,
      action: "创建任务",
      tone: "orange",
      rows: filteredRows.value.filter((row) => row.evaluation.tags.some((tag) => tag.label.includes("转化")))
    },
    {
      key: "scale",
      text: `给 ${dash.scale.length} 个高 ROAS SKU 做加预算复核`,
      action: "去处理",
      tone: "success",
      rows: dash.scale
    }
  ].filter((item) => item.rows.length);
});

const countMainImageTasks = computed(() => filteredRows.value.filter((row) => row.evaluation.tags.some((tag) => tag.label.includes("主图"))).length);
const countDetailTasks = computed(() => filteredRows.value.filter((row) => row.evaluation.tags.some((tag) => tag.label.includes("转化"))).length);
const averageCpc = computed(() => Number(filteredSummary.value.clicks || 0) ? Number(filteredSummary.value.spend_rub || 0) / Number(filteredSummary.value.clicks || 1) : 0);
const riskSkuCount = computed(() => filteredRows.value.filter((row) => ["pause", "optimize"].includes(row.evaluation.status.key)).length);
const storeHealth = computed(() => ({
  score: dashboard.value.averageScore,
  label: dashboard.value.averageScore >= 78 ? "表现稳定" : dashboard.value.averageScore >= 60 ? "需观察" : dashboard.value.averageScore >= 35 ? "存在风险" : "高风险",
  tone: scoreTone(dashboard.value.averageScore)
}));

const aiConclusion = computed(() => {
  if (!filteredRows.value.length) return "当前筛选范围内还没有广告数据，请先同步 Ozon 广告。";
  return `今日广告整体表现：${storeHealth.value.label}。ROAS ${decimal(filteredSummary.value.roas)}，CTR ${percent(filteredSummary.value.ctr)}，CR ${percent(filteredSummary.value.conversion_rate)}。当前有 ${dashboard.value.scale.length} 个 SKU 可加预算，${dashboard.value.pause.length} 个 SKU 建议暂停。`;
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

function summarizeRows(rows = []) {
  const total = rows.reduce((acc, row) => {
    const metrics = row.evaluation?.metrics || evaluateAdSku(row).metrics;
    acc.spend_rub += Number(metrics.spend || row.spend_rub || 0);
    acc.revenue_rub += Number(metrics.revenue || row.revenue_rub || 0);
    acc.impressions += Number(metrics.impressions || row.impressions || 0);
    acc.clicks += Number(metrics.clicks || row.clicks || 0);
    acc.orders += Number(metrics.orders || row.orders || 0);
    acc.units += Number(row.units || 0);
    return acc;
  }, { spend_rub: 0, revenue_rub: 0, impressions: 0, clicks: 0, orders: 0, units: 0 });
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
  const page = Number(taskPages[column.key] || 1);
  const start = (page - 1) * taskPages.pageSize;
  return column.rows.slice(start, start + taskPages.pageSize);
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
  if (tableFilters.diagnosis && primaryTag(row).label !== tableFilters.diagnosis) return false;
  return true;
}

function tableSortValue(row, prop) {
  if (prop === "roas") return Number(row.evaluation.metrics.roas || 0);
  if (prop === "ctr") return Number(row.evaluation.metrics.ctr || 0);
  if (prop === "cr") return Number(row.evaluation.metrics.cr || 0);
  if (prop === "acos") return Number(row.evaluation.metrics.acos || 0);
  if (prop === "healthScore") return Number(row.evaluation.healthScore || 0);
  if (prop === "spend_rub") return Number(row.evaluation.metrics.spend || 0);
  return Number(row[prop] || 0);
}

function resetTablePage() {
  state.page = 1;
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
  if (row.evaluation.status.key === "pause") return { label: "暂停广告", type: "danger", action: () => previewOnly("暂停广告需要人工确认，当前版本不会自动操作 Ozon。") };
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
    const [listPayload, summaryPayload, detailsPayload] = await Promise.all([
      apiClient.get(`/api/advertising/daily?${params.toString()}`),
      apiClient.get(`/api/advertising/daily/summary?${params.toString()}`),
      apiClient.get(`/api/advertising/daily/details?${params.toString()}`)
    ]);
    state.rows = Array.isArray(listPayload?.rows) ? listPayload.rows : [];
    state.total = Number(listPayload?.total || state.rows.length);
    summary.value = summaryPayload || {};
    trendRows.value = Array.isArray(detailsPayload?.rows) ? detailsPayload.rows : [];
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
    <section class="hero-card">
      <div>
        <h1>Ozon AI广告运营驾驶舱</h1>
        <p>第一眼看结论，第二眼看风险，第三眼知道下一步该做什么。</p>
      </div>
      <div class="hero-actions">
        <el-button type="success" :loading="syncing" @click="syncFromOzon">同步 Ozon 广告</el-button>
        <el-button type="primary" :icon="Refresh" :loading="syncing" @click="syncFromOzon">刷新</el-button>
      </div>
    </section>

    <section class="filter-card">
      <el-form inline>
        <el-form-item label="店铺">
          <el-select v-model="state.filters.shopId" filterable clearable placeholder="全部店铺" style="width: 210px">
            <el-option label="全部店铺" value="" />
            <el-option v-for="shop in shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
          </el-select>
        </el-form-item>
        <el-form-item label="开始日期"><el-date-picker v-model="state.filters.from" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="结束日期"><el-date-picker v-model="state.filters.to" type="date" value-format="YYYY-MM-DD" /></el-form-item>
        <el-form-item label="关键词"><el-input v-model="state.filters.keyword" clearable placeholder="SKU / 商品 / 活动" style="width: 220px" @keyup.enter="handleSearch" /></el-form-item>
        <el-form-item label="广告状态">
          <el-select v-model="state.filters.adStatus" style="width: 130px">
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
        <el-form-item label="商品阶段">
          <el-select v-model="state.filters.adStage" style="width: 120px">
            <el-option label="全部" value="all" />
            <el-option label="测款" value="testing" />
            <el-option label="放量" value="scale" />
            <el-option label="稳定" value="stable" />
            <el-option label="止损" value="stop_loss" />
          </el-select>
        </el-form-item>
        <el-form-item label="广告类型">
          <el-select v-model="state.filters.adType" style="width: 110px">
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
      </div>
    </section>

    <el-tabs v-model="activeTab" class="ad-tabs">
      <el-tab-pane label="广告驾驶舱" name="dashboard">
        <div class="tab-pane-stack">
    <section class="overview-layer">
      <div class="health-card" :class="storeHealth.tone">
        <div class="health-title">
          <span>今日广告健康度</span>
          <el-tag :type="toneType(storeHealth.tone)" effect="light">{{ storeHealth.label }}</el-tag>
        </div>
        <div class="health-score">
          <strong>{{ storeHealth.score }}</strong>
          <span>分</span>
        </div>
        <div class="health-metrics">
          <div><span>ROAS</span><strong>{{ decimal(filteredSummary.roas) }}</strong></div>
          <div><span>CTR</span><strong>{{ percent(filteredSummary.ctr) }}</strong></div>
          <div><span>CR</span><strong>{{ percent(filteredSummary.conversion_rate) }}</strong></div>
          <div><span>ACOS</span><strong>{{ percent(filteredSummary.acos) }}</strong></div>
        </div>
        <p>{{ aiConclusion }}</p>
      </div>
      <div class="compact-metrics">
        <div class="mini-card">
          <span>广告花费</span>
          <strong>{{ money(filteredSummary.spend_rub) }}</strong>
          <small>↗ {{ metricTrendText() }}</small>
        </div>
        <div class="mini-card">
          <span>广告销售额</span>
          <strong>{{ money(filteredSummary.revenue_rub) }}</strong>
          <small>↗ {{ metricTrendText() }}</small>
        </div>
        <div class="mini-card">
          <span>点击 / 展示</span>
          <strong>{{ integer(filteredSummary.clicks) }} / {{ integer(filteredSummary.impressions) }}</strong>
          <small>曝光承接能力</small>
        </div>
        <div class="mini-card">
          <span>订单</span>
          <strong>{{ integer(filteredSummary.orders) }}</strong>
          <small>广告归因订单</small>
        </div>
        <div class="mini-card">
          <span>平均 CPC</span>
          <strong>{{ money(averageCpc) }}</strong>
          <small>点击成本</small>
        </div>
        <div class="mini-card danger">
          <span>风险 SKU</span>
          <strong>{{ riskSkuCount }}</strong>
          <small>需优先处理</small>
        </div>
      </div>
    </section>

    <section class="decision-layer">
      <div class="ai-panel">
        <div class="panel-head">
          <strong>AI广告诊断</strong>
          <span>规则引擎 V1 · 不自动操作广告</span>
        </div>
        <div class="ai-content">
          <div class="ai-copy">
            <p><b>今日整体结论：</b>{{ storeHealth.label }}</p>
            <p><b>当前主要问题：</b>{{ dashboard.highClickLowCr.length ? "部分 SKU 存在高点击低转化。" : "未发现明显高点击低转化集中问题。" }}</p>
            <p><b>优先处理建议：</b>{{ dashboard.pause.length ? "先复核建议暂停 SKU，再处理低 CTR/低 CR SKU。" : "优先处理 CR 低于 1.5% 且点击数较高的 SKU。" }}</p>
          </div>
          <div class="risk-summary">
            <div><span>建议暂停</span><strong>{{ dashboard.pause.length }}</strong></div>
            <div><span>需要换主图</span><strong>{{ countMainImageTasks }}</strong></div>
            <div><span>优化详情页</span><strong>{{ countDetailTasks }}</strong></div>
            <div><span>可加预算</span><strong>{{ dashboard.scale.length }}</strong></div>
          </div>
        </div>
      </div>
      <div class="todo-panel">
        <div class="panel-head">
          <strong>今日待处理事项</strong>
          <span>让数据变成动作</span>
        </div>
        <div v-if="!todoItems.length" class="empty-state">暂无待处理事项</div>
        <div v-for="item in todoItems" :key="item.key" class="todo-row" :class="item.tone">
          <span>{{ item.text }}</span>
          <el-button size="small" @click="item.rows[0] && openDetails(item.rows[0])">{{ item.action }}</el-button>
        </div>
      </div>
    </section>

    <section class="sku-panel">
      <div class="panel-head">
        <strong>SKU广告管理</strong>
        <span>高风险自动置顶，只显示主诊断和主动作</span>
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
              <div><span>店铺</span><strong>{{ row.shop_name || "未知店铺" }}</strong></div>
              <div><span>状态</span><strong>{{ readableCampaignStatus(row).label }}</strong></div>
              <div><span>阶段</span><strong>{{ row.evaluation.stage.label }}</strong></div>
              <div><span>CPC 点击成本</span><strong>{{ money(row.evaluation.metrics.cpc) }}</strong></div>
              <div><span>展示</span><strong>{{ integer(row.evaluation.metrics.impressions) }}</strong></div>
              <div><span>点击</span><strong>{{ integer(row.evaluation.metrics.clicks) }}</strong></div>
              <div><span>订单</span><strong>{{ integer(row.evaluation.metrics.orders) }}</strong></div>
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
            </div>
          </template>
        </el-table-column>
        <el-table-column label="SKU / 商品" min-width="245" fixed="left">
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
                <span>{{ row.product_name || row.offer_id || "未同步商品信息" }}</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="spend_rub" label="花费（RUB）" width="165" sortable="custom" align="right">
          <template #default="{ row }">
            <div class="spend-metric-cell">
              <strong>{{ rub(row.evaluation.metrics.spend) }}</strong>
              <span>{{ budgetText(row) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="roas" label="ROAS" width="120" align="right" sortable="custom">
          <template #header>
            <el-tooltip placement="top" effect="dark" content="ROAS（投产比）：广告销售额 / 广告花费。数值越高越好，例如 4.70 表示花 1 RUB 广告费带来 4.70 RUB 销售额。">
              <span class="metric-header">ROAS</span>
            </el-tooltip>
          </template>
          <template #default="{ row }">
            <div class="formula-metric"><strong>{{ decimal(row.evaluation.metrics.roas) }}</strong><span>{{ rub(row.evaluation.metrics.revenue) }} / {{ rub(row.evaluation.metrics.spend) }}</span></div>
          </template>
        </el-table-column>
        <el-table-column prop="ctr" label="CTR" width="120" align="right" sortable="custom">
          <template #header>
            <el-tooltip placement="top" effect="dark" content="CTR（点击率）：点击数 / 展示数。主要看主图、标题、价格是否吸引人。">
              <span class="metric-header">CTR</span>
            </el-tooltip>
          </template>
          <template #default="{ row }">
            <div class="formula-metric"><strong>{{ percent(row.evaluation.metrics.ctr) }}</strong><span>{{ integer(row.evaluation.metrics.clicks) }} / {{ integer(row.evaluation.metrics.impressions) }}</span></div>
          </template>
        </el-table-column>
        <el-table-column prop="cr" label="CR" width="120" align="right" sortable="custom">
          <template #header>
            <el-tooltip placement="top" effect="dark" content="CR（转化率）：订单数 / 点击数。主要看详情页、价格、评价、物流和 SKU 是否匹配。">
              <span class="metric-header">CR</span>
            </el-tooltip>
          </template>
          <template #default="{ row }">
            <div class="formula-metric"><strong>{{ percent(row.evaluation.metrics.cr) }}</strong><span>{{ integer(row.evaluation.metrics.orders) }} / {{ integer(row.evaluation.metrics.clicks) }}</span></div>
          </template>
        </el-table-column>
        <el-table-column prop="acos" label="ACOS" width="120" align="right" sortable="custom">
          <template #header>
            <el-tooltip placement="top" effect="dark" content="ACOS（广告成本销售比）：广告花费 / 广告销售额。数值越低越好，表示广告费占销售额的比例。">
              <span class="metric-header">ACOS</span>
            </el-tooltip>
          </template>
          <template #default="{ row }">
            <div class="formula-metric"><strong>{{ percent(row.evaluation.metrics.acos) }}</strong><span>{{ rub(row.evaluation.metrics.spend) }} / {{ rub(row.evaluation.metrics.revenue) }}</span></div>
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
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <div class="row-actions">
              <el-button link :type="primaryAction(row).type" @click="primaryAction(row).action">{{ primaryAction(row).label }}</el-button>
              <el-button link type="primary" @click="openDetails(row)">详情</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <div class="table-footer">
        <span>共 {{ tableFilteredRows.length }} 个 SKU</span>
        <el-pagination v-model:current-page="state.page" v-model:page-size="state.pageSize" :page-sizes="[20, 30, 50, 100]" :total="tableFilteredRows.length" layout="sizes, prev, pager, next" />
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
        <div class="spend-card">
          <div class="sub-panel-head">
            <strong>高花费 SKU</strong>
            <span>优先复核烧钱 SKU 和放量 SKU</span>
          </div>
          <div v-if="!highSpendSkuRank.length" class="empty-state">暂无 SKU 广告数据</div>
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
          <el-pagination
            v-if="column.rows.length > taskPages.pageSize"
            v-model:current-page="taskPages[column.key]"
            :page-size="taskPages.pageSize"
            :total="column.rows.length"
            size="small"
            layout="prev, pager, next"
          />
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
          <el-table-column label="CTR" width="90" align="right"><template #default="{ row }">{{ percent(row.ctr) }}</template></el-table-column>
          <el-table-column prop="orders" label="订单" width="80" align="right" />
          <el-table-column label="ROAS" width="90" align="right"><template #default="{ row }">{{ decimal(row.roas) }}</template></el-table-column>
        </el-table>
      </div>
    </el-drawer>

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
  max-width: 1760px;
  margin: 0 auto;
  padding-bottom: 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.hero-card,
.filter-card,
.health-card,
.mini-card,
.ai-panel,
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

.hero-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 22px;
}

.hero-card h1 {
  margin: 0;
  color: #111827;
  font-size: 24px;
}

.hero-card p {
  margin: 6px 0 0;
  color: #6b7280;
  font-size: 13px;
}

.hero-actions,
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
  align-items: flex-start;
  gap: 14px;
  padding: 14px 16px 8px;
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
  gap: 18px;
}

.overview-layer {
  display: grid;
  grid-template-columns: minmax(420px, 0.48fr) minmax(0, 0.52fr);
  gap: 16px;
}

.health-card {
  padding: 20px;
  border-left: 5px solid #2563eb;
}

.health-card.success { border-left-color: #16a34a; }
.health-card.warning { border-left-color: #eab308; }
.health-card.orange { border-left-color: #f97316; }
.health-card.danger { border-left-color: #dc2626; }

.health-title,
.panel-head,
.table-footer {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
}

.health-title span,
.panel-head span,
.mini-card span,
.mini-card small {
  color: #6b7280;
  font-size: 12px;
}

.health-score {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  margin: 14px 0;
}

.health-score strong {
  color: #111827;
  font-size: 52px;
  line-height: 1;
}

.health-score span {
  color: #6b7280;
  margin-bottom: 8px;
}

.health-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.health-metrics div,
.drawer-metrics div,
.expand-grid div {
  background: #f9fafb;
  border: 1px solid #edf2f7;
  border-radius: 8px;
  padding: 10px;
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
  margin-top: 4px;
  color: #111827;
}

.health-card p {
  margin: 0;
  color: #374151;
  line-height: 1.7;
}

.compact-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.mini-card {
  min-height: 112px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.mini-card strong {
  color: #111827;
  font-size: 20px;
}

.mini-card.danger strong {
  color: #dc2626;
}

.decision-layer,
.bottom-layer {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(360px, 0.8fr);
  gap: 16px;
}

.ai-panel,
.todo-panel,
.sku-panel,
.spend-overview-panel,
.ranking-panel,
.trend-panel,
.task-board {
  padding: 16px;
}

.panel-head {
  margin-bottom: 14px;
}

.panel-head strong {
  color: #111827;
  font-size: 16px;
}

.ai-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 240px;
  gap: 16px;
}

.ai-copy {
  background: linear-gradient(135deg, #f8fafc, #eef6ff);
  border-radius: 10px;
  padding: 16px;
}

.ai-copy p {
  margin: 0 0 10px;
  color: #374151;
  line-height: 1.7;
}

.risk-summary {
  display: grid;
  gap: 10px;
}

.risk-summary div,
.todo-row {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 10px;
  background: #fff;
}

.risk-summary span {
  display: block;
  color: #6b7280;
  font-size: 12px;
}

.risk-summary strong {
  display: block;
  margin-top: 4px;
  font-size: 20px;
}

.todo-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
  margin-bottom: 10px;
}

.todo-row span {
  color: #374151;
}

.todo-row.danger { background: #fff1f2; }
.todo-row.orange { background: #fff7ed; }
.todo-row.warning { background: #fefce8; }
.todo-row.success { background: #f0fdf4; }

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
  width: 42px;
  height: 56px;
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
.formula-metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  line-height: 1.25;
}

.spend-metric-cell strong,
.formula-metric strong {
  color: #111827;
  font-size: 13px;
}

.spend-metric-cell strong {
  font-size: 14px;
}

.spend-metric-cell span,
.formula-metric span {
  color: #64748b;
  font-size: 11px;
}

.spend-metric-cell span {
  white-space: nowrap;
}

.table-filter-select {
  width: 100%;
}

.ad-table :deep(.el-table__column-filter-trigger) {
  display: none;
}

.ad-table :deep(.el-table__row) {
  height: 72px;
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
  min-height: 74px;
  padding: 9px 0;
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
  min-height: 180px;
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
  padding: 10px;
  margin-bottom: 10px;
}

.task-card .task-product {
  margin-bottom: 8px;
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
  margin: 8px 0;
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
  .decision-layer,
  .bottom-layer {
    grid-template-columns: 1fr;
  }

  .compact-metrics,
  .rank-grid,
  .task-columns {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .spend-overview-grid {
    grid-template-columns: 1fr;
  }

  .ai-content {
    grid-template-columns: 1fr;
  }
}
</style>
