import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let server, useOrdersPage, fetchHandler;
const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const row = id => ({ id, procurement_coverage: null, marker: `order-${id}` });

before(async () => {
  await import("element-plus");
  const storage = { getItem: key => key === "erpPerfMonitor" ? "off" : null, setItem() {}, removeItem() {} };
  globalThis.window = { location: { hash: "#/orders", pathname: "/admin.html" }, localStorage: storage, sessionStorage: storage,
    addEventListener() {}, setTimeout: () => 1, clearTimeout() {} };
  globalThis.fetch = (url, options) => fetchHandler(String(url), options);
  server = await createServer({ configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false }, appType: "custom" });
  ({ useOrdersPage } = await server.ssrLoadModule("/frontend/orders/composables/useOrdersPage.js"));
});
after(async () => { await server?.close(); globalThis.window = previousWindow; globalThis.fetch = previousFetch; });

test("cold list paints before one batched inventory request, then hydrates zero values without allocation", async () => {
  const pending = deferred(), calls = [];
  fetchHandler = async (url, options) => {
    if (url === "/api/shops") return json([]);
    if (url.startsWith("/api/orders/inventory-availability?")) { calls.push({ url, options }); return pending.promise; }
    return json({ rows: [row(1), row(2)], total: 2 });
  };
  const page = useOrdersPage();
  page.vm.filters.searchQuery = "inventory-cold";
  await page.loadOrders();
  assert.equal(page.loading.value, false);
  assert.deepEqual(page.vm.rows.map(r => r.id), [1, 2]);
  assert.equal(page.vm.rows[0].inventory_availability, undefined);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url, "http://localhost").searchParams.get("orderIds"), "1,2");
  pending.resolve(json({ rows: [{ order_id: 1, inventory_availability: [{ product_id: 10, physical_stock: 8, available_stock: 0 }] }] }));
  await tick();
  assert.equal(page.vm.rows[0].inventory_availability[0].available_stock, 0);
  assert.equal(page.vm.rows[0].procurement_coverage, null);
  assert.deepEqual(page.vm.rows.map(r => r.id), [1, 2]);
});

test("changing pages aborts old facts and an out-of-order response cannot overwrite new rows", async () => {
  const old = deferred(), current = deferred(), signals = [];
  let list = 0;
  fetchHandler = async (url, options) => {
    if (url === "/api/shops") return json([]);
    if (url.startsWith("/api/orders/inventory-availability?")) {
      signals.push(options.signal);
      return signals.length === 1 ? old.promise : current.promise;
    }
    return json({ rows: [row(++list)], total: 2 });
  };
  const page = useOrdersPage();
  page.vm.filters.searchQuery = "inventory-stale";
  await page.loadOrders();
  page.vm.filters.page = 2;
  await page.loadOrders();
  assert.equal(signals[0].aborted, true);
  current.resolve(json({ rows: [{ order_id: 2, inventory_availability: [{ product_id: 20, physical_stock: 9, available_stock: 3 }] }] }));
  await tick();
  old.resolve(json({ rows: [{ order_id: 1, inventory_availability: [{ product_id: 10, physical_stock: 999, available_stock: 999 }] }] }));
  await tick();
  assert.equal(page.vm.rows[0].id, 2);
  assert.equal(page.vm.rows[0].inventory_availability[0].available_stock, 3);
});

test("a failed balance request preserves unknown stock and retry forces balance refresh", async () => {
  let fail = true; const urls = [];
  fetchHandler = async url => {
    if (url === "/api/shops") return json([]);
    if (url.startsWith("/api/orders/inventory-availability?")) {
      urls.push(url);
      return fail ? json({ error: "库存暂不可用" }, 503) : json({ rows: [{ order_id: 3, inventory_availability: [{ product_id: 30, physical_stock: 4, available_stock: 2 }] }] });
    }
    return json({ rows: [row(3)], total: 1 });
  };
  const page = useOrdersPage(); page.vm.filters.searchQuery = "inventory-retry";
  await page.loadOrders(); await tick();
  assert.equal(page.vm.rows[0].inventory_availability, undefined);
  fail = false;
  await page.loadOrders({ forceRefresh: true }); await tick();
  assert.equal(new URL(urls.at(-1), "http://localhost").searchParams.get("refresh"), "1");
  assert.equal(page.vm.rows[0].inventory_availability[0].physical_stock, 4);
});

test("removed status tabs are dropped from old preferences and restored filters", async () => {
  const page = useOrdersPage();
  fetchHandler = async () => json({ value: { order: ["dispute", "purchase_records_missing", "purchase_in_transit", "all"] } });
  await page.loadStatusTabPreference();
  assert.deepEqual(page.vm.statusTabs.slice(0, 2).map(t => t.value), ["purchase_in_transit", "all"]);
  assert.equal(page.vm.statusTabs.some(t => ["dispute", "purchase_records_missing"].includes(t.value)), false);
  page.patch({ filters: { status: "purchase_records_missing" } });
  assert.equal(page.vm.filters.status, "awaiting_packaging");
});
