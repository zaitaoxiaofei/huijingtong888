<script setup>
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref } from "vue";
import { apiClient, currentApiCacheScope } from "../../utils/api.js";
import { shanghaiDateText } from "../../utils/shanghai-date.js";
import { buildDailyExchangeChart, exchangeChartKeyboardPoint, exchangeRateQuery, exchangeRateText, nearestExchangeChartPoint, preciseExchangeRateText } from "../../utils/exchange-rate-tool.js";

const props = defineProps({ embedded: { type: Boolean, default: false } });
const preset = ref("year"), dates = ref(null), data = ref(null), loading = ref(false), error = ref("");
const selectedDay = ref(null);
let requestId = 0, controller = null;
const market = computed(() => data.value?.public || null);
const today = computed(() => market.value?.today || null);
const chart = computed(() => buildDailyExchangeChart(market.value?.points || []));
const selectedPoint = computed(() => chart.value.points.find(point => point.business_date === selectedDay.value) || null);
const dateText = value => value ? shanghaiDateText(value) : "—";
function selectPointer(event) {
  const bounds = event.currentTarget.getBoundingClientRect();
  selectedDay.value = nearestExchangeChartPoint(chart.value, (event.clientX - bounds.left) * chart.value.width / bounds.width)?.business_date || null;
}
function leavePointer(event) { if (event.pointerType !== "touch") selectedDay.value = null; }
function selectKeyboard(event) {
  if (event.key === "Escape" && selectedDay.value) { event.stopPropagation(); selectedDay.value = null; return; }
  const point = exchangeChartKeyboardPoint(chart.value, selectedDay.value, event.key);
  if (point) { event.preventDefault(); selectedDay.value = point.business_date; }
}
function stopRequest() { requestId++; controller?.abort(); controller = null; loading.value = false; }
function clearScope() { stopRequest(); data.value = null; selectedDay.value = null; error.value = ""; }
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
  selectedDay.value = null;
  try {
    const result = await apiClient.get(url, { noCache: true, signal });
    if (id !== requestId || signal.aborted || scope !== currentApiCacheScope()) return;
    if (!result?.public || result.public.currency_from !== "CNY" || result.public.currency_to !== "RUB") throw new Error("汇率数据暂不可用，请稍后刷新");
    data.value = result;
  } catch (cause) {
    if (id !== requestId || signal.aborted) return;
    data.value = null;
    error.value = cause.message || "汇率加载失败，请稍后刷新";
  } finally { if (id === requestId) loading.value = false; }
}
function selectPreset() { dates.value = null; load(); }
onMounted(() => { window.addEventListener("erp:auth-scope-changed", clearScope); load(); });
onActivated(() => { if (!data.value && !loading.value) load(); });
onDeactivated(stopRequest);
onUnmounted(() => { stopRequest(); window.removeEventListener("erp:auth-scope-changed", clearScope); });
</script>

<template>
  <div class="exchange-rate-tool" :class="{ 'is-embedded': props.embedded }" v-loading="loading">
    <h2 v-if="!props.embedded">汇率工具</h2>
    <div class="exchange-rate-tool__toolbar">
      <div class="exchange-rate-tool__filters">
        <el-radio-group v-model="preset" size="small" aria-label="汇率查询时段" @change="selectPreset">
          <el-radio-button value="month">近一个月</el-radio-button><el-radio-button value="quarter">近一季度</el-radio-button><el-radio-button value="year">近一年</el-radio-button>
        </el-radio-group>
        <el-date-picker v-model="dates" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" size="small" :clearable="true" @change="load" />
        <el-button size="small" :loading="loading" @click="load">刷新</el-button>
      </div>
      <div v-if="market" class="exchange-rate-tool__reference">
        <span>今日参考汇率 · {{ dateText(today?.business_date) }}</span>
        <strong v-if="today?.available">1 元 = {{ exchangeRateText(today.rate_rub_per_cny ?? today.rate) }} 卢布</strong>
        <strong v-else>今日汇率待更新</strong>
        <small>俄罗斯央行 · {{ today?.available ? `来源日期 ${dateText(today.source_date)}` : '尚无可用的今日存档' }}</small>
      </div>
    </div>
    <el-alert v-if="error" class="exchange-rate-tool__notice" type="error" :title="error" :closable="false" show-icon />
    <section v-if="market" class="exchange-rate-tool__panel">
      <div class="exchange-rate-tool__section-heading"><h3>每日汇率走势</h3><span>{{ dateText(market.range?.from) }} 至 {{ dateText(market.range?.to) }} · 卢布 / 人民币</span></div>
      <div v-if="chart.points.length" class="exchange-rate-tool__chart">
        <div v-if="selectedPoint" class="exchange-rate-tool__tooltip" role="status" aria-live="polite"><strong>{{ dateText(selectedPoint.business_date) }}</strong><span>1 元 = {{ preciseExchangeRateText(selectedPoint.rate) }} 卢布</span><small>央行来源日期 {{ dateText(selectedPoint.source_date) }}</small></div>
        <div class="exchange-rate-tool__chart-scroll">
          <svg :viewBox="`0 0 ${chart.width} ${chart.height}`" role="img" tabindex="0" aria-label="每日人民币兑卢布参考汇率曲线；左右方向键查看日期，Home 和 End 查看首末日，Escape 关闭提示" @pointermove="selectPointer" @pointerdown="selectPointer" @pointerleave="leavePointer" @keydown="selectKeyboard" @blur="selectedDay = null">
            <g v-for="tick in chart.yTicks" :key="tick.label" class="exchange-rate-tool__grid"><line x1="68" x2="976" :y1="tick.y" :y2="tick.y" /><text x="58" :y="tick.y + 4" text-anchor="end">{{ tick.label }}</text></g>
            <line v-if="selectedPoint" :x1="selectedPoint.x" :x2="selectedPoint.x" y1="24" :y2="chart.height - 40" class="exchange-rate-tool__cursor" />
            <path v-for="(path, index) in chart.paths" :key="index" :d="path" class="exchange-rate-tool__line" />
            <circle v-for="point in chart.points" :key="point.business_date" :cx="point.x" :cy="point.y" :r="selectedDay === point.business_date ? 5 : chart.points.length < 4 ? 3 : 1.7" class="exchange-rate-tool__point" />
            <text v-for="tick in chart.xTicks" :key="tick.date" :x="tick.x" :y="chart.height - 14" :text-anchor="tick.x > 950 ? 'end' : tick.x < 80 ? 'start' : 'middle'" class="exchange-rate-tool__axis">{{ dateText(tick.date) }}</text>
          </svg>
        </div>
      </div>
      <el-empty v-else description="所选日期暂无可用汇率存档" :image-size="62" />
      <p class="exchange-rate-tool__hint">每日参考价，非分时行情。移动鼠标、点按曲线或使用左右方向键查看当日汇率<span v-if="market.coverage?.missing_days">；缺档 {{ market.coverage.missing_days }} 天已断开显示</span>。</p>
      <p class="exchange-rate-tool__hint">曲线上升表示每人民币可兑更多卢布；等额卢布收入折回人民币会减少。</p>
    </section>
    <el-empty v-else-if="!loading && !error" description="暂无汇率数据" :image-size="62" />
  </div>
</template>

<style scoped>
.exchange-rate-tool { max-width: 1200px; margin: 0 auto; padding: 20px; color: var(--erp-text-main); }
.exchange-rate-tool.is-embedded { max-width: none; margin: 0; padding: 0; }
.exchange-rate-tool__toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.exchange-rate-tool__filters { display: flex; flex: 1; align-items: center; flex-wrap: wrap; gap: 10px; padding-top: 4px; }
.exchange-rate-tool__filters :deep(.el-date-editor) { flex: 0 1 290px; width: 290px; max-width: 100%; }
.exchange-rate-tool__reference { display: grid; gap: 5px; flex: none; text-align: right; }
.exchange-rate-tool__reference > span, .exchange-rate-tool__reference > small { font-size: 12px; color: var(--erp-text-secondary); }
.exchange-rate-tool__reference > strong { font-size: 19px; color: var(--erp-primary); font-variant-numeric: tabular-nums; }
.exchange-rate-tool__notice { margin-top: 14px; }
.exchange-rate-tool__panel { margin-top: 18px; border: 1px solid var(--erp-border-light); border-radius: var(--erp-radius-lg); padding: 16px; background: var(--erp-card); }
.exchange-rate-tool__section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.exchange-rate-tool h3 { margin: 0; font-size: 14px; }
.exchange-rate-tool__section-heading > span, .exchange-rate-tool__hint { font-size: 12px; color: var(--erp-text-secondary); line-height: 1.7; }
.exchange-rate-tool__chart { position: relative; }
.exchange-rate-tool__chart-scroll { overflow-x: auto; }
.exchange-rate-tool__chart svg { display: block; width: 100%; height: auto; min-height: 260px; outline-offset: -2px; }
.exchange-rate-tool__chart svg:focus-visible { outline: 2px solid var(--erp-primary); }
.exchange-rate-tool__grid line { stroke: var(--erp-border-light); stroke-dasharray: 4 4; }
.exchange-rate-tool__grid text, .exchange-rate-tool__axis { fill: var(--erp-text-secondary); font-size: 11px; }
.exchange-rate-tool__line { stroke: var(--erp-primary); stroke-width: 2.2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.exchange-rate-tool__point { fill: var(--erp-primary); }
.exchange-rate-tool__cursor { stroke: var(--erp-primary-border); stroke-width: 1; stroke-dasharray: 4 4; }
.exchange-rate-tool__tooltip { position: absolute; right: 12px; top: 2px; z-index: 1; display: grid; gap: 5px; max-width: calc(100% - 24px); padding: 11px 14px; border: 1px solid var(--erp-primary-border); border-radius: var(--erp-radius); background: var(--erp-card); box-shadow: var(--erp-shadow-card); pointer-events: none; font-size: 13px; font-variant-numeric: tabular-nums; }
.exchange-rate-tool__tooltip > span { color: var(--erp-primary); }
.exchange-rate-tool__tooltip > small { color: var(--erp-text-secondary); font-size: 11px; }
.exchange-rate-tool__hint { margin: 10px 0 0; }
@media (max-width: 880px) { .exchange-rate-tool__toolbar { flex-wrap: wrap; } .exchange-rate-tool__reference { flex-basis: 100%; text-align: left; } }
@media (max-width: 580px) { .exchange-rate-tool__filters :deep(.el-date-editor) { flex-basis: 100%; width: 100%; } .exchange-rate-tool__panel { min-width: 0; padding: 12px; } .exchange-rate-tool__chart svg { min-width: 640px; } }
</style>
