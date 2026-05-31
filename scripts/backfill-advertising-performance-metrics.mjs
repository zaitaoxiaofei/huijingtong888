import { mysqlExecute, mysqlQuery, closeMysqlPool } from "../src/mysql-pool.js";

const RUB_CNY_RATE = 11.3;

function toNumber(value, fallback = 0) {
  const number = Number(String(value ?? "").replace(",", ".").replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : fallback;
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      const nested = firstNumber(...value);
      if (nested) return nested;
      continue;
    }
    if (typeof value === "object") {
      for (const key of ["value", "amount", "sum", "count", "total"]) {
        const nested = firstNumber(value[key]);
        if (nested) return nested;
      }
      continue;
    }
    const number = toNumber(value, Number.NaN);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function parseRawJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function attributedRevenueRub(row = {}) {
  const hasPerformanceRevenueFields = [
    "ordersMoney",
    "orders_money",
    "orderMoney",
    "order_money",
    "modelsMoney",
    "models_money",
    "modelMoney",
    "model_money"
  ].some((key) => Object.prototype.hasOwnProperty.call(row, key));
  const direct = firstNumber(row.ordersMoney, row.orders_money, row.orderMoney, row.order_money);
  const assisted = firstNumber(row.modelsMoney, row.models_money, row.modelMoney, row.model_money);
  if (hasPerformanceRevenueFields) return direct + assisted;
  return firstNumber(row.revenue, row.sales, row.attributedRevenue, row.money_income, row.orderRevenue);
}

function attributedUnits(row = {}) {
  const direct = firstNumber(row.orders, row.orders_count, row.ordersCount);
  const assisted = firstNumber(row.models, row.models_count, row.modelsCount);
  const explicit = firstNumber(row.units, row.quantity, row.qty);
  return Math.round(explicit || direct + assisted || direct);
}

let scanned = 0;
let updated = 0;
let offsetId = 0;

try {
  while (true) {
    const rows = await mysqlQuery(`
      SELECT date_key, shop_id, ozon_sku, campaign_id, ad_type, spend_rub, spend_cny, orders, units, revenue_rub, revenue_cny, raw_json
      FROM ozon_ad_sku_daily
      WHERE raw_json IS NOT NULL
        AND raw_json <> ''
        AND CONCAT(date_key, '#', shop_id, '#', ozon_sku, '#', campaign_id, '#', ad_type) > ?
      ORDER BY date_key, shop_id, ozon_sku, campaign_id, ad_type
      LIMIT 500
    `, [String(offsetId)]);
    if (!rows.length) break;

    for (const row of rows) {
      const raw = parseRawJson(row.raw_json);
      const cursor = `${row.date_key}#${row.shop_id}#${row.ozon_sku}#${row.campaign_id}#${row.ad_type}`;
      offsetId = cursor;
      scanned += 1;
      if (!raw) continue;

      const spendRub = firstNumber(raw.moneySpent, raw.expense, raw.spend, raw.spend_rub, raw.cost, raw.consumption) || Number(row.spend_rub || 0);
      const revenueRub = attributedRevenueRub(raw);
      const units = attributedUnits(raw);
      const spendCny = roundMoney(spendRub / RUB_CNY_RATE);
      const revenueCny = roundMoney(revenueRub / RUB_CNY_RATE);

      if (
        Number(row.units || 0) === units
        && Number(row.revenue_rub || 0) === revenueRub
        && Number(row.spend_cny || 0) === spendCny
        && Number(row.revenue_cny || 0) === revenueCny
      ) {
        continue;
      }

      await mysqlExecute(`
        UPDATE ozon_ad_sku_daily
        SET units = ?,
            revenue_rub = ?,
            revenue_cny = ?,
            spend_cny = ?,
            updated_at = NOW()
        WHERE date_key = ?
          AND shop_id = ?
          AND ozon_sku = ?
          AND campaign_id = ?
          AND ad_type = ?
      `, [
        units,
        revenueRub,
        revenueCny,
        spendCny,
        row.date_key,
        Number(row.shop_id),
        String(row.ozon_sku),
        String(row.campaign_id),
        String(row.ad_type)
      ]);
      updated += 1;
    }
  }

  console.log(JSON.stringify({ scanned, updated }, null, 2));
} finally {
  await closeMysqlPool();
}
