import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const APPLY = process.argv.includes("--apply");
const socketPath = process.argv.find((arg) => arg.startsWith("--mysql-admin-socket="))?.split("=").slice(1).join("=");
const TABLE = "asset_tail_templates";
const INDEX = "idx_asset_tail_templates_tenant_scope";

async function inspect(query) {
  if (!(await query(`SHOW TABLES LIKE '${TABLE}'`)).length) return { exists: false };
  const [columns, indexes] = await Promise.all([query(`SHOW COLUMNS FROM ${TABLE}`), query(`SHOW INDEX FROM ${TABLE}`)]);
  const tenantColumn = columns.find((column) => column.Field === "tenant_id");
  if (tenantColumn && (!/^bigint(?:\(\d+\))? unsigned$/i.test(tenantColumn.Type) || tenantColumn.Null !== "YES")) {
    throw new Error("asset_tail_templates.tenant_id must be nullable BIGINT UNSIGNED; review the incompatible schema before migrating");
  }
  const tenantIndex = indexes.filter((index) => index.Key_name === INDEX).sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index));
  if (tenantIndex.length && tenantIndex.map((index) => index.Column_name).join(",") !== "tenant_id,shop_id,category,vehicle_model,status") {
    throw new Error("Asset tail template tenant index has incompatible columns; review the schema before migrating");
  }
  const [counts] = await query(`SELECT COUNT(*) AS row_count${tenantColumn ? ", SUM(tenant_id IS NULL) AS legacy_unattributed_rows" : ""} FROM ${TABLE}`);
  return {
    exists: true,
    tenant_id_column: Boolean(tenantColumn),
    row_count: Number(counts.row_count || 0),
    legacy_unattributed_rows: tenantColumn ? Number(counts.legacy_unattributed_rows || 0) : Number(counts.row_count || 0),
    tenant_scope_index: tenantIndex.length > 0
  };
}

async function run() {
  if (APPLY && !socketPath) throw new Error("Apply mode requires --mysql-admin-socket for the MySQL administrator connection");
  if (!APPLY) {
    console.log(JSON.stringify({
      ok: true, mode: "dry-run", changes_database: false,
      legacy_attribution: "existing rows remain NULL and visible only to the default tenant; ownership is not inferred",
      before: await inspect(mysqlQuery)
    }));
    return;
  }
  const admin = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  const query = async (sql, params = []) => (await admin.query(sql, params))[0];
  try {
    const [lock] = await query("SELECT GET_LOCK('tenant_asset_variant_config_v1', 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("Asset variant configuration tenant migration lock unavailable");
    const before = await inspect(query);
    if (before.exists) {
      if (!before.tenant_id_column) await query(`ALTER TABLE ${TABLE} ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id`);
      if (!before.tenant_scope_index) await query(`ALTER TABLE ${TABLE} ADD KEY ${INDEX} (tenant_id, shop_id, category, vehicle_model, status)`);
      const after = await inspect(query);
      if (!after.tenant_id_column || !after.tenant_scope_index) throw new Error("Asset variant configuration tenant schema verification failed");
    }
    console.log(JSON.stringify({
      ok: true, mode: "apply", table_exists: before.exists,
      legacy_rows_preserved_unattributed: before.legacy_unattributed_rows || 0,
      legacy_rows_backfilled: false
    }));
  } finally {
    try { await query("SELECT RELEASE_LOCK('tenant_asset_variant_config_v1')"); } finally { await admin.end(); }
  }
}

try { await run(); } finally { await closeMysqlPool(); }
