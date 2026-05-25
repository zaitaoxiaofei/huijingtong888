<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useRoute, useRouter } from "vue-router";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import { formatMoney } from "./profit-utils.js";

const props = defineProps({
  dimension: { type: String, default: "sku" },
  showNavigation: { type: Boolean, default: true }
});

const route = useRoute();
const router = useRouter();

const loading = ref(false);
const detailLoading = ref(false);
const detailVisible = ref(false);

const state = reactive({
  rows: [],
  total: 0,
  totalPages: 0,
  page: 1,
  pageSize: 30,
  sortBy: "profit",
  sortOrder: "descending",
  filters: {
    from: "",
    to: "",
    keyword: ""
  }
});

const detail = reactive({
  row: null,
  rows: [],
  page: 1,
  pageSize: 20
});

const rankingTabs = [
  { label: "鍒╂鼎鐪嬫澘", value: "/profit" },
  { label: "SKU 排行榜", value: "/profit/sku-ranking" },
  { label: "店铺排行榜", value: "/profit/shop-ranking" }
];

const activeRankingRoute = computed(() => {
  const matched = rankingTabs.find((item) => item.value === route.path);
  return matched?.value || (props.dimension === "shop" ? "/profit/shop-ranking" : "/profit/sku-ranking");
});

const keywordPlaceholder = computed(() => (
  props.dimension === "shop" ? "搴楅摵鍚嶇О" : "SKU / 鍟嗗搧 / 搴楅摵"
));

const detailPagedRows = computed(() => {
  const page = Math.max(1, Number(detail.page || 1));
  const pageSize = Math.max(1, Number(detail.pageSize || 20));
  const start = (page - 1) * pageSize;
  return detail.rows.slice(start, start + pageSize);
});

function modelCancelledRevenue(row) {
  return Number(row?.cancelled_revenue ?? row?.cancel_amount ?? 0) - Number(row?.event_cancelled_revenue || 0);
}

function rowThumb(row) {
  return String(row?.image_url || row?.primary_image || row?.product_image_url || "").trim();
}

function toApiSortOrder(order) {
  if (order === "ascending") return "asc";
  if (order === "descending") return "desc";
  return "";
}

async function loadRows() {
  loading.value = true;
  try {
    const params = new URLSearchParams({
      dimension: props.dimension,
      page: String(state.page),
      pageSize: String(state.pageSize)
    });
    if (state.filters.from) params.set("from", state.filters.from);
    if (state.filters.to) params.set("to", state.filters.to);
    if (state.filters.keyword) params.set("keyword", state.filters.keyword);
    if (state.sortBy) params.set("sortBy", state.sortBy);
    if (state.sortOrder) params.set("sortOrder", toApiSortOrder(state.sortOrder));

    const payload = await apiClient.get(`/api/profit-ranking?${params.toString()}`);
    state.rows = Array.isArray(payload?.rows) ? payload.rows : [];
    state.total = Number(payload?.total || 0);
    state.totalPages = Number(payload?.totalPages || 1);
    state.page = Number(payload?.page || 1);
    state.pageSize = Number(payload?.pageSize || state.pageSize);
    if (!state.filters.from) state.filters.from = payload?.from || "";
    if (!state.filters.to) state.filters.to = payload?.to || "";
  } catch (error) {
    ElMessage.error(error.message || "排行榜加载失败");
  } finally {
    loading.value = false;
  }
}

async function openDetail(row) {
  detailLoading.value = true;
  detailVisible.value = true;
  detail.row = row;
  detail.rows = [];
  detail.page = 1;

  try {
    const params = new URLSearchParams({
      dimension: props.dimension,
      shop_id: String(row.shop_id || ""),
      from: state.filters.from || "",
      to: state.filters.to || "",
      limit: "200"
    });

    if (props.dimension === "sku") {
      params.set("shop_id", String(row.shop_id || ""));
      params.set("ozon_sku", String(row.ozon_sku || ""));
    }

    const payload = await apiClient.get(`/api/profit-ranking/details?${params.toString()}`);
    detail.rows = Array.isArray(payload?.rows) ? payload.rows : [];
  } catch (error) {
    detailVisible.value = false;
    ElMessage.error(error.message || "鏄庣粏鍔犺浇澶辫触");
  } finally {
    detailLoading.value = false;
  }
}

function handleSearch() {
  state.page = 1;
  loadRows();
}

function handleReset() {
  state.page = 1;
  state.pageSize = 30;
  state.sortBy = "profit";
  state.sortOrder = "descending";
  state.filters.from = "";
  state.filters.to = "";
  state.filters.keyword = "";
  loadRows();
}

function handlePageChange(page) {
  state.page = Number(page || 1);
  loadRows();
}

function handlePageSizeChange(size) {
  state.page = 1;
  state.pageSize = Number(size || 30);
  loadRows();
}

function handleDetailPageChange(page) {
  detail.page = Number(page || 1);
}

function handleDetailPageSizeChange(size) {
  detail.page = 1;
  detail.pageSize = Number(size || 20);
}

function handleSortChange({ prop, order }) {
  state.page = 1;
  state.sortBy = prop || "profit";
  state.sortOrder = order || "descending";
  loadRows();
}

function handleTabChange(target) {
  if (target && target !== route.path) router.push(target);
}

watch(() => props.dimension, () => {
  state.page = 1;
  state.filters.keyword = "";
  state.sortBy = "profit";
  state.sortOrder = "descending";
  detailVisible.value = false;
  loadRows();
});

onMounted(loadRows);
</script>

<template>
  <div class="ranking-page-shell">
    <el-card shadow="never" class="page-card ranking-card">
      <div class="ranking-toolbar">
        <div class="ranking-toolbar__filters">
          <el-form inline>
            <el-form-item label="开始日期">
              <el-date-picker
                v-model="state.filters.from"
                value-format="YYYY-MM-DD"
                type="date"
                placeholder="开始日期"
              />
            </el-form-item>
            <el-form-item label="缁撴潫鏃ユ湡">
              <el-date-picker
                v-model="state.filters.to"
                value-format="YYYY-MM-DD"
                type="date"
                placeholder="缁撴潫鏃ユ湡"
              />
            </el-form-item>
            <el-form-item label="关键词">
              <el-input
                v-model="state.filters.keyword"
                :placeholder="keywordPlaceholder"
                clearable
                style="width: 240px"
                @keyup.enter="handleSearch"
              />
            </el-form-item>
          </el-form>
        </div>

        <div class="ranking-toolbar__right">
          <el-segmented
            v-if="showNavigation"
            class="ranking-toolbar__tabs"
            :model-value="activeRankingRoute"
            :options="rankingTabs"
            @change="handleTabChange"
          />
          <div class="ranking-toolbar__actions">
            <el-button type="primary" size="small" :loading="loading" @click="handleSearch">鏌ヨ</el-button>
            <el-button size="small" @click="handleReset">閲嶇疆</el-button>
            <el-button size="small" :loading="loading" @click="loadRows">鍒锋柊</el-button>
          </div>
        </div>
      </div>

      <div class="ranking-workspace">
        <div class="ranking-table-wrap">
          <el-table
            :data="state.rows"
            height="100%"
            stripe
            class="erp-data-table ranking-table"
            table-layout="fixed"
            v-loading="loading"
            @sort-change="handleSortChange"
          >
          <el-table-column prop="rank" label="鎺掑悕" width="70" />

          <template v-if="props.dimension === 'shop'">
            <el-table-column prop="shop_name" label="搴楅摵" min-width="180" />
            <el-table-column prop="order_count" label="订单数" width="100" sortable="custom" />
            <el-table-column prop="item_quantity" label="销量" width="90" />
            <el-table-column prop="revenue" label="营业额" min-width="120" sortable="custom">
              <template #default="{ row }">{{ formatMoney(row.revenue) }}</template>
            </el-table-column>
            <el-table-column prop="profit" label="鍒╂鼎" min-width="120" sortable="custom">
              <template #default="{ row }">{{ formatMoney(row.profit) }}</template>
            </el-table-column>
            <el-table-column prop="model_cancelled_revenue" label="鍒╂鼎鍙ｅ緞鍙栨秷" min-width="130" sortable="custom">
              <template #default="{ row }">{{ formatMoney(modelCancelledRevenue(row)) }}</template>
            </el-table-column>
            <el-table-column prop="event_cancelled_revenue" label="状态取消金额" min-width="130" sortable="custom">
              <template #default="{ row }">{{ formatMoney(row.event_cancelled_revenue) }}</template>
            </el-table-column>
            <el-table-column prop="event_return_revenue" label="状态退货金额" min-width="130" sortable="custom">
              <template #default="{ row }">{{ formatMoney(row.event_return_revenue) }}</template>
            </el-table-column>
            <el-table-column label="鎿嶄綔" width="82" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openDetail(row)">鏄庣粏</el-button>
              </template>
            </el-table-column>
          </template>

          <template v-else>
            <el-table-column prop="product_name" label="鍟嗗搧鍚嶇О" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">{{ row.product_name || "-" }}</template>
            </el-table-column>
            <el-table-column label="缩略图" width="88" align="center">
              <template #default="{ row }">
                <ProductImagePreview :src="rowThumb(row)" />
              </template>
            </el-table-column>
            <el-table-column prop="shop_name" label="搴楅摵" min-width="120" />
            <el-table-column prop="owner_name" label="负责人" min-width="96" />
            <el-table-column prop="order_count" label="订单数" width="90" sortable="custom" />
            <el-table-column prop="revenue" label="营业额" min-width="120" sortable="custom">
              <template #default="{ row }">{{ formatMoney(row.revenue) }}</template>
            </el-table-column>
            <el-table-column prop="profit" label="鍒╂鼎" min-width="120" sortable="custom">
              <template #default="{ row }">{{ formatMoney(row.profit) }}</template>
            </el-table-column>
            <el-table-column prop="model_cancelled_revenue" label="鍒╂鼎鍙ｅ緞鍙栨秷" min-width="130" sortable="custom">
              <template #default="{ row }">{{ formatMoney(modelCancelledRevenue(row)) }}</template>
            </el-table-column>
            <el-table-column prop="event_cancelled_revenue" label="状态取消金额" min-width="130" sortable="custom">
              <template #default="{ row }">{{ formatMoney(row.event_cancelled_revenue) }}</template>
            </el-table-column>
            <el-table-column prop="event_return_revenue" label="状态退货金额" min-width="130" sortable="custom">
              <template #default="{ row }">{{ formatMoney(row.event_return_revenue) }}</template>
            </el-table-column>
            <el-table-column label="鎿嶄綔" width="82" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openDetail(row)">鏄庣粏</el-button>
              </template>
            </el-table-column>
          </template>
          </el-table>
        </div>

        <PageFooterPagination
          class="ranking-footer"
          :total="state.total"
          :page="state.page"
          :page-size="state.pageSize"
          :total-pages="state.totalPages"
          :page-sizes="[30, 50, 100]"
          summary=" "
          @update:page="handlePageChange"
          @update:page-size="handlePageSizeChange"
        />
      </div>
    </el-card>

    <el-dialog v-model="detailVisible" title="鎺掕鏄庣粏" width="1080px" destroy-on-close class="erp-centered-dialog">
      <div v-loading="detailLoading" class="ranking-detail-dialog">
        <div class="ranking-detail-table-wrap">
          <el-table
            :data="detailPagedRows"
            height="100%"
            stripe
            class="erp-data-table ranking-detail-table"
            table-layout="fixed"
          >
            <el-table-column prop="ordered_at" label="涓嬪崟鏃堕棿" min-width="150" />
            <el-table-column prop="posting_number" label="包裹号" min-width="160" />
            <el-table-column label="鍟嗗搧" min-width="320">
              <template #default="{ row }">
                <div class="ranking-detail-product">
                  <ProductImagePreview :src="rowThumb(row)" size="large" />
                  <strong>{{ row.item_names || "-" }}</strong>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="order_status" label="订单状态" min-width="120" />
            <el-table-column prop="revenue" label="营业额" min-width="120">
              <template #default="{ row }">{{ formatMoney(row.revenue) }}</template>
            </el-table-column>
            <el-table-column prop="profit" label="鍒╂鼎" min-width="120">
              <template #default="{ row }">{{ formatMoney(row.profit) }}</template>
            </el-table-column>
            <el-table-column label="取消/退货说明" min-width="220">
              <template #default="{ row }">
                {{ row.reason_label || row.loss_profile_label || "-" }}
              </template>
            </el-table-column>
          </el-table>
        </div>

        <PageFooterPagination
          :total="detail.rows.length"
          :page="detail.page"
          :page-size="detail.pageSize"
          :page-sizes="[20, 30, 50, 100]"
          summary=" "
          @update:page="handleDetailPageChange"
          @update:page-size="handleDetailPageSizeChange"
        />
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.ranking-page-shell {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 140px);
  min-height: 620px;
  overflow: hidden;
}

.ranking-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.ranking-card :deep(.el-card__body) {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  padding-bottom: 0;
}

.ranking-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px 16px;
  align-items: start;
  flex: none;
  padding-bottom: 8px;
  position: sticky;
  top: 0;
  z-index: 4;
  background: var(--erp-surface);
}

.ranking-toolbar__filters {
  min-width: 0;
}

.ranking-toolbar__filters :deep(.el-form) {
  display: flex;
  align-items: center;
  gap: 8px 0;
  flex-wrap: wrap;
}

.ranking-toolbar__right {
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  gap: 8px;
  white-space: nowrap;
  flex-shrink: 0;
}

.ranking-toolbar__tabs {
  flex: none;
}

.ranking-toolbar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.ranking-workspace {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.ranking-table-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.ranking-table,
.ranking-detail-table {
  height: 100%;
}

.ranking-table :deep(.el-table__header-wrapper) {
  position: sticky;
  top: 0;
  z-index: 5;
}

.ranking-table :deep(.el-table__header-wrapper th) {
  background: #f7f9fc;
}

.ranking-table :deep(.el-table__body-wrapper) {
  height: calc(100% - var(--el-table-header-height, 44px));
  overflow: auto;
  overscroll-behavior: contain;
}

.ranking-footer {
  flex: none;
  margin-top: auto;
  position: sticky;
  bottom: 0;
  z-index: 4;
  background: var(--erp-surface);
  padding-top: 10px;
  border-top: 1px solid rgba(226, 232, 240, 0.9);
}

.ranking-table :deep(.el-table__row) {
  height: 76px !important;
}

.ranking-table :deep(.el-table__cell),
.ranking-detail-table :deep(.el-table__cell) {
  font-size: 12px;
  vertical-align: middle;
}

.ranking-table :deep(.el-table__cell .cell) {
  min-height: 56px;
  display: flex;
  align-items: center;
}

.ranking-table :deep(.el-table__cell:nth-child(3) .cell) {
  justify-content: center;
}

.sku-thumb {
  width: 48px !important;
  min-width: 48px !important;
  max-width: 48px !important;
  height: 64px !important;
  min-height: 64px !important;
  max-height: 64px !important;
  margin: 0 auto;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  overflow: hidden !important;
  border-radius: 8px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: #f8fafc;
  flex: 0 0 48px !important;
}

.sku-thumb__img {
  width: 48px !important;
  min-width: 48px !important;
  max-width: 48px !important;
  height: 64px !important;
  min-height: 64px !important;
  max-height: 64px !important;
  display: block !important;
  object-fit: contain !important;
  object-position: center center !important;
  overflow: hidden !important;
  flex: 0 0 48px !important;
  cursor: zoom-in;
}

.sku-thumb__empty {
  color: #94a3b8;
  font-size: 11px;
}

.sku-thumb--detail {
  width: 42px !important;
  min-width: 42px !important;
  max-width: 42px !important;
  height: 56px !important;
  min-height: 56px !important;
  max-height: 56px !important;
  margin: 0;
}

.sku-thumb__img--detail {
  width: 42px !important;
  min-width: 42px !important;
  max-width: 42px !important;
  height: 56px !important;
  min-height: 56px !important;
  max-height: 56px !important;
}

.ranking-detail-dialog {
  display: flex;
  flex-direction: column;
  min-height: 620px;
  max-height: calc(100vh - 180px);
}

.ranking-detail-table-wrap {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.ranking-detail-product {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.ranking-detail-product strong {
  color: #0f172a;
  font-size: 13px;
  line-height: 1.35;
}

@media (max-width: 1380px) {
  .ranking-toolbar {
    grid-template-columns: 1fr;
  }

  .ranking-toolbar__right {
    justify-content: flex-end;
  }
}

@media (max-width: 980px) {
  .ranking-toolbar__right {
    flex-wrap: wrap;
  }
}
</style>

