import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../frontend/orders/OrdersPage.vue', import.meta.url), 'utf8');

test('procurement detail and receipt actions refresh order-specific batches before use', () => {
  assert.match(source, /async function loadOrderProcurementBatches\(row\)[\s\S]*?\/api\/orders\/\$\{Number\(row\.id\)\}\/procurement-batches/);
  assert.match(source, /async function handleViewProcurementDetails\(row\) \{\s+const procurement = await loadOrderProcurementBatches\(row\)/);
  assert.match(source, /async function handleConfirmProcurementInbound\(row\)[\s\S]*?procurement = await loadOrderProcurementBatches\(row\)[\s\S]*?filter\(batch => batch\.status === 'pending_arrival'\)/);
});

test('receipt dialog selects batches explicitly and posts only selected actual quantities', () => {
  assert.match(source, /v-model="procurementReceiptDialog\.visible" title="登记实际收货"/);
  assert.match(source, /<el-checkbox v-model="row\.selected"/);
  assert.match(source, /v-model="row\.receive_quantity"/);
  assert.match(source, /const records = procurementReceiptDialog\.batches\.filter\(batch => batch\.selected\)/);
  assert.match(source, /records\.map\(batch => \(\{ id: batch\.id, payload:/);
});
