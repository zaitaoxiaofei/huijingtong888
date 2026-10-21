import { hasPermission } from "../shared/permissions.js";

// Ordinary accounts join a workspace only through explicit membership management.
// Keep this operation in the caller's transaction so concurrent startup and
// membership changes serialize on the same tenant row.
export async function bootstrapDefaultTenantAccessMysql(connection) {
  const [tenants] = await connection.execute("SELECT id FROM tenants WHERE slug = ? FOR UPDATE", ["default"]);
  const tenantId = Number(tenants[0]?.id || 0);
  if (!tenantId) throw new Error("默认企业不存在，无法初始化平台管理员权限");
  const [people] = await connection.execute("SELECT id, role, roles_json FROM people WHERE active = 1");
  for (const person of people) {
    if (!hasPermission(person, "admin")) continue;
    await connection.execute(`INSERT IGNORE INTO tenant_members (tenant_id, person_id, role)
      VALUES (?, ?, 'owner')`, [tenantId, Number(person.id)]);
  }
  // Legacy sessions may only inherit an already-authorized default membership.
  await connection.execute(`UPDATE sessions s
    JOIN tenant_members tm ON tm.person_id = s.person_id AND tm.tenant_id = ? AND tm.active = 1
    SET s.active_tenant_id = tm.tenant_id WHERE s.active_tenant_id IS NULL`, [tenantId]);
}
