<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";

const route = useRoute();
const router = useRouter();
let syncingRoute = false;

const loading = ref(false);
const syncLoading = ref(false);
const bindDialogVisible = ref(false);
const bindSubmitting = ref(false);

const state = reactive({
  onlineProducts: [],
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
    pageSize: 30
  }
});

const bindForm = reactive({
  online_product_id: null,
  product_id: "",
  person_id: ""
});

const statusOptions = computed(() => {
  const labels = [
    ["all", "全部状态"],
    ["selling", "销售中"],
    ["ready", "待上架"],
    ["error", "异常"],
    ["moderation", "审核中"],
    ["hidden", "已下架"],
    ["archived", "已归档"],
    ["other", "其他"]
  ];
  const counts = Object.fromEntries(labels.map(([key]) => [key, 0]));
  for (const row of state.onlineProducts) {
    counts.all += 1;
    counts[onlineStatusKey(row)] = Number(counts[onlineStatusKey(row)] || 0) + 1;
  }
  return labels.map(([value, label]) => ({ value, label, count: counts[value] || 0 }));
});

const filteredRows = computed(() => {
  const shopId = String(state.filters.shopId || "all");
  const status = String(state.filters.status || "all");
  const name = normalizeSearch(state.filters.name);
  const offer = normalizeSearch(state.filters.offer);
  return state.onlineProducts.filter((row) => {
    const shopOk = shopId === "all" || String(row.shop_id) === shopId;
    const statusOk = status === "all" || onlineStatusKey(row) === status;
    const nameOk = !name || normalizeSearch(row.name).includes(name);
    const offerOk = !offer || normalizeSearch(`${row.offer_id || ""} ${row.ozon_sku || ""}`).includes(offer);
    return shopOk && statusOk && nameOk && offerOk;
  });
});

const pagedRows = computed(() => {
  const start = (state.filters.page - 1) * state.filters.pageSize;
  return filteredRows.value.slice(start, start + state.filters.pageSize);
});

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

function dateText(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
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

function handleSearch() {
  state.filters.page = 1;
}

function handleReset() {
  state.filters.shopId = "all";
  state.filters.status = "all";
  state.filters.name = "";
  state.filters.offer = "";
  state.filters.page = 1;
}

function handlePageChange(page) {
  state.filters.page = page;
}

function handlePageSizeChange(size) {
  state.filters.pageSize = size;
  state.filters.page = 1;
}

function setStatus(value) {
  state.filters.status = value;
  state.filters.page = 1;
}

function selectionChanged(rows) {
  state.selectedIds = rows.map((row) => Number(row.id));
}

function openBindDialog(row) {
  bindForm.online_product_id = Number(row.id);
  bindForm.product_id = row.product_id ? String(row.product_id) : "";
  bindForm.person_id = "";
  bindDialogVisible.value = true;
}

function asPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function applyRouteState() {
  syncingRoute = true;
  try {
    state.filters.shopId = String(route.query.shopId || "all");
    state.filters.status = String(route.query.status || "all");
    state.filters.name = String(route.query.name || "");
    state.filters.offer = String(route.query.offer || "");
    state.filters.page = asPositiveInt(route.query.page, 1);
    state.filters.pageSize = asPositiveInt(route.query.pageSize, 30);
    const openAction = String(route.query.action || "");
    const onlineProductId = Number(route.query.onlineProductId || 0);
    if (openAction === "bind" && onlineProductId) {
      const row = state.onlineProducts.find((item) => Number(item.id) === onlineProductId);
      if (row) openBindDialog(row);
    }
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
    pageSize: state.filters.pageSize !== 30 ? String(state.filters.pageSize) : undefined
  };
  const current = JSON.stringify(route.query || {});
  const next = JSON.stringify(Object.fromEntries(Object.entries(nextQuery).filter(([, value]) => value != null && value !== "")));
  if (current === next) return;
  router.replace({ query: Object.fromEntries(Object.entries(nextQuery).filter(([, value]) => value != null && value !== "")) });
}

async function submitBind() {
  if (!bindForm.online_product_id || !bindForm.product_id) {
    ElMessage.warning("请选择要绑定的库存产品");
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
    const message = selectedOnly
      ? `已同步所选商品，更新 ${result?.upserted || 0} 条`
      : `已同步全部在线商品，更新 ${result?.upserted || 0} 条`;
    ElMessage.success(message);
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "同步在线商品失败");
  } finally {
    syncLoading.value = false;
  }
}

async function loadPageData() {
  loading.value = true;
  try {
    const [onlineProducts, shops, products, people] = await Promise.all([
      apiClient.get("/api/online-products"),
      apiClient.get("/api/shops"),
      apiClient.get("/api/products"),
      apiClient.get("/api/people")
    ]);
    state.onlineProducts = Array.isArray(onlineProducts) ? onlineProducts : [];
    state.shops = Array.isArray(shops) ? shops : [];
    state.products = Array.isArray(products) ? products : [];
    state.people = Array.isArray(people) ? people.filter((item) => Number(item.active) !== 0) : [];
  } catch (error) {
    ElMessage.error(error.message || "在线商品加载失败");
  } finally {
    loading.value = false;
  }
}

watch(
  () => route.query,
  () => applyRouteState(),
  { deep: true }
);

watch(
  () => [
    state.filters.shopId,
    state.filters.status,
    state.filters.name,
    state.filters.offer,
    state.filters.page,
    state.filters.pageSize
  ],
  () => syncRouteQuery()
);

onMounted(async () => {
  applyRouteState();
  await loadPageData();
  applyRouteState();
});
</script>

<template>
  <div class="page-stack online-products-page">
    <el-card shadow="never" class="page-card online-products-card">
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
            <el-button type="primary" @click="handleSearch">查询</el-button>
            <el-button @click="handleReset">重置</el-button>
          </el-form-item>
          <el-form-item>
            <el-button :loading="syncLoading" :disabled="!state.selectedIds.length" @click="syncOnlineProducts(true)">
              同步所选商品
            </el-button>
            <el-button type="primary" :loading="syncLoading" @click="syncOnlineProducts(false)">同步全部在线商品</el-button>
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

      <div class="online-table-wrap">
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
                <el-image v-if="row.primary_image || row.image_url" :src="row.primary_image || row.image_url" fit="cover" class="product-thumb" />
                <div class="cell-stack">
                  <strong>{{ row.name || "-" }}</strong>
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
              <el-space wrap>
                <el-button link type="primary" @click="openBindDialog(row)">去绑定</el-button>
                <el-button link @click="createProductFromOnline(row)">创建库存</el-button>
                <el-button link type="danger" @click="archiveOnlineProduct(row)">归档商品</el-button>
              </el-space>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <PageFooterPagination
        class="online-footer"
        :total="filteredRows.length"
        :page="state.filters.page"
        :page-size="state.filters.pageSize"
        :page-sizes="[30, 50, 100]"
        @update:page="handlePageChange"
        @update:pageSize="handlePageSizeChange"
      />
    </el-card>

    <el-dialog v-model="bindDialogVisible" title="绑定 SKU 到库存产品" width="680px" align-center class="erp-centered-dialog" destroy-on-close>
      <el-form label-width="110px">
        <el-form-item label="库存产品">
          <el-select v-model="bindForm.product_id" filterable placeholder="选择库存产品" style="width: 100%">
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
        <div class="dialog-footer">
          <el-button @click="bindDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="bindSubmitting" @click="submitBind">确认绑定</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.online-products-page { min-height: 100%; }
.online-products-card :deep(.el-card__body) { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.online-toolbar { display: grid; gap: 12px; padding: 8px 0 14px; }
.online-toolbar-sticky { position: sticky; top: 0; z-index: 3; background: var(--erp-surface); }
.status-tabs { display: flex; flex-wrap: wrap; gap: 8px; }
.status-tab-tag { cursor: pointer; user-select: none; }
.online-table-wrap { flex: 1; min-height: 0; overflow: auto; }
.online-footer { margin-top: auto; }
.dialog-footer { display: flex; justify-content: flex-end; gap: 12px; }
.cell-stack { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.muted-text { color: var(--erp-text-secondary); font-size: 12px; line-height: 1.5; }
.product-cell { display: flex; align-items: flex-start; gap: 12px; }
.product-thumb { width: 52px; height: 52px; border-radius: 10px; border: 1px solid var(--erp-border); background: #fff; flex-shrink: 0; overflow: hidden; }
</style>
