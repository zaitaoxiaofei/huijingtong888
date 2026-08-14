<script setup>
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Refresh, View } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api.js";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const batches = ref([]);
const activeBatch = ref(null);
let refreshTimer = 0;

const hasActiveWork = computed(() => batches.value.some((item) => ["queued", "running"].includes(item.status)));
const stageLabels = {
  queued: "等待处理", loading_draft: "读取草稿", analyzing: "产品识别", confirming_analysis: "自动确认识别",
  planning: "生成方案", confirming_plan: "自动审批方案", generating_main_image: "生成主图",
  reviewing_main_image: "主图质检", generating_details: "生成详情图", generating_copy: "生成文案",
  preparing_draft: "准备草稿", creating_draft: "创建复制草稿", completed: "已完成", failed: "失败"
};

async function loadBatches(options = {}) {
  if (!options.silent) loading.value = true;
  try {
    batches.value = await apiClient.get("/api/ai-material-optimization/batches", { noCache: true });
    const requested = String(route.query.batchNo || activeBatch.value?.batch_no || batches.value[0]?.batch_no || "");
    if (requested) await openBatch(requested, { updateRoute: false });
  } catch (error) {
    if (!options.silent) ElMessage.error(error.message || "素材优化记录加载失败");
  } finally {
    loading.value = false;
  }
}

async function openBatch(batchNo, options = {}) {
  activeBatch.value = await apiClient.get(`/api/ai-material-optimization/batches/${encodeURIComponent(batchNo)}`, { noCache: true });
  if (options.updateRoute !== false) await router.replace({ query: { ...route.query, batchNo } });
}

async function retryItem(item) {
  await apiClient.post(`/api/ai-material-optimization/items/${encodeURIComponent(item.item_no)}/retry`, {});
  ElMessage.success("失败任务已重新排队");
  await loadBatches({ silent: true });
}

function openDraft(id) {
  router.push({ name: "listing-automation", query: { draftId: String(id), returnTo: router.currentRoute.value.fullPath } });
}

function batchStatusLabel(status) {
  return { queued: "等待处理", running: "处理中", completed: "已完成", partial: "部分完成", failed: "失败" }[status] || status;
}
function statusType(status) {
  return { completed: "success", partial: "warning", failed: "danger", running: "primary" }[status] || "info";
}

function startRefreshTimer() {
  window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => { if (hasActiveWork.value) void loadBatches({ silent: true }); }, 5000);
}

function stopRefreshTimer() {
  window.clearInterval(refreshTimer);
  refreshTimer = 0;
}

onMounted(async () => {
  await loadBatches();
  startRefreshTimer();
});
onActivated(startRefreshTimer);
onDeactivated(stopRefreshTimer);
onUnmounted(stopRefreshTimer);
</script>

<template>
  <div class="material-records-page">
    <header class="page-toolbar">
      <div><h2>素材优化记录</h2><span>后台任务会持续运行，关闭页面不会中断。</span></div>
      <el-button :icon="Refresh" :loading="loading" @click="loadBatches()">刷新</el-button>
    </header>

    <div class="records-layout">
      <section class="batch-list">
        <button v-for="batch in batches" :key="batch.batch_no" :class="{ active: activeBatch?.batch_no === batch.batch_no }" @click="openBatch(batch.batch_no)">
          <div><strong>{{ batch.batch_no }}</strong><el-tag :type="statusType(batch.status)" size="small">{{ batchStatusLabel(batch.status) }}</el-tag></div>
          <span>{{ batch.optimization_scope === 'main_only' ? '只优化主图' : '全部优化' }} · 成功 {{ batch.success_count }}/{{ batch.total_count }} · 失败 {{ batch.failed_count }}</span>
          <em>{{ shanghaiDateTimeText(batch.created_at) }}</em>
        </button>
        <el-empty v-if="!batches.length && !loading" description="暂无素材优化记录" />
      </section>

      <section class="batch-detail">
        <template v-if="activeBatch">
          <div class="detail-heading">
            <div><h3>{{ activeBatch.batch_no }}</h3><span>成功 {{ activeBatch.success_count }} / {{ activeBatch.total_count }}，失败 {{ activeBatch.failed_count }}</span></div>
            <el-progress :percentage="activeBatch.total_count ? Math.round((activeBatch.success_count + activeBatch.failed_count) * 100 / activeBatch.total_count) : 0" :status="activeBatch.status === 'failed' ? 'exception' : undefined" />
          </div>
          <el-table :data="activeBatch.items" row-key="item_no">
            <el-table-column label="来源草稿" min-width="220">
              <template #default="{ row }"><strong>{{ row.source_title || `草稿 ${row.source_draft_id}` }}</strong><div class="muted">#{{ row.source_draft_id }}</div></template>
            </el-table-column>
            <el-table-column label="当前阶段" width="170"><template #default="{ row }"><el-tag :type="statusType(row.status)">{{ stageLabels[row.stage] || row.stage }}</el-tag></template></el-table-column>
            <el-table-column label="进度" width="180"><template #default="{ row }"><el-progress :percentage="row.progress_percent" /></template></el-table-column>
            <el-table-column label="结果" min-width="230"><template #default="{ row }"><span v-if="row.error_message" class="error-text">{{ row.error_message }}</span><span v-else-if="row.result_draft_id">新草稿 #{{ row.result_draft_id }}</span><span v-else class="muted">-</span></template></el-table-column>
            <el-table-column label="操作" width="150" fixed="right"><template #default="{ row }"><el-button v-if="row.result_draft_id" link type="primary" :icon="View" @click="openDraft(row.result_draft_id)">打开草稿</el-button><el-button v-if="row.status === 'failed'" link type="warning" @click="retryItem(row)">重试</el-button></template></el-table-column>
          </el-table>
        </template>
        <el-empty v-else description="选择一个批次查看明细" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.material-records-page { display: grid; gap: 12px; min-height: 0; }
.page-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; border: 1px solid #e5eaf3; border-radius: 8px; background: #fff; }
.page-toolbar h2, .detail-heading h3 { margin: 0; font-size: 18px; }
.page-toolbar span, .detail-heading span, .batch-list span, .batch-list em, .muted { color: #697386; font-size: 12px; font-style: normal; }
.records-layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 12px; min-height: 560px; }
.batch-list, .batch-detail { min-width: 0; border: 1px solid #e5eaf3; border-radius: 8px; background: #fff; overflow: hidden; }
.batch-list { display: flex; flex-direction: column; padding: 8px; gap: 6px; }
.batch-list button { display: grid; gap: 5px; width: 100%; padding: 10px; border: 1px solid #e5eaf3; border-radius: 6px; background: #fff; text-align: left; cursor: pointer; }
.batch-list button.active { border-color: #409eff; background: #f5f9ff; }
.batch-list button > div { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.batch-detail { padding: 12px; }
.detail-heading { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(240px, 420px); align-items: center; gap: 20px; margin-bottom: 12px; }
.detail-heading > div { display: grid; gap: 4px; }
.error-text { color: #f56c6c; font-size: 12px; line-height: 1.45; }
@media (max-width: 900px) { .records-layout { grid-template-columns: 1fr; } .detail-heading { grid-template-columns: 1fr; } }
</style>
