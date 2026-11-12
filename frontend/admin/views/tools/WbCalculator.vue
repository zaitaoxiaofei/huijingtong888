<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { apiClient } from '../../utils/api.js';
import { calculateWbQuote, wbLogisticsQuote } from '../../utils/wb-pricing.js';
import { WB_LOGISTICS_VERSIONS, currentWbTariff, wbTariffVersion } from '../../../../src/shared/wb-logistics-catalog.js';
const versionKey = ref(currentWbTariff().version);
const tariff = computed(() => wbTariffVersion(versionKey.value));
const historical = computed(() => versionKey.value !== currentWbTariff().version);

const props = defineProps({ mode: { type: String, required: true }, embedded: { type: Boolean, default: false } });
const form = reactive({ saleCny: null, purchaseCost: null, commissionRate: null, weight: null,
  length: null, width: null, height: null, exchangeRate: null, domesticCost: 0, adRate: 0,
  returnRate: 0, returnLoss: 0, otherRate: 0, targetMargin: 20, discountRate: 0 });
const warehouseId = ref(382855);
const product = ref('');
const search = ref('');
const shops = ref([]);
const shopId = ref(null);
const commissions = ref([]);
const categoryId = ref(null);
const commissionOptions = computed(() => commissions.value.map(row => ({ value: row.id, label: `${row.parent} / ${row.category}（${row.rate}%）` })));
const commissionSource = ref('');
const loading = ref(false);
const error = ref('');
const rateNote = ref('');
const result = ref(null);
const selectedRule = computed(() => tariff.value.rows.find(row => row.id === warehouseId.value));
const products = computed(() => [...new Set(tariff.value.rows.map(row => row.service))]);
const rules = computed(() => tariff.value.rows.filter(row => (!product.value || row.service === product.value)
  && `${row.name} ${row.location} ${row.service} ${row.nameEn} ${row.id === 382855 ? 'DPX' : ''}`.toLowerCase().includes(search.value.trim().toLowerCase())));
const fields = computed(() => [
  ...(props.mode === 'profit' ? [{ key: 'saleCny', label: '实际售价', unit: '元', precision: 2 }] : []),
  { key: 'purchaseCost', label: '采购成本', unit: '元/件', precision: 2 },
  ...(props.mode === 'pricing' ? [{ key: 'targetMargin', label: '目标净利率', unit: '%', precision: 1, max: 99 },
    { key: 'discountRate', label: '划线价折扣', unit: '%', precision: 1, max: 99 }] : [])
]);
const extras = [
  { key: 'domesticCost', label: '国内运费及贴单', unit: '元/件' },
  { key: 'adRate', label: '广告费占比', unit: '%', max: 100 },
  { key: 'returnRate', label: '退货率', unit: '%', max: 100 },
  { key: 'returnLoss', label: '单次退货损失', unit: '元/次' },
  { key: 'otherRate', label: '其他费占比', unit: '%', max: 100 }
];
const packageReady = computed(() => ['weight','length','width','height'].every(key => Number(form[key]) > 0));
const shipping = computed(() => { try { return { quote: wbLogisticsQuote(selectedRule.value, form) }; } catch (e) { return { error: e.message }; } });
const money = value => Number(value || 0).toFixed(2);
const details = computed(() => result.value ? [
  ['采购成本', form.purchaseCost], ['WB 平台佣金', result.value.commission],
  ['跨境物流费', result.value.shipping.freight], ['国内运费及贴单', form.domesticCost],
  ['尾程费（沿用 2.5%）', result.value.lastMile], ['提现费（沿用现有公式）', result.value.withdrawalFee],
  ['广告费', result.value.advertising], ['预期退货损失', result.value.expectedReturnLoss], ['其他费', result.value.other]
] : []);
watch([form, warehouseId, versionKey], () => { result.value = null; });
watch(versionKey, () => {
  product.value = ''; search.value = '';
  if (!tariff.value.rows.some(row => row.id === warehouseId.value)) warehouseId.value = null;
});
function chooseCategory(id) {
  const row = commissions.value.find(row => row.id === id);
  form.commissionRate = row?.rate ?? null;
  commissionSource.value = row ? `${row.parent} / ${row.category} · WB 官方中国跨境佣金` : '';
}
function changeShop() { commissions.value = []; categoryId.value = null; form.commissionRate = null; commissionSource.value = ''; error.value = ''; }
async function loadCommissions() {
  if (!shopId.value || loading.value) return;
  const requestedShop = shopId.value;
  loading.value = true; error.value = '';
  try {
    const response = await apiClient.get(`/api/wb/pricing-commissions?shop_id=${shopId.value}`, { noCache: true });
    if (shopId.value === requestedShop) commissions.value = response.rows || [];
  } catch (e) { if (shopId.value === requestedShop) error.value = e.message || 'WB 佣金读取失败，请稍后重试或按后台确认的费率手动填写'; }
  finally { loading.value = false; }
}
function calculate() {
  try { result.value = calculateWbQuote(props.mode, form, selectedRule.value); }
  catch (e) { result.value = null; ElMessage.warning(e.message); }
}
onMounted(async () => {
  const [rate, accounts] = await Promise.allSettled([
    apiClient.get('/api/tools/pricing/reference-rate', { noCache: true }),
    apiClient.get('/api/wb/shops', { noCache: true })
  ]);
  if (rate.status === 'fulfilled' && Number(rate.value?.rate) > 0) {
    form.exchangeRate = Number(rate.value.rate); rateNote.value = `俄罗斯央行 ${rate.value.source_date || ''}`;
  } else rateNote.value = '汇率获取失败，请手动填写';
  if (accounts.status === 'fulfilled') shops.value = (Array.isArray(accounts.value) ? accounts.value : []).filter(row => row.environment === 'production' && row.status === 'active');
});
</script>

<template>
  <div class="wb-calculator">
    <el-alert :closable="false" type="info" show-icon title="按 WB 官方中国跨境 FBS 报价测算，实重每 100 克向上取整。" />
    <div class="wb-grid">
      <el-card shadow="never" class="wb-form-card">
        <template v-if="!props.embedded" #header><h2>WB 跨境{{ mode === 'pricing' ? '定价工具' : '利润计算器' }}</h2></template>
        <el-form :model="form" label-width="130px" @submit.prevent="calculate">
          <h3>基础设置</h3>
          <el-form-item v-for="field in fields.filter(item => ['saleCny','purchaseCost'].includes(item.key))" :key="field.key" :label="field.label" required>
            <el-input-number v-model="form[field.key]" :controls="false" :min="0" :precision="2" /><span class="unit">{{ field.unit }}</span>
          </el-form-item>
          <el-form-item label="类目佣金" required>
            <div class="commission-fields">
              <div v-if="shops.length" class="shop-row"><el-select v-model="shopId" placeholder="选择 WB 店铺" @change="changeShop"><el-option v-for="shop in shops" :key="shop.id" :value="shop.id" :label="shop.name" /></el-select><el-button :disabled="!shopId" :loading="loading" @click="loadCommissions">读取佣金</el-button></div>
              <div class="commission-row">
                <el-select-v2 v-if="commissions.length" v-model="categoryId" :options="commissionOptions" filterable placeholder="选择 WB 商品类目" @change="chooseCategory" />
                <el-input-number v-model="form.commissionRate" :controls="false" :min="0" :max="99.99" :precision="2" @change="categoryId = null; commissionSource = '手动费率'" /><span class="unit">%</span>
              </div>
              <small>{{ commissionSource || '选择官方类目，或填写后台确认的佣金比例。' }}</small><small v-if="error" class="error">{{ error }}</small>
            </div>
          </el-form-item>
          <el-form-item label="包裹重量" required><el-input-number v-model="form.weight" :controls="false" :min="0" :precision="0" /><span class="unit">克</span><span v-if="shipping.quote" class="billing-weight">计费 {{ shipping.quote.chargeableWeightG }} g</span></el-form-item>
          <el-form-item label="包裹尺寸" required><div class="dimensions"><el-input-number v-model="form.length" :controls="false" :min="0" :precision="1" aria-label="包裹长" /><span>×</span><el-input-number v-model="form.width" :controls="false" :min="0" :precision="1" aria-label="包裹宽" /><span>×</span><el-input-number v-model="form.height" :controls="false" :min="0" :precision="1" aria-label="包裹高" /><span class="unit">厘米</span></div></el-form-item>
          <el-form-item label="物流渠道" required>
            <div class="commission-fields">
              <div class="logistics-selects"><el-select v-model="product" clearable placeholder="全部产品"><el-option v-for="item in products" :key="item" :value="item" :label="item" /></el-select><el-select v-model="warehouseId" filterable :filter-method="value => search = value" placeholder="搜索城市 / 仓库" @visible-change="search = ''"><el-option v-for="row in rules" :key="row.id" :value="row.id" :label="`${row.id === 382855 ? 'DPX · ' : ''}${row.location} · ${row.id}`"><span>{{ row.location }} · {{ row.id }}</span><small class="option-service">{{ row.service }}</small></el-option></el-select></div>
              <small v-if="selectedRule" class="channel-note" :title="selectedRule.name">{{ selectedRule.service }} · {{ selectedRule.name.match(/时效[^-]+/)?.[0] || selectedRule.location }} · 限重 {{ selectedRule.maxWeightG / 1000 }} kg</small>
            </div>
          </el-form-item>
          <el-form-item v-for="field in fields.filter(item => ['targetMargin','discountRate'].includes(item.key))" :key="field.key" :label="field.label"><el-input-number v-model="form[field.key]" :controls="false" :min="0" :max="field.max" :precision="1" /><span class="unit">%</span></el-form-item>
          <el-form-item label="参考汇率" required><div class="commission-fields"><div><el-input-number v-model="form.exchangeRate" :controls="false" :min="0.0001" :precision="4" @change="rateNote = '手动汇率'" /><span class="unit">₽ / 元</span></div><small>{{ rateNote }}</small></div></el-form-item>
          <h3>其他费用</h3>
          <el-form-item v-for="field in extras" :key="field.key" :label="field.label"><el-input-number v-model="form[field.key]" :controls="false" :min="0" :max="field.max" :precision="2" /><span class="unit">{{ field.unit }}</span></el-form-item>
          <el-button type="primary" class="calculate-button" @click="calculate">{{ mode === 'pricing' ? '计算建议售价' : '计算预计利润' }}</el-button>
        </el-form>
      </el-card>
      <div class="wb-results">
        <el-card shadow="never" class="wb-result-card">
          <template #header><strong>计算结果</strong></template>
          <div v-if="result" class="headline"><small>{{ mode === 'pricing' ? '建议售价' : '预计净利润' }}</small><strong :class="{ negative: result.profit < 0 }">¥ {{ money(mode === 'pricing' ? result.saleCny : result.profit) }}</strong><span>净利率 {{ result.margin }}%<template v-if="mode === 'pricing'"> · 预计利润 ¥ {{ money(result.profit) }}</template></span><span v-if="mode === 'pricing'" class="result-secondary">划线价 ¥ {{ money(result.listCny) }} · 售价约 ₽ {{ money(result.saleRub) }}</span></div>
          <div v-else class="pricing-empty"><span class="pricing-empty-symbol">—</span><strong>{{ mode === 'pricing' ? '填写参数后计算售价' : '填写参数后计算利润' }}</strong><p>测算结果与费用明细将在这里展示</p></div>
        </el-card>
        <el-card shadow="never" class="wb-shipping-card">
          <template #header><div class="quote-heading"><strong>物流报价</strong><span class="version-label">WB · {{ tariff.version }}</span></div></template>
          <div v-if="shipping.quote" class="freight-quote"><strong>¥ {{ money(shipping.quote.freight) }}</strong><span>计费重 {{ shipping.quote.chargeableWeightG }} g</span><small>{{ shipping.quote.chargeableWeightG / 1000 }} kg × ¥{{ shipping.quote.perKg }}/kg + ¥{{ shipping.quote.perTicket }}/票</small></div>
          <p v-else :class="packageReady ? 'error' : 'hint'">{{ packageReady ? shipping.error : '填写包裹重量和尺寸后，自动匹配物流费用。' }}</p>
          <p v-if="selectedRule" class="hint">{{ selectedRule.restrictions }}；限重 {{ selectedRule.maxWeightG / 1000 }} kg。</p>
          <details class="tariff-details"><summary>报价版本与来源 <span>{{ tariff.rows.length }} 个仓库 / 渠道</span></summary><div><el-select v-model="versionKey" aria-label="WB 报价版本"><el-option v-for="item in WB_LOGISTICS_VERSIONS" :key="item.version" :value="item.version" :label="`${item.version} 生效${item.version === currentWbTariff().version ? '（当前）' : '（历史）'}`" /></el-select><p v-if="historical" class="error">历史报价，仅用于复核测算。</p><p><a :href="tariff.downloadUrl" target="_blank" rel="noopener noreferrer">下载官方原表</a><span> · </span><a :href="tariff.sourceUrl" target="_blank" rel="noopener noreferrer">官方来源</a></p></div></details>
        </el-card>
        <el-card v-if="result" shadow="never">
          <template #header><strong>费用明细（人民币 / 件）</strong></template>
          <div v-for="[label, value] in details" :key="label" class="detail-row"><span>{{ label }}</span><b>¥ {{ money(value) }}</b></div>
          <div class="detail-row total"><span>预计净利润 / 净利率</span><b>¥ {{ money(result.profit) }} / {{ result.margin }}%</b></div>
          <p class="hint">WB 报价 {{ result.shipping.tariffVersion }} · 仓库 {{ result.shipping.warehouseId }}</p>
        </el-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wb-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(320px,1fr);gap:20px;margin-top:16px;align-items:start}
.wb-calculator h2{margin:0;font-size:17px;font-weight:650;color:var(--el-text-color-primary)}
.wb-calculator h3{border-left:4px solid var(--el-color-primary);padding-left:10px}
.wb-results{display:grid;align-content:start;gap:16px}
.wb-result-card{background:var(--erp-primary-faint,var(--el-color-primary-light-9));border-color:var(--erp-primary-border,var(--el-color-primary-light-7))}
.commission-fields{display:grid;gap:7px;width:100%;min-width:0}
.shop-row,.commission-row{display:flex;align-items:center;gap:8px;min-width:0}
.shop-row .el-select,.commission-row :deep(.el-select-v2){flex:1;min-width:0}
.commission-row :deep(.el-input-number){width:110px!important;flex:none}
.commission-row .unit{margin-left:0}
.wb-calculator :deep(.el-input-number){width:220px;max-width:100%}
.wb-calculator :deep(.el-input__inner){text-align:left;font-variant-numeric:tabular-nums}
.dimensions{display:flex;align-items:center;gap:6px;width:100%;min-width:0}
.dimensions :deep(.el-input-number){width:0;flex:1;max-width:118px;min-width:0}
.dimensions .unit{white-space:nowrap;flex:none;margin-left:0}
.logistics-selects{display:grid;grid-template-columns:140px minmax(0,1fr);gap:8px}
.unit{margin-left:8px;color:var(--el-text-color-secondary)}
small,.hint,.channel-note{color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}
.billing-weight{margin-left:12px;color:var(--el-color-primary);font-size:12px}
.error{color:var(--el-color-danger);font-size:12px;line-height:1.6}
.calculate-button{width:100%}
.quote-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}
.version-label{font-size:11px;color:var(--el-text-color-secondary);font-weight:400}
.freight-quote{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.freight-quote>strong{font-size:27px;letter-spacing:-.5px;color:var(--el-text-color-primary);font-variant-numeric:tabular-nums}
.freight-quote>span{font-size:12px;color:var(--el-text-color-secondary)}
.freight-quote>small{flex-basis:100%}
.tariff-details{border-top:1px solid var(--el-border-color-lighter);padding-top:12px;margin-top:14px;font-size:12px;color:var(--el-text-color-secondary)}
.tariff-details summary{cursor:pointer;line-height:1.7}.tariff-details summary span{float:right;font-size:11px}.tariff-details>div{padding-top:10px}.tariff-details a{color:var(--el-color-primary);text-decoration:none}.tariff-details a:hover{text-decoration:underline}
.headline{display:grid;gap:9px}.headline>strong{font-size:32px;color:var(--el-color-primary);font-variant-numeric:tabular-nums}.headline>span{font-size:12px;color:var(--el-text-color-secondary)}.headline .negative{color:var(--el-color-danger)}.headline .result-secondary{font-size:11px}
.detail-row{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--el-border-color-lighter)}.detail-row.total{color:var(--el-color-success)}
.option-service{float:right;margin-left:14px;color:var(--el-text-color-secondary)}
@media(max-width:1000px){.wb-grid{grid-template-columns:1fr}}
@media(max-width:600px){.logistics-selects{grid-template-columns:1fr}.shop-row .el-button{padding:8px}.dimensions :deep(.el-input-number){max-width:none}.tariff-details summary span{float:none;display:block}}
</style>
