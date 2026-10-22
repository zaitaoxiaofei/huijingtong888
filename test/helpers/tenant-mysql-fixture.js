import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { ORDER_PROFIT_CALCULATION_SCHEMA } from '../../src/services/order-profit-calculation-schema.js';
import { OGL_DISPATCH_SCHEMA_SQL } from '../../src/services/ogl-dispatch-schema.js';
import { initializeOrderQueryFacts } from '../../src/services/order-query-facts.js';

// Never uses application credentials or an existing database. The caller must
// explicitly provide the independent test socket; only our random DB is dropped.
export async function createTenantMysqlFixture(prefix = 'inventory') {
  const socketPath = process.env.TENANT_TEST_MYSQL_SOCKET;
  if (!socketPath) throw new Error('TENANT_TEST_MYSQL_SOCKET is required for isolated MySQL fixtures');
  if (!/^[a-z][a-z0-9_]{0,20}$/.test(prefix)) throw new Error('Invalid fixture database prefix');
  const database = `ozon_${prefix}_test_${randomBytes(8).toString('hex')}`;
  const connection = await mysql.createConnection({ socketPath, user: 'root', multipleStatements: true });
  let created = false;
  const cleanup = async () => {
    try { if (created) await connection.query(`DROP DATABASE IF EXISTS \`${database}\``); }
    finally { await connection.end(); }
  };
  try {
    const [[server]] = await connection.query('SELECT @@skip_networking AS networking_disabled');
    if (Number(server.networking_disabled) !== 1) throw new Error('Fixture server must have TCP networking disabled');
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    created = true;
    await connection.changeUser({ database });
    await connection.query("SET time_zone = '+00:00'");
    const source = await readFile(new URL('../../scripts/init-mysql-schema.mjs', import.meta.url), 'utf8');
    const match = source.match(/const mysqlSchemaSql = (`[\s\S]*?`);/);
    if (!match) throw new Error('Canonical MySQL schema template not found');
    // Evaluate the checked-in schema template exactly as the normal initializer does.
    const staticSchema = async (file, name) => {
      const text = await readFile(new URL(`../../src/services/${file}`, import.meta.url), 'utf8');
      const value = text.match(new RegExp(`export const ${name} = (\x60[\\s\\S]*?\x60);`));
      if (!value) throw new Error(`Canonical schema constant missing: ${name}`);
      return Function(`return ${value[1]};`)();
    };
    const privateFiles = await staticSchema('tenant-private-files-schema.js', 'TENANT_PRIVATE_FILES_SCHEMA');
    const salesRefresh = await staticSchema('mysql-inventory-alert-snapshots.js', 'TENANT_INVENTORY_SALES_REFRESH_SCHEMA');
    const constants = { ORDER_PROFIT_CALCULATION_SCHEMA, OGL_DISPATCH_SCHEMA_SQL, TENANT_PRIVATE_FILES_SCHEMA: privateFiles, TENANT_INVENTORY_SALES_REFRESH_SCHEMA: salesRefresh };
    for (const name of ['TENANT_AI_LIMITS_SCHEMA', 'TENANT_AI_USAGE_SCHEMA', 'AI_IMAGE_TASK_OWNERS_SCHEMA']) {
      constants[name] = await staticSchema('ai-tenant-schema.js', name);
    }
    constants.TEAM_TASKS_SCHEMA = await staticSchema('team-task-schema.js', 'TEAM_TASKS_SCHEMA');
    constants.ORDER_HEATMAP_TENANT_SCHEMA = await staticSchema('order-heatmap-tenant-schema.js', 'ORDER_HEATMAP_TENANT_SCHEMA');
    constants.MATERIAL_ASSETS_SCHEMA = await staticSchema('material-assets-schema.js', 'MATERIAL_ASSETS_SCHEMA');
    constants.CUSTOMER_MESSAGE_TEMPLATES_SCHEMA = await staticSchema('customer-message-template-schema.js', 'CUSTOMER_MESSAGE_TEMPLATES_SCHEMA');
    constants.AI_VEHICLE_CATALOG_SCHEMA = await staticSchema('ai-vehicle-catalog-schema.js', 'AI_VEHICLE_CATALOG_SCHEMA');
    for (const name of ['CUSTOMER_MESSAGE_SHOP_SCHEMA', 'CUSTOMER_MESSAGE_TASKS_SCHEMA']) {
      constants[name] = await staticSchema('customer-message-core-schema.js', name);
    }
    const schema = Function(...Object.keys(constants), `return ${match[1]};`)(...Object.values(constants));
    await connection.query(schema);
    await initializeOrderQueryFacts(connection);
    const env = { DB_CLIENT: 'mysql', DB_HOST: 'localhost', DB_NAME: database, DB_USER: 'root', DB_PASSWORD: '', DB_SOCKET_PATH: socketPath, PORT: '8788' };
    return {
      database, connection, env,
      query: async (sql, params = []) => (await connection.execute(sql, params))[0],
      useEnvironment() { for (const [key, value] of Object.entries(env)) process.env[key] = value; },
      cleanup
    };
  } catch (error) { await cleanup(); throw error; }
}
