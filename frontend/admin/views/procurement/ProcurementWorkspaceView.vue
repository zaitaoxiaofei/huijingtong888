<script setup>
import { computed, onMounted, onBeforeUnmount, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useRoute } from "vue-router";
const route = useRoute();
import { apiClient } from "../../utils/api.js";
import { uploadTeamAttachment, withImageToken } from "../../api/tools/imageCropper.js";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import { useAuthStore } from "../../stores/auth.js";
import ErpFilterBar from "../../components/ErpFilterBar.vue";
import ErpPageHeader from "../../components/ErpPageHeader.vue";
import ProcurementLedgerDialog from "../../components/procurement/ProcurementLedgerDialog.vue";
import DailyPurchaseExport from "../../components/procurement/DailyPurchaseExport.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import ProductCreateEditDialog from "../../components/inventory/ProductCreateEditDialog.vue";
import InventoryStructuredSearch from "../../components/inventory/InventoryStructuredSearch.vue";
import PageFooterPagination from "../../components/PageFooterPagination.vue";

const authStore = useAuthStore();
const loading = ref(false);
const demandRefreshing = ref(false);
let rowsController;
let disposed = false;
onBeforeUnmount(() => { disposed = true; rowsController?.abort(); });
const submitting = ref(false);
const createVisible = ref(false);
const bindVisible = ref(false);
const linkVisible = ref(false);
const editingBulkProductId = ref(0);
const inventoryEditorVisible = ref(false);
const inventoryEditorRef = ref(null);
const inventoryEditorProductId = ref(null);
const inventoryEditorValue = ref(null);
const quickInventoryCreateVisible = ref(false);
const quickComponentCreateVisible = ref(false);
const quickComponentRole = ref("included");
const suggestionLoading = ref(false);
const activeItemIndex = ref(0);
const inventorySearch = ref("");
const quickInventorySearch = reactive({ inventoryId: "", productName: "" });
const quickInventoryResults = ref([]);
const quickInventoryLoading = ref(false);
const confirmingGroupKey = ref("");
const uploadingReceipt = ref(false);
const imageSearchingId = ref(0);
const ledgerVisible = ref(false);
const ledgerProductId = ref(0);
function openLedger(row = {}) { ledgerProductId.value = Number(row.product_id || 0); ledgerVisible.value = true; }
function suggestionReasonTagType(type) {
  return ({ real_order: "danger", warehouse_request: "success", inventory_warning: "warning", advance_stock: "info" })[type] || "info";
}
const warehouseReasonLabels = { accessory_shortage: "配件不足", hot_product_replenishment: "热门产品备货不足", shipping_shortage: "订单发货缺货", safety_stock_shortage: "安全库存不足", seasonal_replenishment: "季节性备货", other: "其他" };
function warehouseRequestDetails(row = {}) {
  return (row.requests || []).filter((request) => request.demand_type === "warehouse_request").map((request) => ({
    text: `${request.person_name || "仓库"}：${warehouseReasonLabels[request.request_reason_code] || "其他"}${request.request_reason_note ? `（${request.request_reason_note}）` : ""}`,
    id: request.id,
    request: request
  }));
}
async function rejectWarehouseRequest(request) {
  try {
    const { value } = await ElMessageBox.prompt("请填写拒绝原因，仓库人员可据此调整申请。", "拒绝库存采购申请", {
      inputPlaceholder: "例如：已有在途库存，暂不采购",
      inputValidator: (text) => String(text || "").trim() ? true : "请填写拒绝原因"
    });
    await apiClient.put(`/api/procurement/requests/${request.id}`, {
      status: "cancelled",
      approval_status: "rejected",
      note: `${String(request.note || "").trim()}${request.note ? "；" : ""}采购拒绝：${String(value).trim()}`,
      updated_at: request.updated_at || undefined
    });
    ElMessage.success("库存采购申请已拒绝");
    await loadRows();
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error.message || "拒绝库存采购申请失败");
  }
}
const purchaseHistoryVisible = ref(false);
const purchaseHistoryLoading = ref(false);
const purchaseHistoryProduct = ref(null);
const purchaseHistoryRows = ref([]);
const purchaseHistorySaving = ref(false);
const purchaseCorrection = ref(null);
const purchaseHistorySavingId = ref(0);
const purchaseBackfillVisible = ref(false);
const purchaseBackfillForm = reactive({ quantity: 1, amount: null, shipping_amount: 0, purchased_at: '', inventory_effect: '', reason: '' });
const selectedDemandRows = ref([]);
const bulkVisible = ref(false);
const bulkSaving = ref(false);
const bulkItems = ref([]);
const bulkPage = ref(1);
const bulkPageSize = ref(10);
const bulkAddVisible = ref(false);
const bulkAddLoading = ref(false);
const bulkAddResults = ref([]);
const bulkAddPage = ref(1);
const bulkAddPageSize = ref(20);
const bulkAddTotal = ref(0);
const bulkAddFilters = ref({ inventoryCategory: "", productName: "", vehicleBrand: "", vehicleModel: [], accessoryName: "", color: "", material: [], process: "" });
const bulkGroupRecommendations = ref([]);
const bulkMeta = reactive({ source_type: "1688", supplier_id: null, note: "", receipts: [], remember_group: false, group_name: "" });
const orderDetailPages = reactive({});
const orderHistoryVisible = ref(false);
const orderHistoryLoading = ref(false);
const orderHistoryProduct = ref(null);
const orderHistoryRows = ref([]);
const orderHistorySummary = ref({ total_quantity: 0, shortage_quantity: 0, in_transit_quantity: 0, covered_quantity: 0, advanced_uncovered_quantity: 0 });
const orderHistoryActiveTab = ref("purchase");
const priceAnomalyReasons = ["供应商涨价", "采购数量较少", "临时加急采购", "更换供应商", "商品规格或质量升级", "包含额外商品或服务", "历史价格不准确", "其他原因"];
let suggestionTimer = null;

const state = reactive({
  rows: [],
  total: 0,
  people: [],
  suppliers: [],
  suggestions: [],
  filters: { query: "", demandType: "all", bindingStatus: "all", personId: "all", supplierId: "all", sourceType: "all", inventoryCategory: "", productName: "", vehicleBrand: "", vehicleModel: [], accessoryName: "", color: "", material: [], process: "", page: 1, pageSize: 20 }
});

const createForm = reactive(defaultCreateForm());
const bindForm = reactive({ id: null, raw_name: "", raw_spec: "", product_id: null, product_name: "", updated_at: "", source_order_item_id: null, source_online_product_id: null, source_ozon_sku: "" });
const linkForm = reactive({ id: null, product_id: null, product_name: "", image_url: "", purchase_url: "", source_type: "1688", supplier_id: null, updated_at: "" });
const activeItem = computed(() => createForm.items[activeItemIndex.value] || createForm.items[0]);
const totalAmount = computed(() => createForm.items.reduce((sum, item) => sum + Number(item.amount || 0) + Number(item.shipping_amount || 0), 0));
const pagedBulkItems = computed(() => {
  const start = (bulkPage.value - 1) * bulkPageSize.value;
  return bulkItems.value.slice(start, start + bulkPageSize.value);
});
const bulkPurchaseTotal = computed(() => bulkItems.value.reduce((sum, item) => sum + Number(item.amount || 0) + Number(item.shipping_amount || 0), 0));
const orderHistoryTabs = computed(() => {
  const activeRows = orderHistoryRows.value.filter((row) => !row.is_cancelled && !row.is_returned);
  const inactiveRows = orderHistoryRows.value.filter((row) => row.is_cancelled || row.is_returned);
  const definitions = [
    { key: "purchase", title: "P0 真实待采购", type: "danger", rows: activeRows.filter((row) => row.procurement_priority === "P0"), quantityKey: "shortage_quantity" },
    { key: "missing", title: "P1 采购记录缺失", type: "warning", rows: orderHistoryRows.value.filter((row) => !row.is_cancelled && row.procurement_priority === "P1"), quantityKey: "shortage_quantity" },
    { key: "in_transit", title: "采购在途", type: "warning", rows: activeRows.filter((row) => row.coverage_bucket === "in_transit"), quantityKey: "coverage_in_transit_quantity" },
    { key: "covered", title: "已覆盖", type: "success", rows: activeRows.filter((row) => row.coverage_bucket === "covered"), quantityKey: "coverage_completed_quantity" },
    { key: "inactive", title: "P2 取消/退货", type: "info", rows: inactiveRows, quantityKey: "quantity" }
  ];
  return definitions.map((tab) => ({ ...tab, quantity: tab.rows.reduce((sum, row) => sum + Number(row[tab.quantityKey] || 0), 0) }));
});
const activeOrderHistoryTab = computed(() => orderHistoryTabs.value.find((tab) => tab.key === orderHistoryActiveTab.value) || orderHistoryTabs.value[0]);
const visibleOrderHistoryTabs = computed(() => orderHistoryTabs.value.filter((tab) => tab.rows.length > 0));
const realPurchaseShortage = computed(() => Number(orderHistoryTabs.value.find((tab) => tab.key === "purchase")?.quantity || 0));
const missingPurchaseRecordQuantity = computed(() => Number(orderHistoryTabs.value.find((tab) => tab.key === "missing")?.quantity || 0));
const purchaseHistorySummary = computed(() => purchaseHistoryRows.value.reduce((summary, row) => {
  const item = row.saved_values;
  if (!(Number(item.quantity || 0) > 0) || !(Number(item.amount || 0) > 0)) {
    summary.invalid += 1;
    return summary;
  }
  summary.records += 1;
  summary.quantity += Number(item.quantity || 0);
  summary.amount += Number(item.amount || 0);
  summary.shipping += Number(item.shipping_amount || 0);
  return summary;
}, { records: 0, quantity: 0, amount: 0, shipping: 0, invalid: 0 }));
const pendingBindingCount = computed(() => state.rows.filter((row) => !row.product_id).length);
const purchaseGroups = computed(() => {
  const groups = new Map();
  for (const row of state.rows) {
    const source = String(row.source_type || row.product_source_platform || "other").toLowerCase();
    const supplier = String(row.supplier_name || "").trim();
    const url = String(row.purchase_url || row.product_purchase_url || "").trim();
    const host = purchaseHost(url);
    const key = row.supplier_id
      ? `supplier:${row.supplier_id}:${source}`
      : `${source}:${host || "unassigned"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        source,
        supplier: supplier || host || "渠道待补充",
        rows: [],
        links: [],
        quantity: 0,
        amount: 0,
        unbound: 0
      });
    }
    const group = groups.get(key);
    group.rows.push(row);
    group.quantity += Number(row.quantity || 0);
    group.amount += Number(row.amount || 0) + Number(row.shipping_amount || 0);
    group.unbound += row.product_id ? 0 : 1;
    if (url && !group.links.includes(url)) group.links.push(url);
  }
  return Array.from(groups.values()).sort((a, b) => {
    if (a.links.length !== b.links.length) return b.links.length - a.links.length;
    return b.rows.length - a.rows.length;
  });
});

function defaultItem() {
  return { raw_name: "", raw_spec: "", quantity: 1, amount: 0, shipping_amount: 0, purchase_url: "", product_id: null, product_name: "" };
}

function defaultCreateForm() {
  return { person_id: null, source_type: "pdd", supplier_id: null, urgency: "normal", note: "", receipts: [], items: [defaultItem()] };
}

function resetCreateForm() {
  Object.assign(createForm, defaultCreateForm());
  createForm.person_id = preferredPersonId();
  activeItemIndex.value = 0;
  state.suggestions = [];
  inventorySearch.value = "";
  quickInventorySearch.inventoryId = "";
  quickInventorySearch.productName = "";
  quickInventoryResults.value = [];
}

function preferredPersonId() {
  const currentId = Number(authStore.user?.id || 0);
  return state.people.some((person) => Number(person.id) === currentId) ? currentId : state.people[0]?.id || null;
}

function sourceLabel(value) {
  return ({ pdd: "拼多多", wechat: "微信", supplier: "供应商", other: "其他" })[String(value || "").toLowerCase()] || "1688";
}

function purchaseHost(value) {
  try {
    return value ? new URL(value).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

function groupTitle(group) {
  return `${sourceLabel(group.source)} · ${group.supplier}`;
}

function openGroupLinks(group) {
  if (!group.links.length) return ElMessage.warning("这个采购批次还没有采购链接，请先在库存商品中补充链接");
  group.links.forEach((url) => window.open(url, "_blank", "noopener,noreferrer"));
  ElMessage.success(`已打开 ${group.links.length} 个采购链接`);
}

async function confirmGroupPurchase(group) {
  const ids = group.rows.map((row) => Number(row.id)).filter(Boolean);
  if (!ids.length) return;
  try {
    await ElMessageBox.confirm(
      `确认“${groupTitle(group)}”这一批已经完成下单？共 ${group.rows.length} 种商品、${group.quantity} 件。`,
      "确认整批采购",
      { type: "warning", confirmButtonText: "已完成下单", cancelButtonText: "取消" }
    );
    confirmingGroupKey.value = group.key;
    await apiClient.post("/api/procurement/purchase-orders/confirm-from-requests", {
      request_ids: ids,
      person_id: preferredPersonId(),
      note: "采购工作台确认已完成下单"
    });
    ElMessage.success("采购已登记，商品已进入采购在途");
    await loadRows();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "确认采购失败");
  } finally {
    confirmingGroupKey.value = "";
  }
}

function bindingLabel(row) {
  return row.product_id ? "已绑定" : "待绑定";
}

function bindingType(row) {
  return row.product_id ? "success" : "warning";
}

function productImage(row) {
  const id = Number(row?.product_id || 0);
  return id ? `/api/products/${id}/image?thumb=1&w=180` : "";
}

function productPreviewImage(row) {
  const id = Number(row?.product_id || 0);
  return id ? `/api/products/${id}/image` : "";
}

function searchableProductImage(row) {
  const value = withImageToken(productImage(row));
  return value ? new URL(value, window.location.origin).toString() : "";
}

function requestPlugin1688ImageSearch(row) {
  const requestId = `procurement-1688-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const imageUrl = searchableProductImage(row);
  if (!imageUrl) return Promise.reject(new Error("这个商品没有可用于识图的图片"));
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", handleResponse);
      reject(new Error("1688识图未收到插件响应。请确认爆单ERP采购插件已安装并启用，然后刷新当前页面重试"));
    }, 6000);
    function handleResponse(event) {
      if (event.source !== window || event.data?.type !== "OZON_ERP_OPEN_1688_SAME_ITEM_RESPONSE" || event.data?.requestId !== requestId) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", handleResponse);
      const response = event.data?.payload || event.data || {};
      if (response.success === false) reject(new Error(response.error || "1688识图打开失败"));
      else resolve(response);
    }
    window.addEventListener("message", handleResponse);
    window.postMessage({
      type: "OZON_ERP_OPEN_1688_SAME_ITEM_REQUEST",
      requestId,
      payload: { product: { imageUrl, name: row.product_name || row.raw_name || "" } }
    }, window.location.origin);
  });
}

async function open1688ImageSearch(row) {
  imageSearchingId.value = Number(row.id || row.product_id || 0);
  try {
    await requestPlugin1688ImageSearch(row);
    ElMessage.success("已通过商品图片打开 1688 搜同款，找到商品后复制链接回来保存即可");
  } catch (error) {
    ElMessage.error(error.message || "1688识图打开失败");
  } finally {
    imageSearchingId.value = 0;
  }
}

async function openInventoryEditor(row) {
  const productId = Number(row.product_id || 0);
  if (!productId) return;
  try {
    inventoryEditorValue.value = await apiClient.get(`/api/products/${productId}`, { noCache: true });
    inventoryEditorProductId.value = productId;
    inventoryEditorVisible.value = true;
  } catch (error) {
    inventoryEditorValue.value = null;
    inventoryEditorProductId.value = null;
    ElMessage.error(error.message || "库存商品资料加载失败");
  }
}

async function handleInventorySaved() {
  inventoryEditorVisible.value = false;
  inventoryEditorValue.value = null;
  await loadRows();
}

function openQuickComponentCreate({ role = "included" } = {}) {
  quickComponentRole.value = role === "gift" ? "gift" : "included";
  quickComponentCreateVisible.value = true;
}

async function addQuickComponentToInventoryEditor(product = {}) {
  let resolvedProduct = product;
  const productId = Number(product?.id || product?.product_id || 0);
  if (productId && (!product?.name || !product?.stock_unit)) {
    resolvedProduct = await apiClient.get(`/api/products/${productId}`, { noCache: true });
  }
  inventoryEditorRef.value?.addExternalComponentProduct?.(resolvedProduct, quickComponentRole.value);
}

async function handleQuickComponentCreated({ product } = {}) {
  quickComponentCreateVisible.value = false;
  await addQuickComponentToInventoryEditor(product || {});
  ElMessage.success("配件库存已创建并加入当前商品");
}

async function handleQuickComponentExistingSelected(row) {
  quickComponentCreateVisible.value = false;
  await addQuickComponentToInventoryEditor(row || {});
  ElMessage.success("已有配件已加入当前商品");
}

function realOrderRows(row) {
  return (row.requests || [])
    .filter((item) => Number(item.source_order_id || 0) || Number(item.source_order_item_id || 0))
    .sort((a, b) => new Date(b.source_order_ordered_at || 0).getTime() - new Date(a.source_order_ordered_at || 0).getTime());
}

function stockGapOrderRows(row) {
  return Array.isArray(row.stock_gap_orders) ? row.stock_gap_orders : [];
}

function orderStatusLabel(item) {
  const text = [item?.source_order_status || item?.status, item?.source_order_tracking_stage || item?.tracking_stage, item?.source_order_logistics_status || item?.logistics_status]
    .map((value) => String(value || "").toLowerCase()).join(" ");
  if (text.includes("return")) return "已退货";
  if (text.includes("reject") || text.includes("not_accepted") || text.includes("unclaimed")) return "拒收/未领取";
  if (text.includes("delivered") || text.includes("posting_received")) return "已签收";
  if (text.includes("cancel")) return "已取消";
  if (["delivering", "transferring", "carriage", "pickup", "sorting", "customs", "shipped", "sent", "on_way"].some((value) => text.includes(value))) return "运输中";
  if (["awaiting_deliver", "posting_registered", "sent_by_seller", "posting_ready_for_pickup", "posting_transferred_to_courier_service"].some((value) => text.includes(value))) return "等待发货";
  if (["awaiting_registration", "acceptance_in_progress", "awaiting_approve", "awaiting_packaging", "posting_created", "pending_stock"].some((value) => text.includes(value))) return "等待备货";
  return item?.source_order_status || item?.status || "状态未知";
}

function orderTimeText(item) {
  return shanghaiDateTimeText(item?.source_order_ordered_at || item?.ordered_at, { assumeUtcWhenNaive: true });
}

function orderCoverageText(row) {
  if (row.is_cancelled) return "订单已取消，不计采购缺口";
  if (row.is_returned) return "订单已退货，等待库存退回核对";
  if (row.procurement_priority === "P0") return `真实待采购 ${Number(row.shortage_quantity || 0)} 件`;
  if (row.procurement_priority === "P1") return `缺采购来源 ${Number(row.missing_purchase_quantity ?? row.shortage_quantity ?? 0)} 件；收货待核 ${Number(row.missing_receipt_quantity || 0)} 件${row.missing_amount ? "；金额待补" : ""}`;
  if (Number(row.coverage_in_transit_quantity || 0) > 0) return `本订单由采购在途覆盖 ${Number(row.coverage_in_transit_quantity || 0)} 件`;
  return row.procurement_coverage_label || "覆盖来源待核对";
}

async function openOrderHistory(row) {
  orderHistoryProduct.value = row;
  orderHistoryActiveTab.value = "purchase";
  orderHistoryVisible.value = true;
  orderHistoryLoading.value = true;
  try {
    const params = new URLSearchParams({ productId: String(row.product_id), page: "1", pageSize: "1000" });
    const result = await apiClient.get(`/api/procurement/order-history?${params.toString()}`, { noCache: true });
    orderHistoryRows.value = Array.isArray(result?.rows) ? result.rows : [];
    orderHistorySummary.value = result?.summary || {};
    orderHistoryActiveTab.value = orderHistoryTabs.value.find((tab) => tab.rows.length > 0)?.key || "purchase";
  } catch (error) {
    orderHistoryRows.value = [];
    orderHistorySummary.value = {};
    ElMessage.error(error.message || "历史订单加载失败");
  } finally {
    orderHistoryLoading.value = false;
  }
}

async function openCoverageGapPurchase() {
  const row = orderHistoryProduct.value;
  const shortage = Math.max(0, realPurchaseShortage.value);
  if (!row || !shortage) return;
  orderHistoryVisible.value = false;
  selectedDemandRows.value = [{ ...row, suggested_purchase_qty: shortage, total_quantity: shortage }];
  await openBulkPurchase();
}

function realOrderPage(row) {
  return Number(orderDetailPages[row.product_id] || 1);
}

function pagedRealOrderRows(row) {
  const page = realOrderPage(row);
  return realOrderRows(row).slice((page - 1) * 5, page * 5);
}

function setRealOrderPage(row, page) {
  orderDetailPages[row.product_id] = Number(page || 1);
}

function openLinkEditor(row) {
  const request = Array.isArray(row.requests) ? row.requests[0] || {} : row;
  Object.assign(linkForm, {
    id: Number(request.id),
    product_id: Number(row.product_id || 0) || null,
    product_name: row.product_name || row.raw_name || "采购商品",
    image_url: demandImage(row),
    purchase_url: row.purchase_links?.[0] || request.purchase_url || request.product_purchase_url || "",
    source_type: request.source_type || request.product_source_platform || "1688",
    supplier_id: Number(request.supplier_id || 0) || null,
    updated_at: request.updated_at || ""
  });
  linkVisible.value = true;
}

async function savePurchaseLink() {
  const url = String(linkForm.purchase_url || "").trim();
  if (!/^https?:\/\//i.test(url)) return ElMessage.warning("请粘贴完整的采购链接，以 http:// 或 https:// 开头");
  submitting.value = true;
  try {
    await apiClient.put(`/api/procurement/requests/${linkForm.id}`, {
      updated_at: linkForm.updated_at || undefined,
      purchase_url: url,
      source_type: linkForm.source_type,
      supplier_id: linkForm.supplier_id,
      remember_purchase_link: true
    });
    ElMessage.success("采购链接已保存，以后相同库存商品会自动使用这个链接");
    const bulkItem = bulkItems.value.find((item) => Number(item.product_id) === Number(editingBulkProductId.value));
    if (bulkItem) bulkItem.purchase_url = url;
    editingBulkProductId.value = 0;
    linkVisible.value = false;
    await loadRows();
  } catch (error) {
    ElMessage.error(error.message || "采购链接保存失败");
  } finally {
    submitting.value = false;
  }
}

function productCode(row) {
  return row?.product_code || "-";
}

function queryString() {
  const params = new URLSearchParams({
    grouped: "1",
    paged: "1",
    compact: "1",
    page: String(state.filters.page),
    pageSize: String(state.filters.pageSize),
    demandType: state.filters.demandType,
    bindingStatus: state.filters.bindingStatus,
    personId: state.filters.personId
  });
  for (const [key, value] of Object.entries({
    supplierId: state.filters.supplierId,
    sourceType: state.filters.sourceType,
    inventoryCategory: state.filters.inventoryCategory,
    productName: state.filters.productName,
    vehicleBrand: state.filters.vehicleBrand,
    vehicleModel: state.filters.vehicleModel.join(","),
    accessoryName: state.filters.accessoryName,
    color: state.filters.color,
    material: state.filters.material.join(","),
    process: state.filters.process
  })) {
    if (value && value !== "all") params.set(key, value);
  }
  if (state.filters.query.trim()) params.set("query", state.filters.query.trim());
  return params.toString();
}

function demandImage(row) {
  return row.product_image_url || productImage(row);
}

function coverageText(row) {
  return row.coverage_days === null || row.coverage_days === undefined ? "暂无销量" : `${Number(row.coverage_days).toFixed(1)}天`;
}

function handleDemandSelection(rows) {
  selectedDemandRows.value = rows;
}

async function openBulkPurchase() {
  if (!selectedDemandRows.value.length) return ElMessage.warning("请先勾选需要采购的库存商品");
  loading.value = true;
  try {
    const expandedItems = [];
    const coveredComponents = [];
    for (const row of selectedDemandRows.value) {
      const detail = await apiClient.get(`/api/products/${Number(row.product_id)}`, { noCache: true });
      const components = Array.isArray(detail?.composition_items) ? detail.composition_items : [];
      if (!components.length) {
        expandedItems.push(bulkItemFromDemand(row));
        continue;
      }
      const setQuantity = Math.max(1, Number(row.suggested_purchase_qty || row.total_quantity || 1));
      const replacedRequestIds = (row.requests || []).map((item) => Number(item.id)).filter(Boolean);
      for (const component of components) {
        const required = Math.max(1, Math.ceil(setQuantity * Number(component.quantity || 1)));
        const localStock = Number(component.local_stock || 0);
        const incomingStock = Math.max(0, Number(component.incoming_stock || 0));
        const shortage = Math.max(0, required - localStock - incomingStock);
        if (!shortage) {
          coveredComponents.push(`${component.component_name || component.inventory_id}：库存 ${localStock} + 在途 ${incomingStock}，覆盖需求 ${required}`);
          continue;
        }
        const unitCost = Number(component.purchase_cost || 0);
        expandedItems.push({
          product_id: Number(component.component_product_id),
          product_name: component.component_name || component.inventory_id || "未命名子产品",
          product_code: component.inventory_id || component.code || "-",
          image_url: component.image_url || `/api/products/${Number(component.component_product_id)}/image?thumb=1&w=180`,
          request_ids: [], replaces_request_ids: replacedRequestIds, quantity: shortage,
          amount: Number((unitCost * shortage).toFixed(2)), shipping_amount: 0,
          historical_unit_cost: unitCost, historical_purchase_count: 0, purchase_url: "",
          purchase_basis: `套装“${row.product_name}”需要 ${required} 件；子产品库存 ${localStock}，在途 ${incomingStock}，仅采购缺口 ${shortage} 件`,
          anomaly_reason: "", anomaly_note: "", source_row: row, component_of_product_id: Number(row.product_id)
        });
      }
    }
    bulkItems.value = mergeBulkItems(expandedItems);
    if (!bulkItems.value.length) {
      return ElMessageBox.alert(
        coveredComponents.length ? coveredComponents.join("；") : "所选商品库存及在途已可覆盖",
        "子产品无需重复采购",
        { confirmButtonText: "知道了", type: "success" }
      );
    }
  } catch (error) {
    return ElMessage.error(error.message || "套装子产品库存加载失败");
  } finally {
    loading.value = false;
  }
  bulkPage.value = 1;
  Object.assign(bulkMeta, { source_type: "1688", supplier_id: null, note: "", receipts: [], remember_group: false, group_name: "" });
  bulkVisible.value = true;
  loadBulkGroupRecommendations();
}

function bulkItemFromDemand(row) {
    const quantity = Math.max(1, Number(row.suggested_purchase_qty || row.total_quantity || 1));
    const historicalUnitCost = Number(row.historical_avg_unit_cost || 0);
    const requestedAmount = Number(row.total_amount || 0);
    return {
      product_id: Number(row.product_id),
      product_name: row.product_name,
      product_code: row.product_code,
      image_url: demandImage(row),
      request_ids: (row.requests || []).map((item) => Number(item.id)).filter(Boolean),
      quantity,
      amount: requestedAmount > 0 ? Number(requestedAmount.toFixed(2)) : Number((historicalUnitCost * quantity).toFixed(2)),
      shipping_amount: Number(row.total_shipping || 0),
      historical_unit_cost: historicalUnitCost,
      historical_purchase_count: Number(row.historical_purchase_count || 0),
      historical_purchased_quantity: Number(row.historical_purchased_quantity || 0),
      historical_order_count: Number(row.historical_order_count || 0),
      historical_outbound_quantity: Number(row.historical_outbound_quantity || 0),
      historical_purchase_inbound_quantity: Number(row.historical_purchase_inbound_quantity || 0),
      historical_inventory_order_outbound_quantity: Number(row.historical_inventory_order_outbound_quantity || 0),
      historical_return_in_quantity: Number(row.historical_return_in_quantity || 0),
      historical_fbp_transfer_outbound_quantity: Number(row.historical_fbp_transfer_outbound_quantity || 0),
      historical_other_inventory_quantity: Number(row.historical_other_inventory_quantity || 0),
      current_stock: Number(row.stock || 0),
      purchase_url: row.purchase_links?.[0] || row.link_1688 || row.link_pdd || "",
      purchase_basis: purchaseBasis(row),
      anomaly_reason: "",
      anomaly_note: "",
      source_row: row
    };
}

function mergeBulkItems(items) {
  const merged = new Map();
  for (const item of items) {
    const productId = Number(item.product_id);
    if (!merged.has(productId)) {
      merged.set(productId, { ...item, replaces_request_ids: [...new Set(item.replaces_request_ids || [])] });
      continue;
    }
    const target = merged.get(productId);
    target.quantity += Number(item.quantity || 0);
    target.amount = Number((Number(target.amount || 0) + Number(item.amount || 0)).toFixed(2));
    target.replaces_request_ids = [...new Set([...(target.replaces_request_ids || []), ...(item.replaces_request_ids || [])])];
    target.purchase_basis = `${target.purchase_basis}；${item.purchase_basis}`;
  }
  return [...merged.values()];
}

async function loadBulkGroupRecommendations() {
  const ids = bulkItems.value.map((item) => Number(item.product_id)).filter(Boolean);
  if (!ids.length) return;
  try {
    const rows = await apiClient.get(`/api/procurement/purchase-group-recommendations?productIds=${ids.join(",")}`);
    const existing = new Set(ids);
    bulkGroupRecommendations.value = (Array.isArray(rows) ? rows : []).filter((item) => !existing.has(Number(item.product_id)));
  } catch {
    bulkGroupRecommendations.value = [];
  }
}

function bulkItemFromProduct(product, basis = "本次采购手动追加") {
  const quantity = 1;
  const historicalUnitCost = Number(product.historical_avg_unit_cost || 0);
  return {
    product_id: Number(product.product_id), product_name: product.product_name, product_code: product.product_code,
    image_url: product.image_url || `/api/products/${Number(product.product_id)}/image?thumb=1&w=180`, request_ids: [], quantity,
    amount: Number((historicalUnitCost * quantity).toFixed(2)), shipping_amount: 0,
    historical_unit_cost: historicalUnitCost, historical_purchase_count: Number(product.historical_purchase_count || 0),
    historical_purchased_quantity: Number(product.historical_purchased_quantity || 0), historical_order_count: Number(product.historical_order_count || 0),
    historical_outbound_quantity: Number(product.historical_outbound_quantity || 0), current_stock: Number(product.stock || 0),
    purchase_url: product.purchase_url || "", purchase_basis: basis, anomaly_reason: "", anomaly_note: "", source_row: product,
    manually_added: true
  };
}

function addProductToBulk(product, basis) {
  if (bulkItems.value.some((item) => Number(item.product_id) === Number(product.product_id))) return;
  bulkItems.value.push(bulkItemFromProduct(product, basis));
  bulkPage.value = Math.ceil(bulkItems.value.length / bulkPageSize.value);
  bulkGroupRecommendations.value = bulkGroupRecommendations.value.filter((item) => Number(item.product_id) !== Number(product.product_id));
}

function normalizeBulkInventoryProduct(product) {
  const productId = Number(product.id || product.product_id || 0);
  return {
    ...product,
    product_id: productId,
    product_name: product.name || product.product_name || "未命名库存商品",
    product_code: product.code || product.inventory_id || product.product_code || "-",
    image_url: product.image_url || `/api/products/${productId}/image?thumb=1&w=180`,
    historical_avg_unit_cost: Number(product.avg_unit_cost || product.purchase_cost || product.historical_avg_unit_cost || 0),
    purchase_url: product.purchase_url || "",
    reason: "库存商品库"
  };
}

async function searchBulkInventory(page = 1) {
  bulkAddPage.value = Math.max(1, Number(page || 1));
  bulkAddLoading.value = true;
  try {
    const params = new URLSearchParams({ paged: "1", page: String(bulkAddPage.value), pageSize: String(bulkAddPageSize.value) });
    for (const key of ["inventoryCategory", "productName", "vehicleBrand", "vehicleModel", "accessoryName", "color", "material", "process"]) {
      const raw = bulkAddFilters.value[key];
      const value = Array.isArray(raw) ? raw.join(",") : String(raw || "").trim();
      if (value) params.set(key, value);
    }
    const result = await apiClient.get(`/api/products?${params.toString()}`);
    bulkAddResults.value = (Array.isArray(result?.rows) ? result.rows : []).map(normalizeBulkInventoryProduct);
    bulkAddTotal.value = Number(result?.total || 0);
  } catch (error) {
    bulkAddResults.value = [];
    bulkAddTotal.value = 0;
    ElMessage.error(error.message || "搜索库存商品失败");
  } finally {
    bulkAddLoading.value = false;
  }
}

function resetBulkInventorySearch() {
  bulkAddFilters.value = { inventoryCategory: "", productName: "", vehicleBrand: "", vehicleModel: [], accessoryName: "", color: "", material: [], process: "" };
  searchBulkInventory(1);
}

function isProductInBulk(product) {
  return bulkItems.value.some((item) => Number(item.product_id) === Number(product.product_id));
}

function removeBulkItem(item) {
  bulkItems.value = bulkItems.value.filter((row) => Number(row.product_id) !== Number(item.product_id));
  bulkPage.value = Math.min(bulkPage.value, Math.max(1, Math.ceil(bulkItems.value.length / bulkPageSize.value)));
}

async function uploadBulkReceipt(file) {
  uploadingReceipt.value = true;
  try {
    const result = await uploadTeamAttachment(file.raw || file);
    bulkMeta.receipts.push({ name: result.name || file.name || "采购凭证", url: result.url });
    ElMessage.success("采购凭证已上传");
  } catch (error) {
    ElMessage.error(error.message || "采购凭证上传失败");
  } finally {
    uploadingReceipt.value = false;
  }
}

function purchaseBasis(row) {
  const orderQty = Number(row.order_demand_quantity || 0);
  const coverage = row.coverage_days === null || row.coverage_days === undefined ? null : Number(row.coverage_days);
  const sales30 = Number(row.recent_30d_qty || 0);
  const parts = [];
  if (orderQty > 0) parts.push(`真实订单缺口 ${orderQty} 件`);
  if (coverage !== null && coverage < 7) parts.push(`现有库存仅够 ${coverage.toFixed(1)} 天`);
  if (!parts.length && sales30 > 0) parts.push(`近30天销售 ${sales30} 件`);
  parts.push(`建议备至 ${Number(row.target_days || 7)} 天`);
  return parts.join("；");
}

async function openPurchaseHistory(row, { preserveEdits = false, savedId = 0 } = {}) {
  const drafts = new Map(preserveEdits ? purchaseHistoryRows.value.filter(item => Number(item.id) !== savedId).map(item => [Number(item.id), item]) : []);
  purchaseHistoryProduct.value = row;
  purchaseCorrection.value = null;
  purchaseHistoryRows.value = [];
  purchaseHistoryVisible.value = true;
  purchaseHistoryLoading.value = true;
  try {
    const result = await apiClient.get(`/api/procurement/purchase-history?productId=${Number(row.product_id)}`);
    const rows = Array.isArray(result?.rows) ? result.rows : Array.isArray(result) ? result : [];
    purchaseHistoryRows.value = rows.map((item) => ({
      ...item,
      quantity: Number(item.quantity || 0),
      amount: Number(item.amount || 0),
      shipping_amount: Number(item.shipping_amount || 0),
      purchase_unit_price: Number(item.quantity || 0) > 0 ? Number(item.amount || 0) / Number(item.quantity) : 0,
      saved_values: { ...item },
      correction_reason: "",
      correct_received: false,
      ...(drafts.has(Number(item.id)) ? Object.fromEntries(['quantity', 'amount', 'shipping_amount', 'correction_reason', 'correct_received'].map(key => [key, drafts.get(Number(item.id))[key]])) : {})
    }));
  } catch (error) {
    ElMessage.error(error.message || "采购记录加载失败");
  } finally {
    purchaseHistoryLoading.value = false;
  }
}

async function previewPurchaseHistoryCorrection(row) {
  if (purchaseHistorySaving.value) return;
  if ([row.quantity, row.amount, row.shipping_amount].some((value) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) || Number(value) < 0)) return ElMessage.warning("请在采购记录行填写完整的采购数量、采购金额和运费，数值不能为负数");
  if (!String(row.correction_reason || "").trim()) return ElMessage.warning("请在该行的纠错原因中说明修改依据，再保存采购记录");
  purchaseHistorySaving.value = true;
  purchaseHistorySavingId.value = Number(row.id);
  try {
    const productId = Number(purchaseHistoryProduct.value.product_id);
    const payload = {
      action_type: "revise_purchase", product_id: productId, purchase_item_id: Number(row.id),
      quantity: Number(row.quantity), amount: Number(row.amount), shipping_amount: Number(row.shipping_amount || 0),
      correct_received: row.correct_received === true, reason: row.correction_reason.trim(),
      expected_purchase: row.saved_values, request_key: crypto.randomUUID()
    };
    const preview = await apiClient.post("/api/procurement/ledger/preview", payload);
    purchaseCorrection.value = { payload: { ...payload, revision: preview.revision }, preview };
  } catch (error) {
    ElMessage.error(error.message || "采购纠错预览失败");
  } finally {
    purchaseHistorySaving.value = false;
  }
}

function openPurchaseBackfill() {
  Object.assign(purchaseBackfillForm, { quantity: 1, amount: null, shipping_amount: 0,
    purchased_at: shanghaiDateTimeText(new Date()).replaceAll('/', '-').replace(' ', 'T'), inventory_effect: '', reason: '' });
  purchaseBackfillVisible.value = true;
}

async function previewPurchaseBackfill() {
  if (purchaseHistorySaving.value) return;
  const form = purchaseBackfillForm;
  if (!Number.isInteger(Number(form.quantity)) || !(Number(form.quantity) > 0) || !(Number(form.amount) > 0)) return ElMessage.warning('请填写采购数量和货款，数量须为正整数，货款须大于 0');
  if (!form.purchased_at || !form.inventory_effect) return ElMessage.warning('请选择实际采购时间（北京时间）和收货状态，再保存补录');
  purchaseHistorySaving.value = true;
  purchaseHistorySavingId.value = 0;
  try {
    const payload = { action_type: 'record_purchase', product_id: Number(purchaseHistoryProduct.value.product_id),
      quantity: Number(form.quantity), amount: Number(form.amount), shipping_amount: Number(form.shipping_amount || 0),
      purchased_at: `${form.purchased_at}+08:00`, inventory_effect: form.inventory_effect,
      reason: form.reason.trim() || '在采购记录中补录实际采购', request_key: crypto.randomUUID() };
    const preview = await apiClient.post('/api/procurement/ledger/preview', payload);
    purchaseCorrection.value = { payload: { ...payload, revision: preview.revision }, preview };
  } catch (error) {
    ElMessage.error(error.message || '采购补录预览失败');
  } finally {
    purchaseHistorySaving.value = false;
  }
}

async function savePurchaseHistoryCorrection() {
  if (!purchaseCorrection.value || purchaseHistorySaving.value) return;
  purchaseHistorySaving.value = true;
  try {
    const payload = purchaseCorrection.value.payload;
    await apiClient.post("/api/procurement/ledger", payload);
    purchaseCorrection.value = null;
    purchaseBackfillVisible.value = false;
    ElMessage.success(payload.action_type === 'record_purchase' ? '采购已补录，时间与收货状态已保存' : '采购记录已纠正，采购汇总、库存和关联订单已同步更新');
    await openPurchaseHistory(purchaseHistoryProduct.value, { preserveEdits: true, savedId: Number(payload.purchase_item_id || 0) });
    // Refresh the wider workbench without holding the record editor behind its loading mask.
    void loadRows({ refreshDemand: false, silent: true });
    const summary = purchaseHistorySummary.value;
    for (const item of bulkItems.value.filter((item) => Number(item.product_id) === Number(purchaseHistoryProduct.value.product_id))) {
      item.historical_unit_cost = summary.quantity > 0 ? summary.amount / summary.quantity : 0;
      item.historical_purchase_count = summary.records;
      item.historical_purchased_quantity = summary.quantity;
    }
  } catch (error) {
    ElMessage.error(error.message || "保存采购纠错失败");
  } finally {
    purchaseHistorySaving.value = false;
  }
}

function historyUnitPrice(row) {
  const quantity = Number(row.quantity || 0);
  return quantity > 0 ? Number(row.amount || 0) / quantity : 0;
}

function procurementStatusText(row) {
  return ({
    pending: "待采购",
    suggested: "待采购",
    submitted: "待采购",
    merged: "采购在途",
    purchased: "采购在途",
    pending_arrival: "采购在途",
    done: "已入库",
    inbound_done: "已入库",
    partial_inbound: "部分入库",
    cancelled: "已取消"
  })[String(row.status || "")] || row.status || "-";
}

function openBulkPurchaseUrl(item) {
  if (!item.purchase_url) return;
  window.open(item.purchase_url, "_blank", "noopener,noreferrer");
}

function openBulkLinkEditor(item) {
  editingBulkProductId.value = Number(item.product_id || 0);
  openLinkEditor(item.source_row || item);
}

function normalizeBulkMoney(item, field) {
  item[field] = Number(Math.max(0, Number(item[field] || 0)).toFixed(2));
}

function currentBulkUnitCost(item) {
  const quantity = Number(item.quantity || 0);
  return quantity > 0 ? Number(item.amount || 0) / quantity : 0;
}

function bulkPriceChange(item) {
  const historical = Number(item.historical_unit_cost || 0);
  return historical > 0 ? (currentBulkUnitCost(item) - historical) / historical : null;
}

function historicalDebt(item) {
  return Math.max(0, -Number(item.current_stock ?? item.source_row?.stock ?? 0));
}

function remainingSupply(item) {
  const currentStock = Number(item.current_stock ?? item.source_row?.stock ?? 0);
  const incomingStock = Math.max(0, Number(item.source_row?.incoming_stock ?? 0));
  return Math.max(0, currentStock) + incomingStock;
}

async function saveBulkPurchase() {
  const invalid = bulkItems.value.find((item) => !(Number(item.quantity) > 0));
  if (invalid) return ElMessage.warning(`${invalid.product_name} 的采购数量必须大于0`);
  const missingAmount = bulkItems.value.find((item) => Number(item.amount) < 0);
  if (missingAmount) return ElMessage.warning(`${missingAmount.product_name} 的采购金额不能为负数；未知金额可稍后补齐`);
  const priceAnomaly = bulkItems.value.find((item) => bulkPriceChange(item) > 0.1 && !item.anomaly_reason);
  if (priceAnomaly) return ElMessage.warning(`${priceAnomaly.product_name} 的单价上涨超过10%，请选择价格异常原因`);
  const otherReason = bulkItems.value.find((item) => bulkPriceChange(item) > 0.1 && item.anomaly_reason === "其他原因" && !String(item.anomaly_note || "").trim());
  if (otherReason) return ElMessage.warning(`${otherReason.product_name} 选择了其他原因，请补充说明`);
  bulkSaving.value = true;
  try {
    const addedItems = bulkItems.value.filter((item) => !item.request_ids.length);
    let addedRequestIds = [];
    if (addedItems.length) {
      const created = await apiClient.post("/api/procurement/requests", {
        person_id: preferredPersonId(), source_type: bulkMeta.source_type, supplier_id: bulkMeta.supplier_id,
        note: "采购单内手动追加", items: addedItems.map((item) => ({
          product_id: item.product_id, raw_name: item.product_name, quantity: item.quantity, amount: item.amount,
          shipping_amount: item.shipping_amount, purchase_url: item.purchase_url, source_type: bulkMeta.source_type,
          supplier_id: bulkMeta.supplier_id, note: "采购单内手动追加"
        }))
      });
      addedRequestIds = created?.ids || [];
    }
    const requestIds = [...new Set([...bulkItems.value.flatMap((item) => item.request_ids), ...addedRequestIds].map(Number).filter(Boolean))];
    if (!requestIds.length) throw new Error("采购单没有可处理的采购商品");
    const items = bulkItems.value.map((item) => ({
      product_id: Number(item.product_id),
      actual_quantity: Number(item.quantity || 0),
      amount: Number(item.amount || 0),
      shipping_amount: Number(item.shipping_amount || 0),
      purchase_url: item.purchase_url || "",
      anomaly_reason: item.anomaly_reason === "其他原因"
        ? `其他原因：${String(item.anomaly_note || "").trim()}`
        : item.anomaly_reason || ""
    }));
    await apiClient.post("/api/procurement/purchase-orders/confirm-from-requests", {
      request_ids: requestIds,
      person_id: preferredPersonId(),
      source_type: bulkMeta.source_type, supplier_id: bulkMeta.supplier_id,
      receipts: bulkMeta.receipts, remember_group: bulkMeta.remember_group, group_name: bulkMeta.group_name,
      note: bulkMeta.note || "采购工作台批量采购",
      items
    });
    const replacedRequests = new Map();
    for (const item of bulkItems.value) {
      for (const requestId of item.replaces_request_ids || []) {
        const sourceRequest = item.source_row?.requests?.find((request) => Number(request.id) === Number(requestId));
        if (sourceRequest) replacedRequests.set(Number(requestId), sourceRequest);
      }
    }
    try {
      await Promise.all([...replacedRequests.entries()].map(([requestId, request]) => apiClient.put(`/api/procurement/requests/${requestId}`, {
        status: "cancelled",
        updated_at: request.updated_at,
        note: `${request.note || ""}；套装已拆分为缺货子产品采购`
      })));
    } catch {
      ElMessage.warning("子产品采购已登记，但原套装任务状态更新失败，请刷新工作台后检查");
    }
    ElMessage.success(`已完成 ${items.length} 个库存商品的采购登记，现已进入待入库`);
    bulkVisible.value = false;
    selectedDemandRows.value = [];
    await loadRows();
  } catch (error) {
    ElMessage.error(error.message || "批量采购保存失败");
  } finally {
    bulkSaving.value = false;
  }
}

async function loadRows(options = {}) {
  const { silent = false } = options || {};
  if (disposed) return;
  rowsController?.abort();
  const controller = new AbortController();
  rowsController = controller;
  if (!silent) loading.value = true;
  try {
    const result = await apiClient.get(`/api/procurement/requests?${queryString()}`, { signal: controller.signal });
    if (controller.signal.aborted || disposed) return;
    state.rows = Array.isArray(result?.rows) ? result.rows : [];
    state.total = Number(result?.total || 0);
  } catch (error) {
    if (!controller.signal.aborted && !disposed) ElMessage.error(error.message || "采购工作台加载失败");
  } finally {
    if (rowsController === controller) loading.value = false;
  }
}

async function refreshWorkbench() {
  if (demandRefreshing.value || disposed) return;
  demandRefreshing.value = true;
  try {
    await apiClient.post("/api/procurement/refresh-demand");
    await loadRows({ silent: true });
  } catch (error) {
    if (!disposed) ElMessage.warning(error.message || "采购需求更新失败，当前显示已有记录，请点击刷新重试");
  } finally {
    demandRefreshing.value = false;
  }
}

async function loadOptions() {
  const [people, suppliers] = await Promise.all([
    apiClient.get("/api/people"),
    apiClient.get("/api/suppliers?paged=1&page=1&pageSize=100")
  ]);
  state.people = Array.isArray(people) ? people.filter((item) => Number(item.active) !== 0) : [];
  state.suppliers = Array.isArray(suppliers?.rows) ? suppliers.rows : [];
}

function handleSearch() {
  state.filters.page = 1;
  loadRows();
}

function handleReset() {
  Object.assign(state.filters, { query: "", demandType: "all", bindingStatus: "all", personId: "all", supplierId: "all", sourceType: "all", inventoryCategory: "", productName: "", vehicleBrand: "", vehicleModel: [], accessoryName: "", color: "", material: [], process: "", page: 1, pageSize: 20 });
  loadRows();
}

function handlePageChange(page) {
  state.filters.page = Number(page || 1);
  selectedDemandRows.value = [];
  loadRows();
}

function handlePageSizeChange(pageSize) {
  state.filters.pageSize = Number(pageSize || 20);
  state.filters.page = 1;
  selectedDemandRows.value = [];
  loadRows();
}

function openCreate() {
  resetCreateForm();
  createVisible.value = true;
}

function addItem() {
  createForm.items.push(defaultItem());
  activeItemIndex.value = createForm.items.length - 1;
  state.suggestions = [];
}

function removeItem(index) {
  if (createForm.items.length === 1) return;
  createForm.items.splice(index, 1);
  activeItemIndex.value = Math.min(activeItemIndex.value, createForm.items.length - 1);
  scheduleSuggestions();
}

function setActiveItem(index) {
  activeItemIndex.value = index;
  scheduleSuggestions();
}

function scheduleSuggestions() {
  clearTimeout(suggestionTimer);
  suggestionTimer = setTimeout(loadSuggestions, 260);
}

async function loadSuggestions(queryOverride = "") {
  const text = String(queryOverride || activeItem.value?.raw_name || bindForm.raw_name || "").trim();
  if (!text) {
    state.suggestions = [];
    return;
  }
  suggestionLoading.value = true;
  try {
    state.suggestions = await apiClient.get(`/api/procurement/binding-suggestions?query=${encodeURIComponent(text)}`) || [];
  } catch (error) {
    state.suggestions = [];
  } finally {
    suggestionLoading.value = false;
  }
}

function chooseSuggestion(suggestion) {
  if (bindVisible.value) {
    bindForm.product_id = Number(suggestion.product_id);
    bindForm.product_name = suggestion.product_name;
    return;
  }
  activeItem.value.product_id = Number(suggestion.product_id);
  activeItem.value.product_name = suggestion.product_name;
}

function searchInventorySuggestions() {
  const text = String(inventorySearch.value || "").trim();
  if (!text) return ElMessage.warning("请输入库存名称或编码");
  loadSuggestions(text);
}

function normalizeQuickInventoryProduct(product) {
  const productId = Number(product?.id || product?.product_id || 0);
  return {
    product_id: productId,
    product_name: product?.name || product?.product_name || "未命名库存商品",
    product_code: product?.inventory_id || product?.code || product?.product_code || "-",
    image_url: product?.image_url || (productId ? `/api/products/${productId}/image?thumb=1&w=180` : "")
  };
}

async function searchQuickInventory(mode) {
  const query = String(mode === "inventory_id" ? quickInventorySearch.inventoryId : quickInventorySearch.productName).trim();
  if (!query) return ElMessage.warning(mode === "inventory_id" ? "请输入库存 ID" : "请输入商品名称");
  quickInventoryLoading.value = true;
  try {
    const params = new URLSearchParams({ paged: "1", page: "1", pageSize: "12", query, searchMode: mode });
    const result = await apiClient.get(`/api/products?${params.toString()}`);
    quickInventoryResults.value = (Array.isArray(result?.rows) ? result.rows : []).map(normalizeQuickInventoryProduct);
  } catch (error) {
    quickInventoryResults.value = [];
    ElMessage.error(error.message || "搜索库存商品失败");
  } finally {
    quickInventoryLoading.value = false;
  }
}

function chooseQuickInventory(product) {
  if (!activeItem.value) return;
  activeItem.value.product_id = Number(product.product_id);
  activeItem.value.product_name = product.product_name;
  state.suggestions = [];
  ElMessage.success(`已选择库存：${product.product_name}`);
}

function openQuickInventoryCreate() {
  quickInventoryCreateVisible.value = true;
}

async function handleQuickInventoryCreated({ product } = {}) {
  const productId = Number(product?.id || product?.product_id || 0);
  if (!productId || !activeItem.value) return;
  chooseQuickInventory(normalizeQuickInventoryProduct(product));
  quickInventoryCreateVisible.value = false;
  ElMessage.success("库存已创建并绑定到当前采购明细");
}

function handleQuickInventoryExistingSelected(product = {}) {
  chooseQuickInventory(normalizeQuickInventoryProduct(product));
  quickInventoryCreateVisible.value = false;
  ElMessage.success("已选用已有库存并绑定到当前采购明细");
}

function clearItemBinding() {
  activeItem.value.product_id = null;
  activeItem.value.product_name = "";
}

async function uploadReceipt(file) {
  uploadingReceipt.value = true;
  try {
    const result = await uploadTeamAttachment(file.raw || file);
    createForm.receipts.push({ name: result.name || file.name || "采购凭证", url: result.url });
    ElMessage.success("采购凭证已上传");
  } catch (error) {
    ElMessage.error(error.message || "采购凭证上传失败");
  } finally {
    uploadingReceipt.value = false;
  }
}

function removeReceipt(index) {
  createForm.receipts.splice(index, 1);
}

async function submitCreate() {
  if (!createForm.person_id) return ElMessage.warning("请选择采购负责人");
  const invalidIndex = createForm.items.findIndex((item) => !Number(item.product_id || 0));
  if (invalidIndex >= 0) {
    activeItemIndex.value = invalidIndex;
    return ElMessage.warning(`第 ${invalidIndex + 1} 条采购明细尚未绑定库存商品，无法登记采购在途`);
  }
  submitting.value = true;
  try {
    const receiptNote = createForm.receipts.length
      ? `采购凭证：${createForm.receipts.map((item) => item.url).join("，")}`
      : "";
    await apiClient.post("/api/procurement/purchases", {
      person_id: createForm.person_id,
      source_type: createForm.source_type,
      supplier_id: createForm.supplier_id,
      urgency: createForm.urgency,
      note: [createForm.note, receiptNote].filter(Boolean).join("；"),
      items: createForm.items.map((item) => ({ ...item, quantity: Number(item.quantity || 1), amount: Number(item.amount || 0), shipping_amount: Number(item.shipping_amount || 0) }))
    });
    ElMessage.success(`已登记 ${createForm.items.length} 条采购，现已进入采购在途`);
    createVisible.value = false;
    await loadRows();
  } catch (error) {
    ElMessage.error(error.message || "创建采购失败");
  } finally {
    submitting.value = false;
  }
}

function openBind(row) {
  const request = Array.isArray(row.requests) ? row.requests[0] || {} : row;
  Object.assign(bindForm, {
    id: Number(request.id), raw_name: request.raw_name || row.product_name || "", raw_spec: request.raw_spec || "",
    product_id: Number(row.product_id || 0) || null, product_name: row.product_id ? row.product_name : "", updated_at: request.updated_at || "",
    source_order_item_id: Number(request.source_order_item_id || 0) || null,
    source_online_product_id: Number(request.source_online_product_id || 0) || null,
    source_ozon_sku: request.source_ozon_sku || ""
  });
  bindVisible.value = true;
  inventorySearch.value = "";
  loadSuggestions(bindForm.raw_name);
}

async function saveBinding() {
  if (!bindForm.product_id) return ElMessage.warning("请选择要绑定的库存商品");
  submitting.value = true;
  try {
    if (bindForm.source_order_item_id) {
      if (!bindForm.source_online_product_id) throw new Error("当前订单 SKU 缺少在线商品 ID，请先同步在线商品后再修改绑定");
      await apiClient.post("/api/online-products/bind", {
        online_product_id: bindForm.source_online_product_id,
        order_item_id: bindForm.source_order_item_id,
        ozon_sku: bindForm.source_ozon_sku,
        product_id: Number(bindForm.product_id),
        person_id: preferredPersonId(),
        inventory_recipe: { mode: "single", items: [] }
      });
      ElMessage.success("订单 SKU 已重新绑定库存，采购需求已按新库存重新归组");
    } else {
      await apiClient.put(`/api/procurement/requests/${bindForm.id}`, {
        updated_at: bindForm.updated_at || undefined,
        raw_name: bindForm.raw_name,
        raw_spec: bindForm.raw_spec,
        product_id: bindForm.product_id
      });
      ElMessage.success("库存绑定已保存，系统会把这次确认用于后续推荐");
    }
    bindVisible.value = false;
    await loadRows();
  } catch (error) {
    ElMessage.error(error.message || "绑定库存失败");
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  await Promise.all([
    loadRows(),
    loadOptions().then(resetCreateForm).catch((error) => ElMessage.error(error.message || "采购基础资料加载失败"))
  ]);
  void refreshWorkbench();
  if (Number(route.query.review_product_id) > 0) {
    await openOrderHistory({ product_id: Number(route.query.review_product_id), product_name: `核对订单 ${route.query.review_order_no || ''} 的库存来源` });
    if (orderHistoryTabs.value.some(tab => tab.key === 'missing' && tab.rows.length)) orderHistoryActiveTab.value = 'missing';
  }
});
</script>

<template>
  <div class="page-stack procurement-workspace">
    <ProcurementLedgerDialog v-if="ledgerVisible" v-model="ledgerVisible" :product-id="ledgerProductId" @saved="loadRows(); orderHistoryVisible && openOrderHistory(orderHistoryProduct)" />
    <ErpPageHeader title="采购工作台" description="系统自动汇总采购需求；采购人员按供应商集中下单，不再逐个订单处理。">
      <template #actions>
        <DailyPurchaseExport />
        <el-button @click="openLedger()">采购与库存对账</el-button>
        <el-button type="primary" plain>系统任务采购（{{ state.total }}）</el-button>
        <el-button type="primary" @click="openCreate">＋ 自由采购</el-button>
        <el-button class="erp-btn erp-btn-secondary" :loading="demandRefreshing" @click="refreshWorkbench">{{ demandRefreshing ? '需求更新中' : '刷新' }}</el-button>
      </template>
    </ErpPageHeader>

    <el-card shadow="never" class="page-card">
      <ErpFilterBar>
        <el-form inline>
          <el-form-item label="关键词">
            <el-input v-model="state.filters.query" placeholder="商品 / 供应商 / 链接 / 负责人" clearable @keyup.enter="handleSearch" />
          </el-form-item>
          <el-form-item label="需求类型">
            <el-select v-model="state.filters.demandType" filterable style="width: 150px" @change="handleSearch">
              <el-option label="全部待采购" value="all" />
              <el-option label="真实订单采购" value="real_order" />
              <el-option label="提前采购" value="advance_stock" />
              <el-option label="库存采购申请" value="warehouse_request" />
            </el-select>
          </el-form-item>
          <el-form-item label="库存绑定">
            <el-select v-model="state.filters.bindingStatus" filterable style="width: 130px" @change="handleSearch">
              <el-option label="全部" value="all" />
              <el-option label="待绑定" value="unbound" />
              <el-option label="已绑定" value="bound" />
            </el-select>
          </el-form-item>
          <el-form-item label="采购负责人">
            <el-select v-model="state.filters.personId" filterable style="width: 150px" @change="handleSearch">
              <el-option label="全部" value="all" />
              <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="String(person.id)" />
            </el-select>
          </el-form-item>
          <el-form-item label="供应商">
            <el-select v-model="state.filters.supplierId" filterable clearable style="width: 160px" placeholder="全部供应商" @change="handleSearch">
              <el-option label="全部供应商" value="all" />
              <el-option v-for="supplier in state.suppliers" :key="supplier.id" :label="supplier.name" :value="String(supplier.id)" />
            </el-select>
          </el-form-item>
          <el-form-item label="采购平台">
            <el-select v-model="state.filters.sourceType" filterable clearable style="width: 140px" placeholder="全部平台" @change="handleSearch">
              <el-option label="全部平台" value="all" />
              <el-option label="1688" value="1688" />
              <el-option label="拼多多" value="pdd" />
              <el-option label="微信采购" value="wechat" />
              <el-option label="供应商直采" value="supplier" />
              <el-option label="线下采购" value="offline" />
              <el-option label="其他" value="other" />
            </el-select>
          </el-form-item>
        </el-form>
        <template #actions>
          <el-button type="primary" :disabled="!selectedDemandRows.length" @click="openBulkPurchase">采购选中（{{ selectedDemandRows.length }}）</el-button>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </template>
      </ErpFilterBar>

      <InventoryStructuredSearch
        compact
        class="procurement-structured-search"
        :model-value="state.filters"
        @update:model-value="Object.assign(state.filters, $event)"
        @change="handleSearch"
      />

      <el-table v-loading="loading" :data="state.rows" row-key="product_id" border height="calc(100vh - 350px)" class="demand-table" @selection-change="handleDemandSelection">
        <el-table-column type="selection" width="48" fixed="left" />
        <el-table-column label="库存商品" min-width="340" fixed="left">
          <template #default="{ row }">
            <div class="demand-product-card">
              <ProductImagePreview :src="demandImage(row)" :preview-list="[productPreviewImage(row)]" alt="点击查看库存商品原图" size="portrait" fit="cover" />
              <div><strong>{{ row.product_name }}</strong><span>{{ row.product_code || '-' }}</span><span>SKU：{{ row.mapped_skus || '未绑定SKU' }}</span><div class="row-actions"><el-button link type="primary" @click="openInventoryEditor(row)">编辑库存商品</el-button><el-button link type="primary" @click="openLedger(row)">库存对账／补录</el-button></div></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="采购建议" min-width="210">
          <template #default="{ row }">
            <div class="purchase-suggestion">
              <div class="purchase-suggestion-main">
                <strong class="suggested-qty">建议采购 {{ Number(row.primary_suggested_purchase_qty || row.suggested_purchase_qty || row.total_quantity || 0) }} 件</strong>
                <el-tag v-if="row.primary_suggestion_reason" size="small" effect="plain" :type="suggestionReasonTagType(row.primary_suggestion_reason.type)">{{ row.primary_suggestion_reason.label }}</el-tag>
              </div>
              <el-popover v-if="realOrderRows(row).length" placement="right-start" :width="620" trigger="click">
                <template #reference><el-button link type="primary">查看 {{ realOrderRows(row).length }} 个关联订单 ▾</el-button></template>
                <div class="source-order-list">
                  <div v-for="item in pagedRealOrderRows(row)" :key="item.id" class="source-order-item">
                    <ProductImagePreview :src="item.source_order_image_url || demandImage(row)" size="portrait" fit="cover" />
                    <div><strong>{{ item.source_order_product_name || item.raw_name || row.product_name }}</strong><span>订单：{{ item.source_posting_number || item.source_order_number || item.source_order_id }}</span><span>{{ item.source_shop_name || '未标注店铺' }} · SKU {{ item.source_ozon_sku || '-' }}</span><span>下单时间：{{ orderTimeText(item) }}</span><span>订单状态：<el-tag size="small" effect="plain">{{ orderStatusLabel(item) }}</el-tag> · 采购需求 {{ Number(item.quantity || 0) }} 件</span><el-button link type="primary" class="source-bind-action" @click="openBind(item)">调整该 SKU 的库存绑定</el-button></div>
                  </div>
                  <el-pagination v-if="realOrderRows(row).length > 5" small background layout="prev, pager, next" :page-size="5" :total="realOrderRows(row).length" :current-page="realOrderPage(row)" @current-change="setRealOrderPage(row, $event)" />
                </div>
              </el-popover>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="近期销量" min-width="190" align="center">
          <template #default="{ row }"><div class="sales-summary"><strong>30天 {{ Number(row.recent_30d_qty || 0) }}</strong><span>近7天 {{ Number(row.recent_7d_qty || 0) }}</span><small>三周 {{ row.week3_qty || 0 }} → {{ row.week2_qty || 0 }} → {{ row.week1_qty || 0 }}</small></div></template>
        </el-table-column>
        <el-table-column label="需求原因" min-width="250">
          <template #default="{ row }">
            <p class="demand-reason">{{ row.demand_reason }}</p><div v-for="detail in warehouseRequestDetails(row)" :key="detail.id" class="warehouse-request-detail"><small class="demand-reason">{{ detail.text }}</small><el-button link type="danger" @click="rejectWarehouseRequest(detail.request)">拒绝申请</el-button></div>
          </template>
        </el-table-column>
        <el-table-column label="库存状态" min-width="250" align="center">
          <template #default="{ row }"><div class="inventory-metrics"><div><span>本地库存</span><strong>{{ Number(row.stock || 0) }}</strong></div><div><span>FBP库存</span><strong>{{ Number(row.fbp_available || 0) }}</strong></div><div><span>采购在途</span><strong>{{ Number(row.incoming_stock || 0) }}</strong></div><div><span>FBP在途</span><strong>{{ Number(row.fbp_transfer_in_transit_qty || 0) }}</strong></div></div></template>
        </el-table-column>
        <el-table-column label="历史订单" min-width="220" align="center">
          <template #default="{ row }"><div class="order-history-summary"><span>出单数 <strong>{{ Number(row.historical_total_order_count || 0) }}</strong></span><span>取消 <strong class="history-cancelled">{{ Number(row.historical_cancelled_quantity || 0) }}</strong></span><span>退货 <strong class="history-returned">{{ Number(row.historical_returned_quantity || 0) }}</strong></span><el-button link type="primary" @click="openOrderHistory(row)">查看明细</el-button></div></template>
        </el-table-column>
        <el-table-column label="历史采购" min-width="190" align="center">
          <template #default="{ row }"><div class="order-history-summary"><span>总采购数 <strong>{{ Number(row.historical_purchased_quantity || 0) }} 件</strong></span><span>总采购金额 <strong>¥{{ Number(row.historical_purchase_amount || 0).toFixed(2) }}</strong></span><span v-if="Number(row.historical_purchase_record_missing_quantity || 0) > 0" class="history-cancelled">采购记录缺失 {{ Number(row.historical_purchase_record_missing_quantity) }} 件</span><el-button link type="primary" @click="openPurchaseHistory(row)">查看采购明细</el-button></div></template>
        </el-table-column>
        <el-table-column label="采购链接" min-width="190">
          <template #default="{ row }"><div class="purchase-link-actions"><a v-if="row.purchase_links?.length" :href="row.purchase_links[0]" target="_blank" rel="noreferrer">打开采购链接</a><el-button link type="primary" :loading="imageSearchingId === Number(row.product_id)" @click="open1688ImageSearch(row)">1688识图</el-button><el-button link type="primary" @click="openLinkEditor(row)">{{ row.purchase_links?.length ? '修改采购链接' : '添加采购链接' }}</el-button></div></template>
        </el-table-column>
      </el-table>
      <PageFooterPagination :total="state.total" :page="state.filters.page" :page-size="state.filters.pageSize" :page-sizes="[20, 50, 100]" @update:page="handlePageChange" @update:pageSize="handlePageSizeChange" />
    </el-card>

    <el-dialog v-model="orderHistoryVisible" title="历史订单与采购覆盖" width="1380px" align-center destroy-on-close class="order-history-dialog">
      <div v-loading="orderHistoryLoading" class="coverage-audit">
        <div class="coverage-product-context"><div class="coverage-product-main"><ProductImagePreview :src="demandImage(orderHistoryProduct || {})" size="portrait" fit="cover" /><div><strong>{{ orderHistoryProduct?.product_name || '库存商品' }}</strong><span>{{ orderHistoryProduct?.product_code || '-' }} · SKU {{ orderHistoryProduct?.mapped_skus || '未绑定' }}</span></div></div><div class="coverage-product-total"><span>历史订单</span><strong>{{ Number(orderHistorySummary.total_quantity || 0) }} 件</strong></div></div>
        <el-button type="primary" plain @click="openLedger(orderHistoryProduct)">核对历史缺口／补录来源</el-button>
        <el-alert v-if="missingPurchaseRecordQuantity" type="warning" :closable="false" show-icon :title="`${missingPurchaseRecordQuantity} 件订单已经进入运输或签收，但系统缺少采购记录。请区分采购漏记与收货漏记，历史缺口不计入当前采购。`" />
        <div v-if="visibleOrderHistoryTabs.length" class="coverage-tab-bar"><button v-for="tab in visibleOrderHistoryTabs" :key="tab.key" type="button" :class="[`is-${tab.key}`, { active: orderHistoryActiveTab === tab.key }]" @click="orderHistoryActiveTab = tab.key"><span>{{ tab.title }}</span><strong>{{ tab.quantity }} 件</strong><small>{{ tab.rows.length }} 条订单</small></button></div>
        <section class="coverage-detail-panel"><header><div><strong>{{ activeOrderHistoryTab.title }}</strong><span v-if="activeOrderHistoryTab.key === 'purchase'">等待备货或发货且库存未覆盖，可进入采购表单</span><span v-else-if="activeOrderHistoryTab.key === 'missing'">订单已履约但缺采购记录，应先核对并补录历史采购</span><span v-else>按下单时间倒序展示</span></div><b>{{ activeOrderHistoryTab.quantity }} 件</b></header><el-table :data="activeOrderHistoryTab.rows" max-height="52vh" empty-text="暂无订单" class="coverage-history-table"><el-table-column label="订单号" min-width="180"><template #default="{ row }"><strong>{{ row.posting_number || row.order_number || row.order_id }}</strong><div class="coverage-table-sub">SKU {{ row.ozon_sku || '-' }}</div></template></el-table-column><el-table-column label="店铺" prop="shop_name" min-width="140"><template #default="{ row }">{{ row.shop_name || '未标注店铺' }}</template></el-table-column><el-table-column label="下单时间" min-width="175"><template #default="{ row }">{{ orderTimeText(row) }}</template></el-table-column><el-table-column label="订单状态" width="120"><template #default="{ row }"><el-tag size="small" effect="plain" :type="row.is_cancelled ? 'info' : row.is_returned ? 'warning' : activeOrderHistoryTab.type">{{ orderStatusLabel(row) }}</el-tag></template></el-table-column><el-table-column label="数量" width="80" align="center"><template #default="{ row }">{{ Number(row.quantity || 0) }} 件</template></el-table-column><el-table-column label="采购覆盖情况" min-width="240"><template #default="{ row }"><span :class="['coverage-result', `is-${row.procurement_priority || activeOrderHistoryTab.key}`]">{{ orderCoverageText(row) }}</span></template></el-table-column></el-table></section>
      </div>
      <template #footer><div class="order-history-footer"><el-button v-if="realPurchaseShortage" type="danger" plain @click="openCoverageGapPurchase">采购真实缺口 {{ realPurchaseShortage }} 件</el-button><el-button @click="orderHistoryVisible = false">关闭</el-button></div></template>
    </el-dialog>

    <el-dialog v-model="bulkVisible" title="批量采购确认" width="calc(100vw - 24px)" align-center destroy-on-close class="bulk-purchase-dialog">
      <el-alert title="先看采购依据并打开货源完成下单，再填写实际采购数量、货款和运费；保存后统一进入待入库。" type="info" :closable="false" show-icon />
      <div class="bulk-order-toolbar">
        <el-select v-model="bulkMeta.source_type" class="channel-select" placeholder="采购渠道"><el-option label="1688" value="1688" /><el-option label="拼多多" value="pdd" /><el-option label="微信" value="wechat" /><el-option label="其他" value="other" /></el-select>
        <el-select v-model="bulkMeta.supplier_id" filterable clearable placeholder="选择供应商"><el-option v-for="supplier in state.suppliers" :key="supplier.id" :label="supplier.name" :value="supplier.id" /></el-select>
        <el-input v-model="bulkMeta.note" clearable placeholder="整单备注" />
        <el-button type="primary" plain @click="bulkAddVisible = true; searchBulkInventory(1)">＋ 添加库存商品</el-button>
        <el-upload v-if="bulkMeta.source_type === 'wechat'" :auto-upload="false" :show-file-list="false" accept="image/*" multiple :on-change="uploadBulkReceipt"><el-button :loading="uploadingReceipt">上传微信凭证</el-button></el-upload>
      </div>
      <div v-if="bulkMeta.receipts.length" class="bulk-receipts"><span v-for="(receipt,index) in bulkMeta.receipts" :key="receipt.url">{{ receipt.name }}<el-button link type="danger" @click="bulkMeta.receipts.splice(index,1)">删除</el-button></span></div>
      <div v-if="bulkGroupRecommendations.length" class="group-recommendations"><strong>常购组合建议</strong><span>这些商品曾和当前商品保存为同一采购组合，可按需加入：</span><el-button v-for="item in bulkGroupRecommendations.slice(0,8)" :key="item.product_id" size="small" @click="addProductToBulk(item, `来自常购组合：${item.group_name}`)">＋ {{ item.product_name }}</el-button></div>
      <el-table :data="pagedBulkItems" row-key="product_id" border height="calc(100vh - 300px)" class="bulk-purchase-table">
        <el-table-column label="库存商品" min-width="310"><template #default="{ row }"><div class="bulk-product"><ProductImagePreview :src="row.image_url" size="portrait" fit="cover" /><div><strong>{{ row.product_name }}</strong><span>{{ row.product_code }}</span></div></div></template></el-table-column>
        <el-table-column label="采购依据与库存流水" min-width="620"><template #default="{ row }"><div class="purchase-basis"><div class="purchase-basis-head"><strong class="purchase-basis-title">{{ row.purchase_basis }}</strong><el-button link type="primary" @click="openOrderHistory(row.source_row || row)">历史订单明细</el-button></div><div class="history-ledger"><span><em>业务记录</em><span>有效订单 <strong>{{ Number(row.historical_order_count || 0) }} 单 / {{ Number(row.historical_outbound_quantity || 0) }} 件</strong> · 已记录采购 <strong>{{ Number(row.historical_purchased_quantity || 0) }} 件</strong></span></span><span><em>本地流水</em><span>采购入库 <strong class="ledger-positive">+{{ Number(row.historical_purchase_inbound_quantity || 0) }}</strong> · 订单退回 <strong class="ledger-positive">+{{ Number(row.historical_return_in_quantity || 0) }}</strong> · 订单出库 <strong class="ledger-negative">-{{ Number(row.historical_inventory_order_outbound_quantity || 0) }}</strong> · 转FBP <strong class="ledger-negative">-{{ Number(row.historical_fbp_transfer_outbound_quantity || 0) }}</strong><template v-if="Number(row.historical_other_inventory_quantity || 0)"> · 其他 <strong>{{ Number(row.historical_other_inventory_quantity) > 0 ? '+' : '' }}{{ Number(row.historical_other_inventory_quantity) }}</strong></template></span></span><span><em>当前供给</em><span>现货 <strong>{{ Number(row.current_stock ?? row.source_row?.stock ?? 0) }} 件</strong> · 采购在途 <strong>{{ Number(row.source_row?.incoming_stock || 0) }} 件</strong> · FBP在途 <strong>{{ Number(row.source_row?.fbp_transfer_in_transit_qty || 0) }} 件</strong></span></span><span v-if="historicalDebt(row)" class="history-debt">历史库存待核 <strong>{{ historicalDebt(row) }} 件</strong><small>单独核对，不计本次采购</small></span><span v-else class="history-surplus">剩余总供给 <strong>{{ remainingSupply(row) }} 件</strong></span></div></div></template></el-table-column>
        <el-table-column label="本次采购录入" width="280"><template #default="{ row }"><div class="purchase-entry-fields"><label><span>数量</span><el-input-number v-model="row.quantity" class="bulk-number-input" :min="1" :precision="0" controls-position="right" /></label><label><span>货款</span><el-input v-model="row.amount" class="plain-money-input" inputmode="decimal" @blur="normalizeBulkMoney(row, 'amount')"><template #prefix>¥</template></el-input></label><label><span>运费</span><el-input v-model="row.shipping_amount" class="plain-money-input" inputmode="decimal" @blur="normalizeBulkMoney(row, 'shipping_amount')"><template #prefix>¥</template></el-input></label></div></template></el-table-column>
        <el-table-column label="价格对比" width="230"><template #default="{ row }"><div class="price-comparison"><span>历史均价 <strong>{{ Number(row.historical_unit_cost || 0) > 0 ? `¥${Number(row.historical_unit_cost).toFixed(2)}` : '暂无' }}</strong></span><el-button link type="primary" @click="openPurchaseHistory(row)">查看 {{ Number(row.historical_purchase_count || 0) }} 笔采购明细</el-button><span>本次均价 <strong>¥{{ currentBulkUnitCost(row).toFixed(2) }}</strong></span><em v-if="bulkPriceChange(row) !== null" :class="bulkPriceChange(row) > 0 ? 'price-up' : 'price-down'">{{ bulkPriceChange(row) > 0 ? '贵' : '便宜' }} {{ Math.abs(bulkPriceChange(row) * 100).toFixed(1) }}%</em><template v-if="bulkPriceChange(row) > 0.1"><el-select v-model="row.anomaly_reason" placeholder="请选择涨价原因" size="small" class="price-reason"><el-option v-for="reason in priceAnomalyReasons" :key="reason" :label="reason" :value="reason" /></el-select><el-input v-if="row.anomaly_reason === '其他原因'" v-model="row.anomaly_note" placeholder="请说明原因" size="small" /></template></div></template></el-table-column>
        <el-table-column label="货源与操作" width="160" align="center"><template #default="{ row }"><div class="bulk-link-actions"><el-button type="primary" :disabled="!row.purchase_url" @click="openBulkPurchaseUrl(row)">打开货源</el-button><el-button plain @click="openBulkLinkEditor(row)">{{ row.purchase_url ? '修改链接' : '添加链接' }}</el-button><el-button link type="danger" @click="removeBulkItem(row)">移出本次采购</el-button></div></template></el-table-column>
      </el-table>
      <div class="bulk-pagination"><span>本页 {{ pagedBulkItems.length }} 条，共 {{ bulkItems.length }} 个库存商品</span><el-pagination v-model:current-page="bulkPage" v-model:page-size="bulkPageSize" background layout="prev, pager, next" :total="bulkItems.length" /></div>
      <template #footer><div class="dialog-summary"><div class="remember-group"><el-checkbox v-model="bulkMeta.remember_group">保存为常购组合</el-checkbox><el-input v-if="bulkMeta.remember_group" v-model="bulkMeta.group_name" placeholder="例如：TENET T7/T8 微信全色组合" /></div><span>全部 {{ bulkItems.length }} 个库存商品，货款及运费合计 ¥{{ bulkPurchaseTotal.toFixed(2) }}</span><div><el-button @click="bulkVisible = false">取消</el-button><el-button type="primary" :disabled="!bulkItems.length" :loading="bulkSaving" @click="saveBulkPurchase">保存并标记已采购</el-button></div></div></template>
    </el-dialog>

    <el-dialog v-model="bulkAddVisible" title="添加库存商品到本次采购单（全部库存）" width="calc(100vw - 120px)" align-center class="bulk-add-dialog">
      <div class="bulk-add-search-panel">
        <InventoryStructuredSearch v-model="bulkAddFilters" compact />
        <div class="bulk-add-search-actions"><span>联合筛选完整库存商品库，商品不需要预先出现在系统采购任务中</span><el-button @click="resetBulkInventorySearch">重置</el-button><el-button type="primary" :loading="bulkAddLoading" @click="searchBulkInventory(1)">查询库存商品</el-button></div>
      </div>
      <div class="bulk-add-results" v-loading="bulkAddLoading"><button v-for="item in bulkAddResults" :key="item.product_id" type="button" :class="{ 'is-added': isProductInBulk(item) }" :disabled="isProductInBulk(item)" @click="addProductToBulk(item)"><ProductImagePreview :src="item.image_url" size="portrait" fit="cover" /><div><strong>{{ item.product_name }}</strong><span>{{ item.product_code || '-' }}</span><small>{{ item.reason }}</small></div><em>{{ isProductInBulk(item) ? '已加入' : '＋ 加入' }}</em></button><el-empty v-if="!bulkAddResults.length" :image-size="70" description="当前条件下没有库存商品，请调整联合筛选条件" /></div>
      <div v-if="bulkAddTotal" class="bulk-add-pagination"><span>共 {{ bulkAddTotal }} 个库存商品</span><el-pagination background layout="prev, pager, next" :current-page="bulkAddPage" :page-size="bulkAddPageSize" :total="bulkAddTotal" @current-change="searchBulkInventory" /></div>
      <template #footer><el-button type="primary" @click="bulkAddVisible = false">完成添加</el-button></template>
    </el-dialog>

    <el-dialog v-model="linkVisible" title="查找并绑定采购链接" width="720px" align-center @closed="editingBulkProductId = 0">
      <div class="link-editor-product">
        <ProductImagePreview :src="linkForm.image_url" size="large" fit="cover" />
        <div>
          <strong>{{ linkForm.product_name }}</strong>
          <p>先用图片快速找同款，确认供应商后把最终商品链接粘贴到下面。保存一次，后续采购自动复用。</p>
          <el-button type="primary" plain :loading="imageSearchingId === Number(linkForm.id)" @click="open1688ImageSearch(linkForm)">用这张图片去 1688 搜同款</el-button>
        </div>
      </div>
      <el-form label-width="88px" class="link-editor-form">
        <el-form-item label="采购链接"><el-input v-model="linkForm.purchase_url" type="textarea" :rows="3" placeholder="找到货源后，直接粘贴拼多多或1688商品链接" /></el-form-item>
        <el-row :gutter="12">
          <el-col :span="10"><el-form-item label="采购渠道"><el-select v-model="linkForm.source_type"><el-option label="1688" value="1688" /><el-option label="拼多多" value="pdd" /><el-option label="微信" value="wechat" /><el-option label="其他" value="other" /></el-select></el-form-item></el-col>
          <el-col :span="14"><el-form-item label="供应商"><el-select v-model="linkForm.supplier_id" clearable filterable placeholder="可选"><el-option v-for="supplier in state.suppliers" :key="supplier.id" :label="supplier.name" :value="supplier.id" /></el-select></el-form-item></el-col>
        </el-row>
      </el-form>
      <template #footer><el-button @click="linkVisible = false">取消</el-button><el-button type="primary" :loading="submitting" @click="savePurchaseLink">保存并用于以后采购</el-button></template>
    </el-dialog>

    <ProductCreateEditDialog ref="inventoryEditorRef" v-model:visible="inventoryEditorVisible" mode="edit" target="inventory" :edit-product-id="inventoryEditorProductId" :value="inventoryEditorValue" :people="state.people" :suppliers="state.suppliers" @saved="handleInventorySaved" @quick-create-component="openQuickComponentCreate" />

    <ProductCreateEditDialog v-model:visible="quickInventoryCreateVisible" mode="create" target="inventory" :people="state.people" :suppliers="state.suppliers" @saved="handleQuickInventoryCreated" @existing-selected="handleQuickInventoryExistingSelected" />

    <ProductCreateEditDialog v-model:visible="quickComponentCreateVisible" mode="create" target="inventory" :people="state.people" :suppliers="state.suppliers" :create-context="{ is_accessory: 1 }" @saved="handleQuickComponentCreated" @existing-selected="handleQuickComponentExistingSelected" />

    <el-dialog v-if="purchaseHistoryVisible" v-model="purchaseHistoryVisible" :close-on-click-modal="false" :show-close="!purchaseHistorySaving" :close-on-press-escape="!purchaseHistorySaving" :title="`${purchaseHistoryProduct?.product_name || '库存商品'} · 采购记录`" width="1760px" top="3vh" align-center class="erp-centered-dialog purchase-history-detail-dialog">
      <div class="purchase-history-summary">
        <div><span>有效采购记录</span><strong>{{ purchaseHistorySummary.records }} 笔</strong><small v-if="purchaseHistorySummary.invalid">另有 {{ purchaseHistorySummary.invalid }} 笔零数量/零金额异常</small></div>
        <div><span>采购数量</span><strong>{{ Number(purchaseHistorySummary.quantity).toFixed(0) }} 件</strong></div>
        <div><span>采购货款</span><strong>¥{{ Number(purchaseHistorySummary.amount).toFixed(2) }}</strong></div>
        <div><span>平均采购价</span><strong>¥{{ purchaseHistorySummary.quantity > 0 ? (purchaseHistorySummary.amount / purchaseHistorySummary.quantity).toFixed(2) : '0.00' }}</strong></div>
      </div>
      <div class="purchase-history-toolbar"><span>直接修改数量、货款、运费，填写纠错原因后保存。</span><div><el-button type="primary" :disabled="purchaseHistorySaving" @click="openPurchaseBackfill">＋ 补录一次采购</el-button><el-button :disabled="purchaseHistorySaving" @click="openPurchaseHistory(purchaseHistoryProduct)">刷新记录</el-button></div></div>
      <el-alert title="货款总额不含运费；上方汇总为已保存数据。纠错会同步采购、收货及订单分配并保留记录；只有入库数量也录多时，才勾选“入库也录多了”。" type="info" :closable="false" show-icon />
      <div class="purchase-history-table-wrap">
        <el-table v-loading="purchaseHistoryLoading" :data="purchaseHistoryRows" border stripe height="100%" class="erp-data-table">
          <el-table-column label="图片" width="86" fixed="left" align="center"><template #default="{ row }"><ProductImagePreview :src="row.product_image_url || purchaseHistoryProduct?.image_url" size="portrait" fit="cover" /></template></el-table-column>
          <el-table-column label="提交时间" width="175"><template #default="{ row }">{{ shanghaiDateTimeText(row.created_at, { assumeUtcWhenNaive: true }) }}</template></el-table-column>
          <el-table-column label="提交人" prop="person_name" width="120" />
          <el-table-column label="供应商" prop="supplier_name" min-width="150" />
          <el-table-column label="采购数量" width="130" align="right"><template #default="{ row }"><el-input-number v-model="row.quantity" :min="0" :precision="0" :controls="false" aria-label="采购数量" /></template></el-table-column>
          <el-table-column label="采购金额" width="135" align="right"><template #default="{ row }"><el-input-number v-model="row.amount" :min="0" :precision="2" :controls="false" aria-label="采购金额" /></template></el-table-column>
          <el-table-column label="采购均价" width="125" align="right"><template #default="{ row }"><strong :class="{ 'history-price-invalid': !(historyUnitPrice(row) > 0) }">¥{{ historyUnitPrice(row).toFixed(2) }}</strong></template></el-table-column>
          <el-table-column label="运费" width="120" align="right"><template #default="{ row }"><el-input-number v-model="row.shipping_amount" :min="0" :precision="2" :controls="false" aria-label="运费" /></template></el-table-column>
          <el-table-column label="来源" width="110" prop="source_type" />
          <el-table-column label="状态" width="120"><template #default="{ row }"><el-tag v-if="!(Number(row.quantity || 0) > 0) || !(Number(row.amount || 0) > 0)" size="small" type="danger">记录待补</el-tag><el-tag v-else size="small" effect="plain">{{ procurementStatusText(row) }}</el-tag></template></el-table-column>
          <el-table-column label="采购单号" min-width="180"><template #default="{ row }">{{ row.purchase_order_no }}</template></el-table-column>
          <el-table-column label="备注" prop="note" min-width="220" show-overflow-tooltip />
          <el-table-column label="纠错操作" width="240" fixed="right"><template #default="{ row }"><div class="purchase-history-row-actions"><el-input v-model="row.correction_reason" placeholder="填写纠错原因" maxlength="1000" aria-label="纠错原因" /><el-checkbox v-model="row.correct_received">入库也录多了</el-checkbox><el-button link type="primary" :disabled="purchaseHistorySaving && purchaseHistorySavingId !== Number(row.id)" :loading="purchaseHistorySaving && purchaseHistorySavingId === Number(row.id)" @click="previewPurchaseHistoryCorrection(row)">保存修改</el-button></div></template></el-table-column>
        </el-table>
        <el-empty v-if="!purchaseHistoryLoading && !purchaseHistoryRows.length" description="暂无正式采购记录" />
      </div>
    </el-dialog>

    <el-dialog v-if="purchaseBackfillVisible" v-model="purchaseBackfillVisible" title="补录一次采购" width="620px" align-center :close-on-click-modal="false" :show-close="!purchaseHistorySaving" :close-on-press-escape="!purchaseHistorySaving">
      <p>{{ purchaseHistoryProduct?.product_name }}</p>
      <el-form label-width="110px" :disabled="purchaseHistorySaving">
        <el-form-item label="采购数量" required><el-input-number v-model="purchaseBackfillForm.quantity" :min="1" :precision="0" aria-label="补录数量" /></el-form-item>
        <el-form-item label="货款金额" required><el-input-number v-model="purchaseBackfillForm.amount" :min="0.01" :precision="2" aria-label="补录货款" /><span>元，不含运费</span></el-form-item>
        <el-form-item label="运费"><el-input-number v-model="purchaseBackfillForm.shipping_amount" :min="0" :precision="2" aria-label="补录运费" /></el-form-item>
        <el-form-item label="实际采购时间" required><el-date-picker v-model="purchaseBackfillForm.purchased_at" type="datetime" format="YYYY/MM/DD HH:mm:ss" value-format="YYYY-MM-DDTHH:mm:ss" placeholder="选择北京时间" aria-label="实际采购时间" /><span>北京时间</span></el-form-item>
        <el-form-item label="收货状态" required><el-radio-group v-model="purchaseBackfillForm.inventory_effect" class="purchase-receipt-options"><el-radio value="in_transit">仍在途，增加待入库数量</el-radio><el-radio value="missing_inbound">已收货，补记本地入库</el-radio><el-radio value="already_accounted">库存已记账／供应商直发，只补采购记录</el-radio></el-radio-group></el-form-item>
        <el-form-item label="备注"><el-input v-model="purchaseBackfillForm.reason" type="textarea" maxlength="1000" placeholder="选填：供应商、采购凭证或补录原因" /></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="purchaseHistorySaving" @click="purchaseBackfillVisible = false">取消</el-button><el-button type="primary" :loading="purchaseHistorySaving" @click="previewPurchaseBackfill">保存补录</el-button></template>
    </el-dialog>

    <el-dialog v-if="purchaseCorrection" :model-value="true" :title="purchaseCorrection.payload.action_type === 'record_purchase' ? '确认采购补录' : '确认采购纠错'" width="620px" align-center :close-on-click-modal="false" :show-close="!purchaseHistorySaving" :close-on-press-escape="!purchaseHistorySaving" @close="purchaseCorrection = null">
      <p>采购数量 {{ purchaseCorrection.payload.quantity }} 件 · 货款 ¥{{ purchaseCorrection.payload.amount.toFixed(2) }} · 运费 ¥{{ purchaseCorrection.payload.shipping_amount.toFixed(2) }}</p>
      <p v-if="purchaseCorrection.payload.action_type === 'record_purchase'">实际采购时间：{{ shanghaiDateTimeText(purchaseCorrection.payload.purchased_at) }}（北京时间）<br />{{ purchaseCorrection.payload.inventory_effect === 'in_transit' ? '仍在途，增加待入库数量' : purchaseCorrection.payload.inventory_effect === 'missing_inbound' ? '已收货，补记本地入库' : '只补采购记录，不增加本地库存' }}</p>
      <el-alert type="warning" :closable="false" :title="`本地库存：${purchaseCorrection.preview.local_before} → ${purchaseCorrection.preview.local_after}`" description="确认后同步采购、收货及关联订单覆盖，并保留纠错记录。" />
      <el-table v-if="purchaseCorrection.preview.affected_orders?.length" :data="purchaseCorrection.preview.affected_orders" max-height="240"><el-table-column prop="posting_number" label="覆盖减少的订单" /><el-table-column prop="before" label="原关联数量" /><el-table-column prop="after" label="纠正后数量" /></el-table>
      <template #footer><el-button :disabled="purchaseHistorySaving" @click="purchaseCorrection = null">返回编辑</el-button><el-button type="primary" :loading="purchaseHistorySaving" @click="savePurchaseHistoryCorrection">确认保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="createVisible" title="登记已下单采购" width="1180px" align-center destroy-on-close>
      <el-alert title="这里提交即表示已经完成下单；系统会立即记录采购人、采购时间、数量和金额，并生成采购在途。" type="info" :closable="false" show-icon />
      <el-form label-width="92px">
        <el-row :gutter="16">
          <el-col :span="8"><el-form-item label="采购负责人"><el-select v-model="createForm.person_id"><el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="person.id" /></el-select></el-form-item></el-col>
          <el-col :span="6"><el-form-item label="采购渠道"><el-select v-model="createForm.source_type"><el-option label="拼多多" value="pdd" /><el-option label="1688" value="1688" /><el-option label="微信" value="wechat" /><el-option label="供应商" value="supplier" /><el-option label="其他" value="other" /></el-select></el-form-item></el-col>
          <el-col :span="6"><el-form-item label="供应商"><el-select v-model="createForm.supplier_id" clearable><el-option v-for="supplier in state.suppliers" :key="supplier.id" :label="supplier.name" :value="supplier.id" /></el-select></el-form-item></el-col>
          <el-col :span="4"><el-form-item label="优先级"><el-select v-model="createForm.urgency"><el-option label="普通" value="normal" /><el-option label="加急" value="urgent" /></el-select></el-form-item></el-col>
        </el-row>
      </el-form>

      <div class="create-layout">
        <div class="item-list">
          <div class="item-list-head"><strong>采购明细（{{ createForm.items.length }}）</strong><el-button link type="primary" @click="addItem">＋ 添加商品</el-button></div>
          <button v-for="(item, index) in createForm.items" :key="index" type="button" class="item-card" :class="{ active: activeItemIndex === index }" @click="setActiveItem(index)">
            <div><strong>{{ item.raw_name || `商品 ${index + 1}` }}</strong><span>{{ item.quantity }}件 · ¥{{ Number(item.amount || 0).toFixed(2) }}</span></div>
            <el-tag size="small" :type="item.product_id ? 'success' : 'warning'">{{ item.product_id ? "已绑定" : "提交前需绑定" }}</el-tag>
          </button>
        </div>

        <div v-if="activeItem" class="item-editor">
          <div class="section-head"><strong>填写采购商品</strong><el-button v-if="createForm.items.length > 1" link type="danger" @click="removeItem(activeItemIndex)">删除本条</el-button></div>
          <el-form label-width="92px">
            <el-form-item label="采购名称"><el-input v-model="activeItem.raw_name" placeholder="按采购习惯填写，例如：老王家黑色钥匙壳" @input="scheduleSuggestions" /></el-form-item>
            <el-form-item label="规格备注"><el-input v-model="activeItem.raw_spec" placeholder="颜色、型号、包装等" /></el-form-item>
            <el-row :gutter="12">
              <el-col :span="8"><el-form-item label="数量"><el-input-number v-model="activeItem.quantity" :min="1" :precision="0" /></el-form-item></el-col>
              <el-col :span="8"><el-form-item label="货款"><el-input-number v-model="activeItem.amount" :min="0" :precision="2" /></el-form-item></el-col>
              <el-col :span="8"><el-form-item label="运费"><el-input-number v-model="activeItem.shipping_amount" :min="0" :precision="2" /></el-form-item></el-col>
            </el-row>
            <el-form-item label="采购链接"><el-input v-model="activeItem.purchase_url" placeholder="拼多多、1688或其他采购链接" /></el-form-item>
          </el-form>
        </div>

        <div class="suggestion-panel" v-loading="suggestionLoading">
          <div class="section-head"><div><strong>快速选择库存</strong><p>库存 ID 直达，或按名称模糊搜索；也会保留名称推荐。</p></div><el-button v-if="activeItem?.product_id" link @click="clearItemBinding">暂不绑定</el-button></div>
          <div v-if="activeItem?.product_id" class="selected-binding">已选择：{{ activeItem.product_name }}</div>
          <div class="quick-inventory-search">
            <el-input v-model="quickInventorySearch.inventoryId" placeholder="输入库存 ID 精确查找" clearable @keyup.enter="searchQuickInventory('inventory_id')"><template #append><el-button @click="searchQuickInventory('inventory_id')">查 ID</el-button></template></el-input>
            <el-input v-model="quickInventorySearch.productName" placeholder="输入商品名称模糊搜索" clearable @keyup.enter="searchQuickInventory('name')"><template #append><el-button @click="searchQuickInventory('name')">搜名称</el-button></template></el-input>
          </div>
          <div v-if="quickInventoryResults.length" v-loading="quickInventoryLoading" class="quick-inventory-results">
            <button v-for="product in quickInventoryResults" :key="product.product_id" type="button" class="suggestion-card" @click="chooseQuickInventory(product)"><ProductImagePreview :src="product.image_url" size="small" /><div><strong>{{ product.product_name }}</strong><span>库存 ID：{{ product.product_code }}</span></div></button>
          </div>
          <el-button type="primary" plain @click="openQuickInventoryCreate">＋ 快速创建库存</el-button>
          <el-divider content-position="left">名称推荐</el-divider>
          <button v-for="suggestion in state.suggestions" :key="suggestion.product_id" type="button" class="suggestion-card" @click="chooseSuggestion(suggestion)">
            <ProductImagePreview :src="suggestion.image_url" size="small" />
            <div><strong>{{ suggestion.product_name }}</strong><span>{{ suggestion.product_code || '-' }}</span><span>{{ suggestion.reason }} · {{ suggestion.confidence }}%</span></div>
          </button>
          <el-empty v-if="!state.suggestions.length && !quickInventoryResults.length" :image-size="72" description="可用库存 ID 或名称快速搜索；填写采购名称后也会显示推荐。" />
        </div>
      </div>

      <div v-if="createForm.source_type === 'wechat'" class="receipt-upload-panel">
        <div>
          <strong>微信采购凭证</strong>
          <p>可直接上传聊天、报价或付款截图，作为本次已下单采购的凭证。</p>
        </div>
        <el-upload :auto-upload="false" :show-file-list="false" accept="image/*" multiple :on-change="uploadReceipt">
          <el-button :loading="uploadingReceipt">上传图片</el-button>
        </el-upload>
        <div v-if="createForm.receipts.length" class="receipt-list">
          <div v-for="(receipt, index) in createForm.receipts" :key="receipt.url">
            <el-image :src="withImageToken(receipt.url)" :preview-src-list="createForm.receipts.map((item) => withImageToken(item.url))" preview-teleported fit="cover" />
            <span>{{ receipt.name }}</span>
            <el-button link type="danger" @click="removeReceipt(index)">删除</el-button>
          </div>
        </div>
      </div>

      <el-form label-width="92px" class="create-note"><el-form-item label="整单备注"><el-input v-model="createForm.note" type="textarea" :rows="2" /></el-form-item></el-form>
      <template #footer><div class="dialog-summary"><span>共 {{ createForm.items.length }} 条，合计 ¥{{ totalAmount.toFixed(2) }}</span><div><el-button @click="createVisible = false">取消</el-button><el-button type="primary" :loading="submitting" @click="submitCreate">确认已下单并进入在途</el-button></div></div></template>
    </el-dialog>

    <el-dialog v-model="bindVisible" :title="bindForm.source_order_item_id ? '修改订单 SKU 库存绑定' : '绑定规范库存'" width="760px" align-center>
      <el-alert v-if="bindForm.source_order_item_id" type="info" :closable="false" title="保存后会同步修改订单 SKU 绑定，并把未完成的采购需求重新归到新库存商品。" />
      <el-form label-width="92px">
        <el-form-item label="采购名称"><el-input v-model="bindForm.raw_name" @input="() => loadSuggestions(bindForm.raw_name)" /></el-form-item>
        <el-form-item label="采购规格"><el-input v-model="bindForm.raw_spec" /></el-form-item>
      </el-form>
      <div v-if="bindForm.product_id" class="selected-binding">当前选择：{{ bindForm.product_name }}</div>
      <el-input v-model="inventorySearch" placeholder="搜索库存名称或编码" clearable @keyup.enter="searchInventorySuggestions">
        <template #append><el-button @click="searchInventorySuggestions">搜索</el-button></template>
      </el-input>
      <div class="bind-suggestions" v-loading="suggestionLoading">
        <button v-for="suggestion in state.suggestions" :key="suggestion.product_id" type="button" class="suggestion-card" @click="chooseSuggestion(suggestion)">
          <ProductImagePreview :src="suggestion.image_url" size="small" />
          <div><strong>{{ suggestion.product_name }}</strong><span>{{ suggestion.product_code || '-' }} · {{ suggestion.reason }} · {{ suggestion.confidence }}%</span></div>
        </button>
      </div>
      <template #footer><el-button @click="bindVisible = false">取消</el-button><el-button type="primary" :loading="submitting" @click="saveBinding">确认绑定</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.product-cell,.section-head,.item-list-head,.dialog-summary{display:flex;align-items:center;justify-content:space-between;gap:12px}.product-cell{justify-content:flex-start}.muted-text,.suggestion-card span,.item-card span,.section-head p{color:var(--erp-text-secondary);font-size:12px}.binding-name{margin-top:6px}.create-layout{display:grid;grid-template-columns:220px minmax(0,1fr) 310px;gap:16px;min-height:430px}.item-list,.item-editor,.suggestion-panel{padding:14px;border:1px solid var(--erp-border);border-radius:16px;background:#fff}.item-list,.suggestion-panel{display:flex;flex-direction:column;gap:10px}.item-card,.suggestion-card{border:1px solid var(--erp-border);border-radius:12px;background:#fff;text-align:left;cursor:pointer}.item-card{display:flex;justify-content:space-between;align-items:center;padding:12px}.item-card div,.suggestion-card div{display:grid;gap:4px}.item-card.active{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.suggestion-card{display:grid;grid-template-columns:48px minmax(0,1fr);gap:10px;padding:10px}.suggestion-card:hover{border-color:var(--el-color-primary)}.selected-binding{margin:8px 0 12px;padding:10px 12px;border-radius:10px;background:var(--el-color-success-light-9);color:var(--el-color-success-dark-2)}.quick-inventory-search{display:grid;gap:8px}.quick-inventory-results{display:grid;gap:8px;max-height:230px;overflow:auto}.section-head p{margin:3px 0 0;font-weight:400}.create-note{margin-top:16px}.bind-suggestions{display:grid;grid-template-columns:1fr 1fr;gap:10px;max-height:360px;overflow:auto}.dialog-summary{width:100%}@media(max-width:1100px){.create-layout{grid-template-columns:190px 1fr}.suggestion-panel{grid-column:1/-1}.bind-suggestions{grid-template-columns:1fr}}
.receipt-upload-panel{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;margin-top:16px;padding:16px;border:1px dashed var(--el-color-primary-light-5);border-radius:14px;background:var(--el-color-primary-light-9)}.receipt-upload-panel p{margin:4px 0 0;color:var(--erp-text-secondary);font-size:12px}.receipt-list{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:10px}.receipt-list>div{display:grid;grid-template-columns:56px minmax(80px,160px) auto;align-items:center;gap:8px;padding:8px;border-radius:10px;background:#fff}.receipt-list .el-image{width:56px;height:56px;border-radius:8px}
.purchase-link-actions{display:flex;align-items:center;flex-wrap:wrap;gap:2px 8px}.link-editor-product{display:grid;grid-template-columns:96px minmax(0,1fr);gap:18px;align-items:center;padding:16px;border-radius:14px;background:var(--erp-bg-page)}.link-editor-product strong{font-size:17px}.link-editor-product p{margin:7px 0 12px;color:var(--erp-text-secondary);line-height:1.65}.link-editor-form{margin-top:18px}.compact-product :deep(.erp-image-preview--portrait){width:72px;min-width:72px;max-width:72px;height:90px;min-height:90px;max-height:90px;flex-basis:72px}.compact-product{min-height:98px}
.demand-table{min-height:420px}.demand-product-card{display:grid;grid-template-columns:64px minmax(0,1fr);gap:12px;align-items:center;min-height:88px}.demand-product-card>div{display:grid;gap:4px}.row-actions{display:flex;gap:10px}.demand-reason{margin:8px 0 4px;line-height:1.55}.metric-stack,.sales-stack{display:grid;gap:7px}.metric-stack span,.sales-stack span{display:flex;align-items:center;justify-content:space-between;gap:18px}.metric-stack em,.sales-stack em{color:var(--erp-text-secondary);font-size:12px;font-style:normal}.metric-stack strong,.sales-stack strong{color:var(--erp-text-primary);font-size:14px}.sales-stack small{padding-top:5px;border-top:1px dashed var(--erp-border);color:var(--erp-text-secondary)}.source-order-list{display:grid;gap:8px;max-height:510px;overflow:auto}.source-order-item{display:grid;grid-template-columns:64px minmax(0,1fr);gap:12px;padding:10px 12px;border:1px solid var(--erp-border);border-radius:10px}.source-order-item>div{display:grid;align-content:center;gap:3px}.source-order-item span{font-size:12px;color:var(--erp-text-secondary)}.source-order-list .el-pagination{justify-content:flex-end;padding-top:4px}
:global(.bulk-purchase-dialog){display:flex;flex-direction:column;width:calc(100vw - 24px)!important;max-width:1920px;max-height:96vh;margin-top:2vh!important;margin-bottom:0!important;border-radius:14px}:global(.bulk-purchase-dialog .el-dialog__header),:global(.bulk-purchase-dialog .el-dialog__footer){flex:0 0 auto}:global(.bulk-purchase-dialog .el-dialog__header){padding:20px 24px 14px;border-bottom:1px solid #edf1f6}:global(.bulk-purchase-dialog .el-dialog__body){display:flex;flex:1 1 auto;flex-direction:column;min-height:0;overflow:hidden;padding:10px 24px 0}:global(.bulk-purchase-dialog .el-dialog__footer){padding:14px 24px 18px;border-top:1px solid #edf1f6}.bulk-purchase-table{flex:1 1 auto;margin-top:12px;border-radius:10px}.bulk-pagination{display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:16px;padding:12px 2px 10px;color:var(--erp-text-secondary);font-size:13px}
.inventory-metrics{display:grid;grid-template-columns:repeat(4,minmax(54px,1fr));gap:5px}.inventory-metrics>div{display:grid;align-content:center;gap:4px;min-width:0;padding:8px 5px;border:1px solid #e8edf5;border-radius:8px;background:#f8fafc;text-align:center}.inventory-metrics span{color:#7b8799;font-size:11px;white-space:nowrap}.inventory-metrics strong{color:#24324a;font-size:14px;line-height:1.2}.inventory-metrics>div:first-child strong{color:var(--el-color-primary)}.inventory-metrics .el-button{height:auto;padding:0;font-size:12px}
.negative-stock-button{height:auto;padding:0;font-size:13px;font-weight:700}.stock-gap-head{display:grid;gap:4px;margin-bottom:10px}.stock-gap-head span{color:var(--erp-text-secondary);font-size:12px}
.sales-summary{display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:4px 12px;padding:8px 10px;border-radius:9px;background:#f8fafc}.sales-summary strong{grid-row:1/3;color:#24324a;font-size:16px}.sales-summary span{color:#66758b;font-size:12px}.sales-summary small{grid-column:1/-1;padding-top:6px;border-top:1px dashed #dfe5ee;color:#8a96a8;font-size:11px}
.order-history-summary{display:grid;grid-template-columns:1fr 1fr;gap:5px 12px;padding:8px 10px;border-radius:9px;background:#f8fafc;text-align:left}.order-history-summary span{display:flex;justify-content:space-between;color:#66758b;font-size:12px}.order-history-summary strong{color:#24324a}.order-history-summary .history-cancelled{color:#909399}.order-history-summary .history-returned{color:var(--el-color-warning)}.order-history-summary .el-button{grid-column:1/-1;justify-self:center;height:auto;padding:2px 0}.coverage-audit{display:grid;gap:14px;min-height:620px}.coverage-audit-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.coverage-audit-summary>div{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border:1px solid #dfe6ef;border-radius:10px;background:#f8fafc}.coverage-audit-summary span{color:#667085;font-size:12px}.coverage-audit-summary strong{font-size:20px}.coverage-audit-summary .is-danger strong{color:var(--el-color-danger)}.coverage-audit-summary .is-warning strong{color:var(--el-color-warning)}.coverage-audit-summary .is-success strong{color:var(--el-color-success)}.coverage-columns{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;min-height:500px}.coverage-column{display:grid;grid-template-rows:auto minmax(0,1fr);min-width:0;border:1px solid #dfe6ef;border-radius:12px;background:#f8fafc;overflow:hidden}.coverage-column>header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #dfe6ef;background:#fff}.coverage-column>header>div{display:grid;gap:3px}.coverage-column>header span{color:#7b8797;font-size:11px}.coverage-column>header b{font-size:18px}.coverage-column.is-shortage>header b{color:var(--el-color-danger)}.coverage-column.is-in_transit>header b{color:var(--el-color-warning)}.coverage-column.is-covered>header b{color:var(--el-color-success)}.coverage-order-list{display:grid;align-content:start;gap:8px;max-height:58vh;padding:10px;overflow:auto}.coverage-order-list article{display:grid;grid-template-columns:72px minmax(0,1fr);gap:10px;padding:9px;border:1px solid #e3e9f1;border-radius:10px;background:#fff}.coverage-order-list article>div{display:grid;align-content:start;gap:4px;min-width:0}.coverage-order-list span,.coverage-order-list small{overflow:hidden;color:#667085;font-size:11px;white-space:nowrap;text-overflow:ellipsis}.coverage-order-list small{padding-top:5px;border-top:1px dashed #e1e7ef;color:#52657e}.coverage-column.is-shortage small{color:var(--el-color-danger)}.coverage-order-title{display:flex;align-items:flex-start;justify-content:space-between;gap:7px}.coverage-order-title strong{overflow:hidden;color:#243247;font-size:13px;white-space:nowrap;text-overflow:ellipsis}.coverage-order-list :deep(.erp-image-preview--portrait){width:72px;min-width:72px;max-width:72px;height:96px;min-height:96px;max-height:96px;flex-basis:72px}.order-history-footer{display:flex;align-items:center;justify-content:flex-end;gap:16px}.order-history-footer>span{margin-right:auto;color:var(--erp-text-secondary)}:global(.order-history-dialog){max-width:1800px;max-height:96vh;margin-top:2vh!important}:global(.order-history-dialog .el-dialog__body){max-height:calc(96vh - 130px);overflow:auto}@media(max-width:1100px){.coverage-columns{grid-template-columns:1fr}.coverage-order-list{max-height:420px}}
.coverage-product-context{display:flex;align-items:center;gap:12px;padding:10px 14px;border:1px solid #dfe6ef;border-radius:10px;background:#fff}.coverage-product-context>div{display:grid;gap:3px}.coverage-product-context span,.coverage-product-context small{color:#667085;font-size:12px}.coverage-product-context :deep(.erp-image-preview--portrait){width:48px;min-width:48px;max-width:48px;height:64px;min-height:64px;max-height:64px}.coverage-tab-bar{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}.coverage-tab-bar button{display:grid;grid-template-columns:1fr auto;align-items:center;gap:3px 10px;padding:10px 13px;border:1px solid #dfe6ef;border-radius:10px;background:#f8fafc;color:#344054;text-align:left;cursor:pointer}.coverage-tab-bar button strong{font-size:17px}.coverage-tab-bar button small{grid-column:1/-1;color:#7b8797}.coverage-tab-bar button.active{border-color:var(--el-color-primary);background:#eef5ff;box-shadow:0 0 0 2px rgba(64,158,255,.08)}.coverage-tab-bar .is-purchase strong{color:var(--el-color-danger)}.coverage-tab-bar .is-missing strong,.coverage-tab-bar .is-in_transit strong{color:var(--el-color-warning)}.coverage-tab-bar .is-covered strong{color:var(--el-color-success)}.coverage-detail-panel{display:grid;grid-template-rows:auto minmax(0,1fr);min-height:390px;border:1px solid #dfe6ef;border-radius:12px;background:#f8fafc;overflow:hidden}.coverage-detail-panel>header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #dfe6ef;background:#fff}.coverage-detail-panel>header>div{display:grid;gap:3px}.coverage-detail-panel>header span{color:#7b8797;font-size:12px}.coverage-detail-panel>header b{font-size:20px}.coverage-detail-panel .coverage-order-list{grid-template-columns:repeat(2,minmax(0,1fr));max-height:48vh;padding:12px}.coverage-detail-panel .coverage-order-list article{display:grid;grid-template-columns:1fr;gap:8px;padding:12px}.coverage-order-meta{display:grid!important;grid-template-columns:1fr 1.4fr auto auto;gap:8px!important}.coverage-order-meta span{padding-right:8px;border-right:1px solid #edf0f5}.coverage-order-meta span:last-child{border-right:0}.coverage-detail-panel .coverage-order-list small{font-size:12px}.coverage-detail-panel .el-empty{grid-column:1/-1}@media(max-width:1100px){.coverage-tab-bar{grid-template-columns:1fr 1fr}.coverage-detail-panel .coverage-order-list{grid-template-columns:1fr}.coverage-order-meta{grid-template-columns:1fr 1fr!important}}
.coverage-audit{gap:12px;min-height:0}.coverage-product-context{justify-content:space-between}.coverage-product-context>div.coverage-product-main{display:flex;align-items:center;gap:12px;min-width:0}.coverage-product-main>div{display:grid;gap:4px;min-width:0}.coverage-product-main strong,.coverage-product-main span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.coverage-product-context>div.coverage-product-total{display:grid;justify-items:end;gap:2px;padding-left:20px}.coverage-product-total strong{color:#243247;font-size:20px}.coverage-tab-bar{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}.coverage-detail-panel{display:block;min-height:0}.coverage-history-table strong{color:#243247}.coverage-table-sub{margin-top:4px;color:#7b8797;font-size:11px}.coverage-result{color:#52657e}.coverage-result.is-P0,.coverage-result.is-purchase{color:var(--el-color-danger)}.coverage-result.is-P1,.coverage-result.is-missing{color:var(--el-color-warning)}.coverage-result.is-covered{color:var(--el-color-success)}.order-history-footer{justify-content:flex-end}:global(.order-history-dialog){width:min(1380px,calc(100vw - 48px))!important;max-height:94vh;margin-top:3vh!important}:global(.order-history-dialog .el-dialog__body){max-height:calc(94vh - 130px);overflow:auto}@media(max-width:720px){.coverage-product-context{align-items:flex-start}.coverage-product-total{padding-left:8px!important}.coverage-tab-bar{grid-template-columns:1fr 1fr}}
.bulk-product{display:grid;grid-template-columns:58px minmax(0,1fr);align-items:center;gap:12px}.bulk-product>div{display:grid;gap:5px}.bulk-product strong{color:#25334b;line-height:1.45}.bulk-product span{color:#8a96a8;font-size:12px}.bulk-product :deep(.erp-image-preview--portrait){width:58px;min-width:58px;max-width:58px;height:76px;min-height:76px;max-height:76px;flex-basis:58px}.purchase-basis{padding:12px 14px;border:1px solid #dce9f8;border-radius:10px;background:#f7fbff;color:#53627a;font-size:12px;line-height:1.55}.purchase-basis-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.purchase-basis-head .el-button{flex:none;height:auto;padding:2px 0}.purchase-basis-title{display:block;color:#304766;font-size:13px;line-height:1.6}.bulk-link-actions{display:flex;flex-direction:column;align-items:stretch;gap:7px}.bulk-link-actions .el-button{width:100%;margin:0}.bulk-number-input,.plain-money-input{width:100%}:deep(.bulk-number-input .el-input__wrapper){padding-right:42px}:deep(.bulk-number-input .el-input-number__increase),:deep(.bulk-number-input .el-input-number__decrease){width:34px}.purchase-entry-fields{display:grid;gap:8px}.purchase-entry-fields label{display:grid;grid-template-columns:38px minmax(0,1fr);align-items:center;gap:8px}.purchase-entry-fields label>span{color:#748196;font-size:12px;text-align:right}.price-comparison{display:grid;grid-template-columns:1fr auto;align-items:center;gap:6px 8px;padding:10px;border-radius:9px;background:#f8fafc;color:#68768c;font-size:12px}.price-comparison span{display:flex;justify-content:space-between;gap:6px}.price-comparison small{color:#98a2b2}.price-comparison em{justify-self:end;padding:2px 7px;border-radius:10px;font-size:11px;font-style:normal}.price-up{background:var(--el-color-danger-light-9);color:var(--el-color-danger)}.price-down{background:var(--el-color-success-light-9);color:var(--el-color-success)}
.history-ledger{display:grid;gap:6px;margin-top:9px;padding-top:9px;border-top:1px dashed #cdddf0}.history-ledger>span{display:grid;grid-template-columns:68px minmax(0,1fr);align-items:start;gap:10px}.history-ledger>span>em{padding:2px 6px;border-radius:5px;background:#e8f1fb;color:#53739a;font-size:11px;font-style:normal;text-align:center}.history-ledger>span>span{min-width:0}.ledger-positive{color:var(--el-color-success)}.ledger-negative{color:var(--el-color-danger)}.history-ledger .history-debt,.history-ledger .history-surplus{display:flex;grid-template-columns:auto auto minmax(0,1fr);align-items:center;gap:8px;padding:7px 9px;border-radius:7px}.history-ledger .history-debt{background:var(--el-color-danger-light-9);color:var(--el-color-danger)}.history-ledger .history-surplus{background:var(--el-color-success-light-9);color:var(--el-color-success)}.history-ledger .history-debt small{color:#a95b62}
.purchase-receipt-options{display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.purchase-history-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--erp-text-secondary);font-size:13px}.purchase-history-row-actions{display:flex;flex-direction:column;align-items:flex-start;gap:6px}
:global(.purchase-history-detail-dialog){display:flex;flex-direction:column;width:min(1760px,96vw)!important;max-height:94vh}:global(.purchase-history-detail-dialog .el-dialog__body){display:grid;grid-template-rows:auto auto auto minmax(0,1fr);gap:12px;min-height:0;overflow:hidden}.purchase-history-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.purchase-history-summary>div{display:grid;gap:4px;padding:12px 14px;border:1px solid #dbe6f3;border-radius:8px;background:#f8fbff}.purchase-history-summary span,.purchase-history-summary small{color:#64748b;font-size:12px}.purchase-history-summary small{color:var(--el-color-danger)}.purchase-history-summary strong{color:#0f172a;font-size:18px}.purchase-history-table-wrap{position:relative;min-height:320px;height:min(62vh,660px);overflow:hidden}.purchase-history-table-wrap>.el-empty{position:absolute;inset:80px 0 auto}.purchase-history-table-wrap :deep(.el-input-number){width:100%}.purchase-history-actions{display:flex;align-items:center;justify-content:center;gap:10px}.purchase-history-actions .el-button+.el-button{margin-left:0}.history-price-invalid{color:var(--el-color-danger)}
:deep(.demand-table .el-table__header th.el-table__cell),:deep(.bulk-purchase-table .el-table__header th.el-table__cell){background:#f2f5fa;color:#53627a;font-weight:700}:deep(.demand-table .el-table__body td.el-table__cell){padding:11px 0}:deep(.bulk-purchase-table .el-table__body td.el-table__cell){padding:9px 0}
.suggested-qty{display:block;margin-bottom:4px;font-size:24px;font-weight:600;line-height:1.3;font-variant-numeric:tabular-nums}
.purchase-suggestion{display:grid;justify-items:start;gap:7px}.purchase-suggestion-main{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.suggested-qty{font-size:18px;line-height:1.3}.purchase-suggestion .el-button{height:auto;padding:2px 0}
.warehouse-request-detail{display:flex;align-items:center;gap:6px}.warehouse-request-detail .demand-reason{margin:0}
.bulk-order-toolbar{display:grid;grid-template-columns:150px 220px minmax(220px,1fr) auto auto;gap:10px;align-items:center;margin-top:12px}.bulk-receipts,.group-recommendations{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:9px;padding:8px 10px;border-radius:9px;background:#f7f9fc;font-size:12px}.bulk-receipts span{display:flex;align-items:center;gap:4px}.group-recommendations>span{color:var(--erp-text-secondary)}.remember-group{display:flex;align-items:center;gap:8px;min-width:360px}.remember-group .el-input{width:270px}:global(.bulk-add-dialog){max-width:1600px}.bulk-add-search-panel{padding:10px;border:1px solid var(--erp-border);border-radius:12px;background:#f8fafc}.bulk-add-search-actions,.bulk-add-pagination{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:10px}.bulk-add-search-actions span,.bulk-add-pagination span{margin-right:auto;color:var(--erp-text-secondary);font-size:12px}.bulk-add-results{display:grid;grid-template-columns:1fr 1fr;gap:10px;min-height:180px;max-height:470px;margin-top:14px;overflow:auto}.bulk-add-results>button{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:11px;align-items:center;padding:10px;border:1px solid var(--erp-border);border-radius:10px;background:#fff;text-align:left;cursor:pointer}.bulk-add-results>button:hover{border-color:var(--el-color-primary);background:var(--el-color-primary-light-9)}.bulk-add-results>button.is-added{border-color:var(--el-color-success-light-5);background:var(--el-color-success-light-9);cursor:default;opacity:.78}.bulk-add-results>button.is-added em{color:var(--el-color-success)}.bulk-add-results>button>div{display:grid;gap:4px}.bulk-add-results span,.bulk-add-results small{color:var(--erp-text-secondary)}.bulk-add-results em{color:var(--el-color-primary);font-style:normal}.bulk-add-results :deep(.erp-image-preview--portrait){width:52px;min-width:52px;height:68px;min-height:68px}
@media(max-width:1200px){.bulk-order-toolbar{grid-template-columns:130px 180px minmax(180px,1fr) auto}.bulk-order-toolbar .el-upload{grid-column:1/-1}.bulk-add-results{grid-template-columns:1fr}}
@media(max-width:1100px){.create-layout{grid-template-columns:190px 1fr}.suggestion-panel{grid-column:1/-1}.bind-suggestions{grid-template-columns:1fr}}
</style>
