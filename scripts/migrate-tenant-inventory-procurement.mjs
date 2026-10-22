import mysql from 'mysql2/promise';
import { config } from '../src/config.js';
import { closeMysqlPool, mysqlQuery } from '../src/mysql-pool.js';
import { inspectProcurementImportOwnership, migrateProcurementImportOwnership } from '../src/services/tenant-procurement-import-schema.js';

const tables = ['purchase_orders', 'purchase_order_items', 'inbound_records', 'purchase_cost_versions',
  'procurement_platform_orders', 'procurement_payment_transactions', 'procurement_payment_matches',
  'inventory_product_requests', 'inventory_product_naming_options'];
const apply = process.argv.includes('--apply');
const assignLegacyDefault = process.argv.includes('--assign-legacy-platform-default');
const socketPath = process.argv.find(arg => arg.startsWith('--mysql-admin-socket='))?.slice('--mysql-admin-socket='.length);
const lockName = 'tenant_inventory_procurement_v1';

async function inspect(query) {
  const result = [];
  for (const table of tables) {
    const exists = (await query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table])).length > 0;
    if (!exists) { result.push({ table, exists: false }); continue; }
    const columns = await query(`SHOW COLUMNS FROM ${table}`), indexes = await query(`SHOW INDEX FROM ${table}`);
    const tenant = columns.find(column => column.Field === 'tenant_id');
    if (tenant && !/bigint/i.test(tenant.Type)) throw new Error(`${table}.tenant_id must be BIGINT; manual review required`);
    const [count] = await query(`SELECT COUNT(*) AS row_count${tenant ? ', SUM(tenant_id IS NULL) AS legacy_null_count' : ''} FROM ${table}`);
    result.push({ table, exists, tenant_column: Boolean(tenant), index: indexes.some(index => index.Key_name === `idx_${table}_tenant_id`),
      row_count: Number(count.row_count), legacy_null_count: tenant ? Number(count.legacy_null_count || 0) : Number(count.row_count) });
  }
  return result;
}

async function run() {
  if (!apply) {
    console.log(JSON.stringify({ ok: true, mode: 'dry-run', changes_database: false,
      legacy_policy: 'No ownership inference or reassignment; legacy NULL is default-only and all referenced parents must also belong to default.',
      tables: await inspect(mysqlQuery), import_key_migration: await inspectProcurementImportOwnership(mysqlQuery) }));
    return;
  }
  if (!socketPath) throw new Error('Apply requires explicit --mysql-admin-socket');
  const connection = await mysql.createConnection({ user: 'root', socketPath, database: config.dbName });
  try {
    const query = async (sql, params = []) => (await connection.query(sql, params))[0];
    const [lock] = await query('SELECT GET_LOCK(?, 60) AS acquired', [lockName]);
    if (Number(lock.acquired) !== 1) throw new Error('Inventory procurement migration lock unavailable');
    const before = await inspect(query);
    if (!assignLegacyDefault) throw new Error('Apply requires --assign-legacy-platform-default for safe old-writer import compatibility');
    for (const table of before.filter(item => item.exists)) {
      if (!table.tenant_column) await query(`ALTER TABLE ${table.table} ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id`);
      if (!table.index) await query(`ALTER TABLE ${table.table} ADD INDEX idx_${table.table}_tenant_id (tenant_id, id)`);
    }
    const importKeyMigration = await migrateProcurementImportOwnership(query, { assignLegacyDefault });
    for (const [table, index, columns] of [
      ['inventory_product_naming_options', 'uk_inventory_product_naming_option', ['tenant_id', 'option_type', 'value']],
      ['inventory_product_requests', 'uk_inventory_request_key', ['tenant_id', 'applicant_id', 'request_key']]
    ]) {
      if (!before.some(item => item.table === table && item.exists)) continue;
      const indexes = await query(`SHOW INDEX FROM ${table}`);
      const existing = indexes.filter(item => item.Key_name === index).sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(item => item.Column_name);
      if (existing.join(',') !== columns.join(',')) {
        if (existing.length) await query(`ALTER TABLE ${table} DROP INDEX ${index}`);
        await query(`ALTER TABLE ${table} ADD UNIQUE INDEX ${index} (${columns.join(',')})`);
      }
    }
    console.log(JSON.stringify({ ok: true, mode: 'apply', changes_database: true, ownership_policy: 'Only the three documented legacy default import tables receive explicit default ownership; all other historical NULL ownership remains unchanged.', import_key_migration: importKeyMigration, before, after: await inspect(query) }));
  } finally {
    try { await connection.query('SELECT RELEASE_LOCK(?)', [lockName]); } finally { await connection.end(); }
  }
}

try { await run(); } finally { await closeMysqlPool(); }
