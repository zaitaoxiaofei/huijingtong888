<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
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
const planOrders = ref(new Map()); const selectedCoordinateKeys = ref([]); const selectedCoordinates = ref(new Map());
const zoom = ref(0.78); const viewport = ref(null); const isDragging = ref(false); const dragTimer = ref(null); const dragOrigin = ref(null); const dragged = ref(false);
const unit = computed(() => metric.value === "tasks" ? "个任务" : "个 SKU");
const metricLabel = computed(() => ({ actual: "实际已开发", target: "计划开发", tasks: "开发任务" })[metric.value]);
const periodKey = computed(() => developmentPlanPeriodKey(period.value, range.value || []));
const heatmap = computed(() => buildDevelopmentHeatmap(tasks.value, { metric: metric.value, dimension: dimension.value, scope: scope.value, query: query.value, time: time.value, range: range.value }));
const maxSequence = computed(() => Math.max(1, ...[...planOrders.value.values()].map((item) => Number(item.sequence || 0))));
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
const boardStyle = computed(() => ({ gridTemplateColumns: `190px repeat(${heatmap.value.columns.length}, 148px)`, width: `${190 + heatmap.value.columns.length * 148}px`, transform: `scale(${zoom.value})` }));
const boardShellStyle = computed(() => ({ width: `${(190 + heatmap.value.columns.length * 148) * zoom.value}px`, height: `${(76 + heatmap.value.rows.length * 76) * zoom.value}px` }));
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
  selectedCoordinateKeys.value = selectedCoordinateKeys.value.includes(key)
    ? selectedCoordinateKeys.value.filter((item) => item !== key)
    : [...selectedCoordinateKeys.value, key];
}
function updatePlan(key, field, value) {
  const next = new Map(planOrders.value); const current = next.get(key) || { sequence: null, marked: false };
  next.set(key, { ...current, [field]: field === "sequence" && !Number(value) ? null : value }); planOrders.value = next;
}
function setSelectedMarked(marked) { for (const key of selectedCoordinateKeys.value) updatePlan(key, "marked", marked); }
function setSelectedSequence() { selectedCoordinateKeys.value.forEach((key, index) => updatePlan(key, "sequence", index + 1)); }
async function savePlanOrders() {
  if (!periodKey.value || !selectedCoordinateKeys.value.length) return;
  planSaving.value = true;
  try {
    const entries = selectedCoordinateKeys.value.map((key) => ({ coordinate_key: key, sequence: planOrders.value.get(key)?.sequence ?? null, marked: Boolean(planOrders.value.get(key)?.marked) }));
    await apiClient.put("/api/team/development-heatmap-orders", { period_key: periodKey.value, dimension: dimension.value, entries });
    ElMessage.success(`已保存 ${entries.length} 个开发坐标，本周期任务中心将同步排序`);
    selectedCoordinateKeys.value = []; selectedCoordinates.value = new Map(); await loadPlanOrders();
  } catch (err) { ElMessage.error(err.message || "开发顺序保存失败"); }
  finally { planSaving.value = false; }
}
function priorityLabel(score) { return ({ 10: "紧急重要", 8: "紧急不重要", 7: "重要不紧急", 6: "不紧急不重要" })[score] || "重要不紧急"; }
function cellStyle(row, column, cell) {
  if (!cell.value && !cell.tasks.size) return {};
  if (cell.tasks.size && completedCount(cell) === cell.tasks.size) return { backgroundColor: "#dcfce7", color: "#166534" };
  const plan = cellPlan(row, column);
  if (Number(plan.sequence) > 0) {
    const weight = 1 - (Number(plan.sequence) - 1) / maxSequence.value;
    return { backgroundColor: `hsl(4 78% ${92 - weight * 34}%)`, color: weight > .58 ? "#fff" : "#7f1d1d" };
  }
  return ({ 10: { backgroundColor: "#dc2626", color: "#fff" }, 8: { backgroundColor: "#fee2e2", color: "#7f1d1d" }, 7: { backgroundColor: "#1e40af", color: "#fff" }, 6: { backgroundColor: "#f1f5f9", color: "#334155" } })[cell.priorityScore] || {};
}
function cellClass(row, column, cell) {
  const plan = cellPlan(row, column);
  return { selected: selectedCoordinateKeys.value.includes(coordinateFor(row, column).coordinate_key), marked: plan.marked, ordered: Number(plan.sequence) > 0, completed: cell.tasks.size > 0 && completedCount(cell) === cell.tasks.size, [`priority-${cell.priorityScore}`]: cell.tasks.size > 0 };
}
function showCell(row, column) {
  const cell = heatmap.value.cell(row, column.label);
  const tasks = [...cell.tasks.values()].map((task) => ({ task, modelIndex: modelIndexFor(task, row, column) }))
    .sort((a, b) => ({ urgent_important: 10, high: 10, urgent_unimportant: 8, important_not_urgent: 7, medium: 7, not_urgent_unimportant: 6, low: 6 }[b.task.priority] || 7) - ({ urgent_important: 10, high: 10, urgent_unimportant: 8, important_not_urgent: 7, medium: 7, not_urgent_unimportant: 6, low: 6 }[a.task.priority] || 7));
  detail.value = { title: `${row.label} · ${column.label}`, value: cell.value, priority: priorityLabel(cell.priorityScore), tasks, drafts: cell.drafts, dimension: dimension.value };
}
function removeSelected(key) { selectedCoordinateKeys.value = selectedCoordinateKeys.value.filter((item) => item !== key); }
function cellTasks(cell) { return [...cell.tasks.values()]; }
function completedCount(cell) { return cellTasks(cell).filter((task) => task.status === "done").length; }
function taskOwners(cell) {
  const owners = new Map();
  for (const task of cellTasks(cell)) if (task.owner_name && !owners.has(task.owner_person_id || task.owner_name)) owners.set(task.owner_person_id || task.owner_name, task);
  return [...owners.values()];
}
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
function beginPan(event) {
  if (event.button !== 0) return;
  clearTimeout(dragTimer.value); dragged.value = false;
  dragOrigin.value = { x: event.clientX, y: event.clientY, left: viewport.value.scrollLeft, top: viewport.value.scrollTop, pointerId: event.pointerId };
  dragTimer.value = setTimeout(() => { isDragging.value = true; viewport.value?.setPointerCapture(event.pointerId); }, 180);
}
function movePan(event) {
  if (!dragOrigin.value) return;
  if (isDragging.value) {
    dragged.value = true; viewport.value.scrollLeft = dragOrigin.value.left - (event.clientX - dragOrigin.value.x); viewport.value.scrollTop = dragOrigin.value.top - (event.clientY - dragOrigin.value.y);
  } else if (Math.hypot(event.clientX - dragOrigin.value.x, event.clientY - dragOrigin.value.y) > 8) clearTimeout(dragTimer.value);
}
function endPan() { clearTimeout(dragTimer.value); isDragging.value = false; dragOrigin.value = null; }
function handleCellClick(row, column) {
  if (dragged.value) { dragged.value = false; return; }
  if (planningMode.value) return toggleCoordinate(row, column);
  const cell = heatmap.value.cell(row, column.label);
  const items = [...cell.tasks.values()].map((task) => ({ task, modelIndex: modelIndexFor(task, row, column) }));
  if (items.length === 1) return emitEdit(items[0]);
  showCell(row, column);
}
function emitEdit(item) { emit("open-task", { task: item.task, modelIndex: item.modelIndex, dimension: dimension.value }); detail.value = null; }
defineExpose({ reload: load });
watch([periodKey, dimension], () => { selectedCoordinateKeys.value = []; selectedCoordinates.value = new Map(); loadPlanOrders(); });
onMounted(() => { setPeriod("month"); load(); });
</script>

<template>
  <section class="heatmap-panel" v-loading="loading">
    <header class="heatmap-heading"><div><h2>开发分布热力图</h2><p>横向是核心品名，纵向切换品牌或车型；本周 / 本月统计计划完成日，逾期未完成任务按任务中心规则每周顺延。</p></div><div><el-button @click="load">刷新</el-button><el-button v-if="periodKey" :type="planningMode ? 'warning' : 'default'" @click="togglePlanningMode">{{ planningMode ? '退出排程' : '人工排程' }}</el-button><el-button type="primary" @click="emit('create')">新增开发任务</el-button></div></header>
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
      <span>长按坐标可拖动画布；滚轮缩放。选中任务可批量标记或编号。</span>
      <el-button size="small" :disabled="!selectedPlanCells.length" @click="setSelectedMarked(true)">标记</el-button>
      <el-button size="small" :disabled="!selectedPlanCells.length" @click="setSelectedMarked(false)">取消标记</el-button>
      <el-button size="small" type="primary" plain :disabled="!selectedPlanCells.length" @click="setSelectedSequence">按选择顺序编号</el-button>
      <el-button size="small" type="primary" :loading="planSaving" :disabled="!selectedPlanCells.length" @click="savePlanOrders">保存排程</el-button>
    </div>
    <div v-if="planningMode && selectedPlanCells.length" class="heatmap-selected-list">
      <article v-for="item in selectedPlanCells" :key="item.key"><strong>{{ item.label }}</strong><label>顺序 <el-input-number :model-value="item.sequence" :min="1" :max="9999" :step="1" controls-position="right" @update:model-value="value => updatePlan(item.key,'sequence',value)" /></label><label>标记 <el-switch :model-value="item.marked" @update:model-value="value => updatePlan(item.key,'marked',value)" /></label><el-button link type="danger" @click="removeSelected(item.key)">移除</el-button></article>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false"><el-button @click="load">重新加载</el-button></el-alert>
    <template v-else>
      <div class="heatmap-priority-legend"><strong>优先级</strong><span class="priority-10">紧急重要 <small>{{ priorityQuadrants.find(item => item.score === 10)?.count || 0 }}</small></span><span class="priority-7">重要不紧急 <small>{{ priorityQuadrants.find(item => item.score === 7)?.count || 0 }}</small></span><span class="priority-8">紧急不重要 <small>{{ priorityQuadrants.find(item => item.score === 8)?.count || 0 }}</small></span><span class="priority-6">不重要不紧急 <small>{{ priorityQuadrants.find(item => item.score === 6)?.count || 0 }}</small></span><span class="priority-done">已完成</span><em>横向核心品名 · 纵向{{ dimension === 'model' ? '车型' : '品牌' }}</em></div>
      <div class="heatmap-canvas-toolbar" v-if="heatmap.rows.length && heatmap.columns.length"><span>缩放</span><el-button circle size="small" aria-label="缩小热力图" @click="zoomBy(-0.08)">−</el-button><strong>{{ Math.round(zoom * 100) }}%</strong><el-button circle size="small" aria-label="放大热力图" @click="zoomBy(0.08)">＋</el-button><el-button size="small" @click="zoom = 0.78">重置</el-button><small>滚轮缩放 · 长按空白处拖动</small></div>
      <div v-if="heatmap.rows.length && heatmap.columns.length" ref="viewport" class="heatmap-viewport" :class="{ 'is-panning': isDragging, 'planning-mode': planningMode }" @wheel.prevent="handleZoomWheel" @pointerdown="beginPan" @pointermove="movePan" @pointerup="endPan" @pointercancel="endPan" @lostpointercapture="endPan">
        <div class="heatmap-board-shell" :style="boardShellStyle"><div class="heatmap-board" :style="boardStyle">
          <div class="heatmap-axis-head">{{ dimension === 'model' ? '品牌 / 车型' : '品牌' }}<small>优先级 · 完成状态</small></div>
          <div v-for="column in heatmap.columns" :key="column.label" class="heatmap-column-head"><strong>{{ column.label }}</strong><small>{{ column.total }} {{ unit }}</small></div>
          <template v-for="row in heatmap.rows" :key="row.id">
            <div class="heatmap-row-head"><strong>{{ row.label }}</strong><small>{{ row.total }} {{ unit }}</small></div>
            <button v-for="column in heatmap.columns" :key="`${row.id}-${column.label}`" class="heatmap-cell" :class="[cellClass(row,column,heatmap.cell(row,column.label)), { 'has-tasks': heatmap.cell(row,column.label).tasks.size }]" :style="cellStyle(row,column,heatmap.cell(row,column.label))" :aria-label="`${row.label} · ${column.label}：${heatmap.cell(row,column.label).value} ${unit}`" :disabled="planningMode && !heatmap.cell(row,column.label).tasks.size" @click="handleCellClick(row,column)">
              <i v-if="cellPlan(row,column).marked" class="cell-marker">标记</i><b v-if="cellPlan(row,column).sequence" class="cell-sequence">{{ cellPlan(row,column).sequence }}</b>
              <strong>{{ heatmap.cell(row,column.label).value }}</strong>
              <small v-if="heatmap.cell(row,column.label).tasks.size" class="cell-task-count"><span :class="{ 'has-completed': completedCount(heatmap.cell(row,column.label)) > 0 }">{{ completedCount(heatmap.cell(row,column.label)) }}/{{ heatmap.cell(row,column.label).tasks.size }} 完成</span><span>{{ priorityLabel(heatmap.cell(row,column.label).priorityScore) }}</span></small><small v-else class="cell-empty">暂无开发</small>
              <span v-if="taskOwners(heatmap.cell(row,column.label)).length" class="cell-avatars"><el-avatar v-for="task in taskOwners(heatmap.cell(row,column.label)).slice(0,3)" :key="task.owner_person_id || task.owner_name" :src="task.owner_avatar_url" :size="20">{{ task.owner_name?.slice(0,1) }}</el-avatar><i v-if="taskOwners(heatmap.cell(row,column.label)).length > 3">+{{ taskOwners(heatmap.cell(row,column.label)).length - 3 }}</i></span>
              <span v-if="heatmap.cell(row,column.label).tasks.size" class="cell-hover-card"><b>{{ row.label }} · {{ column.label }}</b><small>{{ heatmap.cell(row,column.label).tasks.size }} 个任务 · {{ completedCount(heatmap.cell(row,column.label)) }} 个已完成</small><span v-for="task in cellTasks(heatmap.cell(row,column.label)).slice(0,4)" :key="task.id"><el-avatar :src="task.owner_avatar_url" :size="22">{{ task.owner_name?.slice(0,1) || '?' }}</el-avatar><strong>{{ task.title }}</strong><i :class="{ done: task.status === 'done' }">{{ taskStatusLabel(task) }}</i></span><em v-if="heatmap.cell(row,column.label).tasks.size > 4">另有 {{ heatmap.cell(row,column.label).tasks.size - 4 }} 个任务</em><small>点击{{ planningMode ? '选择排程' : dimension === 'model' ? '编辑本车型进度' : '编辑任务' }}</small></span>
            </button>
          </template>
        </div></div>
      </div>
      <el-empty v-else-if="!loading" description="当前范围暂无可归类的开发记录，可调整时间或新增开发任务" />
      <footer class="heatmap-notes"><span>长按 {{ dimension === 'model' ? '车型' : '品牌' }}坐标可拖动画布，滚轮缩放；悬浮查看负责人、状态和明细。</span><p>北京时间。{{ metric === 'actual' ? '已开发数量按关联草稿的当前变体数统计，同一草稿去重，店铺副本不重复计数；这不是历史时点快照。' : metric === 'target' ? '计划数量按各车型设置的 SKU 目标汇总。' : '每格按任务去重；跨车型任务可能出现在多个格子，顶部总任务数去重。' }}</p><p v-if="heatmap.unclassified">当前任务日期范围内有 {{ heatmap.unclassified }} 个旧开发任务缺少品牌／车型／类目；切换“开发任务数”查看“未分类”，不将其自动归入非汽车。</p><p v-if="heatmap.conflicts" class="heatmap-warning">{{ heatmap.conflicts }} 份草稿关联到了多个不同坐标，已排除重复归属；请在任务详情中修正关联。</p></footer>
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
.heatmap-panel{padding:20px;background:#fff;border:1px solid #e2e8f0;border-radius:16px}.heatmap-heading{margin-bottom:16px}.heatmap-heading h2{font-size:20px}.heatmap-filters{gap:9px;margin-bottom:10px}.heatmap-plan-toolbar{margin-top:10px}.heatmap-plan-toolbar strong{font-size:13px}.heatmap-priority-legend{gap:7px;padding:8px 10px;margin:8px 0;background:#f8fafc}.heatmap-priority-legend>span{padding:5px 9px;border-radius:7px;font-size:11px}.heatmap-priority-legend .priority-10{background:#dc2626;color:#fff}.heatmap-priority-legend .priority-7{background:#1e40af;color:#fff}.heatmap-priority-legend .priority-8{background:#fee2e2;color:#7f1d1d}.heatmap-priority-legend .priority-6{background:#f1f5f9;color:#334155}.heatmap-priority-legend .priority-done{background:#dcfce7;color:#166534;font-weight:700}.heatmap-priority-legend small{font-size:10px;opacity:.82}.heatmap-canvas-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:7px;margin:8px 0;color:#64748b;font-size:12px}.heatmap-canvas-toolbar strong{min-width:42px;text-align:center;color:#334155}.heatmap-canvas-toolbar small{margin-left:8px;color:#94a3b8}.heatmap-viewport{height:min(66vh,680px);min-height:290px;overflow:auto;position:relative;border:1px solid #dbe4ef;border-radius:11px;background:#f4f7fb;cursor:grab;touch-action:none;user-select:none}.heatmap-viewport.is-panning{cursor:grabbing}.heatmap-board-shell{position:relative}.heatmap-board{position:absolute;left:0;top:0;display:grid;grid-auto-rows:76px;gap:1px;padding:1px;transform-origin:0 0;background:#dbe4ef}.heatmap-axis-head,.heatmap-column-head,.heatmap-row-head{display:flex;flex-direction:column;justify-content:center;gap:5px;padding:9px 11px;background:#f8fafc;color:#334155;overflow:hidden}.heatmap-axis-head{position:sticky;left:0;z-index:2;background:#eef3fa;font-size:12px;font-weight:750}.heatmap-column-head{text-align:center;align-items:center;background:#eef3fa}.heatmap-column-head strong,.heatmap-row-head strong{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.heatmap-column-head small,.heatmap-row-head small,.heatmap-axis-head small{color:#7b8798;font-size:10px}.heatmap-row-head{position:sticky;left:0;z-index:1;background:#f8fafc}.heatmap-cell{position:relative;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:4px;min-width:0;width:100%;height:100%;padding:9px 5px;border:0;border-radius:2px;cursor:pointer;overflow:visible;transition:transform .16s,filter .16s,box-shadow .16s;z-index:0}.heatmap-cell:disabled{cursor:default}.heatmap-cell.has-tasks:hover,.heatmap-cell:focus-visible{z-index:8;filter:brightness(1.06);transform:scale(1.035);outline:2px solid #fff;box-shadow:0 4px 14px #172b4d3b}.heatmap-cell>strong{font-size:19px;line-height:1;font-variant-numeric:tabular-nums}.cell-task-count{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:9px;line-height:1.1;text-align:center}.cell-task-count span:first-child{font-weight:700}.cell-task-count .has-completed,.cell-hover-card>span i.done{color:#15803d;font-weight:750}.cell-avatars{display:flex;align-items:center;height:21px;margin-top:1px}.cell-avatars .el-avatar+.el-avatar{margin-left:-6px;border:1px solid #fff}.cell-avatars i{display:grid;place-items:center;width:20px;height:20px;margin-left:-4px;border:1px solid #fff;border-radius:50%;background:#e2e8f0;color:#475569;font-size:8px;font-style:normal}.heatmap-cell.completed{background:#dcfce7!important;color:#166534!important}.heatmap-cell.completed .cell-task-count{color:#166534}.heatmap-cell.selected{outline:3px solid #f59e0b;outline-offset:-4px;box-shadow:0 0 0 3px #fff7ed,0 0 20px #f59e0b80;z-index:3}.heatmap-cell.marked:not(.selected){box-shadow:inset 0 0 0 3px #f59e0b}.cell-sequence{position:absolute;left:5px;top:5px;display:grid;place-items:center;min-width:22px;height:22px;padding:0 4px;border-radius:999px;background:#991b1b;color:#fff;font-size:11px;font-weight:800;box-shadow:0 1px 4px #0003}.cell-marker{position:absolute;right:5px;top:5px;padding:2px 5px;border-radius:5px;background:#fef3c7;color:#92400e;font-size:9px;font-style:normal;font-weight:750}.cell-hover-card{display:none;position:absolute;left:50%;bottom:calc(100% + 8px);z-index:20;width:270px;padding:12px;border:1px solid #dbe4ef;border-radius:11px;background:#fff;color:#243247;text-align:left;white-space:normal;box-shadow:0 12px 32px #1e293b30;pointer-events:none}.heatmap-cell:hover .cell-hover-card,.heatmap-cell:focus-visible .cell-hover-card{display:grid;gap:7px}.cell-hover-card>b{font-size:12px}.cell-hover-card>small{color:#64748b;font-size:10px}.cell-hover-card>span{display:grid;grid-template-columns:24px 1fr auto;align-items:center;gap:6px;padding-top:6px;border-top:1px solid #eef2f7}.cell-hover-card>span strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.cell-hover-card>span i{font-size:9px;color:#64748b;font-style:normal}.cell-hover-card>em{font-size:10px;color:#64748b;font-style:normal}.cell-hover-card>small:last-child{padding-top:4px;color:#2563eb}.planning-mode .heatmap-cell.has-tasks:hover{animation:planning-focus .72s ease-in-out infinite alternate;outline:2px solid #fff;box-shadow:0 0 0 3px #ef4444,0 0 20px #ef444480}.planning-mode .heatmap-cell.selected{animation:selected-pulse .85s ease-in-out infinite alternate}@keyframes planning-focus{from{transform:scale(1.025)}to{transform:scale(1.09);filter:brightness(1.15)}}@keyframes selected-pulse{from{box-shadow:0 0 0 3px #fff7ed,0 0 12px #f59e0b70}to{box-shadow:0 0 0 4px #fff7ed,0 0 24px #ef4444c0}}.heatmap-selected-list article{box-shadow:0 2px 8px #1e293b0a}.detail-owner{display:inline-flex;align-items:center;gap:7px}.heatmap-notes{margin-top:10px}.heatmap-notes p{margin:4px 0;font-size:11px}@media(max-width:760px){.heatmap-panel{padding:13px}.heatmap-heading{flex-direction:column;align-items:flex-start}.heatmap-canvas-toolbar{justify-content:flex-start;flex-wrap:wrap}.heatmap-viewport{height:65vh}.heatmap-priority-legend em{margin-left:0}.heatmap-summary{margin-left:0}}
</style>
