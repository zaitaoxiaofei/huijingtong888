<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { apiClient, currentApiCacheScope } from '../../utils/api';
import { shanghaiDateTimeText } from '../../utils/shanghai-date.js';
import { recommendProfitRecalculation } from '../../../../src/shared/product-profit-parameters.js';
const visible = ref(false), busy = ref(false), product = ref(null), changes = ref([]), rules = ref([]), preview = ref(null);
const form = reactive({ action: 'existing', recalculation_scope: 'pending', date_from: '', date_to: '', tariff_mode: 'original', logistics_rule_id: null });
let resolveDialog, requestScope = '', generation = 0, result = null;
const recommendation = computed(() => recommendProfitRecalculation(changes.value));
const money = value => Number(value || 0).toFixed(2);
watch(form, () => { preview.value = null; generation += 1; });
function open(value, changed = []) {
  product.value = value; changes.value = changed; preview.value = null; result = null;
  requestScope = currentApiCacheScope(); generation += 1;
  Object.assign(form, { action: changed.length ? recommendProfitRecalculation(changed) : 'existing', recalculation_scope: 'pending', date_from: '', date_to: '', tariff_mode: 'original', logistics_rule_id: null });
  visible.value = true;
  return new Promise(resolve => { resolveDialog = resolve; });
}
function finish() { const resolve = resolveDialog; resolveDialog = null; resolve?.(result); }
onBeforeUnmount(() => { generation += 1; finish(); });
async function loadRules() {
  if (form.tariff_mode !== 'specified' || rules.value.length) return;
  try { const data = await apiClient.get('/api/logistics-rules', { noCache: true }); if (requestScope === currentApiCacheScope()) rules.value = Array.isArray(data) ? data : data.rows || []; }
  catch (error) { ElMessage.error(error.message || '加载运价版本失败'); }
}
async function calculate(execute = false) {
  if (busy.value || requestScope !== currentApiCacheScope()) return;
  const token = generation;
  busy.value = true;
  try {
    const data = await apiClient.post(`/api/products/${product.value.id}/recalculate-profits`, {
      ...form, preview: !execute, ...(execute ? { preview_token: preview.value?.preview_token } : {})
    });
    if (token !== generation || requestScope !== currentApiCacheScope()) return;
    if (!execute) preview.value = data;
    else {
      result = data;
      if (data.failed) {
        preview.value = null;
        ElMessage.warning(`已重算 ${data.updated} 行，${data.failed} 行失败，请重新预览：${data.failed_rows?.[0]?.reason || ''}`);
      } else {
        if (data.refresh_warning) ElMessage.warning(data.refresh_warning);
        else ElMessage.success(`已重算 ${data.updated} 个订单商品行，跳过 ${data.skipped || 0} 行`);
        visible.value = false;
      }
      window.dispatchEvent(new CustomEvent('erp:order-profits-recalculated', { detail: { productId: product.value.id } }));
    }
  } catch (error) { if (execute) preview.value = null; ElMessage.error(error.message || '利润重算失败'); }
  finally { busy.value = false; }
}
defineExpose({ open });
</script>
<template>
  <el-dialog v-model="visible" title="更新关联订单的预估利润" width="960px" style="max-width: calc(100vw - 24px)" append-to-body :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @closed="finish">
    <p v-if="changes.length">商品资料已保存。以下参数已变化，请选择已有订单如何处理。</p>
    <el-table v-if="changes.length" :data="changes" size="small" max-height="180">
      <el-table-column prop="label" label="变更参数"/><el-table-column prop="before" label="修改前"/><el-table-column prop="after" label="修改后"/>
    </el-table>
    <el-alert :closable="false" type="info" style="margin: 14px 0" :title="recommendation === 'future' ? '物流规则或渠道已变化，建议仅后续订单生效；历史订单可另选运价重算。' : '重量或成本修正，建议重算受影响的未结算订单。'" description="已结算、锁定、已结束和售后订单会跳过；各订单保留原有利润公式版本及订单日期汇率，旧计算记录可追溯。"/>
    <el-form label-width="110px" :disabled="busy">
      <el-form-item label="生效范围"><el-radio-group v-model="form.action"><el-radio value="future">仅后续订单，已有订单不重算</el-radio><el-radio value="existing">重算已有订单</el-radio></el-radio-group></el-form-item>
      <template v-if="form.action === 'existing'">
        <el-form-item label="订单范围"><el-select v-model="form.recalculation_scope"><el-option value="pending" label="未结算订单（含已发货）"/><el-option value="unfulfilled" label="仅未发货订单"/></el-select></el-form-item>
        <el-form-item label="订单日期"><div class="date-range"><el-date-picker v-model="form.date_from" type="date" value-format="YYYY-MM-DD" placeholder="开始日期（北京时间）"/><span>至</span><el-date-picker v-model="form.date_to" type="date" value-format="YYYY-MM-DD" placeholder="结束日期（北京时间）"/></div></el-form-item>
        <el-form-item label="运价版本"><el-select v-model="form.tariff_mode" @change="loadRules"><el-option value="original" label="保留每单原运价版本，更新重量及成本"/><el-option value="product" label="使用商品当前选定的运价版本"/><el-option value="specified" label="指定物流运价版本"/></el-select></el-form-item>
        <el-form-item v-if="form.tariff_mode === 'specified'" label="指定运价"><el-select v-model="form.logistics_rule_id" filterable placeholder="选择物流渠道及运价版本"><el-option v-for="rule in rules" :key="rule.id" :value="Number(rule.id)" :label="`${rule.name} · #${rule.id} · ${shanghaiDateTimeText(rule.effective_from, { assumeUtcWhenNaive: true })}`"/></el-select></el-form-item>
      </template>
    </el-form>
    <template v-if="preview && form.action === 'existing'">
      <p>可重算 <strong>{{ preview.selected_items }}</strong> 行，跳过 {{ preview.skipped_items }} 行；预估利润合计变化 <strong>{{ money(preview.profit_difference) }} 元</strong>。</p>
      <el-table :data="preview.rows" size="small" max-height="280">
        <el-table-column prop="posting_number" label="订单" min-width="170"/>
        <el-table-column prop="weight_g" label="重量(g)" width="90"/>
        <el-table-column label="运价 / 公式版本" min-width="190"><template #default="{ row }">{{ row.logistics_rule_name }} #{{ row.logistics_rule_id }} / {{ row.formula_version }}</template></el-table-column>
        <el-table-column label="运费变化" width="140"><template #default="{ row }">{{ money(row.old_freight) }} → {{ money(row.new_freight) }}</template></el-table-column>
        <el-table-column label="利润变化" width="140"><template #default="{ row }">{{ money(row.old_profit) }} → {{ money(row.new_profit) }}</template></el-table-column>
      </el-table>
      <el-collapse v-if="preview.skipped_items"><el-collapse-item title="查看跳过原因"><p v-for="row in preview.skipped_rows" :key="row.order_item_id">{{ row.posting_number }}：{{ row.reason }}</p></el-collapse-item></el-collapse>
    </template>
    <template #footer>
      <el-button :disabled="busy" @click="visible = false">{{ form.action === 'future' ? '完成，保留已有订单' : '暂不重算' }}</el-button>
      <el-button v-if="form.action === 'existing'" :loading="busy" @click="calculate(false)">预览影响</el-button>
      <el-button v-if="form.action === 'existing'" type="primary" :loading="busy" :disabled="!preview?.selected_items" @click="calculate(true)">确认重算 {{ preview?.selected_items || 0 }} 行</el-button>
    </template>
  </el-dialog>
</template>
<style scoped>
.date-range { display: flex; gap: 8px; flex-wrap: wrap; }
.el-select { width: 100%; }
</style>
