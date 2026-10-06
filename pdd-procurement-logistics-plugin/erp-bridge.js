chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const batch = message?.type === "PDD_PROCUREMENT_SYNC_BATCH_TO_ERP";
  if (!batch && message?.type !== "PDD_PROCUREMENT_SYNC_TO_ERP") return;
  fetch(batch ? "/api/procurement/pdd-logistics/sync-batch" : "/api/procurement/pdd-logistics/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(message.payload || {})
  })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || body.error || "ERP 未能保存物流信息");
      sendResponse({ ok: true, body });
    })
    .catch((error) => sendResponse({ ok: false, error: error.message || "ERP 同步失败" }));
  return true;
});
