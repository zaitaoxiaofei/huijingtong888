<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api";
import { createLatestRequestGate } from "../../utils/request-gate";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import InventoryPageToolbar from "../../components/inventory/InventoryPageToolbar.vue";
import { applyFilterQuery, buildFilterQuery, dateText, integer } from "./inventory-utils.js";

const route = useRoute();
const router = useRouter();
let syncingRoute = false;
const listRequestGate = createLatestRequestGate();
let shopsLoaded = false;

const loading = ref(false);
const state = reactive({
  rows: [],
  total: 0,
  shops: [],
  filters: {
    query: "",
    shopId: "all",
    dateFrom: "",
    dateTo: "",
    page: 1,
    pageSize: 20
  }
});

const filterDefaults = {
  query: "",
  shopId: "all",
  dateFrom: "",
  dateTo: "",
  page: 1,
  pageSize: 20
};

const pagedRows = computed(() => state.rows);

function applyRouteState() {
  syncingRoute = true;
  try {
    applyFilterQuery(route, state.filters, filterDefaults);
  } finally {
    syncingRoute = false;
  }
}

function syncRouteQuery() {
  if (syncingRoute) return;
  const next = buildFilterQuery(route, state.filters, filterDefaults);
  if (JSON.stringify(route.query || {}) === JSON.stringify(next)) return;
  router.replace({ query: next });
}

function handleSearch() {
  state.filters.page = 1;
  loadPageData();
}

function handleReset() {
  Object.assign(state.filters, filterDefaults);
  loadPageData();
}

function handlePageChange(page) {
  state.filters.page = page;
  loadPageData();
}

function handlePageSizeChange(size) {
  state.filters.pageSize = size;
  state.filters.page = 1;
  loadPageData();
}

async function restoreProduct(row) {
  try {
    await apiClient.post(`/api/products/${row.id}/restore`, {});
    ElMessage.success("商品已恢复到库存表");
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "恢复商品失败");
  }
}

async function loadPageData() {
  const requestToken = listRequestGate.next();
  loading.value = true;
  try {
    const params = new URLSearchParams({
      paged: "1",
      page: String(state.filters.page),
      pageSize: String(state.filters.pageSize),
      shopId: String(state.filters.shopId || "all"),
      dateFrom: String(state.filters.dateFrom || ""),
      dateTo: String(state.filters.dateTo || "")
    });
    const query = String(state.filters.query || "").trim();
    if (query) params.set("query", query);
    const requests = [apiClient.get(`/api/products/hidden?${params.toString()}`)];
    if (!shopsLoaded) requests.push(apiClient.get("/api/shops"));
    const [rows, shops] = await Promise.all(requests);
    if (!listRequestGate.isLatest(requestToken)) return;
    state.rows = Array.isArray(rows?.rows) ? rows.rows : [];
    state.total = Number(rows?.total || 0);
    if (!shopsLoaded) {
      state.shops = Array.isArray(shops) ? shops : [];
      shopsLoaded = true;
    }
  } catch (error) {
    if (!listRequestGate.isLatest(requestToken)) return;
    ElMessage.error(error.message || "已隐藏产品加载失败");
  } finally {
    if (listRequestGate.isLatest(requestToken)) loading.value = false;
  }
}

watch(() => route.query, applyRouteState, { deep: true });
watch(() => [state.filters.query, state.filters.shopId, state.filters.dateFrom, state.filters.dateTo, state.filters.page, state.filters.pageSize], syncRouteQuery);

onMounted(async () => {
  applyRouteState();
  await loadPageData();
});
</script>

<template>
  <div class="inventory-page-shell inventory-card">
    <InventoryPageToolbar
      :filters="state.filters"
      :shops="state.shops"
      query-label="隐藏产品搜索"
      query-placeholder="产品名称 / 库存ID / 负责人"
      @search="handleSearch"
      @reset="handleReset"
    />

    <div class="inventory-table-wrap">
      <el-table v-loading="loading" :data="pagedRows" stripe border class="erp-data-table">
        <el-table-column label="隐藏产品" min-width="280" fixed="left">
          <template #default="{ row }">
            <div class="product-cell">
              <ProductImagePreview :src="row.image_url" />
              <div class="cell-stack">
                <strong>{{ row.name }}</strong>
                <span class="muted-text">{{ row.inventory_id || row.code || "-" }}</span>
                <span class="muted-text">负责人：{{ row.owner_name || "-" }}</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="当前库存" width="110" align="center">
          <template #default="{ row }">{{ integer(row.stock) }}</template>
        </el-table-column>
        <el-table-column label="待入库" width="110" align="center">
          <template #default="{ row }">{{ integer(row.pending_inbound) }}</template>
        </el-table-column>
        <el-table-column label="库存流水" width="110" align="center">
          <template #default="{ row }">{{ integer(row.movement_count) }}</template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ dateText(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="restoreProduct(row)">恢复到库存表</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <PageFooterPagination
      :total="state.total"
      :page="state.filters.page"
      :page-size="state.filters.pageSize"
      
      @update:page="handlePageChange"
      @update:pageSize="handlePageSizeChange"
    />
  </div>
</template>

