export function normalizeRepairPersonIds(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  const ids = values.map(item => Number(String(item).trim()));
  if (!ids.length || ids.length > 200 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("Provide 1-200 explicit positive person IDs with --person-ids.");
  }
  return [...new Set(ids)];
}

export async function inspectDefaultTenantMemberships(query) {
  const platformGrantsReady = await platformGrantSchemaExists(query);
  const tenants = await query("SELECT id FROM tenants WHERE slug = ?", ["default"]);
  const tenantId = Number(tenants[0]?.id || 0);
  if (!tenantId) return { default_tenant_id: null, platform_grants_schema_ready: platformGrantsReady, review_candidates: [] };
  const rows = await query(`SELECT dm.person_id, dm.role AS default_role,
      ${platformGrantsReady ? "pg.role" : "NULL"} AS platform_role, other.tenant_id AS other_tenant_id
    FROM tenant_members dm JOIN people p ON p.id = dm.person_id
    ${platformGrantsReady ? "LEFT JOIN platform_grants pg ON pg.person_id = dm.person_id AND pg.role = 'super_admin' AND pg.active = 1" : ""}
    JOIN tenant_members other ON other.person_id = dm.person_id AND other.tenant_id <> dm.tenant_id AND other.active = 1
    JOIN tenants other_tenant ON other_tenant.id = other.tenant_id AND other_tenant.status = 'active'
    WHERE dm.tenant_id = ? AND dm.active = 1 ORDER BY dm.person_id, other.tenant_id`, [tenantId]);
  const candidates = new Map();
  for (const row of rows) {
    if (row.platform_role === "super_admin") continue;
    const personId = Number(row.person_id);
    if (!candidates.has(personId)) candidates.set(personId, { person_id: personId, default_role: row.default_role, other_tenant_ids: [] });
    candidates.get(personId).other_tenant_ids.push(Number(row.other_tenant_id));
  }
  return { default_tenant_id: tenantId, platform_grants_schema_ready: platformGrantsReady, review_candidates: [...candidates.values()] };
}

async function platformGrantSchemaExists(query) {
  const columns = await query(`SELECT COLUMN_NAME AS column_name FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_grants'
      AND COLUMN_NAME IN ('person_id', 'role', 'active')`);
  const found = new Set(columns.map(row => row.column_name));
  return ["person_id", "role", "active"].every(column => found.has(column));
}

export const membershipRepairLogSchema = `CREATE TABLE IF NOT EXISTS tenant_membership_repair_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  person_id BIGINT UNSIGNED NOT NULL,
  previous_role VARCHAR(32) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  repaired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_tenant_membership_repair_person (person_id, repaired_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

// Caller owns the transaction. IDs are reviewed by an operator, never inferred.
export async function repairDefaultTenantMemberships(connection, selectedIds, reason) {
  const ids = normalizeRepairPersonIds(selectedIds);
  const normalizedReason = String(reason || "").trim();
  if (!normalizedReason || normalizedReason.length > 500) throw new Error("Provide a review reason of 1-500 characters with --reason.");
  if (!await platformGrantSchemaExists(async (sql, params) => (await connection.execute(sql, params))[0])) {
    throw new Error("Migrate the explicit platform_grants schema before applying membership repairs; no legacy administrator role is inferred.");
  }
  const placeholders = ids.map(() => "?").join(",");
  const [platformGrants] = await connection.execute(`SELECT person_id FROM platform_grants
    WHERE person_id IN (${placeholders}) AND role = 'super_admin' AND active = 1 FOR UPDATE`, ids);
  if (platformGrants.length) throw new Error("Platform administrators cannot be removed by this repair tool.");
  const [tenants] = await connection.execute("SELECT id FROM tenants WHERE slug = ? FOR UPDATE", ["default"]);
  const tenantId = Number(tenants[0]?.id || 0);
  if (!tenantId) throw new Error("Default enterprise does not exist.");
  const [members] = await connection.execute(`SELECT dm.person_id, dm.role AS default_role
    FROM tenant_members dm JOIN people p ON p.id = dm.person_id
    WHERE dm.tenant_id = ? AND dm.active = 1 AND dm.person_id IN (${placeholders}) FOR UPDATE`, [tenantId, ...ids]);
  if (members.length !== ids.length) throw new Error("Every selected person must still have an active default-enterprise membership; no changes applied.");
  const [otherMembers] = await connection.execute(`SELECT tm.person_id FROM tenant_members tm
    JOIN tenants t ON t.id = tm.tenant_id AND t.status = 'active'
    WHERE tm.person_id IN (${placeholders}) AND tm.tenant_id <> ? AND tm.active = 1 FOR UPDATE`, [...ids, tenantId]);
  const otherPersonIds = new Set(otherMembers.map(person => Number(person.person_id)));
  if (ids.some(id => !otherPersonIds.has(id))) throw new Error("Every selected person must retain an active membership in another active enterprise.");
  const [updated] = await connection.execute(`UPDATE tenant_members SET active = 0, updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = ? AND person_id IN (${placeholders}) AND active = 1`, [tenantId, ...ids]);
  const [sessions] = await connection.execute(`DELETE FROM sessions
    WHERE person_id IN (${placeholders}) AND (active_tenant_id = ? OR active_tenant_id IS NULL)`, [...ids, tenantId]);
  for (const member of members) {
    await connection.execute(`INSERT INTO tenant_membership_repair_log (tenant_id, person_id, previous_role, reason)
      VALUES (?, ?, ?, ?)`, [tenantId, Number(member.person_id), member.default_role, normalizedReason]);
  }
  return { default_tenant_id: tenantId, deactivated_memberships: Number(updated.affectedRows || 0), revoked_sessions: Number(sessions.affectedRows || 0), person_ids: ids };
}
