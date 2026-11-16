<script setup>
import {computed,onBeforeUnmount,onMounted,reactive,ref} from 'vue';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {inventoryAdjustmentReasons} from '../../../../src/inventory-adjustment-reasons.js';
import {stocktakePayload,submitStocktakeRows,fillStocktakeQuantities} from '../../utils/inventory-batch-stocktake.js';
const props=defineProps({products:{type:Array,required:true}}),emit=defineEmits(['close','saved']);
const rows=ref(props.products.map(r=>({product_id:r.product_id,name:r.product_name,inventory_number:r.inventory_number,ledger:null,counted_quantity:null,reason_code:'',reason_note:'',status:'',error:'',payload:null})));
const loading=ref(false),busy=ref(false),bulkQuantity=ref(0),selectedRows=ref([]),submission=reactive({payload:null});const scope=currentApiCacheScope();let alive=true;
const current=()=>alive&&scope===currentApiCacheScope();
const success=computed(()=>rows.value.filter(r=>r.status==='success').length);
function validation(row){if(row.status==='success'||row.payload)return '';try{stocktakePayload(row,'preview');return '';}catch(e){return e.message;}}
const valid=computed(()=>rows.value.every(r=>{if(r.status==='success')return true;if(r.payload)return true;try{stocktakePayload(r,'preview');return true;}catch{return false;}}));
async function load(){
 if(submission.payload)return;
 loading.value=true;
 try{const data=await apiClient.get('/api/inventory/batch-stocktake?'+new URLSearchParams({product_ids:rows.value.map(r=>r.product_id).join(',')}),{noCache:true});if(!current())return;const byId=new Map(data.rows.map(r=>[Number(r.product_id),r]));for(const row of rows.value){row.ledger=byId.get(Number(row.product_id))||null;row.error=row.ledger?'':'库存已删除或不可读取，请重新选择';if(!row.reason_code&&row.ledger?.physical_estimate<0)row.reason_code='missing_purchase';}}
 catch(e){if(current())for(const row of rows.value){row.ledger=null;row.error=e.message;}}
 finally{if(current())loading.value=false;}
}
function fill(quantity,selected=false){try{fillStocktakeQuantities(selected?selectedRows.value:rows.value,quantity);}catch(e){ElMessage.warning(e.message);}}
async function submit(){if(busy.value||!valid.value)return;busy.value=true;try{await submitStocktakeRows(rows.value,apiClient,current,submission);if(current())emit('saved');}finally{if(current())busy.value=false;}}
function close(){if(busy.value)return;emit('close');}
function scopeChanged(){alive=false;emit('close');}
onMounted(load);window.addEventListener('erp:auth-scope-changed',scopeChanged);onBeforeUnmount(()=>{alive=false;window.removeEventListener('erp:auth-scope-changed',scopeChanged);});
</script>
<template>
 <el-dialog :model-value="true" title="批量更新本地库存" width="1100px" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @update:model-value="close">
  <div class="batch-toolbar"><span>已完成 {{success}} / {{rows.length}} 项</span><el-button class="erp-btn erp-btn-secondary" :disabled="busy||loading||!!submission.payload" @click="load">重新读取库存</el-button></div>
  <div class="batch-fill"><el-button class="erp-btn erp-btn-secondary" :disabled="busy||loading||!!submission.payload" @click="fill(0)">全部填0</el-button><el-input-number v-model="bulkQuantity" :min="0" :precision="0" controls-position="right" aria-label="批量填入实际数量" :disabled="busy||!!submission.payload"/><el-button class="erp-btn erp-btn-secondary" :disabled="busy||loading||!!submission.payload||bulkQuantity==null" @click="fill(bulkQuantity,selectedRows.length>0)">{{selectedRows.length?`填入所选（${selectedRows.length}）`:'填入全部'}}</el-button></div>
  <el-table :data="rows" @selection-change="selectedRows=$event" v-loading="loading" max-height="480" class="erp-data-table">
   <el-table-column type="selection" width="44" :selectable="row=>!busy&&!row.payload&&row.status!=='success'"/>
   <el-table-column label="库存商品" min-width="200"><template #default="{row}">{{row.name}}<div class="batch-muted">{{row.inventory_number||row.product_id}}</div></template></el-table-column>
   <el-table-column label="当前实物" width="90"><template #default="{row}">{{row.ledger?.physical_estimate??'待核实'}}</template></el-table-column>
   <el-table-column label="实际数量" width="130"><template #default="{row}"><el-input v-model="row.counted_quantity" type="number" min="0" step="1" aria-label="实际数量" :disabled="busy||!!row.payload||row.status==='success'"/></template></el-table-column>
   <el-table-column label="调整原因" min-width="190"><template #default="{row}"><el-select v-model="row.reason_code" :disabled="busy||!!row.payload||row.status==='success'"><el-option v-for="r in inventoryAdjustmentReasons" :key="r.code" :label="r.label" :value="r.code"/></el-select></template></el-table-column>
   <el-table-column label="说明" min-width="150"><template #default="{row}"><el-input v-model="row.reason_note" maxlength="500" :disabled="busy||!!row.payload||row.status==='success'" placeholder="选填"/></template></el-table-column>
   <el-table-column label="结果" min-width="190"><template #default="{row}"><span v-if="row.status==='success'">已更新</span><span v-else-if="row.status==='saving'">提交中</span><span v-else-if="row.error" class="batch-error">{{row.error}}</span><span v-else-if="row.payload">结果待确认，重试不会重复更新</span><span v-else>{{validation(row)||`差额 ${Number(row.counted_quantity)-Number(row.ledger?.physical_estimate)} 件`}}</span></template></el-table-column>
  </el-table>
  <template #footer><el-button :disabled="busy" @click="close">关闭</el-button><el-button type="primary" :loading="busy" :disabled="loading||!valid||success===rows.length" @click="submit">确认更新（{{rows.length-success}}项）</el-button></template>
 </el-dialog>
</template>
<style scoped>.batch-fill{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}.batch-fill .el-input-number{width:130px}.batch-fill :deep(.el-button)+:deep(.el-button){margin-left:0}.batch-toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.batch-muted{font-size:12px;color:var(--el-text-color-secondary)}.batch-error{color:var(--el-color-danger)}</style>
