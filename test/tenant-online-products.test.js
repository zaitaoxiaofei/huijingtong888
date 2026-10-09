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
  const req = { headers: { "x-tenant-id": "99" }, _session: { personId: 7, tenant: { id: 42, slug: "company-a" } } };
  await routes["GET /api/online-products/limits"](req, new URL("http://localhost/api/online-products/limits?shop_id=10"));
  await routes["GET /api/online-products/warehouses"](req, new URL("http://localhost/api/online-products/warehouses?shop_id=10"));
  await routes["POST /api/online-products/batch-stock"](req);
  await routes["POST /api/online-products/action"](req);
  assert.deepEqual(calls.map(([name, ...args]) => [name, args.at(-1)]), [
    ["limits", "42"],
    ["warehouses", "42"],
    ["stock", "42"],
    ["action", "42"]
  ]);
});

test("tenant online product access is limited to exact scoped routes", () => {
  const owner = { roles: ["operations"], tenant: { id: 42, slug: "company-a", role: "owner" } };
  const member = { roles: ["operations"], tenant: { id: 42, slug: "company-a", role: "member" } };
  const platformAdmin = { roles: ["admin"], tenant: { id: 42, slug: "company-a", role: "member" } };
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products"], "GET").allowed, true);
  assert.equal(authorizeApiRequest({ method: "GET", _session: owner }, ["api", "online-products"]).allowed, true);
  assert.equal(authorizeApiRequest({ method: "POST", _session: owner }, ["api", "online-products"]).allowed, false);
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products", "limits"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products", "warehouses"], "GET").allowed, true);
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products", "batch-stock"], "POST").allowed, true);
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products", "action"], "POST").allowed, true);
  assert.equal(authorizeApiRequest({ method: "POST", _session: owner }, ["api", "online-products", "batch-stock"]).allowed, true);
  assert.equal(authorizeApiRequest({ method: "POST", _session: owner }, ["api", "online-products", "action"]).allowed, true);
  assert.equal(authorizeApiRequest({ method: "POST", _session: member }, ["api", "online-products", "batch-stock"]).allowed, false);
  assert.equal(authorizeApiRequest({ method: "POST", _session: member }, ["api", "online-products", "action"]).allowed, false);
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products", "action"], "POST").allowed, true);
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products", "123", "edit-draft"], "GET").allowed, false);
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products"], "POST").allowed, false);
  assert.equal(canAccessPage(owner, "/online-products"), true);
  assert.equal(canAccessPage(owner, "/batch-stock-update"), true);
  assert.equal(canAccessPage(platformAdmin, "/online-products"), true);
  assert.equal(canAccessPage(member, "/online-products"), false);
});

test("online-product SQL scopes every list/count query through live tenant shops", () => {
  const service = read("../src/services/mysql-cutover.js");
  const list = service.match(/export async function onlineProductsMysql\([\s\S]*?(?=\nfunction onlineProductStockJoinSqlMysql)/)?.[0] || "";
  assert.match(list, /resolveShopTenantIdMysql\(tenantId\)/);
  assert.match(list, /if \(defaultTenant\) await repairMissingOnlineProductSkusMysql\(\)/);
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
  assert.match(action, /!defaultTenant && action !== "zero_stock"/);
  assert.match(action, /activeShopForTenantMysql\(Number\(online\.shop_id\), normalizedTenantId\)/);
  assert.match(routes, /performOnlineProductAction\(await readJson\(req\), req\._session\?\.personId, tenantIdFromRequest\(req\)\)/);
  assert.match(warehouses, /activeShopForTenantMysql\(shopId, tenantId\)/);
  assert.match(limits, /tenantShopPredicateMysql\("shops", defaultTenant\)/);
});

test("online-product tenant UI exposes only the scoped stock action and avoids global people data", () => {
  const view = read("../frontend/admin/views/inventory/OnlineProductsView.vue");
  const routes = read("../src/server/routes/catalog.js");
  const cache = read("../frontend/admin/utils/shop-dictionary.js");
  const api = read("../frontend/admin/utils/api.js");
  assert.match(routes, /services\.onlineProducts\(Object\.fromEntries\(url\.searchParams\.entries\(\)\), tenantIdFromRequest\(req\)\)/);
  assert.match(view, /const tenantReadOnly = computed\(\(\) => authStore\.user\?\.tenant\?\.slug !== "default"\)/);
  assert.match(view, /if \(!dictionaryLoaded && !tenantReadOnly\.value\) requests\.push\(apiClient\.get\("\/api\/people"\)\)/);
  assert.match(view, /el-button[^\n]+@click="handleSearch"/);
  assert.match(view, /<el-button v-if="!tenantReadOnly"[^\n]+@click="syncOnlineProducts/);
  assert.match(view, /v-if="tenantCanUpdateStocks"[^\n]+@click="openBatchStockDialog"/);
  assert.match(view, /const snapshotKey = `\$\{tenantKey\}:\$\{snapshotQuery\}`/);
  assert.match(view, /const normalizedShopId = `\$\{tenantKey\}:\$\{String\(shopId \|\| ""\)\}`/);
  assert.match(view, /v-if="!tenantReadOnly \|\| \(tenantCanUpdateStocks && tenantReadOnly\)" label="操作"/);
  assert.match(view, /v-else-if="tenantCanUpdateStocks"[^\n]+@click="zeroOnlineProductStock\(row\)"/);
  assert.match(view, /action: "zero_stock"/);
  assert.match(view, /<template v-if="!tenantReadOnly">[\s\S]*?archiveOnlineProduct\(row\)/);
  assert.match(view, /负责人和管理员可进行批量库存更新或清零单个商品/);
  assert.match(cache, /cacheByTenant\.get\(tenantKey\)/);
  assert.match(api, /__erp_scope=\$\{encodeURIComponent\(currentApiCacheScope\(\)\)\}/);
});
