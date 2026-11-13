<script setup>
import { computed, ref } from 'vue';
import { dashboardTrendRows, dashboardTrendGeometry } from '../utils/dashboard-trend.js';
const props = defineProps({ rows: { type: Array, default: () => [] }, date: String, financial: Boolean });
const days = ref(7), activeDate = ref('');
const points = computed(() => dashboardTrendRows(props.rows, props.date, days.value));
const chart = computed(() => dashboardTrendGeometry(points.value, props.financial));
const selected = computed(() => points.value.find(row => row.date_key === activeDate.value) || points.value.at(-1) || {});
const money = n => n == null ? '—' : `CNY ${Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
const axisMoney = n => Math.abs(n) >= 10000 ? `${(n / 10000).toFixed(1)}万` : Math.round(n).toLocaleString('zh-CN');
function hover(event) {
 const box = event.currentTarget.getBoundingClientRect();
 const point = Math.round(Math.max(0, Math.min(1, (event.clientX - box.left - box.width * 58 / 710) / (box.width * 630 / 710))) * (points.value.length - 1));
 activeDate.value = points.value[point]?.date_key || '';
}
</script>
<template>
 <section class="overview-panel dashboard-performance" aria-label="经营趋势">
  <header><div><span>Business Performance</span><h2>经营趋势</h2></div><div class="performance-controls"><div class="performance-period" role="group" aria-label="趋势时间范围"><button type="button" :aria-pressed="days===7" @click="days=7">近7天</button><button type="button" :aria-pressed="days===30" @click="days=30">近30天</button></div><select v-model="activeDate" aria-label="查看某日趋势"><option value="">{{date}}（所选日）</option><option v-for="row in points" :key="row.date_key" :value="row.date_key">{{row.date_key}}</option></select></div></header>
  <div class="performance-values" aria-live="polite"><span>{{selected.date_key}}</span><span><i class="revenue-key"/>有效营业额 <b>{{money(selected.revenue)}}</b></span><span v-if="financial"><i class="profit-key"/>利润 <b>{{money(selected.profit)}}</b></span></div>
  <svg v-if="chart.hasData" viewBox="0 0 710 140" preserveAspectRatio="none" role="img" :aria-label="financial?'有效营业额与利润趋势，金额人民币':'有效营业额趋势，金额人民币'" @pointermove="hover">
   <g v-for="(tick,i) in [chart.max,(chart.min+chart.max)/2,chart.min]" :key="i"><line x1="58" x2="688" :y1="17+i*49" :y2="17+i*49"/><text x="48" :y="21+i*49" text-anchor="end">{{axisMoney(tick)}}</text></g>
   <path :d="chart.paths.revenue" class="revenue-line" fill="none"/>
   <path v-if="financial" :d="chart.paths.profit" class="profit-line" fill="none"/>
   <template v-for="(row,i) in points" :key="row.date_key"><circle v-if="chart.value(row.revenue)!==null" :cx="chart.x(i)" :cy="chart.y(Number(row.revenue))" r="2.4" class="revenue-dot"/><circle v-if="financial&&chart.value(row.profit)!==null" :cx="chart.x(i)" :cy="chart.y(Number(row.profit))" r="2.4" class="profit-dot"/></template>
   <text x="58" y="136">{{points[0]?.date_key.slice(5)}}</text><text x="373" y="136" text-anchor="middle">{{points[Math.floor(points.length/2)]?.date_key.slice(5)}}</text><text x="688" y="136" text-anchor="end">{{date?.slice(5)}}</text>
  </svg>
  <div v-else class="performance-empty">所选时段暂无可用趋势数据</div>
 </section>
</template>
<style scoped>
.dashboard-performance{min-height:230px;box-sizing:border-box}.dashboard-performance header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.dashboard-performance header>div>span{font-size:11px;color:var(--el-text-color-secondary)}.dashboard-performance h2{font-size:16px;margin:3px 0 0}.performance-controls,.performance-period{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.performance-controls select,.performance-period button{font:inherit;font-size:12px;background:var(--el-bg-color);color:var(--el-text-color-regular);border:1px solid var(--el-border-color-light);border-radius:6px;padding:5px 8px}.performance-period button{cursor:pointer}.performance-period button[aria-pressed=true]{color:var(--el-color-primary, #8ab7ff);background:var(--el-color-primary-light-9);border-color:var(--el-color-primary-light-7)}.performance-values{display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--el-text-color-secondary);margin:10px 0 4px}.performance-values b{color:var(--el-text-color-primary);font-weight:500;font-variant-numeric:tabular-nums}.performance-values i{display:inline-block;width:12px;height:3px;vertical-align:middle;margin-right:4px}.revenue-key{background:var(--el-color-primary, #8ab7ff)}.profit-key{background:var(--el-color-success)}.dashboard-performance svg{display:block;width:100%;height:140px;overflow:visible}.dashboard-performance svg line{stroke:var(--el-border-color-lighter);stroke-width:1}.dashboard-performance svg text{fill:var(--el-text-color-secondary);font-size:11px}.dashboard-performance path{stroke-width:2;vector-effect:non-scaling-stroke}.revenue-line{stroke:var(--el-color-primary, #8ab7ff)}.profit-line{stroke:var(--el-color-success)}.revenue-dot{fill:var(--el-color-primary, #8ab7ff)}.profit-dot{fill:var(--el-color-success)}.performance-empty{min-height:140px;display:grid;place-items:center;color:var(--el-text-color-secondary);font-size:12px}@media(max-width:600px){.dashboard-performance{min-height:250px}.performance-values{gap:7px 12px;font-size:11px}.performance-controls select{max-width:155px;min-height:36px}.performance-period button{min-height:36px}.dashboard-performance header{align-items:flex-start}.performance-controls{width:100%;justify-content:space-between}.dashboard-performance svg{height:130px}}
</style>
