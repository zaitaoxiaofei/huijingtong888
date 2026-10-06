async function syncDetailTab(tab) {
  if (!tab?.id || !/^https:\/\/mobile\.pinduoduo\.com\/goods_express\.html/.test(tab.url || "")) {
    throw new Error("请先打开拼多多采购订单的物流详情页");
  }
  const response = await chrome.tabs.sendMessage(tab.id, { type: "PDD_PROCUREMENT_READ_LOGISTICS" });
  if (!response?.ok) throw new Error(response?.error || "读取拼多多物流页面失败");
  const erpTabs = await chrome.tabs.query({ url: ["https://erp.hjt888.xyz/*", "http://localhost:8788/*"] });
  const erpTab = erpTabs.find((candidate) => candidate.id);
  if (!erpTab?.id) throw new Error("请先在另一个标签页登录并打开爆单ERP");
  const result = await chrome.tabs.sendMessage(erpTab.id, { type: "PDD_PROCUREMENT_SYNC_TO_ERP", payload: response.payload });
  if (!result?.ok) throw new Error(result?.error || "ERP 同步失败");
  return result.body;
}

async function syncCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return await syncDetailTab(tab);
}

async function readLogisticsDetail(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("拼多多物流详情加载超时")), 15000);
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === "complete") { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    const response = await chrome.tabs.sendMessage(tab.id, { type: "PDD_PROCUREMENT_READ_LOGISTICS" });
    if (!response?.ok) throw new Error(response?.error || "读取物流详情失败");
    return response.payload;
  } finally {
    if (tab.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function syncOrderList(tabId) {
  const linksResult = await chrome.tabs.sendMessage(tabId, { type: "PDD_PROCUREMENT_COLLECT_ORDER_LINKS" });
  if (!linksResult?.ok) throw new Error(linksResult?.error || "未读取到拼多多订单物流链接");
  const rows = [];
  for (const item of linksResult.links.slice(0, 100)) {
    try { rows.push(await readLogisticsDetail(item.url)); } catch (error) { console.warn("[pdd-procurement-logistics] skipped", item.order_sn, error); }
  }
  if (!rows.length) throw new Error("订单列表中没有可同步的物流详情");
  const erpTabs = await chrome.tabs.query({ url: ["https://erp.hjt888.xyz/*", "http://localhost:8788/*"] });
  const erpTab = erpTabs.find((candidate) => candidate.id);
  if (!erpTab?.id) throw new Error("请先在另一个标签页登录并打开爆单ERP");
  const result = await chrome.tabs.sendMessage(erpTab.id, { type: "PDD_PROCUREMENT_SYNC_BATCH_TO_ERP", payload: { orders: rows } });
  if (!result?.ok) throw new Error(result?.error || "ERP 批量同步失败");
  return result.body;
}

chrome.action.onClicked.addListener(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (/goods_express\.html/.test(tab?.url || "")) await syncDetailTab(tab);
    else await syncOrderList(tab?.id);
    await chrome.action.setBadgeText({ text: "✓" });
    await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
  } catch (error) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    console.error("[pdd-procurement-logistics]", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "PDD_PROCUREMENT_START_SYNC" || !sender.tab?.id) return;
  const tab = sender.tab;
  const task = /goods_express\.html/.test(tab.url || "") ? syncDetailTab(tab) : syncOrderList(tab.id);
  task.then(
    async (body) => {
      await chrome.action.setBadgeText({ text: "✓", tabId: tab.id });
      await chrome.action.setBadgeBackgroundColor({ color: "#16a34a", tabId: tab.id });
      sendResponse({ ok: true, body });
    },
    async (error) => {
      await chrome.action.setBadgeText({ text: "!", tabId: tab.id });
      await chrome.action.setBadgeBackgroundColor({ color: "#dc2626", tabId: tab.id });
      sendResponse({ ok: false, error: error.message || "同步失败" });
    }
  );
  return true;
});
