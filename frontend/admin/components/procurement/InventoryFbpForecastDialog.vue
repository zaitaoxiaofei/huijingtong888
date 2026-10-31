<script setup>
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
const props=defineProps({modelValue:Boolean,productId:Number,productName:String}),emit=defineEmits(['update:modelValue','created']);
const visible=computed({get:()=>props.modelValue,set:v=>emit('update:modelValue',v)}),loading=ref(false),busy=ref(false),error=ref(''),state=ref(null),rows=ref([]),note=ref(''),key=ref(''),submitted=ref(null);
const total=computed(()=>rows.value.filter(r=>r.selected).reduce((n,r)=>n+Number(r.quantity||0)*Number(r.per_set_quantity),0));
let version=0,disposed=false,controller;
async function load(){controller?.abort();controller=new AbortController();const token=++version,scope=currentApiCacheScope();loading.value=true;error.value='';rows.value=[];try{const result=await apiClient.get(`/api/inventory-workflow?product_id=${props.productId}&fresh=1`,{noCache:true,signal:controller.signal});if(disposed||token!==version||scope!==currentApiCacheScope())return;state.value=result.rows?.[0];rows.value=(state.value?.fbp_forecast_suggestions||[]).filter(r=>r.suggested_application_qty>0).map(r=>({...r,selected:!!r.mapping_id,quantity:r.suggested_application_qty}));}catch(e){if(token===version&&e.name!=='AbortError')error.value=e.message;}finally{if(token===version)loading.value=false;}}
async function save(){if(busy.value)return;if(!submitted.value){const selected=rows.value.filter(r=>r.selected);if(!selected.length)return ElMessage.warning('请选择要确认备货的店铺SKU');if(selected.some(r=>!r.mapping_id||!Number.isSafeInteger(r.quantity)||r.quantity<1||r.quantity>1000000))return ElMessage.warning('请核对SKU绑定，并填写大于0的整数套数');submitted.value={product_id:props.productId,forecast_confirmation:true,submit:true,request_key:key.value,note:note.value,rows:selected.map(r=>({shop_id:r.shop_id,ozon_sku:r.ozon_sku,quantity:r.quantity}))};}const scope=currentApiCacheScope(),token=version;busy.value=true;try{const r=await apiClient.post('/api/inventory-workflow/fbp',submitted.value);if(disposed||token!==version||scope!==currentApiCacheScope())return;ElMessage.success('已创建正式FBP备货申请，货源不足部分进入必须采购，剩余预测继续黄色提醒');emit('created',r);emit('update:modelValue',false);}catch(e){if([400,403,404,409].includes(e.status))submitted.value=null;if(scope===currentApiCacheScope())ElMessage.error(e.message+'；申请表已保留，可重试原提交');}finally{busy.value=false;}}
watch(()=>[props.modelValue,props.productId],([v])=>{if(v){key.value=crypto.randomUUID();submitted.value=null;note.value='';void load();}else{++version;controller?.abort();}},{immediate:true});
onBeforeUnmount(()=>{disposed=true;++version;controller?.abort();});
</script>
<template>
 <el-dialog v-model="visible" title="确认FBP预测并创建备货申请" width="min(1200px,96vw)" append-to-body :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy">
  <h3>{{productName||'当前库存'}}</h3><el-alert type="warning" :closable="false" title="预测是黄色建议，可调整套数或取消。正式确认后才成为FBP申请；系统先用现货和采购在途覆盖，剩余缺口才必须采购。"/>
  <p>已有申请、已确认备货和发往FBP的在途已扣除。本次创建独立申请，不覆盖原申请或顺带提交其他草稿SKU。</p>
  <el-alert v-if="error" :title="error" type="error" :closable="false"/><el-button :loading="loading" :disabled="busy||!!submitted" @click="load">重新读取预测</el-button>
  <div class="forecast-summary"><span>本地可用 {{state?.free??'待核对'}} 件</span><span>本次申请实物 {{total}} 件</span><span>FBP预测采购缺口 {{state?.supply_plan?.optional_fbp??'待核对'}} 件</span></div>
  <el-table v-loading="loading" :data="rows" border :empty-text="state?.fbp?.known?'当前预测已被现有申请、备货或在途覆盖':'FBP预测数据未核实，请先同步官方库存，不把未知当零'">
   <el-table-column width="45"><template #default="{row}"><el-checkbox v-model="row.selected" :disabled="busy||!!submitted||!row.mapping_id"/></template></el-table-column>
   <el-table-column prop="shop_name" label="店铺" min-width="130"/><el-table-column prop="ozon_sku" label="SKU" min-width="150"/>
   <el-table-column prop="available" label="FBP可售（套）" width="130"/><el-table-column prop="fbp_target" label="预测目标（套）" width="135"/>
   <el-table-column label="已有覆盖（套）" min-width="175"><template #default="{row}">发往FBP {{row.in_transit||0}} · 已确认 {{row.committed_qty||0}}<p>待审核申请 {{Number(row.pending_physical)/Number(row.per_set_quantity)}}</p></template></el-table-column>
   <el-table-column label="本次确认（套）" width="180"><template #default="{row}"><el-input-number v-model="row.quantity" :min="1" :max="1000000" :precision="0" :disabled="busy||!!submitted||!row.mapping_id"/></template></el-table-column>
   <el-table-column label="每套实物" width="100"><template #default="{row}">{{row.per_set_quantity}} 件</template></el-table-column>
  </el-table>
  <el-input v-model="note" type="textarea" :disabled="busy||!!submitted" maxlength="500" placeholder="运营确认说明（选填）"/>
  <template #footer><el-button :disabled="busy" @click="visible=false">取消</el-button><el-button type="primary" :loading="busy" :disabled="loading||!!error||!rows.length" @click="save">{{submitted?'重试原申请':'确认创建FBP申请'}}</el-button></template>
 </el-dialog>
</template>
<style scoped>
.forecast-summary{display:flex;gap:24px;flex-wrap:wrap;margin:16px 0}.forecast-summary span{font-size:13px}.el-textarea{margin-top:14px}
</style>
