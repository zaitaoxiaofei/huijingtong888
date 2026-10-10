<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { calculateProfit } from "../../utils/pricing-tool.js";
import { quoteLogisticsRules } from "../../utils/logistics-quote.js";
import { apiClient } from "../../utils/api.js";

const form = reactive({
  category: "", saleCny: null, purchaseCost: null, commissionRate: null, carrier: "GUOO",
  weight: null, length: null, width: null, height: null, freight: null, exchangeRate: null,
  domesticCost: 0, lastMile: 0, adRate: 0, otherRate: 0, returnRate: 0, returnLoss: 0
});
const result = ref(null);
const logisticsRules = ref([]);
const logisticsError = ref("");
const selectedRuleId = ref(null);
const quotes = computed(() => quoteLogisticsRules(logisticsRules.value, {
  carrier: form.carrier, priceRub: Number(form.saleCny) * Number(form.exchangeRate),
  weightG: form.weight, length: form.length, width: form.width, height: form.height
}));
onMounted(async () => {
  try {
    const rows = await apiClient.get("/api/logistics-rules");
    logisticsRules.value = Array.isArray(rows) ? rows : [];
  } catch {
    logisticsError.value = "物流规则加载失败，请刷新后重试";
  }
});
function selectQuote(quote) {
  selectedRuleId.value = quote.id;
  form.freight = quote.priceCny;
  result.value = null;
}
const money = (value) => Number(value || 0).toFixed(2);
function calculate() {
  if (!form.category.trim() || form.commissionRate === null) {
    ElMessage.warning("请填写商品类目及该类目的 Ozon 佣金费率");
    return;
  }
  const selected = quotes.value.find((quote) => quote.id === selectedRuleId.value);
  if (selectedRuleId.value && !selected) {
    ElMessage.warning("原选物流渠道已不符合当前重量、尺寸或售价，请重新选择");
    return;
  }
  if (selected) form.freight = selected.priceCny;
  else if (quotes.value.length) selectQuote(quotes.value[0]);
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
    <el-alert type="info" :closable="false" show-icon title="按当前店铺实际佣金、物流报价和汇率填写。退货损失按退货率分摊，结果为经营测算。" />
    <div class="profit-grid">
      <el-card shadow="never">
        <template #header><h2>Ozon 跨境利润计算器</h2></template>
        <el-form :model="form" label-width="150px" label-position="left">
          <h3>基础设置</h3>
          <el-form-item label="实际售价" required><el-input-number v-model="form.saleCny" :min="0" :precision="2" /><span class="unit">元</span></el-form-item>
          <el-form-item label="采购成本" required><el-input-number v-model="form.purchaseCost" :min="0" :precision="2" /><span class="unit">元/件</span></el-form-item>
          <el-form-item label="商品类目" required><el-input v-model="form.category" placeholder="填写 Ozon 商品类目" /></el-form-item>
          <el-form-item label="类目佣金" required><el-input-number v-model="form.commissionRate" :min="0" :max="100" :precision="2" /><span class="unit">%</span></el-form-item>
          <el-form-item label="包裹重量" required><el-input-number v-model="form.weight" :min="0" :precision="0" /><span class="unit">克</span></el-form-item>
          <el-form-item label="包裹尺寸" required>
            <div class="dimensions"><el-input-number v-model="form.length" :min="0" :precision="1" /><span>×</span><el-input-number v-model="form.width" :min="0" :precision="1" /><span>×</span><el-input-number v-model="form.height" :min="0" :precision="1" /><span>厘米</span></div>
          </el-form-item>
          <el-form-item label="物流服务商"><el-select v-model="form.carrier" @change="selectedRuleId = null"><el-option label="GUOO" value="GUOO" /><el-option label="CEL" value="CEL" /></el-select></el-form-item>
          <div class="quote-list">
            <p v-if="logisticsError">{{ logisticsError }}</p>
            <p v-else-if="!quotes.length">填写售价、汇率、包装重量和尺寸后显示当前有效渠道；无匹配时请人工核对。</p>
            <button v-for="quote in quotes" :key="quote.id" type="button" class="quote-card" :class="{ active: selectedRuleId === quote.id }" :title="quote.source" @click="selectQuote(quote)">
              <strong>{{ quote.name }}</strong><span>¥ {{ money(quote.priceCny) }}</span><small>计费重 {{ quote.chargeableWeightG }}g</small><small>本地规则 #{{ quote.id }} · {{ quote.source }}</small>
            </button>
          </div>
          <el-form-item label="跨境物流费" required><el-input-number v-model="form.freight" :min="0" :precision="2" /><span class="unit">元/件</span></el-form-item>
          <el-form-item label="人民币兑卢布" required><el-input-number v-model="form.exchangeRate" :min="0" :precision="4" /><span class="unit">1 元 = ? ₽</span></el-form-item>
          <h3>其他费用</h3>
          <el-form-item label="国内运费及贴单"><el-input-number v-model="form.domesticCost" :min="0" :precision="2" /><span class="unit">元/件</span></el-form-item>
          <el-form-item label="尾程固定费"><el-input-number v-model="form.lastMile" :min="0" :precision="2" /><span class="unit">元/件</span></el-form-item>
          <el-form-item label="广告费占比"><el-input-number v-model="form.adRate" :min="0" :max="100" :precision="1" /><span class="unit">%</span></el-form-item>
          <el-form-item label="退货率"><el-input-number v-model="form.returnRate" :min="0" :max="100" :precision="1" /><span class="unit">% 的订单预计退货</span></el-form-item>
          <el-form-item label="单次退货损失"><el-input-number v-model="form.returnLoss" :min="0" :precision="2" /><span class="unit">元；退回运费、货损及不可退费用合计</span></el-form-item>
          <el-form-item label="其他费占比"><el-input-number v-model="form.otherRate" :min="0" :max="100" :precision="1" /><span class="unit">%，避免重复计入退货损失</span></el-form-item>
          <el-button type="primary" class="calculate-button" @click="calculate">开始计算</el-button>
        </el-form>
      </el-card>
      <div class="results">
        <el-card shadow="never">
          <template #header><strong>计算结果</strong></template>
          <div v-if="result" class="headline"><small>预计净利润</small><strong :class="{ negative: result.profit < 0 }">¥ {{ money(result.profit) }}</strong><span>利润率 {{ result.margin }}% · 售价约 ₽ {{ money(result.saleRub) }}</span></div>
          <el-empty v-else description="填写参数后计算利润" :image-size="80" />
        </el-card>
        <el-card v-if="result" shadow="never">
          <template #header><strong>费用明细（人民币 / 件）</strong></template>
          <div class="detail-row"><span>采购成本</span><b>¥ {{ money(form.purchaseCost) }}</b></div>
          <div class="detail-row"><span>平台佣金</span><b>¥ {{ money(result.commission) }}</b></div>
          <div class="detail-row"><span>跨境物流费</span><b>¥ {{ money(form.freight) }}</b></div>
          <div class="detail-row"><span>国内运费及贴单</span><b>¥ {{ money(form.domesticCost) }}</b></div>
          <div class="detail-row"><span>尾程固定费</span><b>¥ {{ money(form.lastMile) }}</b></div>
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
.profit-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(320px, 1fr); gap: 18px; margin-top: 18px; }
.results { display: grid; align-content: start; gap: 18px; }
h2 { margin: 0; text-align: center; color: #6758e9; font-size: 22px; }
h3 { border-left: 4px solid #7466ef; padding-left: 10px; margin: 26px 0 18px; font-size: 15px; }
.unit { margin-left: 8px; color: #697386; }
.dimensions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dimensions :deep(.el-input-number) { width: 105px; }
.calculate-button { width: 100%; margin-top: 10px; }
.quote-list { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 18px 150px; }
.quote-list p { color: #788294; font-size: 12px; }
.quote-card { display: grid; gap: 5px; min-width: 150px; padding: 12px; text-align: left; border: 1px solid #d9def0; border-radius: 8px; background: #f8f9ff; cursor: pointer; }
.quote-card.active { border-color: #7466ef; background: #f0eeff; }
.quote-card span { color: #6758e9; font-weight: 700; }
.quote-card small { color: #788294; }
.headline { display: grid; gap: 8px; }
.headline strong { font-size: 30px; color: #6758e9; }
.headline strong.negative { color: #d85050; }
.headline small, .headline span, .hint { color: #788294; }
.detail-row { display: flex; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid #eef0f4; }
.detail-row.total { color: #279b60; }
.hint { font-size: 12px; }
@media (max-width: 850px) { .profit-grid { grid-template-columns: 1fr; } .profit-page { padding: 12px; } }
</style>
