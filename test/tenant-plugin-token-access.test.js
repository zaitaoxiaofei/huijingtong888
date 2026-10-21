import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { pluginTokenTenantIdFromRequest } from "../src/server/tenant-context.js";
import { json } from "../src/http/response.js";

const tokenRoutes = [
  ["GET", ["api", "tenants", "plugin-token"]],
  ["POST", ["api", "tenants", "plugin-token"]],
  ["DELETE", ["api", "tenants", "plugin-token"]],
  ["POST", ["api", "tenants", "plugin-token", "reveal"]],
  ["POST", ["api", "tenants", "plugin-token", "import"]]
];

test("ordinary plugin token requests stay inside the active session enterprise even for a multi-enterprise owner", () => {
  const req = { _session: { roles: ["operations"], tenant: { id: 42, slug: "company-a", role: "owner" } } };
  assert.equal(pluginTokenTenantIdFromRequest(req), 42);
  assert.equal(pluginTokenTenantIdFromRequest(req, "42"), 42);
  assert.throws(() => pluginTokenTenantIdFromRequest(req, 99), { statusCode: 403 });
  assert.throws(() => pluginTokenTenantIdFromRequest({}, 42), { statusCode: 403 });
  assert.equal(pluginTokenTenantIdFromRequest({ _session: { roles: ["admin"], platform_role: "super_admin" } }, 99), 99);
  assert.equal(pluginTokenTenantIdFromRequest({ _session: { roles: ["admin"], platform_role: "super_admin", tenant: { id: 1 } } }), 1);
  assert.throws(() => pluginTokenTenantIdFromRequest({ _session: { roles: ["admin"], platform_role: "super_admin" } }), { statusCode: 400 });
  assert.throws(() => pluginTokenTenantIdFromRequest({ _session: { roles: ["admin"], platform_role: "super_admin" } }, "invalid"), { statusCode: 400 });
  assert.throws(() => pluginTokenTenantIdFromRequest({ _session: { roles: ["admin"], tenant: { id: 42, slug: "company-a", role: "admin" } } }, 99), { statusCode: 403 });
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const routes = server.slice(server.indexOf('"GET /api/tenants/plugin-token"'), server.indexOf('"POST /api/system/update-status"'));
  assert.equal((routes.match(/pluginTokenTenantIdFromRequest\(req,/g) || []).length, tokenRoutes.length);
});

function allowed(session, method, parts) {
  return tenantIsolationDecision(session, parts, method).allowed
    && authorizeApiRequest({ method, _session: session }, parts).allowed;
}

test("ordinary dispatcher applies no-store to sensitive credential responses", async () => {
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const start = server.lastIndexOf('    const key = `${req.method} ${url.pathname}`;');
  const end = server.indexOf('    if (parts[0] === "api") return notFound(res);', start);
  const dispatch = server.slice(start, end);
  assert.ok(start > 0 && end > start);
  for (const sensitive of [true, false]) {
    let headers;
    let body;
    const req = { method: "POST" };
    const res = { writeHead(status, value) { assert.equal(status, 200); headers = value; }, end(value) { body = value; } };
    const context = vm.createContext({ req, res, url: { pathname: "/api/tenants/plugin-token/reveal" },
      routes: { "POST /api/tenants/plugin-token/reveal": async request => { request._sensitiveResponse = sensitive; return { ok: true, token: "test-only-credential" }; } },
      json, markRequestTiming() {} });
    vm.runInContext(`async function respond() { ${dispatch} }`, context);
    await context.respond();
    assert.equal(headers["Cache-Control"], sensitive ? "no-store" : undefined);
    assert.equal(JSON.parse(body).ok, true);
  }
});

test("tenant plugin token routes are available only to enterprise owners and administrators", () => {
  for (const [method, parts] of tokenRoutes) {
    for (const role of ["owner", "admin", "member"]) {
      const session = { roles: ["operations"], tenant: { id: 42, slug: "company-a", role } };
      assert.equal(allowed(session, method, parts), role !== "member", `${role}: ${method} ${parts.join("/")}`);
    }
    const ordinary = { roles: ["operations"], tenant: { id: 42, slug: "company-a" } };
    const platformAdmin = { roles: ["admin"], platform_role: "super_admin", tenant: { id: 42, slug: "company-a", role: "member" } };
    const unassigned = { roles: ["operations"] };
    const ownerWithoutBusinessRole = { roles: [], tenant: { id: 42, slug: "company-a", role: "owner" } };
    const invalidRole = { roles: [], tenant: { id: 42, slug: "company-a", role: "member" } };
    assert.equal(allowed(ordinary, method, parts), false);
    assert.equal(allowed(platformAdmin, method, parts), true);
    assert.equal(allowed(unassigned, method, parts), false);
    assert.equal(allowed(ownerWithoutBusinessRole, method, parts), true);
    assert.equal(allowed(invalidRole, method, parts), false);
  }
});

test("plugin token isolation opens only implemented methods and exact route paths", () => {
  const owner = { roles: ["operations"], tenant: { id: 42, slug: "company-a", role: "owner" } };
  const implemented = new Set(tokenRoutes.map(([method, parts]) => `${method} ${parts.join("/")}`));
  for (const suffix of [[], ["reveal"], ["import"], ["unknown"], ["reveal", "extra"], ["import", "extra"]]) {
    const parts = ["api", "tenants", "plugin-token", ...suffix];
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const route = `${method} ${parts.join("/")}`;
      assert.equal(allowed(owner, method, parts), implemented.has(route), route);
    }
  }
  for (const parts of [["api", "tenants"], ["api", "tenants", "plans"], ["api", "tenants", "subscription"]]) {
    assert.equal(allowed(owner, "POST", parts), false);
  }
});

function loadTokenServices({ tenant = { id: 42, slug: "company-a", status: "active" }, memberships = [] } = {}) {
  const source = readFileSync(new URL("../src/services/tenants.js", import.meta.url), "utf8");
  const tokenServices = source.slice(source.indexOf("async function requireTenantPluginAdminMysql("), source.indexOf("export async function resolveTenantPluginTokenMysql("))
    .replaceAll("export ", "");
  const calls = [];
  const context = vm.createContext({
    DEFAULT_TENANT_SLUG: "default",
    ensureTenantSchemaMysql: async () => {},
    tenantPluginTokenEncryptionConfigured: () => true,
    decryptTenantPluginToken: value => `decrypted:${value}`,
    mysqlQuery: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT t.id, t.slug")) {
        assert.match(sql, /tm\.person_id = \? AND tm\.active = 1/);
        assert.match(sql, /WHERE t\.id = \? LIMIT 1/);
        const [personId, tenantId] = params;
        if (!tenant || tenant.id !== tenantId) return [];
        const member = memberships.find(item => item.person_id === personId && item.tenant_id === tenantId && item.active === 1);
        return [{ ...tenant, member_role: member?.role || null }];
      }
      if (sql.includes("FROM tenant_plugin_tokens")) {
        assert.deepEqual(Array.from(params), [tenant.id]);
        return [{ id: 7, token_ciphertext: "ciphertext", label: "plugin" }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  });
  vm.runInContext(tokenServices, context);
  return { services: context, calls };
}

test("all plugin token services reject forged cross-enterprise selectors before reading or changing tokens", async () => {
  const { services, calls } = loadTokenServices({
    tenant: { id: 99, slug: "company-b", status: "active" },
    memberships: [{ person_id: 10, tenant_id: 42, role: "owner", active: 1 }]
  });
  for (const name of ["tenantPluginTokenStatusMysql", "readTenantPluginTokenMysql", "issueTenantPluginTokenMysql", "saveTenantPluginTokenMysql", "revokeTenantPluginTokenMysql"]) {
    await assert.rejects(services[name](99, 10), error => error.statusCode === 403 && /仅企业负责人或企业管理员/.test(error.message));
  }
  assert.equal(calls.length, 5);
  assert.ok(calls.every(call => call.sql.startsWith("SELECT t.id, t.slug")));
});

test("plugin token service checks current membership activity and role for the requested enterprise", async () => {
  for (const [role, active] of [["member", 1], ["owner", 0], ["admin", 0]]) {
    const { services } = loadTokenServices({ memberships: [{ person_id: 10, tenant_id: 42, role, active }] });
    await assert.rejects(services.tenantPluginTokenStatusMysql(42, 10), /仅企业负责人或企业管理员/);
  }
  for (const role of ["owner", "admin"]) {
    const { services } = loadTokenServices({ memberships: [{ person_id: 10, tenant_id: 42, role, active: 1 }] });
    assert.equal((await services.tenantPluginTokenStatusMysql(42, 10)).configured, true);
    assert.equal((await services.readTenantPluginTokenMysql(42, 10)).token, "decrypted:ciphertext");
  }
});

test("default enterprise tokens still require platform administration and archived enterprises stay unavailable", async () => {
  const { services } = loadTokenServices({
    tenant: { id: 1, slug: "default", status: "active" },
    memberships: [{ person_id: 10, tenant_id: 1, role: "owner", active: 1 }]
  });
  await assert.rejects(services.tenantPluginTokenStatusMysql(1, 10), /仅平台管理员/);
  assert.equal((await services.tenantPluginTokenStatusMysql(1, 10, { isPlatformAdmin: true })).configured, true);
  const archived = loadTokenServices({ tenant: { id: 42, slug: "company-a", status: "archived" } }).services;
  await assert.rejects(archived.tenantPluginTokenStatusMysql(42, 10, { isPlatformAdmin: true }), /企业不存在或已停用/);
});
