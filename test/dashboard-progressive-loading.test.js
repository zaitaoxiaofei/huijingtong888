import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dashboardViewSource = readFileSync(new URL("../frontend/admin/views/DashboardView.vue", import.meta.url), "utf8");
const dashboardServiceSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");

test("dashboard does not load or render operation todos", () => {
  assert.doesNotMatch(dashboardViewSource, /operation-todos/);
  assert.doesNotMatch(dashboardViewSource, /运营动作中心/);
});

test("dashboard renders immediately while its snapshot is being prepared", () => {
  assert.doesNotMatch(dashboardViewSource, /v-loading="initialDashboardLoading"/);
  assert.match(dashboardViewSource, /res\?\.snapshot\?\.status === "building"/);
  assert.match(dashboardServiceSource, /options.snapshot \|\| pendingDashboardPayloadMysql\(dateKey\)/);
  assert.match(dashboardServiceSource, /dashboardSnapshotProgressMysql.set/);
});

test("dashboard refresh returns the saved snapshot while rebuilding asynchronously", () => {
  const handler = dashboardServiceSource.slice(dashboardServiceSource.indexOf("export async function dashboardMysql"), dashboardServiceSource.indexOf("export async function inventoryMysql"));
  assert.match(handler, /queueDashboardSnapshotRefreshMysql\(\{ forceRefresh, dateKey, tenantId, snapshot \}\)/);
  assert.doesNotMatch(handler, /await rebuildDashboardSnapshotMysql/);
});

test("dashboard survives transient connection failures", () => {
  assert.match(dashboardViewSource, /getDashboardWithRetry/);
  assert.match(dashboardViewSource, /DASHBOARD_SESSION_CACHE_PREFIX/);
  assert.match(dashboardViewSource, /scheduleDashboardSnapshotReload\(Math\.min\(1500 \* dashboardSnapshotRefreshAttempts, 6000\)\)/);
});
