<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { createLatestRequestGate } from "../../utils/request-gate";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import ProductTitleLink from "../../components/ProductTitleLink.vue";
import InventoryPageToolbar from "../../components/inventory/InventoryPageToolbar.vue";
import ProductCreateEditDialog from "../../components/inventory/ProductCreateEditDialog.vue";
import {
  applyFilterQuery,
  buildFilterQuery,
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
const profitPreviewDialogVisible = ref(false);
const profitPreviewDialogTitle = ref("");
const profitPreviewRows = ref([]);
const profitPreviewSummary = ref(null);
const dialogProduct = ref(null);
const selectedRows = ref([]);

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
    pageSize: 20
  }
});

const filterDefaults = {
  query: "",
  shopId: "all",
  dateFrom: "",
  dateTo: "",
  page: 1,
  pageSize: 20
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

const INVENTORY_PROFIT_TARGET_MARGIN = 0.2;

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
  return String(row?.settlement_state || "").toLowerCase() === "accrued";
}

function profitDetailCurrentProfit(row) {
  return profitDetailIsAccrued(row) ? profitDetailActualProfit(row) : profitDetailCalculatedProfit(row);
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
  if (profitDetailIsAccrued(row)) return "已入账";
  if (profitDetailHasCalculatedProfit(row)) return "已计算";
  return "待计算";
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

function applyRouteState() {
  syncingRoute = true;
  try {
    applyFilterQuery(route, state.filters, filterDefaults);
    if (route.query.productId && !state.filters.query) state.filters.query = String(route.query.productId);
  } finally {
    syncingRoute = false;
  }
}

function syncRouteQuery() {
  if (syncingRoute) return;
  const next = buildFilterQuery(route, state.filters, filterDefaults);
  if (JSON.stringify(route.query || {}) === JSON.stringify(next)) return;
  router.replace({ query: next });
}

function handleSearch() {
  state.filters.page = 1;
  loadPageData();
}

function handleReset() {
  Object.assign(state.filters, filterDefaults);
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
      `确认将库存产品「${row.name || row.id}」移出库存吗？`,
      "移出库存",
      {
        type: "warning",
        confirmButtonText: "移出库存",
        cancelButtonText: "取消"
      }
    );
    await apiClient.post(`/api/products/${row.id}/remove-from-inventory`, {});
    ElMessage.success("已移出库存");
    await loadPageData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "移出库存失败");
  }
}

async function recalculateProfits(row) {
  try {
    await apiClient.post(`/api/products/${row.id}/recalculate-profits`, {});
    ElMessage.success("该产品关联订单利润已重算");
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "重算利润失败");
  }
}

async function openProfitDetails(row) {
  profitDetailLoading.value = true;
  profitDetailDialogVisible.value = true;
  profitDetailDialogTitle.value = `${row.name || row.product_name} - 订单利润明细`;
  try {
    profitDetailRows.value = await apiClient.get(`/api/products/${row.id}/order-profit-details`);
  } catch (error) {
    profitDetailRows.value = [];
    ElMessage.error(error.message || "加载订单利润明细失败");
  } finally {
    profitDetailLoading.value = false;
  }
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
  router.push({
    path: "/procurement",
    query: {
      productId: String(row.id),
      from: "inventory-products"
    }
  });
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
      dateTo: String(state.filters.dateTo || "")
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
  () => [state.filters.query, state.filters.shopId, state.filters.dateFrom, state.filters.dateTo, state.filters.page, state.filters.pageSize],
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
      >
        <el-table-column type="selection" width="48" fixed="left" />
        <el-table-column label="产品信息" min-width="300" fixed="left">
          <template #default="{ row }">
            <div class="product-cell">
              <ProductImagePreview :src="row.image_url" />
              <div class="cell-stack">
                <ProductTitleLink :title="row.name || '-'" :lines="2" />
                <span class="muted-text">{{ row.inventory_id || row.code || "-" }}</span>
                <span class="muted-text">负责人：{{ row.owner_name || "-" }}</span>
                <span class="muted-text">店铺：{{ row.shop_names.join(" / ") || "-" }}</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="库存 / 在途" width="140" align="center">
          <template #default="{ row }">
            <div class="cell-stack cell-center">
              <strong>{{ integer(row.stock) }}</strong>
              <span class="muted-text">在途 {{ integer(row.incoming_stock) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="成本 / 售价" min-width="160" align="right">
          <template #default="{ row }">
            <div class="cell-stack cell-align-end">
              <strong>成本 ¥{{ money(row.avg_unit_cost) }}</strong>
              <span class="muted-text">售价 ¥{{ money(row.avg_sale_price) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="利润详情" min-width="230">
          <template #default="{ row }">
            <div class="profit-summary-cell">
              <template v-if="hasInventoryProfitPreview(row)">
                <div class="profit-summary-card">
                  <div class="profit-summary-row">
                    <span class="profit-summary-rate">{{ inventoryProfitMarginText(row) }}</span>
                  </div>
                  <div class="profit-summary-metric">利润 ¥{{ inventoryProfitMoneyText(row, "profit") }}</div>
                  <div class="profit-summary-metric">运费 ¥{{ inventoryProfitMoneyText(row, "transport") }}</div>
                  <div class="profit-summary-metric">建议售价 ¥{{ inventoryProfitMoneyText(row, "suggestedSaleRmb") }}</div>
                  <el-button link type="primary" class="sku-detail-link erp-btn-link" @click="openInventoryProfitDetails(row)">明细</el-button>
                </div>
              </template>
              <template v-else>
                <span class="muted-text">{{ inventoryProfitStatusText(row) }}</span>
              </template>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="历史销售" min-width="150" align="right">
          <template #default="{ row }">
            <div class="cell-stack cell-align-end">
              <strong>销售额 ¥{{ money(row.total_sales_amount) }}</strong>
              <span class="muted-text">订单 {{ integer(row.order_count) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="已绑定 SKU" min-width="320">
          <template #default="{ row }">
            <div class="sku-summary-cell">
              <template v-if="row.bound_sku_count">
                <div class="sku-preview-list">
                  <el-tag
                    v-for="mapping in row.sku_preview"
                    :key="mapping.id"
                    size="small"
                    effect="plain"
                    class="sku-preview-tag"
                  >
                    {{ mappingPreviewText(mapping) }}
                  </el-tag>
                  <span v-if="row.sku_preview_extra" class="sku-preview-extra">+{{ row.sku_preview_extra }}</span>
                </div>
                <el-button link type="primary" class="sku-detail-link erp-btn-link" @click="openMappingDetails(row)">查看详情</el-button>
              </template>
              <template v-else>
                <span class="muted-text">未绑定 SKU</span>
                <el-button link type="primary" class="sku-detail-link erp-btn-link" @click="openMappingDetails(row)">去绑定 SKU</el-button>
              </template>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">{{ dateText(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="380" fixed="right">
          <template #default="{ row }">
            <div class="erp-inline-actions">
              <el-button class="erp-btn-link" link type="primary" @click="openEditDialog(row)">编辑</el-button>
              <el-button class="erp-btn-link" link type="primary" @click="openMappingDetails(row)">{{ row.bound_sku_count ? "SKU 详情" : "去绑定 SKU" }}</el-button>
              <el-button class="erp-btn-link" link @click="openProcurement(row)">创建采购</el-button>
              <el-button class="erp-btn-link" link @click="openProfitDetails(row)">订单利润明细</el-button>
              <el-button class="erp-btn-link" link @click="openCancelDetails(row)">取消明细</el-button>
              <el-button class="erp-btn-link" link type="warning" @click="recalculateProfits(row)">重算利润</el-button>
              <el-button class="erp-btn-link erp-btn-link-danger" link type="danger" @click="removeFromInventory(row)">移出库存</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <PageFooterPagination
      :total="state.total"
      :page="state.filters.page"
      :page-size="state.filters.pageSize"
      
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

    <el-dialog v-model="profitDetailDialogVisible" :title="profitDetailDialogTitle" width="1280px" align-center class="erp-centered-dialog">
      <div class="profit-detail-head">
        <div class="profit-detail-card">
          <span>订单数</span>
          <strong>{{ integer(profitDetailSummary.orderCount) }}</strong>
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

      <el-table v-loading="profitDetailLoading" :data="profitDetailRows" stripe border class="erp-data-table">
        <el-table-column type="expand" width="56">
          <template #default="{ row }">
            <div class="profit-breakdown-panel">
              <div class="profit-breakdown-grid">
                <div
                  v-for="item in profitDetailBreakdownRows(row)"
                  :key="`${row.order_item_id || row.posting_number}-${item.label}`"
                  class="profit-breakdown-item"
                  :class="{ 'is-highlight': item.highlight }"
                >
                  <span>{{ item.label }}</span>
                  <strong :class="item.highlight ? profitDetailProfitClass(item.value) : ''">¥{{ money(item.value) }}</strong>
                </div>
              </div>
              <div class="profit-breakdown-meta">
                <span>成本来源：{{ row.cost_source || "-" }}</span>
                <span>公式：销售额 - 各项成本费用 = 当前利润</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="posting_number" label="订单号" min-width="180" />
        <el-table-column prop="shop_name" label="店铺" min-width="130" />
        <el-table-column prop="quantity" label="数量" width="80" align="center" />
        <el-table-column label="销售额" width="120" align="right">
          <template #default="{ row }">¥{{ money(profitDetailRevenue(row)) }}</template>
        </el-table-column>
        <el-table-column label="利润状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="profitDetailStatusTagType(row)">{{ profitDetailStatusText(row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="当前利润" width="150" align="right">
          <template #default="{ row }">
            <div class="profit-value-cell">
              <strong :class="profitDetailProfitClass(profitDetailCurrentProfit(row))">¥{{ money(profitDetailCurrentProfit(row)) }}</strong>
              <span class="profit-subline">预估 ¥{{ money(profitDetailEstimatedProfit(row)) }} / 已入账 ¥{{ money(profitDetailActualProfit(row)) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="利润率" width="100" align="right">
          <template #default="{ row }">{{ percent(profitDetailMargin(row)) }}</template>
        </el-table-column>
        <el-table-column label="成本合计" width="120" align="right">
          <template #default="{ row }">¥{{ money(profitDetailTotalCost(row)) }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="140" />
        <el-table-column prop="ordered_at" label="下单时间" min-width="170">
          <template #default="{ row }">{{ dateText(row.ordered_at) }}</template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog v-model="detailDialogVisible" :title="detailDialogTitle" width="980px" align-center class="erp-centered-dialog">
      <el-table v-loading="detailLoading" :data="detailRows" stripe border class="erp-data-table">
        <el-table-column prop="posting_number" label="订单号" min-width="180" />
        <el-table-column prop="shop_name" label="店铺" min-width="120" />
        <el-table-column prop="quantity" label="数量" width="80" align="center" />
        <el-table-column prop="sale_price" label="售价" width="110" align="right">
          <template #default="{ row }">{{ money(row.sale_price) }}</template>
        </el-table-column>
        <el-table-column prop="estimated_profit" label="利润" width="110" align="right">
          <template #default="{ row }">{{ money(row.actual_profit || row.estimated_profit) }}</template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="140" />
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

.cell-align-end {
  align-items: flex-end;
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
  .profit-preview-head {
    grid-template-columns: 1fr;
  }

  .profit-breakdown-grid {
    grid-template-columns: 1fr 1fr;
  }
}
</style>

