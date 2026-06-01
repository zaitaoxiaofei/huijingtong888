<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { InfoFilled } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { apiClient } from "../../utils/api";
import { createLatestRequestGate } from "../../utils/request-gate";
import PageFooterPagination from "../../components/PageFooterPagination.vue";
import ProductImagePreview from "../../components/ProductImagePreview.vue";
import InventoryPageToolbar from "../../components/inventory/InventoryPageToolbar.vue";
import { applyFilterQuery, buildFilterQuery, dateText, integer } from "./inventory-utils.js";

const route = useRoute();
const router = useRouter();
const listRequestGate = createLatestRequestGate();
let syncingRoute = false;
let shopsLoaded = false;
let routeReady = false;

const loading = ref(false);
const exportLoading = ref(false);
const previewFrameRef = ref(null);
const barcodeLoadingKeys = reactive({});
const barcodePrintPresets = [
  { label: "条形码 70mm x 30mm", value: "barcode_70x30", printer: "label", printSettings: "fit,portrait,monochrome,paper=70mm x 30mm" },
  { label: "FBP 面单 72mm x 130mm", value: "fbp_label_72x130", printer: "label", printSettings: "fit,portrait,monochrome,paper=72mm x 130mm" },
  { label: "订单面单 72mm x 130mm", value: "order_label_72x130", printer: "label", printSettings: "fit,portrait,monochrome,paper=72mm x 130mm" }
];
barcodePrintPresets[0].label = "小面单 / 小标签 70mm x 30mm";
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
    `FBP：${integer(row.fbp_available)} 件`,
    `本地：在库 ${integer(row.local_stock)} + 在途 ${integer(row.pending_procurement_qty)} = ${integer(localInventoryTotal(row))} 件`,
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

function openProcurement(row) {
  router.push({ path: "/procurement", query: { productId: String(row.product_id || ""), from: "fbp-opportunities" } });
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
  state.filters.query,
  state.filters.shopId,
  state.filters.priority,
  state.filters.signal,
  state.filters.minSales,
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
        <div class="fbp-toolbar-summary">
          <article v-for="card in summaryCards" :key="card.label" class="fbp-toolbar-summary-item">
            <span>{{ card.label }}</span>
            <strong>{{ card.value }}</strong>
          </article>
        </div>
      </template>
    </InventoryPageToolbar>

    <div class="inventory-table-wrap">
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
            <el-tooltip placement="top" effect="light" :content="inventoryTooltip(row)" :popper-style="{ whiteSpace: 'pre-line', maxWidth: '280px' }">
              <div class="inventory-summary-cell">
                <span><strong>FBP</strong><em>{{ integer(row.fbp_available) }}</em></span>
                <span><strong>本地</strong><em>{{ integer(localInventoryTotal(row)) }}</em></span>
                <span><strong>FBS</strong><em>{{ integer(row.fbs_available) }}</em></span>
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
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <div class="fbp-actions-cell">
              <el-button size="small" class="fbp-inline-button fbp-inline-button-primary" @click="openProcurement(row)">创建采购</el-button>
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
  display: grid;
  gap: 14px;
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
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: flex-start;
  gap: 8px;
  min-width: 144px;
  padding: 2px 0;
  cursor: help;
}

.inventory-summary-cell span {
  display: grid;
  gap: 2px;
  justify-items: center;
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
  display: flex;
  justify-content: center;
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
