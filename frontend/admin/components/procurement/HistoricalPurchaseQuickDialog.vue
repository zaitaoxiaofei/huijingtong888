<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { apiClient } from '../../utils/api.js';
import { shanghaiDateTimeText } from '../../utils/shanghai-date.js';
const props = defineProps({ productId: { type: Number, required: true } });
const emit = defineEmits(['close', 'saved']);
const loading = ref(false), saving = ref(false), data = ref(null), preview = ref(null), submitted = ref(null), result = ref(null);
const form = reactive({ quantity: 1, amount: 0, shipping_amount: 0, purchased_at: '', reason: '' });
const missing = computed(() => Number(data.value?.missing_purchase || 0));
const allocatedOrders = computed(() => {
  let left = Number(form.quantity);
  return (data.value?.orders || []).filter(row => row.entered_transport && row.stock_location !== 'FBP' && Number(row.missing_purchase_quantity) > 0)
    .sort((a, b) => new Date(a.transport_at || 0) - new Date(b.transport_at || 0) || a.order_item_id - b.order_item_id)
    .flatMap(row => {
      const quantity = Math.min(left, Number(row.missing_purchase_quantity));
      left -= quantity;
      return quantity > 0 ? [{ ...row, quantity }] : [];
    });
});
const earliestOrder = computed(() => allocatedOrders.value.filter(row => row.transport_at)
  .sort((a, b) => new Date(a.transport_at) - new Date(b.transport_at))[0]);
const dateError = computed(() => {
  if (!form.purchased_at) return '请按采购凭证填写实际采购时间，不是今天的补录时间。';
  if (Date.parse(form.purchased_at) > Date.now()) return '实际采购时间不能晚于当前时间。';
  const row = earliestOrder.value;
  if (row && Date.parse(form.purchased_at) > new Date(row.transport_at).getTime()) return `实际采购时间不能晚于历史订单 ${row.posting_number || row.order_id} 的运输时间 ${time(row.transport_at)}（北京时间）。请核对原采购凭证；若是新采购，请通过待采购操作登记。`;
  return '';
});
function time(value) { return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true }); }
watch(form, () => { preview.value = null; submitted.value = null; });
async function load() {
  loading.value = true;
  preview.value = null; submitted.value = null; data.value = null;
  try {
    data.value = await apiClient.get(`/api/procurement/ledger?product_id=${props.productId}`, { noCache: true });
    form.quantity = missing.value;
  } catch (error) { ElMessage.error(error.message); }
  finally { loading.value = false; }
}
async function check() {
  if (dateError.value) { ElMessage.warning(dateError.value); return; }
  saving.value = true;
  preview.value = null; submitted.value = null;
  try {
    const payload = { ...form, action_type: 'historical_purchase_bulk', product_id: props.productId,
      inventory_effect: 'already_accounted', revision: data.value.revision, request_key: crypto.randomUUID() };
    preview.value = await apiClient.post('/api/procurement/ledger/preview', payload);
    submitted.value = payload;
  } catch (error) { ElMessage.error(error.message); }
  finally { saving.value = false; }
}
async function save() {
  if (!submitted.value || saving.value) return;
  saving.value = true;
  try {
    result.value = await apiClient.post('/api/procurement/ledger', submitted.value);
    ElMessage.success('历史采购记录已补齐，未增加库存或在途');
    emit('saved');
  } catch (error) { ElMessage.error(error.message); }
  finally { saving.value = false; }
}
onMounted(load);
</script>
<template>
  <el-dialog :model-value="true" title="补齐历史采购记录" width="min(900px, 96vw)" :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" @close="emit('close')">
    <div v-loading="loading">
      <template v-if="data">
        <strong>{{ data.product.name }} · {{ data.product.code }}</strong>
        <el-alert type="info" :closable="false" title="按该库存的历史订单缺采购记录补齐，不按负库存直接清零；只补采购来源与成本，不增加现货或采购在途。" />
        <p>缺采购记录：{{ missing }} 件；已有采购、收货待核：{{ data.missing_receipt }} 件（不重复采购）。</p>
        <el-form v-if="missing > 0 && !result" label-width="140px" :disabled="saving">
          <el-form-item label="本次补齐数量"><el-input-number v-model="form.quantity" :min="1" :max="missing" :precision="0" /></el-form-item>
          <el-form-item label="实际总货款（元）"><el-input-number v-model="form.amount" :min="0" :precision="2" /></el-form-item>
          <el-form-item label="总运费（元）"><el-input-number v-model="form.shipping_amount" :min="0" :precision="2" /></el-form-item>
          <el-form-item label="实际采购时间"><el-date-picker v-model="form.purchased_at" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss+08:00" placeholder="北京时间，按实际采购批次填写" /></el-form-item>
          <el-alert v-if="dateError" type="warning" :closable="false" :title="dateError" />
          <p v-if="earliestOrder">本次按最早历史订单开始补齐，采购日期须不晚于 {{ time(earliestOrder.transport_at) }}（北京时间）。不同采购批次请分次填写实际数量、金额与日期；不确定日期时请先核对凭证，不要随意填早。</p>
          <el-form-item label="原因／凭证"><el-input v-model="form.reason" type="textarea" maxlength="1000" placeholder="填写历史漏记原因或采购凭证编号" /></el-form-item>
          <el-table :data="allocatedOrders" max-height="200">
            <el-table-column prop="posting_number" label="待补历史订单" min-width="180" />
            <el-table-column label="进入运输时间（北京时间）" min-width="200"><template #default="{ row }">{{ time(row.transport_at) }}</template></el-table-column>
            <el-table-column prop="quantity" label="本次分配件数" width="120" />
          </el-table>
        </el-form>
        <el-empty v-else-if="!result" description="没有可补齐的历史采购缺口。负库存不一定是缺采购记录，请在明细中核对收货、绑定及盘点。" />
        <template v-if="preview || result">
          <el-alert type="success" :closable="false" :title="result ? '补齐成功，可在采购记录及库存明细中追溯' : '按历史订单先后分配数量，货款与运费按数量分摊；确认下面的订单后保存'" />
          <el-table :data="(result || preview).allocations" max-height="320">
            <el-table-column prop="posting_number" label="历史订单" min-width="180" />
            <el-table-column prop="quantity" label="补齐件数" width="100" />
            <el-table-column prop="amount" label="分摊货款（元）" />
            <el-table-column prop="shipping_amount" label="分摊运费（元）" />
          </el-table>
          <p>总货款 {{ form.amount }} 元 + 运费 {{ form.shipping_amount }} 元；本地库存不变，在途不变。</p>
        </template>
      </template>
      <el-empty v-else-if="!loading" description="加载失败，请重试"><el-button @click="load">重新加载</el-button></el-empty>
    </div>
    <template #footer>
      <el-button :disabled="saving" @click="emit('close')">{{ result ? '完成' : '取消' }}</el-button>
      <el-button v-if="data && !result" :disabled="saving" @click="load">刷新缺口</el-button>
      <el-button v-if="missing > 0 && !result" :loading="saving" @click="check">预览分配</el-button>
      <el-button v-if="missing > 0 && !result" type="primary" :disabled="!preview || saving" @click="save">确认补齐采购记录</el-button>
    </template>
  </el-dialog>
</template>
