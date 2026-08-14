import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

try {
  const templates = await mysqlQuery(`SELECT id, source_raw_json, category_attributes_json, editable_payload_json
    FROM listing_category_templates ORDER BY id DESC LIMIT 5`);
  const drafts = await mysqlQuery(`SELECT id, manual_facts_json, ai_payload_json, template_payload_json
    FROM listing_drafts ORDER BY id DESC LIMIT 5`);
  const records = await mysqlQuery(`SELECT id, template_snapshot_json
    FROM listing_publish_records ORDER BY id DESC LIMIT 5`);
  const sizes = await mysqlQuery(`SELECT table_name, table_rows,
    ROUND(data_length/1024/1024,1) data_mb, ROUND(index_length/1024/1024,1) index_mb,
    ROUND(data_free/1024/1024,1) free_mb
    FROM information_schema.tables WHERE table_schema=DATABASE()
      AND table_name IN ('listing_category_templates','listing_drafts','listing_publish_records')`);
  const hasRaw = (value) => String(value || "").includes('"source_raw"');
  console.log(JSON.stringify({
    template_samples: templates.map((row) => ({ id: row.id, source_raw_bytes: Buffer.byteLength(row.source_raw_json || ""), category_attributes_bytes: Buffer.byteLength(row.category_attributes_json || ""), nested_source_raw: hasRaw(row.editable_payload_json) })),
    draft_samples: drafts.map((row) => ({ id: row.id, manual_source_raw: hasRaw(row.manual_facts_json), ai_source_raw: hasRaw(row.ai_payload_json), template_source_raw: hasRaw(row.template_payload_json) })),
    publish_samples: records.map((row) => ({ id: row.id, source_raw: hasRaw(row.template_snapshot_json), bytes: Buffer.byteLength(row.template_snapshot_json || "") })),
    sizes
  }, null, 2));
} finally {
  await closeMysqlPool();
}
