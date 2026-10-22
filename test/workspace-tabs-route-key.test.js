import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { useWorkspaceTabsStore } from "../frontend/admin/stores/workspaceTabs.js";

function fixture(t) {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const values = new Map();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  } });
  const pinia = createPinia();
  setActivePinia(pinia);
  const component = { render: () => null };
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/dashboard", component, meta: { title: "Dashboard" } },
    { path: "/orders", component, meta: { title: "Orders" } },
    { path: "/procurement", component, meta: { title: "Procurement" } },
    { path: "/listing-automation", component, meta: { title: "Listing", tabKey: "workbench" } },
    { path: "/record", component, meta: { title: "Record", tabKey: "fullPath" } },
    { path: "/membership", name: "membership", component, meta: { title: "Membership" } }
  ] });
  t.after(() => {
    disposePinia(pinia);
    setActivePinia(undefined);
    if (previousStorage) Object.defineProperty(globalThis, "sessionStorage", previousStorage);
    else delete globalThis.sessionStorage;
  });
  return { router, store: useWorkspaceTabsStore(pinia) };
}

test("render identity follows the supplied route even while closing changes the active tab", t => {
  const { router, store } = fixture(t);
  const orders = router.resolve("/orders?shopId=42"), procurement = router.resolve("/procurement");
  store.openRoute(router.resolve("/dashboard"));
  store.openRoute(orders);
  store.openRoute(procurement);
  assert.equal(store.closeTab("/procurement"), "/orders?shopId=42");
  assert.equal(store.activeKey, "/orders");
  assert.equal(store.tabKeyForRoute(procurement), "/procurement");
  assert.equal(store.tabKeyForRoute(orders), "/orders");
});

test("retired membership tabs are pruned even when active or pinned without changing business queries", t => {
  const { router, store } = fixture(t);
  sessionStorage.setItem("ozon-admin-workspace-tabs", JSON.stringify({ activeKey: "/membership", tabs: [
    { key: "/orders", route: { path: "/orders", fullPath: "/orders?shopId=42&search=retained" } },
    { key: "/membership", pinned: true, closable: false, route: { path: "/membership", fullPath: "/membership?denied=activation", name: "membership" } }
  ] }));
  store.restoreTabs(router);
  assert.equal(store.tabs.length, 1);
  assert.equal(store.activeKey, "/orders");
  assert.equal(store.activeTab.route.fullPath, "/orders?shopId=42&search=retained");
  store.openRoute(router.resolve("/membership"));
  assert.equal(store.tabs.length, 1);
  const saved = JSON.parse(sessionStorage.getItem("ozon-admin-workspace-tabs"));
  assert.equal(saved.tabs.some(tab => tab.route.path === "/membership"), false);
});

test("render keys preserve path, workbench and normalized full-path query identities", t => {
  const { router, store } = fixture(t);
  for (const [url, expected] of [
    ["/orders?shopId=42", "/orders"],
    ["/listing-automation?workbenchId=two&draftId=7&tabTitle=Draft", "/listing-automation?workbenchId=two"],
    ["/listing-automation?draftId=7", "/listing-automation"],
    ["/record?z=last&recordId=7&tabTitle=First&title=Second", "/record?recordId=7&z=last"],
    ["/record?recordId=8", "/record?recordId=8"]
  ]) {
    const route = router.resolve(url);
    store.openRoute(route);
    assert.equal(store.activeKey, expected);
    assert.equal(store.tabKeyForRoute(route), expected);
    assert.equal(store.activeTab.route.fullPath, route.fullPath);
  }
});
