#!/usr/bin/env node
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";
import { exceptionWorkbenchMysql, pendingSettlementCostsMysql } from "../src/services/mysql-cutover.js";

try {
  const [coverage] = await mysqlQuery(`
    SELECT COUNT(DISTINCT o.id) AS total_orders, COUNT(oi.id) AS total_items,
      MIN(DATE(o.ordered_at)) AS first_order_date, MAX(DATE(o.ordered_at)) AS last_order_date,
      COUNT(DISTINCT CASE WHEN COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued' THEN o.id END) AS accrued_orders,
      COUNT(DISTINCT CASE WHEN COALESCE(opi.profit_status, oi.settlement_state, '') != 'accrued' THEN o.id END) AS not_accrued_orders,
      COUNT(DISTINCT CASE WHEN (LOWER(COALESCE(o.status, '')) = 'delivered' OR LOWER(COALESCE(o.tracking_stage, '')) = 'posting_received' OR LOWER(COALESCE(o.logistics_status, '')) = 'delivered') AND COALESCE(opi.profit_status, oi.settlement_state, '') != 'accrued' THEN o.id END) AS delivered_not_accrued_orders,
      COUNT(DISTINCT CASE WHEN COALESCE(sm.id, fallback_sm.id) IS NULL THEN o.id END) AS unbound_orders,
      COUNT(DISTINCT CASE WHEN (LOWER(COALESCE(o.status, '')) = 'delivered' OR LOWER(COALESCE(o.tracking_stage, '')) = 'posting_received' OR LOWER(COALESCE(o.logistics_status, '')) = 'delivered') AND COALESCE(sm.id, fallback_sm.id) IS NULL THEN o.id END) AS delivered_unbound_orders
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id AND sm.active = 1
    LEFT JOIN sku_mappings fallback_sm ON sm.id IS NULL AND fallback_sm.shop_id = o.shop_id AND fallback_sm.ozon_sku = oi.ozon_sku AND fallback_sm.active = 1
  `);
  const monthly = await mysqlQuery(`
    SELECT DATE_FORMAT(o.ordered_at, '%Y-%m') AS month,
      COUNT(DISTINCT o.id) AS orders,
      COUNT(DISTINCT CASE WHEN COALESCE(opi.profit_status, oi.settlement_state, '') != 'accrued' THEN o.id END) AS not_accrued,
      COUNT(DISTINCT CASE WHEN (LOWER(COALESCE(o.status, '')) = 'delivered' OR LOWER(COALESCE(o.tracking_stage, '')) = 'posting_received' OR LOWER(COALESCE(o.logistics_status, '')) = 'delivered') AND COALESCE(opi.profit_status, oi.settlement_state, '') != 'accrued' THEN o.id END) AS delivered_not_accrued
    FROM orders o JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    GROUP BY month ORDER BY month
  `);
  const settlementBreakdown = await mysqlQuery(`
    WITH order_health AS (
      SELECT o.id, o.posting_number, DATE(o.ordered_at) AS order_date,
        MAX(LOWER(COALESCE(o.status, '')) = 'delivered' OR LOWER(COALESCE(o.tracking_stage, '')) = 'posting_received' OR LOWER(COALESCE(o.logistics_status, '')) = 'delivered') AS delivered,
        MIN(COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued') AS fully_accrued,
        MAX(COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued') AS partly_accrued,
        MAX(opi.order_item_id IS NULL) AS missing_profit_row,
        MAX(COALESCE(sm.id, fallback_sm.id) IS NULL) AS missing_binding,
        MAX(COALESCE(opi.purchase_cost_cny, 0) <= 0.005 AND COALESCE(oi.frozen_purchase_cost, 0) * GREATEST(COALESCE(oi.quantity, 1), 1) <= 0.005) AS missing_purchase,
        MAX(NOT EXISTS (SELECT 1 FROM ozon_finance_items sf WHERE sf.shop_id = o.shop_id AND sf.posting_number = o.posting_number AND ABS(COALESCE(sf.accruals_for_sale_cny, 0)) > 0.005)) AS missing_sale_finance,
        MAX(NOT EXISTS (SELECT 1 FROM ozon_finance_items cf WHERE cf.shop_id = o.shop_id AND cf.posting_number = o.posting_number AND (cf.service_type = 'sale_commission' OR LOWER(CONCAT_WS(' ', cf.operation_type, cf.operation_type_name, cf.service_type, cf.service_name)) LIKE '%commission%'))) AS missing_commission,
        MAX(NOT EXISTS (SELECT 1 FROM ozon_finance_items df WHERE df.shop_id = o.shop_id AND df.posting_number = o.posting_number AND (LOWER(CONCAT_WS(' ', df.operation_type, df.operation_type_name, df.service_type, df.service_name)) LIKE '%delivery%' OR LOWER(CONCAT_WS(' ', df.operation_type, df.operation_type_name, df.service_type, df.service_name)) LIKE '%достав%' OR LOWER(CONCAT_WS(' ', df.operation_type, df.operation_type_name, df.service_type, df.service_name)) LIKE '%транспорт%'))) AS missing_delivery,
        MAX(NOT EXISTS (SELECT 1 FROM ozon_finance_items af WHERE af.shop_id = o.shop_id AND af.posting_number = COALESCE(NULLIF(o.order_number, ''), REGEXP_REPLACE(o.posting_number, '-[0-9]+$', '')) AND (LOWER(CONCAT_WS(' ', af.operation_type, af.operation_type_name, af.service_type, af.service_name)) LIKE '%acquiring%' OR LOWER(CONCAT_WS(' ', af.operation_type, af.operation_type_name, af.service_type, af.service_name)) LIKE '%marketplaceredistributionofacquiringoperation%'))) AS missing_collecting
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
      LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id AND sm.active = 1
      LEFT JOIN sku_mappings fallback_sm ON sm.id IS NULL AND fallback_sm.shop_id = o.shop_id AND fallback_sm.ozon_sku = oi.ozon_sku AND fallback_sm.active = 1
      GROUP BY o.id, o.posting_number, o.ordered_at
    )
    SELECT
      COUNT(*) AS total_orders,
      SUM(fully_accrued = 1) AS fully_accrued_orders,
      SUM(fully_accrued = 0) AS not_fully_accrued_orders,
      SUM(delivered = 1 AND fully_accrued = 0) AS delivered_not_fully_accrued,
      SUM(delivered = 1 AND fully_accrued = 0 AND order_date <= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)) AS stale_delivered_not_accrued,
      SUM(delivered = 1 AND fully_accrued = 0 AND missing_binding = 1) AS missing_binding,
      SUM(delivered = 1 AND fully_accrued = 0 AND missing_profit_row = 1) AS missing_profit_row,
      SUM(delivered = 1 AND fully_accrued = 0 AND missing_purchase = 1) AS missing_purchase,
      SUM(delivered = 1 AND fully_accrued = 0 AND missing_sale_finance = 1) AS missing_sale_finance,
      SUM(delivered = 1 AND fully_accrued = 0 AND missing_commission = 1) AS missing_commission,
      SUM(delivered = 1 AND fully_accrued = 0 AND missing_delivery = 1) AS missing_delivery,
      SUM(delivered = 1 AND fully_accrued = 0 AND missing_collecting = 1) AS missing_collecting
    FROM order_health
  `);
  const pending = await pendingSettlementCostsMysql({ page: 1, pageSize: 200 });
  const views = {};
  for (const view of ["profit", "binding", "stock", "deadline", "deadline_warning"]) {
    const result = await exceptionWorkbenchMysql({ view, refresh: "1", page: 1, pageSize: 1 });
    views[view] = { total: result.total, counts: result.counts };
  }
  console.log(JSON.stringify({ coverage, settlement_breakdown: settlementBreakdown[0], monthly, pending: { total_groups: pending.total, item_total: pending.itemTotal, summary: pending.summary }, exception_views: views }, null, 2));
} finally {
  await closeMysqlPool();
}
