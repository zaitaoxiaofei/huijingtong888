(() => {
  const text = () => document.body?.innerText?.replace(/\s+/g, " ").trim() || "";
  const pick = (value, patterns) => patterns.map((pattern) => value.match(pattern)?.[1]?.trim()).find(Boolean) || "";

  function readLogistics() {
    const params = new URLSearchParams(location.search);
    const pageText = text();
    const trackingNumber = params.get("tracking_number") || pick(pageText, [/运单号[：:\s]*([A-Za-z0-9-]{6,})/]);
    const orderNo = params.get("order_sn") || pick(pageText, [/订单号[：:\s]*([A-Za-z0-9-]{6,})/]);
    const statusText = pick(pageText, [/(已签收|待取件|派送中|运输中|已揽收|物流异常|配送异常)/]);
    const lines = pageText.split(/(?<=。)|(?<=\d{2}:\d{2})/).map((item) => item.trim()).filter(Boolean);
    return {
      platform_order_no: orderNo,
      tracking_number: trackingNumber,
      carrier_code: String(params.get("shipping_id") || ""),
      logistics_status_text: statusText || "已读取拼多多物流页面",
      latest_trace: lines.find((line) => /签收|取件|派送|运输|揽收|到达|异常/.test(line)) || pageText.slice(0, 500),
      source: "pdd_mobile"
    };
  }

  async function collectVisibleLogisticsLinks() {
    const links = new Map();
    let unchanged = 0;
    for (let pass = 0; pass < 20 && unchanged < 3; pass += 1) {
      for (const anchor of document.querySelectorAll('a[href*="goods_express.html"]')) {
        const url = new URL(anchor.href, location.href).toString();
        const orderNo = new URL(url).searchParams.get("order_sn");
        if (orderNo) links.set(orderNo, url);
      }
      const before = links.size;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((resolve) => setTimeout(resolve, 900));
      unchanged = links.size === before ? unchanged + 1 : 0;
    }
    return [...links.entries()].map(([order_sn, url]) => ({ order_sn, url }));
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "PDD_PROCUREMENT_COLLECT_ORDER_LINKS") {
      collectVisibleLogisticsLinks().then((links) => sendResponse({ ok: true, links }), (error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type !== "PDD_PROCUREMENT_READ_LOGISTICS") return;
    const payload = readLogistics();
    if (!payload.platform_order_no || !payload.tracking_number) {
      sendResponse({ ok: false, error: "未在当前拼多多物流页读取到订单号或快递单号" });
      return;
    }
    sendResponse({ ok: true, payload });
  });
})();
