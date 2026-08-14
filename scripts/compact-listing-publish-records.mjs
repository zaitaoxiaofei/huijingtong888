import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMysqlConnection, closeMysqlConnection } from "./mysql-runtime.mjs";

const WRITE = process.argv.includes("--write");
const SOURCE = "listing_publish_records";
const FRESH = "_migration_compact_listing_publish_records_20260803";
const BACKUP = "_storage_backup_listing_publish_records_20260803";
const BATCH_SIZE = 20;
const DROP_KEYS = new Set([
  "raw", "raw_json", "source_raw", "sourceRaw", "source_raw_json",
  "promptVariables", "prompt_variables", "generationSnapshot", "generation_snapshot",
  "generationSnapshots", "generation_snapshots", "templateSnapshot", "template_snapshot",
  "template_snapshot_json", "rowSnapshot", "row_snapshot"
]);
const BOUNDED_ARRAY_KEYS = new Set(["values", "options", "candidates", "dictionary_values", "dictionaryValues"]);

function quoteIdentifier(value) {
  return `\`${String(value).replaceAll("`", "``")}\``;
}

function compactSnapshotValue(value, key = "") {
  if (Array.isArray(value)) {
    const limit = BOUNDED_ARRAY_KEYS.has(key) ? 20 : value.length;
    return value.slice(0, limit).map((item) => compactSnapshotValue(item, key));
  }
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (DROP_KEYS.has(childKey)) continue;
    result[childKey] = compactSnapshotValue(child, childKey);
  }
  return result;
}

export function compactListingPublishRecordSnapshot(value) {
  if (!value) return null;
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object") return null;
  return { ...compactSnapshotValue(parsed), source_raw_omitted: true };
}

async function tableExists(connection, table) {
  const [rows] = await connection.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?",
    [table]
  );
  return rows.length > 0;
}

async function writableColumns(connection) {
  const [rows] = await connection.query(`
    SELECT column_name, extra
    FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name=?
    ORDER BY ordinal_position
  `, [SOURCE]);
  return rows.filter((row) => !/GENERATED/i.test(String(row.extra || row.EXTRA || "")))
    .map((row) => String(row.column_name || row.COLUMN_NAME));
}

export async function compactListingPublishRecords() {
  const connection = await createMysqlConnection({ multipleStatements: false });
  try {
    const [[sourceSummary]] = await connection.query(`SELECT COUNT(*) count, COALESCE(MAX(id),0) max_id FROM ${quoteIdentifier(SOURCE)}`);
    const plan = { mode: WRITE ? "write" : "dry-run", source: SOURCE, fresh: FRESH, backup: BACKUP, rows: Number(sourceSummary.count || 0) };
    if (!WRITE) return plan;
    if (await tableExists(connection, FRESH) || await tableExists(connection, BACKUP)) {
      throw new Error("Publish-record migration or backup table already exists");
    }
    await connection.query(`CREATE TABLE ${quoteIdentifier(FRESH)} LIKE ${quoteIdentifier(SOURCE)}`);
    const columns = await writableColumns(connection);
    const names = columns.map(quoteIdentifier);
    let cursor = 0;
    let copied = 0;
    for (;;) {
      const [rows] = await connection.query(`
        SELECT ${names.join(",")}
        FROM ${quoteIdentifier(SOURCE)}
        WHERE id > ?
        ORDER BY id
        LIMIT ${BATCH_SIZE}
      `, [cursor]);
      if (!rows.length) break;
      const values = [];
      const tuples = [];
      for (const row of rows) {
        const compactSnapshot = compactListingPublishRecordSnapshot(row.template_snapshot_json);
        const normalized = { ...row, template_snapshot_json: compactSnapshot ? JSON.stringify(compactSnapshot) : null };
        tuples.push(`(${columns.map(() => "?").join(",")})`);
        values.push(...columns.map((column) => normalized[column]));
      }
      await connection.query(`INSERT INTO ${quoteIdentifier(FRESH)} (${names.join(",")}) VALUES ${tuples.join(",")}`, values);
      copied += rows.length;
      cursor = Number(rows[rows.length - 1].id);
      if (copied % 200 === 0 || copied === Number(sourceSummary.count || 0)) console.log(JSON.stringify({ copied, total: Number(sourceSummary.count || 0) }));
    }
    const [[coverage]] = await connection.query(`
      SELECT
        (SELECT COUNT(*) FROM ${quoteIdentifier(SOURCE)}) source_count,
        (SELECT COUNT(*) FROM ${quoteIdentifier(FRESH)}) fresh_count,
        (SELECT COUNT(*) FROM ${quoteIdentifier(SOURCE)} s LEFT JOIN ${quoteIdentifier(FRESH)} f ON f.id=s.id WHERE f.id IS NULL) missing_count
    `);
    if (Number(coverage.source_count) !== Number(coverage.fresh_count) || Number(coverage.missing_count)) {
      throw new Error("Publish-record compact table coverage mismatch");
    }
    await connection.query(`RENAME TABLE ${quoteIdentifier(SOURCE)} TO ${quoteIdentifier(BACKUP)}, ${quoteIdentifier(FRESH)} TO ${quoteIdentifier(SOURCE)}`);
    await connection.query(`ANALYZE TABLE ${quoteIdentifier(SOURCE)}`);
    const [sizes] = await connection.query(
      "SELECT table_name,table_rows,ROUND((data_length+index_length)/1024/1024,1) mb FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN (?,?)",
      [SOURCE, BACKUP]
    );
    return { ...plan, copied, coverage, sizes };
  } finally {
    await closeMysqlConnection(connection);
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  compactListingPublishRecords()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error);
      process.exitCode = 1;
    });
}
