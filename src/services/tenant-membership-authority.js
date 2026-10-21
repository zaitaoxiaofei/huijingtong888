import { getRoles } from "../shared/permissions.js";

// The legacy startup assigned every active person an owner row in the default
// enterprise. A NULL member job list must not turn that historical artifact
// into new management permissions. Explicit member jobs mark reviewed/new
// memberships; legacy global admins retain their former enterprise authority.
export function effectiveTenantMembershipRole({ tenant_slug, tenant_role, business_roles_json, legacy_role, roles_json }) {
  if (tenant_slug === "default" && ["owner", "admin"].includes(tenant_role)
    && business_roles_json == null && !getRoles({ role: legacy_role, roles_json }).includes("admin")) {
    return "member";
  }
  return tenant_role;
}
