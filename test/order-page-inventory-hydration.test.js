import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { effectScope } from "vue";
import { createServer } from "vite";

let server, useOrdersPage, fetchHandler, pinia, authStore, currentApiCacheScope;
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
  ({ currentApiCacheScope } = await server.ssrLoadModule('/frontend/admin/utils/api.js'));
  authStore = useAuthStore(pinia);
  authStore.applyLoginResult({
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
  assert.equal(page.vm.rows[1].inventory_availability, undefined);
  assert.equal(page.inventoryRefreshFailed.value, true, 'partial facts keep an existing visible retry entry');
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
  assert.equal(page.inventoryRefreshFailed.value, true);
  assert.match(page.inventoryRefreshNotice.value, /待核对.*重试库存刷新/);
  fail = false;
  await page.loadOrders({ forceRefresh: true }); await tick();
  assert.equal(new URL(urls.at(-1), "http://localhost").searchParams.get("refresh"), "1");
  assert.equal(page.vm.rows[0].inventory_availability[0].physical_stock, 4);
  assert.equal(page.inventoryRefreshFailed.value, false);
  assert.equal(page.inventoryRefreshNotice.value, '');
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
    if(url.startsWith('/api/orders/inventory-availability?'))return json({rows:[{order_id:id,inventory_availability:[]}]});
    return json({rows:[{...row(id),product_ids:'8'}],total:2,page:id});
  };
  const page=createOrdersPage();await page.loadOrders({forceRefresh:true});await tick();const refresh=page.refreshInventoryRows({productId:8});
  id=2;await page.loadOrders({forceRefresh:true});pending.resolve(json({rows:[{order_id:1,order:{...row(1),inventory_availability:[]}}]}));await refresh;
  assert.deepEqual(page.vm.rows.map(row=>row.id),[2]);assert.equal(page.inventoryRefreshNotice.value,'');
});

test('ordinary, filtered and refreshed list requests always defer inventory without waiting for facts', async () => {
  const lists=[], facts=[];
  fetchHandler=async(url,options)=>{
    if(url==='/api/shops')return json([]);
    if(url.startsWith('/api/orders/inventory-availability?')){facts.push({url,options});return new Promise(()=>{});}
    lists.push(url);return json({rows:[row(31)],total:1});
  };
  const page=createOrdersPage();page.vm.filters.searchQuery='deferred-list-flags';
  for(const [status,options] of [['awaiting_packaging',{}],['awaiting_deliver',{}],['all',{}],['pending_purchase',{}],['all',{forceRefresh:true}]]){
    page.vm.filters.status=status;await page.loadOrders(options);
    const params=new URL(lists.at(-1),'http://fixture').searchParams;
    assert.equal(params.get('includeInventoryAvailability'),'0');assert.equal(params.get('includeCounts'),'0');
    assert.equal(page.loading.value,false);assert.equal(page.vm.rows[0].inventory_availability,undefined);
  }
  assert.ok(facts.length>=5);assert.equal(new URL(facts.at(-1).url,'http://fixture').searchParams.get('refresh'),'1');
});

test('cached incomplete rows hydrate while the next list is pending and the fresh paint shares that batch', async () => {
  let lists=0;const listGate=deferred(),firstFacts=deferred(),currentFacts=deferred(),facts=[];
  fetchHandler=async(url,options)=>{
    if(url==='/api/shops')return json([]);
    if(url.startsWith('/api/orders/inventory-availability?')){facts.push({url,signal:options.signal});return facts.length===1?firstFacts.promise:currentFacts.promise;}
    return ++lists===1?json({rows:[row(41)],total:1}):listGate.promise;
  };
  const page=createOrdersPage();page.vm.filters.searchQuery='cached-paint-hydration';await page.loadOrders();
  const refreshing=page.loadOrders();
  assert.equal(page.loading.value,false);assert.equal(page.vm.rows[0].id,41);assert.equal(facts.length,2);
  assert.equal(facts[0].signal.aborted,true);
  listGate.resolve(json({rows:[row(41)],total:1}));await refreshing;assert.equal(facts.length,2,'one active batch for cached and fresh rows');
  firstFacts.resolve(json({rows:[{order_id:41,inventory_availability:[{product_id:4,physical_stock:999,available_stock:999}]}]}));await tick();
  assert.equal(page.vm.rows[0].inventory_availability,undefined);
  currentFacts.resolve(json({rows:[{order_id:41,inventory_availability:[{product_id:4,physical_stock:-3,available_stock:0}]}]}));await tick();
  assert.equal(page.vm.rows[0].inventory_availability[0].physical_stock,-3);assert.equal(page.vm.rows[0].inventory_availability[0].available_stock,0);
});

test('cached rows still receive facts after the following main list request fails', async () => {
  let lists=0;const firstFacts=deferred(),currentFacts=deferred(),listGate=deferred();let facts=0;
  fetchHandler=async url=>{
    if(url==='/api/shops')return json([]);
    if(url.startsWith('/api/orders/inventory-availability?'))return ++facts===1?firstFacts.promise:currentFacts.promise;
    return ++lists===1?json({rows:[row(42)],total:1}):listGate.promise;
  };
  const page=createOrdersPage();page.vm.filters.searchQuery='cache-failed-main';await page.loadOrders();
  const { ElMessage }=await import('element-plus'),showError=ElMessage.error;
  ElMessage.error=()=>{};
  try {
    const failed=assert.rejects(page.loadOrders(),/current list unavailable/);assert.equal(facts,2);
    listGate.resolve(json({error:'current list unavailable'},503));await failed;
  } finally { ElMessage.error=showError; }
  currentFacts.resolve(json({rows:[{order_id:42,inventory_availability:[{product_id:4,physical_stock:5,available_stock:2}]}]}));await tick();
  assert.equal(page.vm.rows[0].id,42);assert.equal(page.vm.rows[0].inventory_availability[0].available_stock,2);
  firstFacts.resolve(json({rows:[]}));await tick();assert.equal(page.inventoryRefreshFailed.value,false);
});

test('saving a note restarts interrupted page facts and rejects the old result without replacing notes or marks', async () => {
  const old=deferred(),current=deferred(),facts=[];let lists=0;
  fetchHandler=async(url,options)=>{
    if(url==='/api/shops')return json([]);
    if(url.startsWith('/api/orders/inventory-availability?')){facts.push(options.signal);return facts.length===1?old.promise:current.promise;}
    lists++;return json({rows:[{...row(43),mark_note:'before',mark_type:'urgent'}],total:1});
  };
  const page=createOrdersPage();page.vm.filters.searchQuery='notes-interrupt-facts';await page.loadOrders();
  page.vm.rows[0].mark_note='saved note';
  window.dispatchEvent(new CustomEvent('erp:order-collaboration-note-saved',{detail:{scope:currentApiCacheScope(),orderId:43,note:'saved note'}}));
  assert.equal(facts.length,2);assert.equal(facts[0].aborted,true);assert.equal(lists,1,'the restart never refetches an order row');
  old.resolve(json({rows:[{order_id:43,inventory_availability:[{product_id:4,physical_stock:999,available_stock:999}]}]}));await tick();
  assert.equal(page.vm.rows[0].inventory_availability,undefined);
  current.resolve(json({rows:[{order_id:43,inventory_availability:[{product_id:4,physical_stock:5,available_stock:0}]}]}));await tick();
  assert.equal(page.vm.rows[0].inventory_availability[0].available_stock,0);assert.equal(page.vm.rows[0].mark_note,'saved note');assert.equal(page.vm.rows[0].mark_type,'urgent');
});

test('enterprise changes and disposal abort facts and cannot hydrate a different or closed page', async () => {
  const pending=[],signals=[];let list=50;
  fetchHandler=async(url,options)=>{
    if(url==='/api/shops')return json([]);
    if(url.startsWith('/api/orders/inventory-availability?')){const task=deferred();pending.push(task);signals.push(options.signal);return task.promise;}
    return json({rows:[row(++list)],total:1});
  };
  const page=createOrdersPage();page.vm.filters.searchQuery='scope-and-dispose';await page.loadOrders();
  authStore.applyLoginResult({token:'other-hydration-scope',user:{id:2,name:'Other fixture',roles:['operations'],tenant:{id:2,slug:'other',role:'owner'}}});
  assert.equal(signals[0].aborted,true);assert.deepEqual(page.vm.rows,[]);
  pending[0].resolve(json({rows:[{order_id:51,inventory_availability:[{product_id:4,physical_stock:999,available_stock:999}]}]}));await tick();assert.deepEqual(page.vm.rows,[]);
  const next=createOrdersPage();await next.loadOrders();pageScopes.at(-1).stop();assert.equal(signals[1].aborted,true);
  pending[1].resolve(json({rows:[{order_id:52,inventory_availability:[{product_id:4,physical_stock:999,available_stock:999}]}]}));await tick();
  assert.equal(next.vm.rows[0].inventory_availability,undefined);
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
