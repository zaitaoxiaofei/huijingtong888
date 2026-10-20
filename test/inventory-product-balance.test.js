import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildInventoryProductBalances,
  invalidateInventoryProductBalance,
  loadInventoryProductBalances
} from "../src/services/mysql-inventory-product-balance.js";

test("库存余额按实物流水、未出库占用及 FBP 预留核算，取消前回补不重复计数", () => {
  const rows = buildInventoryProductBalances(
    [1, 2, 3],
    [
      { product_id: 1, ledger_qty: 8, movement_fbp_reserved_qty: 2 },
      { product_id: 2, ledger_qty: -1, movement_fbp_reserved_qty: 0 }
    ],
    [{ product_id: 1, open_demand_qty: 4 }, { product_id: 2, open_demand_qty: 2 }],
    [{ product_id: 1, open_deducted_qty: 3 }],
    [{ product_id: 1, quantity: 1 }]
  );
  assert.deepEqual(rows.map((row) => [row.physical_stock, row.available_stock, row.open_order_demand_qty, row.fbp_reserved_qty]),
    [[11, 5, 4, 2], [-1, 0, 2, 0], [0, 0, 0, 0]]);
  assert.equal(rows[1].inventory_needs_review, true);
  const cancelled = buildInventoryProductBalances([1], [{ product_id: 1, ledger_qty: 11 }], [], [], []);
  assert.equal(cancelled[0].physical_stock, 11);
  assert.equal(cancelled[0].available_stock, 11);
  // Quantity 2 was deducted, then quantity 1 restored by an order adjustment.
  const revised = buildInventoryProductBalances([1], [{ product_id: 1, ledger_qty: 9 }],
    [{ product_id: 1, open_demand_qty: 1 }], [{ product_id: 1, open_deducted_qty: 1 }], []);
  assert.equal(revised[0].physical_stock, 10);
  assert.equal(revised[0].available_stock, 9);
});

test("企业汇总批量重算、原子写入，并验证租户隔离、组件倍数和运输史 SQL", async () => {
  const statements = [];
  const stored = new Map();
  let transactions = 0;
  const query = async (sql, params = []) => {
    statements.push({ sql, params });
    if (sql.includes("FROM inventory_product_balance")) {
      return (params[0] === 29 ? params.slice(1) : []).map((id) => stored.get(`29:${id}`)).filter(Boolean);
    }
    if (sql.includes("FROM inventory_movements im") && sql.includes("AS ledger_qty")) return [{ product_id: 1, ledger_qty: 20, movement_fbp_reserved_qty: 2 }];
    if (sql.includes("AS open_demand_qty")) return [{ product_id: 1, open_demand_qty: 6 }];
    if (sql.includes("AS open_deducted_qty")) return [{ product_id: 1, open_deducted_qty: 4 }];
    if (sql.includes("FROM fbp_replenishment_order_items i")) return [{ product_id: 1, quantity: 3 }];
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const transaction = async (callback) => {
    transactions += 1;
    return callback({ execute: async (sql, params) => {
      if (sql.includes("DELETE FROM inventory_product_balance")) {
        for (const id of params.slice(1)) stored.delete(`${params[0]}:${id}`);
      } else if (sql.includes("INSERT INTO inventory_product_balance")) {
        for (let i = 0; i < params.length; i += 9) {
          const row = params.slice(i, i + 9);
          stored.set(`${row[0]}:${row[1]}`, {
            product_id: row[1], ledger_qty: row[2], open_deducted_qty: row[3],
            open_order_demand_qty: row[4], fbp_reserved_qty: row[5],
            physical_stock: row[6], available_stock: row[7], inventory_needs_review: row[8], age_seconds: 0
          });
        }
      }
    } });
  };
  const result = await loadInventoryProductBalances(query, transaction, 29, false, [1, 2]);
  assert.equal(transactions, 1);
  assert.equal(result.get(1).physical_stock, 24);
  assert.equal(result.get(1).available_stock, 15);
  assert.equal(result.get(2).available_stock, 0);
  assert.ok(statements.filter(({ sql }) => sql.includes("AS open_demand_qty"))[0].sql.includes("oi.quantity * COALESCE(ri.quantity, pc.quantity, 1)"));
  assert.ok(statements.filter(({ sql }) => sql.includes("AS open_demand_qty"))[0].sql.includes("order_status_history transport_history"));
  assert.match(statements.filter(({ sql }) => sql.includes("AS open_deducted_qty"))[0].sql,
    /im\.source_type IN \('order_outbound', 'order_outbound_adjustment'\)/);
  for (const { sql } of statements.filter(({ sql }) => !sql.includes("FROM inventory_product_balance"))) {
    assert.match(sql, /tenant_id = 29/);
    assert.doesNotMatch(sql, /tenant_id IS NULL/);
  }
  await loadInventoryProductBalances(query, transaction, 29, false, [1, 2]);
  assert.equal(transactions, 1, "fresh projection should be read without recomputing order history");
  invalidateInventoryProductBalance();
  await loadInventoryProductBalances(query, transaction, 29, false, [1, 2]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transactions, 2, "a source mutation must bypass the existing projection");
});

test("完整旧快照先返回并后台刷新，超过九十秒则等待重算", async () => {
  let age = 60;
  let releaseSource;
  let refreshes = 0;
  const gate = new Promise((resolve) => { releaseSource = resolve; });
  const row = { product_id: 8, ledger_qty: 4, open_deducted_qty: 0, open_order_demand_qty: 0,
    fbp_reserved_qty: 0, physical_stock: 4, available_stock: 4, age_seconds: age };
  const query = async (sql) => {
    if (sql.includes("FROM inventory_product_balance")) return [{ ...row, age_seconds: age }];
    await gate;
    return [];
  };
  const transaction = async (callback) => {
    refreshes += 1;
    return callback({ execute: async () => {} });
  };
  const first = await loadInventoryProductBalances(query, transaction, 81, false, [8]);
  assert.equal(first.get(8).available_stock, 4, "a complete 60-second snapshot should not block the page");
  assert.equal(refreshes, 0, "background recomputation is still waiting on the source");
  releaseSource();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);
  age = 91;
  await loadInventoryProductBalances(query, transaction, 81, false, [8]);
  assert.equal(refreshes, 2, "the hard freshness limit must wait for a new computation");
});

test("库存预警使用余额投影且失败时才回退采购覆盖；部署 schema 含企业复合主键", () => {
  const service = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8");
  const branch = service.slice(service.indexOf('if (mode === "inventory-alerts")'), service.indexOf("const cacheKey = `stock-alerts:base:v3:"));
  assert.match(branch, /inventoryProductBalanceMysql\(productIds, inventoryTenantPk, inventoryDefaultTenant, forceRefresh\)/);
  assert.match(branch, /\.catch\(async \(error\) =>/);
  assert.match(branch, /orderProcurementCoverageMysql\(\{ productIds, tenantId: inventoryTenantPk/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS inventory_product_balance/);
  assert.match(schema, /PRIMARY KEY \(tenant_id, product_id\)/);
});
