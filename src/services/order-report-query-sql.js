// Keep the monetary/outcome expressions in mysql-cutover unchanged. Counts only
// need group identities; logistics aggregation only needs order IDs and names.
export function profitRankingGroupCountSql({ groupFields, joinSql, orderScope, dateWhereSql, whereSql }) {
  return `SELECT COUNT(*) AS total FROM (
    SELECT ${groupFields}
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    ${joinSql}
    WHERE ${orderScope} ${dateWhereSql} ${whereSql}
    GROUP BY ${groupFields}
  ) ranking_groups`;
}

// The primary-key GROUP BY materializes the small scope once in MySQL 8.0.
// Neither pass needs to group or duplicate the large raw JSON payload.
export function orderLogisticsSummarySql(where, billingScopeSql) {
  return `WITH summary_orders AS (
      SELECT o.id, o.shop_id, o.posting_number, o.tracking_number
      FROM orders o WHERE ${where}
      GROUP BY o.id
    )
    SELECT o.id, o.posting_number, o.tracking_number, raw.raw_json,
      billing.billing_logistics_rule_name
    FROM summary_orders o
    LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
    LEFT JOIN (
      SELECT summary_item.order_id,
        GROUP_CONCAT(DISTINCT summary_rule.name ORDER BY summary_rule.name SEPARATOR ' / ') AS billing_logistics_rule_name
      FROM summary_orders selected_order
      JOIN order_items summary_item ON summary_item.order_id = selected_order.id
      JOIN logistics_fee_rules summary_rule ON summary_rule.id = summary_item.frozen_logistics_rule_id AND ${billingScopeSql}
      GROUP BY summary_item.order_id
    ) billing ON billing.order_id = o.id`;
}
