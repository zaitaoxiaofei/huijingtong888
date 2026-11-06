import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync('ozon-erp-collector-plugin/analytics/background.js', 'utf8');
const tab = { id: 7, url: 'https://seller.ozon.ru/app/analytics/graphs' };

function harness({ helper, cookies = [], pageCompanies = ['1001'], realHelper = false, partitionedCookies = [] } = {}) {
  const calls = [];
  const event = () => ({ addListener() {}, removeListener() {} });
  let pageReads = 0;
  const chrome = {
    runtime: { id: 'unified', getManifest: () => ({ version: '1.5.1' }), onMessage: event(), onInstalled: event(), onStartup: event() },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    tabs: { query: async () => [], onUpdated: event(), onRemoved: event() },
    webRequest: { onBeforeSendHeaders: event(), onHeadersReceived: event() },
    scripting: { executeScript: async () => {
      calls.push({ type: 'page' });
      return [{ result: { companyId: pageCompanies[Math.min(pageReads++, pageCompanies.length - 1)] } }];
    } },
    cookies: {
      getAllCookieStores: async () => [{ id: 'actual-store', tabIds: [7] }],
      getAll: async query => { calls.push({ type: 'legacy', query }); return query.partitionKey ? partitionedCookies : cookies; }
    }
  };
  const context = vm.createContext({ chrome, URL, URLSearchParams, AbortController,
    OzonUnifiedConfig: { get: async () => ({ erpBaseUrl: 'https://erp.hjt888.xyz', tenantId: 'tenant', localPluginToken: '' }) },
    OzonUnifiedRuntime: { setAnalyticsBadge() {}, withAnalyticsPreparation: run => run() },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: async (url, options) => { calls.push({ type: 'fetch', url, options }); return { ok: true, status: 200, json: async () => ({ success: true, requests: [{ request_id: 'fixture-request', store_id: '1001' }] }) }; }
  });
  if (helper) context.OzonSellerCookieContext = { read: async (selectedTab, options) => {
    calls.push({ type: 'helper', tab: selectedTab, options });
    return helper(selectedTab, options);
  } };
  if (realHelper) {
    chrome.cookies.getPartitionKey = async details => {
      calls.push({ type: 'partition', details });
      return { partitionKey: { topLevelSite: 'https://ozon.ru', hasCrossSiteAncestor: false } };
    };
    vm.runInContext(fs.readFileSync('ozon-erp-collector-plugin/seller-cookie-context.js', 'utf8'), context);
  }
  vm.runInContext(source.replace('})(globalThis);', 'global.__cookieAdapter = { getOzonCookieInfo, verifiedSellerStoreIdentity, assertCollectStoreContext, getNextCollectRequests, waitForSellerAuthContext, proof(tabId, observed, company, age = 0, ok = true) { latestContextHeadersByTab.set(tabId, { "x-o3-company-id": observed, updated_at: Date.now() - age }); latestAnalyticsTableByTab.set(tabId, { company_id: company, ok, updated_at: Date.now() - age }); } };\n})(globalThis);'), context);
  return { calls, adapter: context.__cookieAdapter };
}

test('generated analytics reads the live page before shared cookie context and preserves returned cookie order', async () => {
  const h = harness({ helper: async () => ({ cookies: [
    { name: 'sc_company_id', value: '1001' },
    { name: 'seller_session', value: 'session' },
    { name: 'parent_session', value: 'parent' },
    { name: 'empty', value: '' }
  ], companyId: '1001', storeId: 'actual-store' }) });
  const info = await h.adapter.getOzonCookieInfo(tab);
  assert.deepEqual(h.calls.map(call => call.type), ['page', 'helper']);
  assert.equal(h.calls[1].tab, tab);
  assert.deepEqual(Object.keys(h.calls[1].options), ['pageCompanyId']);
  assert.equal(h.calls[1].options.pageCompanyId, '1001');
  assert.equal(info.header, 'sc_company_id=1001; seller_session=session; parent_session=parent; empty=');
  assert.equal(info.companyId, '1001');
  assert.equal(info.storeId, 'actual-store');
  assert.equal((await h.adapter.verifiedSellerStoreIdentity(tab, '1001')).ok, true);
  assert.equal(h.calls.some(call => call.type === 'legacy'), false);
});

test('generated analytics retains a helper conflict as identity conflict and never returns its cookie header', async () => {
  const h = harness({ helper: async () => ({
    cookies: [{ name: 'sc_company_id', value: '1001' }, { name: 'secret', value: 'must-not-escape' }],
    companyId: '1001', storeId: 'actual-store', code: 'STORE_CONTEXT_MISMATCH'
  }) });
  const info = await h.adapter.getOzonCookieInfo(tab);
  assert.equal(info.header, '');
  assert.equal(info.companyId, '');
  assert.equal(info.code, 'STORE_CONTEXT_MISMATCH');
  const identity = await h.adapter.verifiedSellerStoreIdentity(tab, '1001');
  assert.equal(identity.ok, false);
  assert.equal(identity.code, 'identity_conflict');
  assert.equal(identity.companyId, '');
  assert.doesNotMatch(JSON.stringify(identity), /must-not-escape/);
});

test('generated analytics keeps unavailable identity distinct from conflict and catches a later page shop change', async () => {
  const unavailable = harness({ helper: async () => ({ cookies: [], companyId: '', code: 'STORE_IDENTITY_UNAVAILABLE' }) });
  assert.equal((await unavailable.adapter.verifiedSellerStoreIdentity(tab, '1001')).code, 'identity_missing');
  const switched = harness({ pageCompanies: ['1001', '1002'], helper: async () => ({
    cookies: [{ name: 'sc_company_id', value: '1001' }], companyId: '1001', storeId: 'actual-store'
  }) });
  assert.equal((await switched.adapter.verifiedSellerStoreIdentity(tab, '1001')).code, 'identity_conflict');
});

test('generated analytics retains the legacy same-store lookup when the shared helper is absent', async () => {
  const h = harness({ cookies: [
    { name: 'sc_company_id', value: '1001' }, { name: 'parent_session', value: 'parent' }, { name: 'sc_company_id', value: '1002' }
  ] });
  const info = await h.adapter.getOzonCookieInfo(tab);
  assert.equal(info.header, 'sc_company_id=1001; parent_session=parent; sc_company_id=1002');
  assert.equal(info.companyId, '1001');
  const query = h.calls.find(call => call.type === 'legacy').query;
  assert.equal(query.url, tab.url);
  assert.equal(query.storeId, 'actual-store');
  assert.equal((await h.adapter.verifiedSellerStoreIdentity(tab, '1001')).ok, true);
});

test('real generated analytics and shared helper recover a partitioned company from the exact tab store', async () => {
  const h = harness({ realHelper: true, cookies: [{ name: 'parent_session', value: 'parent', path: '/' }], partitionedCookies: [
    { name: 'sc_company_id', value: '1001', path: '/app', partitionKey: { topLevelSite: 'https://ozon.ru', hasCrossSiteAncestor: false } }
  ] });
  const info = await h.adapter.getOzonCookieInfo(tab);
  assert.equal(info.header, 'sc_company_id=1001; parent_session=parent');
  assert.equal(info.companyId, '1001');
  const queries = h.calls.filter(call => call.type === 'legacy').map(call => call.query);
  assert.equal(queries.length, 2);
  assert.ok(queries.every(query => query.storeId === 'actual-store' && query.url === tab.url));
  assert.deepEqual(Object.keys(queries[1].partitionKey).sort(), ['hasCrossSiteAncestor', 'topLevelSite']);
  assert.equal(queries[1].partitionKey.topLevelSite, 'https://ozon.ru');
  assert.equal(queries[1].partitionKey.hasCrossSiteAncestor, false);
  assert.equal((await h.adapter.verifiedSellerStoreIdentity(tab, '1001')).ok, true);
});

test('real generated analytics and shared helper preserve conflicting unpartitioned and partitioned identity as conflict', async () => {
  const h = harness({ realHelper: true, cookies: [{ name: 'sc_company_id', value: '1002' }], partitionedCookies: [
    { name: 'sc_company_id', value: '1001', partitionKey: { topLevelSite: 'https://ozon.ru', hasCrossSiteAncestor: false } }
  ] });
  assert.equal((await h.adapter.getOzonCookieInfo(tab)).header, '');
  const identity = await h.adapter.verifiedSellerStoreIdentity(tab, '1001');
  assert.equal(identity.ok, false);
  assert.equal(identity.code, 'identity_conflict');
});


test('missing extension cookies permit queue claim and store guards only with fresh same-tab browser proof', async () => {
  const h = harness({ helper: async () => ({ cookies: [], companyId: '', code: 'COOKIE_STORE_UNAVAILABLE' }) });
  assert.equal((await h.adapter.verifiedSellerStoreIdentity(tab, '1001')).ok, false);
  h.adapter.proof(tab.id, '1001', '1001');
  const identity = await h.adapter.verifiedSellerStoreIdentity(tab, '1001');
  assert.equal(identity.ok, true);
  assert.equal(identity.auth_mode, 'browser_only');
  assert.equal(await h.adapter.assertCollectStoreContext('1001', tab), '1001');
  const requests = await h.adapter.getNextCollectRequests(tab);
  assert.equal(requests[0].request_id, 'fixture-request');
  const claim = h.calls.find(x => x.type === 'fetch' && x.url.includes('collect-runs/next'));
  assert.equal(new URL(claim.url).searchParams.get('store_id'), '1001');
  assert.ok(!h.calls.some(x => x.type === 'fetch' && /auth-probe|auth-bindings/.test(x.url)));
  const prepare = await h.adapter.waitForSellerAuthContext(tab, { store_id: '1001' }, 100);
  assert.equal(prepare.success, true);
  assert.equal(prepare.warning, 'BROWSER_COLLECT_ONLY');
  const auth = await h.adapter.waitForSellerAuthContext(tab, { store_id: '1001', bind_auth_only: true }, 100);
  assert.equal(auth.success, false);
  assert.equal(auth.error, 'SERVER_AUTH_COOKIE_UNAVAILABLE');
});

test('browser proof cannot hide conflicts, stale evidence, failed requests, or another tab', async () => {
  const missing = async () => ({ cookies: [], companyId: '', code: 'COOKIE_COMPANY_ID_MISSING' });
  for (const proof of [
    [tab.id, '1001', '1001', 61000],
    [tab.id, '1001', '1001', 0, false],
    [tab.id + 1, '1001', '1001'],
    [tab.id, '', '1001'],
    [tab.id, '1001', 'other'],
    [tab.id, 'other', 'other']
  ]) {
    const h = harness({ helper: missing }); h.adapter.proof(...proof);
    assert.equal((await h.adapter.verifiedSellerStoreIdentity(tab, '1001')).ok, false);
  }
  const switched = harness({ helper: missing }); switched.adapter.proof(tab.id, '1001', '1001');
  assert.equal((await switched.adapter.verifiedSellerStoreIdentity(tab, 'other')).code, 'store_mismatch');
  await assert.rejects(switched.adapter.assertCollectStoreContext('other', tab));
  const conflict = harness({ helper: async () => ({ cookies: [], companyId: '', code: 'STORE_CONTEXT_MISMATCH' }) });
  conflict.adapter.proof(tab.id, '1001', '1001');
  assert.equal((await conflict.adapter.verifiedSellerStoreIdentity(tab, '1001')).code, 'identity_conflict');
  const changedPage = harness({ helper: missing, pageCompanies: ['1001', 'other'] });
  changedPage.adapter.proof(tab.id, '1001', '1001');
  assert.equal((await changedPage.adapter.verifiedSellerStoreIdentity(tab, '1001')).ok, false);
});
