import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";
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
  const localRevenue = toNumber(row.local_revenue_cny);
  const localUnits = Math.max(1, toNumber(row.local_units));
  if (localRevenue > 0) return localRevenue / localUnits;
  const ozonSaleRub = toNumber(row.ozon_sale_price_rub);
  return ozonSaleRub > 0 ? ozonSaleRub / RUB_CNY_RATE : 0;
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

  return {
    ...row,
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
      MAX(op.sale_price) AS ozon_sale_price_rub,
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
      COALESCE(SUM(ad.revenue_cny), 0) AS revenue_cny
    FROM ozon_ad_sku_daily ad
    JOIN shops s ON s.id = ad.shop_id
    ${sql}
  `, params);
  return { ...rowMetrics(rows?.[0] || {}), from, to };
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
    WHERE LOWER(name) LIKE '%vibermart%'
       OR LOWER(name) LIKE '%vibe mart%'
       OR LOWER(name) LIKE '%ruvibe%'
    ORDER BY
      CASE
        WHEN LOWER(name) LIKE '%vibermart%' THEN 1
        WHEN LOWER(name) LIKE '%vibe mart%' THEN 2
        WHEN LOWER(name) LIKE '%ruvibe%' THEN 3
        ELSE 9
      END,
      id
    LIMIT 1
  `);
  return rows?.[0] || null;
}

export async function syncAdvertisingDailyFromOzonMysql(body = {}, options = {}) {
  await ensureAdDailySchema();
  await ensurePerformanceCredentialSchema();
  const { from, to } = buildDateRange(body);
  const shopId = Number(body.shop_id || body.shopId || 0);
  const shops = await mysqlQuery(`
    SELECT *
    FROM shops
    WHERE status = 'active'
      AND (? = 0 OR id = ?)
    ORDER BY id
  `, [shopId, shopId]);

  let totalRows = 0;
  let imported = 0;
  const results = [];
  const errors = [];

  for (const shop of shops) {
    const clientId = String(shop.performance_client_id || "").trim();
    const clientSecret = String(shop.performance_client_secret || "").trim();
    if (!clientId || !clientSecret) {
      errors.push(`${shop.name || shop.id}: 缺少 Ozon Performance API Client ID / Secret`);
      results.push({ shop_id: shop.id, shop_name: shop.name, fetched: 0, imported: 0, status: "missing_credentials" });
      continue;
    }

    try {
      const token = await fetchPerformanceToken({ clientId, clientSecret }, options);
      const campaigns = await fetchPerformanceCampaigns(token, options);
      const selectedCampaigns = filterCampaigns(campaigns, body);
      await hydrateCampaignProductSettings(token, selectedCampaigns, options);
      await refreshCampaignMetadataRows(shop.id, selectedCampaigns, { from, to });
      await refreshCampaignProductSettingsRows(shop.id, selectedCampaigns, { from, to });
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
        results.push({ shop_id: shop.id, shop_name: shop.name, fetched: 0, imported: 0, status: "no_campaigns" });
        continue;
      }

      const reportRows = await fetchPerformanceSkuStats(token, {
        from,
        to,
        campaigns: selectedCampaigns,
        signal: options.signal
      });
      const normalized = reportRows
        .map((row) => normalizePerformanceAdRow(row, shop, selectedCampaigns))
        .filter((row) => row.date_key && row.shop_id && row.ozon_sku && row.ozon_sku !== "0");

      totalRows += reportRows.length;
      if (normalized.length) {
        const result = await upsertAdvertisingDailyRowsMysql({
          source: "ozon_performance_api",
          rows: normalized
        });
        imported += Number(result.total || normalized.length);
      }
      results.push({
        shop_id: shop.id,
        shop_name: shop.name,
        campaigns: selectedCampaigns.length,
        fetched: reportRows.length,
        imported: normalized.length,
        status: "ok"
      });
    } catch (error) {
      errors.push(`${shop.name || shop.id}: ${error.message}`);
      results.push({ shop_id: shop.id, shop_name: shop.name, fetched: 0, imported: 0, status: "error", error: error.message });
    }
  }

  return {
    from,
    to,
    total_rows: totalRows,
    imported,
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
  const result = await performanceRequest(`/api/client/campaign/${campaignId}/v2/products`, payload, { ...options, token, method: "PUT" });

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
      campaign.productSettings = rows.map((row) => ({
        sku: String(row.sku || row.ozon_sku || row.product_sku || "").trim(),
        bidRub: normalizePerformanceMoney(firstNumber(row.bid, row.bidRub, row.bid_rub, row.cpc, row.price)),
        targetCir: firstNumber(row.targetCir, row.target_cir, row.targetDRR, row.target_drr, row.drr)
      })).filter((row) => row.sku);
      campaign.productsBySku = new Map(campaign.productSettings.map((row) => [row.sku, row]));
    } catch {
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
  if (includeInactive !== false) return campaigns;
  return campaigns.filter((campaign) => {
    const state = String(campaign.state || "").toLowerCase();
    return !["archived", "stopped", "deleted"].some((value) => state.includes(value));
  });
}

async function fetchPerformanceSkuStats(token, options = {}) {
  const campaigns = options.campaigns || [];
  const rows = [];
  const windows = splitDateRange(options.from, options.to, 62);
  for (const window of windows) {
    for (let index = 0; index < campaigns.length; index += 10) {
      const chunk = campaigns.slice(index, index + 10);
      try {
        const report = await createAndFetchPerformanceReport(token, {
          campaigns: chunk.map((campaign) => String(campaign.id)),
          dateFrom: window.from,
          dateTo: window.to,
          groupBy: "DATE"
        }, options);
        rows.push(...flattenPerformanceReportRows(report, chunk));
      } catch (error) {
        if (!isMissingReportError(error) || chunk.length <= 1) throw error;
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
            if (!isMissingReportError(singleError)) throw singleError;
          }
        }
      }
    }
  }
  return rows;
}

async function createAndFetchPerformanceReport(token, payload, options = {}) {
  const createPayload = {
    campaigns: payload.campaigns,
    dateFrom: payload.dateFrom,
    dateTo: payload.dateTo,
    groupBy: payload.groupBy
  };
  const createCandidates = [
    "/api/client/statistics/products/json",
    "/api/client/statistics/json"
  ];
  let lastError = null;
  for (const path of createCandidates) {
    let createData = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        createData = await performanceRequest(path, createPayload, { ...options, token });
        break;
      } catch (error) {
        lastError = error;
        if (!isActiveReportLimitError(error)) break;
        await sleep(10000 + attempt * 5000);
      }
    }

    if (!createData) continue;
    const uuid = createData.UUID || createData.uuid || createData.report_id || createData.result?.UUID || createData.result?.uuid;
    if (!uuid) return createData;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const pathCandidates = [
        `/api/client/statistics/report?UUID=${encodeURIComponent(uuid)}`,
        `/api/client/statistics/${encodeURIComponent(uuid)}`
      ];
      for (const reportPath of pathCandidates) {
        try {
          const data = await performanceRequest(reportPath, null, { ...options, token, method: "GET" });
          if (isReportReady(data)) return data;
        } catch (error) {
          lastError = error;
        }
      }
      await sleep(5000);
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
    impressions: Math.round(firstNumber(row.views, row.impressions, row.shows, row.show)),
    clicks: Math.round(firstNumber(row.clicks, row.click)),
    add_to_cart: Math.round(addToCart.value),
    add_to_cart_available: addToCart.available ? 1 : 0,
    orders: Math.round(firstNumber(row.orders, row.orders_count, row.ordersCount)),
    units: Math.round(firstNumber(row.units, row.quantity, row.qty)),
    revenue_rub: firstNumber(row.ordersMoney, row.modelsMoney, row.product_gmv, row.revenue, row.sales, row.attributedRevenue, row.money_income, row.orderRevenue),
    source: "ozon_performance_api",
    raw_json: row
  };
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
