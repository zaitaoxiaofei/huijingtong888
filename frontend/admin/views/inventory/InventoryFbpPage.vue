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
const syncLoading = ref(false);
const state = reactive({
  rows: [],
  total: 0,
  shops: [],
  filters: {
    query: "",
    shopId: "all",
    dateFrom: "",
    dateTo: "",
    alertType: "all",
    sortKey: "fbp_available",
    sortDir: "asc",
    page: 1,
    pageSize: 20
  }
});

const filterDefaults = {
  query: "",
  shopId: "all",
  dateFrom: "",
  dateTo: "",
  alertType: "all",
  sortKey: "fbp_available",
  sortDir: "asc",
  page: 1,
  pageSize: 20
};

const pagedRows = computed(() => state.rows);

function coverageText(row) {
  if (row.stock_days !== null && row.stock_days !== undefined && row.stock_days !== "") {
    return `${Number(row.stock_days || 0).toFixed(1)} 天`;
  }
  if (row.coverage_days !== null && row.coverage_days !== undefined) {
    return `${Number(row.coverage_days || 0).toFixed(1)} 天`;
  }
  const recent30d = Number(row.recent_30d_qty || 0);
  if (recent30d <= 0) return Number(row.fbp_available || 0) > 0 ? "30天无销量" : "暂无销量";
  const daily = recent30d / 30;
  const days = daily > 0 ? Number(row.fbp_available || 0) / daily : 0;
  return `${days.toFixed(1)} 天`;
}

function adviceText(row) {
  if (row.suggestion) return row.suggestion;
  const available = Number(row.fbp_available || 0);
  const recent30d = Number(row.recent_30d_qty || 0);
  const daily = recent30d > 0 ? recent30d / 30 : 0;
  const days = daily > 0 ? available / daily : null;
  if (available <= 0) return "FBP已断货，优先补仓或调整库存策略。";
  if (days !== null && days <= 7) return "预计7天内断货，建议立即补仓。";
  if (days !== null && days <= 30) return "预计30天内断货，建议排入补货计划。";
  if (days !== null && days >= 60) return "预计库存超过60天，关注资金占用和滞缓风险。";
  if (!recent30d && available > 0) return "30天无销量但有FBP库存，检查是否需要促销或减少补仓。";
  return "库存相对充足";
}

function fbpAlertTag(row) {
  if (row.alert_type === "out_of_stock") return "断货";
  if (row.alert_type === "within_7_days") return "7天";
  if (row.alert_type === "within_30_days") return "30天";
  if (row.alert_type === "over_60_days") return "60天滞缓";
  if (row.alert_type === "no_sales") return "30天无销量";
  return "";
}

function fbpAlertTagType(row) {
  if (row.alert_level === "danger") return "danger";
  if (row.alert_level === "warning") return "warning";
  return "info";
}

function paidStorageDateText(row) {
  const value = String(row.paid_storage_start_at || "").slice(0, 10);
  if (!value) return "-";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  const days = Math.ceil((date.getTime() - Date.now()) / 86400000);
  return days > 0 ? `${value} / ${days}天` : value;
}

function setSort(sortKey) {
  if (state.filters.sortKey === sortKey) state.filters.sortDir = state.filters.sortDir === "asc" ? "desc" : "asc";
  else {
    state.filters.sortKey = sortKey;
    state.filters.sortDir = "asc";
  }
  state.filters.page = 1;
  loadPageData();
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

function openMappings() {
  router.push("/inventory/mappings");
}

function openProcurement(row) {
  router.push({ path: "/procurement", query: { productId: String(row.product_id), from: "inventory-fbp" } });
}

function openExternalLink(url) {
  const target = String(url || "").trim();
  if (!target) return;
  window.open(target, "_blank", "noopener,noreferrer");
}

function ozonBuyerProductLinkFor(row) {
  const productId = String(row?.ozon_product_id || "").trim();
  return productId ? `https://www.ozon.ru/product/${encodeURIComponent(productId)}/` : "";
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
  const requestToken = listRequestGate.next();
  loading.value = true;
  try {
    const params = new URLSearchParams({
      mode: "fbp",
      paged: "1",
      page: String(state.filters.page),
      pageSize: String(state.filters.pageSize),
      shopId: String(state.filters.shopId || "all"),
      dateFrom: String(state.filters.dateFrom || ""),
      dateTo: String(state.filters.dateTo || ""),
      alertType: String(state.filters.alertType || "all"),
      sortKey: String(state.filters.sortKey || "fbp_available"),
      sortDir: String(state.filters.sortDir || "asc")
    });
    const query = String(state.filters.query || "").trim();
    if (query) params.set("query", query);
    const requests = [apiClient.get(`/api/stock-alerts?${params.toString()}`)];
    if (!shopsLoaded) requests.push(apiClient.get("/api/shops"));
    const [payload, shops] = await Promise.all(requests);
    if (!listRequestGate.isLatest(requestToken)) return;
    state.rows = Array.isArray(payload?.rows) ? payload.rows : [];
    state.total = Number(payload?.total || 0);
    if (!shopsLoaded) {
      state.shops = Array.isArray(shops) ? shops : [];
      shopsLoaded = true;
    }
  } catch (error) {
    if (!listRequestGate.isLatest(requestToken)) return;
    ElMessage.error(error.message || "FBP 库存表加载失败");
  } finally {
    if (listRequestGate.isLatest(requestToken)) loading.value = false;
  }
}

watch(() => route.query, applyRouteState, { deep: true });
watch(() => [state.filters.query, state.filters.shopId, state.filters.dateFrom, state.filters.dateTo, state.filters.alertType, state.filters.sortKey, state.filters.sortDir, state.filters.page, state.filters.pageSize], syncRouteQuery);

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
              <ProductImagePreview :src="row.image_url" />
              <div class="cell-stack">
                <a
                  v-if="ozonBuyerProductLinkFor(row)"
                  class="inventory-product-link"
                  :href="ozonBuyerProductLinkFor(row)"
                  target="_blank"
                  rel="noopener noreferrer"
                  :title="`打开 Ozon 前台商品 ${row.name || row.ozon_sku || ''}`"
                  @click.prevent.stop="openExternalLink(ozonBuyerProductLinkFor(row))"
                >
                  {{ row.name || row.ozon_sku || "-" }}
                </a>
                <strong v-else>{{ row.name || row.ozon_sku || "-" }}</strong>
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
        <el-table-column label="存储计费" width="150" align="center">
          <template #default="{ row }">
            <div class="cell-stack cell-center">
              <strong>免费 {{ integer(row.free_stock_count ?? row.fbp_available) }}</strong>
              <span class="muted-text">收费 {{ integer(row.paid_stock_count) }}</span>
              <span v-if="Number(row.expiring_stock_count || 0)" class="muted-text">待付费 {{ integer(row.expiring_stock_count) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="付费开始" width="150" align="center">
          <template #default="{ row }">
            <span class="muted-text">{{ paidStorageDateText(row) }}</span>
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
          <template #default="{ row }">
            <div class="cell-stack cell-center">
              <strong>{{ coverageText(row) }}</strong>
              <el-tag v-if="fbpAlertTag(row)" :type="fbpAlertTagType(row)" size="small">{{ fbpAlertTag(row) }}</el-tag>
            </div>
          </template>
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
      :total="state.total"
      :page="state.filters.page"
      :page-size="state.filters.pageSize"
      
      @update:page="handlePageChange"
      @update:pageSize="handlePageSizeChange"
    />
  </div>
</template>

