import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const APPLY = process.argv.includes("--apply");
const socketPath = process.argv.find((arg) => arg.startsWith("--mysql-admin-socket="))?.split("=").slice(1).join("=");

export function procurementRequestTenantBackfillSql() {
  return `UPDATE procurement_requests pr
    LEFT JOIN orders source_order ON source_order.id = pr.source_order_id
    LEFT JOIN shops source_shop ON source_shop.id = source_order.shop_id
    JOIN tenants tenant_default ON tenant_default.slug = 'default'
    SET pr.tenant_id = COALESCE(source_shop.tenant_id, tenant_default.id)
    WHERE pr.tenant_id IS NULL`;
}

async function inspect() {
  const tableRows = await mysqlQuery("SHOW TABLES LIKE 'procurement_requests'");
  if (!tableRows.length) return { exists: false, request_count: 0, tenant_id_column: false, indexes: [] };
  const [columns, indexes, defaultRows] = await Promise.all([
    mysqlQuery("SHOW COLUMNS FROM procurement_requests"),
    mysqlQuery("SHOW INDEX FROM procurement_requests"),
    mysqlQuery("SELECT id FROM tenants WHERE slug = 'default' AND status = 'active' LIMIT 1")
  ]);
  const tenantColumn = columns.some((column) => column.Field === "tenant_id");
  const defaultTenantId = Number(defaultRows[0]?.id || 0);
  if (!defaultTenantId) throw new Error("Active default tenant is missing; no migration changes were applied");
  const tenantExpr = tenantColumn ? "COALESCE(pr.tenant_id, source_shop.tenant_id, tenant_default.id)" : "COALESCE(source_shop.tenant_id, tenant_default.id)";
  const legacyDefaultCandidate = tenantColumn
    ? "pr.tenant_id IS NULL AND source_shop.tenant_id IS NULL"
    : "source_shop.tenant_id IS NULL";
  const attributedTenantJoin = tenantColumn
    ? "LEFT JOIN tenants attributed_tenant ON attributed_tenant.id = pr.tenant_id"
    : "";
  const [counts] = await mysqlQuery(`SELECT
      COUNT(*) AS request_count,
      SUM(CASE WHEN pr.source_order_id IS NOT NULL AND (source_order.id IS NULL OR source_shop.id IS NULL) THEN 1 ELSE 0 END) AS orphan_source_order_count,
      SUM(CASE WHEN ${legacyDefaultCandidate} THEN 1 ELSE 0 END) AS default_legacy_candidate_count,
      ${tenantColumn ? "SUM(CASE WHEN pr.tenant_id IS NOT NULL AND attributed_tenant.id IS NULL THEN 1 ELSE 0 END)" : "0"} AS invalid_tenant_reference_count
    FROM procurement_requests pr
    LEFT JOIN orders source_order ON source_order.id = pr.source_order_id
    LEFT JOIN shops source_shop ON source_shop.id = source_order.shop_id
    ${attributedTenantJoin}`);
  const [mixed] = await mysqlQuery(`SELECT COUNT(*) AS mixed_purchase_order_count FROM (
      SELECT pr.purchase_order_id
      FROM procurement_requests pr
      LEFT JOIN orders source_order ON source_order.id = pr.source_order_id
      LEFT JOIN shops source_shop ON source_shop.id = source_order.shop_id
      JOIN tenants tenant_default ON tenant_default.slug = 'default'
      WHERE pr.purchase_order_id IS NOT NULL
      GROUP BY pr.purchase_order_id
      HAVING COUNT(DISTINCT ${tenantExpr}) > 1
    ) mixed_purchase_orders`);
  let mismatchedExistingTenantCount = 0;
  if (tenantColumn) {
    const [mismatch] = await mysqlQuery(`SELECT COUNT(*) AS mismatch_count
      FROM procurement_requests pr
      LEFT JOIN orders source_order ON source_order.id = pr.source_order_id
      LEFT JOIN shops source_shop ON source_shop.id = source_order.shop_id
      JOIN tenants tenant_default ON tenant_default.slug = 'default'
      WHERE pr.tenant_id IS NOT NULL AND pr.source_order_id IS NOT NULL
        AND pr.tenant_id != COALESCE(source_shop.tenant_id, tenant_default.id)`);
    mismatchedExistingTenantCount = Number(mismatch.mismatch_count || 0);
  }
  return {
    exists: true,
    request_count: Number(counts.request_count || 0),
    orphan_source_order_count: Number(counts.orphan_source_order_count || 0),
    default_legacy_candidate_count: Number(counts.default_legacy_candidate_count || 0),
    invalid_tenant_reference_count: Number(counts.invalid_tenant_reference_count || 0),
    mixed_purchase_order_count: Number(mixed.mixed_purchase_order_count || 0),
    mismatched_existing_tenant_count: mismatchedExistingTenantCount,
    tenant_id_column: tenantColumn,
    indexes: [...new Set(indexes.map((index) => index.Key_name))]
  };
}

async function run() {
  if (APPLY && !socketPath) throw new Error("Apply mode requires --mysql-admin-socket for the MySQL administrator connection");
  const before = await inspect();
  if (!before.exists) {
    console.log(JSON.stringify({ ok: true, mode: APPLY ? "apply" : "dry-run", message: "Procurement request table does not exist; new installs use the tenant-aware schema.", before }));
    return;
  }
  if (before.orphan_source_order_count) throw new Error(`Found ${before.orphan_source_order_count} request(s) with missing source orders or shops; repair these references before migration`);
  if (before.mixed_purchase_order_count) throw new Error(`Found ${before.mixed_purchase_order_count} purchase order(s) containing requests attributed to multiple tenants; resolve or quarantine them before migration`);
  if (before.mismatched_existing_tenant_count) throw new Error(`Found ${before.mismatched_existing_tenant_count} request(s) whose existing tenant attribution conflicts with their source shop; review before migration`);
  if (before.invalid_tenant_reference_count) throw new Error(`Found ${before.invalid_tenant_reference_count} request(s) with missing tenant records; repair these references before migration`);
  if (!APPLY) {
    console.log(JSON.stringify({
      ok: true,
      mode: "dry-run",
      changes_database: false,
      backfill_rule: "request tenant follows its source order shop; requests without a source shop remain in the legacy default tenant",
      legacy_purchase_orders_remain_closed_to_non_default_tenants: true,
      before
    }));
    return;
  }

  const admin = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  try {
    const [[lock]] = await admin.query("SELECT GET_LOCK('tenant_procurement_requests_v1', 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("Procurement request tenant migration lock unavailable");
    const [[defaultTenant]] = await admin.query("SELECT id FROM tenants WHERE slug = 'default' AND status = 'active' LIMIT 1");
    if (!defaultTenant?.id) throw new Error("Active default tenant is missing; no migration changes were applied");

    const [columns] = await admin.query("SHOW COLUMNS FROM procurement_requests");
    if (!columns.some((column) => column.Field === "tenant_id")) {
      await admin.query("ALTER TABLE procurement_requests ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id");
    }
    await admin.query(procurementRequestTenantBackfillSql());
    const [[verification]] = await admin.query(`SELECT
        COUNT(*) AS request_count,
        SUM(CASE WHEN pr.tenant_id IS NULL THEN 1 ELSE 0 END) AS missing_tenant_count,
        SUM(CASE WHEN pr.tenant_id != COALESCE(source_shop.tenant_id, ?) THEN 1 ELSE 0 END) AS mismatch_count
      FROM procurement_requests pr
      LEFT JOIN orders source_order ON source_order.id = pr.source_order_id
      LEFT JOIN shops source_shop ON source_shop.id = source_order.shop_id`, [Number(defaultTenant.id)]);
    if (Number(verification.missing_tenant_count || 0) || Number(verification.mismatch_count || 0)) {
      throw new Error("Procurement request tenant attribution verification failed; index changes were not applied");
    }

    const [indexes] = await admin.query("SHOW INDEX FROM procurement_requests");
    const indexNames = new Set(indexes.map((index) => index.Key_name));
    if (!indexNames.has("idx_procurement_tenant_status_created")) {
      await admin.query("ALTER TABLE procurement_requests ADD KEY idx_procurement_tenant_status_created (tenant_id, status, created_at, id)");
    }
    if (!indexNames.has("idx_procurement_tenant_purchase_status")) {
      await admin.query("ALTER TABLE procurement_requests ADD KEY idx_procurement_tenant_purchase_status (tenant_id, purchase_order_id, status)");
    }
    await admin.query("SELECT RELEASE_LOCK('tenant_procurement_requests_v1')");
    console.log(JSON.stringify({
      ok: true,
      mode: "apply",
      migrated_rows: Number(verification.request_count || 0),
      tenant_id_remains_nullable_for_legacy_writers: true,
      application_privileges_unchanged: true
    }));
  } catch (error) {
    try { await admin.query("SELECT RELEASE_LOCK('tenant_procurement_requests_v1')"); } catch {}
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
