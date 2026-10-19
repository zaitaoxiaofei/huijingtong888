import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

function functionSection(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return source.slice(from, to).replace(/^export /, "");
}

function loadSection(section, dependencies) {
  const context = vm.createContext({ ...dependencies });
  vm.runInContext(section, context);
  return context;
}

const prepareSection = functionSection(
  "async function prepareProcurementRequestPurchaseQuantitiesMysql(",
  "function beijingLedgerTimestampMysql(");

function prepareHarness(rows) {
  const writes = [];
  const reads = [];
  const connection = {
    async query(sql, params) {
      reads.push({ sql, params });
      return [reads.length === 1 ? rows : []];
    },
    async execute(sql, params) {
      writes.push({ sql, params });
      return [{ insertId: 901 }];
    }
  };
  const context = loadSection(prepareSection, {
    requireDefaultProcurementTenantMysql: async () => 7,
    normalizeProcurementPurchaseMode: (value) => value || "shortage_purchase",
    withMysqlTransaction: () => { throw new Error("unexpected nested transaction"); }
  });
  return { prepare: context.prepareProcurementRequestPurchaseQuantitiesMysql, connection, writes, reads };
}

test("warehouse and automatic stock suggestions close whole on a smaller confirmed purchase", async () => {
  for (const request of [
    { id: 17, product_id: 9, quantity: 200, demand_type: "warehouse_request", request_group_no: "CG-1" },
    { id: 18, product_id: 9, quantity: 200, demand_type: "advance_stock", request_group_no: "AUTO-STOCK-20261019-9" }
  ]) {
    const { prepare, connection, writes, reads } = prepareHarness([request]);
    const ids = await prepare({ request_ids: [request.id], items: [{ product_id: 9, actual_quantity: 40 }] }, connection, 7);
    assert.deepEqual(Array.from(ids), [request.id]);
    assert.equal(writes.length, 0, "the original request must not gain a suggested remainder or a replacement ID");
    assert.match(reads[0].sql, /request\.tenant_id = \?/);
    assert.match(reads[0].sql, /product\.tenant_id = \?/);
  }
});

test("real order shortages retain their existing partial purchase split", async () => {
  const request = { id: 21, product_id: 9, quantity: 200, demand_type: "real_order", source_order_item_id: 81 };
  const { prepare, connection, writes } = prepareHarness([request]);
  const ids = await prepare({ request_ids: [21], items: [{ product_id: 9, actual_quantity: 40 }] }, connection, 7);
  assert.deepEqual(Array.from(ids), [901]);
  assert.match(writes[0].sql, /status = 'suggested'/);
  assert.equal(writes[0].params[0], 160);
  assert.match(writes[1].sql, /source_order_item_id/);
});

const warningSection = functionSection(
  "function procurementInventoryWarningJoinsMysql(",
  "let pendingOrderProcurementReconcilePromise = null;");

test("stock warning SQL scopes tenants and keeps rejected or purchased episodes closed until recovery", async () => {
  const statements = [];
  const context = loadSection(warningSection, {
    localStockLocationPredicateMysql: () => "stock_location = 'LOCAL'",
    chinaDateSqlMysql: (column) => column,
    ensureProcurementFlexibleRequestSchemaMysql: async () => {},
    requireDefaultProcurementTenantMysql: async () => 7,
    mysqlExecute: async (sql, params) => { statements.push({ sql, params }); }
  });
  assert.match(context.procurementInventoryWarningJoinsMysql(7), /component_product\.tenant_id = 7/);
  await context.ensureInventoryWarningProcurementRequestsMysql();
  assert.equal(statements.length, 4);
  for (const statement of statements) {
    assert.equal((statement.sql.match(/\?/g) || []).length, statement.params.length);
  }
  assert.match(statements[0].sql, /warning_episode_closed_at = CURRENT_TIMESTAMP/);
  assert.match(statements[0].sql, /NOT \(COALESCE\(warning_sales\.recent_30d_qty, 0\) > 0/);
  assert.match(statements[1].sql, /SET status = 'cancelled', approval_status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP/);
  assert.doesNotMatch(statements[1].sql, /CASE[\s\S]*status/);
  assert.match(statements[3].sql, /existing_request\.request_group_no LIKE 'AUTO-STOCK-%'[\s\S]*existing_request\.warning_episode_closed_at IS NULL/);
  assert.match(statements[3].sql, /existing_request\.demand_type = 'warehouse_request'[\s\S]*existing_request\.approval_status = 'rejected'/);
  assert.deepEqual(Array.from(statements[3].params), [7, 7, 7]);
});

test("warehouse rejection records a terminal decision that blocks the current warning episode", () => {
  const workspace = readFileSync(new URL("../frontend/admin/views/procurement/ProcurementWorkspaceView.vue", import.meta.url), "utf8");
  assert.match(workspace, /async function rejectWarehouseRequest[\s\S]*status: "cancelled",\s*approval_status: "rejected"/);
  assert.match(source, /function procurementInventoryWarningJoinsMysql[\s\S]*existing_request\.approval_status = 'rejected'/);
});

const confirmSection = functionSection(
  "export async function confirmProcurementRequestsPurchasedMysql(",
  "export async function recordProcurementPurchaseMysql(");

function confirmationHarness({ failConfirmation = false } = {}) {
  const state = { requestId: 17, quantity: 200, status: "submitted", purchaseOrderId: null };
  const calls = [];
  const events = [];
  const context = loadSection(confirmSection, {
    requireDefaultProcurementTenantMysql: async (tenantId) => {
      if (tenantId !== "admin") throw new Error("tenant gate");
      return 7;
    },
    invalidateOrderProcurementCoverage: () => { events.push("invalidate"); },
    normalizeProcurementPurchaseMode: () => "shortage_purchase",
    assertDefaultProcurementProductsMysql: async () => {},
    ensureProcurementPurchaseModeSchemaMysql: async () => {},
    ensurePurchaseCostVersionSchemaMysql: async () => {},
    ensurePurchaseOrderShipmentSchemaMysql: async () => {},
    withMysqlTransaction: async (callback) => {
      const before = { ...state };
      try {
        const result = await callback({ transaction: true });
        events.push("commit");
        return result;
      } catch (error) {
        Object.assign(state, before);
        events.push("rollback");
        throw error;
      }
    },
    prepareProcurementRequestPurchaseQuantitiesMysql: async (_body, connection) => {
      assert.equal(connection.transaction, true);
      calls.push("prepare");
      state.quantity = 160;
      return [17];
    },
    mergeProcurementRequestsMysql: async (body, _personId, connection) => {
      assert.equal(connection.transaction, true);
      assert.deepEqual(Array.from(body.request_ids), [17]);
      calls.push("merge");
      state.status = "merged";
      state.purchaseOrderId = 55;
      return { id: 55, order_no: "PO-55" };
    },
    confirmPurchaseOrderMysql: async (_id, _body, _personId, connection) => {
      assert.equal(connection.transaction, true);
      calls.push("confirm");
      if (failConfirmation) throw new Error("price validation failed");
      state.status = "purchased";
    }
  });
  return { confirm: context.confirmProcurementRequestsPurchasedMysql, state, calls, events };
}

const purchaseBody = { request_ids: [17], items: [{ product_id: 9, actual_quantity: 40 }] };

test("confirmed purchase keeps the warehouse request ID linked and invalidates cached demand after commit", async () => {
  const { confirm, state, calls, events } = confirmationHarness();
  const result = await confirm(purchaseBody, 3, "admin");
  assert.deepEqual(calls, ["prepare", "merge", "confirm"]);
  assert.equal(result.purchase_order_id, 55);
  assert.deepEqual(state, { requestId: 17, quantity: 160, status: "purchased", purchaseOrderId: 55 });
  assert.deepEqual(events, ["invalidate", "commit", "invalidate"]);
  assert.match(source, /const result = transactionConnection \? await confirm\(transactionConnection\) : await withMysqlTransaction\(confirm\);\s*if \(!transactionConnection\) invalidateOrderProcurementCoverage\(\)/);
});

test("confirmation failure rolls back the quantity split and request linkage", async () => {
  const { confirm, state, calls } = confirmationHarness({ failConfirmation: true });
  await assert.rejects(confirm(purchaseBody, 3, "admin"), /price validation failed/);
  assert.deepEqual(calls, ["prepare", "merge", "confirm"]);
  assert.deepEqual(state, { requestId: 17, quantity: 200, status: "submitted", purchaseOrderId: null });
});

test("nondefault tenants cannot enter the shared procurement purchase flow", async () => {
  const { confirm, state, calls } = confirmationHarness();
  await assert.rejects(confirm(purchaseBody, 3, "other"), /tenant gate/);
  assert.deepEqual(calls, []);
  assert.equal(state.status, "submitted");
});
