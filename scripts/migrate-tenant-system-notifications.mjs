import mysql from 'mysql2/promise';
import { pathToFileURL } from 'node:url';

export async function migrateTenantSystemNotifications(connection, { apply = false } = {}) {
  let locked = false;
  try {
    if (apply) {
      const [[lock]] = await connection.query("SELECT GET_LOCK(CONCAT('notify_tenant_', LEFT(SHA2(DATABASE(),256),32)),60) acquired");
      if (Number(lock.acquired) !== 1) throw new Error('Notification ownership migration lock unavailable');
      locked = true;
    }
    const [columns] = await connection.query('SHOW COLUMNS FROM system_notifications');
    const [indexes] = await connection.query('SHOW INDEX FROM system_notifications');
    const hasTenant = columns.some(row => row.Field === 'tenant_id');
    const key = indexes.filter(row => row.Key_name === 'idx_system_notifications_tenant_recipient').sort((a,b) => a.Seq_in_index-b.Seq_in_index).map(row => row.Column_name);
    if (key.length && key.join(',') !== 'tenant_id,recipient_person_id,status,created_at') throw new Error('Conflicting notification ownership index');
    if (apply) {
      if (!hasTenant) await connection.query('ALTER TABLE system_notifications ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id');
      if (!key.length) await connection.query('ALTER TABLE system_notifications ADD KEY idx_system_notifications_tenant_recipient(tenant_id,recipient_person_id,status,created_at)');
      const [verified] = await connection.query("SHOW COLUMNS FROM system_notifications LIKE 'tenant_id'");
      if (verified[0]?.Type !== 'bigint unsigned' || verified[0]?.Null !== 'YES') throw new Error('Notification ownership column verification failed');
    }
    return { ok: true, mode: apply ? 'apply' : 'dry-run', add_tenant_column: !hasTenant, add_index: !key.length, legacy_null_scope: 'default only; existing notifications are not reassigned' };
  } finally { if (locked) await connection.query("SELECT RELEASE_LOCK(CONCAT('notify_tenant_', LEFT(SHA2(DATABASE(),256),32)))"); }
}

async function main() {
  const value = key => process.argv.find(arg => arg.startsWith(`${key}=`))?.slice(key.length+1);
  const socketPath = value('--mysql-admin-socket'), database = value('--database');
  if (!socketPath || !database) throw new Error('Explicit --mysql-admin-socket and --database are required');
  const connection = await mysql.createConnection({ socketPath, database, user: 'root' });
  try { console.log(JSON.stringify(await migrateTenantSystemNotifications(connection, { apply: process.argv.includes('--apply') }))); }
  finally { await connection.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
