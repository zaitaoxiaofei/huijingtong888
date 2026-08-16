<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { Refresh } from "@element-plus/icons-vue";
import ErpPageHeader from "../../components/ErpPageHeader.vue";
import { apiClient } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date";

const loading = ref(false);
const state = reactive({ latest: null, history: [], thresholds: {} });

const severityMeta = computed(() => ({
  normal: { label: "运行正常", type: "success" },
  warning: { label: "需要关注", type: "warning" },
  critical: { label: "磁盘告警", type: "danger" }
}[state.latest?.severity] || { label: "暂无快照", type: "info" }));

const storageRows = computed(() => {
  const item = state.latest || {};
  return [
    ["MySQL 数据目录", item.mysqlBytes],
    ["MySQL Binlog", item.binlogBytes],
    ["业务上传目录", item.uploadsBytes],
    ["发布版本", item.releasesBytes],
    ["备份目录", item.backupsBytes],
    ["系统日志", item.logsBytes]
  ].map(([name, bytes]) => ({ name, bytes: Number(bytes || 0) }));
});

async function loadOverview() {
  loading.value = true;
  try {
    const result = await apiClient.get("/api/system-monitoring?days=30", { noCache: true });
    Object.assign(state, result || {});
  } catch (error) {
    ElMessage.error(error.message || "系统监控数据加载失败");
  } finally {
    loading.value = false;
  }
}

function bytesText(value) {
  const bytes = Number(value || 0);
  const absolute = Math.abs(bytes);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let amount = absolute;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  const prefix = bytes < 0 ? "-" : "";
  return `${prefix}${amount.toFixed(index >= 3 ? 2 : 1)} ${units[index]}`;
}

function growthText(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "无明显增长";
  return `${bytes > 0 ? "+" : ""}${bytesText(bytes)}`;
}

onMounted(loadOverview);
</script>

<template>
  <section class="monitor-page" v-loading="loading">
    <ErpPageHeader title="系统监控" description="每日低峰采集磁盘快照，监控容量、增长速度和主要占用来源。">
      <template #actions>
        <el-button :icon="Refresh" :loading="loading" @click="loadOverview">刷新数据</el-button>
      </template>
    </ErpPageHeader>

    <el-alert
      v-if="!state.latest"
      title="监控快照尚未生成，将在定时任务首次执行后显示数据。"
      type="info"
      show-icon
      :closable="false"
    />

    <template v-else>
      <div class="summary-grid">
        <article class="metric-card metric-card--primary">
          <div class="metric-head"><span>根磁盘使用率</span><el-tag :type="severityMeta.type">{{ severityMeta.label }}</el-tag></div>
          <strong>{{ Number(state.latest.usagePercent || 0).toFixed(1) }}%</strong>
          <el-progress :percentage="Math.min(100, Number(state.latest.usagePercent || 0))" :stroke-width="8" :show-text="false" />
          <small>已用 {{ bytesText(state.latest.diskUsedBytes) }} / 共 {{ bytesText(state.latest.diskTotalBytes) }}</small>
        </article>
        <article class="metric-card">
          <span>可用空间</span><strong>{{ bytesText(state.latest.diskAvailableBytes) }}</strong>
          <small>75% 提醒，85% 严重告警</small>
        </article>
        <article class="metric-card">
          <span>较上次快照增长</span><strong :class="{ danger: state.latest.dailyGrowthBytes >= state.thresholds.warningDailyGrowthBytes }">{{ growthText(state.latest.dailyGrowthBytes) }}</strong>
          <small>单日增长超过 1 GB 时提醒</small>
        </article>
        <article class="metric-card">
          <span>应用内存 RSS</span><strong>{{ bytesText(state.latest.appRssBytes) }}</strong>
          <small>采集时服务已运行 {{ Math.floor(Number(state.latest.serviceUptimeSeconds || 0) / 3600) }} 小时</small>
        </article>
      </div>

      <div class="monitor-grid">
        <el-card shadow="never" class="panel">
          <template #header><div class="panel-title"><span>存储构成</span><small>采集于 {{ shanghaiDateTimeText(state.latest.capturedAt) }}</small></div></template>
          <el-table :data="storageRows" size="small">
            <el-table-column prop="name" label="目录 / 类型" min-width="150" />
            <el-table-column label="占用" width="130"><template #default="scope">{{ bytesText(scope.row.bytes) }}</template></el-table-column>
            <el-table-column label="占根磁盘" width="120"><template #default="scope">{{ state.latest.diskTotalBytes ? (scope.row.bytes / state.latest.diskTotalBytes * 100).toFixed(1) : "0.0" }}%</template></el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never" class="panel">
          <template #header><div class="panel-title"><span>数据库大表</span><small>用于定位持续增长来源</small></div></template>
          <el-table :data="state.latest.topTables || []" size="small" max-height="360">
            <el-table-column prop="tableName" label="表名" min-width="190" show-overflow-tooltip />
            <el-table-column label="估算行数" width="110"><template #default="scope">{{ Number(scope.row.rows || 0).toLocaleString() }}</template></el-table-column>
            <el-table-column label="总占用" width="110"><template #default="scope">{{ bytesText(scope.row.totalBytes) }}</template></el-table-column>
          </el-table>
        </el-card>
      </div>

      <el-card shadow="never" class="panel history-panel">
        <template #header><div class="panel-title"><span>近 30 天快照</span><small>保留 180 天</small></div></template>
        <el-table :data="state.history" size="small" max-height="420">
          <el-table-column label="采集时间" min-width="165"><template #default="scope">{{ shanghaiDateTimeText(scope.row.capturedAt) }}</template></el-table-column>
          <el-table-column label="使用率" width="100"><template #default="scope">{{ Number(scope.row.usagePercent || 0).toFixed(1) }}%</template></el-table-column>
          <el-table-column label="已用" width="110"><template #default="scope">{{ bytesText(scope.row.diskUsedBytes) }}</template></el-table-column>
          <el-table-column label="增长" width="120"><template #default="scope"><span :class="{ danger: scope.row.dailyGrowthBytes >= state.thresholds.warningDailyGrowthBytes }">{{ growthText(scope.row.dailyGrowthBytes) }}</span></template></el-table-column>
          <el-table-column label="MySQL" width="110"><template #default="scope">{{ bytesText(scope.row.mysqlBytes) }}</template></el-table-column>
          <el-table-column label="上传目录" width="110"><template #default="scope">{{ bytesText(scope.row.uploadsBytes) }}</template></el-table-column>
          <el-table-column label="状态" width="100"><template #default="scope"><el-tag :type="scope.row.severity === 'critical' ? 'danger' : scope.row.severity === 'warning' ? 'warning' : 'success'" size="small">{{ scope.row.severity === "critical" ? "告警" : scope.row.severity === "warning" ? "关注" : "正常" }}</el-tag></template></el-table-column>
        </el-table>
      </el-card>
    </template>
  </section>
</template>

<style scoped>
.monitor-page { min-height: 100%; padding: 0 18px 24px; background: #f5f7fb; }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin: 4px 0 14px; }
.metric-card { display: flex; flex-direction: column; gap: 10px; padding: 18px; border: 1px solid #e6eaf2; border-radius: 12px; background: #fff; }
.metric-card--primary { border-color: #cbdcfb; background: linear-gradient(145deg, #f7faff, #fff); }
.metric-card > span, .metric-head > span { color: #687386; font-size: 13px; }
.metric-card strong { color: #1f2937; font-size: 26px; line-height: 1.2; }
.metric-card small, .panel-title small { color: #9099aa; font-size: 12px; }
.metric-head, .panel-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.monitor-grid { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); gap: 14px; }
.panel { border-radius: 12px; }
.panel-title > span { color: #273244; font-weight: 650; }
.history-panel { margin-top: 14px; }
.danger { color: #dc2626 !important; }
@media (max-width: 1100px) { .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .monitor-grid { grid-template-columns: 1fr; } }
@media (max-width: 640px) { .monitor-page { padding: 0 10px 16px; } .summary-grid { grid-template-columns: 1fr; } .metric-card { padding: 14px; } }
</style>
