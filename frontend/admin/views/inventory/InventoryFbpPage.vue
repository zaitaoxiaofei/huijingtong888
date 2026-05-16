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
const syncLoading = ref(false);
const state = reactive({
  sourceRows: [],
  shops: [],
  filters: {
    query: "",
    shopId: "all",
    dateFrom: "",
    dateTo: "",
    sortKey: "fbp_available",
    sortDir: "asc",
    page: 1,
    pageSize: 30
  }
});

const filterDefaults = {
  query: "",
  shopId: "all",
  dateFrom: "",
  dateTo: "",
  sortKey: "fbp_available",
  sortDir: "asc",
  page: 1,
  pageSize: 30
};

const flattenedRows = computed(() => {
  const result = [];
  for (const product of state.sourceRows) {
    const skus = Array.isArray(product.skus) ? product.skus : [];
    skus.forEach((sku) => {
      if (Number(sku.fbp_snapshot_count || 0) <= 0 && Number(sku.fbp_present || 0) <= 0 && Number(sku.fbp_available || 0) <= 0) return;
      result.push({
        product_id: product.product_id,
        product_name: product.product_name,
        product_image_url: product.image_url,
        inventory_id: product.inventory_id,
        alert_stock: product.alert_stock,
        local_stock: product.local_stock,
        created_at: product.created_at,
        recent_3d_qty: sku.recent_3d_qty,
        recent_7d_qty: sku.recent_7d_qty,
        recent_30d_qty: sku.recent_30d_qty,
        prev_7d_qty: sku.prev_7d_qty,
        all_time_qty: sku.all_time_qty,
        ...sku
      });
    });
  }
  return result;
});

const filteredRows = computed(() => {
  const query = normalizeSearch(state.filters.query);
  const shopId = String(state.filters.shopId || "all");
  const rows = flattenedRows.value.filter((row) => {
    if (shopId !== "all" && String(row.shop_id || "") !== shopId) return false;
    if (!isWithinDateRange(row.created_at, state.filters.dateFrom, state.filters.dateTo)) return false;
    if (!query) return true;
    const haystack = [row.shop_name, row.name, row.ozon_sku, row.offer_id, row.product_name, row.inventory_id].map(normalizeSearch).join(" ");
    return haystack.includes(query);
  });
  const factor = state.filters.sortDir === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => {
    const a = Number(left[state.filters.sortKey] || 0);
    const b = Number(right[state.filters.sortKey] || 0);
    if (a === b) return Number(left.product_id || 0) - Number(right.product_id || 0);
    return (a - b) * factor;
  });
});

const pagedRows = computed(() => paginate(filteredRows.value, state.filters.page, state.filters.pageSize));

function coverageText(row) {
  const recent7d = Number(row.recent_7d_qty || 0);
  if (recent7d <= 0) return "暂无销量";
  const daily = recent7d / 7;
  const days = daily > 0 ? Number(row.fbp_available || 0) / daily : 0;
  return `${days.toFixed(1)} 天`;
}

function adviceText(row) {
  const available = Number(row.fbp_available || 0);
  const recent3d = Number(row.recent_3d_qty || 0);
  const recent7d = Number(row.recent_7d_qty || 0);
  const recent30d = Number(row.recent_30d_qty || 0);
  if (recent3d > 0 && available <= recent3d) return "低于 3 天销量，建议立即补仓";
  if (recent7d > 0 && available <= recent7d) return "低于 7 天销量，建议抓紧补货";
  if (recent30d > 0 && available <= recent30d) return "低于 30 天销量，建议评估补货";
  return "库存相对充足";
}

function setSort(sortKey) {
  if (state.filters.sortKey === sortKey) state.filters.sortDir = state.filters.sortDir === "asc" ? "desc" : "asc";
  else {
    state.filters.sortKey = sortKey;
    state.filters.sortDir = "asc";
  }
  state.filters.page = 1;
}

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

function openMappings() {
  router.push("/inventory/mappings");
}

function openProcurement(row) {
  router.push({ path: "/procurement", query: { productId: String(row.product_id), from: "inventory-fbp" } });
}

async function refreshStocks() {
  syncLoading.value = true;
  try {
    await apiClient.post("/api/sync/ozon-stocks", {});
    ElMessage.success("FBP 库存已刷新同步");
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "刷新 FBP 库存失败");
  } finally {
    syncLoading.value = false;
  }
}

async function syncSingleProduct(row) {
  syncLoading.value = true;
  try {
    await apiClient.post("/api/sync/ozon-stocks", { product_id: row.product_id });
    ElMessage.success("已同步该产品 FBP 库存");
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "同步 FBP 库存失败");
  } finally {
    syncLoading.value = false;
  }
}

async function loadPageData() {
  loading.value = true;
  try {
    const [payload, shops] = await Promise.all([
      apiClient.get("/api/stock-alerts"),
      apiClient.get("/api/shops")
    ]);
    state.sourceRows = Array.isArray(payload?.rows) ? payload.rows : [];
    state.shops = Array.isArray(shops) ? shops : [];
  } catch (error) {
    ElMessage.error(error.message || "FBP 库存表加载失败");
  } finally {
    loading.value = false;
  }
}

watch(() => route.query, applyRouteState, { deep: true });
watch(() => [state.filters.query, state.filters.shopId, state.filters.dateFrom, state.filters.dateTo, state.filters.sortKey, state.filters.sortDir, state.filters.page, state.filters.pageSize], syncRouteQuery);

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
      query-label="FBP搜索"
      query-placeholder="店铺 / SKU / Offer / 产品名称"
      @search="handleSearch"
      @reset="handleReset"
    >
      <template #actions>
        <el-button :loading="syncLoading" @click="refreshStocks">刷新同步</el-button>
      </template>
    </InventoryPageToolbar>

    <div class="inventory-table-wrap">
      <el-table v-loading="loading || syncLoading" :data="pagedRows" stripe border class="erp-data-table">
        <el-table-column label="店铺" width="130" fixed="left">
          <template #default="{ row }"><strong>{{ row.shop_name || "-" }}</strong></template>
        </el-table-column>
        <el-table-column label="SKU信息" min-width="320">
          <template #default="{ row }">
            <div class="product-cell">
              <el-image v-if="row.image_url" :src="row.image_url" fit="cover" class="product-thumb" />
              <div class="cell-stack">
                <strong>{{ row.name || row.ozon_sku || "-" }}</strong>
                <span class="muted-text">SKU {{ row.ozon_sku || "-" }}</span>
                <span class="muted-text">Offer {{ row.offer_id || "-" }}</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="FBP可售" width="120" align="center">
          <template #header>
            <button type="button" class="inventory-sort-btn" @click="setSort('fbp_available')">
              FBP可售 {{ state.filters.sortKey === 'fbp_available' ? (state.filters.sortDir === 'asc' ? '↑' : '↓') : '' }}
            </button>
          </template>
          <template #default="{ row }">
            <strong :class="{ 'danger-text': Number(row.fbp_available || 0) <= 0 }">{{ integer(row.fbp_available) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="关联库存" min-width="220">
          <template #default="{ row }">
            <div class="cell-stack">
              <strong>{{ row.product_name || "未绑定库存" }}</strong>
              <span class="muted-text">{{ row.inventory_id || "-" }}</span>
              <span class="muted-text">本地库存 {{ integer(row.local_stock) }} / 预警 {{ integer(row.alert_stock) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="30天销量" width="120" align="center">
          <template #header>
            <button type="button" class="inventory-sort-btn" @click="setSort('recent_30d_qty')">
              30天销量 {{ state.filters.sortKey === 'recent_30d_qty' ? (state.filters.sortDir === 'asc' ? '↑' : '↓') : '' }}
            </button>
          </template>
          <template #default="{ row }">{{ integer(row.recent_30d_qty) }}</template>
        </el-table-column>
        <el-table-column label="7天趋势" width="150" align="center">
          <template #header>
            <button type="button" class="inventory-sort-btn" @click="setSort('recent_7d_qty')">
              7天趋势 {{ state.filters.sortKey === 'recent_7d_qty' ? (state.filters.sortDir === 'asc' ? '↑' : '↓') : '' }}
            </button>
          </template>
          <template #default="{ row }">
            <div class="cell-stack cell-center">
              <strong>7天 {{ integer(row.recent_7d_qty) }}</strong>
              <span class="muted-text">前7天 {{ integer(row.prev_7d_qty) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="库存覆盖" width="110" align="center">
          <template #default="{ row }">{{ coverageText(row) }}</template>
        </el-table-column>
        <el-table-column label="补货建议" min-width="220">
          <template #default="{ row }">
            <span class="muted-text">{{ adviceText(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最后同步" width="170">
          <template #default="{ row }">{{ dateText(row.last_synced_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-space wrap>
              <el-button link type="primary" @click="syncSingleProduct(row)">同步库存</el-button>
              <el-button link @click="openMappings()">编辑绑定</el-button>
              <el-button link @click="openProcurement(row)">创建采购</el-button>
            </el-space>
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
