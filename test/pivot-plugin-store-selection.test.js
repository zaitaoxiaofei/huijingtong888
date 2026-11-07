import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync('pivot-table-master/background.js', 'utf8');
const selectionSource = source.slice(
  source.indexOf('function selectSellerTab('),
  source.indexOf('function setPanelSellerTab(')
);

function selectTab(tabs, identities, expectedStoreId = '', pinnedTabId = 0) {
  const context = {
    prepareSellerTabId: pinnedTabId,
    currentSellerCompanyId: (tabId) => identities[tabId] || ''
  };
  return vm.runInNewContext(`${selectionSource}\nselectSellerTab`, context)(tabs, expectedStoreId);
}

function resolveStoreIdentity(observed, cookie, expected = '', page = '') {
  const identitySource = source.slice(
    source.indexOf('function resolveSellerStoreIdentity('),
    source.indexOf('async function verifiedSellerStoreIdentity(')
  );
  return vm.runInNewContext(`${identitySource}\nresolveSellerStoreIdentity`, {})(observed, cookie, expected, page);
}

const oldMartTab = { id: 1, url: 'https://seller.ozon.ru/app/analytics/graphs', active: true, lastAccessed: 100 };
const newMartSTab = { id: 2, url: 'https://seller.ozon.ru/app', active: false, lastAccessed: 200 };

test('prepare selects the requested store instead of an older analytics tab', () => {
  const selected = selectTab([oldMartTab, newMartSTab], { 1: '3570178', 2: '4202503' }, '4202503');
  assert.equal(selected.id, 2);
});

test('prepare tries an unidentified seller tab before a positively mismatched shop', () => {
  const unidentifiedSTab = { ...newMartSTab, lastAccessed: 50 };
  const selected = selectTab([oldMartTab, unidentifiedSTab], { 1: '3570178' }, '4202503');
  assert.equal(selected.id, 2);
});

test('normal status follows the most recently visited seller tab across windows', () => {
  const selected = selectTab([oldMartTab, newMartSTab], { 1: '3570178', 2: '4202503' });
  assert.equal(selected.id, 2);
});

test('same-tab Ozon switch cannot reuse the old request-header identity', () => {
  assert.equal(resolveStoreIdentity('1111', '1111', '1111').ok, true);
  assert.equal(resolveStoreIdentity('1111', '2222', '1111').ok, false);
  assert.equal(resolveStoreIdentity('1111', '', '1111').ok, false);
  assert.equal(resolveStoreIdentity('2222', '2222', '1111').ok, false);
  assert.equal(resolveStoreIdentity('1111', '1111', '1111', '2222').ok, false);
  assert.equal(resolveStoreIdentity('1111', '1111', '1111', '2222').code, 'identity_conflict');
});

test('store preflight reads the current seller page instead of trusting cached headers alone', () => {
  const verifiedSource = source.slice(
    source.indexOf('async function verifiedSellerStoreIdentity('),
    source.indexOf('async function syncPluginStatus(')
  );
  assert.match(verifiedSource, /await readSellerPageCompanyId\(tab\)/);
  const bindSource = source.slice(source.indexOf('async function bindServerSideAuth('), source.indexOf('async function getNextCollectRequests('));
  const probeSource = source.slice(source.indexOf('async function probeServerSideAuth('), source.indexOf('async function postCollectResult('));
  assert.match(bindSource, /await readSellerPageCompanyId\(tab\)/);
  assert.match(probeSource, /await readSellerPageCompanyId\(tab\)/);
});

test('page-reported store mismatch defers a leased task without posting a failed result', async () => {
  const requestSource = source.slice(
    source.indexOf('async function runCollectRequestInSellerTab('),
    source.indexOf('async function assertCollectStoreContext(')
  );
  const context = {
    findAnySellerTab: async () => ({ id: 1 }),
    ensureRelayInjected: async () => {},
    chrome: { tabs: { sendMessage: async () => ({ success: true, payload: { success: false, error: 'STORE_CONTEXT_MISMATCH task=1111 current=2222' } }) } }
  };
  const run = vm.runInNewContext(`${requestSource}\nrunCollectRequestInSellerTab`, context);
  await assert.rejects(run({ store_id: '1111' }, { id: 1 }), (error) => error.code === 'STORE_CONTEXT_MISMATCH');
});

test('an in-progress prepare keeps its chosen tab while it reloads', () => {
  const selected = selectTab([oldMartTab, newMartSTab], { 1: '3570178', 2: '4202503' }, '', 1);
  assert.equal(selected.id, 1);
});

test('store identity never falls back to cached panel state when claiming tasks', () => {
  const nextRequestsSource = source.slice(
    source.indexOf('async function getNextCollectRequests('),
    source.indexOf('async function getNextPrepareRequest(')
  );
  assert.match(nextRequestsSource, /await verifiedSellerStoreIdentity\(tab, preferredSellerStoreId\)/);
  assert.doesNotMatch(nextRequestsSource, /panelState\.currentCompanyId/);
  assert.match(source, /const requests = await getNextCollectRequests\(tab\)/);
});

test('worker restart recovers identity from matching live page and browser cookies', () => {
  assert.equal(resolveStoreIdentity('', '3570178', '3570178', '3570178').companyId, '3570178');
  assert.equal(resolveStoreIdentity('', '3570178', '3570178', '').code, 'identity_missing');
  assert.equal(resolveStoreIdentity('', '3570178', '4202503', '3570178').code, 'store_mismatch');
  assert.equal(resolveStoreIdentity('', '3570178', '3570178', '4202503').code, 'identity_conflict');
  assert.equal(resolveStoreIdentity('4202503', '3570178', '3570178', '3570178').code, 'identity_conflict');
});

test('live page identity reads its current cookie and ignores the plugin historical localStorage cache', async () => {
  const pageSource = source.slice(source.indexOf('async function readSellerPageCompanyId('), source.indexOf('function resolveSellerStoreIdentity('));
  const context = {
    document: { cookie: 'sc_company_id=3570178' },
    window: { localStorage: { getItem: () => '4202503' } },
    chrome: { scripting: { executeScript: async ({ func }) => [{ result: func() }] } }
  };
  const read = vm.runInNewContext(`${pageSource}\nreadSellerPageCompanyId`, context);
  assert.equal((await read({ id: 7 })).companyId, '3570178');
  context.document.cookie = '';
  assert.equal((await read({ id: 7 })).companyId, '');
});

test('cookie identity follows Chrome cookie order and the selected tab cookie store', async () => {
  const cookieSource = source.slice(source.indexOf('async function getOzonCookieInfo('), source.indexOf('function rememberPluginToken('));
  let requestedQuery;
  const getInfo = vm.runInNewContext(`${cookieSource}\ngetOzonCookieInfo`, {
    chrome: { cookies: {
      getAllCookieStores: async () => [{ id: 'regular', tabIds: [1] }, { id: 'incognito', tabIds: [7] }],
      getAll: async (query) => {
        requestedQuery = query;
        return [
          { name: 'sc_company_id', value: '3570178', domain: 'seller.ozon.ru' },
          { name: 'sc_company_id', value: '4202503', domain: '.ozon.ru' }
        ];
      }
    } }
  });
  assert.equal((await getInfo({ id: 7, url: oldMartTab.url })).companyId, '3570178');
  assert.equal(requestedQuery.url, oldMartTab.url);
  assert.equal(requestedQuery.storeId, 'incognito');
});

test('current aligned analytics page is reused after a worker restart without navigation or server probing', async () => {
  const prepareSource = source.slice(source.indexOf('async function runPrepareRequest('), source.indexOf('async function ensureRelayInjected('));
  const calls = [];
  const run = vm.runInNewContext(`${prepareSource}\nrunPrepareRequest`, {
    expectedStoreIdFromPrepare: (request) => request.store_id,
    findAnySellerTab: async () => oldMartTab,
    verifiedSellerStoreIdentity: async () => resolveStoreIdentity('', '3570178', '3570178', '3570178'),
    ensureRelayInjected: async (id) => calls.push(['relay', id]),
    probeServerSideAuth: async () => { throw new Error('server probe must not block browser collection'); },
    ensureSellerAnalyticsGraphsTab: async () => { throw new Error('Navigation rejected.'); },
    panelState: { sellerTab: oldMartTab },
    logPanel: () => {},
    latestContextHeadersByTab: new Map(),
    latestAnalyticsTableByTab: new Map()
  });
  const result = await run({ store_id: '3570178' });
  assert.equal(result.success, true);
  assert.equal(result.current_company_id, '3570178');
  assert.equal(result.auth_warning, 'BROWSER_CONTEXT_READY');
  assert.deepEqual(calls, [['relay', 1]]);
});

test('a real shop conflict cannot reuse an analytics page or navigate away to hide the conflict', async () => {
  const prepareSource = source.slice(source.indexOf('async function runPrepareRequest('), source.indexOf('async function ensureRelayInjected('));
  const run = vm.runInNewContext(`${prepareSource}\nrunPrepareRequest`, {
    expectedStoreIdFromPrepare: (request) => request.store_id,
    findAnySellerTab: async () => oldMartTab,
    verifiedSellerStoreIdentity: async () => resolveStoreIdentity('4202503', '4202503', '3570178', '4202503'),
    ensureRelayInjected: async () => { throw new Error('must not prepare mismatched store'); },
    panelState: { sellerTab: oldMartTab },
    logPanel: () => {}
  });
  const result = await run({ store_id: '3570178' });
  assert.equal(result.success, false);
  assert.equal(result.identity_code, 'store_mismatch');
});

test('worker restart finds the requested live shop across multiple Seller cookie stores', async () => {
  const findSource = source.slice(source.indexOf('async function findAnySellerTab('), source.indexOf('async function ensureSellerAnalyticsGraphsTab('));
  const find = vm.runInNewContext(`${findSource}\nfindAnySellerTab`, {
    prepareSellerTabId: 0,
    chrome: { tabs: { query: async () => [oldMartTab, newMartSTab] } },
    selectSellerTab: () => newMartSTab,
    verifiedSellerStoreIdentity: async (tab, expected) => resolveStoreIdentity('', tab.id === 1 ? '3570178' : '4202503', expected, tab.id === 1 ? '3570178' : '4202503'),
    setPanelSellerTab: () => {}
  });
  assert.equal((await find('3570178')).id, 1);
});

test('queue claim uses recovered live identity and refuses a different ERP shop', async () => {
  const nextSource = source.slice(source.indexOf('async function getNextCollectRequests('), source.indexOf('async function getNextPrepareRequest('));
  const fetches = [];
  const context = {
    preferredSellerStoreId: '3570178',
    BATCH_SIZE: 10,
    URLSearchParams,
    panelState: { lastError: '' },
    verifiedSellerStoreIdentity: async (_tab, expected) => resolveStoreIdentity('', '3570178', expected, '3570178'),
    getErpConfig: async () => ({ erpBaseUrl: 'https://erp.example.test' }),
    syncPluginStatus: async () => {},
    localPluginHeaders: () => ({}),
    logPanel: () => {},
    fetch: async (url) => { fetches.push(url); return { ok: true, json: async () => ({ requests: [{ id: 123 }] }) }; }
  };
  const next = vm.runInNewContext(`${nextSource}\ngetNextCollectRequests`, context);
  assert.equal((await next(oldMartTab))[0].id, 123);
  assert.equal(new URL(fetches[0]).searchParams.get('store_id'), '3570178');
  context.preferredSellerStoreId = '4202503';
  assert.equal((await next(oldMartTab)).length, 0);
  assert.equal(fetches.length, 1);
});

test('navigation rejection identifies the failed stage without treating it as a different shop', async () => {
  const navigationSource = source.slice(source.indexOf('async function navigateSellerTab('), source.indexOf('async function warmSellerAnalyticsPermission('));
  const messages = [];
  const navigate = vm.runInNewContext(`${navigationSource}\nnavigateSellerTab`, {
    chrome: { tabs: { update: async () => { throw new Error('Navigation rejected.'); } } },
    logPanel: (message) => messages.push(message)
  });
  await assert.rejects(navigate(7, oldMartTab.url, 'open_graphs'), /SELLER_NAVIGATION_FAILED stage=open_graphs tab=7: Navigation rejected\./);
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], /STORE_CONTEXT_MISMATCH/);
});

test('navigation clears stale store identity and preparation releases its tab pin', () => {
  assert.match(source, /if \(changeInfo\?\.url \|\| changeInfo\?\.status === 'loading'\) \{\s*latestContextHeadersByTab\.delete\(tabId\)/);
  assert.match(source, /finally \{\s*prepareSellerTabId = 0;\s*preparing = false;/);
});

test('automatic auth binding is throttled by shop and reports stale results accurately', () => {
  assert.match(source, /lastAuthBindingSyncAtByCompany\.get\(resolvedCompanyId\)/);
  assert.match(source, /result\?\.bound && !result\?\.stale/);
  assert.match(source, /ECS 直连探测未通过/);
});

test('ERP wake carries selected shop identity and retries a wake that arrives during preparation', () => {
  const bridge = fs.readFileSync('pivot-table-master/content/erp-instance.js', 'utf8');
  assert.match(bridge, /PIVOT_ERP_COLLECT_WAKE', expectedStoreId/);
  assert.match(source, /findAnySellerTab\(expectedStoreId = preferredSellerStoreId\)/);
  assert.match(source, /if \(preparing\) \{\s*prepareWakePending = true/);
  assert.match(source, /if \(prepareWakePending\) \{[\s\S]*?pollPrepareOnce\(\)\.then\(\(\) => drainCollectQueue\(\)\)/);
});

test('cancelled runs stop queued browser requests and discard results already in flight', () => {
  const processSource = source.slice(
    source.indexOf('async function processCollectRequest('),
    source.indexOf('async function runWithConcurrency(')
  );
  assert.equal((processSource.match(/cancelledCollectRunIds\.has\(request\.run_id\)/g) || []).length, 3);
  assert.match(source, /message\?\.type === 'PIVOT_ERP_COLLECT_CANCEL'/);
  const bridge = fs.readFileSync('pivot-table-master/content/erp-instance.js', 'utf8');
  assert.match(bridge, /BAODAN_ANALYTICS_PLUGIN_CANCEL/);
  assert.match(bridge, /PIVOT_ERP_COLLECT_CANCEL/);
});
