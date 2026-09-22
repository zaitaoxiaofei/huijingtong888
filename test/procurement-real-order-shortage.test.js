import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { groupProcurementRequestsMysql, procurementOrderActionClassMysql, procurementPriorityBreakdownMysql, procurementRealOrderShortageMysql } from "../src/services/mysql-procurement-list.js";

function requestRow(overrides = {}) {
  return {
    id: 1,
    product_id: 10,
    product_name: "测试库存商品",
    quantity: 1,
    amount: 20,
    shipping_amount: 0,
    status: "suggested",
    purchase_order_status: "",
    source_order_id: 100,
    source_order_item_id: 200,
    source_order_status: "awaiting_packaging",
    stock: -3,
    incoming_stock: 0,
    created_at: "2026-08-29 10:00:00",
    ...overrides
  };
}

test("historical inventory debt remains visible separately from current purchasing", () => {
  const result = groupProcurementRequestsMysql([requestRow({ recent_7d_qty: 8, recent_30d_qty: 20 })], { page: 1, pageSize: 20, demandType: "real_order" });
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].order_demand_quantity, 1);
  assert.equal(result.rows[0].real_order_shortage, 1);
  assert.equal(result.rows[0].suggested_purchase_qty, 1);
  assert.equal(result.rows[0].inventory_debt_shortage, 3);
  assert.equal(result.rows[0].priority_level, "P0");
  assert.deepEqual(result.rows[0].suggestion_reasons, [{
    type: "real_order",
    label: "真实订单需求",
    quantity: 1,
    text: "真实订单：1 个待发订单需采购 1 件"
  }]);
  assert.deepEqual(result.rows[0].primary_suggestion_reason, result.rows[0].suggestion_reasons[0]);
  assert.equal(result.rows[0].primary_suggested_purchase_qty, 1);
});

test("only pre-shipment real orders remain actionable procurement demand", () => {
  assert.equal(procurementOrderActionClassMysql({ source_order_status: "awaiting_packaging" }), "p0_purchase");
  assert.equal(procurementOrderActionClassMysql({ source_order_status: "awaiting_deliver" }), "p0_purchase");
  assert.equal(procurementOrderActionClassMysql({ source_order_status: "delivering" }), "p1_missing_record");
  assert.equal(procurementOrderActionClassMysql({ source_order_status: "delivered" }), "p1_missing_record");
  assert.equal(procurementOrderActionClassMysql({ source_order_status: "rejected" }), "p1_missing_record");
  assert.equal(procurementOrderActionClassMysql({ source_order_status: "cancelled" }), "p2_cancelled");
  assert.equal(procurementOrderActionClassMysql({ source_order_status: "after_delivery_return" }), "p2_returned");

  const result = groupProcurementRequestsMysql([
    requestRow({ id: 1, source_order_item_id: 201, source_order_status: "awaiting_packaging" }),
    requestRow({ id: 2, source_order_item_id: 202, source_order_status: "delivering" }),
    requestRow({ id: 3, source_order_item_id: 203, source_order_status: "cancelled" })
  ], { page: 1, pageSize: 20, demandType: "real_order" });
  assert.equal(result.rows[0].order_demand_quantity, 1);
  assert.equal(result.rows[0].requests.length, 1);
  assert.equal(result.rows[0].suggested_purchase_qty, 1);
});

test("newly available stock can cover an existing real-order request", () => {
  const result = groupProcurementRequestsMysql([requestRow({ stock: 1 })], { page: 1, pageSize: 20, demandType: "real_order" });
  assert.equal(result.total, 0);
});

test("deferred coverage keeps real-order shortage calculation on current stock", async () => {
  const service = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  assert.match(service, /row\.operational_shortage = deferCoverage\s*\? null\s*:\s*operationalByProduct\.get\(Number\(row\.product_id\)\) \|\| 0/);
});

test("component stock and incoming supply cover a combination-product request", () => {
  assert.equal(procurementRealOrderShortageMysql({
    order_demand_quantity: 1,
    stock: -9,
    component_count: 2,
    component_local_stock: 1,
    component_incoming_stock: 0
  }), 0);
});

test("a submitted request without a purchase order remains visible as waiting demand", () => {
  const result = groupProcurementRequestsMysql([requestRow({ status: "submitted" })], { page: 1, pageSize: 20, demandType: "real_order" });
  assert.equal(result.total, 1);
});

test("advance-stock recommendations do not repurchase historical discrepancies", () => {
  const result = groupProcurementRequestsMysql([requestRow({
    source_order_id: null,
    source_order_item_id: null,
    demand_type: "advance_stock",
    quantity: 10,
    stock: -78,
    incoming_stock: 50,
    recent_7d_qty: 26,
    recent_30d_qty: 85,
    week1_qty: 26,
    week2_qty: 18,
    week3_qty: 23
  })], { page: 1, pageSize: 20 });

  assert.equal(result.total, 1);
  assert.equal(result.rows[0].suggested_purchase_qty, 10);
  assert.equal(result.rows[0].coverage_days, 17.6);
  assert.equal(result.rows[0].inventory_debt_shortage, 78);
  assert.equal(result.rows[0].safety_stock_shortage, 10);
  assert.match(result.rows[0].suggestion_reasons.find((reason) => reason.type === "advance_stock").text, /提前采购：按近30天日均销量覆盖 21 天日常备货，建议 10 件/);
  assert.equal(result.rows[0].primary_suggestion_reason.type, "advance_stock");
  assert.equal(result.rows[0].primary_suggested_purchase_qty, 10);
});

test("the display suggestion prioritizes real orders over additional replenishment", () => {
  const result = groupProcurementRequestsMysql([
    requestRow({ id: 1, quantity: 2, stock: 0 }),
    requestRow({ id: 2, source_order_id: null, source_order_item_id: null, demand_type: "advance_stock", quantity: 10, stock: 0 })
  ], { page: 1, pageSize: 20 });

  assert.equal(result.rows[0].suggested_purchase_qty, 10);
  assert.equal(result.rows[0].primary_suggestion_reason.type, "real_order");
  assert.equal(result.rows[0].primary_suggested_purchase_qty, 2);
});

test("incoming supply covers current orders without erasing historical debt", () => {
  assert.deepEqual(procurementPriorityBreakdownMysql({ stock: -79, incoming_stock: 50, order_demand_quantity: 20 }, 60), {
    local_supply: -79,
    incoming_supply: 50,
    inventory_debt: 79,
    inventory_debt_shortage: 79,
    incoming_after_debt: 50,
    order_demand: 20,
    real_order_shortage: 0,
    safety_stock_shortage: 30,
    total_priority_shortage: 30
  });
});
