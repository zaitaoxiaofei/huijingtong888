import mysql from "mysql2/promise";
import { config } from "../src/config.js";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const APPLY = process.argv.includes("--apply");
const socketPath = process.argv.find((arg) => arg.startsWith("--mysql-admin-socket="))?.split("=").slice(1).join("=");
const TABLES = [
  ["finance_companies", "idx_finance_company_tenant_status", "(tenant_id, status, id)"],
  ["finance_shop_company_assignments", "idx_finance_assignment_tenant_shop_period", "(tenant_id, shop_id, effective_from, effective_to)"],
  ["finance_expenses", "idx_finance_expense_tenant_company_date", "(tenant_id, company_id, expense_date, id)"],
  ["finance_vouchers", "idx_finance_voucher_tenant_company_date", "(tenant_id, company_id, issue_date, id)"],
  ["finance_periods", "idx_finance_period_tenant_company_month", "(tenant_id, company_id, month_key)"]
];

async function inspect(query = mysqlQuery) {
  const result = {};
  for (const [table, index] of TABLES) {
    const exists = await query(`SHOW TABLES LIKE '${table}'`);
    if (!exists.length) {
      result[table] = { exists: false, tenantColumn: false, index: false };
      continue;
    }
    const [columns, indexes] = await Promise.all([query(`SHOW COLUMNS FROM ${table}`), query(`SHOW INDEX FROM ${table}`)]);
    result[table] = {
      exists: true,
      tenantColumn: columns.some((column) => column.Field === "tenant_id"),
      index: indexes.some((item) => item.Key_name === index),
      tenantNameIndex: table === "finance_companies" && indexes.some((item) => item.Key_name === "uk_finance_company_tenant_name"),
      legacyGlobalNameIndex: table === "finance_companies" && indexes.some((item) => item.Key_name === "uk_finance_company_name")
    };
  }
  return result;
}

async function run() {
  if (APPLY && !socketPath) throw new Error("Apply mode requires --mysql-admin-socket");
  if (!APPLY) {
    console.log(JSON.stringify({ ok: true, mode: "dry-run", changes_database: false, legacy_rows_reassigned: false, before: await inspect() }));
    return;
  }
  const admin = await mysql.createConnection({ socketPath, user: "root", database: config.dbName });
  try {
    const [[lock]] = await admin.query("SELECT GET_LOCK('tenant_finance_center_v1', 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error("Tenant finance-center migration lock unavailable");
    const query = async (sql, params = []) => (await admin.query(sql, params))[0];
    const before = await inspect(query);
    for (const [table, index, definition] of TABLES) {
      if (!before[table].exists) continue;
      if (!before[table].tenantColumn) await admin.query(`ALTER TABLE ${table} ADD COLUMN tenant_id BIGINT UNSIGNED NULL`);
      if (!before[table].index) await admin.query(`ALTER TABLE ${table} ADD KEY ${index} ${definition}`);
    }
    if (before.finance_companies.exists) {
      const [[duplicates]] = await admin.query("SELECT COUNT(*) AS count FROM (SELECT tenant_id, name FROM finance_companies GROUP BY tenant_id, name HAVING COUNT(*) > 1) duplicate_company_names");
      if (Number(duplicates.count || 0)) throw new Error("Duplicate company names exist within the same tenant; no company-name index change applied");
      if (!before.finance_companies.tenantNameIndex) await admin.query("ALTER TABLE finance_companies ADD UNIQUE KEY uk_finance_company_tenant_name (tenant_id, name)");
      const [newIndexRows] = await admin.query("SHOW INDEX FROM finance_companies WHERE Key_name='uk_finance_company_tenant_name'");
      const tenantNameColumns = newIndexRows.sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index)).map((item) => item.Column_name);
      if (tenantNameColumns.join(",") !== "tenant_id,name" || newIndexRows.some((item) => Number(item.Non_unique) !== 0)) throw new Error("Tenant-scoped company-name index verification failed; legacy unique index remains in place");
      if (before.finance_companies.legacyGlobalNameIndex) await admin.query("ALTER TABLE finance_companies DROP INDEX uk_finance_company_name");
    }
    const after = await inspect(query);
    const missing = Object.entries(after).filter(([, state]) => state.exists && (!state.tenantColumn || !state.index));
    if (missing.length) throw new Error(`Tenant finance-center migration verification failed: ${missing.map(([table]) => table).join(", ")}`);
    if (after.finance_companies.exists && (!after.finance_companies.tenantNameIndex || after.finance_companies.legacyGlobalNameIndex)) throw new Error("Tenant-scoped company-name index migration verification failed");
    await admin.query("SELECT RELEASE_LOCK('tenant_finance_center_v1')");
    console.log(JSON.stringify({ ok: true, mode: "apply", legacy_rows_reassigned: false, tables: after }));
  } catch (error) {
    try { await admin.query("SELECT RELEASE_LOCK('tenant_finance_center_v1')"); } catch {}
    throw error;
  } finally {
    await admin.end();
  }
}

try { await run(); } finally { await closeMysqlPool(); }
