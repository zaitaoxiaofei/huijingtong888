<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { MagicStick } from "@element-plus/icons-vue";
import { Sparkles } from "lucide-vue-next";
import { apiClient } from "../../utils/api";
import { useAuthStore } from "../../stores/auth.js";
import { shanghaiDateTimeText } from "../../utils/shanghai-date.js";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import ProductTitleLink from "../../components/ProductTitleLink.vue";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import OzonCategorySelect from "../../components/listing/OzonCategorySelect.vue";

const loading = ref(false);
const dialogVisible = ref(false);
const dialogSubmitting = ref(false);
const importDialogVisible = ref(false);
const importLoading = ref(false);
const importSubmitting = ref(false);
const profitDialogVisible = ref(false);
const selectedRows = ref([]);
const formRef = ref();
const imageUploadLoading = ref(false);
const detailImageUploadLoading = ref(false);
const aiSellingPointsLoading = ref(false);
const manualLogisticsRule = ref(false);
const manualPackagingFee = ref(false);
const oneClickPublishingRows = ref(new Set());
const cancelingListingJobs = ref(new Set());
const retryingListingJobs = ref(new Set());
const materialOptionsLoading = ref(false);
const catalogDictionaryLoading = ref(false);
const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();
let listingJobPoller = null;
const routeEditOpened = ref(false);
const selectionWorkbenchReady = ref(false);
let selectionWorkbenchSaveTimer = 0;
const SELECTION_WORKBENCH_STORAGE_PREFIX = "selectionWorkbenchState:";
const selectionWorkbenchId = computed(() => String(route.query.workbenchId || "").trim());
const selectionWorkbenchStorageKey = computed(() => `${SELECTION_WORKBENCH_STORAGE_PREFIX}${selectionWorkbenchId.value || "default"}`);

function createAiWorkbenchId() {
  return `aiwb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSelectionWorkbenchId() {
  return `selwb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureSelectionWorkbenchRouteId() {
  if (selectionWorkbenchId.value) return;
  router.replace({
    query: {
      ...route.query,
      workbenchId: createSelectionWorkbenchId()
    }
  }).catch(() => {});
}

function selectionTabTitle() {
  const routeSku = String(route.query.sku || "").trim();
  const routeProductId = String(route.query.productId || "").trim();
  const formName = String(dialog.form?.name || "").trim();
  const currentRowId = String(dialog.currentRow?.id || "").trim();
  if (routeSku) return `选品池 · ${routeSku}`;
  if (dialogVisible.value && formName) return `选品池 · ${formName.slice(0, 18)}`;
  if (dialogVisible.value && currentRowId) return `选品池 · ID ${currentRowId}`;
  if (routeProductId) return `选品池 · ID ${routeProductId}`;
  return "选品池";
}

function syncSelectionWorkbenchTabTitle() {
  const nextTitle = selectionTabTitle();
  if (String(route.query.tabTitle || "").trim() === nextTitle) return;
  router.replace({
    query: {
      ...route.query,
      tabTitle: nextTitle
    }
  }).catch(() => {});
}

function saveSelectionWorkbenchState() {
  if (!selectionWorkbenchId.value) return;
  window.clearTimeout(selectionWorkbenchSaveTimer);
  selectionWorkbenchSaveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(selectionWorkbenchStorageKey.value, JSON.stringify({
        filters: state.filters,
        dialogVisible: dialogVisible.value,
        dialogMode: dialog.mode,
        dialogCurrentRowId: dialog.currentRow?.id || null,
        dialogForm: dialog.form,
        importDialogVisible: importDialogVisible.value,
        profitDialogVisible: profitDialogVisible.value,
        savedAt: new Date().toISOString()
      }));
    } catch (error) {
      console.warn("saveSelectionWorkbenchState failed", error);
    }
  }, 120);
}

function restoreSelectionWorkbenchState() {
  try {
    const raw = localStorage.getItem(selectionWorkbenchStorageKey.value)
      || localStorage.getItem("selectionWorkbenchState");
    if (!raw) return;
    const parsed = JSON.parse(raw || "{}");
    if (parsed?.filters) Object.assign(state.filters, parsed.filters);
    if (parsed?.dialogForm) {
      dialog.mode = parsed.dialogMode || "create";
      dialog.currentRow = parsed.dialogCurrentRowId ? { id: parsed.dialogCurrentRowId } : null;
      dialog.form = { ...createDefaultForm(), ...parsed.dialogForm };
      dialogVisible.value = Boolean(parsed.dialogVisible);
    }
    importDialogVisible.value = Boolean(parsed?.importDialogVisible);
    profitDialogVisible.value = Boolean(parsed?.profitDialogVisible);
  } catch {
    localStorage.removeItem(selectionWorkbenchStorageKey.value);
  }
}

const state = reactive({
  rows: [],
  total: 0,
  summary: {
    products: 0,
    quotedRows: 0,
    missingQuoteRows: 0,
    avgPurchaseCost: 0,
    status_counts: {}
  },
  people: [],
  suppliers: [],
  logisticsRules: [],
  filters: {
    query: "",
    ownerPersonId: "all",
    quoteStatus: "all",
    businessStatus: "all",
    page: 1,
    pageSize: 20
  }
});

const importState = reactive({
  fileName: "",
  rows: [],
  total: 0,
  valid: 0,
  invalid: 0
});

const dialog = reactive({
  mode: "create",
  currentRow: null,
  form: createDefaultForm()
});

const profitDialog = reactive({
  row: null,
  channelKey: "air",
  quote: null,
  logisticsRule: null
});

const listingShopDialog = reactive({
  visible: false,
  loading: false,
  submitting: false,
  row: null,
  shops: [],
  selectedShopIds: []
});

const formRules = {
  name: [{ required: true, message: "请输入商品名称", trigger: "blur" }],
  owner_person_id: [{ required: true, message: "请选择负责人", trigger: "change" }],
  purchase_quantity: [{ required: true, message: "请输入采购数量", trigger: "blur" }]
};

const fallbackMaterialOptions = ["热塑性弹性体", "塑料", "高分子材料", "锌合金", "生态皮革", "聚氯乙烯", "ABS塑料", "不锈钢"];
const materialOptions = ref([...fallbackMaterialOptions]);
const vehicleBrandOptions = ref([]);
const vehicleOptions = ref([]);
const fallbackColorOptions = ["黑色", "白色", "紫色", "红色", "蓝色", "绿色", "银色", "金色", "灰色", "棕色", "透明"];
const colorOptions = ref([...fallbackColorOptions]);

function createDefaultForm() {
  return {
    id: null,
    updated_at: "",
    name: "",
    ozon_category_id: "",
    ozon_description_category_id: "",
    ozon_type_id: "",
    ozon_category_name: "",
    image_url: "",
    detail_image_urls: [],
    material: "TPU",
    color: ["黑色"],
    vehicle_brand: "",
    vehicle_model: "",
    selling_points: "",
    purchase_url: "",
    source_platform: "1688",
    supplier_id: "",
    supplier_note: "",
    owner_person_id: "",
    shipping_method: "air_land",
    logistics_rule_id: "",
    purchase_cost: 0,
    domestic_shipping: 0,
    handling_fee: 0.3,
    purchase_quantity: 1,
    package_weight_g: 0,
    length_cm: 30,
    width_cm: 20,
    height_cm: 10,
    sale_price_rmb: 0,
    listing_price_rub: 0,
    air_sale_price_rmb: 0,
    exchange_rate: 11.32,
    advertising_rate: 0,
    desired_profit_mode: "margin",
    desired_profit_value: 20,
    return_rate: 5,
    product_type: "selection",
    selection_status: "draft",
    source_selection_id: null,
    variant_task_id: "",
    variant_result_id: "",
    variant_type: "",
    is_variant_generated: 0,
    material_asset_status: ""
  };
}

const total = computed(() => state.total);
const pagedRows = computed(() => state.rows);
const summary = computed(() => state.summary);
const currentUserPersonId = computed(() => Number(authStore.user?.id || 0) || null);

const dialogTitle = computed(() => (dialog.mode === "create" ? "新增选品" : "编辑选品"));
const importPreviewRows = computed(() => importState.rows.slice(0, 12));
const importCommitRows = computed(() => importState.rows.filter((row) => row.ok).map((row) => row.data));

watch(() => dialog.form.ozon_category_id, (value) => {
  if (value) return;
  dialog.form.ozon_description_category_id = "";
  dialog.form.ozon_type_id = "";
  dialog.form.ozon_category_name = "";
});

watch(
  () => [dialog.form.ozon_description_category_id, dialog.form.ozon_type_id],
  () => {
    if (dialogVisible.value) loadCatalogDictionariesForCurrentCategory();
  }
);

watch(
  [
    () => JSON.stringify(state.filters),
    () => dialogVisible.value,
    () => dialog.mode,
    () => JSON.stringify(dialog.form),
    () => importDialogVisible.value,
    () => profitDialogVisible.value
  ],
  () => {
    if (!selectionWorkbenchReady.value) return;
    saveSelectionWorkbenchState();
  }
);

watch(
  [
    () => route.query.sku,
    () => route.query.productId,
    () => dialogVisible.value,
    () => dialog.form.name,
    () => dialog.currentRow?.id
  ],
  () => {
    if (!selectionWorkbenchReady.value || !selectionWorkbenchId.value) return;
    syncSelectionWorkbenchTabTitle();
  }
);
const catalogDictionaryCache = new Map();
let catalogDictionaryRequestSeq = 0;
const profitDetailRows = computed(() => buildProfitDetailRows(
  profitDialog.row,
  profitDialog.quote,
  profitDialog.channelKey,
  profitDialog.logisticsRule
));
const selectionPreviewRows = computed(() => [
  { label: "采购均摊成本", value: money(getPurchaseCostPerUnit(dialog.form)), note: "已含采购单价、国内运费均摊和处理费" },
  { label: "物流费用", value: money(previewNumbers.value.transport.totalRmb), note: selectedLogisticsRule.value?.name || "-" },
  { label: "佣金", value: money(previewNumbers.value.commission), note: `${percentText(getCommissionRate(previewNumbers.value.listingPriceRub || 0) * 100, 1)}` },
  { label: "末公里+银行", value: money(previewNumbers.value.finalMile), note: "按当前售价计算" },
  { label: "提现费", value: money(previewNumbers.value.withdrawal), note: "按当前售价与运费计算" },
  { label: "广告预算", value: money(previewNumbers.value.advertising), note: percentText(Number(dialog.form.advertising_rate || 0), 1) },
  { label: "退货损失", value: money(previewNumbers.value.returnLoss), note: `退货率 ${percentText(Number(dialog.form.return_rate || 0), 1)}` },
  { label: "净利润", value: money(previewNumbers.value.profit), note: `净利率 ${percentText(previewNumbers.value.margin, 1)}` }
]);
const selectionPreviewCards = computed(() => [
  { label: "当前售价", value: `¥${money(previewNumbers.value.saleRmb)}`, hint: "手动填写优先" },
  { label: "净利润率", value: percentText(previewNumbers.value.margin, 1), hint: "按当前售价计算" },
  { label: "净利润", value: `¥${money(previewNumbers.value.profit)}`, hint: "扣除全部费用后" },
  { label: "建议售价", value: `¥${money(previewNumbers.value.suggestedSaleRmb)}`, hint: previewNumbers.value.targetMode === "margin" ? "按利润率反推" : "按利润额反推" },
  { label: "目标利润率", value: percentText(previewNumbers.value.targetMargin, 1), hint: "模型目标值" },
  { label: "目标利润额", value: `¥${money(previewNumbers.value.targetProfit)}`, hint: "按当前售价换算" }
]);
const selectionPreviewCurrentRow = computed(() => selectionPreviewCards.value.slice(0, 3));
const selectionPreviewSuggestedRow = computed(() => selectionPreviewCards.value.slice(3, 6));
const logisticsRuleOptions = computed(() => [...state.logisticsRules].sort((a, b) => {
  const priority = logisticsRulePriority(a) - logisticsRulePriority(b);
  if (priority) return priority;
  const heat = Number(b.usage_count || 0) - Number(a.usage_count || 0);
  if (heat) return heat;
  const celA = String(a.carrier || "").toUpperCase() === "CEL" ? 1 : 0;
  const celB = String(b.carrier || "").toUpperCase() === "CEL" ? 1 : 0;
  if (celA !== celB) return celB - celA;
  const airA = isAirLandLogisticsRule(a) ? 1 : 0;
  const airB = isAirLandLogisticsRule(b) ? 1 : 0;
  if (airA !== airB) return airB - airA;
  return Number(a.min_weight_g || 0) - Number(b.min_weight_g || 0) || Number(a.id || 0) - Number(b.id || 0);
}));
const selectedLogisticsRule = computed(() => resolveSelectedLogisticsRule(dialog.form));
const previewNumbers = computed(() => buildSelectionPreview(dialog.form, selectedLogisticsRule.value));
const profitFormulaText = "净利润 = 售价 - 均摊采购成本 - 国际运费 - 佣金 - 尾程+银行 - 提现费 - 广告预算 - 退货损失";

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function isAirLandLogisticsRule(rule) {
  const text = normalizeText(`${rule?.name || ""} ${rule?.channel || ""} ${rule?.filter_keywords || ""}`);
  return text.includes("陆空") || text.includes("air") || text.includes("standard") || text.includes("express");
}

function logisticsRulePriority(rule) {
  const text = normalizeText(`${rule?.name || ""} ${rule?.carrier || ""} ${rule?.channel || ""}`);
  if (text.includes("中国邮政") || text.includes("china post")) return 0;
  if ((text.includes("cel") || text.includes("cl")) && (text.includes("陆空") || text.includes("标准") || text.includes("standard"))) return 1;
  return 2;
}

function logisticsRuleLabel(rule) {
  return `${rule.name} · ${rule.carrier}/${rule.channel} · ${numberText(rule.min_weight_g)}-${numberText(rule.max_weight_g)}g`;
}

function normalizePagedRows(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

function normalizePagedTotal(payload, fallbackRows = []) {
  return Array.isArray(payload) ? fallbackRows.length : Number(payload?.total || 0);
}

function buildSelectionQuery(options = {}) {
  const params = new URLSearchParams({
    paged: "1",
    page: String(state.filters.page),
    pageSize: String(state.filters.pageSize),
    quoteStatus: String(state.filters.quoteStatus || "all"),
    businessStatus: String(state.filters.businessStatus || "all"),
    ownerPersonId: String(state.filters.ownerPersonId || "all")
  });
  if (options.summaryMode) params.set("summaryMode", String(options.summaryMode));
  const searchText = String(state.filters.query || "").trim();
  if (searchText) params.set("query", searchText);
  return params.toString();
}

function money(value) {
  return Number(value || 0).toFixed(1);
}

function numberText(value, digits = 0) {
  return Number(value || 0).toFixed(digits);
}

function selectNumericInput(event) {
  const input = event?.target?.closest?.(".el-input-number")?.querySelector?.("input") || event?.target;
  window.requestAnimationFrame(() => input?.select?.());
}

function normalizeTagValue(value) {
  return Array.isArray(value) ? value.filter(Boolean).join("+") : String(value || "").trim();
}

function catalogOptionValue(item) {
  return typeof item === "string" ? item : String(item?.value || item?.label || "").trim();
}

function catalogOptionLabel(item) {
  if (typeof item === "string") return item;
  const label = String(item?.label || item?.display_value_zh || item?.displayValueZh || "").trim();
  const value = String(item?.value || "").trim();
  return label && label !== value ? `${label} / ${value}` : label || value;
}

function normalizeColorTags(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  const text = String(value || "").trim();
  if (!text) return ["黑色"];
  return text.split(/\s*[+＋,，/、]\s*/).filter(Boolean);
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function percentText(value, digits = 1) {
  return `${numberText(value, digits)}%`;
}

function toNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseCommissionList(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.commissions)) return parsed.commissions;
    return parsed ? [parsed] : [];
  } catch {
    return [];
  }
}

function normalizeSchemaHint(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (text.includes("rfbs")) return "rfbs";
  if (text.includes("fbs")) return "fbs";
  if (text.includes("fbo")) return "fbo";
  if (text.includes("fbp")) return "fbp";
  return text;
}

function selectCommissionEntry(list, row) {
  const schemaHints = [
    row?.sale_schema,
    row?.schema,
    row?.delivery_schema,
    row?.stock_type,
    row?.shipping_method
  ].map(normalizeSchemaHint).filter(Boolean);
  for (const hint of schemaHints) {
    const exact = list.find((item) => normalizeSchemaHint(item.sale_schema || item.schema || item.delivery_schema || item.type) === hint);
    if (exact) return exact;
  }
  if (schemaHints.some((hint) => hint.includes("fbo") || hint.includes("fbp"))) {
    return list.find((item) => {
      const normalized = normalizeSchemaHint(item.sale_schema || item.schema || item.delivery_schema || item.type);
      return normalized.includes("fbo") || normalized.includes("fbp");
    });
  }
  return list.find((item) => normalizeSchemaHint(item.sale_schema || item.schema || item.delivery_schema || item.type).includes("fbs"));
}

function getOzonCommissionRate(row) {
  const raw = row?.commissions_json || row?.ozon_commissions_json || row?.commission_json;
  const list = parseCommissionList(raw);
  if (!list.length) return null;
  const preferred = selectCommissionEntry(list, row) || list[0];
  const value = [
    preferred?.percent,
    preferred?.commission,
    preferred?.rate,
    preferred?.value
  ].map(toNumberOrNull).find((item) => item !== null && item > 0);
  if (value === undefined || value === null) return null;
  return value > 1 ? value / 100 : value;
}

function dateText(value) {
  return shanghaiDateTimeText(value, { assumeUtcWhenNaive: true });
}

function getSupplierName(supplierId) {
  const matched = state.suppliers.find((item) => Number(item.id) === Number(supplierId));
  return matched?.name || "-";
}

function personName(id) {
  return state.people.find((person) => Number(person.id) === Number(id))?.name || "";
}

function importStatusText(row) {
  return [...(row.errors || []), ...(row.warnings || [])].join("；");
}

function getPricing(row) {
  return row?.pricing && typeof row.pricing === "object" ? row.pricing : null;
}

function getQuote(row, channelKey) {
  const pricing = getPricing(row);
  return pricing?.[channelKey] || null;
}

function getSuggestedRub(row, channelKey) {
  const pricing = getPricing(row);
  return pricing?.[channelKey === "air" ? "suggestedRub_air" : "suggestedRub_land"] ?? null;
}

function getLogisticsRuleForRow(row) {
  if (!row) return null;
  if (row.logistics_rule_id) {
    const directMatch = state.logisticsRules.find((item) => Number(item.id) === Number(row.logistics_rule_id));
    if (directMatch) return directMatch;
  }
  return resolveSelectedLogisticsRule(row) || null;
}

function getActiveChannelKey(row, logisticsRule = getLogisticsRuleForRow(row)) {
  const method = String(logisticsRule?.channel || row?.shipping_method || "air_land");
  return method === "land" ? "land" : "air";
}

function getCurrentQuote(row, logisticsRule = getLogisticsRuleForRow(row)) {
  if (!row) return null;
  const preview = buildSelectionPreview(row, logisticsRule);
  const channelKey = getActiveChannelKey(row, logisticsRule);
  return {
    ...preview.transport,
    channelKey,
    amount: Number(preview.transport?.totalRmb || 0),
    commission: Number(preview.commission || 0),
    finalMileBankFee: Number(preview.finalMile || 0),
    withdrawalFee: Number(preview.withdrawal || 0),
    advertisingCost: Number(preview.advertising || 0),
    expectedReturnLoss: Number(preview.returnLoss || 0),
    profit: Number(preview.profit || 0),
    margin: Number(preview.margin || 0),
    totalCost: Number(preview.totalCost || 0)
  };
}

function getCurrentSuggestedRub(row, logisticsRule = getLogisticsRuleForRow(row)) {
  if (!row) return null;
  return estimateCurrentSaleRow(row, logisticsRule).listingPriceRub || null;
}
function buildPreviewDetailRows(row, preview, logisticsRule) {
  if (!row || !preview) return [];
  const purchaseQty = Math.max(Number(row.purchase_quantity || 1), 1);
  const domesticShare = Number(row.domestic_shipping || 0) / purchaseQty;
  const sale = Number(preview.saleRmb || 0);
  const commissionRate = sale ? Number(preview.commission || 0) / sale : 0;
  const channelKey = getActiveChannelKey(row, logisticsRule);
  const transportRuleNote = logisticsRule
    ? `${logisticsRule.name || "-"} / ${logisticsRule.carrier || "-"} / ${logisticsRule.channel || "-"}`
    : "未匹配到物流规则";
  return [
    { label: "售价", value: money(sale), note: "当前填写或按目标利润反推后的售价 RMB" },
    {
      label: "采购均摊成本",
      value: money(getPurchaseCostPerUnit(row)),
      note: `已含采购单价 ${money(row.purchase_cost)} + 国内运费均摊 ${money(domesticShare)}${Number(row.handling_fee || 0) ? ` + 处理费 ${money(row.handling_fee)}` : ""}`
    },
    { label: "运输方式", value: methodName(channelKey), note: transportRuleNote },
    { label: "国际运费", value: money(preview.transport?.totalRmb || 0), note: logisticsRule?.name || "-" },
    { label: "Ozon 佣金", value: money(preview.commission), note: `售价 x ${percentText(commissionRate * 100)}` },
    { label: "末公里+银行", value: money(preview.finalMile), note: "售价 x 1.4% + 阶梯末公里费" },
    { label: "提现费", value: money(preview.withdrawal), note: "(售价 - 末公里+银行 - 运费 - 售价 x 20%) x 1.2%" },
    { label: "广告预算", value: money(preview.advertising), note: percentText(Number(row.advertising_rate || 0), 1) },
    { label: "退货损失", value: money(preview.returnLoss), note: `退货率 ${percentText(Number(row.return_rate || 0), 1)}` },
    { label: "成本合计", value: money(preview.totalCost), note: "除售价外所有扣减项合计" },
    { label: "净利润", value: money(preview.profit), note: `售价 - 成本合计，净利率 ${percentText(preview.margin)}` }
  ];
}

function getSaleRmb(product) {
  const listed = Number(product?.listing_price_rub || 0);
  const exchangeRate = Number(product?.exchange_rate || 11.32);
  return Number(product?.air_sale_price_rmb || 0) || (exchangeRate > 0 ? listed / exchangeRate : 0);
}

function getPurchaseCostPerUnit(product) {
  const quantity = Math.max(Number(product?.purchase_quantity || 1), 1);
  return Number(product?.purchase_cost || 0) + Number(product?.domestic_shipping || 0) / quantity + Number(product?.handling_fee || 0);
}

function getSalePriceRmb(product) {
  return Number(product?.sale_price_rmb || product?.air_sale_price_rmb || 0);
}

function getListingPriceRub(product) {
  return Number(product?.listing_price_rub || 0);
}

function methodName(method) {
  if (method === "land") return "陆运";
  if (method === "air" || method === "air_land") return "陆空";
  if (method === "sea") return "海运";
  return "未标明";
}

function profitModeLabel(mode) {
  return mode === "profit" ? "利润额" : "净利率";
}

function profitModeValue(row) {
  const value = Number(row?.desired_profit_value || 0);
  return row?.desired_profit_mode === "profit" ? value : value > 1 ? value : value * 100;
}

function resolvedAdvertisingRate(row) {
  const value = Number(row?.advertising_rate || 0);
  return value > 1 ? value / 100 : value;
}

function resolvedReturnRate(row) {
  const value = Number(row?.return_rate ?? 0.05);
  return value > 1 ? value / 100 : value;
}

function resolvePackagingAmount(row) {
  const sale = Number(row?.sale_price_rmb || row?.air_sale_price_rmb || 0);
  if (sale > 0) return sale;
  const listed = Number(row?.listing_price_rub || 0);
  const exchangeRate = Number(row?.exchange_rate || 0);
  if (listed > 0 && exchangeRate > 0) return listed / exchangeRate;
  return Number(row?.purchase_cost || 0);
}

function getDefaultPackagingFee(row) {
  const weight = Number(row?.package_weight_g || 0);
  const amount = resolvePackagingAmount(row);
  if (weight < 100 && amount < 50) return 0.3;
  if (weight < 500 && amount < 100) return 0.5;
  return 1.0;
}

function syncPackagingFee(row = dialog.form) {
  if (manualPackagingFee.value) return;
  dialog.form.handling_fee = getDefaultPackagingFee(row);
}

function estimateCurrentSaleRow(row, logisticsRule) {
  const purchaseUnit = getPurchaseCostPerUnit(row);
  const quantity = Math.max(Number(row?.purchase_quantity || 1), 1);
  const transport = getTransportEstimate(row, logisticsRule);
  const targetMode = String(row?.desired_profit_mode || "margin");
  const targetValue = Number(row?.desired_profit_value || 0);
  const returnRate = resolvedReturnRate(row);
  const exchangeRate = Number(row?.exchange_rate || 11.32);
  const saleForRate = Number(row?.sale_price_rmb || row?.air_sale_price_rmb || 0);
  const listingPriceRub = Number(row?.listing_price_rub || 0) || roundMoney(saleForRate * exchangeRate);
  const commissionRate = getResolvedCommissionRate(row, listingPriceRub);
  const adRate = resolvedAdvertisingRate(row);
  const finalMileRate = 0.014;
  const withdrawalRate = Number(row?.withdrawal_fee_rate ?? 0.012);
  const finalMile = (saleRmb) => saleRmb * finalMileRate + (saleRmb < 50 ? 1 : saleRmb >= 750 ? 15 : saleRmb * 0.02);
  const withdrawal = (saleRmb, freightRmb) => Math.max(0, saleRmb - finalMile(saleRmb) - freightRmb - saleRmb * 0.2) * withdrawalRate;
  const returnLoss = (purchaseUnit + transport.totalRmb) * returnRate;
  const totalCostExceptSale = purchaseUnit + transport.totalRmb + returnLoss;

  if (targetMode === "profit") {
    const targetProfit = targetValue;
    const saleRmb = roundMoney((totalCostExceptSale + targetProfit + 0) / Math.max(0.01, 1 - commissionRate - adRate - returnRate - withdrawalRate - finalMileRate));
    return {
      saleRmb,
      listingPriceRub: roundMoney(saleRmb * exchangeRate),
      modeLabel: profitModeLabel(targetMode),
      targetText: `${money(targetProfit)} RMB`
    };
  }

  const targetMargin = targetValue > 1 ? targetValue / 100 : targetValue;
  const saleRmb = roundMoney(totalCostExceptSale / Math.max(0.01, 1 - commissionRate - adRate - returnRate - withdrawalRate - finalMileRate - targetMargin));
  return {
    saleRmb,
    listingPriceRub: roundMoney(saleRmb * exchangeRate),
    modeLabel: profitModeLabel(targetMode),
    targetText: percentText(targetMargin * 100)
  };
}

function getTransportEstimate(row, logisticsRule) {
  const rule = logisticsRule || {};
  const weight = Number(row?.package_weight_g || 0);
  const quantity = Math.max(Number(row?.purchase_quantity || 1), 1);
  const purchaseUnit = getPurchaseCostPerUnit(row);
  const base = Number(rule.base_fee_cny || 0);
  const perGram = Number(rule.per_gram_cny || 0);
  const perTicket = Number(rule.per_ticket_cny || 0);
  const amount = roundMoney(base + weight * perGram + perTicket);
  return {
    rule,
    totalRmb: amount,
    totalCny: amount,
    unitPurchase: roundMoney(purchaseUnit),
    unitDomestic: roundMoney(Number(row?.domestic_shipping || 0) / quantity)
  };
}

function getCommissionRate(listingPriceRub) {
  return Number(listingPriceRub || 0) <= 1500 ? 0.12 : 0.17;
}

function getResolvedCommissionRate(row, listingPriceRub) {
  const ozonRate = getOzonCommissionRate(row);
  if (ozonRate !== null) return ozonRate;
  const low = Number(row?.commission_low ?? 0.12);
  const high = Number(row?.commission_high ?? 0.17);
  return Number(listingPriceRub || 0) <= 1500 ? low : high;
}

function resolveSelectedLogisticsRule(row) {
  if (manualLogisticsRule.value && row?.logistics_rule_id) {
    return state.logisticsRules.find((item) => Number(item.id) === Number(row.logistics_rule_id)) || null;
  }
  const weight = Number(row?.package_weight_g || 0);
  const saleRmb = Number(row?.sale_price_rmb || row?.air_sale_price_rmb || 0) || (Number(row?.listing_price_rub || 0) / Number(row?.exchange_rate || 11.32));
  const matched = logisticsRuleOptions.value.find((rule) => {
    const minWeight = Number(rule.min_weight_g || 0);
    const maxWeight = Number(rule.max_weight_g || Infinity);
    const minPrice = Number(rule.min_price_rub || 0);
    const maxPrice = Number(rule.max_price_rub || Infinity);
    return weight >= minWeight && weight <= maxWeight && saleRmb * Number(row?.exchange_rate || 11.32) >= minPrice && saleRmb * Number(row?.exchange_rate || 11.32) <= maxPrice;
  });
  return matched || logisticsRuleOptions.value[0] || null;
}

function buildSelectionPreview(row, logisticsRule) {
  if (!row) {
    return {
      saleRmb: 0,
      listingPriceRub: 0,
      profit: 0,
      margin: 0,
      suggestedSaleRmb: 0,
      totalCost: 0
    };
  }

  const sale = getSalePriceRmb(row);
  const targetMode = String(row.desired_profit_mode || "margin");
  const adRate = resolvedAdvertisingRate(row);
  const purchaseUnit = getPurchaseCostPerUnit(row);
  const transport = getTransportEstimate(row, logisticsRule);
  const suggested = estimateCurrentSaleRow(row, logisticsRule);
  const saleResolved = sale > 0 ? sale : suggested.saleRmb;
  const listingPriceRub = Number(row.listing_price_rub || suggested.listingPriceRub || saleResolved * Number(row.exchange_rate || 11.32));
  const commission = saleResolved * getResolvedCommissionRate(row, listingPriceRub);
  const finalMile = saleResolved * 0.014 + (saleResolved < 50 ? 1 : saleResolved >= 750 ? 15 : saleResolved * 0.02);
  const withdrawal = Math.max(0, saleResolved - finalMile - transport.totalRmb - saleResolved * 0.2) * Number(row.withdrawal_fee_rate || 0.012);
  const advertising = saleResolved * adRate;
  const returnLoss = (purchaseUnit + transport.totalRmb) * resolvedReturnRate(row);
  const profit = roundMoney(saleResolved - purchaseUnit - transport.totalRmb - commission - finalMile - withdrawal - advertising - returnLoss);
  const margin = saleResolved > 0 ? roundMoney((profit / saleResolved) * 100) : 0;
  const targetMargin = targetMode === "margin"
    ? (Number(row.desired_profit_value || 0) > 1 ? Number(row.desired_profit_value || 0) : Number(row.desired_profit_value || 0) * 100)
    : (saleResolved > 0 ? (Number(row.desired_profit_value || 0) / saleResolved) * 100 : 0);
  const targetProfit = targetMode === "profit"
    ? Number(row.desired_profit_value || 0)
    : saleResolved * (targetMargin / 100);

  return {
    saleRmb: roundMoney(saleResolved),
    listingPriceRub: roundMoney(Number(row.listing_price_rub || suggested.listingPriceRub || 0)),
    profit,
    margin,
    suggestedSaleRmb: suggested.saleRmb,
    totalCost: roundMoney(saleResolved - profit),
    targetMode,
    targetText: profitModeLabel(targetMode) === "净利率" ? percentText(Number(row.desired_profit_value || 0), 1) : money(Number(row.desired_profit_value || 0)),
    targetMargin: roundMoney(targetMargin),
    targetProfit: roundMoney(targetProfit),
    transport,
    commission,
    finalMile,
    withdrawal,
    advertising,
    returnLoss
  };
}

function syncListingPriceFromSale() {
  const salePrice = Number(dialog.form.sale_price_rmb || 0);
  dialog.form.listing_price_rub = roundMoney(salePrice * Number(dialog.form.exchange_rate || 11.32));
  dialog.form.air_sale_price_rmb = salePrice;
}

async function readImageAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

async function handleImageUpload(file) {
  const rawFile = file;
  if (!rawFile) return false;
  imageUploadLoading.value = true;
  try {
    const dataUrl = await readImageAsDataUrl(rawFile);
    dialog.form.image_url = dataUrl;
    ElMessage.success("图片已导入");
    return false;
  } catch (error) {
    ElMessage.error(error.message || "图片导入失败");
    return false;
  } finally {
    imageUploadLoading.value = false;
  }
}

function handleImageUploadChange(uploadFile) {
  return handleImageUpload(uploadFile?.raw || uploadFile);
}

function clearUploadedImage() {
  dialog.form.image_url = "";
}

function normalizeDetailImages(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
  } catch {
    // Fall back to delimiter parsing for older text payloads.
  }
  return String(value).split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

async function handleDetailImageUploadChange(uploadFile) {
  const rawFile = uploadFile?.raw || uploadFile;
  if (!rawFile) return false;
  detailImageUploadLoading.value = true;
  try {
    const dataUrl = await readImageAsDataUrl(rawFile);
    dialog.form.detail_image_urls = [...normalizeDetailImages(dialog.form.detail_image_urls), dataUrl];
    ElMessage.success("详情图已导入");
    return false;
  } catch (error) {
    ElMessage.error(error.message || "详情图导入失败");
    return false;
  } finally {
    detailImageUploadLoading.value = false;
  }
}

function removeDetailImage(index) {
  dialog.form.detail_image_urls = normalizeDetailImages(dialog.form.detail_image_urls).filter((_, itemIndex) => itemIndex !== index);
}

async function goToListing(row, shopIds = []) {
  const id = Number(row?.id || 0);
  if (!id || oneClickPublishingRows.value.has(id) || isListingJobActive(row)) return;
  if (!Number(row?.package_weight_g || 0)) {
    ElMessage.warning("请先填写包装克重后再一键上架");
    return;
  }
  if (String(row?.selection_status || "") === "listed") {
    try {
      await ElMessageBox.confirm(
        `产品“${row.name || row.selection_id || row.id}”已上架过，是否继续上架？`,
        "确认重复上架",
        { type: "warning", confirmButtonText: "继续上架", cancelButtonText: "取消" }
      );
    } catch (error) {
      if (error === "cancel" || error === "close" || error?.message === "cancel") return;
      throw error;
    }
  }
  oneClickPublishingRows.value = new Set([...oneClickPublishingRows.value, id]);
  try {
    const result = await apiClient.post("/api/asset-variant-engine/publish-selection", {
      productId: id,
      shopIds: uniqueNumbers(shopIds)
    });
    if (result.accepted) {
      ElMessage.success(result.note || `后台上架任务已创建：${result.jobNo || result.jobId || ""}`);
      await loadPageData();
    } else if (result.ok) {
      ElMessage.success(result.note || `已自动提交 ${result.published || 0} 个店铺到 Ozon`);
      await loadPageData();
    } else {
      ElMessage.warning(result.note || "一键上架已执行，但没有成功提交的店铺");
    }
  } catch (error) {
    ElMessage.error(error.message || "一键上架失败");
  } finally {
    const next = new Set(oneClickPublishingRows.value);
    next.delete(id);
    oneClickPublishingRows.value = next;
  }
}

async function openListingShopDialog(row) {
  const id = Number(row?.id || 0);
  if (!id || oneClickPublishingRows.value.has(id) || isListingJobActive(row)) return;
  listingShopDialog.visible = true;
  listingShopDialog.loading = true;
  listingShopDialog.row = row;
  listingShopDialog.shops = [];
  listingShopDialog.selectedShopIds = [];
  try {
    const data = await apiClient.get(`/api/asset-variant-engine/selection-publish-shops?productId=${encodeURIComponent(id)}`, { noCache: true });
    const ownerRow = {
      ...row,
      owner_name: row.owner_name || row.owner_person_name || data?.ownerName || "",
      owner_person_id: row.owner_person_id || data?.ownerPersonId || ""
    };
    const shops = Array.isArray(data?.shops) ? data.shops : [];
    listingShopDialog.shops = shops
      .filter((shop) => String(shop.status || "").toLowerCase() !== "deleted")
      .map((shop) => normalizeListingShopOption(shop, ownerRow))
      .filter((shop) => shop.id)
      .sort(compareListingShopOptions);
    const recommended = listingShopDialog.shops.filter((shop) => shop.recommended).map((shop) => shop.id);
    listingShopDialog.selectedShopIds = recommended.length ? recommended : listingShopDialog.shops.map((shop) => shop.id);
  } catch (error) {
    ElMessage.error(error.message || "加载店铺失败");
    listingShopDialog.visible = false;
  } finally {
    listingShopDialog.loading = false;
  }
}

function closeListingShopDialog() {
  if (listingShopDialog.submitting) return;
  listingShopDialog.visible = false;
  listingShopDialog.row = null;
  listingShopDialog.shops = [];
  listingShopDialog.selectedShopIds = [];
}

function selectAllListingShops() {
  listingShopDialog.selectedShopIds = listingShopDialog.shops.map((shop) => shop.id);
}

function clearListingShops() {
  listingShopDialog.selectedShopIds = [];
}

function selectOwnerListingShops() {
  const matched = listingShopDialog.shops
    .filter((shop) => shop.priceGroup === "owner")
    .map((shop) => shop.id);
  listingShopDialog.selectedShopIds = matched.length ? matched : listingShopDialog.selectedShopIds;
}

function selectMainPriceListingShops() {
  const matched = listingShopDialog.shops
    .filter((shop) => shop.priceGroup === "main" || shop.priceGroup === "owner")
    .map((shop) => shop.id);
  listingShopDialog.selectedShopIds = matched.length ? matched : listingShopDialog.selectedShopIds;
}

function normalizeListingShopOption(shop = {}, row = {}) {
  const price = listingShopPriceDecision(shop, row);
  return {
    id: Number(shop.id),
    name: String(shop.name || `店铺 ${shop.id}`),
    legalEntity: String(shop.legal_entity || shop.legalEntity || ""),
    status: String(shop.status || ""),
    priceRole: String(shop.rule?.priceRole || shop.rule?.price_role || ""),
    priceIndex: price.index,
    priceGroup: price.group,
    priceLabel: price.label,
    recommended: price.recommended,
    sortRank: price.sortRank
  };
}

function compareListingShopOptions(left, right) {
  const leftRank = Number(left.sortRank ?? 99);
  const rightRank = Number(right.sortRank ?? 99);
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
  return Number(left.id || 0) - Number(right.id || 0);
}

function listingOwnerName(row = {}) {
  return String(row.owner_name || row.owner_person_name || row.owner || "").trim();
}

function listingShopOwnerMatched(shop = {}, row = {}) {
  const ownerName = listingOwnerName(row);
  const legalEntity = String(shop.legal_entity || shop.legalEntity || "").trim();
  return Boolean(ownerName && legalEntity && ownerName === legalEntity);
}

function listingShopPriceDecision(shop = {}, row = {}) {
  const role = String(shop.rule?.priceRole || shop.rule?.price_role || shop.priceRole || "").trim();
  if (role === "main") return { index: 1, group: "main", label: "主店铺", recommended: true, sortRank: 10 };
  if (listingShopOwnerMatched(shop, row)) return { index: 1, group: "owner", label: "负责人店铺", recommended: true, sortRank: 20 };
  const legalEntity = String(shop.legal_entity || shop.legalEntity || "").trim();
  const shopText = `${shop.name || ""} ${legalEntity}`.toLowerCase();
  if (role === "new" || /(^|\s)(new|fresh)(\s|$)|新店|全新/.test(shopText)) return { index: 0.95, group: "new", label: "新店铺", recommended: false, sortRank: 40 };
  if (role === "owner") return { index: 1.05, group: "other_owner", label: "其他负责人店铺", recommended: false, sortRank: 50 };
  if (role === "lift") return { index: 5, group: "lift", label: "台下/抬价店铺", recommended: false, sortRank: 80 };
  return { index: 1.05, group: "matrix", label: "矩阵店铺", recommended: false, sortRank: 60 };
}

function effectiveListingShopPriceIndex(shop = {}) {
  return listingShopPriceDecision(shop, listingShopDialog.row || {}).index;
}

function isListingShopSelected(shopId) {
  return uniqueNumbers(listingShopDialog.selectedShopIds).includes(Number(shopId));
}

function toggleListingShop(shopId) {
  const id = Number(shopId);
  if (!id) return;
  const selected = new Set(uniqueNumbers(listingShopDialog.selectedShopIds));
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  listingShopDialog.selectedShopIds = [...selected];
}

function listingShopInitial(name = "") {
  const text = String(name || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  return text.slice(0, 2) || "OS";
}

function uniqueNumbers(values = []) {
  return [...new Set((values || []).map((value) => Number(value)).filter(Boolean))];
}

async function submitListingShopDialog() {
  const row = listingShopDialog.row;
  const shopIds = uniqueNumbers(listingShopDialog.selectedShopIds);
  if (!row) return;
  if (!shopIds.length) {
    ElMessage.warning("请至少选择一个上架店铺");
    return;
  }
  listingShopDialog.submitting = true;
  try {
    await goToListing(row, shopIds);
    listingShopDialog.visible = false;
  } finally {
    listingShopDialog.submitting = false;
  }
}

async function cancelListingJob(row) {
  const jobId = Number(row?.listing_job_id || 0);
  if (!jobId || cancelingListingJobs.value.has(jobId)) return;
  cancelingListingJobs.value = new Set([...cancelingListingJobs.value, jobId]);
  try {
    await apiClient.post(`/api/asset-variant-engine/jobs/${jobId}/cancel`, {});
    ElMessage.success("已中断上架任务");
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "中断上架任务失败");
  } finally {
    const next = new Set(cancelingListingJobs.value);
    next.delete(jobId);
    cancelingListingJobs.value = next;
  }
}

async function retryListingJobFailures(row) {
  const jobId = Number(row?.listing_job_id || 0);
  if (!jobId || retryingListingJobs.value.has(jobId)) return;
  retryingListingJobs.value = new Set([...retryingListingJobs.value, jobId]);
  try {
    const result = await apiClient.post(`/api/asset-variant-engine/jobs/${jobId}/retry-failures`, {});
    if (result.ok) {
      ElMessage.success(`已重试失败店铺：${result.retried || 0} 个`);
    } else {
      ElMessage.warning(result.note || "没有可重试的失败店铺");
    }
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "重试失败店铺失败");
  } finally {
    const next = new Set(retryingListingJobs.value);
    next.delete(jobId);
    retryingListingJobs.value = next;
  }
}

function handleListingAction(row) {
  if (isListingJobActive(row)) return cancelListingJob(row);
  if (listingJobStatus(row) === "failed" && Number(row?.listing_job_success_count || 0) > 0) return retryListingJobFailures(row);
  return openListingShopDialog(row);
}

function startVariant(row) {
  router.push({
    name: "asset-variant-center-create",
    query: {
      workbenchId: createAiWorkbenchId(),
      baseSelectionId: String(row.id),
      source: "selection",
      autoImport: "1"
    }
  });
}

function startBatchVariant() {
  if (!selectedRows.value.length) {
    ElMessage.warning("请先选择需要 AI 内容优化的选品");
    return;
  }
  const first = selectedRows.value[0];
  router.push({
    name: "asset-variant-center-create",
    query: {
      workbenchId: createAiWorkbenchId(),
      baseSelectionId: String(first.id),
      batchSelectionIds: selectedRows.value.map((row) => row.id).join(","),
      source: "selection",
      autoImport: "1"
    }
  });
}

function selectionReturnTarget() {
  const returnTo = String(route.query.returnTo || "").trim();
  if (!returnTo) return null;
  const query = {};
  const baseSelectionId = String(route.query.baseSelectionId || route.query.productId || "").trim();
  if (baseSelectionId) query.baseSelectionId = baseSelectionId;
  if (String(route.query.autoImport || "").trim()) query.autoImport = String(route.query.autoImport);
  if (String(route.query.source || "").trim()) query.source = String(route.query.source);
  return { path: returnTo, query };
}

function goBackToSelectionReturnTarget() {
  const target = selectionReturnTarget();
  if (!target) return;
  router.push(target);
}

async function openRouteEditDialogIfNeeded() {
  const productId = Number(route.query.productId || 0) || null;
  const openEdit = String(route.query.openEdit || "").trim() === "1";
  if (!productId || !openEdit || routeEditOpened.value) return;
  routeEditOpened.value = true;
  await openEditDialog({ id: productId });
}

function variantTypeText(value) {
  const map = {
    same_model_main_image: "同车型主图裂变",
    multi_model: "同款多车型裂变",
    logo_text_replace: "Logo/文字替换裂变"
  };
  return map[value] || value || "-";
}

function selectionStatusText(row = {}) {
  const status = String(row.selection_status || "draft");
  if (status === "listed") return "已加入库存";
  if (status === "merged") return "已合并";
  if (status === "draft") return "选品中";
  return status;
}

function selectionStatusTagType(row = {}) {
  const status = String(row.selection_status || "draft");
  if (status === "listed") return "success";
  if (status === "merged") return "warning";
  return "info";
}

const businessStatusOptions = [
  { label: "全部状态", value: "all" },
  { label: "待完善", value: "needs_work" },
  { label: "可上架", value: "ready_to_publish" },
  { label: "上架中", value: "publishing" },
  { label: "上架失败", value: "publish_failed" },
  { label: "已上架", value: "published" },
  { label: "已入库", value: "in_inventory" },
  { label: "已中断", value: "publish_cancelled" }
];

function hasSelectionMainImage(row = {}) {
  return Boolean(String(row.image_url || "").trim());
}

function hasSelectionSellingPoints(row = {}) {
  return Boolean(String(row.selling_points || "").trim());
}

function hasSelectionPrice(row = {}) {
  return Number(row.listing_price_rub || 0) > 0 || Number(row.air_sale_price_rmb || 0) > 0;
}

function hasSelectionWeight(row = {}) {
  return Number(row.package_weight_g || 0) > 0;
}

function hasSelectionDetailImages(row = {}) {
  const raw = row.detail_image_urls;
  if (Array.isArray(raw)) return raw.filter(Boolean).length > 0;
  const text = String(raw || "").trim();
  return Boolean(text && text !== "[]");
}

function hasSelectionCategory(row = {}) {
  return Boolean(String(row.ozon_category_id || "").trim())
    && Number(row.ozon_description_category_id || 0) > 0
    && Number(row.ozon_type_id || 0) > 0;
}

function hasSelectionPurchaseCost(row = {}) {
  return Number(row.purchase_cost || 0) > 0;
}

function hasSelectionDimensions(row = {}) {
  return Number(row.length_cm || 0) > 0 && Number(row.width_cm || 0) > 0 && Number(row.height_cm || 0) > 0;
}

function hasSelectionOwner(row = {}) {
  return Number(row.owner_person_id || 0) > 0;
}

function hasSelectionLogisticsRule(row = {}) {
  return Number(row.logistics_rule_id || 0) > 0;
}

function selectionReadinessMissingItems(row = {}) {
  const missing = [];
  if (!hasSelectionMainImage(row)) missing.push("主图");
  if (!hasSelectionDetailImages(row)) missing.push("详情图");
  if (!hasSelectionSellingPoints(row)) missing.push("卖点");
  if (!hasSelectionCategory(row)) missing.push("Ozon类目/类型");
  if (!hasSelectionPrice(row)) missing.push("价格");
  if (!hasSelectionPurchaseCost(row)) missing.push("采购成本");
  if (!hasSelectionWeight(row)) missing.push("重量");
  if (!hasSelectionDimensions(row)) missing.push("尺寸");
  if (!hasSelectionOwner(row)) missing.push("负责人");
  if (!hasSelectionLogisticsRule(row)) missing.push("物流规则");
  return missing;
}

function selectionBusinessStatus(row = {}) {
  const backendStatus = String(row.business_status || "").trim();
  const selectionStatus = String(row.selection_status || "draft");
  const jobStatus = listingJobStatus(row);
  if (selectionStatus === "listed") return "in_inventory";
  if (jobStatus === "queued" || jobStatus === "running") return "publishing";
  if (jobStatus === "failed") return "publish_failed";
  if (jobStatus === "success") return "published";
  if (jobStatus === "cancelled") return "publish_cancelled";
  if (backendStatus && backendStatus !== "draft") return backendStatus;
  return selectionReadinessMissingItems(row).length ? "needs_work" : "ready_to_publish";
}

function selectionBusinessStatusOption(row = {}) {
  const status = selectionBusinessStatus(row);
  return businessStatusOptions.find((item) => item.value === status) || { label: status || "未知", value: status || "unknown" };
}

function selectionBusinessStatusText(row = {}) {
  return selectionBusinessStatusOption(row).label;
}

function selectionBusinessStatusTagType(row = {}) {
  const status = selectionBusinessStatus(row);
  if (status === "in_inventory" || status === "published") return "success";
  if (status === "ready_to_publish") return "primary";
  if (status === "publishing") return "warning";
  if (status === "publish_failed") return "danger";
  return "info";
}

function selectionStageText(row = {}) {
  const stage = selectionStatusText(row);
  const status = selectionBusinessStatusText(row);
  if (!stage || stage === status) return "";
  if (selectionBusinessStatus(row) === "in_inventory") return "";
  return `阶段：${stage}`;
}

function selectionReadinessMissingText(row = {}) {
  if (selectionBusinessStatus(row) !== "needs_work") return "";
  const readinessMissing = selectionReadinessMissingItems(row);
  return readinessMissing.length ? `缺：${readinessMissing.join("、")}` : "";
  const missing = [];
  if (!hasSelectionMainImage(row)) missing.push("主图");
  if (!hasSelectionSellingPoints(row)) missing.push("卖点");
  if (!hasSelectionPrice(row)) missing.push("价格");
  if (!hasSelectionWeight(row)) missing.push("重量");
  return missing.length ? `缺：${missing.join("、")}` : "";
}

function listingJobStatus(row = {}) {
  return String(row.listing_job_status || "").trim();
}

function listingJobStatusLabel(row = {}) {
  const status = listingJobStatus(row);
  const map = {
    queued: "排队中",
    running: "执行中",
    success: "已完成",
    failed: "失败",
    cancelled: "已中断",
    idle: "未发起"
  };
  return map[status] || status || "未发起";
}

function isListingJobActive(row = {}) {
  return ["queued", "running"].includes(listingJobStatus(row));
}

function listingJobText(row = {}) {
  const status = listingJobStatus(row);
  if (status === "cancelled") return "已中断上架";
  const ahead = Number(row.listing_job_queue_ahead || 0);
  if (status === "queued") return ahead > 0 ? `排队中，前方 ${ahead} 个任务` : "排队中，即将开始";
  if (status === "running") return "正在生成并上架";
  if (status === "success") return "已完成上架";
  if (status === "failed") return "上架失败";
  return row.selection_status === "listed" ? "已完成上架" : "未发起";
}

function listingJobSubText(row = {}) {
  const status = listingJobStatus(row);
  if (status === "cancelled") return row.listing_job_no || "已手动中断，可重新上架";
  if (status === "success") return `${Number(row.listing_job_success_count || 0)} 个店铺成功`;
  if (status === "failed") return Number(row.listing_job_failed_count || 0) ? `${Number(row.listing_job_failed_count || 0)} 个失败` : "请查看任务错误";
  if (status === "running") return row.listing_job_no || "后台处理中";
  if (status === "queued") return row.listing_job_no || "等待后台队列";
  return "共享任务状态";
}

function listedTimeText(row = {}) {
  if (row.selection_status !== "listed") return "";
  return dateText(row.listing_job_finished_at || row.updated_at || row.created_at);
}

function parseMaybeJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function listingJobProgress(row = {}) {
  const progress = parseMaybeJson(row.listing_job_progress_json, null);
  if (progress) return progress;
  const elapsedMs = Number(row.listing_job_elapsed_ms || 0);
  const currentStage = String(row.listing_job_current_stage || "").trim();
  if (!elapsedMs && !currentStage) return null;
  return { elapsedMs, currentStage, phases: [] };
}

function listingJobResult(row = {}) {
  return parseMaybeJson(row.listing_job_result_json, null);
}

function listingJobStageText(row = {}) {
  const stage = String(row.listing_job_current_stage || listingJobProgress(row)?.currentStage || "").trim();
  const map = {
    starting: "启动任务",
    load_product: "读取选品",
    bootstrap: "加载配置",
    generate_assets: "生成素材",
    publish_assets: "导入并提交",
    import_listing: "导入编辑上架",
    submit_precheck: "提交前校验",
    submit_ozon: "提交平台",
    done: "完成收尾",
    success: "已完成",
    failed: "已失败",
    recovered: "恢复排队"
  };
  return map[stage] || (stage ? "未知阶段" : "");
}

function listingJobElapsedText(row = {}) {
  const progress = listingJobProgress(row);
  const elapsed = Number(row.listing_job_elapsed_ms || progress?.elapsedMs || 0);
  if (!elapsed) return "";
  if (elapsed < 60000) return `${Math.max(1, Math.round(elapsed / 1000))} 秒`;
  return `${Math.round(elapsed / 6000) / 10} 分钟`;
}

function listingJobFailureText(row = {}) {
  const summaryError = friendlyListingJobErrorMessage(row);
  if (summaryError) return `失败：${summaryError}`;
  const result = listingJobResult(row);
  const firstFailed = Array.isArray(result?.results) ? result.results.find((item) => !item.ok) : null;
  const error = firstFailed?.precheck?.errors?.[0] || firstFailed?.error || parseMaybeJson(row.listing_job_error_json, {})?.message || "";
  return error ? `失败：${friendlyListingJobErrorMessage({ listing_job_error_message: error })}` : "";
}

function listingJobContentIssues(row = {}) {
  const result = listingJobResult(row);
  const rows = Array.isArray(result?.results) ? result.results : [];
  return rows.flatMap((item) => {
    const shopName = item.shopName || item.shop_name || (item.shopId ? `店铺 ${item.shopId}` : "店铺");
    const errors = Array.isArray(item.precheck?.errors) ? item.precheck.errors : [];
    const warnings = Array.isArray(item.precheck?.warnings) ? item.precheck.warnings : [];
    return [
      ...errors.map((message) => ({ type: "error", shopName, message: friendlyListingJobErrorMessage({ listing_job_error_message: message }) || message })),
      ...warnings.map((message) => ({ type: "warning", shopName, message: friendlyListingJobErrorMessage({ listing_job_error_message: message }) || message }))
    ];
  });
}

function listingJobContentIssueCounts(row = {}) {
  const issues = listingJobContentIssues(row);
  return {
    errors: issues.filter((item) => item.type === "error").length,
    warnings: issues.filter((item) => item.type !== "error").length
  };
}

function listingJobContentTooltipText(row = {}) {
  const issues = listingJobContentIssues(row);
  if (!issues.length) return "";
  const counts = listingJobContentIssueCounts(row);
  const summary = [
    counts.errors ? `${counts.errors} 条错误` : "",
    counts.warnings ? `${counts.warnings} 条提醒` : ""
  ].filter(Boolean).join("，");
  const lines = [`内容体检：${summary || "暂无异常"}`];
  return [
    ...lines,
    ...issues.slice(0, 8).map((item) => `${item.type === "error" ? "错误" : "提醒"}：${item.shopName} - ${item.message}`),
    issues.length > 8 ? `还有 ${issues.length - 8} 条，请打开任务详情查看` : ""
  ].filter(Boolean).join("\n");
}

function listingJobContentTagText(row = {}) {
  const counts = listingJobContentIssueCounts(row);
  if (counts.errors) return "体检";
  if (counts.warnings) return "提醒";
  return "";
}

function listingJobFixTip(row = {}) {
  const direct = String(row.listing_job_error_fix_tip || "").trim();
  if (direct) return friendlyListingText(direct, "处理建议请查看后台日志");
  const raw = String(row.listing_job_error_message || row.listing_job_raw_error_message || "").toLowerCase();
  if (raw.includes("shop-watermarks")) return "请到店铺配置里重新上传这个店铺的水印图片，或先清空该店铺水印后再重新一键上架。";
  if (raw.includes("enoent") || raw.includes("no such file or directory")) return "请重新上传缺失的商品图片/店铺水印，确认图片文件存在后再重新一键上架。";
  return "";
}

function friendlyListingText(message = "", fallback = "任务异常，请查看后台日志") {
  const text = String(message || "").trim();
  if (!text) return "";
  return /[A-Za-z]{3,}/.test(text) ? fallback : text;
}

function friendlyListingJobErrorMessage(row = {}) {
  const message = String(row.listing_job_error_message || row.listing_job_raw_error_message || "").trim();
  const lower = message.toLowerCase();
  if (!message) return "";
  if (lower.includes("no product video prepared")) return "未准备商品视频";
  if (lower.includes("rich content json is empty")) return "富文本内容为空";
  if (lower.includes("rich content json is not valid json")) return "富文本格式不正确";
  if (lower.includes("no product images prepared")) return "未准备商品图片";
  if (lower.includes("package size looks too small")) return "包裹尺寸看起来偏小，请检查单位是否正确";
  if (lower.includes("title contains unreadable replacement marks")) return "标题包含乱码或替换字符";
  if (lower.includes("description contains unreadable replacement marks")) return "描述包含乱码或替换字符";
  if (lower.includes("product tags must include shop tag")) {
    const tag = message.match(/#\S+/)?.[0] || "店铺标签";
    return `标签缺少店铺名标签 ${tag}`;
  }
  if (lower.includes("description must mention shop name")) {
    const shop = message.replace(/.*shop name\s*/i, "").trim();
    return shop ? `描述缺少店铺名 ${shop}` : "描述缺少店铺名";
  }
  if (lower.includes("rich content text should mention shop name")) return "富文本建议加入店铺名";
  if (lower.includes("non-key product content contains key-case related terms")) return "非钥匙类商品出现钥匙壳/钥匙套相关词";
  if (lower.includes("product tags look too sparse")) return "标签数量偏少，建议补充类目词和买家搜索词";
  if (lower.includes("description is short")) return "描述偏短，搜索文案可能不足";
  if (lower.includes("title contains chinese")) return "标题仍包含中文";
  if (lower.includes("description contains chinese")) return "描述仍包含中文";
  if (lower.includes("shop-watermarks")) return "店铺水印文件不存在，无法生成上架图片";
  if (lower.includes("enoent") || lower.includes("no such file or directory")) return "本地图片文件不存在，无法生成上架素材";
  if (lower.includes("http") && (lower.includes("image") || lower.includes("图片"))) return "采集图片链接无法下载，无法生成上架素材";
  return friendlyListingText(message);
}

function listingJobTooltipText(row = {}) {
  const progress = listingJobProgress(row);
  const phases = Array.isArray(progress?.phases) ? progress.phases : [];
  const lines = [
    `状态：${listingJobText(row)}`,
    listingJobStageText(row) ? `当前阶段：${listingJobStageText(row)}` : "",
    listingJobElapsedText(row) ? `已耗时：${listingJobElapsedText(row)}` : "",
    Number(row.listing_job_queue_ahead || 0) ? `前方排队：${Number(row.listing_job_queue_ahead || 0)} 个任务` : "",
    listingJobFailureText(row),
    listingJobFixTip(row) ? `处理建议：${listingJobFixTip(row)}` : ""
  ].filter(Boolean);
  const phaseLines = phases.slice(-6).map((phase) => {
    const duration = Number(phase.durationMs || 0);
    const durationText = duration ? ` ${Math.round(duration / 1000)}秒` : "";
    return `${listingJobPhaseName(phase.stage)}${durationText}`;
  });
  return [...lines, ...phaseLines].join("\n") || "暂无任务信息";
}

function listingJobPhaseName(stage = "") {
  const row = { listing_job_current_stage: stage };
  return listingJobStageText(row) || stage || "-";
}

function listingJobCreatedTimeText(row = {}) {
  return row.listing_job_created_at ? dateText(row.listing_job_created_at) : "";
}

function listingJobTagType(row = {}) {
  const status = listingJobStatus(row);
  if (status === "cancelled") return "info";
  if (status === "success" || row.selection_status === "listed") return "success";
  if (status === "failed") return "danger";
  if (status === "running") return "primary";
  if (status === "queued") return "warning";
  return "info";
}

watch(
  () => [dialog.form.package_weight_g, dialog.form.listing_price_rub, dialog.form.sale_price_rmb, dialog.form.air_sale_price_rmb],
  () => {
    if (dialogVisible.value && !manualLogisticsRule.value) {
      const nextRule = resolveSelectedLogisticsRule(dialog.form);
      dialog.form.logistics_rule_id = nextRule?.id || dialog.form.logistics_rule_id || "";
      dialog.form.shipping_method = nextRule?.channel || dialog.form.shipping_method || "air_land";
    }
    if (!Number(dialog.form.sale_price_rmb || 0) && Number(dialog.form.air_sale_price_rmb || 0)) {
      dialog.form.sale_price_rmb = Number(dialog.form.air_sale_price_rmb || 0);
    }
    syncPackagingFee(dialog.form);
  }
);

watch(
  () => [dialog.form.sale_price_rmb, dialog.form.exchange_rate],
  () => {
    syncListingPriceFromSale();
    syncPackagingFee(dialog.form);
  }
);

function sourceName(source) {
  const map = {
    "1688": "1688",
    taobao: "淘宝",
    pinduoduo: "拼多多",
    pdd: "拼多多",
    supplier: "供应商",
    other: "其他"
  };
  return map[source] || source || "-";
}

function shippingFormulaText(channelKey, row, quote) {
  if (!quote) return "当前没有可用报价";
  const weight = numberText(row?.package_weight_g || 0);
  const dimensions = `${numberText(row?.length_cm || 0)} x ${numberText(row?.width_cm || 0)} x ${numberText(row?.height_cm || 0)}`;
  const days = quote.days ? `，时效 ${quote.days}` : "";
  return `${methodName(channelKey)} / ${quote.channel || "-"}，计费重 ${numberText(getPricing(row)?.chargeableWeightKg || 0, 2)} kg，实重 ${weight} g，尺寸 ${dimensions} cm${days}`;
}

function buildProfitDetailRows(row, quote, channelKey, logisticsRule) {
  if (!row || !quote) return [];

  const preview = buildSelectionPreview(row, logisticsRule || getLogisticsRuleForRow(row));
  const sale = Number(preview.saleRmb || getSaleRmb(row));
  const purchaseUnit = getPurchaseCostPerUnit(row);
  const purchaseQty = Math.max(Number(row.purchase_quantity || 1), 1);
  const domesticShare = Number(row.domestic_shipping || 0) / purchaseQty;
  const commissionRate = sale ? Number(quote.commission || 0) / sale : 0;
  const finalMile = Number(quote.finalMileBankFee ?? quote.paymentFee ?? 0);
  const advertisingCost = Number(quote.advertisingCost || 0);
  const totalCost =
    purchaseUnit +
    Number(quote.amount || 0) +
    Number(quote.commission || 0) +
    finalMile +
    Number(quote.withdrawalFee || 0) +
    advertisingCost +
    Number(quote.expectedReturnLoss || 0);

  return [
    { label: "售价", value: money(sale), note: "当前真实运输方式下的售价 RMB" },
    { label: "采购均摊成本", value: money(purchaseUnit), note: `已含采购单价 ${money(row.purchase_cost)} + 国内运费均摊 ${money(domesticShare)}${Number(row.handling_fee || 0) ? ` + 处理费 ${money(row.handling_fee)}` : ""}` },
    { label: "运送方式", value: methodName(channelKey), note: logisticsRule ? `${logisticsRule.name || "-"} / ${logisticsRule.carrier || "-"} / ${logisticsRule.channel || "-"}` : shippingFormulaText(channelKey, row, quote) },
    { label: "国际运费", value: money(quote.amount), note: shippingFormulaText(channelKey, row, quote) },
    { label: "Ozon 佣金", value: money(quote.commission), note: `售价 x ${percentText(commissionRate * 100)}` },
    { label: "末公里+银行", value: money(finalMile), note: "售价 x 1.4% + 阶梯末公里费" },
    { label: "提现费", value: money(quote.withdrawalFee), note: "(售价 - 末公里+银行 - 运费 - 售价 x 20%) x 1.2%" },
    { label: "广告预算", value: money(advertisingCost), note: percentText(Number(row.advertising_rate || 0), 1) },
    { label: "退货损失", value: money(quote.expectedReturnLoss), note: `(采购均摊成本 + 运费) x ${percentText(resolvedReturnRate(row) * 100)}` },
    { label: "成本合计", value: money(totalCost), note: "除售价外所有扣减项合计" },
    { label: "净利润", value: money(quote.profit), note: `售价 - 成本合计，净利率 ${percentText(quote.margin)}`, total: true }
  ];
}

function openProfitDialog(row, channelKey) {
  const logisticsRule = getLogisticsRuleForRow(row);
  const quote = getCurrentQuote(row, logisticsRule);
  if (!quote) {
    ElMessage.warning(`当前商品没有${methodName(channelKey)}报价`);
    return;
  }
  profitDialog.row = row;
  profitDialog.channelKey = quote.channelKey || channelKey;
  profitDialog.quote = quote;
  profitDialog.logisticsRule = logisticsRule;
  profitDialogVisible.value = true;
}

function closeProfitDialog() {
  profitDialogVisible.value = false;
  profitDialog.row = null;
  profitDialog.channelKey = "air";
  profitDialog.quote = null;
  profitDialog.logisticsRule = null;
}

async function loadPageData(options = {}) {
  const silent = Boolean(options.silent);
  const summaryMode = options.summaryMode || (silent ? "skip" : "full");
  if (!silent) loading.value = true;
  let productsLoaded = false;
  try {
    const shouldLoadMeta = !silent || !state.people.length || !state.suppliers.length || !state.logisticsRules.length;
    const metaPromise = Promise.all([
      shouldLoadMeta ? apiClient.get("/api/people") : Promise.resolve(state.people),
      shouldLoadMeta ? apiClient.get("/api/suppliers?paged=1&page=1&pageSize=100") : Promise.resolve(state.suppliers),
      shouldLoadMeta ? apiClient.get("/api/logistics-rules") : Promise.resolve(state.logisticsRules)
    ]).then((values) => ({ values }), (error) => ({ error }));
    const products = await apiClient.get(`/api/products/selection?${buildSelectionQuery({ summaryMode })}`);
    state.rows = normalizePagedRows(products);
    state.total = normalizePagedTotal(products, state.rows);
    if (products?.summary) {
      state.summary = products.summary;
    } else if (!silent) {
      state.summary = {
        products: state.total,
        quotedRows: state.rows.filter((row) => !!getCurrentQuote(row, getLogisticsRuleForRow(row))).length,
        missingQuoteRows: state.rows.filter((row) => !getCurrentQuote(row, getLogisticsRuleForRow(row))).length,
        avgPurchaseCost: state.rows.length
          ? state.rows.reduce((sum, row) => sum + Number(row.purchase_cost || 0), 0) / state.rows.length
          : 0
      };
    }
    productsLoaded = true;
    if (!silent) selectedRows.value = [];
    if (!silent) loading.value = false;
    if (shouldLoadMeta) {
      const metaResult = await metaPromise;
      if (metaResult.error) {
        if (!silent) ElMessage.warning("基础资料加载失败，表格数据已先显示");
        return;
      }
      const [people, suppliers, logisticsRules] = metaResult.values;
      state.people = Array.isArray(people) ? people.filter((item) => Number(item.active) !== 0) : [];
      state.suppliers = normalizePagedRows(suppliers);
      state.logisticsRules = Array.isArray(logisticsRules) ? logisticsRules.filter((item) => Number(item.enabled) !== 0) : [];
    }
  } catch (error) {
    if (!silent) ElMessage.error(error.message || "选品计价表加载失败");
  } finally {
    if (!silent) loading.value = false;
  }
}

async function handleSearch() {
  state.filters.page = 1;
  await loadPageData();
}

async function handleReset() {
  state.filters.query = "";
  state.filters.ownerPersonId = "all";
  state.filters.quoteStatus = "all";
  state.filters.businessStatus = "all";
  state.filters.page = 1;
  await loadPageData();
}

async function handlePageChange(page) {
  state.filters.page = page;
  await loadPageData();
}

async function handlePageSizeChange(size) {
  state.filters.pageSize = size;
  state.filters.page = 1;
  await loadPageData();
}

function handleSelectionChange(rows) {
  selectedRows.value = rows;
}

function preferredPersonId(fallback = null) {
  const current = currentUserPersonId.value;
  if (current && state.people.some((item) => Number(item.id) === Number(current))) return current;
  if (fallback && state.people.some((item) => Number(item.id) === Number(fallback))) return fallback;
  return state.people[0]?.id || "";
}

function resetDialogForm() {
  dialog.form = createDefaultForm();
  dialog.currentRow = null;
  manualLogisticsRule.value = false;
  manualPackagingFee.value = false;
}

function openCreateDialog() {
  dialog.mode = "create";
  resetDialogForm();
  dialog.form.owner_person_id = preferredPersonId();
  dialog.form.logistics_rule_id = selectedLogisticsRule.value?.id || "";
  dialog.form.shipping_method = selectedLogisticsRule.value?.channel || "air_land";
  syncPackagingFee(dialog.form);
  dialogVisible.value = true;
}

function handleSelectionOzonCategorySelected(category) {
  if (!category) return;
  const descriptionCategoryId = category.description_category_id || category.descriptionCategoryId || "";
  const typeId = category.type_id || category.typeId || "";
  dialog.form.ozon_category_id = category.ozon_category_id || (descriptionCategoryId && typeId ? `${descriptionCategoryId}:${typeId}` : "");
  dialog.form.ozon_description_category_id = descriptionCategoryId;
  dialog.form.ozon_type_id = typeId;
  dialog.form.ozon_category_name = displayOzonCategoryZh(category);
}

async function loadCatalogDictionariesForCurrentCategory() {
  const seq = ++catalogDictionaryRequestSeq;
  const descriptionCategoryId = Number(dialog.form.ozon_description_category_id || 0);
  const typeId = Number(dialog.form.ozon_type_id || 0);
  if (!descriptionCategoryId || !typeId) {
    materialOptions.value = [...fallbackMaterialOptions];
    colorOptions.value = [...fallbackColorOptions];
    vehicleBrandOptions.value = [];
    vehicleOptions.value = [];
    return;
  }
  const cacheKey = `${descriptionCategoryId}:${typeId}`;
  const cached = catalogDictionaryCache.get(cacheKey);
  if (cached) {
    applyCatalogDictionaries(cached);
    return;
  }
  materialOptionsLoading.value = true;
  catalogDictionaryLoading.value = true;
  try {
    let dictionaries = await loadCatalogDictionaries(descriptionCategoryId, typeId);
    if (seq !== catalogDictionaryRequestSeq) return;
    if (!dictionaries.material.length && !dictionaries.color.length && !dictionaries.vehicleBrand.length && !dictionaries.vehicle.length) {
      await apiClient.post("/api/listing/ozon-category-attributes/sync", {
        description_category_id: descriptionCategoryId,
        type_id: typeId,
        sync_values: true,
        value_limit: 500,
        language: "ZH_HANS"
      }).catch(() => null);
      dictionaries = await loadCatalogDictionaries(descriptionCategoryId, typeId);
      if (seq !== catalogDictionaryRequestSeq) return;
    }
    catalogDictionaryCache.set(cacheKey, dictionaries);
    applyCatalogDictionaries(dictionaries);
  } catch {
    materialOptions.value = [...fallbackMaterialOptions];
    colorOptions.value = [...fallbackColorOptions];
    vehicleBrandOptions.value = [];
    vehicleOptions.value = [];
  } finally {
    materialOptionsLoading.value = false;
    catalogDictionaryLoading.value = false;
  }
}

function applyCatalogDictionaries(dictionaries = {}) {
  materialOptions.value = dictionaries.material?.length ? sortPreferredCatalogOptions(dictionaries.material, ["热塑性弹性体", "塑料", "高分子材料", "聚氯乙烯", "泡沫聚氨酯", "锌合金", "生态皮革", "不锈钢"]) : [...fallbackMaterialOptions];
  colorOptions.value = dictionaries.color?.length ? dictionaries.color : [...fallbackColorOptions];
  vehicleBrandOptions.value = dictionaries.vehicleBrand || [];
  vehicleOptions.value = dictionaries.vehicle || [];
  const preferredTpu = materialOptions.value.find((item) => catalogOptionLabel(item).includes("热塑性弹性体") || /^tpu$/i.test(catalogOptionValue(item)));
  if (/^tpu$/i.test(String(dialog.form.material || "").trim()) && preferredTpu) {
    dialog.form.material = catalogOptionValue(preferredTpu);
  }
}

async function loadCatalogDictionaries(descriptionCategoryId, typeId) {
  const attributes = await apiClient.get(`/api/listing/ozon-category-attributes?${new URLSearchParams({
    description_category_id: String(descriptionCategoryId),
    type_id: String(typeId),
    value_limit: "1"
  }).toString()}`, { noCache: true }).catch(() => []);
  const materialAttribute = findCatalogAttribute(attributes, { ids: [7199], names: ["材质", "材料", "material"] });
  const colorAttribute = findCatalogAttribute(attributes, { ids: [10096, 8229], names: ["商品颜色", "颜色", "цвет", "color"] });
  const vehicleBrandAttribute = findCatalogAttribute(attributes, { ids: [7204], names: ["汽车品牌", "品牌", "марка", "brand"] });
  const vehicleAttribute = findCatalogAttribute(attributes, { ids: [7212], names: ["车型", "型号", "модель", "model"] });
  const [material, color, vehicleBrand, vehicle] = await Promise.all([
    loadAttributeValueOptions(descriptionCategoryId, typeId, materialAttribute?.attribute_id || materialAttribute?.attributeId || 0, 300),
    loadAttributeValueOptions(descriptionCategoryId, typeId, colorAttribute?.attribute_id || colorAttribute?.attributeId || 0, 300),
    loadAttributeValueOptions(descriptionCategoryId, typeId, vehicleBrandAttribute?.attribute_id || vehicleBrandAttribute?.attributeId || 0, 500),
    loadAttributeValueOptions(descriptionCategoryId, typeId, vehicleAttribute?.attribute_id || vehicleAttribute?.attributeId || 0, 500)
  ]);
  return { material, color, vehicleBrand, vehicle };
}

function findCatalogAttribute(attributes = [], rule = {}) {
  const rows = Array.isArray(attributes) ? attributes : [];
  for (const targetId of (rule.ids || []).map(Number).filter(Boolean)) {
    const exact = rows.find((attribute) => Number(attribute.attribute_id || attribute.attributeId || 0) === targetId);
    if (exact) return exact;
  }
  const names = rule.names || [];
  return rows.find((attribute) => {
    const name = String(attribute.name || attribute.label || "").toLowerCase();
    return names.some((item) => name.includes(String(item).toLowerCase()));
  });
}

async function loadAttributeValueOptions(descriptionCategoryId, typeId, attributeId, limit = 300) {
  if (!attributeId) return [];
  const params = new URLSearchParams({
    description_category_id: String(descriptionCategoryId),
    type_id: String(typeId),
    attribute_id: String(attributeId),
    limit: String(limit)
  });
  const rows = await apiClient.get(`/api/listing/ozon-attribute-values?${params.toString()}`, { noCache: true }).catch(() => []);
  const seen = new Set();
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      value: String(row.value || "").trim(),
      label: String(row.label || row.display_value_zh || row.value || "").trim(),
      dictionaryValueId: Number(row.dictionary_value_id || row.id || 0)
    }))
    .filter((row) => row.value && !seen.has(row.value) && seen.add(row.value));
}

function sortPreferredCatalogOptions(options = [], preferred = []) {
  const rank = (option) => {
    const label = catalogOptionLabel(option);
    const value = catalogOptionValue(option);
    const index = preferred.findIndex((item) => label.includes(item) || value === item);
    return index >= 0 ? index : preferred.length + 1;
  };
  return [...options].sort((a, b) => rank(a) - rank(b) || catalogOptionLabel(a).localeCompare(catalogOptionLabel(b), "zh-Hans-CN"));
}

function displayOzonCategoryZh(category = {}) {
  const value = category.path_zh || category.pathZh || category.name_zh || category.nameZh || category.label || category.name || "";
  const text = String(value || "").replace(/\s*>\s*/g, " / ").trim();
  if (text && !/[\u0400-\u04ff]/.test(text)) return text;
  return dialog.form.ozon_category_id ? `待翻译类目 ${dialog.form.ozon_category_id}` : "";
}

function normalizeStoredOzonCategoryName(value, categoryId) {
  const text = String(value || "").trim();
  if (text && !/[\u0400-\u04ff]/.test(text)) return text;
  return categoryId ? `待翻译类目 ${categoryId}` : "";
}

async function openEditDialog(row) {
  loading.value = true;
  try {
    const detail = await apiClient.get(`/api/products/${row.id}`);
    dialog.mode = "edit";
    dialog.currentRow = row;
    dialog.form = {
      ...createDefaultForm(),
      id: detail.id,
      updated_at: detail.updated_at || "",
      name: detail.name || "",
      ozon_category_id: detail.ozon_category_id || "",
      ozon_description_category_id: detail.ozon_description_category_id || "",
      ozon_type_id: detail.ozon_type_id || "",
      ozon_category_name: normalizeStoredOzonCategoryName(detail.ozon_category_name, detail.ozon_category_id),
      image_url: detail.image_url || "",
      detail_image_urls: normalizeDetailImages(detail.detail_image_urls),
      material: detail.material || "TPU",
      color: normalizeColorTags(detail.color),
      vehicle_brand: detail.vehicle_brand || "",
      vehicle_model: detail.vehicle_model || "",
      selling_points: detail.selling_points || "",
      purchase_url: detail.purchase_url || "",
      source_platform: detail.source_platform || "1688",
      supplier_id: detail.supplier_id || "",
      supplier_note: detail.supplier_note || "",
      owner_person_id: detail.owner_person_id || preferredPersonId(),
      shipping_method: detail.shipping_method || "air_land",
      logistics_rule_id: detail.logistics_rule_id || "",
      purchase_cost: Number(detail.purchase_cost || 0),
      domestic_shipping: Number(detail.domestic_shipping || 0),
      handling_fee: Number(detail.handling_fee || 0),
      purchase_quantity: Number(detail.purchase_quantity || 1),
      package_weight_g: Number(detail.package_weight_g || 0),
      length_cm: Number(detail.length_cm || 30),
      width_cm: Number(detail.width_cm || 20),
      height_cm: Number(detail.height_cm || 10),
      sale_price_rmb: Number(detail.sale_price_rmb || detail.air_sale_price_rmb || 0),
      listing_price_rub: Number(detail.listing_price_rub || 0),
      air_sale_price_rmb: Number(detail.air_sale_price_rmb || 0),
      exchange_rate: Number(detail.exchange_rate || 11.32),
      advertising_rate: Number(detail.advertising_rate || 0),
      desired_profit_mode: detail.desired_profit_mode || "margin",
      desired_profit_value: Number(detail.desired_profit_value || 20),
      return_rate: roundMoney(resolvedReturnRate(detail) * 100),
      product_type: detail.product_type || "selection",
      selection_status: detail.selection_status || "draft",
      source_selection_id: detail.source_selection_id || null,
      variant_task_id: detail.variant_task_id || "",
      variant_result_id: detail.variant_result_id || "",
      variant_type: detail.variant_type || "",
      is_variant_generated: Number(detail.is_variant_generated || 0),
      material_asset_status: detail.material_asset_status || ""
    };
    manualPackagingFee.value = true;
    dialogVisible.value = true;
    await loadCatalogDictionariesForCurrentCategory();
  } catch (error) {
    ElMessage.error(error.message || "选品详情加载失败");
  } finally {
    loading.value = false;
  }
}

function handleDialogClosed() {
  resetDialogForm();
  formRef.value?.clearValidate?.();
}

function upsertSelectionRow(row) {
  if (!row || !row.id) return;
  const nextRow = { ...row };
  const index = state.rows.findIndex((item) => Number(item.id) === Number(row.id));
  if (index >= 0) {
    state.rows.splice(index, 1, nextRow);
    return;
  }
  state.rows.unshift(nextRow);
  state.total += 1;
}

function refreshSelectionSummaryFromRows() {
  const rows = Array.isArray(state.rows) ? state.rows : [];
  const quotedRows = rows.filter((row) => !!getCurrentQuote(row, getLogisticsRuleForRow(row))).length;
  const missingQuoteRows = rows.length - quotedRows;
  const avgPurchaseCost = rows.length
    ? rows.reduce((sum, row) => sum + Number(row.purchase_cost || 0), 0) / rows.length
    : 0;
  state.summary = {
    ...(state.summary || {}),
    products: state.total,
    quotedRows,
    missingQuoteRows,
    avgPurchaseCost
  };
}

async function submitDialog(options = {}) {
  if (!formRef.value) return;
  await formRef.value.validate();

  dialogSubmitting.value = true;
  try {
    const payload = {
      ...dialog.form,
      ozon_category_id: dialog.form.ozon_category_id || "",
      ozon_description_category_id: Number(dialog.form.ozon_description_category_id || 0) || null,
      ozon_type_id: Number(dialog.form.ozon_type_id || 0) || null,
      ozon_category_name: dialog.form.ozon_category_name || "",
      detail_image_urls: normalizeDetailImages(dialog.form.detail_image_urls),
      material: normalizeTagValue(dialog.form.material),
      color: normalizeTagValue(dialog.form.color),
      vehicle_brand: dialog.form.vehicle_brand || "",
      vehicle_model: dialog.form.vehicle_model || "",
      supplier_id: dialog.form.supplier_id || null,
      owner_person_id: Number(dialog.form.owner_person_id || 0) || null,
      logistics_rule_id: Number(dialog.form.logistics_rule_id || 0) || null,
      shipping_method: dialog.form.shipping_method || "air_land",
      purchase_cost: Number(dialog.form.purchase_cost || 0),
      domestic_shipping: Number(dialog.form.domestic_shipping || 0),
      handling_fee: Number(dialog.form.handling_fee || 0),
      purchase_quantity: Number(dialog.form.purchase_quantity || 1),
      package_weight_g: Number(dialog.form.package_weight_g || 0),
      length_cm: Number(dialog.form.length_cm || 30),
      width_cm: Number(dialog.form.width_cm || 20),
      height_cm: Number(dialog.form.height_cm || 10),
      sale_price_rmb: Number(dialog.form.sale_price_rmb || 0),
      listing_price_rub: Number(dialog.form.listing_price_rub || 0),
      air_sale_price_rmb: Number(dialog.form.air_sale_price_rmb || 0),
      exchange_rate: Number(dialog.form.exchange_rate || 11.32),
      advertising_rate: Number(dialog.form.advertising_rate || 0),
      desired_profit_value: Number(dialog.form.desired_profit_value || 20),
      return_rate: resolvedReturnRate(dialog.form),
      selection_status: dialog.mode === "create" ? "draft" : dialog.form.selection_status || "draft",
      product_type: dialog.mode === "create" ? "selection" : dialog.form.product_type || "selection"
    };

    if (dialog.mode === "create") {
      const response = await apiClient.post("/api/products", payload);
      const savedProduct = response?.product || null;
      if (savedProduct) {
        upsertSelectionRow(savedProduct);
        refreshSelectionSummaryFromRows();
      }
      ElMessage.success("选品已新增");
    } else {
      const response = await apiClient.put(`/api/products/${dialog.form.id}`, payload);
      const savedProduct = response?.product || null;
      if (savedProduct) {
        upsertSelectionRow(savedProduct);
        refreshSelectionSummaryFromRows();
      }
      ElMessage.success("选品已更新");
    }

    dialogVisible.value = false;
    loadPageData({ silent: true });
    if (options.returnAfter) {
      goBackToSelectionReturnTarget();
    }
  } catch (error) {
    ElMessage.error(error.message || "保存失败");
  } finally {
    dialogSubmitting.value = false;
  }
}

async function generateSellingPointsByAi() {
  if (aiSellingPointsLoading.value) return;
  aiSellingPointsLoading.value = true;
  try {
    const result = await apiClient.post("/api/selection/selling-points/generate", {
      name: dialog.form.name,
      ozon_category_name: dialog.form.ozon_category_name,
      vehicle_brand: dialog.form.vehicle_brand,
      vehicle_model: dialog.form.vehicle_model,
      material: normalizeTagValue(dialog.form.material),
      color: normalizeTagValue(dialog.form.color),
      existing_selling_points: dialog.form.selling_points,
      supplier_note: dialog.form.supplier_note,
      source_platform: dialog.form.source_platform
    });
    const generated = String(result?.selling_points || "").trim();
    if (!generated) {
      ElMessage.warning("AI 没有返回可用卖点，请稍后重试");
      return;
    }
    dialog.form.selling_points = generated;
    ElMessage.success("AI 卖点已生成");
  } catch (error) {
    ElMessage.error(error.message || "AI 卖点生成失败");
  } finally {
    aiSellingPointsLoading.value = false;
  }
}

async function addToInventory(row) {
  try {
    await ElMessageBox.confirm(
      `确认将选品“${row.name || row.selection_id || row.id}”加入产品库存表吗？`,
      "加入库存",
      { type: "warning", confirmButtonText: "加入库存", cancelButtonText: "取消" }
    );
    const result = await apiClient.post(`/api/products/${row.id}/add-to-inventory`, {});
    ElMessage.success(result?.already_inventory ? "该选品已经在库存表中" : "已加入产品库存表");
    await loadPageData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "加入库存失败");
  }
}

async function handleDelete(row) {
  try {
    await ElMessageBox.confirm(
      `确认删除选品“${row.name || row.inventory_id || row.code || row.id}”吗？删除后将从当前有效列表中移除。`,
      "删除确认",
      { type: "warning", confirmButtonText: "确认删除", cancelButtonText: "取消" }
    );
    await apiClient.delete(`/api/products/${row.id}`);
    ElMessage.success("选品已删除");
    await loadPageData();
  } catch (error) {
    if (error === "cancel" || error === "close" || error?.message === "cancel") return;
    ElMessage.error(error.message || "删除失败");
  }
}

function resetImportState() {
  importState.fileName = "";
  importState.rows = [];
  importState.total = 0;
  importState.valid = 0;
  importState.invalid = 0;
}

function openImportDialog() {
  resetImportState();
  importDialogVisible.value = true;
}

async function handleImportFileChange(uploadFile) {
  const rawFile = uploadFile?.raw;
  if (!rawFile) return;

  importLoading.value = true;
  importState.fileName = rawFile.name || "";
  try {
    const csv = await rawFile.text();
    const result = await apiClient.post("/api/products/import-preview", { csv });
    importState.rows = Array.isArray(result.rows) ? result.rows : [];
    importState.total = Number(result.total || 0);
    importState.valid = Number(result.valid || 0);
    importState.invalid = Number(result.invalid || 0);
    ElMessage.success("CSV 预解析完成");
  } catch (error) {
    resetImportState();
    ElMessage.error(error.message || "CSV 解析失败");
  } finally {
    importLoading.value = false;
  }
}

async function commitImport() {
  if (!importCommitRows.value.length) {
    ElMessage.warning("当前没有可导入的数据");
    return;
  }

  importSubmitting.value = true;
  try {
    const result = await apiClient.post("/api/products/import-commit", { rows: importCommitRows.value });
    ElMessage.success(`导入完成：成功 ${result.inserted || 0} 条，跳过 ${result.skipped || 0} 条`);
    importDialogVisible.value = false;
    resetImportState();
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "导入失败");
  } finally {
    importSubmitting.value = false;
  }
}

function handleBatchAction() {
  if (!selectedRows.value.length) {
    ElMessage.warning("请先选择需要处理的选品");
    return;
  }
  ElMessage.info("批量操作会在后续迁移中接入统一动作中心。");
}

function startListingJobPolling() {
  if (listingJobPoller) window.clearInterval(listingJobPoller);
  listingJobPoller = window.setInterval(() => {
    loadPageData({ silent: true });
  }, 8000);
}

onMounted(async () => {
  ensureSelectionWorkbenchRouteId();
  restoreSelectionWorkbenchState();
  await loadPageData();
  if (dialogVisible.value && dialog.mode === "edit" && dialog.currentRow?.id && !String(route.query.openEdit || "").trim()) {
    await openEditDialog({ id: dialog.currentRow.id });
  }
  await openRouteEditDialogIfNeeded();
  selectionWorkbenchReady.value = true;
  syncSelectionWorkbenchTabTitle();
  startListingJobPolling();
});

onBeforeUnmount(() => {
  if (listingJobPoller) window.clearInterval(listingJobPoller);
  window.clearTimeout(selectionWorkbenchSaveTimer);
});
</script>

<template>
  <div class="page-stack selection-page erp-paged-page">
    <section class="page-hero selection-hero">
      <div>
        <h2>选品计价表</h2>
      </div>
      <div class="page-card-actions">
        <el-button class="erp-btn erp-btn-secondary" @click="openImportDialog">批量导入</el-button>
        <el-button class="erp-btn erp-btn-primary" type="primary" @click="openCreateDialog">新增选品</el-button>
      </div>
    </section>

    <el-card shadow="never" class="page-card selection-table-card erp-paged-card">
      <div class="filter-panel selection-filter-panel">
        <el-form inline>
          <el-form-item label="关键词">
            <el-input
              v-model="state.filters.query"
              placeholder="商品名称 / 商品ID / 选品ID / 负责人"
              clearable
              style="width: 320px"
              @keyup.enter="handleSearch"
              @clear="handleSearch"
            />
          </el-form-item>
          <el-form-item label="负责人">
            <el-select v-model="state.filters.ownerPersonId" style="width: 180px" @change="handleSearch">
              <el-option label="全部负责人" value="all" />
              <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="String(person.id)" />
            </el-select>
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="state.filters.businessStatus" style="width: 150px" @change="handleSearch">
              <el-option
                v-for="item in businessStatusOptions"
                :key="item.value"
                :label="item.label"
                :value="item.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-button class="erp-btn erp-btn-primary" type="primary" @click="handleSearch">查询</el-button>
            <el-button class="erp-btn erp-btn-secondary" @click="handleReset">重置</el-button>
            <el-button class="erp-btn erp-btn-primary" type="primary" @click="openCreateDialog">新增选品</el-button>
            <el-button class="erp-btn erp-btn-secondary" @click="openImportDialog">批量导入</el-button>
            <el-button class="erp-btn erp-btn-secondary" :icon="MagicStick" :disabled="!selectedRows.length" @click="startBatchVariant">
              批量AI优化
            </el-button>
            <el-button class="erp-btn erp-btn-secondary" :disabled="!selectedRows.length" @click="handleBatchAction">
              批量操作
            </el-button>
          </el-form-item>
          <el-form-item class="selection-filter-refresh">
            <span class="muted-text">&#24050;&#36873; {{ selectedRows.length }} &#39033;</span>
            <el-button class="erp-btn erp-btn-secondary" @click="loadPageData">&#21047;&#26032;</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="selection-table-wrap erp-table-scroll">
        <el-table
          v-loading="loading"
          :data="pagedRows"
          stripe
          border
          class="erp-data-table selection-table"
          row-key="id"
          @selection-change="handleSelectionChange"
        >
          <el-table-column type="selection" width="46" fixed="left" />
          <el-table-column label="商品信息" min-width="300" fixed="left">
            <template #default="{ row }">
              <div class="product-cell">
                <ProductImagePreview
                  :src="row.image_url"
                  :preview-list="row.image_url ? [row.image_url] : null"
                  fit="cover"
                />
                <div class="cell-stack gap-sm">
                  <ProductTitleLink :title="row.name || '-'" :lines="2" />
                  <span class="muted-text">库存编码：{{ row.inventory_id || row.code || "-" }}</span>
                  <span class="muted-text">选品 ID：{{ row.selection_id || "-" }}</span>
                  <span class="muted-text">创建：{{ dateText(row.created_at) }}</span>
                  <span v-if="row.ozon_category_name || row.ozon_category_id" class="muted-text">
                    Ozon 类目：{{ row.ozon_category_name || row.ozon_category_id }}
                  </span>
                  <el-tag v-if="row.is_variant_generated" type="warning" effect="plain" size="small">
                    裂变生成
                  </el-tag>
                </div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="状态" min-width="150" align="center">
            <template #default="{ row }">
              <div class="cell-stack gap-xs align-center">
                <el-tooltip
                  :disabled="!selectionReadinessMissingText(row)"
                  :content="selectionReadinessMissingText(row)"
                  placement="top"
                >
                  <el-tag :type="selectionBusinessStatusTagType(row)" effect="plain">
                    {{ selectionBusinessStatusText(row) }}
                  </el-tag>
                </el-tooltip>
                <span v-if="selectionStageText(row)" class="muted-text">{{ selectionStageText(row) }}</span>
                <span v-if="listedTimeText(row)" class="muted-text">上架：{{ listedTimeText(row) }}</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="上架任务" min-width="220">
            <template #default="{ row }">
              <div class="listing-job-cell">
                <span class="listing-job-dot" :class="[`is-${listingJobStatus(row) || 'idle'}`, { spinning: isListingJobActive(row) }]"></span>
                <div class="listing-job-content">
                  <div class="listing-job-title-row">
                    <el-tooltip :content="listingJobTooltipText(row)" placement="top" effect="dark" :popper-style="{ whiteSpace: 'pre-line', maxWidth: '360px' }">
                      <span class="listing-job-status-trigger">
                        <strong>{{ listingJobText(row) }}</strong>
                        <el-tag v-if="listingJobStatus(row)" :type="listingJobTagType(row)" effect="plain" size="small">
                          {{ listingJobStatusLabel(row) }}
                        </el-tag>
                      </span>
                    </el-tooltip>
                    <el-tooltip
                      v-if="listingJobContentTagText(row)"
                      :content="listingJobContentTooltipText(row)"
                      placement="top"
                      effect="dark"
                      :popper-style="{ whiteSpace: 'pre-line', maxWidth: '360px' }"
                    >
                      <el-tag class="listing-content-check-tag" type="info" effect="plain" size="small">
                        {{ listingJobContentTagText(row) }}
                      </el-tag>
                    </el-tooltip>
                  </div>
                  <span class="listing-job-meta">{{ listingJobSubText(row) }}</span>
                  <div v-if="listingJobStageText(row) || listingJobElapsedText(row)" class="listing-job-progress-line">
                    <span v-if="listingJobStageText(row)">{{ listingJobStageText(row) }}</span>
                    <span v-if="listingJobElapsedText(row)">{{ listingJobElapsedText(row) }}</span>
                  </div>
                  <span v-if="listingJobFailureText(row)" class="listing-job-error">{{ listingJobFailureText(row) }}</span>
                  <span v-if="listingJobFixTip(row)" class="listing-job-fix-tip">{{ listingJobFixTip(row) }}</span>
                  <span v-if="listingJobCreatedTimeText(row)" class="listing-job-meta">创建：{{ listingJobCreatedTimeText(row) }}</span>
                </div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="卖点" min-width="190">
            <template #default="{ row }">
              <div class="selling-points-cell">{{ row.selling_points || "-" }}</div>
            </template>
          </el-table-column>

          <el-table-column label="归属 / 渠道" min-width="150">
            <template #default="{ row }">
              <div class="cell-stack gap-sm">
                <span>{{ row.owner_name || "-" }}</span>
                <span class="muted-text">{{ getSupplierName(row.supplier_id) }}</span>
                <span class="muted-text">{{ sourceName(row.source_platform) }}</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="采购成本" min-width="125" align="right">
            <template #default="{ row }">
              <div class="cell-stack align-end gap-sm">
                <strong>¥{{ money(row.purchase_cost) }}</strong>
                <span class="muted-text">均摊：¥{{ money(getPurchaseCostPerUnit(row)) }}</span>
                <span class="muted-text">数量：{{ numberText(row.purchase_quantity) }}</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="售价" min-width="125" align="right">
            <template #default="{ row }">
              <div class="cell-stack align-end gap-sm">
                <strong>¥{{ money(getSaleRmb(row)) }}</strong>
                <span class="muted-text">{{ money(row.listing_price_rub) }} RUB</span>
                <span class="muted-text">汇率 {{ numberText(row.exchange_rate || 11.32, 4) }}</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="重量 / 尺寸" min-width="135" align="center">
            <template #default="{ row }">
              <div class="cell-stack gap-sm">
                <span>{{ numberText(row.package_weight_g) }} g</span>
                <span class="muted-text">{{ numberText(row.length_cm) }} x {{ numberText(row.width_cm) }} x {{ numberText(row.height_cm) }} cm</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="利润报价" min-width="170">
            <template #default="{ row }">
              <div class="quote-grid">
                <div class="quote-card" :class="{ 'is-missing': !getCurrentQuote(row, getLogisticsRuleForRow(row)) }">
                  <div class="quote-card-head">
                    <strong>{{ methodName(getActiveChannelKey(row, getLogisticsRuleForRow(row))) }}</strong>
                    <el-tag v-if="getCurrentQuote(row, getLogisticsRuleForRow(row))" size="small" type="success" effect="plain">
                      {{ percentText(getCurrentQuote(row, getLogisticsRuleForRow(row)).margin) }}
                    </el-tag>
                    <el-tag v-else size="small" type="info" effect="plain">暂无</el-tag>
                  </div>
                  <template v-if="getCurrentQuote(row, getLogisticsRuleForRow(row))">
                    <span>利润 ¥{{ money(getCurrentQuote(row, getLogisticsRuleForRow(row)).profit) }}</span>
                    <span>运费 ¥{{ money(getCurrentQuote(row, getLogisticsRuleForRow(row)).amount) }}</span>
                    <span>建议 {{ getCurrentSuggestedRub(row, getLogisticsRuleForRow(row)) ? `${money(getCurrentSuggestedRub(row, getLogisticsRuleForRow(row)))} RUB` : "-" }}</span>
                    <el-button class="erp-btn-link" link type="primary" @click="openProfitDialog(row, getActiveChannelKey(row, getLogisticsRuleForRow(row)))">明细</el-button>
                  </template>
                  <span v-else class="muted-text">未命中当前物流规则</span>
                </div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="当前利润" min-width="130" align="center">
            <template #default="{ row }">
              <div class="cell-stack gap-sm">
                <template v-if="getCurrentQuote(row, getLogisticsRuleForRow(row))">
                  <span>利润 ¥{{ money(getCurrentQuote(row, getLogisticsRuleForRow(row)).profit) }}</span>
                  <span class="muted-text">利润率 {{ percentText(getCurrentQuote(row, getLogisticsRuleForRow(row)).margin) }}</span>
                </template>
                <span v-else class="muted-text">暂无</span>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="流转操作" width="92" fixed="right" align="center">
            <template #default="{ row }">
              <div class="table-actions is-vertical">
                <el-button
                  link
                  :type="isListingJobActive(row) ? 'danger' : 'warning'"
                  :loading="oneClickPublishingRows.has(Number(row.id || 0)) || cancelingListingJobs.has(Number(row.listing_job_id || 0)) || retryingListingJobs.has(Number(row.listing_job_id || 0))"
                  @click="handleListingAction(row)"
                >
                  {{ isListingJobActive(row) ? "中断上架" : "一键上架" }}
                </el-button>
                <el-button class="erp-btn-link" link type="primary" :icon="MagicStick" @click="startVariant(row)">AI优化</el-button>
                <el-button class="erp-btn-link" link type="success" :disabled="row.selection_status === 'listed'" @click="addToInventory(row)">加入库存</el-button>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="维护操作" width="72" fixed="right" align="center">
            <template #default="{ row }">
              <div class="table-actions is-vertical">
                <el-button class="erp-btn-link" link type="primary" @click="openEditDialog(row)">编辑</el-button>
                <el-button class="erp-btn-link-danger" link type="danger" @click="handleDelete(row)">删除</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <PageFooterPagination
        class="selection-footer"
        :total="total"
        :page="state.filters.page"
        :page-size="state.filters.pageSize"
        @update:page="handlePageChange"
        @update:pageSize="handlePageSizeChange"
      />
    </el-card>

    <el-dialog
      v-model="listingShopDialog.visible"
      title="选择上架店铺"
      width="720px"
      align-center
      destroy-on-close
      class="listing-shop-dialog erp-centered-dialog"
      @closed="closeListingShopDialog"
    >
      <div class="listing-shop-dialog-body" v-loading="listingShopDialog.loading">
        <div class="listing-shop-hero">
          <div class="listing-shop-hero-icon">
            <Sparkles :size="18" />
          </div>
          <div class="listing-shop-hero-main">
            <span>一键上架确认</span>
            <strong>{{ listingShopDialog.row?.name || listingShopDialog.row?.selection_id || "-" }}</strong>
            <p>默认全店铺上架；临时测试或避开店铺时，取消对应店铺即可。</p>
          </div>
          <div class="listing-shop-hero-count">
            <strong>{{ listingShopDialog.selectedShopIds.length }}</strong>
            <span>/ {{ listingShopDialog.shops.length }} 店铺</span>
          </div>
        </div>
        <div class="listing-shop-tools">
          <el-button class="erp-btn erp-btn-secondary" size="small" plain @click="selectAllListingShops">全选</el-button>
          <el-button class="erp-btn erp-btn-secondary" size="small" plain @click="clearListingShops">清空</el-button>
          <el-button class="erp-btn erp-btn-secondary" size="small" plain @click="selectOwnerListingShops">负责人店铺</el-button>
          <el-button class="erp-btn erp-btn-secondary" size="small" plain @click="selectMainPriceListingShops">主价店铺</el-button>
        </div>
        <el-empty v-if="!listingShopDialog.loading && !listingShopDialog.shops.length" description="暂无可上架店铺" />
        <div v-else class="listing-shop-grid">
          <button
            v-for="shop in listingShopDialog.shops"
            :key="shop.id"
            type="button"
            class="listing-shop-option"
            :class="{ 'is-selected': isListingShopSelected(shop.id) }"
            @click="toggleListingShop(shop.id)"
          >
            <span class="listing-shop-check">{{ isListingShopSelected(shop.id) ? "✓" : "" }}</span>
            <div class="listing-shop-avatar">{{ listingShopInitial(shop.name) }}</div>
            <div class="listing-shop-option-content">
              <div class="listing-shop-option-main">
                <strong>{{ shop.name }}</strong>
                <span>{{ shop.legalEntity || "未配置主体" }}</span>
              </div>
              <div class="listing-shop-option-meta">
                <span>{{ shop.status || "active" }}</span>
                <span>{{ shop.priceLabel }} · 价格指数 {{ shop.priceIndex }}</span>
              </div>
            </div>
          </button>
        </div>
      </div>
      <template #footer>
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="closeListingShopDialog">取消</el-button>
          <el-button
            type="primary"
            :loading="listingShopDialog.submitting"
            :disabled="listingShopDialog.loading || !listingShopDialog.selectedShopIds.length"
            @click="submitListingShopDialog"
          >
            确认上架
          </el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog
      v-model="dialogVisible"
      :title="dialogTitle"
      width="1180px"
      align-center
      destroy-on-close
      class="selection-form-dialog erp-centered-dialog"
      @closed="handleDialogClosed"
    >
      <el-form ref="formRef" :model="dialog.form" :rules="formRules" label-width="112px">
        <div class="selection-workbench">
          <div class="selection-workbench-main">
            <el-alert
              v-if="dialog.form.is_variant_generated"
              type="warning"
              :closable="false"
              show-icon
              class="variant-source-alert"
            >
              <template #title>
                该商品由「{{ dialog.form.source_selection_id || "未知" }} 母商品」通过「{{ variantTypeText(dialog.form.variant_type) }}」生成。
              </template>
              <div class="variant-source-actions">
                <el-button size="small" @click="dialog.form.source_selection_id && startVariant({ id: dialog.form.source_selection_id })">查看母商品</el-button>
                <el-button size="small" @click="startVariant(dialog.form)">查看裂变任务</el-button>
              </div>
            </el-alert>
            <div class="form-section">
              <div class="form-section-title">基础信息</div>
              <el-row :gutter="18">
                <el-col :span="12">
                  <el-form-item label="商品名称" prop="name">
                    <el-input v-model="dialog.form.name" placeholder="请输入商品名称" />
                  </el-form-item>
                </el-col>
                <el-col :span="12">
                  <el-form-item label="负责人" prop="owner_person_id">
                    <el-select v-model="dialog.form.owner_person_id" placeholder="请选择负责人">
                      <el-option v-for="person in state.people" :key="person.id" :label="person.name" :value="person.id" />
                    </el-select>
                  </el-form-item>
                </el-col>
                <el-col :span="12">
                  <el-form-item label="Ozon 类目">
                    <OzonCategorySelect
                      v-model="dialog.form.ozon_category_id"
                      :full-refresh="false"
                      :display-label="dialog.form.ozon_category_name"
                      placeholder="搜索并绑定本地 Ozon 类目"
                      @select="handleSelectionOzonCategorySelected"
                    />
                  </el-form-item>
                </el-col>
                <el-col v-if="vehicleBrandOptions.length" :span="6">
                  <el-form-item label="汽车品牌">
                    <el-select
                      v-model="dialog.form.vehicle_brand"
                      filterable
                      clearable
                      allow-create
                      default-first-option
                      :loading="catalogDictionaryLoading"
                      placeholder="选择 Ozon 汽车品牌"
                    >
                      <el-option v-for="item in vehicleBrandOptions" :key="catalogOptionValue(item)" :label="catalogOptionLabel(item)" :value="catalogOptionValue(item)" />
                    </el-select>
                  </el-form-item>
                </el-col>
                <el-col v-if="vehicleOptions.length || dialog.form.vehicle_model" :span="6">
                  <el-form-item label="汽车型号">
                    <el-select
                      v-model="dialog.form.vehicle_model"
                      filterable
                      allow-create
                      default-first-option
                      :loading="catalogDictionaryLoading"
                      placeholder="选择或输入车型"
                    >
                      <el-option v-for="item in vehicleOptions" :key="catalogOptionValue(item)" :label="catalogOptionLabel(item)" :value="catalogOptionValue(item)" />
                    </el-select>
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="材质">
                    <el-select
                      v-model="dialog.form.material"
                      filterable
                      allow-create
                      default-first-option
                      :loading="materialOptionsLoading"
                      placeholder="选择或输入材质"
                    >
                      <el-option v-for="item in materialOptions" :key="catalogOptionValue(item)" :label="catalogOptionLabel(item)" :value="catalogOptionValue(item)" />
                    </el-select>
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="颜色">
                    <el-select
                      v-model="dialog.form.color"
                      multiple
                      filterable
                      allow-create
                      default-first-option
                      collapse-tags
                      collapse-tags-tooltip
                      :loading="catalogDictionaryLoading"
                      placeholder="选择或输入颜色"
                    >
                      <el-option v-for="item in colorOptions" :key="catalogOptionValue(item)" :label="catalogOptionLabel(item)" :value="catalogOptionValue(item)" />
                    </el-select>
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="数量" prop="purchase_quantity">
                    <el-input-number v-model="dialog.form.purchase_quantity" :min="1" :precision="0" :step="1" controls-position="right" @focus="selectNumericInput" />
                  </el-form-item>
                </el-col>
                <el-col :span="4">
                  <el-form-item label="长(cm)" label-width="64px">
                    <el-input v-model.number="dialog.form.length_cm" class="dimension-input" type="number" min="0" inputmode="numeric" @focus="selectNumericInput" />
                  </el-form-item>
                </el-col>
                <el-col :span="4">
                  <el-form-item label="宽(cm)" label-width="64px">
                    <el-input v-model.number="dialog.form.width_cm" class="dimension-input" type="number" min="0" inputmode="numeric" @focus="selectNumericInput" />
                  </el-form-item>
                </el-col>
                <el-col :span="4">
                  <el-form-item label="高(cm)" label-width="64px">
                    <el-input v-model.number="dialog.form.height_cm" class="dimension-input" type="number" min="0" inputmode="numeric" @focus="selectNumericInput" />
                  </el-form-item>
                </el-col>
                <el-col :span="4">
                  <el-form-item label="克重(g)" label-width="70px">
                    <el-input v-model.number="dialog.form.package_weight_g" class="dimension-input" type="number" min="0" inputmode="numeric" @focus="selectNumericInput" />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="物流规则">
                    <el-select v-model="dialog.form.logistics_rule_id" filterable placeholder="优先中国邮政 / CEL 陆空标准" @change="manualLogisticsRule = true">
                      <el-option
                        v-for="rule in logisticsRuleOptions"
                        :key="rule.id"
                        :label="logisticsRuleLabel(rule)"
                        :value="rule.id"
                      />
                    </el-select>
                  </el-form-item>
                </el-col>
                <el-col :span="24">
                  <el-form-item>
                    <template #label>
                      <span class="selling-points-label">
                        <span>产品卖点</span>
                        <el-tooltip content="根据名称、车型、材质和已有卖点生成/丰富文案" placement="top">
                          <el-button
                            class="selling-points-ai-button"
                            size="small"
                            type="primary"
                            link
                            :icon="Sparkles"
                            :loading="aiSellingPointsLoading"
                            @click.stop.prevent="generateSellingPointsByAi"
                          >
                            AI丰富
                          </el-button>
                        </el-tooltip>
                      </span>
                    </template>
                    <el-input
                      v-model="dialog.form.selling_points"
                      type="textarea"
                      :rows="3"
                      placeholder="输入产品核心卖点，后续会用于素材裂变和上架文案"
                    />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="来源平台">
                    <el-select v-model="dialog.form.source_platform">
                      <el-option label="1688" value="1688" />
                      <el-option label="淘宝" value="taobao" />
                      <el-option label="拼多多" value="pinduoduo" />
                      <el-option label="供应商" value="supplier" />
                      <el-option label="其他" value="other" />
                    </el-select>
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="供应商">
                    <el-select v-model="dialog.form.supplier_id" clearable placeholder="请选择供应商">
                      <el-option v-for="supplier in state.suppliers" :key="supplier.id" :label="supplier.name" :value="supplier.id" />
                    </el-select>
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="采购链接">
                    <el-input v-model="dialog.form.purchase_url" placeholder="https://detail.1688.com/..." />
                  </el-form-item>
                </el-col>
              </el-row>
            </div>

            <div class="form-section">
              <div class="form-section-title">上传主图和详情图</div>
              <el-row :gutter="18">
                <el-col :span="12">
                  <el-form-item label="上传主图">
                    <el-upload
                      :show-file-list="false"
                      :auto-upload="false"
                      accept="image/*"
                      :on-change="handleImageUploadChange"
                    >
                      <el-button :loading="imageUploadLoading">上传本地图片</el-button>
                    </el-upload>
                    <el-button v-if="dialog.form.image_url" link type="danger" @click="clearUploadedImage">清除</el-button>
                  </el-form-item>
                </el-col>
                <el-col :span="12">
                  <el-form-item label="上传详情图">
                    <el-upload
                      :show-file-list="false"
                      :auto-upload="false"
                      multiple
                      accept="image/*"
                      :on-change="handleDetailImageUploadChange"
                    >
                      <el-button :loading="detailImageUploadLoading">上传详情图</el-button>
                    </el-upload>
                  </el-form-item>
                </el-col>
                <el-col :span="24">
                  <div class="selection-media-grid">
                    <div class="selection-image-preview-row">
                      <ProductImagePreview :src="dialog.form.image_url" />
                      <div class="selection-image-preview-meta">
                        <strong>商品主图</strong>
                        <span>{{ dialog.form.image_url ? "点击缩略图可预览" : "未上传图片" }}</span>
                      </div>
                    </div>
                    <div class="detail-image-list">
                      <div v-for="(image, index) in normalizeDetailImages(dialog.form.detail_image_urls)" :key="`${image}-${index}`" class="detail-image-item">
                        <ProductImagePreview :src="image" />
                        <el-button link type="danger" @click="removeDetailImage(index)">移除</el-button>
                      </div>
                      <div v-if="!normalizeDetailImages(dialog.form.detail_image_urls).length" class="detail-image-empty">未上传详情图</div>
                    </div>
                  </div>
                </el-col>
              </el-row>
            </div>

            <div class="form-section">
              <div class="form-section-title">采购与物流</div>
              <el-row :gutter="18">
                <el-col :span="8">
                  <el-form-item label="采购成本">
                    <el-input-number v-model="dialog.form.purchase_cost" :min="0" :precision="1" :step="0.1" controls-position="right" @focus="selectNumericInput" />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="国内运费">
                    <el-input-number v-model="dialog.form.domestic_shipping" :min="0" :precision="1" :step="0.1" controls-position="right" @focus="selectNumericInput" />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="打包费">
                    <el-input-number v-model="dialog.form.handling_fee" :min="0" :precision="1" :step="0.1" controls-position="right" @focus="selectNumericInput" @change="manualPackagingFee = true" />
                  </el-form-item>
                </el-col>
              </el-row>
            </div>

            <div class="form-section">
              <div class="form-section-title">定价与利润</div>
              <el-row :gutter="18">
                <el-col :span="8">
                  <el-form-item label="售价(RMB)">
                    <el-input-number v-model="dialog.form.sale_price_rmb" :min="0" :precision="1" :step="0.1" controls-position="right" @focus="selectNumericInput" />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="标价(RUB)">
                    <el-input-number :model-value="getListingPriceRub(dialog.form)" :min="0" :precision="1" controls-position="right" disabled />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="汇率">
                    <el-input-number v-model="dialog.form.exchange_rate" :min="0" :precision="1" :step="0.1" controls-position="right" @focus="selectNumericInput" />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="利润模式">
                    <el-select v-model="dialog.form.desired_profit_mode">
                      <el-option label="净利率" value="margin" />
                      <el-option label="利润额" value="profit" />
                    </el-select>
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="利润目标">
                    <el-input-number v-model="dialog.form.desired_profit_value" :min="0" :precision="1" :step="0.1" controls-position="right" @focus="selectNumericInput" />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="广告预算(%)">
                    <el-input-number v-model="dialog.form.advertising_rate" :min="0" :max="100" :precision="1" :step="0.1" controls-position="right" @focus="selectNumericInput" />
                  </el-form-item>
                </el-col>
                <el-col :span="8">
                  <el-form-item label="退货率(%)">
                    <el-input-number v-model="dialog.form.return_rate" :min="0" :max="100" :precision="1" :step="0.1" controls-position="right" @focus="selectNumericInput" />
                  </el-form-item>
                </el-col>
                <el-col :span="24">
                  <el-form-item label="供应商备注">
                    <el-input
                      v-model="dialog.form.supplier_note"
                      type="textarea"
                      :rows="3"
                      placeholder="记录采购渠道、MOQ、打样或谈价说明"
                    />
                  </el-form-item>
                </el-col>
              </el-row>
            </div>
            <div class="form-section">
              <div class="selection-preview-head">
                <div>
                  <div class="form-section-title">预估模型</div>
                  <span class="selection-preview-subtitle">当前填写内容会实时反推利润结果和费用拆解。</span>
                </div>
                <el-tag effect="plain">{{ previewNumbers.targetMode === "margin" ? "按利润率定价" : "按利润额定价" }}</el-tag>
              </div>

              <div class="selection-preview-compare">
                <div class="selection-preview-row">
                  <div v-for="card in selectionPreviewCurrentRow" :key="card.label" class="selection-preview-card">
                    <span>{{ card.label }}</span>
                    <strong>{{ card.value }}</strong>
                    <small>{{ card.hint }}</small>
                  </div>
                </div>
                <div class="selection-preview-row selection-preview-row--suggested">
                  <div v-for="card in selectionPreviewSuggestedRow" :key="card.label" class="selection-preview-card">
                    <span>{{ card.label }}</span>
                    <strong>{{ card.value }}</strong>
                    <small>{{ card.hint }}</small>
                  </div>
                </div>
              </div>

              <div class="selection-detail-title">费用明细</div>
              <el-table :data="buildPreviewDetailRows(dialog.form, previewNumbers, selectedLogisticsRule)" border class="erp-data-table selection-preview-table" max-height="320">
                <el-table-column prop="label" label="项目" width="140" />
                <el-table-column prop="value" label="金额" width="120" align="right" />
                <el-table-column prop="note" label="说明" min-width="180" />
              </el-table>
            </div>
          </div>
        </div>
      </el-form>

      <template #footer>
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="dialogVisible = false">取消</el-button>
          <el-button
            v-if="selectionReturnTarget() && dialog.mode === 'edit'"
            class="erp-btn erp-btn-secondary"
            :loading="dialogSubmitting"
            @click="submitDialog({ returnAfter: true })"
          >
            保存并返回AI工作台
          </el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :loading="dialogSubmitting" @click="submitDialog">保存</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="profitDialogVisible" title="净利计算明细" width="980px" align-center class="erp-centered-dialog" @closed="closeProfitDialog">
      <div v-if="profitDialog.row && profitDialog.quote" class="page-stack">
        <div class="profit-dialog-title">
          <div class="product-cell">
            <ProductImagePreview
              :src="profitDialog.row.image_url"
              :preview-list="profitDialog.row.image_url ? [profitDialog.row.image_url] : null"
              fit="cover"
            />
            <div class="cell-stack gap-sm">
              <strong>{{ profitDialog.row.name || "-" }}</strong>
              <span class="muted-text">{{ profitDialog.row.selection_id || profitDialog.row.code || "-" }} / {{ methodName(profitDialog.channelKey) }}</span>
              <span class="muted-text">物流分类：{{ getPricing(profitDialog.row)?.categoryLabel || "-" }}</span>
            </div>
          </div>
          <div class="profit-summary-cards">
            <div class="profit-summary-card">
              <span class="muted-text">净利润</span>
              <strong>{{ money(profitDialog.quote.profit) }}</strong>
            </div>
            <div class="profit-summary-card">
              <span class="muted-text">净利率</span>
              <strong>{{ percentText(profitDialog.quote.margin) }}</strong>
            </div>
            <div class="profit-summary-card">
              <span class="muted-text">建议售价</span>
              <strong>{{ getCurrentSuggestedRub(profitDialog.row, profitDialog.logisticsRule) ? `${money(getCurrentSuggestedRub(profitDialog.row, profitDialog.logisticsRule))} RUB` : "-" }}</strong>
            </div>
          </div>
        </div>

        <el-alert type="info" :closable="false" show-icon>
          <template #title>{{ profitFormulaText }}</template>
        </el-alert>

        <el-table :data="buildProfitDetailRows(profitDialog.row, profitDialog.quote, profitDialog.channelKey, profitDialog.logisticsRule)" border stripe class="erp-data-table profit-detail-table">
          <el-table-column prop="label" label="项目" width="160" />
          <el-table-column prop="value" label="金额" width="160" align="right">
            <template #default="{ row }">
              <strong :class="{ 'profit-total-text': row.total }">{{ row.value }}</strong>
            </template>
          </el-table-column>
          <el-table-column prop="note" label="计算说明" min-width="420" />
        </el-table>
      </div>
    </el-dialog>

    <el-dialog v-model="importDialogVisible" title="批量导入选品" width="980px" align-center class="erp-centered-dialog">
      <div class="page-stack">
        <el-upload
          drag
          :auto-upload="false"
          :show-file-list="false"
          accept=".csv,text/csv"
          :on-change="handleImportFileChange"
        >
          <div class="import-dropzone">
            <strong>{{ importState.fileName || "拖拽或点击上传 CSV 文件" }}</strong>
            <span>请选择从飞书导出的 CSV 文件，系统会先做预解析。</span>
          </div>
        </el-upload>

        <div v-if="importLoading" class="import-empty">正在解析 CSV...</div>

        <template v-else-if="importState.total > 0">
          <div class="import-summary">
            <span>共 {{ importState.total }} 行</span>
            <el-tag type="success">可导入 {{ importState.valid }}</el-tag>
            <el-tag :type="importState.invalid ? 'danger' : 'info'">异常 {{ importState.invalid }}</el-tag>
          </div>

          <div class="import-table-wrap">
            <el-table :data="importPreviewRows" stripe border class="erp-data-table">
              <el-table-column prop="index" label="行号" width="80" />
              <el-table-column label="商品" min-width="240">
                <template #default="{ row }">
                  <div class="cell-stack gap-sm">
                    <strong>{{ row.data?.name || "-" }}</strong>
                    <span class="muted-text">{{ row.data?.supplier_note || "-" }}</span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="人员" min-width="120">
                <template #default="{ row }">{{ personName(row.data?.owner_person_id) || "-" }}</template>
              </el-table-column>
              <el-table-column label="采购 / 售价" min-width="150" align="right">
                <template #default="{ row }">{{ money(row.data?.purchase_cost) }} / {{ money(row.data?.air_sale_price_rmb) }}</template>
              </el-table-column>
              <el-table-column label="状态" min-width="220">
                <template #default="{ row }">
                  <div class="cell-stack gap-sm">
                    <el-tag :type="row.ok ? 'success' : 'danger'">{{ row.ok ? "可导入" : "异常" }}</el-tag>
                    <span class="muted-text">{{ importStatusText(row) || "-" }}</span>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </div>

          <div v-if="importState.rows.length > importPreviewRows.length" class="table-footer-meta">
            只预览前 {{ importPreviewRows.length }} 行，确认后会导入全部可用行。
          </div>
        </template>

        <div v-else class="import-empty">请选择从飞书导出的 CSV 文件。</div>
      </div>

      <template #footer>
        <div class="erp-dialog-footer">
          <el-button class="erp-btn erp-btn-secondary" @click="importDialogVisible = false">取消</el-button>
          <el-button class="erp-btn erp-btn-primary" type="primary" :disabled="!importCommitRows.length" :loading="importSubmitting" @click="commitImport">
            确认导入
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.selection-page {
  min-height: 0;
}

.selection-hero p {
  max-width: 760px;
}

.selection-table-card {
  min-height: 0;
}

.selection-filter-panel {
  margin-bottom: 12px;
}

.selection-filter-panel :deep(.el-form) {
  align-items: center;
  display: flex;
  gap: 0;
  width: 100%;
}

.selection-filter-refresh {
  margin-left: auto;
  margin-right: 0;
}

.selection-filter-refresh :deep(.el-form-item__content) {
  align-items: center;
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.toolbar-right {
  color: var(--erp-text-secondary);
  font-size: 13px;
}

.selection-table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.selection-table {
  min-width: 1780px;
}

.selection-table :deep(.el-table__cell) {
  padding: 8px 0;
}

.selection-footer {
  margin-top: auto;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.gap-sm {
  gap: 4px;
}

.gap-xs {
  gap: 2px;
}

.align-end {
  align-items: flex-end;
}

.align-center {
  align-items: center;
}

.muted-text {
  color: var(--erp-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.field-hint {
  margin-top: 6px;
  color: var(--erp-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.product-cell {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.product-name {
  line-height: 1.35;
}

.selling-points-cell {
  color: var(--erp-text-secondary);
  font-size: 13px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.listing-job-cell {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-height: 56px;
}

.listing-job-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: #b8c2d6;
  box-shadow: 0 0 0 4px rgba(184, 194, 214, .16);
}

.listing-job-dot.is-queued {
  background: #e6a23c;
  box-shadow: 0 0 0 4px rgba(230, 162, 60, .16);
}

.listing-job-dot.is-running {
  background: #409eff;
  box-shadow: 0 0 0 4px rgba(64, 158, 255, .16);
}

.listing-job-dot.is-success {
  background: #67c23a;
  box-shadow: 0 0 0 4px rgba(103, 194, 58, .16);
}

.listing-job-dot.is-failed {
  background: #f56c6c;
  box-shadow: 0 0 0 4px rgba(245, 108, 108, .16);
}

.listing-job-dot.spinning {
  position: relative;
}

.listing-job-dot.spinning::after {
  content: "";
  position: absolute;
  inset: -5px;
  border-radius: 50%;
  border: 2px solid rgba(64, 158, 255, .2);
  border-top-color: currentColor;
  animation: listing-job-spin 900ms linear infinite;
}

.listing-job-content {
  display: grid;
  gap: 4px;
  min-width: 0;
  color: var(--erp-text-secondary);
  font-size: 12px;
  line-height: 1.45;
}

.listing-job-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.listing-job-title-row strong {
  min-width: 0;
  color: var(--erp-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}

.listing-job-status-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  cursor: help;
}

.listing-job-title-row :deep(.el-tag) {
  flex: 0 0 auto;
  height: 20px;
  padding: 0 6px;
  line-height: 18px;
}

.listing-content-check-tag {
  cursor: help;
  border-color: #cbd5e1;
  color: #475569;
  background: #f8fafc;
}

.listing-job-meta,
.listing-job-progress-line,
.listing-job-error,
.listing-job-fix-tip {
  max-width: 240px;
}

.listing-job-progress-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  color: var(--erp-text-secondary);
}

.listing-job-progress-line span + span::before {
  content: "/";
  margin-right: 6px;
  color: var(--erp-border-strong);
}

@keyframes listing-job-spin {
  to {
    transform: rotate(360deg);
  }
}

.product-thumb {
  width: 64px;
  height: 84px;
  border-radius: 8px;
  border: 1px solid var(--erp-border);
  background: #fff;
  flex-shrink: 0;
}

.product-thumb-empty {
  display: grid;
  place-items: center;
  color: var(--erp-text-secondary);
  font-size: 12px;
  background: var(--erp-surface-alt);
}

.quote-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}

.quote-card {
  display: grid;
  gap: 5px;
  padding: 10px;
  border: 1px solid var(--erp-border);
  border-radius: 12px;
  background: #f9fbfd;
  font-size: 12px;
}

.quote-card.is-missing {
  background: #fcfcfc;
  border-style: dashed;
}

.quote-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.table-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px 10px;
}

.table-actions.is-vertical {
  flex-direction: column;
  align-items: center;
  flex-wrap: nowrap;
  gap: 4px;
}

.table-actions.is-vertical :deep(.el-button) {
  margin-left: 0;
  padding: 0;
  min-height: 20px;
  font-size: 12px;
}

.form-section {
  padding: 14px 16px 4px;
  border: 1px solid var(--erp-border);
  border-radius: 14px;
  background: var(--erp-surface-alt);
}

.form-section + .form-section {
  margin-top: 14px;
}

.form-section-title {
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--erp-text);
}

.selection-image-preview-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--erp-border);
  border-radius: 12px;
  background: var(--erp-surface);
}

.selection-image-preview-meta {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.selection-image-preview-meta strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--erp-text);
}

.selection-image-preview-meta span {
  font-size: 12px;
  color: var(--erp-text-secondary);
}

.selection-media-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.8fr) minmax(0, 1.2fr);
  gap: 12px;
}

.detail-image-list {
  min-height: 76px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--erp-border);
  border-radius: 12px;
  background: var(--erp-surface);
}

.detail-image-item {
  display: grid;
  justify-items: center;
  gap: 4px;
}

.detail-image-empty {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.selection-preview-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.selection-preview-subtitle {
  display: block;
  margin-top: -4px;
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.selection-preview-compare {
  display: grid;
  gap: 12px;
  margin-bottom: 12px;
}

.selection-preview-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.selection-preview-row--suggested {
  padding-top: 2px;
}

.selection-preview-card {
  display: grid;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--erp-border);
  border-radius: 12px;
  background: var(--erp-surface);
}

.selection-preview-card span,
.selection-preview-card small {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.selection-preview-card strong {
  color: var(--erp-text);
  font-size: 20px;
  line-height: 1.2;
}

.selection-preview-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}

.selection-preview-fact {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.72);
  border: 1px solid rgba(148, 163, 184, 0.14);
}

.selection-preview-fact span {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.selection-preview-fact strong {
  color: var(--erp-text);
  font-size: 14px;
  line-height: 1.35;
}

.selection-detail-title {
  margin-bottom: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--erp-text);
}

.selling-points-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.selling-points-ai-button {
  height: 24px;
  padding: 0;
  font-weight: 600;
}

.selling-points-ai-button :deep(svg) {
  width: 14px;
  height: 14px;
}

.selection-form-dialog :deep(.el-input-number) {
  width: 100%;
  min-width: 104px;
}

.selection-form-dialog :deep(.el-input-number .el-input__wrapper) {
  padding-left: 8px;
  padding-right: 34px;
}

.selection-form-dialog :deep(.el-input-number .el-input__inner) {
  text-align: left;
  min-width: 0;
}

.selection-form-dialog :deep(.dimension-input .el-input__wrapper) {
  min-width: 88px;
}

.selection-form-dialog :deep(.dimension-input .el-input__inner) {
  text-align: left;
}

.variant-source-alert {
  margin-bottom: 14px;
}

.variant-source-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

.listing-shop-dialog-body {
  display: grid;
  gap: 12px;
  min-height: 220px;
}

.listing-shop-hero {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 14px;
  border: 1px solid #dce8f6;
  border-radius: 8px;
  background: #f8fbff;
}

.listing-shop-hero-icon {
  width: 42px;
  height: 42px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: #1677ff;
  background: #eef6ff;
  border: 1px solid #cfe1ff;
}

.listing-shop-hero-main {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.listing-shop-hero-main span,
.listing-shop-hero-main p,
.listing-shop-hero-count span {
  color: #697386;
  font-size: 12px;
}

.listing-shop-hero-main strong {
  color: #172033;
  font-size: 16px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.listing-shop-hero-main p {
  margin: 0;
}

.listing-shop-hero-count {
  min-width: 84px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #fff;
  border: 1px solid #edf1f7;
  text-align: center;
}

.listing-shop-hero-count strong {
  display: block;
  color: #1677ff;
  font-size: 22px;
  line-height: 1.1;
}

.listing-shop-tools {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.listing-shop-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  max-height: 420px;
  overflow: auto;
  padding-right: 4px;
}

.listing-shop-option {
  position: relative;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  width: 100%;
  min-height: 86px;
  text-align: left;
  border: 1px solid #e5eaf3;
  border-radius: 8px;
  padding: 12px;
  background: #fff;
  cursor: pointer;
  transition: border-color .16s ease, box-shadow .16s ease, background .16s ease, transform .16s ease;
}

.listing-shop-option:hover {
  border-color: #8bbcff;
  box-shadow: 0 8px 22px rgba(22, 119, 255, .08);
  transform: translateY(-1px);
}

.listing-shop-option.is-selected {
  border-color: #1677ff;
  background: #f7fbff;
  box-shadow: 0 0 0 2px rgba(22, 119, 255, .10);
}

.listing-shop-check {
  position: absolute;
  right: 10px;
  top: 10px;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: #fff;
  background: #1677ff;
  font-size: 12px;
  line-height: 1;
  opacity: 0;
}

.listing-shop-option.is-selected .listing-shop-check {
  opacity: 1;
}

.listing-shop-avatar {
  width: 44px;
  height: 44px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: #24518f;
  background: #eef6ff;
  border: 1px solid #d7e8ff;
  font-weight: 700;
  letter-spacing: 0;
}

.listing-shop-option-content {
  display: grid;
  gap: 9px;
  min-width: 0;
}

.listing-shop-option-main {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.listing-shop-option-main span,
.listing-shop-option-meta {
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.listing-shop-option-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.listing-shop-option-meta span {
  padding: 3px 7px;
  border-radius: 5px;
  background: #f4f7fb;
  color: #5d6b82;
}

.profit-dialog-title {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.profit-summary-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(120px, 1fr));
  gap: 12px;
  min-width: 360px;
}

.profit-summary-card {
  display: grid;
  gap: 4px;
  padding: 14px 16px;
  border: 1px solid var(--erp-border);
  border-radius: 14px;
  background: #f8fafc;
}

.profit-summary-card strong {
  font-size: 18px;
  line-height: 1.2;
}

.profit-total-text {
  color: #0f766e;
}

.profit-detail-table :deep(.el-table__row:last-child td) {
  background: rgba(15, 118, 110, 0.08);
}

.listing-job-error {
  color: #dc2626;
  max-width: 220px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.listing-job-fix-tip {
  color: #b45309;
  max-width: 240px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.import-dropzone {
  display: grid;
  gap: 6px;
  padding: 16px;
  text-align: center;
}

.import-dropzone strong {
  font-size: 15px;
}

.import-dropzone span,
.import-empty {
  color: var(--erp-text-secondary);
  font-size: 13px;
}

.import-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.import-table-wrap {
  max-height: 420px;
  overflow: auto;
}

@media (max-width: 960px) {
  .selection-preview-row,
  .selection-preview-facts {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 1360px) {
  .quote-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 960px) {
  .profit-summary-cards {
    grid-template-columns: 1fr;
    min-width: 0;
    width: 100%;
  }
}
</style>
