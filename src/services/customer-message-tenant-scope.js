import { AsyncLocalStorage } from 'node:async_hooks';
import { authorizeBusinessTaskSession, restoreBusinessTaskSession } from './business-task-tenant.js';
import { hasPermission } from '../shared/permissions.js';
import { resolveInventoryTenantScope, inventoryTenantSql, assertInventoryRecord } from './inventory-tenant-scope.js';

const context = new AsyncLocalStorage();
const denied = () => Object.assign(new Error('客户消息需要当前企业的有效运营授权'), { statusCode: 403 });

async function assertScheduledTenant(scope) {
  const { mysqlQuery } = await import('../mysql-pool.js');
  const rows = await mysqlQuery(`SELECT id FROM tenants WHERE id=? AND status='active'
    AND subscription_status IN ('active','trial')
    AND (subscription_expires_at IS NULL OR subscription_expires_at>UTC_TIMESTAMP())`, [scope.id]);
  if (!rows.length) throw denied();
}

// Only the platform scheduler calls this entry point. It grants no sender identity.
export async function runCustomerMessageTenantScheduledOperation(tenantId, run) {
  const scope = await resolveInventoryTenantScope(tenantId);
  await assertScheduledTenant(scope);
  return context.run({ session: null, scope }, run);
}

export async function runCustomerMessageTaskOperation(personId, run) {
  const scope = customerMessageTenantScope();
  if (!Number.isSafeInteger(Number(personId)) || Number(personId) <= 0) {
    throw Object.assign(new Error('自动消息未保存运营授权，请由企业运营人员重新保存店铺消息设置'), { statusCode: 403 });
  }
  const session = await restoreBusinessTaskSession(scope.id, Number(personId));
  return runCustomerMessageTenantOperation(session, run);
}

export async function runCustomerMessageTenantOperation(session, run) {
  const current = await authorizeBusinessTaskSession(session);
  if (!hasPermission(current, 'operations')) throw denied();
  const scope = await resolveInventoryTenantScope(current.tenant.id);
  return context.run({ session: current, scope }, run);
}

export function customerMessageTenantScope() {
  const value = context.getStore();
  if (!value) throw denied();
  return value.scope;
}

export function customerMessageShopSql(column = 'shop_id') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(column)) throw new Error('Invalid customer-message shop column');
  return `${column} IN (SELECT id FROM shops WHERE ${inventoryTenantSql(customerMessageTenantScope())})`;
}

export function customerMessageTemplateSql(alias = '') {
  return inventoryTenantSql(customerMessageTenantScope(), alias);
}

export async function assertCustomerMessageAccess({ shopId = null, orderId = null, outbound = false } = {}) {
  const value = context.getStore();
  if (!value) throw denied();
  if (outbound && !value.session) throw denied();
  const current = value.session ? await authorizeBusinessTaskSession(value.session) : null;
  if (current ? (!hasPermission(current, 'operations') || Number(current.tenant.id) !== value.scope.id) : false) throw denied();
  if (!current) await assertScheduledTenant(value.scope);
  const shop = shopId ? await assertInventoryRecord(value.scope, 'shop', shopId) : null;
  if (shop && shop.status !== 'active') throw denied();
  const order = orderId ? await assertInventoryRecord(value.scope, 'order', orderId) : null;
  if (order && shop && Number(order.shop_id) !== Number(shop.id)) throw denied();
  return { session: current, scope: value.scope, shop, order };
}
