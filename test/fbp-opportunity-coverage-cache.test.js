import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createFbpOpportunityCoverageReader } from '../src/services/fbp-opportunity-coverage-cache.js';
import { inventoryTenantSql } from '../src/services/inventory-tenant-scope.js';
import { filterInventoryProductRows, inventoryBusinessSearch } from '../src/services/inventory-product-search.js';
import { searchInventoryRows } from '../src/services/inventory-search.js';
import { calculateOrderProcurementCoverage } from '../src/services/order-procurement-coverage.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const scope = (id = 1, isDefault = true) => ({ id, isDefault });

test('FBP read snapshots expire twenty seconds after completion and isolate enterprise/default ownership', async () => {
  let time = 0, epoch = 0, calls = 0;
  const read = createFbpOpportunityCoverageReader({ revision: () => epoch, now: () => time, load: async () => { calls++; time += 9000; return new Map([[calls, calls]]); } });
  const first = await read(scope());
  time = 28_999; assert.equal(await read(scope()), first); assert.equal(calls, 1);
  time = 29_000; assert.notEqual(await read(scope()), first); assert.equal(calls, 2);
  await read(scope(2, false)); await read(scope(1, false)); assert.equal(calls, 4);
  epoch++; await read(scope()); assert.equal(calls, 5);
  await assert.rejects(read(scope(0)), /scope/);
});

test('fresh bypasses completed data while same-epoch requests share pending work and failures never cache', async () => {
  let calls = 0, gate = deferred();
  const read = createFbpOpportunityCoverageReader({ revision: () => 0, load: () => { calls++; return gate.promise; } });
  const first = read(scope()), concurrentFresh = read(scope(), { fresh: true });
  gate.resolve(new Map([[1, 'first']])); assert.equal(await first, await concurrentFresh); assert.equal(calls, 1);
  gate = deferred(); const refreshed = read(scope(), { fresh: true }), sharing = read(scope());
  gate.reject(new Error('database busy'));
  await assert.rejects(refreshed, /database busy/); await assert.rejects(sharing, /database busy/);
  gate = deferred(); const retry = read(scope()); gate.resolve(new Map([[1, 'retry']]));
  assert.equal((await retry).get(1), 'retry'); assert.equal(calls, 3);
});

test('old epochs cannot publish or delete a newer snapshot when their pending work resolves or fails', async () => {
  for (const rejectOld of [false, true]) {
    let epoch = 0, calls = 0;
    const old = deferred(), current = new Map([[1, 'current']]);
    const read = createFbpOpportunityCoverageReader({ revision: () => epoch, load: async () => ++calls === 1 ? old.promise : current });
    const previous = read(scope()); epoch++;
    assert.equal(await read(scope()), current);
    if (rejectOld) { old.reject(new Error('old failure')); await assert.rejects(previous, /old failure/); }
    else { old.resolve(new Map([[1, 'old']])); await previous; }
    assert.equal(await read(scope()), current); assert.equal(calls, 2);
  }
});

const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const pureStart = source.indexOf('function fbpOpportunityPriority(');
const entryStart = source.indexOf('export async function fbpOpportunitiesMysql(');
const entryEnd = source.indexOf('export async function ignoreFbpReplenishmentMysql(', entryStart);
const readerStart = source.indexOf('const readFbpOpportunityCoverageMysql =');
const readerEnd = source.indexOf('\n});', readerStart) + 4;
const serialize = value => JSON.parse(JSON.stringify(value));

function serviceFixture({ legacy = false, rows, coverage }) {
  let epoch = 0;
  const cache = new Map(), calls = { base: 0, filters: 0, coverage: [], authorization: 0 };
  const resolvedScope = { ...scope(), predicate: alias => ({ sql: inventoryTenantSql(scope(), alias), params: [1] }) };
  const context = vm.createContext({
    createFbpOpportunityCoverageReader, workflowRevision: () => epoch,
    ensureMysqlCutoverEnabled() {}, resolveInventoryTenantScope: async () => resolvedScope,
    authorizeBusinessTaskSession: async () => { calls.authorization++; return { tenant: { id: 1 } }; }, assertBusinessTaskPermission() {},
    ...Object.fromEntries(['ensureProductNamingSchemaMysql', 'ensureOzonStockStorageSchemaMysql', 'ensureStockLocationSchemaMysql', 'ensureProductBarcodeLabelCacheReadyMysql', 'ensureFbpTransferRecordsSchemaMysql', 'ensureFbpReplenishmentSchemaMysql'].map(key => [key, async () => {}])),
    inventoryTenantSql, filterInventoryProductRows, inventoryBusinessSearch, searchInventoryRows,
    getCachedMasterData: async (key, load) => { if (!cache.has(key)) cache.set(key, await load()); return cache.get(key); },
    invalidateMasterDataCache: key => cache.delete(key),
    mysqlQuery: async sql => {
      if (sql.startsWith('SELECT p.id FROM products p')) { calls.filters++; return rows.map(row => ({ id: row.product_id })); }
      assert.match(sql, /sm\.id AS mapping_id/); calls.base++; return rows;
    },
    loadOrderProcurementCoverage: async (query, open, options) => { calls.coverage.push(options); return coverage; },
    inventoryScopeCoverageMysql: async () => { calls.coverage.push({ productIds: Array.from({ length: 970 }, (_, i) => i + 1), fresh: true }); return coverage; },
    chinaDateSqlMysql: value => `DATE(${value})`, fbpTransferInTransitWhereMysql: () => '(1=1)',
    dateKeyDaysAgoMysql: () => '2026-11-01', FBP_OPPORTUNITY_CACHE_TTL_MS: 30_000, parseWarehouseBreakdown: () => []
  });
  let entry = source.slice(entryStart, entryEnd).replace('export ', '');
  if (legacy) entry = entry.replace('readFbpOpportunityCoverageMysql(scope, { fresh: forceRefresh })', 'inventoryScopeCoverageMysql(scope)');
  vm.runInContext(source.slice(readerStart, readerEnd) + source.slice(pureStart, entryStart) + entry, context);
  return { calls, read: query => context.fbpOpportunitiesMysql(query, 1, { session: {} }), invalidate: () => epoch++ };
}

test('real FBP function pages/filter/sort retain every suggestion and summary while warm reads share complete tenant coverage', async () => {
  const rows = Array.from({ length: 67 }, (_, i) => ({
    mapping_id: i + 1, product_id: i % 30 + 1, shop_id: i % 3 + 1, ozon_sku: String(9000000000 + i),
    product_name: `inventory ${i}`, online_name: `listing ${i}`, inventory_number: `1-2-${i % 30 + 1}`,
    recent_30d_qty: 25 + i, recent_7d_qty: 12, week1_qty: 12, week2_qty: 10, week3_qty: 8,
    fbp_available: i % 3, fbs_available: i % 7, fbp_transfer_in_transit_qty: i % 5
  }));
  const coverage = calculateOrderProcurementCoverage({
    demands: [{ order_id: 1, order_item_id: 1, product_id: 1, quantity: 3, needs_fulfillment: 1, stock_location: 'LOCAL' }],
    stocks: Array.from({ length: 30 }, (_, i) => ({ product_id: i + 1, ledger: i + 8, fbp_reserved: i % 4 }))
  });
  const optimized = serviceFixture({ rows, coverage }), baseline = serviceFixture({ rows, coverage, legacy: true });
  const queries = Array.from({ length: 7 }, (_, i) => ({ page: i + 1, pageSize: 10 }));
  queries.push({ page: 1, pageSize: 1, sortKey: 'suggested_purchase_qty', sortDir: 'asc' }, { shopId: '2', priority: 'high', minSales: 35 }, { productId: 3 }, { manualSku: rows[0].ozon_sku }, { query: 'inventory', searchMode: 'name' }, { query: '1-2-', searchMode: 'inventory_prefix' });
  for (const query of queries) assert.deepEqual(serialize(await optimized.read(query)), serialize(await baseline.read(query)));
  assert.equal(optimized.calls.base, 1); assert.equal(optimized.calls.coverage.length, 1);
  assert.equal(optimized.calls.filters, 2);
  assert.equal(optimized.calls.coverage[0].productIds, undefined); assert.equal(optimized.calls.coverage[0].tenantId, 1);
  assert.equal(optimized.calls.coverage[0].includeLegacyTenantNull, true); assert.equal(optimized.calls.coverage[0].fresh, true);
  assert.equal(baseline.calls.coverage.length, queries.length);
  assert.ok(baseline.calls.coverage.every(options => options.productIds.length === 970));
  assert.equal(optimized.calls.authorization, queries.length * 2);
  optimized.invalidate(); await optimized.read({ page: 2 }); assert.equal(optimized.calls.coverage.length, 2);
  await optimized.read({ refresh: '1' }); assert.equal(optimized.calls.coverage.length, 3); assert.equal(optimized.calls.base, 2);
  await optimized.read({ forceRefresh: 'yes' }); assert.equal(optimized.calls.coverage.length, 4); assert.equal(optimized.calls.base, 3);
});
