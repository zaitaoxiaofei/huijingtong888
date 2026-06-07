import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { logScheduledJobEvent } from "./scheduled-jobs.js";
import { estimateItemProfit } from "../profit.js";

const AD_DAILY_SCHEMA = `
CREATE TABLE IF NOT EXISTS ozon_ad_sku_daily (
  date_key VARCHAR(32) NOT NULL,
  shop_id BIGINT UNSIGNED NOT NULL,
  ozon_sku VARCHAR(128) NOT NULL,
  campaign_id VARCHAR(128) NOT NULL DEFAULT '',
  campaign_name VARCHAR(255) NULL,
  campaign_state VARCHAR(64) NULL,
  campaign_budget_rub DECIMAL(18,4) NOT NULL DEFAULT 0,
  campaign_strategy VARCHAR(128) NULL,
  campaign_payment_type VARCHAR(64) NULL,
  campaign_placement VARCHAR(255) NULL,
  campaign_bid_rub DECIMAL(18,4) NOT NULL DEFAULT 0,
  campaign_target_cir DECIMAL(10,4) NOT NULL DEFAULT 0,
  ad_type VARCHAR(64) NOT NULL DEFAULT 'unknown',
  product_id BIGINT UNSIGNED NULL,
  offer_id VARCHAR(255) NULL,
  product_name VARCHAR(255) NULL,
  spend_rub DECIMAL(18,4) NOT NULL DEFAULT 0,
  spend_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  impressions INT NOT NULL DEFAULT 0,
  clicks INT NOT NULL DEFAULT 0,
  add_to_cart INT NOT NULL DEFAULT 0,
  add_to_cart_available TINYINT(1) NOT NULL DEFAULT 0,
  orders INT NOT NULL DEFAULT 0,
  units INT NOT NULL DEFAULT 0,
  revenue_rub DECIMAL(18,4) NOT NULL DEFAULT 0,
  revenue_cny DECIMAL(18,4) NOT NULL DEFAULT 0,
  source VARCHAR(64) NOT NULL DEFAULT 'manual',
  raw_json LONGTEXT NULL,
  synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (date_key, shop_id, ozon_sku, campaign_id, ad_type),
  KEY idx_ozon_ad_sku_daily_shop_date (shop_id, date_key),
  KEY idx_ozon_ad_sku_daily_sku_date (shop_id, ozon_sku, date_key),
  KEY idx_ozon_ad_sku_daily_product (product_id, date_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
`;

let schemaReady = false;
const PERFORMANCE_API_BASE = "https://api-performance.ozon.ru";
const PERFORMANCE_TIMEOUT_MS = 60000;
const FORBIDDEN_CAMPAIGN_RETRY_HOURS = 12;
const RUB_CNY_RATE = 11.3;
const DEFAULT_PACKAGING_FEE_RULE = {
  low_sale_threshold_cny: 50,
  low_fee_cny: 0.5,
  high_fee_cny: 1
};

async function ensureAdDailySchema() {
  if (schemaReady) return;
  await mysqlExecute(AD_DAILY_SCHEMA);
  await mysqlExecute("ALTER TABLE ozon_ad_sku_daily ADD COLUMN campaign_state VARCHAR(64) NULL AFTER campaign_name").catch(ignoreDuplicateColumn);
  await mysqlExecute("ALTER TABLE ozon_ad_sku_daily ADD COLUMN campaign_budget_rub DECIMAL(18,4) NOT NULL DEFAULT 0 AFTER campaign_state").catch(ignoreDuplicateColumn);
  await mysqlExecute("ALTER TABLE ozon_ad_sku_daily ADD COLUMN campaign_strategy VARCHAR(128) NULL AFTER campaign_budget_rub").catch(ignoreDuplicateColumn);
  await mysqlExecute("ALTER TABLE ozon_ad_sku_daily ADD COLUMN campaign_payment_type VARCHAR(64) NULL AFTER campaign_strategy").catch(ignoreDuplicateColumn);
  await mysqlExecute("ALTER TABLE ozon_ad_sku_daily ADD COLUMN campaign_placement VARCHAR(255) NULL AFTER campaign_payment_type").catch(ignoreDuplicateColumn);
  await mysqlExecute("ALTER TABLE ozon_ad_sku_daily ADD COLUMN campaign_bid_rub DECIMAL(18,4) NOT NULL DEFAULT 0 AFTER campaign_placement").catch(ignoreDuplicateColumn);
  await mysqlExecute("ALTER TABLE ozon_ad_sku_daily ADD COLUMN campaign_target_cir DECIMAL(10,4) NOT NULL DEFAULT 0 AFTER campaign_bid_rub").catch(ignoreDuplicateColumn);
  await mysqlExecute("ALTER TABLE ozon_ad_sku_daily ADD COLUMN add_to_cart INT NOT NULL DEFAULT 0 AFTER clicks").catch(ignoreDuplicateColumn);
  await mysqlExecute("ALTER TABLE ozon_ad_sku_daily ADD COLUMN add_to_cart_available TINYINT(1) NOT NULL DEFAULT 0 AFTER add_to_cart").catch(ignoreDuplicateColumn);
  schemaReady = true;
}

async function ensurePerformanceCredentialSchema() {
  await mysqlExecute("ALTER TABLE shops ADD COLUMN performance_client_id VARCHAR(128) NULL").catch(ignoreDuplicateColumn);
  await mysqlExecute("ALTER TABLE shops ADD COLUMN performance_client_secret TEXT NULL").catch(ignoreDuplicateColumn);
  await mysqlExecute("ALTER TABLE shops ADD COLUMN performance_client_secret_hint VARCHAR(255) NULL").catch(ignoreDuplicateColumn);
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS ozon_ad_forbidden_campaigns (
      shop_id BIGINT UNSIGNED NOT NULL,
      campaign_id VARCHAR(128) NOT NULL,
      reason VARCHAR(255) NOT NULL DEFAULT '',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (shop_id, campaign_id),
      KEY idx_ozon_ad_forbidden_campaigns_updated (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `).catch(() => {});
}

function ignoreDuplicateColumn(error) {
  const message = String(error?.message || "").toLowerCase();
  if (!message.includes("duplicate column")) throw error;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}

async function packagingFeeRuleMysql() {
  const rows = await mysqlQuery("SELECT value_json FROM system_settings WHERE `key` = ?", ["profit.packaging_fee_rule"]);
  const raw = rows?.[0]?.value_json;
  if (!raw) return DEFAULT_PACKAGING_FEE_RULE;
  try {
    return { ...DEFAULT_PACKAGING_FEE_RULE, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PACKAGING_FEE_RULE;
  }
}

async function packagingFeeForSaleAmountMysql(saleAmountCny) {
  const rule = await packagingFeeRuleMysql();
  const threshold = toNumber(rule.low_sale_threshold_cny);
  const lowFee = toNumber(rule.low_fee_cny);
  const highFee = toNumber(rule.high_fee_cny);
  return roundMoney(toNumber(saleAmountCny) > threshold ? highFee : lowFee);
}

function buildProfitProduct(row = {}) {
  const productId = toNumber(row.product_id);
  if (!productId) return null;
  return {
    id: productId,
    purchase_cost: toNumber(row.product_purchase_cost),
    domestic_shipping: toNumber(row.product_domestic_shipping),
    international_shipping: toNumber(row.product_international_shipping),
    handling_fee: toNumber(row.product_handling_fee),
    purchase_quantity: toNumber(row.product_purchase_quantity, 1),
    package_weight_g: toNumber(row.product_package_weight_g),
    length_cm: toNumber(row.product_length_cm),
    width_cm: toNumber(row.product_width_cm),
    height_cm: toNumber(row.product_height_cm),
    return_rate: row.product_return_rate == null ? 0.05 : toNumber(row.product_return_rate),
    withdrawal_fee_rate: row.product_withdrawal_fee_rate == null ? 0.012 : toNumber(row.product_withdrawal_fee_rate),
    shipping_method: row.product_shipping_method || "air_land",
    exchange_rate: RUB_CNY_RATE,
    advertising_rate: 0
  };
}

function buildProfitMapping(row = {}) {
  return {
    commission_low: row.mapping_commission_low,
    commission_high: row.mapping_commission_high,
    commissions_json: row.mapping_commissions_json
  };
}

function resolveModelQuantity(row = {}) {
  return Math.max(1, toNumber(row.units) || toNumber(row.orders) || toNumber(row.local_units) || 1);
}

function resolveAdQuantity(row = {}) {
  return toNumber(row.units) || toNumber(row.orders) || 0;
}

function resolveAdRevenueCny(row = {}) {
  return toNumber(row.revenue_cny) || (toNumber(row.revenue_rub) ? toNumber(row.revenue_rub) / RUB_CNY_RATE : 0);
}

function resolveModelSalePriceCny(row = {}, quantity) {
  const adRevenueCny = resolveAdRevenueCny(row);
  if (adRevenueCny > 0) return adRevenueCny / Math.max(1, quantity);
  const onlineSalePrice = toNumber(row.online_sale_price);
  if (onlineSalePrice > 0) {
    const currency = String(row.online_sale_currency_code || row.online_currency_code || "").trim().toUpperCase();
    if (currency === "CNY" || currency === "RMB" || currency === "CHY") return onlineSalePrice;
    if (currency === "RUB" || currency === "RUR" || !currency) return onlineSalePrice / RUB_CNY_RATE;
    return onlineSalePrice;
  }
  const localRevenue = toNumber(row.local_revenue_cny);
  const localUnits = Math.max(1, toNumber(row.local_units));
  if (localRevenue > 0) return localRevenue / localUnits;
  return 0;
}

async function applyAdvertisingProfitModel(row = {}) {
  const quantity = resolveModelQuantity(row);
  const adQuantity = resolveAdQuantity(row);
  const adRevenueCny = roundMoney(resolveAdRevenueCny(row));
  const salePrice = resolveModelSalePriceCny(row, quantity);
  const product = buildProfitProduct(row);
  const adSpendCny = roundMoney(toNumber(row.spend_rub) / RUB_CNY_RATE);
  if (!product || salePrice <= 0) {
    return {
      ...row,
      gross_margin_rate: null,
      ad_order_quantity: adQuantity,
      ad_revenue_cny: adRevenueCny,
      ad_spend_cny: adSpendCny,
      ad_net_profit_rate: null,
      ad_net_profit_cny: adSpendCny > 0 ? -adSpendCny : null,
      profit_model_status: product ? "missing_sale_price" : "missing_inventory_binding",
      ad_profit_status: adQuantity > 0 && adRevenueCny > 0 ? "missing_profit_model" : "no_ad_orders"
    };
  }

  const estimated = estimateItemProfit({
    salePrice,
    quantity: 1,
    product,
    mapping: buildProfitMapping(row)
  });
  const packagingCost = await packagingFeeForSaleAmountMysql(salePrice);
  const modelProfitPerUnit = roundMoney(toNumber(estimated.profit) - packagingCost);
  const modelRevenueCny = roundMoney(salePrice * quantity);
  const modelProfitTotal = roundMoney(modelProfitPerUnit * quantity);
  const hasAdOrders = adQuantity > 0 && adRevenueCny > 0;
  const adModelProfitCny = hasAdOrders ? roundMoney(modelProfitPerUnit * adQuantity) : 0;
  const adNetProfitCny = hasAdOrders ? roundMoney(adModelProfitCny - adSpendCny) : (adSpendCny > 0 ? -adSpendCny : null);

  return {
    ...row,
    model_quantity: quantity,
    ad_order_quantity: adQuantity,
    ad_revenue_cny: adRevenueCny,
    model_sale_price_cny: roundMoney(salePrice),
    model_revenue_cny: modelRevenueCny,
    model_purchase_cost_cny: roundMoney(product.purchase_cost),
    model_domestic_shipping_cny: roundMoney(product.domestic_shipping),
    model_international_shipping_cny: roundMoney(toNumber(estimated.freight ?? product.international_shipping)),
    model_handling_fee_cny: roundMoney(product.handling_fee),
    model_commission_cny: roundMoney(toNumber(estimated.commission)),
    model_payment_fee_cny: roundMoney(toNumber(estimated.paymentFee)),
    model_withdrawal_fee_cny: roundMoney(toNumber(estimated.withdrawalFee)),
    model_return_loss_cny: roundMoney(toNumber(estimated.expectedReturnLoss)),
    model_packaging_cost_cny: packagingCost,
    model_profit_per_unit_cny: modelProfitPerUnit,
    model_profit_cny: modelProfitTotal,
    gross_margin_rate: salePrice > 0 ? modelProfitPerUnit / salePrice : null,
    ad_spend_cny: adSpendCny,
    ad_model_profit_cny: hasAdOrders ? adModelProfitCny : null,
    ad_net_profit_cny: adNetProfitCny,
    ad_net_profit_rate: hasAdOrders && adRevenueCny > 0 ? adNetProfitCny / adRevenueCny : null,
    profit_model_status: "estimated_without_ad_cost",
    ad_profit_status: hasAdOrders ? "current_range_ad_orders" : "no_ad_orders"
  };
}

function normalizeSortOrder(value) {
  return String(value || "").toLowerCase() === "asc" ? "ASC" : "DESC";
}

function pagination(query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(1000, Math.max(1, Number(query.pageSize || query.page_size || 30)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function buildDateRange(query = {}) {
  return {
    from: String(query.from || dateDaysAgo(6)).slice(0, 10),
    to: String(query.to || todayKey()).slice(0, 10)
  };
}

function buildAdDailyWhere(query = {}) {
  const where = [];
  const params = [];
  const { from, to } = buildDateRange(query);

  where.push("ad.date_key >= ?");
  params.push(from);
  where.push("ad.date_key <= ?");
  params.push(to);

  const shopId = query.shopId || query.shop_id;
  if (shopId && String(shopId) !== "all") {
    where.push("ad.shop_id = ?");
    params.push(Number(shopId));
  }

  const keyword = String(query.keyword || "").trim();
  if (keyword) {
    where.push(`(
      ad.ozon_sku LIKE ?
      OR ad.offer_id LIKE ?
      OR ad.product_name LIKE ?
      OR ad.campaign_name LIKE ?
      OR s.name LIKE ?
    )`);
    const like = `%${keyword}%`;
    params.push(like, like, like, like, like);
  }

  return {
    sql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
    from,
    to
  };
}

function rowMetrics(row = {}) {
  const spendRub = toNumber(row.spend_rub);
  const spendCny = toNumber(row.spend_cny);
  const clicks = toNumber(row.clicks);
  const addToCart = toNumber(row.add_to_cart);
  const addToCartAvailable = toNumber(row.add_to_cart_available) || (addToCart > 0 ? 1 : 0);
  const impressions = toNumber(row.impressions);
  const orders = toNumber(row.orders);
  const revenueRub = toNumber(row.revenue_rub);
  const revenueCny = toNumber(row.revenue_cny);
  const source = String(row.source || "");
  let rawJson = row.raw_json || null;
  if (typeof rawJson === "string" && rawJson.trim()) {
    try {
      rawJson = JSON.parse(rawJson);
    } catch {
      rawJson = null;
    }
  }
  const pendingRows = Number(row.pending_rows || 0);
  const dataPending = Boolean(
    row.data_pending
    || pendingRows > 0
    || source === "ozon_performance_pending"
    || rawJson?.pending
  );

  return {
    ...row,
    source,
    pending_rows: pendingRows,
    data_pending: dataPending,
    data_pending_reason: row.data_pending_reason || (dataPending ? (rawJson?.reason || "ozon_report_not_ready") : ""),
    spend_rub: spendRub,
    spend_cny: spendCny,
    impressions,
    clicks,
    add_to_cart: addToCart,
    add_to_cart_available: addToCartAvailable,
    orders,
    units: toNumber(row.units),
    revenue_rub: revenueRub,
    revenue_cny: revenueCny,
    ctr: impressions ? clicks / impressions : 0,
    cpc_rub: clicks ? spendRub / clicks : 0,
    cpc_cny: clicks ? spendCny / clicks : 0,
    acos: revenueRub ? spendRub / revenueRub : 0,
    roas: spendRub ? revenueRub / spendRub : 0,
    conversion_rate: clicks ? orders / clicks : 0
  };
}

export async function advertisingDailyMysql(query = {}) {
  await ensureAdDailySchema();
  const { sql, params, from, to } = buildAdDailyWhere(query);
  const { page, pageSize, offset } = pagination(query);
  const sortBy = String(query.sortBy || query.sort_by || "spend_rub");
  const sortable = new Map([
    ["date_key", "last_date"],
    ["spend_rub", "spend_rub"],
    ["spend_cny", "spend_cny"],
    ["impressions", "impressions"],
    ["clicks", "clicks"],
    ["add_to_cart", "add_to_cart"],
    ["orders", "orders"],
    ["revenue_rub", "revenue_rub"],
    ["revenue_cny", "revenue_cny"],
    ["acos", "acos"],
    ["roas", "roas"]
  ]);
  const orderField = sortable.get(sortBy) || "spend_rub";
  const sortOrder = normalizeSortOrder(query.sortOrder || query.sort_order);

  const countRows = await mysqlQuery(`
    SELECT COUNT(*) AS total
    FROM (
      SELECT ad.shop_id, ad.ozon_sku
      FROM ozon_ad_sku_daily ad
      JOIN shops s ON s.id = ad.shop_id
      ${sql}
      GROUP BY ad.shop_id, ad.ozon_sku
    ) grouped
  `, params);
  const total = Number(countRows?.[0]?.total || 0);

  const rows = await mysqlQuery(`
    SELECT
      ad.shop_id,
      MAX(s.name) AS shop_name,
      ad.ozon_sku,
      SUBSTRING_INDEX(GROUP_CONCAT(NULLIF(ad.campaign_id, '') ORDER BY ad.spend_rub DESC, ad.date_key DESC SEPARATOR ','), ',', 1) AS campaign_id,
      SUBSTRING_INDEX(GROUP_CONCAT(NULLIF(ad.campaign_name, '') ORDER BY ad.spend_rub DESC, ad.date_key DESC SEPARATOR ','), ',', 1) AS campaign_name,
      MAX(COALESCE(ad.offer_id, sm.offer_id, op.offer_id, '')) AS offer_id,
      MAX(COALESCE(ad.product_name, sm.display_name, op.name, p.name, '')) AS product_name,
      MAX(COALESCE(oi_img.image_url, op.image_url, op.primary_image, op_offer.image_url, op_offer.primary_image, p.image_url, '')) AS image_url,
      MAX(COALESCE(ad.product_id, sm.product_id, op.product_id)) AS product_id,
      MIN(ad.date_key) AS first_date,
      MAX(ad.date_key) AS last_date,
      COUNT(DISTINCT ad.date_key) AS active_days,
      COUNT(DISTINCT NULLIF(ad.campaign_id, '')) AS campaign_count,
      GROUP_CONCAT(DISTINCT NULLIF(ad.campaign_state, '') ORDER BY ad.campaign_state SEPARATOR ', ') AS campaign_states,
      GROUP_CONCAT(DISTINCT NULLIF(latest_ad.campaign_state, '') ORDER BY latest_ad.campaign_state SEPARATOR ', ') AS latest_campaign_states,
      GROUP_CONCAT(DISTINCT NULLIF(ad.ad_type, '') ORDER BY ad.ad_type SEPARATOR ', ') AS ad_types,
      COALESCE(MAX(ad.campaign_budget_rub), 0) AS campaign_budget_rub,
      GROUP_CONCAT(DISTINCT NULLIF(ad.campaign_strategy, '') ORDER BY ad.campaign_strategy SEPARATOR ', ') AS campaign_strategies,
      GROUP_CONCAT(DISTINCT NULLIF(ad.campaign_payment_type, '') ORDER BY ad.campaign_payment_type SEPARATOR ', ') AS campaign_payment_types,
      GROUP_CONCAT(DISTINCT NULLIF(ad.campaign_placement, '') ORDER BY ad.campaign_placement SEPARATOR ', ') AS campaign_placements,
      COALESCE(MAX(ad.campaign_bid_rub), 0) AS campaign_bid_rub,
      COALESCE(MAX(ad.campaign_target_cir), 0) AS campaign_target_cir,
      COALESCE(MAX(profit.local_revenue_cny), 0) AS local_revenue_cny,
      COALESCE(MAX(profit.local_purchase_cost_cny), 0) AS local_purchase_cost_cny,
      COALESCE(MAX(profit.local_profit_cny), 0) AS local_profit_cny,
      COALESCE(MAX(profit.local_units), 0) AS local_units,
      MAX(op.sale_price) AS online_sale_price,
      MAX(op.currency_code) AS online_sale_currency_code,
      MAX(sm.commission_low) AS mapping_commission_low,
      MAX(sm.commission_high) AS mapping_commission_high,
      MAX(op.commissions_json) AS mapping_commissions_json,
      MAX(p.purchase_cost) AS product_purchase_cost,
      MAX(p.domestic_shipping) AS product_domestic_shipping,
      0 AS product_international_shipping,
      MAX(p.handling_fee) AS product_handling_fee,
      MAX(p.purchase_quantity) AS product_purchase_quantity,
      MAX(p.package_weight_g) AS product_package_weight_g,
      MAX(p.length_cm) AS product_length_cm,
      MAX(p.width_cm) AS product_width_cm,
      MAX(p.height_cm) AS product_height_cm,
      MAX(p.return_rate) AS product_return_rate,
      MAX(p.withdrawal_fee_rate) AS product_withdrawal_fee_rate,
      MAX(p.shipping_method) AS product_shipping_method,
      COALESCE(SUM(ad.spend_rub), 0) AS spend_rub,
      COALESCE(SUM(ad.spend_cny), 0) AS spend_cny,
      COALESCE(SUM(ad.impressions), 0) AS impressions,
      COALESCE(SUM(ad.clicks), 0) AS clicks,
      COALESCE(SUM(ad.add_to_cart), 0) AS add_to_cart,
      COALESCE(MAX(ad.add_to_cart_available), 0) AS add_to_cart_available,
      COALESCE(SUM(ad.orders), 0) AS orders,
      COALESCE(SUM(ad.units), 0) AS units,
      COALESCE(SUM(ad.revenue_rub), 0) AS revenue_rub,
      COALESCE(SUM(ad.revenue_cny), 0) AS revenue_cny,
      SUM(CASE WHEN ad.source = 'ozon_performance_pending' THEN 1 ELSE 0 END) AS pending_rows,
      CASE WHEN SUM(CASE WHEN ad.source = 'ozon_performance_pending' THEN 1 ELSE 0 END) > 0 THEN 1 ELSE 0 END AS data_pending,
      CASE WHEN SUM(CASE WHEN ad.source = 'ozon_performance_pending' THEN 1 ELSE 0 END) > 0 THEN 'ozon_report_not_ready' ELSE '' END AS data_pending_reason,
      CASE WHEN COALESCE(SUM(ad.revenue_rub), 0) > 0 THEN COALESCE(SUM(ad.spend_rub), 0) / COALESCE(SUM(ad.revenue_rub), 0) ELSE 0 END AS acos,
      CASE WHEN COALESCE(SUM(ad.spend_rub), 0) > 0 THEN COALESCE(SUM(ad.revenue_rub), 0) / COALESCE(SUM(ad.spend_rub), 0) ELSE 0 END AS roas
    FROM ozon_ad_sku_daily ad
    JOIN shops s ON s.id = ad.shop_id
    LEFT JOIN sku_mappings sm ON sm.shop_id = ad.shop_id AND sm.ozon_sku = ad.ozon_sku AND sm.active = 1
    LEFT JOIN online_products op ON op.shop_id = ad.shop_id AND op.ozon_sku = ad.ozon_sku
    LEFT JOIN online_products op_offer ON op_offer.shop_id = ad.shop_id AND op_offer.offer_id = COALESCE(NULLIF(ad.offer_id, ''), sm.offer_id)
    LEFT JOIN products p ON p.id = COALESCE(ad.product_id, sm.product_id, op.product_id)
    LEFT JOIN (
      SELECT base.shop_id, base.ozon_sku, base.campaign_id, base.campaign_state
      FROM ozon_ad_sku_daily base
      JOIN (
        SELECT shop_id, ozon_sku, campaign_id, MAX(date_key) AS date_key
        FROM ozon_ad_sku_daily
        GROUP BY shop_id, ozon_sku, campaign_id
      ) last_row ON last_row.shop_id = base.shop_id
        AND last_row.ozon_sku = base.ozon_sku
        AND last_row.campaign_id = base.campaign_id
        AND last_row.date_key = base.date_key
    ) latest_ad ON latest_ad.shop_id = ad.shop_id
      AND latest_ad.ozon_sku = ad.ozon_sku
      AND latest_ad.campaign_id = ad.campaign_id
    LEFT JOIN (
      SELECT
        o.shop_id,
        oi.ozon_sku,
        COALESCE(SUM(COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0)), 0) AS local_revenue_cny,
        COALESCE(SUM(COALESCE(opi.purchase_cost_cny, oi.frozen_purchase_cost * oi.quantity, 0)), 0) AS local_purchase_cost_cny,
        COALESCE(SUM(COALESCE(opi.net_profit_cny, NULLIF(oi.actual_profit, 0), oi.estimated_profit, 0)), 0) AS local_profit_cny,
        COALESCE(SUM(oi.quantity), 0) AS local_units
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
      WHERE COALESCE(oi.ozon_sku, '') != ''
        AND LOWER(COALESCE(o.status, '')) NOT LIKE '%cancel%'
      GROUP BY o.shop_id, oi.ozon_sku
    ) profit ON profit.shop_id = ad.shop_id AND profit.ozon_sku = ad.ozon_sku
    LEFT JOIN (
      SELECT o.shop_id, oi.ozon_sku, MAX(NULLIF(oi.ozon_image_url, '')) AS image_url
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE COALESCE(oi.ozon_image_url, '') != ''
      GROUP BY o.shop_id, oi.ozon_sku
    ) oi_img ON oi_img.shop_id = ad.shop_id AND oi_img.ozon_sku = ad.ozon_sku
    ${sql}
    GROUP BY ad.shop_id, ad.ozon_sku
    ORDER BY ${orderField} ${sortOrder}, ad.shop_id ASC, ad.ozon_sku ASC
    LIMIT ? OFFSET ?
  `, [...params, pageSize, offset]);

  const modelRows = await Promise.all(rows.map(applyAdvertisingProfitModel));

  return {
    rows: modelRows.map((row, index) => ({ rank: offset + index + 1, ...rowMetrics(row) })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    from,
    to
  };
}

export async function advertisingDailySummaryMysql(query = {}) {
  await ensureAdDailySchema();
  const { sql, params, from, to } = buildAdDailyWhere(query);
  const rows = await mysqlQuery(`
    SELECT
      COUNT(DISTINCT ad.shop_id) AS shop_count,
      COUNT(DISTINCT ad.ozon_sku) AS sku_count,
      COUNT(DISTINCT NULLIF(ad.campaign_id, '')) AS campaign_count,
      COALESCE(SUM(ad.spend_rub), 0) AS spend_rub,
      COALESCE(SUM(ad.spend_cny), 0) AS spend_cny,
      COALESCE(SUM(ad.impressions), 0) AS impressions,
      COALESCE(SUM(ad.clicks), 0) AS clicks,
      COALESCE(SUM(ad.add_to_cart), 0) AS add_to_cart,
      COALESCE(MAX(ad.add_to_cart_available), 0) AS add_to_cart_available,
      COALESCE(SUM(ad.orders), 0) AS orders,
      COALESCE(SUM(ad.units), 0) AS units,
      COALESCE(SUM(ad.revenue_rub), 0) AS revenue_rub,
      COALESCE(SUM(ad.revenue_cny), 0) AS revenue_cny,
      SUM(CASE WHEN ad.source = 'ozon_performance_pending' THEN 1 ELSE 0 END) AS pending_rows,
      CASE WHEN SUM(CASE WHEN ad.source = 'ozon_performance_pending' THEN 1 ELSE 0 END) > 0 THEN 1 ELSE 0 END AS data_pending,
      CASE WHEN SUM(CASE WHEN ad.source = 'ozon_performance_pending' THEN 1 ELSE 0 END) > 0 THEN 'ozon_report_not_ready' ELSE '' END AS data_pending_reason
    FROM ozon_ad_sku_daily ad
    JOIN shops s ON s.id = ad.shop_id
    ${sql}
  `, params);
  return {
    ...rowMetrics(rows?.[0] || {}),
    from,
    to,
    metricBasis: advertisingMetricBasis()
  };
}

function advertisingMetricBasis() {
  return {
    revenueRub: "Ozon Performance attributed revenue, ordersMoney + modelsMoney when available.",
    orders: "Ozon Performance attributed orders. Used for conversion rate.",
    units: "Ozon Performance attributed units, orders + models when available.",
    roas: "attributed revenue / advertising spend.",
    acos: "advertising spend / attributed revenue.",
    cny: "RUB values converted by the system RUB_CNY_RATE for profit estimates."
  };
}

export async function advertisingDailyQualityMysql(query = {}) {
  await ensureAdDailySchema();
  await ensurePerformanceCredentialSchema();
  const { from, to } = buildDateRange(query);
  const shopId = query.shopId || query.shop_id;
  const scopedShopFilter = shopId && String(shopId) !== "all";
  const shopParams = scopedShopFilter ? [Number(shopId)] : [];
  const shopWhere = scopedShopFilter ? "AND s.id = ?" : "";

  const shops = await mysqlQuery(`
    SELECT
      s.id,
      s.name,
      CASE WHEN COALESCE(s.performance_client_id, '') <> '' AND COALESCE(s.performance_client_secret, '') <> '' THEN 1 ELSE 0 END AS has_performance_credentials,
      COALESCE(ad.rows_count, 0) AS rows_count,
      ad.min_date,
      ad.max_date,
      ad.last_synced_at,
      COALESCE(ad.spend_rub, 0) AS spend_rub,
      COALESCE(ad.revenue_rub, 0) AS revenue_rub,
      COALESCE(ad.orders, 0) AS orders,
      COALESCE(ad.units, 0) AS units,
      COALESCE(ad.pending_rows, 0) AS pending_rows
    FROM shops s
    LEFT JOIN (
      SELECT
        shop_id,
        COUNT(*) AS rows_count,
        MIN(date_key) AS min_date,
        MAX(date_key) AS max_date,
        MAX(synced_at) AS last_synced_at,
        SUM(spend_rub) AS spend_rub,
        SUM(revenue_rub) AS revenue_rub,
        SUM(orders) AS orders,
        SUM(units) AS units,
        SUM(CASE WHEN source = 'ozon_performance_pending' THEN 1 ELSE 0 END) AS pending_rows
      FROM ozon_ad_sku_daily
      WHERE date_key >= ? AND date_key <= ?
      GROUP BY shop_id
    ) ad ON ad.shop_id = s.id
    WHERE s.status = 'active'
      AND COALESCE(s.performance_client_id, '') <> ''
      AND COALESCE(s.performance_client_secret, '') <> ''
      ${shopWhere}
    ORDER BY s.id
  `, [from, to, ...shopParams]);

  const checks = await mysqlQuery(`
    SELECT
      COUNT(*) AS row_count,
      COUNT(DISTINCT ad.shop_id) AS covered_shop_count,
      COUNT(DISTINCT ad.ozon_sku) AS sku_count,
      COALESCE(SUM(ad.spend_rub), 0) AS spend_rub,
      COALESCE(SUM(ad.revenue_rub), 0) AS revenue_rub,
      SUM(CASE WHEN ad.clicks > ad.impressions THEN 1 ELSE 0 END) AS impossible_click_rows,
      SUM(CASE WHEN ad.revenue_rub > 0 AND ad.units = 0 THEN 1 ELSE 0 END) AS revenue_without_units_rows,
      SUM(CASE WHEN ad.spend_rub > 0 AND ad.revenue_rub = 0 THEN 1 ELSE 0 END) AS spend_without_revenue_rows,
      COALESCE(SUM(CASE WHEN ad.spend_rub > 0 AND ad.revenue_rub = 0 THEN ad.spend_rub ELSE 0 END), 0) AS spend_without_revenue_rub,
      SUM(CASE WHEN ad.source = 'ozon_performance_pending' THEN 1 ELSE 0 END) AS pending_rows,
      COUNT(DISTINCT CASE WHEN ad.source = 'ozon_performance_pending' THEN ad.shop_id END) AS pending_shop_count,
      COUNT(DISTINCT CASE WHEN ad.source = 'ozon_performance_pending' THEN ad.ozon_sku END) AS pending_sku_count
    FROM ozon_ad_sku_daily ad
    WHERE ad.date_key >= ? AND ad.date_key <= ?
      ${scopedShopFilter ? "AND ad.shop_id = ?" : ""}
  `, scopedShopFilter ? [from, to, Number(shopId)] : [from, to]);

  const multiCampaignRows = await mysqlQuery(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT date_key, shop_id, ozon_sku
      FROM ozon_ad_sku_daily
      WHERE date_key >= ? AND date_key <= ?
        ${scopedShopFilter ? "AND shop_id = ?" : ""}
      GROUP BY date_key, shop_id, ozon_sku
      HAVING COUNT(DISTINCT campaign_id) > 1
    ) t
  `, scopedShopFilter ? [from, to, Number(shopId)] : [from, to]);

  const missingBindingRows = await mysqlQuery(`
    SELECT COUNT(*) AS count, COALESCE(SUM(ad.spend_rub), 0) AS spend_rub
    FROM ozon_ad_sku_daily ad
    LEFT JOIN sku_mappings sm ON sm.shop_id = ad.shop_id AND sm.ozon_sku = ad.ozon_sku AND sm.active = 1
    LEFT JOIN online_products op ON op.shop_id = ad.shop_id AND op.ozon_sku = ad.ozon_sku
    WHERE ad.date_key >= ? AND ad.date_key <= ?
      ${scopedShopFilter ? "AND ad.shop_id = ?" : ""}
      AND COALESCE(ad.product_id, sm.product_id, op.product_id) IS NULL
  `, scopedShopFilter ? [from, to, Number(shopId)] : [from, to]);

  const syncRuns = await mysqlQuery(`
    SELECT job_key, status, COUNT(*) AS count, MAX(started_at) AS latest_started_at, MAX(finished_at) AS latest_finished_at
    FROM scheduled_job_runs
    WHERE job_key IN ('advertising_sync', 'advertising_today_sync')
      AND started_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY)
    GROUP BY job_key, status
    ORDER BY job_key, status
  `);

  const jobRows = await mysqlQuery(`
    SELECT job_key, last_status, fail_count, last_success_at, last_attempt_at, next_run_at, last_error
    FROM scheduled_jobs
    WHERE job_key IN ('advertising_sync', 'advertising_today_sync')
    ORDER BY job_key
  `);

  const forbiddenCampaignRows = await mysqlQuery(`
    SELECT f.shop_id, s.name AS shop_name, COUNT(*) AS count, MAX(f.updated_at) AS latest_updated_at
    FROM ozon_ad_forbidden_campaigns f
    LEFT JOIN shops s ON s.id = f.shop_id
    WHERE f.updated_at >= ?
      ${scopedShopFilter ? "AND f.shop_id = ?" : ""}
    GROUP BY f.shop_id, s.name
    ORDER BY f.shop_id
  `, scopedShopFilter ? [forbiddenCampaignCutoff(), Number(shopId)] : [forbiddenCampaignCutoff()]);

  const check = checks?.[0] || {};
  const expectedShopCount = shops.length;
  const coveredShopCount = Number(check.covered_shop_count || 0);
  const missingShops = shops.filter((shop) => Number(shop.rows_count || 0) === 0);
  const impossibleRows = Number(check.impossible_click_rows || 0) + Number(check.revenue_without_units_rows || 0);
  const missingBindingCount = Number(missingBindingRows?.[0]?.count || 0);
  const pendingRows = Number(check.pending_rows || 0);
  const pendingShopCount = Number(check.pending_shop_count || 0);
  const pendingSkuCount = Number(check.pending_sku_count || 0);
  const rowCount = Number(check.row_count || 0);
  const settledRows = Math.max(0, rowCount - pendingRows);
  const pendingRatio = rowCount > 0 ? pendingRows / rowCount : 0;
  const forbiddenCampaignCount = forbiddenCampaignRows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const recentFailedRuns = syncRuns
    .filter((row) => row.status === "failed")
    .reduce((sum, row) => sum + Number(row.count || 0), 0);

  const issues = [];
  if (missingShops.length) {
    issues.push({
      key: "missing_shop_coverage",
      severity: "danger",
      message: `${missingShops.length} 个店铺在当前日期范围没有广告明细`,
      detail: missingShops.map((shop) => shop.name).join(", ")
    });
  }
  if (impossibleRows > 0) {
    issues.push({
      key: "metric_anomaly",
      severity: "danger",
      message: `${impossibleRows} 行广告指标存在明显异常`,
      detail: "包含点击大于曝光，或有销售额但件数为 0"
    });
  }
  if (missingBindingCount > 0) {
    issues.push({
      key: "missing_product_binding",
      severity: "warning",
      message: `${missingBindingCount} 行广告数据未绑定库存商品`,
      detail: `影响广告净利润判断，相关花费 ${roundMoney(Number(missingBindingRows?.[0]?.spend_rub || 0))} RUB`
    });
  }
  if (Number(multiCampaignRows?.[0]?.count || 0) > 0) {
    issues.push({
      key: "multi_campaign_sku",
      severity: "info",
      message: `${Number(multiCampaignRows[0].count)} 个 SKU 日期存在多个广告活动`,
      detail: "SKU 汇总指标可看，调价/停投应进入明细确认具体活动"
    });
  }
  if (recentFailedRuns > 0) {
    issues.push({
      key: "recent_sync_failures",
      severity: "warning",
      message: `最近 48 小时有 ${recentFailedRuns} 次广告同步失败记录`,
      detail: "如最新状态已成功，可作为历史风险观察"
    });
  }
  if (pendingRows > 0) {
    issues.push({
      key: "ozon_report_pending",
      severity: "warning",
      message: `${pendingSkuCount} 个 SKU 的 Ozon 当日报表还未返回`,
      detail: `${pendingShopCount} 个店铺、${pendingRows} 行为占位数据；任务已跑通，但这些 0 不是最终广告指标`
    });
  }

  const freshnessDates = shops.map((shop) => shop.last_synced_at).filter(Boolean);
  const latestSyncedAt = freshnessDates.length
    ? freshnessDates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
    : null;
  const todayIncluded = to >= todayKey();
  if (todayIncluded) {
    issues.push({
      key: "today_attribution_delay",
      severity: "info",
      message: "当前范围包含今天，当天广告归因可能延迟",
      detail: "今天适合看趋势和异常，最终复盘建议看昨日及以前"
    });
  }

  if (forbiddenCampaignCount > 0) {
    issues.push({
      key: "campaign_report_unavailable",
      severity: missingShops.length ? "warning" : "info",
      message: `${forbiddenCampaignCount} 个广告活动的 Ozon 报表暂不可用`,
      detail: forbiddenCampaignRows.map((row) => `${row.shop_name || row.shop_id}: ${row.count}`).join(", ")
    });
  }

  const severityRank = { danger: 3, warning: 2, info: 1 };
  const maxSeverity = issues.reduce((max, issue) => Math.max(max, severityRank[issue.severity] || 0), 0);
  const score = Math.max(0, 100
    - missingShops.length * 25
    - impossibleRows * 20
    - Math.min(25, missingBindingCount * 2)
    - Math.min(15, recentFailedRuns));
  const status = maxSeverity >= 3 ? "danger" : maxSeverity === 2 ? "warning" : "success";

  return {
    from,
    to,
    status,
    score,
    expectedShopCount,
    coveredShopCount,
    latestSyncedAt,
    todayIncluded,
    summary: {
      rowCount,
      settledRows,
      pendingRatio,
      skuCount: Number(check.sku_count || 0),
      spendRub: Number(check.spend_rub || 0),
      revenueRub: Number(check.revenue_rub || 0),
      spendWithoutRevenueRows: Number(check.spend_without_revenue_rows || 0),
      spendWithoutRevenueRub: Number(check.spend_without_revenue_rub || 0),
      pendingRows,
      pendingShopCount,
      pendingSkuCount,
      multiCampaignSkuDays: Number(multiCampaignRows?.[0]?.count || 0),
      skippedCampaigns: forbiddenCampaignCount,
      missingProductBindingRows: missingBindingCount,
      missingProductBindingSpendRub: Number(missingBindingRows?.[0]?.spend_rub || 0)
    },
    shops: shops.map((shop) => ({
      id: Number(shop.id),
      name: shop.name || "",
      hasPerformanceCredentials: Boolean(shop.has_performance_credentials),
      rows: Number(shop.rows_count || 0),
      minDate: shop.min_date || null,
      maxDate: shop.max_date || null,
      lastSyncedAt: shop.last_synced_at || null,
      spendRub: Number(shop.spend_rub || 0),
      revenueRub: Number(shop.revenue_rub || 0),
      orders: Number(shop.orders || 0),
      units: Number(shop.units || 0),
      pendingRows: Number(shop.pending_rows || 0),
      dataPending: Number(shop.pending_rows || 0) > 0,
      covered: Number(shop.rows_count || 0) > 0
    })),
    jobs: jobRows.map((job) => ({
      key: job.job_key,
      lastStatus: job.last_status || "",
      failCount: Number(job.fail_count || 0),
      lastSuccessAt: job.last_success_at || null,
      lastAttemptAt: job.last_attempt_at || null,
      nextRunAt: job.next_run_at || null,
      lastError: job.last_error || ""
    })),
    recentRuns: syncRuns.map((row) => ({
      jobKey: row.job_key,
      status: row.status,
      count: Number(row.count || 0),
      latestStartedAt: row.latest_started_at || null,
      latestFinishedAt: row.latest_finished_at || null
    })),
    issues
  };
}

export async function advertisingDailyDetailsMysql(query = {}) {
  await ensureAdDailySchema();
  const { sql, params, from, to } = buildAdDailyWhere(query);
  const where = [sql ? sql.replace(/^WHERE\s+/i, "") : "1=1"];
  const detailParams = [...params];

  if (query.ozon_sku) {
    where.push("ad.ozon_sku = ?");
    detailParams.push(String(query.ozon_sku));
  }

  const rows = await mysqlQuery(`
    SELECT
      ad.*,
      s.name AS shop_name,
      COALESCE(ad.product_name, sm.display_name, op.name, p.name, '') AS resolved_product_name,
      COALESCE(oi_img.image_url, op.image_url, op.primary_image, op_offer.image_url, op_offer.primary_image, p.image_url, '') AS image_url
    FROM ozon_ad_sku_daily ad
    JOIN shops s ON s.id = ad.shop_id
    LEFT JOIN sku_mappings sm ON sm.shop_id = ad.shop_id AND sm.ozon_sku = ad.ozon_sku AND sm.active = 1
    LEFT JOIN online_products op ON op.shop_id = ad.shop_id AND op.ozon_sku = ad.ozon_sku
    LEFT JOIN online_products op_offer ON op_offer.shop_id = ad.shop_id AND op_offer.offer_id = COALESCE(NULLIF(ad.offer_id, ''), sm.offer_id)
    LEFT JOIN products p ON p.id = COALESCE(ad.product_id, sm.product_id, op.product_id)
    LEFT JOIN (
      SELECT o.shop_id, oi.ozon_sku, MAX(NULLIF(oi.ozon_image_url, '')) AS image_url
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE COALESCE(oi.ozon_image_url, '') != ''
      GROUP BY o.shop_id, oi.ozon_sku
    ) oi_img ON oi_img.shop_id = ad.shop_id AND oi_img.ozon_sku = ad.ozon_sku
    WHERE ${where.join(" AND ")}
    ORDER BY ad.date_key DESC, ad.spend_rub DESC, ad.campaign_name ASC
    LIMIT 500
  `, detailParams);

  return { rows: rows.map(rowMetrics), from, to };
}

export async function upsertAdvertisingDailyRowsMysql(body = {}) {
  await ensureAdDailySchema();
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return { inserted: 0, updated: 0, total: 0 };

  let affected = 0;
  for (const row of rows) {
    const shopId = Number(row.shop_id || row.shopId || body.shop_id || body.shopId);
    const dateKey = String(row.date_key || row.date || body.date_key || body.date || "").slice(0, 10);
    const ozonSku = String(row.ozon_sku || row.ozonSku || "").trim();
    if (!shopId || !dateKey || !ozonSku) {
      const error = new Error("shop_id, date_key/date and ozon_sku are required for every advertising row");
      error.status = 400;
      throw error;
    }

    const rawJson = row.raw_json
      ? (typeof row.raw_json === "string" ? row.raw_json : JSON.stringify(row.raw_json))
      : JSON.stringify(row);

    const result = await mysqlExecute(`
      INSERT INTO ozon_ad_sku_daily (
        date_key, shop_id, ozon_sku, campaign_id, campaign_name, campaign_state, campaign_budget_rub,
        campaign_strategy, campaign_payment_type, campaign_placement, campaign_bid_rub, campaign_target_cir, ad_type,
        product_id, offer_id, product_name, spend_rub, spend_cny, impressions,
        clicks, add_to_cart, add_to_cart_available, orders, units, revenue_rub, revenue_cny, source, raw_json, synced_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        campaign_name = VALUES(campaign_name),
        campaign_state = VALUES(campaign_state),
        campaign_budget_rub = VALUES(campaign_budget_rub),
        campaign_strategy = VALUES(campaign_strategy),
        campaign_payment_type = VALUES(campaign_payment_type),
        campaign_placement = VALUES(campaign_placement),
        campaign_bid_rub = VALUES(campaign_bid_rub),
        campaign_target_cir = VALUES(campaign_target_cir),
        product_id = VALUES(product_id),
        offer_id = VALUES(offer_id),
        product_name = VALUES(product_name),
        spend_rub = VALUES(spend_rub),
        spend_cny = VALUES(spend_cny),
        impressions = VALUES(impressions),
        clicks = VALUES(clicks),
        add_to_cart = VALUES(add_to_cart),
        add_to_cart_available = VALUES(add_to_cart_available),
        orders = VALUES(orders),
        units = VALUES(units),
        revenue_rub = VALUES(revenue_rub),
        revenue_cny = VALUES(revenue_cny),
        source = VALUES(source),
        raw_json = VALUES(raw_json),
        synced_at = VALUES(synced_at),
        updated_at = NOW()
    `, [
      dateKey,
      shopId,
      ozonSku,
      String(row.campaign_id || row.campaignId || ""),
      row.campaign_name || row.campaignName || null,
      row.campaign_state || row.campaignState || null,
      toNumber(row.campaign_budget_rub || row.campaignBudgetRub || row.budget_rub || row.budgetRub),
      row.campaign_strategy || row.campaignStrategy || null,
      row.campaign_payment_type || row.campaignPaymentType || null,
      row.campaign_placement || row.campaignPlacement || null,
      toNumber(row.campaign_bid_rub || row.campaignBidRub || row.bidRub),
      toNumber(row.campaign_target_cir || row.campaignTargetCir || row.targetCir),
      String(row.ad_type || row.adType || "unknown"),
      row.product_id || row.productId || null,
      row.offer_id || row.offerId || null,
      row.product_name || row.productName || null,
      toNumber(row.spend_rub || row.spendRub),
      toNumber(row.spend_cny || row.spendCny),
      Math.round(toNumber(row.impressions)),
      Math.round(toNumber(row.clicks)),
      Math.round(toNumber(row.add_to_cart || row.addToCart || row.to_cart || row.toCart)),
      Math.round(toNumber(row.add_to_cart_available || row.addToCartAvailable)),
      Math.round(toNumber(row.orders)),
      Math.round(toNumber(row.units)),
      toNumber(row.revenue_rub || row.revenueRub),
      toNumber(row.revenue_cny || row.revenueCny),
      String(row.source || body.source || "manual"),
      rawJson
    ]);
    affected += Number(result.affectedRows || 0);
  }

  return {
    total: rows.length,
    inserted_or_updated: rows.length,
    affected_rows: affected
  };
}

export async function advertisingPilotShopMysql() {
  await ensurePerformanceCredentialSchema();
  const rows = await mysqlQuery(`
    SELECT id, name
    FROM shops
    WHERE status = 'active'
      AND COALESCE(NULLIF(TRIM(performance_client_id), ''), '') <> ''
      AND COALESCE(NULLIF(TRIM(performance_client_secret), ''), NULLIF(TRIM(performance_client_secret_hint), ''), '') <> ''
    ORDER BY id
    LIMIT 1
  `);
  return rows?.[0] || null;
}

export async function syncAdvertisingDailyFromOzonMysql(body = {}, options = {}) {
  await ensureAdDailySchema();
  await ensurePerformanceCredentialSchema();
  const { from, to } = buildDateRange(body);
  const shopId = Number(body.shop_id || body.shopId || 0);
  const shopIds = Array.isArray(body.shop_ids || body.shopIds)
    ? (body.shop_ids || body.shopIds).map((item) => Number(item || 0)).filter((item) => item > 0)
    : [];
  const shops = await mysqlQuery(`
    SELECT *
    FROM shops
    WHERE status = 'active'
      AND (? = 0 OR id = ?)
      AND (${shopIds.length ? `id IN (${shopIds.map(() => "?").join(", ")})` : "1=1"})
    ORDER BY id
  `, [shopId, shopId, ...shopIds]);

  let totalRows = 0;
  let imported = 0;
  const results = [];
  const errors = [];

  for (const shop of shops) {
    const clientId = String(shop.performance_client_id || "").trim();
    const clientSecret = String(shop.performance_client_secret || "").trim();
    await logAdvertisingSyncEvent(body, {
      stepKey: "shop_start",
      status: "info",
      shopId: shop.id,
      shopName: shop.name,
      message: "Starting shop advertising sync"
    });
    if (!clientId || !clientSecret) {
      errors.push(`${shop.name || shop.id}: 缺少 Ozon Performance API Client ID / Secret`);
      results.push({ shop_id: shop.id, shop_name: shop.name, fetched: 0, imported: 0, status: "missing_credentials" });
      await logAdvertisingSyncEvent(body, {
        stepKey: "shop_skip",
        status: "warning",
        shopId: shop.id,
        shopName: shop.name,
        message: "Missing performance credentials"
      });
      continue;
    }

    try {
      await logAdvertisingSyncEvent(body, {
        stepKey: "fetch_token",
        status: "info",
        shopId: shop.id,
        shopName: shop.name,
        message: "Fetching performance token"
      });
      const token = await fetchPerformanceToken({ clientId, clientSecret }, options);
      const campaigns = await fetchPerformanceCampaigns(token, options);
      const forbiddenCampaigns = await forbiddenCampaignIdsMysql(shop.id);
      const selectedCampaigns = filterCampaigns(campaigns, body).filter((campaign) => !forbiddenCampaigns.has(String(campaign.id || "")));
      await hydrateCampaignProductSettings(token, selectedCampaigns, options);
      await refreshCampaignMetadataRows(shop.id, selectedCampaigns, { from, to });
      await refreshCampaignProductSettingsRows(shop.id, selectedCampaigns, { from, to });
      await cleanupInactivePendingAdvertisingRowsMysql(shop.id, selectedCampaigns, { from, to });
      const targetPendingRemaining = await countTargetPendingAdvertisingRowsMysql(shop.id, body, { from, to });
      if (targetPendingRemaining.checked && targetPendingRemaining.count === 0) {
        results.push({
          shop_id: shop.id,
          shop_name: shop.name,
          campaigns: selectedCampaigns.length,
          fetched: 0,
          imported: 0,
          placeholder_rows: 0,
          status: "target_sku_cleared"
        });
        continue;
      }
      if (body.metadata_only || body.metadataOnly) {
        results.push({
          shop_id: shop.id,
          shop_name: shop.name,
          campaigns: selectedCampaigns.length,
          budget_campaigns: selectedCampaigns.filter((campaign) => Number(campaign.budgetRub || 0) > 0).length,
          fetched: 0,
          imported: 0,
          status: "metadata_ok"
        });
        continue;
      }
      if (!selectedCampaigns.length) {
        results.push({
          shop_id: shop.id,
          shop_name: shop.name,
          fetched: 0,
          imported: 0,
          status: "no_campaigns",
          error_code: "no_syncable_campaigns"
        });
        await logAdvertisingSyncEvent(body, {
          stepKey: "shop_finish",
          status: "warning",
          shopId: shop.id,
          shopName: shop.name,
          message: "No syncable campaigns for current run"
        });
        continue;
      }

      const reportRows = await fetchPerformanceSkuStats(token, {
        from,
        to,
        campaigns: selectedCampaigns,
        shop_id: shop.id,
        shop_name: shop.name,
        campaign_chunk_size: body.campaign_chunk_size || body.campaignChunkSize,
        report_retry_delay_ms: body.report_retry_delay_ms || body.reportRetryDelayMs,
        report_poll_delay_ms: body.report_poll_delay_ms || body.reportPollDelayMs,
        report_initial_delay_ms: body.report_initial_delay_ms || body.reportInitialDelayMs,
        report_missing_retry_delay_ms: body.report_missing_retry_delay_ms || body.reportMissingRetryDelayMs,
        report_create_attempts: body.report_create_attempts || body.reportCreateAttempts,
        report_poll_attempts: body.report_poll_attempts || body.reportPollAttempts,
        run_id: body.run_id || body.runId || 0,
        job_key: body.job_key || body.jobKey || "",
        report_stats: {},
        signal: options.signal
      });
      const reportStats = reportRows.reportStats || {};
      const normalized = reportRows
        .map((row) => normalizePerformanceAdRow(row, shop, selectedCampaigns))
        .filter((row) => row.date_key && row.shop_id && row.ozon_sku && row.ozon_sku !== "0");
      const placeholders = reportStats.retryLaterCampaigns > 0
        ? await buildPendingAdvertisingRowsMysql(shop, selectedCampaigns, { from, to, normalized })
        : [];
      const rowsToUpsert = [...normalized, ...placeholders];

      totalRows += reportRows.length;
      if (rowsToUpsert.length) {
        const result = await upsertAdvertisingDailyRowsMysql({
          source: "ozon_performance_api",
          rows: rowsToUpsert
        });
        imported += Number(result.total || rowsToUpsert.length);
      }
      const shopStatus = reportStats.retryLaterCampaigns > 0 ? "report_pending" : "ok";
      results.push({
        shop_id: shop.id,
        shop_name: shop.name,
        campaigns: selectedCampaigns.length,
        fetched: reportRows.length,
        imported: rowsToUpsert.length,
        placeholder_rows: placeholders.length,
        retry_later_campaigns: reportStats.retryLaterCampaigns || 0,
        status: shopStatus,
        warning: shopStatus === "report_pending" ? "Ozon report is not ready; placeholder rows were written" : ""
      });
      await logAdvertisingSyncEvent(body, {
        stepKey: "shop_finish",
        status: shopStatus === "ok" ? "success" : "warning",
        shopId: shop.id,
        shopName: shop.name,
        message: shopStatus === "ok" ? "Shop advertising sync finished" : "Shop advertising report pending",
        detail: {
          campaigns: selectedCampaigns.length,
          fetched: reportRows.length,
          imported: rowsToUpsert.length,
          placeholderRows: placeholders.length,
          retryLaterCampaigns: reportStats.retryLaterCampaigns || 0
        }
      });
    } catch (error) {
      const classified = classifyAdvertisingSyncError(error);
      errors.push(`${shop.name || shop.id}: ${classified.message}`);
      results.push({
        shop_id: shop.id,
        shop_name: shop.name,
        fetched: 0,
        imported: 0,
        status: "error",
        error: classified.message,
        error_code: classified.code
      });
      await logAdvertisingSyncEvent(body, {
        stepKey: "shop_error",
        status: "error",
        shopId: shop.id,
        shopName: shop.name,
        message: classified.message,
        detail: { error_code: classified.code }
      });
    }
  }

  return {
    from,
    to,
    shop_ids: shops.map((shop) => Number(shop.id)),
    total_rows: totalRows,
    imported,
    retry_later_campaigns: results.reduce((sum, item) => sum + Number(item.retry_later_campaigns || 0), 0),
    placeholder_rows: results.reduce((sum, item) => sum + Number(item.placeholder_rows || 0), 0),
    results,
    errors
  };
}

export async function updateAdvertisingCampaignProductSettingMysql(body = {}, options = {}) {
  await ensureAdDailySchema();
  const shop = await resolvePerformanceShop(body);
  const campaignId = String(body.campaign_id || body.campaignId || "").trim();
  const sku = String(body.ozon_sku || body.sku || "").trim();
  const mode = String(body.mode || "").trim();
  if (!campaignId || !sku) throw new Error("campaign_id 和 ozon_sku 不能为空");
  if (!["bid", "targetCir"].includes(mode)) throw new Error("mode 只能是 bid 或 targetCir");

  const token = await fetchPerformanceToken({
    clientId: String(shop.performance_client_id || "").trim(),
    clientSecret: String(shop.performance_client_secret || "").trim()
  }, options);
  const value = mode === "bid" ? toNumber(body.bid_rub || body.bidRub) : toNumber(body.target_cir || body.targetCir);
  if (value <= 0) throw new Error(mode === "bid" ? "点击出价必须大于 0" : "目标广告费用份额必须大于 0");

  const product = mode === "bid"
    ? { sku, bid: String(Math.round(value * 1000000)) }
    : { sku, targetCir: value };
  const payload = { products: [product] };
  let result;
  try {
    result = await performanceRequest(`/api/client/campaign/${campaignId}/v2/products`, payload, { ...options, token, method: "PUT" });
  } catch (error) {
    const message = String(error?.message || "");
    if (!message.includes("HTTP 405")) throw error;
    try {
      result = await performanceRequest(`/api/client/campaign/${campaignId}/v2/products`, payload, { ...options, token, method: "POST" });
    } catch (fallbackError) {
      const fallbackMessage = String(fallbackError?.message || "");
      if (fallbackMessage.includes("HTTP 405")) {
        throw new Error(
          mode === "targetCir"
            ? "Ozon 当前不允许通过 API 修改这个广告活动的目标广告费用份额，请先到 Ozon 后台手动调整。"
            : "Ozon 当前不允许通过 API 修改这个广告活动的点击出价，请先到 Ozon 后台手动调整。"
        );
      }
      throw fallbackError;
    }
  }

  const { from, to } = buildDateRange(body);
  if (mode === "bid") {
    await mysqlExecute(`
      UPDATE ozon_ad_sku_daily
      SET campaign_bid_rub = ?, synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE shop_id = ? AND campaign_id = ? AND ozon_sku = ? AND date_key BETWEEN ? AND ?
    `, [value, Number(shop.id), campaignId, sku, from, to]);
  } else {
    await mysqlExecute(`
      UPDATE ozon_ad_sku_daily
      SET campaign_target_cir = ?, synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE shop_id = ? AND campaign_id = ? AND ozon_sku = ? AND date_key BETWEEN ? AND ?
    `, [value, Number(shop.id), campaignId, sku, from, to]);
  }

  return { ok: true, shop_id: shop.id, campaign_id: campaignId, ozon_sku: sku, mode, value, result };
}

export async function applyAdvertisingCampaignProductSettingMysql(body = {}) {
  await ensureAdDailySchema();
  const shop = await resolvePerformanceShop(body);
  const campaignId = String(body.campaign_id || body.campaignId || "").trim();
  const sku = String(body.ozon_sku || body.sku || "").trim();
  const mode = String(body.mode || "").trim();
  if (!campaignId || !sku) throw new Error("campaign_id and ozon_sku are required");
  if (!["bid", "targetCir"].includes(mode)) throw new Error("mode must be bid or targetCir");
  const value = mode === "bid" ? toNumber(body.bid_rub || body.bidRub) : toNumber(body.target_cir || body.targetCir);
  if (value <= 0) throw new Error(mode === "bid" ? "点击出价必须大于 0" : "目标广告费用份额必须大于 0");

  const { from, to } = buildDateRange(body);
  if (mode === "bid") {
    await mysqlExecute(`
      UPDATE ozon_ad_sku_daily
      SET campaign_bid_rub = ?, synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE shop_id = ? AND campaign_id = ? AND ozon_sku = ? AND date_key BETWEEN ? AND ?
    `, [value, Number(shop.id), campaignId, sku, from, to]);
  } else {
    await mysqlExecute(`
      UPDATE ozon_ad_sku_daily
      SET campaign_target_cir = ?, synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE shop_id = ? AND campaign_id = ? AND ozon_sku = ? AND date_key BETWEEN ? AND ?
    `, [value, Number(shop.id), campaignId, sku, from, to]);
  }

  return { ok: true, shop_id: shop.id, campaign_id: campaignId, ozon_sku: sku, mode, value };
}

export async function stopAdvertisingCampaignMysql(body = {}, options = {}) {
  await ensureAdDailySchema();
  const shop = await resolvePerformanceShop(body);
  const campaignId = String(body.campaign_id || body.campaignId || "").trim();
  if (!campaignId) throw new Error("campaign_id 不能为空");
  const token = await fetchPerformanceToken({
    clientId: String(shop.performance_client_id || "").trim(),
    clientSecret: String(shop.performance_client_secret || "").trim()
  }, options);
  const result = await performanceRequest(`/api/client/campaign/${campaignId}/deactivate`, null, { ...options, token, method: "POST" });
  const { from, to } = buildDateRange(body);
  await mysqlExecute(`
    UPDATE ozon_ad_sku_daily
    SET campaign_state = 'stopped', synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE shop_id = ? AND campaign_id = ? AND date_key BETWEEN ? AND ?
  `, [Number(shop.id), campaignId, from, to]);
  return { ok: true, shop_id: shop.id, campaign_id: campaignId, result };
}

async function resolvePerformanceShop(body = {}) {
  await ensurePerformanceCredentialSchema();
  const shopId = Number(body.shop_id || body.shopId || 0);
  if (!shopId) throw new Error("shop_id 不能为空");
  const rows = await mysqlQuery(`
    SELECT *
    FROM shops
    WHERE id = ? AND status = 'active'
    LIMIT 1
  `, [shopId]);
  const shop = rows?.[0];
  if (!shop) throw new Error("未找到可用店铺");
  if (!String(shop.performance_client_id || "").trim() || !String(shop.performance_client_secret || "").trim()) {
    throw new Error("当前店铺缺少 Ozon Performance API Client ID / Secret");
  }
  return shop;
}

async function refreshCampaignMetadataRows(shopId, campaigns = [], range = {}) {
  const rows = campaigns.filter((campaign) => campaign.id);
  for (const campaign of rows) {
    await mysqlExecute(`
      UPDATE ozon_ad_sku_daily
      SET campaign_name = COALESCE(NULLIF(?, ''), campaign_name),
          campaign_state = COALESCE(NULLIF(?, ''), campaign_state),
          campaign_budget_rub = COALESCE(NULLIF(?, 0), campaign_budget_rub),
          campaign_strategy = COALESCE(NULLIF(?, ''), campaign_strategy),
          campaign_payment_type = COALESCE(NULLIF(?, ''), campaign_payment_type),
          campaign_placement = COALESCE(NULLIF(?, ''), campaign_placement),
          updated_at = NOW()
      WHERE shop_id = ?
        AND campaign_id = ?
        AND date_key >= ?
        AND date_key <= ?
    `, [
      campaign.title || "",
      campaign.state || "",
      toNumber(campaign.budgetRub),
      campaign.strategy || "",
      campaign.paymentType || "",
      campaign.placement || "",
      Number(shopId),
      String(campaign.id),
      range.from,
      range.to
    ]);
  }
}

async function refreshCampaignProductSettingsRows(shopId, campaigns = [], range = {}) {
  for (const campaign of campaigns) {
    const settings = campaign.productSettings || [];
    for (const product of settings) {
      await mysqlExecute(`
        UPDATE ozon_ad_sku_daily
        SET campaign_bid_rub = COALESCE(NULLIF(?, 0), campaign_bid_rub),
            campaign_target_cir = COALESCE(NULLIF(?, 0), campaign_target_cir),
            updated_at = NOW()
        WHERE shop_id = ?
          AND campaign_id = ?
          AND ozon_sku = ?
          AND date_key >= ?
          AND date_key <= ?
      `, [
        toNumber(product.bidRub),
        toNumber(product.targetCir),
        Number(shopId),
        String(campaign.id),
        String(product.sku),
        range.from,
        range.to
      ]);
    }
  }
}

function isInactiveAdvertisingState(value) {
  const state = String(value || "").trim().toLowerCase();
  if (!state) return false;
  const inactiveWords = [
    "stopped",
    "stop",
    "paused",
    "pause",
    "archived",
    "archive",
    "deleted",
    "finished",
    "inactive",
    "disabled",
    "ended",
    "blocked",
    "cancelled",
    "canceled"
  ];
  return inactiveWords.some((word) => state.includes(word));
}

function isInactiveCampaign(campaign = {}) {
  return isInactiveAdvertisingState(campaign.state || campaign.status || campaign.campaign_state || campaign.campaignState);
}

function isInactiveCampaignProduct(product = {}) {
  if (product.active === false || product.is_active === false || product.enabled === false || product.is_enabled === false) return true;
  if (product.active === 0 || product.is_active === 0 || product.enabled === 0 || product.is_enabled === 0) return true;
  return isInactiveAdvertisingState(
    product.state
    || product.status
    || product.product_state
    || product.productState
    || product.ad_state
    || product.adState
    || product.campaign_product_state
    || product.campaignProductState
  );
}

async function cleanupInactivePendingAdvertisingRowsMysql(shopId, campaigns = [], range = {}) {
  const from = String(range.from || "").slice(0, 10);
  const to = String(range.to || "").slice(0, 10);
  if (!shopId || !from || !to) return;

  for (const campaign of campaigns) {
    const campaignId = String(campaign.id || "").trim();
    if (!campaignId) continue;
    if (isInactiveCampaign(campaign)) {
      await mysqlExecute(`
        DELETE FROM ozon_ad_sku_daily
        WHERE shop_id = ?
          AND campaign_id = ?
          AND source = 'ozon_performance_pending'
          AND date_key >= ?
          AND date_key <= ?
      `, [Number(shopId), campaignId, from, to]);
      continue;
    }

    if (!campaign.productSettingsFetched) continue;
    const activeSkus = (campaign.productSettings || []).map((product) => String(product.sku || "").trim()).filter(Boolean);
    if (!activeSkus.length) {
      await mysqlExecute(`
        DELETE FROM ozon_ad_sku_daily
        WHERE shop_id = ?
          AND campaign_id = ?
          AND source = 'ozon_performance_pending'
          AND date_key >= ?
          AND date_key <= ?
      `, [Number(shopId), campaignId, from, to]);
      continue;
    }
    await mysqlExecute(`
      DELETE FROM ozon_ad_sku_daily
      WHERE shop_id = ?
        AND campaign_id = ?
        AND source = 'ozon_performance_pending'
        AND date_key >= ?
        AND date_key <= ?
        AND ozon_sku NOT IN (${activeSkus.map(() => "?").join(", ")})
    `, [Number(shopId), campaignId, from, to, ...activeSkus]);
  }
}

async function countTargetPendingAdvertisingRowsMysql(shopId, body = {}, range = {}) {
  const from = String(range.from || "").slice(0, 10);
  const to = String(range.to || "").slice(0, 10);
  const targetSkus = Array.isArray(body.target_skus || body.targetSkus)
    ? (body.target_skus || body.targetSkus).map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (!shopId || !from || !to || !targetSkus.length) return { checked: false, count: 0 };
  const campaignIds = Array.isArray(body.campaign_ids || body.campaignIds)
    ? (body.campaign_ids || body.campaignIds).map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const campaignWhere = campaignIds.length ? `AND campaign_id IN (${campaignIds.map(() => "?").join(", ")})` : "";
  const rows = await mysqlQuery(`
    SELECT COUNT(*) AS total
    FROM ozon_ad_sku_daily
    WHERE shop_id = ?
      AND source = 'ozon_performance_pending'
      AND date_key >= ?
      AND date_key <= ?
      AND ozon_sku IN (${targetSkus.map(() => "?").join(", ")})
      ${campaignWhere}
  `, [Number(shopId), from, to, ...targetSkus, ...campaignIds]);
  return { checked: true, count: Number(rows?.[0]?.total || 0) };
}

async function buildPendingAdvertisingRowsMysql(shop = {}, campaigns = [], context = {}) {
  const normalizedKeys = new Set((context.normalized || []).map((row) => [
    row.date_key,
    row.shop_id,
    row.ozon_sku,
    row.campaign_id,
    row.ad_type
  ].join("|")));
  const dates = dateKeysBetween(context.from, context.to);
  const rows = [];
  for (const campaign of campaigns) {
    if (isInactiveCampaign(campaign)) continue;
    const productSettings = await pendingCampaignProductsMysql(shop, campaign);
    for (const product of productSettings) {
      const sku = String(product.sku || "").trim();
      if (!sku) continue;
      for (const dateKey of dates) {
        const row = {
          date_key: dateKey,
          shop_id: Number(shop.id),
          ozon_sku: sku,
          campaign_id: String(campaign.id || ""),
          campaign_name: campaign.title || "",
          campaign_state: campaign.state || "",
          campaign_budget_rub: campaign.budgetRub || 0,
          campaign_strategy: campaign.strategy || "",
          campaign_payment_type: campaign.paymentType || "",
          campaign_placement: campaign.placement || "",
          campaign_bid_rub: product.bidRub || 0,
          campaign_target_cir: product.targetCir || 0,
          ad_type: campaign.advObjectType || "performance_pending",
          spend_rub: 0,
          spend_cny: 0,
          impressions: 0,
          clicks: 0,
          add_to_cart: 0,
          add_to_cart_available: 0,
          orders: 0,
          units: 0,
          revenue_rub: 0,
          revenue_cny: 0,
          source: "ozon_performance_pending",
          raw_json: {
            pending: true,
            reason: "ozon_report_not_ready",
            campaign_id: String(campaign.id || ""),
            sku
          }
        };
        const key = [row.date_key, row.shop_id, row.ozon_sku, row.campaign_id, row.ad_type].join("|");
        if (!normalizedKeys.has(key)) rows.push(row);
      }
    }
  }
  if (!rows.length) return [];
  const skus = Array.from(new Set(rows.map((row) => row.ozon_sku)));
  const existingRows = await mysqlQuery(`
    SELECT date_key, shop_id, ozon_sku, campaign_id, ad_type, source
    FROM ozon_ad_sku_daily
    WHERE shop_id = ?
      AND date_key IN (${dates.map(() => "?").join(", ")})
      AND ozon_sku IN (${skus.map(() => "?").join(", ")})
  `, [Number(shop.id), ...dates, ...skus]);
  const existingRealKeys = new Set(existingRows
    .filter((row) => String(row.source || "") !== "ozon_performance_pending")
    .map((row) => [row.date_key, row.shop_id, row.ozon_sku, row.campaign_id, row.ad_type].join("|")));
  const productRows = await mysqlQuery(`
    SELECT shop_id, ozon_sku, ozon_product_id, offer_id, name
    FROM online_products
    WHERE shop_id = ?
      AND ozon_sku IN (${skus.map(() => "?").join(", ")})
  `, [Number(shop.id), ...skus]);
  const productsBySku = new Map(productRows.map((row) => [String(row.ozon_sku), row]));
  return rows.filter((row) => !existingRealKeys.has([
    row.date_key,
    row.shop_id,
    row.ozon_sku,
    row.campaign_id,
    row.ad_type
  ].join("|"))).map((row) => {
    const product = productsBySku.get(String(row.ozon_sku)) || {};
    return {
      ...row,
      product_id: product.ozon_product_id || null,
      offer_id: product.offer_id || "",
      product_name: product.name || ""
    };
  });
}

async function pendingCampaignProductsMysql(shop = {}, campaign = {}) {
  const settings = Array.isArray(campaign.productSettings) ? campaign.productSettings : [];
  if (campaign.productSettingsFetched) return settings.filter((product) => String(product.sku || "").trim());
  const productsBySku = new Map(settings.map((product) => [String(product.sku || "").trim(), product]).filter(([sku]) => sku));
  const historicalRows = await mysqlQuery(`
    SELECT ozon_sku, MAX(campaign_bid_rub) AS bid_rub, MAX(campaign_target_cir) AS target_cir
    FROM ozon_ad_sku_daily
    WHERE shop_id = ?
      AND campaign_id = ?
      AND ozon_sku <> ''
    GROUP BY ozon_sku
    ORDER BY MAX(updated_at) DESC
    LIMIT 500
  `, [Number(shop.id), String(campaign.id || "")]);
  for (const row of historicalRows) {
    const sku = String(row.ozon_sku || "").trim();
    if (!sku || productsBySku.has(sku)) continue;
    productsBySku.set(sku, {
      sku,
      bidRub: toNumber(row.bid_rub),
      targetCir: toNumber(row.target_cir)
    });
  }
  return Array.from(productsBySku.values());
}

function dateKeysBetween(from, to) {
  const start = new Date(`${String(from || to || todayKey()).slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${String(to || from || todayKey()).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [todayKey()];
  const dates = [];
  for (const date = new Date(start); date <= end && dates.length < 90; date.setUTCDate(date.getUTCDate() + 1)) {
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates.length ? dates : [String(to || from || todayKey()).slice(0, 10)];
}

async function fetchPerformanceToken(credentials, options = {}) {
  const data = await performanceRequest("/api/client/token", {
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    grant_type: "client_credentials"
  }, { ...options, auth: false });
  const token = data.access_token || data.token || data.result?.access_token;
  if (!token) throw new Error("Performance API 没有返回 access_token");
  return token;
}

async function fetchPerformanceCampaigns(token, options = {}) {
  const candidates = [
    ["/api/client/campaign", "GET", null],
    ["/api/client/campaign?advObjectType=SKU", "GET", null],
    ["/api/client/campaign?advObjectType=PRODUCT", "GET", null]
  ];
  const campaigns = [];
  let lastError = null;
  for (const [path, method, payload] of candidates) {
    try {
      const data = await performanceRequest(path, payload, { ...options, token, method });
      const rows = normalizeCampaignResponse(data);
      for (const campaign of rows) if (campaign.id) campaigns.push(campaign);
    } catch (error) {
      lastError = error;
    }
  }
  const unique = new Map(campaigns.map((campaign) => [String(campaign.id), campaign]));
  if (!unique.size && lastError) throw lastError;
  return [...unique.values()];
}

async function forbiddenCampaignIdsMysql(shopId) {
  if (!shopId) return new Set();
  const rows = await mysqlQuery(`
    SELECT campaign_id
    FROM ozon_ad_forbidden_campaigns
    WHERE shop_id = ?
      AND updated_at >= ?
  `, [Number(shopId), forbiddenCampaignCutoff()]);
  return new Set(rows.map((row) => String(row.campaign_id || "").trim()).filter(Boolean));
}

function forbiddenCampaignCutoff() {
  return new Date(Date.now() - FORBIDDEN_CAMPAIGN_RETRY_HOURS * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

async function markForbiddenCampaignMysql(shopId, campaignId, reason = "") {
  if (!shopId || !campaignId) return;
  await mysqlExecute(`
    INSERT INTO ozon_ad_forbidden_campaigns (shop_id, campaign_id, reason)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE
      reason = VALUES(reason),
      updated_at = CURRENT_TIMESTAMP
  `, [Number(shopId), String(campaignId), String(reason || "").slice(0, 255)]);
}

function normalizeCampaignResponse(data = {}) {
  const raw = data.list || data.campaigns || data.items || data.result?.list || data.result?.campaigns || data.result?.items || data.result || [];
  const rows = Array.isArray(raw) ? raw : [];
  return rows.map((item) => ({
    id: String(item.id || item.campaign_id || item.campaignId || ""),
    title: String(item.title || item.name || item.campaign_name || item.campaignName || ""),
    state: String(item.state || item.status || ""),
    budgetRub: campaignBudgetRub(item),
    advObjectType: String(item.advObjectType || item.adv_object_type || item.type || ""),
    strategy: String(item.productAutopilotStrategy || item.autopilotStrategy || item.strategy || ""),
    paymentType: String(item.PaymentType || item.paymentType || item.payment_type || ""),
    placement: normalizeCampaignPlacement(item.placement || item.ProductAdvPlacements || item.productAdvPlacements)
  })).filter((item) => item.id);
}

function normalizeCampaignPlacement(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean).join(", ");
  return String(value || "");
}

async function hydrateCampaignProductSettings(token, campaigns = [], options = {}) {
  for (const campaign of campaigns) {
    try {
      const data = await performanceRequest(`/api/client/campaign/${campaign.id}/v2/products`, null, { ...options, token, method: "GET" });
      const rows = Array.isArray(data.products) ? data.products : Array.isArray(data.list) ? data.list : [];
      campaign.productSettingsFetched = true;
      campaign.productSettings = rows
        .filter((row) => !isInactiveCampaignProduct(row))
        .map((row) => ({
          sku: String(row.sku || row.ozon_sku || row.product_sku || "").trim(),
          bidRub: normalizePerformanceMoney(firstNumber(row.bid, row.bidRub, row.bid_rub, row.cpc, row.price)),
          targetCir: firstNumber(row.targetCir, row.target_cir, row.targetDRR, row.target_drr, row.drr),
          state: String(row.state || row.status || row.product_state || row.productState || row.ad_state || row.adState || "")
        }))
        .filter((row) => row.sku);
      campaign.productsBySku = new Map(campaign.productSettings.map((row) => [row.sku, row]));
    } catch {
      campaign.productSettingsFetched = false;
      campaign.productSettings = [];
      campaign.productsBySku = new Map();
    }
  }
  return campaigns;
}

function campaignBudgetRub(item = {}) {
  const rawBudget = firstPositiveNumber(
    item.dailyBudget, item.daily_budget, item.budgetRub, item.budget_rub, item.budget,
    item.limit, item.dailyLimit, item.daily_limit, item.expenseLimit, item.expense_limit,
    item.limits?.dailyBudget, item.limits?.daily_budget, item.limits?.daily, item.limits?.budget,
    item.settings?.dailyBudget, item.settings?.daily_budget, item.settings?.budget,
    item.money?.dailyBudget, item.money?.daily_budget, item.money?.budget,
    item.weeklyBudget, item.weekly_budget, item.weeklyLimit, item.weekly_limit,
    item.limits?.weeklyBudget, item.limits?.weekly_budget, item.limits?.weekly,
    item.settings?.weeklyBudget, item.settings?.weekly_budget
  );
  return normalizePerformanceMoney(rawBudget);
}

function normalizePerformanceMoney(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  if (Math.abs(number) >= 1000000) return number / 1000000;
  return number;
}

function filterCampaigns(campaigns = [], body = {}) {
  const explicit = (body.campaign_ids || body.campaignIds || [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (explicit.length) {
    const allowed = new Set(explicit);
    return campaigns.filter((campaign) => allowed.has(String(campaign.id)));
  }
  const includeInactive = body.include_inactive ?? body.includeInactive;
  const filtered = includeInactive !== false ? campaigns : campaigns.filter((campaign) => {
    const state = String(campaign.state || "").toLowerCase();
    return !["archived", "stopped", "deleted"].some((value) => state.includes(value));
  });
  const maxCampaignsPerShop = Math.max(0, Number(body.max_campaigns_per_shop || body.maxCampaignsPerShop || 0));
  if (!maxCampaignsPerShop) return filtered;
  const start = Math.max(0, Number(body.campaign_cursor || body.campaignCursor || 0));
  const selected = [];
  for (let index = 0; index < Math.min(maxCampaignsPerShop, filtered.length); index += 1) {
    selected.push(filtered[(start + index) % filtered.length]);
  }
  return selected;
}

export async function countSyncableAdvertisingCampaignsForShopsMysql(body = {}, options = {}) {
  await ensurePerformanceCredentialSchema();
  const shopIds = Array.isArray(body.shop_ids || body.shopIds)
    ? (body.shop_ids || body.shopIds).map((item) => Number(item || 0)).filter((item) => item > 0)
    : [];
  if (!shopIds.length) return { count: 0, byShop: [] };
  const shops = await mysqlQuery(`
    SELECT *
    FROM shops
    WHERE status = 'active'
      AND id IN (${shopIds.map(() => "?").join(", ")})
    ORDER BY id
  `, shopIds);
  const byShop = [];
  let count = 0;
  for (const shop of shops) {
    const clientId = String(shop.performance_client_id || "").trim();
    const clientSecret = String(shop.performance_client_secret || "").trim();
    if (!clientId || !clientSecret) {
      byShop.push({ shop_id: Number(shop.id), shop_name: shop.name || "", count: 0, status: "missing_credentials" });
      continue;
    }
    try {
      const token = await fetchPerformanceToken({ clientId, clientSecret }, options);
      const campaigns = await fetchPerformanceCampaigns(token, options);
      const forbiddenCampaigns = await forbiddenCampaignIdsMysql(shop.id);
      const syncable = filterCampaigns(campaigns, { ...body, max_campaigns_per_shop: 0 })
        .filter((campaign) => !forbiddenCampaigns.has(String(campaign.id || "")));
      count += syncable.length;
      byShop.push({ shop_id: Number(shop.id), shop_name: shop.name || "", count: syncable.length, status: "ok" });
    } catch (error) {
      byShop.push({ shop_id: Number(shop.id), shop_name: shop.name || "", count: 0, status: "error", error: error?.message || String(error) });
    }
  }
  return { count, byShop };
}

async function fetchPerformanceSkuStats(token, options = {}) {
  const campaigns = options.campaigns || [];
  const campaignChunkSize = Math.max(1, Math.min(3, Number(options.campaign_chunk_size || options.campaignChunkSize || 1)));
  const rows = [];
  const reportStats = options.report_stats || {};
  reportStats.retryLaterCampaigns = Number(reportStats.retryLaterCampaigns || 0);
  reportStats.skippedCampaigns = Number(reportStats.skippedCampaigns || 0);
  const windows = splitDateRange(options.from, options.to, 62);
  for (const window of windows) {
    for (let index = 0; index < campaigns.length; index += campaignChunkSize) {
      const chunk = campaigns.slice(index, index + campaignChunkSize);
      try {
        const report = await createAndFetchPerformanceReport(token, {
          campaigns: chunk.map((campaign) => String(campaign.id)),
          dateFrom: window.from,
          dateTo: window.to,
          groupBy: "DATE"
        }, options);
        rows.push(...flattenPerformanceReportRows(report, chunk));
      } catch (error) {
        if (chunk.length <= 1) {
          const campaign = chunk[0];
          if (isMissingReportError(error) || isReportEndpointUnavailableError(error)) {
            reportStats.retryLaterCampaigns += 1;
            await logAdvertisingSyncEvent(options, {
              stepKey: "campaign_retry_later",
              status: "warning",
              shopId: options.shop_id,
              shopName: options.shop_name,
              message: `Campaign report not ready ${campaign?.id || ""}`.trim(),
              detail: { campaign_id: campaign?.id || "", reason: error.message || "report_not_ready" }
            });
            continue;
          }
          if (campaign && isCampaignReportUnavailableError(error)) {
            reportStats.skippedCampaigns += 1;
            await markForbiddenCampaignMysql(options.shop_id, campaign.id, error.message || "campaign_report_unavailable");
            await logAdvertisingSyncEvent(options, {
              stepKey: "campaign_skip",
              status: "warning",
              shopId: options.shop_id,
              shopName: options.shop_name,
              message: `Skipping unavailable campaign ${campaign.id}`,
              detail: { campaign_id: campaign.id, reason: error.message || "campaign_report_unavailable" }
            });
            continue;
          }
          throw error;
        }
        if ((!isMissingReportError(error) && !isCampaignReportUnavailableError(error)) || chunk.length <= 1) throw error;
        for (const campaign of chunk) {
          try {
            const report = await createAndFetchPerformanceReport(token, {
              campaigns: [String(campaign.id)],
              dateFrom: window.from,
              dateTo: window.to,
              groupBy: "DATE"
            }, options);
            rows.push(...flattenPerformanceReportRows(report, [campaign]));
          } catch (singleError) {
            if (isMissingReportError(singleError) || isReportEndpointUnavailableError(singleError)) {
              reportStats.retryLaterCampaigns += 1;
              await logAdvertisingSyncEvent(options, {
                stepKey: "campaign_retry_later",
                status: "warning",
                shopId: options.shop_id,
                shopName: options.shop_name,
                message: `Campaign report not ready ${campaign.id}`,
                detail: { campaign_id: campaign.id, reason: singleError.message || "report_not_ready" }
              });
              continue;
            }
            if (isCampaignReportUnavailableError(singleError)) {
              reportStats.skippedCampaigns += 1;
              await markForbiddenCampaignMysql(options.shop_id, campaign.id, singleError.message || "campaign_report_unavailable");
              await logAdvertisingSyncEvent(options, {
                stepKey: "campaign_skip",
                status: "warning",
                shopId: options.shop_id,
                shopName: options.shop_name,
                message: `Skipping unavailable campaign ${campaign.id}`,
                detail: { campaign_id: campaign.id, reason: singleError.message || "campaign_report_unavailable" }
              });
              continue;
            }
            throw singleError;
          }
        }
      }
    }
  }
  rows.reportStats = reportStats;
  return rows;
}

async function createAndFetchPerformanceReport(token, payload, options = {}) {
  const reportRetryDelayMs = Math.max(5000, Number(options.report_retry_delay_ms || options.reportRetryDelayMs || 15000));
  const reportPollDelayMs = Math.max(3000, Number(options.report_poll_delay_ms || options.reportPollDelayMs || 5000));
  const reportInitialDelayMs = Math.max(2000, Number(options.report_initial_delay_ms || options.reportInitialDelayMs || 8000));
  const reportMissingRetryDelayMs = Math.max(reportPollDelayMs, Number(options.report_missing_retry_delay_ms || options.reportMissingRetryDelayMs || 10000));
  const reportCreateAttempts = Math.max(1, Math.min(3, Number(options.report_create_attempts || options.reportCreateAttempts || 2)));
  const reportPollAttempts = Math.max(6, Math.min(24, Number(options.report_poll_attempts || options.reportPollAttempts || 12)));
  const createPayload = {
    campaigns: payload.campaigns,
    dateFrom: payload.dateFrom,
    dateTo: payload.dateTo,
    groupBy: payload.groupBy
  };
  const createCandidates = [
    "/api/client/statistics/json",
    "/api/client/statistics/products/json"
  ];
  let lastError = null;
  for (const path of createCandidates) {
    for (let createAttempt = 0; createAttempt < reportCreateAttempts; createAttempt += 1) {
      let createData = null;
      await logAdvertisingSyncEvent(options, {
        stepKey: "create_report",
        status: "info",
        shopId: options.shop_id,
        shopName: options.shop_name,
        attempt: createAttempt + 1,
        message: `Creating performance report via ${path}`,
        detail: {
          campaigns: Array.isArray(payload.campaigns) ? payload.campaigns.slice(0, 10) : [],
          from: payload.dateFrom,
          to: payload.dateTo
        }
      });
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          createData = await performanceRequest(path, createPayload, { ...options, token });
          break;
        } catch (error) {
          lastError = error;
          if (!isActiveReportLimitError(error)) break;
          await sleep(reportRetryDelayMs + attempt * 5000);
        }
      }

      if (!createData) continue;
      const uuid = createData.UUID || createData.uuid || createData.report_id || createData.result?.UUID || createData.result?.uuid;
      if (!uuid) return createData;
      await logAdvertisingSyncEvent(options, {
        stepKey: "report_uuid",
        status: "info",
        shopId: options.shop_id,
        shopName: options.shop_name,
        attempt: createAttempt + 1,
        message: `Created performance report ${uuid}`,
        detail: { uuid }
      });
      if (reportInitialDelayMs > 0) await sleep(reportInitialDelayMs);

      let sawMissingReport = false;
      for (let attempt = 0; attempt < reportPollAttempts; attempt += 1) {
        let missingReportAttempt = false;
        const pathCandidates = [
          `/api/client/statistics/report?UUID=${encodeURIComponent(uuid)}`,
          `/api/client/statistics/${encodeURIComponent(uuid)}`
        ];
        for (const reportPath of pathCandidates) {
          try {
            await logAdvertisingSyncEvent(options, {
              stepKey: "poll_report",
              status: "info",
              shopId: options.shop_id,
              shopName: options.shop_name,
              attempt: attempt + 1,
              message: `Polling performance report ${uuid}`,
              detail: { uuid, reportPath }
            });
            const data = await performanceRequest(reportPath, null, { ...options, token, method: "GET" });
            if (isReportReady(data)) return data;
            missingReportAttempt = false;
          } catch (error) {
            lastError = error;
            if (isMissingReportError(error)) {
              sawMissingReport = true;
              missingReportAttempt = true;
              continue;
            }
          }
        }
        if (missingReportAttempt) {
          await sleep(reportMissingRetryDelayMs);
          continue;
        }
        await sleep(reportPollDelayMs);
      }

      if (sawMissingReport) {
        lastError = new Error(`Performance API report ${uuid} failed: report not found after ${reportPollAttempts} poll attempts`);
        continue;
      }
      break;
    }
  }

  throw lastError || new Error("无法创建 Ozon Performance 统计报表");
}

function splitDateRange(from, to, maxDays = 62) {
  const start = parseDateKey(from);
  const end = parseDateKey(to);
  if (!start || !end || start > end) return [{ from, to }];
  const windows = [];
  let cursor = start;
  while (cursor <= end) {
    const windowEnd = new Date(cursor);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + Number(maxDays || 62) - 1);
    if (windowEnd > end) windowEnd.setTime(end.getTime());
    windows.push({ from: formatDateKey(cursor), to: formatDateKey(windowEnd) });
    cursor = new Date(windowEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return windows;
}

function parseDateKey(value) {
  const text = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function isActiveReportLimitError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("активных запрос") || message.includes("active request") || message.includes("active statistics");
}

function isMissingReportError(error) {
  return String(error?.message || "").toLowerCase().includes("report not found");
}

function isForbiddenReportError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("generation of this type of report is forbidden")
    || message.includes("forbidden for the transferred list of campaigns");
}

function isReportEndpointUnavailableError(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("404 page not found")
    || message.includes("http 404");
}

function isCampaignReportUnavailableError(error) {
  return isForbiddenReportError(error) || isReportEndpointUnavailableError(error);
}

function classifyAdvertisingSyncError(error) {
  const message = String(error?.message || error || "Advertising sync failed").trim();
  const lower = message.toLowerCase();
  if (lower.includes("report not found")) return { code: "report_not_found", message };
  if (isReportEndpointUnavailableError(error)) return { code: "report_endpoint_unavailable", message };
  if (lower.includes("timed out") || lower.includes("超时")) return { code: "timeout", message };
  if (lower.includes("access_token") || lower.includes("token")) return { code: "token_error", message };
  if (lower.includes("active request") || lower.includes("active statistics")) return { code: "active_report_limit", message };
  if (lower.includes("client id / secret") || lower.includes("missing_credentials")) return { code: "missing_credentials", message };
  return { code: "unknown", message };
}

async function logAdvertisingSyncEvent(source = {}, event = {}) {
  const runId = Number(source?.run_id || source?.runId || 0);
  const jobKey = String(source?.job_key || source?.jobKey || "");
  if (!runId || !jobKey) return;
  await logScheduledJobEvent({
    runId,
    jobKey,
    stepKey: event.stepKey || "info",
    status: event.status || "info",
    shopId: event.shopId || null,
    shopName: event.shopName || "",
    attempt: event.attempt || 0,
    message: event.message || "",
    detail: event.detail
  }).catch(() => {});
}

function isReportReady(data = {}) {
  const state = String(data.state || data.status || data.result?.state || data.result?.status || "").toLowerCase();
  if (["error", "failed"].some((value) => state.includes(value))) throw new Error(`Ozon Performance 报表生成失败: ${state}`);
  if (!state) return true;
  return ["ok", "done", "success", "ready", "completed"].some((value) => state.includes(value));
}

function flattenPerformanceReportRows(data = {}, campaigns = []) {
  const campaignById = new Map(campaigns.map((campaign) => [String(campaign.id), campaign]));
  const groupedRows = [];
  for (const [key, value] of Object.entries(data || {})) {
    if (!value || typeof value !== "object" || !value.report) continue;
    const rows = Array.isArray(value.report?.rows) ? value.report.rows : [];
    const campaign = campaignById.get(String(key)) || { id: String(key), title: value.title || "" };
    for (const row of rows) {
      groupedRows.push({
        ...row,
        campaign_id: String(key),
        campaign_name: campaign.title || value.title || "",
        campaign
      });
    }
  }
  if (groupedRows.length) return groupedRows;

  const candidates = [
    data.rows,
    data.items,
    data.result?.rows,
    data.result?.items,
    data.result?.data,
    data.data,
    Array.isArray(data) ? data : null
  ].filter(Boolean);
  const sourceRows = candidates.find(Array.isArray) || [];
  const flattened = [];
  for (const row of sourceRows) {
    collectReportRows(row, {}, flattened);
  }
  return flattened.map((row) => ({
    ...row,
    campaign: campaignById.get(String(row.campaign_id || row.campaignId || row.id || ""))
  }));
}

function collectReportRows(node, inherited, target) {
  if (!node || typeof node !== "object") return;
  const current = { ...inherited, ...node };
  const children = [
    node.rows,
    node.items,
    node.products,
    node.skus,
    node.children
  ].filter(Array.isArray).flat();

  if (!children.length) {
    target.push(current);
    return;
  }

  const nextInherited = { ...current };
  delete nextInherited.rows;
  delete nextInherited.items;
  delete nextInherited.products;
  delete nextInherited.skus;
  delete nextInherited.children;
  for (const child of children) collectReportRows(child, nextInherited, target);
}

function normalizePerformanceAdRow(row = {}, shop = {}, campaigns = []) {
  const campaignId = String(row.campaign_id || row.campaignId || row.campaign?.id || row.id || "").trim();
  const campaign = row.campaign || campaigns.find((item) => String(item.id) === campaignId) || {};
  const dateKey = normalizePerformanceDate(row.date || row.date_key || row.day || row.period || row.period_from || row.createdAt);
  const sku = String(row.sku || row.ozon_sku || row.product_sku || row.productSku || row.ad_sku || row.id_sku || "").trim();
  const addToCart = adAddToCartMetric(row);
  const revenueRub = performanceAttributedRevenueRub(row);
  const units = performanceAttributedUnits(row);
  const productSetting = campaign.productsBySku?.get(sku) || {};
  return {
    date_key: dateKey,
    shop_id: Number(shop.id),
    ozon_sku: sku,
    campaign_id: campaignId || String(campaign.id || ""),
    campaign_name: row.campaign_name || row.campaignName || campaign.title || "",
    campaign_state: row.campaign_state || row.campaignState || campaign.state || "",
    campaign_budget_rub: firstNumber(row.campaign_budget_rub, row.campaignBudgetRub, row.budget_rub, row.budgetRub, campaign.budgetRub),
    campaign_strategy: row.campaign_strategy || row.campaignStrategy || campaign.strategy || "",
    campaign_payment_type: row.campaign_payment_type || row.campaignPaymentType || campaign.paymentType || "",
    campaign_placement: row.campaign_placement || row.campaignPlacement || campaign.placement || "",
    campaign_bid_rub: firstNumber(row.campaign_bid_rub, row.campaignBidRub, row.bidRub, productSetting.bidRub),
    campaign_target_cir: firstNumber(row.campaign_target_cir, row.campaignTargetCir, row.targetCir, productSetting.targetCir),
    ad_type: row.ad_type || row.adType || campaign.advObjectType || "performance",
    offer_id: row.offer_id || row.offerId || "",
    product_name: row.product_name || row.productName || row.title || row.name || "",
    spend_rub: firstNumber(row.moneySpent, row.expense, row.spend, row.spend_rub, row.cost, row.consumption),
    spend_cny: firstNumber(row.spend_cny, row.spendCny) || roundMoney(firstNumber(row.moneySpent, row.expense, row.spend, row.spend_rub, row.cost, row.consumption) / RUB_CNY_RATE),
    impressions: Math.round(firstNumber(row.views, row.impressions, row.shows, row.show)),
    clicks: Math.round(firstNumber(row.clicks, row.click)),
    add_to_cart: Math.round(addToCart.value),
    add_to_cart_available: addToCart.available ? 1 : 0,
    orders: Math.round(firstNumber(row.orders, row.orders_count, row.ordersCount)),
    units,
    revenue_rub: revenueRub,
    revenue_cny: firstNumber(row.revenue_cny, row.revenueCny) || roundMoney(revenueRub / RUB_CNY_RATE),
    source: "ozon_performance_api",
    raw_json: row
  };
}

function performanceAttributedRevenueRub(row = {}) {
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

function performanceAttributedUnits(row = {}) {
  const direct = firstNumber(row.orders, row.orders_count, row.ordersCount);
  const assisted = firstNumber(row.models, row.models_count, row.modelsCount);
  const explicit = firstNumber(row.units, row.quantity, row.qty);
  return Math.round(explicit || direct + assisted || direct);
}

function adAddToCartMetric(row = {}) {
  const keys = [
    "add_to_cart",
    "addToCart",
    "to_cart",
    "toCart",
    "cart",
    "carts",
    "basket",
    "baskets",
    "addedToCart",
    "added_to_cart",
    "addedToBasket",
    "added_to_basket",
    "cartCount",
    "cart_count",
    "basketCount",
    "basket_count"
  ];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    return { available: true, value: firstNumber(row[key]) };
  }
  return { available: false, value: 0 };
}

function normalizePerformanceDate(value) {
  const text = String(value || "").trim();
  const ruMatch = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (ruMatch) return `${ruMatch[3]}-${ruMatch[2]}-${ruMatch[1]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return text.slice(0, 10);
}

function firstNumber(...values) {
  for (const value of values) {
    for (const candidate of numericCandidates(value)) {
      if (candidate === undefined || candidate === null || candidate === "") continue;
      const number = Number(String(candidate).replace(",", ".").replace(/[^\d.-]/g, ""));
      if (Number.isFinite(number)) return number;
    }
  }
  return 0;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    for (const candidate of numericCandidates(value)) {
      if (candidate === undefined || candidate === null || candidate === "") continue;
      const number = Number(String(candidate).replace(",", ".").replace(/[^\d.-]/g, ""));
      if (Number.isFinite(number) && number > 0) return number;
    }
  }
  return 0;
}

function numericCandidates(value, depth = 0) {
  if (value === undefined || value === null || value === "" || depth > 2) return [];
  if (typeof value !== "object") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => numericCandidates(item, depth + 1));
  const keys = [
    "amount",
    "value",
    "sum",
    "total",
    "daily",
    "limit",
    "budget",
    "budgetRub",
    "budget_rub",
    "dailyBudget",
    "daily_budget",
    "dailyLimit",
    "daily_limit",
    "expenseLimit",
    "expense_limit"
  ];
  return keys.flatMap((key) => numericCandidates(value[key], depth + 1));
}

async function performanceRequest(path, payload, options = {}) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options.signal.reason || new Error("广告同步已取消"));
  if (options.signal?.aborted) abortFromParent();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), PERFORMANCE_TIMEOUT_MS);
  const method = String(options.method || (payload == null ? "GET" : "POST")).toUpperCase();
  try {
    const response = await fetch(`${PERFORMANCE_API_BASE}${path}`, {
      method,
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: payload == null || method === "GET" ? undefined : JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      const message = data.message || data.error || data.raw || `HTTP ${response.status}`;
      throw new Error(`Performance API ${path} failed: ${message}`);
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`Performance API ${path} 请求超时`);
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
