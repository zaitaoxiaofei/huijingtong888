import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseFbpLogisticsRepairOptions, repairFbpOrderLogistics } from "../scripts/repair-fbp-order-logistics.mjs";

const sparse = () => ({ posting_number: "P1", order_id: "O1", fulfillment_schema: "FBP", status: "cancelled", tracking_number: "",
  items: [{ sku: "current", quantity: 2 }], raw: { posting_number: "P1", fulfillment_schema: "FBP", status: "cancelled",
    delivery_method: { name: "FBP", tpl_provider_id: 1108 }, products: [{ sku: "current", quantity: 2 }], financial_data: { amount: 25 } } });
const detail = () => ({ posting_number: "P1", order_id: "O1", status: "delivering", tracking_number: "TRACK1", external_tracking_url: "https://tracking.example.test/P1",
  raw: { posting_number: "P1", delivery_method: { name: "CEL FBP Standard Extra Small", warehouse: "CEL Hunchun 2", tpl_provider: "CEL", tpl_provider_id: 1108 },
    products: [{ sku: "outdated", quantity: 1 }], financial_data: { amount: 99 } } });

function database() {
  let state = {
    raw: { store_id: 7, posting_number: "P1", order_id: "O1", status: "cancelled", substatus: "", query_stock_location: "FBP", raw_json: JSON.stringify(sparse()) },
    order: { id: 101, tracking_number: "", external_tracking_url: "" },
    items: [{ id: 201, order_id: 101, estimated_profit: "18.0000", actual_profit: "6.0000" }],
    profits: [{ order_item_id: 201, net_profit_cny: "6.0000", is_locked: 1, locked_at: "2026-10-20 01:00:00" }],
    states: [{ tenant_key: "9", order_item_id: 201, order_id: 101, formula_version: "V1", revision_count: 3 }],
    revisions: [{ id: 301, tenant_key: "9", order_item_id: 201, order_id: 101, revision_no: 3 }]
  };
  const logs = [];
  let inTransaction = false;
  let changeProfit = false;
  let deadlocks = 0;
  let transactionAttempts = 0;
  const connection = {
    async query(sql, params) {
      logs.push({ sql, params, inTransaction });
      if (sql.includes("FROM ozon_orders_raw")) return [[structuredClone(state.raw)]];
      if (sql.includes("FROM orders")) return [[structuredClone(state.order)]];
      if (sql.includes("FROM order_items")) return [structuredClone(state.items)];
      if (sql.includes("FROM order_profit_items")) return [structuredClone(state.profits)];
      if (sql.includes("FROM order_profit_calc_state")) return [structuredClone(state.states)];
      if (sql.includes("FROM order_profit_calc_revisions")) return [structuredClone(state.revisions)];
      throw new Error(`Unexpected query ${sql}`);
    },
    async execute(sql, params) {
      logs.push({ sql, params, inTransaction });
      if (sql.includes("INSERT INTO ozon_orders_raw")) return [{ affectedRows: 0 }];
      if (sql.includes("UPDATE ozon_orders_raw")) {
        if (deadlocks-- > 0) throw Object.assign(new Error("deadlock fixture"), { code: "ER_LOCK_DEADLOCK", errno: 1213 });
        [state.raw.order_id, state.raw.status, state.raw.substatus, state.raw.raw_json] = params;
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("UPDATE orders SET")) {
        let index = 0;
        for (const field of ["tracking_number", "external_tracking_url"]) if (sql.includes(`${field} = ?`)) state.order[field] = params[index++];
        if (changeProfit) state.items[0].estimated_profit = "999.0000";
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected write ${sql}`);
    }
  };
  return {
    logs, current: () => state, inTransaction: () => inTransaction, changeProfit: () => { changeProfit = true; },
    deadlocks: (count) => { deadlocks = count; }, transactionAttempts: () => transactionAttempts,
    pool: { async query(sql, params) {
      logs.push({ sql, params, inTransaction });
      assert.equal(inTransaction, false);
      if (sql.includes("FROM shops")) return [[{ id: 7, tenant_id: 9, api_key_hint: "never-log-api-key", ozon_client_id: "private-client" }]];
      assert.match(sql, /o\.shop_id = \? AND o\.ordered_at >= \?/);
      assert.match(sql, /raw\.query_stock_location = 'FBP'/);
      assert.ok(sql.includes("REGEXP '^(FBP[[:space:]]*)*$'"));
      assert.deepEqual(params, [7, "2026-10-19 16:00:00", 200]);
      return [[{ id: 101, posting_number: "P1", raw_json: state.raw.raw_json }]];
    } },
    async transaction(callback) {
      transactionAttempts++;
      const before = structuredClone(state);
      inTransaction = true;
      try { return await callback(connection); }
      catch (error) { state = before; throw error; }
      finally { inTransaction = false; }
    }
  };
}

async function backupPath(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "fbp-logistics-repair-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "backup.jsonl");
}

const options = (extra = []) => parseFbpLogisticsRepairOptions(["--shop-id=7", "--from=2026-10-20", ...extra]);
const deps = (db, fetchPosting = async () => detail()) => ({ pool: db.pool, transaction: db.transaction,
  fetchPosting: async (...args) => { assert.equal(db.inTransaction(), false, "API requests cannot hold SQL locks"); return fetchPosting(...args); }, serialize: JSON.stringify });

test("repair requires an explicit shop/date and write backup, with Beijing day boundaries", () => {
  assert.throws(() => parseFbpLogisticsRepairOptions([]), /shop-id/);
  assert.throws(() => parseFbpLogisticsRepairOptions(["--shop-id=7"]), /from/);
  assert.throws(() => options(["--from=2026-02-30"]), /valid YYYY-MM-DD/);
  assert.throws(() => options(["--write"]), /backup/);
  assert.throws(() => options(["--limit=0"]), /limit/);
  assert.throws(() => options(["--write=false"]), /Use/);
  assert.equal(options().write, false);
  assert.equal(options().fromUtc, "2026-10-19 16:00:00");
  assert.equal(options().limit, 200);
});

test("dry run only selects scoped FBP candidates, performs no SQL writes and emits safe logistics fields", async () => {
  const db = database();
  const before = structuredClone(db.current());
  const result = await repairFbpOrderLogistics(options(), deps(db));
  assert.equal(result.repairable_orders, 1);
  assert.deepEqual(result.orders, [{ id: 101, posting_number: "P1", method: "CEL FBP Standard Extra Small", warehouse: "CEL Hunchun 2", provider: "CEL" }]);
  assert.deepEqual(db.current(), before);
  assert.equal(db.logs.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /never-log|private-client|raw_json|financial|tracking|products/);
});

test("write locks fresh rows, persists backup before mutation and leaves all profit evidence unchanged", async (t) => {
  const backup = await backupPath(t);
  const db = database();
  const before = structuredClone(db.current());
  const result = await repairFbpOrderLogistics(options(["--write", `--backup=${backup}`]), deps(db));
  assert.equal(result.repaired_orders, 1);
  const current = JSON.parse(db.current().raw.raw_json);
  assert.equal(current.status, "cancelled");
  assert.deepEqual(current.items, sparse().items);
  assert.deepEqual(current.raw.products, sparse().raw.products);
  assert.deepEqual(current.raw.financial_data, { amount: 25 });
  assert.equal(current.raw.delivery_method.name, "CEL FBP Standard Extra Small");
  assert.equal(db.current().order.tracking_number, "TRACK1");
  for (const key of ["items", "profits", "states", "revisions"]) assert.deepEqual(db.current()[key], before[key]);
  const entries = (await readFile(backup, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].raw.raw_json, before.raw.raw_json);
  assert.equal(entries[1].order_tracking.tracking_number, "");
  assert.doesNotMatch(JSON.stringify(entries), /never-log|private-client/);
  if (process.platform !== "win32") assert.equal((await stat(backup)).mode & 0o777, 0o600);
  assert.ok(db.logs.filter((entry) => /FOR UPDATE|UPDATE|INSERT/.test(entry.sql)).every((entry) => entry.inTransaction));
  const guards = db.logs.filter((entry) => /order_profit_calc_/.test(entry.sql));
  assert.equal(guards.length, 4);
  assert.ok(guards.every((entry) => entry.params[0] === "9" && entry.params.includes(201) && entry.params.at(-1) === 101));
  assert.ok(db.logs.every((entry) => !/UPDATE order_items|UPDATE order_profit|inventory|sync_outbound|SUM\(/i.test(entry.sql)));
});

test("concurrent status and finance updates during API fetch are preserved from the locked current row", async (t) => {
  const backup = await backupPath(t);
  const db = database();
  await repairFbpOrderLogistics(options(["--write", `--backup=${backup}`]), deps(db, async () => {
    const fresh = sparse();
    fresh.status = "delivered";
    fresh.raw.status = "delivered";
    fresh.raw.financial_data = { amount: 777 };
    db.current().raw.raw_json = JSON.stringify(fresh);
    db.current().raw.status = "delivered";
    return detail();
  }));
  const current = JSON.parse(db.current().raw.raw_json);
  assert.equal(current.status, "delivered");
  assert.deepEqual(current.raw.financial_data, { amount: 777 });
});

test("provider conflicts, wrong posting numbers and API failures do not enter write transactions", async () => {
  for (const mutation of [
    (value) => { value.posting_number = "OTHER"; },
    (value) => { value.raw.posting_number = "OTHER"; },
    (value) => { value.raw.delivery_method.tpl_provider_id = 9999; },
    (value) => { delete value.raw.delivery_method.tpl_provider_id; }
  ]) {
    const db = database();
    const fetched = detail();
    mutation(fetched);
    const result = await repairFbpOrderLogistics(options(), deps(db, async () => fetched));
    assert.equal(result.repairable_orders, 0);
    assert.equal(db.logs.length, 2);
  }
  const db = database();
  const result = await repairFbpOrderLogistics(options(), deps(db, async () => { throw new Error("private API response"); }));
  assert.equal(result.failed_orders, 1);
  assert.doesNotMatch(JSON.stringify(result), /private API/);
});

test("a provider change while waiting for detail is rechecked under lock and skipped", async (t) => {
  const backup = await backupPath(t);
  const db = database();
  const result = await repairFbpOrderLogistics(options(["--write", `--backup=${backup}`]), deps(db, async () => {
    const changed = sparse();
    changed.raw.delivery_method.tpl_provider_id = 9999;
    db.current().raw.raw_json = JSON.stringify(changed);
    return detail();
  }));
  assert.equal(result.repaired_orders, 0);
  assert.equal(result.skipped_orders, 1);
  assert.ok(db.logs.every((entry) => !/INSERT|UPDATE ozon_orders_raw|UPDATE orders SET/.test(entry.sql)));
  assert.equal((await readFile(backup, "utf8")).trim().split("\n").length, 1);
});

test("changed profit projections fail the guard and roll back the logistics transaction", async (t) => {
  const backup = await backupPath(t);
  const db = database();
  db.changeProfit();
  const before = structuredClone(db.current());
  await assert.rejects(repairFbpOrderLogistics(options(["--write", `--backup=${backup}`]), deps(db)), /Protected profit/);
  assert.deepEqual(db.current(), before);
});

test("an existing backup is never overwritten and stops before reading credentials or calling APIs", async (t) => {
  const backup = await backupPath(t);
  await writeFile(backup, "keep original", { flag: "wx", mode: 0o600 });
  const db = database();
  await assert.rejects(repairFbpOrderLogistics(options(["--write", `--backup=${backup}`]), deps(db)), { code: "EEXIST" });
  assert.equal(await readFile(backup, "utf8"), "keep original");
  assert.equal(db.logs.length, 0);
});

test("deadlocks retry the complete short order transaction and retain each before-image", async (t) => {
  const backup = await backupPath(t);
  const db = database();
  db.deadlocks(2);
  const result = await repairFbpOrderLogistics(options(["--write", `--backup=${backup}`]), deps(db));
  assert.equal(result.repaired_orders, 1);
  assert.equal(db.transactionAttempts(), 3);
  const records = (await readFile(backup, "utf8")).trim().split("\n").map(JSON.parse).slice(1);
  assert.deepEqual(records.map((row) => row.attempt), [1, 2, 3]);
  assert.ok(records.every((row) => JSON.parse(row.raw.raw_json).raw.delivery_method.name === "FBP"));
});
