import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { CollectorBrowserPool } from '../src/services/collector-browser-pool.js';
import { createCollectorBrowserPoolHandler } from '../src/server/collector-browser-pool-route.js';
import { tenantPluginApiError } from '../src/server/local-plugin-tenant.js';

test('actual browser factory and HTTP coordinator on 8788 dispatch two shops and reuse completed results after worker restart', { timeout: 15000 }, async (t) => {
  const pool = new CollectorBrowserPool();
  const received = [], progress = [], ozon = [], holds = [];
  let failBatchPolling = false;
  let loseCreateResponse = false;
  const sendJson = (req, res, data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    if (loseCreateResponse && req.method === 'POST' && req.url.endsWith('/batches') && status === 200) { res.write('{"success":'); return; }
    res.end(JSON.stringify(data));
  };
  const route = createCollectorBrowserPoolHandler({
    pool, sendJson,
    resolveShop: async (company, tenant) => {
      assert.equal(tenant, 'tenant-a');
      assert.ok(['1001', '1002'].includes(company));
      return { company_id: company, shop_id: Number(company), shop_name: `Fixture ${company}` };
    }
  });
  const server = http.createServer(async (req, res) => {
    const principal = req.headers['x-local-plugin-token'] === 'fixture-token'
      ? { tenantKey: 'tenant-a', tenantId: 41, tenantSlug: 'tenant-a' } : null;
    const parts = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean);
    const denied = tenantPluginApiError(principal, req.method, parts);
    if (denied) return sendJson(req, res, { success: false }, denied.status);
    if (failBatchPolling && req.method === 'GET' && parts[3] === 'batches') return sendJson(req, res, { success: false }, 503);
    await route(req, res, parts, principal);
  });
  server.listen(8788, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:8788';
  const stored = {
    'ozon-erp-base-url': base, 'ozon-erp-tenant-base-url': base,
    'ozon-erp-tenant-id': 'tenant-a', 'ozon-erp-local-plugin-token': 'fixture-token'
  };
  const tabs = [
    { id: 1, company: '1001', url: 'https://seller.ozon.ru/app/analytics/graphs' },
    { id: 2, company: '1002', url: 'https://seller.ozon.ru/app/analytics/graphs' },
    { id: 3, company: '1001', url: 'https://seller.ozon.ru/app/products' }
  ];
  const makeBrowser = async () => {
    const event = () => ({ addListener() {}, removeListener() {} });
    const chrome = {
      runtime: { id: 'same-extension-id-across-profiles', lastError: null, getManifest: () => ({ version: '1.4.39' }), onMessage: event(), onInstalled: event(), onStartup: event() },
      alarms: { create() {}, onAlarm: event() },
      webRequest: { onBeforeSendHeaders: event(), onHeadersReceived: event() },
      storage: { local: { get: async () => stored, set: async (value) => Object.assign(stored, value) } },
      tabs: {
        onRemoved: event(), onUpdated: event(), query: async () => tabs,
        create: async () => { throw new Error('test must not open a Seller tab'); },
        update: async () => { throw new Error('test must not navigate or switch a Seller tab'); },
        sendMessage(tabId, message, callback) {
          const task = (async () => {
            if (message.type === 'OZON_ERP_AUTO_COLLECT_LIST_PROGRESS') { progress.push(message.progress); return { success: true }; }
            assert.equal(message.type, 'OZON_SKU_API_REQUEST');
            const tab = tabs.find((item) => item.id === tabId);
            assert.equal(message.expectedCompanyId, tab.company);
            ozon.push({ tabId, sku: message.sku, type: message.apiType, company: tab.company });
            if (message.apiType === 'sales') return { success: true, data: { items: [{ sku: message.sku, soldCount: 12, soldSum: 1200, variantId: `variant-${message.sku}`, cookie: 'BROWSER_COOKIE_MUST_STAY_LOCAL' }] } };
            if (message.apiType === 'search-sku-base') {
              await new Promise((resolve) => holds.push(resolve));
              return { success: true, data: { variants: [{ variant_id: `variant-${message.sku}`, variant_name: 'Fixture product' }] } };
            }
            return { success: true, data: { item: { images: ['https://image.example/fixture.png'], weight: 100 } } };
          })();
          if (callback) task.then(callback);
          return task;
        }
      },
      cookies: {
        getAllCookieStores: async () => [{ id: 'regular', tabIds: [1, 3] }, { id: 'isolated', tabIds: [2] }],
        getAll: async ({ storeId }) => [{ name: 'sc_company_id', value: storeId === 'isolated' ? '1002' : '1001' }, { name: 'session', value: 'BROWSER_COOKIE_MUST_STAY_LOCAL' }]
      },
      scripting: { executeScript: async ({ target, func }) => {
        const tab = tabs.find((item) => item.id === target.tabId);
        return [{ result: vm.runInNewContext(`(${func.toString()})()`, { document: { cookie: `sc_company_id=${tab.company}` }, location: { origin: 'https://seller.ozon.ru' } }) }];
      } }
    };
    const context = vm.createContext({
      chrome, URL, AbortController, crypto: webcrypto, TextEncoder, console,
      setTimeout(callback, delay) { return delay === 0 ? { suppressedStartup: true } : setTimeout(callback, delay === 1000 ? 10 : loseCreateResponse && delay === 15000 ? 30 : delay); },
      clearTimeout(timer) { if (!timer?.suppressedStartup) clearTimeout(timer); },
      fetch: async (url, options) => {
        if (!url.startsWith(`${base}/api/local-plugin/collector-browser-pool/`)) {
          assert.ok(url.startsWith(`${base}/api/local-plugin/plugin/status`) || url.startsWith(`${base}/api/local-plugin/seller-analytics/`));
          return { ok: true, status: 200, json: async () => ({ success: true, data: { connected: true, app: 'ozon-erp', tenantId: 'tenant-a', bound: false, last_status: 403 } }) };
        }
        assert.ok(url.startsWith(`${base}/api/local-plugin/collector-browser-pool/`));
        received.push({ url, body: options.body ? JSON.parse(options.body) : null });
        return fetch(url, options);
      }
    });
    context.chrome = undefined;
    vm.runInContext(readFileSync('ozon-erp-collector-plugin/unified-config.js', 'utf8'), context);
    context.chrome = chrome;
    Object.assign(context.OzonUnifiedConfig, context.OzonUnifiedConfig.create({ chrome, fetchImpl: context.fetch, baseUrl: base }));
    context.OzonUnifiedConfig.attach();
    await context.OzonUnifiedConfig.refresh(true);
    context.importScripts = (...files) => files.forEach((file) => {
      vm.runInContext(readFileSync(`ozon-erp-collector-plugin/${file}`, 'utf8'), context);
      if (file === 'erp-config.js') {
        context.OzonErpCollectorConfig.DEFAULT_ERP_BASE_URL = base;
        context.OzonErpCollectorConfig.normalizeErpBaseUrl = () => base;
      }
    });
    vm.runInContext(readFileSync('ozon-erp-collector-plugin/background.js', 'utf8'), context);
    const client = vm.runInContext('collectorBrowserPool', context);
    client.stop();
    const collect = vm.runInContext('collectSellerOnlySkusToCollectedProducts', context);
    return { client, collect };
  };
  const first = await makeBrowser();
  await first.client.tick();
  assert.equal(pool.status('tenant-a').available_workers, 2);
  const originalInstance = await first.client.instanceId();
  const pending = first.collect({ skus: ['9001', '9002'], baseProducts: [{ sku: '9001', cardPrice: 15 }, { sku: '9002', cardPrice: 25 }] }, { tab: { id: 9 } });
  const drive = setInterval(() => { void first.client.tick(); }, 10);
  t.after(() => clearInterval(drive));
  const waitUntil = async (predicate) => {
    const until = Date.now() + 5000;
    while (!predicate()) { assert.ok(Date.now() < until, 'fixture progress deadline'); await new Promise((resolve) => setTimeout(resolve, 10)); }
  };
  await waitUntil(() => progress.filter((item) => item.partial).length === 2 && holds.length === 2);
  const batchId = received.find((item) => item.url.endsWith('/batches')).body;
  assert.deepEqual(batchId.skus, ['9001', '9002']);
  assert.equal(progress.filter((item) => !item.partial).length, 0);
  assert.ok(progress.every((item) => item.product.soldCount === 12));
  const restarted = await makeBrowser();
  assert.equal(await restarted.client.instanceId(), originalInstance);
  await restarted.client.tick();
  assert.equal(ozon.filter((item) => item.type === 'sales').length, 2);
  holds.splice(0).forEach((resolve) => resolve());
  const result = await pending;
  clearInterval(drive);
  assert.equal(result.successCount, 2);
  assert.ok(result.results.every((item) => item.success && !item.partial));
  assert.equal(result.results.find((item) => item.sku === '9001').product.cardPrice, 15);
  assert.equal(new Set(ozon.map((item) => item.company)).size, 2);
  for (const sku of ['9001', '9002']) assert.equal(new Set(ozon.filter((item) => item.sku === sku).map((item) => item.tabId)).size, 1);
  assert.doesNotMatch(JSON.stringify(received), /BROWSER_COOKIE_MUST_STAY_LOCAL|"raw"/);
  const count = ozon.length;
  const cached = await restarted.collect({ skus: ['9001', '9002'] }, { tab: { id: 9 } });
  assert.equal(cached.successCount, 2);
  assert.equal(ozon.length, count);
  failBatchPolling = true;
  const interrupted = await restarted.collect({ skus: ['9003', '9004'] }, { tab: { id: 9 } });
  assert.equal(interrupted.successCount, 0);
  assert.equal(interrupted.failCount, 2);
  assert.equal(ozon.length, count);
  assert.ok(received.every((item) => item.url.includes('/collector-browser-pool/')));
  failBatchPolling = false;
  loseCreateResponse = true;
  const unknown = await restarted.collect({ skus: ['9005'] }, { tab: { id: 9 } });
  assert.ok([...pool.tasks.values()].some((task) => task.sku === '9005'));
  assert.equal(unknown.failCount, 1);
  assert.match(unknown.results[0].error, /提交状态未知/);
  assert.equal(ozon.length, count);
  assert.equal(received.filter((item) => item.url.endsWith('/batches') && item.body.skus.includes('9005')).length, 1);
});
