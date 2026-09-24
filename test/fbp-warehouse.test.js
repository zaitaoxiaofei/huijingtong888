import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadWarehouseFacts, appendPrintRecord, validatePrintRecord } from '../src/services/fbp-warehouse.js';
import { labelTarget, remainingLabels, buildWarehouseRows } from '../frontend/admin/utils/fbp-warehouse.js';

test('labels add two per actual detail, preserve zero and calculate remaining without repeating extras', () => {
  const a = { final_qty: 100, barcode_printed_qty: 102 }, b = { final_qty: 50, barcode_printed_qty: 20 };
  assert.equal(labelTarget(a), 102);
  assert.equal(remainingLabels(a), 0);
  assert.equal(remainingLabels(b), 32);
  assert.equal(labelTarget({ final_qty: 0, approved_qty: 100 }), 0);
  assert.equal(labelTarget({ final_qty: 10, order: { status: 'cancelled' } }), 0);
  assert.equal(labelTarget({ _sourceItems: [a, b] }), 154);
  assert.equal(remainingLabels({ _sourceItems: [{ ...a, barcode_printed_qty: 200 }, b] }), 32);
  assert.equal(remainingLabels({ ...a, final_qty: 120 }), 20);
});

test('warehouse groups all shops without adding repeated global stock or incoming', () => {
  const warehouse = { ledger_stock: 100, reserved_fbp: 70, procurement_incoming: 50, fbp_pending: 20 };
  const orders = [1, 2].map(id => ({ id, status: 'approved', items: [{ id, product_id: 10, final_qty: 20, warehouse }] }));
  const [row] = buildWarehouseRows(orders);
  assert.equal(row.final_qty, 40);
  assert.equal(row.local_stock, 70);
  assert.equal(row.procurement_incoming, 50);
  assert.equal(row.pending_receipt_qty, 20);
  assert.equal(row.target_labels, 44);
  assert.equal(buildWarehouseRows([{ status: 'approved', items: [{ id: 1, product_id: 10 }] }])[0].local_stock, null);
});

test('warehouse facts query four batches and partial FBP receipts reduce pending warehouse qty', async () => {
  let calls = 0;
  const facts = await loadWarehouseFacts(async sql => {
    calls++;
    if (sql.includes('inventory_movements')) {
      assert.match(sql, /source_type NOT IN \('fbp_replenishment_reserve', 'fbp_replenishment_reserve_release'\)/);
      return [{ product_id: 10, quantity: 30 }];
    }
    if (sql.includes('inbound_records')) return [{ product_id: 10, quantity: 15 }];
    if (sql.includes('shipments')) return [
      { product_id: 10, shop_id: 1, ozon_sku: 'A', quantity: 20, listed_quantity: 5, status: 'received', shipped_at: '2026-09-20', latest_product: 1, latest_sku: 1 },
      { product_id: 10, shop_id: 2, ozon_sku: 'B', quantity: 10, listed_quantity: 10, status: 'closed', shipped_at: '2026-09-19', latest_product: 2, latest_sku: 1 }
    ];
    return [{ product_id: 10, quantity: 10 }];
  }, [10, 10], "stock_location = 'LOCAL'");
  assert.equal(calls, 4);
  assert.equal(facts.get(10).fbp_pending, 15);
  assert.equal(facts.get(10).last_shipped_qty, 20);
  assert.equal(facts.get(10).sku_shipments['2:B'].quantity, 10);
});

test('shipment uses adjusted final quantity and zero rows release their reservation without shipping', async () => {
  const source = await fs.readFile(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function createFbpReplenishmentApprovedTransfersMysql(');
  const end = source.indexOf('export async function createFbpTransferRecordMysql', start);
  const released = [], outbound = [], inserts = [];
  const run = new Function('resolvePersonIdOrFirstMysql', 'mysqlConnectionQueryOne', 'nullableInteger',
    'releaseFbpReplenishmentReservationMysql', 'postFbpTransferInventoryMovementMysql',
    source.slice(start, end) + '; return createFbpReplenishmentApprovedTransfersMysql;')(
    async () => 1, async () => null, value => value || null,
    async (_, order, item) => released.push(item), async (_, transfer, quantity) => outbound.push(quantity));
  const connection = { execute: async (sql, args) => {
    if (sql.includes('SELECT i.*')) {
      assert.match(sql, /SUM\(a.adjustment_qty\)/);
      return [[{ id: 1, product_id: 10, approved_qty: 100, final_qty: 0 }, { id: 2, product_id: 10, approved_qty: 100, final_qty: 50 }]];
    }
    inserts.push(args); return [{ insertId: 10 }];
  } };
  assert.deepEqual(await run(connection, 1, 1), { transferCount: 1, outboundQuantity: 50 });
  assert.deepEqual(released, [1, 2]);
  assert.deepEqual(outbound, [-50]);
  assert.equal(inserts[0][4], 50);
});

test('allocation rejects stale edits and requires explicit acknowledgment of current-stock shortage', async () => {
  const source = await fs.readFile(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function saveFbpReplenishmentInventoryAllocationMysql(');
  const end = source.indexOf('async function requireSessionPersonIdMysql', start);
  const writes = [];
  const connection = { execute: async (sql, args) => {
    if (sql.includes('SELECT i.id, i.order_id')) return [[{ id: 1, order_id: 1, product_id: 10, inventory_key: '10', approved_qty: 10, adjustment_qty: 0, status: 'approved' }]];
    if (sql.includes('FROM inventory_movements')) return [[{ quantity: 20 }]];
    if (sql.includes('AS quantity')) return [[{ quantity: 0 }]];
    if (/INSERT|UPDATE fbp/.test(sql)) writes.push({ sql, args });
    return [[]];
  } };
  const run = new Function('ensureMysqlCutoverEnabled', 'ensureFbpReplenishmentSchemaMysql', 'withMysqlTransaction', 'localStockLocationPredicateMysql',
    source.slice(start, end).replace('export ', '') + '; return saveFbpReplenishmentInventoryAllocationMysql;')(
    () => {}, async () => {}, callback => callback(connection), () => "stock_location = 'LOCAL'");
  const body = { inventory_key: '10', reason: '仓库重新分配', items: [{ item_id: 1, order_id: 1, final_qty: 30, expected_final_qty: 9 }] };
  await assert.rejects(run(body, 1), /其他人调整/);
  body.items[0].expected_final_qty = 10;
  await assert.rejects(run(body, 1), /当前本地可用/);
  assert.equal(writes.length, 0);
  assert.equal((await run({ ...body, allow_shortage: true }, 1)).final_qty, 30);
  assert.match(writes[0].sql, /fbp_replenishment_item_adjustments/);
  assert.equal(writes[0].args[2], 20);
});

test('printing accumulates and retries are idempotent; changed confirmation is rejected', async () => {
  const item = { id: 1, shop_id: 1, ozon_sku: 'SKU', barcode_printed_qty: 5 };
  const logs = [];
  const connection = { execute: async (sql, args) => {
    if (sql.includes('FOR UPDATE')) return [[{ ...item }]];
    if (sql.startsWith('SELECT * FROM fbp_replenishment_print_records')) return [logs.filter(row => row.request_key === args[0])];
    if (sql.startsWith('INSERT')) logs.push({ request_key: args[0], item_id: args[2], quantity: args[5], preparation_quantity: args[6] });
    if (sql.includes('barcode_printed_qty = barcode_printed_qty +')) item.barcode_printed_qty += args[0];
    return [{}];
  } };
  const body = { order_id: 2, item_id: 1, quantity: 7, preparation_quantity: 10, request_key: 'print-request-12345678' };
  assert.equal((await appendPrintRecord(connection, body, 1)).barcode_printed_qty, 12);
  assert.equal((await appendPrintRecord(connection, body, 1)).duplicate, true);
  assert.equal(logs.length, 1);
  await assert.rejects(appendPrintRecord(connection, { ...body, quantity: 8 }, 1), /同一打印/);
  for (const change of [{ quantity: 0 }, { quantity: 1000 }, { quantity: 1.2 }, { request_key: '' }, { preparation_quantity: 0 }]) assert.throws(() => validatePrintRecord({ ...body, ...change }));
});
