import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const sql = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const baseStart = sql.indexOf('async function orderBaseSqlMysql(');
const orderBase = vm.runInNewContext(`(${sql.slice(baseStart, sql.indexOf('async function orderFilteredSqlMysql(', baseStart))})`, {
  orderListTenantScopeMysql: async id => id,
  orderTenantPredicateMysql: (alias, tenant) => `${alias}.tenant_id = ${tenant}`,
  normalizeSyncDateMysql: () => null
});

test('order platform scope applies as a tenant shop predicate before pagination and count queries', async () => {
  const wb = await orderBase({ platform: 'wb', shopId: '12' }, '2');
  assert.match(wb.where, /tenant_shop\.tenant_id = 2 AND COALESCE\(tenant_shop\.platform, 'ozon'\) = \?/);
  assert.deepEqual(Array.from(wb.params), ['wb', 12]);
  assert.deepEqual(Array.from((await orderBase({ platform: 'ozon' }, '2')).params), ['ozon']);
  assert.doesNotMatch((await orderBase({}, '2')).where, /tenant_shop\.platform/);
  await assert.rejects(orderBase({ platform: 'unsupported' }, '2'), { statusCode: 400 });
});

test('platform tabs keep separate filters and clear cross-platform selections', async () => {
  const source = readFileSync(new URL('../frontend/orders/composables/useOrdersPage.js', import.meta.url), 'utf8');
  const start = source.indexOf('    changePlatform: async');
  const end = source.indexOf('    submitFilters:', start);
  const state = { filters: { platform: 'ozon', shopId: '12', searchQuery: 'first' }, rows: [{ id: 1 }] };
  const ids = { value: new Set([1]) };
  const change = vm.runInNewContext(`({${source.slice(start, end)}}).changePlatform`, {
    vm: state,
    selectedOrderIds: ids,
    ordersLoadToken: { value: 0 },
    platformFilters: new Map(),
    abortOrderReads() {},
    createDefaultFilters: () => ({ shopId: 'all', searchQuery: '' }),
    buildStatusTabs: () => [],
    patch: changes => Object.assign(state, changes),
    LOGISTICS_CARRIER_OPTIONS: [],
    DEFAULT_LOGISTICS_METHOD_OPTIONS: [],
    DEFAULT_LOGISTICS_SERVICE_CLASS_OPTIONS: [],
    defaultFrom: '', defaultTo: ''
  });
  await change('wb', { load: false });
  assert.equal(state.filters.shopId, 'all');
  assert.equal(state.rows.length, 0);
  assert.equal(ids.value.size, 0);
  state.filters.shopId = '23';
  await change('ozon', { load: false });
  assert.equal(state.filters.shopId, '12');
  assert.equal(state.filters.searchQuery, 'first');
  await change('wb', { load: false });
  assert.equal(state.filters.shopId, '23');
});
