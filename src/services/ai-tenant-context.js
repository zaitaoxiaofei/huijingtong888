import { AsyncLocalStorage } from "node:async_hooks";
import { mysqlQuery } from "../mysql-pool.js";
import { assertBusinessTaskPermission, authorizeBusinessTaskSession, businessTaskTenantKey } from "./business-task-tenant.js";
import { checkAiCreditProviderBoundary } from "./ai-credit-provider-context.js";

const context = new AsyncLocalStorage();

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
  await context.getStore().beforeRequest?.(options);
  const query = connection ? async (sql, params) => (await connection.execute(lock ? `${sql.trim()} FOR SHARE` : sql, params))[0] : undefined;
  const authorized = await authorizeBusinessTaskSession(session, query);
  assertBusinessTaskPermission(authorized, context.getStore().permission || "operations");
  return authorized;
}

export async function reserveTenantAiRequest(kind = "text") {
  const session = await assertCurrentAiTenantPermission();
  if (!session) return null;
  const billing = await checkAiCreditProviderBoundary(session, kind, mysqlQuery);
  // Every enterprise uses the wallet for images; text is free. The old request
  // quota cannot authorize a paid image or block a free text request.
  return { tenant_id: Number(session.tenant.id), mode: billing.mode };
}
