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

test("tenant online product access is limited to the exact read-only list route", () => {
  const owner = { roles: ["operations"], tenant: { id: 42, slug: "company-a", role: "owner" } };
  const member = { roles: ["operations"], tenant: { id: 42, slug: "company-a", role: "member" } };
  const platformAdmin = { roles: ["admin"], tenant: { id: 42, slug: "company-a", role: "member" } };
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products"], "GET").allowed, true);
  assert.equal(authorizeApiRequest({ method: "GET", _session: owner }, ["api", "online-products"]).allowed, true);
  assert.equal(authorizeApiRequest({ method: "POST", _session: owner }, ["api", "online-products"]).allowed, false);
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products", "123", "edit-draft"], "GET").allowed, false);
  assert.equal(tenantIsolationDecision(owner, ["api", "online-products"], "POST").allowed, false);
  assert.equal(canAccessPage(owner, "/online-products"), true);
  assert.equal(canAccessPage(platformAdmin, "/online-products"), true);
  assert.equal(canAccessPage(member, "/online-products"), false);
  assert.equal(canAccessPage(owner, "/batch-stock-update"), false);
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

test("online-product tenant UI stays read-only and avoids the global people endpoint", () => {
  const view = read("../frontend/admin/views/inventory/OnlineProductsView.vue");
  const routes = read("../src/server/routes/catalog.js");
  const cache = read("../frontend/admin/utils/shop-dictionary.js");
  const api = read("../frontend/admin/utils/api.js");
  assert.match(routes, /services\.onlineProducts\(Object\.fromEntries\(url\.searchParams\.entries\(\)\), tenantIdFromRequest\(req\)\)/);
  assert.match(view, /const tenantReadOnly = computed\(\(\) => authStore\.user\?\.tenant\?\.slug !== "default"\)/);
  assert.match(view, /if \(!dictionaryLoaded && !tenantReadOnly\.value\) requests\.push\(apiClient\.get\("\/api\/people"\)\)/);
  assert.match(view, /el-button[^\n]+@click="handleSearch"/);
  assert.match(view, /<el-form-item v-if="!tenantReadOnly">\s*<el-button[^\n]+@click="syncOnlineProducts/);
  assert.match(view, /v-if="!tenantReadOnly" label="操作"/);
  assert.match(cache, /cacheByTenant\.get\(tenantKey\)/);
  assert.match(api, /__erp_scope=\$\{encodeURIComponent\(currentApiCacheScope\(\)\)\}/);
});
