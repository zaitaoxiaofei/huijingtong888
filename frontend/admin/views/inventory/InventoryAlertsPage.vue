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
import WarehouseProcurementRequestDialog from "../../components/procurement/WarehouseProcurementRequestDialog.vue";
import { applyFilterQuery, dateText, integer } from "./inventory-utils.js";

const route = useRoute();
const router = useRouter();
let syncingRoute = false;
const listRequestGate = createLatestRequestGate();

const loading = ref(false);
const syncLoading = ref(false);
const rowActionLoading = ref("");
const requestDialogVisible = ref(false);
const requestProducts = ref([]);
const state = reactive({
  rows: [],
  total: 0,
  meta: {},
  shops: [],
  filters: {
    view: "inventory",
    alertType: "all",
    query: "",
    shopId: "all",
    dateFrom: "",
    dateTo: "",
    page: 1,
    pageSize: 20
  }
});

const filterDefaults = {
  view: "inventory",
  alertType: "all",
  query: "",
  shopId: "all",
  dateFrom: "",
  dateTo: "",
  page: 1,
  pageSize: 20
};

const pagedRows = computed(() => state.rows);
const inventoryView = computed(() => state.filters.view !== "sku");
const inventoryAlertFilters = [
  { value: "all", label: "全部" },
  { value: "out_of_stock", label: "断货" },
  { value: "low_stock", label: "缺货" },
  { value: "in_transit", label: "采购在途" },
  { value: "healthy", label: "库存健康" },
  { value: "lead_time_missing", label: "周期待设置" }
];
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

function inventoryAlertLabel(row) {
  if (row.alert_type === "out_of_stock") return "断货";
  if (row.alert_type === "low_stock") return "缺货";
  if (row.alert_type === "healthy") return "库存健康";
  return "周期待设置";
}

function inventoryAlertTagType(row) {
  if (row.alert_type === "out_of_stock") return "danger";
  if (row.alert_type === "low_stock") return "warning";
  if (row.alert_type === "healthy") return "success";
  return "info";
}

function openWarehouseRequest(row) {
  requestProducts.value = [{
    id: row.product_id,
    name: row.product_name,
    inventory_number: row.inventory_number || row.inventory_id,
    image_url: row.image_url,
    suggested_purchase_qty: Math.max(1, Number(row.suggested_purchase_qty || 0))
  }];
  requestDialogVisible.value = true;
}

function changeView(view) {
  state.filters.view = view;
  state.filters.alertType = "all";
  state.filters.page = 1;
  syncRouteQuery("manual");
  loadPageData();
}

function changeAlertType(value) {
  state.filters.alertType = value;
  state.filters.page = 1;
  syncRouteQuery("manual");
  loadPageData();
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
      mode: inventoryView.value ? "inventory-alerts" : "fbp-alerts",
      paged: "1",
      page: String(state.filters.page),
      pageSize: String(state.filters.pageSize),
      alertType: String(state.filters.alertType || "all")
    });
    if (!inventoryView.value) {
      params.set("shopId", String(state.filters.shopId || "all"));
      params.set("dateFrom", String(state.filters.dateFrom || ""));
      params.set("dateTo", String(state.filters.dateTo || ""));
    }
    const query = String(state.filters.query || "").trim();
    if (query) params.set("query", query);
    const requests = [apiClient.get(`/api/stock-alerts?${params.toString()}`), inventoryView.value ? Promise.resolve(state.shops) : loadShopDictionary()];
    const [payload, shops] = await Promise.all(requests);
    if (!listRequestGate.isLatest(requestToken)) return;
    state.rows = Array.isArray(payload?.rows) ? payload.rows : [];
    state.total = Number(payload?.total || payload?.meta?.total || 0);
    state.meta = payload?.meta || {};
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
    <div class="alert-view-switch">
      <div class="alert-view-buttons">
        <el-button :type="inventoryView ? 'primary' : 'default'" @click="changeView('inventory')">库存视角</el-button>
        <el-button :type="!inventoryView ? 'primary' : 'default'" @click="changeView('sku')">FBP SKU 视角</el-button>
      </div>
      <span v-if="inventoryView" class="muted-text">按近 7 个完整北京时间日的日均销量 × 生产周期预警</span>
    </div>
    <InventoryPageToolbar
      :filters="state.filters"
      :shops="state.shops"
      :show-shop="!inventoryView"
      :show-date-range="!inventoryView"
      :query-label="inventoryView ? '库存搜索' : 'FBP预警搜索'"
      :query-placeholder="inventoryView ? '库存编号 / 名称关键词' : '完整库存编号 / SKU / Offer / 名称关键词'"
      @search="handleSearch"
      @reset="handleReset"
    />

    <div v-if="inventoryView" class="alert-status-filters">
      <el-button
        v-for="option in inventoryAlertFilters"
        :key="option.value"
        size="small"
        :type="state.filters.alertType === option.value ? 'primary' : 'default'"
        @click="changeAlertType(option.value)"
      >{{ option.label }}<span v-if="option.value !== 'all'" class="alert-filter-count">{{ state.meta[option.value] ?? 0 }}</span></el-button>
    </div>

    <div class="inventory-table-wrap erp-responsive-table" role="region" aria-label="库存预警表格" tabindex="0">
      <el-table v-if="inventoryView" v-loading="loading" :data="pagedRows" stripe border class="erp-data-table inventory-alert-table">
        <el-table-column label="主图" width="90" fixed="left">
          <template #default="{ row }"><ProductImagePreview :src="row.image_url" :preview-list="row.image_url ? [row.image_url] : []" size="portrait" fit="cover" /></template>
        </el-table-column>
        <el-table-column label="库存信息" min-width="350">
          <template #default="{ row }">
            <div class="cell-stack">
              <ProductTitleLink :title="row.product_name || '-'" :lines="2" />
              <span class="inventory-id-display">库存 ID：{{ row.inventory_number || row.inventory_id || row.product_id }}</span>
              <span>剩余可用 <strong :class="{ 'danger-text': row.available_stock <= 0 }">{{ integer(row.available_stock) }}</strong> · 本地实物 <strong>{{ integer(row.physical_stock) }}</strong></span>
              <span class="muted-text">采购在途 {{ integer(row.incoming_stock) }} · 待履约占用 {{ integer(row.open_order_demand_qty) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="生产周期" width="120" align="center">
          <template #default="{ row }"><strong v-if="row.production_lead_days">{{ row.production_lead_days }} 天</strong><el-tag v-else type="info">待设置</el-tag></template>
        </el-table-column>
        <el-table-column label="销量" width="150" align="center">
          <template #default="{ row }"><div class="cell-stack cell-center"><strong>近 7 天 {{ integer(row.recent_7d_qty) }}</strong><span class="muted-text">近 15 天 {{ integer(row.recent_15d_qty) }}</span></div></template>
        </el-table-column>
        <el-table-column label="预警" min-width="210">
          <template #default="{ row }">
            <div class="cell-stack">
              <div class="alert-row-tags"><el-tag :type="inventoryAlertTagType(row)">{{ inventoryAlertLabel(row) }}</el-tag><el-tag v-if="row.lead_time_missing && row.alert_type !== 'lead_time_missing'" type="info">周期待设置</el-tag><el-tag v-if="row.in_transit" type="primary">采购在途</el-tag></div>
              <span v-if="row.alert_quantity !== null">预警线 {{ integer(row.alert_quantity) }} 件 · 日均 {{ Number(row.daily_sales_7d || 0).toFixed(2) }}</span>
              <span v-else class="muted-text">设置生产周期后计算预警线</span>
              <span v-if="row.suggested_purchase_qty > 0" class="muted-text">建议补 {{ integer(row.suggested_purchase_qty) }} 件（已扣在途）</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }"><el-button link type="primary" :disabled="row.suggested_purchase_qty <= 0" @click="openWarehouseRequest(row)">提交采购需求</el-button></template>
        </el-table-column>
      </el-table>
      <el-table v-else v-loading="loading || syncLoading" :data="pagedRows" stripe border class="erp-data-table">
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
              <span class="inventory-id-display">库存 ID：{{ row.inventory_number || row.inventory_id || "-" }}</span>
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
    <WarehouseProcurementRequestDialog v-model="requestDialogVisible" :products="requestProducts" @submitted="loadPageData" />
  </div>
</template>

<style scoped>
.alert-view-switch { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; padding: 12px 14px 4px; }
.alert-view-buttons { display: flex; gap: 8px; }
.alert-view-buttons .el-button + .el-button { margin-left: 0; }
.alert-status-filters { display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 14px 12px; }
.alert-status-filters .el-button + .el-button { margin-left: 0; }
.alert-filter-count { margin-left: 5px; opacity: .8; }
.alert-row-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.inventory-alert-table :deep(.el-table__row) { height: 92px; }
</style>
