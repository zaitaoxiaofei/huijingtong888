import mysql from 'mysql2/promise';
import { pathToFileURL } from 'node:url';
import { migrateAiVariantDraftHistoryIndex } from './lib/ai-variant-draft-history-index-migration.mjs';

export { migrateAiVariantDraftHistoryIndex };

async function main() {
  const value = name => process.argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const database = value('--database');
  const socketPath = value('--mysql-admin-socket');
  const apply = process.argv.includes('--apply');
  if (!database || !/^[A-Za-z0-9_]+$/.test(database)) throw new Error('Explicit --database=<name> is required');
  if (apply && !socketPath) throw new Error('Apply requires explicit --mysql-admin-socket; application credentials cannot apply DDL');
  let connection;
  let closePool;
  try {
    let query;
    if (socketPath) {
      connection = await mysql.createConnection({ socketPath, database, user: 'root' });
      query = async (sql, params = []) => (await connection.query(sql, params))[0];
    } else {
      const { config } = await import('../src/config.js');
      if (database !== config.dbName) throw new Error('Dry-run without admin socket must match configured DB_NAME');
      const { mysqlQuery, closeMysqlPool } = await import('../src/mysql-pool.js');
      query = mysqlQuery;
      closePool = closeMysqlPool;
    }
    console.log(JSON.stringify(await migrateAiVariantDraftHistoryIndex(query, { database, apply })));
  } finally {
    if (connection) await connection.end();
    if (closePool) await closePool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
