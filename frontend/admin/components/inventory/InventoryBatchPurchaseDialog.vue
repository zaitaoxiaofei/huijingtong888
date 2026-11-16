<script setup>
import {computed,onBeforeUnmount,onMounted,ref} from 'vue';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {historicalPurchaseAverage,purchaseBackfillGroups} from '../../../../src/shared/purchase-backfill-defaults.js';
import {purchaseBackfillPayload,submitPurchaseBackfills} from '../../utils/inventory-batch-purchase.js';
const props=defineProps({products:{type:Array,required:true}}),emit=defineEmits(['close','saved']);
const rows=ref([]);
const busy=ref(false),loading=ref(false),scope=currentApiCacheScope();let alive=true;const current=()=>alive&&scope===currentApiCacheScope();
const success=computed(()=>rows.value.filter(r=>r.status==='success').length);
const ready=computed(()=>rows.value.every(r=>r.status==='success'||(r.payload&&r.preview)));
function validation(row){if(row.status==='success'||row.payload)return '';try{purchaseBackfillPayload(row,'preview');return '';}catch(e){return e.message;}}
const valid=computed(()=>rows.value.every(r=>!validation(r)));
function syncAmount(row){if(!row.amount_manual&&row.unit_cost!==null&&row.unit_cost!==''&&Number(row.quantity)>0)row.amount=Number((Number(row.quantity)*Number(row.unit_cost)).toFixed(4));}
function priceChanged(row){row.unit_cost_manual=true;row.amount_manual=false;syncAmount(row);}
async function load(){
 loading.value=true;
 try{for(const product of props.products){
  if(!current())return;
  const existing=rows.value.filter(r=>r.product_id===product.product_id);
  if(existing.length&&existing.every(r=>r.status==='success'||r.payload))continue;
  try{
   const ledger=await apiClient.get(`/api/procurement/ledger?product_id=${product.product_id}`,{noCache:true});if(!current())return;
   const average=historicalPurchaseAverage(ledger.purchases);
   if(existing.some(r=>!r.order_item_ids)){rows.value=rows.value.filter(r=>r.product_id!==product.product_id);existing.length=0;}
   if(existing.length){for(const row of existing){if(row.status==='success'||row.payload)continue;row.ledger=ledger;row.error='';row.missing_quantity=(ledger.orders||[]).filter(o=>row.order_item_ids.includes(Number(o.order_item_id))&&o.entered_transport&&o.stock_location!=='FBP').reduce((n,o)=>n+Number(o.missing_purchase_quantity||0),0);if(!row.unit_cost_manual){row.average=average;row.unit_cost=average?.unit_cost??null;syncAmount(row);}}}
   else for(const group of purchaseBackfillGroups(ledger)){
    const row={product_id:product.product_id,name:product.product_name,inventory_number:product.inventory_number,ledger,quantity:group.missing_quantity,missing_quantity:group.missing_quantity,order_item_ids:group.order_item_ids,order_date:group.date,purchased_at:group.date,average,unit_cost:average?.unit_cost??null,unit_cost_manual:false,amount:null,amount_manual:false,shipping_amount:0,payload:null,preview:null,error:'',status:''};syncAmount(row);rows.value.push(row);
   }
  }catch(e){if(current()){if(existing.length)for(const row of existing)row.error=e.message;else rows.value.push({product_id:product.product_id,name:product.product_name,ledger:null,quantity:null,amount:null,shipping_amount:0,purchased_at:'',error:e.message,status:''});}}
 }}finally{if(current())loading.value=false;}
}
async function preview(){if(busy.value||!valid.value)return;busy.value=true;try{for(const row of rows.value){if(!current())return;if(row.status==='success'||row.payload)continue;try{const payload=purchaseBackfillPayload(row,crypto.randomUUID());const result=await apiClient.post('/api/procurement/ledger/preview',payload);if(!current())return;row.payload=payload;row.preview=result;row.error='';}catch(e){if(current())row.error=e.message;}}}finally{if(current())busy.value=false;}}
async function submit(){if(!ready.value||busy.value)return;busy.value=true;try{await submitPurchaseBackfills(rows.value,apiClient,current);if(current())emit('saved');}finally{if(current())busy.value=false;}}
function edit(row){if(busy.value||row.status==='success'||row.status==='error')return;row.payload=null;row.preview=null;}
function close(){if(!busy.value)emit('close');}
function scopeChanged(){alive=false;emit('close');}
onMounted(load);window.addEventListener('erp:auth-scope-changed',scopeChanged);onBeforeUnmount(()=>{alive=false;window.removeEventListener('erp:auth-scope-changed',scopeChanged);});
</script>
<template>
 <el-dialog :model-value="true" title="批量补采购记录" width="1240px" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @update:model-value="close">
  <div class="batch-toolbar"><span>按订单日期分组 · 已完成 {{success}} / {{rows.length}} 项</span><el-button class="erp-btn erp-btn-secondary" :disabled="busy||loading" @click="load">重新读取记录</el-button></div>
  <el-table :data="rows" v-loading="loading" max-height="500" class="erp-data-table">
   <el-table-column label="库存商品" min-width="190"><template #default="{row}">{{row.name}}<small>{{row.inventory_number||row.product_id}}</small></template></el-table-column>
   <el-table-column label="已发 / 缺采购" width="115"><template #default="{row}">{{row.ledger?.shipped_quantity??'—'}} / {{row.missing_quantity??'—'}}</template></el-table-column>
   <el-table-column label="补录数量" width="100"><template #default="{row}"><el-input v-model="row.quantity" @input="syncAmount(row)" type="number" min="1" step="1" :disabled="busy||!!row.payload||row.status==='success'"/></template></el-table-column>
   <el-table-column label="均价（元）" width="115"><template #default="{row}"><el-tooltip :content="row.average?`历史货款 ${row.average.amount} 元 ÷ ${row.average.quantity} 件，不含运费；可修改`:'无有效历史价格，请填写单价或总货款'"><el-input v-model="row.unit_cost" type="number" min="0" @input="priceChanged(row)" :disabled="busy||!!row.payload||row.status==='success'"/></el-tooltip></template></el-table-column>
   <el-table-column label="总货款（元）" width="115"><template #default="{row}"><el-input v-model="row.amount" @input="row.amount_manual=true" type="number" min="0" :disabled="busy||!!row.payload||row.status==='success'"/></template></el-table-column>
   <el-table-column label="运费（元）" width="100"><template #default="{row}"><el-input v-model="row.shipping_amount" type="number" min="0" :disabled="busy||!!row.payload||row.status==='success'"/></template></el-table-column>
   <el-table-column label="采购日期" width="160"><template #default="{row}"><el-input v-model="row.purchased_at" type="date" readonly :disabled="busy||!!row.payload||row.status==='success'"/></template></el-table-column>
   <el-table-column label="影响 / 结果" min-width="220"><template #default="{row}"><span v-if="row.status==='success'">已补录</span><span v-else-if="row.status==='saving'">提交中</span><span v-else-if="row.error" class="batch-error">{{row.error}}</span><template v-else-if="row.preview"><div>补录 {{row.quantity}} 件 · 本地账面 {{row.preview.local_before}} → {{row.preview.local_after}}</div><el-tooltip :content="(row.preview.allocations||[]).map(a=>`${a.posting_number}：${a.quantity}件`).join('；')"><span>关联 {{row.preview.allocations?.length||0}} 条订单</span></el-tooltip><el-button size="small" :disabled="busy" @click="edit(row)">修改</el-button></template><span v-else>{{validation(row)||'待预览'}}</span></template></el-table-column>
  </el-table>
  <template #footer><el-button :disabled="busy" @click="close">关闭</el-button><el-button :loading="busy" :disabled="loading||!valid||ready" @click="preview">预览补录影响</el-button><el-button type="primary" :loading="busy" :disabled="loading||!ready||success===rows.length" @click="submit">确认补录（{{rows.length-success}}项）</el-button></template>
 </el-dialog>
</template>
<style scoped>.batch-toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}small{display:block;color:var(--el-text-color-secondary)}.batch-error{color:var(--el-color-danger)}</style>
