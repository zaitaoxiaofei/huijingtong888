<script setup>
import {onBeforeUnmount,reactive,ref,watch,computed} from 'vue';
import {useRouter} from 'vue-router';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import InventoryPageToolbar from './InventoryPageToolbar.vue';
import {inventorySearchDefaults} from '../../../../src/shared/inventory-search-fields.js';
import ProductImagePreview from '../ProductImagePreview.vue';
const props=defineProps({productId:{type:Number,default:0},initialAll:Boolean});
const emit=defineEmits(['saved','navigate']);
const filters=reactive(inventorySearchDefaults());
const router=useRouter();
const auth=useAuthStore(),rows=ref([]),total=ref(0),page=ref(1),all=ref(props.initialAll),loading=ref(false),error=ref('');
const form=reactive({row:null,action:'',at:null,quantity:0,note:'',busy:false});
const canConfirm=computed(()=>hasPermission(auth.user,'packing')||hasPermission(auth.user,'inventory.write'));
let version=0,actionVersion=0,controller;
const time=v=>v?shanghaiDateTimeText(v,{assumeUtcWhenNaive:true}):'未记录';
const inputTime=v=>shanghaiDateTimeText(v||new Date(),{assumeUtcWhenNaive:true}).replaceAll('/','-');
async function load(){
 controller?.abort();controller=new AbortController();const scope=currentApiCacheScope(),token=++version;loading.value=true;error.value='';
 try{const r=await apiClient.get(`/api/inventory-workflow/details?${new URLSearchParams({...filters,node:'fbp-receipts',product_id:props.productId,page:page.value,all:all.value?'1':'0'})}`,{noCache:true,signal:controller.signal});
  if(token===version&&scope===currentApiCacheScope()){rows.value=r.rows||[];total.value=r.total||0;}
 }catch(e){if(token===version&&e.name!=='AbortError')error.value=e.message||'入仓核对读取失败';}finally{if(token===version)loading.value=false;}
}
function openApplication(row){emit('navigate');void router.push({path:'/inventory/fbp-replenishment',query:{orderId:row.order_id}});}
function edit(row,action){++actionVersion;Object.assign(form,{row,action,quantity:row.remaining,at:inputTime(action==='fbp-expected-time'?row.expected_arrival_at:row.arrival_at),note:'',busy:false});}
async function save(){
 if(!form.row||form.busy)return;
 if(form.action==='fbp-receive'&&(!Number.isSafeInteger(Number(form.quantity))||form.quantity<1||form.quantity>form.row.remaining))return ElMessage.warning('实收数量须为大于0且不超过剩余量的整数');
 if(form.action!=='fbp-receive'&&!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(form.at||''))return ElMessage.warning('请选择到仓日期和时间');
 const row=form.row,scope=currentApiCacheScope(),actionToken=actionVersion;form.busy=true;
 try{await apiClient.post('/api/inventory-workflow/node-action',{action:form.action,product_id:Number(row.product_id),id:Number(row.id),note:form.note,
  expected_updated_at:row.updated_at,expected_listed_quantity:Number(row.listed_quantity),received_quantity:Number(form.quantity),expected_arrival_at:row.arrival_at||null,expected_expected_arrival_at:row.recorded_expected_arrival_at||null,at:form.at?new Date(form.at.replace(' ','T')+'+08:00').toISOString():null});
  if(actionToken!==actionVersion||scope!==currentApiCacheScope())return;ElMessage.success(form.action==='fbp-receive'?'本SKU入仓数量已确认；官方库存仍以同步为准':'到仓时间已记录，未增加任何库存');form.row=null;await load();emit('saved');
 }catch(e){if(actionToken===actionVersion&&scope===currentApiCacheScope())ElMessage.error(e.message||'保存失败');}finally{if(actionToken===actionVersion)form.busy=false;}
}
function reset(){++version;++actionVersion;controller?.abort();rows.value=[];total.value=0;page.value=1;form.row=null;void load();}
watch(()=>props.productId,reset,{immediate:true});
window.addEventListener('erp:auth-scope-changed',reset);
onBeforeUnmount(()=>{++version;++actionVersion;controller?.abort();window.removeEventListener('erp:auth-scope-changed',reset);});
defineExpose({refresh:load});
</script>
<template>
 <section class="fbp-receipt-review" aria-label="FBP逐项入仓核对">
  <InventoryPageToolbar v-if="!productId" :filters="filters" product-search :show-shop="false" :show-date-range="false" :loading="loading" @search="page=1;load()" @reset="Object.assign(filters,inventorySearchDefaults());page=1;load()"/>
  <div class="receipt-tools"><span>系统仅提示疑似入仓；须由仓库逐SKU核实，数量按SKU发仓记录计，不拆成子产品。确认沿用原发仓记录，不再扣本地库存，也不覆盖官方快照。</span><el-button @click="all=!all;page=1;load()">{{all?'只看待确认':'查看全部记录'}}</el-button><el-button :loading="loading" @click="load">刷新核对</el-button></div>
  <el-alert v-if="error" :title="error" type="error" :closable="false"/>
  <el-table v-loading="loading" :data="rows" max-height="650" empty-text="暂无待确认的FBP发仓明细" :row-class-name="({row})=>row.overdue&&!row.suspected?'receipt-overdue':''">
   <el-table-column label="库存商品" min-width="240"><template #default="{row}"><div class="receipt-product"><ProductImagePreview :src="row.image_url"/><div><strong>{{row.product_name}}</strong><small>库存 {{row.inventory_number}} · 记录 #{{row.id}}</small></div></div></template></el-table-column>
   <el-table-column label="备货单／店铺／SKU" min-width="205"><template #default="{row}"><div>{{row.order_no||'手工发仓'}}</div><el-button v-if="row.order_id" size="small" @click="openApplication(row)">打开备货单</el-button><small>{{row.shop_name}}</small><strong>{{row.ozon_sku}}</strong></template></el-table-column>
   <el-table-column label="发出／已确认／待确认" min-width="160"><template #default="{row}">{{row.quantity}} / {{row.listed_quantity}} / {{row.remaining}}</template></el-table-column>
   <el-table-column label="入仓核对" min-width="220"><template #default="{row}"><el-popover trigger="hover" width="370"><template #reference><el-tag :type="!row.remaining?'success':row.suspected?'warning':row.overdue?'danger':'info'">{{row.review_label}}</el-tag></template><p>对比基准 {{row.baseline_present??'缺失'}} → 当前实物 {{row.official_present??'未同步'}}</p><p>同期已记录FBP出库 {{row.recorded_consumption??'待核'}}；推测补入 {{row.inferred_arrival??'待核'}}。</p><p>{{time(row.baseline_at)}} 至 {{time(row.official_synced_at)}}（北京）</p><p>退货、调账、多批同SKU到仓均可能影响判断。此证据只供逐项核对，不自动确认。</p></el-popover><small v-if="row.overlapping_batches>1">同SKU有 {{row.overlapping_batches}} 批在途，库存增长不能直接归属本批</small><small v-if="row.sibling_received&&row.remaining">同备货单已有其他SKU确认入仓</small><small v-if="row.overdue">已超过预计到仓时间，请核查物流、仓库签收或上架情况</small></template></el-table-column>
   <el-table-column label="申请／发运（北京）" min-width="190"><template #default="{row}"><small>申请 {{time(row.application_at)}}</small><small>发运 {{time(row.shipped_at)}}</small></template></el-table-column>
   <el-table-column label="到仓时间（北京）" min-width="205"><template #default="{row}"><div>预计 {{time(row.expected_arrival_at)}}</div><div>实际 {{time(row.arrival_at)}}</div><el-button v-if="canConfirm" size="small" @click="edit(row,'fbp-expected-time')">修改预计</el-button><el-button v-if="canConfirm" size="small" @click="edit(row,'fbp-arrival-time')">登记到仓</el-button></template></el-table-column>
   <el-table-column label="逐项确认" width="155" fixed="right"><template #default="{row}"><el-button v-if="canConfirm&&row.remaining>0" type="primary" size="small" @click="edit(row,'fbp-receive')">确认本SKU入仓</el-button><span v-else>{{row.remaining?'等待仓库确认':'已确认'}}</span></template></el-table-column>
  </el-table>
  <el-pagination v-if="total>50" :current-page="page" :page-size="50" :total="total" layout="total,prev,pager,next" @current-change="value=>{page=value;load()}"/>
  <el-dialog v-if="form.row" :model-value="true" :title="form.action==='fbp-receive'?'确认本SKU实收入仓':'登记到仓时间'" width="min(560px,94vw)" append-to-body :close-on-click-modal="false" :show-close="!form.busy" :close-on-press-escape="!form.busy" @close="form.row=null">
   <p>{{form.row.shop_name}} · SKU {{form.row.ozon_sku}}</p>
   <el-alert v-if="form.action==='fbp-receive'" title="请核实此SKU实际入仓数量。系统疑似结果不能代替实收凭证，部分到仓可分次确认。" type="warning" :closable="false"/>
   <el-form label-position="top"><el-form-item v-if="form.action==='fbp-receive'" label="本次确认数量"><el-input-number v-model="form.quantity" :min="1" :max="form.row.remaining" :precision="0"/></el-form-item><el-form-item v-else :label="form.action==='fbp-expected-time'?'预计到仓时间（北京）':'实际到仓时间（北京）'"><el-date-picker v-model="form.at" type="datetime" format="YYYY-MM-DD HH:mm:ss" value-format="YYYY-MM-DD HH:mm:ss"/></el-form-item><el-form-item label="核对备注"><el-input v-model="form.note" type="textarea" :rows="3" maxlength="1000" show-word-limit/></el-form-item></el-form>
   <template #footer><el-button :disabled="form.busy" @click="form.row=null">取消</el-button><el-button type="primary" :loading="form.busy" @click="save">保存确认</el-button></template>
  </el-dialog>
 </section>
</template>
<style scoped>
.receipt-tools{display:flex;align-items:center;gap:12px;margin:12px 0}.receipt-tools>span{flex:1;font-size:12px;color:var(--el-text-color-secondary)}.receipt-product{display:flex;align-items:center;gap:12px;min-height:90px}.receipt-product>div{display:grid;gap:8px}.fbp-receipt-review small{display:block;color:var(--el-text-color-secondary);font-size:12px;margin:5px 0}.fbp-receipt-review :deep(.receipt-overdue){--el-table-tr-bg-color:var(--el-color-danger-light-9)}.fbp-receipt-review :deep(.el-button){margin:4px}.fbp-receipt-review>.el-pagination{justify-content:flex-end;margin:16px 0}
.receipt-product :deep(.erp-image-preview){width:64px;height:84px;flex:0 0 64px;border-radius:6px;overflow:hidden;background:var(--el-fill-color-light)}.receipt-product :deep(.erp-image-preview__image),.receipt-product :deep(.erp-image-preview__empty){width:100%;height:100%;display:flex;align-items:center;justify-content:center}
</style>
