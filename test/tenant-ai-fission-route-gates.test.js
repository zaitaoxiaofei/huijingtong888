import assert from "node:assert/strict";
import test from "node:test";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const fissionPaths = [
  "/api/ai-variant-lab/analyze-image",
  "/api/ai-variant-lab/batch-plan",
  "/api/ai-variant-lab/batch-run-images",
  "/api/ai-variant-lab/batch-resume-images",
  "/api/listing/generate-offer-id"
];
const enterprises = [
  { id: 1, slug: "default", role: "member" },
  { id: 42, slug: "customer-company", role: "member" }
];
const partsOf = path => path.split("/").filter(Boolean);
const member = (tenant, roles) => ({ person_id: 123, roles, platform_role: null, tenant });

// Use the same two real decisions, in server dispatch order, without invoking
// paid AI services. The callback records whether a request could reach them.
function throughGateway(session, path, method = "POST", dispatch = () => {}) {
  const parts = partsOf(path);
  const isolation = tenantIsolationDecision(session, parts, method);
  if (!isolation.allowed) return { stage: "isolation", ...isolation };
  const authorization = authorizeApiRequest({ method, _session: session }, parts);
  if (!authorization.allowed) return { stage: "authorization", ...authorization };
  dispatch();
  return { stage: "dispatch", allowed: true };
}

for (const tenant of enterprises) {
  for (const path of fissionPaths) {
    test(`${tenant.slug} ordinary operations can reach exact POST ${path}`, () => {
      const session = member(tenant, ["operations"]);
      assert.equal(authorizeApiRequest({ method: "POST", _session: session }, partsOf(path)).allowed, true);
      let dispatches = 0;
      const decision = throughGateway(session, path, "POST", () => { dispatches += 1; });
      assert.deepEqual(decision, { stage: "dispatch", allowed: true }, JSON.stringify(decision));
      assert.equal(dispatches, 1);
    });
  }
}

test("fission route access requires an operations permission after the tenant gate", () => {
  for (const tenant of enterprises) {
    for (const roles of [["packing"], ["procurement"], ["technical"], ["packing", "procurement"], []]) {
      for (const path of fissionPaths) {
        const session = member(tenant, roles);
        const authorization = authorizeApiRequest({ method: "POST", _session: session }, partsOf(path));
        assert.equal(authorization.allowed, false, `${tenant.slug} ${roles}: ${path}`);
        assert.equal(authorization.status, 403);
        let dispatches = 0;
        const decision = throughGateway(session, path, "POST", () => { dispatches += 1; });
        assert.equal(decision.allowed, false);
        assert.equal(dispatches, 0);
      }
    }
  }
});

test("operations and platform identities without a current enterprise cannot reach fission services", () => {
  for (const session of [
    null,
    member(null, ["operations"]),
    { person_id: 123, platform_role: "super_admin", roles: [] }
  ]) {
    for (const path of fissionPaths) {
      let dispatches = 0;
      const decision = throughGateway(session, path, "POST", () => { dispatches += 1; });
      assert.equal(decision.stage, "isolation");
      assert.equal(decision.allowed, false);
      assert.equal(decision.code, "TENANT_CONTEXT_REQUIRED");
      assert.equal(dispatches, 0);
    }
  }
});

test("the fission gate does not admit other methods, extended paths, or adjacent advanced actions", () => {
  const unreviewed = [
    ...fissionPaths.flatMap(path => [
      ...["GET", "HEAD", "PUT", "PATCH", "DELETE"].map(method => [method, path]),
      ["POST", `${path}/unreviewed`]
    ]),
    ["POST", "/api/ai-variant-lab/analyze-image-admin"],
    ["POST", "/api/ai-variant-lab/batch-run-images-all"],
    ["POST", "/api/ai-variant-lab/batch-jobs/job-1/run-images"],
    ["POST", "/api/ai-variant-lab/batch-delete"],
    ["POST", "/api/listing/generate-offer-ids"],
    ["POST", "/api/listing/publish-tasks/12/retry"],
    ["POST", "/api/asset-variant-engine/publish"]
  ];
  for (const tenant of enterprises) {
    for (const [method, path] of unreviewed) {
      let dispatches = 0;
      const decision = throughGateway(member(tenant, ["operations"]), path, method, () => { dispatches += 1; });
      assert.equal(decision.stage, "isolation", `${tenant.slug} ${method} ${path}`);
      assert.equal(decision.allowed, false);
      assert.equal(decision.code, "TENANT_ISOLATION_PENDING");
      assert.equal(dispatches, 0);
    }
  }
});
