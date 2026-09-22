import mysql from 'mysql2/promise';
import { config } from '../src/config.js';
import { mysqlQuery, closeMysqlPool } from '../src/mysql-pool.js';
import { initializeOrderQueryFacts } from '../src/services/order-query-facts.js';

const socketPath = process.argv.find(arg => arg.startsWith('--mysql-admin-socket='))?.split('=').slice(1).join('=');
if (!socketPath) throw new Error('Specify --mysql-admin-socket for the local administrator connection');
let admin;
try {
  const [{ account }] = await mysqlQuery('SELECT CURRENT_USER() AS account');
  const at = account.lastIndexOf('@');
  admin = await mysql.createConnection({ socketPath, user: 'root', database: config.dbName });
  const [[lock]] = await admin.query("SELECT GET_LOCK('order_query_facts_v1', 60) AS acquired");
  if (Number(lock.acquired) !== 1) throw new Error('Order query facts migration is busy');
  await initializeOrderQueryFacts(admin, {
    triggerDefiner: `${admin.escape(account.slice(0, at))}@${admin.escape(account.slice(at + 1))}`
  });
  console.log('Order query facts and transactional maintenance verified; application privileges unchanged.');
} finally {
  if (admin) await admin.end();
  await closeMysqlPool();
}
