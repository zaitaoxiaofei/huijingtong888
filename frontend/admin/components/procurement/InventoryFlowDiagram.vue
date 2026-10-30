<script setup>
import { Box, Van, ShoppingCart, Document, Lock, House, Warning, CircleCheck, Tickets, Goods, SoldOut } from '@element-plus/icons-vue';
import InventoryNodeRecords from './InventoryNodeRecords.vue';
import InventoryFbpSkuTable from './InventoryFbpSkuTable.vue';
import { defineAsyncComponent, computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import {procurementArrivalStage} from '../../../../src/shared/inventory-procurement-stage.js';
import { inventoryWorkflow } from '../../../../src/shared/inventory-workflow.js';
import { useRouter } from 'vue-router';
import { shanghaiDateTimeText } from '../../utils/shanghai-date.js';

const InventoryFbpReceiptReview=defineAsyncComponent(()=>import('../inventory/InventoryFbpReceiptReview.vue'));
const props = defineProps({ ledger: { type: Object, required: true }, workflow: Object, inventoryMode: Boolean, fbpLoading: Boolean, fbpSyncing: Boolean, canSyncFbp: Boolean, fbpError: { type: String, default: '' } });
const emit = defineEmits(['select-tab', 'navigate', 'retry-fbp', 'sync-fbp','workflow-action','stocktake','saved']);
const router = useRouter();
const selected = ref('');
const detail = ref(null);
const detailId = `inventory-flow-detail-${useId()}`;
const summary = computed(() => props.ledger.flow_summary || {});
const facts = computed(() => summary.value.unavailable ? {} : summary.value);
const quantity = value => value == null || !Number.isFinite(Number(value)) ? '待核对' : `${Number(value)} 件`;
const time = value => value ? shanghaiDateTimeText(value) : '待核对';
const statusText = status => ({ pending:'待审批',submitted:'待审批',suggested:'待审批',purchased:'已采购',merged:'待采购',inbound_done:'已入库',done:'已完成',draft: '草稿', pending_review: '待审核', approved: '已审核待发', ozon_created: '已建发仓单', sent: '已发出', completed: '已完成入仓', rejected: '已拒绝', cancelled: '已取消' }[status] || status || '待核对');
const currentOrders = computed(() => facts.value.orders || (props.ledger.orders || []).filter(row => row.needs_fulfillment));
const applications = computed(() => summary.value.applications || []);
const official = computed(() => props.ledger.fbp_inventory);
const fbpCoverage = computed(() => {
  const rows = official.value?.rows || [];
  return `${new Set(rows.map(row => row.shop_id)).size} 家店铺 · ${new Set(rows.map(row => `${row.shop_id}:${row.ozon_sku}`)).size} 个 SKU`;
});
const positiveFbpRows = computed(() => (official.value?.rows || []).filter(row => [row.present, row.available, row.reserved].some(value => Number(value) > 0)));
const purchases = computed(() => (facts.value.purchases || props.ledger.purchases || []).filter(row => Number(row.pending_quantity) > 0));
const workflowState=computed(()=>props.workflow||inventoryWorkflow(props.ledger));
function nodeStatus(key) {
  if(key==='incoming'&&purchases.value.some(r=>Number(r.unarrived_quantity)>0&&procurementArrivalStage({...r,status:'pending_arrival'}).overdue))return 'danger';
  const type=({orders:'real_order',safety:'local_safety'})[key];
  if(type)return workflowState.value.demands.find(d=>d.key===type)?.status;
  if(key==='free')return workflowState.value.local_stock_status||workflowState.value.stock_status;
  if(['fbp-physical','fbp-safety'].includes(key))return workflowState.value.fbp?.status==='warning'?'warning':workflowState.value.fbp?.status==='success'?'success':'';
  return '';
}
const transfers = computed(() => workflowState.value.transfers || summary.value.transfers || []);
const receiptRows = computed(() => transfers.value.filter(row => Number(row.listed_quantity) > 0));
const fbpReserved = computed(() => {
  const rows = official.value?.rows;
  return !official.value?.incomplete && rows?.length && rows.every(row => row.reserved != null)
    ? rows.reduce((sum,row)=>sum+Number(row.reserved)*Number(row.per_set_quantity||1),0) : null;
});
const nodes = computed(() => [
 {key:'requests',label:'需求与采购申请',value:workflowState.value.purchase_quantity,hint:'先调配现有货源，再确认采购',icon:Tickets,lane:'purchase'},
 {key:'purchase-confirm',label:'确认采购',display:'登记已下单',hint:'实际采购后进入在途',icon:ShoppingCart,lane:'purchase'},
 {key:'incoming',label:'采购在途',value:props.ledger.incoming_quantity,hint:'到货前不能算现货',icon:Van,lane:'purchase',moving:Number(props.ledger.incoming_quantity)>0,tab:'purchases'},
 {key:'receiving',label:'验货收货',display:'登记入库',hint:'验收合格后增加本地实物',icon:CircleCheck,lane:'purchase'},
 {key:'physical',label:'本地实物',value:props.ledger.physical_estimate,hint:'点击更新实物数量',icon:Box,lane:'local',tab:'movements',primary:true},
 {key:'orders',label:'① FBS订单保障',value:props.ledger.open_order_demand,hint:`本地仓履约${gapText('real_order')}`,icon:Document,lane:'local',tab:'current'},
 {key:'safety',label:'② 本地安全保障',value:facts.value.safety,hint:`保障 ${facts.value.local_days??'待核'} 天${gapText('local_safety')}`,icon:CircleCheck,lane:'local'},
 {key:'free',label:'本地可用库存',value:facts.value.free,hint:'扣除本地订单、保障及FBP锁定',icon:Goods,lane:'local',primary:true},
 {key:'application',label:'FBP备货申请',value:workflowState.value.requested,hint:'提交申请，还未锁定本地货',icon:Tickets,lane:'fbp'},
 {key:'locked',label:'仓库确认与锁定',value:props.ledger.fbp_reserved,hint:'审核通过后锁定 · 发出才扣实物',icon:Lock,lane:'fbp',primary:true},
 {key:'dispatch',label:'发往FBP · 在途',value:workflowState.value.fbp?.in_transit,hint:'本地仓发出，不是FBP销售发货',icon:Van,lane:'fbp',moving:workflowState.value.fbp?.in_transit>0},
 {key:'receipt',label:'到仓签收／入库',display:receiptRows.value.length?`${receiptRows.value.length} 批记录`:'查看入仓记录',hint:'签收后仍以平台可用状态为准',icon:CircleCheck,lane:'fbp'},
 {key:'fbp-physical',label:'FBP可用库存',display:props.fbpLoading?'正在核对':props.fbpError?'同步未完成':official.value?.incomplete?'部分未同步':'',value:official.value?.incomplete?null:official.value?.available,hint:'官方可售数量 · 独立于本地仓',icon:House,lane:'fbp',primary:true},
 {key:'fbp-orders',label:'FBP订单占用',value:fbpReserved.value,hint:'从FBP可用库存出单',icon:Document,lane:'fbp'},
 {key:'fbp-fulfil',label:'FBP仓销售发货',display:'平台仓履约',hint:'销售消耗后继续核对可用库存',icon:SoldOut,lane:'fbp'},
 {key:'fbp-safety',label:'FBP安全库存目标',value:workflowState.value.fbp?.safety,hint:'低于目标先补货，货源不足再采购',icon:Warning,lane:'alert'}
]);
const lanes = [
 {key:'purchase',title:'采购与到货',hint:'采购到货验收后，才进入本地实物'},
 {key:'local',title:'本地仓 · FBS',hint:'本地订单优先，其次安全保障，剩余可用于调拨FBP'},
 {key:'fbp',title:'FBP补货与销售',hint:'本地调拨 → 平台签收入库 → 官方可用 → FBP订单履约'}
];
const laneNodes = key => nodes.value.filter(node => node.lane === key);
const canvas = ref(null), autoFit=ref(true), graphScale=ref(1);
const connections = ref([]);
const canvasSize = ref({ width: 0, height: 0 });
const arrowId = `inventory-arrow-${useId().replace(/[^a-z0-9-]/gi,'')}`;
let observer, frame;
// Measure the rendered nodes so connectors follow resizing, translated text and
// delayed stock updates. The graph is a single scrollable map on narrow screens.
function drawConnections() {
  const root = canvas.value;
  if (!root) return;
  const bounds = root.getBoundingClientRect();
  const fitScale=autoFit.value?Math.min(1,Math.max(.6,(window.innerHeight-bounds.top-64)/root.offsetHeight)):1;
  if(Math.abs(fitScale-graphScale.value)>.01){graphScale.value=fitScale;void nextTick(scheduleConnections);return;}
  const scale=bounds.width/root.offsetWidth;
  canvasSize.value = { width: root.offsetWidth, height: root.offsetHeight };
  const rect = element => { const r=element.getBoundingClientRect();return {left:(r.left-bounds.left)/scale,right:(r.right-bounds.left)/scale,top:(r.top-bounds.top)/scale,bottom:(r.bottom-bounds.top)/scale,x:(r.left-bounds.left+r.width/2)/scale,y:(r.top-bounds.top+r.height/2)/scale}; };
  const boxes = new Map([...root.querySelectorAll('[data-node]')].map(el=>{const box=rect(el);return [el.dataset.node,{...box,bottom:Math.max(box.bottom,...[...el.querySelectorAll('.flow-node-label,strong,small')].map(child=>rect(child).bottom)),icon:rect(el.querySelector('.flow-icon'))}];}));
  const port = (key,side) => { const b=boxes.get(key);return side==='left'?[b.icon.left-7,b.icon.y]:side==='right'?[b.icon.right+7,b.icon.y]:side==='top'?[b.x,b.top-6]:[b.x,b.bottom+6]; };
  const rounded = points => {
    let d=`M ${points[0].join(' ')}`;
    for(let i=1;i<points.length-1;i++){
      const [a,b,c]=[points[i-1],points[i],points[i+1]],distance=(u,v)=>Math.hypot(u[0]-v[0],u[1]-v[1]);
      const radius=Math.min(8,distance(a,b)/2,distance(b,c)/2);
      if(!radius)continue;
      const before=b.map((v,k)=>v+(a[k]-v)*radius/distance(a,b)),after=b.map((v,k)=>v+(c[k]-v)*radius/distance(b,c));
      d+=` L ${before.join(' ')} Q ${b.join(' ')} ${after.join(' ')}`;
    }
    return `${d} L ${points.at(-1).join(' ')}`;
  };
  const edges=[];
  const add=(from,to,points,{kind='stock',label='',labelAt}={})=>edges.push({key:`${from}-${to}`,from,to,kind,label,labelAt,path:rounded(points)});
  const across=(from,to)=>add(from,to,[port(from,'right'),port(to,'left')]);
  across('requests','purchase-confirm');across('purchase-confirm','incoming');across('incoming','receiving');
  for(const key of ['orders','safety']){
    const a=port('physical','right'),b=port(key,'left'),trunk=(a[0]+b[0])/2;
    add('physical',key,[a,[trunk,a[1]],[trunk,b[1]],b],{kind:'allocation'});
  }
  const a=port('physical','right'),b=port('free','left');
  add('physical','free',[a,b],{kind:'allocation',label:'扣除订单、保障及锁定后',labelAt:[a[0]+(b[0]-a[0])*.75,a[1]-14]});
  const purchase=rect(root.querySelector('[data-lane="purchase"]')),local=rect(root.querySelector('[data-lane="local"]'));
  const received=port('receiving','bottom'),physicalIn=port('physical','left');
  add('receiving','physical',[received,[received[0],purchase.bottom+15],[48,purchase.bottom+15],[48,physicalIn[1]],physicalIn],{label:'验收入库',labelAt:[root.offsetWidth/2,purchase.bottom+10]});
  const available=port('free','bottom'),application=port('application','left'),applicationSupply=[application[0],application[1]-9],applicationNeed=[application[0],application[1]+9];
  add('free','application',[available,[available[0],local.bottom+8],[40,local.bottom+8],[40,applicationSupply[1]],applicationSupply],{label:'可用货源调拨',labelAt:[root.offsetWidth/2,local.bottom+5]});
  const fbpKeys=['application','locked','dispatch','receipt','fbp-physical','fbp-orders','fbp-fulfil'];
  for(let i=1;i<fbpKeys.length;i++)across(fbpKeys[i-1],fbpKeys[i]);
  const feedback=rect(root.querySelector('.flow-fbp-feedback')),official=port('fbp-physical','bottom');
  add('fbp-physical','fbp-safety',[official,[official[0],feedback.top-6]],{kind:'feedback'});
  const replenish=workflowState.value.fbp?.replenish_quantity>0;
  add('fbp-safety','application',[[feedback.left+198,feedback.y],[28,feedback.y],[28,applicationNeed[1]],applicationNeed],{kind:replenish?'warning':'feedback',label:replenish?'低于目标先补货':workflowState.value.fbp?.known?(workflowState.value.fbp.shortage>0?'已有补货覆盖':'安全目标核对'):'库存待核对',labelAt:[feedback.left+105,feedback.y-10]});
  const request=port('requests','left');
  // Feedback is demand, never another physical deduction. Keep it outside the
  // warehouse paths and only show an actionable purchase gap.
  const demands=workflowState.value.demands||[];
  const purchaseGap=demands.find(d=>d.key==='fbp_stock')?.purchase_quantity>0;
  if(purchaseGap)add('fbp-safety','requests',[[feedback.left+14,feedback.bottom-14],[12,feedback.bottom-14],[12,request[1]],request],{kind:'warning'});
  for(const key of ['orders','safety'])if(demands.find(d=>d.key===(key==='orders'?'real_order':'local_safety'))?.purchase_quantity>0){
    const start=port(key,key==='orders'?'top':'bottom'),y=key==='orders'?boxes.get(key).top-14:local.bottom-29;
    add(key,'requests',[start,[start[0],y],[12,y],[12,request[1]],request],{kind:'warning'});
  }
  connections.value=edges;
}
function scheduleConnections(){cancelAnimationFrame(frame);frame=requestAnimationFrame(drawConnections);}
onMounted(()=>{window.addEventListener('resize',scheduleConnections);observer=new ResizeObserver(scheduleConnections);observer.observe(canvas.value);for(const el of canvas.value.querySelectorAll('[data-node],.flow-fbp-feedback'))observer.observe(el);scheduleConnections();});
watch(nodes,async()=>{await nextTick();scheduleConnections();});
watch(autoFit,()=>nextTick(scheduleConnections));
onBeforeUnmount(()=>{window.removeEventListener('resize',scheduleConnections);observer?.disconnect();cancelAnimationFrame(frame);});
function gapText(type){const demand=workflowState.value.demands.find(d=>d.key===type);return demand?.purchase_quantity>0?` · 需采购 ${demand.purchase_quantity} 件`:demand?.physical_gap>0?' · 等待到货':'';}
const activeNode = computed(() => selected.value === 'fbp-history' ? { key: 'fbp-history', label: '全部 FBP 单据', display: `${new Set(applications.value.map(row => row.order_id)).size} 单` } : nodes.value.find(node => node.key === selected.value));
function rowsFor(key) {
  if(key==='requests')return workflowState.value.requests||[];
  if (['orders', 'assigned'].includes(key)) return currentOrders.value;
  if (['application', 'locked'].includes(key)) return applications.value.filter(row => key === 'locked' ? Number(row.locked_quantity) > 0 : !['sent', 'completed', 'cancelled', 'rejected'].includes(row.status));
  if (key === 'fbp-history') return applications.value;
  if (key === 'fbp-physical') return positiveFbpRows.value;
  if (key === 'dispatch') return transfers.value.filter(row => Number(row.remaining_quantity)>0);
  if (key === 'receipt') return receiptRows.value;
  if (['fbp-orders','fbp-fulfil'].includes(key)) return positiveFbpRows.value;
  if (key === 'fbp-safety') return workflowState.value.fbp?.rows || [];
  if (key === 'safety') return facts.value.safety_rows || [];
  if (['incoming', 'incoming-free','receiving','purchase-confirm'].includes(key)) return purchases.value;
  return [];
}
function navigateOrder(row) { selected.value='';emit('navigate'); router.push({ path: '/orders', query: { orderId: row.order_id } }); }
function navigateApplication(row) { selected.value='';emit('navigate'); router.push({ path: '/inventory/fbp-replenishment', query: { orderId: row.order_id } }); }
async function openDetails(key) {
  selected.value = key;
  await nextTick();
  detail.value?.focus({ preventScroll: true });

}
function selectNode(node) {
  if(node.key==='free')return;
  if(node.key==='physical' && props.canSyncFbp){emit('stocktake');return;}
  void openDetails(node.key);
}

function brief(node) {
  if (node.key === 'fbp-physical') return ['这里展示平台确认可售的 FBP 可用库存；发运在途、签收记录都不提前加到可用。', `官方实物 ${quantity(official.value?.present)}，官方可用 ${quantity(official.value?.available)}；二者含义不同。`, `${fbpCoverage.value}；${props.fbpLoading ? '正在拉取中，当前明细为上次快照' : props.fbpError ? '本次同步未完成，不能视为全部店铺核实成功' : '按绑定的全部 SKU 汇总'}。`, '按每套组成折算当前库存的实物件数；FBP 订单由平台仓履约，不重复扣本地库存，也不在官方可用上重复扣订单。',
    official.value?.incomplete ? `汇总不完整，已同步部分 ${quantity(official.value?.present)}；未同步 SKU 保持待核对，不按零库存处理。` : '仅展开有库存的店铺 SKU；已占用但仍有实物的 SKU 也会展示。',
    `最早核实时间：${time(official.value?.synced_at)}（北京）；部分店铺失败时保留各自上次快照。`];
  if (node.key === 'dispatch') return ['本地仓已发出但尚未确认全部入仓的调拨，不是销售订单发货。', '发运后扣本地实物；在途不增加FBP可用。'];
  if (node.key === 'receipt') return ['以下为最近入仓确认记录，不是当前可售数量；入仓确认不自动推算或覆盖官方可用库存。'];
  if (['fbp-orders','fbp-fulfil'].includes(node.key)) return ['FBP订单从平台可用库存占用、发货；与本地仓向FBP发运的调拨单分开。', '官方可用已反映平台占用，界面不重复扣减。'];
  if (node.key === 'fbp-safety') return ['按各店铺SKU的FBP/OGR历史销量和补货周期核对安全目标；FBS销量不混入FBP目标。', '可用低于目标时提示补货；先扣除已在途、已确认备货，再用本地可用与采购在途覆盖，剩余才申请采购。'];
  if (node.key === 'application') return ['当前未发出的申请；点击下方“全部 FBP 单据”可查看已拒绝、已取消及完整流转状态。'];
  if (node.key === 'physical') return ['实物包含已打包但尚未实际发出的货。', `最近核实：${time(props.ledger.last_stocktake_at)}`];
  if (node.key === 'free') return [facts.value.free == null ? '保障数据不完整，不能把未占用余量全部视为可发 FBP。' : `${props.ledger.physical_estimate} − ${props.ledger.open_order_demand} − ${facts.value.safety} − ${props.ledger.fbp_reserved} = ${facts.value.free}`, `现行未占用余量：${quantity(props.ledger.available_estimate)}；尚未扣未来保障。`];
  if (node.key === 'safety' && facts.value.daily_consumption != null) return [`近7个完整自然日消耗 ${facts.value.consumed_7d} 件，日均 ${Number(facts.value.daily_consumption).toFixed(2)} 件 × ${facts.value.local_days} 天，向上取整。`, `生产 ${facts.value.production_days} 天＋到本地 ${facts.value.local_shipping_days} 天，至少保障7天；节假日影响已计入。`, facts.value.estimated_dates ? `${facts.value.estimated_dates} 条缺发运时间，按下单时间估计；不含待发订单及FBP/OGR消耗。` : '不含待发订单及FBP/OGR消耗；历史缺发运时间时按履约记录中的签收/下单日期估计，FBP未同步不减少本地保障。'];
  if (node.key === 'safety') return [facts.value.safety_status || '预测数据暂不可用', `本地保障 ${facts.value.local_days ?? '待核'} 天；FBP 保障 ${facts.value.fbp_days ?? '待核'} 天。`];
  if (node.key === 'assigned') return ['已分配在途只表示未来覆盖，不能计入可立即发出的实物。'];
  if (node.key === 'incoming-free') return ['只减本地订单已分配的在途；其他用途及历史关联仍需查看采购明细，不能直接视为可发 FBP。'];
  return [];
}
watch(() => props.ledger.product?.id, () => { selected.value = ''; });
</script>

<template>
  <section class="inventory-flow-diagram" aria-label="库存流转与占用">
    <div class="flow-heading"><h3>库存流转与占用</h3><div class="flow-action-buttons"><slot name="records"/><el-button size="small" @click="autoFit=!autoFit">{{autoFit?'原比例':'适合窗口'}}</el-button><el-button size="small" @click="openDetails('fbp-physical')">FBP库存明细</el-button><el-button size="small" @click="openDetails('fbp-history')">全部FBP单据</el-button><el-button v-if="canSyncFbp" size="small" :loading="fbpSyncing" @click="emit('sync-fbp')">同步FBP库存</el-button><el-popover trigger="click" width="340"><template #reference><el-button size="small">图例与说明</el-button></template><p>实线：实物流转与分配；虚线：需求反馈，不重复扣库存。</p><p>保障是预测目标。在途不能直接发出；FBP以官方快照为准。</p><p>{{fbpSyncing?'FBP正在后台同步':'点击节点查看详情，点击本地实物盘点。'}}</p></el-popover></div></div>
    <el-alert v-if="summary.unavailable" :title="summary.message" type="warning" :closable="false" />
    <p class="flow-mobile-hint">左右滑动查看完整流程，点击图标查看明细</p>
    <div class="flow-map-scroll" role="region" aria-label="库存流程图，可横向滚动" tabindex="0">
    <div ref="canvas" class="flow-canvas" :style="{zoom:graphScale}">
      <svg class="flow-connections" :width="canvasSize.width" :height="canvasSize.height" aria-hidden="true">
        <defs><marker v-for="kind in ['stock','allocation','feedback','warning']" :id="`${arrowId}-${kind}`" :key="kind" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" :class="`flow-arrow is-${kind}`"/></marker></defs>
        <g v-for="edge in connections" :key="edge.key" :data-edge="edge.key" :class="`flow-edge is-${edge.kind}`">
          <path :d="edge.path" :marker-end="`url(#${arrowId}-${edge.kind})`"/>
          <text v-if="edge.label" :x="edge.labelAt[0]" :y="edge.labelAt[1]" text-anchor="middle">{{edge.label}}</text>
        </g>
      </svg>
      <div v-for="lane in lanes" :key="lane.key" class="flow-lane" :data-lane="lane.key">
        <div class="flow-lane-heading"><strong>{{lane.title}}</strong><span>{{lane.hint}}</span></div>
        <div class="flow-stages">
          <el-popover v-for="node in laneNodes(lane.key)" :key="node.key" placement="top" :width="380" trigger="hover" :show-after="240" popper-class="inventory-flow-popover">
            <template #reference>
              <button type="button" class="flow-node" :data-node="node.key" :class="{ 'is-primary':node.primary,'is-selected':selected===node.key,'is-moving':node.moving,[`is-${nodeStatus(node.key)}`]:!!nodeStatus(node.key) }" :aria-expanded="selected===node.key" :aria-controls="detailId" @click="selectNode(node)">
                <span class="flow-icon" aria-hidden="true"><component :is="node.icon" /></span>
                <span class="flow-node-label">{{node.label}}</span><strong>{{node.display||quantity(node.value)}}</strong><small>{{node.hint}}</small>
              </button>
            </template>
            <h4>{{node.label}} · {{node.display||quantity(node.value)}}</h4><p v-for="line in brief(node)" :key="line">{{line}}</p>
            <div v-for="(row,index) in rowsFor(node.key).slice(0,3)" :key="row.id||row.item_id||index" class="flow-hover-row">
              <template v-if="node.key==='orders'"><strong>{{row.shop_name}} · {{row.posting_number}}</strong><div>需求 {{quantity(row.quantity)}} · 现货 {{quantity(row.stock_quantity)}}</div></template>
              <template v-else-if="node.key==='requests'"><strong>{{row.applicant_name||'历史申请人待核对'}} · {{time(row.created_at)}}</strong><div>{{statusText(row.status)}} · {{quantity(row.quantity)}}</div><div>{{row.reason_summary||row.request_reason_note||'采购申请'}}</div></template>
              <template v-else-if="['application','locked'].includes(node.key)"><strong>{{row.order_no}} · {{row.shop_name}}</strong><div>申请人 {{row.applicant_name||'未提供'}} · {{statusText(row.status)}}</div></template>
              <template v-else-if="['dispatch','receipt'].includes(node.key)"><strong>{{row.shop_name}} · {{row.ozon_sku}}</strong><div>申请 {{time(row.application_at)}} · 发运 {{time(row.shipped_at)}}</div><div>预计到仓 {{time(row.expected_arrival_at)}} · 已确认 {{quantity(row.confirmed_quantity)}} · 待确认 {{quantity(row.remaining_quantity)}}</div></template>
              <template v-else-if="['fbp-physical','fbp-orders','fbp-fulfil'].includes(node.key)"><strong>{{row.shop_name}} · {{row.ozon_sku}}</strong><div>可用 {{row.available}} 套 · 平台占用 {{row.reserved}} 套</div></template>
              <template v-else><strong>{{row.order_no||row.shop_name||'库存核对'}}</strong><div>{{row.pending_quantity==null?'点击查看详细记录':`采购在途 ${quantity(row.pending_quantity)}`}}</div></template>
            </div>
            <p v-if="!rowsFor(node.key).length && !brief(node).length">暂无关联记录；点击查看核对说明与操作。</p>
          </el-popover>
          <div v-if="lane.key==='local'" class="flow-allocation-note"><strong>按用途分配</strong><p>订单与保障分别占用本地实物</p><p>剩余可用货源可申请调拨到FBP</p></div>
        </div>
      </div>
      <div class="flow-fbp-feedback" :class="`is-${workflowState.fbp?.status||'unknown'}`">
        <span class="flow-feedback-icon" aria-hidden="true"><Warning v-if="workflowState.fbp?.shortage>0"/><CircleCheck v-else/></span>
        <div class="flow-feedback-copy"><strong>{{workflowState.fbp?.known?(workflowState.fbp.shortage>0?'FBP可用低于安全库存目标':'FBP可用库存达到当前安全目标'):'FBP安全库存正在核对'}}</strong>
          <p v-if="workflowState.fbp?.known">可用 {{quantity(workflowState.fbp.available)}} · 安全目标 {{quantity(workflowState.fbp.safety)}} · 低于目标 {{quantity(workflowState.fbp.shortage)}}<span v-if="workflowState.fbp.shortage>0">；扣除在途及已确认备货后，还需补货 {{quantity(workflowState.fbp.replenish_quantity)}}</span></p>
          <p v-else>先显示本地库存；FBP官方库存和销量核对完成后再判断，不把未知数量当零。</p>
        </div>
        <div class="flow-feedback-actions"><el-button link type="primary" @click="openDetails('fbp-safety')">核对安全目标</el-button><el-button v-if="workflowState.fbp?.replenish_quantity>0" type="primary" plain @click="emit('workflow-action','fbp')">提交FBP补货需求</el-button><el-button v-if="workflowState.demands.find(d=>d.key==='fbp_stock')?.purchase_quantity>0" type="warning" plain @click="emit('workflow-action','request','fbp_stock')">提交采购申请</el-button></div>
      </div>
    </div>
    </div>
    <div v-if="fbpError" class="flow-fbp-error"><span>FBP 数据：{{ fbpError }}；本地库存与上次 FBP 快照保留</span><el-button link type="primary" :disabled="fbpLoading" @click="emit('retry-fbp')">重新读取</el-button></div>
    <el-dialog @opened="detail?.focus({preventScroll:true})" :model-value="!!activeNode" @update:model-value="value=>{if(!value)selected=''}" :title="activeNode?.label" width="84vw" top="6vh" append-to-body destroy-on-close><section v-if="activeNode" ref="detail" :id="detailId" class="flow-node-detail" role="region" :aria-label="`${activeNode.label}明细`" tabindex="-1" aria-live="polite">
      <div class="flow-heading"><h4>{{ activeNode.label }} · {{ activeNode.display || quantity(activeNode.value) }}</h4><el-button text @click="selected = ''">收起</el-button></div>
      <div class="flow-action-buttons">
        <el-button v-if="['requests','orders','safety','application','free'].includes(selected)" type="primary" plain @click="emit('workflow-action','request',({orders:'real_order',safety:'local_safety',application:'fbp_stock'})[selected]||'')">提交采购申请</el-button>
        <el-button v-if="['requests','incoming','purchase-confirm'].includes(selected)" @click="emit('workflow-action','purchase')">登记实际采购</el-button>
        <el-button v-if="['incoming','receiving'].includes(selected)" @click="emit('workflow-action','receive')">登记入库</el-button>
        <el-button v-if="selected==='physical' && canSyncFbp" @click="emit('stocktake')">更新本地库存</el-button>
        <el-button v-if="['application','fbp-physical','fbp-safety','free'].includes(selected)" @click="emit('workflow-action','fbp')">创建FBP备货申请</el-button>
      </div>
      <InventoryNodeRecords v-if="['requests','purchase-confirm','incoming','receiving','orders','safety'].includes(selected)" :node="selected" :product-id="Number(ledger.product.id)" @open-order="navigateOrder" @saved="emit('saved')" @receive="emit('workflow-action','receive')" />
      <p v-for="line in brief(activeNode)" :key="line">{{ line }}</p>
      <el-table v-if="selected==='assigned'" :data="rowsFor(selected)" max-height="340" empty-text="暂无待发订单">
        <el-table-column prop="shop_name" label="店铺" min-width="120" /><el-table-column prop="posting_number" label="订单号" min-width="190" /><el-table-column prop="quantity" label="需求" width="80" /><el-table-column prop="stock_quantity" label="现货覆盖" width="100" /><el-table-column prop="incoming_quantity" label="在途覆盖" width="100" /><el-table-column label="操作" width="100"><template #default="{ row }"><el-button link type="primary" @click="navigateOrder(row)">打开订单</el-button></template></el-table-column>
      </el-table>
      <el-table v-else-if="['application', 'locked', 'fbp-history'].includes(selected)" :data="rowsFor(selected)" max-height="340" empty-text="暂无关联申请；现有占用请到库存流水核对">
        <el-table-column prop="order_no" label="FBP 申请单" min-width="170" /><el-table-column prop="shop_name" label="店铺" min-width="110" /><el-table-column prop="applicant_name" label="申请人" width="100" /><el-table-column prop="ozon_sku" label="SKU" min-width="130" /><el-table-column prop="requested_quantity" label="申请实物数" width="110" /><el-table-column prop="locked_quantity" label="确认占用" width="100" /><el-table-column label="状态" width="110"><template #default="{ row }">{{ statusText(row.status) }}</template></el-table-column><el-table-column label="提交／审核／结束（北京）" min-width="210"><template #default="{ row }"><div>提交 {{ time(row.submitted_at) }}</div><div>审核 {{ time(row.reviewed_at) }}</div><div v-if="row.closed_at">结束 {{ time(row.closed_at) }}</div></template></el-table-column><el-table-column label="操作" width="110"><template #default="{ row }"><el-button link type="primary" @click="navigateApplication(row)">打开申请单</el-button></template></el-table-column>
      </el-table>
      <InventoryFbpReceiptReview v-else-if="['dispatch','receipt'].includes(selected)" :key="selected" :product-id="Number(ledger.product.id)" :initial-all="selected==='receipt'" @saved="emit('saved')" @navigate="selected='';emit('navigate')"/>
      <el-table v-else-if="selected==='fbp-safety'" :data="rowsFor(selected)" max-height="340" empty-text="FBP官方库存或销量尚未核实"><el-table-column prop="shop_name" label="店铺"/><el-table-column prop="ozon_sku" label="SKU"/><el-table-column prop="available" label="可用（套）"/><el-table-column prop="fbp_target" label="安全目标（套）"/><el-table-column prop="in_transit" label="在途（套）"/><el-table-column prop="committed_qty" label="已确认待发（套）"/><el-table-column prop="replenish_quantity" label="仍需补货（套）"/><el-table-column prop="per_set_quantity" label="每套实物件数"/></el-table>
      <InventoryFbpSkuTable v-else-if="['fbp-physical','fbp-orders','fbp-fulfil'].includes(selected)" :rows="positiveFbpRows" :product-id="Number(ledger.product.id)" />
      <template v-else-if="selected==='incoming-free'">
        <el-table :data="purchases" max-height="340" empty-text="暂无采购在途"><el-table-column prop="order_no" label="采购单" min-width="180" /><el-table-column prop="person_name" label="采购人" min-width="100" /><el-table-column prop="pending_quantity" label="在途件数" width="110" /><el-table-column label="采购时间（北京）" min-width="180"><template #default="{ row }">{{ time(row.purchased_at) }}</template></el-table-column></el-table>

      </template>
      <el-button v-if="activeNode.tab && !(inventoryMode && activeNode.tab === 'purchases')" link type="primary" @click="emit('select-tab', ['incoming', 'incoming-free','receiving','purchase-confirm'].includes(selected) ? 'incoming-purchases' : activeNode.tab);selected=''">查看原有{{ { movements: '库存流水', purchases: '采购与成本', current: '订单分配' }[activeNode.tab] }}明细</el-button>
    </section></el-dialog>
    <p v-if="ledger.physical_estimate < 0" class="flow-warning">实物推算为负，请先核对盘点和历史出库；当前不能确认可发数量。</p>

  </section>
</template>

<style scoped>
.inventory-flow-diagram{margin:8px 0;color:var(--el-text-color-primary)}.flow-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}.flow-heading h3,.flow-heading h4{margin:0}.flow-heading>span,.flow-footnote{font-size:12px;color:var(--el-text-color-secondary)}
.flow-map-scroll{overflow-x:auto;overscroll-behavior-x:contain;border:1px solid var(--el-border-color-lighter);border-radius:16px;margin-top:14px;background:var(--el-bg-color)}.flow-map-scroll:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}.flow-canvas{position:relative;isolation:isolate;display:grid;gap:18px;min-width:1050px;padding:12px 16px 12px 52px;box-sizing:border-box}.flow-connections{position:absolute;inset:0;z-index:1;pointer-events:none;overflow:visible}.flow-edge path{fill:none;stroke:var(--el-color-primary-light-3);stroke-width:1.6}.flow-edge.is-allocation path{stroke:var(--el-text-color-placeholder)}.flow-edge.is-feedback path,.flow-edge.is-warning path{stroke-dasharray:5 5}.flow-edge.is-feedback path{stroke:var(--el-color-info)}.flow-edge.is-warning path{stroke:var(--el-color-warning)}.flow-arrow.is-stock{fill:var(--el-color-primary-light-3)}.flow-arrow.is-allocation{fill:var(--el-text-color-placeholder)}.flow-arrow.is-feedback{fill:var(--el-color-info)}.flow-arrow.is-warning{fill:var(--el-color-warning)}.flow-edge text{font-size:11px;fill:var(--el-text-color-secondary);paint-order:stroke;stroke:var(--el-bg-color);stroke-width:5px;stroke-linejoin:round}
.flow-lane{position:relative;border:1px solid var(--el-border-color-lighter);border-radius:12px;padding:8px 12px 10px;background:var(--el-bg-color-overlay)}.flow-lane-heading{display:flex;align-items:baseline;flex-wrap:wrap;gap:12px;padding:0 4px 6px}.flow-lane-heading strong{font-size:14px}.flow-lane-heading span{font-size:12px;color:var(--el-text-color-secondary)}.flow-stages{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));column-gap:16px;align-items:start}.flow-node{position:relative;z-index:2;min-width:0;min-height:78px;display:flex;flex-direction:column;align-items:center;gap:3px;padding:4px 2px;border:1px solid transparent;border-radius:12px;background:transparent;color:var(--el-text-color-primary);font:inherit;cursor:pointer;transition:background .18s,border-color .18s}.flow-icon{position:relative;display:grid;place-items:center;flex:none;width:30px;height:30px;border-radius:16px;background:var(--el-fill-color-light);color:var(--el-color-primary);transition:transform .18s}.flow-icon svg{width:18px;height:18px}.flow-node-label{font-size:13px;font-weight:600;text-align:center}.flow-node strong{font-size:17px;font-variant-numeric:tabular-nums;text-align:center}.flow-node small{font-size:11px;line-height:1.5;color:var(--el-text-color-secondary);text-align:center;overflow-wrap:anywhere}.flow-node:hover,.flow-node:focus-visible,.flow-node.is-selected{background:var(--el-fill-color-light);border-color:var(--el-color-primary-light-5)}.flow-node:hover .flow-icon{transform:translateY(-2px)}.flow-node.is-primary .flow-icon{background:var(--el-color-primary-light-9)}.flow-node.is-success .flow-icon{color:var(--el-color-success);background:var(--el-color-success-light-9)}.flow-node.is-warning .flow-icon{color:var(--el-color-warning);background:var(--el-color-warning-light-9)}.flow-node.is-danger .flow-icon{color:var(--el-color-danger);background:var(--el-color-danger-light-9)}.flow-node.is-moving .flow-icon svg{animation:stock-transit 2.4s ease-in-out infinite}.flow-node.is-warning .flow-icon::after{content:'';position:absolute;right:0;top:0;width:6px;height:6px;border-radius:50%;background:var(--el-color-warning)}
[data-node="requests"]{grid-column:1}[data-node="purchase-confirm"]{grid-column:3}[data-node="incoming"]{grid-column:5}[data-node="receiving"]{grid-column:7}[data-lane="local"] .flow-stages{grid-template-rows:94px 94px;row-gap:24px;padding-bottom:10px}[data-node="physical"]{height:84px;grid-column:1;grid-row:1/3;align-self:center;transform:translateY(22px)}[data-node="orders"]{grid-column:3;grid-row:1}[data-node="safety"]{grid-column:3;grid-row:2}[data-node="free"]{height:84px;grid-column:5;grid-row:1/3;align-self:center;transform:translateY(22px)}.flow-allocation-note{grid-column:7;grid-row:1/3;align-self:center;font-size:11px;line-height:1.8;color:var(--el-text-color-secondary)}.flow-allocation-note strong{font-size:12px;color:var(--el-text-color-regular)}.flow-allocation-note p{margin:6px 0}
.flow-fbp-feedback{position:relative;display:flex;align-items:center;gap:14px;padding:8px 12px 8px 210px;border:1px solid var(--el-border-color-lighter);border-radius:12px;background:var(--el-fill-color-extra-light);min-height:58px;box-sizing:border-box}.flow-feedback-icon{flex:none;width:28px;height:28px;color:var(--el-color-info)}.flow-feedback-icon svg{width:100%;height:100%}.flow-feedback-copy,.flow-feedback-actions{position:relative;z-index:2}.flow-fbp-feedback.is-warning .flow-feedback-icon{color:var(--el-color-warning);animation:stock-warning 3s ease-in-out infinite}.flow-fbp-feedback.is-success .flow-feedback-icon{color:var(--el-color-success)}.flow-fbp-feedback p{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--el-text-color-secondary)}.flow-feedback-actions{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;max-width:210px;flex-shrink:0}.flow-fbp-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:12px 0;font-size:12px;color:var(--el-text-color-secondary)}.flow-fbp-error,.flow-warning{color:var(--el-color-warning);font-size:13px}.flow-node-detail{border-top:1px solid var(--el-border-color-lighter);margin-top:15px;padding-top:12px}.flow-node-detail p{font-size:13px}.flow-hover-row{border-top:1px solid var(--el-border-color-lighter);padding:9px 0;font-size:12px;overflow-wrap:anywhere}.flow-action-buttons{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}:global(.inventory-flow-popover){max-width:calc(100vw - 24px);box-sizing:border-box}.flow-map-legend{display:flex;gap:22px;flex-wrap:wrap;padding:10px 4px;font-size:11px;color:var(--el-text-color-secondary)}.flow-map-legend span{display:flex;align-items:center;gap:7px}.flow-map-legend span::before{content:'';width:22px;border-top:2px solid var(--el-color-primary-light-3)}.flow-map-legend .legend-allocation::before{border-color:var(--el-text-color-placeholder)}.flow-map-legend .legend-feedback::before{border-color:var(--el-color-info);border-top-style:dashed}.flow-mobile-hint{display:none;margin:12px 0 0;font-size:12px;color:var(--el-text-color-secondary)}
@keyframes stock-transit{0%,100%{transform:translateX(-2px)}50%{transform:translateX(3px)}}@keyframes stock-warning{0%,100%{opacity:1}50%{opacity:.55}}
@media(max-width:1180px){.flow-mobile-hint{display:block}}
@media(prefers-reduced-motion:reduce){.flow-node,.flow-icon{transition:none}.flow-node.is-moving .flow-icon svg,.flow-fbp-feedback.is-warning .flow-feedback-icon{animation:none}.flow-node:hover .flow-icon{transform:none}}
</style>
