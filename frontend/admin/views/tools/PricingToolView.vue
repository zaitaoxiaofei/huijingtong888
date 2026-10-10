<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { calculatePricing } from "../../utils/pricing-tool.js";
import { channelLabel, threeChannelQuotes, defaultLogisticsQuote } from "../../utils/logistics-quote.js";
import { pricingLogisticsCandidates } from "../../utils/pricing-logistics-candidates.js";
import { apiClient } from "../../utils/api.js";
import { commissionBandLabel } from "../../utils/rfbs-commission.js";
import RfbsCommissionPicker from "./RfbsCommissionPicker.vue";

const form = reactive({
  category: "", purchaseCost: null, weight: null, length: null, width: null, height: null, carrier: "GUOO",
  commissionRate: null, freight: null, exchangeRate: null, domesticCost: 0,
  adRate: 0, otherRate: 0, returnRate: 0, returnLoss: 0, targetMargin: 20, discountRate: 0
});
const result = ref(null);
const logisticsRules = ref([]);
const logisticsError = ref("");
const rateError = ref("");
const rateSourceDate = ref("");
const selection = ref(null);
const categoryDetail = computed(() => selection.value?.category || null);
const selectedQuoteKey = ref("");
const quoteKey = (quote) => `${quote.id}:${quote.band}`;
function selectCategory(value) {
  selection.value = value;
  form.category = String(value.category.id);
  form.commissionRate = value.category.rates[value.band];
  result.value = null;
  selectedQuoteKey.value = "";
}
const candidates = computed(() => pricingLogisticsCandidates(logisticsRules.value, form, categoryDetail.value?.rates));
const displayCandidates = computed(() => threeChannelQuotes(candidates.value, selection.value?.band ?? null));
const defaultQuote = computed(() => defaultLogisticsQuote(displayCandidates.value));
const quoteReady = computed(() => categoryDetail.value && Number(form.purchaseCost) > 0 && Number(form.weight) > 0
  && Number(form.exchangeRate) > 0 && [form.length, form.width, form.height].every((value) => Number(value) > 0));
const activeQuote = computed(() => candidates.value.find((quote) => quoteKey(quote) === selectedQuoteKey.value) || defaultQuote.value);
onMounted(async () => {
  const [rulesResult, rateResult] = await Promise.allSettled([
    apiClient.get("/api/tools/pricing/logistics-rules", { noCache: true }),
    apiClient.get("/api/tools/pricing/reference-rate", { noCache: true })
  ]);
  if (rulesResult.status === "fulfilled") logisticsRules.value = Array.isArray(rulesResult.value) ? rulesResult.value : [];
  else logisticsError.value = "物流规则加载失败，请刷新后重试";
  if (rateResult.status === "fulfilled" && Number(rateResult.value?.rate) > 0) {
    form.exchangeRate = Number(rateResult.value.rate);
    rateSourceDate.value = String(rateResult.value.source_date || "");
  } else rateError.value = "俄罗斯央行汇率获取失败，暂不能计算，请稍后刷新";
});
function selectQuote(quote) {
  selectedQuoteKey.value = quoteKey(quote);
  form.freight = quote.priceCny;
  form.commissionRate = quote.commissionRate;
  selection.value = { ...selection.value, band: quote.band };
  result.value = null;
}
function calculate() {
  if (!selection.value) {
    ElMessage.warning("请从 rFBS 佣金表选择商品类目");
    return;
  }
  if (activeQuote.value) selectQuote(activeQuote.value);
  else { ElMessage.warning("三档佣金与当前成本、重量和尺寸未找到有效物流报价，请调整参数或切换服务商"); return; }
  try {
    result.value = calculatePricing(form);
  } catch (error) {
    result.value = null;
    ElMessage.warning(error.message);
  }
}
const money = (value) => Number(value || 0).toFixed(2);
</script>

<template>
  <div class="pricing-page">
    <el-alert type="info" :closable="false" show-icon title="物流按售价、重量和尺寸匹配本地最新规则；佣金按 Ozon 中国 rFBS 费率表计算。" />
    <div class="pricing-grid">
      <el-card shadow="never" class="pricing-form">
        <template #header><h2>OZON 跨境定价工具</h2></template>
        <el-form :model="form" label-width="150px" label-position="right">
          <h3>基础设置</h3>
          <el-form-item label="类目佣金" required><div class="category-field"><RfbsCommissionPicker :selection="selection" :price-rub="result?.saleRub || activeQuote?.saleRub || 0" @select="selectCategory" /><small v-if="selection">rFBS {{ selection.version }} · {{ selection.sourceFile }}</small><small v-if="activeQuote && selection?.band !== activeQuote.band" class="tier-note">按当前成本和目标利润，预估售价约 ₽{{ money(activeQuote.saleRub) }}；将自动使用 {{ commissionBandLabel(activeQuote.band) }} 档（{{ activeQuote.commissionRate }}%）。</small><small v-else-if="quoteReady && !candidates.length && !logisticsError" class="rate-error">三档佣金均未匹配到有效物流报价，请检查重量、尺寸或切换服务商。</small></div></el-form-item>
          <el-form-item label="采购成本" required><el-input-number :controls="false" v-model="form.purchaseCost" :min="0" :precision="2" /> <span class="unit">元/件</span></el-form-item>
          <el-form-item label="包裹重量" required><el-input-number :controls="false" v-model="form.weight" :min="0" :precision="0" /> <span class="unit">克</span></el-form-item>
          <el-form-item label="包裹尺寸" required>
            <div class="dimensions"><el-input-number :controls="false" v-model="form.length" :min="0" :precision="1" /><span>×</span><el-input-number :controls="false" v-model="form.width" :min="0" :precision="1" /><span>×</span><el-input-number :controls="false" v-model="form.height" :min="0" :precision="1" /><span>厘米</span></div>
          </el-form-item>
          <el-form-item label="物流服务商"><el-select v-model="form.carrier" @change="selectedQuoteKey = ''"><el-option label="GUOO" value="GUOO" /><el-option label="CEL" value="CEL" /></el-select></el-form-item>
          <el-form-item label="目标净利率"><el-input-number :controls="false" v-model="form.targetMargin" :min="0" :max="99" :precision="1" /> <span class="unit">%</span></el-form-item>
          <el-form-item label="划线价折扣"><el-input-number :controls="false" v-model="form.discountRate" :min="0" :max="99" :precision="1" /> <span class="unit">%，0 表示不设置</span></el-form-item>
          <p class="exchange-note">参考汇率：1 元 ≈ {{ form.exchangeRate || '获取中' }} ₽ · 俄罗斯央行 {{ rateSourceDate }} <span v-if="rateError" class="rate-error">{{ rateError }}</span></p>
          <h3>其他费用</h3>
          <el-form-item label="国内运费及贴单"><el-input-number :controls="false" v-model="form.domesticCost" :min="0" :precision="2" /> <span class="unit">元/件</span></el-form-item>
          <el-form-item label="广告费占比"><el-input-number :controls="false" v-model="form.adRate" :min="0" :max="99" :precision="1" /> <span class="unit">%</span></el-form-item>
          <el-form-item label="退货率"><el-input-number :controls="false" v-model="form.returnRate" :min="0" :max="100" :precision="1" /> <span class="unit">% 的订单预计退货</span></el-form-item>
          <el-form-item label="单次退货损失"><el-input-number :controls="false" v-model="form.returnLoss" :min="0" :precision="2" /> <span class="unit">元；填退回运费、货损及不可退费用合计</span></el-form-item>
          <el-form-item label="其他费占比"><el-input-number :controls="false" v-model="form.otherRate" :min="0" :max="99" :precision="1" /> <span class="unit">%，提现与尾程已自动计入，避免重复计算</span></el-form-item>
          <el-button type="primary" class="calculate-button" @click="calculate">开始计算</el-button>
        </el-form>
      </el-card>
      <div class="pricing-results">
        <el-card shadow="never">
          <template #header><strong>计算结果</strong></template>
          <div v-if="result" class="price-pair"><div><small>建议售价</small><strong>₽ {{ money(result.saleRub) }}</strong><span>≈ ¥ {{ money(result.saleCny) }}</span></div><div><small>划线价</small><strong>₽ {{ money(result.listRub) }}</strong><span>按填写的折扣倒推</span></div></div>
          <el-empty v-else description="填写参数后计算售价" :image-size="80" />
        </el-card>
        <el-card shadow="never" class="shipping-panel">
          <template #header><strong>物流费用</strong></template>
          <p v-if="logisticsError" class="rate-error">{{ logisticsError }}</p>
          <p v-else-if="!candidates.length" class="hint">{{ quoteReady ? '当前成本、重量、尺寸与三档佣金均无有效物流报价；可调整目标利润或切换服务商。' : '选好类目并填写成本、重量和尺寸后显示有效渠道。' }}</p>
          <template v-else><p class="shipping-tip">已匹配 {{ form.carrier }} 当前有效物流方案；默认陆空 Standard，佣金按预估售价自动校正。</p><div class="shipping-cards"><button v-for="quote in displayCandidates" :key="quoteKey(quote)" type="button" class="shipping-card" :class="{ active: (selectedQuoteKey || (defaultQuote && quoteKey(defaultQuote))) === quoteKey(quote) }" :title="quote.source" @click="selectQuote(quote)"><strong>{{ channelLabel(quote.channel) }} <small>{{ quote.channel }}</small></strong><b>¥ {{ money(quote.priceCny) }}</b><small>{{ quote.name }}</small><small>计费重 {{ quote.chargeableWeightG }}g · ₽{{ money(quote.saleRub) }} · 佣金 {{ quote.commissionRate }}%</small></button></div></template>
        </el-card>
        <el-card v-if="result" shadow="never">
          <template #header><strong>费用明细（人民币 / 件）</strong></template>
          <div class="detail-row"><span>采购成本</span><b>¥ {{ money(form.purchaseCost) }}</b></div>
          <div class="detail-row"><span>平台佣金</span><b>¥ {{ money(result.commission) }}</b></div>
          <div class="detail-row"><span>跨境物流费</span><b>¥ {{ money(form.freight) }}</b></div>
          <div class="detail-row"><span>国内运费及贴单</span><b>¥ {{ money(form.domesticCost) }}</b></div>
          <div class="detail-row"><span>尾程费（售价 2.5%）</span><b>¥ {{ money(result.lastMile) }}</b></div>
          <div class="detail-row"><span>提现费（系统现有公式）</span><b>¥ {{ money(result.withdrawalFee) }}</b></div>
          <div class="detail-row"><span>广告费</span><b>¥ {{ money(result.advertising) }}</b></div>
          <div class="detail-row"><span>预期退货损失（{{ form.returnRate }}% × ¥{{ money(form.returnLoss) }}）</span><b>¥ {{ money(result.expectedReturnLoss) }}</b></div>
          <div class="detail-row"><span>其他费</span><b>¥ {{ money(result.other) }}</b></div>
          <div class="detail-row profit"><span>预计净利润 / 净利率</span><b>¥ {{ money(result.profit) }} / {{ result.margin }}%</b></div>
          <p class="hint">体积 {{ result.volumeLiters }} L；重量 {{ form.weight }} g。请用实际计费规则核对物流报价。</p>
        </el-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pricing-page { max-width: 1180px; margin: 0 auto; padding: 24px; }
.pricing-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(360px, 1fr); gap: 20px; margin-top: 14px; }
.pricing-results { display: grid; align-content: start; gap: 18px; }
.pricing-results > :first-child { background: #f4f8ff; border-color: #d7e2ff; }
h2 { margin: 0; text-align: center; color: #6758e9; font-size: 22px; }
h3 { border-left: 4px solid #7466ef; padding-left: 10px; margin: 26px 0 18px; font-size: 15px; }
.pricing-form :deep(.el-form-item__label) { color: #545b69; font-size: 13px; }
.unit { margin-left: 8px; color: #697386; }
.pricing-form :deep(.el-input-number) { width: 220px; max-width: 100%; }
.pricing-form :deep(.el-input-number .el-input__inner) { text-align: left; color: #303744; font-variant-numeric: tabular-nums; }
.category-field { width: 100%; }
.category-field small { display: block; color: #8b95a7; font-size: 11px; line-height: 1.4; margin-top: 4px; }
.category-field .rate-error { color: #d85050; }
.category-field .tier-note { color: #6758e9; }
.exchange-note { margin: 2px 0 16px 150px; color: #8b95a7; font-size: 12px; }
.rate-error { display: block; color: #d85050; }
.dimensions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.dimensions :deep(.el-input-number) { width: 118px; }
.calculate-button { width: 100%; margin-top: 10px; background: #7060ed; border-color: #7060ed; }
.calculate-button:hover { background: #5f50d9; border-color: #5f50d9; }
.shipping-tip { margin: 0 0 12px; padding: 10px 12px; border-radius: 7px; color: #5e558e; background: #f2efff; font-size: 12px; }
.shipping-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.shipping-card { display: grid; align-content: start; gap: 8px; min-height: 130px; padding: 13px; text-align: left; border: 1px solid #cad9fa; border-radius: 8px; background: #edf5ff; cursor: pointer; }
.shipping-card:nth-child(3n + 2) { border-color: #dacbff; background: #f8f3ff; }
.shipping-card:nth-child(3n) { border-color: #ffcce4; background: #fff2f8; }
.shipping-card.active { box-shadow: inset 0 0 0 2px #7466ef; }
.shipping-card strong { color: #286adf; font-size: 13px; }
.shipping-card b { color: #eb4d4d; font-size: 19px; }
.shipping-card small { color: #788294; font-size: 11px; line-height: 1.4; }
.price-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.price-pair > div { display: grid; gap: 9px; }
.price-pair small, .price-pair span, .hint { color: #788294; }
.price-pair strong { font-size: 27px; color: #6758e9; }
.detail-row { display: flex; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid #eef0f4; }
.detail-row.profit { color: #279b60; }
.hint { font-size: 12px; }
@media (max-width: 850px) { .pricing-grid { grid-template-columns: 1fr; } .pricing-page { padding: 12px; } .exchange-note { margin-left: 0; } }
</style>
