import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  markInventoryAlertSkuDailyDirtyMysqlService,
  refreshInventoryAlertSkuDailyMysqlService
} from "../src/services/mysql-inventory-alert-snapshots.js";
import { orderTransportEvidenceSql } from "../src/services/order-transport-evidence.js";

function fixture() {
  const writes = [];
  const invalidated = [];
  let rowCount = 0;
  let failInsert = false;
  const deps = {
    tenantScope: { id: 1, defaultTenant: true },
    normalizeDate: (value) => String(value || "").trim(),
    todayDateKey: () => "2026-10-20",
    orderedAtUtcRange: (_alias, from, to) => ({
      whereSql: "AND o.ordered_at >= ? AND o.ordered_at < ?",
      params: [`${from}-utc`, `${to}-next-utc`]
    }),
    chinaDateSql: (column) => `DATE(${column})`,
    transportEvidenceSql: orderTransportEvidenceSql,
    execute: async (sql, params) => writes.push({ sql, params }),
    invalidateCache: (key) => invalidated.push(key),
    invalidateCachePrefix: (key) => invalidated.push(key),
    queryOne: async () => ({ count: rowCount }),
    transaction: async (callback) => {
      const prior = rowCount;
      try {
        await callback({ execute: async (sql, params) => {
          writes.push({ sql, params });
          if (/DELETE FROM inventory_alert_sku_daily WHERE/.test(sql)) rowCount = 0;
          if (/INSERT INTO inventory_alert_sku_daily \(/.test(sql)) {
            if (failInsert) throw new Error("injected refresh failure");
            rowCount = 3;
          }
        } });
      } catch (error) {
        rowCount = prior;
        throw error;
      }
    }
  };
  return { deps, writes, invalidated, setFailInsert(value) { failInsert = value; }, count() { return rowCount; } };
}

test("SKU daily projection refresh is repeat-safe, transactional and respects shipped cancellations and FBP", async () => {
  const state = fixture();
  await markInventoryAlertSkuDailyDirtyMysqlService(state.deps, "2026-10-19");
  const first = await refreshInventoryAlertSkuDailyMysqlService(state.deps, { from: "2026-10-19", to: "2026-10-19" });
  const second = await refreshInventoryAlertSkuDailyMysqlService(state.deps, { from: "2026-10-19", to: "2026-10-19" });
  assert.deepEqual(first, second);
  assert.equal(first.rows, 3, "repeated refresh replaces the same day's values");
  const insert = state.writes.find(({ sql }) => /INSERT INTO inventory_alert_sku_daily \(/.test(sql));
  assert.match(insert.sql, /SUM\(oi\.quantity\)/);
  assert.match(insert.sql, /query_stock_location = 'FBP'/);
  assert.match(insert.sql, /order_status_history transport_history/);
  assert.match(insert.sql, /NULLIF\(prior_mapping\.ozon_sku, ''\)/);
  assert.match(insert.sql, /LOWER\(COALESCE\(o\.status, ''\)\) NOT LIKE '%cancel%'/);
  assert.deepEqual(insert.params, ["2026-10-19-utc", "2026-10-19-next-utc"]);
  assert.ok(state.invalidated.includes("stock-alerts:product-sales:"));
  assert.ok(state.invalidated.includes("stock-alerts:inventory-base:"));

  state.setFailInsert(true);
  await assert.rejects(refreshInventoryAlertSkuDailyMysqlService(state.deps, { from: "2026-10-19", to: "2026-10-19" }), /injected refresh failure/);
  assert.equal(state.count(), 3, "a failed replacement must keep the previous committed day");
});

test("daily sales count quantities, exclude only pre-transport cancellations and FBP, and recover blank SKU", async () => {
  const state = fixture();
  await refreshInventoryAlertSkuDailyMysqlService(state.deps, { from: "2026-10-19", to: "2026-10-19" });
  const insert = state.writes.find(({ sql }) => /INSERT INTO inventory_alert_sku_daily \(/.test(sql));
  const selectSql = insert.sql.slice(insert.sql.indexOf("SELECT DATE("));
  const db = new DatabaseSync(":memory:");
  db.function("CONCAT_WS", { varargs: true }, (sep, ...values) => values.filter((value) => value != null).join(sep));
  db.function("regexp", (pattern, value) => Number(new RegExp(pattern).test(value || "")));
  try {
    db.exec(`
      CREATE TABLE orders (id INTEGER, shop_id INTEGER, posting_number TEXT, ordered_at TEXT,
        status TEXT, tracking_stage TEXT, logistics_status TEXT, cancelled_after_ship INTEGER, delivered_at TEXT);
      CREATE TABLE order_items (id INTEGER, order_id INTEGER, sku_mapping_id INTEGER, ozon_sku TEXT, quantity INTEGER);
      CREATE TABLE shops (id INTEGER, tenant_id INTEGER);
      INSERT INTO shops VALUES (11, 1);
      CREATE TABLE sku_mappings (id INTEGER, shop_id INTEGER, ozon_sku TEXT, tenant_id INTEGER);
      CREATE TABLE order_status_history (order_id INTEGER, status TEXT);
      CREATE TABLE ozon_orders_raw (store_id INTEGER, posting_number TEXT, query_stock_location TEXT);
      INSERT INTO orders VALUES
        (1, 11, 'new', '2026-10-19 01:00:00', 'awaiting_packaging', '', '', 0, NULL),
        (2, 11, 'cancel-before', '2026-10-19 02:00:00', 'cancelled', 'cancelled', '', 0, NULL),
        (3, 11, 'cancel-after', '2026-10-19 03:00:00', 'cancelled', 'cancelled', '', 0, NULL),
        (4, 11, 'rejected', '2026-10-19 04:00:00', 'rejected', 'rejected', '', 0, NULL),
        (5, 11, 'fbp', '2026-10-19 05:00:00', 'awaiting_packaging', '', '', 0, NULL),
        (6, 11, 'blank-sku', '2026-10-19 06:00:00', 'awaiting_packaging', '', '', 0, NULL);
      INSERT INTO order_items VALUES (-1, 1, NULL, 'S1', 99),
        (1, 1, NULL, 'S1', 2), (2, 2, NULL, 'S1', 3), (3, 3, NULL, 'S1', 4),
        (4, 4, NULL, 'S1', 5), (5, 5, NULL, 'S1', 6), (6, 6, 91, '', 7);
      INSERT INTO order_status_history VALUES (3, 'delivering');
      INSERT INTO ozon_orders_raw VALUES (11, 'fbp', 'FBP');
      INSERT INTO sku_mappings VALUES (91, 11, 'S2', 1);
    `);
    const rows = db.prepare(selectSql).all("2026-10-19", "2026-10-20");
    assert.deepEqual(rows.map((row) => Object.values(row).slice(2, 5)), [["S1", 17, 11], ["S2", 7, 7]]);
  } finally {
    db.close();
  }
});

test("multi-day refresh uses complete individual Beijing dates", async () => {
  const state = fixture();
  await refreshInventoryAlertSkuDailyMysqlService(state.deps, { from: "2026-10-18", to: "2026-10-19" });
  const filters = state.writes.filter(({ sql }) => /INSERT INTO inventory_alert_sku_daily \(/.test(sql));
  assert.deepEqual(filters.map(({ params }) => params), [
    ["2026-10-18-utc", "2026-10-18-next-utc"],
    ["2026-10-19-utc", "2026-10-19-next-utc"]
  ]);
});
