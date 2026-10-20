<script setup>
import { computed, defineAsyncComponent, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { hasPermission } from "../../../../src/shared/permissions.js";
import { useAuthStore } from "../../stores/auth";
import { loadShopDictionary } from "../../utils/shop-dictionary";
import { createLatestRequestGate } from "../../utils/request-gate";
import { createDefaultRouteQuerySync } from "../../utils/route-query-sync.js";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import ProductTitleLink from "../../components/ProductTitleLink.vue";
import InventoryPageToolbar from "../../components/inventory/InventoryPageToolbar.vue";
import WarehouseProcurementRequestDialog from "../../components/procurement/WarehouseProcurementRequestDialog.vue";
import { applyFilterQuery, dateText, integer } from "./inventory-utils.js";

const ProcurementLedgerDialog = defineAsyncComponent(() => import("../../components/procurement/ProcurementLedgerDialog.vue"));

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
let syncingRoute = false;
const listRequestGate = createLatestRequestGate();

const loading = ref(false);
const syncLoading = ref(false);
const rowActionLoading = ref("");
const requestDialogVisible = ref(false);
const requestProducts = ref([]);
const ledgerVisible = ref(false);
const selectedInventory = ref(null);
const ledgerInitialAction = ref("");
const editingLeadProductId = ref(0);
const editingLeadRow = ref(null);
const leadSavingProductId = ref(0);
const leadForm = reactive({ production_lead_days: 7, warehouse_logistics_days: 2, expected_production_lead_days: 7, expected_warehouse_logistics_days: 2 });
const productionLeadOptions = [3, 5, 7, 10, 15, 30];
const logisticsDayOptions = [1, 2, 3, 4, 5];
const state = reactive({
  rows: [],
  total: 0,
  meta: {},
  shops: [],
  filters: {
    view: "inventory",
    alertType: "all",
    sortBy: "recent_30d_qty",
    fbpFocus: "replenishment",
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
  sortBy: "recent_30d_qty",
  fbpFocus: "replenishment",
  query: "",
  shopId: "all",
  dateFrom: "",
  dateTo: "",
  page: 1,
  pageSize: 20
};

const pagedRows = computed(() => state.rows);
const inventoryView = computed(() => state.filters.view !== "sku");
const canEditInventory = computed(() => hasPermission(authStore.user, "inventory.write"));
const canSubmitRequest = computed(() => hasPermission(authStore.user, "procurement.request.submit"));
const inventoryAlertFilters = [
  { value: "all", label: "全部" },
  { value: "out_of_stock", label: "断货" },
  { value: "low_stock", label: "缺货" },
  { value: "in_transit", label: "采购在途" },
  { value: "healthy", label: "库存健康" }
];
const inventorySortOptions = [
  { value: "recent_30d_qty", label: "近 30 天消耗" },
  { value: "recent_15d_qty", label: "近 15 天消耗" },
  { value: "recent_7d_qty", label: "近 7 天消耗" }
];
const fbpFocusOptions = [
  { value: "replenishment", label: "待备货 SKU" },
  { value: "declining", label: "销量下滑 SKU" },
  { value: "all", label: "全部 FBP SKU" }
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

function fbpTrendTagType(type) {
  if (type === "continuous_decline" || type === "recent_decline") return "warning";
  if (type === "stable") return "success";
  return "info";
}

function fbpOperationSuggestion(row) {
  if (!row.replenishment_ignored && suggestedQty(row) > 0) return row.suggestion || "优先为当前 SKU 创建 FBP 备货单。";
  if (row.trend_type === "stockout") return "先核对供货，再判断需求变化。";
  if (row.trend_type === "continuous_decline") return "核对流量、售价、竞品和断货记录，再决定价格与备货策略。";
  if (row.trend_type === "recent_decline") return "留意下一周销量，核对曝光和售价变化。";
  return row.suggestion || "继续观察销量与库存。";
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

function sharedStockText(value) {
  return value == null ? "待核算" : `${integer(value)} 件`;
}

function applyRouteState() {
  syncingRoute = true;
  try {
    applyFilterQuery(route, state.filters, filterDefaults);
    if (state.filters.alertType === "lead_time_missing") state.filters.alertType = "all";
    if (!inventorySortOptions.some((option) => option.value === state.filters.sortBy)) state.filters.sortBy = "recent_30d_qty";
    if (!fbpFocusOptions.some((option) => option.value === state.filters.fbpFocus)) state.filters.fbpFocus = "replenishment";
  } finally {
    syncingRoute = false;
  }
}

function handleSearch() {
  cancelLeadEdit();
  state.filters.page = 1;
  syncRouteQuery("manual");
  loadPageData();
}

function handleReset() {
  cancelLeadEdit();
  Object.assign(state.filters, filterDefaults);
  syncRouteQuery("manual");
  loadPageData();
}

function handlePageChange(page) {
  cancelLeadEdit();
  state.filters.page = page;
  loadPageData();
}

function handlePageSizeChange(size) {
  cancelLeadEdit();
  state.filters.pageSize = size;
  state.filters.page = 1;
  loadPageData();
}

function openMappings() {
  router.push("/inventory/mappings");
}

function inventoryAlertLabel(row) {
  const purchased = Number(row.incoming_stock || 0) > 0;
  if (row.alert_type === "out_of_stock") return purchased ? "断货已采购" : "断货未采购";
  if (row.alert_type === "low_stock") return purchased ? "缺货已采购" : "缺货未采购";
  return "库存健康";
}

function inventoryAlertGap(row) {
  return Math.max(0, Number(row.alert_quantity || 0) - Number(row.available_stock || 0));
}

function inventoryAlertTagType(row) {
  if (row.alert_type === "out_of_stock") return "danger";
  if (row.alert_type === "low_stock") return "warning";
  if (row.alert_type === "healthy") return "success";
  return "success";
}

function linkedShops(row) {
  return Array.isArray(row.shops) ? row.shops : [];
}

function linkedSkus(row) {
  return Array.isArray(row.skus) ? row.skus : [];
}

function linkedShopCount(row) {
  return Number(row.shop_count ?? linkedShops(row).length);
}

function linkedSkuCount(row) {
  return Number(row.sku_count ?? linkedSkus(row).length);
}

function openInventoryDetails(row, initialAction = "") {
  selectedInventory.value = row;
  ledgerInitialAction.value = initialAction;
  ledgerVisible.value = true;
}

function startLeadEdit(row) {
  if (!canEditInventory.value || leadSavingProductId.value) return;
  editingLeadProductId.value = Number(row.product_id);
  editingLeadRow.value = row;
  leadForm.production_lead_days = Number(row.production_lead_days ?? 7);
  leadForm.warehouse_logistics_days = Number(row.warehouse_logistics_days ?? 2);
  leadForm.expected_production_lead_days = leadForm.production_lead_days;
  leadForm.expected_warehouse_logistics_days = leadForm.warehouse_logistics_days;
}

function cancelLeadEdit() {
  editingLeadProductId.value = 0;
  editingLeadRow.value = null;
}

async function saveLeadTimes(row) {
  if (!canEditInventory.value || leadSavingProductId.value) return;
  if (!productionLeadOptions.includes(leadForm.production_lead_days) || !logisticsDayOptions.includes(leadForm.warehouse_logistics_days)) {
    ElMessage.warning("请选择有效的生产周期和物流到仓时长");
    return;
  }
  leadSavingProductId.value = Number(row.product_id);
  try {
    await apiClient.post("/api/inventory/products/lead-times", {
      product_id: row.product_id,
      production_lead_days: leadForm.production_lead_days,
      warehouse_logistics_days: leadForm.warehouse_logistics_days,
      expected_production_lead_days: leadForm.expected_production_lead_days,
      expected_warehouse_logistics_days: leadForm.expected_warehouse_logistics_days
    });
    cancelLeadEdit();
    ElMessage.success("时长已更新，预警线已重新计算");
    await loadPageData({ refresh: true });
  } catch (error) {
    ElMessage.error(error.status === 409 ? "时长已被其他人更新，请重新选择后保存" : error.message || "更新时长失败");
    if (error.status === 409) {
      cancelLeadEdit();
      await loadPageData({ refresh: true });
    }
  } finally {
    leadSavingProductId.value = 0;
  }
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

function changeAlertType(value) {
  cancelLeadEdit();
  state.filters.alertType = value;
  state.filters.page = 1;
  syncRouteQuery("manual");
  loadPageData();
}

function changeInventorySort() {
  state.filters.page = 1;
  syncRouteQuery("manual");
  loadPageData();
}

function changeFbpFocus() {
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

async function loadPageData({ refresh = false } = {}) {
  const requestToken = listRequestGate.next();
  loading.value = true;
  try {
    const params = new URLSearchParams({
      mode: inventoryView.value ? "inventory-alerts" : "fbp-operations",
      paged: "1",
      page: String(state.filters.page),
      pageSize: String(state.filters.pageSize),
      alertType: inventoryView.value ? String(state.filters.alertType || "all") : "all"
    });
    if (inventoryView.value) params.set("sortBy", state.filters.sortBy);
    else params.set("fbpFocus", state.filters.fbpFocus);
    if (refresh) params.set("refresh", "1");
    if (!inventoryView.value) {
      params.set("shopId", String(state.filters.shopId || "all"));
    }
    const query = String(state.filters.query || "").trim();
    if (query) params.set("query", query);
    const requests = [apiClient.get(`/api/stock-alerts?${params.toString()}`), inventoryView.value ? Promise.resolve(state.shops) : loadShopDictionary()];
    const [payload, shops] = await Promise.all(requests);
    if (!listRequestGate.isLatest(requestToken)) return;
    state.rows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (selectedInventory.value) {
      selectedInventory.value = state.rows.find((row) => Number(row.product_id) === Number(selectedInventory.value.product_id)) || selectedInventory.value;
    }
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

watch(() => route.query, () => {
  const previousView = state.filters.view;
  applyRouteState();
  if (previousView !== state.filters.view) {
    cancelLeadEdit();
    state.filters.page = 1;
    syncRouteQuery("manual");
    loadPageData();
  }
}, { deep: true });
watch(() => [state.filters.shopId, state.filters.dateFrom, state.filters.dateTo, state.filters.page, state.filters.pageSize], syncRouteQuery);

onMounted(async () => {
  applyRouteState();
  await loadPageData();
});
</script>

<template>
  <div class="inventory-page-shell inventory-card">
    <InventoryPageToolbar
      class="alert-toolbar"
      :filters="state.filters"
      :shops="state.shops"
      :show-shop="!inventoryView"
      :show-date-range="false"
      :query-label="inventoryView ? '' : 'FBP SKU 搜索'"
      :query-placeholder="inventoryView ? '库存编号 / 名称 / 店铺 / 线上 SKU' : '库存编号 / SKU / Offer / 名称关键词'"
      @search="handleSearch"
      @reset="handleReset"
    >
      <div v-if="inventoryView" class="alert-inventory-filters">
        <div class="alert-status-filters">
          <el-button
            v-for="option in inventoryAlertFilters"
            :key="option.value"
            size="small"
            :type="state.filters.alertType === option.value ? 'primary' : 'default'"
            @click="changeAlertType(option.value)"
          >{{ option.label }}<span v-if="option.value !== 'all'" class="alert-filter-count">{{ state.meta[option.value] ?? 0 }}</span></el-button>
        </div>
        <el-select v-model="state.filters.sortBy" class="alert-sort-select" aria-label="消耗量排序" size="small" @change="changeInventorySort">
          <el-option v-for="option in inventorySortOptions" :key="option.value" :label="`${option.label} ↓`" :value="option.value" />
        </el-select>
      </div>
      <el-select v-else v-model="state.filters.fbpFocus" class="alert-sort-select" aria-label="FBP SKU 备货筛选" size="small" @change="changeFbpFocus">
        <el-option v-for="option in fbpFocusOptions" :key="option.value" :label="option.label" :value="option.value" />
      </el-select>
    </InventoryPageToolbar>

    <div class="inventory-table-wrap erp-responsive-table" role="region" aria-label="库存预警表格" tabindex="0">
      <el-table v-if="inventoryView" v-loading="loading" :data="pagedRows" stripe border class="erp-data-table inventory-alert-table">
        <el-table-column label="主图" width="90" fixed="left">
          <template #default="{ row }"><ProductImagePreview :src="row.image_url" :preview-list="row.image_url ? [row.image_url] : []" size="portrait" fit="cover" /></template>
        </el-table-column>
        <el-table-column label="库存信息" width="265">
          <template #default="{ row }">
            <div class="cell-stack alert-identity">
              <ProductTitleLink :title="row.product_name || '-'" :lines="2" />
              <span class="inventory-id-display">库存 ID：{{ row.inventory_number || row.inventory_id || row.product_id }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="消耗量" width="250">
          <template #default="{ row }">
            <div class="alert-consumption">
              <div><span>近 7 天</span><strong class="alert-metric-value">{{ integer(row.recent_7d_qty) }} 件</strong></div>
              <div><span>近 15 天</span><strong class="alert-metric-value">{{ integer(row.recent_15d_qty) }} 件</strong></div>
              <div><span>近 30 天</span><strong class="alert-metric-value">{{ integer(row.recent_30d_qty) }} 件</strong></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="库存分析" min-width="460">
          <template #default="{ row }">
            <div class="alert-analysis">
              <div class="alert-analysis-status">
                <el-tag :type="inventoryAlertTagType(row)" size="small">{{ inventoryAlertLabel(row) }}</el-tag>
                <span :class="{ 'danger-text': row.alert_type === 'out_of_stock' && !Number(row.incoming_stock) }">预警缺口 <strong class="alert-metric-value">{{ integer(inventoryAlertGap(row)) }} 件</strong></span>
              </div>
              <div class="alert-analysis-grid">
                <div><span>剩余可用</span><strong class="alert-metric-value">{{ integer(row.available_stock) }} 件</strong></div>
                <div><span>本地实物</span><strong class="alert-metric-value">{{ integer(row.physical_stock) }} 件</strong></div>
                <div><span>订单待履约占用</span><strong class="alert-metric-value">{{ integer(row.open_order_demand_qty) }} 件</strong></div>
                <div><span>预警线</span><strong class="alert-metric-value">{{ integer(row.alert_quantity) }} 件</strong></div>
                <div><span>采购在途</span><strong class="alert-metric-value">{{ integer(row.incoming_stock) }} 件</strong></div>
                <div><span>仍需采购</span><strong class="alert-metric-value">{{ integer(row.suggested_purchase_qty) }} 件</strong></div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="关联店铺" width="112" align="center">
          <template #default="{ row }">
            <span class="alert-relation-count"><strong class="alert-metric-value">{{ linkedShopCount(row) }}</strong> 家</span>
          </template>
        </el-table-column>
        <el-table-column label="关联 SKU" width="112" align="center">
          <template #default="{ row }"><span class="alert-relation-count"><strong class="alert-metric-value">{{ linkedSkuCount(row) }}</strong> 个</span></template>
        </el-table-column>
        <el-table-column label="库存周转时间" width="165">
          <template #default="{ row }"><div class="cell-stack alert-lead-time"><div class="alert-metric-row"><span>生产周期</span><strong class="alert-metric-value">{{ row.production_lead_days ?? 7 }} 天</strong></div><div class="alert-metric-row"><span>物流到仓</span><strong class="alert-metric-value">{{ row.warehouse_logistics_days ?? 2 }} 天</strong></div><el-button v-if="canEditInventory" size="small" plain @click="startLeadEdit(row)">修改时长</el-button></div></template>
        </el-table-column>
        <el-table-column label="操作" width="158" fixed="right">
          <template #default="{ row }">
            <div class="cell-stack alert-row-actions">
              <el-button v-if="canEditInventory" size="small" type="primary" plain @click="openInventoryDetails(row, 'stocktake')">更新本地库存</el-button>
              <el-button v-if="canSubmitRequest" size="small" type="warning" plain :disabled="row.suggested_purchase_qty <= 0" @click="openWarehouseRequest(row)">提交采购需求</el-button>
              <el-button size="small" @click="openInventoryDetails(row)">查看明细</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <el-table v-else v-loading="loading || syncLoading" :data="pagedRows" stripe border class="erp-data-table">
        <el-table-column label="店铺" width="110" fixed="left">
          <template #default="{ row }"><strong>{{ row.shop_name || "-" }}</strong></template>
        </el-table-column>
        <el-table-column label="FBP SKU" min-width="260">
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
        <el-table-column label="关联本地库存" width="205">
          <template #default="{ row }">
            <div class="cell-stack">
              <strong>{{ row.product_name || "未绑定库存" }}</strong>
              <span class="inventory-id-display">库存 ID：{{ row.inventory_number || row.inventory_id || "-" }}</span>
              <el-tooltip content="本地库存由关联的多个店铺 SKU 共享，不是当前 SKU 独占量" placement="top">
                <span class="muted-text">共享实物 {{ sharedStockText(row.local_physical_stock) }} · 可用 {{ sharedStockText(row.local_available_stock) }}</span>
              </el-tooltip>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="当前 SKU 库存" width="135" align="center">
          <template #default="{ row }">
            <div class="cell-stack cell-center">
              <strong :class="{ 'danger-text': Number(row.fbp_available || 0) <= 0 }">可售 {{ integer(row.fbp_available) }}</strong>
              <span class="muted-text">发仓在途 {{ integer(row.fbp_transfer_in_transit_qty) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="SKU 可撑" width="115" align="center">
          <template #default="{ row }"><strong>{{ coverageText(row) }}</strong></template>
        </el-table-column>
        <el-table-column label="本 SKU 建议备货" width="125" align="center">
          <template #default="{ row }"><strong class="alert-sku-replenishment-qty">{{ integer(suggestedQty(row)) }} 件</strong></template>
        </el-table-column>
        <el-table-column label="历史订单件数" width="155" align="center">
          <template #default="{ row }">
            <div class="cell-stack cell-center">
              <strong>库存合计 {{ integer(row.product_all_time_qty) }}</strong>
              <span class="muted-text">当前 SKU {{ integer(row.all_time_qty) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="动态日销" width="105" align="center">
          <template #default="{ row }">{{ dailySalesText(row) }}</template>
        </el-table-column>
        <el-table-column label="销量走势" width="170" align="center">
          <template #default="{ row }"><el-tag :type="fbpTrendTagType(row.trend_type)" size="small">{{ row.trend_text }}</el-tag></template>
        </el-table-column>
        <el-table-column label="近三周订单件数" width="220" align="center">
          <template #default="{ row }">
            <div class="alert-fbp-weeks">
              <div><span>再前 7 天</span><strong>{{ integer(row.older_7d_qty) }}</strong></div>
              <div><span>前 7 天</span><strong>{{ integer(row.prev_7d_qty) }}</strong></div>
              <div><span>近 7 天</span><strong>{{ integer(row.recent_7d_qty) }}</strong></div>
            </div>
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
        <el-table-column label="运营建议" min-width="260">
          <template #default="{ row }">
            <span class="muted-text">{{ fbpOperationSuggestion(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="最后同步" width="170">
          <template #default="{ row }">{{ dateText(row.last_synced_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-space wrap>
              <el-button
                v-if="!row.replenishment_ignored && suggestedQty(row) > 0"
                size="small"
                type="warning"
                plain
                :loading="rowActionLoading === `order-${row.shop_id}-${row.ozon_sku}`"
                @click="createReplenishmentOrder(row)"
              >创建备货单</el-button>
              <el-button
                v-if="!row.replenishment_ignored"
                class="erp-btn-link"
                link
                type="warning"
                :loading="rowActionLoading === `ignore-${row.shop_id}-${row.ozon_sku}`"
                @click="ignoreReplenishment(row)"
              >忽略</el-button>
              <el-tag v-else size="small" type="info">已忽略备货</el-tag>
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
    <el-dialog :model-value="!!editingLeadProductId" title="修改库存周转时间" width="420px" append-to-body :close-on-click-modal="false" @update:model-value="value => { if (!value) cancelLeadEdit(); }">
      <template v-if="editingLeadRow">
        <p class="alert-lead-dialog-product">库存 ID：{{ editingLeadRow.inventory_number || editingLeadRow.inventory_id || editingLeadRow.product_id }} · {{ editingLeadRow.product_name }}</p>
        <el-form label-width="96px">
          <el-form-item label="生产周期"><el-select v-model="leadForm.production_lead_days" aria-label="生产周期"><el-option v-for="days in productionLeadOptions" :key="days" :label="`${days} 天`" :value="days" /></el-select></el-form-item>
          <el-form-item label="物流到仓"><el-select v-model="leadForm.warehouse_logistics_days" aria-label="物流到仓时长"><el-option v-for="days in logisticsDayOptions" :key="days" :label="`${days} 天`" :value="days" /></el-select></el-form-item>
        </el-form>
        <p class="alert-lead-dialog-note">预警线按近 7 天日均消耗 ×（生产周期 + 物流到仓时长）计算。</p>
      </template>
      <template #footer><el-button :disabled="!!leadSavingProductId" @click="cancelLeadEdit">取消</el-button><el-button type="primary" :loading="!!leadSavingProductId" @click="saveLeadTimes(editingLeadRow)">保存时长</el-button></template>
    </el-dialog>
    <WarehouseProcurementRequestDialog v-model="requestDialogVisible" :products="requestProducts" @submitted="loadPageData({ refresh: true })" />
    <ProcurementLedgerDialog v-if="ledgerVisible && selectedInventory" v-model="ledgerVisible" :product-id="Number(selectedInventory.product_id)" :initial-action="ledgerInitialAction" inventory-mode :stocktake-enabled="canEditInventory" @saved="loadPageData({ refresh: true })">
      <template #inventory-relations>
        <div class="alert-detail-heading">
          <div class="product-cell">
            <ProductImagePreview :src="selectedInventory.image_url" :preview-list="selectedInventory.image_url ? [selectedInventory.image_url] : []" size="portrait" fit="cover" />
            <div class="cell-stack">
              <strong>{{ selectedInventory.product_name || '-' }}</strong>
              <span class="inventory-id-display">库存 ID：{{ selectedInventory.inventory_number || selectedInventory.inventory_id || selectedInventory.product_id }}</span>
              <span class="muted-text">{{ linkedShopCount(selectedInventory) }} 个店铺 · {{ linkedSkuCount(selectedInventory) }} 个线上 SKU</span>
              <span class="muted-text">消耗：近 7 天 {{ integer(selectedInventory.recent_7d_qty) }} · 近 15 天 {{ integer(selectedInventory.recent_15d_qty) }} · 近 30 天 {{ integer(selectedInventory.recent_30d_qty) }} 件</span>
            </div>
          </div>
          <span class="muted-text">多个店铺及线上 SKU 的订单消耗汇总到同一个库存。以下是该库存的完整关联关系。</span>
        </div>
        <div class="inventory-table-wrap erp-responsive-table" role="region" aria-label="库存关联 SKU 明细" tabindex="0">
          <el-table :data="linkedSkus(selectedInventory)" stripe border class="erp-data-table" max-height="320" empty-text="暂无关联线上 SKU">
            <el-table-column label="店铺" prop="shop_name" min-width="130">
              <template #default="{ row }">{{ row.shop_name || row.shop_id || '-' }}</template>
            </el-table-column>
            <el-table-column label="线上 SKU / Offer" min-width="230">
              <template #default="{ row }"><div class="cell-stack"><strong class="alert-sku-value">{{ row.ozon_sku || '-' }}</strong><span class="muted-text alert-sku-value">Offer {{ row.offer_id || '-' }}</span></div></template>
            </el-table-column>
            <el-table-column label="近 7 天" width="90" align="right">
              <template #default="{ row }">{{ integer(row.recent_7d_qty) }}</template>
            </el-table-column>
            <el-table-column label="近 15 天" width="95" align="right">
              <template #default="{ row }">{{ integer(row.recent_15d_qty) }}</template>
            </el-table-column>
            <el-table-column label="近 30 天" width="95" align="right">
              <template #default="{ row }"><strong>{{ integer(row.recent_30d_qty) }}</strong></template>
            </el-table-column>
          </el-table>
        </div>
      </template>
    </ProcurementLedgerDialog>
  </div>
</template>

<style scoped>
.inventory-page-shell.inventory-card { gap: 8px; }
.alert-toolbar { position: static; margin: 0; padding: 8px 12px; border-radius: 10px; }
.alert-toolbar :deep(.erp-filter-bar) { justify-content: space-between; gap: 12px; }
.alert-toolbar :deep(.inventory-toolbar-form) { flex-wrap: nowrap; gap: 8px; }
.alert-toolbar :deep(.el-form-item) { margin: 0; }
.alert-toolbar :deep(.el-form-item__label:empty) { display: none; }
.alert-toolbar :deep(.inventory-toolbar-form .el-input) { width: 260px !important; }
.alert-inventory-filters { display: flex; align-items: center; gap: 10px; min-width: 0; }
.alert-status-filters { display: flex; align-items: center; flex-wrap: nowrap; gap: 5px; }
.alert-status-filters .el-button + .el-button { margin-left: 0; }
.alert-filter-count { margin-left: 5px; opacity: .8; }
.alert-toolbar :deep(.alert-sort-select), .alert-toolbar :deep(.alert-sort-select .el-input) { width: 170px !important; }
.inventory-alert-table :deep(.el-table__row) { height: 112px; }
.alert-identity .inventory-id-display { font-size: 17px; font-weight: 700; color: var(--el-text-color-primary); }
.alert-metric-value { font-size: 15px; font-weight: 650; line-height: 1.3; color: var(--el-text-color-primary); }
.alert-metric-row { display: flex; align-items: baseline; gap: 5px; line-height: 1.3; white-space: nowrap; }
.alert-metric-row > span { font-size: 12px; color: var(--el-text-color-secondary); }
.alert-consumption { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: center; min-height: 84px; gap: 6px; }
.alert-consumption > div, .alert-analysis-grid > div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.alert-consumption span, .alert-analysis-grid span { font-size: 12px; line-height: 1.25; color: var(--el-text-color-secondary); white-space: nowrap; }
.alert-consumption .alert-metric-value, .alert-analysis-grid .alert-metric-value { white-space: nowrap; }
.alert-analysis { display: grid; gap: 9px; min-width: 0; }
.alert-analysis-status { display: flex; align-items: center; gap: 12px; min-height: 22px; font-size: 12px; color: var(--el-text-color-secondary); }
.alert-analysis-status :deep(.el-tag) { font-size: 13px; font-weight: 650; }
.alert-analysis-status .danger-text, .alert-analysis-status .danger-text .alert-metric-value { color: var(--el-color-danger); }
.alert-analysis-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); column-gap: 14px; row-gap: 7px; }
.alert-fbp-weeks { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
.alert-fbp-weeks > div { display: flex; flex-direction: column; gap: 4px; }
.alert-fbp-weeks span { font-size: 12px; color: var(--el-text-color-secondary); }
.alert-fbp-weeks strong { font-size: 15px; font-weight: 650; }
.alert-sku-replenishment-qty { font-size: 15px; font-weight: 650; color: var(--el-color-warning); }
.alert-lead-time { gap: 5px; }
.alert-relation-count { white-space: nowrap; color: var(--el-text-color-secondary); }
.alert-lead-time :deep(.el-button) { align-self: flex-start; margin: 0; }
.alert-row-actions { align-items: stretch; gap: 4px; }
.alert-row-actions :deep(.el-button) { margin: 0; }
.alert-lead-dialog-product { margin: 0 0 16px; color: var(--el-text-color-regular); }
.alert-lead-dialog-note { margin: 0; font-size: 12px; color: var(--el-text-color-secondary); }
.alert-detail-heading { display: grid; gap: 12px; margin-bottom: 18px; }
.alert-sku-value { overflow-wrap: anywhere; }
@media (max-width: 1300px) {
  .alert-toolbar :deep(.erp-filter-bar), .alert-toolbar :deep(.inventory-toolbar-form), .alert-inventory-filters, .alert-status-filters { flex-wrap: wrap; }
}
@media (max-width: 760px) {
  .alert-toolbar :deep(.inventory-toolbar-form) { display: flex; flex-direction: column; align-items: stretch; }
  .alert-toolbar :deep(.inventory-toolbar-form .el-input) { width: 100% !important; }
  .alert-inventory-filters { width: 100%; }
  .alert-toolbar :deep(.alert-sort-select), .alert-toolbar :deep(.alert-sort-select .el-input) { width: 100% !important; }
  .alert-status-filters { width: 100%; }
  .alert-status-filters .el-button { flex: 1 1 auto; }
}
</style>
