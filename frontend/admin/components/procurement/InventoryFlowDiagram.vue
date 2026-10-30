<script setup>
import { Box, Van, ShoppingCart, Document, Lock, House, Warning, CircleCheck, Tickets, Goods, SoldOut } from '@element-plus/icons-vue';
import InventoryFbpSkuTable from './InventoryFbpSkuTable.vue';
import { computed, nextTick, ref, useId, watch } from 'vue';
import { inventoryWorkflow } from '../../../../src/shared/inventory-workflow.js';
import { useRouter } from 'vue-router';
import { shanghaiDateTimeText } from '../../utils/shanghai-date.js';

const props = defineProps({ ledger: { type: Object, required: true }, workflow: Object, inventoryMode: Boolean, fbpLoading: Boolean, fbpSyncing: Boolean, canSyncFbp: Boolean, fbpError: { type: String, default: '' } });
const emit = defineEmits(['select-tab', 'navigate', 'retry-fbp', 'sync-fbp','workflow-action','stocktake']);
const router = useRouter();
const selected = ref('');
const detail = ref(null);
const detailId = `inventory-flow-detail-${useId()}`;
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
const purchases = computed(() => (facts.value.purchases || props.ledger.purchases || []).filter(row => Number(row.pending_quantity) > 0));
const workflowState=computed(()=>props.workflow||inventoryWorkflow(props.ledger));
function nodeStatus(key) {
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
 {key:'physical',label:'本地实物',value:props.ledger.physical_estimate,hint:'双击盘点 · 点击流水',icon:Box,lane:'local',tab:'movements',primary:true},
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
    <div class="flow-heading"><h3>库存流转与占用</h3><span>悬浮看摘要 · 点击查看对应单据</span></div>
    <el-alert v-if="summary.unavailable" :title="summary.message" type="warning" :closable="false" />
    <div class="flow-canvas">
      <div v-for="lane in lanes" :key="lane.key" class="flow-lane" :data-lane="lane.key">
        <div class="flow-lane-heading"><strong>{{lane.title}}</strong><span>{{lane.hint}}</span></div>
        <div class="flow-stages">
          <el-popover v-for="node in laneNodes(lane.key)" :key="node.key" placement="top" :width="380" trigger="hover" :show-after="240" popper-class="inventory-flow-popover">
            <template #reference>
              <button type="button" class="flow-node" :data-node="node.key" :class="{ 'is-primary':node.primary,'is-selected':selected===node.key,'is-moving':node.moving,[`is-${nodeStatus(node.key)}`]:!!nodeStatus(node.key) }" :aria-expanded="selected===node.key" :aria-controls="detailId" @click="selectNode(node)" @dblclick="node.key==='physical' && canSyncFbp && emit('stocktake')">
                <span class="flow-icon" aria-hidden="true"><component :is="node.icon" /></span>
                <span class="flow-node-label">{{node.label}}</span><strong>{{node.display||quantity(node.value)}}</strong><small>{{node.hint}}</small>
              </button>
            </template>
            <h4>{{node.label}} · {{node.display||quantity(node.value)}}</h4><p v-for="line in brief(node)" :key="line">{{line}}</p>
            <div v-for="(row,index) in rowsFor(node.key).slice(0,3)" :key="row.id||row.item_id||index" class="flow-hover-row">
              <template v-if="node.key==='orders'"><strong>{{row.shop_name}} · {{row.posting_number}}</strong><div>需求 {{quantity(row.quantity)}} · 现货 {{quantity(row.stock_quantity)}}</div></template>
              <template v-else-if="['application','locked'].includes(node.key)"><strong>{{row.order_no}} · {{row.shop_name}}</strong><div>申请人 {{row.applicant_name||'未提供'}} · {{statusText(row.status)}}</div></template>
              <template v-else-if="['dispatch','receipt'].includes(node.key)"><strong>{{row.shop_name}} · {{row.ozon_sku}}</strong><div>入仓确认 {{quantity(row.confirmed_quantity)}} · 待入仓 {{quantity(row.remaining_quantity)}}</div></template>
              <template v-else-if="['fbp-physical','fbp-orders','fbp-fulfil'].includes(node.key)"><strong>{{row.shop_name}} · {{row.ozon_sku}}</strong><div>可用 {{row.available}} 套 · 平台占用 {{row.reserved}} 套</div></template>
              <template v-else><strong>{{row.order_no||row.shop_name||'库存核对'}}</strong><div>{{row.pending_quantity==null?'点击查看详细记录':`采购在途 ${quantity(row.pending_quantity)}`}}</div></template>
            </div>
            <p v-if="!rowsFor(node.key).length && !brief(node).length">暂无关联记录；点击查看核对说明与操作。</p>
          </el-popover>
        </div>
      </div>
      <div class="flow-fbp-feedback" :class="`is-${workflowState.fbp?.status||'unknown'}`">
        <span class="flow-feedback-icon" aria-hidden="true"><Warning v-if="workflowState.fbp?.shortage>0"/><CircleCheck v-else/></span>
        <div><strong>{{workflowState.fbp?.known?(workflowState.fbp.shortage>0?'FBP可用低于安全库存目标':'FBP可用库存达到当前安全目标'):'FBP安全库存正在核对'}}</strong>
          <p v-if="workflowState.fbp?.known">可用 {{quantity(workflowState.fbp.available)}} · 安全目标 {{quantity(workflowState.fbp.safety)}} · 低于目标 {{quantity(workflowState.fbp.shortage)}}<span v-if="workflowState.fbp.shortage>0">；扣除在途及已确认备货后，还需补货 {{quantity(workflowState.fbp.replenish_quantity)}}</span></p>
          <p v-else>先显示本地库存；FBP官方库存和销量核对完成后再判断，不把未知数量当零。</p>
        </div>
        <div class="flow-feedback-actions"><el-button link type="primary" @click="openDetails('fbp-safety')">核对安全目标</el-button><el-button v-if="workflowState.fbp?.replenish_quantity>0" type="primary" plain @click="emit('workflow-action','fbp')">提交FBP补货需求</el-button><el-button v-if="workflowState.demands.find(d=>d.key==='fbp_stock')?.purchase_quantity>0" type="warning" plain @click="emit('workflow-action','request','fbp_stock')">提交采购申请</el-button></div>
      </div>
    </div>
    <div class="flow-fbp-toolbar"><span>{{ fbpSyncing ? 'FBP 正在后台同步，本地库存可正常查看' : fbpLoading ? '正在读取 FBP 已保存库存' : canSyncFbp ? '每次打开明细后自动同步一次 FBP，零库存 SKU 不展开' : '只读查看已保存的 FBP 库存，零库存 SKU 不展开' }}</span><el-button v-if="canSyncFbp" size="small" type="primary" :loading="fbpSyncing" :disabled="fbpLoading" @click="emit('sync-fbp')">{{ fbpError ? '重试同步 FBP' : '同步 FBP 库存' }}</el-button><el-button link type="primary" @click="openDetails('fbp-physical')">查看有库存 SKU</el-button><el-button link type="primary" @click="openDetails('fbp-history')">全部 FBP 单据</el-button></div>
    <div v-if="fbpError" class="flow-fbp-error"><span>FBP 数据：{{ fbpError }}；本地库存与上次 FBP 快照保留</span><el-button link type="primary" :disabled="fbpLoading" @click="emit('retry-fbp')">重新读取</el-button></div>
    <section v-if="activeNode" ref="detail" :id="detailId" class="flow-node-detail" role="region" :aria-label="`${activeNode.label}明细`" tabindex="-1" aria-live="polite">
      <div class="flow-heading"><h4>{{ activeNode.label }} · {{ activeNode.display || quantity(activeNode.value) }}</h4><el-button text @click="selected = ''">收起</el-button></div>
      <div class="flow-action-buttons">
        <el-button v-if="['requests','orders','safety','application','free'].includes(selected)" type="primary" plain @click="emit('workflow-action','request',({orders:'real_order',safety:'local_safety',application:'fbp_stock'})[selected]||'')">提交采购申请</el-button>
        <el-button v-if="['requests','incoming','purchase-confirm'].includes(selected)" @click="emit('workflow-action','purchase')">登记实际采购</el-button>
        <el-button v-if="['incoming','receiving'].includes(selected)" @click="emit('workflow-action','receive')">登记入库</el-button>
        <el-button v-if="selected==='physical' && canSyncFbp" @click="emit('stocktake')">更新本地库存</el-button>
        <el-button v-if="['application','fbp-physical','fbp-safety','free'].includes(selected)" @click="emit('workflow-action','fbp')">创建FBP备货申请</el-button>
      </div>
      <el-table v-if="selected==='requests'" :data="rowsFor(selected)" empty-text="暂无申请；系统推荐需由人员确认提交"><el-table-column prop="id" label="申请编号" width="110"/><el-table-column prop="applicant_name" label="提出人"/><el-table-column prop="quantity" label="申请件数"/><el-table-column prop="status" label="状态"/><el-table-column prop="request_reason_note" label="说明"/></el-table>
      <p v-for="line in brief(activeNode)" :key="line">{{ line }}</p>
      <el-table v-if="['orders', 'assigned'].includes(selected)" :data="rowsFor(selected)" max-height="340" empty-text="暂无待发订单">
        <el-table-column prop="shop_name" label="店铺" min-width="120" /><el-table-column prop="posting_number" label="订单号" min-width="190" /><el-table-column prop="quantity" label="需求" width="80" /><el-table-column prop="stock_quantity" label="现货覆盖" width="100" /><el-table-column prop="incoming_quantity" label="在途覆盖" width="100" /><el-table-column label="操作" width="100"><template #default="{ row }"><el-button link type="primary" @click="navigateOrder(row)">打开订单</el-button></template></el-table-column>
      </el-table>
      <el-table v-else-if="['application', 'locked', 'fbp-history'].includes(selected)" :data="rowsFor(selected)" max-height="340" empty-text="暂无关联申请；现有占用请到库存流水核对">
        <el-table-column prop="order_no" label="FBP 申请单" min-width="170" /><el-table-column prop="shop_name" label="店铺" min-width="110" /><el-table-column prop="applicant_name" label="申请人" width="100" /><el-table-column prop="ozon_sku" label="SKU" min-width="130" /><el-table-column prop="requested_quantity" label="申请实物数" width="110" /><el-table-column prop="locked_quantity" label="确认占用" width="100" /><el-table-column label="状态" width="110"><template #default="{ row }">{{ statusText(row.status) }}</template></el-table-column><el-table-column label="提交／审核／结束（北京）" min-width="210"><template #default="{ row }"><div>提交 {{ time(row.submitted_at) }}</div><div>审核 {{ time(row.reviewed_at) }}</div><div v-if="row.closed_at">结束 {{ time(row.closed_at) }}</div></template></el-table-column><el-table-column label="操作" width="110"><template #default="{ row }"><el-button link type="primary" @click="navigateApplication(row)">打开申请单</el-button></template></el-table-column>
      </el-table>
      <el-table v-else-if="['dispatch','receipt'].includes(selected)" :data="rowsFor(selected)" max-height="340" empty-text="暂无对应发仓／入仓确认记录"><el-table-column prop="shop_name" label="店铺"/><el-table-column prop="ozon_sku" label="SKU"/><el-table-column prop="remaining_quantity" label="待入仓件数"/><el-table-column prop="confirmed_quantity" label="已确认入仓件数"/><el-table-column label="发运（北京）"><template #default="{row}">{{time(row.shipped_at)}}</template></el-table-column><el-table-column label="操作"><template #default="{row}"><el-button v-if="row.order_id" link type="primary" @click="navigateApplication(row)">打开申请单</el-button></template></el-table-column></el-table>
      <el-table v-else-if="selected==='fbp-safety'" :data="rowsFor(selected)" max-height="340" empty-text="FBP官方库存或销量尚未核实"><el-table-column prop="shop_name" label="店铺"/><el-table-column prop="ozon_sku" label="SKU"/><el-table-column prop="available" label="可用（套）"/><el-table-column prop="fbp_target" label="安全目标（套）"/><el-table-column prop="in_transit" label="在途（套）"/><el-table-column prop="committed_qty" label="已确认待发（套）"/><el-table-column prop="replenish_quantity" label="仍需补货（套）"/><el-table-column prop="per_set_quantity" label="每套实物件数"/></el-table>
      <InventoryFbpSkuTable v-else-if="['fbp-physical','fbp-orders','fbp-fulfil'].includes(selected)" :rows="positiveFbpRows" :product-id="Number(ledger.product.id)" />
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
.inventory-flow-diagram{margin:18px 0;color:var(--el-text-color-primary)}.flow-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}.flow-heading h3,.flow-heading h4{margin:0}.flow-heading>span,.flow-footnote{font-size:12px;color:var(--el-text-color-secondary)}
.flow-canvas{display:grid;gap:14px;padding:16px 0;container-type:inline-size}.flow-lane{border:1px solid var(--el-border-color-lighter);border-radius:14px;background:var(--el-bg-color-overlay);padding:16px 14px}.flow-lane-heading{display:flex;align-items:baseline;flex-wrap:wrap;gap:12px;padding:0 8px 14px}.flow-lane-heading strong{font-size:14px}.flow-lane-heading span{font-size:12px;color:var(--el-text-color-secondary)}.flow-stages{display:flex;gap:12px;align-items:stretch}.flow-node{position:relative;flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:7px;padding:10px 6px;border:1px solid transparent;border-radius:12px;background:transparent;color:var(--el-text-color-primary);font:inherit;cursor:pointer;transition:background .18s,border-color .18s}.flow-node:not(:last-child)::after{content:'';position:absolute;right:0;top:34px;width:6px;height:6px;border-top:1px solid var(--el-text-color-placeholder);border-right:1px solid var(--el-text-color-placeholder);transform:rotate(45deg)}.flow-icon{display:grid;place-items:center;width:52px;height:52px;border-radius:18px;background:var(--el-fill-color-light);color:var(--el-color-primary);transition:transform .18s}.flow-icon svg{width:27px;height:27px}.flow-node-label{font-size:13px;font-weight:600;text-align:center}.flow-node strong{font-size:clamp(16px,1.2vw,22px);font-variant-numeric:tabular-nums;text-align:center}.flow-node small{font-size:11px;line-height:1.5;color:var(--el-text-color-secondary);text-align:center;overflow-wrap:anywhere}.flow-node:hover,.flow-node:focus-visible,.flow-node.is-selected{background:var(--el-fill-color-light);border-color:var(--el-color-primary-light-5)}.flow-node:hover .flow-icon{transform:translateY(-2px)}.flow-node.is-primary .flow-icon{background:var(--el-color-primary-light-9)}.flow-node.is-success .flow-icon{color:var(--el-color-success);background:var(--el-color-success-light-9)}.flow-node.is-warning .flow-icon{color:var(--el-color-warning);background:var(--el-color-warning-light-9)}.flow-node.is-danger .flow-icon{color:var(--el-color-danger);background:var(--el-color-danger-light-9)}.flow-node.is-moving .flow-icon svg{animation:stock-transit 2.4s ease-in-out infinite}.flow-node.is-warning .flow-icon::after{content:'';position:absolute;width:6px;height:6px;border-radius:50%;background:var(--el-color-warning);transform:translate(19px,-19px)}
.flow-fbp-feedback{display:flex;align-items:center;gap:14px;padding:16px 20px;border:1px solid var(--el-border-color-lighter);border-radius:12px;background:var(--el-fill-color-extra-light)}.flow-feedback-icon{flex:none;width:30px;height:30px;color:var(--el-color-info)}.flow-feedback-icon svg{width:100%;height:100%}.flow-fbp-feedback.is-warning .flow-feedback-icon{color:var(--el-color-warning);animation:stock-warning 3s ease-in-out infinite}.flow-fbp-feedback.is-success .flow-feedback-icon{color:var(--el-color-success)}.flow-fbp-feedback p{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--el-text-color-secondary)}.flow-feedback-actions{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.flow-fbp-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:12px 0;font-size:12px;color:var(--el-text-color-secondary)}.flow-fbp-error,.flow-warning{color:var(--el-color-warning);font-size:13px}.flow-node-detail{border-top:1px solid var(--el-border-color-lighter);margin-top:15px;padding-top:12px}.flow-node-detail p{font-size:13px}.flow-hover-row{border-top:1px solid var(--el-border-color-lighter);padding:9px 0;font-size:12px;overflow-wrap:anywhere}.flow-action-buttons{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}:global(.inventory-flow-popover){max-width:calc(100vw - 24px);box-sizing:border-box}
@keyframes stock-transit{0%,100%{transform:translateX(-2px)}50%{transform:translateX(3px)}}@keyframes stock-warning{0%,100%{opacity:1}50%{opacity:.55}}
@container (max-width:1050px){.flow-stages{flex-wrap:wrap}.flow-node{flex-basis:calc(25% - 14px)}.flow-node::after{display:none}.flow-fbp-feedback{flex-wrap:wrap}.flow-feedback-actions{margin-left:0}}
@container (max-width:560px){.flow-node{flex-basis:calc(50% - 14px)}.flow-lane{padding:12px 8px}.flow-lane-heading{padding:0 4px 8px}.flow-lane-heading span{line-height:1.5}}
@media(prefers-reduced-motion:reduce){.flow-node,.flow-icon{transition:none}.flow-node.is-moving .flow-icon svg,.flow-fbp-feedback.is-warning .flow-feedback-icon{animation:none}.flow-node:hover .flow-icon{transform:none}}
</style>
