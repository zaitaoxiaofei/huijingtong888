import { pathToFileURL } from "node:url";
import path from "node:path";
import { createMysqlConnection, closeMysqlConnection } from "./mysql-runtime.mjs";

const WRITE = process.argv.includes("--write");
const APPEND = process.argv.includes("--append");
const SLIM_TABLE_PREFIX = "_migration_slim_";

const TABLE_TRANSFORMS = Object.freeze({
  products: {
    listing_title_prompt: "NULL",
    listing_tags_prompt: "NULL",
    listing_description_prompt: "NULL"
  },
  listing_drafts: {
    manual_facts_json: "JSON_REMOVE(manual_facts_json, '$.source_raw')",
    ai_payload_json: "JSON_REMOVE(ai_payload_json, '$.source_raw')",
    template_payload_json: `JSON_REMOVE(
      template_payload_json,
      '$.source_raw',
      '$.editable_payload.source_raw',
      '$.editable_payload.variants[0].source_raw'
    )`
  },
  listing_category_templates: {
    source_raw_json: "NULL",
    category_attributes_json: "NULL",
    editable_payload_json: `JSON_REMOVE(
      editable_payload_json,
      '$.source_raw',
      '$.editable_payload.source_raw'
    )`
  },
  listing_ai_variant_assets: {
    prompt_snapshot_json: "NULL",
    row_snapshot_json: "NULL"
  }
});

function quoteIdentifier(value) {
  return `\`${String(value).replaceAll("`", "``")}\``;
}

async function copySlimTable(connection, tableName, transforms) {
  const slimTableName = `${SLIM_TABLE_PREFIX}${tableName}`;
  const [columns] = await connection.query(`
    SELECT column_name, extra
    FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = ?
    ORDER BY ordinal_position
  `, [tableName]);
  const writableColumns = columns.filter((column) => !/GENERATED/i.test(String(column.extra || column.EXTRA || "")));
  if (!writableColumns.length) throw new Error(`Cannot find writable columns for ${tableName}`);
  const names = writableColumns.map((column) => quoteIdentifier(column.column_name || column.COLUMN_NAME));
  const selections = writableColumns.map((column) => {
    const columnName = String(column.column_name || column.COLUMN_NAME);
    return transforms[columnName] || quoteIdentifier(columnName);
  });
  if (!APPEND) {
    await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(slimTableName)}`);
    await connection.query(`
      CREATE TABLE ${quoteIdentifier(slimTableName)}
      LIKE ${quoteIdentifier(tableName)}
    `);
  }
  let appendWhere = "";
  if (APPEND) {
    const [[maxRow]] = await connection.query(`SELECT COALESCE(MAX(id), 0) AS max_id FROM ${quoteIdentifier(slimTableName)}`);
    const maxId = Number(maxRow?.max_id || maxRow?.MAX_ID || 0);
    appendWhere = `WHERE ${quoteIdentifier(tableName)}.id > ${maxId}`;
  }
  await connection.query(`
    INSERT ${APPEND ? "IGNORE" : ""} INTO ${quoteIdentifier(slimTableName)} (${names.join(", ")})
    SELECT ${selections.join(", ")}
    FROM ${quoteIdentifier(tableName)}
    ${appendWhere}
  `);
  const [[rowSummary]] = await connection.query(`
    SELECT COUNT(*) AS total_rows
    FROM ${quoteIdentifier(slimTableName)}
  `);
  await connection.query("ANALYZE TABLE ??", [slimTableName]);
  const [[sizeSummary]] = await connection.query(`
    SELECT ROUND((data_length + index_length) / 1024 / 1024, 1) AS size_mb
    FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name = ?
  `, [slimTableName]);
  return {
    table: tableName,
    rows: Number(rowSummary?.total_rows || rowSummary?.TOTAL_ROWS || 0),
    sizeMb: Number(sizeSummary?.size_mb || 0)
  };
}

export async function buildSlimCoreMigrationDatabase() {
  const connection = await createMysqlConnection();
  try {
    if (!WRITE) {
      const plan = Object.entries(TABLE_TRANSFORMS).map(([table, transforms]) => ({
        table,
        strippedFields: Object.keys(transforms)
      }));
      console.log(JSON.stringify({ mode: "dry-run", tablePrefix: SLIM_TABLE_PREFIX, plan }, null, 2));
      return { mode: "dry-run", plan };
    }
    const tables = [];
    for (const [tableName, transforms] of Object.entries(TABLE_TRANSFORMS)) {
      console.log(`Building slim migration copy: ${tableName}`);
      tables.push(await copySlimTable(connection, tableName, transforms));
    }
    const result = { mode: APPEND ? "append" : "write", tablePrefix: SLIM_TABLE_PREFIX, tables };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await closeMysqlConnection(connection);
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  buildSlimCoreMigrationDatabase().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
