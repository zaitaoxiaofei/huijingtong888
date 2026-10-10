import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const APPLY = process.argv.includes("--apply");
const socketPath = process.argv.find((arg) => arg.startsWith("--mysql-admin-socket="))?.split("=").slice(1).join("=");
const TABLES = {
  product_components: ["idx_product_components_tenant_parent", "(tenant_id, product_id, component_product_id)"],
  product_name_aliases: ["idx_product_name_alias_tenant_search", "(tenant_id, product_id, active, alias_name(191))"]
};

async function inspectTable(table, query = mysqlQuery) {
  const tables = await query(`SHOW TABLES LIKE '${table}'`);
  if (!tables.length) return { exists: false, row_count: 0, tenant_id_column: false, indexes: [] };
  const [columns, indexes] = await Promise.all([
    query(`SHOW COLUMNS FROM ${table}`),
    query(`SHOW INDEX FROM ${table}`)
  ]);
  const hasTenantColumn = columns.some((column) => column.Field === "tenant_id");
  const [counts] = await query(`SELECT COUNT(*) AS row_count${hasTenantColumn ? ", SUM(tenant_id IS NULL) AS legacy_unattributed_rows" : ""} FROM ${table}`);
  return {
    exists: true,
    row_count: Number(counts.row_count || 0),
    legacy_unattributed_rows: Number(counts.legacy_unattributed_rows || 0),
    tenant_id_column: hasTenantColumn,
    indexes: [...new Set(indexes.map((index) => index.Key_name))]
  };
}

async function inspectOwnership(table, defaultTenantId, query = mysqlQuery) {
  const hasTable = await query(`SHOW TABLES LIKE '${table}'`);
  if (!hasTable.length) return { exists: false, row_count: 0, orphan_count: 0, ownership_mismatch_count: 0, tenant_mismatch_count: 0 };
  const columns = await query(`SHOW COLUMNS FROM ${table}`);
  const hasTenantColumn = columns.some((column) => column.Field === "tenant_id");
  const [rows] = await query(table === "product_components" ? `
    SELECT COUNT(*) AS row_count,
      SUM(parent.id IS NULL OR component.id IS NULL) AS orphan_count,
      SUM(parent.id IS NOT NULL AND component.id IS NOT NULL AND COALESCE(parent.tenant_id, ?) != COALESCE(component.tenant_id, ?)) AS ownership_mismatch_count
      ${hasTenantColumn ? ", SUM(parent.id IS NOT NULL AND (relation.tenant_id IS NOT NULL AND relation.tenant_id != COALESCE(parent.tenant_id, ?))) AS tenant_mismatch_count" : ", 0 AS tenant_mismatch_count"}
    FROM product_components relation
    LEFT JOIN products parent ON parent.id = relation.product_id
    LEFT JOIN products component ON component.id = relation.component_product_id
  ` : `
    SELECT COUNT(*) AS row_count,
      SUM(product.id IS NULL) AS orphan_count,
      0 AS ownership_mismatch_count
      ${hasTenantColumn ? ", SUM(product.id IS NOT NULL AND (alias_row.tenant_id IS NOT NULL AND alias_row.tenant_id != COALESCE(product.tenant_id, ?))) AS tenant_mismatch_count" : ", 0 AS tenant_mismatch_count"}
    FROM product_name_aliases alias_row
    LEFT JOIN products product ON product.id = alias_row.product_id
  `, table === "product_components"
    ? (hasTenantColumn ? [defaultTenantId, defaultTenantId, defaultTenantId] : [defaultTenantId, defaultTenantId])
    : (hasTenantColumn ? [defaultTenantId] : []));
  return {
    exists: true,
    row_count: Number(rows.row_count || 0),
    orphan_count: Number(rows.orphan_count || 0),
    ownership_mismatch_count: Number(rows.ownership_mismatch_count || 0),
    tenant_mismatch_count: Number(rows.tenant_mismatch_count || 0),
    tenant_id_column: hasTenantColumn
  };
}

async function audit(query = mysqlQuery) {
  const before = {};
  for (const table of Object.keys(TABLES)) before[table] = await inspectTable(table, query);
  const [productColumns, [defaultTenant]] = await Promise.all([
    query("SHOW COLUMNS FROM products"),
    query("SELECT id FROM tenants WHERE slug = 'default' AND status = 'active' LIMIT 1")
  ]);
  if (!productColumns.some((column) => column.Field === "tenant_id")) throw new Error("products.tenant_id is missing; run the tenant products migration before product relations");
  const defaultTenantId = Number(defaultTenant?.id || 0);
  if (!defaultTenantId) throw new Error("Active default tenant is missing; relation ownership cannot be audited");
  for (const table of Object.keys(TABLES)) before[table].ownership = await inspectOwnership(table, defaultTenantId, query);
  const unsafe = Object.entries(before).filter(([, state]) => state.ownership.orphan_count || state.ownership.ownership_mismatch_count || state.ownership.tenant_mismatch_count);
  if (unsafe.length) throw new Error(`Product relation ownership audit failed: ${unsafe.map(([table, state]) => `${table} orphans=${state.ownership.orphan_count}, product mismatches=${state.ownership.ownership_mismatch_count}, tenant mismatches=${state.ownership.tenant_mismatch_count}`).join("; ")}`);
  return { before, defaultTenantId };
}

async function run() {
  if (APPLY && !socketPath) throw new Error("Apply mode requires --mysql-admin-socket for the MySQL administrator connection");
  if (!APPLY) {
    const { before } = await audit();
    console.log(JSON.stringify({
      ok: true,
      mode: "dry-run",
      changes_database: false,
      before,
      legacy_attribution: "relationship tenant follows its product(s), treating legacy NULL product ownership as default; orphan or cross-tenant relationships stop the migration"
    }));
    return;
  }

  const admin = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  try {
    const [[lock]] = await admin.query("SELECT GET_LOCK('tenant_product_relations_v1', 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("Product relation tenant migration lock unavailable");
    const adminQuery = async (sql, params = []) => (await admin.query(sql, params))[0];
    const { before } = await audit(adminQuery);
    for (const [table, [indexName, indexDefinition]] of Object.entries(TABLES)) {
      const [tables] = await admin.query(`SHOW TABLES LIKE '${table}'`);
      if (!tables.length) continue;
      let [columns] = await admin.query(`SHOW COLUMNS FROM ${table}`);
      if (!columns.some((column) => column.Field === "tenant_id")) {
        await admin.query(`ALTER TABLE ${table} ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id`);
      }
      let [indexes] = await admin.query(`SHOW INDEX FROM ${table}`);
      if (!indexes.some((index) => index.Key_name === indexName)) {
        await admin.query(`ALTER TABLE ${table} ADD KEY ${indexName} ${indexDefinition}`);
      }
      [columns, indexes] = await Promise.all([
        admin.query(`SHOW COLUMNS FROM ${table}`),
        admin.query(`SHOW INDEX FROM ${table}`)
      ]);
      if (!columns[0].some((column) => column.Field === "tenant_id") || !indexes[0].some((index) => index.Key_name === indexName)) {
        throw new Error(`Product relation tenant schema verification failed for ${table}`);
      }
      if (table === "product_components") {
        await admin.query(`UPDATE product_components relation
          JOIN products parent ON parent.id = relation.product_id
          JOIN products component ON component.id = relation.component_product_id
          JOIN tenants default_tenant ON default_tenant.slug = 'default' AND default_tenant.status = 'active'
          SET relation.tenant_id = COALESCE(parent.tenant_id, default_tenant.id)
          WHERE relation.tenant_id IS NULL`);
      } else {
        await admin.query(`UPDATE product_name_aliases relation
          JOIN products product ON product.id = relation.product_id
          JOIN tenants default_tenant ON default_tenant.slug = 'default' AND default_tenant.status = 'active'
          SET relation.tenant_id = COALESCE(product.tenant_id, default_tenant.id)
          WHERE relation.tenant_id IS NULL`);
      }
    }
    await admin.query("SELECT RELEASE_LOCK('tenant_product_relations_v1')");
    console.log(JSON.stringify({
      ok: true,
      mode: "apply",
      legacy_rows_backfilled_from_product_ownership: true,
      legacy_unresolved_rows: "orphan references abort before attribution; missing relation tables are skipped",
      indexes: Object.fromEntries(Object.entries(TABLES).map(([table, [indexName]]) => [table, indexName]))
    }));
  } catch (error) {
    try { await admin.query("SELECT RELEASE_LOCK('tenant_product_relations_v1')"); } catch {}
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
