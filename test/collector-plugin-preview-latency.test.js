import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const background = readFileSync(new URL('../ozon-erp-collector-plugin/background.js', import.meta.url), 'utf8');
const content = readFileSync(new URL('../ozon-erp-collector-plugin/content.js', import.meta.url), 'utf8');
function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

test('list preview emits sales before a delayed base request and then completes the original enrichment', async () => {
  let finishBase;
  let baseStarted;
  let imports = 0;
  const ready = new Promise((resolve) => { baseStarted = resolve; });
  const progress = [];
  const requests = [];
  const collect = runInNewContext(
    section(background, 'async function fetchSellerCollectedProductFields(', 'function buildSellerCollectedProductFieldsFromPool(')
    + section(background, 'async function collectSellerOnlySkusToCollectedProducts(', 'function normalizeManualSkuList(')
    + '\ncollectSellerOnlySkusToCollectedProducts', {
      normalizeManualSkuList: (items) => items,
      normalizeBaseProductMap: () => new Map(),
      fetchSellerPoolForList: async () => ({ success: false, code: 'SELLER_POOL_UNAVAILABLE' }),
      requestSellerBridgeDataFromBackground: async (sku, type) => {
        requests.push(type);
        if (type === 'sales') return { items: [{ soldCount: 7, soldSumRub: 70, variantId: 'v1' }] };
        if (type === 'search-sku-base') return new Promise((resolve) => { finishBase = resolve; baseStarted(); });
        return { item: { images: ['image.png'] } };
      },
      buildSellerSalesFields: (sales) => ({ ...sales }),
      hasFilledValue: (value) => value !== undefined && value !== null && value !== '',
      buildSellerBaseInfoFields: () => ({ brand: 'saved brand' }),
      normalizeSellerImages: () => ['image.png'],
      buildSellerVariantFields: () => ({ weight_g: 100 }),
      buildSellerOnlyCollectedProductPayload: (sku, result) => ({ sku, ...result.fields }),
      buildCollectedProductDisplayPayload: (payload) => payload,
      emitAutoCollectListProgress: async (tabId, item) => { assert.equal(tabId, 9); progress.push(item); },
      importCollectedProductPayloadToErpDb: async () => { imports++; }
    });
  const pending = collect({ skus: ['sku-a'], concurrency: 12 }, { tab: { id: 9 } });
  await ready;
  assert.equal(progress.length, 1);
  assert.equal(progress[0].sku, 'sku-a');
  assert.equal(progress[0].partial, true);
  assert.equal(progress[0].stage, 'sales');
  assert.equal(progress[0].product.soldCount, 7);
  assert.equal(progress[0].product.soldSumRub, 70);
  assert.equal(imports, 0);
  finishBase({ variants: [{ variant_id: 'v1' }] });
  const final = await pending;
  assert.equal(progress.length, 2);
  assert.equal(progress[1].partial, undefined);
  assert.equal(final.success, true);
  assert.equal(final.results[0].product.weight_g, 100);
  assert.deepEqual(requests, ['sales', 'search-sku-base', 'variant_v2']);
  assert.equal(imports, 0);
});

test('partial sales retain existing fields, remain incomplete and only affect the matching SKU', () => {
  const state = { lookupCacheBySku: new Map() };
  const apply = runInNewContext(section(content, '  function mergeCollectedProductIntoRow(', '  function renderListRowPanelsBySku(') + '\napplyAutoCollectResultToRows', {
    state, todayDateText: () => '2026-11-05'
  });
  const row = { sku: 'sku-a', price: 15, cardPrice: 15, title: 'current title', productTitle: 'current title', images: ['current.png'], erpLookup: { status: 'stale', product: { productTitle: 'old title', brand: 'keep', category: 'keep category', weight_g: 100, images: ['keep.png'], price: 20, soldCount: 3 } } };
  apply([row], { sku: 'sku-a', success: true, partial: true, product: { soldCount: 0, soldSumRub: 70, brand: 'new brand', category: 'other', weight_g: 999, images: ['other.png'], price: 999 } });
  assert.equal(row.erpLookup.product.soldCount, 0);
  assert.equal(row.erpLookup.product.brand, 'keep');
  assert.deepEqual(row.erpLookup.product.images, ['keep.png']);
  assert.equal(row.erpLookup.product.price, 20);
  assert.equal(row.erpLookup.product.category, 'keep category');
  assert.equal(row.erpLookup.product.weight_g, 100);
  assert.equal(row.price, 15);
  assert.equal(row.cardPrice, 15);
  assert.equal(row.title, 'current title');
  assert.equal(row.productTitle, 'current title');
  assert.deepEqual(row.images, ['current.png']);
  assert.equal(row.erpLookup.status, 'pending');
  assert.equal(row.erpLookup.needsRefresh, true);
  assert.equal(state.lookupCacheBySku.size, 0);
  assert.equal(apply([{ sku: 'sku-b' }], { sku: 'sku-a', success: true, partial: true, product: { soldCount: 99 } }), null);
  apply([row], { sku: 'sku-a', success: true, product: { weight_g: 100 } });
  assert.equal(row.erpLookup.status, 'fresh');
  assert.equal(row.erpLookup.product.soldCount, 0);
  assert.equal(state.lookupCacheBySku.size, 1);
});

test('partial progress on the same detail SKU cannot populate the complete detail cache', () => {
  const state = { listRows: [{ sku: 'sku-a' }], lookupCacheBySku: new Map() };
  const api = runInNewContext(
    section(content, '  function applyDetailAutoCollectResult(', '  function summarizeListLookup(')
    + section(content, '  function mergeCollectedProductIntoRow(', '  function renderListRowPanelsBySku(')
    + section(content, '  function handleAutoCollectProgress(', '  function getListAutoCollectCandidates(')
    + '\n({ handleAutoCollectProgress, applyDetailAutoCollectResult })', {
      state, pageSku: () => 'sku-a', renderListRowPanelsBySku() {}, renderDetailProductPanel() {},
      buildDetailDisplayRow: () => ({}), todayDateText: () => '2026-11-05'
    });
  const partial = { sku: 'sku-a', success: true, partial: true, product: { soldCount: 7 } };
  api.handleAutoCollectProgress(partial);
  api.applyDetailAutoCollectResult('sku-a', { results: [partial] });
  assert.equal(state.lookupCacheBySku.size, 0);
  assert.equal(state.listRows[0].erpLookup.status, 'pending');
  api.handleAutoCollectProgress({ sku: 'sku-a', success: true, collectDate: '2026-11-05', product: { soldCount: 7 } });
  assert.equal(state.lookupCacheBySku.get('sku-a').data.needsRefresh, false);
});

function poolHarness(responses) {
  const config = { base: 'https://erp.hjt888.xyz', tenant: 'admin', token: 'token-a' };
  let now = 1000;
  let calls = 0;
  const request = runInNewContext(section(background, 'async function fetchSellerPoolForList(', 'async function collectSellerOnlySkusToCollectedProducts(') + '\nfetchSellerPoolForList', {
    sellerPoolCooldownUntilByContext: new Map(), Date: { now: () => now },
    getErpBaseUrl: async () => config.base,
    getLocalPluginToken: async () => config.token,
    resolveErpTenantId: async () => config.tenant,
    fetchLocalPluginJson: async (path, options) => {
      assert.equal(options.timeoutMs, 120000);
      const next = responses[Math.min(calls++, responses.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    }
  });
  return { request, config, calls: () => calls, advance: (ms) => { now += ms; } };
}

test('known unavailable pool cools for 60 seconds and credentials, tenant and ERP remain isolated', async () => {
  const pool = poolHarness([{ success: false, code: 'SELLER_POOL_UNAVAILABLE' }]);
  await pool.request(['a']);
  assert.equal(await pool.request(['b']), null);
  assert.equal(pool.calls(), 1);
  pool.config.token = 'token-b';
  await pool.request(['a']);
  pool.config.tenant = 'other';
  await pool.request(['a']);
  pool.config.base = 'https://other.example';
  await pool.request(['a']);
  assert.equal(pool.calls(), 4);
  pool.advance(60000);
  await pool.request(['a']);
  assert.equal(pool.calls(), 5);
});

test('completed all-failure batches cool, partial success and waiting timeouts do not', async () => {
  const failed = poolHarness([{ success: false, results: [{ sku: 'a', success: false, status: 403 }, { sku: 'b', success: false }] }]);
  await failed.request(['a', 'b']);
  assert.equal(await failed.request(['a']), null);
  assert.equal(failed.calls(), 1);
  const duplicate = poolHarness([{ results: [{ sku: 'a', success: false }, { sku: 'a', success: false }] }]);
  await duplicate.request(['a', 'b']);
  await duplicate.request(['a', 'b']);
  assert.equal(duplicate.calls(), 2);
  const mixed = poolHarness([{ results: [{ sku: 'a', success: true }, { sku: 'b', success: false }] }]);
  await mixed.request(['a', 'b']);
  await mixed.request(['a', 'b']);
  assert.equal(mixed.calls(), 2);
  const timeout = poolHarness([new Error('ERP request timed out')]);
  await timeout.request(['a']);
  await timeout.request(['a']);
  assert.equal(timeout.calls(), 2);
});

test('list TTL and deduplication run before entrypoint while unverified prices still wait', async () => {
  let finishPrice;
  let priceStarted;
  const ready = new Promise((resolve) => { priceStarted = resolve; });
  const fetched = [];
  const sent = [];
  const state = {
    autoCollectingSkus: new Set(['busy']), autoCollectAttemptedSkus: new Set(),
    previewFetchedAtBySku: new Map([['fresh', 1000]])
  };
  const collect = runInNewContext(section(content, '  async function enrichBaseProductsFromOzonEntrypoint(', '  function todayDateText(') + '\nautoCollectCollectedProductSkus', {
    state, Date: { now: () => 2000 }, console,
    collector: { fetchProductDetail: async (sku) => { fetched.push(sku); return new Promise((resolve) => { finishPrice = resolve; priceStarted(); }); } },
    mergeOzonEntrypointBaseProduct: (item, detail) => { item.price = detail.price; item.cardPrice = detail.price; },
    resolveLocalPluginRequestContext: async () => ({}),
    sendRuntimeMessageCompat: async (message) => { sent.push(message); return { success: true }; }
  });
  const items = [{ sku: 'busy' }, { sku: 'fresh' }, { sku: 'known', price: 20, ozonEntrypointPriceLoaded: true }, { sku: 'raw', price: 172 }, { sku: 'raw', price: 172 }];
  const pending = collect(items);
  await ready;
  assert.deepEqual(fetched, ['raw']);
  assert.equal(sent.length, 0);
  finishPrice({ price: 15 });
  await pending;
  assert.equal(sent.length, 1);
  assert.deepEqual(Array.from(sent[0].skus), ['known', 'raw']);
  assert.equal(sent[0].baseProducts.length, 2);
  assert.equal(sent[0].baseProducts.find((item) => item.sku === 'known').price, 20);
  assert.equal(sent[0].baseProducts.find((item) => item.sku === 'raw').price, 15);
  await collect(items);
  assert.equal(sent.length, 1);
  assert.deepEqual(fetched, ['raw']);
});
