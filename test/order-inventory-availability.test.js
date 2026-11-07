import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadOrderInventoryAvailability, orderInventoryAvailabilityIds } from "../src/services/mysql-order-inventory-availability.js";
import { buildInventoryProductBalances, loadInventoryProductBalances } from "../src/services/mysql-inventory-product-balance.js";
import { calculateOrderProcurementCoverage } from "../src/services/order-procurement-coverage.js";
import { createOrderRoutes, handleOrderRestRoute } from "../src/server/routes/orders.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

function fixture(orders, products, facts = new Map()) {
  const statements = [], calls = [];
  return {
    statements, calls,
    query: async (sql, args) => {
      statements.push({ sql, args });
      return sql.includes("SELECT DISTINCT oi.order_id") ? products : orders;
    },
    loadBalances: async (ids, tenantId, legacy, refresh) => {
      calls.push({ ids, tenantId, legacy, refresh });
      return new Map(ids.filter((id) => facts.has(`${tenantId}:${id}`)).map((id) => [id, facts.get(`${tenantId}:${id}`)]));
    }
  };
}

test("order inventory requests are bounded, canonical positive integer IDs", () => {
  assert.deepEqual(orderInventoryAvailabilityIds({ orderIds: "2, 1,2" }), [2, 1]);
  for (const orderIds of ["", "1,", "0", "-1", "1.5", "1e2", "9007199254740992", Array(101).fill("1").join(",")]) {
    assert.throws(() => orderInventoryAvailabilityIds({ orderIds }), { statusCode: 400 });
  }
});

test("ordinary tenant authorization rejects a mixed order batch before inventory reads", async () => {
  const hooks = fixture([{ order_id: 1, tenant_id: 42 }], []);
  await assert.rejects(loadOrderInventoryAvailability(hooks, { orderIds: "1,2" }, { tenantId: 42, defaultTenantId: 1 }), { statusCode: 404 });
  assert.equal(hooks.statements.length, 1);
  assert.deepEqual(hooks.statements[0].args, [1, 2, 42]);
  assert.match(hooks.statements[0].sql, /s\.tenant_id = \? AND s\.status = 'active'/);
  assert.equal(hooks.calls.length, 0);
});

test("administrator batches derive each order's real tenant and project only independent numeric facts", async () => {
  const hooks = fixture([
    { order_id: 10, tenant_id: 42 }, { order_id: 20, tenant_id: null },
    { order_id: 30, tenant_id: 43 }, { order_id: 40, tenant_id: 42 }
  ], [
    { order_id: 10, product_id: 8, tenant_id: 42 }, { order_id: 10, product_id: 8, tenant_id: 42 },
    { order_id: 20, product_id: 9, tenant_id: 1 }, { order_id: 30, product_id: 18, tenant_id: 43 }
  ], new Map([
    ["42:8", { physical_stock: "11.0000", available_stock: "0.0000", ledger_qty: 999, inventory_needs_review: 0 }],
    ["1:9", { physical_stock: "-2.0000", available_stock: "0.0000", inventory_needs_review: 1 }],
    ["43:18", { physical_stock: 50, available_stock: 42, inventory_needs_review: false }]
  ]));
  const result = await loadOrderInventoryAvailability(hooks, { orderIds: "30,10,20,40", refresh: "1" }, { defaultTenantId: 1 });
  assert.deepEqual(hooks.calls, [
    { ids: [8], tenantId: 42, legacy: false, refresh: true },
    { ids: [9], tenantId: 1, legacy: true, refresh: true },
    { ids: [18], tenantId: 43, legacy: false, refresh: true }
  ]);
  assert.deepEqual(result, { rows: [
    { order_id: 30, inventory_availability: [{ product_id: 18, physical_stock: 50, available_stock: 42, inventory_needs_review: false }] },
    { order_id: 10, inventory_availability: [{ product_id: 8, physical_stock: 11, available_stock: 0, inventory_needs_review: false }] },
    { order_id: 20, inventory_availability: [{ product_id: 9, physical_stock: -2, available_stock: 0, inventory_needs_review: true }] },
    { order_id: 40, inventory_availability: [] }
  ] });
  assert.doesNotMatch(JSON.stringify(result), /procurement_coverage|stock_quantity|ledger_qty/);
  assert.match(hooks.statements[1].sql, /direct_mapping\.shop_id = o\.shop_id/);
  for (const alias of ["direct_mapping", "fallback_mapping", "sm", "p", "pc", "child"]) {
    assert.ok(hooks.statements[1].sql.includes(`${alias}.tenant_id = COALESCE(s.tenant_id, 1)`));
  }
  assert.match(hooks.statements[1].sql, /WHEN recipe\.id IS NOT NULL THEN ri\.product_id/);
  assert.match(hooks.statements[1].sql, /WHEN pc\.component_product_id IS NOT NULL THEN pc\.component_product_id ELSE p\.id END/);
});

test("ordinary tenant source and balances stay scoped, unbound orders need no balance read", async () => {
  const hooks = fixture([{ order_id: 1, tenant_id: 42 }, { order_id: 2, tenant_id: 42 }], [
    { order_id: 1, product_id: 8, tenant_id: 42 }
  ], new Map([["42:8", { physical_stock: 0, available_stock: 0 }]]));
  const result = await loadOrderInventoryAvailability(hooks, { orderIds: "1,2" }, { tenantId: 42, defaultTenantId: 1 });
  assert.deepEqual(hooks.calls, [{ ids: [8], tenantId: 42, legacy: false, refresh: false }]);
  assert.deepEqual(hooks.statements[1].args, [1, 2, 42]);
  assert.deepEqual(result.rows[1], { order_id: 2, inventory_availability: [] });
});

test("unknown or invalid balances never become a fabricated zero and ownership changes fail closed", async () => {
  for (const facts of [new Map(), new Map([["42:8", { physical_stock: null, available_stock: 0 }]]), new Map([["42:8", { physical_stock: "bad", available_stock: 0 }]])]) {
    const hooks = fixture([{ order_id: 1, tenant_id: 42 }], [{ order_id: 1, product_id: 8, tenant_id: 42 }], facts);
    await assert.rejects(loadOrderInventoryAvailability(hooks, { orderIds: "1" }, { tenantId: 42, defaultTenantId: 1 }), { statusCode: 503 });
  }
  const changed = fixture([{ order_id: 1, tenant_id: 42 }], [{ order_id: 1, product_id: 8, tenant_id: 43 }]);
  await assert.rejects(loadOrderInventoryAvailability(changed, { orderIds: "1" }, { defaultTenantId: 1 }), { statusCode: 503 });
  assert.equal(changed.calls.length, 0);
});

test("balance facts retain the coverage arithmetic for physical, all local demand and FBP reservations", () => {
  const coverage = calculateOrderProcurementCoverage({
    stocks: [{ product_id: 8, ledger: 8, open_deducted: 3, fbp_reserved: 2 }],
    demands: [
      { order_id: 1, order_item_id: 11, product_id: 8, quantity: 1, needs_fulfillment: 1, stock_location: "LOCAL" },
      { order_id: 2, order_item_id: 12, product_id: 8, quantity: 3, needs_fulfillment: 1, stock_location: "LOCAL" },
      { order_id: 3, order_item_id: 13, product_id: 8, quantity: 100, needs_fulfillment: 1, stock_location: "FBP" }
    ]
  });
  const [balance] = buildInventoryProductBalances([8], [{ product_id: 8, ledger_qty: 8, movement_fbp_reserved_qty: 2 }],
    [{ product_id: 8, open_demand_qty: 4 }], [{ product_id: 8, open_deducted_qty: 3 }], [{ product_id: 8, quantity: 1 }]);
  const expected = coverage.product_availability.get(8);
  assert.deepEqual([balance.physical_stock, balance.available_stock], [expected.physical_stock, expected.available_stock]);
  assert.deepEqual([balance.physical_stock, balance.available_stock], [11, 5]);
});

test("the balance source excludes FBP demand/deductions and keeps the existing transport and net-adjustment evidence", async () => {
  const statements = [];
  await loadInventoryProductBalances(async (sql) => {
    statements.push(sql);
    assert.match(sql, /tenant_id = (?:\?|42)/);
    if (sql.includes("FROM inventory_product_balance")) return [{ product_id: 8, physical_stock: 1, available_stock: 1, open_order_demand_qty: 0, fbp_reserved_qty: 0, age_seconds: 0 }];
    return [];
  }, async () => { throw new Error("fresh source cannot write"); }, 42, false, [8]);
  assert.equal(statements.length, 1, "a fresh product balance is read without full allocation reconciliation");
  const source = readFileSync(new URL("../src/services/mysql-inventory-product-balance.js", import.meta.url), "utf8");
  assert.match(source, /raw\.query_stock_location = 'FBP'/);
  assert.match(source, /AND NOT \$\{orderTransportEvidenceSql\("o"\)\}/);
  assert.match(source, /im\.source_type IN \('order_outbound', 'order_outbound_adjustment'\)/);
});

test("the exact inventory route precedes numeric detail, propagates tenant and fails explicitly without a runtime adapter", async () => {
  const tenant = { id: 42, slug: "company-a" }, req = { method: "GET", _session: { tenant } };
  const url = new URL("http://localhost:8788/api/orders/inventory-availability?orderIds=1&refresh=1");
  const calls = [], services = { orderInventoryAvailability: async (...args) => { calls.push(args); return { rows: [] }; }, orderDetail: () => { throw new Error("not a numeric detail"); } };
  const direct = createOrderRoutes({ services });
  assert.deepEqual(await direct["GET /api/orders/inventory-availability"](req, url), { rows: [] });
  assert.deepEqual(await handleOrderRestRoute({ req, url, parts: ["api", "orders", "inventory-availability"], services, json: (_res, value) => value }), { rows: [] });
  assert.deepEqual(calls, [[{ orderIds: "1", refresh: "1" }, "42"], [{ orderIds: "1", refresh: "1" }, "42"]]);
  assert.equal(tenantIsolationDecision({ tenant }, ["api", "orders", "inventory-availability"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision({ tenant }, ["api", "orders", "inventory-availability"], "POST").allowed, false);
  assert.throws(() => createOrderRoutes({ services: {} })["GET /api/orders/inventory-availability"](req, url), { statusCode: 503 });
});
