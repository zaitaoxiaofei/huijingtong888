<script setup>
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
const props=defineProps({productId:Number,readOnly:Boolean,formOpen:Boolean,externalActions:Boolean}),emit=defineEmits(['saved','busy','state']);
const auth=useAuthStore(),canWrite=computed(()=>!props.readOnly&&hasPermission(auth.user,'inventory.write'));
const data=ref(null),loading=ref(false),busy=ref(false),error=ref(''),action=ref('assemble'),quantity=ref(1),batchId=ref(null),note=ref(''),submission=ref(null);
let version=0,disposed=false;
const batch=computed(()=>data.value?.batches?.find(b=>b.id===batchId.value));
const parts=computed(()=>action.value==='disassemble'?batch.value?.components||[]:data.value?.components||[]);
const maximum=computed(()=>action.value==='assemble'?(data.value?.assembly_capacity??data.value?.assemblable??0):Math.min(data.value?.finished_available||0,batch.value?.remaining||0));
const valid=computed(()=>data.value&&canWrite.value&&Number.isSafeInteger(quantity.value)&&quantity.value>0&&quantity.value<=maximum.value&&!loading.value);
const previewRows=computed(()=>{
 if(!data.value)return [];const q=Number.isSafeInteger(quantity.value)&&quantity.value>0?quantity.value:0,sign=action.value==='assemble'?1:-1;
 const row=(id,name,before,delta,unit)=>({id,name,before,delta,after:before==null?null:before+delta,unit});
 return [row('finished','已打包成品',data.value.finished_physical,sign*q,'套'),...parts.value.map(part=>row(part.product_id,`${part.name} · ${part.inventory_number||part.product_id}`,data.value.components.find(c=>c.product_id===part.product_id)?.physical_stock,-sign*q*part.per_set_quantity,part.stock_unit||'件'))];
});
const previewValid=computed(()=>Number.isSafeInteger(quantity.value)&&quantity.value>0&&quantity.value<=maximum.value);

async function load(){
 const token=++version,scope=currentApiCacheScope();loading.value=true;error.value='';
 try{const value=await apiClient.get(`/api/inventory/bundle-conversion?product_id=${props.productId}`,{noCache:true});if(disposed||token!==version||scope!==currentApiCacheScope())return;data.value=value;batchId.value=value.batches[0]?.id??null;}
 catch(e){if(token===version)error.value=e.message||'成品与散件库存读取失败';}finally{if(token===version)loading.value=false;}
}
async function save(){
 if(!canWrite.value||busy.value||(!submission.value&&!valid.value))return;
 if(!submission.value)submission.value={product_id:props.productId,action:action.value,quantity:quantity.value,batch_id:action.value==='disassemble'?batchId.value:null,revision:data.value.revision,request_key:crypto.randomUUID(),note:note.value,stock_location:'LOCAL'};
 const token=version,scope=currentApiCacheScope();busy.value=true;error.value='';
 try{const result=await apiClient.post('/api/inventory/bundle-conversion',submission.value);if(disposed||token!==version||scope!==currentApiCacheScope())return;submission.value=null;ElMessage.success(result.action==='assemble'?'组装入库完成，已扣减对应散件':'拆包完成，已返还原批次散件');emit('saved',result);await load();busy.value=false;}
 catch(e){if(token!==version||scope!==currentApiCacheScope())return;if([400,403,404,409].includes(e.status)){submission.value=null;await load();}error.value=e.message||'提交结果未确认，请使用同一记录重试';}
 finally{if(token===version)busy.value=false;}
}
function reset(){++version;data.value=null;submission.value=null;busy.value=false;}
watch(()=>props.productId,()=>{reset();load();},{immediate:true});
watch(busy,value=>emit('busy',value),{flush:'sync'});
watch([valid,busy,submission,action,quantity],()=>emit('state',{canSave:!!valid.value,busy:busy.value,retrying:!!submission.value,label:submission.value?'重试确认':`${action.value==='assemble'?'确认组装':'确认拆包'} ${quantity.value||''} 套`}),{immediate:true,flush:'sync'});
defineExpose({save});
window.addEventListener('erp:auth-scope-changed',reset);onBeforeUnmount(()=>{disposed=true;reset();window.removeEventListener('erp:auth-scope-changed',reset);});
</script>
<template>
 <section class="bundle-conversion" v-loading="loading" aria-label="套装成品与散件转换">
  <el-alert v-if="error" :title="error" type="warning" :closable="false"/><el-button v-if="error&&!data" @click="load">重新读取成品库存</el-button>
  <template v-if="data">
   <div class="bundle-stock-cards"><div><small>已打包成品</small><strong>{{data.finished_physical}} 套</strong><small>可发 {{data.finished_available}} · 占用 {{data.finished_reserved}}</small></div><div><small>散件最多可组装</small><strong>{{data.assemblable}} 套</strong><small>已扣订单与 FBP 占用</small></div><div><small>最大可供</small><strong>{{data.maximum_available}} 套</strong><small>成品可发 + 可组装</small></div></div>
   <p class="bundle-help">本地仓 · 可组装数量使用共享散件，不能与其他套装相加。确认已完成的组装数量后，系统扣减对应散件并增加成品。</p>
   <details v-if="canWrite" :open="formOpen" class="bundle-conversion-form"><summary>{{formOpen?'转换操作':'组装入库 / 拆包返还散件'}}</summary>
    <fieldset :disabled="busy||!!submission"><label>转换方式<select v-model="action" aria-label="套装转换方式"><option value="assemble">散件 → 组装成品</option><option value="disassemble">成品 → 拆回散件</option></select></label>
     <label v-if="action==='disassemble'">原组装批次<select v-model="batchId" aria-label="原组装批次"><option v-for="b in data.batches" :key="b.id" :value="b.id">#{{b.id}} · {{shanghaiDateTimeText(b.created_at,{assumeUtcWhenNaive:true})}} · 剩余 {{b.remaining}} 套</option></select></label>
     <label>{{action==='assemble'?'本次已完成组装':'本次确认拆包'}}数量（最多 {{maximum}} 套）<el-input-number v-model="quantity" :min="1" :max="Math.max(1,maximum)" :precision="0" :disabled="busy||!!submission" aria-label="套装转换数量"/></label>
     <div class="bundle-conversion-preview"><table aria-label="本次转换前后库存"><thead><tr><th>库存项目</th><th>当前</th><th>本次变动</th><th>完成后</th></tr></thead><tbody><tr v-for="row in previewRows" :key="row.id"><td>{{row.name}}</td><td>{{row.before??'待核对'}} {{row.unit}}</td><td>{{row.delta>=0?'+':'−'}}{{Math.abs(row.delta)}} {{row.unit}}</td><td>{{previewValid?(row.after??'待核对'):'—'}} {{row.unit}}</td></tr></tbody></table></div>
     <el-alert v-if="maximum===0" :title="action==='assemble'?'散件不足，当前无法组装':'没有可拆的未占用成品，请核对成品和原组装批次'" type="info" :closable="false"/>
     <p class="bundle-help">{{action==='assemble'?'实际打包、贴标完成后再确认。可使用本套装待组装订单已分配的散件，完成后订单改为占用成品；其他订单和 FBP 占用不能借用。预览不会扣库存。':'实际拆包完成后再确认，按原组装批次返还配件。被订单或 FBP 占用的成品不能拆包。'}}</p>
     <label>操作说明<el-input v-model="note" maxlength="500" placeholder="可填写打包或拆包说明"/></label>
    </fieldset>
    <p v-if="submission&&!busy">提交结果尚未确认，请使用同一记录重试。</p><el-button v-if="!externalActions" type="primary" :loading="busy" :disabled="!submission&&!valid" @click="save">{{submission?'重试确认':action==='assemble'?'确认已打包并入库':'确认已拆包并返还'}}</el-button>
   </details>
   <details v-if="data.history?.length" class="bundle-conversion-form"><summary>组装 / 拆包记录 · {{data.history.length}} 条</summary><p v-for="record in data.history" :key="record.id" class="bundle-help">#{{record.id}} · {{record.action==='bundle_assembly'?'组装入库':'拆包返还'}} {{record.quantity}} 套<span v-if="record.batch_id"> · 原批次 #{{record.batch_id}}</span> · {{shanghaiDateTimeText(record.created_at,{assumeUtcWhenNaive:true})}}<br v-if="record.note"/>{{record.note}}</p></details>
  </template>
 </section>
</template>
<style scoped>
.bundle-conversion{display:grid;gap:10px}.bundle-stock-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.bundle-stock-cards>div{display:grid;gap:6px;padding:12px;background:var(--el-fill-color-light);border-radius:8px}.bundle-stock-cards strong{font-size:20px}.bundle-help,.bundle-stock-cards small{font-size:12px;color:var(--el-text-color-secondary);line-height:1.7;margin:0}.bundle-conversion-form{border:1px solid var(--el-border-color);border-radius:8px;padding:12px}.bundle-conversion-form summary{cursor:pointer;font-weight:600}.bundle-conversion-form fieldset{border:0;padding:12px 0;display:grid;gap:12px;min-width:0}.bundle-conversion-form label{display:grid;gap:6px;font-size:13px}.bundle-conversion-form select{padding:9px;width:100%;border:1px solid var(--el-border-color);border-radius:6px;background:var(--el-bg-color);color:var(--el-text-color-primary)}.bundle-conversion-preview{font-size:13px;line-height:1.6;background:var(--el-fill-color-light);padding:8px 12px;border-radius:6px}.bundle-conversion-preview table{width:100%;border-collapse:collapse;table-layout:fixed}.bundle-conversion-preview th,.bundle-conversion-preview td{padding:9px 5px;text-align:right;border-bottom:1px solid var(--el-border-color-lighter);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.bundle-conversion-preview th{font-weight:500;color:var(--el-text-color-secondary)}.bundle-conversion-preview th:first-child,.bundle-conversion-preview td:first-child{width:37%;text-align:left}@media(max-width:480px){.bundle-stock-cards{grid-template-columns:1fr}.bundle-stock-cards>div{grid-template-columns:1fr auto}.bundle-stock-cards small:last-child{grid-column:1/-1}}
</style>
