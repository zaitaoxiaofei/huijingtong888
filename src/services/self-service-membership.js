import { createHash, randomBytes } from "node:crypto";
import { hashPassword, validatePasswordStrength } from "../auth-password.js";
import { mysqlExecute, withMysqlTransaction } from "../mysql-pool.js";
import { isPlatformAdmin } from "../shared/permissions.js";
import { ensureTenantSchemaMysql } from "./tenants.js";
import { tenantPlanMemberLimit } from "./tenant-plans.js";
import { effectiveTenantMembershipRole } from "./tenant-membership-authority.js";
import { inspectSubscriptionVoucherSchema } from "./subscription-voucher-schema.js";

const DAY_MS = 86400000;

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

function iso(value) {
  if (!value) return null;
  return new Date(value).toISOString();
}

function sqlDate(value) {
  return new Date(value).toISOString().slice(0, 19).replace("T", " ");
}

export function membershipSummary(tenant, role, now = Date.now()) {
  const expiresAt = tenant.subscription_expires_at ? new Date(tenant.subscription_expires_at).getTime() : null;
  const expired = ["active", "trial"].includes(tenant.subscription_status) && expiresAt !== null && expiresAt <= now;
  const status = expired ? "expired" : tenant.subscription_status;
  const allowed = tenant.status === "active" && ["active", "trial"].includes(status);
  return {
    tenant_id: Number(tenant.id), tenant_name: tenant.name, plan_code: tenant.plan_code,
    status, expires_at: iso(tenant.subscription_expires_at),
    remaining_days: allowed && expiresAt === null ? null : allowed ? Math.max(0, Math.ceil((expiresAt - now) / DAY_MS)) : 0,
    access_allowed: allowed, can_activate: role === "owner" && tenant.status === "active" && status !== "suspended" && !(allowed && expiresAt === null),
    server_time: new Date(now).toISOString()
  };
}

function snapshotOf(plan) {
  const duration = Number(plan.duration_days);
  if (!Number.isInteger(duration) || duration < 1 || duration > 36500 || !["active", "trial"].includes(plan.subscription_status)) fail("套餐期限或类型无效，请先修正套餐");
  if (![plan.account_limit, plan.shop_limit].every(value => value === null || (Number.isSafeInteger(Number(value)) && Number(value) >= 0))
    || (plan.account_limit !== null && Number(plan.account_limit) < 1)) fail("套餐账号或店铺额度无效，请先修正套餐");
  return {
    plan_code: plan.code, plan_name: plan.name, duration_days: duration,
    subscription_status: plan.subscription_status,
    account_limit: plan.account_limit === null ? null : Number(plan.account_limit),
    member_limit: tenantPlanMemberLimit(plan), shop_limit: plan.shop_limit === null ? null : Number(plan.shop_limit)
  };
}

function voucherResult(row, now) {
  const snapshot = typeof row.plan_snapshot_json === "string" ? JSON.parse(row.plan_snapshot_json) : row.plan_snapshot_json;
  return {
    id: Number(row.id), code_hint: row.code_hint,
    status: row.status === "active" && new Date(row.redeemable_until).getTime() <= now ? "expired" : row.status,
    ...snapshot, redeemable_until: iso(row.redeemable_until), created_at: iso(row.created_at),
    used_at: iso(row.used_at), used_by_tenant_id: row.used_by_tenant_id ? Number(row.used_by_tenant_id) : null
  };
}

export function createSelfServiceMembershipService(overrides = {}) {
  const deps = { mysqlExecute, withMysqlTransaction, ensureTenantSchemaMysql, inspectVoucherSchema: inspectSubscriptionVoucherSchema, hashPassword, validatePasswordStrength, now: Date.now, randomBytes, ...overrides };
  let schemaReady;
  async function prepareSchema() {
    await deps.ensureTenantSchemaMysql();
    if (!schemaReady) schemaReady = deps.inspectVoucherSchema(deps.mysqlExecute).then(result => {
      if (!result.ready) fail("会员激活服务尚未完成数据库迁移，请联系管理员运行 scripts/migrate-subscription-vouchers.mjs", 503);
    }).catch(error => { schemaReady = null; throw error; });
    await schemaReady;
  }

  async function requirePlatform(connection, session) {
    if (!isPlatformAdmin(session)) fail("仅平台超级管理员可以管理会员激活码", 403);
    const [rows] = await connection.execute(`SELECT pg.person_id FROM platform_grants pg
      JOIN people p ON p.id = pg.person_id AND p.active = 1
      WHERE pg.person_id = ? AND pg.active = 1 AND pg.role = 'super_admin' FOR UPDATE`, [Number(session.personId)]);
    if (!rows.length) fail("平台授权已失效，请重新登录", 403);
  }

  async function currentTenant(connection, session, lock = false) {
    const tenantId = Number(session?.tenant?.id);
    const personId = Number(session?.personId);
    if (!Number.isSafeInteger(tenantId) || tenantId <= 0 || !Number.isSafeInteger(personId) || personId <= 0) fail("请先登录有效企业", 403);
    const [tenants] = await connection.execute(`SELECT * FROM tenants WHERE id = ?${lock ? " FOR UPDATE" : ""}`, [tenantId]);
    const tenant = tenants[0];
    if (!tenant || tenant.status !== "active") fail("当前企业已停用，请联系平台管理员", 403);
    const [members] = await connection.execute(`SELECT tm.role AS tenant_role, tm.business_roles_json,
      p.role AS legacy_role, p.roles_json FROM tenant_members tm JOIN people p ON p.id = tm.person_id AND p.active = 1
      WHERE tm.tenant_id = ? AND tm.person_id = ? AND tm.active = 1${lock ? " FOR UPDATE" : ""}`, [tenantId, personId]);
    if (!members[0]) fail("当前企业成员权限已失效，请重新登录", 403);
    return { tenant, role: effectiveTenantMembershipRole({ ...members[0], tenant_slug: tenant.slug }) };
  }

  async function register(body = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("请提交完整注册资料");
    if (!["username", "name", "password"].every(key => typeof body[key] === "string")) fail("请填写登录名、显示名称和密码");
    const username = String(body.username || "").trim();
    const name = String(body.name || "").trim();
    const enterpriseName = String(body.enterprise_name || `${name}的工作空间`).trim();
    const password = String(body.password || "");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@+\-]{2,63}$/.test(username)) fail("登录名需为 3–64 位字母、数字或 . _ @ + -");
    if (!name || name.length > 100) fail("显示名称不能为空且不能超过 100 个字符");
    if (!enterpriseName || enterpriseName.length > 100) fail("企业名称不能为空且不能超过 100 个字符");
    if (password.length > 128) fail("密码不能超过 128 位");
    if (Object.keys(body).some(key => !["username", "name", "password", "enterprise_name"].includes(key))) fail("注册只能提交登录名、显示名称、密码和企业名称");
    try { deps.validatePasswordStrength(password, { username, name }); } catch (error) { error.statusCode = 400; throw error; }
    const passwordHash = deps.hashPassword(password);
    await prepareSchema();
    try {
      return await deps.withMysqlTransaction(async connection => {
        const [person] = await connection.execute(`INSERT INTO people (name, username, role, roles_json, active, password_hash)
          VALUES (?, ?, 'operator', JSON_ARRAY('operator'), 1, ?)`, [name, username, passwordHash]);
        const personId = Number(person.insertId);
        const slug = `workspace-${deps.randomBytes(12).toString("hex")}`;
        const [tenant] = await connection.execute(`INSERT INTO tenants
          (slug, name, status, plan_code, subscription_status, subscription_expires_at, member_limit, shop_limit)
          VALUES (?, ?, 'active', 'unactivated', 'unactivated', NULL, 0, 0)`, [slug, enterpriseName]);
        const tenantId = Number(tenant.insertId);
        await connection.execute(`INSERT INTO tenant_members (tenant_id, person_id, role, business_roles_json, active)
          VALUES (?, ?, 'owner', JSON_ARRAY('operator'), 1)`, [tenantId, personId]);
        return { id: personId, name, username, role: "operator", roles_json: '["operator"]', active: 1, tenant_id: tenantId };
      });
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") fail("登录名或显示名称已被使用，请更换后重试", 409);
      throw error;
    }
  }

  async function membership(session) {
    await prepareSchema();
    return deps.withMysqlTransaction(async connection => {
      const { tenant, role } = await currentTenant(connection, session);
      return membershipSummary(tenant, role, deps.now());
    });
  }

  async function issueVoucher(body = {}, session) {
    if (!isPlatformAdmin(session)) fail("仅平台超级管理员可以管理会员激活码", 403);
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("请选择有效套餐");
    const planCode = String(body.plan_code || "").trim();
    if (!planCode || planCode.length > 32) fail("请选择有效套餐");
    const now = deps.now();
    if (body.redeemable_until && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(String(body.redeemable_until))) fail("兑换截止时间必须包含时区");
    const deadline = body.redeemable_until ? new Date(body.redeemable_until).getTime() : now + 30 * DAY_MS;
    if (!Number.isFinite(deadline) || deadline <= now || deadline > now + 366 * DAY_MS) fail("兑换截止时间需在未来一年内");
    const code = `BD-${deps.randomBytes(24).toString("hex").toUpperCase()}`;
    const codeHash = createHash("sha256").update(code).digest("hex");
    await prepareSchema();
    return deps.withMysqlTransaction(async connection => {
      await requirePlatform(connection, session);
      const [plans] = await connection.execute("SELECT * FROM tenant_plans WHERE code = ? AND active = 1 FOR UPDATE", [planCode]);
      if (!plans[0]) fail("套餐不存在或已停用，请选择有效套餐");
      const snapshot = snapshotOf(plans[0]);
      const [created] = await connection.execute(`INSERT INTO tenant_subscription_vouchers
        (code_hash, code_hint, plan_snapshot_json, redeemable_until, issued_by_person_id)
        VALUES (?, ?, ?, ?, ?)`, [codeHash, code.slice(-6), JSON.stringify(snapshot), sqlDate(deadline), Number(session.personId)]);
      const voucher = voucherResult({ id: created.insertId, code_hint: code.slice(-6), status: "active", plan_snapshot_json: snapshot,
        redeemable_until: deadline, created_at: now, used_at: null, used_by_tenant_id: null }, now);
      return { ok: true, id: Number(created.insertId), activation_code: code, voucher };
    });
  }

  async function listVouchers(session) {
    if (!isPlatformAdmin(session)) fail("仅平台超级管理员可以管理会员激活码", 403);
    await prepareSchema();
    return deps.withMysqlTransaction(async connection => {
      await requirePlatform(connection, session);
      const [rows] = await connection.execute(`SELECT id, code_hint, status, plan_snapshot_json, redeemable_until,
        created_at, used_at, used_by_tenant_id FROM tenant_subscription_vouchers ORDER BY id DESC LIMIT 100`);
      return { rows: rows.map(row => voucherResult(row, deps.now())) };
    });
  }

  async function revokeVoucher(id, session) {
    if (!isPlatformAdmin(session)) fail("仅平台超级管理员可以管理会员激活码", 403);
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) fail("请选择有效激活码");
    await prepareSchema();
    return deps.withMysqlTransaction(async connection => {
      await requirePlatform(connection, session);
      const [result] = await connection.execute(`UPDATE tenant_subscription_vouchers SET status = 'revoked', revoked_at = UTC_TIMESTAMP()
        WHERE id = ? AND status = 'active'`, [Number(id)]);
      return { ok: true, revoked: Number(result.affectedRows) };
    });
  }

  async function activate(body = {}, session) {
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some(key => key !== "activation_code")) fail("请仅提交会员激活码");
    const code = String(body.activation_code || "").trim().toUpperCase();
    if (!/^BD-[A-F0-9]{48}$/.test(code)) fail("激活码无效、已过期或已使用，请核对后重试");
    const hash = createHash("sha256").update(code).digest("hex");
    await prepareSchema();
    return deps.withMysqlTransaction(async connection => {
      const { tenant, role } = await currentTenant(connection, session, true);
      const now = deps.now();
      const current = membershipSummary(tenant, role, now);
      if (role !== "owner") fail("仅当前企业负责人可以激活或续费会员", 403);
      if (tenant.subscription_status === "suspended") fail("企业已暂停，请联系平台管理员恢复后再兑换", 403);
      if (current.access_allowed && !tenant.subscription_expires_at) fail("当前企业为长期授权，无需兑换时长", 409);
      const [vouchers] = await connection.execute(`SELECT * FROM tenant_subscription_vouchers
        WHERE code_hash = ? FOR UPDATE`, [hash]);
      const voucher = vouchers[0];
      if (!voucher || voucher.status !== "active" || new Date(voucher.redeemable_until).getTime() <= now) fail("激活码无效、已过期或已使用，请核对后重试");
      const snapshot = typeof voucher.plan_snapshot_json === "string" ? JSON.parse(voucher.plan_snapshot_json) : voucher.plan_snapshot_json;
      // Snapshot is written only by platform issuance. Reject corrupt rows rather
      // than interpreting them as an unlimited entitlement.
      if (!snapshot || typeof snapshot.plan_code !== "string" || !snapshot.plan_code || snapshot.plan_code.length > 32
        || !Number.isInteger(snapshot.duration_days) || snapshot.duration_days < 1 || snapshot.duration_days > 36500
        || !["active", "trial"].includes(snapshot.subscription_status)
        || ![snapshot.member_limit, snapshot.shop_limit].every(value => value === null || (Number.isSafeInteger(value) && value >= 0))) fail("激活码套餐配置无效，请联系平台管理员");
      const base = current.access_allowed ? Math.max(now, new Date(tenant.subscription_expires_at).getTime()) : now;
      const expiresAt = base + snapshot.duration_days * DAY_MS;
      await connection.execute(`UPDATE tenants SET plan_code = ?, subscription_status = ?, subscription_expires_at = ?,
        member_limit = ?, shop_limit = ? WHERE id = ?`, [snapshot.plan_code, snapshot.subscription_status, sqlDate(expiresAt), snapshot.member_limit, snapshot.shop_limit, Number(tenant.id)]);
      const [consumed] = await connection.execute(`UPDATE tenant_subscription_vouchers SET status = 'used', used_at = UTC_TIMESTAMP(),
        used_by_person_id = ?, used_by_tenant_id = ? WHERE id = ? AND status = 'active'`, [Number(session.personId), Number(tenant.id), Number(voucher.id)]);
      if (Number(consumed.affectedRows) !== 1) fail("激活码已被使用，请刷新后重试", 409);
      return { ok: true, membership: membershipSummary({ ...tenant, plan_code: snapshot.plan_code,
        subscription_status: snapshot.subscription_status, subscription_expires_at: new Date(expiresAt) }, role, now) };
    });
  }

  return { register, membership, issueVoucher, listVouchers, revokeVoucher, activate };
}

export const selfServiceMembership = createSelfServiceMembershipService();
