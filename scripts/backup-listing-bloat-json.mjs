import fs from "node:fs";
import { once } from "node:events";
import { createGzip } from "node:zlib";
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const outputPath = process.argv.find((value) => value.startsWith("--output="))?.slice(9);
if (!outputPath) throw new Error("Missing --output path");

const targets = [
  ["listing_category_templates", ["id", "source_raw_json", "category_attributes_json", "editable_payload_json"]],
  ["listing_drafts", ["id", "manual_facts_json", "ai_payload_json", "template_payload_json"]],
  ["listing_publish_records", ["id", "template_snapshot_json"]]
];
const gzip = createGzip({ level: 6 });
const output = fs.createWriteStream(outputPath, { flags: "wx" });
gzip.pipe(output);
const counts = {};

async function writeLine(value) {
  if (gzip.write(`${JSON.stringify(value)}\n`)) return;
  await once(gzip, "drain");
}

try {
  for (const [table, columns] of targets) {
    let cursor = 0;
    let count = 0;
    for (;;) {
      const rows = await mysqlQuery(`SELECT ${columns.join(",")} FROM ${table} WHERE id > ? ORDER BY id LIMIT 100`, [cursor]);
      if (!rows.length) break;
      for (const row of rows) await writeLine({ table, ...row });
      cursor = Number(rows.at(-1).id);
      count += rows.length;
    }
    counts[table] = count;
  }
  gzip.end();
  await once(output, "close");
  console.log(JSON.stringify({ output: outputPath, counts }, null, 2));
} finally {
  await closeMysqlPool();
}
