<script setup>
import OrderHandlingSummary from './OrderHandlingSummary.vue';
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import {PROCUREMENT_CANCELLATION_CAUSES} from '../../../../src/shared/procurement-demand-cancellation.js';
const props=defineProps({modelValue:Boolean,productId:Number}),emit=defineEmits(['update:modelValue','changed','detail']);
const visible=computed({get:()=>props.modelValue,set:value=>emit('update:modelValue',value)});
const data=ref(null),loading=ref(false),busy=ref(false),error=ref(''),selected=ref([]),cause=ref(''),note=ref(''),submitted=ref(null);
let version=0,disposed=false,controller;
const rows=computed(()=>data.value?.orders||[]);
const actionable=row=>Number(row.shortage_quantity)>0&&!row.quantity_needs_review;
const selectable=row=>!busy.value&&!submitted.value&&actionable(row);
const quantity=row=>Number(row.shortage_quantity||0);
const total=computed(()=>selected.value.reduce((sum,row)=>sum+quantity(row),0));
async function load(){
 controller?.abort();controller=new AbortController();const token=++version,scope=currentApiCacheScope();loading.value=true;error.value='';selected.value=[];
 try{const result=await apiClient.get(`/api/inventory-workflow/demand-details?product_id=${props.productId}`,{noCache:true,signal:controller.signal});if(disposed||token!==version||scope!==currentApiCacheScope())return;data.value=result;}
 catch(e){if(token===version&&e.name!=='AbortError')error.value=e.message;}finally{if(token===version)loading.value=false;}
}
async function save(){
 if(busy.value)return;
 if(!submitted.value){
  if(!selected.value.length||!cause.value)return ElMessage.warning('请选择订单商品和处理原因；备注可选');
  submitted.value={product_id:props.productId,order_item_ids:selected.value.map(row=>Number(row.order_item_id)),operation:'cancel',cause:cause.value,note:note.value.trim(),expected_revision:data.value.cancellation_revision,request_key:crypto.randomUUID()};
 }
 const scope=currentApiCacheScope(),token=version;busy.value=true;
 try{const result=await apiClient.post('/api/inventory-workflow/cancel-demand',submitted.value);if(disposed||token!==version||scope!==currentApiCacheScope())return;ElMessage.success('已取消采购并标记订单，两边待采购同步移除');window.dispatchEvent(new CustomEvent('erp:procurement-handled',{detail:{scope,event_id:result.event_id}}));emit('changed',result);visible.value=false;}
 catch(e){if(disposed||token!==version||scope!==currentApiCacheScope())return;if([400,403,404,409].includes(e.status))submitted.value=null;ElMessage.error(e.message||'保存失败，请重试；原提交标识已保留，避免重复操作');}
 finally{if(token===version)busy.value=false;}
}
function close(){if(!busy.value)visible.value=false;}
function detail(tab){close();emit('detail',tab);}
watch(()=>props.modelValue,value=>{if(!value){version++;controller?.abort();return;}data.value=null;selected.value=[];cause.value='';note.value='';submitted.value=null;void load();},{immediate:true});
onBeforeUnmount(()=>{disposed=true;version++;controller?.abort();});
</script>
<template>
 <el-dialog v-model="visible" title="取消采购并标记订单" width="min(1100px,96vw)" append-to-body :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy">
  <div v-loading="loading">
   <el-alert title="选择订单和原因后，将订单转为人工处理，并同步从两边的待采购队列移除。平台订单状态和库存数量不变。" type="info" :closable="false"/>
   <el-alert v-if="error" :title="error" type="error" :closable="false"/>
   <h3>{{data?.product?.name||'采购需求'}}</h3>

   <el-table :data="rows" row-key="order_item_id" border max-height="330" @selection-change="selected=$event" empty-text="当前没有待履约的FBS订单采购需求">
    <el-table-column type="selection" width="45" :selectable="selectable"/>
    <el-table-column label="订单 / 商品" min-width="245"><template #default="{row}"><b>{{row.posting_number}}</b><p>{{row.ozon_name||row.ozon_sku}}</p><small>{{row.shop_name}}</small><OrderHandlingSummary :row="row"/></template></el-table-column>
    <el-table-column label="实际缺货" width="100"><template #default="{row}">{{row.shortage_quantity??0}} 件</template></el-table-column>
    <el-table-column label="本次处理" width="110"><template #default="{row}">{{quantity(row)}} 件</template></el-table-column>
    <el-table-column label="采购决定" min-width="230"><template #default="{row}"><template v-if="row.cancellation"><el-tag size="small" type="warning">已转人工处理</el-tag><p>{{PROCUREMENT_CANCELLATION_CAUSES[row.cancellation.cause]}} · {{row.cancellation.note}}</p><small>{{row.cancellation.person_name||'采购人员'}} · {{shanghaiDateTimeText(row.cancellation.created_at,{assumeUtcWhenNaive:true})}}</small></template><span v-else>待采购，可选择原因转人工处理</span></template></el-table-column>
   </el-table>
   <p class="cancellation-help">没货、不发货或售后等情况可直接选择原因，备注选填；已有订单标记和备注会保留，并追加本次处理原因。</p>
   <el-form label-position="top" :disabled="busy||!!submitted">
    <el-form-item label="取消原因" required><el-select v-model="cause" aria-label="取消采购原因"><el-option v-for="(label,key) in PROCUREMENT_CANCELLATION_CAUSES" :key="key" :value="key" :label="label"/></el-select></el-form-item>
    <el-form-item label="补充备注（选填）"><el-input v-model="note" type="textarea" :rows="2" maxlength="300" show-word-limit placeholder="可补充缺货、暂不发货或售后的处理信息，不填也可提交"/></el-form-item>
   </el-form>
   <p class="cancellation-help">本地保障和FBP申请是独立需求，请在对应规则／申请中调整，避免影响同商品的其他订单。<el-button plain size="small" :disabled="busy" @click="detail('safety')">调整本地保障</el-button><el-button plain size="small" :disabled="busy" @click="detail('fbp')">查看FBP申请</el-button></p>
  </div>
  <template #footer><span class="cancellation-total">已选 {{selected.length}} 项 · {{total}} 件</span><el-button :disabled="busy||!!submitted" @click="load">刷新明细</el-button><el-button :disabled="busy" @click="close">返回</el-button><el-button type="primary" :loading="busy" :disabled="loading||(!submitted&&(!selected.length||!cause))" @click="save">{{submitted?'重试原操作':'确认取消采购并标记订单'}}</el-button></template>
 </el-dialog>
</template>
<style scoped>
.cancellation-help{font-size:12px;color:var(--el-text-color-secondary);line-height:1.7}.cancellation-total{margin-right:16px}.el-table{margin-top:14px}.el-form{margin-top:16px}.cancellation-help .el-button{margin:4px 0 4px 8px}
</style>
