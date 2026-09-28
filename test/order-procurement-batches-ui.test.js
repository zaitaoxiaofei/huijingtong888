import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { orderProcurementRecordDetails } from '../frontend/orders/utils/order-procurement-detail.js';

const source = await readFile(new URL('../frontend/orders/OrdersPage.vue', import.meta.url), 'utf8');

test('procurement detail and receipt actions refresh order-specific batches before use', () => {
  assert.match(source, /async function loadOrderProcurementBatches\(row\)[\s\S]*?\/api\/orders\/\$\{Number\(row\.id\)\}\/procurement-batches/);
  assert.match(source, /async function handleViewProcurementDetails\(row\) \{\s+const procurement = await loadOrderProcurementBatches\(row\)/);
  assert.match(source, /async function handleConfirmProcurementInbound\(row, selectedInboundRecordId = 0\)[\s\S]*?procurement = await loadOrderProcurementBatches\(row\)[\s\S]*?filter\(batch => batch\.status === 'pending_arrival'\)/);
});

test('receipt dialog selects batches explicitly and posts only selected actual quantities', () => {
  assert.match(source, /v-model="procurementReceiptDialog\.visible" title="登记实际收货"/);
  assert.match(source, /<el-checkbox v-model="row\.selected"/);
  assert.match(source, /v-model="row\.receive_quantity"/);
  assert.match(source, /const records = procurementReceiptDialog\.batches\.filter\(batch => batch\.selected\)/);
  assert.match(source, /records\.map\(batch => \(\{ id: batch\.id, payload:/);
});

test('procurement detail preserves every inbound batch and renders each record status', () => {
  assert.match(source, /orderProcurementRecordDetails\(row\.procurement_coverage\?\.batches\)/);
  assert.match(source, /orders-procurement-table/);
  assert.match(source, /"采购单号", "快递", "快递单号"/);
  assert.match(source, /saveProcurementReferences\(record\)/);
  assert.match(source, /handleConfirmProcurementInbound\(row, record\.id\)/);
  assert.match(source, /tracking_number: String\(record\.trackingNumber \|\| ""\)\.trim\(\)/);
  assert.match(source, /\/api\/procurement\/purchase-orders\/\$\{record\.purchaseOrderId\}/);
  assert.match(source, /isReceived \? "已入库" : "等待入库"/);

  const records = orderProcurementRecordDetails([
    { id: 11, status: 'approved', quantity: 10, purchased_at: '2026-09-27 10:00:00' },
    { id: 12, status: 'pending_arrival', quantity: 20, purchased_at: '2026-09-28 10:00:00' }
  ]);
  assert.deepEqual(records.map((record) => record.id), [12, 11]);
});

test('receipt dialog supports direct batch registration and wide table review', () => {
  assert.match(source, /async function handleConfirmProcurementInbound\(row, selectedInboundRecordId = 0\)/);
  assert.match(source, /selected: Number\(batch\.id\) === Number\(selectedInboundRecordId\)/);
  assert.match(source, /title="登记实际收货" width="92%"/);
  assert.match(source, /max-height="60vh"/);
});
