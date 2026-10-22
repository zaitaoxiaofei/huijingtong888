import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { createHash, randomBytes } from "node:crypto";
import { assertTenantQuotaAvailable, normalizeTenantQuotaLimit } from "./tenant-quotas.js";
import { DEFAULT_TENANT_PLAN_PRESETS, normalizeTenantPlanInput, tenantPlanMemberLimit } from "./tenant-plans.js";
import { decryptTenantPluginToken, encryptTenantPluginToken, tenantPluginTokenEncryptionConfigured } from "./tenant-plugin-token-crypto.js";
import { ensurePeopleRolesSchemaMysql } from "./people-roles.js";
import { bootstrapDefaultTenantAccessMysql } from "./tenant-default-access.js";
import { ensurePlatformGrantSchemaMysql } from "./platform-grants.js";
import { getRoles } from "../shared/permissions.js";
import { effectiveTenantMembershipRole } from "./tenant-membership-authority.js";
import { TENANT_AI_LIMITS_SCHEMA } from "./ai-tenant-schema.js";

const DEFAULT_TENANT_SLUG = "default";
let schemaReady;

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
      business_roles_json JSON NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, person_id),
      KEY idx_tenant_members_person (person_id, active),
      KEY idx_tenant_members_tenant (tenant_id, active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await mysqlExecute("ALTER TABLE tenant_members ADD COLUMN business_roles_json JSON NULL").catch(error => {
      if (error?.code !== "ER_DUP_FIELDNAME") throw error;
    });
    await mysqlExecute(`CREATE TABLE IF NOT EXISTS tenant_plugin_tokens (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL,
      token_ciphertext VARCHAR(255) NULL,
      label VARCHAR(100) NOT NULL DEFAULT 'Ozon browser plugin',
      created_by_person_id BIGINT UNSIGNED NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at DATETIME NULL,
      UNIQUE KEY uk_tenant_plugin_token_hash (token_hash),
      KEY idx_tenant_plugin_tokens_tenant_active (tenant_id, revoked_at, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await mysqlExecute("ALTER TABLE tenant_plugin_tokens ADD COLUMN token_ciphertext VARCHAR(255) NULL").catch(error => {
      if (error?.code !== "ER_DUP_FIELDNAME") throw error;
    });
    await mysqlExecute(`CREATE TABLE IF NOT EXISTS tenant_activation_codes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      tenant_id BIGINT UNSIGNED NOT NULL,
      code_hash CHAR(64) NOT NULL,
      code_hint VARCHAR(12) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      expires_at DATETIME NULL,
      created_by_person_id BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at DATETIME NULL,
      UNIQUE KEY uk_tenant_activation_code_hash (code_hash),
      KEY idx_tenant_activation_codes_tenant (tenant_id, status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await mysqlExecute(`CREATE TABLE IF NOT EXISTS tenant_plans (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(32) NOT NULL,
      name VARCHAR(80) NOT NULL,
      duration_days INT UNSIGNED NOT NULL,
      subscription_status VARCHAR(16) NOT NULL DEFAULT 'active',
      account_limit INT UNSIGNED NULL,
      shop_limit INT UNSIGNED NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      is_builtin TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_tenant_plans_code (code),
      KEY idx_tenant_plans_active (active, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    for (const plan of DEFAULT_TENANT_PLAN_PRESETS) {
      await mysqlExecute(`INSERT IGNORE INTO tenant_plans
        (code, name, duration_days, subscription_status, account_limit, shop_limit, active, is_builtin)
        VALUES (?, ?, ?, ?, ?, ?, 1, 1)`, [plan.code, plan.name, plan.duration_days, plan.subscription_status, plan.account_limit, plan.shop_limit]);
    }
    for (const sql of [
      "ALTER TABLE tenants ADD COLUMN plan_code VARCHAR(32) NOT NULL DEFAULT 'trial_7d'",
      "ALTER TABLE tenants ADD COLUMN subscription_status VARCHAR(32) NOT NULL DEFAULT 'trial'",
      "ALTER TABLE tenants ADD COLUMN subscription_expires_at DATETIME NULL",
      "ALTER TABLE tenants ADD COLUMN feature_flags_json JSON NULL",
      "ALTER TABLE tenants ADD COLUMN member_limit INT UNSIGNED NULL",
      "ALTER TABLE tenants ADD COLUMN shop_limit INT UNSIGNED NULL"
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
    await ensurePeopleRolesSchemaMysql();
    await ensurePlatformGrantSchemaMysql();
    await withMysqlTransaction(bootstrapDefaultTenantAccessMysql);
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
  const rows = await mysqlQuery(`SELECT t.id, t.slug, t.name, t.status, t.plan_code, t.subscription_status, t.subscription_expires_at, tm.role, tm.active, tm.business_roles_json,
      p.role AS legacy_role, p.roles_json
    FROM tenant_members tm JOIN tenants t ON t.id = tm.tenant_id JOIN people p ON p.id = tm.person_id
    WHERE tm.person_id = ? AND tm.active = 1 AND t.status = 'active'
    ORDER BY t.id`, [Number(personId)]);
  return rows.map(row => {
    const { legacy_role, roles_json, ...membership } = row;
    return subscriptionState({ ...membership, role: effectiveTenantMembershipRole({
      tenant_slug: row.slug, tenant_role: row.role, business_roles_json: row.business_roles_json, legacy_role, roles_json
    }) });
  });
}

export async function resolveActiveTenantMysql(personId, requestedTenantId = null) {
  const memberships = await tenantMembershipsMysql(personId);
  const requested = Number(requestedTenantId || 0);
  if (requested) return memberships.find(item => Number(item.id) === requested) || null;
  return memberships[0] || null;
}

export async function listTenantsMysql() {
  await ensureTenantSchemaMysql();
  const rows = await mysqlQuery(`SELECT t.*,
      (SELECT COUNT(*) FROM tenant_members tm WHERE tm.tenant_id = t.id AND tm.active = 1) AS member_count,
      (SELECT COUNT(*) FROM tenant_members tm WHERE tm.tenant_id = t.id AND tm.active = 1 AND tm.person_id <> COALESCE(
        (SELECT MIN(owner.person_id) FROM tenant_members owner WHERE owner.tenant_id = t.id AND owner.active = 1 AND owner.role = 'owner'), 0)) AS sub_account_count,
      (SELECT COUNT(*) FROM shops s WHERE (s.tenant_id = t.id OR (t.slug = 'default' AND s.tenant_id IS NULL)) AND s.status != 'deleted') AS shop_count
    FROM tenants t ORDER BY t.status = 'active' DESC, t.id`);
  return rows.map(subscriptionState);
}

export async function createTenantMysql(body = {}) {
  await ensureTenantSchemaMysql();
  const name = text(body.name);
  const slug = text(body.slug, 80).toLowerCase();
  if (!name) throw new Error("企业名称不能为空");
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) throw new Error("企业标识只能使用小写字母、数字和连字符");
  const planCode = text(body.plan_code || body.planCode, 32) || "trial_7d";
  const plans = await mysqlQuery("SELECT * FROM tenant_plans WHERE code = ? AND active = 1 LIMIT 1", [planCode]);
  const plan = plans[0];
  if (!plan) throw new Error("请选择一个有效套餐；套餐可在企业管理的套餐目录中启用或编辑");
  const memberLimit = tenantPlanMemberLimit(plan);
  const ownerPersonId = Number(body.owner_person_id || body.ownerPersonId || 0);
  const activationCode = generateTenantActivationCode();
  const result = await withMysqlTransaction(async connection => {
    const [tenantResult] = await connection.execute(`INSERT INTO tenants (slug, name, status, plan_code, subscription_status, subscription_expires_at, member_limit, shop_limit)
      VALUES (?, ?, 'active', ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? DAY), ?, ?)`, [slug, name, plan.code, plan.subscription_status, Number(plan.duration_days), memberLimit, plan.shop_limit]);
    const tenantId = Number(tenantResult.insertId);
    if (ownerPersonId) await connection.execute("INSERT INTO tenant_members (tenant_id, person_id, role) VALUES (?, ?, 'owner')", [tenantId, ownerPersonId]);
    await connection.execute(`INSERT INTO tenant_activation_codes
      (tenant_id, code_hash, code_hint, status, expires_at, created_by_person_id)
      VALUES (?, ?, ?, 'active', DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? DAY), ?)`, [tenantId, hashTenantActivationCode(activationCode), activationCode.slice(-6), Number(plan.duration_days), Number(body.created_by_person_id || 0) || null]);
    return tenantId;
  });
  return { ok: true, id: result, activation_code: activationCode };
}

function generateTenantActivationCode() {
  return `OZ-${randomBytes(24).toString("hex").toUpperCase()}`;
}

function hashTenantActivationCode(code) {
  return createHash("sha256").update(String(code || "").trim().toUpperCase()).digest("hex");
}

export async function tenantActivationCodeStatusMysql(tenantId) {
  await ensureTenantSchemaMysql();
  const normalizedTenantId = Number(tenantId);
  if (!Number.isSafeInteger(normalizedTenantId) || normalizedTenantId <= 0) throw new Error("请选择有效客户空间");
  const rows = await mysqlQuery(`SELECT c.id, c.tenant_id, c.code_hint, c.status, c.expires_at, c.created_at, c.revoked_at,
      t.status AS tenant_status, t.subscription_status
    FROM tenant_activation_codes c JOIN tenants t ON t.id = c.tenant_id
    WHERE c.tenant_id = ? ORDER BY c.id DESC LIMIT 1`, [normalizedTenantId]);
  const row = rows[0];
  if (!row) return { configured: false };
  const expired = row.status === "active" && row.expires_at && new Date(row.expires_at).getTime() <= Date.now();
  const unavailable = row.tenant_status !== "active" || !["active", "trial"].includes(row.subscription_status);
  return { configured: true, ...row, status: unavailable ? "unavailable" : expired ? "expired" : row.status };
}

export async function issueTenantActivationCodeMysql(tenantId, personId = null) {
  await ensureTenantSchemaMysql();
  const normalizedTenantId = Number(tenantId);
  if (!Number.isSafeInteger(normalizedTenantId) || normalizedTenantId <= 0) throw new Error("请选择有效客户空间");
  const code = generateTenantActivationCode();
  await withMysqlTransaction(async connection => {
    const [tenants] = await connection.execute("SELECT id, status, subscription_status, subscription_expires_at FROM tenants WHERE id = ? FOR UPDATE", [normalizedTenantId]);
    const tenant = tenants[0];
    if (!tenant) throw new Error("客户空间不存在");
    if (tenant.status !== "active") throw new Error("客户空间已归档，不能生成激活码");
    if (!["active", "trial"].includes(tenant.subscription_status)) throw new Error("客户空间套餐已暂停，请先恢复授权再生成激活码");
    if (tenant.subscription_expires_at && new Date(tenant.subscription_expires_at).getTime() <= Date.now()) throw new Error("客户空间套餐已到期，请先续费再生成激活码");
    await connection.execute("UPDATE tenant_activation_codes SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND status = 'active'", [normalizedTenantId]);
    await connection.execute(`INSERT INTO tenant_activation_codes
      (tenant_id, code_hash, code_hint, status, expires_at, created_by_person_id)
      VALUES (?, ?, ?, 'active', ?, ?)`, [normalizedTenantId, hashTenantActivationCode(code), code.slice(-6), tenant.subscription_expires_at, Number(personId) || null]);
  });
  return { ok: true, activation_code: code };
}

export async function revokeTenantActivationCodeMysql(tenantId) {
  await ensureTenantSchemaMysql();
  const normalizedTenantId = Number(tenantId);
  if (!Number.isSafeInteger(normalizedTenantId) || normalizedTenantId <= 0) throw new Error("请选择有效客户空间");
  const result = await mysqlExecute("UPDATE tenant_activation_codes SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND status = 'active'", [normalizedTenantId]);
  return { ok: true, revoked: Number(result.affectedRows || 0) };
}

export async function setTenantQuotasMysql(tenantId, body = {}) {
  await ensureTenantSchemaMysql();
  const normalizedTenantId = Number(tenantId);
  if (!Number.isSafeInteger(normalizedTenantId) || normalizedTenantId <= 0) {
    const error = new Error("请选择有效企业");
    error.statusCode = 400;
    throw error;
  }
  const updatesAi = Object.hasOwn(body, "monthly_ai_request_limit");
  const aiLimit = updatesAi ? normalizeTenantQuotaLimit(body.monthly_ai_request_limit, null, "每月 AI 请求额度") : undefined;
  if (aiLimit != null && aiLimit > 4294967295) throw Object.assign(new Error("每月 AI 请求额度超出支持范围"), { statusCode: 400 });
  if (updatesAi) await mysqlExecute(TENANT_AI_LIMITS_SCHEMA);
  return withMysqlTransaction(async connection => {
    const [tenants] = await connection.execute("SELECT id, member_limit, shop_limit FROM tenants WHERE id = ? FOR UPDATE", [normalizedTenantId]);
    if (!tenants[0]) throw new Error("企业不存在");
    const memberLimit = body.member_limit === undefined ? tenants[0].member_limit : normalizeTenantQuotaLimit(body.member_limit, null, "子账号额度");
    const shopLimit = body.shop_limit === undefined ? tenants[0].shop_limit : normalizeTenantQuotaLimit(body.shop_limit, null, "店铺额度");
    await connection.execute("UPDATE tenants SET member_limit = ?, shop_limit = ? WHERE id = ?", [memberLimit, shopLimit, normalizedTenantId]);
    if (updatesAi) await connection.execute(`INSERT INTO tenant_ai_limits (tenant_id, monthly_request_limit) VALUES (?, ?)
      ON DUPLICATE KEY UPDATE monthly_request_limit=VALUES(monthly_request_limit)`, [normalizedTenantId, aiLimit]);
    return { ok: true, member_limit: memberLimit, shop_limit: shopLimit, ...(updatesAi ? { monthly_ai_request_limit: aiLimit } : {}) };
  });
}

export async function setTenantSubscriptionMysql(tenantId, body = {}) {
  await ensureTenantSchemaMysql();
  const planCode = text(body.plan_code || body.planCode, 32);
  const normalizedTenantId = Number(tenantId);
  if (!normalizedTenantId) throw new Error("请选择企业");
  const plans = planCode ? await mysqlQuery("SELECT * FROM tenant_plans WHERE code = ? AND active = 1 LIMIT 1", [planCode]) : [];
  const plan = plans[0];
  if (!plan && text(body.subscription_status || body.subscriptionStatus) !== "suspended") throw new Error("不支持的套餐或套餐已停用");
  const tenantRows = await mysqlQuery("SELECT id FROM tenants WHERE id = ?", [normalizedTenantId]);
  if (!tenantRows[0]) throw new Error("企业不存在");
  if (!plan) {
    await mysqlExecute("UPDATE tenants SET subscription_status = 'suspended', subscription_expires_at = NULL WHERE id = ?", [normalizedTenantId]);
    return { ok: true, subscription_status: "suspended" };
  }
  const durationDays = Number(plan.duration_days);
  const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
  const memberLimit = tenantPlanMemberLimit(plan);
  await mysqlExecute("UPDATE tenants SET plan_code = ?, subscription_status = ?, subscription_expires_at = ?, member_limit = ?, shop_limit = ? WHERE id = ?", [plan.code, plan.subscription_status, expiresAt, memberLimit, plan.shop_limit, normalizedTenantId]);
  return { ok: true, plan_code: plan.code, subscription_status: plan.subscription_status, subscription_expires_at: expiresAt, member_limit: memberLimit, shop_limit: plan.shop_limit };
}

export async function listTenantPlansMysql() {
  await ensureTenantSchemaMysql();
  return mysqlQuery("SELECT id, code, name, duration_days, subscription_status, account_limit, shop_limit, active, is_builtin, created_at, updated_at FROM tenant_plans ORDER BY active DESC, is_builtin DESC, duration_days, id");
}

export async function createTenantPlanMysql(body = {}) {
  await ensureTenantSchemaMysql();
  const plan = normalizeTenantPlanInput(body);
  const code = `plan_${randomBytes(8).toString("hex")}`;
  const result = await mysqlExecute(`INSERT INTO tenant_plans
    (code, name, duration_days, subscription_status, account_limit, shop_limit, active, is_builtin)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0)`, [code, plan.name, plan.duration_days, plan.subscription_status, plan.account_limit, plan.shop_limit]);
  return { ok: true, id: Number(result.insertId), code, ...plan, active: 1, is_builtin: 0 };
}

export async function updateTenantPlanMysql(planId, body = {}) {
  await ensureTenantSchemaMysql();
  const normalizedPlanId = Number(planId);
  if (!Number.isSafeInteger(normalizedPlanId) || normalizedPlanId <= 0) {
    const error = new Error("请选择有效套餐");
    error.statusCode = 400;
    throw error;
  }
  const plan = normalizeTenantPlanInput(body);
  const currentRows = await mysqlQuery("SELECT id, active FROM tenant_plans WHERE id = ? LIMIT 1", [normalizedPlanId]);
  if (!currentRows[0]) throw new Error("套餐不存在");
  const active = body.active === undefined ? Number(currentRows[0].active) : Number(body.active) ? 1 : 0;
  await mysqlExecute(`UPDATE tenant_plans SET name = ?, duration_days = ?, subscription_status = ?, account_limit = ?, shop_limit = ?, active = ?
    WHERE id = ?`, [plan.name, plan.duration_days, plan.subscription_status, plan.account_limit, plan.shop_limit, active, normalizedPlanId]);
  return { ok: true, id: normalizedPlanId, ...plan, active };
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
  await mysqlExecute("UPDATE tenant_activation_codes SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND status = 'active'", [normalizedTenantId]);
  return { ok: true };
}

export async function tenantMembersMysql(tenantId) {
  await ensureTenantSchemaMysql();
  const normalizedTenantId = Number(tenantId);
  if (!Number.isSafeInteger(normalizedTenantId) || normalizedTenantId <= 0) {
    const error = new Error("请选择有效企业后重试");
    error.statusCode = 400;
    throw error;
  }
  const rows = await mysqlQuery(`SELECT tm.tenant_id, tm.person_id, tm.role, tm.active, tm.business_roles_json, p.name, p.username,
      (SELECT slug FROM tenants WHERE id = tm.tenant_id) AS tenant_slug,
      p.avatar_url, p.role AS business_role, p.roles_json, p.active AS account_active
    FROM tenant_members tm JOIN people p ON p.id = tm.person_id
    WHERE tm.tenant_id = ? AND tm.active = 1 ORDER BY p.id`, [normalizedTenantId]);
  return rows.map(row => {
    const { tenant_slug, ...membership } = row;
    return { ...membership, role: effectiveTenantMembershipRole({
      tenant_slug, tenant_role: row.role, business_roles_json: row.business_roles_json, legacy_role: row.business_role, roles_json: row.roles_json
    }) };
  });
}

export async function upsertTenantMemberMysql(tenantId, body = {}) {
  await ensureTenantSchemaMysql();
  const normalizedTenantId = Number(tenantId);
  const personId = Number(body.person_id || body.personId || 0);
  const role = text(body.role, 32) || "member";
  if (!normalizedTenantId || !personId) throw new Error("请选择企业和成员");
  if (!['owner', 'admin', 'member'].includes(role)) throw new Error("企业成员角色无效");
  const active = Number(body.active ?? 1) ? 1 : 0;
  const peopleRows = await mysqlQuery("SELECT id, role, roles_json FROM people WHERE id = ?", [personId]);
  if (!peopleRows[0]) throw new Error("成员不存在");
  await withMysqlTransaction(async connection => {
    const [tenantRows] = await connection.execute("SELECT id, member_limit FROM tenants WHERE id = ? AND status = 'active' FOR UPDATE", [normalizedTenantId]);
    if (!tenantRows[0]) throw new Error("企业不存在或已停用");
    const [existingRows] = await connection.execute("SELECT role, active FROM tenant_members WHERE tenant_id = ? AND person_id = ? FOR UPDATE", [normalizedTenantId, personId]);
    const existing = existingRows[0];
    const [ownerRows] = await connection.execute("SELECT MIN(person_id) AS primary_owner_id FROM tenant_members WHERE tenant_id = ? AND active = 1 AND role = 'owner'", [normalizedTenantId]);
    const primaryOwnerId = Number(ownerRows[0]?.primary_owner_id || 0);
    const currentConsumesQuota = Boolean(existing?.active && Number(personId) !== primaryOwnerId);
    const targetConsumesQuota = Boolean(active && !(role === "owner" && (!primaryOwnerId || Number(personId) === primaryOwnerId)));
    const becomesSubAccount = targetConsumesQuota && !currentConsumesQuota;
    if (becomesSubAccount) {
      const [countRows] = await connection.execute("SELECT COUNT(*) AS used FROM tenant_members WHERE tenant_id = ? AND active = 1 AND person_id <> ?", [normalizedTenantId, primaryOwnerId]);
      assertTenantQuotaAvailable({ label: "子账号", current: countRows[0]?.used || 0, limit: tenantRows[0].member_limit });
    }
    await connection.execute(`INSERT INTO tenant_members (tenant_id, person_id, role, business_roles_json, active) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE role = VALUES(role), business_roles_json = COALESCE(business_roles_json, VALUES(business_roles_json)),
        active = VALUES(active), updated_at = CURRENT_TIMESTAMP`,
    [normalizedTenantId, personId, role, JSON.stringify(getRoles(peopleRows[0])), active]);
  });
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
  if (!Number.isSafeInteger(normalizedTenantId) || normalizedTenantId <= 0 || !Number.isSafeInteger(normalizedPersonId) || normalizedPersonId <= 0) {
    throw Object.assign(new Error("请选择企业和当前操作账号"), { statusCode: 400 });
  }
  const rows = await mysqlQuery(`SELECT t.id, t.slug, t.status, tm.role AS member_role
    FROM tenants t
    LEFT JOIN tenant_members tm ON tm.tenant_id = t.id AND tm.person_id = ? AND tm.active = 1
    WHERE t.id = ? LIMIT 1`, [normalizedPersonId, normalizedTenantId]);
  const tenant = rows[0];
  if (!tenant || tenant.status !== "active") throw Object.assign(new Error("企业不存在或已停用"), { statusCode: 403 });
  if (tenant.slug === DEFAULT_TENANT_SLUG && !isPlatformAdmin) throw Object.assign(new Error("默认企业插件令牌仅平台管理员可以管理"), { statusCode: 403 });
  if (!isPlatformAdmin && !["owner", "admin"].includes(tenant.member_role)) throw Object.assign(new Error("仅企业负责人或企业管理员可以管理插件令牌"), { statusCode: 403 });
  return { ...tenant, id: normalizedTenantId };
}

export async function issueTenantPluginTokenMysql(tenantId, personId, { isPlatformAdmin = false } = {}) {
  const tenant = await requireTenantPluginAdminMysql(tenantId, personId, isPlatformAdmin);
  const token = `ozp_${randomBytes(32).toString("base64url")}`;
  const encryptedToken = encryptTenantPluginToken(token);
  await withMysqlTransaction(async (connection) => {
    await connection.execute("SELECT id FROM tenants WHERE id = ? FOR UPDATE", [tenant.id]);
    await connection.execute("UPDATE tenant_plugin_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND revoked_at IS NULL", [tenant.id]);
    await connection.execute(`INSERT INTO tenant_plugin_tokens (tenant_id, token_hash, token_ciphertext, created_by_person_id)
      VALUES (?, ?, ?, ?)`, [tenant.id, hashTenantPluginToken(token), encryptedToken, Number(personId)]);
  });
  return { ok: true, tenant_id: tenant.id, token };
}

export async function tenantPluginTokenStatusMysql(tenantId, personId, options = {}) {
  const tenant = await requireTenantPluginAdminMysql(tenantId, personId, options.isPlatformAdmin === true);
  const rows = await mysqlQuery(`SELECT id, label, created_at, token_ciphertext FROM tenant_plugin_tokens
    WHERE tenant_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`, [tenant.id]);
  return {
    configured: Boolean(rows[0]),
    created_at: rows[0]?.created_at || null,
    label: rows[0]?.label || "",
    recoverable: Boolean(rows[0]?.token_ciphertext),
    can_reveal: Boolean(rows[0]?.token_ciphertext) && tenantPluginTokenEncryptionConfigured(),
    encryption_configured: tenantPluginTokenEncryptionConfigured()
  };
}

export async function readTenantPluginTokenMysql(tenantId, personId, options = {}) {
  const tenant = await requireTenantPluginAdminMysql(tenantId, personId, options.isPlatformAdmin === true);
  const rows = await mysqlQuery(`SELECT token_ciphertext FROM tenant_plugin_tokens
    WHERE tenant_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`, [tenant.id]);
  if (!rows[0]) throw Object.assign(new Error("该企业尚未配置插件令牌"), { statusCode: 404 });
  if (!rows[0].token_ciphertext) throw Object.assign(new Error("当前令牌为旧版凭证，无法恢复；重置后请重新配置插件"), { statusCode: 409 });
  return { ok: true, tenant_id: tenant.id, token: decryptTenantPluginToken(rows[0].token_ciphertext) };
}

export async function saveTenantPluginTokenMysql(tenantId, personId, tokenInput, { isPlatformAdmin = false } = {}) {
  const tenant = await requireTenantPluginAdminMysql(tenantId, personId, isPlatformAdmin);
  const token = String(tokenInput || "").trim();
  if (!/^ozp_[A-Za-z0-9_-]{40,80}$/.test(token)) {
    throw Object.assign(new Error("令牌格式不正确，请粘贴 Ozon 浏览器插件使用的 ozp_ 令牌"), { statusCode: 400 });
  }
  const tokenHash = hashTenantPluginToken(token);
  const encryptedToken = encryptTenantPluginToken(token);
  let unchanged = false;
  await withMysqlTransaction(async connection => {
    await connection.execute("SELECT id FROM tenants WHERE id = ? FOR UPDATE", [tenant.id]);
    const [existingRows] = await connection.execute("SELECT id, tenant_id, revoked_at FROM tenant_plugin_tokens WHERE token_hash = ? LIMIT 1 FOR UPDATE", [tokenHash]);
    const existing = existingRows[0];
    if (existing && Number(existing.tenant_id) !== tenant.id) {
      throw Object.assign(new Error("此令牌已关联其他企业，不能重复使用"), { statusCode: 409 });
    }
    const [activeRows] = await connection.execute("SELECT id, token_hash FROM tenant_plugin_tokens WHERE tenant_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE", [tenant.id]);
    if (activeRows[0]?.token_hash === tokenHash) {
      await connection.execute("UPDATE tenant_plugin_tokens SET token_ciphertext = ? WHERE id = ?", [encryptedToken, activeRows[0].id]);
      unchanged = true;
      return;
    }
    await connection.execute("UPDATE tenant_plugin_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND revoked_at IS NULL", [tenant.id]);
    if (existing) {
      await connection.execute("UPDATE tenant_plugin_tokens SET token_ciphertext = ?, revoked_at = NULL WHERE id = ?", [encryptedToken, existing.id]);
      return;
    }
    await connection.execute(`INSERT INTO tenant_plugin_tokens (tenant_id, token_hash, token_ciphertext, created_by_person_id)
      VALUES (?, ?, ?, ?)`, [tenant.id, tokenHash, encryptedToken, Number(personId)]);
  });
  return { ok: true, tenant_id: tenant.id, unchanged };
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
  const rows = await mysqlQuery(`SELECT t.id, t.slug, t.status, t.plan_code, t.subscription_status, t.subscription_expires_at,
      pt.id AS token_id, pt.created_by_person_id
    FROM tenant_plugin_tokens pt JOIN tenants t ON t.id = pt.tenant_id
    WHERE pt.token_hash = ? AND pt.revoked_at IS NULL AND t.status = 'active' LIMIT 1`, [hashTenantPluginToken(normalizedToken)]);
  const tenant = rows[0];
  if (!tenant || !tenantHasAccess(tenant)) return null;
  return {
    tenantId: Number(tenant.id),
    tenantKey: tenant.slug === DEFAULT_TENANT_SLUG ? "admin" : String(tenant.id),
    tenantSlug: tenant.slug,
    tokenId: Number(tenant.token_id),
    personId: Number(tenant.created_by_person_id)
  };
}
