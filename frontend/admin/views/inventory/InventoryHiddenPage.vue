<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import InventoryPageToolbar from "../../components/inventory/InventoryPageToolbar.vue";
import { applyFilterQuery, buildFilterQuery, dateText, integer, isWithinDateRange, normalizeSearch, paginate } from "./inventory-utils.js";

const route = useRoute();
const router = useRouter();
let syncingRoute = false;

const loading = ref(false);
const state = reactive({
  rows: [],
  mappings: [],
  shops: [],
  filters: {
    query: "",
    shopId: "all",
    dateFrom: "",
    dateTo: "",
    page: 1,
    pageSize: 30
  }
});

const filterDefaults = {
  query: "",
  shopId: "all",
  dateFrom: "",
  dateTo: "",
  page: 1,
  pageSize: 30
};

const enrichedRows = computed(() => {
  const shopMap = new Map();
  for (const mapping of state.mappings) {
    const productId = Number(mapping.product_id || 0);
    if (!productId) continue;
    if (!shopMap.has(productId)) shopMap.set(productId, new Set());
    if (mapping.shop_id) shopMap.get(productId).add(String(mapping.shop_id));
  }
  return state.rows.map((row) => ({ ...row, shop_ids: [...(shopMap.get(Number(row.id)) || new Set())] }));
});

const filteredRows = computed(() => {
  const query = normalizeSearch(state.filters.query);
  const shopId = String(state.filters.shopId || "all");
  return enrichedRows.value.filter((row) => {
    if (shopId !== "all" && !row.shop_ids.includes(shopId)) return false;
    if (!isWithinDateRange(row.created_at, state.filters.dateFrom, state.filters.dateTo)) return false;
    if (!query) return true;
    const haystack = [row.name, row.code, row.inventory_id, row.owner_name].map(normalizeSearch).join(" ");
    return haystack.includes(query);
  });
});

const pagedRows = computed(() => paginate(filteredRows.value, state.filters.page, state.filters.pageSize));

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
}

function handleReset() {
  Object.assign(state.filters, filterDefaults);
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
  loading.value = true;
  try {
    const [rows, mappings, shops] = await Promise.all([
      apiClient.get("/api/products/hidden"),
      apiClient.get("/api/mappings"),
      apiClient.get("/api/shops")
    ]);
    state.rows = Array.isArray(rows) ? rows : [];
    state.mappings = Array.isArray(mappings) ? mappings : [];
    state.shops = Array.isArray(shops) ? shops : [];
  } catch (error) {
    ElMessage.error(error.message || "已隐藏产品加载失败");
  } finally {
    loading.value = false;
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
              <el-image v-if="row.image_url" :src="row.image_url" fit="cover" class="product-thumb" />
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
      :total="filteredRows.length"
      :page="state.filters.page"
      :page-size="state.filters.pageSize"
      :page-sizes="[30, 50, 100]"
      @update:page="state.filters.page = $event"
      @update:pageSize="state.filters.pageSize = $event; state.filters.page = 1"
    />
  </div>
</template>
