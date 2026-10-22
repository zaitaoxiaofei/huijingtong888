import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';
import { closeMysqlPool, mysqlQuery } from '../src/mysql-pool.js';
import { inspectCustomerMessageTemplateOwnership, migrateCustomerMessageTemplateOwnership } from '../src/services/customer-message-template-schema.js';
import { CUSTOMER_MESSAGE_SHOP_SCHEMA, CUSTOMER_MESSAGE_TASKS_SCHEMA } from '../src/services/customer-message-core-schema.js';

const value = name => process.argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const database = value('--database');
const apply = process.argv.includes('--apply');
const socketPath = value('--mysql-admin-socket');
const assignLegacyDefault = process.argv.includes('--assign-legacy-customer-default');
if (!database || !/^[A-Za-z0-9_]+$/.test(database)) throw new Error('Explicit --database=<name> is required');
const lockName = `tenant_customer_messages_${createHash('sha256').update(database).digest('hex').slice(0,24)}`;

async function inspect(query) {
  const principalColumns = [];
  for (const [table,column] of [['customer_message_shop_settings','automation_person_id'],['customer_message_tasks','person_id']]) {
    const exists = (await query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table])).length > 0;
    const columns = exists ? await query(`SHOW COLUMNS FROM ${table}`) : [];
    principalColumns.push({ table, column, exists, principal_column: columns.some(row => row.Field === column) });
  }
  return { templates: await inspectCustomerMessageTemplateOwnership(query), principal_columns: principalColumns };
}

let connection;
try {
  let query;
  if (socketPath) {
    connection = await mysql.createConnection({ user: 'root', socketPath, database });
    query = async (sql,params=[]) => (await connection.query(sql,params))[0];
  } else {
    if (apply) throw new Error('Apply requires explicit --mysql-admin-socket');
    if (database !== config.dbName) throw new Error('Dry-run without admin socket must match configured DB_NAME');
    query = mysqlQuery;
  }
  const before = await inspect(query);
  if (!apply) {
    console.log(JSON.stringify({ ok:true,mode:'dry-run',database,changes_database:false,before,
      policy:'Explicitly assign only legacy templates to default; no sender identity is inferred. Existing shops and tasks retain NULL principals until an authorized operator saves settings.' }));
  } else {
    if (!assignLegacyDefault) throw new Error('Apply requires --assign-legacy-customer-default');
    const [lock] = await query('SELECT GET_LOCK(?,60) acquired',[lockName]);
    if (Number(lock.acquired)!==1) throw new Error('Customer message migration lock unavailable');
    try {
      const templates = await migrateCustomerMessageTemplateOwnership(query,{assignLegacyDefault});
      await query(CUSTOMER_MESSAGE_SHOP_SCHEMA);
      await query(CUSTOMER_MESSAGE_TASKS_SCHEMA);
      for (const { table,column,exists,principal_column } of before.principal_columns) {
        if (exists && !principal_column) await query(`ALTER TABLE ${table} ADD COLUMN ${column} BIGINT UNSIGNED NULL`);
      }
      console.log(JSON.stringify({ok:true,mode:'apply',database,changes_database:true,templates,before,after:await inspect(query),
        policy:'DDL commits separately. Only template NULL ownership is assigned; no principal or other customer record is reassigned.'}));
    } finally { await query('SELECT RELEASE_LOCK(?)',[lockName]); }
  }
} finally {
  if (connection) await connection.end();
  await closeMysqlPool();
}
