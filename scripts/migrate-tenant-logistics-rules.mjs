import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const APPLY = process.argv.includes("--apply");
const socketPath = process.argv.find((arg) => arg.startsWith("--mysql-admin-socket="))?.split("=").slice(1).join("=");
const INDEX = ["idx_logistics_rules_tenant_enabled_version", "(tenant_id, enabled, version_group_id, effective_from, id)"];
const OPTIONAL_COLUMNS = [
  ["usage_count", "INT NOT NULL DEFAULT 0"],
  ["last_used_at", "DATETIME NULL"],
  ["version_group_id", "BIGINT UNSIGNED NULL"],
  ["effective_from", "DATETIME NULL"],
  ["effective_to", "DATETIME NULL"]
];

async function inspect(query = mysqlQuery) {
  const tables = await query("SHOW TABLES LIKE 'logistics_fee_rules'");
  if (!tables.length) return { exists: false, row_count: 0, tenant_id_column: false, indexes: [], columns: [] };
  const [columns, indexes] = await Promise.all([
    query("SHOW COLUMNS FROM logistics_fee_rules"),
    query("SHOW INDEX FROM logistics_fee_rules")
  ]);
  const hasTenantColumn = columns.some((column) => column.Field === "tenant_id");
  const [counts] = await query(`SELECT COUNT(*) AS row_count${hasTenantColumn ? ", SUM(tenant_id IS NULL) AS legacy_unattributed_rows" : ""} FROM logistics_fee_rules`);
  return {
    exists: true,
    row_count: Number(counts.row_count || 0),
    legacy_unattributed_rows: Number(counts.legacy_unattributed_rows || 0),
    tenant_id_column: hasTenantColumn,
    indexes: [...new Set(indexes.map((index) => index.Key_name))],
    columns: [...new Set(columns.map((column) => column.Field))]
  };
}

async function run() {
  if (APPLY && !socketPath) throw new Error("Apply mode requires --mysql-admin-socket for the MySQL administrator connection");
  if (!APPLY) {
    const before = await inspect();
    console.log(JSON.stringify({
      ok: true,
      mode: "dry-run",
      changes_database: false,
      legacy_attribution: "existing logistics rules remain NULL and visible only to the default tenant; ownership is not inferred",
      before
    }));
    return;
  }

  const admin = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  try {
    const [[lock]] = await admin.query("SELECT GET_LOCK('tenant_logistics_rules_v1', 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("Logistics-rule tenant migration lock unavailable");
    const adminQuery = async (sql, params = []) => (await admin.query(sql, params))[0];
    const before = await inspect(adminQuery);
    if (!before.exists) {
      await admin.query("SELECT RELEASE_LOCK('tenant_logistics_rules_v1')");
      console.log(JSON.stringify({ ok: true, mode: "apply", message: "Logistics rule table does not exist; application schema creates it tenant-aware.", before }));
      return;
    }
    let [columns] = await admin.query("SHOW COLUMNS FROM logistics_fee_rules");
    for (const [name, definition] of OPTIONAL_COLUMNS) {
      if (!columns.some((column) => column.Field === name)) {
        await admin.query(`ALTER TABLE logistics_fee_rules ADD COLUMN ${name} ${definition}`);
        [columns] = await admin.query("SHOW COLUMNS FROM logistics_fee_rules");
      }
    }
    if (!columns.some((column) => column.Field === "tenant_id")) {
      await admin.query("ALTER TABLE logistics_fee_rules ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id");
    }
    let [indexes] = await admin.query("SHOW INDEX FROM logistics_fee_rules");
    if (!indexes.some((index) => index.Key_name === INDEX[0])) {
      await admin.query(`ALTER TABLE logistics_fee_rules ADD KEY ${INDEX[0]} ${INDEX[1]}`);
    }
    const [verifiedColumns, verifiedIndexes] = await Promise.all([
      admin.query("SHOW COLUMNS FROM logistics_fee_rules"),
      admin.query("SHOW INDEX FROM logistics_fee_rules")
    ]);
    if (!verifiedColumns[0].some((column) => column.Field === "tenant_id")
      || OPTIONAL_COLUMNS.some(([name]) => !verifiedColumns[0].some((column) => column.Field === name))
      || !verifiedIndexes[0].some((index) => index.Key_name === INDEX[0])) {
      throw new Error("Logistics-rule tenant ownership schema verification failed");
    }
    await admin.query("SELECT RELEASE_LOCK('tenant_logistics_rules_v1')");
    console.log(JSON.stringify({
      ok: true,
      mode: "apply",
      legacy_rows_preserved_unattributed: before.legacy_unattributed_rows ?? before.row_count,
      legacy_rows_backfilled: false,
      index: INDEX[0]
    }));
  } catch (error) {
    try { await admin.query("SELECT RELEASE_LOCK('tenant_logistics_rules_v1')"); } catch {}
    throw error;
  } finally {
    await admin.end();
  }
}

try {
  await run();
} finally {
  await closeMysqlPool();
}
