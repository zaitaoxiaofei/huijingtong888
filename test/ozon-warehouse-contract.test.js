import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fetchOzonWarehouses } from '../src/ozonClient.js';

const SHOP = { id: 1, name: 'Fixture', ozon_client_id: 'fixture-client', ozon_api_key: 'fixture-key' };
const warehouse = (id, extra = {}) => ({ warehouse_id: id, name: `Warehouse ${id}`, status: 'active', ...extra });
const json = (data, status = 200) => ({ ok: status === 200, status, headers: new Headers(), text: async () => JSON.stringify(data) });
function mock(t, run) { const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; }); globalThis.fetch = run; }

test('short and archived-only pages follow has_next; archived warehouses remain excluded', async t => {
  const calls = [];
  mock(t, async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    return json(calls.length === 1 ? { warehouses: [warehouse(1, { status: 'archived' })], cursor: 'page2', has_next: true }
      : { warehouses: [warehouse(2), warehouse(3, { is_rfbs: true })], cursor: '', has_next: false });
  });
  const result = await fetchOzonWarehouses(SHOP);
  assert.deepEqual(calls.map(c => c.body), [{ limit: 200, cursor: '' }, { limit: 200, cursor: 'page2' }]);
  assert.deepEqual(result.map(row => row.warehouse_id), ['2','3']); assert.equal(result[1].is_rfbs, true);
});

test('explicit completed empty list is distinct from missing or legacy response fields', async t => {
  mock(t, async () => json({ warehouses: [], has_next: false }));
  assert.deepEqual(await fetchOzonWarehouses(SHOP), []);
  for (const invalid of [{}, { result: [] }, { warehouses: [] }, { warehouses: [], has_next: 'false' }, { warehouses: [{ name: 'missing id' }], has_next: false }]) {
    globalThis.fetch = async () => json(invalid);
    await assert.rejects(fetchOzonWarehouses(SHOP), /响应格式|无法确认编号/);
  }
});

test('broken cursors, duplicate IDs and empty intermediate pages fail without returning a partial list', async t => {
  mock(t, async () => json({}));
  for (const second of [
    { warehouses: [warehouse(2)], has_next: true, cursor: 'same' },
    { warehouses: [warehouse(2)], has_next: true },
    { warehouses: [], has_next: true, cursor: 'next' },
    { warehouses: [warehouse(1)], has_next: false }
  ]) {
    let calls = 0;
    globalThis.fetch = async () => json(++calls === 1 ? { warehouses: [warehouse(1)], has_next: true, cursor: 'same' } : second);
    await assert.rejects(fetchOzonWarehouses(SHOP), /分页|重复仓库/); assert.equal(calls,2);
  }
});

test('permission failure on a later page never returns earlier warehouses or calls retired v1', async t => {
  const paths = [];
  mock(t, async url => {
    paths.push(new URL(url).pathname);
    return paths.length === 1 ? json({ warehouses: [warehouse(1)], has_next: true, cursor: 'next' }) : json({ message: 'Forbidden' },403);
  });
  await assert.rejects(fetchOzonWarehouses(SHOP), error => error.statusCode === 403);
  assert.deepEqual(paths, ['/v2/warehouse/list','/v2/warehouse/list']);
});

test('authorization is refreshed for each page and revoked access stops before another request', async t => {
  const keys = []; let checks = 0;
  mock(t, async (_url, options) => {
    keys.push(options.headers['Api-Key']);
    return json({ warehouses: [warehouse(keys.length)], has_next: keys.length === 1, cursor: keys.length === 1 ? 'next' : '' });
  });
  await fetchOzonWarehouses(SHOP, { beforeRequest: async () => ({ ...SHOP, ozon_api_key: `rotated-${++checks}` }) });
  assert.deepEqual(keys, ['rotated-1','rotated-2']);
  keys.length = 0;
  await assert.rejects(fetchOzonWarehouses(SHOP, { afterRequest: async () => { throw Object.assign(new Error('access revoked'), { statusCode: 403 }); } }), /access revoked/);
  assert.equal(keys.length,1);
});

test('cancelled reads do not send requests', async t => {
  let calls = 0; mock(t, async () => { calls++; return json({}); });
  const controller = new AbortController(); controller.abort(new Error('cancelled fixture'));
  await assert.rejects(fetchOzonWarehouses(SHOP, { signal: controller.signal }), /cancelled fixture/); assert.equal(calls,0);
});

const view = readFileSync(new URL('../frontend/admin/views/inventory/OnlineProductsView.vue', import.meta.url), 'utf8');
const load = view.match(/async function loadWarehousesForStock\([^]*?\n}/)[0];
function viewFixture(request) {
  const state = { warehouses: [] }, stockForm = { shop_id: 1, warehouse_id: '' }, loading = { value: false }, error = { value: '' }, cache = new Map();
  const context = vm.createContext({ state, stockForm, warehousesLoading: loading, warehousesError: error, warehouseCacheByShop: cache,
    warehouseRequestVersion: 0, authStore: { user: { tenant: { id: 2 } } }, currentApiCacheScope: () => 'tenant-2', apiClient: { get: request }, ElMessage: { error() {} } });
  vm.runInContext(load, context);
  return { load: context.loadWarehousesForStock, state, stockForm, loading, error, cache };
}

test('a failed forced refresh invalidates the old cache and leaves no writeable warehouse selection', async () => {
  let calls = 0;
  const f = viewFixture(async () => { if (++calls === 1) return { warehouses: [{ warehouse_id: '7' }] }; throw new Error('warehouse API unavailable'); });
  await f.load(1); assert.equal(f.stockForm.warehouse_id, '7');
  await f.load(1,true); assert.equal(f.stockForm.warehouse_id,''); assert.equal(f.cache.size,0); assert.match(f.error.value,/unavailable/);
  await f.load(1); assert.equal(calls,3); assert.equal(f.state.warehouses.length,0);
});

test('an older warehouse response cannot replace the latest shop selection', async () => {
  let first;
  const f = viewFixture(() => new Promise(resolve => { first = resolve; }));
  const pending = f.load(1);
  f.stockForm.shop_id = 2;
  first({ warehouses: [{ warehouse_id: 'old' }] }); await pending;
  assert.equal(f.state.warehouses.length,0); assert.equal(f.stockForm.warehouse_id,''); assert.equal(f.cache.size,0);
});

test('out-of-order responses for the same shop cannot roll back the latest verified list', async () => {
  const complete = [];
  const f = viewFixture(() => new Promise(resolve => complete.push(resolve)));
  const first = f.load(1,true), second = f.load(1,true);
  complete[1]({ warehouses: [{ warehouse_id: 'new' }] }); await second;
  complete[0]({ warehouses: [{ warehouse_id: 'old' }] }); await first;
  assert.equal(f.stockForm.warehouse_id,'new'); assert.equal(f.cache.get('2:1').rows[0].warehouse_id,'new'); assert.equal(f.loading.value,false);
});
