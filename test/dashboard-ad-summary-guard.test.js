import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dashboardSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const dashboardViewSource = readFileSync(new URL("../frontend/admin/views/DashboardView.vue", import.meta.url), "utf8");

test("dashboard ad ROI is based only on Ozon ad report revenue", () => {
  assert.match(dashboardSource, /const adRevenue = Number\(row\?\.revenue_cny \|\| 0\) \|\| rubToCnyMysql\(revenueRub, exchangeRate\);/);
  assert.match(dashboardSource, /const roi = spend && adRevenue \? adRevenue \/ spend : null;/);
  assert.doesNotMatch(dashboardSource, /const revenue = Number\(row\?\.revenue_cny \|\| 0\) \|\| rubToCnyMysql\(revenueRub, exchangeRate\) \|\| localRevenue;/);
  assert.doesNotMatch(dashboardSource, /local_order_fallback/);
});

test("dashboard view does not treat missing ad ROI as a low ROI alert", () => {
  assert.match(dashboardViewSource, /if \(hasValue\(adToday\.value\.roi\) && Number\(adToday\.value\.roi \|\| 0\) < 1\)/);
});
