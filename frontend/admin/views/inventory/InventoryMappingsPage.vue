<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { createLatestRequestGate } from "../../utils/request-gate";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import InventoryPageToolbar from "../../components/inventory/InventoryPageToolbar.vue";
import { applyFilterQuery, buildFilterQuery, dateText } from "./inventory-utils.js";

const route = useRoute();
const router = useRouter();
let syncingRoute = false;
const listRequestGate = createLatestRequestGate();
let dictionaryLoaded = false;

const loading = ref(false);
const dialogVisible = ref(false);
const dialogSubmitting = ref(false);
const productOptionsLoading = ref(false);

const state = reactive({
  rows: [],
  total: 0,
  shops: [],
  people: [],
  products: [],
  filters: {
    query: "",
    shopId: "all",
    dateFrom: "",
    dateTo: "",
    page: 1,
    pageSize: 30
  }
});

const dialog = reactive({
  id: null,
  product_id: "",
  person_id: ""
});

const filterDefaults = {
  query: "",
  shopId: "all",
  dateFrom: "",
  dateTo: "",
  page: 1,
  pageSize: 30
};

const focusProductId = computed(() => Number(route.query.productId || 0) || null);
const focusedProduct = computed(() => state.products.find((item) => Number(item.id) === Number(focusProductId.value)) || null);
const returnTo = computed(() => String(route.query.returnTo || ""));
const cameFromProducts = computed(() => String(route.query.from || "") === "inventory-products");

const pagedRows = computed(() => state.rows);
const productOptions = computed(() => state.products.map((item) => ({ label: `${item.name} / ${item.inventory_id || item.code || item.id}`, value: item.id })));
const pagedProductSpans = computed(() => {
  const spans = [];
  let index = 0;
  while (index < pagedRows.value.length) {
    const productId = Number(pagedRows.value[index]?.product_id || 0);
    let size = 1;
    while (index + size < pagedRows.value.length && Number(pagedRows.value[index + size]?.product_id || 0) === productId) {
      size += 1;
    }
    spans[index] = size;
    for (let offset = 1; offset < size; offset += 1) spans[index + offset] = 0;
    index += size;
  }
  return spans;
});
const pagedProductCounts = computed(() => {
  const counts = new Map();
  for (const row of pagedRows.value) {
    const productId = Number(row?.product_id || 0);
    counts.set(productId, Number(counts.get(productId) || 0) + 1);
  }
  return counts;
});

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

function mappingSpanMethod({ rowIndex, columnIndex }) {
  if (columnIndex !== 0) return { rowspan: 1, colspan: 1 };
  const rowspan = Number(pagedProductSpans.value[rowIndex] || 0);
  return rowspan > 0 ? { rowspan, colspan: 1 } : { rowspan: 0, colspan: 0 };
}

function productBindingCount(row) {
  return Number(pagedProductCounts.value.get(Number(row?.product_id || 0)) || 0);
}

async function ensureProductOptions(row = null) {
  if (state.products.length) return;
  productOptionsLoading.value = true;
  try {
    const query = row?.product_name || row?.product_code || row?.inventory_id || "";
    const params = new URLSearchParams({ paged: "1", page: "1", pageSize: "100" });
    if (query) params.set("query", query);
    const result = await apiClient.get(`/api/products?${params.toString()}`);
    state.products = Array.isArray(result?.rows) ? result.rows : [];
  } catch (error) {
    ElMessage.error(error.message || "加载商品候选失败");
  } finally {
    productOptionsLoading.value = false;
  }
}

async function openEditDialog(row) {
  dialog.id = row.id;
  dialog.product_id = row.product_id;
  dialog.person_id = row.person_id || "";
  await ensureProductOptions(row);
  dialogVisible.value = true;
}

function openOnlineProducts() {
  router.push("/online-products");
}

function goBackToProducts() {
  if (returnTo.value) {
    router.push(returnTo.value);
    return;
  }
  router.push({
    path: "/inventory/products",
    query: focusProductId.value ? { productId: String(focusProductId.value) } : {}
  });
}

async function submitDialog() {
  if (!dialog.id || !dialog.product_id) {
    ElMessage.warning("请选择库存产品");
    return;
  }
  dialogSubmitting.value = true;
  try {
    await apiClient.put(`/api/mappings/${dialog.id}`, {
      product_id: Number(dialog.product_id),
      person_id: dialog.person_id ? Number(dialog.person_id) : null
    });
    ElMessage.success("SKU 绑定已更新");
    dialogVisible.value = false;
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "更新 SKU 绑定失败");
  } finally {
    dialogSubmitting.value = false;
  }
}

async function deleteMapping(row) {
  try {
    await ElMessageBox.confirm(`确认停用绑定「${row.shop_name} / ${row.ozon_sku}」吗？`, "停用绑定", {
      type: "warning",
      confirmButtonText: "确认停用",
      cancelButtonText: "取消"
    });
    await apiClient.delete(`/api/mappings/${row.id}`);
    ElMessage.success("SKU 绑定已停用");
    await loadPageData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "停用 SKU 绑定失败");
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
    if (focusProductId.value) params.set("productId", String(focusProductId.value));
    const requests = [apiClient.get(`/api/mappings?${params.toString()}`)];
    if (!dictionaryLoaded) requests.push(apiClient.get("/api/shops"), apiClient.get("/api/people"));
    const [rows, shops, people] = await Promise.all(requests);
    if (!listRequestGate.isLatest(requestToken)) return;
    state.rows = Array.isArray(rows?.rows) ? rows.rows : [];
    state.total = Number(rows?.total || 0);
    if (!dictionaryLoaded) {
      state.shops = Array.isArray(shops) ? shops : [];
      state.people = Array.isArray(people) ? people.filter((item) => Number(item.active) !== 0) : [];
      dictionaryLoaded = true;
    }
    applyRouteState();
  } catch (error) {
    if (!listRequestGate.isLatest(requestToken)) return;
    ElMessage.error(error.message || "库存-SKU映射表加载失败");
  } finally {
    if (listRequestGate.isLatest(requestToken)) loading.value = false;
  }
}

watch(() => route.query, applyRouteState, { deep: true });
watch(
  () => [state.filters.query, state.filters.shopId, state.filters.dateFrom, state.filters.dateTo, state.filters.page, state.filters.pageSize],
  syncRouteQuery
);

onMounted(async () => {
  applyRouteState();
  await loadPageData();
});
</script>

<template>
  <div class="inventory-page-shell inventory-card">
    <div v-if="focusProductId" class="mapping-focus-banner">
      <div class="mapping-focus-copy">
        <strong>{{ focusedProduct?.name || "当前产品" }}</strong>
        <span>{{ focusedProduct?.inventory_id || focusedProduct?.code || `产品ID ${focusProductId}` }}</span>
        <span>当前只显示这个产品对应的 SKU 绑定。</span>
      </div>
      <div class="mapping-focus-actions">
        <el-button v-if="cameFromProducts" @click="goBackToProducts">返回产品库存表</el-button>
        <el-button type="primary" plain @click="openOnlineProducts">去在线商品页新增绑定</el-button>
      </div>
    </div>

    <InventoryPageToolbar
      :filters="state.filters"
      :shops="state.shops"
      query-label="映射搜索"
      query-placeholder="库存产品 / SKU / 库存ID / 店铺"
      @search="handleSearch"
      @reset="handleReset"
    >
      <template #actions>
        <el-button v-if="!focusProductId" @click="openOnlineProducts">去在线商品页新增绑定</el-button>
      </template>
    </InventoryPageToolbar>

    <div class="inventory-table-wrap">
      <el-table v-loading="loading" :data="pagedRows" :span-method="mappingSpanMethod" stripe border class="erp-data-table">
        <el-table-column label="库存产品" min-width="280" fixed="left">
          <template #default="{ row }">
            <div class="product-cell">
              <ProductImagePreview :src="row.product_image_url" />
              <div class="cell-stack">
                <strong>{{ row.product_name || "-" }}</strong>
                <span class="muted-text">{{ row.inventory_id || row.product_code || "-" }}</span>
                <span class="muted-text">已绑定 {{ productBindingCount(row) }} 个 SKU</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="映射SKU" min-width="220">
          <template #default="{ row }">
            <div class="cell-stack">
              <strong>{{ row.ozon_sku || "-" }}</strong>
              <span class="muted-text">Offer {{ row.offer_id || "-" }}</span>
              <span class="muted-text">{{ row.online_name || "-" }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="店铺" min-width="160">
          <template #default="{ row }">
            <div class="cell-stack">
              <strong>{{ row.shop_name || "-" }}</strong>
              <span class="muted-text">负责人：{{ row.person_name || "-" }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ dateText(row.created_at || row.updated_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-space wrap>
              <el-button link type="primary" @click="openEditDialog(row)">编辑</el-button>
              <el-button link type="danger" @click="deleteMapping(row)">停用</el-button>
            </el-space>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <PageFooterPagination
      :total="state.total"
      :page="state.filters.page"
      :page-size="state.filters.pageSize"
      :page-sizes="[30, 50, 100]"
      @update:page="handlePageChange"
      @update:pageSize="handlePageSizeChange"
    />

    <el-dialog v-model="dialogVisible" title="编辑 SKU 绑定" width="760px" align-center class="erp-centered-dialog">
      <el-form label-width="100px">
        <el-form-item label="库存产品">
          <el-select v-model="dialog.product_id" filterable :loading="productOptionsLoading" style="width: 100%">
            <el-option v-for="item in productOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="负责人">
          <el-select v-model="dialog.person_id" clearable style="width: 100%">
            <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="person.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="dialogSubmitting" @click="submitDialog">保存</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.mapping-focus-banner {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  padding: 16px 18px;
  margin-bottom: 16px;
  border: 1px solid #d9e6f7;
  border-radius: 14px;
  background: linear-gradient(135deg, #f7fbff 0%, #eef5ff 100%);
}

.mapping-focus-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mapping-focus-copy strong {
  font-size: 15px;
}

.mapping-focus-copy span {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.mapping-focus-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.product-thumb-fallback {
  display: grid;
  place-items: center;
  background: #f3f6fb;
  color: #8c98aa;
  font-size: 12px;
}

@media (max-width: 900px) {
  .mapping-focus-banner {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>

