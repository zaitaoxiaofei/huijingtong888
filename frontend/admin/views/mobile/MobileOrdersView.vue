<script setup>
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Search } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { apiClient, currentApiCacheScope } from "../../utils/api";
import { orderSearchMatchForInput } from "../../../../src/shared/order-search.js";
import {
  MOBILE_STATUS_OPTIONS,
  defaultOrderDateRange,
  firstCsv,
  orderStatusLabel,
  shortText,
  unboundSkus,
  packingItems,
  manualMarkLabel
} from "./mobile-orders-utils.js";

import MobileDialog from "../../components/mobile/MobileDialog.vue";
import {shanghaiDateTimeText} from "../../utils/shanghai-date.js";
import MobilePagination from "../../components/mobile/MobilePagination.vue";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const rows = ref([]);
const total = ref(0);
const noteOrder = ref(null);
const page = ref(1);
const pageSize = ref(20);
let version=0,disposed=false,rowController=null;
let restoreScroll=Number(window.history.state?.mobileOrdersScroll||0);
const initialPage=Math.max(1,Math.trunc(Number(route.query.page)||1));
pageSize.value=[20,50,100].includes(Number(route.query.pageSize))?Number(route.query.pageSize):20;
const { dateFrom, dateTo } = defaultOrderDateRange();
const filters = reactive({
  status: String(route.query.status || "all"),
  searchQuery: String(route.query.q || ""),
  searchType: ["order","sku","product"].includes(route.query.searchType) ? route.query.searchType : "product",
  sortMode: ["ordered","inventory_picking"].includes(route.query.sortMode) ? route.query.sortMode : (route.query.status === "awaiting_deliver" ? "inventory_picking" : "ordered"),
  printFilter: ["printed","unprinted"].includes(route.query.printFilter) ? route.query.printFilter : "all",
  fulfillmentType: ["fbs","fbp"].includes(route.query.fulfillmentType) ? route.query.fulfillmentType : "all",
  dateFrom,
  dateTo
});

function buildParams(nextPage = 1) {
  const params = new URLSearchParams({
    paged: "1",
    page: String(nextPage),
    pageSize: String(pageSize.value),
    status: filters.status,
    shopId: "all",
    logisticsMethod: "all",
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    searchType: filters.searchType,
    searchQuery: filters.searchQuery.trim(),
    searchMatch: orderSearchMatchForInput(filters.searchType, filters.searchQuery),
    markFilter: "all",
    printView: "all",
    printFilter: filters.printFilter,
    sortMode: filters.sortMode,
    fulfillmentType: filters.fulfillmentType,
    includeRows: "1",
    includeCounts: "0",
    includeLogisticsOptions: "0"
  });
  return params;
}

async function loadOrders({nextPage=1}={}) {
  rowController?.abort();rowController=new AbortController();const controller=rowController,token=++version,scope=currentApiCacheScope();loading.value=true;
  const timeout=window.setTimeout(()=>controller.abort(),20000);
  try {
    const result=await apiClient.get(`/api/orders?${buildParams(nextPage).toString()}`,{noCache:true,signal:controller.signal});
    if(disposed||token!==version||scope!==currentApiCacheScope())return;
    page.value=Number(result.page||nextPage);total.value=Number(result.total||0);rows.value=Array.isArray(result.rows)?result.rows:[];
    await nextTick();if(disposed||token!==version||scope!==currentApiCacheScope())return;
    document.querySelector('.mobile-orders-page .mobile-list-scroll')?.scrollTo(0,restoreScroll);restoreScroll=0;
  }catch(e){if(token===version&&scope===currentApiCacheScope())ElMessage.error(e.name==='AbortError'?'订单读取超时，请重试':e.message||'订单加载失败');}
  finally{window.clearTimeout(timeout);if(token===version)loading.value=false;}
}
function changePage(value){restoreScroll=0;pageSize.value=value.pageSize;syncFilters(value.page);return loadOrders({nextPage:value.page});}
function clearScope(){++version;rowController?.abort();rows.value=[];total.value=0;noteOrder.value=null;}

function syncFilters(nextPage=1) {
  router.replace({path:'/mobile/orders',query:{...route.query,page:nextPage,pageSize:pageSize.value,status:filters.status,q:filters.searchQuery.trim()||undefined,searchType:filters.searchType,sortMode:filters.sortMode,printFilter:filters.printFilter,fulfillmentType:filters.fulfillmentType}});
}
function setStatus(status) {
  filters.status=status;
  if(status==='awaiting_deliver')filters.sortMode='inventory_picking';
  return submitSearch();
}
function submitSearch() {
  restoreScroll=0;syncFilters();return loadOrders();
}
function resetFilters(){Object.assign(filters,{searchQuery:'',searchType:'product',printFilter:'all',fulfillmentType:'all',sortMode:filters.status==='awaiting_deliver'?'inventory_picking':'ordered'});return submitSearch();}

function saveListPosition(){window.history.replaceState({...window.history.state,mobileOrdersScroll:document.querySelector('.mobile-orders-page .mobile-list-scroll')?.scrollTop||0},'');}
function openDetail(row) {
  saveListPosition();
  router.push(`/mobile/orders/${row.id}`);
}

function openDesktopBind(row) {
  saveListPosition();
  const sku = unboundSkus(row)[0] || firstCsv(row.skus);
  ElMessage.info(sku ? "已进入订单详情，请在商品明细里绑定库存" : "已进入订单详情");
  router.push({ path: `/mobile/orders/${row.id}`, query: sku ? { sku, action: "bind" } : { action: "bind" } });
}

watch(
  () => route.query.status,
  (status) => {
    const next = String(status || "all");
    if (next !== filters.status) {
      filters.status = next;
      loadOrders();
    }
  }
);

onMounted(()=>{loadOrders({nextPage:initialPage});window.addEventListener('erp:auth-scope-changed',clearScope);});
onBeforeUnmount(()=>{disposed=true;clearScope();window.removeEventListener('erp:auth-scope-changed',clearScope);});
</script>

<template>
  <div class="mobile-orders-page mobile-list-page">
    <div class="mobile-list-controls">
    <section class="mobile-status-strip" aria-label="订单状态">
      <button
        v-for="option in MOBILE_STATUS_OPTIONS"
        :key="option.value"
        type="button"
        :class="{ active: filters.status === option.value }"
        @click="setStatus(option.value)"
      >
        {{ option.label }}
      </button>
    </section>

    <section class="mobile-search-panel">
      <label class="mobile-order-select"><span aria-hidden="true">{{({product:"库存 ID",sku:"SKU",order:"订单号"})[filters.searchType]}}</span><select v-model="filters.searchType" aria-label="订单搜索方式"><option value="product">库存 ID</option><option value="sku">SKU</option><option value="order">订单号</option></select></label>
      <el-input
        v-model="filters.searchQuery"
        clearable
        :placeholder="filters.searchType==='product'?'库存 ID / 商品名':filters.searchType==='sku'?'输入 SKU':'输入订单号'"
        @keyup.enter="submitSearch"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-button type="primary" @click="submitSearch">查询</el-button>
    </section>

    <section class="mobile-packing-filters" aria-label="贴单核对筛选">
      <label class="mobile-order-select"><span aria-hidden="true">{{filters.sortMode==='inventory_picking'?'库存顺序':'下单时间'}}</span><select v-model="filters.sortMode" aria-label="订单排序" @change="submitSearch"><option value="ordered">下单时间</option><option value="inventory_picking">库存顺序（FBS优先）</option></select></label>
      <label class="mobile-order-select"><span aria-hidden="true">{{({all:"全部打印",printed:"已打印",unprinted:"未打印"})[filters.printFilter]}}</span><select v-model="filters.printFilter" aria-label="打印状态" @change="submitSearch"><option value="all">全部打印状态</option><option value="printed">已打印</option><option value="unprinted">未打印</option></select></label>
      <label class="mobile-order-select"><span aria-hidden="true">{{({all:"全部履约",fbs:"仅 FBS",fbp:"仅 FBP"})[filters.fulfillmentType]}}</span><select v-model="filters.fulfillmentType" aria-label="履约方式" @change="submitSearch"><option value="all">全部履约</option><option value="fbs">仅 FBS</option><option value="fbp">仅 FBP</option></select></label>
      <el-button @click="resetFilters">重置</el-button>
    </section>
    <small v-if="loading" class="mobile-muted" role="status">正在读取订单…</small>
    </div>
    <div class="mobile-list-scroll">
    <section v-if="!rows.length && !loading" class="mobile-empty">
      <strong>暂无订单</strong>
      <span>可以换个状态或搜索词试试。</span>
    </section>

    <section class="mobile-order-list">
      <article v-for="row in rows" :key="row.id" class="mobile-order-card" @click="openDetail(row)">
        <div class="mobile-order-card__head">
          <span>{{ shortText(row.shop_name, "店铺") }}</span>
          <strong>{{ orderStatusLabel(row) }}</strong>
        </div>

        <div class="mobile-order-card__identity">
          <strong>{{ shortText(row.posting_number || row.order_number) }}</strong>
          <span :class="['mobile-print-badge',{'is-printed':!!row.printed_at}]">{{row.printed_at?'已打印':'未打印'}}</span>
        </div>
        <div v-for="item in packingItems(row)" :key="item.sku" class="mobile-order-card__body">
          <img v-if="item.imageUrl" :src="item.imageUrl" loading="lazy" decoding="async" width="64" height="84" alt="">
          <div v-else class="mobile-order-card__image-fallback">无图</div>
          <div class="mobile-order-card__main">
            <h2>{{item.inventoryName || item.name}}</h2>
            <div class="mobile-order-card__facts"><strong>库存 {{item.inventoryNumber || (item.inventoryMode==='combo'?'组合库存':'未绑定')}}</strong><span>{{item.quantity}} 件</span></div>
            <p>SKU {{item.sku}}</p>
          </div>
        </div>
        <button v-if="row.mark_type || row.mark_note" type="button" class="mobile-order-note" @click.stop="noteOrder=row">{{manualMarkLabel(row)}}<span>{{row.mark_note || '查看人工标记'}}</span><b>查看</b></button>
        <div class="mobile-order-card__foot">
          <span v-if="Number(row.unbound_item_count || 0) > 0" class="is-danger">
            未绑定 {{ row.unbound_item_count }} 项
          </span>
          <span v-else>库存已绑定</span>
          <button
            v-if="Number(row.unbound_item_count || 0) > 0"
            type="button"
            @click.stop="openDesktopBind(row)"
          >
            去绑定
          </button>
          <button v-else type="button" @click.stop="openDetail(row)">详情</button>
        </div>
      </article>
    </section>

    </div>
    <MobilePagination :page="page" :page-size="pageSize" :total="total" :loading="loading" @change="changePage"/>
    <MobileDialog v-if="noteOrder" :model-value="!!noteOrder" title="人工标记与备注" mode="compact" @update:model-value="value=>{if(!value)noteOrder=null}">
      <strong>{{noteOrder.posting_number || noteOrder.order_number}}</strong>
      <p>{{noteOrder.shop_name}} · {{manualMarkLabel(noteOrder)}}</p>
      <p class="mobile-order-note-full">{{noteOrder.mark_note || '此标记未填写备注，请与运营确认。'}}</p>
      <p v-if="noteOrder.printed_at" class="mobile-muted">打印时间 {{shanghaiDateTimeText(noteOrder.printed_at,{assumeUtcWhenNaive:true})}}</p>
      <template #footer><el-button @click="noteOrder=null">关闭</el-button></template>
    </MobileDialog>
  </div>
</template>

<style scoped>
.mobile-orders-page {
  display: grid;
  gap: 12px;
}

.mobile-search-panel {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr) 56px;
  gap: 8px;
}

.mobile-search-panel :deep(.el-input__wrapper),
.mobile-search-panel :deep(.el-button) {
  min-height: 42px;
  border-radius: 12px;
}

.mobile-status-strip {
  display: flex;
  gap: 5px;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: none;
}

.mobile-status-strip button {
  flex: none;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--erp-detail-primary-border, #dbe3ef);
  border-radius: 999px;
  background: var(--erp-detail-surface, #fff);
  color: var(--erp-detail-text-regular, #475569);
  font-size: 13px;
  font-weight: 700;
}

.mobile-status-strip button.active {
  border-color: var(--erp-detail-primary-border, #bfdbfe);
  background: var(--erp-detail-primary-soft, #eaf1ff);
  color: var(--erp-detail-primary, #1d4ed8);
}

.mobile-order-list {
  display: grid;
  gap: 10px;
}

.mobile-order-card {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--erp-detail-primary-border, #dbe3ef);
  border-radius: 14px;
  background: var(--erp-detail-surface, #fff);
  box-shadow: 0 8px 20px rgba(15, 23, 42, 0.04);
}

.mobile-order-card__head,
.mobile-order-card__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mobile-order-card__head span {
  min-width: 0;
  overflow: hidden;
  color: var(--erp-detail-text-regular, #64748b);
  font-size: 12px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-order-card__head strong {
  flex: none;
  padding: 4px 8px;
  border-radius: 999px;
  background: var(--erp-detail-primary-soft, #eef6ff);
  color: var(--erp-detail-primary, #1d4ed8);
  font-size: 12px;
}

.mobile-order-card__body {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 10px;
}

.mobile-order-card__body img,
.mobile-order-card__image-fallback {
  width: 64px;
  height: 84px;
  border-radius: 12px;
  object-fit: cover;
  background: var(--erp-detail-surface-alt, #eef2f7);
}

.mobile-order-card__image-fallback {
  display: grid;
  place-items: center;
  color: var(--erp-detail-text-secondary, #94a3b8);
  font-size: 12px;
  font-weight: 800;
}

.mobile-order-card__main {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.mobile-order-card__main h2 {
  margin: 0;
  display: -webkit-box;
  overflow: hidden;
  color: var(--erp-detail-text-main, #172033);
  font-size: 14px;
  line-height: 1.35;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.mobile-order-card__main p {
  margin: 0;
  overflow: hidden;
  color: var(--erp-detail-text-regular, #64748b);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-order-card__facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.mobile-order-card__facts span {
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--erp-detail-surface-alt, #f1f5f9);
  color: var(--erp-detail-text-regular, #475569);
  font-size: 11px;
  font-weight: 700;
}

.mobile-order-card__foot {
  padding-top: 2px;
}

.mobile-order-card__foot span {
  color: var(--erp-detail-success-text, #16a34a);
  font-size: 12px;
  font-weight: 800;
}

.mobile-order-card__foot span.is-danger {
  color: var(--erp-detail-danger-text, #dc2626);
}

.mobile-order-card__foot button {
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--erp-detail-primary-border, #c7d2fe);
  border-radius: 10px;
  background: var(--erp-detail-primary-soft, #eef2ff);
  color: var(--erp-detail-primary, #3730a3);
  font-size: 12px;
  font-weight: 800;
}

.mobile-empty {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 36px 12px;
  color: var(--erp-detail-text-regular, #64748b);
}

.mobile-empty strong {
  color: var(--erp-detail-text-main, #334155);
  font-size: 15px;
}

.mobile-order-card__identity{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:14px;overflow-wrap:anywhere}
.mobile-print-badge{flex:none;padding:4px 7px;border-radius:6px;background:var(--erp-detail-surface-alt,#f1f5f9);color:var(--erp-detail-text-regular,#64748b);font-size:12px}
.mobile-print-badge.is-printed{background:var(--erp-detail-success-bg,#eaf8ee);color:var(--erp-detail-success-text,#167747);font-weight:700}
.mobile-order-card__facts strong{font-size:14px;color:var(--erp-detail-primary,#315da8)}
.mobile-packing-filters{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) 48px;gap:5px}
.mobile-order-select{position:relative;display:flex;align-items:center;width:100%;min-width:0;min-height:40px;box-sizing:border-box;padding:4px 20px 4px 8px;border:1px solid var(--el-border-color);border-radius:8px;background:var(--el-bg-color);color:var(--el-text-color-primary);font-size:13px}
.mobile-order-select>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.mobile-order-select::after{content:'⌄';position:absolute;right:7px;font-size:13px;pointer-events:none}
.mobile-order-select select{position:absolute;inset:0;opacity:0;width:100%;min-width:0;font-size:16px}
.mobile-order-select:focus-within{outline:2px solid var(--el-color-primary);outline-offset:1px}
.mobile-packing-filters :deep(.el-button){padding:4px;min-width:0;height:36px;font-size:12px}
.mobile-order-note{display:flex;align-items:center;gap:8px;width:100%;min-width:0;text-align:left;padding:8px;border:1px solid var(--erp-detail-warning-border,#f2d7a2);border-radius:8px;background:var(--erp-detail-warning-bg,#fff7e6);color:var(--erp-detail-warning-text,#945c00);font-size:12px;cursor:pointer}
.mobile-order-note span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mobile-order-note-full{white-space:pre-wrap;overflow-wrap:anywhere}
</style>
