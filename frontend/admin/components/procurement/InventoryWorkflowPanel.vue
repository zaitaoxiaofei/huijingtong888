<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiClient, currentApiCacheScope } from '../../utils/api.js';
import { getActivePinia } from 'pinia';
import { useAuthStore } from '../../stores/auth.js';
import { hasPermission } from '../../../../src/shared/permissions.js';
import { INVENTORY_DEMAND_TYPES, inventoryWorkflow } from '../../../../src/shared/inventory-workflow.js';
import ProcurementRequestCreateDialog from './ProcurementRequestCreateDialog.vue';
const props=defineProps({ledger:{type:Object,required:true},orderId:Number,initialAction:String});
const emit=defineEmits(['loaded','saved']);
const auth=getActivePinia()?useAuthStore():{user:null};
const state=ref(null), loading=ref(false), error=ref(''), dialog=ref(''), busy=ref(false), purchaseVisible=ref(false);
const canPurchase=computed(()=>hasPermission(auth.user,'procurement'));
const canReceive=computed(()=>canPurchase.value||hasPermission(auth.user,'packing'));
const canFbp=computed(()=>hasPermission(auth.user,'inventory.write'));
const productId=computed(()=>Number(props.ledger.product?.id));
const current=computed(()=>inventoryWorkflow(props.ledger,{requests:state.value?.requests||[],forecast:state.value?.skus?{skus:state.value.skus}:undefined}));
watch(current,value=>emit('loaded',value),{immediate:true});
const form=reactive({type:'',quantity:1,note:'',requestKey:''}), receiptRows=ref([]), counted=ref(null), fbpRows=ref([]);
let version=0,actionVersion=0,disposed=false;
onBeforeUnmount(()=>{disposed=true;++version;++actionVersion;});
async function reload(fresh=false,full=false){
 const token=++version,id=productId.value,scope=currentApiCacheScope();loading.value=true;error.value='';state.value=null;emit('loaded',null);
 try{const result=await apiClient.get(`/api/inventory-workflow?product_id=${id}${full?'':'&view=requests'}${fresh?'&fresh=1':''}`,{noCache:true});if(!disposed&&token===version&&id===productId.value&&scope===currentApiCacheScope()){state.value=result.rows?.[0]||null;}}
 catch(e){if(!disposed&&token===version&&scope===currentApiCacheScope())error.value=e.message||'需求暂不可用';}
 finally{if(token===version)loading.value=false;}
}
async function open(action,type=''){
 const actionToken=++actionVersion,id=productId.value,scope=currentApiCacheScope();
 const active=()=>!disposed&&actionToken===actionVersion&&id===productId.value&&scope===currentApiCacheScope()&&dialog.value===action;
 form.type=type;form.quantity=Math.max(1,Number(current.value.demands.find(d=>d.key===type)?.purchase_quantity)||1);form.note='';form.requestKey=crypto.randomUUID();
 if(action==='purchase'){if(canPurchase.value&&state.value&&!loading.value)purchaseVisible.value=true;return;}
 dialog.value=action;
 if(action==='receive'){
  counted.value=null;receiptRows.value=[];busy.value=true;
  try{const r=await apiClient.get(`/api/inventory-workflow/receipts?product_id=${id}`,{noCache:true});if(!active())return;receiptRows.value=(r.rows||[]).map(row=>({...row,selected:false,actual:Number(row.quantity),reason:'',note:''}));}catch(e){if(active())ElMessage.error(e.message);}finally{if(active())busy.value=false;}
 }
 if(action==='fbp'){
  fbpRows.value=[];
  if(!state.value?.skus)await reload(true,true);
  if(!active())return;
  fbpRows.value=(state.value?.skus||[]).map(s=>({...s,selected:false,quantity:Math.max(5,Number(s.suggested_qty)||5)})).sort((a,b)=>({爆品:0,潜力品:1,常规品:2,淘汰品:3}[a.category]??4)-({爆品:0,潜力品:1,常规品:2,淘汰品:3}[b.category]??4));
 }
}
async function submitRequest(){
 if(!form.type||!Number.isSafeInteger(form.quantity)||form.quantity<1)return ElMessage.warning('请选择需求类型并填写大于0的整数件数');
 busy.value=true;
 try{await apiClient.post('/api/inventory-workflow/requests',{product_id:productId.value,demand_type:form.type,quantity:form.quantity,note:form.note,order_id:form.type==='real_order'?props.orderId||undefined:undefined,request_key:form.requestKey});ElMessage.success('采购申请已提交，并通知本企业管理员和采购人员');dialog.value='';await reload(true);emit('saved');}catch(e){ElMessage.error(e.message);}finally{busy.value=false;}
}
async function receive(){
 const selected=receiptRows.value.filter(r=>r.selected);
 if(!selected.length)return ElMessage.warning('请选择实际到货并验收合格的批次');
 if(selected.some(r=>!Number.isSafeInteger(r.actual)||r.actual<=0||r.actual>Number(r.quantity)))return ElMessage.warning('验收合格件数须大于0且不超过待收件数');
 if(selected.some(r=>r.actual<Number(r.quantity)&&!r.reason))return ElMessage.warning('部分登记入库时请选择未收部分的原因');
 try{await ElMessageBox.confirm(`确认登记 ${selected.reduce((n,r)=>n+r.actual,0)} 件验收合格实物？未收或不合格部分继续待处理。`,'确认登记入库',{type:'warning'});}catch{return;}
 busy.value=true;
 try{await apiClient.post('/api/inventory-workflow/receipts',{product_id:productId.value,request_key:form.requestKey,counted_quantity:counted.value,records:selected.map(r=>({id:r.id,quantity:r.actual,expected_quantity:Number(r.quantity),reason:r.reason,note:r.note}))});ElMessage.success('已登记入库，未收部分保留待处理');dialog.value='';emit('saved');}catch(e){ElMessage.error(e.message);}finally{busy.value=false;}
}
async function saveFbp(submit){
 const selected=fbpRows.value.filter(r=>r.selected);
 if(!selected.length)return ElMessage.warning('请选择需要备货的店铺SKU');
 if(selected.some(r=>!Number.isSafeInteger(r.quantity)||r.quantity<1))return ElMessage.warning('备货数量须为正整数，建议每个SKU至少5件');
 busy.value=true;
 try{await apiClient.post('/api/inventory-workflow/fbp',{product_id:productId.value,submit,note:form.note,rows:selected.map(r=>({shop_id:r.shop_id,ozon_sku:r.ozon_sku,quantity:r.quantity}))});ElMessage.success(submit?'FBP备货申请已提交，供货不足时可继续提交采购申请':'已保存FBP草稿，不占库存、不产生采购需求');dialog.value='';await reload(true);emit('saved');}catch(e){ElMessage.error(e.message);}finally{busy.value=false;}
}
watch([()=>productId.value,()=>props.ledger.revision],()=>{++actionVersion;busy.value=false;dialog.value='';purchaseVisible.value=false;void reload();},{immediate:true});
watch(()=>props.initialAction,value=>{if(value==='procurement')void open('request');},{immediate:true});
defineExpose({open,reload});
</script>
<template>
 <section class="inventory-workflow-panel">
  <div class="workflow-actions"><el-button @click="open('request')">提交采购申请</el-button><el-button v-if="canPurchase" :disabled="loading||!state" @click="open('purchase')">登记实际采购</el-button><el-button v-if="canReceive" @click="open('receive')">登记入库</el-button><el-button v-if="canFbp" @click="open('fbp')">创建FBP备货申请</el-button><el-button link :loading="loading" @click="reload(true)">刷新需求判断</el-button></div>
  <div class="workflow-demands"><button v-for="d in current.demands" :key="d.key" :class="['workflow-demand',`is-${d.status}`]" @click="open('request',d.key)"><strong>{{d.priority}}. {{d.label}}</strong><span>{{loading?'计算中':d.purchase_quantity==null?'待核对':`建议采购 ${d.purchase_quantity} 件`}}</span><small v-if="d.submitted_quantity">已提交 {{d.submitted_quantity}} 件</small><small v-if="d.process_status" class="process-note">{{({pending_review:'待仓库确认',draft:'备货草稿未提交',request_submitted:'采购申请待处理'})[d.process_status]}}</small><small v-if="d.advisory_status" :class="d.advisory_status==='warning'?'process-note':'advisory-note'">{{d.advisory_status==='warning'?'建议关注FBP补货周期':'存在FBP备货机会'}} · 尚未形成采购需求</small></button></div>
  <p v-if="error" class="workflow-warning">{{error}}；未知数据不当作零，可刷新或手动提交说明。</p><p v-if="current.incoming_note">{{current.incoming_note}}</p>
  <el-dialog v-if="dialog==='request'" :model-value="true" title="提交采购申请" width="min(600px,94vw)" append-to-body :show-close="!busy" :close-on-click-modal="false" :close-on-press-escape="!busy" @close="dialog=''">
   <p><strong>{{ledger.product.name}}</strong>；申请不会直接生成采购在途，也不会改库存。</p>
   <el-form label-width="100px" :disabled="busy"><el-form-item label="需求类型" required><el-select v-model="form.type" placeholder="请选择用途"><el-option v-for="t in INVENTORY_DEMAND_TYPES" :key="t.key" :value="t.key" :label="t.label" /></el-select></el-form-item><el-form-item label="申请件数" required><el-input-number v-model="form.quantity" :precision="0" :min="1" :max="1000000" /></el-form-item><el-form-item label="说明"><el-input v-model="form.note" type="textarea" maxlength="500" show-word-limit /></el-form-item></el-form>
   <template #footer><el-button :disabled="busy" @click="dialog=''">取消</el-button><el-button type="primary" :loading="busy" @click="submitRequest">提交并提醒采购</el-button></template>
  </el-dialog>
  <ProcurementRequestCreateDialog v-if="purchaseVisible" v-model="purchaseVisible" :initial-product-id="productId" :source-request-ids="(state?.requests||[]).map(r=>r.id)" lock-product @created="emit('saved');reload(true)" />
  <el-dialog v-if="dialog==='receive'" :model-value="true" title="登记入库" width="min(1000px,94vw)" append-to-body :show-close="!busy" :close-on-click-modal="false" :close-on-press-escape="!busy" @close="dialog=''">
   <p>仅登记验收合格的实物；未到货或不合格部分不增加库存。一次可登记多个批次。</p>
   <el-table v-loading="busy" :data="receiptRows" empty-text="暂无待入库的已采购批次"><el-table-column width="45"><template #default="{row}"><el-checkbox v-model="row.selected" :disabled="busy" /></template></el-table-column><el-table-column prop="order_no" label="采购单" min-width="150" /><el-table-column prop="id" label="批次" width="80" /><el-table-column prop="quantity" label="待收件数" width="90" /><el-table-column label="验收合格件数" width="170"><template #default="{row}"><el-input-number v-model="row.actual" :min="0" :max="Number(row.quantity)" :precision="0" :disabled="busy" /></template></el-table-column><el-table-column label="未收原因" min-width="160"><template #default="{row}"><el-select v-model="row.reason" :disabled="busy"><el-option v-for="reason in ['部分到货','验货不合格','其他']" :key="reason" :value="reason" :label="reason" /></el-select></template></el-table-column></el-table>
   <el-form label-width="180px"><el-form-item label="当前实际在仓总数"><el-input-number v-model="counted" :min="0" :precision="0" :disabled="busy" /><small>存在历史出库或盘点时必填，包含本次合格到货，避免重复入库。</small></el-form-item></el-form>
   <template #footer><el-button :disabled="busy" @click="dialog=''">取消</el-button><el-button type="primary" :loading="busy" @click="receive">确认登记入库</el-button></template>
  </el-dialog>
  <el-dialog v-if="dialog==='fbp'" :model-value="true" title="创建FBP备货申请" width="min(1100px,94vw)" append-to-body :show-close="!busy" :close-on-click-modal="false" :close-on-press-escape="!busy" @close="dialog=''">
   <p>爆品优先，其次潜力品；建议按SKU备货，通常至少5件，可自行调整。草稿和系统机会不占库存；提交后进入待审核，仓库确认才锁定。</p><el-alert v-if="state?.forecast_error" :title="state.forecast_error" type="warning" :closable="false" />
   <el-table v-loading="loading" :data="fbpRows" empty-text="暂无可备货SKU，请先核对商品绑定或刷新预测"><el-table-column width="45"><template #default="{row}"><el-checkbox v-model="row.selected" :disabled="busy||!row.mapping_id" /></template></el-table-column><el-table-column prop="shop_name" label="店铺" min-width="110" /><el-table-column prop="ozon_sku" label="SKU" min-width="150" /><el-table-column prop="category" label="分级" width="90" /><el-table-column prop="available" label="官方可售" width="100" /><el-table-column label="建议" width="130"><template #default="{row}">{{!row.mapping_id?'请先完善SKU绑定':row.suggested_qty?`建议 ${row.suggested_qty} 套`:'暂不建议，可人工备货'}}</template></el-table-column><el-table-column label="申请套数" width="170"><template #default="{row}"><el-input-number v-model="row.quantity" :min="1" :precision="0" :disabled="busy||!row.mapping_id" /></template></el-table-column><el-table-column prop="per_set_quantity" label="每套实物件数" width="120" /></el-table>
   <el-input v-model="form.note" type="textarea" maxlength="500" placeholder="备货说明" :disabled="busy" />
   <template #footer><el-button :disabled="busy" @click="dialog=''">取消</el-button><el-button :loading="busy" @click="saveFbp(false)">保存草稿</el-button><el-button type="primary" :loading="busy" @click="saveFbp(true)">提交备货申请</el-button></template>
  </el-dialog>
 </section>
</template>
<style scoped>
.workflow-actions,.workflow-demands{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.workflow-demand{flex:1;min-width:200px;text-align:left;background:var(--el-fill-color-light);color:var(--el-text-color-primary);border:1px solid var(--el-border-color);border-left:4px solid var(--el-color-info);border-radius:8px;padding:10px;display:grid;gap:5px;cursor:pointer}.workflow-demand.is-danger{border-left-color:var(--el-color-danger)}.workflow-demand.is-warning{border-left-color:var(--el-color-warning)}.workflow-demand.is-success{border-left-color:var(--el-color-success)}.workflow-demand.is-opportunity{border-left-color:var(--el-color-primary)}.advisory-note{color:var(--el-color-primary)!important}.process-note{color:var(--el-color-warning)!important}.workflow-warning{color:var(--el-color-warning)}.inventory-workflow-panel p,.workflow-demand small{font-size:12px;color:var(--el-text-color-secondary)}
</style>
