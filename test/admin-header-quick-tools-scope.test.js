import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { computed, effectScope, reactive, ref, watch } from "vue";
import { canAccessPage } from "../src/shared/permissions.js";

const layout = readFileSync(new URL("../frontend/admin/layouts/AdminLayout.vue", import.meta.url), "utf8");
const quickTools = layout.match(/const quickToolsVisible =[\s\S]*?(?=\nconst densityLabel =)/)[0];
const mounted = layout.match(/onMounted\(\(\) => \{[\s\S]*?\n\}\);/)[0];
const beforeUnmount = layout.match(/onBeforeUnmount\(\(\) => \{[\s\S]*?\n\}\);/)[0];
const api = readFileSync(new URL("../frontend/admin/utils/api.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "")
  .replace(/^export /gm, "");

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

function fixture(t, user = { id: 10, roles: ["operator"], tenant: { id: 1, slug: "default", role: "member" } }) {
  const listeners = new Map(), hooks = { mounted: [], beforeUnmount: [] };
  const noop = () => {};
  const window = {
    localStorage: storage(), sessionStorage: storage(),
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); },
    matchMedia: () => ({ addEventListener: noop, removeEventListener: noop }),
    setInterval: () => 1, clearInterval: noop, clearTimeout: noop
  };
  window.localStorage.setItem("authToken", "fixture-token-a");
  window.localStorage.setItem("baodanAuthUser", JSON.stringify(user));
  const authStore = reactive({ user });
  const context = vm.createContext({
    window, AbortController, DOMException,
    CustomEvent: class { constructor(type) { this.type = type; } },
    ref, computed, watch, authStore, canAccessPage,
    onMounted: callback => hooks.mounted.push(callback),
    onBeforeUnmount: callback => hooks.beforeUnmount.push(callback),
    syncMobileViewport: noop, handleGlobalPointerDown: noop, handleWindowBlur: noop,
    handlePluginUpdate: noop, clearPluginUpdate: noop, loadNotifications: noop
  });
  vm.runInContext(`${api}\nglobalThis.api = { currentApiCacheScope, setAuthToken };`, context);
  const effects = effectScope();
  effects.run(() => vm.runInContext(`
    let mobileViewportQuery = null, notificationRefreshTimer = 0, routeSwitchTimer = 0;
    ${quickTools}
    ${mounted}
    ${beforeUnmount}
    globalThis.tools = { quickToolScope, quickToolsVisible, quickToolsMounted, openQuickTool };
  `, context));
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    hooks.beforeUnmount.forEach(callback => callback());
    effects.stop();
  };
  t.after(dispose);
  return {
    tools: context.tools, api: context.api, authStore, window,
    mount: () => hooks.mounted.forEach(callback => callback()),
    dispose,
    listenerCount: () => listeners.get("erp:auth-scope-changed")?.size || 0
  };
}

function assertClosed(tools) {
  assert.equal(tools.quickToolsVisible.value, false);
  assert.equal(tools.quickToolsMounted.value, false);
}

test("token-only auth scope changes synchronously close and unmount tools with the same user object", t => {
  const f = fixture(t);
  f.mount();
  const user = f.authStore.user;
  f.tools.openQuickTool("profit");
  assert.equal(f.tools.quickToolsVisible.value, true);
  assert.equal(f.tools.quickToolsMounted.value, true);
  const key = f.tools.quickToolScope.value;

  f.api.setAuthToken("fixture-token-b");

  assert.equal(f.authStore.user, user);
  assertClosed(f.tools);
  assert.notEqual(f.tools.quickToolScope.value, key);
  assert.equal(f.tools.quickToolScope.value, `10:1:${f.api.currentApiCacheScope()}`);
  f.tools.openQuickTool("pricing");
  assert.equal(f.tools.quickToolsVisible.value, true);
  assert.equal(f.tools.quickToolsMounted.value, true);
});

test("changing the active enterprise closes and unmounts tools without waiting for an API response", t => {
  const f = fixture(t);
  f.mount();
  f.tools.openQuickTool("profit");
  const key = f.tools.quickToolScope.value;

  f.authStore.user.tenant = { id: 2, slug: "company-b", role: "member" };

  assertClosed(f.tools);
  assert.notEqual(f.tools.quickToolScope.value, key);
  f.tools.openQuickTool("profit");
  assert.equal(f.tools.quickToolsVisible.value, true);
});

test("removing tool permissions closes mounted tools and prevents either opener", t => {
  const f = fixture(t);
  f.mount();
  f.tools.openQuickTool("pricing");

  f.authStore.user.roles = [];

  assertClosed(f.tools);
  for (const tool of ["profit", "pricing"]) {
    f.tools.openQuickTool(tool);
    assertClosed(f.tools);
  }
});

test("platform-only accounts without an active enterprise cannot open business calculators", t => {
  const f = fixture(t, { id: 20, platform_role: "super_admin", roles: ["operator"], tenant: null });
  f.mount();
  for (const tool of ["profit", "pricing"]) {
    f.tools.openQuickTool(tool);
    assertClosed(f.tools);
  }
});

test("the layout registers its scope listener on mount and removes it on unmount", t => {
  const f = fixture(t);
  assert.equal(f.listenerCount(), 0);
  f.mount();
  assert.equal(f.listenerCount(), 1);
  f.tools.openQuickTool("profit");
  const key = f.tools.quickToolScope.value;

  f.dispose();
  assert.equal(f.listenerCount(), 0);
  f.api.setAuthToken("fixture-token-after-unmount");
  assert.equal(f.tools.quickToolsVisible.value, true, "the removed listener no longer mutates disposed layout state");
  assert.equal(f.tools.quickToolScope.value, key);
});
