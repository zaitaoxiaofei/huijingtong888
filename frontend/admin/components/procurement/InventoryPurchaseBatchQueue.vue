<script setup>
import {computed,defineAsyncComponent,onBeforeUnmount,reactive,ref,watch} from 'vue';
import {ElMessage,ElMessageBox} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {hasPermission} from '../../../../src/shared/permissions.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import ProductImagePreview from '../ProductImagePreview.vue';
const BatchCorrection=defineAsyncComponent(()=>import('./PurchaseBatchCorrectionDialog.vue'));
const correction=reactive({visible:false,productId:0,inboundId:0,remove:false});
function editBatch(row,remove=false){Object.assign(correction,{visible:true,productId:Number(row.product_id),inboundId:Number(row.id),remove});}
const ReceiveDialog=defineAsyncComponent(()=>import('./InventoryReceiveDialog.vue'));
const receiving=reactive({visible:false,id:0,batch:0,name:''});
const Ledger=defineAsyncComponent(()=>import('./ProcurementLedgerDialog.vue'));
const props=defineProps({status:{type:String,default:'open'},filters:{type:Object,required:true},revision:Number,productId:Number});
const emit=defineEmits(['changed','summary']),auth=useAuthStore(),rows=ref([]),total=ref(0),loading=ref(false),busy=ref(false),error=ref('');
const page=ref(1),ledger=reactive({visible:false,id:0,action:'',batch:0});
const canConfirm=computed(()=>hasPermission(auth.user,'procurement')),canReceive=computed(()=>canConfirm.value||hasPermission(auth.user,'packing'));
let version=0,disposed=false,controller;
const time=v=>v?shanghaiDateTimeText(v,{assumeUtcWhenNaive:true}):'未记录';
const elapsed=v=>{if(!v)return null;const d=typeof v==='string'&&!/[TZ]/.test(v)?v.replace(' ','T')+'Z':v;const n=Date.now()-new Date(d).getTime();return Number.isFinite(n)?Math.max(0,n/86400000):null;};
async function load(reset=false){if(reset)page.value=1;controller?.abort();controller=new AbortController();const token=++version,scope=currentApiCacheScope();loading.value=true;error.value='';try{const r=await apiClient.get(`/api/inventory-workflow/purchase-arrivals?${new URLSearchParams({...props.filters,scope:'all',status:props.status,page:page.value,pageSize:20,...(props.productId?{product_id:props.productId}:{})})}`,{noCache:true,signal:controller.signal});if(!disposed&&token===version&&scope===currentApiCacheScope()){rows.value=r.rows||[];total.value=r.total||0;emit('summary',r.summary||{});}}catch(e){if(token===version&&e.name!=='AbortError')error.value=e.message;}finally{if(token===version)loading.value=false;}}
function openLedger(row,action=''){if(action==='receive'){Object.assign(receiving,{visible:true,id:Number(row.product_id),batch:Number(row.id),name:row.product_name});return;}Object.assign(ledger,{visible:true,id:Number(row.product_id),action,batch:action==='receive'?Number(row.id):0});}
async function confirm(row){const scope=currentApiCacheScope();try{const {value}=await ElMessageBox.prompt(`确认剩余 ${row.quantity} 件已经全部到货？确认后进入仓库待验收，本地实物暂不增加。部分到货请先核对实际验收数量。`,'确认采购到货',{inputType:'textarea',inputPlaceholder:'填写到货位置或签收说明',inputValidator:v=>!!String(v||'').trim()&&String(v).length<=500||'请填写1至500字到货说明',confirmButtonText:'确认本批次到货'});if(disposed||scope!==currentApiCacheScope())return;busy.value=true;await apiClient.post('/api/inventory-workflow/purchase-arrivals',{id:row.id,note:String(value).trim(),expected_updated_at:row.updated_at,request_key:crypto.randomUUID()});if(disposed||scope!==currentApiCacheScope())return;ElMessage.success('已到货待验收，本地实物尚未增加');await load();emit('changed');}catch(e){if(!['cancel','close'].includes(e)&&scope===currentApiCacheScope())ElMessage.error(e.message);}finally{busy.value=false;}}
watch(()=>[props.status,props.revision,props.productId],()=>load(true),{immediate:true});onBeforeUnmount(()=>{disposed=true;++version;controller?.abort();});
</script>
<template>
 <section class="inventory-batch-queue" :aria-label="status==='open'?'采购待到货批次':'到货待验收批次'">
  <el-alert v-if="error" :title="error+'；保留最近成功记录，请手动刷新重试'" type="error" :closable="false"/>
  <el-table :data="rows" row-key="id" border v-loading="loading||busy" :empty-text="error?'到货记录读取失败，不代表没有待处理批次':'当前筛选没有待处理采购批次'">
   <el-table-column label="库存商品" min-width="280"><template #default="{row}"><div class="batch-product"><ProductImagePreview :src="`/api/products/${row.product_id}/image?thumb=1`" :preview-list="[`/api/products/${row.product_id}/image`]" size="portrait"/><div><b>{{row.product_name}}</b><small>库存 ID：{{row.inventory_number||row.product_id}}</small><el-button plain size="small" @click="openLedger(row)">库存详情</el-button></div></div></template></el-table-column>
   <el-table-column label="采购批次 / 人员" min-width="190"><template #default="{row}"><b>{{row.order_no||`采购批次 #${row.id}`}}</b><p>批次 #{{row.id}} · {{row.buyer_name||'采购人待核'}}</p></template></el-table-column>
   <el-table-column :label="status==='open'?'待到货数量':'待验收数量'" width="130"><template #default="{row}"><strong>{{row.quantity}} 件</strong></template></el-table-column>
   <el-table-column :label="status==='open'?'采购时间 / 等待':'采购 / 到货时间'" min-width="205"><template #default="{row}"><span>{{time(row.purchased_at)}}</span><p v-if="status==='open'" :class="{overdue:elapsed(row.purchased_at)>2}">{{elapsed(row.purchased_at)==null?'采购时间待核':`已采购 ${elapsed(row.purchased_at).toFixed(1)} 天`}}{{elapsed(row.purchased_at)>2?' · 超过2天':''}}</p><template v-else><p>到货 {{time(row.received_at)}}</p><small>已到货 {{elapsed(row.received_at)?.toFixed(1)??'待核'}} 天</small></template></template></el-table-column>
   <el-table-column label="物流 / 核对" min-width="180"><template #default="{row}"><div class="batch-actions"><span>{{row.courier_company||'快递待填写'}} {{row.tracking_number||''}}</span><el-button v-if="status==='arrived'&&hasPermission(auth.user,'inventory.write')" plain size="small" @click="openLedger(row,'stocktake')">核对实物</el-button></div></template></el-table-column>
   <el-table-column label="处理" min-width="235"><template #default="{row}"><div class="batch-actions-row"><el-button v-if="status==='open'&&canConfirm" type="primary" @click="confirm(row)">确认到货</el-button><el-button v-if="status==='open'&&canConfirm" plain @click="editBatch(row)">编辑</el-button><el-button v-if="status==='open'&&canConfirm" plain type="danger" @click="editBatch(row,true)">删除</el-button><el-button v-if="status==='arrived'&&canReceive" type="primary" @click="openLedger(row,'receive')">登记入库</el-button><small v-if="status==='open'&&!canConfirm">待采购确认到货</small><small v-if="status==='arrived'&&!canReceive">待仓库验收入库</small></div></template></el-table-column>
  </el-table>
  <el-pagination v-model:current-page="page" :page-size="20" :total="total" layout="total,prev,pager,next" @current-change="load()"/>
  <BatchCorrection v-if="correction.visible" v-model="correction.visible" :product-id="correction.productId" :inbound-id="correction.inboundId" :remove="correction.remove" @saved="load();emit('changed')"/>
  <ReceiveDialog v-if="receiving.visible" v-model="receiving.visible" :product-id="receiving.id" :product-name="receiving.name" :inbound-id="receiving.batch" @saved="load();emit('changed')"/>
  <Ledger v-if="ledger.visible" v-model="ledger.visible" :product-id="ledger.id" :initial-action="ledger.action" :initial-inbound-id="ledger.batch" :stocktake-enabled="hasPermission(auth.user,'inventory.write')" @saved="load();emit('changed')"/>

 </section>
</template>
<style scoped>
.inventory-batch-queue{display:grid;gap:12px;min-width:0}.batch-product{display:flex;gap:12px;align-items:center;min-height:92px}.batch-product>div{display:grid;gap:7px}.batch-product small,.batch-queue small{color:var(--el-text-color-secondary)}.batch-product .el-button{justify-self:start;margin:0}.batch-actions-row{display:flex;gap:6px;flex-wrap:wrap}.batch-actions-row .el-button{margin:0}.batch-actions{display:grid;gap:8px;justify-items:start}.overdue{color:var(--el-color-danger)}.inventory-batch-queue>.el-pagination{justify-content:flex-end}
</style>
