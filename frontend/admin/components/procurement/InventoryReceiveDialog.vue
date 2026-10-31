<script setup>
import {computed,onBeforeUnmount,reactive,ref,watch} from 'vue';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
const props=defineProps({modelValue:Boolean,productId:Number,productName:String,inboundId:Number}),emit=defineEmits(['update:modelValue','saved']);
const visible=computed({get:()=>props.modelValue,set:v=>emit('update:modelValue',v)}),rows=ref([]),context=ref({}),loading=ref(false),saving=ref(false),error=ref(''),preview=ref(null),submitted=ref(null),requiresCount=ref(false),counted=ref(null);
const selected=computed(()=>rows.value.filter(r=>r.selected)),quantity=computed(()=>selected.value.reduce((n,r)=>n+Number(r.actual||0),0));
let version=0,disposed=false,key='';
const units=n=>n==null?'待核对':`${n} 件`;
async function load(){const token=++version,scope=currentApiCacheScope();loading.value=true;rows.value=[];preview.value=null;submitted.value=null;requiresCount.value=false;counted.value=null;error.value='';key=crypto.randomUUID();try{const r=await apiClient.get(`/api/inventory-workflow/receipts/context?product_id=${props.productId}`,{noCache:true});if(disposed||token!==version||scope!==currentApiCacheScope())return;context.value=r;rows.value=(r.rows||[]).map((row,i)=>({...row,selected:props.inboundId?Number(row.id)===props.inboundId:i===0,actual:Number(row.quantity),reason:''}));}catch(e){if(!disposed&&token===version&&scope===currentApiCacheScope())error.value=e.message;}finally{if(token===version)loading.value=false;}}
async function next(){
 if(!selected.value.length)return ElMessage.warning('请选择要登记入库的批次');
 if(selected.value.some(r=>!Number.isSafeInteger(r.actual)||r.actual<1||r.actual>Number(r.quantity)))return ElMessage.warning('入库数量须为正整数且不超过待收数；采购数录错请先编辑采购批次');
 if(selected.value.some(r=>r.actual!==Number(r.quantity)&&!r.reason.trim()))return ElMessage.warning('数量与待收数不一致，请填写差异原因');
 if(requiresCount.value&&(counted.value==null||!Number.isSafeInteger(counted.value)||counted.value<0))return ElMessage.warning('请核实包含本次合格到货的当前实物总数，避免历史补录重复加库存');
 const token=version,scope=currentApiCacheScope();saving.value=true;error.value='';
 try{const body={product_id:props.productId,request_key:key,counted_quantity:counted.value,records:selected.value.map(r=>({id:r.id,quantity:r.actual,expected_quantity:Number(r.quantity),reason:r.reason}))};
  const r=await apiClient.post('/api/inventory-workflow/receipts/preview',body);if(disposed||token!==version||scope!==currentApiCacheScope())return;
  if(r.requires_count&&counted.value==null){requiresCount.value=true;error.value='此商品存在历史出库或盘点，请核实包含本次到货的当前实物总数；不直接叠加入库数量。';return;}
  submitted.value={...body,expected_revision:r.revision};preview.value=r;
 }catch(e){if(!disposed&&token===version&&scope===currentApiCacheScope())error.value=e.message;}finally{if(token===version)saving.value=false;}
}
async function save(){if(!submitted.value)return;const scope=currentApiCacheScope(),token=version;saving.value=true;error.value='';try{await apiClient.post('/api/inventory-workflow/receipts',submitted.value);if(disposed||token!==version||scope!==currentApiCacheScope())return;ElMessage.success('入库已登记，未收部分继续待处理');visible.value=false;emit('saved');}catch(e){if(!disposed&&token===version&&scope===currentApiCacheScope()){error.value=e.message;preview.value=null;}}finally{if(token===version)saving.value=false;}}
watch(()=>[props.modelValue,props.productId,props.inboundId],()=>{if(props.modelValue)load();},{immediate:true});
function scopeChanged(){++version;visible.value=false;}window.addEventListener('erp:auth-scope-changed',scopeChanged);
onBeforeUnmount(()=>{disposed=true;++version;window.removeEventListener('erp:auth-scope-changed',scopeChanged);});
</script>
<template>
 <el-dialog v-model="visible" :title="preview?'确认入库影响':'快速登记入库'" width="min(780px,94vw)" append-to-body :show-close="!saving" :close-on-click-modal="false" :close-on-press-escape="!saving">
  <div v-loading="loading"><p><strong>{{productName||`库存商品 #${productId}`}}</strong></p><el-alert v-if="error" :title="error" type="warning" :closable="false"/>
   <div class="receive-overview"><div><span>本地实物</span><strong>{{units(preview?.physical_before??context.physical)}}<template v-if="preview"> → {{units(preview.physical_after)}}</template></strong></div><div><span>可用库存</span><strong>{{units(preview?.available_before??context.available)}}<template v-if="preview"> → {{units(preview.available_after)}}</template></strong></div><div><span>本次入库</span><strong>{{units(preview?.quantity??quantity)}}</strong></div></div>
   <template v-if="preview"><el-alert title="仅合格到货计入库存，未收部分继续保留待处理。" type="info" :closable="false"/><p v-if="preview.requires_count">本次按已核实的在仓总数登记，不重复叠加历史实物。</p><p v-for="row in submitted.records" :key="row.id">批次 #{{row.id}}：{{row.quantity}} 件<span v-if="row.reason"> · 差异原因：{{row.reason}}</span></p></template>
   <template v-else><el-table :data="rows" max-height="300" empty-text="没有待入库的已采购批次"><el-table-column width="44"><template #default="{row}"><el-checkbox v-model="row.selected" :disabled="saving" :aria-label="`选择入库批次 ${row.id}`"/></template></el-table-column><el-table-column label="采购批次" min-width="160"><template #default="{row}">{{row.order_no||'采购批次'}} · #{{row.id}}</template></el-table-column><el-table-column prop="quantity" label="待收" width="70"/><el-table-column label="本次入库" width="150"><template #default="{row}"><el-input-number v-model="row.actual" :min="1" :max="Number(row.quantity)" :precision="0" :disabled="saving||!row.selected" :aria-label="`批次 ${row.id} 入库数量`" controls-position="right"/></template></el-table-column><el-table-column label="差异原因" min-width="170"><template #default="{row}"><el-input v-if="row.selected&&row.actual!==Number(row.quantity)" v-model="row.reason" placeholder="如部分到货、验货不合格" maxlength="100" :disabled="saving"/><span v-else>—</span></template></el-table-column></el-table>
    <el-form v-if="requiresCount" label-position="top"><el-form-item label="核实当前实物总数（包含本次合格到货）" required><el-input-number v-model="counted" :min="0" :precision="0" :disabled="saving"/></el-form-item></el-form>
   </template>
  </div><template #footer><el-button :disabled="saving" @click="visible=false">取消</el-button><el-button v-if="preview" :disabled="saving" @click="preview=null;submitted=null">返回修改</el-button><el-button type="primary" :disabled="loading||!selected.length" :loading="saving" @click="preview?save():next()">{{preview?'确认入库':'确认数量，查看影响'}}</el-button></template>
 </el-dialog>
</template>
<style scoped>
.receive-overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0}.receive-overview>div{display:grid;gap:10px;padding:16px;background:var(--el-fill-color-light);border:1px solid var(--el-border-color-lighter);border-radius:8px}.receive-overview span{font-size:12px;color:var(--el-text-color-secondary)}.receive-overview strong{font-size:17px}.el-input-number{max-width:100%}@media(max-width:600px){.receive-overview{grid-template-columns:1fr}}
</style>
