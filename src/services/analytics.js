import { db } from "../db.js";
import { describeCancellation } from "./order-cancellation.js";
import { buildOrderOutcomeSql } from "./order-outcome.js";

const PROFIT_SUMMARY_CACHE_MS = 30000;
const profitSummaryCache = new Map();
const PROFIT_DASHBOARD_CACHE_MS = 180000;
const profitDashboardCache = new Map();
const PROFIT_DB_CACHE_TTL_MS = 15 * 60 * 1000;

function allLocal(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
}

function getLocal(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.get(...params) : stmt.get(params);
}

function profitSummaryCacheKey(dateFrom, dateTo) {
  return `${dateFrom || ""}::${dateTo || ""}`;
}

function readProfitSummaryCache(dateFrom, dateTo) {
  const key = profitSummaryCacheKey(dateFrom, dateTo);
  const cached = profitSummaryCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > PROFIT_SUMMARY_CACHE_MS) {
    profitSummaryCache.delete(key);
    return null;
  }
  return cached.value;
}

function writeProfitSummaryCache(dateFrom, dateTo, value) {
  profitSummaryCache.set(profitSummaryCacheKey(dateFrom, dateTo), {
    createdAt: Date.now(),
    value
  });
  return value;
}

function profitDashboardCacheKey(options = {}) {
  return String(options.date || "").slice(0, 10) || formatDateKey(new Date());
}

function readProfitDashboardCache(options = {}) {
  const key = profitDashboardCacheKey(options);
  const cached = profitDashboardCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > PROFIT_DASHBOARD_CACHE_MS) {
    profitDashboardCache.delete(key);
    return null;
  }
  return cached.value;
}

function writeProfitDashboardCache(options = {}, value) {
  profitDashboardCache.set(profitDashboardCacheKey(options), {
    createdAt: Date.now(),
    value
  });
  return value;
}

function readAnalyticsDbCache(cacheType, cacheKey) {
  let row = null;
  try {
    row = getLocal(`
      SELECT payload, refreshed_at
      FROM analytics_cache
      WHERE cache_type = ? AND cache_key = ?
      LIMIT 1
    `, [cacheType, cacheKey]);
  } catch (error) {
    if (!String(error?.message || "").includes("no such table: analytics_cache")) throw error;
    return null;
  }
  if (!row?.payload || !row?.refreshed_at) return null;
  const refreshedAt = new Date(row.refreshed_at).getTime();
  if (!Number.isFinite(refreshedAt) || Date.now() - refreshedAt > PROFIT_DB_CACHE_TTL_MS) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

function writeAnalyticsDbCache(cacheType, cacheKey, value) {
  try {
    db.prepare(`
      INSERT INTO analytics_cache (cache_type, cache_key, payload, refreshed_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(cache_type, cache_key) DO UPDATE SET
        payload = excluded.payload,
        refreshed_at = CURRENT_TIMESTAMP
    `).run(cacheType, cacheKey, JSON.stringify(value));
  } catch (error) {
    if (!String(error?.message || "").includes("no such table: analytics_cache")) throw error;
  }
  return value;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function profitEventDateExpr(alias = "o") {
  return `substr(datetime(${alias}.last_status_changed_at, '+8 hours'), 1, 10)`;
}

function profitDailyEventSummary(dateFrom, dateTo) {
  const from = dateFrom || "2000-01-01";
  const to = dateTo || "9999-12-31";
  const outcome = buildOrderOutcomeSql("o");
  const eventDate = profitEventDateExpr("o");
  const row = getLocal(`
    WITH order_amounts AS (
      SELECT oi.order_id,
        COALESCE(SUM(oi.sale_price * oi.quantity), 0) AS revenue
      FROM order_items oi
      GROUP BY oi.order_id
    )
    SELECT
      COUNT(DISTINCT CASE
        WHEN LOWER(COALESCE(o.status, '')) = 'cancelled' OR ${outcome.cancelLike}
        THEN o.id END) AS event_cancelled_orders,
      COUNT(DISTINCT CASE
        WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn}
        THEN o.id END) AS event_return_orders,
      COALESCE(SUM(CASE
        WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn}
        THEN COALESCE(oa.revenue, 0) ELSE 0 END), 0) AS event_return_revenue
    FROM orders o
    LEFT JOIN order_amounts oa ON oa.order_id = o.id
    WHERE ${eventDate} >= ? AND ${eventDate} <= ?
  `, [from, to]) || {};
  return {
    event_cancelled_orders: Number(row.event_cancelled_orders || 0),
    event_return_orders: Number(row.event_return_orders || 0),
    event_return_revenue: roundMoney(row.event_return_revenue || 0)
  };
}

function mergeProfitDailyEventFields(summary = {}, eventSummary = {}) {
  const revenue = Number(summary.revenue || 0);
  const returnRevenue = Number(eventSummary.event_return_revenue || 0);
  return {
    ...summary,
    event_cancelled_orders: Number(eventSummary.event_cancelled_orders || 0),
    event_return_orders: Number(eventSummary.event_return_orders || 0),
    event_return_revenue: roundMoney(returnRevenue),
    effective_revenue: roundMoney(revenue - returnRevenue)
  };
}

function profitDailyEventTrend(dateFrom, dateTo) {
  const from = dateFrom || "2000-01-01";
  const to = dateTo || "9999-12-31";
  const outcome = buildOrderOutcomeSql("o");
  const eventDate = profitEventDateExpr("o");
  return allLocal(`
    WITH order_amounts AS (
      SELECT oi.order_id,
        COALESCE(SUM(oi.sale_price * oi.quantity), 0) AS revenue
      FROM order_items oi
      GROUP BY oi.order_id
    )
    SELECT
      ${eventDate} AS date_key,
      COUNT(DISTINCT CASE
        WHEN LOWER(COALESCE(o.status, '')) = 'cancelled' OR ${outcome.cancelLike}
        THEN o.id END) AS event_cancelled_orders,
      COUNT(DISTINCT CASE
        WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn}
        THEN o.id END) AS event_return_orders,
      COALESCE(SUM(CASE
        WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn}
        THEN COALESCE(oa.revenue, 0) ELSE 0 END), 0) AS event_return_revenue
    FROM orders o
    LEFT JOIN order_amounts oa ON oa.order_id = o.id
    WHERE ${eventDate} >= ? AND ${eventDate} <= ?
    GROUP BY ${eventDate}
    ORDER BY date_key DESC
  `, [from, to]).map((row) => ({
    date_key: row.date_key,
    event_cancelled_orders: Number(row.event_cancelled_orders || 0),
    event_return_orders: Number(row.event_return_orders || 0),
    event_return_revenue: roundMoney(row.event_return_revenue || 0)
  }));
}

function mergeProfitDailyTrendRows(rows = [], eventRows = []) {
  const byDate = new Map();
  for (const row of rows || []) {
    byDate.set(String(row.date_key || ""), {
      ...row,
      event_cancelled_orders: Number(row.event_cancelled_orders || 0),
      event_return_orders: Number(row.event_return_orders || 0),
      event_return_revenue: roundMoney(row.event_return_revenue || 0),
      effective_revenue: roundMoney(Number(row.revenue || 0) - Number(row.event_return_revenue || 0))
    });
  }
  for (const eventRow of eventRows || []) {
    const key = String(eventRow.date_key || "");
    const current = byDate.get(key) || {
      date_key: key,
      order_count: 0,
      revenue: 0,
      cancelled_orders: 0,
      cancelled_revenue: 0,
      profit: 0
    };
    const next = {
      ...current,
      event_cancelled_orders: Number(eventRow.event_cancelled_orders || 0),
      event_return_orders: Number(eventRow.event_return_orders || 0),
      event_return_revenue: roundMoney(eventRow.event_return_revenue || 0)
    };
    next.effective_revenue = roundMoney(Number(next.revenue || 0) - Number(next.event_return_revenue || 0));
    byDate.set(key, next);
  }
  return [...byDate.values()].sort((left, right) => String(right.date_key || "").localeCompare(String(left.date_key || "")));
}

function profitEventSummaryByShop(dateFrom, dateTo) {
  const from = dateFrom || "2000-01-01";
  const to = dateTo || "9999-12-31";
  const outcome = buildOrderOutcomeSql("o");
  const eventDate = profitEventDateExpr("o");
  return allLocal(`
    WITH order_amounts AS (
      SELECT oi.order_id,
        COALESCE(SUM(oi.sale_price * oi.quantity), 0) AS revenue
      FROM order_items oi
      GROUP BY oi.order_id
    )
    SELECT
      o.shop_id,
      COUNT(DISTINCT CASE
        WHEN LOWER(COALESCE(o.status, '')) = 'cancelled' OR ${outcome.cancelLike}
        THEN o.id END) AS event_cancelled_orders,
      COALESCE(SUM(CASE
        WHEN LOWER(COALESCE(o.status, '')) = 'cancelled' OR ${outcome.cancelLike}
        THEN COALESCE(oa.revenue, 0) ELSE 0 END), 0) AS event_cancelled_revenue,
      COUNT(DISTINCT CASE
        WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn}
        THEN o.id END) AS event_return_orders,
      COALESCE(SUM(CASE
        WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn}
        THEN COALESCE(oa.revenue, 0) ELSE 0 END), 0) AS event_return_revenue
    FROM orders o
    LEFT JOIN order_amounts oa ON oa.order_id = o.id
    WHERE ${eventDate} >= ? AND ${eventDate} <= ?
    GROUP BY o.shop_id
  `, [from, to]);
}

function profitEventSummaryBySku(dateFrom, dateTo) {
  const from = dateFrom || "2000-01-01";
  const to = dateTo || "9999-12-31";
  const outcome = buildOrderOutcomeSql("o");
  const eventDate = profitEventDateExpr("o");
  return allLocal(`
    SELECT
      o.shop_id,
      oi.ozon_sku,
      COUNT(DISTINCT CASE
        WHEN LOWER(COALESCE(o.status, '')) = 'cancelled' OR ${outcome.cancelLike}
        THEN o.id END) AS event_cancelled_orders,
      COALESCE(SUM(CASE
        WHEN LOWER(COALESCE(o.status, '')) = 'cancelled' OR ${outcome.cancelLike}
        THEN COALESCE(oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS event_cancelled_revenue,
      COUNT(DISTINCT CASE
        WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn}
        THEN o.id END) AS event_return_orders,
      COALESCE(SUM(CASE
        WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn}
        THEN COALESCE(oi.sale_price * oi.quantity, 0) ELSE 0 END), 0) AS event_return_revenue
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    WHERE ${eventDate} >= ? AND ${eventDate} <= ?
    GROUP BY o.shop_id, oi.ozon_sku
  `, [from, to]);
}

function mergeShopEventSummary(rows = [], eventRows = []) {
  const eventMap = new Map((eventRows || []).map((row) => [String(row.shop_id || ""), row]));
  return (rows || []).map((row) => {
    const event = eventMap.get(String(row.shop_id || "")) || {};
    return {
      ...row,
      event_cancelled_orders: Number(event.event_cancelled_orders || 0),
      event_cancelled_revenue: roundMoney(event.event_cancelled_revenue || 0),
      event_return_orders: Number(event.event_return_orders || 0),
      event_return_revenue: roundMoney(event.event_return_revenue || 0),
      cancelled_revenue: roundMoney(Number(row.cancelled_revenue || 0) + Number(event.event_cancelled_revenue || 0)),
      return_amount: roundMoney(Number(row.return_amount || 0) + Number(event.event_return_revenue || 0)),
      return_order_count: Number(row.return_order_count || 0) + Number(event.event_return_orders || 0)
    };
  });
}

function mergeSkuEventSummary(rows = [], eventRows = []) {
  const eventMap = new Map((eventRows || []).map((row) => [`${row.shop_id || ""}::${row.ozon_sku || ""}`, row]));
  return (rows || []).map((row) => {
    const key = `${row.shop_id || ""}::${row.ozon_sku || ""}`;
    const event = eventMap.get(key) || {};
    return {
      ...row,
      event_cancelled_orders: Number(event.event_cancelled_orders || 0),
      event_cancelled_revenue: roundMoney(event.event_cancelled_revenue || 0),
      event_return_orders: Number(event.event_return_orders || 0),
      event_return_revenue: roundMoney(event.event_return_revenue || 0),
      cancel_amount: roundMoney(Number(row.cancel_amount || 0) + Number(event.event_cancelled_revenue || 0)),
      return_amount: roundMoney(Number(row.return_amount || 0) + Number(event.event_return_revenue || 0)),
      return_order_count: Number(row.return_order_count || 0) + Number(event.event_return_orders || 0)
    };
  });
}

function hasProfitSnapshotRows(dateFrom, dateTo) {
  const from = dateFrom || "2000-01-01";
  const to = dateTo || "9999-12-31";
  const row = getLocal(`
    SELECT COUNT(*) AS count
    FROM analytics_shop_daily
    WHERE date_key >= ? AND date_key <= ?
  `, [from, to]);
  return Number(row?.count || 0) > 0;
}

function hasProductProfitSnapshotRows(dateFrom, dateTo) {
  const from = dateFrom || "2000-01-01";
  const to = dateTo || "9999-12-31";
  const row = getLocal(`
    SELECT COUNT(*) AS count
    FROM analytics_product_profit_daily
    WHERE date_key >= ? AND date_key <= ?
  `, [from, to]);
  return Number(row?.count || 0) > 0;
}

function hasSkuProfitSnapshotRows(dateFrom, dateTo) {
  const from = dateFrom || "2000-01-01";
  const to = dateTo || "9999-12-31";
  const row = getLocal(`
    SELECT COUNT(*) AS count
    FROM analytics_sku_profit_daily
    WHERE date_key >= ? AND date_key <= ?
  `, [from, to]);
  return Number(row?.count || 0) > 0;
}

function profitSummaryByProductSnapshot(dateFrom, dateTo) {
  const from = dateFrom || "2000-01-01";
  const to = dateTo || "9999-12-31";
  return allLocal(`
    SELECT
      p.id AS product_id,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS product_code,
      p.name AS product_name,
      p.image_url,
      p.shipping_method,
      COALESCE(pe.name, '未分配') AS owner_name,
      COALESCE(ic.available_stock, 0) AS available_stock,
      COUNT(DISTINCT sm.ozon_sku) AS sku_count,
      COALESCE(SUM(a.order_count), 0) AS order_count,
      COALESCE(SUM(a.item_quantity), 0) AS item_quantity,
      COALESCE(SUM(a.revenue), 0) AS revenue,
      COALESCE(SUM(a.current_profit), 0) AS profit,
      0 AS cancel_order_count,
      0 AS cancel_quantity,
      0 AS cancel_amount,
      (
        SELECT GROUP_CONCAT(shop_name, ' / ')
        FROM (
          SELECT s2.name || ' ' || COALESCE(SUM(a2.order_count), 0) || '单/' || COALESCE(SUM(a2.item_quantity), 0) || '件' AS shop_name
          FROM analytics_product_profit_daily a2
          JOIN shops s2 ON s2.id = a2.shop_id
          WHERE a2.product_id = p.id
            AND a2.date_key >= ?
            AND a2.date_key <= ?
          GROUP BY a2.shop_id
        )
      ) AS shop_breakdown,
      0 AS advertising_cost,
      0 AS return_order_count,
      0 AS return_quantity,
      0 AS return_amount
    FROM products p
    LEFT JOIN sku_mappings sm ON sm.product_id = p.id AND sm.active = 1
    LEFT JOIN analytics_product_profit_daily a ON a.product_id = p.id AND a.shop_id = sm.shop_id AND a.date_key >= ? AND a.date_key <= ?
    LEFT JOIN people pe ON pe.id = COALESCE(sm.person_id, p.owner_person_id)
    LEFT JOIN inventory_current ic ON ic.real_product_id = p.id
    WHERE p.active = 1
    GROUP BY p.id
    HAVING order_count > 0 OR sku_count > 0
    ORDER BY profit DESC, revenue DESC
  `, [from, to, from, to]);
}

function profitSummaryBySkuSnapshot(dateFrom, dateTo) {
  const from = dateFrom || "2000-01-01";
  const to = dateTo || "9999-12-31";
  return allLocal(`
    SELECT
      a.shop_id,
      s.name AS shop_name,
      a.ozon_sku,
      COALESCE(op.name, p.name, a.ozon_sku) AS sku_name,
      COALESCE(p.code, p.selection_id, '未绑定') AS product_code,
      COALESCE(p.name, '未绑定产品') AS product_name,
      COALESCE(p.shipping_method, '') AS shipping_method,
      COALESCE(op.primary_image, op.image_url, p.image_url, '') AS image_url,
      COALESCE(pe.name, '未分配') AS owner_name,
      COALESCE(SUM(a.order_count), 0) AS order_count,
      COALESCE(SUM(a.item_quantity), 0) AS item_quantity,
      COALESCE(SUM(a.revenue), 0) AS revenue,
      COALESCE(SUM(a.current_profit), 0) AS profit,
      COALESCE(SUM(a.cancelled_orders), 0) AS cancel_order_count,
      COALESCE(SUM(a.cancelled_quantity), 0) AS cancel_quantity,
      COALESCE(SUM(a.cancelled_revenue), 0) AS cancel_amount,
      0 AS advertising_cost,
      COALESCE(SUM(a.return_orders), 0) AS return_order_count,
      COALESCE(SUM(a.return_quantity), 0) AS return_quantity,
      COALESCE(SUM(a.return_revenue), 0) AS return_amount
    FROM analytics_sku_profit_daily a
    JOIN shops s ON s.id = a.shop_id
    LEFT JOIN sku_mappings sm ON sm.shop_id = a.shop_id AND sm.ozon_sku = a.ozon_sku AND sm.active = 1
    LEFT JOIN products p ON p.id = COALESCE(a.product_id, sm.product_id)
    LEFT JOIN online_products op ON op.shop_id = a.shop_id AND op.ozon_sku = a.ozon_sku
    LEFT JOIN people pe ON pe.id = sm.person_id
    WHERE a.date_key >= ? AND a.date_key <= ?
    GROUP BY a.shop_id, a.ozon_sku
    ORDER BY profit DESC, revenue DESC
  `, [from, to]);
}

function profitDateWhere(dateFrom, dateTo, shopId = "") {
  const where = ["1=1"];
  const params = [];
  if (dateFrom) {
    where.push("substr(datetime(o.ordered_at, '+8 hours'), 1, 10) >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push("substr(datetime(o.ordered_at, '+8 hours'), 1, 10) <= ?");
    params.push(dateTo);
  }
  if (shopId && shopId !== "all" && Number.isFinite(Number(shopId))) {
    where.push("o.shop_id = ?");
    params.push(Number(shopId));
  }
  return { where: where.join(" AND "), params };
}

function profitDailyTrendSnapshot(dateFrom, dateTo) {
  const from = dateFrom || "2000-01-01";
  const to = dateTo || "9999-12-31";
  return allLocal(`
    SELECT
      date_key,
      COALESCE(SUM(order_count), 0) AS order_count,
      COALESCE(SUM(revenue), 0) AS revenue,
      COALESCE(SUM(cancelled_orders), 0) AS cancelled_orders,
      COALESCE(SUM(cancelled_revenue), 0) AS cancelled_revenue,
      COALESCE(SUM(current_profit), 0) AS profit
    FROM analytics_shop_daily
    WHERE date_key >= ? AND date_key <= ?
    GROUP BY date_key
    ORDER BY date_key DESC
  `, [from, to]).map((row) => ({
    ...row,
    revenue: roundMoney(row.revenue),
    cancelled_revenue: roundMoney(row.cancelled_revenue),
    profit: roundMoney(row.profit)
  }));
}

function profitDailyTrendLive(base) {
  return allLocal(`${base}
    SELECT
      substr(datetime(ordered_at, '+8 hours'), 1, 10) AS date_key,
      COUNT(DISTINCT CASE WHEN is_cancelled = 0 THEN order_id END) AS order_count,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 THEN revenue_value ELSE 0 END), 0) AS revenue,
      COUNT(DISTINCT CASE WHEN is_cancelled = 1 THEN order_id END) AS cancelled_orders,
      COALESCE(SUM(CASE WHEN is_cancelled = 1 THEN revenue_value ELSE 0 END), 0) AS cancelled_revenue,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 THEN profit_value ELSE 0 END), 0) AS profit
    FROM item_profit
    GROUP BY substr(datetime(ordered_at, '+8 hours'), 1, 10)
    ORDER BY date_key DESC
  `).map((row) => ({
    ...row,
    revenue: roundMoney(row.revenue),
    cancelled_revenue: roundMoney(row.cancelled_revenue),
    profit: roundMoney(row.profit)
  }));
}

function profitDailyShopTrendSnapshot(dateFrom, dateTo) {
  const from = dateFrom || "2000-01-01";
  const to = dateTo || "9999-12-31";
  return allLocal(`
    SELECT
      a.date_key,
      a.shop_id,
      s.name AS shop_name,
      COALESCE(SUM(a.order_count), 0) AS order_count,
      COALESCE(SUM(a.revenue), 0) AS revenue,
      COALESCE(SUM(a.cancelled_orders), 0) AS cancelled_orders,
      COALESCE(SUM(a.cancelled_revenue), 0) AS cancelled_revenue,
      COALESCE(SUM(a.current_profit), 0) AS profit
    FROM analytics_shop_daily a
    JOIN shops s ON s.id = a.shop_id
    WHERE a.date_key >= ? AND a.date_key <= ?
    GROUP BY a.date_key, a.shop_id
    ORDER BY a.date_key DESC, revenue DESC
  `, [from, to]).map((row) => ({
    ...row,
    revenue: roundMoney(row.revenue),
    cancelled_revenue: roundMoney(row.cancelled_revenue),
    profit: roundMoney(row.profit)
  }));
}

function profitDailyShopTrendLive(base) {
  return allLocal(`${base}
    SELECT
      substr(datetime(ordered_at, '+8 hours'), 1, 10) AS date_key,
      shop_id,
      shop_name,
      COUNT(DISTINCT CASE WHEN is_cancelled = 0 THEN order_id END) AS order_count,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 THEN revenue_value ELSE 0 END), 0) AS revenue,
      COUNT(DISTINCT CASE WHEN is_cancelled = 1 THEN order_id END) AS cancelled_orders,
      COALESCE(SUM(CASE WHEN is_cancelled = 1 THEN revenue_value ELSE 0 END), 0) AS cancelled_revenue,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 THEN profit_value ELSE 0 END), 0) AS profit
    FROM item_profit
    GROUP BY substr(datetime(ordered_at, '+8 hours'), 1, 10), shop_id, shop_name
    ORDER BY date_key DESC, revenue DESC
  `).map((row) => ({
    ...row,
    revenue: roundMoney(row.revenue),
    cancelled_revenue: roundMoney(row.cancelled_revenue),
    profit: roundMoney(row.profit)
  }));
}

function profitItemCte(whereSql) {
  const outcome = buildOrderOutcomeSql("o");
  return `
    WITH item_profit AS (
      SELECT oi.*, o.shop_id, o.id AS order_id, o.posting_number, o.order_number,
        o.status AS order_status, o.tracking_stage, o.logistics_status, o.ordered_at, o.delivered_at, o.accrued_at,
        o.cancel_reason, o.cancel_initiator, o.cancel_type, o.cancelled_after_ship,
        s.name AS shop_name,
        COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) AS revenue_value,
        COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) AS estimated_profit_value,
        COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) AS actual_profit_value,
        COALESCE(opi.profit_status, oi.settlement_state, '') AS profit_status,
        COALESCE(oi.ozon_image_url, op.primary_image, op.image_url, p.image_url, '') AS image_url,
        COALESCE(oi.ozon_name, op.name, p.name, oi.ozon_sku) AS item_name,
        p.id AS product_id,
        COALESCE(p.code, p.selection_id, '') AS product_code,
        COALESCE(p.name, '') AS product_name,
        COALESCE(opi.purchase_cost_cny, oi.frozen_purchase_cost * oi.quantity, 0) AS purchase_cost_value,
        COALESCE(opi.domestic_shipping_cny, oi.frozen_domestic_shipping * oi.quantity, 0) AS domestic_shipping_value,
        COALESCE(opi.international_shipping_cny, oi.frozen_international_shipping * oi.quantity, 0) AS international_shipping_value,
        COALESCE(opi.packaging_cost_cny, oi.frozen_handling_fee * oi.quantity, 0) AS packaging_cost_value,
        COALESCE(opi.commission_fee_cny, oi.estimated_commission, 0) AS commission_fee_value,
        COALESCE(opi.ozon_service_fee_cny, oi.platform_fee_actual, 0) AS ozon_service_fee_value,
        COALESCE(opi.return_loss_cny, oi.aftersale_loss, 0) AS return_loss_value,
        COALESCE(opi.advertising_cost_cny, 0) AS advertising_cost_value,
        COALESCE(opi.other_fee_cny, 0) AS other_fee_value,
        CASE
          WHEN ${outcome.afterDeliveryReturn} THEN 'after_delivery_return'
          WHEN ${outcome.rejectedUnclaimed} THEN 'rejected_unclaimed'
          WHEN ${outcome.cancelledPreFulfillment} THEN 'cancelled_pre_fulfillment'
          WHEN ${outcome.deliveredSigned} THEN 'delivered_signed'
          ELSE 'active'
        END AS outcome_type,
        CASE WHEN ${outcome.cancelledPreFulfillment} THEN 1 ELSE 0 END AS is_cancelled,
        CASE
          WHEN LOWER(COALESCE(o.status, '')) LIKE '%return%'
            OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%return%'
            OR COALESCE(o.status, '') LIKE '%退货%'
            OR COALESCE(o.status, '') LIKE '%退回%'
            OR COALESCE(o.tracking_stage, '') LIKE '%退货%'
            OR COALESCE(o.tracking_stage, '') LIKE '%退回%'
          THEN 1 ELSE 0
        END AS is_returned_legacy,
        CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN 1 ELSE 0 END AS is_returned,
        CASE WHEN COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued'
          THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0)
          ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, 0)
        END AS profit_value
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN shops s ON s.id = o.shop_id
      LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
      LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
      LEFT JOIN products p ON p.id = sm.product_id
      LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
      WHERE ${whereSql}
    )
  `;
}

export function dashboard() {
  const summary = getLocal(`
    SELECT COUNT(DISTINCT o.id) AS order_count,
      COALESCE(SUM(oi.sale_price * oi.quantity), 0) AS revenue,
      COALESCE(SUM(oi.estimated_profit), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN oi.settlement_state = 'accrued' THEN oi.actual_profit ELSE 0 END), 0) AS accrued_profit,
      COALESCE(SUM(CASE WHEN oi.settlement_state != 'accrued' THEN oi.estimated_profit ELSE 0 END), 0) AS pending_profit
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
  `);
  return {
    summary,
    byShop: allLocal(`
      SELECT s.name, COUNT(DISTINCT o.id) AS orders,
        COALESCE(SUM(oi.sale_price * oi.quantity), 0) AS revenue,
        COALESCE(SUM(oi.estimated_profit), 0) AS estimated_profit,
        COALESCE(SUM(CASE WHEN oi.settlement_state = 'accrued' THEN oi.actual_profit ELSE 0 END), 0) AS accrued_profit
      FROM shops s
      LEFT JOIN orders o ON o.shop_id = s.id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      GROUP BY s.id
    `),
    byPerson: allLocal(`
      SELECT p.name, COUNT(oi.id) AS items,
        COALESCE(SUM(oi.sale_price * oi.quantity), 0) AS revenue,
        COALESCE(SUM(oi.estimated_profit), 0) AS estimated_profit
      FROM people p
      LEFT JOIN sku_mappings sm ON sm.person_id = p.id
      LEFT JOIN order_items oi ON oi.sku_mapping_id = sm.id
      GROUP BY p.id
    `),
    lowStock: allLocal(`
      SELECT p.id, p.code, p.name, p.alert_stock, COALESCE(SUM(im.quantity_delta), 0) AS stock
      FROM products p
      LEFT JOIN inventory_movements im ON im.product_id = p.id AND im.status = 'posted'
      GROUP BY p.id
      HAVING stock <= p.alert_stock
    `),
    exceptions: allLocal(`
      SELECT exception_type AS name, COUNT(*) AS count
      FROM order_exceptions
      WHERE status = 'open'
      GROUP BY exception_type
    `),
    orderStages: allLocal("SELECT tracking_stage AS name, COUNT(*) AS count FROM orders GROUP BY tracking_stage"),
    stockByOwner: allLocal(`
      SELECT p.name AS product_name, pe.name AS owner_name, COALESCE(SUM(im.quantity_delta), 0) AS stock
      FROM inventory_movements im
      JOIN products p ON p.id = im.product_id
      LEFT JOIN people pe ON pe.id = im.owner_person_id
      WHERE im.status = 'posted'
      GROUP BY p.id, im.owner_person_id
      HAVING stock != 0
      LIMIT 20
    `)
  };
}

export function profitDetails(query = {}) {
  const type = normalizeProfitDetailType(query.type);
  const { where, params } = profitDateWhere(query.from || query.dateFrom || "", query.to || query.dateTo || "", query.shopId || query.shop_id || "");
  const limit = Math.min(Math.max(Number(query.limit || 1000), 1), 5000);
  const inventoryDetailLimit = Math.min(limit * 3, 8000);
  const filter = profitDetailFilterSql(type);
  const orderAggregateSql = `
    SELECT order_id,
      posting_number,
      order_number,
      shop_name,
      ordered_at,
      delivered_at,
      accrued_at,
      order_status,
      tracking_stage,
      logistics_status,
      cancel_reason,
      cancel_initiator,
      cancel_type,
      cancelled_after_ship,
      MAX(outcome_type) AS outcome_type,
      GROUP_CONCAT(DISTINCT ozon_sku) AS skus,
      GROUP_CONCAT(DISTINCT item_name) AS item_names,
      MAX(image_url) AS image_url,
      COALESCE(SUM(quantity), 0) AS item_quantity,
      COALESCE(SUM(revenue_value), 0) AS revenue,
      COALESCE(SUM(profit_value), 0) AS current_profit,
      COALESCE(SUM(estimated_profit_value), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN profit_status = 'accrued' THEN actual_profit_value ELSE 0 END), 0) AS confirmed_profit,
      COALESCE(SUM(CASE WHEN profit_status != 'accrued' THEN estimated_profit_value ELSE 0 END), 0) AS pending_profit,
      COALESCE(SUM(purchase_cost_value), 0) AS purchase_cost,
      COALESCE(SUM(domestic_shipping_value), 0) AS domestic_shipping,
      COALESCE(SUM(international_shipping_value), 0) AS international_shipping,
      COALESCE(SUM(packaging_cost_value), 0) AS packaging_cost,
      COALESCE(SUM(commission_fee_value), 0) AS commission_fee,
      COALESCE(SUM(ozon_service_fee_value), 0) AS ozon_service_fee,
      COALESCE(SUM(return_loss_value), 0) AS return_loss,
      COALESCE(SUM(advertising_cost_value), 0) AS advertising_cost,
      COALESCE(SUM(other_fee_value), 0) AS other_fee
    FROM item_profit
    WHERE ${filter}
    GROUP BY order_id
  `;
  const rows = allLocal(`${profitItemCte(where)}
    ${orderAggregateSql}
    ORDER BY ordered_at DESC, order_id DESC
    LIMIT ?
  `, [...params, limit]);
  const totals = getLocal(`${profitItemCte(where)}
    SELECT
      COALESCE(COUNT(*), 0) AS orders,
      COALESCE(SUM(revenue), 0) AS revenue,
      COALESCE(SUM(current_profit), 0) AS current_profit,
      COALESCE(SUM(estimated_profit), 0) AS estimated_profit,
      COALESCE(SUM(confirmed_profit), 0) AS confirmed_profit,
      COALESCE(SUM(pending_profit), 0) AS pending_profit,
      COALESCE(SUM(item_quantity), 0) AS item_quantity,
      COALESCE(SUM(purchase_cost), 0) AS purchase_cost,
      COALESCE(SUM(domestic_shipping), 0) AS domestic_shipping,
      COALESCE(SUM(international_shipping), 0) AS international_shipping,
      COALESCE(SUM(packaging_cost), 0) AS packaging_cost,
      COALESCE(SUM(commission_fee), 0) AS commission_fee,
      COALESCE(SUM(ozon_service_fee), 0) AS ozon_service_fee,
      COALESCE(SUM(return_loss), 0) AS return_loss,
      COALESCE(SUM(advertising_cost), 0) AS advertising_cost,
      COALESCE(SUM(other_fee), 0) AS other_fee
    FROM (${orderAggregateSql}) grouped_orders
  `, params) || {};
  const inventoryRows = allLocal(`${profitItemCte(where)}
    SELECT
      COALESCE(product_id, 0) AS product_id,
      COALESCE(NULLIF(product_code, ''), 'UNBOUND') AS product_code,
      COALESCE(NULLIF(product_name, ''), '未绑定库存商品') AS product_name,
      MAX(image_url) AS image_url,
      COUNT(DISTINCT order_id) AS order_count,
      COALESCE(SUM(quantity), 0) AS item_quantity,
      COALESCE(SUM(revenue_value), 0) AS revenue,
      COALESCE(SUM(profit_value), 0) AS current_profit,
      COALESCE(SUM(estimated_profit_value), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN profit_status = 'accrued' THEN actual_profit_value ELSE 0 END), 0) AS confirmed_profit,
      COALESCE(SUM(CASE WHEN profit_status != 'accrued' THEN estimated_profit_value ELSE 0 END), 0) AS pending_profit,
      COALESCE(SUM(purchase_cost_value), 0) AS purchase_cost,
      COALESCE(SUM(domestic_shipping_value), 0) AS domestic_shipping,
      COALESCE(SUM(international_shipping_value), 0) AS international_shipping,
      COALESCE(SUM(packaging_cost_value), 0) AS packaging_cost,
      COALESCE(SUM(commission_fee_value), 0) AS commission_fee,
      COALESCE(SUM(ozon_service_fee_value), 0) AS ozon_service_fee,
      COALESCE(SUM(return_loss_value), 0) AS return_loss,
      COALESCE(SUM(advertising_cost_value), 0) AS advertising_cost,
      COALESCE(SUM(other_fee_value), 0) AS other_fee
    FROM item_profit
    WHERE ${filter}
    GROUP BY COALESCE(product_id, 0), COALESCE(NULLIF(product_code, ''), 'UNBOUND'), COALESCE(NULLIF(product_name, ''), '未绑定库存商品')
    ORDER BY current_profit DESC, revenue DESC
    LIMIT 200
  `, params);
  const inventoryOrderRows = allLocal(`${profitItemCte(where)}
    SELECT
      COALESCE(product_id, 0) AS product_id,
      COALESCE(NULLIF(product_code, ''), 'UNBOUND') AS product_code,
      COALESCE(NULLIF(product_name, ''), 'Unbound inventory') AS product_name,
      order_id,
      posting_number,
      order_number,
      shop_name,
      ordered_at,
      delivered_at,
      accrued_at,
      order_status,
      tracking_stage,
      logistics_status,
      MAX(outcome_type) AS outcome_type,
      GROUP_CONCAT(DISTINCT ozon_sku) AS skus,
      GROUP_CONCAT(DISTINCT item_name) AS item_names,
      MAX(image_url) AS image_url,
      COALESCE(SUM(quantity), 0) AS item_quantity,
      COALESCE(SUM(revenue_value), 0) AS revenue,
      COALESCE(SUM(profit_value), 0) AS current_profit,
      COALESCE(SUM(estimated_profit_value), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN profit_status = 'accrued' THEN actual_profit_value ELSE 0 END), 0) AS confirmed_profit,
      COALESCE(SUM(CASE WHEN profit_status != 'accrued' THEN estimated_profit_value ELSE 0 END), 0) AS pending_profit,
      COALESCE(SUM(purchase_cost_value), 0) AS purchase_cost,
      COALESCE(SUM(domestic_shipping_value), 0) AS domestic_shipping,
      COALESCE(SUM(international_shipping_value), 0) AS international_shipping,
      COALESCE(SUM(packaging_cost_value), 0) AS packaging_cost,
      COALESCE(SUM(commission_fee_value), 0) AS commission_fee,
      COALESCE(SUM(ozon_service_fee_value), 0) AS ozon_service_fee,
      COALESCE(SUM(return_loss_value), 0) AS return_loss,
      COALESCE(SUM(advertising_cost_value), 0) AS advertising_cost,
      COALESCE(SUM(other_fee_value), 0) AS other_fee
    FROM item_profit
    WHERE ${filter}
    GROUP BY
      COALESCE(product_id, 0),
      COALESCE(NULLIF(product_code, ''), 'UNBOUND'),
      COALESCE(NULLIF(product_name, ''), 'Unbound inventory'),
      order_id
    ORDER BY revenue DESC, ordered_at DESC, order_id DESC
    LIMIT ?
  `, [...params, inventoryDetailLimit]);
  const mappedRows = rows.map((row) => ({ ...row, ...describeCancellation(row) }));
  const mappedInventoryOrderRows = inventoryOrderRows.map((row) => ({ ...row, ...describeCancellation(row) }));
  return {
    type,
    rows: mappedRows,
    inventoryRows,
    inventoryOrderRows: mappedInventoryOrderRows,
    totals,
    limit,
    returned: mappedRows.length,
    truncated: mappedRows.length >= limit && Number(totals.orders || 0) > mappedRows.length,
    emptyReason: Number(totals.orders || 0) <= 0 ? profitDetailEmptyReason(type) : ""
  };
}

export function profitRankingDetails(query = {}) {
  const dimension = String(query.dimension || "sku") === "shop" ? "shop" : "sku";
  const shopId = Number(query.shop_id || query.shopId || 0);
  const ozonSku = String(query.ozon_sku || query.ozonSku || "").trim();
  const from = query.from || query.dateFrom || "";
  const to = query.to || query.dateTo || "";
  const limit = Math.min(Math.max(Number(query.limit || 100), 1), 500);
  if (!shopId) throw new Error("shop_id is required");
  if (dimension === "sku" && !ozonSku) throw new Error("ozon_sku is required");
  const baseWhere = profitDateWhere(from, to, shopId);
  const whereParts = [baseWhere.where];
  const params = [...baseWhere.params];
  if (dimension === "sku") {
    whereParts.push("oi.ozon_sku = ?");
    params.push(ozonSku);
  }
  const whereSql = whereParts.join(" AND ");
  const orderRows = allLocal(`${profitItemCte(whereSql)}
    SELECT
      order_id,
      posting_number,
      order_number,
      shop_name,
      ordered_at,
      delivered_at,
      accrued_at,
      order_status,
      tracking_stage,
      logistics_status,
      MAX(outcome_type) AS outcome_type,
      MAX(product_code) AS product_code,
      MAX(product_name) AS product_name,
      GROUP_CONCAT(DISTINCT ozon_sku) AS skus,
      GROUP_CONCAT(DISTINCT item_name) AS item_names,
      MAX(image_url) AS image_url,
      COALESCE(SUM(quantity), 0) AS item_quantity,
      COALESCE(SUM(revenue_value), 0) AS revenue,
      COALESCE(SUM(profit_value), 0) AS profit,
      COALESCE(SUM(CASE WHEN is_cancelled = 1 THEN revenue_value ELSE 0 END), 0) AS model_cancelled_revenue,
      COALESCE(SUM(CASE WHEN is_returned = 1 THEN revenue_value ELSE 0 END), 0) AS return_revenue
    FROM item_profit
    GROUP BY order_id
    ORDER BY ordered_at DESC, order_id DESC
    LIMIT ?
  `, [...params, limit]).map((row) => ({ ...row, ...describeCancellation(row) }));
  const totals = getLocal(`${profitItemCte(whereSql)}
    SELECT
      COUNT(DISTINCT order_id) AS order_count,
      COALESCE(SUM(quantity), 0) AS item_quantity,
      COALESCE(SUM(revenue_value), 0) AS revenue,
      COALESCE(SUM(profit_value), 0) AS profit,
      COALESCE(SUM(CASE WHEN is_cancelled = 1 THEN revenue_value ELSE 0 END), 0) AS model_cancelled_revenue,
      COALESCE(SUM(CASE WHEN is_returned = 1 THEN revenue_value ELSE 0 END), 0) AS return_revenue
    FROM item_profit
  `, params) || {};
  return {
    dimension,
    shop_id: shopId,
    ozon_sku: ozonSku,
    from,
    to,
    totals: {
      order_count: Number(totals.order_count || 0),
      item_quantity: Number(totals.item_quantity || 0),
      revenue: roundMoney(totals.revenue || 0),
      profit: roundMoney(totals.profit || 0),
      model_cancelled_revenue: roundMoney(totals.model_cancelled_revenue || 0),
      return_revenue: roundMoney(totals.return_revenue || 0)
    },
    rows: orderRows
  };
}

function normalizeProfitDetailType(value) {
  return [
    "total_sales",
    "current_profit",
    "confirmed_profit",
    "pending_profit",
    "model_estimated",
    "effective_orders",
    "cancelled_orders",
    "return_orders"
  ].includes(String(value || "")) ? String(value) : "total_sales";
}

function profitDetailFilterSql(type) {
  if (type === "confirmed_profit") return "is_cancelled = 0 AND is_returned = 0 AND profit_status = 'accrued'";
  if (type === "pending_profit") return "is_cancelled = 0 AND is_returned = 0 AND profit_status != 'accrued'";
  if (type === "cancelled_orders") return "is_cancelled = 1";
  if (type === "return_orders") return "is_cancelled = 0 AND is_returned = 1";
  return "is_cancelled = 0 AND is_returned = 0";
}

function profitDetailEmptyReason(type) {
  return {
    confirmed_profit: "当前时间和店铺筛选下，没有已签收/已结算的真实利润记录。",
    pending_profit: "当前时间和店铺筛选下，没有待确认的预估利润订单。",
    cancelled_orders: "当前时间和店铺筛选下，没有取消订单。",
    return_orders: "当前时间和店铺筛选下，没有识别到退货/拒收订单。",
    total_sales: "当前时间和店铺筛选下，没有有效销售订单。",
    current_profit: "当前时间和店铺筛选下，没有有效利润订单。",
    model_estimated: "当前时间和店铺筛选下，没有模型预估订单。",
    effective_orders: "当前时间和店铺筛选下，没有有效订单。"
  }[type] || "当前筛选下没有明细记录。";
}

export function profitSummary(dateFrom, dateTo, options = {}) {
  const forceRefresh = options.refresh === true || options.force === true;
  if (!forceRefresh) {
    const cached = readProfitSummaryCache(dateFrom, dateTo);
    if (cached) return cached;
  }
  const cacheKey = profitSummaryCacheKey(dateFrom, dateTo);
  if (!forceRefresh) {
    const cachedDb = readAnalyticsDbCache("profit_summary", cacheKey);
    if (cachedDb) {
      writeProfitSummaryCache(dateFrom, dateTo, cachedDb);
      return cachedDb;
    }
  }
  const snapshotEnabled = hasProfitSnapshotRows(dateFrom, dateTo);
  const productSnapshotEnabled = hasProductProfitSnapshotRows(dateFrom, dateTo);
  const skuSnapshotEnabled = hasSkuProfitSnapshotRows(dateFrom, dateTo);
  const outcome = buildOrderOutcomeSql("o");
  const snapshotFrom = dateFrom || "2000-01-01";
  const snapshotTo = dateTo || "9999-12-31";
  const eventSummary = profitDailyEventSummary(snapshotFrom, snapshotTo);
  const whereDate = dateFrom || dateTo
    ? `AND o.ordered_at >= '${dateFrom || "2000-01-01"}' AND o.ordered_at <= '${dateTo ? `${dateTo}T23:59:59.999` : "9999-12-31"}'`
    : "";
  const base = `
    WITH item_profit AS (
      SELECT oi.*, o.shop_id, o.id AS order_id, o.status AS order_status, o.tracking_stage, o.ordered_at,
        s.name AS shop_name,
        COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) AS revenue_value,
        COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) AS estimated_profit_value,
        COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) AS actual_profit_value,
        COALESCE(opi.profit_status, oi.settlement_state, '') AS profit_status,
        CASE WHEN ${outcome.cancelledPreFulfillment} THEN 1 ELSE 0 END AS is_cancelled,
        CASE
          WHEN LOWER(COALESCE(o.status, '')) LIKE '%return%'
            OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%return%'
            OR COALESCE(o.status, '') LIKE '%退货%'
            OR COALESCE(o.status, '') LIKE '%退回%'
            OR COALESCE(o.tracking_stage, '') LIKE '%退货%'
            OR COALESCE(o.tracking_stage, '') LIKE '%退回%'
          THEN 1 ELSE 0
        END AS is_returned_legacy,
        CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN 1 ELSE 0 END AS is_returned,
        CASE WHEN COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued'
          THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0)
          ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, 0)
        END AS profit_value
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN shops s ON s.id = o.shop_id
      LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
      WHERE 1=1 ${whereDate}
    )
  `;
  const productProfitBase = `
    WITH item_profit AS (
      SELECT oi.*, o.shop_id, o.id AS order_id, o.status AS order_status, o.tracking_stage,
        COALESCE(opi.sale_amount_cny, oi.sale_price * oi.quantity, 0) AS revenue_value,
        COALESCE(opi.net_profit_cny, oi.estimated_profit, 0) AS estimated_profit_value,
        COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0) AS actual_profit_value,
        COALESCE(opi.profit_status, oi.settlement_state, '') AS profit_status,
        CASE WHEN ${outcome.cancelledPreFulfillment} THEN 1 ELSE 0 END AS is_cancelled,
        CASE
          WHEN LOWER(COALESCE(o.status, '')) LIKE '%return%'
            OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%return%'
            OR COALESCE(o.status, '') LIKE '%退货%'
            OR COALESCE(o.status, '') LIKE '%退回%'
            OR COALESCE(o.tracking_stage, '') LIKE '%退货%'
            OR COALESCE(o.tracking_stage, '') LIKE '%退回%'
          THEN 1 ELSE 0
        END AS is_returned_legacy,
        CASE WHEN ${outcome.rejectedUnclaimed} OR ${outcome.afterDeliveryReturn} THEN 1 ELSE 0 END AS is_returned,
        CASE WHEN COALESCE(opi.profit_status, oi.settlement_state, '') = 'accrued'
          THEN COALESCE(opi.net_profit_cny, oi.actual_profit, oi.estimated_profit, 0)
          ELSE COALESCE(opi.net_profit_cny, oi.estimated_profit, 0)
        END AS profit_value
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
      WHERE 1=1 ${whereDate}
    ),
    product_shop AS (
      SELECT sm.product_id, s.name AS shop_name,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 0 THEN ip.order_id END) AS order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.quantity ELSE 0 END), 0) AS item_quantity
      FROM sku_mappings sm
      JOIN shops s ON s.id = sm.shop_id
      LEFT JOIN item_profit ip ON ip.sku_mapping_id = sm.id
      WHERE sm.active = 1
      GROUP BY sm.product_id, s.id
    )
  `;
  const liveSummary = getLocal(`${base}
    SELECT COUNT(DISTINCT CASE WHEN is_cancelled = 0 THEN order_id END) AS order_count,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 THEN quantity ELSE 0 END), 0) AS item_quantity,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 THEN revenue_value ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 THEN profit_value ELSE 0 END), 0) AS profit,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 THEN estimated_profit_value ELSE 0 END), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 AND profit_status = 'accrued' THEN actual_profit_value ELSE 0 END), 0) AS accrued_profit,
      COUNT(DISTINCT CASE WHEN is_cancelled = 0 AND profit_status = 'accrued' THEN order_id END) AS accrued_order_count,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 AND profit_status != 'accrued' THEN estimated_profit_value ELSE 0 END), 0) AS pending_profit,
      COUNT(DISTINCT CASE WHEN is_cancelled = 0 AND profit_status != 'accrued' THEN order_id END) AS pending_order_count,
      COALESCE(SUM(CASE WHEN is_cancelled = 1 THEN revenue_value ELSE 0 END), 0) AS cancelled_revenue,
      COUNT(DISTINCT CASE WHEN is_cancelled = 1 THEN order_id END) AS cancelled_orders,
      COUNT(DISTINCT CASE WHEN is_cancelled = 0 AND is_returned = 1 THEN order_id END) AS return_orders,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 AND is_returned = 1 THEN quantity ELSE 0 END), 0) AS return_quantity,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 AND is_returned = 1 THEN revenue_value ELSE 0 END), 0) AS return_revenue
    FROM item_profit
  `);
  const summaryBase = snapshotEnabled
    ? (getLocal(`
      SELECT
        COALESCE(SUM(order_count), 0) AS order_count,
        COALESCE(SUM(item_quantity), 0) AS item_quantity,
        COALESCE(SUM(revenue), 0) AS revenue,
        COALESCE(SUM(current_profit), 0) AS profit,
        COALESCE(SUM(estimated_profit), 0) AS estimated_profit,
        COALESCE(SUM(confirmed_profit), 0) AS accrued_profit,
        0 AS accrued_order_count,
        COALESCE(SUM(current_profit) - SUM(confirmed_profit), 0) AS pending_profit,
        0 AS pending_order_count,
        COALESCE(SUM(cancelled_revenue), 0) AS cancelled_revenue,
        COALESCE(SUM(cancelled_orders), 0) AS cancelled_orders,
        COALESCE(SUM(return_orders), 0) AS return_orders,
        COALESCE(SUM(return_quantity), 0) AS return_quantity,
        COALESCE(SUM(return_revenue), 0) AS return_revenue
      FROM analytics_shop_daily
      WHERE date_key >= ? AND date_key <= ?
    `, [snapshotFrom, snapshotTo]) || liveSummary)
    : liveSummary;
  const summary = mergeProfitDailyEventFields(summaryBase || {}, eventSummary);
  const liveByShop = allLocal(`${base}
      SELECT s.id AS shop_id, s.name AS shop_name,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 0 THEN ip.order_id END) AS order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.quantity ELSE 0 END), 0) AS item_quantity,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.revenue_value ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.profit_value ELSE 0 END), 0) AS profit,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.estimated_profit_value ELSE 0 END), 0) AS estimated_profit,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 AND ip.profit_status = 'accrued' THEN ip.actual_profit_value ELSE 0 END), 0) AS accrued_profit,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 0 AND ip.profit_status = 'accrued' THEN ip.order_id END) AS accrued_order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 AND ip.profit_status != 'accrued' THEN ip.estimated_profit_value ELSE 0 END), 0) AS pending_profit,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 0 AND ip.profit_status != 'accrued' THEN ip.order_id END) AS pending_order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 1 THEN ip.revenue_value ELSE 0 END), 0) AS cancelled_revenue,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 1 THEN ip.order_id END) AS cancelled_orders,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.order_id END) AS return_order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.quantity ELSE 0 END), 0) AS return_quantity,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.revenue_value ELSE 0 END), 0) AS return_amount
      FROM shops s
      LEFT JOIN item_profit ip ON ip.shop_id = s.id
      GROUP BY s.id
      ORDER BY profit DESC, revenue DESC
    `);
  const byShop = snapshotEnabled
    ? allLocal(`
      SELECT
        s.id AS shop_id,
        s.name AS shop_name,
        COALESCE(SUM(a.order_count), 0) AS order_count,
        COALESCE(SUM(a.item_quantity), 0) AS item_quantity,
        COALESCE(SUM(a.revenue), 0) AS revenue,
        COALESCE(SUM(a.current_profit), 0) AS profit,
        COALESCE(SUM(a.estimated_profit), 0) AS estimated_profit,
        COALESCE(SUM(a.confirmed_profit), 0) AS accrued_profit,
        0 AS accrued_order_count,
        COALESCE(SUM(a.current_profit) - SUM(a.confirmed_profit), 0) AS pending_profit,
        0 AS pending_order_count,
        COALESCE(SUM(a.cancelled_revenue), 0) AS cancelled_revenue,
        COALESCE(SUM(a.cancelled_orders), 0) AS cancelled_orders,
        COALESCE(SUM(a.return_orders), 0) AS return_order_count,
        COALESCE(SUM(a.return_quantity), 0) AS return_quantity,
        COALESCE(SUM(a.return_revenue), 0) AS return_amount
      FROM shops s
      LEFT JOIN analytics_shop_daily a ON a.shop_id = s.id AND a.date_key >= ? AND a.date_key <= ?
      GROUP BY s.id
      ORDER BY profit DESC, revenue DESC
    `, [snapshotFrom, snapshotTo])
    : liveByShop;
  const byShopWithEvents = mergeShopEventSummary(byShop, profitEventSummaryByShop(snapshotFrom, snapshotTo));
  const dailyTrendBase = snapshotEnabled
    ? profitDailyTrendSnapshot(snapshotFrom, snapshotTo)
    : profitDailyTrendLive(base);
  const dailyTrend = mergeProfitDailyTrendRows(dailyTrendBase, profitDailyEventTrend(snapshotFrom, snapshotTo));
  const dailyByShop = snapshotEnabled
    ? profitDailyShopTrendSnapshot(snapshotFrom, snapshotTo)
    : profitDailyShopTrendLive(base);
  const result = {
    summary,
    dailyTrend,
    dailyByShop,
    byShop,
    bySku: skuSnapshotEnabled ? profitSummaryBySkuSnapshot(snapshotFrom, snapshotTo) : allLocal(`${base}
      SELECT s.name AS shop_name, ip.ozon_sku,
        COALESCE(op.name, p.name, ip.ozon_sku) AS sku_name,
        COALESCE(p.code, p.selection_id, '未绑定') AS product_code,
        COALESCE(p.name, '未绑定产品') AS product_name,
        COALESCE(p.shipping_method, '') AS shipping_method,
        COALESCE(op.primary_image, op.image_url, p.image_url, '') AS image_url,
        COALESCE(pe.name, '未分配') AS owner_name,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 0 THEN ip.order_id END) AS order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.quantity ELSE 0 END), 0) AS item_quantity,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.revenue_value ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.profit_value ELSE 0 END), 0) AS profit,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 1 THEN ip.order_id END) AS cancel_order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 1 THEN ip.quantity ELSE 0 END), 0) AS cancel_quantity,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 1 THEN ip.revenue_value ELSE 0 END), 0) AS cancel_amount,
        0 AS advertising_cost,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.order_id END) AS return_order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.quantity ELSE 0 END), 0) AS return_quantity,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.revenue_value ELSE 0 END), 0) AS return_amount
      FROM item_profit ip
      JOIN shops s ON s.id = ip.shop_id
      LEFT JOIN sku_mappings sm ON sm.id = ip.sku_mapping_id
      LEFT JOIN products p ON p.id = sm.product_id
      LEFT JOIN online_products op ON op.shop_id = ip.shop_id AND op.ozon_sku = ip.ozon_sku
      LEFT JOIN people pe ON pe.id = sm.person_id
      GROUP BY ip.shop_id, ip.ozon_sku
      ORDER BY profit DESC, revenue DESC
    `),
    byProduct: productSnapshotEnabled ? profitSummaryByProductSnapshot(snapshotFrom, snapshotTo) : allLocal(`${productProfitBase}
      SELECT p.id AS product_id,
        CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS product_code,
        p.name AS product_name,
        p.image_url,
        p.shipping_method,
        COALESCE(pe.name, '未分配') AS owner_name,
        COALESCE(ic.available_stock, 0) AS available_stock,
        COUNT(DISTINCT sm.ozon_sku) AS sku_count,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 0 THEN ip.order_id END) AS order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.quantity ELSE 0 END), 0) AS item_quantity,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.revenue_value ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.profit_value ELSE 0 END), 0) AS profit,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 1 THEN ip.order_id END) AS cancel_order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 1 THEN ip.quantity ELSE 0 END), 0) AS cancel_quantity,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 1 THEN ip.revenue_value ELSE 0 END), 0) AS cancel_amount,
        (
          SELECT GROUP_CONCAT(shop_name || ' ' || order_count || '单/' || item_quantity || '件', ' / ')
          FROM product_shop ps
          WHERE ps.product_id = p.id AND (ps.order_count > 0 OR ps.item_quantity > 0)
        ) AS shop_breakdown,
        0 AS advertising_cost,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.order_id END) AS return_order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.quantity ELSE 0 END), 0) AS return_quantity,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.revenue_value ELSE 0 END), 0) AS return_amount
      FROM products p
      LEFT JOIN sku_mappings sm ON sm.product_id = p.id AND sm.active = 1
      LEFT JOIN item_profit ip ON ip.sku_mapping_id = sm.id
      LEFT JOIN people pe ON pe.id = COALESCE(sm.person_id, p.owner_person_id)
      LEFT JOIN inventory_current ic ON ic.real_product_id = p.id
      WHERE p.active = 1
      GROUP BY p.id
      HAVING order_count > 0 OR sku_count > 0
      ORDER BY profit DESC, revenue DESC
    `)
  };
  writeProfitSummaryCache(dateFrom, dateTo, result);
  writeAnalyticsDbCache("profit_summary", cacheKey, result);
  return result;
}

function parseDateKey(value) {
  const source = String(value || "").slice(0, 10);
  const [year, month, day] = source.split("-").map((part) => Number(part || 0));
  if (!year || !month || !day) return new Date();
  return new Date(year, month - 1, day);
}

function formatDateKey(value) {
  const date = value instanceof Date ? value : parseDateKey(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDateKey(value, days) {
  const date = parseDateKey(value);
  date.setDate(date.getDate() + Number(days || 0));
  return formatDateKey(date);
}

function shiftMonthKey(value, months) {
  const date = parseDateKey(value);
  date.setDate(1);
  date.setMonth(date.getMonth() + Number(months || 0));
  return formatDateKey(date);
}

function shiftRelativeMonthKey(value, months) {
  const source = parseDateKey(value);
  const target = new Date(source);
  const day = source.getDate();
  target.setMonth(target.getMonth() + Number(months || 0), 1);
  const maxDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, maxDay));
  return formatDateKey(target);
}

function startOfMonthKey(value) {
  const date = parseDateKey(value);
  date.setDate(1);
  return formatDateKey(date);
}

function endOfMonthKey(value) {
  const date = parseDateKey(value);
  date.setMonth(date.getMonth() + 1, 0);
  return formatDateKey(date);
}

function startOfQuarterKey(value) {
  const date = parseDateKey(value);
  const quarterMonth = Math.floor(date.getMonth() / 3) * 3;
  date.setMonth(quarterMonth, 1);
  return formatDateKey(date);
}

function startOfYearKey(value) {
  const date = parseDateKey(value);
  date.setMonth(0, 1);
  return formatDateKey(date);
}

function normalizeProfitRangeSummary(summary = {}) {
  const revenue = Number(summary.revenue || 0);
  const cancelledOrders = Number(summary.event_cancelled_orders || summary.cancelled_orders || 0);
  const cancelledRevenue = Number(summary.cancelled_revenue || 0);
  const returnOrders = Number(summary.event_return_orders || summary.return_orders || 0);
  const returnRevenue = Number(summary.event_return_revenue || summary.return_revenue || 0);
  const effectiveRevenue = Number(summary.effective_revenue || revenue - returnRevenue);
  return {
    order_count: Number(summary.order_count || 0),
    item_quantity: Number(summary.item_quantity || 0),
    revenue: roundMoney(revenue),
    profit: roundMoney(summary.profit || 0),
    estimated_profit: roundMoney(summary.estimated_profit || 0),
    accrued_profit: roundMoney(summary.accrued_profit || 0),
    pending_profit: roundMoney(summary.pending_profit || 0),
    cancelled_orders: cancelledOrders,
    cancelled_revenue: roundMoney(cancelledRevenue),
    return_orders: returnOrders,
    return_revenue: roundMoney(returnRevenue),
    effective_orders: Math.max(0, Number(summary.order_count || 0) - returnOrders),
    effective_revenue: roundMoney(effectiveRevenue)
  };
}

function normalizeProfitTrendRow(row = {}) {
  const revenue = Number(row.revenue || 0);
  const returnOrders = Number(row.event_return_orders || row.return_orders || 0);
  const returnRevenue = Number(row.event_return_revenue || row.return_revenue || 0);
  return {
    date_key: String(row.date_key || ""),
    order_count: Number(row.order_count || 0),
    revenue: roundMoney(revenue),
    profit: roundMoney(row.profit || 0),
    cancelled_orders: Number(row.cancelled_orders || 0),
    cancelled_revenue: roundMoney(row.cancelled_revenue || 0),
    event_cancelled_orders: Number(row.event_cancelled_orders || 0),
    return_orders: returnOrders,
    return_revenue: roundMoney(returnRevenue),
    effective_orders: Math.max(0, Number(row.order_count || 0) - returnOrders),
    effective_revenue: roundMoney(Number(row.effective_revenue || revenue - returnRevenue))
  };
}

function aggregateProfitTrendByMonth(rows = [], limit = 12) {
  const byMonth = new Map();
  for (const row of rows || []) {
    const monthKey = String(row.date_key || "").slice(0, 7);
    if (!monthKey) continue;
    const current = byMonth.get(monthKey) || {
      month_key: monthKey,
      order_count: 0,
      revenue: 0,
      profit: 0,
      cancelled_orders: 0,
      cancelled_revenue: 0,
      event_cancelled_orders: 0,
      return_orders: 0,
      return_revenue: 0,
      effective_orders: 0,
      effective_revenue: 0
    };
    const normalized = normalizeProfitTrendRow(row);
    current.order_count += normalized.order_count;
    current.revenue += normalized.revenue;
    current.profit += normalized.profit;
    current.cancelled_orders += normalized.cancelled_orders;
    current.cancelled_revenue += normalized.cancelled_revenue;
    current.event_cancelled_orders += normalized.event_cancelled_orders;
    current.return_orders += normalized.return_orders;
    current.return_revenue += normalized.return_revenue;
    current.effective_orders += normalized.effective_orders;
    current.effective_revenue += normalized.effective_revenue;
    byMonth.set(monthKey, current);
  }
  return [...byMonth.values()]
    .sort((left, right) => String(left.month_key).localeCompare(String(right.month_key)))
    .slice(-Math.max(1, Number(limit || 12)))
    .map((row) => ({
      ...row,
      revenue: roundMoney(row.revenue),
      profit: roundMoney(row.profit),
      cancelled_revenue: roundMoney(row.cancelled_revenue),
      return_revenue: roundMoney(row.return_revenue),
      effective_revenue: roundMoney(row.effective_revenue)
    }));
}

function fillDailyTrendRows(rows = [], from, to) {
  const start = parseDateKey(from);
  const end = parseDateKey(to);
  const byDate = new Map((rows || []).map((row) => [String(row.date_key || ""), normalizeProfitTrendRow(row)]));
  const result = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const key = formatDateKey(cursor);
    result.push(byDate.get(key) || normalizeProfitTrendRow({ date_key: key }));
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

function fillMonthlyTrendRows(rows = [], anchorDate, months = 12) {
  const byMonth = new Map((rows || []).map((row) => [String(row.month_key || ""), row]));
  const result = [];
  const totalMonths = Math.max(1, Number(months || 12));
  for (let index = totalMonths - 1; index >= 0; index -= 1) {
    const monthDate = parseDateKey(startOfMonthKey(shiftMonthKey(anchorDate, -index)));
    const monthKey = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, "0")}`;
    result.push(byMonth.get(monthKey) || {
      month_key: monthKey,
      order_count: 0,
      revenue: 0,
      profit: 0,
      cancelled_orders: 0,
      cancelled_revenue: 0,
      event_cancelled_orders: 0,
      return_orders: 0,
      return_revenue: 0,
      effective_orders: 0,
      effective_revenue: 0
    });
  }
  return result;
}

function paginateRows(rows = [], page = 1, pageSize = 30) {
  const safePage = Math.max(1, Number(page || 1));
  const safePageSize = Math.min(200, Math.max(10, Number(pageSize || 30)));
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const currentPage = Math.min(safePage, totalPages);
  const offset = (currentPage - 1) * safePageSize;
  return {
    page: currentPage,
    pageSize: safePageSize,
    total,
    totalPages,
    rows: rows.slice(offset, offset + safePageSize).map((row, index) => ({
      rank: offset + index + 1,
      ...row
    }))
  };
}

export function profitDashboard(options = {}) {
  const cached = readProfitDashboardCache(options);
  if (cached) return cached;
  const cacheKey = profitDashboardCacheKey(options);
  const cachedDb = readAnalyticsDbCache("profit_dashboard", cacheKey);
  if (cachedDb) {
    writeProfitDashboardCache(options, cachedDb);
    return cachedDb;
  }
  const anchorDate = String(options.date || "").slice(0, 10) || formatDateKey(new Date());
  const today = anchorDate;
  const yesterday = shiftDateKey(anchorDate, -1);
  const currentMonthFrom = startOfMonthKey(anchorDate);
  const lastMonthAnchor = shiftMonthKey(anchorDate, -1);
  const lastMonthFrom = startOfMonthKey(lastMonthAnchor);
  const lastMonthTo = endOfMonthKey(lastMonthAnchor);
  const currentQuarterFrom = startOfQuarterKey(anchorDate);
  const currentYearFrom = startOfYearKey(anchorDate);
  const fourteenDayFrom = shiftDateKey(anchorDate, -13);
  const yearlyTrendFrom = startOfMonthKey(shiftMonthKey(anchorDate, -11));

  const todaySummary = profitSummary(today, today).summary;
  const yesterdaySummary = profitSummary(yesterday, yesterday).summary;
  const currentMonthSummary = profitSummary(currentMonthFrom, today);
  const lastMonthSummary = profitSummary(lastMonthFrom, lastMonthTo).summary;
  const currentQuarterSummary = profitSummary(currentQuarterFrom, today).summary;
  const currentYearSummary = profitSummary(currentYearFrom, today).summary;
  const fourteenDaySummary = profitSummary(fourteenDayFrom, today);
  const previousFourteenDayFrom = shiftRelativeMonthKey(fourteenDayFrom, -1);
  const previousFourteenDayTo = shiftRelativeMonthKey(today, -1);
  const previousFourteenDaySummary = profitSummary(previousFourteenDayFrom, previousFourteenDayTo);
  const yearlyTrendSummary = profitSummary(yearlyTrendFrom, today);

  const result = {
    anchor_date: anchorDate,
    ranges: {
      today: {
        label: "今日",
        from: today,
        to: today,
        summary: normalizeProfitRangeSummary(todaySummary)
      },
      yesterday: {
        label: "昨日",
        from: yesterday,
        to: yesterday,
        summary: normalizeProfitRangeSummary(yesterdaySummary)
      },
      currentMonth: {
        label: "本月",
        from: currentMonthFrom,
        to: today,
        summary: normalizeProfitRangeSummary(currentMonthSummary.summary)
      },
      lastMonth: {
        label: "上月",
        from: lastMonthFrom,
        to: lastMonthTo,
        summary: normalizeProfitRangeSummary(lastMonthSummary)
      },
      currentQuarter: {
        label: "本季度",
        from: currentQuarterFrom,
        to: today,
        summary: normalizeProfitRangeSummary(currentQuarterSummary)
      },
      currentYear: {
        label: "本年度",
        from: currentYearFrom,
        to: today,
        summary: normalizeProfitRangeSummary(currentYearSummary)
      }
    },
    dailyTrend14: fillDailyTrendRows(
      (fourteenDaySummary.dailyTrend || [])
        .slice()
        .sort((left, right) => String(left.date_key || "").localeCompare(String(right.date_key || "")))
        .map(normalizeProfitTrendRow),
      fourteenDayFrom,
      today
    ),
    previousDailyTrend14: fillDailyTrendRows(
      (previousFourteenDaySummary.dailyTrend || [])
        .slice()
        .sort((left, right) => String(left.date_key || "").localeCompare(String(right.date_key || "")))
        .map(normalizeProfitTrendRow),
      previousFourteenDayFrom,
      previousFourteenDayTo
    ),
    monthlyTrend12: fillMonthlyTrendRows(aggregateProfitTrendByMonth(yearlyTrendSummary.dailyTrend || [], 12), anchorDate, 12)
  };
  writeProfitDashboardCache(options, result);
  writeAnalyticsDbCache("profit_dashboard", cacheKey, result);
  return result;
}

export function profitRanking(query = {}) {
  const anchorDate = String(query.date || "").slice(0, 10) || formatDateKey(new Date());
  const defaultFrom = startOfMonthKey(anchorDate);
  const defaultTo = anchorDate;
  const dimension = String(query.dimension || "sku") === "shop" ? "shop" : "sku";
  const from = String(query.from || defaultFrom).slice(0, 10);
  const to = String(query.to || defaultTo).slice(0, 10);
  const keyword = String(query.keyword || "").trim().toLowerCase();
  const page = Number(query.page || 1);
  const pageSize = Number(query.pageSize || query.page_size || 30);
  const summary = profitSummary(from, to);
  const sourceRows = dimension === "shop"
    ? mergeShopEventSummary(summary.byShop || [], profitEventSummaryByShop(from, to))
    : mergeSkuEventSummary(summary.bySku || [], profitEventSummaryBySku(from, to));
  const filteredRows = keyword
    ? sourceRows.filter((row) => {
      const haystack = dimension === "shop"
        ? [row.shop_name]
        : [row.shop_name, row.sku_name, row.product_name, row.ozon_sku, row.product_code];
      return haystack.some((value) => String(value || "").toLowerCase().includes(keyword));
    })
    : sourceRows;
  const paged = paginateRows(filteredRows, page, pageSize);
  return {
    dimension,
    from,
    to,
    keyword,
    ...paged
  };
}

export function currentExchangeRate() {
  return getLocal(`
    SELECT *
    FROM exchange_rates
    WHERE currency_from = 'CNY' AND currency_to = 'RUB'
    ORDER BY effective_date DESC, id DESC
    LIMIT 1
  `) || {
    currency_from: "CNY",
    currency_to: "RUB",
    rate: 11.32,
    source: "fallback",
    effective_date: new Date().toISOString().slice(0, 10),
    note: "Fallback rate"
  };
}

export function exchangeRates() {
  return allLocal(`
    SELECT *
    FROM exchange_rates
    WHERE currency_from = 'CNY' AND currency_to = 'RUB'
    ORDER BY effective_date DESC, id DESC
    LIMIT 30
  `);
}

export function updateExchangeRate(body) {
  const rate = Number(body.rate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("汇率必须大于 0");
  const effectiveDate = String(body.effective_date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const result = db.prepare(`
    INSERT INTO exchange_rates (currency_from, currency_to, rate, source, effective_date, note)
    VALUES ('CNY', 'RUB', ?, ?, ?, ?)
  `).run(rate, body.source || "manual", effectiveDate, body.note || "");
  return { id: Number(result.lastInsertRowid), ...currentExchangeRate() };
}
