import { AsyncLocalStorage } from 'node:async_hooks';
import { mysqlQuery } from '../mysql-pool.js';
import { authorizeBusinessTaskSession, assertBusinessTaskPermission } from './business-task-tenant.js';

const context = new AsyncLocalStorage();
export function isAdvertisingBusinessRequest() { return Boolean(context.getStore()?.session); }
const denied = () => Object.assign(new Error('广告数据不属于当前企业或企业授权已失效'), { status: 403, statusCode: 403 });

export async function advertisingTenantScope() {
  const current = context.getStore();
  let tenantId = current?.tenantId ?? 'admin';
  if (current?.session) {
    const session = await authorizeBusinessTaskSession(current.session);
    assertBusinessTaskPermission(session, 'analytics');
    tenantId = session.tenant.id;
  }
  if (tenantId !== 'admin' && (!/^\d+$/.test(String(tenantId)) || !Number.isSafeInteger(Number(tenantId)) || Number(tenantId) <= 0)) throw denied();
  const rows = await mysqlQuery(`SELECT id, slug FROM tenants WHERE ${tenantId === 'admin' ? "slug = 'default'" : 'id = ?'}
    AND status = 'active' AND subscription_status IN ('active', 'trial')
    AND (subscription_expires_at IS NULL OR subscription_expires_at > UTC_TIMESTAMP()) LIMIT 1`, tenantId === 'admin' ? [] : [Number(tenantId)]);
  if (!rows[0]) throw denied();
  const id = Number(rows[0].id), isDefault = rows[0].slug === 'default';
  return { id, isDefault };
}

export function advertisingTenantSql(scope, alias) {
  if (!Number.isSafeInteger(scope?.id) || scope.id <= 0 || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) throw denied();
  return `(${alias}.tenant_id = ${scope.id}${scope.isDefault ? ` OR ${alias}.tenant_id IS NULL` : ''})`;
}

export function advertisingShopSql(scope, column) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(column)) throw denied();
  return `EXISTS (SELECT 1 FROM shops ad_owner WHERE ad_owner.id = ${column} AND ${advertisingTenantSql(scope, 'ad_owner')})`;
}

export async function assertAdvertisingShop(shopId) {
  const scope = await advertisingTenantScope();
  const id = Number(shopId);
  if (!Number.isSafeInteger(id) || id <= 0) throw denied();
  const rows = await mysqlQuery(`SELECT id FROM shops s WHERE s.id = ? AND ${advertisingTenantSql(scope, 's')} AND s.status = 'active' LIMIT 1`, [id]);
  if (!rows.length) throw denied();
  return scope;
}

export async function withAdvertisingTenantSession(session, run) {
  const fresh = await authorizeBusinessTaskSession(session);
  assertBusinessTaskPermission(fresh, 'analytics');
  return context.run({ session: fresh, tenantId: fresh.tenant.id }, run);
}

// Platform cron supplies a tenant resolved from its active-tenant inventory, never a request body.
export async function withAdvertisingTenant(tenantId, run) {
  return context.run({ tenantId }, async () => { await advertisingTenantScope(); return run(); });
}
