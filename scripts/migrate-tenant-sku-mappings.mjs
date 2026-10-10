import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const APPLY = process.argv.includes("--apply");
const socketPath = process.argv.find((arg) => arg.startsWith("--mysql-admin-socket="))?.split("=").slice(1).join("=");
const TABLE = "sku_mappings";
const INDEXES = [
  ["idx_sku_mappings_tenant_shop_active", "(tenant_id, shop_id, active, ozon_sku)"],
  ["idx_sku_mappings_tenant_product_shop", "(tenant_id, product_id, shop_id)"]
];

async function inspect(query = mysqlQuery) {
  const tables = await query(`SHOW TABLES LIKE '${TABLE}'`);
  if (!tables.length) return { exists: false, row_count: 0, tenant_id_column: false, indexes: [] };
  const [columns, indexes, shopColumns, productColumns, [defaultTenant]] = await Promise.all([
    query(`SHOW COLUMNS FROM ${TABLE}`),
    query(`SHOW INDEX FROM ${TABLE}`),
    query("SHOW COLUMNS FROM shops"),
    query("SHOW COLUMNS FROM products"),
    query("SELECT id FROM tenants WHERE slug = 'default' AND status = 'active' LIMIT 1")
  ]);
  const hasTenantColumn = columns.some((column) => column.Field === "tenant_id");
  if (!shopColumns.some((column) => column.Field === "tenant_id")) throw new Error("shops.tenant_id is missing; migrate shop ownership before SKU mappings");
  if (!productColumns.some((column) => column.Field === "tenant_id")) throw new Error("products.tenant_id is missing; run the tenant products migration before SKU mappings");
  const [counts] = await query(`SELECT COUNT(*) AS row_count${hasTenantColumn ? ", SUM(tenant_id IS NULL) AS unattributed_rows" : ""} FROM ${TABLE}`);
  const defaultId = Number(defaultTenant?.id || 0);
  let orphanShopCount = null;
  let orphanProductCount = null;
  let mismatchCount = null;
  if (defaultId) {
    const [{ count: shops }, { count: products }, { count: mismatches }] = await Promise.all([
      mysqlQuery(`SELECT COUNT(*) AS count FROM ${TABLE} m LEFT JOIN shops s ON s.id = m.shop_id WHERE s.id IS NULL`),
      mysqlQuery(`SELECT COUNT(*) AS count FROM ${TABLE} m LEFT JOIN products p ON p.id = m.product_id WHERE p.id IS NULL`),
      mysqlQuery(`SELECT COUNT(*) AS count FROM ${TABLE} m
        JOIN shops s ON s.id = m.shop_id
        JOIN products p ON p.id = m.product_id
        WHERE COALESCE(s.tenant_id, ?) != COALESCE(p.tenant_id, ?)
          OR (m.tenant_id IS NOT NULL AND m.tenant_id != COALESCE(s.tenant_id, ?))`, [defaultId, defaultId, defaultId])
    ]);
    orphanShopCount = Number(shops || 0);
    orphanProductCount = Number(products || 0);
    mismatchCount = Number(mismatches || 0);
  }
  return {
    exists: true,
    row_count: Number(counts.row_count || 0),
    unattributed_rows: Number(counts.unattributed_rows || 0),
    tenant_id_column: hasTenantColumn,
    indexes: [...new Set(indexes.map((index) => index.Key_name))],
    default_tenant_exists: Boolean(defaultId),
    orphan_shop_count: orphanShopCount,
    orphan_product_count: orphanProductCount,
    ownership_mismatch_count: mismatchCount
  };
}

function assertSafePreflight(before) {
  if (!before.default_tenant_exists) throw new Error("Active default tenant is missing; SKU mapping attribution cannot be audited");
  if (before.orphan_shop_count || before.orphan_product_count || before.ownership_mismatch_count) {
    throw new Error(`SKU mapping ownership audit failed: orphan shops=${before.orphan_shop_count}, orphan products=${before.orphan_product_count}, ownership mismatches=${before.ownership_mismatch_count}`);
  }
}

async function run() {
  if (APPLY && !socketPath) throw new Error("Apply mode requires --mysql-admin-socket for the MySQL administrator connection");
  if (!APPLY) {
    const before = await inspect();
    if (!before.exists) {
      console.log(JSON.stringify({ ok: true, mode: "dry-run", changes_database: false, message: "SKU mapping table does not exist; application schema creates it tenant-aware.", before }));
      return;
    }
    assertSafePreflight(before);
    console.log(JSON.stringify({
      ok: true,
      mode: "dry-run",
      changes_database: false,
      backfill_rule: "mapping tenant must match both its shop and product; legacy NULL shop/product ownership resolves to the active default tenant",
      unique_key: "uk_sku_mappings_shop_sku is preserved",
      before
    }));
    return;
  }

  const admin = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  try {
    const [[lock]] = await admin.query("SELECT GET_LOCK('tenant_sku_mappings_v1', 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("SKU mapping tenant migration lock unavailable");
    const adminQuery = async (sql, params = []) => (await admin.query(sql, params))[0];
    const before = await inspect(adminQuery);
    if (!before.exists) {
      await admin.query("SELECT RELEASE_LOCK('tenant_sku_mappings_v1')");
      console.log(JSON.stringify({ ok: true, mode: "apply", message: "SKU mapping table does not exist; application schema creates it tenant-aware.", before }));
      return;
    }
    assertSafePreflight(before);
    const [[defaultTenant]] = await admin.query("SELECT id FROM tenants WHERE slug = 'default' AND status = 'active' LIMIT 1");
    const defaultId = Number(defaultTenant?.id || 0);
    if (!defaultId) throw new Error("Active default tenant is missing; no migration changes were applied");
    let [columns] = await admin.query(`SHOW COLUMNS FROM ${TABLE}`);
    if (!columns.some((column) => column.Field === "tenant_id")) {
      await admin.query(`ALTER TABLE ${TABLE} ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id`);
    } else {
      const tenantColumn = columns.find((column) => column.Field === "tenant_id");
      if (!/bigint/i.test(String(tenantColumn.Type || ""))) throw new Error("sku_mappings.tenant_id exists with a non-BIGINT type; inspect manually before migration");
    }
    await admin.query(`UPDATE ${TABLE} m
      JOIN shops s ON s.id = m.shop_id
      JOIN products p ON p.id = m.product_id
      SET m.tenant_id = COALESCE(s.tenant_id, ?)
      WHERE m.tenant_id IS NULL`, [defaultId]);
    const [[invalid]] = await admin.query(`SELECT COUNT(*) AS count FROM ${TABLE} m
      JOIN shops s ON s.id = m.shop_id
      JOIN products p ON p.id = m.product_id
      WHERE m.tenant_id IS NULL
        OR m.tenant_id != COALESCE(s.tenant_id, ?)
        OR m.tenant_id != COALESCE(p.tenant_id, ?)`, [defaultId, defaultId]);
    if (Number(invalid.count)) throw new Error(`SKU mapping ownership verification failed for ${invalid.count} row(s); index changes were not applied`);

    let [indexes] = await admin.query(`SHOW INDEX FROM ${TABLE}`);
    for (const [indexName, definition] of INDEXES) {
      if (!indexes.some((index) => index.Key_name === indexName)) {
        await admin.query(`ALTER TABLE ${TABLE} ADD KEY ${indexName} ${definition}`);
        [indexes] = await admin.query(`SHOW INDEX FROM ${TABLE}`);
      }
    }
    const oldUniqueName = "uk_sku_mappings_shop_sku";
    if (!indexes.some((index) => index.Key_name === oldUniqueName)) throw new Error("Expected legacy SKU mapping unique key is missing; refusing to alter uniqueness implicitly");
    await admin.query("SELECT RELEASE_LOCK('tenant_sku_mappings_v1')");
    console.log(JSON.stringify({
      ok: true,
      mode: "apply",
      attributed_rows: before.row_count,
      ownership_verified_against: ["shops.tenant_id", "products.tenant_id"],
      tenant_id_remains_nullable: "legacy application write paths do not yet populate this column",
      unique_key_preserved: oldUniqueName,
      indexes: INDEXES.map(([name]) => name)
    }));
  } catch (error) {
    try { await admin.query("SELECT RELEASE_LOCK('tenant_sku_mappings_v1')"); } catch {}
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
