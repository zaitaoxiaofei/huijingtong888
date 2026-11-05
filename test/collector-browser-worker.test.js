import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const moduleSource = fs.readFileSync('ozon-erp-collector-plugin/collector-browser-worker.js', 'utf8');
const background = fs.readFileSync('ozon-erp-collector-plugin/background.js', 'utf8');
const bridge = fs.readFileSync('ozon-erp-collector-plugin/seller-bridge-content.js', 'utf8');
function section(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

function realCollector() {
  return vm.runInNewContext(section(background, 'async function fetchSellerCollectedProductFields(', 'function buildSellerCollectedProductFieldsFromPool(') + '\nfetchSellerCollectedProductFields', {
    requestSellerBridgeDataFromBackground: async () => { throw new Error('must use fixed tab injection'); },
    hasFilledValue: (value) => value !== undefined && value !== null && value !== '',
    buildSellerSalesFields: (value) => ({ ...value }),
    buildSellerBaseInfoFields: () => ({ brand: 'brand' }),
    buildSellerVariantFields: () => ({ weight_g: 100 }),
    normalizeSellerImages: () => ['image.png']
  });
}

function harness(options = {}) {
  let now = 1000, timerId = 0;
  const timers = new Map(), stored = options.stored || {};
  const tabs = [{ id: 1, url: 'https://seller.ozon.ru/app/analytics/graphs' }, { id: 2, url: 'https://seller.ozon.ru/app/analytics/graphs' }];
  const stores = [{ id: 'regular', tabIds: [1] }, { id: 'isolated', tabIds: [2] }];
  const companies = new Map([[1, '111'], [2, '222']]);
  const calls = [], apiCalls = [], progress = [];
  const context = {
    URL, AbortController, crypto: { randomUUID: () => 'installation-uuid' },
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) {
      const id = ++timerId;
      if (delay === 1000) Promise.resolve().then(callback);
      else timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(moduleSource, context);
  const chrome = {
    runtime: { getManifest: () => ({ version: '1.4.39' }) },
    storage: { local: { get: async () => stored, set: async (value) => Object.assign(stored, value) } },
    tabs: { query: async () => tabs },
    scripting: { executeScript: async ({ target }) => [{ result: companies.get(target.tabId) }] },
    cookies: {
      getAllCookieStores: async () => stores,
      getAll: async (query) => {
        calls.push({ cookieQuery: query });
        return [{ name: 'sc_company_id', value: companies.get(query.storeId === 'regular' ? 1 : 2) }, { name: 'private_session', value: 'secret-cookie' }];
      }
    }
  };
  const display = vm.runInNewContext(section(background, 'function buildCollectedProductDisplayPayload(', 'async function emitAutoCollectListProgress(') + '\nbuildCollectedProductDisplayPayload', {});
  const client = context.OzonCollectorBrowserPool.create({
    chrome,
    getContext: async () => ({ erpBaseUrl: 'https://erp.hjt888.xyz', tenantId: 'tenant-a', token: 'secret-token' }),
    fetch: async (url, init) => {
      const path = new URL(url).pathname.split('/collector-browser-pool')[1] + new URL(url).search;
      const body = init.body ? JSON.parse(init.body) : undefined;
      apiCalls.push({ path, body });
      if (options.fetch) return options.fetch(path, body, init);
      if (path === '/claim') return { ok: true, status: 200, json: async () => ({ success: true, task: options.task?.(body) || null }) };
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    },
    collectFields: realCollector(),
    requestInTab: async (tab, request) => {
      calls.push({ tab: tab.id, request });
      if (options.request) return options.request(tab, request, companies);
      return { success: true, data: request.apiType === 'sales'
        ? { items: [{ soldCount: 7, soldSumRub: 70, variantId: 'v', cookie: 'must-not-transfer' }] }
        : request.apiType === 'search-sku-base' ? { variants: [{ variant_id: 'v' }] } : { item: { images: ['image.png'] } } };
    },
    buildPayload: (sku, result, base) => ({ ...result.fields, ...base, sku }),
    buildDisplay: display,
    emit: async (tabId, result) => progress.push({ tabId, ...result })
  });
  return { client, companies, tabs, stores, calls, apiCalls, progress, stored, advance(ms) { now += ms; }, expire(delay) { for (const timer of [...timers.values()]) if (timer.delay === delay) timer.callback(); } };
}

function task(company) {
  return { task_id: `task-${company}`, batch_id: 'batch', sku: `sku-${company}`, company_id: company, lease_token: 'lease', lease_expires_at: new Date(91000).toISOString() };
}

test('two isolated cookie stores register distinct workers and retain a persistent installation UUID', async () => {
  const h = harness();
  await h.client.tick();
  const heartbeats = h.apiCalls.filter((item) => item.path === '/heartbeat');
  assert.equal(heartbeats.length, 2);
  assert.notEqual(heartbeats[0].body.worker_id, heartbeats[1].body.worker_id);
  assert.equal(heartbeats[0].body.observed_company_id, '');
  assert.equal(heartbeats[0].body.identity_source, 'page_cookie');
  assert.equal(heartbeats[1].body.company_id, '222');
  assert.equal(heartbeats[1].body.cookie_company_id, '222');
  assert.ok(h.calls.some((call) => call.cookieQuery?.storeId === 'isolated'));
  const restart = harness({ stored: h.stored });
  assert.equal(await restart.client.instanceId(), await h.client.instanceId());
  assert.ok(!JSON.stringify(h.apiCalls).includes('secret-cookie'));
});

test('one task stays on its own tab, reports sales before complete, and never transfers cookies/raw JSON', async () => {
  const issued = new Set();
  const h = harness({ task: ({ company_id }) => { if (issued.has(company_id)) return null; issued.add(company_id); return task(company_id); } });
  await h.client.tick();
  await flush();
  for (const company of ['111', '222']) {
    const requests = h.calls.filter((call) => call.request?.sku === `sku-${company}`);
    assert.deepEqual(requests.map((call) => call.request.apiType), ['sales', 'search-sku-base', 'variant_v2']);
    assert.ok(requests.every((call) => call.tab === (company === '111' ? 1 : 2) && call.request.expectedCompanyId === company));
    const reports = h.apiCalls.filter((call) => call.path === '/results' && call.body.company_id === company);
    assert.deepEqual(reports.map((call) => call.body.phase), ['sales', 'complete']);
    assert.deepEqual(Object.keys(reports[0].body.fields).sort(), ['soldCount', 'soldSumRub']);
    assert.equal(reports[1].body.fields.weight_g, 100);
  }
  assert.doesNotMatch(JSON.stringify(h.apiCalls), /secret-cookie|secret-token|must-not-transfer|"raw"/);
});

test('a task interrupted by a shop switch reports failure and does not continue base/variant', async () => {
  let issued = false;
  const h = harness({
    task: ({ company_id }) => { if (issued || company_id !== '111') return null; issued = true; return task(company_id); },
    request: async (tab, request, companies) => {
      companies.set(tab.id, 'other-shop');
      return { success: true, data: { items: [{ soldCount: 7 }] } };
    }
  });
  await h.client.tick();
  await flush();
  assert.equal(h.calls.filter((call) => call.request).length, 1);
  const reports = h.apiCalls.filter((call) => call.path === '/results');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].body.phase, 'failed');
  assert.equal(reports[0].body.error, 'STORE_CONTEXT_MISMATCH');
});

test('missing live identity during a task is reported separately from a confirmed shop conflict', async () => {
  let issued = false;
  const h = harness({
    task: ({ company_id }) => { if (issued || company_id !== '111') return null; issued = true; return task(company_id); },
    request: async (tab, request, companies) => {
      companies.set(tab.id, '');
      return { success: true, data: { items: [{ soldCount: 7 }] } };
    }
  });
  await h.client.tick(); await flush();
  const reports = h.apiCalls.filter((call) => call.path === '/results');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].body.phase, 'failed');
  assert.equal(reports[0].body.error, 'STORE_IDENTITY_UNAVAILABLE');
  assert.equal(reports[0].body.status, 409);
  assert.equal(h.calls.filter((call) => call.request).length, 1);
});

test('rescanning another tab for the same company cannot move an active task between tabs', async () => {
  let issued = false;
  let releaseBase;
  let baseStarted;
  const ready = new Promise((resolve) => { baseStarted = resolve; });
  const h = harness({
    task: ({ company_id }) => { if (issued || company_id !== '111') return null; issued = true; return task(company_id); },
    request: async (tab, request) => {
      if (request.apiType === 'sales') return { success: true, data: { items: [{ soldCount: 7, variantId: 'v' }] } };
      if (request.apiType === 'search-sku-base') {
        await new Promise((resolve) => { releaseBase = resolve; baseStarted(); });
        return { success: true, data: { variants: [{ variant_id: 'v' }] } };
      }
      return { success: true, data: { item: { images: ['image.png'] } } };
    }
  });
  h.tabs.push({ id: 3, url: 'https://seller.ozon.ru/app/products' });
  h.companies.set(3, '111');
  h.stores[0].tabIds.push(3);
  await h.client.tick(); await ready;
  assert.equal(h.calls.find((call) => call.request).tab, 3);
  h.tabs.reverse();
  h.advance(16000);
  await h.client.tick();
  releaseBase(); await flush();
  assert.ok(h.calls.filter((call) => call.request).every((call) => call.tab === 3));
  assert.deepEqual(h.apiCalls.filter((call) => call.path === '/results').map((call) => call.body.phase), ['sales', 'complete']);
});

test('expired leases do not execute and an active long task still sends heartbeats without another claim', async () => {
  let issued = false;
  const expired = harness({ task: ({ company_id }) => { if (issued) return null; issued = true; return { ...task(company_id), lease_expires_at: new Date(0).toISOString() }; } });
  await expired.client.tick(); await flush();
  assert.equal(expired.calls.filter((call) => call.request).length, 0);
  assert.equal(expired.apiCalls.find((call) => call.path === '/results').body.phase, 'failed');
  issued = false;
  const active = harness({ task: ({ company_id }) => { if (issued || company_id !== '111') return null; issued = true; return task(company_id); }, request: async () => new Promise(() => {}) });
  await active.client.tick(); await flush();
  const claims = active.apiCalls.filter((call) => call.path === '/claim' && call.body.company_id === '111').length;
  active.advance(16000);
  await active.client.tick();
  assert.equal(active.apiCalls.filter((call) => call.path === '/claim' && call.body.company_id === '111').length, claims);
  assert.equal(active.apiCalls.filter((call) => call.path === '/heartbeat' && call.body.company_id === '111').length, 2);
  active.expire(20000); await flush();
  assert.equal(active.apiCalls.filter((call) => call.path === '/results').at(-1).body.phase, 'failed');
});

test('old servers fall back, incrementally completed SKUs are not fetched again and page prices remain authoritative', async () => {
  const old = harness({ fetch: async () => ({ ok: false, status: 404, json: async () => ({ success: false }) }) });
  assert.equal(await old.client.preview(['a'], new Map(), 9), null);
  let polls = 0;
  const h = harness({ fetch: async (path) => ({ ok: true, status: 200, json: async () => path === '/batches'
    ? { success: true, batch_id: 'batch', status: 'running', revision: 1, results: [{ sku: 'a', success: true, partial: true, product: { soldCount: 7, price: 999 } }] }
    : (++polls, { success: true, batch_id: 'batch', status: 'complete', revision: 2, results: [{ sku: 'a', success: true, partial: false, product: { soldCount: 7, price: 999 } }] }) }) });
  const result = await h.client.preview(['a'], new Map([['a', { price: 15, cardPrice: 15 }]]), 9);
  assert.equal(polls, 1);
  assert.equal(result.fallbackSkus.length, 0);
  assert.equal(h.progress[0].partial, true);
  assert.equal(h.progress[0].product.price, undefined);
  assert.equal(h.progress[1].product.price, 15);
  assert.equal(h.calls.filter((call) => call.request).length, 0);
});

test('a stalled API response body has a total deadline and does not expose authentication data', async () => {
  let reading;
  const ready = new Promise((resolve) => { reading = resolve; });
  const h = harness({ fetch: async (path, body, { signal }) => ({ ok: true, status: 200, json: () => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('secret-token'), { name: 'AbortError' })), { once: true });
    reading();
  }) }) });
  const pending = h.client.preview(['a'], new Map(), 9);
  await ready;
  h.expire(15000);
  const result = await pending;
  assert.equal(result.fallbackSkus.length, 0);
  assert.equal(result.results[0].success, false);
  assert.equal(h.progress.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret-token/);
});

test('initial submission with network, invalid JSON or server failure never triggers legacy fallback', async () => {
  for (const failure of ['network', 'json', 'server']) {
    let accepted = 0;
    const h = harness({ fetch: async () => {
      accepted++;
      if (failure === 'network') throw new Error('connection lost after acceptance');
      return { ok: failure !== 'server', status: failure === 'server' ? 500 : 200,
        json: async () => { if (failure === 'json') throw new SyntaxError('truncated response'); return { success: false }; } };
    } });
    const result = await h.client.preview(['a'], new Map(), 9);
    assert.equal(accepted, 1);
    assert.equal(result.fallbackSkus.length, 0);
    assert.equal(result.results[0].success, false);
    assert.equal(h.calls.filter((call) => call.request).length, 0);
  }
});

test('an initial no-worker response registers this browser before one safe batch retry', async () => {
  let registered = false, attempts = 0, accepted = 0;
  const h = harness({ fetch: async (path) => {
    if (path === '/batches') {
      attempts++;
      if (!registered) return { ok: false, status: 409, json: async () => ({ success: false, code: 'COLLECTOR_BROWSER_POOL_UNAVAILABLE' }) };
      accepted++;
      return { ok: true, status: 200, json: async () => ({ success: true, batch_id: 'batch', status: 'complete', revision: 1,
        results: [{ sku: 'a', success: true, partial: false, product: { soldCount: 7 } }] }) };
    }
    if (path === '/heartbeat') registered = true;
    return { ok: true, status: 200, json: async () => ({ success: true, task: null }) };
  } });
  const result = await h.client.preview(['a'], new Map(), 9);
  assert.equal(attempts, 2);
  assert.equal(accepted, 1);
  assert.equal(result.fallbackSkus.length, 0);
  assert.ok(h.apiCalls.some((call) => call.path === '/heartbeat'));
  assert.equal(h.calls.filter((call) => call.request).length, 0);
});

test('polling failure after batch acceptance preserves complete SKUs without replaying unfinished work', async () => {
  const h = harness({ fetch: async (path) => {
    if (path !== '/batches') throw new Error('private-cookie-value');
    return { ok: true, status: 200, json: async () => ({ success: true, batch_id: 'batch', status: 'running', revision: 1,
      results: [{ sku: 'a', success: true, partial: false, product: { soldCount: 7 } }] }) };
  } });
  const result = await h.client.preview(['a', 'b'], new Map(), 9);
  assert.equal(result.fallbackSkus.length, 0);
  assert.equal(result.results.filter((item) => item.success).length, 1);
  assert.equal(h.progress.filter((item) => item.sku === 'a').length, 1);
  assert.equal(h.calls.filter((call) => call.request).length, 0);
  assert.doesNotMatch(JSON.stringify(result), /private-cookie-value/);
});

test('the real seller bridge rejects a changed live company after JSON before returning data', async () => {
  const document = { cookie: 'sc_company_id=111' };
  const run = vm.runInNewContext(section(bridge, '  function assertSellerCompany(', '  async function runMediaUploadRequest(') + '\nrunSellerRequest', {
    AbortController, document, location: { origin: 'https://seller.ozon.ru' },
    getCompanyId: () => document.cookie.split('=')[1],
    buildSellerRequest: () => ({ url: 'https://seller.ozon.ru/test', body: {}, language: 'RU' }),
    fetch: async () => ({ ok: true, json: async () => { document.cookie = 'sc_company_id=222'; return { items: [] }; } }),
    setTimeout: () => 1, clearTimeout() {}, clearCompanyId() {}
  });
  await assert.rejects(run({ expectedCompanyId: '111' }), (error) => error.code === 'STORE_CONTEXT_MISMATCH' && error.status === 409);
});
