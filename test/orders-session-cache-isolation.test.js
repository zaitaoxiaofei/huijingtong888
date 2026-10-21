import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../frontend/orders/composables/useOrdersPage.js", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\r?\n/gm, "")
  .replace("export function useOrdersPage", "function useOrdersPage");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const result = (id) => ({ rows: [{ id, posting_number: `private-${id}` }], total: id, page: 1, pageSize: 20 });
const options = (label) => [{ value: "all", label: "all" }, { value: label, label }];

function harness() {
  let sessionEpoch = 1;
  const auth = { user: { id: 1, tenant: { id: 10, slug: "company-a" } } };
  const requests = [], inventoryRequests = [], allRequests = [], shops = [], watchers = [], disposers = [], timers = new Map(), listeners = new Map();
  let timerId = 0;
  const context = vm.createContext({
    AbortController, URLSearchParams, console: { warn() {} },
    currentApiCacheScope: () => String(sessionEpoch), useAuthStore: () => auth,
    reactive: (value) => value, ref: (value) => ({ value }),
    computed: (getter) => ({ get value() { return getter(); } }),
    watch: (_getter, callback) => watchers.push(callback), onScopeDispose: (callback) => disposers.push(callback),
    shanghaiDateKey: () => "2026-10-21", shanghaiDateDaysAgo: () => "2026-07-23",
    normalizePrintState: (filters) => ({ printView: filters.printView || "all", printFilter: filters.printFilter || "all", sortMode: filters.sortMode || "ordered" }),
    window: {
      addEventListener(name, listener) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(listener);
      },
      removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
      setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
      clearTimeout(id) { timers.delete(id); }
    },
    apiClient: { get(url, requestOptions) {
      const task = deferred();
      const request = { ...task, url, options: requestOptions };
      allRequests.push(request);
      // Release hydrates visible inventory independently; keep its pending reads
      // separate from the row/count/channel sequences that these tests control.
      if (url.startsWith("/api/orders/inventory-availability?")) inventoryRequests.push(request);
      else requests.push(request);
      return task.promise;
    } },
    loadShopDictionary: () => { const task = deferred(); shops.push(task); return task.promise; },
    ElMessage: { error() {} }
  });
  vm.runInContext(source, context);
  return {
    context, requests, inventoryRequests, allRequests, shops, timers,
    page: () => context.useOrdersPage(),
    switchSession(nextToken, tenant = { id: 20, slug: "company-b" }, id = 2) {
      sessionEpoch += 1;
      auth.user = nextToken ? { id, tenant } : null;
      watchers.forEach((callback) => callback());
    },
    externalScopeChange(eventName = "storage") {
      sessionEpoch += 1;
      for (const callback of listeners.get(eventName) || []) callback({ key: "authToken" });
    },
    runMetaTimer() { const callback = [...timers.values()].at(-1); timers.clear(); callback(); },
    dispose() { disposers.forEach((callback) => callback()); }
  };
}

test("orders cached rows, counts and logistics never flash for a blocked second account", async () => {
  const h = harness();
  const first = h.page();
  const loadA = first.loadOrders();
  h.requests[0].resolve(result(11));
  h.shops[0].resolve([{ id: 10, name: "A-shop" }]);
  await loadA;
  h.context.writeOrdersMetaCache(first.vm.filters, { all: 11 });
  const logisticsA = first.loadLogisticsOptions();
  h.requests[1].resolve({ logisticsServiceClassOptions: options("A-private-logistics") });
  await logisticsA;
  first.selectedOrderIds.value.add(11);

  h.switchSession("session-B");
  assert.equal(first.vm.rows.length, 0);
  assert.equal(first.selectedOrderIds.value.size, 0);
  assert.equal(vm.runInContext("logisticsOptionsCache.size", h.context), 0);
  assert.ok(!first.vm.logisticsServiceClassOptions.some((item) => item.label === "A-private-logistics"));
  const second = h.page();
  const loadB = second.loadOrders();
  assert.equal(second.vm.rows.length, 0);
  assert.equal(second.vm.meta.total, 0);
  assert.equal(Object.keys(second.vm.meta.counts).length, 0);
  assert.equal(h.context.readOrdersMetaCache(second.vm.filters), null);
  assert.ok(!second.vm.logisticsServiceClassOptions.some((item) => item.label === "A-private-logistics"));
  h.requests[2].reject(Object.assign(new Error("blocked B"), { status: 403 }));
  await assert.rejects(loadB, /blocked B/);
  assert.equal(second.vm.rows.length, 0);
  assert.equal(second.vm.shops.length, 0);
});

test("same-token tenant changes and same-tenant session rotations invalidate orders", async (t) => {
  for (const [name, nextToken, nextTenant, nextPerson] of [
    ["tenant switch", "session-A", { id: 20, slug: "company-b" }, 1],
    ["new login session", "session-A-renewed", { id: 10, slug: "company-a" }, 1],
    ["logout", "", null, null]
  ]) {
    await t.test(name, async () => {
      const h = harness();
      const page = h.page();
      const loading = page.loadOrders();
      h.requests[0].resolve(result(11));
      await loading;
      h.context.writeOrdersMetaCache(page.vm.filters, { all: 11 });
      h.switchSession(nextToken, nextTenant, nextPerson);
      assert.equal(page.vm.rows.length, 0);
      assert.equal(page.vm.meta.total, 0);
      assert.equal(h.context.readOrdersMetaCache(page.vm.filters), null);
    });
  }
});

test("late A rows cannot replace B rows or repopulate the B cache even when transport ignores abort", async () => {
  const h = harness();
  const first = h.page();
  const loadingA = first.loadOrders();
  h.switchSession("session-B");
  const second = h.page();
  const loadingB = second.loadOrders();
  h.requests[1].resolve(result(22));
  await loadingB;
  h.requests[0].resolve(result(11));
  await loadingA;
  assert.equal(first.vm.rows.length, 0);
  assert.equal(second.vm.rows[0].id, 22);
  const third = h.page();
  const loadingAgain = third.loadOrders();
  assert.equal(third.vm.rows[0].id, 22);
  h.requests[2].resolve(result(22));
  await loadingAgain;
  assert.ok(vm.runInContext("[...ordersListCache.keys()].every(key => !key.includes('session-'))", h.context));
});

test("late A metadata and dictionary callbacks cannot overwrite B page state", async () => {
  const h = harness();
  const page = h.page();
  const loadingA = page.loadOrders();
  h.requests[0].resolve(result(11));
  await loadingA;
  h.runMetaTimer();
  h.switchSession("session-B");
  const loadingB = page.loadOrders();
  h.requests[2].resolve(result(22));
  await loadingB;
  h.runMetaTimer();
  h.shops[1].resolve([{ id: 20, name: "B-shop" }]);
  h.shops[0].resolve([{ id: 10, name: "A-private-shop" }]);
  h.requests[1].resolve({ counts: { all: 999 } });
  h.requests[3].resolve({ counts: { all: 22 } });
  await flush();
  assert.equal(page.vm.rows[0].id, 22);
  assert.equal(page.vm.shops[0].name, "B-shop");
  assert.equal(page.vm.meta.counts.all, 22);
  assert.equal(page.vm.meta.total, 22);
  assert.equal(h.context.readOrdersMetaCache(page.vm.filters).all, 22);
});

test("old logistics completion cannot clear or reuse B's pending logistics request", async () => {
  const h = harness();
  const page = h.page();
  const logisticsA = page.loadLogisticsOptions();
  h.switchSession("session-B");
  const logisticsB = page.loadLogisticsOptions();
  assert.equal(h.requests.length, 2);
  h.requests[0].resolve({ logisticsServiceClassOptions: options("A-private-logistics") });
  await logisticsA;
  const samePendingB = page.loadLogisticsOptions();
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve({ logisticsServiceClassOptions: options("B-logistics") });
  await Promise.all([logisticsB, samePendingB]);
  assert.equal(page.vm.logisticsServiceClassOptions[1].label, "B-logistics");
  await page.loadLogisticsOptions();
  assert.equal(h.requests.length, 2);
});

test("same-session paging keeps cached first paint and metadata reuse without exposing token keys", async () => {
  const h = harness();
  const first = h.page();
  const loading = first.loadOrders();
  h.requests[0].resolve(result(11));
  await loading;
  h.context.writeOrdersMetaCache(first.vm.filters, { all: 11 });
  const second = h.page();
  const loadingAgain = second.loadOrders();
  assert.equal(second.vm.rows[0].id, 11);
  assert.equal(h.context.readOrdersMetaCache({ ...second.vm.filters, page: 2, pageSize: 50 }).all, 11);
  assert.ok(!h.requests[1].url.includes("session-A"));
  h.requests[1].resolve(result(11));
  await loadingAgain;
});

test("an old metadata timer cannot start a request under the next account", async () => {
  const h = harness();
  const page = h.page();
  const loading = page.loadOrders();
  h.requests[0].resolve(result(11));
  await loading;
  const staleTimer = [...h.timers.values()][0];
  h.switchSession("session-B");
  staleTimer();
  assert.equal(h.requests.length, 1);
});

test("external auth scope and storage events clear visible orders even before the auth store refreshes", async (t) => {
  for (const eventName of ["storage", "erp:auth-scope-changed"]) {
    await t.test(eventName, async () => {
      const h = harness();
      const page = h.page();
      const loading = page.loadOrders();
      h.requests[0].resolve(result(11));
      await loading;
      h.externalScopeChange(eventName);
      assert.equal(page.vm.rows.length, 0);
      assert.equal(page.vm.meta.total, 0);
    });
  }
});

test("visible inventory hydrates after rows without waiting for metadata and reaches the scoped row cache", async () => {
  const h = harness();
  const page = h.page();
  const loading = page.loadOrders();
  assert.equal(h.requests.length, 1);
  assert.equal(h.inventoryRequests.length, 0);
  h.requests[0].resolve(result(11));
  await loading;
  assert.equal(page.vm.rows[0].id, 11);
  assert.equal(page.loading.value, false);
  assert.equal(h.inventoryRequests.length, 1, "the list does not await its inventory request");
  assert.equal(new URLSearchParams(h.inventoryRequests[0].url.split("?")[1]).get("orderIds"), "11");
  assert.equal(h.inventoryRequests[0].options.noCache, true);
  h.runMetaTimer();
  const metaParams = new URLSearchParams(h.requests[1].url.split("?")[1]);
  assert.equal(metaParams.get("includeCounts"), "1");
  assert.equal(metaParams.get("includeRows"), "0");
  const inventory = [{ product_id: 71, local_quantity: 4 }];
  h.inventoryRequests[0].resolve({ rows: [{ order_id: 11, inventory_availability: inventory }] });
  await flush();
  assert.equal(page.vm.rows[0].inventory_availability[0].local_quantity, 4);
  assert.equal(page.vm.meta.total, 11, "inventory never changes pagination or counts");
  const cached = h.page();
  const reload = cached.loadOrders();
  assert.equal(cached.vm.rows[0].inventory_availability[0].local_quantity, 4, "cached first paint keeps the hydrated inventory");
  h.requests[2].resolve(result(11));
  await reload;
  assert.equal(h.inventoryRequests.length, 2);
  assert.ok(h.allRequests.every((request) => !request.url.includes("session-")));
});

test("late A inventory cannot overwrite B's same-ID row or repopulate its scoped cache", async () => {
  const h = harness();
  const page = h.page();
  const loadingA = page.loadOrders();
  h.requests[0].resolve(result(11));
  await loadingA;
  const inventoryA = h.inventoryRequests[0];
  h.switchSession("session-B");
  assert.equal(inventoryA.options.signal.aborted, true);
  const loadingB = page.loadOrders();
  h.requests[1].resolve(result(11)); // Deliberately share an ID to expose an unsafe late merge.
  await loadingB;
  h.inventoryRequests[1].resolve({ rows: [{ order_id: 11, inventory_availability: [{ product_id: 72, note: "B-stock" }] }] });
  await flush();
  inventoryA.resolve({ rows: [{ order_id: 11, inventory_availability: [{ product_id: 71, note: "A-private-stock" }] }] });
  await flush();
  assert.equal(page.vm.rows[0].inventory_availability[0].note, "B-stock");
  assert.equal(vm.runInContext("JSON.stringify([...ordersListCache.values()]).includes('A-private-stock')", h.context), false);
  const cachedB = h.page();
  const reloadB = cachedB.loadOrders();
  assert.equal(cachedB.vm.rows[0].inventory_availability[0].note, "B-stock");
  h.requests[2].resolve(result(11));
  await reloadB;
});

test("logistics Map caches each release filter and clears every entry and visible private option on scope changes", async () => {
  const h = harness();
  const page = h.page();
  const initial = page.loadLogisticsOptions();
  h.requests[0].resolve({ logisticsServiceClassOptions: options("A-default-filter") });
  await initial;
  page.vm.filters.logisticsCarrier = "ogl";
  page.vm.filters.logisticsServiceClass = "small";
  page.vm.filters.page = 4;
  const ogl = page.loadLogisticsOptions();
  const params = new URLSearchParams(h.requests[1].url.split("?")[1]);
  assert.equal(params.get("logisticsCarrier"), "ogl");
  assert.equal(params.get("logisticsServiceClass"), "all");
  assert.equal(params.get("logisticsMethod"), "all");
  assert.equal(params.get("page"), "1");
  h.requests[1].resolve({ logisticsServiceClassOptions: options("A-OGL-filter") });
  await ogl;
  assert.equal(vm.runInContext("logisticsOptionsCache.size", h.context), 2);
  await page.loadLogisticsOptions();
  assert.equal(h.requests.length, 2);
  h.switchSession("session-B");
  assert.equal(vm.runInContext("logisticsOptionsCache.size", h.context), 0);
  assert.equal(page.vm.logisticsServiceClassOptions.length, 7);
  assert.ok(!page.vm.logisticsServiceClassOptions.some((option) => option.label.startsWith("A-")));
  const reload = page.loadLogisticsOptions();
  assert.equal(h.requests.length, 3, "same-filter options must be read again under B");
  h.requests[2].resolve({ logisticsServiceClassOptions: options("B-OGL-filter") });
  await reload;
  assert.equal(page.vm.logisticsServiceClassOptions[1].label, "B-OGL-filter");
});

test("disposing an order view aborts inventory hydration even when its transport completes later", async () => {
  const h = harness();
  const page = h.page();
  const loading = page.loadOrders();
  h.requests[0].resolve(result(11));
  await loading;
  h.dispose();
  assert.equal(h.inventoryRequests[0].options.signal.aborted, true);
  h.inventoryRequests[0].resolve({ rows: [{ order_id: 11, inventory_availability: [{ note: "late-stock" }] }] });
  await flush();
  assert.equal(page.vm.rows[0].inventory_availability, undefined);
});
