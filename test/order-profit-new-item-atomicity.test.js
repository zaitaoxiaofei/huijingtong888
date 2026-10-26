import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { retryProfitCalculationTransaction } from "../src/services/order-profit-calculation-versions.js";

const source = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const start = source.indexOf("const orderItemId = await retryProfitCalculationTransaction(withMysqlTransaction");
const end = source.indexOf("\n    if (!mapping)", start);
assert.ok(start > 0 && end > start);
const createItem = vm.runInNewContext(`(async (deps) => {
  const {retryProfitCalculationTransaction,withMysqlTransaction,profitCalculationDatabase,withVersionedOrderProfitWrite,
    profitEstimateInputs,saveProfitItemMysql,syncOrderItemProfitFromBreakdownMysql,orderId,mapping,item,normalizedItem,
    product,estimated,settlement,returnLossEstimate,estimatedProfit,posting,profitFxState,getOrderProfitFxPolicy,readOrderProfitFxState,shop}=deps;
  ${source.slice(start, end)}
  return orderItemId;
})`);

function scenario(failures = []) {
  let committed = { items: [], saved: false, synchronized: false };
  let attempts = 0;
  const deps = {
    retryProfitCalculationTransaction: (provider, callback) => retryProfitCalculationTransaction(provider, callback, { sleepImpl: async () => {} }),
    async withMysqlTransaction(callback) {
      attempts += 1;
      const connection = { working: structuredClone(committed) };
      const result = await callback(connection);
      committed = connection.working;
      return result;
    },
    profitCalculationDatabase: (connection) => ({ queryOne: async sql => {
      assert.match(sql, /SELECT id FROM order_items.*FOR UPDATE/);return null;
    }, query: async sql => {
      assert.match(sql, /SELECT id FROM orders.*FOR UPDATE/);return [{ id: 10 }];
    }, execute: async (sql, params) => {
      assert.match(sql, /INSERT INTO order_items/);
      connection.working.items.push({ id: 33, order_id: params[0] });
      return { insertId: 33 };
    } }),
    async withVersionedOrderProfitWrite(id, options, project) {
      assert.equal(id, 33);
      assert.equal(options.connection.working.items.length, 1);
      await project({ connection: options.connection });
      const failure = failures.shift();
      if (failure) throw failure;
    },
    profitEstimateInputs: () => ({}),
    saveProfitItemMysql: async ({ connection }) => { connection.working.saved = true; },
    syncOrderItemProfitFromBreakdownMysql: async (id, settlement, connection) => { connection.working.synchronized = true; },
    orderId: 10, mapping: { id: 5 }, item: { ozon_sku: "fixture", quantity: 1, sale_price: 38 },
    normalizedItem: {}, product: { purchase_cost: 10 }, estimated: { commission: 3, freight: 5 },
    settlement: "pending", returnLossEstimate: 0, estimatedProfit: 20, posting: {}, profitFxState: null,
    getOrderProfitFxPolicy: async () => null, shop: { tenant_id: 7 }
  };
  return { deps, state: () => committed, attempts: () => attempts };
}

test("a failed first revision rolls back the new order item so the next sync can run first outbound", async () => {
  const fixture = scenario([new Error("revision failed")]);
  await assert.rejects(createItem(fixture.deps), /revision failed/);
  assert.deepEqual(fixture.state(), { items: [], saved: false, synchronized: false });
  assert.equal(await createItem(fixture.deps), 33);
  assert.deepEqual(fixture.state(), { items: [{ id: 33, order_id: 10 }], saved: true, synchronized: true });
});

test("a deadlock retries the complete item and first-profit transaction without leaving a partial insert", async () => {
  const fixture = scenario([Object.assign(new Error("deadlock"), { code: "ER_LOCK_DEADLOCK" })]);
  assert.equal(await createItem(fixture.deps), 33);
  assert.equal(fixture.attempts(), 2);
  assert.equal(fixture.state().items.length, 1);
  assert.ok(fixture.state().saved && fixture.state().synchronized);
});
