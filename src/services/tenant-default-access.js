// All enterprise memberships, including a platform administrator's, are explicit.
// Startup only repairs legacy session bindings through existing membership.
export async function bootstrapDefaultTenantAccessMysql(connection) {
  const [tenants] = await connection.execute("SELECT id FROM tenants WHERE slug = ? FOR UPDATE", ["default"]);
  const tenantId = Number(tenants[0]?.id || 0);
  if (!tenantId) throw new Error("默认企业不存在，无法初始化平台管理员权限");
  // Legacy sessions may only inherit an already-authorized default membership.
  await connection.execute(`UPDATE sessions s
    JOIN tenant_members tm ON tm.person_id = s.person_id AND tm.tenant_id = ? AND tm.active = 1
    SET s.active_tenant_id = tm.tenant_id WHERE s.active_tenant_id IS NULL`, [tenantId]);
}
