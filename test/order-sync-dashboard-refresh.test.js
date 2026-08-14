import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const configSource = readFileSync(new URL("../src/config.js", import.meta.url), "utf8");
const envExampleSource = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

test("scheduled order sync refreshes the dashboard snapshot before it succeeds", () => {
  const handler = serverSource.match(/async function runBackgroundOrderStatusSync\(\)[\s\S]*?\n}\n\nasync function runBackgroundCancelledOrderSync/)?.[0] || "";

  assert.match(handler, /await services\.syncOzonIncrementalOrders\([\s\S]*?await services\.refreshDashboardSnapshot\(\{ forceRefresh: true }\)/);
  assert.match(handler, /dashboard_refresh:/);
});

test("standalone dashboard schedule is disabled after being merged into order sync", () => {
  const definition = serverSource.match(/key: "dashboard_snapshot_refresh"[\s\S]*?maxCatchupRuns: 0/)?.[0] || "";

  assert.match(definition, /enabled: false/);
});

test("explicit dashboard refresh preserves an optional date key", () => {
  const refresh = dashboardSource.match(/export async function refreshDashboardSnapshotMysql[\s\S]*?\n}/)?.[0] || "";

  assert.match(refresh, /dateKey: options\.dateKey \|\| options\.date_key/);
});

test("combined order and dashboard refresh defaults to a ten minute interval", () => {
  assert.match(configSource, /backgroundOrderSyncIntervalMinutes: readNumberEnv\("BACKGROUND_ORDER_SYNC_INTERVAL_MINUTES", 10\)/);
  assert.match(serverSource, /config\.backgroundOrderSyncIntervalMinutes \|\| 10/);
  assert.match(envExampleSource, /BACKGROUND_ORDER_SYNC_INTERVAL_MINUTES=10/);
});
