import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../ozon-erp-collector-plugin/seller-cookie-context.js', import.meta.url), 'utf8');
const tab = { id: 7, url: 'https://seller.ozon.ru/app/analytics/graphs' };
const company = (value, extra = {}) => ({ name: 'sc_company_id', value, path: '/', domain: 'seller.ozon.ru', storeId: 'one', ...extra });
function harness({ ordinary = [], partitioned = [], key, noPartitionApi = false, stores } = {}) {
  const calls = [];
  const chrome = { cookies: {
    getAllCookieStores: async () => stores || [{ id: 'one', tabIds: [7] }, { id: 'other', tabIds: [8] }],
    getAll: async (query) => { calls.push(query); return query.partitionKey ? partitioned : ordinary; },
    ...(noPartitionApi ? {} : { getPartitionKey: async (frame) => { assert.deepEqual(JSON.parse(JSON.stringify(frame)), { tabId: 7, frameId: 0 }); return { partitionKey: key }; } })
  } };
  const context = { chrome, URL };
  vm.runInNewContext(source, context);
  return { ...context.OzonSellerCookieContext, calls, chrome };
}

test('the live frame partition recovers identity while every query stays in its tab cookie store', async () => {
  const key = { topLevelSite: 'https://ozon.ru', hasCrossSiteAncestor: false };
  const h = harness({ ordinary: [{ name: 'session', value: 'fixture', path: '/' }], partitioned: [company('1001', { partitionKey: key })], key });
  const result = await h.read(tab, { pageCompanyId: '1001', storeId: 'one' });
  assert.equal(result.code, '');
  assert.equal(result.companyId, '1001');
  assert.equal(result.storeId, 'one');
  assert.equal(result.cookies.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [
    { url: tab.url, storeId: 'one' }, { url: tab.url, storeId: 'one', partitionKey: key }
  ]);
});

test('older Chrome remains compatible with verified unpartitioned identity', async () => {
  const h = harness({ ordinary: [company('1001')], noPartitionApi: true });
  assert.equal((await h.read(tab, { pageCompanyId: '1001' })).companyId, '1001');
  assert.equal(h.calls.length, 1);
});

test('an empty or unavailable frame key never queries every partition or invents a key', async () => {
  for (const key of [undefined, {}, { hasCrossSiteAncestor: false }]) {
    const h = harness({ key });
    const result = await h.read(tab, { pageCompanyId: '1001' });
    assert.equal(result.companyId, '');
    assert.equal(h.calls.length, 1);
  }
});

test('page identity cannot fill missing cookies and different current cookie identities fail closed', async () => {
  for (const ordinary of [[], [company('other')], [company('1001'), company('other', { path: '/app' })]]) {
    const h = harness({ ordinary, noPartitionApi: true });
    const result = await h.read(tab, { pageCompanyId: '1001' });
    assert.equal(result.companyId, '');
    if (ordinary.length) { assert.equal(result.code, 'STORE_CONTEXT_MISMATCH'); assert.equal(result.cookies.length, 0); }
  }
  const h = harness({ ordinary: [company('1001')], partitioned: [company('other')], key: { topLevelSite: 'https://ozon.ru' } });
  assert.equal((await h.read(tab, { pageCompanyId: '1001' })).code, 'STORE_CONTEXT_MISMATCH');
});

test('stale tab-store assignments and site permission failures never fall back to a different store', async () => {
  const h = harness({ ordinary: [company('1001')] });
  assert.equal((await h.read(tab, { storeId: 'other' })).code, 'COOKIE_STORE_UNAVAILABLE');
  assert.equal(h.calls.length, 0);
  h.chrome.cookies.getAll = async () => { throw new Error('Cannot access site: fixture-secret'); };
  const failed = await h.read(tab);
  assert.equal(failed.code, 'SELLER_TAB_PERMISSION_DENIED');
  assert.ok(!JSON.stringify(failed).includes('fixture-secret'));
});

test('optional partition API rejection preserves verified ordinary cookies', async () => {
  for (const stage of ['key', 'cookies']) {
    const h = harness({ ordinary: [company('4493649')], key: { topLevelSite: 'https://ozon.ru' } });
    if (stage === 'key') h.chrome.cookies.getPartitionKey = async () => { throw new Error('unsupported fixture-secret'); };
    else {
      const getAll = h.chrome.cookies.getAll;
      h.chrome.cookies.getAll = async query => { if (query.partitionKey) throw new Error('unsupported fixture-secret'); return getAll(query); };
    }
    const result = await h.read(tab, { pageCompanyId: '4493649' });
    assert.equal(result.companyId, '4493649');
    assert.equal(result.diagnosticCode, 'COOKIE_PARTITION_UNAVAILABLE');
    assert.ok(!JSON.stringify(result).includes('fixture-secret'));
    assert.equal((await h.read(tab, { pageCompanyId: 'other' })).code, 'STORE_CONTEXT_MISMATCH');
  }
});

test('supported cookie aliases recover identity but conflicting aliases fail closed', async () => {
  const h = harness({ ordinary: [{ ...company('4493649'), name: 'company_id' }], noPartitionApi: true });
  assert.equal((await h.read(tab, { pageCompanyId: '4493649' })).companyId, '4493649');
  const conflict = harness({ ordinary: [company('4493649'), { ...company('other'), name: 'seller_company_id' }], noPartitionApi: true });
  assert.equal((await conflict.read(tab)).code, 'STORE_CONTEXT_MISMATCH');
});
