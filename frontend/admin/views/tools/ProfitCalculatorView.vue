<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { calculateProfit } from "../../utils/pricing-tool.js";
import { quoteLogisticsRules, channelLabel, threeChannelQuotes, defaultLogisticsQuote, logisticsRuleMismatchReasons } from "../../utils/logistics-quote.js";
import { apiClient } from "../../utils/api.js";
import { commissionRateForRub } from "../../utils/rfbs-commission.js";
import RfbsCommissionPicker from "./RfbsCommissionPicker.vue";

const form = reactive({
  category: "", saleCny: null, purchaseCost: null, commissionRate: null, carrier: "GUOO",
  weight: null, length: null, width: null, height: null, freight: null, exchangeRate: null,
  domesticCost: 0, adRate: 0, otherRate: 0, returnRate: 0, returnLoss: 0
});
const result = ref(null);
const logisticsRules = ref([]);
const logisticsError = ref("");
const rateError = ref("");
const rateLoading = ref(true);
const rateSourceDate = ref("");
const selection = ref(null);
const categoryDetail = computed(() => selection.value?.category || null);
const selectedRuleId = ref(null);
function selectCategory(value) {
  selection.value = value;
  form.category = String(value.category.id);
  result.value = null;
}
const saleRub = computed(() => Number(form.saleCny) * Number(form.exchangeRate));
const actualCommission = computed(() => commissionRateForRub(categoryDetail.value?.rates, saleRub.value));
const selectedCommission = computed(() => selection.value ? categoryDetail.value.rates[selection.value.band] : null);
const bandMismatch = computed(() => selection.value && actualCommission.value !== null && selection.value.band !== (saleRub.value <= 1500 ? 0 : saleRub.value <= 5000 ? 1 : 2));
const quotes = computed(() => quoteLogisticsRules(logisticsRules.value, {
  carrier: form.carrier, priceRub: saleRub.value,
  weightG: form.weight, length: form.length, width: form.width, height: form.height, exchangeRate: form.exchangeRate
}));
const displayQuotes = computed(() => threeChannelQuotes(quotes.value));
const defaultQuote = computed(() => defaultLogisticsQuote(displayQuotes.value));
const activeQuote = computed(() => quotes.value.find((quote) => quote.id === selectedRuleId.value) || defaultQuote.value);
const previousRule = computed(() => logisticsRules.value.find((rule) => rule.id === selectedRuleId.value));
const outdatedQuoteNote = computed(() => {
  if (!quoteReady.value || !selectedRuleId.value || quotes.value.some((quote) => quote.id === selectedRuleId.value)) return "";
  const reasons = logisticsRuleMismatchReasons(previousRule.value, {
    priceRub: saleRub.value, weightG: form.weight, length: form.length, width: form.width, height: form.height
  });
  const explanation = reasons.length ? reasons.join("；") : "该规则已停用或不在当前生效期";
  return `原选 ${previousRule.value?.name || "物流规则"} 已失效：${explanation}。${defaultQuote.value ? `计算时将自动改用 ${defaultQuote.value.name}。` : "请调整标注的参数或切换服务商。"}`;
});
const quoteReady = computed(() => Number(form.saleCny) > 0 && Number(form.exchangeRate) > 0
  && Number(form.weight) > 0 && [form.length, form.width, form.height].every((value) => Number(value) > 0));
onMounted(async () => {
  const [rulesResult, rateResult] = await Promise.allSettled([
    apiClient.get("/api/tools/pricing/logistics-rules", { noCache: true }),
    apiClient.get("/api/tools/pricing/reference-rate", { noCache: true })
  ]);
  if (rulesResult.status === "fulfilled") logisticsRules.value = Array.isArray(rulesResult.value) ? rulesResult.value : [];
  else logisticsError.value = "物流规则加载失败，请刷新后重试";
  if (rateResult.status === "fulfilled" && Number(rateResult.value?.rate) > 0) {
    if (!(Number(form.exchangeRate) > 0)) {
      form.exchangeRate = Number(rateResult.value.rate);
      rateSourceDate.value = String(rateResult.value.source_date || "");
    }
  } else if (!(Number(form.exchangeRate) > 0)) rateError.value = "俄罗斯央行汇率获取失败，请手动填写人民币兑卢布汇率";
  rateLoading.value = false;
});
function selectQuote(quote) {
  selectedRuleId.value = quote.id;
  form.freight = quote.priceCny;
  result.value = null;
}
function editExchangeRate() {
  rateSourceDate.value = "";
  rateError.value = "";
  result.value = null;
}
const money = (value) => Number(value || 0).toFixed(2);
function calculate() {
  if (!(Number(form.exchangeRate) > 0)) {
    ElMessage.warning(rateLoading.value ? "汇率仍在获取中，请稍后计算" : "缺少人民币兑卢布汇率，请在参考汇率处填写后计算");
    return;
  }
  if (!categoryDetail.value || selectedCommission.value === null) {
    ElMessage.warning("请从 rFBS 佣金表选择商品类目，并等待汇率和售价匹配佣金档位");
    return;
  }
  if (bandMismatch.value) { ElMessage.warning("所选佣金售价档与实际售价不符，请选择高亮的售价档"); return; }
  const selected = quotes.value.find((quote) => quote.id === selectedRuleId.value);
  if (selectedRuleId.value && !selected && defaultQuote.value) ElMessage.info(outdatedQuoteNote.value);
  if (selected) form.freight = selected.priceCny;
  else if (defaultQuote.value) selectQuote(defaultQuote.value);
  else { ElMessage.warning(outdatedQuoteNote.value || "当前售价、重量和尺寸没有匹配的有效物流渠道；请核对货值（卢布）、计费重和包裹尺寸"); return; }
  form.commissionRate = selectedCommission.value;
  try {
    result.value = calculateProfit(form);
  } catch (error) {
    result.value = null;
    ElMessage.warning(error.message);
  }
}
</script>

<template>
  <div class="profit-page">
    <el-alert type="info" :closable="false" show-icon title="佣金按 Ozon 中国 rFBS 费率表匹配；物流按售价、重量和尺寸匹配本地规则，退货损失按退货率分摊。" />
    <div class="profit-grid">
      <el-card shadow="never">
        <template #header><h2>OZON 跨境利润计算器</h2></template>
        <el-form :model="form" label-width="150px" label-position="right">
          <h3>基础设置</h3>
          <el-form-item label="实际售价" required><el-input-number :controls="false" v-model="form.saleCny" :min="0" :precision="2" /><span class="unit">元</span></el-form-item>
          <el-form-item label="采购成本" required><el-input-number :controls="false" v-model="form.purchaseCost" :min="0" :precision="2" /><span class="unit">元/件</span></el-form-item>
          <el-form-item label="类目佣金" required><div class="category-field"><RfbsCommissionPicker :selection="selection" :price-rub="saleRub" @select="selectCategory" /><small v-if="selection">rFBS {{ selection.version }} · {{ selection.sourceFile }}</small><small v-if="bandMismatch" class="rate-error">实际售价约 ₽{{ money(saleRub) }}，适用佣金 {{ actualCommission }}%；请选择高亮的售价档。</small></div></el-form-item>
          <el-form-item label="包裹重量" required><el-input-number :controls="false" v-model="form.weight" :min="0" :precision="0" /><span class="unit">克</span></el-form-item>
          <el-form-item label="包裹尺寸" required>
            <div class="dimensions"><el-input-number :controls="false" v-model="form.length" :min="0" :precision="1" /><span>×</span><el-input-number :controls="false" v-model="form.width" :min="0" :precision="1" /><span>×</span><el-input-number :controls="false" v-model="form.height" :min="0" :precision="1" /><span>厘米</span></div>
          </el-form-item>
          <el-form-item label="物流服务商"><el-select v-model="form.carrier" @change="selectedRuleId = null"><el-option label="GUOO" value="GUOO" /><el-option label="CEL" value="CEL" /><el-option label="OGL（陆运）" value="OGL" /></el-select></el-form-item>
          <el-form-item label="参考汇率" required><el-input-number :controls="false" v-model="form.exchangeRate" :min="0.0001" :precision="4" @update:model-value="editExchangeRate" /><span class="unit">₽ / 元</span><span v-if="rateLoading" class="unit">获取中</span><span v-else-if="rateSourceDate" class="unit">俄罗斯央行 {{ rateSourceDate }}</span><span v-if="rateError" class="rate-error">{{ rateError }}</span></el-form-item>
          <h3>其他费用</h3>
          <el-form-item label="国内运费及贴单"><el-input-number :controls="false" v-model="form.domesticCost" :min="0" :precision="2" /><span class="unit">元/件</span></el-form-item>
          <el-form-item label="广告费占比"><el-input-number :controls="false" v-model="form.adRate" :min="0" :max="100" :precision="1" /><span class="unit">%</span></el-form-item>
          <el-form-item label="退货率"><el-input-number :controls="false" v-model="form.returnRate" :min="0" :max="100" :precision="1" /><span class="unit">% 的订单预计退货</span></el-form-item>
          <el-form-item label="单次退货损失"><el-input-number :controls="false" v-model="form.returnLoss" :min="0" :precision="2" /><span class="unit">元；退回运费、货损及不可退费用合计</span></el-form-item>
          <el-form-item label="其他费占比"><el-input-number :controls="false" v-model="form.otherRate" :min="0" :max="100" :precision="1" /><span class="unit">%，提现与尾程已自动计入，避免重复计算</span></el-form-item>
          <el-button type="primary" class="calculate-button" @click="calculate">开始计算</el-button>
        </el-form>
      </el-card>
      <div class="results">
        <el-card shadow="never">
          <template #header><strong>计算结果</strong></template>
          <div v-if="result" class="headline"><small>预计净利润</small><strong :class="{ negative: result.profit < 0 }">¥ {{ money(result.profit) }}</strong><span>利润率 {{ result.margin }}% · 售价约 ₽ {{ money(result.saleRub) }}</span></div>
          <el-empty v-else description="填写参数后计算利润" :image-size="80" />
        </el-card>
        <el-card shadow="never" class="shipping-panel">
          <template #header><strong>物流费用</strong></template>
          <p v-if="logisticsError" class="rate-error">{{ logisticsError }}</p>
          <p v-else-if="!quoteReady" class="hint">{{ Number(form.exchangeRate) > 0 ? '填写售价、重量和尺寸后显示有效渠道。' : '缺少人民币兑卢布汇率；请等待获取或在参考汇率处手动填写。' }}</p>
          <p v-else-if="!quotes.length" class="hint">{{ outdatedQuoteNote || '当前售价、重量和尺寸没有匹配的有效物流渠道；请核对货值（卢布）、计费重和包裹尺寸，或切换服务商。' }}</p>
          <template v-else><p v-if="outdatedQuoteNote" class="rate-error">{{ outdatedQuoteNote }}</p><p class="shipping-tip">已匹配 {{ form.carrier }} 当前有效物流方案；{{ form.carrier === 'OGL' ? '仅陆运，运费包含平台电子服务费。' : '默认陆空 Standard，点击卡片可切换。' }}</p><div class="shipping-cards"><button v-for="quote in displayQuotes" :key="quote.id" type="button" class="shipping-card" :class="{ active: (selectedRuleId ?? defaultQuote?.id) === quote.id }" :title="quote.source" @click="selectQuote(quote)"><strong>{{ channelLabel(quote.channel) }} <small>{{ quote.channel }}</small></strong><b>¥ {{ money(quote.priceCny) }}</b><small>{{ quote.name }}</small><small>计费重 {{ quote.chargeableWeightG }}g<span v-if="quote.serviceFeeRub"> · 含电子服务费 ₽{{ money(quote.serviceFeeRub) }}</span></small></button></div></template>
        </el-card>
        <el-card v-if="result" shadow="never">
          <template #header><strong>费用明细（人民币 / 件）</strong></template>
          <div class="detail-row"><span>采购成本</span><b>¥ {{ money(form.purchaseCost) }}</b></div>
          <div class="detail-row"><span>平台佣金</span><b>¥ {{ money(result.commission) }}</b></div>
          <div class="detail-row"><span>跨境物流费</span><b>¥ {{ money(activeQuote?.transportCny ?? form.freight) }}</b></div>
          <div v-if="activeQuote?.serviceFeeRub" class="detail-row"><span>OGL 平台电子服务费（₽{{ money(activeQuote.serviceFeeRub) }}）</span><b>¥ {{ money(activeQuote.serviceFeeCny) }}</b></div>
          <div class="detail-row"><span>国内运费及贴单</span><b>¥ {{ money(form.domesticCost) }}</b></div>
          <div class="detail-row"><span>尾程费（售价 2.5%）</span><b>¥ {{ money(result.lastMile) }}</b></div>
          <div class="detail-row"><span>提现费（系统现有公式）</span><b>¥ {{ money(result.withdrawalFee) }}</b></div>
          <div class="detail-row"><span>广告费</span><b>¥ {{ money(result.advertising) }}</b></div>
          <div class="detail-row"><span>预期退货损失（{{ form.returnRate }}% × ¥{{ money(form.returnLoss) }}）</span><b>¥ {{ money(result.expectedReturnLoss) }}</b></div>
          <div class="detail-row"><span>其他费</span><b>¥ {{ money(result.other) }}</b></div>
          <div class="detail-row total"><span>预计净利润 / 净利率</span><b>¥ {{ money(result.profit) }} / {{ result.margin }}%</b></div>
          <p class="hint">体积 {{ result.volumeLiters }} L；重量 {{ form.weight }} g。请用实际计费规则核对物流报价。</p>
        </el-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.profit-page { max-width: 1180px; margin: 0 auto; padding: 24px; }
.profit-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(360px, 1fr); gap: 20px; margin-top: 14px; }
.results { display: grid; align-content: start; gap: 18px; }
.results > :first-child { background: #f4f8ff; border-color: #d7e2ff; }
h2 { margin: 0; text-align: center; color: #6758e9; font-size: 22px; }
h3 { border-left: 4px solid #7466ef; padding-left: 10px; margin: 26px 0 18px; font-size: 15px; }
.profit-page :deep(.el-form-item__label) { color: #545b69; font-size: 13px; }
.unit { margin-left: 8px; color: #697386; }
.profit-page :deep(.el-input-number) { width: 220px; max-width: 100%; }
.profit-page :deep(.el-input-number .el-input__inner) { text-align: left; color: #303744; font-variant-numeric: tabular-nums; }
.category-field { width: 100%; }
.category-field small { display: block; color: #8b95a7; font-size: 11px; line-height: 1.4; margin-top: 4px; }
.category-field .rate-error { color: #d85050; }
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
.headline { display: grid; gap: 8px; }
.headline strong { font-size: 30px; color: #6758e9; }
.headline strong.negative { color: #d85050; }
.headline small, .headline span, .hint { color: #788294; }
.detail-row { display: flex; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid #eef0f4; }
.detail-row.total { color: #279b60; }
.hint { font-size: 12px; }
@media (max-width: 850px) { .profit-grid { grid-template-columns: 1fr; } .profit-page { padding: 12px; } .exchange-note { margin-left: 0; } }
</style>
