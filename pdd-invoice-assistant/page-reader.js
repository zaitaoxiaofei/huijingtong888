// Runs in the page's MAIN world. Read only the observed, rendered order props;
// do not call platform APIs, store methods, event handlers, or enumerate credentials.
export function readRenderedOrders() {
  const rows = new Map();
  for (const el of document.querySelectorAll('[data-test="商品名称"]')) {
    const key = Object.keys(el).find(k => k.startsWith("__reactInternalInstance") || k.startsWith("__reactFiber"));
    for (let fiber = key && el[key], depth = 0; fiber && depth < 18; fiber = fiber.return, depth++) {
      const order = fiber.memoizedProps?.list;
      if (!order || typeof order.orderSn !== "string" || !/^[\d-]{10,40}$/.test(order.orderSn)) continue;
      try {
        const url = new URL(order.orderLinkUrl, location.origin);
        if (url.origin !== "https://mobile.pinduoduo.com" || url.searchParams.get("order_sn") !== order.orderSn) break;
        const prompt = String(order.orderStatusPrompt || "");
        const skip = /待发货|待付款|待支付|退款|售后中|交易关闭|订单关闭/.test(prompt);
        const time = Number(order.orderTime);
        const date = time > 0 ? new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date(time * 1000)) : "";
        rows.set(order.orderSn, {id: order.orderSn, url: url.href,
          shop: String(order.mall?.mallName || "").slice(0, 100),
          product: (Array.isArray(order.orderGoods) ? order.orderGoods : []).map(g => String(g.goodsName || "")).join("；").slice(0, 250),
          amount: Number.isFinite(order.displayAmount) ? (order.displayAmount / 100).toFixed(2) : "",
          date, status: skip ? "skipped" : "pending", note: skip ? `页面订单状态：${prompt}` : ""});
      } catch { /* Unsupported order shape stays absent, never guess a URL. */ }
      break;
    }
  }
  // The official invoice assistant renders an observed data object for each card.
  // Its invoice_amount is a decimal yuan string; do not confuse it with cents in orders.
  const seen = new Set();
  for (const el of document.querySelectorAll("div,span")) {
    if (el.children.length || !["发票详情", "申请发票"].includes(el.textContent?.trim())) continue;
    const key = Object.keys(el).find(k => k.startsWith("__reactInternalInstance") || k.startsWith("__reactFiber"));
    for (let fiber = key && el[key], depth = 0; fiber && depth < 12; fiber = fiber.return, depth++) {
      if (seen.has(fiber)) break;
      seen.add(fiber);
      const data = fiber.memoizedProps?.data;
      if (!data?.order_sn || !/^[\d-]{10,40}$/.test(data.order_sn)) continue;
      const value = String(data.invoice_amount ?? "");
      const match = value.match(/^(\d{1,10})(?:\.(\d{1,2}))?$/);
      const amount = match ? +match[1] * 100 + +(match[2] || "").padEnd(2, "0") : null;
      const status = +data.invoice_status === 2 ? "issued" : +data.invoice_status === 1 ? "submitted" : +data.invoice_status === 0 ? "rejected" : "pending";
      const facts = {platformCheckedAt: Date.now()};
      if (amount !== null) { facts.applicationAmountCents = amount; if (status === "issued") facts.invoiceAmountCents = amount; }
      if (data.reject_reason) facts.rejectionReason = String(data.reject_reason);
      rows.set(data.order_sn, {id: data.order_sn, url: `https://mobile.pinduoduo.com/order.html?order_sn=${encodeURIComponent(data.order_sn)}`,
        product: String(data.goods_name || "").slice(0, 250), shop: "", amount: "", date: "", status,
        note: status === "rejected" ? String(data.reject_reason || "平台显示开票失败") : "已读取官方发票列表", invoiceFacts: facts});
      break;
    }
  }
  return [...rows.values()];
}

// The two official invoice pages expose the same observed order fields either
// on store.invoice (detail) or directly on store (application form).
export function readInvoicePage() {
  function pick(store, invoice) {
    return {ready: store.isFinishInitLoading === true, orderId: String(invoice.orderSn), mallId: String(invoice.mallId || ""),
      hasApplied: invoice.hasApplied, displayText: String(invoice.displayStatusText || ""),
      rejected: Boolean(invoice.rejectReApplyControl) || Boolean(invoice.deniedReason), rejectionReason: String(invoice.deniedReason || ""),
      applicationTime: String(invoice.applicationTimeStr || ""), invoiceTime: String(invoice.invoiceTimeStr || ""),
      invoiceAmount: typeof invoice.invoiceAmount === "string" ? invoice.invoiceAmount : "",
      invoiceKind: invoice.invoiceKind, businessType: invoice.businessType,
      company: String(invoice.payerName || ""), taxId: String(invoice.payerRegisterNo || "")};
  }
  const seen = new Set();
  for (const el of [...document.querySelectorAll("textarea,input,div,p")].slice(0, 1500)) {
    const key = Object.keys(el).find(k => k.startsWith("__reactInternalInstance") || k.startsWith("__reactFiber"));
    for (let fiber = key && el[key], depth = 0; fiber && depth < 22; fiber = fiber.return, depth++) {
      if (seen.has(fiber)) break;
      seen.add(fiber);
      const store = fiber.memoizedProps?.store;
      const invoice = store?.invoice || store;
      if (!invoice?.orderSn || typeof invoice.hasApplied !== "boolean") continue;
      return pick(store, invoice);
    }
  }
  const raw = window.rawData?.stores?.store;
  if (raw?.invoice?.orderSn && typeof raw.invoice.hasApplied === "boolean") return pick(raw, raw.invoice);
  return {ready: false};
}
