import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createMemoryHistory, createRouter } from "vue-router";
import { canAccessPage, hasPermission, isPlatformAdmin, needsMembershipActivation } from "../src/shared/permissions.js";

const read = path => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const moduleBody = source => source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const employee = { id: 7, roles: ["operations"], tenant: { id: 1, slug: "default", role: "member" } };

function routerFixture(user = employee) {
  const auth = { user, isAuthenticated: true, bootstrap: async () => {} };
  const withStubComponents = routes => routes.map(route => ({ ...route,
    ...(route.component ? { component: {} } : {}),
    ...(route.children ? { children: withStubComponents(route.children) } : {})
  }));
  const context = vm.createContext({
    canAccessPage, hasPermission, isPlatformAdmin, needsMembershipActivation,
    membershipDialogRequest: { value: null }, requestMembershipDialog() {},
    createRouter: options => createRouter({ ...options, routes: withStubComponents(options.routes) }),
    createWebHashHistory: createMemoryHistory,
    AdminLayout: {}, MobileLayout: {}, LoginView: {}, useAuthStore: () => auth,
    markRouteReadyPerf() {}, startRoutePerf() {}, document: { title: "" },
    window: { matchMedia: () => ({ matches: false }), navigator: { userAgent: "fixture-desktop" }, localStorage: { getItem: () => null } }
  });
  vm.runInContext(`${moduleBody(read("../frontend/admin/router/index.js"))}\nglobalThis.actualRouter = router;`, context);
  return context.actualRouter;
}

function tabsFixture() {
  const values = new Map();
  const sessionStorage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const context = vm.createContext({
    sessionStorage, navigationIconByRoute: new Map(), markRaw: value => value,
    ref: value => ({ value }), computed: get => ({ get value() { return get(); } }), defineStore: (_name, create) => create
  });
  vm.runInContext(`${moduleBody(read("../frontend/admin/stores/workspaceTabs.js"))}\nglobalThis.tabsStore = useWorkspaceTabsStore();`, context);
  return { store: context.tabsStore, sessionStorage };
}

test("removed onboarding navigation and orphan frontend files stay absent while ordinary navigation remains", () => {
  const icons = Object.fromEntries("ChatDotRound Coin DataAnalysis Document Finished Goods House MagicStick Setting ShoppingCart Tools WarningFilled".split(" ").map(name => [name, name]));
  const context = vm.createContext({ ...icons, canAccessPage });
  vm.runInContext(moduleBody(read("../frontend/admin/constants/navigation.js")), context);
  const routes = context.navigationMenusForRole(employee).flatMap(menu => menu.children || [menu]).map(item => item.route);
  assert.equal(routes.includes("/onboarding"), false);
  for (const route of ["/dashboard", "/team-plan", "/orders", "/selection"]) assert.equal(routes.includes(route), true, route);
  assert.equal(fs.existsSync(new URL("../frontend/admin/views/onboarding/OnboardingKnowledgeView.vue", import.meta.url)), false);
  assert.equal(fs.existsSync(new URL("../frontend/admin/api/onboardingKnowledge.js", import.meta.url)), false);
});

test("legacy onboarding links redirect to an accessible home without reviving their saved title or article query", async () => {
  for (const [user, home] of [[employee, "/dashboard"], [{ id: 1, roles: [], platform_role: "super_admin", tenant: null }, "/platform-accounts"]]) {
    const router = routerFixture(user);
    assert.equal(router.hasRoute("onboarding"), false);
    await router.push("/onboarding?tabTitle=Old%20onboarding%20tab&article=3#history");
    assert.equal(router.currentRoute.value.path, home);
    assert.equal(Object.hasOwn(router.currentRoute.value.query, "tabTitle"), false);
    assert.equal(Object.hasOwn(router.currentRoute.value.query, "article"), false);
    assert.equal(router.currentRoute.value.hash, "");
  }
});

test("cached onboarding tabs are pruned even when pinned or active, preserving other tab routes and state", () => {
  const router = routerFixture();
  const { store, sessionStorage } = tabsFixture();
  const route = fullPath => { const value = router.resolve(fullPath); return { path: value.path, fullPath, name: value.name, meta: value.meta, query: value.query }; };
  sessionStorage.setItem("ozon-admin-workspace-tabs", JSON.stringify({ activeKey: "/onboarding", tabs: [
    { key: "/dashboard", title: "Home", pinned: true, closable: false, route: route("/dashboard") },
    { key: "/orders", title: "Orders", pinned: false, closable: true, route: route("/orders?status=awaiting_packaging") },
    { key: "/onboarding", title: "Old onboarding tab", pinned: true, closable: true, route: { path: "/onboarding", fullPath: "/onboarding?article=3", name: "onboarding", meta: { title: "Old onboarding tab" } } }
  ] }));
  store.restoreTabs(router);
  assert.deepEqual(Array.from(store.tabs.value, tab => tab.key), ["/dashboard", "/orders"]);
  assert.equal(store.activeKey.value, "/orders");
  assert.equal(store.tabs.value[0].pinned, true);
  assert.equal(store.tabs.value[1].route.query.status, "awaiting_packaging");
  const persisted = JSON.parse(sessionStorage.getItem("ozon-admin-workspace-tabs"));
  assert.deepEqual(persisted.tabs.map(tab => tab.title), ["Home", "Orders"]);
  assert.equal(persisted.activeKey, "/orders");
  store.openRoute(router.resolve("/onboarding?article=3"));
  store.openRoute(router.resolve("/onboarding/"));
  assert.equal(store.tabs.value.length, 2);
  assert.equal(store.activeKey.value, "/orders");
});

test("a workspace containing only removed onboarding tabs restores as empty and can open an ordinary page", () => {
  const router = routerFixture();
  const { store, sessionStorage } = tabsFixture();
  sessionStorage.setItem("ozon-admin-workspace-tabs", JSON.stringify({ activeKey: "/onboarding/", tabs: [
    { key: "/onboarding/", pinned: true, route: { path: "/onboarding/", fullPath: "/onboarding/?article=3", name: "onboarding", meta: {} } }
  ] }));
  store.restoreTabs(router);
  assert.equal(store.tabs.value.length, 0);
  assert.equal(store.activeKey.value, "");
  assert.deepEqual(JSON.parse(sessionStorage.getItem("ozon-admin-workspace-tabs")).tabs, []);
  store.openRoute(router.resolve("/orders"));
  assert.equal(store.tabs.value.length, 1);
  assert.equal(store.activeKey.value, "/orders");
});

test("onboarding mutations require manager role and record session identity", () => {
  const authorization = fs.readFileSync(new URL("../src/server/authorization.js", import.meta.url), "utf8");
  const routes = fs.readFileSync(new URL("../src/server/routes/onboardingKnowledge.js", import.meta.url), "utf8");
  const service = fs.readFileSync(new URL("../src/services/onboarding-knowledge.js", import.meta.url), "utf8");
  assert.match(authorization, /resource === "onboarding"/);
  assert.match(authorization, /require\("onboarding.edit"\)/);
  assert.match(routes, /req\._session/);
  assert.match(service, /onboarding_article_versions/);
  assert.match(service, /changed_by_person_id/);
  assert.match(service, /updated_by_person_id/);
});

test("knowledge seed includes the GUOO and CEL packing standard", () => {
  const service = fs.readFileSync(new URL("../src/services/onboarding-knowledge.js", import.meta.url), "utf8");
  assert.match(service, /GUOO \/ CEL 报价与打包发货标准/);
  assert.match(service, /包装完成后的实际重量/);
  assert.match(service, /H 型封箱/);
  assert.match(service, /GUOO 禁运红线/);
  assert.match(service, /CEL产品资费表 V7\.24/);
});
