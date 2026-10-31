<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { apiClient, currentApiCacheScope } from '../../utils/api.js';
import { getActivePinia } from 'pinia';
import { useAuthStore } from '../../stores/auth.js';
import { hasPermission } from '../../../../src/shared/permissions.js';
import { INVENTORY_DEMAND_TYPES, inventoryWorkflow } from '../../../../src/shared/inventory-workflow.js';
import {inventoryProcurementStatus} from '../../../../src/shared/inventory-procurement-status.js';
import ProcurementRequestCreateDialog from './ProcurementRequestCreateDialog.vue';
const ReceiveDialog=defineAsyncComponent(()=>import('./InventoryReceiveDialog.vue'));
const ForecastDialog=defineAsyncComponent(()=>import('./InventoryFbpForecastDialog.vue'));
const forecastVisible=ref(false);
const props=defineProps({ledger:{type:Object,required:true},orderId:Number,initialAction:String,initialInboundId:Number,compact:Boolean});
const emit=defineEmits(['loaded','saved']);
const auth=getActivePinia()?useAuthStore():{user:null};
const fbpProjection=ref(null),showDemands=ref(false);
const state=ref(null), loading=ref(false), error=ref(''), dialog=ref(''), busy=ref(false), purchaseVisible=ref(false);
const canPurchase=computed(()=>hasPermission(auth.user,'procurement'));
const canReceive=computed(()=>canPurchase.value||hasPermission(auth.user,'packing'));
const canFeedback=computed(()=>canReceive.value||hasPermission(auth.user,'inventory.write'));
const canFbp=computed(()=>hasPermission(auth.user,'inventory.write'));
const productId=computed(()=>Number(props.ledger.product?.id));
const current=computed(()=>({...inventoryWorkflow(props.ledger,{requests:state.value?.requests||[],forecast:fbpProjection.value?.forecast||state.value?.forecast}),transfers:fbpProjection.value?.transfers??props.ledger.flow_summary?.transfers}));
watch(current,value=>emit('loaded',value),{immediate:true});
const fbpSelectedPhysical=computed(()=>fbpRows.value.filter(r=>r.selected).reduce((sum,r)=>sum+Number(r.quantity||0)*Number(r.per_set_quantity||1),0));
const form=reactive({type:'',quantity:1,note:'',requestKey:''}), fbpRows=ref([]);
let version=0,actionVersion=0,projectionVersion=0,disposed=false;
onBeforeUnmount(()=>{disposed=true;++version;++actionVersion;++projectionVersion;});
async function reload(fresh=false,full=false){
 const token=++version,id=productId.value,scope=currentApiCacheScope();loading.value=true;error.value='';state.value=null;emit('loaded',null);
 try{const result=await apiClient.get(`/api/inventory-workflow?product_id=${id}${full?'':'&view=requests'}${fresh?'&fresh=1':''}`,{noCache:true});if(!disposed&&token===version&&id===productId.value&&scope===currentApiCacheScope()){state.value=result.rows?.[0]||null;if(full)fbpProjection.value=state.value;}}
 catch(e){if(!disposed&&token===version&&scope===currentApiCacheScope())error.value=e.message||'需求暂不可用';}
 finally{if(token===version)loading.value=false;}
}
async function open(action,type=''){
 if(action==='forecast'){if(canFbp.value)forecastVisible.value=true;return;}
 const actionToken=++actionVersion,id=productId.value,scope=currentApiCacheScope();
 const active=()=>!disposed&&actionToken===actionVersion&&id===productId.value&&scope===currentApiCacheScope()&&dialog.value===action;
 form.type=type;form.quantity=Math.max(1,Number(current.value.demands.find(d=>d.key===type)?.purchase_quantity)||1);form.note='';form.requestKey=crypto.randomUUID();
 if(action==='purchase'){if(canPurchase.value&&state.value&&!loading.value)purchaseVisible.value=true;return;}
 dialog.value=action;
 if(action==='fbp'){
  fbpRows.value=[];
  if(!fbpProjection.value?.skus&&!state.value?.skus)await reload(true,true);
  if(!active())return;
  fbpRows.value=(fbpProjection.value?.skus||state.value?.skus||[]).map(s=>({...s,selected:false,quantity:Math.max(5,Number(s.suggested_qty)||5)})).sort((a,b)=>({爆品:0,潜力品:1,常规品:2,淘汰品:3}[a.category]??4)-({爆品:0,潜力品:1,常规品:2,淘汰品:3}[b.category]??4));
 }
}
async function feedbackSupply(){
 const id=productId.value,scope=currentApiCacheScope();
 try{const {value}=await ElMessageBox.prompt('说明当前缺货或核对结果。实物数量不符请先更新本地库存；反馈本身不修改库存。','反馈库存缺口',{inputType:'textarea',inputValidator:text=>String(text||'').trim().length>0&&String(text).length<=500||'请填写1至500字反馈说明'});
  if(scope!==currentApiCacheScope()||id!==productId.value)return;
  const result=await apiClient.post('/api/inventory-workflow/feedback',{product_id:id,note:value,request_key:crypto.randomUUID()});
  if(scope===currentApiCacheScope())ElMessage.success(result.notified?'已反馈至本企业采购与运营':'已核对当前需求');
 }catch(e){if(e!=='cancel'&&e!=='close'&&scope===currentApiCacheScope())ElMessage.error(e.message||'反馈未完成');}
}
async function submitRequest(){
 if(!form.type||!Number.isSafeInteger(form.quantity)||form.quantity<1)return ElMessage.warning('请选择需求类型并填写大于0的整数件数');
 busy.value=true;
 try{await apiClient.post('/api/inventory-workflow/requests',{product_id:productId.value,demand_type:form.type,quantity:form.quantity,note:form.note,order_id:form.type==='real_order'?props.orderId||undefined:undefined,request_key:form.requestKey});ElMessage.success('采购申请已提交，并通知本企业管理员和采购人员');dialog.value='';await reload(true);emit('saved');}catch(e){ElMessage.error(e.message);}finally{busy.value=false;}
}
async function saveFbp(submit){
 const selected=fbpRows.value.filter(r=>r.selected);
 if(!selected.length)return ElMessage.warning('请选择需要备货的店铺SKU');
 if(selected.some(r=>!Number.isSafeInteger(r.quantity)||r.quantity<1))return ElMessage.warning('备货数量须为正整数，建议每个SKU至少5件');
 busy.value=true;
 try{await apiClient.post('/api/inventory-workflow/fbp',{product_id:productId.value,submit,note:form.note,rows:selected.map(r=>({shop_id:r.shop_id,ozon_sku:r.ozon_sku,quantity:r.quantity}))});ElMessage.success(submit?'FBP备货申请已提交，缺口已联动采购队列并通知相关人员':'已保存FBP草稿，不占库存、不产生采购需求');dialog.value='';await reload(true);emit('saved');}catch(e){ElMessage.error(e.message);}finally{busy.value=false;}
}
watch([()=>productId.value,()=>props.ledger.revision],()=>{++actionVersion;busy.value=false;dialog.value='';purchaseVisible.value=false;void reload();},{immediate:true});
watch([()=>productId.value,()=>props.ledger.fbp_inventory],async()=>{
 const token=++projectionVersion,id=productId.value,scope=currentApiCacheScope();fbpProjection.value=null;
 if(!props.ledger.fbp_inventory)return;
 try{const result=await apiClient.get(`/api/inventory-workflow?product_id=${id}&fresh=1`,{noCache:true});
  if(!disposed&&token===projectionVersion&&id===productId.value&&scope===currentApiCacheScope())fbpProjection.value=result.rows?.[0]||null;
 }catch{ /* Local allocation stays usable; FBP remains explicitly unverified. */ }
},{immediate:true});
watch(()=>props.initialAction,value=>{const action=({procurement:'request',receive:'receive',fbp:'fbp',purchase:'purchase'})[value];if(action)void open(action);},{immediate:true});
defineExpose({open,reload});
</script>
<template>
 <section class="inventory-workflow-panel">
  <div class="workflow-actions"><el-button v-if="compact" @click="showDemands=!showDemands">需求判断</el-button><el-button @click="open('request')">提交采购申请</el-button><el-button v-if="canPurchase" :disabled="loading||!state" @click="open('purchase')">登记实际采购</el-button><el-button v-if="canReceive" @click="open('receive')">登记入库</el-button><el-button v-if="canFbp" @click="open('fbp')">创建FBP备货申请</el-button><el-button v-if="canFeedback" type="warning" plain @click="feedbackSupply">反馈缺口</el-button><el-button link :loading="loading" @click="reload(true)">刷新需求判断</el-button></div>
  <div v-if="!compact||showDemands" class="workflow-demands"><button v-for="d in current.demands" :key="d.key" :class="['workflow-demand',`is-${inventoryProcurementStatus(current,d.key)}`]" @click="d.key==='fbp_forecast'?open('forecast'):open('request',d.key)"><strong>{{d.label}}</strong><span>{{loading?'计算中':d.purchase_quantity==null?'待核对':d.required_purchase_quantity>0?`必须采购 ${d.required_purchase_quantity} 件`:`建议采购 ${d.purchase_quantity} 件`}}<small v-if="d.required_purchase_quantity>0&&d.optional_purchase_quantity>0">另有可暂缓保障建议 {{d.optional_purchase_quantity}} 件</small></span><small v-if="d.submitted_quantity">已提交 {{d.submitted_quantity}} 件</small><small v-if="d.process_status" class="process-note">{{({pending_review:'待仓库确认',draft:'备货草稿未提交',request_submitted:'采购申请待处理'})[d.process_status]}}</small><small v-if="d.key==='fbp_forecast' && current.fbp?.known && current.fbp.shortage>0" class="process-note">FBP可用低于安全目标 {{current.fbp.shortage}} 件；先用本地可用与已在途补货，剩余才采购</small><small v-if="d.advisory_status" :class="d.advisory_status==='warning'?'process-note':'advisory-note'">{{d.advisory_status==='warning'?'建议关注FBP补货周期':'存在FBP备货机会'}} · 尚未形成采购需求</small></button></div>
  <p v-if="error" class="workflow-warning">{{error}}；未知数据不当作零，可刷新或手动提交说明。</p><p v-if="!compact&&current.incoming_note">{{current.incoming_note}}</p>
  <el-dialog v-if="dialog==='request'" :model-value="true" title="提交采购申请" width="min(600px,94vw)" append-to-body :show-close="!busy" :close-on-click-modal="false" :close-on-press-escape="!busy" @close="dialog=''">
   <p><strong>{{ledger.product.name}}</strong>；申请不会直接生成采购在途，也不会改库存。</p>
   <el-form label-width="100px" :disabled="busy"><el-form-item label="需求类型" required><el-select v-model="form.type" placeholder="请选择用途"><el-option v-for="t in INVENTORY_DEMAND_TYPES" :key="t.key" :value="t.key" :label="t.label" /></el-select></el-form-item><el-form-item label="申请件数" required><el-input-number v-model="form.quantity" :precision="0" :min="1" :max="1000000" /></el-form-item><el-form-item label="说明"><el-input v-model="form.note" type="textarea" maxlength="500" show-word-limit /></el-form-item></el-form>
   <template #footer><el-button :disabled="busy" @click="dialog=''">取消</el-button><el-button type="primary" :loading="busy" @click="submitRequest">提交并提醒采购</el-button></template>
  </el-dialog>
  <ForecastDialog v-if="forecastVisible" v-model="forecastVisible" :product-id="productId" :product-name="ledger.product.name" @created="forecastVisible=false;emit('saved');reload(true,true)"/>
  <ProcurementRequestCreateDialog v-if="purchaseVisible" v-model="purchaseVisible" :initial-product-id="productId" :source-request-ids="(state?.requests||[]).map(r=>r.id)" lock-product @created="emit('saved');reload(true)" />
  <ReceiveDialog v-if="dialog==='receive'" :model-value="true" :product-id="productId" :product-name="ledger.product.name" :inbound-id="initialInboundId" @update:model-value="value=>{if(!value)dialog='';}" @saved="dialog='';emit('saved')"/>
  <el-dialog v-if="dialog==='fbp'" :model-value="true" title="创建FBP备货申请" width="min(1100px,94vw)" append-to-body :show-close="!busy" :close-on-click-modal="false" :close-on-press-escape="!busy" @close="dialog=''">
   <div class="fbp-group-summary"><div><strong>同库存商品关联的店铺SKU</strong><p>按SKU选择和填写套数，系统统一换算实物。现货不足也可提交需求，未勾选的SKU不会创建。</p></div><div><span>本次实物需求</span><strong>{{fbpSelectedPhysical}} 件</strong><small>当前本地可用 {{current.free??'待核对'}} 件</small></div></div>
   <p>草稿不占库存、不产生采购任务；正式提交后自动进入库存需求队列。已有现货和在途先覆盖，剩余缺口由采购处理，仓库确认后才锁定。</p>
   <p v-if="current.requested>0||current.locked>0" class="process-note">当前库存已有待审核申请 {{current.requested}} 件、已确认锁定 {{current.locked}} 件。请先核对已有单据；同日同店铺SKU会更新原未审核申请，其他日期的申请分别保留。</p><el-alert v-if="state?.forecast_error" :title="state.forecast_error" type="warning" :closable="false" />
   <el-table v-loading="loading" :data="fbpRows" empty-text="暂无可备货SKU，请先核对商品绑定或刷新预测"><el-table-column width="45"><template #default="{row}"><el-checkbox v-model="row.selected" :disabled="busy||!row.mapping_id" /></template></el-table-column><el-table-column prop="shop_name" label="店铺" min-width="110" /><el-table-column prop="ozon_sku" label="SKU" min-width="150" /><el-table-column prop="category" label="分级" width="90" /><el-table-column prop="available" label="官方可售" width="100" /><el-table-column label="建议" width="130"><template #default="{row}">{{!row.mapping_id?'请先完善SKU绑定':row.suggested_qty?`建议 ${row.suggested_qty} 套`:'暂不建议，可人工备货'}}</template></el-table-column><el-table-column label="申请套数" width="170"><template #default="{row}"><el-input-number v-model="row.quantity" :min="1" :precision="0" :disabled="busy||!row.mapping_id" /></template></el-table-column><el-table-column prop="per_set_quantity" label="每套实物件数" width="120" /></el-table>
   <el-input v-model="form.note" type="textarea" maxlength="500" placeholder="备货说明" :disabled="busy" />
   <template #footer><el-button :disabled="busy" @click="dialog=''">取消</el-button><el-button :loading="busy" @click="saveFbp(false)">保存草稿</el-button><el-button type="primary" :loading="busy" @click="saveFbp(true)">提交备货申请</el-button></template>
  </el-dialog>
 </section>
</template>
<style scoped>
.fbp-group-summary{display:flex;justify-content:space-between;gap:24px;padding:16px;border:1px solid var(--el-border-color-lighter);border-radius:10px;background:var(--el-fill-color-light);margin-bottom:14px}.fbp-group-summary>div:last-child{display:grid;gap:5px;min-width:160px}.fbp-group-summary>div:last-child>strong{font-size:24px;color:var(--el-color-primary)}.fbp-group-summary span,.fbp-group-summary small{font-size:12px;color:var(--el-text-color-secondary)}.workflow-actions,.workflow-demands{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.workflow-demand{flex:1;min-width:200px;text-align:left;background:var(--el-fill-color-light);color:var(--el-text-color-primary);border:1px solid var(--el-border-color);border-left:4px solid var(--el-color-info);border-radius:8px;padding:10px;display:grid;gap:5px;cursor:pointer}.workflow-demand.is-danger{border-left-color:var(--el-color-danger)}.workflow-demand.is-warning{border-left-color:var(--el-color-warning)}.workflow-demand.is-success{border-left-color:var(--el-color-success)}.workflow-demand.is-opportunity{border-left-color:var(--el-color-primary)}.advisory-note{color:var(--el-color-primary)!important}.process-note{color:var(--el-color-warning)!important}.workflow-warning{color:var(--el-color-warning)}.inventory-workflow-panel p,.workflow-demand small{font-size:12px;color:var(--el-text-color-secondary)}
</style>
