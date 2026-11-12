<script setup>
import MobileDialog from './MobileDialog.vue';
import {computed,defineAsyncComponent,onBeforeUnmount,onMounted,reactive,ref,watch} from 'vue';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
import {inventorySearchDefaults,appendInventorySearch} from '../../../../src/shared/inventory-search-fields.js';
import MobileInventorySearch from './MobileInventorySearch.vue';
import MobilePagination from './MobilePagination.vue';
import {withImageToken} from '../../api/tools/imageCropper.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import {purchaseQueueDays,purchaseQueueDayGroups,purchaseQueueBadgeTone} from '../../utils/purchase-queue-days.js';
import ProductImagePreview from '../ProductImagePreview.vue';
import MobilePurchaseDialog from './MobilePurchaseDialog.vue';
import MobileStocktakeDialog from './MobileStocktakeDialog.vue';
import InventoryReceiveDialog from '../procurement/InventoryReceiveDialog.vue';
import InventoryProductEditAction from '../inventory/InventoryProductEditAction.vue';
import InventoryProductHistoryAction from '../inventory/InventoryProductHistoryAction.vue';
const MobilePurchaseBatchDialog=defineAsyncComponent(()=>import('./MobilePurchaseBatchDialog.vue'));
const props=defineProps({warehouse:Boolean}),auth=useAuthStore();
const canPurchase=computed(()=>hasPermission(auth.user,'procurement')),canReceive=computed(()=>hasPermission(auth.user,'packing')),canConfirmArrival=computed(()=>canPurchase.value||canReceive.value),warehouseMode=computed(()=>props.warehouse||!canPurchase.value&&canReceive.value);
const rows=ref([]),total=ref(null),page=ref(1),pageSize=ref(20),tab=ref(warehouseMode.value?'pending':'register'),queueStatus=ref('pending'),purchaseRange=reactive({start:'',end:''}),filters=reactive({...inventorySearchDefaults(),searchMode:'inventory_id',query:'',inventoryType:'all'}),loading=ref(false),error=ref(''),snapshot=ref({}),busy=ref(false);
const purchase=reactive({visible:false,rows:[]}),receive=reactive({visible:false,id:0,batch:0,name:''}),edit=reactive({row:null,tracking:'',courier:''});let generation=0,disposed=false,controller=null;
const stocktake=reactive({visible:false,product:{}}),stockFeedback=ref(''),stockError=ref(false);const stockUpdates=new Map();
const canWrite=computed(()=>hasPermission(auth.user,'inventory.write'));
const tabs=computed(()=>warehouseMode.value?[['pending','采购收货']]:[['register','登记采购'],['required','必须采购'],['advisory','保障补货'],['pending','采购收货'],['history','采购记录']]);
const queueFilters=[['pending','全部状态'],['open','待到货'],['reminded','已提醒'],['arrived','待验收']];
const demand=computed(()=>['required','advisory'].includes(tab.value));
const pending=computed(()=>tab.value==='pending'),purchaseDays=ref([]),selectedDay=ref(''),selected=ref([]),batch=reactive({visible:false,rows:[],status:'open'});
const dateTabs=computed(()=>purchaseQueueDays(purchaseDays.value,{status:queueStatus.value,selectedDay:selectedDay.value}));
const dateGroups=computed(()=>purchaseQueueDayGroups(dateTabs.value));
const canBatch=computed(()=>pending.value&&canConfirmArrival.value);
const selectable=row=>!row.review_required&&!row.composition_error&&row.status!=='approved'&&row.status!=='cancelled';
const selectableRows=computed(()=>rows.value.filter(selectable)),selectedRows=computed(()=>rows.value.filter(row=>selected.value.includes(Number(row.id))));
const selectedUnarrived=computed(()=>selectedRows.value.filter(row=>!row.received_at));
const allSelected=computed(()=>selectableRows.value.length>0&&selectedRows.value.length===selectableRows.value.length);
const dateDescription=day=>`采购日期 ${day.date}，${day.count} 个批次，${day.ageDays>=2?'前天及更早，逾期待处理':day.ageDays===1?'昨天采购':day.ageDays===0?'今天采购':'近期采购'}`;
function selectPage(value){selected.value=value?selectableRows.value.map(row=>Number(row.id)):[];}
function selectRow(row,value){selected.value=value?[...selected.value,Number(row.id)]:selected.value.filter(id=>id!==Number(row.id));}
function openBatch(values=selectedRows.value,status='open'){
 const allowed=status==='arrived'?canReceive.value:status==='remind'?canPurchase.value:canConfirmArrival.value;
 const eligible=values.filter(row=>selectable(row)&&(status==='arrived'||!row.received_at));
 if(!pending.value||!allowed||loading.value||busy.value||error.value||!eligible.length)return;
 Object.assign(batch,{visible:true,rows:[...eligible],status});
}
function changeDay(day){if(!loading.value)void load(true,false,day);}
const time=value=>value?shanghaiDateTimeText(value,{assumeUtcWhenNaive:true}):'未记录';
const days=value=>{if(!value)return null;const n=(Date.now()-new Date(/[TZ]/.test(value)?value:value.replace(' ','T')+'Z').getTime())/86400000;return Number.isFinite(n)?Math.max(0,n):null;};
function photos(row){let values=row.receipt_images_json;try{if(typeof values==='string')values=JSON.parse(values);}catch{values=[];}return [...new Set([...(Array.isArray(values)?values:[]),...(String(row.purchase_note||'').match(/\/uploads\/team-attachments\/[^\s，]+/g)||[])])].filter(v=>String(v).startsWith('/uploads/team-attachments/')).slice(0,12).map(withImageToken);}
function number(value){return value==null?'待计算':`${Number(value)} 件`;}
function filtersUrl(){return appendInventorySearch(new URLSearchParams({page:String(page.value),pageSize:String(pageSize.value),query:filters.query.trim(),inventoryType:filters.inventoryType}),filters);}
async function load(reset=false,fresh=false,day=reset?'':selectedDay.value){
 selected.value=[];if(reset)page.value=1;controller?.abort();controller=new AbortController();const request=controller,token=++generation,scope=currentApiCacheScope();loading.value=true;error.value='';
 const timeout=window.setTimeout(()=>request.abort(),15000);
 try {
  const p=filtersUrl();let endpoint;
  if(pending.value||tab.value==='received'){
   if(purchaseRange.start&&purchaseRange.end&&purchaseRange.start>purchaseRange.end)throw Error('采购开始日期不能晚于结束日期');
   if(purchaseRange.start)p.set('start_date',purchaseRange.start);if(purchaseRange.end)p.set('end_date',purchaseRange.end);
  }
  if(tab.value==='register'){p.set('paged','1');p.set('view','inventory');p.set('includeStock','0');endpoint='/api/products?'+p;}
  else if(demand.value){p.set('view','workspace');p.set('compact','1');p.set('task',tab.value);p.set(fresh?'refresh':'snapshot_only','1');endpoint='/api/inventory-workflow/alerts?'+p;}
  else{p.set('status',tab.value==='history'?'all':tab.value==='received'?'received':queueStatus.value);if(tab.value==='history')p.set('recent','1');else if(pending.value){p.set('day_mode','pending');if(day)p.set('purchase_day',day);}endpoint='/api/inventory-workflow/purchase-arrivals?'+p;}
  const r=await apiClient.get(endpoint,{noCache:true,signal:request.signal});if(disposed||token!==generation||scope!==currentApiCacheScope())return;
  const raw=tab.value==='register'?(r.rows||[]).map(row=>({...row,product_id:row.id,product_name:row.name})):(r.rows||[]);snapshot.value=r.snapshot||{};rows.value=applyStockUpdates(raw,snapshot.value);total.value=r.total==null?null:Math.max(0,Number(r.total)-raw.length+rows.value.length);
  purchaseDays.value=pending.value?r.days||[]:[];selectedDay.value=pending.value?r.selected_day??day:'';if(r.page!=null)page.value=Number(r.page);
  document.querySelector('.mobile-work-queue .mobile-list-scroll')?.scrollTo(0,0);
 }catch(e){if(token===generation&&scope===currentApiCacheScope())error.value=e.name==='AbortError'?'读取超时，请点击查询重试':e.message;}
 finally{window.clearTimeout(timeout);if(token===generation)loading.value=false;}
}
function changed(){return load();}
function resetFilters(){Object.assign(filters,inventorySearchDefaults(),{searchMode:'inventory_id',query:'',inventoryType:'all'});Object.assign(purchaseRange,{start:'',end:''});const statusChanged=queueStatus.value!=='pending';queueStatus.value='pending';if(!pending.value||!statusChanged)load(true);}
function queueMore(command){if(loading.value||busy.value)return;if(command==='received'){tab.value='received';return;}if(command==='pending'){tab.value='pending';return;}if(command==='refresh')load(false,demand.value);}
function changePage(value){page.value=value.page;pageSize.value=value.pageSize;load();}

function openPurchase(row){if(row?.stocktake_pending||row?.stocktake_recheck_error)return;purchase.rows=row?[row]:[];purchase.visible=true;}
function canStocktake(row){const id=Number(row.product_id||(tab.value==='register'?row.id:0));return canWrite.value&&Number.isSafeInteger(id)&&id>0&&!row.is_bundle&&!row.review_required&&Number(row.component_count||0)===0;}
function openStocktake(row){if(!canStocktake(row))return;stocktake.product={...row,id:Number(row.product_id||row.id),name:row.product_name||row.name};stocktake.visible=true;}
function applyStockUpdates(values,meta={}){
 const at=Date.parse(meta.calculated_at||'');if(meta.stale===false)for(const [id,entry] of stockUpdates)if(at>=entry.at)stockUpdates.delete(id);
 return values.map(row=>{const entry=stockUpdates.get(Number(row.product_id||row.id));if(!entry)return row;return{...row,stocktake_physical:entry.physical,stocktake_pending:demand.value&&!entry.state&&!entry.error,stocktake_recheck_error:demand.value&&entry.error,workflow:demand.value?(entry.state||{...row.workflow,physical_recorded:entry.physical,supply_plan:null}):row.workflow};}).filter(row=>{if(!demand.value||!stockUpdates.get(Number(row.product_id))?.state)return true;const count=tab.value==='required'?row.workflow?.supply_plan?.required_purchase:row.workflow?.supply_plan?.optional_purchase;return count!==0;});
}
async function stocktakeSaved(result){
 const id=Number(stocktake.product.id),scope=currentApiCacheScope(),pageToken=generation,entry={physical:result.physical_after,at:Date.now(),state:null,error:false};stockUpdates.set(id,entry);
 stocktake.visible=false;stockError.value=false;stockFeedback.value=`库存 ${stocktake.product.inventory_number||id} 已核对，本地实物 ${result.physical_after} 件；操作记录已保存。`;
 rows.value=applyStockUpdates(rows.value);
 if(!demand.value)return;
 const controller=new AbortController();entry.controller=controller;const timeout=window.setTimeout(()=>controller.abort(),15000);
 try{
  const response=await apiClient.get(`/api/inventory-workflow?view=status&product_ids=${id}&fresh=1`,{noCache:true,signal:controller.signal});
  if(disposed||stockUpdates.get(id)!==entry||scope!==currentApiCacheScope())return;
  const state=response.rows?.find(row=>Number(row.product_id)===id);if(!state)throw Error('未读取到更新后的库存需求');entry.state=state;
  if(pageToken!==generation)return;const before=rows.value.length;rows.value=applyStockUpdates(rows.value);if(total.value!=null)total.value=Math.max(0,total.value-before+rows.value.length);if(before>rows.value.length)stockFeedback.value+=' 当前需求已覆盖，已移出本列表。';
 }catch(e){if(!disposed&&stockUpdates.get(id)===entry&&scope===currentApiCacheScope()){entry.error=true;if(pageToken===generation){stockError.value=true;stockFeedback.value+=' 采购建议更新失败，请刷新后再登记采购。';rows.value=applyStockUpdates(rows.value);}}}finally{window.clearTimeout(timeout);}
}
function openReceive(row){if(!pending.value||!canReceive.value||!selectable(row)||loading.value||busy.value||error.value)return;Object.assign(receive,{visible:true,id:Number(row.product_id),batch:Number(row.id),name:row.product_name});}
async function saveLogistics(){if(!edit.row||busy.value)return;const row=edit.row,scope=currentApiCacheScope();busy.value=true;try{await apiClient.post('/api/inventory-workflow/purchase-arrivals',{operation:'logistics',id:row.id,expected_updated_at:row.updated_at,expected_courier_company:row.courier_company,expected_tracking_number:row.tracking_number,courier_company:edit.courier,tracking_number:edit.tracking});if(disposed||scope!==currentApiCacheScope())return;edit.row=null;ElMessage.success('采购物流已保存');await load();}catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{busy.value=false;}}

function reset(){for(const entry of stockUpdates.values())entry.controller?.abort();stockUpdates.clear();stocktake.visible=false;stockFeedback.value='';++generation;controller?.abort();rows.value=[];total.value=null;purchase.visible=false;receive.visible=false;batch.visible=false;selected.value=[];purchaseDays.value=[];selectedDay.value='';edit.row=null;error.value='';loading.value=false;busy.value=false;}
watch(tab,()=>{rows.value=[];purchaseDays.value=[];selectedDay.value='';snapshot.value={};load(true);});watch(queueStatus,()=>{if(pending.value)load(true);});onMounted(()=>{load();window.addEventListener('erp:auth-scope-changed',reset);});onBeforeUnmount(()=>{disposed=true;reset();window.removeEventListener('erp:auth-scope-changed',reset);});
watch([warehouseMode,canPurchase,canReceive],()=>{if(warehouseMode.value&&!['pending','received'].includes(tab.value))tab.value='pending';if(!canPurchase.value){purchase.visible=false;edit.row=null;}if(!canReceive.value)receive.visible=false;if(batch.visible&&((batch.status==='arrived'&&!canReceive.value)||(batch.status==='remind'&&!canPurchase.value)||!canConfirmArrival.value))batch.visible=false;},{flush:'sync'});
</script>
<template><div class="mobile-work-queue mobile-list-page"><div class="mobile-list-controls"><nav v-if="!warehouseMode" class="mobile-queue-tabs" aria-label="库存任务"><button v-for="[key,label] in tabs" :key="key" :class="{active:tab===key}" @click="tab=key">{{label}}</button></nav>
 <div v-if="tab==='received'" class="mobile-received-heading"><strong>已入库记录</strong><el-button size="small" :disabled="loading" @click="queueMore('pending')">返回采购收货</el-button></div>
 <MobileInventorySearch :filters="filters" :loading="loading" @search="load(true)" @reset="resetFilters">
  <template #filters><div v-if="pending||tab==='received'" class="mobile-receipt-filters" :class="{'is-history':!pending}"><label v-if="pending">收货状态<select v-model="queueStatus" aria-label="收货状态" :disabled="loading"><option v-for="[key,label] in queueFilters" :key="key" :value="key">{{label}}</option></select></label><label title="按北京时间筛选采购日期">采购开始日期<input v-model="purchaseRange.start" type="date" aria-label="采购开始日期" :max="purchaseRange.end||undefined" :disabled="loading"></label><label title="按北京时间筛选采购日期">采购结束日期<input v-model="purchaseRange.end" type="date" aria-label="采购结束日期" :min="purchaseRange.start||undefined" :disabled="loading"></label></div></template>
  <template #actions><el-dropdown v-if="pending||tab==='received'" trigger="click" :disabled="loading" @command="queueMore"><el-button :disabled="loading">更多</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="refresh">刷新列表</el-dropdown-item><el-dropdown-item v-if="pending" command="received">已入库记录</el-dropdown-item><el-dropdown-item v-else command="pending">返回采购收货</el-dropdown-item></el-dropdown-menu></template></el-dropdown><el-button v-else :disabled="loading" @click="load(false,demand)">刷新</el-button><el-button v-if="canPurchase&&!warehouseMode" @click="openPurchase()">登记采购</el-button></template>
 </MobileInventorySearch><el-alert v-if="stockFeedback" :title="stockFeedback" :type="stockError?'warning':'success'" :closable="false"/><el-alert v-if="error" :title="error" type="warning" :closable="false"/>
 <nav v-if="pending&&dateGroups.length" class="mobile-purchase-days" aria-label="按北京采购日期查看批次"><section v-for="group in dateGroups" :key="group.month" class="mobile-purchase-month"><small>{{group.monthLabel}}</small><div><button v-for="day in group.days" :key="day.date" type="button" :aria-label="dateDescription(day)" :title="dateDescription(day)" :aria-pressed="selectedDay===day.date" :disabled="loading" @click="changeDay(day.date)"><span>{{day.dayLabel}}</span><b :class="`is-${purchaseQueueBadgeTone(day.count,day.ageDays>=2)}`" aria-hidden="true">{{day.count}}</b></button></div></section></nav>
 <div v-if="canBatch" class="mobile-batch-toolbar"><el-checkbox :model-value="allSelected" :indeterminate="!!selectedRows.length&&!allSelected" :disabled="loading||!!error||!selectableRows.length" @change="selectPage">选择本页</el-checkbox><div class="mobile-batch-actions"><el-button v-if="canReceive" type="success" :aria-label="`批量验收入库（${selectedRows.length}）`" :disabled="loading||!!error||!selectedRows.length" @click="openBatch(selectedRows,'arrived')">验收入库（{{selectedRows.length}}）</el-button><el-button v-if="canPurchase" :aria-label="`批量提醒到货（${selectedUnarrived.length}）`" :disabled="loading||!!error||!selectedUnarrived.length" @click="openBatch(selectedUnarrived,'remind')">提醒到货（{{selectedUnarrived.length}}）</el-button><el-button v-if="canConfirmArrival" :aria-label="`批量确认实物到货（${selectedUnarrived.length}）`" :disabled="loading||!!error||!selectedUnarrived.length" @click="openBatch(selectedUnarrived,'open')">确认到货（{{selectedUnarrived.length}}）</el-button></div></div>
 <small v-if="loading" class="mobile-muted">正在读取…</small><small v-if="snapshot.refreshing" class="mobile-muted">采购建议正在准备，可先登记采购，稍后点击刷新查看。</small></div><div class="mobile-list-scroll">

 <article v-for="row in rows" :key="demand?row.product_id:row.id" class="mobile-record"><el-checkbox v-if="canBatch" :model-value="selected.includes(Number(row.id))" :disabled="loading||!!error||!selectable(row)" :aria-label="`选择采购批次 ${row.id}`" @change="value=>selectRow(row,value)">选择此批次</el-checkbox><div class="mobile-record-head"><ProductImagePreview :src="`/api/products/${row.product_id}/image?thumb=1`" :preview-list="[`/api/products/${row.product_id}/image`]" size="portrait"/><div><h3>{{row.product_name||row.name}}</h3><small>{{row.inventory_number||row.product_id}}</small><small v-if="!demand">{{row.order_no||row.shop_name||'采购记录'}} · #{{row.id}} <template v-if="row.ozon_sku">SKU {{row.ozon_sku}}</template></small></div></div>
 <template v-if="tab==='register'"><div class="mobile-record-actions"><el-button v-if="canPurchase" type="primary" @click="openPurchase(row)">登记本商品采购</el-button><el-button v-if="canStocktake(row)" @click="openStocktake(row)">更新库存</el-button></div></template>
 <template v-else-if="demand"><div class="mobile-record-grid"><span>本地实物<b>{{number(row.workflow?.physical_recorded)}}</b></span><span>采购在途<b>{{number(row.workflow?.incoming)}}</b></span><span>必须采购<b :class="{required:Number(row.workflow?.supply_plan?.required_purchase)>0,covered:row.workflow?.supply_plan?.required_purchase===0}">{{number(row.workflow?.supply_plan?.required_purchase)}}</b></span><span>保障建议<b>{{number(row.workflow?.supply_plan?.optional_purchase)}}</b></span></div><div class="mobile-record-actions"><el-button v-if="canPurchase" :disabled="loading||snapshot.refreshing||row.stocktake_pending||row.stocktake_recheck_error" type="primary" @click="openPurchase(row)">登记实际采购</el-button><el-button v-if="canStocktake(row)" :disabled="row.stocktake_pending" @click="openStocktake(row)">更新库存</el-button></div><small v-if="row.stocktake_pending" class="mobile-muted">正在更新采购缺口…</small></template>

 <template v-else>
  <div v-if="pending&&Number(row.product_id)>0" class="mobile-record-actions"><InventoryProductEditAction :product-id="Number(row.product_id)" mobile @saved="changed"/><InventoryProductHistoryAction :product-id="Number(row.product_id)" mobile/></div>
  <div class="mobile-record-grid"><span>{{tab==='history'||tab==='received'?'批次数量':row.received_at?'到货待验收':'待到货'}}<b>{{number(row.physical_quantity)}}</b></span><span>采购时间<b>{{time(row.purchased_at)}}</b></span></div>
  <div v-if="row.purchase_progress" class="mobile-purchase-progress"><span>本项采购 {{row.purchase_progress.ordered_quantity}} {{row.is_bundle?'套':row.components?.[0]?.stock_unit||'件'}}</span><span>待到货 {{row.purchase_progress.unarrived_quantity}}</span><span>待验收 {{row.purchase_progress.arrived_quantity}}</span><span>已入库 {{row.purchase_progress.received_quantity}}</span></div>
  <small v-if="pending&&!row.received_at" :class="{'mobile-overdue':days(row.purchased_at)>2}">{{days(row.purchased_at)==null?'采购时间未记录':`已采购 ${days(row.purchased_at).toFixed(1)} 天${days(row.purchased_at)>2?'，超过2天未到货':''}`}}</small>
  <small v-if="row.received_at">实物到货 {{time(row.received_at)}}</small>
  <small v-else-if="pending">{{row.arrival_reminder?'已提醒仓库查收，尚未确认实物到货':'尚未确认实物到货'}}</small>
  <div v-if="row.arrival_reminder" class="mobile-arrival-reminder"><strong>到货提醒</strong><small>{{row.arrival_reminder.person_name||'采购人员'}} · {{time(row.arrival_reminder.created_at)}}</small><small v-if="row.arrival_reminder.note">{{row.arrival_reminder.note}}</small></div>
  <small v-if="row.tracking_number">快递 {{row.courier_company}} {{row.tracking_number}}</small>
  <div v-if="tab==='history'||tab==='received'"><small>状态：{{row.status==='approved'?'已入库':row.status==='pending_arrival'?'采购在途／待验收':row.status}}</small><small v-if="tab==='received'">入库时间 {{time(row.approved_at)}}</small><small v-if="tab==='history'&&row.amount!=null">货款 ¥{{Number(row.amount).toFixed(2)}} · 运费 ¥{{Number(row.shipping_amount||0).toFixed(2)}}</small><div class="mobile-history-photos"><el-image v-for="(url,index) in photos(row)" :key="url" :src="url" :preview-src-list="photos(row)" :initial-index="index" preview-teleported fit="cover"/></div></div>
  <p v-if="pending&&(row.review_required||row.composition_error)" class="mobile-muted">此批次原按套装采购，需采购人员先核对实际配件组成；不直接按套数入库。</p>
  <div v-else-if="pending" class="mobile-record-actions"><el-button v-if="canReceive" :disabled="loading||busy||!!error" type="success" @click="openReceive(row)">验收入库</el-button><el-button v-if="canPurchase&&!row.received_at" :disabled="loading||busy||!!error" @click="openBatch([row],'remind')">提醒到货</el-button><el-button v-if="canConfirmArrival&&!row.received_at" :disabled="loading||busy||!!error" @click="openBatch([row],'open')">确认实物到货</el-button><el-button v-if="canStocktake(row)" @click="openStocktake(row)">更新库存</el-button><el-button v-if="canPurchase" :disabled="busy" @click="Object.assign(edit,{row,tracking:row.tracking_number||'',courier:row.courier_company||''})">填写物流</el-button></div>
 </template><small v-if="row.stocktake_physical!=null&&!demand" class="mobile-muted">已核对本地实物 {{row.stocktake_physical}} 件，操作记录已保存</small></article>
 <p v-if="!loading&&!rows.length&&!error" class="mobile-muted">{{snapshot.refreshing?'需求正在计算，请稍候':'当前筛选暂无待处理记录'}}</p></div><MobilePagination :page="page" :page-size="pageSize" :total="total" :loading="loading" @change="changePage"/>

 <MobilePurchaseBatchDialog v-if="batch.visible" v-model="batch.visible" :status="batch.status" :rows="batch.rows" @changed="changed"/><MobileStocktakeDialog v-if="stocktake.visible" v-model="stocktake.visible" :product="stocktake.product" context-note="核对仓库实际总数；本批采购到货请用验收入库，避免重复登记。核对总数不会自动完成采购批次。" @saved="stocktakeSaved"/>
 <MobilePurchaseDialog v-if="purchase.visible" v-model="purchase.visible" :initial-rows="purchase.rows" @saved="changed"/><InventoryReceiveDialog v-if="receive.visible" v-model="receive.visible" :product-id="receive.id" :inbound-id="receive.batch" :product-name="receive.name" mobile @saved="changed"/>
 <MobileDialog :model-value="!!edit.row" class="mobile-dialog mobile-logistics-dialog" title="采购物流" mode="compact" append-to-body :show-close="!busy" :close-on-click-modal="false" @update:model-value="v=>{if(!v)edit.row=null}"><div class="mobile-form"><label>快递公司<input v-model="edit.courier" maxlength="128" :disabled="busy"></label><label>快递单号<input v-model="edit.tracking" placeholder="粘贴快递单号" maxlength="128" :disabled="busy"></label></div><template #footer><el-button :loading="busy" @click="saveLogistics">保存物流</el-button></template></MobileDialog>

</div></template>
<style scoped>
.mobile-receipt-filters{display:grid;grid-template-columns:minmax(0,.85fr) repeat(2,minmax(0,1.1fr));gap:7px;min-width:0}.mobile-receipt-filters.is-history{grid-template-columns:repeat(2,minmax(0,1fr))}.mobile-receipt-filters label{display:grid;gap:4px;min-width:0;font-size:12px;color:var(--el-text-color-secondary)}.mobile-receipt-filters select,.mobile-receipt-filters input{width:100%;min-width:0;box-sizing:border-box;min-height:36px;padding:5px;border:1px solid var(--el-border-color);border-radius:7px;background:var(--el-bg-color);color:var(--el-text-color-primary);font:inherit;font-size:12px}.mobile-receipt-filters input::-webkit-calendar-picker-indicator{width:13px;margin:0;padding:0}.mobile-work-queue>.mobile-list-controls{grid-auto-rows:max-content;align-content:start}.mobile-received-heading{display:flex;justify-content:space-between;align-items:center;gap:8px}.mobile-work-queue :deep(.mobile-inventory-filter-actions>.el-dropdown){flex:1;min-width:0}.mobile-work-queue :deep(.mobile-inventory-filter-actions>.el-dropdown>.el-button){width:100%}
.mobile-batch-toolbar{flex-wrap:wrap;justify-content:flex-start}.mobile-batch-actions{display:flex;flex-wrap:wrap;gap:6px}.mobile-batch-actions .el-button{min-height:36px;font-size:12px}.mobile-arrival-reminder{display:grid;gap:4px;padding:9px 11px;border-radius:8px;background:var(--el-color-warning-light-9);font-size:12px;overflow-wrap:anywhere}.mobile-arrival-reminder strong{color:var(--el-color-warning-dark-2)}.mobile-purchase-progress{display:flex;flex-wrap:wrap;gap:5px 12px;font-size:12px;color:var(--el-text-color-secondary)}
</style>
<style scoped>.mobile-work-queue{display:grid;gap:12px;min-width:0}.mobile-queue-tabs{display:flex;overflow-x:auto;gap:7px;padding-bottom:5px}.mobile-queue-tabs button{flex:0 0 auto;min-height:42px;padding:8px 12px;border:1px solid var(--el-border-color);background:var(--el-bg-color);color:var(--el-text-color-regular);border-radius:10px}.mobile-queue-tabs button.active{color:var(--el-color-primary);border-color:var(--el-color-primary)}.mobile-history-photos{display:flex;gap:8px;flex-wrap:wrap}.mobile-history-photos .el-image{width:72px;height:84px}.mobile-purchase-days{display:flex;gap:12px;overflow-x:auto;padding-bottom:4px;min-width:0}.mobile-purchase-month{flex:none;display:grid;gap:4px}.mobile-purchase-month>small{font-size:12px;color:var(--el-text-color-secondary)}.mobile-purchase-month>div{display:flex;gap:6px}.mobile-purchase-month button{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:44px;min-height:54px;padding:5px 7px;border:1px solid var(--el-border-color);border-radius:8px;background:var(--el-bg-color);color:var(--el-text-color-regular);font:inherit;font-size:13px;white-space:nowrap}.mobile-purchase-month button[aria-pressed=true]{background:var(--el-color-primary-light-9);border-color:var(--el-color-primary)}.mobile-purchase-month b{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:20px;height:20px;padding:0 4px;border-radius:999px;color:#fff;font-size:12px;font-variant-numeric:tabular-nums}.mobile-purchase-month .is-recent{background:#4b7563}.mobile-purchase-month .is-overdue{background:#a35454}.mobile-purchase-month .is-empty{background:#6b7280}.mobile-batch-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px}.mobile-batch-toolbar .el-button{margin:0}.covered{color:var(--el-color-success)}.mobile-overdue,.required{color:var(--el-color-danger)!important}</style>
