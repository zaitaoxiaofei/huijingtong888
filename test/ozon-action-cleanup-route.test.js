import assert from "node:assert/strict";
import test from "node:test";
import { createOzonActionRoutes } from "../src/server/routes/ozonActions.js";
import { authorizeApiRequest } from "../src/server/authorization.js";

test("enterprise operators can request scoped all-shop cleanup without platform task authority", async () => {
  const session = { personId: 7, role: "operations", roles: ["operations"], tenant: { id: 2, slug: "enterprise-2", role: "member" } };
  const req = { method: "POST", _session: session };
  assert.equal(authorizeApiRequest(req, ["api", "ozon", "actions", "cleanup-run-all"]).allowed, true);
  assert.equal(authorizeApiRequest(req, ["api", "scheduled-jobs", "run"]).allowed, false);
  assert.equal(authorizeApiRequest({ ...req, _session: { ...session, role: "packing", roles: ["packing"] } }, ["api", "ozon", "actions", "cleanup-run-all"]).allowed, false);
  const body = { tenant_key: "foreign" };
  const routes = createOzonActionRoutes({ services: { runOzonActionCleanupForTenant: (received, identity) => {
    assert.equal(received, body);
    assert.equal(identity, session);
    return { success: true, status: "running" };
  } }, readJson: async () => body });
  assert.deepEqual(await routes["POST /api/ozon/actions/cleanup-run-all"](req), { success: true, status: "running" });
});
