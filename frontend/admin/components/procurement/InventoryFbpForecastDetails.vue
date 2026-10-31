<script setup>
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
const props=defineProps({productId:Number}),emit=defineEmits(['create']);
const state=ref(null),loading=ref(false),error=ref(''),auth=useAuthStore(),canCreate=computed(()=>hasPermission(auth.user,'inventory.write'));
let version=0,controller;
async function load(){controller?.abort();controller=new AbortController();const token=++version,scope=currentApiCacheScope();loading.value=true;error.value='';try{const r=await apiClient.get(`/api/inventory-workflow?product_id=${props.productId}&fresh=1`,{noCache:true,signal:controller.signal});if(token===version&&scope===currentApiCacheScope())state.value=r.rows?.[0];}catch(e){if(token===version&&e.name!=='AbortError')error.value=e.message;}finally{if(token===version)loading.value=false;}}
watch(()=>props.productId,load,{immediate:true});onBeforeUnmount(()=>{++version;controller?.abort();});
</script>
<template>
 <section v-loading="loading" aria-label="FBP预测预警明细"><el-alert type="warning" :closable="false" title="黄色预警，可提前备货或采购，不强制。运营正式确认后，只有未被现货和采购在途覆盖的申请缺口才进入必须采购。"/>
  <el-alert v-if="error" :title="error" type="error" :closable="false"/>
  <p>按实际FBP销量与备货周期预测；平台可售、发往FBP在途、已确认备货和同SKU待审核申请不重复计算。FBS销量不增加FBP预测目标。</p>
  <p>本地保障建议 {{state?.supply_plan?.optional_local??'待核对'}} 件 · 未确认FBP预测采购建议 {{state?.supply_plan?.optional_fbp??'待核对'}} 件 · FBP正式申请必须采购 {{state?.supply_plan?.required_fbp??'待核对'}} 件</p>
  <el-table :data="state?.fbp_forecast_suggestions||[]" border empty-text="FBP预测未核实，请先同步官方库存；未知不按零处理">
   <el-table-column prop="shop_name" label="店铺" min-width="130"/><el-table-column prop="ozon_sku" label="SKU" min-width="150"/>
   <el-table-column prop="available" label="FBP可售（套）" width="130"/><el-table-column prop="fbp_target" label="预测目标（套）" width="135"/>
   <el-table-column label="发往FBP / 已确认（套）" min-width="190"><template #default="{row}">{{row.in_transit||0}} / {{row.committed_qty||0}}</template></el-table-column>
   <el-table-column prop="pending_physical" label="待审核申请（实物）" min-width="165"/>
   <el-table-column prop="suggested_application_qty" label="剩余预测建议（套）" min-width="165"/>
  </el-table>
  <p><el-button :loading="loading" @click="load">刷新预测</el-button><el-button v-if="canCreate" type="warning" plain :disabled="!state?.fbp_forecast_suggestions?.some(r=>r.suggested_application_qty>0)" @click="emit('create')">创建FBP申请</el-button></p>
 </section>
</template>
