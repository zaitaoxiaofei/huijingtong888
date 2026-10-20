import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("incremental order sync runs global post-processing once after all shops", async () => {
  const source = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const incremental = source.match(/export async function syncOzonIncrementalOrdersMysql[\s\S]*?export async function syncOzonPostingsByNumberMysql/)?.[0] || "";

  assert.match(incremental, /skip_post_processing: true/);
  assert.equal((incremental.match(/await syncOutboundForOpenOrdersMysql\(\{ ordered_from: recentFrom, ordered_to: to \}\)/g) || []).length, 1);
  assert.equal((incremental.match(/await refreshProfitAnalyticsSnapshotsMysql/g) || []).length, 1);
});

test("skip-post-processing sync marks affected sales days without a per-order full-day refresh", async () => {
  const source = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const sync = source.match(/export async function syncDemoOrdersMysql[\s\S]*?async function ensurePurchaseOrderShipmentSchemaMysql/)?.[0] || "";
  assert.match(sync, /const shopSalesDates = new Set\(postings\.map/);
  assert.match(sync, /await markInventoryAlertSkuDailyDirtyMysql/);
  assert.match(sync, /salesDatesMarked: true/);
  assert.doesNotMatch(sync, /await refreshInventoryAlertSkuDailyMysql/);
  const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.ok(server.includes('key: "inventory_sales_daily_backfill"'));
  assert.match(server, /inventory_sales_daily_backfill: withForegroundApiDeferral\("inventory_sales_daily_backfill", \(\) => backfillInventoryAlertSalesMysql\(\{ max_days: 30 \}\)\)/);
});
