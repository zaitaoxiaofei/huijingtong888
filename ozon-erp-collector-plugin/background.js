if (typeof importScripts === 'function') {
  try {
    importScripts('erp-config.js');
  } catch (error) {}
}

const erpConfig = globalThis.OzonErpCollectorConfig || {};
const ERP_BASE_URL_STORAGE_KEY = erpConfig.ERP_BASE_URL_STORAGE_KEY || 'ozon-erp-base-url';
const ERP_TENANT_ID_STORAGE_KEY = erpConfig.ERP_TENANT_ID_STORAGE_KEY || 'ozon-erp-tenant-id';
const LOCAL_PLUGIN_TOKEN_STORAGE_KEY = erpConfig.LOCAL_PLUGIN_TOKEN_STORAGE_KEY || 'ozon-erp-local-plugin-token';
const DEFAULT_LOCAL_PLUGIN_TOKEN = erpConfig.DEFAULT_LOCAL_PLUGIN_TOKEN || 'ozon-erp-collector-hjt888-default';
const ERP_TENANT_BASE_URL_STORAGE_KEY = 'ozon-erp-tenant-base-url';
const DEFAULT_ERP_BASE_URL = erpConfig.DEFAULT_ERP_BASE_URL || 'https://erp.hjt888.xyz';
const OZON_PRODUCT_BASE_URL = 'https://www.ozon.ru/product';
const SELLER_BRIDGE_URL = 'https://seller.ozon.ru/app/products';
const MANUAL_PROGRESS_STORAGE_KEY = 'ozon-erp-manual-progress';
const PLUGIN_UPDATE_STATUS_STORAGE_KEY = 'ozon-erp-plugin-update-status';
const PLUGIN_UPDATE_ALARM_NAME = 'ozon-erp-plugin-update-check';
const SERVER_PUBLISH_MEDIA_SIDECAR_ALARM_NAME = 'ozon-erp-server-publish-media-sidecar';
const SERVER_PUBLISH_MEDIA_SIDECAR_INTERVAL_MINUTES = 0.5;
const SERVER_PUBLISH_MEDIA_SIDECAR_INITIAL_DELAY_MINUTES = 0.05;
const SERVER_PUBLISH_MEDIA_SIDECAR_LIMIT = 20;
const SERVER_PUBLISH_MEDIA_SIDECAR_CONCURRENCY = 8;
const SERVER_PUBLISH_MEDIA_SIDECAR_LEASE_MS = 10 * 60 * 1000;
const PLUGIN_VERSION = chrome.runtime.getManifest?.().version || '0.0.0';
const OZON_FRONT_SCRIPT_FILES = [
  'erp-config.js',
  'collector.js',
  'content-core.js',
  'field-registry.js',
  'data-aggregator.js',
  'content.js'
];
const OZON_FRONT_STYLE_FILES = ['content.css'];
const OZON_INJECTION_DEBOUNCE_MS = 1200;
const OZON_INJECTION_BLOCKED_TTL_MS = 5 * 60 * 1000;
const ozonInjectionAttemptAtByTabId = new Map();
const ozonInjectionBlockedByTabId = new Map();
let serverPublishMediaSidecarPromise = null;
let sellerAuthSyncPromise = null;

function normalizeErpBaseUrl(value) {
  if (typeof erpConfig.normalizeErpBaseUrl === 'function') {
    return erpConfig.normalizeErpBaseUrl(value);
  }
  return DEFAULT_ERP_BASE_URL;
}

function normalizeDirectSyncContext(syncContext) {
  if (!syncContext || typeof syncContext !== 'object') return null;
  const tenantId = String(syncContext.tenantId || '').trim();
  const erpBaseUrl = normalizeErpBaseUrl(syncContext.erpBaseUrl || syncContext.apiBaseUrl || '');
  if (!erpBaseUrl) return null;
  return { tenantId, erpBaseUrl };
}

async function getErpBaseUrl() {
  const stored = await chrome.storage.local.get([ERP_BASE_URL_STORAGE_KEY]);
  return normalizeErpBaseUrl(stored?.[ERP_BASE_URL_STORAGE_KEY] || DEFAULT_ERP_BASE_URL);
}

async function getLocalPluginToken() {
  const stored = await chrome.storage.local.get([LOCAL_PLUGIN_TOKEN_STORAGE_KEY]);
  return String(stored?.[LOCAL_PLUGIN_TOKEN_STORAGE_KEY] || DEFAULT_LOCAL_PLUGIN_TOKEN).trim();
}

function resolveProductEditUrl(baseUrl, collectionId) {
  if (typeof erpConfig.resolveProductEditUrl === 'function') {
    return erpConfig.resolveProductEditUrl(baseUrl, collectionId);
  }
  const query = collectionId ? `?collectionId=${encodeURIComponent(collectionId)}` : '';
  return `${normalizeErpBaseUrl(baseUrl)}/#/product-edit${query}`;
}

function resolveCollectorBoxUrl(baseUrl, sku) {
  if (typeof erpConfig.resolveCollectorBoxUrl === 'function') {
    return erpConfig.resolveCollectorBoxUrl(baseUrl, sku);
  }
  const query = sku ? `?sku=${encodeURIComponent(sku)}` : '';
  return `${normalizeErpBaseUrl(baseUrl)}/#/collector-box${query}`;
}

function resolveLocalPluginApiBaseUrl(baseUrl) {
  if (typeof erpConfig.resolveLocalPluginApiBaseUrl === 'function') {
    return erpConfig.resolveLocalPluginApiBaseUrl(baseUrl);
  }
  return `${normalizeErpBaseUrl(baseUrl)}/api/local-plugin`;
}

async function checkPluginUpdateStatus() {
  const erpBaseUrl = await getErpBaseUrl();
  const token = await getLocalPluginToken();
  const url = `${resolveLocalPluginApiBaseUrl(erpBaseUrl)}/update-status?plugin_version=${encodeURIComponent(PLUGIN_VERSION)}`;
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'x-local-plugin-token': token
    }
  }, 12000);
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json?.success === false) {
    throw new Error(json?.error || `Plugin update check failed: HTTP ${response.status}`);
  }
  const plugin = json?.data?.plugin || json?.plugin || null;
  await chrome.storage.local.set({
    [PLUGIN_UPDATE_STATUS_STORAGE_KEY]: {
      ...(plugin || {}),
      checkedAt: Date.now()
    }
  });
  if (plugin?.update_required) {
    chrome.action.setBadgeText({ text: 'NEW' });
    chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
  return plugin;
}

function isAllowedLocalPluginUrl(url, baseUrl) {
  if (typeof erpConfig.isAllowedLocalPluginUrl === 'function') {
    return erpConfig.isAllowedLocalPluginUrl(url, baseUrl);
  }
  return false;
}

function isAllowedErpApiUrl(url, baseUrl) {
  if (typeof erpConfig.isAllowedErpApiUrl === 'function') {
    return erpConfig.isAllowedErpApiUrl(url, baseUrl);
  }
  return false;
}

function withResponse(promise, sendResponse) {
  promise
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
  return true;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('ERP request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchLocalPluginJson(pathname, options = {}) {
  const erpBaseUrl = await getErpBaseUrl();
  const url = `${resolveLocalPluginApiBaseUrl(erpBaseUrl)}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  if (!isAllowedLocalPluginUrl(url, erpBaseUrl)) {
    return { success: false, error: 'LOCAL_PLUGIN_URL_INVALID', message: 'Invalid local plugin API URL' };
  }
  const headers = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {})
  };
  const token = await getLocalPluginToken();
  if (token) headers['x-local-plugin-token'] = token;
  let tenantId = String(headers['x-tenant-id'] || headers['X-Tenant-Id'] || '').trim();
  if (!tenantId) tenantId = await resolveErpTenantId(erpBaseUrl);
  if (!tenantId) tenantId = 'admin';
  headers['x-tenant-id'] = tenantId;
  await cacheErpTenantId(tenantId, erpBaseUrl);
  const response = await fetchWithTimeout(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  }, Number(options.timeoutMs || 15000));
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    json = { success: false, error: text || `HTTP ${response.status}` };
  }
  if (!response.ok && json?.success !== false) {
    return { ...json, success: false, error: json?.error || `HTTP ${response.status}` };
  }
  return json;
}

async function getSellerCookieInfo(tabUrl = 'https://seller.ozon.ru/') {
  const cookies = await chrome.cookies.getAll({ domain: 'seller.ozon.ru' });
  const header = cookies.filter((item) => item?.name).map((item) => `${item.name}=${item.value || ''}`).join('; ');
  const preferredNames = ['sc_company_id', 'company_id', 'seller_company_id'];
  let companyId = '';
  for (const name of preferredNames) {
    const cookie = await chrome.cookies.get({ url: String(tabUrl || 'https://seller.ozon.ru/'), name });
    if (cookie?.value) { companyId = String(cookie.value).trim(); break; }
  }
  const portableCookies = cookies.filter((item) => item?.name).map((item) => ({
    name: item.name,
    value: item.value || '',
    domain: item.domain || '.seller.ozon.ru',
    path: item.path || '/',
    secure: Boolean(item.secure),
    httpOnly: Boolean(item.httpOnly),
    sameSite: item.sameSite || 'unspecified',
    expirationDate: Number(item.expirationDate || 0) || null
  }));
  return { header, companyId, cookies: portableCookies };
}

async function syncPendingSellerAuthBinding(observedCompanyId = '', sender = {}) {
  const prepareResponse = await fetchLocalPluginJson('/seller-analytics/plugin-prepare/next');
  const request = prepareResponse?.request || prepareResponse?.data || null;
  if (!request?.id) return { success: true, pending: false };
  const expectedCompanyId = String(request.expected_store_id || request.expectedStoreId || request.store_id || request.company_id || '').trim();
  const cookieInfo = await getSellerCookieInfo(sender?.tab?.url);
  const currentCompanyId = String(observedCompanyId || cookieInfo.companyId || '').trim();
  if (!cookieInfo.header || !currentCompanyId) return { success: false, pending: true, error: 'SELLER_AUTH_CONTEXT_MISSING' };
  if (expectedCompanyId && currentCompanyId !== expectedCompanyId) {
    return { success: false, pending: true, ignored: true, error: 'SELLER_COMPANY_MISMATCH', expectedCompanyId, currentCompanyId };
  }
  const probeResponse = await fetchLocalPluginJson('/seller-analytics/auth-probe', {
    method: 'POST',
    body: {
      company_id: currentCompanyId,
      cookie: cookieInfo.header,
      headers: { 'x-o3-company-id': currentCompanyId }
    },
    timeoutMs: 30000
  });
  const probe = probeResponse?.data || probeResponse;
  const usable = probeResponse?.success !== false && probe?.ok !== false && ![401, 403].includes(Number(probe?.status || 0));
  if (usable) {
    const bindingResponse = await fetchLocalPluginJson('/seller-analytics/auth-bindings', {
      method: 'POST',
      body: {
        company_id: currentCompanyId,
        store_id: currentCompanyId,
        cookie: cookieInfo.header,
        cookies: cookieInfo.cookies,
        headers: { 'x-o3-company-id': currentCompanyId },
        source: 'collector-plugin-auto-bind',
        plugin_version: PLUGIN_VERSION,
        captured_at: new Date().toISOString()
      }
    });
    if (bindingResponse?.success === false) throw new Error(bindingResponse?.error || 'Seller auth binding failed');
  }
  await fetchLocalPluginJson('/seller-analytics/plugin-prepare/result', {
    method: 'POST',
    body: {
      success: usable,
      current_company_id: currentCompanyId,
      error: usable ? '' : `AUTH_PROBE_HTTP_${probe?.status || 'UNKNOWN'}`
    }
  });
  return { success: usable, pending: false, companyId: currentCompanyId, probe };
}

async function queryTabs(queryInfo) {
  return await chrome.tabs.query(queryInfo);
}

function isErpBrowserTabUrl(url, baseUrl) {
  try {
    const target = new URL(String(url || ''));
    const base = new URL(normalizeErpBaseUrl(baseUrl));
    const basePath = String(base.pathname || '').replace(/\/+$/, '');
    const targetPath = String(target.pathname || '').replace(/\/+$/, '');
    const pathMatched = !basePath || targetPath === basePath || targetPath.startsWith(`${basePath}/`);
    return (
      target.protocol === base.protocol &&
      target.hostname === base.hostname &&
      String(target.port || '') === String(base.port || '') &&
      pathMatched
    );
  } catch (error) {
    return false;
  }
}

function isOzonFrontUrl(url) {
  try {
    const hostname = new URL(String(url || '')).hostname.toLowerCase();
    return /(^|\.)ozon\.(ru|kz|by)$/i.test(hostname) && !hostname.startsWith('seller.ozon.');
  } catch (error) {
    return false;
  }
}

function originPatternForUrl(url) {
  try {
    const target = new URL(String(url || ''));
    return `${target.protocol}//${target.hostname}/*`;
  } catch (error) {
    return '';
  }
}

async function hasOzonFrontPermission(url) {
  if (!chrome?.permissions?.contains) return true;
  const origin = originPatternForUrl(url);
  if (!origin) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch (error) {
    return true;
  }
}

async function hasOzonContentScript(tabId) {
  if (!tabId || !chrome?.scripting?.executeScript) return false;
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(window.__ozonErpCollectorContentLoaded)
    });
    return Boolean(result?.[0]?.result);
  } catch (error) {
    return false;
  }
}

async function injectOzonFrontContent(tabId, url, reason = 'auto') {
  if (!tabId || !isOzonFrontUrl(url) || !chrome?.scripting?.executeScript) return false;
  if (!(await hasOzonFrontPermission(url))) return false;
  const now = Date.now();
  const blockedUntil = Number(ozonInjectionBlockedByTabId.get(tabId) || 0);
  if (reason !== 'manual' && blockedUntil > now) return false;
  const lastAttemptAt = Number(ozonInjectionAttemptAtByTabId.get(tabId) || 0);
  if (now - lastAttemptAt < OZON_INJECTION_DEBOUNCE_MS) return false;
  ozonInjectionAttemptAtByTabId.set(tabId, now);
  if (await hasOzonContentScript(tabId)) return true;
  try {
    if (chrome?.scripting?.insertCSS) {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: OZON_FRONT_STYLE_FILES
      }).catch(() => {});
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: OZON_FRONT_SCRIPT_FILES
    });
    console.info('[Ozon ERP] Ozon front script injected', { tabId, reason });
    ozonInjectionBlockedByTabId.delete(tabId);
    return true;
  } catch (error) {
    const message = error?.message || String(error);
    if (/blocked/i.test(message)) {
      ozonInjectionBlockedByTabId.set(tabId, Date.now() + OZON_INJECTION_BLOCKED_TTL_MS);
      console.warn('[Ozon ERP] Ozon front script injection blocked by browser site access. Grant Ozon site access from the extension popup or Edge extension details.', { tabId, reason, url });
    } else {
      console.warn('[Ozon ERP] Ozon front script injection failed: ' + message, { tabId, reason, url });
    }
    return false;
  }
}

async function findErpBrowserTab(baseUrl) {
  const tabs = await queryTabs({});
  const matchedTabs = tabs.filter((tab) => tab.id && tab.status === 'complete' && isErpBrowserTabUrl(tab.url, baseUrl));
  return (
    matchedTabs.find((tab) => !String(tab.url || '').includes('#/login')) ||
    matchedTabs[0] ||
    null
  );
}

function isErpLoginTab(tab) {
  return String(tab?.url || '').includes('#/login');
}

async function getCachedErpTenantId(baseUrl) {
  const stored = await chrome.storage.local.get([ERP_TENANT_ID_STORAGE_KEY, ERP_TENANT_BASE_URL_STORAGE_KEY]);
  const cachedTenantId = String(stored?.[ERP_TENANT_ID_STORAGE_KEY] || '').trim();
  const cachedBaseUrl = normalizeErpBaseUrl(stored?.[ERP_TENANT_BASE_URL_STORAGE_KEY] || '');
  return cachedTenantId && cachedBaseUrl === normalizeErpBaseUrl(baseUrl) ? cachedTenantId : '';
}

async function cacheErpTenantId(tenantId, baseUrl) {
  const normalizedTenantId = String(tenantId || '').trim();
  if (!normalizedTenantId) return;
  await chrome.storage.local.set({
    [ERP_TENANT_ID_STORAGE_KEY]: normalizedTenantId,
    [ERP_TENANT_BASE_URL_STORAGE_KEY]: normalizeErpBaseUrl(baseUrl)
  });
}

async function readTenantIdFromErpTab(tabId) {
  if (!tabId) return '';
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (keys) => {
      try {
        for (const key of keys) {
          const value = String(localStorage.getItem(key) || sessionStorage.getItem(key) || '').trim();
          if (value) return value;
        }
      } catch (error) {
      }
      return '';
    },
    args: [['tenantId', 'tenant_id', 'erpTenantId', 'ozonTenantId']]
  });
  return String(result?.[0]?.result || '').trim();
}

async function resolveErpTenantId(baseUrl) {
  const tab = await findErpBrowserTab(baseUrl);
  if (tab?.id && !isErpLoginTab(tab)) {
    const tenantId = await readTenantIdFromErpTab(tab.id);
    if (tenantId) {
      await cacheErpTenantId(tenantId, baseUrl);
      return tenantId;
    }
  }

  return await getCachedErpTenantId(baseUrl);
}

async function importCollectedProductPayloadToErpDb(payload, syncContext = null, options = {}) {
  const directSyncContext = normalizeDirectSyncContext(syncContext);
  const erpBaseUrl = directSyncContext?.erpBaseUrl || await getErpBaseUrl();
  const requireTenant = options.requireTenant === true;
  const tenantId = directSyncContext?.tenantId || (requireTenant ? await resolveErpTenantId(erpBaseUrl) : '') || 'admin';
  if (requireTenant && directSyncContext?.tenantId) {
    await cacheErpTenantId(directSyncContext.tenantId, erpBaseUrl);
  }
  if (requireTenant && !tenantId) {
    return {
      success: false,
      error: 'ERP_TENANT_REQUIRED',
      message: 'ERP tenant required before manual collect'
    };
  }

  const syncUrl = `${resolveLocalPluginApiBaseUrl(erpBaseUrl)}/collected-products/sync`;
  if (!isAllowedLocalPluginUrl(syncUrl, erpBaseUrl)) {
    return {
      success: false,
      error: 'ERP_SYNC_URL_INVALID',
      message: 'Invalid ERP sync URL, check plugin ERP base URL'
    };
  }

  const headers = {
    'Content-Type': 'application/json'
  };
  if (tenantId) {
    headers['x-tenant-id'] = tenantId;
  }
  const pluginToken = await getLocalPluginToken();
  if (pluginToken) {
    headers['x-local-plugin-token'] = pluginToken;
  }

  const response = await fetchWithTimeout(syncUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      products: [payload]
    })
  }, 30000);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {}

  if (!response.ok || json?.success === false) {
    const message = json?.error || text || `Sync to ERP database failed: HTTP ${response.status}`;
    return {
      success: false,
      error: json?.error || `HTTP_${response.status}`,
      message
    };
  }

  return {
    success: true,
    importedCount: Number(json?.importedCount || 1),
    tenantId: tenantId || '',
    erpBaseUrl
  };
}

async function lookupCollectedProductCache(sku, syncContext = null) {
  const normalizedSku = String(sku || '').trim();
  if (!normalizedSku) {
    return {
      success: false,
      error: 'SKU_REQUIRED',
      message: 'SKU is required to query collected products'
    };
  }

  const directSyncContext = normalizeDirectSyncContext(syncContext);
  const erpBaseUrl = directSyncContext?.erpBaseUrl || await getErpBaseUrl();

  const lookupUrl = `${resolveLocalPluginApiBaseUrl(erpBaseUrl)}/collected-products/lookup?sku=${encodeURIComponent(normalizedSku)}`;
  if (!isAllowedLocalPluginUrl(lookupUrl, erpBaseUrl)) {
    return {
      success: false,
      error: 'ERP_LOOKUP_URL_INVALID',
      message: 'Invalid ERP lookup URL, check plugin ERP base URL'
    };
  }

  const headers = {};
  const pluginToken = await getLocalPluginToken();
  if (pluginToken) {
    headers['x-local-plugin-token'] = pluginToken;
  }
  const response = await fetchWithTimeout(lookupUrl, {
    method: 'GET',
    headers
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {}

  if (!response.ok || json?.success === false) {
    return {
      success: false,
      error: json?.error || `HTTP_${response.status}`,
      message: json?.error || text || `Query collected product failed: HTTP ${response.status}`
    };
  }

  return {
    success: true,
    tenantId: '',
    erpBaseUrl,
    data: json?.data || null
  };
}

async function lookupCollectedProductCaches(skus, syncContext = null) {
  const normalizedSkus = Array.from(
    new Set(
      (Array.isArray(skus) ? skus : [])
        .map((sku) => String(sku || '').trim())
        .filter(Boolean)
    )
  );
  const batch = await fetchLocalPluginJson('/collected-products/lookup-batch', {
    method: 'POST',
    body: { skus: normalizedSkus, syncContext },
    timeoutMs: 30000
  }).catch(() => null);
  if (batch?.success && Array.isArray(batch.results)) {
    return { success: true, total: normalizedSkus.length, results: batch.results };
  }
  const results = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(6, normalizedSkus.length || 1) }, async () => {
    while (cursor < normalizedSkus.length) {
      const sku = normalizedSkus[cursor++];
      const result = await lookupCollectedProductCache(sku, syncContext).catch((error) => ({
        success: false,
        error: error?.message || String(error)
      }));
      results.push({ sku, ...result });
    }
  }));
  return {
    success: true,
    total: normalizedSkus.length,
    results
  };
}

async function findSellerTab() {
  const tabs = await queryTabs({ url: '*://seller.ozon.ru/*' });
  return (
    tabs.find((tab) => tab.status === 'complete' && tab.url && !tab.url.includes('registration') && /\/(app|dashboard)\//.test(tab.url)) ||
    tabs.find((tab) => tab.status === 'complete' && tab.url && !tab.url.includes('registration')) ||
    tabs[0] ||
    null
  );
}

function waitForTabReady(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(handler);
      resolve();
    };
    const handler = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo?.status === 'complete') finish();
    };
    const timer = setTimeout(finish, Math.max(100, timeoutMs));
    chrome.tabs.onUpdated.addListener(handler);
    if (chrome.tabs.get) {
      chrome.tabs.get(tabId)
        .then((tab) => {
          if (tab?.status === 'complete' || Date.now() > deadline) finish();
        })
        .catch(() => {});
    }
  });
}

async function ensureSellerTab() {
  const existing = await findSellerTab();
  if (existing?.id) return existing;
  const tab = await chrome.tabs.create({ url: SELLER_BRIDGE_URL, active: false });
  await waitForTabReady(tab.id);
  return tab;
}

async function checkSellerTab() {
  const tabs = await queryTabs({ url: '*://seller.ozon.ru/*' });
  const available = tabs.filter((tab) => tab.status === 'complete' && tab.url && !tab.url.includes('registration'));
  return { hasSellerTab: available.length > 0, tabCount: available.length };
}

async function testSellerTabCommunication() {
  const tab = await findSellerTab();
  if (!tab?.id) return { success: false, error: 'NO_SELLER_TAB' };
  return await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: 'PING_TEST', timestamp: Date.now() }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: 'COMMUNICATION_FAILED', detail: chrome.runtime.lastError.message });
        return;
      }
      resolve(response?.pong === true ? { success: true, message: 'Communication OK' } : { success: false, error: 'NO_RESPONSE', detail: JSON.stringify(response) });
    });
  });
}

async function refreshSellerTab() {
  const tab = await findSellerTab();
  if (!tab?.id) return { success: false, error: 'NO_SELLER_TAB', message: 'No seller.ozon.ru page found' };
  await chrome.tabs.reload(tab.id);
  return { success: true, message: 'seller.ozon.ru page refreshed, please retry later' };
}

async function sendMessageToSellerTab(tabId, payload) {
  return await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          success: false,
          error: 'TAB_COMMUNICATION_FAILED',
          message: 'Failed to communicate with seller.ozon.ru tab'
        });
        return;
      }
      resolve(response);
    });
  });
}

async function sendMessageToTab(tabId, payload) {
  return await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          success: false,
          error: chrome.runtime.lastError.message
        });
        return;
      }
      resolve(response);
    });
  });
}

async function sendMessageToTabWithRetry(tabId, payload, retries = 5, intervalMs = 800) {
  for (let index = 0; index < retries; index += 1) {
    const response = await sendMessageToTab(tabId, payload);
    if (response?.success || response?.success === false) return response;
    if (index < retries - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return { success: false, error: 'Page not responding, refresh Ozon and retry' };
}

async function reinjectSellerBridge(tabId) {
  if (!tabId || !chrome?.scripting?.executeScript) return false;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['seller-bridge-content.js']
  });
  return true;
}

async function crossTabOzonRequest(message, sender) {
  const tab = await ensureSellerTab();
  if (!tab?.id) {
    return { success: true, hasSellerTab: false, error: 'NO_SELLER_TAB', message: 'Open seller.ozon.ru first' };
  }
  const requestPayload = {
    type: 'OZON_SKU_API_REQUEST',
    requestId: message.requestId,
    sku: message.sku,
    apiType: message.apiType,
    variantId: message.variantId,
    sourceTabId: sender?.tab?.id
  };
  const initialResponse = await sendMessageToSellerTab(tab.id, requestPayload);
  if (initialResponse?.error !== 'TAB_COMMUNICATION_FAILED') {
    return initialResponse;
  }

  try {
    await reinjectSellerBridge(tab.id);
  } catch (error) {
    return initialResponse;
  }

  return await sendMessageToSellerTab(tab.id, requestPayload);
}

async function crossTabOzonMediaUpload(message, sender) {
  const tab = await ensureSellerTab();
  if (!tab?.id) {
    return { success: false, error: 'NO_SELLER_TAB', message: 'Open seller.ozon.ru first' };
  }
  const requestPayload = {
    type: 'OZON_ERP_MEDIA_UPLOAD',
    requestId: message.requestId,
    mediaType: message.mediaType || message.kind || 'image',
    fileName: message.fileName || '',
    mimeType: message.mimeType || '',
    dataUrl: message.dataUrl || '',
    sourceTabId: sender?.tab?.id
  };
  const initialResponse = await sendMessageToSellerTab(tab.id, requestPayload);
  if (initialResponse?.error !== 'TAB_COMMUNICATION_FAILED') return initialResponse;
  try {
    await reinjectSellerBridge(tab.id);
  } catch (error) {
    return initialResponse;
  }
  return await sendMessageToSellerTab(tab.id, requestPayload);
}

async function runFbpFillTask(message) {
  const tabs = await queryTabs({ url: '*://seller.ozon.ru/app/fbp-supply/create-order/*' });
  const tab = tabs.find((item) => item.status === 'complete' && /\/app\/fbp-supply\/create-order\/\d+/i.test(String(item.url || '')));
  if (!tab?.id) {
    return { success: false, error: 'FBP_PAGE_REQUIRED', message: '请先打开Ozon FBP申请的“商品和货位”页面，然后重试' };
  }
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  const requestPayload = {
    type: 'OZON_ERP_FBP_FILL',
    requestId: message.requestId,
    payload: message.payload || {}
  };
  const initialResponse = await sendMessageToSellerTab(tab.id, requestPayload);
  if (initialResponse?.error !== 'TAB_COMMUNICATION_FAILED') return initialResponse;
  try {
    await reinjectSellerBridge(tab.id);
  } catch (error) {
    return initialResponse;
  }
  return await sendMessageToSellerTab(tab.id, requestPayload);
}

function normalizeServerPublishMediaKind(value = '') {
  return String(value || '').trim().toLowerCase() === 'video' ? 'video' : 'image';
}

function inferServerPublishMediaMimeType(sourceUrl = '', kind = 'image', fallback = '') {
  const explicit = String(fallback || '').trim();
  if (explicit) return explicit;
  const text = String(sourceUrl || '').trim();
  const dataMatch = text.match(/^data:([^;,]+)[;,]/i);
  if (dataMatch?.[1]) return dataMatch[1];
  let pathname = text.split(/[?#]/)[0].toLowerCase();
  try {
    pathname = new URL(text).pathname.toLowerCase();
  } catch (error) {}
  if (/\.jpe?g$/.test(pathname)) return 'image/jpeg';
  if (/\.png$/.test(pathname)) return 'image/png';
  if (/\.webp$/.test(pathname)) return 'image/webp';
  if (/\.gif$/.test(pathname)) return 'image/gif';
  if (/\.mov$/.test(pathname)) return 'video/quicktime';
  if (/\.webm$/.test(pathname)) return 'video/webm';
  if (/\.mp4$/.test(pathname)) return 'video/mp4';
  return normalizeServerPublishMediaKind(kind) === 'video' ? 'video/mp4' : 'image/jpeg';
}

function inferServerPublishMediaFileName(job = {}) {
  const explicit = String(job.fileName || job.file_name || '').trim();
  if (explicit) return explicit;
  const sourceUrl = String(job.sourceUrl || job.source_url || '').trim();
  try {
    const name = decodeURIComponent(new URL(sourceUrl).pathname.split('/').filter(Boolean).pop() || '');
    if (name && /\.[A-Za-z0-9]{2,5}$/.test(name)) return name.slice(0, 160);
  } catch (error) {}
  const kind = normalizeServerPublishMediaKind(job.kind);
  const mimeType = inferServerPublishMediaMimeType(sourceUrl, kind, job.mimeType || job.mime_type);
  const extension = mimeType.includes('png') ? '.png'
    : mimeType.includes('webp') ? '.webp'
      : mimeType.includes('gif') ? '.gif'
        : mimeType.includes('mp4') ? '.mp4'
          : mimeType.includes('quicktime') ? '.mov'
            : mimeType.includes('webm') ? '.webm'
              : '.jpg';
  return `${kind}-${Date.now().toString(36)}${extension}`;
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer || new ArrayBuffer(0));
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

async function serverPublishMediaSourceToDataUrl(job = {}) {
  const sourceUrl = String(job.sourceUrl || job.source_url || '').trim();
  if (!sourceUrl) throw new Error('Media upload job is missing sourceUrl');
  if (/^data:/i.test(sourceUrl)) {
    return {
      dataUrl: sourceUrl,
      mimeType: inferServerPublishMediaMimeType(sourceUrl, job.kind, job.mimeType || job.mime_type),
      fileName: inferServerPublishMediaFileName(job)
    };
  }
  const response = await fetch(sourceUrl, {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store'
  });
  if (!response?.ok) throw new Error(`Download media failed: HTTP ${response?.status || 0}`);
  const contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim();
  const mimeType = inferServerPublishMediaMimeType(sourceUrl, job.kind, job.mimeType || job.mime_type || contentType);
  const arrayBuffer = await response.arrayBuffer();
  return {
    dataUrl: `data:${mimeType};base64,${arrayBufferToBase64(arrayBuffer)}`,
    mimeType,
    fileName: inferServerPublishMediaFileName({ ...job, mimeType })
  };
}

function buildServerPublishMediaSidecarRunnerId() {
  const extensionId = String(chrome.runtime?.id || 'collector-plugin').trim() || 'collector-plugin';
  return `collector_plugin_media_sidecar_${extensionId}`;
}

async function completeServerPublishMediaUploadJob(job = {}, payload = {}) {
  const jobId = encodeURIComponent(String(job.jobId || job.job_id || '').trim());
  const mediaJobId = encodeURIComponent(String(job.mediaJobId || job.media_job_id || job.id || '').trim());
  if (!jobId || !mediaJobId) return { success: false, error: 'MEDIA_JOB_ID_MISSING' };
  return await fetchLocalPluginJson(`/server-publish/media-upload-jobs/${jobId}/${mediaJobId}`, {
    method: 'POST',
    body: payload
  });
}

async function processServerPublishMediaUploadJob(job = {}) {
  try {
    const source = await serverPublishMediaSourceToDataUrl(job);
    const uploadResponse = await crossTabOzonMediaUpload({
      type: 'OZON_ERP_MEDIA_UPLOAD',
      requestId: `server-publish-${job.jobId || job.job_id || 'job'}-${job.mediaJobId || job.media_job_id || job.id || Date.now()}`,
      mediaType: normalizeServerPublishMediaKind(job.kind),
      fileName: source.fileName,
      mimeType: source.mimeType,
      dataUrl: source.dataUrl
    }, {});
    const uploadedUrl = String(uploadResponse?.url || uploadResponse?.resultUrl || uploadResponse?.data?.url || '').trim();
    if (!uploadResponse?.success || !uploadedUrl) {
      const message = String(uploadResponse?.message || uploadResponse?.error || 'Seller media upload failed').trim();
      await completeServerPublishMediaUploadJob(job, {
        success: false,
        error: uploadResponse?.error || 'SELLER_MEDIA_UPLOAD_FAILED',
        message
      });
      return {
        success: false,
        jobId: job.jobId || job.job_id || '',
        mediaJobId: job.mediaJobId || job.media_job_id || job.id || '',
        error: uploadResponse?.error || 'SELLER_MEDIA_UPLOAD_FAILED',
        message
      };
    }
    const completeResponse = await completeServerPublishMediaUploadJob(job, {
      success: true,
      url: uploadedUrl,
      message: ''
    });
    if (completeResponse?.success === false) {
      return {
        success: false,
        jobId: job.jobId || job.job_id || '',
        mediaJobId: job.mediaJobId || job.media_job_id || job.id || '',
        error: completeResponse.error || 'MEDIA_UPLOAD_RESULT_WRITE_FAILED',
        message: completeResponse.message || completeResponse.error || 'Media upload result write failed'
      };
    }
    return {
      success: true,
      jobId: job.jobId || job.job_id || '',
      mediaJobId: job.mediaJobId || job.media_job_id || job.id || '',
      url: uploadedUrl
    };
  } catch (error) {
    const message = error?.message || String(error);
    await completeServerPublishMediaUploadJob(job, {
      success: false,
      error: 'SERVER_PUBLISH_MEDIA_SIDECAR_FAILED',
      message
    }).catch(() => null);
    return {
      success: false,
      jobId: job.jobId || job.job_id || '',
      mediaJobId: job.mediaJobId || job.media_job_id || job.id || '',
      error: 'SERVER_PUBLISH_MEDIA_SIDECAR_FAILED',
      message
    };
  }
}

async function runServerPublishMediaSidecar(options = {}) {
  if (serverPublishMediaSidecarPromise && options.force !== true) {
    return await serverPublishMediaSidecarPromise;
  }
  serverPublishMediaSidecarPromise = (async () => {
    const runnerId = options.runnerId || buildServerPublishMediaSidecarRunnerId();
    const limit = Math.max(1, Math.min(20, Number(options.limit || SERVER_PUBLISH_MEDIA_SIDECAR_LIMIT) || SERVER_PUBLISH_MEDIA_SIDECAR_LIMIT));
    const leaseMs = Math.max(60000, Number(options.leaseMs || SERVER_PUBLISH_MEDIA_SIDECAR_LEASE_MS) || SERVER_PUBLISH_MEDIA_SIDECAR_LEASE_MS);
    const concurrency = Math.max(1, Math.min(12, Number(options.concurrency || SERVER_PUBLISH_MEDIA_SIDECAR_CONCURRENCY) || SERVER_PUBLISH_MEDIA_SIDECAR_CONCURRENCY));
    const results = [];
    let claimed = 0;
    while (true) {
      const claim = await fetchLocalPluginJson('/server-publish/media-upload-jobs/claim', {
        method: 'POST',
        body: { runnerId, limit, leaseMs }
      });
      if (claim?.success === false) {
        if (!claimed) return { success: false, error: claim.error, message: claim.message || claim.error, claimed: 0, results: [] };
        break;
      }
      const jobs = Array.isArray(claim?.jobs) ? claim.jobs : [];
      if (!jobs.length) break;
      const resultOffset = results.length;
      claimed += jobs.length;
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
        while (cursor < jobs.length) {
          const index = cursor++;
          results[resultOffset + index] = await processServerPublishMediaUploadJob(jobs[index]);
        }
      }));
      if (jobs.length < limit) break;
    }
    return {
      success: !results.some((item) => item?.success === false),
      claimed,
      results
    };
  })();
  try {
    return await serverPublishMediaSidecarPromise;
  } finally {
    serverPublishMediaSidecarPromise = null;
  }
}

function scheduleServerPublishMediaSidecar() {
  if (!chrome.alarms?.create) return;
  chrome.alarms.create(SERVER_PUBLISH_MEDIA_SIDECAR_ALARM_NAME, {
    delayInMinutes: SERVER_PUBLISH_MEDIA_SIDECAR_INITIAL_DELAY_MINUTES,
    periodInMinutes: SERVER_PUBLISH_MEDIA_SIDECAR_INTERVAL_MINUTES
  });
}

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatMeasurement(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  return Number.isInteger(numeric) ? String(numeric) : String(Math.round(numeric * 100) / 100);
}

function hasFilledValue(value) {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function firstFilledValue(source = {}, keys = []) {
  if (!source || typeof source !== 'object') return '';
  for (const key of keys) {
    const value = source[key];
    if (hasFilledValue(value)) return value;
  }
  return '';
}

function firstFilledValueDeep(source = {}, keys = [], depth = 0) {
  if (!source || typeof source !== 'object' || depth > 4) return '';
  const wanted = new Set(keys.map((key) => String(key).toLowerCase()));
  for (const [key, value] of Object.entries(source)) {
    if (wanted.has(String(key).toLowerCase()) && hasFilledValue(value)) return value;
  }
  for (const value of Object.values(source)) {
    if (!value || typeof value !== 'object') continue;
    const nested = firstFilledValueDeep(value, keys, depth + 1);
    if (hasFilledValue(nested)) return nested;
  }
  return '';
}

function normalizeSellerAttributeValue(item = {}) {
  const firstValue = Array.isArray(item?.values) ? item.values[0] : null;
  const value = item?.value ?? item?.attribute_value ?? item?.text ?? firstValue?.value ?? firstValue?.name ?? firstValue?.text;
  if (Array.isArray(value)) return value.map((entry) => normalizeSellerAttributeValue(entry)).filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    return cleanText(value.value ?? value.name ?? value.text ?? value.label ?? value.display_value ?? '');
  }
  return cleanText(value);
}

function sellerAttributeValueByIds(attributes = [], ids = []) {
  const wanted = new Set(ids.map((id) => String(id)));
  for (const item of Array.isArray(attributes) ? attributes : []) {
    const key = String(item?.key || item?.attribute_id || item?.attributeId || item?.id || '').trim();
    if (!wanted.has(key)) continue;
    const value = normalizeSellerAttributeValue(item);
    if (value) return value;
  }
  return '';
}

function sellerMeasurementByAttributeIds(attributes = [], ids = []) {
  const value = sellerAttributeValueByIds(attributes, ids);
  return formatMeasurement(value);
}

function normalizeSellerPrice(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (typeof value === 'object') {
    const nested = firstFilledValue(value, ['value', 'amount', 'price', 'rub', 'RUB']);
    return normalizeSellerPrice(nested);
  }
  const raw = String(value).replace(/\u00a0/g, ' ').trim();
  if (!raw) return '';
  const compact = raw.replace(/[^\d,.-]/g, '');
  if (!compact) return '';
  const lastComma = compact.lastIndexOf(',');
  const lastDot = compact.lastIndexOf('.');
  let normalized = compact;
  if (lastComma > -1 && lastDot > -1) {
    normalized = lastComma > lastDot
      ? compact.replace(/\./g, '').replace(',', '.')
      : compact.replace(/,/g, '');
  } else if (lastComma > -1) {
    normalized = compact.replace(',', '.');
  }
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : '';
}

function normalizeSellerImageUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value !== 'object') return '';
  const direct = firstFilledValue(value, [
    'url',
    'src',
    'image',
    'imageUrl',
    'image_url',
    'main_image',
    'primary_image',
    'cover',
    'coverUrl',
    'cover_url',
    'big',
    'large',
    'medium',
    'small'
  ]);
  if (direct) return normalizeSellerImageUrl(direct);
  return '';
}

function normalizeSellerImages(...sources) {
  const result = [];
  const append = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(append);
      return;
    }
    const imageUrl = normalizeSellerImageUrl(value);
    if (imageUrl && !result.includes(imageUrl)) result.push(imageUrl);
  };
  sources.forEach(append);
  return result;
}

function selectSellerTitle(sources, keys) {
  return (Array.isArray(sources) ? sources : [])
    .flatMap((source) => (keys || []).map((key) => cleanText(source?.[key])))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || '';
}

function normalizeSellerBrand(value) {
  const text = cleanText(value);
  if (!text) return '';
  return text === 'без бренда' ? 'No brand' : text;
}

function normalizeSellerCategoryIds(source = {}) {
  return [source.category1Id, source.category2Id, source.category3Id]
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function normalizeSellerBaseCategoryIds(source = {}) {
  const categories = Array.isArray(source.categories) ? source.categories : [];
  return categories
    .map((item) => ({
      id: Number(item?.id),
      level: Number(item?.level)
    }))
    .filter((item) => Number.isFinite(item.id) && item.id > 0)
    .sort((a, b) => (Number.isFinite(a.level) ? a.level : 0) - (Number.isFinite(b.level) ? b.level : 0))
    .map((item) => item.id);
}

function normalizeSellerTypeId(source = {}) {
  const value =
    source.description_type_dict_value ??
    source.descriptionTypeDictValue ??
    source.type_id ??
    source.typeId ??
    '';
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? String(numeric) : '';
}

function appendSellerTypeIdToCategoryIds(categoryIds, typeId) {
  const ids = Array.isArray(categoryIds) ? categoryIds.slice() : [];
  const numericTypeId = Number(typeId);
  if (Number.isFinite(numericTypeId) && numericTypeId > 0 && !ids.includes(numericTypeId)) {
    ids.push(numericTypeId);
  }
  return ids;
}

function normalizeSellerCategoryPath(source = {}) {
  const category1 = cleanText(source.category1 || '');
  const category3 = cleanText(source.category3 || '');
  if (!category1 || !category3) return '';
  return `${category1}/${category3}`;
}

function normalizeSellerCreateMeta(value) {
  if (!value) {
    return { nullableCreateDate: '', createDays: '' };
  }
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) {
    return { nullableCreateDate: '', createDays: '' };
  }
  const today = new Date();
  const diffDays = Math.floor(Math.abs(today.getTime() - time) / (24 * 60 * 60 * 1000));
  return {
    nullableCreateDate: date.toISOString().slice(0, 10),
    createDays: diffDays
  };
}

function normalizeSellerReturnRate(value) {
  if (value === undefined || value === null || value === '') return '';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  const redemptionRate = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
  const returnRate = 100 - redemptionRate;
  if (!Number.isFinite(returnRate)) return '';
  return `${returnRate.toFixed(1)}%`;
}

function normalizeSellerCommissionPercent(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'object') {
    return normalizeSellerCommissionPercent(firstFilledValue(value, [
      'percent',
      'commission_percent',
      'commissionPercent',
      'rate',
      'value',
      'amount'
    ]));
  }
  const text = cleanText(value);
  if (!text) return '';
  const numeric = normalizeSellerPrice(text);
  if (numeric === '') return text;
  const percent = numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Number.isInteger(percent) ? String(percent) : String(Math.round(percent * 100) / 100);
}

function normalizeSellerCommissionSchema(value, fallback = '') {
  return cleanText(value || fallback).toLowerCase();
}

function normalizeSellerCommissionEntry(entry, fallbackSchema = '') {
  if (entry === undefined || entry === null || entry === '') return null;
  if (typeof entry !== 'object') {
    const value = normalizeSellerCommissionPercent(entry);
    return value ? { sales_schema: normalizeSellerCommissionSchema(fallbackSchema, 'fbs'), value } : null;
  }
  const schema = normalizeSellerCommissionSchema(
    entry.sales_schema ||
    entry.sale_schema ||
    entry.salesSchema ||
    entry.delivery_schema ||
    entry.deliverySchema ||
    entry.schema ||
    entry.name ||
    entry.type,
    fallbackSchema
  );
  const value = normalizeSellerCommissionPercent(entry);
  if (!value) return null;
  return {
    ...entry,
    sales_schema: schema || 'fbs',
    value
  };
}

function normalizeSellerCommissions(...sources) {
  const result = [];
  const seen = new Set();
  const append = (value, fallbackSchema = '') => {
    if (value === undefined || value === null || value === '') return;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return;
      if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
        try {
          append(JSON.parse(text), fallbackSchema);
          return;
        } catch (error) {}
      }
    }
    if (Array.isArray(value)) {
      value.forEach((item) => append(item, fallbackSchema));
      return;
    }
    if (value && typeof value === 'object' && !('value' in value) && !('percent' in value) && !('rate' in value) && !('commission_percent' in value)) {
      for (const [key, item] of Object.entries(value)) append(item, key);
      return;
    }
    const entry = normalizeSellerCommissionEntry(value, fallbackSchema);
    if (!entry) return;
    const key = `${entry.sales_schema}:${entry.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(entry);
  };

  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    append(source.category_commission || source.categoryCommission);
    append(source.commissions || source.commission);
    append(source.fbo_commission || source.fboCommission || source.fbo_rate || source.fboRate, 'fbo');
    append(source.fbs_commission || source.fbsCommission || source.fbs_rate || source.fbsRate, 'fbs');
    append(source.rfbs_commission || source.rfbsCommission || source.rfbs_rate || source.rfbsRate, 'rfbs');
    append(source.commission_percent || source.commissionPercent || source.commission_rate || source.commissionRate, source.salesSchema || source.sales_schema || 'fbs');
  }
  return result;
}

function applySellerCommissionFields(target, ...sources) {
  if (!target || typeof target !== 'object') return target;
  const commissions = normalizeSellerCommissions(...sources);
  if (commissions.length === 0) return target;
  target.category_commission = target.category_commission || commissions;
  target.commissions = target.commissions || commissions;
  for (const item of commissions) {
    const schema = normalizeSellerCommissionSchema(item.sales_schema || item.delivery_schema || item.schema);
    if (!schema) continue;
    const value = normalizeSellerCommissionPercent(item);
    if (!value) continue;
    if (schema.includes('rfbs')) target.rfbs_rate = target.rfbs_rate || value;
    else if (schema.includes('fbo')) target.fbo_rate = target.fbo_rate || value;
    else if (schema.includes('fbs')) target.fbs_rate = target.fbs_rate || value;
  }
  return target;
}

function buildSellerSalesFields(source = {}) {
  if (!source || typeof source !== 'object') return {};
  const result = { ...source };
  const categoryIds = normalizeSellerCategoryIds(source);
  const categoryPath = normalizeSellerCategoryPath(source);
  const createMeta = normalizeSellerCreateMeta(source.nullableCreateDate);
  const views = Number(source.views) || 0;
  const qtyViewPdp = Number(source.qtyViewPdp) || 0;
  const clickRate = views > 0 && qtyViewPdp > 0 ? `${(qtyViewPdp / views * 100).toFixed(2)}%` : '';

  if (source.soldSum !== undefined && source.soldSum !== null && source.soldSum !== '') {
    result.soldSum = source.soldSum;
    if (result.soldSumRub === undefined || result.soldSumRub === null || result.soldSumRub === '') {
      result.soldSumRub = source.soldSum;
    }
  }
  if (source.variantId !== undefined && source.variantId !== null && source.variantId !== '') {
    result.variantId = source.variantId;
  }
  if (hasFilledValue(source.photo)) {
    result.productImage = result.productImage || source.photo;
    result.mainImage = result.mainImage || source.photo;
    result.images = normalizeSellerImages(source.photo, result.images);
  }
  if (hasFilledValue(source.link)) {
    result.productLink = result.productLink || source.link;
    result.productUrl = result.productUrl || source.link;
  }
  const avgPrice = normalizeSellerPrice(source.avgPrice);
  if (avgPrice !== '') {
    result.avgPrice = source.avgPrice;
    result.price = result.price || avgPrice;
    result.productPrice = result.productPrice || avgPrice;
    result.sell_price = result.sell_price || avgPrice;
    result.cardPrice = result.cardPrice || avgPrice;
  }

  const brand = normalizeSellerBrand(source.brand);
  if (brand) result.brand = brand;
  if (categoryPath) result.category = categoryPath;
  if (categoryIds.length > 0) result.category_ids = categoryIds;
  if (clickRate) result.custom_click_rate = clickRate;
  if (createMeta.nullableCreateDate) result.nullableCreateDate = createMeta.nullableCreateDate;
  if (createMeta.createDays !== '') result.createDays = createMeta.createDays;
  if (source.nullableRedemptionRate !== undefined && source.nullableRedemptionRate !== null && source.nullableRedemptionRate !== '') {
    result.nullableRedemptionRate = normalizeSellerReturnRate(source.nullableRedemptionRate);
  }
  applySellerCommissionFields(result, source);
  return result;
}

function buildSellerBaseInfoFields(source = {}) {
  const variant = Array.isArray(source?.variants) ? source.variants[0] : source;
  if (!variant || typeof variant !== 'object') return {};
  const result = { ...variant };
  const variantId = variant.variant_id || variant.variantId || '';
  if (variantId) result.variantId = variantId;
  const title = cleanText(variant.variant_name || variant.name || variant.title || '');
  if (title) {
    result.productTitle = title;
    result.name = title;
  }
  const brand = normalizeSellerBrand(variant.brand_name || variant.brand);
  if (brand) result.brand = brand;
  if (hasFilledValue(variant.brand_id)) result.brandId = variant.brand_id;
  const sellerTypeId = normalizeSellerTypeId(variant);
  const categoryIds = appendSellerTypeIdToCategoryIds(normalizeSellerBaseCategoryIds(variant), sellerTypeId);
  if (categoryIds.length > 0) result.category_ids = categoryIds;
  if (!hasFilledValue(result.description_category_id) && categoryIds.length >= 2) {
    result.description_category_id = String(categoryIds[categoryIds.length - 2]);
  }
  if (sellerTypeId) {
    result.type_id = sellerTypeId;
  } else if (!hasFilledValue(result.type_id) && categoryIds.length >= 1) {
    result.type_id = String(categoryIds[categoryIds.length - 1]);
  }
  const images = normalizeSellerImages(variant.main_image, variant.secondary_images, variant.images);
  if (images.length > 0) {
    result.images = images;
    result.productImage = images[0];
    result.mainImage = images[0];
  }
  if (hasFilledValue(variant.rating)) result.rating = variant.rating;
  if (Array.isArray(variant.barcodes) && variant.barcodes.length > 0) result.barcodes = variant.barcodes;
  if (Array.isArray(variant.skus) && variant.skus.length > 0) result.skus = variant.skus;
  if (hasFilledValue(variant.description_type_name)) result.description_type_name = variant.description_type_name;
  if (hasFilledValue(variant.description_type_dict_value)) result.description_type_dict_value = variant.description_type_dict_value;
  return result;
}

function extractVariantV1Logistics(source = {}) {
  const attributes = Array.isArray(source.attributes) ? source.attributes : [];
  let depth = '';
  let width = '';
  let height = '';
  let weight = '';

  for (const item of attributes) {
    const key = String(item?.key || item?.attribute_id || item?.attributeId || item?.id || '').trim();
    const firstValue = Array.isArray(item?.values) ? item.values[0] : null;
    const value = item?.value ?? firstValue?.value;
    if (key === '9454') depth = formatMeasurement(value);
    if (key === '9455') width = formatMeasurement(value);
    if (key === '9456') height = formatMeasurement(value);
    if (key === '4497') weight = formatMeasurement(value);
  }

  const customVolume = depth && width && height ? `${depth}x${width}x${height}` : '';
  return {
    custom_weight: weight || '',
    weight_g: weight || '',
    depth: depth || '',
    width: width || '',
    height: height || '',
    dimensions: customVolume ? { depth, width, height, unit: 'mm' } : null,
    real_dimensions: customVolume || '',
    custom_volume: customVolume || ''
  };
}

function extractVariantV2Logistics(source = {}) {
  const item = source?.item && typeof source.item === 'object' ? source.item : source;
  const attributes = Array.isArray(item?.attributes) ? item.attributes : (Array.isArray(source?.attributes) ? source.attributes : []);
  const depth = formatMeasurement(firstFilledValueDeep(item, ['depth', 'length', 'length_mm', 'depth_mm'])) || sellerMeasurementByAttributeIds(attributes, ['9454']);
  const width = formatMeasurement(firstFilledValueDeep(item, ['width', 'width_mm'])) || sellerMeasurementByAttributeIds(attributes, ['9455']);
  const height = formatMeasurement(firstFilledValueDeep(item, ['height', 'height_mm'])) || sellerMeasurementByAttributeIds(attributes, ['9456']);
  const weight = formatMeasurement(firstFilledValueDeep(item, ['weight', 'weight_g', 'package_weight', 'custom_weight'])) || sellerMeasurementByAttributeIds(attributes, ['4497']);
  const customVolume = depth && width && height ? `${depth}x${width}x${height}` : '';
  return {
    custom_weight: weight || '',
    weight_g: weight || '',
    depth: depth || '',
    width: width || '',
    height: height || '',
    dimensions: customVolume ? { depth, width, height, unit: 'mm' } : null,
    real_dimensions: customVolume || '',
    custom_volume: customVolume || ''
  };
}

function buildSellerVariantFields(source = {}, options = {}) {
  if (!source || typeof source !== 'object') return {};
  const variantMode = options.variantMode === 'variant_v2' ? 'variant_v2' : 'variant';
  const result = variantMode === 'variant_v2' ? extractVariantV2Logistics(source) : extractVariantV1Logistics(source);
  const item = source?.item && typeof source.item === 'object' ? source.item : source;
  const variantId = source.variant_id || source.variantId || source?.item?.variant_id || source?.item?.variantId || '';
  if (variantId) result.variantId = variantId;
  if (hasFilledValue(source.bundle_id)) result.bundle_id = source.bundle_id;
  if (hasFilledValue(item.offer_id)) result.offer_id = item.offer_id;
  if (hasFilledValue(item.barcode)) result.barcode = item.barcode;
  if (hasFilledValue(item.description_category_id)) result.description_category_id = item.description_category_id;
  if (hasFilledValue(item.new_description_category_id)) result.new_description_category_id = item.new_description_category_id;
  const sellerTypeId = normalizeSellerTypeId(item);
  if (sellerTypeId) result.type_id = sellerTypeId;
  else if (hasFilledValue(item.type_id)) result.type_id = item.type_id;
  if (hasFilledValue(item.origin_variant_id)) result.origin_variant_id = item.origin_variant_id;
  const attributes = Array.isArray(item.attributes) ? item.attributes : [];
  const color = firstFilledValue(item, ['color', 'color_name', 'colorName']) || sellerAttributeValueByIds(attributes, ['8229', '10096', '22814']);
  const modelName = firstFilledValue(item, ['model_name', 'modelName', 'model']) || sellerAttributeValueByIds(attributes, ['9048']);
  if (hasFilledValue(color)) result.color = color;
  if (hasFilledValue(modelName)) {
    result.modelName = modelName;
    result.spec = result.spec || modelName;
  }
  const itemTitle = item.name || item.title || '';
  if (hasFilledValue(itemTitle) && (!hasFilledValue(color) || cleanText(itemTitle) !== cleanText(color))) {
    result.variantName = itemTitle;
    result.name = result.name || itemTitle;
    result.productTitle = result.productTitle || itemTitle;
  } else if (hasFilledValue(modelName)) {
    result.variantName = result.variantName || modelName;
  }
  const images = normalizeSellerImages(item.primary_image, item.images, item.color_image);
  if (images.length > 0) {
    result.primary_image = item.primary_image || images[0];
    result.images = images;
    result.productImage = images[0];
    result.mainImage = images[0];
  }
  if (attributes.length > 0) result.attributes = attributes;
  applySellerCommissionFields(result, source, source?.item);
  return result;
}

async function requestSellerBridgeDataFromBackground(sku, apiType = 'sales', variantId = '') {
  const requestId = `ozon_erp_auto_seller_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const response = await crossTabOzonRequest({
    requestId,
    sku: String(sku || ''),
    apiType,
    variantId
  }, null);
  if (!response) {
    throw new Error('seller.ozon.ru did not return a response');
  }
  if (response.success !== true) {
    throw new Error(response.message || response.error || 'seller.ozon.ru request failed');
  }
  return response.data;
}

async function fetchSellerCollectedProductFields(sku) {
  const normalizedSku = String(sku || '').trim();
  if (!normalizedSku) throw new Error('SKU is required');

  const fields = {};
  const raw = {};
  const warnings = [];
  let resolvedVariantId = '';
  let variantApiType = 'variant_v2';

  try {
    const salesResponse = await requestSellerBridgeDataFromBackground(normalizedSku, 'sales');
    raw.sales = Array.isArray(salesResponse?.items) && salesResponse.items.length > 0 ? salesResponse.items[0] : null;
    raw.salesMeta = {
      totals: salesResponse?.totals ?? '',
      updateDate: salesResponse?.updateDate ?? '',
      benchmark: salesResponse?.benchmark ?? null
    };
    if (raw.sales) {
      Object.assign(fields, buildSellerSalesFields(raw.sales));
      if (hasFilledValue(raw.salesMeta.updateDate)) fields.salesUpdateDate = raw.salesMeta.updateDate;
      if (hasFilledValue(raw.salesMeta.totals)) fields.salesTotals = raw.salesMeta.totals;
      if (hasFilledValue(raw.salesMeta.benchmark)) fields.salesBenchmark = raw.salesMeta.benchmark;
      resolvedVariantId = String(raw.sales.variantId || raw.sales.variant_id || '').trim();
    } else {
      warnings.push('seller sales did not return product data');
    }
  } catch (error) {
    warnings.push(error?.message || String(error));
  }

  if (!raw.baseInfo) {
    try {
      raw.baseInfo = await requestSellerBridgeDataFromBackground(normalizedSku, 'search-sku-base');
      const categoryIds = fields.category_ids;
      Object.assign(fields, buildSellerBaseInfoFields(raw.baseInfo));
      if (Array.isArray(categoryIds) && categoryIds.length > 0) fields.category_ids = categoryIds;
      if (!resolvedVariantId) {
        resolvedVariantId = String(raw.baseInfo?.variants?.[0]?.variant_id || '').trim();
      }
    } catch (error) {
      warnings.push(error?.message || String(error));
    }
  }

  if (!resolvedVariantId && !raw.baseInfo) {
    try {
      raw.baseInfo = await requestSellerBridgeDataFromBackground(normalizedSku, 'search-sku-base');
      const categoryIds = fields.category_ids;
      Object.assign(fields, buildSellerBaseInfoFields(raw.baseInfo));
      if (Array.isArray(categoryIds) && categoryIds.length > 0) fields.category_ids = categoryIds;
      resolvedVariantId = String(raw.baseInfo?.variants?.[0]?.variant_id || '').trim();
    } catch (error) {
      warnings.push(error?.message || String(error));
    }
  }

  if (resolvedVariantId) {
    try {
      raw.variant = await requestSellerBridgeDataFromBackground(normalizedSku, 'variant_v2', resolvedVariantId);
      const variantImages = normalizeSellerImages(raw.variant?.item?.images, raw.variant?.images);
      if (variantImages.length === 0 && !raw.baseInfo) {
        try {
          raw.baseInfo = await requestSellerBridgeDataFromBackground(normalizedSku, 'search-sku-base');
        } catch (error) {
          warnings.push(error?.message || String(error));
        }
      }
    } catch (error) {
      warnings.push(error?.message || String(error));
      variantApiType = 'variant';
    }
  } else {
    variantApiType = 'variant';
  }

  if (!raw.variant && variantApiType === 'variant') {
    try {
      const variantResponse = await requestSellerBridgeDataFromBackground(normalizedSku, 'variant');
      raw.variant = Array.isArray(variantResponse?.items) && variantResponse.items.length > 0
        ? variantResponse.items[0]
        : null;
    } catch (error) {
      warnings.push(error?.message || String(error));
    }
  }

  if (raw.variant) {
    Object.assign(fields, buildSellerVariantFields(raw.variant, { variantMode: variantApiType }));
  }
  raw.variantId = resolvedVariantId;
  raw.variantApiType = variantApiType;

  return { fields, raw, warnings };
}

function buildSellerCollectedProductFieldsFromPool(item = {}) {
  const raw = item?.raw && typeof item.raw === 'object' ? item.raw : {};
  const fields = {};
  const warnings = Array.isArray(item?.warnings) ? [...item.warnings] : [];
  if (raw.sales) {
    Object.assign(fields, buildSellerSalesFields(raw.sales));
    if (hasFilledValue(raw.salesMeta?.updateDate)) fields.salesUpdateDate = raw.salesMeta.updateDate;
    if (hasFilledValue(raw.salesMeta?.totals)) fields.salesTotals = raw.salesMeta.totals;
    if (hasFilledValue(raw.salesMeta?.benchmark)) fields.salesBenchmark = raw.salesMeta.benchmark;
  }
  if (raw.baseInfo) {
    const categoryIds = fields.category_ids;
    Object.assign(fields, buildSellerBaseInfoFields(raw.baseInfo));
    if (Array.isArray(categoryIds) && categoryIds.length > 0) fields.category_ids = categoryIds;
  }
  if (raw.variant) {
    Object.assign(fields, buildSellerVariantFields(raw.variant, { variantMode: raw.variantApiType || 'variant_v2' }));
  }
  fields.seller_source_shop_id = item.source_shop_id || '';
  fields.seller_source_shop_name = item.source_shop_name || '';
  fields.seller_source_company_id = item.source_company_id || '';
  raw.variantId = raw.variantId || '';
  raw.poolSource = {
    shopId: item.source_shop_id || null,
    shopName: item.source_shop_name || '',
    companyId: item.source_company_id || '',
    durationMs: Number(item.duration_ms || 0)
  };
  return { fields, raw, warnings };
}

function normalizeBaseProductPayload(product = {}) {
  if (!product || typeof product !== 'object') return null;
  const sku = String(product.sku || product.product_id || product.productId || '').trim();
  if (!sku) return null;
  const images = normalizeSellerImages(product.images, product.productImage, product.mainImage, product.image);
  const title = cleanText(product.productTitle || product.name || product.title || '');
  const rawPrice = firstFilledValue(product, ['price', 'productPrice', 'sell_price', 'cardPrice']);
  const price = normalizeSellerPrice(rawPrice);
  const payload = {
    sku,
    product_id: String(product.product_id || product.productId || sku).trim(),
    productLink: product.productLink || product.productUrl || product.url || '',
    productUrl: product.productUrl || product.productLink || product.url || ''
  };
  if (title) {
    payload.productTitle = title;
    payload.name = title;
  }
  if (price !== '') {
    payload.price = price;
    payload.webPrice = normalizeSellerPrice(product.webPrice) || price;
    payload.productPrice = price;
    payload.sell_price = price;
    payload.cardPrice = price;
  }
  if (hasFilledValue(product.originalPrice)) payload.originalPrice = normalizeSellerPrice(product.originalPrice) || product.originalPrice;
  payload.priceCurrency = 'CNY';
  payload.currency = 'CNY';
  if (images.length > 0) {
    payload.images = images;
    payload.productImage = images[0];
    payload.mainImage = images[0];
  }
  return payload;
}

function normalizeBaseProductMap(products) {
  const result = new Map();
  for (const item of Array.isArray(products) ? products : []) {
    const normalized = normalizeBaseProductPayload(item);
    if (normalized?.sku && !result.has(normalized.sku)) result.set(normalized.sku, normalized);
  }
  return result;
}

function applyFirstFilled(target, key, sources) {
  if (hasFilledValue(target[key])) return;
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    if (hasFilledValue(source[key])) {
      target[key] = source[key];
      return;
    }
  }
}

function buildSellerOnlyCollectedProductPayload(sku, sellerResult, baseProduct = null) {
  const normalizedSku = String(sku || '').trim();
  const fields = sellerResult?.fields && typeof sellerResult.fields === 'object' ? sellerResult.fields : {};
  const raw = sellerResult?.raw && typeof sellerResult.raw === 'object' ? sellerResult.raw : {};
  const base = normalizeBaseProductPayload(baseProduct) || {};
  const baseVariant = Array.isArray(raw.baseInfo?.variants) ? raw.baseInfo.variants[0] : null;
  const variantItem = raw.variant?.item && typeof raw.variant.item === 'object' ? raw.variant.item : null;
  const payload = {
    ...fields,
    ...base,
    id: normalizedSku,
    sku: normalizedSku,
    product_id: base.product_id || normalizedSku,
    productLink: base.productLink || buildOzonProductUrl(normalizedSku),
    productUrl: base.productUrl || buildOzonProductUrl(normalizedSku),
    data_source: 'ozon_plugin_seller_auto_collect',
    process_status: 'pending',
    collectedAt: new Date().toISOString(),
    sellerFallback: {
      variantId: raw.variantId || fields.variantId || '',
      variantApiType: raw.variantApiType || '',
      salesUpdateDate: raw.salesMeta?.updateDate || fields.salesUpdateDate || '',
      warnings: sellerResult?.warnings || []
    }
  };
  const sources = [variantItem, baseVariant, raw.variant, raw.sales, fields];
  applySellerCommissionFields(payload, ...sources);
  const titleKeys = ['name', 'title', 'productTitle', 'product_title', 'displayName', 'display_name'];
  const priceKeys = ['price', 'marketing_price', 'marketingPrice', 'cardPrice', 'card_price', 'currentPrice', 'current_price'];
  const resolvedTitle = selectSellerTitle(sources, titleKeys);
  const resolvedPrice = sources.map((source) => normalizeSellerPrice(firstFilledValue(source, priceKeys))).find(hasFilledValue) || '';
  if (!hasFilledValue(payload.productTitle) && resolvedTitle) {
    payload.name = resolvedTitle;
    payload.productTitle = resolvedTitle;
  } else {
    applyFirstFilled(payload, 'name', sources);
    applyFirstFilled(payload, 'productTitle', sources);
  }
  if (!hasFilledValue(payload.productTitle) && hasFilledValue(payload.name)) {
    payload.productTitle = payload.name;
  }
  if (!hasFilledValue(payload.name) && hasFilledValue(payload.productTitle)) {
    payload.name = payload.productTitle;
  }
  if (!hasFilledValue(payload.price) && resolvedPrice !== '') {
    payload.price = resolvedPrice;
    payload.productPrice = resolvedPrice;
    payload.sell_price = resolvedPrice;
    payload.cardPrice = resolvedPrice;
  }
  const payloadPrice = normalizeSellerPrice(firstFilledValue(payload, ['price', 'productPrice', 'sell_price', 'cardPrice']));
  if (payloadPrice !== '') {
    payload.price = payloadPrice;
    if (!hasFilledValue(payload.webPrice)) payload.webPrice = payloadPrice;
    if (!hasFilledValue(payload.productPrice)) payload.productPrice = payloadPrice;
    if (!hasFilledValue(payload.sell_price)) payload.sell_price = payloadPrice;
    if (!hasFilledValue(payload.cardPrice)) payload.cardPrice = payloadPrice;
  }
  const images = normalizeSellerImages(
    variantItem?.primary_image,
    variantItem?.images,
    raw.variant?.primary_image,
    raw.variant?.images,
    baseVariant?.main_image,
    baseVariant?.images,
    baseVariant?.secondary_images,
    baseVariant?.image,
    baseVariant?.imageUrl,
    baseVariant?.image_url,
    raw.sales?.photo,
    raw.sales?.image,
    raw.sales?.imageUrl,
    raw.sales?.image_url
  );
  if ((!Array.isArray(payload.images) || payload.images.length === 0) && images.length > 0) {
    payload.images = images;
    payload.productImage = images[0];
    payload.mainImage = images[0];
  } else {
    applyFirstFilled(payload, 'productImage', sources);
  }
  const mainImage = String(payload.productImage || payload.mainImage || payload.images?.find(Boolean) || '').trim();
  payload.productImage = mainImage;
  payload.mainImage = mainImage;
  payload.images = mainImage ? [mainImage] : [];
  return payload;
}

function buildCollectedProductDisplayPayload(payload = {}) {
  const keys = [
    'id',
    'sku',
    'product_id',
    'productTitle',
    'name',
    'title',
    'variantName',
    'brand',
    'brandId',
    'category',
    'category_ids',
    'category1',
    'category1Id',
    'category2Id',
    'category3',
    'category3Id',
    'category_commission',
    'commissions',
    'fbo_rate',
    'fbs_rate',
    'rfbs_rate',
    'commission',
    'commission_percent',
    'commissionPercent',
    'commission_rate',
    'commissionRate',
    'price',
    'productPrice',
    'sell_price',
    'cardPrice',
    'webPrice',
    'originalPrice',
    'priceCurrency',
    'currency',
    'avgPrice',
    'minSellerPrice',
    'productImage',
    'mainImage',
    'primary_image',
    'photo',
    'images',
    'productLink',
    'productUrl',
    'link',
    'bundle_id',
    'variantId',
    'origin_variant_id',
    'offer_id',
    'barcode',
    'barcodes',
    'rating',
    'description_type_name',
    'description_type_dict_value',
    'description_category_id',
    'new_description_category_id',
    'type_id',
    'salesSchema',
    'sources',
    'soldCount',
    'soldSum',
    'soldSumRub',
    'soldSumCny',
    'gmvSum',
    'avgGmv',
    'avgGmvOnAccDays',
    'avgGmvOnAccDaysCny',
    'avgOrdersOnAccDays',
    'sumMissedGmv',
    'salesDynamics',
    'drr',
    'daysInPromo',
    'discount',
    'promoRevenueShare',
    'daysWithTrafarets',
    'sessionCount',
    'convToCart',
    'qtyViewPdp',
    'views',
    'hitsView',
    'hits_view',
    'convToCartPdp',
    'sessionCountSearch',
    'convToCartSearch',
    'convViewToOrder',
    'custom_click_rate',
    'pdpToCartConversion',
    'nullableRedemptionRate',
    'nullableCreateDate',
    'createDays',
    'localIndex',
    'bin',
    'sellerId',
    'sellerName',
    'article',
    'priceIndex',
    'price_index',
    'minPrice',
    'min_price',
    'stock',
    'fbsStock',
    'fboStock',
    'cbStock',
    'retailStock',
    'sumItemsInStock',
    'daysInStock',
    'availableStock',
    'available_stock',
    'totalStock',
    'total_stock',
    'accessibility',
    'accessibilityByDays',
    'avgDeliveryDays',
    'avgDeliveryTime',
    'volume',
    'salesUpdateDate',
    'salesTotals',
    'salesBenchmark',
    'custom_weight',
    'weight_g',
    'depth',
    'width',
    'height',
    'dimensions',
    'real_dimensions',
    'custom_volume'
  ];
  const result = {};
  for (const key of keys) {
    const value = payload[key];
    if (value === undefined || value === null || value === '') continue;
    if (key === 'images' && Array.isArray(value)) {
      result.images = value.filter(Boolean).slice(0, 6);
      continue;
    }
    result[key] = value;
  }
  return result;
}

async function emitAutoCollectListProgress(tabId, progress) {
  if (!tabId || !progress || typeof progress !== 'object') return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'OZON_ERP_AUTO_COLLECT_LIST_PROGRESS',
      progress
    });
  } catch (error) {}
}

async function collectSellerOnlySkusToCollectedProducts(message, sender = null) {
  const skus = normalizeManualSkuList(message?.skus || []);
  if (skus.length === 0) {
    return { success: false, error: 'AUTO_SKU_REQUIRED', message: 'Missing SKUs for auto collection' };
  }

  const writeToErp = message?.writeToErp === true;
  const baseBySku = normalizeBaseProductMap(message?.baseProducts);
  const sourceTabId = sender?.tab?.id || message?.sourceTabId || null;
  const results = [];
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(Number(message?.concurrency || 3), 3));
  const poolResponse = await fetchLocalPluginJson('/collector-seller-pool/collect', {
    method: 'POST',
    body: { skus },
    timeoutMs: 120000
  }).catch(() => null);
  const poolAttempted = Array.isArray(poolResponse?.results);
  const poolWorkerCount = Number(poolResponse?.worker_count || poolResponse?.data?.worker_count || 0);
  const poolBySku = new Map((poolAttempted ? poolResponse.results : [])
    .filter((item) => item?.sku)
    .map((item) => [String(item.sku), item]));
  async function collectOne(sku) {
    try {
      const poolItem = poolBySku.get(String(sku));
      const poolWarning = poolItem?.warnings?.filter(Boolean)?.[0] || poolItem?.error || '';
      const collectionRoute = poolItem?.success
        ? {
            mode: 'pool',
            workerCount: poolWorkerCount,
            shopName: poolItem.source_shop_name || '',
            companyId: poolItem.source_company_id || '',
            durationMs: Number(poolItem.duration_ms || 0),
            status: Number(poolItem.status || 200)
          }
        : {
            mode: 'browser_fallback',
            workerCount: poolWorkerCount,
            shopName: '',
            companyId: '',
            durationMs: Number(poolItem?.duration_ms || 0),
            status: Number(poolItem?.status || 0),
            warning: poolWarning || (poolAttempted ? 'Seller pool did not return usable data' : 'Seller pool unavailable')
          };
      let sellerResult;
      if (poolItem?.success) {
        sellerResult = buildSellerCollectedProductFieldsFromPool(poolItem);
      } else {
        sellerResult = await fetchSellerCollectedProductFields(sku);
        if (poolWarning) {
          sellerResult.warnings = [`Seller pool fallback: ${poolWarning}`, ...(sellerResult.warnings || [])];
        }
      }
      const payload = buildSellerOnlyCollectedProductPayload(sku, sellerResult, baseBySku.get(sku));
      if (!payload.sku || Object.keys(sellerResult.fields || {}).length === 0) {
        throw new Error((sellerResult.warnings || []).filter(Boolean)[0] || 'seller did not return usable fields');
      }
      if (!writeToErp) {
        const item = {
          sku,
          success: true,
          imported: false,
          previewOnly: true,
          product: buildCollectedProductDisplayPayload(payload),
          collectDate: new Date().toISOString().slice(0, 10),
          source: 'seller_preview',
          collectionRoute
        };
        results.push(item);
        await emitAutoCollectListProgress(sourceTabId, item);
        return;
      }
      const importResult = await importCollectedProductPayloadToErpDb(payload, message?.syncContext);
      if (importResult?.success) {
        const item = {
          sku,
          success: true,
          imported: true,
          product: buildCollectedProductDisplayPayload(payload),
          collectDate: new Date().toISOString().slice(0, 10),
          importResult,
          collectionRoute
        };
        results.push(item);
        await emitAutoCollectListProgress(sourceTabId, item);
      } else {
        const item = {
          sku,
          success: false,
          error: importResult?.message || importResult?.error || 'Failed to write collected product',
          collectionRoute
        };
        results.push(item);
        await emitAutoCollectListProgress(sourceTabId, item);
      }
    } catch (error) {
      const item = { sku, success: false, error: error?.message || String(error) };
      results.push(item);
      await emitAutoCollectListProgress(sourceTabId, item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, skus.length) }, async () => {
    while (cursor < skus.length) {
      const sku = skus[cursor++];
      await collectOne(sku);
    }
  }));

  const successCount = results.filter((item) => item.success).length;
  return {
    success: successCount > 0,
    total: skus.length,
    successCount,
    failCount: skus.length - successCount,
    results
  };
}

function normalizeManualSkuList(value) {
  const source = Array.isArray(value) ? value.join('\n') : String(value || '');
  return Array.from(
    new Set(
      source
        .split(/[\s,，;；]+/g)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function buildOzonProductUrl(sku) {
  return `${OZON_PRODUCT_BASE_URL}/${encodeURIComponent(String(sku || '').trim())}/`;
}

async function emitManualCollectProgress(progress) {
  const payload = {
    type: 'OZON_ERP_MANUAL_COLLECT_PROGRESS',
    progress: progress && typeof progress === 'object' ? progress : {}
  };
  try {
    await chrome.runtime.sendMessage(payload);
  } catch (error) {}
}

async function getManualCollectProgressState() {
  const stored = await chrome.storage.local.get([MANUAL_PROGRESS_STORAGE_KEY]);
  const state = stored?.[MANUAL_PROGRESS_STORAGE_KEY];
  if (!state || typeof state !== 'object') {
    return {
      active: false,
      summary: '',
      items: []
    };
  }
  return {
    active: state.active === true,
    summary: String(state.summary || ''),
    items: Array.isArray(state.items) ? state.items.filter((item) => item && typeof item === 'object') : []
  };
}

async function saveManualCollectProgressState(state) {
  await chrome.storage.local.set({
    [MANUAL_PROGRESS_STORAGE_KEY]: {
      active: state?.active === true,
      summary: String(state?.summary || ''),
      items: Array.isArray(state?.items) ? state.items : [],
      updatedAt: Date.now()
    }
  });
}

function buildManualCollectSummary(items, fallback = '') {
  const safeItems = Array.isArray(items) ? items : [];
  if (safeItems.length === 0) return fallback;
  const successCount = safeItems.filter((item) => item?.status === 'success').length;
  const errorCount = safeItems.filter((item) => item?.status === 'error').length;
  const runningCount = safeItems.filter((item) => item?.status === 'running').length;
  return `Batch collecting: done ${successCount}, failed ${errorCount}, running ${runningCount}, total ${safeItems.length}`;
}

async function persistManualCollectProgress(progress, options = {}) {
  const sku = String(progress?.sku || '').trim();
  const current = await getManualCollectProgressState();
  const items = Array.isArray(current.items) ? current.items.slice() : [];
  if (sku) {
    const nextItem = {
      sku,
      status: String(progress?.status || 'running'),
      text: String(progress?.text || sku)
    };
    const index = items.findIndex((item) => String(item?.sku || '').trim() === sku);
    if (index >= 0) items[index] = nextItem;
    else items.push(nextItem);
  }
  const summary = String(options.summary || buildManualCollectSummary(items, current.summary || ''));
  await saveManualCollectProgressState({
    active: options.active === undefined ? true : options.active === true,
    summary,
    items
  });
}

async function collectManualDetailSkus(message) {
  const skus = normalizeManualSkuList(message?.skus || []);
  if (skus.length === 0) {
    return { success: false, error: 'MANUAL_SKU_REQUIRED', message: 'Please enter SKU first' };
  }

  await saveManualCollectProgressState({
    active: true,
    summary: `Preparing to collect ${skus.length} SKU...`,
    items: skus.map((sku) => ({
      sku,
      status: 'pending',
      text: `Waiting: ${sku}`
    }))
  });

  const results = [];
  for (const sku of skus) {
    await persistManualCollectProgress({
      sku,
      status: 'running',
      text: `Collecting: ${sku}`
    });
    await emitManualCollectProgress({
      sku,
      status: 'running',
      text: `Collecting: ${sku}`
    });
    try {
      if (message?.forceCollect !== true) {
        const cacheResult = await lookupCollectedProductCache(sku, message?.syncContext).catch((error) => ({
          success: false,
          error: error?.message || String(error)
        }));
        if (cacheResult?.success && cacheResult.data?.found && cacheResult.data?.needsRefresh === false) {
          results.push({
            sku,
            success: true,
            cached: true,
            needsRefresh: false,
            product: cacheResult.data.product || null
          });
          await persistManualCollectProgress({
            sku,
            status: 'success',
            text: `Used ERP collected data: ${sku}`
          });
          await emitManualCollectProgress({
            sku,
            status: 'success',
            text: `Used ERP collected data: ${sku}`
          });
          continue;
        }
        if (cacheResult?.success && cacheResult.data?.found && cacheResult.data?.needsRefresh) {
          await persistManualCollectProgress({
            sku,
            status: 'running',
            text: `Needs refresh collection: ${sku}`
          });
          await emitManualCollectProgress({
            sku,
            status: 'running',
            text: `Needs refresh collection: ${sku}`
          });
        }
      }
      const tab = await chrome.tabs.create({ url: buildOzonProductUrl(sku), active: false });
      await waitForTabReady(tab.id);
      const response = await sendMessageToTabWithRetry(tab.id, {
        type: 'OZON_ERP_COLLECT_LIST_PAYLOAD_FROM_DETAIL',
        expectedSku: sku
      });
      const payload = response?.payload || response?.data?.payload || null;
      if (response?.success && payload) {
        const importResult = await importCollectedProductPayloadToErpDb(payload, message?.syncContext, { requireTenant: true });
        if (importResult?.success) {
          results.push({ sku, success: true, tabId: tab.id, imported: true, importResult });
          await persistManualCollectProgress({
            sku,
            status: 'success',
            text: `Done: ${sku}`
          });
          await emitManualCollectProgress({
            sku,
            status: 'success',
            text: `Done: ${sku}`
          });
        } else {
          const errorMessage = importResult?.message || importResult?.error || 'Failed to write collected product';
          results.push({ sku, success: false, tabId: tab.id, error: errorMessage });
          await persistManualCollectProgress({
            sku,
            status: 'error',
            text: `Failed: ${sku} - ${errorMessage}`
          });
          await emitManualCollectProgress({
            sku,
            status: 'error',
            text: `Failed: ${sku} - ${errorMessage}`
          });
        }
      } else {
        const errorMessage = response?.message || response?.error || 'Detail page collection failed';
        results.push({ sku, success: false, tabId: tab.id, error: errorMessage });
        await persistManualCollectProgress({
          sku,
          status: 'error',
          text: `Failed: ${sku} - ${errorMessage}`
        });
        await emitManualCollectProgress({
          sku,
          status: 'error',
          text: `Failed: ${sku} - ${errorMessage}`
        });
      }
    } catch (error) {
      const errorMessage = error?.message || String(error);
      results.push({ sku, success: false, error: errorMessage });
      await persistManualCollectProgress({
        sku,
        status: 'error',
        text: `Failed: ${sku} - ${errorMessage}`
      });
      await emitManualCollectProgress({
        sku,
        status: 'error',
        text: `Failed: ${sku} - ${errorMessage}`
      });
    }
  }

  const successCount = results.filter((item) => item.success).length;
  await saveManualCollectProgressState({
    active: false,
    summary: `Collected products written: ${successCount} succeeded, ${skus.length - successCount} failed`,
    items: (await getManualCollectProgressState()).items
  });
  return {
    success: successCount > 0,
    total: skus.length,
    successCount,
    failCount: skus.length - successCount,
    results
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'OZON_ERP_SELLER_AUTH_SYNC') {
    const isSellerTab = /^https:\/\/seller\.ozon\.ru\//i.test(String(sender?.tab?.url || ''));
    if (!isSellerTab) {
      sendResponse({ success: false, pending: true, ignored: true, error: 'SELLER_TAB_REQUIRED' });
      return false;
    }
    if (!sellerAuthSyncPromise) {
      sellerAuthSyncPromise = syncPendingSellerAuthBinding(message.companyId, sender)
        .finally(() => { sellerAuthSyncPromise = null; });
    }
    sellerAuthSyncPromise
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === 'CHECK_SELLER_TAB') return withResponse(checkSellerTab(), sendResponse);
  if (message?.type === 'OPEN_NEW_TAB') return withResponse(chrome.tabs.create({ url: message.url }), sendResponse);
  if (message?.type === 'TEST_SELLER_TAB_COMMUNICATION') return withResponse(testSellerTabCommunication(), sendResponse);
  if (message?.type === 'REFRESH_SELLER_TAB') return withResponse(refreshSellerTab(), sendResponse);
  if (message?.type === 'CROSS_TAB_OZON_REQUEST') return withResponse(crossTabOzonRequest(message, sender), sendResponse);
  if (message?.type === 'OZON_ERP_MEDIA_UPLOAD') return withResponse(crossTabOzonMediaUpload(message, sender), sendResponse);
  if (message?.type === 'OZON_ERP_FBP_FILL_REQUEST') return withResponse(runFbpFillTask(message), sendResponse);
  if (message?.type === 'OZON_ERP_RUN_SERVER_PUBLISH_MEDIA_SIDECAR') return withResponse(runServerPublishMediaSidecar({ force: true, ...(message.options || {}) }), sendResponse);
  if (message?.type === 'OZON_ERP_COLLECT_MANUAL_DETAIL_SKUS') return withResponse(collectManualDetailSkus(message), sendResponse);
  if (message?.type === 'OZON_ERP_AUTO_COLLECT_LIST_SKUS') {
    return withResponse(collectSellerOnlySkusToCollectedProducts({ ...message, writeToErp: false }, sender), sendResponse);
  }
  if (message?.type === 'OZON_ERP_COLLECTED_PRODUCT_LOOKUP') {
    return withResponse(lookupCollectedProductCache(message.sku, message.syncContext), sendResponse);
  }
  if (message?.type === 'OZON_ERP_COLLECTED_PRODUCTS_LOOKUP_BATCH') {
    return withResponse(lookupCollectedProductCaches(message.skus, message.syncContext), sendResponse);
  }

  if (message?.type === 'OZON_ERP_INJECT_ACTIVE_OZON_FRONT') {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async ([tab]) => {
        if (!tab?.id || !isOzonFrontUrl(tab.url)) return { success: false, error: 'Current tab is not an Ozon front page' };
        if (await hasOzonContentScript(tab.id)) return { success: true, alreadyLoaded: true };
        const injected = await injectOzonFrontContent(tab.id, tab.url, 'manual');
        const loaded = injected ? await hasOzonContentScript(tab.id) : false;
        return { success: Boolean(injected && loaded), injected, loaded };
      })
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === 'OZON_ERP_LOCAL_PLUGIN_FETCH') {
    let url = null;
    try {
      url = new URL(message.url);
    } catch (error) {
      sendResponse({ success: false, error: 'Invalid local API URL' });
      return false;
    }

    Promise.resolve(String(message.erpBaseUrl || '').trim())
      .then((rawErpBaseUrl) => (rawErpBaseUrl ? normalizeErpBaseUrl(rawErpBaseUrl) : getErpBaseUrl()))
      .then(async (erpBaseUrl) => {
        if (!isAllowedLocalPluginUrl(url.toString(), erpBaseUrl)) {
          sendResponse({ success: false, error: 'Only local plugin API under current ERP config is allowed' });
          return null;
        }
        const nextOptions = message.options && typeof message.options === 'object' ? { ...message.options } : {};
        const nextHeaders = nextOptions.headers && typeof nextOptions.headers === 'object' ? { ...nextOptions.headers } : {};
        const pluginToken = await getLocalPluginToken();
        if (pluginToken) {
          nextHeaders['x-local-plugin-token'] = pluginToken;
        }
        let tenantId = String(nextHeaders['x-tenant-id'] || nextHeaders['X-Tenant-Id'] || '').trim();
        if (!tenantId) {
          tenantId = await resolveErpTenantId(erpBaseUrl);
        }
        if (!tenantId) {
          tenantId = 'admin';
        }
        if (!tenantId) {
          sendResponse({
            success: false,
            error: 'ERP_TENANT_REQUIRED',
            message: 'ERP tenant required before manual collect'
          });
          return null;
        }
        nextHeaders['x-tenant-id'] = tenantId;
        await cacheErpTenantId(tenantId, erpBaseUrl);
        nextOptions.headers = nextHeaders;
        return fetchWithTimeout(url.toString(), nextOptions, Number(message.timeoutMs || nextOptions.timeoutMs || 15000));
      })
      .then(async (res) => {
        if (!res) return;
        const text = await res.text();
        sendResponse({
          success: true,
          ok: res.ok,
          status: res.status,
          responseText: text
        });
      })
      .catch((error) => {
        console.error('Local plugin fetch error in background script:', error);
        sendResponse({
          success: false,
          error: error?.message || String(error)
        });
      });
    return true;
  }

  if (message?.type === 'OZON_ERP_API_FETCH') {
    let url = null;
    try {
      url = new URL(message.url);
    } catch (error) {
      sendResponse({ success: false, error: 'Invalid ERP API URL' });
      return false;
    }

    Promise.resolve(String(message.erpBaseUrl || '').trim())
      .then((rawErpBaseUrl) => (rawErpBaseUrl ? normalizeErpBaseUrl(rawErpBaseUrl) : getErpBaseUrl()))
      .then(async (erpBaseUrl) => {
        if (!isAllowedErpApiUrl(url.toString(), erpBaseUrl)) {
          sendResponse({ success: false, error: 'Only API under current ERP config is allowed' });
          return null;
        }
        const nextOptions = message.options && typeof message.options === 'object' ? { ...message.options } : {};
        const nextHeaders = nextOptions.headers && typeof nextOptions.headers === 'object' ? { ...nextOptions.headers } : {};
        let tenantId = String(nextHeaders['x-tenant-id'] || nextHeaders['X-Tenant-Id'] || '').trim();
        if (!tenantId) tenantId = await resolveErpTenantId(erpBaseUrl);
        if (!tenantId) tenantId = 'admin';
        nextHeaders['x-tenant-id'] = tenantId;
        nextOptions.headers = nextHeaders;
        await cacheErpTenantId(tenantId, erpBaseUrl);
        return fetchWithTimeout(url.toString(), nextOptions);
      })
      .then(async (res) => {
        if (!res) return;
        const text = await res.text();
        sendResponse({
          success: true,
          ok: res.ok,
          status: res.status,
          responseText: text
        });
      })
      .catch((error) => {
        console.error('ERP API fetch error in background script:', error);
        sendResponse({
          success: false,
          error: error?.message || String(error)
        });
      });
    return true;
  }

  if (message?.type === 'OZON_ERP_GET_TAB_STATE') {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async ([tab]) => {
        if (!tab?.id) return { success: false, error: 'Current tab not found' };
        return await chrome.tabs.sendMessage(tab.id, { type: 'OZON_ERP_EXPORT_STATE' });
      })
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === 'OZON_ERP_COLLECT_ACTIVE_DETAIL') {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async ([tab]) => {
        if (!tab?.id) return { success: false, error: 'Current tab not found' };
        return await chrome.tabs.sendMessage(tab.id, { type: 'OZON_ERP_MANUAL_COLLECT_DETAIL' });
      })
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === 'OZON_ERP_OPEN_PRODUCT_EDIT_BROWSER') {
    getErpBaseUrl()
      .then((erpBaseUrl) => {
        return chrome.tabs.create({ url: resolveProductEditUrl(erpBaseUrl, message.collectionId) })
          .then((tab) => ({ tab, erpBaseUrl }));
      })
      .then(({ tab, erpBaseUrl }) => {
        const handler = (tabId, changeInfo) => {
          if (tabId !== tab.id || changeInfo.status !== 'complete') return;
          chrome.tabs.onUpdated.removeListener(handler);
          chrome.scripting.executeScript({
            target: { tabId },
            func: ({ context, legacy, collectionId, targetUrl }) => {
              localStorage.setItem('ozon_erp_product_editor_context', JSON.stringify(context));
              if (legacy) localStorage.setItem('ozon_erp_edit_product', JSON.stringify(legacy));
              else localStorage.removeItem('ozon_erp_edit_product');
              if (targetUrl && location.href !== targetUrl) location.href = targetUrl;
              else location.hash = `#/product-edit${collectionId ? `?collectionId=${encodeURIComponent(collectionId)}` : ''}`;
            },
            args: [{
              context: message.context,
              legacy: message.legacy,
              collectionId: message.collectionId,
              targetUrl: resolveProductEditUrl(erpBaseUrl, message.collectionId)
            }]
          }).catch((error) => {
            sendResponse({ success: false, error: error?.message || String(error) });
          });
        };
        chrome.tabs.onUpdated.addListener(handler);
        sendResponse({ success: true, tabId: tab.id, pending: true });
      })
      .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === 'OZON_ERP_OPEN_COLLECTOR_BOX_BROWSER') {
    getErpBaseUrl()
      .then((erpBaseUrl) => chrome.tabs.create({ url: resolveCollectorBoxUrl(erpBaseUrl, message.sku) }))
      .then((tab) => sendResponse({ success: true, tabId: tab.id }))
      .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === 'OZON_ERP_CHECK_PLUGIN_UPDATE') {
    checkPluginUpdateStatus()
      .then((plugin) => sendResponse({ success: true, plugin }))
      .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ozonInjectionAttemptAtByTabId.delete(tabId);
  ozonInjectionBlockedByTabId.delete(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(PLUGIN_UPDATE_ALARM_NAME, { periodInMinutes: 60 });
  scheduleServerPublishMediaSidecar();
  checkPluginUpdateStatus().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(PLUGIN_UPDATE_ALARM_NAME, { periodInMinutes: 60 });
  scheduleServerPublishMediaSidecar();
  checkPluginUpdateStatus().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === PLUGIN_UPDATE_ALARM_NAME) {
    checkPluginUpdateStatus().catch(() => {});
    return;
  }
  if (alarm?.name === SERVER_PUBLISH_MEDIA_SIDECAR_ALARM_NAME) {
    runServerPublishMediaSidecar().catch(() => {});
  }
});
