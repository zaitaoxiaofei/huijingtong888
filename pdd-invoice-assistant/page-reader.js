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
        const skip = /待发货|待付款|待支付|退款|售后中|交易关闭|订单关闭|交易已取消|订单已取消|拼单失败|拼单未成功/.test(prompt);
        const time = Number(order.orderTime);
        const date = time > 0 ? new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date(time * 1000)) : "";
        rows.set(order.orderSn, {id: order.orderSn, url: url.href,
          shop: String(order.mall?.mallName || "").slice(0, 100),
          product: (Array.isArray(order.orderGoods) ? order.orderGoods : []).map(g => String(g.goodsName || "")).join("；").slice(0, 250),
          amount: Number.isFinite(order.displayAmount) ? (order.displayAmount / 100).toFixed(2) : "",
          thumbnail: String(order.orderGoods?.[0]?.thumbUrl || order.orderGoods?.[0]?.goodsThumbUrl || ""), date, status: skip ? "skipped" : "pending", note: skip ? `页面订单状态：${prompt}` : ""});
      } catch { /* Unsupported order shape stays absent, never guess a URL. */ }
      break;
    }
  }
  // The official invoice assistant renders an observed data object for each card.
  // Its invoice_amount is a decimal yuan string; do not confuse it with cents in orders.
  const seen = new Set();
  for (const el of document.querySelectorAll("div,span")) {
    if (el.children.length || !["发票详情", "申请发票", "待申请", "申请发票请联系拼多多官方客服"].includes(el.textContent?.trim())) continue;
    const key = Object.keys(el).find(k => k.startsWith("__reactInternalInstance") || k.startsWith("__reactFiber"));
    for (let fiber = key && el[key], depth = 0; fiber && depth < 12; fiber = fiber.return, depth++) {
      if (seen.has(fiber)) break;
      seen.add(fiber);
      const data = fiber.memoizedProps?.data;
      if (!data?.order_sn || !/^[\d-]{10,40}$/.test(data.order_sn)) continue;
      const value = String(data.invoice_amount ?? "");
      const match = value.match(/^(\d{1,10})(?:\.(\d{1,2}))?$/);
      const amount = match ? +match[1] * 100 + +(match[2] || "").padEnd(2, "0") : null;
      const status = data.invoice_status == null ? (data.is_full_refund || data.is_mall_close ? "skipped" : "pending") : +data.invoice_status === 2 ? "issued" : +data.invoice_status === 1 ? "submitted" : +data.invoice_status === 0 ? "rejected" : "pending";
      const facts = {platformCheckedAt: Date.now()};
      if (amount !== null) { facts.applicationAmountCents = amount; if (status === "issued") facts.invoiceAmountCents = amount; }
      if (data.reject_reason) facts.rejectionReason = String(data.reject_reason);
      rows.set(data.order_sn, {id: data.order_sn, url: `https://mobile.pinduoduo.com/order.html?order_sn=${encodeURIComponent(data.order_sn)}`,
        mallId: String(data.mall_id || ""), thumbnail: String(data.thumb_url || ""),
        applicationUrl: data.invoice_status == null && data.mall_id ? `https://mobile.pinduoduo.com/transac_return_compensation.html?_t_timestamp=transac_modify_invoice&order_sn=${encodeURIComponent(data.order_sn)}&mall_id=${encodeURIComponent(data.mall_id)}&from_invoice=1&source=9` : "",
        product: String(data.goods_name || "").slice(0, 250), shop: "", amount: "", date: Number(data.order_time) > 0 ? new Intl.DateTimeFormat("sv-SE", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date(Number(data.order_time) * 1000)) : "", status,
        note: status === "pending" ? "官方待申请订单，可向商家发送申请" : status === "skipped" ? "订单已退款或商家关闭，请核对" : status === "rejected" ? String(data.reject_reason || "平台显示开票失败") : "已读取官方发票列表", invoiceFacts: facts});
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

// Read-only buyer order pagination, observed on the official purchase page.
// Keep login credentials in the browser; return only invoice-ledger fields.
export function readPurchasePage(offset = "") {
  return (async () => {
    if (location.origin !== "https://mobile.pinduoduo.com" || location.pathname !== "/orders.html") throw new Error("请在官方采购订单页同步历史记录");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch("/proxy/api/api/aristotle/order_list_v4", {method: "POST", credentials: "same-origin", signal: controller.signal,
        headers: {"content-type": "application/json"}, body: JSON.stringify({type: "all", page: 1, origin_host_name: location.hostname,
          scene: "order_list_h5", page_from: 0, pay_front_supports: [], size: 50, offset})});
      const data = await response.json();
      if (!response.ok || data.error_code) throw new Error(data.error_msg || `采购订单读取失败（HTTP ${response.status}），请检查登录状态后重试`);
      if (!Array.isArray(data.orders)) throw new Error("平台未返回采购订单列表，已停止；不会当作历史已读完");
      const rows = [];
      for (const order of data.orders) {
        const id = String(order.order_sn || "");
        if (!/^[\d-]{10,40}$/.test(id)) continue;
        const goods = Array.isArray(order.order_goods) ? order.order_goods : [];
        const prompt = String(order.order_status_prompt || "");
        const skip = /待发货|待付款|待支付|退款|售后中|交易关闭|订单关闭|交易已取消|订单已取消|拼单失败|拼单未成功/.test(prompt);
        const time = Number(order.order_time);
        rows.push({id, url: `https://mobile.pinduoduo.com/order.html?order_sn=${encodeURIComponent(id)}`,
          product: goods.map(g => String(g.goods_name || "")).join("；").slice(0, 250),
          thumbnail: String(goods[0]?.thumb_url || ""), shop: String(order.mall?.mall_name || "").slice(0,100),
          amount: Number.isSafeInteger(order.display_amount) ? (order.display_amount / 100).toFixed(2) : "",
          date: time > 0 ? new Intl.DateTimeFormat("sv-SE", {timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(time*1000)) : "",
          status: skip ? "skipped" : "pending", note: skip ? `页面订单状态：${prompt}` : "已读取采购订单，申请前会核对实际开票状态"});
      }
      const nextOffset = String(data.orders.at(-1)?.offset || "");
      if (data.orders.length && (!nextOffset || nextOffset === offset || !rows.length)) throw new Error("平台分页游标未推进，已保留记录；请重试，尚不能确认全部历史已读完");
      return {rows, nextOffset, complete: data.orders.length === 0};
    } finally { clearTimeout(timer); }
  })();
}
