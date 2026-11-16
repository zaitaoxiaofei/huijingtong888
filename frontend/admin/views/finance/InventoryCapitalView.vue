<script setup>
import {computed,defineAsyncComponent,onActivated,onDeactivated,onBeforeUnmount,onMounted,reactive,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {canAccessPage,hasPermission} from '../../../../src/shared/permissions.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import {synchronizeInventoryFbp} from '../../utils/inventory-fbp-sync.js';
import {INVENTORY_CAPITAL_REVIEWS,inventoryCapitalReviewItems} from '../../../../src/shared/inventory-capital-review.js';
import CapitalActions from '../../components/inventory/InventoryCapitalActions.vue';
import ProductImagePreview from '../../components/ProductImagePreview.vue';
const Binding=defineAsyncComponent(()=>import('../../components/inventory/InventoryCapitalBindingDialog.vue'));
const BatchPurchase=defineAsyncComponent(()=>import('../../components/inventory/InventoryBatchPurchaseDialog.vue'));
const batchPurchaseOpen=ref(false);
const BatchStocktake=defineAsyncComponent(()=>import('../../components/inventory/InventoryBatchStocktakeDialog.vue'));
const selected=ref([]),batchProducts=ref([]),batchOpen=ref(false);
const Stocktake=defineAsyncComponent(()=>import('../../components/mobile/MobileStocktakeDialog.vue'));
const Correction=defineAsyncComponent(()=>import('../../components/procurement/PurchaseBatchCorrectionDialog.vue'));
const Receive=defineAsyncComponent(()=>import('../../components/procurement/InventoryReceiveDialog.vue'));
const Ledger=defineAsyncComponent(()=>import('../../components/procurement/ProcurementLedgerDialog.vue'));
const route=useRoute(),router=useRouter(),auth=useAuthStore();
const mobile=computed(()=>!!route.meta.mobile),allowed=computed(()=>canAccessPage(auth.user,mobile.value?'/mobile/inventory-capital':'/finance/inventory-capital'));
const types=[{key:'local',name:'国内仓（可用）',hint:'货值 = 可用数量 × 成本单价。可用数量按库存公共规则扣除待发订单、FBP锁定和安全保障；采购在途不计入。'},
 {key:'fbp',name:'FBP仓',hint:'平台官方实物库存快照，按店铺、SKU和仓库逐项展示；同步后更新。'},
 {key:'transit',name:'采购在途',hint:'已登记采购、尚未验收入库的批次，包含已到货待验收；验收后移入国内仓。'}];
const kind=ref(types.some(t=>t.key===route.query.kind)?route.query.kind:'local'),query=ref(''),page=ref(1),data=ref(null),loading=ref(false),error=ref(''),syncing=ref(null);
const review=ref('all'),pageSize=ref(20);
const reviewOptions=computed(()=>INVENTORY_CAPITAL_REVIEWS.filter(item=>kind.value==='local'?['cost','availability','purchase'].includes(item.key):!item.local));
const selectedReview=computed(()=>reviewOptions.value.find(item=>item.key===review.value));
function chooseReview(value){review.value=value;page.value=1;load();}
function reviewLedger(row,tab){open('ledger',row);dialog.tab=tab||selectedReview.value?.tab||inventoryCapitalReviewItems(row)[0]?.tab||'current';}
const dialog=reactive({type:'',row:null,tab:'current'});let generation=0,controller,timer,active=true;
const category=computed(()=>types.find(t=>t.key===kind.value));
const categories=computed(()=>data.value?.summary?.categories||{});
const canWrite=computed(()=>hasPermission(auth.user,'inventory.write'));
const canPurchase=computed(()=>hasPermission(auth.user,'procurement'));
const money=(v,digits=2)=>v==null?'待核实':Number(v).toLocaleString('zh-CN',{minimumFractionDigits:digits,maximumFractionDigits:digits});
const units=v=>v==null?'待核实':`${v} 件`;
const currency=(v,digits=2)=>v==null?'待核实':`¥${money(v,digits)}`;
const time=v=>v?shanghaiDateTimeText(v,{assumeUtcWhenNaive:true}):'未记录';
const basis=row=>row.cost_basis==='purchase_batch'?'本批次货款 + 运费':row.cost_basis==='purchase_version'?`采购含运成本 · V${row.cost_version}`:'商品档案采购成本';
async function load(fresh=false){
 selected.value=[];
 const token=++generation,scope=currentApiCacheScope();controller?.abort();controller=new AbortController();
 if(!allowed.value||!['/finance/inventory-capital','/mobile/inventory-capital'].includes(route.path))return;loading.value=true;error.value='';
 try{const result=await apiClient.get('/api/finance-center/inventory-capital-details?'+new URLSearchParams({kind:kind.value,review:review.value,query:query.value.trim(),page:page.value,pageSize:pageSize.value,reuse_snapshot:1,...(fresh===true?{refresh:1}:{})}),{noCache:true,signal:controller.signal});
 if(token===generation&&scope===currentApiCacheScope()&&allowed.value)data.value=result;
 }catch(e){if(token===generation&&e.name!=='AbortError'){data.value=null;error.value=e.message||'库存占用读取失败';}}
 finally{if(token===generation)loading.value=false;}
}
function choose(value){if(kind.value===value)return;kind.value=value;review.value='all';page.value=1;data.value=null;router.replace({query:{...route.query,kind:value}});load();}
function search(){page.value=1;load();}
function pageChanged(value){if(page.value===value)return;page.value=value;load();}
function sizeChanged(value){pageSize.value=value;page.value=1;load();}
function open(type,row){dialog.type=type;dialog.row={...row};}
async function synced(row){
 if(syncing.value!=null)return;const token=generation,scope=currentApiCacheScope();syncing.value=row.row_id;
 try{await synchronizeInventoryFbp(apiClient,row.product_id,{isCurrent:()=>token===generation&&scope===currentApiCacheScope()&&allowed.value});if(token!==generation)return;ElMessage.success('官方库存已同步');syncing.value=null;await load(true);}
 catch(e){if(token===generation&&e.name!=='AbortError')ElMessage.error(e.message);}
 finally{if(token===generation)syncing.value=null;}
}
function saved(){load(true);window.dispatchEvent(new CustomEvent('erp:inventory-capital-changed'));}
function scopeChanged(){batchPurchaseOpen.value=false;batchOpen.value=false;selected.value=[];review.value='all';page.value=1;++generation;controller?.abort();data.value=null;dialog.type='';dialog.row=null;syncing.value=null;}
watch(()=>[auth.user?.id,auth.user?.tenant?.id,allowed.value,currentApiCacheScope()],()=>{scopeChanged();if(allowed.value)load();},{immediate:true});
watch(()=>route.query.kind,value=>{if(!['/finance/inventory-capital','/mobile/inventory-capital'].includes(route.path))return;const next=types.some(t=>t.key===value)?value:'local';if(next!==kind.value){kind.value=next;review.value='all';page.value=1;data.value=null;load();}});
onMounted(()=>{timer=window.setInterval(()=>{if(active&&allowed.value&&!loading.value&&!selected.value.length&&!dialog.type&&!batchOpen.value&&!batchPurchaseOpen.value&&syncing.value==null&&document.visibilityState==='visible')load();},30000);});
onActivated(()=>{active=true;load();});onDeactivated(()=>{active=false;++generation;controller?.abort();loading.value=false;});
onBeforeUnmount(()=>{clearInterval(timer);scopeChanged();});
</script>
<template>
 <div v-if="allowed" class="capital-page" :class="{'is-mobile':mobile}">
  <header><div class="page-title"><h1>库存占用</h1><span v-if="data" class="updated-at">{{time(data.snapshot_at)}} 更新</span></div><el-button :loading="loading" @click="load(true)">刷新</el-button></header>
  <el-alert v-if="error" :title="error" type="error" :closable="false"/>
  <section class="capital-summary" aria-label="库存占用分类">
   <div class="capital-total"><span>当前占用总额</span><strong>{{data?currency(data.summary.inventory_total_value):'读取中'}}</strong></div>
   <el-tooltip v-for="type in types" :key="type.key" :content="type.hint" placement="bottom" trigger="hover" :show-after="250"><button :class="{active:kind===type.key}" :aria-pressed="kind===type.key" @click="choose(type.key)"><span>{{type.name}}</span><b>{{data?currency(categories[type.key]?.value):'—'}}</b><small>{{data?units(categories[type.key]?.quantity):'读取中'}}</small></button></el-tooltip>
  </section>
  <section class="capital-details" v-loading="loading">
   <div class="details-heading"><div><h2>{{category.name}}明细</h2></div><div class="query-actions"><form @submit.prevent="search"><el-input v-model="query" clearable placeholder="库存ID / 商品名 / SKU / 批次 / 快递单号" aria-label="库存明细搜索"/><el-button native-type="submit">查询</el-button></form><div v-if="kind==='local'&&(canWrite||canPurchase)&&!mobile" class="batch-actions"><el-button v-if="canWrite" class="erp-btn erp-btn-secondary" :disabled="!selected.length||loading" @click="batchProducts=selected.map(r=>({...r}));batchOpen=true">批量更新库存（{{selected.length}}）</el-button><el-button v-if="canPurchase" class="erp-btn erp-btn-secondary" :disabled="!selected.some(r=>r.missing_purchase_quantity>0)||loading" @click="batchProducts=selected.filter(r=>r.missing_purchase_quantity>0).map(r=>({...r}));batchPurchaseOpen=true">批量补采购记录</el-button></div></div></div>
   <div v-if="data" class="result-info"><span>共 {{data.total}} 项 · {{units(data.filtered_quantity)}} · {{currency(data.filtered_value)}}</span></div>
   <div class="review-filters" aria-label="按核实问题筛选">
    <el-button :type="review==='all'?'primary':'default'" :aria-pressed="review==='all'" @click="chooseReview('all')">全部明细（{{categories[kind]?.item_count||0}}）</el-button>
    <el-tooltip v-for="item in reviewOptions" :key="item.key" :content="item.help" placement="top" :show-after="250"><el-button :type="review===item.key?'primary':'default'" :aria-pressed="review===item.key" @click="chooseReview(item.key)">{{item.label}}（{{categories[kind]?.[item.count]||0}}）</el-button></el-tooltip>
   </div>

   <template v-if="mobile">
    <article v-for="row in data?.rows||[]" :key="row.row_id" class="capital-record"><div class="product-info"><ProductImagePreview v-if="row.product_id" :src="`/api/products/${row.product_id}/image?thumb=1`" :preview-list="[`/api/products/${row.product_id}/image`]" size="portrait"/><div><b>{{row.product_name||'未绑定库存商品'}}</b><small>库存ID：{{row.inventory_number||'未分配'}} · 系统ID：{{row.product_id||'未绑定'}}</small><small>{{row.code||'未填写SKU／货号'}}</small><CapitalActions view-only :row="row" :kind="kind" :mobile="mobile" @open="(type,tab)=>type==='ledger'?reviewLedger(row,tab):open(type,row)"/></div></div><div class="record-values"><span>{{kind==='local'?'可用数量':'数量'}}<b>{{units(row.quantity)}}</b></span><span>占用金额<b>{{currency(row.inventory_value,4)}}</b></span></div><p v-if="kind==='local'">实物数量：{{units(row.physical_quantity)}}；待发订单：{{units(row.order_quantity)}}；FBP锁定：{{units(row.locked_quantity)}}；安全保障：{{units(row.safety_quantity)}}。</p><p>单价 ¥{{money(row.unit_cost,4)}} · {{basis(row)}}</p><p v-if="kind==='fbp'">{{row.shop_name}} · {{row.warehouse_name||'仓库未标明'}}<br>平台SKU：{{row.ozon_sku}}</p><p v-if="kind==='transit'">{{row.order_no||'采购批次'}} · #{{row.row_id}} · {{row.received_at?'已到货待验收':'待到货／待验收'}}<br>快递：{{row.tracking_number||'未填写'}}</p><small>{{kind==='fbp'?'官方同步':'库存记录更新'}}：{{time(row.updated_at)}}</small><div v-if="inventoryCapitalReviewItems(row).length" class="review-reasons"><el-tooltip v-for="item in inventoryCapitalReviewItems(row)" :key="item.key" :content="item.detail" placement="top"><el-tag size="small" type="warning">{{item.label}}</el-tag></el-tooltip></div><CapitalActions :row="row" :kind="kind" :mobile="mobile" :syncing="syncing" @open="(type,tab)=>type==='ledger'?reviewLedger(row,tab):open(type,row)" @sync="synced(row)" @saved="saved"/></article>
   </template>
   <el-table v-else :data="data?.rows||[]" empty-text="当前分类或搜索条件下没有库存记录" height="100%" class="capital-table" @selection-change="selected=$event">
    <el-table-column v-if="kind==='local'&&(canWrite||canPurchase)" type="selection" width="44"/>
    <el-table-column label="库存商品" min-width="310"><template #default="{row}"><div class="product-info"><ProductImagePreview v-if="row.product_id" :src="`/api/products/${row.product_id}/image?thumb=1`" :preview-list="[`/api/products/${row.product_id}/image`]" size="portrait"/><div><b>{{row.product_name||'未绑定库存商品'}}</b><small>库存ID：{{row.inventory_number||'未分配'}} · 系统ID：{{row.product_id||'未绑定'}}</small><small>{{row.code||'未填写SKU／货号'}}</small><CapitalActions view-only :row="row" :kind="kind" :mobile="mobile" @open="(type,tab)=>type==='ledger'?reviewLedger(row,tab):open(type,row)"/></div></div></template></el-table-column>
    <el-table-column v-if="kind==='local'" label="实物数量" width="105" align="right"><template #default="{row}"><el-tooltip :content="`待发订单 ${units(row.order_quantity)}；FBP锁定 ${units(row.locked_quantity)}；安全保障 ${units(row.safety_quantity)}`" placement="top"><span>{{row.physical_quantity??'待核实'}}</span></el-tooltip></template></el-table-column>
    <el-table-column :label="kind==='local'?'可用数量':'数量'" width="105" align="right"><template #default="{row}">{{row.quantity??'待核实'}}</template></el-table-column>
    <el-table-column label="采购单价" width="115" align="right"><template #default="{row}"><el-tooltip :content="basis(row)+'；人民币，保留4位小数'" placement="top"><span>{{money(row.unit_cost,4)}}</span></el-tooltip></template></el-table-column>
    <el-table-column label="占用金额" width="125" align="right"><template #default="{row}">{{money(row.inventory_value,4)}}</template></el-table-column>
    <el-table-column label="待核事项" min-width="180"><template #default="{row}"><div v-if="inventoryCapitalReviewItems(row).length" class="review-reasons"><el-tooltip v-for="item in inventoryCapitalReviewItems(row)" :key="item.key" :content="item.detail" placement="top"><el-tag size="small" type="warning">{{item.label}}</el-tag></el-tooltip></div><span v-else>—</span></template></el-table-column>
    <el-table-column v-if="kind==='fbp'" label="店铺 / 仓库 / 平台SKU" min-width="220"><template #default="{row}">{{row.shop_name}}<small>{{row.warehouse_name||'仓库未标明'}}</small><small>SKU：{{row.ozon_sku}}</small></template></el-table-column>
    <el-table-column v-if="kind==='transit'" label="采购批次 / 物流" min-width="200"><template #default="{row}">{{row.order_no||'采购批次'}} · #{{row.row_id}}<small>{{row.received_at?'已到货待验收':'待到货／待验收'}}</small><small>{{row.tracking_number||'快递未填写'}}</small></template></el-table-column>
    <el-table-column v-if="kind==='local'&&review==='purchase'" label="已发 / 采购记录 / 已入库" width="180"><template #default="{row}">{{row.shipped_quantity}} / {{row.purchase_quantity}} / {{row.received_quantity}}</template></el-table-column>
    <el-table-column label="更新时间" width="170"><template #default="{row}">{{time(row.updated_at)}}</template></el-table-column>
    <el-table-column label="操作" width="180" fixed="right"><template #default="{row}"><CapitalActions :row="row" :kind="kind" :mobile="mobile" :syncing="syncing" @open="(type,tab)=>type==='ledger'?reviewLedger(row,tab):open(type,row)" @sync="synced(row)" @saved="saved"/></template></el-table-column>
   </el-table>
   <p v-if="mobile&&data&&!data.rows.length" class="empty">当前分类或搜索条件下没有库存记录。</p>
   <div v-if="data" class="capital-pagination erp-footer-pagination">
    <template v-if="mobile"><el-button :disabled="page<=1||loading" @click="page--;load()">上一页</el-button><span>{{page}} / {{Math.max(1,Math.ceil(data.total/pageSize))}}</span><el-button :disabled="page*pageSize>=data.total||loading" @click="page++;load()">下一页</el-button></template>
    <el-pagination v-else :current-page="page" :page-size="pageSize" :page-sizes="[20,50,100]" :total="data.total" :disabled="loading" layout="total, sizes, prev, pager, next, jumper" @current-change="pageChanged" @size-change="sizeChanged"/>
   </div>
  </section>
  <BatchPurchase v-if="batchPurchaseOpen&&canPurchase" :products="batchProducts" @close="batchPurchaseOpen=false;load()" @saved="saved"/>
  <BatchStocktake v-if="batchOpen&&canWrite" :products="batchProducts" @close="batchOpen=false;load()" @saved="saved"/>
  <Stocktake v-if="['stocktake','details'].includes(dialog.type)" :read-only="dialog.type==='details'" @metadata-saved="saved" :model-value="true" :product="{id:dialog.row.product_id,name:dialog.row.product_name}" @update:model-value="v=>{if(!v)dialog.type=''}" @saved="saved"/>
  <Binding v-if="['bind','create'].includes(dialog.type)" :row="dialog.row" :initial-create="dialog.type==='create'" :mobile="mobile" @close="dialog.type=''" @saved="saved"/>
  <Correction v-if="dialog.type==='correction'" :model-value="true" :product-id="dialog.row.product_id" :inbound-id="dialog.row.row_id" @update:model-value="v=>{if(!v)dialog.type=''}" @saved="saved"/>
  <Receive v-if="dialog.type==='receive'" :model-value="true" :product-id="dialog.row.product_id" :product-name="dialog.row.product_name" :inbound-id="dialog.row.row_id" :mobile="mobile" @update:model-value="v=>{if(!v)dialog.type=''}" @saved="saved"/>
  <Ledger v-if="dialog.type==='ledger'" :model-value="true" :product-id="dialog.row.product_id" :inventory-mode="!canPurchase" :initial-tab="!canPurchase&&['purchases','history'].includes(dialog.tab)?'movements':dialog.tab" :initial-inbound-id="kind==='transit'?dialog.row.row_id:0" :full-page="mobile" @update:model-value="v=>{if(!v){dialog.type='';load()}}" @saved="saved"/>
 </div>
</template>
<style scoped>
.query-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-left:auto}.batch-actions{display:flex;gap:8px;margin:0}.batch-actions :deep(.el-button)+:deep(.el-button){margin-left:0}.review-filters{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 6px}.review-filters :deep(.el-button)+:deep(.el-button){margin-left:0}.review-reasons{display:flex;gap:6px;flex-wrap:wrap}.page-title{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.updated-at{font-size:12px;color:var(--el-text-color-secondary)}.capital-page{display:grid;gap:12px;max-width:1560px;width:100%;min-width:0;margin:auto}.capital-page>section{min-width:0}.capital-page header,.details-heading,.capital-pagination,.result-info{display:flex;align-items:center;justify-content:space-between;gap:14px}.capital-page h1{font-size:22px;margin:0}.capital-page h2{font-size:17px;margin:0}.capital-page p{font-size:13px;color:var(--el-text-color-secondary);line-height:1.6;margin:7px 0}.capital-summary{display:grid;grid-template-columns:1.1fr repeat(3,1fr);gap:8px;background:var(--el-bg-color);padding:8px;border-radius:10px;border:1px solid var(--el-border-color-lighter)}.capital-total{display:flex;gap:10px;align-items:center;padding:8px 12px}.capital-total span{font-size:13px;color:var(--el-text-color-secondary)}.capital-total strong{font-size:19px;white-space:nowrap}.capital-summary button{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;min-height:48px;text-align:left;border:1px solid transparent;border-radius:7px;padding:8px 12px;background:var(--el-bg-color);color:var(--el-text-color-primary);cursor:pointer}.capital-summary button:hover{background:var(--el-fill-color-light)}.capital-summary button>span{font-size:13px}.capital-summary button small{margin-left:auto;white-space:nowrap}.capital-summary button.active{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.capital-summary b{font-size:17px;white-space:nowrap}.capital-page small{display:block;color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}.capital-details{background:var(--el-bg-color);border:1px solid var(--el-border-color-lighter);border-radius:12px;padding:16px}.details-heading{flex-wrap:wrap}.details-heading form{display:flex;gap:8px;min-width:330px}.result-info{font-size:12px;color:var(--el-text-color-secondary);margin:10px 0;flex-wrap:wrap}.product-info{display:flex;align-items:center;gap:12px}.product-info>div{min-width:0}.capital-table :deep(.el-table__cell){padding:14px 0}.row-actions{display:flex;gap:8px;flex-wrap:wrap}.row-actions :deep(.el-button)+:deep(.el-button){margin:0}.needs-review{color:var(--el-color-warning-dark-2)!important}.capital-pagination{justify-content:flex-end;margin-top:12px;flex:none}.capital-record{border-bottom:1px solid var(--el-border-color-lighter);padding:20px 0}.record-values{display:grid;grid-template-columns:1fr 1fr;margin:14px 0;gap:12px}.record-values span{font-size:12px;color:var(--el-text-color-secondary)}.record-values b{display:block;font-size:17px;color:var(--el-text-color-primary);margin-top:5px}.capital-record .row-actions{margin-top:14px}.empty{padding:24px;text-align:center}
@media(min-width:768px){.capital-page{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}.capital-page>header,.capital-summary{flex:none}.capital-details{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}.details-heading,.result-info,.review-filters{flex:none}.capital-table{flex:1;min-height:0}.query-actions form{min-width:270px}.capital-pagination{overflow-x:auto}}
@media(max-width:720px){.capital-page{gap:12px}.capital-page h1{font-size:20px}.capital-summary{grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;padding:6px}.capital-total{grid-column:1/-1;padding:4px 8px}.capital-summary button{padding:6px;gap:4px;min-height:58px;align-content:center}.capital-summary b{font-size:15px;overflow-wrap:anywhere}.capital-summary button small{margin-left:0;width:100%}.capital-summary small{font-size:11px}.capital-details{padding:14px}.details-heading form{width:100%;min-width:0}.product-info b{overflow-wrap:anywhere}.result-info{margin:14px 0}.capital-page header{gap:8px}}
</style>
