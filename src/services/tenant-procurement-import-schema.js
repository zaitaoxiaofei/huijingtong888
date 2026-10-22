const imports = [
  { table: 'procurement_platform_orders', index: 'uk_procurement_platform_order', key: ['platform', 'platform_order_no'] },
  { table: 'procurement_payment_transactions', index: 'uk_procurement_payment_transaction', key: ['provider', 'external_no'] },
  { table: 'procurement_payment_matches', index: 'uk_procurement_payment_match_order', key: ['platform_order_id'] }
];

// Run only from the explicit administrator migration, never request startup.
export async function inspectProcurementImportOwnership(query) {
  const [tenant] = await query("SELECT id FROM tenants WHERE slug = 'default' AND status = 'active' LIMIT 1");
  const defaultId = Number(tenant?.id);
  if (!Number.isSafeInteger(defaultId) || defaultId <= 0) throw new Error('Active default enterprise is required');
  const tables = [];
  for (const item of imports) {
    if (!(await query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [item.table])).length) { tables.push({ ...item, exists: false }); continue; }
    const columns = await query(`SHOW COLUMNS FROM ${item.table}`);
    const tenantColumn = columns.find(row => row.Field === 'tenant_id');
    const indexes = (await query(`SHOW INDEX FROM ${item.table}`)).filter(row => row.Key_name === item.index)
      .sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(row => row.Column_name);
    const owner = tenantColumn ? 'tenant_id' : 'NULL';
    const [counts] = await query(`SELECT COUNT(*) AS row_count, SUM(${owner} IS NULL) AS legacy_null_count FROM ${item.table}`);
    const duplicates = await query(`SELECT COUNT(*) AS duplicate_count FROM (
      SELECT COALESCE(${owner}, ?) AS effective_tenant, ${item.key.join(',')} FROM ${item.table}
      GROUP BY effective_tenant, ${item.key.join(',')} HAVING COUNT(*) > 1) duplicate_keys`, [defaultId]);
    tables.push({ ...item, exists: true, tenant_column: tenantColumn, index_columns: indexes,
      row_count: Number(counts.row_count), legacy_null_count: Number(counts.legacy_null_count || 0), duplicate_count: Number(duplicates[0].duplicate_count) });
  }
  const owner = (table, alias) => tables.find(item => item.table === table)?.tenant_column ? `${alias}.tenant_id` : 'NULL';
  const parents = tables.some(item => !item.exists) ? { conflict_count: 0 } : (await query(`SELECT COUNT(*) AS conflict_count FROM procurement_payment_matches m
    LEFT JOIN procurement_platform_orders o ON o.id = m.platform_order_id
    LEFT JOIN procurement_payment_transactions p ON p.id = m.payment_transaction_id
    WHERE o.id IS NULL OR p.id IS NULL OR COALESCE(${owner('procurement_payment_matches', 'm')}, ?) != COALESCE(${owner('procurement_platform_orders', 'o')}, ?)
      OR COALESCE(${owner('procurement_payment_matches', 'm')}, ?) != COALESCE(${owner('procurement_payment_transactions', 'p')}, ?)`, Array(4).fill(defaultId)))[0];
  return { default_tenant_id: defaultId, parent_conflict_count: Number(parents.conflict_count), tables };
}

export async function migrateProcurementImportOwnership(query, { assignLegacyDefault = false } = {}) {
  const before = await inspectProcurementImportOwnership(query);
  if (!assignLegacyDefault) throw new Error('Import-key migration requires explicit --assign-legacy-platform-default');
  if (before.parent_conflict_count || before.tables.some(row => row.duplicate_count)) throw new Error('Import tenant parent/key conflicts require manual repair before migration');
  const changes = [];
  for (const item of before.tables.filter(item => item.exists)) {
    // NULL imports belong to the documented historical default workflow only.
    // All legacy writers also receive this actual numeric default during cutover.
    const result = await query(`UPDATE ${item.table} SET tenant_id = ? WHERE tenant_id IS NULL`, [before.default_tenant_id]);
    const expected = ['tenant_id', ...item.key];
    const replace = item.index_columns.join(',') !== expected.join(',');
    await query(`ALTER TABLE ${item.table} MODIFY tenant_id BIGINT UNSIGNED NOT NULL DEFAULT ${before.default_tenant_id}${replace ? `, ${item.index_columns.length ? `DROP INDEX ${item.index}, ` : ''}ADD UNIQUE INDEX ${item.index} (${expected.join(',')})` : ''}`);
    changes.push({ table: item.table, legacy_default_rows_assigned: Number(result.affectedRows || 0), tenant_default: before.default_tenant_id,
      unique_index_columns: expected, atomic_index_replacement: replace });
  }
  return { before, changes, after: await inspectProcurementImportOwnership(query) };
}
