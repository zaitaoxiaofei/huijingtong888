import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { navigationMenusForRole } from "../frontend/admin/constants/navigation.js";

const dashboardSource = fs.readFileSync(new URL("../frontend/admin/views/DashboardView.vue", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("finance and system navigation are only visible to admins", () => {
  const operatorKeys = navigationMenusForRole("operator").map((item) => item.key);
  const managerKeys = navigationMenusForRole("manager").map((item) => item.key);
  const adminKeys = navigationMenusForRole("admin").map((item) => item.key);
  const operatorRoutes = navigationMenusForRole("operator").flatMap((item) => item.children || [item]).map((item) => item.route);

  assert.equal(operatorKeys.includes("finance"), false);
  assert.equal(operatorKeys.includes("settings"), false);
  assert.equal(managerKeys.includes("finance"), false);
  assert.equal(managerKeys.includes("settings"), false);
  assert.equal(adminKeys.includes("finance"), true);
  assert.equal(adminKeys.includes("settings"), true);
  assert.equal(operatorRoutes.includes("/exceptions/profit"), false);
  assert.equal(operatorRoutes.some((route) => String(route || "").startsWith("/profit/")), false);
});

test("dashboard hides only profit cards and profit trend from non-admin users", () => {
  assert.match(dashboardSource, /v-if="isAdmin" class="primary-metric profit-card"/);
  assert.match(dashboardSource, /v-if="isAdmin" class="primary-metric month-profit-card"/);
  assert.match(dashboardSource, /isAdmin\.value \|\| card\.title !== "利润趋势"/);
  assert.doesNotMatch(dashboardSource, /首页经营数据仅管理员可见/);
  assert.match(serverSource, /dashboardForSession/);
  assert.match(serverSource, /includes\("profit"\)/);
});
