<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { createLatestRequestGate } from "../../utils/request-gate";
import { createDefaultRouteQuerySync } from "../../utils/route-query-sync.js";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import ProductTitleLink from "../../components/ProductTitleLink.vue";
import InventoryPageToolbar from "../../components/inventory/InventoryPageToolbar.vue";
import ProductCreateEditDialog from "../../components/inventory/ProductCreateEditDialog.vue";
import ProcurementRequestCreateDialog from "../../components/procurement/ProcurementRequestCreateDialog.vue";
import {
  applyFilterQuery,
  dateText,
  integer,
  money,
  percent
} from "./inventory-utils.js";

const route = useRoute();
const router = useRouter();
let syncingRoute = false;
let dictionaryLoaded = false;
const listRequestGate = createLatestRequestGate();

const loading = ref(false);
const detailLoading = ref(false);
const dialogVisible = ref(false);
const detailDialogVisible = ref(false);
const detailDialogTitle = ref("");
const detailRows = ref([]);
const profitDetailLoading = ref(false);
const profitDetailDialogVisible = ref(false);
const profitDetailDialogTitle = ref("");
const profitDetailRows = ref([]);
const profitDetailPreferredMode = ref("estimated");
const profitPreviewDialogVisible = ref(false);
const profitPreviewDialogTitle = ref("");
const profitPreviewRows = ref([]);
const profitPreviewSummary = ref(null);
const procurementCreateVisible = ref(false);
const procurementCreateProductId = ref(null);
const productSalesDialogVisible = ref(false);
const productSalesDialogTitle = ref("");
const productSalesLoading = ref(false);
const productSalesRows = ref([]);
const productSalesTotal = ref(0);
const productSalesCurrentProduct = ref(null);
const productProcurementDialogVisible = ref(false);
const productProcurementDialogTitle = ref("");
const productProcurementLoading = ref(false);
const productProcurementSaving = ref(false);
const productProcurementRows = ref([]);
const productProcurementTotal = ref(0);
const productProcurementCurrentProduct = ref(null);
const profitDetailCurrentProduct = ref(null);
const dialogProduct = ref(null);
const selectedRows = ref([]);

const detailPageDefaults = {
  page: 1,
  pageSize: 20
};
const productSalesPager = reactive({ ...detailPageDefaults });
const productProcurementPager = reactive({ ...detailPageDefaults });
const profitDetailPager = reactive({ ...detailPageDefaults });
const profitDetailTotal = ref(0);
const productSalesFilters = reactive({
  query: "",
  shopId: "all",
  dateFrom: "",
  dateTo: ""
});
const productProcurementFilters = reactive({
  query: "",
  personId: "all",
  dateFrom: "",
  dateTo: ""
});
const profitDetailFilters = reactive({
  query: "",
  shopId: "all",
  dateFrom: "",
  dateTo: ""
});

const mergeDialogVisible = ref(false);
const mergePreviewLoading = ref(false);
const mergeSubmitting = ref(false);

const mergeHistoryDialogVisible = ref(false);
const mergeHistoryLoading = ref(false);
const mergeHistoryRows = ref([]);
const mergeUndoingId = ref(0);

const mergePreview = reactive({
  products: [],
  conflicts: [],
  affectedCounts: {},
  moveCountsSummary: {},
  targetProductId: null,
  fieldSources: {}
});

const state = reactive({
  products: [],
  total: 0,
  people: [],
  suppliers: [],
  logisticsRules: [],
  shops: [],
  filters: {
    query: "",
    shopId: "all",
    dateFrom: "",
    dateTo: "",
    page: 1,
    pageSize: 20,
    sortKey: "",
    sortDir: ""
  }
});

const filterDefaults = {
  query: "",
  shopId: "all",
  dateFrom: "",
  dateTo: "",
  page: 1,
  pageSize: 20,
  sortKey: "",
  sortDir: ""
};

const mergeFieldLabelMap = {
  name: "产品名称",
  selection_id: "选品编号",
  code: "库存编码",
  image_url: "产品图片",
  purchase_url: "采购链接",
  supplier_note: "备注",
  source_platform: "货源平台",
  supplier_id: "供应商",
  shipping_method: "物流方式",
  logistics_rule_id: "物流规则",
  purchase_cost: "采购成本",
  domestic_shipping: "国内运费",
  handling_fee: "包装/处理费",
  purchase_quantity: "采购数量",
  package_weight_g: "重量(g)",
  length_cm: "长(cm)",
  width_cm: "宽(cm)",
  height_cm: "高(cm)",
  sale_price_rmb: "售价(RMB)",
  listing_price_rub: "上架价(RUB)",
  air_sale_price_rmb: "空运售价(RMB)",
  exchange_rate: "汇率",
  target_margin: "目标利润率",
  desired_profit_mode: "利润模式",
  desired_profit_value: "目标利润值",
  advertising_rate: "广告费率",
  return_rate: "退货率",
  owner_person_id: "负责人",
  created_by_person_id: "创建人"
};

const pagedRows = computed(() => state.products);
const inventoryTotalPages = computed(() => Math.max(1, Math.ceil(Number(state.total || 0) / Math.max(1, Number(state.filters.pageSize || 1)))));
const inventoryFooterSummary = computed(() => `第 ${Number(state.filters.page || 1)} / ${inventoryTotalPages.value} 页，共 ${integer(state.total)} 条记录`);
const canMergeProducts = computed(() => selectedRows.value.length >= 2);
const mergeCountRows = computed(() => {
  const summary = mergePreview.moveCountsSummary || {};
  return Object.entries(summary)
    .map(([key, item]) => ({
      key,
      label: item?.label || key,
      total: Number(item?.total || 0)
    }))
    .filter((item) => item.total > 0);
});
const mergeConflictMap = computed(() => new Map((mergePreview.conflicts || []).map((field) => [field.key, field])));
const mergeFieldKeys = computed(() => {
  const conflictKeys = (mergePreview.conflicts || []).map((field) => field.key);
  if (conflictKeys.length) return conflictKeys;
  return Object.keys(mergePreview.fieldSources || {});
});
const mergeDialogColumns = computed(() => {
  const count = Math.max(mergePreview.products.length, 1);
  return `repeat(${count}, minmax(0, 1fr))`;
});
const profitDetailSummary = computed(() => {
  const rows = Array.isArray(profitDetailRows.value) ? profitDetailRows.value : [];
  return rows.reduce((summary, row) => {
    summary.orderCount += 1;
    summary.revenue += profitDetailRevenue(row);
    summary.currentProfit += profitDetailCurrentProfit(row);
    summary.actualProfit += profitDetailActualProfit(row);
    return summary;
  }, {
    orderCount: 0,
    revenue: 0,
    currentProfit: 0,
    actualProfit: 0
  });
});
const productSalesSummary = computed(() => productSalesRows.value.reduce((summary, row) => {
  summary.quantity += Number(row.quantity || 0);
  summary.amount += Number(row.order_amount || 0);
  summary.profit += Number(row.actual_profit || row.estimated_profit || 0);
  return summary;
}, { quantity: 0, amount: 0, profit: 0 }));
const productProcurementSummary = computed(() => productProcurementRows.value.reduce((summary, row) => {
  summary.quantity += Number(row.quantity || 0);
  summary.amount += Number(row.amount || 0) + Number(row.shipping_amount || 0);
  return summary;
}, { quantity: 0, amount: 0 }));

const INVENTORY_PROFIT_TARGET_MARGIN = 0.2;

function toFilterDateValue(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const matched = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
    if (matched) return matched[1];
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? trimmed.slice(0, 10) : parsed.toISOString().slice(0, 10);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  }
  if (typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
  }
  if (typeof value === "object" && typeof value?.toDate === "function") {
    const parsed = value.toDate();
    return parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : "";
  }
  return "";
}

function mappingPrimaryText(mapping) {
  return mapping.ozon_sku || mapping.offer_id || mapping.online_name || "-";
}

function mappingPreviewText(mapping) {
  const primary = mappingPrimaryText(mapping);
  return mapping.shop_name ? `${mapping.shop_name} / ${primary}` : primary;
}

function mergeProductName(product = {}) {
  return product.name || `产品 ${product.id}`;
}

function mergeProductCode(product = {}) {
  return product.inventory_id || product.code || `ID ${product.id}`;
}

function mergeFieldForProduct(fieldKey, productId) {
  return mergeConflictMap.value.get(fieldKey)?.options?.find((item) => Number(item.sourceId) === Number(productId)) || null;
}

function mergeFieldDisplay(fieldKey, productId) {
  const option = mergeFieldForProduct(fieldKey, productId);
  return option?.displayValue || "未设置";
}

function mergeFieldSelected(fieldKey, productId) {
  return Number(mergePreview.fieldSources?.[fieldKey] || 0) === Number(productId);
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function positiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function inventoryProfitPercentText(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function resolvedReturnRate(row) {
  const value = Number(row?.return_rate ?? 0.05);
  return value > 1 ? value / 100 : value;
}

function resolvedAdvertisingRate(row) {
  const value = Number(row?.advertising_rate || 0);
  return value > 1 ? value / 100 : value;
}

function getInventorySalePrice(row) {
  return positiveNumber(row?.avg_sale_price);
}

function getInventoryPurchaseCost(row) {
  return positiveNumber(row?.avg_unit_cost);
}

function getInventoryListingPriceRub(row, salePrice = getInventorySalePrice(row)) {
  const listed = positiveNumber(row?.listing_price_rub);
  if (listed) return listed;
  const exchangeRate = positiveNumber(row?.exchange_rate) || 11.32;
  return roundMoney(salePrice * exchangeRate);
}

function getInventoryCommissionRate(listingPriceRub) {
  return Number(listingPriceRub || 0) <= 1500 ? 0.12 : 0.17;
}

function resolveInventoryProfitLogisticsRule(row) {
  if (!row) return null;
  if (row.logistics_rule_id) {
    const directMatch = state.logisticsRules.find((item) => Number(item.id) === Number(row.logistics_rule_id));
    if (directMatch) return directMatch;
  }
  const weight = positiveNumber(row.package_weight_g);
  const listingPriceRub = getInventoryListingPriceRub(row);
  if (!weight || !listingPriceRub) return null;
  return state.logisticsRules.find((rule) => {
    const minWeight = Number(rule.min_weight_g || 0);
    const maxWeight = Number(rule.max_weight_g || Number.POSITIVE_INFINITY);
    const minPrice = Number(rule.min_price_rub || 0);
    const maxPrice = Number(rule.max_price_rub || Number.POSITIVE_INFINITY);
    return weight >= minWeight && weight <= maxWeight && listingPriceRub >= minPrice && listingPriceRub <= maxPrice;
  }) || null;
}

function getInventoryTransportEstimate(row, logisticsRule) {
  if (!logisticsRule) return { totalRmb: 0, valid: false };
  const weight = positiveNumber(row?.package_weight_g);
  const totalRmb = roundMoney(
    Number(logisticsRule.base_fee_cny || 0) +
    weight * Number(logisticsRule.per_gram_cny || 0) +
    Number(logisticsRule.per_ticket_cny || 0)
  );
  return {
    totalRmb,
    valid: totalRmb > 0 || Boolean(weight) || Boolean(logisticsRule.per_ticket_cny || logisticsRule.base_fee_cny)
  };
}

function buildInventoryProfitPreview(row) {
  const salePrice = getInventorySalePrice(row);
  const purchaseCost = getInventoryPurchaseCost(row);
  if (!salePrice || !purchaseCost) {
    return {
      valid: false,
      reason: !salePrice ? "缺件均售价" : "缺平均采购成本"
    };
  }
  const logisticsRule = resolveInventoryProfitLogisticsRule(row);
  if (!logisticsRule) {
    return {
      valid: false,
      reason: "缺物流规则"
    };
  }
  const transport = getInventoryTransportEstimate(row, logisticsRule);
  const listingPriceRub = getInventoryListingPriceRub(row, salePrice);
  const commissionRate = getInventoryCommissionRate(listingPriceRub);
  const advertisingRate = resolvedAdvertisingRate(row);
  const returnRate = resolvedReturnRate(row);
  const withdrawalRate = Number(row?.withdrawal_fee_rate ?? 0.012);
  const finalMile = roundMoney(salePrice * 0.014 + (salePrice < 50 ? 1 : salePrice >= 750 ? 15 : salePrice * 0.02));
  const commission = roundMoney(salePrice * commissionRate);
  const withdrawal = roundMoney(Math.max(0, salePrice - finalMile - transport.totalRmb - salePrice * 0.2) * withdrawalRate);
  const advertising = roundMoney(salePrice * advertisingRate);
  const returnLoss = roundMoney((purchaseCost + transport.totalRmb) * returnRate);
  const totalCost = roundMoney(purchaseCost + transport.totalRmb + commission + finalMile + withdrawal + advertising + returnLoss);
  const profit = roundMoney(salePrice - totalCost);
  const margin = salePrice > 0 ? profit / salePrice : 0;
  const suggestedSaleRmb = roundMoney(
    ((purchaseCost + transport.totalRmb + returnLoss) || 0) /
    Math.max(0.01, 1 - commissionRate - advertisingRate - returnRate - withdrawalRate - 0.014 - INVENTORY_PROFIT_TARGET_MARGIN)
  );
  return {
    valid: true,
    logisticsRule,
    salePrice,
    purchaseCost,
    listingPriceRub,
    transport,
    commissionRate,
    commission,
    finalMile,
    withdrawal,
    advertising,
    returnLoss,
    totalCost,
    profit,
    margin,
    suggestedSaleRmb
  };
}

function hasInventoryProfitPreview(row) {
  return buildInventoryProfitPreview(row).valid;
}

function inventoryProfitStatusText(row) {
  const preview = buildInventoryProfitPreview(row);
  return preview.valid ? "" : (preview.reason || "暂无");
}

function inventoryProfitMarginText(row) {
  const preview = buildInventoryProfitPreview(row);
  return preview.valid ? inventoryProfitPercentText(preview.margin) : "-";
}

function inventoryProfitValue(row, key) {
  const preview = buildInventoryProfitPreview(row);
  if (!preview.valid) return null;
  if (key === "transport") return Number(preview.transport?.totalRmb || 0);
  return Number(preview[key] || 0);
}

function inventoryProfitMoneyText(row, key) {
  const value = inventoryProfitValue(row, key);
  return value === null ? "-" : money(value);
}

function rowNumber(row, key) {
  return Number(row?.[key] || 0);
}

function localStock(row) {
  return rowNumber(row, "stock");
}

function fbpStock(row) {
  return rowNumber(row, "fbp_stock");
}

function fbpTransferStock(row) {
  return rowNumber(row, "fbp_transfer_in_transit_qty");
}

function fbsStock(row) {
  return rowNumber(row, "fbs_stock");
}

function totalProductStock(row) {
  return localStock(row) + fbpStock(row);
}

function stockForInventoryValue(row) {
  return Math.max(0, totalProductStock(row));
}

function productInventoryValue(row) {
  return stockForInventoryValue(row) * getInventoryPurchaseCost(row);
}

function averageOrderAmount(row) {
  const orderCount = rowNumber(row, "order_count");
  return orderCount > 0 ? rowNumber(row, "total_sales_amount") / orderCount : 0;
}

function averagePurchaseCost(row) {
  const quantity = rowNumber(row, "total_purchase_quantity");
  return quantity > 0 ? rowNumber(row, "total_purchase_amount") / quantity : getInventoryPurchaseCost(row);
}

function buildInventoryProfitDetailRows(row, preview) {
  return [
    { label: "售价", value: `¥${money(preview.salePrice)}`, note: "取当前产品历史平均售价" },
    { label: "平均采购成本", value: `¥${money(preview.purchaseCost)}`, note: "取当前产品平均采购成本" },
    {
      label: "运费",
      value: `¥${money(preview.transport.totalRmb)}`,
      note: preview.logisticsRule ? `${preview.logisticsRule.name || "-"} / ${preview.logisticsRule.carrier || "-"} / ${preview.logisticsRule.channel || "-"}` : "未命中物流规则"
    },
    { label: "Ozon 佣金", value: `¥${money(preview.commission)}`, note: `售价 x ${(preview.commissionRate * 100).toFixed(1)}%` },
    { label: "末公里+银行", value: `¥${money(preview.finalMile)}`, note: "售价 x 1.4% + 阶梯末公里费" },
    { label: "提现费", value: `¥${money(preview.withdrawal)}`, note: "(售价 - 末公里+银行 - 运费 - 售价 x 20%) x 1.2%" },
    { label: "广告费", value: `¥${money(preview.advertising)}`, note: `广告占比 ${(resolvedAdvertisingRate(row) * 100).toFixed(1)}%` },
    { label: "退货损失", value: `¥${money(preview.returnLoss)}`, note: `退货率 ${(resolvedReturnRate(row) * 100).toFixed(1)}%` },
    { label: "成本合计", value: `¥${money(preview.totalCost)}`, note: "除售价外所有扣减项合计" },
    { label: "净利润", value: `¥${money(preview.profit)}`, note: `净利率 ${inventoryProfitPercentText(preview.margin)}` }
  ];
}

function profitDetailEstimatedProfit(row) {
  return Number(row?.estimated_profit || 0);
}

function profitDetailActualProfit(row) {
  return Number(row?.actual_profit || 0);
}

function profitDetailCalculatedProfit(row) {
  const direct = Number(row?.profit_value);
  if (Number.isFinite(direct)) return direct;
  const calculated = Number(row?.calculated_profit_value);
  if (Number.isFinite(calculated)) return calculated;
  return profitDetailEstimatedProfit(row);
}

function profitDetailIsAccrued(row) {
  return String(row?.profit_model || "").toLowerCase() === "actual"
    || String(row?.settlement_state || "").toLowerCase() === "accrued";
}

function profitDetailCurrentProfit(row) {
  if (String(row?.profit_model || "").toLowerCase() === "actual") {
    const actual = profitDetailActualProfit(row);
    return actual || profitDetailCalculatedProfit(row);
  }
  return profitDetailCalculatedProfit(row);
}

function profitDetailHasCalculatedProfit(row) {
  return [
    row?.profit_value,
    row?.calculated_profit_value,
    row?.estimated_profit,
    row?.revenue,
    row?.cost_total
  ].some((value) => value !== null && value !== undefined && value !== "");
}

function profitDetailRevenue(row) {
  const revenue = Number(row?.revenue);
  if (Number.isFinite(revenue)) return revenue;
  return roundMoney(Number(row?.sale_price || 0) * Number(row?.quantity || 0));
}

function profitDetailTotalCost(row) {
  return roundMoney(
    Number(row?.cost_total || 0) +
    Number(row?.commission_total || 0) +
    Number(row?.ozon_service_fee_total || 0) +
    Number(row?.return_loss_total || 0) +
    Number(row?.advertising_cost_total || 0) +
    Number(row?.other_fee_total || 0)
  );
}

function profitDetailMargin(row) {
  const revenue = profitDetailRevenue(row);
  return revenue > 0 ? profitDetailCurrentProfit(row) / revenue : 0;
}

function profitDetailStatusText(row) {
  if (String(row?.profit_model_text || "")) return row.profit_model_text;
  if (profitDetailIsAccrued(row)) return "真实利润";
  if (profitDetailHasCalculatedProfit(row)) return "预估利润";
  return "待计算";
}

function labelFromMap(value, map, fallback = "-") {
  const key = String(value || "").trim();
  if (!key) return fallback;
  return map[key] || map[key.toLowerCase()] || key;
}

function orderStatusText(value) {
  return labelFromMap(value, {
    awaiting_packaging: "待打包",
    awaiting_deliver: "待发货",
    delivering: "配送中",
    delivered: "已签收",
    cancelled: "已取消",
    canceled: "已取消",
    return: "退货中",
    returned: "已退货",
    arbitration: "仲裁中",
    dispute: "纠纷中"
  });
}

function outboundStatusText(value) {
  return labelFromMap(value, {
    deducted: "已出库",
    cancelled: "已取消",
    pending: "待处理",
    posted: "已记账"
  });
}

function procurementStatusText(value) {
  return labelFromMap(value, {
    pending: "待处理",
    suggested: "待处理",
    submitted: "待处理",
    merged: "待处理",
    approved: "待处理",
    purchased: "待处理",
    partial_inbound: "待处理",
    inbound_done: "已完成",
    done: "已完成",
    cancelled: "已取消"
  });
}

function procurementUrgencyText(value) {
  return labelFromMap(value, {
    normal: "普通",
    urgent: "加急"
  });
}

function procurementSourceText(value) {
  return labelFromMap(value, {
    "1688": "1688",
    pdd: "拼多多",
    supplier: "供应商",
    wechat: "微信",
    other: "其他"
  });
}

function detailImage(row) {
  return row?.image_urls || row?.order_image_urls || row?.product_image_url || row?.image_url || "";
}

function profitDetailStatusTagType(row) {
  if (profitDetailIsAccrued(row)) return "success";
  if (profitDetailHasCalculatedProfit(row)) return "info";
  return "warning";
}

function profitDetailProfitClass(value) {
  if (Number(value || 0) > 0) return "profit-positive";
  if (Number(value || 0) < 0) return "profit-negative";
  return "profit-neutral";
}

function pendingAccruedProfit(row) {
  return Number(row?.estimated_profit_total || 0) - Number(row?.actual_profit_total || 0);
}

function profitDetailBreakdownRows(row) {
  return [
    { label: "销售额", value: profitDetailRevenue(row) },
    { label: "采购成本", value: Number(row?.purchase_cost_total || 0) },
    { label: "国内运费", value: Number(row?.domestic_shipping_total || 0) },
    { label: "国际运费", value: Number(row?.international_shipping_total || 0) },
    { label: "包装费", value: Number(row?.handling_fee_total || 0) },
    { label: "佣金", value: Number(row?.commission_total || 0) },
    { label: "平台服务费", value: Number(row?.ozon_service_fee_total || 0) },
    { label: "退货损失", value: Number(row?.return_loss_total || 0) },
    { label: "广告费", value: Number(row?.advertising_cost_total || 0) },
    { label: "其他费用", value: Number(row?.other_fee_total || 0) },
    { label: "当前利润", value: profitDetailCurrentProfit(row), highlight: true }
  ];
}

function profitDetailModelRows(row, mode) {
  const rows = row?.profit_models?.[mode]?.rows;
  return Array.isArray(rows) ? rows : [];
}

function profitDetailModelLabel(row, mode) {
  return row?.profit_models?.[mode]?.label || (mode === "actual" ? "真实利润" : "预估利润");
}

function profitDetailModelReady(row, mode) {
  return Boolean(row?.profit_models?.[mode]?.ready);
}

function profitDetailModelValueText(item) {
  if (item?.value_type === "number") return integer(item?.value || 0);
  if (item?.value === null || item?.value === undefined || item?.value === "") return "-";
  return `¥${money(item.value)}`;
}

function applyRouteState() {
  syncingRoute = true;
  try {
    applyFilterQuery(route, state.filters, filterDefaults);
    if (route.query.productId && !state.filters.query) state.filters.query = String(route.query.productId);
  } finally {
    syncingRoute = false;
  }
}

const syncRouteQuery = createDefaultRouteQuerySync({
  route,
  router,
  filters: state.filters,
  defaults: filterDefaults,
  isSyncingRoute: () => syncingRoute
});

function handleSearch() {
  state.filters.page = 1;
  syncRouteQuery("manual");
  loadPageData();
}

function handleReset() {
  Object.assign(state.filters, filterDefaults);
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

function handleSelectionChange(rows) {
  selectedRows.value = Array.isArray(rows) ? rows : [];
}

function handleTableSortChange({ prop, order }) {
  state.filters.sortKey = prop || "";
  state.filters.sortDir = order === "ascending" ? "asc" : (order === "descending" ? "desc" : "");
  state.filters.page = 1;
  loadPageData();
}

function openCreateDialog() {
  dialogProduct.value = null;
  dialogVisible.value = true;
}

async function openEditDialog(row) {
  detailLoading.value = true;
  try {
    dialogProduct.value = await apiClient.get(`/api/products/${row.id}`);
    dialogVisible.value = true;
  } catch (error) {
    ElMessage.error(error.message || "加载产品详情失败");
  } finally {
    detailLoading.value = false;
  }
}

async function handleDialogSaved({ mode }) {
  dialogVisible.value = false;
  dialogProduct.value = null;
  ElMessage.success(mode === "edit" ? "库存产品已更新" : "库存产品已创建");
  await loadPageData();
}

function resetMergePreview() {
  mergePreview.products = [];
  mergePreview.conflicts = [];
  mergePreview.affectedCounts = {};
  mergePreview.moveCountsSummary = {};
  mergePreview.targetProductId = null;
  mergePreview.fieldSources = {};
}

function updateMergeCountSummary() {
  const targetProductId = Number(mergePreview.targetProductId || 0);
  const affectedCounts = mergePreview.affectedCounts || {};
  mergePreview.moveCountsSummary = Object.fromEntries(
    Object.entries(affectedCounts).map(([key, value]) => {
      const perProduct = value?.per_product || {};
      const total = Object.entries(perProduct).reduce((sum, [productId, count]) => (
        Number(productId) === targetProductId ? sum : sum + Number(count || 0)
      ), 0);
      return [key, {
        label: value?.label || key,
        total
      }];
    })
  );
}

async function openMergeDialog() {
  if (!canMergeProducts.value) {
    ElMessage.warning("请至少选择两个库存产品");
    return;
  }
  mergePreviewLoading.value = true;
  resetMergePreview();
  mergeDialogVisible.value = true;
  try {
    const result = await apiClient.post("/api/products/merge-preview", {
      product_ids: selectedRows.value.map((row) => row.id)
    });
    mergePreview.products = Array.isArray(result?.products) ? result.products : [];
    mergePreview.conflicts = Array.isArray(result?.conflicts) ? result.conflicts : [];
    mergePreview.affectedCounts = result?.affected_counts || {};
    mergePreview.targetProductId = Number(mergePreview.products[0]?.id || selectedRows.value[0]?.id || 0) || null;
    for (const field of mergePreview.conflicts) {
      mergePreview.fieldSources[field.key] = Number(field.options?.[0]?.sourceId || mergePreview.targetProductId || 0);
    }
    updateMergeCountSummary();
  } catch (error) {
    mergeDialogVisible.value = false;
    ElMessage.error(error.message || "加载合并预览失败");
  } finally {
    mergePreviewLoading.value = false;
  }
}

async function submitMergeProducts() {
  if (!mergePreview.targetProductId) {
    ElMessage.warning("请选择保留的主产品");
    return;
  }
  mergeSubmitting.value = true;
  try {
    await apiClient.post("/api/products/merge", {
      product_ids: mergePreview.products.map((row) => row.id),
      target_product_id: mergePreview.targetProductId,
      field_sources: mergePreview.fieldSources
    });
    ElMessage.success("库存产品已合并");
    mergeDialogVisible.value = false;
    selectedRows.value = [];
    resetMergePreview();
    await Promise.all([loadPageData(), loadMergeHistory()]);
  } catch (error) {
    ElMessage.error(error.message || "合并库存产品失败");
  } finally {
    mergeSubmitting.value = false;
  }
}

async function loadMergeHistory() {
  mergeHistoryLoading.value = true;
  try {
    const rows = await apiClient.get("/api/products/merge-history?limit=30");
    mergeHistoryRows.value = Array.isArray(rows) ? rows : [];
  } catch (error) {
    ElMessage.error(error.message || "加载合并历史失败");
  } finally {
    mergeHistoryLoading.value = false;
  }
}

async function openMergeHistoryDialog() {
  mergeHistoryDialogVisible.value = true;
  await loadMergeHistory();
}

function mergeHistorySourceText(row) {
  const names = Array.isArray(row.source_product_names) ? row.source_product_names : [];
  return names.length ? names.join("、") : "-";
}

function mergeHistoryCountsText(row) {
  const affected = row.affected_counts || {};
  return Object.values(affected)
    .map((item) => {
      const total = Number(item?.total || 0);
      return total > 0 ? `${item.label} ${total}` : "";
    })
    .filter(Boolean)
    .join("，") || "-";
}

async function undoMergeHistory(row) {
  const id = Number(row.id || 0);
  if (!id) return;
  try {
    await ElMessageBox.confirm(
      "确认撤销这次合并吗？将恢复主产品和被合并产品的关联数据。",
      "撤销合并",
      {
        type: "warning",
        confirmButtonText: "确认撤销",
        cancelButtonText: "取消"
      }
    );
    mergeUndoingId.value = id;
    await apiClient.post(`/api/products/${id}/undo-merge`, {});
    ElMessage.success("已撤销合并");
    await Promise.all([loadPageData(), loadMergeHistory()]);
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "撤销合并失败");
  } finally {
    mergeUndoingId.value = 0;
  }
}

async function removeFromInventory(row) {
  try {
    await ElMessageBox.confirm(
      `确认删除库存产品「${row.name || row.id}」吗？`,
      "删除库存产品",
      {
        type: "warning",
        confirmButtonText: "删除",
        cancelButtonText: "取消"
      }
    );
    await apiClient.post(`/api/products/${row.id}/remove-from-inventory`, {});
    ElMessage.success("已删除库存产品");
    await loadPageData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "删除库存产品失败");
  }
}

async function openProfitDetailsByMode(row, mode = "estimated") {
  profitDetailCurrentProduct.value = row;
  profitDetailPreferredMode.value = mode === "actual" ? "actual" : "estimated";
  Object.assign(profitDetailPager, detailPageDefaults);
  Object.assign(profitDetailFilters, {
    query: "",
    shopId: "all",
    dateFrom: "",
    dateTo: ""
  });
  await loadProfitDetails();
}

async function loadProfitDetails() {
  const row = profitDetailCurrentProduct.value;
  if (!row?.id) return;
  profitDetailLoading.value = true;
  profitDetailDialogVisible.value = true;
  profitDetailDialogTitle.value = `${row.name || row.product_name} - ${profitDetailPreferredMode.value === "actual" ? "真实利润" : "预估利润"}明细`;
  try {
    const params = new URLSearchParams({
      paged: "1",
      page: String(profitDetailPager.page),
      pageSize: String(profitDetailPager.pageSize),
      shopId: String(profitDetailFilters.shopId || "all"),
      dateFrom: toFilterDateValue(profitDetailFilters.dateFrom),
      dateTo: toFilterDateValue(profitDetailFilters.dateTo)
    });
    const query = String(profitDetailFilters.query || "").trim();
    if (query) params.set("query", query);
    const result = await apiClient.get(`/api/products/${row.id}/order-profit-details?${params.toString()}`);
    profitDetailRows.value = Array.isArray(result?.rows) ? result.rows : (Array.isArray(result) ? result : []);
    profitDetailTotal.value = Number(result?.total || profitDetailRows.value.length);
  } catch (error) {
    profitDetailRows.value = [];
    profitDetailTotal.value = 0;
    ElMessage.error(error.message || "加载订单利润明细失败");
  } finally {
    profitDetailLoading.value = false;
  }
}

function handleProfitDetailPageChange(page) {
  profitDetailPager.page = page;
  loadProfitDetails();
}

function handleProfitDetailPageSizeChange(size) {
  profitDetailPager.pageSize = size;
  profitDetailPager.page = 1;
  loadProfitDetails();
}

function submitProfitDetailFilters() {
  profitDetailPager.page = 1;
  loadProfitDetails();
}

function resetProfitDetailFilters() {
  Object.assign(profitDetailFilters, {
    query: "",
    shopId: "all",
    dateFrom: "",
    dateTo: ""
  });
  submitProfitDetailFilters();
}

async function openInventoryProfitDetails(row) {
  const preview = buildInventoryProfitPreview(row);
  if (!preview.valid) {
    ElMessage.warning(preview.reason || "暂无可用利润详情");
    return;
  }
  profitPreviewDialogVisible.value = true;
  profitPreviewDialogTitle.value = `${row.name || row.product_name} - 利润详情`;
  profitPreviewSummary.value = preview.valid ? preview : null;
  profitPreviewRows.value = preview.valid ? buildInventoryProfitDetailRows(row, preview) : [];
}

async function openCancelDetails(row) {
  detailLoading.value = true;
  detailDialogVisible.value = true;
  detailDialogTitle.value = `${row.name || row.product_name} - 取消订单明细`;
  try {
    detailRows.value = await apiClient.get(`/api/products/${row.id}/cancel-details`);
  } catch (error) {
    detailRows.value = [];
    ElMessage.error(error.message || "加载取消订单明细失败");
  } finally {
    detailLoading.value = false;
  }
}

function openProcurement(row) {
  procurementCreateProductId.value = Number(row.id || 0) || null;
  procurementCreateVisible.value = Boolean(procurementCreateProductId.value);
}

async function handleProcurementCreated() {
  procurementCreateVisible.value = false;
  procurementCreateProductId.value = null;
  await loadPageData();
}

async function openProductSalesDetails(row) {
  productSalesCurrentProduct.value = row;
  Object.assign(productSalesPager, detailPageDefaults);
  Object.assign(productSalesFilters, {
    query: "",
    shopId: "all",
    dateFrom: "",
    dateTo: ""
  });
  await loadProductSalesDetails();
}

async function loadProductSalesDetails() {
  const row = productSalesCurrentProduct.value;
  if (!row?.id) return;
  productSalesDialogVisible.value = true;
  productSalesDialogTitle.value = `${row.name || row.product_name || "产品"} - 销售出库明细`;
  productSalesLoading.value = true;
  try {
    const params = new URLSearchParams({
      paged: "1",
      page: String(productSalesPager.page),
      pageSize: String(productSalesPager.pageSize),
      productId: String(row.id),
      status: "deducted",
      shopId: String(productSalesFilters.shopId || "all"),
      dateFrom: toFilterDateValue(productSalesFilters.dateFrom),
      dateTo: toFilterDateValue(productSalesFilters.dateTo)
    });
    const query = String(productSalesFilters.query || "").trim();
    if (query) params.set("query", query);
    const result = await apiClient.get(`/api/outbound-records?${params.toString()}`);
    productSalesRows.value = Array.isArray(result?.rows) ? result.rows : [];
    productSalesTotal.value = Number(result?.total || productSalesRows.value.length);
  } catch (error) {
    ElMessage.error(error.message || "加载销售出库明细失败");
  } finally {
    productSalesLoading.value = false;
  }
}

function handleProductSalesPageChange(page) {
  productSalesPager.page = page;
  loadProductSalesDetails();
}

function handleProductSalesPageSizeChange(size) {
  productSalesPager.pageSize = size;
  productSalesPager.page = 1;
  loadProductSalesDetails();
}

function submitProductSalesFilters() {
  productSalesPager.page = 1;
  loadProductSalesDetails();
}

function resetProductSalesFilters() {
  Object.assign(productSalesFilters, {
    query: "",
    shopId: "all",
    dateFrom: "",
    dateTo: ""
  });
  submitProductSalesFilters();
}

async function openProductProcurementDetails(row) {
  productProcurementCurrentProduct.value = row;
  Object.assign(productProcurementPager, detailPageDefaults);
  Object.assign(productProcurementFilters, {
    query: "",
    personId: "all",
    dateFrom: "",
    dateTo: ""
  });
  await loadProductProcurementDetails();
}

async function loadProductProcurementDetails() {
  const row = productProcurementCurrentProduct.value;
  if (!row?.id) return;
  productProcurementDialogVisible.value = true;
  productProcurementDialogTitle.value = `${row.name || row.product_name || "产品"} - 采购记录`;
  productProcurementLoading.value = true;
  try {
    const params = new URLSearchParams({
      paged: "1",
      page: String(productProcurementPager.page),
      pageSize: String(productProcurementPager.pageSize),
      productId: String(row.id),
      status: "all",
      personId: String(productProcurementFilters.personId || "all"),
      dateFrom: toFilterDateValue(productProcurementFilters.dateFrom),
      dateTo: toFilterDateValue(productProcurementFilters.dateTo)
    });
    const query = String(productProcurementFilters.query || "").trim();
    if (query) params.set("query", query);
    const result = await apiClient.get(`/api/procurement/requests?${params.toString()}`);
    productProcurementRows.value = Array.isArray(result?.rows) ? result.rows : [];
    productProcurementTotal.value = Number(result?.total || productProcurementRows.value.length);
  } catch (error) {
    ElMessage.error(error.message || "加载采购记录失败");
  } finally {
    productProcurementLoading.value = false;
  }
}

async function saveProductProcurementRow(row) {
  const requestId = Number(row?.id || 0);
  if (!requestId) return;
  try {
    await ElMessageBox.confirm(
      `确认保存采购记录 #${requestId} 的修改吗？修改历史采购记录可能影响采购统计、成本和利润口径。`,
      "编辑风险提醒",
      {
        type: "warning",
        confirmButtonText: "继续保存",
        cancelButtonText: "取消"
      }
    );
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    throw error;
  }
  productProcurementSaving.value = true;
  try {
    await apiClient.put(`/api/procurement/requests/${requestId}`, {
      updated_at: row.updated_at || "",
      product_id: Number(row.product_id || 0) || null,
      person_id: Number(row.person_id || 0) || null,
      quantity: Number(row.quantity || 0),
      amount: Number(row.amount || 0),
      shipping_amount: Number(row.shipping_amount || 0),
      urgency: row.urgency || "normal",
      source_type: row.source_type || "1688",
      supplier_id: row.supplier_id || null,
      purchase_url: row.purchase_url || "",
      note: row.note || "",
      status: row.status || "submitted"
    });
    ElMessage.success("采购记录已更新");
    await loadProductProcurementDetails();
  } catch (error) {
    ElMessage.error(error.message || "保存采购记录失败");
  } finally {
    productProcurementSaving.value = false;
  }
}

async function deleteProductProcurementRow(row) {
  const requestId = Number(row?.id || 0);
  if (!requestId) return;
  try {
    await ElMessageBox.confirm(
      `确认删除采购记录 #${requestId} 吗？删除历史采购记录可能影响采购统计、成本和利润口径。`,
      "删除风险提醒",
      {
        type: "warning",
        confirmButtonText: "确认删除",
        cancelButtonText: "取消"
      }
    );
    productProcurementSaving.value = true;
    await apiClient.delete(`/api/procurement/requests/${requestId}`);
    ElMessage.success("采购记录已删除");
    await Promise.all([loadProductProcurementDetails(), loadPageData()]);
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "删除采购记录失败");
  } finally {
    productProcurementSaving.value = false;
  }
}

async function directInboundProductProcurementRow(row) {
  const requestId = Number(row?.id || 0);
  if (!requestId) return;
  try {
    await ElMessageBox.confirm(`确认将采购记录 #${requestId} 直接入库吗？`, "直接入库", {
      type: "warning",
      confirmButtonText: "确认入库",
      cancelButtonText: "取消"
    });
    productProcurementSaving.value = true;
    await apiClient.post("/api/procurement/requests/direct-inbound", { request_ids: [requestId] });
    ElMessage.success("采购记录已直接入库");
    await Promise.all([loadProductProcurementDetails(), loadPageData()]);
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "采购记录直接入库失败");
  } finally {
    productProcurementSaving.value = false;
  }
}

function handleProductProcurementPageChange(page) {
  productProcurementPager.page = page;
  loadProductProcurementDetails();
}

function handleProductProcurementPageSizeChange(size) {
  productProcurementPager.pageSize = size;
  productProcurementPager.page = 1;
  loadProductProcurementDetails();
}

function submitProductProcurementFilters() {
  productProcurementPager.page = 1;
  loadProductProcurementDetails();
}

function resetProductProcurementFilters() {
  Object.assign(productProcurementFilters, {
    query: "",
    personId: "all",
    dateFrom: "",
    dateTo: ""
  });
  submitProductProcurementFilters();
}

function openMappingDetails(row) {
  router.push({
    path: "/inventory/mappings",
    query: {
      productId: String(row.id),
      from: "inventory-products",
      returnTo: route.fullPath
    }
  });
}

async function loadPageData() {
  const requestToken = listRequestGate.next();
  loading.value = true;
  try {
    const params = new URLSearchParams({
      paged: "1",
      page: String(state.filters.page),
      pageSize: String(state.filters.pageSize),
      shopId: String(state.filters.shopId || "all"),
      dateFrom: String(state.filters.dateFrom || ""),
      dateTo: String(state.filters.dateTo || ""),
      sortKey: String(state.filters.sortKey || ""),
      sortDir: String(state.filters.sortDir || "")
    });
    const query = String(state.filters.query || "").trim();
    if (query) params.set("query", query);
    const requests = [apiClient.get(`/api/products?${params.toString()}`)];
    if (!dictionaryLoaded) {
      requests.push(
        apiClient.get("/api/people"),
        apiClient.get("/api/suppliers"),
        apiClient.get("/api/shops"),
        apiClient.get("/api/logistics-rules")
      );
    }
    const [products, people, suppliers, shops, logisticsRules] = await Promise.all(requests);
    if (!listRequestGate.isLatest(requestToken)) return;
    state.products = Array.isArray(products?.rows) ? products.rows : [];
    state.total = Number(products?.total || 0);
    const resolvedTotalPages = Math.max(1, Math.ceil(state.total / Math.max(1, Number(state.filters.pageSize || 1))));
    if (state.filters.page > resolvedTotalPages) {
      state.filters.page = resolvedTotalPages;
      loadPageData();
      return;
    }
    selectedRows.value = [];
    if (!dictionaryLoaded) {
      state.people = Array.isArray(people) ? people.filter((item) => Number(item.active) !== 0) : [];
      state.suppliers = Array.isArray(suppliers) ? suppliers : [];
      state.shops = Array.isArray(shops) ? shops : [];
      state.logisticsRules = Array.isArray(logisticsRules) ? logisticsRules.filter((item) => Number(item.enabled) !== 0) : [];
      dictionaryLoaded = true;
    }
  } catch (error) {
    if (!listRequestGate.isLatest(requestToken)) return;
    ElMessage.error(error.message || "加载库存产品列表失败");
  } finally {
    if (listRequestGate.isLatest(requestToken)) loading.value = false;
  }
}

watch(() => route.query, applyRouteState, { deep: true });
watch(
  () => [state.filters.shopId, state.filters.dateFrom, state.filters.dateTo, state.filters.page, state.filters.pageSize, state.filters.sortKey, state.filters.sortDir],
  syncRouteQuery
);
watch(() => mergePreview.targetProductId, updateMergeCountSummary);

onMounted(async () => {
  applyRouteState();
  await loadPageData();
});
</script>

<template>
  <div class="inventory-page-shell inventory-card">
    <InventoryPageToolbar
      :filters="state.filters"
      :shops="state.shops"
      query-label="产品搜索"
      query-placeholder="产品名称 / SKU / 库存编码 / 负责人"
      @search="handleSearch"
      @reset="handleReset"
    >
      <template #actions>
        <el-button class="erp-btn erp-btn-secondary" @click="openMergeHistoryDialog">合并历史</el-button>
        <el-button class="erp-btn erp-btn-secondary" :disabled="!canMergeProducts" @click="openMergeDialog">合并库存产品</el-button>
        <el-button class="erp-btn erp-btn-primary" type="primary" @click="openCreateDialog">新增库存产品</el-button>
      </template>
    </InventoryPageToolbar>

    <div class="inventory-table-wrap">
      <el-table
        v-loading="loading"
        :data="pagedRows"
        stripe
        border
        class="erp-data-table"
        @selection-change="handleSelectionChange"
        @sort-change="handleTableSortChange"
      >
        <el-table-column type="selection" width="48" fixed="left" />
        <el-table-column label="产品信息" prop="product" min-width="340" fixed="left" sortable="custom">
          <template #default="{ row }">
            <div class="product-cell">
              <ProductImagePreview :src="row.image_url" />
              <div class="cell-stack">
                <ProductTitleLink :title="row.name || '-'" :lines="2" />
                <span class="muted-text">{{ row.inventory_id || row.code || "-" }}</span>
                <span class="muted-text">负责人：{{ row.owner_name || "-" }}</span>
                <span class="muted-text">绑定 SKU：{{ integer(row.bound_sku_count) }} 个</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="库存" prop="stock" width="180" align="center" sortable="custom">
          <template #default="{ row }">
            <div class="inventory-stock-cell">
              <div class="stock-total-line">
                <span>总库存</span>
                <strong>{{ integer(totalProductStock(row)) }}</strong>
              </div>
              <div class="stock-split-grid">
                <span>本地 {{ integer(localStock(row)) }}</span>
                <span>FBP {{ integer(fbpStock(row)) }}</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="采购在途" prop="incoming_stock" width="120" align="center" sortable="custom">
          <template #default="{ row }">
            <div class="cell-stack cell-center">
              <strong>{{ integer(row.incoming_stock) }}</strong>
              <span class="muted-text">采购/入库</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="FBP发仓" prop="fbp_transfer_in_transit_qty" width="120" align="center" sortable="custom">
          <template #default="{ row }">
            <div class="cell-stack cell-center">
              <strong>{{ integer(fbpTransferStock(row)) }}</strong>
              <span class="muted-text">待入FBP</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="销售表现" prop="total_sales_amount" min-width="190" align="right" sortable="custom">
          <template #default="{ row }">
            <el-button class="metric-cell-link" link type="primary" @click.stop="openProductSalesDetails(row)">
              <div class="metric-cell-content cell-stack cell-align-end">
                <strong>{{ integer(row.total_sales_quantity) }} 件</strong>
                <span class="muted-text">销售额 ¥{{ money(row.total_sales_amount) }}</span>
                <span class="muted-text">订单 {{ integer(row.order_count) }} / 均单 ¥{{ money(averageOrderAmount(row)) }}</span>
              </div>
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="采购成本" prop="total_purchase_amount" min-width="170" align="right" sortable="custom">
          <template #default="{ row }">
            <el-button class="metric-cell-link" link type="primary" @click.stop="openProductProcurementDetails(row)">
              <div class="metric-cell-content cell-stack cell-align-end">
                <strong>总采购 ¥{{ money(row.total_purchase_amount) }}</strong>
                <span class="muted-text">采购数 {{ integer(row.total_purchase_quantity) }}</span>
                <span class="muted-text">均成本 ¥{{ money(averagePurchaseCost(row)) }}</span>
              </div>
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="预估利润" prop="estimated_profit_total" min-width="170" align="right" sortable="custom">
          <template #default="{ row }">
            <el-button class="metric-cell-link" link type="success" @click.stop="openProfitDetailsByMode(row, 'estimated')">
              <div class="metric-cell-content cell-stack cell-align-end">
                <strong :class="profitDetailProfitClass(row.estimated_profit_total)">¥{{ money(row.estimated_profit_total) }}</strong>
                <span class="muted-text">待入账 ¥{{ money(pendingAccruedProfit(row)) }}</span>
                <span class="muted-text">利润率 {{ percent(row.profit_rate) }}</span>
              </div>
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="真实利润" prop="actual_profit_total" min-width="170" align="right" sortable="custom">
          <template #default="{ row }">
            <el-button class="metric-cell-link" link type="primary" @click.stop="openProfitDetailsByMode(row, 'actual')">
              <div class="metric-cell-content cell-stack cell-align-end">
                <strong :class="profitDetailProfitClass(row.actual_profit_total)">¥{{ money(row.actual_profit_total) }}</strong>
                <span class="muted-text">已入账利润</span>
                <span class="muted-text">参考件利 ¥{{ inventoryProfitMoneyText(row, "profit") }}</span>
              </div>
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="库存占用" prop="inventory_value" min-width="150" align="right" sortable="custom">
          <template #default="{ row }">
            <div class="cell-stack cell-align-end">
              <strong>¥{{ money(productInventoryValue(row)) }}</strong>
              <span class="muted-text">库存 {{ integer(stockForInventoryValue(row)) }} x 成本</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <div class="inventory-actions">
              <el-button class="erp-btn-link" link type="primary" @click="openEditDialog(row)">编辑</el-button>
              <el-button class="erp-btn-link" link @click="openProcurement(row)">创建采购</el-button>
              <el-button class="erp-btn-link erp-btn-link-danger" link type="danger" @click="removeFromInventory(row)">删除</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <PageFooterPagination
      :total="state.total"
      :page="state.filters.page"
      :page-size="state.filters.pageSize"
      :total-pages="inventoryTotalPages"
      :summary="inventoryFooterSummary"
      @update:page="handlePageChange"
      @update:pageSize="handlePageSizeChange"
    />

    <el-dialog
      v-model="mergeDialogVisible"
      title="合并库存产品"
      width="1320px"
      top="4vh"
      align-center
      class="erp-centered-dialog merge-product-dialog"
    >
      <div v-loading="mergePreviewLoading" class="merge-dialog-body">
        <div class="merge-target-section">
          <div class="merge-section-head">
            <span class="merge-section-title">保留主产品</span>
            <span class="merge-section-tip">先选择保留哪一个产品，再按列决定冲突字段保留哪边数据。</span>
          </div>
          <div class="merge-top-grid" :style="{ gridTemplateColumns: mergeDialogColumns }">
            <div
              v-for="product in mergePreview.products"
              :key="product.id"
              class="merge-product-card"
              :class="{ 'is-target': Number(mergePreview.targetProductId) === Number(product.id) }"
            >
              <label class="merge-product-select">
                <input v-model="mergePreview.targetProductId" type="radio" :value="product.id">
                <span>保留为主产品</span>
              </label>
              <ProductImagePreview :src="product.image_url" size="square" fit="cover" :alt="mergeProductName(product)" />
              <div class="merge-product-meta">
                <strong>{{ mergeProductName(product) }}</strong>
                <span>{{ mergeProductCode(product) }}</span>
                <span>负责人：{{ product.owner_name || "未设置" }}</span>
                <span>供应商：{{ product.supplier_name || "未设置" }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="merge-counts-card">
          <div class="merge-section-head">
            <span class="merge-section-title">将迁移的关联记录</span>
            <span class="merge-section-tip">这里只统计会从其它产品迁移到主产品的记录数量。</span>
          </div>
          <el-empty v-if="!mergeCountRows.length" description="未发现需要迁移的关联记录" :image-size="64" />
          <div v-else class="merge-count-list">
            <div v-for="item in mergeCountRows" :key="item.key" class="merge-count-item">
              <span>{{ item.label }}</span>
              <strong>{{ integer(item.total) }}</strong>
            </div>
          </div>
        </div>

        <div v-if="mergePreview.conflicts.length" class="merge-compare-section">
          <div class="merge-section-head">
            <span class="merge-section-title">冲突字段对比</span>
            <span class="merge-section-tip">按列查看每个产品的完整冲突数据，点击每行即可选择该字段保留哪个产品的值。</span>
          </div>
          <div class="merge-compare-grid" :style="{ gridTemplateColumns: mergeDialogColumns }">
            <div
              v-for="product in mergePreview.products"
              :key="`compare-${product.id}`"
              class="merge-compare-column"
              :class="{ 'is-target': Number(mergePreview.targetProductId) === Number(product.id) }"
            >
              <div class="merge-compare-column-head">
                <ProductImagePreview :src="product.image_url" size="square" fit="cover" :alt="mergeProductName(product)" />
                <div class="merge-compare-column-meta">
                  <strong>{{ mergeProductName(product) }}</strong>
                  <span>{{ mergeProductCode(product) }}</span>
                </div>
              </div>
              <button
                v-for="fieldKey in mergeFieldKeys"
                :key="`${product.id}-${fieldKey}`"
                type="button"
                class="merge-field-card"
                :class="{ 'is-selected': mergeFieldSelected(fieldKey, product.id) }"
                @click="mergePreview.fieldSources[fieldKey] = product.id"
              >
                <span class="merge-field-label">{{ mergeFieldLabelMap[fieldKey] || fieldKey }}</span>
                <span class="merge-field-value">{{ mergeFieldDisplay(fieldKey, product.id) }}</span>
                <span class="merge-field-choice">{{ mergeFieldSelected(fieldKey, product.id) ? "当前保留" : "点击选用该值" }}</span>
              </button>
            </div>
          </div>
        </div>
        <el-empty
          v-else
          description="所选产品的主数据没有冲突，将直接保留主产品字段。"
          :image-size="64"
        />
      </div>
      <template #footer>
        <div class="dialog-footer">
          <el-button @click="mergeDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="mergeSubmitting" @click="submitMergeProducts">确认合并</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="mergeHistoryDialogVisible" title="库存合并历史" width="1100px" align-center class="erp-centered-dialog">
      <el-table v-loading="mergeHistoryLoading" :data="mergeHistoryRows" stripe border class="erp-data-table">
        <el-table-column prop="id" label="记录 ID" width="90" />
        <el-table-column label="主产品" min-width="180">
          <template #default="{ row }">{{ row.target_product_name || row.target_product_id }}</template>
        </el-table-column>
        <el-table-column label="被合并产品" min-width="240">
          <template #default="{ row }">{{ mergeHistorySourceText(row) }}</template>
        </el-table-column>
        <el-table-column label="迁移统计" min-width="260">
          <template #default="{ row }">{{ mergeHistoryCountsText(row) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 'undone' ? 'info' : 'success'">
              {{ row.status === "undone" ? "已撤销" : "已合并" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ dateText(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="撤销时间" width="170">
          <template #default="{ row }">{{ row.undone_at ? dateText(row.undone_at) : "-" }}</template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="danger"
              :disabled="row.status === 'undone'"
              :loading="mergeUndoingId === row.id"
              @click="undoMergeHistory(row)"
            >
              撤销合并
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <ProductCreateEditDialog
      v-model:visible="dialogVisible"
      :mode="dialogProduct ? 'edit' : 'create'"
      target="inventory"
      :people="state.people"
      :suppliers="state.suppliers"
      :logistics-rules="state.logisticsRules"
      :value="dialogProduct"
      @saved="handleDialogSaved"
    />

    <ProcurementRequestCreateDialog
      v-model="procurementCreateVisible"
      :initial-product-id="procurementCreateProductId"
      :lock-product="true"
      @created="handleProcurementCreated"
    />

    <el-dialog v-model="productSalesDialogVisible" :title="productSalesDialogTitle" width="1380px" top="4vh" align-center class="erp-centered-dialog inventory-detail-dialog inventory-detail-dialog--wide">
      <div class="product-detail-summary">
        <div class="product-detail-summary-item">
          <span>当前明细</span>
          <strong>{{ integer(productSalesRows.length) }} / {{ integer(productSalesTotal) }}</strong>
        </div>
        <div class="product-detail-summary-item">
          <span>出库件数</span>
          <strong>{{ integer(productSalesSummary.quantity) }}</strong>
        </div>
        <div class="product-detail-summary-item">
          <span>销售额</span>
          <strong>¥{{ money(productSalesSummary.amount) }}</strong>
        </div>
        <div class="product-detail-summary-item">
          <span>利润</span>
          <strong :class="profitDetailProfitClass(productSalesSummary.profit)">¥{{ money(productSalesSummary.profit) }}</strong>
        </div>
      </div>
      <div class="detail-filter-bar" @keydown.enter.prevent="submitProductSalesFilters">
        <el-form inline class="detail-filter-form" @submit.prevent="submitProductSalesFilters">
          <el-form-item label="店铺">
            <el-select v-model="productSalesFilters.shopId" style="width: 180px">
              <el-option label="全部店铺" value="all" />
              <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
            </el-select>
          </el-form-item>
          <el-form-item label="开始">
            <el-date-picker v-model="productSalesFilters.dateFrom" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" />
          </el-form-item>
          <el-form-item label="结束">
            <el-date-picker v-model="productSalesFilters.dateTo" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" />
          </el-form-item>
          <el-form-item label="搜索" class="detail-filter-search">
            <el-input
              v-model="productSalesFilters.query"
              clearable
              placeholder="订单号 / SKU / 名称 / 店铺"
              style="width: 100%"
              @keyup.enter="submitProductSalesFilters"
            />
          </el-form-item>
          <el-form-item class="detail-filter-actions">
            <el-button class="erp-btn erp-btn-primary" native-type="submit" type="primary" @click="submitProductSalesFilters">查询</el-button>
            <el-button class="erp-btn erp-btn-secondary" @click="resetProductSalesFilters">重置</el-button>
          </el-form-item>
        </el-form>
      </div>
      <div class="inventory-dialog-table-wrap">
        <el-table
          v-loading="productSalesLoading"
          :data="productSalesRows"
          height="100%"
          stripe
          border
          class="erp-data-table"
        >
          <el-table-column label="图片" width="86" fixed="left" align="center">
            <template #default="{ row }">
              <ProductImagePreview :src="detailImage(row)" size="portrait" :alt="row.product_name || row.ozon_sku || '订单商品图片'" />
            </template>
          </el-table-column>
          <el-table-column prop="outbound_time" label="出库时间" width="170" />
          <el-table-column prop="order_ref" label="订单号" min-width="220" />
          <el-table-column prop="shop_name" label="店铺" min-width="150" />
          <el-table-column prop="ozon_sku" label="SKU" min-width="180" />
          <el-table-column prop="quantity" label="数量" width="80" align="center" />
          <el-table-column label="售价" width="110" align="right">
            <template #default="{ row }">¥{{ money(row.sale_price) }}</template>
          </el-table-column>
          <el-table-column label="销售额" width="120" align="right">
            <template #default="{ row }">¥{{ money(row.order_amount) }}</template>
          </el-table-column>
          <el-table-column label="利润" width="150" align="right">
            <template #default="{ row }">
              <div class="profit-value-cell">
                <strong :class="profitDetailProfitClass(profitDetailCurrentProfit(row))">¥{{ money(profitDetailCurrentProfit(row)) }}</strong>
                <span class="profit-subline">{{ profitDetailStatusText(row) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }">{{ outboundStatusText(row.status) }}</template>
          </el-table-column>
        </el-table>
      </div>
      <PageFooterPagination
        :total="productSalesTotal"
        :page="productSalesPager.page"
        :page-size="productSalesPager.pageSize"
        @update:page="handleProductSalesPageChange"
        @update:pageSize="handleProductSalesPageSizeChange"
      />
    </el-dialog>

    <el-dialog v-model="productProcurementDialogVisible" :title="productProcurementDialogTitle" width="1460px" top="4vh" align-center class="erp-centered-dialog inventory-detail-dialog inventory-detail-dialog--wide">
      <div class="product-detail-summary">
        <div class="product-detail-summary-item">
          <span>当前明细</span>
          <strong>{{ integer(productProcurementRows.length) }} / {{ integer(productProcurementTotal) }}</strong>
        </div>
        <div class="product-detail-summary-item">
          <span>采购数量</span>
          <strong>{{ integer(productProcurementSummary.quantity) }}</strong>
        </div>
        <div class="product-detail-summary-item">
          <span>采购金额</span>
          <strong>¥{{ money(productProcurementSummary.amount) }}</strong>
        </div>
      </div>
      <div class="detail-filter-bar" @keydown.enter.prevent="submitProductProcurementFilters">
        <el-form inline class="detail-filter-form" @submit.prevent="submitProductProcurementFilters">
          <el-form-item label="人员">
            <el-select v-model="productProcurementFilters.personId" style="width: 180px">
              <el-option label="全部人员" value="all" />
              <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="String(person.id)" />
            </el-select>
          </el-form-item>
          <el-form-item label="开始">
            <el-date-picker v-model="productProcurementFilters.dateFrom" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" />
          </el-form-item>
          <el-form-item label="结束">
            <el-date-picker v-model="productProcurementFilters.dateTo" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" />
          </el-form-item>
          <el-form-item label="搜索" class="detail-filter-search">
            <el-input
              v-model="productProcurementFilters.query"
              clearable
              placeholder="SKU / 名称 / 备注 / 链接"
              style="width: 100%"
              @keyup.enter="submitProductProcurementFilters"
            />
          </el-form-item>
          <el-form-item class="detail-filter-actions">
            <el-button class="erp-btn erp-btn-primary" native-type="submit" type="primary" @click="submitProductProcurementFilters">查询</el-button>
            <el-button class="erp-btn erp-btn-secondary" @click="resetProductProcurementFilters">重置</el-button>
          </el-form-item>
        </el-form>
      </div>
      <div class="inventory-dialog-table-wrap">
        <el-table v-loading="productProcurementLoading || productProcurementSaving" :data="productProcurementRows" height="100%" stripe border class="erp-data-table">
          <el-table-column label="图片" width="86" fixed="left" align="center">
            <template #default="{ row }">
              <ProductImagePreview :src="detailImage(row)" size="portrait" :alt="row.product_name || '采购商品图片'" />
            </template>
          </el-table-column>
          <el-table-column prop="created_at" label="提交时间" width="170">
            <template #default="{ row }">{{ dateText(row.created_at) }}</template>
          </el-table-column>
          <el-table-column prop="person_name" label="提交人" width="140" />
          <el-table-column prop="supplier_name" label="供应商" min-width="180" />
          <el-table-column label="数量" width="110" align="center">
            <template #default="{ row }">
              <el-input-number v-model="row.quantity" :min="1" :precision="0" controls-position="right" />
            </template>
          </el-table-column>
          <el-table-column label="货款" width="130" align="right">
            <template #default="{ row }">
              <el-input-number v-model="row.amount" :min="0" :precision="2" controls-position="right" />
            </template>
          </el-table-column>
          <el-table-column label="运费" width="130" align="right">
            <template #default="{ row }">
              <el-input-number v-model="row.shipping_amount" :min="0" :precision="2" controls-position="right" />
            </template>
          </el-table-column>
          <el-table-column label="来源" width="140">
            <template #default="{ row }">
              <el-select v-model="row.source_type">
                <el-option label="1688" value="1688" />
                <el-option label="拼多多" value="pdd" />
                <el-option label="供应商" value="supplier" />
                <el-option label="微信" value="wechat" />
                <el-option label="其他" value="other" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="紧急程度" width="120">
            <template #default="{ row }">
              <el-select v-model="row.urgency">
                <el-option label="普通" value="normal" />
                <el-option label="加急" value="urgent" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="120">
            <template #default="{ row }">{{ procurementStatusText(row.status) }}</template>
          </el-table-column>
          <el-table-column prop="purchase_order_no" label="采购单" min-width="180" />
          <el-table-column label="采购链接" min-width="320">
            <template #default="{ row }">
              <el-input v-model="row.purchase_url" placeholder="https://..." />
            </template>
          </el-table-column>
          <el-table-column label="备注" min-width="280">
            <template #default="{ row }">
              <el-input v-model="row.note" placeholder="备注" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="{ row }">
              <div class="erp-inline-actions">
                <el-button class="erp-btn-link" link type="primary" @click="saveProductProcurementRow(row)">保存</el-button>
                <el-button class="erp-btn-link" link type="success" @click="directInboundProductProcurementRow(row)">直接入库</el-button>
                <el-button class="erp-btn-link erp-btn-link-danger" link type="danger" @click="deleteProductProcurementRow(row)">删除</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <PageFooterPagination
        :total="productProcurementTotal"
        :page="productProcurementPager.page"
        :page-size="productProcurementPager.pageSize"
        @update:page="handleProductProcurementPageChange"
        @update:pageSize="handleProductProcurementPageSizeChange"
      />
    </el-dialog>

    <el-dialog v-model="profitDetailDialogVisible" :title="profitDetailDialogTitle" width="1480px" top="4vh" align-center class="erp-centered-dialog inventory-detail-dialog inventory-detail-dialog--wide">
      <div class="profit-detail-head">
        <div class="profit-detail-card">
          <span>当前明细</span>
          <strong>{{ integer(profitDetailRows.length) }} / {{ integer(profitDetailTotal) }}</strong>
        </div>
        <div class="profit-detail-card">
          <span>销售额合计</span>
          <strong>¥{{ money(profitDetailSummary.revenue) }}</strong>
        </div>
        <div class="profit-detail-card">
          <span>当前利润合计</span>
          <strong :class="profitDetailProfitClass(profitDetailSummary.currentProfit)">¥{{ money(profitDetailSummary.currentProfit) }}</strong>
        </div>
        <div class="profit-detail-card">
          <span>已入账利润合计</span>
          <strong :class="profitDetailProfitClass(profitDetailSummary.actualProfit)">¥{{ money(profitDetailSummary.actualProfit) }}</strong>
        </div>
      </div>
      <div class="detail-filter-bar" @keydown.enter.prevent="submitProfitDetailFilters">
        <el-form inline class="detail-filter-form" @submit.prevent="submitProfitDetailFilters">
          <el-form-item label="店铺">
            <el-select v-model="profitDetailFilters.shopId" style="width: 180px">
              <el-option label="全部店铺" value="all" />
              <el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)" />
            </el-select>
          </el-form-item>
          <el-form-item label="开始">
            <el-date-picker v-model="profitDetailFilters.dateFrom" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" />
          </el-form-item>
          <el-form-item label="结束">
            <el-date-picker v-model="profitDetailFilters.dateTo" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" />
          </el-form-item>
          <el-form-item label="搜索" class="detail-filter-search">
            <el-input
              v-model="profitDetailFilters.query"
              clearable
              placeholder="订单号 / SKU / 名称 / 店铺"
              style="width: 100%"
              @keyup.enter="submitProfitDetailFilters"
            />
          </el-form-item>
          <el-form-item class="detail-filter-actions">
            <el-button class="erp-btn erp-btn-primary" native-type="submit" type="primary" @click="submitProfitDetailFilters">查询</el-button>
            <el-button class="erp-btn erp-btn-secondary" @click="resetProfitDetailFilters">重置</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="inventory-dialog-table-wrap inventory-dialog-table-wrap--profit">
        <el-table
          v-loading="profitDetailLoading"
          :data="profitDetailRows"
          height="100%"
          stripe
          border
          class="erp-data-table"
        >
          <el-table-column label="图片" width="86" fixed="left" align="center">
            <template #default="{ row }">
              <ProductImagePreview :src="detailImage(row)" size="portrait" :alt="row.product_name || row.posting_number || '订单商品图片'" />
            </template>
          </el-table-column>
          <el-table-column type="expand" width="56">
            <template #default="{ row }">
              <div class="profit-breakdown-panel">
                <div class="profit-breakdown-models">
                  <div class="profit-breakdown-model">
                    <div class="profit-breakdown-model__head">
                      <strong>{{ profitDetailModelLabel(row, "estimated") }}</strong>
                      <span>按预估模型展开收费项</span>
                    </div>
                    <div class="profit-breakdown-grid">
                      <div
                        v-for="item in profitDetailModelRows(row, 'estimated')"
                        :key="`${row.order_item_id || row.posting_number}-estimated-${item.key}`"
                        class="profit-breakdown-item"
                        :class="{ 'is-highlight': item.emphasize }"
                      >
                        <span>{{ item.label }}</span>
                        <strong :class="item.emphasize ? profitDetailProfitClass(item.value) : ''">{{ profitDetailModelValueText(item) }}</strong>
                      </div>
                    </div>
                  </div>
                  <div class="profit-breakdown-model">
                    <div class="profit-breakdown-model__head">
                      <strong>{{ profitDetailModelLabel(row, "actual") }}</strong>
                      <span>{{ profitDetailModelReady(row, "actual") ? "按真实入账模型展开收费项" : "当前订单暂未形成完整真实利润" }}</span>
                    </div>
                    <div class="profit-breakdown-grid">
                      <div
                        v-for="item in profitDetailModelRows(row, 'actual')"
                        :key="`${row.order_item_id || row.posting_number}-actual-${item.key}`"
                        class="profit-breakdown-item"
                        :class="{ 'is-highlight': item.emphasize }"
                      >
                        <span>{{ item.label }}</span>
                        <strong :class="item.emphasize ? profitDetailProfitClass(item.value) : ''">{{ profitDetailModelValueText(item) }}</strong>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="profit-breakdown-meta">
                  <span>成本来源：{{ row.cost_source || "-" }}</span>
                  <span>当前取值：未结束订单默认看预估利润，已结束订单默认看真实利润</span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="posting_number" label="订单号" min-width="220" />
          <el-table-column prop="shop_name" label="店铺" min-width="150" />
          <el-table-column prop="quantity" label="数量" width="80" align="center" />
          <el-table-column label="销售额" width="120" align="right">
            <template #default="{ row }">¥{{ money(profitDetailRevenue(row)) }}</template>
          </el-table-column>
          <el-table-column label="利润模型" width="110" align="center">
            <template #default="{ row }">
              <el-tag :type="profitDetailStatusTagType(row)">{{ profitDetailStatusText(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="当前利润" width="150" align="right">
            <template #default="{ row }">
              <div class="profit-value-cell">
                <strong :class="profitDetailProfitClass(profitDetailCurrentProfit(row))">¥{{ money(profitDetailCurrentProfit(row)) }}</strong>
                <span class="profit-subline">预估 ¥{{ money(profitDetailEstimatedProfit(row)) }} / 真实 ¥{{ money(profitDetailActualProfit(row)) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="利润率" width="100" align="right">
            <template #default="{ row }">{{ percent(profitDetailMargin(row)) }}</template>
          </el-table-column>
          <el-table-column label="成本合计" width="120" align="right">
            <template #default="{ row }">¥{{ money(profitDetailTotalCost(row)) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="140">
            <template #default="{ row }">{{ orderStatusText(row.status || row.order_status) }}</template>
          </el-table-column>
          <el-table-column prop="ordered_at" label="下单时间" min-width="190">
            <template #default="{ row }">{{ dateText(row.ordered_at) }}</template>
          </el-table-column>
        </el-table>
      </div>
      <PageFooterPagination
        :total="profitDetailTotal"
        :page="profitDetailPager.page"
        :page-size="profitDetailPager.pageSize"
        @update:page="handleProfitDetailPageChange"
        @update:pageSize="handleProfitDetailPageSizeChange"
      />
    </el-dialog>

    <el-dialog v-model="detailDialogVisible" :title="detailDialogTitle" width="980px" align-center class="erp-centered-dialog">
      <el-table v-loading="detailLoading" :data="detailRows" stripe border class="erp-data-table">
        <el-table-column label="图片" width="86" fixed="left" align="center">
          <template #default="{ row }">
            <ProductImagePreview :src="detailImage(row)" size="portrait" :alt="row.product_name || row.posting_number || '订单商品图片'" />
          </template>
        </el-table-column>
        <el-table-column prop="posting_number" label="订单号" min-width="180" />
        <el-table-column prop="shop_name" label="店铺" min-width="120" />
        <el-table-column prop="quantity" label="数量" width="80" align="center" />
        <el-table-column prop="sale_price" label="售价" width="110" align="right">
          <template #default="{ row }">{{ money(row.sale_price) }}</template>
        </el-table-column>
        <el-table-column prop="estimated_profit" label="利润" width="110" align="right">
          <template #default="{ row }">{{ money(row.actual_profit || row.estimated_profit) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="140">
          <template #default="{ row }">{{ orderStatusText(row.status || row.order_status) }}</template>
        </el-table-column>
        <el-table-column prop="ordered_at" label="下单时间" min-width="170">
          <template #default="{ row }">{{ dateText(row.ordered_at) }}</template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog v-model="profitPreviewDialogVisible" :title="profitPreviewDialogTitle" width="980px" align-center class="erp-centered-dialog">
      <div v-if="profitPreviewSummary" class="profit-preview-head">
        <div class="profit-preview-card">
          <span>净利率</span>
          <strong>{{ inventoryProfitPercentText(profitPreviewSummary.margin) }}</strong>
        </div>
        <div class="profit-preview-card">
          <span>净利润</span>
          <strong>¥{{ money(profitPreviewSummary.profit) }}</strong>
        </div>
        <div class="profit-preview-card">
          <span>建议售价</span>
          <strong>¥{{ money(profitPreviewSummary.suggestedSaleRmb) }}</strong>
        </div>
      </div>
      <el-table v-loading="detailLoading" :data="profitPreviewRows" stripe border class="erp-data-table">
        <el-table-column prop="label" label="项目" width="180" />
        <el-table-column prop="value" label="金额" width="150" align="right">
          <template #default="{ row }"><strong>{{ row.value }}</strong></template>
        </el-table-column>
        <el-table-column prop="note" label="说明" min-width="360" />
      </el-table>
    </el-dialog>

  </div>
</template>

<style scoped>
.sku-summary-cell {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}

.sku-preview-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.sku-preview-tag {
  max-width: 220px;
}

.sku-preview-extra {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.sku-detail-link {
  padding: 0;
}

.inventory-page-shell :deep(.inventory-toolbar-sticky) {
  position: relative;
  flex: 0 0 auto;
  z-index: 2;
}

.inventory-page-shell.inventory-card {
  height: 100%;
  overflow: hidden;
}

.inventory-page-shell > .erp-data-table {
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
}

.inventory-page-shell > .inventory-table-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.inventory-page-shell > .inventory-table-wrap :deep(.erp-data-table) {
  height: 100%;
}

.inventory-page-shell > .inventory-table-wrap :deep(.erp-data-table .el-table__body-wrapper) {
  height: calc(100% - var(--el-table-header-height, 44px));
}

.inventory-detail-dialog :deep(.el-dialog) {
  display: flex;
  flex-direction: column;
  max-height: 92vh;
}

.inventory-detail-dialog--wide :deep(.el-dialog) {
  width: min(1480px, 96vw) !important;
}

.inventory-detail-dialog :deep(.el-dialog__body) {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 12px;
  min-height: 0;
  overflow: hidden;
}

.inventory-dialog-table-wrap {
  min-height: 320px;
  height: min(54vh, 560px);
  overflow: hidden;
}

.inventory-dialog-table-wrap--profit {
  height: min(52vh, 540px);
}

.inventory-detail-dialog :deep(.page-footer-pagination) {
  margin-top: 0;
  padding-top: 0;
}

.inventory-page-shell > :deep(.table-footer),
.inventory-page-shell > :deep(.page-footer-pagination) {
  flex: 0 0 auto;
}

.cell-align-end {
  align-items: flex-end;
}

.metric-cell-link {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: 100%;
  min-height: 64px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  text-align: right;
  transition: background 0.18s ease, border-color 0.18s ease;
}

.metric-cell-link :deep(.el-button__text) {
  width: 100%;
}

.metric-cell-content {
  display: flex;
  flex-direction: column;
  justify-content: center;
  width: 100%;
  min-height: 48px;
}

.metric-cell-link strong {
  color: #1d4ed8;
}

.metric-cell-link:hover {
  border-color: #bfdbfe;
  background: #f8fbff;
}

.detail-filter-bar {
  padding: 10px 12px;
  border: 1px solid #dbe6f3;
  border-radius: 10px;
  background: #fbfdff;
}

.detail-filter-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px 0;
}

.detail-filter-form :deep(.el-input),
.detail-filter-form :deep(.el-select),
.detail-filter-form :deep(.el-date-editor) {
  max-width: 100%;
}

.detail-filter-form :deep(.el-form-item) {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-end;
  margin-bottom: 0;
  margin-right: 14px;
}

.detail-filter-form :deep(.el-form-item__content) {
  display: flex;
  align-items: center;
}

.inventory-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: center;
  gap: 6px;
}

.inventory-actions :deep(.el-button) {
  margin-left: 0;
}

.detail-filter-search {
  flex: 1 1 360px !important;
  min-width: 320px;
}

.detail-filter-search :deep(.el-form-item__content) {
  width: 100%;
}

.detail-filter-actions {
  flex: 0 0 auto !important;
  margin-left: auto;
  padding-left: 16px;
  margin-right: 0 !important;
}

.detail-filter-actions :deep(.el-form-item__content) {
  flex-wrap: nowrap;
  gap: 8px;
}

.product-detail-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}

.product-detail-summary-item {
  display: grid;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid #dbe6f3;
  border-radius: 8px;
  background: #f8fbff;
}

.product-detail-summary-item span {
  color: #64748b;
  font-size: 12px;
}

.product-detail-summary-item strong {
  color: #0f172a;
  font-size: 18px;
}

.inventory-stock-cell {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.stock-total-line {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
}

.stock-total-line span {
  color: #64748b;
  font-size: 12px;
}

.stock-total-line strong {
  color: #0f172a;
  font-size: 18px;
  line-height: 1;
}

.stock-split-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.stock-split-grid span {
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid #dbe6f3;
  border-radius: 8px;
  background: #f8fbff;
  color: #334155;
  font-size: 12px;
  line-height: 1.3;
}

.profit-summary-cell {
  display: flex;
  align-items: center;
  min-height: 100%;
}

.profit-summary-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  max-width: 148px;
  padding: 12px 14px;
  border: 1px solid #d8e4f2;
  border-radius: 14px;
  background: linear-gradient(180deg, #f9fbfe 0%, #f4f7fc 100%);
}

.profit-summary-row {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  width: 100%;
}

.profit-summary-rate {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border: 1px solid #b7dfb8;
  border-radius: 8px;
  color: #4caf50;
  background: #f6fff6;
  font-size: 12px;
  line-height: 1.4;
}

.profit-summary-metric {
  color: #334155;
  font-size: 13px;
  line-height: 1.5;
}

.profit-preview-head {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.profit-preview-card {
  display: grid;
  gap: 4px;
  padding: 14px 16px;
  border: 1px solid #dbe6f3;
  border-radius: 14px;
  background: #f8fbff;
}

.profit-preview-card span {
  color: #64748b;
  font-size: 12px;
}

.profit-preview-card strong {
  color: #0f172a;
  font-size: 20px;
  line-height: 1.2;
}

.profit-detail-head {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.profit-detail-card {
  display: grid;
  gap: 6px;
  padding: 14px 16px;
  border: 1px solid #dbe6f3;
  border-radius: 14px;
  background: linear-gradient(180deg, #fcfdff 0%, #f5f9ff 100%);
}

.profit-detail-card span {
  color: #64748b;
  font-size: 12px;
}

.profit-detail-card strong {
  color: #0f172a;
  font-size: 20px;
  line-height: 1.2;
}

.profit-value-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.profit-subline {
  color: #64748b;
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
}

.profit-positive {
  color: #15803d;
}

.profit-negative {
  color: #dc2626;
}

.profit-neutral {
  color: #64748b;
}

.profit-breakdown-panel {
  display: grid;
  gap: 12px;
  padding: 12px 8px;
}

.profit-breakdown-models {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.profit-breakdown-model {
  display: grid;
  gap: 12px;
  align-content: start;
}

.profit-breakdown-model__head {
  display: grid;
  gap: 4px;
}

.profit-breakdown-model__head strong {
  color: #0f172a;
  font-size: 14px;
}

.profit-breakdown-model__head span {
  color: #64748b;
  font-size: 12px;
}

.profit-breakdown-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.profit-breakdown-item {
  display: grid;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #f8fbff;
}

.profit-breakdown-item span {
  color: #64748b;
  font-size: 12px;
}

.profit-breakdown-item strong {
  color: #0f172a;
  font-size: 16px;
  line-height: 1.2;
}

.profit-breakdown-item.is-highlight {
  border-color: #bfd5f2;
  background: #eef6ff;
}

.profit-breakdown-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  color: #64748b;
  font-size: 12px;
}

.merge-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-height: 240px;
}

.merge-target-section,
.merge-compare-section,
.merge-counts-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  border: 1px solid #d9e3f0;
  border-radius: 16px;
  background: linear-gradient(180deg, #fcfdff 0%, #f7faff 100%);
}

.merge-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.merge-section-title {
  font-size: 16px;
  font-weight: 700;
  color: #1f2a37;
}

.merge-section-tip {
  font-size: 12px;
  color: #6b7280;
}

.merge-top-grid,
.merge-compare-grid {
  display: grid;
  gap: 16px;
  align-items: start;
}

.merge-product-card,
.merge-compare-column {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 16px;
  border-radius: 16px;
  border: 1px solid #dce7f5;
  background: #fff;
  box-shadow: 0 6px 18px rgba(31, 42, 55, 0.05);
}

.merge-product-card.is-target,
.merge-compare-column.is-target {
  border-color: #3b82f6;
  box-shadow: 0 10px 24px rgba(59, 130, 246, 0.12);
}

.merge-product-select {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #1f2937;
  cursor: pointer;
}

.merge-product-meta,
.merge-compare-column-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.merge-product-meta strong,
.merge-compare-column-meta strong {
  font-size: 15px;
  color: #111827;
  word-break: break-word;
}

.merge-product-meta span,
.merge-compare-column-meta span {
  font-size: 12px;
  color: #6b7280;
  word-break: break-word;
}

.merge-compare-column-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid #edf2f7;
}

.merge-field-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 14px;
  border: 1px solid #e5edf7;
  border-radius: 14px;
  background: #f8fbff;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
}

.merge-field-card:hover {
  border-color: #93c5fd;
  box-shadow: 0 8px 18px rgba(59, 130, 246, 0.08);
}

.merge-field-card.is-selected {
  border-color: #3b82f6;
  background: #eef6ff;
  box-shadow: 0 10px 24px rgba(59, 130, 246, 0.12);
}

.merge-field-label {
  font-size: 12px;
  color: #6b7280;
}

.merge-field-value {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
  word-break: break-word;
}

.merge-field-choice {
  font-size: 12px;
  color: #2563eb;
}

.merge-count-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
}

.merge-count-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px;
  border-radius: 12px;
  background: #fff;
  border: 1px solid #e6eef8;
}

@media (max-width: 1440px) {
  .merge-top-grid,
  .merge-compare-grid {
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)) !important;
  }
}

@media (max-width: 960px) {
  .profit-detail-head,
  .product-detail-summary,
  .profit-preview-head {
    grid-template-columns: 1fr;
  }

  .detail-filter-actions {
    width: 100%;
    margin-left: 0;
    padding-left: 0;
  }

  .detail-filter-actions :deep(.el-form-item__content) {
    width: 100%;
    justify-content: flex-start;
  }

  .profit-breakdown-models {
    grid-template-columns: 1fr;
  }

  .profit-breakdown-grid {
    grid-template-columns: 1fr 1fr;
  }
}
</style>

