import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planLedgerAction } from "../src/services/procurement-ledger.js";

const service = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../scripts/init-mysql-schema.mjs", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../frontend/admin/views/procurement/ProcurementWorkspaceView.vue", import.meta.url), "utf8");
const orders = readFileSync(new URL("../frontend/orders/OrdersPage.vue", import.meta.url), "utf8");
const ledger = readFileSync(new URL("../src/services/procurement-ledger.js", import.meta.url), "utf8");

test("purchase mode is stored per request and purchase item without rewriting history", () => {
  assert.match(schema, /procurement_requests[\s\S]*purchase_mode VARCHAR\(32\) NOT NULL DEFAULT 'shortage_purchase'/);
  assert.match(schema, /purchase_order_items[\s\S]*purchase_mode VARCHAR\(32\) NOT NULL DEFAULT 'shortage_purchase'/);
  assert.match(service, /stock_record_backfill/);
});

test("three purchase modes use separate inventory semantics", () => {
  assert.match(service, /inventory_update/);
  assert.match(service, /historical_debt_backfill/);
  assert.match(service, /action_type: 'stocktake'/);
  assert.match(service, /action_type: 'historical_purchase_bulk'/);
  assert.match(ledger, /inventory_effect !== 'already_accounted'/);
  assert.match(ledger, /row\.entered_transport && row\.stock_location !== 'FBP'/);
  assert.match(ledger, /stocktake_valuation/);
});

test("workspace and order purchase entry expose explained business modes", () => {
  for (const source of [workspace, orders]) {
    assert.match(source, /缺货采购/);
    assert.match(source, /更新实存/);
    assert.match(source, /历史采购补记/);
    assert.match(source, /description/);
  }
  assert.match(orders, /disabled: true/);
  assert.match(service, /当前待备货／待发货订单不能使用/);
});

test("updating actual stock records quantity and total valuation without creating transit", () => {
  const plan = planLedgerAction({ revision: "current", product: { id: 1 }, physical_estimate: 3, local_stock: 3, stocktake_id: 1, cost_tasks: [] }, {
    revision: "current", action_type: "stocktake", counted_quantity: 5, counted_amount: 100, reason: "仓库复盘",
  });
  assert.equal(plan.local_delta, 2);
  assert.equal(plan.counted_amount, 100);
  assert.equal(plan.counted_unit_cost, 20);
  assert.equal(plan.cost_task_quantity, 0);
});
