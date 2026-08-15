import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dashboard rebuilds a persisted snapshot when analytics are newer", async () => {
  const source = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const dashboard = source.match(/async function dashboardSnapshotIsStaleMysql[\s\S]*?export async function inventoryMysql/)?.[0] || "";

  assert.match(dashboard, /MAX\(refreshed_at\) AS refreshed_at[\s\S]*FROM analytics_shop_daily/);
  assert.match(dashboard, /if \(await dashboardSnapshotIsStaleMysql\(snapshot, dateKey\)\)/);
  assert.match(dashboard, /queueDashboardSnapshotRefreshMysql\(\{ forceRefresh: true, dateKey \}\)/);
  assert.match(dashboard, /status: "building"/);
});

test("dashboard calculates today's order metrics from live orders", async () => {
  const source = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const builder = source.match(/async function buildDashboardPayloadMysql[\s\S]*?async function rebuildDashboardSnapshotMysql/)?.[0] || "";

  assert.match(builder, /dashboardRecentCommerceMysql\(selectedDate, previousDate\)/);
  assert.doesNotMatch(builder, /profitSummaryOverviewMysql\(selectedDate, selectedDate\)/);
  assert.doesNotMatch(builder, /profitSummaryOverviewMysql\(previousDate, previousDate\)/);
});

test("dashboard snapshot refresh leaves database capacity for foreground requests", async () => {
  const source = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const builder = source.match(/async function buildDashboardPayloadMysql[\s\S]*?async function rebuildDashboardSnapshotMysql/)?.[0] || "";

  assert.match(builder, /mapWithConcurrencyMysql\(\[/);
  assert.match(builder, /\], 3, \(loadSection\) => loadSection\(\)\)/);
  assert.doesNotMatch(builder, /await Promise\.all\(\[/);
});

test("dashboard consolidates repeated commerce ranges into bounded aggregate queries", async () => {
  const source = await readFile(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
  const recentCommerce = source.match(/async function dashboardRecentCommerceMysql[\s\S]*?async function dashboardFbpInventoryValueMysql/)?.[0] || "";
  const trend = source.match(/async function dashboardProfitTrendSummaryMysql[\s\S]*?async function dashboardAftersalesLossSummaryMysql/)?.[0] || "";

  assert.match(recentCommerce, /\$\{chinaDateKeySqlMysql\("o\.ordered_at"\)\} AS date_key/);
  assert.match(recentCommerce, /GROUP BY \$\{chinaDateKeySqlMysql\("o\.ordered_at"\)\}, o\.shop_id, s\.name/);
  assert.match(recentCommerce, /today: summarize\(selectedDateRows\)/);
  assert.match(recentCommerce, /yesterday: summarize/);
  assert.equal((trend.match(/FROM analytics_shop_daily/g) || []).length, 1);
  assert.match(trend, /SUM\(CASE WHEN date_key >= \? AND date_key <= \? THEN current_profit/);
  assert.doesNotMatch(trend, /profitSummaryOverviewMysql\(/);
});
