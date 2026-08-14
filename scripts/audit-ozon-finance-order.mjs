#!/usr/bin/env node
import { closeMysqlPool, mysqlQuery } from "../src/mysql-pool.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) return process.argv[index + 1];
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function money(value) {
  const number = Number(value || 0);
  return Math.round((Number.isFinite(number) ? number : 0) * 100) / 100;
}

function dateKey(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value);
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  if (match) return match[0];
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text.slice(0, 10) : date.toISOString().slice(0, 10);
}

function parentPostingNumber(postingNumber = "") {
  return String(postingNumber || "").replace(/-[0-9]+$/, "");
}

function financeLineChineseLabel(row = {}) {
  const text = `${row.operation_type || ""} ${row.operation_type_name || ""} ${row.service_type || ""} ${row.service_name || ""}`.toLowerCase();
  if (text.includes("sale_commission")) return "Ozon 销售佣金";
  if (text.includes("acquiring")) return "收款/支付手续费";
  if (text.includes("agencyfeeaggregator") || text.includes("международ") || text.includes("транспорт")) return "国际运输/运输代理服务费";
  if (text.includes("deliveryservices") || text.includes("достав")) return "配送服务费";
  if (text.includes("deliveredtocustomer")) return "买家签收销售入账";
  if (text.includes("return") || text.includes("возврат")) return "退货/售后相关费用";
  return row.service_name || row.operation_type_name || row.operation_type || "Ozon 财务项";
}

function normalizeFinanceRows(rows = [], scope = "posting") {
  return rows.map((row) => ({
    scope,
    posting_number: row.posting_number,
    operation_date: dateKey(row.operation_date),
    chinese_label: financeLineChineseLabel(row),
    operation_type: row.operation_type || "",
    operation_type_name: row.operation_type_name || "",
    service_type: row.service_type || "",
    service_name: row.service_name || "",
    amount_rub: money(row.amount),
    amount_cny: money(row.amount_cny),
    accruals_for_sale_rub: money(row.accruals_for_sale),
    accruals_for_sale_cny: money(row.accruals_for_sale_cny)
  }));
}

function sumFeeCny(rows = []) {
  return money(rows.reduce((sum, row) => sum + (Number(row.amount_cny || 0) < 0 ? Math.abs(Number(row.amount_cny || 0)) : 0), 0));
}

function saleAccrualCny(rows = []) {
  return money(rows.reduce((max, row) => Math.max(max, Math.abs(Number(row.accruals_for_sale_cny || 0))), 0));
}

async function main() {
  const postingNumber = String(argValue("posting") || argValue("posting-number") || "").trim();
  if (!postingNumber) throw new Error("Missing --posting=POSTING_NUMBER");
  const orderRows = await mysqlQuery(`
    SELECT o.*, s.name AS shop_name
    FROM orders o
    LEFT JOIN shops s ON s.id = o.shop_id
    WHERE o.posting_number = ?
    LIMIT 1
  `, [postingNumber]);
  const order = orderRows[0];
  if (!order) throw new Error(`Order not found: ${postingNumber}`);

  const items = await mysqlQuery(`
    SELECT oi.id AS order_item_id, oi.ozon_sku, oi.ozon_name, oi.ozon_product_id, oi.quantity, oi.sale_price,
      oi.estimated_profit, oi.actual_profit, oi.settlement_state,
      opi.sale_amount_cny, opi.purchase_cost_cny, opi.domestic_shipping_cny, opi.international_shipping_cny,
      opi.packaging_cost_cny, opi.commission_fee_cny, opi.ozon_service_fee_cny, opi.return_loss_cny,
      opi.advertising_cost_cny, opi.other_fee_cny, opi.net_profit_cny, opi.profit_status, opi.is_locked
    FROM order_items oi
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE oi.order_id = ?
    ORDER BY oi.id
  `, [order.id]);

  const parentPosting = parentPostingNumber(order.posting_number);
  const directRows = await mysqlQuery(`
    SELECT *
    FROM ozon_finance_items
    WHERE shop_id = ? AND posting_number = ?
    ORDER BY operation_date, operation_id, service_type
  `, [order.shop_id, order.posting_number]);
  const parentRows = parentPosting && parentPosting !== order.posting_number
    ? await mysqlQuery(`
      SELECT *
      FROM ozon_finance_items
      WHERE shop_id = ?
        AND posting_number = ?
        AND (
          LOWER(COALESCE(operation_type, '')) LIKE '%acquiring%'
          OR LOWER(COALESCE(service_name, '')) LIKE '%acquiring%'
        )
      ORDER BY operation_date, operation_id, service_type
    `, [order.shop_id, parentPosting])
    : [];
  const siblingRows = parentPosting && parentPosting !== order.posting_number
    ? await mysqlQuery(`
      SELECT o.posting_number,
        COALESCE(MAX(CASE WHEN ABS(COALESCE(ofi.accruals_for_sale_cny, 0)) > 0 THEN ABS(ofi.accruals_for_sale_cny) ELSE 0 END), 0) AS sale_accrual_cny
      FROM orders o
      LEFT JOIN ozon_finance_items ofi ON ofi.shop_id = o.shop_id AND ofi.posting_number = o.posting_number
      WHERE o.shop_id = ? AND o.posting_number LIKE ?
      GROUP BY o.posting_number
      ORDER BY o.posting_number
    `, [order.shop_id, `${parentPosting}-%`])
    : [];

  const targetSale = saleAccrualCny(directRows);
  const siblingSaleTotal = money(siblingRows.reduce((sum, row) => sum + Math.abs(Number(row.sale_accrual_cny || 0)), 0));
  const parentFeeTotal = sumFeeCny(parentRows);
  const parentAllocationShare = siblingSaleTotal > 0 ? targetSale / siblingSaleTotal : (parentRows.length ? 1 : 0);
  const parentAllocatedFeeCny = money(parentFeeTotal * parentAllocationShare);
  const directFeeCny = sumFeeCny(directRows);
  const currentEstimatedProfit = money(items.reduce((sum, item) => sum + Number(item.estimated_profit || 0), 0));
  const currentActualProfit = money(items.reduce((sum, item) => sum + Number(item.actual_profit || 0), 0));
  const currentBreakdownProfit = money(items.reduce((sum, item) => sum + Number(item.net_profit_cny || 0), 0));

  const result = {
    posting_number: order.posting_number,
    parent_posting_number: parentPosting,
    shop_id: Number(order.shop_id),
    shop_name: order.shop_name || "",
    order_status: order.status || "",
    tracking_stage: order.tracking_stage || "",
    logistics_status: order.logistics_status || "",
    ordered_at: order.ordered_at || null,
    current_erp_profit: {
      estimated_profit_cny: currentEstimatedProfit,
      actual_profit_cny: currentActualProfit,
      breakdown_profit_cny: currentBreakdownProfit,
      settlement_states: [...new Set(items.map((item) => item.settlement_state || item.profit_status || "").filter(Boolean))]
    },
    ozon_finance_summary: {
      sale_accrual_cny: targetSale,
      direct_fee_cny: directFeeCny,
      parent_acquiring_fee_total_cny: parentFeeTotal,
      parent_allocation_share: money(parentAllocationShare),
      parent_allocated_fee_cny: parentAllocatedFeeCny,
      total_ozon_fee_cny: money(directFeeCny + parentAllocatedFeeCny),
      direct_rows: directRows.length,
      parent_acquiring_rows: parentRows.length,
      sibling_postings: siblingRows.map((row) => ({
        posting_number: row.posting_number,
        sale_accrual_cny: money(row.sale_accrual_cny)
      }))
    },
    erp_items: items.map((item) => ({
      order_item_id: Number(item.order_item_id),
      ozon_sku: item.ozon_sku || "",
      ozon_product_id: item.ozon_product_id || "",
      ozon_name: item.ozon_name || "",
      quantity: Number(item.quantity || 0),
      sale_price: money(item.sale_price),
      sale_amount_cny: money(item.sale_amount_cny),
      purchase_cost_cny: money(item.purchase_cost_cny),
      domestic_shipping_cny: money(item.domestic_shipping_cny),
      international_shipping_cny: money(item.international_shipping_cny),
      packaging_cost_cny: money(item.packaging_cost_cny),
      commission_fee_cny: money(item.commission_fee_cny),
      ozon_service_fee_cny: money(item.ozon_service_fee_cny),
      other_fee_cny: money(item.other_fee_cny),
      net_profit_cny: money(item.net_profit_cny),
      estimated_profit: money(item.estimated_profit),
      actual_profit: money(item.actual_profit),
      profit_status: item.profit_status || "",
      settlement_state: item.settlement_state || "",
      is_locked: Number(item.is_locked || 0)
    })),
    finance_lines: [
      ...normalizeFinanceRows(directRows, "子货件"),
      ...normalizeFinanceRows(parentRows, "父订单")
    ]
  };

  console.log(JSON.stringify(result, null, 2));
}

try {
  await main();
  await closeMysqlPool();
  process.exit(0);
} catch (error) {
  await closeMysqlPool().catch(() => {});
  console.error(error?.stack || error?.message || error);
  process.exit(1);
}
