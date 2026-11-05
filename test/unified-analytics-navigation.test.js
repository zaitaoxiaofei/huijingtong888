import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync('ozon-erp-collector-plugin/analytics/background.js', 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const analyticsUrl = 'https://seller.ozon.ru/app/analytics';
const graphsUrl = `${analyticsUrl}/graphs`;

function harness({ tab = {}, updateError = '', cookieCompany = '1001', pageCompany = '1001', reloadPending = false, noTabs = false } = {}) {
  const current = { id: 7, title: 'Actual Seller tab', url: 'https://seller.ozon.ru/app/products', status: 'complete', ...tab };
  const calls = { update: [], reload: [], create: [] };
  const timers = new Map();
  let now = 100000, timerId = 0;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const event = () => ({ addListener() {}, removeListener() {} });
  const chrome = {
    runtime: { id: 'unified', getManifest: () => ({ version: '1.5.1' }), onMessage: event(), onInstalled: event(), onStartup: event() },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    tabs: {
      query: async () => noTabs ? [] : [{ ...current }], get: async () => ({ ...current }),
      update: async (id, changes) => {
        calls.update.push({ id, changes });
        if (updateError) throw new Error(updateError);
        if (current.pendingUrl === changes.url) throw new Error('Navigation rejected.');
        current.pendingUrl = changes.url;
        return { ...current };
      },
      reload: async id => { calls.reload.push(id); if (reloadPending) current.pendingUrl = current.url; },
      create: async changes => { calls.create.push(changes); throw new Error('Unexpected new tab'); },
      onUpdated: event(), onRemoved: event()
    },
    webRequest: { onBeforeSendHeaders: event(), onHeadersReceived: event() },
    cookies: { getAllCookieStores: async () => [{ id: 'store', tabIds: [7] }], getAll: async () => [{ name: 'sc_company_id', value: cookieCompany }] },
    scripting: { executeScript: async () => [{ result: { companyId: pageCompany } }] }
  };
  const context = vm.createContext({ chrome, URL, AbortController, Date: ClockDate,
    OzonUnifiedConfig: { get: async () => ({ erpBaseUrl: 'https://erp.hjt888.xyz', tenantId: 'tenant', localPluginToken: '' }) },
    setTimeout(run, delay) { const id = ++timerId; timers.set(id, { run, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 1, clearInterval() {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { ok: false, status: 403 } }) })
  });
  vm.runInContext(fs.readFileSync('ozon-erp-collector-plugin/unified-runtime.js', 'utf8'), context);
  vm.runInContext(source.replace('})(globalThis);', 'global.__navigation = { ensureSellerAnalyticsGraphsTab, navigateSellerTab, warmSellerAnalyticsPermission, openSellerAnalyticsGraphsAfterWarmup, runPrepareRequest, panelState };\n})(globalThis);'), context);
  return { current, calls, api: context.__navigation, runtime: context.OzonUnifiedRuntime,
    commit(url = current.pendingUrl) { current.url = url; current.status = 'complete'; delete current.pendingUrl; },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); }
      await flush();
    }
  };
}

test('real generated ensure waits for the first navigation commit before warmup, avoiding the duplicate update rejection', async () => {
  const h = harness();
  let loaded, completed = false;
  const preparing = h.api.ensureSellerAnalyticsGraphsTab(analyticsUrl, { ...h.current }).then(async tab => {
    loaded = tab;
    await h.api.warmSellerAnalyticsPermission(tab.id);
    completed = true;
  });
  await flush();
  assert.equal(h.calls.update.length, 1);
  assert.equal(h.current.status, 'complete');
  assert.equal(h.current.pendingUrl, analyticsUrl);
  assert.equal(loaded, undefined);
  assert.equal(h.calls.reload.length, 0);
  h.commit(`${analyticsUrl}/?view=funnel#summary`);
  await h.advance(250);
  assert.equal(loaded.url, `${analyticsUrl}/?view=funnel#summary`);
  assert.equal(h.api.panelState.sellerTab.url, loaded.url);
  assert.equal(h.calls.update.length, 1);
  assert.equal(h.calls.reload.length, 0);
  await h.advance(1000);
  assert.equal(h.calls.reload.length, 1);
  await h.advance(2500);
  await preparing;
  assert.equal(completed, true);
  assert.equal(h.calls.update.length, 1);
});

test('real generated navigation reuses a matching pending navigation but requires pending to clear and actual status complete', async () => {
  const h = harness({ tab: { pendingUrl: analyticsUrl } });
  let completed = false;
  const pending = h.api.navigateSellerTab(7, analyticsUrl, 'warm_analytics').then(tab => { completed = true; return tab; });
  await flush();
  assert.equal(h.calls.update.length, 0);
  assert.equal(completed, false);
  h.current.url = analyticsUrl;
  await h.advance(250);
  assert.equal(completed, false);
  delete h.current.pendingUrl;
  h.current.status = 'loading';
  await h.advance(250);
  assert.equal(completed, false);
  h.current.status = 'complete';
  await h.advance(250);
  assert.equal((await pending).url, analyticsUrl);
});

test('real generated graph opening returns the actual completed URL and never reports a different path as ready', async () => {
  const h = harness({ tab: { url: `${graphsUrl}/?source=ozon#chart` } });
  const loaded = await h.api.openSellerAnalyticsGraphsAfterWarmup(7, graphsUrl);
  assert.equal(loaded.url, h.current.url);
  assert.equal(h.api.panelState.sellerTab.url, h.current.url);
  assert.equal(h.calls.update.length, 0);
  const other = harness({ tab: { pendingUrl: analyticsUrl } });
  const pending = other.api.navigateSellerTab(7, analyticsUrl, 'warm_analytics');
  const rejected = assert.rejects(pending, /SELLER_NAVIGATION_TIMEOUT/);
  await flush();
  other.commit('https://seller.ozon.ru/login');
  await other.advance(15000);
  await rejected;
  assert.equal(other.calls.update.length, 0);
});

test('real generated hard navigation rejection is reported once without retry, reload or replacement tab', async () => {
  const h = harness({ updateError: 'Navigation rejected.' });
  await assert.rejects(h.api.navigateSellerTab(7, analyticsUrl, 'warm_analytics'), /SELLER_NAVIGATION_FAILED stage=warm_analytics tab=7: Navigation rejected\./);
  assert.equal(h.calls.update.length, 1);
  assert.equal(h.calls.reload.length, 0);
  assert.equal(h.calls.create.length, 0);
});

test('real generated navigation rejects foreign targets before either update or new-tab creation', async () => {
  for (const target of ['https://foreign.example/app/analytics', 'http://seller.ozon.ru/app/analytics', 'javascript:alert(1)']) {
    const h = harness({ noTabs: true });
    await assert.rejects(h.api.navigateSellerTab(7, target, 'open_graphs'), /SELLER_NAVIGATION_TARGET_NOT_ALLOWED/);
    await assert.rejects(h.api.ensureSellerAnalyticsGraphsTab(target), /SELLER_NAVIGATION_TARGET_NOT_ALLOWED/);
    assert.equal(h.calls.update.length, 0);
    assert.equal(h.calls.create.length, 0);
    assert.equal(h.calls.reload.length, 0);
  }
});

test('real generated warmup reload timeout never opens graphs or reports readiness from an old complete page', async () => {
  const h = harness({ tab: { url: analyticsUrl }, reloadPending: true });
  let ready = false;
  const preparing = h.api.warmSellerAnalyticsPermission(7).then(async () => {
    await h.api.openSellerAnalyticsGraphsAfterWarmup(7, graphsUrl);
    ready = true;
  });
  const rejected = assert.rejects(preparing, /SELLER_NAVIGATION_FAILED stage=reload_analytics tab=7: SELLER_NAVIGATION_TIMEOUT/);
  await flush();
  await h.advance(1000);
  assert.equal(h.calls.reload.length, 1);
  assert.equal(h.current.status, 'complete');
  assert.equal(h.current.pendingUrl, analyticsUrl);
  assert.equal(h.calls.update.length, 0);
  await h.advance(20000);
  await rejected;
  assert.equal(ready, false);
  assert.equal(h.calls.update.length, 0);
  assert.equal(h.calls.create.length, 0);
});

test('real generated preparation timeout blocks warmup and returns its shared gate while real identity conflicts never navigate', async () => {
  const h = harness();
  const preparing = h.api.runPrepareRequest({ expected_store_id: '1001', target_url: graphsUrl });
  const rejected = assert.rejects(preparing, /SELLER_NAVIGATION_FAILED stage=open_analytics tab=7: SELLER_NAVIGATION_TIMEOUT/);
  await flush();
  assert.equal(h.calls.update.length, 1);
  assert.equal(h.runtime.tryAcquireCollectorTab(7), null);
  await h.advance(15000);
  await rejected;
  await flush();
  assert.equal(h.calls.reload.length, 0);
  assert.equal(h.calls.update.length, 1);
  assert.equal(h.calls.create.length, 0);
  const release = h.runtime.tryAcquireCollectorTab(7);
  assert.equal(typeof release, 'function');
  release();
  const conflict = harness({ cookieCompany: '1002' });
  const result = await conflict.api.runPrepareRequest({ expected_store_id: '1001' });
  assert.equal(result.success, false);
  assert.equal(result.identity_code, 'identity_conflict');
  assert.equal(conflict.calls.update.length, 0);
  assert.equal(conflict.calls.reload.length, 0);
});
