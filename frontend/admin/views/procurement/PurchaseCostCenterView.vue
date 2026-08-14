<script setup>
import { onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import ErpPageHeader from "../../components/ErpPageHeader.vue";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import { apiClient } from "../../utils/api.js";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";

const mode = ref("latest");
const loading = ref(false);
const rows = ref([]);
const total = ref(0);
const summary = reactive({ product_count: 0, pending_count: 0, critical_count: 0, version_count: 0 });
const filters = reactive({ query: "", channel: "", page: 1, pageSize: 20 });
const detailVisible = ref(false);
const detailRow = ref(null);
const reviewVisible = ref(false);
const reviewSubmitting = ref(false);
const reviewForm = reactive({ id: null, product_name: "", reason: "" });
const backfillVisible = ref(false);
const backfillLoading = ref(false);
const backfillSubmitting = ref(false);
const backfillPreview = ref(null);

const tabs = [
  { value: "latest", label: "成本动态" },
  { value: "exceptions", label: "异常待处理" },
  { value: "history", label: "版本记录" }
];

const channels = [
  { value: "", label: "全部渠道" },
  { value: "1688", label: "1688" },
  { value: "pdd", label: "拼多多" },
  { value: "taobao", label: "淘宝" },
  { value: "wechat", label: "微信" },
  { value: "supplier", label: "供应商" },
  { value: "offline", label: "线下" },
  { value: "other", label: "其他" }
];

function channelText(value) {
  return channels.find((item) => item.value === String(value || ""))?.label || "其他";
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

function dateText(value) {
  return value ? shanghaiDateTimeText(value, { assumeUtcWhenNaive: true }) : "-";
}

function changeText(row) {
  if (row.change_ratio == null) return "首次采购";
  const value = Number(row.change_ratio || 0) * 100;
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function anomalyText(value) {
  return {
    first_purchase: "首次采购",
    normal: "正常",
    warning: "价格提醒",
    abnormal: "价格异常",
    critical: "严重异常"
  }[value] || "正常";
}

function anomalyType(value) {
  return { critical: "danger", abnormal: "danger", warning: "warning", normal: "success" }[value] || "info";
}

function statusText(value) {
  return { active: "当前版本", revised: "已修订", void: "已撤销" }[value] || value || "-";
}

function stageText(value) {
  return {
    purchased: "采购确认",
    purchased_revision: "采购修订",
    inbound_final: "入库确认"
  }[value] || value || "-";
}

async function loadData() {
  loading.value = true;
  try {
    const params = new URLSearchParams({
      mode: mode.value,
      page: String(filters.page),
      pageSize: String(filters.pageSize)
    });
    if (filters.query.trim()) params.set("query", filters.query.trim());
    if (filters.channel) params.set("channel", filters.channel);
    const result = await apiClient.get(`/api/procurement/cost-versions?${params.toString()}`);
    rows.value = Array.isArray(result?.rows) ? result.rows : [];
    total.value = Number(result?.total || 0);
    Object.assign(summary, result?.summary || {});
  } catch (error) {
    ElMessage.error(error.message || "采购成本数据加载失败");
  } finally {
    loading.value = false;
  }
}

function search() {
  filters.page = 1;
  loadData();
}

function reset() {
  filters.query = "";
  filters.channel = "";
  filters.page = 1;
  loadData();
}

function openDetail(row) {
  detailRow.value = row;
  detailVisible.value = true;
}

function openReview(row) {
  reviewForm.id = Number(row.id);
  reviewForm.product_name = row.product_name || "";
  reviewForm.reason = row.anomaly_reason || "";
  reviewVisible.value = true;
}

async function submitReview() {
  if (!reviewForm.reason.trim()) {
    ElMessage.warning("请填写异常原因和核对结论");
    return;
  }
  reviewSubmitting.value = true;
  try {
    await apiClient.post(`/api/procurement/cost-versions/${reviewForm.id}/review`, { reason: reviewForm.reason.trim() });
    ElMessage.success("采购成本异常已复核");
    reviewVisible.value = false;
    await loadData();
  } catch (error) {
    ElMessage.error(error.message || "复核失败");
  } finally {
    reviewSubmitting.value = false;
  }
}

async function openBackfillPreview() {
  backfillVisible.value = true;
  backfillLoading.value = true;
  try {
    backfillPreview.value = await apiClient.get("/api/procurement/cost-versions/backfill-preview");
  } catch (error) {
    ElMessage.error(error.message || "历史采购成本预览加载失败");
  } finally {
    backfillLoading.value = false;
  }
}

async function confirmBackfill() {
  const count = Number(backfillPreview.value?.summary?.trusted_count || 0);
  if (!count) return;
  await ElMessageBox.confirm(
    `将为 ${count} 条资料完整的历史采购记录生成成本版本。待补充资料的记录不会写入，是否继续？`,
    "确认初始化历史成本",
    { type: "warning", confirmButtonText: "确认初始化", cancelButtonText: "取消" }
  );
  backfillSubmitting.value = true;
  try {
    const result = await apiClient.post("/api/procurement/cost-versions/backfill", { confirm: true });
    ElMessage.success(`已生成 ${Number(result?.created_count || 0)} 条成本版本，跳过 ${Number(result?.skipped_count || 0)} 条`);
    backfillVisible.value = false;
    await loadData();
  } catch (error) {
    ElMessage.error(error.message || "历史采购成本初始化失败");
  } finally {
    backfillSubmitting.value = false;
  }
}

watch(mode, () => {
  filters.page = 1;
  loadData();
});

onMounted(loadData);
</script>

<template>
  <div class="page-stack purchase-cost-center-page">
    <ErpPageHeader title="成本与异常" description="集中查看采购成本变化、渠道来源和待复核异常；不会在这里修改订单利润。">
      <template #actions>
        <el-button @click="openBackfillPreview">历史成本初始化</el-button>
        <el-button @click="loadData">刷新数据</el-button>
      </template>
    </ErpPageHeader>

    <div class="cost-summary-grid">
      <div><span>成本商品</span><strong>{{ summary.product_count || 0 }}</strong></div>
      <div :class="{ 'is-warning': summary.pending_count > 0 }"><span>待复核</span><strong>{{ summary.pending_count || 0 }}</strong></div>
      <div :class="{ 'is-danger': summary.critical_count > 0 }"><span>严重异常</span><strong>{{ summary.critical_count || 0 }}</strong></div>
      <div><span>累计版本</span><strong>{{ summary.version_count || 0 }}</strong></div>
    </div>

    <el-card shadow="never" class="cost-center-card">
      <div class="cost-center-toolbar">
        <el-segmented v-model="mode" :options="tabs.map((item) => ({ label: item.label, value: item.value }))" />
        <div class="cost-center-filters">
          <el-input v-model="filters.query" clearable placeholder="商品名称、编码或供应商" @keyup.enter="search" />
          <el-select v-model="filters.channel">
            <el-option v-for="item in channels" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <el-button type="primary" @click="search">查询</el-button>
          <el-button @click="reset">重置</el-button>
        </div>
      </div>

      <div class="cost-table-wrap">
        <el-table v-loading="loading" :data="rows" height="100%" stripe border>
          <el-table-column label="商品" min-width="300" fixed="left">
            <template #default="{ row }">
              <div class="cost-product-cell">
                <ProductImagePreview :src="row.product_image_url" :preview-list="row.product_image_url ? [row.product_image_url] : []" />
                <div><strong>{{ row.product_name || "-" }}</strong><span>{{ row.product_code || `ID ${row.product_id}` }}</span></div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="版本" width="92" align="center"><template #default="{ row }">V{{ row.version_no }}</template></el-table-column>
          <el-table-column label="渠道" width="100" align="center"><template #default="{ row }"><el-tag effect="plain">{{ channelText(row.source_type) }}</el-tag></template></el-table-column>
          <el-table-column prop="supplier_name_snapshot" label="供应商" min-width="140" show-overflow-tooltip />
          <el-table-column label="数量" width="90" align="right"><template #default="{ row }">{{ row.quantity }}</template></el-table-column>
          <el-table-column label="商品单价" width="118" align="right"><template #default="{ row }">¥{{ money(row.goods_unit_cost) }}</template></el-table-column>
          <el-table-column label="含运成本" width="118" align="right"><template #default="{ row }">¥{{ money(row.landed_unit_cost) }}</template></el-table-column>
          <el-table-column label="较上版" width="105" align="center"><template #default="{ row }"><span :class="['cost-change', { 'is-up': Number(row.change_ratio) > 0, 'is-down': Number(row.change_ratio) < 0 }]">{{ changeText(row) }}</span></template></el-table-column>
          <el-table-column label="异常" width="110" align="center"><template #default="{ row }"><el-tag :type="anomalyType(row.anomaly_level)">{{ anomalyText(row.anomaly_level) }}</el-tag></template></el-table-column>
          <el-table-column v-if="mode === 'history'" label="状态" width="105" align="center"><template #default="{ row }">{{ statusText(row.status) }}</template></el-table-column>
          <el-table-column label="形成时间" width="180"><template #default="{ row }">{{ dateText(row.created_at) }}</template></el-table-column>
          <el-table-column label="操作" width="150" fixed="right" align="center">
            <template #default="{ row }">
              <el-button link type="primary" @click="openDetail(row)">详情</el-button>
              <el-button v-if="row.review_status === 'pending'" link type="warning" @click="openReview(row)">复核</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <PageFooterPagination
        :total="total"
        :page="filters.page"
        :page-size="filters.pageSize"
        :page-sizes="[20, 50, 100]"
        @update:page="(value) => { filters.page = value; loadData(); }"
        @update:pageSize="(value) => { filters.pageSize = value; filters.page = 1; loadData(); }"
      />
    </el-card>

    <el-drawer v-model="detailVisible" title="采购成本版本详情" size="520px">
      <div v-if="detailRow" class="cost-detail-list">
        <div><span>商品</span><strong>{{ detailRow.product_name }}</strong></div>
        <div><span>版本 / 环节</span><strong>V{{ detailRow.version_no }} · {{ stageText(detailRow.stage) }}</strong></div>
        <div><span>采购渠道</span><strong>{{ channelText(detailRow.source_type) }}</strong></div>
        <div><span>供应商</span><strong>{{ detailRow.supplier_name_snapshot || "-" }}</strong></div>
        <div><span>数量</span><strong>{{ detailRow.quantity }}</strong></div>
        <div><span>货款 / 运费</span><strong>¥{{ money(detailRow.amount) }} / ¥{{ money(detailRow.shipping_amount) }}</strong></div>
        <div><span>商品单价 / 含运成本</span><strong>¥{{ money(detailRow.goods_unit_cost) }} / ¥{{ money(detailRow.landed_unit_cost) }}</strong></div>
        <div><span>异常状态</span><strong>{{ anomalyText(detailRow.anomaly_level) }} · {{ changeText(detailRow) }}</strong></div>
        <div><span>采购人员</span><strong>{{ detailRow.creator_name || "-" }}</strong></div>
        <div><span>采购链接</span><a v-if="detailRow.purchase_url" :href="detailRow.purchase_url" target="_blank" rel="noopener noreferrer">打开采购页面</a><strong v-else>-</strong></div>
        <div><span>复核结论</span><strong>{{ detailRow.anomaly_reason || "-" }}</strong></div>
        <div><span>复核人 / 时间</span><strong>{{ detailRow.reviewer_name || "-" }} / {{ dateText(detailRow.reviewed_at) }}</strong></div>
      </div>
    </el-drawer>

    <el-dialog v-model="reviewVisible" title="复核采购成本异常" width="560px" align-center>
      <el-alert type="warning" :closable="false" :title="`请核对「${reviewForm.product_name}」的数量、货款、渠道和供应商。`" />
      <el-input v-model="reviewForm.reason" type="textarea" :rows="5" placeholder="填写异常原因、核对结果及是否确认该采购价格" />
      <template #footer>
        <el-button @click="reviewVisible = false">取消</el-button>
        <el-button type="primary" :loading="reviewSubmitting" @click="submitReview">确认复核</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="backfillVisible" title="历史采购成本初始化" width="760px" align-center>
      <div v-loading="backfillLoading" class="backfill-preview">
        <el-alert
          type="info"
          :closable="false"
          title="系统只会初始化商品、数量、货款和采购渠道均完整的历史记录；资料有疑点的记录保留待处理。"
        />
        <div v-if="backfillPreview" class="backfill-summary">
          <div><span>历史记录</span><strong>{{ backfillPreview.summary.total_count || 0 }}</strong></div>
          <div class="is-safe"><span>可安全初始化</span><strong>{{ backfillPreview.summary.trusted_count || 0 }}</strong></div>
          <div class="is-warning"><span>待补充资料</span><strong>{{ backfillPreview.summary.needs_review_count || 0 }}</strong></div>
          <div><span>已经初始化</span><strong>{{ backfillPreview.summary.initialized_count || 0 }}</strong></div>
        </div>
        <div v-if="backfillPreview?.issue_samples?.length" class="backfill-issues">
          <div class="backfill-section-title">待补充资料样本（最多显示 50 条）</div>
          <el-table :data="backfillPreview.issue_samples" max-height="300" size="small" border>
            <el-table-column prop="product_name" label="商品" min-width="180" show-overflow-tooltip />
            <el-table-column label="采购环节" width="100"><template #default="{ row }">{{ stageText(row.stage) }}</template></el-table-column>
            <el-table-column prop="quantity" label="数量" width="70" align="right" />
            <el-table-column label="货款" width="90" align="right"><template #default="{ row }">¥{{ money(row.amount) }}</template></el-table-column>
            <el-table-column label="渠道" width="90"><template #default="{ row }">{{ channelText(row.source_type) }}</template></el-table-column>
            <el-table-column label="需处理" min-width="190"><template #default="{ row }">{{ row.issues?.join("、") || "-" }}</template></el-table-column>
          </el-table>
        </div>
        <el-empty v-else-if="backfillPreview && !backfillPreview.summary.trusted_count" description="没有需要初始化的可信历史记录" :image-size="72" />
      </div>
      <template #footer>
        <el-button @click="backfillVisible = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="!Number(backfillPreview?.summary?.trusted_count || 0)"
          :loading="backfillSubmitting"
          @click="confirmBackfill"
        >确认初始化 {{ backfillPreview?.summary?.trusted_count || 0 }} 条</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.purchase-cost-center-page { min-height: 0; }
.cost-summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.cost-summary-grid > div { display: grid; gap: 5px; padding: 14px 16px; border: 1px solid var(--erp-border-color, #e2e8f0); border-radius: 10px; background: #fff; }
.cost-summary-grid span { color: var(--erp-text-secondary, #64748b); font-size: 12px; }
.cost-summary-grid strong { font-size: 22px; }
.cost-summary-grid .is-warning strong { color: #d97706; }
.cost-summary-grid .is-danger strong { color: #dc2626; }
.backfill-preview { display: grid; min-height: 120px; gap: 14px; }
.backfill-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.backfill-summary > div { display: grid; gap: 4px; padding: 12px; border: 1px solid var(--erp-border-color, #e2e8f0); border-radius: 8px; background: #f8fafc; }
.backfill-summary span { color: var(--erp-text-secondary, #64748b); font-size: 12px; }
.backfill-summary strong { font-size: 20px; }
.backfill-summary .is-safe strong { color: #059669; }
.backfill-summary .is-warning strong { color: #d97706; }
.backfill-issues { display: grid; gap: 8px; }
.backfill-section-title { color: var(--erp-text-secondary, #64748b); font-size: 13px; }
.cost-center-card { display: flex; flex: 1; min-height: 0; }
.cost-center-card :deep(.el-card__body) { display: flex; flex: 1; min-height: 0; flex-direction: column; gap: 12px; width: 100%; }
.cost-center-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.cost-center-filters { display: grid; grid-template-columns: minmax(220px, 320px) 130px auto auto; gap: 8px; }
.cost-table-wrap { flex: 1; min-height: 420px; }
.cost-product-cell { display: flex; align-items: center; gap: 10px; min-width: 0; }
.cost-product-cell :deep(.product-image-preview) { flex: none; }
.cost-product-cell > div { display: grid; gap: 4px; min-width: 0; }
.cost-product-cell strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cost-product-cell span { color: var(--erp-text-secondary, #64748b); font-size: 12px; }
.cost-change.is-up { color: #dc2626; }
.cost-change.is-down { color: #059669; }
.cost-detail-list { display: grid; gap: 0; }
.cost-detail-list > div { display: grid; grid-template-columns: 145px 1fr; gap: 12px; padding: 13px 0; border-bottom: 1px solid #e2e8f0; }
.cost-detail-list span { color: var(--erp-text-secondary, #64748b); }
.cost-detail-list strong { font-weight: 600; word-break: break-word; }
.el-alert + .el-textarea { margin-top: 16px; }
@media (max-width: 1100px) {
  .cost-summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cost-center-toolbar { align-items: stretch; flex-direction: column; }
  .cost-center-filters { grid-template-columns: 1fr 140px auto auto; }
}
</style>
