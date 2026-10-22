import test from "node:test";
import assert from "node:assert/strict";
import { canAccessPage, needsMembershipActivation } from "../src/shared/permissions.js";

const owner = { id: 7, roles: ["operator"], tenant: { id: 8, role: "owner", subscription_status: "unactivated", access_allowed: false } };

test("unactivated and expired members retain basic pages while direct business routes require activation", () => {
  for (const status of ["unactivated", "expired", "suspended"]) {
    const user = { ...owner, tenant: { ...owner.tenant, subscription_status: status } };
    assert.equal(needsMembershipActivation(user), true);
    for (const path of ["/membership", "/tools/pricing", "/tools/profit-calculator"]) assert.equal(canAccessPage(user, path), true, path);
    for (const path of ["/dashboard", "/orders", "/mobile/orders", "/procurement/workspace", "/tenant-people", "/listing-automation", "/settings", "/tenant-management"]) assert.equal(canAccessPage(user, path), false, path);
  }
});

test("active membership restores existing role boundaries without granting platform authority", () => {
  const user = { ...owner, tenant: { ...owner.tenant, subscription_status: "active", access_allowed: true } };
  assert.equal(needsMembershipActivation(user), false);
  for (const path of ["/membership", "/dashboard", "/orders", "/tenant-people"]) assert.equal(canAccessPage(user, path), true, path);
  for (const path of ["/settings", "/tenant-management", "/platform-accounts"]) assert.equal(canAccessPage(user, path), false, path);
  assert.equal(canAccessPage({ roles: ["operator"] }, "/membership"), false);
  assert.equal(canAccessPage({ platform_role: "super_admin", tenant: null }, "/platform-accounts"), true);
});
