import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { searchInventoryRows, inventoryIdentifierSearch, isInventoryIdentifier } from "../src/services/inventory-search.js";
import { applyStockAlertQuery } from "../src/services/inventory-alert-utils.js";
import { normalizeFbpReplenishmentItem, normalizeFbpTransferRecord } from "../src/services/mysql-fbp-normalizers.js";

const source = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const products = [2, 23].map((id) => ({
  product_id: id, inventory_number: `1-${id}`, inventory_id: `P-20260916-010000-0${id}`,
  product_name: "黑色 汽车 钥匙壳", alert_level: "danger", created_at: "2026-09-16",
  skus: [{ shop_id: id, ozon_sku: `12345${id}`, offer_id: `offer-${id}`, shop_name: "测试店铺", fbp_snapshot_count: 1, fbp_available: 0 }]
}));

test("standard and legacy identifiers find the same inventory without matching number prefixes", () => {
  assert.deepEqual(searchInventoryRows(products, "1-2"), [products[0]]);
  assert.deepEqual(searchInventoryRows(products, products[0].inventory_id), [products[0]]);
  assert.deepEqual(searchInventoryRows(products, "123452"), [products[0]]);
  assert.deepEqual(searchInventoryRows(products, "1-999"), []);
  assert.deepEqual(searchInventoryRows(products, "钥匙壳 黑色"), products);
  assert.deepEqual(searchInventoryRows(products, "钥匙壳 红色"), []);
});

test("FB stock and alert pagination retain numbers, shop filters and independent sorting", () => {
  for (const mode of ["fbp", "fbp-alerts", "alerts"]) {
    const query = { mode, paged: "1", query: "1-2", pageSize: 1 };
    const result = applyStockAlertQuery(products, query);
    assert.equal(result.total, 1);
    assert.equal(result.rows[0].inventory_number, "1-2");
    assert.equal(applyStockAlertQuery(products, { ...query, shopId: 23 }).total, 0);
    assert.equal(applyStockAlertQuery(products, { ...query, page: 2 }).rows.length, 0);
    assert.equal(applyStockAlertQuery(products, { ...query, query: products[0].inventory_id }).total, 1);
  }
  const replacement = [{ ...products[0], inventory_number: "2-99", skus: [{ ...products[0].skus[0], fbp_available: 100 }] }];
  assert.equal(applyStockAlertQuery(replacement, { mode: "fbp", query: "2-99" }).rows[0].fbp_available, 100);
  assert.equal(applyStockAlertQuery(replacement, { mode: "fbp", query: "1-2" }).total, 0);
});

test("warm identifier searches reuse the snapshot index without scanning product names", () => {
  let reads = 0;
  const rows = Array.from({ length: 1000 }, (_, i) => ({ inventory_number: `1-${i + 1}`, get product_name() { reads++; return "钥匙壳"; } }));
  searchInventoryRows(rows, "1-1");
  const initialReads = reads;
  for (let i = 1; i <= 100; i++) assert.equal(searchInventoryRows(rows, `1-${i}`).length, 1);
  assert.equal(reads, initialReads);
});

test("recommendations search standard numbers and enforce the requested product context", () => {
  const start = source.indexOf("function applyFbpOpportunityQuery(");
  const end = source.indexOf("export async function fbpOpportunitiesMysql", start);
  const context = vm.createContext({ searchInventoryRows });
  vm.runInContext(source.slice(start, end), context);
  const rows = products.map((p) => ({ ...p, score: 60, suggested_qty: 10, ozon_sku: p.skus[0].ozon_sku, priority: "high" }));
  assert.equal(context.applyFbpOpportunityQuery(rows, { query: "1-2" }).rows[0].inventory_number, "1-2");
  assert.equal(context.applyFbpOpportunityQuery(rows, { query: "1-2", productId: 23 }).total, 0);
  assert.equal(context.applyFbpOpportunityQuery(rows, { productId: 23 }).total, 1);
});

test("replenishment and transfer serializers retain both identifiers", () => {
  for (const normalize of [normalizeFbpReplenishmentItem, normalizeFbpTransferRecord]) {
    const row = normalize(products[0]);
    assert.equal(row.inventory_number, "1-2");
    assert.equal(row.inventory_id, products[0].inventory_id);
  }
});

test("warm alerts read and parse the persisted snapshot only once", async () => {
  let reads = 0;
  let cached;
  const context = vm.createContext({
    ensureMysqlCutoverEnabled() {}, ensureProductNamingSchemaMysql: async () => {},
    ensureOzonStockStorageSchemaMysql: async () => {}, ensureStockLocationSchemaMysql: async () => {},
    ensureProfitAnalyticsSchemaMysql: async () => {},
    getCachedMasterData: async (key, loader) => cached ||= await loader(),
    mysqlQueryOne: async (sql) => { reads++; assert.match(sql, /alerts-v4/); return { payload_json: JSON.stringify(products) }; },
    parseJsonFallback: JSON.parse, STOCK_ALERT_BASE_CACHE_TTL_MS: 30000, applyStockAlertQuery
  });
  const start = source.indexOf("export async function stockAlertsMysql");
  vm.runInContext(source.slice(start, source.indexOf("async function loadFbpStockAlertBaseMysql", start)).replace("export ", ""), context);
  assert.equal((await context.stockAlertsMysql({ query: "1-2" })).total, 1);
  assert.equal((await context.stockAlertsMysql({ query: "1-23" })).total, 1);
  assert.equal(reads, 1);
});

test("mapping and hidden-stock number searches use identifier lookup SQL", async () => {
  for (const [name, next] of [["mappingsMysql", "async function ensureInventoryProductSearchSchemaMysql"], ["hiddenProductsMysql", "export async function selectionProductsMysql"]]) {
    const queries = [];
    const context = vm.createContext({
      ensureMysqlCutoverEnabled() {}, ensureProductNamingSchemaMysql: async () => {},
      inventoryIdentifierSearch, isInventoryIdentifier, withProductImageEndpointMysql: (row) => row,
      mysqlQuery: async (sql, params) => { queries.push({ sql, params }); return []; },
      mysqlQueryOne: async (sql, params) => { queries.push({ sql, params }); return { total: 0 }; }
    });
    const start = source.indexOf(`export async function ${name}`);
    vm.runInContext(source.slice(start, source.indexOf(next, start)).replace("export ", ""), context);
    await context[name]({ query: "1-2", paged: "1" });
    assert.equal(queries.length, 2);
    for (const { sql, params } of queries) {
      assert.match(sql, /inventory_number = \?/);
      assert.ok(params.includes("1-2"));
      assert.ok(!params.includes("%1-2%"));
    }
  }
});

test("sorted inventory starts count and page queries together without unused FBP aggregation", { timeout: 1000 }, async () => {
  let releasePage;
  const queries = [];
  const context = vm.createContext({
    ensureMysqlCutoverEnabled() {}, ensureProductCompositionSchemaMysql: async () => {},
    ensureProductNamingSchemaMysql: async () => {}, ensureStockLocationSchemaMysql: async () => {},
    inventoryProductPredicateMysql: () => "1=1", inventoryProductSearchTermsMysql: () => [],
    isInventoryIdentifier, localStockLocationPredicateMysql: () => "stock_location = 'LOCAL'",
    mysqlQuery: (sql) => { queries.push(sql); return new Promise((resolve) => { releasePage = resolve; }); },
    mysqlQueryOne: async (sql) => { queries.push(sql); releasePage([]); return { total: 0 }; }
  });
  const start = source.indexOf("export async function productsMysql");
  vm.runInContext(source.slice(start, source.indexOf("export async function hiddenProductsMysql", start)).replace("export ", ""), context);
  const result = await context.productsMysql({ paged: "1", sortKey: "stock" });
  assert.equal(result.total, 0);
  assert.equal(queries.length, 2);
  assert.ok(queries.every((sql) => !sql.includes("ozon_stock_snapshots")));
});
