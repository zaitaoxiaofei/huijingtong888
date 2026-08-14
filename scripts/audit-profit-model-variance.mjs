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

function pct(value) {
  const number = Number(value || 0);
  return Math.round((Number.isFinite(number) ? number : 0) * 10000) / 10000;
}

function dominantDriver(row) {
  const entries = [
    ["sale", Math.abs(row.sale_impact_cny)],
    ["purchase", Math.abs(row.purchase_impact_cny)],
    ["international_shipping", Math.abs(row.international_shipping_impact_cny)],
    ["commission", Math.abs(row.commission_impact_cny)],
    ["parent_acquiring", Math.abs(row.parent_acquiring_impact_cny)],
    ["other", Math.abs(row.unexplained_cny)]
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] || "other";
}

async function main() {
  const from = String(argValue("from", "2026-05-18")).slice(0, 10);
  const to = String(argValue("to", "2026-06-14")).slice(0, 10);
  const threshold = Math.max(Number(argValue("threshold", "10")), 0);
  const limit = Math.min(Math.max(Number(argValue("limit", "50")), 1), 5000);

  const rows = await mysqlQuery(`
    SELECT * FROM (
      SELECT o.id AS order_id, o.posting_number, s.name AS shop_name,
        SUM(COALESCE(oi.estimated_profit, 0)) AS estimated_profit,
        SUM(COALESCE(oi.actual_profit, 0)) AS actual_profit,
        SUM(COALESCE(oi.sale_price * oi.quantity, 0)) AS local_sale,
        SUM(COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0)) AS ozon_sale,
        SUM(COALESCE(oi.frozen_purchase_cost * oi.quantity, 0)) AS frozen_purchase,
        SUM(COALESCE(opi.purchase_cost_cny, 0)) AS purchase_cost,
        SUM(COALESCE(oi.frozen_international_shipping * oi.quantity, 0)) AS estimated_international_shipping,
        SUM(COALESCE(opi.international_shipping_cny, 0)) AS actual_international_shipping,
        SUM(COALESCE(oi.estimated_commission, 0)) AS estimated_commission,
        SUM(COALESCE(opi.commission_fee_cny, 0)) AS actual_commission,
        SUM(COALESCE(opi.other_fee_cny, 0)) AS parent_acquiring_fee,
        COUNT(*) AS item_count
      FROM orders o
      JOIN shops s ON s.id = o.shop_id
      JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
      WHERE DATE(CONVERT_TZ(o.ordered_at, '+00:00', '+08:00')) BETWEEN ? AND ?
        AND COALESCE(opi.profit_status, oi.settlement_state) = 'accrued'
        AND EXISTS (
          SELECT 1
          FROM ozon_finance_items ofi
          WHERE ofi.shop_id = o.shop_id AND ofi.posting_number = o.posting_number
        )
      GROUP BY o.id, o.posting_number, s.name
    ) x
    ORDER BY ABS(actual_profit - estimated_profit) DESC
  `, [from, to]);

  const enriched = rows.map((row) => {
    const estimatedProfit = Number(row.estimated_profit || 0);
    const actualProfit = Number(row.actual_profit || 0);
    const diff = actualProfit - estimatedProfit;
    const saleImpact = Number(row.ozon_sale || 0) - Number(row.local_sale || 0);
    const purchaseImpact = -(Number(row.purchase_cost || 0) - Number(row.frozen_purchase || 0));
    const internationalShippingImpact = -(Number(row.actual_international_shipping || 0) - Number(row.estimated_international_shipping || 0));
    const commissionImpact = -(Number(row.actual_commission || 0) - Number(row.estimated_commission || 0));
    const parentAcquiringImpact = -Number(row.parent_acquiring_fee || 0);
    const unexplained = diff - saleImpact - purchaseImpact - internationalShippingImpact - commissionImpact - parentAcquiringImpact;
    const result = {
      order_id: Number(row.order_id),
      posting_number: row.posting_number,
      shop_name: row.shop_name || "",
      item_count: Number(row.item_count || 0),
      estimated_profit_cny: money(estimatedProfit),
      actual_profit_cny: money(actualProfit),
      diff_cny: money(diff),
      abs_diff_cny: money(Math.abs(diff)),
      local_sale_cny: money(row.local_sale),
      ozon_sale_cny: money(row.ozon_sale),
      sale_impact_cny: money(saleImpact),
      estimated_international_shipping_cny: money(row.estimated_international_shipping),
      actual_international_shipping_cny: money(row.actual_international_shipping),
      international_shipping_impact_cny: money(internationalShippingImpact),
      estimated_commission_cny: money(row.estimated_commission),
      actual_commission_cny: money(row.actual_commission),
      commission_impact_cny: money(commissionImpact),
      parent_acquiring_impact_cny: money(parentAcquiringImpact),
      purchase_impact_cny: money(purchaseImpact),
      unexplained_cny: money(unexplained)
    };
    result.dominant_driver = dominantDriver(result);
    return result;
  });

  const selected = enriched.filter((row) => row.abs_diff_cny > threshold);
  const total = enriched.reduce((acc, row) => {
    acc.estimated_profit_cny += row.estimated_profit_cny;
    acc.actual_profit_cny += row.actual_profit_cny;
    acc.sale_cny += row.ozon_sale_cny;
    acc.abs_diff_cny += row.abs_diff_cny;
    return acc;
  }, { estimated_profit_cny: 0, actual_profit_cny: 0, sale_cny: 0, abs_diff_cny: 0 });
  const selectedTotals = selected.reduce((acc, row) => {
    for (const key of ["diff_cny", "sale_impact_cny", "purchase_impact_cny", "international_shipping_impact_cny", "commission_impact_cny", "parent_acquiring_impact_cny", "unexplained_cny"]) {
      acc[key] += Number(row[key] || 0);
    }
    acc.by_driver[row.dominant_driver] = Number(acc.by_driver[row.dominant_driver] || 0) + 1;
    return acc;
  }, {
    diff_cny: 0,
    sale_impact_cny: 0,
    purchase_impact_cny: 0,
    international_shipping_impact_cny: 0,
    commission_impact_cny: 0,
    parent_acquiring_impact_cny: 0,
    unexplained_cny: 0,
    by_driver: {}
  });

  const payload = {
    ok: true,
    from,
    to,
    threshold_cny: threshold,
    orders: enriched.length,
    outlier_orders: selected.length,
    estimated_profit_cny: money(total.estimated_profit_cny),
    actual_profit_cny: money(total.actual_profit_cny),
    total_diff_cny: money(total.actual_profit_cny - total.estimated_profit_cny),
    sale_cny: money(total.sale_cny),
    estimated_margin: pct(total.sale_cny ? total.estimated_profit_cny / total.sale_cny : 0),
    actual_margin: pct(total.sale_cny ? total.actual_profit_cny / total.sale_cny : 0),
    average_abs_diff_cny: money(total.abs_diff_cny / Math.max(enriched.length, 1)),
    outlier_totals: {
      diff_cny: money(selectedTotals.diff_cny),
      sale_impact_cny: money(selectedTotals.sale_impact_cny),
      purchase_impact_cny: money(selectedTotals.purchase_impact_cny),
      international_shipping_impact_cny: money(selectedTotals.international_shipping_impact_cny),
      commission_impact_cny: money(selectedTotals.commission_impact_cny),
      parent_acquiring_impact_cny: money(selectedTotals.parent_acquiring_impact_cny),
      unexplained_cny: money(selectedTotals.unexplained_cny),
      by_driver: selectedTotals.by_driver
    },
    rows: selected.slice(0, limit)
  };

  console.log(JSON.stringify(payload, null, 2));
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
