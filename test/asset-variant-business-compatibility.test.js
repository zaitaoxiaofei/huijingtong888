import assert from "node:assert/strict";
import test from "node:test";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const employee = (slug = "default", role = "member", roles = ["operations"]) => ({
  personId: 7, roles, tenant: { id: slug === "default" ? 1 : 42, slug, role }
});
const parts = path => ["api", "asset-variant-engine", ...path.split("/")];
const allowed = (session, method, path) => authorizeApiRequest({ method, _session: session }, parts(path)).allowed;
const configurationReads = ["bootstrap", "tail-templates", "tail-template-files/12"];
const configurationWrites = ["rules", "tail-templates"];
const executionRoutes = [
  ["GET", "selection-publish-shops"], ["GET", "jobs"], ["GET", "jobs/12"], ["GET", "files/job/example.png"],
  ["POST", "publish-selection"], ["POST", "generate"], ["POST", "generate-async"], ["POST", "publish-to-ozon"],
  ["POST", "import-listing-automation"], ["POST", "jobs/12/retry-failures"]
];
const reviewedJobs = new Set(['jobs', 'jobs/12', 'files/job/example.png', 'jobs/12/retry-failures']);

test("default operations members retain reviewed matrix jobs while unverified execution fails closed", () => {
  const session = employee();
  for (const path of configurationReads) {
    assert.equal(allowed(session, "GET", path), true, path);
    assert.equal(tenantIsolationDecision(session, parts(path), "GET").allowed, true, path);
  }
  for (const [method, path] of executionRoutes) {
    assert.equal(allowed(session, method, path), true, path);
    assert.equal(tenantIsolationDecision(session, parts(path), method).allowed, reviewedJobs.has(path), path);
  }
  for (const path of configurationWrites) assert.equal(allowed(session, "POST", path), false, path);
  for (const [method, path] of [...configurationReads.map(path => ["GET", path]), ...executionRoutes]) {
    assert.equal(allowed(employee("default", "member", ["packing"]), method, path), false, path);
  }
});

test("enterprise administrators manage own configuration and operations members use reviewed jobs only", () => {
  for (const slug of ["default", "company-a"]) {
    const session = employee(slug, "owner", ["packing"]);
    for (const path of configurationReads) assert.equal(allowed(session, "GET", path), true, `${slug}: ${path}`);
    for (const path of configurationWrites) assert.equal(allowed(session, "POST", path), true, `${slug}: ${path}`);
  }
  for (const role of ["member", "owner", "admin"]) {
    const session = employee("company-a", role);
    for (const [method, path] of executionRoutes) {
      assert.equal(allowed(session, method, path), reviewedJobs.has(path), path);
      assert.equal(tenantIsolationDecision(session, parts(path), method).allowed, reviewedJobs.has(path), path);
    }
    if (role === "member") {
      for (const path of configurationReads) assert.equal(allowed(session, "GET", path), false, path);
      for (const path of configurationWrites) assert.equal(allowed(session, "POST", path), false, path);
    }
  }
});

test("platform-only accounts still need enterprise context for matrix routes despite platform authorization", () => {
  const session = { personId: 7, roles: [], platform_role: "super_admin", tenant: null };
  for (const [method, path] of [...configurationReads.map(path => ["GET", path]), ...configurationWrites.map(path => ["POST", path]), ...executionRoutes]) {
    assert.equal(tenantIsolationDecision(session, parts(path), method).allowed, false, path);
  }
});
