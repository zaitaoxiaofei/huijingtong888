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
  assert.match(dashboardServiceSource, /queueDashboardSnapshotRefreshMysql\(\{ forceRefresh: false, dateKey \}\);\s+return pendingDashboardPayloadMysql\(dateKey\);/);
  assert.match(dashboardServiceSource, /dashboardSnapshotIsStaleMysql[\s\S]*?queueDashboardSnapshotRefreshMysql\(\{ forceRefresh: true, dateKey \}\)[\s\S]*?status: "building"/);
  assert.doesNotMatch(dashboardServiceSource, /dashboardSnapshotIsStaleMysql\(snapshot, dateKey\)\) \{\s*return rebuildDashboardSnapshotMysql/);
});

test("dashboard refresh returns the saved snapshot while rebuilding asynchronously", () => {
  assert.match(dashboardServiceSource, /if \(forceRefresh\) \{[\s\S]*?loadDashboardSnapshotMysql\(dateKey\)[\s\S]*?queueDashboardSnapshotRefreshMysql\(\{ forceRefresh: true, dateKey \}\)/);
  assert.doesNotMatch(dashboardServiceSource, /if \(forceRefresh\) \{\s*return rebuildDashboardSnapshotMysql/);
});

test("dashboard survives transient connection failures", () => {
  assert.match(dashboardViewSource, /getDashboardWithRetry/);
  assert.match(dashboardViewSource, /DASHBOARD_SESSION_CACHE_PREFIX/);
  assert.match(dashboardViewSource, /scheduleDashboardSnapshotReload\(Math\.min\(1500 \* dashboardSnapshotRefreshAttempts, 6000\)\)/);
});
