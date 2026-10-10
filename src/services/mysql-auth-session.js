import { ensurePeopleRolesSchemaMysql } from "./people-roles.js";
import { getRoles, primaryRole } from "../shared/permissions.js";
import { isMysqlPrimaryEnabled, mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { ensureTenantSchemaMysql, resolveActiveTenantMysql, tenantHasAccess } from "./tenants.js";

function ensureMysqlAuthSessionEnabled() {
  if (!isMysqlPrimaryEnabled()) {
    throw new Error("MySQL cutover routes are not enabled");
  }
}

function normalizeMysqlDateTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

async function mysqlQueryOne(sql, params = []) {
  const rows = await mysqlQuery(sql, params);
  return rows[0] || null;
}

function ignoreDuplicateSchemaError(error) {
  if (["ER_DUP_FIELDNAME", "ER_DUP_KEYNAME"].includes(error?.code)) return;
  if (/Duplicate column name|Duplicate key name/i.test(error?.message || "")) return;
  throw error;
}

let wechatColumnsReady = false;

async function ensureWechatAuthColumnsMysql() {
  ensureMysqlAuthSessionEnabled();
  if (wechatColumnsReady) return;
  await mysqlExecute("ALTER TABLE people ADD COLUMN wechat_openid VARCHAR(128) NULL").catch(ignoreDuplicateSchemaError);
  await mysqlExecute("ALTER TABLE people ADD COLUMN wechat_unionid VARCHAR(128) NULL").catch(ignoreDuplicateSchemaError);
  await mysqlExecute("ALTER TABLE people ADD COLUMN wechat_nickname VARCHAR(255) NULL").catch(ignoreDuplicateSchemaError);
  await mysqlExecute("ALTER TABLE people ADD COLUMN wechat_bound_at DATETIME NULL").catch(ignoreDuplicateSchemaError);
  await mysqlExecute("CREATE INDEX idx_people_wechat_openid ON people (wechat_openid)").catch(ignoreDuplicateSchemaError);
  await mysqlExecute("CREATE INDEX idx_people_wechat_unionid ON people (wechat_unionid)").catch(ignoreDuplicateSchemaError);
  wechatColumnsReady = true;
}

export async function createSessionMysql(session) {
  ensureMysqlAuthSessionEnabled();
  if (typeof ensureTenantSchemaMysql === "function") await ensureTenantSchemaMysql();
  const expiresAt = normalizeMysqlDateTime(session.expiresAt);
  const tenant = await resolveActiveTenantMysql(session.personId, session.activeTenantId);
  if (!tenant) throw new Error("账号未加入任何企业，请联系平台管理员");

  await mysqlExecute(`
    INSERT INTO sessions (token, person_id, name, role, username, active_tenant_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [session.token, session.personId, session.name, session.role, session.username || null, tenant.id, expiresAt]);

  return session.token;
}

export async function getSessionMysql(token) {
  ensureMysqlAuthSessionEnabled();
  await ensurePeopleRolesSchemaMysql();
  if (typeof ensureTenantSchemaMysql === "function") await ensureTenantSchemaMysql();
  const row = await mysqlQueryOne(`SELECT s.*, p.name AS current_name, p.role AS current_role, p.roles_json,
      t.slug AS tenant_slug, t.name AS tenant_name, t.status AS tenant_status, t.plan_code, t.subscription_status, t.subscription_expires_at, tm.role AS tenant_role
    FROM sessions s JOIN people p ON p.id = s.person_id AND p.active = 1
    JOIN tenant_members tm ON tm.tenant_id = s.active_tenant_id AND tm.person_id = s.person_id AND tm.active = 1
    JOIN tenants t ON t.id = tm.tenant_id AND t.status = 'active' WHERE s.token = ?`, [token]);
  if (!row) return null;

  if (new Date(row.expires_at) < new Date()) {
    await destroySessionMysql(token);
    return null;
  }

  return {
    personId: row.person_id,
    name: row.current_name,
    role: primaryRole({ role: row.current_role, roles_json: row.roles_json }),
    roles: getRoles({ role: row.current_role, roles_json: row.roles_json }),
    username: row.username,
    tenantId: Number(row.active_tenant_id),
    tenant: (() => {
      const tenant = { id: Number(row.active_tenant_id), slug: row.tenant_slug, name: row.tenant_name, status: row.tenant_status, plan_code: row.plan_code, subscription_status: row.subscription_status, subscription_expires_at: row.subscription_expires_at, role: row.tenant_role };
      return { ...tenant, access_allowed: typeof tenantHasAccess === "function" ? tenantHasAccess(tenant) : true };
    })(),
    createdAt: new Date(row.created_at).getTime()
  };
}

export async function destroySessionMysql(token) {
  ensureMysqlAuthSessionEnabled();
  await mysqlExecute("DELETE FROM sessions WHERE token = ?", [token]);
}

export async function destroySessionsByPersonIdMysql(personId, exceptToken = "") {
  ensureMysqlAuthSessionEnabled();
  const params = [personId];
  let sql = "DELETE FROM sessions WHERE person_id = ?";
  if (exceptToken) {
    sql += " AND token <> ?";
    params.push(exceptToken);
  }
  await mysqlExecute(sql, params);
}

export async function cleanExpiredSessionsMysql() {
  ensureMysqlAuthSessionEnabled();
  await mysqlExecute("DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP");
}

export async function findPersonForLoginMysql(username) {
  ensureMysqlAuthSessionEnabled();
  await ensurePeopleRolesSchemaMysql();
  return await mysqlQueryOne(
    "SELECT id, name, username, role, roles_json, password_hash, active FROM people WHERE username = ?",
    [username]
  );
}

export async function findPersonByIdMysql(personId) {
  ensureMysqlAuthSessionEnabled();
  await ensurePeopleRolesSchemaMysql();
  return await mysqlQueryOne(
    "SELECT id, name, username, role, roles_json, avatar_url, active, password_hash FROM people WHERE id = ?",
    [personId]
  );
}

export async function updatePersonPasswordMysql(personId, passwordHash) {
  ensureMysqlAuthSessionEnabled();
  await mysqlExecute("UPDATE people SET password_hash = ? WHERE id = ?", [passwordHash, personId]);
}

export async function updateOwnProfileMysql(personId, body = {}) {
  ensureMysqlAuthSessionEnabled();
  const name = String(body.name || "").trim();
  if (!name) throw new Error("姓名不能为空");
  if (name.length > 100) throw new Error("姓名不能超过 100 个字符");
  const avatarUrl = String(body.avatar_url || body.avatarUrl || "").trim();
  await mysqlExecute(
    "UPDATE people SET name = ?, avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [name, avatarUrl, Number(personId)]
  );
  await mysqlExecute("UPDATE sessions SET name = ? WHERE person_id = ?", [name, Number(personId)]);
  return findPersonByIdMysql(personId);
}

export async function findPersonByWechatIdentityMysql(identity = {}) {
  await ensureWechatAuthColumnsMysql();
  await ensurePeopleRolesSchemaMysql();
  const unionid = String(identity.unionid || "").trim();
  const openid = String(identity.openid || "").trim();
  if (unionid) {
    const row = await mysqlQueryOne(
      "SELECT id, name, username, role, roles_json, active FROM people WHERE wechat_unionid = ? LIMIT 1",
      [unionid]
    );
    if (row) return row;
  }
  if (!openid) return null;
  return await mysqlQueryOne(
    "SELECT id, name, username, role, roles_json, active FROM people WHERE wechat_openid = ? LIMIT 1",
    [openid]
  );
}

export async function updatePersonWechatIdentityMysql(personId, identity = {}) {
  await ensureWechatAuthColumnsMysql();
  const openid = String(identity.openid || "").trim();
  const unionid = String(identity.unionid || "").trim() || null;
  const nickname = String(identity.nickname || "").trim() || null;
  if (!openid) throw new Error("微信身份缺少 openid");
  await mysqlExecute(`
    UPDATE people
    SET wechat_openid = ?, wechat_unionid = ?, wechat_nickname = ?, wechat_bound_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [openid, unionid, nickname, personId]);
}
