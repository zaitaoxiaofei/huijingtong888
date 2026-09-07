(function initOzonErpFbpBridge() {
  if (window.__ozonErpFbpBridgeLoaded) return;
  window.__ozonErpFbpBridgeLoaded = true;

  const REQUEST_TYPE = 'OZON_ERP_FBP_FILL_REQUEST';
  const ACCEPTED_TYPE = 'OZON_ERP_FBP_BRIDGE_ACCEPTED';
  const RESPONSE_TYPE = 'OZON_ERP_FBP_FILL_RESPONSE';

  function postResponse(requestId, response) {
    window.postMessage({
      type: RESPONSE_TYPE,
      requestId,
      response
    }, window.location.origin);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== REQUEST_TYPE) return;
    const requestId = String(event.data.requestId || '').trim();
    if (!requestId) return;
    const runtime = globalThis.chrome?.runtime;
    if (!runtime || typeof runtime.sendMessage !== 'function') {
      postResponse(requestId, {
        success: false,
        error: 'PLUGIN_CONTEXT_INVALIDATED',
        message: '插件刚刚更新或重载，当前 ERP 页面仍是旧连接。请刷新当前 ERP 页面后重试。'
      });
      return;
    }

    // Acknowledge before the potentially long-running Ozon fill task starts.
    window.postMessage({ type: ACCEPTED_TYPE, requestId }, window.location.origin);
    try {
      runtime.sendMessage({
        type: REQUEST_TYPE,
        requestId,
        payload: event.data.payload || {}
      }, (response) => {
        const error = runtime.lastError?.message || '';
        postResponse(requestId, error
          ? { success: false, error: 'PLUGIN_RUNTIME_ERROR', message: error }
          : (response || { success: false, message: '插件后台没有返回执行结果，请刷新 ERP 页面后重试。' }));
      });
    } catch (error) {
      postResponse(requestId, {
        success: false,
        error: 'PLUGIN_CONTEXT_INVALIDATED',
        message: error?.message || '插件连接已失效，请刷新当前 ERP 页面后重试。'
      });
    }
  });
})();
