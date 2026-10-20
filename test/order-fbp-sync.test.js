import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";

import { fetchOzonFbpPostings, fetchOzonPostingByNumber } from "../src/ozonClient.js";
import { stockLocationSql } from "../src/services/order-query-facts.js";

const shop = { id: 4, name: "Test Shop", ozon_client_id: "123", ozon_api_key: "test-api-key" };
const serviceSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function fbpPosting(number) {
  return {
    posting_number: number,
    order_id: 123,
    order_number: `ORDER-${number}`,
    status: "delivering",
    order_date: "2026-10-20T01:00:00Z",
    in_process_at: "2026-10-20T01:02:00Z",
    products: [{ sku: 555, offer_id: "offer-555", name: "Test product", quantity: 2, price: { amount: "2500.50", currency: "RUB" } }]
  };
}

test("FBP list uses its own cursor API and persists a warehouse marker", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), body });
    return jsonResponse(calls.length === 1
      ? { postings: [fbpPosting("FBP-1")], cursor: "next" }
      : { postings: [fbpPosting("FBP-2")], cursor: "" });
  };

  const result = await fetchOzonFbpPostings(shop, {
    from: "2026-10-20T00:00:00Z", to: "2026-10-20T12:00:00Z", statuses: ["delivering"], limit: 500
  });
  assert.deepEqual(calls.map((call) => call.url.endsWith("/v1/posting/fbp/list")), [true, true]);
  assert.deepEqual(calls.map((call) => call.body.cursor), ["", "next"]);
  assert.ok(calls.every((call) => call.body.limit === 100 && !("statuses" in call.body.filter)));
  assert.deepEqual(result.postings.map((posting) => posting.posting_number), ["FBP-1", "FBP-2"]);
  assert.equal(result.requests, 2);
  assert.equal(result.postings[0].items[0].sale_price, 2500.5);
  assert.equal(result.postings[0].items[0].ozon_sku, "555");
  assert.equal(result.postings[0].raw.delivery_method.name, "FBP");
  assert.equal(result.postings[0].raw.fulfillment_schema, "FBP");

  const db = new DatabaseSync(":memory:");
  try {
    db.function("JSON_UNQUOTE", (value) => value);
    db.function("CONCAT_WS", { varargs: true }, (separator, ...values) => values.filter((value) => value != null).join(separator));
    db.function("regexp", (pattern, value) => Number(new RegExp(pattern, "i").test(value || "")));
    db.exec("CREATE TABLE raw (raw_json TEXT)");
    db.prepare("INSERT INTO raw VALUES (?)").run(JSON.stringify(result.postings[0]));
    assert.equal(db.prepare(`SELECT ${stockLocationSql("raw_json")} AS stock_location FROM raw`).get().stock_location, "FBP");
  } finally {
    db.close();
  }

  const resolverSource = serviceSource.match(/function resolveOrderStockLocationMysql\(posting = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(resolverSource);
  const resolve = vm.runInNewContext(`${resolverSource}; resolveOrderStockLocationMysql`, {
    parseOzonPostingRawMysql: (posting) => posting.raw || posting
  });
  assert.equal(resolve(result.postings[0]).stockLocation, "FBP");
});

test("posting detail lookup keeps the existing FBS get path for an FBP order", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const paths = [];
  globalThis.fetch = async (url) => {
    paths.push(new URL(url).pathname);
    return jsonResponse({ result: {
      ...fbpPosting("FBP-1"),
      delivery_method: { name: "FBP warehouse" }
    } });
  };
  const posting = await fetchOzonPostingByNumber(shop, "FBP-1");
  assert.deepEqual(paths, ["/v3/posting/fbs/get"]);
  assert.equal(posting.posting_number, "FBP-1");
  assert.equal(posting.raw.delivery_method.name, "FBP warehouse");
});

test("one failed feed cannot suppress orders from the other feed", async () => {
  const source = serviceSource.match(/export async function syncDemoOrdersMysql\(body = \{\}, options = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source);
  const written = [];
  let failFbp = true;
  const sync = vm.runInNewContext(`${source.replace("export ", "")}; syncDemoOrdersMysql`, {
    ensureMysqlCutoverEnabled() {},
    nullableInteger: (value) => Number(value || 0),
    shopsMysql: async () => [{ ...shop, status: "active" }],
    textValueMysql: (...values) => values.find(Boolean) || "",
    normalizeSyncDateMysql: () => "2026-10-20",
    normalizeSyncDateTimeMysql: () => "",
    normalizeShanghaiDateBoundaryMysql: () => "2026-10-19T16:00:00Z",
    throwIfAbortedMysql() {},
    chinaDateKeyMysql: () => "2026-10-20",
    markInventoryAlertSkuDailyDirtyMysql: async () => {},
    fetchOzonPostings: async () => failFbp ? { postings: [{ posting_number: "FBS-1", ordered_at: "2026-10-20T01:00:00Z" }], requests: 1 } : Promise.reject(new Error("FBS unavailable")),
    fetchOzonFbpPostings: async () => failFbp ? Promise.reject(new Error("FBP unavailable")) : { postings: [{ posting_number: "FBP-1", ordered_at: "2026-10-20T01:00:00Z" }], requests: 1 },
    upsertPostingMysql: async (_shop, posting) => { written.push(posting.posting_number); return { inserted: 1, updated: 0, insertedItems: 1 }; },
    mysqlExecute: async () => {},
    invalidateMasterDataCache() {}
  });

  const fbsResult = await sync({ skip_post_processing: true });
  assert.deepEqual(written, ["FBS-1"]);
  assert.equal(fbsResult.errors.length, 1);
  assert.match(fbsResult.shops[0].error, /FBP unavailable/);

  failFbp = false;
  const fbpResult = await sync({ skip_post_processing: true });
  assert.deepEqual(written, ["FBS-1", "FBP-1"]);
  assert.equal(fbpResult.errors.length, 1);
  assert.match(fbpResult.shops[0].error, /FBS unavailable/);
});

test("new-order sync covers two complete Beijing days of FBP without a long initial backfill", async () => {
  const source = serviceSource.match(/export async function syncOzonIncrementalOrdersMysql\(body = \{\}, options = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source);
  const requests = [];
  const sync = vm.runInNewContext(`${source.replace("export ", "")}; syncOzonIncrementalOrdersMysql`, {
    ensureMysqlCutoverEnabled() {},
    nullableInteger: () => 0,
    shopsMysql: async () => [{ ...shop, status: "active" }],
    todayDateKeyMysql: () => "2026-10-20",
    dateKeyDaysAgoMysql: (days) => days === 2 ? "2026-10-18" : "2026-08-21",
    normalizeShanghaiDateBoundaryMysql: (date) => `${date}T00:00:00Z`,
    latestOrderSyncStartMysql: async () => "2026-10-20T08:00:00Z",
    emptySyncAggregateMysql: (mode, from, to) => ({ mode, from, to, inserted: 0, updated: 0, fetched: 0, requests: 0, shops: [], errors: [] }),
    mergeSyncAggregateMysql() {},
    throwIfAbortedMysql() {},
    syncDemoOrdersMysql: async (body) => { requests.push(body); return { inserted: 0, updated: 0, fetched: 0, requests: 2, shops: [], errors: [] }; },
    mysqlExecute: async () => {}
  });
  await sync({ mode: "new", skip_post_processing: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].from_datetime, "2026-10-20T08:00:00Z");
  assert.equal(requests[0].fbp_from_datetime, "2026-10-18T00:00:00Z");
});
