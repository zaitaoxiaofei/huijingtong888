import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const APPLY = process.argv.includes("--apply");
const socketPath = process.argv.find((arg) => arg.startsWith("--mysql-admin-socket="))?.split("=").slice(1).join("=");
const TABLE = "listing_variant_workbench_drafts";
const OLD_UNIQUE_INDEX = "uq_listing_variant_workbench_owner";
const TENANT_UNIQUE_INDEX = "uq_listing_variant_workbench_tenant_owner";
const INDEXES = {
  [TENANT_UNIQUE_INDEX]: "UNIQUE KEY uq_listing_variant_workbench_tenant_owner (tenant_id, workbench_id, route_name, created_by_person_id)",
  idx_listing_variant_workbench_tenant_status: "KEY idx_listing_variant_workbench_tenant_status (tenant_id, status, updated_at, id)",
  idx_listing_variant_workbench_tenant_owner: "KEY idx_listing_variant_workbench_tenant_owner (tenant_id, created_by_person_id, status, updated_at, id)",
  idx_listing_variant_workbench_tenant_task: "KEY idx_listing_variant_workbench_tenant_task (tenant_id, task_id, updated_at)"
};

async function inspect() {
  const tables = await mysqlQuery(`SHOW TABLES LIKE '${TABLE}'`);
  if (!tables.length) return { exists: false, row_count: 0, legacy_unattributed_rows: 0, tenant_id_column: false, indexes: [] };
  const [columns, indexes] = await Promise.all([
    mysqlQuery(`SHOW COLUMNS FROM ${TABLE}`),
    mysqlQuery(`SHOW INDEX FROM ${TABLE}`)
  ]);
  const hasTenantColumn = columns.some((column) => column.Field === "tenant_id");
  const [counts] = await mysqlQuery(hasTenantColumn
    ? `SELECT COUNT(*) AS row_count, SUM(CASE WHEN tenant_id IS NULL THEN 1 ELSE 0 END) AS legacy_unattributed_rows FROM ${TABLE}`
    : `SELECT COUNT(*) AS row_count, COUNT(*) AS legacy_unattributed_rows FROM ${TABLE}`);
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
    console.log(JSON.stringify({ ok: true, mode: APPLY ? "apply" : "dry-run", message: "Workbench table does not exist; future application schema creates a tenant-aware table.", before }));
    return;
  }
  if (!APPLY) {
    console.log(JSON.stringify({
      ok: true,
      mode: "dry-run",
      changes_database: false,
      backfill_rule: "no ownership is inferred; legacy rows remain NULL and are visible only in the default tenant",
      tenant_scope: "new workbench drafts are keyed and queried by tenant plus existing creator scope",
      before
    }));
    return;
  }

  const admin = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  try {
    const [[lock]] = await admin.query("SELECT GET_LOCK('tenant_listing_workbench_drafts_v1', 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("Listing workbench tenant migration lock unavailable");
    const [columns] = await admin.query(`SHOW COLUMNS FROM ${TABLE}`);
    if (!columns.some((column) => column.Field === "tenant_id")) {
      await admin.query(`ALTER TABLE ${TABLE} ADD COLUMN tenant_id VARCHAR(80) NULL AFTER id`);
    }
    let [indexes] = await admin.query(`SHOW INDEX FROM ${TABLE}`);
    let indexNames = new Set(indexes.map((index) => index.Key_name));
    if (!indexNames.has(TENANT_UNIQUE_INDEX)) {
      await admin.query(`ALTER TABLE ${TABLE} ADD ${INDEXES[TENANT_UNIQUE_INDEX]}`);
    }
    indexes = (await admin.query(`SHOW INDEX FROM ${TABLE}`))[0];
    indexNames = new Set(indexes.map((index) => index.Key_name));
    if (indexNames.has(OLD_UNIQUE_INDEX)) await admin.query(`ALTER TABLE ${TABLE} DROP INDEX ${OLD_UNIQUE_INDEX}`);
    indexes = (await admin.query(`SHOW INDEX FROM ${TABLE}`))[0];
    indexNames = new Set(indexes.map((index) => index.Key_name));
    for (const [name, definition] of Object.entries(INDEXES)) {
      if (name === TENANT_UNIQUE_INDEX || indexNames.has(name)) continue;
      await admin.query(`ALTER TABLE ${TABLE} ADD ${definition}`);
    }

    const [verifiedColumns, verifiedIndexes] = await Promise.all([
      admin.query(`SHOW COLUMNS FROM ${TABLE}`),
      admin.query(`SHOW INDEX FROM ${TABLE}`)
    ]);
    const hasTenantColumn = verifiedColumns[0].some((column) => column.Field === "tenant_id");
    const verifiedIndexNames = new Set(verifiedIndexes[0].map((index) => index.Key_name));
    if (!hasTenantColumn || Object.keys(INDEXES).some((name) => !verifiedIndexNames.has(name)) || verifiedIndexNames.has(OLD_UNIQUE_INDEX)) {
      throw new Error("Listing workbench tenant schema verification failed");
    }
    await admin.query("SELECT RELEASE_LOCK('tenant_listing_workbench_drafts_v1')");
    console.log(JSON.stringify({
      ok: true,
      mode: "apply",
      migrated_rows: before.row_count,
      legacy_unattributed_rows_preserved: before.legacy_unattributed_rows,
      legacy_rows_backfilled: false
    }));
  } catch (error) {
    try { await admin.query("SELECT RELEASE_LOCK('tenant_listing_workbench_drafts_v1')"); } catch {}
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
