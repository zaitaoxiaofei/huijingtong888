<script setup>
import {computed,onBeforeUnmount,reactive,ref,watch} from 'vue';
import {ElMessage,ElMessageBox} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {allocateBundlePurchaseTotal} from '../../../../src/shared/purchase-bundle-total.js';
import ProductImagePreview from '../ProductImagePreview.vue';
const props=defineProps({modelValue:Boolean,inboundId:Number}),emit=defineEmits(['update:modelValue','saved']);
const visible=computed({get:()=>props.modelValue,set:v=>emit('update:modelValue',v)});
const context=ref(null),loading=ref(false),busy=ref(false),error=ref(''),items=ref([]),submitted=ref(null),requestKey=ref('');
const form=reactive({mode:'whole',set_quantity:1,total_amount:0,note:'',arrived:false});
const selected=computed(()=>form.mode==='whole'?items.value:items.value.filter(i=>i.selected));
const originalAmount=computed(()=>Number(context.value?.batch.amount||0)+Number(context.value?.batch.shipping_amount||0));
const changedAmount=computed(()=>Math.abs(Number(form.total_amount)-originalAmount.value)>=0.0001);
function totalInput(){return {mode:form.mode,set_quantity:Number(form.set_quantity),total_amount:Number(form.total_amount),items:selected.value.map(i=>({product_id:Number(i.product_id),quantity:Number(i.quantity)}))};}
const allocation=computed(()=>{if(!context.value)return[];try{return allocateBundlePurchaseTotal(context.value,totalInput()).map(row=>({...row,name:items.value.find(i=>Number(i.product_id)===row.product_id)?.name}));}catch{return[];}});
let version=0,disposed=false;
async function load(){const token=++version,scope=currentApiCacheScope();loading.value=true;error.value='';try{
 const result=await apiClient.get(`/api/inventory-workflow/purchase-bundle?id=${props.inboundId}`,{noCache:true});
 if(disposed||token!==version||scope!==currentApiCacheScope())return;
 context.value=result;items.value=result.components.map(c=>({...c,selected:false}));
 Object.assign(form,{mode:'whole',set_quantity:Number(result.batch.quantity),total_amount:Number(result.batch.amount||0)+Number(result.batch.shipping_amount||0),note:'',arrived:!!result.batch.received_at});submitted.value=null;requestKey.value=crypto.randomUUID();
}catch(e){if(token===version)error.value=e.message;}finally{if(token===version)loading.value=false;}}
async function save(){
 if(busy.value||!context.value)return;
 if(!submitted.value){
  const input=totalInput();try{allocateBundlePurchaseTotal(context.value,input);}catch(e){return ElMessage.warning(e.message);}
  const summary=form.mode==='whole'?`完整套装 ${input.set_quantity} 套`:`${selected.value.length} 项配件，共 ${selected.value.reduce((n,i)=>n+Number(i.quantity),0)} 件`;
  const correction=changedAmount.value?`原记录总费用 ¥${originalAmount.value.toFixed(4)}，本次改为 ¥${input.total_amount.toFixed(4)}；请确认实际凭证，退款另走采购对账。`:`总费用 ¥${input.total_amount.toFixed(4)}。`;
  try{await ElMessageBox.confirm(`确认实际购买了${summary}？${correction}费用由系统自动分摊，保存后仍按实收数量验收入库。`,'确认采购内容',{type:'warning',confirmButtonText:'确认保存'});}catch{return;}
  submitted.value={id:props.inboundId,revision:context.value.revision,request_key:requestKey.value,allocation_mode:'total',...input,note:form.note.trim()||`确认实际采购：${summary}，总费用 ${input.total_amount} 元`,arrived:form.arrived,allocation_confirmed:true,confirm_amount_change:changedAmount.value};
 }
 const scope=currentApiCacheScope();busy.value=true;error.value='';
 try{const result=await apiClient.post('/api/inventory-workflow/purchase-bundle',submitted.value);if(disposed||scope!==currentApiCacheScope())return;ElMessage.success('采购内容已保存，可按实际收到的数量入库');emit('saved',result);visible.value=false;}catch(e){if(scope===currentApiCacheScope())error.value=e.message;}finally{if(scope===currentApiCacheScope())busy.value=false;}
}
watch(()=>props.inboundId,load,{immediate:true});onBeforeUnmount(()=>{disposed=true;++version;});
</script>
<template>
 <el-dialog v-model="visible" title="确认历史采购内容" width="min(920px,96vw)" append-to-body :close-on-click-modal="false" :close-on-press-escape="false" :show-close="!busy">
  <section v-loading="loading" class="bundle-review">
   <el-alert v-if="error" :title="error" type="error" :closable="false"/>
   <template v-if="context">
    <p>原批次 #{{inboundId}} · {{context.product.name}} · 原登记 {{context.batch.quantity}} 套 · 总费用 ¥{{originalAmount.toFixed(4)}}</p>
    <el-radio-group v-model="form.mode" :disabled="busy||!!submitted"><el-radio-button value="whole">买了完整套装</el-radio-button><el-radio-button value="parts">只买了部分配件</el-radio-button></el-radio-group>
    <el-form inline :disabled="busy||!!submitted">
     <el-form-item v-if="form.mode==='whole'" label="购买套数" required><el-input-number v-model="form.set_quantity" :min="1" :max="1000000" :precision="0" aria-label="购买套数"/></el-form-item>
     <el-form-item label="总费用（含运费）" required><el-input-number v-model="form.total_amount" :min="0" :precision="4" aria-label="采购总费用"/></el-form-item>
    </el-form>
    <p>填写实际购买的数量和总费用即可，系统自动分摊到子库存。保存采购内容后，再登记实际收到的数量。</p>
    <el-table :data="items" border>
     <el-table-column v-if="form.mode==='parts'" label="购买" width="65"><template #default="{row}"><el-checkbox v-model="row.selected" :disabled="busy||!!submitted" :aria-label="'购买'+row.name"/></template></el-table-column>
     <el-table-column label="实物库存" min-width="320"><template #default="{row}"><div class="bundle-review-product"><ProductImagePreview :src="`/api/products/${row.product_id}/image?thumb=1`" :preview-list="[`/api/products/${row.product_id}/image`]" size="portrait"/><div><b>{{row.name}}</b><small>库存 {{row.inventory_number||row.product_id}} · 每套 {{row.per_set_quantity}} {{row.stock_unit||'件'}}</small></div></div></template></el-table-column>
     <el-table-column label="购买数量" width="180"><template #default="{row}"><el-input-number v-if="form.mode==='parts'" :key="`qty-${row.product_id}-${row.selected}`" v-model="row.quantity" :min="1" :max="1000000" :precision="0" :disabled="!row.selected||busy||!!submitted" :aria-label="row.name+'购买数量'" style="width:145px"/><b v-else>{{Number(form.set_quantity||0)*row.per_set_quantity}} {{row.stock_unit||'件'}}</b></template></el-table-column>
    </el-table>
    <el-collapse><el-collapse-item title="查看系统费用分摊（自动计算）" name="allocation"><el-table :data="allocation" border><el-table-column prop="name" label="库存"/><el-table-column label="分摊货款（元）"><template #default="{row}">{{row.amount.toFixed(4)}}</template></el-table-column><el-table-column label="分摊运费（元）"><template #default="{row}">{{row.shipping_amount.toFixed(4)}}</template></el-table-column></el-table><small>有配件采购成本时按成本比例分摊，缺少成本时按实物数量分摊；尾差由系统处理，总费用保持一致。</small></el-collapse-item></el-collapse>
    <el-checkbox v-model="form.arrived" :disabled="busy||!!submitted">本批货已到货，保存后等待仓库验收</el-checkbox>
    <el-input v-model="form.note" maxlength="500" placeholder="备注（选填）" :disabled="busy||!!submitted"/>
    <el-alert v-if="submitted" title="内容已提交并锁定；响应中断时可重试，避免重复登记。" type="warning" :closable="false"/>
   </template>
  </section>
  <template #footer><el-button :disabled="busy" @click="visible=false">返回</el-button><el-button type="primary" :loading="busy" :disabled="loading||!context" @click="save">{{submitted?'重试本次保存':'确认保存'}}</el-button></template>
 </el-dialog>
</template>
<style scoped>
.bundle-review{display:grid;gap:14px}.bundle-review p{margin:0;font-size:13px;line-height:1.6}.bundle-review-product{display:flex;gap:10px;align-items:center;min-height:88px}.bundle-review-product>div{display:grid;gap:6px}.bundle-review-product small,.bundle-review>p,.bundle-review :deep(.el-collapse-item__content>small){color:var(--el-text-color-secondary)}.bundle-review .el-form-item{margin-bottom:0}
</style>
