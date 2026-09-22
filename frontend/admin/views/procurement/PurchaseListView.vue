<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import ProcurementLedgerDialog from "../../components/procurement/ProcurementLedgerDialog.vue";
import { apiClient } from "../../utils/api";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import { createLatestRequestGate } from "../../utils/request-gate";
import { createRouteQuerySync } from "../../utils/route-query-sync.js";
import ErpFilterBar from "../../components/ErpFilterBar.vue";
import ErpPageHeader from "../../components/ErpPageHeader.vue";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import InventoryStructuredSearch from "../../components/inventory/InventoryStructuredSearch.vue";
import { uploadTeamAttachment } from "../../api/tools/imageCropper.js";

const route = useRoute();
const ledgerVisible = ref(false);
const ledgerProductId = ref(0);
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
const receiptVisible = ref(false);
const receiptSubmitting = ref(false);
const receiptRows = ref([]);
const receiptForm = reactive({ courier_company: "", tracking_number: "", received_at: "", images: [], note: "" });
const newPurchaseVisible = ref(false);
const newPurchaseSaving = ref(false);
const newPurchaseForm = reactive({ quantity: 1, amount: 0, shipping_amount: 0, purchase_url: "", note: "" });

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
  people: [],
  suppliers: [],
  filters: {
    query: "",
    demandType: "all",
    personId: "all",
    supplierId: "all",
    sourceType: "all",
    inventoryCategory: "",
    productName: "",
    vehicleBrand: "",
    vehicleModel: [],
    accessoryName: "",
    color: "",
    material: [],
    process: "",
    productId: "",
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
    paged: "1",
    page: String(state.filters.page),
    pageSize: String(state.filters.pageSize),
    status: "pending_arrival"
  });
  const query = String(state.filters.query || "").trim();
  if (query) params.set("query", query);
  if (state.filters.productId) params.set("productId", String(state.filters.productId));
  for (const [key, value] of Object.entries({
    demandType: state.filters.demandType,
    personId: state.filters.personId,
    supplierId: state.filters.supplierId,
    sourceType: state.filters.sourceType,
    inventoryCategory: state.filters.inventoryCategory,
    productName: state.filters.productName,
    vehicleBrand: state.filters.vehicleBrand,
    vehicleModel: state.filters.vehicleModel,
    accessoryName: state.filters.accessoryName,
    color: state.filters.color,
    material: state.filters.material,
    process: state.filters.process
  })) {
    const normalized = Array.isArray(value) ? value.join(",") : String(value || "").trim();
    if (normalized && normalized !== "all") params.set(key, normalized);
  }
  return params.toString();
}

function normalizeInboundRow(record = {}) {
  const purchasedAt = record.purchased_at || record.created_at || "";
  const detail = {
    ...record,
    quantity: Number(record.quantity || 0),
    amount: Number(record.amount || 0),
    shipping_amount: Number(record.shipping_amount || 0)
  };
  return {
    ...record,
    row_key: `inbound-${record.id}`,
    total_quantity: detail.quantity,
    total_amount: detail.amount,
    total_shipping: detail.shipping_amount,
    request_count: 1,
    requester_names: record.person_name ? [record.person_name] : [],
    supplier_names: record.supplier_name ? [record.supplier_name] : [],
    purchase_links: record.purchase_url ? [record.purchase_url] : [],
    earliest_created_at: purchasedAt,
    latest_created_at: purchasedAt,
    requests: [detail]
  };
}

function receiptImages(row = {}) {
  const value = row.receipt_images_json;
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || "[]"); } catch { return []; }
}

function openReceiptDialog(rows) {
  receiptRows.value = rows.flatMap((row) => row.requests || []).map((row) => ({ ...row, receive_quantity: Number(row.quantity || 0) }));
  Object.assign(receiptForm, { courier_company: "", tracking_number: "", received_at: new Date().toISOString().slice(0, 19).replace("T", " "), images: [], note: "" });
  receiptVisible.value = true;
}

async function uploadReceiptImage(file) {
  try {
    const result = await uploadTeamAttachment(file.raw || file);
    receiptForm.images.push(result.url || result.path || result);
  } catch (error) { ElMessage.error(error.message || "到货照片上传失败"); }
}

async function confirmReceipt() {
  if (!receiptRows.value.length) return;
  receiptSubmitting.value = true;
  try {
    await apiClient.post("/api/inbound-records/batch-update", { records: receiptRows.value.map((row) => ({ id: row.id, payload: {
      ...normalizeRequestForSave(row), receive_quantity: Number(row.receive_quantity || 0),
      expected_remaining_quantity: Number(row.quantity || 0),
      courier_company: receiptForm.courier_company, tracking_number: receiptForm.tracking_number,
      receipt_images_json: receiptForm.images, received_at: receiptForm.received_at,
      receipt_context: receiptForm.note, qc_status: row.qc_status || "pending"
    }})) });
    ElMessage.success("收货批次已登记，已同步快递单号和到货照片");
    receiptVisible.value = false; state.selectedRows = []; await loadPageData();
  } catch (error) { ElMessage.error(error.message || "批量收货失败"); }
  finally { receiptSubmitting.value = false; }
}

async function loadPageData() {
  const requestToken = listRequestGate.next();
  loading.value = true;
  try {
    const result = await apiClient.get(`/api/inbound-records?${procurementQueryString()}`, { routeScoped: false });
    if (!listRequestGate.isLatest(requestToken)) return;
    state.rows = Array.isArray(result?.rows) ? result.rows.map(normalizeInboundRow) : [];
    state.total = Number(result?.total || 0);
    const availableKeys = new Set(state.rows.map((row) => String(row.row_key || "")));
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
  Object.assign(state.filters, {
    query: "", demandType: "all", personId: "all", supplierId: "all", sourceType: "all",
    inventoryCategory: "", productName: "", vehicleBrand: "", vehicleModel: [],
    accessoryName: "", color: "", material: [], process: "", productId: "", page: 1, pageSize: 20
  });
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
    state.filters.query = query;
    state.filters.productId = productId;
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
      productId: state.filters.productId || undefined,
      page: state.filters.page > 1 ? String(state.filters.page) : undefined,
      pageSize: state.filters.pageSize !== 20 ? String(state.filters.pageSize) : undefined
    };
  }
});

const orderProcurementContext = computed(() => Number(route.query.orderId || 0) > 0 ? {
  orderId: Number(route.query.orderId),
  orderItemId: Number(route.query.orderItemId || 0) || null,
  orderNo: String(route.query.orderNo || ""),
  productName: String(route.query.productName || "")
} : null);

function openNewPurchaseDialog() {
  const quantity = Math.max(1, Number(route.query.quantity || 1));
  Object.assign(newPurchaseForm, { quantity, amount: 0, shipping_amount: 0, purchase_url: "", note: "" });
  newPurchaseVisible.value = true;
}

async function saveNewPurchaseRecord() {
  const productId = Number(state.filters.productId || 0);
  if (!productId) return ElMessage.warning("缺少库存商品，无法新增采购记录");
  if (!(Number(newPurchaseForm.quantity || 0) > 0)) return ElMessage.warning("采购数量必须大于 0");
  if (Number(newPurchaseForm.amount || 0) < 0 || Number(newPurchaseForm.shipping_amount || 0) < 0) return ElMessage.warning("采购金额和运费不能为负数");
  newPurchaseSaving.value = true;
  try {
    const context = orderProcurementContext.value;
    await apiClient.post("/api/procurement/purchases", {
      items: [{
        product_id: productId,
        quantity: Number(newPurchaseForm.quantity),
        amount: Number(newPurchaseForm.amount || 0),
        shipping_amount: Number(newPurchaseForm.shipping_amount || 0),
        purchase_url: newPurchaseForm.purchase_url,
        note: newPurchaseForm.note,
        source_order_id: context?.orderId || null,
        source_order_item_id: context?.orderItemId || null
      }],
      note: context?.orderNo ? `订单 ${context.orderNo} 补录采购` : "采购明细新增采购"
    });
    ElMessage.success("采购已登记并进入待到货明细");
    newPurchaseVisible.value = false;
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "新增采购记录失败");
  } finally {
    newPurchaseSaving.value = false;
  }
}

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
    { label: "最新采购", value: row.latest_created_at || "" }
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
  if (!(Number(row.quantity || 0) > 0)) return ElMessage.warning("采购数量必须大于 0");
  if (Number(row.amount || 0) < 0) return ElMessage.warning("采购金额不能为负数，未知金额可稍后补齐");
  savingRequestIds.value = [...new Set([...savingRequestIds.value, requestId])];
  try {
    await apiClient.put(`/api/inbound-records/${requestId}`, {
      ...normalizeRequestForSave(row),
      status: "pending_arrival",
      qc_status: row.qc_status || "pending"
    });
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
  const invalid = detailDialog.rows.find((row) => !(Number(row.quantity || 0) > 0) || Number(row.amount || 0) < 0);
  if (invalid) return ElMessage.warning("每条采购明细必须有实际数量，金额不能为负数；未知金额可稍后补齐");

  detailSaving.value = true;
  try {
    for (const row of detailDialog.rows) {
      await apiClient.put(`/api/inbound-records/${row.id}`, {
        ...normalizeRequestForSave(row),
        status: "pending_arrival",
        qc_status: row.qc_status || "pending"
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

function collectInboundIds(rows = []) {
  return rows.flatMap((row) => (row.requests || []).map((item) => Number(item.id))).filter(Boolean);
}

async function directInboundRequests(rows, label) {
  const inboundIds = collectInboundIds(rows);
  if (!inboundIds.length) return;
  try {
    await ElMessageBox.confirm(`确认将${label}直接入库吗？确认后会增加库存。`, "确认入库", {
      type: "warning",
      confirmButtonText: "确认入库",
      cancelButtonText: "取消"
    });

    inboundSubmitting.value = true;
    await apiClient.post("/api/inbound-records/batch-update", {
      records: rows.flatMap((row) => (row.requests || []).map((item) => ({
        id: Number(item.id),
        payload: {
          ...normalizeRequestForSave(item),
          status: "approved",
          qc_status: item.qc_status || "pending"
        }
      })))
    });
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
  openReceiptDialog([row]);
}

async function inboundSelectedRows() {
  openReceiptDialog(state.selectedRows);
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
      await apiClient.put(`/api/inbound-records/${item.id}`, {
        updated_at: item.updated_at || undefined,
        ...normalizeRequestForSave(item),
        status: "cancelled",
        qc_status: item.qc_status || "pending"
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
  const [peopleResult, suppliersResult] = await Promise.allSettled([
    apiClient.get("/api/people"),
    apiClient.get("/api/suppliers")
  ]);
  const people = peopleResult.status === "fulfilled" ? peopleResult.value : [];
  const suppliers = suppliersResult.status === "fulfilled" ? suppliersResult.value : [];
  state.people = Array.isArray(people) ? people.filter((item) => Number(item.active) !== 0) : [];
  state.suppliers = Array.isArray(suppliers) ? suppliers : [];
  await loadPageData();
});
</script>

<template>
  <div class="page-stack procurement-list-page procurement-workspace-page">
    <ProcurementLedgerDialog v-if="ledgerVisible" v-model="ledgerVisible" :product-id="ledgerProductId" @saved="loadPageData" />
    <ErpPageHeader title="每日采购与收货台账" description="按采购日期和核心品名排序，集中核货、登记快递与到货留痕。" />

    <el-alert
      v-if="orderProcurementContext"
      type="warning"
      :closable="false"
      class="procurement-order-context"
      show-icon
    >
      <template #title>
        订单 {{ orderProcurementContext.orderNo || orderProcurementContext.orderId }} 的采购明细
      </template>
      当前仅展示「{{ orderProcurementContext.productName || `库存商品 #${state.filters.productId}` }}」的待到货采购记录；可直接展开修改，或新增一笔并自动关联当前订单。
    </el-alert>

    <el-card shadow="never" class="page-card procurement-list-card procurement-workspace-card">
      <div class="procurement-toolbar procurement-toolbar-sticky procurement-workspace-filter">
        <div class="procurement-list-summary">
          <strong>采购与收货明细</strong>
          <span>共 {{ totalRows }} 条</span>
          <span>已选 {{ state.selectedRows.length }} 条</span>
        </div>
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
            <el-form-item label="需求类型">
              <el-select v-model="state.filters.demandType" style="width: 150px">
                <el-option label="全部需求" value="all" />
                <el-option label="真实订单需求" value="real_order" />
                <el-option label="库存预警需求" value="inventory_warning" />
              </el-select>
            </el-form-item>
            <el-form-item label="采购负责人">
              <el-select v-model="state.filters.personId" filterable style="width: 140px">
                <el-option label="全部" value="all" />
                <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="String(person.id)" />
              </el-select>
            </el-form-item>
            <el-form-item label="供应商">
              <el-select v-model="state.filters.supplierId" filterable style="width: 150px">
                <el-option label="全部供应商" value="all" />
                <el-option v-for="supplier in state.suppliers" :key="supplier.id" :label="supplier.name" :value="String(supplier.id)" />
              </el-select>
            </el-form-item>
            <el-form-item label="采购平台">
              <el-select v-model="state.filters.sourceType" style="width: 130px">
                <el-option label="全部平台" value="all" />
                <el-option v-for="option in sourceTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
            </el-form-item>
          </el-form>
          <template #actions>
            <el-button class="erp-btn erp-btn-primary" type="primary" @click="handleSearch">查询</el-button>
            <el-button class="erp-btn erp-btn-secondary" @click="handleReset">重置</el-button>
            <el-button class="erp-btn erp-btn-secondary" @click="loadPageData">刷新数据</el-button>
            <el-button v-if="orderProcurementContext" class="erp-btn erp-btn-primary" type="primary" @click="openNewPurchaseDialog">
              新增该订单采购记录
            </el-button>
            <el-button class="erp-btn erp-btn-primary" type="success" :disabled="!state.selectedRows.length" :loading="inboundSubmitting" @click="inboundSelectedRows">
              批量登记到货（{{ state.selectedRows.length }}）
            </el-button>
            <el-button class="erp-btn erp-btn-danger" :disabled="!state.selectedRows.length" :loading="cancelSubmitting" @click="cancelSelectedRows">
              选中取消
            </el-button>
          </template>
        </ErpFilterBar>
      </div>

      <InventoryStructuredSearch
        compact
        class="procurement-structured-search"
        :model-value="state.filters"
        @update:model-value="Object.assign(state.filters, $event)"
        @change="handleSearch"
      />

      <div class="list-wrap erp-responsive-table" role="region" aria-label="待入库采购表格" tabindex="0">
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
                  <span>库存 ID：{{ row.inventory_number || row.product_code || "-" }}</span>
                  <span>核心品名：{{ row.inventory_category || "未分类" }}</span>
                  <span>SKU：{{ row.mapped_skus || "未绑定 SKU" }}</span>
                  <span>申请人：{{ arrayText(row.requester_names) || "-" }}</span>
                </div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="采购信息" width="190">
            <template #default="{ row }"><div class="time-cell"><span>采购人：{{ row.person_name || "未记录" }}</span><span>采购时间：{{ dateText(row.purchased_at || row.created_at) }}</span></div></template>
          </el-table-column>
          <el-table-column label="快递 / 留痕" min-width="200">
            <template #default="{ row }"><div class="time-cell"><span>{{ row.courier_company || "未填快递公司" }} {{ row.tracking_number || "" }}</span><span>{{ receiptImages(row).length ? `到货照片 ${receiptImages(row).length} 张` : "未上传到货照片" }}</span></div></template>
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
                <el-button class="erp-btn-link" link @click="ledgerProductId = Number(row.product_id); ledgerVisible = true">数量纠正／对账</el-button>
                <el-button class="erp-btn-link" link type="primary" :disabled="actionDisabled(row, 'edit')" @click="handleEditAction(row)">展开编辑</el-button>
                <el-button class="erp-btn-link" link type="success" :disabled="actionDisabled(row, 'inbound')" :loading="inboundSubmitting" @click="handleInboundAction(row)">登记到货</el-button>
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

    <el-dialog v-model="newPurchaseVisible" title="新增采购记录" width="620px" destroy-on-close>
      <el-alert type="info" :closable="false" title="保存后会生成采购在途，并关联当前订单；到货后请在本页登记实收。" />
      <el-form label-width="92px" class="receipt-form">
        <el-form-item label="采购数量"><el-input-number v-model="newPurchaseForm.quantity" :min="1" :precision="0" /></el-form-item>
        <el-form-item label="货款"><el-input-number v-model="newPurchaseForm.amount" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="运费"><el-input-number v-model="newPurchaseForm.shipping_amount" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="采购链接"><el-input v-model="newPurchaseForm.purchase_url" placeholder="https://..." /></el-form-item>
        <el-form-item label="备注"><el-input v-model="newPurchaseForm.note" type="textarea" placeholder="颜色、规格、供应商等" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="newPurchaseVisible = false">取消</el-button>
        <el-button type="primary" :loading="newPurchaseSaving" @click="saveNewPurchaseRecord">保存并进入在途</el-button>
      </template>
    </el-dialog>

    <el-dialog v-if="receiptVisible" v-model="receiptVisible" title="批量登记到货" width="820px" destroy-on-close>
      <el-alert title="同一批到货可共用快递单号和照片；每条明细仍可分别填写实收数量。" type="info" :closable="false" />
      <el-form label-width="92px" class="receipt-form">
        <el-form-item label="快递公司"><el-input v-model="receiptForm.courier_company" placeholder="例如：中通" /></el-form-item>
        <el-form-item label="快递单号"><el-input v-model="receiptForm.tracking_number" placeholder="填写本批次快递单号" /></el-form-item>
        <el-form-item label="到货时间"><el-date-picker v-model="receiptForm.received_at" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" /></el-form-item>
        <el-form-item label="到货照片"><el-upload :auto-upload="false" accept="image/*" multiple :on-change="uploadReceiptImage"><el-button>上传照片</el-button></el-upload><span class="muted-text">已上传 {{ receiptForm.images.length }} 张</span></el-form-item>
        <el-form-item label="收货备注"><el-input v-model="receiptForm.note" type="textarea" /></el-form-item>
      </el-form>
      <el-table :data="receiptRows" border max-height="280"><el-table-column prop="product_name" label="库存名称" min-width="300" /><el-table-column prop="quantity" label="采购数" width="100" /><el-table-column label="实收数" width="160"><template #default="{row}"><el-input-number v-model="row.receive_quantity" :min="0" :max="row.quantity" :precision="0" /></template></el-table-column></el-table>
      <template #footer><el-button @click="receiptVisible=false">取消</el-button><el-button type="primary" :loading="receiptSubmitting" @click="confirmReceipt">确认收货并入库</el-button></template>
    </el-dialog>

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
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
}

.procurement-list-summary {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.procurement-list-summary strong {
  color: var(--erp-text-primary);
  font-size: 14px;
}

.procurement-list-summary span {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.procurement-structured-search {
  flex: none;
}

.procurement-structured-search:deep(.inventory-structured-search.is-compact) {
  grid-template-columns: repeat(7, minmax(110px, 1fr)) minmax(180px, 1.35fr);
  overflow-x: visible;
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

@media (max-width: 767px) {
  .procurement-toolbar,
  .page-card-header,
  .purchase-inline-editor__header {
    align-items: stretch;
    flex-direction: column;
  }

  .page-card-actions,
  .page-card-actions .el-button {
    width: 100%;
  }

  .purchase-inline-editor {
    min-width: 920px;
    padding: 10px;
  }

  .row-actions {
    justify-content: flex-start;
    flex-wrap: wrap;
    white-space: normal;
  }
}

@media (max-width: 1500px) {
  .procurement-toolbar {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .procurement-structured-search:deep(.inventory-structured-search.is-compact) {
    grid-template-columns: repeat(4, minmax(140px, 1fr));
  }
}
</style>
