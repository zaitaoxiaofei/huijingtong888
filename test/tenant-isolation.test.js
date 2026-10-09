import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isPrivateImageRead, readCookie, tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { isTenantScopedPluginRoute, tenantPluginApiError } from "../src/server/local-plugin-tenant.js";

test("default tenant retains access while unsupported tenant business routes fail closed", () => {
  const defaultSession = { tenant: { id: 1, slug: "default" } };
  const otherSession = { tenant: { id: 42, slug: "test-company" } };

  assert.equal(tenantIsolationDecision(defaultSession, ["api", "orders"]).allowed, true);
  assert.equal(tenantIsolationDecision(otherSession, ["api", "orders"]).code, "TENANT_ISOLATION_PENDING");
  assert.equal(tenantIsolationDecision(otherSession, ["api", "dashboard"]).allowed, false);
  assert.equal(tenantIsolationDecision(otherSession, ["api", "user-preferences"]).allowed, true);
  assert.equal(tenantIsolationDecision({}, ["api", "orders"]).code, "TENANT_CONTEXT_REQUIRED");
});

test("private image reads are identified for session and tenant checks", () => {
  assert.equal(isPrivateImageRead({ method: "GET" }, ["api", "products", "42", "image"]), true);
  assert.equal(isPrivateImageRead({ method: "GET" }, ["api", "products", "42", "detail-images", "0"]), true);
  assert.equal(isPrivateImageRead({ method: "GET" }, ["api", "ai", "file", "task-id"]), true);
  assert.equal(isPrivateImageRead({ method: "GET" }, ["api", "asset-variant-engine", "tail-template-files", "file"]), true);
  assert.equal(isPrivateImageRead({ method: "POST" }, ["api", "products", "42", "image"]), false);
  assert.equal(isPrivateImageRead({ method: "GET" }, ["api", "image-proxy"]), false);
});

test("cookie parsing handles multiple cookies and malformed encoding", () => {
  assert.equal(readCookie({ headers: { cookie: "other=value; erp_image_session=a%2Fb" } }, "erp_image_session"), "a/b");
  assert.equal(readCookie({ headers: { cookie: "erp_image_session=%ZZ" } }, "erp_image_session"), "%ZZ");
  assert.equal(readCookie({ headers: { cookie: "other=value" } }, "erp_image_session"), "");
});

test("server enforces tenant isolation before dispatching authenticated API routes", () => {
  const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const isolationIndex = source.indexOf("tenantIsolationDecision(session, parts)");
  const authorizationIndex = source.indexOf("authorizeApiRequest(req, parts)", isolationIndex);
  assert.ok(isolationIndex >= 0);
  assert.ok(authorizationIndex > isolationIndex);
  assert.match(source, /const imageCookieToken = isPrivateImageRead\(req, parts\)/);
  assert.match(source, /setCookie\(res, IMAGE_SESSION_COOKIE, result\.token/);
});

test("tenant plugin credentials are restricted to tenant-keyed collector and analytics routes", () => {
  const tenantPrincipal = { tenantId: 42, tenantKey: "42", tenantSlug: "test-company" };
  assert.equal(isTenantScopedPluginRoute("POST", ["api", "local-plugin", "collected-products", "sync"]), true);
  assert.equal(isTenantScopedPluginRoute("POST", ["api", "local-plugin", "seller-analytics", "snapshots"]), true);
  assert.equal(isTenantScopedPluginRoute("POST", ["api", "local-plugin", "collector-box", "ABC", "create-selection"]), false);
  assert.equal(isTenantScopedPluginRoute("GET", ["api", "local-plugin", "seller-analytics", "auth-probe"]), false);
  assert.equal(tenantPluginApiError(tenantPrincipal, "POST", ["api", "local-plugin", "collector-box"]).code, "TENANT_PLUGIN_SCOPE_PENDING");
  assert.equal(tenantPluginApiError({ tenantKey: "admin" }, "POST", ["api", "local-plugin", "collector-box"]), null);
  assert.equal(tenantPluginApiError(null, "POST", ["api", "local-plugin", "collector-box"]).code, "TENANT_PLUGIN_AUTH_REQUIRED");
});

test("plugin tenant identity comes from a hashed, revocable tenant credential", () => {
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const tenantService = readFileSync(new URL("../src/services/tenants.js", import.meta.url), "utf8");
  const pluginHandler = server.match(/async function handleLocalPluginRoute\([\s\S]*?(?=async function sendProductImage)/)?.[0] || "";
  const principalResolver = server.match(/async function resolveLocalPluginPrincipal\([\s\S]*?(?=async function handleLocalPluginRoute)/)?.[0] || "";
  assert.match(tenantService, /CREATE TABLE IF NOT EXISTS tenant_plugin_tokens/);
  assert.match(tenantService, /token_hash CHAR\(64\) NOT NULL/);
  assert.match(tenantService, /createHash\("sha256"\)/);
  assert.match(tenantService, /withMysqlTransaction\(async \(connection\)/);
  assert.match(tenantService, /WHERE pt\.token_hash = \? AND pt\.revoked_at IS NULL AND t\.status = 'active'/);
  assert.match(pluginHandler, /const tenantId = principal\.tenantKey/);
  assert.match(principalResolver, /isDirectLocalRequest\(req\) && localHost/);
  assert.match(principalResolver, /resolveTenantPluginTokenMysql\(pluginBearerToken\(req\)\)/);
  assert.doesNotMatch(pluginHandler, /req\.headers\["x-tenant-id"\].*tenantId/);
  assert.match(server, /POST \/api\/tenants\/plugin-token/);
  assert.match(server, /DELETE \/api\/tenants\/plugin-token/);
});
