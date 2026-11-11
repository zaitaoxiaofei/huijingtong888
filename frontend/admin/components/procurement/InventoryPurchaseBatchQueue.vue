<script setup>
import InventoryCompositionBadge from '../inventory/InventoryCompositionBadge.vue';
import InventoryProductActions from '../inventory/InventoryProductActions.vue';
import {computed,defineAsyncComponent,onBeforeUnmount,reactive,ref,shallowRef,watch} from 'vue';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
import {ElMessage} from 'element-plus';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import {purchaseQueueDays,purchaseQueueDayGroups,purchaseQueueBadgeTone as badgeTone} from '../../utils/purchase-queue-days.js';
import {createInventoryWorkspacePageCache} from '../../utils/inventory-workspace-pages.js';
import ProductImagePreview from '../ProductImagePreview.vue';
import InventoryAffectedBundles from '../inventory/InventoryAffectedBundles.vue';
const BatchAction=defineAsyncComponent(()=>import('./PurchaseBatchActionDialog.vue'));
const batchAction=reactive({visible:false,rows:[],status:'open'}),selected=ref([]),batchTable=ref(null),reminding=ref(false);
const selectable=row=>!row.review_required&&!row.composition_error;
const unarrived=row=>selectable(row)&&!row.received_at;
const confirmRows=computed(()=>selected.value.filter(unarrived));
const reminderRows=computed(()=>confirmRows.value.filter(row=>!row.arrival_reminder));
function startBatch(status,values=status==='open'?confirmRows.value:selected.value){if(loading.value||reminding.value||error.value||!values.length||(status==='open'?!canConfirm.value:!canReceive.value))return;Object.assign(batchAction,{rows:[...values],status,visible:true});}
const allSelected=computed(()=>rows.value.some(selectable)&&rows.value.filter(selectable).every(row=>selected.value.some(value=>value.id===row.id)));
function togglePage(){const value=!allSelected.value;for(const row of rows.value.filter(selectable))batchTable.value?.toggleRowSelection(row,value);}
const BundleReview=defineAsyncComponent(()=>import('./PurchaseBundleReviewDialog.vue'));
const bundleReview=reactive({visible:false,id:0});
function reviewBundle(row){Object.assign(bundleReview,{visible:true,id:Number(row.id)});}
const BatchCorrection=defineAsyncComponent(()=>import('./PurchaseBatchCorrectionDialog.vue'));
const correction=reactive({visible:false,productId:0,inboundId:0,remove:false});
function editBatch(row,remove=false){Object.assign(correction,{visible:true,productId:Number(row.product_id),inboundId:Number(row.id),remove});}
const ReceiveDialog=defineAsyncComponent(()=>import('./InventoryReceiveDialog.vue'));
const receiving=reactive({visible:false,id:0,batch:0,name:''});
const Ledger=defineAsyncComponent(()=>import('./ProcurementLedgerDialog.vue'));
const OrderNotes=defineAsyncComponent(()=>import('./ProcurementOrderNotesDialog.vue'));
const orderNotes=reactive({visible:false,productId:0});
const props=defineProps({status:{type:String,default:'pending'},filters:{type:Object,required:true},revision:Number,productId:Number});
const emit=defineEmits(['changed','summary']),auth=useAuthStore(),rows=shallowRef([]),total=ref(0),loading=ref(false),error=ref('');
const statusFilter=ref(props.status);
const page=ref(1),pageSize=ref(50),ledger=reactive({visible:false,id:0,action:'',batch:0,tab:'current'});
const days=ref([]),selectedDay=ref(''),dateRange=ref(null);
const dayTabs=computed(()=>purchaseQueueDays(days.value,{status:statusFilter.value,selectedDay:selectedDay.value,startDate:dateRange.value?.[0]||'',endDate:dateRange.value?.[1]||''}));
const dayGroups=computed(()=>purchaseQueueDayGroups(dayTabs.value));
const allDayCount=computed(()=>days.value.reduce((sum,day)=>sum+Number(day[statusFilter.value]||0),0));
const overdueDayCount=computed(()=>dayTabs.value.filter(day=>day.ageDays>=2).reduce((sum,day)=>sum+day.count,0));
const allDayDescription=computed(()=>`全部待处理，${allDayCount.value} 个批次，其中前天及更早逾期 ${overdueDayCount.value} 个批次${allDayCount.value?'':'，无需提醒'}`);
const dayDescription=day=>`采购日期 ${day.date}，${day.count} 个批次，${!day.count?'无待处理批次，无需提醒':day.ageDays>=2?'前天及更早采购，逾期待处理':day.ageDays===1?'昨天采购':day.ageDays===0?'今天采购':'近期采购'}`;
const dayLabel=computed(()=>selectedDay.value==='all'?'全部待处理':selectedDay.value||'没有待处理日期');
const canRemind=computed(()=>hasPermission(auth.user,'procurement')),canReceive=computed(()=>hasPermission(auth.user,'packing')),canConfirm=computed(()=>canRemind.value||canReceive.value);
const pageCache=createInventoryWorkspacePageCache();
let version=0,disposed=false,controller;
const time=v=>v?shanghaiDateTimeText(v,{assumeUtcWhenNaive:true}):'未记录';
const elapsed=v=>{if(!v)return null;const d=typeof v==='string'&&!/[TZ]/.test(v)?v.replace(' ','T')+'Z':v;const n=Date.now()-new Date(d).getTime();return Number.isFinite(n)?Math.max(0,n/86400000):null;};
async function load(reset=false,day=selectedDay.value,useCache=false){
 if(!useCache)pageCache.clear();
 selected.value=[];batchTable.value?.clearSelection();if(reset)page.value=1;controller?.abort();controller=new AbortController();
 const token=++version,scope=currentApiCacheScope();loading.value=true;error.value='';
 const dates=dateRange.value||[];
 try{
  const params=new URLSearchParams({...props.filters,scope:'all',status:statusFilter.value,day_mode:'pending',page:page.value,pageSize:pageSize.value,...(day?{purchase_day:day}:{}),...(dates.length===2?{start_date:dates[0],end_date:dates[1]}:{}),...(props.productId?{product_id:props.productId}:{})});
  const url=`/api/inventory-workflow/purchase-arrivals?${params}`;
  const cached=useCache?pageCache.get(scope,url):null;
  const r=cached||await apiClient.get(url,{noCache:true,signal:controller.signal});
  if(!disposed&&token===version&&scope===currentApiCacheScope()){if(!cached){pageCache.set(scope,url,r);if(r.selected_day){params.set('purchase_day',r.selected_day);params.set('page',String(r.page??page.value));pageCache.set(scope,`/api/inventory-workflow/purchase-arrivals?${params}`,r);}}rows.value=r.rows||[];total.value=r.total||0;days.value=r.days||[];selectedDay.value=r.selected_day??day;page.value=r.page??page.value;emit('summary',r.summary||{});}
 }catch(e){if(token===version&&e.name!=='AbortError')error.value=e.message;}finally{if(token===version)loading.value=false;}
}
function changeDay(day){if(!loading.value)void load(true,day,true);}
function changeRange(){void load(true,'');}
function openLedger(row,action=''){if(action==='receive'){if(!canReceive.value||!selectable(row)||loading.value||reminding.value||error.value)return;Object.assign(receiving,{visible:true,id:Number(row.product_id),batch:Number(row.id),name:row.product_name});return;}Object.assign(ledger,{visible:true,id:Number(row.product_id),action,batch:0,tab:'current'});}
async function remind(values){
 if(!canRemind.value||loading.value||reminding.value||error.value)return;
 const chosen=values.filter(row=>unarrived(row)&&!row.arrival_reminder);if(!chosen.length)return;
 const scope=currentApiCacheScope();reminding.value=true;let completed=0,failure='';
 try{for(const row of chosen){if(disposed||scope!==currentApiCacheScope())return;try{await apiClient.post('/api/inventory-workflow/purchase-arrivals',{operation:'remind',id:row.id,expected_updated_at:row.updated_at,expected_quantity:Number(row.quantity),request_key:crypto.randomUUID()});completed++;}catch(e){failure=e.message;break;}}
  if(disposed||scope!==currentApiCacheScope())return;
  if(failure)ElMessage.warning(`已提醒 ${completed} / ${chosen.length} 批；${failure}。请刷新核对后重试。`);else ElMessage.success(`已提醒仓库核对 ${completed} 个批次，尚未确认实物到货`);
  await load();emit('changed');
 }finally{reminding.value=false;}
}
watch(()=>props.status,value=>{statusFilter.value=value;});
watch(()=>[statusFilter.value,props.revision,props.productId,JSON.stringify(props.filters)],(value,previous)=>{const resetDay=!previous||value[0]!==previous[0]||value[2]!==previous[2]||value[3]!==previous[3];void load(true,resetDay?'':selectedDay.value);},{immediate:true});onBeforeUnmount(()=>{disposed=true;++version;pageCache.clear();controller?.abort();});
</script>
<template>
 <section class="inventory-batch-queue" aria-label="采购收货与验收入库批次">
  <el-alert v-if="error" :title="error+'；保留最近成功记录，请手动刷新重试'" type="error" :closable="false"/>
  <el-radio-group v-model="statusFilter" class="batch-status-filter" aria-label="采购收货状态" :disabled="loading||reminding"><el-radio-button value="pending">全部未完成</el-radio-button><el-radio-button value="open">待到货</el-radio-button><el-radio-button value="reminded">已提醒到货</el-radio-button><el-radio-button value="arrived">实物到货待验收</el-radio-button></el-radio-group>
  <div class="batch-queue-toolbar"><el-button v-if="canRemind" plain :disabled="!reminderRows.length||loading||reminding||!!error" :loading="reminding" @click="remind(reminderRows)">批量提醒到货{{reminderRows.length?`（${reminderRows.length}）`:''}}</el-button><el-button v-if="canConfirm" plain :disabled="!confirmRows.length||loading||reminding||!!error" @click="startBatch('open')">批量确认实物到货{{confirmRows.length?`（${confirmRows.length}）`:''}}</el-button><el-button v-if="canReceive" type="primary" :disabled="!selected.length||loading||reminding||!!error" @click="startBatch('arrived')">批量验收入库{{selected.length?`（${selected.length}）`:''}}</el-button><el-button v-if="canConfirm||canReceive" plain :disabled="loading||reminding||!!error||!rows.some(selectable)" @click="togglePage">{{allSelected?'取消本页选择':'全选本页'}}</el-button><el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至" start-placeholder="采购开始日期" end-placeholder="采购结束日期" :disabled="loading||reminding" aria-label="按北京采购日期筛选待处理批次" @change="changeRange"/></div>
  <small class="batch-workflow-help">提醒到货仅通知仓库查货；确认实物到货不增加库存。仓库可直接验收入库，无需等待采购先确认。分批到货保留未到余量，历史套装需先核对采购内容。</small>
  <div class="batch-day-summary"><span>{{dayLabel}} · 共 {{total}} 个批次 · 本页 {{rows.length}} 个批次</span><small>日期按北京时间；搜索覆盖所有采购日期，等待最久优先；已处理完的日期自动收起。</small></div>
  <el-table ref="batchTable" @selection-change="value=>selected=value" :data="rows" row-key="id" border v-loading="loading" :empty-text="error?'到货记录读取失败，不代表没有待处理批次':'当前筛选没有待处理采购批次'">
   <el-table-column v-if="canConfirm||canReceive" type="selection" width="45" :selectable="row=>!reminding&&selectable(row)"/>
   <el-table-column label="最小实物库存" min-width="310"><template #default="{row}"><div v-for="part in row.components||[]" :key="part.product_id" class="batch-product"><ProductImagePreview :src="`/api/products/${part.product_id}/image?thumb=1`" :preview-list="[`/api/products/${part.product_id}/image`]" size="portrait"/><div><b>{{part.name}}</b><small>库存 ID：{{part.inventory_number||part.product_id}} <InventoryCompositionBadge :product="{...part,id:Number(part.product_id),component_count:0}"/></small><el-button plain size="small" @click="openLedger({product_id:part.product_id,id:0})">库存详情</el-button><InventoryProductActions :product-id="Number(part.product_id)" @saved="load();emit('changed')"/></div></div><small v-if="row.review_required" class="batch-review-warning">历史按 {{row.quantity}} 套登记 · 待确认实际配件</small><small v-if="row.composition_error">{{row.composition_error}}</small></template></el-table-column>
   <el-table-column label="受影响套装" min-width="220"><template #default="{row}"><InventoryAffectedBundles :bundles="row.affected_bundles||[]" @open="id=>openLedger({product_id:id,id:0})"/><small v-if="row.source_bundle_batch">原套装批次 #{{row.source_bundle_batch.id}} · 已按实物核对</small></template></el-table-column>
   <el-table-column label="采购批次 / 人员" min-width="190"><template #default="{row}"><b>{{row.source_bundle_batch?.order_no?`原采购单号 ${row.source_bundle_batch.order_no}`:row.order_no||`采购批次 #${row.id}`}}</b><template v-if="row.source_bundle_batch"><small class="batch-source-line">核对生成 {{row.order_no||`采购批次 #${row.id}`}}</small><small class="batch-source-line">原批次 #{{row.source_bundle_batch.id}} → 当前 #{{row.id}}</small></template><p>{{row.source_bundle_batch?'采购人':`批次 #${row.id} ·`}} {{row.buyer_name||'采购人待核'}}</p></template></el-table-column>
   <el-table-column label="本批数量 / 采购进度" min-width="180"><template #default="{row}"><div v-for="part in row.components||[]" :key="part.product_id" class="batch-component-quantity"><small>本批{{row.received_at?'待验收':'待到货'}}</small><small v-if="row.review_required">原登记 {{row.quantity}} 套</small><strong>{{row.review_required?`折算 ${part.quantity} ${part.stock_unit||'件'} · 待核`:`${part.quantity} ${part.stock_unit||'件'}`}}</strong><small v-if="row.is_bundle">每套 {{part.per_set_quantity}} {{part.stock_unit||'件'}}</small></div><div v-if="row.purchase_progress" class="batch-purchase-progress" aria-label="该商品采购累计进度"><small>总采购 <b>{{row.purchase_progress.ordered_quantity}}</b></small><small>未到货 <b>{{row.purchase_progress.unarrived_quantity}}</b></small><small>待验收 <b>{{row.purchase_progress.arrived_quantity}}</b></small><small>已入库 <b>{{row.purchase_progress.received_quantity}}</b></small></div></template></el-table-column>
   <el-table-column label="收货状态" min-width="170"><template #default="{row}"><div class="batch-arrival-state"><el-tag :type="row.received_at?'success':row.arrival_reminder?'warning':'info'">{{row.received_at?'实物到货待验收':row.arrival_reminder?'已提醒到货':'待到货'}}</el-tag><template v-if="row.arrival_reminder"><small>{{row.arrival_reminder.person_name||'采购'}} 提醒 · {{time(row.arrival_reminder.created_at)}}</small><small v-if="row.arrival_reminder.note">{{row.arrival_reminder.note}}</small><small v-if="!row.received_at">物流提示，实物尚待核实</small></template></div></template></el-table-column>
   <el-table-column label="采购 / 到货时间" min-width="205"><template #default="{row}"><span>{{time(row.purchased_at)}}</span><p v-if="!row.received_at" :class="{overdue:elapsed(row.purchased_at)>2}">{{elapsed(row.purchased_at)==null?'采购时间待核':`已采购 ${elapsed(row.purchased_at).toFixed(1)} 天`}}{{elapsed(row.purchased_at)>2?' · 超过2天':''}}</p><template v-else><p>到货 {{time(row.received_at)}}</p><small>已到货 {{elapsed(row.received_at)?.toFixed(1)??'待核'}} 天</small></template></template></el-table-column>
   <el-table-column label="物流 / 核对" min-width="180"><template #default="{row}"><div class="batch-actions"><span>{{row.courier_company||'快递待填写'}} {{row.tracking_number||''}}</span><el-button plain size="small" @click="Object.assign(orderNotes,{visible:true,productId:Number(row.product_id)})">订单备注</el-button><el-button v-if="row.received_at&&hasPermission(auth.user,'inventory.write')" plain size="small" @click="openLedger(row,'stocktake')">核对实物</el-button></div></template></el-table-column>
   <el-table-column label="处理" min-width="265" fixed="right"><template #default="{row}"><div class="batch-actions-row"><template v-if="row.review_required"><el-button v-if="canRemind" plain size="small" @click="reviewBundle(row)">核对套装采购内容</el-button><small v-else>待采购核对实际配件后再验收</small></template><template v-else-if="!row.composition_error"><el-button v-if="!row.received_at&&canRemind" plain size="small" :disabled="!!row.arrival_reminder||loading||reminding||!!error" @click="remind([row])">{{row.arrival_reminder?'已提醒到货':'提醒到货'}}</el-button><el-button v-if="!row.received_at&&canConfirm" plain size="small" :disabled="loading||reminding||!!error" @click="startBatch('open',[row])">确认实物到货</el-button><el-button v-if="canReceive" type="primary" plain size="small" :disabled="loading||reminding||!!error" @click="openLedger(row,'receive')">验收入库</el-button><el-button v-if="!row.received_at&&canRemind" plain size="small" :disabled="loading||reminding" @click="editBatch(row)">编辑</el-button><el-button v-if="!row.received_at&&canRemind" plain size="small" type="danger" :disabled="loading||reminding" @click="editBatch(row,true)">删除</el-button><small v-if="!canReceive">由仓库验收入库</small></template></div></template></el-table-column>
  </el-table>
  <footer class="batch-queue-footer"><nav class="batch-day-tabs" aria-label="按采购日期查看批次"><button type="button" :title="allDayDescription" :aria-label="allDayDescription" :aria-pressed="selectedDay==='all'" :disabled="loading" @click="changeDay('all')"><span>全部待处理</span><small class="batch-day-count" :class="`is-${badgeTone(allDayCount,overdueDayCount>0)}`" aria-hidden="true">{{allDayCount}}</small></button><div v-for="group in dayGroups" :key="group.month" class="batch-month-group"><span class="batch-month-label">{{group.monthLabel}}</span><div class="batch-month-days"><button v-for="day in group.days" :key="day.date" type="button" :title="dayDescription(day)" :aria-label="dayDescription(day)" :aria-pressed="selectedDay===day.date" :disabled="loading" @click="changeDay(day.date)"><span>{{day.dayLabel}}</span><small class="batch-day-count" :class="`is-${badgeTone(day.count,day.ageDays>=2)}`" aria-hidden="true">{{day.count}}</small></button></div></div></nav><el-pagination v-model:current-page="page" v-model:page-size="pageSize" :disabled="loading" :page-sizes="[20,50,100]" :total="total" layout="total,sizes,prev,pager,next" @size-change="load(true,selectedDay,true)" @current-change="load(false,selectedDay,true)"/></footer>
  <BatchAction v-if="batchAction.visible" v-model="batchAction.visible" :status="batchAction.status" :rows="batchAction.rows" @changed="load();emit('changed')" @correct="row=>{batchAction.visible=false;if(batchAction.status==='open')editBatch(row);else Object.assign(ledger,{visible:true,id:Number(row.product_id),action:'',batch:0,tab:'purchases'});}"/>
  <BundleReview v-if="bundleReview.visible" v-model="bundleReview.visible" :inbound-id="bundleReview.id" @saved="load();emit('changed')"/>
  <BatchCorrection v-if="correction.visible" v-model="correction.visible" :product-id="correction.productId" :inbound-id="correction.inboundId" :remove="correction.remove" @saved="load();emit('changed')"/>
  <ReceiveDialog v-if="receiving.visible" v-model="receiving.visible" :product-id="receiving.id" :product-name="receiving.name" :inbound-id="receiving.batch" @saved="load();emit('changed')"/>
  <Ledger v-if="ledger.visible" v-model="ledger.visible" :product-id="ledger.id" :initial-action="ledger.action" :initial-inbound-id="ledger.batch" :initial-tab="ledger.tab" :stocktake-enabled="hasPermission(auth.user,'inventory.write')" @saved="load();emit('changed')"/>
  <OrderNotes v-if="orderNotes.visible" v-model="orderNotes.visible" :product-id="orderNotes.productId" @saved="emit('changed')"/>

 </section>
</template>
<style scoped>
.batch-status-filter{display:flex;flex-wrap:nowrap;overflow-x:auto;max-width:100%;padding-bottom:2px}.batch-status-filter :deep(.el-radio-button){flex:none}.batch-workflow-help{color:var(--el-text-color-secondary);line-height:1.6}.batch-arrival-state{display:grid;justify-items:start;gap:6px}.batch-arrival-state small{color:var(--el-text-color-secondary);line-height:1.5}
.batch-purchase-progress{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 8px;padding-top:7px;border-top:1px solid var(--el-border-color-lighter)}.batch-purchase-progress small{color:var(--el-text-color-secondary);white-space:nowrap}.batch-purchase-progress b{font-weight:500;color:var(--el-text-color-regular);font-variant-numeric:tabular-nums}
.batch-queue-toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.batch-queue-toolbar span{font-size:12px;color:var(--el-text-color-secondary)}.batch-queue-toolbar :deep(.el-date-editor){margin-left:auto;max-width:320px}.inventory-batch-queue{display:grid;gap:12px;min-width:0}.batch-product{display:flex;gap:12px;align-items:center;min-height:92px}.batch-product>div{display:grid;gap:7px}.batch-product small,.batch-queue small{color:var(--el-text-color-secondary)}.batch-product .el-button{justify-self:start;margin:0}.batch-component-quantity{display:flex;flex-direction:column;justify-content:center;gap:5px;min-height:92px}.batch-review-warning{color:var(--el-color-warning)}.batch-product+.batch-product{margin-top:6px}.batch-actions-row{display:flex;gap:6px;flex-wrap:wrap}.batch-actions-row .el-button{margin:0}.batch-source-line{display:block;margin-top:5px;color:var(--el-text-color-secondary);line-height:1.5}.batch-actions{display:grid;gap:8px;justify-items:start}.overdue{color:var(--el-color-danger)}.batch-day-summary{font-size:13px;color:var(--el-text-color-primary)}.batch-day-summary small{margin-left:12px;font-size:12px;color:var(--el-text-color-secondary)}.batch-queue-footer{display:flex;align-items:center;gap:16px;min-width:0}.batch-day-tabs{display:flex;gap:6px;flex:1;min-width:180px;overflow-x:auto;padding:3px 0 7px}.batch-month-group{display:flex;align-items:center;gap:8px;flex:none}.batch-month-label{font-size:12px;white-space:nowrap;color:var(--el-text-color-secondary)}.batch-month-days{display:flex;gap:6px}.batch-day-tabs button{display:flex;flex-direction:column;align-items:center;gap:5px;flex:none;border:1px solid var(--el-border-color);border-radius:5px;background:var(--el-fill-color-blank);color:var(--el-text-color-secondary);padding:7px 10px;font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}.batch-day-tabs button[aria-pressed=true]{background:var(--el-color-primary-light-9);border-color:var(--el-color-primary-light-5);color:var(--el-color-primary)}.batch-day-tabs button:disabled{cursor:wait;opacity:.65}.batch-day-count{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:22px;height:22px;padding:0 5px;border:1px solid transparent;border-radius:999px;color:#fff;font-size:12px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums}.batch-day-count.is-recent{background:#4b7563;border-color:#3e6554}.batch-day-count.is-overdue{background:#a35454;border-color:#914646}.batch-day-count.is-empty{background:#6b7280;border-color:#59616d}.batch-queue-footer>.el-pagination{flex:none;justify-content:flex-end}@media(max-width:1000px){.batch-queue-footer{flex-wrap:wrap}.batch-day-tabs{flex-basis:100%}.batch-queue-footer>.el-pagination{margin-left:auto}.batch-day-summary small{display:block;margin:5px 0 0}}
</style>
