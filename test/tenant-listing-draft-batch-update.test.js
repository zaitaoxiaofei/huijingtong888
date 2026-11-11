import assert from "node:assert/strict";
import test from "node:test";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { createListingAutomationRoutes } from "../src/server/routes/listingAutomation.js";

const endpoint = "/api/listing/drafts/batch-update";
const partsOf = path => path.split("/").filter(Boolean);
const tenants = [{ id: 7, slug: "default" }, { id: 42, slug: "a" }, { id: 43, slug: "b" }];
const actor = (tenant, roles = ["operations"]) => ({ personId: 11, roles, tenant: { ...tenant, role: "member" } });

async function throughGateway(session, { path = endpoint, method = "POST", body = {}, save } = {}) {
  const parts = partsOf(path);
  const isolation = tenantIsolationDecision(session, parts, method);
  if (!isolation.allowed) return { stage: "isolation", ...isolation };
  const authorization = authorizeApiRequest({ method, _session: session }, parts);
  if (!authorization.allowed) return { stage: "authorization", ...authorization };
  const routes = createListingAutomationRoutes({ services: { updateListingDraftsBatch: save }, readJson: async req => req.body });
  return { stage: "dispatch", allowed: true, data: await routes[`${method} ${path}`]({ _session: session, body }) };
}

test("ordinary default/A/B operations can batch edit through the exact route with their own session", async () => {
  for (const tenant of tenants) {
    const session = actor(tenant);
    const body = { tenant_id: 999, created_by_person_id: 999, items: [{ id: 1 }, { id: 2 }] };
    let calls = 0;
    const result = await throughGateway(session, { body, save: async (received, member) => {
      calls++;
      assert.strictEqual(received, body);
      assert.strictEqual(member, session);
      return { updated: 2 };
    } });
    assert.equal(result.stage, "dispatch", JSON.stringify(result));
    assert.deepEqual(result.data, { updated: 2 });
    assert.equal(calls, 1);
  }
});

test("batch draft editing retains the existing operations permission and rejects other duties", async () => {
  for (const tenant of tenants) {
    for (const roles of [["packing"], ["procurement"], ["technical"], ["packing", "procurement"], []]) {
      let calls = 0;
      const result = await throughGateway(actor(tenant, roles), { save: async () => { calls++; } });
      assert.equal(result.stage, "authorization", `${tenant.slug}: ${roles} ${JSON.stringify(result)}`);
      assert.equal(result.allowed, false);
      assert.equal(result.status, 403);
      assert.equal(calls, 0);
    }
  }
});

test("batch draft editing admits no additional methods, path suffixes or advanced bindings", async () => {
  for (const [method, path] of [
    ...["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"].map(method => [method, endpoint]),
    ["POST", `${endpoint}/extra`], ["POST", `${endpoint}-all`],
    ["POST", "/api/listing/drafts/bind"], ["POST", "/api/listing/development-review"]
  ]) {
    const result = await throughGateway(actor(tenants[1]), { method, path });
    assert.equal(result.stage, "isolation", `${method} ${path}`);
    assert.equal(result.code, "TENANT_ISOLATION_PENDING");
  }
  for (const session of [null, { roles: ["operations"] }, { platform_role: "super_admin", roles: [] }]) {
    const result = await throughGateway(session);
    assert.equal(result.stage, "isolation");
    assert.equal(result.code, "TENANT_CONTEXT_REQUIRED");
  }
});
