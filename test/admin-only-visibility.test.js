import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { navigationMenusForRole } from "../frontend/admin/constants/navigation.js";

const dashboardSource = fs.readFileSync(new URL("../frontend/admin/views/DashboardView.vue", import.meta.url), "utf8");
const routerSource = fs.readFileSync(new URL("../frontend/admin/router/index.js", import.meta.url), "utf8");
const serverSource = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("finance belongs to enterprise administrators while system navigation requires an explicit platform grant", () => {
  const tenant = { id: 1, slug: "default", role: "member", access_allowed: true };
  const operator = { roles: ["operator"], tenant };
  const manager = { roles: ["manager"], tenant };
  const owner = { roles: ["operations"], tenant: { ...tenant, role: "owner" } };
  const platform = { roles: [], platform_role: "super_admin", tenant: { ...tenant, role: "owner" } };
  const operatorKeys = navigationMenusForRole(operator).map((item) => item.key);
  const managerKeys = navigationMenusForRole(manager).map((item) => item.key);
  const ownerKeys = navigationMenusForRole(owner).map((item) => item.key);
  const platformKeys = navigationMenusForRole(platform).map((item) => item.key);
  const operatorRoutes = navigationMenusForRole(operator).flatMap((item) => item.children || [item]).map((item) => item.route);

  assert.equal(operatorKeys.includes("finance"), false);
  assert.equal(operatorKeys.includes("settings"), false);
  assert.equal(managerKeys.includes("finance"), false);
  assert.equal(managerKeys.includes("settings"), false);
  assert.equal(ownerKeys.includes("finance"), true);
  assert.equal(ownerKeys.includes("settings"), false);
  assert.equal(platformKeys.includes("settings"), true);
  const ownerRoutes = navigationMenusForRole(owner).flatMap((item) => item.children || [item]).map((item) => item.route);
  const platformRoutes = navigationMenusForRole(platform).flatMap((item) => item.children || [item]).map((item) => item.route);
  assert.equal(ownerRoutes.includes("/finance/payroll"), true);
  assert.equal(ownerRoutes.includes("/profit/monthly-billing"), true);
  assert.equal(ownerRoutes.includes("/tenant-management"), false);
  assert.equal(platformRoutes.includes("/tenant-management"), true);
  assert.equal(navigationMenusForRole("admin").some(menu => menu.key === "settings"), false);
  assert.equal(operatorRoutes.includes("/tenant-management"), false);
  assert.match(routerSource, /path: "tenant-management", name: "tenant-management"/);
  assert.match(routerSource, /path: "settings\/tenants", name: "settings-tenants", redirect/);
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
