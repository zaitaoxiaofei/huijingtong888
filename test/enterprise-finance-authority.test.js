import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";
import { canAccessPage, getRoles, hasPermission, isPlatformAdmin, primaryRole } from "../src/shared/permissions.js";
import { effectiveTenantMembershipRole } from "../src/services/tenant-membership-authority.js";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const owner = { personId: 6, id: 6, roles: ["operations"], platform_role: null, tenant: { id: 1, slug: "default", role: "owner", access_allowed: true } };
const allowed = (subject, method, path) => authorizeApiRequest({ method, _session: subject }, path.split("/").filter(Boolean)).allowed;

test("reviewed enterprise owners and administrators read only the admitted finance pages and APIs without platform authority", () => {
  for (const role of ["owner", "admin"]) for (const tenant of [{ id: 1, slug: "default" }, { id: 2, slug: "company-a" }]) {
    const subject = { ...owner, roles: ["packing"], tenant: { ...tenant, role, access_allowed: true } };
    assert.equal(hasPermission(subject, "finance"), true);
    assert.equal(hasPermission(subject, "admin"), false);
    assert.equal(isPlatformAdmin(subject), false);
    for (const page of ["/dashboard", "/finance-center", "/profit/monthly-billing", "/profit/monthly-billing/orders", "/profit/aftersales", "/finance/payroll"]) assert.equal(canAccessPage(subject, page), true, page);
    for (const page of ["/settings", "/tenant-management", "/platform-accounts", "/profit/reconciliation", "/profit/inventory-risks", "/finance/unknown"]) assert.equal(canAccessPage(subject, page), false, page);
    for (const path of ["/api/monthly-billing-details", "/api/monthly-billing-orders", "/api/payroll/setup", "/api/payroll/period", "/api/profit-aftersales", "/api/profit-aftersales/details"]) assert.equal(allowed(subject, "GET", path), true, path);
    for (const path of ["/api/payroll/setup/private", "/api/payroll/period/1", "/api/ozon-finance/summary", "/api/payroll/calculate", "/api/profits/recalculate-historical", "/api/settings/exchange-rate"]) assert.equal(allowed(subject, path.includes("period/") || path.includes("setup/") || path.includes("summary") ? "GET" : "POST", path), false, path);
    assert.equal(tenantIsolationDecision(subject, ["api", "payroll", "setup"], "GET").allowed, true);
    assert.equal(tenantIsolationDecision(subject, ["api", "payroll", "calculate"], "POST").allowed, false);
  }
  for (const subject of [{ ...owner, tenant: { ...owner.tenant, role: "member" } }, { ...owner, tenant: null }, { roles: ["admin"], name: "曼哈顿牛马", tenant: { id: 1, slug: "default", role: "member" } }]) {
    assert.equal(canAccessPage(subject, "/finance/payroll"), false);
    assert.equal(allowed(subject, "GET", "/api/payroll/setup"), false);
    assert.equal(allowed(subject, "GET", "/api/monthly-billing-details"), false);
  }
});

test("live sessions preserve explicit enterprise authority independently of job duties and retain the auto-owner protection", async () => {
  const source = readFileSync("src/services/mysql-auth-session.js", "utf8").replace(/^import[^\n]+\n/gm, "").replaceAll("export ", "");
  let row = { person_id: 6, current_name: "Owner fixture", current_role: "operator", roles_json: '["operator"]', active_tenant_id: 1, tenant_slug: "default", tenant_role: "owner", tenant_status: "active", business_roles_json: '["operations"]', platform_role: null, expires_at: new Date(Date.now() + 60000), created_at: new Date() };
  const context = vm.createContext({ getRoles, primaryRole, effectiveTenantMembershipRole, isMysqlPrimaryEnabled: () => true, ensurePeopleRolesSchemaMysql: async () => {}, ensureTenantSchemaMysql: async () => {}, tenantHasAccess: () => true, mysqlQuery: async () => [row], mysqlExecute: async () => {} });
  vm.runInContext(source, context);
  let session = await context.getSessionMysql("fixture");
  assert.equal(session.tenant.role, "owner");
  assert.deepEqual(Array.from(session.roles), ["operations"]);
  assert.equal(hasPermission(session, "finance"), true);
  assert.equal(session.platform_role, null);
  row = { ...row, business_roles_json: null, current_role: "manager", roles_json: '["manager","operations","packing"]' };
  session = await context.getSessionMysql("fixture");
  assert.equal(session.tenant.role, "member", "unreviewed historical auto-owner is not elevated");
  assert.equal(hasPermission(session, "finance"), false);
  row = { ...row, current_role: "admin", roles_json: '["admin","operations"]' };
  assert.equal((await context.getSessionMysql("fixture")).tenant.role, "owner", "existing legacy business administrator retains their enterprise authority");
});

test("dashboard finance visibility and cached values bind to enterprise and authority while payroll stays read-only for owners", () => {
  const dashboard = readFileSync("frontend/admin/views/DashboardView.vue", "utf8");
  assert.match(dashboard, /hasPermission\(authStore\.user, "finance"\)/);
  const start = dashboard.indexOf("function dashboardSessionCacheKey("), end = dashboard.indexOf("\n}", start) + 2;
  const authStore = { user: { id: 6, roles: ["operations"], tenant: { id: 1, role: "owner" } } };
  const context = vm.createContext({ authStore, DASHBOARD_SESSION_CACHE_PREFIX: "fixture:" });
  vm.runInContext(dashboard.slice(start, end), context);
  const first = context.dashboardSessionCacheKey("2026-10-26");
  authStore.user.tenant.role = "member";
  assert.notEqual(context.dashboardSessionCacheKey("2026-10-26"), first);
  authStore.user.tenant.role = "owner";
  authStore.user.tenant.id = 2;
  assert.notEqual(context.dashboardSessionCacheKey("2026-10-26"), first);
  const filename = "frontend/admin/views/finance/PayrollView.vue", source = readFileSync(filename, "utf8");
  const { descriptor, errors } = parse(source, { filename });
  assert.deepEqual(errors, []);
  const script = compileScript(descriptor, { id: "payroll-authority" });
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename, id: "payroll-authority", compilerOptions: { bindingMetadata: script.bindings } }).errors, []);
  assert.match(source, /canManage = computed\(\(\) => isPlatformAdmin\(authStore\.user\)\)/);
  assert.match(source, /v-if="canManage" class="toolbar-actions"/);
  assert.match(source, /currentRead\(read\)/);
  assert.match(source, /erp:auth-scope-changed/);
});
