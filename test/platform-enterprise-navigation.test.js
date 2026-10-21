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
  for (const route of ["/platform-accounts", "/tenant-management", "/settings", "/settings/scheduled-jobs", "/settings/system-monitoring", "/settings/ai", "/settings/prompts"]) {
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
  assert.deepEqual([...group.children.map((item) => item.route)], ["/tenant-shops", "/tenant-people", "/asset-variant-center"]);
});

test("global settings expose only shared-rule tabs and platform roster is read-only", () => {
  const source = read("../frontend/admin/views/settings/SettingsView.vue");
  const tabs = vm.runInNewContext(source.match(/const sectionOptions = (\[[\s\S]*?\n\]);/)[1]);
  assert.deepEqual([...tabs.map((item) => item.key)], ["rates", "profit", "logistics", "cancel"]);
  assert.match(source, /const activeSection = ref\("rates"\)/);
  const roster = read("../frontend/admin/views/settings/PlatformAccountsView.vue");
  assert.match(roster, /apiClient\.get\("\/api\/platform\/accounts"/);
  assert.doesNotMatch(roster, /apiClient\.(post|put|delete)|["'`]\/api\/people/);
  const router = read("../frontend/admin/router/index.js");
  assert.match(router, /path: "tenant-people".*component: EnterprisePersonnelPanel/);
  assert.match(router, /path: "platform-accounts".*component: PlatformAccountsView/);
});
