import mysql from "mysql2/promise";
import { inspectOperationalQueryIndexes, ensureOperationalQueryIndexes } from "../src/services/operational-query-indexes.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const database = args.find(arg => arg.startsWith("--database="))?.slice(11);
const socketPath = args.find(arg => arg.startsWith("--mysql-admin-socket="))?.slice(21);
if (!/^[A-Za-z0-9_]{1,64}$/.test(database || "") || !socketPath?.startsWith("/")) throw Error("Explicit database and administrator socket required");
if (args.some(arg => arg !== "--apply" && !/^--(database|mysql-admin-socket)=/.test(arg))) throw Error("Unknown migration argument");
const connection = await mysql.createConnection({ user: "root", database, socketPath });
try {
  await connection.query("SET SESSION lock_wait_timeout=5");
  const before = await inspectOperationalQueryIndexes(connection);
  if (before.indexes.some(index => index.present && !index.valid) || (before.finance_column.present && !before.finance_column.valid)) throw Error("Existing operational query index has an incompatible definition");
  if (!apply) console.log(JSON.stringify({ ok: true, mode: "dry-run", changes_database: false, ...before }));
  else {
    const [[lock]] = await connection.query("SELECT GET_LOCK('operational_query_indexes_v1',5) acquired");
    if (Number(lock.acquired) !== 1) throw Error("Operational index migration already running");
    try { console.log(JSON.stringify({ ok: true, mode: "apply", ...await ensureOperationalQueryIndexes(connection) })); }
    finally { await connection.query("SELECT RELEASE_LOCK('operational_query_indexes_v1')"); }
  }
} finally { await connection.end(); }
