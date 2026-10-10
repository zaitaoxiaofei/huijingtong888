import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const APPLY = process.argv.includes("--apply");
const socketPath = process.argv.find((arg) => arg.startsWith("--mysql-admin-socket="))?.split("=").slice(1).join("=");
const TABLE = "products";
const INDEXES = [
  ["idx_products_tenant_active_updated", "(tenant_id, active, updated_at, id)"],
  ["idx_products_tenant_owner_active", "(tenant_id, owner_person_id, active, id)"]
];

async function inspect(query = mysqlQuery) {
  const tables = await query(`SHOW TABLES LIKE '${TABLE}'`);
  if (!tables.length) return { exists: false, row_count: 0, tenant_id_column: false, indexes: [] };
  const [columns, indexes] = await Promise.all([
    query(`SHOW COLUMNS FROM ${TABLE}`),
    query(`SHOW INDEX FROM ${TABLE}`)
  ]);
  const hasTenantColumn = columns.some((column) => column.Field === "tenant_id");
  const [counts] = await query(`SELECT COUNT(*) AS row_count${hasTenantColumn ? ", SUM(tenant_id IS NULL) AS legacy_unattributed_rows" : ""} FROM ${TABLE}`);
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
  if (!APPLY) {
    const before = await inspect();
    console.log(JSON.stringify({
      ok: true,
      mode: "dry-run",
      changes_database: false,
      legacy_attribution: "existing rows remain NULL and visible only to the default tenant; ownership is not inferred",
      unique_keys: "legacy global selection_id/code unique keys are preserved; tenant-local uniqueness is not enabled until dependent references are migrated",
      before
    }));
    return;
  }

  const admin = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  try {
    const [[lock]] = await admin.query("SELECT GET_LOCK('tenant_products_ownership_v1', 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("Product tenant ownership migration lock unavailable");
    const adminQuery = async (sql, params = []) => (await admin.query(sql, params))[0];
    const before = await inspect(adminQuery);
    if (!before.exists) {
      await admin.query("SELECT RELEASE_LOCK('tenant_products_ownership_v1')");
      console.log(JSON.stringify({ ok: true, mode: "apply", message: "Product table does not exist; application schema creates it tenant-aware.", before }));
      return;
    }
    let [columns] = await admin.query(`SHOW COLUMNS FROM ${TABLE}`);
    if (!columns.some((column) => column.Field === "tenant_id")) {
      await admin.query(`ALTER TABLE ${TABLE} ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id`);
    }
    let [indexes] = await admin.query(`SHOW INDEX FROM ${TABLE}`);
    for (const [name, definition] of INDEXES) {
      if (!indexes.some((index) => index.Key_name === name)) {
        await admin.query(`ALTER TABLE ${TABLE} ADD KEY ${name} ${definition}`);
        [indexes] = await admin.query(`SHOW INDEX FROM ${TABLE}`);
      }
    }
    [columns, indexes] = await Promise.all([
      admin.query(`SHOW COLUMNS FROM ${TABLE}`),
      admin.query(`SHOW INDEX FROM ${TABLE}`)
    ]);
    if (!columns[0].some((column) => column.Field === "tenant_id") || INDEXES.some(([name]) => !indexes[0].some((index) => index.Key_name === name))) {
      throw new Error("Product tenant ownership schema verification failed");
    }
    await admin.query("SELECT RELEASE_LOCK('tenant_products_ownership_v1')");
    console.log(JSON.stringify({
      ok: true,
      mode: "apply",
      legacy_rows_preserved_unattributed: before.legacy_unattributed_rows ?? before.row_count,
      legacy_rows_backfilled: false,
      unique_keys_preserved: ["uk_products_selection_id", "uk_products_code"],
      indexes: INDEXES.map(([name]) => name)
    }));
  } catch (error) {
    try { await admin.query("SELECT RELEASE_LOCK('tenant_products_ownership_v1')"); } catch {}
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
