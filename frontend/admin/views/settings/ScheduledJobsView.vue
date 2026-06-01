<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { EditPen, InfoFilled, Refresh, VideoPlay, Warning } from "@element-plus/icons-vue";
import { apiClient } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date";

const loading = ref(false);
const saving = ref(false);
const detailLoading = ref(false);
const runningKeys = ref(new Set());
const editVisible = ref(false);
const detailVisible = ref(false);
const activeJob = ref(null);
const activeRun = ref(null);
const runEvents = ref([]);
const state = reactive({
  jobs: [],
  filter: {
    category: "all",
    status: "all",
    keyword: ""
  }
});
const form = reactive({
  scheduleType: "interval",
  intervalMinutes: 60,
  dailyTime: "02:00",
  catchupEnabled: true,
  maxCatchupRuns: 1,
  timeoutMinutes: 30,
  scope: "",
  days: 7
});

const categories = computed(() => {
  const values = [...new Set(state.jobs.map((job) => job.category).filter(Boolean))];
  return values.map((value) => ({ value, label: categoryLabel(value) }));
});

const summary = computed(() => {
  const jobs = state.jobs;
  return {
    total: jobs.length,
    enabled: jobs.filter((job) => job.enabled).length,
    failed: jobs.filter((job) => job.lastStatus === "failed").length,
    due: jobs.filter((job) => isDue(job.nextRunAt) && job.enabled).length
  };
});

const failedJobs = computed(() => state.jobs.filter((job) => job.lastStatus === "failed"));

const filteredJobs = computed(() => {
  const keyword = String(state.filter.keyword || "").trim().toLowerCase();
  return [...state.jobs]
    .filter((job) => {
      if (state.filter.category !== "all" && job.category !== state.filter.category) return false;
      if (state.filter.status === "enabled" && !job.enabled) return false;
      if (state.filter.status === "disabled" && job.enabled) return false;
      if (state.filter.status === "failed" && job.lastStatus !== "failed") return false;
      if (state.filter.status === "due" && !isDue(job.nextRunAt)) return false;
      if (!keyword) return true;
      return [job.name, job.key, job.category].some((item) => String(item || "").toLowerCase().includes(keyword));
    })
    .sort((a, b) => {
      const aFailed = a.lastStatus === "failed" ? 1 : 0;
      const bFailed = b.lastStatus === "failed" ? 1 : 0;
      if (aFailed !== bFailed) return bFailed - aFailed;
      const aDue = isDue(a.nextRunAt) ? 1 : 0;
      const bDue = isDue(b.nextRunAt) ? 1 : 0;
      if (aDue !== bDue) return bDue - aDue;
      return String(a.key).localeCompare(String(b.key));
    });
});

async function loadJobs() {
  loading.value = true;
  try {
    const rows = await apiClient.get("/api/scheduled-jobs?run_limit=3", { noCache: true });
    state.jobs = Array.isArray(rows) ? rows : [];
  } catch (error) {
    ElMessage.error(error.message || "后台任务加载失败");
  } finally {
    loading.value = false;
  }
}

async function runJob(row) {
  await ElMessageBox.confirm(`确认立即运行「${row.name || row.key}」？`, "手动补跑", {
    type: "warning",
    confirmButtonText: "立即运行",
    cancelButtonText: "取消"
  });
  const next = new Set(runningKeys.value);
  next.add(row.key);
  runningKeys.value = next;
  try {
    await apiClient.post("/api/scheduled-jobs/run", { job_key: row.key });
    ElMessage.success("任务已触发");
    await loadJobs();
  } catch (error) {
    ElMessage.error(error.message || "任务执行失败");
  } finally {
    const done = new Set(runningKeys.value);
    done.delete(row.key);
    runningKeys.value = done;
  }
}

async function toggleJob(row) {
  const previous = !row.enabled;
  try {
    await apiClient.post("/api/scheduled-jobs/state", {
      job_key: row.key,
      enabled: row.enabled
    });
    ElMessage.success(row.enabled ? "任务已启用" : "任务已停用");
    await loadJobs();
  } catch (error) {
    row.enabled = previous;
    ElMessage.error(error.message || "任务状态更新失败");
  }
}

function openEdit(row) {
  activeJob.value = row;
  form.scheduleType = row.scheduleType || "interval";
  form.intervalMinutes = Number(row.intervalMinutes || 60);
  form.dailyTime = row.dailyTime || "02:00";
  form.catchupEnabled = Boolean(row.catchupEnabled);
  form.maxCatchupRuns = Number(row.maxCatchupRuns ?? 1);
  form.timeoutMinutes = Number(row.config?.timeoutMinutes || 30);
  form.scope = row.config?.scope || "";
  form.days = Number(row.config?.days || 7);
  editVisible.value = true;
}

async function saveConfig() {
  if (!activeJob.value) return;
  saving.value = true;
  try {
    await apiClient.post("/api/scheduled-jobs/config", {
      job_key: activeJob.value.key,
      scheduleType: form.scheduleType,
      intervalMinutes: Number(form.intervalMinutes),
      dailyTime: form.dailyTime,
      catchupEnabled: form.catchupEnabled,
      maxCatchupRuns: Number(form.maxCatchupRuns),
      config: {
        timeoutMinutes: Number(form.timeoutMinutes),
        scope: form.scope || "",
        days: Number(form.days)
      }
    });
    ElMessage.success("任务配置已更新");
    editVisible.value = false;
    await loadJobs();
  } catch (error) {
    ElMessage.error(error.message || "任务配置更新失败");
  } finally {
    saving.value = false;
  }
}

async function openRunDetail(row) {
  const run = row?.recentRuns?.[0];
  if (!run?.id) return;
  activeJob.value = row;
  activeRun.value = run;
  detailVisible.value = true;
  detailLoading.value = true;
  runEvents.value = [];
  try {
    const rows = await apiClient.get(`/api/scheduled-job-run-events?run_id=${run.id}&limit=200`, { noCache: true });
    runEvents.value = Array.isArray(rows) ? rows : [];
  } catch (error) {
    ElMessage.error(error.message || "运行详情加载失败");
  } finally {
    detailLoading.value = false;
  }
}

function resetFilters() {
  state.filter.category = "all";
  state.filter.status = "all";
  state.filter.keyword = "";
}

function isRunning(key) {
  return runningKeys.value.has(key);
}

function isDue(value) {
  if (!value) return false;
  const date = new Date(`${String(value).replace(" ", "T")}Z`);
  return !Number.isNaN(date.getTime()) && date.getTime() <= Date.now();
}

function formatDateTime(value) {
  return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true }) || "-";
}

function scheduleText(row) {
  if (row.scheduleType === "daily") return `每天 ${row.dailyTime || "-"}`;
  return `每 ${row.intervalMinutes || 0} 分钟`;
}

function configSummary(row) {
  const config = row?.config || {};
  const parts = [];
  if (config.scope === "today_only") parts.push("仅今日");
  else if (config.scope === "recent_window") parts.push(`最近 ${config.days || "?"} 天`);
  else if (config.scope === "full") parts.push("全量");
  if (config.timeoutMinutes) parts.push(`超时 ${config.timeoutMinutes} 分钟`);
  parts.push(row.catchupEnabled ? `补跑 ${row.maxCatchupRuns} 次` : "不补跑");
  return parts.join(" / ");
}

function runSummary(run) {
  const result = run?.result || {};
  if (run?.jobKey === "ozon_action_cleanup") {
    if (!run?.result && Number(run?.resultSize || 0) > 0) return "清理结果已写入日志明细";
    const parts = [];
    parts.push(`扫描店铺 ${Number(result.stores || 0)}`);
    parts.push(`移除 ${Number(result.removed || 0)}`);
    if (Number(result.failed || 0) > 0) parts.push(`失败 ${Number(result.failed || 0)}`);
    return parts.join(" / ");
  }
  if (!run?.result && Number(run?.resultSize || 0) > 0) return `结果较大，已省略列表详情 (${Math.round(Number(run.resultSize || 0) / 1024)} KB)`;
  const rows = Array.isArray(result.results) ? result.results : [];
  const errorCodes = rows.map((item) => String(item?.error_code || "")).filter(Boolean);
  if (errorCodes.includes("no_syncable_campaigns")) return "当前没有可同步的广告活动，后续会自动重试";
  if (rows.length && rows.every((item) => String(item?.error_code || "") === "no_syncable_campaigns")) return "当前没有可同步的广告活动，后续会自动重试";
  if (errorCodes.length && errorCodes.every((code) => code === "report_not_found")) return "报表结果暂未就绪，系统会继续重试";
  if (!rows.length) {
    if (run?.errorMessage) return run.errorMessage;
    if (result?.reason) return String(result.reason);
    return "";
  }
  const ok = rows.filter((item) => item.status === "ok").length;
  const failed = rows.filter((item) => item.status === "error").length;
  const skipped = rows.filter((item) => !["ok", "error"].includes(String(item.status || ""))).length;
  const timeoutCount = rows.filter((item) => String(item.error || "").toLowerCase().includes("timed out")).length;
  const parts = [];
  if (result.date) parts.push(`日期 ${result.date}`);
  if (result.from && result.to && result.from !== result.to) parts.push(`${result.from}~${result.to}`);
  if (ok) parts.push(`成功 ${ok}`);
  if (failed) parts.push(`失败 ${failed}`);
  if (skipped) parts.push(`跳过 ${skipped}`);
  if (timeoutCount) parts.push(`超时 ${timeoutCount}`);
  if (Number(result.imported || 0) > 0) parts.push(`导入 ${result.imported}`);
  return parts.join(" / ");
}

function recentRuns(row) {
  return Array.isArray(row?.recentRuns) ? row.recentRuns.slice(0, 3) : [];
}

function runErrorSummary(run) {
  const result = run?.result || {};
  if (run?.jobKey === "ozon_action_cleanup") {
    const rows = Array.isArray(result.results) ? result.results : [];
    const errors = rows.map((item) => item?.error).filter(Boolean);
    if (errors.length) return errors.slice(0, 2).join("；");
  }
  const rows = Array.isArray(result.results) ? result.results : [];
  const errorCodes = rows.map((item) => String(item?.error_code || "")).filter(Boolean);
  if (errorCodes.includes("no_syncable_campaigns")) return "店铺当前未开广告或暂无可同步商品";
  if (errorCodes.includes("report_not_found")) return "Ozon 广告报表结果延迟，系统已自动重试";
  const errors = Array.isArray(result.errors) ? result.errors.filter(Boolean) : [];
  if (errors.length) return errors.slice(0, 2).join("；");
  if (!run?.result && Number(run?.resultSize || 0) > 0 && run?.status && !["success", "running", "skipped"].includes(String(run.status))) {
    return "任务结果体积较大，列表未加载完整明细";
  }
  return run?.errorMessage || "";
}

function displayErrorText(row) {
  const latestRun = recentRuns(row)[0];
  return row?.lastError || runErrorSummary(latestRun) || "-";
}

function eventStatusType(status) {
  return {
    success: "success",
    warning: "warning",
    error: "danger",
    info: "info"
  }[status] || "info";
}

function eventDetailText(event) {
  if (!event?.detail_json) return "";
  try {
    const parsed = typeof event.detail_json === "string" ? JSON.parse(event.detail_json) : event.detail_json;
    return JSON.stringify(parsed);
  } catch {
    return String(event.detail_json || "");
  }
}

function categoryLabel(value) {
  return {
    orders: "订单",
    analytics: "分析",
    advertising: "广告",
    inventory: "库存",
    listing: "上架",
    maintenance: "维护"
  }[value] || value || "-";
}

function priorityType(priority) {
  return {
    critical: "danger",
    high: "warning",
    normal: "primary",
    low: "info"
  }[priority] || "info";
}

function statusType(status) {
  return {
    success: "success",
    partial: "warning",
    failed: "danger",
    running: "warning",
    skipped: "info"
  }[status] || "info";
}

function statusLabel(status) {
  return {
    success: "成功",
    partial: "部分成功",
    failed: "失败",
    running: "运行中",
    skipped: "跳过"
  }[status] || "待执行";
}

function jobDescription(row) {
  const map = {
    order_status_sync: "按增量同步 Ozon 订单基础状态，确保新订单和状态变化尽快进入系统。",
    cancelled_order_sync: "补抓已取消订单，避免取消状态遗漏，影响售后和利润口径。",
    posting_detail_sync: "按 posting number 回头补拉最近订单的货件详情，优先补齐待打包、待发货、配送中的订单。",
    posting_detail_deep_sync: "夜间大范围复查历史订单货件详情，用来兜底修复遗漏和后补状态。",
    analytics_refresh: "刷新利润分析快照，把订单、货件、售后变化重新汇总到利润看板和分析报表。",
    advertising_sync: "同步最近窗口期的广告数据，适合补齐近几天广告消耗、销售额和 ROI。",
    advertising_today_sync: "高频同步今天的广告数据，让首页和广告页尽量接近当日最新表现。",
    ozon_stock_sync: "同步 Ozon FBP 库存和可用量，用于库存预警、货值和库龄分析。",
    ozon_category_sync: "刷新 Ozon 类目属性与字典缓存，保证上架、编辑商品时的类目数据是新的。",
    ozon_action_cleanup: "清理 Ozon 营销动作里的自动添加商品，保持活动数据整洁。"
  };
  return map[row?.key] || "用于后台自动同步、补齐或刷新业务数据的计划任务。";
}

onMounted(loadJobs);
</script>

<template>
  <div class="page-stack scheduled-jobs-page">
    <el-card class="page-card scheduled-toolbar" shadow="never">
      <div class="scheduled-toolbar__main">
        <div class="scheduled-title">
          <strong>后台任务中心</strong>
          <span>统一查看同步、刷新、补跑任务</span>
        </div>
        <div class="scheduled-metrics">
          <div>
            <span>任务总数</span>
            <strong>{{ summary.total }}</strong>
          </div>
          <div>
            <span>已启用</span>
            <strong>{{ summary.enabled }}</strong>
          </div>
          <div>
            <span>待补跑</span>
            <strong>{{ summary.due }}</strong>
          </div>
          <div class="is-danger">
            <span>失败任务</span>
            <strong>{{ summary.failed }}</strong>
          </div>
        </div>
        <el-button class="erp-btn erp-btn-secondary" :icon="Refresh" :loading="loading" @click="loadJobs">刷新</el-button>
      </div>
      <div v-if="failedJobs.length" class="scheduled-alert">
        <el-icon><Warning /></el-icon>
        <span>当前有 {{ failedJobs.length }} 个失败任务，建议优先处理并补跑。</span>
        <el-button class="erp-btn-link erp-btn-link-danger" text type="danger" @click="state.filter.status = 'failed'">只看失败任务</el-button>
      </div>
    </el-card>

    <el-card class="page-card scheduled-table-card" shadow="never">
      <div class="filter-panel scheduled-filter">
        <el-form inline>
          <el-form-item label="分类">
            <el-select v-model="state.filter.category" class="scheduled-filter__select">
              <el-option label="全部" value="all" />
              <el-option v-for="item in categories" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="state.filter.status" class="scheduled-filter__select">
              <el-option label="全部" value="all" />
              <el-option label="启用" value="enabled" />
              <el-option label="停用" value="disabled" />
              <el-option label="失败" value="failed" />
              <el-option label="待补跑" value="due" />
            </el-select>
          </el-form-item>
          <el-form-item label="搜索">
            <el-input v-model="state.filter.keyword" clearable placeholder="任务名称 / key" class="scheduled-filter__search" />
          </el-form-item>
          <el-form-item>
            <el-button class="erp-btn erp-btn-secondary" @click="resetFilters">重置</el-button>
          </el-form-item>
        </el-form>
      </div>

      <el-table v-loading="loading" :data="filteredJobs" class="erp-data-table scheduled-table" row-key="key">
        <el-table-column label="任务" min-width="220" fixed>
          <template #default="{ row }">
            <div class="scheduled-job-name">
              <div class="scheduled-job-title">
                <strong>{{ row.name }}</strong>
                <el-tooltip :content="jobDescription(row)" placement="top" effect="light">
                  <el-icon class="scheduled-job-help"><InfoFilled /></el-icon>
                </el-tooltip>
              </div>
              <span>{{ row.key }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="分类" width="92">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ categoryLabel(row.category) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="优先级" width="96">
          <template #default="{ row }">
            <el-tag size="small" :type="priorityType(row.priority)" effect="plain">{{ row.priority }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="计划" width="140">
          <template #default="{ row }">{{ scheduleText(row) }}</template>
        </el-table-column>
        <el-table-column label="配置" min-width="220">
          <template #default="{ row }">{{ configSummary(row) }}</template>
        </el-table-column>
        <el-table-column label="上次成功" width="170">
          <template #default="{ row }">{{ formatDateTime(row.lastSuccessAt) }}</template>
        </el-table-column>
        <el-table-column label="下次执行" width="180">
          <template #default="{ row }">
            <div class="scheduled-date-cell">
              <span>{{ formatDateTime(row.nextRunAt) }}</span>
              <el-tag v-if="isDue(row.nextRunAt) && row.enabled" size="small" type="warning" effect="plain">待补跑</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="最近状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="statusType(row.lastStatus)" effect="plain">{{ statusLabel(row.lastStatus) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="失败次数" width="88" align="right" prop="failCount" />
        <el-table-column label="最近记录" min-width="230">
          <template #default="{ row }">
            <div class="scheduled-runs">
              <div v-for="run in recentRuns(row)" :key="run.id" class="scheduled-run-line">
                <el-tag size="small" :type="statusType(run.status)" effect="plain">{{ statusLabel(run.status) }}</el-tag>
                <span>{{ run.mode }}</span>
                <span>{{ formatDateTime(run.startedAt) }}</span>
              </div>
              <span v-if="recentRuns(row)[0] && runSummary(recentRuns(row)[0])" class="scheduled-run-summary">
                {{ runSummary(recentRuns(row)[0]) }}
              </span>
              <span v-if="!row.recentRuns?.length" class="scheduled-muted">暂无记录</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="错误" min-width="240">
          <template #default="{ row }">
            <el-tooltip :content="displayErrorText(row)" placement="top" effect="light" :disabled="displayErrorText(row) === '-'">
              <span class="scheduled-error">{{ displayErrorText(row) }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <div class="scheduled-actions">
              <el-switch v-model="row.enabled" size="small" @change="toggleJob(row)" />
              <el-button class="erp-btn-link" link :icon="EditPen" @click="openEdit(row)">配置</el-button>
              <el-button
                class="erp-btn-link"
                type="primary"
                link
                :icon="VideoPlay"
                :loading="isRunning(row.key)"
                :disabled="!row.enabled"
                @click="runJob(row)"
              >
                补跑
              </el-button>
              <el-button class="erp-btn-link" link :disabled="!row.recentRuns?.length" @click="openRunDetail(row)">日志</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="editVisible" title="任务配置" width="520px">
      <div v-if="activeJob" class="scheduled-dialog">
        <div class="scheduled-dialog__header">
          <strong>{{ activeJob.name }}</strong>
          <span>{{ activeJob.key }}</span>
        </div>
        <el-form label-width="120px">
          <el-form-item label="计划类型">
            <el-radio-group v-model="form.scheduleType">
              <el-radio-button label="interval">间隔</el-radio-button>
              <el-radio-button label="daily">每天</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="form.scheduleType === 'interval'" label="间隔分钟">
            <el-input-number v-model="form.intervalMinutes" :min="1" :max="1440" />
          </el-form-item>
          <el-form-item v-else label="每日时间">
            <el-time-picker
              v-model="form.dailyTime"
              value-format="HH:mm"
              format="HH:mm"
              :clearable="false"
              :editable="false"
              style="width: 180px"
            />
          </el-form-item>
          <el-form-item label="允许补跑">
            <el-switch v-model="form.catchupEnabled" />
          </el-form-item>
          <el-form-item label="补跑上限">
            <el-input-number v-model="form.maxCatchupRuns" :min="0" :max="24" />
          </el-form-item>
          <el-form-item label="超时分钟">
            <el-input-number v-model="form.timeoutMinutes" :min="1" :max="720" />
          </el-form-item>
          <el-form-item label="同步范围">
            <el-select v-model="form.scope" style="width: 220px">
              <el-option label="默认" value="" />
              <el-option label="仅今日" value="today_only" />
              <el-option label="最近窗口" value="recent_window" />
              <el-option label="全量" value="full" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="form.scope === 'recent_window'" label="窗口天数">
            <el-input-number v-model="form.days" :min="1" :max="365" />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="editVisible = false">取消</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="saving" @click="saveConfig">保存</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="detailVisible" title="运行日志" width="760px">
      <div v-if="activeJob" class="scheduled-dialog">
        <div class="scheduled-dialog__header">
          <strong>{{ activeJob.name }}</strong>
          <span>{{ activeRun?.mode || "-" }} / {{ formatDateTime(activeRun?.startedAt) }}</span>
        </div>
        <el-table v-loading="detailLoading" :data="runEvents" class="erp-data-table" height="420" empty-text="暂无日志">
          <el-table-column label="时间" width="160">
            <template #default="{ row }">{{ formatDateTime(row.created_at) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="86">
            <template #default="{ row }">
              <el-tag size="small" :type="eventStatusType(row.status)" effect="plain">{{ row.status || "info" }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="店铺" width="150">
            <template #default="{ row }">{{ row.shop_name || row.shop_id || "-" }}</template>
          </el-table-column>
          <el-table-column label="内容" min-width="260">
            <template #default="{ row }">
              <div class="scheduled-event-message">
                <span>{{ row.message || row.step_key || "-" }}</span>
                <small v-if="eventDetailText(row)">{{ eventDetailText(row) }}</small>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.scheduled-jobs-page {
  min-height: 100%;
}

.scheduled-toolbar :deep(.el-card__body) {
  display: grid;
  gap: 14px;
  padding: 14px 16px;
}

.scheduled-toolbar__main {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) auto auto;
  gap: 16px;
  align-items: center;
}

.scheduled-title {
  display: grid;
  gap: 4px;
}

.scheduled-title strong {
  color: var(--erp-text);
  font-size: 18px;
}

.scheduled-title span,
.scheduled-muted,
.scheduled-dialog__header span {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.scheduled-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(72px, 1fr));
  gap: 8px;
}

.scheduled-metrics div {
  min-height: 54px;
  display: grid;
  gap: 3px;
  align-content: center;
  padding: 8px 10px;
  border: 1px solid var(--erp-border);
  border-radius: 8px;
  background: var(--erp-surface-alt);
}

.scheduled-metrics .is-danger {
  border-color: rgba(220, 38, 38, 0.22);
  background: rgba(254, 242, 242, 0.92);
}

.scheduled-metrics span {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.scheduled-metrics strong {
  color: var(--erp-text);
  font-size: 18px;
}

.scheduled-alert {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(220, 38, 38, 0.2);
  background: rgba(254, 242, 242, 0.92);
  color: #991b1b;
}

.scheduled-table-card {
  flex: 1;
  min-height: 0;
}

.scheduled-table-card :deep(.el-card__body) {
  height: calc(100vh - 188px);
  min-height: 520px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.scheduled-filter {
  flex: none;
}

.scheduled-filter__select {
  width: 132px;
}

.scheduled-filter__search {
  width: 220px;
}

.scheduled-table {
  flex: 1;
  min-height: 0;
}

.scheduled-job-name,
.scheduled-date-cell,
.scheduled-runs,
.scheduled-dialog,
.scheduled-dialog__header {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.scheduled-job-name strong,
.scheduled-dialog__header strong {
  color: var(--erp-text);
  font-size: 13px;
}

.scheduled-job-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.scheduled-job-help {
  color: var(--erp-text-secondary);
  cursor: help;
}

.scheduled-job-help:hover {
  color: var(--erp-primary);
}

.scheduled-job-name span,
.scheduled-date-cell span,
.scheduled-run-line span {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.scheduled-run-summary {
  color: var(--erp-text);
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scheduled-run-error {
  color: var(--erp-danger);
  font-size: 12px;
  line-height: 1.5;
}

.scheduled-run-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.scheduled-error {
  display: block;
  max-width: 320px;
  color: var(--erp-danger);
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.scheduled-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.scheduled-event-message {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.scheduled-event-message span {
  color: var(--erp-text);
  font-size: 13px;
}

.scheduled-event-message small {
  color: var(--erp-text-secondary);
  font-size: 12px;
  line-height: 1.45;
  word-break: break-all;
}

@media (max-width: 960px) {
  .scheduled-toolbar__main {
    grid-template-columns: 1fr;
  }

  .scheduled-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .scheduled-table-card :deep(.el-card__body) {
    height: auto;
    min-height: 520px;
  }
}
</style>
