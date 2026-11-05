import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import vm from 'node:vm';
import { createCollectorBrowserPoolHandler } from '../src/server/collector-browser-pool-route.js';
import { tenantPluginApiError } from '../src/server/local-plugin-tenant.js';
import { CollectorBrowserPool } from '../src/services/collector-browser-pool.js';

test('real partition-aware browser workers complete one uncached two-shop batch through HTTP 8788 without crossing tenants', { timeout: 15000 }, async (t) => {
  const pool = new CollectorBrowserPool();
  const requests = [], progress = [], sellerCalls = [], cookieQueries = [], holds = [];
  const prefix = '/api/local-plugin/collector-browser-pool';
  const base = 'http://127.0.0.1:8788';
  const principals = {
    'fixture-a': { tenantKey: 'tenant-a', tenantId: 41, tenantSlug: 'fixture-a' },
    'fixture-b': { tenantKey: 'tenant-b', tenantId: 42, tenantSlug: 'fixture-b' }
  };
  const sendJson = (_req, res, data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const route = createCollectorBrowserPoolHandler({
    pool, sendJson,
    resolveShop: async (company, tenant) => {
      if (tenant !== 'tenant-a' || !['1001', '1002'].includes(company)) {
        throw Object.assign(new Error('Fixture shop ownership rejected'), { status: 403, code: 'COLLECTOR_BROWSER_SHOP_FORBIDDEN' });
      }
      return { company_id: company, shop_id: Number(company), shop_name: `Fixture ${company}` };
    }
  });
  const server = http.createServer(async (req, res) => {
    const parts = new URL(req.url, base).pathname.split('/').filter(Boolean);
    const principal = principals[req.headers['x-local-plugin-token']] || null;
    const denied = tenantPluginApiError(principal, req.method, parts);
    if (denied) return sendJson(req, res, { success: false, code: denied.code }, denied.status);
    try {
      if (!await route(req, res, parts, principal)) sendJson(req, res, { success: false }, 404);
    } catch {
      sendJson(req, res, { success: false }, 500);
    }
  });
  server.listen(8788, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

  const tabs = [
    { id: 11, url: 'https://seller.ozon.ru/app/analytics/graphs', company: '1001' },
    { id: 12, url: 'https://seller.ozon.ru/app/analytics/graphs', company: '1002' }
  ];
  const stores = [{ id: 'regular', tabIds: [11] }, { id: 'partition-only', tabIds: [12] }];
  const frameKey = { topLevelSite: 'https://ozon.ru', hasCrossSiteAncestor: false };
  const cookie = (company, storeId, partitioned = false) => ({
    name: 'sc_company_id', value: company, domain: 'seller.ozon.ru', path: '/', storeId,
    ...(partitioned ? { partitionKey: frameKey } : {})
  });
  const chrome = {
    runtime: { getManifest: () => ({ version: '1.5.1' }) },
    storage: { local: { get: async () => ({ 'ozon-erp-collector-browser-instance': 'fixture-installation' }) } },
    tabs: { query: async () => tabs },
    cookies: {
      getAllCookieStores: async () => stores,
      getPartitionKey: async (frame) => {
        assert.equal(frame.frameId, 0);
        assert.ok(tabs.some((tab) => tab.id === frame.tabId));
        return { partitionKey: { ...frameKey } };
      },
      getAll: async (query) => {
        cookieQueries.push(JSON.parse(JSON.stringify(query)));
        assert.ok(stores.some((store) => store.id === query.storeId));
        if (query.partitionKey) assert.deepEqual(JSON.parse(JSON.stringify(query.partitionKey)), frameKey);
        if (query.storeId === 'regular') return query.partitionKey ? [] : [cookie('1001', 'regular')];
        return query.partitionKey ? [cookie('1002', 'partition-only', true)] : [
          { name: 'session', value: 'COOKIE_MUST_STAY_IN_BROWSER', domain: 'seller.ozon.ru', path: '/', storeId: 'partition-only' }
        ];
      }
    },
    scripting: { executeScript: async ({ target, func }) => {
      assert.deepEqual(Array.from(target.frameIds), [0]);
      const tab = tabs.find((item) => item.id === target.tabId);
      assert.ok(tab);
      return [{ result: vm.runInNewContext(`(${func.toString()})()`, {
        location: { origin: 'https://seller.ozon.ru' }, document: { cookie: `sc_company_id=${tab.company}` }
      }) }];
    } }
  };
  const context = vm.createContext({
    chrome, URL, AbortController, crypto: webcrypto,
    setTimeout: (callback, delay) => setTimeout(callback, delay === 1000 ? 5 : delay), clearTimeout
  });
  for (const name of ['seller-cookie-context.js', 'collector-browser-worker.js']) {
    vm.runInContext(readFileSync(`ozon-erp-collector-plugin/${name}`, 'utf8'), context);
  }
  const client = context.OzonCollectorBrowserPool.create({
    chrome,
    getContext: async () => ({ erpBaseUrl: base, tenantId: 'tenant-a', token: 'fixture-a' }),
    readCookieContext: (tab, options) => context.OzonSellerCookieContext.read(tab, options),
    fetch: async (url, init) => {
      assert.ok(url.startsWith(`${base}${prefix}/`));
      requests.push({ path: new URL(url).pathname.slice(prefix.length), body: init.body ? JSON.parse(init.body) : null });
      return fetch(url, init);
    },
    collectFields: async (sku, { request, onSales }) => {
      const sales = await request(sku, 'sales');
      await onSales({ fields: sales });
      const baseFields = await request(sku, 'base');
      const variant = await request(sku, 'variant');
      return { fields: { ...sales, ...baseFields, ...variant }, warnings: [] };
    },
    requestInTab: async (tab, request) => {
      assert.equal(request.expectedCompanyId, tab.company);
      sellerCalls.push({ sku: request.sku, company: tab.company, tabId: tab.id, apiType: request.apiType });
      if (request.apiType === 'base') await new Promise((resolve) => holds.push(resolve));
      return { success: true, data: request.apiType === 'sales'
        ? { soldCount: Number(tab.company), soldSumRub: 1200 }
        : request.apiType === 'base' ? { category: 'Fixture' } : { weight_g: 100 } };
    },
    buildPayload: (sku, result) => ({ sku, ...result.fields }), buildDisplay: (value) => value,
    emit: async (_tabId, result) => { progress.push(JSON.parse(JSON.stringify(result))); }
  });
  t.after(() => { client.stop(); holds.splice(0).forEach((release) => release()); });
  const call = async (path, body, token = 'fixture-a') => {
    const response = await fetch(`${base}${prefix}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'x-local-plugin-token': token, 'x-tenant-id': 'tenant-a' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const waitUntil = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'partition-aware HTTP fixture progress deadline');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  assert.equal(pool.status('tenant-a').available_workers, 0);
  await client.tick();
  assert.equal(pool.status('tenant-a').available_workers, 2);
  const heartbeats = requests.filter((item) => item.path === '/heartbeat');
  assert.deepEqual(heartbeats.map((item) => item.body.company_id).sort(), ['1001', '1002']);
  assert.ok(heartbeats.every((item) => item.body.identity_source === 'page_cookie'));
  assert.ok(cookieQueries.some((query) => query.storeId === 'partition-only' && query.partitionKey));
  assert.equal(pool.cache.size, 0);
  assert.equal((await call('status', undefined, 'fixture-b')).body.available_workers, 0);

  const pending = client.preview(['uncached-one', 'uncached-two'], new Map(), 99);
  const drive = setInterval(() => { void client.tick(); }, 10);
  t.after(() => clearInterval(drive));
  await waitUntil(() => holds.length === 2 && progress.filter((item) => item.partial).length === 2);
  const created = requests.filter((item) => item.path === '/batches');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].body.skus, ['uncached-one', 'uncached-two']);
  const batch = [...pool.batches.values()][0];
  assert.ok(batch);
  const partial = (await call(`batches/${batch.id}?after=0`)).body;
  assert.equal(partial.completed_count, 0);
  assert.equal(partial.results.filter((item) => item.partial).length, 2);
  assert.equal((await call(`batches/${batch.id}`, undefined, 'fixture-b')).status, 404);
  const firstReport = requests.find((item) => item.path === '/results').body;
  assert.equal((await call('results', firstReport, 'fixture-b')).status, 403);

  holds.splice(0).forEach((release) => release());
  const completed = await pending;
  clearInterval(drive);
  assert.deepEqual(Array.from(completed.fallbackSkus), []);
  assert.equal(completed.results.length, 2);
  assert.ok(completed.results.every((item) => item.success && !item.partial && item.collectionRoute.mode === 'browser_pool'));
  const final = (await call(`batches/${batch.id}?after=0`)).body;
  assert.equal(final.status, 'complete');
  assert.equal(final.completed_count, 2);
  assert.deepEqual(final.results.map((item) => item.source_company_id).sort(), ['1001', '1002']);
  assert.deepEqual(final.results.map((item) => item.source_shop_id).sort(), [1001, 1002]);
  for (const sku of ['uncached-one', 'uncached-two']) {
    assert.equal(new Set(sellerCalls.filter((item) => item.sku === sku).map((item) => item.company)).size, 1);
  }
  assert.equal(pool.cache.size, 2);
  assert.equal((await call('batches', { skus: ['uncached-one', 'uncached-two'] }, 'fixture-b')).status, 409);
  assert.equal(pool.status('tenant-b').available_workers, 0);
  assert.equal(requests.filter((item) => item.path === '/batches').length, 1);
  assert.equal(requests.filter((item) => item.path === '/results' && item.body.phase === 'complete').length, 2);
  assert.doesNotMatch(JSON.stringify(requests), /COOKIE_MUST_STAY_IN_BROWSER|"cookies"|"raw"|partitionKey/);
});
