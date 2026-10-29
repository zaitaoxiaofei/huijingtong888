<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { useRouter } from 'vue-router';
import { shanghaiDateTimeText } from '../../utils/shanghai-date.js';

const props = defineProps({ ledger: { type: Object, required: true }, inventoryMode: Boolean });
const emit = defineEmits(['select-tab', 'navigate']);
const router = useRouter();
const canvas = ref(null), selected = ref(''), paths = ref([]);
const arrowId = `inventory-flow-arrow-${useId()}`;
let observer;
const summary = computed(() => props.ledger.flow_summary || {});
const facts = computed(() => summary.value.unavailable ? {} : summary.value);
const quantity = value => value == null || !Number.isFinite(Number(value)) ? '待核对' : `${Number(value)} 件`;
const time = value => value ? shanghaiDateTimeText(value) : '待核对';
const statusText = status => ({ draft: '草稿', pending_review: '待审核', approved: '已审核待发', ozon_created: '已建发仓单', sent: '已发出', completed: '已完成' }[status] || status || '待核对');
const currentOrders = computed(() => facts.value.orders || (props.ledger.orders || []).filter(row => row.needs_fulfillment));
const applications = computed(() => facts.value.applications || []);
const purchases = computed(() => (facts.value.purchases || props.ledger.purchases || []).filter(row => Number(row.pending_quantity) > 0));
const nodes = computed(() => [
  { key: 'incoming', label: '采购在途', value: props.ledger.incoming_quantity, hint: '收货验收后入库', area: '2 / 1', tab: 'purchases' },
  { key: 'assigned', label: '订单在途覆盖', value: props.ledger.current_incoming, hint: '尚未到货，不能发出', area: '1 / 2', tab: 'current', plan: true },
  { key: 'physical', label: '本地实物', value: props.ledger.physical_estimate, hint: props.ledger.last_stocktake_at ? `核实 ${time(props.ledger.last_stocktake_at)}` : '尚无盘点时间', area: '2 / 2', tab: 'movements', primary: true },
  { key: 'incoming-free', label: '在途未分配给订单', value: props.ledger.incoming_quantity == null || props.ledger.current_incoming == null ? null : Math.max(0, props.ledger.incoming_quantity - props.ledger.current_incoming), hint: '非 FBP 已锁定现货', area: '4 / 2', tab: 'purchases', plan: true },
  { key: 'orders', label: '① 订单占用', value: props.ledger.open_order_demand, hint: `${currentOrders.value.length} 条商品需求 · 优先保障`, area: '1 / 3', tab: 'current' },
  { key: 'safety', label: '② 本地安全保障', value: facts.value.safety, hint: facts.value.local_days == null ? '等待预测数据' : `保障 ${facts.value.local_days} 天 · 不含已出单`, area: '2 / 3', plan: true },
  { key: 'application', label: '③ FBP 申请', value: facts.value.requested, hint: '申请不重复扣实物', area: '3 / 3', plan: true },
  { key: 'locked', label: '已确认 FBP 占用', value: props.ledger.fbp_reserved, hint: '实际发出才扣实物', area: '3 / 4', primary: true },
  { key: 'free', label: '可用库存', value: facts.value.free, hint: facts.value.protection_gap > 0 ? `保障缺口 ${quantity(facts.value.protection_gap)}` : '扣除占用与保障后', area: '2 / 5', primary: true }
]);
const activeNode = computed(() => nodes.value.find(node => node.key === selected.value));
function rowsFor(key) {
  if (['orders', 'assigned'].includes(key)) return currentOrders.value;
  if (['application', 'locked'].includes(key)) return applications.value.filter(row => key !== 'locked' || Number(row.locked_quantity) > 0);
  if (key === 'safety') return facts.value.safety_rows || [];
  if (['incoming', 'incoming-free'].includes(key)) return purchases.value;
  return [];
}
function navigateOrder(row) { emit('navigate'); router.push({ path: '/orders', query: { orderId: row.order_id } }); }
function navigateApplication(row) { emit('navigate'); router.push({ path: '/inventory/fbp-replenishment', query: { orderId: row.order_id } }); }
function selectNode(node) {
  const rows = rowsFor(node.key);
  if (node.key === 'orders' && rows.length === 1 && rows[0].order_id) return navigateOrder(rows[0]);
  if (['application', 'locked'].includes(node.key) && rows.length && new Set(rows.map(row => row.order_id)).size === 1) return navigateApplication(rows[0]);
  selected.value = node.key;
}
function brief(node) {
  if (node.key === 'physical') return ['实物包含已打包但尚未实际发出的货。', `最近核实：${time(props.ledger.last_stocktake_at)}`];
  if (node.key === 'free') return [facts.value.free == null ? '保障数据不完整，不能把未占用余量全部视为可发 FBP。' : `${props.ledger.physical_estimate} − ${props.ledger.open_order_demand} − ${facts.value.safety} − ${props.ledger.fbp_reserved} = ${facts.value.free}`, `现行未占用余量：${quantity(props.ledger.available_estimate)}；尚未扣未来保障。`];
  if (node.key === 'safety') return [facts.value.safety_status || '预测数据暂不可用', `本地保障 ${facts.value.local_days ?? '待核'} 天；FBP 保障 ${facts.value.fbp_days ?? '待核'} 天。`];
  if (node.key === 'assigned') return ['已分配在途只表示未来覆盖，不能计入可立即发出的实物。'];
  if (node.key === 'incoming-free') return ['只减本地订单已分配的在途；其他用途及历史关联仍需查看采购明细，不能直接视为可发 FBP。'];
  return [];
}
const edges = [['incoming', 'assigned', true], ['incoming', 'physical', false], ['incoming', 'incoming-free', true], ['physical', 'orders', false], ['physical', 'safety', true], ['physical', 'application', true], ['application', 'locked', false], ['locked', 'free', false], ['physical', 'free', true]];
function draw() {
  if (!canvas.value) return;
  const box = canvas.value.getBoundingClientRect();
  const narrow = box.width < 760;
  paths.value = edges.map(([from, to, planned]) => {
    const a = canvas.value.querySelector(`[data-node="${from}"]`)?.getBoundingClientRect();
    const b = canvas.value.querySelector(`[data-node="${to}"]`)?.getBoundingClientRect();
    if (!a || !b) return null;
    if (narrow) {
      const x1 = a.left - box.left + a.width / 2, y1 = a.bottom - box.top;
      const x2 = b.left - box.left + b.width / 2, y2 = b.top - box.top;
      const lane = box.width - 5;
      return { key: `${from}-${to}`, planned, d: `M${x1},${y1} V${y1 + 10} H${lane} V${y2 - 10} H${x2} V${y2}` };
    }
    const x1 = a.right - box.left, y1 = a.top - box.top + a.height / 2;
    const x2 = b.left - box.left, y2 = b.top - box.top + b.height / 2;
    const mid = (x1 + x2) / 2;
    return { key: `${from}-${to}`, planned, d: from === 'physical' && to === 'free'
      ? `M${x1},${y1} H${x1 + 12} V${y1 + 72} H${x2 - 12} V${y2} H${x2}`
      : `M${x1},${y1} H${mid} V${y2} H${x2}` };
  }).filter(Boolean);
}
watch(() => props.ledger, async () => { selected.value = ''; await nextTick(); draw(); });
onMounted(() => { observer = new ResizeObserver(draw); observer.observe(canvas.value); draw(); });
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <section class="inventory-flow-diagram" aria-label="库存流转与占用">
    <div class="flow-heading"><h3>库存流转与占用</h3><span>悬浮看摘要 · 点击查看对应单据</span></div>
    <el-alert v-if="summary.unavailable" :title="summary.message" type="warning" :closable="false" />
    <div ref="canvas" class="flow-canvas">
      <svg class="flow-connectors" aria-hidden="true"><defs><marker :id="arrowId" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="flow-arrow-head" /></marker></defs><path v-for="path in paths" :key="path.key" :d="path.d" :marker-end="`url(#${arrowId})`" :class="{ 'is-planned': path.planned }" /></svg>
      <el-popover v-for="node in nodes" :key="node.key" placement="top" :width="420" trigger="hover" :show-after="180" popper-class="inventory-flow-popover">
        <template #reference><button type="button" class="flow-node" :data-node="node.key" :style="{ gridArea: node.area }" :class="{ 'is-primary': node.primary, 'is-planned': node.plan, 'is-selected': selected === node.key }" :aria-expanded="selected === node.key" @click="selectNode(node)"><span>{{ node.label }}</span><strong>{{ quantity(node.value) }}</strong><small>{{ node.hint }}</small></button></template>
        <h4>{{ node.label }} · {{ quantity(node.value) }}</h4>
        <p v-for="line in brief(node)" :key="line">{{ line }}</p>
        <div v-for="(row, index) in rowsFor(node.key).slice(0, 4)" :key="row.order_item_id || row.item_id || row.id || index" class="flow-hover-row">
          <template v-if="['orders', 'assigned'].includes(node.key)"><strong>{{ row.shop_name || '店铺待核' }} · {{ row.posting_number }}</strong><div>需求 {{ quantity(row.quantity) }} · 现货 {{ quantity(row.stock_quantity) }} · 在途 {{ quantity(row.incoming_quantity) }}</div><small>下单 {{ time(row.ordered_at) }}</small></template>
          <template v-else-if="['application', 'locked'].includes(node.key)"><strong>{{ row.order_no }} · {{ row.shop_name }}</strong><div>申请人 {{ row.applicant_name || '未提供' }} · {{ statusText(row.status) }}</div><div>SKU {{ row.ozon_sku }} · 申请 {{ quantity(row.requested_quantity) }} · 占用 {{ quantity(row.locked_quantity) }}</div></template>
          <template v-else-if="node.key === 'safety'"><strong>{{ row.shop_name }} · {{ row.ozon_sku }}</strong><div>本地日均 {{ Number(row.local_daily_sales || 0).toFixed(2) }} · {{ row.status }}</div><small>官方同步 {{ time(row.synced_at) }}</small></template>
          <template v-else><strong>{{ row.order_no || '采购单号待核' }}</strong><div>采购人 {{ row.person_name || '未提供' }} · 在途 {{ quantity(row.pending_quantity) }}</div></template>
        </div>
        <p v-if="rowsFor(node.key).length > 4">另有 {{ rowsFor(node.key).length - 4 }} 条，点击节点查看全部。</p>
        <p v-if="!rowsFor(node.key).length && !brief(node).length">暂无关联明细；占用不为零时请刷新并核对库存流水。</p>
      </el-popover>
    </div>
    <div class="flow-legend"><span>实线：实物与确认占用</span><span>虚线：计划与保障关系</span><el-button link type="primary" @click="emit('select-tab', 'fbp')">FBP 官方库存 {{ props.ledger.fbp_inventory?.incomplete ? '待核对' : quantity(props.ledger.fbp_inventory?.present) }} · 查看 SKU</el-button></div>
    <section v-if="activeNode" class="flow-node-detail" aria-live="polite">
      <div class="flow-heading"><h4>{{ activeNode.label }} · {{ quantity(activeNode.value) }}</h4><el-button text @click="selected = ''">收起</el-button></div>
      <p v-for="line in brief(activeNode)" :key="line">{{ line }}</p>
      <el-table v-if="['orders', 'assigned'].includes(selected)" :data="rowsFor(selected)" max-height="340" empty-text="暂无待发订单">
        <el-table-column prop="shop_name" label="店铺" min-width="120" /><el-table-column prop="posting_number" label="订单号" min-width="190" /><el-table-column prop="quantity" label="需求" width="80" /><el-table-column prop="stock_quantity" label="现货覆盖" width="100" /><el-table-column prop="incoming_quantity" label="在途覆盖" width="100" /><el-table-column label="操作" width="100"><template #default="{ row }"><el-button link type="primary" @click="navigateOrder(row)">打开订单</el-button></template></el-table-column>
      </el-table>
      <el-table v-else-if="['application', 'locked'].includes(selected)" :data="rowsFor(selected)" max-height="340" empty-text="暂无关联申请；现有占用请到库存流水核对">
        <el-table-column prop="order_no" label="FBP 申请单" min-width="170" /><el-table-column prop="shop_name" label="店铺" min-width="110" /><el-table-column prop="applicant_name" label="申请人" width="100" /><el-table-column prop="ozon_sku" label="SKU" min-width="130" /><el-table-column prop="requested_quantity" label="申请实物数" width="110" /><el-table-column prop="locked_quantity" label="确认占用" width="100" /><el-table-column label="状态" width="110"><template #default="{ row }">{{ statusText(row.status) }}</template></el-table-column><el-table-column label="操作" width="110"><template #default="{ row }"><el-button link type="primary" @click="navigateApplication(row)">打开申请单</el-button></template></el-table-column>
      </el-table>
      <el-table v-else-if="selected === 'safety'" :data="rowsFor(selected)" max-height="340" empty-text="尚无可核对的 SKU 预测数据">
        <el-table-column prop="shop_name" label="店铺" min-width="120" /><el-table-column prop="ozon_sku" label="SKU" min-width="140" /><el-table-column label="本地日均" width="110"><template #default="{ row }">{{ Number(row.local_daily_sales || 0).toFixed(2) }}</template></el-table-column><el-table-column label="每套含实物" width="110" prop="per_set_quantity" /><el-table-column prop="status" label="供货判断" min-width="150" /><el-table-column label="官方同步（北京）" min-width="180"><template #default="{ row }">{{ time(row.synced_at) }}</template></el-table-column>
      </el-table>
      <template v-else-if="['incoming', 'incoming-free'].includes(selected)">
        <el-table :data="purchases" max-height="340" empty-text="暂无采购在途"><el-table-column prop="order_no" label="采购单" min-width="180" /><el-table-column prop="person_name" label="采购人" min-width="100" /><el-table-column prop="pending_quantity" label="在途件数" width="110" /><el-table-column label="采购时间（北京）" min-width="180"><template #default="{ row }">{{ time(row.purchased_at) }}</template></el-table-column></el-table>

      </template>
      <el-button v-if="activeNode.tab && !(inventoryMode && activeNode.tab === 'purchases')" link type="primary" @click="emit('select-tab', ['incoming', 'incoming-free'].includes(selected) ? 'incoming-purchases' : activeNode.tab)">查看原有{{ { movements: '库存流水', purchases: '采购与成本', current: '订单分配' }[activeNode.tab] }}明细</el-button>
    </section>
    <p v-if="ledger.physical_estimate < 0" class="flow-warning">实物推算为负，请先核对盘点和历史出库；当前不能确认可发数量。</p>
    <p class="flow-footnote">保障为预测目标，不生成出库流水；在途到货前不可发；FBP 官方库存以同步结果为准。</p>
  </section>
</template>

<style scoped>
.inventory-flow-diagram { margin: 18px 0; color: var(--el-text-color-primary); }
.flow-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
.flow-heading h3, .flow-heading h4 { margin: 0; }
.flow-heading > span, .flow-footnote, .flow-legend { font-size: 12px; color: var(--el-text-color-secondary); }
.flow-canvas { position: relative; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); grid-template-rows: repeat(4, 106px); gap: 34px 38px; padding: 26px 0 12px; background-image: radial-gradient(var(--el-border-color-lighter) .7px, transparent .7px); background-size: 18px 18px; }
.flow-connectors { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.flow-connectors path { stroke: var(--el-color-primary-light-3); stroke-width: 1.5; fill: none; }
.flow-connectors .flow-arrow-head { fill: var(--el-color-primary-light-3); stroke: none; }
.flow-connectors path.is-planned { stroke-dasharray: 5 4; }
.flow-node { position: relative; z-index: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 7px; min-width: 0; padding: 10px 8px; border: 1px solid var(--el-border-color); border-radius: 8px; background: var(--el-bg-color-overlay); color: var(--el-text-color-primary); font: inherit; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
.flow-node strong { font-size: 23px; font-weight: 600; font-variant-numeric: tabular-nums; }
.flow-node small { font-size: 11px; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
.flow-node.is-primary { background: var(--el-color-primary-light-9); border-color: var(--el-color-primary-light-5); }
.flow-node.is-planned { border-style: dashed; }
.flow-node:hover, .flow-node:focus-visible, .flow-node.is-selected { border-color: var(--el-color-primary); box-shadow: 0 0 0 2px var(--el-color-primary-light-8); }
.flow-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 18px; margin-top: 6px; }
.flow-node-detail { border-top: 1px solid var(--el-border-color-lighter); margin-top: 15px; padding-top: 12px; }
.flow-node-detail p { font-size: 13px; }
.flow-warning { color: var(--el-color-warning); }
.flow-hover-row { border-top: 1px solid var(--el-border-color-lighter); padding: 9px 0; font-size: 12px; overflow-wrap: anywhere; }
.flow-hover-row strong { font-weight: 600; }
:global(.inventory-flow-popover) { max-width: calc(100vw - 24px); box-sizing: border-box; }
@container inventory-flow (max-width: 759px) { .flow-canvas { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: none; gap: 28px 26px; padding-right: 16px; }.flow-node { grid-area: auto !important; min-height: 100px; } }
.inventory-flow-diagram { container-type: inline-size; container-name: inventory-flow; }
@media (prefers-reduced-motion: reduce) { .flow-node { transition: none; } }
</style>
