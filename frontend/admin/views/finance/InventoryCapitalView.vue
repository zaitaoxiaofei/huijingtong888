<script setup>
import {computed,defineAsyncComponent,onActivated,onDeactivated,onBeforeUnmount,onMounted,reactive,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {ElMessage} from 'element-plus';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {canAccessPage,hasPermission} from '../../../../src/shared/permissions.js';
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
import {synchronizeInventoryFbp} from '../../utils/inventory-fbp-sync.js';
import ProductImagePreview from '../../components/ProductImagePreview.vue';
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
const dialog=reactive({type:'',row:null});let generation=0,controller,timer,active=true;
const category=computed(()=>types.find(t=>t.key===kind.value));
const categories=computed(()=>data.value?.summary?.categories||{});
const canWrite=computed(()=>hasPermission(auth.user,'inventory.write')),canPurchase=computed(()=>hasPermission(auth.user,'procurement'));
const money=(v,digits=2)=>v==null?'待核实':Number(v).toLocaleString('zh-CN',{minimumFractionDigits:digits,maximumFractionDigits:digits});
const units=v=>v==null?'待核实':`${v} 件`;
const currency=(v,digits=2)=>v==null?'待核实':`¥${money(v,digits)}`;
const time=v=>v?shanghaiDateTimeText(v,{assumeUtcWhenNaive:true}):'未记录';
const basis=row=>row.cost_basis==='purchase_batch'?'本批次货款 + 运费':row.cost_basis==='purchase_version'?`采购含运成本 · V${row.cost_version}`:'商品档案采购成本';
async function load(){
 const token=++generation,scope=currentApiCacheScope();controller?.abort();controller=new AbortController();
 if(!allowed.value||!['/finance/inventory-capital','/mobile/inventory-capital'].includes(route.path))return;loading.value=true;error.value='';
 try{const result=await apiClient.get('/api/finance-center/inventory-capital-details?'+new URLSearchParams({kind:kind.value,query:query.value.trim(),page:page.value,pageSize:20}),{noCache:true,signal:controller.signal});
 if(token===generation&&scope===currentApiCacheScope()&&allowed.value)data.value=result;
 }catch(e){if(token===generation&&e.name!=='AbortError'){data.value=null;error.value=e.message||'库存占用读取失败';}}
 finally{if(token===generation)loading.value=false;}
}
function choose(value){if(kind.value===value)return;kind.value=value;page.value=1;data.value=null;router.replace({query:{...route.query,kind:value}});load();}
function search(){page.value=1;load();}
function open(type,row){dialog.type=type;dialog.row={...row};}
async function synced(row){
 if(syncing.value!=null)return;const token=generation,scope=currentApiCacheScope();syncing.value=row.row_id;
 try{await synchronizeInventoryFbp(apiClient,row.product_id,{isCurrent:()=>token===generation&&scope===currentApiCacheScope()&&allowed.value});if(token!==generation)return;ElMessage.success('官方库存已同步');syncing.value=null;await load();}
 catch(e){if(token===generation&&e.name!=='AbortError')ElMessage.error(e.message);}
 finally{if(token===generation)syncing.value=null;}
}
function saved(){load();window.dispatchEvent(new CustomEvent('erp:inventory-capital-changed'));}
function scopeChanged(){++generation;controller?.abort();data.value=null;dialog.type='';dialog.row=null;syncing.value=null;}
watch(()=>[auth.user?.id,auth.user?.tenant?.id,allowed.value,currentApiCacheScope()],()=>{scopeChanged();if(allowed.value)load();},{immediate:true});
watch(()=>route.query.kind,value=>{if(!['/finance/inventory-capital','/mobile/inventory-capital'].includes(route.path))return;const next=types.some(t=>t.key===value)?value:'local';if(next!==kind.value){kind.value=next;page.value=1;data.value=null;load();}});
onMounted(()=>{timer=window.setInterval(()=>{if(active&&allowed.value&&!loading.value&&!dialog.type&&syncing.value==null&&document.visibilityState==='visible')load();},30000);});
onActivated(()=>{active=true;load();});onDeactivated(()=>{active=false;++generation;controller?.abort();loading.value=false;});
onBeforeUnmount(()=>{clearInterval(timer);scopeChanged();});
</script>
<template>
 <div v-if="allowed" class="capital-page" :class="{'is-mobile':mobile}">
  <header><div><h1>库存占用</h1><p>按商品核对数量和资金 · 人民币 · 每30秒刷新账面数据</p></div><el-button :loading="loading" @click="load">刷新</el-button></header>
  <el-alert v-if="error" :title="error" type="error" :closable="false"/>
  <section class="capital-summary" aria-label="库存占用分类">
   <div class="capital-total"><span>当前占用总额</span><strong>{{data?currency(data.summary.inventory_total_value):'读取中'}}</strong><small>{{data?time(data.snapshot_at)+' 更新':'正在读取当前库存'}}</small></div>
   <button v-for="type in types" :key="type.key" :class="{active:kind===type.key}" :aria-pressed="kind===type.key" @click="choose(type.key)"><span>{{type.name}}</span><b>{{data?currency(categories[type.key]?.value):'—'}}</b><small>{{data?units(categories[type.key]?.quantity):'读取中'}} · 查看明细</small></button>
  </section>
  <section class="capital-details" v-loading="loading">
   <div class="details-heading"><div><h2>{{category.name}}明细</h2><p>{{category.hint}}</p></div><form @submit.prevent="search"><el-input v-model="query" clearable placeholder="库存ID / 商品名 / SKU / 批次 / 快递单号" aria-label="库存明细搜索"/><el-button native-type="submit">查询</el-button></form></div>
   <div v-if="data" class="result-info"><span>共 {{data.total}} 项 · {{units(data.filtered_quantity)}} · {{currency(data.filtered_value)}}</span><span>成本与明细金额保留4位小数，合计按原值汇总。</span></div>
   <el-alert v-if="categories[kind]?.missing_cost_count||categories[kind]?.unmapped_count||categories[kind]?.unclassified_count" type="warning" :closable="false"><template #title>需核实：{{categories[kind]?.missing_cost_count||0}} 项成本缺失或为零，{{categories[kind]?.unmapped_count||0}} 项未绑定库存，{{categories[kind]?.unclassified_count||0}} 项含历史未标明库位流水；显示的金额可能不完整。</template></el-alert>
   <el-alert v-if="kind==='local'&&categories.local?.availability_unknown_count" type="warning" :closable="false" :title="`${categories.local.availability_unknown_count} 项可用库存待核实，国内仓货值与总额暂不完整；请先盘点或核对库存规则。`" />
   <template v-if="mobile">
    <article v-for="row in data?.rows||[]" :key="row.row_id" class="capital-record"><div class="product-info"><ProductImagePreview v-if="row.product_id" :src="`/api/products/${row.product_id}/image?thumb=1`" :preview-list="[`/api/products/${row.product_id}/image`]" size="portrait"/><div><b>{{row.product_name||'未绑定库存商品'}}</b><small>库存ID：{{row.inventory_number||'未分配'}} · 系统ID：{{row.product_id||'未绑定'}}</small><small>{{row.code||'未填写SKU／货号'}}</small></div></div><div class="record-values"><span>{{kind==='local'?'可用数量（计价）':'数量'}}<b>{{units(row.quantity)}}</b></span><span>占用金额<b>{{currency(row.inventory_value,4)}}</b></span></div><p v-if="kind==='local'">账面实物：{{units(row.physical_quantity)}}；待发订单：{{units(row.order_quantity)}}；FBP锁定：{{units(row.locked_quantity)}}；安全保障：{{units(row.safety_quantity)}}。</p><p>单价 ¥{{money(row.unit_cost,4)}} · {{basis(row)}}</p><p v-if="kind==='fbp'">{{row.shop_name}} · {{row.warehouse_name||'仓库未标明'}}<br>平台SKU：{{row.ozon_sku}}</p><p v-if="kind==='transit'">{{row.order_no||'采购批次'}} · #{{row.row_id}} · {{row.received_at?'已到货待验收':'待到货／待验收'}}<br>快递：{{row.tracking_number||'未填写'}}</p><small>{{kind==='fbp'?'官方同步':'库存记录更新'}}：{{time(row.updated_at)}}</small><p v-if="row.cost_missing||!row.product_id||row.unclassified_movements" class="needs-review">{{row.availability_unknown?'可用数量待核实；':''}}{{row.cost_missing?'成本待核实；':''}}{{!row.product_id?'请先核对SKU绑定；':''}}{{row.unclassified_movements?'含历史未标明库位流水':''}}</p><div class="row-actions"><el-button v-if="kind==='local'&&row.product_id&&canWrite" type="primary" @click="open('stocktake',row)">盘点更新数量</el-button><el-button v-if="kind==='fbp'&&row.product_id&&canWrite" :loading="syncing===row.row_id" :disabled="syncing!=null" @click="synced(row)">同步官方数量</el-button><el-button v-if="kind==='transit'&&row.product_id&&canPurchase" type="primary" @click="open('receive',row)">验收入库</el-button><el-button v-if="row.product_id&&canPurchase" @click="open(kind==='transit'&&!row.received_at?'correction':'ledger',row)">{{kind==='transit'&&!row.received_at?'修改批次数量／金额':'核对成本与流水'}}</el-button></div></article>
   </template>
   <el-table v-else :data="data?.rows||[]" empty-text="当前分类或搜索条件下没有库存记录" class="capital-table">
    <el-table-column label="库存商品" min-width="310"><template #default="{row}"><div class="product-info"><ProductImagePreview v-if="row.product_id" :src="`/api/products/${row.product_id}/image?thumb=1`" :preview-list="[`/api/products/${row.product_id}/image`]" size="portrait"/><div><b>{{row.product_name||'未绑定库存商品'}}</b><small>库存ID：{{row.inventory_number||'未分配'}} · 系统ID：{{row.product_id||'未绑定'}}</small><small>{{row.code||'未填写SKU／货号'}}</small><small v-if="row.unclassified_movements" class="needs-review">含历史未标明库位流水</small></div></div></template></el-table-column>
    <el-table-column v-if="kind==='local'" label="账面实物 / 扣减明细" min-width="175"><template #default="{row}">实物 {{units(row.physical_quantity)}}<small>待发订单 {{units(row.order_quantity)}}</small><small>FBP锁定 {{units(row.locked_quantity)}}</small><small>安全保障 {{units(row.safety_quantity)}}</small></template></el-table-column><el-table-column :label="kind==='local'?'可用数量（计价）':'数量'" width="135" align="right"><template #default="{row}">{{row.quantity==null?'待核实':row.quantity}}</template></el-table-column><el-table-column label="单价（元）" width="130" align="right"><template #default="{row}">{{money(row.unit_cost,4)}}</template></el-table-column><el-table-column label="占用金额（元）" width="150" align="right"><template #default="{row}">{{money(row.inventory_value,4)}}<small v-if="row.cost_missing" class="needs-review">成本待核实</small></template></el-table-column>
    <el-table-column label="成本来源" min-width="165"><template #default="{row}">{{basis(row)}}</template></el-table-column>
    <el-table-column v-if="kind==='fbp'" label="店铺 / 仓库 / 平台SKU" min-width="220"><template #default="{row}">{{row.shop_name}}<small>{{row.warehouse_name||'仓库未标明'}}</small><small>SKU：{{row.ozon_sku}}</small></template></el-table-column>
    <el-table-column v-if="kind==='transit'" label="采购批次 / 物流" min-width="200"><template #default="{row}">{{row.order_no||'采购批次'}} · #{{row.row_id}}<small>{{row.received_at?'已到货待验收':'待到货／待验收'}}</small><small>{{row.tracking_number||'快递未填写'}}</small></template></el-table-column>
    <el-table-column :label="kind==='fbp'?'官方同步时间':'库存记录更新时间'" width="180"><template #default="{row}">{{time(row.updated_at)}}</template></el-table-column>
    <el-table-column label="核对与更新" width="200" fixed="right"><template #default="{row}"><div class="row-actions"><el-button v-if="kind==='local'&&row.product_id&&canWrite" link type="primary" @click="open('stocktake',row)">盘点更新数量</el-button><el-button v-if="kind==='fbp'&&row.product_id&&canWrite" link type="primary" :loading="syncing===row.row_id" :disabled="syncing!=null" @click="synced(row)">同步官方数量</el-button><el-button v-if="kind==='transit'&&row.product_id&&canPurchase" link type="primary" @click="open('receive',row)">验收入库</el-button><el-button v-if="row.product_id&&canPurchase" link @click="open(kind==='transit'&&!row.received_at?'correction':'ledger',row)">{{kind==='transit'&&!row.received_at?'修改批次数量／金额':'核对成本与流水'}}</el-button><span v-if="!row.product_id">请先在SKU绑定中关联库存</span></div></template></el-table-column>
   </el-table>
   <p v-if="mobile&&data&&!data.rows.length" class="empty">当前分类或搜索条件下没有库存记录。</p>
   <div v-if="data" class="capital-pagination"><el-button :disabled="page<=1||loading" @click="page--;load()">上一页</el-button><span>{{page}} / {{Math.max(1,Math.ceil(data.total/20))}}</span><el-button :disabled="page*20>=data.total||loading" @click="page++;load()">下一页</el-button></div>
  </section>
  <Stocktake v-if="dialog.type==='stocktake'" :model-value="true" :product="{id:dialog.row.product_id,name:dialog.row.product_name}" @update:model-value="v=>{if(!v)dialog.type=''}" @saved="saved"/>
  <Correction v-if="dialog.type==='correction'" :model-value="true" :product-id="dialog.row.product_id" :inbound-id="dialog.row.row_id" @update:model-value="v=>{if(!v)dialog.type=''}" @saved="saved"/>
  <Receive v-if="dialog.type==='receive'" :model-value="true" :product-id="dialog.row.product_id" :product-name="dialog.row.product_name" :inbound-id="dialog.row.row_id" :mobile="mobile" @update:model-value="v=>{if(!v)dialog.type=''}" @saved="saved"/>
  <Ledger v-if="dialog.type==='ledger'" :model-value="true" :product-id="dialog.row.product_id" :initial-tab="'purchases'" :initial-inbound-id="kind==='transit'?dialog.row.row_id:0" :full-page="mobile" @update:model-value="v=>{if(!v){dialog.type='';load()}}" @saved="saved"/>
 </div>
</template>
<style scoped>
.capital-page{display:grid;gap:22px;max-width:1560px;margin:auto}.capital-page header,.details-heading,.capital-pagination,.result-info{display:flex;align-items:center;justify-content:space-between;gap:14px}.capital-page h1{font-size:22px;margin:0}.capital-page h2{font-size:17px;margin:0}.capital-page p{font-size:13px;color:var(--el-text-color-secondary);line-height:1.6;margin:7px 0}.capital-summary{display:grid;grid-template-columns:1.2fr repeat(3,1fr);gap:14px;background:var(--el-bg-color);padding:24px;border-radius:12px;border:1px solid var(--el-border-color-lighter)}.capital-total,.capital-summary button{display:grid;gap:10px}.capital-total strong{font-size:26px}.capital-summary button{text-align:left;border:1px solid var(--el-border-color-lighter);border-radius:9px;padding:16px;background:var(--el-bg-color);color:var(--el-text-color-primary);cursor:pointer}.capital-summary button.active{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.capital-summary b{font-size:21px}.capital-page small{display:block;color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}.capital-details{background:var(--el-bg-color);border:1px solid var(--el-border-color-lighter);border-radius:12px;padding:24px}.details-heading{flex-wrap:wrap}.details-heading form{display:flex;gap:8px;min-width:330px}.result-info{font-size:12px;color:var(--el-text-color-secondary);margin:18px 0;flex-wrap:wrap}.product-info{display:flex;align-items:center;gap:12px}.product-info>div{min-width:0}.capital-table :deep(.el-table__cell){padding:14px 0}.row-actions{display:flex;gap:8px;flex-wrap:wrap}.row-actions :deep(.el-button)+:deep(.el-button){margin:0}.needs-review{color:var(--el-color-warning-dark-2)!important}.capital-pagination{justify-content:center;margin-top:20px}.capital-record{border-bottom:1px solid var(--el-border-color-lighter);padding:20px 0}.record-values{display:grid;grid-template-columns:1fr 1fr;margin:14px 0;gap:12px}.record-values span{font-size:12px;color:var(--el-text-color-secondary)}.record-values b{display:block;font-size:17px;color:var(--el-text-color-primary);margin-top:5px}.capital-record .row-actions{margin-top:14px}.empty{padding:24px;text-align:center}
@media(max-width:720px){.capital-page{gap:12px}.capital-page h1{font-size:20px}.capital-summary{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:14px}.capital-total{grid-column:1/-1;padding-bottom:12px}.capital-summary button{padding:12px 8px;gap:7px}.capital-summary b{font-size:15px;overflow-wrap:anywhere}.capital-summary small{font-size:11px}.capital-details{padding:14px}.details-heading form{width:100%;min-width:0}.product-info b{overflow-wrap:anywhere}.result-info{margin:14px 0}.capital-page header{gap:8px}}
</style>
