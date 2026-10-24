import mysql from "mysql2/promise";
import { ORDER_SEARCH_INDEX, inspectOrderSearchIndex, ensureOrderSearchIndex } from "../src/services/order-search-indexes.js";

const apply = process.argv.includes("--apply");
const socketPath = process.argv.find(value => value.startsWith("--mysql-admin-socket="))?.slice("--mysql-admin-socket=".length);
const database = process.argv.find(value => value.startsWith("--database="))?.slice("--database=".length);
if (!database) throw new Error("An explicit --database is required");
if (apply && !socketPath) throw new Error("Apply requires --mysql-admin-socket");
let options = { socketPath, user: "root", database };
if (!socketPath) {
  const { config } = await import("../src/config.js");
  options = { host: config.dbHost, port: config.dbPort, user: config.dbUser, password: config.dbPassword, database };
}
const connection = await mysql.createConnection(options);
try {
  await connection.query("SET SESSION lock_wait_timeout = 5");
  if (!apply) {
    const before = await inspectOrderSearchIndex(connection);
    if (before.present && !before.valid) throw new Error("Existing order search index has an unexpected definition");
    console.log(JSON.stringify({ ok: true, mode: "dry-run", changes_database: false, index: ORDER_SEARCH_INDEX, before }));
  } else {
    const [[lock]] = await connection.query("SELECT GET_LOCK('order_search_indexes_v1', 30) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("Order search index migration lock unavailable");
    try { console.log(JSON.stringify({ ok: true, mode: "apply", index: ORDER_SEARCH_INDEX, ...await ensureOrderSearchIndex(connection) })); }
    finally { await connection.query("SELECT RELEASE_LOCK('order_search_indexes_v1')"); }
  }
} finally { await connection.end(); }
