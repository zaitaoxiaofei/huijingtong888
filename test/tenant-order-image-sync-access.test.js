import assert from "node:assert/strict";
import test from "node:test";
import { authorizeApiRequest } from "../src/server/authorization.js";
import { tenantIsolationDecision } from "../src/server/tenant-isolation.js";
import { isTenantPilotRoute } from "../src/server/tenant-pilot-routes.js";

const parts = path => ["api", ...path.split("/")];
const session = (id, roles = ["operations"], tenantRole = "member") => ({
  personId: 7, roles, tenant: { id, slug: id === 1 ? "default" : `enterprise-${id}`, role: tenantRole }
});
const allowed = (current, method = "POST", path = "orders/23/sync-images") => authorizeApiRequest({ method, _session: current }, parts(path)).allowed
  && tenantIsolationDecision(current, parts(path), method).allowed;

test("default and A/B enterprises open only the reviewed single-order image mutation", () => {
  for (const id of [1, 2, 3]) {
    assert.equal(allowed(session(id)), true);
    assert.equal(allowed(session(id, ["operator"])), true);
    for (const tenantRole of ["owner", "admin"]) assert.equal(allowed(session(id, [], tenantRole)), true);
  }
});

test("read, packing, procurement and technical duties do not grant image mutation authority", () => {
  for (const id of [1, 2, 3]) {
    for (const roles of [["packing"], ["procurement"], ["technical"], ["packing", "procurement", "technical"], []]) {
      assert.equal(allowed(session(id, roles)), false, `${id}: ${roles.join(",")}`);
    }
  }
});

test("image access needs a current enterprise even for a platform-only account", () => {
  for (const current of [null, {}, { roles: ["operations"] }, { platform_role: "super_admin" }, { ...session(2), tenant: { id: 2 } }]) {
    assert.equal(allowed(current), false);
  }
});

test("tenant route gate rejects batch aliases, invalid identifiers, neighboring paths and other methods", () => {
  for (const [method, path] of [
    ["POST", "orders/sync-images"], ["POST", "orders/batch/sync-images"],
    ["POST", "orders/23,24/sync-images"], ["POST", "orders/-23/sync-images"],
    ["POST", "orders/2.3/sync-images"], ["POST", "orders/2e3/sync-images"],
    ["POST", "orders/23/sync-images/extra"], ["POST", "orders/23/sync-images/"],
    ["POST", "orders/23/sync-images-batch"], ["POST", "orders/23/sync-image"],
    ["GET", "orders/23/sync-images"], ["HEAD", "orders/23/sync-images"],
    ["PUT", "orders/23/sync-images"], ["DELETE", "orders/23/sync-images"]
  ]) {
    assert.equal(isTenantPilotRoute(path, method), false, `${method} ${path}`);
    for (const id of [1, 2, 3]) assert.equal(allowed(session(id), method, path), false, `${id}: ${method} ${path}`);
  }
});

test("existing manual order sync routes retain their business permission boundary", () => {
  for (const path of ["sync/ozon", "sync/ozon/incremental", "sync/ozon/details", "sync/ozon/postings"]) {
    assert.equal(allowed(session(2), "POST", path), true, path);
    assert.equal(allowed(session(2, ["packing"]), "POST", path), false, path);
  }
});
