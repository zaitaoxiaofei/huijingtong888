<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api.js";
import { shanghaiDateKey, shanghaiMonthStart } from "../../utils/shanghai-date.js";
import { buildDevelopmentHeatmap, developmentCoordinateKey, developmentPlanPeriodKey } from "../../utils/development-heatmap.js";

const emit = defineEmits(["open-task", "create"]);
const tasks = ref([]); const loading = ref(false); const error = ref("");
const metric = ref("tasks"); const dimension = ref("model"); const scope = ref("all"); const query = ref("");
const period = ref("month"); const time = ref("due");
const range = ref([shanghaiMonthStart(), shanghaiDateKey()]);
const detail = ref(null); const planningMode = ref(false); const planSaving = ref(false);
const planOrders = ref(new Map()); const selectedCoordinateKeys = ref([]); const selectedCoordinates = ref(new Map());
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
  const plan = cellPlan(row, column);
  if (Number(plan.sequence) > 0) {
    const weight = 1 - (Number(plan.sequence) - 1) / maxSequence.value;
    return { backgroundColor: `hsl(4 78% ${92 - weight * 34}%)`, color: weight > .58 ? "#fff" : "#7f1d1d" };
  }
  if (cell.priorityScore >= 10) return { backgroundColor: "#fee2e2", color: "#991b1b" };
  const weight = Math.sqrt(cell.value / heatmap.value.max);
  return { backgroundColor: `hsl(214 82% ${96 - weight * 53}%)`, color: weight > .87 ? "#fff" : "#10243f" };
}
function cellClass(row, column, cell) {
  const plan = cellPlan(row, column);
  return { selected: selectedCoordinateKeys.value.includes(coordinateFor(row, column).coordinate_key), marked: plan.marked, ordered: Number(plan.sequence) > 0, [`priority-${cell.priorityScore}`]: cell.tasks.size > 0 };
}
function showCell(row, column) {
  const cell = heatmap.value.cell(row, column.label);
  detail.value = { title: `${row.label} · ${column.label}`, value: cell.value, priority: priorityLabel(cell.priorityScore), tasks: [...cell.tasks.values()].sort((a, b) => ({ urgent_important: 10, high: 10, urgent_unimportant: 8, important_not_urgent: 7, medium: 7, not_urgent_unimportant: 6, low: 6 }[b.priority] || 7) - ({ urgent_important: 10, high: 10, urgent_unimportant: 8, important_not_urgent: 7, medium: 7, not_urgent_unimportant: 6, low: 6 }[a.priority] || 7)), drafts: cell.drafts };
}
function handleCellClick(row, column) { if (planningMode.value) toggleCoordinate(row, column); else showCell(row, column); }
function removeSelected(key) { selectedCoordinateKeys.value = selectedCoordinateKeys.value.filter((item) => item !== key); }
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
      <strong>{{ periodKey }} · 已选 {{ selectedPlanCells.length }} 个坐标</strong>
      <span>点选矩阵格子，再标记或分配开发顺序；序号会同步到任务中心。</span>
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
      <div class="heatmap-priority-legend"><strong>优先级四象限</strong><span v-for="item in priorityQuadrants" :key="item.score" :class="`priority-${item.score}`"><b>{{ item.label }}</b><small>{{ item.count }} 个任务</small></span><em>高优先级核心品名 / 品牌 / 车型优先靠前并高亮；人工顺序号越小颜色越红。</em></div>
      <div class="heatmap-scroll" v-if="heatmap.rows.length && heatmap.columns.length">
        <table><thead><tr><th>{{ dimension === 'model' ? '品牌 / 车型' : '品牌' }}<small>按优先级与开发量排序</small></th><th v-for="column in heatmap.columns" :key="column.label">{{ column.label }}<small>{{ column.total }} {{ unit }}</small></th></tr></thead><tbody>
          <tr v-for="row in heatmap.rows" :key="row.id"><th>{{ row.label }}<small>{{ row.total }} {{ unit }}</small></th><td v-for="column in heatmap.columns" :key="column.label"><button :class="cellClass(row,column,heatmap.cell(row,column.label))" :style="cellStyle(row,column,heatmap.cell(row,column.label))" :aria-label="`${row.label} · ${column.label}：${heatmap.cell(row, column.label).value} ${unit}`" :disabled="planningMode && !heatmap.cell(row,column.label).tasks.size" @click="handleCellClick(row, column)"><i v-if="cellPlan(row,column).marked" class="cell-marker">标记</i><b v-if="cellPlan(row,column).sequence" class="cell-sequence">{{ cellPlan(row,column).sequence }}</b><strong>{{ heatmap.cell(row, column.label).value }}</strong><small v-if="heatmap.cell(row, column.label).tasks.size">{{ heatmap.cell(row, column.label).tasks.size }} 个任务 · {{ priorityLabel(heatmap.cell(row,column.label).priorityScore) }}</small><small v-else>暂无开发</small></button></td></tr>
        </tbody></table>
      </div>
      <el-empty v-else-if="!loading" description="当前范围暂无可归类的开发记录，可调整时间或新增开发任务" />
      <footer class="heatmap-notes"><span>蓝色表示开发量，红色序号表示人工顺序；点击格子查看明细</span><p>北京时间。{{ metric === 'actual' ? '已开发数量按关联草稿的当前变体数统计，同一草稿去重，店铺副本不重复计数；这不是历史时点快照。' : metric === 'target' ? '计划数量按各车型设置的 SKU 目标汇总。' : '每格按任务去重；跨车型任务可能出现在多个格子，顶部总任务数去重。' }}</p><p v-if="heatmap.unclassified">当前任务日期范围内有 {{ heatmap.unclassified }} 个旧开发任务缺少品牌／车型／类目；切换“开发任务数”查看“未分类”，不将其自动归入非汽车。</p><p v-if="heatmap.conflicts" class="heatmap-warning">{{ heatmap.conflicts }} 份草稿关联到了多个不同坐标，已排除重复归属；请在任务详情中修正关联。</p></footer>
    </template>
    <el-dialog v-if="detail" :model-value="true" :title="detail.title" width="min(820px, 94vw)" append-to-body @close="detail = null">
      <p>{{ metricLabel }}：<b>{{ detail.value }}</b> {{ unit }} · {{ detail.tasks.length }} 个关联任务 · 最高优先级 {{ detail.priority }}</p>
      <el-table :data="detail.tasks" max-height="420" empty-text="这个坐标暂无开发任务"><el-table-column prop="title" label="任务名称" min-width="220" /><el-table-column prop="owner_name" label="负责人" width="120" /><el-table-column prop="priority" label="优先级" width="130"><template #default="{row}">{{ priorityLabel(({ urgent_important:10, high:10, urgent_unimportant:8, important_not_urgent:7, medium:7, not_urgent_unimportant:6, low:6 })[row.priority] || 7) }}</template></el-table-column><el-table-column prop="due_at" label="计划完成" width="130" /><el-table-column label="操作" width="95"><template #default="{ row }"><el-button link type="primary" @click="emit('open-task', row); detail = null">查看任务</el-button></template></el-table-column></el-table>
      <p v-if="metric === 'actual'">符合筛选条件的成果草稿：{{ detail.drafts.length }} 份（已去重）</p>
      <template #footer><el-button @click="detail = null">关闭</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.heatmap-panel{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:24px;min-width:0}.heatmap-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:22px}.heatmap-heading h2{margin:0 0 8px;font-size:22px;color:#1e293b}.heatmap-heading p,.heatmap-notes{font-size:13px;color:#64748b;line-height:1.7}.heatmap-heading p{margin:0}.heatmap-heading>div:last-child{display:flex;flex-shrink:0;gap:6px}.heatmap-filters{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}.heatmap-filters .el-select{width:174px}.heatmap-filters .el-input{width:250px}.heatmap-filters :deep(.el-date-editor){max-width:320px}.heatmap-summary{margin-left:auto;color:#64748b;font-size:13px}.heatmap-summary b{font-size:23px;color:#2563eb;margin:0 4px}.heatmap-plan-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:11px 13px;margin:0 0 10px;border:1px solid #bfdbfe;border-radius:10px;background:#eff6ff;color:#334155;font-size:12px}.heatmap-plan-toolbar strong{color:#1d4ed8}.heatmap-plan-toolbar>span{margin-right:auto}.heatmap-selected-list{display:flex;gap:8px;flex-wrap:wrap;padding:0 0 14px}.heatmap-selected-list article{display:flex;align-items:center;gap:9px;padding:7px 10px;border:1px solid #dbe3ef;border-radius:9px;background:#fff;font-size:12px}.heatmap-selected-list article>strong{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.heatmap-selected-list label{display:flex;align-items:center;gap:5px;color:#64748b}.heatmap-selected-list :deep(.el-input-number){width:104px}.heatmap-priority-legend{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 11px;margin-bottom:10px;border-radius:8px;background:#f8fafc;color:#475569;font-size:11px}.heatmap-priority-legend>strong{flex:none}.heatmap-priority-legend span{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;font-weight:700}.heatmap-priority-legend .priority-10{background:#fee2e2;color:#b91c1c}.heatmap-priority-legend .priority-7{background:#fef3c7;color:#92400e}.heatmap-priority-legend .priority-8{background:#ffedd5;color:#c2410c}.heatmap-priority-legend .priority-6{background:#e2e8f0;color:#475569}.heatmap-priority-legend span small{color:inherit;font-weight:500}.heatmap-priority-legend em{margin-left:auto;color:#64748b;font-style:normal}.heatmap-scroll{max-height:calc(100vh - 430px);min-height:230px;overflow:auto;border:1px solid #dce5f0;border-radius:10px}.heatmap-scroll table{border-collapse:separate;border-spacing:0;min-width:100%;font-size:13px}.heatmap-scroll th,.heatmap-scroll td{border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;min-width:140px;padding:0}.heatmap-scroll th{padding:14px 18px;background:#f5f8fd;text-align:left;color:#334155}.heatmap-scroll th small{display:block;font-size:11px;font-weight:400;color:#64748b;margin-top:5px}.heatmap-scroll thead th{position:sticky;top:0;z-index:2;white-space:nowrap}.heatmap-scroll tr>th:first-child{position:sticky;left:0;z-index:1;min-width:190px}.heatmap-scroll thead th:first-child{z-index:3;background:#edf3fb}.heatmap-scroll td button{position:relative;width:100%;min-height:82px;display:flex;flex-direction:column;gap:5px;justify-content:center;align-items:center;background:#fafcff;color:#94a3b8;border:0;cursor:pointer;transition:box-shadow .15s,transform .15s}.heatmap-scroll td button:disabled{cursor:default}.heatmap-scroll td button.selected{outline:3px solid #2563eb;outline-offset:-4px;z-index:1}.heatmap-scroll td button.marked{box-shadow:inset 0 0 0 3px #f59e0b}.heatmap-scroll td button.priority-10:not(.ordered){box-shadow:inset 0 0 0 3px #dc2626}.heatmap-scroll td button.priority-8:not(.ordered){box-shadow:inset 0 0 0 2px #f97316}.heatmap-scroll td button.priority-7:not(.ordered){box-shadow:inset 0 0 0 1px #fbbf24}.heatmap-scroll td strong{font-size:22px;font-variant-numeric:tabular-nums}.heatmap-scroll td small{font-size:11px}.cell-sequence{position:absolute;left:7px;top:6px;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#991b1b;color:#fff;font-size:12px}.cell-marker{position:absolute;right:6px;top:6px;padding:2px 5px;border-radius:5px;background:#fef3c7;color:#92400e;font-size:10px;font-style:normal;font-weight:700}.heatmap-scroll button:hover:not(:disabled),.heatmap-scroll button:focus-visible{outline:2px solid #2563eb;outline-offset:-3px}.heatmap-notes{margin-top:14px}.heatmap-notes p{margin:5px 0}.heatmap-notes>span{display:flex;align-items:center;gap:8px}.heatmap-warning{color:#b45309}@media(max-width:760px){.heatmap-panel{padding:14px}.heatmap-heading{align-items:flex-start;flex-direction:column}.heatmap-scroll{max-height:65vh}.heatmap-summary{margin-left:0}.heatmap-filters .el-select{width:150px}.heatmap-selected-list article{flex-wrap:wrap}}
</style>
