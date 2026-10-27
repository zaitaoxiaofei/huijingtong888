import mysql from "mysql2/promise";
import { pathToFileURL } from "node:url";
import { ENTERPRISE_MESSAGES_SCHEMA_SQL } from "../src/services/enterprise-messages.js";
import { inspectPeopleAccountKind, preparePeopleAccountKind } from "../src/services/people-account-kind.js";

async function inspect(query) {
  const exists = (await query("SHOW TABLES LIKE 'enterprise_direct_messages'")).length > 0;
  if (!exists) return { exists: false, ready: false };
  const columns = new Map((await query("SHOW FULL COLUMNS FROM enterprise_direct_messages")).map(row => [row.Field, row]));
  const indexes = await query("SHOW INDEX FROM enterprise_direct_messages");
  const problems = [];
  const [table] = await query("SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enterprise_direct_messages'");
  if (table?.ENGINE !== "InnoDB") problems.push("engine:InnoDB");
  const columnTypes = { id: "bigint unsigned", tenant_id: "bigint unsigned", sender_id: "bigint unsigned", recipient_id: "bigint unsigned",
    client_message_id: "varchar(64)", text: "text", reference_type: "varchar(20)", reference_id: "bigint unsigned", created_at: "datetime(3)", read_at: "datetime(3)" };
  for (const [name, type] of Object.entries(columnTypes)) {
    const column = columns.get(name);
    const nullable = ["reference_type", "reference_id", "read_at"].includes(name);
    if (!column || column.Type.toLowerCase().replace(/bigint\(\d+\)/, "bigint") !== type || column.Null !== (nullable ? "YES" : "NO")) problems.push(`column:${name}`);
  }
  if (!String(columns.get("id")?.Extra || "").includes("auto_increment")) problems.push("id:auto_increment");
  if (columns.get("client_message_id")?.Collation !== "ascii_bin") problems.push("client_message_id:ascii_bin");
  for (const name of ["text", "reference_type"]) if (!String(columns.get(name)?.Collation || "").startsWith("utf8mb4_")) problems.push(`${name}:utf8mb4`);
  const expectedIndexes = { PRIMARY: [true, "id"], uk_enterprise_message_retry: [true, "tenant_id,sender_id,client_message_id"],
    idx_enterprise_message_inbox: [false, "tenant_id,recipient_id,read_at,id"], idx_enterprise_message_sent: [false, "tenant_id,sender_id,recipient_id,id"],
    idx_enterprise_message_received: [false, "tenant_id,recipient_id,sender_id,id"] };
  for (const [name, [unique, fields]] of Object.entries(expectedIndexes)) {
    const rows = indexes.filter(row => row.Key_name === name).sort((a,b) => Number(a.Seq_in_index)-Number(b.Seq_in_index));
    if (rows.map(row => row.Column_name).join(",") !== fields || rows.some(row => Number(row.Non_unique) !== Number(!unique) || row.Sub_part != null || row.Index_type !== "BTREE")) problems.push(`index:${name}`);
  }
  return { exists, ready: problems.length === 0, problems };
}
export async function runEnterpriseMessagesMigration({ apply = false, socketPath, database,
  createConnection = mysql.createConnection } = {}) {
  if (apply && !socketPath) throw new Error("Apply requires an explicit local --mysql-admin-socket");
  let applicationPool;
  if (!database || !socketPath) {
    const { config } = await import("../src/config.js");
    database ||= config.dbName;
    if (!socketPath) {
      if (database !== config.dbName) throw new Error("Read-only application connection must match configured DB_NAME");
      applicationPool = await import("../src/mysql-pool.js");
    }
  }
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database || "")) throw new Error("A valid database is required");
  const connection = socketPath ? await createConnection({ socketPath, user: "root", database }) : null;
  const query = connection ? async (sql, params = []) => (await connection.query(sql, params))[0] : applicationPool.mysqlQuery;
  try {
    if (!apply) {
      const messages = await inspect(query), accountKind = await inspectPeopleAccountKind(query);
      return { mode: "dry-run", changes_database: false, ...messages, ready: messages.ready && accountKind.ready, account_kind: accountKind };
    }
    try {
      const [lock] = await query("SELECT GET_LOCK('enterprise_messages_schema_v1', 60) AS acquired");
      if (Number(lock.acquired) !== 1) throw new Error("Private messages schema migration lock unavailable");
      const before = await inspect(query);
      if (before.exists && !before.ready) throw new Error("Existing private messages schema is incompatible; manual review required");
      await preparePeopleAccountKind(query);
      for (const sql of ENTERPRISE_MESSAGES_SCHEMA_SQL) await query(sql);
      const after = await inspect(query);
      if (!after.ready) throw new Error("Private messages schema verification failed");
      return { mode: "apply", ...after, account_kind: await inspectPeopleAccountKind(query) };
    } finally {
      await query("SELECT RELEASE_LOCK('enterprise_messages_schema_v1')");
    }
  } finally {
    if (connection) await connection.end();
    else await applicationPool.closeMysqlPool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const value = name => process.argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  console.log(JSON.stringify(await runEnterpriseMessagesMigration({ apply: process.argv.includes("--apply"),
    socketPath: value("--mysql-admin-socket"), database: value("--database") })));
}
