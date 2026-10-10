import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('export async function batchUpdateInboundRecordsMysql('), source.indexOf('export async function previewInboundReceiptImpactMysql(')).replace('export async function', 'async function');

function receiver(quantity, note = '') {
  const updates = [];
  const receive = vm.runInNewContext(`${block};batchUpdateInboundRecordsMysql`, {
    ensureMysqlCutoverEnabled: () => {}, ensureInboundRecordTimestampSchemaMysql: async () => {},
    ensurePurchaseCostVersionSchemaMysql: async () => {},
    withMysqlTransaction: async callback => callback({}),
    mysqlConnectionQueryOne: async () => ({ quantity, note }),
    applyInboundRecordUpdateMysql: async (_connection, _id, payload) => { updates.push(payload); },
    refreshPurchaseOrderStatusMysql: async () => {}, invalidateOrderProcurementCoverage: () => {},
    normalizeMysqlDateTime: () => '2026-10-10 17:00:00', Date
  });
  return { receive, updates };
}

test('full receipt without purchase_quantity does not require a difference reason', async () => {
  const { receive, updates } = receiver(200);
  await receive({ records: [{ id: 1456, payload: { receive_quantity: 200, expected_remaining_quantity: 200 } }] });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].note, undefined);
});

test('short receipt still requires a difference reason', async () => {
  const { receive, updates } = receiver(200);
  const record = { id: 1456, payload: { receive_quantity: 180, expected_remaining_quantity: 200 } };
  await assert.rejects(receive({ records: [record] }), /采购数与实收数不一致，请选择差异原因/);
  assert.equal(updates.length, 0);
  await receive({ records: [record], receipt_difference_reason: '少货' });
  assert.match(updates[0].note, /收货差异：少货/);
});

test('over receipt requires a reason and keeps the entered quantity', async () => {
  const { receive, updates } = receiver(200);
  const record = { id: 1456, payload: { receive_quantity: 201, expected_remaining_quantity: 200 } };
  await assert.rejects(receive({ records: [record] }), /采购数与实收数不一致，请选择差异原因/);
  await receive({ records: [record], receipt_difference_reason: '采购记录不准' });
  assert.equal(updates[0].receive_quantity, 201);
  assert.equal(updates[0].receipt_difference_reason, '采购记录不准');
  assert.match(updates[0].note, /收货差异：采购记录不准/);
});

test('each differing batch records its own selected reason and preserves its note', async () => {
  const { receive, updates } = receiver(200, '原采购备注');
  await receive({ records: [{ id: 1456, payload: { receive_quantity: 180, receipt_difference_reason: '商家少发货', receipt_difference_note: '少两箱' } }] });
  assert.match(updates[0].note, /^原采购备注；收货差异：商家少发货（少两箱）/);
});
