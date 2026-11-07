<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { apiClient, currentApiCacheScope } from '../utils/api.js';

const props = defineProps({
  rows: { type: Array, default: () => [] },
  date: String, dateText: String, loading: Boolean, error: String, hasMore: Boolean
});
const emit = defineEmits(['retry']);
const expanded = ref(false);
const extra = ref([]);
const nextPage = ref(2);
const more = ref(false);
const busy = ref(false);
const moreError = ref('');
const scrollBox = ref(null);
const root = ref(null);
const visibleCount = ref(10);
const scrolling = ref(false);
let resizeObserver, scrollTimer;
const PAGE_SIZE = 15;
const detail = ref(null);
const detailRows = ref([]);
const detailLoading = ref(false);
const detailError = ref('');
const detailPage = ref(1);
const detailTotal = ref(0);
const previews = reactive({});
let version = 0;
let detailVersion = 0;
const allRows = computed(() => expanded.value ? [...props.rows, ...extra.value] : props.rows.slice(0, visibleCount.value));
const groups = computed(() => {
  const result = [];
  for (let i = 0; i < allRows.value.length; i += visibleCount.value) result.push(allRows.value.slice(i, i + visibleCount.value));
  return result;
});
const money = value => `CNY ${Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
const count = value => Number(value || 0).toLocaleString('zh-CN');
function fetchRows(values) {
  const params = new URLSearchParams({
    dimension: 'sku', inventory: '1', from: props.date, to: props.date,
    sortBy: 'revenue', sortOrder: 'desc', ...values
  });
  return apiClient.get(`/api/profit-ranking?${params}`, { noCache: true });
}
function reset() {
  ++version;
  ++detailVersion;
  expanded.value = false;
  extra.value = [];
  nextPage.value = 2;
  more.value = props.hasMore;
  moreError.value = '';
  busy.value = false;
  detail.value = null;
  detailRows.value = [];
  detailError.value = '';
  for (const id of Object.keys(previews)) delete previews[id];
  if (scrollBox.value) scrollBox.value.scrollTop = 0;
}
async function loadMore() {
  if (busy.value || !expanded.value || !more.value) return;
  const scope = currentApiCacheScope(), token = version, page = nextPage.value;
  busy.value = true;
  moreError.value = '';
  try {
    const result = await fetchRows({ dimension: 'product', page: String(page), pageSize: String(PAGE_SIZE), fast: '1' });
    if (token !== version || scope !== currentApiCacheScope()) return;
    const known = new Set(allRows.value.map(row => Number(row.product_id)));
    extra.value.push(...(result.rows || []).filter(row => !known.has(Number(row.product_id))));
    nextPage.value++;
    more.value = Number(result.total) > page * PAGE_SIZE;
  } catch (error) {
    if (token === version) moreError.value = error.message || '加载失败，请重试';
  } finally {
    if (token === version) busy.value = false;
  }
}
function startMore() {
  expanded.value = true;
  if (props.rows.length + extra.value.length <= visibleCount.value) void loadMore();
}
function collapse() {
  expanded.value = false;
  if (scrollBox.value) scrollBox.value.scrollTop = 0;
}
function onScroll() {
  scrolling.value = true;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => { scrolling.value = false; }, 450);
  const el = scrollBox.value;
  if (expanded.value && el && el.scrollHeight - el.scrollTop - el.clientHeight < 180 && !moreError.value) void loadMore();
}
async function preview(row) {
  const id = Number(row.product_id);
  if (previews[id]) return;
  const scope = currentApiCacheScope(), token = version;
  previews[id] = { loading: true, rows: [], error: '' };
  try {
    const result = await fetchRows({ productId: String(id), page: '1', pageSize: '5', fast: '1' });
    if (token !== version || scope !== currentApiCacheScope()) return;
    previews[id] = { loading: false, rows: result.rows || [], error: '' };
  } catch (error) {
    if (token === version) previews[id] = { loading: false, rows: [], error: error.message || '概览加载失败，请点击查看明细' };
  }
}
async function loadDetail() {
  if (!detail.value) return;
  const scope = currentApiCacheScope(), token = ++detailVersion, id = Number(detail.value.product_id);
  detailLoading.value = true;
  detailError.value = '';
  detailRows.value = [];
  try {
    const result = await fetchRows({ productId: String(id), page: String(detailPage.value), pageSize: '20' });
    if (token !== detailVersion || scope !== currentApiCacheScope()) return;
    detailRows.value = result.rows || [];
    detailTotal.value = Number(result.total) || 0;
  } catch (error) {
    if (token === detailVersion) detailError.value = error.message || '明细加载失败，请重试';
  } finally {
    if (token === detailVersion) detailLoading.value = false;
  }
}
function openDetail(row) {
  detail.value = row;
  detailPage.value = 1;
  detailTotal.value = 0;
  void loadDetail();
}
watch(() => props.date, reset);
watch(() => props.rows, reset);
watch(() => props.hasMore, value => { if (!expanded.value) more.value = value; });
onMounted(() => {
  window.addEventListener('erp:auth-scope-changed', reset);
  resizeObserver = new ResizeObserver(entries => {
    const width = entries[0]?.contentRect.width || 0;
    visibleCount.value = width >= 1450 ? 15 : width >= 1100 ? 12 : 10;
  });
  if (root.value) resizeObserver.observe(root.value);
});
onBeforeUnmount(() => {
  ++version;
  ++detailVersion;
  window.removeEventListener('erp:auth-scope-changed', reset);
  resizeObserver?.disconnect();
  clearTimeout(scrollTimer);
});
</script>
<template>
 <section ref="root" class="overview-panel inventory-ranking" :style="{'--ranking-columns': visibleCount>10?3:2, '--ranking-rows': visibleCount===12?4:5}" aria-label="库存商品销售榜单">
  <header class="ranking-heading">
  <div>
  <span>TOP PRODUCTS</span>
  <h2>Top {{visibleCount}} 库存商品</h2>
  </div>
  <small>{{dateText}} · 按销售额排序</small>
  </header>
  <div ref="scrollBox" class="ranking-scroll" :class="{'is-expanded':expanded}" @scroll.passive="onScroll">
   <el-alert v-if="error" type="warning" :title="error" :closable="false"/>
  <el-button v-if="error" size="small" @click="emit('retry')">重新读取榜单</el-button>
   <div v-for="(group,groupIndex) in groups" :key="groupIndex" class="ranking-group">
    <el-popover v-for="(row,index) in group" :key="row.product_id" trigger="hover" :disabled="scrolling" :show-after="400" :width="460" placement="top" @show="preview(row)">
     <template #reference>
  <article class="inventory-rank-card">
      <b class="rank-number">{{groupIndex*visibleCount+index+1}}</b>
      <el-image class="rank-image" loading="lazy" :src="row.image_url" fit="cover" :preview-src-list="row.image_url?[`/api/products/${row.product_id}/image`]:[]" preview-teleported>
  <template #error>
  <span>无图</span>
  </template>
  </el-image>
      <div class="rank-copy">
  <button type="button" class="rank-name" :title="row.product_name" @click="openDetail(row)">{{row.product_name||'未命名库存商品'}}</button>
  <small>库存 {{row.inventory_number||row.product_code||row.product_id}}</small>
  <small>{{count(row.shop_count)}} 家店铺 · {{count(row.sku_count)}} 个 SKU <el-button size="small" plain @click="openDetail(row)">明细</el-button>
  </small>
  </div>
      <div class="rank-metrics">
  <span>销售额<strong>{{money(row.revenue)}}</strong>
  </span>
  <span>销量 <b>{{count(row.item_quantity)}} {{row.stock_unit||'件'}}</b>
  </span>
  <span>单量 <b>{{count(row.order_count)}} 单</b>
  </span>
  </div>
     </article>
  </template>
     <div class="rank-preview">
  <strong>{{row.product_name}}</strong>
  <p>{{dateText}} · {{money(row.revenue)}} · {{count(row.item_quantity)}} {{row.stock_unit||'件'}} · {{count(row.order_count)}} 单</p>
  <p v-if="previews[row.product_id]?.loading">正在读取店铺与 SKU 概览…</p>
  <p v-else-if="previews[row.product_id]?.error">{{previews[row.product_id].error}}</p>
  <div v-for="sku in previews[row.product_id]?.rows" :key="`${sku.shop_id}:${sku.ozon_sku}`" class="preview-line">
  <span>{{sku.shop_name}} · SKU {{sku.ozon_sku}}</span>
  <span>{{money(sku.revenue)}} · {{count(sku.item_quantity)}} 件 · {{count(sku.order_count)}} 单</span>
  </div>
  <el-button size="small" @click="openDetail(row)">查看全部店铺 / SKU 明细</el-button>
  </div>
    </el-popover>
   </div>
   <el-skeleton v-if="loading&&!rows.length" :rows="10" animated/>
  <el-empty v-else-if="!rows.length&&!error" description="所选日期暂无已绑定库存商品的有效销售" :image-size="72"/>
  </div>
  <footer class="ranking-footer">
  <el-button v-if="!expanded&&rows.length" size="small" @click="startMore">往下查看更多</el-button>
  <template v-else-if="expanded">
  <span v-if="busy">正在加载…</span>
  <el-button v-else-if="moreError" size="small" @click="loadMore">加载失败，点击重试</el-button>
  <span v-else>{{more?'继续向下滚动查看更多':'已全部加载'}} · 已展示 {{allRows.length}} 个库存商品</span>
  <el-button size="small" @click="collapse">收起</el-button>
  </template>
  </footer>
  <el-dialog v-if="detail" :model-value="true" :title="`${detail.product_name} · 销售明细`" width="min(1100px,94vw)" top="7vh" append-to-body destroy-on-close @close="detail=null;++detailVersion">
   <p>{{dateText}} · 库存 {{detail.inventory_number||detail.product_id}} · {{money(detail.revenue)}} · 有效销量 {{count(detail.item_quantity)}} {{detail.stock_unit||'件'}} · 有效订单 {{count(detail.order_count)}} 单</p>
   <el-alert v-if="detailError" type="error" :title="detailError" :closable="false"/>
  <el-button v-if="detailError" @click="loadDetail">重试</el-button>
   <el-table v-loading="detailLoading" :data="detailRows" max-height="470" empty-text="所选日期暂无对应店铺 / SKU 销售">
  <el-table-column prop="shop_name" label="店铺" min-width="140"/>
  <el-table-column prop="ozon_sku" label="Ozon SKU" min-width="150"/>
  <el-table-column prop="product_name" label="SKU 商品名称" min-width="230"/>
  <el-table-column label="销售额" width="140">
  <template #default="{row}">{{money(row.revenue)}}</template>
  </el-table-column>
  <el-table-column prop="order_count" label="有效单量" width="110"/>
  <el-table-column prop="item_quantity" label="有效销量" width="110"/>
  </el-table>
   <p class="ranking-note">同一订单含多个 SKU 时，库存单量按订单去重，不能直接相加 SKU 行的单量。未绑定库存的 SKU 不混入此榜单。</p>
   <el-pagination v-if="detailTotal>20" :current-page="detailPage" :page-size="20" :total="detailTotal" layout="prev,pager,next,total" @current-change="p=>{detailPage=p;loadDetail()}"/>
  </el-dialog>
 </section>
</template>
<style scoped>
.inventory-ranking{height:680px;box-sizing:border-box;display:flex;flex-direction:column;min-width:0;overflow:hidden}
.ranking-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;margin-bottom:16px;flex:none}
.ranking-heading span{font-size:11px;color:var(--dashboard-theme-link,#2563eb);font-weight:800;letter-spacing:.12em}
.ranking-heading h2{margin:5px 0 0;font-size:20px}
.ranking-heading small,.rank-copy small,.ranking-footer,.ranking-note{color:var(--dashboard-muted,var(--el-text-color-secondary));font-size:12px}
.ranking-scroll{flex:1;min-height:0;overflow:hidden;scrollbar-gutter:stable}
.ranking-scroll.is-expanded{overflow-y:auto;overscroll-behavior:contain}
.ranking-group{display:grid;grid-template-columns:repeat(var(--ranking-columns),minmax(0,1fr));height:530px;grid-template-rows:repeat(var(--ranking-rows),minmax(0,1fr));grid-auto-flow:column;gap:10px;margin-bottom:10px}
.inventory-rank-card{display:grid;grid-template-columns:22px 64px minmax(0,1fr) 94px;align-items:center;gap:10px;height:100%;box-sizing:border-box;padding:6px 10px;border:1px solid var(--dashboard-theme-border-light,var(--el-border-color-lighter));border-radius:12px;background:var(--dashboard-theme-surface-alt,var(--el-fill-color-extra-light))}
.rank-number{color:var(--dashboard-theme-link,var(--el-color-primary));font-size:16px;text-align:center}
.rank-image{width:64px;height:84px;border-radius:8px;background:var(--el-fill-color-light)}
.rank-copy{min-width:0;display:grid;gap:4px}
.rank-copy small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rank-name{padding:0;border:0;background:none;text-align:left;cursor:pointer;color:var(--dashboard-text,var(--el-text-color-primary));font:inherit;font-size:13px;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rank-name:hover{color:var(--el-color-primary)}
.rank-copy :deep(.el-button){height:20px;padding:0 5px;margin-left:5px}
.rank-metrics{display:grid;gap:4px;text-align:right;font-size:11px;color:var(--dashboard-muted,var(--el-text-color-secondary));min-width:0}
.rank-metrics strong{display:block;font-size:13px;color:var(--dashboard-text,var(--el-text-color-primary));white-space:nowrap}
.rank-metrics b{color:var(--dashboard-text,var(--el-text-color-primary))}
.ranking-footer{display:flex;align-items:center;justify-content:center;gap:12px;height:30px;flex:none;padding-top:6px}
.rank-preview{font-size:12px}
.preview-line{display:grid;gap:4px;padding:8px 0;border-top:1px solid var(--el-border-color-lighter);overflow-wrap:anywhere}
.ranking-note{line-height:1.6}
.ranking-scroll::-webkit-scrollbar{width:6px}
.ranking-scroll::-webkit-scrollbar-thumb{background:var(--el-border-color);border-radius:4px}
@media(max-width:760px){.ranking-group{height:auto;grid-template-columns:minmax(0,1fr);grid-template-rows:none;grid-auto-flow:row}
.inventory-ranking{height:680px}
.inventory-rank-card{height:98px;grid-template-columns:20px 64px minmax(0,1fr) 88px;gap:7px}
.ranking-heading{align-items:start}
.ranking-heading small{max-width:140px;text-align:right}}
</style>
