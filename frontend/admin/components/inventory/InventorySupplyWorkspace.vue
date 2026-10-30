<script setup>
import {computed,defineAsyncComponent,onActivated,onBeforeUnmount,onDeactivated,onMounted,reactive,ref,watch} from 'vue';
import {ElMessage} from 'element-plus';
import {Box,Document,ShoppingCart,Van,Warning} from '@element-plus/icons-vue';
import {useAuthStore} from '../../stores/auth.js';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {procurementDemandType} from '../../../../src/shared/inventory-workflow.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import InventoryPageToolbar from './InventoryPageToolbar.vue';
import {inventorySearchDefaults} from '../../../../src/shared/inventory-search-fields.js';
import ProductImagePreview from '../ProductImagePreview.vue';
const ProcurementLedgerDialog=defineAsyncComponent(()=>import('../procurement/ProcurementLedgerDialog.vue'));
const ProcurementRequestCreateDialog=defineAsyncComponent(()=>import('../procurement/ProcurementRequestCreateDialog.vue'));
const emit=defineEmits(['clear-product']);
const props=defineProps({role:{type:String,default:'warehouse'},productId:{type:Number,default:0}});
const supplyTable=ref(null);
const auth=useAuthStore(),loading=ref(false),error=ref(''),rows=ref([]),total=ref(0),meta=ref({}),snapshot=ref({}),checkingProduct=ref(0);
const filters=reactive({...inventorySearchDefaults(),query:'',scope:'all',task:'required',page:1,pageSize:20});
const canCount=computed(()=>hasPermission(auth.user,'inventory.write'));
const canReceive=computed(()=>hasPermission(auth.user,'packing')||hasPermission(auth.user,'procurement'));
const canPurchase=computed(()=>hasPermission(auth.user,'procurement'));
const canReport=computed(()=>canCount.value||canReceive.value);
const ledger=reactive({visible:false,productId:0,action:''}),purchase=reactive({visible:false,row:null});
const feedback=reactive({visible:false,row:null,note:'',key:'',busy:false});
const tasks=[{key:'required',label:'必须处理',hint:'FBS订单／正式FBP申请',icon:Document},{key:'advisory',label:'建议补货',hint:'本地保障／FBP安全目标',icon:Warning},{key:'incoming',label:'已采购待到货',hint:'跟踪到货并验收',icon:Van},{key:'review',label:'库存待核对',hint:'先核实，再决定采购',icon:Box}];
let version=0,controller,disposed=false,active=true,refreshTimer,pollTimer;
function queueRefresh(){clearTimeout(refreshTimer);if(active&&document.visibilityState!=='hidden')refreshTimer=setTimeout(()=>load(),500);}
const units=n=>n==null?'待核对':`${Number(n)} 件`;
const plan=row=>row.workflow?.supply_plan||{};
const format=value=>value?shanghaiDateTimeText(value):'未记录采购时间';
const age=value=>{if(!value)return null;const date=typeof value==='string'&&!value.includes('T')?value.replace(' ','T')+'Z':value;const at=new Date(date).getTime();return Number.isFinite(at)?Math.max(0,Math.floor((Date.now()-at)/86400000)):null;};
const purchaseRequestIds=row=>(row?.workflow?.requests||[]).filter(r=>{const type=procurementDemandType(r),p=plan(row);return p.required_purchase>0?(type==='real_order'&&p.required_fbs>0)||(type==='fbp_stock'&&p.required_fbp>0):(type==='local_safety'&&p.optional_local>0)||(type==='fbp_stock'&&p.optional_fbp>0);}).map(r=>r.id);
const sources=row=>[...(row.workflow?.requests||[]).map(r=>({key:`R${r.id}`,label:r.applicant_name||(procurementDemandType(r)==='real_order'?'系统 · 订单触发':'历史申请人待核'),text:r.request_reason_code==='flow_real_order'?'FBS订单':r.request_reason_code==='flow_fbp_stock'?'FBP需求':'本地保障',quantity:r.quantity,time:r.created_at})),...(row.workflow?.applications||[]).filter(a=>a.status!=='draft').map(a=>({key:`F${a.item_id}`,label:a.applicant_name||'申请人待核',text:`${a.order_no||'FBP申请'} · ${a.ozon_sku}`,quantity:a.requested_quantity,time:a.submitted_at}))];
async function load(reset=false,fresh=false){
 if(reset)filters.page=1;
 clearTimeout(pollTimer);controller?.abort();controller=new AbortController();const token=++version,scope=currentApiCacheScope();loading.value=true;error.value='';
 try{const result=await apiClient.get(`/api/inventory-workflow/alerts?${new URLSearchParams({...filters,view:'workspace',...(fresh?{refresh:'1'}:{}),...(props.productId?{product_id:props.productId}:{})})}`,{noCache:true,signal:controller.signal});
  if(!disposed&&token===version&&scope===currentApiCacheScope()){rows.value=result.rows||[];total.value=result.total||0;meta.value=result.meta||{};snapshot.value=result.snapshot||{};}
 }catch(e){if(token===version&&e.name!=='AbortError'){error.value=e.message||'库存需求暂不可用';}}
 finally{if(token===version){loading.value=false;if(!error.value&&snapshot.value.status&&active&&document.visibilityState!=='hidden')pollTimer=setTimeout(()=>{if(active&&!disposed&&document.visibilityState!=='hidden')void load();},snapshot.value.refreshing?3000:60000);}}
}
function resetScope(){snapshot.value={};checkingProduct.value=0;clearTimeout(pollTimer);++version;clearTimeout(refreshTimer);controller?.abort();Object.assign(filters,inventorySearchDefaults());filters.query='';filters.scope='all';filters.task='required';if(props.productId)emit('clear-product');rows.value=[];meta.value={};total.value=0;loading.value=false;ledger.visible=false;ledger.productId=0;purchase.visible=false;purchase.row=null;feedback.visible=false;feedback.row=null;if(active)void load(true);}
function openLedger(row,action=''){Object.assign(ledger,{visible:true,productId:Number(row.product_id),action});}
async function openPurchase(row){
 if(checkingProduct.value)return;
 const scope=currentApiCacheScope(),id=Number(row.product_id);checkingProduct.value=id;
 try{const result=await apiClient.get(`/api/inventory-workflow?view=status&product_id=${id}&fresh=1`,{noCache:true});
  if(disposed||!active||scope!==currentApiCacheScope())return;
  const current=result.rows?.find(r=>Number(r.product_id)===id);
  if(!current?.supply_plan?.known)return ElMessage.warning('当前库存需求还未核实，请先核对实物');
  if(!(current.supply_plan.required_purchase>0||current.supply_plan.optional_purchase>0))return ElMessage.info('最新核对显示当前货源已覆盖需求，无需重复采购');
  purchase.row={...row,workflow:current};purchase.visible=true;
 }catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message||'核对最新采购需求失败，请重试');}
 finally{if(scope===currentApiCacheScope())checkingProduct.value=0;}
}
function openFeedback(row){Object.assign(feedback,{visible:true,row,note:'',key:crypto.randomUUID(),busy:false});}
async function sendFeedback(){
 if(!feedback.note.trim())return ElMessage.warning('请说明核实到的缺货或实物差异，方便运营和采购处理');
 const scope=currentApiCacheScope(),row=feedback.row;feedback.busy=true;
 try{const result=await apiClient.post('/api/inventory-workflow/feedback',{product_id:Number(row.product_id),note:feedback.note,request_key:feedback.key});
  if(scope!==currentApiCacheScope())return;
  ElMessage.success(result.notified?`已反馈，通知 ${result.notified} 位相关人员；采购缺口按最新库存计算`:'当前没有未覆盖需求，已完成核对');feedback.visible=false;await load();
 }catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{feedback.busy=false;}
}
onMounted(()=>{window.addEventListener('erp:auth-scope-changed',resetScope);window.addEventListener('erp:system-notification',queueRefresh);document.addEventListener('visibilitychange',queueRefresh);});
onActivated(()=>{const previous=active;active=true;if(!previous)void load();});
onDeactivated(()=>{active=false;ledger.visible=false;purchase.visible=false;feedback.visible=false;clearTimeout(refreshTimer);clearTimeout(pollTimer);++version;controller?.abort();loading.value=false;});
onBeforeUnmount(()=>{disposed=true;++version;clearTimeout(refreshTimer);controller?.abort();clearTimeout(pollTimer);window.removeEventListener('erp:auth-scope-changed',resetScope);window.removeEventListener('erp:system-notification',queueRefresh);document.removeEventListener('visibilitychange',queueRefresh);});
watch(()=>props.productId,()=>load(true),{immediate:true});
defineExpose({refresh:load});
</script>
<template>
 <section class="supply-workspace" :aria-label="role==='procurement'?'库存采购需求':'库存管理模式'">
  <div class="supply-heading"><div><h2>{{role==='procurement'?'按库存统一采购':'库存管理'}}</h2><p>{{role==='procurement'?'先处理订单与正式备货缺口，再决定保障采购':'按实物库存核对订单缺口、采购进度和到货验收'}}</p></div><div class="supply-heading-actions"><el-button v-if="productId" @click="emit('clear-product')">返回全部库存</el-button><el-button :loading="loading" @click="load()">刷新库存需求</el-button><el-button :disabled="snapshot.refreshing" @click="load(false,true)">重新核算</el-button></div></div>
  <div class="supply-task-cards"><button v-for="task in tasks" :key="task.key" :data-task="task.key" :class="['supply-task',`is-${task.key}`,{'is-active':filters.task===task.key}]" @click="filters.task=task.key;load(true)"><component :is="task.icon"/><div><span>{{task.label}}</span><strong>{{meta[task.key]??'—'}}</strong><small>{{task.hint}}</small></div></button></div>
  <InventoryPageToolbar :filters="filters" product-search :show-shop="false" :show-date-range="false" :loading="loading" @search="load(true)" @reset="Object.assign(filters,inventorySearchDefaults(),{query:'',scope:'all'});load(true)">
   <el-form-item label="库存范围"><el-select v-model="filters.scope" aria-label="库存范围" @change="load(true)"><el-option value="all" label="全部库存需求（含FBP）"/><el-option value="orders" label="FBS待发订单关联库存"/></el-select></el-form-item>
   <template #actions><el-button link @click="filters.task='all';load(true)">查看全部库存</el-button></template>
  </InventoryPageToolbar>
  <el-alert v-if="snapshot.status" :type="snapshot.status==='error'?'warning':'info'" :closable="false" show-icon class="supply-snapshot-status">
   <template #title>{{snapshot.available?'需求核算时间：'+shanghaiDateTimeText(snapshot.calculated_at):snapshot.error?'需求核算失败，请重新核算；暂不能判断是否缺货':'首次需求快照正在生成，请稍候，当前尚不能判断是否缺货'}}</template>
   <span v-if="snapshot.error">{{snapshot.error}}</span><span v-else-if="snapshot.refreshing">后台正在核对最新需求，完成后自动更新；已有结果继续显示。</span><span v-else-if="snapshot.stale||snapshot.incomplete">订单或库存有变化，后台将合并更新；发现不准可点“重新核算”。</span><span v-else>当前显示最近成功结果；登记采购前会重新核对该库存的需求。</span>
  </el-alert>
  <p class="supply-policy-hint">红色必须处理 · 黄色可按计划采购 · 同一库存的各店铺SKU统一核算</p>
  <el-alert v-if="error" :title="error+'。'+(rows.length?'当前保留上次成功结果，请刷新后再核对需求':'未能读取采购需求，不代表没有缺货')" type="error" :closable="false" show-icon/>
  <el-table ref="supplyTable" v-loading="loading" :data="rows" row-key="product_id" class="supply-table" :empty-text="snapshot.available===false&&!snapshot.refreshing?'尚无成功核算结果，请重新核算；不代表没有采购需求':snapshot.refreshing?'后台正在核对需求，请稍候；暂不可判断为零缺口':snapshot.incomplete?'有新库存尚待核算，请稍候或重新核算':error?'库存需求加载失败，请重试；这不代表没有采购需求':loading?'正在核对库存需求，请稍候':'当前筛选没有待处理库存，可切换其他任务或查看全部'" border>
   <el-table-column type="expand" width="40"><template #default="{row}"><div class="supply-evidence"><div><strong>需求来源与提交人</strong><p v-if="!sources(row).length">FBS订单与安全目标由系统汇总；人员申请会在这里保留来源。</p><div v-for="source in sources(row).slice(0,20)" :key="source.key" class="source-line"><b>{{source.label}}</b><span>{{source.text}}</span><span>{{units(source.quantity)}}</span><small>{{format(source.time)}}</small></div></div><div><strong>已采购待验收批次</strong><p v-if="!row.pending_batches?.length">暂无已采购待收批次；提交采购建议不代表已经下单。</p><div v-for="batch in row.pending_batches" :key="batch.id" class="source-line"><b>{{batch.order_no||`批次 #${batch.id}`}}</b><span>待收 {{units(batch.quantity)}}</span><span>{{age(batch.purchased_at)==null?'采购时间待核':`已采购 ${age(batch.purchased_at)} 天`}}</span><small>{{format(batch.purchased_at)}}</small></div></div><div v-if="row.feedbacks?.length" class="supply-feedback-history"><strong>最近库存反馈</strong><div v-for="(item,index) in row.feedbacks" :key="index" class="source-line"><b>{{item.title}}</b><small>{{format(item.created_at)}}</small><span>{{item.content}}</span></div></div></div></template></el-table-column>
   <el-table-column label="库存商品" min-width="270"><template #default="{row}"><div class="supply-product"><ProductImagePreview :src="`/api/products/${row.product_id}/image?thumb=1`" :preview-list="[`/api/products/${row.product_id}/image`]" size="portrait"/><div><strong>{{row.product_name}}</strong><span>库存 ID：{{row.inventory_number||row.product_id}}</span><el-button link type="primary" @click="openLedger(row)">查看库存流转</el-button></div></div></template></el-table-column>
   <el-table-column label="实物与货源" min-width="160"><template #default="{row}"><div class="supply-quantities"><span>本地实物 <b>{{units(row.workflow?.physical)}}</b></span><span>采购在途 <b>{{units(row.workflow?.incoming)}}</b></span><span>FBP已锁定 {{units(row.workflow?.locked)}}</span></div></template></el-table-column>
   <el-table-column label="三类需求 · 共用货源去重" min-width="290"><template #default="{row}"><div class="supply-demand-lines"><span :class="{'is-required':plan(row).required_fbs>0}"><b>FBS订单</b><strong>{{plan(row).required_fbs>0?`必须采购 ${units(plan(row).required_fbs)}`:plan(row).required_fbs==null?'待核对':'货源已覆盖'}}</strong></span><span :class="{'is-advisory':plan(row).optional_local>0}"><b>本地保障</b><strong>{{plan(row).optional_local==null?'待核对':plan(row).optional_local>0?`建议采购 ${units(plan(row).optional_local)}`:'保障已覆盖'}}</strong></span><span :class="plan(row).required_fbp>0?'is-required':plan(row).optional_fbp>0?'is-advisory':''"><b>FBP备货</b><strong>{{plan(row).required_fbp>0?`正式申请缺 ${units(plan(row).required_fbp)}`:plan(row).optional_fbp==null?'预测待核对':plan(row).optional_fbp>0?`预测建议 ${units(plan(row).optional_fbp)}`:'当前无需补货'}}</strong></span><small v-if="sources(row).length">来源：{{[...new Set(sources(row).map(s=>s.label))].slice(0,2).join('、')}}</small><el-button link type="primary" class="supply-source-button" @click="supplyTable.toggleRowExpansion(row)">查看来源与批次</el-button><small v-if="plan(row).fbp_waiting_incoming>0">正式FBP需求有 {{units(plan(row).fbp_waiting_incoming)}} 等待到货</small></div></template></el-table-column>
   <el-table-column label="采购／到货进度" min-width="170"><template #default="{row}"><el-tag v-if="!plan(row).known" type="info">先核实库存</el-tag><el-tag v-else-if="plan(row).required_purchase>0" type="danger">未覆盖 {{units(plan(row).required_purchase)}}</el-tag><el-tag v-else-if="row.pending_batches?.length" type="primary">已采购，等待验收</el-tag><el-tag v-else-if="plan(row).optional_purchase>0" type="warning">保障采购可暂缓</el-tag><el-tag v-else-if="!plan(row).fbp_forecast_known" type="info">FBP预测待核对</el-tag><el-tag v-else type="success">当前货源已覆盖</el-tag><p v-if="row.pending_batches?.length" class="supply-age">最早一批：{{age(row.pending_batches[0].purchased_at)==null?'时间待核':`已采购 ${age(row.pending_batches[0].purchased_at)} 天`}}<small>到货后登记合格实收数量</small></p></template></el-table-column>
   <el-table-column label="处理" min-width="155" fixed="right"><template #default="{row}"><div class="supply-row-actions"><el-button v-if="canReceive&&row.pending_batches?.length" type="primary" plain @click="openLedger(row,'receive')">验货入库</el-button><el-button v-if="canPurchase" type="primary" :loading="checkingProduct===Number(row.product_id)" :disabled="!!checkingProduct||!plan(row).known||!(plan(row).required_purchase>0||plan(row).optional_purchase>0)" @click="openPurchase(row)">登记采购</el-button><el-button v-if="canCount" link type="primary" @click="openLedger(row,'stocktake')">核对实物</el-button><el-button v-if="canReport" link type="warning" @click="openFeedback(row)">反馈缺口</el-button></div></template></el-table-column>
  </el-table>
  <el-pagination v-if="snapshot.available!==false" v-model:current-page="filters.page" :page-size="filters.pageSize" :total="total" layout="total, prev, pager, next" @current-change="load()"/>
  <ProcurementLedgerDialog v-if="ledger.visible" v-model="ledger.visible" :product-id="ledger.productId" :initial-action="ledger.action" :stocktake-enabled="canCount" @saved="load(false,true)"/>
  <ProcurementRequestCreateDialog v-if="purchase.visible" v-model="purchase.visible" :initial-product-id="purchase.row.product_id" :initial-quantity="Math.max(1,plan(purchase.row).required_purchase||plan(purchase.row).optional_purchase||1)" :source-request-ids="purchaseRequestIds(purchase.row)" lock-product @created="load(false,true)"/>
  <el-dialog v-if="feedback.visible" v-model="feedback.visible" title="反馈库存缺口" width="min(580px,94vw)" append-to-body :close-on-click-modal="false" :close-on-press-escape="!feedback.busy" :show-close="!feedback.busy"><p>{{feedback.row.product_name}}</p><p>系统重新核对货源，通知本企业采购及相关备货申请人。反馈本身不修改库存、不重复增加采购数量。</p><el-input v-model="feedback.note" type="textarea" :rows="3" maxlength="500" show-word-limit placeholder="例如：核实只有12件，尚有5件订单缺口；已联系供应商补货"/><template #footer><el-button :disabled="feedback.busy" @click="feedback.visible=false">取消</el-button><el-button type="primary" :loading="feedback.busy" @click="sendFeedback">反馈并通知相关人员</el-button></template></el-dialog>
 </section>
</template>
<style scoped>
.supply-workspace{display:grid;gap:18px;min-width:0;color:var(--el-text-color-primary)}.supply-heading{display:flex;justify-content:space-between;align-items:center;gap:16px}.supply-policy-hint{font-size:12px;color:var(--el-text-color-secondary);margin:0}.supply-heading-actions{display:flex;gap:8px;flex-wrap:wrap}.supply-heading h2{margin:0;font-size:20px}.supply-heading p{margin:7px 0 0;font-size:13px;color:var(--el-text-color-secondary)}.supply-task-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.supply-task{display:flex;gap:15px;align-items:center;text-align:left;border:1px solid var(--el-border-color-lighter);border-radius:12px;background:var(--el-bg-color-overlay);color:var(--el-text-color-primary);padding:17px;cursor:pointer;font:inherit}.supply-task>svg{width:29px;height:29px;color:var(--el-color-primary)}.supply-task>div{display:grid;grid-template-columns:1fr auto;gap:6px;width:100%}.supply-task strong{font-size:24px}.supply-task small{grid-column:1/-1;color:var(--el-text-color-secondary);font-size:11px}.supply-task.is-required>svg{color:var(--el-color-danger)}.supply-task.is-advisory>svg{color:var(--el-color-warning)}.supply-task.is-active{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.supply-filters{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.supply-filters>.el-input{width:260px}.supply-filters>.el-select{width:240px}.supply-filters>span{font-size:12px;color:var(--el-text-color-secondary);margin-left:auto}.supply-product{display:flex;align-items:center;gap:12px;min-height:92px}.supply-product>div{display:grid;gap:7px;line-height:1.5}.supply-product span{font-size:12px;color:var(--el-text-color-secondary)}.supply-product strong{font-size:13px}.supply-product .el-button{justify-self:start;margin:0}.supply-quantities{display:grid;gap:9px;font-size:12px}.supply-quantities b{display:block;margin-top:3px;font-size:14px}.supply-demand-lines{display:grid;gap:10px;font-size:12px}.supply-demand-lines>span{display:flex;justify-content:space-between;gap:15px}.supply-demand-lines strong{font-weight:500}.supply-demand-lines .is-required strong{color:var(--el-color-danger)}.supply-demand-lines .is-advisory strong{color:var(--el-color-warning)}.supply-source-button{justify-self:start;margin:0;padding:0;font-size:12px}.supply-demand-lines small{color:var(--el-text-color-secondary)}.supply-age{font-size:12px;margin:10px 0 0}.supply-age small{display:block;color:var(--el-text-color-secondary);margin-top:5px}.supply-row-actions{display:flex;flex-wrap:wrap;gap:8px}.supply-row-actions .el-button{margin:0}.supply-evidence{padding:18px 28px;display:grid;grid-template-columns:1fr 1fr;gap:24px;font-size:12px;background:var(--el-fill-color-extra-light)}.supply-evidence p{color:var(--el-text-color-secondary)}.source-line{display:flex;flex-wrap:wrap;gap:10px;padding:10px 0;border-bottom:1px solid var(--el-border-color-lighter)}.supply-feedback-history{grid-column:1/-1}.source-line small{color:var(--el-text-color-secondary)}.supply-workspace>.el-pagination{justify-content:flex-end}@media(max-width:900px){.supply-task-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.supply-evidence{grid-template-columns:1fr}.supply-filters>span{margin-left:0}}@media(max-width:500px){.supply-heading{align-items:flex-start}.supply-task{padding:12px;gap:8px}.supply-task small{line-height:1.5}.supply-filters>.el-input,.supply-filters>.el-select{width:100%}}
</style>
