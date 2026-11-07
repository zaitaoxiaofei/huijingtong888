<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient, currentApiCacheScope } from "../../utils/api";
import MobileDialog from '../../components/mobile/MobileDialog.vue';
import MobilePagination from '../../components/mobile/MobilePagination.vue';
import MobileStocktakeDialog from '../../components/mobile/MobileStocktakeDialog.vue';
import MobileOrderProfitDetails from '../../components/mobile/MobileOrderProfitDetails.vue';
import ProductImagePreview from '../../components/ProductImagePreview.vue';
import MobileInventorySearch from '../../components/mobile/MobileInventorySearch.vue';
import {inventorySearchDefaults,appendInventorySearch} from '../../../../src/shared/inventory-search-fields.js';
import {useInventoryLocalQuantities} from '../../utils/use-inventory-local-quantities.js';
import { money, shortText } from "./mobile-orders-utils.js";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const procurementLoading = ref(false);
const creatingProcurement = ref(false);
const bindingVisible = ref(false);
const bindingLoading = ref(false);
const bindingSubmitting = ref(false);
const productOptionsLoading = ref(false);
const detail = ref(null);
const procurement = ref(null);
const productOptions = ref([]);
const peopleOptions = ref([]);
const bindingFilters=reactive({...inventorySearchDefaults(),inventoryType:'all',searchMode:'inventory_id',query:''}),bindingPageSize=ref(20),bindingPage=ref(1),bindingTotal=ref(0),bindingError=ref(''),bindingSearched=ref(false),bindingOwnerExpanded=ref(false),selectedProduct=ref(null),previewProduct=ref(null),bindList=ref(null);
const bindingLocal=useInventoryLocalQuantities(()=>productOptions.value);
let bindingVersion=0,detailVersion=0,disposed=false;
const inventoryType=product=>Number(product.component_count)>0?'套装':Number(product.is_accessory)?'配件':'单品';
const inventoryQuantity=(product,key)=>{const value=bindingLocal.rows.value.get(Number(product.id))?.[key];return value==null?'待核对':`${value} 件`;};
function selectBindingProduct(product){selectedProduct.value=product;bindingForm.product_id=String(product.id);}
function resetBindingScope(){++bindingVersion;++detailVersion;bindingVisible.value=false;bindingItem.value=null;Object.assign(bindingForm,{product_id:'',person_id:'',query:''});previewProduct.value=null;selectedProduct.value=null;productOptions.value=[];peopleOptions.value=[];detail.value=null;procurement.value=null;}

const bindingItem = ref(null);
const autoBindOpened = ref(false);
const bindingForm = reactive({
  product_id: "",
  person_id: "",
});

const orderId = computed(() => Number(route.params.id || 0));
const order = computed(() => detail.value?.order || {});
const items = computed(() => Array.isArray(detail.value?.items) ? detail.value.items : []);
const unboundItems = computed(() => items.value.filter((item) => !item.product_name && !item.product_code));
const purchasableProducts = computed(() => Array.isArray(procurement.value?.products) ? procurement.value.products : []);

async function loadDetail() {
  if (!orderId.value) return;
  const token=++detailVersion,scope=currentApiCacheScope();
  loading.value = true;
  try {
    const result = await apiClient.get(`/api/orders/${orderId.value}`, { noCache: true });
    if(disposed||token!==detailVersion||scope!==currentApiCacheScope())return;
    detail.value=result;
    await loadProcurementPreview();
    if(disposed||token!==detailVersion||scope!==currentApiCacheScope())return;
    await maybeOpenRouteBindDialog();
  } catch (error) {
    ElMessage.error(error.message || "订单详情加载失败");
  } finally {
    loading.value = false;
  }
}

async function loadProcurementPreview() {
  const scope=currentApiCacheScope();
  procurementLoading.value = true;
  try {
    const result = await apiClient.get(`/api/orders/${orderId.value}/procurement-preview`, { noCache: true });
    if(!disposed&&scope===currentApiCacheScope())procurement.value=result;
  } catch (error) {
    procurement.value = null;
    console.warn("load mobile procurement preview failed", error);
  } finally {
    procurementLoading.value = false;
  }
}

async function loadPeopleOptions() {
  if (peopleOptions.value.length) return;
  const scope=currentApiCacheScope();
  try {
    const result = await apiClient.get("/api/people", { noCache: true });
    if(disposed||scope!==currentApiCacheScope())return;
    peopleOptions.value = Array.isArray(result) ? result.filter((item) => Number(item.active) !== 0) : [];
  } catch (error) {
    peopleOptions.value = [];
    console.warn("load mobile people options failed", error);
  }
}

async function loadProductOptions(query = "",page=1) {
  const token=++bindingVersion,scope=currentApiCacheScope();productOptionsLoading.value=true;bindingError.value='';bindingSearched.value=true;
  try {
    const params=appendInventorySearch(new URLSearchParams({paged:'1',view:'inventory',includeStock:'0',page:String(page),pageSize:String(bindingPageSize.value),query:String(query||'').trim(),inventoryType:bindingFilters.inventoryType}),bindingFilters);
    const result=await apiClient.get(`/api/products?${params}`,{noCache:true});
    if(disposed||token!==bindingVersion||scope!==currentApiCacheScope()||!bindingVisible.value)return;
    productOptions.value=Array.isArray(result?.rows)?result.rows:[];bindingTotal.value=Number(result.total||0);bindingPage.value=page;
    bindList.value?.closest('.mobile-dialog-content')?.scrollTo(0,0);
  }catch(error){if(token===bindingVersion&&scope===currentApiCacheScope())bindingError.value=error.message||'候选库存加载失败，请重试';}
  finally{if(token===bindingVersion)productOptionsLoading.value=false;}
}

async function openMobileBind(item = {}) {
  if (!item.online_product_id) {
    ElMessage.warning("这条订单商品还没有匹配到在线商品，请先同步在线商品后再绑定");
    return;
  }
  bindingItem.value = item;
  selectedProduct.value=null;previewProduct.value=null;bindingSearched.value=false;bindingPageSize.value=20;bindingOwnerExpanded.value=false;bindingPage.value=1;bindingTotal.value=0;productOptions.value=[];
  Object.assign(bindingFilters,inventorySearchDefaults(),{inventoryType:'all',searchMode:'inventory_id',query:''});
  bindingForm.product_id = "";
  bindingForm.person_id = "";
  bindingFilters.query = "";
  bindingVisible.value = true;
  bindingLoading.value = true;
  try {
    await Promise.all([
      loadProductOptions(bindingFilters.query)
    ]);
  } finally {
    bindingLoading.value = false;
  }
}

function toggleBindingOwner(){bindingOwnerExpanded.value=!bindingOwnerExpanded.value;if(bindingOwnerExpanded.value)void loadPeopleOptions();}

function resetBindingFilters(){Object.assign(bindingFilters,inventorySearchDefaults(),{inventoryType:'all',searchMode:'inventory_id',query:''});return searchBindingProducts();}
function changeBindingPage(value){bindingPageSize.value=value.pageSize;return loadProductOptions(bindingFilters.query,value.page);}

async function searchBindingProducts() {
  await loadProductOptions(bindingFilters.query);
}

async function submitMobileBind() {
  if(bindingSubmitting.value)return;
  const scope=currentApiCacheScope();
  const onlineProductId = Number(bindingItem.value?.online_product_id || 0);
  if (!onlineProductId) {
    ElMessage.warning("没有找到可绑定的在线商品");
    return;
  }
  if (!bindingForm.product_id) {
    ElMessage.warning("请选择要绑定的库存商品");
    return;
  }
  bindingSubmitting.value = true;
  try {
    await apiClient.post("/api/online-products/bind", {
      online_product_id: onlineProductId,
      product_id: Number(bindingForm.product_id),
      person_id: bindingForm.person_id ? Number(bindingForm.person_id) : null
    });
    if(disposed||scope!==currentApiCacheScope())return;
    ElMessage.success("库存绑定成功");
    bindingVisible.value = false;
    await loadDetail();
  } catch (error) {
    if(scope===currentApiCacheScope())ElMessage.error(error.message || "绑定库存失败");
  } finally {
    bindingSubmitting.value = false;
  }
}

async function maybeOpenRouteBindDialog() {
  if (autoBindOpened.value || String(route.query.action || "") !== "bind") return;
  autoBindOpened.value = true;
  const targetSku = String(route.query.sku || "");
  const target = items.value.find((item) => {
    if (item.product_name || item.product_code) return false;
    if (!targetSku) return true;
    return String(item.ozon_sku || "") === targetSku;
  });
  if (target) await openMobileBind(target);
}

function openMobileProcurement() {
  router.push("/mobile/procurement");
}

function productPurchasePayload() {
  return purchasableProducts.value.map((product) => ({
    product_id: Number(product.product_id || product.id || 0),
    quantity: Math.max(0, Number(product.purchase_quantity ?? product.shortage_quantity ?? product.quantity ?? 0)),
    amount: Number(product.purchase_cost || product.amount || 0),
    shipping_amount: Number(product.shipping_amount || 0)
  })).filter((item) => item.product_id);
}

async function createProcurement() {
  if (!purchasableProducts.value.length) {
    ElMessage.info("当前订单没有可直接创建的采购项");
    return;
  }
  try {
    await ElMessageBox.confirm("确认根据当前订单创建采购需求？", "创建采购需求", {
      type: "warning",
      confirmButtonText: "确认创建",
      cancelButtonText: "取消"
    });
    creatingProcurement.value = true;
    const result = await apiClient.post(`/api/orders/${orderId.value}/procurement-requests`, {
      urgency: "normal",
      product_purchases: productPurchasePayload()
    });
    ElMessage.success(`已创建 ${Number(result.created_count || 0)} 条采购需求`);
    await loadProcurementPreview();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "采购需求创建失败");
  } finally {
    creatingProcurement.value = false;
  }
}

onMounted(() => {loadDetail();window.addEventListener('erp:auth-scope-changed',resetBindingScope);});
onBeforeUnmount(()=>{disposed=true;resetBindingScope();window.removeEventListener('erp:auth-scope-changed',resetBindingScope);});
</script>

<template>
  <div class="mobile-detail-page" v-loading="loading">
    <section class="mobile-detail-hero">
      <span>{{ shortText(order.shop_name, "店铺") }}</span>
      <h1>{{ shortText(order.posting_number || order.order_number, "订单详情") }}</h1>
      <div class="mobile-detail-hero__facts">
        <strong>{{ shortText(order.status || order.tracking_stage, "状态未知") }}</strong>
        <strong>{{ money(order.revenue || order.total_price, "₽") }}</strong>
      </div>
    </section>

    <section class="mobile-section">
      <div class="mobile-section__head">
        <h2>商品明细</h2>
        <span>{{ items.length }} 项</span>
      </div>
      <article v-for="item in items" :key="item.id" class="mobile-item-card">
        <img v-if="item.image_url" :src="item.image_url" alt="">
        <div v-else class="mobile-item-card__fallback">SKU</div>
        <div class="mobile-item-card__main">
          <h3>{{ shortText(item.product_name || item.ozon_name, "未绑定商品") }}</h3>
          <p>Ozon SKU：{{ shortText(item.ozon_sku) }}</p>
          <p>货号：{{ shortText(item.offer_id || item.product_code) }}</p>
          <div class="mobile-item-card__chips">
            <span>数量 {{ Number(item.quantity || 0) }}</span>
            <span>{{ money(item.sale_price, "₽") }}</span>
            <span :class="{ danger: !item.product_name && !item.product_code }">
              {{ item.product_name || item.product_code ? "已绑定" : "待绑定" }}
            </span>
          </div>
          <button
            v-if="!item.product_name && !item.product_code"
            type="button"
            @click="openMobileBind(item)"
          >
            去绑定库存
          </button>
        </div>
      </article>
    </section>

    <section class="mobile-section">
      <div class="mobile-section__head">
        <h2>库存与采购</h2>
        <span v-if="procurementLoading">检查中</span>
        <span v-else>{{ purchasableProducts.length }} 个采购项</span>
      </div>

      <div v-if="unboundItems.length" class="mobile-warning">
        <strong>还有 {{ unboundItems.length }} 个商品未绑定库存</strong>
        <span>先完成绑定后，采购建议会更准确。</span>
      </div>

      <article v-for="product in purchasableProducts" :key="product.product_id || product.id" class="mobile-proc-card">
        <strong>{{ shortText(product.product_name || product.name || product.ozon_sku, "采购商品") }}</strong>
        <span>建议采购：{{ Number(product.purchase_quantity ?? product.shortage_quantity ?? product.quantity ?? 0) }}</span>
        <span>当前库存：{{ Number(product.current_stock || product.stock || 0) }}</span>
      </article>

      <el-button
        type="primary"
        class="mobile-primary-action"
        :loading="creatingProcurement"
        @click="createProcurement"
      >
        创建采购需求
      </el-button>
      <el-button class="mobile-secondary-action" @click="openMobileProcurement">
        打开采购页面
      </el-button>
      <el-button class="mobile-secondary-action" :loading="procurementLoading" @click="loadProcurementPreview">
        刷新采购建议
      </el-button>
    </section>

    <MobileOrderProfitDetails v-if="detail" :key="order.id || orderId" :detail="detail" />

    <MobileDialog v-model="bindingVisible" title="绑定库存" mode="sheet" class="mobile-bind-dialog" :show-close="!bindingSubmitting" :close-on-press-escape="!bindingSubmitting" destroy-on-close>
      <template #tools>
        <div class="mobile-bind-tools">
          <details v-if="bindingItem" class="mobile-bind-target"><summary>{{shortText(bindingItem.ozon_name||bindingItem.online_product_name||bindingItem.ozon_sku,'待绑定商品')}}</summary><div class="mobile-bind-source"><ProductImagePreview v-if="bindingItem.image_url" :src="bindingItem.image_url" size="portrait"/><div><small>{{order.shop_name}} · SKU {{bindingItem.ozon_sku}}</small><small>货号 {{bindingItem.offer_id||'未记录'}}</small></div></div></details>
          <MobileInventorySearch :filters="bindingFilters" :loading="productOptionsLoading" @search="searchBindingProducts" @reset="resetBindingFilters"/>
        </div>
      </template>
      <div ref="bindList" class="mobile-bind-options" :aria-busy="productOptionsLoading">
        <p v-if="productOptionsLoading" class="mobile-muted" role="status">正在查找库存…</p>
        <el-alert v-if="bindingError" :title="bindingError" type="warning" :closable="false"/><el-button v-if="bindingError" @click="loadProductOptions(bindingFilters.query,bindingPage)">重新查询</el-button>
        <div v-else-if="bindingSearched&&!productOptionsLoading&&!productOptions.length" class="mobile-bind-empty"><strong>没有找到匹配库存</strong><span>可切换为库存ID精确搜索，或缩短商品名后重新查询。</span></div>
        <article v-for="product in productOptions" :key="product.id" class="mobile-bind-option" :class="{active:String(product.id)===bindingForm.product_id}" @click="!bindingSubmitting&&!productOptionsLoading&&selectBindingProduct(product)">
          <label class="mobile-bind-choice"><input type="radio" name="mobile-binding-product" :checked="String(product.id)===bindingForm.product_id" :disabled="bindingSubmitting||productOptionsLoading" @change="selectBindingProduct(product)"><span class="sr-only">选择 {{product.name}}</span></label>
          <ProductImagePreview :src="`/api/products/${product.id}/image?thumb=1`" :preview-list="[`/api/products/${product.id}/image`]" size="portrait" @click.stop/>
          <div class="mobile-bind-option__text"><button type="button" class="mobile-bind-name" :disabled="bindingSubmitting||productOptionsLoading" @click="selectBindingProduct(product)">{{product.name||'库存商品'}}</button><small>库存 {{product.inventory_number||product.inventory_id||product.code||product.id}}</small><el-tag size="small" :type="Number(product.component_count)>0?'warning':'info'">{{inventoryType(product)}}</el-tag><small>实物 {{inventoryQuantity(product,'physical_stock')}} · 可用 {{inventoryQuantity(product,'workflow_free')}}</small><button type="button" class="mobile-bind-detail" @click.stop="previewProduct=product">库存详情</button></div>
        </article>

      </div>
      <template #footer>
        <div class="mobile-bind-confirm"><MobilePagination v-if="bindingSearched" :page="bindingPage" :page-size="bindingPageSize" :total="bindingTotal" :loading="productOptionsLoading" @change="changeBindingPage"/><div class="mobile-bind-selection"><strong>{{selectedProduct?'已选：'+selectedProduct.name:'请选择要绑定的库存'}}</strong><button type="button" :aria-expanded="bindingOwnerExpanded" @click="toggleBindingOwner">{{bindingForm.person_id?'已选负责人':'负责人（选填）'}}</button></div><el-select v-if="bindingOwnerExpanded" v-model="bindingForm.person_id" :disabled="bindingSubmitting" clearable filterable placeholder="选择负责人"><el-option v-for="person in peopleOptions" :key="person.id" :label="person.name" :value="String(person.id)"/></el-select><div class="mobile-bind-footer"><el-button :disabled="bindingSubmitting" @click="bindingVisible=false">取消</el-button><el-button type="primary" :disabled="!selectedProduct||productOptionsLoading||bindingLoading" :loading="bindingSubmitting" @click="submitMobileBind">确认绑定</el-button></div></div>
      </template>
    </MobileDialog>
    <MobileStocktakeDialog v-if="previewProduct" :model-value="!!previewProduct" :product="previewProduct" read-only @update:model-value="v=>{if(!v)previewProduct=null}"/>

  </div>
</template>

<style scoped>
.mobile-detail-page {
  display: grid;
  gap: 12px;
}

.mobile-detail-hero,
.mobile-section {
  border: 1px solid var(--erp-detail-primary-border, #dbe3ef);
  border-radius: 14px;
  background: var(--erp-detail-surface, #fff);
  box-shadow: 0 8px 20px rgba(15, 23, 42, 0.04);
}

.mobile-detail-hero {
  display: grid;
  gap: 8px;
  padding: 14px;
}

.mobile-detail-hero span {
  color: var(--erp-detail-text-regular, #64748b);
  font-size: 12px;
  font-weight: 800;
}

.mobile-detail-hero h1 {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--erp-detail-text-main, #172033);
  font-size: 18px;
  line-height: 1.25;
}

.mobile-detail-hero__facts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.mobile-detail-hero__facts strong {
  padding: 5px 9px;
  border-radius: 999px;
  background: var(--erp-detail-primary-soft, #eef6ff);
  color: var(--erp-detail-primary, #1d4ed8);
  font-size: 12px;
}

.mobile-section {
  display: grid;
  gap: 10px;
  padding: 12px;
}

.mobile-section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mobile-section__head h2 {
  margin: 0;
  color: var(--erp-detail-text-main, #172033);
  font-size: 15px;
}

.mobile-section__head span {
  color: var(--erp-detail-text-regular, #64748b);
  font-size: 12px;
  font-weight: 700;
}

.mobile-item-card {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--erp-detail-border, #e2e8f0);
  border-radius: 12px;
  background: var(--erp-detail-surface-alt, #f8fafc);
}

.mobile-item-card img,
.mobile-item-card__fallback {
  width: 76px;
  height: 76px;
  border-radius: 12px;
  object-fit: cover;
  background: var(--erp-detail-surface-alt, #e2e8f0);
}

.mobile-item-card__fallback {
  display: grid;
  place-items: center;
  color: var(--erp-detail-text-secondary, #94a3b8);
  font-size: 12px;
  font-weight: 800;
}

.mobile-item-card__main {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.mobile-item-card__main h3 {
  margin: 0;
  color: var(--erp-detail-text-main, #172033);
  font-size: 14px;
  line-height: 1.35;
}

.mobile-item-card__main p {
  margin: 0;
  overflow: hidden;
  color: var(--erp-detail-text-regular, #64748b);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-item-card__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.mobile-item-card__chips span {
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--erp-detail-surface, #fff);
  color: var(--erp-detail-text-regular, #475569);
  font-size: 11px;
  font-weight: 800;
}

.mobile-item-card__chips span.danger {
  background: var(--erp-detail-danger-bg, #fee2e2);
  color: var(--erp-detail-danger-text, #b91c1c);
}

.mobile-item-card button {
  width: fit-content;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--erp-detail-danger-border, #fecaca);
  border-radius: 10px;
  background: var(--erp-detail-danger-bg, #fff1f2);
  color: var(--erp-detail-danger-text, #b91c1c);
  font-size: 12px;
  font-weight: 800;
}

.mobile-warning {
  display: grid;
  gap: 4px;
  padding: 10px;
  border: 1px solid var(--erp-detail-border, #fed7aa);
  border-radius: 12px;
  background: var(--erp-detail-warning-bg, #fff7ed);
}

.mobile-warning strong {
  color: var(--erp-detail-danger-text, #c2410c);
  font-size: 13px;
}

.mobile-warning span {
  color: var(--erp-detail-danger-text, #9a3412);
  font-size: 12px;
}

.mobile-proc-card {
  display: grid;
  gap: 4px;
  padding: 10px;
  border: 1px solid var(--erp-detail-primary-border, #dbeafe);
  border-radius: 12px;
  background: var(--erp-detail-primary-soft, #eff6ff);
}

.mobile-proc-card strong {
  color: var(--erp-detail-primary, #1e3a8a);
  font-size: 13px;
}

.mobile-proc-card span {
  color: var(--erp-detail-primary, #1d4ed8);
  font-size: 12px;
  font-weight: 700;
}

.mobile-primary-action {
  width: 100%;
  min-height: 42px;
  border-radius: 12px;
}

.mobile-secondary-action {
  width: 100%;
  min-height: 42px;
  border-radius: 12px;
}

.mobile-bind-tools{display:grid;gap:8px;min-width:0}.mobile-bind-target{min-width:0;max-width:100%;box-sizing:border-box}.mobile-bind-target{font-size:12px;line-height:1.4;background:var(--el-fill-color-light);border-radius:8px;padding:8px 10px}.mobile-bind-target summary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;font-weight:600}.mobile-bind-target[open] summary{white-space:normal}.mobile-bind-source{display:flex;gap:10px;align-items:center;margin-top:8px}.mobile-bind-source>div{min-width:0}.mobile-bind-target small{display:block;margin-top:5px;overflow-wrap:anywhere}.mobile-bind-options{display:grid;gap:10px}.mobile-bind-option{display:grid;grid-template-columns:24px 64px minmax(0,1fr);gap:8px;padding:10px;border:1px solid var(--el-border-color-light);border-radius:12px;background:var(--el-bg-color)}.mobile-bind-option.active{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.mobile-bind-choice{display:flex;align-items:flex-start;padding-top:12px;min-width:24px;cursor:pointer}.mobile-bind-choice input{width:20px;height:20px;margin:0;accent-color:var(--el-color-primary)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.mobile-bind-option__text{display:grid;gap:5px;min-width:0;justify-items:start}.mobile-bind-name{border:0;background:none;padding:0;color:var(--el-text-color-primary);font-size:14px;line-height:1.5;font-weight:600;text-align:left;overflow-wrap:anywhere}.mobile-bind-option__text small{font-size:12px;color:var(--el-text-color-secondary);overflow-wrap:anywhere}.mobile-bind-detail{min-height:32px;padding:3px 0;border:0;background:none;color:var(--el-color-primary);font-size:13px}.mobile-bind-empty{display:grid;gap:10px;text-align:center;padding:24px 8px;font-size:14px}.mobile-bind-empty span{font-size:13px;line-height:1.6;color:var(--el-text-color-secondary)}.mobile-bind-confirm{display:grid;gap:8px;width:100%;text-align:left}.mobile-bind-selection{display:flex;align-items:center;gap:8px;min-width:0}.mobile-bind-selection strong{flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mobile-bind-selection button{flex:none;font-size:12px;min-height:44px}.mobile-bind-footer{display:grid;grid-template-columns:1fr 2fr;gap:8px}
</style>
