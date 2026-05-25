<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import { createLatestRequestGate } from "../../utils/request-gate";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";

const route = useRoute();
const router = useRouter();
let syncingRoute = false;
const listRequestGate = createLatestRequestGate();

const loading = ref(false);
const confirming = ref(false);
const confirmingInbound = ref(false);
const detailVisible = ref(false);
const detailSaving = ref(false);

const state = reactive({
  rows: [],
  inboundRows: [],
  total: 0,
  filters: {
    query: "",
    page: 1,
    pageSize: 20
  },
  selectedProductIds: []
});

const detailDialog = reactive({
  productId: null,
  productName: "",
  rows: []
});

const pendingInboundRows = computed(() => state.inboundRows.map((row) => ({
    ...row,
    row_type: "inbound",
    row_key: `inbound-${row.inbound_record_id}`,
    total_quantity: Number(row.expected_quantity || row.remaining_quantity || row.actual_quantity || 0),
    total_amount: Number(row.amount || 0),
    total_shipping: Number(row.shipping_amount || 0),
    request_count: 1,
    earliest_created_at: row.order_created_at || row.inbound_created_at || row.purchased_at || "",
    requests: []
  })));
const tableRows = computed(() => [
  ...pendingInboundRows.value,
  ...state.rows.map((row) => ({ ...row, row_type: "purchase", row_key: `purchase-${row.product_id}` }))
]);
const selectedRows = computed(() => tableRows.value.filter((row) => row.row_type === "purchase" && state.selectedProductIds.includes(Number(row.product_id))));
const totalRows = computed(() => Number(state.total || 0) + state.inboundRows.length);

function money(value) {
  return Number(value || 0).toFixed(2);
}

function numberText(value) {
  return Number(value || 0).toFixed(0);
}

function dateText(value) {
  return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true });
}

function productImage(row) {
  return row?.product_image_url || row?.image_url || "";
}

function arrayText(value) {
  return Array.isArray(value) ? value.filter(Boolean).join("、") : String(value || "");
}

function sourceLabel(source) {
  const value = String(source || "").toLowerCase();
  if (value === "1688") return "1688";
  if (value === "pdd") return "拼多多";
  if (value === "supplier") return "供应商";
  if (value === "wechat") return "微信";
  return source || "其他";
}

function requestSourceSummary(row) {
  if (row.row_type === "inbound") return row.order_no || row.purchase_order_no || "采购单";
  const sources = (row.requests || []).map((item) => sourceLabel(item.source_type || item.product_source_platform));
  return Array.from(new Set(sources)).join(" / ") || "-";
}

function averageUnitCost(row) {
  const quantity = Number(row.total_quantity || 0);
  if (!quantity) return "0.00";
  return money((Number(row.total_amount || 0) + Number(row.total_shipping || 0)) / quantity);
}

function asPositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function procurementQueryString() {
  const params = new URLSearchParams({
    grouped: "1",
    paged: "1",
    page: String(state.filters.page),
    pageSize: String(state.filters.pageSize)
  });
  const query = String(state.filters.query || "").trim();
  if (query) params.set("query", query);
  return params.toString();
}

async function loadPageData() {
  const requestToken = listRequestGate.next();
  loading.value = true;
  try {
    const [result, inboundRows] = await Promise.all([
      apiClient.get(`/api/procurement/requests?${procurementQueryString()}`),
      apiClient.get("/api/procurement/pending-inbound")
    ]);
    if (!listRequestGate.isLatest(requestToken)) return;
    state.rows = Array.isArray(result?.rows) ? result.rows : [];
    state.inboundRows = Array.isArray(inboundRows) ? inboundRows : [];
    state.total = Number(result?.total || 0);
    state.selectedProductIds = state.selectedProductIds.filter((id) => state.rows.some((row) => Number(row.product_id) === id));
  } catch (error) {
    if (!listRequestGate.isLatest(requestToken)) return;
    ElMessage.error(error.message || "采购清单加载失败");
  } finally {
    if (listRequestGate.isLatest(requestToken)) loading.value = false;
  }
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

function applyRouteState() {
  syncingRoute = true;
  try {
    const query = String(route.query.query || "");
    const productId = String(route.query.productId || "").trim();
    state.filters.query = query || productId;
    state.filters.page = asPositiveInt(route.query.page, 1);
    state.filters.pageSize = asPositiveInt(route.query.pageSize, 20);
  } finally {
    syncingRoute = false;
  }
}

function syncRouteQuery() {
  if (syncingRoute) return;
  const nextQuery = {
    query: state.filters.query || undefined,
    page: state.filters.page > 1 ? String(state.filters.page) : undefined,
    pageSize: state.filters.pageSize !== 20 ? String(state.filters.pageSize) : undefined
  };
  const normalizedNext = Object.fromEntries(Object.entries(nextQuery).filter(([, value]) => value != null && value !== ""));
  if (JSON.stringify(route.query || {}) === JSON.stringify(normalizedNext)) return;
  router.replace({ query: normalizedNext });
}

function handleSelectionChange(rows) {
  state.selectedProductIds = rows.filter((row) => row.row_type === "purchase").map((row) => Number(row.product_id));
}

function canSelectRow(row) {
  return row.row_type === "purchase";
}

function rowStatusText(row) {
  return row.row_type === "inbound" ? "待入库" : (row.overdue ? "超期" : "待采购");
}

function rowStatusType(row) {
  if (row.row_type === "inbound") return "warning";
  return row.overdue ? "danger" : "info";
}

function rowClassName({ row }) {
  return row.row_type === "inbound" ? "inbound-ready-row" : "";
}

function flowTimes(row) {
  return [
    { label: "创建", value: row.row_type === "inbound" ? row.order_created_at || row.earliest_created_at : row.earliest_created_at },
    { label: "采购", value: row.row_type === "inbound" ? row.purchased_at : "" },
    { label: "入库", value: row.inbound_approved_at || row.approved_at || "" }
  ];
}

function actionDisabled(row, action) {
  if (action === "edit") return row.row_type !== "purchase";
  if (action === "purchase") return row.row_type !== "purchase";
  if (action === "inbound") return row.row_type !== "inbound";
  return false;
}

function handleEditAction(row) {
  if (actionDisabled(row, "edit")) return;
  openEditDialog(row);
}

function handlePurchaseAction(row) {
  if (actionDisabled(row, "purchase")) return;
  confirmRow(row);
}

function handleInboundAction(row) {
  if (actionDisabled(row, "inbound")) return;
  confirmInbound(row);
}

function openEditDialog(row) {
  detailDialog.productId = Number(row.product_id);
  detailDialog.productName = row.product_name || row.product_code || "";
  detailDialog.rows = (row.requests || []).map((item) => ({
    id: Number(item.id),
    product_id: Number(item.product_id || 0) || null,
    person_id: Number(item.person_id || 0) || null,
    person_name: item.person_name || "",
    quantity: Number(item.quantity || 0),
    amount: Number(item.amount || 0),
    shipping_amount: Number(item.shipping_amount || 0),
    urgency: item.urgency || "normal",
    source_type: item.source_type || "1688",
    supplier_id: item.supplier_id || null,
    purchase_url: item.purchase_url || "",
    note: item.note || "",
    created_at: item.created_at || ""
  }));
  detailVisible.value = true;
}

function resetDetailDialog() {
  detailDialog.productId = null;
  detailDialog.productName = "";
  detailDialog.rows = [];
}

async function recalculateProductProfits(productIds = []) {
  const ids = [...new Set(productIds.map((item) => Number(item || 0)).filter(Boolean))];
  for (const productId of ids) {
    await apiClient.post(`/api/products/${productId}/recalculate-profits`, {});
  }
  return ids.length;
}

async function saveDetailRows() {
  if (!detailDialog.rows.length) return;

  detailSaving.value = true;
  try {
    for (const row of detailDialog.rows) {
      await apiClient.put(`/api/procurement/requests/${row.id}`, {
        product_id: row.product_id,
        person_id: row.person_id,
        quantity: Number(row.quantity || 0),
        amount: Number(row.amount || 0),
        shipping_amount: Number(row.shipping_amount || 0),
        urgency: row.urgency || "normal",
        source_type: row.source_type || "1688",
        supplier_id: row.supplier_id || null,
        purchase_url: row.purchase_url || "",
        note: row.note || ""
      });
    }
    await recalculateProductProfits(detailDialog.rows.map((row) => row.product_id));
    ElMessage.success("采购明细已更新");
    detailVisible.value = false;
    resetDetailDialog();
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "保存采购明细失败");
  } finally {
    detailSaving.value = false;
  }
}

async function confirmRequests(requestIds, label) {
  if (!requestIds.length) return;

  try {
    await ElMessageBox.confirm(`确认采购${label}吗？确认后会生成采购单并进入待入库。`, "确认采购", {
      type: "warning",
      confirmButtonText: "确认采购",
      cancelButtonText: "取消"
    });

    confirming.value = true;
    const result = await apiClient.post("/api/procurement/purchase-orders", { request_ids: requestIds });
    if (result?.id) {
      await apiClient.post(`/api/procurement/purchase-orders/${result.id}/confirm-purchased`, {});
    }
    ElMessage.success("已确认采购，并生成待入库记录");
    state.selectedProductIds = [];
    await loadPageData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "确认采购失败");
  } finally {
    confirming.value = false;
  }
}

async function confirmRow(row) {
  const requestIds = (row.requests || []).map((item) => Number(item.id)).filter(Boolean);
  await confirmRequests(requestIds, `产品“${row.product_name || row.product_code || row.product_id}”`);
}

async function confirmSelected() {
  const requestIds = selectedRows.value.flatMap((row) => (row.requests || []).map((item) => Number(item.id))).filter(Boolean);
  await confirmRequests(requestIds, `选中的 ${selectedRows.value.length} 种产品`);
}

async function confirmAll() {
  const requestIds = state.rows.flatMap((row) => (row.requests || []).map((item) => Number(item.id))).filter(Boolean);
  await confirmRequests(requestIds, `当前页中的 ${state.rows.length} 种产品`);
}

function inboundPayload(row) {
  return {
    product_id: Number(row.product_id || 0) || null,
    quantity: Number(row.expected_quantity || row.remaining_quantity || row.actual_quantity || 0),
    amount: Number(row.amount || 0),
    shipping_amount: Number(row.shipping_amount || 0),
    purchase_url: row.purchase_url || "",
    status: "approved",
    note: row.inbound_note || "",
    qc_status: row.qc_status || "approved"
  };
}

async function confirmInboundRows(rows, label) {
  const targetRows = rows.filter((row) => Number(row.inbound_record_id || 0));
  if (!targetRows.length) return;
  try {
    await ElMessageBox.confirm(
      `确认${label}已入库吗？确认后会增加库存。`,
      "确认入库",
      { type: "warning", confirmButtonText: "确认入库", cancelButtonText: "取消" }
    );
    confirmingInbound.value = true;
    for (const row of targetRows) {
      await apiClient.put(`/api/inbound-records/${row.inbound_record_id}`, inboundPayload(row));
    }
    ElMessage.success(targetRows.length > 1 ? `已确认 ${targetRows.length} 条入库，库存已更新，并进入采购历史` : "已确认入库，库存已更新，并进入采购历史");
    await loadPageData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "确认入库失败");
  } finally {
    confirmingInbound.value = false;
  }
}

async function confirmInbound(row) {
  await confirmInboundRows([row], `产品“${row.product_name || row.product_code || row.product_id}”`);
}

async function confirmAllInbound() {
  await confirmInboundRows(pendingInboundRows.value, `全部 ${pendingInboundRows.value.length} 个待入库产品`);
}

watch(() => route.query, applyRouteState, { deep: true });
watch(() => [state.filters.query, state.filters.page, state.filters.pageSize], syncRouteQuery);

onMounted(async () => {
  applyRouteState();
  await loadPageData();
});
</script>

<template>
  <div class="page-stack procurement-list-page procurement-workspace-page">
    <section class="page-hero">
      <div>
        <h2>采购清单</h2>
        <p>按产品合并待采购请求，当前页面已切换为后端分页。</p>
      </div>
      <div class="page-card-actions">
        <el-button @click="loadPageData">刷新数据</el-button>
        <el-button type="primary" :disabled="!selectedRows.length" :loading="confirming" @click="confirmSelected">
          确认采购所选
        </el-button>
        <el-button type="success" :disabled="!pendingInboundRows.length" :loading="confirmingInbound" @click="confirmAllInbound">
          确认入库全部
        </el-button>
      </div>
    </section>

    <el-card shadow="never" class="page-card procurement-list-card procurement-workspace-card">
      <template #header>
        <div class="page-card-header">
          <div>
            <strong>待采购产品</strong>
            <span class="muted-text">共 {{ totalRows }} 种，含待入库 {{ state.inboundRows.length }} 种</span>
          </div>
          <div class="page-card-actions">
            <el-tag type="info">已选 {{ selectedRows.length }} 种</el-tag>
            <el-tag v-if="pendingInboundRows.length" type="warning">待入库已置顶</el-tag>
            <el-button :disabled="!state.rows.length" :loading="confirming" @click="confirmAll">确认采购当前页</el-button>
          </div>
        </div>
      </template>

      <div class="procurement-toolbar procurement-toolbar-sticky procurement-workspace-filter">
        <el-form inline>
          <el-form-item label="关键词">
            <el-input
              v-model="state.filters.query"
              placeholder="商品名称 / 编码 / SKU / 申请人 / 采购链接"
              clearable
              style="width: 360px"
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
        <el-table
          v-loading="loading"
          :data="tableRows"
          :row-key="(row) => row.row_key"
          height="100%"
          stripe
          border
          class="erp-data-table"
          :row-class-name="rowClassName"
          @selection-change="handleSelectionChange"
        >
          <el-table-column type="selection" width="56" reserve-selection :selectable="canSelectRow" />

          <el-table-column label="产品信息" min-width="360" fixed="left">
            <template #default="{ row }">
              <div class="product-cell">
                <ProductImagePreview :src="productImage(row)" />
                <div class="product-cell-meta">
                  <strong>{{ row.product_name || "-" }}</strong>
                  <span>编码：{{ row.product_code || "-" }}</span>
                  <span>SKU：{{ row.mapped_skus || "未绑定 SKU" }}</span>
                  <span>申请人：{{ arrayText(row.requester_names) || "-" }}</span>
                </div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="请求数" width="90" align="center">
            <template #default="{ row }">{{ numberText(row.request_count) }}</template>
          </el-table-column>
          <el-table-column label="总数量" width="90" align="center">
            <template #default="{ row }">{{ numberText(row.total_quantity) }}</template>
          </el-table-column>
          <el-table-column label="货款" width="110" align="right">
            <template #default="{ row }">¥{{ money(row.total_amount) }}</template>
          </el-table-column>
          <el-table-column label="运费" width="110" align="right">
            <template #default="{ row }">¥{{ money(row.total_shipping) }}</template>
          </el-table-column>
          <el-table-column label="均摊单价" width="110" align="right">
            <template #default="{ row }">¥{{ averageUnitCost(row) }}</template>
          </el-table-column>

          <el-table-column label="采购来源" min-width="260">
            <template #default="{ row }">
              <div class="source-cell">
                <span>供应商：{{ arrayText(row.supplier_names) || row.other_source || "-" }}</span>
                <span>
                  1688：
                  <a v-if="row.link_1688" :href="row.link_1688" target="_blank" rel="noreferrer">{{ row.link_1688 }}</a>
                  <span v-else>-</span>
                </span>
                <span>
                  拼多多：
                  <a v-if="row.link_pdd" :href="row.link_pdd" target="_blank" rel="noreferrer">{{ row.link_pdd }}</a>
                  <span v-else>-</span>
                </span>
                <span>来源类型：{{ requestSourceSummary(row) }}</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="状态" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="rowStatusType(row)">{{ rowStatusText(row) }}</el-tag>
            </template>
          </el-table-column>

          <el-table-column label="流程时间" width="190">
            <template #default="{ row }">
              <div class="time-cell">
                <span v-for="item in flowTimes(row)" :key="item.label">
                  {{ item.label }}：{{ item.value ? dateText(item.value) : "-" }}
                </span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="操作" width="250" fixed="right" align="center">
            <template #default="{ row }">
              <div class="row-actions">
                <el-button link type="primary" :disabled="actionDisabled(row, 'edit')" @click="handleEditAction(row)">编辑明细</el-button>
                <el-button link type="success" :disabled="actionDisabled(row, 'purchase')" :loading="confirming && row.row_type === 'purchase'" @click="handlePurchaseAction(row)">确认采购</el-button>
                <el-button link type="success" :disabled="actionDisabled(row, 'inbound')" :loading="confirmingInbound && row.row_type === 'inbound'" @click="handleInboundAction(row)">确认入库</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <PageFooterPagination
        class="procurement-footer procurement-workspace-footer"
        :total="totalRows"
        :page="state.filters.page"
        :page-size="state.filters.pageSize"
        :page-sizes="[20, 50, 100]"
        @update:page="handlePageChange"
        @update:pageSize="handlePageSizeChange"
      />
    </el-card>

    <el-dialog
      v-model="detailVisible"
      title="编辑采购明细"
      width="1180px"
      align-center
      class="erp-centered-dialog"
      destroy-on-close
      @closed="resetDetailDialog"
    >
      <div class="page-stack">
        <div class="detail-header">
          <strong>{{ detailDialog.productName || "-" }}</strong>
          <span class="muted-text">这里修改的是当前产品下已提交的采购请求。</span>
        </div>

        <el-alert type="info" :closable="false" class="profit-sync-alert" title="保存后会同步重算当前产品关联订单利润。" />

        <el-table :data="detailDialog.rows" stripe border class="erp-data-table">
          <el-table-column prop="person_name" label="申请人" width="120" />
          <el-table-column prop="created_at" label="创建时间" width="170">
            <template #default="{ row }">{{ dateText(row.created_at) }}</template>
          </el-table-column>
          <el-table-column label="数量" width="110" align="center">
            <template #default="{ row }">
              <el-input-number v-model="row.quantity" :min="1" :precision="0" controls-position="right" />
            </template>
          </el-table-column>
          <el-table-column label="货款" width="130">
            <template #default="{ row }">
              <el-input-number v-model="row.amount" :min="0" :precision="2" controls-position="right" />
            </template>
          </el-table-column>
          <el-table-column label="运费" width="130">
            <template #default="{ row }">
              <el-input-number v-model="row.shipping_amount" :min="0" :precision="2" controls-position="right" />
            </template>
          </el-table-column>
          <el-table-column label="采购链接" min-width="260">
            <template #default="{ row }">
              <el-input v-model="row.purchase_url" placeholder="https://..." />
            </template>
          </el-table-column>
          <el-table-column label="备注" min-width="220">
            <template #default="{ row }">
              <el-input v-model="row.note" placeholder="颜色、规格等备注" />
            </template>
          </el-table-column>
        </el-table>
      </div>

      <template #footer>
        <div class="dialog-footer">
          <el-button @click="detailVisible = false">取消</el-button>
          <el-button type="primary" :loading="detailSaving" @click="saveDetailRows">保存修改</el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.procurement-list-page {
  min-height: 100%;
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
  background: var(--erp-surface);
}

.procurement-footer {
  margin-top: auto;
}

.product-cell {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.product-thumb {
  width: 68px;
  height: 68px;
  flex-shrink: 0;
  border-radius: 12px;
  overflow: hidden;
  background: #f2f4f7;
}

.product-thumb-fallback {
  display: grid;
  place-items: center;
  color: #909399;
  font-size: 12px;
}

.product-cell-meta,
.source-cell,
.detail-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.source-cell a {
  color: var(--el-color-primary);
  word-break: break-all;
}

.time-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--erp-text-secondary);
  font-size: 12px;
  line-height: 1.45;
}

.row-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  white-space: nowrap;
}

:deep(.inbound-ready-row) {
  background: #f0fdf4;
}

:deep(.inbound-ready-row td.el-table__cell) {
  background: #f0fdf4 !important;
}

.profit-sync-alert {
  margin-bottom: 12px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
</style>
