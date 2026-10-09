import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadOrderFbpStocks, loadProductFbpStocks } from '../src/services/fbp-inventory-display.js';
import { calculateOrderProcurementCoverage } from '../src/services/order-procurement-coverage.js';

test('FBP demand cannot consume local availability; FBS and approved FBP reservations do', () => {
  const coverage = calculateOrderProcurementCoverage({ stocks: [{ product_id: 10, ledger: 10, fbp_reserved: 3 }], demands: [
    { order_id: 1, order_item_id: 1, product_id: 10, quantity: 4, needs_fulfillment: 1, stock_location: 'LOCAL' },
    { order_id: 2, order_item_id: 2, product_id: 10, quantity: 100, needs_fulfillment: 1, stock_location: 'FBP' }
  ] });
  assert.equal(coverage.get(1).items[0].product_local_available, 3);
  assert.equal(coverage.get(2).items[0].product_local_available, 3);
  assert.deepEqual(coverage.product_availability.get(10), {
    product_id: 10, local_stock: 10, local_available: 3,
    order_reserved_qty: 4, fbp_reserved_qty: 3,
    pending_procurement_qty: 0, pending_procurement_available_qty: 0,
    inventory_needs_review: false
  });
});

test('only real pending-arrival batches count as incoming, including products without open orders', () => {
  const coverage = calculateOrderProcurementCoverage({
    stocks: [{ product_id: 10, ledger: 4 }],
    requests: [{ id: 1, product_id: 10, status: 'done', quantity: 117 }, { id: 2, product_id: 10, status: 'draft', quantity: 20 }, { id: 3, product_id: 10, status: 'suggested', quantity: 27 }],
    inbounds: [{ id: 4, product_id: 10, status: 'approved', quantity: 143 }]
  });
  assert.equal(coverage.product_availability.get(10).local_available, 4);
  assert.equal(coverage.product_availability.get(10).pending_procurement_qty, 0);
});

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE shops(id INTEGER, name TEXT);
    CREATE TABLE sku_mappings(id INTEGER, shop_id INTEGER, ozon_sku TEXT, product_id INTEGER, active INTEGER);
    CREATE TABLE product_components(product_id INTEGER, component_product_id INTEGER, quantity INTEGER);
    CREATE TABLE sku_inventory_recipes(id INTEGER, shop_id INTEGER, ozon_sku TEXT, active INTEGER);
    CREATE TABLE sku_inventory_recipe_items(recipe_id INTEGER, product_id INTEGER, quantity INTEGER);
    CREATE TABLE online_products(shop_id INTEGER, ozon_sku TEXT, name TEXT, offer_id TEXT);
    CREATE TABLE ozon_stock_snapshots(id INTEGER, shop_id INTEGER, ozon_sku TEXT, warehouse_id TEXT, warehouse_name TEXT, stock_type TEXT, present INTEGER, available INTEGER, reserved INTEGER, synced_at TEXT);
    CREATE TABLE orders(id INTEGER, shop_id INTEGER);
    CREATE TABLE order_items(order_id INTEGER, ozon_sku TEXT);
    INSERT INTO shops VALUES(1,'A店'),(2,'B店');
    INSERT INTO sku_mappings VALUES(1,1,'ONE',10,1),(2,1,'TWO',20,1),(3,2,'ONE',10,1),(4,1,'MISSING',10,1),(5,1,'ONE',10,1);
    INSERT INTO product_components VALUES(20,10,2);
    INSERT INTO ozon_stock_snapshots VALUES
      (1,1,'ONE','W1','仓一','fbp_real',5,4,1,'2026-09-28 01:00:00'),
      (2,1,'TWO','W1','仓一','fbp_real',3,3,0,'2026-09-28 01:00:00'),
      (3,2,'ONE','W1','仓一','fbp_real',7,6,1,'2026-09-28 01:00:00'),
      (4,1,'ONE','W2','仓二','fbp_real',2,2,0,'2026-09-28 01:00:00'),
      (5,1,'ONE','W3','虚拟仓','fbs_virtual',100,100,0,'2026-09-28 01:00:00');
    INSERT INTO orders VALUES(1,1),(2,2),(3,1);
    INSERT INTO order_items VALUES(1,'ONE'),(1,'ONE'),(2,'ONE'),(3,'MISSING');`);
  const calls = [];
  return { db, calls, query: async (sql, args) => { calls.push({ sql, args }); return db.prepare(sql).all(...args); } };
}

test('FBP inventory uses shop/SKU/warehouse and converts each package before summing', async () => {
  const f = fixture();
  try {
    const data = await loadProductFbpStocks(f.query, 10);
    assert.equal(data.present, 20); // A single 5+2, A double 3*2, B single 7
    assert.equal(data.available, 18);
    assert.equal(data.incomplete, true);
    assert.equal(data.rows.length, 5, 'duplicate mappings do not duplicate snapshots');
    assert.equal(data.rows.find(row => row.ozon_sku === 'MISSING').present, null);
    assert.equal((await loadProductFbpStocks(f.query, 20)).present, 3, 'virtual product remains in complete sets');
    assert.equal(f.calls.length, 4, 'two bounded reads per opened product, no per-SKU request');
  } finally { f.db.close(); }
});

test('an explicit SKU recipe overrides the parent composition and supports recipe-only bindings', async () => {
  const f = fixture();
  try {
    f.db.exec(`INSERT INTO sku_inventory_recipes VALUES(1,1,'TWO',1),(2,1,'RECIPE',1);
      INSERT INTO sku_inventory_recipe_items VALUES(1,99,4),(2,10,3);
      INSERT INTO ozon_stock_snapshots VALUES(6,1,'RECIPE','W1','仓一','fbp_real',2,2,0,'2026-09-28 01:00:00');`);
    const data = await loadProductFbpStocks(f.query, 10);
    assert.equal(data.rows.some(row => row.ozon_sku === 'TWO'), false);
    assert.equal(data.rows.find(row => row.ozon_sku === 'RECIPE').inventory_quantity, 6);
    assert.equal((await loadProductFbpStocks(f.query, 99)).present, 12);
  } finally { f.db.close(); }
});

test('order stock is fetched in one page-scoped read, distinguishes missing from zero, and never mixes shops', async () => {
  const f = fixture();
  try {
    const data = await loadOrderFbpStocks(f.query, [1,2,3]);
    assert.equal(data.get(1)[0].present, 7);
    assert.equal(data.get(2)[0].available, 6);
    assert.equal(data.get(3)[0].present, null);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].args, [1,2,3]);
    assert.equal((await loadOrderFbpStocks(f.query, [])).size, 0);
    assert.equal(f.calls.length, 1);
  } finally { f.db.close(); }
});
