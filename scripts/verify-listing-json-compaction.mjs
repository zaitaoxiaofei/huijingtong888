import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

try {
  const [templates, drafts, records] = await Promise.all([
    mysqlQuery(`SELECT COUNT(*) total,
      SUM(source_raw_json IS NOT NULL AND source_raw_json NOT IN ('', '{}')) source_raw_remaining,
      SUM(category_attributes_json IS NOT NULL AND category_attributes_json NOT IN ('', '[]', '{}')) category_attributes_remaining,
      SUM(editable_payload_json LIKE '%"source_raw"%') nested_source_raw_remaining
      FROM listing_category_templates`),
    mysqlQuery(`SELECT COUNT(*) total,
      SUM(manual_facts_json LIKE '%"source_raw"%') manual_source_raw_remaining,
      SUM(ai_payload_json LIKE '%"source_raw"%') ai_source_raw_remaining,
      SUM(template_payload_json LIKE '%"source_raw"%') template_source_raw_remaining
      FROM listing_drafts`),
    mysqlQuery(`SELECT COUNT(*) total,
      SUM(template_snapshot_json LIKE '%"source_raw"%') source_raw_remaining
      FROM listing_publish_records`)
  ]);
  console.log(JSON.stringify({ templates: templates[0], drafts: drafts[0], publish_records: records[0] }, null, 2));
} finally {
  await closeMysqlPool();
}
