import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync('pivot-table-master/background.js', 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const never = () => new Promise(() => {});

function panelHarness(options = {}) {
  const stored = {};
  const timers = new Map();
  const calls = { identity: 0, heartbeat: 0 };
  let nextTimer = 0;
  let listener;
  const context = {
    panelRefreshPromise: null, panelRefreshEpoch: 0, panelRefreshTabId: 0,
    preferredSellerStoreId: '', POLLING_ENABLED_KEY: 'polling',
    ERP_BASE_URL_KEY: 'base', ERP_TENANT_ID_KEY: 'tenant', LOCAL_PLUGIN_TOKEN_KEY: 'token',
    DEFAULT_TENANT_ID: 'admin', DEFAULT_LOCAL_PLUGIN_TOKEN: '',
    panelState: { logs: [], currentCompanyId: '', sellerTab: null },
    tabs: [{ id: 1, url: 'https://seller.ozon.ru/app/analytics/graphs' }],
    normalizeErpBaseUrl: (value) => value || 'https://erp.hjt888.xyz',
    rememberPluginToken() {}, redactDiagnosticMessage: (value) => value, safePanelLog: (value) => value,
    updateActionBadge() {}, logPanel() {},
    selectSellerTab: (tabs) => tabs[0] || null,
    verifiedSellerStoreIdentity: async (tab) => { calls.identity++; return options.identity ? options.identity(tab) : { companyId: 'shop-a' }; },
    syncPluginStatus: async () => { calls.heartbeat++; if (options.heartbeat) return options.heartbeat(); },
    setPanelSellerTab(tab) { context.panelState.sellerTab = tab; },
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    chrome: {
      runtime: { onMessage: { addListener(callback) { listener = callback; } } },
      storage: { local: {
        get: async () => stored,
        set: async (value) => { if (options.storageError) throw new Error(options.storageError); Object.assign(stored, value); }
      } },
      tabs: { query: async () => context.tabs }
    }
  };
  vm.runInNewContext(
    section('async function getErpConfig(', 'function localPluginHeaders(')
    + section('async function fetchPluginStatusJson(', 'chrome.webRequest.onBeforeSendHeaders')
    + section('chrome.runtime.onMessage.addListener(', 'chrome.tabs.onUpdated.addListener(')
    + '\nglobalThis.invalidate = invalidatePanelRefresh;', context
  );
  return {
    context, stored, calls,
    request: (message) => new Promise((resolve) => listener(message, {}, resolve)),
    expire() { for (const callback of [...timers.values()]) callback(); }
  };
}

for (const stalled of ['identity', 'heartbeat']) {
  test(`local status and save respond while ${stalled} is stalled`, { timeout: 1000 }, async () => {
    const harness = panelHarness({ [stalled]: never });
    const initial = await harness.request({ type: 'PIVOT_ERP_PANEL_GET_STATUS' });
    assert.equal(initial.config.tenantId, 'admin');
    await tick();
    await harness.request({ type: 'PIVOT_ERP_PANEL_GET_STATUS' });
    await harness.request({ type: 'PIVOT_ERP_PANEL_GET_STATUS' });
    assert.equal(harness.calls.identity, 1);
    const saved = await harness.request({ type: 'PIVOT_ERP_PANEL_SAVE_CONFIG', config: { localPluginToken: 'local-test-token' } });
    assert.equal(harness.stored.token, 'local-test-token');
    assert.equal(saved.config.localPluginToken, 'local-test-token');
  });
}

test('storage failure is reported without starting remote synchronization', async () => {
  const harness = panelHarness({ storageError: 'storage write failed' });
  const result = await harness.request({ type: 'PIVOT_ERP_PANEL_SAVE_CONFIG', config: { tenantId: 'admin' } });
  assert.equal(result.error, 'storage write failed');
  assert.equal(harness.calls.identity, 0);
  assert.equal(harness.calls.heartbeat, 0);
});

test('expired probes stay singleflight and an invalidated old shop cannot replace a new shop', async () => {
  let finishOldProbe;
  const harness = panelHarness({ identity: (tab) => tab.id === 1
    ? new Promise((resolve) => { finishOldProbe = resolve; })
    : Promise.resolve({ companyId: 'shop-b' }) });
  await harness.request({ type: 'PIVOT_ERP_PANEL_GET_STATUS' });
  await tick();
  harness.expire();
  const expired = await harness.request({ type: 'PIVOT_ERP_PANEL_GET_STATUS' });
  assert.match(expired.state.lastError, /状态读取超时/);
  assert.equal(harness.calls.identity, 1);
  harness.context.tabs = [{ id: 2, url: 'https://seller.ozon.ru/app/analytics/graphs' }];
  const refreshing = await harness.request({ type: 'PIVOT_ERP_PANEL_GET_STATUS', forceRefresh: true });
  assert.equal(refreshing.state.currentCompanyId, '');
  await tick();
  assert.equal(harness.context.panelState.currentCompanyId, 'shop-b');
  assert.equal(harness.context.panelState.lastError, '');
  finishOldProbe({ companyId: 'shop-a' });
  await tick();
  assert.equal(harness.context.panelState.currentCompanyId, 'shop-b');
  assert.equal(harness.calls.heartbeat, 1);
});

test('task claiming still verifies the live page and rejects a real store conflict', async () => {
  let probes = 0;
  let network = 0;
  const context = {
    document: { cookie: 'sc_company_id=shop-b' },
    chrome: { scripting: { executeScript: async ({ func }) => { probes++; return [{ result: func() }]; } } },
    getOzonCookieInfo: async () => ({ companyId: 'shop-b' }),
    currentSellerCompanyId: () => 'shop-a',
    preferredSellerStoreId: 'shop-b', findAnySellerTab: async () => ({ id: 1 }),
    panelState: {}, logPanel() {}, fetch: async () => { network++; },
  };
  const claim = vm.runInNewContext(
    section('async function readSellerPageCompanyId(', 'async function syncPluginStatus(')
    + section('async function getNextCollectRequests(', 'async function getNextPrepareRequest(')
    + '\ngetNextCollectRequests', context
  );
  assert.equal((await claim()).length, 0);
  assert.equal(probes, 1);
  assert.equal(network, 0);
  assert.match(context.panelState.lastError, /STORE_CONTEXT_MISMATCH/);
});

test('an invalidated display heartbeat cannot restore its old tab after a delayed config read', async () => {
  let finishConfigRead;
  let valid = true;
  let panelWrites = 0;
  let identityReads = 0;
  const sync = vm.runInNewContext(section('async function syncPluginStatus(', 'async function bindServerSideAuth(') + '\nsyncPluginStatus', {
    lastPluginStatusSyncAt: 0, PLUGIN_STATUS_SYNC_MIN_INTERVAL_MS: 30000,
    getErpConfig: () => new Promise((resolve) => { finishConfigRead = resolve; }),
    setPanelSellerTab: () => { panelWrites++; },
    verifiedSellerStoreIdentity: async () => { identityReads++; return { companyId: 'shop-a' }; }
  });
  const pending = sync(true, { id: 1 }, () => valid);
  valid = false;
  finishConfigRead({ erpBaseUrl: 'https://erp.hjt888.xyz' });
  await pending;
  assert.equal(panelWrites, 0);
  assert.equal(identityReads, 0);
});

for (const stalled of ['fetch', 'body']) {
  test(`heartbeat ${stalled} is aborted within its deadline`, async () => {
    let expire;
    let started;
    let cleared = false;
    const ready = new Promise((resolve) => { started = resolve; });
    const request = vm.runInNewContext(section('async function fetchPluginStatusJson(', 'function panelStatusSnapshot(') + '\nfetchPluginStatusJson', {
      AbortController,
      setTimeout(callback, delay) { assert.equal(delay, 15000); expire = callback; return 1; },
      clearTimeout() { cleared = true; },
      fetch: async (url, { signal }) => {
        const wait = () => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
          started();
        });
        return stalled === 'fetch' ? wait() : { json: wait };
      }
    });
    const pending = request('https://erp.hjt888.xyz/api/local-plugin/seller-analytics/plugin-status', {});
    await ready;
    expire();
    await assert.rejects(pending, /状态同步超时/);
    assert.equal(cleared, true);
  });
}
