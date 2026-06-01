(function initPivotErpRelayBridge() {
  'use strict';

  if (window.__PIVOT_ERP_RELAY_BRIDGE_INSTALLED__) return;
  window.__PIVOT_ERP_RELAY_BRIDGE_INSTALLED__ = true;
  const pending = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.type !== 'PIVOT_ERP_ANALYTICS_EXECUTE_RESULT') return;
    const entry = pending.get(data.requestId);
    if (!entry) return;
    pending.delete(data.requestId);
    entry.sendResponse({ success: true, payload: data.payload });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'PIVOT_ERP_ANALYTICS_EXECUTE_REQUEST') return false;
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timeoutId = setTimeout(() => {
      const entry = pending.get(requestId);
      if (!entry) return;
      pending.delete(requestId);
      entry.sendResponse({ success: false, error: '采集请求执行超时' });
    }, 60000);
    pending.set(requestId, {
      sendResponse(payload) {
        clearTimeout(timeoutId);
        sendResponse(payload);
      }
    });
    window.postMessage({
      type: 'PIVOT_ERP_ANALYTICS_EXECUTE_REQUEST',
      requestId,
      request: message.request
    }, '*');
    return true;
  });
})();
