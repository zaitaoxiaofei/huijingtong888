<script setup>
import { computed, defineAsyncComponent, defineExpose, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import OrdersStatusTabs from "./components/OrdersStatusTabs.vue";
import OrdersTable from "./components/OrdersTable.vue";
import OrdersToolbar from "./components/OrdersToolbar.vue";
import PageFooterPagination from "../admin/components/PageFooterPagination.vue";
import { apiClient } from "../admin/utils/api.js";
import { shanghaiDateTimeText } from "../admin/utils/shanghai-date.js";
import { useOrdersPage } from "./composables/useOrdersPage.js";
import "./orders-view.css";

const ProcurementRequestCreateDialog = defineAsyncComponent(() => import("../admin/components/procurement/ProcurementRequestCreateDialog.vue"));
const route = useRoute();
const router = useRouter();

const SEARCH_TYPE_OPTIONS = [
  { value: "order", label: "订单号" },
  { value: "sku", label: "SKU" },
  { value: "offer", label: "货号" },
  { value: "tracking", label: "跟踪号" },
  { value: "purchaseTracking", label: "采购快递单号" },
  { value: "product", label: "库存产品" }
];

const ORDER_DETAIL_CACHE_TTL_MS = 60 * 1000;
const orderDetailCache = new Map();

const STATE_META = {
  all: { label: "全部订单", color: "slate" },
  awaiting_packaging: { label: "等待备货", color: "amber" },
  awaiting_deliver: { label: "等待发货", color: "blue" },
  delivering: { label: "运输中", color: "green" },
  dispute: { label: "有争议", color: "red" },
  delivered: { label: "已签收", color: "green" },
  cancelled: { label: "已取消", color: "slate" },
  unbound: { label: "待绑定库存", color: "amber" },
  stock_issue: { label: "库存异常", color: "red" }
};

const {
  vm,
  loading,
  totalPages,
  selectedOrderIds,
  loadOrders,
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
  printSingleOrder,
  recalculateOrderProfit,
  saveOrderMark,
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

const procurementDialog = reactive({
  visible: false,
  productId: null
});

const inventoryDialog = reactive({
  visible: false,
  mode: "bind",
  submitting: false,
  orderId: null,
  sku: "",
  onlineProductId: null,
  currentProductId: null,
  currentProductName: "",
  itemName: "",
  imageUrl: "",
  sourceUrl: "",
  baseName: "",
  baseWeightG: "",
  purchaseUrl: "",
  createProcurementRequest: true
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
  neededBy: "",
  createProcurementRequest: true
});



const bindProductQuery = ref("");
const inventoryListPage = ref(1);
const inventoryProductSearchTimer = ref(null);
const INVENTORY_LIST_PAGE_SIZE = 10;
const orderRouteBootstrapDone = ref(false);

const detailOrder = computed(() => detailDialog.data?.order || {});
const detailItems = computed(() => detailDialog.data?.items || []);
const detailFinance = computed(() => detailDialog.data?.finance || []);
const detailProfitSnapshot = computed(() => detailDialog.data?.profit_detail_snapshot || null);
const detailPrimaryItem = computed(() => detailItems.value[0] || {});
const detailPrimaryImageUrl = computed(() => detailItemImageUrl(detailPrimaryItem.value));
const detailProfit = computed(() => buildOrderProfitDetail(detailOrder.value, detailItems.value, detailFinance.value, detailProfitSnapshot.value));
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

function formatDateTime(value) {
  return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true });
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

function formatSignedMoney(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return "0.00";
  if (Math.abs(amount) < 0.005) return "0.00";
  return `${amount > 0 ? "+" : ""}${amount.toFixed(2)}`;
}

function formatPercent(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? `${amount.toFixed(2)}%` : "0.00%";
}

function moneyValueClass(value) {
  const amount = Number(value || 0);
  if (amount < -0.005) return "is-negative";
  if (amount > 0.005) return "is-positive";
  return "";
}

function numberOrNull(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function positiveAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function roundMoneyValue(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) / 100 : 0;
}

function parseMappedPairs(value, separator = "||") {
  return String(value || "")
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [key, ...rest] = item.split(":");
      return { key: String(key || "").trim(), value: rest.join(":").trim() };
    })
    .filter((item) => item.key);
}

function splitCsv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

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

function formatLogisticsRuleLabel(rule) {
  if (!rule) return "-";
  return `${rule.name} (${Number(rule.min_weight_g || 0)}-${Number(rule.max_weight_g || 0)}g)`;
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
  const localActions = {
    print: beforeTransit && !isFbp && (printed || isAwaitingDeliver),
    prepare: displayStateKey !== "awaiting_deliver" && beforeTransit && isAwaitingPackaging,
    profit: true
  };
  const apiActions = row?.availableActions && typeof row.availableActions === "object" ? row.availableActions : {};
  return {
    ...apiActions,
    print: beforeTransit && !isFbp && (Boolean(apiActions.print) || localActions.print),
    prepare: beforeTransit && !isAwaitingDeliver && (Boolean(apiActions.prepare) || localActions.prepare),
    profit: apiActions.profit !== false
  };
}

function firstCsvValue(value) {
  return String(value || "").split(",").map((item) => item.trim()).find(Boolean) || "";
}

function trackingLinkFor(value) {
  const track = String(value || "").trim();
  return track
    ? `https://tracking.ozon.ru/?${new URLSearchParams({ track, local: "zh-Hans" }).toString()}`
    : "";
}

function ozonBuyerProductLinkFor(value) {
  const productId = String(value || "").trim();
  return productId ? `https://www.ozon.ru/product/${encodeURIComponent(productId)}/` : "";
}

function fallbackOzonProductId(value) {
  const text = String(value || "").trim();
  return /^\d{6,}$/.test(text) ? text : "";
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

function parseSkuMap(row, fieldName, transform = (value) => value) {
  const map = new Map();
  const separator = [
    "sku_ozon_product_ids",
    "sku_product_ids",
    "sku_online_product_ids",
    "sku_mapping_ids",
    "sku_stock_summaries"
  ].includes(fieldName) ? "," : "||";
  for (const item of parseMappedPairs(row?.[fieldName], separator)) {
    if (!map.has(item.key)) map.set(item.key, transform(item.value));
  }
  return map;
}

function shippingMethodLabel(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "--";
  if (text === "cel_air_land") return "CEL 陆空";
  if (text === "cel_land") return "CEL 陆运";
  if (text === "cel_large_land") return "CEL 大件陆运";
  if (text === "postal_packet") return "邮政小包";
  if (text === "hunchun_2") return "珲春 2";
  if (text === "manual_review") return "人工核验";
  if (text.includes("fbp")) return "平台仓发货";
  if (text.includes("fbs")) return "自发货";
  if (text.includes("air")) return "空运";
  if (text.includes("sea")) return "海运";
  return String(value || "").trim();
}

function financeCategory(row = {}) {
  const raw = String(row.service_name || row.operation_type_name || row.service_type || row.operation_type || "").trim();
  const normalized = raw.toLowerCase();
  if (normalized.includes("sale_commission") || raw === "Ozon 销售佣金") return "commission";
  if (normalized.includes("marketplaceredistributionofacquiringoperation")) return "collecting_fee";
  if (normalized.includes("return_delivery_charge") || normalized.includes("returnflowlogistic") || normalized.includes("returnnotdelivtocustomer")) return "aftersale_loss";
  if (normalized.includes("delivery_charge")) return "platform_delivery";
  if (raw === "袩械褉械胁褘褋褌邪胁谢械薪懈械 褍褋谢褍谐 写芯褋褌邪胁泻懈" || raw.includes("写芯褋褌邪胁")) return "platform_delivery";
  if (raw.includes("屑械卸写褍薪邪褉芯写") || raw.includes("褌褉邪薪褋锌芯褉褌薪芯-褝泻褋锌械写懈褑懈芯薪薪褘褏")) return "international_transport";
  if (raw.includes("效邪褋褌懈褔薪邪褟 泻芯屑锌械薪褋邪褑懈褟 锌芯泻褍锌邪褌械谢褞") || raw.includes("胁芯蟹胁褉邪褌") || raw.includes("薪械写芯胁谢芯卸")) return "aftersale_loss";
  return "other";
}

function sumRows(rows = [], getter = () => 0) {
  return roundMoneyValue(rows.reduce((sum, row) => sum + Number(getter(row) || 0), 0));
}

function itemSaleAmount(item) {
  return positiveAmount(item.sale_amount_cny) || Number(item.sale_price || 0) * Number(item.quantity || 1);
}

function itemQuantity(item) {
  return Math.max(Number(item.quantity || 1), 1);
}

function itemEstimatedPurchaseCost(item) {
  return positiveAmount(item.frozen_purchase_cost) * itemQuantity(item) || positiveAmount(item.purchase_cost_cny);
}

function itemEstimatedDomesticShipping(item) {
  return positiveAmount(item.frozen_domestic_shipping) * itemQuantity(item) || positiveAmount(item.domestic_shipping_cny);
}

function itemEstimatedInternationalShipping(item) {
  return positiveAmount(item.frozen_international_shipping) * itemQuantity(item) || positiveAmount(item.international_shipping_cny);
}

function itemActualPurchaseCost(item) {
  return positiveAmount(item.purchase_cost_cny) || itemEstimatedPurchaseCost(item);
}

function itemActualDomesticShipping(item) {
  return positiveAmount(item.domestic_shipping_cny) || itemEstimatedDomesticShipping(item);
}

function itemHasFinanceActualProfit(item = {}) {
  const statusText = [item.settlement_state, item.profit_status].map((value) => String(value || "").toLowerCase()).join(" ");
  const lockReason = String(item.lock_reason || "").toLowerCase();
  return statusText.includes("accrued") && lockReason.includes("finance");
}

function hasFinanceSaleAccrual(finance = []) {
  return (finance || []).some((row) => Math.abs(Number(row.accruals_for_sale_cny || row.accruals_for_sale || 0)) > 0.005);
}

function isFinalProfitOutcome(order = {}) {
  const text = [
    order.outcome_type,
    order.status,
    order.tracking_stage,
    order.logistics_status,
    order.accrued_at
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  return text.includes("delivered")
    || text.includes("signed")
    || text.includes("cancel")
    || text.includes("return")
    || text.includes("reject")
    || text.includes("accrued");
}

function financeCategoryTotal(finance = [], categories = []) {
  const keys = new Set(Array.isArray(categories) ? categories : [categories]);
  let matched = false;
  const total = (finance || []).reduce((sum, row) => {
    if (!keys.has(financeCategory(row))) return sum;
    matched = true;
    const feeAmount = numberOrNull(row.fee_amount_cny);
    const rawAmount = Number(row.amount_cny || 0);
    const amount = feeAmount !== null ? feeAmount : rawAmount < 0 ? Math.abs(rawAmount) : 0;
    return sum + amount;
  }, 0);
  return matched ? roundMoneyValue(total) : null;
}

function valueDiff(actual, estimated) {
  if (actual === null || actual === undefined) return null;
  return roundMoneyValue(Number(actual || 0) - Number(estimated || 0));
}

function snapshotDetailNote(key) {
  return {
    sale: "订单全部商品销售收入。",
    purchase: "本地库存商品采购成本。",
    domestic: "本地采购到仓或集货的国内运费。",
    international: "真实金额来自 Ozon 财务里的平台配送或国际运输费用；未出现前显示 --。",
    packaging: "本地包装处理费规则或已保存利润项。",
    commission: "真实金额来自 Ozon 销售佣金账单；FBP 减免以账单为准。",
    collecting: "真实值来自 Ozon 收单手续费账单。",
    service: "真实值来自非佣金、非物流、非售后类 Ozon 财务费用。",
    aftersale: "真实值来自退货、拒收、补偿等售后财务费用。",
    other: "广告费、手工调整或额外费用。",
    costTotal: "真实成本未结算完整时不汇总，避免误导。",
    profit: "订单未结算完整前不计算真实利润。"
  }[key] || "";
}

function buildDetailMetricCards(summary) {
  return [
    {
      label: "订单金额",
      value: formatMoney(summary.saleAmount),
      sub: "订单全部商品销售收入",
      tone: "strong"
    },
    {
      label: "利润",
      lines: [
        {
          label: "实际利润",
          value: summary.actualProfitReady ? formatMoney(summary.actualProfit) : "--"
        },
        {
          label: "预估利润",
          value: formatMoney(summary.estimatedProfit)
        }
      ],
      sub: summary.actualProfitReady ? `差异 ${formatSignedMoney(summary.profitDiff)}` : "真实利润待 Ozon 财务结算后计算",
      tone: summary.actualProfit < 0 ? "danger" : "default"
    },
    {
      label: "实际利润率",
      value: summary.actualProfitReady ? formatPercent(summary.actualMargin) : "--",
      sub: "实际利润 / 销售额",
      tone: summary.actualMargin < 0 ? "danger" : "strong"
    },
    {
      label: "财务匹配状态",
      value: summary.actualProfitReady ? "已结算" : summary.financeRows ? "已匹配" : "未匹配",
      sub: summary.financeRows
        ? `已识别 ${summary.financeRows} 类 Ozon 真实费用${summary.actualProfitReady ? "" : "，利润待结算"}`
        : "未匹配到 Ozon 真实费用",
      tone: summary.actualProfitReady || summary.financeRows ? "success" : "warning"
    }
  ];
}

function buildOrderProfitDetail(order = {}, items = [], finance = [], snapshot = null) {
  if (snapshot?.summary && Array.isArray(snapshot?.rows)) {
    const summary = {
      saleAmount: Number(snapshot.summary.saleAmount || snapshot.sale_amount_cny || 0),
      estimatedProfit: Number(snapshot.summary.estimatedProfit || snapshot.estimated_profit_cny || 0),
      actualProfit: snapshot.summary.actualProfit ?? snapshot.actual_profit_cny,
      profitDiff: snapshot.summary.actualProfit !== null && snapshot.summary.actualProfit !== undefined
        ? roundMoneyValue(Number(snapshot.summary.actualProfit || 0) - Number(snapshot.summary.estimatedProfit || 0))
        : null,
      actualMargin: snapshot.summary.actualProfitRate ?? snapshot.actual_profit_rate,
      hasActual: Number(snapshot.finance_rows || snapshot.summary.financeRows || 0) > 0,
      actualProfitReady: Boolean(snapshot.summary.actualProfitReady || snapshot.actual_profit_ready),
      financeRows: Number(snapshot.finance_rows || snapshot.summary.financeRows || 0),
      estimatedCostTotal: Number(snapshot.summary.estimatedCostTotal || snapshot.estimated_cost_total_cny || 0),
      actualCostTotal: snapshot.summary.actualCostTotal ?? snapshot.actual_cost_total_cny
    };
    return {
      summary,
      cards: buildDetailMetricCards(summary),
      rows: snapshot.rows.map((row) => ({
        ...row,
        note: row.note || snapshotDetailNote(row.key),
        strong: Boolean(row.strong)
      })),
      fromSnapshot: true
    };
  }
  const rows = Array.isArray(items) ? items : [];
  const financeRows = Array.isArray(finance) ? finance : [];
  const hasFinalFinanceBasis = financeRows.length > 0 && (hasFinanceSaleAccrual(financeRows) || isFinalProfitOutcome(order));
  const actualProfitReady = hasFinalFinanceBasis && rows.length > 0 && rows.every((item) => itemHasFinanceActualProfit(item));
  const saleAmount = sumRows(rows, itemSaleAmount);
  const estimated = {
    sale: saleAmount,
    purchase: sumRows(rows, itemEstimatedPurchaseCost),
    domestic: sumRows(rows, itemEstimatedDomesticShipping),
    international: sumRows(rows, itemEstimatedInternationalShipping),
    packaging: sumRows(rows, (item) => positiveAmount(item.packaging_cost_cny)),
    commission: sumRows(rows, (item) => positiveAmount(item.estimated_commission) || positiveAmount(item.commission_fee_cny)),
    collecting: 0,
    service: sumRows(rows, (item) => positiveAmount(item.ozon_service_fee_cny)),
    aftersale: sumRows(rows, (item) => positiveAmount(item.aftersale_loss) || positiveAmount(item.return_loss_cny)),
    other: sumRows(rows, (item) => positiveAmount(item.advertising_cost_cny) + positiveAmount(item.other_fee_cny)),
    profit: sumRows(rows, (item) => numberOrNull(item.estimated_profit) ?? numberOrNull(item.net_profit_cny) ?? 0)
  };
  const financeInternational = financeCategoryTotal(financeRows, ["platform_delivery", "international_transport"]);
  const financeCommission = financeCategoryTotal(financeRows, "commission");
  const financeCollecting = financeCategoryTotal(financeRows, "collecting_fee");
  const financeService = financeCategoryTotal(financeRows, "other");
  const financeAftersale = financeCategoryTotal(financeRows, "aftersale_loss");
  const actual = {
    sale: saleAmount,
    purchase: sumRows(rows, itemActualPurchaseCost),
    domestic: sumRows(rows, itemActualDomesticShipping),
    international: financeInternational ?? (actualProfitReady ? 0 : null),
    packaging: sumRows(rows, (item) => positiveAmount(item.packaging_cost_cny)),
    commission: financeCommission ?? (actualProfitReady ? 0 : null),
    collecting: financeCollecting ?? (actualProfitReady ? 0 : null),
    service: financeService ?? (actualProfitReady ? 0 : null),
    aftersale: financeAftersale ?? (actualProfitReady ? 0 : null),
    other: actualProfitReady ? sumRows(rows, (item) => positiveAmount(item.advertising_cost_cny) + positiveAmount(item.other_fee_cny)) : null,
    profit: null
  };
  const estimatedCostTotal = roundMoneyValue(estimated.purchase + estimated.domestic + estimated.international + estimated.packaging + estimated.commission + estimated.collecting + estimated.service + estimated.aftersale + estimated.other);
  const actualCostTotal = actualProfitReady
    ? roundMoneyValue(actual.purchase + actual.domestic + (actual.international || 0) + actual.packaging + (actual.commission || 0) + (actual.collecting || 0) + (actual.service || 0) + (actual.aftersale || 0) + (actual.other || 0))
    : null;
  const estimatedProfit = estimated.profit || roundMoneyValue(saleAmount - estimatedCostTotal);
  const actualProfit = actualProfitReady ? roundMoneyValue(saleAmount - actualCostTotal) : null;
  const actualMargin = actualProfitReady && saleAmount ? actualProfit / saleAmount * 100 : null;

  const moneyRow = (key, label, note) => ({
    key,
    label,
    estimated: roundMoneyValue(estimated[key] || 0),
    actual: actual[key],
    diff: valueDiff(actual[key], estimated[key] || 0),
    note
  });

  const detailRows = [
    {
      key: "shipping",
      label: "运输方式",
      estimatedText: shippingMethodLabel(rows[0]?.shipping_method || order.delivery_method || order.shipping_method),
      actualText: financeRows.length || actualProfitReady ? shippingMethodLabel(order.delivery_method || order.shipping_method || rows[0]?.shipping_method) : "--",
      diffText: "",
      note: "预计按库存商品物流模型；真实列仅展示已匹配到订单维度的财务口径。"
    },
    moneyRow("sale", "订单金额", "订单全部商品销售收入。"),
    moneyRow("purchase", "采购成本", "本地库存商品的采购成本，通常不会随 Ozon 结算变化。"),
    moneyRow("domestic", "国内运费", "本地采购到仓或集货的国内运费。"),
    moneyRow("international", "国际运费", "真实金额优先取 Ozon 财务里的平台配送或国际运输费用；未出现前不拿预估值冒充。"),
    moneyRow("packaging", "包装处理费", "本地包装处理费规则或已保存利润项。"),
    moneyRow("commission", "Ozon佣金", "真实金额来自 Ozon 销售佣金账单；FBP 减免以账单或结算后的 0 值为准。"),
    moneyRow("collecting", "收单费", "真实值来自 Ozon 收单手续费账单。"),
    moneyRow("service", "Ozon服务费", "真实值来自非佣金、非物流、非售后类 Ozon 财务费用。"),
    moneyRow("aftersale", "售后损失", "真实值来自退货、拒收、补偿等售后财务费用。"),
    moneyRow("other", "其他费用", "广告费、手工调整或额外费用。"),
    {
      key: "costTotal",
      label: "总成本",
      estimated: estimatedCostTotal,
      actual: actualCostTotal,
      diff: valueDiff(actualCostTotal, estimatedCostTotal),
      note: actualProfitReady ? "实际成本合计已按结算后的真实值汇总。" : "真实成本未结算完整时不汇总，避免误导。",
      strong: true
    },
    {
      key: "profit",
      label: "利润",
      estimated: estimatedProfit,
      actual: actualProfit,
      diff: valueDiff(actualProfit, estimatedProfit),
      note: actualProfitReady ? `实际利润率 ${formatPercent(actualMargin)}` : "订单未结算完整前不计算真实利润。",
      strong: true
    }
  ];

  const summary = {
    saleAmount,
    estimatedProfit,
    actualProfit,
    profitDiff: actualProfitReady ? roundMoneyValue(actualProfit - estimatedProfit) : null,
    actualMargin,
    hasActual: financeRows.length > 0 || actualProfitReady,
    actualProfitReady,
    financeRows: financeRows.length,
    estimatedCostTotal,
    actualCostTotal
  };

  return {
    summary,
    cards: buildDetailMetricCards(summary),
    rows: detailRows
  };
}

function profitDetailCellClassName({ columnIndex }) {
  if (columnIndex === 2) return "orders-profit-actual-column";
  return "";
}

function buildProductDisplayRows(row) {
  const skuImages = parseSkuMap(row, "sku_images");
  const skuNames = parseSkuMap(row, "sku_names");
  const skuQuantities = parseSkuMap(row, "sku_quantities", (value) => Number(value || 0));
  const ozonProductIds = parseSkuMap(row, "sku_ozon_product_ids");
  const productIds = parseSkuMap(row, "sku_product_ids", (value) => Number(value || 0));
  const onlineIds = parseSkuMap(row, "sku_online_product_ids", (value) => Number(value || 0));
  const inventoryImages = splitCsv(row.inventory_image_urls);
  const stockMap = parseSkuMap(row, "sku_stock_summaries", (value) => {
    const parts = String(value || "").split(":");
    return { fbs: Number(parts[0] || 0), fbp: Number(parts[1] || 0) };
  });
  const skus = splitCsv(row.skus);
  const unboundSkus = new Set(splitCsv(row.unbound_skus));
  const rawFallbackName = firstCsvValue(row.product_names);
  const fallbackName = rawFallbackName && rawFallbackName !== "Unbound product" ? rawFallbackName : "";
  const fallbackImage = firstCsvValue(row.order_image_urls) || firstCsvValue(row.image_urls) || inventoryImages[0] || "";

  if (!skus.length) {
    return [{
      sku: row.ozon_sku || "-",
      name: skuNames.get(row.ozon_sku) || fallbackName || row.ozon_sku || "待创建库存商品",
      quantity: Number(row.total_quantity || row.quantity_total || row.quantity || row.item_count || 1),
      imageUrl: fallbackImage,
      stock: { fbs: 0, fbp: 0 },
      productId: 0,
      onlineId: 0,
      ozonProductId: String(row.ozon_product_id || row.ozon_sku || ""),
      unbound: true,
      productLink: ozonBuyerProductLinkFor(row.ozon_product_id || row.ozon_sku)
    }];
  }

  return skus.map((sku) => {
    const ozonProductId = ozonProductIds.get(sku) || fallbackOzonProductId(sku) || "";
    const onlineId = onlineIds.get(sku) || 0;
    return {
      sku,
      name: skuNames.get(sku) || fallbackName || sku || "待创建库存商品",
      quantity: skuQuantities.get(sku) || 0,
      imageUrl: skuImages.get(sku) || fallbackImage || inventoryImages[0] || "",
      stock: stockMap.get(sku) || { fbs: 0, fbp: 0 },
      productId: productIds.get(sku) || 0,
      onlineId,
      ozonProductId,
      unbound: unboundSkus.has(sku),
      productLink: ozonBuyerProductLinkFor(ozonProductId)
    };
  });
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
        sku: item.sku || "",
        productName: fallbackIndex >= 0 ? (productNames[fallbackIndex] || item.name) : (item.name || productNames[0] || "搴撳瓨鍟嗗搧"),
        amountText: `CNY ${formatMoney(profitSummary.revenue)}`
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
    ElMessage.error(error.message || "???????????????");
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
    ElMessage.error(error.message || "閸旂姾娴囨惔鎾崇摠閸熷棗鎼ф径杈Е");
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
  inventoryDialog.createProcurementRequest = true;
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
  createForm.createProcurementRequest = true;
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

function bulkPrintSelected() {
  if (!selectedOrderIds.value.size) return ElMessage.warning("请先选择订单");
  const ids = selectedActionOrderIds("print");
  if (!ids.length) return ElMessage.warning("已选订单里没有可打印面单的订单");
  const skipped = selectedOrderIds.value.size - ids.length;
  if (skipped > 0) ElMessage.warning(`已跳过 ${skipped} 个不可打印订单`);
  return bulkPrint(ids);
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
  await recalculateOrderProfit(orderId);
  orderDetailCache.delete(Number(orderId));
  await loadOrders();
  if (detailDialog.visible && Number(detailDialog.orderId) === Number(orderId)) {
    await openDrawer(detailDialog.mode, orderId);
  }
}

async function handlePrepareOrder(orderId) {
  await prepareSingleOrder(orderId);
  orderDetailCache.delete(Number(orderId));
  await loadOrders();
}

async function handlePrintOrder(orderId) {
  await printSingleOrder(orderId);
  orderDetailCache.delete(Number(orderId));
  await loadOrders();
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

function handleOpenProcurement(productId) {
  procurementDialog.productId = Number(productId || 0) || null;
  procurementDialog.visible = Boolean(procurementDialog.productId);
}

async function handleProcurementCreated() {
  procurementDialog.visible = false;
  procurementDialog.productId = null;
  await loadOrders();
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
  inventoryDialog.createProcurementRequest = true;
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
  createForm.createProcurementRequest = true;
  const defaultRule = defaultLogisticsRule();
  if (defaultRule) {
    createForm.logisticsRuleId = String(defaultRule.id);
    createForm.shippingMethod = defaultRule.channel || defaultRule.name || "";
  }
}

async function submitInventoryDialog() {
  if (!inventoryDialog.onlineProductId) {
    ElMessage.warning("????????? ID");
    return;
  }
  if (inventoryDialog.mode === "bind" && !bindForm.productId) {
    ElMessage.warning("???????????");
    return;
  }
  if (inventoryDialog.mode !== "bind") {
    if (!String(createForm.name || "").trim()) {
      ElMessage.warning("??????????????");
      return;
    }
    if (!createForm.personId) {
      ElMessage.warning("??????????");
      return;
    }
    if (!createForm.logisticsRuleId) {
      ElMessage.warning("???????????");
      return;
    }
  }
  inventoryDialog.submitting = true;
  try {
    if (inventoryDialog.mode === "bind") {
      await apiClient.post("/api/online-products/bind", {
        online_product_id: inventoryDialog.onlineProductId,
        product_id: Number(bindForm.productId),
        person_id: bindForm.personId ? Number(bindForm.personId) : null
      });
      ElMessage.success("???????????");
    } else {
      await apiClient.post("/api/online-products/create-product", {
        online_product_id: inventoryDialog.onlineProductId,
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
        purchase_quantity: createQuantity.value,
        supplier_id: createForm.supplierId || null,
        source_platform: createForm.sourcePlatform || "1688",
        shipping_method: createForm.shippingMethod || "cel_air_land",
        logistics_rule_id: createForm.logisticsRuleId ? Number(createForm.logisticsRuleId) : null,
        urgency: createForm.urgency || "normal",
        needed_by: createForm.neededBy || null,
        create_procurement_request: createForm.createProcurementRequest ? "1" : ""
      });
      ElMessage.success(createForm.createProcurementRequest ? "??????????????????????????" : "??????????????????");
    }
    resetInventoryDialog();
    await loadOrders();
  } catch (error) {
    ElMessage.error(error.message || (inventoryDialog.mode === "bind" ? "?????????" : "?????????"));
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
  await loadOrders();
  await bootstrapFromRoute();
});
</script>

<template>
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
      @more-action="handleMoreAction"
      @open-quality-rules="showQualityRules"
      @reset-dates="resetRecentDates"
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
        @bulk-print="bulkPrintSelected"
        @bulk-prepare="bulkPrepareSelected"
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
        @open-procurement="handleOpenProcurement"
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
            <el-button v-if="detailDialog.mode === 'profit'" type="primary" @click="handleRecalculate(detailDialog.orderId)">重算利润</el-button>
          </div>
        </div>

        <div v-if="detailDialog.mode === 'profit'" class="orders-profit-detail-shell">
          <div class="orders-profit-order-card">
            <el-image
              v-if="detailPrimaryImageUrl"
              :src="detailPrimaryImageUrl"
              fit="contain"
              class="orders-profit-order-thumb"
              :preview-src-list="[detailPrimaryImageUrl]"
              preview-teleported
            />
            <div v-else class="orders-profit-order-thumb orders-profit-order-image-empty">鏃犲浘</div>
            <div class="orders-profit-order-copy">
              <strong>{{ detailPrimaryItem.product_name || detailPrimaryItem.ozon_name || "订单商品" }}</strong>
              <span>{{ detailPrimaryItem.owner_name || "未分配负责人" }} / 状态: {{ rowStateLabel(detailOrder) }}</span>
              <span>SKU: {{ detailPrimaryItem.ozon_sku || "-" }} / 货号: {{ detailPrimaryItem.offer_id || "-" }}</span>
            </div>
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
                <div v-else class="vue-orders-detail-item-thumb vue-orders-detail-item-thumb-empty">鏃犲浘</div>
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
              <span>先保留来源信息，再补全商品主数据、规格和采购请求。提交时会同时创建库存和采购请求。</span>
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
                  <el-form-item label="采购数量">
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
                  <strong>采购请求</strong>
                  <span>勾选后会在创建库存时同步提交采购请求。</span>
                </div>
                <div class="create-grid create-grid--proc">
                  <el-form-item label="紧急程度">
                    <el-segmented v-model="createForm.urgency" :options="[{ label: '普通', value: 'normal' }, { label: '加急', value: 'urgent' }]" />
                  </el-form-item>
                  <el-form-item label="需求日期">
                    <el-input v-model="createForm.neededBy" placeholder="例如 2026-05-20" />
                  </el-form-item>
                  <el-form-item label="同步采购">
                    <el-switch v-model="createForm.createProcurementRequest" />
                  </el-form-item>
                  <el-form-item label="采购说明" class="create-grid-span-2">
                    <el-input v-model="createForm.note" type="textarea" :rows="3" placeholder="提交到采购请求里的备注" />
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
            <span>采购请求</span>
            <strong>{{ createForm.createProcurementRequest ? "同步提交" : "不创建" }}</strong>
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
          {{ inventoryDialog.mode === "bind" ? "确认绑定" : (createForm.createProcurementRequest ? "创建库存并提交采购" : "仅创建库存") }}
        </el-button>
      </template>
    </el-dialog>

    <ProcurementRequestCreateDialog
      v-model="procurementDialog.visible"
      :initial-product-id="procurementDialog.productId"
      lock-product
      @created="handleProcurementCreated"
    />
  </section>
</template>
