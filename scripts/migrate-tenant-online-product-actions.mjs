import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const APPLY = process.argv.includes("--apply");
const socketPath = process.argv.find((arg) => arg.startsWith("--mysql-admin-socket="))?.split("=").slice(1).join("=");
const TABLE = "online_product_actions";
const INDEX = "idx_online_product_actions_tenant_shop_created";

async function inspect() {
  const tables = await mysqlQuery(`SHOW TABLES LIKE '${TABLE}'`);
  if (!tables.length) return { exists: false, row_count: 0, tenant_id_column: false, indexes: [] };
  const [columns, indexes] = await Promise.all([
    mysqlQuery(`SHOW COLUMNS FROM ${TABLE}`),
    mysqlQuery(`SHOW INDEX FROM ${TABLE}`)
  ]);
  const hasTenantColumn = columns.some((column) => column.Field === "tenant_id");
  const [counts] = await mysqlQuery(`SELECT COUNT(*) AS row_count${hasTenantColumn ? ", SUM(tenant_id IS NULL) AS legacy_unattributed_rows" : ""} FROM ${TABLE}`);
  return {
    exists: true,
    row_count: Number(counts.row_count || 0),
    legacy_unattributed_rows: Number(counts.legacy_unattributed_rows || 0),
    tenant_id_column: hasTenantColumn,
    indexes: [...new Set(indexes.map((index) => index.Key_name))]
  };
}

async function run() {
  if (APPLY && !socketPath) throw new Error("Apply mode requires --mysql-admin-socket for the MySQL administrator connection");
  const before = await inspect();
  if (!before.exists) {
    console.log(JSON.stringify({ ok: true, mode: APPLY ? "apply" : "dry-run", message: "Action table does not exist; application schema creates it tenant-aware.", before }));
    return;
  }
  if (!APPLY) {
    console.log(JSON.stringify({
      ok: true,
      mode: "dry-run",
      changes_database: false,
      legacy_attribution: "existing rows remain NULL and visible only to the default tenant; ownership is not inferred",
      before
    }));
    return;
  }

  const admin = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  try {
    const [[lock]] = await admin.query("SELECT GET_LOCK('tenant_online_product_actions_v1', 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("Online product action tenant migration lock unavailable");
    let [columns] = await admin.query(`SHOW COLUMNS FROM ${TABLE}`);
    if (!columns.some((column) => column.Field === "tenant_id")) {
      await admin.query(`ALTER TABLE ${TABLE} ADD COLUMN tenant_id VARCHAR(80) NULL AFTER id`);
    }
    let [indexes] = await admin.query(`SHOW INDEX FROM ${TABLE}`);
    if (!indexes.some((index) => index.Key_name === INDEX)) {
      await admin.query(`ALTER TABLE ${TABLE} ADD KEY ${INDEX} (tenant_id, shop_id, created_at, id)`);
    }
    [columns, indexes] = await Promise.all([
      admin.query(`SHOW COLUMNS FROM ${TABLE}`),
      admin.query(`SHOW INDEX FROM ${TABLE}`)
    ]);
    if (!columns[0].some((column) => column.Field === "tenant_id") || !indexes[0].some((index) => index.Key_name === INDEX)) {
      throw new Error("Online product action tenant schema verification failed");
    }
    await admin.query("SELECT RELEASE_LOCK('tenant_online_product_actions_v1')");
    console.log(JSON.stringify({
      ok: true,
      mode: "apply",
      legacy_rows_preserved_unattributed: before.legacy_unattributed_rows ?? before.row_count,
      legacy_rows_backfilled: false,
      index: INDEX
    }));
  } catch (error) {
    try { await admin.query("SELECT RELEASE_LOCK('tenant_online_product_actions_v1')"); } catch {}
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
