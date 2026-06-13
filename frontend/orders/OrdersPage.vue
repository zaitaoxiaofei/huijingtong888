<script setup>
import { computed, defineExpose, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import OrdersStatusTabs from "./components/OrdersStatusTabs.vue";
import OrdersTable from "./components/OrdersTable.vue";
import OrdersToolbar from "./components/OrdersToolbar.vue";
import PageFooterPagination from "../admin/components/PageFooterPagination.vue";
import { apiClient } from "../admin/utils/api.js";
import { useOrdersPage } from "./composables/useOrdersPage.js";
import {
  INVENTORY_LIST_PAGE_SIZE,
  ORDER_DETAIL_CACHE_TTL_MS,
  SEARCH_TYPE_OPTIONS,
  STATE_META
} from "./constants/orders-ui.js";
import { buildProductDisplayRows, firstCsvValue, splitCsv } from "./utils/order-display.js";
import { formatDateTime, formatLogisticsRuleLabel, formatMoney, formatPercent, formatSignedMoney, moneyValueClass } from "./utils/order-format.js";
import { buildOrderProfitDetail, profitDetailCellClassName } from "./utils/order-profit-detail.js";
import "./orders-view.css";
import "../admin/styles/erp-theme.css";

const route = useRoute();
const router = useRouter();
const elementLocale = zhCn;

const orderDetailCache = new Map();

const {
  vm,
  loading,
  totalPages,
  selectedOrderIds,
  loadOrders,
  loadLogisticsOptions,
  submitFilters,
  changeStatus,
  changePrintView,
  changeMarkFilter,
  changePage,
  changePageSize,
  syncRecent,
  syncAll,
  cancelSync,
  bulkPrint,
  bulkPrepare,
  openQualityRules,
  saveQualityRules,
  resetRecentDates,
  handleMoreAction,
  fetchOrderDetail,
  prepareSingleOrder,
  previewOrderProcurement,
  createOrderProcurementRequests,
  printSingleOrder,
  recalculateOrderProfit,
  saveOrderMark,
  loadStatusTabPreference,
  saveStatusTabPreference,
  defaultStatusTabOrder,
} = useOrdersPage();

const selectedCount = computed(() => selectedOrderIds.value.size);
const selectedOrderIdList = computed(() => [...selectedOrderIds.value]);
const allRowsSelected = computed(() => {
  const rows = Array.isArray(vm.rows) ? vm.rows : [];
  return rows.length > 0 && rows.every((row) => selectedOrderIds.value.has(Number(row.id)));
});
const someRowsSelected = computed(() => {
  const rows = Array.isArray(vm.rows) ? vm.rows : [];
  return rows.some((row) => selectedOrderIds.value.has(Number(row.id))) && !allRowsSelected.value;
});

const detailDialog = reactive({
  visible: false,
  loading: false,
  recalculating: false,
  mode: "detail",
  orderId: null,
  data: null
});

const qualityDialog = reactive({
  visible: false,
  loading: false,
  saving: false,
  prefixesText: "",
  note: ""
});

const stockDebtAdjustingProductId = ref(null);

const orderProcurementDialog = reactive({
  visible: false,
  loading: false,
  submitting: false,
  orderId: null,
  preview: null,
  selectedItemIds: []
});

const printDialog = reactive({
  visible: false,
  submitting: false,
  previewing: false,
  orderIds: [],
  preset: "order_label_72x130",
  copies: 1,
  scale: "noscale",
  orientation: "auto",
  color: "monochrome"
});

const statusPreferenceDialog = reactive({
  visible: false,
  saving: false,
  order: []
});

const printPresetOptions = [
  {
    label: "订单面单 72mm x 130mm",
    value: "order_label_72x130",
    printer: "label",
    paper: "72mm x 130mm",
    scale: "noscale",
    orientation: "auto",
    color: "monochrome"
  },
  {
    label: "FBP 面单 72mm x 130mm",
    value: "fbp_label_72x130",
    printer: "label",
    paper: "72mm x 130mm",
    scale: "noscale",
    orientation: "auto",
    color: "monochrome"
  },
  {
    label: "标签面单 30mm x 70mm",
    value: "barcode_70x30",
    printer: "label",
    paper: "70mm*30mm",
    scale: "noscale",
    orientation: "auto",
    color: "monochrome"
  },
  {
    label: "A4 PDF / FBP 申请文件",
    value: "a4_document",
    printer: "document",
    paper: "A4",
    scale: "fit",
    orientation: "portrait",
    color: ""
  }
];

const orientationOptions = [
  { label: "自动", value: "auto" },
  { label: "纵向", value: "portrait" },
  { label: "横向", value: "landscape" }
];

const colorOptions = [
  { label: "打印机默认", value: "" },
  { label: "彩色", value: "color" },
  { label: "黑白", value: "monochrome" }
];

const selectedPrintPreset = computed(() => (
  printPresetOptions.find((item) => item.value === printDialog.preset) || printPresetOptions[0]
));

const statusTabLabelMap = computed(() => new Map((vm.statusTabs || []).map((item) => [item.value, item.label])));

const statusPreferenceRows = computed(() => statusPreferenceDialog.order.map((value) => ({
  value,
  label: statusTabLabelMap.value.get(value) || value
})));

const inventoryDialog = reactive({
  visible: false,
  mode: "bind",
  submitting: false,
  orderId: null,
  orderItemId: null,
  sku: "",
  onlineProductId: null,
  currentProductId: null,
  currentProductName: "",
  itemName: "",
  imageUrl: "",
  sourceUrl: "",
  baseName: "",
  baseWeightG: "",
  purchaseUrl: ""
});

const inventoryOptionsLoading = ref(false);
const inventoryOptions = reactive({
  products: [],
  productTotal: 0,
  people: [],
  suppliers: [],
  logisticsRules: []
});

const bindForm = reactive({
  productId: "",
  personId: ""
});

const createForm = reactive({
  personId: "",
  name: "",
  purchaseUrl: "",
  packageWeightG: "",
  lengthCm: "",
  widthCm: "",
  heightCm: "",
  supplierNote: "",
  note: "",
  amount: "",
  shippingAmount: "",
  quantity: 1,
  supplierId: "",
  sourcePlatform: "1688",
  shippingMethod: "",
  logisticsRuleId: "",
  urgency: "normal",
  neededBy: ""
});



const bindProductQuery = ref("");
const inventoryListPage = ref(1);
const inventoryProductSearchTimer = ref(null);
const orderRouteBootstrapDone = ref(false);

const detailOrder = computed(() => detailDialog.data?.order || {});
const detailItems = computed(() => detailDialog.data?.items || []);
const detailFinance = computed(() => detailDialog.data?.finance || []);
const detailProfitSnapshot = computed(() => detailDialog.data?.profit_detail_snapshot || null);
const detailOrderHasMultipleItems = computed(() => detailItems.value.length > 1);
const detailProfit = computed(() => buildOrderProfitDetail(
  detailOrder.value,
  detailItems.value,
  detailFinance.value,
  detailProfitSnapshot.value,
  { formatMoney, formatSignedMoney, formatPercent }
));
const detailProfitItemCards = computed(() => detailItems.value.map((item, index) => ({
  id: item.id || `${item.ozon_sku || "item"}-${index}`,
  index: index + 1,
  name: item.product_name || item.ozon_name || "订单商品",
  sku: item.ozon_sku || "-",
  offerId: item.offer_id || "-",
  imageUrl: detailItemImageUrl(item),
  saleAmount: detailItemSaleAmount(item),
  estimatedProfit: Number(item.estimated_profit || item.net_profit_cny || 0),
  actualProfit: item.settlement_state === "accrued" || item.profit_status === "accrued"
    ? Number(item.actual_profit || item.net_profit_cny || 0)
    : null,
  statusText: item.settlement_state === "accrued" || item.profit_status === "accrued" ? "已结算" : "预估中"
})));
const selectedInventoryProduct = computed(() => (
  inventoryOptions.products.find((row) => Number(row.id) === Number(bindForm.productId)) || null
));
const inventoryProductTotal = computed(() => inventoryOptions.productTotal);
const filteredInventoryProducts = computed(() => ({ length: inventoryOptions.productTotal }));
const pagedInventoryProducts = computed(() => inventoryOptions.products);
const createQuantity = computed(() => Math.max(1, Number(createForm.quantity || 1)));
const createAmount = computed(() => Math.max(0, Number(createForm.amount || 0)));
const createShippingAmount = computed(() => Math.max(0, Number(createForm.shippingAmount || 0)));
const createUnitPurchaseCost = computed(() => createAmount.value / createQuantity.value);
const createUnitShippingCost = computed(() => createShippingAmount.value / createQuantity.value);
const createWeightG = computed(() => Math.max(0, Number(createForm.packageWeightG || 0)));
const createLengthCm = computed(() => Math.max(0, Number(createForm.lengthCm || 0)));
const createWidthCm = computed(() => Math.max(0, Number(createForm.widthCm || 0)));
const createHeightCm = computed(() => Math.max(0, Number(createForm.heightCm || 0)));
const createVolumetricWeightG = computed(() => {
  if (!createLengthCm.value || !createWidthCm.value || !createHeightCm.value) return 0;
  return Math.round((createLengthCm.value * createWidthCm.value * createHeightCm.value / 6000) * 1000);
});
const createChargeableWeightG = computed(() => (
  createWeightG.value <= 500
    ? createWeightG.value
    : Math.max(createWeightG.value, createVolumetricWeightG.value)
));
const sortedInventoryLogisticsRules = computed(() => (
  [...(inventoryOptions.logisticsRules || [])]
    .filter((item) => Number(item.enabled ?? 1) !== 0)
    .sort((a, b) => {
      const heat = Number(b.usage_count || 0) - Number(a.usage_count || 0);
      if (heat) return heat;
      const weight = Number(a.min_weight_g || 0) - Number(b.min_weight_g || 0);
      if (weight) return weight;
      return Number(a.id || 0) - Number(b.id || 0);
    })
));
const createSelectedLogisticsRule = computed(() => (
  sortedInventoryLogisticsRules.value.find((item) => Number(item.id) === Number(createForm.logisticsRuleId)) || null
));
const createShippingMethodLabel = computed(() => (
  createSelectedLogisticsRule.value ? formatLogisticsRuleLabel(createSelectedLogisticsRule.value) : (createForm.shippingMethod || "-")
));
const orderProcurementProducts = computed(() => (
  Array.isArray(orderProcurementDialog.preview?.products) ? orderProcurementDialog.preview.products : []
));
const orderProcurementItems = computed(() => (
  orderProcurementProducts.value.flatMap((product) => (
    Array.isArray(product.items)
      ? product.items.map((item) => ({ ...item, product }))
      : []
  ))
));
const orderProcurementSelectedCount = computed(() => orderProcurementDialog.selectedItemIds.length);
const orderProcurementSelectedQuantity = computed(() => {
  const selected = new Set(orderProcurementDialog.selectedItemIds.map(Number));
  return orderProcurementItems.value
    .filter((item) => selected.has(Number(item.order_item_id)))
    .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
});

function inventoryProductLabel(row) {
  if (!row) return "";
  return row.name || row.inventory_id || row.code || `#${row.id}`;
}

function inventoryProductCode(row) {
  return row?.inventory_id || row?.code || row?.selection_id || `#${row?.id || "-"}`;
}

function inventoryProductSkuText(row) {
  return row?.mapped_skus || "未绑定 SKU";
}

function inventoryProductOwner(row) {
  return row?.owner_name || "未分配负责人";
}

function supplierName(id) {
  return inventoryOptions.suppliers.find((supplier) => Number(supplier.id) === Number(id))?.name || "";
}

function defaultLogisticsRule() {
  const rules = sortedInventoryLogisticsRules.value;
  return rules.find((rule) => String(rule.name || "").includes("CEL 陆空标准 Extra Small"))
    || rules[0]
    || null;
}

function inventoryProductImage(row) {
  return row?.product_image_url || row?.image_url || "";
}

function preferredPersonId() {
  return String(inventoryOptions.people[0]?.id || "");
}

function normalizePagedRows(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

watch(bindProductQuery, () => {
  if (!inventoryDialog.visible || inventoryDialog.mode !== "bind") return;
  inventoryListPage.value = 1;
  if (inventoryProductSearchTimer.value) window.clearTimeout(inventoryProductSearchTimer.value);
  inventoryProductSearchTimer.value = window.setTimeout(() => {
    loadInventoryProductOptions();
  }, 250);
});

watch(inventoryListPage, () => {
  if (!inventoryDialog.visible || inventoryDialog.mode !== "bind") return;
  loadInventoryProductOptions();
});

function toggleAll(checked) {
  selectedOrderIds.value = checked
    ? new Set((vm.rows || []).map((row) => Number(row.id)).filter(Boolean))
    : new Set();
}

function toggleRow(orderId, checked) {
  const next = new Set(selectedOrderIds.value);
  const id = Number(orderId);
  if (checked) next.add(id);
  else next.delete(id);
  selectedOrderIds.value = next;
}

function currentStatusTabOrder() {
  const fallback = Array.isArray(defaultStatusTabOrder) ? defaultStatusTabOrder : [];
  const current = (vm.statusTabs || []).map((item) => String(item.value || "")).filter(Boolean);
  return current.length ? current : fallback;
}

function openStatusPreferenceDialog() {
  statusPreferenceDialog.order = [...currentStatusTabOrder()];
  statusPreferenceDialog.visible = true;
}

function moveStatusPreference(index, delta) {
  const nextIndex = Number(index) + Number(delta);
  if (nextIndex < 0 || nextIndex >= statusPreferenceDialog.order.length) return;
  const next = [...statusPreferenceDialog.order];
  const [item] = next.splice(index, 1);
  next.splice(nextIndex, 0, item);
  statusPreferenceDialog.order = next;
}

function pinStatusPreference(index, target) {
  const next = [...statusPreferenceDialog.order];
  const [item] = next.splice(index, 1);
  if (!item) return;
  if (target === "bottom") {
    next.push(item);
  } else {
    next.unshift(item);
  }
  statusPreferenceDialog.order = next;
}

function resetStatusPreference() {
  statusPreferenceDialog.order = [...defaultStatusTabOrder];
}

async function saveStatusPreference() {
  statusPreferenceDialog.saving = true;
  try {
    await saveStatusTabPreference(statusPreferenceDialog.order);
    statusPreferenceDialog.visible = false;
    ElMessage.success("订单标签顺序已保存");
  } catch (error) {
    ElMessage.error(error.message || "保存订单标签顺序失败");
  } finally {
    statusPreferenceDialog.saving = false;
  }
}

function rowStateLabel(row) {
  const status = String(row?.status || "").toLowerCase();
  const stage = String(row?.tracking_stage || "").toLowerCase();
  const logisticsStatus = String(row?.logistics_status || "").toLowerCase();
  const text = `${status} ${stage} ${logisticsStatus}`.trim();

  if (["awaiting_deliver", "posting_registered", "sent_by_seller", "posting_ready_for_pickup", "posting_transferred_to_courier_service", "posting_transferring", "posting_in_carriage", "posting_transferring_to_delivery"].some((value) => text.includes(value))) {
    return "等待发货";
  }
  if (["delivering", "transferring", "carriage", "pickup", "sorting", "customs", "shipped", "sent", "on_way", "发往", "已上网", "发走"].some((value) => text.includes(value))) {
    return "运输中";
  }
  if (["awaiting_registration", "acceptance_in_progress", "awaiting_approve", "awaiting_packaging", "posting_created", "posting_awaiting_registration", "posting_acceptance_in_progress"].some((value) => text.includes(value))) {
    return "等待备货";
  }
  if (text.includes("delivered")) return "已签收";
  if (text.includes("cancel")) return "已取消";
  if (text.includes("dispute") || text.includes("arbitration")) return "有争议";

  return STATE_META[status]?.label || row?.tracking_stage || row?.status || "-";
}

function rowDisplayStateKey(row) {
  const status = String(row?.status || "").toLowerCase();
  const stage = String(row?.tracking_stage || "").toLowerCase();
  const logisticsStatus = String(row?.logistics_status || "").toLowerCase();
  const text = `${status} ${stage} ${logisticsStatus}`.trim();

  if (["awaiting_deliver", "posting_registered", "sent_by_seller", "posting_ready_for_pickup", "posting_transferred_to_courier_service", "posting_transferring", "posting_in_carriage", "posting_transferring_to_delivery"].some((value) => text.includes(value))) {
    return "awaiting_deliver";
  }
  if (["delivering", "transferring", "carriage", "pickup", "sorting", "customs", "shipped", "sent", "on_way", "发往", "已上网", "发走"].some((value) => text.includes(value))) {
    return "delivering";
  }
  if (["awaiting_registration", "acceptance_in_progress", "awaiting_approve", "awaiting_packaging", "posting_created", "posting_awaiting_registration", "posting_acceptance_in_progress"].some((value) => text.includes(value))) {
    return "awaiting_packaging";
  }
  if (text.includes("delivered")) return "delivered";
  if (text.includes("cancel")) return "cancelled";
  if (text.includes("dispute") || text.includes("arbitration")) return "dispute";
  return status || "all";
}

function rowStateColor(row) {
  const key = rowDisplayStateKey(row);
  return STATE_META[key]?.color || "slate";
}

function rowAvailableActions(row) {
  const displayStateKey = rowDisplayStateKey(row);
  const statusText = [
    row?.status,
    row?.tracking_stage,
    row?.logistics_status,
    row?.workbenchState?.key
  ].map((item) => String(item || "").toLowerCase()).join(" ");
  const printed = Boolean(row?.printed_at || row?.label_printed_at || row?.shipping_label_printed_at || row?.isPrinted);
  const isCancelled = displayStateKey === "cancelled" || statusText.includes("cancel") || statusText.includes("return");
  const isDelivered = displayStateKey === "delivered" || statusText.includes("delivered") || statusText.includes("received");
  const isDispute = displayStateKey === "dispute" || statusText.includes("dispute") || statusText.includes("arbitration");
  const isDelivering = displayStateKey === "delivering";
  const isAwaitingDeliver = displayStateKey === "awaiting_deliver";
  const logisticsText = [
    row?.warehouse_name,
    row?.delivery_method_name,
    row?.delivery_method,
    row?.shipping_method,
    row?.logistics_channel,
    row?.delivery_schema
  ].map((item) => String(item || "").toLowerCase()).join(" ");
  const isFbp = logisticsText.includes("fbp")
    || logisticsText.includes("hunchun")
    || logisticsText.includes("hun chun")
    || logisticsText.includes("鐝叉槬")
    || logisticsText.includes("娣锋槬")
    || logisticsText.includes("娣峰窛");
  const isAwaitingPackaging = ["awaiting_packaging", "unbound", "stock_issue"].includes(displayStateKey);
  const beforeTransit = !isCancelled && !isDelivered && !isDispute && !isDelivering;
  const procurementTotal = Number(row?.procurement_total_item_count || 0);
  const procurementHandledCount = Number(row?.procurement_handled_item_count || 0);
  const procurementHandled = procurementTotal > 0 && procurementHandledCount >= procurementTotal;
  const apiActions = row?.availableActions && typeof row.availableActions === "object" ? row.availableActions : {};
  const showPrepare = beforeTransit && !isFbp && isAwaitingPackaging && apiActions.prepare !== false;
  const showPurchase = beforeTransit && (isAwaitingDeliver || isAwaitingPackaging) && !procurementHandled && apiActions.purchase !== false;
  const showPrint = beforeTransit && isAwaitingDeliver && apiActions.print !== false;
  const canPrint = showPrint && !isFbp && (Boolean(apiActions.print) || printed || isAwaitingDeliver);
  return {
    ...apiActions,
    print: canPrint,
    prepare: showPrepare,
    purchase: showPurchase,
    showPrint,
    showPrepare,
    showPurchase,
    profit: apiActions.profit !== false
  };
}

function trackingLinkFor(value) {
  const track = String(value || "").trim();
  return track
    ? `https://tracking.ozon.ru/?${new URLSearchParams({ track, local: "zh-Hans" }).toString()}`
    : "";
}

function formatOrderTitleParts(value) {
  const text = String(value || "").trim();
  const dashIndex = text.indexOf("-");
  if (dashIndex <= 0) return [{ text, strong: false }];
  const firstPart = text.slice(0, dashIndex);
  const strongStart = Math.max(0, firstPart.length - 4);
  const prefix = text.slice(0, strongStart);
  const strongPart = text.slice(strongStart, dashIndex);
  const rest = text.slice(dashIndex);
  return [
    { text: prefix, strong: false },
    { text: strongPart, strong: true },
    { text: rest, strong: false }
  ].filter((part) => part.text);
}

function detailItemImageUrl(item = {}) {
  return item.ozon_image_url
    || item.image_url
    || item.online_primary_image
    || item.online_image_url
    || item.primary_image
    || item.product_image_url
    || firstCsvValue(detailOrder.value.order_image_urls)
    || firstCsvValue(detailOrder.value.image_urls)
    || "";
}

function detailItemSaleAmount(item = {}) {
  return Number(item.sale_amount_cny || 0) || (Number(item.sale_price || 0) * Number(item.quantity || 0));
}

function buildProfitSummary(row) {
  const estimated = Number(row.estimated_profit || 0);
  const actual = Number(row.actual_profit || 0);
  return {
    revenue: Number(row.revenue || 0),
    estimated,
    actual,
    hasActual: Math.abs(actual) > 0.000001 || String(row.status || "").toLowerCase() === "delivered"
  };
}

function buildLogisticsSummary(row) {
  const shipmentNumber = String(row.posting_number || row.order_number || "").trim();
  const trackingNumber = String(row.tracking_number || "").trim();
  const trackingTarget = trackingNumber || shipmentNumber;
  return {
    shipmentNumber,
    tracking: trackingNumber,
    trackingNumber,
    trackingLink: trackingLinkFor(trackingTarget),
    hasSeparateTrackingNumber: Boolean(trackingNumber && shipmentNumber && trackingNumber !== shipmentNumber),
    deliveryMethod: row.delivery_method_name || row.delivery_method || row.shipping_method || "",
    deliveryMethodLabel: row.fulfillment_type_label || "FBS",
    resolvedRuleName: row.resolved_logistics_rule_name || "--",
    warehouse: row.warehouse_name || "",
    channel: row.logistics_channel || "",
    deadline: row.shipment_deadline_at || "",
    overdue: Boolean(row.is_overdue)
  };
}

function buildStatusDeadlineHint(displayStateKey, logisticsSummary) {
  if (!["awaiting_packaging", "awaiting_deliver"].includes(displayStateKey)) return "";
  if (!logisticsSummary.deadline) return "";
  const time = new Date(logisticsSummary.deadline).getTime();
  if (!Number.isFinite(time)) return "";
  const diffDays = Math.ceil((time - Date.now()) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return `超时 ${Math.abs(diffDays)} 天`;
  if (diffDays === 0) return "今天到期";
  return `剩余 ${diffDays} 天`;
}

function buildProcurementState(row = {}) {
  const total = Number(row.procurement_total_item_count || 0);
  const handled = Number(row.procurement_handled_item_count || 0);
  if (!total || !handled) return { handled: false, label: "", detail: "" };
  const types = splitCsv(row.procurement_handling_types);
  const stockCount = types.includes("stock_available");
  const requestCount = types.includes("procurement_request");
  const detail = stockCount && requestCount
    ? "库存可满足/已提交采购"
    : stockCount
      ? "库存可满足"
      : "已提交采购";
  return {
    handled: handled >= total,
    partial: handled > 0 && handled < total,
    label: handled >= total ? "采购已处理" : "部分处理",
    detail
  };
}

function buildTableRow(row) {
  const productDisplayRows = buildProductDisplayRows(row);
  const profitSummary = buildProfitSummary(row);
  const logisticsSummary = buildLogisticsSummary(row);
  const displayStateKey = rowDisplayStateKey(row);
  const orderTitle = row.posting_number || row.order_number || `Order #${row.id}`;
  const orderTitleParts = formatOrderTitleParts(orderTitle);
  const orderNo = String(row?.posting_number || row?.order_number || "").trim();
  const stockSummary = productDisplayRows.reduce((summary, item) => ({
    fbs: summary.fbs + Number(item.stock?.fbs || 0),
    fbp: summary.fbp + Number(item.stock?.fbp || 0)
  }), { fbs: 0, fbp: 0 });
  const quantitySummary = Number(row.total_quantity || row.quantity_total || row.quantity || row.item_count || 1);
  const productIds = splitCsv(row.product_ids).map((item) => Number(item)).filter(Boolean);
  const productNames = splitCsv(row.product_names);
  const seenProductIds = new Set();
  const inventorySummaries = productDisplayRows
    .filter((item) => Number(item.productId || 0) > 0)
    .map((item) => {
      const productId = Number(item.productId || 0);
      const fallbackIndex = productIds.findIndex((id) => Number(id) === productId);
      return {
        productId,
        orderItemId: Number(item.orderItemId || 0) || null,
        sku: item.sku || "",
        productName: fallbackIndex >= 0 ? (productNames[fallbackIndex] || item.name) : (item.name || productNames[0] || "库存商品"),
        saleAmount: Number(item.saleAmount || 0),
        estimatedProfit: Number(item.estimatedProfit || 0),
        actualProfit: Number(item.actualProfit || 0),
        actualProfitReady: Boolean(item.actualProfitReady),
        amountText: `CNY ${formatMoney(item.saleAmount || 0)}`,
        stock: item.stock || { fbs: 0, fbp: 0 }
      };
    })
    .filter((item) => {
      if (seenProductIds.has(item.productId)) return false;
      seenProductIds.add(item.productId);
      return true;
    });
  const cancelReasonText = displayStateKey === "cancelled" ? row?.cancel_reason_label || "--" : "--";
  const unboundItems = productDisplayRows.filter((item) => item.unbound);
  const inventoryBoundCount = inventorySummaries.length;
  const inventoryPendingCount = unboundItems.length;

  return {
    ...row,
    orderTitle,
    orderTitleParts,
    quantitySummary,
    stockSummary,
    productDisplayRows,
    unboundItems,
    inventorySummaries,
    inventoryBoundCount,
    inventoryPendingCount,
    printedState: Boolean(row.printed_at),
    printed_at: row.printed_at || "",
    profitSummary,
    logisticsSummary,
    cancelReasonText,
    amountText: `CNY ${formatMoney(profitSummary.revenue)}`,
    statusLabel: rowStateLabel(row),
    statusColor: rowStateColor(row),
    statusDeadlineHint: buildStatusDeadlineHint(displayStateKey, logisticsSummary),
    procurementState: buildProcurementState(row),
    availableActions: rowAvailableActions(row)
  };
}

const tableRows = computed(() => (
  Array.isArray(vm.rows) ? vm.rows.map((row) => buildTableRow(row)) : []
));

function findOrderRow(orderId) {
  return tableRows.value.find((row) => Number(row.id) === Number(orderId)) || null;
}

function resolveOrderInventoryContext(orderId, sku) {
  const row = findOrderRow(orderId);
  if (!row) return null;
  const itemSku = String(sku || "").trim();
  const displayItem = (row.productDisplayRows || []).find((item) => item.sku === itemSku) || null;
  const onlineProductId = Number(displayItem?.onlineId || 0) || null;
  const currentProductId = Number(displayItem?.productId || 0) || null;
  const productIds = splitCsv(row.product_ids).map((item) => Number(item));
  const productNames = splitCsv(row.product_names);
  const currentProductIndex = currentProductId ? productIds.findIndex((id) => Number(id) === currentProductId) : -1;
  const rawInventoryName = currentProductIndex >= 0 ? productNames[currentProductIndex] : productNames[0];
  const inventoryName = rawInventoryName && rawInventoryName !== "Unbound product" ? rawInventoryName : "";
  const itemName = displayItem?.name || inventoryName || itemSku || `璁㈠崟 ${orderId}`;
  const currentProductName = currentProductId ? (inventoryName || itemName) : "";
  const sourceUrl = firstCsvValue(row.purchase_urls) || displayItem?.purchaseUrl || displayItem?.sourceUrl || row.product_purchase_url || row.purchase_url || "";
  const baseWeightG = Number(displayItem?.weight_g || row.package_weight_g || 0) || "";
  return {
    sku: itemSku,
    orderItemId: Number(displayItem?.orderItemId || 0) || null,
    onlineProductId,
    currentProductId,
    currentProductName,
    itemName,
    imageUrl: displayItem?.imageUrl || firstCsvValue(row.order_image_urls) || firstCsvValue(row.image_urls) || "",
    sourceUrl,
    baseWeightG
  };
}

async function ensureInventoryOptionsLoaded() {
  inventoryOptionsLoading.value = true;
  try {
    const [people, suppliers, logisticsRules] = await Promise.all([
      apiClient.get("/api/people"),
      apiClient.get("/api/suppliers?paged=1&page=1&pageSize=100"),
      apiClient.get("/api/logistics-rules")
    ]);
    inventoryOptions.people = Array.isArray(people) ? people.filter((item) => Number(item.active ?? 1) !== 0) : [];
    inventoryOptions.suppliers = Array.isArray(suppliers?.rows) ? suppliers.rows : [];
    inventoryOptions.logisticsRules = Array.isArray(logisticsRules) ? logisticsRules : [];
    if (!createForm.logisticsRuleId) {
      const defaultRule = defaultLogisticsRule();
      if (defaultRule) {
        createForm.logisticsRuleId = String(defaultRule.id);
        createForm.shippingMethod = defaultRule.channel || defaultRule.name || "";
      }
    }
  } catch (error) {
    ElMessage.error(error.message || "初始化库存选项失败");
    throw error;
  } finally {
    inventoryOptionsLoading.value = false;
  }
}

function inventoryProductQueryString() {
  const params = new URLSearchParams({
    paged: "1",
    page: String(inventoryListPage.value),
    pageSize: String(INVENTORY_LIST_PAGE_SIZE)
  });
  const query = String(bindProductQuery.value || "").trim();
  if (query) params.set("query", query);
  return params.toString();
}

async function loadInventoryProductOptions() {
  inventoryOptionsLoading.value = true;
  try {
    const result = await apiClient.get(`/api/products?${inventoryProductQueryString()}`);
    inventoryOptions.products = normalizePagedRows(result).filter((item) => Number(item.active ?? 1) !== 0);
    inventoryOptions.productTotal = Array.isArray(result) ? inventoryOptions.products.length : Number(result?.total || 0);
  } catch (error) {
    ElMessage.error(error.message || "加载库存商品失败");
    throw error;
  } finally {
    inventoryOptionsLoading.value = false;
  }
}

async function handleInventoryProductSearch() {
  inventoryListPage.value = 1;
  await loadInventoryProductOptions();
}

async function handleInventoryProductPageChange(page) {
  inventoryListPage.value = Number(page || 1);
  await loadInventoryProductOptions();
}

function resetInventoryDialog() {
  inventoryDialog.visible = false;
  inventoryDialog.mode = "bind";
  inventoryDialog.submitting = false;
  inventoryDialog.orderId = null;
  inventoryDialog.orderItemId = null;
  inventoryDialog.sku = "";
  inventoryDialog.onlineProductId = null;
  inventoryDialog.currentProductId = null;
  inventoryDialog.currentProductName = "";
  inventoryDialog.itemName = "";
  inventoryDialog.imageUrl = "";
  inventoryDialog.sourceUrl = "";
  inventoryDialog.baseName = "";
  inventoryDialog.baseWeightG = "";
  inventoryDialog.purchaseUrl = "";
  bindForm.productId = "";
  bindForm.personId = "";
  createForm.personId = "";
  createForm.name = "";
  createForm.purchaseUrl = "";
  createForm.packageWeightG = "";
  createForm.lengthCm = "15";
  createForm.widthCm = "10";
  createForm.heightCm = "5";
  createForm.supplierNote = "";
  createForm.note = "";
  createForm.amount = "";
  createForm.shippingAmount = "";
  createForm.quantity = 1;
  createForm.supplierId = "";
  createForm.sourcePlatform = "1688";
  createForm.shippingMethod = "";
  createForm.urgency = "normal";
  createForm.neededBy = "";
  bindProductQuery.value = "";
  inventoryListPage.value = 1;
  inventoryOptions.products = [];
  inventoryOptions.productTotal = 0;
  if (inventoryProductSearchTimer.value) {
    window.clearTimeout(inventoryProductSearchTimer.value);
    inventoryProductSearchTimer.value = null;
  }
}

function selectedActionOrderIds(action) {
  return tableRows.value
    .filter((row) => selectedOrderIds.value.has(Number(row.id)) && row.availableActions?.[action] !== false)
    .map((row) => Number(row.id))
    .filter(Boolean);
}

async function syncRecentOrdersAction() {
  await syncRecent();
}

async function syncAllOrdersAction() {
  await syncAll();
}

function openPrintDialog(orderIds = []) {
  const ids = Array.isArray(orderIds) ? orderIds.map(Number).filter(Boolean) : [];
  if (!ids.length) return ElMessage.warning("请选择需要打印的订单");
  printDialog.orderIds = ids;
  printDialog.preset = "order_label_72x130";
  printDialog.copies = 1;
  printDialog.scale = "noscale";
  printDialog.orientation = "auto";
  printDialog.color = "monochrome";
  printDialog.visible = true;
}

function buildPrintSettings() {
  const preset = selectedPrintPreset.value;
  return [
    printDialog.scale,
    printDialog.orientation === "auto" ? "" : printDialog.orientation,
    printDialog.color,
    preset.paper ? `paper=${preset.paper}` : ""
  ].filter(Boolean).join(",");
}

function applyPrintPreset() {
  const preset = selectedPrintPreset.value;
  printDialog.scale = preset.scale || "fit";
  printDialog.orientation = preset.orientation || "auto";
  printDialog.color = preset.color || "";
}

async function previewPrintLabels() {
  const ids = printDialog.orderIds.map(Number).filter(Boolean);
  if (!ids.length) return;
  printDialog.previewing = true;
  try {
    const response = await apiClient.blobResponse("/api/orders/package-label", {
      method: "POST",
      body: JSON.stringify({
        order_ids: ids,
        require_all: true,
        printer: selectedPrintPreset.value.printer,
        print_settings: buildPrintSettings(),
        preset: selectedPrintPreset.value.value,
        paper_size: selectedPrintPreset.value.value,
        orientation: printDialog.orientation
      })
    });
    const url = URL.createObjectURL(response.blob);
    window.open(url, "_blank", "noopener");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    ElMessage.error(`预览失败：${error?.message || "未知错误"}`);
  } finally {
    printDialog.previewing = false;
  }
}

async function submitPrintDialog() {
  const ids = printDialog.orderIds.map(Number).filter(Boolean);
  if (!ids.length) return;
  printDialog.submitting = true;
  try {
    await bulkPrint(ids, {
      printer: selectedPrintPreset.value.printer,
      printSettings: buildPrintSettings(),
      preset: selectedPrintPreset.value.value,
      paperSize: selectedPrintPreset.value.value,
      orientation: printDialog.orientation,
      copies: printDialog.copies
    });
    printDialog.visible = false;
    orderDetailCache.clear();
  } finally {
    printDialog.submitting = false;
  }
}

function bulkPrintSelected() {
  if (!selectedOrderIds.value.size) return ElMessage.warning("请先选择订单");
  const ids = selectedActionOrderIds("print");
  if (!ids.length) return ElMessage.warning("已选订单里没有可打印面单的订单");
  const skipped = selectedOrderIds.value.size - ids.length;
  if (skipped > 0) ElMessage.warning(`已跳过 ${skipped} 个不可打印订单`);
  return openPrintDialog(ids);
}

function handleToolbarMoreAction(action) {
  if (action === "print-selected") return bulkPrintSelected();
  return handleMoreAction(action);
}

function bulkPrepareSelected() {
  if (!selectedOrderIds.value.size) return ElMessage.warning("请先选择订单");
  const ids = selectedActionOrderIds("prepare");
  if (!ids.length) return ElMessage.warning("已选订单里没有可备货的订单");
  const skipped = selectedOrderIds.value.size - ids.length;
  const message = skipped > 0
    ? `确认批量备货 ${ids.length} 个可备货订单？将跳过 ${skipped} 个不可备货订单。`
    : "确认批量备货所选订单？";
  ElMessageBox.confirm(message, "批量备货", { type: "warning" })
    .then(() => bulkPrepare(ids));
}

async function openDrawer(mode, orderId) {
  detailDialog.visible = true;
  detailDialog.loading = true;
  detailDialog.mode = mode;
  detailDialog.orderId = Number(orderId);
  try {
    const cacheKey = Number(orderId);
    const cached = orderDetailCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < ORDER_DETAIL_CACHE_TTL_MS) {
      detailDialog.data = cached.payload;
      return;
    }
    const payload = await fetchOrderDetail(orderId);
    orderDetailCache.set(cacheKey, {
      payload,
      timestamp: Date.now()
    });
    detailDialog.data = payload;
  } finally {
    detailDialog.loading = false;
  }
}

function openProfitDetail(orderId) {
  return openDrawer("profit", orderId);
}

function hasAftersalesReturnContext() {
  return String(route.query.from || "") === "profit-aftersales";
}

function backToAftersales() {
  router.push({
    path: "/profit/aftersales",
    query: {
      from: String(route.query.returnFrom || ""),
      to: String(route.query.returnTo || ""),
      shopId: String(route.query.returnShopId || "all"),
      bucket: String(route.query.returnFilterBucket || route.query.returnBucket || "all"),
      detailBucket: String(route.query.returnDetailBucket || route.query.returnBucket || ""),
      detailPage: String(route.query.returnDetailPage || "1"),
      detailPageSize: String(route.query.returnDetailPageSize || "10")
    }
  });
}

async function bootstrapFromRoute() {
  if (orderRouteBootstrapDone.value) return;
  const orderId = Number(route.query.orderId || 0);
  if (!orderId) return;
  orderRouteBootstrapDone.value = true;
  vm.filters.searchType = "order";
  vm.filters.searchQuery = String(orderId);
  vm.filters.page = 1;
  await submitFilters();
  await openProfitDetail(orderId);
}

async function handleRecalculate(orderId) {
  const numericOrderId = Number(orderId || 0);
  if (!numericOrderId || detailDialog.recalculating) return;
  detailDialog.recalculating = true;
  try {
    const result = await recalculateOrderProfit(numericOrderId);
    orderDetailCache.delete(numericOrderId);
    await loadOrders();
    if (detailDialog.visible && Number(detailDialog.orderId) === numericOrderId) {
      await openDrawer(detailDialog.mode, numericOrderId);
    }
    const updated = Number(result?.updated || 0);
    const unbound = Number(result?.unbound || 0);
    const parts = [];
    parts.push(updated > 0 ? `已重算 ${updated} 个商品行` : "已执行重算，当前没有可更新的商品行");
    if (unbound > 0) parts.push(`${unbound} 个商品行未绑定库存产品`);
    ElMessage.success(parts.join("，"));
  } catch (error) {
    ElMessage.error(error?.message || "重算利润失败");
  } finally {
    detailDialog.recalculating = false;
  }
}

async function handlePrepareOrder(orderId) {
  await prepareSingleOrder(orderId);
  orderDetailCache.delete(Number(orderId));
}

async function handlePrintOrder(orderId) {
  openPrintDialog([orderId]);
}

async function showQualityRules() {
  qualityDialog.visible = true;
  qualityDialog.loading = true;
  try {
    const rules = await openQualityRules();
    const list = Array.isArray(rules) ? rules : [];
    qualityDialog.prefixesText = list.map((item) => item.prefix).filter(Boolean).join("\n");
    qualityDialog.note = list[0]?.note || "命中这些前缀的订单会标记为质检单。";
  } finally {
    qualityDialog.loading = false;
  }
}

async function submitQualityRules() {
  qualityDialog.saving = true;
  try {
    const prefixes = qualityDialog.prefixesText
      .split(/[\s,，]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    await saveQualityRules({ prefixes, note: qualityDialog.note });
    ElMessage.success("质检规则已保存");
    qualityDialog.visible = false;
    await loadOrders();
  } finally {
    qualityDialog.saving = false;
  }
}

function closeQualityDialog() {
  qualityDialog.visible = false;
}

async function handleSaveMark(orderId, markType) {
  await saveOrderMark(orderId, markType);
  vm.rows = (vm.rows || []).map((row) => (
    Number(row.id) === Number(orderId)
      ? { ...row, mark_type: String(markType || "") }
      : row
  ));
  ElMessage.success("订单标记已更新");
}

async function handleOpenOrderProcurement(orderId) {
  orderProcurementDialog.orderId = Number(orderId || 0) || null;
  if (!orderProcurementDialog.orderId) return;
  orderProcurementDialog.visible = true;
  orderProcurementDialog.loading = true;
  orderProcurementDialog.preview = null;
  orderProcurementDialog.selectedItemIds = [];
  try {
    orderProcurementDialog.preview = await previewOrderProcurement(orderProcurementDialog.orderId);
    initializeProcurementPurchaseInputs();
    orderProcurementDialog.selectedItemIds = orderProcurementItems.value.map((item) => Number(item.order_item_id)).filter(Boolean);
  } catch (error) {
    ElMessage.error(error.message || "采购预览加载失败");
    orderProcurementDialog.visible = false;
  } finally {
    orderProcurementDialog.loading = false;
  }
}

function initializeProcurementPurchaseInputs() {
  for (const product of orderProcurementProducts.value) {
    const shortage = Math.max(0, Number(product.shortage_quantity || 0));
    const totalQuantity = Math.max(1, Number(product.total_quantity || 1));
    const unitAmount = Number(product.estimated_amount || 0) / totalQuantity;
    const unitShipping = Number(product.estimated_shipping || 0) / totalQuantity;
    product.purchase_quantity = shortage;
    product.purchase_amount = Number((unitAmount * shortage).toFixed(2));
    product.purchase_shipping = Number((unitShipping * shortage).toFixed(2));
  }
}

function selectedProcurementProductIds() {
  const selected = new Set(orderProcurementDialog.selectedItemIds.map(Number));
  return new Set(orderProcurementItems.value
    .filter((item) => selected.has(Number(item.order_item_id)))
    .map((item) => Number(item.product?.product_id || 0))
    .filter(Boolean));
}

function procurementPurchasePayload() {
  const selectedProducts = selectedProcurementProductIds();
  return orderProcurementProducts.value
    .filter((product) => selectedProducts.has(Number(product.product_id)))
    .map((product) => ({
      product_id: Number(product.product_id),
      quantity: Number(product.purchase_quantity || 0),
      amount: Number(product.purchase_amount || 0),
      shipping_amount: Number(product.purchase_shipping || 0)
    }));
}

function validateProcurementPurchaseInputs() {
  return true;
}

function handleProcurementQuantityChange(product) {
  if (!product || Number(product.purchase_quantity || 0) !== 0) return;
  product.purchase_amount = 0;
  product.purchase_shipping = 0;
}

async function handleAdjustStockDebt(product) {
  const productId = Number(product?.product_id || 0);
  const quantity = Math.max(0, Number(product?.stock_debt || 0));
  if (!productId || quantity <= 0) return;
  await ElMessageBox.confirm(
    `确认给「${product.product_name || product.product_code || productId}」新增 ${quantity} 件历史负库存冲正流水？这会把账面库存补到 0，不会删除原始订单出库记录。`,
    "冲正历史欠账",
    { type: "warning", confirmButtonText: "确认冲正", cancelButtonText: "取消" }
  );
  stockDebtAdjustingProductId.value = productId;
  try {
    await apiClient.post("/api/inventory/stock-debts/adjust", {
      product_id: productId,
      quantity,
      note: `订单采购弹框冲正历史负库存：${product.product_code || productId} / ${product.product_name || ""}`
    });
    ElMessage.success("历史欠账已冲正");
    const selectedIds = [...orderProcurementDialog.selectedItemIds];
    orderProcurementDialog.preview = await previewOrderProcurement(orderProcurementDialog.orderId);
    initializeProcurementPurchaseInputs();
    const availableIds = new Set(orderProcurementItems.value.map((item) => Number(item.order_item_id)).filter(Boolean));
    orderProcurementDialog.selectedItemIds = selectedIds.filter((id) => availableIds.has(Number(id)));
    await loadOrders();
  } catch (error) {
    if (error !== "cancel") ElMessage.error(error.message || "历史欠账冲正失败");
  } finally {
    stockDebtAdjustingProductId.value = null;
  }
}

async function submitOrderProcurement() {
  if (!orderProcurementDialog.orderId) return;
  if (!orderProcurementDialog.selectedItemIds.length) {
    ElMessage.warning("请至少选择一条关联订单");
    return;
  }
  if (!validateProcurementPurchaseInputs()) return;
  orderProcurementDialog.submitting = true;
  try {
    const result = await createOrderProcurementRequests(orderProcurementDialog.orderId, {
      order_item_ids: orderProcurementDialog.selectedItemIds,
      product_purchases: procurementPurchasePayload()
    });
    const createdCount = Number(result?.created_count || 0);
    const stockCount = Number(result?.stock_satisfied_count || 0);
    const markedCount = Number(result?.marked_count || 0);
    if (markedCount > 0) {
      ElMessage.success(`采购建议已处理：${stockCount} 条库存可满足，${createdCount} 条已生成采购建议`);
    } else {
      ElMessage.info("当前没有新的待采购订单明细");
    }
    orderProcurementDialog.visible = false;
    await loadOrders();
  } catch (error) {
    ElMessage.error(error.message || "生成采购建议失败");
  } finally {
    orderProcurementDialog.submitting = false;
  }
}

function procurementItemSelected(item) {
  return orderProcurementDialog.selectedItemIds.map(Number).includes(Number(item?.order_item_id));
}

function setProcurementItemSelected(item, selected) {
  const id = Number(item?.order_item_id || 0);
  if (!id) return;
  const ids = new Set(orderProcurementDialog.selectedItemIds.map(Number));
  if (selected) ids.add(id);
  else ids.delete(id);
  orderProcurementDialog.selectedItemIds = [...ids];
}

function firstProcurementMissingItem() {
  return orderProcurementDialog.preview?.missing_items?.[0] || null;
}

async function bindFirstProcurementMissingItem() {
  const item = firstProcurementMissingItem();
  if (!item) return;
  orderProcurementDialog.visible = false;
  await handleOpenBindProductFromOrder(item.order_id || orderProcurementDialog.orderId, item.ozon_sku);
}

async function createInventoryForFirstProcurementMissingItem() {
  const item = firstProcurementMissingItem();
  if (!item) return;
  orderProcurementDialog.visible = false;
  await handleOpenCreateProductFromOrder(item.order_id || orderProcurementDialog.orderId, item.ozon_sku);
}

async function handleOpenBindProductFromOrder(orderId, sku) {
  const context = resolveOrderInventoryContext(orderId, sku);
  if (!context?.onlineProductId) {
    ElMessage.warning("当前 SKU 缺少在线商品 ID，暂时无法修改绑定");
    return;
  }
  await ensureInventoryOptionsLoaded();
  inventoryDialog.mode = "bind";
  inventoryDialog.visible = true;
  inventoryDialog.orderId = Number(orderId);
  inventoryDialog.orderItemId = context.orderItemId;
  inventoryDialog.sku = context.sku;
  inventoryDialog.onlineProductId = context.onlineProductId;
  inventoryDialog.currentProductId = context.currentProductId;
  inventoryDialog.currentProductName = context.currentProductName;
  inventoryDialog.itemName = context.itemName;
  inventoryDialog.imageUrl = context.imageUrl;
  bindForm.productId = context.currentProductId ? String(context.currentProductId) : "";
  bindForm.personId = preferredPersonId();
  bindProductQuery.value = "";
  inventoryListPage.value = 1;
  await loadInventoryProductOptions();
}

async function handleOpenCreateProductFromOrder(orderId, sku) {
  const context = resolveOrderInventoryContext(orderId, sku);
  if (!context?.onlineProductId) {
    ElMessage.warning("当前 SKU 缺少在线商品 ID，暂时无法创建库存");
    return;
  }
  await ensureInventoryOptionsLoaded();
  inventoryDialog.mode = "create";
  inventoryDialog.visible = true;
  inventoryDialog.orderId = Number(orderId);
  inventoryDialog.orderItemId = context.orderItemId;
  inventoryDialog.sku = context.sku;
  inventoryDialog.onlineProductId = context.onlineProductId;
  inventoryDialog.currentProductId = context.currentProductId;
  inventoryDialog.currentProductName = context.currentProductName;
  inventoryDialog.itemName = context.itemName;
  inventoryDialog.imageUrl = context.imageUrl;
  inventoryDialog.sourceUrl = context.sourceUrl;
  inventoryDialog.baseName = context.itemName;
  inventoryDialog.baseWeightG = context.baseWeightG;
  inventoryDialog.purchaseUrl = context.sourceUrl;
  createForm.personId = preferredPersonId();
  createForm.name = context.itemName;
  createForm.purchaseUrl = context.sourceUrl;
  createForm.packageWeightG = context.baseWeightG || "";
  createForm.lengthCm = "15";
  createForm.widthCm = "10";
  createForm.heightCm = "5";
  createForm.supplierNote = `From Ozon SKU ${context.sku}${context.currentProductName ? ` / ${context.currentProductName}` : ""}`;
  createForm.note = "";
  createForm.amount = "";
  createForm.shippingAmount = "";
  createForm.quantity = 1;
  createForm.supplierId = "";
  createForm.sourcePlatform = "1688";
  createForm.shippingMethod = "";
  createForm.logisticsRuleId = "";
  createForm.urgency = "normal";
  createForm.neededBy = "";
  const defaultRule = defaultLogisticsRule();
  if (defaultRule) {
    createForm.logisticsRuleId = String(defaultRule.id);
    createForm.shippingMethod = defaultRule.channel || defaultRule.name || "";
  }
}

async function submitInventoryDialog() {
  if (!inventoryDialog.onlineProductId) {
    ElMessage.warning("当前订单缺少在线商品 ID");
    return;
  }
  if (inventoryDialog.mode === "bind" && !bindForm.productId) {
    ElMessage.warning("请先选择库存商品");
    return;
  }
  if (inventoryDialog.mode !== "bind") {
    if (!String(createForm.name || "").trim()) {
      ElMessage.warning("请先填写库存商品名称");
      return;
    }
    if (!createForm.personId) {
      ElMessage.warning("请先选择负责人");
      return;
    }
    if (!createForm.logisticsRuleId) {
      ElMessage.warning("请先选择物流规则");
      return;
    }
  }
  inventoryDialog.submitting = true;
  try {
    if (inventoryDialog.mode === "bind") {
      await apiClient.post("/api/online-products/bind", {
        online_product_id: inventoryDialog.onlineProductId,
        order_item_id: inventoryDialog.orderItemId,
        ozon_sku: inventoryDialog.sku,
        product_id: Number(bindForm.productId),
        person_id: bindForm.personId ? Number(bindForm.personId) : null
      });
      ElMessage.success("库存绑定已更新");
    } else {
      await apiClient.post("/api/online-products/create-product", {
        online_product_id: inventoryDialog.onlineProductId,
        order_item_id: inventoryDialog.orderItemId,
        ozon_sku: inventoryDialog.sku,
        person_id: createForm.personId ? Number(createForm.personId) : null,
        owner_person_id: createForm.personId ? Number(createForm.personId) : null,
        name: createForm.name || inventoryDialog.itemName,
        purchase_url: createForm.purchaseUrl || inventoryDialog.sourceUrl || "",
        package_weight_g: createForm.packageWeightG ? Number(createForm.packageWeightG) : null,
        length_cm: createForm.lengthCm ? Number(createForm.lengthCm) : null,
        width_cm: createForm.widthCm ? Number(createForm.widthCm) : null,
        height_cm: createForm.heightCm ? Number(createForm.heightCm) : null,
        supplier_note: createForm.supplierNote || "",
        note: createForm.note || createForm.supplierNote || "",
        purchase_total_amount: createForm.amount ? Number(createForm.amount) : 0,
        domestic_shipping_total: createForm.shippingAmount ? Number(createForm.shippingAmount) : 0,
        purchase_quantity: 1,
        procurement_quantity: createQuantity.value,
        supplier_id: createForm.supplierId || null,
        source_platform: createForm.sourcePlatform || "1688",
        shipping_method: createForm.shippingMethod || "cel_air_land",
        logistics_rule_id: createForm.logisticsRuleId ? Number(createForm.logisticsRuleId) : null,
        urgency: createForm.urgency || "normal",
        needed_by: createForm.neededBy || null
      });
      ElMessage.success("库存商品已创建");
    }
    resetInventoryDialog();
    await loadOrders();
  } catch (error) {
    ElMessage.error(error.message || (inventoryDialog.mode === "bind" ? "库存绑定失败" : "创建库存失败"));
  } finally {
    inventoryDialog.submitting = false;
  }
}

defineExpose({ loadOrders });

watch(() => route.query.orderId, async () => {
  orderRouteBootstrapDone.value = false;
  await bootstrapFromRoute();
});

onMounted(async () => {
  await loadStatusTabPreference();
  if (route.query.orderId) {
    await bootstrapFromRoute();
    return;
  }
  await loadOrders({ includeCounts: true });
  if (vm.filters.logisticsMethod && vm.filters.logisticsMethod !== "all") {
    void loadLogisticsOptions().catch(() => {});
  }
});
</script>

<template>
  <el-config-provider :locale="elementLocale">
    <section v-loading="loading" class="vue-orders-shell">
    <div v-if="hasAftersalesReturnContext()" class="orders-return-strip">
      <el-button @click="backToAftersales">返回售后补损</el-button>
    </div>

    <OrdersToolbar
      :filters="vm.filters"
      :shops="vm.shops"
      :logistics-method-options="vm.logisticsMethodOptions"
      :search-type-options="SEARCH_TYPE_OPTIONS"
      :sync-status="vm.syncStatus"
      :sync-running="vm.syncRunning"
      :more-actions="vm.moreActions"
      @update:filters="vm.filters = $event"
      @submit="submitFilters"
      @sync-incremental="syncRecentOrdersAction"
      @sync-full="syncAllOrdersAction"
      @cancel-sync="cancelSync"
      @more-action="handleToolbarMoreAction"
      @open-quality-rules="showQualityRules"
      @reset-dates="resetRecentDates"
      @load-logistics-options="loadLogisticsOptions"
    >
      <OrdersStatusTabs
        :status-tabs="vm.statusTabs"
        :active-status="vm.filters.status"
        :print-views="vm.printViews"
        :active-print-view="vm.filters.printView"
        :mark-options="vm.markOptions"
        :active-mark-filter="vm.filters.markFilter"
        :selected-count="selectedCount"
        @change-status="changeStatus"
        @change-print-view="changePrintView"
        @change-mark-filter="changeMarkFilter"
        @configure-status-tabs="openStatusPreferenceDialog"
      />
    </OrdersToolbar>

    <div class="orders-table-section">
      <OrdersTable
        :rows="tableRows"
        :mark-options="vm.markOptions"
        :selected-ids="selectedOrderIds"
        :all-selected="allRowsSelected"
        :some-selected="someRowsSelected"
        table-height="100%"
        @toggle-all="toggleAll"
        @toggle-row="toggleRow"
        @open-profit="openProfitDetail"
        @prepare-order="handlePrepareOrder"
        @print-order="handlePrintOrder"
        @save-mark="handleSaveMark"
        @open-bind-product-from-order="handleOpenBindProductFromOrder"
        @open-create-product-from-order="handleOpenCreateProductFromOrder"
        @open-order-procurement="handleOpenOrderProcurement"
      />

      <div class="orders-page-footer">
        <PageFooterPagination
          :page="vm.filters.page"
          :total-pages="totalPages"
          :page-size="vm.filters.pageSize"
          :total="vm.meta.total"
          @update:page="changePage"
          @update:pageSize="changePageSize"
        />
      </div>
    </div>

    <el-dialog
      v-model="statusPreferenceDialog.visible"
      title="订单标签顺序"
      width="640px"
      align-center
      class="erp-centered-dialog"
    >
      <div class="orders-status-preference-list">
        <div
          v-for="(item, index) in statusPreferenceRows"
          :key="item.value"
          class="orders-status-preference-item"
        >
          <span class="orders-status-preference-index">{{ index + 1 }}</span>
          <strong>{{ item.label }}</strong>
          <div class="orders-status-preference-actions">
            <el-button size="small" :disabled="index === 0" @click="pinStatusPreference(index, 'top')">置顶</el-button>
            <el-button size="small" :disabled="index === 0" @click="moveStatusPreference(index, -1)">上移</el-button>
            <el-button size="small" :disabled="index === statusPreferenceRows.length - 1" @click="moveStatusPreference(index, 1)">下移</el-button>
            <el-button size="small" :disabled="index === statusPreferenceRows.length - 1" @click="pinStatusPreference(index, 'bottom')">置底</el-button>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="resetStatusPreference">恢复默认</el-button>
          <el-button class="erp-btn erp-btn-secondary" @click="statusPreferenceDialog.visible = false">取消</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="statusPreferenceDialog.saving" @click="saveStatusPreference">保存</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-model="printDialog.visible"
      title="面单打印设置"
      width="560px"
      align-center
      class="erp-centered-dialog"
      destroy-on-close
    >
      <el-form label-position="top" class="orders-print-settings-form">
        <el-form-item label="打印用途 / 尺寸">
          <el-select v-model="printDialog.preset" class="w-full" @change="applyPrintPreset">
            <el-option v-for="item in printPresetOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <div class="orders-print-target-line">
          <span>打印机</span>
          <strong>{{ selectedPrintPreset.printer === "document" ? "Canon MG2500 series Printer" : "Gprinter GP-1324D" }}</strong>
        </div>
        <div class="orders-print-settings-grid">
          <el-form-item label="纸张尺寸">
            <el-input :model-value="selectedPrintPreset.paper" disabled />
          </el-form-item>
          <el-form-item label="份数 / 张数">
            <el-input-number v-model="printDialog.copies" :min="1" :max="999" :step="1" controls-position="right" />
          </el-form-item>
          <el-form-item label="方向">
            <el-select v-model="printDialog.orientation">
              <el-option v-for="item in orientationOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="颜色">
            <el-select v-model="printDialog.color">
              <el-option v-for="item in colorOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
        </div>
      </el-form>
      <template #footer>
        <div class="orders-print-dialog-footer">
          <span>{{ printDialog.orderIds.length }} 个面单 × {{ printDialog.copies }} 份</span>
          <div>
            <el-button @click="printDialog.visible = false">取消</el-button>
            <el-button :loading="printDialog.previewing" @click="previewPrintLabels">预览 PDF</el-button>
            <el-button type="primary" :loading="printDialog.submitting" @click="submitPrintDialog">确认打印</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-model="detailDialog.visible"
      :title="detailDialog.mode === 'profit' ? '订单利润详情' : '订单详情'"
      width="1180px"
      align-center
      class="orders-detail-dialog erp-centered-dialog"
      destroy-on-close
    >
      <div v-loading="detailDialog.loading" class="vue-orders-detail-dialog-body">
        <div class="vue-orders-detail-dialog-hero">
          <div class="vue-orders-detail-dialog-title">
            <h3>{{ detailOrder.posting_number || detailDialog.orderId || "-" }}</h3>
            <p>
              {{ detailOrder.shop_name || "-" }} / 下单: {{ formatDateTime(detailOrder.ordered_at) }} / {{ rowStateLabel(detailOrder) }}
            </p>
          </div>
          <div class="vue-orders-detail-dialog-actions">
            <el-button v-if="hasAftersalesReturnContext()" @click="backToAftersales">返回售后补损</el-button>
            <el-button
              v-if="detailDialog.mode === 'profit'"
              type="primary"
              :loading="detailDialog.recalculating"
              :disabled="detailDialog.loading || detailDialog.recalculating"
              @click="handleRecalculate(detailDialog.orderId)"
            >
              重算利润
            </el-button>
          </div>
        </div>

        <div v-if="detailDialog.mode === 'profit'" class="orders-profit-detail-shell">
          <div v-if="detailProfitItemCards.length" class="orders-profit-item-grid">
            <article
              v-for="card in detailProfitItemCards"
              :key="card.id"
              class="orders-profit-item-card"
            >
              <el-image
                v-if="card.imageUrl"
                :src="card.imageUrl"
                fit="contain"
                class="orders-profit-item-thumb"
                :preview-src-list="[card.imageUrl]"
                preview-teleported
              />
              <div v-else class="orders-profit-item-thumb orders-profit-item-thumb-empty">无图</div>
              <div class="orders-profit-item-copy">
                <strong>{{ card.index }}. {{ card.name }}</strong>
                <span>SKU: {{ card.sku }} / 货号: {{ card.offerId }}</span>
                <span>{{ card.statusText }}</span>
              </div>
              <div class="orders-profit-item-metrics">
                <div>
                  <span>销售额</span>
                  <strong>CNY {{ formatMoney(card.saleAmount) }}</strong>
                </div>
                <div>
                  <span>预估利润</span>
                  <strong :class="moneyValueClass(card.estimatedProfit)">CNY {{ formatMoney(card.estimatedProfit) }}</strong>
                </div>
                <div>
                  <span>实际利润</span>
                  <strong v-if="card.actualProfit !== null" :class="moneyValueClass(card.actualProfit)">CNY {{ formatMoney(card.actualProfit) }}</strong>
                  <strong v-else>--</strong>
                </div>
              </div>
            </article>
          </div>

          <div class="orders-profit-aggregate-head">
            <strong>整单汇总</strong>
            <span>下方金额为该订单全部商品行的合计，便于核对整单利润。</span>
          </div>

          <div class="orders-profit-summary-grid">
            <div
              v-for="card in detailProfit.cards"
              :key="card.label"
              class="orders-profit-summary-card"
              :class="[`is-${card.tone || 'default'}`]"
            >
              <span>{{ card.label }}</span>
              <strong v-if="card.value">{{ card.value }}</strong>
              <div v-else class="orders-profit-card-lines">
                <div v-for="line in card.lines" :key="line.label">
                  <span>{{ line.label }}</span>
                  <strong>{{ line.value }}</strong>
                </div>
              </div>
              <small>{{ card.sub }}</small>
            </div>
          </div>

          <div class="orders-profit-rule-row orders-profit-rule-row-compact">
            <div>
              <strong>预估利润</strong>
              <span>预估利润 = 销售额 - 采购/运费 - Ozon 费用 - 售后损失 - 其他费用</span>
            </div>
            <div>
              <strong>真实利润</strong>
              <span>真实利润优先使用 Ozon 已结算费用；Ozon 未出账前显示 --，避免误导判断。</span>
            </div>
          </div>

          <el-table
            :data="detailProfit.rows"
            stripe
            border
            class="orders-profit-detail-table"
            :cell-class-name="profitDetailCellClassName"
          >
            <el-table-column prop="label" label="项目" min-width="130" fixed="left">
              <template #default="{ row }">
                <strong :class="{ 'orders-profit-total-text': row.strong }">{{ row.label }}</strong>
              </template>
            </el-table-column>
            <el-table-column label="预估金额" width="140" align="right">
              <template #default="{ row }">
                <span v-if="row.estimatedText">{{ row.estimatedText }}</span>
                <strong v-else>CNY {{ formatMoney(row.estimated) }}</strong>
              </template>
            </el-table-column>
            <el-table-column label="真实金额" width="140" align="right">
              <template #default="{ row }">
                <span v-if="row.actualText">{{ row.actualText }}</span>
                <strong v-else-if="row.actual !== null && row.actual !== undefined">CNY {{ formatMoney(row.actual) }}</strong>
                <span v-else>--</span>
              </template>
            </el-table-column>
            <el-table-column label="差异" width="110" align="right">
              <template #default="{ row }">
                <strong v-if="row.diff !== null && row.diff !== undefined" :class="moneyValueClass(row.diff)">
                  {{ formatSignedMoney(row.diff) }}
                </strong>
                <span v-else>--</span>
              </template>
            </el-table-column>
            <el-table-column prop="note" label="说明" min-width="360" />
          </el-table>
        </div>

        <template v-else>
          <el-descriptions :column="2" border>
            <el-descriptions-item label="订单号">{{ detailOrder.posting_number || detailDialog.orderId || "-" }}</el-descriptions-item>
            <el-descriptions-item label="店铺">{{ detailOrder.shop_name || "-" }}</el-descriptions-item>
            <el-descriptions-item label="状态">{{ rowStateLabel(detailOrder) }}</el-descriptions-item>
            <el-descriptions-item label="下单时间">{{ formatDateTime(detailOrder.ordered_at) }}</el-descriptions-item>
            <el-descriptions-item label="跟踪号">{{ detailOrder.tracking_number || "-" }}</el-descriptions-item>
            <el-descriptions-item label="物流方式">{{ detailOrder.fulfillment_type_label || "FBS" }}</el-descriptions-item>
            <el-descriptions-item label="物流规则">{{ detailOrder.resolved_logistics_rule_name || "--" }}</el-descriptions-item>
          </el-descriptions>
        </template>

        <div v-if="detailDialog.mode !== 'profit'" class="vue-orders-drawer-block">
          <div class="vue-orders-drawer-section-head">
            <strong>商品明细</strong>
            <span>{{ detailItems.length }} 个商品行</span>
          </div>
          <el-table :data="detailItems" stripe border max-height="260" class="vue-orders-detail-table">
            <el-table-column label="图片" width="86" align="center">
              <template #default="{ row }">
                <el-image
                  v-if="detailItemImageUrl(row)"
                  :src="detailItemImageUrl(row)"
                  fit="contain"
                  class="vue-orders-detail-item-thumb"
                  :preview-src-list="[detailItemImageUrl(row)]"
                  preview-teleported
                />
                <div v-else class="vue-orders-detail-item-thumb vue-orders-detail-item-thumb-empty">无图</div>
              </template>
            </el-table-column>
            <el-table-column prop="ozon_sku" label="SKU" min-width="150" />
            <el-table-column prop="offer_id" label="货号" min-width="130" />
            <el-table-column prop="product_name" label="商品" min-width="260" />
            <el-table-column prop="quantity" label="数量" width="80" align="center" />
            <el-table-column label="销售额" width="120" align="right">
              <template #default="{ row }">CNY {{ formatMoney(row.sale_amount_cny || Number(row.sale_price || 0) * Number(row.quantity || 0)) }}</template>
            </el-table-column>
            <el-table-column v-if="detailDialog.mode === 'profit'" label="利润" width="120" align="right">
              <template #default="{ row }">CNY {{ formatMoney(row.actual_profit || row.net_profit_cny || row.estimated_profit || row.gross_profit_cny) }}</template>
            </el-table-column>
          </el-table>
        </div>
      </div>
    </el-dialog>

    <el-dialog v-model="qualityDialog.visible" title="质检规则" width="720px" destroy-on-close>
      <div v-loading="qualityDialog.loading">
        <el-form label-width="100px">
          <el-form-item label="前缀列表">
            <el-input
              v-model="qualityDialog.prefixesText"
              type="textarea"
              :rows="8"
              placeholder="每行一个前缀，也可以用空格或逗号分隔"
            />
          </el-form-item>
          <el-form-item label="规则说明">
            <el-input
              v-model="qualityDialog.note"
              type="textarea"
              :rows="4"
              placeholder="请输入质检规则说明"
            />
          </el-form-item>
        </el-form>
        <el-alert
          type="info"
          :closable="false"
          title="命中这些规则的订单会按质检单识别，用于过滤和人工处理提醒。"
        />
      </div>
      <template #footer>
        <el-button @click="closeQualityDialog">关闭</el-button>
        <el-button type="primary" :loading="qualityDialog.saving" @click="submitQualityRules">保存规则</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="inventoryDialog.visible"
      :title="inventoryDialog.mode === 'bind' ? '修改库存绑定' : '创建库存商品'"
      width="1080px"
      align-center
      class="erp-centered-dialog"
      destroy-on-close
      @closed="resetInventoryDialog"
    >
      <div v-loading="inventoryOptionsLoading" class="order-inventory-dialog" :class="{ 'is-create-mode': inventoryDialog.mode !== 'bind' }">
        <div class="order-inventory-dialog-left">
          <div class="selected-product-card">
            <div class="dialog-search-head">
              <strong>{{ inventoryDialog.mode === "bind" ? "当前订单 SKU" : "创建库存前确认" }}</strong>
              <span>{{ inventoryDialog.mode === "bind" ? "先确认订单上下文，再在右侧选择要绑定的库存商品。" : "会按当前在线商品资料创建库存商品，并自动把这个 SKU 绑定过去。" }}</span>
            </div>

            <div class="selected-product-main selected-product-main-order">
              <div class="selected-product-meta selected-product-meta-order">
                <strong>{{ inventoryDialog.itemName || "-" }}</strong>
                <div class="selected-product-image-row">
                  <el-image
                    v-if="inventoryDialog.imageUrl"
                    :src="inventoryDialog.imageUrl"
                    fit="contain"
                    class="selected-product-thumb selected-product-thumb-image"
                    :preview-src-list="[inventoryDialog.imageUrl]"
                    preview-teleported
                  />
                  <div v-else class="selected-product-thumb picker-thumb-fallback">SKU</div>
                </div>
                <div class="order-inventory-info-table">
                  <div class="order-inventory-info-row">
                    <span>订单号</span>
                    <strong>{{ inventoryDialog.orderId || "-" }}</strong>
                  </div>
                  <div class="order-inventory-info-row">
                    <span>SKU</span>
                    <strong>{{ inventoryDialog.sku || "-" }}</strong>
                  </div>
                  <div class="order-inventory-info-row">
                    <span>当前绑定</span>
                    <strong>{{ inventoryDialog.currentProductName || "未绑定库存商品" }}</strong>
                  </div>
                  <div class="order-inventory-info-row">
                    <span>新绑定目标</span>
                    <strong>{{ selectedInventoryProduct ? inventoryProductLabel(selectedInventoryProduct) : (inventoryDialog.mode === "bind" ? "请选择右侧库存商品" : "提交后自动创建") }}</strong>
                  </div>
                  <div class="order-inventory-info-row">
                    <span>在线商品 ID</span>
                    <strong>{{ inventoryDialog.onlineProductId || "-" }}</strong>
                  </div>
                  <div class="order-inventory-info-row" v-if="inventoryDialog.mode !== 'bind'">
                    <span>原链接</span>
                    <strong>
                      <a
                        v-if="inventoryDialog.sourceUrl"
                        :href="inventoryDialog.sourceUrl"
                        target="_blank"
                        rel="noreferrer"
                        class="inventory-source-link"
                      >
                        {{ inventoryDialog.sourceUrl }}
                      </a>
                      <span v-else>未提供</span>
                    </strong>
                  </div>
                  <div class="order-inventory-info-row">
                    <span>操作类型</span>
                    <strong>{{ inventoryDialog.mode === "bind" ? "修改库存绑定" : "创建库存并自动绑定" }}</strong>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="inventoryDialog.mode === 'bind'" class="order-inventory-dialog-right">
          <div class="inventory-picker-panel">
            <div class="dialog-search-head">
              <strong>选择库存商品</strong>
              <span>按商品名称、库存编码、SKU、负责人筛选。表格可滚动，表头固定。</span>
            </div>
            <el-input v-model="bindProductQuery" placeholder="搜索商品名称、库存编码、SKU 或负责人" clearable />
            <div class="order-inventory-result-meta">
              <span>库存商品 {{ inventoryProductTotal }}</span>
              <span>命中 {{ filteredInventoryProducts.length }}</span>
            </div>
            <el-table
              :data="pagedInventoryProducts"
              height="420"
              border
              stripe
              highlight-current-row
              class="inventory-picker-table"
              empty-text="没有匹配到库存商品"
              :row-class-name="({ row }) => Number(bindForm.productId) === Number(row.id) ? 'is-selected-inventory-row' : ''"
              @row-click="(row) => { bindForm.productId = String(row.id); }"
            >
              <el-table-column label="商品" min-width="360" fixed="left">
                <template #default="{ row }">
                  <div class="inventory-picker-product-cell">
                    <el-image
                      v-if="inventoryProductImage(row)"
                      :src="inventoryProductImage(row)"
                      fit="contain"
                      class="picker-thumb picker-thumb-product"
                      :preview-src-list="[inventoryProductImage(row)]"
                      preview-teleported
                    />
                    <div v-else class="picker-thumb picker-thumb-fallback picker-thumb-product">库存</div>
                    <div class="picker-item-meta">
                      <strong>{{ inventoryProductLabel(row) }}</strong>
                      <span>编码：{{ inventoryProductCode(row) }}</span>
                    </div>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="SKU" min-width="210">
                <template #default="{ row }">
                  <span class="inventory-picker-table-text">{{ inventoryProductSkuText(row) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="负责人" width="120">
                <template #default="{ row }">{{ inventoryProductOwner(row) }}</template>
              </el-table-column>
            </el-table>
            <PageFooterPagination
              compact
               page-size-label="每页"
              :total="filteredInventoryProducts.length"
              :page="inventoryListPage"
              :page-size="INVENTORY_LIST_PAGE_SIZE"
              :page-sizes="[10]"
              @update:page="inventoryListPage = $event"
            />
          </div>

        </div>

        <div v-else class="order-inventory-dialog-right">
          <div class="create-workbench">
            <div class="dialog-search-head create-workbench-head">
              <strong>创建库存工作台</strong>
              <span>先保留来源信息，再补全商品主数据、规格和成本信息，提交后会创建库存并自动绑定当前 SKU。</span>
            </div>

            <el-form label-position="top" class="order-inventory-form create-inventory-form">
              <div class="create-form-section">
                <div class="create-section-title">
                  <strong>基础信息</strong>
                  <span>决定库存主档和负责人归属。</span>
                </div>
                <div class="create-grid create-grid--base">
                  <el-form-item label="商品名称">
                    <el-input v-model="createForm.name" placeholder="请输入库存商品名称" />
                  </el-form-item>
                  <el-form-item label="负责人">
                    <el-select v-model="createForm.personId" clearable filterable placeholder="请选择负责人" style="width: 100%">
                      <el-option
                        v-for="person in inventoryOptions.people"
                        :key="person.id"
                        :label="person.name"
                        :value="String(person.id)"
                      />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="供应商">
                    <el-select v-model="createForm.supplierId" clearable filterable placeholder="可选，绑定采购供应商" style="width: 100%">
                      <el-option
                        v-for="supplier in inventoryOptions.suppliers"
                        :key="supplier.id"
                        :label="supplier.name"
                        :value="String(supplier.id)"
                      />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="来源平台">
                    <el-select v-model="createForm.sourcePlatform" style="width: 100%">
                      <el-option label="1688" value="1688" />
                      <el-option label="淘宝" value="taobao" />
                      <el-option label="拼多多" value="pdd" />
                      <el-option label="手工采购" value="manual" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="原链接" class="create-grid-span-2">
                    <el-input v-model="createForm.purchaseUrl" placeholder="来源链接或商品链接" />
                  </el-form-item>
                </div>
              </div>
              <div class="create-form-section">
                <div class="create-section-title">
                  <strong>成本与规格</strong>
                  <span>用于采购成本、物流规则和计费克重计算。</span>
                </div>
                <div class="create-grid create-grid--spec">
                  <el-form-item label="本次采购数量">
                    <el-input-number v-model="createForm.quantity" :min="1" :step="1" controls-position="right" style="width: 100%" />
                  </el-form-item>
                  <el-form-item label="货款金额">
                    <el-input-number v-model="createForm.amount" :min="0" :precision="2" :step="1" controls-position="right" style="width: 100%" />
                  </el-form-item>
                  <el-form-item label="国内运费">
                    <el-input-number v-model="createForm.shippingAmount" :min="0" :precision="2" :step="1" controls-position="right" style="width: 100%" />
                  </el-form-item>
                  <el-form-item label="实重(g)">
                    <el-input-number v-model="createForm.packageWeightG" :min="0" :precision="0" :step="1" controls-position="right" style="width: 100%" />
                  </el-form-item>
                  <el-form-item label="长(cm)">
                    <el-input-number v-model="createForm.lengthCm" :min="0" :precision="0" :step="1" controls-position="right" style="width: 100%" />
                  </el-form-item>
                  <el-form-item label="宽(cm)">
                    <el-input-number v-model="createForm.widthCm" :min="0" :precision="0" :step="1" controls-position="right" style="width: 100%" />
                  </el-form-item>
                  <el-form-item label="高(cm)">
                    <el-input-number v-model="createForm.heightCm" :min="0" :precision="0" :step="1" controls-position="right" style="width: 100%" />
                  </el-form-item>
                  <el-form-item label="物流方式" class="create-grid-span-2">
                    <el-select v-model="createForm.logisticsRuleId" filterable placeholder="请选择物流规则" style="width: 100%">
                      <el-option
                        v-for="rule in sortedInventoryLogisticsRules"
                        :key="rule.id"
                        :label="formatLogisticsRuleLabel(rule)"
                        :value="String(rule.id)"
                      />
                    </el-select>
                  </el-form-item>
                </div>
                <div class="create-summary-strip">
                  <div class="create-summary-item">
                    <span>单件货款</span>
                    <strong>{{ formatMoney(createUnitPurchaseCost) }}</strong>
                  </div>
                  <div class="create-summary-item">
                    <span>单件国内运费</span>
                    <strong>{{ formatMoney(createUnitShippingCost) }}</strong>
                  </div>
                  <div class="create-summary-item">
                    <span>计费克重</span>
                    <strong>{{ createChargeableWeightG }}g</strong>
                  </div>
                  <div class="create-summary-item">
                    <span>物流方式</span>
                    <strong>{{ createShippingMethodLabel }}</strong>
                  </div>
                </div>
              </div>

              <div class="create-form-section">
                <div class="create-section-title">
                  <strong>补充说明</strong>
                  <span>用于记录来源备注、供应提示和交接信息，不会自动生成采购请求。</span>
                </div>
                <div class="create-grid create-grid--proc">
                  <el-form-item label="紧急程度">
                    <el-segmented v-model="createForm.urgency" :options="[{ label: '普通', value: 'normal' }, { label: '加急', value: 'urgent' }]" />
                  </el-form-item>
                  <el-form-item label="需求日期">
                    <el-input v-model="createForm.neededBy" placeholder="例如 2026-05-20" />
                  </el-form-item>
                  <el-form-item label="库存备注" class="create-grid-span-2">
                    <el-input v-model="createForm.note" type="textarea" :rows="3" placeholder="记录当前订单的补货说明、时效要求或交接备注" />
                  </el-form-item>
                  <el-form-item label="供应备注" class="create-grid-span-2">
                    <el-input v-model="createForm.supplierNote" type="textarea" :rows="3" placeholder="补充来源说明、采购提醒或人工备注" />
                  </el-form-item>
                </div>
              </div>
            </el-form>
          </div>
        </div>

        <div v-if="inventoryDialog.mode === 'bind'" class="order-inventory-footer-bar">
          <el-form label-width="76px" class="order-inventory-footer-form">
            <el-form-item label="负责人">
              <el-select v-model="bindForm.personId" clearable filterable placeholder="可选，覆盖绑定负责人" style="width: 100%">
                <el-option
                  v-for="person in inventoryOptions.people"
                  :key="person.id"
                  :label="person.name"
                  :value="String(person.id)"
                />
              </el-select>
            </el-form-item>
          </el-form>
          <div class="order-inventory-bind-target">
            <span>将绑定到</span>
            <strong>{{ selectedInventoryProduct ? inventoryProductLabel(selectedInventoryProduct) : "请选择库存商品" }}</strong>
          </div>
        </div>
        <div v-else class="order-inventory-footer-bar create-footer-bar">
          <div class="create-footer-summary">
            <span>将创建</span>
            <strong>{{ createForm.name || inventoryDialog.itemName || "新库存商品" }}</strong>
          </div>
          <div class="create-footer-summary">
            <span>绑定 SKU</span>
            <strong>{{ inventoryDialog.sku || "-" }}</strong>
          </div>
          <div class="create-footer-summary">
            <span>供应商</span>
            <strong>{{ supplierName(createForm.supplierId) || "未指定" }}</strong>
          </div>
        </div>
      </div>

      <template #footer>
        <el-button @click="resetInventoryDialog">取消</el-button>
        <el-button type="primary" :loading="inventoryDialog.submitting" @click="submitInventoryDialog">
          {{ inventoryDialog.mode === "bind" ? "确认绑定" : "创建库存" }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="orderProcurementDialog.visible"
      title="采购处理确认"
      width="1120px"
      align-center
      class="erp-centered-dialog"
      destroy-on-close
    >
      <div v-loading="orderProcurementDialog.loading" class="order-procurement-preview">
        <el-alert
          v-if="orderProcurementDialog.preview?.missing_count"
          type="warning"
          :closable="false"
          show-icon
          title="当前订单里有 SKU 还没有绑定库存，无法一起处理。"
        />

        <div v-if="orderProcurementProducts.length" class="order-procurement-summary">
          <div class="create-summary-item">
            <span>已选择明细</span>
            <strong>{{ orderProcurementSelectedCount }}</strong>
          </div>
          <div class="create-summary-item">
            <span>已选择数量</span>
            <strong>{{ orderProcurementSelectedQuantity }}</strong>
          </div>
          <div class="create-summary-item">
            <span>库存商品</span>
            <strong>{{ orderProcurementDialog.preview.product_count }}</strong>
          </div>
        </div>

        <div v-if="orderProcurementProducts.length" class="order-procurement-products">
          <section
            v-for="product in orderProcurementProducts"
            :key="product.product_id"
            class="order-procurement-product"
          >
            <div class="order-procurement-product-main">
              <div class="order-procurement-image">
                <el-image
                  v-if="product.items?.[0]?.image_url"
                  :src="product.items[0].image_url"
                  fit="contain"
                />
                <span v-else>无图</span>
              </div>
              <div class="order-procurement-product-copy">
                <strong>{{ product.product_name || "-" }}</strong>
                <span>库存编码：{{ product.product_code || "-" }}</span>
                <span>SKU：{{ (product.skus || []).join(", ") || "-" }}</span>
              </div>
            </div>
            <div class="order-procurement-stock-grid">
              <div>
                <span>可用库存</span>
                <strong>{{ product.current_stock }}</strong>
              </div>
              <div>
                <span>账面库存</span>
                <strong>{{ product.ledger_stock ?? product.current_stock }}</strong>
              </div>
              <div :class="{ 'is-shortage': Number(product.stock_debt || 0) > 0 }">
                <span>历史欠账</span>
                <strong>{{ product.stock_debt || 0 }}</strong>
                <el-button
                  v-if="Number(product.stock_debt || 0) > 0"
                  class="order-procurement-stock-action"
                  size="small"
                  type="warning"
                  plain
                  :loading="stockDebtAdjustingProductId === Number(product.product_id)"
                  @click="handleAdjustStockDebt(product)"
                >
                  冲正旧账
                </el-button>
              </div>
              <div>
                <span>采购在途</span>
                <strong>{{ product.incoming_stock }}</strong>
              </div>
              <div>
                <span>本次需求</span>
                <strong>{{ product.total_quantity }}</strong>
              </div>
              <div :class="{ 'is-shortage': Number(product.shortage_quantity || 0) > 0 }">
                <span>缺口</span>
                <strong>{{ product.shortage_quantity }}</strong>
              </div>
            </div>
            <div class="order-procurement-purchase-form">
              <el-form-item label="采购数量">
                <el-input-number
                  v-model="product.purchase_quantity"
                  :min="0"
                  :precision="0"
                  :step="1"
                  controls-position="right"
                  @change="handleProcurementQuantityChange(product)"
                />
              </el-form-item>
              <el-form-item label="货款">
                <el-input-number
                  v-model="product.purchase_amount"
                  :min="0"
                  :precision="2"
                  :step="1"
                  controls-position="right"
                />
              </el-form-item>
              <el-form-item label="运费">
                <el-input-number
                  v-model="product.purchase_shipping"
                  :min="0"
                  :precision="2"
                  :step="1"
                  controls-position="right"
                />
              </el-form-item>
            </div>
          </section>

          <el-table
            :data="orderProcurementItems"
            border
            stripe
            max-height="360"
            class="order-procurement-orders-table"
          >
            <el-table-column label="一起处理" width="96" align="center">
              <template #default="{ row }">
                <el-checkbox
                  :model-value="procurementItemSelected(row)"
                  @change="setProcurementItemSelected(row, $event)"
                />
              </template>
            </el-table-column>
            <el-table-column label="订单商品" min-width="320">
              <template #default="{ row }">
                <div class="order-procurement-order-cell">
                  <div class="order-procurement-order-thumb">
                    <el-image v-if="row.image_url" :src="row.image_url" fit="contain" />
                    <span v-else>无图</span>
                  </div>
                  <div>
                    <strong>{{ row.ozon_name || row.product?.product_name || "-" }}</strong>
                    <span>SKU：{{ row.ozon_sku || "-" }}</span>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="订单号" min-width="180">
              <template #default="{ row }">{{ row.posting_number || "-" }}</template>
            </el-table-column>
            <el-table-column prop="quantity" label="数量" width="80" align="center" />
            <el-table-column label="订单金额" width="110" align="right">
              <template #default="{ row }">¥{{ formatMoney(row.sale_amount) }}</template>
            </el-table-column>
            <el-table-column label="处理建议" width="150">
              <template #default="{ row }">
                <el-tag :type="Number(row.product?.current_stock || 0) >= Number(row.product?.total_quantity || 0) ? 'success' : 'warning'" effect="light">
                  {{ Number(row.product?.current_stock || 0) >= Number(row.product?.total_quantity || 0) ? "库存可满足" : "生成采购建议" }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </div>

        <el-empty
          v-else-if="!orderProcurementDialog.loading"
          description="当前没有新的待采购明细"
        />

        <div v-if="orderProcurementDialog.preview?.missing_items?.length" class="order-procurement-missing">
          <strong>未绑定库存</strong>
          <span>
            {{ orderProcurementDialog.preview.missing_items[0].ozon_name || orderProcurementDialog.preview.missing_items[0].ozon_sku }}
            <template v-if="orderProcurementDialog.preview.missing_items.length > 1">
              等 {{ orderProcurementDialog.preview.missing_items.length }} 个 SKU
            </template>
          </span>
        </div>
      </div>

      <template #footer>
        <el-button @click="orderProcurementDialog.visible = false">取消</el-button>
        <el-button
          v-if="orderProcurementDialog.preview?.missing_items?.length"
          @click="bindFirstProcurementMissingItem"
        >
          绑定库存
        </el-button>
        <el-button
          v-if="orderProcurementDialog.preview?.missing_items?.length"
          @click="createInventoryForFirstProcurementMissingItem"
        >
          创建库存
        </el-button>
        <el-button
          type="primary"
          :disabled="!orderProcurementSelectedCount"
          :loading="orderProcurementDialog.submitting"
          @click="submitOrderProcurement"
        >
          生成采购建议
        </el-button>
      </template>
    </el-dialog>
    </section>
  </el-config-provider>
</template>
