import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const declaration = name => source.match(new RegExp('^(?:export )?(?:async )?function ' + name + '\\([^]*?^}', 'm'))[0].replace(/^export /, '');
function fixture({ empty = false, stockError = false } = {}) {
  const shop = { id: 11, status: 'active', name: 'Own shop' };
  const products = empty ? [] : [888, 666, 555, 555, 100].map((stock, i) => ({ ozon_product_id: String(i + 1), ozon_sku: String(100 + i), stocks: { stock } }));
  const saved = [], snapshots = [], reads = [];
  const context = vm.createContext({
    Map, Set, Date, String, Number, Boolean, Math, Promise, Object, Array, Error,
    ensureMysqlCutoverEnabled() {}, nullableNumber: value => Number(value) || null,
    resolveInventoryTenantScope: async () => ({ id: 590, predicate: () => ({ sql: 'tenant_id = ?' }) }),
    assertOrderTaskAccessMysql: async () => {}, assertInventoryReferences: async () => {},
    assertInventoryRecord: async (scope, kind, id) => { assert.equal(scope.id, 590); assert.equal(kind, 'shop'); assert.equal(id, 11); return shop; },
    mysqlQuery: async sql => sql.startsWith('SELECT * FROM shops') ? [shop] : [],
    mysqlExecute: async () => ({}), fetchOzonProducts: async () => products,
    fetchOzonProductStocks: async (current, options) => {
      assert.equal(current.id, 11); await options.beforeRequest(); reads.push(Array.from(options.productIds));
      if (stockError) throw new Error('stock read failed');
      await options.afterRequest(); return products.map(p => ({ ozon_product_id: p.ozon_product_id, available: p.stocks.stock }));
    },
    refreshPendingListingStockSnapshotsMysql: async (id, ids, rows, check) => { await check(); snapshots.push({ id, ids: Array.from(ids), quantities: rows.map(r => r.available) }); },
    upsertOnlineProductDualWrite: async (id, item, options) => { await options.beforeWrite(); saved.push(item); },
    recordOzonSyncHealth: async () => {}, invalidateMasterDataCachePrefix() {}, requestPublicMediaStream() {}
  });
  vm.runInContext(['syncOzonOnlineProductsMysql', 'mapWithConcurrencyMysql'].map(declaration).join('\n'), context);
  return { saved, snapshots, reads, run: body => context.syncOzonOnlineProductsMysql(body, { session: { personId: 1 }, tenantId: 590 }) };
}

test('full sync preserves all five stocked products and refreshes only their original shop snapshots', async () => {
  const f = fixture(); const result = await f.run({ shop_id: 11, include_stocks: true });
  assert.equal(result.upserted, 5); assert.equal(result.scope, 'all');
  assert.deepEqual(f.reads, [[1, 2, 3, 4, 5]]);
  assert.deepEqual(f.snapshots[0], { id: 11, ids: [1, 2, 3, 4, 5], quantities: [888, 666, 555, 555, 100] });
  assert.equal(f.saved.length, 5);
});
test('empty catalog never issues an unfiltered stock read or clears existing snapshots', async () => {
  const f = fixture({ empty: true }); await f.run({ include_stocks: true });
  assert.equal(f.reads.length, 0); assert.equal(f.snapshots.length, 0);
});
test('failed stock read cannot clear stock snapshots or report success', async () => {
  const f = fixture({ stockError: true }); await assert.rejects(f.run({ include_stocks: true }), /stock read failed/);
  assert.equal(f.snapshots.length, 0); assert.equal(f.saved.length, 0);
});
test('existing callers do not silently gain additional stock sync work', async () => {
  const f = fixture(); await f.run({}); assert.equal(f.reads.length, 0); assert.equal(f.saved.length, 5);
});
