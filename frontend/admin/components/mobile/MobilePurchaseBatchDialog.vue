<script setup>
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import MobileDialog from './MobileDialog.vue';
import MobileEvidencePicker from './MobileEvidencePicker.vue';
import PurchaseQuantityDifference from '../procurement/PurchaseQuantityDifference.vue';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
import {runPurchaseBatchGroups} from '../../utils/purchase-batch-workers.js';

const props=defineProps({modelValue:Boolean,status:String,rows:{type:Array,default:()=>[]}}),emit=defineEmits(['update:modelValue','changed']);
const auth=useAuthStore(),entries=ref([]),groups=ref([]),busy=ref(false),error=ref(''),previewed=ref(false),attempted=ref(false),note=ref('');
const visible=computed({get:()=>props.modelValue,set:value=>emit('update:modelValue',value)}),arriving=computed(()=>props.status==='open');
const allowed=computed(()=>hasPermission(auth.user,'procurement')||!arriving.value&&hasPermission(auth.user,'packing'));
const photosReady=computed(()=>entries.value.every(row=>row.photoState.ready&&!row.photoState.busy));
const done=computed(()=>groups.value.filter(group=>group.state==='done').length),finished=computed(()=>groups.value.length>0&&done.value===groups.value.length);
let version=0,disposed=false,scope='';
const current=token=>!disposed&&token===version&&visible.value&&scope===currentApiCacheScope();
const unit=row=>row.is_bundle?'套':row.components?.[0]?.stock_unit||'件';
const remaining=group=>Number(group.result?.remaining_quantity??group.rows.reduce((sum,row)=>sum+Number(row.quantity)-row.actual,0));
const received=group=>Number(group.result?.quantity??group.preview?.quantity??group.rows.reduce((sum,row)=>sum+row.actual,0));
const arrivalNote=row=>[note.value.trim(),row.actual!==Number(row.quantity)?`分批到货，本次 ${row.actual} 件，剩余 ${Number(row.quantity)-row.actual} 件继续待到货`:'',row.reason.trim()].filter(Boolean).join('；');
function load(){
 ++version;scope=currentApiCacheScope();busy.value=false;error.value='';previewed.value=false;attempted.value=false;note.value='';
 entries.value=props.rows.map(row=>({...row,actual:Number(row.quantity),reason:'',difference_kind:arriving.value?'partial':'',photos:[],photoState:{busy:false,ready:true}}));
 groups.value=[];
 if(!allowed.value){error.value='当前岗位无权处理这些采购批次';return;}
 if(!entries.value.length||entries.value.some(row=>row.review_required||row.composition_error||!Number(row.id)||!Number(row.product_id)||!arriving.value&&!row.received_at)){error.value='请选择已核对采购内容的有效批次；入库前须先确认到货';return;}
 const indexed=new Map();
 for(const row of entries.value){const id=Number(row.product_id),index=arriving.value?Number(row.id):id;if(!indexed.has(index))indexed.set(index,{product_id:id,key:crypto.randomUUID(),name:arriving.value?(row.order_no||`采购批次 #${row.id}`):row.product_name,rows:[],state:'pending',error:'',body:null,preview:null,result:null});indexed.get(index).rows.push(row);}
 groups.value=[...indexed.values()];
}
function validate(){
 if(!allowed.value){error.value='当前岗位无权处理这些采购批次';return false;}
 if(entries.value.some(row=>!Number.isSafeInteger(row.actual)||row.actual<1||row.actual>Number(row.quantity))){error.value='本次数量须为正整数且不超过待处理数量；采购总数录错请先联系采购更正原记录';return false;}
 if(!arriving.value){
  if(!photosReady.value){error.value='请等待照片上传完成，失败的照片请重试或移除';return false;}
  if(entries.value.some(row=>row.actual!==Number(row.quantity)&&row.difference_kind!=='partial')){error.value='部分入库请选择分批到货保留余量；采购总数录错请先更正原记录';return false;}
  if(entries.value.some(row=>row.actual!==Number(row.quantity)&&!row.reason.trim())){error.value='部分入库请填写未收部分的原因';return false;}
 }else if(entries.value.some(row=>arrivalNote(row).length>500)){error.value='到货说明合计不能超过500字，请简写后重试';return false;}
 return true;
}
async function preview(){
 if(busy.value||attempted.value||!validate())return;
 const token=version;busy.value=true;error.value='';
 try{
  await runPurchaseBatchGroups(groups.value,async group=>{
   const body={product_id:group.product_id,receipt_mode:'new_arrival',request_key:group.key,records:group.rows.map(row=>({id:Number(row.id),quantity:row.actual,expected_quantity:Number(row.quantity),reason:row.reason.trim(),...(row.photos.length?{receipt_images_json:[...row.photos]}:{})}))};
   const result=await apiClient.post('/api/inventory-workflow/receipts/preview',body);if(!current(token))return;group.preview=result;group.body={...body,expected_revision:result.revision};
  },{isCurrent:()=>current(token)});
  if(current(token))previewed.value=true;
 }catch(e){if(current(token))error.value=e.message;}finally{if(token===version)busy.value=false;}
}
async function submit(){
 if(busy.value||finished.value||!allowed.value||!groups.value.length)return;
 if(!attempted.value&&!validate()||!arriving.value&&!previewed.value)return;
 const token=version;busy.value=true;error.value='';attempted.value=true;let changed=false;
 try{await runPurchaseBatchGroups(groups.value.filter(group=>group.state!=='done'),async group=>{
  group.state='running';group.error='';
  try{const row=group.rows[0];group.body||={id:Number(row.id),quantity:row.actual,expected_quantity:Number(row.quantity),expected_updated_at:row.updated_at,note:arrivalNote(row),request_key:group.key};
   const result=await apiClient.post(arriving.value?'/api/inventory-workflow/purchase-arrivals':'/api/inventory-workflow/receipts',group.body);if(!current(token))return;group.result=result;group.state='done';changed=true;
  }catch(e){if(current(token)){group.state='error';group.error=e.message;}}
 },{isCurrent:()=>current(token)});}finally{if(current(token)&&changed)emit('changed');if(token===version)busy.value=false;}
}
function scopeChanged(){++version;visible.value=false;}
watch(()=>props.modelValue,value=>{if(value)load();},{immediate:true});
window.addEventListener('erp:auth-scope-changed',scopeChanged);
onBeforeUnmount(()=>{disposed=true;++version;window.removeEventListener('erp:auth-scope-changed',scopeChanged);});
</script>
<template>
 <MobileDialog v-model="visible" :title="arriving?'确认采购到货':'批量验收入库'" :show-close="!busy" :close-on-press-escape="!busy" :before-close="done=>{if(!busy)done();}">
  <section class="mobile-batch-form mobile-form">
   <p class="mobile-muted">{{arriving?'默认全部到货；填少时余量继续待到货，仅通知仓库，不增加本地实物。到货说明选填。':'仅合格实收计入库存。部分入库须选择分批到货并说明原因，未收余量继续采购待到货。'}}</p>
   <el-alert v-if="error" :title="error" type="warning" :closable="false"/>
   <template v-if="!previewed&&!attempted">
    <article v-for="row in entries" :key="row.id" class="mobile-record">
     <h3>{{row.product_name}}</h3><small>{{row.order_no||'采购批次'}} · #{{row.id}} · 待处理 {{row.quantity}} {{unit(row)}}</small>
     <label>{{arriving?'本次到货':'本次合格实收'}}<el-input-number v-model="row.actual" :min="1" :max="Number(row.quantity)" :disabled="busy||!!error&&groups.length===0" :aria-label="`批次 ${row.id} ${arriving?'到货数量':'实收数量'}`" @change="error=''"/></label>
     <PurchaseQuantityDifference v-if="arriving||row.actual!==Number(row.quantity)" :row="row" :arrival="arriving" :disabled="busy" :allow-correction="false" @change="error=''"/>
     <MobileEvidencePicker v-if="!arriving" v-model="row.photos" :disabled="busy" :label="`批次 ${row.id} 入库照片`" @state="row.photoState=$event;error=''"/>
    </article>
    <el-input v-if="arriving" v-model="note" type="textarea" maxlength="500" placeholder="到货位置或签收说明（选填）" :disabled="busy" @input="error=''"/>
   </template>
   <template v-else>
    <p role="status">{{attempted?`已完成 ${done} / ${groups.length} 项；失败项保留，重试不重复提交已完成项。`:'请核对本次入库影响后确认。'}}</p>
    <article v-for="group in groups" :key="group.key" class="mobile-record">
     <h3>{{group.name}}</h3><small v-for="row in group.rows" :key="row.id">批次 #{{row.id}} · 本次 {{row.actual}} {{unit(row)}}</small>
     <p v-if="!arriving">账面库存 {{group.preview?.physical_before}} → {{group.preview?.physical_after}} · 本次合格实收 {{group.preview?.quantity}} 件</p>
     <template v-if="group.state==='done'"><strong>{{arriving?'已到货待验收':'已验收入库'}} {{received(group)}} 件</strong><small>剩余 {{remaining(group)}} 件{{remaining(group)?'继续采购待到货':'，本批次已处理完成'}}</small></template>
     <el-tag :type="group.state==='done'?'success':group.state==='error'?'danger':'info'">{{group.state==='done'?'已完成':group.state==='error'?'未完成':group.state==='running'?'处理中':'待确认'}}</el-tag><p v-if="group.error" role="alert">{{group.error}}；批次已变化时请关闭后刷新核对。</p>
    </article>
   </template>
  </section>
  <template #footer><el-button :disabled="busy" @click="visible=false">{{attempted?'关闭':'取消'}}</el-button><el-button v-if="previewed&&!attempted" :disabled="busy" @click="previewed=false;error=''">返回修改</el-button><el-button v-if="!finished" type="primary" :loading="busy" :disabled="!groups.length||!allowed||(!arriving&&!photosReady)" @click="arriving||previewed?submit():preview()">{{attempted?'重试未完成项':arriving?'确认到货':previewed?'确认入库':'核对数量，查看影响'}}</el-button></template>
 </MobileDialog>
</template>
<style scoped>
.mobile-batch-form{min-width:0}.mobile-batch-form p{margin:0;line-height:1.6}.mobile-batch-form .mobile-record>p{overflow-wrap:anywhere}.mobile-batch-form .el-tag{justify-self:start}
</style>
