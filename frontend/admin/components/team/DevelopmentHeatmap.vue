<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api.js";
import { shanghaiDateKey, shanghaiDateText, shanghaiMonthStart } from "../../utils/shanghai-date.js";
import { buildDevelopmentHeatmap, developmentCoordinateKey, developmentPlanPeriodKey } from "../../utils/development-heatmap.js";

const emit = defineEmits(["open-task", "create"]);
const tasks = ref([]); const loading = ref(false); const error = ref("");
const metric = ref("tasks"); const dimension = ref("model"); const scope = ref("all"); const query = ref("");
const period = ref("month"); const time = ref("due");
const range = ref([shanghaiMonthStart(), shanghaiDateKey()]);
const detail = ref(null); const planningMode = ref(false); const planSaving = ref(false);
const planOrders = ref(new Map()); const selectedCoordinateKeys = ref([]); const selectedCoordinates = ref(new Map()); const pendingPlanKeys = ref(new Set());
const avatarFailures = ref(new Set());
const zoom = ref(1); const viewport = ref(null); const canvasWidth = ref(1200); const isDragging = ref(false); const dragOrigin = ref(null); const dragged = ref(false);
let resizeObserver;
const unit = computed(() => metric.value === "tasks" ? "个任务" : "个 SKU");
const metricLabel = computed(() => ({ actual: "实际已开发", target: "计划开发", tasks: "开发任务" })[metric.value]);
const periodKey = computed(() => developmentPlanPeriodKey(period.value, range.value || []));
const heatmap = computed(() => buildDevelopmentHeatmap(tasks.value, { metric: metric.value, dimension: dimension.value, scope: scope.value, query: query.value, time: time.value, range: range.value }));
const maxSequence = computed(() => Math.max(0, ...[...planOrders.value.values()].map((item) => Number(item.sequence || 0))));
const selectedPlanCells = computed(() => selectedCoordinateKeys.value.map((key) => ({
  key,
  ...selectedCoordinates.value.get(key),
  ...(planOrders.value.get(key) || { sequence: null, marked: false })
})).filter((item) => item.coordinate_key));
const selectedPlanSummary = computed(() => {
  const selectedTasks = new Set(); const grains = new Set();
  for (const item of selectedPlanCells.value) {
    const row = heatmap.value.rows.find((candidate) => candidate.scope === item.scope && candidate.brand === item.brand && candidate.model_id === item.model_id);
    const column = heatmap.value.columns.find((candidate) => candidate.label === item.category);
    if (!row || !column) continue;
    for (const taskId of heatmap.value.cell(row, column.label).tasks.keys()) selectedTasks.add(taskId);
    grains.add(dimension.value === "model" ? JSON.stringify([item.scope, item.brand, item.model_id]) : JSON.stringify([item.scope, item.brand]));
  }
  return { grainCount: grains.size, taskCount: selectedTasks.size, grainLabel: dimension.value === "model" ? "车型" : "品牌" };
});
const quadrantCards = computed(() => {
  const cards = [10, 7, 8, 6].map((score) => ({ ...quadrantLabels.find((quadrant) => quadrant.score === score), points: [] }));
  for (const row of heatmap.value.rows) {
    for (const column of heatmap.value.columns) {
      const cell = heatmap.value.cell(row, column.label);
      if (!cell.tasks.size) continue;
      const quadrant = cards.find((item) => item.score === cell.priorityScore) || cards.find((item) => item.score === 7);
      const plan = cellPlan(row, column);
      quadrant.points.push({ row, column, cell, plan, coordinate: coordinateFor(row, column), title: `${column.label} · ${row.label}` });
    }
  }
  for (const quadrant of cards) quadrant.points.sort((a, b) => {
    const aSequence = Number(a.plan.sequence) || Number.MAX_SAFE_INTEGER;
    const bSequence = Number(b.plan.sequence) || Number.MAX_SAFE_INTEGER;
    return aSequence - bSequence || completedCount(a.cell) / a.cell.tasks.size - completedCount(b.cell) / b.cell.tasks.size || a.title.localeCompare(b.title, "zh-CN", { numeric: true });
  });
  return cards;
});
const boardStyle = computed(() => ({ width: `${canvasWidth.value}px`, gridTemplateRows: "repeat(2, 340px)", transform: `scale(${zoom.value})` }));
const boardShellStyle = computed(() => ({ width: `${canvasWidth.value * zoom.value}px`, height: `${696 * zoom.value}px` }));
const quadrantLabels = [
  { score: 10, label: "紧急重要" },
  { score: 8, label: "紧急不重要" },
  { score: 7, label: "重要不紧急" },
  { score: 6, label: "不紧急不重要" }
];
const priorityQuadrants = computed(() => quadrantLabels.map((item) => ({ ...item, count: heatmap.value.quadrants.find((row) => row.score === item.score)?.count || 0 })));

function setMetric() { if (metric.value !== "actual" && time.value === "draft") time.value = "due"; detail.value = null; }
function togglePlanningMode() {
  planningMode.value = !planningMode.value;
  selectedCoordinateKeys.value = [];
  selectedCoordinates.value = new Map();
}
function dateUTC(value) { const [year, month, day] = value.split("-").map(Number); return new Date(Date.UTC(year, month - 1, day)); }
function dateKey(value) { return value.toISOString().slice(0, 10); }
function setPeriod(value) {
  period.value = value;
  const today = shanghaiDateKey(); const anchor = dateUTC(today); const year = anchor.getUTCFullYear(); const month = anchor.getUTCMonth();
  if (value === "week") { const day = anchor.getUTCDay() || 7; const start = new Date(Date.UTC(year, month, anchor.getUTCDate() - day + 1)); range.value = [dateKey(start), dateKey(new Date(Date.UTC(year, month, anchor.getUTCDate() - day + 7)))]; }
  if (value === "month") range.value = [shanghaiMonthStart(), `${year}-${String(month + 1).padStart(2, "0")}-${new Date(Date.UTC(year, month + 1, 0)).getUTCDate()}`];
  if (value === "quarter") { const startMonth = Math.floor(month / 3) * 3; range.value = [dateKey(new Date(Date.UTC(year, startMonth, 1))), dateKey(new Date(Date.UTC(year, startMonth + 3, 0)))]; }
  if (value === "year") range.value = [`${year}-01-01`, `${year}-12-31`];
  if (value === "all") range.value = [];
  detail.value = null;
}
async function load() {
  loading.value = true; error.value = "";
  try { const rows = await apiClient.get("/api/team/tasks", { noCache: true }); tasks.value = Array.isArray(rows) ? rows : rows.rows || []; }
  catch (err) { error.value = err.message || "开发数据加载失败，请重试"; }
  finally { loading.value = false; }
}
async function loadPlanOrders() {
  if (!periodKey.value) { planOrders.value = new Map(); return; }
  try {
    const rows = await apiClient.get(`/api/team/development-heatmap-orders?period_key=${encodeURIComponent(periodKey.value)}&dimension=${dimension.value}`, { noCache: true });
    planOrders.value = new Map((Array.isArray(rows) ? rows : []).map((row) => [row.coordinate_key, { sequence: row.sequence == null ? null : Number(row.sequence), marked: Boolean(row.marked) }]));
  } catch { planOrders.value = new Map(); }
}
function coordinateFor(row, column) {
  const coordinate_key = developmentCoordinateKey(row.scope, row.brand, column.label, dimension.value === "model" ? row.model_id : "");
  return { coordinate_key, label: `${row.label} · ${column.label}`, scope: row.scope, brand: row.brand, category: column.label, model_id: dimension.value === "model" ? row.model_id : "" };
}
function cellPlan(row, column) { return planOrders.value.get(coordinateFor(row, column).coordinate_key) || { sequence: null, marked: false }; }
function toggleCoordinate(row, column) {
  const cell = heatmap.value.cell(row, column.label);
  if (!cell.tasks.size) return;
  const coordinate = coordinateFor(row, column); const key = coordinate.coordinate_key;
  selectedCoordinates.value = new Map(selectedCoordinates.value).set(key, coordinate);
  if (selectedCoordinateKeys.value.includes(key)) return;
  selectedCoordinateKeys.value = [...selectedCoordinateKeys.value, key];
  if (!(Number(planOrders.value.get(key)?.sequence) > 0)) updatePlan(key, "sequence", maxSequence.value + 1);
}
function updatePlan(key, field, value) {
  const next = new Map(planOrders.value); const current = next.get(key) || { sequence: null, marked: false };
  next.set(key, { ...current, [field]: field === "sequence" && !Number(value) ? null : value }); planOrders.value = next;
  pendingPlanKeys.value = new Set(pendingPlanKeys.value).add(key);
}
function setSelectedMarked(marked) { for (const key of selectedCoordinateKeys.value) updatePlan(key, "marked", marked); }
function cancelCoordinate(event, row, column) {
  if (!planningMode.value) return;
  event.preventDefault();
  const key = coordinateFor(row, column).coordinate_key;
  selectedCoordinateKeys.value = selectedCoordinateKeys.value.filter((item) => item !== key);
  if (!(Number(planOrders.value.get(key)?.sequence) > 0)) return;
  updatePlan(key, "sequence", null);
  const ordered = [...planOrders.value.entries()].filter(([, plan]) => Number(plan.sequence) > 0).sort((a, b) => Number(a[1].sequence) - Number(b[1].sequence));
  ordered.forEach(([orderedKey], index) => { if (Number(planOrders.value.get(orderedKey)?.sequence) !== index + 1) updatePlan(orderedKey, "sequence", index + 1); });
}
async function savePlanOrders() {
  if (!periodKey.value || !pendingPlanKeys.value.size) return;
  planSaving.value = true;
  try {
    const entries = [...pendingPlanKeys.value].map((key) => ({ coordinate_key: key, sequence: planOrders.value.get(key)?.sequence ?? null, marked: Boolean(planOrders.value.get(key)?.marked) }));
    await apiClient.put("/api/team/development-heatmap-orders", { period_key: periodKey.value, dimension: dimension.value, entries });
    ElMessage.success(`已保存 ${entries.length} 个开发坐标，本周期任务中心将同步排序`);
    selectedCoordinateKeys.value = []; selectedCoordinates.value = new Map(); pendingPlanKeys.value = new Set(); await loadPlanOrders();
  } catch (err) { ElMessage.error(err.message || "开发顺序保存失败"); }
  finally { planSaving.value = false; }
}
function priorityLabel(score) { return ({ 10: "紧急重要", 8: "紧急不重要", 7: "重要不紧急", 6: "不紧急不重要" })[score] || "重要不紧急"; }
function pointStyle(point) {
  const sequence = Number(point.plan.sequence);
  if (!(sequence > 0)) return {};
  const strength = Math.max(0.12, 1 - (sequence - 1) / Math.max(1, maxSequence.value));
  return { "--schedule-strength": strength, borderColor: `hsl(4 85% ${78 - strength * 38}%)`, boxShadow: `0 0 ${Math.round(strength * 12)}px rgba(220, 38, 38, ${0.12 + strength * 0.4})` };
}
function showCell(row, column) {
  const cell = heatmap.value.cell(row, column.label);
  const tasks = [...cell.tasks.values()].map((task) => ({ task, modelIndex: modelIndexFor(task, row, column) }))
    .sort((a, b) => ({ urgent_important: 10, high: 10, urgent_unimportant: 8, important_not_urgent: 7, medium: 7, not_urgent_unimportant: 6, low: 6 }[b.task.priority] || 7) - ({ urgent_important: 10, high: 10, urgent_unimportant: 8, important_not_urgent: 7, medium: 7, not_urgent_unimportant: 6, low: 6 }[a.task.priority] || 7));
  detail.value = { title: `${row.label} · ${column.label}`, value: cell.value, priority: priorityLabel(cell.priorityScore), tasks, drafts: cell.drafts, dimension: dimension.value };
}
function cellTasks(cell) { return [...cell.tasks.values()]; }
function completedCount(cell) { return cellTasks(cell).filter((task) => task.status === "done").length; }
function taskOwners(cell) {
  const owners = new Map();
  for (const task of cellTasks(cell)) if (task.owner_name && !owners.has(task.owner_person_id || task.owner_name)) owners.set(task.owner_person_id || task.owner_name, task);
  return [...owners.values()];
}
function avatarKey(task) { return String(task.owner_person_id || task.owner_name || task.id); }
function handleAvatarError(task) { avatarFailures.value = new Set(avatarFailures.value).add(avatarKey(task)); }
function modelIndexFor(task, row, column) {
  if (dimension.value !== "model") return null;
  const models = task.development_plan?.models || [];
  const index = models.findIndex((model) => String(model.model_id || model.model || "") === String(row.model_id || "") && (model.category || task.development_plan?.category || "") === column.label);
  return index < 0 ? null : index;
}
function taskStatusLabel(task) { return task.status === "done" ? "已完成" : task.status === "delayed" ? "已超时" : task.status === "doing" ? "进行中" : "待开始"; }
function taskDueLabel(task) { return task.due_at ? shanghaiDateText(task.due_at, { assumeUtcWhenNaive: true }) : "未设置"; }
function zoomBy(delta, anchor = null) {
  const target = Math.max(0.45, Math.min(1.35, Math.round((zoom.value + delta) * 100) / 100));
  if (target === zoom.value) return;
  const viewportRect = viewport.value?.getBoundingClientRect(); const element = viewport.value;
  const point = anchor && viewportRect ? { x: anchor.x - viewportRect.left + element.scrollLeft, y: anchor.y - viewportRect.top + element.scrollTop } : null;
  const previous = zoom.value; zoom.value = target;
  if (point && element) nextTick(() => {
    element.scrollLeft = point.x * target / previous - (anchor.x - viewportRect.left);
    element.scrollTop = point.y * target / previous - (anchor.y - viewportRect.top);
  });
}
function handleZoomWheel(event) { zoomBy(event.deltaY < 0 ? 0.06 : -0.06, { x: event.clientX, y: event.clientY }); }
function resetZoom() {
  zoom.value = 1;
  if (!viewport.value) return;
  viewport.value.scrollLeft = 0; viewport.value.scrollTop = 0;
  for (const quadrant of viewport.value.querySelectorAll(".quadrant-points")) { quadrant.scrollLeft = 0; quadrant.scrollTop = 0; }
}
function beginPan(event) {
  if (event.button !== 0) return;
  dragged.value = false;
  dragOrigin.value = { x: event.clientX, y: event.clientY, left: viewport.value.scrollLeft, top: viewport.value.scrollTop, pointerId: event.pointerId };
}
function movePan(event) {
  if (!dragOrigin.value) return;
  if (!isDragging.value && Math.hypot(event.clientX - dragOrigin.value.x, event.clientY - dragOrigin.value.y) > 4) {
    dragged.value = true; isDragging.value = true; viewport.value?.setPointerCapture(event.pointerId);
  }
  if (isDragging.value) {
    event.preventDefault();
    viewport.value.scrollLeft = dragOrigin.value.left - (event.clientX - dragOrigin.value.x); viewport.value.scrollTop = dragOrigin.value.top - (event.clientY - dragOrigin.value.y);
  }
}
function endPan() {
  isDragging.value = false; dragOrigin.value = null;
  if (dragged.value) setTimeout(() => { dragged.value = false; }, 0);
}
function handleCellClick(row, column) {
  if (dragged.value) { dragged.value = false; return; }
  if (planningMode.value) return toggleCoordinate(row, column);
  const cell = heatmap.value.cell(row, column.label);
  const items = [...cell.tasks.values()].map((task) => ({ task, modelIndex: modelIndexFor(task, row, column) }));
  if (items.length === 1) return emitEdit(items[0]);
  showCell(row, column);
}
function emitEdit(item) { emit("open-task", { task: item.task, modelIndex: item.modelIndex, dimension: dimension.value }); detail.value = null; }
async function fitCanvas() {
  await nextTick();
  if (viewport.value?.clientWidth) canvasWidth.value = Math.max(960, viewport.value.clientWidth - 2);
}
defineExpose({ reload: load });
watch([periodKey, dimension], () => { selectedCoordinateKeys.value = []; selectedCoordinates.value = new Map(); pendingPlanKeys.value = new Set(); loadPlanOrders(); });
watch(() => heatmap.value.rows.length, fitCanvas);
watch(viewport, (element) => { if (element) resizeObserver?.observe(element); }, { flush: "post" });
onMounted(() => { setPeriod("month"); load(); fitCanvas(); resizeObserver = new ResizeObserver(fitCanvas); if (viewport.value) resizeObserver.observe(viewport.value); });
onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
  <section class="heatmap-panel" v-loading="loading">
    <header class="heatmap-heading"><div><h2>开发分布热力图</h2><p>按优先级四象限展示；每个点对应核心品名与当前品牌/车型颗粒度。本周 / 本月统计计划完成日，逾期未完成任务按任务中心规则每周顺延。</p></div><div><el-button @click="load">刷新</el-button><el-button v-if="periodKey" :type="planningMode ? 'warning' : 'default'" @click="togglePlanningMode">{{ planningMode ? '退出排程' : '人工排程' }}</el-button><el-button type="primary" @click="emit('create')">新增开发任务</el-button></div></header>
    <div class="heatmap-filters">
      <el-radio-group v-model="period" @change="setPeriod"><el-radio-button value="week">本周</el-radio-button><el-radio-button value="month">本月</el-radio-button><el-radio-button value="quarter">本季度</el-radio-button><el-radio-button value="year">本年</el-radio-button><el-radio-button value="all">全部时间</el-radio-button><el-radio-button value="custom">自定义</el-radio-button></el-radio-group>
      <el-date-picker v-if="period !== 'all'" v-model="range" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" :clearable="false" @change="period = 'custom'" />
      <el-select v-model="metric" aria-label="统计数量" @change="setMetric"><el-option label="开发任务数" value="tasks" /><el-option label="计划开发 SKU" value="target" /><el-option label="实际已开发 SKU" value="actual" /></el-select>
      <el-select v-model="time" aria-label="统计日期"><el-option v-if="metric === 'actual'" label="按草稿创建时间" value="draft" /><el-option label="按计划完成日期（含顺延）" value="due" /><el-option label="按任务创建时间" value="created" /></el-select>
    </div>
    <div class="heatmap-filters">
      <el-radio-group v-model="dimension"><el-radio-button value="model">按车型</el-radio-button><el-radio-button value="brand">按品牌</el-radio-button></el-radio-group>
      <el-select v-model="scope" aria-label="开发范围"><el-option label="全部范围" value="all" /><el-option label="汽车" value="automotive" /><el-option label="非汽车" value="non_automotive" /><el-option label="未分类" value="unknown" /></el-select>
      <el-input v-model="query" clearable placeholder="搜索品牌、车型或核心品名" />
      <span class="heatmap-summary">{{ metricLabel }} <b>{{ heatmap.total }}</b> {{ unit }} · {{ heatmap.taskCount }} 个任务 · {{ heatmap.rows.length }} 行 × {{ heatmap.columns.length }} 核心品名</span>
    </div>
    <div v-if="planningMode" class="heatmap-plan-toolbar">
      <strong>{{ periodKey }} · 已选 {{ selectedPlanSummary.grainCount }} 个{{ selectedPlanSummary.grainLabel }} · {{ selectedPlanSummary.taskCount }} 个任务</strong>
      <span>左键依次安排顺序；右键取消该点排程。拖动图面平移，滚轮缩放。</span>
      <el-button size="small" :disabled="!selectedPlanCells.length" @click="setSelectedMarked(true)">标记</el-button>
      <el-button size="small" :disabled="!selectedPlanCells.length" @click="setSelectedMarked(false)">取消标记</el-button>
      <el-button size="small" type="primary" :loading="planSaving" :disabled="!pendingPlanKeys.size" @click="savePlanOrders">保存排程</el-button>
    </div>
    <div v-if="planningMode && selectedPlanCells.length" class="heatmap-selected-list">
      <span v-for="item in selectedPlanCells" :key="item.key"><b>{{ item.sequence || '·' }}</b>{{ item.label }}</span>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false"><el-button @click="load">重新加载</el-button></el-alert>
    <template v-else>
      <div class="heatmap-priority-legend"><strong>优先级</strong><span class="priority-10">紧急重要 <small>{{ priorityQuadrants.find(item => item.score === 10)?.count || 0 }}</small></span><span class="priority-7">重要不紧急 <small>{{ priorityQuadrants.find(item => item.score === 7)?.count || 0 }}</small></span><span class="priority-8">紧急不重要 <small>{{ priorityQuadrants.find(item => item.score === 8)?.count || 0 }}</small></span><span class="priority-6">不重要不紧急 <small>{{ priorityQuadrants.find(item => item.score === 6)?.count || 0 }}</small></span><span class="priority-done">已完成</span><em>四象限 = 优先级 · 点位 = 核心品名 × {{ dimension === 'model' ? '车型' : '品牌' }}</em></div>
      <div class="heatmap-canvas-toolbar" v-if="heatmap.rows.length && heatmap.columns.length"><span>缩放</span><el-button circle size="small" aria-label="缩小热力图" @click="zoomBy(-0.08)">−</el-button><strong>{{ Math.round(zoom * 100) }}%</strong><el-button circle size="small" aria-label="放大热力图" @click="zoomBy(0.08)">＋</el-button><el-button size="small" @click="resetZoom">重置</el-button><small>滚轮缩放 · 左键拖动</small></div>
      <div v-if="heatmap.rows.length && heatmap.columns.length" ref="viewport" class="heatmap-viewport" :class="{ 'is-panning': isDragging, 'planning-mode': planningMode }" @wheel.prevent="handleZoomWheel" @pointerdown="beginPan" @pointermove="movePan" @pointerup="endPan" @pointercancel="endPan" @lostpointercapture="endPan">
        <div class="heatmap-board-shell" :style="boardShellStyle"><div class="quadrant-board" :style="boardStyle">
          <section v-for="quadrant in quadrantCards" :key="quadrant.score" class="priority-quadrant" :class="[`quadrant-${quadrant.score}`, { dense: quadrant.points.length > 8 }]">
            <header><div><strong>{{ quadrant.label }}</strong><small>{{ quadrant.points.length }} 个{{ dimension === 'model' ? '车型' : '品牌' }}点 · {{ quadrant.points.reduce((sum, point) => sum + point.cell.tasks.size, 0) }} 个任务</small></div><b>{{ quadrant.points.length }}</b></header>
            <div class="quadrant-points">
              <button v-for="point in quadrant.points" :key="point.coordinate.coordinate_key" class="quadrant-point" :class="[{ selected: selectedCoordinateKeys.includes(point.coordinate.coordinate_key), marked: point.plan.marked, completed: completedCount(point.cell) === point.cell.tasks.size }, `priority-${quadrant.score}`]" :style="pointStyle(point)" :aria-label="`${point.title}：${point.cell.value} ${unit}`" @click="handleCellClick(point.row,point.column)" @contextmenu="cancelCoordinate($event,point.row,point.column)">
                <b v-if="point.plan.sequence" class="point-sequence">{{ point.plan.sequence }}</b><i v-if="point.plan.marked" class="point-marker">标记</i>
                <span class="point-owners"><el-avatar v-for="task in taskOwners(point.cell).slice(0,3)" :key="avatarKey(task)" :src="avatarFailures.has(avatarKey(task)) ? '' : task.owner_avatar_url" :size="34" @error="handleAvatarError(task)">{{ task.owner_name?.slice(0,1) || '?' }}</el-avatar><i v-if="taskOwners(point.cell).length > 3">+{{ taskOwners(point.cell).length - 3 }}</i><el-avatar v-if="!taskOwners(point.cell).length" :size="34">?</el-avatar></span>
                <span class="point-copy"><strong>{{ point.title }}</strong><small>{{ point.cell.tasks.size }} 个任务 · {{ completedCount(point.cell) }}/{{ point.cell.tasks.size }} 完成</small><small>{{ point.cell.value }} {{ unit }} · {{ priorityLabel(point.cell.priorityScore) }}</small></span>
                <span class="point-hover-card"><b>{{ point.title }}</b><small>{{ dimension === 'model' ? '车型' : '品牌' }}颗粒度 · {{ point.cell.tasks.size }} 个任务</small><span v-for="task in cellTasks(point.cell).slice(0,4)" :key="task.id"><el-avatar :src="task.owner_avatar_url" :size="22">{{ task.owner_name?.slice(0,1) || '?' }}</el-avatar><strong>{{ task.title }}</strong><i :class="{ done: task.status === 'done' }">{{ taskStatusLabel(task) }}</i></span><em v-if="point.cell.tasks.size > 4">另有 {{ point.cell.tasks.size - 4 }} 个任务</em><small>点击{{ planningMode ? '排入顺序' : dimension === 'model' ? '查看车型任务' : '查看品牌任务' }}{{ planningMode ? ' · 右键取消排程' : '' }}</small></span>
              </button>
              <p v-if="!quadrant.points.length" class="quadrant-empty">暂无任务</p>
            </div>
          </section>
        </div></div>
      </div>
      <el-empty v-else-if="!loading" description="当前范围暂无可归类的开发记录，可调整时间或新增开发任务" />
      <footer class="heatmap-notes"><span>四象限按优先级分区；早排程点靠近中心，头像表示负责人，悬浮查看任务概览。左键拖动画布，滚轮缩放。</span><p>北京时间。{{ metric === 'actual' ? '已开发数量按关联草稿的当前变体数统计，同一草稿去重，店铺副本不重复计数；这不是历史时点快照。' : metric === 'target' ? '计划数量按各车型设置的 SKU 目标汇总。' : '每个点对应一个核心品名与当前品牌/车型颗粒度的任务集合；顶部总任务数去重。' }}</p><p v-if="heatmap.unclassified">当前任务日期范围内有 {{ heatmap.unclassified }} 个旧开发任务缺少品牌／车型／类目；切换“开发任务数”查看“未分类”，不将其自动归入非汽车。</p><p v-if="heatmap.conflicts" class="heatmap-warning">{{ heatmap.conflicts }} 份草稿关联到了多个不同坐标，已排除重复归属；请在任务详情中修正关联。</p></footer>
    </template>
    <el-dialog v-if="detail" :model-value="true" :title="detail.title" width="min(820px, 94vw)" append-to-body @close="detail = null">
      <p>{{ metricLabel }}：<b>{{ detail.value }}</b> {{ unit }} · {{ detail.tasks.length }} 个关联任务 · 最高优先级 {{ detail.priority }}</p>
      <el-table :data="detail.tasks" max-height="420" empty-text="这个坐标暂无开发任务"><el-table-column label="任务名称" min-width="220"><template #default="{row}">{{ row.task.title }}</template></el-table-column><el-table-column label="负责人" width="150"><template #default="{row}"><span class="detail-owner"><el-avatar :src="row.task.owner_avatar_url" :size="24">{{ row.task.owner_name?.slice(0,1) || '?' }}</el-avatar>{{ row.task.owner_name || '未分配' }}</span></template></el-table-column><el-table-column label="优先级" width="130"><template #default="{row}">{{ priorityLabel(({ urgent_important:10, high:10, urgent_unimportant:8, important_not_urgent:7, medium:7, not_urgent_unimportant:6, low:6 })[row.task.priority] || 7) }}</template></el-table-column><el-table-column label="计划完成" width="130"><template #default="{row}">{{ taskDueLabel(row.task) }}</template></el-table-column><el-table-column label="操作" width="150"><template #default="{row}"><el-button link type="primary" @click="emitEdit(row)">{{ detail.dimension === 'model' ? '编辑本车型进度' : '编辑任务' }}</el-button></template></el-table-column></el-table>
      <p v-if="metric === 'actual'">符合筛选条件的成果草稿：{{ detail.drafts.length }} 份（已去重）</p>
      <template #footer><el-button @click="detail = null">关闭</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.heatmap-panel{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:24px;min-width:0}.heatmap-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:22px}.heatmap-heading h2{margin:0 0 8px;font-size:22px;color:#1e293b}.heatmap-heading p,.heatmap-notes{font-size:13px;color:#64748b;line-height:1.7}.heatmap-heading p{margin:0}.heatmap-heading>div:last-child{display:flex;flex-shrink:0;gap:6px}.heatmap-filters{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}.heatmap-filters .el-select{width:174px}.heatmap-filters .el-input{width:250px}.heatmap-filters :deep(.el-date-editor){max-width:320px}.heatmap-summary{margin-left:auto;color:#64748b;font-size:13px}.heatmap-summary b{font-size:23px;color:#2563eb;margin:0 4px}.heatmap-plan-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:11px 13px;margin:0 0 10px;border:1px solid #bfdbfe;border-radius:10px;background:#eff6ff;color:#334155;font-size:12px}.heatmap-plan-toolbar strong{color:#1d4ed8}.heatmap-plan-toolbar>span{margin-right:auto}.heatmap-selected-list{display:flex;gap:8px;flex-wrap:wrap;padding:0 0 14px}.heatmap-selected-list article{display:flex;align-items:center;gap:9px;padding:7px 10px;border:1px solid #dbe3ef;border-radius:9px;background:#fff;font-size:12px}.heatmap-selected-list article>strong{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.heatmap-selected-list label{display:flex;align-items:center;gap:5px;color:#64748b}.heatmap-selected-list :deep(.el-input-number){width:104px}.heatmap-priority-legend{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 11px;margin-bottom:10px;border-radius:8px;background:#f8fafc;color:#475569;font-size:11px}.heatmap-priority-legend>strong{flex:none}.heatmap-priority-legend span{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;font-weight:700}.heatmap-priority-legend .priority-10{background:#fee2e2;color:#b91c1c}.heatmap-priority-legend .priority-7{background:#fef3c7;color:#92400e}.heatmap-priority-legend .priority-8{background:#ffedd5;color:#c2410c}.heatmap-priority-legend .priority-6{background:#e2e8f0;color:#475569}.heatmap-priority-legend span small{color:inherit;font-weight:500}.heatmap-priority-legend em{margin-left:auto;color:#64748b;font-style:normal}.heatmap-scroll{max-height:calc(100vh - 430px);min-height:230px;overflow:auto;border:1px solid #dce5f0;border-radius:10px}.heatmap-scroll table{border-collapse:separate;border-spacing:0;min-width:100%;font-size:13px}.heatmap-scroll th,.heatmap-scroll td{border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;min-width:140px;padding:0}.heatmap-scroll th{padding:14px 18px;background:#f5f8fd;text-align:left;color:#334155}.heatmap-scroll th small{display:block;font-size:11px;font-weight:400;color:#64748b;margin-top:5px}.heatmap-scroll thead th{position:sticky;top:0;z-index:2;white-space:nowrap}.heatmap-scroll tr>th:first-child{position:sticky;left:0;z-index:1;min-width:190px}.heatmap-scroll thead th:first-child{z-index:3;background:#edf3fb}.heatmap-scroll td button{position:relative;width:100%;min-height:82px;display:flex;flex-direction:column;gap:5px;justify-content:center;align-items:center;background:#fafcff;color:#94a3b8;border:0;cursor:pointer;transition:box-shadow .15s,transform .15s}.heatmap-scroll td button:disabled{cursor:default}.heatmap-scroll td button.selected{outline:3px solid #2563eb;outline-offset:-4px;z-index:1}.heatmap-scroll td button.marked{box-shadow:inset 0 0 0 3px #f59e0b}.heatmap-scroll td button.priority-10:not(.ordered){box-shadow:inset 0 0 0 3px #dc2626}.heatmap-scroll td button.priority-8:not(.ordered){box-shadow:inset 0 0 0 2px #f97316}.heatmap-scroll td button.priority-7:not(.ordered){box-shadow:inset 0 0 0 1px #fbbf24}.heatmap-scroll td strong{font-size:22px;font-variant-numeric:tabular-nums}.heatmap-scroll td small{font-size:11px}.cell-sequence{position:absolute;left:7px;top:6px;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#991b1b;color:#fff;font-size:12px}.cell-marker{position:absolute;right:6px;top:6px;padding:2px 5px;border-radius:5px;background:#fef3c7;color:#92400e;font-size:10px;font-style:normal;font-weight:700}.heatmap-scroll button:hover:not(:disabled),.heatmap-scroll button:focus-visible{outline:2px solid #2563eb;outline-offset:-3px}.heatmap-notes{margin-top:14px}.heatmap-notes p{margin:5px 0}.heatmap-notes>span{display:flex;align-items:center;gap:8px}.heatmap-warning{color:#b45309}@media(max-width:760px){.heatmap-panel{padding:14px}.heatmap-heading{align-items:flex-start;flex-direction:column}.heatmap-scroll{max-height:65vh}.heatmap-summary{margin-left:0}.heatmap-filters .el-select{width:150px}.heatmap-selected-list article{flex-wrap:wrap}}
</style>

<style scoped>
.quadrant-board{position:absolute;inset:0 auto auto 0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:4px;box-sizing:border-box;transform-origin:0 0}
.priority-quadrant{display:flex;min-width:0;flex-direction:column;overflow:hidden;border:1px solid #dbe4ef;border-radius:12px;background:#fff;box-shadow:0 2px 8px #172b4d0a}
.priority-quadrant>header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 13px;border-bottom:1px solid #e8edf4;background:#f8fafc}
.priority-quadrant>header>div{display:grid;gap:3px}.priority-quadrant>header strong{font-size:13px}.priority-quadrant>header small{color:#748196;font-size:10px}.priority-quadrant>header>b{display:grid;place-items:center;min-width:27px;height:27px;padding:0 5px;border-radius:50%;background:#e9eef5;color:#42536b;font-size:11px}
.quadrant-10>header{border-bottom-color:#fecaca;background:#fff7f7;color:#b91c1c}.quadrant-7>header{border-bottom-color:#bfdbfe;background:#f5f8ff;color:#1e40af}.quadrant-8>header{border-bottom-color:#fecaca;background:#fff8f8;color:#991b1b}.quadrant-6>header{background:#f8fafc;color:#475569}
.quadrant-points{display:flex;flex:1;min-height:0;flex-wrap:wrap;align-content:flex-start;gap:8px;padding:10px;overflow:auto}.priority-quadrant.dense .quadrant-points{align-content:flex-start!important}
.quadrant-10 .quadrant-points,.quadrant-8 .quadrant-points{flex-direction:row-reverse;align-content:flex-end;justify-content:flex-start}.quadrant-7 .quadrant-points,.quadrant-6 .quadrant-points{align-content:flex-end;justify-content:flex-start}.quadrant-8 .quadrant-points,.quadrant-6 .quadrant-points{align-content:flex-start}
.quadrant-point{position:relative;display:flex;align-items:center;gap:9px;width:min(248px,calc(50% - 5px));min-height:76px;padding:10px 12px;border:1px solid transparent;border-radius:11px;color:#fff;cursor:pointer;text-align:left;transition:transform .14s ease,box-shadow .14s ease,border-color .14s ease,filter .14s ease}
.quadrant-point.priority-10{background:#dc2626}.quadrant-point.priority-7{background:#1e40af}.quadrant-point.priority-8{background:#fee2e2;color:#7f1d1d}.quadrant-point.priority-6{background:#f1f5f9;color:#334155}.quadrant-point.completed{border-color:#86efac;background:#dcfce7;color:#166534}
.quadrant-point:hover,.quadrant-point:focus-visible{z-index:3;transform:translateY(-2px);filter:brightness(1.04);outline:2px solid #fff;box-shadow:0 6px 16px #14294a36}.quadrant-point.selected{outline:3px solid #fbbf24;outline-offset:1px;box-shadow:0 0 0 4px #fff7ed,0 7px 20px #ef44445c;animation:plan-point-pulse .8s ease-in-out infinite alternate}.quadrant-point.marked:not(.selected){box-shadow:inset 0 0 0 3px #f59e0b}.quadrant-point[style*="--schedule-strength"]{border-width:2px}
.point-owners{display:flex;align-items:center;flex:none;padding-left:3px}.point-owners>.el-avatar+.el-avatar{margin-left:-11px;border:2px solid #fff}.point-owners>i{display:grid;place-items:center;width:24px;height:24px;margin-left:-9px;border:2px solid #fff;border-radius:50%;background:#e2e8f0;color:#334155;font-size:9px;font-style:normal}
.point-copy{display:grid;gap:4px;min-width:0}.point-copy>strong{overflow:hidden;font-size:12px;line-height:1.35;text-overflow:ellipsis;white-space:nowrap}.point-copy>small{overflow:hidden;font-size:10px;opacity:.84;text-overflow:ellipsis;white-space:nowrap}
.point-sequence{position:absolute;top:-7px;left:-7px;z-index:2;display:grid;place-items:center;width:25px;height:25px;border:2px solid #fff;border-radius:50%;background:#b91c1c;color:#fff;font-size:11px;box-shadow:0 2px 6px #0003}.point-marker{position:absolute;right:7px;top:5px;padding:2px 5px;border-radius:5px;background:#fef3c7;color:#92400e;font-size:9px;font-style:normal;font-weight:700}
.point-hover-card{display:none;position:absolute;left:50%;bottom:calc(100% + 8px);z-index:10;width:270px;padding:12px;border:1px solid #dbe4ef;border-radius:11px;background:#fff;color:#243247;text-align:left;white-space:normal;box-shadow:0 12px 32px #1e293b30;pointer-events:none}.quadrant-point:hover .point-hover-card,.quadrant-point:focus-visible .point-hover-card{display:grid;gap:7px}.point-hover-card>b{font-size:12px}.point-hover-card>small{color:#64748b;font-size:10px}.point-hover-card>span{display:grid;grid-template-columns:24px minmax(0,1fr) auto;align-items:center;gap:6px;padding-top:6px;border-top:1px solid #eef2f7}.point-hover-card>span strong{overflow:hidden;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.point-hover-card>span i{color:#64748b;font-size:9px;font-style:normal}.point-hover-card>span i.done{color:#15803d;font-weight:750}.point-hover-card>em{color:#64748b;font-size:10px;font-style:normal}.point-hover-card>small:last-child{padding-top:4px;color:#2563eb}.quadrant-empty{align-self:center;margin:auto;color:#a0aaba;font-size:12px}
.planning-mode .quadrant-point:hover{animation:plan-point-pulse .8s ease-in-out infinite alternate;outline:3px solid #fff;outline-offset:2px;box-shadow:0 0 0 4px #ef4444,0 0 20px #ef444480}@keyframes plan-point-pulse{from{box-shadow:0 0 0 3px #fff7ed,0 0 12px #f59e0b70}to{box-shadow:0 0 0 4px #fff7ed,0 0 24px #ef4444c0}}
@media(max-width:760px){.heatmap-viewport .quadrant-board{grid-template-columns:repeat(2,minmax(0,1fr))!important;grid-template-rows:repeat(2,340px)!important;grid-auto-rows:initial!important}.heatmap-viewport .quadrant-point{width:min(248px,calc(50% - 5px))!important}.heatmap-viewport .quadrant-10 .quadrant-points,.heatmap-viewport .quadrant-8 .quadrant-points,.heatmap-viewport .quadrant-7 .quadrant-points,.heatmap-viewport .quadrant-6 .quadrant-points{align-content:flex-start!important;justify-content:flex-start!important;flex-direction:row!important}}
</style>

<style scoped>
.heatmap-panel{padding:20px;background:#fff;border:1px solid #e2e8f0;border-radius:16px}.heatmap-heading{margin-bottom:16px}.heatmap-heading h2{font-size:20px}.heatmap-filters{gap:9px;margin-bottom:10px}.heatmap-plan-toolbar{margin-top:10px}.heatmap-plan-toolbar strong{font-size:13px}.heatmap-priority-legend{gap:7px;padding:8px 10px;margin:8px 0;background:#f8fafc}.heatmap-priority-legend>span{padding:5px 9px;border-radius:7px;font-size:11px}.heatmap-priority-legend .priority-10{background:#dc2626;color:#fff}.heatmap-priority-legend .priority-7{background:#1e40af;color:#fff}.heatmap-priority-legend .priority-8{background:#fee2e2;color:#7f1d1d}.heatmap-priority-legend .priority-6{background:#f1f5f9;color:#334155}.heatmap-priority-legend .priority-done{background:#dcfce7;color:#166534;font-weight:700}.heatmap-priority-legend small{font-size:10px;opacity:.82}.heatmap-canvas-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:7px;margin:8px 0;color:#64748b;font-size:12px}.heatmap-canvas-toolbar strong{min-width:42px;text-align:center;color:#334155}.heatmap-canvas-toolbar small{margin-left:8px;color:#94a3b8}.heatmap-viewport{height:min(66vh,680px);min-height:290px;overflow:auto;position:relative;border:1px solid #dbe4ef;border-radius:11px;background:#f4f7fb;cursor:grab;touch-action:none;user-select:none}.heatmap-viewport.is-panning{cursor:grabbing}.heatmap-board-shell{position:relative}.heatmap-board{position:absolute;left:0;top:0;display:grid;grid-auto-rows:76px;gap:1px;padding:1px;transform-origin:0 0;background:#dbe4ef}.heatmap-axis-head,.heatmap-column-head,.heatmap-row-head{display:flex;flex-direction:column;justify-content:center;gap:5px;padding:9px 11px;background:#f8fafc;color:#334155;overflow:hidden}.heatmap-axis-head{position:sticky;left:0;z-index:2;background:#eef3fa;font-size:12px;font-weight:750}.heatmap-column-head{text-align:center;align-items:center;background:#eef3fa}.heatmap-column-head strong,.heatmap-row-head strong{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.heatmap-column-head small,.heatmap-row-head small,.heatmap-axis-head small{color:#7b8798;font-size:10px}.heatmap-row-head{position:sticky;left:0;z-index:1;background:#f8fafc}.heatmap-cell{position:relative;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:4px;min-width:0;width:100%;height:100%;padding:9px 5px;border:0;border-radius:2px;cursor:pointer;overflow:visible;transition:transform .16s,filter .16s,box-shadow .16s;z-index:0}.heatmap-cell:disabled{cursor:default}.heatmap-cell.has-tasks:hover,.heatmap-cell:focus-visible{z-index:8;filter:brightness(1.06);transform:scale(1.035);outline:2px solid #fff;box-shadow:0 4px 14px #172b4d3b}.heatmap-cell>strong{font-size:19px;line-height:1;font-variant-numeric:tabular-nums}.cell-task-count{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:9px;line-height:1.1;text-align:center}.cell-task-count span:first-child{font-weight:700}.cell-task-count .has-completed,.cell-hover-card>span i.done{color:#15803d;font-weight:750}.cell-avatars{display:flex;align-items:center;height:21px;margin-top:1px}.cell-avatars .el-avatar+.el-avatar{margin-left:-6px;border:1px solid #fff}.cell-avatars i{display:grid;place-items:center;width:20px;height:20px;margin-left:-4px;border:1px solid #fff;border-radius:50%;background:#e2e8f0;color:#475569;font-size:8px;font-style:normal}.heatmap-cell.completed{background:#dcfce7!important;color:#166534!important}.heatmap-cell.completed .cell-task-count{color:#166534}.heatmap-cell.selected{outline:3px solid #f59e0b;outline-offset:-4px;box-shadow:0 0 0 3px #fff7ed,0 0 20px #f59e0b80;z-index:3}.heatmap-cell.marked:not(.selected){box-shadow:inset 0 0 0 3px #f59e0b}.cell-sequence{position:absolute;left:5px;top:5px;display:grid;place-items:center;min-width:22px;height:22px;padding:0 4px;border-radius:999px;background:#991b1b;color:#fff;font-size:11px;font-weight:800;box-shadow:0 1px 4px #0003}.cell-marker{position:absolute;right:5px;top:5px;padding:2px 5px;border-radius:5px;background:#fef3c7;color:#92400e;font-size:9px;font-style:normal;font-weight:750}.cell-hover-card{display:none;position:absolute;left:50%;bottom:calc(100% + 8px);z-index:20;width:270px;padding:12px;border:1px solid #dbe4ef;border-radius:11px;background:#fff;color:#243247;text-align:left;white-space:normal;box-shadow:0 12px 32px #1e293b30;pointer-events:none}.heatmap-cell:hover .cell-hover-card,.heatmap-cell:focus-visible .cell-hover-card{display:grid;gap:7px}.cell-hover-card>b{font-size:12px}.cell-hover-card>small{color:#64748b;font-size:10px}.cell-hover-card>span{display:grid;grid-template-columns:24px 1fr auto;align-items:center;gap:6px;padding-top:6px;border-top:1px solid #eef2f7}.cell-hover-card>span strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.cell-hover-card>span i{font-size:9px;color:#64748b;font-style:normal}.cell-hover-card>em{font-size:10px;color:#64748b;font-style:normal}.cell-hover-card>small:last-child{padding-top:4px;color:#2563eb}.planning-mode .heatmap-cell.has-tasks:hover{animation:planning-focus .72s ease-in-out infinite alternate;outline:2px solid #fff;box-shadow:0 0 0 3px #ef4444,0 0 20px #ef444480}.planning-mode .heatmap-cell.selected{animation:selected-pulse .85s ease-in-out infinite alternate}@keyframes planning-focus{from{transform:scale(1.025)}to{transform:scale(1.09);filter:brightness(1.15)}}@keyframes selected-pulse{from{box-shadow:0 0 0 3px #fff7ed,0 0 12px #f59e0b70}to{box-shadow:0 0 0 4px #fff7ed,0 0 24px #ef4444c0}}.heatmap-selected-list article{box-shadow:0 2px 8px #1e293b0a}.detail-owner{display:inline-flex;align-items:center;gap:7px}.heatmap-notes{margin-top:10px}.heatmap-notes p{margin:4px 0;font-size:11px}@media(max-width:760px){.heatmap-panel{padding:13px}.heatmap-heading{flex-direction:column;align-items:flex-start}.heatmap-canvas-toolbar{justify-content:flex-start;flex-wrap:wrap}.heatmap-viewport{height:65vh}.heatmap-priority-legend em{margin-left:0}.heatmap-summary{margin-left:0}}
</style>
