import {withRequestReadCache} from '../src/services/request-read-cache.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { withMysqlWorkload, currentMysqlWorkload } from '../src/mysql-workload.js';

const component = readFileSync(new URL('../frontend/orders/OrdersPage.vue', import.meta.url), 'utf8');
const mounted = component.slice(component.indexOf('onMounted(async () => {'), component.indexOf('\nonBeforeUnmount(', component.indexOf('onMounted(async () => {')));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

test('cold page requests orders before either toolbar endpoint responds; auxiliary failure does not block rows', async () => {
  const preferences = deferred(), sync = deferred(), calls = [];
  let mount;
  const context = {
    onMounted: callback => { mount = callback; },
    loadStatusTabPreference: () => { calls.push('preferences'); return preferences.promise; },
    loadLatestOrderSyncStatus: () => { calls.push('sync'); return sync.promise; },
    loadOrders: async () => { calls.push('orders'); },
    loadLogisticsOptions: async () => { calls.push('logistics'); },
    bootstrapFromRoute: async () => { calls.push('route'); },
    window: { setInterval: () => 1 }, orderClock: { value: 0 }, route: { query: {} },
    vm: { filters: {} }, console: { warn: () => calls.push('aux-failed') }, Date
  };
  vm.runInNewContext(mounted, context);
  await mount();
  assert.deepEqual(calls, ['preferences', 'sync', 'orders']);
  preferences.reject(new Error('endpoint unavailable'));
  sync.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.includes('aux-failed'));
  assert.equal(calls.filter(call => call === 'orders').length, 1);
  calls.length = 0;
  context.route.query.orderId = '7';
  await mount();
  assert.ok(calls.includes('route'));
  assert.ok(!calls.includes('orders'), 'Deep-link bootstrap retains its own order filtering');
});

test('secondary order counts and initial inventory hydration are background, while pages and targeted updates are foreground', async () => {
  const source = readFileSync(new URL('../src/services/mysql-runtime-services.js', import.meta.url), 'utf8');
  const contexts = [];
  const extract = (name, nextName) => source.slice(source.indexOf(`  ${name}:`), source.indexOf(`  ${nextName}:`, source.indexOf(`  ${name}:`)));
  const callbacks = vm.runInNewContext(`({${extract('ordersPaged', 'outboundRecords')}${extract('orderInventoryAvailability', 'updateInventoryProductLeadTimes')}})`, {
    withRequestReadCache, withMysqlWorkload, String,
    ordersPagedMysql: async (query, tenant) => contexts.push({ lane: currentMysqlWorkload(), tenant, query }),
    orderInventoryAvailabilityMysql: async (query, tenant) => contexts.push({ lane: currentMysqlWorkload(), tenant, query })
  });
  const query = { page: 2, includeCounts: '0' };
  await callbacks.ordersPaged(query, 'tenant-b');
  await callbacks.ordersPaged({ includeRows: '0' }, 'tenant-b');
  await callbacks.ordersPaged({ include_rows: '0' }, 'tenant-b');
  await callbacks.orderInventoryAvailability({ orderIds: '1,2' }, 'tenant-b');
  await callbacks.orderInventoryAvailability({ includeRows: '1', refresh: '1', productId: '9' }, 'tenant-b');
  assert.deepEqual(contexts.map(row => row.lane), ['foreground', 'background', 'background', 'background', 'foreground']);
  assert.ok(contexts.every(row => row.tenant === 'tenant-b'));
  assert.equal(contexts[0].query, query);
});
