import { classifyOrderLogistics } from "./order-logistics-classification.js";

export function orderLogisticsCarrierCandidateSql(carrier) {
  if (carrier !== "ogl") return "";
  const fields = ["delivery_method.name", "delivery_method.warehouse", "delivery_method.tpl_provider",
    "analytics_data.warehouse", "analytics_data.tpl_provider", "warehouse_name", "tpl_provider"];
  const paths = [".raw", ""].flatMap((prefix) => fields.map((field) => `'$${prefix}.${field}'`));
  // This is only a superset: source-layer precedence, ASCII token boundaries
  // and field types are still checked by the classifier against the full raw.
  // One multi-path extraction avoids repeatedly parsing a LONGTEXT document.
  return `LOWER(JSON_EXTRACT(CASE WHEN JSON_VALID(raw.raw_json) THEN raw.raw_json ELSE '{}' END,
    ${paths.join(", ")})) LIKE '%ogl%'`;
}

export function orderLogisticsCarrierSummaryRows(rows = [], carrier = "all") {
  return rows.map((row) => ({ id: Number(row.id), logistics_carrier: classifyOrderLogistics(row).logistics_carrier }))
    .filter((row) => carrier === "all" || row.logistics_carrier === carrier);
}
