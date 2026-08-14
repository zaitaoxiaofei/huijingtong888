import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMysqlConnection, closeMysqlConnection } from "./mysql-runtime.mjs";

const WRITE = process.argv.includes("--write");
const TABLE_ARG = process.argv.find((item) => item.startsWith("--table="));
const TABLE = String(TABLE_ARG?.split("=")[1] || "").trim();
const BACKUP_SUFFIX = "20260803";

const TRANSFORMS = Object.freeze({
  listing_category_templates: {
    source_raw_json: "NULL",
    category_attributes_json: "NULL",
    editable_payload_json: "JSON_REMOVE(editable_payload_json, '$.source_raw', '$.editable_payload.source_raw')"
  },
  listing_drafts: {
    manual_facts_json: "JSON_REMOVE(manual_facts_json, '$.source_raw')",
    ai_payload_json: "JSON_REMOVE(ai_payload_json, '$.source_raw')",
    template_payload_json: "JSON_REMOVE(template_payload_json, '$.source_raw', '$.editable_payload.source_raw', '$.editable_payload.variants[0].source_raw')"
  },
  listing_ai_variant_assets: {
    prompt_snapshot_json: "'{}'",
    row_snapshot_json: `JSON_OBJECT(
      'item_no', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(row_snapshot_json, '$.item_no')), ''),
      'target_variant_value', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(row_snapshot_json, '$.target_variant_value')), ''),
      'status', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(row_snapshot_json, '$.status')), ''),
      'title', LEFT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(row_snapshot_json, '$.title')), ''), 6000),
      'tags', COALESCE(JSON_EXTRACT(row_snapshot_json, '$.tags'), JSON_ARRAY()),
      'description', LEFT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(row_snapshot_json, '$.description')), ''), 24000),
      'source_main_image_url', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(row_snapshot_json, '$.source_main_image_url')), ''),
      'generated_main_image_url', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(row_snapshot_json, '$.generated_main_image_url')), ''),
      'generated_main_image_original_url', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(row_snapshot_json, '$.generated_main_image_original_url')), '')
    )`
  }
});

function quoteIdentifier(value) {
  return `\`${String(value).replaceAll("`", "``")}\``;
}

async function tableColumns(connection, table) {
  const [rows] = await connection.query(`
    SELECT column_name, extra
    FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = ?
    ORDER BY ordinal_position
  `, [table]);
  return rows.map((row) => ({ name: String(row.column_name || row.COLUMN_NAME), extra: String(row.extra || row.EXTRA || "") }));
}

async function tableSummary(connection, table) {
  const [[row]] = await connection.query(`
    SELECT COUNT(*) AS count, COALESCE(MIN(id), 0) AS min_id, COALESCE(MAX(id), 0) AS max_id,
      MAX(updated_at) AS max_updated
    FROM ${quoteIdentifier(table)}
  `);
  const [[size]] = await connection.query(`
    SELECT ROUND((data_length + index_length) / 1024 / 1024, 1) AS size_mb
    FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = ?
  `, [table]);
  return { ...row, size_mb: Number(size?.size_mb || 0) };
}

async function syncSlimTable(connection, table, transforms) {
  const slim = `_migration_slim_${table}`;
  const sourceColumns = await tableColumns(connection, table);
  const slimColumns = await tableColumns(connection, slim);
  if (!sourceColumns.length || sourceColumns.map((item) => item.name).join("|") !== slimColumns.map((item) => item.name).join("|")) {
    throw new Error(`Schema mismatch between ${table} and ${slim}`);
  }
  const writable = sourceColumns.filter((column) => !/GENERATED/i.test(column.extra));
  const names = writable.map((column) => quoteIdentifier(column.name));
  const selections = writable.map((column) => transforms[column.name] || quoteIdentifier(column.name));
  const updates = writable
    .filter((column) => column.name !== "id")
    .map((column) => `${quoteIdentifier(column.name)} = VALUES(${quoteIdentifier(column.name)})`);
  const [[watermark]] = await connection.query(`
    SELECT COALESCE(MAX(id), 0) AS max_id, MAX(updated_at) AS max_updated
    FROM ${quoteIdentifier(slim)}
  `);
  const maxId = Number(watermark?.max_id || 0);
  const maxUpdated = watermark?.max_updated || "1970-01-01 00:00:00";
  const [result] = await connection.query(`
    INSERT INTO ${quoteIdentifier(slim)} (${names.join(", ")})
    SELECT ${selections.join(", ")}
    FROM ${quoteIdentifier(table)}
    WHERE id > ? OR updated_at >= ?
    ON DUPLICATE KEY UPDATE ${updates.join(", ")}
  `, [maxId, maxUpdated]);
  const [[coverage]] = await connection.query(`
    SELECT
      SUM(CASE WHEN c.id IS NULL THEN 1 ELSE 0 END) AS missing_in_slim,
      COUNT(*) AS source_count
    FROM ${quoteIdentifier(table)} s
    LEFT JOIN ${quoteIdentifier(slim)} c ON c.id = s.id
  `);
  const [[extra]] = await connection.query(`
    SELECT COUNT(*) AS extra_in_slim
    FROM ${quoteIdentifier(slim)} c
    LEFT JOIN ${quoteIdentifier(table)} s ON s.id = c.id
    WHERE s.id IS NULL
  `);
  if (Number(coverage?.missing_in_slim || 0) || Number(extra?.extra_in_slim || 0)) {
    throw new Error(`Slim coverage mismatch for ${table}`);
  }
  return { affected: Number(result.affectedRows || 0), sourceCount: Number(coverage?.source_count || 0) };
}

export async function promoteSlimCoreTable(table = TABLE) {
  if (!TRANSFORMS[table]) throw new Error(`Use --table with one of: ${Object.keys(TRANSFORMS).join(", ")}`);
  const slim = `_migration_slim_${table}`;
  const backup = `_storage_backup_${table}_${BACKUP_SUFFIX}`;
  const connection = await createMysqlConnection({ multipleStatements: false });
  try {
    const before = {
      source: await tableSummary(connection, table),
      slim: await tableSummary(connection, slim)
    };
    if (!WRITE) return { mode: "dry-run", table, slim, backup, before };
    const [existingBackup] = await connection.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
      [backup]
    );
    if (existingBackup.length) throw new Error(`Backup table already exists: ${backup}`);
    const sync = await syncSlimTable(connection, table, TRANSFORMS[table]);
    const ready = await tableSummary(connection, slim);
    if (Number(ready.count || 0) !== Number(sync.sourceCount || 0)) throw new Error(`Row count mismatch for ${table}`);
    await connection.query(`
      RENAME TABLE ${quoteIdentifier(table)} TO ${quoteIdentifier(backup)},
                   ${quoteIdentifier(slim)} TO ${quoteIdentifier(table)}
    `);
    return {
      mode: "write",
      table,
      backup,
      before,
      sync,
      active: await tableSummary(connection, table),
      retainedBackup: await tableSummary(connection, backup)
    };
  } finally {
    await closeMysqlConnection(connection);
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  promoteSlimCoreTable()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error?.stack || error);
      process.exitCode = 1;
    });
}
