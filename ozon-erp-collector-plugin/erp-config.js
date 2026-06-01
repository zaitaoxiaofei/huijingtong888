(function initOzonErpCollectorConfig(globalScope) {
  const DEFAULT_ERP_BASE_URL = 'https://erp.hjt888.xyz';
  const ERP_BASE_URL_STORAGE_KEY = 'ozon-erp-base-url';
  const ERP_TENANT_ID_STORAGE_KEY = 'ozon-erp-tenant-id';
  const LOCAL_PLUGIN_TOKEN_STORAGE_KEY = 'ozon-erp-local-plugin-token';
  const DEFAULT_LOCAL_PLUGIN_TOKEN = 'ozon-erp-collector-hjt888-default';

  function trimTrailingSlashes(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }

  function ensureAbsoluteUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    return `https://${raw.replace(/^\/+/, '')}`;
  }

  function isLocalErpHost(parsed) {
    const hostname = String(parsed?.hostname || '').toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1' || hostname === '[::1]';
  }

  function normalizeErpBaseUrl(value) {
    const raw = ensureAbsoluteUrl(value);
    if (!raw) return DEFAULT_ERP_BASE_URL;

    let parsed = null;
    try {
      parsed = new URL(raw);
    } catch (error) {
      return DEFAULT_ERP_BASE_URL;
    }
    let pathname = trimTrailingSlashes(parsed.pathname || '');
    if (pathname.endsWith('/api')) {
      pathname = pathname.slice(0, -4);
    }
    parsed.pathname = pathname || '/';
    parsed.search = '';
    parsed.hash = '';
    return trimTrailingSlashes(parsed.toString()) || DEFAULT_ERP_BASE_URL;
  }

  function resolveLocalPluginApiBaseUrl(value) {
    return `${normalizeErpBaseUrl(value)}/api/local-plugin`;
  }

  function resolveProductEditUrl(value, collectionId) {
    const baseUrl = normalizeErpBaseUrl(value);
    const query = collectionId ? `?collectionId=${encodeURIComponent(collectionId)}` : '';
    return `${baseUrl}/#/product-edit${query}`;
  }

  function resolveCollectorBoxUrl(value, sku) {
    const baseUrl = normalizeErpBaseUrl(value);
    const query = sku ? `?sku=${encodeURIComponent(sku)}` : '';
    return `${baseUrl}/#/collector-box${query}`;
  }

  function isAllowedLocalPluginUrl(url, erpBaseUrl) {
    try {
      const target = new URL(String(url || ''));
      const base = new URL(normalizeErpBaseUrl(erpBaseUrl));
      const targetPath = String(target.pathname || '');
      const allowedPrefix = `${trimTrailingSlashes(base.pathname || '') || ''}/api/local-plugin/`;
      return (
        target.protocol === base.protocol &&
        target.hostname === base.hostname &&
        String(target.port || '') === String(base.port || '') &&
        targetPath.startsWith(allowedPrefix)
      );
    } catch (error) {
      return false;
    }
  }

  function isAllowedErpApiUrl(url, erpBaseUrl) {
    try {
      const target = new URL(String(url || ''));
      const base = new URL(normalizeErpBaseUrl(erpBaseUrl));
      const targetPath = String(target.pathname || '');
      const allowedPrefix = `${trimTrailingSlashes(base.pathname || '') || ''}/api/`;
      return (
        target.protocol === base.protocol &&
        target.hostname === base.hostname &&
        String(target.port || '') === String(base.port || '') &&
        targetPath.startsWith(allowedPrefix) &&
        !targetPath.includes('/api/local-plugin/')
      );
    } catch (error) {
      return false;
    }
  }

  globalScope.OzonErpCollectorConfig = {
    DEFAULT_ERP_BASE_URL,
    DEFAULT_LOCAL_PLUGIN_TOKEN,
    ERP_BASE_URL_STORAGE_KEY,
    ERP_TENANT_ID_STORAGE_KEY,
    LOCAL_PLUGIN_TOKEN_STORAGE_KEY,
    normalizeErpBaseUrl,
    resolveLocalPluginApiBaseUrl,
    resolveProductEditUrl,
    resolveCollectorBoxUrl,
    isAllowedLocalPluginUrl,
    isAllowedErpApiUrl
  };
})(typeof window !== 'undefined' ? window : globalThis);
