import { AsyncLocalStorage } from "node:async_hooks";
import { mysqlExecute, mysqlQuery, withMysqlTransaction } from "../mysql-pool.js";
import { shanghaiDateKey } from "../shanghai-time.js";
import { assertBusinessTaskPermission, authorizeBusinessTaskSession, businessTaskTenantKey } from "./business-task-tenant.js";
import { TENANT_AI_LIMITS_SCHEMA, TENANT_AI_USAGE_SCHEMA } from "./ai-tenant-schema.js";
import { checkAiCreditProviderBoundary } from "./ai-credit-provider-context.js";

const context = new AsyncLocalStorage();
let usageSchema;

export function currentAiTenantSession() { return context.getStore()?.session || null; }
export function needsAiTenantSession(session, permission = "operations") {
  const current = currentAiTenantSession();
  if (!current) return true;
  if (context.getStore().permission !== permission) return true;
  if (!session?.tenant) return false;
  return businessTaskTenantKey(current) !== businessTaskTenantKey(session)
    || (session.personId !== undefined && Number(current.personId) !== Number(session.personId));
}
export function aiTenantId() {
  const session = currentAiTenantSession();
  if (!session) throw Object.assign(new Error("AI 业务操作缺少企业上下文"), { statusCode: 403 });
  return businessTaskTenantKey(session);
}

export async function withAiTenantSession(session, operation, { permission = "operations" } = {}) {
  if (!["operations", "analytics"].includes(permission)) throw new Error("Invalid AI business permission");
  const authorized = await authorizeBusinessTaskSession(session);
  assertBusinessTaskPermission(authorized, permission);
  const previous = context.getStore();
  const sameIdentity = previous?.session && businessTaskTenantKey(previous.session) === businessTaskTenantKey(authorized)
    && Number(previous.session.personId) === Number(authorized.personId) && previous.permission === permission;
  return context.run({ session: authorized, permission, beforeRequest: sameIdentity ? previous.beforeRequest : undefined }, operation);
}

// Resource ownership/cancellation belongs to the workflow, while provider
// retries and polls live below it. Carry a server-created guard to that boundary.
export async function withAiTenantRequestGuard(guard, operation) {
  const current = context.getStore();
  if (!current?.session || typeof guard !== "function") throw new Error("AI resource guard requires a current enterprise task");
  return context.run({ ...current, beforeRequest: async options => {
    await current.beforeRequest?.(options);
    await guard(options || {});
  } }, operation);
}

export async function assertCurrentAiTenantPermission({ connection = null, lock = false } = {}) {
  const session = currentAiTenantSession();
  if (!session) return null; // Platform diagnostics are authorized separately.
  const options = connection ? { connection, lock } : {};
  // Resource locks can themselves wait. Take them before the final current
  // authorization read, whose shared locks remain held through the write.
  if (connection && lock) await context.getStore().beforeRequest?.(options);
  const query = connection ? async (sql, params) => (await connection.execute(lock ? `${sql.trim()} FOR SHARE` : sql, params))[0] : undefined;
  const authorized = await authorizeBusinessTaskSession(session, query);
  assertBusinessTaskPermission(authorized, context.getStore().permission || "operations");
  if (!connection || !lock) await context.getStore().beforeRequest?.(options);
  return authorized;
}

export async function reserveTenantAiRequest(kind = "text", count = 1) {
  const session = await assertCurrentAiTenantPermission();
  if (!session) return null;
  const billing = await checkAiCreditProviderBoundary(session, kind, mysqlQuery);
  // Prepaid attempts are accounted by the durable wallet executor. Do not also
  // block a funded customer with the legacy monthly-request default of zero.
  if (billing.mode === "credits") return { tenant_id: Number(session.tenant.id), mode: "credits" };
  if (!usageSchema) usageSchema = (async () => {
    await mysqlExecute(TENANT_AI_LIMITS_SCHEMA);
    await mysqlExecute(TENANT_AI_USAGE_SCHEMA);
  })().catch(error => { usageSchema = null; throw error; });
  await usageSchema;
  const quantity = Number(count);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) throw new Error("AI 请求数量无效");
  const tenantId = Number(session.tenant.id);
  const period = shanghaiDateKey(new Date()).slice(0, 7);
  return withMysqlTransaction(async connection => {
    await connection.execute("SELECT id FROM tenants WHERE id = ? FOR UPDATE", [tenantId]);
    // The quota mutex can wait behind another request. Resolve current access
    // after acquiring it, through this transaction rather than another pool slot.
    await assertCurrentAiTenantPermission({connection,lock:true});
    const [limits] = await connection.execute("SELECT monthly_request_limit FROM tenant_ai_limits WHERE tenant_id = ?", [tenantId]);
    const [usage] = await connection.execute("SELECT request_count FROM tenant_ai_usage WHERE tenant_id = ? AND period_key = ?", [tenantId, period]);
    const limit = limits.length ? limits[0].monthly_request_limit : session.tenant.slug === "default" ? null : 0;
    if (limit !== null && limit !== undefined && Number(usage[0]?.request_count || 0) + quantity > Number(limit)) {
      throw Object.assign(new Error("当前企业 AI 请求额度未开通或本月已用完，请联系平台管理员设置企业 AI 月度额度"), { status: 409, statusCode: 409, code: "TENANT_AI_QUOTA_EXCEEDED" });
    }
    await connection.execute(`INSERT INTO tenant_ai_usage (tenant_id, period_key, request_count, text_count, image_count)
      VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE request_count = request_count + VALUES(request_count),
      text_count = text_count + VALUES(text_count), image_count = image_count + VALUES(image_count)`,
    [tenantId, period, quantity, kind === "image" ? 0 : quantity, kind === "image" ? quantity : 0]);
    return { tenant_id: tenantId, period_key: period, quantity };
  });
}
