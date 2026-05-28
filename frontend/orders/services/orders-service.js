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
    button.danger { color: #991b1b; border-color: #fecaca; background: #fff; }
    button:disabled { opacity: 0.7; cursor: wait; }
    iframe { width: 100%; height: 100%; border: 0; background: #e5e7eb; }
  </style>
</head>
<body>
  <header class="bar">
    <div class="title">
      <h1>&#38754;&#21333;&#25171;&#21360;&#30830;&#35748;</h1>
      <p>&#35831;&#20808;&#23436;&#25104; PDF &#25171;&#21360;&#12290;&#30830;&#35748;&#38754;&#21333;&#24050;&#32463;&#23454;&#38469;&#25171;&#21360;&#21518;&#65292;&#20877;&#28857;&#20987;&#8220;&#30830;&#35748;&#24050;&#25171;&#21360;&#8221;&#12290;</p>
    </div>
    <div class="actions">
      <button type="button" id="printNow">&#25171;&#21360;</button>
      <a href="${url}" target="_blank" rel="noopener">&#25171;&#24320; PDF</a>
      <button type="button" id="cancelPrint" class="danger">&#21462;&#28040;</button>
      <button type="button" id="confirmPrinted" class="primary">&#30830;&#35748;&#24050;&#25171;&#21360;</button>
    </div>
  </header>
  <iframe id="labelFrame" src="${url}" title="PDF"></iframe>
  <script>
    document.getElementById("confirmPrinted").addEventListener("click", function () {
      document.body.dataset.printDecision = "confirmed";
      this.disabled = true;
      this.textContent = "\\u6b63\\u5728\\u786e\\u8ba4...";
    });
    document.getElementById("cancelPrint").addEventListener("click", function () {
      document.body.dataset.printDecision = "cancelled";
      this.disabled = true;
    });
    document.getElementById("printNow").addEventListener("click", function () {
      var frame = document.getElementById("labelFrame");
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch (error) {
        window.open("${url}", "_blank", "noopener");
      }
    });
  <\/script>
</body>
</html>`);
  printWindow.document.close();
}

function waitForPrintConfirmation(printWindow, { url, count }) {
  writePrintPreviewPageSafe(printWindow, { url, count });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      window.clearInterval(closeTimer);
      resolve(Boolean(confirmed));
    };
    const closeTimer = window.setInterval(() => {
      if (printWindow.closed) finish(false);
      const decision = printWindow.document?.body?.dataset?.printDecision;
      if (decision === "confirmed") finish(true);
      if (decision === "cancelled") finish(false);
    }, 600);
    const confirmButton = printWindow.document.getElementById("confirmPrinted");
    const cancelButton = printWindow.document.getElementById("cancelPrint");
    const printButton = printWindow.document.getElementById("printNow");
    confirmButton?.addEventListener("click", () => finish(true));
    cancelButton?.addEventListener("click", () => finish(false));
    printButton?.addEventListener("click", () => {
      const frame = printWindow.document.getElementById("labelFrame");
      try {
        frame?.contentWindow?.focus();
        frame?.contentWindow?.print();
      } catch {
        printWindow.open(url, "_blank", "noopener");
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

export async function bulkPrintOrders(orderIds = []) {
  const ids = Array.isArray(orderIds) ? orderIds.map(Number).filter(Boolean) : [];
  if (!ids.length) return null;
  const printWindow = window.open("about:blank", "_blank");
  if (!printWindow) {
    throw new Error("浏览器拦截了打印窗口，请允许弹窗后重试");
  }
  printWindow.opener = null;
  writePrintLoadingPage(printWindow, ids.length);
  try {
    const response = await apiClient.blobResponse("/api/orders/package-label", {
      method: "POST",
      body: JSON.stringify({ order_ids: ids, require_all: true })
    });
    const blob = response.blob;
    const url = URL.createObjectURL(blob);
    const failures = failedLabelsFromHeader(response.headers);
    const pdfOrderIds = printedIdsFromHeader(response.headers);
    const failedIds = new Set(failures.map((item) => Number(item.id)).filter(Boolean));
    const printedIds = pdfOrderIds.length
      ? pdfOrderIds.filter((id) => !failedIds.has(Number(id)))
      : ids.filter((id) => !failedIds.has(Number(id)));
    const confirmed = await waitForPrintConfirmation(printWindow, { url, count: printedIds.length || ids.length });
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    if (!confirmed) {
      return { ok: false, count: 0, requested: ids.length, failures, cancelled: true };
    }
    if (printedIds.length) {
      await apiClient.post("/api/orders/package-label-printed", { order_ids: printedIds });
    }
    try {
      const confirmButton = printWindow.document?.getElementById?.("confirmPrinted");
      if (confirmButton) confirmButton.textContent = "已确认";
      const hint = printWindow.document?.querySelector?.(".title p");
      if (hint) hint.textContent = "已记录为已打印，可以关闭此窗口。";
    } catch {
      // The print window may already be closed.
    }
    return { ok: true, count: printedIds.length, requested: ids.length, failures };
  } catch (error) {
    printWindow.close();
    throw error;
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
