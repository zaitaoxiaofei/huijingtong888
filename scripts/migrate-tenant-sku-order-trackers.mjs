import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { assertTenantSkuTrackerPreflight, applyTenantSkuOrderTrackers, inspectTenantSkuOrderTrackers } from './lib/tenant-sku-order-trackers-migration.mjs';

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const value = /^--(database|mysql-admin-socket)=(.+)$/.exec(arg);
  if (arg === '--apply' && !args.has('apply')) args.set('apply', true);
  else if (value && !args.has(value[1])) args.set(value[1], value[2]);
  else throw new Error('Unknown or duplicate SKU tracker migration argument');
}
const apply = args.has('apply');
const database = args.get('database');
const socketPath = args.get('mysql-admin-socket');
let connection;
let locked = false;
const lockName = `tenant_sku_order_trackers_v1:${createHash('sha256').update(database || '').digest('hex').slice(0, 32)}`;
try {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database || '') || !socketPath) throw new Error('Explicit --database and --mysql-admin-socket are required; application credentials are never used');
  connection = await mysql.createConnection({ socketPath, user: 'root', database, multipleStatements: false, connectTimeout: 10000 });
  const query = async (sql, params = []) => (await connection.query(sql, params))[0];
  const [selected] = await query('SELECT DATABASE() AS database_name');
  if (selected.database_name !== database) throw new Error('Selected database does not match the explicit migration target');
  await query('SET SESSION lock_wait_timeout = 10');
  await query('SET SESSION innodb_lock_wait_timeout = 10');
  if (!apply) {
    await query('START TRANSACTION READ ONLY');
    const before = await inspectTenantSkuOrderTrackers(query);
    assertTenantSkuTrackerPreflight(before);
    console.log(JSON.stringify({ ok: true, mode: 'dry-run', changes_database: false, requires_apply: !before.ready, before }));
  } else {
    const [lock] = await query('SELECT GET_LOCK(?, 10) AS acquired', [lockName]);
    if (Number(lock.acquired) !== 1) throw new Error('SKU tracker tenant migration lock unavailable');
    locked = true;
    const result = await applyTenantSkuOrderTrackers(query);
    console.log(JSON.stringify({ ok: true, mode: 'apply', ...result, application_privileges_unchanged: true }));
  }
} finally {
  if (connection) {
    try { if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [lockName]); }
    finally { await connection.end(); }
  }
}
