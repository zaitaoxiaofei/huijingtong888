import { restoreBusinessTaskSession } from './business-task-tenant.js';
import { hasPermission } from '../shared/permissions.js';

export function isPurchaseReceiptWrite(body = {}) {
  if (body.status === 'approved' || body.receive_quantity !== undefined || body.historical_receipt_groups !== undefined) return true;
  return (Array.isArray(body.records) ? body.records : []).some(row => isPurchaseReceiptWrite(row.payload && typeof row.payload === 'object' ? row.payload : { status: row.status, receive_quantity: row.receive_quantity }));
}

export async function assertWarehouseReceiptActor(scope, personId, query, { lock = false } = {}) {
  const current = await restoreBusinessTaskSession(scope.isDefault ? 'admin' : scope.id, personId,
    query && ((sql, params) => query(lock ? `${sql} FOR SHARE` : sql, params)));
  if (!hasPermission(current, 'packing')) throw Object.assign(new Error('验收入库需要本企业仓库打包权限；采购人员可以提醒或确认实物到货'), { statusCode: 403 });
  return current;
}
