import { db } from "../db.js";

function allLocal(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
}

function getLocal(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.get(...params) : stmt.get(params);
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

export function profitSummary(dateFrom, dateTo) {
  const whereDate = dateFrom || dateTo
    ? `AND o.ordered_at >= '${dateFrom || "2000-01-01"}' AND o.ordered_at <= '${dateTo ? `${dateTo}T23:59:59.999` : "9999-12-31"}'`
    : "";
  const base = `
    WITH item_profit AS (
      SELECT oi.*, o.shop_id, o.id AS order_id, o.status AS order_status, o.tracking_stage,
        CASE WHEN LOWER(o.status) LIKE '%cancel%' OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%cancel%' THEN 1 ELSE 0 END AS is_cancelled,
        CASE
          WHEN LOWER(COALESCE(o.status, '')) LIKE '%return%'
            OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%return%'
            OR COALESCE(o.status, '') LIKE '%退货%'
            OR COALESCE(o.status, '') LIKE '%退回%'
            OR COALESCE(o.tracking_stage, '') LIKE '%退货%'
            OR COALESCE(o.tracking_stage, '') LIKE '%退回%'
          THEN 1 ELSE 0
        END AS is_returned,
        CASE WHEN oi.settlement_state = 'accrued'
          THEN COALESCE(NULLIF(oi.actual_profit, 0), oi.estimated_profit)
          ELSE oi.estimated_profit
        END AS profit_value
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE 1=1 ${whereDate}
    )
  `;
  const productProfitBase = `
    WITH item_profit AS (
      SELECT oi.*, o.shop_id, o.id AS order_id, o.status AS order_status, o.tracking_stage,
        CASE WHEN LOWER(o.status) LIKE '%cancel%' OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%cancel%' THEN 1 ELSE 0 END AS is_cancelled,
        CASE
          WHEN LOWER(COALESCE(o.status, '')) LIKE '%return%'
            OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%return%'
            OR COALESCE(o.status, '') LIKE '%退货%'
            OR COALESCE(o.status, '') LIKE '%退回%'
            OR COALESCE(o.tracking_stage, '') LIKE '%退货%'
            OR COALESCE(o.tracking_stage, '') LIKE '%退回%'
          THEN 1 ELSE 0
        END AS is_returned,
        CASE WHEN oi.settlement_state = 'accrued'
          THEN COALESCE(NULLIF(oi.actual_profit, 0), oi.estimated_profit)
          ELSE oi.estimated_profit
        END AS profit_value
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
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
  const summary = getLocal(`${base}
    SELECT COUNT(DISTINCT CASE WHEN is_cancelled = 0 THEN order_id END) AS order_count,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 THEN quantity ELSE 0 END), 0) AS item_quantity,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 THEN sale_price * quantity ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 THEN estimated_profit ELSE 0 END), 0) AS estimated_profit,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 AND settlement_state = 'accrued' THEN COALESCE(NULLIF(actual_profit, 0), estimated_profit) ELSE 0 END), 0) AS accrued_profit,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 AND settlement_state != 'accrued' THEN estimated_profit ELSE 0 END), 0) AS pending_profit,
      COALESCE(SUM(CASE WHEN is_cancelled = 1 THEN sale_price * quantity ELSE 0 END), 0) AS cancelled_revenue,
      COUNT(DISTINCT CASE WHEN is_cancelled = 1 THEN order_id END) AS cancelled_orders,
      COUNT(DISTINCT CASE WHEN is_cancelled = 0 AND is_returned = 1 THEN order_id END) AS return_orders,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 AND is_returned = 1 THEN quantity ELSE 0 END), 0) AS return_quantity,
      COALESCE(SUM(CASE WHEN is_cancelled = 0 AND is_returned = 1 THEN sale_price * quantity ELSE 0 END), 0) AS return_revenue
    FROM item_profit
  `);
  return {
    summary,
    byShop: allLocal(`${base}
      SELECT s.id AS shop_id, s.name AS shop_name,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 0 THEN ip.order_id END) AS order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.quantity ELSE 0 END), 0) AS item_quantity,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.sale_price * ip.quantity ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.profit_value ELSE 0 END), 0) AS profit,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 1 THEN ip.sale_price * ip.quantity ELSE 0 END), 0) AS cancelled_revenue,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 1 THEN ip.order_id END) AS cancelled_orders,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.order_id END) AS return_order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.quantity ELSE 0 END), 0) AS return_quantity,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.sale_price * ip.quantity ELSE 0 END), 0) AS return_amount
      FROM shops s
      LEFT JOIN item_profit ip ON ip.shop_id = s.id
      GROUP BY s.id
      ORDER BY profit DESC, revenue DESC
    `),
    bySku: allLocal(`${base}
      SELECT s.name AS shop_name, ip.ozon_sku,
        COALESCE(op.name, p.name, ip.ozon_sku) AS sku_name,
        COALESCE(p.code, p.selection_id, '未绑定') AS product_code,
        COALESCE(p.name, '未绑定产品') AS product_name,
        COALESCE(p.shipping_method, '') AS shipping_method,
        COALESCE(op.primary_image, op.image_url, p.image_url, '') AS image_url,
        COALESCE(pe.name, '未分配') AS owner_name,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 0 THEN ip.order_id END) AS order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.quantity ELSE 0 END), 0) AS item_quantity,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.sale_price * ip.quantity ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.profit_value ELSE 0 END), 0) AS profit,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 1 THEN ip.order_id END) AS cancel_order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 1 THEN ip.quantity ELSE 0 END), 0) AS cancel_quantity,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 1 THEN ip.sale_price * ip.quantity ELSE 0 END), 0) AS cancel_amount,
        0 AS advertising_cost,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.order_id END) AS return_order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.quantity ELSE 0 END), 0) AS return_quantity,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.sale_price * ip.quantity ELSE 0 END), 0) AS return_amount
      FROM item_profit ip
      JOIN shops s ON s.id = ip.shop_id
      LEFT JOIN sku_mappings sm ON sm.id = ip.sku_mapping_id
      LEFT JOIN products p ON p.id = sm.product_id
      LEFT JOIN online_products op ON op.shop_id = ip.shop_id AND op.ozon_sku = ip.ozon_sku
      LEFT JOIN people pe ON pe.id = sm.person_id
      GROUP BY ip.shop_id, ip.ozon_sku
      ORDER BY profit DESC, revenue DESC
    `),
    byProduct: allLocal(`${productProfitBase}
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
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.sale_price * ip.quantity ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 THEN ip.profit_value ELSE 0 END), 0) AS profit,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 1 THEN ip.order_id END) AS cancel_order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 1 THEN ip.quantity ELSE 0 END), 0) AS cancel_quantity,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 1 THEN ip.sale_price * ip.quantity ELSE 0 END), 0) AS cancel_amount,
        (
          SELECT GROUP_CONCAT(shop_name || ' ' || order_count || '单/' || item_quantity || '件', ' / ')
          FROM product_shop ps
          WHERE ps.product_id = p.id AND (ps.order_count > 0 OR ps.item_quantity > 0)
        ) AS shop_breakdown,
        0 AS advertising_cost,
        COUNT(DISTINCT CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.order_id END) AS return_order_count,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.quantity ELSE 0 END), 0) AS return_quantity,
        COALESCE(SUM(CASE WHEN ip.is_cancelled = 0 AND ip.is_returned = 1 THEN ip.sale_price * ip.quantity ELSE 0 END), 0) AS return_amount
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
