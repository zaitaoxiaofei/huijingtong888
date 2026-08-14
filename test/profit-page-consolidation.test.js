import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dashboardSource = readFileSync(new URL("../frontend/admin/views/DashboardView.vue", import.meta.url), "utf8");
const hubSource = readFileSync(new URL("../frontend/admin/views/profit/MonthlyBillingHubView.vue", import.meta.url), "utf8");
const billingSource = readFileSync(new URL("../frontend/admin/views/profit/MonthlyBillingDetailsView.vue", import.meta.url), "utf8");
const billingOrdersSource = readFileSync(new URL("../frontend/admin/views/profit/MonthlyBillingOrdersView.vue", import.meta.url), "utf8");
const navigationSource = readFileSync(new URL("../frontend/admin/constants/navigation.js", import.meta.url), "utf8");
const routerSource = readFileSync(new URL("../frontend/admin/router/index.js", import.meta.url), "utf8");
const mysqlSource = readFileSync(new URL("../src/services/mysql-cutover.js", import.meta.url), "utf8");
const profitRoutesSource = readFileSync(new URL("../src/server/routes/profit.js", import.meta.url), "utf8");

test("dashboard supports Beijing-date navigation and sends the selected date", () => {
  assert.match(dashboardSource, /selectedDate/);
  assert.match(dashboardSource, /<h1>经营总览<\/h1>/);
  assert.match(dashboardSource, /class="dashboard-date-control"/);
  assert.match(dashboardSource, /<el-date-picker/);
  assert.match(dashboardSource, /shiftDashboardDate\(-1\)/);
  assert.match(dashboardSource, /shiftDashboardDate\(1\)/);
  assert.match(dashboardSource, /date=\$\{encodeURIComponent\(dateKey\)\}/);
  assert.match(mysqlSource, /function dashboardDateKeyMysql/);
  assert.match(mysqlSource, /date_key: selectedDate/);
  assert.match(mysqlSource, /previous_date_key: previousDate/);
});

test("monthly billing lazily owns overview, order details, and aftersales views", () => {
  assert.match(hubSource, /defineAsyncComponent/);
  assert.match(hubSource, /value: "overview"/);
  assert.match(hubSource, /value: "orders"/);
  assert.match(hubSource, /value: "aftersales"/);
  assert.match(hubSource, /ProfitAftersalesView v-if/);
  assert.match(hubSource, /MonthlyBillingOrdersView v-else-if/);
  assert.match(hubSource, /MonthlyBillingDetailsView v-else/);
});

test("monthly billing and order details support a Beijing-date range", () => {
  assert.match(billingSource, /type="daterange"/);
  assert.match(billingSource, /from: state\.dateRange\[0\]/);
  assert.match(billingOrdersSource, /type="daterange"/);
  assert.match(billingOrdersSource, /to: state\.filters\.dateRange\[1\]/);
  assert.match(mysqlSource, /账单查询时间范围不能超过 366 天/);
});

test("monthly billing separates accrued and pending settlement results", () => {
  assert.match(billingSource, /label: "已结算利润"/);
  assert.match(billingSource, /label: "待结算利润"/);
  assert.match(billingSource, /selectedSummary\.accrued_order_count/);
  assert.match(mysqlSource, /total\.accrued_order_count = rows\.reduce/);
});

test("legacy profit routes redirect while navigation exposes only monthly billing", () => {
  assert.match(routerSource, /path: "profit", redirect: "\/profit\/monthly-billing"/);
  assert.match(routerSource, /path: "profit\/aftersales", redirect:/);
  assert.match(routerSource, /path: "profit\/monthly-billing\/orders", redirect:/);
  assert.doesNotMatch(navigationSource, /key: "profit-dashboard"/);
  assert.doesNotMatch(navigationSource, /key: "profit-aftersales"/);
  assert.match(navigationSource, /key: "profit-monthly-billing"/);
});

test("retired profit dashboard APIs stay removed while monthly billing APIs remain", () => {
  assert.doesNotMatch(profitRoutesSource, /\/api\/profit-dashboard/);
  assert.doesNotMatch(profitRoutesSource, /\/api\/profit-summary/);
  assert.doesNotMatch(profitRoutesSource, /\/api\/profit-details/);
  assert.match(profitRoutesSource, /\/api\/monthly-billing-details/);
  assert.match(profitRoutesSource, /\/api\/profit-aftersales/);
});
