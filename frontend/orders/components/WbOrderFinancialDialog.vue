<script setup>
import { onMounted, ref } from 'vue';
import { apiClient, currentApiCacheScope } from '../../admin/utils/api.js';

const props = defineProps({ row: { type: Object, required: true } });
const emit = defineEmits(['close']);
const evidence = ref(null);
const error = ref('');
const loading = ref(true);

function money(value) {
  return value == null ? '待核对' : `CNY ${Number(value).toFixed(2)}`;
}

onMounted(async () => {
  const scope = currentApiCacheScope();
  try {
    const result = await apiClient.get(`/api/wb/orders/financial-evidence?order_id=${props.row.id}`, { noCache: true });
    if (scope !== currentApiCacheScope()) return emit('close');
    evidence.value = result;
  } catch (failure) {
    if (scope !== currentApiCacheScope()) return emit('close');
    error.value = failure.message || 'WB 订单金额明细加载失败';
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <el-dialog :model-value="true" title="WB 订单金额明细" width="min(560px,94vw)" @close="emit('close')">
    <div v-loading="loading">
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <el-descriptions v-if="evidence" :column="1" border>
        <el-descriptions-item label="订单">{{ row.posting_number }}</el-descriptions-item>
        <el-descriptions-item label="WB 折算售价">{{ money(evidence.revenue_cny) }}</el-descriptions-item>
        <el-descriptions-item label="已记账本地出库成本">{{ money(evidence.posted_inventory_cost_cny) }}</el-descriptions-item>
        <el-descriptions-item label="WB 佣金、物流与结算">待接入结算账单</el-descriptions-item>
        <el-descriptions-item label="真实利润">待结算</el-descriptions-item>
      </el-descriptions>
    </div>
  </el-dialog>
</template>
