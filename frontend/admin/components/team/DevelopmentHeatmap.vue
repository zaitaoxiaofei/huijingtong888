<script setup>
import { computed, onMounted, ref } from "vue";
import { apiClient } from "../../utils/api.js";
import { shanghaiDateKey, shanghaiMonthStart } from "../../utils/shanghai-date.js";
import { buildDevelopmentHeatmap } from "../../utils/development-heatmap.js";

const emit = defineEmits(["open-task", "create"]);
const tasks = ref([]); const loading = ref(false); const error = ref("");
const metric = ref("actual"); const dimension = ref("model"); const scope = ref("all"); const query = ref("");
const period = ref("month"); const time = ref("draft");
const range = ref([shanghaiMonthStart(), shanghaiDateKey()]);
const detail = ref(null);
const unit = computed(() => metric.value === "tasks" ? "个任务" : "个 SKU");
const metricLabel = computed(() => ({ actual: "实际已开发", target: "计划开发", tasks: "开发任务" })[metric.value]);
const heatmap = computed(() => buildDevelopmentHeatmap(tasks.value, { metric: metric.value, dimension: dimension.value, scope: scope.value, query: query.value, time: time.value, range: range.value }));
function setMetric() { if (metric.value !== "actual" && time.value === "draft") time.value = "created"; detail.value = null; }
function setPeriod(value) {
  period.value = value;
  const today = shanghaiDateKey(); const [year, month] = today.split("-").map(Number);
  if (value === "month") range.value = [shanghaiMonthStart(), `${year}-${String(month).padStart(2, "0")}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`];
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
function cellStyle(value) {
  if (!value) return {};
  const weight = Math.sqrt(value / heatmap.value.max);
  return { backgroundColor: `hsl(214 82% ${96 - weight * 53}%)`, color: weight > .87 ? "#fff" : "#10243f" };
}
function showCell(row, column) {
  const cell = heatmap.value.cell(row, column.label);
  detail.value = { title: `${row.label} · ${column.label}`, value: cell.value, tasks: [...cell.tasks.values()], drafts: cell.drafts };
}
defineExpose({ reload: load });
onMounted(() => { setPeriod("month"); load(); });
</script>

<template>
  <section class="heatmap-panel" v-loading="loading">
    <header class="heatmap-heading"><div><h2>开发分布热力图</h2><p>纵向看车型或品牌，横向看核心品名；当前范围内数量越多，颜色越深，排序越靠左上。</p></div><div><el-button @click="load">刷新</el-button><el-button type="primary" @click="emit('create')">新增开发任务</el-button></div></header>
    <div class="heatmap-filters">
      <el-radio-group v-model="period" @change="setPeriod"><el-radio-button value="month">本月</el-radio-button><el-radio-button value="year">本年</el-radio-button><el-radio-button value="all">全部时间</el-radio-button><el-radio-button value="custom">自定义</el-radio-button></el-radio-group>
      <el-date-picker v-if="period !== 'all'" v-model="range" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" :clearable="false" @change="period = 'custom'" />
      <el-select v-model="metric" aria-label="统计数量" @change="setMetric"><el-option label="实际已开发 SKU" value="actual" /><el-option label="计划开发 SKU" value="target" /><el-option label="开发任务数" value="tasks" /></el-select>
      <el-select v-model="time" aria-label="统计日期"><el-option v-if="metric === 'actual'" label="按草稿创建时间" value="draft" /><el-option label="按任务创建时间" value="created" /><el-option label="按计划完成日期" value="due" /></el-select>
    </div>
    <div class="heatmap-filters">
      <el-radio-group v-model="dimension"><el-radio-button value="model">按车型</el-radio-button><el-radio-button value="brand">按品牌</el-radio-button></el-radio-group>
      <el-select v-model="scope" aria-label="开发范围"><el-option label="全部范围" value="all" /><el-option label="汽车" value="automotive" /><el-option label="非汽车" value="non_automotive" /><el-option label="未分类" value="unknown" /></el-select>
      <el-input v-model="query" clearable placeholder="搜索品牌、车型或核心品名" />
      <span class="heatmap-summary">{{ metricLabel }} <b>{{ heatmap.total }}</b> {{ unit }} · {{ heatmap.taskCount }} 个任务 · {{ heatmap.rows.length }} 行 × {{ heatmap.columns.length }} 类目</span>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false"><el-button @click="load">重新加载</el-button></el-alert>
    <template v-else>
      <div class="heatmap-scroll" v-if="heatmap.rows.length && heatmap.columns.length">
        <table><thead><tr><th>{{ dimension === 'model' ? '品牌 / 车型' : '品牌 / 范围' }}<small>按开发数量降序</small></th><th v-for="column in heatmap.columns" :key="column.label">{{ column.label }}<small>{{ column.total }} {{ unit }}</small></th></tr></thead><tbody>
          <tr v-for="row in heatmap.rows" :key="row.id"><th>{{ row.label }}<small>{{ row.total }} {{ unit }}</small></th><td v-for="column in heatmap.columns" :key="column.label"><button :style="cellStyle(heatmap.cell(row, column.label).value)" :aria-label="`${row.label} · ${column.label}：${heatmap.cell(row, column.label).value} ${unit}`" @click="showCell(row, column)"><strong>{{ heatmap.cell(row, column.label).value }}</strong><small v-if="heatmap.cell(row, column.label).tasks.size">{{ heatmap.cell(row, column.label).tasks.size }} 个任务</small><small v-else>暂无开发</small></button></td></tr>
        </tbody></table>
      </div>
      <el-empty v-else-if="!loading" description="当前范围暂无可归类的开发记录，可调整时间或新增开发任务" />
      <footer class="heatmap-notes"><span>少 <i class="heatmap-legend"></i> 多 · 点击格子查看明细</span><p>北京时间。{{ metric === 'actual' ? '已开发数量按关联草稿的当前变体数统计，同一草稿去重，店铺副本不重复计数；这不是历史时点快照。' : metric === 'target' ? '计划数量按各车型设置的 SKU 目标汇总。' : '每格按任务去重；跨车型任务可能出现在多个格子，顶部总任务数去重。' }}</p><p v-if="heatmap.unclassified">当前任务日期范围内有 {{ heatmap.unclassified }} 个旧开发任务缺少品牌／车型／类目；切换“开发任务数”查看“未分类”，不将其自动归入非汽车。</p><p v-if="heatmap.conflicts" class="heatmap-warning">{{ heatmap.conflicts }} 份草稿关联到了多个不同坐标，已排除重复归属；请在任务详情中修正关联。</p></footer>
    </template>
    <el-dialog v-if="detail" :model-value="true" :title="detail.title" width="min(820px, 94vw)" append-to-body @close="detail = null">
      <p>{{ metricLabel }}：<b>{{ detail.value }}</b> {{ unit }} · {{ detail.tasks.length }} 个关联任务</p>
      <el-table :data="detail.tasks" max-height="420" empty-text="这个坐标暂无开发任务"><el-table-column prop="title" label="任务名称" min-width="220" /><el-table-column prop="owner_name" label="负责人" width="120" /><el-table-column prop="due_at" label="计划完成" width="130" /><el-table-column label="操作" width="95"><template #default="{ row }"><el-button link type="primary" @click="emit('open-task', row); detail = null">查看任务</el-button></template></el-table-column></el-table>
      <p v-if="metric === 'actual'">符合筛选条件的成果草稿：{{ detail.drafts.length }} 份（已去重）</p>
      <template #footer><el-button @click="detail = null">关闭</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.heatmap-panel{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:24px;min-width:0}.heatmap-heading{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:22px}.heatmap-heading h2{margin:0 0 8px;font-size:22px;color:#1e293b}.heatmap-heading p,.heatmap-notes{font-size:13px;color:#64748b;line-height:1.7}.heatmap-heading p{margin:0}.heatmap-heading>div:last-child{display:flex;flex-shrink:0}.heatmap-filters{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}.heatmap-filters .el-select{width:174px}.heatmap-filters .el-input{width:250px}.heatmap-filters :deep(.el-date-editor){max-width:320px}.heatmap-summary{margin-left:auto;color:#64748b;font-size:13px}.heatmap-summary b{font-size:23px;color:#2563eb;margin:0 4px}.heatmap-scroll{max-height:calc(100vh - 350px);min-height:230px;overflow:auto;border:1px solid #dce5f0;border-radius:10px}.heatmap-scroll table{border-collapse:separate;border-spacing:0;min-width:100%;font-size:13px}.heatmap-scroll th,.heatmap-scroll td{border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;min-width:140px;padding:0}.heatmap-scroll th{padding:14px 18px;background:#f5f8fd;text-align:left;color:#334155}.heatmap-scroll th small{display:block;font-size:11px;font-weight:400;color:#64748b;margin-top:5px}.heatmap-scroll thead th{position:sticky;top:0;z-index:2;white-space:nowrap}.heatmap-scroll tr>th:first-child{position:sticky;left:0;z-index:1;min-width:190px}.heatmap-scroll thead th:first-child{z-index:3;background:#edf3fb}.heatmap-scroll td button{width:100%;min-height:78px;display:flex;flex-direction:column;gap:5px;justify-content:center;align-items:center;background:#fafcff;color:#94a3b8;border:0;cursor:pointer}.heatmap-scroll td strong{font-size:22px;font-variant-numeric:tabular-nums}.heatmap-scroll td small{font-size:11px}.heatmap-scroll button:hover,.heatmap-scroll button:focus-visible{outline:2px solid #2563eb;outline-offset:-3px}.heatmap-notes{margin-top:14px}.heatmap-notes p{margin:5px 0}.heatmap-notes>span{display:flex;align-items:center;gap:8px}.heatmap-legend{display:inline-block;width:130px;height:12px;border-radius:3px;background:linear-gradient(90deg,#f8fbff,#1470ce)}.heatmap-warning{color:#b45309}@media(max-width:760px){.heatmap-panel{padding:14px}.heatmap-heading{align-items:flex-start;flex-direction:column}.heatmap-scroll{max-height:65vh}.heatmap-summary{margin-left:0}.heatmap-filters .el-select{width:150px}}
</style>
