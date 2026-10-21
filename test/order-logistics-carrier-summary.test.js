import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { classifyOrderLogistics } from "../src/services/order-logistics-classification.js";
import { orderLogisticsCarrierCandidateSql, orderLogisticsCarrierSummaryRows } from "../src/services/order-logistics-carrier-summary.js";
import { getCachedMasterData, invalidateMasterDataCachePrefix } from "../src/services/mysql-master-data-cache.js";

const paths = ["delivery_method.name", "delivery_method.warehouse", "delivery_method.tpl_provider",
  "analytics_data.warehouse", "analytics_data.tpl_provider", "warehouse_name", "tpl_provider"];

function setPath(target, path, value) {
  const parts = path.split(".");
  const key = parts.pop();
  for (const part of parts) target = target[part] ||= {};
  target[key] = value;
}

test("OGL candidates use one guarded extraction of the 14 logistics paths, never arbitrary raw text", () => {
  const sql = orderLogisticsCarrierCandidateSql("ogl");
  const actualPaths = [...sql.matchAll(/'(\$\.[^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(actualPaths.sort(), [...paths.map((path) => `$.${path}`), ...paths.map((path) => `$.raw.${path}`)].sort());
  assert.equal((sql.match(/JSON_EXTRACT\(/g) || []).length, 1);
  assert.match(sql, /CASE WHEN JSON_VALID\(raw\.raw_json\) THEN raw\.raw_json ELSE '\{\}' END/);
  assert.match(sql, /LOWER\(JSON_EXTRACT/);
  assert.match(sql, /LIKE '%ogl%'/);
  assert.doesNotMatch(sql, /customer|buyer|product|url|JSON_SEARCH|COALESCE|JSON_OBJECT|fulfillment_schema/);
  for (const carrier of ["guoo", "cel", "postal", "other", "all", "' OR 1=1"]) {
    assert.equal(orderLogisticsCarrierCandidateSql(carrier), "", "unprofiled carriers retain full raw classification");
  }
});

test("light carrier summaries equal full classification for every fallback and both payload shapes", () => {
  const original = [];
  for (const path of paths) {
    for (const wrapped of [false, true]) {
      for (const token of ["OGL", "GUOO", "CEL", "Hch-pd 2", "China Post", "Google", "cancelled"]) {
        const logistics = {};
        setPath(logistics, path, token);
        logistics.fulfillment_schema = "FBP";
        const raw = { ...logistics, customer: { name: "OGL" }, products: [{ name: "CEL GUOO" }], url: "https://example.test/ogl" };
        const id = original.length + 1;
        original.push({ id, raw_json: JSON.stringify(wrapped ? { raw, delivery_method: { name: "OGL ignored outer field" } } : raw), billing_logistics_rule_name: "OGL Economy Extra Small" });
      }
    }
  }
  original.push({ id: 999, raw_json: '{"raw":{},"delivery_method":{"name":"OGL ignored outer field"}}', resolved_logistics_rule_name: "CEL fallback" });
  const expected = original.map((row) => ({ id: row.id, logistics_carrier: classifyOrderLogistics(row).logistics_carrier }));
  assert.deepEqual(orderLogisticsCarrierSummaryRows(original), expected);
  for (const carrier of ["ogl", "guoo", "cel", "postal", "other"]) {
    assert.deepEqual(orderLogisticsCarrierSummaryRows(original, carrier), expected.filter((row) => row.logistics_carrier === carrier));
  }
  assert.ok(orderLogisticsCarrierSummaryRows(original).every((row) => Object.keys(row).length === 2), "the memory cache contains no raw payload or tariff-derived channel");
});

test("full raw final classification rejects customer pollution, ignored outer layers and partial ASCII tokens", () => {
  const payloads = [
    { raw: { delivery_method: { name: "GUOO" }, customer: { name: "OGL" } } },
    { raw: { delivery_method: { name: "GUOO" } }, delivery_method: { name: "OGL" } },
    { raw: {}, delivery_method: { name: "OGL" } },
    { raw: [], delivery_method: { name: "OGL" } },
    ...["Google", "xOGL", "OGL2", "1OGL"].map((name) => ({ delivery_method: { name } })),
    { delivery_method: { name: { customer: "OGL" } } },
    { raw: "OGL", delivery_method: { name: "OGL" } },
    { delivery_method: { name: "OGL economy" } },
    { delivery_method: { name: "_OGL_" } },
    { delivery_method: { name: "前OGL后" } },
    ...[null, false, 0, ""].map((raw) => ({ raw, delivery_method: { name: "OGL" } }))
  ];
  const rows = payloads.map((payload, index) => ({ id: index + 1, raw_json: JSON.stringify(payload) }));
  rows.push({ id: 18, raw_json: '{"delivery_method":{"name":"\\u004fGL"}}' });
  rows.push({ id: 19, raw_json: "not valid JSON" });
  assert.deepEqual(orderLogisticsCarrierSummaryRows(rows, "ogl").map((row) => row.id), [11, 12, 13, 14, 15, 16, 17, 18]);
});

test("light summary preserves tenant/shop/date scope, bypasses tariff work and coalesces warm/concurrent reads", async () => {
  const source = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const definition = source.match(/async function loadOrderLogisticsCarrierSummaryForBaseMysql\([^]*?\n}/)?.[0];
  assert.ok(definition);
  const queries = [], keys = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const base = { where: "o.shop_id = ? AND o.ordered_at >= ? AND EXISTS (SELECT 1 FROM shops tenant_shop WHERE tenant_shop.id = o.shop_id AND tenant_shop.tenant_id = 9 AND tenant_shop.status = 'active')", params: [2, "2026-07-22 16:00:00"] };
  const load = vm.runInNewContext(`${definition}\nloadOrderLogisticsCarrierSummaryForBaseMysql`, {
    orderLogisticsCarrierCandidateSql, orderLogisticsCarrierSummaryRows, ORDER_COUNTS_CACHE_TTL_MS: 180000,
    getCachedMasterData: (key, loader, ttl) => { keys.push(key); return getCachedMasterData(key, loader, ttl); },
    mysqlQuery: async (sql, params) => {
      queries.push({ sql, params }); await pending;
      return [{ id: 1, raw_json: '{"delivery_method":{"name":"OGL Economy Extra Small"}}' },
        { id: 2, raw_json: '{"delivery_method":{"name":"GUOO"}}' },
        { id: 3, raw_json: '{"raw":{},"delivery_method":{"name":"OGL ignored outer field"}}' }];
    }
  });
  invalidateMasterDataCachePrefix("orders:logistics-carrier-summary:");
  const first = load(base, "9", "ogl");
  const concurrent = load(base, "9", "ogl");
  release();
  const [rows] = await Promise.all([first, concurrent]);
  await load(base, "9", "ogl");
  assert.equal(queries.length, 1);
  assert.deepEqual(Array.from(rows, (row) => [row.id, row.logistics_carrier]), [[1, "ogl"]]);
  assert.deepEqual(queries[0].params, base.params);
  assert.match(keys[0], /^orders:logistics-carrier-summary:v2:9:ogl:/);
  assert.match(queries[0].sql, /raw\.store_id = o\.shop_id AND raw\.posting_number = o\.posting_number/);
  assert.ok(queries[0].sql.includes(base.where));
  assert.doesNotMatch(queries[0].sql, /order_items|logistics_fee_rules|GROUP BY|snapshot|CREATE TABLE|INSERT/);
  assert.match(queries[0].sql, /LIKE '%ogl%'/);
  assert.match(queries[0].sql, /SELECT o\.id, raw\.raw_json/);
  await load(base, "10", "ogl");
  assert.equal(queries.length, 2, "different tenant cache identities cannot share a result");
  const guoo = await load(base, "9", "guoo");
  assert.equal(queries.length, 3, "different requested carriers cannot reuse OGL candidates");
  assert.deepEqual(Array.from(guoo, (row) => [row.id, row.logistics_carrier]), [[2, "guoo"]]);
  assert.doesNotMatch(queries[2].sql, /JSON_EXTRACT|LIKE/);
  await load({ ...base, params: [3, base.params[1]] }, "9", "ogl");
  await load({ ...base, params: [2, "2026-09-01 16:00:00"] }, "9", "ogl");
  assert.equal(queries.length, 5, "shop and date bounds remain part of the cache identity");
  invalidateMasterDataCachePrefix("orders:logistics-carrier-summary:");
});
