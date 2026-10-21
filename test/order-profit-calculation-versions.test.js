import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ensureOrderProfitCalculationState, getPinnedProfitFormulaVersion, normalizeProfitCalculationSnapshot,
  profitCalculationFingerprint, profitCalculationTenantKey, readOrderProfitCalculationVersions, recordOrderProfitCalculation,
  retryProfitCalculationTransaction
} from "../src/services/order-profit-calculation-versions.js";
import { assertProfitFormulaSupported, getProfitFormula } from "../src/services/profit-formulas/registry.js";
import { ORDER_PROFIT_CALCULATION_SCHEMA } from "../src/services/order-profit-calculation-schema.js";
import { baselineProfitCalculationBatch } from "../src/services/order-profit-calculation-baseline.js";
import { migrateProfitCalculationVersions } from "../scripts/migrate-order-profit-calculation-versions.mjs";

function memoryDatabase() {
  let states = new Map();
  let revisions = [];
  let nextId = 1;
  let tail = Promise.resolve();
  const sqlLog = [];
  const key = (tenant, item) => `${tenant}:${item}`;
  const connection = {
    async query(sql, params = []) {
      sqlLog.push(sql);
      if (sql.includes("SELECT * FROM order_profit_calc_state") && sql.includes("order_item_id = ?")) return [[states.get(key(...params))].filter(Boolean)];
      if (sql.includes("SELECT formula_version FROM")) return [[states.get(key(...params))].filter(Boolean)];
      if (sql.includes("SELECT * FROM order_profit_calc_state")) return [[...states.values()].filter((s) => s.tenant_key === params[0] && s.order_id === params[1])];
      if (sql.includes("SELECT * FROM order_profit_calc_revisions")) {
        let result = revisions.filter((r) => r.tenant_key === params[0] && r.order_item_id === params[1]);
        if (sql.includes("idempotency_key = ?")) result = result.filter((r) => r.layer === params[2] && r.idempotency_key === params[3]);
        else if (sql.includes("AND id = ?")) result = result.filter((r) => r.id === params[2]);
        else result = result.sort((a, b) => b.revision_no - a.revision_no).slice(0, params[2]);
        return [structuredClone(result)];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async execute(sql, params) {
      sqlLog.push(sql);
      if (sql.includes("INSERT INTO order_profit_calc_state")) {
        assert.match(sql, /ON DUPLICATE KEY UPDATE order_item_id = VALUES\(order_item_id\)/);
        const [tenant, item, order, legacy] = params;
        if (!states.has(key(tenant, item))) states.set(key(tenant, item), {
          tenant_key: tenant, order_item_id: item, order_id: order, formula_version: "V1", legacy_baseline: legacy,
          revision_count: 0, current_estimate_revision_id: null, current_actual_revision_id: null
        });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("SET legacy_baseline = 1")) {
        states.get(key(...params)).legacy_baseline = 1;
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("INSERT INTO order_profit_calc_revisions")) {
        const columns = ["tenant_key", "order_item_id", "order_id", "revision_no", "layer", "formula_version", "legacy_baseline", "input_completeness",
          "input_hash", "output_hash", "idempotency_key", "rate_version_json", "cost_version_json", "inputs_json", "outputs_json", "parent_revision_id", "source", "reason", "actor_id", "command_id"];
        const revision = Object.fromEntries(columns.map((column, i) => [column, params[i]]));
        assert.ok(!revisions.some((r) => r.tenant_key === revision.tenant_key && r.order_item_id === revision.order_item_id && r.layer === revision.layer && r.idempotency_key === revision.idempotency_key), "duplicate idempotency key");
        revision.id = nextId++;
        revisions.push(revision);
        return [{ insertId: revision.id }];
      }
      if (sql.includes("UPDATE order_profit_calc_state SET current_")) {
        const pointer = sql.includes("SET current_actual") ? "current_actual_revision_id" : "current_estimate_revision_id";
        const state = states.get(key(params[2], params[3]));
        state[pointer] = params[0];
        state.revision_count = params[1];
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected execute: ${sql}`);
    }
  };
  return {
    connection, sqlLog,
    states: () => states, revisions: () => revisions,
    transaction(callback) {
      const pending = tail.then(async () => {
        const oldStates = structuredClone(states), oldRevisions = structuredClone(revisions), oldId = nextId;
        try { return await callback(connection); }
        catch (error) { states = oldStates; revisions = oldRevisions; nextId = oldId; throw error; }
      });
      tail = pending.catch(() => {});
      return pending;
    }
  };
}

const identity = { tenantId: 7, orderId: 11, orderItemId: 101 };
const calculation = { ...identity, layer: "estimate", formulaVersion: "V1", inputs: { quantity: 1, sale_price: 100 }, outputs: { net_profit_cny: 30 } };

test("only the defined V1 formula is dispatchable, including finance and aftersale guards", () => {
  assert.equal(getProfitFormula("V1").version, "V1");
  assert.equal(assertProfitFormulaSupported("V1", { operation: "finance" }), "V1");
  for (const version of ["V2", "V3", "latest", "", null]) {
    assert.throws(() => getProfitFormula(version), { code: "UNSUPPORTED_PROFIT_FORMULA_VERSION" });
    assert.throws(() => assertProfitFormulaSupported(version, { operation: "aftersale" }));
  }
});

test("V1 dependency closure does not import the live formula modules", () => {
  const expectedHashes = {
    "profit.js": "a5a38ec654a69df4810f9bfb6177b0511b050f619156d4f781fe4e86f189666b",
    "pricingFormula.js": "5fae2f222c11bb9da68a11a54fff9059a3b045ae9c69cfff9bb7d899113e1f95",
    "celRates.js": "af4c95209def232e78f238cbb6d5bd4500d4e29256c970e4f3fb31d3e636f9ac",
    "ogl-rates.js": "d4e64517537890a85dae23872a82fa3e804f06faeed12526d64b0dfa1f91b3c2",
    "order-outcome.js": "51e001624e5735c5fcdbaa805b17b19d543ee8bf2c8570aad22ffe05af9dc226",
    "aggregation.js": "e34f9cf54459e42e6d1cfbed46ddd75af5c6889cd1dffedd99f72f8dffc557dd"
  };
  for (const [filename, expected] of Object.entries(expectedHashes)) {
    const source = readFileSync(new URL(`../src/services/profit-formulas/v1/${filename}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*\.\.\//);
    assert.equal(createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex"), expected, `${filename} must remain frozen; introduce a new version instead`);
  }
  assert.equal(getProfitFormula("V1").actualItemProfit({ sale_price: 100, quantity: 2, frozen_purchase_cost: 10, frozen_international_shipping: 5, platform_fee_actual: 20 }), 150);
});

test("fingerprint ignores sync times and finance ordering without dropping financial dates or item order", () => {
  const a = { updated_at: "yesterday", quantity: 2, finance_rows: [{ id: 2, amount_cny: -4 }, { id: 1, amount_cny: -2, operation_date: "2026-01-02" }] };
  const b = { quantity: 2, updated_at: "today", finance_rows: [...a.finance_rows].reverse() };
  assert.equal(profitCalculationFingerprint(a), profitCalculationFingerprint(b));
  assert.notEqual(profitCalculationFingerprint(a), profitCalculationFingerprint({ ...b, quantity: 3 }));
  assert.notEqual(profitCalculationFingerprint({ items: [1, 2] }), profitCalculationFingerprint({ items: [2, 1] }));
  assert.notEqual(profitCalculationFingerprint(a), profitCalculationFingerprint({ ...a, finance_rows: [{ id: 1, operation_date: "2026-01-03" }] }));
  assert.deepEqual(normalizeProfitCalculationSnapshot({ access_token: "never store", cookie: "private", price: 3 }), { price: 3 });
});

test("repeated and concurrent automatic writes record one revision, retaining tenant isolation", async () => {
  const db = memoryDatabase();
  await Promise.all(Array.from({ length: 100 }, () => db.transaction((connection) => recordOrderProfitCalculation(connection, calculation))));
  assert.equal(db.revisions().length, 1);
  await db.transaction((connection) => recordOrderProfitCalculation(connection, { ...calculation, tenantId: 8 }));
  assert.equal(db.revisions().length, 2);
  assert.equal(db.states().size, 2);
  assert.ok(db.sqlLog.some((sql) => sql.includes("FOR UPDATE")));
  assert.match(ORDER_PROFIT_CALCULATION_SCHEMA.join("\n"), /PRIMARY KEY \(tenant_key, order_item_id\)/);
  assert.ok(db.sqlLog.every((sql) => !sql.includes("INSERT IGNORE")));
});

test("deadlock recovery retries the complete rolled-back transaction, not only the failed statement", async () => {
  const db = memoryDatabase();
  let invocations = 0;
  const pauses = [];
  const result = await retryProfitCalculationTransaction(db.transaction.bind(db), async (connection) => {
    const recorded = await recordOrderProfitCalculation(connection, calculation);
    if (++invocations === 1) throw Object.assign(new Error("deadlock after revision insert"), { code: "ER_LOCK_DEADLOCK", errno: 1213 });
    return recorded;
  }, { sleepImpl: async (ms) => pauses.push(ms) });
  assert.equal(invocations, 2);
  assert.deepEqual(pauses, [25]);
  assert.equal(result.changed, true);
  assert.equal(db.revisions().length, 1);
  assert.equal(db.states().get("7:101").revision_count, 1);
  let invalidWrites = 0;
  await assert.rejects(retryProfitCalculationTransaction(db.transaction.bind(db), async () => {
    invalidWrites++;
    throw new Error("ordinary validation error");
  }, { sleepImpl: () => assert.fail("must not retry validation failures") }), /ordinary validation error/);
  assert.equal(invalidWrites, 1);
  await assert.rejects(retryProfitCalculationTransaction(db.transaction.bind(db), async () => {
    throw Object.assign(new Error("persistent deadlock"), { code: "ER_LOCK_DEADLOCK" });
  }, { maxAttempts: 2, sleepImpl: async () => {} }), /persistent deadlock/);
});

test("a changed input creates one new revision and reverting business inputs creates a new revision", async () => {
  const db = memoryDatabase();
  const run = (input) => db.transaction((connection) => recordOrderProfitCalculation(connection, input));
  await run(calculation);
  await run({ ...calculation, inputs: { quantity: 2, sale_price: 100 } });
  await run(calculation);
  await run(calculation);
  assert.equal(db.revisions().length, 3);
  assert.equal(db.revisions()[2].parent_revision_id, 2);
});

test("command retries are idempotent even after another command becomes current", async () => {
  const db = memoryDatabase();
  const run = (commandId) => db.transaction((connection) => recordOrderProfitCalculation(connection, { ...calculation, commandId }));
  await run("one"); await run("two");
  const duplicate = await run("one");
  assert.equal(duplicate.changed, false);
  assert.equal(db.revisions().length, 2);
  assert.equal(db.states().get("7:101").current_estimate_revision_id, 2);
  await assert.rejects(db.transaction((connection) => recordOrderProfitCalculation(connection, { ...calculation, commandId: "one", outputs: { net_profit_cny: 999 } })), { code: "PROFIT_CALCULATION_IDEMPOTENCY_CONFLICT" });
  assert.equal(db.revisions().length, 2);
});

test("baseline saves exact existing monetary and lock values without inventing historical inputs", async () => {
  const db = memoryDatabase();
  const baseline = { actual_profit: "0.0000", net_profit_cny: "-13.5700", is_locked: 1, lock_reason: "finance_accrued", locked_at: "2026-01-01" };
  const ensure = () => db.transaction((connection) => ensureOrderProfitCalculationState(connection, { ...identity, legacy: true, baselineEstimate: baseline, baselineActual: baseline }));
  await ensure(); await ensure();
  assert.equal(db.revisions().length, 2);
  assert.equal(db.states().get("7:101").legacy_baseline, 1);
  for (const revision of db.revisions()) {
    assert.deepEqual(JSON.parse(revision.outputs_json), baseline);
    assert.equal(revision.input_completeness, "legacy_unknown");
    assert.deepEqual(JSON.parse(revision.inputs_json), { input_completeness: "legacy_unknown" });
  }
  const preserved = await db.transaction((connection) => recordOrderProfitCalculation(connection, { ...calculation, preserveBaseline: true }));
  assert.equal(preserved.reason, "legacy_baseline_preserved");
  // Real later finance data is allowed, with its original formula pinned.
  await db.transaction((connection) => recordOrderProfitCalculation(connection, { ...calculation, layer: "actual", preserveBaseline: false }));
  assert.equal(db.revisions().length, 3);
});

test("unsupported pinned versions fail before projection, and a projection failure rolls back revision and pointer", async () => {
  const db = memoryDatabase();
  await assert.rejects(db.transaction((connection) => recordOrderProfitCalculation(connection, { ...calculation, formulaVersion: "V2", project: () => assert.fail("must not project") })), /Unsupported profit formula/);
  assert.equal(db.revisions().length, 0);
  await assert.rejects(db.transaction((connection) => recordOrderProfitCalculation(connection, { ...calculation, project: async ({ connection }) => {
    assert.equal(connection, db.connection); throw new Error("projection rejected");
  } })), /projection rejected/);
  assert.equal(db.revisions().length, 0);
  assert.equal(db.states().size, 0);
});

test("lookup requires ownership and never falls back from a corrupt existing pinned version", async () => {
  const db = memoryDatabase();
  const query = db.connection.query.bind(db.connection);
  await assert.rejects(getPinnedProfitFormulaVersion({ query }, 101), /ownership/);
  assert.equal(await getPinnedProfitFormulaVersion({ query, tenantId: 7 }, 101), "V1");
  await db.transaction((connection) => recordOrderProfitCalculation(connection, calculation));
  db.states().get("7:101").formula_version = "V2";
  await assert.rejects(getPinnedProfitFormulaVersion({ query, tenantId: 7 }, 101), /Unsupported profit formula/);
  assert.equal(await getPinnedProfitFormulaVersion({ query, tenantId: 8 }, 101), "V1");
  assert.equal(profitCalculationTenantKey(null), "admin");
  assert.equal(profitCalculationTenantKey("9"), "9");
});

test("history is scoped and bounded, leaving the current business projection outside history joins", async () => {
  const db = memoryDatabase();
  await db.transaction((connection) => recordOrderProfitCalculation(connection, calculation));
  await db.transaction((connection) => recordOrderProfitCalculation(connection, { ...calculation, commandId: "manual", rateVersion: { id: 5 }, costVersion: 9 }));
  const detail = await readOrderProfitCalculationVersions({ query: db.connection.query.bind(db.connection) }, { tenantId: 7, orderId: 11, limitPerItem: 1 });
  assert.equal(detail.items[0].truncated, true);
  assert.equal(detail.items[0].history_count, 2);
  assert.deepEqual(detail.items[0].revisions[0].rate_version, { id: 5 });
  assert.equal((await readOrderProfitCalculationVersions({ query: db.connection.query.bind(db.connection) }, { tenantId: 8, orderId: 11 })).available, false);
});

test("dry-run migration only scans the requested cursor batch and never invokes a transaction", async () => {
  let parameters;
  const result = await baselineProfitCalculationBatch({ query: async (_sql, params) => { parameters = params; return [[{ order_item_id: 20, order_id: 2, tenant_id: 7 }]]; },
    transaction: () => assert.fail("dry-run must not write") }, { afterId: 10, limit: 2 });
  assert.deepEqual(parameters, [10, 2]);
  assert.equal(result.mode, "dry_run");
  assert.equal(result.next_after_id, 20);
  assert.equal(result.initialized, 0);
});

test("baseline batch locks item before state, labels an empty state legacy, and leaves computed states alone", async () => {
  const db = memoryDatabase();
  const originalQuery = db.connection.query;
  db.connection.query = async (sql, params) => {
    if (sql === "SELECT id FROM order_items WHERE id = ? FOR UPDATE") {
      db.sqlLog.push(sql);
      assert.deepEqual(params, [101]);
      return [[{ id: 101 }]];
    }
    if (sql.includes("SELECT oi.*")) {
      db.sqlLog.push(sql);
      assert.doesNotMatch(sql, /FOR UPDATE/);
      return [[{ id: 101, order_id: 11, profit_item_id: 3, estimated_profit: "12.00", actual_profit: "9.00", is_locked: 1, profit_status: "accrued" }]];
    }
    return originalQuery(sql, params);
  };
  const deps = { query: async () => [[{ order_item_id: 101, order_id: 11, tenant_id: 7 }]], transaction: db.transaction.bind(db) };
  await baselineProfitCalculationBatch(deps, { write: true });
  assert.equal(db.states().get("7:101").legacy_baseline, 1);
  assert.equal(db.revisions().length, 2);
  assert.equal(db.sqlLog[0], "SELECT id FROM order_items WHERE id = ? FOR UPDATE");
  assert.ok(db.sqlLog[1].includes("SELECT oi.*"));
  await baselineProfitCalculationBatch(deps, { write: true });
  assert.equal(db.revisions().length, 2);
  const live = memoryDatabase();
  await live.transaction((tx) => recordOrderProfitCalculation(tx, calculation));
  await live.transaction((tx) => ensureOrderProfitCalculationState(tx, { ...identity, legacy: true, baselineEstimate: { net_profit_cny: -999 } }));
  assert.equal(live.states().get("7:101").legacy_baseline, 0);
  assert.equal(live.revisions().length, 1);
});

test("schema-only dry-run does not issue DDL or rewrite a legacy profit table", async () => {
  const sqlLog = [];
  const connection = { async query(sql) {
    sqlLog.push(sql);
    if (sql.includes("SELECT 1 FROM")) throw Object.assign(new Error("missing"), { code: "ER_NO_SUCH_TABLE" });
    return [[{ item_count: 2, estimated_profit: "10.00", actual_profit: "0.00", locked_count: 0 }]];
  } };
  const result = await migrateProfitCalculationVersions(connection, { createSchema: true, schemaOnly: true });
  assert.equal(result.mode, "dry_run");
  assert.equal(result.projection_unchanged, true);
  assert.ok(sqlLog.every((sql) => !/CREATE|UPDATE|INSERT|DELETE/.test(sql)));
});

test("explicit concurrent-writer audit reports changed totals accurately without asserting unchanged", async () => {
  let projectionRead = 0;
  const connection = { async query(sql) {
    if (sql.includes("SELECT 1 FROM")) return [[]];
    if (sql.includes("SUM(oi.estimated_profit)")) return [[{ item_count: 2, estimated_profit: ++projectionRead, actual_profit: 0, locked_count: 0 }]];
    if (sql.includes("COUNT(state.order_item_id)")) return [[{ state_count: 2, missing_count: 0, unsupported_count: 0 }]];
    if (sql.includes("COUNT(*) AS revision_count")) return [[{ revision_count: 2 }]];
    throw new Error(sql);
  } };
  await assert.rejects(migrateProfitCalculationVersions(connection, { auditOnly: true }), /changed business totals/);
  const result = await migrateProfitCalculationVersions(connection, { auditOnly: true, allowConcurrentWriters: true });
  assert.equal(result.projection_unchanged, false);
  assert.equal(result.concurrent_business_totals_changed, true);
});

test("V1 accounting aggregates preserve normal and terminal amount semantics", () => {
  const formula = getProfitFormula("V1");
  const estimated = { terminalNoRevenue: false, saleAmount: 100, purchaseCost: 10, domesticShipping: 2, internationalShipping: 8,
    packagingCost: 1, commission: 15, ozonServiceFee: 3, otherFee: 2, returnLoss: 4, advertisingCost: 5 };
  assert.deepEqual(formula.aggregateEstimatedProfit(estimated), { costTotal: 50, netProfit: 50, grossProfit: 62 });
  assert.equal(formula.aggregateEstimatedProfit({ ...estimated, terminalNoRevenue: true }).netProfit, -50);
  assert.deepEqual(formula.aggregateActualProfit({ terminalNoRevenue: false, itemSale: 100, purchaseCost: 10, domesticShipping: 2,
    actualInternationalShipping: 8, packagingCost: 1, commissionFeeCny: 15, actualServiceFeeCny: 3, returnLoss: 4, advertisingCost: 5, otherFee: 2 }),
  { terminalLoss: 50, actualProfit: 50, grossProfit: 55 });
  assert.equal(formula.estimatedProfitValue({ order: { status: "cancelled" }, item: { sale_price: 100, quantity: 1 }, product: {}, estimated: {}, returnLossEstimate: 3 }), -3);
});
