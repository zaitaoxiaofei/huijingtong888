<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { loadShopDictionary } from "../../utils/shop-dictionary";
import { createLatestRequestGate } from "../../utils/request-gate";
import { createDefaultRouteQuerySync } from "../../utils/route-query-sync.js";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import ProductTitleLink from "../../components/ProductTitleLink.vue";
import InventoryPageToolbar from "../../components/inventory/InventoryPageToolbar.vue";
import { applyFilterQuery, dateText, integer } from "./inventory-utils.js";

const route = useRoute();
const router = useRouter();
let syncingRoute = false;
const listRequestGate = createLatestRequestGate();

const loading = ref(false);
const syncLoading = ref(false);
const rowActionLoading = ref("");
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
const syncRouteQuery = createDefaultRouteQuerySync({
  route,
  router,
  filters: state.filters,
  defaults: filterDefaults,
  manualKeys: ["query"],
  isSyncingRoute: () => syncingRoute
});

function warningTagType(level) {
  if (level === "danger") return "danger";
  if (level === "warning") return "warning";
  if (level === "info") return "";
  return "success";
}

function coverageText(row) {
  if (row.coverage_days === null || row.coverage_days === undefined) {
    return Number(row.fbp_available || 0) > 0 ? "近两周无销量" : "已断货";
  }
  return `${Number(row.coverage_days || 0).toFixed(1)} 天`;
}

function dailySalesText(row) {
  return Number(row.dynamic_daily_sales || row.daily_sales_14d || 0).toFixed(2);
}

function suggestedQty(row) {
  return Math.max(0, Math.round(Number(row.suggested_qty || 0)));
}

function applyRouteState() {
  syncingRoute = true;
  try {
    applyFilterQuery(route, state.filters, filterDefaults);
  } finally {
    syncingRoute = false;
  }
}

function handleSearch() {
  state.filters.page = 1;
  syncRouteQuery("manual");
  loadPageData();
}

function handleReset() {
  Object.assign(state.filters, filterDefaults);
  syncRouteQuery("manual");
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

async function offerOpenReplenishmentPage(message = "FBP 备货单草稿已创建。") {
  try {
    await ElMessageBox.confirm(message, "备货单已创建", {
      type: "success",
      confirmButtonText: "去备货单页面",
      cancelButtonText: "继续当前页",
      distinguishCancelAndClose: true
    });
    router.push("/inventory/fbp-replenishment");
  } catch {
    // Operator chose to stay on the current recommendation page.
  }
}

async function createReplenishmentOrder(row) {
  const defaultQty = Math.max(1, suggestedQty(row) || 1);
  let requestedQty = defaultQty;
  try {
    const result = await ElMessageBox.prompt("填写这次要备货到 FBP 的数量", "创建FBP备货单", {
      confirmButtonText: "创建",
      cancelButtonText: "取消",
      inputValue: String(defaultQty),
      inputPattern: /^[1-9]\d*$/,
      inputErrorMessage: "请输入大于0的整数"
    });
    requestedQty = Math.max(1, Math.round(Number(result.value || defaultQty)));
  } catch {
    return;
  }
  rowActionLoading.value = `order-${row.shop_id}-${row.ozon_sku}`;
  try {
    await apiClient.post("/api/fbp-replenishment-orders", {
      rows: [{ ...row, requested_qty: requestedQty, approved_qty: requestedQty }]
    });
    ElMessage.success("已加入 FBP 备货单草稿");
    await offerOpenReplenishmentPage("已加入 FBP 备货单草稿。");
  } catch (error) {
    ElMessage.error(error.message || "创建备货单失败");
  } finally {
    rowActionLoading.value = "";
  }
}

async function ignoreReplenishment(row) {
  rowActionLoading.value = `ignore-${row.shop_id}-${row.ozon_sku}`;
  try {
    await apiClient.post("/api/fbp-replenishment-ignore", {
      shop_id: row.shop_id,
      ozon_sku: row.ozon_sku,
      product_id: row.product_id,
      mapping_id: row.mapping_id,
      reason: "不再备货 FBP"
    });
    ElMessage.success("已忽略该 FBP SKU，后续不再预警");
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "忽略失败");
  } finally {
    rowActionLoading.value = "";
  }
}

async function syncSingleProduct(row) {
  syncLoading.value = true;
  try {
    await apiClient.post("/api/sync/ozon-stocks", { product_id: row.product_id });
    ElMessage.success("已同步该产品库存");
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "同步库存失败");
  } finally {
    syncLoading.value = false;
  }
}

async function loadPageData() {
  const requestToken = listRequestGate.next();
  loading.value = true;
  try {
    const params = new URLSearchParams({
      mode: "fbp-alerts",
      paged: "1",
      page: String(state.filters.page),
      pageSize: String(state.filters.pageSize),
      shopId: String(state.filters.shopId || "all"),
      dateFrom: String(state.filters.dateFrom || ""),
      dateTo: String(state.filters.dateTo || "")
    });
    const query = String(state.filters.query || "").trim();
    if (query) params.set("query", query);
    const requests = [apiClient.get(`/api/stock-alerts?${params.toString()}`), loadShopDictionary()];
    const [payload, shops] = await Promise.all(requests);
    if (!listRequestGate.isLatest(requestToken)) return;
    state.rows = Array.isArray(payload?.rows) ? payload.rows : [];
    state.total = Number(payload?.total || payload?.meta?.total || 0);
    state.shops = Array.isArray(shops) ? shops : [];
  } catch (error) {
    if (!listRequestGate.isLatest(requestToken)) return;
    ElMessage.error(error.message || "库存预警加载失败");
  } finally {
    if (listRequestGate.isLatest(requestToken)) loading.value = false;
  }
}

watch(() => route.query, applyRouteState, { deep: true });
watch(() => [state.filters.shopId, state.filters.dateFrom, state.filters.dateTo, state.filters.page, state.filters.pageSize], syncRouteQuery);

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
      query-label="FBP预警搜索"
      query-placeholder="店铺 / SKU / Offer / 产品名称"
      @search="handleSearch"
      @reset="handleReset"
    />

    <div class="inventory-table-wrap">
      <el-table v-loading="loading || syncLoading" :data="pagedRows" stripe border class="erp-data-table">
        <el-table-column label="店铺" width="130" fixed="left">
          <template #default="{ row }"><strong>{{ row.shop_name || "-" }}</strong></template>
        </el-table-column>
        <el-table-column label="FBP SKU" min-width="300">
          <template #default="{ row }">
            <div class="product-cell">
              <ProductImagePreview :src="row.image_url || row.product_image_url" />
              <div class="cell-stack">
                <ProductTitleLink :title="row.name || row.product_name || '-'" :lines="2" />
                <span class="muted-text">SKU {{ row.ozon_sku || "-" }}</span>
                <span class="muted-text">Offer {{ row.offer_id || "-" }}</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="关联库存" min-width="220">
          <template #default="{ row }">
            <div class="cell-stack">
              <strong>{{ row.product_name || "未绑定库存" }}</strong>
              <span class="muted-text">{{ row.inventory_id || "-" }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="FBP可售" width="110" align="center">
          <template #default="{ row }">
            <strong :class="{ 'danger-text': Number(row.fbp_available || 0) <= 0 }">{{ integer(row.fbp_available) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="近两周销量" width="150" align="center">
          <template #default="{ row }">
            <div class="cell-stack cell-center">
              <strong>7天 {{ integer(row.recent_7d_qty) }}</strong>
              <span class="muted-text">前7天 {{ integer(row.prev_7d_qty) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="动态日销" width="110" align="center">
          <template #default="{ row }">{{ dailySalesText(row) }}</template>
        </el-table-column>
        <el-table-column label="预计可撑" width="120" align="center">
          <template #default="{ row }">
            <strong>{{ coverageText(row) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="建议备货" width="110" align="center">
          <template #default="{ row }">
            <strong>{{ integer(suggestedQty(row)) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="预警标签" min-width="260">
          <template #default="{ row }">
            <el-space wrap>
              <el-tag
                v-for="warning in row.warnings || []"
                :key="`${row.product_id}-${warning.type}`"
                :type="warningTagType(warning.level)"
              >
                {{ warning.text }}
              </el-tag>
              <span v-if="!(row.warnings || []).length" class="muted-text">正常</span>
            </el-space>
          </template>
        </el-table-column>
        <el-table-column label="建议" min-width="240">
          <template #default="{ row }">
            <span class="muted-text">{{ row.suggestion || "-" }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最后同步" width="170">
          <template #default="{ row }">{{ dateText(row.last_synced_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-space wrap>
              <el-button
                class="erp-btn-link"
                link
                type="success"
                :loading="rowActionLoading === `order-${row.shop_id}-${row.ozon_sku}`"
                @click="createReplenishmentOrder(row)"
              >创建备货单</el-button>
              <el-button
                class="erp-btn-link"
                link
                type="warning"
                :loading="rowActionLoading === `ignore-${row.shop_id}-${row.ozon_sku}`"
                @click="ignoreReplenishment(row)"
              >忽略</el-button>
              <el-button class="erp-btn-link" link type="primary" @click="syncSingleProduct(row)">同步库存</el-button>
              <el-button class="erp-btn-link" link @click="openMappings()">编辑绑定</el-button>
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

