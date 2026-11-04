<script setup>
import MobileDialog from './MobileDialog.vue';
import ProductImagePreview from '../ProductImagePreview.vue';
import {computed,onBeforeUnmount,reactive,ref,watch} from 'vue';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import {inventoryWorkflow} from '../../../../src/shared/inventory-workflow.js';
import {inventoryAdjustmentReasons,validateInventoryAdjustment} from '../../../../src/inventory-adjustment-reasons.js';
const props=defineProps({modelValue:Boolean,readOnly:Boolean,contextNote:String,product:{type:Object,default:()=>({})}}),emit=defineEmits(['update:modelValue','saved']);
const auth=useAuthStore();
const lastStocktake=computed(()=>[...(data.value?.actions||[])].sort((a,b)=>Number(b.id)-Number(a.id))[0]);
const visible=computed({get:()=>props.modelValue,set:v=>emit('update:modelValue',v)}),data=ref(null),submission=ref(null),error=ref(''),busy=ref(false),loading=ref(false),form=reactive({counted_quantity:null,reason_code:'',reason_note:''});let generation=0,disposed=false;
const availableBefore=computed(()=>data.value?inventoryWorkflow(data.value,{applications:[]}).free:null);
const validQuantity=computed(()=>form.counted_quantity!==null&&form.counted_quantity!==''&&Number.isSafeInteger(Number(form.counted_quantity))&&Number(form.counted_quantity)>=0);
const impact=computed(()=>data.value&&validQuantity.value?{physical_before:data.value.physical_estimate,physical_after:Number(form.counted_quantity),stocktake_delta:data.value.physical_estimate==null?null:Number(form.counted_quantity)-Number(data.value.physical_estimate),available_after:inventoryWorkflow({...data.value,physical_estimate:Number(form.counted_quantity)},{applications:[]}).free}:null);
const reasonError=computed(()=>{if(!impact.value||!form.reason_code)return '';try{validateInventoryAdjustment(form.reason_code,form.reason_note,impact.value.stocktake_delta);return '';}catch(e){return e.message;}});
const canSave=computed(()=>!!data.value&&validQuantity.value&&!!form.reason_code&&!reasonError.value&&!loading.value);
async function load(){const token=++generation,scope=currentApiCacheScope();loading.value=true;busy.value=false;data.value=null;submission.value=null;error.value='';Object.assign(form,{counted_quantity:null,reason_code:'',reason_note:''});try{const result=await apiClient.get(`/api/inventory/ledger?product_id=${props.product.id}&include_flow=local`,{noCache:true});if(!disposed&&token===generation&&scope===currentApiCacheScope())data.value=result;}catch(e){if(token===generation&&scope===currentApiCacheScope())error.value=e.message;}finally{if(token===generation)loading.value=false;}}
async function save(){
 if(busy.value||props.readOnly||!data.value)return;
 if(!submission.value){
  if(!validQuantity.value)return ElMessage.warning('请填写实际清点数量，无货请填0');
  if(!form.reason_code)return ElMessage.warning('请选择调整原因');
  if(reasonError.value)return ElMessage.warning(reasonError.value);
  submission.value={...form,counted_quantity:Number(form.counted_quantity),product_id:props.product.id,action_type:'stocktake',stocktake_type:'physical',revision:data.value.revision,request_key:crypto.randomUUID()};
 }
 const token=generation,scope=currentApiCacheScope();busy.value=true;error.value='';
 try{
  const result=await apiClient.post('/api/inventory/ledger',submission.value);
  if(disposed||token!==generation||scope!==currentApiCacheScope())return;
  ElMessage.success('本地实物已更新');emit('saved',result);visible.value=false;
 }catch(e){
  if(disposed||token!==generation||scope!==currentApiCacheScope())return;
  error.value=e.message;
  if([400,403,404,409].includes(e.status))submission.value=null;
  if(e.status===409){
   try{const latest=await apiClient.get(`/api/inventory/ledger?product_id=${props.product.id}&include_flow=local`,{noCache:true});if(disposed||token!==generation||scope!==currentApiCacheScope())return;data.value=latest;error.value='库存已变化，已更新下方影响；填写内容已保留，请核对后再确认。';}
   catch{if(token===generation&&scope===currentApiCacheScope()){data.value=null;error.value='库存已变化，暂时无法读取最新实物数；请重新打开核对后再提交。';}}
  }
 }finally{if(token===generation)busy.value=false;}
}
function clear(){++generation;data.value=null;submission.value=null;visible.value=false;}
watch(()=>[props.modelValue,props.product.id],()=>{if(props.modelValue)load();else ++generation;},{immediate:true});window.addEventListener('erp:auth-scope-changed',clear);onBeforeUnmount(()=>{disposed=true;clear();window.removeEventListener('erp:auth-scope-changed',clear);});
</script>
<template>
 <MobileDialog v-model="visible" class="mobile-stocktake-dialog" :mode="readOnly?'sheet':'compact'" :title="readOnly?'库存明细':'更新本地库存'" :close-on-press-escape="!busy" :show-close="!busy">
  <div class="mobile-form" v-loading="loading">
   <div class="mobile-record-head"><ProductImagePreview :src="`/api/products/${product.id}/image?thumb=1`" :preview-list="[`/api/products/${product.id}/image`]" size="portrait"/><div><h3>{{product.name}}</h3><small class="mobile-muted">库存 {{product.inventory_number||product.code||product.id}}</small><el-tag size="small">{{Number(product.component_count)>0?'套装':Number(product.is_accessory)?'配件':'单品'}}</el-tag></div></div>
   <el-alert v-if="error" :title="error" type="warning" :closable="false"/>
   <template v-if="data">
    <small v-if="contextNote&&!readOnly" class="mobile-muted">{{contextNote}}</small>
    <template v-if="!readOnly">
     <label>仓库实物总数（包含待发货品）<input v-model.number="form.counted_quantity" type="number" inputmode="numeric" min="0" step="1" aria-label="实际清点数量" :disabled="busy||!!submission"></label>
     <label>调整原因<select v-model="form.reason_code" :disabled="busy||!!submission" aria-label="调整原因"><option value="">请选择</option><option v-for="reason in inventoryAdjustmentReasons" :key="reason.code" :value="reason.code">{{reason.label}}</option></select></label>
     <label>补充说明{{form.reason_code==='other'?'（必填）':'（选填）'}}<textarea v-model="form.reason_note" maxlength="500" :disabled="busy||!!submission"/></label>
     <small v-if="reasonError" class="mobile-stocktake-validation">{{reasonError}}</small>
    </template>
    <section class="mobile-stocktake-impact" aria-label="库存变动影响" aria-live="polite">
     <strong>{{readOnly?'当前库存':'本次调整影响'}}</strong>
     <div class="mobile-record-grid"><span>本地实物<b>{{data.physical_estimate??'待核实'}}<template v-if="!readOnly"> → {{impact?.physical_after??'—'}}</template></b></span><span>可用库存<b>{{availableBefore??'待核实'}}<template v-if="!readOnly"> → {{impact?impact.available_after??'待核实':'—'}}</template></b></span></div>
     <small v-if="!readOnly&&impact">实物差额 {{impact.stocktake_delta==null?'待核实':impact.stocktake_delta>0?'+'+impact.stocktake_delta:impact.stocktake_delta}} 件</small>
     <small v-else-if="!readOnly">填写实物总数后，这里会自动显示数量影响。</small>
    </section>
    <small class="mobile-muted">实物不包含采购在途和FBP；可用量扣除待发订单、安全保障和已锁定FBP。规则不完整时显示待核实。</small>
    <small v-if="!readOnly" class="mobile-muted">操作人：{{auth.user?.name||auth.user?.username}} · 自动记录时间、原因和数量变动</small>
    <small v-if="lastStocktake" class="mobile-muted">最近核对：{{lastStocktake.person_name||'未记录姓名'}} · {{shanghaiDateTimeText(lastStocktake.created_at,{assumeUtcWhenNaive:true})}} · {{lastStocktake.reason}}</small>
    <small v-if="submission&&!busy" class="mobile-muted">上次结果尚未确认，重试使用同一记录，不会重复更新。</small>
    <template v-if="readOnly"><small>FBS待发需求 {{data.open_order_demand??0}} 件 · FBP锁定 {{data.fbp_reserved??0}} 件 · 采购在途 {{data.incoming_quantity??0}} 件</small><article v-for="order in data.orders||[]" :key="order.order_item_id" class="mobile-record"><b>{{order.posting_number}}</b><small>需求 {{order.quantity}} 件 · 待采购 {{order.shortage_quantity}} 件</small></article></template>
   </template>
  </div>
  <template #footer><el-button :disabled="busy" @click="visible=false">{{readOnly?'返回':'取消'}}</el-button><el-button v-if="!readOnly" type="primary" :disabled="!canSave" :loading="busy" @click="save">{{submission&&!busy?'重试确认':'确认更新'}}</el-button></template>
 </MobileDialog>
</template>
<style scoped>
.mobile-stocktake-impact{display:grid;gap:9px;padding:12px;border:1px solid var(--el-border-color-light);border-radius:10px;background:var(--el-fill-color-extra-light);font-size:13px}.mobile-stocktake-validation{color:var(--el-color-danger);line-height:1.5}
</style>
