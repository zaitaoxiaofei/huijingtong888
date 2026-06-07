<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api";
import ProfitTrendChart from "../../components/profit/ProfitTrendChart.vue";
import ProfitRankingView from "./ProfitRankingView.vue";
import { formatInteger, formatMoney, formatMonthLabel, formatShortDate } from "./profit-utils.js";
import { shanghaiDateKey } from "../../utils/shanghai-date";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const syncLoading = ref(false);
const sectionLoading = ref({
  summary: false,
  dailyTrend: false,
  monthlyTrend: false
});
const sectionErrors = ref({
  summary: "",
  dailyTrend: "",
  monthlyTrend: ""
});
const dashboard = ref({
  ranges: {},
  dailyTrend14: [],
  previousDailyTrend14: [],
  monthlyTrend12: []
});

let dashboardAbortController = null;
let dashboardLoadTimer = 0;

function todayText() {
  return shanghaiDateKey();
}

const viewTabs = [
  { label: "看板", value: "/profit" },
  { label: "SKU排行榜", value: "/profit/sku-ranking" },
  { label: "店铺排行榜", value: "/profit/shop-ranking" }
];

const activeViewRoute = computed(() => (
  viewTabs.some((item) => item.value === route.path) ? route.path : "/profit"
));

const activeRankingDimension = computed(() => (
  activeViewRoute.value === "/profit/shop-ranking" ? "shop" : "sku"
));

const isDashboardView = computed(() => activeViewRoute.value === "/profit");

const dailySeriesDefs = [
  { key: "profit", label: "本期利润", color: "#2563eb", axis: "money" },
  { key: "revenue", label: "本期营业额", color: "#0f766e", axis: "money" }
];

const dailyCompareSeriesDefs = [
  { key: "profit", label: "上月同期利润", color: "#60a5fa", axis: "money" },
  { key: "revenue", label: "上月同期营业额", color: "#34d399", axis: "money" }
];

const monthlyRevenueSeriesDefs = [
  { key: "revenue", label: "营业额", color: "#0f766e", axis: "money" }
];

const monthlyOrderSeriesDefs = [
  { key: "order_count", label: "单量", color: "#7c3aed", axis: "count" }
];

const monthlyMarginSeriesDefs = [
  { key: "profit_margin", label: "利润率", color: "#d97706", axis: "money" }
];

const summaryHighlights = computed(() => {
  const today = dashboard.value.ranges?.today?.summary || {};
  const month = dashboard.value.ranges?.currentMonth?.summary || {};
  return [
    { label: "今日订单", value: formatInteger(today.order_count), suffix: "单" },
    { label: "今日营业额", value: formatMoney(today.revenue), suffix: "CNY" },
    { label: "今日利润", value: formatMoney(today.profit), suffix: "CNY" },
    { label: "今日取消金额", value: formatMoney(today.cancelled_revenue), suffix: "CNY" },
    { label: "今日退货损失", value: formatMoney(today.return_loss), suffix: "CNY" },
    { label: "本月订单", value: formatInteger(month.order_count), suffix: "单" },
    { label: "本月营业额", value: formatMoney(month.revenue), suffix: "CNY" },
    { label: "本月利润", value: formatMoney(month.profit), suffix: "CNY" },
    { label: "本月有效订单", value: formatInteger(month.effective_orders), suffix: "单" }
  ];
});

const summaryColumns = [
  { key: "today", label: "今日" },
  { key: "yesterday", label: "昨日" },
  { key: "currentMonth", label: "本月" },
  { key: "lastMonth", label: "上月" },
  { key: "currentQuarter", label: "本季" },
  { key: "currentYear", label: "本年" }
];

const summaryRows = computed(() => {
  const ranges = dashboard.value.ranges || {};
  const getSummary = (key) => ranges?.[key]?.summary || {};
  return [
    {
      label: "订单数",
      formatter: formatInteger,
      suffix: "单",
      values: Object.fromEntries(summaryColumns.map((column) => [column.key, getSummary(column.key).order_count]))
    },
    {
      label: "营业额",
      formatter: formatMoney,
      suffix: "CNY",
      values: Object.fromEntries(summaryColumns.map((column) => [column.key, getSummary(column.key).revenue]))
    },
    {
      label: "利润",
      formatter: formatMoney,
      suffix: "CNY",
      values: Object.fromEntries(summaryColumns.map((column) => [column.key, getSummary(column.key).profit]))
    },
    {
      label: "取消金额",
      formatter: formatMoney,
      suffix: "CNY",
      values: Object.fromEntries(summaryColumns.map((column) => [column.key, getSummary(column.key).cancelled_revenue]))
    },
    {
      label: "取消订单",
      formatter: formatInteger,
      suffix: "单",
      values: Object.fromEntries(summaryColumns.map((column) => [column.key, getSummary(column.key).cancelled_orders]))
    },
    {
      label: "退货金额",
      formatter: formatMoney,
      suffix: "CNY",
      values: Object.fromEntries(summaryColumns.map((column) => [column.key, getSummary(column.key).return_revenue]))
    },
    {
      label: "退货订单",
      formatter: formatInteger,
      suffix: "单",
      values: Object.fromEntries(summaryColumns.map((column) => [column.key, getSummary(column.key).return_orders]))
    },
    {
      label: "退货损失",
      formatter: formatMoney,
      suffix: "CNY",
      values: Object.fromEntries(summaryColumns.map((column) => [column.key, getSummary(column.key).return_loss]))
    },
    {
      label: "有效订单",
      formatter: formatInteger,
      suffix: "单",
      values: Object.fromEntries(summaryColumns.map((column) => [column.key, getSummary(column.key).effective_orders]))
    }
  ];
});

const monthlyTrendWithMargin = computed(() => (
  (dashboard.value.monthlyTrend12 || []).map((row) => ({
    ...row,
    profit_margin: Number(row?.revenue || 0) ? (Number(row?.profit || 0) / Number(row.revenue)) * 100 : 0
  }))
));

function formatPercentValue(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function formatDayWithWeekday(value) {
  const text = String(value || "");
  if (!text) return "";
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const date = new Date(`${text}T00:00:00`);
  const weekday = Number.isNaN(date.getTime()) ? "" : weekdays[date.getDay()];
  return `${formatShortDate(text)}\n${weekday}`;
}

function sectionStateKey(section) {
  return {
    "daily-trend": "dailyTrend",
    "monthly-trend": "monthlyTrend"
  }[section] || section;
}

function setSectionLoading(section, value) {
  sectionLoading.value = { ...sectionLoading.value, [sectionStateKey(section)]: value };
}

function setSectionError(section, value) {
  sectionErrors.value = { ...sectionErrors.value, [sectionStateKey(section)]: value };
}

function assignSectionPayload(section, payload) {
  if (section === "summary") {
    dashboard.value = { ...dashboard.value, ranges: payload?.ranges || {} };
    return;
  }
  if (section === "daily-trend") {
    dashboard.value = {
      ...dashboard.value,
      dailyTrend14: payload?.dailyTrend14 || [],
      previousDailyTrend14: payload?.previousDailyTrend14 || []
    };
    return;
  }
  if (section === "monthly-trend") {
    dashboard.value = { ...dashboard.value, monthlyTrend12: payload?.monthlyTrend12 || [] };
  }
}

function withRefreshParams(params, forceRefresh = false) {
  if (!forceRefresh) return params;
  params.set("refresh", "1");
  params.set("_ts", `${Date.now()}`);
  return params;
}

async function loadDashboardSection(section, signal, options = {}) {
  setSectionLoading(section, true);
  setSectionError(section, "");
  try {
    const forceRefresh = Boolean(options.forceRefresh);
    const payload = await apiClient.get(`/api/profit-dashboard?${withRefreshParams(new URLSearchParams({ section }), forceRefresh).toString()}`, { signal, noCache: forceRefresh, cache: forceRefresh ? "no-store" : undefined });
    if (signal.aborted) return;
    assignSectionPayload(section, payload);
  } catch (error) {
    if (error?.name === "AbortError") return;
    setSectionError(section, error.message || "加载失败");
    throw error;
  } finally {
    if (!signal.aborted) setSectionLoading(section, false);
  }
}

async function loadDashboard(forceRefresh = false) {
  dashboardAbortController?.abort();
  dashboardAbortController = new AbortController();
  const { signal } = dashboardAbortController;
  loading.value = true;
  const jobs = [
    loadDashboardSection("summary", signal, { forceRefresh }),
    loadDashboardSection("daily-trend", signal, { forceRefresh }),
    loadDashboardSection("monthly-trend", signal, { forceRefresh })
  ];
  const results = await Promise.allSettled(jobs);
  if (signal.aborted) return;
  const failures = results.filter((item) => item.status === "rejected");
  if (failures.length) {
    ElMessage.warning(`利润看板有 ${failures.length} 个区块加载失败，其余区块已显示`);
  }
  loading.value = false;
}

async function refreshTodayAnalytics() {
  const today = todayText();
  await apiClient.post("/api/profit-snapshots/refresh", { from: today, to: today });
}

async function refreshDashboardData() {
  if (syncLoading.value || loading.value) return;
  syncLoading.value = true;
  try {
    const today = todayText();
    const yearStart = `${today.slice(0, 4)}-01-01`;
    const [syncResult, cancelledSyncResult] = await Promise.all([
      apiClient.post("/api/sync/ozon", { from: today, to: today }),
      apiClient.post("/api/sync/ozon", { from: yearStart, to: today, statuses: ["cancelled"] })
    ]);
    await refreshTodayAnalytics();
    await loadDashboard(true);
    const fetched = Number(syncResult?.fetched || 0) + Number(cancelledSyncResult?.fetched || 0);
    const inserted = Number(syncResult?.inserted || 0) + Number(cancelledSyncResult?.inserted || 0);
    const updated = Number(syncResult?.updated || 0) + Number(cancelledSyncResult?.updated || 0);
    ElMessage.success(`刷新完成：拉取 ${fetched} 单，新增 ${inserted} 项，更新 ${updated} 单`);
  } catch (error) {
    ElMessage.error(error?.message || "刷新利润看板失败");
  } finally {
    syncLoading.value = false;
  }
}

function handleViewChange(target) {
  if (target && target !== route.path) router.push(target);
}

function openAftersalesPage() {
  router.push("/profit/aftersales");
}

onMounted(() => {
  dashboardLoadTimer = window.setTimeout(() => {
    loadDashboard();
  }, 0);
});

onBeforeUnmount(() => {
  if (dashboardLoadTimer) window.clearTimeout(dashboardLoadTimer);
  dashboardAbortController?.abort();
});
</script>

<template>
  <div class="page-stack profit-dashboard-page">
    <div class="profit-view-switch-bar">
      <el-button
        v-if="isDashboardView"
        type="primary"
        :loading="loading || syncLoading"
        @click="refreshDashboardData"
      >
        刷新数据
      </el-button>
      <el-segmented
        :model-value="activeViewRoute"
        :options="viewTabs"
        @change="handleViewChange"
      />
    </div>

    <el-card shadow="never" class="page-card profit-dashboard-hero-card">
      <div class="page-hero profit-dashboard-hero">
        <div>
          <h2>利润看板</h2>
          <p>重点看利润、营业额和上月同期变化，首屏信息尽量浓缩。</p>
        </div>
        <div class="page-card-actions">
          <el-button class="erp-btn erp-btn-secondary" v-if="isDashboardView" type="warning" plain @click="openAftersalesPage">售后损失</el-button>
        </div>
      </div>

      <div v-if="isDashboardView" v-loading="sectionLoading.summary" class="profit-summary-strip">
        <div v-for="item in summaryHighlights" :key="item.label" class="profit-summary-card">
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
          <small>{{ item.suffix }}</small>
        </div>
      </div>
      <div v-if="isDashboardView && sectionErrors.summary" class="profit-dashboard-section-error">{{ sectionErrors.summary }}</div>
    </el-card>

    <template v-if="isDashboardView">
    <el-row :gutter="16" class="profit-dashboard-main-row">
      <el-col :xs="24" :xl="12" class="profit-trend-col">
        <el-card shadow="never" class="page-card profit-panel-card profit-trend-panel" v-loading="sectionLoading.dailyTrend">
          <ProfitTrendChart
            :rows="dashboard.dailyTrend14"
            :compare-rows="dashboard.previousDailyTrend14"
            title="近 14 天经营走势"
            subtitle="只保留利润和营业额，并用上月同期两条虚线做对比。"
            :series-defs="dailySeriesDefs"
            :compare-series-defs="dailyCompareSeriesDefs"
            :label-formatter="formatDayWithWeekday"
            :money-formatter="formatMoney"
            :count-formatter="formatInteger"
            :chart-height="250"
            tooltip-mode="focus"
            :tooltip-width="220"
          />
          <div v-if="sectionErrors['daily-trend']" class="profit-dashboard-section-error">{{ sectionErrors["daily-trend"] }}</div>
        </el-card>
      </el-col>

      <el-col :xs="24" :xl="12" class="profit-matrix-col">
        <el-card shadow="never" class="page-card profit-panel-card profit-matrix-panel" v-loading="sectionLoading.summary">
          <template #header>
            <div class="page-card-header">
              <div>
                <strong>核心汇总矩阵</strong>
                <span>今日、昨日、本月、上月、本季、本年集中查看。</span>
              </div>
            </div>
          </template>

          <div class="profit-summary-table-wrap">
            <table class="profit-summary-table">
              <thead>
                <tr>
                  <th>指标</th>
                  <th
                    v-for="column in summaryColumns"
                    :key="column.key"
                    :class="{ 'summary-today-column': column.key === 'today' }"
                  >
                    {{ column.label }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in summaryRows" :key="row.label">
                  <th>{{ row.label }}</th>
                  <td
                    v-for="column in summaryColumns"
                    :key="column.key"
                    :class="{ 'summary-today-column': column.key === 'today' }"
                  >
                    <strong>{{ row.formatter(row.values[column.key]) }}</strong>
                    <small>{{ row.suffix }}</small>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="sectionErrors.summary" class="profit-dashboard-section-error">{{ sectionErrors.summary }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" class="profit-dashboard-monthly-row">
      <el-col :xs="24" :xl="8">
        <el-card shadow="never" class="page-card profit-panel-card profit-monthly-card" v-loading="sectionLoading.monthlyTrend">
          <ProfitTrendChart
            :rows="dashboard.monthlyTrend12"
            title="近 12 个月营业额趋势"
            subtitle="单独看月度营业额变化。"
            x-key="month_key"
            :series-defs="monthlyRevenueSeriesDefs"
            :label-formatter="formatMonthLabel"
            :money-formatter="formatMoney"
            :count-formatter="formatInteger"
            :show-compare-toggle="false"
            :chart-height="220"
            tooltip-mode="focus"
            :tooltip-width="160"
          />
        </el-card>
      </el-col>
      <el-col :xs="24" :xl="8">
        <el-card shadow="never" class="page-card profit-panel-card profit-monthly-card" v-loading="sectionLoading.monthlyTrend">
          <ProfitTrendChart
            :rows="dashboard.monthlyTrend12"
            title="近 12 个月单量趋势"
            subtitle="单独看月度订单量变化。"
            x-key="month_key"
            :series-defs="monthlyOrderSeriesDefs"
            :label-formatter="formatMonthLabel"
            :money-formatter="formatMoney"
            :count-formatter="formatInteger"
            :show-compare-toggle="false"
            :chart-height="220"
            tooltip-mode="focus"
            :tooltip-width="160"
          />
        </el-card>
      </el-col>
      <el-col :xs="24" :xl="8">
        <el-card shadow="never" class="page-card profit-panel-card profit-monthly-card" v-loading="sectionLoading.monthlyTrend">
          <ProfitTrendChart
            :rows="monthlyTrendWithMargin"
            title="近 12 个月利润率趋势"
            subtitle="单独看月度利润率变化。"
            x-key="month_key"
            :series-defs="monthlyMarginSeriesDefs"
            :label-formatter="formatMonthLabel"
            :money-formatter="formatPercentValue"
            :count-formatter="formatInteger"
            :show-compare-toggle="false"
            :chart-height="220"
            tooltip-mode="focus"
            :tooltip-width="160"
          />
          <div v-if="sectionErrors['monthly-trend']" class="profit-dashboard-section-error">{{ sectionErrors["monthly-trend"] }}</div>
        </el-card>
      </el-col>
    </el-row>
    </template>

    <ProfitRankingView
      v-else
      :dimension="activeRankingDimension"
      :show-navigation="false"
    />
  </div>
</template>

<style scoped>
:global(.profit-dashboard-page .profit-dashboard-hero-card) {
  display: block !important;
}

.profit-dashboard-page {
  gap: 16px;
}

.profit-dashboard-hero {
  align-items: center;
  gap: 12px;
  padding: 0;
}

.profit-dashboard-hero-card {
  padding-bottom: 8px;
}

:deep(.profit-dashboard-hero-card > .el-card__body) {
  padding: 18px;
}

.profit-dashboard-hero h2 {
  font-size: 20px;
}

.profit-dashboard-hero p {
  font-size: 13px;
}

.profit-view-switch-bar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  min-height: 32px;
}

.profit-summary-strip {
  grid-template-columns: repeat(9, minmax(0, 1fr));
  gap: 8px;
  min-height: 0;
  margin-top: 16px;
}

.profit-summary-card {
  min-height: 76px;
  justify-content: space-between;
  border-radius: 8px;
}

.profit-summary-card strong {
  font-size: 17px;
}

.profit-dashboard-main-row,
.profit-dashboard-monthly-row {
  align-items: stretch;
  row-gap: 16px;
}

.profit-dashboard-main-row > .el-col,
.profit-dashboard-monthly-row > .el-col {
  display: flex;
}

.profit-panel-card {
  width: 100%;
  height: 100%;
  min-height: 0;
}

:deep(.profit-panel-card) {
  display: flex;
  flex-direction: column;
}

:deep(.profit-panel-card > .el-card__body) {
  flex: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.profit-trend-panel,
.profit-matrix-panel {
  min-height: 430px;
}

.profit-matrix-panel :deep(.el-card__body) {
  padding-bottom: 14px;
}

.profit-matrix-panel :deep(.el-card__header) {
  padding: 16px 18px 10px;
  border-bottom: 0;
}

.profit-summary-table-wrap {
  flex: 1;
  min-height: 0;
}

.profit-summary-table {
  min-width: 760px;
  border-spacing: 0 6px;
}

.profit-summary-table tbody th,
.profit-summary-table tbody td {
  padding: 8px 10px;
}

.profit-monthly-card {
  min-height: 335px;
}

.profit-dashboard-section-error {
  margin-top: 10px;
  color: #b91c1c;
  font-size: 12px;
}

.summary-today-column,
.summary-today-column strong,
.summary-today-column small {
  font-weight: 800;
}

.profit-summary-table thead .summary-today-column {
  color: #1d4ed8;
}

.profit-summary-table tbody .summary-today-column strong {
  color: #1d4ed8;
}

.profit-summary-table tbody .summary-today-column small {
  color: #3b82f6;
}

:global(:root[data-theme="dark"] .profit-summary-table thead .summary-today-column) {
  color: #bfdbfe;
}

:global(:root[data-theme="dark"] .profit-summary-table tbody .summary-today-column strong) {
  color: #dbeafe;
}

:global(:root[data-theme="dark"] .profit-summary-table tbody .summary-today-column small) {
  color: #93c5fd;
}

@media (max-width: 1360px) {
  .profit-summary-strip {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 780px) {
  .profit-view-switch-bar,
  .profit-dashboard-hero {
    align-items: stretch;
    flex-direction: column-reverse;
  }

  .profit-summary-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .profit-trend-panel,
  .profit-matrix-panel,
  .profit-monthly-card {
    min-height: 0;
  }
}
</style>
