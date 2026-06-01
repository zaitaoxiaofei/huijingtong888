<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import { createLatestRequestGate } from "../../utils/request-gate";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";

const loading = ref(false);
const detailVisible = ref(false);
const cancelling = ref(false);
const listRequestGate = createLatestRequestGate();

const state = reactive({
  rows: [],
  total: 0,
  filters: {
    query: "",
    page: 1,
    pageSize: 20
  }
});

const detail = reactive({
  order: null,
  items: [],
  requests: []
});

const total = computed(() => state.total);

function money(value) {
  return Number(value || 0).toFixed(2);
}

function numberText(value) {
  return Number(value || 0).toFixed(0);
}

function dateText(value) {
  return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true });
}

function splitTextList(value) {
  return String(value || "").split("||").map((item) => item.trim()).filter(Boolean);
}

function productRows(row) {
  const names = splitTextList(row.product_names);
  const codes = splitTextList(row.product_codes);
  const images = String(row.product_image_urls || "").split("||").map((item) => item.trim());
  const skus = String(row.mapped_skus || "").split("||").map((item) => item.trim());
  const length = Math.max(names.length, codes.length, images.length, skus.length, 1);
  return Array.from({ length }, (_, index) => ({
    name: names[index] || "-",
    code: codes[index] || "-",
    image: images[index] || "",
    skus: skus[index] || ""
  }));
}

function primaryProduct(row) {
  return productRows(row)[0] || { name: "-", code: "-", image: "", skus: "" };
}

function extraProductCount(row) {
  return Math.max(0, productRows(row).length - 1);
}

function statusTagType(status) {
  const value = String(status || "").toLowerCase();
  if (value.includes("cancel")) return "danger";
  if (value.includes("done") || value.includes("purchased")) return "success";
  if (value.includes("pending")) return "warning";
  return "info";
}

function statusText(status) {
  const value = String(status || "");
  if (value === "pending_purchase") return "待采购";
  if (value === "purchased") return "已采购";
  if (value === "partial_inbound") return "部分入库";
  if (value === "inbound_done") return "已完成入库";
  if (value === "cancelled") return "已取消";
  return value || "-";
}

function handleSearch() {
  state.filters.page = 1;
  loadPageData();
}

function handleReset() {
  state.filters.query = "";
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

function purchaseOrdersQueryString() {
  const params = new URLSearchParams({
    paged: "1",
    page: String(state.filters.page),
    pageSize: String(state.filters.pageSize),
    query: String(state.filters.query || "").trim()
  });
  return params.toString();
}

async function loadPageData() {
  const requestToken = listRequestGate.next();
  loading.value = true;
  try {
    const result = await apiClient.get(`/api/procurement/purchase-orders?${purchaseOrdersQueryString()}`);
    if (!listRequestGate.isLatest(requestToken)) return;
    state.rows = Array.isArray(result?.rows) ? result.rows : [];
    state.total = Number(result?.total || 0);
  } catch (error) {
    if (!listRequestGate.isLatest(requestToken)) return;
    ElMessage.error(error.message || "加载采购历史失败");
  } finally {
    if (listRequestGate.isLatest(requestToken)) loading.value = false;
  }
}

async function openDetail(row) {
  loading.value = true;
  try {
    const result = await apiClient.get(`/api/procurement/purchase-orders/${row.id}`);
    detail.order = result.order || null;
    detail.items = Array.isArray(result.items) ? result.items : [];
    detail.requests = Array.isArray(result.requests) ? result.requests : [];
    detailVisible.value = true;
  } catch (error) {
    ElMessage.error(error.message || "加载采购单详情失败");
  } finally {
    loading.value = false;
  }
}

function closeDetail() {
  detail.order = null;
  detail.items = [];
  detail.requests = [];
}

async function cancelOrder() {
  if (!detail.order?.id) return;

  try {
    await ElMessageBox.confirm(
      `确认取消采购单“${detail.order.order_no || detail.order.id}”吗？`,
      "取消采购单",
      { type: "warning", confirmButtonText: "确认取消", cancelButtonText: "关闭" }
    );
    cancelling.value = true;
    await apiClient.post(`/api/procurement/purchase-orders/${detail.order.id}/cancel`, {});
    ElMessage.success("采购单已取消");
    detailVisible.value = false;
    closeDetail();
    await loadPageData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "取消采购单失败");
  } finally {
    cancelling.value = false;
  }
}

onMounted(loadPageData);
</script>

<template>
  <div class="page-stack procurement-history-page procurement-workspace-page">
    <section class="page-hero">
      <div class="procurement-hero-copy">
        <h2>采购历史</h2>
      </div>
      <div class="page-card-actions">
        <el-button class="erp-btn erp-btn-secondary" @click="loadPageData">刷新数据</el-button>
      </div>
    </section>

    <el-card shadow="never" class="page-card procurement-history-card procurement-workspace-card">
      <div class="procurement-toolbar procurement-toolbar-sticky procurement-filter-panel procurement-workspace-filter">
        <el-form inline>
          <el-form-item label="关键词">
            <el-input
              v-model="state.filters.query"
              placeholder="采购单号 / 创建人 / 商品名称"
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
        <el-table v-loading="loading" :data="state.rows" height="100%" stripe border class="erp-data-table procurement-history-table">
          <el-table-column label="产品信息" min-width="420" fixed="left">
            <template #default="{ row }">
              <div class="product-cell">
                <ProductImagePreview
                  :src="primaryProduct(row).image"
                  :preview-list="productRows(row).map((item) => item.image).filter(Boolean)"
                />
                <div class="product-cell-meta">
                  <strong>{{ primaryProduct(row).name }}</strong>
                  <span>编码：{{ primaryProduct(row).code }}</span>
                  <span>SKU：{{ primaryProduct(row).skus || "未绑定 SKU" }}</span>
                  <span>采购单号：{{ row.order_no || "-" }}</span>
                  <el-tag v-if="extraProductCount(row)" size="small" type="info">另有 {{ extraProductCount(row) }} 个产品</el-tag>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="creator_name" label="创建人" width="120" />
          <el-table-column label="商品数" width="100" align="center">
            <template #default="{ row }">{{ numberText(row.item_count) }}</template>
          </el-table-column>
          <el-table-column label="总数量" width="100" align="center">
            <template #default="{ row }">{{ numberText(row.total_quantity) }}</template>
          </el-table-column>
          <el-table-column label="总金额" width="130" align="right">
            <template #default="{ row }">¥{{ money(row.total_amount) }}</template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="120" align="center">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)">{{ statusText(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="created_at" label="创建时间" width="180">
            <template #default="{ row }">{{ dateText(row.created_at) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="130" fixed="right" align="center">
            <template #default="{ row }">
              <el-button class="erp-btn-link" link type="primary" @click="openDetail(row)">查看详情</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <PageFooterPagination
        class="procurement-footer procurement-workspace-footer"
        :total="total"
        :page="state.filters.page"
        :page-size="state.filters.pageSize"
        :page-sizes="[20, 50, 100]"
        @update:page="handlePageChange"
        @update:pageSize="handlePageSizeChange"
      />
    </el-card>

    <el-dialog
      v-model="detailVisible"
      title="采购单详情"
      width="1120px"
      align-center
      class="erp-centered-dialog"
      destroy-on-close
      @closed="closeDetail"
    >
      <div v-if="detail.order" class="page-stack">
        <div class="detail-summary">
          <div class="summary-card">
            <span class="muted-text">采购单号</span>
            <strong>{{ detail.order.order_no || "-" }}</strong>
          </div>
          <div class="summary-card">
            <span class="muted-text">状态</span>
            <strong>{{ statusText(detail.order.status) }}</strong>
          </div>
          <div class="summary-card">
            <span class="muted-text">总数量</span>
            <strong>{{ numberText(detail.order.total_quantity) }}</strong>
          </div>
          <div class="summary-card">
            <span class="muted-text">总金额</span>
            <strong>¥{{ money(detail.order.total_amount) }}</strong>
          </div>
        </div>

        <section class="detail-section">
          <el-table :data="detail.items" stripe border class="erp-data-table">
            <el-table-column prop="product_code" label="商品编码" width="160" />
            <el-table-column prop="product_name" label="商品名称" min-width="240" />
            <el-table-column label="请求数量" width="100" align="center">
              <template #default="{ row }">{{ numberText(row.requested_quantity) }}</template>
            </el-table-column>
            <el-table-column label="实际数量" width="100" align="center">
              <template #default="{ row }">{{ numberText(row.actual_quantity) }}</template>
            </el-table-column>
            <el-table-column label="货款" width="120" align="right">
              <template #default="{ row }">¥{{ money(row.amount) }}</template>
            </el-table-column>
            <el-table-column label="运费" width="120" align="right">
              <template #default="{ row }">¥{{ money(row.shipping_amount) }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="120" align="center">
              <template #default="{ row }">{{ statusText(row.status) }}</template>
            </el-table-column>
          </el-table>
        </section>
      </div>

      <template #footer>
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="detailVisible = false">关闭</el-button>
          <el-button class="erp-btn erp-btn-danger" type="danger" :loading="cancelling" @click="cancelOrder">取消采购单</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.procurement-history-page {
  min-height: 100%;
}

.procurement-hero-copy {
  display: grid;
  gap: 8px;
}

.procurement-history-card {
  border: 1px solid rgba(198, 209, 225, 0.85);
  background:
    radial-gradient(circle at top right, rgba(37, 99, 235, 0.08), transparent 24%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 250, 252, 0.98));
}

.procurement-toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
}

.procurement-toolbar-sticky {
  position: sticky;
  top: 0;
  z-index: 3;
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(14px);
}

.procurement-filter-panel {
  margin-bottom: 0;
  padding: 14px 16px;
  border: 1px solid rgba(219, 227, 239, 0.9);
  border-radius: 18px;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);
}

.procurement-history-table {
  min-width: 1320px;
}

.procurement-footer {
  margin-top: auto;
}

.product-cell {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.product-cell-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.product-cell-meta strong {
  line-height: 1.35;
}

.product-cell-meta span {
  color: var(--erp-text-secondary);
  font-size: 12px;
  line-height: 1.45;
  word-break: break-all;
}

.detail-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.summary-card {
  display: grid;
  gap: 4px;
  padding: 16px;
  border: 1px solid rgba(191, 219, 254, 0.9);
  border-radius: 18px;
  background:
    radial-gradient(circle at top right, rgba(37, 99, 235, 0.12), transparent 28%),
    linear-gradient(180deg, rgba(239, 246, 255, 0.88), rgba(248, 250, 252, 0.98));
  box-shadow: 0 12px 28px rgba(37, 99, 235, 0.08);
}

.summary-card strong {
  font-size: 15px;
}

.detail-section {
  display: grid;
  gap: 10px;
}

.muted-text {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

@media (max-width: 1360px) {
  .detail-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 960px) {
  .procurement-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .detail-summary {
    grid-template-columns: 1fr;
  }
}
</style>
