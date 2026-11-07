import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync('ozon-erp-collector-plugin/collector-browser-worker.js', 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(options = {}) {
  let now = 1000, nextTimer = 0;
  const timers = new Map(), calls = [];
  const config = { erpBaseUrl: 'https://erp.hjt888.xyz', tenantId: 'tenant-a', token: 'synthetic-key-a' };
  const tabs = options.tabs || [{ id: 7, url: 'https://seller.ozon.ru/app/analytics/graphs?private=do-not-expose' }];
  const stores = options.stores || [{ id: 'store', tabIds: [7] }];
  const context = {
    URL, AbortController, crypto: { randomUUID: () => 'installation' },
    Date: class extends Date { static now() { return now; } },
    setTimeout(run, ms) { timers.set(++nextTimer, { run, ms }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(source, context);
  const chrome = {
    runtime: { getManifest: () => ({ version: '1.5.1' }) },
    storage: { local: { get: async () => ({ 'ozon-erp-collector-browser-instance': 'installation' }) } },
    tabs: { query: async () => { calls.push({ type: 'scan' }); return tabs; } },
    cookies: {
      getAllCookieStores: async () => stores,
      getAll: async () => [{ name: 'sc_company_id', value: options.cookieCompany ?? '1001' }, { name: 'session', value: 'private-cookie' }]
    },
    scripting: { executeScript: async () => {
      if (options.permissionDenied) throw new Error('Cannot access contents of url https://seller.ozon.ru/private?token=synthetic-key-a');
      return [{ result: options.pageCompany ?? '1001' }];
    } }
  };
  const client = context.OzonCollectorBrowserPool.create({
    chrome,
    readCookieContext: options.readCookieContext,
    getContext: async () => ({ ...config }),
    fetch: async (url, init) => {
      const path = new URL(url).pathname.split('/collector-browser-pool')[1];
      const call = { path, headers: { ...init.headers }, body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      if (options.fetch) return options.fetch(call);
      return { ok: true, status: 200, json: async () => ({ success: true, available_workers: 1, task: null }) };
    },
    buildPayload: (sku, result) => ({ sku, ...result.fields }), buildDisplay: (value) => value,
    emit: async () => {}
  });
  return { client, config, tabs, stores, calls, advance(ms) { now += ms; } };
}

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const unavailable = () => reply(409, { success: false, code: 'COLLECTOR_BROWSER_POOL_UNAVAILABLE' });
const completed = () => reply(200, { success: true, batch_id: 'batch', status: 'complete', revision: 1,
  results: [{ sku: 'sku', success: true, partial: false, product: { soldCount: 7 } }] });

test('a token or tenant change rescans and registers immediately inside the old scan TTL', async () => {
  const h = harness();
  await h.client.tick();
  h.config.token = 'synthetic-key-b';
  await h.client.tick();
  h.config.tenantId = 'tenant-b';
  await h.client.tick();
  assert.equal(h.calls.filter((call) => call.type === 'scan').length, 3);
  const heartbeats = h.calls.filter((call) => call.path === '/heartbeat');
  assert.equal(heartbeats.length, 3);
  assert.deepEqual(heartbeats.map((call) => call.headers['x-tenant-id']), ['tenant-a', 'tenant-a', 'tenant-b']);
  assert.equal(heartbeats[1].headers['x-local-plugin-token'], 'synthetic-key-b');
});

test('no-worker bootstrap forces a fresh scan and heartbeat even after a recent successful registration', async () => {
  let registered = true, batches = 0;
  const h = harness({ fetch: async ({ path }) => {
    if (path === '/heartbeat') registered = true;
    if (path === '/batches') { batches++; return registered ? completed() : unavailable(); }
    return reply(200, { success: true, task: null });
  } });
  await h.client.tick();
  registered = false;
  const result = await h.client.preview(['sku'], new Map(), 1);
  assert.equal(batches, 2);
  assert.ok(result);
  assert.equal(result.fallbackSkus.length, 0);
  assert.equal(h.calls.filter((call) => call.type === 'scan').length, 2);
  assert.equal(h.calls.filter((call) => call.path === '/heartbeat').length, 2);
});

test('bootstrap waits for an existing tick then force-registers and retries with the latest context', async () => {
  let releaseHeartbeat, heartbeatStarted, oldReleased = false, latestRegistered = false;
  const ready = new Promise((resolve) => { heartbeatStarted = resolve; });
  const h = harness({ fetch: async ({ path, headers }) => {
    if (path === '/heartbeat' && !oldReleased) {
      heartbeatStarted();
      await new Promise((resolve) => { releaseHeartbeat = () => { oldReleased = true; resolve(); }; });
    }
    if (path === '/heartbeat' && headers['x-tenant-id'] === 'tenant-b') latestRegistered = true;
    if (path === '/batches') return latestRegistered && headers['x-tenant-id'] === 'tenant-b' ? completed() : unavailable();
    return reply(200, { success: true, task: null });
  } });
  const running = h.client.tick();
  await ready;
  h.config.tenantId = 'tenant-b'; h.config.token = 'synthetic-key-b';
  const preview = h.client.preview(['sku'], new Map(), 1);
  await flush();
  assert.equal(h.calls.filter((call) => call.path === '/batches').length, 1);
  releaseHeartbeat(); await running;
  const result = await preview;
  assert.ok(result);
  assert.equal(result.fallbackSkus.length, 0);
  assert.equal(h.calls.filter((call) => call.path === '/batches').at(-1).headers['x-local-plugin-token'], 'synthetic-key-b');
  assert.equal(h.calls.filter((call) => call.type === 'scan').length, 2);
});

test('an explicit wake immediately retries registration and diagnostics reads never cause network work', async () => {
  const h = harness();
  assert.equal(h.client.getDiagnostics().phase, 'idle');
  assert.equal(h.calls.length, 0);
  await h.client.tick();
  await h.client.wake();
  assert.equal(h.calls.filter((call) => call.path === '/heartbeat').length, 2);
  const before = h.calls.length;
  const status = h.client.getDiagnostics();
  assert.equal(status.phase, 'registered');
  assert.equal(status.localTabCount, 1);
  assert.equal(status.verifiedCompanyCount, 1);
  assert.equal(status.registeredCompanyCount, 1);
  assert.equal(status.serverCompanyCount, 1);
  assert.equal(status.checkedAt, 1000);
  status.tabs?.push({ tabId: 99, code: 'fake' });
  assert.equal(h.client.getDiagnostics().tabs.some((tab) => tab.tabId === 99), false);
  assert.equal(h.calls.length, before);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-key|private-cookie|seller\.ozon|private=|installation/);
});

test('registration diagnostics distinguish absent pages, missing stores, denied access and identity problems', async () => {
  const cases = [
    [{ tabs: [] }, 'no_seller_tabs', 'NO_SELLER_TAB'],
    [{ stores: [] }, 'identity_unavailable', 'COOKIE_STORE_UNAVAILABLE'],
    [{ permissionDenied: true }, 'identity_unavailable', 'SELLER_TAB_PERMISSION_DENIED'],
    [{ pageCompany: '' }, 'identity_unavailable', 'STORE_IDENTITY_UNAVAILABLE'],
    [{ cookieCompany: '1002' }, 'identity_unavailable', 'STORE_CONTEXT_MISMATCH']
  ];
  for (const [options, phase, code] of cases) {
    const h = harness(options);
    await h.client.tick();
    const status = h.client.getDiagnostics();
    assert.equal(status.phase, phase);
    assert.equal(status.lastErrorCode, code);
    assert.equal(status.verifiedCompanyCount, 0);
    assert.equal(status.registeredCompanyCount, 0);
    assert.equal(status.serverCompanyCount, null);
    assert.equal(h.calls.some((call) => call.path === '/heartbeat'), false);
    assert.doesNotMatch(JSON.stringify(status), /synthetic-key|private-cookie|https:|token=/);
  }
});

test('a context-aware cookie reader can provide partitioned identity but cannot substitute another store or company', async () => {
  let reads = 0;
  const h = harness({ readCookieContext: async (tab, options) => {
    reads++;
    assert.equal(tab.id, 7);
    assert.deepEqual({ ...options }, { pageCompanyId: '1001', storeId: 'store' });
    return { companyId: '1001', storeId: 'store', cookies: [{ name: 'sc_company_id', value: '1001', partitionKey: { topLevelSite: 'https://ozon.ru' } }] };
  } });
  await h.client.tick();
  assert.equal(h.client.getDiagnostics().registeredCompanyCount, 1);
  assert.ok(reads >= 2);
  for (const changed of [
    { companyId: '1001', storeId: 'other-store', cookies: [{ name: 'sc_company_id', value: '1001' }] },
    { companyId: '1002', storeId: 'store', cookies: [{ name: 'sc_company_id', value: '1002' }] },
    { companyId: '1001', storeId: 'store', cookies: [] }
  ]) {
    const invalid = harness({ readCookieContext: async () => changed });
    await invalid.client.tick();
    assert.equal(invalid.client.getDiagnostics().registeredCompanyCount, 0);
    assert.equal(invalid.calls.some((call) => call.path === '/heartbeat'), false);
  }
  const noPage = harness({ pageCompany: '' });
  await noPage.client.tick();
  assert.equal(noPage.client.getDiagnostics().tabs[0].code, 'SELLER_PAGE_IDENTITY_MISSING');
  const noCookie = harness({ cookieCompany: '' });
  await noCookie.client.tick();
  assert.equal(noCookie.client.getDiagnostics().tabs[0].code, 'SELLER_COOKIE_IDENTITY_MISSING');
});

test('heartbeat rejection is visible, stays separate from identity failure and respects cooldown on wake', async () => {
  const h = harness({ fetch: async () => reply(403, { success: false, code: 'COLLECTOR_BROWSER_SHOP_FORBIDDEN', error: 'private-cookie synthetic-key-a' }) });
  await h.client.tick();
  const first = h.client.getDiagnostics();
  assert.equal(first.phase, 'registration_failed');
  assert.equal(first.lastErrorCode, 'COLLECTOR_BROWSER_HEARTBEAT_REJECTED');
  assert.equal(first.verifiedCompanyCount, 1);
  assert.equal(first.registeredCompanyCount, 0);
  assert.match(first.lastError, /403/);
  assert.doesNotMatch(JSON.stringify(first), /synthetic-key|private-cookie|https:/);
  await h.client.wake();
  assert.equal(h.calls.filter((call) => call.path === '/heartbeat').length, 1);
  assert.equal(h.client.getDiagnostics().lastErrorCode, 'COLLECTOR_BROWSER_HEARTBEAT_REJECTED');
  h.advance(60001);
  await h.client.wake();
  assert.equal(h.calls.filter((call) => call.path === '/heartbeat').length, 2);
});
