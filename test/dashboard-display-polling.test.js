import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";
import { createDisplayReadScope } from "../frontend/admin/utils/display-read-scope.js";
import { dashboardForSession, canViewDashboardFinance } from "../src/shared/dashboard-visibility.js";
import { mergeDashboardSections } from "../src/shared/dashboard-sections.js";

const source = readFileSync(new URL("../frontend/admin/views/DashboardView.vue", import.meta.url), "utf8").match(/<script setup>([\s\S]*?)<\/script>/)[1];
const imports = parse(source, { sourceType: "module", ecmaVersion: "latest" }).body.filter(node => node.type === "ImportDeclaration");
let body = source;
for (const node of [...imports].reverse()) body = body.slice(0, node.start) + body.slice(node.end);
const turn = () => new Promise(resolve => setImmediate(resolve));
function events(extra = {}) {
  const listeners = new Map();
  return { ...extra, addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    emit(name) { for (const callback of listeners.get(name) || []) callback({ type: name }); },
    listenerCount: () => [...listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0) };
}
function fixture({ hidden = false, get } = {}) {
  const hooks = {}, timers = new Map(), requests = [], errors = [];
  let timer = 0, scope = "tenant-A", revision = "r1", building = true;
  const window = events({ setTimeout(callback, delay) { const id = ++timer; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); } });
  const document = events({ visibilityState: hidden ? "hidden" : "visible" });
  const context = Object.fromEntries(imports.flatMap(node => node.specifiers.map(specifier => [specifier.local.name, () => {}])));
  Object.assign(context, { window, document, AbortController, DOMException, URLSearchParams, Date, console: { error() {} },
    ref: value => ({ value }), computed: read => Object.defineProperty({}, "value", { get: read }),
    onMounted: callback => { hooks.mount = callback; }, onActivated: callback => { hooks.activate = callback; },
    onDeactivated: callback => { hooks.deactivate = callback; }, onBeforeUnmount: callback => { hooks.dispose = callback; },
    useRoute: () => ({ path: "/dashboard", query: {} }), useRouter: () => ({ replace: async () => {} }),
    useAuthStore: () => ({ user: { personId: 7, tenant: { id: 2, role: "member" }, roles: ["finance"] } }),
    dashboardForSession, canViewDashboardFinance, mergeDashboardSections, createDisplayReadScope,
    shanghaiDateKey: () => "2026-11-27", currentApiCacheScope: () => scope, getAuthToken: () => "fixture-session",
    clearTimeout: id => timers.delete(id), setTimeout: window.setTimeout,
    ElMessage: { error: message => errors.push(message), warning() {} },
    apiClient: { get: async (url, options) => {
      const request = { url, options }; requests.push(request);
      if (get) { const response = await get(request); if (response !== undefined) return response; }
      if (!url.startsWith("/api/dashboard?")) return { rows: [], summary: {} };
      const snapshot = { status: building ? "building" : "snapshot", revision, date_key: "2026-11-27" };
      return url.includes("statusOnly=1") ? { status_only: true, snapshot }
        : { snapshot, commerce: { today: { effective_orders: revision === "r1" ? 4 : 8 } }, summary: {}, alerts: {} };
    } }
  });
  vm.createContext(context);
  vm.runInContext(body + "\nglobalThis.view={loadDashboard,refreshDashboard,dashboard,loading,hasDashboardLoaded,loadOverviewPanels};", context);
  return { view: context.view, hooks, timers, requests, errors,
    async mount() { hooks.mount(); hooks.activate(); await turn(); },
    async hide() { document.visibilityState = "hidden"; document.emit("visibilitychange"); await turn(); },
    async show() { document.visibilityState = "visible"; document.emit("visibilitychange"); await turn(); },
    async runTimer() { const [id, scheduled] = timers.entries().next().value || []; assert.ok(scheduled); timers.delete(id); scheduled.callback(); await turn(); },
    async emit(name) { window.emit(name); await turn(); },
    setResult(next, isBuilding = false) { revision = next; building = isBuilding; },
    changeScope(value) { scope = value; },
    async dispose() { hooks.dispose(); await turn(); assert.equal(window.listenerCount() + document.listenerCount(), 0); }
  };
}

test("dashboard preserves early metrics, polls only status and loads full metrics when revision changes", async () => {
  const page = fixture(); await page.mount();
  const fullReads = () => page.requests.filter(request => request.url.startsWith("/api/dashboard?") && !request.url.includes("statusOnly=1"));
  assert.equal(fullReads().length, 1, "mount and KeepAlive activation share the initial visit");
  assert.equal(page.view.dashboard.value.commerce.today.effective_orders, 4);
  await page.runTimer();
  assert.equal(fullReads().length, 1);
  assert.equal(page.requests.filter(request => request.url.includes("statusOnly=1")).length, 1);
  page.setResult("r2"); await page.runTimer();
  assert.equal(fullReads().length, 2);
  assert.equal(page.view.dashboard.value.commerce.today.effective_orders, 8);
  assert.equal(page.timers.size, 0);
  await page.dispose();
});

test("dashboard pauses both core and auxiliary reads while hidden/deactivated and catches up on activation", async () => {
  const page = fixture({ hidden: true }); await page.mount();
  assert.equal(page.requests.length, 0);
  await page.show(); const visibleReads = page.requests.length;
  await page.hide(); assert.equal(page.timers.size, 0);
  await page.view.loadDashboard(); await page.view.loadOverviewPanels();
  assert.equal(page.requests.length, visibleReads);
  page.hooks.deactivate(); await page.show(); assert.equal(page.requests.length, visibleReads);
  page.hooks.activate(); await turn(); assert.ok(page.requests.length > visibleReads);
  await page.dispose(); assert.equal(page.timers.size, 0);
});

test("dashboard aborts departing display reads and cannot apply a late result or restart polling", async () => {
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const page = fixture({ get: ({ url }) => url.startsWith("/api/dashboard?") ? pending : undefined });
  await page.mount(); const request = page.requests[0];
  page.hooks.deactivate(); assert.equal(request.options.signal.aborted, true);
  complete({ snapshot: { status: "building", revision: "late" }, commerce: { today: { effective_orders: 99 } } });
  await turn();
  assert.equal(page.view.dashboard.value.commerce.today.effective_orders, undefined);
  assert.equal(page.timers.size, 0); assert.equal(page.view.loading.value, false);
  await page.dispose();
});

for (const status of [401, 403]) test(`dashboard HTTP ${status} stops polling until a successful identity verification`, async () => {
  let allowed = false;
  const page = fixture({ get: ({ url }) => { if (!allowed && url.startsWith("/api/dashboard?")) throw Object.assign(new Error("fixture access rejected"), { status }); } });
  await page.mount(); assert.equal(page.requests.length, 1); assert.equal(page.timers.size, 0);
  await page.hide(); await page.show(); page.hooks.deactivate(); page.hooks.activate();
  await page.view.loadDashboard(); await turn(); assert.equal(page.requests.length, 1);
  allowed = true; await page.emit("erp:auth-verified");
  assert.equal(page.view.dashboard.value.commerce.today.effective_orders, 4);
  assert.ok(page.requests.length > 1);
  await page.dispose();
});

for (const endpoint of ["/api/online-products/limits", "/api/profit-ranking", "/api/fbp-opportunities"]) {
  test(`a forbidden optional ${endpoint} read pauses only that resource, preserving the authorized dashboard`, async () => {
    let allowed = false;
    const page = fixture({ get: ({ url }) => {
      if (!allowed && url.split("?")[0] === endpoint) throw Object.assign(new Error("fixture optional role not granted"), { status: 403 });
    } });
    await page.mount();
    const deniedCalls = () => page.requests.filter(request => request.url.split("?")[0] === endpoint).length;
    assert.equal(deniedCalls(), 1);
    assert.equal(page.view.dashboard.value.commerce.today.effective_orders, 4);
    await page.view.loadOverviewPanels();
    assert.equal(deniedCalls(), 1, "visibility or manual refresh cannot retry a denied resource without verification");
    await page.runTimer();
    assert.ok(page.requests.some(request => request.url.includes("statusOnly=1")), "core snapshot polling continues");
    allowed = true; await page.emit("erp:auth-verified");
    assert.equal(deniedCalls(), 2);
    page.setResult("r2"); await page.runTimer();
    assert.equal(page.view.dashboard.value.commerce.today.effective_orders, 8);
    await page.dispose();
  });
}
