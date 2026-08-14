import { pathToFileURL } from "node:url";
import path from "node:path";
import { closeMysqlPool, mysqlExecute, mysqlQuery } from "../src/mysql-pool.js";

const WRITE = process.argv.includes("--write");
const BATCH_SIZE_ARG = process.argv.find((item) => item.startsWith("--batch-size="));
const BATCH_SIZE = Math.min(Math.max(Number(BATCH_SIZE_ARG?.split("=")[1] || 200), 10), 1000);
const ONLY_ARG = process.argv.find((item) => item.startsWith("--only="));
const ONLY_TABLE = String(ONLY_ARG?.split("=")[1] || "").trim();

const TARGETS = [
  {
    table: "listing_ai_variant_assets",
    where: "1 = 1",
    update: "prompt_snapshot_json = '{}'"
  },
  {
    table: "ai_generation_tasks",
    where: "status = 'done' AND input_json IS NOT NULL",
    update: `input_json = JSON_OBJECT(
      'productName', LEFT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.productName')), ''), 4000),
      'categoryName', LEFT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.categoryName')), ''), 2000),
      'brand', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.brand')), ''),
      'targetModel', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.targetModel')), ''),
      'material', LEFT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.material')), ''), 2000),
      'color', LEFT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.color')), ''), 1000),
      'title', LEFT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.title')), ''), 6000),
      'summary', LEFT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.summary')), ''), 6000),
      'description', LEFT(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.description')), ''), 12000),
      'sourceImageUrl', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.sourceImageUrl')), ''),
      'imageUrl', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.imageUrl')), ''),
      'resultId', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.resultId')), '')
    )`
  },
  {
    table: "listing_category_templates",
    where: "1 = 1",
    update: `
      source_raw_json = NULL,
      category_attributes_json = NULL,
      editable_payload_json = CASE
        WHEN JSON_VALID(editable_payload_json) THEN JSON_REMOVE(editable_payload_json, '$.source_raw', '$.editable_payload.source_raw')
        ELSE editable_payload_json
      END
    `
  },
  {
    table: "listing_drafts",
    where: "1 = 1",
    update: `
      manual_facts_json = CASE WHEN JSON_VALID(manual_facts_json) THEN JSON_REMOVE(manual_facts_json, '$.source_raw') ELSE manual_facts_json END,
      ai_payload_json = CASE WHEN JSON_VALID(ai_payload_json) THEN JSON_REMOVE(ai_payload_json, '$.source_raw') ELSE ai_payload_json END,
      template_payload_json = CASE WHEN JSON_VALID(template_payload_json) THEN JSON_REMOVE(template_payload_json, '$.source_raw', '$.editable_payload.source_raw', '$.editable_payload.variants[0].source_raw') ELSE template_payload_json END
    `
  }
];

async function candidateCount(target) {
  const rows = await mysqlQuery(`SELECT COUNT(*) AS count FROM \`${target.table}\` WHERE ${target.where}`);
  return Number(rows[0]?.count || 0);
}

async function compactTarget(target) {
  let updated = 0;
  let cursor = 0;
  for (;;) {
    const rows = await mysqlQuery(`SELECT id FROM \`${target.table}\` WHERE ${target.where} AND id > ? ORDER BY id LIMIT ?`, [cursor, BATCH_SIZE]);
    const ids = rows.map((row) => Number(row.id)).filter(Boolean);
    if (!ids.length) break;
    const result = await mysqlExecute(`
      UPDATE \`${target.table}\`
      SET ${target.update}
      WHERE id IN (${ids.map(() => "?").join(",")})
    `, ids);
    updated += Number(result.affectedRows || 0);
    cursor = ids[ids.length - 1];
    console.log(JSON.stringify({ table: target.table, updated, remainingBatch: ids.length }));
  }
  return updated;
}

export async function compactMysqlStorageBloat() {
  const selectedTargets = ONLY_TABLE ? TARGETS.filter((target) => target.table === ONLY_TABLE) : TARGETS;
  if (ONLY_TABLE && !selectedTargets.length) throw new Error(`Unknown cleanup target: ${ONLY_TABLE}`);
  const before = {};
  for (const target of selectedTargets) before[target.table] = await candidateCount(target);
  const productRows = await mysqlQuery(`
    SELECT COUNT(*) AS total,
      SUM(image_url LIKE 'data:image/%') AS base64_main,
      SUM(detail_image_urls LIKE '%data:image/%') AS base64_details
    FROM products
  `);
  const report = { mode: WRITE ? "write" : "dry-run", before, products: productRows[0] || {} };
  console.log(JSON.stringify(report, null, 2));
  if (!WRITE) return report;
  const updated = {};
  for (const target of selectedTargets) updated[target.table] = await compactTarget(target);
  const result = { ...report, updated };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  compactMysqlStorageBloat()
    .catch((error) => {
      console.error(error?.stack || error);
      process.exitCode = 1;
    })
    .finally(() => closeMysqlPool());
}
