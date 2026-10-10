import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const APPLY = process.argv.includes("--apply");
const socketPath = process.argv.find((arg) => arg.startsWith("--mysql-admin-socket="))?.split("=").slice(1).join("=");
const TABLE = "listing_ozon_seller_media_upload_jobs";
const OLD_INDEXES = [
  "uq_listing_seller_media_job",
  "idx_listing_seller_media_status",
  "idx_listing_seller_media_job",
  "idx_listing_seller_media_source_hash",
  "idx_listing_seller_media_source"
];
const INDEXES = {
  uq_listing_seller_media_tenant_job: "UNIQUE KEY uq_listing_seller_media_tenant_job (tenant_id, media_job_id)",
  idx_listing_seller_media_tenant_status: "KEY idx_listing_seller_media_tenant_status (tenant_id, status, updated_at, id)",
  idx_listing_seller_media_tenant_hash: "KEY idx_listing_seller_media_tenant_hash (tenant_id, source_hash, status, updated_at)",
  idx_listing_seller_media_tenant_job: "KEY idx_listing_seller_media_tenant_job (tenant_id, job_id, media_job_id)",
  idx_listing_seller_media_tenant_source: "KEY idx_listing_seller_media_tenant_source (tenant_id, kind, source_url(160))"
};

async function inspect() {
  const tables = await mysqlQuery(`SHOW TABLES LIKE '${TABLE}'`);
  if (!tables.length) return { exists: false, row_count: 0, tenant_id_column: false, indexes: [] };
  const [columns, indexes] = await Promise.all([
    mysqlQuery(`SHOW COLUMNS FROM ${TABLE}`),
    mysqlQuery(`SHOW INDEX FROM ${TABLE}`)
  ]);
  const hasTenantColumn = columns.some((column) => column.Field === "tenant_id");
  const [counts] = await mysqlQuery(hasTenantColumn
    ? `SELECT COUNT(*) AS row_count, SUM(tenant_id IS NULL) AS null_tenant_rows FROM ${TABLE}`
    : `SELECT COUNT(*) AS row_count, 0 AS null_tenant_rows FROM ${TABLE}`);
  return {
    exists: true,
    row_count: Number(counts.row_count || 0),
    null_tenant_rows: Number(counts.null_tenant_rows || 0),
    tenant_id_column: hasTenantColumn,
    indexes: [...new Set(indexes.map((index) => index.Key_name))]
  };
}

async function run() {
  if (APPLY && !socketPath) throw new Error("Apply mode requires --mysql-admin-socket for the MySQL administrator connection");
  const before = await inspect();
  if (!before.exists) {
    console.log(JSON.stringify({ ok: true, mode: APPLY ? "apply" : "dry-run", message: "Media upload job table does not exist; application schema will create it with tenant indexes.", before }));
    return;
  }
  if (before.tenant_id_column && before.null_tenant_rows) {
    throw new Error("Found media jobs with NULL tenant ownership; review them before migration. No database changes were applied.");
  }
  if (!APPLY) {
    console.log(JSON.stringify({
      ok: true,
      mode: "dry-run",
      changes_database: false,
      legacy_attribution: before.tenant_id_column ? "existing tenant values are retained" : "all pre-tenant media jobs will remain assigned to default tenant admin",
      before
    }));
    return;
  }

  const admin = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  try {
    const [[lock]] = await admin.query("SELECT GET_LOCK('tenant_ozon_media_jobs_v1', 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("Ozon media job tenant migration lock unavailable");
    const [columns] = await admin.query(`SHOW COLUMNS FROM ${TABLE}`);
    if (!columns.some((column) => column.Field === "tenant_id")) {
      await admin.query(`ALTER TABLE ${TABLE} ADD COLUMN tenant_id VARCHAR(80) NOT NULL DEFAULT 'admin' AFTER id`);
    }
    if (!columns.some((column) => column.Field === "source_hash")) {
      await admin.query(`ALTER TABLE ${TABLE} ADD COLUMN source_hash VARCHAR(128) NOT NULL DEFAULT '' AFTER source_url`);
    }
    let [indexes] = await admin.query(`SHOW INDEX FROM ${TABLE}`);
    let names = new Set(indexes.map((index) => index.Key_name));
    for (const [name, definition] of Object.entries(INDEXES)) {
      if (names.has(name)) continue;
      await admin.query(`ALTER TABLE ${TABLE} ADD ${definition}`);
      names.add(name);
    }
    for (const name of OLD_INDEXES) {
      if (!names.has(name)) continue;
      await admin.query(`ALTER TABLE ${TABLE} DROP INDEX ${name}`);
      names.delete(name);
    }
    const [verifiedColumns, verifiedIndexes] = await Promise.all([
      admin.query(`SHOW COLUMNS FROM ${TABLE}`),
      admin.query(`SHOW INDEX FROM ${TABLE}`)
    ]);
    names = new Set(verifiedIndexes[0].map((index) => index.Key_name));
    if (!verifiedColumns[0].some((column) => column.Field === "tenant_id")
      || !verifiedColumns[0].some((column) => column.Field === "source_hash")
      || Object.keys(INDEXES).some((name) => !names.has(name))
      || OLD_INDEXES.some((name) => names.has(name))) {
      throw new Error("Ozon media job tenant schema verification failed");
    }
    await admin.query("SELECT RELEASE_LOCK('tenant_ozon_media_jobs_v1')");
    console.log(JSON.stringify({ ok: true, mode: "apply", migrated_rows: before.row_count, legacy_rows_attributed_to_default: before.tenant_id_column ? 0 : before.row_count }));
  } catch (error) {
    try { await admin.query("SELECT RELEASE_LOCK('tenant_ozon_media_jobs_v1')"); } catch {}
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
