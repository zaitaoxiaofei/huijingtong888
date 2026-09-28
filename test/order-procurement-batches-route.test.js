import assert from 'node:assert/strict';
import test from 'node:test';
import { handleOrderRestRoute } from '../src/server/routes/orders.js';
import { readFile } from 'node:fs/promises';

const mysqlSource = await readFile(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');

test('order procurement batches route returns the fresh order-specific batches', async () => {
  let receivedId = 0;
  let payload;
  const handled = await handleOrderRestRoute({
    req: { method: 'GET' },
    res: {},
    url: new URL('http://localhost/api/orders/22397/procurement-batches'),
    parts: ['api', 'orders', '22397', 'procurement-batches'],
    services: {
      orderProcurementBatches: async (id) => {
        receivedId = id;
        return { batches: [{ id: 1080, purchase_quantity: 10 }], items: [{ quantity: 1 }] };
      }
    },
    readJson: async () => ({}),
    json: (_res, value) => { payload = value; return value; },
    notFound: () => null,
    writeHead: () => {}
  });

  assert.equal(receivedId, 22397);
  assert.deepEqual(payload, { batches: [{ id: 1080, purchase_quantity: 10 }], items: [{ quantity: 1 }] });
  assert.deepEqual(handled, payload);
});

test('order procurement batches route has an empty safe fallback', async () => {
  let payload;
  await handleOrderRestRoute({
    req: { method: 'GET' }, res: {}, url: new URL('http://localhost/api/orders/1/procurement-batches'),
    parts: ['api', 'orders', '1', 'procurement-batches'], services: {}, readJson: async () => ({}),
    json: (_res, value) => { payload = value; return value; }, notFound: () => null, writeHead: () => {}
  });
  assert.deepEqual(payload, { batches: [], items: [] });
});

test('purchase order updates accept a corrected purchase order number', () => {
  const start = mysqlSource.indexOf('export async function updatePurchaseOrderMysql');
  const end = mysqlSource.indexOf('export async function deletePurchaseOrderMysql', start);
  const block = mysqlSource.slice(start, end);
  assert.match(block, /const orderNo = body\.order_no/);
  assert.match(block, /采购单号不能为空/);
  assert.match(block, /UPDATE purchase_orders SET order_no = \?/);
});
