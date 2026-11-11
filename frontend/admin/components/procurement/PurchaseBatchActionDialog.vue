<script setup>
import {computed,defineAsyncComponent,onBeforeUnmount,reactive,ref,watch} from 'vue';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
import {runPurchaseBatchGroups} from '../../utils/purchase-batch-workers.js';
import PurchaseQuantityDifference from './PurchaseQuantityDifference.vue';
const BatchCorrection=defineAsyncComponent(()=>import('./PurchaseBatchCorrectionDialog.vue'));
const correction=reactive({visible:false,row:null}),correcting=ref(false);
const canCorrect=computed(()=>hasPermission(auth.user,'procurement'));
const Ledger=defineAsyncComponent(()=>import('./ProcurementLedgerDialog.vue'));
const counting=ref(0),auth=useAuthStore(),canCount=computed(()=>hasPermission(auth.user,'inventory.write'));
const props=defineProps({modelValue:Boolean,status:String,rows:{type:Array,default:()=>[]}}),emit=defineEmits(['update:modelValue','changed','correct']);
const visible=computed({get:()=>props.modelValue,set:v=>emit('update:modelValue',v)}),entries=ref([]),groups=ref([]),note=ref(''),busy=ref(false),error=ref(''),previewed=ref(false),attempted=ref(false);
const checked=ref(0),processed=ref(0);
const arriving=computed(()=>props.status==='open'),done=computed(()=>groups.value.filter(g=>g.state==='done').length),finished=computed(()=>groups.value.length>0&&done.value===groups.value.length);
let version=0,disposed=false,scope='';
const current=token=>!disposed&&token===version&&scope===currentApiCacheScope()&&visible.value;
const unit=row=>row.is_bundle?'套':row.components?.[0]?.stock_unit||'件';
const arrivalNote=row=>[note.value.trim(),row.actual!==Number(row.quantity)?`分批到货，本次 ${row.actual} 件，剩余 ${Number(row.quantity)-row.actual} 件继续待到货`:'',row.reason.trim()].filter(Boolean).join('；');
const arrivalQuantity=group=>Number(group.result?.quantity??group.rows.reduce((sum,row)=>sum+Number(row.actual),0));
const arrivalRemaining=group=>Number(group.result?.remaining_quantity??group.rows.reduce((sum,row)=>sum+Number(row.quantity)-Number(row.actual),0));
function load(){
 ++version;checked.value=0;processed.value=0;scope=currentApiCacheScope();entries.value=props.rows.map(row=>({...row,actual:Number(row.quantity),reason:'',difference_kind:arriving.value?'partial':''}));groups.value=[];note.value='';counting.value=0;error.value='';previewed.value=false;attempted.value=false;
 if(!entries.value.length||entries.value.some(r=>r.review_required||r.composition_error)){error.value='请选择已核对采购内容的有效批次';return;}

 rebuildGroups();
}
function rebuildGroups(){
 if(arriving.value){groups.value=entries.value.map(row=>({key:crypto.randomUUID(),name:row.order_no||`采购批次 #${row.id}`,rows:[row],state:'pending',error:''}));return;}
 const byProduct=new Map();for(const row of entries.value){const id=Number(row.product_id);if(!byProduct.has(id))byProduct.set(id,{product_id:id,name:row.product_name||`库存 #${id}`,rows:[],key:crypto.randomUUID(),state:'pending',error:'',preview:null,body:null});byProduct.get(id).rows.push(row);}
 groups.value=[...byProduct.values()];
 // The preview endpoint rechecks ownership and current remaining quantities for every selected batch.
}

function correctRow(row){if(busy.value||correcting.value||attempted.value)return;correction.row=row;correction.visible=true;}
async function corrected(){
 const token=version,row=correction.row;correcting.value=true;error.value='';
 try{const data=await apiClient.get(`/api/procurement/ledger?product_id=${row.product_id}&include_fbp=0`,{noCache:true});if(!current(token))return;
 const updated=data.batches?.find(batch=>Number(batch.id)===Number(row.id));
 if(!updated||updated.status!=='pending_arrival')throw Error('该批次已关闭，请刷新后重新选择');
 Object.assign(row,{quantity:Number(updated.quantity),updated_at:updated.updated_at,amount:updated.amount,shipping_amount:updated.shipping_amount});
 row.actual=Math.min(row.actual,Number(updated.quantity));row.difference_kind='';row.reason='';previewed.value=false;rebuildGroups();emit('changed');
 }catch(e){if(current(token))error.value=`采购更正已保存，但批次刷新失败：${e.message}；请关闭后刷新列表再入库`;}finally{if(token===version)correcting.value=false;}
}
async function preview(){
 if(busy.value||correcting.value||error.value||correction.visible)return;
 if(entries.value.some(r=>!Number.isSafeInteger(r.actual)||r.actual<1||r.actual>Number(r.quantity))){error.value='实收数量须为正整数；超过原登记数时，请先点击该行“更正采购记录”，保存后继续入库';return;}
 if(entries.value.some(r=>r.actual!==Number(r.quantity)&&r.difference_kind!=='partial')){error.value='数量不一致时，请选择保留余量继续待处理；采购总数录错请先更正采购记录';return;}
 if(entries.value.some(r=>r.actual!==Number(r.quantity)&&!r.reason.trim())){error.value='部分入库请填写未收部分的原因';return;}
 const token=version;busy.value=true;checked.value=0;
 try{await runPurchaseBatchGroups(groups.value,async group=>{const body={product_id:group.product_id,receipt_mode:'new_arrival',request_key:group.key,records:group.rows.map(row=>({id:row.id,quantity:row.actual,expected_quantity:Number(row.quantity),reason:row.reason}))};const result=await apiClient.post('/api/inventory-workflow/receipts/preview',body);if(!current(token))return;group.preview=result;group.body={...body,expected_revision:result.revision};checked.value++;},{isCurrent:()=>current(token)});if(current(token))previewed.value=true;}
 catch(e){if(current(token))error.value=e.message;}finally{if(token===version)busy.value=false;}
}
async function submit(){
 if(busy.value||correcting.value||correction.visible||finished.value)return;
 if(arriving.value&&note.value.length>500){error.value='到货说明不能超过500字';return;}
 if(arriving.value&&!attempted.value){
  if(entries.value.some(r=>!Number.isSafeInteger(r.actual)||r.actual<1||r.actual>Number(r.quantity))){error.value='本次到货件数须为正整数且不超过待到货件数；采购数录错请先更正采购记录';return;}
  if(entries.value.some(r=>arrivalNote(r).length>500)){error.value='到货说明与差异原因合计不能超过500字，请简写后重试';return;}
 }
 if(!arriving.value&&!previewed.value)return;
 const token=version;busy.value=true;error.value='';attempted.value=true;processed.value=done.value;let changed=false;
 try{await runPurchaseBatchGroups(groups.value.filter(group=>group.state!=='done'),async group=>{group.error='';group.state='running';try{
  const row=group.rows[0];const body=arriving.value?(group.body||{id:row.id,quantity:row.actual,expected_quantity:Number(row.quantity),note:arrivalNote(row),expected_updated_at:row.updated_at,request_key:group.key}):group.body;group.body=body;
  const result=await apiClient.post(arriving.value?'/api/inventory-workflow/purchase-arrivals':'/api/inventory-workflow/receipts',body);
  if(!current(token))return;group.result=result;group.state='done';changed=true;
 }catch(e){if(!current(token))return;group.state='error';group.error=e.message;}finally{if(current(token))processed.value++;}},{isCurrent:()=>current(token)});
 }finally{if(current(token)&&changed)emit('changed');if(token===version)busy.value=false;}
}
function scopeChanged(){++version;visible.value=false;}
watch(()=>props.modelValue,value=>{if(value)void load();},{immediate:true});window.addEventListener('erp:auth-scope-changed',scopeChanged);
onBeforeUnmount(()=>{disposed=true;++version;window.removeEventListener('erp:auth-scope-changed',scopeChanged);});
</script>
<template>
 <el-dialog v-model="visible" :title="arriving?'批量确认实物到货':'批量登记验收入库'" width="min(1080px,96vw)" append-to-body :show-close="!busy&&!correcting&&!correction.visible" :close-on-click-modal="false" :close-on-press-escape="!busy&&!correcting&&!correction.visible" :before-close="done=>{if(!busy&&!correcting&&!correction.visible)done();}">
  <section class="purchase-batch-action">
   <el-alert :title="arriving?'确认已拿到实物后再登记。默认本批次全部到货；填少时自动保留余量继续待到货，无需另选原因。本地库存暂不增加。':'只填写本次验收合格的实收数量；余量保持原状态，已到货继续待验收、未到货继续待到货。采购总数录错请先按凭证更正采购记录。'" type="info" :closable="false"/>
   <el-alert v-if="error" :title="error" type="warning" :closable="false"/>
   <div v-if="busy" role="status" aria-live="polite"><p>{{attempted?`已处理 ${processed} / ${groups.length} 项，成功 ${done} 项`:`正在核对入库影响 ${checked} / ${groups.length} 项`}}</p><el-progress :percentage="Math.round((attempted?processed:checked)/Math.max(1,groups.length)*100)"/></div>
   <template v-if="!previewed&&!attempted">
    <el-table :data="entries" row-key="id" max-height="420" border>
     <el-table-column label="库存商品" min-width="240"><template #default="{row}"><b>{{row.product_name}}</b><p>库存 ID：{{row.inventory_number||row.product_id}}</p></template></el-table-column>
     <el-table-column label="采购批次" min-width="170"><template #default="{row}">{{row.order_no||'采购批次'}} · #{{row.id}}</template></el-table-column>
     <el-table-column label="待收数量" width="110"><template #default="{row}">{{row.quantity}} {{unit(row)}}</template></el-table-column>
     <el-table-column :label="arriving?'本次到货':'本次合格实收'" width="160"><template #default="{row}"><el-input-number v-model="row.actual" :min="1" :max="1000000" :disabled="busy||correcting||correction.visible" :aria-label="`批次 ${row.id} ${arriving?'到货数量':'实收数量'}`" controls-position="right" @change="error=''"/></template></el-table-column>
     <el-table-column label="数量差异处理" min-width="290"><template #default="{row}"><small v-if="row.actual>Number(row.quantity)">实收超过原登记 {{row.actual-Number(row.quantity)}} 件，请先更正采购记录。</small><PurchaseQuantityDifference v-else-if="arriving||row.actual!==Number(row.quantity)" :row="row" :arrival="arriving" :disabled="busy||correcting||correction.visible" :allow-correction="canCorrect" @correct="correctRow" @change="error=''"/><span v-else>全部验收合格</span><el-button v-if="canCorrect" plain size="small" :disabled="busy||correcting||correction.visible" @click="correctRow(row)">更正采购记录</el-button><small v-else-if="row.actual>Number(row.quantity)">请采购人员更正原记录后再入库。</small></template></el-table-column>
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
     <el-table-column label="处理状态" min-width="270"><template #default="{row}"><el-tag :type="row.state==='done'?'success':row.state==='error'?'danger':'info'">{{row.state==='done'?'已完成':row.state==='error'?'未完成':row.state==='running'?'处理中':'待确认'}}</el-tag><p v-if="row.error">{{row.error}}；如提示批次已变化，请关闭后刷新核对。</p><el-button v-if="!arriving&&canCount&&row.state==='done'" link type="primary" @click="counting=row.product_id">核对库存</el-button></template></el-table-column>
    </el-table>
   </template>
  </section>
  <template #footer><span class="batch-action-count">已选 {{entries.length}} 个采购批次</span><el-button :disabled="busy||correcting||correction.visible" @click="visible=false">{{attempted?'关闭':'取消'}}</el-button><el-button v-if="previewed&&!attempted" :disabled="busy" @click="previewed=false;error=''">返回修改</el-button><el-button v-if="!finished" type="primary" :loading="busy" :disabled="!entries.length||correcting||correction.visible||(!attempted&&!!error)" @click="arriving||previewed?submit():preview()">{{attempted?'重试未完成项':arriving?'确认批量到货':previewed?'确认批量入库':'核对数量，查看入库影响'}}</el-button></template>
  <BatchCorrection v-if="correction.visible" v-model="correction.visible" :product-id="Number(correction.row.product_id)" :inbound-id="Number(correction.row.id)" :allow-arrived="!arriving" :initial-quantity="correction.row.actual" @saved="corrected"/>
  <Ledger v-if="counting" :model-value="true" :product-id="counting" initial-action="stocktake" :stocktake-enabled="canCount" @update:model-value="value=>{if(!value)counting=0;}"/>
 </el-dialog>
</template>
<style scoped>
.purchase-batch-action{display:grid;gap:16px}.purchase-batch-action .el-input-number{width:135px}.purchase-batch-action p{margin:8px 0;line-height:1.5}.purchase-batch-action small{display:block;color:var(--el-color-warning);margin-top:6px}.batch-action-count{margin-right:16px;color:var(--el-text-color-secondary)}
</style>
