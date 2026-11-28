<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { currentWbTariff } from '../../../src/shared/wb-logistics-catalog.js';
import { estimateWbOrderProfit } from '../utils/wb-order-profit.js';
import { ElMessage } from 'element-plus';
import { apiClient, currentApiCacheScope } from '../../admin/utils/api.js';
import { useAuthStore } from '../../admin/stores/auth.js';
import { hasPermission } from '../../../src/shared/permissions.js';
import { shanghaiDateDaysAgo, shanghaiDateKey, shanghaiDateText } from '../../admin/utils/shanghai-date.js';

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
  commissionRate: null, paymentRate: null, adRate: 0, otherRate: 0, returnRate: 0, returnLoss: null });
const commissionNote = ref('');
const warehouseId = ref(null);
const configuring = ref(false);
const preferencesLoaded = ref(false);
const preferenceError = ref('');
const savingPreference = ref(false);
const savedPreferences = ref({});
const configuration = reactive({ warehouseId: 382855, paymentRate: null });
const manualReturnLoss = ref(false);
const preferenceKey = computed(() => auth.user?.tenant?.id ? `wb.profit.warehouse.${auth.user.tenant.id}` : null);
const shopId = computed(() => evidence.value?.estimate_inputs?.shop_id ?? props.row.shop_id);
const scope = currentApiCacheScope();
let hydrated = false;
let disposed = false;
const active = () => !disposed && scope === currentApiCacheScope();
const tariff = computed(() => {
  const date = evidence.value?.estimate_inputs?.ordered_at;
  if (!date) return null;
  try { return currentWbTariff(date); } catch { return null; }
});
const rule = computed(() => tariff.value?.rows.find(row => row.id === warehouseId.value));
const estimate = computed(() => estimateWbOrderProfit({ ...inputs, sale: evidence.value?.revenue_cny }, rule.value));
const margin = computed(() => estimate.value.profit != null && estimate.value.sale > 0
  ? `${(estimate.value.profit / estimate.value.sale * 100).toFixed(1)}%` : '—');
const missingHint = computed(() => (estimate.value.missingInputs || []).map(field => field.label).join('、'));
const comparison = [
  ['销售额', 'sale', 'retailAmount', '预估取订单人民币售价，真实取 WB 账单销售额。'],
  ['商品成本', 'cost', 'cost', '预估取采购成本，真实取已过账出库成本。'],
  ['国内运费及贴单', 'domestic', null, '取本地商品资料，可按本次订单核对调整。'],
  ['平台佣金', 'commission', 'ppvzSalesCommission', '预估按 WB 中国跨境类目费率，真实取账单。'],
  ['跨境物流费', 'delivery', 'deliveryService', '按揽收仓、实重及尺寸匹配下单日生效报价。'],
  ['委托派送费', 'lastMile', null, '按现有 WB 测算约定：销售额 × 2.5%。'],
  ['提现费', 'withdrawal', null, '沿用 WB 计算器提现公式，计算依据见下方。'],
  ['支付手续费', 'payment', 'acquiringFee', '预估按已确认费率，账单支付费已含在商品应付净额中。'],
  ['广告费', 'ad', null, '销售额 × 广告费率，默认 0。'],
  ['预期退货损失', 'returnLoss', null, '退货率 × 单次损失；默认自动合计货值、运费、佣金及委托派送费。'],
  ['其他预估费用', 'other', null, '销售额 × 其他费率，默认 0。'],
  ['成本／费用合计', 'total', 'total', '真实合计为账单销售额减去真实利润。'],
  ['利润', 'profit', 'profit', '预估为销售额减各项成本；真实为账单结算净额减出库成本。']
];
const adjustments = [
  ['仓储费', null, 'paidStorage', '取可归属此订单的账单费用。'],
  ['入仓处理费', null, 'paidAcceptance', '取 WB 账单。'],
  ['罚款', null, 'penalty', '暂不纳入预估，出账后按实际金额核对。'],
  ['其他扣款', null, 'deduction', '取 WB 账单，扣款方向待核对时留空真实利润。'],
  ['补偿／调整', null, 'additionalPayment', '取 WB 账单调整流水。'],
  ['转付物流费', null, 'rebillLogisticCost', '取 WB 账单调整流水。'],
  ['返现金额', null, 'cashbackAmount', '取 WB 账单。'],
  ['返现折扣', null, 'cashbackDiscount', '取 WB 账单。'],
  ['返现佣金调整', null, 'cashbackCommissionChange', '取 WB 账单。'],
  ['商品应付净额', null, 'forPay', 'WB 已计入佣金和支付费，不能再次扣减。'],
  ['结算净额', null, 'settlement', '按已拉取账单计算，已包含实际退货冲减。']
];
function feeRows(definitions) {
  const settlement = evidence.value?.settlement;
  const actual = { ...settlement?.amounts_cny, cost: evidence.value?.posted_inventory_cost_cny,
    settlement: settlement?.net_settlement_cny, profit: settlement?.actual_profit_cny };
  actual.total = actual.retailAmount == null || actual.profit == null ? null : actual.retailAmount - actual.profit;
  return definitions.map(([label, left, right, note]) => ({
    label, note, estimated: left === 'payment' && !estimate.value.paymentConfigured ? null : left ? estimate.value[left] : null,
    actual: right ? actual[right] : null,
    estimatedHint: left === 'payment' && !estimate.value.paymentConfigured ? '未配置' : left ? '待补齐' : '暂不预估',
    original: right && actual[right] == null
      ? (settlement?.amounts || []).filter(row => row.currency !== 'CNY' && Number(row[right]) !== 0 && row[right] != null)
        .map(row => money(row[right], row.currency)).join(' / ')
      : '', strong: left === 'total' || left === 'profit'
  }));
}
const rows = computed(() => feeRows(comparison));
const adjustmentRows = computed(() => feeRows(adjustments));
const inputFields = [
  ['purchaseCost', '采购成本', '元'], ['domesticCost', '国内运费及贴单', '元'], ['commissionRate', '佣金费率', '%'],
  ['weight', '包裹实重', 'g'], ['length', '长', 'cm'], ['width', '宽', 'cm'], ['height', '高', 'cm']
];
const optionalFields = [['adRate', '广告费率'], ['returnRate', '退货率'], ['otherRate', '其他费率']];

function money(value, currency = 'CNY') {
  return value == null ? '—' : `${currency === 'CNY' ? '¥' : currency} ${Number(value).toFixed(2)}`;
}
function warehouseLabel(warehouse) {
  return `${warehouse.id === 382855 ? '合肥 · DPX' : warehouse.location} · ${warehouse.id} · ${warehouse.service}`;
}
function openConfiguration() {
  configuration.warehouseId = warehouseId.value ?? 382855;
  configuration.paymentRate = inputs.paymentRate;
  configuring.value = true;
}
async function loadPreferences() {
  preferenceError.value = '';
  if (!preferenceKey.value) {
    preferenceError.value = '无法确认当前企业，请重新进入企业后配置仓库。';
    return;
  }
  try {
    const result = await apiClient.get(`/api/user-preferences?key=${preferenceKey.value}`, { noCache: true });
    if (!active()) return;
    savedPreferences.value = result?.value && typeof result.value === 'object' ? result.value : {};
    const selectedId = Number(savedPreferences.value.warehouseId);
    warehouseId.value = selectedId > 0 ? selectedId : null;
    const rate = savedPreferences.value.paymentRates?.[String(shopId.value)];
    inputs.paymentRate = rate != null && Number.isFinite(Number(rate)) && Number(rate) >= 0 && Number(rate) <= 100 ? Number(rate) : null;
    preferencesLoaded.value = true;
  } catch (failure) {
    if (active()) preferenceError.value = failure.message || '仓库配置读取失败，请重试。';
  }
}
async function saveConfiguration() {
  if (!active() || savingPreference.value || !preferencesLoaded.value || !preferenceKey.value) return;
  const selected = tariff.value?.rows.find(row => row.id === configuration.warehouseId);
  if (!selected) return ElMessage.warning('请选择此订单报价版本中可用的 WB 揽收仓。');
  const paymentRates = { ...savedPreferences.value.paymentRates };
  if (configuration.paymentRate == null) delete paymentRates[String(shopId.value)];
  else paymentRates[String(shopId.value)] = configuration.paymentRate;
  const value = { ...savedPreferences.value, warehouseId: selected.id, paymentRates };
  savingPreference.value = true;
  try {
    await apiClient.post('/api/user-preferences', { key: preferenceKey.value, value });
    if (!active()) return;
    savedPreferences.value = value;
    warehouseId.value = selected.id;
    inputs.paymentRate = configuration.paymentRate;
    configuring.value = false;
    ElMessage.success('已保存仓库与费用配置，后续 WB 订单自动使用。');
  } catch (failure) {
    if (active()) ElMessage.error(failure.message || '保存失败，请重试。');
  } finally { savingPreference.value = false; }
}
function toggleReturnOverride(enabled) {
  inputs.returnLoss = enabled ? estimate.value.autoReturnLoss : null;
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const result = await apiClient.get(`/api/wb/orders/financial-evidence?order_id=${props.row.id}`, { noCache: true });
    if (!active()) return emit('close');
    evidence.value = result;
    if (!hydrated && result.estimate_inputs) {
      hydrated = true;
      const { shop_id, subject_id, ordered_at, ...packageInputs } = result.estimate_inputs;
      Object.assign(inputs, packageInputs);
      await loadPreferences();
      if (shop_id && subject_id) {
        void apiClient.get(`/api/wb/pricing-commissions?shop_id=${shop_id}`).then(({ rows: choices = [] }) => {
          if (!active() || inputs.commissionRate != null) return;
          const category = choices.find(row => Number(row.id) === Number(subject_id));
          if (category) {
            inputs.commissionRate = category.rate;
            commissionNote.value = `WB 中国跨境类目 · ${category.category}`;
          }
        }).catch(() => {
          if (active()) commissionNote.value = '未取得类目费率，请按 WB 卖家后台填写佣金。';
        });
      }
    }
  } catch (failure) {
    if (!active()) return emit('close');
    error.value = failure.message || 'WB 订单金额明细加载失败';
  } finally { loading.value = false; }
}
async function sync() {
  if (!canSync.value || syncing.value || !dateRange.value?.[0] || !dateRange.value?.[1]) return;
  syncing.value = true;
  try {
    const result = await apiClient.post('/api/wb/orders/sync-settlement', {
      order_id: props.row.id, date_from: dateRange.value[0], date_to: dateRange.value[1], cursor: cursor.value
    });
    if (!active()) return emit('close');
    cursor.value = result.next_cursor;
    if (!result.fetched) ElMessage.info('所选日期范围没有更多 WB 账单流水。');
    else ElMessage.success(`已读取店铺账单 ${result.fetched} 行，请按平台频率限制继续拉取下一页。`);
    await load();
  } catch (failure) {
    if (active()) ElMessage.error(failure.message);
  } finally { syncing.value = false; }
}
watch(() => [auth.user?.id, auth.user?.tenant?.id], () => { if (!active()) emit('close'); });
onBeforeUnmount(() => { disposed = true; });
onMounted(load);
</script>

<template>
  <el-dialog :model-value="true" title="WB 订单利润明细" width="min(1160px,96vw)" top="4vh" class="wb-profit-dialog" @close="emit('close')">
    <div v-loading="loading" class="wb-profit-body">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <template v-if="evidence">
        <div class="wb-order-heading"><div><span class="wb-muted">订单</span><strong>{{ row.posting_number }}</strong><span v-if="row.shop_name" class="wb-muted">{{ row.shop_name }}</span></div><el-tag :type="evidence.settlement?.state === 'reported' ? 'success' : 'info'" effect="plain">{{ statusText[evidence.settlement?.state] || '账单状态待核对' }}</el-tag></div>
        <div class="wb-profit-summary">
          <div class="wb-summary-card wb-summary-estimate"><span class="wb-summary-label">预估利润 <small v-if="estimate.provisional">· 待补支付费率</small></span><strong class="wb-profit-value" :class="{ negative: estimate.profit < 0 }">{{ money(estimate.profit) }}</strong><span class="wb-summary-note">{{ estimate.profit == null ? '补齐计费资料后自动计算' : `预估利润率 ${margin}` }}</span></div>
          <div class="wb-summary-card"><span class="wb-summary-label">真实利润</span><strong class="wb-profit-value" :class="{ negative: evidence.settlement?.actual_profit_cny < 0 }">{{ money(evidence.settlement?.actual_profit_cny) }}</strong><span class="wb-summary-note">{{ evidence.settlement?.actual_profit_cny == null ? '等待正式账单及实际出库成本' : '按正式账单与实际出库核算' }}</span></div>
          <div class="wb-summary-card wb-summary-sale"><span class="wb-summary-label">订单销售额</span><strong class="wb-profit-value">{{ money(estimate.sale) }}</strong><span class="wb-summary-note">人民币 · 本次订单</span></div>
        </div>
        <section class="wb-section">
          <div class="wb-section-heading"><div><h3>揽收仓与自动运费</h3><p>仓库保存一次，后续 WB 订单沿用；实重和尺寸自动匹配报价。</p></div><el-button :disabled="!preferencesLoaded || !tariff" @click="openConfiguration">{{ warehouseId ? '修改仓库与费率' : '配置仓库' }}</el-button></div>
          <div v-if="preferenceError" class="wb-notice wb-notice-warning">{{ preferenceError }}<el-button link type="primary" @click="loadPreferences">重试读取</el-button></div>
          <div v-if="!warehouseId && !configuring" class="wb-notice">首次使用请配置所在地的 WB 揽收仓，推荐合肥 DPX 仓。</div>
          <div v-else-if="warehouseId && !rule" class="wb-notice wb-notice-warning">已保存仓库 {{ warehouseId }} 不在此订单的报价版本中，请重新选择；不会自动改用其他仓库。</div>
          <el-form v-if="configuring" label-position="top" class="wb-configuration" @submit.prevent="saveConfiguration">
            <el-form-item label="WB 默认揽收仓"><el-select v-model="configuration.warehouseId" aria-label="WB 默认揽收仓" filterable placeholder="选择所在地的揽收仓"><el-option v-for="warehouse in tariff?.rows || []" :key="warehouse.id" :value="warehouse.id" :label="warehouseLabel(warehouse)" /></el-select></el-form-item>
            <el-form-item label="本店支付手续费率（%）"><el-input-number v-model="configuration.paymentRate" aria-label="支付手续费率" :min="0" :max="100" :precision="2" :controls="false" placeholder="按已确认费率填写" /><small>按店铺保存；留空表示未配置，确认免收可填 0。</small></el-form-item>
            <div class="wb-configuration-actions"><el-button type="primary" :loading="savingPreference" @click="saveConfiguration">保存并使用</el-button><el-button @click="configuring = false">取消</el-button></div><p>仓库仅用于当前企业下你的 WB 订单预估，不修改 WB 平台仓库或历史利润。</p>
          </el-form>
          <div v-if="rule" class="wb-freight-preview"><div><strong>{{ rule.id === 382855 ? '合肥 · DPX' : rule.location }}</strong><span>{{ rule.service }} · {{ rule.id }}</span></div><div v-if="estimate.shipping" class="wb-freight-result"><strong>{{ money(estimate.delivery) }}</strong><span>计费 {{ estimate.shipping.chargeableWeightG }} g · {{ estimate.shipping.chargeableWeightG / 1000 }} kg × ¥{{ estimate.shipping.perKg }}/kg + ¥{{ estimate.shipping.perTicket }}/票</span></div><span v-else class="wb-muted">填写实重和尺寸后自动报价</span></div>
          <p v-if="estimate.shippingError" class="wb-notice wb-notice-warning">{{ estimate.shippingError }}</p><p v-if="!tariff" class="wb-notice wb-notice-warning">下单日期没有已登记的 WB 报价，请核对订单日期。</p>
        </section>
        <section class="wb-section">
          <div class="wb-section-heading"><div><h3>成本与包裹参数</h3><p>已带入商品资料，调整后即时更新本次测算。</p></div><span v-if="tariff" class="wb-muted">报价 {{ tariff.version }}</span></div>
          <el-form label-position="top" class="wb-estimate-grid"><el-form-item v-for="[key, label, unit] in inputFields" :key="key" :label="`${label}（${unit}）`"><el-input-number v-model="inputs[key]" :aria-label="label" :min="0" :max="unit === '%' ? 100 : undefined" :precision="key === 'weight' ? 0 : 2" :controls="false" @change="key === 'commissionRate' && (commissionNote = '使用手工填写的 WB 佣金费率。')" /></el-form-item></el-form>
          <div class="wb-parameter-notes"><span v-if="commissionNote">{{ commissionNote }}</span><span>支付手续费率：{{ inputs.paymentRate == null ? '未配置' : `${inputs.paymentRate}%` }}<el-button link type="primary" :disabled="!preferencesLoaded || !tariff" @click="openConfiguration">设置</el-button></span></div>
          <details class="wb-optional-inputs"><summary>广告、退货与其他费用<span>默认费率 0 · 单次退货损失自动计算</span></summary><el-form label-position="top" class="wb-optional-grid"><el-form-item v-for="[key, label] in optionalFields" :key="key" :label="`${label}（%）`"><el-input-number v-model="inputs[key]" :aria-label="label" :min="0" :max="100" :precision="2" :controls="false" /></el-form-item><el-form-item label="单次退货损失（元）"><strong v-if="!manualReturnLoss" class="wb-return-value">{{ money(estimate.singleReturnLoss) }}</strong><el-input-number v-else v-model="inputs.returnLoss" aria-label="单次退货损失" :min="0" :precision="2" :controls="false" /></el-form-item></el-form><div class="wb-return-explanation"><span>自动合计：货值 + 国内运费及贴单 + 跨境物流费 + 佣金 + 委托派送费。</span><el-checkbox v-model="manualReturnLoss" @change="toggleReturnOverride">手动填写单次退货损失</el-checkbox></div><p class="wb-muted">预期退货损失 = 退货率 × 单次损失。广告、退货与其他参数仅用于本次测算。</p></details>
        </section>
        <div v-if="estimate.profit == null" class="wb-notice wb-notice-warning wb-estimate-hint">请补齐{{ missingHint || '计费参数' }}。{{ estimate.inputErrors?.map(field => `${field.label}需填写有效数值`).join('；') }}</div>
        <div v-if="estimate.provisional" class="wb-notice wb-notice-warning">支付手续费率未配置，暂未计入预估利润。请在“修改仓库与费率”中填写已确认费率。</div>
        <section class="wb-section wb-fees-section">
          <div class="wb-section-heading"><div><h3>费用与利润对比</h3><p>金额均为人民币；真实金额以已拉取的 WB 正式账单为准。</p></div><span class="wb-muted">差异 = 真实 − 预估</span></div>
          <el-table class="wb-settlement-rows orders-profit-detail-table" :data="rows" :row-class-name="({ row: fee }) => fee.strong ? 'wb-total-row' : ''" size="small">
            <el-table-column label="费用项目" min-width="145" fixed="left"><template #default="{ row: fee }"><strong v-if="fee.strong">{{ fee.label }}</strong><span v-else>{{ fee.label }}</span></template></el-table-column>
            <el-table-column label="预估金额" width="130" align="right"><template #default="{ row: fee }"><span :class="{ 'wb-muted': fee.estimated == null }">{{ fee.estimated == null ? fee.estimatedHint : money(fee.estimated) }}</span></template></el-table-column>
            <el-table-column label="真实金额" width="130" align="right"><template #default="{ row: fee }"><span :class="{ 'wb-muted': fee.actual == null }">{{ fee.original || (fee.actual == null ? '待核对' : money(fee.actual)) }}</span></template></el-table-column>
            <el-table-column label="差异" width="115" align="right"><template #default="{ row: fee }">{{ fee.actual == null || fee.estimated == null ? '—' : money(fee.actual - fee.estimated) }}</template></el-table-column><el-table-column prop="note" label="说明" min-width="285" />
          </el-table>
          <details class="wb-appendix"><summary>其他账单项目<span>仓储、罚款、补偿及结算净额</span></summary><el-table :data="adjustmentRows" size="small"><el-table-column prop="label" label="费用项目" min-width="145" /><el-table-column label="真实金额" width="145" align="right"><template #default="{ row: fee }">{{ fee.original || money(fee.actual) }}</template></el-table-column><el-table-column prop="note" label="说明" min-width="280" /></el-table></details>
        </section>
        <section v-if="canSync" class="wb-section wb-settlement-controls"><div><h3>正式账单核对</h3><p>按北京时间选择账单日期，拉取后更新真实费用与利润。</p></div><div class="wb-settlement-actions"><el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD" start-placeholder="账单开始日" end-placeholder="账单结束日" :disabled="syncing" @change="cursor = null" /><el-button type="primary" plain :loading="syncing" :disabled="!dateRange?.length" @click="sync">{{ cursor ? '继续拉取下一页' : '拉取 WB 正式账单' }}</el-button></div></section>
        <el-collapse v-if="evidence.settlement?.lines?.length" class="wb-ledger-collapse"><el-collapse-item title="WB 原始账单流水"><el-table :data="evidence.settlement.lines" size="small" max-height="330"><el-table-column prop="report_id" label="报表编号" min-width="140" /><el-table-column prop="row_id" label="流水编号" min-width="140" /><el-table-column label="账单日期" min-width="105"><template #default="{ row: line }">{{ shanghaiDateText(line.date) }}</template></el-table-column><el-table-column prop="operation" label="WB 记账事项" min-width="160" /><el-table-column label="商品应付净额" min-width="140" align="right"><template #default="{ row: line }">{{ money(line.forPay, line.currency) }}</template></el-table-column><el-table-column prop="fx_rate" label="人民币兑卢布汇率" min-width="135" /></el-table></el-collapse-item></el-collapse>
        <details class="wb-appendix wb-calculation-source"><summary>计算依据与报价来源</summary><p>预估仅用于本次订单测算，不覆盖已保存的历史利润。罚款等未确认费用暂不预估，真实退货以账单冲减核算。</p><p>委托派送费 = 销售额 × 2.5%。提现费沿用现有约定：max(0, 销售额 − 跨境物流费 − 委托派送费 − 销售额 × 20%) × 1.2%。这些为测算约定，请以实际合同及账单核对。</p><p v-if="tariff">下单日生效报价 {{ tariff.version }} · <a :href="tariff.downloadUrl" target="_blank" rel="noopener noreferrer">查看官方报价原表</a></p><p v-if="estimate.modelVersion">预估模型 {{ estimate.modelVersion }}</p></details>
      </template>
    </div>
  </el-dialog>
</template>

<style scoped>
.wb-profit-body { color: var(--el-text-color-primary); font-size: 13px; line-height: 1.6; }
.wb-order-heading, .wb-order-heading > div, .wb-section-heading, .wb-freight-preview, .wb-return-explanation { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.wb-order-heading { margin-bottom: 18px; flex-wrap: wrap; }
.wb-order-heading > div { justify-content: flex-start; flex-wrap: wrap; gap: 10px; }
.wb-order-heading strong { font-size: 15px; }
.wb-muted, .wb-summary-note { color: var(--el-text-color-secondary); }
.wb-profit-summary { display: grid; grid-template-columns: 1.15fr 1.15fr 1fr; gap: 14px; margin-bottom: 20px; }
.wb-summary-card { display: flex; flex-direction: column; gap: 5px; padding: 19px 22px; border: 1px solid var(--el-border-color-light); border-radius: 12px; background: var(--el-fill-color-extra-light); }
.wb-summary-estimate { background: var(--el-color-primary-light-9); border-color: var(--el-color-primary-light-7); }
.wb-summary-label { font-weight: 600; color: var(--el-text-color-regular); }
.wb-summary-label small { font-size: 11px; font-weight: 400; }
.wb-profit-value { color: var(--el-text-color-primary); font-size: 28px; font-variant-numeric: tabular-nums; line-height: 1.5; letter-spacing: -.6px; }
.wb-summary-estimate .wb-profit-value { color: var(--el-color-primary); }
.wb-profit-value.negative { color: var(--el-color-danger); }
.wb-summary-note { font-size: 12px; }
.wb-section { margin-top: 16px; padding: 18px 20px; border: 1px solid var(--el-border-color-light); border-radius: 10px; background: var(--el-bg-color); }
.wb-section-heading { margin-bottom: 14px; flex-wrap: wrap; }
.wb-section h3 { margin: 0; font-size: 14px; font-weight: 600; }
.wb-section-heading p, .wb-section > div > p { margin: 4px 0 0; color: var(--el-text-color-secondary); font-size: 12px; }
.wb-configuration { display: grid; grid-template-columns: minmax(250px, 2fr) minmax(180px, 1fr) auto; align-items: start; gap: 0 16px; padding: 16px; margin: 12px 0; background: var(--el-fill-color-extra-light); border-radius: 8px; }
.wb-configuration :deep(.el-select), .wb-configuration :deep(.el-input-number), .wb-estimate-grid :deep(.el-input-number), .wb-optional-grid :deep(.el-input-number) { width: 100%; }
.wb-configuration :deep(.el-form-item__content) { display: block; }
.wb-configuration small { display: block; margin-top: 5px; color: var(--el-text-color-secondary); font-size: 11px; line-height: 1.5; }
.wb-configuration-actions { display: flex; margin-top: 30px; }
.wb-configuration > p { grid-column: 1 / -1; margin: 0; color: var(--el-text-color-secondary); font-size: 12px; }
.wb-freight-preview { padding: 13px 16px; background: var(--el-fill-color-extra-light); border-radius: 8px; }
.wb-freight-preview > div { display: flex; flex-direction: column; gap: 3px; }
.wb-freight-preview strong { font-size: 14px; }
.wb-freight-preview span { color: var(--el-text-color-secondary); font-size: 12px; }
.wb-freight-result { align-items: flex-end; text-align: right; }
.wb-freight-result strong { font-size: 20px; color: var(--el-color-primary); }
.wb-estimate-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 0 12px; }
.wb-estimate-grid :deep(.el-form-item), .wb-optional-grid :deep(.el-form-item) { margin-bottom: 8px; }
.wb-estimate-grid :deep(.el-form-item__label), .wb-optional-grid :deep(.el-form-item__label) { font-size: 12px; }
.wb-parameter-notes { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; color: var(--el-text-color-secondary); font-size: 12px; }
.wb-parameter-notes .el-button { margin-left: 8px; }
.wb-optional-inputs { border-top: 1px solid var(--el-border-color-lighter); margin-top: 14px; padding-top: 12px; }
summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; cursor: pointer; color: var(--el-text-color-regular); font-weight: 500; list-style: none; }
summary::before { content: '›'; display: inline-block; font-size: 17px; line-height: 1; }
details[open] > summary::before { transform: rotate(90deg); }
summary span { color: var(--el-text-color-secondary); font-size: 12px; font-weight: 400; }
.wb-optional-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
.wb-return-value { font-variant-numeric: tabular-nums; line-height: 32px; }
.wb-return-explanation { flex-wrap: wrap; gap: 6px; font-size: 12px; color: var(--el-text-color-secondary); }
.wb-optional-inputs > p { margin: 6px 0 0; font-size: 12px; }
.wb-notice { padding: 10px 14px; border-radius: 7px; background: var(--el-fill-color-light); color: var(--el-text-color-secondary); font-size: 12px; }
.wb-notice-warning { color: var(--el-color-warning); background: var(--el-color-warning-light-9); }
.wb-profit-body > .wb-notice { margin-top: 12px; }
.wb-notice .el-button { margin-left: 8px; }
.wb-fees-section { padding: 18px 0 0; overflow: hidden; }
.wb-fees-section > .wb-section-heading { padding: 0 20px; }
.wb-settlement-rows { font-variant-numeric: tabular-nums; --el-table-header-bg-color: var(--el-fill-color-light); }
.wb-settlement-rows :deep(.el-table__cell) { padding: 10px 0; }
.wb-settlement-rows :deep(.cell) { padding: 0 16px; }
.wb-settlement-rows :deep(.wb-total-row) { --el-table-tr-bg-color: var(--el-fill-color-extra-light); font-weight: 600; }
.wb-settlement-rows :deep(td:last-child .cell) { color: var(--el-text-color-secondary); font-size: 12px; }
.wb-appendix { padding: 14px 20px; }
.wb-appendix .el-table { margin-top: 12px; }
.wb-appendix p { font-size: 12px; color: var(--el-text-color-secondary); }
.wb-settlement-controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px; }
.wb-settlement-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.wb-settlement-actions :deep(.el-date-editor) { width: 270px; flex-grow: 0; }
.wb-ledger-collapse { margin-top: 14px; }
.wb-calculation-source { margin-top: 8px; }
.wb-calculation-source a { color: var(--el-color-primary); }
@media (max-width: 1000px) {
  .wb-estimate-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .wb-configuration { grid-template-columns: minmax(230px, 2fr) minmax(180px, 1fr); }
  .wb-configuration-actions { grid-column: 1 / -1; margin: 0 0 12px; }
}
@media (max-width: 600px) {
  .wb-profit-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .wb-summary-card { padding: 14px; }
  .wb-summary-sale { grid-column: 1 / -1; flex-direction: row; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  .wb-profit-value { font-size: 23px; }
  .wb-summary-sale .wb-profit-value { font-size: 19px; }
  .wb-summary-note { font-size: 11px; }
  .wb-section { padding: 14px 12px; }
  .wb-section-heading { align-items: flex-start; gap: 10px; }
  .wb-configuration { grid-template-columns: 1fr; padding: 12px; }
  .wb-estimate-grid, .wb-optional-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wb-freight-preview { align-items: flex-start; flex-direction: column; gap: 10px; }
  .wb-freight-result { align-items: flex-start; text-align: left; }
  .wb-fees-section { padding: 14px 0 0; }
  .wb-fees-section > .wb-section-heading, .wb-appendix { padding-left: 12px; padding-right: 12px; }
  .wb-settlement-actions { width: 100%; }
  .wb-settlement-actions :deep(.el-date-editor) { width: 100%; max-width: 100%; }
}
</style>
