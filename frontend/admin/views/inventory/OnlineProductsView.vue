<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import { createLatestRequestGate } from "../../utils/request-gate";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import ProductTitleLink from "../../components/ProductTitleLink.vue";
import { ozonBuyerProductLinkFromRow } from "../../utils/product-links";

const route = useRoute();
const router = useRouter();
let syncingRoute = false;
const listRequestGate = createLatestRequestGate();
let dictionaryLoaded = false;

const loading = ref(false);
const syncLoading = ref(false);
const bindDialogVisible = ref(false);
const bindSubmitting = ref(false);
const productOptionsLoading = ref(false);

const state = reactive({
  onlineProducts: [],
  total: 0,
  statusCounts: {},
  shops: [],
  products: [],
  people: [],
  selectedIds: [],
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

function money(value) {
  return Number(value || 0).toFixed(2);
}

function dateText(value) {
  return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true });
}

function ozonBuyerProductLinkFor(row) {
  return ozonBuyerProductLinkFromRow(row);
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
  loadPageData();
}

function handleReset() {
  state.filters.shopId = "all";
  state.filters.status = "all";
  state.filters.name = "";
  state.filters.offer = "";
  state.filters.page = 1;
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

function syncRouteQuery() {
  if (syncingRoute) return;
  const nextQuery = {
    shopId: state.filters.shopId !== "all" ? state.filters.shopId : undefined,
    status: state.filters.status !== "all" ? state.filters.status : undefined,
    name: state.filters.name || undefined,
    offer: state.filters.offer || undefined,
    page: state.filters.page > 1 ? String(state.filters.page) : undefined,
    pageSize: state.filters.pageSize !== 20 ? String(state.filters.pageSize) : undefined
  };
  const normalized = Object.fromEntries(Object.entries(nextQuery).filter(([, value]) => value != null && value !== ""));
  if (JSON.stringify(route.query || {}) === JSON.stringify(normalized)) return;
  router.replace({ query: normalized });
}

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
    const scope = selectedOnly ? "所选商品" : "全部在线商品";
    ElMessage.success(`已同步${scope}，更新 ${result?.upserted || 0} 条`);
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "同步在线商品失败");
  } finally {
    syncLoading.value = false;
  }
}

watch(() => route.query, applyRouteState, { deep: true });
watch(
  () => [state.filters.shopId, state.filters.status, state.filters.name, state.filters.offer, state.filters.page, state.filters.pageSize],
  syncRouteQuery
);

onMounted(async () => {
  applyRouteState();
  await loadPageData();
  const openAction = String(route.query.action || "");
  const onlineProductId = Number(route.query.onlineProductId || 0);
  if (openAction === "bind" && onlineProductId) {
    const row = state.onlineProducts.find((item) => Number(item.id) === onlineProductId);
    if (row) await openBindDialog(row);
  }
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
          <el-form-item label="货号 / SKU">
            <el-input v-model="state.filters.offer" placeholder="货号 / SKU" clearable style="width: 220px" @keyup.enter="handleSearch" />
          </el-form-item>
          <el-form-item>
            <el-button class="erp-btn erp-btn-primary" type="primary" @click="handleSearch">查询</el-button>
            <el-button class="erp-btn erp-btn-secondary" @click="handleReset">重置</el-button>
          </el-form-item>
          <el-form-item>
            <el-button class="erp-btn erp-btn-secondary" :loading="syncLoading" :disabled="!state.selectedIds.length" @click="syncOnlineProducts(true)">
              同步所选商品
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
          <el-table-column label="SKU / Offer" min-width="180">
            <template #default="{ row }">
              <div class="cell-stack">
                <strong>{{ row.ozon_sku || "-" }}</strong>
                <span class="muted-text">Offer {{ row.offer_id || "-" }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="商品信息" min-width="320">
            <template #default="{ row }">
              <div class="product-cell">
                <ProductImagePreview :src="row.primary_image || row.image_url" />
                <div class="cell-stack">
                  <ProductTitleLink :title="row.name || row.ozon_sku || '-'" :href="ozonBuyerProductLinkFor(row)" :lines="2" />
                  <span class="muted-text">在线商品 ID: {{ row.id }}</span>
                  <span class="muted-text">Ozon Product ID: {{ row.ozon_product_id || "-" }}</span>
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
          <el-table-column label="同步时间" min-width="160">
            <template #default="{ row }">{{ dateText(row.synced_at || row.updated_at) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="260" fixed="right">
            <template #default="{ row }">
              <div class="erp-inline-actions">
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
.product-thumb { width: 52px; height: 52px; border-radius: 10px; border: 1px solid var(--erp-border); background: #fff; flex-shrink: 0; overflow: hidden; }
</style>

