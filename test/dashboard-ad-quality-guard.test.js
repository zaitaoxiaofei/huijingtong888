import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dashboardSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const dashboardViewSource = readFileSync(new URL("../frontend/admin/views/DashboardView.vue", import.meta.url), "utf8");

test("dashboard ad summaries expose pending report quality", () => {
  assert.match(dashboardSource, /quality_status: pendingRows > 0 \? "partial" : "complete"/);
  assert.match(dashboardSource, /pending_dates: pendingDateRows\.map/);
  assert.match(dashboardSource, /recent_pending_rows/);
  assert.match(dashboardSource, /last_complete_date_key/);
  assert.match(dashboardSource, /complete_dates_spend_cny/);
  assert.match(dashboardSource, /returned_spend_cny/);
});

test("dashboard month ad spend warns when report rows are pending", () => {
  assert.match(dashboardViewSource, /adMonthQuality/);
  assert.match(dashboardViewSource, /adMonthSpendDisplay/);
  assert.match(dashboardViewSource, /报表未齐/);
  assert.match(dashboardViewSource, /不可当最终月累计/);
  assert.match(dashboardViewSource, /pending_dates/);
});

test("dashboard overview keeps today and month metrics in stable rows", () => {
  assert.match(dashboardViewSource, /\.today-core-grid\s*\{\s*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\);/);
  assert.match(dashboardViewSource, /\.month-core-grid\s*\{\s*grid-template-columns:\s*repeat\(9,\s*minmax\(0,\s*1fr\)\);/);
  assert.doesNotMatch(dashboardViewSource, /month-ad-spend-card[\s\S]{0,160}grid-row:\s*span\s+2/);
});

test("today advertising sync covers a rolling recent window", () => {
  const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(serverSource, /scope: "rolling_recent"/);
  assert.match(serverSource, /rollingDays: 3/);
  assert.match(serverSource, /const rollingDays = Math\.max\(1, Math\.min\(3,/);
  assert.match(serverSource, /from: fromDate/);
});
