const ERP_BASE_URL_KEY = 'pivot-erp-base-url';
const ERP_TENANT_ID_KEY = 'pivot-erp-tenant-id';
const LOCAL_PLUGIN_TOKEN_KEY = 'pivot-erp-local-plugin-token';
const LOCAL_MIRROR_BASE_URL_KEY = 'pivot-erp-local-mirror-base-url';
const POLLING_ENABLED_KEY = 'pivot-erp-polling-enabled';
const DEFAULT_ERP_BASE_URL = 'https://erp.hjt888.xyz';
const DEFAULT_TENANT_ID = 'admin';
const DEFAULT_LOCAL_PLUGIN_TOKEN = 'ozon-erp-collector-hjt888-default';
const DEFAULT_LOCAL_MIRROR_BASE_URL = 'http://127.0.0.1:8787';
const POLL_INTERVAL_MS = 1500;
const PREPARE_POLL_INTERVAL_MS = 3000;
const BATCH_SIZE = 10;
const MAX_CONCURRENT_REQUESTS = 5;
const MIN_COLLECT_DELAY_MS = 80;
const MAX_COLLECT_DELAY_MS = 1500;
const DEFAULT_COLLECT_DELAY_MS = 250;
const RATE_LIMIT_COOLDOWN_MS = 8000;
const AUTH_ERROR_COOLDOWN_MS = 3000;
const AUTH_CONTEXT_TIMEOUT_MS = 45000;
const AUTH_CONTEXT_POLL_MS = 1000;
const CONTEXT_URL_FILTER = {
  urls: [
    'https://seller.ozon.ru/api/*'
  ]
};
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
const latestAnalyticsApiByTab = new Map();
const PLUGIN_STATUS_SYNC_MIN_INTERVAL_MS = 5000;
const AUTH_BINDING_SYNC_MIN_INTERVAL_MS = 60000;
const panelState = {
  running: false,
  sellerTab: null,
  sellerMissing: false,
  currentCompanyId: '',
  lastPollAt: null,
  lastError: '',
  claimed: 0,
  completed: 0,
  failed: 0,
  active: 0,
  pollingEnabled: false,
  pollIntervalMs: POLL_INTERVAL_MS,
  rate: {
    concurrency: 3,
    delayMs: DEFAULT_COLLECT_DELAY_MS,
    lastStatus: null
  },
  queue: [],
  logs: []
};
const collectRateState = {
  concurrency: 3,
  delayMs: DEFAULT_COLLECT_DELAY_MS,
  successStreak: 0,
  errorStreak: 0,
  lastStatus: null,
  cooldownUntil: 0
};
let pollTimer = null;
let preparePollTimer = null;
let polling = false;
let preparing = false;
let lastPluginStatusSyncAt = 0;
let lastAuthBindingSyncAt = 0;

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
  const stored = await chrome.storage.local.get([ERP_BASE_URL_KEY, ERP_TENANT_ID_KEY, LOCAL_PLUGIN_TOKEN_KEY, LOCAL_MIRROR_BASE_URL_KEY]);
  return {
    erpBaseUrl: normalizeErpBaseUrl(stored[ERP_BASE_URL_KEY]),
    tenantId: String(stored[ERP_TENANT_ID_KEY] || DEFAULT_TENANT_ID).trim() || DEFAULT_TENANT_ID,
    localPluginToken: String(stored[LOCAL_PLUGIN_TOKEN_KEY] || DEFAULT_LOCAL_PLUGIN_TOKEN).trim(),
    localMirrorBaseUrl: normalizeErpBaseUrl(stored[LOCAL_MIRROR_BASE_URL_KEY] || DEFAULT_LOCAL_MIRROR_BASE_URL)
  };
}

async function saveErpConfig(patch = {}) {
  const next = {};
  if (patch.erpBaseUrl !== undefined) next[ERP_BASE_URL_KEY] = normalizeErpBaseUrl(patch.erpBaseUrl);
  if (patch.tenantId !== undefined) next[ERP_TENANT_ID_KEY] = String(patch.tenantId || DEFAULT_TENANT_ID).trim() || DEFAULT_TENANT_ID;
  if (patch.localPluginToken !== undefined) next[LOCAL_PLUGIN_TOKEN_KEY] = String(patch.localPluginToken || '').trim();
  if (patch.localMirrorBaseUrl !== undefined) next[LOCAL_MIRROR_BASE_URL_KEY] = normalizeErpBaseUrl(patch.localMirrorBaseUrl);
  await chrome.storage.local.set(next);
  return getErpConfig();
}

function localPluginHeaders(config, extraHeaders = {}) {
  const headers = {
    ...extraHeaders,
    'x-tenant-id': config.tenantId
  };
  if (config.localPluginToken) headers['x-local-plugin-token'] = config.localPluginToken;
  return headers;
}

async function getOzonCookieHeader() {
  if (!chrome?.cookies?.getAll) return '';
  const cookies = await chrome.cookies.getAll({ domain: 'seller.ozon.ru' });
  return cookies
    .filter((item) => item?.name)
    .map((item) => `${item.name}=${item.value || ''}`)
    .join('; ');
}

async function getOzonCookieInfo() {
  if (!chrome?.cookies?.getAll) return { header: '', companyId: '' };
  const cookies = await chrome.cookies.getAll({ domain: 'seller.ozon.ru' });
  const header = cookies
    .filter((item) => item?.name)
    .map((item) => `${item.name}=${item.value || ''}`)
    .join('; ');
  const byName = new Map(cookies.map((item) => [String(item?.name || ''), String(item?.value || '')]));
  const companyId = String(
    byName.get('sc_company_id') ||
    byName.get('company_id') ||
    byName.get('seller_company_id') ||
    ''
  ).trim();
  return { header, companyId };
}

function sameErpBaseUrl(left, right) {
  return normalizeErpBaseUrl(left) === normalizeErpBaseUrl(right);
}

function logPanel(message, level = 'info') {
  panelState.logs.unshift({
    level,
    message: String(message || ''),
    time: new Date().toISOString()
  });
  panelState.logs = panelState.logs.slice(0, 30);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function syncCollectRatePanel() {
  panelState.rate = {
    concurrency: collectRateState.concurrency,
    delayMs: Math.round(collectRateState.delayMs),
    lastStatus: collectRateState.lastStatus
  };
}

function currentCollectDelayMs() {
  const cooldownLeft = Math.max(0, collectRateState.cooldownUntil - Date.now());
  if (cooldownLeft > 0) return cooldownLeft;
  const jitter = Math.floor(Math.random() * 80);
  return Math.round(clampNumber(collectRateState.delayMs + jitter, MIN_COLLECT_DELAY_MS, MAX_COLLECT_DELAY_MS));
}

function currentCollectConcurrency() {
  return clampNumber(collectRateState.concurrency, 1, MAX_CONCURRENT_REQUESTS);
}

function collectStatusFromResult(result = {}) {
  const status = Number(result.response_status || result.status || result.http_status || 0);
  return Number.isFinite(status) && status > 0 ? status : 0;
}

function tuneCollectRate({ success = false, status = 0, error = '' } = {}) {
  const normalizedStatus = Number(status) || 0;
  collectRateState.lastStatus = normalizedStatus || null;
  const message = String(error || '').toLowerCase();
  const rateLimited = normalizedStatus === 429 || message.includes('429') || message.includes('rate limit');
  const authBlocked = normalizedStatus === 401 || normalizedStatus === 403 || message.includes('401') || message.includes('403');

  if (success && !rateLimited && !authBlocked) {
    collectRateState.successStreak += 1;
    collectRateState.errorStreak = 0;
    collectRateState.cooldownUntil = 0;
    collectRateState.delayMs = clampNumber(collectRateState.delayMs * 0.82, MIN_COLLECT_DELAY_MS, MAX_COLLECT_DELAY_MS);
    if (collectRateState.successStreak >= 6 && collectRateState.concurrency < MAX_CONCURRENT_REQUESTS) {
      collectRateState.concurrency += 1;
      collectRateState.successStreak = 0;
      logPanel(`Adaptive rate up: concurrency=${collectRateState.concurrency}, delay=${Math.round(collectRateState.delayMs)}ms`, 'success');
    }
    syncCollectRatePanel();
    return;
  }

  collectRateState.successStreak = 0;
  collectRateState.errorStreak += 1;
  if (rateLimited) {
    collectRateState.concurrency = 1;
    collectRateState.delayMs = MAX_COLLECT_DELAY_MS;
    collectRateState.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    logPanel('Adaptive rate down: HTTP 429, cooldown 8s', 'error');
  } else if (authBlocked) {
    collectRateState.concurrency = 1;
    collectRateState.delayMs = Math.max(collectRateState.delayMs, AUTH_ERROR_COOLDOWN_MS);
    collectRateState.cooldownUntil = Date.now() + AUTH_ERROR_COOLDOWN_MS;
    logPanel(`Adaptive rate down: auth blocked HTTP ${normalizedStatus || '-'}`, 'error');
  } else {
    collectRateState.concurrency = Math.max(1, collectRateState.concurrency - 1);
    collectRateState.delayMs = clampNumber(collectRateState.delayMs * 1.8, MIN_COLLECT_DELAY_MS, MAX_COLLECT_DELAY_MS);
    if (collectRateState.errorStreak >= 3) {
      collectRateState.cooldownUntil = Date.now() + Math.min(3000, Math.round(collectRateState.delayMs * 2));
    }
  }
  syncCollectRatePanel();
}

function currentSellerCompanyId(tabId = 0) {
  if (!tabId) return '';
  return getHeaderValue(latestContextHeadersByTab.get(tabId), 'x-o3-company-id');
}

async function syncPluginStatus(force = false) {
  const now = Date.now();
  if (!force && now - lastPluginStatusSyncAt < PLUGIN_STATUS_SYNC_MIN_INTERVAL_MS) return null;
  lastPluginStatusSyncAt = now;
  const config = await getErpConfig();
  const sellerTab = panelState.sellerTab || await findSellerAnalyticsTab() || await findAnySellerTab();
  const cookieInfo = await getOzonCookieInfo();
  const companyId = currentSellerCompanyId(sellerTab?.id) || cookieInfo.companyId;
  const response = await fetch(`${config.erpBaseUrl}/api/local-plugin/seller-analytics/plugin-status`, {
    method: 'POST',
    headers: localPluginHeaders(config, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify({
      tenant_id: config.tenantId,
      plugin_version: chrome.runtime.getManifest()?.version || '',
      seller_missing: !sellerTab?.id,
      seller_tab: sellerTab ? {
        id: sellerTab.id,
        title: sellerTab.title || '',
        url: sellerTab.url || ''
      } : null,
      current_company_id: companyId,
      latest_analytics_api: sellerTab?.id ? latestAnalyticsApiByTab.get(sellerTab.id) || null : null,
      polling_enabled: panelState.pollingEnabled,
      synced_at: new Date().toISOString(),
      synced_at_ms: now
    })
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || json?.success === false) {
    throw new Error(json?.error || `HTTP ${response.status}`);
  }
  if (companyId) {
    bindServerSideAuth(companyId, sellerTab).catch((error) => {
      logPanel(`绑定后端直连授权失败：${error?.message || error}`, 'error');
    });
  }
  return json?.data || json;
}

async function bindServerSideAuth(companyId, sellerTab = null, force = false) {
  const now = Date.now();
  if (!force && now - lastAuthBindingSyncAt < AUTH_BINDING_SYNC_MIN_INTERVAL_MS) return null;
  lastAuthBindingSyncAt = now;
  const config = await getErpConfig();
  const tab = sellerTab || await findSellerAnalyticsTab();
  const cookieInfo = await getOzonCookieInfo();
  const resolvedCompanyId = String(companyId || cookieInfo.companyId || '').trim();
  const cookie = cookieInfo.header;
  if (!cookie) throw new Error('No Ozon cookie found. Open and login seller.ozon.ru first.');
  const headers = latestContextHeadersByTab.get(tab?.id) || {};
  const response = await fetch(`${config.erpBaseUrl}/api/local-plugin/seller-analytics/auth-bindings`, {
    method: 'POST',
    headers: localPluginHeaders(config, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify({
      tenant_id: config.tenantId,
      company_id: resolvedCompanyId,
      store_id: resolvedCompanyId,
      cookie,
      headers,
      source: 'plugin-auto-bind'
    })
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || json?.success === false) throw new Error(json?.error || `HTTP ${response.status}`);
  logPanel(`后端直连授权已绑定：${companyId}`, 'success');
  return json?.data || json;
}

async function getNextCollectRequests() {
  const config = await getErpConfig();
  await syncPluginStatus(true).catch((error) => {
    logPanel(`同步插件状态失败：${error?.message || error}`, 'error');
  });
  const params = new URLSearchParams({ limit: String(BATCH_SIZE) });
  const sellerTab = panelState.sellerTab || await findSellerAnalyticsTab() || await findAnySellerTab();
  const companyId = currentSellerCompanyId(sellerTab?.id) || panelState.currentCompanyId || '';
  if (companyId) {
    params.set('store_id', companyId);
    params.set('company_id', companyId);
  }
  const response = await fetch(`${config.erpBaseUrl}/api/local-plugin/seller-analytics/collect-runs/next?${params.toString()}`, {
    method: 'GET',
    headers: localPluginHeaders(config)
  });
  const json = await response.json();
  if (!response.ok || json?.success === false) throw new Error(json?.error || `HTTP ${response.status}`);
  return Array.isArray(json.requests) ? json.requests : (json.request ? [json.request] : []);
}

async function getNextPrepareRequest() {
  const config = await getErpConfig();
  const response = await fetch(`${config.erpBaseUrl}/api/local-plugin/seller-analytics/plugin-prepare/next`, {
    method: 'GET',
    headers: localPluginHeaders(config)
  });
  const json = await response.json();
  if (!response.ok || json?.success === false) throw new Error(json?.error || `HTTP ${response.status}`);
  return json.request || json.data || null;
}

async function postPrepareResult(payload = {}) {
  const config = await getErpConfig();
  const response = await fetch(`${config.erpBaseUrl}/api/local-plugin/seller-analytics/plugin-prepare/result`, {
    method: 'POST',
    headers: localPluginHeaders(config, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify({
      ...payload,
      tenant_id: config.tenantId
    })
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || json?.success === false) throw new Error(json?.error || `HTTP ${response.status}`);
  return json?.data || json;
}

async function probeServerSideAuth(companyId = '', sellerTab = null) {
  const config = await getErpConfig();
  const tab = sellerTab || await findSellerAnalyticsTab();
  const cookieInfo = await getOzonCookieInfo();
  const resolvedCompanyId = String(companyId || currentSellerCompanyId(tab?.id) || cookieInfo.companyId || '').trim();
  const cookie = cookieInfo.header;
  const headers = latestContextHeadersByTab.get(tab?.id) || {};
  if (!cookie) throw new Error('No Ozon cookie found. Open and login seller.ozon.ru first.');
  const response = await fetch(`${config.erpBaseUrl}/api/local-plugin/seller-analytics/auth-probe`, {
    method: 'POST',
    headers: localPluginHeaders(config, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify({
      tenant_id: config.tenantId,
      company_id: resolvedCompanyId,
      cookie,
      headers
    })
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || json?.success === false) throw new Error(json?.error || `HTTP ${response.status}`);
  const result = json?.data || json;
  logPanel(`Auth probe ${result?.ok ? 'OK' : 'FAILED'} HTTP ${result?.status || '-'}`, result?.ok ? 'success' : 'error');
  return result;
}

async function postCollectResult(request, payload) {
  const config = await getErpConfig();
  const headerSnapshot = takeHeaderSnapshot(payload.request_url || request.request_url, payload.request_method || request.request_method);
  const response = await fetch(`${config.erpBaseUrl}/api/local-plugin/seller-analytics/collect-runs/${encodeURIComponent(request.run_id)}/requests/${encodeURIComponent(request.request_id)}/result`, {
    method: 'POST',
    headers: localPluginHeaders(config, {
      'Content-Type': 'application/json',
    }),
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

async function mirrorSnapshotToLocal(payload) {
  if (!payload || payload.success === false) return null;
  const config = await getErpConfig();
  if (!config.localMirrorBaseUrl || sameErpBaseUrl(config.localMirrorBaseUrl, config.erpBaseUrl)) return null;
  const response = await fetch(`${config.localMirrorBaseUrl}/api/local-plugin/seller-analytics/snapshots`, {
    method: 'POST',
    headers: localPluginHeaders(config, {
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(payload)
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
  panelState.currentCompanyId = tab?.id ? currentSellerCompanyId(tab.id) : '';
  if (tab && panelState.lastError === '未找到 seller.ozon.ru/app/analytics 页面') {
    panelState.lastError = '';
  }
  updateActionBadge();
  return tab;
}

async function findAnySellerTab() {
  const tabs = await chrome.tabs.query({ url: 'https://seller.ozon.ru/*' });
  return tabs.find((item) => item.id) || null;
}

async function ensureSellerAnalyticsGraphsTab(targetUrl = 'https://seller.ozon.ru/app/analytics/graphs') {
  const analyticsTab = await findSellerAnalyticsTab();
  const tab = analyticsTab || await findAnySellerTab();
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
    panelState.sellerTab = { id: tab.id, title: tab.title || '', url: targetUrl };
    panelState.sellerMissing = false;
    updateActionBadge();
    return { ...tab, url: targetUrl };
  }
  const created = await chrome.tabs.create({ url: targetUrl, active: true });
  panelState.sellerTab = created ? { id: created.id, title: created.title || '', url: targetUrl } : null;
  panelState.sellerMissing = !created?.id;
  updateActionBadge();
  return created;
}

async function warmSellerAnalyticsPermission(tabId) {
  if (!tabId) return null;
  await chrome.tabs.update(tabId, { url: 'https://seller.ozon.ru/app/analytics', active: true });
  await waitForTabComplete(tabId, 15000);
  await sleep(1000);
  latestAnalyticsApiByTab.delete(tabId);
  logPanel('销售漏斗页已打开，开始强制刷新以激活分析权限');
  await chrome.tabs.reload(tabId, { bypassCache: true });
  await waitForTabComplete(tabId, 20000);
  await sleep(2500);
  return { ok: true, status: 'script_ready', url: 'https://seller.ozon.ru/app/analytics', updated_at: Date.now() };
}

async function openSellerAnalyticsGraphsAfterWarmup(tabId, targetUrl) {
  if (!tabId) return null;
  const updated = await chrome.tabs.update(tabId, { url: targetUrl, active: true });
  await waitForTabComplete(tabId, 15000);
  panelState.sellerTab = { id: tabId, title: updated?.title || '', url: targetUrl };
  panelState.sellerMissing = false;
  updateActionBadge();
  return { ...(updated || {}), id: tabId, url: targetUrl };
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.id) return false;
    if (tab.status === 'complete') return true;
    await sleep(300);
  }
  return false;
}

function expectedStoreIdFromPrepare(request = {}) {
  return String(
    request.expected_store_id ||
    request.expectedStoreId ||
    request.store_id ||
    request.storeId ||
    request.company_id ||
    request.companyId ||
    ''
  ).trim();
}

function isSellerAnalyticsApiUrl(url = '') {
  const value = String(url || '');
  return /\/api\/.+(?:seller-analytics|analytics|charts|funnel|graph)/i.test(value);
}

async function waitForSellerAnalyticsDataReady(tabId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const latest = latestAnalyticsApiByTab.get(tabId);
    if (latest?.ok) {
      logPanel(`销售漏斗数据接口已加载：HTTP ${latest.status}`, 'success');
      return latest;
    }
    if (latest?.status) lastStatus = latest.status;
    await sleep(500);
  }
  const warning = lastStatus ? `销售漏斗数据接口未确认成功，最后状态 HTTP ${lastStatus}` : '销售漏斗数据接口未确认成功，继续等待身份上下文';
  logPanel(warning, 'error');
  return null;
}

async function waitForSellerAuthContext(tab, request = {}, timeoutMs = AUTH_CONTEXT_TIMEOUT_MS) {
  const expectedStoreId = expectedStoreIdFromPrepare(request);
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    await syncPluginStatus(true).catch(() => {});
    const cookieInfo = await getOzonCookieInfo();
    const observedCompanyId = String(currentSellerCompanyId(tab?.id) || cookieInfo.companyId || '').trim();
    const companyId = observedCompanyId || expectedStoreId;
    if (expectedStoreId && observedCompanyId && observedCompanyId !== expectedStoreId) {
      lastError = `STORE_MISMATCH expected=${expectedStoreId} current=${observedCompanyId}`;
      await sleep(AUTH_CONTEXT_POLL_MS);
      continue;
    }
    if (companyId && cookieInfo.header) {
      try {
        const binding = await bindServerSideAuth(companyId, tab, true);
        try {
          const probe = await probeServerSideAuth(companyId, tab);
          if (probe?.ok) {
            return {
              success: true,
              companyId,
              binding,
              probe,
              warning: observedCompanyId ? '' : 'BOUND_WITH_EXPECTED_STORE_ID'
            };
          }
          lastError = `AUTH_PROBE_HTTP_${probe?.status || 'UNKNOWN'}`;
          return {
            success: true,
            companyId,
            binding,
            probe,
            warning: observedCompanyId ? lastError : `BOUND_WITH_EXPECTED_STORE_ID; ${lastError}`
          };
        } catch (probeError) {
          lastError = probeError?.message || String(probeError);
          return {
            success: true,
            companyId,
            binding,
            warning: observedCompanyId ? `AUTH_PROBE_FAILED: ${lastError}` : `BOUND_WITH_EXPECTED_STORE_ID; AUTH_PROBE_FAILED: ${lastError}`
          };
        }
      } catch (error) {
        lastError = error?.message || String(error);
      }
    } else {
      lastError = 'WAITING_FOR_SELLER_IDENTITY';
    }
    await sleep(AUTH_CONTEXT_POLL_MS);
  }
  return { success: false, error: lastError || 'AUTH_CONTEXT_TIMEOUT' };
}

function failedPrepareOnAnalyticsPage(tab, error, warmup = null) {
  return {
    success: false,
    error: error || 'AUTH_CONTEXT_NOT_READY',
    detail: '销售漏斗页真实数据已加载，但还没有识别到当前店铺上下文，已停止跳转 graphs。',
    current_company_id: currentSellerCompanyId(tab?.id),
    latest_analytics_api: warmup,
    seller_tab: panelState.sellerTab
  };
}

async function runPrepareRequest(request) {
  const targetUrl = request?.target_url || 'https://seller.ozon.ru/app/analytics/graphs';
  let tab = await ensureSellerAnalyticsGraphsTab('https://seller.ozon.ru/app/analytics');
  if (!tab?.id) return { success: false, error: 'SELLER_TAB_OPEN_FAILED' };
  const warmup = await warmSellerAnalyticsPermission(tab.id);
  tab = await openSellerAnalyticsGraphsAfterWarmup(tab.id, targetUrl);
  if (!tab?.id) return { success: false, error: 'SELLER_GRAPHS_OPEN_FAILED', warmup };
  await waitForSellerAnalyticsDataReady(tab.id, 30000);
  await syncPluginStatus(true).catch(() => {});
  const authContext = await waitForSellerAuthContext(tab, request, 15000);
  const deadline = Date.now() + 15000;
  let companyId = currentSellerCompanyId(tab.id) || authContext.companyId || expectedStoreIdFromPrepare(request);
  while (!companyId && Date.now() < deadline) {
    await sleep(1000);
    await syncPluginStatus(true).catch(() => {});
    companyId = currentSellerCompanyId(tab.id);
  }
  return {
    success: true,
    current_company_id: companyId,
    auth_probe: authContext.probe || null,
    auth_warning: authContext.warning || authContext.error || '',
    warmup,
    seller_tab: panelState.sellerTab
  };
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
  const tab = existingTab || await findSellerAnalyticsTab() || await findAnySellerTab();
  if (!tab?.id) {
    return { success: false, error: '请先打开并登录 seller.ozon.ru 页面' };
  }
  await ensureRelayInjected(tab.id);
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
  let rateTuned = false;
  try {
    const delayMs = currentCollectDelayMs();
    logPanel(`限速等待 ${Math.round(delayMs / 1000)} 秒后采集 ${request.source_label || request.source_key} 第 ${(request.page_index || 0) + 1} 页`);
    await sleep(delayMs);
    const result = await runCollectRequestInSellerTab(request, tab);
    const responseStatus = collectStatusFromResult(result);
    const collectSuccess = result?.success !== false && (!responseStatus || responseStatus < 400);
    tuneCollectRate({ success: collectSuccess, status: responseStatus, error: result?.error || '' });
    rateTuned = true;
    await postCollectResult(request, result);
    mirrorSnapshotToLocal(result).catch((error) => {
      logPanel(`Local mirror write failed: ${error?.message || error}`, 'error');
    });
    if (result?.success === false) {
      panelState.failed += 1;
      logPanel(`${request.source_label || request.source_key} ${request.endpoint_type} 失败：${result.error || '请求失败'}`, 'error');
    } else {
      panelState.completed += 1;
      logPanel(`${request.source_label || request.source_key} ${request.endpoint_type} 已回传`, 'success');
    }
  } catch (error) {
    if (!rateTuned) {
      tuneCollectRate({ success: false, error: error?.message || String(error) });
    }
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
    const tab = await findSellerAnalyticsTab() || await findAnySellerTab();
    if (!tab?.id) {
      const previousError = panelState.lastError;
      panelState.lastError = '未找到 seller.ozon.ru 页面';
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
    const concurrency = currentCollectConcurrency();
    logPanel(`Collect batch ${requests.length}, concurrency=${concurrency}, delay=${Math.round(collectRateState.delayMs)}ms`);
    await runWithConcurrency(requests, concurrency, (request) => processCollectRequest(request, tab));
  } catch (error) {
    panelState.lastError = error?.message || String(error);
    logPanel(panelState.lastError, 'error');
  } finally {
    panelState.running = false;
    polling = false;
    updateActionBadge();
  }
}

async function pollPrepareOnce() {
  if (preparing) return;
  preparing = true;
  try {
    const request = await getNextPrepareRequest();
    if (!request?.id) return;
    logPanel(`Prepare seller analytics page: ${request.expected_store_id || 'store'}`);
    const result = await runPrepareRequest(request);
    await postPrepareResult(result);
    await syncPluginStatus(true).catch(() => {});
  } catch (error) {
    panelState.lastError = error?.message || String(error);
    logPanel(panelState.lastError, 'error');
    try {
      await postPrepareResult({ success: false, error: panelState.lastError });
    } catch (postError) {}
  } finally {
    preparing = false;
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
  await syncPluginStatus(true).catch(() => {});
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
  if (!preparePollTimer) {
    preparePollTimer = setInterval(() => {
      void pollPrepareOnce();
    }, PREPARE_POLL_INTERVAL_MS);
  }
  if (runNow) void pollCollectOnce();
  if (runNow) void pollPrepareOnce();
}

function stopPreparePolling() {
  if (!preparePollTimer) return;
  clearInterval(preparePollTimer);
  preparePollTimer = null;
}

async function stopPolling() {
  stopPreparePolling();
  await setPollingEnabled(false);
}

async function initializePolling() {
  const stored = await chrome.storage.local.get(POLLING_ENABLED_KEY);
  panelState.pollingEnabled = stored[POLLING_ENABLED_KEY] !== false;
  if (panelState.pollingEnabled) await startPolling(false);
  await findSellerAnalyticsTab();
  await syncPluginStatus(true).catch(() => {});
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

function rememberSellerAnalyticsApiResult(details) {
  if (details.tabId < 0 || !isSellerAnalyticsApiUrl(details.url)) return;
  latestAnalyticsApiByTab.set(details.tabId, {
    url: details.url,
    status: details.statusCode,
    ok: Number(details.statusCode || 0) >= 200 && Number(details.statusCode || 0) < 300,
    updated_at: Date.now()
  });
}

async function getPanelStatus() {
  const config = await getErpConfig();
  const stored = await chrome.storage.local.get(POLLING_ENABLED_KEY);
  panelState.pollingEnabled = stored[POLLING_ENABLED_KEY] !== false;
  await findSellerAnalyticsTab();
  panelState.currentCompanyId = panelState.sellerTab?.id ? currentSellerCompanyId(panelState.sellerTab.id) : '';
  await syncPluginStatus(true).catch(() => {});
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
      syncPluginStatus().catch(() => {});
    }
    entry.updated_at = Date.now();
  },
  CONTEXT_URL_FILTER,
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const entry = getOrCreateHeaderEntry(details);
    entry.request_headers = normalizeHeaderList(details.requestHeaders);
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
    rememberSellerAnalyticsApiResult(details);
    entry.updated_at = Date.now();
  },
  CONTEXT_URL_FILTER,
  ['responseHeaders', 'extraHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const entry = getOrCreateHeaderEntry(details);
    entry.response_headers = normalizeHeaderList(details.responseHeaders);
    entry.response_status = details.statusCode;
    rememberSellerAnalyticsApiResult(details);
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
  if (message?.type === 'PIVOT_ERP_PANEL_AUTH_PROBE') {
    probeServerSideAuth()
      .then((result) => getPanelStatus().then((status) => ({ ...status, authProbe: result })))
      .then(sendResponse)
      .catch((error) => sendResponse({ error: error?.message || String(error) }));
    return true;
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId) => {
  injectedTabs.delete(tabId);
  void findSellerAnalyticsTab();
  void syncPluginStatus().catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  latestContextHeadersByTab.delete(tabId);
  latestAnalyticsApiByTab.delete(tabId);
  void findSellerAnalyticsTab();
  void syncPluginStatus(true).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  void initializePolling();
});
chrome.runtime.onStartup.addListener(() => {
  void initializePolling();
});
void initializePolling();
