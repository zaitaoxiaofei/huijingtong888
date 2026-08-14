<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import { createLatestRequestGate } from "../../utils/request-gate";
import { createRouteQuerySync } from "../../utils/route-query-sync.js";
import ErpFilterBar from "../../components/ErpFilterBar.vue";
import ErpPageHeader from "../../components/ErpPageHeader.vue";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";

const route = useRoute();
const router = useRouter();
const listRequestGate = createLatestRequestGate();
let syncingRoute = false;

const loading = ref(false);
const inboundSubmitting = ref(false);
const cancelSubmitting = ref(false);
const detailVisible = ref(false);
const detailSaving = ref(false);
const expandedRowKeys = ref([]);
const savingRequestIds = ref([]);

const sourceTypeOptions = [
  { label: "1688", value: "1688" },
  { label: "拼多多", value: "pdd" },
  { label: "供应商", value: "supplier" },
  { label: "微信", value: "wechat" },
  { label: "其他", value: "other" }
];

const urgencyOptions = [
  { label: "普通", value: "normal" },
  { label: "加急", value: "urgent" }
];

const state = reactive({
  rows: [],
  total: 0,
  filters: {
    query: "",
    page: 1,
    pageSize: 20
  },
  selectedRows: []
});

const detailDialog = reactive({
  productId: null,
  productName: "",
  rows: []
});

const tableRows = computed(() => state.rows.map((row) => ({
  ...row,
  row_key: `purchase-${row.product_id}`
})));

const totalRows = computed(() => Number(state.total || 0));

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
  const productId = Number(row?.product_id || 0);
  return productId ? `/api/products/${productId}/image?thumb=1&w=180` : "";
}

function productPreviewImage(row) {
  const productId = Number(row?.product_id || 0);
  return productId ? `/api/products/${productId}/image` : "";
}

function arrayText(value) {
  return Array.isArray(value) ? value.filter(Boolean).join(" / ") : String(value || "");
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
  const sources = (row.requests || []).map((item) => sourceLabel(item.source_type || item.product_source_platform));
  return Array.from(new Set(sources)).join(" / ") || "-";
}

function uniqueRequestValues(row, field) {
  const values = (row.requests || []).map((item) => String(item?.[field] || "").trim()).filter(Boolean);
  return Array.from(new Set(values));
}

function requestPurchaseLinks(row) {
  return uniqueRequestValues(row, "purchase_url");
}

function requestNotes(row) {
  return uniqueRequestValues(row, "note");
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
    const result = await apiClient.get(`/api/procurement/requests?${procurementQueryString()}`);
    if (!listRequestGate.isLatest(requestToken)) return;
    state.rows = Array.isArray(result?.rows) ? result.rows : [];
    state.total = Number(result?.total || 0);
    const availableKeys = new Set(state.rows.map((row) => `purchase-${row.product_id}`));
    state.selectedRows = state.selectedRows.filter((row) => availableKeys.has(String(row.row_key || "")));
  } catch (error) {
    if (!listRequestGate.isLatest(requestToken)) return;
    ElMessage.error(error.message || "待入库清单加载失败");
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
  state.filters.query = "";
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

const syncRouteQuery = createRouteQuerySync({
  route,
  router,
  isSyncingRoute: () => syncingRoute,
  buildQuery(mode) {
    const includeTextFilters = mode === "manual";
    return {
      query: includeTextFilters ? state.filters.query || undefined : undefined,
      page: state.filters.page > 1 ? String(state.filters.page) : undefined,
      pageSize: state.filters.pageSize !== 20 ? String(state.filters.pageSize) : undefined
    };
  }
});

function handleSelectionChange(rows) {
  state.selectedRows = Array.isArray(rows) ? rows : [];
}

function canSelectRow(row) {
  return Boolean(row?.row_key);
}

function rowStatusText(row) {
  return row.overdue ? "超期待入库" : "待入库";
}

function rowStatusType(row) {
  return row.overdue ? "danger" : "warning";
}

function flowTimes(row) {
  return [
    { label: "最早创建", value: row.earliest_created_at || "" },
    { label: "最近创建", value: row.latest_created_at || "" }
  ];
}

function actionDisabled(row, action) {
  const requests = Array.isArray(row?.requests) ? row.requests : [];
  if (!requests.length) return true;
  if (action === "edit") return false;
  if (action === "inbound") return inboundSubmitting.value;
  if (action === "cancel") return cancelSubmitting.value;
  return false;
}

function handleEditAction(row) {
  if (actionDisabled(row, "edit")) return;
  toggleRowExpanded(row);
}

function handleExpandChange(row, expandedRows) {
  expandedRowKeys.value = expandedRows.map((item) => item.row_key).filter(Boolean);
}

function toggleRowExpanded(row) {
  const key = String(row?.row_key || "");
  if (!key) return;
  expandedRowKeys.value = expandedRowKeys.value.includes(key)
    ? expandedRowKeys.value.filter((item) => item !== key)
    : [...expandedRowKeys.value, key];
}

function requestSaving(row) {
  return savingRequestIds.value.includes(Number(row?.id || 0));
}

function normalizeRequestForSave(row = {}) {
  return {
    updated_at: row.updated_at || undefined,
    product_id: Number(row.product_id || 0) || null,
    person_id: Number(row.person_id || 0) || null,
    quantity: Number(row.quantity || 0),
    amount: Number(row.amount || 0),
    shipping_amount: Number(row.shipping_amount || 0),
    urgency: row.urgency || "normal",
    source_type: row.source_type || "1688",
    supplier_id: row.supplier_id || null,
    purchase_url: row.purchase_url || "",
    note: row.note || ""
  };
}

async function saveRequestRow(row) {
  const requestId = Number(row?.id || 0);
  if (!requestId || requestSaving(row)) return;
  savingRequestIds.value = [...new Set([...savingRequestIds.value, requestId])];
  try {
    await apiClient.put(`/api/procurement/requests/${requestId}`, normalizeRequestForSave(row));
    await recalculateProductProfits([row.product_id]);
    ElMessage.success("采购明细已保存");
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "保存采购明细失败");
  } finally {
    savingRequestIds.value = savingRequestIds.value.filter((id) => id !== requestId);
  }
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
    created_at: item.created_at || "",
    updated_at: item.updated_at || ""
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
      await apiClient.put(`/api/procurement/requests/${row.id}`, normalizeRequestForSave(row));
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

function collectRequestIds(rows = []) {
  return rows.flatMap((row) => (row.requests || []).map((item) => Number(item.id))).filter(Boolean);
}

async function directInboundRequests(rows, label) {
  const requestIds = collectRequestIds(rows);
  if (!requestIds.length) return;

  try {
    await ElMessageBox.confirm(`确认将${label}直接入库吗？确认后会增加库存。`, "确认入库", {
      type: "warning",
      confirmButtonText: "确认入库",
      cancelButtonText: "取消"
    });

    inboundSubmitting.value = true;
    await apiClient.post("/api/procurement/requests/direct-inbound", { request_ids: requestIds });
    ElMessage.success("采购记录已入库");
    state.selectedRows = [];
    await loadPageData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "入库失败");
  } finally {
    inboundSubmitting.value = false;
  }
}

async function handleInboundAction(row) {
  if (actionDisabled(row, "inbound")) return;
  await directInboundRequests([row], `产品「${row.product_name || row.product_code || row.product_id}」`);
}

async function inboundSelectedRows() {
  await directInboundRequests(state.selectedRows, `选中的 ${state.selectedRows.length} 个商品`);
}

async function cancelRequests(rows, label) {
  const requests = rows.flatMap((row) => Array.isArray(row.requests) ? row.requests : []);
  if (!requests.length) return;

  try {
    await ElMessageBox.confirm(`确认取消${label}吗？取消后将不会继续入库。`, "取消采购", {
      type: "warning",
      confirmButtonText: "确认取消",
      cancelButtonText: "返回"
    });

    cancelSubmitting.value = true;
    for (const item of requests) {
      await apiClient.put(`/api/procurement/requests/${item.id}`, {
        updated_at: item.updated_at || undefined,
        status: "cancelled",
        approval_status: "cancelled"
      });
    }
    ElMessage.success("采购记录已取消");
    state.selectedRows = [];
    await loadPageData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "取消采购失败");
  } finally {
    cancelSubmitting.value = false;
  }
}

async function handleCancelAction(row) {
  if (actionDisabled(row, "cancel")) return;
  await cancelRequests([row], `产品「${row.product_name || row.product_code || row.product_id}」`);
}

async function cancelSelectedRows() {
  await cancelRequests(state.selectedRows, `选中的 ${state.selectedRows.length} 个商品`);
}

watch(() => route.query, applyRouteState, { deep: true });
watch(() => [state.filters.page, state.filters.pageSize], syncRouteQuery);

onMounted(async () => {
  applyRouteState();
  await loadPageData();
});
</script>

<template>
  <div class="page-stack procurement-list-page procurement-workspace-page">
    <ErpPageHeader title="待入库清单" description="采购流程统一收口到这里处理，只保留编辑、入库和取消。">
      <template #actions>
        <el-button class="erp-btn erp-btn-secondary" @click="loadPageData">刷新数据</el-button>
        <el-button class="erp-btn erp-btn-primary" type="success" :disabled="!state.selectedRows.length" :loading="inboundSubmitting" @click="inboundSelectedRows">
          批量入库
        </el-button>
        <el-button class="erp-btn erp-btn-danger" :disabled="!state.selectedRows.length" :loading="cancelSubmitting" @click="cancelSelectedRows">
          选中取消
        </el-button>
      </template>
    </ErpPageHeader>

    <el-card shadow="never" class="page-card procurement-list-card procurement-workspace-card">
      <template #header>
        <div class="page-card-header">
          <div>
            <strong>待入库商品</strong>
            <span class="muted-text">共 {{ totalRows }} 种，已选 {{ state.selectedRows.length }} 种</span>
          </div>
          <div class="page-card-actions">
            <el-button class="erp-btn erp-btn-primary" type="success" :disabled="!state.selectedRows.length" :loading="inboundSubmitting" @click="inboundSelectedRows">
              批量入库（{{ state.selectedRows.length }}）
            </el-button>
          </div>
        </div>
      </template>

      <div class="procurement-toolbar procurement-toolbar-sticky procurement-workspace-filter">
        <ErpFilterBar>
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
          </el-form>
          <template #actions>
            <el-button class="erp-btn erp-btn-primary" type="primary" @click="handleSearch">查询</el-button>
            <el-button class="erp-btn erp-btn-secondary" @click="handleReset">重置</el-button>
          </template>
        </ErpFilterBar>
      </div>

      <div class="list-wrap">
        <el-table
          v-loading="loading"
          :data="tableRows"
          :row-key="(row) => row.row_key"
          :expand-row-keys="expandedRowKeys"
          height="100%"
          stripe
          border
          class="erp-data-table"
          @selection-change="handleSelectionChange"
          @expand-change="handleExpandChange"
        >
          <el-table-column type="selection" width="56" reserve-selection :selectable="canSelectRow" />
          <el-table-column type="expand" width="48">
            <template #default="{ row }">
              <div class="purchase-inline-editor">
                <div class="purchase-inline-editor__header">
                  <strong>{{ row.product_name || row.product_code || "-" }}</strong>
                  <span class="muted-text">直接修改明细后点“保存”，保存后会同步重算关联订单利润。</span>
                </div>
                <el-table :data="row.requests || []" stripe border class="erp-data-table purchase-inline-table">
                  <el-table-column prop="person_name" label="申请人" width="100" />
                  <el-table-column label="数量" width="112" align="center">
                    <template #default="{ row: item }">
                      <el-input-number v-model="item.quantity" :min="1" :precision="0" controls-position="right" />
                    </template>
                  </el-table-column>
                  <el-table-column label="货款" width="128">
                    <template #default="{ row: item }">
                      <el-input-number v-model="item.amount" :min="0" :precision="2" controls-position="right" />
                    </template>
                  </el-table-column>
                  <el-table-column label="运费" width="128">
                    <template #default="{ row: item }">
                      <el-input-number v-model="item.shipping_amount" :min="0" :precision="2" controls-position="right" />
                    </template>
                  </el-table-column>
                  <el-table-column label="来源" width="124">
                    <template #default="{ row: item }">
                      <el-select v-model="item.source_type">
                        <el-option
                          v-for="option in sourceTypeOptions"
                          :key="option.value"
                          :label="option.label"
                          :value="option.value"
                        />
                      </el-select>
                    </template>
                  </el-table-column>
                  <el-table-column label="紧急" width="104">
                    <template #default="{ row: item }">
                      <el-select v-model="item.urgency">
                        <el-option
                          v-for="option in urgencyOptions"
                          :key="option.value"
                          :label="option.label"
                          :value="option.value"
                        />
                      </el-select>
                    </template>
                  </el-table-column>
                  <el-table-column label="采购链接" min-width="260">
                    <template #default="{ row: item }">
                      <el-input v-model="item.purchase_url" placeholder="https://..." clearable />
                    </template>
                  </el-table-column>
                  <el-table-column label="备注" min-width="220">
                    <template #default="{ row: item }">
                      <el-input v-model="item.note" placeholder="颜色、规格、供应提醒" clearable />
                    </template>
                  </el-table-column>
                  <el-table-column label="操作" width="96" align="center" fixed="right">
                    <template #default="{ row: item }">
                      <el-button
                        class="erp-btn-link"
                        link
                        type="primary"
                        :loading="requestSaving(item)"
                        @click="saveRequestRow(item)"
                      >
                        保存
                      </el-button>
                    </template>
                  </el-table-column>
                </el-table>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="产品信息" min-width="360" fixed="left">
            <template #default="{ row }">
              <div class="product-cell">
                <ProductImagePreview
                  :src="productImage(row)"
                  :preview-list="productPreviewImage(row) ? [productPreviewImage(row)] : []"
                />
                <div class="product-cell-meta">
                  <strong>{{ row.product_name || "-" }}</strong>
                  <span>编码：{{ row.product_code || "-" }}</span>
                  <span>SKU：{{ row.mapped_skus || "未绑定 SKU" }}</span>
                  <span>申请人：{{ arrayText(row.requester_names) || "-" }}</span>
                </div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="明细数" width="90" align="center">
            <template #default="{ row }">{{ numberText(row.request_count) }}</template>
          </el-table-column>
          <el-table-column label="总数量" width="90" align="center">
            <template #default="{ row }">{{ numberText(row.total_quantity) }}</template>
          </el-table-column>
          <el-table-column label="货款" width="110" align="right">
            <template #default="{ row }">￥{{ money(row.total_amount) }}</template>
          </el-table-column>
          <el-table-column label="运费" width="110" align="right">
            <template #default="{ row }">￥{{ money(row.total_shipping) }}</template>
          </el-table-column>
          <el-table-column label="均摊单价" width="110" align="right">
            <template #default="{ row }">￥{{ averageUnitCost(row) }}</template>
          </el-table-column>

          <el-table-column label="采购来源" min-width="280">
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

          <el-table-column label="采购链接" min-width="260">
            <template #default="{ row }">
              <div v-if="requestPurchaseLinks(row).length" class="link-note-cell">
                <a
                  v-for="link in requestPurchaseLinks(row)"
                  :key="link"
                  :href="link"
                  target="_blank"
                  rel="noreferrer"
                >
                  {{ link }}
                </a>
              </div>
              <span v-else class="empty-text">-</span>
            </template>
          </el-table-column>

          <el-table-column label="备注信息" min-width="260">
            <template #default="{ row }">
              <div v-if="requestNotes(row).length" class="link-note-cell">
                <span v-for="note in requestNotes(row)" :key="note">{{ note }}</span>
              </div>
              <span v-else class="empty-text">-</span>
            </template>
          </el-table-column>

          <el-table-column label="状态" width="110" align="center">
            <template #default="{ row }">
              <el-tag :type="rowStatusType(row)">{{ rowStatusText(row) }}</el-tag>
            </template>
          </el-table-column>

          <el-table-column label="时间" width="210">
            <template #default="{ row }">
              <div class="time-cell">
                <span v-for="item in flowTimes(row)" :key="item.label">
                  {{ item.label }}：{{ item.value ? dateText(item.value) : "-" }}
                </span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="操作" width="280" fixed="right" align="center">
            <template #default="{ row }">
              <div class="row-actions erp-inline-actions">
                <el-button class="erp-btn-link" link type="primary" :disabled="actionDisabled(row, 'edit')" @click="handleEditAction(row)">展开编辑</el-button>
                <el-button class="erp-btn-link" link type="success" :disabled="actionDisabled(row, 'inbound')" :loading="inboundSubmitting" @click="handleInboundAction(row)">入库</el-button>
                <el-button class="erp-btn-link" link type="danger" :disabled="actionDisabled(row, 'cancel')" :loading="cancelSubmitting" @click="handleCancelAction(row)">取消</el-button>
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
          <span class="muted-text">这里修改的是当前商品下待入库的采购记录。</span>
        </div>

        <el-alert type="info" :closable="false" class="profit-sync-alert" title="保存后会同步重算当前商品关联订单利润。" />

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
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="detailVisible = false">取消</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="detailSaving" @click="saveDetailRows">保存修改</el-button>
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

.link-note-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  line-height: 1.45;
  word-break: break-all;
}

.link-note-cell a {
  color: var(--el-color-primary);
}

.empty-text {
  color: var(--erp-text-secondary);
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

.purchase-inline-editor {
  display: grid;
  gap: 10px;
  padding: 12px 16px 14px 72px;
  background: #f8fafc;
}

.purchase-inline-editor__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.purchase-inline-table {
  width: 100%;
}

.purchase-inline-table :deep(.el-input-number) {
  width: 100%;
}

.purchase-inline-table :deep(.el-select) {
  width: 100%;
}

.profit-sync-alert {
  margin-bottom: 12px;
}
</style>
