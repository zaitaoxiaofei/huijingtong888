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
const editingLeadProductId = ref(0);
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
const canEditInventory = computed(() => hasPermission(authStore.user, "inventory.write"));
const canSubmitRequest = computed(() => hasPermission(authStore.user, "procurement.request.submit"));
const inventoryAlertFilters = [
  { value: "all", label: "全部" },
  { value: "out_of_stock", label: "断货" },
  { value: "low_stock", label: "缺货" },
  { value: "in_transit", label: "采购在途" },
  { value: "healthy", label: "库存健康" }
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
    if (state.filters.alertType === "lead_time_missing") state.filters.alertType = "all";
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
  if (row.alert_type === "out_of_stock") return "断货";
  if (row.alert_type === "low_stock") return "缺货";
  return "库存健康";
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

function openInventoryDetails(row) {
  selectedInventory.value = row;
  ledgerVisible.value = true;
}

function startLeadEdit(row) {
  if (!canEditInventory.value || leadSavingProductId.value) return;
  editingLeadProductId.value = Number(row.product_id);
  leadForm.production_lead_days = Number(row.production_lead_days ?? 7);
  leadForm.warehouse_logistics_days = Number(row.warehouse_logistics_days ?? 2);
  leadForm.expected_production_lead_days = leadForm.production_lead_days;
  leadForm.expected_warehouse_logistics_days = leadForm.warehouse_logistics_days;
}

function cancelLeadEdit() {
  editingLeadProductId.value = 0;
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
    editingLeadProductId.value = 0;
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

function changeView(view) {
  cancelLeadEdit();
  state.filters.view = view;
  state.filters.alertType = "all";
  state.filters.page = 1;
  syncRouteQuery("manual");
  loadPageData();
}

function changeAlertType(value) {
  cancelLeadEdit();
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

async function loadPageData({ refresh = false } = {}) {
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
    if (refresh) params.set("refresh", "1");
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
        <el-button size="small" :type="inventoryView ? 'primary' : 'default'" @click="changeView('inventory')">库存视角</el-button>
        <el-button size="small" :type="!inventoryView ? 'primary' : 'default'" @click="changeView('sku')">FBP SKU 视角</el-button>
      </div>
    </div>
    <InventoryPageToolbar
      class="alert-toolbar"
      :filters="state.filters"
      :shops="state.shops"
      :show-shop="!inventoryView"
      :show-date-range="!inventoryView"
      :query-label="inventoryView ? '' : 'FBP预警搜索'"
      :query-placeholder="inventoryView ? '库存编号 / 名称 / 店铺 / 线上 SKU' : '完整库存编号 / SKU / Offer / 名称关键词'"
      @search="handleSearch"
      @reset="handleReset"
    >
      <div v-if="inventoryView" class="alert-status-filters">
        <el-button
          v-for="option in inventoryAlertFilters"
          :key="option.value"
          size="small"
          :type="state.filters.alertType === option.value ? 'primary' : 'default'"
          @click="changeAlertType(option.value)"
        >{{ option.label }}<span v-if="option.value !== 'all'" class="alert-filter-count">{{ state.meta[option.value] ?? 0 }}</span></el-button>
      </div>
    </InventoryPageToolbar>

    <div class="inventory-table-wrap erp-responsive-table" role="region" aria-label="库存预警表格" tabindex="0">
      <el-table v-if="inventoryView" v-loading="loading" :data="pagedRows" stripe border class="erp-data-table inventory-alert-table">
        <el-table-column label="主图" width="90" fixed="left">
          <template #default="{ row }"><ProductImagePreview :src="row.image_url" :preview-list="row.image_url ? [row.image_url] : []" size="portrait" fit="cover" /></template>
        </el-table-column>
        <el-table-column label="库存信息" min-width="285">
          <template #default="{ row }">
            <div class="cell-stack">
              <ProductTitleLink :title="row.product_name || '-'" :lines="2" />
              <span class="inventory-id-display">库存 ID：{{ row.inventory_number || row.inventory_id || row.product_id }}</span>
              <span>剩余可用 <strong class="alert-available-value" :class="{ 'danger-text': row.available_stock <= 0 }">{{ integer(row.available_stock) }}</strong> · 本地实物 <strong>{{ integer(row.physical_stock) }}</strong></span>
              <span class="muted-text">采购在途 {{ integer(row.incoming_stock) }} · 待履约占用 {{ integer(row.open_order_demand_qty) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="预警线" width="120" align="center">
          <template #default="{ row }"><div class="cell-stack cell-center"><strong class="alert-threshold-value">{{ integer(row.alert_quantity) }} 件</strong><span class="muted-text">日均 {{ Number(row.daily_sales_7d || 0).toFixed(2) }}</span><el-tag :type="inventoryAlertTagType(row)" size="small">{{ inventoryAlertLabel(row) }}</el-tag></div></template>
        </el-table-column>
        <el-table-column label="建议补货" width="125" align="center">
          <template #default="{ row }">
            <div class="cell-stack cell-center">
              <strong>{{ integer(row.suggested_purchase_qty) }} 件</strong>
              <span class="muted-text">已扣采购在途</span>
              <el-tag v-if="row.in_transit" type="primary" size="small">采购在途</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="关联店铺 / SKU" min-width="200">
          <template #default="{ row }">
            <div class="cell-stack alert-relations">
              <span><strong>{{ linkedShopCount(row) }}</strong> 个店铺 · <strong>{{ linkedSkuCount(row) }}</strong> 个线上 SKU</span>
              <span v-if="linkedShops(row).length" class="alert-relation-preview muted-text">
                店铺：{{ linkedShops(row).slice(0, 2).map((shop) => shop.shop_name || shop.shop_id).join('、') }}{{ linkedShops(row).length > 2 ? ` 等 ${linkedShops(row).length} 家` : '' }}
              </span>
              <span v-if="linkedSkus(row).length" class="alert-relation-preview muted-text">
                SKU：{{ linkedSkus(row).slice(0, 2).map((sku) => sku.ozon_sku || sku.offer_id || '-').join('、') }}{{ linkedSkus(row).length > 2 ? ` 等 ${linkedSkus(row).length} 个` : '' }}
              </span>
              <span v-if="!linkedSkuCount(row)" class="muted-text">暂无关联线上 SKU</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="生产周期" width="110" align="center">
          <template #default="{ row }"><div class="cell-stack cell-center"><el-select v-if="editingLeadProductId === Number(row.product_id)" v-model="leadForm.production_lead_days" size="small" aria-label="生产周期"><el-option v-for="days in productionLeadOptions" :key="days" :label="`${days} 天`" :value="days" /></el-select><template v-else><strong>{{ row.production_lead_days ?? 7 }} 天</strong><el-button v-if="canEditInventory" link type="primary" size="small" @click="startLeadEdit(row)">编辑</el-button></template></div></template>
        </el-table-column>
        <el-table-column label="物流到仓" width="120" align="center">
          <template #default="{ row }"><div class="cell-stack cell-center"><el-select v-if="editingLeadProductId === Number(row.product_id)" v-model="leadForm.warehouse_logistics_days" size="small" aria-label="物流到仓时长"><el-option v-for="days in logisticsDayOptions" :key="days" :label="`${days} 天`" :value="days" /></el-select><template v-else><strong>{{ row.warehouse_logistics_days ?? 2 }} 天</strong><el-button v-if="canEditInventory" link type="primary" size="small" @click="startLeadEdit(row)">编辑</el-button></template></div></template>
        </el-table-column>
        <el-table-column label="销量" width="150" align="center">
          <template #default="{ row }"><div class="cell-stack cell-center"><strong>近 30 天 {{ integer(row.recent_30d_qty) }}</strong><span class="muted-text">近 7 天 {{ integer(row.recent_7d_qty) }} · 15 天 {{ integer(row.recent_15d_qty) }}</span></div></template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <div class="cell-stack alert-row-actions">
              <template v-if="editingLeadProductId === Number(row.product_id)"><el-button link type="primary" :loading="leadSavingProductId === Number(row.product_id)" @click="saveLeadTimes(row)">保存时长</el-button><el-button link :disabled="!!leadSavingProductId" @click="cancelLeadEdit">取消</el-button></template>
              <template v-else><el-button link type="primary" @click="openInventoryDetails(row)">查看明细</el-button><el-button v-if="canSubmitRequest" link type="primary" :disabled="row.suggested_purchase_qty <= 0" @click="openWarehouseRequest(row)">提交采购需求</el-button></template>
            </div>
          </template>
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
    <WarehouseProcurementRequestDialog v-model="requestDialogVisible" :products="requestProducts" @submitted="loadPageData({ refresh: true })" />
    <ProcurementLedgerDialog v-if="ledgerVisible && selectedInventory" v-model="ledgerVisible" :product-id="Number(selectedInventory.product_id)" inventory-mode :stocktake-enabled="canEditInventory" @saved="loadPageData({ refresh: true })">
      <template #inventory-relations>
        <div class="alert-detail-heading">
          <div class="product-cell">
            <ProductImagePreview :src="selectedInventory.image_url" :preview-list="selectedInventory.image_url ? [selectedInventory.image_url] : []" size="portrait" fit="cover" />
            <div class="cell-stack">
              <strong>{{ selectedInventory.product_name || '-' }}</strong>
              <span class="inventory-id-display">库存 ID：{{ selectedInventory.inventory_number || selectedInventory.inventory_id || selectedInventory.product_id }}</span>
              <span class="muted-text">{{ linkedShopCount(selectedInventory) }} 个店铺 · {{ linkedSkuCount(selectedInventory) }} 个线上 SKU · 近 30 天合计 {{ integer(selectedInventory.recent_30d_qty) }} 件</span>
            </div>
          </div>
          <span class="muted-text">多个店铺及线上 SKU 的销量汇总到同一个库存。以下是该库存的完整关联关系。</span>
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
.alert-view-switch { display: flex; justify-content: flex-end; align-items: center; padding: 2px 10px 0; }
.alert-view-buttons { display: flex; gap: 8px; }
.alert-view-buttons .el-button + .el-button { margin-left: 0; }
.alert-toolbar { position: static; margin: 0; padding: 9px 12px; border-radius: 10px; }
.alert-toolbar :deep(.erp-filter-bar) { justify-content: space-between; gap: 12px; }
.alert-toolbar :deep(.inventory-toolbar-form) { flex-wrap: nowrap; gap: 8px; }
.alert-toolbar :deep(.el-form-item) { margin: 0; }
.alert-toolbar :deep(.el-form-item__label:empty) { display: none; }
.alert-status-filters { display: flex; align-items: center; flex-wrap: nowrap; gap: 5px; }
.alert-status-filters .el-button + .el-button { margin-left: 0; }
.alert-filter-count { margin-left: 5px; opacity: .8; }
.alert-available-value { font-size: 18px; font-weight: 800; color: var(--el-color-primary); }
.alert-threshold-value { font-size: 17px; }
.inventory-alert-table :deep(.el-table__row) { height: 92px; }
.alert-relations { min-width: 0; }
.alert-relation-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alert-row-actions { align-items: flex-start; }
.alert-row-actions :deep(.el-button) { margin: 0; }
.alert-detail-heading { display: grid; gap: 12px; margin-bottom: 18px; }
.alert-sku-value { overflow-wrap: anywhere; }
@media (max-width: 1300px) {
  .alert-toolbar :deep(.erp-filter-bar), .alert-toolbar :deep(.inventory-toolbar-form), .alert-status-filters { flex-wrap: wrap; }
}
@media (max-width: 760px) {
  .alert-view-switch { justify-content: flex-start; }
  .alert-toolbar :deep(.inventory-toolbar-form) { display: flex; flex-direction: column; align-items: stretch; }
  .alert-status-filters { width: 100%; }
  .alert-status-filters .el-button { flex: 1 1 auto; }
}
</style>
