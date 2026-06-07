<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import { shanghaiDateKey, shanghaiMonthStart } from "../../utils/shanghai-date";

const loading = ref(false);

const state = reactive({
  rows: [],
  shops: [],
  total: 0,
  summary: {
    totalRows: 0,
    totalOrders: 0,
    totalQuantity: 0,
    totalAmount: 0,
    cancelledCount: 0
  },
  filters: {
    dateFrom: monthStartText(),
    dateTo: todayText(),
    shopId: "all",
    status: "all",
    query: "",
    page: 1,
    pageSize: 20
  }
});

const filteredRows = computed(() => {
  const query = normalizeSearch(state.filters.query);
  return state.rows.filter((row) => {
    const dateValue = String(row.outbound_time || row.created_at || "").slice(0, 10);
    if (!dateValue) return false;
    if (state.filters.dateFrom && dateValue < state.filters.dateFrom) return false;
    if (state.filters.dateTo && dateValue > state.filters.dateTo) return false;
    if (state.filters.shopId !== "all" && String(row.shop_id || "") !== String(state.filters.shopId)) return false;
    if (state.filters.status !== "all" && String(row.status || "") !== state.filters.status) return false;
    if (!query) return true;
    const haystack = [
      row.order_ref,
      row.shop_name,
      row.ozon_sku,
      row.product_name,
      row.product_code,
      row.person_name,
      row.note
    ].map((item) => normalizeSearch(item)).join(" ");
    return haystack.includes(query);
  });
});

const pagedRows = computed(() => {
  const start = (state.filters.page - 1) * state.filters.pageSize;
  return filteredRows.value.slice(start, start + state.filters.pageSize);
});

const serverPagedMode = computed(() => state.total > 0 || state.summary.totalRows > 0);
const tableRows = computed(() => state.rows);
const total = computed(() => serverPagedMode.value ? state.total : filteredRows.value.length);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / Math.max(1, state.filters.pageSize))));
const totalOrders = computed(() => state.summary.totalOrders || new Set(filteredRows.value.map((row) => row.order_ref).filter(Boolean)).size);
const cancelledCount = computed(() => state.summary.cancelledCount || filteredRows.value.filter((row) => row.status === "cancelled").length);
const totalQty = computed(() => state.summary.totalQuantity || filteredRows.value.reduce((sum, row) => sum + Number(row.quantity || 0), 0));
const totalAmount = computed(() => state.summary.totalAmount || filteredRows.value.reduce((sum, row) => sum + Number(row.order_amount || 0), 0));

const summaryCards = computed(() => ([
  { label: "出库明细", value: total.value, suffix: "当前筛选结果" },
  { label: "订单数", value: totalOrders.value, suffix: "去重订单" },
  { label: "出库件数", value: totalQty.value, suffix: "累计数量" },
  { label: "取消回退", value: cancelledCount.value, suffix: `订单额 ${money(totalAmount.value)}` }
]));

const filterSummary = computed(() => {
  const parts = [];
  if (state.filters.dateFrom || state.filters.dateTo) {
    parts.push(`${state.filters.dateFrom || "--"} 至 ${state.filters.dateTo || "--"}`);
  }
  if (state.filters.shopId !== "all") {
    const shop = state.shops.find((item) => String(item.id) === String(state.filters.shopId));
    parts.push(shop?.name || "指定店铺");
  } else {
    parts.push("全部店铺");
  }
  if (state.filters.status !== "all") {
    parts.push(statusText(state.filters.status));
  } else {
    parts.push("全部状态");
  }
  if (state.filters.query.trim()) {
    parts.push(`关键词：${state.filters.query.trim()}`);
  }
  return parts.join(" / ");
});

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function todayText() {
  return shanghaiDateKey();
}

function monthStartText() {
  return shanghaiMonthStart();
}

function money(value) {
  return `¥${Number(value || 0).toFixed(2)}`;
}

function numberText(value) {
  return Number(value || 0).toFixed(0);
}

function dateTimeText(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function statusTagType(status) {
  if (status === "cancelled") return "warning";
  if (status === "deducted") return "success";
  return "info";
}

function statusText(status) {
  if (status === "cancelled") return "已回退库存";
  if (status === "deducted") return "已扣库存";
  return status || "-";
}

function reasonText(value) {
  if (value === "order") return "订单出库";
  if (value === "cancelled_order") return "取消订单出库";
  if (value === "unmapped_order") return "待绑定出库";
  return value || "-";
}

function auditText(row) {
  return String(row.note || "")
    .replace(/Created by outbound sync/gi, "Created by Ozon sync")
    .replace(/Updated by outbound sync/gi, "Updated by Ozon sync")
    .replace(/Restored by outbound sync/gi, "Restored by Ozon sync")
    .replace(/Order cancelled.*$/gi, "订单已取消，库存已回退")
    .replace(/Cancelled order outbound/gi, "取消订单出库")
    || reasonText(row.reason);
}

function imageSource(row) {
  return String(row.image_urls || row.product_image_url || "")
    .split(",")
    .map((item) => item.trim())
    .find(Boolean) || "";
}

function handleSearch() {
  state.filters.page = 1;
  loadOutboundRecords();
}

function handleReset() {
  state.filters.dateFrom = monthStartText();
  state.filters.dateTo = todayText();
  state.filters.shopId = "all";
  state.filters.status = "all";
  state.filters.query = "";
  state.filters.page = 1;
  state.filters.pageSize = 20;
  loadOutboundRecords();
}

function handlePageChange(page) {
  state.filters.page = page;
  loadOutboundRecords();
}

function handlePageSizeChange(size) {
  state.filters.pageSize = size;
  state.filters.page = 1;
  loadOutboundRecords();
}

function outboundQueryString() {
  const params = new URLSearchParams({
    paged: "1",
    page: String(state.filters.page),
    pageSize: String(state.filters.pageSize),
    dateFrom: state.filters.dateFrom || "",
    dateTo: state.filters.dateTo || "",
    shopId: state.filters.shopId || "all",
    status: state.filters.status || "all",
    query: state.filters.query.trim()
  });
  return params.toString();
}

function applyOutboundResult(result) {
  const legacyRows = Array.isArray(result) ? result : null;
  const legacyStart = (state.filters.page - 1) * state.filters.pageSize;
  const rows = legacyRows
    ? result.slice(legacyStart, legacyStart + state.filters.pageSize)
    : (Array.isArray(result?.rows) ? result.rows : []);
  state.rows = rows;
  state.total = legacyRows ? result.length : Number(result?.total || 0);
  state.summary = {
    totalRows: legacyRows ? result.length : Number(result?.summary?.totalRows || 0),
    totalOrders: legacyRows ? 0 : Number(result?.summary?.totalOrders || 0),
    totalQuantity: legacyRows ? 0 : Number(result?.summary?.totalQuantity || 0),
    totalAmount: legacyRows ? 0 : Number(result?.summary?.totalAmount || 0),
    cancelledCount: legacyRows ? 0 : Number(result?.summary?.cancelledCount || 0)
  };
}

async function loadOutboundRecords() {
  loading.value = true;
  try {
    applyOutboundResult(await apiClient.get(`/api/outbound-records?${outboundQueryString()}`));
  } catch (error) {
    ElMessage.error(error.message || "鍑哄簱娴佹按鍔犺浇澶辫触");
  } finally {
    loading.value = false;
  }
}

async function loadPageData() {
  loading.value = true;
  try {
    const [result, shops] = await Promise.all([
      apiClient.get(`/api/outbound-records?${outboundQueryString()}`),
      apiClient.get("/api/shops")
    ]);
    applyOutboundResult(result);
    state.shops = Array.isArray(shops) ? shops : [];
  } catch (error) {
    ElMessage.error(error.message || "出库流水加载失败");
  } finally {
    loading.value = false;
  }
}

onMounted(loadPageData);
</script>

<template>
  <div class="page-stack outbound-page">
    <section v-if="false" class="page-hero outbound-hero">
      <div>
        <h2>出库流水</h2>
      </div>
      <div class="page-card-actions">
        <el-button class="erp-btn erp-btn-secondary" @click="loadPageData">刷新数据</el-button>
      </div>
    </section>

    <div class="outbound-table-section">
      <el-card shadow="never" class="page-card outbound-card">
        <template #header v-if="false">
          <div class="page-card-header">
            <div>
              <strong>出库流水</strong>
              <span>左侧是筛选和表格，右侧统计与当前筛选条件实时同步。</span>
            </div>
          </div>
        </template>

        <div class="filter-panel outbound-filter-panel">
          <el-form inline>
            <el-form-item label="开始日期">
              <el-date-picker
                v-model="state.filters.dateFrom"
                type="date"
                value-format="YYYY-MM-DD"
                placeholder="开始日期"
                style="width: 160px"
              />
            </el-form-item>
            <el-form-item label="结束日期">
              <el-date-picker
                v-model="state.filters.dateTo"
                type="date"
                value-format="YYYY-MM-DD"
                placeholder="结束日期"
                style="width: 160px"
              />
            </el-form-item>
            <el-form-item label="店铺">
              <el-select v-model="state.filters.shopId" style="width: 180px">
                <el-option label="全部店铺" value="all" />
                <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
              </el-select>
            </el-form-item>
            <el-form-item label="状态">
              <el-select v-model="state.filters.status" style="width: 160px" @change="handleSearch">
                <el-option label="全部状态" value="all" />
                <el-option label="已扣库存" value="deducted" />
                <el-option label="已回退库存" value="cancelled" />
              </el-select>
            </el-form-item>
            <el-form-item label="关键词">
              <el-input
                v-model="state.filters.query"
                placeholder="订单号 / SKU / 商品名称 / 产品编码"
                clearable
                style="width: 320px"
                @keyup.enter="handleSearch"
              />
            </el-form-item>
            <el-form-item>
              <el-button class="erp-btn erp-btn-primary" type="primary" @click="handleSearch">查询</el-button>
              <el-button class="erp-btn erp-btn-secondary" @click="handleReset">重置</el-button>
            </el-form-item>
          </el-form>
        </div>

        <div class="list-wrap">
          <el-table v-loading="loading" :data="tableRows" height="100%" stripe border class="erp-data-table">
            <el-table-column label="出库时间" width="170" fixed="left">
              <template #default="{ row }">{{ dateTimeText(row.outbound_time || row.created_at) }}</template>
            </el-table-column>

            <el-table-column label="订单信息" min-width="220">
              <template #default="{ row }">
                <div class="outbound-info-block">
                  <strong>{{ row.order_ref || "-" }}</strong>
                  <span>{{ row.shop_name || "未记录店铺" }}</span>
                </div>
              </template>
            </el-table-column>

            <el-table-column label="订单详情" min-width="280">
              <template #default="{ row }">
                <div class="erp-product-media-cell">
                  <div class="erp-product-thumb-wrap">
                    <ProductImagePreview :src="imageSource(row)" :alt="row.product_name || row.ozon_sku || '商品图片'" />
                  </div>
                  <div class="erp-product-copy outbound-info-block">
                    <strong>{{ row.ozon_sku || "-" }}</strong>
                    <span>{{ row.product_name || "-" }}</span>
                  </div>
                </div>
              </template>
            </el-table-column>

            <el-table-column label="订单金额" width="120" align="right">
              <template #default="{ row }">{{ money(row.order_amount) }}</template>
            </el-table-column>

            <el-table-column label="数量" width="90" align="center">
              <template #default="{ row }">
                <el-tag :type="Number(row.quantity || 0) > 1 ? 'primary' : 'info'">{{ numberText(row.quantity) }}</el-tag>
              </template>
            </el-table-column>

            <el-table-column label="库存产品" min-width="280">
              <template #default="{ row }">
                <div class="erp-product-media-cell">
                  <div class="erp-product-thumb-wrap">
                    <ProductImagePreview :src="row.product_image_url" :alt="row.product_name || row.product_code || '商品图片'" />
                  </div>
                  <div class="erp-product-copy outbound-info-block">
                    <strong>{{ row.product_code || "-" }}</strong>
                    <span>{{ row.product_name || "-" }}</span>
                  </div>
                </div>
              </template>
            </el-table-column>

            <el-table-column label="状态" width="120" align="center">
              <template #default="{ row }">
                <el-tag :type="statusTagType(row.status)">{{ statusText(row.status) }}</el-tag>
              </template>
            </el-table-column>

            <el-table-column label="原因" width="140" align="center">
              <template #default="{ row }">{{ reasonText(row.reason) }}</template>
            </el-table-column>

            <el-table-column label="流水审计" min-width="260">
              <template #default="{ row }">
                <div class="outbound-info-block outbound-audit-block">
                  <strong>{{ row.order_item_id ? `明细 #${row.order_item_id}` : "无明细 ID" }}</strong>
                  <span>{{ row.person_name ? `负责人：${row.person_name}` : "负责人未记录" }}</span>
                  <span>{{ auditText(row) }}</span>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </el-card>

      <aside v-if="false" class="outbound-side-panel">
        <el-card shadow="never" class="outbound-summary-card">
          <template #header v-if="false">
            <div class="page-card-header">
              <div>
                <strong>统计信息</strong>
                <span>{{ filterSummary }}</span>
              </div>
            </div>
          </template>

          <div class="outbound-summary-grid">
            <div v-for="card in summaryCards" :key="card.label" class="outbound-summary-item">
              <span class="metric-label">{{ card.label }}</span>
              <strong class="metric-value">{{ card.value }}</strong>
              <span class="metric-suffix">{{ card.suffix }}</span>
            </div>
          </div>
        </el-card>
      </aside>
      <div class="outbound-page-footer">
        <PageFooterPagination
          class="outbound-footer"
          :total="total"
          :page="state.filters.page"
          :page-size="state.filters.pageSize"
          :total-pages="totalPages"
          @update:page="handlePageChange"
          @update:pageSize="handlePageSizeChange"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.outbound-page {
  min-height: 100%;
  height: 100%;
  max-width: 100%;
  overflow: hidden;
  gap: 8px;
}

.outbound-hero,
.outbound-card :deep(.el-card__header),
.outbound-summary-card :deep(.el-card__header) {
  display: none;
}

.outbound-page-footer {
  flex: none;
  margin-top: 0;
}

.outbound-hero {
  align-items: center;
}

.outbound-hero :deep(h2) {
  margin-bottom: 0;
}

.outbound-table-section {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  gap: 2px;
}

.outbound-card {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  flex: 1 1 auto;
  padding: 0;
}

.outbound-card :deep(.el-card__body) {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  padding: 0;
}

.outbound-filter-panel {
  margin-bottom: 0;
  flex: none;
}

.outbound-side-panel {
  display: none;
}

.outbound-summary-card {
  height: 100%;
  border: 1px solid rgba(203, 213, 225, 0.8);
  border-radius: 12px;
  box-shadow: none;
}

.outbound-summary-card :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.outbound-summary-grid {
  display: grid;
  gap: 10px;
}

.outbound-summary-item {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--erp-border);
  border-radius: 14px;
  background: linear-gradient(180deg, #fbfdff 0%, #f6f9fd 100%);
}

.outbound-summary-item .metric-value {
  font-size: 28px;
}

.outbound-footer {
  margin: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  padding: 0;
  min-height: 28px;
}

.outbound-footer :deep(.erp-footer-pagination__meta) {
  color: #46556c;
  font-size: 11px;
  line-height: 24px;
}

.outbound-footer :deep(.erp-footer-pagination__actions) {
  gap: 6px;
}

.outbound-footer :deep(.el-pagination) {
  --el-pagination-bg-color: transparent;
  --el-pagination-button-bg-color: #f8fafc;
  --el-pagination-button-disabled-bg-color: #f1f5f9;
  --el-pagination-hover-color: #2563eb;
  --el-pagination-button-color: #334155;
  --el-pagination-button-width: 26px;
  --el-pagination-button-height: 26px;
  font-weight: 500;
  font-size: 11px;
}

.outbound-footer :deep(.el-pagination button),
.outbound-footer :deep(.el-pagination .el-pager li) {
  min-width: 26px;
  height: 26px;
  border: 1px solid rgba(203, 213, 225, 0.85);
  border-radius: 6px;
  background: #f8fafc;
  box-shadow: none;
}

.outbound-footer :deep(.el-pagination .el-pager li.is-active) {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
  box-shadow: 0 8px 18px rgba(37, 99, 235, 0.22);
}

.outbound-footer :deep(.erp-page-size) {
  gap: 4px;
  font-size: 11px;
}

.outbound-footer :deep(.erp-page-size__select) {
  width: 84px;
}

.outbound-footer :deep(.erp-page-size__select .el-select__wrapper) {
  min-height: 26px;
}

.list-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  border-bottom: 1px solid rgba(226, 232, 240, 0.9);
}

.list-wrap :deep(.el-table),
.list-wrap :deep(.el-table__inner-wrapper),
.list-wrap :deep(.el-table__body-wrapper) {
  height: 100%;
}

.outbound-info-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.outbound-info-block strong,
.outbound-info-block span {
  white-space: normal;
  word-break: break-word;
}

.outbound-info-block span {
  color: var(--erp-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.outbound-audit-block {
  gap: 2px;
}

@media (max-width: 1320px) {
  .outbound-table-section {
    grid-template-columns: 1fr;
  }

  .outbound-side-panel {
    order: -1;
  }

  .outbound-summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 900px) {
  .outbound-hero {
    align-items: flex-start;
  }

  .outbound-summary-grid {
    grid-template-columns: 1fr;
  }
}
</style>
