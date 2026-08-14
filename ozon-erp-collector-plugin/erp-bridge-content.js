(function initOzonErpFbpBridge() {
  if (window.__ozonErpFbpBridgeLoaded) return;
  window.__ozonErpFbpBridgeLoaded = true;

  const REQUEST_TYPE = 'OZON_ERP_FBP_FILL_REQUEST';
  const RESPONSE_TYPE = 'OZON_ERP_FBP_FILL_RESPONSE';

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== REQUEST_TYPE) return;
    const requestId = String(event.data.requestId || '').trim();
    if (!requestId) return;
    chrome.runtime.sendMessage({
      type: REQUEST_TYPE,
      requestId,
      payload: event.data.payload || {}
    }, (response) => {
      const error = chrome.runtime.lastError?.message || '';
      window.postMessage({
        type: RESPONSE_TYPE,
        requestId,
        response: error ? { success: false, error } : response
      }, window.location.origin);
    });
  });
})();
