import { pathToFileURL } from 'node:url';
import { inspectInventoryNumberingV2Schema, prepareInventoryNumberingV2Schema } from '../src/services/inventory-numbering-v2.js';

// Schema preparation only. Reviewed data cutover belongs to the V2 migration CLI.
export async function runInventoryNumberingSchemaCli(args) {
  const options = new Map();
  for (const argument of args) {
    const match = /^--(database|mysql-admin-socket|apply-schema)(?:=(.*))?$/.exec(argument);
    if (!match || options.has(match[1]) || (match[1] === 'apply-schema' ? match[2] !== undefined : !match[2])) throw new Error('Use explicit --database=, --mysql-admin-socket= and optional --apply-schema; this command never cuts over numbering');
    options.set(match[1], match[2] ?? true);
  }
  const database = options.get('database'), socketPath = options.get('mysql-admin-socket');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database || '') || typeof socketPath !== 'string' || !(socketPath.startsWith('/') || socketPath.startsWith('\\\\.\\pipe\\'))) throw new Error('Explicit database and local administrator socket required; application configuration is not used');
  const { default: mysql } = await import('mysql2/promise');
  const db = await mysql.createConnection({ database, socketPath, user: 'root' });
  let locked = false;
  try {
    await db.query('SET SESSION lock_wait_timeout = 5');
    await db.query('SET SESSION innodb_lock_wait_timeout = 5');
    await db.query('SET SESSION max_execution_time = 10000');
    if (options.has('apply-schema')) {
      const [[lock]] = await db.query("SELECT GET_LOCK('inventory_numbering_schema_v1', 5) AS acquired");
      if (Number(lock.acquired) !== 1) throw new Error('Inventory numbering preparation lock unavailable');
      locked = true;
    } else await db.query('START TRANSACTION READ ONLY');
    const schema = options.has('apply-schema') ? await prepareInventoryNumberingV2Schema(db) : await inspectInventoryNumberingV2Schema(db);
    if (!options.has('apply-schema')) await db.rollback();
    return { mode: options.has('apply-schema') ? 'schema-prepared' : 'read-only', ...schema, data_cutover: false };
  } finally {
    try { if (locked) await db.query("SELECT RELEASE_LOCK('inventory_numbering_schema_v1')"); }
    finally { await db.end(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runInventoryNumberingSchemaCli(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  });
}
