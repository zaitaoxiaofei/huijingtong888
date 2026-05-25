<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api";
import ProfitTrendChart from "../../components/profit/ProfitTrendChart.vue";
import ProfitRankingView from "./ProfitRankingView.vue";
import { formatInteger, formatMoney, formatMonthLabel, formatShortDate } from "./profit-utils.js";
import { shanghaiDateKey, shanghaiMonthStart } from "../../utils/shanghai-date";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const shops = ref([]);
const sectionLoading = ref({
  summary: false,
  dailyTrend: false,
  monthlyTrend: false,
  aftersales: false
});
const sectionErrors = ref({
  summary: "",
  dailyTrend: "",
  monthlyTrend: "",
  aftersales: ""
});
const dashboard = ref({
  ranges: {},
  dailyTrend14: [],
  previousDailyTrend14: [],
  monthlyTrend12: [],
  aftersales: {
    buckets: [],
    totals: {},
    missing_alert: {}
  }
});

let dashboardAbortController = null;
let aftersalesAbortController = null;
let dashboardLoadTimer = 0;

function todayText() {
  return shanghaiDateKey();
}

function monthStartText() {
  return shanghaiMonthStart();
}

function createAftersalesFilters() {
  return {
    from: monthStartText(),
    to: todayText(),
    shopId: "all"
  };
}

const aftersalesFilters = reactive(createAftersalesFilters());

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
      label: "退货金额",
      formatter: formatMoney,
      suffix: "CNY",
      values: Object.fromEntries(summaryColumns.map((column) => [column.key, getSummary(column.key).return_revenue]))
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

const currentAftersalesShopName = computed(() => {
  if (aftersalesFilters.shopId === "all") return "全部店铺";
  return shops.value.find((item) => String(item.id) === String(aftersalesFilters.shopId))?.name || "未知店铺";
});

const aftersalesRangeSummary = computed(() => `${aftersalesFilters.from || "--"} 至 ${aftersalesFilters.to || "--"}`);

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

function setSectionLoading(section, value) {
  sectionLoading.value = { ...sectionLoading.value, [section]: value };
}

function setSectionError(section, value) {
  sectionErrors.value = { ...sectionErrors.value, [section]: value };
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
    return;
  }
  if (section === "aftersales") {
    dashboard.value = {
      ...dashboard.value,
      aftersales: {
        buckets: payload?.buckets || [],
        totals: payload?.totals || {},
        missing_alert: payload?.missing_alert || {}
      }
    };
  }
}

function aftersalesQueryString() {
  const params = new URLSearchParams({
    from: aftersalesFilters.from || "",
    to: aftersalesFilters.to || "",
    shopId: aftersalesFilters.shopId || "all"
  });
  return params.toString();
}

function validateAftersalesFilters() {
  if (aftersalesFilters.from && aftersalesFilters.to && aftersalesFilters.from > aftersalesFilters.to) {
    ElMessage.warning("开始日期不能晚于结束日期");
    return false;
  }
  return true;
}

async function loadShops() {
  if (shops.value.length) return;
  const payload = await apiClient.get("/api/shops");
  shops.value = Array.isArray(payload?.rows) ? payload.rows : Array.isArray(payload) ? payload : [];
}

async function loadDashboardSection(section, signal) {
  setSectionLoading(section, true);
  setSectionError(section, "");
  try {
    const payload = section === "aftersales"
      ? await apiClient.get(`/api/profit-aftersales?${aftersalesQueryString()}`, { signal })
      : await apiClient.get(`/api/profit-dashboard?section=${encodeURIComponent(section)}`, { signal });
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

async function loadAftersalesCard() {
  if (!validateAftersalesFilters()) return;
  aftersalesAbortController?.abort();
  aftersalesAbortController = new AbortController();
  await loadDashboardSection("aftersales", aftersalesAbortController.signal);
}

async function loadDashboard() {
  if (!validateAftersalesFilters()) return;
  aftersalesAbortController?.abort();
  dashboardAbortController?.abort();
  dashboardAbortController = new AbortController();
  const { signal } = dashboardAbortController;
  loading.value = true;
  const jobs = [
    loadDashboardSection("summary", signal),
    loadDashboardSection("daily-trend", signal),
    loadDashboardSection("monthly-trend", signal),
    loadDashboardSection("aftersales", signal)
  ];
  const results = await Promise.allSettled(jobs);
  if (signal.aborted) return;
  const failures = results.filter((item) => item.status === "rejected");
  if (failures.length) {
    ElMessage.warning(`利润看板有 ${failures.length} 个区块加载失败，其余区块已显示`);
  }
  loading.value = false;
}

function handleViewChange(target) {
  if (target && target !== route.path) router.push(target);
}

function resetAftersalesFilters() {
  Object.assign(aftersalesFilters, createAftersalesFilters());
  loadAftersalesCard();
}

function openAftersalesPage() {
  router.push({
    path: "/profit/aftersales",
    query: {
      from: aftersalesFilters.from || undefined,
      to: aftersalesFilters.to || undefined,
      shopId: aftersalesFilters.shopId !== "all" ? aftersalesFilters.shopId : undefined
    }
  });
}

onMounted(() => {
  dashboardLoadTimer = window.setTimeout(() => {
    Promise.allSettled([loadShops(), loadDashboard()]).then((results) => {
      if (results[0]?.status === "rejected") {
        ElMessage.error(results[0].reason?.message || "店铺列表加载失败");
      }
    });
  }, 0);
});

onBeforeUnmount(() => {
  if (dashboardLoadTimer) window.clearTimeout(dashboardLoadTimer);
  dashboardAbortController?.abort();
  aftersalesAbortController?.abort();
});
</script>

<template>
  <div class="page-stack profit-dashboard-page">
    <div class="profit-view-switch-bar">
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
          <el-button v-if="isDashboardView" :loading="loading" @click="loadDashboard">刷新数据</el-button>
          <el-button v-if="isDashboardView" type="warning" plain @click="openAftersalesPage">售后损失</el-button>
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
    <el-row :gutter="16">
      <el-col :xs="24" :xl="12" class="profit-trend-col">
        <el-card shadow="never" class="page-card" v-loading="sectionLoading.dailyTrend">
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
        <el-card shadow="never" class="page-card" v-loading="sectionLoading.summary">
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

    <el-card shadow="never" class="page-card" v-loading="sectionLoading.aftersales">
      <template #header>
        <div class="page-card-header">
          <div>
            <strong>售后损失分类</strong>
            <span>取消、拒收、错发破损、质量问题和平台/证件问题分开统计。</span>
          </div>
        </div>
      </template>

      <div class="profit-aftersales-toolbar">
        <el-form inline @submit.prevent>
          <el-form-item label="开始日期">
            <el-date-picker
              v-model="aftersalesFilters.from"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="开始日期"
              style="width: 160px"
            />
          </el-form-item>
          <el-form-item label="结束日期">
            <el-date-picker
              v-model="aftersalesFilters.to"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="结束日期"
              style="width: 160px"
            />
          </el-form-item>
          <el-form-item label="店铺">
            <el-select v-model="aftersalesFilters.shopId" style="width: 180px">
              <el-option label="全部店铺" value="all" />
              <el-option v-for="shop in shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="sectionLoading.aftersales" @click="loadAftersalesCard">查询</el-button>
            <el-button @click="resetAftersalesFilters">重置</el-button>
          </el-form-item>
        </el-form>
        <div class="profit-aftersales-summary">
          <span>时间段：{{ aftersalesRangeSummary }}</span>
          <span>店铺：{{ currentAftersalesShopName }}</span>
        </div>
      </div>

      <el-alert
        v-if="dashboard.aftersales?.missing_alert?.message"
        class="profit-aftersale-alert"
        type="warning"
        :closable="false"
        :title="dashboard.aftersales.missing_alert.message"
      />

      <div class="profit-summary-table-wrap">
        <table class="profit-summary-table profit-aftersale-table">
          <thead>
            <tr>
              <th>类型</th>
              <th>订单数</th>
              <th>件数</th>
              <th>涉及销售额</th>
              <th>估算损失</th>
              <th>已入账损失</th>
              <th>成本缺失</th>
              <th>运费缺失</th>
              <th>待核实</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in dashboard.aftersales.buckets" :key="row.key">
              <th>
                <strong>{{ row.label }}</strong>
                <small>{{ row.loss_policy }}</small>
              </th>
              <td><strong>{{ formatInteger(row.order_count) }}</strong><small>单</small></td>
              <td><strong>{{ formatInteger(row.item_quantity) }}</strong><small>件</small></td>
              <td><strong>{{ formatMoney(row.sale_amount_cny) }}</strong><small>CNY</small></td>
              <td><strong>{{ formatMoney(row.estimated_loss_cny) }}</strong><small>CNY</small></td>
              <td><strong>{{ formatMoney(row.actual_loss_cny) }}</strong><small>CNY</small></td>
              <td :class="{ 'aftersale-warning-cell': row.missing_cost_count > 0 }">
                <strong>{{ formatInteger(row.missing_cost_count) }}</strong><small>项</small>
              </td>
              <td :class="{ 'aftersale-warning-cell': row.missing_shipping_count > 0 }">
                <strong>{{ formatInteger(row.missing_shipping_count) }}</strong><small>项</small>
              </td>
              <td :class="{ 'aftersale-warning-cell': row.needs_review_count > 0 }">
                <strong>{{ formatInteger(row.needs_review_count) }}</strong><small>项</small>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <th>合计</th>
              <td><strong>{{ formatInteger(dashboard.aftersales.totals?.order_count) }}</strong><small>单</small></td>
              <td><strong>{{ formatInteger(dashboard.aftersales.totals?.item_quantity) }}</strong><small>件</small></td>
              <td><strong>{{ formatMoney(dashboard.aftersales.totals?.sale_amount_cny) }}</strong><small>CNY</small></td>
              <td><strong>{{ formatMoney(dashboard.aftersales.totals?.estimated_loss_cny) }}</strong><small>CNY</small></td>
              <td><strong>{{ formatMoney(dashboard.aftersales.totals?.actual_loss_cny) }}</strong><small>CNY</small></td>
              <td><strong>{{ formatInteger(dashboard.aftersales.totals?.missing_cost_count) }}</strong><small>项</small></td>
              <td><strong>{{ formatInteger(dashboard.aftersales.totals?.missing_shipping_count) }}</strong><small>项</small></td>
              <td><strong>{{ formatInteger(dashboard.aftersales.totals?.needs_review_count) }}</strong><small>项</small></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div v-if="sectionErrors.aftersales" class="profit-dashboard-section-error">{{ sectionErrors.aftersales }}</div>
    </el-card>

    <el-row :gutter="16">
      <el-col :xs="24" :xl="8">
        <el-card shadow="never" class="page-card" v-loading="sectionLoading.monthlyTrend">
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
        <el-card shadow="never" class="page-card" v-loading="sectionLoading.monthlyTrend">
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
        <el-card shadow="never" class="page-card" v-loading="sectionLoading.monthlyTrend">
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
.profit-dashboard-hero { align-items: center; gap: 12px; }
.profit-dashboard-hero-card { padding-bottom: 8px; }
.profit-view-switch-bar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  min-height: 32px;
}
.profit-matrix-col { order: 1; }
.profit-trend-col { order: 2; }
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

.profit-aftersale-alert {
  margin-bottom: 12px;
}

.profit-aftersales-toolbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.profit-aftersales-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  color: #64748b;
  font-size: 12px;
}

.profit-aftersale-table th:first-child {
  min-width: 180px;
}

.profit-aftersale-table th strong,
.profit-aftersale-table th small {
  display: block;
}

.profit-aftersale-table th small {
  margin-top: 4px;
  color: #64748b;
  font-weight: 500;
  white-space: normal;
}

.profit-aftersale-table tfoot th,
.profit-aftersale-table tfoot td {
  background: #f8fafc;
  border-top: 1px solid #cbd5e1;
}

.aftersale-warning-cell strong {
  color: #b45309;
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

:global(:root[data-theme="dark"] .profit-aftersale-table tfoot th),
:global(:root[data-theme="dark"] .profit-aftersale-table tfoot td) {
  background: #0f172a;
  border-top-color: #334155;
}

@media (max-width: 780px) {
  .profit-aftersales-summary {
    flex-direction: column;
    gap: 6px;
  }
}
</style>
