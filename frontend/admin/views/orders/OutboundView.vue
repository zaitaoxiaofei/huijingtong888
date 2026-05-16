<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { apiClient } from "../../utils/api";
import PageFooterPagination from "../../components/PageFooterPagination.vue";

const loading = ref(false);

const state = reactive({
  rows: [],
  shops: [],
  filters: {
    dateFrom: monthStartText(),
    dateTo: todayText(),
    shopId: "all",
    query: "",
    page: 1,
    pageSize: 30
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

const total = computed(() => filteredRows.value.length);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / Math.max(1, state.filters.pageSize))));
const totalOrders = computed(() => new Set(filteredRows.value.map((row) => row.order_ref).filter(Boolean)).size);
const cancelledCount = computed(() => filteredRows.value.filter((row) => row.status === "cancelled").length);
const totalQty = computed(() => filteredRows.value.reduce((sum, row) => sum + Number(row.quantity || 0), 0));
const totalAmount = computed(() => filteredRows.value.reduce((sum, row) => sum + Number(row.order_amount || 0), 0));

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
  if (state.filters.query.trim()) {
    parts.push(`关键词：${state.filters.query.trim()}`);
  }
  return parts.join(" / ");
});

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function todayText() {
  return new Date().toISOString().slice(0, 10);
}

function monthStartText() {
  const date = new Date();
  date.setDate(1);
  return date.toISOString().slice(0, 10);
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
}

function handleReset() {
  state.filters.dateFrom = monthStartText();
  state.filters.dateTo = todayText();
  state.filters.shopId = "all";
  state.filters.query = "";
  state.filters.page = 1;
  state.filters.pageSize = 30;
}

function handlePageChange(page) {
  state.filters.page = page;
}

function handlePageSizeChange(size) {
  state.filters.pageSize = size;
  state.filters.page = 1;
}

async function loadPageData() {
  loading.value = true;
  try {
    const [rows, shops] = await Promise.all([
      apiClient.get("/api/outbound-records"),
      apiClient.get("/api/shops")
    ]);
    state.rows = Array.isArray(rows) ? rows : [];
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
    <section class="page-hero outbound-hero">
      <div>
        <h2>出库流水</h2>
      </div>
      <div class="page-card-actions">
        <el-button @click="loadPageData">刷新数据</el-button>
      </div>
    </section>

    <div class="outbound-layout">
      <el-card shadow="never" class="page-card outbound-card">
        <template #header>
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
              <el-button type="primary" @click="handleSearch">查询</el-button>
              <el-button @click="handleReset">重置</el-button>
            </el-form-item>
          </el-form>
        </div>

        <div class="list-wrap">
          <el-table v-loading="loading" :data="pagedRows" stripe border class="erp-data-table">
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
                <div class="outbound-detail-cell">
                  <el-image
                    v-if="imageSource(row)"
                    :src="imageSource(row)"
                    fit="cover"
                    class="outbound-thumb"
                    preview-teleported
                    :preview-src-list="[imageSource(row)]"
                  />
                  <div class="outbound-info-block">
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
                <div class="outbound-detail-cell">
                  <el-image
                    v-if="row.product_image_url"
                    :src="row.product_image_url"
                    fit="cover"
                    class="outbound-thumb"
                    preview-teleported
                    :preview-src-list="[row.product_image_url]"
                  />
                  <div class="outbound-info-block">
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

      <aside class="outbound-side-panel">
        <el-card shadow="never" class="outbound-summary-card">
          <template #header>
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
    </div>

    <div class="outbound-page-footer">
      <PageFooterPagination
        class="outbound-footer"
        :total="total"
        :page="state.filters.page"
        :page-size="state.filters.pageSize"
        :total-pages="totalPages"
        :page-sizes="[30, 100, 1000, 10000]"
        @update:page="handlePageChange"
        @update:pageSize="handlePageSizeChange"
      />
    </div>
  </div>
</template>

<style scoped>
.outbound-page {
  min-height: 100%;
  height: 100%;
  overflow: hidden;
}

.outbound-page-footer {
  flex: none;
  margin-top: 8px;
}

.outbound-hero {
  align-items: center;
}

.outbound-hero :deep(h2) {
  margin-bottom: 0;
}

.outbound-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
}

.outbound-card {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.outbound-card :deep(.el-card__body) {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.outbound-filter-panel {
  margin-bottom: 0;
  flex: none;
}

.outbound-side-panel {
  min-height: 0;
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
  border: 1px solid rgba(203, 213, 225, 0.8);
  border-radius: 12px;
  background: #fff;
  box-shadow: none;
  padding: 10px 14px;
}

.list-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.outbound-detail-cell {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.outbound-thumb {
  width: 52px;
  height: 52px;
  flex: none;
  border-radius: 10px;
  border: 1px solid var(--erp-border);
  background: #f8fafc;
  overflow: hidden;
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
  .outbound-layout {
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
