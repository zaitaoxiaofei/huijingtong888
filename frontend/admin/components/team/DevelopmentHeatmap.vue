<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api.js";
import { shanghaiDateKey, shanghaiDateText, shanghaiMonthStart } from "../../utils/shanghai-date.js";
import { buildDevelopmentHeatmap, developmentCoordinateKey, developmentPlanPeriodKey } from "../../utils/development-heatmap.js";

const emit = defineEmits(["open-task", "create"]);
const tasks = ref([]); const loading = ref(false); const error = ref("");
const metric = ref("tasks"); const dimension = ref("model"); const scope = ref("all"); const query = ref(""); const includeCompleted = ref(false); const viewMode = ref("quadrant"); const expandedQuadrantScore = ref(null); const draggedPoint = ref(null); const prioritySaving = ref(false);
const period = ref("month"); const time = ref("due");
const range = ref([shanghaiMonthStart(), shanghaiDateKey()]);
const detail = ref(null); const planningMode = ref(false); const planSaving = ref(false);
const planOrders = ref(new Map()); const selectedCoordinateKeys = ref([]); const selectedCoordinates = ref(new Map()); const pendingPlanKeys = ref(new Set());
const avatarFailures = ref(new Set());
const zoom = ref(1); const viewport = ref(null); const canvasWidth = ref(1200); const isDragging = ref(false); const dragOrigin = ref(null); const dragged = ref(false); const activeDropScore = ref(null);
let resizeObserver;
const unit = computed(() => metric.value === "tasks" ? "个任务" : "个 SKU");
const metricLabel = computed(() => ({ actual: "实际已开发", target: "计划开发", tasks: "开发任务" })[metric.value]);
const periodKey = computed(() => developmentPlanPeriodKey(period.value, range.value || []));
const heatmap = computed(() => buildDevelopmentHeatmap(tasks.value, { metric: metric.value, dimension: dimension.value, scope: scope.value, query: query.value, time: time.value, range: range.value, includeCompleted: includeCompleted.value }));
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
const priorityRingLayout = computed(() => {
  const nodeSpacing = 124;
  let boundary = 0;
  const bands = quadrantCards.value.map((group, index) => {
    const points = group.points;
    const placements = [];
    let remaining = points.length;
    let lastRadius = 0;
    let lane = 0;
    if (index === 0 && remaining) {
      if (remaining === 1) {
        placements.push({ point: points[0], radius: 0, angle: 0 });
        remaining = 0;
      } else {
        lastRadius = 78;
      }
    } else if (index > 0 && remaining) {
      lastRadius = boundary + 84;
    }
    while (remaining > 0) {
      const capacity = Math.max(2, Math.floor((Math.PI * 2 * lastRadius) / nodeSpacing));
      const laneCount = Math.min(remaining, capacity);
      for (let offset = 0; offset < laneCount; offset += 1) {
        const angle = -Math.PI / 2 + (Math.PI / laneCount) + (offset * Math.PI * 2) / laneCount + (lane % 2 ? Math.PI / capacity : 0);
        placements.push({ point: points[points.length - remaining + offset], radius: lastRadius, angle });
      }
      remaining -= laneCount;
      if (remaining > 0) { lane += 1; lastRadius += 112; }
    }
    const minimumBand = index === 0 ? 150 : 154;
    const outerRadius = Math.max(boundary + minimumBand, lastRadius + 70);
    const band = { ...group, innerRadius: boundary, outerRadius, placements };
    boundary = outerRadius;
    return band;
  });
  const diameter = Math.max(900, Math.ceil((boundary + 100) * 2));
  const center = diameter / 2;
  return {
    diameter,
    center,
    bands: bands.map((band) => ({
      ...band,
      placements: band.placements.map((item) => ({
        ...item,
        x: center + Math.cos(item.angle) * item.radius,
        y: center + Math.sin(item.angle) * item.radius
      }))
    }))
  };
});
const visibleRingBands = computed(() => priorityRingLayout.value.bands.map((band) => ({
  ...band,
  placements: band.score === expandedQuadrantScore.value || expandedQuadrantScore.value == null ? band.placements : []
})));
const boardWidth = computed(() => viewMode.value === "coordinates" ? Math.max(canvasWidth.value, 190 + heatmap.value.columns.length * 158) : viewMode.value === "quadrant" ? Math.max(canvasWidth.value, priorityRingLayout.value.diameter) : canvasWidth.value);
const boardHeight = computed(() => viewMode.value === "coordinates" ? 58 + heatmap.value.rows.length * 100 : viewMode.value === "quadrant" ? Math.max(696, priorityRingLayout.value.diameter) : 696);
const boardShellStyle = computed(() => ({ width: `${boardWidth.value * zoom.value}px`, height: `${boardHeight.value * zoom.value}px` }));
const coordinateBoardStyle = computed(() => ({ width: `${boardWidth.value}px`, gridTemplateColumns: `190px repeat(${heatmap.value.columns.length}, minmax(150px, 1fr))`, gridTemplateRows: `58px repeat(${heatmap.value.rows.length}, 100px)`, transform: `scale(${zoom.value})` }));
const quadrantLabels = [
  { score: 10, label: "紧急重要" },
  { score: 8, label: "紧急不重要" },
  { score: 7, label: "重要不紧急" },
  { score: 6, label: "不紧急不重要" }
];
const priorityQuadrants = computed(() => quadrantLabels.map((item) => ({ ...item, count: heatmap.value.quadrants.find((row) => row.score === item.score)?.count || 0 })));
const priorityFilters = computed(() => [{ score: null, label: "全部", count: heatmap.value.taskCount }, ...priorityQuadrants.value]);

function ringTaskCount(band) { return new Set(band.placements.flatMap((item) => [...item.point.cell.tasks.keys()])).size; }
function setViewMode(value) { viewMode.value = value; expandedQuadrantScore.value = null; resetZoom(); }
function setPriorityFilter(score) { expandedQuadrantScore.value = score; resetZoom(); }
function startPriorityDrag(event, point, score) {
  if (planningMode.value) { event.preventDefault(); return; }
  draggedPoint.value = { point, score };
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", point.coordinate.coordinate_key);
}
function endPriorityDrag() { draggedPoint.value = null; activeDropScore.value = null; }
function setPriorityDropTarget(event, score) {
  if (!draggedPoint.value || score == null || score === draggedPoint.value.score) return;
  activeDropScore.value = score;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}
async function movePointToPriority(score) {
  const drag = draggedPoint.value;
  if (!drag || score === drag.score || prioritySaving.value) return;
  const ids = cellTasks(drag.point.cell).filter((task) => !["done", "closed", "cancelled"].includes(task.status)).map((task) => Number(task.id)).filter(Boolean);
  if (!ids.length) return ElMessage.info("这个坐标没有未完成任务可调整");
  const priority = ({ 10: "urgent_important", 8: "urgent_unimportant", 7: "important_not_urgent", 6: "not_urgent_unimportant" })[score];
  prioritySaving.value = true;
  try {
    await apiClient.put("/api/team/development-task-priority", { task_ids: ids, priority });
    ElMessage.success(`已调整 ${ids.length} 个任务的优先级为${priorityLabel(score)}`);
    draggedPoint.value = null;
    await load();
    setPriorityFilter(score);
  } catch (err) { ElMessage.error(err.message || "优先级调整失败，请刷新重试"); }
  finally { prioritySaving.value = false; }
}
function ringScoreAtPointer(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const layout = priorityRingLayout.value;
  const scaleX = rect.width / layout.diameter;
  const scaleY = rect.height / layout.diameter;
  const x = (event.clientX - rect.left) / scaleX;
  const y = (event.clientY - rect.top) / scaleY;
  const radius = Math.hypot(x - layout.center, y - layout.center);
  return layout.bands.find((band) => radius <= band.outerRadius)?.score ?? null;
}
function handleRingDragOver(event) {
  if (!draggedPoint.value) return;
  const score = ringScoreAtPointer(event);
  activeDropScore.value = score != null && score !== draggedPoint.value.score ? score : null;
  if (activeDropScore.value && event.dataTransfer) event.dataTransfer.dropEffect = "move";
}
async function dropOnRing(event) {
  if (!draggedPoint.value) return;
  const score = activeDropScore.value ?? ringScoreAtPointer(event);
  if (score != null && score !== draggedPoint.value.score) await movePointToPriority(score);
  activeDropScore.value = null;
}

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
  if (event.target.closest("button, .el-button, .el-select, .el-radio-button, .el-switch, .el-date-editor, .el-input")) return;
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
watch([periodKey, dimension], () => { selectedCoordinateKeys.value = []; selectedCoordinates.value = new Map(); pendingPlanKeys.value = new Set(); expandedQuadrantScore.value = null; loadPlanOrders(); });
watch(() => heatmap.value.rows.length, fitCanvas);
watch(viewport, (element) => { if (element) resizeObserver?.observe(element); }, { flush: "post" });
onMounted(() => { setPeriod("month"); load(); fitCanvas(); resizeObserver = new ResizeObserver(fitCanvas); if (viewport.value) resizeObserver.observe(viewport.value); });
onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<template>
  <section class="heatmap-panel" v-loading="loading">
    <header class="heatmap-heading"><div><h2>开发分布热力图</h2><p>同心优先级环由中心向外展示紧急重要、重要不紧急、紧急不重要、不重要不紧急；顶部筛选可聚焦，拖到目标环或优先级标签即可调整。</p></div><div><el-button @click="load">刷新</el-button><el-button v-if="periodKey" :type="planningMode ? 'warning' : 'default'" @click="togglePlanningMode">{{ planningMode ? '退出排程' : '人工排程' }}</el-button><el-button type="primary" @click="emit('create')">新增开发任务</el-button></div></header>
    <div class="heatmap-filterbar">
      <el-select :model-value="period" aria-label="统计周期" @change="setPeriod"><el-option label="本周" value="week" /><el-option label="本月" value="month" /><el-option label="本季度" value="quarter" /><el-option label="本年" value="year" /><el-option label="全部时间" value="all" /><el-option label="自定义" value="custom" /></el-select>
      <el-date-picker v-if="period !== 'all'" v-model="range" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" :clearable="false" @change="period = 'custom'" />
      <el-select v-model="metric" aria-label="统计数量" @change="setMetric"><el-option label="开发任务数" value="tasks" /><el-option label="计划开发 SKU" value="target" /><el-option label="实际已开发 SKU" value="actual" /></el-select>
      <el-select v-model="time" aria-label="统计日期"><el-option v-if="metric === 'actual'" label="按草稿时间" value="draft" /><el-option label="按计划完成日期" value="due" /><el-option label="按任务创建时间" value="created" /></el-select>
      <el-radio-group v-model="dimension" aria-label="显示颗粒度"><el-radio-button value="model">车型</el-radio-button><el-radio-button value="brand">品牌</el-radio-button></el-radio-group>
      <el-select v-model="scope" aria-label="开发范围"><el-option label="全部范围" value="all" /><el-option label="汽车" value="automotive" /><el-option label="非汽车" value="non_automotive" /><el-option label="未分类" value="unknown" /></el-select>
      <el-input v-model="query" aria-label="搜索开发任务" clearable placeholder="搜索核心品名 / 品牌 / 车型" />
      <label class="completed-filter"><span>含已完成</span><el-switch v-model="includeCompleted" aria-label="包含已完成任务" /></label>
      <el-radio-group :model-value="viewMode" class="view-mode-switch" aria-label="热力图视图" @change="setViewMode"><el-radio-button value="quadrant">四象限</el-radio-button><el-radio-button value="coordinates">横纵坐标</el-radio-button></el-radio-group>
      <span class="heatmap-summary"><b>{{ heatmap.taskCount }}</b> 个任务 · {{ heatmap.rows.length }} × {{ heatmap.columns.length }}</span>
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
      <div class="heatmap-priority-legend priority-filter-bar"><strong>优先级</strong><button v-for="filter in priorityFilters" :key="filter.score ?? 'all'" type="button" class="priority-filter" :class="[filter.score == null ? 'priority-all' : `priority-${filter.score}`, { active: expandedQuadrantScore === filter.score, 'drop-target-active': activeDropScore === filter.score }]" :data-score="filter.score ?? 'all'" :aria-label="`筛选优先级：${filter.label}`" :aria-pressed="expandedQuadrantScore === filter.score" @click="setPriorityFilter(filter.score)" @dragover.prevent="setPriorityDropTarget($event, filter.score)" @dragleave="activeDropScore === filter.score && (activeDropScore = null)" @drop.prevent.stop="filter.score != null && movePointToPriority(filter.score)">{{ filter.label }} <small>{{ filter.count }}</small></button><em>{{ draggedPoint ? '拖到优先级标签或目标环即可调整' : viewMode === 'quadrant' ? '全部显示四层环；拖动圆形任务点到目标环或标签调整优先级' : '横向核心品名 · 纵向' + (dimension === 'model' ? '车型' : '品牌') }}</em></div>
      <div class="heatmap-canvas-toolbar" v-if="heatmap.rows.length && heatmap.columns.length && (viewMode === 'coordinates' || viewMode === 'quadrant' || expandedQuadrantScore !== null)"><span>缩放</span><el-button circle size="small" aria-label="缩小热力图" @click="zoomBy(-0.08)">−</el-button><strong>{{ Math.round(zoom * 100) }}%</strong><el-button circle size="small" aria-label="放大热力图" @click="zoomBy(0.08)">＋</el-button><el-button size="small" @click="resetZoom">重置</el-button><small>滚轮缩放 · 左键拖动画布</small></div>
      <div v-if="heatmap.rows.length && heatmap.columns.length" ref="viewport" class="heatmap-viewport" :class="{ 'is-panning': isDragging, 'planning-mode': planningMode }" @wheel.prevent="handleZoomWheel" @pointerdown="beginPan" @pointermove="movePan" @pointerup="endPan" @pointercancel="endPan" @lostpointercapture="endPan">
        <div v-if="viewMode === 'quadrant'" class="heatmap-board-shell ring-board-shell" :style="boardShellStyle">
          <div class="priority-rings-canvas" :style="{ width: `${priorityRingLayout.diameter}px`, height: `${priorityRingLayout.diameter}px`, left: `${((boardWidth - priorityRingLayout.diameter) / 2) * zoom}px`, top: `${((boardHeight - priorityRingLayout.diameter) / 2) * zoom}px`, transform: `scale(${zoom})` }" @dragover.prevent="handleRingDragOver" @drop.prevent="dropOnRing">
            <div v-for="band in [...visibleRingBands].reverse()" :key="`ring-zone-${band.score}`" class="priority-ring-zone" :class="[`priority-${band.score}`, { 'drop-target-active': activeDropScore === band.score }]" :style="{ width: `${band.outerRadius * 2}px`, height: `${band.outerRadius * 2}px`, left: `${priorityRingLayout.center - band.outerRadius}px`, top: `${priorityRingLayout.center - band.outerRadius}px` }" aria-hidden="true"></div>
            <div v-for="band in visibleRingBands" :key="`ring-label-${band.score}`" class="priority-ring-label" :class="`priority-${band.score}`" :style="{ left: `${priorityRingLayout.center}px`, top: `${priorityRingLayout.center - band.outerRadius + 9}px` }"><strong>{{ band.label }}</strong><small>{{ band.placements.length }} 个点位 · {{ ringTaskCount(band) }} 个任务</small></div>
            <template v-for="band in visibleRingBands" :key="`ring-points-${band.score}`"><button v-for="item in band.placements" :key="item.point.coordinate.coordinate_key" :draggable="!planningMode" class="quadrant-point ring-point" :class="[{ selected: selectedCoordinateKeys.includes(item.point.coordinate.coordinate_key), marked: item.point.plan.marked, completed: completedCount(item.point.cell) === item.point.cell.tasks.size }, `priority-${band.score}`]" :style="{ ...pointStyle(item.point), left: `${item.x}px`, top: `${item.y}px` }" :aria-label="`${item.point.title}：${item.point.cell.value} ${unit}`" @click="handleCellClick(item.point.row,item.point.column)" @contextmenu="cancelCoordinate($event,item.point.row,item.point.column)" @dragstart="startPriorityDrag($event,item.point,band.score)" @dragend="endPriorityDrag">
              <b v-if="item.point.plan.sequence" class="point-sequence">{{ item.point.plan.sequence }}</b><i v-if="item.point.plan.marked" class="point-marker">标记</i>
              <span class="point-owners"><el-avatar v-for="task in taskOwners(item.point.cell).slice(0,2)" :key="avatarKey(task)" :src="avatarFailures.has(avatarKey(task)) ? '' : task.owner_avatar_url" :size="42" @error="handleAvatarError(task)">{{ task.owner_name?.slice(0,1) || '?' }}</el-avatar><el-avatar v-if="!taskOwners(item.point.cell).length" :size="42">?</el-avatar></span>
              <span class="point-copy"><strong>{{ item.point.title }}</strong><small>{{ item.point.cell.tasks.size }} 个任务 · {{ item.point.cell.value }} {{ unit }}</small></span>
              <span class="point-hover-card"><b>{{ item.point.title }}</b><small>{{ dimension === 'model' ? '车型' : '品牌' }}颗粒度 · {{ item.point.cell.tasks.size }} 个未完成任务</small><span v-for="task in cellTasks(item.point.cell).slice(0,4)" :key="task.id"><el-avatar :src="task.owner_avatar_url" :size="22">{{ task.owner_name?.slice(0,1) || '?' }}</el-avatar><strong>{{ task.title }}</strong><i>{{ taskStatusLabel(task) }}</i></span><em v-if="item.point.cell.tasks.size > 4">另有 {{ item.point.cell.tasks.size - 4 }} 个任务</em><small>点击查看明细 · 拖动调整优先级</small></span>
            </button></template>
            <div v-if="!visibleRingBands.some((band) => band.placements.length)" class="ring-empty">当前筛选范围暂无未完成任务</div>
          </div>
        </div>
        <div v-else class="heatmap-board-shell" :style="boardShellStyle"><div class="coordinate-board" :style="coordinateBoardStyle">
          <div class="axis-corner">{{ dimension === 'model' ? '品牌 / 车型' : '品牌' }} <small>核心品名 →</small></div><div v-for="column in heatmap.columns" :key="column.label" class="axis-column"><strong>{{ column.label }}</strong><small>{{ column.tasks.size }} 个任务</small></div>
          <template v-for="row in heatmap.rows" :key="row.id"><div class="axis-row"><strong>{{ row.label }}</strong><small>{{ row.tasks.size }} 个任务</small></div><div v-for="column in heatmap.columns" :key="`${row.id}:${column.label}`" class="axis-cell-wrap"><button v-if="heatmap.cell(row,column.label).tasks.size && (expandedQuadrantScore == null || heatmap.cell(row,column.label).priorityScore === expandedQuadrantScore)" class="axis-cell" :class="[`priority-${heatmap.cell(row,column.label).priorityScore}`, { selected: selectedCoordinateKeys.includes(coordinateFor(row,column).coordinate_key), marked: cellPlan(row,column).marked }]" :aria-label="`${column.label} · ${row.label}：${heatmap.cell(row,column.label).tasks.size} 个任务`" @click="handleCellClick(row,column)" @contextmenu="cancelCoordinate($event,row,column)"><b v-if="cellPlan(row,column).sequence" class="point-sequence">{{ cellPlan(row,column).sequence }}</b><i v-if="cellPlan(row,column).marked" class="point-marker">标记</i><span class="axis-avatars"><el-avatar v-for="owner in taskOwners(heatmap.cell(row,column.label)).slice(0,2)" :key="avatarKey(owner)" :src="avatarFailures.has(avatarKey(owner)) ? '' : owner.owner_avatar_url" :size="36" @error="handleAvatarError(owner)">{{ owner.owner_name?.slice(0,1) || '?' }}</el-avatar></span><small>{{ heatmap.cell(row,column.label).tasks.size }} 个任务</small><span class="point-hover-card"><b>{{ column.label }} · {{ row.label }}</b><small>{{ heatmap.cell(row,column.label).tasks.size }} 个任务 · {{ heatmap.cell(row,column.label).value }} {{ unit }}</small><span v-for="task in cellTasks(heatmap.cell(row,column.label)).slice(0,4)" :key="task.id"><el-avatar :src="task.owner_avatar_url" :size="22">{{ task.owner_name?.slice(0,1) || '?' }}</el-avatar><strong>{{ task.title }}</strong><i>{{ taskStatusLabel(task) }}</i></span><small>点击查看任务明细</small></span></button><span v-else class="axis-empty">—</span></div></template>
        </div></div>
      </div>
      <el-empty v-else-if="!loading" description="当前范围暂无可归类的开发记录，可调整时间或新增开发任务" />
      <footer class="heatmap-notes"><span>默认排除已完成任务；全部模式按优先级由中心向外排列同心环，筛选项可聚焦某一优先级；可拖节点到目标环或优先级标签更新关联任务。横纵坐标用于按核心品名 × {{ dimension === 'model' ? '车型' : '品牌' }} 查找。左键拖动画布，滚轮缩放。</span><p>北京时间。{{ metric === 'actual' ? '已开发数量按关联草稿的当前变体数统计，同一草稿去重，店铺副本不重复计数；这不是历史时点快照。' : metric === 'target' ? '计划数量按各车型设置的 SKU 目标汇总。' : '每个点对应一个核心品名与当前品牌/车型颗粒度的任务集合；顶部总任务数去重。' }}</p><p v-if="heatmap.unclassified">当前任务日期范围内有 {{ heatmap.unclassified }} 个旧开发任务缺少品牌／车型／类目；切换“开发任务数”查看“未分类”，不将其自动归入非汽车。</p><p v-if="heatmap.conflicts" class="heatmap-warning">{{ heatmap.conflicts }} 份草稿关联到了多个不同坐标，已排除重复归属；请在任务详情中修正关联。</p></footer>
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
@media(max-width:760px){.heatmap-viewport .quadrant-board{grid-template-columns:repeat(2,minmax(0,1fr))!important;grid-template-rows:repeat(2,340px)!important;grid-auto-rows:initial!important}.heatmap-viewport .quadrant-point:not(.ring-point){width:min(248px,calc(50% - 5px))!important}.heatmap-viewport .quadrant-10 .quadrant-points,.heatmap-viewport .quadrant-8 .quadrant-points,.heatmap-viewport .quadrant-7 .quadrant-points,.heatmap-viewport .quadrant-6 .quadrant-points{align-content:flex-start!important;justify-content:flex-start!important;flex-direction:row!important}}
</style>

<style scoped>
.heatmap-panel{padding:20px;background:#fff;border:1px solid #e2e8f0;border-radius:16px}.heatmap-heading{margin-bottom:16px}.heatmap-heading h2{font-size:20px}.heatmap-filters{gap:9px;margin-bottom:10px}.heatmap-plan-toolbar{margin-top:10px}.heatmap-plan-toolbar strong{font-size:13px}.heatmap-priority-legend{gap:7px;padding:8px 10px;margin:8px 0;background:#f8fafc}.heatmap-priority-legend>span{padding:5px 9px;border-radius:7px;font-size:11px}.heatmap-priority-legend .priority-10{background:#dc2626;color:#fff}.heatmap-priority-legend .priority-7{background:#1e40af;color:#fff}.heatmap-priority-legend .priority-8{background:#fee2e2;color:#7f1d1d}.heatmap-priority-legend .priority-6{background:#f1f5f9;color:#334155}.heatmap-priority-legend .priority-done{background:#dcfce7;color:#166534;font-weight:700}.heatmap-priority-legend small{font-size:10px;opacity:.82}.heatmap-canvas-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:7px;margin:8px 0;color:#64748b;font-size:12px}.heatmap-canvas-toolbar strong{min-width:42px;text-align:center;color:#334155}.heatmap-canvas-toolbar small{margin-left:8px;color:#94a3b8}.heatmap-viewport{height:min(66vh,680px);min-height:290px;overflow:auto;position:relative;border:1px solid #dbe4ef;border-radius:11px;background:#f4f7fb;cursor:grab;touch-action:none;user-select:none}.heatmap-viewport.is-panning{cursor:grabbing}.heatmap-board-shell{position:relative}.heatmap-board{position:absolute;left:0;top:0;display:grid;grid-auto-rows:76px;gap:1px;padding:1px;transform-origin:0 0;background:#dbe4ef}.heatmap-axis-head,.heatmap-column-head,.heatmap-row-head{display:flex;flex-direction:column;justify-content:center;gap:5px;padding:9px 11px;background:#f8fafc;color:#334155;overflow:hidden}.heatmap-axis-head{position:sticky;left:0;z-index:2;background:#eef3fa;font-size:12px;font-weight:750}.heatmap-column-head{text-align:center;align-items:center;background:#eef3fa}.heatmap-column-head strong,.heatmap-row-head strong{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.heatmap-column-head small,.heatmap-row-head small,.heatmap-axis-head small{color:#7b8798;font-size:10px}.heatmap-row-head{position:sticky;left:0;z-index:1;background:#f8fafc}.heatmap-cell{position:relative;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:4px;min-width:0;width:100%;height:100%;padding:9px 5px;border:0;border-radius:2px;cursor:pointer;overflow:visible;transition:transform .16s,filter .16s,box-shadow .16s;z-index:0}.heatmap-cell:disabled{cursor:default}.heatmap-cell.has-tasks:hover,.heatmap-cell:focus-visible{z-index:8;filter:brightness(1.06);transform:scale(1.035);outline:2px solid #fff;box-shadow:0 4px 14px #172b4d3b}.heatmap-cell>strong{font-size:19px;line-height:1;font-variant-numeric:tabular-nums}.cell-task-count{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:9px;line-height:1.1;text-align:center}.cell-task-count span:first-child{font-weight:700}.cell-task-count .has-completed,.cell-hover-card>span i.done{color:#15803d;font-weight:750}.cell-avatars{display:flex;align-items:center;height:21px;margin-top:1px}.cell-avatars .el-avatar+.el-avatar{margin-left:-6px;border:1px solid #fff}.cell-avatars i{display:grid;place-items:center;width:20px;height:20px;margin-left:-4px;border:1px solid #fff;border-radius:50%;background:#e2e8f0;color:#475569;font-size:8px;font-style:normal}.heatmap-cell.completed{background:#dcfce7!important;color:#166534!important}.heatmap-cell.completed .cell-task-count{color:#166534}.heatmap-cell.selected{outline:3px solid #f59e0b;outline-offset:-4px;box-shadow:0 0 0 3px #fff7ed,0 0 20px #f59e0b80;z-index:3}.heatmap-cell.marked:not(.selected){box-shadow:inset 0 0 0 3px #f59e0b}.cell-sequence{position:absolute;left:5px;top:5px;display:grid;place-items:center;min-width:22px;height:22px;padding:0 4px;border-radius:999px;background:#991b1b;color:#fff;font-size:11px;font-weight:800;box-shadow:0 1px 4px #0003}.cell-marker{position:absolute;right:5px;top:5px;padding:2px 5px;border-radius:5px;background:#fef3c7;color:#92400e;font-size:9px;font-style:normal;font-weight:750}.cell-hover-card{display:none;position:absolute;left:50%;bottom:calc(100% + 8px);z-index:20;width:270px;padding:12px;border:1px solid #dbe4ef;border-radius:11px;background:#fff;color:#243247;text-align:left;white-space:normal;box-shadow:0 12px 32px #1e293b30;pointer-events:none}.heatmap-cell:hover .cell-hover-card,.heatmap-cell:focus-visible .cell-hover-card{display:grid;gap:7px}.cell-hover-card>b{font-size:12px}.cell-hover-card>small{color:#64748b;font-size:10px}.cell-hover-card>span{display:grid;grid-template-columns:24px 1fr auto;align-items:center;gap:6px;padding-top:6px;border-top:1px solid #eef2f7}.cell-hover-card>span strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.cell-hover-card>span i{font-size:9px;color:#64748b;font-style:normal}.cell-hover-card>em{font-size:10px;color:#64748b;font-style:normal}.cell-hover-card>small:last-child{padding-top:4px;color:#2563eb}.planning-mode .heatmap-cell.has-tasks:hover{animation:planning-focus .72s ease-in-out infinite alternate;outline:2px solid #fff;box-shadow:0 0 0 3px #ef4444,0 0 20px #ef444480}.planning-mode .heatmap-cell.selected{animation:selected-pulse .85s ease-in-out infinite alternate}@keyframes planning-focus{from{transform:scale(1.025)}to{transform:scale(1.09);filter:brightness(1.15)}}@keyframes selected-pulse{from{box-shadow:0 0 0 3px #fff7ed,0 0 12px #f59e0b70}to{box-shadow:0 0 0 4px #fff7ed,0 0 24px #ef4444c0}}.heatmap-selected-list article{box-shadow:0 2px 8px #1e293b0a}.detail-owner{display:inline-flex;align-items:center;gap:7px}.heatmap-notes{margin-top:10px}.heatmap-notes p{margin:4px 0;font-size:11px}@media(max-width:760px){.heatmap-panel{padding:13px}.heatmap-heading{flex-direction:column;align-items:flex-start}.heatmap-canvas-toolbar{justify-content:flex-start;flex-wrap:wrap}.heatmap-viewport{height:65vh}.heatmap-priority-legend em{margin-left:0}.heatmap-summary{margin-left:0}}
</style>

<style scoped>
.heatmap-panel{padding:22px;background:linear-gradient(180deg,#fff 0%,#fbfcff 100%);border-color:#e8edf5;border-radius:20px;box-shadow:0 12px 36px #1e293b08}
.heatmap-heading{margin-bottom:20px}.heatmap-heading h2{font-size:21px;letter-spacing:-.02em}.heatmap-heading p{max-width:940px;font-size:12px;color:#7b8798}.heatmap-heading>div:last-child{gap:8px}
.heatmap-filters{gap:10px;min-height:52px;padding:9px 11px;margin-bottom:10px;border:1px solid #edf1f7;border-radius:14px;background:#f9fbfe}
.heatmap-filters+.heatmap-filters{padding:8px 11px;background:#fff}
.heatmap-filters .el-select{width:174px}.heatmap-filters .el-input{width:248px}.heatmap-filters .el-select :deep(.el-select__wrapper),.heatmap-filters .el-input :deep(.el-input__wrapper),.heatmap-filters :deep(.el-date-editor){min-height:36px;border-radius:10px;box-shadow:0 1px 3px #172b4d0b}
.heatmap-filters :deep(.el-radio-group){padding:3px;border-radius:11px;background:#eef3fa}.heatmap-filters :deep(.el-radio-button__inner){padding:9px 13px;border:0;border-radius:9px!important;background:transparent;box-shadow:none;color:#68778d}.heatmap-filters :deep(.el-radio-button__original-radio:checked+.el-radio-button__inner){background:#fff;color:#2563eb;box-shadow:0 2px 8px #1e3a8a15;font-weight:700}
.heatmap-summary{padding-left:12px;color:#738097;font-size:12px}.heatmap-summary b{font-size:22px;color:#2563eb}
.heatmap-plan-toolbar{gap:10px;padding:12px 15px;margin:12px 0 10px;border-color:#d8e8ff;border-radius:14px;background:linear-gradient(110deg,#eff6ff,#f7faff 70%,#fff);box-shadow:0 4px 14px #2563eb0a}.heatmap-plan-toolbar strong{color:#1e40af}.heatmap-plan-toolbar>span{color:#718096}.heatmap-selected-list{gap:7px;padding-bottom:12px}.heatmap-selected-list article{border-color:#e7ebf2;border-radius:999px;box-shadow:0 3px 9px #1e293b08}
.heatmap-priority-legend{gap:8px;padding:8px 10px;margin:12px 0 8px;border:1px solid #eef1f6;border-radius:12px;background:#fff}.heatmap-priority-legend>span{padding:6px 10px;border-radius:999px;font-size:10px}.heatmap-priority-legend .priority-10{background:#fee2e2;color:#b91c1c}.heatmap-priority-legend .priority-7{background:#dbeafe;color:#1e40af}.heatmap-priority-legend .priority-8{background:#fff1f2;color:#be123c}.heatmap-priority-legend .priority-6{background:#f1f5f9;color:#475569}.heatmap-priority-legend .priority-done{background:#dcfce7;color:#166534}.heatmap-priority-legend em{font-size:10px}
.heatmap-canvas-toolbar{gap:8px;margin:8px 2px 10px}.heatmap-canvas-toolbar .el-button{border-radius:9px}.heatmap-canvas-toolbar strong{font-variant-numeric:tabular-nums}
.heatmap-viewport{border-color:#e7ecf4;border-radius:18px;background:radial-gradient(ellipse at 50% 50%,#fff 0%,#f8faff 72%,#f4f7fb 100%);box-shadow:inset 0 1px 4px #172b4d05}
.quadrant-board{gap:20px;padding:12px}
.priority-quadrant{position:relative;overflow:visible;border:0;border-radius:25px;background:#fff9;box-shadow:inset 0 0 0 1px #fff8}
.priority-quadrant:after{position:absolute;inset:0;z-index:0;border-radius:25px;content:"";pointer-events:none;opacity:.72}
.quadrant-10:after{background:radial-gradient(ellipse at 100% 100%,#fee2e2 0%,#fff6f6 52%,#ffffff30 100%)}.quadrant-7:after{background:radial-gradient(ellipse at 0% 100%,#dbeafe 0%,#f3f8ff 55%,#ffffff30 100%)}.quadrant-8:after{background:radial-gradient(ellipse at 100% 0%,#ffe4e6 0%,#fff8f8 56%,#ffffff30 100%)}.quadrant-6:after{background:radial-gradient(ellipse at 0% 0%,#e9eef5 0%,#f8fafc 58%,#ffffff30 100%)}
.priority-quadrant>header{position:relative;z-index:1;padding:13px 16px 8px;border:0;background:transparent}.priority-quadrant>header strong{font-size:12px;letter-spacing:.01em}.priority-quadrant>header small{color:#8290a4}.priority-quadrant>header>b{min-width:25px;height:25px;border:1px solid #ffffffc9;border-radius:999px;background:#ffffff9c;color:#526178;box-shadow:0 3px 10px #1e293b0a}
.quadrant-10>header{color:#b42332}.quadrant-7>header{color:#244c96}.quadrant-8>header{color:#be4560}.quadrant-6>header{color:#58677b}
.quadrant-points{position:relative;z-index:1;gap:10px;padding:9px 13px 14px}
.quadrant-point{width:min(248px,calc(50% - 6px));min-height:78px;padding:10px 13px;border:1px solid #ffffffc9;border-left:3px solid transparent;border-radius:17px;background:#fff;color:#243247;box-shadow:0 5px 16px #243b5a0d,0 1px 3px #243b5a08;transition:transform .18s cubic-bezier(.2,.8,.2,1),box-shadow .18s ease,border-color .18s ease,filter .18s ease}
.quadrant-point.priority-10{border-left-color:#dc3545;background:linear-gradient(110deg,#fff1f2,#fff 78%);color:#7f1d1d}.quadrant-point.priority-7{border-left-color:#1e40af;background:linear-gradient(110deg,#eff6ff,#fff 78%);color:#1e3a68}.quadrant-point.priority-8{border-left-color:#fb7185;background:linear-gradient(110deg,#fff7f7,#fff 78%);color:#7f1d1d}.quadrant-point.priority-6{border-left-color:#cbd5e1;background:linear-gradient(110deg,#f8fafc,#fff 78%);color:#334155}.quadrant-point.completed{border-color:#bbf7d0;border-left-color:#22a06b;background:linear-gradient(110deg,#dcfce7,#f5fff8 78%);color:#166534}
.quadrant-point:hover,.quadrant-point:focus-visible{transform:translateY(-3px) scale(1.015);filter:saturate(1.05);outline:2px solid #fff;box-shadow:0 12px 24px #14294a1c,0 0 0 1px #dbeafe}.quadrant-point.selected{outline:2px solid #f59e0b;outline-offset:2px;box-shadow:0 0 0 5px #fff7ed,0 10px 24px #ef444440}.quadrant-point.marked:not(.selected){box-shadow:inset 0 0 0 2px #f59e0b,0 5px 16px #243b5a0d}.quadrant-point[style*="--schedule-strength"]{border-width:1px 1px 1px 3px}
.point-owners>.el-avatar{border:2px solid #fff;box-shadow:0 2px 5px #0f172a20}.point-copy>small{color:#738097;opacity:1}.quadrant-point.completed .point-copy>small{color:#438161}.point-sequence{min-width:25px;height:25px;background:linear-gradient(145deg,#ef4444,#b91c1c);box-shadow:0 3px 10px #7f1d1d50}
.point-hover-card{width:280px;padding:14px;border-color:#e4eaf2;border-radius:16px;box-shadow:0 18px 44px #1e293b30}.point-hover-card>span{padding-top:7px}
.planning-mode .quadrant-point:hover{outline:2px solid #fff;box-shadow:0 0 0 4px #ef4444,0 0 24px #ef444480}
.heatmap-filterbar{display:flex;align-items:center;gap:7px;min-width:0;overflow-x:auto;flex-wrap:nowrap;padding:8px;margin:0 0 10px;border:1px solid #edf1f7;border-radius:13px;background:#f8faff;scrollbar-width:thin}
.heatmap-filterbar>*{flex:0 0 auto}.heatmap-filterbar>.el-select{width:122px}.heatmap-filterbar>.el-date-editor{width:232px}.heatmap-filterbar>.el-input{width:205px}.heatmap-filterbar>.el-radio-group{padding:2px;border-radius:9px;background:#edf2f8}.heatmap-filterbar>.el-radio-group :deep(.el-radio-button__inner){padding:8px 10px;font-size:11px}.heatmap-filterbar>.view-mode-switch{margin-left:auto;background:#e8eef8}.heatmap-filterbar>.heatmap-summary{padding:0 7px;white-space:nowrap;font-size:10px}.heatmap-filterbar>.heatmap-summary b{font-size:16px}
.completed-filter{display:flex;align-items:center;gap:6px;padding:0 4px;color:#64748b;font-size:11px;white-space:nowrap}
.quadrant-board{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,340px)}.quadrant-board.is-focused{grid-template-columns:minmax(0,1fr)}.priority-quadrant{display:flex;flex-direction:column;min-width:0;min-height:0}.priority-quadrant.focused{grid-column:1/-1}.priority-quadrant>header{display:flex;align-items:center;gap:10px}.priority-quadrant>header>div{margin-right:auto}.priority-quadrant>header .el-button{z-index:2;color:#3568ad;font-size:11px}
.quadrant-overview{position:relative;z-index:1;display:flex;align-content:flex-start;align-items:center;gap:7px;flex:1;min-height:0;flex-wrap:wrap;padding:4px 16px 15px;cursor:pointer}.quadrant-name-chip{max-width:190px;overflow:hidden;padding:7px 10px;border:1px solid #e5ebf3;border-radius:999px;background:#ffffffd9;color:#44546a;font-size:11px;text-overflow:ellipsis;white-space:nowrap;box-shadow:0 2px 8px #1e293b08}.quadrant-overview>small{width:100%;margin-top:2px;color:#8793a5;font-size:10px}.quadrant-overview:hover .quadrant-name-chip{border-color:#cbd9ee;background:#fff}.quadrant-overview .quadrant-empty{width:100%;text-align:center}
.quadrant-points{display:grid;grid-template-columns:repeat(auto-fill,minmax(94px,1fr));align-content:start;justify-items:center;gap:14px;overflow:auto;min-height:0;flex:1;padding:8px 14px 15px}.priority-quadrant.focused .quadrant-points{min-height:460px}.quadrant-point{display:grid;grid-template-rows:64px auto;justify-items:center;align-content:start;gap:6px;width:92px;min-height:100px;padding:2px 4px;border:0;border-radius:14px;background:transparent;box-shadow:none;text-align:center;overflow:visible}.quadrant-point.priority-10,.quadrant-point.priority-7,.quadrant-point.priority-8,.quadrant-point.priority-6,.quadrant-point.completed{border:0;background:transparent;color:#25344a}.quadrant-point:hover,.quadrant-point:focus-visible{transform:translateY(-2px);outline:0;background:transparent;box-shadow:none}.point-owners{position:relative;display:grid;place-items:center;width:58px;height:58px;padding:4px;border:2px solid #d7e1ee;border-radius:50%;background:linear-gradient(145deg,#fff,#edf3fa);box-shadow:0 4px 14px #1e293b18}.quadrant-10 .point-owners{border-color:#f2a0a5}.quadrant-7 .point-owners{border-color:#99baf3}.quadrant-8 .point-owners{border-color:#fac1c9}.quadrant-6 .point-owners{border-color:#d2d9e2}.point-owners>.el-avatar{width:44px!important;height:44px!important;border:2px solid #fff;box-shadow:0 2px 6px #1e293b22}.point-owners>.el-avatar+.el-avatar{margin-left:-14px}.quadrant-point.completed .point-owners{border-color:#84d7a0;background:#f0fff4}.point-copy{display:grid;gap:2px;width:100%;text-align:center}.point-copy>strong{max-width:100%;font-size:10px;line-height:1.25;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.point-copy>small{font-size:9px;color:#748198;opacity:1}.quadrant-point.completed .point-copy>small{color:#438161}.quadrant-point.selected{outline:2px solid #f59e0b;outline-offset:1px;border-radius:18px;box-shadow:0 0 0 4px #fff7ed}.quadrant-point[style*="--schedule-strength"]{border:0}.point-sequence{top:0;left:0;min-width:22px;height:22px;font-size:10px}.point-marker{top:0;right:0}
.coordinate-board{position:absolute;inset:0 auto auto 0;display:grid;gap:1px;padding:1px;transform-origin:0 0;background:#e3e9f2}.axis-corner,.axis-column,.axis-row,.axis-cell-wrap{display:flex;align-items:center;justify-content:center;min-width:0;background:#fff}.axis-corner,.axis-column,.axis-row{position:sticky;z-index:2;flex-direction:column;gap:5px;padding:8px;background:#f2f6fc;color:#31415a;text-align:center}.axis-corner{left:0;z-index:4;align-items:flex-start;padding-left:14px;font-size:11px;font-weight:700}.axis-corner small,.axis-column small,.axis-row small{color:#8b97aa;font-size:9px;font-weight:400}.axis-column{top:0}.axis-column strong,.axis-row strong{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.axis-row{left:0;align-items:flex-start;text-align:left}.axis-cell-wrap{position:relative;overflow:visible}.axis-cell{position:relative;display:grid;place-items:center;gap:2px;width:66px;height:66px;padding:4px;border:2px solid #d7e1ee;border-radius:50%;background:linear-gradient(145deg,#fff,#edf3fa);color:#5a6880;cursor:pointer;transition:transform .15s,box-shadow .15s}.axis-cell.priority-10{border-color:#f2a0a5}.axis-cell.priority-7{border-color:#99baf3}.axis-cell.priority-8{border-color:#fac1c9}.axis-cell.priority-6{border-color:#d2d9e2}.axis-cell:hover,.axis-cell:focus-visible{z-index:4;transform:scale(1.08);outline:0;box-shadow:0 7px 16px #1e293b26}.axis-avatars{display:flex;justify-content:center}.axis-avatars>.el-avatar{width:34px!important;height:34px!important;border:2px solid #fff;box-shadow:0 2px 5px #0f172a20}.axis-avatars>.el-avatar+.el-avatar{margin-left:-10px}.axis-cell>small{font-size:9px}.axis-cell.selected{outline:3px solid #f59e0b;outline-offset:1px}.axis-cell.marked:not(.selected){box-shadow:inset 0 0 0 3px #f59e0b}.axis-empty{color:#d1d8e2;font-size:15px}
@media(max-width:900px){.heatmap-heading{align-items:flex-start;flex-direction:column}.heatmap-filterbar>.view-mode-switch{margin-left:0}.heatmap-filterbar>.heatmap-summary{margin-left:0}.quadrant-board{min-width:820px}.quadrant-board.is-focused{min-width:820px}.coordinate-board{min-width:max-content}.priority-quadrant,.priority-quadrant:after{border-radius:18px}}
</style>

<style scoped>
.priority-filter-bar{gap:7px}.priority-filter{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border:1px solid transparent;border-radius:999px;font:inherit;font-size:11px;font-weight:700;white-space:nowrap;cursor:pointer;transition:transform .15s,box-shadow .15s,outline-color .15s}.priority-filter small{font-size:10px;opacity:.78}.priority-filter.priority-all{background:#f1f5f9;color:#475569}.priority-filter.priority-10{background:#fee2e2;color:#b91c1c}.priority-filter.priority-7{background:#dbeafe;color:#1e40af}.priority-filter.priority-8{background:#fff1f2;color:#be123c}.priority-filter.priority-6{background:#f1f5f9;color:#475569}.priority-filter.active{box-shadow:0 0 0 2px #fff,0 0 0 4px currentColor}.priority-filter:hover{transform:translateY(-1px);filter:saturate(1.08)}.priority-filter.drop-target-active{outline:2px dashed currentColor;outline-offset:3px;transform:scale(1.04)}
.ring-board-shell{overflow:visible}.priority-rings-canvas{position:absolute;transform-origin:top left;touch-action:none}.priority-ring-zone{position:absolute;z-index:0;box-sizing:border-box;border:1px solid transparent;border-radius:50%;transition:filter .18s,box-shadow .18s,background-color .18s;pointer-events:none}.priority-ring-zone.priority-6{color:#cbd5e1;border-color:#d5dde7;background:radial-gradient(circle at 50% 48%,#fff 0%,#f3f6fa 100%)}.priority-ring-zone.priority-8{color:#fb7185;border-color:#f4c5cc;background:radial-gradient(circle at 50% 48%,#fff9fa 0%,#ffecef 100%)}.priority-ring-zone.priority-7{color:#2563eb;border-color:#b8d0fb;background:radial-gradient(circle at 50% 48%,#f8fbff 0%,#e8f1ff 100%)}.priority-ring-zone.priority-10{color:#dc3545;border-color:#ef9ba3;background:radial-gradient(circle at 50% 48%,#fff7f7 0%,#ffe1e4 100%)}.priority-ring-zone.drop-target-active{filter:saturate(1.35);box-shadow:inset 0 0 0 5px currentColor,0 0 26px currentColor}.priority-ring-label{position:absolute;z-index:2;display:flex;align-items:center;gap:8px;transform:translateX(-50%);padding:6px 11px;border:1px solid #ffffffd9;border-radius:999px;background:#ffffffdf;box-shadow:0 4px 14px #1e293b12;white-space:nowrap;pointer-events:none}.priority-ring-label strong{font-size:11px}.priority-ring-label small{font-size:10px;color:#64748b}.priority-ring-label.priority-10{color:#b42332}.priority-ring-label.priority-7{color:#244c96}.priority-ring-label.priority-8{color:#be4560}.priority-ring-label.priority-6{color:#58677b}.ring-point{position:absolute!important;z-index:4;display:grid!important;grid-template-rows:54px auto;justify-items:center;align-content:start;gap:4px;width:116px!important;min-height:98px!important;padding:2px 3px!important;border:0!important;border-radius:16px!important;background:transparent!important;color:#25344a!important;box-shadow:none;text-align:center!important;transform:translate(-50%,-50%);cursor:grab}.ring-point:active{cursor:grabbing}.ring-point.priority-10 .point-owners{border-color:#f2a0a5}.ring-point.priority-7 .point-owners{border-color:#99baf3}.ring-point.priority-8 .point-owners{border-color:#fac1c9}.ring-point.priority-6 .point-owners{border-color:#d2d9e2}.ring-point.completed .point-owners{border-color:#84d7a0;background:#f0fff4}.ring-point .point-owners{width:52px;height:52px;padding:3px}.ring-point .point-owners>.el-avatar{width:42px!important;height:42px!important}.ring-point .point-copy{display:grid;gap:2px;width:100%;text-align:center}.ring-point .point-copy>strong{max-width:100%;font-size:10px;line-height:1.25;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.ring-point .point-copy>small{font-size:9px;color:#718096}.ring-point.completed .point-copy>strong{color:#167345}.ring-point:hover,.ring-point:focus-visible{z-index:8;transform:translate(-50%,-50%) scale(1.08);outline:0;background:transparent!important;box-shadow:none!important}.ring-point .point-hover-card{left:50%;bottom:calc(100% + 8px)}.ring-point.selected{outline:2px solid #f59e0b!important;outline-offset:0;box-shadow:0 0 0 4px #fff7ed!important}.ring-empty{position:absolute;left:50%;top:50%;z-index:3;transform:translate(-50%,-50%);padding:12px 18px;border-radius:999px;background:#ffffffd9;color:#7b8798;font-size:12px;pointer-events:none}
</style>
