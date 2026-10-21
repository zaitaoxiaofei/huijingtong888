import assert from "node:assert/strict";
import test from "node:test";
import { effectiveTenantMembershipRole } from "../src/services/tenant-membership-authority.js";

const legacy = { tenant_slug: "default", tenant_role: "owner", business_roles_json: null, legacy_role: "packing", roles_json: null };

test("unreviewed default ownership never grants ordinary legacy staff new enterprise authority", () => {
  for (const role of ["owner", "admin"]) {
    assert.equal(effectiveTenantMembershipRole({ ...legacy, tenant_role: role }), "member");
    assert.equal(effectiveTenantMembershipRole({ ...legacy, tenant_role: role, business_roles_json: undefined }), "member");
  }
  assert.equal(effectiveTenantMembershipRole({ ...legacy, tenant_role: "member" }), "member");
});

test("legacy administrator overrides match existing roles_json semantics and never create platform grants", () => {
  assert.equal(effectiveTenantMembershipRole({ ...legacy, legacy_role: "admin" }), "owner");
  assert.equal(effectiveTenantMembershipRole({ ...legacy, legacy_role: "admin", roles_json: '["packing"]' }), "member");
  assert.equal(effectiveTenantMembershipRole({ ...legacy, legacy_role: "admin", roles_json: "[]" }), "member");
  assert.equal(effectiveTenantMembershipRole({ ...legacy, roles_json: '["technical","admin"]' }), "owner");
  assert.equal(effectiveTenantMembershipRole({ ...legacy, platform_role: "super_admin" }), "member");
});

test("explicit membership jobs and nondefault enterprise ownership retain their deliberate role", () => {
  for (const jobs of ['["packing"]', ["operations"], []]) {
    assert.equal(effectiveTenantMembershipRole({ ...legacy, business_roles_json: jobs }), "owner");
  }
  assert.equal(effectiveTenantMembershipRole({ ...legacy, tenant_slug: "enterprise-a" }), "owner");
});
