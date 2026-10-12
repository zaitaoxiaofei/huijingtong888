import { closeMysqlPool, mysqlExecute, mysqlQuery } from "../src/mysql-pool.js";
import { vehicleMetaFromTarget } from "../src/services/product-development-meta.js";

const apply = process.argv.includes("--apply");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = Math.min(Math.max(Number(limitArg?.split("=")[1] || 5000), 1), 10000);

try {
  const brands = await mysqlQuery("SELECT DISTINCT brand_name FROM ai_vehicle_catalog WHERE brand_name <> ''");
  const extraBrands = brands.map((row) => row.brand_name);
  const rows = await mysqlQuery(`
    SELECT id, COALESCE(tenant_id, 'admin') AS tenant_id, product_name,
      vehicle_brand, vehicle_model, vehicle_model_key,
      COALESCE(
        CASE WHEN JSON_VALID(ai_payload_json) THEN JSON_UNQUOTE(JSON_EXTRACT(ai_payload_json, '$.ai_optimization.target_variant_value')) END,
        CASE WHEN JSON_VALID(manual_facts_json) THEN JSON_UNQUOTE(JSON_EXTRACT(manual_facts_json, '$.target_variant_value')) END
      ) AS target
    FROM listing_drafts
    WHERE status <> 'deleted' AND development_type = 'fission'
      AND (vehicle_brand IN ('', 'VAR', 'AI') OR vehicle_model = '' OR vehicle_model_key = '')
    ORDER BY id
    LIMIT ?
  `, [limit]);
  const summary = { mode: apply ? "apply" : "preview", scanned: rows.length, recoverable: 0, changed: 0, skipped_no_target: 0, skipped_unrecognized: 0, skipped_title_mismatch: 0, sample_ids: [], unrecognized_examples: [] };
  for (const draft of rows) {
    if (!draft.target) { summary.skipped_no_target += 1; continue; }
    const meta = vehicleMetaFromTarget(draft.target, extraBrands);
    if (!meta) {
      summary.skipped_unrecognized += 1;
      if (summary.unrecognized_examples.length < 20) summary.unrecognized_examples.push(String(draft.target).slice(0, 80));
      continue;
    }
    const title = String(draft.product_name || "").toUpperCase();
    if (!title.includes(meta.vehicle_brand.toUpperCase()) || !title.includes(meta.vehicle_model.toUpperCase())) {
      summary.skipped_title_mismatch += 1;
      continue;
    }
    summary.recoverable += 1;
    if (summary.sample_ids.length < 20) summary.sample_ids.push(draft.id);
    if (!apply) continue;
    const result = await mysqlExecute(`
      UPDATE listing_drafts
      SET vehicle_brand = ?, vehicle_model = ?, vehicle_model_key = ?, updated_at = updated_at
      WHERE id = ? AND COALESCE(tenant_id, 'admin') = ? AND status <> 'deleted' AND development_type = 'fission'
        AND vehicle_brand = ? AND vehicle_model = ? AND vehicle_model_key = ?
    `, [meta.vehicle_brand, meta.vehicle_model, meta.vehicle_model_key, draft.id, draft.tenant_id,
      draft.vehicle_brand, draft.vehicle_model, draft.vehicle_model_key]);
    summary.changed += Number(result.affectedRows || 0);
  }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await closeMysqlPool();
}
