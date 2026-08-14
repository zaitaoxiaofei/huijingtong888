<script setup>
import { computed, defineExpose, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, Plus } from "@element-plus/icons-vue";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import OrdersStatusTabs from "./components/OrdersStatusTabs.vue";
import OrdersTable from "./components/OrdersTable.vue";
import OrdersToolbar from "./components/OrdersToolbar.vue";
import PageFooterPagination from "../admin/components/PageFooterPagination.vue";
import OzonCategorySelect from "../admin/components/listing/OzonCategorySelect.vue";
import ProductCompositionDialog from "../admin/components/inventory/ProductCompositionDialog.vue";
import ProductCreateEditDialog from "../admin/components/inventory/ProductCreateEditDialog.vue";
import InventoryStructuredSearch from "../admin/components/inventory/InventoryStructuredSearch.vue";
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
import { inventoryProductNameGroup, scoreInventorySimilarity } from "../admin/utils/inventory-similarity.js";
import { previewOrderLabels } from "./services/orders-service.js";
import "./orders-view.css";
import "../admin/styles/erp-theme.css";

const route = useRoute();
const router = useRouter();
const emit = defineEmits(["inventory-completed"]);
const elementLocale = zhCn;

const orderDetailCache = new Map();
let latestOrderSyncTimer = 0;

const {
  vm,
  loading,
  totalPages,
  selectedOrderIds,
  loadOrders,
  loadLogisticsOptions,
  submitFilters,
  changeStatus,
  changeFulfillmentType,
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
  prepareSplitOrder,
  previewOrderProcurement,
  createOrderProcurementRequests,
  printSingleOrder,
  recalculateOrderProfit,
  saveOrderMark,
  loadStatusTabPreference,
  loadLatestOrderSyncStatus,
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

const splitOrderDialog = reactive({
  visible: false,
  loading: false,
  submitting: false,
  orderId: null,
  postingNumber: "",
  items: [],
  packages: []
});

const splitOrderValidation = computed(() => {
  if (splitOrderDialog.packages.length < 2) return "至少需要两个包裹";
  if (splitOrderDialog.packages.some((pkg) => !Object.values(pkg.quantities || {}).some((value) => Number(value) > 0))) {
    return "每个包裹至少需要分配一件商品";
  }
  for (const item of splitOrderDialog.items) {
    const assigned = splitOrderDialog.packages.reduce(
      (sum, pkg) => sum + Number(pkg.quantities?.[item.id] || 0),
      0
    );
    if (assigned !== Number(item.quantity || 0)) {
      return `${item.sku} 已分配 ${assigned} 件，应分配 ${item.quantity} 件`;
    }
  }
  return "";
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

const QUALITY_CHECK_ORDER_PREFIXES = ["02090", "02131", "02478"];

function isQualityCheckOrderRow(row = {}) {
  if (Number(row.is_quality_order || 0) !== 0 || String(row.order_nature || "") === "quality_check") return true;
  const postingNumber = String(row.posting_number || row.order_number || "").trim();
  return QUALITY_CHECK_ORDER_PREFIXES.some((prefix) => postingNumber.startsWith(prefix));
}

const procurementSourceOptions = [
  { label: "1688", value: "1688" },
  { label: "拼多多", value: "pdd" },
  { label: "淘宝", value: "taobao" },
  { label: "供应商", value: "supplier" },
  { label: "微信", value: "wechat" },
  { label: "线下", value: "offline" },
  { label: "其他", value: "other" }
];

function procurementChannelLabel(value) {
  return procurementSourceOptions.find((item) => item.value === String(value || ""))?.label || "其他";
}

const procurementUrgencyOptions = [
  { label: "普通", value: "normal" },
  { label: "加急", value: "urgent" }
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
  mode: "single",
  productId: "",
  personId: "",
  recipeItems: [],
  componentSelectId: "",
  componentQuery: ""
});
const bindRecipeOptions = ref([]);
const bindRecipeLoading = ref(false);
const createComponentOptions = ref([]);
const createComponentLoading = ref(false);
const createSimilarProducts = ref([]);
const createSimilarProductsLoading = ref(false);
let createSimilarProductsTimer = null;
const createCompositionDialogVisible = ref(false);
const createdInventoryProductId = ref(null);
const createComponentCategory = ref("single");
const createComponentListPage = ref(1);
const createComponentListPageSize = ref(INVENTORY_LIST_PAGE_SIZE);
const createComponentProductTotal = ref(0);

const createComponentCategoryOptions = [
  { label: "单品", value: "single" },
  { label: "组合", value: "combo" },
  { label: "配件", value: "accessory" }
];

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
  stockUnit: "个",
  structureType: "single",
  isAccessory: 0,
  compositionItems: [],
  componentSelectId: "",
  componentQuery: ""
});



const bindProductQuery = ref("");
const bindProductCategory = ref("");
const bindProductSearchMode = ref("fuzzy");
const bindProductStructuredFilters = reactive({
  inventoryCategory: "",
  productName: "",
  vehicleBrand: "",
  fitmentType: "",
  vehicleModel: [],
  accessoryName: "",
  color: "",
  material: [],
  process: ""
});
const inventoryListPage = ref(1);
const inventoryListPageSize = ref(INVENTORY_LIST_PAGE_SIZE);
const inventoryProductEditorVisible = ref(false);
const inventoryProductEditorValue = ref(null);
const inventoryProductEditorLoadingId = ref(0);
const inventoryProductEditorMode = ref("edit");
const inventoryProductEditorCreateContext = ref(null);
const compositionDialogVisible = ref(false);
const compositionDialogReadOnly = ref(false);
const compositionDialogProduct = ref(null);
const compositionDialogRefreshKey = ref(0);
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
const detailLossRows = computed(() => (detailProfit.value?.rows || []).filter((row) => (
  ["purchase", "domestic", "international", "packaging", "commission", "collecting", "service", "aftersale", "other"].includes(row.key)
  && (Math.abs(Number(row.estimated || 0)) > 0.005 || Math.abs(Number(row.actual || 0)) > 0.005)
)));
const detailLossCostTotal = computed(() => {
  const summary = detailProfit.value?.summary || {};
  return summary.actualCostTotal !== null && summary.actualCostTotal !== undefined
    ? Number(summary.actualCostTotal || 0)
    : Number(summary.estimatedCostTotal || 0);
});
const detailFinalLoss = computed(() => {
  const summary = detailProfit.value?.summary || {};
  const profit = summary.actualProfitReady && summary.actualProfit !== null && summary.actualProfit !== undefined
    ? Number(summary.actualProfit || 0)
    : Number(summary.estimatedProfit || 0);
  return Math.max(0, -profit);
});
const detailProfitItemCards = computed(() => detailItems.value.map((item, index) => ({
  id: item.id || `${item.ozon_sku || "item"}-${index}`,
  index: index + 1,
  name: item.product_name || item.ozon_name || "订单商品",
  sku: item.ozon_sku || "-",
  offerId: item.offer_id || "-",
  imageUrl: detailItemImageUrl(item),
  saleAmount: detailItemSaleAmount(item),
  estimatedProfit: Number(item.estimated_profit || item.net_profit_cny || 0),
  actualProfit: item.settlement_state === "accrued" && item.profit_status === "accrued"
    ? Number(item.actual_profit || item.net_profit_cny || 0)
    : null,
  statusText: item.settlement_state === "accrued" && item.profit_status === "accrued" ? "已结算" : "预估中"
})));
const selectedInventoryProduct = computed(() => (
  inventoryOptions.products.find((row) => Number(row.id) === Number(bindForm.productId)) || null
));
const bindRecipeAvailable = computed(() => {
  const values = bindForm.recipeItems.map((item) => recipeItemAvailable(item));
  return values.length ? Math.min(...values) : null;
});
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
const createCompositionAvailable = computed(() => {
  const values = createForm.compositionItems.map((item) => recipeItemAvailable(item));
  return values.length ? Math.min(...values) : null;
});
const createProductStructureLabel = computed(() => (
  createForm.structureType === "kit" ? `套装产品 / ${createForm.compositionItems.length} 个组成` : "单品产品"
));
const createProductAvailableLabel = computed(() => (
  createForm.structureType === "kit" ? String(createCompositionAvailable.value ?? "-") : "-"
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

function inventoryProductSkuPreviews(row) {
  return Array.isArray(row?.bound_mappings) ? row.bound_mappings.slice(0, 3) : [];
}

function inventoryProductSkuImage(item) {
  return item?.online_image_url || "";
}

function inventoryProductOwner(row) {
  return row?.owner_name || "未分配负责人";
}

function inventoryProductBasicLines(row) {
  const lines = [];
  const cost = Number(row?.purchase_cost || 0);
  const weight = Number(row?.package_weight_g || 0);
  const size = [row?.length_cm, row?.width_cm, row?.height_cm].map((value) => Number(value || 0));
  lines.push(`${inventoryProductTypeText(row)} / 单位 ${row?.stock_unit || "个"}`);
  if (row?.ozon_category_name) lines.push(`类目 ${row.ozon_category_name}`);
  if (cost) lines.push(`成本 ¥${cost.toFixed(1)}`);
  if (weight) lines.push(`重量 ${Math.round(weight)}g`);
  if (size.every((value) => value > 0)) lines.push(`规格 ${size.map((value) => Math.round(value)).join(" x ")}cm`);
  return lines.length ? lines : ["未完善基础信息"];
}

function inventoryProductTypeText(row) {
  return Number(row?.is_accessory || 0) ? "配件库存" : "库存产品";
}

function inventoryProductCategoryText(row) {
  if (Number(row?.is_accessory || 0)) return "配件";
  if (Number(row?.component_count || 0) > 0) return "组合";
  return "单品";
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

function inventoryProductLocalStock(row) {
  return Number(row?.local_stock ?? row?.stock ?? row?.available_stock ?? row?.quantity ?? 0) || 0;
}

function recipeItemLabel(item) {
  return item?.product_name || item?.name || item?.inventory_id || item?.code || `#${item?.product_id || item?.id || "-"}`;
}

function recipeItemCode(item) {
  return item?.inventory_id || item?.code || `#${item?.product_id || item?.id || "-"}`;
}

function recipeItemImage(item) {
  return item?.product_image_url || item?.image_url || "";
}

function recipeItemAvailable(item) {
  const quantity = Number(item?.quantity || 0);
  if (!quantity) return 0;
  return Math.floor(Number(item?.local_stock || 0) / quantity);
}

function preferredPersonId() {
  return String(inventoryOptions.people[0]?.id || "");
}

function normalizePagedRows(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

watch([bindProductQuery, bindProductCategory, bindProductSearchMode, bindProductStructuredFilters], () => {
  if (!inventoryDialog.visible || inventoryDialog.mode !== "bind") return;
  if (inventoryProductSearchTimer.value) window.clearTimeout(inventoryProductSearchTimer.value);
  inventoryProductSearchTimer.value = window.setTimeout(() => {
    if (inventoryListPage.value !== 1) {
      inventoryListPage.value = 1;
      return;
    }
    loadInventoryProductOptions();
  }, 250);
}, { deep: true });

watch(inventoryListPage, () => {
  if (!inventoryDialog.visible || inventoryDialog.mode !== "bind") return;
  loadInventoryProductOptions();
});

watch(inventoryListPageSize, () => {
  if (!inventoryDialog.visible || inventoryDialog.mode !== "bind") return;
  if (inventoryListPage.value !== 1) {
    inventoryListPage.value = 1;
    return;
  }
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

  if (text.includes("return")) return "已退货";
  if (text.includes("reject") || text.includes("not_accepted") || text.includes("unclaimed")) return "拒收/未领取";
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

  if (text.includes("return")) return "returned";
  if (text.includes("reject") || text.includes("not_accepted") || text.includes("unclaimed")) return "rejected";
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
  const apiActions = row?.availableActions && typeof row.availableActions === "object" ? row.availableActions : {};
  const showPrepare = beforeTransit && !isFbp && isAwaitingPackaging && apiActions.prepare !== false;
  const quantitySummary = Number(row?.total_quantity || row?.quantity_total || row?.quantity || row?.item_count || 1);
  const showSplitPrepare = beforeTransit && !isFbp && quantitySummary > 1 && (isAwaitingPackaging || isAwaitingDeliver);
  const showPurchase = beforeTransit && (isAwaitingDeliver || isAwaitingPackaging) && apiActions.purchase !== false;
  const showPrint = beforeTransit && isAwaitingDeliver && apiActions.print !== false;
  const canPrint = showPrint && !isFbp && (Boolean(apiActions.print) || printed || isAwaitingDeliver);
  return {
    ...apiActions,
    print: canPrint,
    prepare: showPrepare,
    purchase: showPurchase,
    showPrint,
    showPrepare,
    splitPrepare: showPrepare,
    showSplitPrepare,
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
  const outcome = String(detailOrder.value?.outcome_type || "");
  if (outcome === "cancelled_pre_fulfillment") return 0;
  if (["rejected_unclaimed", "after_delivery_return"].includes(outcome)) {
    const hasRetainedSale = detailFinance.value.some((row) => Math.abs(Number(row.accruals_for_sale_cny || row.accruals_for_sale || 0)) > 0.005);
    if (!hasRetainedSale) return 0;
    return Number(item.sale_amount_cny || 0);
  }
  return Number(item.sale_amount_cny || 0) || (Number(item.sale_price || 0) * Number(item.quantity || 0));
}

function buildProfitSummary(row) {
  const estimated = Number(row.estimated_profit || 0);
  const actual = Number(row.actual_profit || 0);
  const settlementStates = splitCsv(row.settlement_states).map((value) => value.toLowerCase());
  const profitStatuses = splitCsv(row.profit_statuses).map((value) => value.toLowerCase());
  const fullyAccrued = settlementStates.length > 0
    && profitStatuses.length > 0
    && settlementStates.every((value) => value === "accrued")
    && profitStatuses.every((value) => value === "accrued");
  const effective = fullyAccrued ? actual : estimated;
  return {
    revenue: Number(row.revenue || 0),
    estimated,
    actual,
    hasActual: fullyAccrued,
    effective,
    effectiveType: fullyAccrued ? "actual" : "estimated",
    alertLevel: effective < 0 ? "loss" : effective < 1 ? "low" : ""
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
    ozonMethodName: row.delivery_method_name || row.logistics_channel || "--",
    resolvedRuleName: row.billing_logistics_rule_name || row.resolved_logistics_rule_name || "--",
    ruleSourceLabel: row.billing_logistics_rule_name ? "利润计费" : "物流识别",
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
  const incomingCount = types.includes("incoming_available");
  const requestCount = types.includes("procurement_request");
  const detail = incomingCount && requestCount
    ? "采购在途可满足/已提交采购"
      : incomingCount
      ? "采购在途可满足"
      : stockCount && requestCount
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
    fbp: summary.fbp + Number(item.stock?.fbp || 0),
    local: summary.local + Number(item.stock?.local || 0)
  }), { fbs: 0, fbp: 0, local: 0 });
  const quantitySummary = Number(row.total_quantity || row.quantity_total || row.quantity || row.item_count || 1);
  const productIds = splitCsv(row.product_ids).map((item) => Number(item)).filter(Boolean);
  const productNames = splitCsv(row.product_names);
  const seenProductIds = new Set();
  const inventorySummaries = productDisplayRows
    .filter((item) => Number(item.productId || 0) > 0 || item.inventoryMode === "combo")
    .map((item) => {
      const productId = Number(item.productId || 0);
      const fallbackIndex = productIds.findIndex((id) => Number(id) === productId);
      return {
        productId,
        inventoryKey: productId ? `product-${productId}` : `combo-${item.sku || item.orderItemId || "sku"}`,
        inventoryMode: item.inventoryMode || (productId ? "single" : "unbound"),
        orderItemId: Number(item.orderItemId || 0) || null,
        sku: item.sku || "",
        quantity: Number(item.quantity || 0),
        productName: item.inventoryMode === "combo"
          ? `组合库存方案 / ${item.name || item.sku || "SKU"}`
          : (item.inventoryName || (fallbackIndex >= 0 ? (productNames[fallbackIndex] || item.name) : (item.name || productNames[0] || "库存商品"))),
        saleAmount: Number(item.saleAmount || 0),
        estimatedProfit: Number(item.estimatedProfit || 0),
        actualProfit: Number(item.actualProfit || 0),
        actualProfitReady: Boolean(item.actualProfitReady),
        amountText: `CNY ${formatMoney(item.saleAmount || 0)}`,
        stock: item.stock || { fbs: 0, fbp: 0, local: 0 },
        incoming: Number(item.incoming || 0),
        componentCount: Number(item.componentCount || 0)
      };
    })
    .filter((item) => {
      const dedupeKey = item.inventoryKey || String(item.productId || "");
      if (seenProductIds.has(dedupeKey)) return false;
      seenProductIds.add(dedupeKey);
      return true;
    });
  const terminalOutcome = ["cancelled_pre_fulfillment", "rejected_unclaimed", "after_delivery_return"].includes(String(row?.outcome_type || ""));
  const cancelReasonText = terminalOutcome || ["cancelled", "returned", "rejected"].includes(displayStateKey)
    ? row?.cancel_reason_label || "取消原因待同步"
    : "--";
  const cancelReasonMeta = cancelReasonText === "--"
    ? ""
    : [
        row?.aftersale_bucket_label ? `归类：${row.aftersale_bucket_label}` : "",
        row?.loss_profile_label ? `损失口径：${row.loss_profile_label}` : ""
      ].filter(Boolean).join(" · ");
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
    cancelReasonMeta,
    cancelCategoryText: terminalOutcome ? row?.aftersale_bucket_label || "原因待归类" : "--",
    cancelInitiatorText: cancelReasonText !== "--" && row?.cancel_initiator_label ? `发起方：${row.cancel_initiator_label}` : "",
    amountText: `CNY ${formatMoney(profitSummary.revenue)}`,
    statusLabel: rowStateLabel(row),
    statusColor: rowStateColor(row),
    statusDeadlineHint: buildStatusDeadlineHint(displayStateKey, logisticsSummary),
    qualityCheckOrder: isQualityCheckOrderRow(row),
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
    baseWeightG,
    lengthCm: Number(displayItem?.length_cm || displayItem?.length || row.length_cm || 0) || "",
    widthCm: Number(displayItem?.width_cm || displayItem?.width || row.width_cm || 0) || "",
    heightCm: Number(displayItem?.height_cm || displayItem?.height || row.height_cm || 0) || "",
    listingPriceRub: Number(displayItem?.salePrice || displayItem?.sale_price || row.sale_price || 0) || 0
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
    pageSize: String(inventoryListPageSize.value || INVENTORY_LIST_PAGE_SIZE)
  });
  const query = String(bindProductQuery.value || "").trim();
  if (bindProductSearchMode.value === "fuzzy") {
    if (query) params.set("query", query);
    const category = String(bindProductCategory.value || "").trim();
    if (category) params.set("category", category);
  } else {
    for (const [key, rawValue] of Object.entries(bindProductStructuredFilters)) {
      const value = Array.isArray(rawValue) ? rawValue.join(",") : String(rawValue || "").trim();
      if (value) params.set(key, value);
    }
  }
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

function createComponentProductQueryString() {
  const params = new URLSearchParams({
    paged: "1",
    page: String(createComponentListPage.value),
    pageSize: String(createComponentListPageSize.value || INVENTORY_LIST_PAGE_SIZE),
    inventoryType: createComponentCategory.value
  });
  const query = String(createForm.componentQuery || "").trim();
  if (query) params.set("query", query);
  return params.toString();
}

async function loadCreateComponentProducts() {
  createComponentLoading.value = true;
  try {
    const result = await apiClient.get(`/api/products?${createComponentProductQueryString()}`);
    createComponentOptions.value = normalizePagedRows(result).filter((item) => Number(item.active ?? 1) !== 0);
    createComponentProductTotal.value = Array.isArray(result) ? createComponentOptions.value.length : Number(result?.total || 0);
  } catch (error) {
    ElMessage.error(error.message || "加载组件商品失败");
  } finally {
    createComponentLoading.value = false;
  }
}

async function searchCreateComponentProducts(query = "") {
  createForm.componentQuery = String(query || "").trim();
  createComponentListPage.value = 1;
  await loadCreateComponentProducts();
}

async function changeCreateComponentCategory(category) {
  createComponentCategory.value = category || "single";
  createComponentListPage.value = 1;
  await loadCreateComponentProducts();
}

async function handleCreateComponentPageChange(page) {
  createComponentListPage.value = Number(page || 1);
  await loadCreateComponentProducts();
}

async function handleCreateComponentPageSizeChange(pageSize) {
  createComponentListPageSize.value = Number(pageSize || INVENTORY_LIST_PAGE_SIZE);
  createComponentListPage.value = 1;
  await loadCreateComponentProducts();
}

function addCreateCompositionItem(productId) {
  const row = createComponentOptions.value.find((item) => Number(item.id) === Number(productId));
  if (!row) return;
  const existing = createForm.compositionItems.find((item) => Number(item.product_id) === Number(row.id));
  if (existing) {
    existing.quantity = Number(existing.quantity || 0) + 1;
  } else {
    createForm.compositionItems.push({
      product_id: Number(row.id),
      product_name: inventoryProductLabel(row),
      code: row?.code || "",
      inventory_id: row?.inventory_id || "",
      image_url: inventoryProductImage(row),
      stock_unit: row?.stock_unit || "个",
      local_stock: inventoryProductLocalStock(row),
      quantity: 1
    });
  }
  createForm.structureType = "kit";
}

function createCompositionItemSelected(productId) {
  return createForm.compositionItems.some((item) => Number(item.product_id) === Number(productId));
}

function removeCreateCompositionItem(productId) {
  createForm.compositionItems = createForm.compositionItems.filter((item) => Number(item.product_id) !== Number(productId));
}

async function loadSkuInventoryRecipe() {
  bindForm.mode = "single";
  bindForm.recipeItems = [];
  if (!inventoryDialog.onlineProductId) return;
  try {
    const params = new URLSearchParams({
      online_product_id: String(inventoryDialog.onlineProductId),
      ozon_sku: String(inventoryDialog.sku || "")
    });
    const result = await apiClient.get(`/api/sku-inventory-recipes?${params.toString()}`);
    const items = Array.isArray(result?.items) ? result.items : [];
    if (String(result?.mode || "") === "combo" && items.length) {
      bindForm.mode = "combo";
      bindForm.productId = "";
      bindForm.recipeItems = items.map((item) => ({
        product_id: Number(item.product_id),
        product_name: item.product_name || "",
        code: item.code || "",
        inventory_id: item.inventory_id || "",
        image_url: item.image_url || "",
        stock_unit: item.stock_unit || "个",
        local_stock: Number(item.local_stock || 0),
        quantity: Number(item.quantity || 1)
      }));
    }
  } catch (error) {
    ElMessage.error(error.message || "加载组合方案失败");
  }
}

async function searchBindRecipeProducts(query = "") {
  bindForm.componentQuery = String(query || "").trim();
  if (!bindForm.componentQuery) {
    bindRecipeOptions.value = [];
    return;
  }
  bindRecipeLoading.value = true;
  try {
    const params = new URLSearchParams({
      paged: "1",
      page: "1",
      pageSize: "20",
      query: bindForm.componentQuery
    });
    const result = await apiClient.get(`/api/products?${params.toString()}`);
    bindRecipeOptions.value = normalizePagedRows(result).filter((item) => Number(item.active ?? 1) !== 0);
  } catch (error) {
    ElMessage.error(error.message || "加载组件商品失败");
  } finally {
    bindRecipeLoading.value = false;
  }
}

function addBindRecipeItem(productId) {
  const row = bindRecipeOptions.value.find((item) => Number(item.id) === Number(productId));
  if (!row) return;
  const existing = bindForm.recipeItems.find((item) => Number(item.product_id) === Number(row.id));
  if (existing) {
    existing.quantity = Number(existing.quantity || 0) + 1;
  } else {
    bindForm.recipeItems.push({
      product_id: Number(row.id),
      product_name: inventoryProductLabel(row),
      code: row?.code || "",
      inventory_id: row?.inventory_id || "",
      image_url: inventoryProductImage(row),
      stock_unit: row?.stock_unit || "个",
      local_stock: inventoryProductLocalStock(row),
      quantity: 1
    });
  }
  bindForm.componentSelectId = "";
  bindForm.componentQuery = "";
}

function removeBindRecipeItem(productId) {
  bindForm.recipeItems = bindForm.recipeItems.filter((item) => Number(item.product_id) !== Number(productId));
}

async function handleInventoryProductSearch() {
  inventoryListPage.value = 1;
  await loadInventoryProductOptions();
}

async function handleInventoryProductPageChange(page) {
  inventoryListPage.value = Number(page || 1);
  await loadInventoryProductOptions();
}

async function openInventoryProductEditor(row) {
  const productId = Number(row?.id || 0);
  if (!productId) return;
  inventoryProductEditorLoadingId.value = productId;
  inventoryProductEditorMode.value = "edit";
  try {
    inventoryProductEditorValue.value = await apiClient.get(`/api/products/${productId}`, { noCache: true });
    inventoryProductEditorVisible.value = true;
  } catch (error) {
    ElMessage.error(error.message || "加载库存商品详情失败");
  } finally {
    inventoryProductEditorLoadingId.value = 0;
  }
}

async function openProductCompositionDialog(productId) {
  const id = Number(productId || 0);
  if (!id) return;
  await ensureInventoryOptionsLoaded();
  compositionDialogProduct.value = { id };
  compositionDialogReadOnly.value = false;
  compositionDialogVisible.value = true;
}

async function viewProductCompositionDialog(productId) {
  const id = Number(productId || 0);
  if (!id) return;
  compositionDialogProduct.value = { id };
  compositionDialogReadOnly.value = true;
  compositionDialogVisible.value = true;
}

function openQuickCreateFromComposition() {
  inventoryProductEditorMode.value = "create";
  inventoryProductEditorValue.value = null;
  inventoryProductEditorVisible.value = true;
}

async function handleProductCompositionSaved() {
  compositionDialogVisible.value = false;
  compositionDialogProduct.value = null;
  await Promise.all([loadInventoryProductOptions(), loadOrders({ forceRefresh: true, includeCounts: true })]);
}

async function handleInventoryProductEditorSaved({ mode, product } = {}) {
  const createdFromOrder = mode === "create" && Boolean(inventoryProductEditorCreateContext.value?.online_product_id);
  inventoryProductEditorVisible.value = false;
  inventoryProductEditorValue.value = null;
  inventoryProductEditorCreateContext.value = null;
  ElMessage.success(createdFromOrder ? "库存商品已创建并绑定当前订单 SKU" : (mode === "create" ? "库存商品已创建" : "库存商品已更新"));
  await Promise.all([
    loadInventoryProductOptions(),
    loadOrders(createdFromOrder ? { forceRefresh: true, includeCounts: true } : {})
  ]);
  if (inventoryDialog.visible && inventoryDialog.mode === "bind") {
    await loadSkuInventoryRecipe();
  }
  if (compositionDialogVisible.value && mode === "create") {
    compositionDialogRefreshKey.value += 1;
  }
  if (createdFromOrder) emit("inventory-completed", { mode: "create", product });
}

async function handleInventoryProductEditorExistingSelected(row) {
  const context = inventoryProductEditorCreateContext.value;
  if (!context?.online_product_id) {
    inventoryProductEditorVisible.value = false;
    inventoryProductEditorValue.value = null;
    await openInventoryProductEditor(row);
    return;
  }
  try {
    await apiClient.post("/api/online-products/bind", {
      ...context,
      product_id: Number(row.id),
      person_id: context.person_id || null,
      inventory_recipe: { mode: "single", items: [] }
    });
    ElMessage.success("已使用现有库存商品并绑定当前订单 SKU");
    inventoryProductEditorVisible.value = false;
    inventoryProductEditorValue.value = null;
    inventoryProductEditorCreateContext.value = null;
    await loadOrders({ silent: true, forceRefresh: true, includeCounts: true });
    emit("inventory-completed", { mode: "bind", product: row });
  } catch (error) {
    ElMessage.error(error.message || "绑定已有库存商品失败");
  }
}

function resetInventoryDialog() {
  inventoryDialog.visible = false;
  createCompositionDialogVisible.value = false;
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
  bindForm.mode = "single";
  bindForm.productId = "";
  bindForm.personId = "";
  bindForm.recipeItems = [];
  bindForm.componentSelectId = "";
  bindForm.componentQuery = "";
  bindRecipeOptions.value = [];
  bindRecipeLoading.value = false;
  createComponentOptions.value = [];
  createComponentLoading.value = false;
  createComponentCategory.value = "single";
  createComponentListPage.value = 1;
  createComponentListPageSize.value = INVENTORY_LIST_PAGE_SIZE;
  createComponentProductTotal.value = 0;
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
  createForm.stockUnit = "个";
  createForm.structureType = "single";
  createForm.isAccessory = 0;
  createForm.compositionItems = [];
  createdInventoryProductId.value = null;
  createForm.componentSelectId = "";
  createForm.componentQuery = "";
  bindProductQuery.value = "";
  bindProductCategory.value = "";
  bindProductSearchMode.value = "fuzzy";
  Object.assign(bindProductStructuredFilters, { inventoryCategory: "", productName: "", vehicleBrand: "", vehicleModel: [], accessoryName: "", color: "", material: [], process: "" });
  inventoryListPage.value = 1;
  inventoryListPageSize.value = INVENTORY_LIST_PAGE_SIZE;
  inventoryProductEditorVisible.value = false;
  inventoryProductEditorValue.value = null;
  inventoryProductEditorLoadingId.value = 0;
  inventoryProductEditorMode.value = "edit";
  inventoryProductEditorCreateContext.value = null;
  createSimilarProducts.value = [];
  createSimilarProductsLoading.value = false;
  if (createSimilarProductsTimer) {
    window.clearTimeout(createSimilarProductsTimer);
    createSimilarProductsTimer = null;
  }
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
    const result = await previewOrderLabels(ids, {
      printer: selectedPrintPreset.value.printer,
      printSettings: buildPrintSettings(),
      preset: selectedPrintPreset.value.value,
      paperSize: selectedPrintPreset.value.value,
      orientation: printDialog.orientation
    });
    if (result?.confirmed) {
      orderDetailCache.clear();
      await loadOrders({ includeCounts: true });
      ElMessage.success("已记录面单打印时间");
    }
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
    path: "/profit/monthly-billing",
    query: {
      tab: "aftersales",
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
  const routeAction = String(route.query.action || "").trim();
  const routeSku = String(route.query.sku || "").trim();
  if (routeAction === "bind" && routeSku) {
    await handleOpenBindProductFromOrder(orderId, routeSku);
    return;
  }
  if (routeAction === "create" && routeSku) {
    await handleOpenCreateProductFromOrder(orderId, routeSku);
    return;
  }
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

function splitPackageQuantity(pkg, itemId) {
  return Number(pkg?.quantities?.[itemId] || 0);
}

function updateSplitPackageQuantity(pkg, item, value) {
  const next = Math.max(0, Math.min(Number(item.quantity || 0), Math.floor(Number(value || 0))));
  pkg.quantities[item.id] = next;
}

function distributeSplitPackages() {
  const packages = [{ quantities: {} }, { quantities: {} }];
  splitOrderDialog.items.forEach((item, index) => {
    const quantity = Number(item.quantity || 0);
    if (quantity > 1) {
      packages[0].quantities[item.id] = Math.ceil(quantity / 2);
      packages[1].quantities[item.id] = Math.floor(quantity / 2);
    } else {
      packages[index % 2].quantities[item.id] = quantity;
      packages[(index + 1) % 2].quantities[item.id] = 0;
    }
  });
  splitOrderDialog.packages = packages;
}

function addSplitPackage() {
  splitOrderDialog.packages.push({ quantities: {} });
}

function removeSplitPackage(index) {
  if (splitOrderDialog.packages.length <= 2) return;
  const removed = splitOrderDialog.packages[index];
  const targetIndex = index === 0 ? 1 : 0;
  const target = splitOrderDialog.packages[targetIndex];
  for (const item of splitOrderDialog.items) {
    target.quantities[item.id] = splitPackageQuantity(target, item.id) + splitPackageQuantity(removed, item.id);
  }
  splitOrderDialog.packages.splice(index, 1);
}

async function openSplitOrderDialog(orderId) {
  splitOrderDialog.visible = true;
  splitOrderDialog.loading = true;
  splitOrderDialog.orderId = Number(orderId);
  splitOrderDialog.items = [];
  splitOrderDialog.packages = [];
  try {
    const detail = await fetchOrderDetail(orderId);
    const items = (detail?.items || []).map((item) => ({
      id: Number(item.id),
      sku: String(item.ozon_sku || item.mapped_ozon_sku || "-"),
      name: String(item.product_name || item.online_product_name || item.ozon_name || item.ozon_sku || "商品"),
      quantity: Number(item.quantity || 0)
    })).filter((item) => item.id && item.quantity > 0);
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    if (totalQuantity < 2) {
      splitOrderDialog.visible = false;
      ElMessage.warning("该订单只有 1 件商品，无需拆分包裹");
      return;
    }
    splitOrderDialog.postingNumber = String(detail?.order?.posting_number || orderId);
    splitOrderDialog.items = items;
    distributeSplitPackages();
  } catch (error) {
    splitOrderDialog.visible = false;
    ElMessage.error(error?.message || "订单商品加载失败");
  } finally {
    splitOrderDialog.loading = false;
  }
}

async function submitSplitOrder() {
  if (splitOrderValidation.value || splitOrderDialog.submitting) return;
  splitOrderDialog.submitting = true;
  try {
    const packages = splitOrderDialog.packages.map((pkg) => ({
      products: splitOrderDialog.items
        .map((item) => ({
          order_item_id: item.id,
          quantity: splitPackageQuantity(pkg, item.id)
        }))
        .filter((item) => item.quantity > 0)
    }));
    const result = await prepareSplitOrder(splitOrderDialog.orderId, packages);
    orderDetailCache.delete(Number(splitOrderDialog.orderId));
    splitOrderDialog.visible = false;
    await loadOrders({ includeCounts: true });
    ElMessage.success(`已拆分为 ${Number(result?.package_count || packages.length)} 个包裹并完成备货`);
  } catch (error) {
    ElMessage.error(error?.message || "拆分备货失败");
  } finally {
    splitOrderDialog.submitting = false;
  }
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
    qualityDialog.note = list[0]?.note || "订单号命中这些前缀时会标记为质检单。";
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
    orderProcurementDialog.selectedItemIds = orderProcurementItems.value
      .filter((item) => !item.already_handled)
      .map((item) => Number(item.order_item_id))
      .filter(Boolean);
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
    const recentPurchase = product.cost_history?.[0] || null;
    product.purchase_url = product.purchase_url || recentPurchase?.purchase_url || "";
    product.purchase_note = product.supplier_note || "";
    product.purchase_source_type = recentPurchase?.source_type && recentPurchase.source_type !== "other"
      ? recentPurchase.source_type
      : product.source_type || "1688";
    product.purchase_urgency = product.urgency || "normal";
  }
}

function procurementTrendType(product) {
  return {
    rising: "danger",
    stable: "success",
    declining: "info",
    accelerated: "warning",
    dormant: "info",
    sporadic: "warning",
    none: "info"
  }[product?.sales_trend] || "info";
}

function procurementModeType(product) {
  return {
    bulk: "danger",
    single: "warning",
    hold: "success"
  }[product?.purchase_mode] || "info";
}

function procurementCoverageText(product) {
  const days = Number(product?.coverage_days);
  return Number.isFinite(days) ? `${days.toFixed(1)} 天` : "暂无销量";
}

function procurementCurrentUnitCost(product) {
  const quantity = Number(product?.purchase_quantity || 0);
  return quantity > 0 ? Number(product?.purchase_amount || 0) / quantity : 0;
}

function procurementPreviousUnitCost(product) {
  return Number(product?.cost_history?.[0]?.unit_cost || 0);
}

function procurementCostVariance(product) {
  const current = procurementCurrentUnitCost(product);
  const previous = procurementPreviousUnitCost(product);
  if (!(current > 0) || !(previous > 0)) return null;
  const amount = current - previous;
  return {
    amount,
    ratio: amount / previous,
    abnormal: Math.abs(amount) >= 2 && Math.abs(amount / previous) >= 0.25
  };
}

function procurementCostVarianceText(product) {
  const variance = procurementCostVariance(product);
  if (!variance) return "暂无可比历史";
  const sign = variance.ratio > 0 ? "+" : "";
  return `较上批 ${sign}${formatPercent(variance.ratio * 100)}`;
}

function procurementCostTrendType(product) {
  const variance = procurementCostVariance(product);
  if (!variance) return "info";
  if (variance.abnormal) return "danger";
  return Math.abs(variance.ratio) >= 0.1 ? "warning" : "success";
}

function procurementCostHistoryDate(value) {
  return value ? formatDateTime(value) : "-";
}

function procurementCostHistorySummary(product) {
  const rows = Array.isArray(product?.cost_history) ? product.cost_history : [];
  if (!rows.length) return null;
  const costs = rows.map((row) => Number(row.unit_cost || 0)).filter((value) => value > 0);
  const quantity = rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const amount = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return {
    count: rows.length,
    min: costs.length ? Math.min(...costs) : 0,
    max: costs.length ? Math.max(...costs) : 0,
    weighted: quantity > 0 ? amount / quantity : 0
  };
}

function applyProcurementQuantity(product, mode) {
  if (!product) return;
  const previousQuantity = Math.max(0, Number(product.purchase_quantity || 0));
  const nextQuantity = Math.max(0, Math.round(Number(
    mode === "suggested" ? product.suggested_purchase_qty : product.shortage_quantity
  ) || 0));
  const unitAmount = previousQuantity > 0
    ? Number(product.purchase_amount || 0) / previousQuantity
    : Number(product.estimated_amount || 0) / Math.max(1, Number(product.total_quantity || 1));
  const unitShipping = previousQuantity > 0
    ? Number(product.purchase_shipping || 0) / previousQuantity
    : Number(product.estimated_shipping || 0) / Math.max(1, Number(product.total_quantity || 1));
  product.purchase_quantity = nextQuantity;
  product.purchase_amount = Number((unitAmount * nextQuantity).toFixed(2));
  product.purchase_shipping = Number((unitShipping * nextQuantity).toFixed(2));
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
      shipping_amount: Number(product.purchase_shipping || 0),
      purchase_url: String(product.purchase_url || "").trim(),
      note: String(product.purchase_note || "").trim(),
      source_type: product.purchase_source_type || "1688",
      urgency: product.purchase_urgency || "normal",
      supplier_id: product.supplier_id || null
    }));
}

async function validateProcurementPurchaseInputs() {
  const selectedProducts = selectedProcurementProductIds();
  const abnormalProducts = orderProcurementProducts.value.filter((product) => (
    selectedProducts.has(Number(product.product_id)) && procurementCostVariance(product)?.abnormal
  ));
  if (!abnormalProducts.length) return true;
  const details = abnormalProducts.map((product) => {
    const variance = procurementCostVariance(product);
    return `「${product.product_name || product.product_code}」本次 ¥${formatMoney(procurementCurrentUnitCost(product))}/件，上一批 ¥${formatMoney(procurementPreviousUnitCost(product))}/件，变动 ${variance.ratio > 0 ? "+" : ""}${formatPercent(variance.ratio * 100)}`;
  }).join("\n");
  try {
    await ElMessageBox.confirm(
      `${details}\n\n采购单价波动较大，请确认采购数量和货款没有填错。`,
      "采购成本异常确认",
      { type: "warning", confirmButtonText: "数据无误，继续生成", cancelButtonText: "返回检查" }
    );
    return true;
  } catch {
    return false;
  }
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
    await loadOrders({ forceRefresh: true, includeCounts: true });
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
  if (!await validateProcurementPurchaseInputs()) return;
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
    await loadOrders({ forceRefresh: true, includeCounts: true });
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
  bindForm.mode = context.currentProductId ? "single" : "single";
  bindForm.recipeItems = [];
  bindForm.componentSelectId = "";
  bindForm.componentQuery = "";
  bindRecipeOptions.value = [];
  bindProductQuery.value = "";
  bindProductCategory.value = "";
  bindProductSearchMode.value = "fuzzy";
  Object.assign(bindProductStructuredFilters, { inventoryCategory: "", productName: "", vehicleBrand: "", vehicleModel: [], accessoryName: "", color: "", material: [], process: "" });
  inventoryListPage.value = 1;
  inventoryListPageSize.value = INVENTORY_LIST_PAGE_SIZE;
  await loadInventoryProductOptions();
  await loadSkuInventoryRecipe();
}

async function handleOpenCreateProductFromOrder(orderId, sku) {
  const context = resolveOrderInventoryContext(orderId, sku);
  if (!context?.onlineProductId) {
    ElMessage.warning("当前 SKU 缺少在线商品 ID，暂时无法创建库存");
    return;
  }
  await ensureInventoryOptionsLoaded();
  const personId = preferredPersonId();
  const defaultRule = defaultLogisticsRule();
  inventoryProductEditorCreateContext.value = {
    online_product_id: context.onlineProductId,
    order_item_id: context.orderItemId,
    ozon_sku: context.sku,
    person_id: personId ? Number(personId) : null,
    owner_person_id: personId ? Number(personId) : null
  };
  inventoryProductEditorMode.value = "create";
  inventoryProductEditorValue.value = {
    name: context.itemName,
    image_url: context.imageUrl,
    purchase_url: context.sourceUrl,
    package_weight_g: context.baseWeightG || 0,
    length_cm: context.lengthCm || 30,
    width_cm: context.widthCm || 20,
    height_cm: context.heightCm || 10,
    listing_price_rub: context.listingPriceRub || 0,
    owner_person_id: personId || "",
    source_platform: "1688",
    supplier_note: `来自订单 ${orderId} / Ozon SKU ${context.sku}`,
    stock_unit: "个",
    logistics_rule_id: defaultRule?.id || "",
    shipping_method: defaultRule?.channel || "air_land",
    return_rate: 0.05,
    product_type: "main",
    selection_status: "listed"
  };
  inventoryProductEditorVisible.value = true;
}

async function loadCreateSimilarProducts() {
  if (!inventoryDialog.visible || inventoryDialog.mode !== "create" || createdInventoryProductId.value) return;
  const query = String(createForm.name || "").trim();
  if (query.length < 2) {
    createSimilarProducts.value = [];
    return;
  }
  createSimilarProductsLoading.value = true;
  try {
    const exactParams = new URLSearchParams({ paged: "1", page: "1", pageSize: "20", query });
    const broadParams = new URLSearchParams({ paged: "1", page: "1", pageSize: "30", query, matchMode: "any" });
    const coreQuery = inventoryProductNameGroup(query)?.[0] || query;
    const coreParams = new URLSearchParams({ paged: "1", page: "1", pageSize: "30", query: coreQuery });
    const [coreResult, exactResult, broadResult] = await Promise.all([
      apiClient.get(`/api/products?${coreParams.toString()}`, { noCache: true }),
      apiClient.get(`/api/products?${exactParams.toString()}`, { noCache: true }),
      apiClient.get(`/api/products?${broadParams.toString()}`, { noCache: true })
    ]);
    const candidates = [...(coreResult?.rows || []), ...(exactResult?.rows || []), ...(broadResult?.rows || [])]
      .filter((row, index, rows) => rows.findIndex((item) => Number(item.id) === Number(row.id)) === index);
    createSimilarProducts.value = candidates
      .map((row) => ({ ...row, similarity: scoreInventorySimilarity(row, { coreName: createForm.name }) }))
      .filter((row) => row.similarity && row.similarity.score >= 45)
      .sort((left, right) => right.similarity.score - left.similarity.score)
      .slice(0, 5);
  } catch {
    createSimilarProducts.value = [];
  } finally {
    createSimilarProductsLoading.value = false;
  }
}

function scheduleCreateSimilarProducts() {
  if (createSimilarProductsTimer) window.clearTimeout(createSimilarProductsTimer);
  createSimilarProductsTimer = window.setTimeout(loadCreateSimilarProducts, 320);
}

async function bindExistingProductDuringCreate(row) {
  try {
    await ElMessageBox.confirm(
      `确认不再创建新商品，直接把当前 SKU 绑定到“${row.name}”？`,
      "使用已有库存商品",
      { type: "warning", confirmButtonText: "直接绑定", cancelButtonText: "继续创建" }
    );
  } catch {
    return;
  }
  inventoryDialog.submitting = true;
  try {
    await apiClient.post("/api/online-products/bind", {
      online_product_id: inventoryDialog.onlineProductId,
      order_item_id: inventoryDialog.orderItemId,
      ozon_sku: inventoryDialog.sku,
      product_id: Number(row.id),
      person_id: createForm.personId ? Number(createForm.personId) : null,
      inventory_recipe: { mode: "single", items: [] }
    });
    ElMessage.success("已使用现有库存商品并完成绑定");
    resetInventoryDialog();
    await loadOrders({ silent: true, forceRefresh: true, includeCounts: true });
    emit("inventory-completed", { mode: "bind", product: row });
  } catch (error) {
    ElMessage.error(error.message || "绑定已有库存商品失败");
  } finally {
    inventoryDialog.submitting = false;
  }
}

watch(() => createForm.name, scheduleCreateSimilarProducts);

async function submitInventoryDialog() {
  if (!inventoryDialog.onlineProductId) {
    ElMessage.warning("当前订单缺少在线商品 ID");
    return;
  }
  if (inventoryDialog.mode === "bind") {
    if (bindForm.mode === "single" && !bindForm.productId) {
      ElMessage.warning("请先选择库存商品");
      return;
    }
    if (bindForm.mode === "combo" && !bindForm.recipeItems.length) {
      ElMessage.warning("请先添加组合方案的组成商品");
      return;
    }
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
        product_id: bindForm.mode === "combo" ? null : Number(bindForm.productId),
        person_id: bindForm.personId ? Number(bindForm.personId) : null,
        inventory_recipe: {
          mode: bindForm.mode === "combo" ? "combo" : "single",
          items: bindForm.mode === "combo"
            ? bindForm.recipeItems.map((item) => ({
              product_id: Number(item.product_id),
              quantity: Number(item.quantity || 1)
            }))
            : []
        }
      });
      ElMessage.success("库存绑定已更新");
      resetInventoryDialog();
      await loadOrders({ silent: true, forceRefresh: true, includeCounts: true });
      ElMessage.success("采购状态已重新计算");
      emit("inventory-completed", { mode: "bind", product_id: Number(bindForm.productId || 0) });
    } else {
      if (createdInventoryProductId.value) {
        await apiClient.put(`/api/products/${createdInventoryProductId.value}/components`, {
          composition_items: createForm.compositionItems.map((item) => ({
            component_product_id: Number(item.product_id),
            quantity: Number(item.quantity || 1)
          })).filter((item) => item.component_product_id && item.quantity > 0)
        });
        ElMessage.success("产品组成已保存");
        resetInventoryDialog();
        await loadOrders();
        return;
      }
      const created = await apiClient.post("/api/online-products/create-product", {
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
        supplier_note: createForm.note || createForm.supplierNote || "",
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
        needed_by: createForm.neededBy || null,
        stock_unit: createForm.stockUnit || "个",
        is_accessory: Number(createForm.isAccessory || 0) ? 1 : 0,
        composition_items: []
      });
      createdInventoryProductId.value = Number(created?.id || 0) || null;
      if (!createdInventoryProductId.value) throw new Error("库存商品创建后未返回产品 ID");
      createCompositionDialogVisible.value = true;
      ElMessage.success("基础库存已创建，请按需添加子产品");
    }
  } catch (error) {
    ElMessage.error(error.message || (inventoryDialog.mode === "bind" ? "库存绑定失败" : "创建库存失败"));
  } finally {
    inventoryDialog.submitting = false;
  }
}

async function openInventoryDialogFromOutside({ orderId, sku, action = "bind" } = {}) {
  const numericOrderId = Number(orderId || 0);
  const skuText = String(sku || "").trim();
  if (!numericOrderId || !skuText) return;
  vm.filters.searchType = "order";
  vm.filters.searchQuery = String(numericOrderId);
  vm.filters.page = 1;
  await submitFilters();
  if (action === "create") await handleOpenCreateProductFromOrder(numericOrderId, skuText);
  else await handleOpenBindProductFromOrder(numericOrderId, skuText);
}

defineExpose({ loadOrders, openInventoryDialog: openInventoryDialogFromOutside });

watch(() => route.query.orderId, async () => {
  orderRouteBootstrapDone.value = false;
  await bootstrapFromRoute();
});

onMounted(async () => {
  await Promise.all([loadStatusTabPreference(), loadLatestOrderSyncStatus()]);
  latestOrderSyncTimer = window.setInterval(() => {
    void loadLatestOrderSyncStatus();
  }, 60 * 1000);
  if (route.query.orderId) {
    await bootstrapFromRoute();
    return;
  }
  await loadOrders({ includeCounts: true });
  if (vm.filters.logisticsMethod && vm.filters.logisticsMethod !== "all") {
    void loadLogisticsOptions().catch(() => {});
  }
});

onBeforeUnmount(() => {
  window.clearInterval(latestOrderSyncTimer);
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
      :logistics-carrier-options="vm.logisticsCarrierOptions"
      :logistics-method-options="vm.logisticsMethodOptions"
      :search-type-options="SEARCH_TYPE_OPTIONS"
      :sync-status="vm.syncStatus"
      :sync-running="vm.syncRunning"
      :last-sync-text="vm.lastSyncText"
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
        :fulfillment-type-options="vm.fulfillmentTypeOptions"
        :active-fulfillment-type="vm.filters.fulfillmentType"
        :print-views="vm.printViews"
        :active-print-view="vm.filters.printView"
        :mark-options="vm.markOptions"
        :active-mark-filter="vm.filters.markFilter"
        :selected-count="selectedCount"
        @change-status="changeStatus"
        @change-fulfillment-type="changeFulfillmentType"
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
        @split-order="openSplitOrderDialog"
        @print-order="handlePrintOrder"
        @save-mark="handleSaveMark"
        @open-bind-product-from-order="handleOpenBindProductFromOrder"
        @edit-inventory-product="(productId) => openInventoryProductEditor({ id: productId })"
        @open-product-components="openProductCompositionDialog"
        @view-product-components="viewProductCompositionDialog"
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
      v-model="splitOrderDialog.visible"
      title="拆分包裹并备货"
      width="920px"
      align-center
      class="erp-centered-dialog orders-split-dialog"
      destroy-on-close
    >
      <div v-loading="splitOrderDialog.loading" class="orders-split-dialog-body">
        <div class="orders-split-summary">
          <div>
            <span>货件号</span>
            <strong>{{ splitOrderDialog.postingNumber || "-" }}</strong>
          </div>
          <div>
            <span>包裹数量</span>
            <strong>{{ splitOrderDialog.packages.length }}</strong>
          </div>
          <el-button :icon="Plus" @click="addSplitPackage">新增包裹</el-button>
          <el-button @click="distributeSplitPackages">重新均分</el-button>
        </div>

        <div class="orders-split-packages">
          <section
            v-for="(pkg, packageIndex) in splitOrderDialog.packages"
            :key="packageIndex"
            class="orders-split-package"
          >
            <header>
              <strong>包裹 {{ packageIndex + 1 }}</strong>
              <el-tooltip content="删除包裹并把数量合并到第一个包裹" placement="top">
                <el-button
                  :icon="Delete"
                  circle
                  plain
                  type="danger"
                  :disabled="splitOrderDialog.packages.length <= 2"
                  aria-label="删除包裹"
                  @click="removeSplitPackage(packageIndex)"
                />
              </el-tooltip>
            </header>
            <div v-for="item in splitOrderDialog.items" :key="item.id" class="orders-split-item-row">
              <div class="orders-split-item-main">
                <strong>{{ item.name }}</strong>
                <span>SKU {{ item.sku }} · 订单 {{ item.quantity }} 件</span>
              </div>
              <el-input-number
                :model-value="splitPackageQuantity(pkg, item.id)"
                :min="0"
                :max="item.quantity"
                :step="1"
                step-strictly
                controls-position="right"
                aria-label="包裹商品数量"
                @update:model-value="updateSplitPackageQuantity(pkg, item, $event)"
              />
            </div>
          </section>
        </div>

        <el-alert
          v-if="splitOrderValidation"
          :title="splitOrderValidation"
          type="warning"
          :closable="false"
          show-icon
        />
        <el-alert
          v-else
          title="商品数量已全部分配，提交后 Ozon 将按这些包裹完成备货。"
          type="success"
          :closable="false"
          show-icon
        />
      </div>
      <template #footer>
        <el-button @click="splitOrderDialog.visible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="splitOrderDialog.submitting"
          :disabled="Boolean(splitOrderValidation) || splitOrderDialog.loading"
          @click="submitSplitOrder"
        >
          确认拆分并备货
        </el-button>
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
          <div
            v-if="['cancelled_pre_fulfillment', 'rejected_unclaimed', 'after_delivery_return'].includes(detailOrder.outcome_type)"
            class="orders-profit-attribution"
          >
            <div>
              <span>一级归类</span>
              <strong>{{ detailOrder.aftersale_bucket_label || "原因待归类" }}</strong>
            </div>
            <div>
              <span>具体原因</span>
              <strong>{{ detailOrder.cancel_reason_label || "取消原因待同步" }}</strong>
              <small v-if="detailOrder.cancel_reason_original && !detailOrder.cancel_reason_translated">
                Ozon原文：{{ detailOrder.cancel_reason_original }}
              </small>
            </div>
            <div>
              <span>损失公式</span>
              <strong>{{ detailOrder.loss_profile_label || "损失口径待确认" }}</strong>
              <small>{{ detailOrder.loss_formula_text }}</small>
            </div>
          </div>

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

          <div v-if="detailLossRows.length" class="orders-profit-loss-breakdown">
            <div class="orders-profit-loss-breakdown__title">
              <strong>各项成本损失</strong>
              <span>按照当前归类与既有损失公式展示</span>
            </div>
            <div v-for="row in detailLossRows" :key="row.key" class="orders-profit-loss-row">
              <div>
                <strong>{{ row.label }}</strong>
                <small>{{ row.note }}</small>
              </div>
              <b>CNY {{ formatMoney(row.actual ?? row.estimated) }}</b>
            </div>
            <div class="orders-profit-loss-total">
              <span>成本/费用合计</span>
              <strong>CNY {{ formatMoney(detailLossCostTotal) }}</strong>
            </div>
            <div class="orders-profit-loss-total is-final">
              <span>最终总损失</span>
              <strong>CNY {{ formatMoney(detailFinalLoss) }}</strong>
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
            <el-descriptions-item label="Ozon 履约渠道">{{ detailOrder.delivery_method_name || detailOrder.logistics_channel || "--" }}</el-descriptions-item>
            <el-descriptions-item label="利润计费规则">{{ detailOrder.billing_logistics_rule_name || detailOrder.resolved_logistics_rule_name || "--" }}</el-descriptions-item>
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
              placeholder="每行一个订单号前缀，也可以用空格或逗号分隔"
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
          title="订单号开头命中这些规则时会按质检单识别，用于过滤和人工处理提醒。"
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
      width="92vw"
      align-center
      class="erp-centered-dialog order-inventory-modal"
      destroy-on-close
      @closed="resetInventoryDialog"
    >
      <div v-loading="inventoryOptionsLoading" class="order-inventory-dialog" :class="{ 'is-create-mode': inventoryDialog.mode !== 'bind' }">
        <div class="order-inventory-dialog-left">
          <div class="selected-product-card">
            <div class="dialog-search-head">
              <strong>{{ inventoryDialog.mode === "bind" ? "当前订单 SKU" : "创建库存前确认" }}</strong>
              <span>{{ inventoryDialog.mode === "bind" ? "订单上下文与库存绑定目标。" : "来源商品、库存主档与 SKU 绑定结果。" }}</span>
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
                    <div class="order-inventory-current-binding">
                      <strong>{{ inventoryDialog.currentProductName || "未绑定库存商品" }}</strong>
                      <el-button
                        v-if="inventoryDialog.currentProductId"
                        link
                        type="primary"
                        :loading="inventoryProductEditorLoadingId === Number(inventoryDialog.currentProductId)"
                        @click="openInventoryProductEditor({ id: inventoryDialog.currentProductId })"
                      >
                        配置子产品
                      </el-button>
                    </div>
                  </div>
                  <div class="order-inventory-info-row">
                    <span>新绑定目标</span>
                    <strong>
                      {{
                        inventoryDialog.mode === "bind"
                          ? (bindForm.mode === "combo"
                            ? `组合方案 / ${bindForm.recipeItems.length} 个组成`
                            : (selectedInventoryProduct ? `${inventoryProductLabel(selectedInventoryProduct)} / ${inventoryProductTypeText(selectedInventoryProduct)}` : "请选择右侧库存商品"))
                          : createProductStructureLabel
                      }}
                    </strong>
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
              <strong>配置 SKU 库存方案</strong>
              <span>单个库存品用于一对一绑定；组合方案只记录组成部分，不创建独立库存产品。</span>
            </div>
            <el-segmented
              v-model="bindForm.mode"
              :options="[{ label: '单个库存品', value: 'single' }, { label: '组合方案', value: 'combo' }]"
              class="inventory-binding-mode-switch"
            />
            <div v-if="bindForm.mode === 'single'" class="inventory-single-binding-panel">
              <div class="inventory-search-mode-row">
                <el-segmented v-model="bindProductSearchMode" :options="[{ label: '模糊搜索', value: 'fuzzy' }, { label: '精确搜索', value: 'exact' }]" />
                <span>{{ bindProductSearchMode === 'fuzzy' ? '输入多个关键词快速匹配' : '按库存标准名称字段组合筛选' }}</span>
              </div>
              <div v-if="bindProductSearchMode === 'fuzzy'" class="inventory-search-row">
                <el-input v-model="bindProductQuery" placeholder="搜索名称、编码、SKU，可输入多个关键词" clearable />
                <OzonCategorySelect
                  v-model="bindProductCategory"
                  :show-sync="false"
                  placeholder="选择或搜索 Ozon 类目"
                  class="inventory-category-input"
                />
              </div>
              <InventoryStructuredSearch
                v-else
                compact
                :model-value="bindProductStructuredFilters"
                @update:model-value="Object.assign(bindProductStructuredFilters, $event)"
              />
              <div class="order-inventory-result-meta">
                <span>库存商品 {{ inventoryProductTotal }}</span>
                <span>命中 {{ filteredInventoryProducts.length }}</span>
              </div>
            <el-table
              :data="pagedInventoryProducts"
              height="100%"
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
                  <div v-if="inventoryProductSkuPreviews(row).length" class="inventory-sku-preview-list">
                    <div v-for="item in inventoryProductSkuPreviews(row)" :key="item.id || `${item.shop_id}-${item.ozon_sku}`" class="inventory-sku-preview-item">
                      <el-image
                        v-if="inventoryProductSkuImage(item)"
                        :src="inventoryProductSkuImage(item)"
                        fit="cover"
                        class="inventory-sku-preview-thumb"
                        :preview-src-list="[inventoryProductSkuImage(item)]"
                        preview-teleported
                        @click.stop
                      />
                      <div v-else class="inventory-sku-preview-thumb inventory-sku-preview-empty">SKU</div>
                      <div class="inventory-sku-preview-meta">
                        <strong>{{ item.ozon_sku || item.offer_id || "-" }}</strong>
                        <span>{{ item.shop_name || item.online_name || "已绑定在线商品" }}</span>
                      </div>
                    </div>
                    <span v-if="Number(row.sku_preview_extra || 0) > 0" class="inventory-sku-preview-more">
                      另有 {{ row.sku_preview_extra }} 个 SKU
                    </span>
                  </div>
                  <span v-else class="inventory-picker-table-text">{{ inventoryProductSkuText(row) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="基础信息" min-width="190">
                <template #default="{ row }">
                  <div class="inventory-picker-basic-cell">
                    <span v-for="line in inventoryProductBasicLines(row)" :key="line">{{ line }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="负责人" width="120">
                <template #default="{ row }">{{ inventoryProductOwner(row) }}</template>
              </el-table-column>
              <el-table-column label="操作" width="120" fixed="right">
                <template #default="{ row }">
                  <el-button
                    class="erp-btn-link"
                    link
                    type="primary"
                    :loading="inventoryProductEditorLoadingId === Number(row.id)"
                    @click.stop="openInventoryProductEditor(row)"
                  >
                    编辑
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
            <PageFooterPagination
              compact
               page-size-label="每页"
              :total="filteredInventoryProducts.length"
              :page="inventoryListPage"
              :page-size="inventoryListPageSize"
              @update:page="inventoryListPage = $event"
              @update:pageSize="inventoryListPageSize = $event"
            />
            </div>
            <div v-else class="inventory-combo-binding-panel">
              <el-alert
                type="info"
                :closable="false"
                title="组合方案挂在当前店铺 SKU 上，真正库存只来自下面的组成商品。"
              />
              <el-select
                v-model="bindForm.componentSelectId"
                filterable
                remote
                clearable
                reserve-keyword
                :remote-method="searchBindRecipeProducts"
                :loading="bindRecipeLoading"
                placeholder="搜索已有库存商品作为组成部分"
                style="width: 100%"
                @change="addBindRecipeItem"
              >
                <el-option
                  v-for="item in bindRecipeOptions"
                  :key="item.id"
                  :label="`${item.name} / ${item.inventory_id || item.code || item.id}`"
                  :value="item.id"
                />
              </el-select>
              <el-table
                :data="bindForm.recipeItems"
                border
                stripe
                class="inventory-picker-table inventory-combo-table"
                empty-text="还没有组成商品，请搜索后加入"
              >
                <el-table-column label="组成商品" min-width="300">
                  <template #default="{ row }">
                    <div class="inventory-recipe-product">
                      <el-image
                        v-if="recipeItemImage(row)"
                        :src="recipeItemImage(row)"
                        fit="contain"
                        class="inventory-recipe-thumb"
                        :preview-src-list="[recipeItemImage(row)]"
                        preview-teleported
                      />
                      <div v-else class="inventory-recipe-thumb inventory-recipe-thumb-empty">库存</div>
                      <div class="inventory-recipe-meta">
                        <strong>{{ recipeItemLabel(row) }}</strong>
                        <span>{{ recipeItemCode(row) }}</span>
                      </div>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column label="本地库存" width="120" align="right">
                  <template #default="{ row }">{{ Number(row.local_stock || 0) }} {{ row.stock_unit || "个" }}</template>
                </el-table-column>
                <el-table-column label="单件用量" width="190">
                  <template #default="{ row }">
                    <div class="create-composition-qty">
                      <el-input-number v-model="row.quantity" :min="0.0001" :precision="4" :step="1" controls-position="right" />
                      <span>{{ row.stock_unit || "个" }}</span>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column label="本地可组" width="110" align="right">
                  <template #default="{ row }">{{ recipeItemAvailable(row) }}</template>
                </el-table-column>
                <el-table-column label="操作" width="90" align="center">
                  <template #default="{ row }">
                    <el-button link type="danger" @click="removeBindRecipeItem(row.product_id)">删除</el-button>
                  </template>
                </el-table-column>
              </el-table>
              <div class="inventory-recipe-summary">
                <span>当前 SKU 本地可发</span>
                <strong>{{ bindRecipeAvailable ?? "-" }}</strong>
              </div>
            </div>
          </div>

        </div>

        <div v-else class="order-inventory-dialog-right">
          <div class="create-workbench">
            <div class="dialog-search-head create-workbench-head">
              <strong>创建库存工作台</strong>
              <span>{{ createProductStructureLabel }} · SKU {{ inventoryDialog.sku || "-" }}</span>
            </div>

            <section class="create-similar-panel" v-loading="createSimilarProductsLoading">
              <div class="create-section-title">
                <strong>已有相似库存</strong>
                <span>名称输入后自动检索，确认是同一商品可直接绑定，避免重复建品。</span>
              </div>
              <div v-if="createSimilarProducts.length" class="create-similar-list">
                <article v-for="row in createSimilarProducts" :key="row.id" class="create-similar-card">
                  <el-image
                    v-if="inventoryProductImage(row)"
                    :src="inventoryProductImage(row)"
                    fit="contain"
                    class="inventory-recipe-thumb"
                    :preview-src-list="[inventoryProductImage(row)]"
                    preview-teleported
                  />
                  <div v-else class="inventory-recipe-thumb inventory-recipe-thumb-empty">库存</div>
                  <div class="create-similar-card__body">
                    <div class="create-similar-card__title">
                      <el-tag :type="row.similarity.level === 'duplicate' ? 'danger' : 'warning'" size="small" effect="light">
                        {{ row.similarity.levelLabel }} {{ row.similarity.score }}分
                      </el-tag>
                      <strong>{{ row.name }}</strong>
                    </div>
                    <span>{{ inventoryProductCode(row) }} · 库存 {{ inventoryProductLocalStock(row) }} {{ row.stock_unit || "个" }}</span>
                    <div>
                      <el-tag v-for="reason in row.similarity.matches" :key="reason" size="small" type="success" effect="light">{{ reason }}相同</el-tag>
                    </div>
                    <span v-if="row.similarity.differences.length">差异：{{ row.similarity.differences.join("、") }}</span>
                  </div>
                  <el-button type="primary" plain :loading="inventoryDialog.submitting" @click="bindExistingProductDuringCreate(row)">直接绑定</el-button>
                </article>
              </div>
              <el-empty v-else :description="createForm.name ? '暂未发现相似库存' : '输入商品名称后开始检索'" :image-size="58" />
            </section>

            <el-form label-position="top" class="order-inventory-form create-inventory-form">
              <div class="create-form-section create-product-section">
                <div class="create-section-title">
                  <strong>库存商品</strong>
                  <span>{{ createProductStructureLabel }}</span>
                </div>
                <div class="create-grid create-grid--product">
                  <el-form-item label="商品名称">
                    <el-input v-model="createForm.name" placeholder="请输入库存商品名称" />
                  </el-form-item>
                  <el-form-item label="库存单位">
                    <el-select v-model="createForm.stockUnit" filterable allow-create default-first-option style="width: 100%">
                      <el-option v-for="unit in ['个', '件', '套', '对', '双', '条', '米', '卷', '包', '片']" :key="unit" :label="unit" :value="unit" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="产品属性">
                    <div class="create-type-row">
                      <el-checkbox v-model="createForm.isAccessory" :true-label="1" :false-label="0">配件产品</el-checkbox>
                    </div>
                  </el-form-item>
                  <el-form-item label="采购链接" class="create-grid-span-2">
                    <el-input v-model="createForm.purchaseUrl" clearable placeholder="可填写 1688、供应商或其他采购链接" />
                  </el-form-item>
                  <el-form-item label="备注" class="create-grid-span-2">
                    <el-input v-model="createForm.note" type="textarea" :rows="2" placeholder="记录产品材质、适配车型、采购说明等" />
                  </el-form-item>
                </div>
              </div>

              <div class="create-form-section create-composition-launcher">
                <div class="create-section-title">
                  <strong>产品组成</strong>
                  <span>{{ createForm.compositionItems.length ? `已添加 ${createForm.compositionItems.length} 个子产品` : "基础信息保存后再添加" }}</span>
                </div>
                <el-button class="erp-btn erp-btn-secondary" :disabled="!createdInventoryProductId" @click="createCompositionDialogVisible = true">
                  {{ createForm.compositionItems.length ? "编辑子产品" : "添加子产品" }}
                </el-button>
              </div>

              <el-dialog
                v-model="createCompositionDialogVisible"
                title="添加子产品"
                width="86vw"
                append-to-body
                destroy-on-close
                class="erp-centered-dialog create-composition-modal"
              >
              <div class="create-form-section create-composition-section">
                <div class="create-section-title">
                  <strong>产品组成</strong>
                  <span>{{ createForm.structureType === "kit" ? (createForm.compositionItems.length ? `本地可组 ${createProductAvailableLabel}` : "等待添加组成") : "单品库存" }}</span>
                </div>
                <div class="create-composition-box">
                  <div class="create-composition-toolbar">
                    <el-segmented
                      v-model="createComponentCategory"
                      :options="createComponentCategoryOptions"
                      @change="changeCreateComponentCategory"
                    />
                    <el-input
                      v-model="createForm.componentQuery"
                      clearable
                      placeholder="搜索商品名称、库存编码、SKU 或负责人"
                      @input="searchCreateComponentProducts"
                      @clear="searchCreateComponentProducts('')"
                    />
                    <div class="order-inventory-result-meta">
                      <span>商品 {{ createComponentProductTotal }}</span>
                      <span>已加入 {{ createForm.compositionItems.length }}</span>
                    </div>
                  </div>
                  <el-table
                    v-loading="createComponentLoading"
                    :data="createComponentOptions"
                    border
                    stripe
                    height="420"
                    class="inventory-picker-table create-composition-search-table"
                    empty-text="没有匹配到库存商品"
                  >
                    <el-table-column label="库存商品" min-width="320">
                      <template #default="{ row }">
                        <div class="inventory-recipe-product">
                          <el-image
                            v-if="inventoryProductImage(row)"
                            :src="inventoryProductImage(row)"
                            fit="contain"
                            class="inventory-recipe-thumb"
                            :preview-src-list="[inventoryProductImage(row)]"
                            preview-teleported
                          />
                          <div v-else class="inventory-recipe-thumb inventory-recipe-thumb-empty">库存</div>
                          <div class="inventory-recipe-meta">
                            <strong>{{ inventoryProductLabel(row) }}</strong>
                            <span>{{ inventoryProductCode(row) }}</span>
                          </div>
                        </div>
                      </template>
                    </el-table-column>
                    <el-table-column label="分类" width="86">
                      <template #default="{ row }">{{ inventoryProductCategoryText(row) }}</template>
                    </el-table-column>
                    <el-table-column label="SKU" min-width="180">
                      <template #default="{ row }">
                        <span class="inventory-picker-table-text">{{ inventoryProductSkuText(row) }}</span>
                      </template>
                    </el-table-column>
                    <el-table-column label="明细" min-width="230">
                      <template #default="{ row }">
                        <div class="inventory-picker-basic-cell">
                          <span v-for="line in inventoryProductBasicLines(row)" :key="line">{{ line }}</span>
                          <span>本地库存 {{ inventoryProductLocalStock(row) }} {{ row.stock_unit || "个" }}</span>
                        </div>
                      </template>
                    </el-table-column>
                    <el-table-column label="" width="64" align="center" fixed="right">
                      <template #default="{ row }">
                        <el-button
                          circle
                          type="primary"
                          :icon="Plus"
                          :disabled="createCompositionItemSelected(row.id)"
                          @click="addCreateCompositionItem(row.id)"
                        />
                      </template>
                    </el-table-column>
                  </el-table>
                  <PageFooterPagination
                    compact
                    page-size-label="每页"
                    :total="createComponentProductTotal"
                    :page="createComponentListPage"
                    :page-size="createComponentListPageSize"
                    @update:page="handleCreateComponentPageChange"
                    @update:pageSize="handleCreateComponentPageSizeChange"
                  />
                  <el-table
                    :data="createForm.compositionItems"
                    border
                    stripe
                    class="inventory-picker-table create-composition-table"
                    empty-text="未添加组成商品，当前按单品库存创建"
                  >
                    <el-table-column label="已加入组成" min-width="300">
                      <template #default="{ row }">
                        <div class="inventory-recipe-product">
                          <el-image
                            v-if="recipeItemImage(row)"
                            :src="recipeItemImage(row)"
                            fit="contain"
                            class="inventory-recipe-thumb"
                            :preview-src-list="[recipeItemImage(row)]"
                            preview-teleported
                          />
                          <div v-else class="inventory-recipe-thumb inventory-recipe-thumb-empty">库存</div>
                          <div class="inventory-recipe-meta">
                            <strong>{{ recipeItemLabel(row) }}</strong>
                            <span>{{ recipeItemCode(row) }}</span>
                          </div>
                        </div>
                      </template>
                    </el-table-column>
                    <el-table-column label="本地库存" width="120" align="right">
                      <template #default="{ row }">{{ Number(row.local_stock || 0) }} {{ row.stock_unit || "个" }}</template>
                    </el-table-column>
                    <el-table-column label="单件用量" width="190">
                      <template #default="{ row }">
                        <div class="create-composition-qty">
                          <el-input-number v-model="row.quantity" :min="0.0001" :precision="4" :step="1" controls-position="right" />
                          <span>{{ row.stock_unit || "个" }}</span>
                        </div>
                      </template>
                    </el-table-column>
                    <el-table-column label="本地可组" width="110" align="right">
                      <template #default="{ row }">{{ recipeItemAvailable(row) }}</template>
                    </el-table-column>
                    <el-table-column label="操作" width="72" align="center">
                      <template #default="{ row }">
                        <el-button link type="danger" :icon="Delete" @click="removeCreateCompositionItem(row.product_id)" />
                      </template>
                    </el-table-column>
                  </el-table>
                </div>
              </div>
              <template #footer>
                <div class="create-composition-dialog-footer">
                  <span>已选择 {{ createForm.compositionItems.length }} 个子产品</span>
                  <el-button type="primary" @click="createCompositionDialogVisible = false">
                    确认选择
                  </el-button>
                </div>
              </template>
              </el-dialog>

              <div class="create-form-section">
                <div class="create-section-title">
                  <strong>采购信息</strong>
                  <span>{{ supplierName(createForm.supplierId) || "未指定供应商" }}</span>
                </div>
                <div class="create-grid create-grid--purchase">
                  <el-form-item label="来源">
                    <el-select v-model="createForm.sourcePlatform" style="width: 100%">
                      <el-option label="1688" value="1688" />
                      <el-option label="淘宝" value="taobao" />
                      <el-option label="拼多多" value="pdd" />
                      <el-option label="手工采购" value="manual" />
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
                  <el-form-item label="采购人">
                    <el-select v-model="createForm.personId" clearable filterable placeholder="请选择采购人" style="width: 100%">
                      <el-option
                        v-for="person in inventoryOptions.people"
                        :key="person.id"
                        :label="person.name"
                        :value="String(person.id)"
                      />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="采购金额">
                    <el-input-number v-model="createForm.amount" :min="0" :precision="2" :step="1" controls-position="right" style="width: 100%" />
                  </el-form-item>
                  <el-form-item label="采购数量">
                    <el-input-number v-model="createForm.quantity" :min="1" :step="1" controls-position="right" style="width: 100%" />
                  </el-form-item>
                  <el-form-item label="国内运费">
                    <el-input-number v-model="createForm.shippingAmount" :min="0" :precision="2" :step="1" controls-position="right" style="width: 100%" />
                  </el-form-item>
                </div>
              </div>
              <div class="create-form-section">
                <div class="create-section-title">
                  <strong>物流信息</strong>
                  <span>计费克重 {{ createChargeableWeightG }}g</span>
                </div>
                <div class="create-grid create-grid--logistics">
                  <el-form-item label="长宽高(cm)">
                    <div class="create-dimension-combo">
                      <el-input-number v-model="createForm.lengthCm" :min="0" :precision="0" :step="1" controls-position="right" />
                      <span>*</span>
                      <el-input-number v-model="createForm.widthCm" :min="0" :precision="0" :step="1" controls-position="right" />
                      <span>*</span>
                      <el-input-number v-model="createForm.heightCm" :min="0" :precision="0" :step="1" controls-position="right" />
                      <em>cm</em>
                    </div>
                  </el-form-item>
                  <el-form-item label="克重(g)">
                    <el-input-number v-model="createForm.packageWeightG" :min="0" :precision="0" :step="1" controls-position="right" style="width: 100%" />
                  </el-form-item>
                  <el-form-item label="物流方式">
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
            <strong>
              {{
                bindForm.mode === "combo"
                  ? `组合方案 / ${bindForm.recipeItems.length} 个组成 / 本地可发 ${bindRecipeAvailable ?? "-"}`
                  : (selectedInventoryProduct ? `${inventoryProductLabel(selectedInventoryProduct)} / ${inventoryProductTypeText(selectedInventoryProduct)}` : "请选择库存商品")
              }}
            </strong>
          </div>
        </div>
      </div>

      <template #footer>
        <el-button @click="resetInventoryDialog">取消</el-button>
        <el-button type="primary" :loading="inventoryDialog.submitting" @click="submitInventoryDialog">
          {{ inventoryDialog.mode === "bind" ? "确认绑定" : (createdInventoryProductId ? "保存子产品" : "创建基础库存") }}
        </el-button>
      </template>
    </el-dialog>

    <ProductCreateEditDialog
      v-model:visible="inventoryProductEditorVisible"
      :mode="inventoryProductEditorMode"
      target="inventory"
      :people="inventoryOptions.people"
      :suppliers="inventoryOptions.suppliers"
      :logistics-rules="inventoryOptions.logisticsRules"
      :value="inventoryProductEditorValue"
      :create-endpoint="inventoryProductEditorCreateContext ? '/api/online-products/create-product' : '/api/products'"
      :create-context="inventoryProductEditorCreateContext || {}"
      @saved="handleInventoryProductEditorSaved"
      @existing-selected="handleInventoryProductEditorExistingSelected"
      @manage-components="(product) => openProductCompositionDialog(product.id)"
    />

    <ProductCompositionDialog
      v-model:visible="compositionDialogVisible"
      :product="compositionDialogProduct"
      :refresh-key="compositionDialogRefreshKey"
      :read-only="compositionDialogReadOnly"
      @saved="handleProductCompositionSaved"
      @quick-create="openQuickCreateFromComposition"
    />

    <el-dialog
      v-model="orderProcurementDialog.visible"
      title="采购处理确认"
      width="min(1480px, 96vw)"
      align-center
      class="erp-centered-dialog order-procurement-dialog"
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
            <div class="order-procurement-sales-panel">
              <div class="order-procurement-sales-heading">
                <div>
                  <span>智能采购建议</span>
                  <strong>建议采购 {{ product.suggested_purchase_qty || 0 }} 件</strong>
                </div>
                <div class="order-procurement-sales-tags">
                  <el-tag :type="procurementTrendType(product)" effect="light">
                    {{ product.sales_trend_text || "暂无趋势" }}
                  </el-tag>
                  <el-tag :type="procurementModeType(product)" effect="dark">
                    {{ product.purchase_mode_text || "按单采购" }}
                  </el-tag>
                </div>
              </div>
              <div class="order-procurement-decision-row">
                <p>{{ product.purchase_reason }}</p>
                <div class="order-procurement-signal-list">
                  <span>近7天 <strong>{{ product.recent_7d_qty || 0 }}</strong></span>
                  <span>近30天 <strong>{{ product.recent_30d_qty || 0 }}</strong></span>
                  <span>三周 <strong>{{ product.week3_qty || 0 }} → {{ product.week2_qty || 0 }} → {{ product.week1_qty || 0 }}</strong></span>
                  <span>库存覆盖 <strong>{{ procurementCoverageText(product) }}</strong></span>
                  <span>订单缺口 <strong>{{ product.shortage_quantity || 0 }}</strong></span>
                  <span v-if="Number(product.extra_stock_qty || 0) > 0">其中备货 <strong>{{ product.extra_stock_qty }}</strong></span>
                </div>
              </div>
              <div class="order-procurement-quantity-actions">
                <span>采购数量由你确认，系统不会自动扩大订单采购量。</span>
                <el-button size="small" plain @click="applyProcurementQuantity(product, 'shortage')">
                  按订单缺口 {{ product.shortage_quantity || 0 }}
                </el-button>
                <el-button
                  size="small"
                  type="primary"
                  plain
                  @click="applyProcurementQuantity(product, 'suggested')"
                >
                  采用建议 {{ product.suggested_purchase_qty || 0 }}
                </el-button>
              </div>
            </div>
            <div class="order-procurement-cost-panel">
              <div class="order-procurement-cost-heading">
                <div>
                  <span>采购成本校验</span>
                  <div class="order-procurement-cost-summary">
                    <strong>本次 ¥{{ formatMoney(procurementCurrentUnitCost(product)) }}/件</strong>
                    <span>渠道 {{ procurementChannelLabel(product.purchase_source_type) }}</span>
                    <span v-if="procurementPreviousUnitCost(product)">上批 ¥{{ formatMoney(procurementPreviousUnitCost(product)) }}</span>
                    <span v-if="procurementCostHistorySummary(product)">近{{ procurementCostHistorySummary(product).count }}批均价 ¥{{ formatMoney(procurementCostHistorySummary(product).weighted) }}</span>
                    <span v-if="procurementCostHistorySummary(product)">区间 ¥{{ formatMoney(procurementCostHistorySummary(product).min) }}–{{ formatMoney(procurementCostHistorySummary(product).max) }}</span>
                  </div>
                </div>
                <div class="order-procurement-cost-actions">
                  <el-tag :type="procurementCostTrendType(product)" effect="light">
                    {{ procurementCostVarianceText(product) }}
                  </el-tag>
                  <el-popover v-if="product.cost_history?.length" placement="bottom-end" :width="480" trigger="click">
                    <template #reference>
                      <el-button size="small" plain>查看历史 {{ product.cost_history.length }} 批</el-button>
                    </template>
                    <div class="order-procurement-cost-popover">
                      <strong>历史采购成本</strong>
                      <div v-for="history in product.cost_history" :key="`${history.batch_no}-${history.recorded_at}`">
                        <span>{{ procurementCostHistoryDate(history.recorded_at) }}</span>
                        <strong>¥{{ formatMoney(history.unit_cost) }}/件</strong>
                        <span>{{ procurementChannelLabel(history.source_type) }}</span>
                        <span>{{ history.quantity }} 件 · ¥{{ formatMoney(history.amount) }}</span>
                        <span>{{ history.supplier_name || history.batch_no || "历史采购" }}</span>
                      </div>
                    </div>
                  </el-popover>
                </div>
              </div>
              <p v-if="procurementCostVariance(product)?.abnormal" class="order-procurement-cost-warning">
                本次单价波动较大，请核对采购数量和货款后再生成。
              </p>
              <p v-else-if="!product.cost_history?.length" class="order-procurement-cost-empty">
                暂无已确认历史，本次将作为首个参考价格。
              </p>
            </div>
            <div class="order-procurement-purchase-form">
              <div class="order-procurement-form-section">
                <span class="order-procurement-form-title">采购决策</span>
                <div class="order-procurement-form-grid order-procurement-form-grid-compact">
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
                  <el-form-item label="紧急程度">
                    <el-segmented v-model="product.purchase_urgency" :options="procurementUrgencyOptions" />
                  </el-form-item>
                </div>
              </div>
              <div class="order-procurement-form-section">
                <span class="order-procurement-form-title">来源备注</span>
                <div class="order-procurement-form-grid">
                  <el-form-item label="采购来源">
                    <el-select v-model="product.purchase_source_type" style="width: 100%">
                      <el-option
                        v-for="option in procurementSourceOptions"
                        :key="option.value"
                        :label="option.label"
                        :value="option.value"
                      />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="采购链接" class="order-procurement-form-span-2">
                    <el-input v-model="product.purchase_url" placeholder="https://detail.1688.com/..." clearable />
                  </el-form-item>
                  <el-form-item label="采购备注" class="order-procurement-form-span-3">
                    <el-input
                      v-model="product.purchase_note"
                      type="textarea"
                      :rows="2"
                      placeholder="颜色、规格、供应商沟通、采购注意事项"
                    />
                  </el-form-item>
                </div>
              </div>
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
                  :disabled="row.already_handled"
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
                <el-tag
                  :type="row.already_handled || Number(row.product?.current_stock || 0) >= Number(row.product?.total_quantity || 0) ? 'success' : 'warning'"
                  effect="light"
                >
                  {{ row.already_handled ? "已采购处理" : Number(row.product?.current_stock || 0) >= Number(row.product?.total_quantity || 0) ? "库存可满足" : "生成采购建议" }}
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
