import { closeMysqlPool, mysqlExecute, mysqlQuery } from "../src/mysql-pool.js";
import { compactListingPublishRecordSnapshot } from "./compact-listing-publish-records.mjs";

const APPLY = process.argv.includes("--apply");
let cursor = 0;
let scanned = 0;
let updated = 0;

try {
  for (;;) {
    const rows = await mysqlQuery(`
      SELECT id, template_snapshot_json
      FROM listing_publish_records
      WHERE id > ? AND template_snapshot_json IS NOT NULL
      ORDER BY id LIMIT 20
    `, [cursor]);
    if (!rows.length) break;
    for (const row of rows) {
      const compact = compactListingPublishRecordSnapshot(row.template_snapshot_json);
      if (APPLY && compact) {
        await mysqlExecute("UPDATE listing_publish_records SET template_snapshot_json=? WHERE id=?", [JSON.stringify(compact), row.id]);
        updated += 1;
      }
    }
    scanned += rows.length;
    cursor = Number(rows.at(-1).id);
    if (scanned % 200 === 0) console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry-run", scanned, updated }));
  }
  console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry-run", scanned, updated }, null, 2));
} finally {
  await closeMysqlPool();
}
