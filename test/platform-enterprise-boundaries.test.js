import assert from "node:assert/strict";
import test from "node:test";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { canAccessPage, hasPermission } from "../src/shared/permissions.js";

const platform = { personId: 1, platform_role: "super_admin", roles: [], tenant: null };
const owner = { personId: 2, roles: ["operations"], tenant: { id: 42, slug: "company-a", role: "owner" } };
const parts = path => ["api", ...path.split("/")];
const allowed = (session, method, path) => authorizeApiRequest({ method, _session: session }, parts(path)).allowed
  && tenantIsolationDecision(session, parts(path), method).allowed;

test("platform-only accounts can operate platform resources without acquiring enterprise business access", () => {
  for (const path of ["platform/accounts", "tenants", "scheduled-jobs", "system-monitoring", "ai-provider", "ai-prompt-templates"]) {
    assert.equal(allowed(platform, "GET", path), true, path);
    assert.equal(allowed(owner, "GET", path), false, path);
    assert.equal(allowed({ ...owner, tenant: { ...owner.tenant, slug: "default" } }, "GET", path), false, `default ${path}`);
  }
  for (const path of ["orders", "shops", "enterprise/people", "asset-variant-engine/bootstrap", "products"]) {
    assert.equal(allowed(platform, "GET", path), false, path);
  }
  assert.equal(canAccessPage(platform, "/platform-accounts"), true);
  assert.equal(canAccessPage(platform, "/dashboard"), false);
  assert.equal(hasPermission({ roles: ["admin"] }, "admin"), false);
  assert.equal(hasPermission({ roles: ["technical"] }, "platform.admin"), false);
  assert.equal(allowed(owner, "GET", "logistics-rules"), true);
  assert.equal(allowed(owner, "POST", "logistics-rules"), false);
  assert.equal(allowed(platform, "POST", "logistics-rules"), true);
  assert.equal(allowed(owner, 'GET', 'settings/packaging-fee-rule'), true);
  assert.equal(allowed(owner, 'POST', 'settings/packaging-fee-rule'), false);
});

test("enterprise matrix configuration writes stay administrative while reviewed business execution opens to operators", () => {
  for (const [method, path] of [["GET", "bootstrap"], ["POST", "rules"], ["GET", "tail-templates"], ["POST", "tail-templates"], ["GET", "tail-template-files/12"]]) {
    assert.equal(allowed(owner, method, `asset-variant-engine/${path}`), true, `${method} ${path}`);
    assert.equal(allowed({ ...owner, tenant: { ...owner.tenant, role: "member" } }, method, `asset-variant-engine/${path}`), method === 'GET', path);
  }
  for (const path of ['jobs', 'files/123/image.png']) assert.equal(allowed(owner, 'GET', `asset-variant-engine/${path}`), true);
  for (const path of ['generate', 'generate-async', 'publish-to-ozon']) assert.equal(allowed(owner, 'POST', `asset-variant-engine/${path}`), true, path);
  for (const [method, path] of [["POST", "rules/12"], ["DELETE", "tail-templates"], ["GET", "tail-template-files/12/extra"]]) {
    assert.equal(allowed(owner, method, `asset-variant-engine/${path}`), false, `${method} ${path}`);
  }
});

test("enterprise administration does not gain platform grant from legacy jobs, tenant role or request selectors", () => {
  for (const role of ["admin", "technical", "manager", "operations"]) {
    const user = { ...owner, roles: [role] };
    assert.equal(allowed(user, "GET", "enterprise/people"), true);
    assert.equal(allowed(user, "POST", "people"), false);
    assert.equal(allowed(user, "POST", "ai-provider/config"), false);
    assert.equal(allowed(user, "POST", "scheduled-jobs/run"), false);
  }
  assert.equal(canAccessPage(owner, "/tenant-people"), true);
  assert.equal(canAccessPage(owner, "/settings"), false);
  for (const slug of ["default", "company-a"]) {
    const enterprise = { ...owner, tenant: { ...owner.tenant, slug } };
    assert.equal(canAccessPage(enterprise, "/finance-center"), true);
    assert.equal(canAccessPage(enterprise, "/finance/payroll"), false);
    assert.equal(canAccessPage(enterprise, "/profit/monthly-billing"), false);
  }
});
