import mysql from 'mysql2/promise';
import { pathToFileURL } from 'node:url';
import { MATERIAL_ASSETS_SCHEMA } from '../src/services/material-assets-schema.js';

export async function migrateTenantMaterialAssets(connection, { apply = false } = {}) {
  let locked = false;
  try {
    if (apply) {
      const [[lock]] = await connection.query("SELECT GET_LOCK(CONCAT('material_tenant_', LEFT(SHA2(DATABASE(),256),32)),60) acquired");
      if (Number(lock.acquired) !== 1) throw new Error('Material asset ownership migration lock unavailable');
      locked = true;
    }
    const [found] = await connection.execute("SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='material_assets'");
    const [columns] = found.length ? await connection.query('SHOW COLUMNS FROM material_assets') : [[]];
    const [indexes] = found.length ? await connection.query('SHOW INDEX FROM material_assets') : [[]];
    const hasTenant = columns.some(row => row.Field === 'tenant_id');
    const key = indexes.filter(row => row.Key_name === 'idx_material_assets_tenant').sort((a,b) => a.Seq_in_index-b.Seq_in_index).map(row => row.Column_name);
    if (key.length && key.join(',') !== 'tenant_id,status,updated_at,id') throw new Error('Conflicting material asset tenant index');
    if (apply) {
      if (!found.length) await connection.query(MATERIAL_ASSETS_SCHEMA);
      else {
        if (!hasTenant) await connection.query('ALTER TABLE material_assets ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id');
        if (!key.length) await connection.query('ALTER TABLE material_assets ADD KEY idx_material_assets_tenant(tenant_id,status,updated_at,id)');
      }
      const [verified] = await connection.query("SHOW COLUMNS FROM material_assets LIKE 'tenant_id'");
      if (verified[0]?.Type !== 'bigint unsigned' || verified[0]?.Null !== 'YES') throw new Error('Material asset ownership column verification failed');
    }
    return { ok: true, mode: apply ? 'apply' : 'dry-run', exists: Boolean(found.length), add_tenant_column: !hasTenant, add_index: !key.length, legacy_null_scope: 'default only; existing rows are not reassigned' };
  } finally { if (locked) await connection.query("SELECT RELEASE_LOCK(CONCAT('material_tenant_', LEFT(SHA2(DATABASE(),256),32)))"); }
}

async function main() {
  const value = key => process.argv.find(arg => arg.startsWith(`${key}=`))?.slice(key.length+1);
  const socketPath = value('--mysql-admin-socket'), database = value('--database');
  if (!socketPath || !database) throw new Error('Explicit --mysql-admin-socket and --database are required');
  const connection = await mysql.createConnection({ socketPath, database, user: 'root' });
  try { console.log(JSON.stringify(await migrateTenantMaterialAssets(connection, { apply: process.argv.includes('--apply') }))); }
  finally { await connection.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
