<script setup>
import MobileDialog from './MobileDialog.vue';
import {computed,onBeforeUnmount,onMounted,reactive,ref,watch} from 'vue';
import {ElMessage,ElMessageBox} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
import {inventorySearchDefaults,appendInventorySearch} from '../../../../src/shared/inventory-search-fields.js';
import MobileInventorySearch from './MobileInventorySearch.vue';
import MobilePagination from './MobilePagination.vue';
import {withImageToken} from '../../api/tools/imageCropper.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import ProductImagePreview from '../ProductImagePreview.vue';
import MobilePurchaseDialog from './MobilePurchaseDialog.vue';
import InventoryReceiveDialog from '../procurement/InventoryReceiveDialog.vue';
const props=defineProps({warehouse:Boolean});const auth=useAuthStore(),rows=ref([]),total=ref(null),page=ref(1),pageSize=ref(20),tab=ref(props.warehouse?'arrived':'register'),filters=reactive({...inventorySearchDefaults(),query:'',inventoryType:'all'}),loading=ref(false),error=ref(''),snapshot=ref({}),busy=ref(false);
const purchase=reactive({visible:false,rows:[]}),receive=reactive({visible:false,id:0,batch:0,name:''}),edit=reactive({row:null,tracking:'',courier:''});let generation=0,disposed=false,controller=null;
const canPurchase=computed(()=>hasPermission(auth.user,'procurement')),canReceive=computed(()=>hasPermission(auth.user,'packing')||canPurchase.value);
const tabs=computed(()=>props.warehouse?[['arrived','核验收货']]:[['register','登记采购'],['required','必须采购'],['advisory','保障补货'],['open','采购待到货'],['arrived','到货待验收'],['history','采购记录']]);
const demand=computed(()=>['required','advisory'].includes(tab.value));
const time=value=>value?shanghaiDateTimeText(value,{assumeUtcWhenNaive:true}):'未记录';
const days=value=>{if(!value)return null;const n=(Date.now()-new Date(/[TZ]/.test(value)?value:value.replace(' ','T')+'Z').getTime())/86400000;return Number.isFinite(n)?Math.max(0,n):null;};
function photos(row){let values=row.receipt_images_json;try{if(typeof values==='string')values=JSON.parse(values);}catch{values=[];}return [...new Set([...(Array.isArray(values)?values:[]),...(String(row.purchase_note||'').match(/\/uploads\/team-attachments\/[^\s，]+/g)||[])])].filter(v=>String(v).startsWith('/uploads/team-attachments/')).slice(0,12).map(withImageToken);}
function number(value){return value==null?'待计算':`${Number(value)} 件`;}
function filtersUrl(){return appendInventorySearch(new URLSearchParams({page:String(page.value),pageSize:String(pageSize.value),query:filters.query.trim(),inventoryType:filters.inventoryType}),filters);}
async function load(reset=false,fresh=false){
 if(reset)page.value=1;controller?.abort();controller=new AbortController();const request=controller,token=++generation,scope=currentApiCacheScope();loading.value=true;error.value='';
 const timeout=window.setTimeout(()=>request.abort(),15000);
 try {
  const p=filtersUrl();let endpoint;
  if(tab.value==='register'){p.set('paged','1');p.set('view','inventory');p.set('includeStock','0');endpoint='/api/products?'+p;}
  else if(demand.value){p.set('view','workspace');p.set('compact','1');p.set('task',tab.value);p.set(fresh?'refresh':'snapshot_only','1');endpoint='/api/inventory-workflow/alerts?'+p;}
  else{p.set('status',tab.value==='arrived'?(props.warehouse?'arrived':'inspection'):tab.value==='history'?'all':'open');if(tab.value==='history')p.set('recent','1');endpoint='/api/inventory-workflow/purchase-arrivals?'+p;}
  const r=await apiClient.get(endpoint,{noCache:true,signal:request.signal});if(disposed||token!==generation||scope!==currentApiCacheScope())return;
  rows.value=tab.value==='register'?(r.rows||[]).map(row=>({...row,product_id:row.id,product_name:row.name})):(r.rows||[]);total.value=r.total??null;snapshot.value=r.snapshot||{};
  document.querySelector('.mobile-work-queue .mobile-list-scroll')?.scrollTo(0,0);
 }catch(e){if(token===generation&&scope===currentApiCacheScope())error.value=e.name==='AbortError'?'读取超时，请点击查询重试':e.message;}
 finally{window.clearTimeout(timeout);if(token===generation)loading.value=false;}
}
function changed(){return load();}
function resetFilters(){Object.assign(filters,inventorySearchDefaults(),{query:'',inventoryType:'all'});load(true);}
function changePage(value){page.value=value.page;pageSize.value=value.pageSize;load();}

function openPurchase(row){purchase.rows=row?[row]:[];purchase.visible=true;}
async function arrived(row){const scope=currentApiCacheScope();try{await ElMessageBox.confirm(`确认批次 #${row.id} 的货物已到仓？此操作不增加实物，验收后再入库。`,'确认到货',{confirmButtonText:'确认已到货',cancelButtonText:'取消'});if(scope!==currentApiCacheScope()||disposed)return;busy.value=true;await apiClient.post('/api/inventory-workflow/purchase-arrivals',{id:row.id,expected_updated_at:row.updated_at,note:'手机端确认到货，等待验收',request_key:crypto.randomUUID()});if(scope!==currentApiCacheScope()||disposed)return;ElMessage.success('已进入待验收');await load();}catch(e){if(!['cancel','close'].includes(e)&&scope===currentApiCacheScope())error.value=e.message;}finally{busy.value=false;}}
function openReceive(row){Object.assign(receive,{visible:true,id:Number(row.product_id),batch:Number(row.id),name:row.product_name});}
async function saveLogistics(){if(!edit.row||busy.value)return;const row=edit.row,scope=currentApiCacheScope();busy.value=true;try{await apiClient.post('/api/inventory-workflow/purchase-arrivals',{operation:'logistics',id:row.id,expected_updated_at:row.updated_at,expected_courier_company:row.courier_company,expected_tracking_number:row.tracking_number,courier_company:edit.courier,tracking_number:edit.tracking});if(disposed||scope!==currentApiCacheScope())return;edit.row=null;ElMessage.success('采购物流已保存');await load();}catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{busy.value=false;}}

function reset(){++generation;controller?.abort();rows.value=[];total.value=null;purchase.visible=false;receive.visible=false;edit.row=null;error.value='';}
watch(tab,()=>{rows.value=[];snapshot.value={};load(true);});onMounted(()=>{load();window.addEventListener('erp:auth-scope-changed',reset);});onBeforeUnmount(()=>{disposed=true;reset();window.removeEventListener('erp:auth-scope-changed',reset);});
</script>
<template><div class="mobile-work-queue mobile-list-page"><div class="mobile-list-controls"><nav v-if="!warehouse" class="mobile-queue-tabs" aria-label="库存任务"><button v-for="[key,label] in tabs" :key="key" :class="{active:tab===key}" @click="tab=key">{{label}}</button></nav><MobileInventorySearch :filters="filters" :loading="loading" @search="load(true)" @reset="resetFilters"><template #actions><el-button :disabled="loading" @click="load(false,demand)">刷新</el-button><el-button v-if="canPurchase&&!warehouse" @click="openPurchase()">登记采购</el-button></template></MobileInventorySearch><el-alert v-if="error" :title="error" type="warning" :closable="false"/><small v-if="loading" class="mobile-muted">正在读取…</small><small v-if="snapshot.refreshing" class="mobile-muted">采购建议正在准备，可先登记采购，稍后点击刷新查看。</small></div><div class="mobile-list-scroll">

 <article v-for="row in rows" :key="demand?row.product_id:row.id" class="mobile-record"><div class="mobile-record-head"><ProductImagePreview :src="`/api/products/${row.product_id}/image?thumb=1`" :preview-list="[`/api/products/${row.product_id}/image`]" size="portrait"/><div><h3>{{row.product_name||row.name}}</h3><small>{{row.inventory_number||row.product_id}}</small><small v-if="!demand">{{row.order_no||row.shop_name||'采购记录'}} · #{{row.id}} <template v-if="row.ozon_sku">SKU {{row.ozon_sku}}</template></small></div></div>
 <template v-if="tab==='register'"><el-button v-if="canPurchase" type="primary" @click="openPurchase(row)">登记本商品采购</el-button></template>
 <template v-else-if="demand"><div class="mobile-record-grid"><span>本地实物<b>{{number(row.workflow?.physical_recorded)}}</b></span><span>采购在途<b>{{number(row.workflow?.incoming)}}</b></span><span>必须采购<b :class="{required:Number(row.workflow?.supply_plan?.required_purchase)>0,covered:row.workflow?.supply_plan?.required_purchase===0}">{{number(row.workflow?.supply_plan?.required_purchase)}}</b></span><span>保障建议<b>{{number(row.workflow?.supply_plan?.optional_purchase)}}</b></span></div><el-button v-if="canPurchase" :disabled="loading||snapshot.refreshing" type="primary" @click="openPurchase(row)">登记实际采购</el-button></template>

 <template v-else><div class="mobile-record-grid"><span>{{tab==='history'?'批次数量':'待收数量'}}<b>{{number(row.physical_quantity)}}</b></span><span>采购时间<b>{{time(row.purchased_at)}}</b></span></div><small :class="{'mobile-overdue':tab==='open'&&days(row.purchased_at)>2}">{{tab==='open'?(days(row.purchased_at)==null?'采购时间未记录':`已采购 ${days(row.purchased_at).toFixed(1)} 天${days(row.purchased_at)>2?'，超过2天未到货':''}`):row.received_at?`到货 ${time(row.received_at)}`:'采购满3天，等待核验到货'}}</small><small v-if="row.tracking_number">快递 {{row.courier_company}} {{row.tracking_number}}</small><div v-if="tab==='history'"><small>状态：{{row.status==='approved'?'已入库':row.status==='pending_arrival'?'采购在途／待验收':row.status}}</small><small v-if="row.amount!=null">货款 ¥{{Number(row.amount).toFixed(2)}} · 运费 ¥{{Number(row.shipping_amount||0).toFixed(2)}}</small><div class="mobile-history-photos"><el-image v-for="(url,index) in photos(row)" :key="url" :src="url" :preview-src-list="photos(row)" :initial-index="index" preview-teleported fit="cover"/></div></div><p v-if="tab!=='history'&&row.review_required" class="mobile-muted">此批次原按套装采购，需采购人员先核对实际配件组成；不直接按套数入库。</p><div v-else-if="tab!=='history'" class="mobile-record-actions"><template v-if="tab==='open'&&canPurchase"><el-button :disabled="busy" @click="Object.assign(edit,{row,tracking:row.tracking_number||'',courier:row.courier_company||''})">填写物流</el-button><el-button :disabled="busy" @click="arrived(row)">确认到货</el-button></template><el-button v-if="canReceive" type="primary" @click="openReceive(row)">拍照验收入库</el-button></div></template></article>
 <p v-if="!loading&&!rows.length&&!error" class="mobile-muted">{{snapshot.refreshing?'需求正在计算，请稍候':'当前筛选暂无待处理记录'}}</p></div><MobilePagination :page="page" :page-size="pageSize" :total="total" :loading="loading" @change="changePage"/>

 <MobilePurchaseDialog v-if="purchase.visible" v-model="purchase.visible" :initial-rows="purchase.rows" @saved="changed"/><InventoryReceiveDialog v-if="receive.visible" v-model="receive.visible" :product-id="receive.id" :inbound-id="receive.batch" :product-name="receive.name" mobile @saved="changed"/>
 <MobileDialog :model-value="!!edit.row" class="mobile-dialog mobile-logistics-dialog" title="采购物流" mode="compact" append-to-body :show-close="!busy" :close-on-click-modal="false" @update:model-value="v=>{if(!v)edit.row=null}"><div class="mobile-form"><label>快递公司<input v-model="edit.courier" maxlength="128" :disabled="busy"></label><label>快递单号<input v-model="edit.tracking" placeholder="粘贴快递单号" maxlength="128" :disabled="busy"></label></div><template #footer><el-button :loading="busy" @click="saveLogistics">保存物流</el-button></template></MobileDialog>

</div></template>
<style scoped>.mobile-work-queue{display:grid;gap:12px;min-width:0}.mobile-queue-tabs{display:flex;overflow-x:auto;gap:7px;padding-bottom:5px}.mobile-queue-tabs button{flex:0 0 auto;min-height:42px;padding:8px 12px;border:1px solid var(--el-border-color);background:var(--el-bg-color);color:var(--el-text-color-regular);border-radius:10px}.mobile-queue-tabs button.active{color:var(--el-color-primary);border-color:var(--el-color-primary)}.mobile-history-photos{display:flex;gap:8px;flex-wrap:wrap}.mobile-history-photos .el-image{width:72px;height:84px}.covered{color:var(--el-color-success)}.mobile-overdue,.required{color:var(--el-color-danger)!important}</style>
