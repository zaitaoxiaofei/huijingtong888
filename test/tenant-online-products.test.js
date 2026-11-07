import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCatalogRoutes } from "../src/server/routes/catalog.js";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { canAccessPage } from "../src/shared/permissions.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("online product list API derives the tenant only from the authenticated session", async () => {
  const calls = [];
  const routes = createCatalogRoutes({
    readJson: async () => ({}),
    services: { onlineProducts: async (...args) => { calls.push(args); return { rows: [] }; } }
  });
  const req = { headers: { "x-tenant-id": "99" }, _session: { tenant: { id: 42, slug: "company-a" } } };
  const url = new URL("http://localhost/api/online-products?paged=1&tenant_id=99");
  await routes["GET /api/online-products"](req, url);
  assert.equal(calls[0][0].tenant_id, "99");
  assert.equal(calls[0][1], "42");
});

test("online product stock and shop lookup routes derive scope from the session", async () => {
  const calls = [];
  const routes = createCatalogRoutes({
    readJson: async () => ({ online_product_ids: [10], tenant_id: 99 }),
    services: {
      onlineProductLimits: async (...args) => { calls.push(["limits", ...args]); return {}; },
      onlineProductWarehouses: async (...args) => { calls.push(["warehouses", ...args]); return {}; },
      batchUpdateOnlineProductStocks: async (...args) => { calls.push(["stock", ...args]); return {}; },
      performOnlineProductAction: async (...args) => { calls.push(["action", ...args]); return {}; }
    }
  });
  const req = { headers: { "x-tenant-id": "99" }, _session: { personId: 7, tenant: { id: 42, slug: "company-a" } }, _abortSignal: new AbortController().signal };
  await routes["GET /api/online-products/limits"](req, new URL("http://localhost/api/online-products/limits?shop_id=10"));
  await routes["GET /api/online-products/warehouses"](req, new URL("http://localhost/api/online-products/warehouses?shop_id=10"));
  await routes["POST /api/online-products/batch-stock"](req);
  await routes["POST /api/online-products/action"](req);
  assert.deepEqual(calls, [
    ["limits", { shop_id: "10" }, "42"],
    ["warehouses", { shop_id: "10" }, "42"],
    ["stock", { online_product_ids: [10], tenant_id: 99 }, 7, "42"],
    ["action", { online_product_ids: [10], tenant_id: 99 }, 7, "42", { session: req._session, signal: req._abortSignal }]
  ]);
  assert.equal(calls[3][4].session, req._session);
  assert.equal(calls[3][4].signal, req._abortSignal);
});

test("online product binding forwards authenticated tenant, current session and cancellation signal", async () => {
  const calls = [];
  const routes = createCatalogRoutes({
    readJson: async () => ({ online_product_id: 10, product_id: 20 }),
    services: { bindOnlineProduct: async (...args) => { calls.push(args); return { ok: true }; } }
  });
  const req = { headers: { "x-tenant-id": "99" }, _session: { tenant: { id: 42, slug: "company-a" } }, _abortSignal: new AbortController().signal };
  await routes["POST /api/online-products/bind"](req);
  assert.deepEqual(calls[0], [{ online_product_id: 10, product_id: 20 }, "42", { session: req._session, signal: req._abortSignal }]);
  assert.equal(calls[0][2].session, req._session);
  assert.equal(calls[0][2].signal, req._abortSignal);
  assert.equal(tenantIsolationDecision(req._session, ["api", "online-products", "bind"], "POST").allowed, true);
});

test("tenant online product access is limited to exact scoped routes", () => {
  const owner = { roles: ["operations"], tenant: { id: 42, slug: "company-a", role: "owner" } };
  const member = { roles: ["packing"], tenant: { id: 42, slug: "company-a", role: "member" } };
  const operator = { ...member, roles: ["operations"] };
  const platformAdmin = { roles: ["admin"], platform_role: "super_admin", tenant: { id: 42, slug: "company-a", role: "member" } };
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products"], "GET").allowed, true);
  assert.equal(authorizeApiRequest({ method: "GET", _session: owner }, ["api", "online-products"]).allowed, true);
  assert.equal(authorizeApiRequest({ method: "POST", _session: owner }, ["api", "online-products"]).allowed, false);
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products", "limits"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products", "warehouses"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products", "batch-stock"], "POST").allowed, true);
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products", "action"], "POST").allowed, true);
  assert.equal(authorizeApiRequest({ method: "POST", _session: owner }, ["api", "online-products", "batch-stock"]).allowed, true);
  assert.equal(authorizeApiRequest({ method: "POST", _session: owner }, ["api", "online-products", "action"]).allowed, true);
  for (const endpoint of ["batch-stock", "action", "bind", "create-product"]) assert.equal(authorizeApiRequest({ method: "POST", _session: operator }, ["api", "online-products", endpoint]).allowed, true);
  assert.equal(authorizeApiRequest({ method: "POST", _session: member }, ["api", "online-products", "batch-stock"]).allowed, false);
  assert.equal(authorizeApiRequest({ method: "POST", _session: member }, ["api", "online-products", "action"]).allowed, false);
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products", "action"], "POST").allowed, true);
  for (const [method, parts] of [
    ["POST", ["api", "online-products", "bind"]],
    ["POST", ["api", "online-products", "create-product"]],
    ["GET", ["api", "online-products", "123", "edit-draft"]]
  ]) {
    assert.equal(tenantIsolationDecision(owner, parts, method).allowed, true);
    assert.equal(authorizeApiRequest({ method, _session: owner }, parts).allowed, true);
  }
  for (const [method, parts] of [
    ["POST", ["api", "online-products", "sync"]],
    ["POST", ["api", "online-products", "bind", "all"]],
    ["POST", ["api", "online-products", "create-product", "all"]],
    ["GET", ["api", "online-products", "123", "edit-draft", "all"]]
  ]) {
    assert.equal(tenantIsolationDecision(owner, parts, method).allowed, false);
    assert.equal(authorizeApiRequest({ method, _session: owner }, parts).allowed, false);
  }
  for (const endpoint of ["bind", "create-product"]) assert.equal(authorizeApiRequest({ method: "POST", _session: member }, ["api", "online-products", endpoint]).allowed, false);
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products"], "POST").allowed, false);
  assert.equal(canAccessPage(owner, "/online-products"), true);
  assert.equal(canAccessPage(owner, "/batch-stock-update"), true);
  assert.equal(canAccessPage(platformAdmin, "/online-products"), true);
  assert.equal(canAccessPage(operator, "/online-products"), true);
  assert.equal(canAccessPage(member, "/online-products"), false);
});

test("online-product SQL scopes every list/count query through live tenant shops", () => {
  const service = read("../src/services/mysql-cutover.js");
  const list = service.match(/export async function onlineProductsMysql\([\s\S]*?(?=\nfunction onlineProductStockJoinSqlMysql)/)?.[0] || "";
  assert.match(list, /resolveShopTenantIdMysql\(tenantId\)/);
  assert.match(list, /if \(defaultTenant && !batchStock\) await repairMissingOnlineProductSkusMysql\(\)/);
  assert.match(list, /tenant_shop\.status != 'deleted' AND \(tenant_shop\.tenant_id = \?/);
  assert.match(list, /const cacheKey = `online-products:list:\$\{normalizedTenantId\}:/);
  assert.match(list, /const statusIndexCacheKey = `online-products:status-index:\$\{normalizedTenantId\}:/);
  assert.match(list, /const productJoinSql = defaultTenant \? "LEFT JOIN products p ON p\.id = op\.product_id" : "LEFT JOIN products p ON 1 = 0"/);
  assert.match(list, /const productIdSql = defaultTenant \? "op\.product_id" : "NULL AS product_id"/);
});

test("online product mutations and shop credentials are resolved inside active tenant scope", () => {
  const service = read("../src/services/mysql-cutover.js");
  const routes = read("../src/server/routes/catalog.js");
  const batch = service.match(/export async function batchUpdateOnlineProductStocksMysql\([\s\S]*?(?=\nexport async function performOnlineProductActionMysql)/)?.[0] || "";
  const warehouses = service.match(/export async function onlineProductWarehousesMysql\([\s\S]*?(?=\nfunction normalizeOzonLimitBucketMysql)/)?.[0] || "";
  const limits = service.match(/export async function onlineProductLimitsMysql\([\s\S]*?(?=\nfunction normalizeOzonAttributeValueObjectsMysql)/)?.[0] || "";
  assert.match(batch, /resolveShopTenantIdMysql\(tenantId\)/);
  assert.match(batch, /AND \$\{tenantShopPredicateMysql\("s", defaultTenant\)\}/);
  assert.match(batch, /rows\.length !== onlineProductIds\.length/);
  assert.match(batch, /activeShopForTenantMysql\(targetShopId, normalizedTenantId\)/);
  const action = service.match(/export async function performOnlineProductActionMysql\([\s\S]*?(?=\nexport async function mappingsMysql)/)?.[0] || "";
  assert.match(action, /resolveShopTenantIdMysql\(tenantId\)/);
  assert.match(action, /WHERE op\.id = \? AND s\.status != 'deleted' AND \$\{shopScope\}/);
  assert.match(action, /assertOrderTaskAccessMysql\(scope, options, \["operations"\]\)/);
  assert.match(action, /if \(!\["archive", "zero_stock", "zero_then_archive"\]\.includes\(action\)\)/);
  assert.match(action, /const checkCurrentShop = async \(\) => \{\s*await checkAccess\(\);/);
  assert.match(action, /await checkCurrentShop\(\);\s*const stockResult = await updateOzonProductStocks\(shop, stockTargets\);\s*await checkCurrentShop\(\);/);
  assert.match(action, /await checkCurrentShop\(\);\s*archiveResult = await archiveOzonProducts\(shop, \[ozonProductId\]\)/);
  assert.match(action, /resolveFreshOzonProductIdForArchiveMysql\(shop, online, checkCurrentShop\)/);
  assert.match(action, /WHERE id = \? AND shop_id = \?/);
  assert.match(action, /activeShopForTenantMysql\(Number\(online\.shop_id\), normalizedTenantId\)/);
  assert.match(routes, /performOnlineProductAction\(await readJson\(req\), req\._session\?\.personId, tenantIdFromRequest\(req\), \{ session: req\._session, signal: req\._abortSignal \}\)/);
  assert.match(warehouses, /activeShopForTenantMysql\(shopId, tenantId\)/);
  assert.match(limits, /tenantShopPredicateMysql\("shops", defaultTenant\)/);
  const bind = service.match(/export async function bindOnlineProductMysql\([\s\S]*?(?=\nexport async function createOnlineProductMysql)/)?.[0] || "";
  assert.match(bind, /resolveShopTenantIdMysql\(tenantId\)/);
  assert.match(bind, /assertOrderTaskAccessMysql\(\{ id: scope\.id \}, options, \["inventory\.write"\]\)/);
  assert.match(bind, /JOIN shops s ON s\.id = op\.shop_id/);
  assert.match(bind, /tenantShopPredicateMysql\("s", defaultTenant\)/);
  assert.match(bind, /tenant_id = \?\$\{defaultTenant \? " OR tenant_id IS NULL" : ""\}/);
  assert.match(bind, /INSERT INTO sku_mappings[\s\S]*?shop_id, tenant_id, product_id/);
  assert.match(bind, /SET product_id = \?, person_id = \?, online_product_id = \?, offer_id = \?, display_name = \?, tenant_id = \?/);
});

test("online-product tenant UI exposes only the scoped stock action and avoids global people data", () => {
  const view = read("../frontend/admin/views/inventory/OnlineProductsView.vue");
  const routes = read("../src/server/routes/catalog.js");
  const cache = read("../frontend/admin/utils/shop-dictionary.js");
  const api = read("../frontend/admin/utils/api.js");
  assert.match(routes, /services\.onlineProducts\(Object\.fromEntries\(url\.searchParams\.entries\(\)\), tenantIdFromRequest\(req\)\)/);
  assert.match(view, /const tenantReadOnly = computed\(\(\) => authStore\.user\?\.tenant\?\.slug !== "default"\)/);
  assert.match(view, /!dictionaryLoaded && !tenantReadOnly\.value && !showProductLimitPanel\.value/);
  assert.match(view, /el-button[^\n]+@click="handleSearch"/);
  assert.match(view, /<el-button v-if="canSyncOnline"[^\n]+@click="syncOnlineProducts/);
  assert.match(view, /if \(!canSyncOnline\.value\) return;/);
  assert.match(view, /v-if="tenantCanUpdateStocks"[^\n]+@click="openBatchStockDialog"/);
  assert.match(view, /if \(showProductLimitPanel\.value\) params\.set\("batchStock", "1"\)/);
  assert.match(view, /const normalizedShopId = `\$\{tenantKey\}:\$\{String\(shopId \|\| ""\)\}`/);
  assert.match(view, /v-if="canOperate \|\| canManageInventory \|\| tenantCanUpdateStocks" label="操作"/);
  assert.match(view, /v-if="tenantReadOnly && tenantCanUpdateStocks"[^\n]+@click="zeroOnlineProductStock\(row\)"/);
  assert.match(view, /action: "zero_stock"/);
  assert.match(view, /<template v-if="canOperate">[\s\S]*?archiveOnlineProduct\(row\)/);
  assert.match(view, /<template v-if="canManageInventory">[\s\S]*?openBindDialog\(row\)/);
  assert.match(view, /商品绑定、建品、编辑上架及归档按岗位权限开放/);
  assert.match(cache, /cacheByTenant\.get\(tenantKey\)/);
  assert.match(api, /__erp_scope=\$\{encodeURIComponent\(currentApiCacheScope\(\)\)\}/);
});
