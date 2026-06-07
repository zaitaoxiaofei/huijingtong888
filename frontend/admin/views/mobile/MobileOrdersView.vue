<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Search } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api";
import {
  MOBILE_STATUS_OPTIONS,
  defaultOrderDateRange,
  firstCsv,
  money,
  orderImage,
  orderStatusLabel,
  orderTitle,
  procurementLabel,
  shortText,
  unboundSkus
} from "./mobile-orders-utils.js";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const loadingMore = ref(false);
const rows = ref([]);
const total = ref(0);
const counts = ref({});
const page = ref(1);
const pageSize = 20;
const { dateFrom, dateTo } = defaultOrderDateRange();
const filters = reactive({
  status: String(route.query.status || "all"),
  searchQuery: String(route.query.q || ""),
  searchType: "order",
  dateFrom,
  dateTo
});

const hasMore = computed(() => rows.value.length < total.value);
const summaryCards = computed(() => [
  { label: "待绑定", value: Number(counts.value.unbound || 0), status: "unbound" },
  { label: "待备货", value: Number(counts.value.awaiting_packaging || 0), status: "awaiting_packaging" },
  { label: "待发货", value: Number(counts.value.awaiting_deliver || 0), status: "awaiting_deliver" }
]);

function buildParams(nextPage = 1) {
  const params = new URLSearchParams({
    paged: "1",
    page: String(nextPage),
    pageSize: String(pageSize),
    status: filters.status,
    shopId: "all",
    logisticsMethod: "all",
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    searchType: filters.searchType,
    searchQuery: filters.searchQuery.trim(),
    markFilter: "all",
    printView: "all",
    printFilter: "all",
    sortMode: "ordered",
    includeRows: "1",
    includeCounts: nextPage === 1 ? "1" : "0",
    includeLogisticsOptions: "0"
  });
  return params;
}

async function loadOrders({ append = false } = {}) {
  if (append) {
    loadingMore.value = true;
  } else {
    loading.value = true;
  }
  try {
    const nextPage = append ? page.value + 1 : 1;
    const result = await apiClient.get(`/api/orders?${buildParams(nextPage).toString()}`, {
      noCache: true
    });
    page.value = Number(result.page || nextPage);
    total.value = Number(result.total || 0);
    if (result.counts) counts.value = result.counts;
    const nextRows = Array.isArray(result.rows) ? result.rows : [];
    rows.value = append ? [...rows.value, ...nextRows] : nextRows;
  } catch (error) {
    ElMessage.error(error.message || "订单加载失败");
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function setStatus(status) {
  filters.status = status;
  router.replace({ path: "/mobile/orders", query: { ...route.query, status, q: filters.searchQuery || undefined } });
  loadOrders();
}

function submitSearch() {
  router.replace({ path: "/mobile/orders", query: { ...route.query, status: filters.status, q: filters.searchQuery || undefined } });
  loadOrders();
}

function openDetail(row) {
  router.push(`/mobile/orders/${row.id}`);
}

function openDesktopBind(row) {
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

onMounted(() => loadOrders());
</script>

<template>
  <div class="mobile-orders-page" v-loading="loading">
    <section class="mobile-workbench">
      <button
        v-for="card in summaryCards"
        :key="card.status"
        type="button"
        class="mobile-summary-card"
        @click="setStatus(card.status)"
      >
        <span>{{ card.label }}</span>
        <strong>{{ card.value }}</strong>
      </button>
    </section>

    <section class="mobile-search-panel">
      <el-input
        v-model="filters.searchQuery"
        clearable
        placeholder="订单号 / SKU / 商品名"
        @keyup.enter="submitSearch"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-button type="primary" @click="submitSearch">搜索</el-button>
    </section>

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

        <div class="mobile-order-card__body">
          <img v-if="orderImage(row)" :src="orderImage(row)" alt="">
          <div v-else class="mobile-order-card__image-fallback">SKU</div>
          <div class="mobile-order-card__main">
            <h2>{{ orderTitle(row) }}</h2>
            <p>{{ shortText(row.posting_number || row.order_number) }}</p>
            <div class="mobile-order-card__facts">
              <span>数量 {{ Number(row.total_quantity || row.item_count || 0) }}</span>
              <span>{{ money(row.revenue, "₽") }}</span>
              <span>{{ procurementLabel(row) }}</span>
            </div>
          </div>
        </div>

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

    <el-button
      v-if="hasMore"
      class="mobile-load-more"
      :loading="loadingMore"
      @click="loadOrders({ append: true })"
    >
      加载更多
    </el-button>
  </div>
</template>

<style scoped>
.mobile-orders-page {
  display: grid;
  gap: 12px;
}

.mobile-workbench {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.mobile-summary-card {
  min-width: 0;
  display: grid;
  gap: 4px;
  padding: 12px 10px;
  border: 1px solid #dbe3ef;
  border-radius: 12px;
  background: #fff;
  text-align: left;
}

.mobile-summary-card span {
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
}

.mobile-summary-card strong {
  color: #172033;
  font-size: 22px;
  line-height: 1;
}

.mobile-search-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 72px;
  gap: 8px;
}

.mobile-search-panel :deep(.el-input__wrapper),
.mobile-search-panel :deep(.el-button) {
  min-height: 42px;
  border-radius: 12px;
}

.mobile-status-strip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: none;
}

.mobile-status-strip button {
  flex: none;
  height: 34px;
  padding: 0 13px;
  border: 1px solid #dbe3ef;
  border-radius: 999px;
  background: #fff;
  color: #475569;
  font-size: 13px;
  font-weight: 700;
}

.mobile-status-strip button.active {
  border-color: #bfdbfe;
  background: #eaf1ff;
  color: #1d4ed8;
}

.mobile-order-list {
  display: grid;
  gap: 10px;
}

.mobile-order-card {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid #dbe3ef;
  border-radius: 14px;
  background: #fff;
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
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-order-card__head strong {
  flex: none;
  padding: 4px 8px;
  border-radius: 999px;
  background: #eef6ff;
  color: #1d4ed8;
  font-size: 12px;
}

.mobile-order-card__body {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 10px;
}

.mobile-order-card__body img,
.mobile-order-card__image-fallback {
  width: 72px;
  height: 72px;
  border-radius: 12px;
  object-fit: cover;
  background: #eef2f7;
}

.mobile-order-card__image-fallback {
  display: grid;
  place-items: center;
  color: #94a3b8;
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
  color: #172033;
  font-size: 14px;
  line-height: 1.35;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.mobile-order-card__main p {
  margin: 0;
  overflow: hidden;
  color: #64748b;
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
  background: #f1f5f9;
  color: #475569;
  font-size: 11px;
  font-weight: 700;
}

.mobile-order-card__foot {
  padding-top: 2px;
}

.mobile-order-card__foot span {
  color: #16a34a;
  font-size: 12px;
  font-weight: 800;
}

.mobile-order-card__foot span.is-danger {
  color: #dc2626;
}

.mobile-order-card__foot button {
  height: 32px;
  padding: 0 12px;
  border: 1px solid #c7d2fe;
  border-radius: 10px;
  background: #eef2ff;
  color: #3730a3;
  font-size: 12px;
  font-weight: 800;
}

.mobile-empty {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 36px 12px;
  color: #64748b;
}

.mobile-empty strong {
  color: #334155;
  font-size: 15px;
}

.mobile-load-more {
  min-height: 42px;
  border-radius: 12px;
}
</style>
