import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const backendSource = fs.readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const frontendSource = fs.readFileSync(new URL("../frontend/admin/views/DashboardView.vue", import.meta.url), "utf8");

test("FBP opportunity sales aggregation is bounded to recent orders", () => {
  assert.match(backendSource, /WHERE o\.ordered_at >= DATE_SUB\(UTC_TIMESTAMP\(\), INTERVAL 31 DAY\)/);
  assert.match(backendSource, /getCachedMasterData\("fbp-opportunities:base:v2"/);
});

test("dashboard loads FBP opportunities independently from the main snapshot", () => {
  const dashboardBuilder = backendSource.slice(
    backendSource.indexOf("async function buildDashboardPayloadMysql"),
    backendSource.indexOf("async function rebuildDashboardSnapshotMysql")
  );
  assert.doesNotMatch(dashboardBuilder, /fbpOpportunitiesMysql/);
  assert.match(frontendSource, /getDashboardWithRetry\("\/api\/fbp-opportunities\?page=1&pageSize=1", \{ routeScoped: false \}\)/);
  assert.match(frontendSource, /const fbpOpportunityRequest = getDashboardWithRetry/);
  assert.match(frontendSource, /await Promise\.allSettled\(\[limitsRequest, rankingRequest, fbpOpportunityRequest\]\)/);
});
