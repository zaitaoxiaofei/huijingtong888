<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api";
import ProfitTrendChart from "../../components/profit/ProfitTrendChart.vue";
import { formatInteger, formatMoney, formatMonthLabel, formatShortDate } from "./profit-utils.js";

const router = useRouter();
const loading = ref(false);
const dashboard = ref({
  ranges: {},
  dailyTrend14: [],
  previousDailyTrend14: [],
  monthlyTrend12: []
});

let dashboardAbortController = null;
let dashboardLoadTimer = 0;

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

async function loadDashboard() {
  dashboardAbortController?.abort();
  dashboardAbortController = new AbortController();
  loading.value = true;
  try {
    dashboard.value = await apiClient.get("/api/profit-dashboard", {
      signal: dashboardAbortController.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") return;
    ElMessage.error(error.message || "利润看板加载失败");
  } finally {
    if (!dashboardAbortController?.signal?.aborted) {
      loading.value = false;
    }
  }
}

function openRanking(dimension) {
  router.push(dimension === "shop" ? "/profit/shop-ranking" : "/profit/sku-ranking");
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
    <el-card shadow="never" class="page-card profit-dashboard-hero-card">
      <div class="page-hero profit-dashboard-hero">
        <div>
          <h2>利润看板</h2>
          <p>重点看利润、营业额和上月同期变化，首屏信息尽量浓缩。</p>
        </div>
        <div class="page-card-actions">
          <el-button :loading="loading" @click="loadDashboard">刷新数据</el-button>
          <el-button type="primary" plain @click="openRanking('sku')">SKU 排行榜</el-button>
          <el-button type="primary" plain @click="openRanking('shop')">店铺排行榜</el-button>
        </div>
      </div>

      <div class="summary-strip">
        <div v-for="item in summaryHighlights" :key="item.label" class="summary-strip__item">
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
          <small>{{ item.suffix }}</small>
        </div>
      </div>
    </el-card>

    <el-row :gutter="16">
      <el-col :xs="24" :xl="12">
        <el-card shadow="never" class="page-card">
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
        </el-card>
      </el-col>

      <el-col :xs="24" :xl="12">
        <el-card shadow="never" class="page-card">
          <template #header>
            <div class="page-card-header">
              <div>
                <strong>核心汇总矩阵</strong>
                <span>今日、昨日、本月、上月、本季、本年集中查看。</span>
              </div>
            </div>
          </template>

          <div class="summary-matrix">
            <div class="summary-matrix__row summary-matrix__row--head">
              <span>指标</span>
              <span v-for="column in summaryColumns" :key="column.key">{{ column.label }}</span>
            </div>
            <div v-for="row in summaryRows" :key="row.label" class="summary-matrix__row">
              <strong>{{ row.label }}</strong>
              <span v-for="column in summaryColumns" :key="column.key">
                {{ row.formatter(row.values[column.key]) }}
                <small>{{ row.suffix }}</small>
              </span>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <el-col :xs="24" :xl="8">
        <el-card shadow="never" class="page-card">
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
        <el-card shadow="never" class="page-card">
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
        <el-card shadow="never" class="page-card">
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
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.profit-dashboard-hero { align-items: center; gap: 12px; }
.profit-dashboard-hero-card { padding-bottom: 8px; }
.summary-strip {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 10px;
}
.summary-strip__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border-radius: 10px;
  background: linear-gradient(180deg, rgba(248, 250, 252, 0.96), rgba(241, 245, 249, 0.92));
  border: 1px solid rgba(148, 163, 184, 0.16);
}
.summary-strip__item span,
.summary-strip__item small {
  color: #64748b;
  font-size: 12px;
}
.summary-strip__item strong {
  color: #0f172a;
  font-size: 18px;
}
.summary-matrix {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.summary-matrix__row {
  display: grid;
  grid-template-columns: 92px repeat(6, minmax(0, 1fr));
  gap: 8px;
  align-items: center;
}
.summary-matrix__row > span,
.summary-matrix__row > strong {
  padding: 9px 8px;
  border-radius: 10px;
  background: rgba(248, 250, 252, 0.9);
  border: 1px solid rgba(148, 163, 184, 0.16);
  color: #0f172a;
  font-size: 13px;
}
.summary-matrix__row > strong {
  text-align: center;
  background: rgba(241, 245, 249, 0.96);
}
.summary-matrix__row > span small {
  margin-left: 4px;
  color: #64748b;
  font-size: 11px;
}
.summary-matrix__row--head > span {
  background: transparent;
  border: 0;
  color: #64748b;
  font-weight: 600;
  padding: 0 8px 4px;
}
.summary-matrix__row--head > span:first-child {
  text-align: center;
}

@media (max-width: 1440px) {
  .summary-strip { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}

@media (max-width: 900px) {
  .summary-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .summary-matrix { overflow-x: auto; }
  .summary-matrix__row { min-width: 860px; }
}
</style>
