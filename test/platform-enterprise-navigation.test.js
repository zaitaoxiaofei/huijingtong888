import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { canAccessPage } from "../src/shared/permissions.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const navSource = read("../frontend/admin/constants/navigation.js").replace(/^import .*;\r?\n/gm, "").replaceAll("export ", "");
const icons = Object.fromEntries(["ChatDotRound", "Coin", "DataAnalysis", "Document", "Finished", "Goods", "House", "MagicStick", "Setting", "ShoppingCart", "Tools", "WarningFilled"].map((name) => [name, name]));
const nav = vm.createContext({ ...icons, canAccessPage });
vm.runInContext(navSource, nav);
const routesFor = (subject) => nav.navigationMenusForRole(subject).flatMap((group) => group.children || [group]).map((item) => item.route);

test("platform-only and enterprise-only identities receive separate navigation, while dual roles receive both", () => {
  const platform = { platform_role: "super_admin", roles: ["admin"], tenant: null };
  const enterprise = { roles: ["admin"], tenant: { id: 42, slug: "company-a", role: "owner" } };
  const dual = { ...enterprise, platform_role: "super_admin" };
  for (const route of ["/platform-accounts", "/tenant-management", "/order-cancellation-rules", "/settings/scheduled-jobs", "/settings/system-monitoring", "/settings/ai", "/ai-prompts"]) {
    assert.ok(routesFor(platform).includes(route), route);
    assert.ok(!routesFor(enterprise).includes(route), route);
    assert.ok(routesFor(dual).includes(route), route);
  }
  for (const route of ["/tenant-shops", "/tenant-people", "/asset-variant-center"]) {
    assert.ok(!routesFor(platform).includes(route), route);
    assert.ok(routesFor(enterprise).includes(route), route);
    assert.ok(routesFor(dual).includes(route), route);
  }
  const group = nav.navigationMenusForRole(enterprise).find((item) => item.key === "tenant-shops");
  assert.equal(group.label, "企业店铺");
  assert.deepEqual([...group.children.map((item) => item.route)], ["/tenant-shops", "/tenant-people", "/logistics-settings"]);
  const operator = { roles: ['operations'], tenant: { id: 42, slug: 'company-a', role: 'member' } };
  assert.ok(routesFor(operator).includes('/asset-variant-center'));
  assert.ok(!routesFor(operator).includes('/tenant-people'));
  assert.ok(!routesFor(operator).includes('/tenant-shops'));
  assert.ok(nav.navigationMenusForRole(operator).find(item => item.key === 'ai-skills').children.some(item => item.route === '/asset-variant-center'));
  assert.ok(routesFor(operator).includes('/ai-materials'));
  assert.ok(!routesFor(operator).includes('/ai-prompts'));
  assert.ok(routesFor(operator).includes('/tools/packaging-fee-rule'));
});

test("shared settings use focused pages and legacy exchange settings no longer expose a CRUD view", () => {
  const source = read("../frontend/admin/views/settings/SettingsView.vue");
  assert.doesNotMatch(source, /汇率设置|最近变更|recalculate-historical|rateForm/);
  const packaging = read("../frontend/admin/views/tools/PackagingFeeRuleView.vue");
  assert.match(packaging, /包装费规则/);
  assert.doesNotMatch(packaging, /最近变更|recalculate-historical/);
  const roster = read("../frontend/admin/views/settings/PlatformAccountsView.vue");
  assert.match(roster, /apiClient\.get\("\/api\/platform\/accounts"/);
  assert.doesNotMatch(roster, /apiClient\.(post|put|delete)|["'`]\/api\/people/);
  const router = read("../frontend/admin/router/index.js");
  assert.match(router, /path: "tenant-people".*component: EnterprisePersonnelPanel/);
  assert.match(router, /path: "platform-accounts".*component: PlatformAccountsView/);
  assert.match(router, /path: "ai-materials".*component: MaterialCenterView/);
  assert.match(router, /path: "ai-prompts".*component: AiPromptLibraryView/);
  assert.match(router, /rates: "\/dashboard"/);
  assert.match(router, /path: "tools\/packaging-fee-rule".*component: PackagingFeeRuleView/);
  assert.match(router, /path: "logistics-settings".*section: "logistics"/);
  assert.match(router, /path: "order-cancellation-rules".*section: "cancel"/);
});
