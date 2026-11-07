<script setup>
import {computed,onBeforeUnmount,reactive,ref,watch} from 'vue';
import {ElMessage,ElMessageBox} from 'element-plus';
import {useAuthStore} from '../../stores/auth.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import ProcurementRequestCreateDialog from './ProcurementRequestCreateDialog.vue';
const props=defineProps({node:String,productId:Number});
const emit=defineEmits(['saved','receive','open-order']);
const auth=useAuthStore(),loading=ref(false),busy=ref(false),error=ref(''),all=ref(false),page=ref(1);
const data=ref(null),purchase=ref(null),editing=ref(null),note=ref('');
const rules=reactive({production_days:1,local_days:2,fbp_days:7});
const time=value=>value?shanghaiDateTimeText(value):'待核对';
const canPurchase=computed(()=>hasPermission(auth.user,'procurement'));
const canWrite=computed(()=>hasPermission(auth.user,'inventory.write'));
const canArrive=computed(()=>canPurchase.value||hasPermission(auth.user,'packing'));
const canNote=computed(()=>['orders.manage','inventory.write','packing','procurement'].some(p=>hasPermission(auth.user,p)));
const requestStatus=row=>({cancelled:row.approval_status==='rejected'?'已拒绝':'已取消',purchased:'已采购',merged:'待采购',submitted:'待审批',pending:'待审批',suggested:'待审批',inbound_done:'已入库',done:'已完成'}[row.status]||row.status);
let version=0,disposed=false;
async function load(){
 const token=++version,scope=currentApiCacheScope();loading.value=true;error.value='';
 try{const result=await apiClient.get(`/api/inventory-workflow/details?${new URLSearchParams({product_id:props.productId,node:props.node,all:all.value?'1':'0',page:page.value})}`,{noCache:true});
  if(token!==version||scope!==currentApiCacheScope())return;
  data.value=result;
  if(props.node==='safety')Object.assign(rules,{production_days:result.settings.production_days??result.product.production_lead_days??7,local_days:result.settings.local_days??result.product.warehouse_logistics_days??2,fbp_days:result.settings.fbp_days??7});
 }catch(e){if(token===version)error.value=e.message||'明细加载失败，请重试';}finally{if(token===version)loading.value=false;}
}
async function action(action,row,value=''){
 if(disposed)return;
 const scope=currentApiCacheScope();busy.value=true;
 try{await apiClient.post('/api/inventory-workflow/node-action',{action,product_id:props.productId,id:action==='order-note'?row.order_id:row.id,note:value,expected_note:row.mark_note});
  if(scope!==currentApiCacheScope())return;
  ElMessage.success(action==='arrived'?'已标记到货，等待验收；实物库存未增加':action==='reject'?'已记录拒绝原因':action==='transit-check'?'已记录今日在途核查':'订单备注和标记已保存');editing.value=null;await load();emit('saved');
 }catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{busy.value=false;}
}
async function reject(row){
 try{const {value}=await ElMessageBox.prompt('请填写拒绝原因，例如重复采购、需求变动或其他说明。','拒绝采购申请',{confirmButtonText:'记录拒绝',cancelButtonText:'取消',inputType:'textarea',inputValidator:v=>!!String(v||'').trim()||'必须填写拒绝原因'});await action('reject',row,value);}catch(e){if(e?.message)ElMessage.error(e.message);}
}
async function arrived(row){try{await ElMessageBox.confirm('确认这批货已实际到达？此操作只进入待验收，不增加库存。','采购到货确认',{confirmButtonText:'确认到货',cancelButtonText:'取消'});await action('arrived',row);}catch{}}
async function saveRules(){
 if(!Number.isSafeInteger(rules.production_days)||rules.production_days<1)return ElMessage.warning('生产周期至少1天，须为整数');
 busy.value=true;
 try{await apiClient.post('/api/inventory-flow/settings',{product_id:props.productId,revision:data.value.revision,settings:{...data.value.settings,...rules}});ElMessage.success('周期规则已保存');await load();emit('saved');}catch(e){ElMessage.error(e.message);}finally{busy.value=false;}
}
watch([()=>props.productId,()=>props.node],()=>{data.value=null;all.value=false;page.value=1;void load();},{immediate:true});
onBeforeUnmount(()=>{disposed=true;++version;});
</script>
<template>
 <section v-loading="loading" class="node-records">
  <el-alert v-if="error" type="error" :title="error" :closable="false"/><el-button v-if="error" @click="load">重试</el-button>
  <div v-if="['requests','purchase-confirm'].includes(node)" class="node-tools"><span>默认近三个月；尚未结束的申请和在途批次继续保留。</span><el-button :disabled="loading" @click="all=!all;page=1;load()">{{all?'查看近三个月':'查看全部'}}</el-button></div>
  <template v-if="data">
   <el-table v-if="node==='requests'" :data="data.rows" max-height="440" empty-text="暂无采购申请">
    <el-table-column prop="id" label="申请编号" width="100"/><el-table-column prop="applicant_name" label="申请人" min-width="110"/><el-table-column label="申请时间" min-width="170"><template #default="{row}">{{time(row.created_at)}}</template></el-table-column><el-table-column prop="quantity" label="申请数量" width="100"/><el-table-column label="状态" min-width="100"><template #default="{row}">{{requestStatus(row)}}</template></el-table-column><el-table-column label="原因／备注" min-width="260"><template #default="{row}"><div>{{row.reason_summary}}</div><div v-if="row.rejection_summary" class="record-note">拒绝：{{row.rejection_summary}}</div><el-popover v-if="row.reason_detail" trigger="click" width="360"><template #reference><el-button size="small" link>完整说明</el-button></template><div class="record-note">{{row.reason_detail}}</div></el-popover></template></el-table-column><el-table-column v-if="canPurchase" label="操作" width="190"><template #default="{row}"><template v-if="['submitted','pending','suggested'].includes(row.status)&&!row.purchase_order_id"><el-button size="small" type="primary" @click="purchase=row">审批并登记采购</el-button><el-button size="small" :disabled="busy" @click="reject(row)">拒绝</el-button></template></template></el-table-column>
   </el-table>
   <el-table v-else-if="['incoming','receiving','purchase-confirm'].includes(node)" :data="data.rows" max-height="440" :row-class-name="({row})=>row.overdue?'node-overdue':''" empty-text="暂无对应采购批次">
    <el-table-column label="采购单／批次" min-width="190"><template #default="{row}">{{row.order_no}}<div>批次 #{{row.id}}</div></template></el-table-column><el-table-column prop="person_name" label="采购人" min-width="100"/><el-table-column label="采购时间" min-width="170"><template #default="{row}">{{time(row.purchased_at)}}<div v-if="row.hours!=null">已过 {{Math.floor(row.hours/24)}} 天 {{Math.floor(row.hours%24)}} 小时</div></template></el-table-column><el-table-column prop="quantity" label="本批件数" width="95"/><el-table-column v-if="data.financial" label="采购金额" width="115"><template #default="{row}">¥{{Number(row.amount||0).toFixed(2)}}<small v-if="row.shipping_amount">＋运费 {{row.shipping_amount}}</small></template></el-table-column><el-table-column label="申请来源" min-width="190"><template #default="{row}"><div v-for="r in row.requests" :key="`${r.applicant_name}:${r.created_at}:${r.quantity}`">{{r.applicant_name||'申请人待核'}} · {{r.quantity}} 件<br>{{time(r.created_at)}}</div><span v-if="!row.requests.length">直接采购／历史来源待核</span></template></el-table-column><el-table-column label="运输／到货状态" min-width="190"><template #default="{row}"><el-tag :type="row.overdue?'danger':row.awaiting_inspection?'warning':'info'">{{row.label}}</el-tag><div v-if="row.overdue">超过2天未到货，请采购跟进</div><div>{{row.courier_company}} {{row.tracking_number}}</div><small>最近核查：{{time(row.checked_at)}}</small></template></el-table-column><el-table-column v-if="canArrive" label="操作" width="150"><template #default="{row}"><el-button v-if="row.status==='pending_arrival'&&!row.received_at" size="small" :disabled="busy" @click="arrived(row)">采购已到货</el-button><el-button v-if="row.status==='pending_arrival'&&!row.received_at" size="small" :disabled="busy" @click="action('transit-check',row)">仍在途 · 已核查</el-button><el-button v-if="row.awaiting_inspection" size="small" @click="emit('receive')">验收登记入库</el-button></template></el-table-column>
   </el-table>
   <el-table v-else-if="node==='orders'" :data="data.rows" max-height="470" empty-text="暂无待履约FBS订单">
    <el-table-column label="主图" width="86"><template #default="{row}"><el-image v-if="row.image_url" class="order-image" :src="row.image_url" fit="cover" :preview-src-list="[row.image_url]" preview-teleported/><span v-else class="order-image empty">无图</span></template></el-table-column><el-table-column prop="posting_number" label="订单号" min-width="180"/><el-table-column prop="shop_name" label="店铺" min-width="110"/><el-table-column label="下单时间" min-width="170"><template #default="{row}">{{time(row.ordered_at)}}</template></el-table-column><el-table-column prop="logistics" label="物流" min-width="150"/><el-table-column label="订单协作备注" min-width="280"><template #default="{row}"><el-tag v-if="row.mark_type" size="small">已标记</el-tag><div class="record-note">{{row.mark_note||'暂无备注'}}</div><el-button v-if="canNote" size="small" @click="editing=row;note=row.mark_note">编辑备注</el-button></template></el-table-column><el-table-column label="操作" width="100"><template #default="{row}"><el-button size="small" @click="emit('open-order',row)">打开订单</el-button></template></el-table-column>
   </el-table>
   <el-form v-else-if="node==='safety'" label-width="160px" class="rules-form"><p>本地安全保障按日均消耗 × 保障天数向上取整，保障天数至少7天；生产周期允许从1天起配置。</p><el-form-item label="生产周期（天）"><el-input-number v-model="rules.production_days" :min="1" :max="180" :precision="0" :disabled="!canWrite||busy"/></el-form-item><el-form-item label="发运到本地仓（天）"><el-input-number v-model="rules.local_days" :min="0" :max="180" :precision="0" :disabled="!canWrite||busy"/></el-form-item><el-form-item label="本地发往FBP（天）"><el-input-number v-model="rules.fbp_days" :min="0" :max="180" :precision="0" :disabled="!canWrite||busy"/></el-form-item><el-button v-if="canWrite" type="primary" :loading="busy" @click="saveRules">保存周期规则</el-button></el-form>
   <el-pagination v-if="data.total>50" :current-page="page" :page-size="50" :total="data.total" layout="prev,pager,next,total" @current-change="value=>{page=value;load()}"/>
  </template>
  <ProcurementRequestCreateDialog v-if="purchase" :model-value="true" @update:model-value="v=>{if(!v)purchase=null}" :initial-product-id="productId" :initial-quantity="Number(purchase.quantity)" :source-request-ids="[Number(purchase.id)]" lock-product @created="purchase=null;load();emit('saved')"/>
  <el-dialog v-if="editing" :model-value="true" title="订单协作备注" width="520px" append-to-body :close-on-click-modal="false" @close="editing=null"><p>此备注同步显示在对应订单的标记中，供运营、采购与仓库协作。</p><el-input v-model="note" type="textarea" :rows="5" maxlength="1000" show-word-limit/><template #footer><el-button :disabled="busy" @click="editing=null">取消</el-button><el-button type="primary" :loading="busy" @click="action('order-note',editing,note)">保存并标记订单</el-button></template></el-dialog>
 </section>
</template>
<style scoped>
.node-tools{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 0;color:var(--el-text-color-secondary);font-size:12px}.record-note{white-space:pre-wrap;overflow-wrap:anywhere}.order-image{display:inline-flex;width:64px;height:84px;border-radius:6px}.empty{align-items:center;justify-content:center;background:var(--el-fill-color-light);color:var(--el-text-color-secondary)}.rules-form{max-width:760px}.node-records :deep(.node-overdue){--el-table-tr-bg-color:var(--el-color-danger-light-9);color:var(--el-color-danger)}.node-records small{display:block}.node-records :deep(.el-button+.el-button){margin-left:0}.node-records :deep(.el-table .el-button){margin:3px}
</style>
