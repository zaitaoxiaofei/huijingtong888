import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

const queries = [
  ["listing_category_templates", `SELECT COUNT(*) row_count,
    ROUND(COALESCE(SUM(OCTET_LENGTH(source_raw_json)), 0) / 1048576, 1) source_raw_mb,
    ROUND(COALESCE(SUM(OCTET_LENGTH(category_attributes_json)), 0) / 1048576, 1) attributes_mb,
    ROUND(COALESCE(SUM(OCTET_LENGTH(editable_payload_json)), 0) / 1048576, 1) payload_mb
    FROM listing_category_templates`],
  ["listing_drafts", `SELECT COUNT(*) row_count,
    ROUND(COALESCE(SUM(OCTET_LENGTH(manual_facts_json)), 0) / 1048576, 1) manual_facts_mb,
    ROUND(COALESCE(SUM(OCTET_LENGTH(ai_payload_json)), 0) / 1048576, 1) ai_payload_mb,
    ROUND(COALESCE(SUM(OCTET_LENGTH(template_payload_json)), 0) / 1048576, 1) template_payload_mb
    FROM listing_drafts`],
  ["listing_publish_records", `SELECT COUNT(*) row_count,
    ROUND(COALESCE(SUM(OCTET_LENGTH(template_snapshot_json)), 0) / 1048576, 1) snapshot_mb
    FROM listing_publish_records`]
];

try {
  const report = {};
  for (const [name, sql] of queries) report[name] = (await mysqlQuery(sql))[0] || {};
  console.log(JSON.stringify(report, null, 2));
} finally {
  await closeMysqlPool();
}
