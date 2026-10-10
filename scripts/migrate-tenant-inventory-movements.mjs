import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const APPLY = process.argv.includes("--apply");
const socketPath = process.argv.find((arg) => arg.startsWith("--mysql-admin-socket="))?.split("=").slice(1).join("=");
const TABLE = "inventory_movements";
const INDEX = ["idx_inventory_tenant_product_status_created", "(tenant_id, product_id, status, created_at, id)"];
const LOCK_NAME = "tenant_inventory_movements_v1";

async function inspect(query = mysqlQuery) {
  const tables = await query(`SHOW TABLES LIKE '${TABLE}'`);
  if (!tables.length) return { exists: false, row_count: 0, tenant_id_column: false, indexes: [] };
  const [columns, indexes] = await Promise.all([
    query(`SHOW COLUMNS FROM ${TABLE}`),
    query(`SHOW INDEX FROM ${TABLE}`)
  ]);
  const tenantColumn = columns.find((column) => column.Field === "tenant_id");
  const productTenantColumn = (await query("SHOW COLUMNS FROM products")).find((column) => column.Field === "tenant_id");
  if (!productTenantColumn) throw new Error("products.tenant_id is missing; run the tenant products migration first");
  const [defaultRows] = await query("SELECT id FROM tenants WHERE slug = 'default' AND status = 'active' LIMIT 1");
  const defaultId = Number(defaultRows?.id || 0);
  const [counts] = await query(`SELECT COUNT(*) AS row_count${tenantColumn ? ", SUM(tenant_id IS NULL) AS unattributed_rows" : ""} FROM ${TABLE}`);
  if (!defaultId) throw new Error("Active default tenant is missing; inventory attribution cannot be audited");
  const [audit] = await query(`SELECT
      SUM(CASE WHEN p.id IS NULL THEN 1 ELSE 0 END) AS orphan_product_count,
      ${tenantColumn ? "SUM(CASE WHEN m.tenant_id IS NOT NULL AND m.tenant_id != COALESCE(p.tenant_id, ?) THEN 1 ELSE 0 END)" : "0"} AS ownership_mismatch_count
    FROM ${TABLE} m LEFT JOIN products p ON p.id = m.product_id`, tenantColumn ? [defaultId] : []);
  return {
    exists: true,
    row_count: Number(counts.row_count || 0),
    unattributed_rows: Number(counts.unattributed_rows || 0),
    tenant_id_column: Boolean(tenantColumn),
    tenant_id_type: String(tenantColumn?.Type || ""),
    indexes: [...new Set(indexes.map((index) => index.Key_name))],
    default_tenant_exists: true,
    orphan_product_count: Number(audit.orphan_product_count || 0),
    ownership_mismatch_count: Number(audit.ownership_mismatch_count || 0)
  };
}

function assertSafe(before) {
  if (before.orphan_product_count || before.ownership_mismatch_count) {
    throw new Error(`Inventory ownership audit failed: orphan products=${before.orphan_product_count}, ownership mismatches=${before.ownership_mismatch_count}`);
  }
  if (before.tenant_id_column && !/bigint/i.test(before.tenant_id_type)) {
    throw new Error("inventory_movements.tenant_id has a non-BIGINT type; inspect manually before migration");
  }
}

async function run() {
  if (APPLY && !socketPath) throw new Error("Apply mode requires --mysql-admin-socket for the MySQL administrator connection");
  if (!APPLY) {
    const before = await inspect();
    if (before.exists) assertSafe(before);
    console.log(JSON.stringify({
      ok: true,
      mode: "dry-run",
      changes_database: false,
      backfill_rule: "movement tenant follows its product tenant; legacy products without ownership resolve to the active default tenant",
      orphan_or_conflicting_rows_are_blocking: true,
      before
    }));
    return;
  }

  const admin = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  try {
    const [[lock]] = await admin.query("SELECT GET_LOCK(?, 60) AS acquired", [LOCK_NAME]);
    if (Number(lock.acquired) !== 1) throw new Error("Inventory movement tenant migration lock unavailable");
    const adminQuery = async (sql, params = []) => (await admin.query(sql, params))[0];
    const before = await inspect(adminQuery);
    if (!before.exists) {
      await admin.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
      console.log(JSON.stringify({ ok: true, mode: "apply", message: "Inventory movement table does not exist; application schema creates it tenant-aware.", before }));
      return;
    }
    assertSafe(before);
    let [columns] = await admin.query(`SHOW COLUMNS FROM ${TABLE}`);
    if (!columns.some((column) => column.Field === "tenant_id")) {
      await admin.query(`ALTER TABLE ${TABLE} ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id`);
    }
    await admin.query(`UPDATE ${TABLE} m
      JOIN products p ON p.id = m.product_id
      JOIN tenants tenant_default ON tenant_default.slug = 'default' AND tenant_default.status = 'active'
      SET m.tenant_id = COALESCE(p.tenant_id, tenant_default.id)
      WHERE m.tenant_id IS NULL`);
    const [[verification]] = await admin.query(`SELECT
        SUM(CASE WHEN p.id IS NULL OR m.tenant_id IS NULL THEN 1 ELSE 0 END) AS invalid_count,
        SUM(CASE WHEN m.tenant_id != COALESCE(p.tenant_id, tenant_default.id) THEN 1 ELSE 0 END) AS mismatch_count
      FROM ${TABLE} m
      LEFT JOIN products p ON p.id = m.product_id
      JOIN tenants tenant_default ON tenant_default.slug = 'default' AND tenant_default.status = 'active'`);
    if (Number(verification.invalid_count || 0) || Number(verification.mismatch_count || 0)) {
      throw new Error("Inventory movement tenant attribution verification failed; index changes were not applied");
    }
    let [indexes] = await admin.query(`SHOW INDEX FROM ${TABLE}`);
    if (!indexes.some((index) => index.Key_name === INDEX[0])) {
      await admin.query(`ALTER TABLE ${TABLE} ADD KEY ${INDEX[0]} ${INDEX[1]}`);
      [indexes] = await admin.query(`SHOW INDEX FROM ${TABLE}`);
    }
    if (!indexes.some((index) => index.Key_name === INDEX[0])) throw new Error("Inventory movement tenant index verification failed");
    await admin.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
    console.log(JSON.stringify({
      ok: true,
      mode: "apply",
      attributed_rows: before.row_count,
      ownership_verified_against: "products.tenant_id",
      indexes: [INDEX[0]],
      movement_tenant_column_remains_nullable_for_legacy_compatibility: true
    }));
  } catch (error) {
    try { await admin.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]); } catch {}
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
