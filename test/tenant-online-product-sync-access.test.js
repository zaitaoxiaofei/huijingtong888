import assert from "node:assert/strict";
import test from "node:test";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";

const parts = path => ["api", ...path.split("/")];
const session = (id, roles = ["operations"], tenantRole = "member") => ({
  personId: 7, roles, tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}`, role: tenantRole }
});
const routes = [["POST", "sync/online-products"], ["GET", "sync/online-products/status"]];
const allowed = (current, method, path) => authorizeApiRequest({ method, _session: current }, parts(path)).allowed
  && tenantIsolationDecision(current, parts(path), method).allowed;

test("default and A/B enterprise operations use the same two exact online-product sync routes", () => {
  for (const id of [1, 2, 3]) for (const [method, path] of routes) {
    const current = session(id);
    assert.equal(current.platform_role, undefined);
    assert.equal(authorizeApiRequest({ method, _session: current }, parts(path)).allowed, true, `${id} ${method} ${path}`);
    assert.equal(tenantIsolationDecision(current, parts(path), method).allowed, true, `${id} ${method} ${path}`);
  }
});

test("packing, procurement and technical duties cannot acquire online sync through order permissions", () => {
  for (const id of [1, 2, 3]) for (const role of ["packing", "procurement", "technical"]) {
    for (const [method, path] of routes) assert.equal(allowed(session(id, [role]), method, path), false, `${id} ${role} ${path}`);
  }
  for (const role of ["owner", "admin"]) for (const [method, path] of routes) {
    assert.equal(allowed(session(2, [], role), method, path), true, `Enterprise ${role} retains business authority`);
  }
});

test("online sync does not admit missing enterprise context, method aliases or neighboring advanced routes", () => {
  const current = session(2);
  for (const [method, path] of [
    ["GET", "sync/online-products"], ["HEAD", "sync/online-products/status"],
    ["POST", "sync/online-products/status"], ["POST", "sync/online-products/cancel"],
    ["POST", "sync/online-products/extra"], ["GET", "sync/online-products/status/extra"],
    ["POST", "online-products/sync"], ["POST", "sync/ozon-stocks"], ["POST", "sync/ozon-finance"]
  ]) assert.equal(allowed(current, method, path), false, `${method} ${path}`);
  for (const invalid of [{}, { roles: ["operations"] }, { platform_role: "super_admin", tenant: null }]) {
    for (const [method, path] of routes) assert.equal(allowed(invalid, method, path), false);
  }
  assert.equal(allowed(session(2, ["packing"]), "GET", "sync/ozon/status"), true);
  assert.equal(allowed(session(2, ["packing"]), "POST", "sync/ozon"), false);
  assert.equal(allowed(current, "POST", "sync/ozon"), true);
});
