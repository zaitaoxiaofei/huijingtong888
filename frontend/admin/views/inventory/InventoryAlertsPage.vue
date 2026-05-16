<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import InventoryPageToolbar from "../../components/inventory/InventoryPageToolbar.vue";
import { applyFilterQuery, buildFilterQuery, dateText, integer, isWithinDateRange, normalizeSearch, paginate, stockStatusText, stockStatusType } from "./inventory-utils.js";

const route = useRoute();
const router = useRouter();
let syncingRoute = false;

const loading = ref(false);
const syncLoading = ref(false);
const state = reactive({
  rows: [],
  shops: [],
  filters: {
    query: "",
    shopId: "all",
    dateFrom: "",
    dateTo: "",
    page: 1,
    pageSize: 30
  }
});

const filterDefaults = {
  query: "",
  shopId: "all",
  dateFrom: "",
  dateTo: "",
  page: 1,
  pageSize: 30
};

const filteredRows = computed(() => {
  const query = normalizeSearch(state.filters.query);
  const shopId = String(state.filters.shopId || "all");
  return state.rows.filter((row) => {
    if (shopId !== "all") {
      const matched = Array.isArray(row.skus) && row.skus.some((sku) => String(sku.shop_id || "") === shopId);
      if (!matched) return false;
    }
    if (!isWithinDateRange(row.created_at, state.filters.dateFrom, state.filters.dateTo)) return false;
    if (!query) return true;
    const skuText = Array.isArray(row.skus) ? row.skus.map((sku) => `${sku.shop_name || ""} ${sku.ozon_sku || ""} ${sku.offer_id || ""}`).join(" ") : "";
    const haystack = [row.product_name, row.inventory_id, row.suggestion, skuText].map(normalizeSearch).join(" ");
    return haystack.includes(query);
  });
});

const pagedRows = computed(() => paginate(filteredRows.value, state.filters.page, state.filters.pageSize));

function alertSkuSummary(row) {
  const skus = Array.isArray(row.skus) ? row.skus : [];
  if (!skus.length) return "未绑定 SKU";
  return skus.slice(0, 3).map((sku) => `${sku.shop_name || "-"} / ${sku.ozon_sku || "-"}`).join(" | ");
}

function warningTagType(level) {
  if (level === "danger") return "danger";
  if (level === "warning") return "warning";
  if (level === "info") return "";
  return "success";
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

function openProcurement(row) {
  router.push({ path: "/procurement", query: { productId: String(row.product_id), from: "inventory-alerts" } });
}

function openMappings() {
  router.push("/inventory/mappings");
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
  loading.value = true;
  try {
    const [payload, shops] = await Promise.all([
      apiClient.get("/api/stock-alerts"),
      apiClient.get("/api/shops")
    ]);
    state.rows = Array.isArray(payload?.rows) ? payload.rows : [];
    state.shops = Array.isArray(shops) ? shops : [];
  } catch (error) {
    ElMessage.error(error.message || "库存预警加载失败");
  } finally {
    loading.value = false;
  }
}

watch(() => route.query, applyRouteState, { deep: true });
watch(() => [state.filters.query, state.filters.shopId, state.filters.dateFrom, state.filters.dateTo, state.filters.page, state.filters.pageSize], syncRouteQuery);

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
      query-label="预警搜索"
      query-placeholder="产品名称 / SKU / 库存ID"
      @search="handleSearch"
      @reset="handleReset"
    />

    <div class="inventory-table-wrap">
      <el-table v-loading="loading || syncLoading" :data="pagedRows" stripe border class="erp-data-table">
        <el-table-column label="库存产品" min-width="280" fixed="left">
          <template #default="{ row }">
            <div class="product-cell">
              <el-image v-if="row.image_url" :src="row.image_url" fit="cover" class="product-thumb" />
              <div class="cell-stack">
                <strong>{{ row.product_name }}</strong>
                <span class="muted-text">{{ row.inventory_id }}</span>
                <span class="muted-text">{{ alertSkuSummary(row) }}</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="本地库存" width="100" align="center">
          <template #default="{ row }">{{ integer(row.local_stock) }}</template>
        </el-table-column>
        <el-table-column label="预警值" width="100" align="center">
          <template #default="{ row }">{{ integer(row.alert_stock) }}</template>
        </el-table-column>
        <el-table-column label="FBP / FBS" width="150" align="center">
          <template #default="{ row }">
            <div class="cell-stack cell-center">
              <strong>FBP {{ integer(row.fbp_total) }}</strong>
              <span class="muted-text">FBS {{ integer(row.fbs_total) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="7天 / 30天销量" width="160" align="center">
          <template #default="{ row }">
            <div class="cell-stack cell-center">
              <strong>{{ integer(row.recent_7d_qty) }}</strong>
              <span class="muted-text">30天 {{ integer(row.recent_30d_qty) }}</span>
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
        <el-table-column label="状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="stockStatusType(row.local_stock, row.alert_stock)">
              {{ stockStatusText(row.local_stock, row.alert_stock) }}
            </el-tag>
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
        <el-table-column label="操作" width="260" fixed="right">
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
