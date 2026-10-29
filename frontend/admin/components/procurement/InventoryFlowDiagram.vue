<script setup>
import InventoryFbpSkuTable from './InventoryFbpSkuTable.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { inventoryWorkflow } from '../../../../src/shared/inventory-workflow.js';
import { useRouter } from 'vue-router';
import { shanghaiDateTimeText } from '../../utils/shanghai-date.js';

const props = defineProps({ ledger: { type: Object, required: true }, workflow: Object, inventoryMode: Boolean, fbpLoading: Boolean, fbpSyncing: Boolean, canSyncFbp: Boolean, fbpError: { type: String, default: '' } });
const emit = defineEmits(['select-tab', 'navigate', 'retry-fbp', 'sync-fbp','workflow-action','stocktake']);
const router = useRouter();
const canvas = ref(null), selected = ref(''), paths = ref([]);
const detail = ref(null);
const detailId = `inventory-flow-detail-${useId()}`;
const arrowId = `inventory-flow-arrow-${useId()}`;
let observer;
const summary = computed(() => props.ledger.flow_summary || {});
const facts = computed(() => summary.value.unavailable ? {} : summary.value);
const quantity = value => value == null || !Number.isFinite(Number(value)) ? '待核对' : `${Number(value)} 件`;
const time = value => value ? shanghaiDateTimeText(value) : '待核对';
const statusText = status => ({ draft: '草稿', pending_review: '待审核', approved: '已审核待发', ozon_created: '已建发仓单', sent: '已发出', completed: '已完成入仓', rejected: '已拒绝', cancelled: '已取消' }[status] || status || '待核对');
const currentOrders = computed(() => facts.value.orders || (props.ledger.orders || []).filter(row => row.needs_fulfillment));
const applications = computed(() => summary.value.applications || []);
const official = computed(() => props.ledger.fbp_inventory);
const fbpCoverage = computed(() => {
  const rows = official.value?.rows || [];
  return `${new Set(rows.map(row => row.shop_id)).size} 家店铺 · ${new Set(rows.map(row => `${row.shop_id}:${row.ozon_sku}`)).size} 个 SKU`;
});
const positiveFbpRows = computed(() => (official.value?.rows || []).filter(row => [row.present, row.available, row.reserved].some(value => Number(value) > 0)));
const dispatches = computed(() => applications.value.filter(row => ['sent', 'completed'].includes(row.status)));
const purchases = computed(() => (facts.value.purchases || props.ledger.purchases || []).filter(row => Number(row.pending_quantity) > 0));
const workflowState=computed(()=>props.workflow||inventoryWorkflow(props.ledger));
function nodeStatus(key) {
  const type=({orders:'real_order',safety:'local_safety',application:'fbp_stock'})[key];
  if(type)return workflowState.value.demands.find(d=>d.key===type)?.status;
  if(key==='free')return workflowState.value.stock_status;
  return '';
}
const nodes = computed(() => [
 {key:'receiving',label:'验货收货',value:props.ledger.incoming_quantity,hint:'验收合格后登记入库',area:'1 / 1'},
 {key:'orders',label:'① FBS订单保障',value:props.ledger.open_order_demand,hint:`现货占用 · 优先保障${gapText('real_order')}`,area:'1 / 2',tab:'current'},
 {key:'safety',label:'② 本地安全保障',value:facts.value.safety,hint:`保障 ${facts.value.local_days??'待核'} 天${gapText('local_safety')}`,area:'2 / 2',plan:true},
 {key:'physical',label:'本地实物',value:props.ledger.physical_estimate,hint:'双击更新实物，点击查看流水',area:'3 / 1',tab:'movements',primary:true},
 {key:'free',label:'可用库存',value:facts.value.free,hint:'扣订单、安全保障及已确认FBP占用',area:'4 / 2',primary:true},
 {key:'application',label:'③ FBP备货申请',value:workflowState.value.requested,hint:workflowState.value.demands.find(d=>d.key==='fbp_stock')?.process_status==='draft'?'另有备货草稿，尚未提交':`未确认不锁库存${gapText('fbp_stock')}`,area:'4 / 3',plan:true},
 {key:'locked',label:'仓库确认与锁定',value:props.ledger.fbp_reserved,hint:'只锁定，实际发运才扣实物',area:'3 / 4',primary:true},
 {key:'dispatch',label:'发往FBP',display:`${new Set(dispatches.value.map(row=>row.order_id)).size} 单`,hint:'已发出／入仓记录',area:'3 / 5'},
 {key:'fbp-physical',label:'FBP官方库存核对',display:props.fbpLoading?'正在拉取中':props.fbpError?'同步未完成':official.value?.incomplete?'部分未同步':'',value:official.value?.incomplete?null:official.value?.present,hint:'各店铺SKU汇总 · 点击看图片与组成',area:'4 / 6',primary:true},
 {key:'requests',label:'需求与采购申请',value:workflowState.value.purchase_quantity,hint:'三类缺口按优先级汇总',area:'1 / 4',plan:true},
 {key:'purchase-confirm',label:'确认采购',display:'登记已下单',hint:'以实际下单件数为准',area:'1 / 5'},
 {key:'incoming',label:'采购在途',value:props.ledger.incoming_quantity,hint:'在途不是可发实物',area:'1 / 6',tab:'purchases'}
]);
function gapText(type){const demand=workflowState.value.demands.find(d=>d.key===type);return demand?.purchase_quantity>0?` · 需采购 ${demand.purchase_quantity} 件`:demand?.physical_gap>0?' · 等待到货':'';}
const activeNode = computed(() => selected.value === 'fbp-history' ? { key: 'fbp-history', label: '全部 FBP 单据', display: `${new Set(applications.value.map(row => row.order_id)).size} 单` } : nodes.value.find(node => node.key === selected.value));
function rowsFor(key) {
  if(key==='requests')return workflowState.value.requests||[];
  if (['orders', 'assigned'].includes(key)) return currentOrders.value;
  if (['application', 'locked'].includes(key)) return applications.value.filter(row => key === 'locked' ? Number(row.locked_quantity) > 0 : !['sent', 'completed', 'cancelled', 'rejected'].includes(row.status));
  if (key === 'fbp-history') return applications.value;
  if (key === 'fbp-physical') return positiveFbpRows.value;
  if (key === 'dispatch') return dispatches.value;
  if (key === 'safety') return facts.value.safety_rows || [];
  if (['incoming', 'incoming-free','receiving','purchase-confirm'].includes(key)) return purchases.value;
  return [];
}
function navigateOrder(row) { emit('navigate'); router.push({ path: '/orders', query: { orderId: row.order_id } }); }
function navigateApplication(row) { emit('navigate'); router.push({ path: '/inventory/fbp-replenishment', query: { orderId: row.order_id } }); }
async function openDetails(key) {
  selected.value = key;
  await nextTick();
  detail.value?.focus({ preventScroll: true });
  detail.value?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
function selectNode(node) {
  const rows = rowsFor(node.key);
  if (node.key === 'orders' && rows.length === 1 && rows[0].order_id) return navigateOrder(rows[0]);
  if (['application', 'locked'].includes(node.key) && rows.length && new Set(rows.map(row => row.order_id)).size === 1) return navigateApplication(rows[0]);
  void openDetails(node.key);
}
function brief(node) {
  if (node.key === 'fbp-physical') return [`${fbpCoverage.value}；${props.fbpLoading ? '正在拉取中，当前明细为上次快照' : props.fbpError ? '本次同步未完成，不能视为全部店铺核实成功' : '按绑定的全部 SKU 汇总'}。`, 'Ozon 官方 FBP 仓实物，按每套组成折算为当前库存的件数；独立于本地库存，不增加本地可用，也不重复扣订单。',
    official.value?.incomplete ? `汇总不完整，已同步部分 ${quantity(official.value?.present)}；未同步 SKU 保持待核对，不按零库存处理。` : '仅展开有库存的店铺 SKU；已占用但仍有实物的 SKU 也会展示。',
    `最早核实时间：${time(official.value?.synced_at)}（北京）；部分店铺失败时保留各自上次快照。`];
  if (node.key === 'dispatch') return ['这里是已发出、已完成入仓的申请记录，不再计入本地申请或确认占用。', '发仓记录不代表官方当前库存；官方实物以独立同步结果为准。'];
  if (node.key === 'application') return ['当前未发出的申请；点击下方“全部 FBP 单据”可查看已拒绝、已取消及完整流转状态。'];
  if (node.key === 'physical') return ['实物包含已打包但尚未实际发出的货。', `最近核实：${time(props.ledger.last_stocktake_at)}`];
  if (node.key === 'free') return [facts.value.free == null ? '保障数据不完整，不能把未占用余量全部视为可发 FBP。' : `${props.ledger.physical_estimate} − ${props.ledger.open_order_demand} − ${facts.value.safety} − ${props.ledger.fbp_reserved} = ${facts.value.free}`, `现行未占用余量：${quantity(props.ledger.available_estimate)}；尚未扣未来保障。`];
  if (node.key === 'safety' && facts.value.daily_consumption != null) return [`近7个完整自然日消耗 ${facts.value.consumed_7d} 件，日均 ${Number(facts.value.daily_consumption).toFixed(2)} 件 × ${facts.value.local_days} 天，向上取整。`, `生产 ${facts.value.production_days} 天＋到本地 ${facts.value.local_shipping_days} 天，至少保障7天；节假日影响已计入。`, facts.value.estimated_dates ? `${facts.value.estimated_dates} 条缺发运时间，按下单时间估计；不含待发订单及FBP/OGR消耗。` : '不含待发订单及FBP/OGR消耗；历史缺发运时间时按履约记录中的签收/下单日期估计，FBP未同步不减少本地保障。'];
  if (node.key === 'safety') return [facts.value.safety_status || '预测数据暂不可用', `本地保障 ${facts.value.local_days ?? '待核'} 天；FBP 保障 ${facts.value.fbp_days ?? '待核'} 天。`];
  if (node.key === 'assigned') return ['已分配在途只表示未来覆盖，不能计入可立即发出的实物。'];
  if (node.key === 'incoming-free') return ['只减本地订单已分配的在途；其他用途及历史关联仍需查看采购明细，不能直接视为可发 FBP。'];
  return [];
}
const edges = [
 ['physical','orders',false,''],['physical','safety',false,''],['physical','free',false,''],
 ['orders','requests',true,'订单缺口'],['safety','requests',true,'保障缺口'],['application','requests',true,'本地供货不足'],
 ['requests','purchase-confirm',false,''],['purchase-confirm','incoming',false,''],['incoming','receiving',false,'验货收货'],['receiving','physical',false,'登记入库'],
 ['free','application',false,''],['application','locked',false,'确认'],['locked','dispatch',false,''],['dispatch','fbp-physical',false,'到仓核对'],['fbp-physical','application',true,'预测缺口']
];
function draw(){
 if(!canvas.value)return;
 const box=canvas.value.getBoundingClientRect(),narrow=box.width<760;
 paths.value=edges.map(([from,to,planned,label])=>{
  const a=canvas.value.querySelector(`[data-node="${from}"]`)?.getBoundingClientRect(),b=canvas.value.querySelector(`[data-node="${to}"]`)?.getBoundingClientRect();if(!a||!b)return null;
  let x1=a.right-box.left,y1=a.top-box.top+a.height/2,x2=b.left-box.left,y2=b.top-box.top+b.height/2,d,lx=(x1+x2)/2,ly=(y1+y2)/2-8;
  if(narrow){const lane=box.width-4;x1=a.left-box.left+a.width/2;x2=b.left-box.left+b.width/2;y1=a.bottom-box.top;y2=b.top-box.top;d=`M${x1},${y1} V${y1+8} H${lane} V${y2-8} H${x2} V${y2}`;label='';}
  else if(from==='incoming'&&to==='receiving'){x1=a.left-box.left+a.width/2;x2=b.left-box.left+b.width/2;y1=a.top-box.top;y2=b.top-box.top;d=`M${x1},${y1} V8 H${x2} V${y2}`;lx=(x1+x2)/2;ly=8;}
  else if(from==='fbp-physical'&&to==='application'){x1=a.left-box.left+a.width/2;x2=b.left-box.left+b.width/2;y1=a.bottom-box.top;y2=b.bottom-box.top;const lane=box.height-10;d=`M${x1},${y1} V${lane} H${x2} V${y2}`;lx=(x1+x2)/2;ly=lane;}
  else if(from==='receiving'){x1=a.left-box.left+a.width/2;x2=b.left-box.left+b.width/2;y1=a.bottom-box.top;y2=b.top-box.top;d=`M${x1},${y1} V${y2}`;lx=x1;ly=(y1+y2)/2;}
  else {const mid=x1+Math.max(14,(x2-x1)/2);d=`M${x1},${y1} H${mid} V${y2} H${x2}`;lx=mid;ly=(y1+y2)/2;}
  return{key:`${from}-${to}`,planned,d,label,lx,ly};
 }).filter(Boolean);
}
watch(() => props.ledger, async (value, previous) => { if (value.product?.id !== previous?.product?.id) selected.value = ''; await nextTick(); draw(); });
onMounted(() => { observer = new ResizeObserver(draw); observer.observe(canvas.value); draw(); });
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <section class="inventory-flow-diagram" aria-label="库存流转与占用">
    <div class="flow-heading"><h3>库存流转与占用</h3><span>悬浮看摘要 · 点击查看对应单据</span></div>
    <el-alert v-if="summary.unavailable" :title="summary.message" type="warning" :closable="false" />
    <div ref="canvas" class="flow-canvas">
      <svg class="flow-connectors" aria-hidden="true"><defs><marker :id="arrowId" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="flow-arrow-head" /></marker></defs><path v-for="path in paths" :key="path.key" :data-edge="path.key" :d="path.d" :marker-end="`url(#${arrowId})`" :class="{ 'is-planned': path.planned }" /><g v-for="path in paths.filter(p=>p.label)" :key="`label-${path.key}`" class="flow-edge-label" :transform="`translate(${path.lx},${path.ly})`"><rect x="-48" y="-11" width="96" height="22" rx="11" /><text text-anchor="middle" dominant-baseline="central">{{path.label}}</text></g></svg>
      <el-popover v-for="node in nodes" :key="node.key" placement="top" :width="420" trigger="hover" :show-after="180" popper-class="inventory-flow-popover">
        <template #reference><button type="button" class="flow-node" :data-node="node.key" :style="{ gridArea: node.area }" :class="{ 'is-primary': node.primary, 'is-planned': node.plan, 'is-selected': selected === node.key, [`is-${nodeStatus(node.key)}`]: !!nodeStatus(node.key) }" :aria-expanded="selected === node.key" :aria-controls="detailId" @click="selectNode(node)" @dblclick="node.key==='physical' && canSyncFbp && emit('stocktake')"><span>{{ node.label }}</span><strong>{{ node.display || quantity(node.value) }}</strong><small>{{ node.hint }}</small></button></template>
        <h4>{{ node.label }} · {{ node.display || quantity(node.value) }}</h4>
        <p v-for="line in brief(node)" :key="line">{{ line }}</p>
        <div v-for="(row, index) in rowsFor(node.key).slice(0, 4)" :key="row.order_item_id || row.item_id || row.id || index" class="flow-hover-row">
          <template v-if="['orders', 'assigned'].includes(node.key)"><strong>{{ row.shop_name || '店铺待核' }} · {{ row.posting_number }}</strong><div>需求 {{ quantity(row.quantity) }} · 现货 {{ quantity(row.stock_quantity) }} · 在途 {{ quantity(row.incoming_quantity) }}</div><small>下单 {{ time(row.ordered_at) }}</small></template>
          <template v-else-if="['application', 'locked', 'dispatch'].includes(node.key)"><strong>{{ row.order_no }} · {{ row.shop_name }}</strong><div>申请人 {{ row.applicant_name || '未提供' }} · {{ statusText(row.status) }}</div><div>SKU {{ row.ozon_sku }} · 申请 {{ quantity(row.requested_quantity) }} · 占用 {{ quantity(row.locked_quantity) }}</div></template>
          <template v-else-if="node.key === 'fbp-physical'"><strong>{{ row.shop_name }} · SKU {{ row.ozon_sku }}</strong><div>{{ row.warehouse_name }} · 实物 {{ quantity(row.inventory_quantity) }}（{{ row.present }} 套）</div><small>核实 {{ time(row.synced_at) }}</small></template>
          <template v-else-if="node.key === 'safety'"><strong>{{ row.shop_name }} · {{ row.ozon_sku }}</strong><div>本地日均 {{ Number(row.local_daily_sales || 0).toFixed(2) }} · {{ row.status }}</div><small>官方同步 {{ time(row.synced_at) }}</small></template>
          <template v-else><strong>{{ row.order_no || '采购单号待核' }}</strong><div>采购人 {{ row.person_name || '未提供' }} · 在途 {{ quantity(row.pending_quantity) }}</div></template>
        </div>
        <p v-if="rowsFor(node.key).length > 4">另有 {{ rowsFor(node.key).length - 4 }} 条，点击节点查看全部。</p>
        <p v-if="!rowsFor(node.key).length && !brief(node).length">暂无关联明细；占用不为零时请刷新并核对库存流水。</p>
      </el-popover>
    </div>
    <div class="flow-legend"><span>本地线：采购 → 本地实物 → FBS 占用／安全保障／可用</span><span>FBP 线：申请 → 确认占用 → 发仓；官方实物单独核实</span></div>
    <div class="flow-fbp-toolbar"><span>{{ fbpSyncing ? 'FBP 正在后台同步，本地库存可正常查看' : fbpLoading ? '正在读取 FBP 已保存库存' : canSyncFbp ? '每次打开明细后自动同步一次 FBP，零库存 SKU 不展开' : '只读查看已保存的 FBP 库存，零库存 SKU 不展开' }}</span><el-button v-if="canSyncFbp" size="small" type="primary" :loading="fbpSyncing" :disabled="fbpLoading" @click="emit('sync-fbp')">{{ fbpError ? '重试同步 FBP' : '同步 FBP 库存' }}</el-button><el-button link type="primary" @click="openDetails('fbp-physical')">查看有库存 SKU</el-button><el-button link type="primary" @click="openDetails('fbp-history')">全部 FBP 单据</el-button></div>
    <div v-if="fbpError" class="flow-fbp-error"><span>FBP 数据：{{ fbpError }}；本地库存与上次 FBP 快照保留</span><el-button link type="primary" :disabled="fbpLoading" @click="emit('retry-fbp')">重新读取</el-button></div>
    <section v-if="activeNode" ref="detail" :id="detailId" class="flow-node-detail" role="region" :aria-label="`${activeNode.label}明细`" tabindex="-1" aria-live="polite">
      <div class="flow-heading"><h4>{{ activeNode.label }} · {{ activeNode.display || quantity(activeNode.value) }}</h4><el-button text @click="selected = ''">收起</el-button></div>
      <div class="flow-action-buttons">
        <el-button v-if="['requests','orders','safety','application','free'].includes(selected)" type="primary" plain @click="emit('workflow-action','request',({orders:'real_order',safety:'local_safety',application:'fbp_stock'})[selected]||'')">提交采购申请</el-button>
        <el-button v-if="['requests','incoming','purchase-confirm'].includes(selected)" @click="emit('workflow-action','purchase')">登记实际采购</el-button>
        <el-button v-if="['incoming','receiving'].includes(selected)" @click="emit('workflow-action','receive')">登记入库</el-button>
        <el-button v-if="selected==='physical' && canSyncFbp" @click="emit('stocktake')">更新本地库存</el-button>
        <el-button v-if="['application','fbp-physical','free'].includes(selected)" @click="emit('workflow-action','fbp')">创建FBP备货申请</el-button>
      </div>
      <el-table v-if="selected==='requests'" :data="rowsFor(selected)" empty-text="暂无申请；系统推荐需由人员确认提交"><el-table-column prop="id" label="申请编号" width="110"/><el-table-column prop="applicant_name" label="提出人"/><el-table-column prop="quantity" label="申请件数"/><el-table-column prop="status" label="状态"/><el-table-column prop="request_reason_note" label="说明"/></el-table>
      <p v-for="line in brief(activeNode)" :key="line">{{ line }}</p>
      <el-table v-if="['orders', 'assigned'].includes(selected)" :data="rowsFor(selected)" max-height="340" empty-text="暂无待发订单">
        <el-table-column prop="shop_name" label="店铺" min-width="120" /><el-table-column prop="posting_number" label="订单号" min-width="190" /><el-table-column prop="quantity" label="需求" width="80" /><el-table-column prop="stock_quantity" label="现货覆盖" width="100" /><el-table-column prop="incoming_quantity" label="在途覆盖" width="100" /><el-table-column label="操作" width="100"><template #default="{ row }"><el-button link type="primary" @click="navigateOrder(row)">打开订单</el-button></template></el-table-column>
      </el-table>
      <el-table v-else-if="['application', 'locked', 'dispatch', 'fbp-history'].includes(selected)" :data="rowsFor(selected)" max-height="340" empty-text="暂无关联申请；现有占用请到库存流水核对">
        <el-table-column prop="order_no" label="FBP 申请单" min-width="170" /><el-table-column prop="shop_name" label="店铺" min-width="110" /><el-table-column prop="applicant_name" label="申请人" width="100" /><el-table-column prop="ozon_sku" label="SKU" min-width="130" /><el-table-column prop="requested_quantity" label="申请实物数" width="110" /><el-table-column prop="locked_quantity" label="确认占用" width="100" /><el-table-column label="状态" width="110"><template #default="{ row }">{{ statusText(row.status) }}</template></el-table-column><el-table-column label="提交／审核／结束（北京）" min-width="210"><template #default="{ row }"><div>提交 {{ time(row.submitted_at) }}</div><div>审核 {{ time(row.reviewed_at) }}</div><div v-if="row.closed_at">结束 {{ time(row.closed_at) }}</div></template></el-table-column><el-table-column label="操作" width="110"><template #default="{ row }"><el-button link type="primary" @click="navigateApplication(row)">打开申请单</el-button></template></el-table-column>
      </el-table>
      <InventoryFbpSkuTable v-else-if="selected === 'fbp-physical'" :rows="positiveFbpRows" :product-id="Number(ledger.product.id)" />
      <el-table v-else-if="selected === 'safety' && rowsFor(selected).length" :data="rowsFor(selected)" max-height="340" empty-text="尚无可核对的 SKU 预测数据">
        <el-table-column prop="shop_name" label="店铺" min-width="120" /><el-table-column prop="ozon_sku" label="SKU" min-width="140" /><el-table-column label="本地日均" width="110"><template #default="{ row }">{{ Number(row.local_daily_sales || 0).toFixed(2) }}</template></el-table-column><el-table-column label="每套含实物" width="110" prop="per_set_quantity" /><el-table-column prop="status" label="供货判断" min-width="150" /><el-table-column label="官方同步（北京）" min-width="180"><template #default="{ row }">{{ time(row.synced_at) }}</template></el-table-column>
      </el-table>
      <template v-else-if="['incoming', 'incoming-free','receiving','purchase-confirm'].includes(selected)">
        <el-table :data="purchases" max-height="340" empty-text="暂无采购在途"><el-table-column prop="order_no" label="采购单" min-width="180" /><el-table-column prop="person_name" label="采购人" min-width="100" /><el-table-column prop="pending_quantity" label="在途件数" width="110" /><el-table-column label="采购时间（北京）" min-width="180"><template #default="{ row }">{{ time(row.purchased_at) }}</template></el-table-column></el-table>

      </template>
      <el-button v-if="activeNode.tab && !(inventoryMode && activeNode.tab === 'purchases')" link type="primary" @click="emit('select-tab', ['incoming', 'incoming-free','receiving','purchase-confirm'].includes(selected) ? 'incoming-purchases' : activeNode.tab)">查看原有{{ { movements: '库存流水', purchases: '采购与成本', current: '订单分配' }[activeNode.tab] }}明细</el-button>
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
.flow-canvas { position: relative; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); grid-template-rows: repeat(4, 108px); gap: 42px 28px; padding: 38px 0 45px; background-image: radial-gradient(var(--el-border-color-lighter) .7px, transparent .7px); background-size: 18px 18px; }
.flow-connectors { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.flow-connectors path { stroke: var(--el-color-primary-light-3); stroke-width: 1.5; fill: none; }
.flow-connectors .flow-arrow-head { fill: var(--el-color-primary-light-3); stroke: none; }
.flow-edge-label rect{fill:var(--el-bg-color-overlay);stroke:var(--el-border-color-lighter)}.flow-edge-label text{fill:var(--el-text-color-secondary);font-size:11px}.flow-connectors path.is-planned { stroke-dasharray: 5 4; }
.flow-node { position: relative; z-index: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 7px; min-width: 0; padding: 10px 8px; border: 1px solid var(--el-border-color); border-radius: 8px; background: var(--el-bg-color-overlay); color: var(--el-text-color-primary); font: inherit; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
.flow-node strong { font-size: clamp(16px, 1.2vw, 23px); font-weight: 600; font-variant-numeric: tabular-nums; }
.flow-node small { font-size: 11px; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
.flow-node.is-primary { background: var(--el-color-primary-light-9); border-color: var(--el-color-primary-light-5); }
.flow-node.is-planned { border-style: dashed; }
.flow-node:hover, .flow-node:focus-visible, .flow-node.is-selected { border-color: var(--el-color-primary); box-shadow: 0 0 0 2px var(--el-color-primary-light-8); }
.flow-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 18px; margin-top: 6px; }
.flow-fbp-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 12px 0; font-size: 12px; color: var(--el-text-color-secondary); }
.flow-fbp-error { color: var(--el-color-warning); font-size: 13px; }
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

<style scoped>
.flow-node.is-danger{border-color:var(--el-color-danger);box-shadow:inset 0 3px var(--el-color-danger)}.flow-node.is-warning{border-color:var(--el-color-warning);box-shadow:inset 0 3px var(--el-color-warning)}.flow-node.is-success{border-color:var(--el-color-success)}.flow-node.is-opportunity{border-color:var(--el-color-primary)}.flow-action-buttons{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
</style>
