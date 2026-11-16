<script setup>
import {computed,onBeforeUnmount,onMounted,ref} from 'vue';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {inventoryAdjustmentReasons} from '../../../../src/inventory-adjustment-reasons.js';
import {stocktakePayload,submitStocktakeRows} from '../../utils/inventory-batch-stocktake.js';
const props=defineProps({products:{type:Array,required:true}}),emit=defineEmits(['close','saved']);
const rows=ref(props.products.map(r=>({product_id:r.product_id,name:r.product_name,inventory_number:r.inventory_number,ledger:null,counted_quantity:null,reason_code:'',reason_note:'',status:'',error:'',payload:null})));
const loading=ref(false),busy=ref(false);const scope=currentApiCacheScope();let alive=true;
const current=()=>alive&&scope===currentApiCacheScope();
const success=computed(()=>rows.value.filter(r=>r.status==='success').length);
function validation(row){if(row.status==='success'||row.payload)return '';try{stocktakePayload(row,'preview');return '';}catch(e){return e.message;}}
const valid=computed(()=>rows.value.every(r=>{if(r.status==='success')return true;if(r.payload)return true;try{stocktakePayload(r,'preview');return true;}catch{return false;}}));
async function load(){loading.value=true;try{for(const row of rows.value){if(!current())return;if(row.status==='success'||row.payload)continue;try{const ledger=await apiClient.get(`/api/inventory/ledger?product_id=${row.product_id}&include_flow=local`,{noCache:true});if(!current())return;row.ledger=ledger;row.error='';if(!row.reason_code&&ledger.physical_estimate<0)row.reason_code='missing_purchase';}catch(e){if(current())row.error=e.message;}}}finally{if(current())loading.value=false;}}
async function submit(){if(busy.value||!valid.value)return;busy.value=true;try{await submitStocktakeRows(rows.value,apiClient,current);if(current())emit('saved');}finally{if(current())busy.value=false;}}
function close(){if(busy.value)return;emit('close');}
function scopeChanged(){alive=false;emit('close');}
onMounted(load);window.addEventListener('erp:auth-scope-changed',scopeChanged);onBeforeUnmount(()=>{alive=false;window.removeEventListener('erp:auth-scope-changed',scopeChanged);});
</script>
<template>
 <el-dialog :model-value="true" title="批量更新本地库存" width="1000px" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @update:model-value="close">
  <div class="batch-toolbar"><span>已完成 {{success}} / {{rows.length}} 项</span><el-button class="erp-btn erp-btn-secondary" :disabled="busy||loading" @click="load">重新读取库存</el-button></div>
  <el-table :data="rows" v-loading="loading" max-height="480" class="erp-data-table">
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
<style scoped>.batch-toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.batch-muted{font-size:12px;color:var(--el-text-color-secondary)}.batch-error{color:var(--el-color-danger)}</style>
