import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import { assertNoDuplicateCategoryUsage, assertNoDuplicateTenantRequest, assertTenantIdColumnType } from "./lib/tenant-listing-core-migration-guard.mjs";

const APPLY = process.argv.includes("--apply");
const socketPath = process.argv.find((arg) => arg.startsWith("--mysql-admin-socket="))?.split("=").slice(1).join("=");
const TABLES = {
  listing_category_templates: {
    idx_listing_templates_tenant_status_updated: "KEY idx_listing_templates_tenant_status_updated (tenant_id, status, updated_at, id)"
  },
  listing_drafts: {
    idx_listing_drafts_tenant_status_updated: "KEY idx_listing_drafts_tenant_status_updated (tenant_id, status, updated_at, id)",
    idx_listing_drafts_tenant_template: "KEY idx_listing_drafts_tenant_template (tenant_id, template_id, status, updated_at)"
  },
  listing_shop_copies: {
    idx_listing_shop_copies_tenant_draft_shop: "KEY idx_listing_shop_copies_tenant_draft_shop (tenant_id, draft_id, shop_id, status)"
  },
  listing_publish_records: {
    idx_listing_publish_tenant_status_created: "KEY idx_listing_publish_tenant_status_created (tenant_id, status, created_at, id)",
    idx_listing_publish_tenant_draft: "KEY idx_listing_publish_tenant_draft (tenant_id, draft_id, status, updated_at)",
    idx_listing_publish_tenant_shop: "KEY idx_listing_publish_tenant_shop (tenant_id, shop_id, created_at, id)"
  },
  listing_publish_tasks: {
    idx_listing_publish_tasks_tenant_status_created: "KEY idx_listing_publish_tasks_tenant_status_created (tenant_id, status, created_at, id)"
  },
  listing_publish_task_items: {
    idx_listing_publish_task_items_tenant_task: "KEY idx_listing_publish_task_items_tenant_task (tenant_id, publish_task_id, status, id)",
    idx_listing_publish_task_items_tenant_draft_shop: "KEY idx_listing_publish_task_items_tenant_draft_shop (tenant_id, draft_id, shop_id, status)",
    idx_listing_publish_task_items_tenant_record: "KEY idx_listing_publish_task_items_tenant_record (tenant_id, record_id)"
  },
  ozon_category_usage: {
    idx_ozon_category_usage_tenant_category: "KEY idx_ozon_category_usage_tenant_category (tenant_id, description_category_id, type_id, last_used_at)"
  }
};
const UNIQUE_INDEXES = {
  listing_publish_tasks: {
    uq_listing_publish_tasks_tenant_request: "UNIQUE KEY uq_listing_publish_tasks_tenant_request (tenant_id, request_id)"
  },
  ozon_category_usage: {
    uq_ozon_category_usage_tenant: "UNIQUE KEY uq_ozon_category_usage_tenant (tenant_id, source_module, source_id, description_category_id, type_id)"
  }
};
const DROP_INDEXES = {
  listing_publish_tasks: ["uq_listing_publish_tasks_request"],
  ozon_category_usage: ["uq_ozon_category_usage"]
};

async function inspectTable(table, query = mysqlQuery) {
  const tables = await query(`SHOW TABLES LIKE '${table}'`);
  if (!tables.length) return { table, exists: false, row_count: 0, tenant_id_column: false, indexes: [] };
  const [columns, indexes] = await Promise.all([
    query(`SHOW COLUMNS FROM ${table}`),
    query(`SHOW INDEX FROM ${table}`)
  ]);
  const tenantColumn = columns.find((column) => column.Field === "tenant_id");
  const hasTenantColumn = Boolean(tenantColumn);
  const [counts] = await query(`SELECT COUNT(*) AS row_count${hasTenantColumn ? ", SUM(tenant_id IS NULL) AS legacy_unattributed_rows" : ""} FROM ${table}`);
  return {
    table,
    exists: true,
    row_count: Number(counts.row_count || 0),
    legacy_unattributed_rows: Number(counts.legacy_unattributed_rows || 0),
    tenant_id_column: hasTenantColumn,
    tenant_id_type: tenantColumn?.Type || null,
    indexes: [...new Set(indexes.map((index) => index.Key_name))]
  };
}

async function run() {
  if (APPLY && !socketPath) throw new Error("Apply mode requires --mysql-admin-socket for the MySQL administrator connection");
  let before = [];
  if (!APPLY) {
    before = await Promise.all(Object.keys(TABLES).map(inspectTable));
    console.log(JSON.stringify({
      ok: true,
      mode: "dry-run",
      changes_database: false,
      legacy_attribution: "existing rows remain NULL and must stay default-tenant-only; ownership is not inferred",
      unique_index_changes: { drop: DROP_INDEXES, add: UNIQUE_INDEXES },
      tables: before
    }));
    return;
  }

  const admin = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  try {
    const [[lock]] = await admin.query("SELECT GET_LOCK('tenant_listing_core_ownership_v1', 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("Listing core ownership migration lock unavailable");
    const adminQuery = async (sql, params = []) => (await admin.query(sql, params))[0];
    before = await Promise.all(Object.keys(TABLES).map((table) => inspectTable(table, adminQuery)));
    if (!before.some((snapshot) => snapshot.exists)) {
      await admin.query("SELECT RELEASE_LOCK('tenant_listing_core_ownership_v1')");
      console.log(JSON.stringify({ ok: true, mode: "apply", message: "No listing core tables exist; application schema creates them tenant-aware.", tables: before }));
      return;
    }

    // Validate every existing table before the first ALTER/DROP so schema drift cannot leave a partial migration.
    for (const snapshot of before) {
      if (!snapshot.exists) continue;
      const [columns] = await admin.query(`SHOW COLUMNS FROM ${snapshot.table}`);
      const tenantColumn = columns.find((column) => column.Field === "tenant_id");
      assertTenantIdColumnType(snapshot.table, tenantColumn?.Type);
    }
    const taskTable = before.find((snapshot) => snapshot.table === "listing_publish_tasks" && snapshot.exists);
    if (taskTable) {
      const taskTenantExpression = taskTable.tenant_id_column
        ? "COALESCE(NULLIF(tenant_id, ''), 'admin')"
        : "'admin'";
      const [[duplicate]] = await admin.query(`
        SELECT ${taskTenantExpression} AS tenant_key, request_id, COUNT(*) AS duplicate_count
        FROM listing_publish_tasks
        WHERE request_id IS NOT NULL
        GROUP BY ${taskTenantExpression}, request_id
        HAVING COUNT(*) > 1
        LIMIT 1
      `);
      assertNoDuplicateTenantRequest(duplicate);
    }
    const categoryUsageTable = before.find((snapshot) => snapshot.table === "ozon_category_usage" && snapshot.exists);
    if (categoryUsageTable) {
      const categoryUsageTenantExpression = categoryUsageTable.tenant_id_column
        ? "COALESCE(NULLIF(tenant_id, ''), 'admin')"
        : "'admin'";
      const [[duplicate]] = await admin.query(`
        SELECT ${categoryUsageTenantExpression} AS tenant_key, source_module, source_id,
          description_category_id, type_id, COUNT(*) AS duplicate_count
        FROM ozon_category_usage
        GROUP BY ${categoryUsageTenantExpression}, source_module, source_id, description_category_id, type_id
        HAVING COUNT(*) > 1
        LIMIT 1
      `);
      assertNoDuplicateCategoryUsage(duplicate);
    }

    for (const snapshot of before) {
      if (!snapshot.exists) continue;
      const table = snapshot.table;
      let [columns] = await admin.query(`SHOW COLUMNS FROM ${table}`);
      if (!columns.some((column) => column.Field === "tenant_id")) {
        await admin.query(`ALTER TABLE ${table} ADD COLUMN tenant_id VARCHAR(80) NULL AFTER id`);
      }
      const [indexes] = await admin.query(`SHOW INDEX FROM ${table}`);
      const names = new Set(indexes.map((index) => index.Key_name));
      for (const name of DROP_INDEXES[table] || []) {
        if (names.has(name)) {
          await admin.query(`ALTER TABLE ${table} DROP INDEX ${name}`);
          names.delete(name);
        }
      }
      for (const [name, definition] of Object.entries(TABLES[table])) {
        if (!names.has(name)) await admin.query(`ALTER TABLE ${table} ADD ${definition}`);
      }
      const uniqueNames = new Set((await admin.query(`SHOW INDEX FROM ${table}`))[0].map((index) => index.Key_name));
      for (const [name, definition] of Object.entries(UNIQUE_INDEXES[table] || {})) {
        if (!uniqueNames.has(name)) await admin.query(`ALTER TABLE ${table} ADD ${definition}`);
      }
      columns = (await admin.query(`SHOW COLUMNS FROM ${table}`))[0];
      const verifiedIndexes = await admin.query(`SHOW INDEX FROM ${table}`);
      const columnNames = new Set(columns.map((column) => column.Field));
      const indexNames = new Set(verifiedIndexes[0].map((index) => index.Key_name));
      const expectedIndexes = [...Object.keys(TABLES[table]), ...Object.keys(UNIQUE_INDEXES[table] || {})];
      if (!columnNames.has("tenant_id") || expectedIndexes.some((name) => !indexNames.has(name)) || (DROP_INDEXES[table] || []).some((name) => indexNames.has(name))) {
        throw new Error(`Listing core tenant schema verification failed for ${table}`);
      }
    }
    await admin.query("SELECT RELEASE_LOCK('tenant_listing_core_ownership_v1')");
    console.log(JSON.stringify({
      ok: true,
      mode: "apply",
      legacy_rows_preserved_unattributed: before.reduce((sum, table) => sum + (table.legacy_unattributed_rows ?? table.row_count), 0),
      legacy_rows_backfilled: false,
      tables: before.filter((table) => table.exists).map((table) => table.table)
    }));
  } catch (error) {
    try { await admin.query("SELECT RELEASE_LOCK('tenant_listing_core_ownership_v1')"); } catch {}
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
