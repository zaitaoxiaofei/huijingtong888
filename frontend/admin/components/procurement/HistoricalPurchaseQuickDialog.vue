<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { apiClient } from '../../utils/api.js';
import { shanghaiDateKey, shanghaiDateTimeText } from '../../utils/shanghai-date.js';
const props = defineProps({ products: { type: Array, required: true } });
const emit = defineEmits(['close', 'saved']);
const loading = ref(false), saving = ref(false), rows = ref([]);
const pending = computed(() => rows.value.filter(row => !row.saved));
function time(value) { return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true }); }
function dateError(row) {
  if (!row.purchased_at) return '请填写实际采购时间，不是补录时间。';
  const date = Date.parse(row.purchased_at);
  if (!Number.isFinite(date) || date > Date.now()) return '请填写有效采购时间，不能晚于当前时间。';
  const order = (row.data?.orders || []).filter(order => order.entered_transport && order.stock_location !== 'FBP' && Number(order.missing_purchase_quantity) > 0 && order.transport_at)
    .sort((a, b) => new Date(a.transport_at) - new Date(b.transport_at))[0];
  if (order && date > new Date(order.transport_at).getTime()) return `请核对原采购日期，须不晚于 ${time(order.transport_at)}（历史订单 ${order.posting_number || order.order_id}）。`;
  return '';
}
async function read(row) {
  row.data = await apiClient.get(`/api/procurement/ledger?product_id=${row.id}`, { noCache: true });
}
async function load() {
  loading.value = true;
  rows.value = [...new Map(props.products.map(product => [Number(product.id), product])).values()].map(product => ({
    id: Number(product.id), name: product.name, data: null, quantity: 0, amount: 0, shipping_amount: 0,
    purchased_at: `${shanghaiDateKey()}T00:00:00+08:00`, reason: '', error: '', submitted: null, saved: false
  }));
  for (const row of rows.value) {
    try { await read(row); row.quantity = Number(row.data.missing_purchase || 0); }
    catch (error) { row.error = `加载失败：${error.message}。保存时会重试，也可删除此行。`; }
  }
  loading.value = false;
}
function remove(row) { rows.value = rows.value.filter(item => item !== row); }
async function save() {
  if (saving.value || loading.value || !pending.value.length) return;
  saving.value = true;
  let changed = false;
  try {
    // Validate every remaining row before writing any of them.
    for (const row of pending.value) {
      row.error = '';
      if (row.submitted) continue; // Retry uncertain responses with the original idempotency key.
      try {
        await read(row);
        const error = dateError(row);
        if (error) throw new Error(error);
        const payload = { action_type: 'historical_purchase_bulk', product_id: row.id, quantity: row.quantity,
          amount: row.amount, shipping_amount: row.shipping_amount, purchased_at: row.purchased_at,
          reason: row.reason.trim() || '订单列表补齐历史采购记录', inventory_effect: 'already_accounted',
          revision: row.data.revision, request_key: crypto.randomUUID() };
        await apiClient.post('/api/procurement/ledger/preview', payload);
        row.preview = payload;
      } catch (error) { row.error = error.message; }
    }
    if (pending.value.some(row => row.error)) { ElMessage.warning('请处理表格中标红的行，已填内容不会丢失。'); return; }
    for (const row of pending.value) {
      row.submitted ||= row.preview;
      try {
        await apiClient.post('/api/procurement/ledger', row.submitted);
        row.saved = true;
        changed = true;
      } catch (error) {
        row.error = `此行未确认保存成功：${error.message}。已成功的行不会重复提交，请再次保存重试。`;
        if (error.status >= 400 && error.status < 500) row.submitted = null;
        ElMessage.error('部分行尚未保存，请查看行内提示；已填内容已保留。');
        return;
      }
    }
    ElMessage.success('历史采购记录已保存，未增加现货或在途库存');
    emit('close');
  } finally {
    if (changed) emit('saved');
    saving.value = false;
  }
}
onMounted(load);
</script>
<template>
  <el-dialog :model-value="true" title="补齐历史采购记录" width="min(1500px, 96vw)" :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving" @close="emit('close')">
    <el-alert type="info" :closable="false" title="每行对应一个库存产品，仅补历史采购来源与成本，不增加现货或在途。日期默认今天，请按原采购凭证修改；删除子记录只移除本次填写行，不删除库存或历史记录。" />
    <el-table v-loading="loading" :data="rows" row-key="id" max-height="65vh" class="history-purchase-table">
      <el-table-column label="库存产品" min-width="300" fixed>
        <template #default="{ row }">
          <div class="history-product">
            <el-image v-if="row.data?.product.image_url" class="history-image" :src="row.data.product.image_url" fit="cover" :preview-src-list="[row.data.product.image_url]" :initial-index="0" preview-teleported />
            <span v-else class="history-image history-no-image">无图</span>
            <div><strong>{{ row.data?.product.name || row.name }}</strong><p>库存 ID：{{ row.data?.product.inventory_number || row.id }}</p><small>{{ row.data?.product.code }}</small></div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="缺采购记录" width="110"><template #default="{ row }">{{ row.data?.missing_purchase ?? '—' }} 件</template></el-table-column>
      <el-table-column label="补录数量" width="150"><template #default="{ row }"><el-input-number v-model="row.quantity" aria-label="补录数量" :min="1" :max="Number(row.data?.missing_purchase || 0)" :precision="0" :disabled="saving || row.saved || !!row.submitted" controls-position="right" /></template></el-table-column>
      <el-table-column label="总货款（元）" width="150"><template #default="{ row }"><el-input-number v-model="row.amount" aria-label="总货款" :min="0" :precision="2" :disabled="saving || row.saved || !!row.submitted" controls-position="right" /></template></el-table-column>
      <el-table-column label="运费（元）" width="140"><template #default="{ row }"><el-input-number v-model="row.shipping_amount" aria-label="运费" :min="0" :precision="2" :disabled="saving || row.saved || !!row.submitted" controls-position="right" /></template></el-table-column>
      <el-table-column label="实际采购时间（北京时间）" width="310">
        <template #default="{ row }">
          <el-date-picker v-model="row.purchased_at" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss+08:00" placeholder="请选择实际采购时间" :disabled="saving || row.saved || !!row.submitted" @change="row.error = ''" />
          <p v-if="!row.saved && dateError(row)" class="history-error">{{ dateError(row) }}</p>
          <p v-if="row.error" class="history-error" role="alert">{{ row.error }}</p>
        </template>
      </el-table-column>
      <el-table-column label="原因／凭证（选填）" min-width="180"><template #default="{ row }"><el-input v-model="row.reason" placeholder="历史漏记原因或凭证编号" maxlength="1000" :disabled="saving || row.saved || !!row.submitted" /></template></el-table-column>
      <el-table-column label="操作" width="120" fixed="right"><template #default="{ row }"><el-tag v-if="row.saved" type="success">已保存</el-tag><el-button v-else type="danger" link :disabled="saving || loading || !!row.submitted" @click="remove(row)">删除子记录</el-button></template></el-table-column>
    </el-table>
    <template #footer>
      <el-button :disabled="saving" @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="loading || !pending.length" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>
<style scoped>
.history-purchase-table { margin-top: 16px; }
.history-product { display: flex; align-items: center; gap: 12px; min-height: 92px; }
.history-image { width: 64px; height: 84px; flex: 0 0 64px; border-radius: 4px; }
.history-no-image { display: flex; align-items: center; justify-content: center; background: #f5f7fa; color: #909399; }
.history-product p { margin: 6px 0; }
.history-error { color: #c45656; font-size: 12px; line-height: 1.5; margin: 6px 0; }
.history-purchase-table :deep(.el-input-number) { width: 125px; }
.history-purchase-table :deep(.el-date-editor) { width: 270px; }
</style>
