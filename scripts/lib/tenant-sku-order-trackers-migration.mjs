import { SKU_ORDER_TRACKERS_SCHEMA, skuOrderTrackerSchemaState } from '../../src/services/sku-order-tracking-schema.js';

export function tenantTrackerBackfillSql() {
  return `UPDATE sku_order_trackers tracker
    JOIN shops s ON s.id = tracker.shop_id
    JOIN tenants tenant_default ON tenant_default.slug = 'default' AND tenant_default.status = 'active'
    SET tracker.tenant_id = COALESCE(s.tenant_id, tenant_default.id), tracker.updated_at = tracker.updated_at
    WHERE tracker.tenant_id IS NULL`;
}

export async function inspectTenantSkuOrderTrackers(query) {
  if (!(await query("SHOW TABLES LIKE 'sku_order_trackers'")).length) return { exists: false, tracker_count: 0, ready: false };
  const [columns, indexes, shopColumns, defaults] = await Promise.all([
    query('SHOW COLUMNS FROM sku_order_trackers'), query('SHOW INDEX FROM sku_order_trackers'),
    query('SHOW COLUMNS FROM shops'), query("SELECT id FROM tenants WHERE slug = 'default' AND status = 'active'")
  ]);
  if (!shopColumns.some(column => column.Field === 'tenant_id')) throw new Error('shops.tenant_id must be migrated before SKU order trackers');
  const state = skuOrderTrackerSchemaState(columns, indexes);
  const defaultId = defaults.length === 1 ? Number(defaults[0].id) : 0;
  const [counts] = await query(`SELECT COUNT(*) AS tracker_count${state.tenant_column ? ', SUM(tenant_id IS NULL) AS unattributed_count' : ''} FROM sku_order_trackers`);
  const [invalid] = await query(`SELECT
    SUM(s.id IS NULL) AS orphan_shop_count,
    SUM(s.id IS NOT NULL AND owner_tenant.id IS NULL) AS unknown_shop_tenant_count
    ${state.tenant_column ? ', SUM(tracker.tenant_id IS NOT NULL AND tracker.tenant_id != COALESCE(s.tenant_id, ?)) AS ownership_mismatch_count' : ''}
    FROM sku_order_trackers tracker LEFT JOIN shops s ON s.id = tracker.shop_id
    LEFT JOIN tenants owner_tenant ON owner_tenant.id = COALESCE(s.tenant_id, ?)`, state.tenant_column ? [defaultId, defaultId] : [defaultId]);
  const [duplicates] = await query(`SELECT COUNT(*) AS duplicate_count FROM (
    SELECT COALESCE(s.tenant_id, ?) AS resolved_tenant, tracker.shop_id, tracker.ozon_sku
    FROM sku_order_trackers tracker JOIN shops s ON s.id = tracker.shop_id
    GROUP BY resolved_tenant, tracker.shop_id, tracker.ozon_sku HAVING COUNT(*) > 1
  ) conflicts`, [defaultId]);
  const names = [...new Set(indexes.map(index => index.Key_name))];
  const invalidNamedIndexes = [
    ['uk_sku_order_tracker_tenant_shop_sku', state.unique_index], ['idx_sku_order_tracker_tenant_active_shop', state.active_index]
  ].filter(([name, valid]) => names.includes(name) && !valid).map(([name]) => name);
  for (const name of state.unexpected_unique_indexes) if (!invalidNamedIndexes.includes(name)) invalidNamedIndexes.push(name);
  const legacy = indexes.filter(index => index.Key_name === 'uk_sku_order_tracker').sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index));
  if (legacy.length && (legacy.length !== 2 || legacy.some((index, position) => index.Column_name !== ['shop_id', 'ozon_sku'][position] || Number(index.Non_unique) !== 0 || index.Sub_part != null)) && !invalidNamedIndexes.includes('uk_sku_order_tracker')) invalidNamedIndexes.push('uk_sku_order_tracker');
  return {
    exists: true, tracker_count: Number(counts.tracker_count),
    unattributed_count: state.tenant_column ? Number(counts.unattributed_count || 0) : Number(counts.tracker_count),
    default_tenant_id: defaultId, orphan_shop_count: Number(invalid.orphan_shop_count || 0),
    unknown_shop_tenant_count: Number(invalid.unknown_shop_tenant_count || 0), ownership_mismatch_count: Number(invalid.ownership_mismatch_count || 0),
    duplicate_count: Number(duplicates.duplicate_count), invalid_named_indexes: invalidNamedIndexes, schema: state,
    ready: state.ready && !Number(invalid.orphan_shop_count || 0) && !Number(invalid.unknown_shop_tenant_count || 0)
      && !Number(invalid.ownership_mismatch_count || 0) && !Number(duplicates.duplicate_count)
  };
}

export function assertTenantSkuTrackerPreflight(report) {
  if (!report.exists) return;
  if (!report.default_tenant_id) throw new Error('An unambiguous active default tenant is required; no tracker rows were changed');
  if (report.schema.tenant_column && !report.schema.tenant_type_valid) throw new Error('Existing tracker tenant_id has an unexpected type; manual review is required');
  if (report.orphan_shop_count || report.unknown_shop_tenant_count || report.ownership_mismatch_count || report.duplicate_count || report.invalid_named_indexes.length) {
    throw new Error(`SKU tracker attribution preflight failed: orphan shops=${report.orphan_shop_count}, unknown shop enterprises=${report.unknown_shop_tenant_count}, ownership conflicts=${report.ownership_mismatch_count}, duplicate keys=${report.duplicate_count}, unexpected indexes=${report.invalid_named_indexes.length}; no automatic record deletion or ownership overwrite is allowed`);
  }
}

// Caller explicitly authorizes maintenance and holds a database-specific lock.
// Missing ownership follows the existing shop; original fields remain intact.
export async function applyTenantSkuOrderTrackers(query) {
  const before = await inspectTenantSkuOrderTrackers(query);
  assertTenantSkuTrackerPreflight(before);
  if (!before.exists) await query(SKU_ORDER_TRACKERS_SCHEMA);
  else {
    if (!before.schema.tenant_column) await query('ALTER TABLE sku_order_trackers ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id');
    if (before.unattributed_count) await query(tenantTrackerBackfillSql());
    const attributed = await inspectTenantSkuOrderTrackers(query);
    assertTenantSkuTrackerPreflight(attributed);
    if (attributed.unattributed_count) throw new Error('SKU tracker attribution remains incomplete; index changes were not applied');
    if (!attributed.schema.unique_index) await query('ALTER TABLE sku_order_trackers ADD UNIQUE KEY uk_sku_order_tracker_tenant_shop_sku (tenant_id, shop_id, ozon_sku)');
    if (!attributed.schema.active_index) await query('ALTER TABLE sku_order_trackers ADD KEY idx_sku_order_tracker_tenant_active_shop (tenant_id, active, shop_id)');
    if (!attributed.schema.tenant_not_null) await query('ALTER TABLE sku_order_trackers MODIFY tenant_id BIGINT UNSIGNED NOT NULL');
    if (attributed.schema.legacy_unique_index) await query('ALTER TABLE sku_order_trackers DROP INDEX uk_sku_order_tracker');
  }
  const after = await inspectTenantSkuOrderTrackers(query);
  if (!after.ready || after.tracker_count !== before.tracker_count) throw new Error('Post-migration SKU tracker ownership, indexes or original row count could not be verified');
  return { before, after, changes_database: !before.ready, original_rows_preserved: true };
}
