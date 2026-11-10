<script setup>
import { computed, defineAsyncComponent, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient, currentApiCacheScope } from "../../utils/api.js";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import DailyPurchaseExport from "../../components/procurement/DailyPurchaseExport.vue";
const InventorySupplyWorkspace = defineAsyncComponent(() => import("../../components/inventory/InventorySupplyWorkspace.vue"));
const ProcurementArrivalTracker = defineAsyncComponent(() => import("../../components/procurement/ProcurementArrivalTracker.vue"));
const ProcurementLedgerDialog = defineAsyncComponent(() => import("../../components/procurement/ProcurementLedgerDialog.vue"));
const route = useRoute(), router = useRouter();
const arrivalRecordsVisible = ref(false), reviewVisible = ref(false);
const productId = computed(() => Number(route.query.product_id || route.query.review_product_id) || 0);
let disposed = false;
const messageRequestVisible = ref(false), messageRequestLoading = ref(false), messageRequestRecord = ref(null), messageRequestError = ref("");
let messageRequestController, messageRequestVersion = 0;
function resetMessageRequest() {
  messageRequestVersion++; messageRequestController?.abort(); messageRequestVisible.value = false;
  messageRequestRecord.value = null; messageRequestError.value = ""; messageRequestLoading.value = false;
}
function closeMessageRequest() {
  resetMessageRequest();
  if (route.query.message_request_id) {
    const query = { ...route.query }; delete query.message_request_id;
    router.replace({ query }).catch(() => {});
  }
}
async function openMessageRequest(value) {
  resetMessageRequest();
  const requestId = Number(value);
  if (!Number.isSafeInteger(requestId) || requestId <= 0) return;
  const version = messageRequestVersion, scope = currentApiCacheScope();
  messageRequestController = new AbortController();
  messageRequestVisible.value = true; messageRequestLoading.value = true;
  try {
    const result = await apiClient.get(`/api/enterprise/messages/reference?type=procurement&id=${requestId}`, { noCache: true, signal: messageRequestController.signal });
    if (!disposed && version === messageRequestVersion && scope === currentApiCacheScope()) messageRequestRecord.value = result.record;
  } catch (error) {
    if (!disposed && version === messageRequestVersion && scope === currentApiCacheScope() && error.name !== "AbortError") messageRequestError.value = error.message || "当前采购需求暂不可访问";
  } finally { if (!disposed && version === messageRequestVersion && scope === currentApiCacheScope()) messageRequestLoading.value = false; }
}
function messageRequestStatus(value) { return ({ pending: "待采购", ordered: "已下单", purchased: "已采购", completed: "已完成", closed: "已关闭", cancelled: "已取消", rejected: "已拒绝", partially_received: "部分收货", received: "已收货" })[value] || value || "—"; }
watch(() => route.query.message_request_id, openMessageRequest, { immediate: true });

// Old bookmarks retain their product/message context but never mount the retired workbench.
watch(() => route.query.mode, mode => {
  if (mode === "purchase") router.replace({ query: { ...route.query, mode: undefined } }).catch(() => {});
}, { immediate: true });
watch(() => route.query.review_product_id, value => { reviewVisible.value = Number(value) > 0; }, { immediate: true });
function closeReview() {
  const query = { ...route.query }; delete query.review_product_id; delete query.review_order_no;
  router.replace({ query }).catch(() => {});
}
onMounted(() => window.addEventListener("erp:auth-scope-changed", resetMessageRequest));
onBeforeUnmount(() => { disposed = true; resetMessageRequest(); window.removeEventListener("erp:auth-scope-changed", resetMessageRequest); });
</script>
<template>
  <div class="page-stack procurement-workspace">
    <InventorySupplyWorkspace entry="procurement" :initial-task="route.query.mode === 'arrivals' ? 'incoming' : ''" :product-id="productId" @clear-product="router.replace({ query: { ...route.query, product_id: undefined, review_product_id: undefined } })">
      <template #heading-actions><el-button plain @click="arrivalRecordsVisible = true">采购批次记录</el-button></template>
      <template #purchase-actions><DailyPurchaseExport /></template>
    </InventorySupplyWorkspace>
    <el-dialog v-if="arrivalRecordsVisible" v-model="arrivalRecordsVisible" title="采购批次记录" width="95%" append-to-body destroy-on-close><ProcurementArrivalTracker :product-id="productId" /></el-dialog>
    <ProcurementLedgerDialog v-if="reviewVisible" v-model="reviewVisible" :product-id="productId" initial-tab="history" @update:model-value="value => !value && closeReview()" />
    <el-dialog v-if="messageRequestVisible" v-model="messageRequestVisible" title="私信关联的采购需求" width="min(620px, 94vw)" append-to-body destroy-on-close @close="closeMessageRequest">
      <div v-loading="messageRequestLoading" style="min-height: 100px">
        <el-alert v-if="messageRequestError" :title="messageRequestError" type="error" :closable="false" show-icon />
        <el-descriptions v-if="messageRequestRecord" :column="1" border>
          <el-descriptions-item label="需求编号">#{{ messageRequestRecord.id }}</el-descriptions-item>
          <el-descriptions-item label="库存商品">{{ messageRequestRecord.product_name || '—' }}</el-descriptions-item>
          <el-descriptions-item label="需求数量">{{ messageRequestRecord.quantity }} 件</el-descriptions-item>
          <el-descriptions-item label="处理状态">{{ messageRequestStatus(messageRequestRecord.status) }}</el-descriptions-item>
          <el-descriptions-item label="来源订单">{{ messageRequestRecord.source_posting_number || '—' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ shanghaiDateTimeText(messageRequestRecord.created_at, { assumeUtcWhenNaive: true }) }}</el-descriptions-item>
          <el-descriptions-item label="备注">{{ messageRequestRecord.note || '—' }}</el-descriptions-item>
        </el-descriptions>
      </div>
      <template #footer><el-button @click="messageRequestVisible = false">关闭</el-button></template>
    </el-dialog>
  </div>
</template>
