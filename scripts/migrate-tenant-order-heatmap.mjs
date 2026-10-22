import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { applyOrderHeatmapTenantSchema, inspectOrderHeatmapTenantSchema } from './lib/tenant-order-heatmap-migration.mjs';

const apply = process.argv.includes('--apply');
const socketPath = process.argv.find(arg => arg.startsWith('--mysql-admin-socket='))?.slice('--mysql-admin-socket='.length);
const database = process.argv.find(arg => arg.startsWith('--database='))?.slice('--database='.length);
let connection;
let locked = false;
const lockName = `tenant_heatmap_v1:${createHash('sha256').update(database || '').digest('hex').slice(0, 32)}`;
try {
  if (!socketPath || !database) throw new Error('Explicit --mysql-admin-socket and --database are required; application configuration is never used');
  connection = await mysql.createConnection({ socketPath, user: 'root', database });
  const query = async (sql, params = []) => (await connection.query(sql, params))[0];
  const [selected] = await query('SELECT DATABASE() AS database_name');
  if (selected.database_name !== database) throw new Error('Selected database differs from the explicitly requested database');
  if (!apply) console.log(JSON.stringify({ ok: true, mode: 'dry-run', changes_database: false, schema: await inspectOrderHeatmapTenantSchema(query) }));
  else {
    const [lock] = await query('SELECT GET_LOCK(?, 60) AS acquired', [lockName]);
    if (Number(lock.acquired) !== 1) throw new Error('Order heatmap migration lock unavailable');
    locked = true;
    const result = await applyOrderHeatmapTenantSchema(query);
    console.log(JSON.stringify({ ok: true, mode: 'apply', ...result, legacy_null_ownership: 'default-only', data_rows_changed: 0 }));
  }
} finally {
  if (connection) {
    if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
    await connection.end();
  }
}
