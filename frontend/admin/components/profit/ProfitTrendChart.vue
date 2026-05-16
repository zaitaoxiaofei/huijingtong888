<script setup>
import { computed, ref } from "vue";

const props = defineProps({
  rows: { type: Array, default: () => [] },
  compareRows: { type: Array, default: () => [] },
  xKey: { type: String, default: "date_key" },
  title: { type: String, default: "" },
  subtitle: { type: String, default: "" },
  labelFormatter: { type: Function, default: (value) => String(value || "") },
  moneyFormatter: { type: Function, default: (value) => Number(value || 0).toFixed(2) },
  countFormatter: { type: Function, default: (value) => Number(value || 0).toLocaleString("zh-CN") },
  seriesDefs: {
    type: Array,
    default: () => ([
      { key: "profit", label: "利润", color: "#2563eb", axis: "money" },
      { key: "revenue", label: "营业额", color: "#0f766e", axis: "money" }
    ])
  },
  compareSeriesDefs: {
    type: Array,
    default: () => []
  },
  showCompareToggle: { type: Boolean, default: true },
  chartHeight: { type: Number, default: 280 },
  tooltipMode: { type: String, default: "full" },
  tooltipWidth: { type: Number, default: 280 }
});

const hoverIndex = ref(-1);
const compareVisible = ref(true);

const viewWidth = 760;
const padding = { top: 16, right: 56, bottom: 42, left: 56 };

function numeric(value) {
  return Number(value || 0);
}

const normalizedRows = computed(() => (
  (props.rows || []).map((row, index) => ({
    index,
    raw: row,
    x: row?.[props.xKey]
  }))
));

const normalizedCompareRows = computed(() => (
  (props.compareRows || []).map((row, index) => ({
    index,
    raw: row,
    x: row?.[props.xKey]
  }))
));

const allSeriesDefs = computed(() => {
  const compareDefs = compareVisible.value ? props.compareSeriesDefs : [];
  return [...props.seriesDefs, ...compareDefs];
});

const hasCountAxis = computed(() => allSeriesDefs.value.some((item) => item.axis === "count"));
const hasCompare = computed(() => props.compareSeriesDefs.length > 0 && normalizedCompareRows.value.length > 0);

function buildAxisRange(values) {
  if (!values.length) return { min: 0, max: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    const base = Math.abs(max) || 1;
    return { min: Math.min(0, min - base * 0.2), max: max + base * 0.2 };
  }
  const paddingValue = (max - min) * 0.12;
  return { min: Math.min(0, min - paddingValue), max: max + paddingValue };
}

function collectValues(defs, sourceRows) {
  const values = [];
  for (const row of sourceRows) {
    for (const def of defs) {
      values.push(numeric(row.raw?.[def.key]));
    }
  }
  return values;
}

const moneyRange = computed(() => buildAxisRange([
  ...collectValues(props.seriesDefs.filter((item) => item.axis === "money"), normalizedRows.value),
  ...(compareVisible.value ? collectValues(props.compareSeriesDefs.filter((item) => item.axis === "money"), normalizedCompareRows.value) : [])
]));

const countRange = computed(() => buildAxisRange([
  ...collectValues(props.seriesDefs.filter((item) => item.axis === "count"), normalizedRows.value),
  ...(compareVisible.value ? collectValues(props.compareSeriesDefs.filter((item) => item.axis === "count"), normalizedCompareRows.value) : [])
]));

function axisPoint(index, total) {
  const plotWidth = viewWidth - padding.left - padding.right;
  if (total <= 1) return padding.left + plotWidth / 2;
  return padding.left + (index / (total - 1)) * plotWidth;
}

function axisY(value, axis) {
  const plotHeight = props.chartHeight - padding.top - padding.bottom;
  const range = axis === "count" ? countRange.value : moneyRange.value;
  const span = Math.max(range.max - range.min, 1);
  return padding.top + plotHeight - (((numeric(value) - range.min) / span) * plotHeight);
}

function buildSeries(def, sourceRows) {
  return sourceRows.map((row, index) => ({
    index,
    label: row.x,
    value: numeric(row.raw?.[def.key]),
    px: axisPoint(index, sourceRows.length),
    py: axisY(row.raw?.[def.key], def.axis)
  }));
}

const currentSeries = computed(() => props.seriesDefs.map((def) => ({
  ...def,
  compare: false,
  points: buildSeries(def, normalizedRows.value)
})));

const compareSeries = computed(() => (
  compareVisible.value
    ? props.compareSeriesDefs.map((def) => ({
      ...def,
      compare: true,
      points: buildSeries(def, normalizedCompareRows.value)
    }))
    : []
));
const labelledSeries = computed(() => [...compareSeries.value, ...currentSeries.value]);

function toPolyline(points = []) {
  return points.map((point) => `${point.px},${point.py}`).join(" ");
}

function axisTicks(range, formatter) {
  const values = [];
  for (let index = 0; index < 4; index += 1) {
    const ratio = index / 3;
    const value = range.max - ((range.max - range.min) * ratio);
    const y = padding.top + ((props.chartHeight - padding.top - padding.bottom) * ratio);
    values.push({ y, label: formatter(value) });
  }
  return values;
}

const moneyTicks = computed(() => axisTicks(moneyRange.value, props.moneyFormatter));
const countTicks = computed(() => axisTicks(countRange.value, props.countFormatter));
const hoverRow = computed(() => normalizedRows.value[hoverIndex.value]?.raw || null);
const hoverCompareRow = computed(() => normalizedCompareRows.value[hoverIndex.value]?.raw || null);
const hoverLabel = computed(() => normalizedRows.value[hoverIndex.value]?.x || "");
const hoverX = computed(() => (
  hoverIndex.value < 0 ? padding.left : axisPoint(hoverIndex.value, normalizedRows.value.length)
));
const chartVars = computed(() => ({
  "--column-count": Math.max(normalizedRows.value.length, 1)
}));
const tooltipLeft = computed(() => {
  const width = props.tooltipWidth;
  const minLeft = 12;
  const maxLeft = viewWidth - width - 12;
  return Math.min(Math.max(hoverX.value - (width / 2), minLeft), maxLeft);
});

function clearHover() {
  hoverIndex.value = -1;
}

function seriesLabelX(series) {
  return Math.max((series.points?.[0]?.px || 0) + 8, padding.left + 8);
}

function seriesLabelY(series) {
  const firstPoint = series.points?.[0];
  if (!firstPoint) return padding.top;
  const minY = padding.top + 12;
  const maxY = props.chartHeight - padding.bottom - 12;
  return Math.min(Math.max(firstPoint.py - 8, minY), maxY);
}

function tooltipValue(row, def) {
  if (!row) return "";
  return def.axis === "count" ? props.countFormatter(row?.[def.key]) : props.moneyFormatter(row?.[def.key]);
}

const tooltipItems = computed(() => {
  const row = hoverRow.value;
  const compareRow = hoverCompareRow.value;
  if (!row) return [];

  if (props.tooltipMode === "focus") {
    return [
      ...props.seriesDefs.map((def) => ({
        label: def.label,
        value: tooltipValue(row, def)
      })),
      ...(compareVisible.value ? props.compareSeriesDefs.map((def) => ({
        label: def.label,
        value: tooltipValue(compareRow, def)
      })) : [])
    ];
  }

  return [
    { label: "单量", value: props.countFormatter(row.order_count) },
    { label: "营业额", value: props.moneyFormatter(row.revenue) },
    { label: "利润", value: props.moneyFormatter(row.profit) },
    { label: "取消单量", value: props.countFormatter(row.event_cancelled_orders ?? row.cancelled_orders) },
    { label: "取消金额", value: props.moneyFormatter(row.event_cancelled_revenue ?? row.cancelled_revenue) },
    { label: "退货单量", value: props.countFormatter(row.event_return_orders ?? row.return_orders) },
    { label: "退货金额", value: props.moneyFormatter(row.event_return_revenue ?? row.return_revenue) },
    { label: "有效订单", value: props.countFormatter(row.effective_orders) },
    { label: "有效营业额", value: props.moneyFormatter(row.effective_revenue) },
    ...(compareVisible.value ? props.compareSeriesDefs.map((def) => ({
      label: def.label,
      value: tooltipValue(compareRow, def)
    })) : [])
  ];
});
</script>

<template>
  <div class="profit-trend-card">
    <div class="profit-trend-card__head">
      <div>
        <strong>{{ title }}</strong>
        <span>{{ subtitle }}</span>
      </div>
      <div class="profit-trend-card__actions">
        <el-switch
          v-if="showCompareToggle && hasCompare"
          v-model="compareVisible"
          size="small"
          inline-prompt
          active-text="上月同期"
          inactive-text="仅本期"
        />
      </div>
    </div>

    <div
      v-if="normalizedRows.length"
      class="profit-trend-card__chart"
      :style="chartVars"
      @mouseleave="clearHover"
    >
      <svg :viewBox="`0 0 ${viewWidth} ${chartHeight}`" preserveAspectRatio="none">
        <line
          v-for="tick in moneyTicks"
          :key="`grid-${tick.y}`"
          :x1="padding.left"
          :x2="viewWidth - padding.right"
          :y1="tick.y"
          :y2="tick.y"
          stroke="rgba(148, 163, 184, 0.18)"
          stroke-width="1"
        />

        <line
          v-if="hoverIndex >= 0"
          :x1="hoverX"
          :x2="hoverX"
          :y1="padding.top"
          :y2="chartHeight - padding.bottom"
          stroke="rgba(37, 99, 235, 0.18)"
          stroke-width="1.5"
          stroke-dasharray="4 4"
        />

        <g v-for="series in compareSeries" :key="`compare-${series.key}`">
          <polyline
            :points="toPolyline(series.points)"
            fill="none"
            :stroke="series.color"
            stroke-width="2"
            stroke-dasharray="5 5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </g>

        <g v-for="series in currentSeries" :key="series.key">
          <polyline
            :points="toPolyline(series.points)"
            fill="none"
            :stroke="series.color"
            stroke-width="2.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <circle
            v-for="point in series.points"
            :key="`${series.key}-${point.index}`"
            :cx="point.px"
            :cy="point.py"
            r="3.2"
            :fill="series.color"
            :stroke="hoverIndex === point.index ? '#ffffff' : series.color"
            :stroke-width="hoverIndex === point.index ? 2 : 0"
          />
        </g>

        <text
          v-for="series in labelledSeries"
          :key="`series-label-${series.compare ? 'compare' : 'current'}-${series.key}`"
          :x="seriesLabelX(series)"
          :y="seriesLabelY(series)"
          :fill="series.color"
          class="series-inline-label"
        >
          {{ series.label }}
        </text>

        <text
          v-for="tick in moneyTicks"
          :key="`money-${tick.y}`"
          :x="padding.left - 10"
          :y="tick.y + 4"
          text-anchor="end"
          class="axis-label"
        >
          {{ tick.label }}
        </text>

        <text
          v-for="tick in countTicks"
          v-if="hasCountAxis"
          :key="`count-${tick.y}`"
          :x="viewWidth - padding.right + 10"
          :y="tick.y + 4"
          text-anchor="start"
          class="axis-label"
        >
          {{ tick.label }}
        </text>
      </svg>

      <div class="profit-trend-card__hover-columns">
        <button
          v-for="(row, index) in normalizedRows"
          :key="row.x"
          class="hover-column"
          type="button"
          @mouseenter="hoverIndex = index"
          @focus="hoverIndex = index"
        />
      </div>

      <div
        v-if="hoverRow"
        class="profit-trend-card__tooltip"
        :class="{ 'profit-trend-card__tooltip--compact': tooltipMode === 'focus' }"
        :style="{ left: `${tooltipLeft}px`, width: `${tooltipWidth}px` }"
      >
        <strong>{{ labelFormatter(hoverLabel) }}</strong>
        <div class="tooltip-grid">
          <div v-for="item in tooltipItems" :key="item.label" class="tooltip-grid__item">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </div>
        </div>
      </div>

      <div class="profit-trend-card__legend">
        <span v-for="series in currentSeries" :key="`legend-${series.key}`">
          <i class="legend-dot" :style="{ background: series.color }"></i>{{ series.label }}
        </span>
        <span v-for="series in compareSeries" :key="`legend-compare-${series.key}`">
          <i class="legend-line" :style="{ borderTopColor: series.color }"></i>{{ series.label }}
        </span>
      </div>

      <div class="profit-trend-card__labels">
        <span v-for="row in normalizedRows" :key="row.x">{{ labelFormatter(row.x) }}</span>
      </div>
    </div>

    <div v-else class="compact-empty compact-empty--table">
      <strong>暂无趋势数据</strong>
      <span>当前筛选范围内还没有可展示的趋势结果。</span>
    </div>
  </div>
</template>

<style scoped>
.profit-trend-card { display: flex; flex-direction: column; gap: 12px; }
.profit-trend-card__head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
.profit-trend-card__head strong { display: block; font-size: 16px; color: #0f172a; }
.profit-trend-card__head span { display: block; margin-top: 4px; font-size: 13px; color: #64748b; }
.profit-trend-card__actions { flex-shrink: 0; }
.profit-trend-card__chart { position: relative; }
.profit-trend-card__chart svg { width: 100%; display: block; overflow: visible; }
.axis-label { fill: #64748b; font-size: 11px; }
.series-inline-label { font-size: 9px; font-weight: 500; opacity: 0.92; }
.profit-trend-card__hover-columns {
  position: absolute;
  inset: 16px 56px 42px 56px;
  display: grid;
  grid-template-columns: repeat(var(--column-count), minmax(0, 1fr));
}
.hover-column {
  border: 0;
  background: transparent;
  padding: 0;
  margin: 0;
  cursor: crosshair;
}
.profit-trend-card__tooltip {
  position: absolute;
  top: 18px;
  padding: 12px;
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.94);
  color: #f8fafc;
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.22);
  pointer-events: none;
}
.profit-trend-card__tooltip strong { display: block; font-size: 14px; }
.profit-trend-card__tooltip--compact {
  padding: 10px;
  border-radius: 10px;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.18);
}
.tooltip-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
  margin-top: 8px;
}
.profit-trend-card__tooltip--compact .tooltip-grid {
  grid-template-columns: minmax(0, 1fr);
  gap: 6px;
  margin-top: 6px;
}
.tooltip-grid__item { display: flex; flex-direction: column; gap: 2px; }
.tooltip-grid__item span { font-size: 11px; color: rgba(203, 213, 225, 0.92); }
.tooltip-grid__item strong { font-size: 13px; }
.profit-trend-card__legend { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; font-size: 12px; color: #64748b; }
.legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 999px; margin-right: 6px; vertical-align: middle; }
.legend-line {
  display: inline-block;
  width: 14px;
  height: 0;
  border-top: 2px dashed #94a3b8;
  margin-right: 6px;
  vertical-align: middle;
}
.profit-trend-card__labels {
  display: grid;
  grid-template-columns: repeat(var(--column-count), minmax(0, 1fr));
  gap: 0;
  padding: 0 56px;
  font-size: 12px;
  color: #64748b;
}
.profit-trend-card__labels span { text-align: center; white-space: pre-line; line-height: 1.2; }

@media (max-width: 768px) {
  .profit-trend-card__tooltip {
    width: calc(100% - 24px);
    left: 12px !important;
    right: 12px;
  }
}
</style>
