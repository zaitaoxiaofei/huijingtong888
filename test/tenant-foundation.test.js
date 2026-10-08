import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { authorizeApiRequest } from "../src/server/authorization.js";

test("tenant management remains limited to platform administrators", () => {
  const operator = { roles: ["operations"] };
  const administrator = { roles: ["admin"] };
  assert.equal(authorizeApiRequest({ method: "GET", _session: operator }, ["api", "tenants"]).allowed, false);
  assert.equal(authorizeApiRequest({ method: "PUT", _session: administrator }, ["api", "tenants", "members"]).allowed, true);
});

test("tenant foundation binds the active tenant to the server session", () => {
  const authSession = readFileSync(new URL("../src/services/mysql-auth-session.js", import.meta.url), "utf8");
  const tenantService = readFileSync(new URL("../src/services/tenants.js", import.meta.url), "utf8");
  assert.match(authSession, /active_tenant_id/);
  assert.match(authSession, /JOIN tenant_members tm ON tm\.tenant_id = s\.active_tenant_id/);
  assert.match(tenantService, /UPDATE sessions SET active_tenant_id = \? WHERE token = \? AND person_id = \?/);
  assert.match(tenantService, /企业不存在或已停用/);
});
