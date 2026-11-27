<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { currentWbTariff } from '../../../src/shared/wb-logistics-catalog.js';
import { estimateWbOrderProfit } from '../utils/wb-order-profit.js';
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
const inputs = reactive({ purchaseCost: null, domesticCost: null, weight: null, length: null, width: null, height: null,
  commissionRate: null, adRate: 0, otherRate: 0, returnRate: 0, returnLoss: 0 });
const commissionNote = ref('');
const warehouseId = ref(null);
let hydrated = false;
const tariff = computed(() => {
  const date = evidence.value?.estimate_inputs?.ordered_at;
  if (!date) return null;
  try { return currentWbTariff(date); } catch { return null; }
});
const rule = computed(() => tariff.value?.rows.find(row => row.id === warehouseId.value));
const estimate = computed(() => estimateWbOrderProfit({ ...inputs, sale: evidence.value?.revenue_cny }, rule.value));
const comparison = [
  ['销售额', 'sale', 'retailAmount', '预估取订单折算售价，真实取 WB 账单销售额。'],
  ['商品成本', 'cost', 'cost', '库存采购价与实际出库成本。'],
  ['国内运费及贴单', 'domestic', null, '预估取库存资料，WB 账单没有独立费用项。'],
  ['平台佣金', 'commission', 'ppvzSalesCommission', '预估取 WB 中国跨境类目费率，真实取账单。'],
  ['跨境物流费', 'delivery', 'deliveryService', '预估取下单日期对应的 WB 仓库报价。'],
  ['尾程费', 'lastMile', null, 'WB 预估计算器按售价的 2.5% 计。'],
  ['提现费', 'withdrawal', null, '按 WB 预估计算器口径。'],
  ['支付手续费', null, 'acquiringFee', '真实取账单，已计入商品应付净额。'],
  ['广告费', 'ad', null, '预估按填写比例计算。'],
  ['退货损失', 'returnLoss', null, '预估按退货率与单次损失计算，真实退货冲减体现在账单净额。'],
  ['其他预估费用', 'other', null, '预估按填写比例计算。'],
  ['仓储费', null, 'paidStorage', '取可归属此订单的账单费用。'],
  ['入仓处理费', null, 'paidAcceptance', '取 WB 账单。'],
  ['罚款', null, 'penalty', '取 WB 账单。'],
  ['其他扣款', null, 'deduction', '取 WB 账单，扣款方向待核对时留空利润。'],
  ['补偿／调整', null, 'additionalPayment', '取 WB 账单调整流水。'],
  ['转付物流费', null, 'rebillLogisticCost', '取 WB 账单调整流水。'],
  ['返现金额', null, 'cashbackAmount', '取 WB 账单。'],
  ['返现折扣', null, 'cashbackDiscount', '取 WB 账单。'],
  ['返现佣金调整', null, 'cashbackCommissionChange', '取 WB 账单。'],
  ['商品应付净额', null, 'forPay', 'WB 已计入佣金和支付费，此处展示账单口径。'],
  ['结算净额', null, 'settlement', '按已拉取账单计算。'],
  ['成本／费用合计', 'total', 'total', '真实合计为账单销售额减去利润。'],
  ['利润', 'profit', 'profit', '真实利润用账单结算净额减本地出库成本。']
];
const rows = computed(() => {
  const settlement = evidence.value?.settlement;
  const actual = { ...settlement?.amounts_cny, cost: evidence.value?.posted_inventory_cost_cny,
    settlement: settlement?.net_settlement_cny, profit: settlement?.actual_profit_cny };
  actual.total = actual.retailAmount == null || actual.profit == null ? null : actual.retailAmount - actual.profit;
  return comparison.map(([label, left, right, note]) => ({
    label, note, estimated: left ? estimate.value[left] : null, actual: right ? actual[right] : null,
    original: right && actual[right] == null
      ? (settlement?.amounts || []).filter(row => row.currency !== 'CNY' && Number(row[right]) !== 0 && row[right] != null)
        .map(row => money(row[right], row.currency)).join(' / ')
      : '',
    strong: left === 'total' || left === 'profit'
  }));
});
const inputFields = [
  ['purchaseCost', '采购成本（元）'], ['domesticCost', '国内运费及贴单（元）'],
  ['weight', '实重（g）'], ['length', '长（cm）'], ['width', '宽（cm）'], ['height', '高（cm）'],
  ['commissionRate', '佣金（%）'], ['adRate', '广告费率（%）'], ['otherRate', '其他费率（%）'],
  ['returnRate', '退货率（%）'], ['returnLoss', '单次退货损失（元）']
];

function money(value, currency = 'CNY') {
  return value == null ? '—' : `${currency} ${Number(value).toFixed(2)}`;
}

async function load() {
  const scope = currentApiCacheScope();
  loading.value = true;
  error.value = '';
  try {
    const result = await apiClient.get(`/api/wb/orders/financial-evidence?order_id=${props.row.id}`, { noCache: true });
    if (scope !== currentApiCacheScope()) return emit('close');
    evidence.value = result;
    if (!hydrated && result.estimate_inputs) {
      hydrated = true;
      const { shop_id, subject_id, ordered_at, ...packageInputs } = result.estimate_inputs;
      Object.assign(inputs, packageInputs);
      if (shop_id && subject_id) {
        void apiClient.get(`/api/wb/pricing-commissions?shop_id=${shop_id}`).then(({ rows: choices = [] }) => {
          if (scope !== currentApiCacheScope() || inputs.commissionRate != null) return;
          const category = choices.find(row => Number(row.id) === Number(subject_id));
          if (category) {
            inputs.commissionRate = category.rate;
            commissionNote.value = `WB 中国跨境类目费率 · ${category.category}`;
          }
        }).catch(() => {
          if (scope === currentApiCacheScope()) commissionNote.value = '未取得 WB 类目费率，可填入已核对的费率。';
        });
      }
    }
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
  <el-dialog :model-value="true" title="WB 订单利润明细" width="min(1120px,96vw)" @close="emit('close')">
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
          <el-descriptions-item label="预估利润">{{ money(estimate.profit) }}</el-descriptions-item>
          <el-descriptions-item label="真实利润">{{ money(evidence.settlement?.actual_profit_cny) }}</el-descriptions-item>
        </el-descriptions>
        <details class="wb-estimate-inputs">
          <summary>预估计费依据与参数</summary>
          <el-form label-position="top" class="wb-estimate-grid">
            <el-form-item label="WB 揽收仓">
              <el-select v-model="warehouseId" filterable clearable :disabled="!tariff" placeholder="选择用于测算的仓库">
                <el-option v-for="warehouse in tariff?.rows || []" :key="warehouse.id"
                  :value="warehouse.id" :label="`${warehouse.name} · ${warehouse.service}`" />
              </el-select>
            </el-form-item>
            <el-form-item v-for="[key, label] in inputFields" :key="key" :label="label">
              <el-input-number v-model="inputs[key]" :min="0" :max="label.includes('%') ? 100 : undefined" :precision="2" :controls="false"
                @change="key === 'commissionRate' && (commissionNote = '使用手工填写的 WB 佣金费率。')" />
            </el-form-item>
          </el-form>
          <p>参数仅用于当前测算。广告费、退货损失和其他费用按计算器默认值 0 起算。</p>
          <p v-if="commissionNote">{{ commissionNote }}</p>
          <p v-if="tariff">报价版本 {{ tariff.version }}<template v-if="estimate.shipping">，计费重量 {{ estimate.shipping.chargeableWeightG }} g</template></p>
          <p v-else>下单日期没有可用 WB 官方报价版本。</p>
          <p v-if="estimate.shippingError">{{ estimate.shippingError }}</p>
        </details>
        <p v-if="estimate.profit == null" class="wb-estimate-hint">补齐采购成本、国内费用、佣金和揽收仓包裹资料后，才会显示预估利润。</p>
        <el-table class="wb-settlement-rows orders-profit-detail-table" :data="rows" stripe border size="small">
          <el-table-column label="费用项目" min-width="150" fixed="left">
            <template #default="{ row: fee }"><strong v-if="fee.strong">{{ fee.label }}</strong><span v-else>{{ fee.label }}</span></template>
          </el-table-column>
          <el-table-column label="预估金额" width="138" align="right">
            <template #default="{ row: fee }">{{ money(fee.estimated) }}</template>
          </el-table-column>
          <el-table-column label="真实金额" width="138" align="right">
            <template #default="{ row: fee }">{{ fee.original || money(fee.actual) }}</template>
          </el-table-column>
          <el-table-column label="差异" width="125" align="right">
            <template #default="{ row: fee }">{{ fee.actual == null || fee.estimated == null ? '—' : money(fee.actual - fee.estimated) }}</template>
          </el-table-column>
          <el-table-column prop="note" label="说明" min-width="280" />
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
.wb-settlement-rows, .wb-estimate-inputs { margin-top: 12px; }
.wb-estimate-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px,1fr)); gap: 0 12px; margin-top: 12px; }
.wb-estimate-hint { color: var(--el-text-color-secondary); }
</style>
