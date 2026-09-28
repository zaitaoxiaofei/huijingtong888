<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiClient } from '../../utils/api.js';
import { shanghaiDateKey, shanghaiDateTimeText } from '../../utils/shanghai-date.js';
import InventoryIdentity from '../../../orders/components/InventoryIdentity.vue';
import { inventoryAdjustmentReasons, validateInventoryAdjustment } from '../../../../src/inventory-adjustment-reasons.js';
const props = defineProps({ modelValue: Boolean, productId: { type: Number, default: 0 }, orderId: { type: Number, default: 0 }, initialTab: { type: String, default: 'current' }, orderOverview: { type: Object, default: null }, orderLabel: { type: String, default: '' } });
const emit = defineEmits(['update:modelValue', 'saved']);
const visible = computed({ get: () => props.modelValue, set: value => emit('update:modelValue', value) });
const loading = ref(false), saving = ref(false), searching = ref(false);
const productId = ref(0), products = ref([]), targetProducts = ref([]), data = ref(null), target = ref(null);
const preview = ref(null), submission = ref(null), formVisible = ref(false);
const form = reactive({});
const activeTab = ref('current');
const purchaseFilter = ref('all');
const purchaseRows = computed(() => [...(data.value?.purchases || [])]
  .filter(row => purchaseFilter.value !== 'incoming' || Number(row.pending_quantity) > 0)
  .sort((a, b) => String(b.purchased_at || '').localeCompare(String(a.purchased_at || '')) || Number(b.id) - Number(a.id)));
const countDelta = computed(() => form.counted_quantity == null ? null : Number(form.counted_quantity) - Number(data.value?.physical_estimate || 0));
const countReasons = computed(() => inventoryAdjustmentReasons.filter(reason => reason.direction === 'any'
  || (reason.direction === 'decrease' && countDelta.value < 0)
  || (reason.direction === 'increase' && countDelta.value >= 0)
  || (reason.direction === 'same' && countDelta.value === 0)));
function showPurchases(filter = 'all') { purchaseFilter.value = filter; activeTab.value = 'purchases'; }
function startConversion() {
  const quantity = countDelta.value < 0 ? -countDelta.value : 1;
  edit('convert');
  form.quantity = quantity;
  form.reason = '库存转换';
}
const managementVisible = ref(false), loadError = ref('');
const currentOrders = computed(() => (data.value?.orders || []).filter(row => row.needs_fulfillment)
  .sort((a, b) => Number(b.order_id === props.orderId) - Number(a.order_id === props.orderId)));
const orderItems = computed(() => (props.orderOverview?.items || []).map(item => {
  if (!props.orderOverview.active || Number(item.product_id) !== productId.value || !data.value) return item;
  const matches = data.value.orders.filter(row => row.order_id === props.orderId && row.needs_fulfillment);
  if (!matches.length) return item;
  return { ...item, ...Object.fromEntries(['quantity', 'stock_quantity', 'incoming_quantity', 'shortage_quantity'].map(key =>
    [key, matches.some(row => row[key] == null) ? undefined : matches.reduce((sum, row) => sum + Number(row[key]), 0)])),
    quantity_needs_review: matches.some(row => row.quantity_needs_review) };
}));
const pendingCosts = computed(() => (data.value?.cost_tasks || []).filter(row => Number(row.quantity) > Number(row.resolved_quantity)));
let loadVersion = 0;
const labels = {
  set_priority: '调整现货分配优先级', link_stock_cost: '关联已有采购成本',
  record_purchase: '补现货采购成本',
  historical_purchase_bulk: '批量补齐历史采购',
  historical_purchase: '补历史采购', receive: '补确认收货', link_purchase: '关联已有收货',
  historical_source: '登记其他历史来源', substitute: '登记订单实际替代用料',
  convert: '库存商品转换', damage: '货损报废', loss: '货物丢失', stocktake: '更新本地库存', revise_purchase: '纠正采购记录'
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
const needsMoney = computed(() => ['historical_purchase', 'revise_purchase', 'record_purchase'].includes(form.action_type));
const historyAction = computed(() => ['historical_purchase', 'historical_source', 'substitute', 'receive', 'link_purchase'].includes(form.action_type));
const batches = computed(() => (data.value?.batches || []).filter(row => row.status === (form.action_type === 'receive' ? 'pending_arrival' : 'approved'))
  .map(row => ({ ...row, selectable_quantity: Number(row.unallocated_quantity) + Number(selectedOrder.value?.receipt_claims?.find(claim => claim.batch_id === Number(row.id))?.quantity || 0) }))
  .filter(row => row.selectable_quantity > 0));
function time(value) { return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true }); }
function actionSummary(action) {
  const result = typeof action.result_json === 'string' ? JSON.parse(action.result_json) : action.result_json;
  if (!result) return '—';
  if (result.physical_before != null && result.physical_after != null) return `本地库存 ${result.physical_before} → ${result.physical_after}（${result.stocktake_delta > 0 ? '+' : ''}${result.stocktake_delta}）${result.cost_task_quantity ? `；待补采购记录 ${result.cost_task_quantity} 件` : ''}`;
  if (action.action_type === 'set_priority') return `订单明细 #${result.order_item_id}：${result.priority ? '优先分配' : '恢复默认顺序'}`;
  if (result.cost_task_id) return `成本任务 #${result.cost_task_id}：核对 ${result.quantity} 件，不增加库存`;
  return [`主库存账面 ${result.local_before} → ${result.local_after}`,
    ...(result.extra_sources || []).map(row => `配件库存 #${row.product_id}：-${row.quantity}`),
    ...(result.target_product_id ? [`目标／替代库存 #${result.target_product_id}：${result.target_delta}`] : []),
    ...(result.cost_task_quantity ? [`生成成本核对 ${result.cost_task_quantity} 件`] : [])].join('；');
}
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
  if (Number(id) !== productId.value || !id) data.value = null;
  productId.value = Number(id);
  preview.value = null;
  formVisible.value = false;
  loadError.value = '';
  if (!id) { loading.value = false; return; }
  loading.value = true;
  try {
    const result = await apiClient.get(`/api/procurement/ledger?product_id=${id}`, { noCache: true });
    if (version === loadVersion) data.value = result;
  } catch (error) { if (version === loadVersion) { data.value = null; loadError.value = error.message; } }
  finally { if (version === loadVersion) loading.value = false; }
}
async function discardForm() {
  if (saving.value) return false;
  if (!formVisible.value) return true;
  try { await ElMessageBox.confirm('当前填写内容尚未保存，确定放弃吗？', '未保存的修改', { confirmButtonText: '放弃修改', cancelButtonText: '继续填写', type: 'warning' }); }
  catch { return false; }
  formVisible.value = false;
  return true;
}
async function changeProduct(id) {
  if (Number(id) === productId.value || !await discardForm()) return;
  managementVisible.value = false;
  await load(id);
}
async function closeDetail(done) { if (await discardForm()) { ++loadVersion; done(); } }
async function closeForm(done) { if (await discardForm()) done(); }
function moreAction(command) {
  if (command === 'management') managementVisible.value = !managementVisible.value;
  else edit(command);
}
async function selectTarget(id) {
  target.value = null;
  preview.value = null;
  try {
    const result = await apiClient.get(`/api/procurement/ledger?product_id=${id}`, { noCache: true });
    if (Number(form.target_product_id) === Number(id)) target.value = result;
  } catch (error) { ElMessage.error(error.message); }
}
async function selectSource(row, id) {
  row.revision = '';
  row.available = undefined;
  try {
    const result = await apiClient.get(`/api/procurement/ledger?product_id=${id}`, { noCache: true });
    if (row.product_id === id) Object.assign(row, { revision: result.revision, available: result.available_estimate, product_name: result.product.name });
  } catch (error) { ElMessage.error(error.message); }
}
function editCost(type, row) {
  edit(type);
  Object.assign(form, { cost_task_id: Number(row.id), quantity: Number(row.quantity) - Number(row.resolved_quantity) });
}
function edit(type, row = null) {
  Object.keys(form).forEach(key => delete form[key]);
  Object.assign(form, { action_type: type, quantity: (type === 'receive' ? row?.missing_receipt_quantity : row?.missing_purchase_quantity) || row?.missing_record_quantity || row?.shortage_quantity || 1,
    order_item_id: row?.order_item_id || null, reason: '', reason_code: '', reason_note: '', amount: 0, shipping_amount: 0, purchased_at: `${shanghaiDateKey()}T00:00:00+08:00`,
    inventory_effect: 'already_accounted', target_product_id: null, target_quantity: 1, counted_quantity: undefined, correct_received: false,
    extra_sources: [], priority: row?.allocation_priority ? 0 : 1 });
  if (type === 'revise_purchase') Object.assign(form, { purchase_item_id: row.id, quantity: Number(row.actual_quantity), amount: Number(row.amount), shipping_amount: Number(row.shipping_amount) });
  preview.value = null; submission.value = null; target.value = null; formVisible.value = true;
}
watch(form, () => { preview.value = null; submission.value = null; });
async function makePreview() {
  if (form.action_type === 'stocktake') {
    if (form.counted_quantity == null) return ElMessage.warning('请输入实际清点数量；没有实物请填 0');
    try { validateInventoryAdjustment(form.reason_code, form.reason_note, countDelta.value); }
    catch (error) { return ElMessage.warning(error.message); }
  }
  if (needsTarget.value && !target.value) return ElMessage.warning('请先选择实际库存商品');
  if (form.extra_sources?.some(row => !row.revision)) return ElMessage.warning('请选择配件库存并等待现货信息加载完成');
  saving.value = true;
  try {
    const payload = { ...form, extra_sources: (form.extra_sources || []).map(({ product_id, quantity, revision }) => ({ product_id, quantity, revision })), product_id: productId.value, revision: data.value.revision,
      target_revision: target.value?.revision, request_key: crypto.randomUUID() };
    preview.value = await apiClient.post('/api/procurement/ledger/preview', payload);
    submission.value = payload;
  } catch (error) { ElMessage.error(error.message); }
  finally { saving.value = false; }
}
async function confirmStock() {
  await makePreview();
  if (!submission.value) return;
  try {
    const occupied = Number(data.value.current_stock_reserved || 0) + Number(data.value.fbp_reserved || 0);
    const warning = Number(form.counted_quantity) < occupied ? ` 当前订单和 FBP 已占用 ${occupied} 件，更新后库存不足，需复核分配和备货。` : '';
    await ElMessageBox.confirm(`本地库存 ${preview.value.physical_before} → ${preview.value.physical_after}。原因：${validateInventoryAdjustment(form.reason_code, form.reason_note, countDelta.value)}。保存后重新计算订单覆盖；采购在途不变。${warning}`, '确认更新本地库存', { confirmButtonText: '确认更新', cancelButtonText: '继续填写', type: 'warning' });
  } catch { return; }
  await save();
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
watch(() => props.modelValue, value => { if (value) { activeTab.value = ['current', 'purchases', 'history'].includes(props.initialTab) ? props.initialTab : 'current'; products.value = []; load(props.productId); if (!props.orderOverview) search(''); } else ++loadVersion; }, { immediate: true });
</script>

<template>
  <el-dialog v-model="visible" title="库存明细与历史核对" width="min(1400px, 96vw)" top="4vh" append-to-body destroy-on-close :before-close="closeDetail" :close-on-click-modal="false" class="unified-inventory-dialog">
    <section v-if="orderOverview" class="ledger-order-summary">
      <h3>本单需求与覆盖 <small>{{ orderLabel }}</small></h3>
      <InventoryIdentity v-if="orderOverview.parents?.length" :parents="orderOverview.parents" />
      <p>点击库存行，下方直接切换详情；不同子产品的件数不合并相加。</p>
      <el-table :data="orderItems" row-key="product_id" max-height="290" :row-class-name="({ row }) => Number(row.product_id) === productId ? 'selected-inventory-row' : ''" @row-click="row => changeProduct(row.product_id)">
        <el-table-column label="库存产品" min-width="320"><template #default="{ row }"><div class="ledger-product ledger-order-product">
          <el-image class="ledger-image" :src="`/api/products/${row.product_id}/image?thumb=1&w=180`" fit="cover" :preview-src-list="[`/api/products/${row.product_id}/image`]" :initial-index="0" preview-teleported @click.stop><template #error>无图</template></el-image>
          <div><el-button link type="primary" class="ledger-product-select" @click.stop="changeProduct(row.product_id)">{{ row.product_name }}</el-button><p>库存 ID：{{ row.inventory_number || '—' }} <el-tag v-if="Number(row.product_id) === productId" size="small">当前查看</el-tag></p></div>
        </div></template></el-table-column>
        <el-table-column prop="quantity" label="本单需求" width="110" />
        <el-table-column label="现货覆盖" width="110"><template #default="{ row }">{{ orderOverview.active ? row.stock_quantity ?? '待核' : '—' }}</template></el-table-column>
        <el-table-column label="在途覆盖" width="110"><template #default="{ row }">{{ orderOverview.active ? row.incoming_quantity ?? '待核' : '—' }}</template></el-table-column>
        <el-table-column label="还需采购" width="110"><template #default="{ row }"><strong :class="{ 'ledger-shortage': row.shortage_quantity > 0 }">{{ orderOverview.active ? (row.quantity_needs_review ? '待核' : row.shortage_quantity ?? '待核') : '—' }}</strong></template></el-table-column>
      </el-table>
    </section>
    <div class="ledger-toolbar">
      <el-select v-if="!orderOverview" :model-value="productId || undefined" filterable remote :remote-method="search" :loading="searching" placeholder="搜索全部库存商品名称或编码" @change="changeProduct" style="width:460px">
        <el-option v-if="data && !products.some(p => Number(p.id) === productId)" :value="productId" :label="data.product.name" />
        <el-option v-for="p in products" :key="p.id" :value="Number(p.id)" :label="`${p.name} · ${p.code || p.inventory_id || ''}`" />
      </el-select>
      <strong v-else class="ledger-scope">库存汇总</strong>
      <div class="ledger-top-actions">
        <el-button type="primary" plain :disabled="!data || loading" @click="edit('stocktake')">更新本地库存</el-button>
        <el-button :disabled="!data || loading" @click="edit('convert')">库存转换</el-button>
        <el-dropdown @command="moreAction"><el-button>更多操作</el-button><template #dropdown><el-dropdown-menu>
          <el-dropdown-item v-if="$slots.management" command="management">绑定管理</el-dropdown-item>
          <el-dropdown-item command="damage" :disabled="!data || loading">货损报废</el-dropdown-item>
          <el-dropdown-item command="loss" :disabled="!data || loading">货物丢失</el-dropdown-item>
        </el-dropdown-menu></template></el-dropdown>
        <el-button :disabled="!productId || loading" @click="load()">刷新对账</el-button>
      </div>
    </div>
    <section v-if="managementVisible" class="ledger-management"><slot name="management" /></section>
    <el-alert v-if="loadError" type="error" :closable="false" title="库存明细加载失败，请点击刷新对账重试" :description="loadError" />
    <div v-loading="loading">
      <template v-if="data">
        <div class="ledger-product"><el-image v-if="!orderOverview" class="ledger-image" :src="`/api/products/${productId}/image?thumb=1&w=180`" fit="cover" :preview-src-list="[`/api/products/${productId}/image` ]" :initial-index="0" preview-teleported><template #error><span>无图</span></template></el-image><strong>{{ data.product.name }}</strong><span>库存 ID：{{ data.product.inventory_number || orderItems.find(item => Number(item.product_id) === productId)?.inventory_number || '—' }}</span><span>{{ data.product.code }}</span></div>
        <div class="ledger-metric-groups"><section><h3>本地实物与占用</h3>
        <div class="ledger-metrics">
          <div><span>本地库存</span><strong>{{ Math.max(0, data.physical_estimate) }}</strong><small>{{ data.last_stocktake_at ? `最近核实：${time(data.last_stocktake_at)}` : data.stocktake_id ? '已盘点，时间待核' : '未盘点' }}</small></div>
          <div><span>订单占用</span><strong>{{ data.current_stock_reserved }}</strong><small>全部待履约本地订单</small></div>
          <div><span>FBP 待发占用</span><strong>{{ data.fbp_reserved ?? '待核' }}</strong><small>审核通过占用，调减释放</small></div>
          <div><span>剩余可用</span><strong>{{ data.available_estimate }}</strong><small>已扣订单及 FBP 占用</small></div>
        </div></section><section><h3>采购与缺口</h3><div class="ledger-metrics">
          <div><span>采购在途</span><el-button link type="primary" @click="showPurchases('incoming')"><strong>{{ data.incoming_quantity }}</strong></el-button><small>点击查看待收采购</small></div>
          <div><span>在途已分配</span><strong>{{ data.current_incoming }}</strong></div>
          <div :class="{ 'ledger-shortage': data.current_shortage > 0 }"><span>全部待履约订单待采购</span><strong>{{ data.current_shortage }}</strong><small>历史缺记录不计入此数</small></div>
        </div></section></div>
        <div v-if="pendingCosts.length || data.current_shortage > 0" class="ledger-toolbar">
          <el-button v-if="pendingCosts.length" type="warning" plain @click="showPurchases()">补采购记录（{{ pendingCosts.length }} 项待核）</el-button>
          <el-button v-if="data.current_shortage > 0" type="primary" plain @click="visible = false; $router.push('/procurement/workspace')">处理采购缺口（{{ data.current_shortage }} 件）</el-button>
        </div>
        <div class="ledger-toolbar" v-if="data.fbp_inventory">
          <strong>FBP 库存汇总：{{ data.fbp_inventory.incomplete ? '待核对' : data.fbp_inventory.present }} {{ data.product.stock_unit || '库存单位' }}</strong>
          <el-button type="primary" plain @click="activeTab = 'fbp'">查看各店铺 SKU 库存</el-button>
        </div>
        <el-tabs v-model="activeTab">
          <el-tab-pane v-if="data.fbp_inventory" label="FBP 库存" name="fbp" lazy>
            <p>直接读取 Ozon 同步库存，不重复扣订单。汇总已按每套组成折算为当前库存的实物单位；不同店铺、SKU 库存独立，不能互相抵扣。</p>
            <el-alert v-if="data.fbp_inventory.incomplete" type="warning" :closable="false" :title="`存在未同步或未绑定的 SKU，汇总不完整；已同步部分 ${data.fbp_inventory.present ?? 0}，请到 FBP 库存页面同步并核对绑定。`" />
            <el-table :data="data.fbp_inventory.rows" max-height="360" empty-text="暂无已绑定的 FBP SKU" :row-class-name="({ row }) => orderOverview?.shopId === Number(row.shop_id) && orderOverview?.skus.includes(String(row.ozon_sku)) ? 'current-fbp-sku' : ''">
              <el-table-column prop="shop_name" label="店铺" min-width="130" />
              <el-table-column label="Ozon SKU" min-width="150"><template #default="{ row }">{{ row.ozon_sku }}<el-tag v-if="orderOverview?.shopId === Number(row.shop_id) && orderOverview?.skus.includes(String(row.ozon_sku))" size="small">本单 SKU</el-tag></template></el-table-column>
              <el-table-column prop="product_name" label="商品规格" min-width="190" />
              <el-table-column prop="warehouse_name" label="FBP 仓库" min-width="130" />
              <el-table-column label="库存／可售（套）" width="140"><template #default="{ row }">{{ row.present ?? '待同步' }} / {{ row.available ?? '待同步' }}</template></el-table-column>
              <el-table-column label="每套含当前库存" width="130"><template #default="{ row }">{{ row.per_set_quantity }}</template></el-table-column>
              <el-table-column label="折算实物库存" width="125"><template #default="{ row }">{{ row.inventory_quantity ?? '待同步' }}</template></el-table-column>
              <el-table-column label="同步时间（北京）" min-width="180"><template #default="{ row }">{{ row.synced_at ? time(row.synced_at) : '待同步' }}</template></el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="订单分配" name="current" lazy>
            <p>现货覆盖表示已分配给订单的数量，不等于仓库总现货。包含已分拣、已打包但尚未进入运输的订单。</p>
            <el-table :data="currentOrders" max-height="400" empty-text="暂无待履约的本地订单">
              <el-table-column label="订单" min-width="190"><template #default="{ row }">{{ row.posting_number }} <el-tag v-if="row.order_id === props.orderId" size="small">当前订单</el-tag></template></el-table-column>
              <el-table-column label="下单时间" min-width="175"><template #default="{ row }">{{ time(row.ordered_at) }}</template></el-table-column>
              <el-table-column prop="quantity" label="需求" width="90" />
              <el-table-column prop="stock_quantity" label="现货覆盖" width="110" />
              <el-table-column prop="incoming_quantity" label="在途覆盖" width="110" />
              <el-table-column label="待采购" width="110"><template #default="{ row }"><strong class="ledger-shortage">{{ row.quantity_needs_review ? '数量待核' : row.shortage_quantity }}</strong></template></el-table-column>
              <el-table-column label="核对" min-width="200"><template #default="{ row }"><span v-if="row.quantity_needs_review">请核对已有采购数量，避免重复采购</span><span v-else-if="row.shortage_quantity > 0">返回订单或采购工作台采购</span><span v-else>已覆盖，无需重复采购</span></template></el-table-column>
              <el-table-column label="操作" width="210"><template #default="{ row }"><el-button size="small" :type="row.allocation_priority ? 'warning' : 'primary'" plain @click="edit('set_priority', row)">{{ row.allocation_priority ? '恢复默认顺序' : '优先分配' }}</el-button><el-button v-if="row.shortage_quantity > 0" size="small" plain @click="edit('substitute', row)">库存替代</el-button></template></el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="采购与成本" name="purchases" lazy>
            <h3>盘点现货成本待核（{{ pendingCosts.length }}）</h3>
            <p>盘点不要求库管填写金额。已有采购请关联；确实漏记才补录成本。货物后续发出不影响这些核对任务。</p>
            <el-table :data="pendingCosts" max-height="230" empty-text="暂无待核成本任务">
              <el-table-column label="任务" width="85"><template #default="{ row }">#{{ row.id }}</template></el-table-column>
              <el-table-column label="盘点时间" min-width="175"><template #default="{ row }">{{ time(row.created_at) }}</template></el-table-column>
              <el-table-column label="待核数量" width="100"><template #default="{ row }">{{ Number(row.quantity) - Number(row.resolved_quantity) }}</template></el-table-column>
              <el-table-column prop="reason" label="盘点说明" min-width="150" />
              <el-table-column label="处理" min-width="240"><template #default="{ row }"><el-button type="primary" plain size="small" @click="editCost('link_stock_cost', row)">关联已有采购</el-button><el-button plain size="small" @click="editCost('record_purchase', row)">补录缺失成本</el-button></template></el-table-column>
            </el-table>
            <p>已记录采购 {{ data.purchase_quantity }} 件 · 已收货 {{ data.received_quantity }} 件。补成本与实物入库分开处理，不重复增加现货。</p>
            <div class="ledger-toolbar"><el-button type="primary" plain @click="edit('record_purchase')">补现货采购成本</el-button><el-button @click="visible = false; $router.push('/purchase-history')">登记采购实收</el-button><span>已有采购到货请登记实收，不重复补采购；已盘点计入现货的，请先核对收货记录，避免再次增加库存。</span></div>
            <el-radio-group v-model="purchaseFilter"><el-radio-button value="all">全部采购</el-radio-button><el-radio-button value="incoming">采购在途</el-radio-button></el-radio-group>
            <el-table :data="purchaseRows" max-height="400" empty-text="暂无符合条件的采购记录">
              <el-table-column prop="order_no" label="采购单" min-width="160" />
              <el-table-column label="采购时间" width="180"><template #default="{ row }">{{ time(row.purchased_at) }}</template></el-table-column>
              <el-table-column prop="actual_quantity" label="采购数量" />
              <el-table-column prop="received_quantity" label="已收货" />
              <el-table-column prop="pending_quantity" label="待收货" />
              <el-table-column prop="person_name" label="采购人" />
              <el-table-column label="状态"><template #default="{ row }">{{ Number(row.pending_quantity) > 0 ? '采购在途' : '已收货' }}</template></el-table-column>
              <el-table-column prop="amount" label="货款" />
              <el-table-column label="操作"><template #default="{ row }"><el-button link type="primary" @click="edit('revise_purchase', row)">纠正记录</el-button></template></el-table-column>
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="历史核对" name="history" lazy>
            <p>本地账面余额 {{ data.local_stock }} 件<span v-if="data.physical_estimate < 0"> · 账面待核差异 {{ -data.physical_estimate }} 件</span>。不等于真实现货，也不计入本次待采购；实物不符请核对现货，不要重复补采购。</p>
            <el-alert type="warning" :closable="false" :title="`历史缺采购来源 ${data.missing_purchase} 件 · 收货待核 ${data.missing_receipt} 件；仅核对已发订单，不增加当前采购需求。`" />
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
            <el-collapse><el-collapse-item title="历史补录成本（最近50次操作）" name="history-costs">
              <el-table :data="historicalCosts" max-height="300" empty-text="暂无批量补齐记录">
                <el-table-column prop="posting_number" label="历史订单" min-width="180" />
                <el-table-column prop="purchase_order_id" label="采购单 ID" width="110" />
                <el-table-column prop="quantity" label="补齐数量" />
                <el-table-column prop="amount" label="分摊货款（元）" />
                <el-table-column prop="shipping_amount" label="分摊运费（元）" />
                <el-table-column prop="person_name" label="操作人" />
                <el-table-column label="补录时间（北京时间）" min-width="180"><template #default="{ row }">{{ time(row.created_at) }}</template></el-table-column>
              </el-table>
            </el-collapse-item></el-collapse>
          </el-tab-pane>
          <el-tab-pane label="库存流水" name="movements" lazy>
            <el-button link type="primary" @click="activeTab = 'actions'">查看调整明细：操作人、原因和前后数量</el-button>
            <p>本地账面余额：{{ data.local_stock }} 件。以下为按来源汇总的累计变动，不是实物盘点数量。</p>
            <div class="ledger-toolbar"><el-button @click="visible = false; $router.push('/inventory/fbp')">核对 FBP 调拨</el-button></div>
            <el-alert type="info" :closable="false" title="本地余额 = 期初及调整 + 采购实收 + 实际退回 + 转换入 − 订单出库 − 转 FBP − 转换出 − 损失。漏记 FBP 调拨请补调拨记录，不以盘亏代替。" />
            <el-table :data="data.movements" max-height="330"><el-table-column label="流水类型"><template #default="{ row }">{{ movementLabels[row.source_type] || row.source_type }}</template></el-table-column><el-table-column label="仓位"><template #default="{ row }">{{ row.stock_location === 'FBP' ? 'FBP（不计本地）' : '本地' }}</template></el-table-column><el-table-column prop="quantity_delta" label="累计变动数量" /></el-table>
          </el-tab-pane>
          <el-tab-pane label="操作记录" name="actions" lazy>
            <el-table :data="data.actions" max-height="400"><el-table-column label="北京时间" width="180"><template #default="{ row }">{{ time(row.created_at) }}</template></el-table-column><el-table-column label="操作" width="180"><template #default="{ row }">{{ labels[row.action_type] }}</template></el-table-column><el-table-column prop="person_name" label="操作人" width="110" /><el-table-column label="变动内容" min-width="260"><template #default="{ row }">{{ actionSummary(row) }}</template></el-table-column><el-table-column prop="reason" label="原因／凭证" /></el-table>
          </el-tab-pane>
        </el-tabs>
      </template>
      <el-empty v-else-if="!loading && !loadError" :description="orderOverview ? '没有已绑定的库存商品，请通过更多操作中的绑定管理核对' : '请选择商品；没有当前采购任务的商品也可以对账'" />
    </div>
    <el-dialog v-if="formVisible" v-model="formVisible" :title="labels[form.action_type]" width="720px" append-to-body :close-on-click-modal="false" :before-close="closeForm">
      <el-form label-width="150px" :disabled="saving">
        <el-form-item v-if="historyAction" label="关联订单">{{ selectedOrder?.posting_number }} · 待核／待覆盖 {{ selectedOrder?.entered_transport ? selectedOrder?.missing_record_quantity : selectedOrder?.shortage_quantity }} 件</el-form-item>
        <el-form-item v-if="!['stocktake', 'set_priority'].includes(form.action_type)" :label="form.action_type === 'revise_purchase' ? '纠正后采购数量' : '本商品数量'"><el-input-number v-model="form.quantity" :min="form.action_type === 'revise_purchase' ? 0 : 1" :precision="0" /></el-form-item>
        <template v-if="form.action_type === 'set_priority'">
          <el-form-item label="订单">{{ selectedOrder?.posting_number }}</el-form-item>
          <el-form-item label="分配方式"><el-radio-group v-model="form.priority"><el-radio :value="1">优先分配</el-radio><el-radio :value="0">恢复按下单时间</el-radio></el-radio-group></el-form-item>
          <el-alert type="warning" :closable="false" title="将重新分配本库存未发订单的现货，可能释放其他订单的现货覆盖；不会抢占 FBP 预留或更改采购在途关联。同为优先订单时仍按下单时间排序，必须填写原因。" />
        </template>
        <el-form-item v-if="form.cost_task_id" label="关联成本任务">#{{ form.cost_task_id }} · 本次仅核对成本，不变动实物</el-form-item>
        <el-form-item v-if="form.action_type === 'link_stock_cost'" label="已有采购明细"><el-select v-model="form.purchase_item_id" filterable style="width:100%" placeholder="选择有金额且已收货的采购"><el-option v-for="p in data.purchases.filter(row => Number(row.amount) > 0 && Number(row.received_quantity) > 0)" :key="p.id" :value="Number(p.id)" :label="`${p.order_no} · 已收 ${p.received_quantity} 件 · 货款 ${p.amount} 元`" /></el-select></el-form-item>
        <el-form-item v-if="['receive', 'link_purchase'].includes(form.action_type)" label="已有采购收货批次"><el-select v-model="form.inbound_id" style="width:100%"><el-option v-for="batch in batches" :key="batch.id" :value="Number(batch.id)" :label="`${batch.purchase_order_no || '采购批次'} #${batch.id} · 可关联 ${batch.selectable_quantity} 件`" /></el-select></el-form-item>
        <el-form-item v-if="form.action_type === 'historical_purchase'" label="采购／补录日期"><el-date-picker v-model="form.purchased_at" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss+08:00" placeholder="北京时间" /><small>默认今天，可按凭证修改；不要求早于历史订单，不新增现货或在途。</small></el-form-item>
        <el-form-item v-if="form.action_type === 'historical_purchase'" label="库存影响">只补历史采购来源，不增加现货或在途。实物与账面不符请单独盘点核对。</el-form-item>
        <template v-if="form.action_type === 'record_purchase'">
          <el-form-item label="采购／补录日期"><el-date-picker v-model="form.purchased_at" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss+08:00" placeholder="北京时间" /><small>默认今天，可按实际凭证修改。</small></el-form-item>
          <el-form-item label="库存影响">实物已盘点计入现货；本次只补数量与成本，不增加现货或采购在途。</el-form-item>
        </template>
        <el-form-item v-if="form.action_type === 'receive'" label="库存影响"><el-radio-group v-model="form.inventory_effect"><el-radio value="already_accounted">实物已计入盘点／账面，只补收货记录</el-radio><el-radio value="missing_inbound">确认漏记入库，增加账面数量</el-radio></el-radio-group></el-form-item>
        <template v-if="needsMoney"><el-form-item label="实际货款"><el-input-number v-model="form.amount" :min="0" :precision="2" /><span>{{ form.action_type === 'record_purchase' ? '按采购凭证填写，货款须大于 0' : '金额未知填 0，保留待补状态' }}</span></el-form-item><el-form-item label="实际运费"><el-input-number v-model="form.shipping_amount" :min="0" :precision="2" /></el-form-item></template>
        <el-form-item v-if="form.action_type === 'revise_purchase'" label="入库记录"><el-checkbox v-model="form.correct_received">入库也录多了，同步纠正多记的入库</el-checkbox></el-form-item>
        <template v-if="needsTarget"><el-form-item :label="form.action_type === 'substitute' ? '实际使用来源商品' : '转换目标商品'"><el-select v-model="form.target_product_id" filterable remote :remote-method="value => search(value, true)" @change="selectTarget" style="width:100%"><el-option v-for="p in targetProducts" :key="p.id" :value="Number(p.id)" :label="`${p.name} · ${p.code || ''}`" /></el-select></el-form-item><el-form-item :label="form.action_type === 'substitute' ? '来源实际消耗数量' : '目标入库数量'"><el-input-number v-model="form.target_quantity" :min="1" :precision="0" /><span v-if="target">该商品本地库存 {{ target.local_stock }}</span></el-form-item></template>
        <template v-if="form.action_type === 'stocktake'">
          <p><strong>{{ data.product.name }}</strong> · 库存 ID：{{ data.product.inventory_number || '—' }}</p>
          <el-form-item label="系统本地库存">{{ data.physical_estimate }} 件</el-form-item>
          <el-form-item label="实际清点数量"><el-input-number v-model="form.counted_quantity" placeholder="无实物请填 0" :min="0" :precision="0" /></el-form-item>
          <el-form-item v-if="countDelta != null" label="本次变动">{{ countDelta === 0 ? '数量一致' : `${countDelta > 0 ? '增加' : '减少'} ${Math.abs(countDelta)} 件` }}</el-form-item>
          <el-form-item label="调整原因"><el-radio-group v-model="form.reason_code"><el-radio v-for="reason in countReasons" :key="reason.code" :value="reason.code">{{ reason.label }}</el-radio></el-radio-group></el-form-item>
          <el-form-item :label="form.reason_code === 'other' ? '说明（必填）' : '补充说明（选填）'"><el-input v-model="form.reason_note" type="textarea" :rows="2" maxlength="900" placeholder="可填写领用人、凭证或补充情况" /></el-form-item>
          <div class="ledger-toolbar"><span>如果是以下情况，请使用对应流程：</span><el-button @click="startConversion">库存转换</el-button><el-button @click="formVisible = false; showPurchases('incoming')">已到货，核对采购记录</el-button></div>
          <p>清点数量包含已打包但尚未发出的货物，不包含采购在途。转换、实收、退货及已发货漏扣请按关联单据处理，避免重复记账。</p>
        </template>
        <template v-if="form.action_type === 'convert'">
          <el-divider>同时消耗的配件（例如车标）</el-divider>
          <div v-for="(source, index) in form.extra_sources" :key="index" class="ledger-toolbar">
            <el-select v-model="source.product_id" filterable remote :remote-method="value => search(value, true)" placeholder="选择配件库存" @change="id => selectSource(source, id)"><el-option v-for="p in targetProducts" :key="p.id" :value="Number(p.id)" :label="p.name" /></el-select>
            <el-input-number v-model="source.quantity" :min="1" :precision="0" aria-label="配件消耗数量" />
            <span>未占用 {{ source.available ?? '待选择' }}</span><el-button link type="danger" @click="form.extra_sources.splice(index, 1)">移除配件</el-button>
          </div>
          <el-button :disabled="form.extra_sources.length >= 20" @click="form.extra_sources.push({ product_id: null, quantity: 1, revision: '' })">添加消耗配件</el-button>
          <p>主件、配件同时扣减，目标成品入库；任一配件不足则整笔不保存。这里只支持实际库存产品，不支持把虚拟组合库存再次入库。</p>
        </template>
        <el-form-item v-if="form.action_type !== 'stocktake'" label="原因／凭证"><el-input v-model="form.reason" type="textarea" :rows="3" maxlength="1000" placeholder="说明实际采购、来源商品、使用去向或盘点差异" /></el-form-item>
      </el-form>
      <el-alert v-if="preview && form.action_type !== 'stocktake'" type="warning" :closable="false" :title="`本地账面库存：${preview.local_before} → ${preview.local_after}${needsTarget ? `；另一商品库存：${preview.target_before} → ${preview.target_after}` : ''}`" :description="form.action_type === 'revise_purchase' ? '采购、收货及关联订单覆盖将同步重算；负库存保留为待核差异，不自动补采购。' : '历史补录只解释所选订单来源；不会新增一笔当前待采购任务。'" />
      <el-table v-if="preview?.affected_orders?.length" :data="preview.affected_orders" max-height="180"><el-table-column prop="posting_number" label="覆盖减少的订单" /><el-table-column prop="before" label="原关联数量" /><el-table-column prop="after" label="纠正后关联数量" /></el-table>
      <el-alert v-if="preview?.cost_task_quantity > 0" type="info" :closable="false" :title="`将生成 ${preview.cost_task_quantity} 件现货成本核对任务，交由采购关联已有采购或补录成本；不是要求再采购这些货物。`" />
      <el-alert v-if="preview && form.action_type === 'convert'" :type="preview.conversion_cost_amount == null ? 'warning' : 'info'" :closable="false" :title="preview.conversion_cost_amount == null ? '部分来源库存缺少成本，本次转换成本暂不能确定；不生成虚假的零元采购。请核对来源商品采购成本。' : `转换成本合计 ${preview.conversion_cost_amount} 元，转入目标成品成本记录，不新增采购或在途。`" />
      <el-table v-if="preview?.extra_changes?.length" :data="preview.extra_changes"><el-table-column prop="product_name" label="配件" /><el-table-column prop="quantity" label="消耗" /><el-table-column prop="available_before" label="未占用现货（前）" /><el-table-column prop="available_after" label="未占用现货（后）" /></el-table>
      <template #footer><el-button :disabled="saving" @click="discardForm">取消</el-button><el-button v-if="form.action_type === 'stocktake'" type="primary" :loading="saving" @click="confirmStock">确认更新</el-button><template v-else><el-button :loading="saving" @click="makePreview">预览影响</el-button><el-button type="primary" :disabled="!preview" :loading="saving" @click="save">确认保存纠正记录</el-button></template></template>
    </el-dialog>
  </el-dialog>
</template>
<style scoped>
.ledger-toolbar,.ledger-product { display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap; }
.ledger-image { width:64px;height:84px;flex:none;display:flex;align-items:center;justify-content:center;background:#f5f7fa; }
.ledger-metrics { display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px;margin:16px 0; }
.ledger-metrics > div { display:grid;gap:8px;padding:14px;background:#f5f7fa;border-radius:8px; }
.ledger-metrics span { color:#606266;font-size:12px; }.ledger-metrics strong { font-size:22px; }.ledger-warning strong { color:#b45309; }
.ledger-shortage { color:var(--el-color-danger); }
.ledger-order-summary { margin-bottom:20px; }
.ledger-order-summary h3 { display:flex;align-items:center;gap:16px;flex-wrap:wrap; }
.ledger-order-summary p,.ledger-hint,.ledger-scope small { color:#606266;font-size:13px; }
.ledger-order-summary h3 small { font-weight:400;color:#606266; }
.ledger-order-product { margin:0;min-height:92px;flex-wrap:nowrap; }
.ledger-product-select { white-space:normal;text-align:left;height:auto;line-height:1.5; }
.ledger-order-summary :deep(.el-table__row) { cursor:pointer; }
.ledger-order-summary :deep(.selected-inventory-row) { --el-table-tr-bg-color:var(--el-color-primary-light-9); }
.ledger-top-actions { display:flex;gap:8px;flex-wrap:wrap;margin-left:auto; }
.ledger-top-actions .el-button { margin-left:0; }
.ledger-scope { display:flex;flex-direction:column;gap:6px; }
.ledger-scope small { font-weight:400; }
.ledger-metric-groups { display:grid;grid-template-columns:4fr 3fr;gap:20px; }
.ledger-metric-groups h3 { margin:8px 0; }
.ledger-metric-groups .ledger-metrics { grid-template-columns:repeat(4,minmax(0,1fr));margin:8px 0 16px; }
.ledger-metric-groups section:last-child .ledger-metrics { grid-template-columns:repeat(3,minmax(0,1fr)); }
.ledger-metrics small { color:#606266;font-size:12px;line-height:1.5; }
.ledger-management { border:1px solid #dcdfe6;padding:16px;margin-bottom:16px;border-radius:8px; }
:deep(.current-fbp-sku) { --el-table-tr-bg-color:var(--el-color-primary-light-9); }
:global(.unified-inventory-dialog > .el-dialog__body) { max-height:82vh;overflow:auto; }
@media(max-width:1000px) { .ledger-metric-groups { grid-template-columns:1fr;gap:0; } }
@media(max-width:900px) { .ledger-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } }
</style>
