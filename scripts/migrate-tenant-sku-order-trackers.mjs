import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const APPLY = process.argv.includes("--apply");
const socketPath = process.argv.find((arg) => arg.startsWith("--mysql-admin-socket="))?.split("=").slice(1).join("=");

export function tenantTrackerBackfillSql() {
  return `UPDATE sku_order_trackers tracker
    JOIN shops s ON s.id = tracker.shop_id
    JOIN tenants tenant_default ON tenant_default.slug = 'default'
    SET tracker.tenant_id = COALESCE(s.tenant_id, tenant_default.id)
    WHERE tracker.tenant_id IS NULL`;
}

async function inspect() {
  const tableRows = await mysqlQuery("SHOW TABLES LIKE 'sku_order_trackers'");
  if (!tableRows.length) return { exists: false, tracker_count: 0, tenant_id_column: false, indexes: [] };
  const [columns, indexes, [{ tracker_count }], [{ orphan_shop_count }]] = await Promise.all([
    mysqlQuery("SHOW COLUMNS FROM sku_order_trackers"),
    mysqlQuery("SHOW INDEX FROM sku_order_trackers"),
    mysqlQuery("SELECT COUNT(*) AS tracker_count FROM sku_order_trackers"),
    mysqlQuery("SELECT COUNT(*) AS orphan_shop_count FROM sku_order_trackers tracker LEFT JOIN shops s ON s.id = tracker.shop_id WHERE s.id IS NULL")
  ]);
  return {
    exists: true,
    tracker_count: Number(tracker_count || 0),
    orphan_shop_count: Number(orphan_shop_count || 0),
    tenant_id_column: columns.some((column) => column.Field === "tenant_id"),
    indexes: [...new Set(indexes.map((index) => index.Key_name))]
  };
}

async function run() {
  if (APPLY && !socketPath) throw new Error("Apply mode requires --mysql-admin-socket for the MySQL administrator connection");
  const before = await inspect();
  if (!before.exists) {
    console.log(JSON.stringify({ ok: true, mode: APPLY ? "apply" : "dry-run", message: "Tracker table does not exist; new installs will create the tenant-aware schema.", before }));
    return;
  }
  if (before.orphan_shop_count) throw new Error(`Found ${before.orphan_shop_count} tracker row(s) without a shop; repair these references before migration`);
  if (!APPLY) {
    console.log(JSON.stringify({ ok: true, mode: "dry-run", changes_database: false, backfill_rule: "tracker tenant follows its shop; legacy NULL shop tenant maps to the default tenant", before }));
    return;
  }

  const admin = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  try {
    const [[lock]] = await admin.query("SELECT GET_LOCK('tenant_sku_order_trackers_v1', 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("SKU tracker tenant migration lock unavailable");
    const [[defaultTenant]] = await admin.query("SELECT id FROM tenants WHERE slug = 'default' AND status = 'active' LIMIT 1");
    if (!defaultTenant?.id) throw new Error("Active default tenant is missing; no migration changes were applied");

    if (!before.tenant_id_column) await admin.query("ALTER TABLE sku_order_trackers ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id");
    await admin.query(tenantTrackerBackfillSql());
    const [[invalid]] = await admin.query(`SELECT COUNT(*) AS invalid_count
      FROM sku_order_trackers tracker JOIN shops s ON s.id = tracker.shop_id
      WHERE tracker.tenant_id IS NULL OR tracker.tenant_id != COALESCE(s.tenant_id, ?)` , [Number(defaultTenant.id)]);
    if (Number(invalid.invalid_count)) throw new Error(`Tenant attribution verification failed for ${invalid.invalid_count} tracker row(s); index changes were not applied`);

    const [indexes] = await admin.query("SHOW INDEX FROM sku_order_trackers");
    const indexNames = new Set(indexes.map((index) => index.Key_name));
    if (indexNames.has("uk_sku_order_tracker")) await admin.query("ALTER TABLE sku_order_trackers DROP INDEX uk_sku_order_tracker");
    if (!indexNames.has("uk_sku_order_tracker_tenant_shop_sku")) {
      await admin.query("ALTER TABLE sku_order_trackers ADD UNIQUE KEY uk_sku_order_tracker_tenant_shop_sku (tenant_id, shop_id, ozon_sku)");
    }
    if (!indexNames.has("idx_sku_order_tracker_tenant_active_shop")) {
      await admin.query("ALTER TABLE sku_order_trackers ADD KEY idx_sku_order_tracker_tenant_active_shop (tenant_id, active, shop_id)");
    }
    await admin.query("ALTER TABLE sku_order_trackers MODIFY tenant_id BIGINT UNSIGNED NOT NULL");
    const [[verified]] = await admin.query("SELECT COUNT(*) AS tracker_count, COUNT(tenant_id) AS tenant_count FROM sku_order_trackers");
    if (Number(verified.tracker_count) !== Number(verified.tenant_count)) throw new Error("Post-migration tenant_id verification failed");
    await admin.query("SELECT RELEASE_LOCK('tenant_sku_order_trackers_v1')");
    console.log(JSON.stringify({ ok: true, mode: "apply", migrated_rows: Number(verified.tracker_count), application_privileges_unchanged: true }));
  } catch (error) {
    try { await admin.query("SELECT RELEASE_LOCK('tenant_sku_order_trackers_v1')"); } catch {}
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
