<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { apiClient, currentApiCacheScope } from '../../admin/utils/api.js';
import { useAuthStore } from '../../admin/stores/auth.js';
import { hasPermission } from '../../../src/shared/permissions.js';
import { shanghaiDateDaysAgo, shanghaiDateKey } from '../../admin/utils/shanghai-date.js';

const props = defineProps({ row: { type: Object, required: true } });
const emit = defineEmits(['close']);
const auth = useAuthStore();
const canSync = computed(() => hasPermission(auth.user, 'finance'));
const evidence = ref(null);
const error = ref('');
const loading = ref(true);
const syncing = ref(false);
const cursor = ref(null);
const dateRange = ref([shanghaiDateDaysAgo(6), shanghaiDateKey()]);
const statusText = { pending: '待 WB 出账', needs_review: '账单有待核对项目', needs_fx: '缺少账单日期汇率', reported: '已有账单流水' };
const feeRows = {
  retailAmount: '账单销售额', ppvzSalesCommission: '平台佣金', acquiringFee: '支付手续费',
  forPay: '商品应付净额（含佣金及支付费）', deliveryService: '物流费用', paidStorage: '仓储费用',
  paidAcceptance: '入仓处理费', penalty: '罚款', deduction: '其他扣款', additionalPayment: '补偿／调整',
  rebillLogisticCost: '转付物流费用', cashbackAmount: '返现金额', cashbackDiscount: '返现折扣',
  cashbackCommissionChange: '返现佣金调整', net_settlement: '按已拉取账单计算的净额'
};

function money(value, currency = 'CNY') {
  return value == null ? '待核对' : `${currency} ${Number(value).toFixed(2)}`;
}

async function load() {
  const scope = currentApiCacheScope();
  loading.value = true;
  error.value = '';
  try {
    const result = await apiClient.get(`/api/wb/orders/financial-evidence?order_id=${props.row.id}`, { noCache: true });
    if (scope !== currentApiCacheScope()) return emit('close');
    evidence.value = result;
  } catch (failure) {
    if (scope !== currentApiCacheScope()) return emit('close');
    error.value = failure.message || 'WB 订单金额明细加载失败';
  } finally { loading.value = false; }
}

async function sync() {
  if (!canSync.value || syncing.value || !dateRange.value?.[0] || !dateRange.value?.[1]) return;
  const scope = currentApiCacheScope();
  syncing.value = true;
  try {
    const result = await apiClient.post('/api/wb/orders/sync-settlement', {
      order_id: props.row.id, date_from: dateRange.value[0], date_to: dateRange.value[1], cursor: cursor.value
    });
    if (scope !== currentApiCacheScope()) return emit('close');
    cursor.value = result.next_cursor;
    if (!result.fetched) ElMessage.info('所选日期范围没有更多 WB 账单流水。');
    else ElMessage.success(`已读取店铺账单 ${result.fetched} 行，请按平台频率限制继续拉取下一页。`);
    await load();
  } catch (failure) {
    if (scope === currentApiCacheScope()) ElMessage.error(failure.message);
  } finally { syncing.value = false; }
}

onMounted(load);
</script>

<template>
  <el-dialog :model-value="true" title="WB 订单利润明细" width="min(880px,94vw)" @close="emit('close')">
    <div v-loading="loading">
      <div v-if="canSync" class="wb-settlement-controls">
        <el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD"
          start-placeholder="账单开始日" end-placeholder="账单结束日" :disabled="syncing" @change="cursor=null" />
        <el-button type="primary" :loading="syncing" :disabled="!dateRange?.length" @click="sync">
          {{ cursor ? '继续拉取下一页' : '拉取 WB 正式账单' }}
        </el-button>
      </div>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <template v-if="evidence">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="订单">{{ row.posting_number }}</el-descriptions-item>
          <el-descriptions-item label="账单状态">{{ statusText[evidence.settlement?.state] }}</el-descriptions-item>
          <el-descriptions-item label="WB 下单折算售价">{{ money(evidence.revenue_cny) }}</el-descriptions-item>
          <el-descriptions-item label="本地出库成本">{{ money(evidence.posted_inventory_cost_cny) }}</el-descriptions-item>
          <el-descriptions-item label="已入账结算净额">{{ money(evidence.settlement?.net_settlement_cny) }}</el-descriptions-item>
          <el-descriptions-item label="已入账利润">{{ money(evidence.settlement?.actual_profit_cny) }}</el-descriptions-item>
        </el-descriptions>
        <el-table v-if="evidence.settlement?.amounts?.length" class="wb-settlement-rows" :data="Object.entries(feeRows)" size="small">
          <el-table-column label="费用项目" min-width="230"><template #default="{ row: fee }">{{ fee[1] }}</template></el-table-column>
          <el-table-column v-for="amount in evidence.settlement.amounts" :key="amount.currency" :label="amount.currency" min-width="130" align="right">
            <template #default="{ row: fee }">{{ money(amount[fee[0]], amount.currency) }}</template>
          </el-table-column>
        </el-table>
        <el-collapse v-if="evidence.settlement?.lines?.length">
          <el-collapse-item title="WB 原始账单流水">
            <el-table :data="evidence.settlement.lines" size="small" max-height="330">
              <el-table-column prop="report_id" label="报表编号" min-width="140" />
              <el-table-column prop="row_id" label="流水编号" min-width="140" />
              <el-table-column prop="date" label="账单日期" min-width="105" />
              <el-table-column prop="operation" label="WB 记账事项" min-width="160" />
              <el-table-column label="商品应付净额" min-width="140" align="right"><template #default="{ row: line }">{{ money(line.forPay, line.currency) }}</template></el-table-column>
              <el-table-column prop="fx_rate" label="人民币兑卢布汇率" min-width="135" />
            </el-table>
          </el-collapse-item>
        </el-collapse>
      </template>
    </div>
  </el-dialog>
</template>

<style scoped>
.wb-settlement-controls { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.wb-settlement-rows { margin-top: 12px; }
</style>
