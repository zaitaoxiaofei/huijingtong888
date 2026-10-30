<script setup>
import {computed,onBeforeUnmount,reactive,ref,watch} from 'vue';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {PROCUREMENT_GAP_CAUSES} from '../../../../src/shared/procurement-demand-types.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import ProductImagePreview from '../ProductImagePreview.vue';
const props=defineProps({productId:Number,initialTab:{type:String,default:'orders'}}),emit=defineEmits(['changed','track']);
const auth=useAuthStore(),tab=ref(props.initialTab),data=ref(null),loading=ref(false),error=ref(''),saving=ref(false);
const form=reactive({system:true,quantity:0,note:''});let version=0,controller;
const canEdit=computed(()=>hasPermission(auth.user,'inventory.write')||hasPermission(auth.user,'procurement'));
const fbpLabels={pending_review:'待审核申请',approved:'已确认占用',ozon_created:'已提交官方'};
const time=v=>v?shanghaiDateTimeText(v,{assumeUtcWhenNaive:true}):'未记录';
const openBatches=computed(()=>(data.value?.batches||[]).filter(r=>!r.received_at&&r.status!=='approved'));
const activeReports=computed(()=>(data.value?.reports||[]).filter(r=>r.types?.includes({orders:'real_order',safety:'local_safety',fbp:'fbp_stock'}[tab.value])));
const skuCount=computed(()=>new Set((data.value?.applications||[]).map(a=>`${a.shop_id}:${a.ozon_sku}`)).size);
async function load(){
 controller?.abort();controller=new AbortController();const token=++version,scope=currentApiCacheScope();loading.value=true;error.value='';
 try{const result=await apiClient.get(`/api/inventory-workflow/demand-details?product_id=${props.productId}`,{noCache:true,signal:controller.signal});if(token!==version||scope!==currentApiCacheScope())return;data.value=result;Object.assign(form,{system:result.safety.safety_override==null,quantity:result.safety.safety_override??result.safety.recommended_safety_qty,note:result.safety.override_note||''});}
 catch(e){if(token===version&&e.name!=='AbortError')error.value=e.message;}finally{if(token===version)loading.value=false;}
}
async function save(){
 if(!form.system&&(form.quantity==null||!Number.isSafeInteger(Number(form.quantity))))return ElMessage.warning('请填写0或更大的整数保障数量');
 if(!form.system&&!form.note.trim())return ElMessage.warning('请填写调整原因，例如销量下滑或季节变化');
 const scope=currentApiCacheScope();saving.value=true;
 try{await apiClient.post('/api/inventory-workflow/local-safety',{product_id:props.productId,quantity:form.system?null:form.quantity,note:form.note,revision:data.value.safety.revision});if(scope!==currentApiCacheScope())return;ElMessage.success('本地保障已保存，其他两类真实需求保持独立');await load();emit('changed',data.value?.state);}
 catch(e){if(scope===currentApiCacheScope())ElMessage.error(e.message);}finally{saving.value=false;}
}
watch(()=>props.productId,load,{immediate:true});onBeforeUnmount(()=>{version++;controller?.abort();});
</script>
<template>
 <div v-loading="loading" class="procurement-demand-detail">
  <div class="detail-heading"><strong>{{data?.product?.name||'库存需求明细'}}</strong><el-button @click="load">刷新本商品明细</el-button></div>
  <el-alert v-if="error" :title="error" type="error" :closable="false"/>
  <el-tabs v-if="data" v-model="tab">
   <el-tab-pane label="FBS订单明细" name="orders">
    <p>共 {{new Set(data.orders.map(o=>o.order_id)).size}} 个待履约订单 · 需求 {{data.state.order_demand}} 件 · 尚需采购 {{data.state.supply_plan?.required_fbs??'待核对'}} 件</p>
    <el-table :data="data.orders" border empty-text="当前没有关联的待履约FBS订单" max-height="60vh">
     <el-table-column label="订单商品" min-width="245"><template #default="{row}"><div class="order-product"><ProductImagePreview :src="row.ozon_image_url" :preview-list="[row.ozon_image_url].filter(Boolean)" style="width:66px;height:88px;min-width:66px"/><div><b>{{row.ozon_name||row.ozon_sku}}</b><small>SKU {{row.ozon_sku}}</small><small>实物需求 {{row.quantity}} 件</small></div></div></template></el-table-column>
     <el-table-column label="订单与店铺" min-width="210"><template #default="{row}"><b>{{row.posting_number}}</b><p>{{row.shop_name}}</p><small>{{row.logistics}}</small></template></el-table-column>
     <el-table-column label="下单时间" min-width="175"><template #default="{row}">{{time(row.ordered_at)}}</template></el-table-column>
     <el-table-column label="货源覆盖" min-width="155"><template #default="{row}">现货 {{row.stock_quantity??0}} 件<p>采购在途 {{row.incoming_quantity??0}} 件</p><strong class="gap">缺 {{row.shortage_quantity??0}} 件</strong></template></el-table-column>
     <el-table-column label="人工备注" min-width="180"><template #default="{row}">{{row.manual_note||'暂无人工备注'}}</template></el-table-column>
    </el-table>
   </el-tab-pane>
   <el-tab-pane label="本地保障规则" name="safety">
    <el-descriptions :column="2" border>
     <el-descriptions-item label="统计窗口">近7个完整北京自然日</el-descriptions-item><el-descriptions-item label="实际FBS消耗">{{data.safety.consumed_7d}} 件</el-descriptions-item>
     <el-descriptions-item label="平均日销量">{{Number(data.safety.daily_consumption).toFixed(2)}} 件/日</el-descriptions-item><el-descriptions-item label="生产周期">{{data.safety.production_days}} 天</el-descriptions-item>
     <el-descriptions-item label="运往本地仓">{{data.safety.local_shipping_days}} 天</el-descriptions-item><el-descriptions-item label="最终保障周期">{{data.safety.local_days}} 天（含最低周期与假期延长）</el-descriptions-item>
     <el-descriptions-item label="系统建议保障">{{data.safety.recommended_safety_qty}} 件</el-descriptions-item><el-descriptions-item label="当前采用">{{data.safety.safety_qty}} 件 · {{data.safety.safety_override==null?'系统建议':'人工覆盖'}}</el-descriptions-item>
    </el-descriptions>
    <p v-if="data.safety.updated_at">最近调整：{{data.safety.updated_by_name||'历史修改人待核'}} · {{time(data.safety.updated_at)}}</p>
    <p>系统建议 = 平均日销量 × 保障周期，向上取整。人工覆盖只调整本地保障，不减少真实订单和正式FBP申请。</p>
    <el-form v-if="canEdit" label-position="top" class="safety-editor"><el-checkbox v-model="form.system">使用系统建议</el-checkbox><el-form-item label="人工保障数量"><el-input-number v-model="form.quantity" :disabled="form.system" :min="0" :max="1000000" :precision="0"/></el-form-item><el-form-item label="调整原因"><el-input v-model="form.note" type="textarea" :rows="2" :disabled="form.system" maxlength="500" placeholder="例如：近期销量下滑，保障从10件调整为5件"/></el-form-item><el-button type="primary" :loading="saving" @click="save">保存本地保障</el-button></el-form>
   </el-tab-pane>
   <el-tab-pane label="FBP备货申请" name="fbp">
    <p>{{skuCount}} 个店铺SKU已提交申请 · 待审核需求 {{data.state.requested}} 件 · 本库存正式FBP采购缺口 {{data.state.supply_plan?.required_fbp??'待核对'}} 件</p>
    <el-alert type="info" :closable="false" title="现货和采购在途按库存共享，缺口统一去重汇总；具体SKU的最终占用由仓库确认分配。预测预警不等于正式申请。"/>
    <el-table :data="data.applications" border empty-text="当前没有正式FBP备货申请" max-height="55vh"><el-table-column label="申请单 / SKU" min-width="220"><template #default="{row}"><b>{{row.order_no}}</b><p>{{row.ozon_sku}}</p><small>{{row.shop_name}}</small></template></el-table-column><el-table-column label="状态" min-width="130"><template #default="{row}">{{fbpLabels[row.status]||row.status}}</template></el-table-column><el-table-column label="申请实物" width="100"><template #default="{row}">{{row.requested_quantity}} 件</template></el-table-column><el-table-column label="申请人" min-width="130"><template #default="{row}">{{row.applicant_name||'历史申请人待核'}}</template></el-table-column><el-table-column label="申请时间" min-width="175"><template #default="{row}">{{time(row.submitted_at||row.created_at)}}</template></el-table-column></el-table>
   </el-tab-pane>
   <el-tab-pane label="采购与到货记录" name="batches"><p>未关闭采购 {{openBatches.length}} 个批次；确认到货后进入“已到货待验收”，验收入库后才增加本地实物。</p><el-table :data="data.batches" border><el-table-column label="采购单" min-width="180"><template #default="{row}">{{row.order_no||`采购批次 #${row.id}`}}</template></el-table-column><el-table-column label="剩余待验收" width="130"><template #default="{row}">{{row.quantity}} 件</template></el-table-column><el-table-column label="采购时间" min-width="180"><template #default="{row}">{{time(row.purchased_at)}}</template></el-table-column><el-table-column label="状态" min-width="160"><template #default="{row}">{{row.received_at?'已到货待验收':'采购未完成 · 待到货'}}</template></el-table-column></el-table></el-tab-pane>
  </el-tabs>
  <div v-if="activeReports.length" class="demand-reports"><h3>本类需求的补充说明</h3><div v-for="(report,index) in activeReports" :key="index"><b>{{PROCUREMENT_GAP_CAUSES[report.cause]||report.cause}}</b> · {{report.person_name||'历史人员待核'}} · {{time(report.created_at)}}<p>{{report.note}}</p></div></div>
 </div>
</template>
<style scoped>
.procurement-demand-detail{min-height:220px}.detail-heading{display:flex;justify-content:space-between;align-items:center;gap:15px;margin-bottom:20px}.order-product{display:flex;gap:12px;align-items:center;min-height:100px}.order-product>div{display:grid;gap:8px}.order-product small{color:var(--el-text-color-secondary)}.gap{color:var(--el-color-danger)}.safety-editor{max-width:620px;margin-top:24px;padding:20px;background:var(--el-fill-color-extra-light);border-radius:8px}
</style>
