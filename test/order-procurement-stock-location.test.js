import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadOrderProcurementCoverage, invalidateOrderProcurementCoverage, procurementQueueSql } from '../src/services/mysql-order-procurement-coverage.js';

test('procurement uses the displayed non-FBP ledger, including legacy warehouse movements', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE products (id INTEGER, name TEXT, stock_unit TEXT);
    INSERT INTO products VALUES (5, 'TENET', 'unit');
    CREATE TABLE inventory_movements (id INTEGER PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP, source_ref TEXT, product_id INTEGER, quantity_delta INTEGER, status TEXT,
      stock_location TEXT, source_type TEXT, related_order_item_id INTEGER);
    INSERT INTO inventory_movements (product_id, quantity_delta, status, stock_location, source_type, related_order_item_id) VALUES
      (5, 500, 'posted', 'UNKNOWN', 'purchase_inbound', NULL),
      (5, 3, 'posted', 'UNKNOWN', 'return_in', NULL),
      (5, 34, 'posted', 'LOCAL', 'return_in', NULL),
      (5, -320, 'posted', 'LOCAL', 'order_outbound', NULL),
      (5, -10, 'posted', 'LOCAL', 'fbp_transfer_outbound', NULL),
      (5, 900, 'posted', 'FBP', 'purchase_inbound', NULL),
      (5, 900, 'draft', 'UNKNOWN', 'purchase_inbound', NULL);`);
  const demands = [1, 2].map(id => ({ order_id: id, order_item_id: id, product_id: 5,
    quantity: id === 1 ? 207 : 1, ordered_at: `2026-09-0${id}T00:00:00Z`,
    needs_fulfillment: 1, entered_transport: 0, stock_location: 'LOCAL' }));
  const query = async sql => {
    if (sql.includes('SELECT o.id AS order_id')) return demands.map(row => ({ ...row }));
    if (sql.includes('FROM inventory_movements')) return db.prepare(sql).all();
    return [];
  };
  try {
    invalidateOrderProcurementCoverage();
    let result = await loadOrderProcurementCoverage(query, '');
    assert.equal(result.get(1).items[0].ledger_stock, 207);
    assert.equal(result.get(1).stock_quantity, 207);
    assert.equal(result.get(1).shortage_quantity, 0);
    assert.equal(result.get(1).inventory_needs_review, false);
    assert.equal(result.get(2).shortage_quantity, 1);
    assert.equal(procurementQueueSql(result, 'pending_purchase'), 'o.id IN (2)');

    // Legacy deductions for an unshipped order must be restored into the same pool once.
    db.exec("INSERT INTO inventory_movements (product_id, quantity_delta, status, stock_location, source_type, related_order_item_id) VALUES (5, -1, 'posted', 'UNKNOWN', 'order_outbound', 2)");
    invalidateOrderProcurementCoverage();
    result = await loadOrderProcurementCoverage(query, '');
    assert.equal(result.get(1).items[0].ledger_stock, 206);
    assert.equal(result.get(1).stock_quantity, 207);
    assert.equal(result.get(2).shortage_quantity, 1);
  } finally {
    db.close();
    invalidateOrderProcurementCoverage();
  }
});
