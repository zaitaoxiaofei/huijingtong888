<script setup>
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref } from "vue";
import { apiClient, currentApiCacheScope } from "../../utils/api.js";
import { shanghaiDateText, shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import { buildDailyExchangeChart, exchangeForecastAmount, exchangeImpactMoney, exchangeImpactTone, exchangeRateQuery, exchangeRateReasonText, exchangeRateText } from "../../utils/exchange-rate-tool.js";

const props = defineProps({ embedded: { type: Boolean, default: false } });
const preset = ref("year"), dates = ref(null), data = ref(null), loading = ref(false), error = ref("");
const tablePage = ref(1);
let requestId = 0, controller = null;
const market = computed(() => data.value?.public || null);
const today = computed(() => market.value?.today || null);
const impact = computed(() => data.value?.month_impact || null);
const forecastAmount = computed(() => exchangeForecastAmount(impact.value?.open));
const chart = computed(() => buildDailyExchangeChart(market.value?.points || []));
const dailyRows = computed(() => [...(market.value?.points || [])].sort((a, b) => String(b.business_date).localeCompare(String(a.business_date))));
const pageRows = computed(() => dailyRows.value.slice((tablePage.value - 1) * 15, tablePage.value * 15));
const realizedReasons = computed(() => reasonTexts(impact.value?.realized?.reasons));
const openReasons = computed(() => reasonTexts(impact.value?.open?.reasons));
const dateText = value => value ? shanghaiDateText(value) : "—";
const dateTimeText = value => value ? shanghaiDateTimeText(value, { assumeUtcWhenNaive: true }) : "—";
function reasonTexts(reasons) {
  return [...new Set((Array.isArray(reasons) ? reasons : []).map(reason => exchangeRateReasonText(typeof reason === "string" ? reason : reason?.code)))].join("；");
}
function stopRequest() {
  requestId += 1;
  controller?.abort();
  controller = null;
  loading.value = false;
}
function clearScope() {
  stopRequest();
  data.value = null;
  error.value = "";
}
async function load() {
  let url;
  try { url = exchangeRateQuery(preset.value, dates.value); }
  catch (cause) { error.value = cause.message; return; }
  const scope = currentApiCacheScope();
  stopRequest();
  const id = requestId;
  controller = new AbortController();
  const signal = controller.signal;
  loading.value = true;
  error.value = "";
  try {
    const result = await apiClient.get(url, { noCache: true, signal });
    if (id !== requestId || signal.aborted || scope !== currentApiCacheScope()) return;
    if (!result?.public || result.public.currency_from !== "CNY" || result.public.currency_to !== "RUB") throw new Error("汇率数据暂不可用，请稍后刷新");
    data.value = result;
    tablePage.value = 1;
  } catch (cause) {
    if (id !== requestId || signal.aborted) return;
    data.value = null;
    error.value = cause.message || "汇率加载失败，请稍后刷新";
  } finally {
    if (id === requestId) loading.value = false;
  }
}
function selectPreset() { dates.value = null; load(); }
onMounted(() => { window.addEventListener("erp:auth-scope-changed", clearScope); load(); });
onActivated(() => { if (!data.value && !loading.value) load(); });
onDeactivated(stopRequest);
onUnmounted(() => { stopRequest(); window.removeEventListener("erp:auth-scope-changed", clearScope); });
</script>

<template>
  <div class="exchange-rate-tool" :class="{ 'is-embedded': props.embedded }" v-loading="loading">
    <h2 v-if="!props.embedded">汇率与汇差</h2>
    <div class="exchange-rate-tool__filters">
      <el-radio-group v-model="preset" size="small" aria-label="汇率查询时段" @change="selectPreset">
        <el-radio-button value="month">近一月</el-radio-button>
        <el-radio-button value="quarter">近一季度</el-radio-button>
        <el-radio-button value="year">近一年</el-radio-button>
      </el-radio-group>
      <el-date-picker v-model="dates" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" size="small" :clearable="true" @change="load" />
      <el-button size="small" :loading="loading" @click="load">刷新</el-button>
      <span class="exchange-rate-tool__hint">北京时间 · 每日参考价</span>
    </div>
    <el-alert v-if="error" class="exchange-rate-tool__notice" type="error" :title="error" :closable="false" show-icon />
    <template v-if="market">
      <div class="exchange-rate-tool__overview">
        <section class="exchange-rate-tool__reference">
          <span>今日参考汇率 · {{ dateText(today?.business_date) }}</span>
          <strong v-if="today?.available">1 元 = {{ exchangeRateText(today.rate_rub_per_cny ?? today.rate) }} 卢布</strong>
          <strong v-else>{{ today?.reason && today.reason !== 'TODAY_ARCHIVE_MISSING' ? '今日汇率待核对' : '今日尚未存档' }}</strong>
          <span v-if="today?.available">1 卢布 = {{ exchangeRateText(today.rate_cny_per_rub, 6) }} 元</span>
          <small v-if="today?.available">俄罗斯央行 · 来源日期 {{ dateText(today.source_date) }} · 存档 #{{ today.archive_id ?? '待补齐' }}</small>
          <template v-if="!today?.available">
            <small v-if="today?.reason && today.reason !== 'TODAY_ARCHIVE_MISSING'">{{ exchangeRateReasonText(today.reason) }}</small>
            <small v-if="market.latest">最近可用：{{ dateText(market.latest.business_date) }}，1 元 = {{ exchangeRateText(market.latest.rate_rub_per_cny ?? market.latest.rate) }} 卢布；未替代今日汇率。</small>
            <small v-else>当前尚无可用的汇率存档，请稍后刷新。</small>
          </template>
        </section>
        <section class="exchange-rate-tool__basis">
          <strong>每日归档，可追溯</strong>
          <p>每日曲线记录人民币兑卢布的参考价，不代表日内实时行情。周末及休市日可能沿用最近公布的央行报价，来源日期会单独保留。</p>
          <small>读取时间：{{ dateTimeText(data.as_of) }}</small>
        </section>
      </div>
      <section class="exchange-rate-tool__panel">
        <div class="exchange-rate-tool__section-heading"><h3>每日汇率走势</h3><span>{{ dateText(market.range?.from) }} 至 {{ dateText(market.range?.to) }} · 卢布 / 人民币</span></div>
        <div v-if="chart.points.length" class="exchange-rate-tool__chart">
          <svg :viewBox="`0 0 ${chart.width} ${chart.height}`" role="img" aria-label="每日人民币兑卢布参考汇率折线图，缺失日期断开显示">
            <g v-for="tick in chart.yTicks" :key="tick.label" class="exchange-rate-tool__grid">
              <line x1="68" x2="976" :y1="tick.y" :y2="tick.y" />
              <text x="58" :y="tick.y + 4" text-anchor="end">{{ tick.label }}</text>
            </g>
            <path v-for="(path, index) in chart.paths" :key="index" :d="path" class="exchange-rate-tool__line" />
            <circle v-for="point in chart.points" :key="point.business_date" :cx="point.x" :cy="point.y" :r="chart.points.length < 4 ? 3 : 1.7" class="exchange-rate-tool__point"><title>{{ dateText(point.business_date) }}：1 元 = {{ exchangeRateText(point.rate) }} 卢布；来源 {{ dateText(point.source_date) }}；存档 #{{ point.archive_id ?? '待补齐' }}</title></circle>
            <text v-for="tick in chart.xTicks" :key="tick.date" :x="tick.x" y="246" :text-anchor="tick.x > 950 ? 'end' : tick.x < 80 ? 'start' : 'middle'" class="exchange-rate-tool__axis">{{ dateText(tick.date) }}</text>
          </svg>
        </div>
        <el-empty v-else description="所选日期暂无可用汇率存档" :image-size="62" />
        <p class="exchange-rate-tool__hint">已存档 {{ market.coverage?.available_days ?? 0 }} / {{ market.coverage?.expected_days ?? 0 }} 天<span v-if="market.coverage?.missing_days">，缺少 {{ market.coverage.missing_days }} 天，曲线已断开显示</span><span v-if="market.coverage?.invalid_days">；{{ market.coverage.invalid_days }} 天的存档待核对</span>。订单历史汇率保持冻结。</p>
        <p class="exchange-rate-tool__hint">曲线上升表示每人民币可兑更多卢布；等额卢布收入折回人民币会减少。</p>
      </section>
      <section class="exchange-rate-tool__panel">
        <div class="exchange-rate-tool__section-heading"><h3>汇率对经营的影响</h3><span>金额均为人民币</span></div>
        <el-alert v-if="!impact" type="info" title="当前账号可查看公共参考汇率。企业汇差涉及财务数据，仅向有财务权限的成员开放。" :closable="false" show-icon />
        <template v-else>
          <div class="exchange-rate-tool__impact-grid">
            <article class="exchange-rate-tool__impact-card">
              <h4>本月已结算真实汇差</h4>
              <strong :class="`is-${exchangeImpactTone(impact.realized?.amount_cny)}`">{{ impact.realized?.eligible_items === 0 ? '暂无新规则结算' : exchangeImpactMoney(impact.realized?.amount_cny) }}</strong>
              <p>本月 {{ impact.month }}，按同一笔实际原币净额，对比签收汇率与下单汇率。正数为汇兑收益，负数为汇兑损失。</p>
              <small>已计入 {{ impact.realized?.included_items ?? 0 }} / {{ impact.realized?.eligible_items ?? 0 }} 项<span v-if="impact.realized?.pending_items"> · {{ impact.realized.pending_items }} 项待核对</span><span v-if="impact.realized?.excluded_items"> · {{ impact.realized.excluded_items }} 项未计入</span></small>
              <p v-if="realizedReasons" class="exchange-rate-tool__pending">{{ realizedReasons }}</p>
              <p v-else-if="impact.realized?.coverage_complete === false" class="exchange-rate-tool__pending">当前结果未覆盖全部订单，缺少依据的项目未按零处理。</p>
            </article>
            <article class="exchange-rate-tool__impact-card">
              <h4>待签收预计销售收入汇差（参考估算）</h4>
              <strong :class="`is-${exchangeImpactTone(forecastAmount)}`">{{ impact.open?.eligible_items === 0 ? '暂无适用订单' : exchangeImpactMoney(forecastAmount) }}</strong>
              <small v-if="impact.open?.coverage_complete === false && forecastAmount != null">已知部分，尚未覆盖全部待签收订单</small>
              <p>人民币标价按下单日汇率估算卢布参考收入，再按今日汇率比较；不含费用，不是官方结算金额。</p>
              <p>覆盖当前待签收的新规则订单，包含跨月存量；已确认卢布收入直接按原币金额比较。</p>
              <small v-if="impact.open?.reference_cny_items != null || impact.open?.confirmed_rub_items != null">人民币参考估算 {{ impact.open.reference_cny_items ?? 0 }} 项 · 已确认卢布收入 {{ impact.open.confirmed_rub_items ?? 0 }} 项</small>
              <small>已计入 {{ impact.open?.included_items ?? 0 }} / {{ impact.open?.eligible_items ?? 0 }} 项<span v-if="impact.open?.pending_items"> · {{ impact.open.pending_items }} 项待核对</span><span v-if="impact.open?.excluded_items"> · {{ impact.open.excluded_items }} 项未计入</span></small>
              <p v-if="openReasons" class="exchange-rate-tool__pending">{{ openReasons }}</p>
              <p v-else-if="impact.open?.coverage_complete === false" class="exchange-rate-tool__pending">当前结果未覆盖全部待签收订单，缺少依据的项目未按零处理。</p>
            </article>
          </div>
          <p class="exchange-rate-tool__hint">两项分别反映已结算结果与待签收收入风险，不合并为总损益。旧规则订单不追溯改算<span v-if="impact.excluded?.legacy_items">，另有 {{ impact.excluded.legacy_items }} 项旧规则订单未纳入汇差统计</span>。</p>
        </template>
      </section>
      <section class="exchange-rate-tool__panel">
        <div class="exchange-rate-tool__section-heading"><h3>每日记录</h3><span>按日期倒序 · 可查报价来源和存档编号</span></div>
        <el-table :data="pageRows" size="small" stripe empty-text="所选日期暂无记录" class="exchange-rate-tool__table">
          <el-table-column label="归档日期（北京时间）" min-width="170"><template #default="{ row }">{{ dateText(row.business_date) }}</template></el-table-column>
          <el-table-column label="1 人民币兑卢布" min-width="140" align="right"><template #default="{ row }">{{ exchangeRateText(row.rate_rub_per_cny ?? row.rate) }}</template></el-table-column>
          <el-table-column label="1 卢布兑人民币" min-width="140" align="right"><template #default="{ row }">{{ exchangeRateText(row.rate_cny_per_rub, 6) }}</template></el-table-column>
          <el-table-column label="央行来源日期" min-width="125"><template #default="{ row }">{{ dateText(row.source_date) }}</template></el-table-column>
          <el-table-column label="存档编号" min-width="105"><template #default="{ row }"><span v-if="row.archive_id != null">#{{ row.archive_id }}</span><span v-else>尚未存档</span></template></el-table-column>
        </el-table>
        <el-pagination v-if="dailyRows.length > 15" v-model:current-page="tablePage" :page-size="15" :total="dailyRows.length" layout="total, prev, pager, next" small class="exchange-rate-tool__pagination" />
      </section>
    </template>
    <el-empty v-else-if="!loading && !error" description="暂无汇率数据" :image-size="62" />
  </div>
</template>

<style scoped>
.exchange-rate-tool { max-width: 1200px; margin: 0 auto; padding: 20px; color: var(--erp-text-main); }
.exchange-rate-tool.is-embedded { max-width: none; margin: 0; padding: 0; }
.exchange-rate-tool__filters { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.exchange-rate-tool__filters :deep(.el-date-editor) { flex: 0 1 300px; width: 300px; max-width: 100%; }
.exchange-rate-tool__notice { margin-top: 14px; }
.exchange-rate-tool__overview { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 16px; }
.exchange-rate-tool__reference, .exchange-rate-tool__basis, .exchange-rate-tool__panel { border: 1px solid var(--erp-border-light); border-radius: var(--erp-radius-lg); padding: 16px; background: var(--erp-card); }
.exchange-rate-tool__reference { display: flex; flex-direction: column; gap: 9px; background: var(--erp-primary-faint); border-color: var(--erp-primary-border); }
.exchange-rate-tool__reference > strong { font-size: 25px; line-height: 1.4; color: var(--erp-primary); font-variant-numeric: tabular-nums; }
.exchange-rate-tool__reference > span, .exchange-rate-tool__basis p { font-size: 13px; color: var(--erp-text-regular); }
.exchange-rate-tool__reference small, .exchange-rate-tool__basis small, .exchange-rate-tool__hint, .exchange-rate-tool__section-heading > span { color: var(--erp-text-secondary); font-size: 12px; line-height: 1.7; }
.exchange-rate-tool__basis p { line-height: 1.8; margin: 10px 0; }
.exchange-rate-tool__panel { margin-top: 14px; }
.exchange-rate-tool__section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.exchange-rate-tool h3, .exchange-rate-tool h4 { margin: 0; font-size: 14px; }
.exchange-rate-tool__chart svg { display: block; width: 100%; height: auto; min-height: 160px; }
.exchange-rate-tool__grid line { stroke: var(--erp-border-light); stroke-dasharray: 4 4; }
.exchange-rate-tool__grid text, .exchange-rate-tool__axis { fill: var(--erp-text-secondary); font-size: 11px; }
.exchange-rate-tool__line { stroke: var(--erp-primary); stroke-width: 2.2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.exchange-rate-tool__point { fill: var(--erp-primary); }
.exchange-rate-tool__impact-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.exchange-rate-tool__impact-card { border: 1px solid var(--erp-border-light); border-radius: var(--erp-radius); padding: 16px; }
.exchange-rate-tool__impact-card > strong { display: block; margin-top: 14px; font-size: 28px; font-variant-numeric: tabular-nums; }
.exchange-rate-tool__impact-card > p { font-size: 12px; line-height: 1.8; color: var(--erp-text-regular); }
.exchange-rate-tool__impact-card > small { font-size: 12px; color: var(--erp-text-secondary); }
.exchange-rate-tool__impact-card .is-positive { color: var(--erp-success-text); }
.exchange-rate-tool__impact-card .is-negative { color: var(--erp-danger-text); }
.exchange-rate-tool__impact-card .is-neutral { color: var(--erp-text-main); }
.exchange-rate-tool__impact-card .exchange-rate-tool__pending { color: var(--erp-warning-text); margin-bottom: 0; }
.exchange-rate-tool__pagination { justify-content: flex-end; margin-top: 12px; }
.exchange-rate-tool__table { width: 100%; font-variant-numeric: tabular-nums; }
@media (max-width: 680px) {
  .exchange-rate-tool__overview, .exchange-rate-tool__impact-grid { grid-template-columns: minmax(0, 1fr); }
  .exchange-rate-tool__filters :deep(.el-date-editor) { flex-basis: 100%; width: 100%; }
  .exchange-rate-tool__reference > strong { font-size: 21px; }
  .exchange-rate-tool__reference, .exchange-rate-tool__basis, .exchange-rate-tool__panel { min-width: 0; padding: 12px; }
  .exchange-rate-tool__chart { overflow-x: auto; }
  .exchange-rate-tool__chart svg { min-width: 560px; }
}
</style>
