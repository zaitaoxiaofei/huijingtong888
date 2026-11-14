import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ref, computed, watch } from 'vue';

const source = readFileSync(new URL('../frontend/admin/views/inventory/WbStockBatchView.vue', import.meta.url), 'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\n/gm, '');
function harness({ count = 3, failWrite = false } = {}) {
  let scope = 'tenant-a'; const calls = [], warnings = [];
  const stock = new Map(Array.from({ length: count }, (_, index) => [index + 200, 5]));
  const api = {
    get: async url => url === '/api/wb/shops' ? [{ id: 13, name: 'Store', status: 'active' }] : url.startsWith('/api/wb/warehouses') ? { rows: [{ id: 100, name: 'A' }, { id: 101, name: 'B' }], selected: 100 } : { rows: Array.from(stock.keys(), chrtID => ({ nm_id: chrtID, title: 'Product ' + chrtID, vendor_code: 'WB-' + chrtID, card: { sizes: [{ chrtID, techSize: '0', skus: ['BAR' + chrtID] }] } })) },
    post: async (url, body) => {
      calls.push({ url, body: structuredClone(body) });
      if (url.endsWith('/read')) return { rows: body.items.map(row => ({ ...row, current: body.warehouse_id === 101 ? 10 : stock.get(row.chrt_id) })) };
      if (url.endsWith('/set')) { if (failWrite) throw Error('network unknown'); return { rows: body.items.map(row => { stock.set(row.chrt_id, row.quantity); return { ...row, current: row.quantity, status: 'success', message: 'confirmed' }; }) }; }
      return {};
    }
  };
  const h = new Function('ref', 'computed', 'watch', 'onMounted', 'onBeforeUnmount', 'apiClient', 'currentApiCacheScope', 'ElMessage', source + '; return {bootstrap,load,refreshStock,apply,review,submit,clearReview,reset,shop,warehouse,rows,selection,search,quantity,changed,reviewRows,confirmVisible,busy,notice};')(ref, computed, watch, () => {}, () => {}, api, () => scope, { warning: m => warnings.push(m), error: m => warnings.push(m) });
  return { h, calls, warnings, changeScope: () => { scope = 'tenant-b'; } };
}
test('load reads all SKU quantities without mutations; all filtered fill is confirmed before writing, unchanged rows untouched', async () => {
  const { h, calls } = harness(); await h.bootstrap(); assert.equal(h.rows.value.length, 3); assert.equal(h.rows.value[0].current, 5); assert.equal(h.changed.value.length, 0);
  h.search.value = 'BAR200'; h.quantity.value = 12; h.apply(true); h.review();
  assert.equal(h.reviewRows.value.length, 1); assert.equal(calls.some(c => c.url.endsWith('/set')), false);
  await h.submit(); assert.equal(calls.filter(c => c.url.endsWith('/set')).length, 1); assert.equal(calls.at(-1).body.warehouse_id, 100);
  assert.equal(h.rows.value[0].current, 12); assert.equal(h.rows.value[0].quantity, undefined); assert.equal(h.rows.value[1].current, 5);
});
test('selected rows accept zero, empty targets never default to clearing the store', async () => {
  const { h, calls } = harness(); await h.bootstrap(); h.selection.value = [h.rows.value[1]];
  h.apply(); assert.equal(h.changed.value.length, 0);
  h.quantity.value = 0; h.apply(); h.review(); await h.submit();
  assert.equal(calls.at(-1).body.items.length, 1); assert.equal(calls.at(-1).body.items[0].quantity, 0); assert.equal(h.rows.value[1].current, 0);
});
test('switching seller warehouse discards former target quantities and reads the selected warehouse', async () => {
  const { h, calls } = harness(); await h.bootstrap(); h.rows.value[0].quantity = 8; h.review();
  h.warehouse.value = 101; await h.refreshStock(true);
  assert.equal(h.confirmVisible.value, false); assert.equal(h.changed.value.length, 0); assert.equal(h.rows.value[0].current, 10); assert.equal(calls.at(-1).body.warehouse_id, 101);
});
test('1001 SKUs are automatically split, while failed writes stop subsequent batches and require a fresh read', async () => {
  const { h, calls } = harness({ count: 1001, failWrite: true }); await h.bootstrap();
  assert.deepEqual(calls.map(c => c.body.items.length), [1000, 1]);
  h.quantity.value = 20; h.apply(true); h.review(); await h.submit();
  assert.equal(calls.filter(c => c.url.endsWith('/set')).length, 1); assert.equal(h.rows.value[0].loaded, false); assert.equal(h.rows.value[0].status, 'unconfirmed');
  assert.match(h.notice.value, /后续批次已停止/); h.review(); assert.equal(h.confirmVisible.value, false);
});
test('an enterprise scope change invalidates an open stock confirmation before any write', async () => {
  const { h, calls, changeScope } = harness(); await h.bootstrap(); h.rows.value[0].quantity = 9; h.review(); changeScope(); await h.submit();
  assert.equal(calls.some(c => c.url.endsWith('/set')), false);
});
test('successful large submission sends every SKU exactly once and clears confirmed target inputs', async () => {
  const { h, calls } = harness({ count: 1001 }); await h.bootstrap(); h.quantity.value = 30; h.apply(true); h.review(); await h.submit();
  const writes = calls.filter(c => c.url.endsWith('/set')); assert.deepEqual(writes.map(c => c.body.items.length), [1000, 1]);
  assert.equal(new Set(writes.flatMap(c => c.body.items.map(row => row.chrt_id))).size, 1001); assert.equal(h.changed.value.length, 0); assert.match(h.notice.value, /1001/);
});
