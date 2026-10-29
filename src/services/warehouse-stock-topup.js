import { withMysqlTransaction } from '../mysql-pool.js';
import { authorizeBusinessTaskSession } from './business-task-tenant.js';
import { resolveInventoryTenantScope, assertInventoryRecord } from './inventory-tenant-scope.js';
import { hasPermission, getRoles } from '../shared/permissions.js';
import { effectiveTenantMembershipRole } from './tenant-membership-authority.js';
import { loadOrderProcurementCoverage, invalidateOrderProcurementCoverage } from './mysql-order-procurement-coverage.js';
import { broadcastGlobalEvent } from '../server/notifications.js';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export function validateStockTopup(body = {}) {
  const value = { product_id: Number(body.product_id), order_id: Number(body.order_id), quantity: Number(body.quantity),
    request_key: String(body.request_key || ''), note: String(body.note || '').trim() };
  for (const field of ['product_id', 'order_id']) if (!Number.isSafeInteger(value[field]) || value[field] <= 0) throw fail('请选择订单中已绑定的库存商品（order_id、product_id），再提醒采购');
  if (!Number.isSafeInteger(value.quantity) || value.quantity <= 0 || value.quantity > 1000000) throw fail('提醒采购数量（quantity）须为1至1000000的整数件');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.request_key)) throw fail('本次提醒标识（request_key）缺失，请重新打开提醒采购');
  if (value.note.length > 500) throw fail('提醒说明（note）最多500字');
  return value;
}
export function stockTopupRecipients(rows) {
  return [...new Set(rows.filter(row => ['owner', 'admin'].includes(effectiveTenantMembershipRole({ ...row, legacy_role: row.role }))
    || getRoles({ roles: row.business_roles_json ?? row.roles_json ?? row.role }).includes('procurement')).map(row => Number(row.id)))];
}
export function createWarehouseStockTopupService({ transaction = withMysqlTransaction, coverage = loadOrderProcurementCoverage, broadcast = broadcastGlobalEvent } = {}) {
  return async function create(body, session) {
    const input = validateStockTopup(body);
    const result = await transaction(async connection => {
      const q = async (sql, args = []) => (await connection.query(sql, args))[0];
      // Lock current membership/subscription before authorizing a persistent write.
      const current = await authorizeBusinessTaskSession(session, (sql, args) => q(sql + ' FOR UPDATE', args));
      if (!hasPermission(current, 'packing') && !hasPermission(current, 'inventory.write')) throw fail('提醒采购需要本企业仓库打包或库存管理权限，请联系企业管理员分配岗位', 403);
      const scope = await resolveInventoryTenantScope(current.tenant.id, q);
      const group = `ST-${current.personId}-${input.request_key}`;
      const existing = await q('SELECT id, product_id, source_order_id, quantity, request_reason_note FROM procurement_requests WHERE tenant_id = ? AND request_group_no = ? FOR UPDATE', [scope.id, group]);
      if (existing.length) {
        const row = existing[0];
        if (Number(row.product_id) !== input.product_id || Number(row.source_order_id) !== input.order_id || Number(row.quantity) !== input.quantity || String(row.request_reason_note || '') !== input.note) throw fail('此提醒已提交，内容发生变化；请刷新后查看原申请或重新创建提醒', 409);
        return { ok: true, id: Number(row.id), duplicate: true, recipients: [], tenantId: scope.id };
      }
      const product = await assertInventoryRecord(scope, 'product', input.product_id, q, { lock: true });
      const order = await assertInventoryRecord(scope, 'order', input.order_id, q);
      const projection = await coverage(q, '', { fresh: true, productId: input.product_id, tenantId: scope.id, includeLegacyTenantNull: scope.isDefault });
      const demand = projection.get(input.order_id);
      if (!demand || demand.stock_location === 'FBP' || !demand.items?.some(row => Number(row.product_id) === input.product_id)) throw fail('该商品不属于此订单的本地库存需求，请先检查SKU及库存组成绑定；FBP官方仓订单不能提醒本地采购');
      const people = await q(`SELECT p.id, p.name, p.role, p.roles_json, tm.role AS tenant_role, tm.business_roles_json, t.slug AS tenant_slug
        FROM tenant_members tm JOIN people p ON p.id = tm.person_id AND p.active = 1
        JOIN tenants t ON t.id = tm.tenant_id WHERE tm.tenant_id = ? AND tm.active = 1 FOR UPDATE`, [scope.id]);
      const recipients = stockTopupRecipients(people);
      if (!recipients.length) throw fail('本企业暂无有效管理员或采购人员接收提醒，请在企业人员设置分配采购岗位后重试', 409);
      const sender = people.find(row => Number(row.id) === current.personId)?.name || '仓库人员';
      const [request] = await connection.execute(`INSERT INTO procurement_requests
        (tenant_id, request_group_no, product_id, binding_status, person_id, created_by_person_id,
         quantity, amount, shipping_amount, approval_status, status, note, urgency, source_type,
         source_order_id, demand_type, request_reason_code, request_reason_note, purchase_mode)
        VALUES (?, ?, ?, 'bound', ?, ?, ?, 0, 0, 'submitted', 'submitted', ?, 'high', 'warehouse', ?,
          'warehouse_request', 'inventory_stock_topup', ?, 'shortage_purchase')`,
      [scope.id, group, input.product_id, current.personId, current.personId, input.quantity, `库存补足：${input.note || '仓库核对发现实物不足，请采购补足'}`, input.order_id, input.note || null]);
      const id = Number(request.insertId);
      for (const recipient of recipients) await connection.execute(`INSERT INTO system_notifications
        (tenant_id, recipient_person_id, notification_type, title, content, severity, route, entity_type, entity_id, dedupe_key, status)
        VALUES (?, ?, 'stock_topup', '库存补足', ?, 'warning', ?, 'procurement', ?, ?, 'unread')`,
      [scope.id, recipient, `${sender}提醒采购：${product.name}，补足${input.quantity}件；关联订单${order.posting_number}。${input.note}`, `/procurement/workspace?demandType=warehouse_request&message_request_id=${id}`, String(id), `${scope.id}:stock_topup:${id}:${recipient}`]);
      return { ok: true, id, duplicate: false, recipients, tenantId: scope.id };
    });
    invalidateOrderProcurementCoverage();
    for (const personId of result.recipients) {
      // Notification rows are committed before the best-effort refresh signal.
      try { broadcast('system-notification', { refresh: true }, { personId, tenantId: result.tenantId }); } catch {}
    }
    return { ok: true, id: result.id, duplicate: result.duplicate, notified: result.recipients.length };
  };
}
export const createWarehouseStockTopup = createWarehouseStockTopupService();
