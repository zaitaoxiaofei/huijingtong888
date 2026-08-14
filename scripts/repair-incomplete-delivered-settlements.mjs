#!/usr/bin/env node
import { closeMysqlPool, mysqlExecute, mysqlQuery } from "../src/mysql-pool.js";
import { refreshOrderProfitDetailSnapshotsMysql } from "../src/services/mysql-cutover.js";

const write = process.argv.includes("--write");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = Math.min(Math.max(Number(limitArg?.slice(8) || 5000), 1), 10000);

const rows = await mysqlQuery(`
  SELECT o.id AS order_id, o.posting_number, oi.id AS order_item_id,
    COALESCE(opi.purchase_cost_cny, 0) AS purchase_cost_cny,
    COALESCE(opi.international_shipping_cny, 0) AS international_shipping_cny,
    COALESCE(child_fin.net_commission_cny, 0) AS net_commission_cny,
    COALESCE(parent_fin.net_collecting_cny, 0) AS net_collecting_cny
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  JOIN order_profit_items opi ON opi.order_item_id = oi.id
  LEFT JOIN (
    SELECT shop_id, posting_number,
      GREATEST(0, -SUM(CASE
        WHEN LOWER(CONCAT_WS(' ', service_type, service_name, operation_type, operation_type_name)) LIKE '%commission%'
        THEN amount_cny ELSE 0 END
      )) AS net_commission_cny
    FROM ozon_finance_items
    GROUP BY shop_id, posting_number
  ) child_fin ON child_fin.shop_id = o.shop_id AND child_fin.posting_number = o.posting_number
  LEFT JOIN (
    SELECT shop_id, posting_number,
      GREATEST(0, -SUM(CASE
        WHEN LOWER(CONCAT_WS(' ', service_type, service_name, operation_type, operation_type_name)) LIKE '%acquiring%'
        THEN amount_cny ELSE 0 END
      )) AS net_collecting_cny
    FROM ozon_finance_items
    GROUP BY shop_id, posting_number
  ) parent_fin ON parent_fin.shop_id = o.shop_id
    AND parent_fin.posting_number = COALESCE(NULLIF(o.order_number, ''), REGEXP_REPLACE(o.posting_number, '-[0-9]+$', ''))
  WHERE (opi.profit_status = 'accrued' OR oi.settlement_state = 'accrued')
    AND (
      LOWER(COALESCE(o.status, '')) = 'delivered'
      OR LOWER(COALESCE(o.tracking_stage, '')) = 'posting_received'
      OR LOWER(COALESCE(o.logistics_status, '')) = 'delivered'
    )
    AND (
      COALESCE(opi.purchase_cost_cny, 0) <= 0.005
      OR COALESCE(opi.international_shipping_cny, 0) <= 0.005
      OR COALESCE(child_fin.net_commission_cny, 0) <= 0.005
      OR COALESCE(parent_fin.net_collecting_cny, 0) <= 0.005
    )
  ORDER BY o.ordered_at, oi.id
  LIMIT ?
`, [limit]);

const reasonCounts = rows.reduce((acc, row) => {
  if (Number(row.purchase_cost_cny || 0) <= 0.005) acc.missing_purchase_cost += 1;
  if (Number(row.international_shipping_cny || 0) <= 0.005) acc.missing_international_shipping += 1;
  if (Number(row.net_commission_cny || 0) <= 0.005) acc.missing_net_commission += 1;
  if (Number(row.net_collecting_cny || 0) <= 0.005) acc.missing_net_collecting += 1;
  return acc;
}, { missing_purchase_cost: 0, missing_international_shipping: 0, missing_net_commission: 0, missing_net_collecting: 0 });

if (write && rows.length) {
  const itemIds = rows.map((row) => Number(row.order_item_id));
  const orderIds = [...new Set(rows.map((row) => Number(row.order_id)))];
  for (let offset = 0; offset < itemIds.length; offset += 500) {
    const ids = itemIds.slice(offset, offset + 500);
    const placeholders = ids.map(() => "?").join(",");
    await mysqlExecute(`UPDATE order_items SET actual_profit = 0, platform_fee_actual = 0, settlement_state = 'pending' WHERE id IN (${placeholders})`, ids);
    await mysqlExecute(`UPDATE order_profit_items SET profit_status = 'estimated', is_locked = 0, lock_reason = 'incomplete_finance_basis', updated_at = CURRENT_TIMESTAMP WHERE order_item_id IN (${placeholders})`, ids);
  }
  await refreshOrderProfitDetailSnapshotsMysql({ order_ids: orderIds, final_only: 0, limit: orderIds.length });
}

console.log(JSON.stringify({
  ok: true,
  mode: write ? "write" : "dry_run",
  matched_items: rows.length,
  matched_orders: new Set(rows.map((row) => Number(row.order_id))).size,
  reasons: reasonCounts,
  sample: rows.slice(0, 50)
}, null, 2));

await closeMysqlPool();
