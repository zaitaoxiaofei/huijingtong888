<script setup>
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api.js";
import { parseAlipayFile, parseWechatFile } from "../../utils/procurement-file-parsers.js";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import ErpPageHeader from "../../components/ErpPageHeader.vue";
import ErpFilterBar from "../../components/ErpFilterBar.vue";
import PageFooterPagination from "../../components/PageFooterPagination.vue";

const loading = ref(false);
const actionLoading = ref(false);
const wechatInput = ref(null);
const alipayInput = ref(null);
const paymentDialog = ref(false);
const paymentCandidates = ref([]);
const selectedPaymentId = ref(null);
const selectedOrder = ref(null);
const state = reactive({ rows: [], total: 0, summary: {}, platformSummary: [], filters: { platform: "all", status: "all", page: 1, pageSize: 30 } });

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams(state.filters);
    const result = await apiClient.get(`/api/procurement/reconciliation?${params}`);
    state.rows = result.rows || [];
    state.total = Number(result.total || 0);
    state.summary = result.summary || {};
    state.platformSummary = result.platform_summary || [];
  } catch (error) { ElMessage.error(error.message || "采购对账加载失败"); }
  finally { loading.value = false; }
}

async function importPayment(event, provider) {
  const file = event.target.files?.[0]; event.target.value = "";
  if (!file) return;
  actionLoading.value = true;
  try {
    const rows = provider === "wechat" ? await parseWechatFile(file) : await parseAlipayFile(file);
    const result = await apiClient.post("/api/procurement/payments/import", { provider, rows });
    ElMessage.success(`${provider === "wechat" ? "微信" : "支付宝"}导入 ${result.total} 笔，新增 ${result.inserted} 笔`);
    await autoMatch(false);
  } catch (error) { ElMessage.error(error.message || "账单导入失败"); }
  finally { actionLoading.value = false; }
}

async function autoMatch(showResult = true) {
  actionLoading.value = true;
  try {
    const result = await apiClient.post("/api/procurement/reconciliation/auto-match", {});
    if (showResult) ElMessage.success(`自动确认 ${result.confirmed} 单，待复核 ${result.suggested} 单`);
    await load();
  } finally { actionLoading.value = false; }
}

async function confirm(row, confirmed) {
  await apiClient.post(`/api/procurement/reconciliation/${row.match_id}/confirm`, { confirmed });
  ElMessage.success(confirmed ? "匹配已确认" : "匹配已驳回");
  await load();
}

async function openPaymentCandidates(row) {
  selectedOrder.value = row;
  selectedPaymentId.value = row.payment_id || null;
  paymentDialog.value = true;
  paymentCandidates.value = await apiClient.get(`/api/procurement/reconciliation/${row.id}/payment-candidates`) || [];
}

async function savePaymentMatch() {
  if (!selectedPaymentId.value) return ElMessage.warning("请选择一条支付流水");
  await apiClient.post(`/api/procurement/reconciliation/${selectedOrder.value.id}/payment-match`, { payment_transaction_id: selectedPaymentId.value });
  ElMessage.success("支付流水已人工确认");
  paymentDialog.value = false;
  await load();
}

async function applyCosts() {
  await ElMessageBox.confirm("将已确认支付金额写入采购记录，并按绑定数量更新库存商品采购成本。是否继续？", "应用实际采购成本", { type: "warning" });
  actionLoading.value = true;
  try {
    const result = await apiClient.post("/api/procurement/reconciliation/apply-costs", {});
    ElMessage.success(`已更新 ${result.updated} 条采购成本`);
    await load();
  } finally { actionLoading.value = false; }
}

function money(value) { return `¥${Number(value || 0).toFixed(2)}`; }
function platformTotal(platform, field) { return state.platformSummary.find((item) => item.platform === platform)?.[field] || 0; }
function time(value) { return shanghaiDateTimeText(value, { assumeUtcWhenNaive: false }); }
function statusText(value) { return ({ confirmed: "已确认", suggested: "待复核", rejected: "已驳回", unmatched: "未匹配" })[value] || value; }
function statusType(value) { return ({ confirmed: "success", suggested: "warning", rejected: "danger", unmatched: "info" })[value] || "info"; }
function search() { state.filters.page = 1; load(); }
onMounted(load);
</script>

<template>
  <div class="page-shell">
    <ErpPageHeader title="采购对账" description="以拼多多、1688平台订单为目标值，反向匹配微信和支付宝真实支付。">
      <template #actions>
        <input ref="wechatInput" type="file" accept=".xlsx" hidden @change="(event) => importPayment(event, 'wechat')">
        <input ref="alipayInput" type="file" accept=".csv" hidden @change="(event) => importPayment(event, 'alipay')">
        <el-button :loading="actionLoading" @click="wechatInput?.click()">导入微信账单</el-button>
        <el-button :loading="actionLoading" @click="alipayInput?.click()">导入支付宝账单</el-button>
        <el-button type="primary" :loading="actionLoading" @click="autoMatch()">自动对账</el-button>
        <el-button type="success" :loading="actionLoading" @click="applyCosts">应用实际成本</el-button>
      </template>
    </ErpPageHeader>

    <div class="summary-grid">
      <el-card shadow="never"><span>平台有效订单</span><strong>{{ Number(state.summary.effective_order_count || 0) }}</strong></el-card>
      <el-card shadow="never"><span>拼多多有效采购</span><strong>{{ money(platformTotal('pdd','platform_payable')) }}</strong></el-card>
      <el-card shadow="never"><span>1688有效采购</span><strong>{{ money(platformTotal('1688','platform_payable')) }}</strong></el-card>
      <el-card shadow="never"><span>已确认支付</span><strong>{{ money(state.summary.confirmed_payment) }}</strong></el-card>
      <el-card shadow="never"><span>待复核</span><strong>{{ Number(state.summary.suggested_count || 0) }}</strong></el-card>
      <el-card shadow="never"><span>未匹配</span><strong>{{ Number(state.summary.unmatched_count || 0) }}</strong></el-card>
    </div>

    <ErpFilterBar>
      <el-select v-model="state.filters.platform" style="width:130px" @change="search"><el-option label="全部平台" value="all" /><el-option label="拼多多" value="pdd" /><el-option label="1688" value="1688" /></el-select>
      <el-select v-model="state.filters.status" style="width:130px" @change="search"><el-option label="全部状态" value="all" /><el-option label="已确认" value="confirmed" /><el-option label="待复核" value="suggested" /><el-option label="未匹配" value="unmatched" /><el-option label="已驳回" value="rejected" /></el-select>
    </ErpFilterBar>

    <el-card shadow="never">
      <el-table v-loading="loading" :data="state.rows" border>
        <el-table-column label="平台订单" width="190"><template #default="{ row }"><div>{{ row.platform_order_no }}</div><small>{{ row.platform === 'pdd' ? '拼多多' : '1688' }} · {{ time(row.order_time) }}</small></template></el-table-column>
        <el-table-column prop="product_name" label="商品 / 采购绑定" min-width="260"><template #default="{ row }"><div class="ellipsis">{{ row.product_name }}</div><small>{{ row.procurement_names || '尚未绑定采购记录' }}</small></template></el-table-column>
        <el-table-column label="平台实付" width="100"><template #default="{ row }">{{ money(row.paid_amount) }}</template></el-table-column>
        <el-table-column label="支付流水" min-width="240"><template #default="{ row }"><template v-if="row.payment_id"><div>{{ row.provider === 'wechat' ? '微信' : '支付宝' }} · {{ money(row.payment_amount) }}</div><small>{{ time(row.transaction_time) }} · {{ row.counterparty }} · {{ row.payment_method }}</small></template><span v-else class="muted">尚未找到金额、时间相符的支付</span></template></el-table-column>
        <el-table-column label="状态" width="105"><template #default="{ row }"><el-tag :type="statusType(row.match_status)">{{ statusText(row.match_status) }}</el-tag><div v-if="row.confidence" class="confidence">{{ row.confidence }}%</div></template></el-table-column>
        <el-table-column label="操作" width="175" fixed="right"><template #default="{ row }"><template v-if="row.match_status === 'suggested'"><el-button link type="success" @click="confirm(row,true)">确认</el-button><el-button link type="danger" @click="confirm(row,false)">驳回</el-button></template><el-button v-if="row.match_status !== 'confirmed'" link type="primary" @click="openPaymentCandidates(row)">查找流水</el-button><span v-if="row.match_status === 'confirmed'">-</span></template></el-table-column>
      </el-table>
      <PageFooterPagination v-model:page="state.filters.page" v-model:page-size="state.filters.pageSize" :total="state.total" @change="load" />
    </el-card>

    <el-dialog v-model="paymentDialog" title="选择实际支付流水" width="880px">
      <el-alert type="info" :closable="false" :title="`平台订单 ${selectedOrder?.platform_order_no || ''}，实付 ${money(selectedOrder?.paid_amount)}`" />
      <el-table :data="paymentCandidates" height="430" highlight-current-row @current-change="(row) => selectedPaymentId = row?.id">
        <el-table-column width="55"><template #default="{ row }"><el-radio v-model="selectedPaymentId" :value="row.id" /></template></el-table-column>
        <el-table-column label="渠道" width="85"><template #default="{ row }">{{ row.provider === 'wechat' ? '微信' : '支付宝' }}</template></el-table-column>
        <el-table-column label="交易时间" width="170"><template #default="{ row }">{{ time(row.transaction_time) }}</template></el-table-column>
        <el-table-column prop="counterparty" label="交易对方" min-width="180" />
        <el-table-column prop="item_description" label="商品说明" min-width="180" show-overflow-tooltip />
        <el-table-column label="金额" width="90"><template #default="{ row }">{{ money(row.amount) }}</template></el-table-column>
        <el-table-column label="差额" width="90"><template #default="{ row }">{{ money(row.amount_difference) }}</template></el-table-column>
      </el-table>
      <template #footer><el-button @click="paymentDialog=false">取消</el-button><el-button type="primary" @click="savePaymentMatch">确认匹配</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-shell{display:flex;flex-direction:column;gap:14px}.summary-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.summary-grid :deep(.el-card__body){display:flex;flex-direction:column;gap:8px}.summary-grid span,small,.muted{color:var(--el-text-color-secondary)}.summary-grid strong{font-size:22px}.ellipsis{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.confidence{font-size:12px;color:var(--el-text-color-secondary);margin-top:4px}@media(max-width:900px){.summary-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
