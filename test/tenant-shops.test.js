import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createOperationsRoutes, handleOperationsRestRoute } from "../src/server/routes/operations.js";
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
  assert.equal(authorizeApiRequest({ method: "GET", _session: member }, ["api", "shops"]).allowed, false);
  assert.equal(authorizeApiRequest({ method: "GET", _session: member }, ["api", "people"]).allowed, false);
  assert.equal(authorizeApiRequest({ method: "GET", _session: member }, ["api", "tenants", "members"]).allowed, false);
  assert.equal(canAccessPage(owner, "/tenant-shops"), true);
  assert.equal(canAccessPage(member, "/tenant-shops"), false);
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
  const router = read("../frontend/admin/router/index.js");
  const navigation = read("../frontend/admin/constants/navigation.js");
  assert.match(source, /hasPermission\(req\._session, "admin"\)[\s\S]*\? \(req\.query\?\.tenant_id \|\| req\.query\?\.tenantId\)[\s\S]*: req\._session\?\.tenant\?\.id/);
  assert.match(router, /path: "tenant-shops"[\s\S]*component: TenantShopsView/);
  assert.match(navigation, /route: "\/tenant-shops"/);
});
