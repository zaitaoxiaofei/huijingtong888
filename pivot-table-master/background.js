const ERP_BASE_URL_KEY = 'pivot-erp-base-url';
const ERP_TENANT_ID_KEY = 'pivot-erp-tenant-id';
const POLLING_ENABLED_KEY = 'pivot-erp-polling-enabled';
const DEFAULT_ERP_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_TENANT_ID = 'admin';
const POLL_INTERVAL_MS = 3000;
const BATCH_SIZE = 6;
const MAX_CONCURRENT_REQUESTS = 4;
const TARGET_URL_FILTER = {
  urls: [
    'https://seller.ozon.ru/api/site/seller-analytics/charts/v3/table/totals*',
    'https://seller.ozon.ru/api/site/seller-analytics/charts/v3/table/by_sku*',
    'https://seller.ozon.ru/api/site/seller-analytics/charts/v3/abc*'
  ]
};

const headerCache = new Map();
const injectedTabs = new Set();
const latestContextHeadersByTab = new Map();
const panelState = {
  running: false,
  sellerTab: null,
  sellerMissing: false,
  lastPollAt: null,
  lastError: '',
  claimed: 0,
  completed: 0,
  failed: 0,
  active: 0,
  pollingEnabled: false,
  pollIntervalMs: POLL_INTERVAL_MS,
  queue: [],
  logs: []
};
let pollTimer = null;
let polling = false;

function setActionBadge(text, color, title = 'Ozon ERP 采集') {
  if (!chrome?.action) return;
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title });
}

function updateActionBadge() {
  if (panelState.sellerMissing) {
    setActionBadge('!', '#dc2626', '未找到 seller.ozon.ru/app/analytics 页面');
    return;
  }
  if (panelState.pollingEnabled) {
    setActionBadge('ON', '#16a34a', '轮询已开启');
    return;
  }
  setActionBadge('OFF', '#64748b', '轮询已暂停');
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeErpBaseUrl(value) {
  const raw = String(value || '').trim() || DEFAULT_ERP_BASE_URL;
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/api\/?$/i, '').replace(/\/+$/, '');
    return trimTrailingSlash(url.toString());
  } catch (error) {
    return DEFAULT_ERP_BASE_URL;
  }
}

async function getErpConfig() {
  const stored = await chrome.storage.local.get([ERP_BASE_URL_KEY, ERP_TENANT_ID_KEY]);
  return {
    erpBaseUrl: normalizeErpBaseUrl(stored[ERP_BASE_URL_KEY]),
    tenantId: String(stored[ERP_TENANT_ID_KEY] || DEFAULT_TENANT_ID).trim() || DEFAULT_TENANT_ID
  };
}

async function saveErpConfig(patch = {}) {
  const next = {};
  if (patch.erpBaseUrl !== undefined) next[ERP_BASE_URL_KEY] = normalizeErpBaseUrl(patch.erpBaseUrl);
  if (patch.tenantId !== undefined) next[ERP_TENANT_ID_KEY] = String(patch.tenantId || DEFAULT_TENANT_ID).trim() || DEFAULT_TENANT_ID;
  await chrome.storage.local.set(next);
  return getErpConfig();
}

function logPanel(message, level = 'info') {
  panelState.logs.unshift({
    level,
    message: String(message || ''),
    time: new Date().toISOString()
  });
  panelState.logs = panelState.logs.slice(0, 30);
}

async function getNextCollectRequests() {
  const config = await getErpConfig();
  const response = await fetch(`${config.erpBaseUrl}/api/local-plugin/seller-analytics/collect-runs/next?limit=${BATCH_SIZE}`, {
    method: 'GET',
    headers: {
      'x-tenant-id': config.tenantId
    }
  });
  const json = await response.json();
  if (!response.ok || json?.success === false) throw new Error(json?.error || `HTTP ${response.status}`);
  return Array.isArray(json.requests) ? json.requests : (json.request ? [json.request] : []);
}

async function postCollectResult(request, payload) {
  const config = await getErpConfig();
  const headerSnapshot = takeHeaderSnapshot(payload.request_url || request.request_url, payload.request_method || request.request_method);
  const response = await fetch(`${config.erpBaseUrl}/api/local-plugin/seller-analytics/collect-runs/${encodeURIComponent(request.run_id)}/requests/${encodeURIComponent(request.request_id)}/result`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-id': config.tenantId
    },
    body: JSON.stringify({
      ...payload,
      request_headers: headerSnapshot?.request_headers || payload.request_headers,
      response_headers: headerSnapshot?.response_headers || payload.response_headers,
      response_status: headerSnapshot?.response_status || payload.response_status,
      tenant_id: config.tenantId
    })
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {}
  if (!response.ok || json?.success === false) throw new Error(json?.error || text || `HTTP ${response.status}`);
  return json;
}

async function findSellerAnalyticsTab() {
  const tabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/app/analytics*' });
  const tab = tabs.find((item) => item.id && /\/app\/analytics/.test(String(item.url || ''))) || null;
  panelState.sellerTab = tab ? { id: tab.id, title: tab.title || '', url: tab.url || '' } : null;
  panelState.sellerMissing = !tab;
  if (tab && panelState.lastError === '未找到 seller.ozon.ru/app/analytics 页面') {
    panelState.lastError = '';
  }
  updateActionBadge();
  return tab;
}

async function ensureRelayInjected(tabId) {
  if (injectedTabs.has(tabId)) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/erp-relay-page.js'],
    world: 'MAIN'
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/erp-relay-bridge.js']
  });
  injectedTabs.add(tabId);
}

function getHeaderValue(headers = {}, name = '') {
  const target = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key || '').toLowerCase() === target) return String(value || '').trim();
  }
  return '';
}

async function runCollectRequestInSellerTab(request, existingTab) {
  const tab = existingTab || await findSellerAnalyticsTab();
  if (!tab?.id) {
    return { success: false, error: '请先打开并登录 seller.ozon.ru/app/analytics 页面' };
  }
  await ensureRelayInjected(tab.id);
  const erpCompanyId = getHeaderValue(request.request_headers, 'x-o3-company-id');
  const sellerCompanyId = getHeaderValue(latestContextHeadersByTab.get(tab.id), 'x-o3-company-id');
  if (erpCompanyId && sellerCompanyId && erpCompanyId !== sellerCompanyId) {
    return {
      success: false,
      error: `店铺不一致：ERP 下发 ${erpCompanyId}，seller 页面当前 ${sellerCompanyId}`
    };
  }
  const result = await chrome.tabs.sendMessage(tab.id, {
    type: 'PIVOT_ERP_ANALYTICS_EXECUTE_REQUEST',
    request
  });
  if (result?.success === false) return { success: false, error: result.error || '采集请求执行失败' };
  return result?.payload || { success: false, error: 'EMPTY_COLLECT_RESULT' };
}

async function processCollectRequest(request, tab) {
  panelState.active += 1;
  panelState.queue = panelState.queue.map((item) => (
    item.request_id === request.request_id ? { ...item, status: 'running' } : item
  ));
  try {
    const result = await runCollectRequestInSellerTab(request, tab);
    await postCollectResult(request, result);
    if (result?.success === false) {
      panelState.failed += 1;
      logPanel(`${request.source_label || request.source_key} ${request.endpoint_type} 失败：${result.error || '请求失败'}`, 'error');
    } else {
      panelState.completed += 1;
      logPanel(`${request.source_label || request.source_key} ${request.endpoint_type} 已回传`, 'success');
    }
  } catch (error) {
    panelState.failed += 1;
    panelState.lastError = error?.message || String(error);
    logPanel(`${request.source_label || request.source_key} ${request.endpoint_type} 异常：${panelState.lastError}`, 'error');
    try {
      await postCollectResult(request, { success: false, error: panelState.lastError });
    } catch (postError) {
      logPanel(`失败状态回写失败：${postError?.message || postError}`, 'error');
    }
  } finally {
    panelState.active = Math.max(0, panelState.active - 1);
    panelState.queue = panelState.queue.filter((item) => item.request_id !== request.request_id);
  }
}

async function runWithConcurrency(items, limit, run) {
  const workers = Array.from({ length: Math.min(limit, items.length) }, async (_, workerIndex) => {
    for (let index = workerIndex; index < items.length; index += limit) {
      await run(items[index]);
    }
  });
  await Promise.all(workers);
}

async function pollCollectOnce() {
  if (polling) return;
  polling = true;
  panelState.running = true;
  panelState.lastPollAt = new Date().toISOString();
  updateActionBadge();
  try {
    const tab = await findSellerAnalyticsTab();
    if (!tab?.id) {
      const previousError = panelState.lastError;
      panelState.lastError = '未找到 seller.ozon.ru/app/analytics 页面';
      if (previousError !== panelState.lastError) logPanel(panelState.lastError, 'error');
      return;
    }
    await ensureRelayInjected(tab.id);
    const requests = await getNextCollectRequests();
    if (requests.length === 0) {
      panelState.lastError = '';
      return;
    }
    panelState.claimed += requests.length;
    panelState.queue = requests.map((request) => ({
      request_id: request.request_id,
      source_label: request.source_label || request.source_key,
      endpoint_type: request.endpoint_type,
      page_index: request.page_index || 0,
      status: 'pending'
    }));
    logPanel(`领取 ${requests.length} 个采集任务`);
    await runWithConcurrency(requests, MAX_CONCURRENT_REQUESTS, (request) => processCollectRequest(request, tab));
  } catch (error) {
    panelState.lastError = error?.message || String(error);
    logPanel(panelState.lastError, 'error');
  } finally {
    panelState.running = false;
    polling = false;
    updateActionBadge();
  }
}

async function setPollingEnabled(enabled) {
  const nextEnabled = Boolean(enabled);
  panelState.pollingEnabled = nextEnabled;
  await chrome.storage.local.set({ [POLLING_ENABLED_KEY]: nextEnabled });
  if (!nextEnabled && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    logPanel('已停止轮询');
  }
  updateActionBadge();
}

async function startPolling(runNow = true) {
  await setPollingEnabled(true);
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      void pollCollectOnce();
    }, POLL_INTERVAL_MS);
    logPanel('已启动轮询，3 秒一次', 'success');
  }
  if (runNow) void pollCollectOnce();
}

async function stopPolling() {
  await setPollingEnabled(false);
}

async function initializePolling() {
  const stored = await chrome.storage.local.get(POLLING_ENABLED_KEY);
  panelState.pollingEnabled = stored[POLLING_ENABLED_KEY] === true;
  if (panelState.pollingEnabled) await startPolling(false);
  await findSellerAnalyticsTab();
  updateActionBadge();
}

function normalizeHeaderList(headers = []) {
  const result = {};
  for (const header of headers || []) {
    const key = String(header?.name || '').toLowerCase();
    if (!key) continue;
    result[key] = String(header?.value || '');
  }
  return result;
}

function pickSellerContextHeaders(headers = {}) {
  const result = {};
  for (const key of ['accept', 'accept-language', 'x-o3-app-name', 'x-o3-company-id', 'x-o3-language', 'x-o3-page-type']) {
    if (headers[key]) result[key] = headers[key];
  }
  return result;
}

function headerCacheKey(url, method) {
  return `${String(method || 'GET').toUpperCase()} ${String(url || '')}`;
}

function getOrCreateHeaderEntry(details) {
  const key = headerCacheKey(details.url, details.method);
  const current = headerCache.get(key) || {};
  const next = {
    ...current,
    request_url: details.url,
    request_method: String(details.method || 'GET').toUpperCase(),
    updated_at: Date.now()
  };
  headerCache.set(key, next);
  return next;
}

function cleanupHeaderCache() {
  const now = Date.now();
  for (const [key, value] of headerCache.entries()) {
    if (now - Number(value.updated_at || 0) > 60000) headerCache.delete(key);
  }
}

function takeHeaderSnapshot(url, method) {
  cleanupHeaderCache();
  const key = headerCacheKey(url, method);
  const direct = headerCache.get(key);
  if (direct) {
    headerCache.delete(key);
    return direct;
  }
  return null;
}

async function getPanelStatus() {
  const config = await getErpConfig();
  const stored = await chrome.storage.local.get(POLLING_ENABLED_KEY);
  panelState.pollingEnabled = stored[POLLING_ENABLED_KEY] === true;
  await findSellerAnalyticsTab();
  updateActionBadge();
  return {
    config,
    state: panelState
  };
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const entry = getOrCreateHeaderEntry(details);
    entry.request_headers = normalizeHeaderList(details.requestHeaders);
    const contextHeaders = pickSellerContextHeaders(entry.request_headers);
    if (details.tabId >= 0 && contextHeaders['x-o3-company-id']) {
      latestContextHeadersByTab.set(details.tabId, contextHeaders);
    }
    entry.updated_at = Date.now();
  },
  TARGET_URL_FILTER,
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const entry = getOrCreateHeaderEntry(details);
    entry.response_headers = normalizeHeaderList(details.responseHeaders);
    entry.response_status = details.statusCode;
    entry.updated_at = Date.now();
  },
  TARGET_URL_FILTER,
  ['responseHeaders', 'extraHeaders']
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'PIVOT_ERP_PANEL_GET_STATUS') {
    getPanelStatus().then(sendResponse).catch((error) => sendResponse({ error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'PIVOT_ERP_PANEL_SAVE_CONFIG') {
    saveErpConfig(message.config || {})
      .then(() => getPanelStatus())
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'PIVOT_ERP_PANEL_POLL_NOW') {
    pollCollectOnce()
      .then(() => getPanelStatus())
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'PIVOT_ERP_PANEL_START_POLLING') {
    startPolling(true)
      .then(() => getPanelStatus())
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'PIVOT_ERP_PANEL_STOP_POLLING') {
    stopPolling()
      .then(() => getPanelStatus())
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error?.message || String(error) }));
    return true;
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId) => {
  injectedTabs.delete(tabId);
  void findSellerAnalyticsTab();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  latestContextHeadersByTab.delete(tabId);
  void findSellerAnalyticsTab();
});

chrome.runtime.onInstalled.addListener(() => {
  void initializePolling();
});
chrome.runtime.onStartup.addListener(() => {
  void initializePolling();
});
void initializePolling();
