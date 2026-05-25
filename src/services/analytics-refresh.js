function executeStatement(deps, sql, params = []) {
  if (typeof deps.execute === "function") {
    return deps.execute(sql, params);
  }
  return deps.db.prepare(sql).run(...params);
}

function querySingle(deps, sql, params = []) {
  if (typeof deps.queryOne === "function") {
    return deps.queryOne(sql, params);
  }
  return deps.get ? deps.get(sql, params) : deps.db.prepare(sql).get(...params);
}

export function refreshProfitAnalyticsSnapshots(deps, { from = "", to = "" } = {}) {
  const rangeFrom = from || "2000-01-01";
  const rangeTo = to || "9999-12-31";
  const outcome = deps.buildOrderOutcomeSql("o");
  executeStatement(deps, "DELETE FROM analytics_shop_daily WHERE date_key >= ? AND date_key <= ?", [rangeFrom, rangeTo]);
  executeStatement(deps, "DELETE FROM analytics_product_profit_daily WHERE date_key >= ? AND date_key <= ?", [rangeFrom, rangeTo]);
  executeStatement(deps, "DELETE FROM analytics_sku_profit_daily WHERE date_key >= ? AND date_key <= ?", [rangeFrom, rangeTo]);

  executeStatement(deps, `
    INSERT INTO analytics_shop_daily (
      date_key, shop_id, order_count, item_quantity, revenue, estimated_profit, confirmed_profit, current_profit,
      cancelled_orders, cancelled_revenue, return_orders, return_quantity, return_revenue, return_loss, refreshed_at
    )
    SELECT
      ${deps.chinaDateSql("o.ordered_at")} AS date_key,
      o.shop_id,
      COUNT(DISTINCT CASE WHEN ${outcome.effectiveSale} THEN o.id END) AS order_count,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN oi.quantity ELSE 0 END), 0) AS item_quantity,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) ELSE 0 END), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} AND COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE 0 END), 0) AS confirmed_profit,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN CASE WHEN COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) END ELSE 0 END), 0) AS current_profit,
      COUNT(DISTINCT CASE WHEN ${outcome.cancelledPreFulfillment} THEN o.id END) AS cancelled_orders,
      COALESCE(SUM(CASE WHEN ${outcome.cancelledPreFulfillment} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS cancelled_revenue,
      COUNT(DISTINCT CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN o.id END) AS return_orders,
      COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN oi.quantity ELSE 0 END), 0) AS return_quantity,
      COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS return_revenue,
      COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN COALESCE(opi.return_loss_cny, oi.aftersale_loss, 0) ELSE 0 END), 0) AS return_loss,
      CURRENT_TIMESTAMP
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE ${deps.chinaDateSql("o.ordered_at")} >= ?
      AND ${deps.chinaDateSql("o.ordered_at")} <= ?
    GROUP BY ${deps.chinaDateSql("o.ordered_at")}, o.shop_id
  `, [rangeFrom, rangeTo]);

  executeStatement(deps, `
    INSERT INTO analytics_product_profit_daily (
      date_key, product_id, shop_id, order_count, item_quantity, revenue, estimated_profit, confirmed_profit, current_profit, refreshed_at
    )
    SELECT
      ${deps.chinaDateSql("o.ordered_at")} AS date_key,
      sm.product_id,
      o.shop_id,
      COUNT(DISTINCT CASE WHEN ${outcome.effectiveSale} THEN o.id END) AS order_count,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN oi.quantity ELSE 0 END), 0) AS item_quantity,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) ELSE 0 END), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} AND COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE 0 END), 0) AS confirmed_profit,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN CASE WHEN COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) END ELSE 0 END), 0) AS current_profit,
      CURRENT_TIMESTAMP
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id AND sm.active = 1
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE ${deps.chinaDateSql("o.ordered_at")} >= ?
      AND ${deps.chinaDateSql("o.ordered_at")} <= ?
    GROUP BY ${deps.chinaDateSql("o.ordered_at")}, sm.product_id, o.shop_id
  `, [rangeFrom, rangeTo]);

  executeStatement(deps, `
    INSERT INTO analytics_sku_profit_daily (
      date_key, shop_id, ozon_sku, product_id, order_count, item_quantity, revenue, estimated_profit, confirmed_profit, current_profit,
      cancelled_orders, cancelled_quantity, cancelled_revenue, return_orders, return_quantity, return_revenue, return_loss, refreshed_at
    )
    SELECT
      ${deps.chinaDateSql("o.ordered_at")} AS date_key,
      o.shop_id,
      oi.ozon_sku,
      sm.product_id,
      COUNT(DISTINCT CASE WHEN ${outcome.effectiveSale} THEN o.id END) AS order_count,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN oi.quantity ELSE 0 END), 0) AS item_quantity,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) ELSE 0 END), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} AND COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE 0 END), 0) AS confirmed_profit,
      COALESCE(SUM(CASE WHEN ${outcome.effectiveSale} THEN CASE WHEN COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) END ELSE 0 END), 0) AS current_profit,
      COUNT(DISTINCT CASE WHEN ${outcome.cancelledPreFulfillment} THEN o.id END) AS cancelled_orders,
      COALESCE(SUM(CASE WHEN ${outcome.cancelledPreFulfillment} THEN oi.quantity ELSE 0 END), 0) AS cancelled_quantity,
      COALESCE(SUM(CASE WHEN ${outcome.cancelledPreFulfillment} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS cancelled_revenue,
      COUNT(DISTINCT CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN o.id END) AS return_orders,
      COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN oi.quantity ELSE 0 END), 0) AS return_quantity,
      COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS return_revenue,
      COALESCE(SUM(CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN COALESCE(opi.return_loss_cny, oi.aftersale_loss, 0) ELSE 0 END), 0) AS return_loss,
      CURRENT_TIMESTAMP
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id AND sm.active = 1
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE ${deps.chinaDateSql("o.ordered_at")} >= ?
      AND ${deps.chinaDateSql("o.ordered_at")} <= ?
    GROUP BY ${deps.chinaDateSql("o.ordered_at")}, o.shop_id, oi.ozon_sku
  `, [rangeFrom, rangeTo]);

  return {
    ok: true,
    from: rangeFrom,
    to: rangeTo,
    shop_rows: querySingle(deps, "SELECT COUNT(*) AS count FROM analytics_shop_daily WHERE date_key >= ? AND date_key <= ?", [rangeFrom, rangeTo])?.count || 0,
    product_rows: querySingle(deps, "SELECT COUNT(*) AS count FROM analytics_product_profit_daily WHERE date_key >= ? AND date_key <= ?", [rangeFrom, rangeTo])?.count || 0,
    sku_rows: querySingle(deps, "SELECT COUNT(*) AS count FROM analytics_sku_profit_daily WHERE date_key >= ? AND date_key <= ?", [rangeFrom, rangeTo])?.count || 0
  };
}
