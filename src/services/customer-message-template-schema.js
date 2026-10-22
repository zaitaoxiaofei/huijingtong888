export const CUSTOMER_MESSAGE_TEMPLATES_SCHEMA = `CREATE TABLE IF NOT EXISTS customer_message_templates (
  tenant_id BIGINT UNSIGNED NOT NULL,
  scenario VARCHAR(64) NOT NULL,
  name VARCHAR(64) NOT NULL DEFAULT '', label VARCHAR(64) NOT NULL DEFAULT '',
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  template_text TEXT NULL, template_translation TEXT NULL,
  trigger_condition VARCHAR(64) NOT NULL DEFAULT '', delay_hours INT NOT NULL DEFAULT 1,
  rule_defaults_version INT NOT NULL DEFAULT 1, deleted TINYINT(1) NOT NULL DEFAULT 0,
  enabled_defaults_version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, scenario)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

export async function inspectCustomerMessageTemplateOwnership(query) {
  const [tenant] = await query("SELECT id FROM tenants WHERE slug='default' AND status='active' LIMIT 1");
  const defaultId = Number(tenant?.id);
  if (!Number.isSafeInteger(defaultId) || defaultId <= 0) throw new Error('Active default enterprise is required');
  const exists = (await query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_message_templates'")).length > 0;
  if (!exists) return { default_tenant_id: defaultId, exists: false, legacy_null_count: 0, duplicate_count: 0 };
  const columns = await query('SHOW COLUMNS FROM customer_message_templates');
  const indexes = await query('SHOW INDEX FROM customer_message_templates');
  const uniqueKeys = new Map();
  for (const index of indexes.filter(row => !Number(row.Non_unique))) {
    const key = uniqueKeys.get(index.Key_name) || [];
    key[Number(index.Seq_in_index)-1] = index.Column_name;
    uniqueKeys.set(index.Key_name,key);
  }
  const conflictingUniqueKeys = [...uniqueKeys].filter(([name, key]) => {
    if (name === 'PRIMARY' && key.join(',') === 'scenario') return false;
    return key.length !== 2 || !key.includes('tenant_id') || !key.includes('scenario');
  }).map(([name]) => name);
  const owner = columns.some(row => row.Field === 'tenant_id') ? 'tenant_id' : 'NULL';
  const [counts] = await query(`SELECT COUNT(*) row_count,SUM(${owner} IS NULL) legacy_null_count FROM customer_message_templates`);
  const [duplicates] = await query(`SELECT COUNT(*) duplicate_count FROM (SELECT COALESCE(${owner},?) tenant,scenario FROM customer_message_templates GROUP BY tenant,scenario HAVING COUNT(*)>1) duplicate_keys`, [defaultId]);
  return { default_tenant_id: defaultId, exists: true, tenant_column: owner !== 'NULL', row_count: Number(counts.row_count), legacy_null_count: Number(counts.legacy_null_count || 0), duplicate_count: Number(duplicates.duplicate_count), conflicting_unique_keys: conflictingUniqueKeys };
}

export async function migrateCustomerMessageTemplateOwnership(query, { assignLegacyDefault = false } = {}) {
  const before = await inspectCustomerMessageTemplateOwnership(query);
  if (!assignLegacyDefault) throw new Error('Template migration requires explicit --assign-legacy-customer-default');
  if (before.duplicate_count) throw new Error('Customer-message template ownership conflicts require manual repair');
  if (before.conflicting_unique_keys?.length) throw new Error('Unexpected customer-message template unique keys require manual review');
  if (!before.exists) await query(CUSTOMER_MESSAGE_TEMPLATES_SCHEMA);
  else if (!before.tenant_column) await query('ALTER TABLE customer_message_templates ADD COLUMN tenant_id BIGINT UNSIGNED NULL');
  const assigned = await query('UPDATE customer_message_templates SET tenant_id=? WHERE tenant_id IS NULL', [before.default_tenant_id]);
  const columns = (await query('SHOW INDEX FROM customer_message_templates')).filter(row => row.Key_name === 'PRIMARY').sort((a,b) => a.Seq_in_index-b.Seq_in_index).map(row => row.Column_name);
  await query(`ALTER TABLE customer_message_templates MODIFY tenant_id BIGINT UNSIGNED NOT NULL DEFAULT ${before.default_tenant_id}${columns.join(',') === 'tenant_id,scenario' ? '' : `, ${columns.length ? 'DROP PRIMARY KEY, ' : ''}ADD PRIMARY KEY (tenant_id,scenario)`}`);
  return { before, legacy_default_rows_assigned: Number(assigned.affectedRows || 0), after: await inspectCustomerMessageTemplateOwnership(query) };
}
