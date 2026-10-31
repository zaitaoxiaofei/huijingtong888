<script setup>
import {computed,defineAsyncComponent,onActivated,onBeforeUnmount,onDeactivated,onMounted,reactive,ref,watch} from 'vue';
import {ElMessage} from 'element-plus';
import {Box,Document,ShoppingCart,Van,Warning} from '@element-plus/icons-vue';
import {useAuthStore} from '../../stores/auth.js';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {PROCUREMENT_GAP_CAUSES,PROCUREMENT_GAP_FIELDS} from '../../../../src/shared/procurement-demand-types.js';
import {procurementDemandType} from '../../../../src/shared/inventory-workflow.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import InventoryPageToolbar from './InventoryPageToolbar.vue';
import {createInventoryWorkspacePageCache} from '../../utils/inventory-workspace-pages.js';
import {inventoryPurchaseQuantity,inventoryPurchaseReady} from '../../../../src/shared/inventory-supply-plan.js';
import {inventorySupplyLines} from '../../../../src/shared/inventory-supply-lines.js';
import {inventoryWorkspacePage} from '../../../../src/shared/inventory-workspace.js';
import {inventorySearchDefaults} from '../../../../src/shared/inventory-search-fields.js';
import ProductImagePreview from '../ProductImagePreview.vue';
const InventoryFbpReceiptReview=defineAsyncComponent(()=>import('./InventoryFbpReceiptReview.vue'));
const workspaceTab=ref('stock');
const ReceiveDialog=defineAsyncComponent(()=>import('../procurement/InventoryReceiveDialog.vue'));
const receiving=reactive({visible:false,id:0,name:''});
const ProcurementLedgerDialog=defineAsyncComponent(()=>import('../procurement/ProcurementLedgerDialog.vue'));
const ProcurementRequestCreateDialog=defineAsyncComponent(()=>import('../procurement/ProcurementRequestCreateDialog.vue'));
const BatchPurchase=defineAsyncComponent(()=>import('../procurement/ProcurementBatchPurchaseDialog.vue'));
const BatchQueue=defineAsyncComponent(()=>import('../procurement/InventoryPurchaseBatchQueue.vue'));
const ForecastDialog=defineAsyncComponent(()=>import('../procurement/InventoryFbpForecastDialog.vue'));
const ForecastDetails=defineAsyncComponent(()=>import('../procurement/InventoryFbpForecastDetails.vue'));
const forecastDialog=reactive({visible:false,id:0,name:''});
const DemandDetails=defineAsyncComponent(()=>import('../procurement/ProcurementDemandDetails.vue'));
const emit=defineEmits(['clear-product','purchased','track']);
const props=defineProps({role:{type:String,default:'warehouse'},productId:{type:Number,default:0}});
const auth=useAuthStore(),loading=ref(false),error=ref(''),rows=ref([]),total=ref(0),meta=ref({}),snapshot=ref({}),checkingProduct=ref(0);
const filters=reactive({...inventorySearchDefaults(),query:'',scope:'all',task:'required',page:1,pageSize:20});
const canCount=computed(()=>hasPermission(auth.user,'inventory.write'));
const canReceive=computed(()=>hasPermission(auth.user,'packing')||hasPermission(auth.user,'procurement'));
const canPurchase=computed(()=>hasPermission(auth.user,'procurement'));
const canFbp=computed(()=>hasPermission(auth.user,'inventory.write'));
const canReport=computed(()=>canCount.value||canReceive.value);
const ledger=reactive({visible:false,productId:0,action:''}),purchase=reactive({visible:false,row:null,error:''});
const feedback=reactive({visible:false,row:null,note:'',key:'',busy:false,loading:false,types:[],cause:'physical_shortage',plan:{}});
const supplyTable=ref(null),selected=ref([]),batchVisible=ref(false),batchRows=ref([]),batchCounts=ref({}),readAt=ref(''),batchRevision=ref(0);
const fbpReceiptCount=ref(null);
const pageCache=createInventoryWorkspacePageCache();
let warmRequest=null,warmController,countsKey='',countsAt=0,countsVersion=0;
function clearPages(){pageCache.clear();warmController?.abort();warmRequest=null;}
const isBatch=computed(()=>['incoming','receiving'].includes(filters.task));
const detail=reactive({visible:false,productId:0,tab:'orders'});
const demandTypes=[{key:'real_order',label:'FBS订单需求'},{key:'local_safety',label:'本地保障需求'},{key:'fbp_stock',label:'FBP正式备货申请'},{key:'fbp_forecast',label:'FBP预测预警建议'}];
const openBatches=row=>(row.pending_batches||[]).filter(b=>!b.received_at);
function openDetail(row,tab){Object.assign(detail,{visible:true,productId:Number(row.product_id),tab});}
function applyDetail(state){clearPages();hasUpdates.value=true;if(state)rows.value=rows.value.map(row=>Number(row.product_id)===Number(state.product_id)?{...row,workflow:state}:row);}
async function purchased(){const id=Number(purchase.row.product_id);purchase.visible=false;await refreshPurchased([id]);emit('purchased',{productId:id});}
async function forecastCreated(){const id=forecastDialog.id;forecastDialog.visible=false;await refreshPurchased([id]);}
const tasks=[{key:'required',label:'必须采购',hint:'FBS订单／正式FBP申请',icon:Document},{key:'advisory',label:'保障补货',hint:'本地保障 / FBP预测建议',icon:Warning},{key:'incoming',label:'采购待到货',hint:'采购确认签收',icon:Van},{key:'receiving',label:'到货待验收',hint:'仓库核对数量并入库',icon:Box},{key:'fbp-receipts',label:'FBP到货验收',hint:'发往FBP的SKU逐项核对',icon:Box}];
let version=0,controller,disposed=false,active=true;
const hasUpdates=ref(false);
function queueRefresh(){clearPages();hasUpdates.value=true;}
const units=n=>n==null?'待核对':`${Number(n)} 件`;
const plan=row=>row.workflow?.supply_plan||{};
const demandLines=row=>inventorySupplyLines(row.workflow);
const forecastPendingLabel=row=>row.workflow?.fbp?.sku_count===0?'未绑定可核算SKU':row.workflow?.fbp?.missing_stock_count>0?`${row.workflow.fbp.missing_stock_count} 个SKU库存未同步`:row.workflow?.fbp?.unknown_reason||'FBP预测待核实';
const age=value=>{if(!value)return null;const date=typeof value==='string'&&!value.includes('T')?value.replace(' ','T')+'Z':value;const at=new Date(date).getTime();return Number.isFinite(at)?Math.max(0,Math.floor((Date.now()-at)/86400000)):null;};
const purchaseRequestIds=row=>(row?.workflow?.requests||[]).filter(r=>{const type=procurementDemandType(r),p=plan(row);return p.required_purchase>0?(type==='real_order'&&p.required_fbs>0)||(type==='fbp_stock'&&p.required_fbp>0):(type==='local_safety'&&p.optional_local>0)||(type==='fbp_forecast'&&p.optional_fbp>0);}).map(r=>r.id);
function taskCount(key){if(key==='fbp-receipts')return fbpReceiptCount.value??'—';return key==='incoming'?batchCounts.value.open??'—':key==='receiving'?batchCounts.value.arrived??'—':meta.value[key]??'—';}
function taskHint(task){if(task.key==='incoming')return `${batchCounts.value.open_quantity??'—'} 件待到货`;if(task.key==='receiving')return `${batchCounts.value.arrived_quantity??'—'} 件待验收`;return task.hint;}
function switchTask(key){if(key==='fbp-receipts'){workspaceTab.value='fbp';return;}workspaceTab.value='stock';filters.task=key;selected.value=[];if(['incoming','receiving'].includes(key))filters.scope='all';void load(true);}
async function startBatch(){
 if(checkingProduct.value)return;
 if(!selected.value.length){batchRows.value=[];batchVisible.value=true;return;}
 if(selected.value.length>100)return ElMessage.warning('一次最多登记100项库存，请分批选择');
 const scope=currentApiCacheScope(),chosen=[...selected.value];checkingProduct.value=-1;
 try{const fresh=[];for(let i=0;i<chosen.length;i+=20){const result=await apiClient.get(`/api/inventory-workflow?view=status&fresh=1&product_ids=${chosen.slice(i,i+20).map(r=>r.product_id).join(',')}`,{noCache:true});fresh.push(...result.rows||[]);}
  if(disposed||!active||scope!==currentApiCacheScope())return;
  const unknown=fresh.find(r=>inventoryPurchaseQuantity(r.supply_plan)===null);if(unknown)return ElMessage.warning('部分库存数量尚未核实，请先核对实物再登记采购');
  batchRows.value=chosen.map(row=>({...row,workflow:fresh.find(r=>Number(r.product_id)===Number(row.product_id))})).filter(row=>plan(row).required_purchase>0||plan(row).optional_purchase>0);
  if(!batchRows.value.length)return ElMessage.info('所选库存最新货源已覆盖需求，无需重复采购');batchVisible.value=true;
 }catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{checkingProduct.value=0;}
}
async function refreshPurchased(ids){
 const scope=currentApiCacheScope();clearPages();countsAt=0;hasUpdates.value=true;supplyTable.value?.clearSelection();selected.value=[];
 try{const fresh=[];for(let i=0;i<ids.length;i+=20){const result=await apiClient.get(`/api/inventory-workflow?view=status&fresh=1&product_ids=${ids.slice(i,i+20).join(',')}`,{noCache:true});fresh.push(...result.rows||[]);}if(disposed||!active||scope!==currentApiCacheScope())return;
  rows.value=rows.value.map(row=>{const state=fresh.find(r=>Number(r.product_id)===Number(row.product_id));if(!state)return row;const next={...row,workflow:state};for(const key of ['required','advisory'])meta.value[key]=Math.max(0,Number(meta.value[key]||0)+inventoryWorkspacePage([next],{task:key}).total-inventoryWorkspacePage([row],{task:key}).total);return next;});
  const before=rows.value.length;rows.value=inventoryWorkspacePage(rows.value,{task:filters.task,pageSize:100}).rows;total.value=Math.max(0,total.value-before+rows.value.length);readAt.value=new Date().toISOString();await loadBatchCounts();
 }catch(e){if(scope===currentApiCacheScope())ElMessage.warning('采购已登记，最新需求暂未读取，请点击刷新库存需求核对');}
}
async function batchPurchased(result){const ids=result.product_ids||batchRows.value.map(r=>Number(r.product_id));batchVisible.value=false;await refreshPurchased(ids);emit('purchased',{productIds:ids});}
async function loadBatchCounts(signal){
 const scope=currentApiCacheScope(),{page,task,...criteria}=filters;
 const key=JSON.stringify([scope,criteria,props.productId]);
 if(key===countsKey&&Date.now()-countsAt<20000)return;
 const token=++countsVersion,isCurrent=()=>!disposed&&active&&scope===currentApiCacheScope()&&token===countsVersion;
 if(key!==countsKey){batchCounts.value={};fbpReceiptCount.value=null;}
 const qs=new URLSearchParams({...criteria,...(props.productId?{product_id:props.productId}:{})});
 const requests=[
  apiClient.get(`/api/inventory-workflow/purchase-arrivals?${qs}&status=open&summary_only=1`,{noCache:true,signal}).then(r=>{if(isCurrent())batchCounts.value=r.summary||{};}),
  apiClient.get(`/api/inventory-workflow/details?${qs}&node=fbp-receipts&summary_only=1`,{noCache:true,signal}).then(r=>{if(isCurrent())fbpReceiptCount.value=r.total??null;})
 ];
 const results=await Promise.allSettled(requests);
 if(!signal?.aborted&&isCurrent()&&results.every(r=>r.status==='fulfilled')){countsKey=key;countsAt=Date.now();}
}
function workspaceUrl(page=filters.page){return `/api/inventory-workflow/alerts?${new URLSearchParams({...filters,page,view:'workspace',compact:'1',...(props.productId?{product_id:props.productId}:{})})}`;}
function applyPage(result){rows.value=result.rows||[];total.value=result.total||0;meta.value=result.meta||{};snapshot.value=result.snapshot||{};readAt.value=new Date().toISOString();batchRevision.value++;}
function warmNextPage(result,scope,token){
 if(disposed||!active||token!==version||filters.page*filters.pageSize>=Number(result.total||0)||isBatch.value)return;
 const url=workspaceUrl(Number(filters.page)+1);
 if(pageCache.get(scope,url)||warmRequest?.url===url)return;
 warmController?.abort();warmController=new AbortController();
 const pending={url};warmRequest=pending;
 pending.promise=apiClient.get(url,{noCache:true,signal:warmController.signal}).then(r=>{if(!disposed&&active&&scope===currentApiCacheScope()&&token===version)pageCache.set(scope,url,r);return r;}).catch(()=>null).finally(()=>{if(warmRequest===pending)warmRequest=null;});
}
async function load(reset=false,fresh=false,fromPage=false){
 if(reset){filters.page=1;supplyTable.value?.clearSelection();selected.value=[];}
 if(!fromPage||fresh||hasUpdates.value){clearPages();countsAt=0;}
 hasUpdates.value=false;controller?.abort();controller=new AbortController();const token=++version,scope=currentApiCacheScope(),url=workspaceUrl();error.value='';
 const cached=fromPage?pageCache.get(scope,url):null;
 loading.value=!cached;
 try{
  let result=cached;
  if(!result&&warmRequest?.url===url)result=await warmRequest.promise;
  if(!result)result=await apiClient.get(url+(fresh?'&refresh=1':''),{noCache:true,signal:controller.signal});
  if(!disposed&&active&&token===version&&scope===currentApiCacheScope()){pageCache.set(scope,url,result);applyPage(result);void loadBatchCounts(controller.signal);warmNextPage(result,scope,token);}
 }catch(e){if(token===version&&e.name!=='AbortError'){error.value=e.message||'库存需求暂不可用';}}
 finally{if(token===version)loading.value=false;}
}

function resetScope(){++countsVersion;clearPages();countsKey='';countsAt=0;fbpReceiptCount.value=null;snapshot.value={};batchCounts.value={};readAt.value='';selected.value=[];batchVisible.value=false;forecastDialog.visible=false;checkingProduct.value=0;++version;controller?.abort();Object.assign(filters,inventorySearchDefaults());filters.query='';filters.scope='all';filters.task='required';if(props.productId)emit('clear-product');rows.value=[];meta.value={};total.value=0;loading.value=false;detail.visible=false;ledger.visible=false;receiving.visible=false;ledger.productId=0;purchase.visible=false;purchase.row=null;feedback.visible=false;feedback.row=null;if(active)void load(true);}
function openLedger(row,action=''){if(action==='receive'){Object.assign(receiving,{visible:true,id:Number(row.product_id),name:row.product_name});return;}Object.assign(ledger,{visible:true,productId:Number(row.product_id),action});}
let purchaseVersion=0,purchaseController;
watch(()=>purchase.visible,value=>{if(!value){++purchaseVersion;purchaseController?.abort();checkingProduct.value=0;}});
async function openPurchase(row){
 if(checkingProduct.value===-1)return;
 purchaseController?.abort();purchaseController=new AbortController();const token=++purchaseVersion;
 const scope=currentApiCacheScope(),id=Number(row.product_id);checkingProduct.value=id;
 Object.assign(purchase,{row,error:'',visible:true});
 try{const result=await apiClient.get(`/api/inventory-workflow?view=status&product_id=${id}&fresh=1`,{noCache:true,signal:purchaseController.signal});
  if(disposed||!active||token!==purchaseVersion||!purchase.visible||scope!==currentApiCacheScope())return;
  const current=result.rows?.find(r=>Number(r.product_id)===id);
  if(!current?.supply_plan||inventoryPurchaseQuantity(current.supply_plan)===null){purchase.error='本次尚无可确认的采购数量，请核对对应需求；不会将未知数量当零';return;}
  if(!(current.supply_plan.required_purchase>0||current.supply_plan.optional_purchase>0)){purchase.error='最新货源已覆盖需求，无需重复采购，请返回刷新列表';return;}
  purchase.row={...row,workflow:current};
 }catch(e){if(token===purchaseVersion&&e.name!=='AbortError'&&scope===currentApiCacheScope())purchase.error=e.message||'核对最新采购需求失败，请重新打开重试';}
 finally{if(token===purchaseVersion&&scope===currentApiCacheScope())checkingProduct.value=0;}
}
async function openFeedback(row){
 Object.assign(feedback,{visible:true,row,note:'',key:crypto.randomUUID(),busy:false,loading:true,types:[],cause:'physical_shortage',plan:{}});
 const scope=currentApiCacheScope(),key=feedback.key;
 try{const result=await apiClient.get(`/api/inventory-workflow?view=status&product_id=${row.product_id}&fresh=1`,{noCache:true});if(scope!==currentApiCacheScope()||key!==feedback.key)return;feedback.plan=result.rows?.[0]?.supply_plan||{};feedback.types=demandTypes.filter(t=>feedback.plan[PROCUREMENT_GAP_FIELDS[t.key]]>0).map(t=>t.key);}
 catch(e){if(scope===currentApiCacheScope()&&key===feedback.key)ElMessage.error(e.message);}finally{if(key===feedback.key)feedback.loading=false;}
}
async function sendFeedback(){
 if(!feedback.types.length||!feedback.note.trim())return ElMessage.warning('请选择实际缺口需求并填写具体成因');
 const scope=currentApiCacheScope(),key=feedback.key;feedback.busy=true;
 try{const result=await apiClient.post('/api/inventory-workflow/demand-request',{product_id:Number(feedback.row.product_id),demand_types:feedback.types,cause:feedback.cause,note:feedback.note,request_key:key});
  if(scope!==currentApiCacheScope()||key!==feedback.key)return;ElMessage.success(`已处理 ${result.requests?.length||0} 类采购需求并通知采购；已有需求关联说明，不重复增加数量`);feedback.visible=false;hasUpdates.value=true;
 }catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{if(key===feedback.key)feedback.busy=false;}
}

onMounted(()=>{window.addEventListener('erp:auth-scope-changed',resetScope);window.addEventListener('erp:system-notification',queueRefresh);});
onActivated(()=>{active=true;});
onDeactivated(()=>{++countsVersion;clearPages();active=false;detail.visible=false;ledger.visible=false;receiving.visible=false;purchase.visible=false;feedback.visible=false;batchVisible.value=false;forecastDialog.visible=false;++version;controller?.abort();loading.value=false;});
onBeforeUnmount(()=>{++countsVersion;clearPages();disposed=true;++version;controller?.abort();window.removeEventListener('erp:auth-scope-changed',resetScope);window.removeEventListener('erp:system-notification',queueRefresh);});
watch(()=>props.productId,()=>load(true),{immediate:true});
defineExpose({refresh:load});
</script>
<template>
 <section class="supply-workspace" :aria-label="role==='procurement'?'库存采购需求':'库存管理模式'">
  <el-tabs v-model="workspaceTab"><el-tab-pane name="stock" :label="role==='warehouse'?'库存核对':'采购需求'"/><el-tab-pane name="fbp" label="FBP入库确认"/></el-tabs>
  <template v-if="workspaceTab==='fbp'"><div class="supply-heading-actions"><slot name="heading-actions"/></div><InventoryFbpReceiptReview :product-id="productId" @saved="queueRefresh();countsAt=0;loadBatchCounts()"/></template>
  <template v-else>
  <InventoryPageToolbar :filters="filters" product-search compact-search :show-shop="false" :show-date-range="false" :loading="loading" @search="load(true)" @reset="Object.assign(filters,inventorySearchDefaults(),{query:'',scope:'all'});load(true)">
   <el-form-item label="库存范围"><el-select v-model="filters.scope" aria-label="库存范围" @change="load(true)"><el-option value="all" label="全部库存"/><el-option v-if="!isBatch" value="orders" label="FBS订单关联库存"/></el-select></el-form-item>
   <template #right><span class="supply-read-time" :title="'读取时间：'+(readAt?shanghaiDateTimeText(readAt):'未读取')">读取 {{readAt?shanghaiDateTimeText(readAt):'尚未读取'}}<small>核算 {{snapshot.calculated_at?shanghaiDateTimeText(snapshot.calculated_at):'尚未完成'}}</small></span><el-button :loading="loading" @click="load()">{{hasUpdates?'有新变化 · 刷新库存需求':'刷新库存需求'}}</el-button><el-button :disabled="snapshot.refreshing" @click="load(false,true)">重新核算</el-button><div class="supply-context-actions"><el-button v-if="canPurchase&&!isBatch" type="primary" :disabled="!!checkingProduct" :loading="checkingProduct===-1" @click="startBatch">批量登记采购{{selected.length?`（${selected.length}）`:''}}</el-button><el-button plain size="small" @click="switchTask('review')">库存异常 / 资料待核实 {{meta.review??'—'}}</el-button><el-button v-if="!isBatch" plain size="small" @click="switchTask('all')">查看全部库存</el-button><el-button v-if="productId" size="small" @click="emit('clear-product')">返回全部库存</el-button></div><slot name="heading-actions"/></template>
  </InventoryPageToolbar>
  <div class="supply-task-cards"><button v-for="task in tasks" :key="task.key" :data-task="task.key" :class="['supply-task',`is-${task.key}`,{'is-active':filters.task===task.key}]" @click="switchTask(task.key)"><component :is="task.icon"/><div><span>{{task.label}}</span><strong>{{taskCount(task.key)}}<span class="supply-task-unit">{{['incoming','receiving','fbp-receipts'].includes(task.key)?'个批次':'项库存'}}</span></strong><small>{{taskHint(task)}}</small></div></button></div>

  <el-alert v-if="snapshot.error||snapshot.refreshing||snapshot.available===false" :type="snapshot.error?'warning':'info'" :closable="false" :title="snapshot.error|| (snapshot.available===false?'尚无成功核算结果，暂不能判断是否缺货':'后台正在核对最新需求，页面保持不变，稍后点击刷新查看')"/>
  <BatchQueue v-if="isBatch" :status="filters.task==='incoming'?'open':'arrived'" :filters="filters" :revision="batchRevision" :product-id="productId" @summary="value=>batchCounts=value" @changed="hasUpdates=true;countsAt=0;loadBatchCounts()"/>
  <template v-else>
  <p class="supply-policy-hint">必须采购与保障补货分开处理；现货和采购在途只抵扣一次。缺口是待补数量，采购建议是扣除可用货源后的净数量；FBP实物独立核对，不抵扣本地订单。同一预测转申请后不重复计算。</p>
  <el-alert v-if="error" :title="error+'。'+(rows.length?'当前保留上次成功结果，请刷新后再核对需求':'未能读取采购需求，不代表没有缺货')" type="error" :closable="false" show-icon/>
  <el-table ref="supplyTable" @selection-change="value=>selected=value" v-loading="loading" :data="rows" row-key="product_id" class="supply-table" :empty-text="snapshot.available===false&&!snapshot.refreshing?'尚无成功核算结果，请重新核算；不代表没有采购需求':snapshot.refreshing?'后台正在核对需求，请稍候；暂不可判断为零缺口':snapshot.incomplete?'有新库存尚待核算，请稍候或重新核算':error?'库存需求加载失败，请重试；这不代表没有采购需求':loading?'正在核对库存需求，请稍候':'当前筛选没有待处理库存，可切换其他任务或查看全部'" border>

   <el-table-column v-if="canPurchase" type="selection" reserve-selection width="45" :selectable="row=>inventoryPurchaseReady(plan(row))"/>
   <el-table-column label="库存商品" min-width="270"><template #default="{row}"><div class="supply-product"><ProductImagePreview :src="`/api/products/${row.product_id}/image?thumb=1`" :preview-list="[`/api/products/${row.product_id}/image`]" size="portrait"/><div><strong>{{row.product_name}}</strong><span>库存 ID：{{row.inventory_number||row.product_id}}</span><el-button plain size="small" @click="openLedger(row)">库存详情</el-button></div></div></template></el-table-column>
   <el-table-column label="库存事实" min-width="175"><template #default="{row}"><div class="supply-quantities supply-stock-facts"><span><span>{{row.workflow?.physical_recorded<0?'本地账面（异常）':'本地实物'}}</span><b>{{units(row.workflow?.physical_recorded??row.workflow?.physical)}}</b></span><span><el-button link type="primary" @click="openLedger(row)">FBP实物</el-button><b>{{units(row.workflow?.fbp?.physical)}}</b></span><small>本地FBP锁定 {{units(row.workflow?.locked)}}</small><small v-if="!plan(row).known" class="supply-review-reason">{{row.workflow?.review_reasons?.[0]||'本地账面待核对，请先盘点实物'}}</small><el-button plain size="small" @click="openLedger(row,'stocktake')" v-if="canCount">核对实物</el-button></div></template></el-table-column>
   <el-table-column label="采购在途" min-width="150"><template #default="{row}"><div class="supply-quantities"><b>{{units(row.workflow?.incoming)}}</b><small>含已到货待验收货源</small><el-button plain size="small" @click="openDetail(row,'batches')">采购批次</el-button></div></template></el-table-column>
   <el-table-column label="需求缺口与货源覆盖" min-width="330"><template #default="{row}"><div class="supply-demand-lines">
    <div v-for="line in demandLines(row)" :key="line.key" :class="['supply-demand-line',`is-${line.status}`]">
     <span><el-button link :type="line.status" @click="openDetail(row,line.key)">{{line.label}}</el-button><strong>{{line.key==='fbp'&&line.quantity===0?'暂无申请':line.status==='success'&&!(line.quantity>0)?'已覆盖':line.quantity==null?(line.key==='forecast'?forecastPendingLabel(row):'货源待仓库核实'):(line.partial?'未覆盖 ':'')+units(line.quantity)}}</strong></span>
     <small v-if="line.partial">订单共 {{units(line.target)}}；按未覆盖订单采购，历史负账面另核对</small>
     <small v-if="line.status!=='success'&&line.quantity==null&&line.target!=null">已知需求 {{units(line.target)}}，覆盖量待核实</small>
     <small v-if="line.unbacked>0">含已确认锁定缺货 {{units(line.unbacked)}}</small>
     <small v-if="line.key==='forecast'&&line.quantity!=null">发仓在途 {{units(row.workflow.fbp.in_transit)}} · 已确认 {{units(row.workflow.fbp.committed)}} · 待申请 {{units(line.unsubmitted)}}</small>
     <small v-if="(line.key==='fbp'||line.key==='forecast')&&line.quantity>0">本地可供 {{units(line.stock)}} · 采购在途 {{units(line.incoming)}}</small>
     <small v-else-if="line.quantity>0">采购在途覆盖 {{units(line.incoming)}}</small>
     <small v-if="line.quantity>0||line.purchase>0">{{line.required?'必须采购':'建议采购'}} <b>{{units(line.purchase)}}</b></small>
     <small v-if="line.key==='forecast'&&line.quantity!=null&&!(line.unsubmitted>0)&&line.replenishment>0">待审核申请已覆盖剩余预测，不重复采购</small>
    </div>
    <small v-if="!demandLines(row).length">各项需求已覆盖</small>
    <el-button v-if="canFbp&&plan(row).fbp_forecast_quantity>0" plain size="small" type="warning" @click="Object.assign(forecastDialog,{visible:true,id:Number(row.product_id),name:row.product_name})">创建FBP申请</el-button>
   </div></template></el-table-column>
   <el-table-column label="本次采购建议" min-width="190"><template #default="{row}"><div class="supply-purchase-summary"><b :class="{'is-required':plan(row).required_purchase>0}">必须采购 {{units(plan(row).required_purchase)}}</b><span>可选保障补货 {{units(plan(row).optional_purchase)}}</span><strong>建议总采购 {{inventoryPurchaseQuantity(plan(row))==null?'待核对':units(inventoryPurchaseQuantity(plan(row)))}}</strong><small v-if="plan(row).known">已抵扣本地实物及采购在途</small><small v-else-if="row.workflow?.purchase_partial">仅含已确认的FBS订单缺口；保障与FBP另行核实</small><small v-else>{{row.workflow?.review_reasons?.join('；')||'本地账面待核实，不能按零缺口处理'}}</small><small v-if="!plan(row).fbp_forecast_known">FBP预测待核实，以上仅为已知需求合计</small></div></template></el-table-column>
   <el-table-column label="未关闭采购" min-width="190"><template #default="{row}"><div v-if="openBatches(row).length" class="supply-open-purchases"><el-button v-for="batch in openBatches(row).slice(0,3)" :key="batch.id" link type="primary" @click="openDetail(row,'batches')">{{batch.order_no||`批次 #${batch.id}`}} · {{batch.quantity}} 件</el-button><small>{{openBatches(row).length}} 个未到货批次，最早已采购 {{age(openBatches(row)[0].purchased_at)??'待核'}} 天</small></div><span v-else>暂无未关闭采购</span><el-button v-if="role==='procurement'" link type="primary" @click="emit('track',{productId:Number(row.product_id)})">采购到货跟踪</el-button></template></el-table-column>
   <el-table-column label="处理" min-width="155" fixed="right"><template #default="{row}"><div class="supply-row-actions"><el-button v-if="canReceive&&row.pending_batches?.length" type="primary" plain @click="openLedger(row,'receive')">验货入库</el-button><el-button v-if="canPurchase" type="primary" :loading="checkingProduct===Number(row.product_id)" :disabled="!!checkingProduct||!inventoryPurchaseReady(plan(row))" @click="openPurchase(row)">登记采购</el-button><el-button v-if="canCount" link type="primary" @click="openLedger(row,'stocktake')">核对实物</el-button><el-button v-if="canReport" link type="warning" @click="openFeedback(row)">创建采购需求</el-button></div></template></el-table-column>
  </el-table>
  <el-pagination v-if="snapshot.available!==false" v-model:current-page="filters.page" :page-size="filters.pageSize" :total="total" layout="total, prev, pager, next" @current-change="load(false,false,true)"/>
  </template>
  </template>
  <ForecastDialog v-if="forecastDialog.visible" v-model="forecastDialog.visible" :product-id="forecastDialog.id" :product-name="forecastDialog.name" @created="forecastCreated"/>
  <BatchPurchase v-if="batchVisible" v-model="batchVisible" :initial-rows="batchRows" @created="batchPurchased"/>
  <ReceiveDialog v-if="receiving.visible" v-model="receiving.visible" :product-id="receiving.id" :product-name="receiving.name" @saved="load(false,true)"/>
  <ProcurementLedgerDialog v-if="ledger.visible" v-model="ledger.visible" :product-id="ledger.productId" :initial-action="ledger.action" :stocktake-enabled="canCount" @saved="load(false,true)"/>
  <ProcurementRequestCreateDialog v-if="purchase.visible" v-model="purchase.visible" :initial-product-id="purchase.row.product_id" :initial-quantity="Math.max(1,Number(plan(purchase.row).required_purchase||0)+Number(plan(purchase.row).optional_purchase||0))" :source-request-ids="purchaseRequestIds(purchase.row)" :verifying-demand="checkingProduct===Number(purchase.row.product_id)" :demand-error="purchase.error" :initial-product="{id:Number(purchase.row.product_id),name:purchase.row.product_name,inventory_id:purchase.row.inventory_number,image_url:`/api/products/${purchase.row.product_id}/image?thumb=1`}" lock-product @created="purchased"/>
  <el-drawer v-if="detail.visible" v-model="detail.visible" title="库存采购需求明细" size="min(1200px,96vw)" append-to-body destroy-on-close><ForecastDetails v-if="detail.tab==='forecast'" :product-id="detail.productId" @create="Object.assign(forecastDialog,{visible:true,id:detail.productId,name:rows.find(r=>Number(r.product_id)===Number(detail.productId))?.product_name||''})"/><DemandDetails v-else :product-id="detail.productId" :initial-tab="detail.tab" @changed="applyDetail"/></el-drawer>
  <el-dialog v-if="feedback.visible" v-model="feedback.visible" title="创建采购需求" width="min(650px,94vw)" append-to-body :close-on-click-modal="false" :show-close="!feedback.busy">
   <div v-loading="feedback.loading"><h3>{{feedback.row.product_name}}</h3><p>需求来源分为四类；按当前未被现货及采购在途覆盖的缺口创建，不重复叠加采购数量。</p><el-form label-position="top"><el-form-item label="需求来源"><el-checkbox-group v-model="feedback.types"><el-checkbox v-for="type in demandTypes" :key="type.key" :value="type.key" :disabled="!(feedback.plan[PROCUREMENT_GAP_FIELDS[type.key]]>0)">{{type.label}} {{units(feedback.plan[PROCUREMENT_GAP_FIELDS[type.key]])}}</el-checkbox></el-checkbox-group></el-form-item><el-form-item label="缺口成因"><el-select v-model="feedback.cause"><el-option v-for="(label,key) in PROCUREMENT_GAP_CAUSES" :key="key" :value="key" :label="label"/></el-select></el-form-item><el-alert v-if="feedback.cause==='physical_mismatch'" title="请先盘点并更新本地实物，再按系统识别出的四类缺口创建需求。" type="info" :closable="false"/><el-button v-if="feedback.cause==='physical_mismatch'&&canCount" link type="primary" @click="feedback.visible=false;openLedger(feedback.row,'stocktake')">先核对本地实物</el-button><el-form-item label="具体说明（必填）"><el-input v-model="feedback.note" type="textarea" :rows="3" maxlength="300" show-word-limit placeholder="例如：原记录30件，盘点仅3件，导致已提交的FBP申请缺货"/></el-form-item></el-form></div>
   <template #footer><el-button :disabled="feedback.busy" @click="feedback.visible=false">取消</el-button><el-button type="primary" :loading="feedback.busy" :disabled="feedback.loading||!feedback.types.length" @click="sendFeedback">创建采购需求并通知采购</el-button></template>
  </el-dialog>
 </section>
</template>
<style scoped>
.supply-purchase-summary{display:grid;gap:9px;justify-items:start}.supply-purchase-summary strong{color:var(--el-color-primary)}.supply-purchase-summary small{font-size:12px;color:var(--el-text-color-secondary)}.supply-purchase-summary .is-required{color:var(--el-color-danger)}.supply-read-time{display:grid;gap:2px;font-size:11px;color:var(--el-text-color-secondary);white-space:nowrap}.supply-review-reason{color:var(--el-color-warning);line-height:1.5}.supply-context-actions{display:flex;gap:8px;flex-wrap:wrap}.supply-context-actions .el-button{margin:0}.supply-open-purchases{display:grid;gap:8px}.supply-open-purchases .el-button{justify-content:flex-start;margin:0}.supply-open-purchases small{color:var(--el-text-color-secondary)}.supply-workspace{display:grid;gap:12px;min-width:0;color:var(--el-text-color-primary)}.supply-heading{display:flex;justify-content:space-between;align-items:center;gap:16px}.supply-policy-hint{font-size:12px;color:var(--el-text-color-secondary);margin:0}.supply-workspace :deep(.inventory-search-actions){flex-shrink:0}.supply-workspace :deep(.inventory-toolbar-right){flex-wrap:wrap;justify-content:flex-end;white-space:normal}.supply-heading-actions{display:flex;gap:8px;flex-wrap:wrap}.supply-heading h2{margin:0;font-size:20px}.supply-heading p{margin:7px 0 0;font-size:13px;color:var(--el-text-color-secondary)}.supply-task-cards{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px}.supply-task{display:flex;gap:15px;align-items:center;text-align:left;border:1px solid var(--el-border-color-lighter);border-radius:8px;background:var(--el-bg-color-overlay);color:var(--el-text-color-primary);padding:10px 14px;cursor:pointer;font:inherit}.supply-task>svg{width:22px;height:22px;color:var(--el-color-primary)}.supply-task>div{display:grid;grid-template-columns:1fr auto;gap:6px;width:100%}.supply-task strong{font-size:21px}.supply-task-unit{font-size:11px;font-weight:normal;margin-left:5px;color:var(--el-text-color-secondary)}.supply-task small{grid-column:1/-1;color:var(--el-text-color-secondary);font-size:11px}.supply-task.is-required>svg{color:var(--el-color-danger)}.supply-task.is-advisory>svg{color:var(--el-color-warning)}.supply-task.is-active{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.supply-filters{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.supply-filters>.el-input{width:260px}.supply-filters>.el-select{width:240px}.supply-filters>span{font-size:12px;color:var(--el-text-color-secondary);margin-left:auto}.supply-product{display:flex;align-items:center;gap:12px;min-height:92px}.supply-product>div{display:grid;gap:7px;line-height:1.5}.supply-product span{font-size:12px;color:var(--el-text-color-secondary)}.supply-product strong{font-size:13px}.supply-product .el-button{justify-self:start;margin:0}.supply-quantities{display:grid;gap:9px;justify-items:start;font-size:12px}.supply-quantities b{display:block;margin-top:3px;font-size:14px}.supply-demand-lines{display:grid;gap:10px;font-size:12px}.supply-demand-line{display:grid;gap:4px;padding-bottom:7px;border-bottom:1px solid var(--el-border-color-lighter)}.supply-demand-line>span{display:flex;justify-content:space-between;gap:12px}.supply-demand-line small{line-height:1.5}.supply-stock-facts{width:100%}.supply-stock-facts>span{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%}.supply-stock-facts b{margin:0}.supply-stock-facts .el-button{padding:0}.supply-demand-lines strong{font-weight:500}.supply-demand-lines .is-danger strong{color:var(--el-color-danger)}.supply-demand-lines .is-warning strong{color:var(--el-color-warning)}.supply-demand-lines .is-success strong{color:var(--el-color-success)}.supply-demand-lines .is-info strong{color:var(--el-text-color-secondary)}.supply-source-button{justify-self:start;margin:0;padding:0;font-size:12px}.supply-demand-lines small{color:var(--el-text-color-secondary)}.supply-age{font-size:12px;margin:10px 0 0}.supply-age small{display:block;color:var(--el-text-color-secondary);margin-top:5px}.supply-row-actions{display:flex;flex-wrap:wrap;gap:8px}.supply-row-actions .el-button{margin:0}.supply-evidence{padding:18px 28px;display:grid;grid-template-columns:1fr 1fr;gap:24px;font-size:12px;background:var(--el-fill-color-extra-light)}.supply-evidence p{color:var(--el-text-color-secondary)}.source-line{display:flex;flex-wrap:wrap;gap:10px;padding:10px 0;border-bottom:1px solid var(--el-border-color-lighter)}.supply-feedback-history{grid-column:1/-1}.source-line small{color:var(--el-text-color-secondary)}.supply-workspace>.el-pagination{justify-content:flex-end}@media(max-width:900px){.supply-task-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.supply-evidence{grid-template-columns:1fr}.supply-filters>span{margin-left:0}}@media(max-width:500px){.supply-heading{align-items:flex-start}.supply-task{padding:12px;gap:8px}.supply-task small{line-height:1.5}.supply-filters>.el-input,.supply-filters>.el-select{width:100%}}
</style>
