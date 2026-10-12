import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { DEFAULT_TENANT_PLAN_PRESETS, normalizeTenantPlanInput, tenantPlanMemberLimit } from "../src/services/tenant-plans.js";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("default tenant plan catalog preserves trial and expected seat/shop allowances", () => {
  assert.deepEqual(DEFAULT_TENANT_PLAN_PRESETS.map(plan => [plan.code, plan.duration_days]), [
    ["trial_1d", 1], ["trial_7d", 7], ["monthly", 30], ["monthly_team", 30], ["quarterly_team", 90], ["yearly", 365]
  ]);
  assert.deepEqual(DEFAULT_TENANT_PLAN_PRESETS.map(plan => [plan.account_limit, plan.shop_limit]), [
    [1, 2], [1, 2], [1, 2], [3, 10], [3, 10], [3, 10]
  ]);
  assert.equal(DEFAULT_TENANT_PLAN_PRESETS[0].subscription_status, "trial");
  assert.equal(DEFAULT_TENANT_PLAN_PRESETS[1].subscription_status, "trial");
});

test("tenant plan input validates duration and total accounts including the owner", () => {
  assert.deepEqual(normalizeTenantPlanInput({ name: " Custom ", duration_days: "45", subscription_status: "active", account_limit: "3", shop_limit: "10" }), {
    name: "Custom", duration_days: 45, subscription_status: "active", account_limit: 3, shop_limit: 10
  });
  assert.equal(normalizeTenantPlanInput({ name: "不限套餐", duration_days: 1, account_limit: null, shop_limit: null }).account_limit, null);
  for (const input of [
    { name: "", duration_days: 30 },
    { name: "bad", duration_days: 0 },
    { name: "bad", duration_days: 30, account_limit: 0 },
    { name: "bad", duration_days: 30, subscription_status: "suspended" }
  ]) assert.throws(() => normalizeTenantPlanInput(input), error => error.statusCode === 400);
});

test("package total-account quota converts to additional account capacity", () => {
  assert.equal(tenantPlanMemberLimit({ account_limit: 1 }), 0);
  assert.equal(tenantPlanMemberLimit({ account_limit: 3 }), 2);
  assert.equal(tenantPlanMemberLimit({ account_limit: null }), null);
});

test("tenant plan administration remains platform-admin only", () => {
  assert.equal(authorizeApiRequest({ method: "GET", _session: { roles: ["admin"] } }, ["api", "tenants", "plans"]).allowed, true);
  assert.equal(authorizeApiRequest({ method: "POST", _session: { roles: ["operations"], tenant: { id: 2, role: "owner" } } }, ["api", "tenants", "plans"]).allowed, false);
});

test("tenant plan catalog persists presets and is wired into enterprise create and subscription flows", () => {
  const tenantService = read("../src/services/tenants.js");
  const server = read("../src/server.js");
  const view = read("../frontend/admin/views/settings/TenantSubscriptionView.vue");
  assert.match(tenantService, /CREATE TABLE IF NOT EXISTS tenant_plans/);
  assert.match(tenantService, /INSERT IGNORE INTO tenant_plans/);
  assert.match(tenantService, /UPDATE tenants SET plan_code = \?, subscription_status = \?, subscription_expires_at = \?, member_limit = \?, shop_limit = \? WHERE id = \?/);
  assert.match(tenantService, /tenantPlanMemberLimit\(plan\)/);
  assert.match(server, /GET \/api\/tenants\/plans/);
  assert.match(server, /POST \/api\/tenants\/plans/);
  assert.match(server, /PUT \/api\/tenants\/plans/);
  assert.match(view, /套餐目录/);
  assert.match(view, /tenantForm\.plan_code/);
  assert.match(view, /savePlan/);
});

test("tenant operations separate customer-space work from plan-catalog work", () => {
  const view = read("../frontend/admin/views/settings/TenantSubscriptionView.vue");
  assert.match(view, /el-tab-pane label="客户空间" name="customers"/);
  assert.match(view, /el-tab-pane label="套餐目录" name="plans"/);
  assert.match(view, /filteredRows/);
  assert.match(view, /el-drawer v-model="detailVisible"/);
  assert.match(view, /子账号用量/);
  assert.match(view, /店铺用量/);
  assert.match(view, /每个新客户空间会自动生成客户激活码/);
  assert.match(view, /不是客户购买或注册用的激活码/);
  assert.match(view, /高级接入：浏览器插件令牌/);
});

test("customer activation codes are separate, hash-only, and platform-admin managed", () => {
  const tenantService = read("../src/services/tenants.js");
  const server = read("../src/server.js");
  assert.match(tenantService, /CREATE TABLE IF NOT EXISTS tenant_activation_codes/);
  assert.match(tenantService, /createHash\("sha256"\)/);
  assert.match(tenantService, /randomBytes\(24\)/);
  assert.match(tenantService, /withMysqlTransaction\(async connection =>/);
  assert.match(tenantService, /INSERT INTO tenant_activation_codes/);
  assert.match(tenantService, /SELECT c\.id, c\.tenant_id, c\.code_hint, c\.status, c\.expires_at, c\.created_at, c\.revoked_at/);
  assert.doesNotMatch(tenantService, /SELECT[^`]*\bcode\b[^`]*FROM tenant_activation_codes/is);
  assert.match(server, /GET \/api\/tenants\/activation-code/);
  assert.match(server, /POST \/api\/tenants\/activation-code/);
  assert.match(server, /DELETE \/api\/tenants\/activation-code/);
  assert.equal(authorizeApiRequest({ method: "POST", _session: { roles: ["admin"] } }, ["api", "tenants", "activation-code"]).allowed, true);
  assert.equal(authorizeApiRequest({ method: "POST", _session: { roles: ["operations"], tenant: { id: 2, role: "owner" } } }, ["api", "tenants", "activation-code"]).allowed, false);
});

test("tenant creation reveals the activation code once and the view distinguishes it from plugin tokens", () => {
  const tenantService = read("../src/services/tenants.js");
  const view = read("../frontend/admin/views/settings/TenantSubscriptionView.vue");
  assert.match(tenantService, /return \{ ok: true, id: result, activation_code: activationCode \}/);
  assert.match(view, /完整码只显示这一次/);
  assert.match(view, /activationCodeStatus\.code_hint/);
  assert.match(view, /客户自助注册兑换将在下一步接入/);
  assert.match(view, /copyActivationCode/);
});
