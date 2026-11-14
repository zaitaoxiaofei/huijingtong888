<script setup>
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {inventoryAdjustmentReasons,validateInventoryAdjustment} from '../../../../src/inventory-adjustment-reasons.js';
import ProductImagePreview from '../ProductImagePreview.vue';
const props=defineProps({productId:Number,editable:Boolean,embedded:Boolean,externalActions:Boolean}),emit=defineEmits(['saved','cancel','busy','state']);
const data=ref(null),loading=ref(false),busy=ref(false),error=ref(''),items=ref([]),reason=ref(''),note=ref(''),submission=ref(null);
let version=0,disposed=false;
const canSave=computed(()=>data.value&&!data.value.incomplete&&!loading.value&&!busy.value&&items.value.length&&items.value.every(row=>Number.isSafeInteger(row.counted_quantity)&&row.counted_quantity>=0)&&!!reason.value);
const physicalSets=computed(()=>data.value?.components?.length&&data.value.components.every(row=>Number.isFinite(row.physical_stock)&&row.physical_stock>=0)?Math.min(...data.value.components.map(row=>Math.floor(row.physical_stock/row.per_set_quantity))):null);
async function load(preserve=false){
 const token=++version,scope=currentApiCacheScope(),old=items.value;loading.value=true;busy.value=false;data.value=null;error.value='';submission.value=null;
 try{const result=await apiClient.get(`/api/inventory/bundle-stocktake?product_id=${props.productId}`,{noCache:true});if(disposed||token!==version||scope!==currentApiCacheScope())return;data.value=result;items.value=result.components.map(row=>({...row,counted_quantity:preserve?old.find(item=>item.product_id===row.product_id)?.counted_quantity??null:null}));}
 catch(e){if(token===version&&scope===currentApiCacheScope())error.value=e.message||'套装明细读取失败';}finally{if(token===version)loading.value=false;}
}
async function save(){
 if(busy.value||!props.editable||!data.value||(!submission.value&&!canSave.value))return;
 if(!submission.value){
  try{for(const row of items.value)validateInventoryAdjustment(reason.value,note.value,row.counted_quantity-row.physical_stock);}
  catch(e){error.value=e.message;return;}
  submission.value={product_id:props.productId,revision:data.value.revision,request_key:crypto.randomUUID(),reason_code:reason.value,reason_note:note.value,items:items.value.map(row=>({product_id:row.product_id,revision:row.revision,counted_quantity:row.counted_quantity}))};
 }
 const token=version,scope=currentApiCacheScope();busy.value=true;error.value='';
 try{const result=await apiClient.post('/api/inventory/bundle-stocktake',submission.value);if(disposed||token!==version||scope!==currentApiCacheScope())return;ElMessage.success('套装所有子库存已更新');emit('saved',result);}
 catch(e){if(token!==version||scope!==currentApiCacheScope())return;error.value=e.message||'更新失败，请重试';if([400,403,404,409].includes(e.status)){submission.value=null;if(e.status===409){await load(true);error.value='库存或套装组成已变化，整批未保存。已刷新明细并保留填写的数量，请核对后重试。';}}}
 finally{if(token===version)busy.value=false;}
}
function clear(){++version;data.value=null;items.value=[];submission.value=null;busy.value=false;emit('cancel');}
watch(()=>props.productId,()=>{reason.value='';note.value='';items.value=[];load();},{immediate:true});
watch(busy,value=>emit('busy',value),{flush:'sync'});
watch([canSave,busy,submission],()=>emit('state',{canSave:!!canSave.value,busy:busy.value,retrying:!!submission.value}),{immediate:true,flush:'sync'});
defineExpose({save});
window.addEventListener('erp:auth-scope-changed',clear);onBeforeUnmount(()=>{disposed=true;++version;window.removeEventListener('erp:auth-scope-changed',clear);});
</script>
<template>
 <section class="bundle-details" v-loading="loading" aria-label="套装子库存明细">
  <el-alert v-if="error" :title="error" type="warning" :closable="false"/><el-button v-if="error&&!data" @click="load()">重新读取套装</el-button>
  <template v-if="data">
   <header v-if="!embedded" class="bundle-product"><ProductImagePreview :src="data.product.image_url" :preview-list="[`/api/products/${data.product.id}/image`]" size="portrait"/><div><strong>{{data.product.name}}</strong><p>套装库存 ID：{{data.product.inventory_number||data.product.id}}</p><small>按当前实物可组成 {{physicalSets==null?'待核实':physicalSets}} 套</small></div></header>
   <el-alert v-if="data.incomplete" title="存在已停用子库存，请先核对套装组成；当前不能更新库存。" type="warning" :closable="false"/>
   <p v-if="editable" class="bundle-shared-note">逐项填写每个子产品在本地仓库的实际总库存，无货填 0。子产品可能被多个套装共用，更新会同时影响相关套装；父套装不单独记库存。</p>
   <details v-if="data.structure?.some(row=>row.is_bundle)" open><summary>全部层级及子库存 ID</summary><p v-for="(row,index) in data.structure" :key="index">{{row.name}} · 库存 ID {{row.inventory_number||row.id}} · 每个上级用 {{row.quantity}} {{row.stock_unit}}<span v-if="row.is_bundle">（子套装，已继续展开）</span></p></details>
   <h4>实际子库存 · {{items.length}} 项</h4>
   <article v-for="row in items" :key="row.product_id" class="bundle-child">
    <ProductImagePreview :src="row.image_url" :preview-list="[`/api/products/${row.product_id}/image`]" size="portrait"/>
    <div class="bundle-child-copy"><strong>{{row.name}}</strong><b>库存 ID：{{row.inventory_number||row.product_id}}</b><small>每套使用 {{row.per_set_quantity}} {{row.stock_unit}}<span v-if="!row.active"> · 已停用</span></small><small>本地实物 {{row.physical_stock??'待核实'}} {{row.stock_unit}} · 待发需求 {{row.open_order_demand??'待核实'}} · FBP 锁定 {{row.fbp_reserved??'待核实'}}</small>
     <template v-if="editable"><label>实际总库存<el-input-number v-model="row.counted_quantity" :min="0" :precision="0" controls-position="right" :aria-label="`子库存 ${row.inventory_number||row.product_id} 实际总库存`" :disabled="busy||!!submission||!row.active"/></label><small v-if="row.counted_quantity!=null">本地实物 {{row.physical_stock??'待核实'}} → {{row.counted_quantity}} {{row.stock_unit}}</small></template>
    </div>
   </article>
   <template v-if="editable"><label>统一调整原因<select v-model="reason" aria-label="套装调整原因" :disabled="busy||!!submission"><option value="">请选择</option><option v-for="item in inventoryAdjustmentReasons" :key="item.code" :value="item.code">{{item.label}}</option></select></label><label>补充说明<textarea v-model="note" aria-label="套装调整说明" maxlength="500" :disabled="busy||!!submission"/></label><p v-if="submission&&!busy">上次提交结果尚未确认，请使用同一记录重试，避免重复更新。</p><div v-if="!externalActions" class="bundle-actions"><el-button :disabled="busy" @click="emit('cancel')">取消</el-button><el-button type="primary" :loading="busy" :disabled="!submission&&!canSave" @click="save">{{submission?'重试确认':'一次确认更新所有子库存'}}</el-button></div></template>
  </template>
 </section>
</template>
<style scoped>
.bundle-details{display:grid;gap:12px;min-width:0}.bundle-product,.bundle-child{display:flex;gap:12px;align-items:flex-start;min-width:0}.bundle-product p{margin:6px 0}.bundle-product>div,.bundle-child-copy{min-width:0;overflow-wrap:anywhere}.bundle-child{padding:12px 0;border-bottom:1px solid var(--el-border-color-lighter)}.bundle-child-copy{display:grid;gap:7px;flex:1}.bundle-details small,.bundle-shared-note{font-size:12px;line-height:1.7;color:var(--el-text-color-secondary)}.bundle-details h4{margin:0}.bundle-details label{display:grid;gap:7px;font-size:13px}.bundle-child label{grid-template-columns:auto minmax(130px,180px);align-items:center}.bundle-details select,.bundle-details textarea{box-sizing:border-box;min-width:0;width:100%;padding:10px;background:var(--el-bg-color);color:var(--el-text-color-primary);border:1px solid var(--el-border-color);border-radius:7px}.bundle-details textarea{min-height:70px}.bundle-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}.bundle-child :deep(.el-input-number){width:100%}.bundle-details :deep(.erp-image-preview){flex-shrink:0}.bundle-details details{font-size:12px;line-height:1.7}
</style>
