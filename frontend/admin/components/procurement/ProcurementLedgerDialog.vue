<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { apiClient } from '../../utils/api.js';
import { shanghaiDateTimeText } from '../../utils/shanghai-date.js';
const props = defineProps({ modelValue: Boolean, productId: { type: Number, default: 0 }, orderId: { type: Number, default: 0 } });
const emit = defineEmits(['update:modelValue', 'saved']);
const visible = computed({ get: () => props.modelValue, set: value => emit('update:modelValue', value) });
const loading = ref(false), saving = ref(false), searching = ref(false);
const productId = ref(0), products = ref([]), targetProducts = ref([]), data = ref(null), target = ref(null);
const preview = ref(null), submission = ref(null), formVisible = ref(false);
const form = reactive({});
let loadVersion = 0;
const labels = {
  historical_purchase_bulk: '批量补齐历史采购',
  historical_purchase: '补历史采购', receive: '补确认收货', link_purchase: '关联已有收货',
  historical_source: '登记其他历史来源', substitute: '登记订单实际替代用料',
  convert: '库存商品转换', damage: '货损报废', loss: '货物丢失', stocktake: '本地盘点调整', revise_purchase: '纠正采购记录'
};
const movementLabels = { purchase_inbound: '采购入库', purchase_inbound_correction: '采购入库纠正', order_outbound: '订单出库',
  historical_receipt_offset: '历史收货已计入实物（抵消重复入库）',
  return_in: '实际退回入库', fbp_transfer_out: '转 FBP', reconciliation_convert: '转换出', reconciliation_convert_in: '转换入',
  substitution_restore: '替代用料：原商品冲回', substitution_out: '替代用料：实际消耗', reconciliation_damage: '货损报废',
  reconciliation_loss: '丢失', reconciliation_stocktake: '盘点调整', manual_outbound: '手动出库' };
const history = computed(() => (data.value?.orders || []).filter(row => row.entered_transport && (row.missing_record_quantity > 0 || row.missing_amount))
  .sort((a, b) => Number(b.order_id === props.orderId) - Number(a.order_id === props.orderId)));
const historicalCosts = computed(() => (data.value?.actions || []).flatMap(action => {
  const result = typeof action.result_json === 'string' ? JSON.parse(action.result_json) : action.result_json;
  return (result?.allocations || []).map(row => ({ ...row, purchase_order_id: result.purchase_order_id, created_at: action.created_at, person_name: action.person_name }));
}));
const selectedOrder = computed(() => data.value?.orders.find(row => row.order_item_id === form.order_item_id));
const needsTarget = computed(() => ['convert', 'substitute'].includes(form.action_type));
const needsMoney = computed(() => ['historical_purchase', 'revise_purchase'].includes(form.action_type));
const historyAction = computed(() => ['historical_purchase', 'historical_source', 'substitute', 'receive', 'link_purchase'].includes(form.action_type));
const batches = computed(() => (data.value?.batches || []).filter(row => row.status === (form.action_type === 'receive' ? 'pending_arrival' : 'approved'))
  .map(row => ({ ...row, selectable_quantity: Number(row.unallocated_quantity) + Number(selectedOrder.value?.receipt_claims?.find(claim => claim.batch_id === Number(row.id))?.quantity || 0) }))
  .filter(row => row.selectable_quantity > 0));
function time(value) { return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true }); }
async function search(text, isTarget = false) {
  searching.value = true;
  try {
    const result = await apiClient.get(`/api/products?${new URLSearchParams({ paged: '1', page: '1', pageSize: '30', query: text || '' })}`);
    (isTarget ? targetProducts : products).value = result.rows || [];
  } catch (error) { ElMessage.error(error.message); }
  finally { searching.value = false; }
}
async function load(id = productId.value) {
  const version = ++loadVersion;
  productId.value = Number(id);
  data.value = null;
  preview.value = null;
  formVisible.value = false;
  if (!id) return;
  loading.value = true;
  try {
    const result = await apiClient.get(`/api/procurement/ledger?product_id=${id}`, { noCache: true });
    if (version === loadVersion) data.value = result;
  } catch (error) { ElMessage.error(error.message); }
  finally { if (version === loadVersion) loading.value = false; }
}
async function selectTarget(id) {
  target.value = null;
  preview.value = null;
  try {
    const result = await apiClient.get(`/api/procurement/ledger?product_id=${id}`, { noCache: true });
    if (Number(form.target_product_id) === Number(id)) target.value = result;
  } catch (error) { ElMessage.error(error.message); }
}
function edit(type, row = null) {
  Object.keys(form).forEach(key => delete form[key]);
  Object.assign(form, { action_type: type, quantity: (type === 'receive' ? row?.missing_receipt_quantity : row?.missing_purchase_quantity) || row?.missing_record_quantity || row?.shortage_quantity || 1,
    order_item_id: row?.order_item_id || null, reason: '', amount: 0, shipping_amount: 0, purchased_at: '',
    inventory_effect: 'already_accounted', target_product_id: null, target_quantity: 1, counted_quantity: undefined, correct_received: false });
  if (type === 'revise_purchase') Object.assign(form, { purchase_item_id: row.id, quantity: Number(row.actual_quantity), amount: Number(row.amount), shipping_amount: Number(row.shipping_amount) });
  preview.value = null; submission.value = null; target.value = null; formVisible.value = true;
}
watch(form, () => { preview.value = null; submission.value = null; });
async function makePreview() {
  if (needsTarget.value && !target.value) return ElMessage.warning('请先选择实际库存商品');
  saving.value = true;
  try {
    const payload = { ...form, product_id: productId.value, revision: data.value.revision,
      target_revision: target.value?.revision, request_key: crypto.randomUUID() };
    preview.value = await apiClient.post('/api/procurement/ledger/preview', payload);
    submission.value = payload;
  } catch (error) { ElMessage.error(error.message); }
  finally { saving.value = false; }
}
async function save() {
  if (!submission.value || saving.value) return;
  saving.value = true;
  try {
    await apiClient.post('/api/procurement/ledger', submission.value);
    ElMessage.success('已保存对账记录，库存和历史缺口已重新计算');
    formVisible.value = false;
    await load();
    emit('saved');
  } catch (error) { ElMessage.error(error.message); }
  finally { saving.value = false; }
}
watch(() => props.modelValue, value => { if (value) { products.value = []; load(props.productId); search(''); } }, { immediate: true });
</script>

<template>
  <el-dialog v-model="visible" title="库存明细与历史核对" width="min(1400px, 96vw)" align-center destroy-on-close>
    <div class="ledger-toolbar">
      <el-select :model-value="productId || undefined" filterable remote :remote-method="search" :loading="searching" placeholder="搜索全部库存商品名称或编码" @change="load" style="width:460px">
        <el-option v-if="data && !products.some(p => Number(p.id) === productId)" :value="productId" :label="data.product.name" />
        <el-option v-for="p in products" :key="p.id" :value="Number(p.id)" :label="`${p.name} · ${p.code || p.inventory_id || ''}`" />
      </el-select>
      <el-button :disabled="!productId" @click="load()">刷新对账</el-button>
    </div>
    <div v-loading="loading">
      <template v-if="data">
        <div class="ledger-product"><el-image class="ledger-image" :src="`/api/products/${productId}/image?thumb=1&w=180`" fit="cover" :preview-src-list="[`/api/products/${productId}/image` ]" :initial-index="0" preview-teleported><template #error><span>无图</span></template></el-image><strong>{{ data.product.name }}</strong><span>{{ data.product.code }}</span></div>
        <el-alert type="info" :closable="false" title="实物推算已加回待发订单的提前扣减，以仓库盘点为准；负数不能当成真实实物。请先盘点校准，历史补采购只补记录，不增加现货或在途。" />
        <div class="ledger-toolbar"><el-button type="primary" plain @click="edit('stocktake')">核对现货／修正历史账面</el-button><span>采购成本已补齐但账面仍为负时，无需重复补采购；按实际盘点核对，保留历史差异流水。</span></div>
        <div class="ledger-metrics">
          <div><span>本地账面库存</span><strong>{{ data.local_stock }}</strong></div>
          <div><span>现货推算（以盘点为准）</span><strong>{{ Math.max(0, data.physical_estimate) }}</strong><small v-if="data.physical_estimate < 0">账面待核差异 {{ -data.physical_estimate }} 件</small></div>
          <div><span>当前订单现货覆盖 / 可用推算</span><strong>{{ data.current_stock_reserved }} / {{ data.available_estimate }}</strong></div>
          <div><span>已记录采购 / 已收货</span><strong>{{ data.purchase_quantity }} / {{ data.received_quantity }}</strong></div>
          <div><span>采购在途</span><strong>{{ data.incoming_quantity }}</strong></div>
          <div><span>当前订单待采购 / 在途覆盖</span><strong>{{ data.current_shortage }} / {{ data.current_incoming }}</strong></div>
          <div class="ledger-warning"><span>历史缺采购来源 / 收货待核</span><strong>{{ data.missing_purchase }} / {{ data.missing_receipt }}</strong></div>
        </div>
        <el-tabs>
          <el-tab-pane label="历史缺口与补录">
            <el-table :data="history" max-height="400" empty-text="没有历史来源缺口">
              <el-table-column label="订单" min-width="190"><template #default="{ row }">{{ row.posting_number }}<el-tag v-if="row.order_id === props.orderId" size="small">当前订单</el-tag></template></el-table-column>
              <el-table-column prop="quantity" label="已发件数" width="100" />
              <el-table-column prop="missing_purchase_quantity" label="缺采购来源" width="120" />
              <el-table-column prop="missing_receipt_quantity" label="收货待核" width="110" />
              <el-table-column label="处理" min-width="410"><template #default="{ row }">
                <template v-if="row.missing_record_quantity > 0">
                  <el-button v-if="row.missing_purchase_quantity > 0" link type="primary" @click="edit('historical_purchase', row)">补采购记录</el-button>
                  <el-button v-if="row.missing_receipt_quantity > 0" link type="primary" @click="edit('receive', row)">核对历史收货</el-button>
                  <el-button link type="primary" @click="edit('link_purchase', row)">关联收货</el-button>
                  <el-button link type="primary" @click="edit('substitute', row)">实际用了其他商品</el-button>
                  <el-button link @click="edit('historical_source', row)">其他来源</el-button>
                </template>
                <span v-if="row.missing_amount">金额待补，请在采购记录中纠正金额</span>
              </template></el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="当前订单库存替代">
            <el-alert type="info" :closable="false" title="从其他商品的本地现货中转换，直接覆盖所选当前订单；历史缺口保持独立，不需要虚构采购。" />
            <el-table :data="data.orders.filter(row => row.needs_fulfillment && row.shortage_quantity > 0)" max-height="400" empty-text="当前订单已覆盖">
              <el-table-column prop="posting_number" label="订单" /><el-table-column prop="shortage_quantity" label="待覆盖数量" />
              <el-table-column label="操作"><template #default="{ row }"><el-button link type="primary" @click="edit('substitute', row)">选择其他商品库存替代</el-button></template></el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="采购数量与金额纠正">
            <el-table :data="data.purchases" max-height="400">
              <el-table-column prop="order_no" label="采购单" min-width="160" />
              <el-table-column label="采购时间" width="180"><template #default="{ row }">{{ time(row.purchased_at) }}</template></el-table-column>
              <el-table-column prop="actual_quantity" label="采购数量" />
              <el-table-column prop="received_quantity" label="已收货" />
              <el-table-column prop="pending_quantity" label="待收货" />
              <el-table-column prop="amount" label="货款" />
              <el-table-column label="操作"><template #default="{ row }"><el-button link type="primary" @click="edit('revise_purchase', row)">纠正记录</el-button></template></el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="本地库存去向">
            <div class="ledger-toolbar"><el-button @click="edit('convert')">转换为其他商品库存</el-button><el-button @click="edit('damage')">货损报废</el-button><el-button @click="edit('loss')">货物丢失</el-button><el-button @click="edit('stocktake')">盘点调整／原因待查</el-button><el-button @click="visible = false; $router.push('/inventory/fbp')">核对 FBP 调拨</el-button></div>
            <el-alert type="info" :closable="false" title="本地余额 = 期初及调整 + 采购实收 + 实际退回 + 转换入 − 订单出库 − 转 FBP − 转换出 − 损失。漏记 FBP 调拨请补调拨记录，不以盘亏代替。" />
            <el-table :data="data.movements" max-height="330"><el-table-column label="流水类型"><template #default="{ row }">{{ movementLabels[row.source_type] || row.source_type }}</template></el-table-column><el-table-column label="仓位"><template #default="{ row }">{{ row.stock_location === 'FBP' ? 'FBP（不计本地）' : '本地' }}</template></el-table-column><el-table-column prop="quantity_delta" label="累计变动数量" /></el-table>
          </el-tab-pane>
          <el-tab-pane label="纠正记录">
            <el-table :data="data.actions" max-height="400"><el-table-column label="北京时间" width="180"><template #default="{ row }">{{ time(row.created_at) }}</template></el-table-column><el-table-column label="操作" width="180"><template #default="{ row }">{{ labels[row.action_type] }}</template></el-table-column><el-table-column prop="person_name" label="操作人" width="110" /><el-table-column prop="reason" label="原因／凭证" /></el-table>
          </el-tab-pane>
          <el-tab-pane label="历史补录成本（最近50次操作）">
            <el-table :data="historicalCosts" max-height="400" empty-text="暂无批量补齐记录">
              <el-table-column prop="posting_number" label="历史订单" min-width="180" />
              <el-table-column prop="purchase_order_id" label="采购单 ID" width="110" />
              <el-table-column prop="quantity" label="补齐数量" />
              <el-table-column prop="amount" label="分摊货款（元）" />
              <el-table-column prop="shipping_amount" label="分摊运费（元）" />
              <el-table-column prop="person_name" label="操作人" />
              <el-table-column label="补录时间（北京时间）" min-width="180"><template #default="{ row }">{{ time(row.created_at) }}</template></el-table-column>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </template>
      <el-empty v-else-if="!loading" description="请选择商品；没有当前采购任务的商品也可以对账" />
    </div>
    <el-dialog v-if="formVisible" v-model="formVisible" :title="labels[form.action_type]" width="720px" append-to-body :close-on-click-modal="false">
      <el-form label-width="150px" :disabled="saving">
        <el-form-item v-if="historyAction" label="关联订单">{{ selectedOrder?.posting_number }} · 待核／待覆盖 {{ selectedOrder?.entered_transport ? selectedOrder?.missing_record_quantity : selectedOrder?.shortage_quantity }} 件</el-form-item>
        <el-form-item v-if="form.action_type !== 'stocktake'" :label="form.action_type === 'revise_purchase' ? '纠正后采购数量' : '本商品数量'"><el-input-number v-model="form.quantity" :min="form.action_type === 'revise_purchase' ? 0 : 1" :precision="0" /></el-form-item>
        <el-form-item v-if="['receive', 'link_purchase'].includes(form.action_type)" label="已有采购收货批次"><el-select v-model="form.inbound_id" style="width:100%"><el-option v-for="batch in batches" :key="batch.id" :value="Number(batch.id)" :label="`${batch.purchase_order_no || '采购批次'} #${batch.id} · 可关联 ${batch.selectable_quantity} 件`" /></el-select></el-form-item>
        <el-form-item v-if="form.action_type === 'historical_purchase'" label="实际采购时间"><el-date-picker v-model="form.purchased_at" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss+08:00" placeholder="北京时间" /></el-form-item>
        <el-form-item v-if="form.action_type === 'historical_purchase'" label="库存影响">只补历史采购来源，不增加现货或在途。实物与账面不符请单独盘点核对。</el-form-item>
        <el-form-item v-if="form.action_type === 'receive'" label="库存影响"><el-radio-group v-model="form.inventory_effect"><el-radio value="already_accounted">实物已计入盘点／账面，只补收货记录</el-radio><el-radio value="missing_inbound">确认漏记入库，增加账面数量</el-radio></el-radio-group></el-form-item>
        <template v-if="needsMoney"><el-form-item label="实际货款"><el-input-number v-model="form.amount" :min="0" :precision="2" /><span>金额未知填 0，保留待补状态</span></el-form-item><el-form-item label="实际运费"><el-input-number v-model="form.shipping_amount" :min="0" :precision="2" /></el-form-item></template>
        <el-form-item v-if="form.action_type === 'revise_purchase'" label="入库记录"><el-checkbox v-model="form.correct_received">入库也录多了，同步纠正多记的入库</el-checkbox></el-form-item>
        <template v-if="needsTarget"><el-form-item :label="form.action_type === 'substitute' ? '实际使用来源商品' : '转换目标商品'"><el-select v-model="form.target_product_id" filterable remote :remote-method="value => search(value, true)" @change="selectTarget" style="width:100%"><el-option v-for="p in targetProducts" :key="p.id" :value="Number(p.id)" :label="`${p.name} · ${p.code || ''}`" /></el-select></el-form-item><el-form-item :label="form.action_type === 'substitute' ? '来源实际消耗数量' : '目标入库数量'"><el-input-number v-model="form.target_quantity" :min="1" :precision="0" /><span v-if="target">该商品本地库存 {{ target.local_stock }}</span></el-form-item></template>
        <el-form-item v-if="form.action_type === 'stocktake'" label="本地实际盘点数量"><el-input-number v-model="form.counted_quantity" placeholder="无实物请填 0" :min="0" :precision="0" /></el-form-item>
        <el-alert v-if="form.action_type === 'stocktake'" type="warning" :closable="false" :title="`当前实物推算 ${data.physical_estimate} 件（含待发订单提前扣减的加回）；请填写仓库全部实物，包含已经分配给待发订单的货。历史缺记录不会被清除。`" />
        <el-form-item label="原因／凭证"><el-input v-model="form.reason" type="textarea" :rows="3" maxlength="1000" placeholder="说明实际采购、来源商品、使用去向或盘点差异；暂不清楚可填原因待查及盘点依据" /></el-form-item>
      </el-form>
      <el-alert v-if="preview" type="warning" :closable="false" :title="`本地账面库存：${preview.local_before} → ${preview.local_after}${needsTarget ? `；另一商品库存：${preview.target_before} → ${preview.target_after}` : ''}`" :description="form.action_type === 'revise_purchase' ? '采购、收货及关联订单覆盖将同步重算；负库存保留为待核差异，不自动补采购。' : '历史补录只解释所选订单来源；不会新增一笔当前待采购任务。'" />
      <el-alert v-if="preview && form.action_type === 'stocktake'" type="info" :closable="false" :title="`核对后现货 ${preview.physical_after} 件；账面仍保留待发订单已扣数量，因此不一定为 0。采购成本与在途不变，历史收货待核不会自动清除。`" />
      <el-table v-if="preview?.affected_orders?.length" :data="preview.affected_orders" max-height="180"><el-table-column prop="posting_number" label="覆盖减少的订单" /><el-table-column prop="before" label="原关联数量" /><el-table-column prop="after" label="纠正后关联数量" /></el-table>
      <template #footer><el-button :disabled="saving" @click="formVisible = false">取消</el-button><el-button :loading="saving" @click="makePreview">预览影响</el-button><el-button type="primary" :disabled="!preview" :loading="saving" @click="save">确认保存纠正记录</el-button></template>
    </el-dialog>
  </el-dialog>
</template>
<style scoped>
.ledger-toolbar,.ledger-product { display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap; }
.ledger-image { width:64px;height:84px;flex:none;display:flex;align-items:center;justify-content:center;background:#f5f7fa; }
.ledger-metrics { display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:16px 0; }
.ledger-metrics > div { display:grid;gap:8px;padding:14px;background:#f5f7fa;border-radius:8px; }
.ledger-metrics span { color:#606266;font-size:12px; }.ledger-metrics strong { font-size:22px; }.ledger-warning strong { color:#b45309; }
@media(max-width:900px) { .ledger-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } }
</style>
