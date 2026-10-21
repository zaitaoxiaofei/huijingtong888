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
  assert.match(nextRequestsSource, /currentSellerCompanyId\(tab\?\.id\)/);
  assert.doesNotMatch(nextRequestsSource, /panelState\.currentCompanyId/);
  assert.match(source, /const requests = await getNextCollectRequests\(tab\)/);
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
