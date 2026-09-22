import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const backend = fs.readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const page = fs.readFileSync(new URL('../frontend/admin/views/inventory/InventoryFbpReplenishmentPage.vue', import.meta.url), 'utf8');
function extract(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function receiptContext() {
  const record = { id: 9, quantity: 200, listed_quantity: 0, status: 'sent', source_type: 'fbp_replenishment', source_ref: 'fbp_replenishment:43:1', product_id: 8 };
  const movements = [];
  let completed = false;
  const connection = { execute: async (sql, args) => {
    if (sql.includes('UPDATE fbp_transfer_records')) { record.listed_quantity = args[0]; record.status = args[1]; }
    if (sql.includes("status = 'completed'")) completed = true;
    return [[]];
  }};
  const context = vm.createContext({
    ensureMysqlCutoverEnabled() {}, ensureFbpTransferRecordsSchemaMysql: async () => {}, ensureStockLocationSchemaMysql: async () => {},
    withMysqlTransaction: async (fn) => fn(connection), mysqlConnectionQueryOne: async () => ({ ...record }),
    resolvePersonIdOrFirstMysql: async () => 2, postFbpTransferInventoryMovementMysql: async (conn, row, qty, location) => movements.push({ qty, location }),
    fbpReplenishmentCompletionStateMysql: async () => ({ transferCount: 1, remainingQuantity: record.quantity - record.listed_quantity }),
    invalidateFbpPlanningCachesMysql() {}, mysqlQueryOne: async () => record, normalizeFbpTransferRecord: (row) => row
  });
  vm.runInContext(extract(backend, 'confirmFbpTransferReceivedMysql'), context);
  return { context, record, movements, completed: () => completed };
}
test('partial receipt keeps remaining transit; final receipt completes the order without local deduction', async () => {
  const env = receiptContext();
  const partial = await env.context.confirmFbpTransferReceivedMysql({ id: 9, received_quantity: 60, expected_listed_quantity: 0 }, 2);
  assert.equal(partial.remaining_quantity, 140);
  assert.equal(env.completed(), false);
  const final = await env.context.confirmFbpTransferReceivedMysql({ id: 9, received_quantity: 140, expected_listed_quantity: 60 }, 2);
  assert.equal(final.remaining_quantity, 0);
  assert.equal(env.completed(), true);
  assert.deepEqual(env.movements, [{ qty: 60, location: 'FBP' }, { qty: 140, location: 'FBP' }]);
});
test('stale receipt submission and over-receipt do not post a second movement', async () => {
  const env = receiptContext();
  await env.context.confirmFbpTransferReceivedMysql({ id: 9, received_quantity: 60, expected_listed_quantity: 0 });
  await assert.rejects(env.context.confirmFbpTransferReceivedMysql({ id: 9, received_quantity: 60, expected_listed_quantity: 0 }), /避免重复入仓/);
  await assert.rejects(env.context.confirmFbpTransferReceivedMysql({ id: 9, received_quantity: 141, expected_listed_quantity: 60 }), /不能超过剩余/);
  assert.equal(env.movements.length, 1);
});
test('dialog retains successful receipts and reloads after a later row fails', async () => {
  const rows = [{ id: 1, receive_now: 10, remaining: 20, listed_quantity: 0 }, { id: 2, receive_now: 5, remaining: 20, listed_quantity: 0 }];
  let refreshed = 0;
  const calls = [];
  const messages = [];
  const context = vm.createContext({
    receiptDialog: { rows, submitting: false, loading: false },
    ElMessage: { warning: (m) => messages.push(m), success: (m) => messages.push(m), error: (m) => messages.push(m) },
    apiClient: { post: async (url, body) => { calls.push(body); if (body.id === 2) throw new Error('入仓数量已更新'); } },
    loadReceiptRows: async () => { refreshed++; }, loadPageData: async () => {}
  });
  vm.runInContext(extract(page, 'submitReceipt'), context);
  await context.submitReceipt();
  assert.equal(rows[0].receive_now, 0);
  assert.equal(calls[0].expected_listed_quantity, 0);
  assert.equal(refreshed, 1);
  assert.match(messages[0], /已保存 1 条/);
  assert.equal(context.receiptDialog.submitting, false);
});
