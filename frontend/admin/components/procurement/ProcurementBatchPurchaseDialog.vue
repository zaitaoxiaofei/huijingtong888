<script setup>
import {computed,defineAsyncComponent,onBeforeUnmount,onMounted,reactive,ref,watch} from 'vue';
import {ElMessage,ElMessageBox} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import ProductImagePreview from '../ProductImagePreview.vue';
const Ledger=defineAsyncComponent(()=>import('./ProcurementLedgerDialog.vue'));
const props=defineProps({modelValue:Boolean,initialRows:{type:Array,default:()=>[]}}),emit=defineEmits(['update:modelValue','created']);
const auth=useAuthStore(),items=ref([]),people=ref([]),results=ref([]),query=ref(''),searchMode=ref('auto'),searching=ref(false),loading=ref(false),busy=ref(false),submitted=ref(null),requestKey=ref('');
const form=reactive({person_id:null,source_type:'1688',note:''}),detail=reactive({visible:false,id:0});
const amount=computed(()=>items.value.reduce((n,r)=>n+Number(r.amount||0)+Number(r.shipping_amount||0),0).toFixed(2));
let generation=0,disposed=false,searchVersion=0;
const visible=computed({get:()=>props.modelValue,set:v=>emit('update:modelValue',v)});
function add(row){const id=Number(row.product_id||row.id);if(!id||items.value.some(i=>i.product_id===id))return ElMessage.info('该库存已在采购表中');if(items.value.length>=100)return ElMessage.warning('一次最多登记100项库存');const p=row.workflow?.supply_plan;items.value.push({product_id:id,name:row.product_name||row.name,number:row.inventory_number||row.code,quantity:Math.max(1,Number(p?.required_purchase||0)+Number(p?.optional_purchase||0)),amount:0,shipping_amount:0,purchase_url:row.purchase_url||'',note:row.workflow?.purchase_partial?'仅采购已确认FBS缺口；历史账面差异另核对':'',purchase_mode:'shortage_purchase'});}
async function search(){const token=++searchVersion,scope=currentApiCacheScope();searching.value=true;try{const r=await apiClient.get(`/api/products?${new URLSearchParams({paged:'1',page:'1',pageSize:'20',query:query.value,searchMode:searchMode.value})}`,{noCache:true});if(!disposed&&token===searchVersion&&scope===currentApiCacheScope())results.value=r.rows||[];}catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{if(token===searchVersion)searching.value=false;}}
async function close(done){if(busy.value||detail.visible)return;if(items.value.length){try{await ElMessageBox.confirm('关闭会放弃本次尚未登记的采购表。查看库存详情后可直接关闭详情返回，无需关闭采购表。','关闭批量采购',{confirmButtonText:'放弃并关闭',cancelButtonText:'继续填写'});}catch{return;}}done();}
function clearScope(){++generation;++searchVersion;items.value=[];results.value=[];submitted.value=null;detail.visible=false;emit('update:modelValue',false);}
async function submit(){
 if(busy.value)return;
 if(!submitted.value){
  if(!form.person_id||!items.value.length)return ElMessage.warning('请选择采购人并至少保留一项库存');
  const bad=items.value.find(r=>!Number.isSafeInteger(Number(r.quantity))||Number(r.quantity)<1||!(Number(r.amount)>0)||!Number.isFinite(Number(r.amount))||Number(r.shipping_amount)<0||!Number.isFinite(Number(r.shipping_amount)));
  if(bad)return ElMessage.warning(`请完整填写「${bad.name}」的实际采购数量、货款和非负运费`);
  submitted.value={workspace_batch:true,request_key:requestKey.value,person_id:Number(form.person_id),source_type:form.source_type,note:form.note,items:items.value.map(({product_id,quantity,amount,shipping_amount,purchase_url,note,purchase_mode})=>({product_id,quantity:Number(quantity),actual_quantity:Number(quantity),amount:Number(amount),shipping_amount:Number(shipping_amount),purchase_url,note,purchase_mode}))};
 }
 const scope=currentApiCacheScope(),token=generation;busy.value=true;
 try{const result=await apiClient.post('/api/procurement/purchases',submitted.value);if(disposed||token!==generation||scope!==currentApiCacheScope())return;ElMessage.success(`已登记 ${items.value.length} 项采购，进入采购在途`);emit('created',{...result,product_ids:items.value.map(r=>r.product_id)});emit('update:modelValue',false);}
 catch(e){if([400,403,404,409].includes(e.status))submitted.value=null;if(scope===currentApiCacheScope()&&token===generation)ElMessage.error(`${e.message}。采购表已保留；重试将使用同一提交标识，避免重复登记`);}
 finally{if(token===generation)busy.value=false;}
}
watch(()=>props.modelValue,async value=>{if(!value)return;const token=++generation,scope=currentApiCacheScope();items.value=[];results.value=[];query.value='';submitted.value=null;requestKey.value=crypto.randomUUID();form.person_id=Number(auth.user?.personId||auth.user?.id)||null;form.source_type='1688';form.note='';props.initialRows.forEach(add);loading.value=true;try{const r=await apiClient.get('/api/people');if(token===generation&&scope===currentApiCacheScope()&&!disposed)people.value=(Array.isArray(r)?r:r.rows||[]).filter(p=>Number(p.active)!==0);}catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{if(token===generation)loading.value=false;}},{immediate:true});
onMounted(()=>window.addEventListener('erp:auth-scope-changed',clearScope));onBeforeUnmount(()=>{disposed=true;++generation;++searchVersion;window.removeEventListener('erp:auth-scope-changed',clearScope);});
</script>
<template>
 <el-dialog v-model="visible" title="批量登记采购" width="min(1400px,96vw)" append-to-body :before-close="close" :close-on-click-modal="false" :close-on-press-escape="false" :show-close="!busy">
  <div v-loading="loading" class="batch-purchase"><el-alert title="仅登记已经完成下单的真实采购。各库存分别生成明细和在途批次；验收入库后才增加本地实物。" type="info" :closable="false"/>
   <el-form inline :disabled="busy||!!submitted"><el-form-item label="采购人" required><el-select v-model="form.person_id" aria-label="采购人" style="width:170px"><el-option v-for="p in people" :key="p.id" :value="Number(p.id)" :label="p.name"/></el-select></el-form-item><el-form-item label="采购平台"><el-select v-model="form.source_type" style="width:130px"><el-option v-for="v in ['1688','pdd','taobao','other']" :key="v" :value="v" :label="({pdd:'拼多多',taobao:'淘宝',other:'其他'})[v]||v"/></el-select></el-form-item><el-form-item label="采购备注"><el-input v-model="form.note" maxlength="500"/></el-form-item></el-form>
   <div v-if="!submitted" class="batch-add"><el-select v-model="searchMode" aria-label="添加库存搜索方式"><el-option label="综合搜索" value="auto"/><el-option label="库存编号精确" value="inventory_id"/><el-option label="SKU／货号精确" value="sku"/></el-select><el-input v-model="query" placeholder="搜索库存编号 / SKU / 名称，加入本次采购" @keyup.enter="search" clearable/><el-button :loading="searching" @click="search">搜索库存</el-button></div>
   <div v-if="results.length&&!submitted" class="batch-results"><div v-for="p in results" :key="p.id"><span>{{p.inventory_number||p.code||p.id}} · {{p.name}}</span><el-button size="small" :disabled="items.some(i=>i.product_id===Number(p.id))" @click="add(p)">加入采购</el-button></div></div>
   <el-table :data="items" row-key="product_id" border aria-label="批量采购明细" empty-text="请选择或搜索库存加入采购表">
    <el-table-column label="库存商品" min-width="290"><template #default="{row}"><div class="batch-product"><ProductImagePreview :src="`/api/products/${row.product_id}/image?thumb=1`" :preview-list="[`/api/products/${row.product_id}/image`]" size="portrait"/><div><b>{{row.name}}</b><small>库存 ID：{{row.number||row.product_id}}</small><el-button plain size="small" :disabled="busy" @click="Object.assign(detail,{visible:true,id:row.product_id})">库存详情</el-button></div></div></template></el-table-column>
    <el-table-column label="采购件数" width="160"><template #default="{row}"><el-input-number v-model="row.quantity" :min="1" :max="1000000" :precision="0" :disabled="busy||!!submitted" :aria-label="row.name+'采购件数'" style="width:135px"/></template></el-table-column>
    <el-table-column label="实际货款（元）" width="165"><template #default="{row}"><el-input-number v-model="row.amount" :min="0" :precision="2" :disabled="busy||!!submitted" :aria-label="row.name+'实际货款'" style="width:140px"/></template></el-table-column>
    <el-table-column label="运费（元）" width="150"><template #default="{row}"><el-input-number v-model="row.shipping_amount" :min="0" :precision="2" :disabled="busy||!!submitted" style="width:125px"/></template></el-table-column>
    <el-table-column label="采购链接 / 备注" min-width="210"><template #default="{row}"><el-input v-model="row.purchase_url" placeholder="采购链接（选填）" :disabled="busy||!!submitted"/><el-input v-model="row.note" placeholder="本项备注（选填）" :disabled="busy||!!submitted"/></template></el-table-column>
    <el-table-column label="操作" width="85"><template #default="{row}"><el-button type="danger" plain size="small" :disabled="busy||!!submitted" @click="items=items.filter(i=>i!==row)">移除</el-button></template></el-table-column>
   </el-table>
   <el-alert v-if="submitted" type="warning" :closable="false" title="已发起登记，内容暂时锁定。若响应中断，请直接重试；系统会核对原提交，避免重复采购。"/>
  </div>
  <template #footer><span class="batch-total">{{items.length}} 项库存 · 合计 {{amount}} 元</span><el-button :disabled="busy||detail.visible" @click="close(()=>visible=false)">取消</el-button><el-button type="primary" :loading="busy" :disabled="!items.length||loading||detail.visible" @click="submit">{{submitted?'重试原采购登记':'确认批量登记采购'}}</el-button></template>
  <Ledger v-if="detail.visible" v-model="detail.visible" :product-id="detail.id" :allow-full-page="false"/>
 </el-dialog>
</template>
<style scoped>
.batch-purchase{display:grid;gap:14px;min-width:0}.batch-add{display:flex;gap:8px}.batch-add>.el-select{width:160px;flex:none}.batch-add>.el-input{max-width:420px}.batch-product{display:flex;gap:12px;align-items:center;min-height:92px}.batch-product>div{display:grid;gap:7px}.batch-product small{color:var(--el-text-color-secondary)}.batch-product .el-button{justify-self:start;margin:0}.batch-results{display:grid;gap:8px;max-height:220px;overflow:auto}.batch-results>div{display:flex;gap:12px;align-items:center;justify-content:space-between}.batch-total{margin-right:20px}.batch-purchase :deep(.el-table .el-input+.el-input){margin-top:7px}@media(max-width:600px){.batch-add{flex-wrap:wrap}}
</style>
