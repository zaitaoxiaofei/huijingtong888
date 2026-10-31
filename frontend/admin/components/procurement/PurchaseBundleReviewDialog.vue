<script setup>
import {computed,onBeforeUnmount,reactive,ref,watch} from 'vue';
import {ElMessage,ElMessageBox} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import ProductImagePreview from '../ProductImagePreview.vue';
const props=defineProps({modelValue:Boolean,inboundId:Number}),emit=defineEmits(['update:modelValue','saved']);
const visible=computed({get:()=>props.modelValue,set:v=>emit('update:modelValue',v)});
const context=ref(null),loading=ref(false),busy=ref(false),error=ref(''),items=ref([]),submitted=ref(null),requestKey=ref('');
const form=reactive({mode:'',note:'',arrived:false,allocation_confirmed:false,confirm_amount_change:false});
const selected=computed(()=>form.mode==='whole'?items.value:items.value.filter(i=>i.selected));
const originalAmount=computed(()=>Number(context.value?.batch.amount||0)+Number(context.value?.batch.shipping_amount||0));
const amount=computed(()=>selected.value.reduce((n,i)=>n+Number(i.amount||0)+Number(i.shipping_amount||0),0));
const changedAmount=computed(()=>Math.abs(amount.value-originalAmount.value)>=0.0001);
let version=0,disposed=false;
async function load(){const token=++version,scope=currentApiCacheScope();loading.value=true;error.value='';try{
 const result=await apiClient.get(`/api/inventory-workflow/purchase-bundle?id=${props.inboundId}`,{noCache:true});
 if(disposed||token!==version||scope!==currentApiCacheScope())return;
 context.value=result;items.value=result.components.map(c=>({...c,selected:false,amount:c.suggested_amount??0,shipping_amount:c.suggested_shipping_amount??0}));
 Object.assign(form,{mode:'',note:'',arrived:!!result.batch.received_at,allocation_confirmed:false,confirm_amount_change:false});submitted.value=null;requestKey.value=crypto.randomUUID();
}catch(e){if(token===version)error.value=e.message;}finally{if(token===version)loading.value=false;}}
async function save(){
 if(busy.value||!context.value)return;
 if(!submitted.value){
  if(!form.mode||!form.note.trim())return ElMessage.warning('请选择实际采购内容并填写核对说明');
  if((!selected.value.length||selected.value.some(i=>!Number.isInteger(Number(i.quantity))||Number(i.quantity)<=0||!(Number(i.amount)>0)||Number(i.shipping_amount)<0)))return ElMessage.warning('请选择实际采购的配件，填写件数和货款');
  if(form.mode==='whole'&&(!form.allocation_confirmed||changedAmount.value))return ElMessage.warning('请核对并确认整套成本分摊，合计须与原货款及运费相等');
  if(form.mode==='parts'&&changedAmount.value&&!form.confirm_amount_change)return ElMessage.warning('金额与原记录不同，请先核对并确认金额更正');
  try{await ElMessageBox.confirm(form.mode==='whole'?'确认实际购买了整套，按下方实物数量和已确认的成本分摊建立配件批次？原始采购记录保留追溯。':'确认将原套装误录批次更正为所选实物配件？本次只调整采购记录，实物仍需验收入库。','确认采购内容',{type:'warning',confirmButtonText:'确认核对'});}catch{return;}
  submitted.value={id:props.inboundId,revision:context.value.revision,request_key:requestKey.value,mode:form.mode,note:form.note.trim(),arrived:form.arrived,allocation_confirmed:form.allocation_confirmed,confirm_amount_change:form.confirm_amount_change,items:selected.value.map(i=>({product_id:Number(i.product_id),quantity:Number(i.quantity),amount:Number(i.amount),shipping_amount:Number(i.shipping_amount||0)}))};
 }
 const scope=currentApiCacheScope();busy.value=true;error.value='';
 try{const result=await apiClient.post('/api/inventory-workflow/purchase-bundle',submitted.value);if(disposed||scope!==currentApiCacheScope())return;ElMessage.success('已核对为实物配件批次，可分别到货及验收');emit('saved',result);visible.value=false;}catch(e){if(scope===currentApiCacheScope())error.value=e.message;}finally{if(scope===currentApiCacheScope())busy.value=false;}
}
watch(()=>form.mode,mode=>{if(submitted.value)return;for(const item of items.value){item.selected=false;item.amount=mode==='whole'?(item.suggested_amount??0):0;item.shipping_amount=mode==='whole'?(item.suggested_shipping_amount??0):0;}form.allocation_confirmed=false;form.confirm_amount_change=false;});
watch(()=>props.inboundId,load,{immediate:true});onBeforeUnmount(()=>{disposed=true;++version;});
</script>
<template>
 <el-dialog v-model="visible" title="核对套装实际采购内容" width="min(1050px,96vw)" append-to-body :close-on-click-modal="false" :show-close="!busy">
  <section v-loading="loading" class="bundle-review">
   <el-alert v-if="error" :title="error" type="error" :closable="false"/>
   <template v-if="context"><p>原批次 #{{inboundId}} · {{context.product.name}} · 原套装数量 {{context.batch.quantity}} · 原货款及运费 ¥{{originalAmount.toFixed(4)}}</p>
    <el-radio-group v-model="form.mode" :disabled="busy||!!submitted"><el-radio-button value="whole">实际买了完整套装</el-radio-button><el-radio-button value="parts">实际只买了配件</el-radio-button></el-radio-group>
    <el-alert type="info" :closable="false" :title="form.mode==='parts'?'选择实际采购的配件并填写数量、金额，保存后形成独立的实物库存批次。':'整套采购按下方配件建立实物批次。建议分摊基于已存配件成本，须由采购确认；原货款及运费合计保持一致。'"/>
    <el-table :data="items" border>
     <el-table-column v-if="form.mode==='parts'" label="采购" width="65"><template #default="{row}"><el-checkbox v-model="row.selected" :disabled="busy||!!submitted" :aria-label="'采购'+row.name"/></template></el-table-column>
     <el-table-column label="最小实物库存" min-width="320"><template #default="{row}"><div class="bundle-review-product"><ProductImagePreview :src="`/api/products/${row.product_id}/image?thumb=1`" :preview-list="[`/api/products/${row.product_id}/image`]" size="portrait"/><div><b>{{row.name}}</b><small>库存 {{row.inventory_number||row.product_id}} · 每套 {{row.per_set_quantity}} {{row.stock_unit||'件'}}</small></div></div></template></el-table-column>
     <el-table-column label="实物数量" width="160"><template #default="{row}"><el-input-number v-if="form.mode==='parts'" v-model="row.quantity" :key="`qty-${form.mode}-${row.selected}`" :min="1" :precision="0" :disabled="!row.selected||busy||!!submitted" style="width:135px"/><b v-else>{{row.quantity}} {{row.stock_unit||'件'}}</b></template></el-table-column>
     <el-table-column label="实际货款 / 分摊运费（元）" width="190"><template #default="{row}"><el-input-number v-model="row.amount" :key="`amount-${form.mode}-${row.selected}`" :precision="4" :min="0" :disabled="(form.mode==='parts'&&!row.selected)||busy||!!submitted" :aria-label="row.name+'实际货款'" style="width:160px"/><el-input-number v-model="row.shipping_amount" :key="`shipping-${form.mode}-${row.selected}`" :precision="4" :min="0" :disabled="(form.mode==='parts'&&!row.selected)||busy||!!submitted" :aria-label="row.name+'运费'" style="width:160px;margin-top:5px"/></template></el-table-column>
    </el-table>
    <template v-if="form.mode"><p>本次合计 ¥{{amount.toFixed(4)}}<el-checkbox v-if="form.mode==='parts'&&changedAmount" v-model="form.confirm_amount_change" :disabled="busy||!!submitted">已核对凭证，确认原金额录错；实际退款另走采购对账</el-checkbox></p><el-checkbox v-model="form.arrived" :disabled="busy||!!submitted">这些配件已到货，接下来等待仓库验收</el-checkbox></template>
    <el-checkbox v-if="form.mode==='whole'" v-model="form.allocation_confirmed" :disabled="busy||!!submitted">已确认上述配件成本分摊，原始采购总额不变</el-checkbox>
    <el-input v-model="form.note" type="textarea" maxlength="500" show-word-limit placeholder="核对说明 / 采购凭证" :disabled="busy||!!submitted"/>
    <el-alert v-if="submitted" title="内容已提交并锁定；响应中断时请重试本次核对，避免重复采购。" type="warning" :closable="false"/>
   </template>
  </section>
  <template #footer><el-button :disabled="busy" @click="visible=false">返回</el-button><el-button type="primary" :loading="busy" :disabled="loading||!context" @click="save">{{submitted?'重试本次核对':'确认保存采购内容'}}</el-button></template>
 </el-dialog>
</template>
<style scoped>
.bundle-review{display:grid;gap:12px}.bundle-review p{margin:0;font-size:13px}.bundle-review-product{display:flex;gap:10px;align-items:center;min-height:88px}.bundle-review-product>div{display:grid;gap:6px}.bundle-review-product small{color:var(--el-text-color-secondary)}.bundle-review .el-checkbox{margin-left:10px}
</style>
