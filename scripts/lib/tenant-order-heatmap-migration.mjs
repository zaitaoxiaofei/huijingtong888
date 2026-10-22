import { ORDER_HEATMAP_TENANT_SCHEMA } from '../../src/services/order-heatmap-tenant-schema.js';

export async function inspectOrderHeatmapTenantSchema(query) {
  if (!(await query("SHOW TABLES LIKE 'order_vehicle_title_tags'")).length) return { exists: false, tenant_column: false, tenant_index: false, rows: 0 };
  const columns = await query("SHOW COLUMNS FROM order_vehicle_title_tags LIKE 'tenant_id'");
  const indexes = await query("SHOW INDEX FROM order_vehicle_title_tags WHERE Key_name = 'idx_order_vehicle_title_tags_tenant_hash'");
  const [count] = await query('SELECT COUNT(*) AS count FROM order_vehicle_title_tags');
  return { exists: true, tenant_column: columns.length > 0, tenant_index: indexes.length > 0, rows: Number(count.count || 0) };
}

// Existing NULL rows remain legacy default-company cache entries. No identity,
// membership, title content or pre-existing classification is reassigned.
export async function applyOrderHeatmapTenantSchema(query) {
  const before = await inspectOrderHeatmapTenantSchema(query);
  if (!before.exists) await query(ORDER_HEATMAP_TENANT_SCHEMA);
  else {
    if (!before.tenant_column) await query('ALTER TABLE order_vehicle_title_tags ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id');
    if (!before.tenant_index) await query('ALTER TABLE order_vehicle_title_tags ADD KEY idx_order_vehicle_title_tags_tenant_hash (tenant_id, title_hash)');
  }
  const after = await inspectOrderHeatmapTenantSchema(query);
  if (!after.tenant_column || !after.tenant_index || after.rows !== before.rows) throw new Error('Order heatmap tenant schema verification failed');
  return { before, after };
}
