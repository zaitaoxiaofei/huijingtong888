(() => {
  const RESPONSE_TYPE = 'BAODAN_ANALYTICS_PLUGIN_INSTANCE';
  const REQUEST_TYPE = 'BAODAN_ANALYTICS_PLUGIN_INSTANCE_REQUEST';
  const WAKE_TYPE = 'BAODAN_ANALYTICS_PLUGIN_WAKE';

  function isTrustedErpPage() {
    const hostname = String(window.location.hostname || '').toLowerCase();
    if (window.location.protocol === 'https:' && hostname === 'erp.hjt888.xyz') return true;
    if (window.location.protocol !== 'http:') return false;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
      /^10\./.test(hostname) || /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
  }

  async function pairCurrentErpOrigin() {
    if (!isTrustedErpPage()) return;
    await chrome.runtime.sendMessage({
      type: 'PIVOT_ERP_PAIR_ORIGIN',
      erpBaseUrl: window.location.origin
    }).catch(() => null);
  }

  async function announce() {
    await pairCurrentErpOrigin();
    window.postMessage({
      type: RESPONSE_TYPE,
      pluginInstanceId: chrome.runtime.id,
      pluginVersion: chrome.runtime.getManifest()?.version || ''
    }, window.location.origin);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.type === REQUEST_TYPE) void announce();
    if (event.data?.type === WAKE_TYPE) {
      void chrome.runtime.sendMessage({ type: 'PIVOT_ERP_COLLECT_WAKE' }).catch(() => null);
    }
  });

  void announce();
})();
