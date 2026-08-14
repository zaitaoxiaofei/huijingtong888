import { setTimeout as delay } from "node:timers/promises";
import { closeMysqlPool, mysqlExecute, mysqlQuery } from "../src/mysql-pool.js";

const APPLY = process.argv.includes("--apply");
const batchSize = 20;
const targets = [
  {
    table: "listing_category_templates",
    where: `(source_raw_json IS NOT NULL OR category_attributes_json IS NOT NULL
      OR editable_payload_json LIKE '%"source_raw"%')`,
    update: `source_raw_json=NULL, category_attributes_json=NULL,
      editable_payload_json=CASE WHEN JSON_VALID(editable_payload_json)
        THEN JSON_REMOVE(editable_payload_json, '$.source_raw', '$.editable_payload.source_raw')
        ELSE editable_payload_json END`
  },
  {
    table: "listing_drafts",
    where: `(manual_facts_json LIKE '%"source_raw"%' OR ai_payload_json LIKE '%"source_raw"%'
      OR template_payload_json LIKE '%"source_raw"%')`,
    update: `manual_facts_json=CASE WHEN JSON_VALID(manual_facts_json) THEN JSON_REMOVE(manual_facts_json, '$.source_raw') ELSE manual_facts_json END,
      ai_payload_json=CASE WHEN JSON_VALID(ai_payload_json) THEN JSON_REMOVE(ai_payload_json, '$.source_raw') ELSE ai_payload_json END,
      template_payload_json=CASE WHEN JSON_VALID(template_payload_json)
        THEN JSON_REMOVE(template_payload_json, '$.source_raw', '$.editable_payload.source_raw', '$.editable_payload.variants[0].source_raw')
        ELSE template_payload_json END`
  }
];

try {
  for (const target of targets) {
    let cursor = 0;
    let updated = 0;
    for (;;) {
      const rows = await mysqlQuery(`SELECT id FROM ${target.table} WHERE id > ? ORDER BY id LIMIT ${batchSize}`, [cursor]);
      if (!rows.length) break;
      if (!APPLY) {
        console.log(JSON.stringify({ mode: "dry-run", table: target.table, sample_count: rows.length }));
        break;
      }
      const ids = rows.map((row) => Number(row.id));
      cursor = ids.at(-1);
      const result = await mysqlExecute(`UPDATE ${target.table} SET ${target.update} WHERE ${target.where} AND id IN (${ids.map(() => "?").join(",")})`, ids);
      updated += Number(result.affectedRows || 0);
      if (updated % 200 === 0) console.log(JSON.stringify({ table: target.table, updated }));
      await delay(100);
    }
    console.log(JSON.stringify({ table: target.table, updated, complete: APPLY }));
  }
} finally {
  await closeMysqlPool();
}
