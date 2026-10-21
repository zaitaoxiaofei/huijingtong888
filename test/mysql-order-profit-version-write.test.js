import assert from "node:assert/strict";
import test from "node:test";
import {
  profitCalculationOutputForLayer,
  withVersionedOrderProfitBatchWrite, withVersionedOrderProfitWrite
} from "../src/services/mysql-order-profit-version-write.js";
import { retryProfitCalculationTransaction } from "../src/services/order-profit-calculation-versions.js";

// A mysql2-shaped adapter exercises the actual revision writer without opening
// a pool, reading application data or requiring a database server.
function memoryProjection() {
  const projection = {
    order_item_id: 101, order_id: 11, tenant_key: "7", ordered_at: "2026-10-20 01:00:00",
    quantity: 1, sale_price: "100.0000", sku_mapping_id: 5,
    frozen_purchase_cost: "20.0000", frozen_domestic_shipping: "2.0000", frozen_international_shipping: "10.0000",
    frozen_logistics_rule_id: 70, frozen_handling_fee: "0.5000", estimated_commission: "12.0000", aftersale_loss: "1.0000",
    estimated_profit: "54.5000", actual_profit: "50.0000", settlement_state: "accrued", platform_fee_actual: "17.0000",
    sale_amount_cny: "100.0000", purchase_cost_cny: "20.0000", domestic_shipping_cny: "2.0000", international_shipping_cny: "11.0000",
    packaging_cost_cny: "0.5000", commission_rate: "0.1200", commission_fee_cny: "12.0000", ozon_service_fee_cny: "1.5000",
    return_loss_cny: "1.0000", advertising_cost_cny: "1.0000", other_fee_cny: "0.0000", gross_profit_cny: "52.5000", net_profit_cny: "50.0000",
    profit_status: "accrued", is_locked: 1, locked_at: "2026-10-21 01:00:00", lock_reason: "finance_accrued"
  };
  let state;
  const revisions = [];
  const queryLog = [];
  const connection = {
    async query(sql, params = []) {
      queryLog.push(sql);
      if (/SELECT id FROM order_items WHERE id = \? FOR UPDATE/.test(sql)) return [[{ id: projection.order_item_id }]];
      if (sql.includes("FROM order_items oi")) return [[structuredClone(projection)]];
      if (sql.includes("FROM order_profit_calc_state")) return [[state].filter(Boolean).map((row) => ({ ...row }))];
      if (sql.includes("FROM order_profit_calc_revisions")) {
        let result = revisions.filter((row) => row.tenant_key === params[0] && row.order_item_id === params[1]);
        if (sql.includes("idempotency_key = ?")) result = result.filter((row) => row.layer === params[2] && row.idempotency_key === params[3]);
        else if (sql.includes("AND id = ?")) result = result.filter((row) => row.id === params[2]);
        return [structuredClone(result)];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async execute(sql, params) {
      if (/INSERT (?:IGNORE )?INTO order_profit_calc_state/.test(sql)) {
        state ||= { tenant_key: params[0], order_item_id: params[1], order_id: params[2], formula_version: "V1", legacy_baseline: params[3],
          revision_count: 0, current_estimate_revision_id: null, current_actual_revision_id: null };
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("SET legacy_baseline = 1")) { state.legacy_baseline = 1; return [{ affectedRows: 1 }]; }
      if (sql.includes("INSERT INTO order_profit_calc_revisions")) {
        const columns = ["tenant_key", "order_item_id", "order_id", "revision_no", "layer", "formula_version", "legacy_baseline", "input_completeness",
          "input_hash", "output_hash", "idempotency_key", "rate_version_json", "cost_version_json", "inputs_json", "outputs_json", "parent_revision_id", "source", "reason", "actor_id", "command_id"];
        const row = { ...Object.fromEntries(columns.map((column, index) => [column, params[index]])), id: revisions.length + 1 };
        revisions.push(row);
        return [{ insertId: row.id }];
      }
      if (sql.includes("UPDATE order_profit_calc_state SET current_")) {
        const pointer = sql.includes("SET current_actual") ? "current_actual_revision_id" : "current_estimate_revision_id";
        state[pointer] = params[0]; state.revision_count = params[1];
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected execute: ${sql}`);
    }
  };
  return { connection, projection, revisions, queryLog };
}

test("output selection keeps estimate values and actual finance values in their own layers", () => {
  const { projection } = memoryProjection();
  const estimate = profitCalculationOutputForLayer("estimate", projection);
  const actual = profitCalculationOutputForLayer("actual", projection);
  assert.equal(estimate.estimated_profit, "54.5000");
  assert.equal(estimate.frozen_logistics_rule_id, 70);
  for (const key of ["actual_profit", "net_profit_cny", "sale_amount_cny", "is_locked", "locked_at", "profit_status", "platform_fee_actual"]) assert.equal(Object.hasOwn(estimate, key), false);
  assert.equal(actual.actual_profit, "50.0000");
  assert.equal(actual.locked_at, projection.locked_at);
  for (const key of ["estimated_profit", "frozen_logistics_rule_id", "frozen_purchase_cost", "estimated_commission", "quantity", "sale_price"]) assert.equal(Object.hasOwn(actual, key), false);
  assert.deepEqual(profitCalculationOutputForLayer("actual", { actual_profit: 0, net_profit_cny: "0.0000", is_locked: 0 }), { actual_profit: 0, net_profit_cny: "0.0000", is_locked: 0 });
  assert.throws(() => profitCalculationOutputForLayer("unknown", projection), /layer/);
});

test("finance changes do not add a revision when the same estimate is synchronized again", async () => {
  const db = memoryProjection();
  const estimate = () => withVersionedOrderProfitWrite(101, {
    connection: db.connection, legacy: false, layer: "estimate", inputs: { quantity: 1, sale_price: 100 }
  }, async () => {});
  await estimate();
  await withVersionedOrderProfitWrite(101, { connection: db.connection, legacy: false, layer: "actual", source: "ozon_finance", inputs: { finance_rows: [{ amount_cny: -15 }] } }, async () => {
    db.projection.actual_profit = "48.0000";
    db.projection.net_profit_cny = "48.0000";
    db.projection.international_shipping_cny = "13.0000";
    db.projection.lock_reason = "finance_accrued_updated";
  });
  await estimate();
  assert.equal(db.revisions.filter((row) => row.layer === "estimate").length, 1);
  assert.equal(db.revisions.filter((row) => row.layer === "actual").length, 1);
});

test("estimate and frozen tariff changes do not create a repeated actual finance revision", async () => {
  const db = memoryProjection();
  const finance = () => withVersionedOrderProfitWrite(101, {
    connection: db.connection, legacy: false, layer: "actual", source: "ozon_finance", inputs: { finance_rows: [{ id: 1, amount_cny: -15 }] }
  }, async () => {});
  await finance();
  await withVersionedOrderProfitWrite(101, { connection: db.connection, legacy: false, layer: "estimate", inputs: { quantity: 2 } }, async () => {
    Object.assign(db.projection, { estimated_profit: "56.0000", frozen_logistics_rule_id: 80, frozen_purchase_cost: "18.0000", quantity: 2, sale_price: "101.0000" });
  });
  await finance();
  assert.equal(db.revisions.filter((row) => row.layer === "actual").length, 1);
  assert.deepEqual(JSON.parse(db.revisions.find((row) => row.layer === "actual").rate_version_json), { source: "ozon_finance" });
});

test("legacy baselines retain the full before projection and its exact lock timestamp", async () => {
  const db = memoryProjection();
  const before = structuredClone(db.projection);
  await withVersionedOrderProfitWrite(101, { connection: db.connection, layer: "estimate", inputs: {} }, async () => {
    db.projection.estimated_profit = "55.0000";
  });
  const baselines = db.revisions.filter((row) => row.legacy_baseline);
  assert.equal(baselines.length, 2);
  for (const row of baselines) {
    assert.equal(row.input_completeness, "legacy_unknown");
    assert.deepEqual(JSON.parse(row.outputs_json), before);
  }
  assert.ok(db.queryLog.some((sql) => sql.includes("opi.locked_at")));
  assert.equal(Object.hasOwn(JSON.parse(db.revisions.at(-1).outputs_json), "actual_profit"), false);
});

test("batch repair records layer-specific outputs and retains the actual repair source", async () => {
  const db = memoryProjection();
  await withVersionedOrderProfitBatchWrite([101], { connection: db.connection, source: "manual_historical_review", inputs: { action: "clear" } }, async () => {
    db.projection.actual_profit = "51.0000";
    db.projection.net_profit_cny = "51.0000";
    db.projection.estimated_profit = "54.0000";
  });
  const revisions = db.revisions.filter((row) => !row.legacy_baseline);
  assert.equal(revisions.length, 2);
  const actual = revisions.find((row) => row.layer === "actual");
  const estimate = revisions.find((row) => row.layer === "estimate");
  assert.deepEqual(JSON.parse(actual.rate_version_json), { source: "manual_historical_review" });
  assert.equal(JSON.parse(estimate.rate_version_json), 70);
  assert.equal(Object.hasOwn(JSON.parse(actual.outputs_json), "estimated_profit"), false);
  assert.equal(Object.hasOwn(JSON.parse(estimate.outputs_json), "net_profit_cny"), false);
});

test("deadlocks restart the whole transaction with bounded backoff", async () => {
  const connections = [];
  const sleeps = [];
  let attempts = 0;
  const result = await retryProfitCalculationTransaction(async (callback) => callback({ id: ++attempts }), async (connection) => {
    connections.push(connection.id);
    if (connection.id < 3) throw Object.assign(new Error("deadlock"), { code: "ER_LOCK_DEADLOCK" });
    return "committed";
  }, { maxAttempts: 3, sleepImpl: async (ms) => sleeps.push(ms) });
  assert.equal(result, "committed");
  assert.deepEqual(connections, [1, 2, 3]);
  assert.deepEqual(sleeps, [25, 50]);
});

test("ordinary projection failures are never retried and persistent deadlocks stop after three transactions", async () => {
  let attempts = 0;
  const transaction = async (callback) => { attempts += 1; return callback({}); };
  await assert.rejects(retryProfitCalculationTransaction(transaction, async () => { throw new Error("projection rejected"); }, { maxAttempts: 3, sleepImpl: async () => assert.fail("must not back off") }), /projection rejected/);
  assert.equal(attempts, 1);
  attempts = 0;
  await assert.rejects(retryProfitCalculationTransaction(transaction, async () => { throw Object.assign(new Error("deadlock"), { code: "ER_LOCK_DEADLOCK" }); }, { maxAttempts: 3, sleepImpl: async () => {} }), { code: "ER_LOCK_DEADLOCK" });
  assert.equal(attempts, 3);
});

test("a caller-owned connection leaves deadlock retries to the outer transaction", async () => {
  for (const write of [withVersionedOrderProfitWrite, withVersionedOrderProfitBatchWrite]) {
    const db = memoryProjection();
    let projections = 0;
    await assert.rejects(write(write === withVersionedOrderProfitWrite ? 101 : [101], { connection: db.connection, legacy: false }, async () => {
      projections += 1;
      throw Object.assign(new Error("deadlock"), { code: "ER_LOCK_DEADLOCK" });
    }), { code: "ER_LOCK_DEADLOCK" });
    assert.equal(projections, 1);
  }
});
