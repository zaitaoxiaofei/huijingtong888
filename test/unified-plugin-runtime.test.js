import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const root = 'ozon-erp-collector-plugin/';
const read = (name) => fs.readFileSync(root + name, 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function runtimeHarness() {
  const timers = new Map();
  let next = 0;
  const badges = [];
  const context = { chrome: { action: { setBadgeText: (value) => badges.push(value.text), setBadgeBackgroundColor() {}, setTitle() {} } },
    setTimeout(callback) { timers.set(++next, callback); return next; }, clearTimeout(id) { timers.delete(id); } };
  vm.runInNewContext(read('unified-runtime.js'), context);
  return { runtime: context.OzonUnifiedRuntime, timers, badges };
}

test('analytics navigation waits for collector claims and holds its gate until actual completion', async () => {
  const h = runtimeHarness();
  const release = h.runtime.tryAcquireCollectorTab(7);
  let entered = false, finish;
  const pending = h.runtime.withAnalyticsPreparation(async () => { entered = true; await new Promise((resolve) => { finish = resolve; }); });
  await flush();
  assert.equal(entered, false);
  assert.equal(h.runtime.tryAcquireCollectorTab(8), null);
  release(); await flush();
  assert.equal(entered, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.runtime.tryAcquireCollectorTab(7), null);
  finish(); await pending; await flush();
  assert.equal(typeof h.runtime.tryAcquireCollectorTab(7), 'function');
});

test('gate timeout only rejects waiting navigation and update badge retains priority', async () => {
  const h = runtimeHarness();
  const release = h.runtime.tryAcquireCollectorTab(7);
  let entered = false;
  const pending = h.runtime.withAnalyticsPreparation(async () => { entered = true; });
  for (const expire of [...h.timers.values()]) expire();
  await assert.rejects(pending, (error) => error.code === 'SELLER_TAB_BUSY');
  assert.equal(entered, false);
  assert.equal(h.runtime.tryAcquireCollectorTab(7), null);
  release();
  h.runtime.setCollectorBadge({ text: 'NEW', color: '#d97706' });
  h.runtime.setAnalyticsBadge({ text: 'ON', color: '#00ff00' });
  h.runtime.setAnalyticsBadge({ text: 'OFF' });
  assert.equal(h.badges.at(-1), 'NEW');
  h.runtime.setCollectorBadge({ text: '' });
  assert.equal(h.badges.at(-1), '');
});

test('a timed out legacy collector wait never starts after preparation finishes', async () => {
  const h = runtimeHarness();
  let finishPreparation, ran = false;
  const preparing = h.runtime.withAnalyticsPreparation(() => new Promise((resolve) => { finishPreparation = resolve; }));
  await flush();
  const pending = h.runtime.withCollectorTab(7, async () => { ran = true; });
  for (const expire of [...h.timers.values()]) expire();
  await assert.rejects(pending, (error) => error.code === 'SELLER_TAB_BUSY');
  finishPreparation(); await preparing; await flush();
  assert.equal(ran, false);
});

test('the real browser worker gates claim and keeps navigation blocked until its task report completes', async () => {
  const h = runtimeHarness();
  let finishPreparation;
  const initialPreparation = h.runtime.withAnalyticsPreparation(() => new Promise((resolve) => { finishPreparation = resolve; }));
  await flush();
  let claims = 0, finishFields, fieldsStarted;
  const ready = new Promise((resolve) => { fieldsStarted = resolve; });
  const context = { URL, AbortController, crypto: { randomUUID: () => 'instance' }, setTimeout, clearTimeout };
  vm.runInNewContext(read('collector-browser-worker.js'), context);
  const client = context.OzonCollectorBrowserPool.create({
    coordination: h.runtime,
    chrome: {
      runtime: { getManifest: () => ({ version: '1.5.0' }) },
      storage: { local: { get: async () => ({ 'ozon-erp-collector-browser-instance': 'instance' }), set: async () => {} } },
      tabs: { query: async () => [{ id: 7, url: 'https://seller.ozon.ru/app/analytics/graphs' }] },
      cookies: { getAllCookieStores: async () => [{ id: 'store', tabIds: [7] }], getAll: async () => [{ name: 'sc_company_id', value: '1001' }] },
      scripting: { executeScript: async () => [{ result: '1001' }] }
    },
    getContext: async () => ({ erpBaseUrl: 'https://erp.hjt888.xyz', tenantId: 'tenant-a', token: 'key' }),
    fetch: async (url) => ({ ok: true, status: 200, json: async () => {
      if (!url.endsWith('/claim')) return { success: true };
      claims++;
      return { success: true, task: { task_id: 'task', sku: 'sku', company_id: '1001', lease_token: 'lease', lease_expires_at: new Date(Date.now() + 90000).toISOString() } };
    } }),
    collectFields: async () => { fieldsStarted(); return new Promise((resolve) => { finishFields = resolve; }); },
    buildPayload: (sku, value) => ({ sku, ...value.fields }), buildDisplay: (value) => value,
    requestInTab: async () => {}, emit: async () => {}
  });
  await client.tick();
  assert.equal(claims, 0);
  finishPreparation(); await initialPreparation; await flush();
  await client.tick(); await ready;
  assert.equal(claims, 1);
  let navigated = false;
  const nextPreparation = h.runtime.withAnalyticsPreparation(async () => { navigated = true; });
  await flush();
  assert.equal(navigated, false);
  finishFields({ fields: { soldCount: 7 }, raw: {}, warnings: [] });
  await nextPreparation;
  assert.equal(navigated, true);
});

test('empty or rejected browser claims release the shared collector tab gate', async () => {
  for (const rejected of [false, true]) {
    const h = runtimeHarness();
    const context = { URL, AbortController, setTimeout, clearTimeout };
    vm.runInNewContext(read('collector-browser-worker.js'), context);
    let claims = 0;
    const client = context.OzonCollectorBrowserPool.create({
      coordination: h.runtime,
      chrome: {
        runtime: { getManifest: () => ({ version: '1.5.0' }) },
        storage: { local: { get: async () => ({ 'ozon-erp-collector-browser-instance': 'instance' }) } },
        tabs: { query: async () => [{ id: 7, url: 'https://seller.ozon.ru/app/analytics/graphs' }] },
        cookies: { getAllCookieStores: async () => [{ id: 'store', tabIds: [7] }], getAll: async () => [{ name: 'sc_company_id', value: '1001' }] },
        scripting: { executeScript: async () => [{ result: '1001' }] }
      },
      getContext: async () => ({ erpBaseUrl: 'https://erp.hjt888.xyz', tenantId: 'tenant-a', token: 'key' }),
      fetch: async (url) => {
        if (url.endsWith('/claim')) { claims++; if (rejected) throw new Error('offline'); }
        return { ok: true, status: 200, json: async () => ({ success: true, task: null }) };
      }
    });
    await client.tick();
    assert.equal(claims, 1);
    let prepared = false;
    await h.runtime.withAnalyticsPreparation(async () => { prepared = true; });
    assert.equal(prepared, true);
  }
});

function dualBackground(options = {}) {
  const listeners = [], requests = [], imports = [];
  const stored = { 'pivot-erp-base-url': 'https://wrong.example', 'pivot-erp-tenant-id': 'wrong', 'pivot-erp-local-plugin-token': 'wrong-key' };
  const config = { erpBaseUrl: 'https://erp.hjt888.xyz', tenantId: 'tenant-a', localPluginToken: 'one-key' };
  const saves = [];
  const events = new Map();
  const event = (name) => ({ addListener(fn) {
    if (!name) return;
    const handlers = events.get(name) || [];
    handlers.push(fn); events.set(name, handlers);
  }, removeListener() {} });
  const chrome = {
    runtime: { id: 'unified-instance', getManifest: () => ({ version: '1.5.0' }), onMessage: { addListener(fn) { listeners.push(fn); } }, onInstalled: event(), onStartup: event() },
    storage: { local: { get: async () => stored, set: async (value) => Object.assign(stored, value) }, onChanged: event('storage') },
    webRequest: { onBeforeSendHeaders: event(), onHeadersReceived: event() },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    alarms: { create() {}, onAlarm: event() },
    tabs: { query: async () => [], onUpdated: event('tabs'), onRemoved: event('removed') },
    cookies: { getAll: async () => [], getAllCookieStores: async () => [], onChanged: event('cookies') }
  };
  const context = vm.createContext({
    chrome, URL, AbortController,
    console: { error() {} },
    OzonUnifiedConfig: { get: async () => ({ ...config }), saveKey: async (value) => { saves.push(value); config.localPluginToken = value; return { configured: true }; } },
    setTimeout: options.setTimeout || (() => 1), clearTimeout: options.clearTimeout || (() => {}), setInterval: () => 1, clearInterval() {},
    fetch: async (url, init) => { requests.push({ url, options: init }); return options.fetch ? options.fetch(url, init) : { ok: true, status: 200, json: async () => ({ success: true, data: {} }) }; }
  });
  context.importScripts = (...files) => files.forEach((file) => {
    imports.push(file);
    const source = options.exposeAnalytics && file === 'analytics/background.js'
      ? read(file).replace('})(globalThis);', 'global.__analyticsFetch = fetch;\n})(globalThis);') : read(file);
    vm.runInContext(source, context);
  });
  vm.runInContext(read('background.js'), context);
  return { context, imports, saves, config, requests, events, async message(message, sender = { id: 'unified-instance', url: 'chrome-extension://unified-instance/popup.html' }) {
    return new Promise((resolve) => listeners.forEach((listener) => listener(message, sender, resolve)));
  } };
}

test('local pool diagnostics and reconnect reply immediately and are restricted to the own popup', async () => {
  const h = dualBackground();
  await flush();
  let wakes = 0;
  h.context.__wake = () => { wakes++; return new Promise(() => {}); };
  vm.runInContext('collectorBrowserPool.wake = __wake', h.context);
  const requestsBefore = h.requests.length;
  const status = await h.message({ type: 'OZON_ERP_BROWSER_POOL_DIAGNOSTICS' });
  assert.equal(status.success, true);
  assert.ok(status.diagnostics);
  assert.equal(wakes, 0);
  const reconnect = await h.message({ type: 'OZON_ERP_BROWSER_POOL_RECONNECT' });
  assert.equal(reconnect.success, true);
  assert.equal(wakes, 1);
  assert.equal(h.requests.length, requestsBefore);
  for (const sender of [
    { id: 'another-instance', url: 'chrome-extension://unified-instance/popup.html' },
    { id: 'unified-instance', tab: { id: 7 }, url: 'chrome-extension://unified-instance/popup.html' },
    { id: 'unified-instance', url: 'https://seller.ozon.ru/app/analytics/graphs' }
  ]) {
    const denied = await h.message({ type: 'OZON_ERP_BROWSER_POOL_RECONNECT' }, sender);
    assert.equal(denied.error, 'PLUGIN_POPUP_REQUIRED');
  }
  assert.equal(wakes, 1);
});

test('Seller page, company cookie and verified connection changes wake registration without navigation', async () => {
  const h = dualBackground();
  await flush();
  let wakes = 0;
  h.context.__wake = async () => { wakes++; };
  vm.runInContext('collectorBrowserPool.wake = __wake', h.context);
  const emit = (name, ...args) => h.events.get(name).forEach((handler) => handler(...args));
  emit('tabs', 7, { status: 'complete' }, { url: 'https://seller.ozon.ru/app/products' });
  emit('tabs', 7, { url: 'https://seller.ozon.ru/app/analytics/graphs' }, {});
  assert.equal(wakes, 2);
  emit('tabs', 7, { status: 'complete' }, { url: 'https://evil.example/' });
  emit('cookies', { cookie: { name: 'sc_company_id', domain: '.ozon.ru' } });
  emit('cookies', { cookie: { name: 'sc_company_id', domain: 'seller.ozon.ru' } });
  assert.equal(wakes, 4);
  emit('cookies', { cookie: { name: 'sc_company_id', domain: 'ozon.ru.evil.example' } });
  emit('cookies', { cookie: { name: 'other', domain: '.ozon.ru' } });
  for (const key of ['ozon-erp-local-plugin-token', 'ozon-erp-tenant-id', 'ozon-erp-unified-connection-v1']) {
    emit('storage', { [key]: { newValue: 'fixture' } }, 'local');
  }
  assert.equal(wakes, 7);
  emit('storage', { unrelated: {} }, 'local');
  emit('storage', { 'ozon-erp-local-plugin-token': {} }, 'sync');
  assert.equal(wakes, 7);
  assert.equal(typeof h.context.OzonSellerCookieContext.read, 'function');
});

test('actual collector and namespaced analytics backgrounds load together and share one key', async () => {
  const h = dualBackground();
  await flush();
  assert.equal(h.context.OzonUnifiedAnalytics.loaded, true);
  assert.equal(typeof h.context.OzonCollectorBrowserPool.create, 'function');
  assert.ok(h.imports.includes('analytics/background.js'));
  const status = await h.message({ type: 'PIVOT_ERP_PANEL_GET_STATUS' });
  assert.equal(status.config.erpBaseUrl, 'https://erp.hjt888.xyz');
  assert.equal(status.config.tenantId, 'tenant-a');
  assert.equal(status.config.localPluginToken, 'one-key');
  const saved = await h.message({ type: 'PIVOT_ERP_PANEL_SAVE_CONFIG', config: { erpBaseUrl: 'https://wrong.example', tenantId: 'wrong', localPluginToken: 'new-key' } });
  assert.deepEqual(h.saves, ['new-key']);
  assert.equal(saved.config.localPluginToken, 'new-key');
  assert.equal(await vm.runInContext('getLocalPluginToken()', h.context), 'new-key');
  assert.equal(await vm.runInContext('resolveErpTenantId("https://wrong.example")', h.context), 'tenant-a');
  const collector = await h.message({ type: 'CHECK_SELLER_TAB' });
  assert.equal(collector.hasSellerTab, false);
  const pairing = await h.message({ type: 'PIVOT_ERP_PAIR_ORIGIN', erpBaseUrl: 'http://localhost:8788' }, { tab: { url: 'http://localhost:8788/admin.html' } });
  assert.equal(pairing.config.erpBaseUrl, 'https://erp.hjt888.xyz');
  const untrusted = await h.message({ type: 'PIVOT_ERP_PAIR_ORIGIN', erpBaseUrl: 'https://evil.example' }, { tab: { url: 'https://evil.example/' } });
  assert.equal(untrusted.error, 'ERP_ORIGIN_MISMATCH');
  assert.equal(h.saves.length, 1);
  assert.throws(() => vm.runInContext('normalizeDirectSyncContext({ erpBaseUrl: "https://other.example", tenantId: "wrong" })', h.context), /固定连接/);
  const rejected = await h.message({ type: 'OZON_ERP_LOCAL_PLUGIN_FETCH', erpBaseUrl: 'https://other.example', url: 'https://other.example/api/local-plugin/plugin/status' });
  assert.equal(rejected.success, false);
  assert.ok(h.requests.every((item) => item.url.startsWith('https://erp.hjt888.xyz/')));
});

test('legacy bridge messages wait for analytics navigation and hold the gate through the real callback', async () => {
  const h = dualBackground();
  await flush();
  h.context.chrome.tabs.query = async () => [{ id: 7, status: 'complete', url: 'https://seller.ozon.ru/app/analytics/graphs' }];
  let callback, sent = 0, finishPreparation;
  h.context.chrome.tabs.sendMessage = (tabId, payload, done) => { assert.equal(tabId, 7); sent++; callback = done; };
  const runtime = h.context.OzonUnifiedRuntime;
  const preparing = runtime.withAnalyticsPreparation(() => new Promise((resolve) => { finishPreparation = resolve; }));
  await flush();
  const result = h.message({ type: 'CROSS_TAB_OZON_REQUEST', sku: 'sku', apiType: 'sales' });
  await flush();
  assert.equal(sent, 0);
  finishPreparation(); await preparing; await flush();
  assert.equal(sent, 1);
  let navigated = false;
  const nextPreparation = runtime.withAnalyticsPreparation(async () => { navigated = true; });
  await flush();
  assert.equal(navigated, false);
  callback({ success: true, data: { soldCount: 7 } });
  assert.equal((await result).data.soldCount, 7);
  await nextPreparation;
  assert.equal(navigated, true);
});

test('generated analytics fetch and response body deadlines release the preparation gate after failure', async () => {
  for (const stalled of ['fetch', 'body']) {
    const timers = new Map(); let next = 0;
    const h = dualBackground({
      exposeAnalytics: true,
      setTimeout: (run, ms) => { timers.set(++next, { run, ms }); return next; }, clearTimeout: (id) => timers.delete(id),
      fetch: async (url, init) => {
        if (url.endsWith('/deadline')) return stalled === 'fetch' ? new Promise(() => {}) : { ok: true, status: 200, json: () => new Promise(() => {}) };
        return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
      }
    });
    await flush();
    const runtime = h.context.OzonUnifiedRuntime;
    const pending = runtime.withAnalyticsPreparation(async () => {
      const response = await h.context.__analyticsFetch('https://erp.hjt888.xyz/deadline');
      return response.json();
    });
    await flush();
    assert.equal(runtime.tryAcquireCollectorTab(7), null);
    const deadline = [...timers.values()].findLast((timer) => timer.ms === 15000);
    assert.ok(deadline);
    deadline.run();
    await assert.rejects(pending, (error) => error.name === 'AbortError');
    await flush();
    const release = runtime.tryAcquireCollectorTab(7);
    assert.equal(typeof release, 'function');
    release();
    assert.equal(h.requests.find((request) => request.url.endsWith('/deadline')).options.signal.aborted, true);
  }
});

test('generated ERP bridge advertises both capabilities and answers only targeted instances', async () => {
  const sent = [], posted = [];
  let handler;
  const window = { location: { protocol: 'https:', hostname: 'erp.hjt888.xyz', origin: 'https://erp.hjt888.xyz' },
    addEventListener: (type, fn) => { handler = fn; }, postMessage: (value) => posted.push(value) };
  const chrome = { runtime: { id: 'unified-instance', getManifest: () => ({ version: '1.5.0' }), sendMessage: async (message) => { sent.push(message); return { ok: true }; } } };
  vm.runInNewContext(read('analytics/content/erp-instance.js'), { window, chrome });
  await flush();
  assert.equal(posted[0].capabilities.collector, true);
  assert.equal(posted[0].capabilities.sellerAnalytics, true);
  const deliver = (type, id) => handler({ source: window, origin: window.location.origin, data: { type, pluginInstanceId: id, requestId: 'request', expectedStoreId: '1001', runId: 'run' } });
  const before = sent.length;
  for (const type of ['BAODAN_ANALYTICS_PLUGIN_CHECK_STORE', 'BAODAN_ANALYTICS_PLUGIN_WAKE', 'BAODAN_ANALYTICS_PLUGIN_CANCEL']) deliver(type, 'other-instance');
  await flush();
  assert.equal(sent.length, before);
  deliver('BAODAN_ANALYTICS_PLUGIN_CHECK_STORE', 'unified-instance');
  await flush();
  assert.equal(posted.at(-1).pluginInstanceId, 'unified-instance');
  deliver('BAODAN_ANALYTICS_PLUGIN_WAKE', undefined);
  await flush();
  assert.ok(sent.some((item) => item.type === 'PIVOT_ERP_COLLECT_WAKE'));
});
