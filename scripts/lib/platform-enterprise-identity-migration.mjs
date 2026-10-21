import { getRoles, validateRoles } from "../../src/shared/permissions.js";
import { effectiveTenantMembershipRole } from "../../src/services/tenant-membership-authority.js";

function positiveId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be an explicit positive integer.`);
  return value;
}

export function normalizeIdentityManifest(manifest) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.accounts) || !manifest.accounts.length || manifest.accounts.length > 200) {
    throw new Error("A version 1 manifest with 1-200 reviewed account records is required.");
  }
  const reviewer = positiveId(manifest.reviewed_by_person_id, "reviewed_by_person_id");
  const reason = String(manifest.reason || "").trim();
  if (!reason || reason.length > 500) throw new Error("A review reason of 1-500 characters is required.");
  const seen = new Set();
  const accounts = manifest.accounts.map(account => {
    const personId = positiveId(account.person_id, "person_id");
    if (seen.has(personId)) throw new Error("A person_id may appear only once in a reviewed manifest.");
    seen.add(personId);
    if (![null, "super_admin"].includes(account.platform_role)) throw new Error("Every account must explicitly specify platform_role as super_admin or null.");
    if (!Array.isArray(account.memberships)) throw new Error("Every account must explicitly list its desired enterprise memberships.");
    if (!account.platform_role && !account.memberships.length) throw new Error("Enterprise-only accounts must retain at least one explicit membership.");
    const tenantIds = new Set();
    const memberships = account.memberships.map(member => {
      const tenantId = positiveId(member.tenant_id, "tenant_id");
      if (tenantIds.has(tenantId)) throw new Error("Duplicate enterprise membership in reviewed manifest.");
      tenantIds.add(tenantId);
      if (!["owner", "admin", "member"].includes(member.role)) throw new Error("Membership role must be owner, admin, or member.");
      if (![0, 1].includes(member.active)) throw new Error("Every membership must explicitly specify active as 0 or 1.");
      return { tenant_id: tenantId, role: member.role, active: member.active, business_roles: validateRoles(member.business_roles) };
    });
    return { person_id: personId, platform_role: account.platform_role, memberships };
  });
  return { version: 1, reviewed_by_person_id: reviewer, reason, accounts };
}

export async function inspectIdentitySeparation(query, rawManifest = null) {
  const manifest = rawManifest ? normalizeIdentityManifest(rawManifest) : null;
  const ids = manifest?.accounts.map(account => account.person_id) || [];
  const filter = ids.length ? ` WHERE id IN (${ids.map(() => "?").join(",")})` : "";
  const people = await query(`SELECT id, active, role, roles_json FROM people${filter} ORDER BY id`, ids);
  const grantTable = await query("SHOW TABLES LIKE 'platform_grants'");
  const memberColumns = await query("SHOW COLUMNS FROM tenant_members LIKE 'business_roles_json'");
  const grants = grantTable.length ? await query("SELECT person_id, role, active FROM platform_grants ORDER BY person_id") : [];
  const members = await query(`SELECT tm.person_id, tm.tenant_id, tm.role, tm.active, t.slug AS tenant_slug${memberColumns.length ? ", tm.business_roles_json" : ""}
    FROM tenant_members tm JOIN tenants t ON t.id = tm.tenant_id ORDER BY tm.person_id, tm.tenant_id`);
  return {
    changes_database: false,
    schema_ready: Boolean(grantTable.length && memberColumns.length),
    accounts: people.map(person => ({
      person_id: Number(person.id), account_active: Number(person.active), legacy_business_roles: getRoles(person),
      platform_grant: grants.find(grant => Number(grant.person_id) === Number(person.id)) || null,
      memberships: members.filter(member => Number(member.person_id) === Number(person.id)).map(member => ({
        tenant_id: Number(member.tenant_id), stored_role: member.role,
        role: effectiveTenantMembershipRole({ ...member, tenant_role: member.role, legacy_role: person.role, roles_json: person.roles_json }), active: Number(member.active),
        business_roles: getRoles({ roles: member.business_roles_json ?? person.roles_json ?? person.role })
      })),
      proposed: manifest?.accounts.find(account => account.person_id === Number(person.id)) || null
    })),
    missing_person_ids: ids.filter(id => !people.some(person => Number(person.id) === id))
  };
}

export const IDENTITY_MIGRATION_LOG_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS platform_identity_migration_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  person_id BIGINT UNSIGNED NOT NULL,
  reviewed_by_person_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(500) NOT NULL,
  previous_grant_json JSON NULL,
  previous_memberships_json JSON NOT NULL,
  desired_identity_json JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_platform_identity_migration_person (person_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

function membershipShape(member) {
  return { tenant_id: Number(member.tenant_id), role: member.role, active: Number(member.active),
    business_roles: getRoles({ roles: member.business_roles_json ?? [] }) };
}

// The caller owns a transaction. Only reviewed person IDs are changed; people
// identities and all operational references remain intact.
export async function applyIdentitySeparationMysql(connection, rawManifest) {
  const manifest = normalizeIdentityManifest(rawManifest);
  const ids = manifest.accounts.map(account => account.person_id);
  const placeholders = ids.map(() => "?").join(",");
  // Member management locks a tenant before writing. Lock all tenant rows for
  // this bounded administrative migration before validating its final state.
  const [tenants] = await connection.execute("SELECT id, slug, status, member_limit FROM tenants ORDER BY id FOR UPDATE");
  const peopleIds = [...new Set([...ids, manifest.reviewed_by_person_id])];
  const [people] = await connection.execute(`SELECT id, active, role, roles_json FROM people WHERE id IN (${peopleIds.map(() => "?").join(",")}) ORDER BY id FOR UPDATE`, peopleIds);
  if (people.length !== peopleIds.length || !people.some(person => Number(person.id) === manifest.reviewed_by_person_id && Number(person.active) === 1)) {
    throw new Error("All reviewed person IDs and an active reviewer must exist; no identity changes applied.");
  }
  const [grants] = await connection.execute(`SELECT pg.person_id, pg.role, pg.active, p.active AS account_active
    FROM platform_grants pg JOIN people p ON p.id = pg.person_id ORDER BY pg.person_id FOR UPDATE`);
  const [members] = await connection.execute(`SELECT tm.person_id, tm.tenant_id, tm.role, tm.active, tm.business_roles_json, p.role AS legacy_role, p.roles_json, p.active AS account_active
    FROM tenant_members tm JOIN people p ON p.id = tm.person_id ORDER BY tm.tenant_id, tm.person_id FOR UPDATE`);
  const desiredGrants = new Map(grants.map(grant => [Number(grant.person_id), Boolean(Number(grant.active) && Number(grant.account_active) && grant.role === "super_admin")]));
  for (const account of manifest.accounts) {
    if (account.platform_role && !people.some(person => Number(person.id) === account.person_id && Number(person.active) === 1)) {
      throw new Error("An inactive global account cannot receive an active platform grant.");
    }
    desiredGrants.set(account.person_id, account.platform_role === "super_admin");
    if (account.memberships.some(member => {
      const tenant = tenants.find(tenant => Number(tenant.id) === member.tenant_id);
      const previous = members.find(item => Number(item.person_id) === account.person_id && Number(item.tenant_id) === member.tenant_id);
      const preservesInactive = member.active === 0 && Number(previous?.active) === 0;
      return !tenant || (tenant.status !== "active" && !preservesInactive);
    })) {
      throw new Error("Desired enterprise memberships must target existing active enterprises; existing inactive memberships may remain inactive in archived enterprises.");
    }
  }
  if (![...desiredGrants.values()].some(Boolean)) throw new Error("The final state must retain at least one active platform super administrator.");
  const changedIds = [];
  const desiredMembers = members.filter(member => !ids.includes(Number(member.person_id)));
  for (const account of manifest.accounts) desiredMembers.push(...account.memberships.map(member => ({ ...member, person_id: account.person_id,
    account_active: Number(people.find(person => Number(person.id) === account.person_id).active), business_roles_json: JSON.stringify(member.business_roles) })));
  const affectedTenantIds = new Set([...members.filter(member => ids.includes(Number(member.person_id))).map(member => Number(member.tenant_id)), ...manifest.accounts.flatMap(account => account.memberships.map(member => member.tenant_id))]);
  for (const tenant of tenants.filter(item => affectedTenantIds.has(Number(item.id)))) {
    const before = members.filter(member => Number(member.tenant_id) === Number(tenant.id) && Number(member.active) === 1);
    const after = desiredMembers.filter(member => Number(member.tenant_id) === Number(tenant.id) && Number(member.active) === 1);
    const isOwner = member => effectiveTenantMembershipRole({ ...member, tenant_slug: tenant.slug, tenant_role: member.role }) === "owner";
    const beforeOwner = before.some(isOwner);
    const afterOwner = after.some(isOwner);
    const beforeLiveOwner = before.some(member => isOwner(member) && Number(member.account_active) === 1);
    const afterLiveOwner = after.some(member => isOwner(member) && Number(member.account_active) === 1);
    if ((beforeOwner && !afterOwner) || (beforeLiveOwner && !afterLiveOwner)) throw new Error("Migration cannot remove the last active enterprise owner.");
    const beforeUsed = before.length - Number(beforeOwner);
    const afterUsed = after.length - Number(afterOwner);
    if (afterUsed > beforeUsed && tenant.member_limit != null && afterUsed > Number(tenant.member_limit)) throw new Error("Desired memberships exceed an enterprise sub-account quota.");
  }
  for (const account of manifest.accounts) {
    const previousGrant = grants.find(grant => Number(grant.person_id) === account.person_id) || null;
    const previousMembers = members.filter(member => Number(member.person_id) === account.person_id);
    const desiredTenantIds = new Set(account.memberships.map(member => member.tenant_id));
    const previousActiveGrant = previousGrant?.role === "super_admin" && Number(previousGrant.active) === 1;
    let changed = Boolean(previousActiveGrant) !== Boolean(account.platform_role);
    if (account.platform_role) {
      await connection.execute(`INSERT INTO platform_grants (person_id, role, active, granted_by_person_id, reason)
        VALUES (?, 'super_admin', 1, ?, ?) ON DUPLICATE KEY UPDATE role = 'super_admin', active = 1,
        granted_by_person_id = VALUES(granted_by_person_id), reason = VALUES(reason), updated_at = CURRENT_TIMESTAMP`,
      [account.person_id, manifest.reviewed_by_person_id, manifest.reason]);
    } else if (previousGrant) {
      await connection.execute("UPDATE platform_grants SET active = 0, granted_by_person_id = ?, reason = ?, updated_at = CURRENT_TIMESTAMP WHERE person_id = ?", [manifest.reviewed_by_person_id, manifest.reason, account.person_id]);
    }
    for (const member of previousMembers.filter(member => !desiredTenantIds.has(Number(member.tenant_id)))) {
      if (Number(member.active) === 1) changed = true;
      await connection.execute("UPDATE tenant_members SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND person_id = ?", [Number(member.tenant_id), account.person_id]);
    }
    for (const member of account.memberships) {
      const previous = previousMembers.find(item => Number(item.tenant_id) === member.tenant_id);
      if (!previous || JSON.stringify(membershipShape(previous)) !== JSON.stringify(member)) changed = true;
      await connection.execute(`INSERT INTO tenant_members (tenant_id, person_id, role, business_roles_json, active)
        VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role), business_roles_json = VALUES(business_roles_json),
        active = VALUES(active), updated_at = CURRENT_TIMESTAMP`, [member.tenant_id, account.person_id, member.role, JSON.stringify(member.business_roles), member.active]);
    }
    if (changed) changedIds.push(account.person_id);
    await connection.execute(`INSERT INTO platform_identity_migration_log
      (person_id, reviewed_by_person_id, reason, previous_grant_json, previous_memberships_json, desired_identity_json)
      VALUES (?, ?, ?, ?, ?, ?)`, [account.person_id, manifest.reviewed_by_person_id, manifest.reason,
      previousGrant ? JSON.stringify(previousGrant) : null, JSON.stringify(previousMembers), JSON.stringify(account)]);
  }
  if (changedIds.length) await connection.execute(`DELETE FROM sessions WHERE person_id IN (${changedIds.map(() => "?").join(",")})`, changedIds);
  return { changed_person_ids: changedIds, reviewed_person_ids: ids, preserved_person_ids: true, revoked_changed_account_sessions: true };
}
