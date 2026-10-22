import mysql from 'mysql2/promise';
import { pathToFileURL } from 'node:url';
import { migrateAiVehicleCatalogSchema } from '../src/services/ai-vehicle-catalog-schema.js';

export { migrateAiVehicleCatalogSchema as migrateTenantVehicleCatalog };

async function main() {
  const value = key => process.argv.find(arg => arg.startsWith(`${key}=`))?.slice(key.length+1);
  const socketPath = value('--mysql-admin-socket'), database = value('--database');
  if (!socketPath || !database) throw new Error('Explicit --mysql-admin-socket and --database are required');
  const connection = await mysql.createConnection({ socketPath, database, user: 'root' });
  try { console.log(JSON.stringify(await migrateAiVehicleCatalogSchema(connection, { apply: process.argv.includes('--apply') }))); }
  finally { await connection.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
