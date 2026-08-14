import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const DEEP = process.argv.includes("--deep");
const MAX_EXECUTION_MS = Math.min(Math.max(Number(process.env.STORAGE_AUDIT_QUERY_TIMEOUT_MS || 15000), 1000), 60000);
const LARGE_TABLE_MB = Math.max(Number(process.env.STORAGE_AUDIT_LARGE_TABLE_MB || 50), 1);

const LARGE_JSON_COLUMNS = new Map([
  ["listing_category_templates", ["source_raw_json", "editable_payload_json", "category_attributes_json"]],
  ["listing_drafts", ["manual_facts_json", "ai_payload_json", "template_payload_json"]],
  ["listing_publish_records", ["request_json", "template_snapshot_json", "response_json", "error_json"]],
  ["ai_variant_draft_save_items", ["payload_json"]],
  ["ai_variant_lab_batch_items", ["payload_json", "result_json"]]
]);

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeIdentifier(value) {
  const text = String(value || "");
  if (!/^[A-Za-z0-9_]+$/.test(text)) throw new Error(`Unsafe MySQL identifier: ${text}`);
  return `\`${text}\``;
}

async function query(sql, params = []) {
  return mysqlQuery(`SET STATEMENT max_execution_time=${MAX_EXECUTION_MS} FOR ${sql}`, params);
}

async function tableInventory() {
  const rows = await query(`
    SELECT table_name, engine, table_rows, data_length, index_length, data_free,
      create_time, update_time
    FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
    ORDER BY data_length + index_length DESC
  `);
  return rows.map((row) => ({
    table: row.table_name,
    engine: row.engine || "",
    estimatedRows: number(row.table_rows),
    dataBytes: number(row.data_length),
    indexBytes: number(row.index_length),
    allocatedBytes: number(row.data_length) + number(row.index_length),
    reclaimableEstimateBytes: number(row.data_free),
    createTime: row.create_time || null,
    updateTime: row.update_time || null
  }));
}

async function jsonColumnInventory() {
  const rows = await query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND data_type IN ('json', 'text', 'mediumtext', 'longtext', 'blob', 'mediumblob', 'longblob')
    ORDER BY table_name, ordinal_position
  `);
  return rows.map((row) => ({ table: row.table_name, column: row.column_name, type: row.data_type }));
}

async function deepLargeFieldUsage() {
  const report = {};
  for (const [table, configuredColumns] of LARGE_JSON_COLUMNS) {
    const existing = await query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ?
    `, [table]);
    const existingColumns = new Set(existing.map((row) => row.column_name));
    const columns = configuredColumns.filter((column) => existingColumns.has(column));
    if (!columns.length) continue;
    const expressions = columns.map((column) => `COALESCE(SUM(OCTET_LENGTH(${safeIdentifier(column)})), 0) AS ${safeIdentifier(`${column}_bytes`)}`);
    const rows = await query(`SELECT COUNT(*) AS row_count, ${expressions.join(", ")} FROM ${safeIdentifier(table)}`);
    report[table] = rows[0] || {};
  }
  return report;
}

export async function auditStorageBaseline() {
  const [tables, largeColumns] = await Promise.all([tableInventory(), jsonColumnInventory()]);
  const totalAllocatedBytes = tables.reduce((sum, table) => sum + table.allocatedBytes, 0);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: DEEP ? "deep" : "metadata-only",
    safeguards: {
      readOnly: true,
      queryTimeoutMs: MAX_EXECUTION_MS,
      deepScanRequiresFlag: true
    },
    summary: {
      tableCount: tables.length,
      totalAllocatedBytes,
      largeTableThresholdBytes: LARGE_TABLE_MB * 1024 * 1024,
      largeTableCount: tables.filter((table) => table.allocatedBytes >= LARGE_TABLE_MB * 1024 * 1024).length,
      largeFieldColumnCount: largeColumns.length
    },
    tables,
    largeFieldColumns: largeColumns,
    deepLargeFieldUsage: DEEP ? await deepLargeFieldUsage() : null
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

auditStorageBaseline()
  .catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  })
  .finally(() => closeMysqlPool());
