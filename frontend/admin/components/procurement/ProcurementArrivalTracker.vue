<script setup>
import {computed,defineAsyncComponent,onBeforeUnmount,onMounted,reactive,ref,watch} from 'vue';
import {ElMessage,ElMessageBox} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
import {inventorySearchDefaults} from '../../../../src/shared/inventory-search-fields.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import InventoryPageToolbar from '../inventory/InventoryPageToolbar.vue';
import ProductImagePreview from '../ProductImagePreview.vue';
const Ledger=defineAsyncComponent(()=>import('./ProcurementLedgerDialog.vue'));
const props=defineProps({productId:{type:Number,default:0}}),auth=useAuthStore();
const filters=reactive({...inventorySearchDefaults(),query:'',status:'open',page:1,pageSize:20}),rows=ref([]),total=ref(0),loading=ref(false),error=ref('');
const ledger=reactive({visible:false,productId:0}),canConfirm=computed(()=>hasPermission(auth.user,'procurement')),canReceive=computed(()=>hasPermission(auth.user,'packing')||hasPermission(auth.user,'procurement'));
const labels={open:'未到货 · 采购未关闭',arrived:'已到货待验收',received:'已验收入库',cancelled:'已取消'};
const time=v=>v?shanghaiDateTimeText(v,{assumeUtcWhenNaive:true}):'未记录';
let version=0,controller,disposed=false;
async function load(reset=false){
 if(reset)filters.page=1;controller?.abort();controller=new AbortController();const token=++version,scope=currentApiCacheScope();loading.value=true;error.value='';
 try{const r=await apiClient.get(`/api/inventory-workflow/purchase-arrivals?${new URLSearchParams({...filters,...(props.productId?{product_id:props.productId}:{})})}`,{noCache:true,signal:controller.signal});if(token===version&&!disposed&&scope===currentApiCacheScope()){rows.value=r.rows||[];total.value=r.total||0;}}
 catch(e){if(token===version&&e.name!=='AbortError')error.value=e.message;}finally{if(token===version)loading.value=false;}
}
function resetScope(){version++;controller?.abort();rows.value=[];total.value=0;ledger.visible=false;Object.assign(filters,inventorySearchDefaults(),{query:'',status:'open',page:1});void load();}
async function confirm(row){
 const scope=currentApiCacheScope();
 try{const {value}=await ElMessageBox.prompt(`确认本批次剩余 ${row.quantity} 件已全部到货？只关闭采购到货跟踪，仓库验收入库后才增加本地实物。部分到货请用验货入库登记实际数量。`,'确认采购到货',{inputType:'textarea',inputPlaceholder:'填写到货位置、签收情况或其他说明',inputValidator:v=>!!String(v||'').trim()||'请填写到货说明',confirmButtonText:'确认本批次到货'});
  if(scope!==currentApiCacheScope()||disposed)return;await apiClient.post('/api/inventory-workflow/purchase-arrivals',{id:row.id,note:String(value).trim(),expected_updated_at:row.updated_at,request_key:crypto.randomUUID()});if(scope!==currentApiCacheScope())return;ElMessage.success('采购已标记到货，等待仓库验收；本地实物尚未增加');await load();
 }catch(e){if(!['cancel','close'].includes(e)&&scope===currentApiCacheScope())ElMessage.error(e.message||'确认到货失败');}
}
watch(()=>props.productId,()=>load(true),{immediate:true});onMounted(()=>window.addEventListener('erp:auth-scope-changed',resetScope));onBeforeUnmount(()=>{disposed=true;version++;controller?.abort();window.removeEventListener('erp:auth-scope-changed',resetScope);});
</script>
<template>
 <section class="arrival-tracker">
  <div class="arrival-heading"><div><h2>采购到货跟踪</h2><p>一笔采购可对应多个到货批次；未到货继续跟踪，到货确认与验收入库分开记录。</p></div><el-button :loading="loading" @click="load()">刷新到货记录</el-button></div>
  <el-radio-group aria-label="采购到货状态" v-model="filters.status" @change="load(true)"><el-radio-button value="open">未到货（未关闭）</el-radio-button><el-radio-button value="arrived">已到货待验收</el-radio-button><el-radio-button value="received">已验收入库</el-radio-button><el-radio-button value="all">全部记录</el-radio-button></el-radio-group>
  <InventoryPageToolbar :filters="filters" product-search :show-shop="false" :show-date-range="false" :loading="loading" @search="load(true)" @reset="Object.assign(filters,inventorySearchDefaults(),{query:''});load(true)"/>
  <el-alert v-if="productId" type="info" :closable="false" title="当前展示选中库存的采购记录，可返回库存需求总览切换商品。"/>
  <el-alert v-if="error" :title="error" type="error" :closable="false"/>
  <el-table v-loading="loading" :data="rows" row-key="id" border :empty-text="error?'采购记录加载失败，请刷新重试':'当前筛选没有采购记录'">
   <el-table-column label="库存商品" min-width="270"><template #default="{row}"><div class="arrival-product"><ProductImagePreview :src="`/api/products/${row.product_id}/image?thumb=1`" :preview-list="[`/api/products/${row.product_id}/image`]" size="portrait"/><div><b>{{row.product_name}}</b><small>库存 ID：{{row.inventory_number||row.product_id}}</small></div></div></template></el-table-column>
   <el-table-column label="采购记录" min-width="200"><template #default="{row}"><b>{{row.order_no||`采购批次 #${row.id}`}}</b><p>批次 #{{row.id}} · {{row.buyer_name||'采购人待核'}}</p><small>采购 {{time(row.purchased_at)}}</small></template></el-table-column>
   <el-table-column label="数量与状态" min-width="170"><template #default="{row}"><strong>{{row.quantity}} 件</strong><p><el-tag :type="row.arrival_state==='open'?'warning':'success'">{{labels[row.arrival_state]}}</el-tag></p></template></el-table-column>
   <el-table-column label="物流与时间" min-width="220"><template #default="{row}"><span>{{row.courier_company||'快递未登记'}} {{row.tracking_number||''}}</span><p v-if="row.received_at">到货 {{time(row.received_at)}}</p><p v-if="row.approved_at">入库 {{time(row.approved_at)}}</p></template></el-table-column>
   <el-table-column prop="note" label="采购备注" min-width="170"/>
   <el-table-column label="操作" min-width="190" fixed="right"><template #default="{row}"><div class="arrival-actions"><el-button v-if="canConfirm&&row.arrival_state==='open'" type="primary" @click="confirm(row)">确认采购到货</el-button><el-button v-if="canReceive&&['open','arrived'].includes(row.arrival_state)" plain @click="Object.assign(ledger,{visible:true,productId:Number(row.product_id)})">验货入库</el-button></div></template></el-table-column>
  </el-table>
  <el-pagination v-model:current-page="filters.page" :page-size="filters.pageSize" :total="total" layout="total,prev,pager,next" @current-change="load()"/>
  <Ledger v-if="ledger.visible" v-model="ledger.visible" :product-id="ledger.productId" initial-action="receive" :stocktake-enabled="hasPermission(auth.user,'inventory.write')" @saved="load()"/>
 </section>
</template>
<style scoped>
.arrival-tracker{display:grid;gap:18px;min-width:0}.arrival-heading{display:flex;justify-content:space-between;gap:16px}.arrival-heading h2{margin:0;font-size:20px}.arrival-heading p{font-size:13px;color:var(--el-text-color-secondary)}.arrival-product{display:flex;gap:12px;align-items:center;min-height:92px}.arrival-product>div{display:grid;gap:8px}.arrival-product small{color:var(--el-text-color-secondary)}.arrival-actions{display:flex;gap:8px;flex-wrap:wrap}.arrival-actions .el-button{margin:0}.arrival-tracker>.el-pagination{justify-content:flex-end}
</style>
