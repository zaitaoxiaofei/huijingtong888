import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { effectScope } from "vue";
import { createServer } from "vite";

let server, useOrdersPage, fetchHandler, pinia;
const pageScopes = [];
const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const row = id => ({ id, procurement_coverage: null, marker: `order-${id}` });
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
function createOrdersPage() {
  const scope = effectScope();
  pageScopes.push(scope);
  return scope.run(() => useOrdersPage());
}

before(async () => {
  await import("element-plus");
  const localStorage = storage();
  localStorage.setItem("erpPerfMonitor", "off");
  globalThis.window = Object.assign(new EventTarget(), {
    location: { hash: "#/orders", pathname: "/admin.html" }, localStorage, sessionStorage: storage(),
    setTimeout: () => 1, clearTimeout() {}
  });
  globalThis.fetch = (url, options) => fetchHandler(String(url), options);
  pinia = createPinia();
  setActivePinia(pinia);
  server = await createServer({ configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false }, appType: "custom" });
  ({ useOrdersPage } = await server.ssrLoadModule("/frontend/orders/composables/useOrdersPage.js"));
  const { useAuthStore } = await server.ssrLoadModule("/frontend/admin/stores/auth.js");
  useAuthStore(pinia).applyLoginResult({
    token: "inventory-hydration-fixture-session",
    user: { id: 1, name: "Inventory fixture", roles: ["operations"], tenant: { id: 1, slug: "default", role: "owner" } }
  });
});
afterEach(() => { for (const scope of pageScopes.splice(0)) scope.stop(); });
after(async () => {
  if (pinia) disposePinia(pinia);
  setActivePinia(undefined);
  await server?.close();
  globalThis.window = previousWindow;
  globalThis.fetch = previousFetch;
});

test("cold list paints before one batched inventory request, then hydrates zero values without allocation", async () => {
  const pending = deferred(), calls = [];
  fetchHandler = async (url, options) => {
    if (url === "/api/shops") return json([]);
    if (url.startsWith("/api/orders/inventory-availability?")) { calls.push({ url, options }); return pending.promise; }
    return json({ rows: [row(1), row(2)], total: 2 });
  };
  const page = createOrdersPage();
  page.vm.filters.searchQuery = "inventory-cold";
  await page.loadOrders();
  assert.equal(page.loading.value, false);
  assert.deepEqual(page.vm.rows.map(r => r.id), [1, 2]);
  assert.equal(page.vm.rows[0].inventory_availability, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, "Bearer inventory-hydration-fixture-session");
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
  const page = createOrdersPage();
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
  const page = createOrdersPage(); page.vm.filters.searchQuery = "inventory-retry";
  await page.loadOrders(); await tick();
  assert.equal(page.vm.rows[0].inventory_availability, undefined);
  fail = false;
  await page.loadOrders({ forceRefresh: true }); await tick();
  assert.equal(new URL(urls.at(-1), "http://localhost").searchParams.get("refresh"), "1");
  assert.equal(page.vm.rows[0].inventory_availability[0].physical_stock, 4);
});

test("removed status tabs are dropped from old preferences and restored filters", async () => {
  const page = createOrdersPage();
  fetchHandler = async () => json({ value: { order: ["dispute", "purchase_records_missing", "purchase_in_transit", "all"] } });
  await page.loadStatusTabPreference();
  assert.deepEqual(page.vm.statusTabs.slice(0, 2).map(t => t.value), ["purchase_in_transit", "all"]);
  assert.equal(page.vm.statusTabs.some(t => ["dispute", "purchase_records_missing"].includes(t.value)), false);
  page.patch({ filters: { status: "purchase_records_missing" } });
  assert.equal(page.vm.filters.status, "awaiting_packaging");
});

test('stocktake updates only returned rows, preserving images, order, filters, totals and hidden selections', async () => {
  const calls=[];
  const originals=[{...row(21),product_ids:'8'},{...row(22),product_ids:'8'},{...row(23),product_ids:'9'}];
  fetchHandler=async(url,options)=>{
    calls.push({url,options});
    if(url==='/api/shops')return json([]);
    if(url.includes('includeRows=1'))return json({rows:[21,22].map(id=>({order_id:id,order:{...originals.find(r=>r.id===id),procurement_coverage:{shortage_quantity:0},inventory_availability:[{product_id:8,physical_stock:20,available_stock:18}]}}))});
    if(url.startsWith('/api/orders/inventory-availability?'))return json({rows:[]});
    return json({rows:originals,total:100,page:2,pageSize:20});
  };
  const page=createOrdersPage();await page.loadOrders({forceRefresh:true});await tick();
  page.selectedOrderIds.value=new Set([1,21]);const unrelated=page.vm.rows[2],filters={...page.vm.filters};calls.length=0;
  await page.refreshInventoryRows({productId:8});
  assert.deepEqual(page.vm.rows.map(r=>r.id),[21,22,23]);assert.equal(page.vm.rows[2],unrelated);
  assert.equal(page.vm.rows[0].inventory_availability[0].physical_stock,20);assert.deepEqual(page.vm.filters,filters);assert.equal(page.vm.meta.total,100);
  assert.deepEqual([...page.selectedOrderIds.value],[1,21]);assert.equal(calls.length,1);assert.ok(calls[0].url.includes('productId=8'));assert.equal(calls[0].options.noCache,true);
  assert.equal(page.inventoryRefreshFailed.value,false);
});

test('failed stocktake refresh stays visibly stale and a page-level retry can recover',async()=>{
  let fail=true;
  fetchHandler=async url=>{
    if(url==='/api/shops')return json([]);
    if(url.includes('includeRows=1'))return fail?json({error:'temporary'},503):json({rows:[{order_id:1,order:{...row(1),product_ids:'8',inventory_availability:[{product_id:8,physical_stock:0,available_stock:0}]}}]});
    if(url.startsWith('/api/orders/inventory-availability?'))return json({rows:[]});
    return json({rows:[{...row(1),product_ids:'8'}],total:1});
  };
  const page=createOrdersPage();await page.loadOrders({forceRefresh:true});await tick();await page.refreshInventoryRows({productId:8});
  assert.equal(page.inventoryRefreshFailed.value,true);assert.equal(page.vm.rows[0].inventory_refresh_pending,true);
  fail=false;await page.refreshInventoryRows();assert.equal(page.inventoryRefreshFailed.value,false);assert.equal(page.vm.rows[0].inventory_refresh_pending,false);assert.equal(page.vm.rows[0].inventory_availability[0].physical_stock,0);
});

test('a late stocktake refresh cannot replace a page opened afterwards',async()=>{
  const pending=deferred();let id=1;
  fetchHandler=async url=>{
    if(url==='/api/shops')return json([]);
    if(url.includes('includeRows=1'))return pending.promise;
    if(url.startsWith('/api/orders/inventory-availability?'))return json({rows:[]});
    return json({rows:[{...row(id),product_ids:'8'}],total:2,page:id});
  };
  const page=createOrdersPage();await page.loadOrders({forceRefresh:true});await tick();const refresh=page.refreshInventoryRows({productId:8});
  id=2;await page.loadOrders({forceRefresh:true});pending.resolve(json({rows:[{order_id:1,order:{...row(1),inventory_availability:[]}}]}));await refresh;
  assert.deepEqual(page.vm.rows.map(row=>row.id),[2]);assert.equal(page.inventoryRefreshNotice.value,'');
});

test('a second save reconciles both pending changes and ignores a late first response',async()=>{
  const first=deferred(),requests=[];let n=0;
  const raw=[{...row(1),product_ids:'8'},{...row(2),product_ids:'9'}];
  fetchHandler=async url=>{
    if(url==='/api/shops')return json([]);
    if(url.includes('includeRows=1')){requests.push(url);if(++n===1)return first.promise;return json({rows:raw.map(r=>({order_id:r.id,order:{...r,inventory_availability:[{product_id:r.id===1?8:9,physical_stock:20,available_stock:18}]}}))});}
    if(url.startsWith('/api/orders/inventory-availability?'))return json({rows:[]});
    return json({rows:raw,total:2});
  };
  const page=createOrdersPage();await page.loadOrders({forceRefresh:true});await tick();const initial=page.refreshInventoryRows({productId:8});await tick();await page.refreshInventoryRows({productId:9});
  first.resolve(json({rows:[{order_id:1,order:{...row(1),inventory_availability:[]}}]}));await initial;
  assert.ok(requests[0].includes('productId=8'));assert.ok(!requests[1].includes('productId='));assert.ok(page.vm.rows.every(row=>row.inventory_availability[0].physical_stock===20));assert.ok(page.vm.rows.every(row=>row.inventory_refresh_pending===false));
});
