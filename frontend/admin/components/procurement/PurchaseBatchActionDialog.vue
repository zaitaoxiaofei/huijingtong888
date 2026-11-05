<script setup>
import {computed,defineAsyncComponent,onBeforeUnmount,ref,watch} from 'vue';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
import PurchaseQuantityDifference from './PurchaseQuantityDifference.vue';
const Ledger=defineAsyncComponent(()=>import('./ProcurementLedgerDialog.vue'));
const counting=ref(0),auth=useAuthStore(),canCount=computed(()=>hasPermission(auth.user,'inventory.write'));
const props=defineProps({modelValue:Boolean,status:String,rows:{type:Array,default:()=>[]}}),emit=defineEmits(['update:modelValue','changed','correct']);
const visible=computed({get:()=>props.modelValue,set:v=>emit('update:modelValue',v)}),entries=ref([]),groups=ref([]),note=ref(''),busy=ref(false),error=ref(''),previewed=ref(false),attempted=ref(false);
const arriving=computed(()=>props.status==='open'),done=computed(()=>groups.value.filter(g=>g.state==='done').length),finished=computed(()=>groups.value.length>0&&done.value===groups.value.length);
let version=0,disposed=false,scope='';
const current=token=>!disposed&&token===version&&scope===currentApiCacheScope()&&visible.value;
const unit=row=>row.is_bundle?'套':row.components?.[0]?.stock_unit||'件';
const arrivalNote=row=>[note.value.trim(),row.actual!==Number(row.quantity)?`分批到货，本次 ${row.actual} 件，剩余 ${Number(row.quantity)-row.actual} 件继续待到货`:'',row.reason.trim()].filter(Boolean).join('；');
const arrivalQuantity=group=>Number(group.result?.quantity??group.rows.reduce((sum,row)=>sum+Number(row.actual),0));
const arrivalRemaining=group=>Number(group.result?.remaining_quantity??group.rows.reduce((sum,row)=>sum+Number(row.quantity)-Number(row.actual),0));
function load(){
 ++version;scope=currentApiCacheScope();entries.value=props.rows.map(row=>({...row,actual:Number(row.quantity),reason:'',difference_kind:arriving.value?'partial':''}));groups.value=[];note.value='';counting.value=0;error.value='';previewed.value=false;attempted.value=false;
 if(!entries.value.length||entries.value.some(r=>r.review_required||r.composition_error)){error.value='请选择已核对采购内容的有效批次';return;}
 if(arriving.value){groups.value=entries.value.map(row=>({key:crypto.randomUUID(),name:row.order_no||`采购批次 #${row.id}`,rows:[row],state:'pending',error:''}));return;}
 const byProduct=new Map();for(const row of entries.value){const id=Number(row.product_id);if(!byProduct.has(id))byProduct.set(id,{product_id:id,name:row.product_name||`库存 #${id}`,rows:[],key:crypto.randomUUID(),state:'pending',error:'',preview:null,body:null});byProduct.get(id).rows.push(row);}
 groups.value=[...byProduct.values()];
 // The preview endpoint rechecks ownership and current remaining quantities for every selected batch.
}
async function preview(){
 if(busy.value||error.value)return;
 if(entries.value.some(r=>!Number.isSafeInteger(r.actual)||r.actual<1||r.actual>Number(r.quantity))){error.value='实收数量须为正整数且不超过待收数量，请修改后重试';return;}
 if(entries.value.some(r=>r.actual!==Number(r.quantity)&&r.difference_kind!=='partial')){error.value='数量不一致时，请选择分批到货保留余量；采购总数录错请先更正采购记录';return;}
 if(entries.value.some(r=>r.actual!==Number(r.quantity)&&!r.reason.trim())){error.value='部分入库请填写未收部分的原因';return;}
 const token=version;busy.value=true;
 try{for(const group of groups.value){const body={product_id:group.product_id,receipt_mode:'new_arrival',request_key:group.key,records:group.rows.map(row=>({id:row.id,quantity:row.actual,expected_quantity:Number(row.quantity),reason:row.reason}))};const result=await apiClient.post('/api/inventory-workflow/receipts/preview',body);if(!current(token))return;group.preview=result;group.body={...body,expected_revision:result.revision};}if(current(token))previewed.value=true;}
 catch(e){if(current(token))error.value=e.message;}finally{if(token===version)busy.value=false;}
}
async function submit(){
 if(busy.value||finished.value)return;
 if(arriving.value&&note.value.length>500){error.value='到货说明不能超过500字';return;}
 if(arriving.value&&!attempted.value){
  if(entries.value.some(r=>!Number.isSafeInteger(r.actual)||r.actual<1||r.actual>Number(r.quantity))){error.value='本次到货件数须为正整数且不超过待到货件数；采购数录错请先更正采购记录';return;}
  if(entries.value.some(r=>arrivalNote(r).length>500)){error.value='到货说明与差异原因合计不能超过500字，请简写后重试';return;}
 }
 if(!arriving.value&&!previewed.value)return;
 const token=version;busy.value=true;error.value='';attempted.value=true;let changed=false;
 try{for(const group of groups.value){if(!current(token))break;if(group.state==='done')continue;group.error='';try{
  const row=group.rows[0];const body=arriving.value?(group.body||{id:row.id,quantity:row.actual,expected_quantity:Number(row.quantity),note:arrivalNote(row),expected_updated_at:row.updated_at,request_key:group.key}):group.body;group.body=body;
  const result=await apiClient.post(arriving.value?'/api/inventory-workflow/purchase-arrivals':'/api/inventory-workflow/receipts',body);
  if(!current(token))break;group.result=result;group.state='done';changed=true;
 }catch(e){if(!current(token))break;group.state='error';group.error=e.message;}}
 }finally{if(current(token)&&changed)emit('changed');if(token===version)busy.value=false;}
}
function scopeChanged(){++version;visible.value=false;}
watch(()=>props.modelValue,value=>{if(value)void load();},{immediate:true});window.addEventListener('erp:auth-scope-changed',scopeChanged);
onBeforeUnmount(()=>{disposed=true;++version;window.removeEventListener('erp:auth-scope-changed',scopeChanged);});
</script>
<template>
 <el-dialog v-model="visible" :title="arriving?'批量确认采购到货':'批量登记验收入库'" width="min(1080px,96vw)" append-to-body :show-close="!busy" :close-on-click-modal="false" :close-on-press-escape="!busy">
  <section class="purchase-batch-action">
   <el-alert :title="arriving?'默认本批次全部到货；填少时自动保留余量继续待到货，无需另选原因。仅本次到货数量进入待验收，本地库存暂不增加。':'只填写本次验收合格的实收数量，未收部分继续采购待到货；采购总数录错请先按凭证更正采购记录。'" type="info" :closable="false"/>
   <el-alert v-if="error" :title="error" type="warning" :closable="false"/>
   <template v-if="!previewed&&!attempted">
    <el-table :data="entries" row-key="id" max-height="420" border>
     <el-table-column label="库存商品" min-width="240"><template #default="{row}"><b>{{row.product_name}}</b><p>库存 ID：{{row.inventory_number||row.product_id}}</p></template></el-table-column>
     <el-table-column label="采购批次" min-width="170"><template #default="{row}">{{row.order_no||'采购批次'}} · #{{row.id}}</template></el-table-column>
     <el-table-column label="待收数量" width="110"><template #default="{row}">{{row.quantity}} {{unit(row)}}</template></el-table-column>
     <el-table-column :label="arriving?'本次到货':'本次合格实收'" width="160"><template #default="{row}"><el-input-number v-model="row.actual" :min="1" :max="Number(row.quantity)" :disabled="busy" :aria-label="`批次 ${row.id} ${arriving?'到货数量':'实收数量'}`" controls-position="right" @change="error=''"/></template></el-table-column>
     <el-table-column label="数量差异处理" min-width="290"><template #default="{row}"><PurchaseQuantityDifference v-if="arriving||row.actual!==Number(row.quantity)" :row="row" :arrival="arriving" :disabled="busy" :allow-correction="hasPermission(auth.user,'procurement')" @correct="emit('correct',$event)" @change="error=''"/><span v-else>全部验收合格</span></template></el-table-column>
    </el-table>
    <el-input v-if="arriving" v-model="note" type="textarea" maxlength="500" show-word-limit placeholder="到货位置或签收说明（选填）" :disabled="busy" @input="error=''"/>
   </template>
   <template v-else>
    <p>{{attempted?`已完成 ${done} / ${groups.length} 项；不同库存分别提交，失败项保留在下方，不重复提交已完成项。`:'请核对入库影响，然后确认。未收部分继续保留待处理。'}}</p>
    <el-table :data="groups" row-key="key" max-height="420" border>
     <el-table-column prop="name" label="处理对象" min-width="230"/>
     <el-table-column v-if="arriving" label="本次到货" width="140"><template #default="{row}"><template v-if="row.state==='done'"><strong>{{arrivalQuantity(row)}} 件</strong><small>已到货待验收</small></template><span v-else>尚未登记</span></template></el-table-column>
     <el-table-column v-if="arriving" label="剩余待到货" width="160"><template #default="{row}"><template v-if="row.state==='done'"><strong>{{arrivalRemaining(row)}} 件</strong><small>{{arrivalRemaining(row)?'继续采购待到货':'本批次已全部到货'}}</small></template><span v-else>待确认</span></template></el-table-column>
     <el-table-column v-if="!arriving" label="账面库存变化" min-width="180"><template #default="{row}">{{row.preview?.physical_before}} → {{row.preview?.physical_after}}<small v-if="row.preview?.ledger_warning">历史账面存在负数，后续可手动核对库存</small></template></el-table-column>
     <el-table-column v-if="!arriving" label="本次合格实收" width="130"><template #default="{row}">{{row.preview?.quantity}}</template></el-table-column>
     <el-table-column label="处理状态" min-width="270"><template #default="{row}"><el-tag :type="row.state==='done'?'success':row.state==='error'?'danger':'info'">{{row.state==='done'?'已完成':row.state==='error'?'未完成':'待确认'}}</el-tag><p v-if="row.error">{{row.error}}；如提示批次已变化，请关闭后刷新核对。</p><el-button v-if="!arriving&&canCount&&row.state==='done'" link type="primary" @click="counting=row.product_id">核对库存</el-button></template></el-table-column>
    </el-table>
   </template>
  </section>
  <template #footer><span class="batch-action-count">已选 {{entries.length}} 个采购批次</span><el-button :disabled="busy" @click="visible=false">{{attempted?'关闭':'取消'}}</el-button><el-button v-if="previewed&&!attempted" :disabled="busy" @click="previewed=false;error=''">返回修改</el-button><el-button v-if="!finished" type="primary" :loading="busy" :disabled="!entries.length||(!attempted&&!!error)" @click="arriving||previewed?submit():preview()">{{attempted?'重试未完成项':arriving?'确认批量到货':previewed?'确认批量入库':'核对数量，查看入库影响'}}</el-button></template>
  <Ledger v-if="counting" :model-value="true" :product-id="counting" initial-action="stocktake" :stocktake-enabled="canCount" @update:model-value="value=>{if(!value)counting=0;}"/>
 </el-dialog>
</template>
<style scoped>
.purchase-batch-action{display:grid;gap:16px}.purchase-batch-action .el-input-number{width:135px}.purchase-batch-action p{margin:8px 0;line-height:1.5}.purchase-batch-action small{display:block;color:var(--el-color-warning);margin-top:6px}.batch-action-count{margin-right:16px;color:var(--el-text-color-secondary)}
</style>
