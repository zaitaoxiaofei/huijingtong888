import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "acorn";
import { listingTenantLookup } from "../src/services/listing-tenant-scope.js";

const view = readFileSync(new URL("../frontend/admin/views/listing/ListingPublishRecordsView.vue", import.meta.url), "utf8")
  .split("<script setup>")[1].split("</script>")[0];
const service = readFileSync(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const catalog = readFileSync(new URL("../src/services/ai-vehicle-catalog.js", import.meta.url), "utf8");
const trees = new Map([view, service, catalog].map(source => [source, parse(source, { ecmaVersion: "latest", sourceType: "module" })]));

function declaration(source, name) {
  const node = trees.get(source).body.map(item => item.declaration || item)
    .find(item => item.type === "FunctionDeclaration" && item.id.name === name);
  assert.ok(node, `Missing production function ${name}`);
  return source.slice(node.start, node.end);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const turn = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const list = (id, name = "Draft") => ({ rows: [{ id, row_type: "draft", product_name: name }], total: 1, page: 1, pageSize: 20 });

function frontend(get) {
  let scope = "tenant-a:person-7";
  const warnings = [];
  const state = { rows: [], total: 0, page: 1, pageSize: 20, status: "all", quality: "all", query: "", nameQuery: "",
    category: "", vehicleBrand: "", vehicleModel: "", shopId: "all", creatorId: "all", developmentType: "all",
    publishStatus: "all", minPrice: "", maxPrice: "", createdRange: [], updatedRange: [] };
  const context = vm.createContext({ URLSearchParams, state, loading: { value: false }, draftBindingsLoading: { value: false },
    selectedRows: { value: [] }, isDraftMode: { value: true }, isPublishMode: { value: false }, route: { query: {} },
    currentApiCacheScope: () => scope, apiClient: { get }, ElMessage: { warning: message => warnings.push(message) },
    // Row presentation is separate from the request/cache/loading behavior under test.
    normalizeDraftProjectFallback: row => ({ ...row }) });
  vm.runInContext(`const DRAFT_LIST_CACHE_TTL_MS = 30000; const LIST_CACHE_MAX_ENTRIES = 30;
    const draftListCache = new Map(); const publishTaskListCache = new Map(); let recordsRequestSeq = 0;
    ${["setBoundedListCache", "applyDraftListResult", "loadRecords"].map(name => declaration(view, name)).join("\n")}
    globalThis.cacheEntries = () => [...draftListCache.entries()];`, context);
  const watcher = trees.get(view).body.find(node => node.type === "ExpressionStatement"
    && node.expression.type === "CallExpression" && node.expression.callee.name === "watch"
    && view.slice(node.start, node.end).includes("draftListCache.clear()")
    && view.slice(node.start, node.end).includes("authStore.user?.tenant?.role"));
  assert.ok(watcher, "Identity/role changes must invalidate visible rows and list snapshots");
  const callback = watcher.expression.arguments[1];
  vm.runInContext(`globalThis.invalidateIdentity = ${view.slice(callback.start, callback.end)};`, context);
  return { context, state, warnings, load: () => context.loadRecords(),
    setScope(value, invalidate = false) { scope = value; if (invalidate) context.invalidateIdentity(); } };
}

test("draft rows become usable while their secondary bindings are still pending", async () => {
  const rows = deferred(), bindings = deferred(), calls = [];
  const ui = frontend(async (url, options) => {
    calls.push({ url, options });
    return url.startsWith("/api/listing/draft-bindings?") ? bindings.promise : rows.promise;
  });
  let finished = false;
  const request = ui.load().then(() => { finished = true; });
  assert.equal(ui.context.loading.value, true);
  rows.resolve(list(17));
  await turn();
  assert.equal(ui.state.rows[0].id, 17);
  assert.equal(ui.context.loading.value, false);
  assert.equal(ui.context.draftBindingsLoading.value, true);
  assert.equal(finished, false, "The first paint must precede the secondary response");
  assert.equal(calls[1].url, "/api/listing/draft-bindings?ids=17");
  assert.ok(calls.every(call => call.options.noCache === true));
  bindings.resolve([{ draft_id: 17, task_id: 42, task_title: "Task", vehicle_catalog_id: 9 }]);
  await request;
  assert.equal(ui.state.rows[0].team_task_id, 42);
  assert.equal(ui.state.rows[0].vehicle_catalog_id, 9);
  assert.equal(ui.context.draftBindingsLoading.value, false);
});

test("bindings failure retains usable rows, releases loading, and permits a successful retry", async () => {
  let bindingReads = 0;
  const ui = frontend(async url => {
    if (!url.startsWith("/api/listing/draft-bindings?")) return list(17);
    if (++bindingReads === 1) throw Object.assign(new Error("Forbidden fixture"), { status: 403 });
    return [{ draft_id: 17, task_id: 43, task_title: "Retried" }];
  });
  await ui.load();
  assert.equal(ui.state.rows[0].id, 17);
  assert.equal(ui.state.total, 1);
  assert.equal(ui.warnings.length, 1);
  assert.equal(ui.context.loading.value, false);
  assert.equal(ui.context.draftBindingsLoading.value, false);
  await ui.load();
  assert.equal(ui.state.rows[0].team_task_id, 43);
  assert.equal(bindingReads, 2);
});

test("a late page from another identity cannot repopulate rows or cache", async () => {
  const oldRows = deferred();
  let pages = 0;
  const ui = frontend(async url => url.startsWith("/api/listing/draft-bindings?") ? [] : ++pages === 1 ? oldRows.promise : list(17, "B"));
  const oldRequest = ui.load();
  ui.setScope("tenant-b:person-8", true);
  assert.deepEqual(plain(ui.state.rows), []);
  await ui.load();
  oldRows.resolve(list(17, "Private A"));
  await oldRequest;
  assert.equal(ui.state.rows[0].product_name, "B");
  const cache = plain(ui.context.cacheEntries());
  assert.equal(cache.length, 1);
  assert.ok(cache[0][0].startsWith("tenant-b:person-8:"));
  assert.equal(cache[0][1].result.rows[0].product_name, "B");
});

test("late bindings for the same draft ID cannot cross an identity boundary", async () => {
  const oldBindings = deferred();
  let pages = 0, bindingReads = 0;
  const ui = frontend(async url => {
    if (!url.startsWith("/api/listing/draft-bindings?")) return list(17, ++pages === 1 ? "A" : "B");
    return ++bindingReads === 1 ? oldBindings.promise : [{ draft_id: 17, task_id: 200, task_title: "B task" }];
  });
  const oldRequest = ui.load();
  await turn();
  ui.setScope("tenant-b:person-8", true);
  assert.equal(ui.context.draftBindingsLoading.value, false);
  await ui.load();
  oldBindings.resolve([{ draft_id: 17, task_id: 100, task_title: "Private A task" }]);
  await oldRequest;
  assert.equal(ui.state.rows[0].product_name, "B");
  assert.equal(ui.state.rows[0].team_task_id, 200);
  assert.equal(ui.warnings.length, 0);
});

test("a superseded request cannot merge bindings or clear the newer request's loading", async () => {
  const firstBindings = deferred(), secondRows = deferred();
  let pages = 0;
  const ui = frontend(async url => url.startsWith("/api/listing/draft-bindings?") ? firstBindings.promise : ++pages === 1 ? list(17) : secondRows.promise);
  const first = ui.load();
  await turn();
  ui.state.query = "different query";
  const second = ui.load();
  assert.equal(ui.context.loading.value, true);
  firstBindings.reject(new Error("Stale binding failure"));
  await first;
  assert.equal(ui.warnings.length, 0);
  assert.equal(ui.state.rows[0].team_task_id, undefined);
  assert.equal(ui.context.loading.value, true, "The older finally must not clear the active request's mask");
  secondRows.resolve({ rows: [], total: 0, page: 1, pageSize: 20 });
  await second;
  assert.deepEqual(plain(ui.state.rows), []);
  assert.equal(ui.context.loading.value, false);
});

test("a cached page is never restored under a different cache scope even before watcher invalidation", async () => {
  const secondRows = deferred();
  let pages = 0;
  const ui = frontend(async url => url.startsWith("/api/listing/draft-bindings?") ? [] : ++pages === 1 ? list(17) : secondRows.promise);
  await ui.load();
  ui.state.rows = [];
  ui.setScope("tenant-b:person-8");
  const second = ui.load();
  assert.deepEqual(plain(ui.state.rows), []);
  assert.equal(ui.context.loading.value, true);
  secondRows.resolve({ rows: [], total: 0 });
  await second;
});

function backend(readCount, readRows) {
  const context = vm.createContext({ ensureListingListReadSchema: async () => {}, listingTenantLookup,
    row: readCount, all: readRows, normalizeDraftRow: row => ({ ...row }), resolveMappedMediaInValue: async rows => rows });
  vm.runInContext([declaration(service, "listingTenantId"), declaration(catalog, "vehicleCatalogTenantPredicate"),
    declaration(service, "listingDrafts")].join("\n"), context);
  return context;
}

test("lightweight count and ID reads start concurrently with identical tenant/filter parameters", async () => {
  const count = deferred(), ids = deferred(), calls = [];
  const context = backend((sql, params) => { calls.push({ type: "count", sql, params: plain(params) }); return count.promise; },
    (sql, params) => { calls.push({ type: "ids", sql, params: plain(params) }); return ids.promise; });
  const request = context.listingDrafts({ paged: "1", lightweight: "1", page: 3, pageSize: 7, tenant_id: "3", ids: "17,18,17",
    query: "TENET", nameQuery: "Key", sku: "SKU", shopId: 20, creatorId: 7, developmentType: "model", category: "Parts",
    categoryPath: "Cars / Keys", vehicleBrand: "TENET", vehicleModel: "T4", minPrice: "0", maxPrice: "80",
    publishStatus: "partial", status: "waiting", projectOnly: "1", startDate: "2026-10-20", endDate: "2026-10-22",
    dateTimeZone: "Asia/Shanghai", sortBy: "created_at" }, { tenant: { id: 2, slug: "enterprise-a" } });
  await turn();
  assert.deepEqual(calls.map(call => call.type), ["count", "ids"], "The ID read must start while count is still unresolved");
  const [countCall, idCall] = calls;
  assert.deepEqual(idCall.params.slice(0, -2), countCall.params);
  assert.deepEqual(idCall.params.slice(-2), [7, 14]);
  assert.equal(countCall.params[0], "2", "Client tenant_id cannot replace the session tenant");
  assert.deepEqual(countCall.params.slice(1, 3), [17, 18]);
  assert.ok(countCall.params.includes("2026-10-19 16:00:00"));
  assert.ok(countCall.params.includes("2026-10-21 16:00:00"));
  const commonCount = countCall.sql.slice(countCall.sql.indexOf("FROM listing_drafts")).trim();
  const commonIds = idCall.sql.slice(idCall.sql.indexOf("FROM listing_drafts"), idCall.sql.lastIndexOf("ORDER BY")).trim();
  assert.equal(commonIds, commonCount);
  ids.resolve([]);
  count.resolve({ total: 21 });
  assert.deepEqual(plain(await request), { rows: [], total: 21, page: 3, pageSize: 7, mode: "paged" });
});

test("parallel pagination still rechecks the session tenant when hydrating page IDs", async () => {
  for (const tenant of [{ id: 2, slug: "enterprise-a" }, { id: 1, slug: "default" }]) {
    const calls = [];
    const context = backend(async (sql, params) => { calls.push({ sql, params: plain(params) }); return { total: 2 }; },
      async (sql, params) => {
        calls.push({ sql, params: plain(params) });
        if (sql.includes("SELECT d.id")) return [{ id: 17 }, { id: 18 }];
        return [{ id: 17, product_name: "Owned" }, { id: 18, product_name: "Also owned" }];
      });
    const result = await context.listingDrafts({ paged: "1", lightweight: "1", tenant_id: "3" }, { tenant });
    assert.deepEqual(plain(result.rows).map(row => row.id), [17, 18]);
    const hydration = calls[2];
    assert.deepEqual(hydration.params, [tenant.id, 17, 18, tenant.slug === "default" ? "admin" : "2", 17, 18]);
    assert.match(hydration.sql, /WHERE d\.id IN \(\?, \?\) AND CONVERT\(COALESCE\(d\.tenant_id, 'admin'\)/);
    assert.match(hydration.sql, /creator_members\.tenant_id = \?/);
    assert.match(hydration.sql, /COALESCE\(t\.tenant_id, 'admin'\)[\s\S]*COALESCE\(d\.tenant_id, 'admin'\)/);
  }
});
