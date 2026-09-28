async function syncCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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

chrome.action.onClicked.addListener(async () => {
  try {
    await syncCurrentTab();
    await chrome.action.setBadgeText({ text: "✓" });
    await chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
  } catch (error) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    console.error("[pdd-procurement-logistics]", error);
  }
});
