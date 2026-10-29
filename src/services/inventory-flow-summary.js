import { mysqlQuery } from '../mysql-pool.js';
import { validateFlowSettings } from './inventory-flow-rules.js';
import { inventoryTenantSql, resolveInventoryTenantScope, assertInventoryRecord } from './inventory-tenant-scope.js';

import { buildInventoryFlowSummary, calculateLocalInventorySafety } from './inventory-flow-summary-model.js';
export { buildInventoryFlowSummary } from './inventory-flow-summary-model.js';

export function createInventoryFlowSummaryReader({ query = mysqlQuery } = {}) {
  return async function read(ledger, tenantId, { localOnly = false, fbpOnly = false } = {}) {
    const scope = await resolveInventoryTenantScope(tenantId, query);
    const productId = Number(ledger.product.id);
    const product = await assertInventoryRecord(scope, 'product', productId, query);
    const current = (ledger.orders || []).filter(row => row.needs_fulfillment);
    const ids = [...new Set(current.map(row => Number(row.order_id)))];
    const metadata = !fbpOnly && ids.length ? await query(`SELECT o.id, o.shop_id, s.name AS shop_name, o.status
      FROM orders o JOIN shops s ON s.id = o.shop_id AND ${inventoryTenantSql(scope, 's')}
      WHERE o.id IN (${ids.map(() => '?').join(',')})`, ids) : [];
    const byId = new Map(metadata.map(row => [Number(row.id), row]));
    const orders = current.filter(row => byId.has(Number(row.order_id))).map(row => ({
      order_id: row.order_id, order_item_id: row.order_item_id, posting_number: row.posting_number,
      ordered_at: row.ordered_at, quantity: row.quantity, stock_quantity: row.stock_quantity,
      incoming_quantity: row.incoming_quantity, shortage_quantity: row.shortage_quantity,
      ...byId.get(Number(row.order_id))
    }));
    let projection;
    if (!fbpOnly) {
      const records = await query('SELECT product_id, settings_json FROM inventory_flow_settings WHERE tenant_id = ? AND product_id IN (0, ?)', [scope.id, productId]);
      const parse = row => typeof row?.settings_json === 'string' ? JSON.parse(row.settings_json) : row?.settings_json || {};
      const defaults = parse(records.find(row => !Number(row.product_id)));
      const settings = validateFlowSettings({ ...defaults, ...parse(records.find(row => Number(row.product_id) === productId)), holidays: defaults.holidays || [] });
      projection = calculateLocalInventorySafety({ ...ledger, product: { ...ledger.product, production_lead_days: product.production_lead_days, warehouse_logistics_days: product.warehouse_logistics_days } }, settings);
      if (localOnly) return { ...buildInventoryFlowSummary(ledger, projection, orders), applications_pending: true, requested: null };
    }
    const bindings = [...new Map((ledger.fbp_inventory?.rows || []).map(row => [`${row.shop_id}:${row.ozon_sku}`, row])).values()];
    const applications = await query(`SELECT o.id AS order_id, o.order_no, o.status, o.created_at,
      i.id AS item_id, i.shop_id, s.name AS shop_name, i.ozon_sku, i.product_id,
      i.requested_qty, GREATEST(0, i.approved_qty + COALESCE((SELECT SUM(a.adjustment_qty)
        FROM fbp_replenishment_item_adjustments a WHERE a.item_id = i.id), 0)) AS final_qty,
      requester.name AS applicant_name, reviewer.name AS reviewer_name
      FROM fbp_replenishment_order_items i JOIN fbp_replenishment_orders o ON o.id = i.order_id AND o.shop_id = i.shop_id
      JOIN shops s ON s.id = o.shop_id AND ${inventoryTenantSql(scope, 's')}
      JOIN products p ON p.id = i.product_id AND ${inventoryTenantSql(scope, 'p')}
      LEFT JOIN people requester ON requester.id = COALESCE(i.requested_by, o.created_by) AND EXISTS
        (SELECT 1 FROM tenant_members m WHERE m.tenant_id = ${scope.id} AND m.person_id = requester.id AND m.active = 1)
      LEFT JOIN people reviewer ON reviewer.id = o.reviewed_by AND EXISTS
        (SELECT 1 FROM tenant_members m WHERE m.tenant_id = ${scope.id} AND m.person_id = reviewer.id AND m.active = 1)
      WHERE (i.mapping_id IS NULL OR EXISTS (SELECT 1 FROM sku_mappings m
        WHERE m.id = i.mapping_id AND m.shop_id = i.shop_id AND m.product_id = i.product_id AND ${inventoryTenantSql(scope, 'm')}))
        AND o.status IN ('draft','pending_review','approved','ozon_created') AND
        (i.product_id = ?${bindings.length ? ` OR ${bindings.map(() => '(i.shop_id = ? AND i.ozon_sku = ?)').join(' OR ')}` : ''})
      ORDER BY o.created_at DESC, o.id DESC, i.id`, [productId, ...bindings.flatMap(row => [row.shop_id, row.ozon_sku])]);
    for (const row of applications) {
      const binding = bindings.find(item => Number(item.shop_id) === Number(row.shop_id) && String(item.ozon_sku) === String(row.ozon_sku));
      const perSet = Number(binding?.per_set_quantity || 1);
      row.requested_quantity = Number(row.requested_qty) * perSet;
      row.locked_quantity = ['approved', 'ozon_created'].includes(row.status) ? Number(row.final_qty) * perSet : 0;
      row.per_set_quantity = perSet;
    }
    if (fbpOnly) return { applications, requested: applications.reduce((sum, row) => sum + row.requested_quantity, 0) };
    return buildInventoryFlowSummary(ledger, projection, orders, applications);
  };
}
export const readInventoryFlowSummary = createInventoryFlowSummaryReader();
