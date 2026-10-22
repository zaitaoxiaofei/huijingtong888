import { listingTenantLookup } from "./listing-tenant-scope.js";
import { effectiveTenantMembershipRole } from "./tenant-membership-authority.js";
import { getRoles, hasPermission, primaryRole } from "../shared/permissions.js";

function denied(message) {
  return Object.assign(new Error(message), { status: 403, statusCode: 403, code: "TENANT_TASK_ACCESS_DENIED" });
}

async function queryBusinessTaskMysql(sql, params) {
  const { mysqlQuery } = await import("../mysql-pool.js");
  return mysqlQuery(sql, params);
}

export function businessTaskTenantKey(session) {
  const tenant = session?.tenant;
  if (!Number.isSafeInteger(Number(tenant?.id)) || Number(tenant.id) <= 0 || !String(tenant?.slug || "").trim()) {
    throw denied("当前任务缺少有效企业上下文，请重新登录后重试");
  }
  return listingTenantLookup(tenant.slug === "default" ? "admin" : tenant.id).key;
}

// A persisted task is an enterprise member's operation, never a platform grant.
// Resolve the current membership and subscription again after every restart.
export async function restoreBusinessTaskSession(tenantKey, personId, query = queryBusinessTaskMysql) {
  if (tenantKey === undefined || tenantKey === null || tenantKey === "") {
    throw denied("后台任务未保存企业归属，不能自动恢复执行");
  }
  const lookup = listingTenantLookup(tenantKey);
  const person = Number(personId);
  if (!Number.isSafeInteger(person) || person <= 0) throw denied("后台任务未保存有效操作人员，不能自动恢复执行");
  const rows = await query(`SELECT t.id, t.slug, tm.role AS tenant_role, tm.business_roles_json,
      p.role AS legacy_role, p.roles_json
    FROM tenants t
    JOIN tenant_members tm ON tm.tenant_id = t.id AND tm.person_id = ? AND tm.active = 1
    JOIN people p ON p.id = tm.person_id AND p.active = 1
    WHERE t.${lookup.column} = ? AND t.status = 'active'
      AND t.subscription_status IN ('active', 'trial')
      AND (t.subscription_expires_at IS NULL OR t.subscription_expires_at > UTC_TIMESTAMP())
    LIMIT 1`, [person, lookup.value]);
  const tenant = rows[0];
  if (!tenant) throw denied("任务所属企业、成员或订阅已不可用，请恢复授权后重试");
  const roles = getRoles({ roles: tenant.business_roles_json ?? tenant.roles_json ?? tenant.legacy_role });
  return { personId: person, roles, role: primaryRole(roles), tenant: {
    id: Number(tenant.id), slug: tenant.slug,
    role: effectiveTenantMembershipRole({ ...tenant, tenant_slug: tenant.slug }), business_roles_json: tenant.business_roles_json
  } };
}

export async function authorizeBusinessTaskSession(session, query = queryBusinessTaskMysql) {
  const key = businessTaskTenantKey(session);
  const restored = await restoreBusinessTaskSession(key, session?.personId, query);
  if (Number(restored.tenant.id) !== Number(session.tenant.id) || restored.tenant.slug !== session.tenant.slug) {
    throw denied("任务企业上下文与当前授权不一致");
  }
  return restored;
}

export function assertBusinessTaskPermission(session, permission) {
  if (!hasPermission(session, permission)) throw denied("当前企业岗位已无权执行该后台任务，请联系企业管理员");
}
