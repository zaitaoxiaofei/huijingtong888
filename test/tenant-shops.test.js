import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createOperationsRoutes, handleOperationsRestRoute } from "../src/server/routes/operations.js";
import { createEnterpriseManagementRoutes } from "../src/server/routes/enterpriseManagement.js";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { canAccessPage } from "../src/shared/permissions.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("tenant shop routes derive shop scope from the authenticated session", async () => {
  const calls = [];
  const services = {
    shops: async (...args) => { calls.push(["shops", ...args]); return []; },
    createShop: async (...args) => { calls.push(["create", ...args]); return { ok: true }; },
    updateShop: async (...args) => { calls.push(["update", ...args]); },
    deleteShop: async (...args) => { calls.push(["delete", ...args]); }
  };
  const routes = createOperationsRoutes({ services, readJson: async () => ({ name: "A", tenant_id: 99 }) });
  const req = { headers: { "x-tenant-id": "99" }, _session: { personId: 7, tenant: { id: 42, slug: "company-a" } } };
  await routes["GET /api/shops"](req);
  await routes["POST /api/shops"](req);
  const json = (_res, data) => data;
  await handleOperationsRestRoute({ req: { ...req, method: "PUT" }, res: {}, parts: ["api", "shops", "12"], services, readJson: async () => ({ name: "A" }), json });
  await handleOperationsRestRoute({ req: { ...req, method: "DELETE" }, res: {}, parts: ["api", "shops", "12"], services, readJson: async () => ({}), json });
  assert.deepEqual(calls.map((call) => call.slice(0, call[0] === "shops" ? 2 : call[0] === "create" ? 3 : 4)), [
    ["shops", "42"],
    ["create", { name: "A", tenant_id: 99 }, "42"],
    ["update", 12, { name: "A" }, "42"],
    ["delete", 12, "42"]
  ]);
});

test("shop management is limited to tenant owners/admins and exact scoped routes", () => {
  const owner = { roles: ["operations"], tenant: { id: 42, slug: "company-a", role: "owner" } };
  const member = { roles: ["operations"], tenant: { id: 42, slug: "company-a", role: "member" } };
  for (const [method, parts] of [
    ["GET", ["api", "shops"]],
    ["POST", ["api", "shops"]],
    ["PUT", ["api", "shops", "12"]],
    ["DELETE", ["api", "shops", "12"]],
    ["GET", ["api", "tenants", "members"]]
  ]) {
    assert.equal(tenantIsolationDecision(owner, parts, method).allowed, true);
    assert.equal(authorizeApiRequest({ method, _session: owner }, parts).allowed, true);
  }
  assert.equal(tenantIsolationDecision(owner, ["api", "shops", "12", "credentials"], "DELETE").allowed, false);
  assert.equal(authorizeApiRequest({ method: "POST", _session: member }, ["api", "shops"]).allowed, false);
  assert.equal(authorizeApiRequest({ method: "GET", _session: member }, ["api", "shops"]).allowed, true);
  assert.equal(authorizeApiRequest({ method: "GET", _session: member }, ["api", "people"]).allowed, true);
  assert.equal(authorizeApiRequest({ method: "GET", _session: member }, ["api", "tenants", "members"]).allowed, true);
  assert.equal(canAccessPage(owner, "/tenant-shops"), true);
  assert.equal(canAccessPage(member, "/tenant-shops"), false);
});

test("ordinary default and customer staff receive only scoped shop dictionary fields", async () => {
  const rows = [{ id: 20, name: 'Own shop', status: 'active', platform: 'ozon', currency_code: 'RUB',
    ozon_client_id: 'private-client', api_key_hint: 'private-key', performance_client_secret: 'private-secret', watermark_path: '/private/path', watermark_opacity_percent: 40 }];
  const routes = createOperationsRoutes({ services: { shops: async () => rows }, readJson: async () => ({}) });
  for (const slug of ['default', 'customer-a']) {
    const member = { roles: ['operations'], tenant: { id: 2, slug, role: 'member' } };
    const projected = JSON.parse(JSON.stringify(await routes['GET /api/shops']({ _session: member })));
    assert.deepEqual(projected, [{ id: 20, name: 'Own shop', status: 'active', platform: 'ozon', currency_code: 'RUB',
      watermark_path: '/api/tools/image-cropper/shop-watermark/20/file', watermark_opacity_percent: 40 }]);
    assert.equal(canAccessPage(member, '/online-products'), true);
    assert.equal(authorizeApiRequest({ method: 'PUT', _session: member }, ['api', 'shops', '20']).allowed, false);
  }
  assert.deepEqual(await routes['GET /api/shops']({ _session: { tenant: { id: 2, slug: 'customer-a', role: 'owner' } } }), rows);
});

test("legacy people selector reads only current enterprise members and strips identity secrets", async () => {
  const calls = [];
  const routes = createEnterpriseManagementRoutes({ services: {
    tenantMembers: async (tenantId, options) => {
      assert.deepEqual(options, { peopleOnly: true });
      calls.push(tenantId);
      return [
        { person_id: tenantId * 10, name: `Member ${tenantId}`, username: `member-${tenantId}`, avatar_url: "", active: 1, account_active: 1,
          business_roles_json: '["packing"]', role: "owner", platform_role: "super_admin", password_hash: "private-hash", secret: "private-secret" },
        { person_id: 999, name: "Disabled account", active: 1, account_active: 0 }
      ];
    },
    people: async () => { throw new Error("A business administrator must not read global identities"); }
  }, readJson: async () => ({}) });
  for (const tenant of [{ id: 42, slug: "company-a" }, { id: 1, slug: "default" }]) {
    const session = { personId: 7, roles: ["admin"], tenant: { ...tenant, role: "member" } };
    const req = { method: "GET", headers: { "x-tenant-id": "99" }, query: { tenant_id: 99, tenantId: 99 }, _session: session };
    assert.equal(tenantIsolationDecision(session, ["api", "people"], "GET").allowed, true);
    assert.equal(authorizeApiRequest(req, ["api", "people"]).allowed, true);
    assert.deepEqual(await routes["GET /api/people"](req), [
      { id: tenant.id * 10, name: `Member ${tenant.id}`, username: `member-${tenant.id}`, avatar_url: "", roles: ["packing"], active: 1 }
    ]);
  }
  assert.deepEqual(calls, [42, 1]);
  const server = read("../src/server.js");
  assert.ok(server.indexOf("...createEnterpriseManagementRoutes({") > server.indexOf("...createOperationsRoutes({"), "safe selector must override the legacy global route");
});

test("global identity selector requires an explicit platform grant and no enterprise membership", async () => {
  let globalCalls = 0;
  const identities = [{ id: 1, name: "Platform account" }];
  const routes = createEnterpriseManagementRoutes({ services: {
    people: async () => { globalCalls++; return identities; },
    tenantMembers: async () => { throw new Error("Platform selector does not infer a default membership"); }
  }, readJson: async () => ({}) });
  const req = { method: "GET", _session: { personId: 1, platform_role: "super_admin", tenant: null } };
  assert.equal(tenantIsolationDecision(req._session, ["api", "people"], "GET").allowed, true);
  assert.equal(authorizeApiRequest(req, ["api", "people"]).allowed, true);
  assert.deepEqual(await routes["GET /api/people"](req), identities);
  assert.equal(globalCalls, 1);
});

test("dual platform and enterprise identities use the current enterprise people selector", async () => {
  const calls = [];
  const routes = createEnterpriseManagementRoutes({ services: {
    people: async () => { throw new Error("Enterprise context must not load the platform roster"); },
    tenantMembers: async (id, options) => { calls.push({ id, options }); return []; }
  }, readJson: async () => ({}) });
  assert.deepEqual(await routes["GET /api/people"]({ _session: { personId: 1, platform_role: "super_admin", tenant: { id: 2, slug: "b", role: "owner" } } }), []);
  assert.deepEqual(calls, [{ id: 2, options: { peopleOnly: true } }]);
});

test("explicit platform people scope requires a platform grant even with an enterprise admin role", async () => {
  let calls = 0;
  const routes = createEnterpriseManagementRoutes({ services: {
    people: async () => { calls++; return [{ id: 99, name: "System identity" }]; },
    tenantMembers: async () => { throw new Error("Explicit platform scope must not use enterprise members"); }
  }, readJson: async () => ({}) });
  const url = new URL("http://localhost:8788/api/people?scope=platform");
  const enterprise = { personId: 1, tenant: { id: 1, slug: "default", role: "owner" } };
  await assert.rejects(routes["GET /api/people"]({ _session: enterprise }, url), { statusCode: 403 });
  assert.equal(calls, 0);
  assert.deepEqual(await routes["GET /api/people"]({ _session: { ...enterprise, platform_role: "super_admin" } }, url), [{ id: 99, name: "System identity" }]);
  assert.equal(calls, 1);
});

test("shop storage adds a tenant index without bulk-reassigning legacy rows", () => {
  const schema = read("../scripts/init-mysql-schema.mjs");
  const service = read("../src/services/mysql-cutover.js");
  assert.match(schema, /tenant_id BIGINT UNSIGNED NULL/);
  assert.match(schema, /idx_shops_tenant_status_id \(tenant_id, status, id\)/);
  assert.doesNotMatch(schema, /UPDATE shops SET tenant_id/);
  assert.match(service, /export async function shopsMysql\(tenantId = "admin"\)/);
  assert.match(service, /s\.tenant_id = \?\$\{defaultTenant \? " OR s\.tenant_id IS NULL" : ""\}/);
  assert.match(service, /SELECT p\.id FROM people p\s+JOIN tenant_members tm ON tm\.person_id = p\.id AND tm\.tenant_id = \? AND tm\.active = 1/);
  assert.match(service, /UPDATE shops SET status = 'deleted' WHERE id = \? AND \(tenant_id = \?/);
});

test("tenant member lookup ignores another tenant selector for non-platform accounts", () => {
  const source = read("../src/server.js");
  const tenantService = read("../src/services/tenants.js");
  const router = read("../frontend/admin/router/index.js");
  const navigation = read("../frontend/admin/constants/navigation.js");
  assert.match(source, /hasPermission\(req\._session, "admin"\)[\s\S]*\? \(req\.query\?\.tenant_id \|\| req\.query\?\.tenantId \|\| req\._session\?\.tenant\?\.id\)[\s\S]*: req\._session\?\.tenant\?\.id/);
  assert.match(tenantService, /const normalizedTenantId = Number\(tenantId\);[\s\S]*?Number\.isSafeInteger\(normalizedTenantId\)[\s\S]*?WHERE tm\.tenant_id = \? AND tm\.active = 1\$\{options\.peopleOnly \? " AND p\.account_kind = 'person'" : ""\} ORDER BY p\.id`, \[normalizedTenantId\]\)/);
  assert.match(router, /path: "tenant-shops"[\s\S]*component: TenantShopsView/);
  assert.match(navigation, /route: "\/tenant-shops"/);
});
