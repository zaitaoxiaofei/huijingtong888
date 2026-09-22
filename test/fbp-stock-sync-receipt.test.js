import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
function functionSource(name) {
  const match = source.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([^]*?\\n}`));
  return match ? match[0].replace(/^export /, "") : "";
}

for (const scenario of [
  { name: "stock recovers from zero", before: 0, after: 172 },
  { name: "stock rises while a shipment is outstanding", before: 158, after: 168 },
  { name: "stock API fails and falls back to cached stock", before: 0, after: 161, fail: true }
]) {
  test(`stock sync does not confirm shipment receipt when ${scenario.name}`, async () => {
    let stock = scenario.before;
    const receipts = [];
    const context = vm.createContext({
      ensureMysqlCutoverEnabled() {}, ensureOzonStockStorageSchemaMysql() {},
      nullableNumber: (value) => value ? Number(value) : null,
      shopsMysql: async () => [{ id: 4, name: "Shop", status: "active" }],
      stockSyncFiltersMysql: async () => ({}),
      fetchOzonProductStocks: async () => {
        if (scenario.fail) throw new Error("API unavailable");
        return [{ present: scenario.after }];
      },
      fetchOzonStockAnalyticsSafeMysql: async () => ({ rows: [], errors: [] }),
      mergeOzonStockAnalyticsRowsMysql: (rows) => rows,
      clearStockSnapshotsForSyncMysql: async () => { stock = 0; },
      fallbackStockRowsFromOnlineProductsMysql: async () => [{ present: scenario.after }],
      upsertStockSnapshotMysql: async (_, row) => { stock = row.present; },
      reclassifyStockSnapshotsMysql: async () => {},
      invalidateMasterDataCache() {}, stockAlertsMysql: async () => [],
      mysqlQuery: async (sql) => sql.includes("FROM ozon_stock_snapshots")
        ? [{ shop_id: 4, product_id: 48, ozon_sku: "4069090137", fbp_quantity: stock }]
        : [{ id: 191, quantity: 200, listed_quantity: 0 }],
      confirmFbpTransferReceivedMysql: async (body) => { receipts.push(body); }
    });
    vm.runInContext([
      "fbpStockDeltaKey", "currentFbpStockQuantityMapMysql",
      "autoConfirmFbpTransfersFromStockDeltaMysql", "syncOzonStocksMysql"
    ].map(functionSource).join("\n"), context);
    const result = await context.syncOzonStocksMysql({ shop_id: 4 });
    assert.equal(stock, scenario.after, "stock snapshots still refresh");
    assert.equal(receipts.length, 0, "inventory changes are not shipment receipt evidence");
    assert.equal(result.upserted, 1);
    assert.equal(result.status, scenario.fail ? "partial_error" : "ok");
    assert.equal(result.auto_fbp_receive.confirmedQuantity, 0);
  });
}
