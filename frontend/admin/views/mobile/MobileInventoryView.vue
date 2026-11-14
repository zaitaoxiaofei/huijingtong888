<script setup>
import {computed,defineAsyncComponent,onBeforeUnmount,onMounted,reactive,ref} from 'vue';
import {useRouter} from 'vue-router';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {useAuthStore} from '../../stores/auth.js';
import {canAccessPage,hasPermission} from '../../../../src/shared/permissions.js';
import {inventorySearchDefaults,appendInventorySearch} from '../../../../src/shared/inventory-search-fields.js';
import {useInventoryLocalQuantities} from '../../utils/use-inventory-local-quantities.js';
import MobileInventorySearch from '../../components/mobile/MobileInventorySearch.vue';
import MobilePagination from '../../components/mobile/MobilePagination.vue';
import InventoryCompositionBadge from '../../components/inventory/InventoryCompositionBadge.vue';
import ProductImagePreview from '../../components/ProductImagePreview.vue';
import MobileStocktakeDialog from '../../components/mobile/MobileStocktakeDialog.vue';
import MobileWorkQueue from '../../components/mobile/MobileWorkQueue.vue';
import InventoryProductEditAction from '../../components/inventory/InventoryProductEditAction.vue';
import InventoryProductHistoryAction from '../../components/inventory/InventoryProductHistoryAction.vue';
import {FullScreen} from '@element-plus/icons-vue';
const router=useRouter(),auth=useAuthStore(),rows=ref([]),total=ref(0),page=ref(1),loading=ref(false),error=ref(''),pageSize=ref(20),section=ref('stock');
const filters=reactive({...inventorySearchDefaults(),searchMode:'inventory_id',query:'',inventoryType:'all'}),dialog=reactive({visible:false,product:{},readOnly:false});
const local=useInventoryLocalQuantities(()=>rows.value),canWrite=computed(()=>hasPermission(auth.user,'inventory.write'));
const Scanner=defineAsyncComponent(()=>import('../../components/mobile/MobileInventoryScanner.vue')),scannerVisible=ref(false);
const BundleDialog=defineAsyncComponent(()=>import('../../components/inventory/InventoryBundleDialog.vue'));
const BundleDetails=defineAsyncComponent(()=>import('../../components/inventory/InventoryBundleDetails.vue'));
const bundleDialog=reactive({visible:false,id:0,editable:false}),scannedBundleId=ref(0);
function openInventory(row,readOnly){if(Number(row.component_count)>0){Object.assign(bundleDialog,{visible:true,id:Number(row.id),editable:!readOnly&&canWrite.value});return;}Object.assign(dialog,{visible:true,product:row,readOnly});}
async function scanned(number){scannerVisible.value=false;scannedBundleId.value=0;Object.assign(filters,inventorySearchDefaults(),{searchMode:'inventory_id',query:number,inventoryType:'all'});const token=version+1;await load(true);if(token===version&&filters.query===number)scannedBundleId.value=Number(rows.value.find(row=>Number(row.component_count)>0)?.id||0);}
let version=0,disposed=false;
const units=value=>value==null?'正在读取':`${Number(value)} 件`;
async function load(reset=false){scannedBundleId.value=0;if(reset)page.value=1;const token=++version,scope=currentApiCacheScope();loading.value=true;error.value='';try{const p=appendInventorySearch(new URLSearchParams({paged:'1',view:'inventory',includeStock:'0',page:String(page.value),pageSize:String(pageSize.value),query:filters.query.trim(),inventoryType:filters.inventoryType}),filters);const r=await apiClient.get('/api/products?'+p,{noCache:true});if(disposed||token!==version||scope!==currentApiCacheScope())return;rows.value=r.rows||[];total.value=Number(r.total||0);document.querySelector('.mobile-inventory-page>.mobile-list-scroll')?.scrollTo(0,0);}catch(e){if(token===version&&scope===currentApiCacheScope())error.value=e.message;}finally{if(token===version)loading.value=false;}}
function changePage(value){page.value=value.page;pageSize.value=value.pageSize;load();}
function reset(){Object.assign(filters,inventorySearchDefaults(),{searchMode:'inventory_id',query:'',inventoryType:'all'});load(true);}
async function saved(){await load();await local.refresh(true);}
async function metadataSaved(value){if(dialog.visible&&Number(value?.product?.id)===Number(dialog.product.id))dialog.product={...dialog.product,...value.product};await saved();}
function clearScope(){++version;rows.value=[];total.value=0;dialog.visible=false;scannerVisible.value=false;bundleDialog.visible=false;scannedBundleId.value=0;}
onMounted(()=>{load();window.addEventListener('erp:auth-scope-changed',clearScope);});onBeforeUnmount(()=>{disposed=true;clearScope();window.removeEventListener('erp:auth-scope-changed',clearScope);});
</script>
<template><div class="mobile-inventory-page mobile-list-page"><nav class="mobile-inventory-tabs"><el-button v-if="canAccessPage(auth.user,'/mobile/inventory-capital')" @click="router.push('/mobile/inventory-capital')">库存占用</el-button><el-button :type="section==='stock'?'primary':''" @click="section='stock'">商品库存</el-button><el-button :type="section==='receiving'?'primary':''" @click="section='receiving'">采购收货</el-button><el-button :type="section==='fbp'?'primary':''" @click="section='fbp'">核验 FBP 入仓</el-button></nav><MobileWorkQueue v-if="section==='receiving'" warehouse/><section v-else-if="section==='fbp'" class="mobile-record"><h3>核验 FBP 入仓</h3><p class="mobile-muted">FBP 入仓逐项核验暂在电脑端完成。请在电脑端打开采购工作台的「FBP入库确认」，核对批次、店铺和SKU后再确认。</p></section><template v-else>
 <div class="mobile-list-controls"><MobileInventorySearch :filters="filters" :loading="loading" @search="load(true)" @reset="reset"><template #actions><el-button type="success" plain class="mobile-inventory-scan-button" @click="scannerVisible=true"><el-icon><FullScreen/></el-icon><span>扫一扫</span></el-button></template></MobileInventorySearch>
 <el-alert v-if="error" :title="error" type="warning" :closable="false"/><p v-if="local.error.value" class="mobile-muted">{{local.error.value}}，可点击库存明细重新核对。</p>
 </div><div class="mobile-list-scroll"><article v-for="row in rows" :key="row.id" class="mobile-record"><div class="mobile-record-head"><ProductImagePreview :src="`/api/products/${row.id}/image?thumb=1`" :preview-list="[`/api/products/${row.id}/image`]" size="portrait"/><div><h3>{{row.name}}</h3><small>库存 {{row.inventory_number||row.code||row.id}}</small><InventoryCompositionBadge :product="row" trigger="click" width="min(400px,92vw)"/></div></div><div class="mobile-record-grid"><span>本地实物<b>{{units(local.rows.value.get(Number(row.id))?.physical_stock)}}</b></span><span>可用库存<b>{{units(local.rows.value.get(Number(row.id))?.workflow_free)}}</b></span></div><div class="mobile-record-actions"><el-button @click="openInventory(row,true)">{{Number(row.component_count)>0?'套装明细':'库存明细'}}</el-button><InventoryProductEditAction :product-id="Number(row.id)" mobile @saved="metadataSaved"/><InventoryProductHistoryAction :product-id="Number(row.id)" mobile/><el-button v-if="canWrite" type="primary" @click="openInventory(row,false)">更新库存</el-button></div><BundleDetails v-if="Number(row.id)===scannedBundleId" :product-id="Number(row.id)" embedded/></article>
 <p v-if="!rows.length&&!loading&&!error" class="mobile-muted">没有找到库存商品，请调整筛选条件。</p></div><MobilePagination :page="page" :page-size="pageSize" :total="total" :loading="loading" @change="changePage"/>

 <MobileStocktakeDialog v-if="dialog.visible" v-model="dialog.visible" :product="dialog.product" :read-only="dialog.readOnly" @saved="saved" @metadata-saved="metadataSaved"/>
 <BundleDialog v-if="bundleDialog.visible" v-model="bundleDialog.visible" :product-id="bundleDialog.id" :editable="bundleDialog.editable&&canWrite" mobile @saved="saved"/>
 <Scanner v-if="scannerVisible" v-model="scannerVisible" @scanned="scanned"/>
</template></div></template>
<style scoped>.mobile-inventory-page{min-width:0}.mobile-inventory-page>.mobile-work-queue{height:auto;flex:1;min-height:0}.mobile-inventory-tabs{flex:none;display:flex;gap:8px;flex-wrap:wrap}.mobile-inventory-tabs .el-button{margin:0}.mobile-inventory-scan-button{background:var(--erp-success-bg)!important;border-color:var(--erp-success-border)!important;color:var(--erp-success-text)!important}.mobile-inventory-scan-button .el-icon{font-size:19px;margin-right:5px}</style>
