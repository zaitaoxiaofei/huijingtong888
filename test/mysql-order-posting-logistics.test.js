import assert from "node:assert/strict";
import test from "node:test";
import { saveOrderPostingLogistics } from "../src/services/mysql-order-posting-logistics.js";

function memoryDatabase() {
  let table = new Map();
  let tail = Promise.resolve();
  const sqlLog = [];
  const connection = {
    async execute(sql, params) {
      sqlLog.push(sql);
      if (sql.includes("INSERT INTO ozon_orders_raw")) {
        assert.match(sql, /ON DUPLICATE KEY UPDATE store_id = VALUES\(store_id\)/);
        const [store, number, order, status, substatus, raw] = params;
        if (!table.has(`${store}:${number}`)) table.set(`${store}:${number}`, { order_id: order, status, substatus, raw_json: raw });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("UPDATE ozon_orders_raw")) {
        const [order, status, substatus, raw, store, number] = params;
        table.set(`${store}:${number}`, { order_id: order, status, substatus, raw_json: raw });
        return [{ affectedRows: 1 }];
      }
      throw new Error(sql);
    },
    async query(sql, params) {
      sqlLog.push(sql);
      assert.match(sql, /store_id = \? AND posting_number = \? FOR UPDATE/);
      return [[table.get(`${params[0]}:${params[1]}`)].filter(Boolean)];
    }
  };
  return { sqlLog, table: () => table,
    transaction(callback) {
      const run = tail.then(async () => {
        const previous = structuredClone(table);
        try { return await callback(connection); }
        catch (error) { table = previous; throw error; }
      });
      tail = run.catch(() => {});
      return run;
    }
  };
}

const rich = { posting_number: "P1", order_number: "O1", fulfillment_schema: "FBP", stock_type: "fbp_real", status: "delivering", tracking_number: "TRACK1",
  external_tracking_url: "https://tracking.example/P1", raw: { fulfillment_schema: "FBP", delivery_method: { name: "CEL FBP Hunchun 2", tpl_provider: "CEL", warehouse: "Hunchun 2" }, tracking_number: "TRACK1" } };
const sparse = { posting_number: "P1", order_number: "O1", fulfillment_schema: "FBP", stock_type: "fbp_real", status: "delivered", tracking_number: "", raw: { fulfillment_schema: "FBP" } };
const save = (db, posting, shopId = 7, serialize = JSON.stringify, supplement = null) => saveOrderPostingLogistics({ transaction: db.transaction.bind(db), shopId, posting, serialize, supplement });

test("atomic raw merge retains rich FBP logistics but accepts the incoming business status", async () => {
  const db = memoryDatabase();
  await save(db, rich);
  const result = await save(db, sparse);
  assert.equal(result.status, "delivered");
  assert.equal(result.tracking_number, "TRACK1");
  const stored = db.table().get("7:P1");
  assert.equal(stored.status, "delivered");
  assert.equal(JSON.parse(stored.raw_json).raw.delivery_method.tpl_provider, "CEL");
  assert.ok(db.sqlLog.every((sql) => !/order_items|order_profit|inventory|history/.test(sql)));
});

test("same posting number in another shop never inherits logistics", async () => {
  const db = memoryDatabase();
  await save(db, rich, 7);
  const result = await save(db, sparse, 8);
  assert.equal(result.tracking_number || "", "");
  assert.equal(result.raw.delivery_method?.tpl_provider || "", "");
  assert.equal(db.table().size, 2);
});

test("same-key concurrent rich and sparse updates preserve logistics and serialize status writes", async () => {
  const db = memoryDatabase();
  await Promise.all([save(db, rich), ...Array.from({ length: 20 }, () => save(db, sparse))]);
  const stored = JSON.parse(db.table().get("7:P1").raw_json);
  assert.equal(stored.status, "delivered");
  assert.equal(stored.tracking_number, "TRACK1");
  assert.equal(stored.raw.delivery_method.tpl_provider, "CEL");
  assert.equal(db.table().size, 1);
});

test("a failed merged serialization rolls back the whole raw write", async () => {
  const db = memoryDatabase();
  await save(db, rich);
  const before = structuredClone(db.table().get("7:P1"));
  let calls = 0;
  await assert.rejects(save(db, sparse, 7, (value) => ++calls > 1 ? "" : JSON.stringify(value)), /serializer returned no JSON/);
  assert.deepEqual(db.table().get("7:P1"), before);
});

test("invalid ownership and incoming JSON fail before opening a transaction", async () => {
  const transaction = () => assert.fail("invalid input must not start SQL");
  await assert.rejects(saveOrderPostingLogistics({ transaction, shopId: 0, posting: sparse, serialize: JSON.stringify }), /shop ID/);
  await assert.rejects(saveOrderPostingLogistics({ transaction, shopId: 7, posting: sparse, serialize: () => "not JSON" }), SyntaxError);
  await assert.rejects(saveOrderPostingLogistics({ transaction, shopId: 7, posting: sparse, supplement: { ...rich, posting_number: "OTHER" }, serialize: JSON.stringify }), /different posting/);
});

test("a late detail supplement cannot undo a new provider, status or tracking saved during get", async () => {
  const db = memoryDatabase();
  const beforeGet = { ...sparse, status: "delivering" };
  await save(db, beforeGet);
  const detail = { ...rich, status: "delivering" };
  const latest = { ...rich, status: "delivered", tracking_number: "TRACK-NEW", raw: { fulfillment_schema: "FBP",
    delivery_method: { name: "GUOO FBP", tpl_provider: "GUOO", provider_id: 22 }, tracking_number: "TRACK-NEW" } };
  await save(db, latest);
  const result = await save(db, beforeGet, 7, JSON.stringify, detail);
  assert.equal(result.status, "delivered");
  assert.equal(result.tracking_number, "TRACK-NEW");
  assert.equal(result.raw.delivery_method.tpl_provider, "GUOO");
  assert.equal(result.raw.delivery_method.provider_id, 22);
  assert.equal(JSON.parse(db.table().get("7:P1").raw_json).tracking_number, "TRACK-NEW");
});

test("a supplement fills missing logistics while current status, item facts and explicit tracking clear remain authoritative", async () => {
  const db = memoryDatabase();
  await save(db, { ...sparse, status: "cancelled", items: [{ ozon_sku: "new", quantity: 2 }],
    raw: { fulfillment_schema: "FBP", tracking_number: "", external_tracking_url: null } });
  const result = await save(db, { ...sparse, status: "delivering" }, 7, JSON.stringify, rich);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.items, [{ ozon_sku: "new", quantity: 2 }]);
  assert.equal(result.raw.delivery_method.tpl_provider, "CEL");
  assert.equal(result.tracking_number, "");
  assert.equal(result.raw.external_tracking_url, null);
});
