<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import { createLatestRequestGate } from "../../utils/request-gate";
import { createRouteQuerySync } from "../../utils/route-query-sync.js";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import ProductTitleLink from "../../components/ProductTitleLink.vue";
import { ozonBuyerProductLinkFromRow } from "../../utils/product-links";

const route = useRoute();
const router = useRouter();
let syncingRoute = false;
let onlineProductSyncPollTimer = 0;
const listRequestGate = createLatestRequestGate();
const warehouseCacheByShop = new Map();
let dictionaryLoaded = false;

function createAiWorkbenchId() {
  return `aiwb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const loading = ref(false);
const syncLoading = ref(false);
const openingEditId = ref(0);
const bindDialogVisible = ref(false);
const bindSubmitting = ref(false);
const stockDialogVisible = ref(false);
const stockSubmitting = ref(false);
const warehousesLoading = ref(false);
const productOptionsLoading = ref(false);

const state = reactive({
  onlineProducts: [],
  total: 0,
  statusCounts: {},
  shops: [],
  products: [],
  people: [],
  selectedIds: [],
  selectedRows: [],
  warehouses: [],
  filters: {
    shopId: "all",
    status: "all",
    name: "",
    offer: "",
    page: 1,
    pageSize: 20
  }
});

const bindForm = reactive({
  online_product_id: null,
  product_id: "",
  person_id: ""
});

const stockForm = reactive({
  shop_id: "",
  warehouse_id: "",
  stock: 888
});

const statusLabels = [
  ["all", "全部状态"],
  ["selling", "销售中"],
  ["ready", "待上架"],
  ["error", "异常"],
  ["moderation", "审核中"],
  ["hidden", "已下架"],
  ["archived", "已归档"],
  ["other", "其他"]
];

const statusOptions = computed(() => statusLabels.map(([value, label]) => ({
  value,
  label,
  count: Number(state.statusCounts?.[value] || 0)
})));

const pagedRows = computed(() => state.onlineProducts);
const stockDialogShopName = computed(() => {
  const shopId = Number(stockForm.shop_id || 0);
  return state.shops.find((shop) => Number(shop.id) === shopId)?.name || "当前店铺";
});
const stockDialogWarehouseName = computed(() => {
  const warehouseId = String(stockForm.warehouse_id || "");
  const warehouse = state.warehouses.find((item) => String(item.warehouse_id) === warehouseId);
  return warehouse ? `${warehouse.name || "Ozon 仓库"} / ${warehouse.warehouse_id}` : "未选择";
});
const stockPresetValues = [888, 500, 100, 0];

function money(value) {
  return Number(value || 0).toFixed(2);
}

function dateText(value) {
  return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true });
}

function ozonBuyerProductLinkFor(row) {
  return ozonBuyerProductLinkFromRow(row);
}

function parseOnlineProductRaw(row) {
  const raw = row?.raw_json;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function realOzonSkuFromValue(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "0" || text.startsWith("__MISSING_SKU__:")) return "";
  return text;
}

function displayedOzonSku(row) {
  const raw = parseOnlineProductRaw(row);
  return (
    realOzonSkuFromValue(raw?.sku)
    || realOzonSkuFromValue(raw?.fbo_sku)
    || realOzonSkuFromValue(raw?.fbs_sku)
    || realOzonSkuFromValue(raw?.product_sku)
    || realOzonSkuFromValue(raw?.productSku)
    || realOzonSkuFromValue(raw?.ozon_sku)
    || realOzonSkuFromValue(row?.ozon_sku)
    || ""
  );
}

function onlineStatusKey(row) {
  const status = String(row.status || "").toLowerCase();
  const visibility = String(row.visibility || "").toLowerCase();
  if (Number(row.archived || 0) || status.includes("archive")) return "archived";
  if (status.includes("error") || status.includes("fail") || visibility.includes("failed") || visibility.includes("banned")) return "error";
  if (status.includes("moder") || status.includes("edit") || status.includes("validation") || visibility.includes("pending")) return "moderation";
  if (status.includes("ready") || status.includes("created") || visibility.includes("ready_to_supply") || visibility.includes("empty_stock")) return "ready";
  if (visibility.includes("hidden") || visibility.includes("blocked") || visibility.includes("removed_from_sale") || status.includes("hidden") || status.includes("offline")) return "hidden";
  if (status.includes("online") || status.includes("active") || status.includes("sell") || visibility.includes("in_sale") || visibility.includes("visible") || visibility.includes("moderated")) return "selling";
  return "other";
}

function onlineStatusType(row) {
  const key = onlineStatusKey(row);
  if (key === "selling") return "success";
  if (key === "ready") return "primary";
  if (key === "error") return "danger";
  if (key === "moderation") return "warning";
  if (key === "hidden" || key === "archived") return "info";
  return "";
}

function onlineStatusLabel(row) {
  return statusOptions.value.find((item) => item.value === onlineStatusKey(row))?.label || "其他";
}

function asPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function onlineProductsQueryString() {
  const params = new URLSearchParams({
    paged: "1",
    page: String(state.filters.page),
    pageSize: String(state.filters.pageSize),
    shopId: String(state.filters.shopId || "all"),
    status: String(state.filters.status || "all")
  });
  const name = String(state.filters.name || "").trim();
  const offer = String(state.filters.offer || "").trim();
  if (name) params.set("name", name);
  if (offer) params.set("offer", offer);
  return params.toString();
}

async function loadPageData() {
  const requestToken = listRequestGate.next();
  loading.value = true;
  try {
    const requests = [apiClient.get(`/api/online-products?${onlineProductsQueryString()}`)];
    if (!dictionaryLoaded) requests.push(apiClient.get("/api/shops"), apiClient.get("/api/people"));
    const [onlineProducts, shops, people] = await Promise.all(requests);
    if (!listRequestGate.isLatest(requestToken)) return;
    state.onlineProducts = Array.isArray(onlineProducts?.rows) ? onlineProducts.rows : [];
    state.total = Number(onlineProducts?.total || 0);
    state.statusCounts = onlineProducts?.statusCounts || {};
    if (!dictionaryLoaded) {
      state.shops = Array.isArray(shops) ? shops : [];
      state.people = Array.isArray(people) ? people.filter((item) => Number(item.active) !== 0) : [];
      dictionaryLoaded = true;
    }
  } catch (error) {
    if (!listRequestGate.isLatest(requestToken)) return;
    ElMessage.error(error.message || "在线商品加载失败");
  } finally {
    if (listRequestGate.isLatest(requestToken)) loading.value = false;
  }
}

function handleSearch() {
  state.filters.page = 1;
  syncRouteQuery("manual");
  loadPageData();
}

function handleReset() {
  state.filters.shopId = "all";
  state.filters.status = "all";
  state.filters.name = "";
  state.filters.offer = "";
  state.filters.page = 1;
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

function setStatus(value) {
  state.filters.status = value;
  state.filters.page = 1;
  loadPageData();
}

function selectionChanged(rows) {
  state.selectedIds = rows.map((row) => Number(row.id));
  state.selectedRows = rows;
}

function selectedShopIdForStock() {
  if (state.filters.shopId !== "all") return Number(state.filters.shopId);
  const shopIds = [...new Set(state.selectedRows.map((row) => Number(row.shop_id || 0)).filter(Boolean))];
  return shopIds.length === 1 ? shopIds[0] : 0;
}

async function loadWarehousesForStock(shopId, force = false) {
  const normalizedShopId = String(shopId || "");
  if (!force && warehouseCacheByShop.has(normalizedShopId)) {
    state.warehouses = warehouseCacheByShop.get(normalizedShopId);
    stockForm.warehouse_id = state.warehouses[0]?.warehouse_id ? String(state.warehouses[0].warehouse_id) : "";
    return;
  }
  warehousesLoading.value = true;
  try {
    const result = await apiClient.get(`/api/online-products/warehouses?shop_id=${encodeURIComponent(shopId)}`);
    state.warehouses = Array.isArray(result?.warehouses) ? result.warehouses : [];
    warehouseCacheByShop.set(normalizedShopId, state.warehouses);
    stockForm.warehouse_id = state.warehouses[0]?.warehouse_id ? String(state.warehouses[0].warehouse_id) : "";
  } catch (error) {
    state.warehouses = [];
    stockForm.warehouse_id = "";
    ElMessage.error(error.message || "Ozon 仓库加载失败");
  } finally {
    warehousesLoading.value = false;
  }
}

function applyStockPreset(value) {
  stockForm.stock = value;
}

async function openBatchStockDialog() {
  if (!state.selectedIds.length) {
    ElMessage.warning("请选择需要更新库存的在线商品");
    return;
  }
  const shopId = selectedShopIdForStock();
  if (!shopId) {
    ElMessage.warning("批量更新库存需要选择同一个店铺的商品");
    return;
  }
  stockForm.shop_id = String(shopId);
  stockForm.stock = 888;
  state.warehouses = [];
  stockForm.warehouse_id = "";
  stockDialogVisible.value = true;
  await loadWarehousesForStock(shopId);
}

async function submitBatchStock() {
  if (!stockForm.warehouse_id) {
    ElMessage.warning("请选择 Ozon 仓库");
    return;
  }
  const stock = Math.max(0, Math.round(Number(stockForm.stock || 0)));
  stockSubmitting.value = true;
  try {
    const result = await apiClient.post("/api/online-products/batch-stock", {
      online_product_ids: state.selectedIds,
      shop_id: Number(stockForm.shop_id),
      warehouse_id: stockForm.warehouse_id,
      stock
    });
    ElMessage.success(`已更新 ${result?.target_count || 0} 个商品库存为 ${stock}`);
    stockDialogVisible.value = false;
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "批量更新库存失败");
  } finally {
    stockSubmitting.value = false;
  }
}

async function ensureProductOptions(row = null) {
  if (state.products.length) return;
  productOptionsLoading.value = true;
  try {
    const params = new URLSearchParams({ paged: "1", page: "1", pageSize: "100" });
    const query = row?.product_name || row?.name || row?.offer_id || "";
    if (query) params.set("query", query);
    const result = await apiClient.get(`/api/products?${params.toString()}`);
    state.products = Array.isArray(result?.rows) ? result.rows : [];
  } catch (error) {
    ElMessage.error(error.message || "加载库存商品候选失败");
  } finally {
    productOptionsLoading.value = false;
  }
}

async function openBindDialog(row) {
  bindForm.online_product_id = Number(row.id);
  bindForm.product_id = row.product_id ? String(row.product_id) : "";
  bindForm.person_id = "";
  await ensureProductOptions(row);
  bindDialogVisible.value = true;
}

function applyRouteState() {
  syncingRoute = true;
  try {
    state.filters.shopId = String(route.query.shopId || "all");
    state.filters.status = String(route.query.status || "all");
    state.filters.name = String(route.query.name || "");
    state.filters.offer = String(route.query.offer || "");
    state.filters.page = asPositiveInt(route.query.page, 1);
    state.filters.pageSize = asPositiveInt(route.query.pageSize, 20);
  } finally {
    syncingRoute = false;
  }
}

const syncRouteQuery = createRouteQuerySync({
  route,
  router,
  isSyncingRoute: () => syncingRoute,
  buildQuery(mode) {
    const includeTextFilters = mode === "manual";
    return {
      shopId: state.filters.shopId !== "all" ? state.filters.shopId : undefined,
      status: state.filters.status !== "all" ? state.filters.status : undefined,
      name: includeTextFilters ? state.filters.name || undefined : undefined,
      offer: includeTextFilters ? state.filters.offer || undefined : undefined,
      page: state.filters.page > 1 ? String(state.filters.page) : undefined,
      pageSize: state.filters.pageSize !== 20 ? String(state.filters.pageSize) : undefined
    };
  }
});

async function submitBind() {
  if (!bindForm.online_product_id || !bindForm.product_id) {
    ElMessage.warning("请选择要绑定的库存商品");
    return;
  }
  bindSubmitting.value = true;
  try {
    await apiClient.post("/api/online-products/bind", {
      online_product_id: bindForm.online_product_id,
      product_id: Number(bindForm.product_id),
      person_id: bindForm.person_id ? Number(bindForm.person_id) : null
    });
    ElMessage.success("在线商品已绑定库存");
    bindDialogVisible.value = false;
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "绑定库存失败");
  } finally {
    bindSubmitting.value = false;
  }
}

async function createProductFromOnline(row) {
  try {
    await apiClient.post("/api/online-products/create-product", {
      online_product_id: row.id,
      person_id: state.people[0]?.id || null
    });
    ElMessage.success("已根据在线商品创建库存产品");
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "创建库存产品失败");
  }
}

function openOnlineProductAiWorkbench(row, mode = "optimization") {
  if (!row?.id) return;
  router.push({
    name: mode === "variant" ? "asset-variant-center-wizard" : "ai-optimization-workbench-v2",
    query: {
      workbenchId: createAiWorkbenchId(),
      tabTitle: `${mode === "variant" ? "AI裂变" : "AI优化"} · ${row.offer_id || row.name || row.id}`,
      onlineProductId: String(row.id),
      source: "online_product",
      autoImport: "1",
      importAt: String(Date.now())
    }
  });
}

async function archiveOnlineProduct(row) {
  try {
    await ElMessageBox.confirm(`确认归档在线商品「${row.name || row.ozon_sku}」吗？`, "归档确认", {
      type: "warning",
      confirmButtonText: "确认归档",
      cancelButtonText: "取消"
    });
    await apiClient.post("/api/online-products/action", {
      online_product_id: row.id,
      action: "archive"
    });
    ElMessage.success("在线商品已归档");
    await loadPageData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "归档在线商品失败");
  }
}

async function syncOnlineProducts(selectedOnly = false) {
  syncLoading.value = true;
  try {
    const payload = selectedOnly ? { online_product_ids: state.selectedIds } : {};
    const result = await apiClient.post("/api/sync/online-products", payload);
    if (result?.started === false && result?.running) {
      ElMessage.warning("在线商品同步任务已在后台运行，请等待当前任务完成");
      startOnlineProductSyncPolling();
      return;
    }
    ElMessage.success(selectedOnly ? "已开始后台同步所选商品" : "已开始后台同步全部在线商品");
    startOnlineProductSyncPolling();
  } catch (error) {
    ElMessage.error(error.message || "同步在线商品失败");
    stopOnlineProductSyncPolling();
  }
}

function stopOnlineProductSyncPolling() {
  if (!onlineProductSyncPollTimer) return;
  window.clearInterval(onlineProductSyncPollTimer);
  onlineProductSyncPollTimer = 0;
}

async function pollOnlineProductSyncStatus() {
  try {
    const result = await apiClient.get("/api/sync/online-products/status", { routeScoped: false });
    if (result?.running) {
      syncLoading.value = true;
      return;
    }
    stopOnlineProductSyncPolling();
    syncLoading.value = false;
    if (result?.error) {
      ElMessage.error(result.error || "同步在线商品失败");
      return;
    }
    ElMessage.success(`在线商品同步完成，更新 ${Number(result?.result?.upserted || 0)} 条`);
    await loadPageData();
  } catch (error) {
    stopOnlineProductSyncPolling();
    syncLoading.value = false;
    ElMessage.error(error.message || "获取在线商品同步状态失败");
  }
}

function startOnlineProductSyncPolling() {
  stopOnlineProductSyncPolling();
  syncLoading.value = true;
  void pollOnlineProductSyncStatus();
  onlineProductSyncPollTimer = window.setInterval(() => {
    void pollOnlineProductSyncStatus();
  }, 2500);
}

watch(() => route.query, applyRouteState, { deep: true });
watch(
  () => [state.filters.shopId, state.filters.status, state.filters.page, state.filters.pageSize],
  syncRouteQuery
);

onMounted(async () => {
  applyRouteState();
  await loadPageData();
  try {
    const status = await apiClient.get("/api/sync/online-products/status", { routeScoped: false });
    if (status?.running) startOnlineProductSyncPolling();
  } catch {}
  const openAction = String(route.query.action || "");
  const onlineProductId = Number(route.query.onlineProductId || 0);
  if (openAction === "bind" && onlineProductId) {
    const row = state.onlineProducts.find((item) => Number(item.id) === onlineProductId);
    if (row) await openBindDialog(row);
  }
});

onBeforeUnmount(() => {
  stopOnlineProductSyncPolling();
});
</script>

<template>
  <div class="page-stack online-products-page erp-paged-page">
    <el-card shadow="never" class="page-card online-products-card erp-paged-card">
      <div class="online-toolbar online-toolbar-sticky">
        <el-form inline>
          <el-form-item label="店铺">
            <el-select v-model="state.filters.shopId" style="width: 180px">
              <el-option label="全部店铺" value="all" />
              <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
            </el-select>
          </el-form-item>
          <el-form-item label="商品名称">
            <el-input v-model="state.filters.name" placeholder="商品名称" clearable style="width: 220px" @keyup.enter="handleSearch" />
          </el-form-item>
          <el-form-item label="货号 / Ozon SKU">
            <el-input v-model="state.filters.offer" placeholder="货号 / Ozon SKU" clearable style="width: 220px" @keyup.enter="handleSearch" />
          </el-form-item>
          <el-form-item>
            <el-button class="erp-btn erp-btn-primary" type="primary" @click="handleSearch">查询</el-button>
            <el-button class="erp-btn erp-btn-secondary" @click="handleReset">重置</el-button>
          </el-form-item>
          <el-form-item>
            <el-button class="erp-btn erp-btn-secondary" :loading="syncLoading" :disabled="!state.selectedIds.length" @click="syncOnlineProducts(true)">
              同步所选商品
            </el-button>
            <el-button class="erp-btn erp-btn-secondary" :disabled="!state.selectedIds.length" @click="openBatchStockDialog">
              批量更新库存
            </el-button>
            <el-button class="erp-btn erp-btn-primary" type="primary" :loading="syncLoading" @click="syncOnlineProducts(false)">同步全部在线商品</el-button>
          </el-form-item>
        </el-form>

        <div class="status-tabs">
          <el-tag
            v-for="item in statusOptions"
            :key="item.value"
            :type="state.filters.status === item.value ? 'primary' : 'info'"
            effect="light"
            class="status-tab-tag"
            @click="setStatus(item.value)"
          >
            {{ item.label }} {{ item.count }}
          </el-tag>
        </div>
      </div>

      <div class="online-table-wrap erp-table-scroll">
        <el-table v-loading="loading" :data="pagedRows" stripe border class="erp-data-table" @selection-change="selectionChanged">
          <el-table-column type="selection" width="48" fixed="left" />
          <el-table-column label="店铺 / 状态" min-width="160" fixed="left">
            <template #default="{ row }">
              <div class="cell-stack">
                <strong>{{ row.shop_name || "-" }}</strong>
                <el-tag :type="onlineStatusType(row)">{{ onlineStatusLabel(row) }}</el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="Ozon SKU / Offer ID" min-width="220">
            <template #default="{ row }">
              <div class="cell-stack">
                <strong>{{ displayedOzonSku(row) || "未返回 SKU" }}</strong>
                <span class="muted-text">Offer ID: {{ row.offer_id || "-" }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="商品信息" min-width="320">
            <template #default="{ row }">
              <div class="product-cell">
                <ProductImagePreview :src="row.primary_image || row.image_url" />
                <div class="cell-stack">
                  <ProductTitleLink :title="row.name || row.ozon_sku || '-'" :href="ozonBuyerProductLinkFor(row)" :lines="2" />
                  <span class="muted-text">Ozon SKU: {{ displayedOzonSku(row) || "未返回 SKU" }}</span>
                  <span class="muted-text">在线商品 ID: {{ row.id }}</span>
                  <span class="muted-text">
                    Ozon Product ID:
                    <a
                      v-if="ozonBuyerProductLinkFor(row)"
                      :href="ozonBuyerProductLinkFor(row)"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="muted-text"
                      @click.stop
                    >
                      {{ row.ozon_product_id || "-" }}
                    </a>
                    <template v-else>{{ row.ozon_product_id || "-" }}</template>
                  </span>
                  <span class="muted-text">Offer ID: {{ row.offer_id || "-" }}</span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="售价" width="120" align="right">
            <template #default="{ row }">{{ money(row.sale_price) }}</template>
          </el-table-column>
          <el-table-column label="绑定库存" min-width="220">
            <template #default="{ row }">
              <div v-if="row.product_id" class="cell-stack">
                <strong>{{ row.product_name || "-" }}</strong>
                <span class="muted-text">{{ row.product_code || "-" }}</span>
              </div>
              <span v-else class="muted-text">未绑定库存产品</span>
            </template>
          </el-table-column>
          <el-table-column label="上架时间" min-width="160">
            <template #default="{ row }">{{ dateText(row.published_at || row.ozon_updated_at || row.synced_at || row.updated_at) }}</template>
          </el-table-column>
          <el-table-column label="最后同步时间" min-width="160">
            <template #default="{ row }">{{ dateText(row.synced_at || row.updated_at) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="470" fixed="right">
            <template #default="{ row }">
              <div class="erp-inline-actions">
                <el-button class="erp-btn-link" link type="primary" :loading="openingEditId === Number(row.id)" @click="openOnlineProductEditor(row)">编辑上架</el-button>
                <el-button class="erp-btn-link" link type="primary" @click="openOnlineProductAiWorkbench(row, 'optimization')">AI优化</el-button>
                <el-button class="erp-btn-link" link type="primary" @click="openOnlineProductAiWorkbench(row, 'variant')">AI裂变</el-button>
                <el-button class="erp-btn-link" link type="primary" @click="openBindDialog(row)">去绑定</el-button>
                <el-button class="erp-btn-link" link @click="createProductFromOnline(row)">创建库存</el-button>
                <el-button class="erp-btn-link erp-btn-link-danger" link type="danger" @click="archiveOnlineProduct(row)">归档商品</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <PageFooterPagination
        class="online-footer"
        :total="state.total"
        :page="state.filters.page"
        :page-size="state.filters.pageSize"
        @update:page="handlePageChange"
        @update:pageSize="handlePageSizeChange"
      />
    </el-card>

    <el-dialog v-model="bindDialogVisible" title="绑定 SKU 到库存产品" width="680px" align-center class="erp-centered-dialog" destroy-on-close>
      <el-form label-width="110px">
        <el-form-item label="库存商品">
          <el-select v-model="bindForm.product_id" filterable :loading="productOptionsLoading" placeholder="选择库存商品" style="width: 100%">
            <el-option
              v-for="product in state.products"
              :key="product.id"
              :label="`${product.name} / ${product.inventory_id || product.code || product.id}`"
              :value="String(product.id)"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="负责人">
          <el-select v-model="bindForm.person_id" filterable clearable placeholder="选择负责人" style="width: 100%">
            <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="String(person.id)" />
          </el-select>
        </el-form-item>
      </el-form>

      <template #footer>
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="bindDialogVisible = false">取消</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="bindSubmitting" @click="submitBind">确认绑定</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="stockDialogVisible" title="批量更新 Ozon 库存" width="760px" align-center class="stock-dialog erp-centered-dialog" destroy-on-close>
      <div class="stock-dialog-body">
        <div class="stock-summary-strip">
          <div class="stock-summary-item">
            <span class="stock-summary-label">店铺</span>
            <strong>{{ stockDialogShopName }}</strong>
          </div>
          <div class="stock-summary-item">
            <span class="stock-summary-label">已选商品</span>
            <strong>{{ state.selectedIds.length }}</strong>
          </div>
          <div class="stock-summary-item">
            <span class="stock-summary-label">目标库存</span>
            <strong>{{ Number(stockForm.stock || 0) }}</strong>
          </div>
        </div>

        <div class="stock-form-grid">
          <section class="stock-field-panel stock-field-panel-wide">
            <div class="stock-field-head">
              <div>
                <div class="stock-field-title">Ozon 仓库</div>
                <div class="stock-field-subtitle">{{ stockDialogWarehouseName }}</div>
              </div>
              <el-button class="erp-btn erp-btn-secondary" :loading="warehousesLoading" @click="loadWarehousesForStock(stockForm.shop_id, true)">
                刷新仓库
              </el-button>
            </div>
            <el-select
              v-model="stockForm.warehouse_id"
              filterable
              :loading="warehousesLoading"
              placeholder="选择要写入库存的 Ozon 仓库"
              class="stock-warehouse-select"
            >
              <el-option
                v-for="warehouse in state.warehouses"
                :key="warehouse.warehouse_id"
                :label="`${warehouse.name || 'Ozon 仓库'} / ${warehouse.warehouse_id}`"
                :value="String(warehouse.warehouse_id)"
              >
                <div class="warehouse-option">
                  <strong>{{ warehouse.name || "Ozon 仓库" }}</strong>
                  <span>{{ warehouse.warehouse_id }}</span>
                </div>
              </el-option>
            </el-select>
          </section>

          <section class="stock-field-panel">
            <div class="stock-field-title">上架数量</div>
            <el-input-number v-model="stockForm.stock" :min="0" :step="1" :precision="0" controls-position="right" class="stock-quantity-input" />
            <div class="stock-presets">
              <el-button
                v-for="value in stockPresetValues"
                :key="value"
                size="small"
                :type="Number(stockForm.stock) === value ? 'primary' : ''"
                @click="applyStockPreset(value)"
              >
                {{ value }}
              </el-button>
            </div>
          </section>

          <section class="stock-field-panel stock-field-confirm">
            <div class="stock-field-title">提交内容</div>
            <div class="stock-confirm-line">
              <span>仓库</span>
              <strong>{{ stockDialogWarehouseName }}</strong>
            </div>
            <div class="stock-confirm-line">
              <span>数量</span>
              <strong>{{ Number(stockForm.stock || 0) }}</strong>
            </div>
          </section>
        </div>
      </div>

      <template #footer>
        <div class="erp-dialog-footer stock-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="stockDialogVisible = false">取消</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="stockSubmitting" :disabled="warehousesLoading || !stockForm.warehouse_id" @click="submitBatchStock">
            确认更新 {{ state.selectedIds.length }} 个商品
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.online-products-page { min-height: 0; }
.online-products-card :deep(.el-card__body) { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.online-toolbar { display: grid; gap: 12px; padding: 8px 0 14px; }
.online-toolbar-sticky { position: sticky; top: 0; z-index: 3; background: var(--erp-surface); }
.status-tabs { display: flex; flex-wrap: wrap; gap: 8px; }
.status-tab-tag { cursor: pointer; user-select: none; }
.online-table-wrap { flex: 1; min-height: 0; overflow: auto; }
.online-footer { margin-top: auto; }
.cell-stack { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.muted-text { color: var(--erp-text-secondary); font-size: 12px; line-height: 1.5; }
.product-cell { display: flex; align-items: flex-start; gap: 12px; }
.product-thumb { width: 64px; height: 84px; border-radius: 8px; border: 1px solid var(--erp-border); background: #fff; flex-shrink: 0; overflow: hidden; }
.stock-dialog :deep(.el-dialog__body) { padding: 0 24px 8px; }
.stock-dialog-body { display: grid; gap: 16px; min-height: 260px; }
.stock-summary-strip {
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--erp-border);
  border-radius: 8px;
  background: var(--erp-bg);
}
.stock-summary-item { display: grid; gap: 4px; min-width: 0; }
.stock-summary-item strong { color: var(--erp-text-primary); font-size: 18px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stock-summary-label { color: var(--erp-text-secondary); font-size: 12px; }
.stock-form-grid { display: grid; grid-template-columns: minmax(240px, 0.8fr) minmax(0, 1.4fr); gap: 14px; }
.stock-field-panel {
  display: grid;
  gap: 12px;
  align-content: start;
  padding: 16px;
  border: 1px solid var(--erp-border);
  border-radius: 8px;
  background: var(--erp-surface);
}
.stock-field-panel-wide { grid-column: 1 / -1; }
.stock-field-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.stock-field-title { color: var(--erp-text-primary); font-weight: 700; line-height: 1.3; }
.stock-field-subtitle { margin-top: 4px; color: var(--erp-text-secondary); font-size: 12px; line-height: 1.4; }
.stock-warehouse-select { width: 100%; }
.stock-warehouse-select :deep(.el-select__wrapper) { min-height: 44px; }
.warehouse-option { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-width: 0; }
.warehouse-option strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.warehouse-option span { color: var(--erp-text-secondary); font-size: 12px; flex-shrink: 0; }
.stock-quantity-input { width: 100%; }
.stock-quantity-input :deep(.el-input-number__decrease),
.stock-quantity-input :deep(.el-input-number__increase) { width: 40px; }
.stock-quantity-input :deep(.el-input__wrapper) { min-height: 48px; }
.stock-quantity-input :deep(.el-input__inner) { font-size: 18px; font-weight: 700; }
.stock-presets { display: flex; flex-wrap: wrap; gap: 8px; }
.stock-presets :deep(.el-button) { margin-left: 0; }
.stock-confirm-line { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 16px; color: var(--erp-text-secondary); }
.stock-confirm-line strong { color: var(--erp-text-primary); overflow-wrap: anywhere; }
.stock-dialog-footer { padding-top: 8px; }
@media (max-width: 820px) {
  .stock-summary-strip,
  .stock-form-grid { grid-template-columns: 1fr; }
}
</style>

