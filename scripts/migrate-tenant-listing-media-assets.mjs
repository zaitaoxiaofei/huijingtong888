import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const APPLY = process.argv.includes("--apply");
const socketPath = process.argv.find((arg) => arg.startsWith("--mysql-admin-socket="))?.split("=").slice(1).join("=");
const TABLE = "listing_media_assets";
const INDEXES = {
  idx_listing_media_tenant_status_updated: "KEY idx_listing_media_tenant_status_updated (tenant_id, status, updated_at, id)",
  idx_listing_media_tenant_source: "KEY idx_listing_media_tenant_source (tenant_id, source_module, source_id, role, id)"
};

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
    console.log(JSON.stringify({ ok: true, mode: APPLY ? "apply" : "dry-run", message: "Listing media asset table does not exist; application schema creates it tenant-aware.", before }));
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
    const [[lock]] = await admin.query("SELECT GET_LOCK('tenant_listing_media_assets_v1', 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("Listing media asset tenant migration lock unavailable");
    let [columns] = await admin.query(`SHOW COLUMNS FROM ${TABLE}`);
    if (!columns.some((column) => column.Field === "tenant_id")) {
      await admin.query(`ALTER TABLE ${TABLE} ADD COLUMN tenant_id VARCHAR(80) NULL AFTER id`);
    }
    let [indexes] = await admin.query(`SHOW INDEX FROM ${TABLE}`);
    const names = new Set(indexes.map((index) => index.Key_name));
    for (const [name, definition] of Object.entries(INDEXES)) {
      if (!names.has(name)) await admin.query(`ALTER TABLE ${TABLE} ADD ${definition}`);
    }
    const [verifiedColumns, verifiedIndexes] = await Promise.all([
      admin.query(`SHOW COLUMNS FROM ${TABLE}`),
      admin.query(`SHOW INDEX FROM ${TABLE}`)
    ]);
    const verifiedColumnNames = new Set(verifiedColumns[0].map((column) => column.Field));
    const verifiedIndexNames = new Set(verifiedIndexes[0].map((index) => index.Key_name));
    if (!verifiedColumnNames.has("tenant_id") || Object.keys(INDEXES).some((name) => !verifiedIndexNames.has(name))) {
      throw new Error("Listing media asset tenant schema verification failed");
    }
    await admin.query("SELECT RELEASE_LOCK('tenant_listing_media_assets_v1')");
    console.log(JSON.stringify({ ok: true, mode: "apply", legacy_rows_preserved_unattributed: before.legacy_unattributed_rows ?? before.row_count, legacy_rows_backfilled: false }));
  } catch (error) {
    try { await admin.query("SELECT RELEASE_LOCK('tenant_listing_media_assets_v1')"); } catch {}
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
