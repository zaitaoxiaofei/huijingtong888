import { apiClient } from "../../admin/utils/api.js";

function navigateTo(path, query = {}) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    params.set(key, String(value));
  });
  const suffix = params.toString() ? `?${params.toString()}` : "";
  window.location.hash = `#${path}${suffix}`;
  return { ok: true, path, query };
}

export async function submitOrderFilters(filters) {
  return filters;
}

export async function changeOrderStatus(status) {
  return status;
}

export async function changeOrderPrintView(view) {
  return view;
}

export async function changeOrderMarkFilter(value) {
  return value;
}

export async function changeOrderPageSize(pageSize) {
  return pageSize;
}

export async function prevOrderPage() {
  return "prev";
}

export async function nextOrderPage() {
  return "next";
}

export async function syncRecentOrders() {
  return apiClient.post("/api/sync/ozon/incremental", { from_latest: true, fallback_days: 7, overlap_minutes: 15 });
}

export async function syncAllOrders() {
  return apiClient.post("/api/sync/ozon", {});
}

export async function cancelOrderSync() {
  throw new Error("订单同步取消接口尚未接入");
}

export async function openQualityRules() {
  return apiClient.get("/api/order-quality-rules");
}

export async function saveQualityRules(payload = {}) {
  return apiClient.put("/api/order-quality-rules", payload);
}

export async function resetRecentDates() {
  return "reset";
}

function writePrintLoadingPage(printWindow, count) {
  const title = count > 1 ? "正在加载批量面单" : "正在加载面单";
  const detail = count > 1 ? `正在生成 ${count} 个订单的标签 PDF，请稍等...` : "正在生成标签 PDF，请稍等...";
  printWindow.document.open();
  printWindow.document.write(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1f2937;
      background: #f8fafc;
    }
    .panel {
      width: min(420px, calc(100vw - 48px));
      padding: 28px 30px;
      border: 1px solid #dbe3ef;
      border-radius: 14px;
      background: #fff;
      box-shadow: 0 18px 40px rgba(15, 23, 42, 0.10);
    }
    .spinner {
      width: 30px;
      height: 30px;
      border: 3px solid #dbeafe;
      border-top-color: #2563eb;
      border-radius: 999px;
      animation: spin 0.9s linear infinite;
    }
    h1 {
      margin: 18px 0 8px;
      font-size: 18px;
      line-height: 1.3;
    }
    p {
      margin: 0;
      color: #64748b;
      font-size: 13px;
      line-height: 1.6;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main class="panel">
    <div class="spinner" aria-hidden="true"></div>
    <h1>${title}</h1>
    <p>${detail}</p>
  </main>
</body>
</html>`);
  printWindow.document.close();
}

function writePrintPreviewPage(printWindow, { url, count }) {
  const title = count > 1 ? "面单打印确认" : "面单打印确认";
  printWindow.document.open();
  printWindow.document.write(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1f2937;
      background: #f8fafc;
    }
    .bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 10px 14px;
      border-bottom: 1px solid #dbe3ef;
      background: #fff;
      box-shadow: 0 1px 8px rgba(15, 23, 42, 0.08);
    }
    .title {
      min-width: 0;
      display: grid;
      gap: 2px;
    }
    h1 {
      margin: 0;
      font-size: 15px;
      line-height: 1.3;
    }
    p {
      margin: 0;
      color: #64748b;
      font-size: 12px;
      line-height: 1.4;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    button, a {
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 12px;
      border-radius: 6px;
      border: 1px solid #cbd5e1;
      color: #334155;
      background: #fff;
      font-size: 13px;
      text-decoration: none;
      cursor: pointer;
    }
    button.primary {
      border-color: #2563eb;
      color: #fff;
      background: #2563eb;
    }
    button.danger {
      color: #991b1b;
      border-color: #fecaca;
      background: #fff;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: 0;
      background: #e5e7eb;
    }
  </style>
</head>
<body>
  <header class="bar">
    <div class="title">
      <h1>${title}</h1>
      <p>请先完成浏览器或 PDF 预览里的打印。确认已经打印后，再点击“确认已打印”。</p>
    </div>
    <div class="actions">
      <button type="button" id="printNow">打印</button>
      <a href="${url}" target="_blank" rel="noopener">打开 PDF</a>
      <button type="button" id="cancelPrint" class="danger">取消</button>
      <button type="button" id="confirmPrinted" class="primary">确认已打印</button>
    </div>
  </header>
  <iframe id="labelFrame" src="${url}" title="面单 PDF"></iframe>
</body>
</html>`);
  printWindow.document.close();
}

function writePrintPreviewPageSafe(printWindow, { url }) {
  printWindow.document.open();
  printWindow.document.write(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>&#38754;&#21333;&#25171;&#21360;&#30830;&#35748;</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1f2937;
      background: #f8fafc;
    }
    .bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 10px 14px;
      border-bottom: 1px solid #dbe3ef;
      background: #fff;
      box-shadow: 0 1px 8px rgba(15, 23, 42, 0.08);
    }
    .title { min-width: 0; display: grid; gap: 2px; }
    h1 { margin: 0; font-size: 15px; line-height: 1.3; }
    p { margin: 0; color: #64748b; font-size: 12px; line-height: 1.4; }
    .actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    button, a {
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 12px;
      border-radius: 6px;
      border: 1px solid #cbd5e1;
      color: #334155;
      background: #fff;
      font-size: 13px;
      text-decoration: none;
      cursor: pointer;
    }
    button.primary { border-color: #2563eb; color: #fff; background: #2563eb; }
    button.danger { color: #fff; border-color: #dc2626; background: #dc2626; }
    button:disabled { opacity: 0.7; cursor: wait; }
    iframe { width: 100%; height: 100%; border: 0; background: #e5e7eb; }
    .result-mask {
      position: fixed;
      inset: 0;
      z-index: 10;
      display: none;
      place-items: center;
      padding: 24px;
      background: rgba(15, 23, 42, 0.42);
    }
    .result-mask.visible { display: grid; }
    .result-dialog {
      position: relative;
      width: min(420px, calc(100vw - 48px));
      padding: 26px;
      border-radius: 12px;
      background: #fff;
      box-shadow: 0 24px 70px rgba(15, 23, 42, 0.28);
    }
    .result-dialog h2 { margin: 0 0 10px; font-size: 18px; }
    .result-dialog p { font-size: 13px; line-height: 1.6; }
    .result-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 22px; }
    .result-close {
      position: absolute;
      top: 10px;
      right: 10px;
      width: 32px;
      padding: 0;
      border: 0;
      color: #64748b;
      background: transparent;
      font-size: 22px;
    }
  </style>
</head>
<body>
  <header class="bar">
    <div class="title">
      <h1>&#38754;&#21333;&#25171;&#21360;&#30830;&#35748;</h1>
      <p>&#30830;&#35748;&#38754;&#21333;&#20869;&#23481;&#21518;&#65292;&#28857;&#20987;&#8220;&#25171;&#21360;&#8221;&#35843;&#29992;&#27983;&#35272;&#22120;&#25171;&#21360;&#12290;</p>
    </div>
    <div class="actions">
      <button type="button" id="printNow" class="primary">&#25171;&#21360;</button>
      <a href="${url}" target="_blank" rel="noopener">&#25171;&#24320; PDF</a>
      <button type="button" id="closePage">&#20851;&#38381;</button>
    </div>
  </header>
  <iframe id="labelFrame" src="${url}" title="PDF"></iframe>
  <div id="printResultMask" class="result-mask">
    <section class="result-dialog" role="dialog" aria-modal="true" aria-labelledby="printResultTitle">
      <button type="button" id="closeResult" class="result-close" aria-label="Close">&times;</button>
      <h2 id="printResultTitle">&#25171;&#21360;&#32467;&#26524;&#30830;&#35748;</h2>
      <p>&#22914;&#26524;&#38754;&#21333;&#24050;&#27491;&#24120;&#25171;&#20986;&#65292;&#28857;&#20987;&#8220;&#23436;&#25104;&#8221;&#12290;&#22914;&#26524;&#25171;&#21360;&#22833;&#36133;&#65292;&#28857;&#20987;&#8220;&#22833;&#36133;&#8221;&#25764;&#38144;&#26412;&#25209;&#25171;&#21360;&#35760;&#24405;&#12290;</p>
      <div class="result-actions">
        <button type="button" id="printFailed" class="danger">&#22833;&#36133;</button>
        <button type="button" id="printCompleted" class="primary">&#23436;&#25104;</button>
      </div>
    </section>
  </div>
</body>
</html>`);
  printWindow.document.close();
}

function waitForPrintConfirmation(printWindow, { url, count, orderIds }) {
  writePrintPreviewPageSafe(printWindow, { url, count });
  return new Promise((resolve) => {
    let settled = false;
    let printBatchId = "";
    let printTriggered = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      window.clearInterval(closeTimer);
      resolve(result);
    };
    const closeTimer = window.setInterval(() => {
      if (printWindow.closed) finish({ printed: printTriggered, failed: false });
    }, 600);
    const printButton = printWindow.document.getElementById("printNow");
    const closePageButton = printWindow.document.getElementById("closePage");
    const resultMask = printWindow.document.getElementById("printResultMask");
    const completedButton = printWindow.document.getElementById("printCompleted");
    const failedButton = printWindow.document.getElementById("printFailed");
    const closeResultButton = printWindow.document.getElementById("closeResult");
    const acceptDefault = () => {
      resultMask?.classList.remove("visible");
      finish({ printed: printTriggered, failed: false });
    };
    closePageButton?.addEventListener("click", () => printWindow.close());
    completedButton?.addEventListener("click", acceptDefault);
    closeResultButton?.addEventListener("click", acceptDefault);
    resultMask?.addEventListener("click", (event) => {
      if (event.target === resultMask) acceptDefault();
    });
    failedButton?.addEventListener("click", async () => {
      if (!printBatchId) return;
      failedButton.disabled = true;
      try {
        await apiClient.post("/api/orders/package-label-print-failed", { print_batch_id: printBatchId });
        resultMask?.classList.remove("visible");
        finish({ printed: false, failed: true });
      } catch (error) {
        failedButton.disabled = false;
        printWindow.alert(`撤销打印记录失败：${error?.message || "未知错误"}`);
      }
    });
    printButton?.addEventListener("click", async () => {
      printButton.disabled = true;
      const frame = printWindow.document.getElementById("labelFrame");
      try {
        const record = await apiClient.post("/api/orders/package-label-printed", { order_ids: orderIds });
        printBatchId = String(record?.print_batch_id || "");
        printTriggered = true;
        frame?.contentWindow?.focus();
        frame?.contentWindow?.print();
        resultMask?.classList.add("visible");
      } catch (error) {
        printButton.disabled = false;
        printWindow.alert(`记录打印时间失败：${error?.message || "未知错误"}`);
      }
    });
  });
}

function failedLabelsFromHeader(headers) {
  const raw = headers?.get?.("X-Ozon-Label-Failures") || "";
  if (!raw) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function printedIdsFromHeader(headers) {
  const raw = headers?.get?.("X-Ozon-Label-Printed-Ids") || "";
  if (!raw) return [];
  try {
    const decoded = decodeURIComponent(raw);
    const parsed = JSON.parse(decoded);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function bulkPrintOrders(orderIds = [], options = {}) {
  const ids = Array.isArray(orderIds) ? orderIds.map(Number).filter(Boolean) : [];
  if (!ids.length) return null;
  return apiClient.post("/api/print/order-labels", {
    order_ids: ids,
    printer: options.printer || "label",
    print_settings: options.printSettings || options.print_settings || "fit",
    preset: options.preset || options.paperSize || options.paper_size || "",
    paper_size: options.paperSize || options.paper_size || options.preset || "",
    orientation: options.orientation || "auto",
    auto_paper: options.autoPaper === true || options.auto_paper === true,
    copies: options.copies || 1,
    require_all: true
  });
}

export async function previewOrderLabels(orderIds = [], options = {}) {
  const ids = Array.isArray(orderIds) ? orderIds.map(Number).filter(Boolean) : [];
  if (!ids.length) return null;
  const printIds = ids.length > 1 ? [...ids].reverse() : ids;
  const printWindow = window.open("", "_blank");
  if (!printWindow) throw new Error("浏览器阻止了预览窗口，请允许本站打开弹窗后重试");
  writePrintLoadingPage(printWindow, ids.length);
  let url = "";
  try {
    const response = await apiClient.blobResponse("/api/orders/package-label", {
      method: "POST",
      body: JSON.stringify({
        order_ids: printIds,
        require_all: true,
        browser_preview: true,
        printer: options.printer || "label",
        print_settings: options.printSettings || options.print_settings || "fit",
        preset: options.preset || options.paperSize || options.paper_size || "",
        paper_size: options.paperSize || options.paper_size || options.preset || "",
        orientation: options.orientation || "auto"
      })
    });
    const printedIds = printedIdsFromHeader(response.headers);
    url = URL.createObjectURL(response.blob);
    const printResult = await waitForPrintConfirmation(printWindow, {
      url,
      count: printedIds.length || ids.length,
      orderIds: printedIds.length ? printedIds : printIds
    });
    return { ok: true, ...printResult, printed_ids: printedIds.length ? printedIds : printIds, failures: failedLabelsFromHeader(response.headers) };
  } catch (error) {
    if (!printWindow.closed) writePrintErrorPage(printWindow, "面单预览失败", error?.message || "未知错误");
    throw error;
  } finally {
    if (url) window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export async function bulkPrepareOrders(orderIds = []) {
  const ids = Array.isArray(orderIds) ? orderIds.map(Number).filter(Boolean) : [];
  if (!ids.length) return null;
  return apiClient.post("/api/orders/ship", { order_ids: ids });
}

export async function handleMoreOrderAction(action) {
  throw new Error(`更多操作暂未接入：${action}`);
}

export async function openOrderProfit(orderId) {
  return fetchOrderDetail(orderId);
}

export async function fetchOrderDetail(orderId) {
  return apiClient.get(`/api/orders/${orderId}`);
}

export async function prepareSingleOrder(orderId) {
  return bulkPrepareOrders([orderId]);
}

export async function prepareSplitOrder(orderId, packages = []) {
  const id = Number(orderId || 0);
  if (!id) return null;
  return apiClient.post("/api/orders/ship", { order_ids: [id], packages });
}

export async function previewOrderProcurement(orderId) {
  return apiClient.get(`/api/orders/${orderId}/procurement-preview`);
}

export async function createOrderProcurementRequests(orderId, payload = {}) {
  return apiClient.post(`/api/orders/${orderId}/procurement-requests`, payload);
}

export async function printSingleOrder(orderId) {
  return bulkPrintOrders([orderId]);
}

export async function recalculateOrderProfit(orderId) {
  return apiClient.post(`/api/orders/${orderId}/recalculate-profit`, {});
}

export async function saveOrderMark(orderId, markType) {
  return apiClient.put(`/api/orders/${orderId}/mark`, { mark_type: markType });
}

export async function openBindProduct(onlineId) {
  return navigateTo("/online-products", { onlineProductId: onlineId, action: "bind" });
}

export async function openBindProductFromOrder(orderId, sku) {
  return navigateTo("/orders", { orderId, sku, action: "bind" });
}

export async function openCreateProduct(onlineId, orderId, sku) {
  return navigateTo("/selection", { onlineProductId: onlineId, orderId, sku, action: "create" });
}

export async function openCreateProductFromOrder(orderId, sku) {
  return navigateTo("/selection", { orderId, sku, action: "create" });
}

export async function jumpToStockProduct(productId) {
  return navigateTo("/inventory/products", { productId });
}

export async function openProcurement(productId) {
  return navigateTo("/procurement", { productId });
}
