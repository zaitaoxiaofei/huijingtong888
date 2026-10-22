import { withMysqlTransaction } from "../mysql-pool.js";
import { hashPassword, validatePasswordStrength } from "../auth-password.js";
import { getRoles, validateRoles } from "../shared/permissions.js";
import { ensureTenantSchemaMysql } from "./tenants.js";
import { ensurePlatformGrantSchemaMysql } from "./platform-grants.js";
import { assertTenantQuotaAvailable } from "./tenant-quotas.js";
import { effectiveTenantMembershipRole } from "./tenant-membership-authority.js";

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

function accountKindQueryFailure(error) {
  if (error.code === "ER_BAD_FIELD_ERROR" && String(error.sqlMessage || error.message).includes("account_kind")) {
    fail("企业人员的账号类型字段尚未迁移，请联系平台维护人员执行私信数据库迁移", 503);
  }
  throw error;
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) fail(`${label}无效`, 403);
  return id;
}

function requiredText(value, label, limit = 255) {
  const result = String(value ?? "").trim();
  if (!result || result.length > limit) fail(`${label}不能为空且不能超过 ${limit} 个字符`);
  return result;
}

function activeFlag(value) {
  if (![0, 1, "0", "1", false, true].includes(value)) fail("企业成员启用状态必须为 0 或 1（member_active）");
  return Number(value);
}

function membershipInput(body, existing = null) {
  const tenantRole = body.tenant_role ?? body.membership_role ?? body.role ?? existing?.tenant_role ?? "member";
  if (!["owner", "admin", "member"].includes(tenantRole)) fail("企业成员角色必须是负责人、管理员或成员（tenant_role）");
  let roles;
  try { roles = validateRoles(body.business_roles ?? body.roles ?? existing?.business_roles ?? ["operator"]); }
  catch (error) { error.statusCode = 400; throw error; }
  return { role: tenantRole, roles, active: activeFlag(body.member_active ?? body.active ?? existing?.member_active ?? 1) };
}

function rejectPlatformOrLinkFields(body) {
  if (["platform_role", "platform_roles", "platform_grant", "account_active", "roles_json", "business_roles_json", "person_id", "personId", "id"].some(key => body[key] !== undefined)) {
    fail("企业人员接口不能关联现有全局账号或修改平台权限、全局启用状态；请使用当前企业的成员字段", 403);
  }
}

async function requireEnterpriseAdmin(connection, session, lock = false) {
  const tenantId = positiveId(session?.tenant?.id, "当前企业");
  const personId = positiveId(session?.personId, "当前操作账号");
  if (!session?.tenant?.slug) fail("当前登录会话没有有效企业上下文", 403);
  if (!["owner", "admin"].includes(session.tenant.role)) fail("仅当前企业负责人或企业管理员可以管理企业人员", 403);
  const [tenants] = await connection.execute(`SELECT id, slug, status, member_limit FROM tenants WHERE id = ?${lock ? " FOR UPDATE" : ""}`, [tenantId]);
  if (tenants[0]?.status !== "active") fail("当前企业不存在或已停用", 403);
  const [members] = await connection.execute(`SELECT tm.role, tm.business_roles_json, p.role AS legacy_role, p.roles_json FROM tenant_members tm
    JOIN people p ON p.id = tm.person_id AND p.active = 1
    WHERE tm.tenant_id = ? AND tm.person_id = ? AND tm.active = 1`, [tenantId, personId]);
  const role = members[0] && effectiveTenantMembershipRole({ ...members[0], tenant_role: members[0].role, tenant_slug: tenants[0].slug });
  if (!["owner", "admin"].includes(role)) fail("仅当前企业负责人或企业管理员可以管理企业人员", 403);
  return tenants[0];
}

const MEMBER_COLUMNS = `p.id, p.id AS person_id, p.name, p.username, p.avatar_url, t.slug AS tenant_slug,
  p.role AS legacy_role, p.roles_json, p.active AS account_active,
  tm.role AS tenant_role, tm.business_roles_json, tm.active AS member_active, tm.updated_at,
  NOT EXISTS (SELECT 1 FROM tenant_members other WHERE other.person_id = p.id AND other.tenant_id <> tm.tenant_id)
    AND NOT EXISTS (SELECT 1 FROM platform_grants pg WHERE pg.person_id = p.id) AS can_edit_identity`;

function memberResult(row) {
  return {
    id: Number(row.id), person_id: Number(row.person_id), name: row.name, username: row.username,
    avatar_url: row.avatar_url || "", tenant_role: effectiveTenantMembershipRole(row),
    business_roles: getRoles({ roles: row.business_roles_json ?? row.roles_json ?? row.legacy_role }),
    member_active: Number(row.member_active), account_active: Number(row.account_active),
    updated_at: row.updated_at, can_edit_identity: Boolean(Number(row.can_edit_identity))
  };
}

async function memberById(connection, tenantId, personId, lock = false) {
  const [rows] = await connection.execute(`SELECT ${MEMBER_COLUMNS}
    FROM tenant_members tm JOIN people p ON p.id = tm.person_id JOIN tenants t ON t.id = tm.tenant_id
    WHERE tm.tenant_id = ? AND tm.person_id = ? AND p.account_kind = 'person'${lock ? " FOR UPDATE" : ""}`, [tenantId, personId]).catch(accountKindQueryFailure);
  if (!rows[0]) fail("该人员不属于当前企业", 404);
  return memberResult(rows[0]);
}

async function checkOwnerAndQuota(connection, tenant, personId, target) {
  const [rows] = await connection.execute(`SELECT tm.person_id, tm.role, tm.active, tm.business_roles_json, p.role AS legacy_role, p.roles_json, p.active AS account_active
    FROM tenant_members tm JOIN people p ON p.id = tm.person_id WHERE tm.tenant_id = ? FOR UPDATE`, [Number(tenant.id)]);
  const members = rows.map(member => ({ ...member, role: effectiveTenantMembershipRole({ ...member, tenant_role: member.role, tenant_slug: tenant.slug }) }));
  const beforeActive = members.filter(member => Number(member.active) === 1);
  const accountActive = members.find(member => Number(member.person_id) === personId)?.account_active ?? 1;
  const afterActive = [...members.filter(member => Number(member.person_id) !== personId), { person_id: personId, role: target.role, active: target.active, account_active: accountActive }]
    .filter(member => Number(member.active) === 1);
  const beforeOwners = beforeActive.filter(member => member.role === "owner").length;
  const afterOwners = afterActive.filter(member => member.role === "owner").length;
  const beforeLiveOwner = beforeActive.some(member => member.role === "owner" && Number(member.account_active) === 1);
  const afterLiveOwner = afterActive.some(member => member.role === "owner" && Number(member.account_active) === 1);
  if ((beforeOwners && !afterOwners) || (beforeLiveOwner && !afterLiveOwner)) fail("企业必须保留至少一位启用的负责人，请先指定另一位负责人", 409);
  const beforeUsed = beforeActive.length - Number(beforeOwners > 0);
  const afterUsed = afterActive.length - Number(afterOwners > 0);
  if (afterUsed > beforeUsed) assertTenantQuotaAvailable({ label: "子账号", current: afterUsed - 1, limit: tenant.member_limit });
}

async function prepareSchema() {
  await ensureTenantSchemaMysql();
  await ensurePlatformGrantSchemaMysql();
}

export async function listEnterprisePeopleMysql(session) {
  await prepareSchema();
  return withMysqlTransaction(async connection => {
    const tenant = await requireEnterpriseAdmin(connection, session);
    const [rows] = await connection.execute(`SELECT ${MEMBER_COLUMNS}
      FROM tenant_members tm JOIN people p ON p.id = tm.person_id JOIN tenants t ON t.id = tm.tenant_id
      WHERE tm.tenant_id = ? AND p.account_kind = 'person' ORDER BY tm.active DESC, p.id`, [Number(tenant.id)]).catch(accountKindQueryFailure);
    return rows.map(memberResult);
  });
}

export async function createEnterprisePersonMysql(body = {}, session) {
  rejectPlatformOrLinkFields(body);
  const name = requiredText(body.name, "姓名");
  const username = requiredText(body.username, "登录名");
  const target = membershipInput(body);
  const password = String(body.password ?? "");
  try { validatePasswordStrength(password, { name, username }); }
  catch (error) { error.statusCode = 400; throw error; }
  const passwordHash = hashPassword(password);
  await prepareSchema();
  try {
    return await withMysqlTransaction(async connection => {
      const tenant = await requireEnterpriseAdmin(connection, session, true);
      if (body.tenant_id !== undefined && Number(body.tenant_id) !== Number(tenant.id)) fail("只能在当前企业创建人员", 403);
      await checkOwnerAndQuota(connection, tenant, 0, target);
      const [created] = await connection.execute(`INSERT INTO people (name, username, role, roles_json, avatar_url, active, password_hash)
        VALUES (?, ?, 'operator', JSON_ARRAY('operator'), ?, 1, ?)`, [name, username, String(body.avatar_url || "").trim(), passwordHash]);
      const personId = Number(created.insertId);
      await connection.execute(`INSERT INTO tenant_members (tenant_id, person_id, role, business_roles_json, active)
        VALUES (?, ?, ?, ?, ?)`, [Number(tenant.id), personId, target.role, JSON.stringify(target.roles), target.active]);
      return memberById(connection, Number(tenant.id), personId);
    });
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") fail("姓名或登录名无法使用，请更换后重试", 409);
    throw error;
  }
}

export async function updateEnterprisePersonMysql(id, body = {}, session) {
  rejectPlatformOrLinkFields(body);
  const personId = positiveId(id, "企业人员 ID");
  await prepareSchema();
  try {
    return await withMysqlTransaction(async connection => {
      const tenant = await requireEnterpriseAdmin(connection, session, true);
      if (body.tenant_id !== undefined && Number(body.tenant_id) !== Number(tenant.id)) fail("只能管理当前企业人员", 403);
      const existing = await memberById(connection, Number(tenant.id), personId, true);
      if (body.updated_at !== undefined) {
        const expected = new Date(body.updated_at).getTime();
        if (!Number.isFinite(expected) || Math.floor(expected / 1000) !== Math.floor(new Date(existing.updated_at).getTime() / 1000)) {
          fail("企业成员资料已被其他用户修改，请刷新后重试", 409);
        }
      }
      const target = membershipInput(body, existing);
      const name = body.name === undefined ? existing.name : requiredText(body.name, "姓名");
      const username = body.username === undefined ? existing.username : requiredText(body.username, "登录名");
      const avatarUrl = body.avatar_url === undefined ? existing.avatar_url : String(body.avatar_url || "").trim();
      const password = String(body.password ?? "");
      const identityChanged = name !== existing.name || username !== existing.username || avatarUrl !== existing.avatar_url || Boolean(password);
      if (identityChanged) {
        // Current locking reads also protect absent grants and additional member
        // rows from being inserted while an exclusive identity is edited.
        const [memberships] = await connection.execute("SELECT tenant_id FROM tenant_members WHERE person_id = ? FOR UPDATE", [personId]);
        const [grants] = await connection.execute("SELECT person_id FROM platform_grants WHERE person_id = ? FOR UPDATE", [personId]);
        if (memberships.some(member => Number(member.tenant_id) !== Number(tenant.id)) || grants.length) {
          fail("此登录身份同时用于其他企业或平台，企业管理员只能修改本企业成员权限；身份资料请由本人或平台管理员维护", 403);
        }
      }
      if (password) {
        try { validatePasswordStrength(password, { name, username }); }
        catch (error) { error.statusCode = 400; throw error; }
      }
      await checkOwnerAndQuota(connection, tenant, personId, target);
      await connection.execute(`UPDATE tenant_members SET role = ?, business_roles_json = ?, active = ?, updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ? AND person_id = ?`, [target.role, JSON.stringify(target.roles), target.active, Number(tenant.id), personId]);
      if (identityChanged) {
        await connection.execute(`UPDATE people SET name = ?, username = ?, avatar_url = ?, updated_at = CURRENT_TIMESTAMP${password ? ", password_hash = ?" : ""}
          WHERE id = ?`, [name, username, avatarUrl, ...(password ? [hashPassword(password)] : []), personId]);
        await connection.execute("DELETE FROM sessions WHERE person_id = ?", [personId]);
      } else if (target.role !== existing.tenant_role || target.active !== existing.member_active || JSON.stringify(target.roles) !== JSON.stringify(existing.business_roles)) {
        await connection.execute("DELETE FROM sessions WHERE person_id = ? AND active_tenant_id = ?", [personId, Number(tenant.id)]);
      }
      return memberById(connection, Number(tenant.id), personId);
    });
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") fail("姓名或登录名无法使用，请更换后重试", 409);
    throw error;
  }
}
