import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { createHash, randomBytes } from "node:crypto";

const DEFAULT_TENANT_SLUG = "default";
let schemaReady;
const SUBSCRIPTION_PLANS = Object.freeze({
  trial_1d: { code: "trial_1d", label: "1 天体验", days: 1, status: "trial" },
  trial_7d: { code: "trial_7d", label: "7 天体验", days: 7, status: "trial" },
  monthly: { code: "monthly", label: "月租", days: 30, status: "active" },
  yearly: { code: "yearly", label: "年租", days: 365, status: "active" }
});

function text(value, max = 255) {
  return String(value || "").trim().slice(0, max);
}

export async function ensureTenantSchemaMysql() {
  if (!schemaReady) schemaReady = (async () => {
    await mysqlExecute(`CREATE TABLE IF NOT EXISTS tenants (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(80) NOT NULL,
      name VARCHAR(255) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_tenants_slug (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await mysqlExecute(`CREATE TABLE IF NOT EXISTS tenant_members (
      tenant_id BIGINT UNSIGNED NOT NULL,
      person_id BIGINT UNSIGNED NOT NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'member',
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, person_id),
      KEY idx_tenant_members_person (person_id, active),
      KEY idx_tenant_members_tenant (tenant_id, active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await mysqlExecute(`CREATE TABLE IF NOT EXISTS tenant_plugin_tokens (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL,
      label VARCHAR(100) NOT NULL DEFAULT 'Ozon browser plugin',
      created_by_person_id BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at DATETIME NULL,
      UNIQUE KEY uk_tenant_plugin_token_hash (token_hash),
      KEY idx_tenant_plugin_tokens_tenant_active (tenant_id, revoked_at, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    for (const sql of [
      "ALTER TABLE tenants ADD COLUMN plan_code VARCHAR(32) NOT NULL DEFAULT 'trial_7d'",
      "ALTER TABLE tenants ADD COLUMN subscription_status VARCHAR(32) NOT NULL DEFAULT 'trial'",
      "ALTER TABLE tenants ADD COLUMN subscription_expires_at DATETIME NULL",
      "ALTER TABLE tenants ADD COLUMN feature_flags_json JSON NULL"
    ]) await mysqlExecute(sql).catch(error => {
      if (error?.code !== "ER_DUP_FIELDNAME") throw error;
    });
    await mysqlExecute("ALTER TABLE sessions ADD COLUMN active_tenant_id BIGINT UNSIGNED NULL").catch(error => {
      if (error?.code !== "ER_DUP_FIELDNAME") throw error;
    });
    await mysqlExecute("CREATE INDEX idx_sessions_active_tenant ON sessions (active_tenant_id)").catch(error => {
      if (error?.code !== "ER_DUP_KEYNAME") throw error;
    });
    await mysqlExecute("INSERT IGNORE INTO tenants (slug, name, plan_code, subscription_status) VALUES (?, ?, 'yearly', 'active')", [DEFAULT_TENANT_SLUG, "默认企业"]);
    await mysqlExecute(`INSERT IGNORE INTO tenant_members (tenant_id, person_id, role)
      SELECT t.id, p.id, 'owner' FROM tenants t CROSS JOIN people p
      WHERE t.slug = ? AND p.active = 1`, [DEFAULT_TENANT_SLUG]);
    await mysqlExecute(`UPDATE sessions s JOIN tenants t ON t.slug = ?
      SET s.active_tenant_id = t.id WHERE s.active_tenant_id IS NULL`, [DEFAULT_TENANT_SLUG]);
  })().catch(error => {
    schemaReady = null;
    throw error;
  });
  await schemaReady;
}

function subscriptionState(tenant = {}) {
  const status = text(tenant.subscription_status, 32) || "trial";
  const expiresAt = tenant.subscription_expires_at ? new Date(tenant.subscription_expires_at) : null;
  const expired = ["trial", "active"].includes(status) && expiresAt && expiresAt.getTime() <= Date.now();
  const accessAllowed = tenant.status === "active" && !expired && ["trial", "active"].includes(status);
  return { ...tenant, subscription_status: expired ? "expired" : status, access_allowed: accessAllowed };
}

export function tenantHasAccess(tenant = {}) {
  return subscriptionState(tenant).access_allowed;
}

export async function tenantMembershipsMysql(personId) {
  await ensureTenantSchemaMysql();
  const rows = await mysqlQuery(`SELECT t.id, t.slug, t.name, t.status, t.plan_code, t.subscription_status, t.subscription_expires_at, tm.role, tm.active
    FROM tenant_members tm JOIN tenants t ON t.id = tm.tenant_id
    WHERE tm.person_id = ? AND tm.active = 1 AND t.status = 'active'
    ORDER BY t.id`, [Number(personId)]);
  return rows.map(subscriptionState);
}

export async function resolveActiveTenantMysql(personId, requestedTenantId = null) {
  const memberships = await tenantMembershipsMysql(personId);
  const requested = Number(requestedTenantId || 0);
  if (requested) return memberships.find(item => Number(item.id) === requested) || null;
  return memberships[0] || null;
}

export async function listTenantsMysql() {
  await ensureTenantSchemaMysql();
  const rows = await mysqlQuery(`SELECT t.*, COUNT(tm.person_id) AS member_count
    FROM tenants t LEFT JOIN tenant_members tm ON tm.tenant_id = t.id AND tm.active = 1
    GROUP BY t.id ORDER BY t.status = 'active' DESC, t.id`);
  return rows.map(subscriptionState);
}

export async function createTenantMysql(body = {}) {
  await ensureTenantSchemaMysql();
  const name = text(body.name);
  const slug = text(body.slug, 80).toLowerCase();
  if (!name) throw new Error("企业名称不能为空");
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) throw new Error("企业标识只能使用小写字母、数字和连字符");
  const result = await mysqlExecute(`INSERT INTO tenants (slug, name, status, plan_code, subscription_status, subscription_expires_at)
    VALUES (?, ?, 'active', 'trial_7d', 'trial', DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 7 DAY))`, [slug, name]);
  const ownerPersonId = Number(body.owner_person_id || body.ownerPersonId || 0);
  if (ownerPersonId) await mysqlExecute("INSERT INTO tenant_members (tenant_id, person_id, role) VALUES (?, ?, 'owner')", [result.insertId, ownerPersonId]);
  return { ok: true, id: Number(result.insertId) };
}

export async function setTenantSubscriptionMysql(tenantId, body = {}) {
  await ensureTenantSchemaMysql();
  const plan = SUBSCRIPTION_PLANS[text(body.plan_code || body.planCode, 32)];
  const normalizedTenantId = Number(tenantId);
  if (!normalizedTenantId) throw new Error("请选择企业");
  if (!plan && text(body.subscription_status || body.subscriptionStatus) !== "suspended") throw new Error("不支持的套餐");
  const tenantRows = await mysqlQuery("SELECT id FROM tenants WHERE id = ?", [normalizedTenantId]);
  if (!tenantRows[0]) throw new Error("企业不存在");
  if (!plan) {
    await mysqlExecute("UPDATE tenants SET subscription_status = 'suspended', subscription_expires_at = NULL WHERE id = ?", [normalizedTenantId]);
    return { ok: true, subscription_status: "suspended" };
  }
  const expiresAt = new Date(Date.now() + plan.days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  await mysqlExecute("UPDATE tenants SET plan_code = ?, subscription_status = ?, subscription_expires_at = ? WHERE id = ?", [plan.code, plan.status, expiresAt, normalizedTenantId]);
  return { ok: true, plan_code: plan.code, subscription_status: plan.status, subscription_expires_at: expiresAt };
}

export async function archiveTenantMysql(tenantId) {
  await ensureTenantSchemaMysql();
  const normalizedTenantId = Number(tenantId);
  if (!normalizedTenantId) throw new Error("请选择企业");
  const rows = await mysqlQuery("SELECT id, slug FROM tenants WHERE id = ?", [normalizedTenantId]);
  if (!rows[0]) throw new Error("企业不存在");
  if (rows[0].slug === DEFAULT_TENANT_SLUG) throw new Error("默认企业不能删除");
  await mysqlExecute("UPDATE tenants SET status = 'archived', subscription_status = 'suspended', subscription_expires_at = NULL WHERE id = ?", [normalizedTenantId]);
  await mysqlExecute("UPDATE tenant_members SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?", [normalizedTenantId]);
  return { ok: true };
}

export { SUBSCRIPTION_PLANS };

export async function tenantMembersMysql(tenantId) {
  await ensureTenantSchemaMysql();
  return mysqlQuery(`SELECT tm.tenant_id, tm.person_id, tm.role, tm.active, p.name, p.username
    FROM tenant_members tm JOIN people p ON p.id = tm.person_id
    WHERE tm.tenant_id = ? AND tm.active = 1 ORDER BY p.id`, [Number(tenantId)]);
}

export async function upsertTenantMemberMysql(tenantId, body = {}) {
  await ensureTenantSchemaMysql();
  const normalizedTenantId = Number(tenantId);
  const personId = Number(body.person_id || body.personId || 0);
  const role = text(body.role, 32) || "member";
  if (!normalizedTenantId || !personId) throw new Error("请选择企业和成员");
  if (!['owner', 'admin', 'member'].includes(role)) throw new Error("企业成员角色无效");
  const [tenantRows, peopleRows] = await Promise.all([
    mysqlQuery("SELECT id FROM tenants WHERE id = ? AND status = 'active'", [normalizedTenantId]),
    mysqlQuery("SELECT id FROM people WHERE id = ?", [personId])
  ]);
  if (!tenantRows[0]) throw new Error("企业不存在或已停用");
  if (!peopleRows[0]) throw new Error("成员不存在");
  await mysqlExecute(`INSERT INTO tenant_members (tenant_id, person_id, role, active) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE role = VALUES(role), active = VALUES(active), updated_at = CURRENT_TIMESTAMP`,
  [normalizedTenantId, personId, role, Number(body.active ?? 1)]);
  return { ok: true };
}

export async function switchSessionTenantMysql(token, personId, tenantId) {
  const tenant = await resolveActiveTenantMysql(personId, tenantId);
  if (!tenant) throw new Error("无权切换到该企业");
  await mysqlExecute("UPDATE sessions SET active_tenant_id = ? WHERE token = ? AND person_id = ?", [tenant.id, token, Number(personId)]);
  return tenant;
}

function hashTenantPluginToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

async function requireTenantPluginAdminMysql(tenantId, personId, isPlatformAdmin) {
  await ensureTenantSchemaMysql();
  const normalizedTenantId = Number(tenantId);
  const normalizedPersonId = Number(personId);
  if (!normalizedTenantId || !normalizedPersonId) throw new Error("请选择企业和当前操作账号");
  const rows = await mysqlQuery(`SELECT t.id, t.slug, t.status, tm.role AS member_role
    FROM tenants t
    LEFT JOIN tenant_members tm ON tm.tenant_id = t.id AND tm.person_id = ? AND tm.active = 1
    WHERE t.id = ? LIMIT 1`, [normalizedPersonId, normalizedTenantId]);
  const tenant = rows[0];
  if (!tenant || tenant.status !== "active") throw new Error("企业不存在或已停用");
  if (tenant.slug === DEFAULT_TENANT_SLUG && !isPlatformAdmin) throw new Error("默认企业插件令牌仅平台管理员可以管理");
  if (!isPlatformAdmin && !["owner", "admin"].includes(tenant.member_role)) throw new Error("仅企业负责人或企业管理员可以管理插件令牌");
  return { ...tenant, id: normalizedTenantId };
}

export async function issueTenantPluginTokenMysql(tenantId, personId, { isPlatformAdmin = false } = {}) {
  const tenant = await requireTenantPluginAdminMysql(tenantId, personId, isPlatformAdmin);
  const token = `ozp_${randomBytes(32).toString("base64url")}`;
  await withMysqlTransaction(async (connection) => {
    await connection.execute("SELECT id FROM tenants WHERE id = ? FOR UPDATE", [tenant.id]);
    await connection.execute("UPDATE tenant_plugin_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND revoked_at IS NULL", [tenant.id]);
    await connection.execute(`INSERT INTO tenant_plugin_tokens (tenant_id, token_hash, created_by_person_id)
      VALUES (?, ?, ?)`, [tenant.id, hashTenantPluginToken(token), Number(personId)]);
  });
  return { ok: true, tenant_id: tenant.id, token };
}

export async function tenantPluginTokenStatusMysql(tenantId, personId, options = {}) {
  const tenant = await requireTenantPluginAdminMysql(tenantId, personId, options.isPlatformAdmin === true);
  const rows = await mysqlQuery(`SELECT id, label, created_at FROM tenant_plugin_tokens
    WHERE tenant_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`, [tenant.id]);
  return { configured: Boolean(rows[0]), created_at: rows[0]?.created_at || null, label: rows[0]?.label || "" };
}

export async function revokeTenantPluginTokenMysql(tenantId, personId, options = {}) {
  const tenant = await requireTenantPluginAdminMysql(tenantId, personId, options.isPlatformAdmin === true);
  await mysqlExecute("UPDATE tenant_plugin_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND revoked_at IS NULL", [tenant.id]);
  return { ok: true };
}

export async function resolveTenantPluginTokenMysql(token) {
  const normalizedToken = String(token || "").trim();
  if (!/^ozp_[A-Za-z0-9_-]{40,80}$/.test(normalizedToken)) return null;
  await ensureTenantSchemaMysql();
  const rows = await mysqlQuery(`SELECT t.id, t.slug, t.status, t.plan_code, t.subscription_status, t.subscription_expires_at
    FROM tenant_plugin_tokens pt JOIN tenants t ON t.id = pt.tenant_id
    WHERE pt.token_hash = ? AND pt.revoked_at IS NULL AND t.status = 'active' LIMIT 1`, [hashTenantPluginToken(normalizedToken)]);
  const tenant = rows[0];
  if (!tenant || !tenantHasAccess(tenant)) return null;
  return {
    tenantId: Number(tenant.id),
    tenantKey: tenant.slug === DEFAULT_TENANT_SLUG ? "admin" : String(tenant.id),
    tenantSlug: tenant.slug
  };
}
