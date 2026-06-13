<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { InfoFilled } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { createLatestRequestGate } from "../../utils/request-gate";
import { createDefaultRouteQuerySync } from "../../utils/route-query-sync.js";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import InventoryPageToolbar from "../../components/inventory/InventoryPageToolbar.vue";
import ProcurementRequestCreateDialog from "../../components/procurement/ProcurementRequestCreateDialog.vue";
import { applyFilterQuery, dateText, integer } from "./inventory-utils.js";

const route = useRoute();
const router = useRouter();
const listRequestGate = createLatestRequestGate();
let syncingRoute = false;
let shopsLoaded = false;
let routeReady = false;

const loading = ref(false);
const exportLoading = ref(false);
const supplySyncLoading = ref(false);
const pdfImportVisible = ref(false);
const pdfPreviewLoading = ref(false);
const pdfImportSubmitting = ref(false);
const pdfImportFileName = ref("");
const pdfImportBase64 = ref("");
const previewFrameRef = ref(null);
const fbpTableWrapRef = ref(null);
const procurementCreateVisible = ref(false);
const procurementCreateProductId = ref(null);
const fbpTransferVisible = ref(false);
const fbpTransferSubmitting = ref(false);
const fbpTransferRow = ref(null);
const fbpReceiveVisible = ref(false);
const fbpReceiveLoading = ref(false);
const fbpReceiveSubmittingId = ref(0);
const fbpReceiveRow = ref(null);
const fbpReceiveRecords = ref([]);
const fbpReceiveForm = reactive({
  recordId: 0,
  receivedQuantity: 0,
  note: ""
});
const fbpTransferForm = reactive({
  quantity: 1,
  status: "sent",
  tracking_no: "",
  box_no: "",
  expected_arrival_at: "",
  note: ""
});
const barcodeLoadingKeys = reactive({});
const barcodePrintPresets = [
  { label: "条形码 70mm x 30mm", value: "barcode_70x30", printer: "label", printSettings: "fit,portrait,monochrome,paper=70mm x 30mm" },
  { label: "FBP 面单 72mm x 130mm", value: "fbp_label_72x130", printer: "label", printSettings: "fit,portrait,monochrome,paper=72mm x 130mm" },
  { label: "订单面单 72mm x 130mm", value: "order_label_72x130", printer: "label", printSettings: "fit,portrait,monochrome,paper=72mm x 130mm" }
];
barcodePrintPresets[0].label = "标签面单 30mm x 70mm";
barcodePrintPresets[0].printSettings = "noscale,portrait,monochrome,paper=70mm*30mm";
barcodePrintPresets[1].printSettings = "noscale,portrait,monochrome,paper=72mm x 130mm";
barcodePrintPresets[2].printSettings = "noscale,portrait,monochrome,paper=72mm x 130mm";
const barcodePreview = reactive({
  visible: false,
  loading: false,
  url: "",
  filename: "",
  pdfBase64: "",
  count: 0,
  printer: "",
  printers: barcodePrintPresets,
  helperAvailable: false,
  helperStatus: "",
  directPrinting: false
});
const pdfImportPreview = reactive({
  shop: null,
  header: {},
  items: [],
  checks: {}
});
const state = reactive({
  rows: [],
  total: 0,
  summary: {},
  shops: [],
  filters: {
    query: "",
    shopId: "all",
    priority: "all",
    signal: "all",
    minSales: "",
    sortKey: "score",
    sortDir: "desc",
    page: 1,
    pageSize: 20
  }
});

const filterDefaults = {
  query: "",
  shopId: "all",
  priority: "all",
  signal: "all",
  minSales: "",
  sortKey: "score",
  sortDir: "desc",
  page: 1,
  pageSize: 20
};

const summaryCards = computed(() => [
  { label: "推荐", value: integer(state.summary.total) },
  { label: "建议入库", value: `${integer(state.summary.suggested_total_qty)} 件` }
]);

function priorityType(priority) {
  if (priority === "high") return "danger";
  if (priority === "medium") return "warning";
  return "info";
}

function coverageText(row) {
  if (row.coverage_days === null || row.coverage_days === undefined) {
    return Number(row.fbp_available || 0) > 0 ? "暂无销量" : "未覆盖";
  }
  return `${Number(row.coverage_days || 0).toFixed(1)} 天`;
}

function warehouseText(row) {
  const warehouses = Array.isArray(row.warehouses) ? row.warehouses : [];
  if (!warehouses.length) return "-";
  return warehouses.slice(0, 2).map((item) => `${item.name || "仓库"} ${integer(item.available ?? item.present)}`).join(" / ");
}

function localInventoryTotal(row) {
  return Number(row.local_stock || 0) + Number(row.pending_procurement_qty || 0);
}

function transferActionTooltip(row) {
  return [
    `建议发仓：${integer(row.suggested_transfer_qty)} 件`,
    `建议采购：${integer(row.suggested_purchase_qty)} 件`,
    `发仓在途：${integer(row.fbp_transfer_in_transit_qty)} 件`
  ].join("\n");
}

function inventoryTooltipCn(row) {
  return [
    `本地：库存 ${integer(row.local_stock)} + 采购在途 ${integer(row.pending_procurement_qty)} = ${integer(localInventoryTotal(row))} 件`,
    `FBP发仓：${integer(row.fbp_transfer_in_transit_qty)} 件`,
    `FBP可售：${integer(row.fbp_available)} 件`,
    `FBS可售：${integer(row.fbs_available)} 件`,
    `覆盖天数：${coverageText(row)}`,
    `仓库分布：${warehouseText(row)}`
  ].join("\n");
}

function suggestedQtyTooltip(row) {
  return `建议入库：${integer(row.suggested_qty)} 件\n目标覆盖：${integer(row.target_days)} 天`;
}

function salesTooltip(row) {
  return `30天销量：${integer(row.recent_30d_qty)} 件\n7天销量：${integer(row.recent_7d_qty)} 件`;
}

function trendTooltip(row) {
  return `趋势：${row.trend_text || "-"}\n近三周：${integer(row.week3_qty)} / ${integer(row.week2_qty)} / ${integer(row.week1_qty)}`;
}

function inventoryTooltip(row) {
  return [
    `本地：在库 ${integer(row.local_stock)} + 采购在途 ${integer(row.pending_procurement_qty)} = ${integer(localInventoryTotal(row))} 件`,
    `FBP发仓：${integer(row.fbp_transfer_in_transit_qty)} 件`,
    `FBP：${integer(row.fbp_available)} 件`,
    `FBS：${integer(row.fbs_available)} 件`,
    `覆盖：${coverageText(row)}`,
    `仓库分布：${warehouseText(row)}`
  ].join("\n");
}

function reasonTooltip(row) {
  return String(row.reason || "-");
}

function buildListParams(overrides = {}) {
  const params = new URLSearchParams({
    page: String(overrides.page ?? state.filters.page),
    pageSize: String(overrides.pageSize ?? state.filters.pageSize),
    shopId: String(state.filters.shopId || "all"),
    priority: String(state.filters.priority || "all"),
    signal: String(state.filters.signal || "all"),
    minSales: String(state.filters.minSales || ""),
    sortKey: String(state.filters.sortKey || "score"),
    sortDir: String(state.filters.sortDir || "desc")
  });
  const query = String(state.filters.query || "").trim();
  if (query) params.set("query", query);
  return params;
}

async function exportSkuIds() {
  exportLoading.value = true;
  try {
    const pageSize = 200;
    const firstPayload = await apiClient.get(`/api/fbp-opportunities?${buildListParams({ page: 1, pageSize }).toString()}`);
    const total = Number(firstPayload?.total || 0);
    const rows = Array.isArray(firstPayload?.rows) ? [...firstPayload.rows] : [];
    const pageCount = Math.ceil(total / pageSize);
    for (let page = 2; page <= pageCount; page += 1) {
      const payload = await apiClient.get(`/api/fbp-opportunities?${buildListParams({ page, pageSize }).toString()}`);
      rows.push(...(Array.isArray(payload?.rows) ? payload.rows : []));
    }
    const skuIds = [...new Set(rows.map((row) => String(row.ozon_sku || "").trim()).filter(Boolean))];
    if (!skuIds.length) {
      ElMessage.warning("当前筛选下没有可导出的 SKU ID");
      return;
    }
    const text = skuIds.join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fbp-sku-ids-${new Date().toISOString().slice(0, 10)}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    navigator.clipboard?.writeText(text).catch(() => {});
    ElMessage.success(`已导出 ${skuIds.length} 个 SKU ID`);
  } catch (error) {
    ElMessage.error(error.message || "导出 SKU ID 失败");
  } finally {
    exportLoading.value = false;
  }
}

async function syncOzonSupplyOrders() {
  supplySyncLoading.value = true;
  try {
    const payload = await apiClient.post("/api/sync/ozon-fbo-supplies", {
      shop_id: state.filters.shopId === "all" ? null : state.filters.shopId
    });
    if (payload?.status === "partial_error") {
      ElMessage.warning(payload?.message || "Ozon入仓请求已部分同步，请查看失败店铺");
    } else {
      ElMessage.success(payload?.message || "Ozon入仓请求已同步");
    }
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "同步 Ozon 入仓请求失败");
  } finally {
    supplySyncLoading.value = false;
  }
}

function setSort(sortKey) {
  if (state.filters.sortKey === sortKey) state.filters.sortDir = state.filters.sortDir === "asc" ? "desc" : "asc";
  else {
    state.filters.sortKey = sortKey;
    state.filters.sortDir = "desc";
  }
  state.filters.page = 1;
  loadPageData();
}

function sortMark(sortKey) {
  if (state.filters.sortKey !== sortKey) return "";
  return state.filters.sortDir === "asc" ? "↑" : "↓";
}

function applyRouteState() {
  syncingRoute = true;
  try {
    applyFilterQuery(route, state.filters, filterDefaults);
  } finally {
    syncingRoute = false;
  }
}

const syncRouteQuery = createDefaultRouteQuerySync({
  route,
  router,
  filters: state.filters,
  defaults: filterDefaults,
  manualKeys: ["query", "minSales"],
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

function handleFbpTableWheel(event) {
  const wrap = fbpTableWrapRef.value;
  if (!wrap || !event?.deltaY) return;
  const before = wrap.scrollTop;
  wrap.scrollTop += event.deltaY;
  if (wrap.scrollTop !== before) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function openProcurement(row) {
  procurementCreateProductId.value = Number(row.product_id || 0) || null;
  procurementCreateVisible.value = Boolean(procurementCreateProductId.value);
}

async function handleProcurementCreated() {
  procurementCreateVisible.value = false;
  procurementCreateProductId.value = null;
  await loadPageData();
}

function openFbpTransfer(row) {
  fbpTransferRow.value = row;
  fbpTransferForm.quantity = Math.max(1, Math.round(Number(row?.suggested_transfer_qty || row?.suggested_qty || 1)));
  fbpTransferForm.status = "sent";
  fbpTransferForm.tracking_no = "";
  fbpTransferForm.box_no = "";
  fbpTransferForm.expected_arrival_at = "";
  fbpTransferForm.note = row?.suggested_action === "purchase"
    ? `备货建议：先采购 ${integer(row.suggested_purchase_qty)} 件，采购到货后发 FBP`
    : `备货建议：本地发仓 ${integer(row.suggested_transfer_qty || row.suggested_qty)} 件`;
  fbpTransferVisible.value = true;
}

async function submitFbpTransfer() {
  const row = fbpTransferRow.value;
  if (!row?.product_id) {
    ElMessage.error("缺少产品信息，无法创建 FBP 发仓");
    return;
  }
  const quantity = Math.max(1, Math.round(Number(fbpTransferForm.quantity || 0)));
  fbpTransferSubmitting.value = true;
  try {
    await apiClient.post("/api/fbp-transfer-records", {
      product_id: row.product_id,
      mapping_id: row.mapping_id || null,
      shop_id: row.shop_id || null,
      ozon_sku: row.ozon_sku || "",
      quantity,
      status: fbpTransferForm.status || "sent",
      tracking_no: fbpTransferForm.tracking_no,
      box_no: fbpTransferForm.box_no,
      expected_arrival_at: fbpTransferForm.expected_arrival_at || null,
      note: fbpTransferForm.note
    });
    ElMessage.success("FBP 发仓记录已创建");
    fbpTransferVisible.value = false;
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "创建 FBP 发仓失败");
  } finally {
    fbpTransferSubmitting.value = false;
  }
}

function remainingReceiveQuantity(record) {
  return Math.max(0, Number(record?.quantity || 0) - Number(record?.listed_quantity || 0));
}

function fbpTransferStatusText(status) {
  return {
    draft: "草稿",
    sent: "已发出",
    in_transit: "运输中",
    received: "部分入仓",
    listed: "已入仓",
    exception: "异常",
    closed: "已关闭",
    cancelled: "已取消"
  }[status] || status || "-";
}

async function loadFbpReceiveRecords() {
  const row = fbpReceiveRow.value;
  if (!row?.product_id) return;
  fbpReceiveLoading.value = true;
  try {
    const params = new URLSearchParams({
      productId: String(row.product_id || ""),
      shopId: String(row.shop_id || ""),
      ozonSku: String(row.ozon_sku || ""),
      onlyOpen: "1",
      pageSize: "100"
    });
    const payload = await apiClient.get(`/api/fbp-transfer-records?${params.toString()}`);
    fbpReceiveRecords.value = Array.isArray(payload?.rows) ? payload.rows : [];
  } catch (error) {
    ElMessage.error(error.message || "FBP 发仓记录加载失败");
  } finally {
    fbpReceiveLoading.value = false;
  }
}

async function openFbpReceiveDialog(row) {
  if (Number(row?.fbp_transfer_in_transit_qty || 0) <= 0) {
    ElMessage.info("当前没有待确认的 FBP 发仓");
    return;
  }
  fbpReceiveRow.value = row;
  fbpReceiveForm.recordId = 0;
  fbpReceiveForm.receivedQuantity = 0;
  fbpReceiveForm.note = "";
  fbpReceiveVisible.value = true;
  await loadFbpReceiveRecords();
}

function prepareFbpReceive(record) {
  fbpReceiveForm.recordId = Number(record.id || 0);
  fbpReceiveForm.receivedQuantity = remainingReceiveQuantity(record);
  fbpReceiveForm.note = "";
}

async function confirmFbpReceive(record) {
  const recordId = Number(record?.id || fbpReceiveForm.recordId || 0);
  if (!recordId) return;
  const quantity = Number(fbpReceiveForm.recordId === recordId ? fbpReceiveForm.receivedQuantity : remainingReceiveQuantity(record));
  if (quantity <= 0) {
    ElMessage.warning("请输入本次入仓数量");
    return;
  }
  fbpReceiveSubmittingId.value = recordId;
  try {
    const payload = await apiClient.post("/api/fbp-transfer-records/confirm-received", {
      id: recordId,
      received_quantity: quantity,
      note: fbpReceiveForm.recordId === recordId ? fbpReceiveForm.note : ""
    });
    ElMessage.success(payload?.remaining_quantity > 0 ? "已确认部分入仓" : "已确认全部入仓");
    await loadFbpReceiveRecords();
    await loadPageData();
    if (!fbpReceiveRecords.value.some((item) => remainingReceiveQuantity(item) > 0)) {
      fbpReceiveVisible.value = false;
    }
  } catch (error) {
    ElMessage.error(error.message || "确认 FBP 入仓失败");
  } finally {
    fbpReceiveSubmittingId.value = 0;
  }
}

function rowBarcodeLoadingKey(row) {
  return String(row?.online_product_id || row?.mapping_id || row?.ozon_sku || row?.offer_id || "");
}

function barcodePrintLoading(row) {
  return Boolean(barcodeLoadingKeys[`${rowBarcodeLoadingKey(row)}:print`]);
}

function barcodePreviewLoading(row) {
  return Boolean(barcodeLoadingKeys[`${rowBarcodeLoadingKey(row)}:preview`]);
}

function barcodeGenerateLoading(row) {
  return Boolean(barcodeLoadingKeys[`${rowBarcodeLoadingKey(row)}:generate`]);
}

function barcodeHasCache(row) {
  return Boolean(row?.barcode_cached_at);
}

function filenameFromDisposition(value, fallback = "ozon-barcodes.pdf") {
  const raw = String(value || "");
  const utf8 = raw.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {}
  }
  const plain = raw.match(/filename="?([^"]+)"?/i);
  return plain?.[1] || fallback;
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function resetPdfImportPreview() {
  pdfImportFileName.value = "";
  pdfImportBase64.value = "";
  pdfImportPreview.shop = null;
  pdfImportPreview.header = {};
  pdfImportPreview.items = [];
  pdfImportPreview.checks = {};
}

function openPdfImportDialog() {
  resetPdfImportPreview();
  pdfImportVisible.value = true;
}

async function handlePdfImportFileChange(file) {
  const rawFile = file?.raw || file;
  if (!rawFile) return;
  if (!String(rawFile.name || "").toLowerCase().endsWith(".pdf")) {
    ElMessage.error("请上传 PDF 文件");
    return;
  }
  pdfImportFileName.value = rawFile.name || "fbp-supply.pdf";
  pdfPreviewLoading.value = true;
  try {
    pdfImportBase64.value = await blobToBase64(rawFile);
    const payload = await apiClient.post("/api/fbp-transfer-records/pdf-preview", {
      pdf_base64: pdfImportBase64.value,
      filename: pdfImportFileName.value
    });
    pdfImportPreview.shop = payload.shop || null;
    pdfImportPreview.header = payload.header || {};
    pdfImportPreview.items = Array.isArray(payload.items) ? payload.items : [];
    pdfImportPreview.checks = payload.checks || {};
    if (pdfImportPreview.checks.unmatched_count) {
      ElMessage.warning(`PDF 已解析，有 ${pdfImportPreview.checks.unmatched_count} 个 SKU 未匹配`);
    } else {
      ElMessage.success("PDF 已解析，SKU 全部匹配");
    }
  } catch (error) {
    resetPdfImportPreview();
    ElMessage.error(error.message || "解析 FBP 入库单 PDF 失败");
  } finally {
    pdfPreviewLoading.value = false;
  }
}

async function confirmPdfImport() {
  if (!pdfImportBase64.value) {
    ElMessage.warning("请先上传并解析 PDF");
    return;
  }
  if (Number(pdfImportPreview.checks?.unmatched_count || 0) > 0) {
    ElMessage.error("还有 SKU 未匹配，请先绑定后再导入");
    return;
  }
  pdfImportSubmitting.value = true;
  try {
    const payload = await apiClient.post("/api/fbp-transfer-records/pdf-import", {
      pdf_base64: pdfImportBase64.value,
      filename: pdfImportFileName.value
    });
    ElMessage.success(payload?.message || "FBP 入库单已导入");
    pdfImportVisible.value = false;
    resetPdfImportPreview();
    await loadPageData();
  } catch (error) {
    ElMessage.error(error.message || "导入 FBP 入库单失败");
  } finally {
    pdfImportSubmitting.value = false;
  }
}

function ensureBarcodeTarget(row, actionText) {
  if (!row?.online_product_id && !(row?.shop_id && (row?.ozon_sku || row?.offer_id))) {
    ElMessage.error(`这条备货机会缺少在线商品定位信息，暂时无法${actionText}`);
    return false;
  }
  return true;
}

function barcodeRequestItem(row, quantity = 1) {
  return {
    online_product_id: Number(row.online_product_id || 0),
    shop_id: Number(row.shop_id || 0),
    ozon_sku: String(row.ozon_sku || ""),
    offer_id: String(row.offer_id || ""),
    quantity
  };
}

function printerName(printer) {
  return String(printer?.Name || printer?.name || "").trim();
}

function printerLabel(printer) {
  const name = printerName(printer);
  return printer?.Default ? `${name}（默认）` : name;
}

function choosePreferredPrinter(printers = []) {
  const list = (printers || []).filter((item) => printerName(item));
  const labelPrinter = list.find((item) => /gprinter|gp-?1324d/i.test(printerName(item)));
  if (labelPrinter) return printerName(labelPrinter);
  const defaultPrinter = list.find((item) => item?.Default);
  if (defaultPrinter) return printerName(defaultPrinter);
  return printerName(list[0]);
}

const canUseOfficialBarcodePdf = computed(() => Boolean(
  window?.ozonDesktop?.isElectron
  && typeof window?.ozonDesktop?.downloadOfficialBarcodePdf === "function"
));

function markBarcodeCached(row) {
  row.barcode_cached = true;
  row.barcode_cached_at = new Date().toISOString();
}

function resetBarcodePreview() {
  if (barcodePreview.url) URL.revokeObjectURL(barcodePreview.url);
  barcodePreview.visible = false;
  barcodePreview.loading = false;
  barcodePreview.url = "";
  barcodePreview.filename = "";
  barcodePreview.pdfBase64 = "";
  barcodePreview.count = 0;
  barcodePreview.printer = "";
  barcodePreview.printers = barcodePrintPresets;
  barcodePreview.helperAvailable = false;
  barcodePreview.helperStatus = "";
  barcodePreview.directPrinting = false;
}

function openBarcodePreviewDialog(count) {
  if (barcodePreview.url) URL.revokeObjectURL(barcodePreview.url);
  barcodePreview.visible = true;
  barcodePreview.loading = true;
  barcodePreview.url = "";
  barcodePreview.filename = "";
  barcodePreview.pdfBase64 = "";
  barcodePreview.count = count;
  barcodePreview.printer = "barcode_70x30";
  barcodePreview.printers = barcodePrintPresets;
  barcodePreview.helperAvailable = false;
  barcodePreview.helperStatus = "正在生成条码 PDF...";
  barcodePreview.directPrinting = false;
}

async function loadLocalPrinters() {
  barcodePreview.helperAvailable = false;
  barcodePreview.printers = barcodePrintPresets;
  barcodePreview.printer = barcodePreview.printer || "barcode_70x30";
  barcodePreview.helperStatus = "正在检测服务器打印服务...";
  try {
    const payload = await apiClient.get("/api/print/printers");
    if (!payload?.ok || payload?.roles?.label?.installed === false) throw new Error("printers failed");
    barcodePreview.helperStatus = "服务器打印服务已连接";
    barcodePreview.helperAvailable = true;
  } catch {
    barcodePreview.helperAvailable = false;
    barcodePreview.helperStatus = "服务器打印服务不可用，可先预览或下载 PDF";
  }
}

async function openBarcodePreviewFromResponse(response, count) {
  if (barcodePreview.url) URL.revokeObjectURL(barcodePreview.url);
  barcodePreview.url = URL.createObjectURL(response.blob);
  barcodePreview.pdfBase64 = await blobToBase64(response.blob);
  barcodePreview.filename = filenameFromDisposition(response.headers.get("Content-Disposition"), "ozon-barcodes.pdf");
  barcodePreview.count = count;
  barcodePreview.loading = false;
  await loadLocalPrinters();
}

async function openOfficialBarcodePreview(row, count) {
  if (!canUseOfficialBarcodePdf.value) return false;
  const official = await window.ozonDesktop.downloadOfficialBarcodePdf({
    ozon_sku: row.ozon_sku,
    offer_id: row.offer_id
  });
  if (!official?.ok || !official?.path) {
    throw new Error(official?.message || "未能从 Ozon 卖家后台下载官方 PDF");
  }
  const buffer = await fetch(`file:///${official.path.replace(/\\/g, "/")}`).then((res) => {
    if (!res.ok) throw new Error("读取官方 PDF 失败");
    return res.arrayBuffer();
  });
  const blob = new Blob([buffer], { type: "application/pdf" });
  const response = {
    blob,
    headers: new Headers({
      "Content-Disposition": `attachment; filename="${official.filename || "official-barcode.pdf"}"`
    })
  };
  await openBarcodePreviewFromResponse(response, count);
  return true;
}

function printBarcodePreviewInBrowser() {
  const target = previewFrameRef.value?.contentWindow;
  if (!target) {
    ElMessage.warning("PDF 预览还没准备好，请稍后再试");
    return;
  }
  try {
    target.focus();
    target.print();
  } catch {
    window.open(barcodePreview.url, "_blank", "noopener");
  }
}

async function directPrintBarcodePreview() {
  if (!barcodePreview.pdfBase64) {
    ElMessage.error("当前没有可打印的 PDF");
    return;
  }
  barcodePreview.directPrinting = true;
  barcodePreview.helperStatus = "正在发送到服务器打印机...";
  try {
    const preset = barcodePrintPresets.find((item) => item.value === barcodePreview.printer) || barcodePrintPresets[0];
    await apiClient.post("/api/print/jobs", {
      pdf_base64: barcodePreview.pdfBase64,
      filename: barcodePreview.filename || "ozon-barcodes.pdf",
      printer: preset.printer,
      print_settings: preset.printSettings,
      preset: preset.value,
      paper_size: preset.value,
      source: "fbp-barcode-preview"
    });
    barcodePreview.helperStatus = "已发送到打印机";
    ElMessage.success("条码已发送到服务器标签打印机");
  } catch (error) {
    barcodePreview.helperStatus = "直接打印失败，已回退到浏览器打印";
    ElMessage.warning(error.message || "直接打印失败，已回退到浏览器打印");
    printBarcodePreviewInBrowser();
  } finally {
    barcodePreview.directPrinting = false;
  }
}

function downloadBarcodePreviewFile() {
  if (!barcodePreview.url) return;
  const link = document.createElement("a");
  link.href = barcodePreview.url;
  link.download = barcodePreview.filename || "ozon-barcodes.pdf";
  link.click();
}

function openBarcodePreviewInNewWindow() {
  if (!barcodePreview.url) return;
  window.open(barcodePreview.url, "_blank", "noopener");
}

async function generateBarcode(row, options = {}) {
  if (!ensureBarcodeTarget(row, "生成条码")) return false;
  const key = `${rowBarcodeLoadingKey(row)}:generate`;
  barcodeLoadingKeys[key] = true;
  try {
    await apiClient.post("/api/products/barcode-label/generate", {
      items: [barcodeRequestItem(row, 1)],
      refresh_cache: options.refreshCache !== false,
      force_generate: options.forceGenerate === true
    });
    markBarcodeCached(row);
    ElMessage.success(options.forceGenerate ? "条码已重新生成" : "条码已生成");
    return true;
  } catch (error) {
    ElMessage.error(error.message || "生成条码失败");
    return false;
  } finally {
    delete barcodeLoadingKeys[key];
  }
}

async function previewBarcodeLabel(row) {
  if (!ensureBarcodeTarget(row, "预览条码")) return;
  if (!barcodeHasCache(row)) {
    ElMessage.warning("这条商品还没有生成条码 PDF，请先点“生成条码”");
    return;
  }
  const key = `${rowBarcodeLoadingKey(row)}:preview`;
  barcodeLoadingKeys[key] = true;
  openBarcodePreviewDialog(1);
  try {
    if (canUseOfficialBarcodePdf.value) {
      const opened = await openOfficialBarcodePreview(row, 1);
      if (opened) return;
    }
    const response = await apiClient.blobResponse("/api/products/barcode-label", {
      method: "POST",
      body: JSON.stringify({
        items: [barcodeRequestItem(row, 1)]
      })
    });
    await openBarcodePreviewFromResponse(response, 1);
  } catch (error) {
    resetBarcodePreview();
    ElMessage.error(error.message || "预览条码 PDF 失败");
  } finally {
    delete barcodeLoadingKeys[key];
  }
}

async function printBarcodeLabel(row) {
  if (!ensureBarcodeTarget(row, "打印条码")) return;
  let promptValue = String(Math.max(1, Math.round(Number(row?.suggested_qty || 1))));
  try {
    const result = await ElMessageBox.prompt("请输入这次要打印的条码数量", "打印条码 PDF", {
      confirmButtonText: "继续",
      cancelButtonText: "取消",
      inputValue: promptValue,
      inputPattern: /^[1-9]\d{0,2}$/,
      inputErrorMessage: "请输入 1-999 的整数"
    });
    promptValue = String(result?.value || promptValue).trim();
  } catch {
    return;
  }

  if (!barcodeHasCache(row)) {
    const generated = await generateBarcode(row, { refreshCache: true });
    if (!generated) return;
  }

  const quantity = Math.max(1, Math.min(999, Math.round(Number(promptValue || 1))));
  const key = `${rowBarcodeLoadingKey(row)}:print`;
  barcodeLoadingKeys[key] = true;
  openBarcodePreviewDialog(quantity);
  try {
    if (canUseOfficialBarcodePdf.value && quantity === 1) {
      const opened = await openOfficialBarcodePreview(row, quantity);
      if (opened) return;
    }
    const response = await apiClient.blobResponse("/api/products/barcode-label", {
      method: "POST",
      body: JSON.stringify({
        items: [barcodeRequestItem(row, quantity)]
      })
    });
    await openBarcodePreviewFromResponse(response, quantity);
  } catch (error) {
    resetBarcodePreview();
    ElMessage.error(error.message || "打印条码 PDF 失败");
  } finally {
    delete barcodeLoadingKeys[key];
  }
}

async function loadPageData() {
  const requestToken = listRequestGate.next();
  loading.value = true;
  try {
    const params = buildListParams();
    const requests = [apiClient.get(`/api/fbp-opportunities?${params.toString()}`)];
    if (!shopsLoaded) requests.push(apiClient.get("/api/shops"));
    const [payload, shops] = await Promise.all(requests);
    if (!listRequestGate.isLatest(requestToken)) return;
    state.rows = Array.isArray(payload?.rows) ? payload.rows : [];
    state.total = Number(payload?.total || 0);
    state.summary = payload?.summary || {};
    if (!shopsLoaded) {
      state.shops = Array.isArray(shops) ? shops : [];
      shopsLoaded = true;
    }
  } catch (error) {
    if (!listRequestGate.isLatest(requestToken)) return;
    ElMessage.error(error.message || "FBP 备货机会加载失败");
  } finally {
    if (listRequestGate.isLatest(requestToken)) loading.value = false;
  }
}

watch(
  () => route.query,
  async () => {
    applyRouteState();
    if (!routeReady) return;
    await loadPageData();
  },
  { deep: true }
);
watch(() => [
  state.filters.shopId,
  state.filters.priority,
  state.filters.signal,
  state.filters.sortKey,
  state.filters.sortDir,
  state.filters.page,
  state.filters.pageSize
], syncRouteQuery);

onMounted(async () => {
  applyRouteState();
  routeReady = true;
  await loadPageData();
});
</script>

<template>
  <div class="inventory-page-shell inventory-card fbp-opportunity-page">
    <InventoryPageToolbar
      :filters="state.filters"
      :shops="state.shops"
      :show-date-range="false"
      query-label="机会搜索"
      query-placeholder="店铺 / SKU / Offer / 产品名称"
      @search="handleSearch"
      @reset="handleReset"
    >
      <el-form-item label="优先级">
        <el-select v-model="state.filters.priority" style="width: 150px">
          <el-option label="全部" value="all" />
          <el-option label="高优先级" value="high" />
          <el-option label="中优先级" value="medium" />
          <el-option label="观察" value="watch" />
        </el-select>
      </el-form-item>
      <el-form-item label="信号">
        <el-select v-model="state.filters.signal" style="width: 160px">
          <el-option label="全部" value="all" />
          <el-option label="三周增长" value="growth" />
          <el-option label="FBP低库存" value="low_stock" />
          <el-option label="FBS转FBP" value="fbs_to_fbp" />
        </el-select>
      </el-form-item>
      <el-form-item label="30天销量">
        <el-input v-model="state.filters.minSales" placeholder="最低" style="width: 90px" @keyup.enter="handleSearch" />
      </el-form-item>
      <template #actions>
        <el-button class="erp-btn erp-btn-secondary" @click="openPdfImportDialog">
          导入PDF
        </el-button>
        <el-button class="erp-btn erp-btn-secondary" :loading="supplySyncLoading" @click="syncOzonSupplyOrders">
          同步入仓请求
        </el-button>
        <div class="fbp-toolbar-summary">
          <article v-for="card in summaryCards" :key="card.label" class="fbp-toolbar-summary-item">
            <span>{{ card.label }}</span>
            <strong>{{ card.value }}</strong>
          </article>
        </div>
      </template>
    </InventoryPageToolbar>

    <div ref="fbpTableWrapRef" class="inventory-table-wrap" @wheel.capture="handleFbpTableWheel">
      <el-table v-loading="loading" :data="state.rows" stripe border class="erp-data-table">
        <el-table-column label="店铺" width="130" fixed="left">
          <template #default="{ row }">
            <div class="fbp-cell-stack">
              <div class="fbp-cell-title">{{ row.shop_name || "-" }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="图片" width="82" align="center">
          <template #default="{ row }">
            <ProductImagePreview :src="row.image_url" />
          </template>
        </el-table-column>
        <el-table-column label="SKU ID" min-width="150">
          <template #default="{ row }">
            <el-tooltip
              placement="top"
              effect="light"
              :content="row.name || row.product_name || row.online_name || '-'"
              :popper-style="{ whiteSpace: 'pre-line', maxWidth: '320px' }"
            >
              <div class="fbp-cell-stack fbp-sku-cell">
                <div class="fbp-cell-title fbp-sku-text">{{ row.ozon_sku || "-" }}</div>
              </div>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="建议入库数" width="130" align="center">
          <template #header>
            <button type="button" class="inventory-sort-btn" @click="setSort('suggested_qty')">
              建议入库数 {{ sortMark("suggested_qty") }}
            </button>
          </template>
          <template #default="{ row }">
            <div class="suggested-qty-cell">
              <strong class="suggested-qty-main">{{ integer(row.suggested_qty) }}</strong>
              <el-tooltip placement="top" effect="light" :content="suggestedQtyTooltip(row)" :popper-style="{ whiteSpace: 'pre-line', maxWidth: '220px' }">
                <button type="button" class="cell-meta-trigger">
                  <span class="suggested-qty-meta">{{ integer(row.target_days) }} 天覆盖</span>
                  <el-icon><InfoFilled /></el-icon>
                </button>
              </el-tooltip>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="库存" min-width="180" align="center">
          <template #header>
            <button type="button" class="inventory-sort-btn" @click="setSort('fbp_available')">
              库存 {{ sortMark("fbp_available") }}
            </button>
          </template>
          <template #default="{ row }">
            <el-tooltip placement="top" effect="light" :content="inventoryTooltipCn(row)" :popper-style="{ whiteSpace: 'pre-line', maxWidth: '280px' }">
              <div class="inventory-summary-cell">
                <span><strong>本地+采购</strong><em>{{ integer(localInventoryTotal(row)) }}</em></span>
                <button
                  type="button"
                  class="inventory-summary-action"
                  :disabled="Number(row.fbp_transfer_in_transit_qty || 0) <= 0"
                  @click.stop="openFbpReceiveDialog(row)"
                >
                  <strong>FBP发仓</strong><em>{{ integer(row.fbp_transfer_in_transit_qty) }}</em>
                </button>
                <span><strong>FBP</strong><em>{{ integer(row.fbp_available) }}</em></span>
                <span><strong>FBS</strong><em>{{ integer(row.fbs_available) }}</em></span>
              </div>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="建议动作" width="150" align="center">
          <template #header>
            <button type="button" class="inventory-sort-btn" @click="setSort('suggested_transfer_qty')">
              建议动作 {{ sortMark("suggested_transfer_qty") }}
            </button>
          </template>
          <template #default="{ row }">
            <el-tooltip placement="top" effect="light" :content="transferActionTooltip(row)" :popper-style="{ whiteSpace: 'pre-line', maxWidth: '240px' }">
              <div class="fbp-cell-stack fbp-cell-center">
                <el-tag :type="row.suggested_action === 'transfer' ? 'success' : 'warning'" effect="light">
                  {{ row.suggested_action_text || "观察" }}
                </el-tag>
                <span class="fbp-cell-meta-line">发仓 {{ integer(row.suggested_transfer_qty) }} / 采购 {{ integer(row.suggested_purchase_qty) }}</span>
              </div>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column width="130" align="center">
          <template #header>
            <button type="button" class="inventory-sort-btn" @click="setSort('recent_30d_qty')">
              销量 {{ sortMark("recent_30d_qty") }}
            </button>
          </template>
          <template #default="{ row }">
            <div class="fbp-cell-stack fbp-cell-center">
              <div class="fbp-cell-title">{{ integer(row.recent_30d_qty) }}</div>
              <div class="fbp-cell-meta-line">近30天</div>
              <div class="fbp-cell-meta-line">7天 {{ integer(row.recent_7d_qty) }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="近三周趋势" width="170" align="center">
          <template #default="{ row }">
            <div class="fbp-cell-stack fbp-cell-center">
              <div class="fbp-cell-title">{{ row.trend_text || "-" }}</div>
              <el-tooltip placement="top" effect="light" :content="trendTooltip(row)" :popper-style="{ whiteSpace: 'pre-line', maxWidth: '240px' }">
                <button type="button" class="cell-meta-trigger">
                  <span class="fbp-cell-meta-line">查看近三周</span>
                  <el-icon><InfoFilled /></el-icon>
                </button>
              </el-tooltip>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="优先级" width="120" align="center">
          <template #default="{ row }">
            <div class="fbp-cell-stack fbp-cell-center">
              <el-tag :type="priorityType(row.priority)" effect="light">{{ row.priority_text }}</el-tag>
              <span class="score-text">{{ integer(row.score) }}分</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="推荐原因" min-width="280">
          <template #default="{ row }">
            <el-tooltip placement="top" effect="light" :content="reasonTooltip(row)" :popper-style="{ whiteSpace: 'pre-line', maxWidth: '360px' }">
              <button type="button" class="reason-brief">
                <span>{{ row.reason || "-" }}</span>
                <el-icon><InfoFilled /></el-icon>
              </button>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="条码" width="140" align="center">
          <template #default="{ row }">
            <div class="fbp-barcode-actions">
              <el-button
                v-if="barcodeHasCache(row)"
                size="small"
                class="fbp-inline-button fbp-inline-button-secondary"
                :loading="barcodePreviewLoading(row)"
                @click="previewBarcodeLabel(row)"
              >
                预览
              </el-button>
              <span v-else class="fbp-cell-meta-line">未生成</span>
              <el-button
                size="small"
                class="fbp-inline-button fbp-inline-button-primary"
                :loading="barcodeGenerateLoading(row)"
                @click="generateBarcode(row, { refreshCache: true, forceGenerate: barcodeHasCache(row) })"
              >
                {{ barcodeHasCache(row) ? "重生成" : "生成" }}
              </el-button>
              <el-button
                size="small"
                class="fbp-inline-button fbp-inline-button-secondary"
                :loading="barcodePrintLoading(row)"
                @click="printBarcodeLabel(row)"
              >
                打印
              </el-button>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="190">
          <template #default="{ row }">
            <div class="fbp-cell-stack">
              <div class="fbp-cell-meta-line">生成：{{ barcodeHasCache(row) ? dateText(row.barcode_cached_at) : "-" }}</div>
              <div class="fbp-cell-meta-line">同步：{{ dateText(row.last_synced_at) }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <div class="fbp-actions-cell">
              <el-button
                size="small"
                class="fbp-inline-button fbp-inline-button-primary"
                :disabled="Number(row.suggested_transfer_qty || 0) <= 0 && Number(row.local_stock || 0) <= 0"
                @click="openFbpTransfer(row)"
              >
                创建发仓
              </el-button>
              <el-button
                size="small"
                class="fbp-inline-button fbp-inline-button-secondary"
                :disabled="Number(row.fbp_transfer_in_transit_qty || 0) <= 0"
                @click="openFbpReceiveDialog(row)"
              >
                确认入仓
              </el-button>
              <el-button size="small" class="fbp-inline-button fbp-inline-button-secondary" @click="openProcurement(row)">创建采购</el-button>
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

    <ProcurementRequestCreateDialog
      v-model="procurementCreateVisible"
      :initial-product-id="procurementCreateProductId"
      :lock-product="true"
      @created="handleProcurementCreated"
    />

    <el-dialog
      v-model="fbpReceiveVisible"
      title="确认 FBP 入仓"
      width="min(960px, 96vw)"
      top="6vh"
      destroy-on-close
    >
      <div class="fbp-receive-header" v-if="fbpReceiveRow">
        <ProductImagePreview :src="fbpReceiveRow.image_url" />
        <div>
          <strong>{{ fbpReceiveRow.product_name || fbpReceiveRow.name || fbpReceiveRow.ozon_sku || "产品" }}</strong>
          <span>{{ fbpReceiveRow.shop_name || "-" }} / SKU {{ fbpReceiveRow.ozon_sku || "-" }}</span>
          <em>当前待入仓 {{ integer(fbpReceiveRow.fbp_transfer_in_transit_qty) }} 件</em>
        </div>
      </div>
      <el-table
        v-loading="fbpReceiveLoading"
        :data="fbpReceiveRecords"
        border
        stripe
        class="erp-data-table fbp-receive-table"
      >
        <el-table-column label="状态" width="96">
          <template #default="{ row }">
            <el-tag :type="remainingReceiveQuantity(row) > 0 ? 'warning' : 'success'" effect="light">
              {{ fbpTransferStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="数量" width="150" align="center">
          <template #default="{ row }">
            <div class="fbp-cell-stack fbp-cell-center">
              <strong>{{ integer(row.listed_quantity) }} / {{ integer(row.quantity) }}</strong>
              <span class="fbp-cell-meta-line">剩余 {{ integer(remainingReceiveQuantity(row)) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="入仓单/箱号" min-width="180">
          <template #default="{ row }">
            <div class="fbp-cell-stack">
              <strong>{{ row.source_ref || row.tracking_no || "-" }}</strong>
              <span class="fbp-cell-meta-line">箱号 {{ row.box_no || "-" }}</span>
              <span class="fbp-cell-meta-line">仓库 {{ row.warehouse_name || "-" }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="180">
          <template #default="{ row }">
            <div class="fbp-cell-stack">
              <span class="fbp-cell-meta-line">发出：{{ dateText(row.shipped_at) }}</span>
              <span class="fbp-cell-meta-line">预计：{{ dateText(row.expected_arrival_at) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="本次入仓" width="210">
          <template #default="{ row }">
            <div class="fbp-receive-input">
              <el-input-number
                v-if="fbpReceiveForm.recordId === Number(row.id)"
                v-model="fbpReceiveForm.receivedQuantity"
                :min="1"
                :max="remainingReceiveQuantity(row)"
                :step="1"
                :precision="0"
                controls-position="right"
              />
              <el-button v-else link type="primary" :disabled="remainingReceiveQuantity(row) <= 0" @click="prepareFbpReceive(row)">
                填写数量
              </el-button>
              <el-input
                v-if="fbpReceiveForm.recordId === Number(row.id)"
                v-model="fbpReceiveForm.note"
                placeholder="备注"
                maxlength="80"
              />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              type="primary"
              :disabled="remainingReceiveQuantity(row) <= 0"
              :loading="fbpReceiveSubmittingId === Number(row.id)"
              @click="confirmFbpReceive(row)"
            >
              确认入仓
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="fbpReceiveVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="fbpTransferVisible"
      title="创建 FBP 发仓"
      width="560px"
      align-center
      destroy-on-close
    >
      <div class="fbp-transfer-product" v-if="fbpTransferRow">
        <ProductImagePreview :src="fbpTransferRow.image_url" />
        <div>
          <strong>{{ fbpTransferRow.product_name || fbpTransferRow.name || fbpTransferRow.ozon_sku || "产品" }}</strong>
          <span>{{ fbpTransferRow.shop_name || "-" }} / SKU {{ fbpTransferRow.ozon_sku || "-" }}</span>
        </div>
      </div>
      <el-form label-width="92px" class="fbp-transfer-form">
        <el-form-item label="发仓数量">
          <el-input-number v-model="fbpTransferForm.quantity" :min="1" :step="1" :precision="0" controls-position="right" style="width: 180px" />
          <span class="fbp-form-tip">本地可用 {{ integer(fbpTransferRow?.local_stock) }} 件</span>
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="fbpTransferForm.status" style="width: 180px">
            <el-option label="已发出" value="sent" />
            <el-option label="运输中" value="in_transit" />
            <el-option label="草稿" value="draft" />
          </el-select>
        </el-form-item>
        <el-form-item label="物流单号">
          <el-input v-model="fbpTransferForm.tracking_no" placeholder="可选" />
        </el-form-item>
        <el-form-item label="箱号">
          <el-input v-model="fbpTransferForm.box_no" placeholder="可选" />
        </el-form-item>
        <el-form-item label="预计到达">
          <el-date-picker v-model="fbpTransferForm.expected_arrival_at" type="datetime" value-format="YYYY-MM-DD HH:mm:ss" placeholder="可选" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="fbpTransferForm.note" type="textarea" :rows="3" maxlength="300" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="fbpTransferVisible = false">取消</el-button>
        <el-button type="primary" :loading="fbpTransferSubmitting" @click="submitFbpTransfer">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="pdfImportVisible"
      title="导入 FBP 入库单 PDF"
      width="min(980px, 96vw)"
      top="6vh"
      destroy-on-close
      @closed="resetPdfImportPreview"
    >
      <div class="fbp-pdf-import-shell">
        <el-upload
          class="fbp-pdf-upload"
          drag
          accept="application/pdf,.pdf"
          :auto-upload="false"
          :limit="1"
          :show-file-list="false"
          :on-change="handlePdfImportFileChange"
        >
          <div class="fbp-pdf-upload-text">
            <strong>{{ pdfImportFileName || "选择或拖入 Ozon FBP 入库单 PDF" }}</strong>
            <span>系统会先解析并校验 SKU 匹配，不会直接写入库存</span>
          </div>
        </el-upload>

        <el-skeleton v-if="pdfPreviewLoading" :rows="6" animated />
        <template v-else-if="pdfImportPreview.header?.supply_order_id">
          <div class="fbp-pdf-summary">
            <article>
              <span>入库单</span>
              <strong>{{ pdfImportPreview.header.supply_order_id }}</strong>
            </article>
            <article>
              <span>店铺</span>
              <strong>{{ pdfImportPreview.shop?.name || "-" }}</strong>
            </article>
            <article>
              <span>仓库</span>
              <strong>{{ pdfImportPreview.header.warehouse_name || "-" }}</strong>
            </article>
            <article>
              <span>数量</span>
              <strong>{{ integer(pdfImportPreview.checks.parsed_quantity) }} / {{ integer(pdfImportPreview.header.total_quantity) }}</strong>
            </article>
          </div>
          <el-alert
            v-if="pdfImportPreview.checks.unmatched_count"
            type="warning"
            show-icon
            :closable="false"
            :title="`有 ${pdfImportPreview.checks.unmatched_count} 个 SKU 未匹配，请先绑定后再导入`"
          />
          <el-alert
            v-else
            type="success"
            show-icon
            :closable="false"
            title="SKU 已全部匹配，可以导入为 FBP 发仓在途"
          />
          <el-table :data="pdfImportPreview.items" border stripe class="erp-data-table fbp-pdf-preview-table">
            <el-table-column label="Ozon SKU" prop="ozon_sku" width="150" />
            <el-table-column label="数量" prop="quantity" width="90" align="center" />
            <el-table-column label="匹配产品" min-width="220">
              <template #default="{ row }">
                <span v-if="row.matched">{{ row.product_name || row.product_id }}</span>
                <el-tag v-else type="danger" effect="light">未匹配</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="PDF 商品名" prop="title" min-width="260" show-overflow-tooltip />
          </el-table>
        </template>
      </div>
      <template #footer>
        <el-button @click="pdfImportVisible = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="!pdfImportPreview.header?.supply_order_id || Number(pdfImportPreview.checks?.unmatched_count || 0) > 0"
          :loading="pdfImportSubmitting"
          @click="confirmPdfImport"
        >
          确认导入
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="barcodePreview.visible"
      title="条码 PDF 预览"
      width="min(1120px, 96vw)"
      top="4vh"
      destroy-on-close
      @closed="resetBarcodePreview"
    >
      <div class="barcode-preview-shell">
        <div class="barcode-preview-toolbar">
          <div class="cell-stack">
            <strong>{{ barcodePreview.count > 1 ? `条码打印预览（${barcodePreview.count} 张）` : "条码打印预览" }}</strong>
            <span class="muted-text">{{ barcodePreview.helperStatus || "先预览，确认无误后再打印" }}</span>
          </div>
          <div class="barcode-preview-actions">
            <el-select
              v-model="barcodePreview.printer"
              placeholder="打印尺寸"
              filterable
              style="width: 220px"
              :disabled="!barcodePreview.helperAvailable || barcodePreview.directPrinting"
            >
              <el-option
                v-for="preset in barcodePreview.printers"
                :key="preset.value"
                :label="preset.label"
                :value="preset.value"
              />
            </el-select>
            <el-button
              type="primary"
              :disabled="!barcodePreview.helperAvailable || barcodePreview.loading"
              :loading="barcodePreview.directPrinting"
              @click="directPrintBarcodePreview"
            >
              直接打印
            </el-button>
            <el-button :disabled="barcodePreview.loading || !barcodePreview.url" @click="printBarcodePreviewInBrowser">浏览器打印</el-button>
            <el-button :disabled="barcodePreview.loading || !barcodePreview.url" @click="downloadBarcodePreviewFile">下载 PDF</el-button>
            <el-button :disabled="barcodePreview.loading || !barcodePreview.url" @click="openBarcodePreviewInNewWindow">新窗口打开</el-button>
          </div>
        </div>

        <div v-if="barcodePreview.loading" class="barcode-preview-loading">
          <el-skeleton :rows="8" animated />
        </div>
        <iframe
          v-else
          ref="previewFrameRef"
          class="barcode-preview-frame"
          :src="barcodePreview.url"
          title="条码 PDF 预览"
        />
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.fbp-opportunity-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  overflow: hidden;
}

.fbp-opportunity-page :deep(.inventory-toolbar-sticky) {
  position: relative;
  flex: 0 0 auto;
  z-index: 2;
}

.fbp-opportunity-page .inventory-table-wrap {
  flex: 1 1 auto;
  min-height: 320px;
  overflow: hidden;
}

.fbp-opportunity-page :deep(.erp-data-table) {
  height: 100%;
}

.fbp-opportunity-page :deep(.erp-data-table .el-table__body-wrapper) {
  height: calc(100% - var(--el-table-header-height, 44px));
}

.fbp-toolbar-summary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.fbp-toolbar-summary-item {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 0;
  color: #475569;
}

.fbp-toolbar-summary-item span {
  color: #64748b;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
}

.fbp-toolbar-summary-item strong {
  color: #0f172a;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.2;
  white-space: nowrap;
}

.fbp-pdf-import-shell {
  display: grid;
  gap: 14px;
}

.fbp-pdf-upload :deep(.el-upload-dragger) {
  padding: 22px 18px;
  border-radius: 8px;
}

.fbp-pdf-upload-text {
  display: grid;
  gap: 6px;
  color: #475569;
}

.fbp-pdf-upload-text strong {
  color: #111827;
  font-size: 14px;
}

.fbp-pdf-upload-text span {
  font-size: 12px;
}

.fbp-pdf-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.fbp-pdf-summary article {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #f8fafc;
}

.fbp-pdf-summary span {
  color: #64748b;
  font-size: 12px;
}

.fbp-pdf-summary strong {
  min-width: 0;
  color: #111827;
  font-size: 14px;
  overflow-wrap: anywhere;
}

.fbp-pdf-preview-table {
  max-height: 360px;
}

.fbp-cell-stack {
  display: grid;
  gap: 3px;
}

.fbp-cell-center {
  justify-items: center;
  text-align: center;
}

.fbp-cell-title {
  color: #334155;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}

.fbp-cell-meta-line {
  color: #66758c;
  font-size: 12px;
  line-height: 1.3;
}

.fbp-sku-cell {
  cursor: help;
}

.fbp-sku-text {
  color: #50627d;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.score-text {
  color: #66758c;
  font-size: 12px;
  line-height: 1.35;
}

.suggested-qty-cell {
  display: grid;
  gap: 3px;
  justify-items: center;
  min-width: 88px;
}

.suggested-qty-main {
  color: var(--erp-danger);
  font-size: 20px;
  line-height: 1;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.inventory-summary-cell {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  align-items: flex-start;
  gap: 8px;
  min-width: 144px;
  padding: 2px 0;
  cursor: help;
}

.inventory-summary-cell span,
.inventory-summary-action {
  display: grid;
  gap: 2px;
  justify-items: center;
}

.inventory-summary-action {
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  font: inherit;
}

.inventory-summary-action:disabled {
  cursor: default;
}

.inventory-summary-action:not(:disabled):hover em {
  color: var(--erp-primary);
  text-decoration: underline;
}

.inventory-summary-cell strong {
  min-width: 0;
  color: #66758c;
  font-size: 11px;
  font-weight: 600;
  text-align: center;
}

.inventory-summary-cell em {
  color: #0f172a;
  font-size: 14px;
  font-style: normal;
  font-weight: 700;
  line-height: 1.2;
}

.suggested-qty-meta {
  color: #66758c;
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
}

.cell-meta-trigger,
.reason-brief {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: help;
  font: inherit;
}

.cell-meta-trigger--left,
.reason-brief {
  justify-content: flex-start;
}

.cell-meta-trigger .el-icon,
.reason-brief .el-icon {
  color: #94a3b8;
  font-size: 11px;
}

.reason-brief {
  max-width: 100%;
}

.reason-brief span {
  display: -webkit-box;
  overflow: hidden;
  color: #66758c;
  font-size: 12px;
  line-height: 1.4;
  text-align: left;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.fbp-actions-cell {
  display: grid;
  gap: 6px;
  justify-content: center;
}

.fbp-transfer-product {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  margin-bottom: 14px;
}

.fbp-transfer-product strong,
.fbp-transfer-product span {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fbp-transfer-product strong {
  color: #0f172a;
  font-size: 14px;
  font-weight: 700;
}

.fbp-transfer-product span,
.fbp-form-tip {
  color: #64748b;
  font-size: 12px;
}

.fbp-transfer-form {
  padding-top: 4px;
}

.fbp-receive-header {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  margin-bottom: 14px;
}

.fbp-receive-header strong,
.fbp-receive-header span,
.fbp-receive-header em {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fbp-receive-header strong {
  color: #0f172a;
  font-size: 14px;
  font-weight: 700;
}

.fbp-receive-header span,
.fbp-receive-header em {
  color: #64748b;
  font-size: 12px;
  font-style: normal;
}

.fbp-receive-table {
  width: 100%;
}

.fbp-receive-input {
  display: grid;
  gap: 6px;
}

.fbp-form-tip {
  margin-left: 10px;
}

.fbp-barcode-actions {
  display: grid;
  gap: 6px;
  justify-items: center;
}

.fbp-inline-button.el-button {
  min-height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.fbp-inline-button-primary.el-button {
  border-color: rgba(59, 130, 246, 0.18);
  background: #eff6ff;
  color: #2563eb;
}

.fbp-inline-button-primary.el-button:hover {
  border-color: rgba(59, 130, 246, 0.32);
  background: #dbeafe;
  color: #1d4ed8;
}

.fbp-inline-button-secondary.el-button {
  border-color: rgba(203, 213, 225, 0.82);
  background: #fff;
  color: #475569;
}

.fbp-inline-button-secondary.el-button:hover {
  border-color: rgba(148, 163, 184, 0.9);
  background: #f8fafc;
  color: #334155;
}

.barcode-preview-shell {
  display: grid;
  gap: 12px;
}

.barcode-preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.barcode-preview-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.barcode-preview-loading {
  min-height: 520px;
  padding: 18px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
}

.barcode-preview-frame {
  width: 100%;
  height: 72vh;
  border: 1px solid #dbe3ef;
  border-radius: 10px;
  background: #f8fafc;
}

@media (max-width: 900px) {
  .fbp-toolbar-summary {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
