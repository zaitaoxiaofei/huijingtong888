<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { apiClient } from '../../utils/api.js';
import { calculateWbQuote, wbLogisticsQuote } from '../../utils/wb-pricing.js';
import tariff from '../../../../src/data/wb/logistics-2026-11-11.json';

const props = defineProps({ mode: { type: String, required: true } });
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
const selectedRule = computed(() => tariff.rows.find(row => row.id === warehouseId.value));
const products = [...new Set(tariff.rows.map(row => row.service))];
const rules = computed(() => tariff.rows.filter(row => (!product.value || row.service === product.value)
  && `${row.name} ${row.location} ${row.service} ${row.nameEn} ${row.id === 382855 ? 'DPX' : ''}`.toLowerCase().includes(search.value.trim().toLowerCase())));
const fields = computed(() => [
  ...(props.mode === 'profit' ? [{ key: 'saleCny', label: '实际售价', unit: '元', precision: 2 }] : []),
  { key: 'purchaseCost', label: '采购成本', unit: '元/件', precision: 2 },
  { key: 'weight', label: '包裹实重', unit: '克', precision: 0 },
  ...['length', 'width', 'height'].map((key, index) => ({ key, label: ['包裹长', '包裹宽', '包裹高'][index], unit: '厘米', precision: 1 })),
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
const shipping = computed(() => { try { return { quote: wbLogisticsQuote(selectedRule.value, form) }; } catch (e) { return { error: e.message }; } });
const money = value => Number(value || 0).toFixed(2);
const details = computed(() => result.value ? [
  ['采购成本', form.purchaseCost], ['WB 平台佣金', result.value.commission],
  ['跨境物流费', result.value.shipping.freight], ['国内运费及贴单', form.domesticCost],
  ['尾程费（沿用 2.5%）', result.value.lastMile], ['提现费（沿用现有公式）', result.value.withdrawalFee],
  ['广告费', result.value.advertising], ['预期退货损失', result.value.expectedReturnLoss], ['其他费', result.value.other]
] : []);
watch([form, warehouseId], () => { result.value = null; });
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
    <el-alert :closable="false" type="info" show-icon title="WB 中国跨境 FBS：物流按实重每 100 克向上取整；广告、退货损失、其他费、尾程及提现沿用现有设置。" />
    <div class="wb-grid">
      <el-card shadow="never">
        <template #header><strong>WB 跨境{{ mode === 'pricing' ? '定价工具' : '利润计算器' }}</strong></template>
        <el-form :model="form" label-width="150px" @submit.prevent="calculate">
          <el-form-item v-for="field in fields" :key="field.key" :label="field.label" :required="!['targetMargin', 'discountRate'].includes(field.key)">
            <el-input-number v-model="form[field.key]" :controls="false" :min="0" :max="field.max" :precision="field.precision" /><span class="unit">{{ field.unit }}</span>
          </el-form-item>
          <el-form-item label="WB 类目佣金" required>
            <div class="commission-fields">
              <div v-if="shops.length" class="shop-row"><el-select v-model="shopId" placeholder="选择 WB 店铺读取官方佣金" @change="changeShop"><el-option v-for="shop in shops" :key="shop.id" :value="shop.id" :label="shop.name" /></el-select><el-button :disabled="!shopId" :loading="loading" @click="loadCommissions">读取佣金</el-button></div>
              <el-select-v2 v-if="commissions.length" v-model="categoryId" :options="commissionOptions" filterable placeholder="搜索 WB 商品类目" @change="chooseCategory" />
              <div><el-input-number v-model="form.commissionRate" :controls="false" :min="0" :max="99.99" :precision="2" @change="categoryId = null; commissionSource = '手动填写的 WB 中国跨境佣金'" /><span class="unit">%</span></div>
              <small>{{ commissionSource || '从已授权店铺读取 WB 官方中国跨境佣金，或按 WB 卖家后台确认的类目费率填写。' }}</small><small v-if="error" class="error">{{ error }}</small>
            </div>
          </el-form-item>
          <el-form-item label="物流产品"><el-select v-model="product" clearable placeholder="全部产品"><el-option v-for="item in products" :key="item" :value="item" :label="item" /></el-select></el-form-item>
          <el-form-item label="揽收仓及渠道" required><div class="commission-fields"><el-input v-model="search" placeholder="按城市、渠道或仓库编号筛选" clearable /><el-select v-model="warehouseId" filterable><el-option v-for="row in rules" :key="row.id" :value="row.id" :label="`${row.service} · ${row.id === 382855 ? 'DPX · ' : ''}${row.name}`" /></el-select><small v-if="selectedRule">已选 {{ selectedRule.service }} · {{ selectedRule.id === 382855 ? 'DPX · ' : '' }}{{ selectedRule.name }}</small></div></el-form-item>
          <el-form-item label="参考汇率" required><el-input-number v-model="form.exchangeRate" :controls="false" :min="0.0001" :precision="4" @change="rateNote = '手动汇率'" /><span class="unit">₽ / 元</span><small>{{ rateNote }}</small></el-form-item>
          <h3>其他费用</h3>
          <el-form-item v-for="field in extras" :key="field.key" :label="field.label"><el-input-number v-model="form[field.key]" :controls="false" :min="0" :max="field.max" :precision="2" /><span class="unit">{{ field.unit }}</span></el-form-item>
          <el-button type="primary" class="calculate" @click="calculate">开始计算</el-button>
        </el-form>
      </el-card>
      <div class="wb-results">
        <el-card shadow="never">
          <template #header><strong>物流报价</strong></template>
          <p v-if="shipping.quote"><b>¥ {{ money(shipping.quote.freight) }}</b> · 计费重 {{ shipping.quote.chargeableWeightG }} 克</p><p v-else class="error">{{ shipping.error }}</p>
          <p v-if="shipping.quote">{{ shipping.quote.chargeableWeightG / 1000 }} kg × ¥{{ shipping.quote.perKg }}/kg + ¥{{ shipping.quote.perTicket }}/票</p>
          <p v-if="selectedRule">{{ selectedRule.restrictions }}；限重 {{ selectedRule.maxWeightG / 1000 }} kg。</p>
          <small>WB 官方费率 · {{ tariff.version }} 生效 · {{ tariff.rows.length }} 个揽收仓／渠道</small>
          <p><a href="/reference/wb-logistics-2026-11-11.pdf" target="_blank" rel="noopener noreferrer">下载报价原表</a> · <a :href="tariff.sourceUrl" target="_blank" rel="noopener noreferrer">查看官方报价原表</a></p>
        </el-card>
        <el-card shadow="never">
          <template #header><strong>计算结果</strong></template>
          <template v-if="result"><p v-if="mode === 'pricing'">建议售价 <b>¥ {{ money(result.saleCny) }}</b> · 参考 ₽{{ money(result.saleRub) }}</p><p v-if="mode === 'pricing'">建议划线价 ¥{{ money(result.listCny) }} · 参考 ₽{{ money(result.listRub) }}</p><p>预计净利润 <b>¥ {{ money(result.profit) }}</b> · 净利率 {{ result.margin }}%</p><div v-for="[label, value] in details" :key="label" class="detail"><span>{{ label }}</span><b>¥ {{ money(value) }}</b></div></template>
          <el-empty v-else description="填写参数后计算" :image-size="80" />
        </el-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wb-calculator { margin-top: 14px; }
.wb-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(320px, 1fr); gap: 20px; margin-top: 14px; }
.wb-results { display: grid; align-content: start; gap: 18px; }
.commission-fields { display: grid; gap: 8px; width: 100%; }
.shop-row { display: flex; gap: 8px; }
.unit { margin-left: 8px; }
small { color: var(--erp-text-secondary); line-height: 1.5; }
.error { color: var(--erp-danger-text); }
.detail { display: flex; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--erp-border-light); }
.calculate { width: 100%; }
.wb-calculator :deep(.el-input-number) { width: 200px; max-width: 100%; }
.wb-calculator :deep(.el-input__inner) { text-align: left; }
@media (max-width: 850px) { .wb-grid { grid-template-columns: 1fr; } }
@media (max-width: 640px) { .wb-calculator :deep(.el-form-item) { display: block; } .wb-calculator :deep(.el-form-item__label) { width: auto !important; padding-bottom: 6px; } .wb-calculator :deep(.el-form-item__content) { margin-left: 0 !important; } }
</style>
