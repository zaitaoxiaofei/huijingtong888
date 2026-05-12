import { db, hashPassword } from "./db.js";
import { PDFDocument } from "pdf-lib";
import { calculateSelectionPricing } from "./celRates.js";
import { estimateItemProfit, actualItemProfit } from "./profit.js";
import { calculateFinalMileBankFee } from "./pricingFormula.js";
import { archiveOzonProducts, fetchOzonFinanceTransactions, fetchOzonPackageLabel, fetchOzonPostings, fetchOzonProducts, fetchOzonProductStocks, shipOzonPosting, updateOzonProductStocks } from "./ozonClient.js";

// 低于该阈值的 Ozon 虚拟库存会被视为需要关注的风险信号。
const FBS_VIRTUAL_STOCK_WARNING_THRESHOLD = 10;

export function all(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
}

export function get(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.get(...params) : stmt.get(params);
}

export function dashboard() {
  // 仪表盘接口提供聚合视图，减少前端首屏拆分多个统计请求。
  const summary = get(`
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
    byShop: all(`
      SELECT s.name, COUNT(DISTINCT o.id) AS orders,
        COALESCE(SUM(oi.sale_price * oi.quantity), 0) AS revenue,
        COALESCE(SUM(oi.estimated_profit), 0) AS estimated_profit,
        COALESCE(SUM(CASE WHEN oi.settlement_state = 'accrued' THEN oi.actual_profit ELSE 0 END), 0) AS accrued_profit
      FROM shops s
      LEFT JOIN orders o ON o.shop_id = s.id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      GROUP BY s.id
    `),
    byPerson: all(`
      SELECT p.name, COUNT(oi.id) AS items,
        COALESCE(SUM(oi.sale_price * oi.quantity), 0) AS revenue,
        COALESCE(SUM(oi.estimated_profit), 0) AS estimated_profit
      FROM people p
      LEFT JOIN sku_mappings sm ON sm.person_id = p.id
      LEFT JOIN order_items oi ON oi.sku_mapping_id = sm.id
      GROUP BY p.id
    `),
    lowStock: all(`
      SELECT p.id, p.code, p.name, p.alert_stock, COALESCE(SUM(im.quantity_delta), 0) AS stock
      FROM products p
      LEFT JOIN inventory_movements im ON im.product_id = p.id AND im.status = 'posted'
      GROUP BY p.id
      HAVING stock <= p.alert_stock
    `),
    exceptions: all(`
      SELECT exception_type AS name, COUNT(*) AS count
      FROM order_exceptions
      WHERE status = 'open'
      GROUP BY exception_type
    `),
    orderStages: all("SELECT tracking_stage AS name, COUNT(*) AS count FROM orders GROUP BY tracking_stage"),
    stockByOwner: all(`
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
  // 利润按下单时间统计，体现经营发生口径，而不是单纯财务到账口径。
  const whereDate = dateFrom || dateTo
    ? `AND o.ordered_at >= '${dateFrom || "2000-01-01"}' AND o.ordered_at <= '${dateTo ? dateTo + "T23:59:59.999" : "9999-12-31"}'`
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
  // 复用同一批 item_profit，保证店铺/SKU/产品三个维度统计口径一致。
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
  const summary = get(`${base}
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
    byShop: all(`${base}
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
    bySku: all(`${base}
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
    byProduct: all(`${productProfitBase}
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
  // 汇率未维护时提供兜底值，避免计价和利润页面直接不可用。
  return get(`
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
  return all(`
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

export function products() {
  const rows = all(`
    SELECT p.*,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS inventory_id,
      pe.name AS owner_name, creator.name AS creator_name,
      COALESCE(stock.stock, 0) AS stock,
      COALESCE(proc.avg_unit_cost, stock.avg_unit_cost, p.purchase_cost) AS avg_unit_cost,
      COALESCE(proc.total_purchase_amount, stock.total_purchase_amount, 0) AS total_purchase_amount,
      COALESCE(proc.total_purchase_quantity, 0) AS total_purchase_quantity,
      COALESCE(incoming.incoming_stock, 0) AS incoming_stock,
      COALESCE(sales.avg_sale_price, 0) AS avg_sale_price,
      COALESCE(sales.avg_profit, 0) AS avg_profit,
      COALESCE(sales.profit_rate, 0) AS profit_rate,
      COALESCE(sales.total_sales_amount, 0) AS total_sales_amount,
      COALESCE(sales.total_sales_quantity, 0) AS total_sales_quantity,
      COALESCE(sales.estimated_profit_total, 0) AS estimated_profit_total,
      COALESCE(sales.order_count, 0) AS order_count,
      COALESCE(sales.cancel_quantity, 0) AS cancel_quantity,
      COALESCE(sales.cancel_amount, 0) AS cancel_amount,
      COALESCE(sales.cancel_order_count, 0) AS cancel_order_count,
      COALESCE(skus.sku_count, 0) AS sku_count,
      COALESCE(skus.skus, '') AS mapped_skus,
      COALESCE(skus.origin_skus, '') AS origin_skus
    FROM products p
    LEFT JOIN people pe ON pe.id = p.owner_person_id
    LEFT JOIN people creator ON creator.id = p.created_by_person_id
    LEFT JOIN (
      SELECT product_id,
        SUM(quantity_delta) AS stock,
        CASE WHEN SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END) > 0
          THEN SUM(CASE WHEN quantity_delta > 0 THEN amount ELSE 0 END) /
               SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END)
          ELSE NULL END AS avg_unit_cost,
        SUM(CASE WHEN quantity_delta > 0 THEN amount ELSE 0 END) AS total_purchase_amount
      FROM inventory_movements
      WHERE status = 'posted'
      GROUP BY product_id
    ) stock ON stock.product_id = p.id
    LEFT JOIN (
      SELECT product_id,
        SUM(quantity) AS total_purchase_quantity,
        SUM(amount + COALESCE(shipping_amount, 0)) AS total_purchase_amount,
        CASE WHEN SUM(quantity) > 0 THEN SUM(amount + COALESCE(shipping_amount, 0)) / SUM(quantity) ELSE NULL END AS avg_unit_cost
      FROM procurement_requests
      WHERE status != 'cancelled'
      GROUP BY product_id
    ) proc ON proc.product_id = p.id
    LEFT JOIN (
      SELECT product_id, SUM(quantity) AS incoming_stock
      FROM (
        SELECT product_id, quantity
        FROM inbound_records
        WHERE status = 'pending_arrival'
        UNION ALL
        SELECT product_id, quantity
        FROM procurement_requests
        WHERE status = 'submitted'
      )
      GROUP BY product_id
    ) incoming ON incoming.product_id = p.id
    LEFT JOIN (
      SELECT sm.product_id, COUNT(*) AS sku_count, GROUP_CONCAT(sm.ozon_sku, ', ') AS skus,
        GROUP_CONCAT(s.name || ' / ' || sm.ozon_sku, '||') AS origin_skus
      FROM sku_mappings sm
      LEFT JOIN shops s ON s.id = sm.shop_id
      WHERE sm.active = 1
      GROUP BY sm.product_id
    ) skus ON skus.product_id = p.id
    LEFT JOIN (
      SELECT sm.product_id,
        CASE WHEN SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN oi.quantity ELSE 0 END) > 0
          THEN SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN oi.sale_price * oi.quantity ELSE 0 END) /
               SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN oi.quantity ELSE 0 END)
          ELSE 0 END AS avg_sale_price,
        CASE WHEN SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN oi.quantity ELSE 0 END) > 0
          THEN SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN COALESCE(NULLIF(oi.actual_profit, 0), oi.estimated_profit) ELSE 0 END) /
               SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN oi.quantity ELSE 0 END)
          ELSE 0 END AS avg_profit,
        CASE WHEN SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN oi.sale_price * oi.quantity ELSE 0 END) > 0
          THEN SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN COALESCE(NULLIF(oi.actual_profit, 0), oi.estimated_profit) ELSE 0 END) /
               SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN oi.sale_price * oi.quantity ELSE 0 END)
          ELSE 0 END AS profit_rate,
        SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN oi.sale_price * oi.quantity ELSE 0 END) AS total_sales_amount,
        SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN oi.quantity ELSE 0 END) AS total_sales_quantity,
        SUM(CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN COALESCE(NULLIF(oi.actual_profit, 0), oi.estimated_profit) ELSE 0 END) AS estimated_profit_total,
        COUNT(DISTINCT CASE WHEN LOWER(o.status) NOT LIKE '%cancel%' AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%' THEN oi.order_id END) AS order_count,
        SUM(CASE WHEN LOWER(o.status) LIKE '%cancel%' OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%cancel%' THEN oi.quantity ELSE 0 END) AS cancel_quantity,
        SUM(CASE WHEN LOWER(o.status) LIKE '%cancel%' OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%cancel%' THEN oi.sale_price * oi.quantity ELSE 0 END) AS cancel_amount,
        COUNT(DISTINCT CASE WHEN LOWER(o.status) LIKE '%cancel%' OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%cancel%' THEN oi.order_id END) AS cancel_order_count
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
      GROUP BY sm.product_id
    ) sales ON sales.product_id = p.id
    WHERE p.active = 1
    ORDER BY p.id DESC
  `);
  const orderStats = productOrderStats();
  return rows.map((row) => ({
    ...row,
    ...(orderStats.get(Number(row.id)) || {}),
    pricing: calculateSelectionPricing(row)
  }));
}

function productOrderStats() {
  const stats = all(`
    WITH mapped_items AS (
      SELECT
        oi.id,
        oi.order_id,
        oi.quantity,
        oi.sale_price,
        oi.estimated_profit,
        oi.actual_profit,
        oi.frozen_purchase_cost,
        oi.frozen_domestic_shipping,
        oi.frozen_international_shipping,
        oi.frozen_handling_fee,
        oi.estimated_commission,
        oi.platform_fee_actual,
        oi.aftersale_loss,
        o.status AS order_status,
        o.tracking_stage,
        COALESCE(o.cancel_loss_applies, 0) AS cancel_loss_applies,
        sm.product_id,
        ROW_NUMBER() OVER (PARTITION BY oi.id ORDER BY CASE WHEN sm.id = oi.sku_mapping_id THEN 0 ELSE 1 END, sm.id) AS rn
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN sku_mappings sm ON (
        (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
        AND sm.active = 1
      )
    )
    SELECT product_id,
      CASE WHEN SUM(CASE WHEN LOWER(order_status) NOT LIKE '%cancel%' AND LOWER(COALESCE(tracking_stage, '')) NOT LIKE '%cancel%' THEN quantity ELSE 0 END) > 0
        THEN SUM(CASE WHEN LOWER(order_status) NOT LIKE '%cancel%' AND LOWER(COALESCE(tracking_stage, '')) NOT LIKE '%cancel%' THEN sale_price * quantity ELSE 0 END) /
             SUM(CASE WHEN LOWER(order_status) NOT LIKE '%cancel%' AND LOWER(COALESCE(tracking_stage, '')) NOT LIKE '%cancel%' THEN quantity ELSE 0 END)
        ELSE 0 END AS avg_sale_price,
      SUM(CASE WHEN LOWER(order_status) NOT LIKE '%cancel%' AND LOWER(COALESCE(tracking_stage, '')) NOT LIKE '%cancel%' THEN sale_price * quantity ELSE 0 END) AS total_sales_amount,
      SUM(CASE WHEN LOWER(order_status) NOT LIKE '%cancel%' AND LOWER(COALESCE(tracking_stage, '')) NOT LIKE '%cancel%' THEN quantity ELSE 0 END) AS total_sales_quantity,
      SUM(CASE WHEN LOWER(order_status) NOT LIKE '%cancel%' AND LOWER(COALESCE(tracking_stage, '')) NOT LIKE '%cancel%' THEN
        COALESCE(
          NULLIF(actual_profit, 0),
          NULLIF(estimated_profit, 0),
          sale_price * quantity -
            ((frozen_purchase_cost + frozen_domestic_shipping + frozen_international_shipping + frozen_handling_fee) * quantity) -
            estimated_commission -
            platform_fee_actual -
            aftersale_loss
        )
        ELSE 0 END) AS estimated_profit_total,
      COUNT(DISTINCT CASE WHEN LOWER(order_status) NOT LIKE '%cancel%' AND LOWER(COALESCE(tracking_stage, '')) NOT LIKE '%cancel%' THEN order_id END) AS order_count,
      SUM(CASE WHEN LOWER(order_status) LIKE '%cancel%' OR LOWER(COALESCE(tracking_stage, '')) LIKE '%cancel%' THEN quantity ELSE 0 END) AS cancel_quantity,
      SUM(CASE WHEN LOWER(order_status) LIKE '%cancel%' OR LOWER(COALESCE(tracking_stage, '')) LIKE '%cancel%' THEN sale_price * quantity ELSE 0 END) AS cancel_amount,
      COUNT(DISTINCT CASE WHEN LOWER(order_status) LIKE '%cancel%' OR LOWER(COALESCE(tracking_stage, '')) LIKE '%cancel%' THEN order_id END) AS cancel_order_count,
      SUM(CASE WHEN cancel_loss_applies = 1 AND (LOWER(order_status) LIKE '%cancel%' OR LOWER(COALESCE(tracking_stage, '')) LIKE '%cancel%') THEN
        (COALESCE(frozen_purchase_cost, 0) + COALESCE(frozen_domestic_shipping, 0) + COALESCE(frozen_international_shipping, 0)) * quantity
        ELSE 0 END) AS cancel_base_loss
    FROM mapped_items
    WHERE rn = 1
    GROUP BY product_id
  `);
  const finalMileRows = all(`
    WITH mapped_items AS (
      SELECT
        oi.id,
        oi.order_id,
        oi.quantity,
        oi.sale_price,
        o.status AS order_status,
        o.tracking_stage,
        COALESCE(o.cancel_loss_applies, 0) AS cancel_loss_applies,
        sm.product_id,
        ROW_NUMBER() OVER (PARTITION BY oi.id ORDER BY CASE WHEN sm.id = oi.sku_mapping_id THEN 0 ELSE 1 END, sm.id) AS rn
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN sku_mappings sm ON (
        (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
        AND sm.active = 1
      )
    )
    SELECT product_id, sale_price, quantity
    FROM mapped_items
    WHERE rn = 1
      AND cancel_loss_applies = 1
      AND (LOWER(order_status) LIKE '%cancel%' OR LOWER(COALESCE(tracking_stage, '')) LIKE '%cancel%')
  `);
  const finalMileByProduct = new Map();
  for (const row of finalMileRows) {
    const productId = Number(row.product_id);
    const fee = calculateFinalMileBankFee(row.sale_price) * Number(row.quantity || 0);
    finalMileByProduct.set(productId, roundMoney(Number(finalMileByProduct.get(productId) || 0) + fee));
  }
  return new Map(stats.map((row) => {
    const productId = Number(row.product_id);
    const finalMile = Number(finalMileByProduct.get(productId) || 0);
    return [productId, {
      ...row,
      cancel_final_mile_bank_fee: finalMile,
      cancel_loss_total: roundMoney(Number(row.cancel_base_loss || 0) + finalMile)
    }];
  }));
}

export function productOrderProfitDetails(productId) {
  return productOrderDetailRows(productId, false).map(withComputedOrderDetail);
}

export function productCancelDetails(productId) {
  return productOrderDetailRows(productId, true).map(withComputedOrderDetail);
}

function productOrderDetailRows(productId, cancelled) {
  const cancelCondition = cancelled
    ? "(LOWER(order_status) LIKE '%cancel%' OR LOWER(COALESCE(tracking_stage, '')) LIKE '%cancel%')"
    : "(LOWER(order_status) NOT LIKE '%cancel%' AND LOWER(COALESCE(tracking_stage, '')) NOT LIKE '%cancel%')";
  return all(`
    WITH mapped_items AS (
      SELECT
        oi.id AS order_item_id,
        oi.order_id,
        oi.ozon_sku,
        oi.ozon_name,
        oi.quantity,
        oi.sale_price,
        oi.estimated_profit,
        oi.actual_profit,
        oi.settlement_state,
        oi.frozen_purchase_cost,
        oi.frozen_domestic_shipping,
        oi.frozen_international_shipping,
        oi.frozen_handling_fee,
        oi.estimated_commission,
        oi.platform_fee_actual,
        oi.aftersale_loss,
        opi.sale_amount_cny,
        opi.purchase_cost_cny,
        opi.domestic_shipping_cny,
        opi.international_shipping_cny,
        opi.packaging_cost_cny,
        opi.commission_fee_cny,
        opi.ozon_service_fee_cny,
        opi.return_loss_cny,
        opi.advertising_cost_cny,
        opi.other_fee_cny,
        opi.net_profit_cny,
        o.posting_number,
        o.order_number,
        o.status AS order_status,
        o.tracking_stage,
        COALESCE(o.cancel_loss_applies, 0) AS cancel_loss_applies,
        o.cancel_reason,
        o.cancel_initiator,
        o.ordered_at,
        o.created_at,
        s.name AS shop_name,
        sm.product_id,
        sm.id AS sku_mapping_id,
        sm.offer_id,
        sm.display_name AS mapping_display_name,
        sm.commission_low,
        sm.commission_high,
        p.name AS product_name,
        p.purchase_cost AS product_purchase_cost,
        p.domestic_shipping AS product_domestic_shipping,
        p.handling_fee AS product_handling_fee,
        p.purchase_quantity AS product_purchase_quantity,
        p.package_weight_g,
        p.length_cm,
        p.width_cm,
        p.height_cm,
        p.return_rate,
        p.withdrawal_fee_rate,
        p.exchange_rate,
        p.shipping_method,
        COALESCE(proc.avg_unit_cost, stock.avg_unit_cost, p.purchase_cost + p.domestic_shipping) AS avg_unit_cost,
        ROW_NUMBER() OVER (PARTITION BY oi.id ORDER BY CASE WHEN sm.id = oi.sku_mapping_id THEN 0 ELSE 1 END, sm.id) AS rn
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN shops s ON s.id = o.shop_id
      LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
      JOIN sku_mappings sm ON (
        (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
        AND sm.active = 1
      )
      JOIN products p ON p.id = sm.product_id
      LEFT JOIN (
        SELECT product_id,
          CASE WHEN SUM(quantity_delta) > 0 THEN SUM(amount) / SUM(quantity_delta) ELSE NULL END AS avg_unit_cost
        FROM inventory_movements
        WHERE status = 'posted' AND quantity_delta > 0
        GROUP BY product_id
      ) stock ON stock.product_id = p.id
      LEFT JOIN (
        SELECT product_id,
          CASE WHEN SUM(quantity) > 0 THEN SUM(amount + COALESCE(shipping_amount, 0)) / SUM(quantity) ELSE NULL END AS avg_unit_cost
        FROM procurement_requests
        WHERE status != 'cancelled'
        GROUP BY product_id
      ) proc ON proc.product_id = p.id
      WHERE sm.product_id = ?
    )
    SELECT *
    FROM mapped_items
    WHERE rn = 1 AND ${cancelCondition}
    ORDER BY COALESCE(ordered_at, created_at) DESC, order_item_id DESC
    LIMIT 500
  `, [Number(productId)]);
}

function withComputedOrderDetail(row) {
  const quantity = Number(row.quantity || 0);
  const salePrice = Number(row.sale_price || 0);
  const product = {
    purchase_cost: positiveNumber(row.product_purchase_cost),
    domestic_shipping: positiveNumber(row.product_domestic_shipping),
    international_shipping: 0,
    handling_fee: positiveNumber(row.product_handling_fee),
    purchase_quantity: positiveNumber(row.product_purchase_quantity) || 1,
    package_weight_g: positiveNumber(row.package_weight_g),
    length_cm: positiveNumber(row.length_cm),
    width_cm: positiveNumber(row.width_cm),
    height_cm: positiveNumber(row.height_cm),
    return_rate: row.return_rate,
    withdrawal_fee_rate: row.withdrawal_fee_rate,
    advertising_rate: 0,
    exchange_rate: row.exchange_rate,
    shipping_method: row.shipping_method
  };
  const mapping = {
    commission_low: row.commission_low,
    commission_high: row.commission_high
  };
  const estimated = estimateItemProfit({ salePrice, quantity, product, mapping });
  const frozenPurchaseCost = positiveNumber(row.frozen_purchase_cost);
  const frozenDomesticShipping = positiveNumber(row.frozen_domestic_shipping);
  const frozenInternationalShipping = positiveNumber(row.frozen_international_shipping);
  const frozenHandlingFee = positiveNumber(row.frozen_handling_fee);
  const avgUnitCost = positiveNumber(row.avg_unit_cost);
  const purchaseCost = positiveNumber(row.purchase_cost_cny) && quantity
    ? Number(row.purchase_cost_cny) / quantity
    : (frozenPurchaseCost || (avgUnitCost && !frozenDomesticShipping ? Math.max(0, avgUnitCost - product.domestic_shipping) : 0) || product.purchase_cost);
  const domesticShipping = positiveNumber(row.domestic_shipping_cny) && quantity
    ? Number(row.domestic_shipping_cny) / quantity
    : (frozenDomesticShipping || product.domestic_shipping || (avgUnitCost ? Math.max(0, avgUnitCost - purchaseCost) : 0));
  const internationalShipping = positiveNumber(row.international_shipping_cny) && quantity
    ? Number(row.international_shipping_cny) / quantity
    : (frozenInternationalShipping || positiveNumber(estimated.freight) || product.international_shipping);
  const handlingFee = positiveNumber(row.packaging_cost_cny) && quantity
    ? Number(row.packaging_cost_cny) / quantity
    : (frozenHandlingFee || product.handling_fee);
  const commission = positiveNumber(row.commission_fee_cny) || positiveNumber(row.estimated_commission) || positiveNumber(estimated.commission);
  const finalMileBankFee = calculateFinalMileBankFee(salePrice) * quantity;
  const ozonServiceFee = positiveNumber(row.ozon_service_fee_cny) || positiveNumber(row.platform_fee_actual) || roundMoney(finalMileBankFee + positiveNumber(estimated.withdrawalFee));
  const returnLoss = positiveNumber(row.return_loss_cny) || positiveNumber(estimated.expectedReturnLoss);
  const advertisingCost = positiveNumber(row.advertising_cost_cny) || positiveNumber(estimated.advertisingCost);
  const otherFee = positiveNumber(row.other_fee_cny) + positiveNumber(row.aftersale_loss);
  const storedProfit = Number(row.settlement_state === "accrued" ? (row.actual_profit || row.estimated_profit || 0) : (row.estimated_profit || row.actual_profit || 0));
  const calculatedProfit =
    salePrice * quantity -
    (purchaseCost + domesticShipping + internationalShipping + handlingFee) * quantity -
    commission -
    ozonServiceFee -
    returnLoss -
    advertisingCost -
    otherFee;
  const cancelLossApplies = Number(row.cancel_loss_applies || 0) > 0;
  const lossBase = cancelLossApplies
    ? (purchaseCost + domesticShipping + internationalShipping) * quantity
    : 0;
  return {
    ...row,
    revenue: roundMoney(salePrice * quantity),
    purchase_cost_total: roundMoney(purchaseCost * quantity),
    domestic_shipping_total: roundMoney(domesticShipping * quantity),
    international_shipping_total: roundMoney(internationalShipping * quantity),
    handling_fee_total: roundMoney(handlingFee * quantity),
    commission_total: roundMoney(commission),
    final_mile_bank_fee: roundMoney(finalMileBankFee),
    ozon_service_fee_total: roundMoney(ozonServiceFee),
    return_loss_total: roundMoney(returnLoss),
    advertising_cost_total: roundMoney(advertisingCost),
    other_fee_total: roundMoney(otherFee),
    cost_total: roundMoney((purchaseCost + domesticShipping + internationalShipping + handlingFee) * quantity),
    stored_profit_value: roundMoney(storedProfit),
    calculated_profit_value: roundMoney(calculatedProfit),
    profit_value: roundMoney(calculatedProfit),
    cancel_loss_base: roundMoney(lossBase),
    cancel_loss: roundMoney(lossBase + (cancelLossApplies ? finalMileBankFee : 0)),
    cost_source: frozenPurchaseCost || frozenDomesticShipping ? "下单冻结成本" : (avgUnitCost ? "平均采购成本" : "产品当前成本")
  };
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function hiddenProducts() {
  return all(`
    SELECT p.*,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS inventory_id,
      pe.name AS owner_name,
      COALESCE(stock.stock, 0) AS stock,
      COALESCE(inbound.pending_inbound, 0) AS pending_inbound,
      COALESCE(movements.movement_count, 0) AS movement_count
    FROM products p
    LEFT JOIN people pe ON pe.id = p.owner_person_id
    LEFT JOIN (
      SELECT product_id, SUM(quantity_delta) AS stock
      FROM inventory_movements
      WHERE status = 'posted'
      GROUP BY product_id
    ) stock ON stock.product_id = p.id
    LEFT JOIN (
      SELECT product_id, SUM(quantity) AS pending_inbound
      FROM inbound_records
      WHERE status = 'pending_arrival'
      GROUP BY product_id
    ) inbound ON inbound.product_id = p.id
    LEFT JOIN (
      SELECT product_id, COUNT(*) AS movement_count
      FROM inventory_movements
      GROUP BY product_id
    ) movements ON movements.product_id = p.id
    WHERE p.active = 0
    ORDER BY p.updated_at DESC, p.id DESC
  `);
}

export function restoreProduct(id) {
  db.prepare("UPDATE products SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(Number(id));
}

export function onlineProducts() {
  return all(`
    SELECT
      op.id, op.shop_id, op.ozon_sku, op.offer_id, op.ozon_product_id, op.name, op.image_url, op.primary_image,
      op.sale_price, op.currency_code, op.marketing_price, op.old_price, op.status, op.visibility, op.archived,
      op.is_discounted, op.images_json, op.barcodes_json, op.stocks_json, op.commissions_json, op.attributes_json,
      CASE WHEN op.raw_json IS NOT NULL AND op.raw_json != '' THEN 1 ELSE 0 END AS has_raw_json,
      op.ozon_updated_at, op.product_id, op.synced_at, op.updated_at,
      s.name AS shop_name,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS product_code,
      p.name AS product_name
    FROM online_products op
    JOIN shops s ON s.id = op.shop_id
    LEFT JOIN products p ON p.id = op.product_id
    ORDER BY op.synced_at DESC, op.id DESC
  `);
}

export function stockAlerts() {
  const rows = all(`
    SELECT p.id AS product_id,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS inventory_id,
      p.name AS product_name, p.image_url, p.alert_stock, p.created_at,
      COALESCE(ic.available_stock, 0) AS local_stock,
      sm.id AS mapping_id, sm.shop_id, sm.ozon_sku, sm.offer_id, sm.display_name, sm.active,
      s.name AS shop_name,
      op.id AS online_product_id, op.ozon_product_id, op.name AS online_name, op.primary_image AS online_image, op.image_url AS online_image_url,
      COALESCE(stock.fbp_present, 0) AS fbp_present,
      COALESCE(stock.fbp_available, 0) AS fbp_available,
      COALESCE(stock.fbs_present, 0) AS fbs_present,
      COALESCE(stock.fbs_available, 0) AS fbs_available,
      COALESCE(stock.unknown_present, 0) AS unknown_present,
      COALESCE(stock.fbp_snapshot_count, 0) AS fbp_snapshot_count,
      COALESCE(stock.fbs_snapshot_count, 0) AS fbs_snapshot_count,
      stock.last_synced_at,
      stock.warehouse_breakdown,
      COALESCE(recent3.qty, 0) AS recent_3d_qty,
      COALESCE(recent.qty, 0) AS recent_7d_qty,
      COALESCE(recent30.qty, 0) AS recent_30d_qty,
      COALESCE(prev.qty, 0) AS prev_7d_qty,
      COALESCE(alltime.qty, 0) AS all_time_qty
    FROM products p
    LEFT JOIN inventory_current ic ON ic.real_product_id = p.id
    LEFT JOIN sku_mappings sm ON sm.product_id = p.id AND sm.active = 1
    LEFT JOIN shops s ON s.id = sm.shop_id
    LEFT JOIN online_products op ON op.id = sm.online_product_id OR (op.shop_id = sm.shop_id AND op.ozon_sku = sm.ozon_sku)
    LEFT JOIN (
      SELECT shop_id, ozon_sku,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN present ELSE 0 END) AS fbp_present,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN available ELSE 0 END) AS fbp_available,
        SUM(CASE WHEN stock_type = 'fbs_virtual' THEN present ELSE 0 END) AS fbs_present,
        SUM(CASE WHEN stock_type = 'fbs_virtual' THEN available ELSE 0 END) AS fbs_available,
        SUM(CASE WHEN stock_type = 'unknown' THEN present ELSE 0 END) AS unknown_present,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN 1 ELSE 0 END) AS fbp_snapshot_count,
        SUM(CASE WHEN stock_type = 'fbs_virtual' THEN 1 ELSE 0 END) AS fbs_snapshot_count,
        MAX(synced_at) AS last_synced_at,
        GROUP_CONCAT(warehouse_name || ':' || present || '/' || available || ':' || stock_type, '||') AS warehouse_breakdown
      FROM ozon_stock_snapshots
      GROUP BY shop_id, ozon_sku
    ) stock ON stock.shop_id = sm.shop_id AND stock.ozon_sku = sm.ozon_sku
    LEFT JOIN (
      SELECT o.shop_id, oi.ozon_sku, SUM(oi.quantity) AS qty
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE substr(o.ordered_at, 1, 10) >= ?
        AND LOWER(o.status) NOT LIKE '%cancel%'
        AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%'
      GROUP BY o.shop_id, oi.ozon_sku
    ) recent3 ON recent3.shop_id = sm.shop_id AND recent3.ozon_sku = sm.ozon_sku
    LEFT JOIN (
      SELECT o.shop_id, oi.ozon_sku, SUM(oi.quantity) AS qty
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE substr(o.ordered_at, 1, 10) >= ?
        AND LOWER(o.status) NOT LIKE '%cancel%'
        AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%'
      GROUP BY o.shop_id, oi.ozon_sku
    ) recent ON recent.shop_id = sm.shop_id AND recent.ozon_sku = sm.ozon_sku
    LEFT JOIN (
      SELECT o.shop_id, oi.ozon_sku, SUM(oi.quantity) AS qty
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE substr(o.ordered_at, 1, 10) >= ?
        AND LOWER(o.status) NOT LIKE '%cancel%'
        AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%'
      GROUP BY o.shop_id, oi.ozon_sku
    ) recent30 ON recent30.shop_id = sm.shop_id AND recent30.ozon_sku = sm.ozon_sku
    LEFT JOIN (
      SELECT o.shop_id, oi.ozon_sku, SUM(oi.quantity) AS qty
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE substr(o.ordered_at, 1, 10) >= ?
        AND substr(o.ordered_at, 1, 10) < ?
        AND LOWER(o.status) NOT LIKE '%cancel%'
        AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%'
      GROUP BY o.shop_id, oi.ozon_sku
    ) prev ON prev.shop_id = sm.shop_id AND prev.ozon_sku = sm.ozon_sku
    LEFT JOIN (
      SELECT o.shop_id, oi.ozon_sku, SUM(oi.quantity) AS qty
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE LOWER(o.status) NOT LIKE '%cancel%'
        AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%'
      GROUP BY o.shop_id, oi.ozon_sku
    ) alltime ON alltime.shop_id = sm.shop_id AND alltime.ozon_sku = sm.ozon_sku
    WHERE p.active = 1
    ORDER BY p.id DESC, s.id, sm.ozon_sku
  `, [dateKeyDaysAgo(3), dateKeyDaysAgo(7), dateKeyDaysAgo(30), dateKeyDaysAgo(14), dateKeyDaysAgo(7)]);

  const productsMap = new Map();
  for (const row of rows) {
    const productId = Number(row.product_id);
    if (!productsMap.has(productId)) {
      productsMap.set(productId, {
        product_id: productId,
        inventory_id: row.inventory_id,
        product_name: row.product_name,
        image_url: row.image_url,
        alert_stock: Number(row.alert_stock || 0),
        local_stock: Number(row.local_stock || 0),
        created_at: row.created_at,
        skus: [],
        fbp_total: 0,
        fbs_total: 0,
        unknown_total: 0,
        recent_7d_qty: 0,
        recent_3d_qty: 0,
        recent_30d_qty: 0,
        prev_7d_qty: 0,
        all_time_qty: 0,
        fbp_sku_count: 0,
        fbp_zero_sku_count: 0,
        fbs_zero_sku_count: 0,
        fbs_low_sku_count: 0,
        fbs_low_threshold: FBS_VIRTUAL_STOCK_WARNING_THRESHOLD,
        last_synced_at: row.last_synced_at || ""
      });
    }
    const product = productsMap.get(productId);
    if (!row.mapping_id) continue;
    const sku = {
      mapping_id: row.mapping_id,
      shop_id: row.shop_id,
      shop_name: row.shop_name,
      ozon_sku: row.ozon_sku,
      offer_id: row.offer_id,
      name: row.online_name || row.display_name || row.ozon_sku,
      image_url: row.online_image || row.online_image_url || "",
      fbp_present: Number(row.fbp_present || 0),
      fbp_available: Number(row.fbp_available || 0),
      fbs_present: Number(row.fbs_present || 0),
      fbs_available: Number(row.fbs_available || 0),
      fbs_low_threshold: FBS_VIRTUAL_STOCK_WARNING_THRESHOLD,
      unknown_present: Number(row.unknown_present || 0),
      fbp_snapshot_count: Number(row.fbp_snapshot_count || 0),
      fbs_snapshot_count: Number(row.fbs_snapshot_count || 0),
      recent_3d_qty: Number(row.recent_3d_qty || 0),
      recent_7d_qty: Number(row.recent_7d_qty || 0),
      recent_30d_qty: Number(row.recent_30d_qty || 0),
      prev_7d_qty: Number(row.prev_7d_qty || 0),
      all_time_qty: Number(row.all_time_qty || 0),
      last_synced_at: row.last_synced_at || "",
      warehouses: parseWarehouseBreakdown(row.warehouse_breakdown)
    };
    product.skus.push(sku);
    product.fbp_total += sku.fbp_present;
    product.fbs_total += sku.fbs_present;
    product.unknown_total += sku.unknown_present;
    product.recent_3d_qty += sku.recent_3d_qty;
    product.recent_7d_qty += sku.recent_7d_qty;
    product.recent_30d_qty += sku.recent_30d_qty;
    product.prev_7d_qty += sku.prev_7d_qty;
    product.all_time_qty += sku.all_time_qty;
    if (sku.fbp_snapshot_count > 0) {
      product.fbp_sku_count += 1;
      if (sku.fbp_present <= 0) product.fbp_zero_sku_count += 1;
    }
    if (sku.fbs_snapshot_count > 0) {
      if (sku.fbs_present <= 0) product.fbs_zero_sku_count += 1;
      if (sku.fbs_present < FBS_VIRTUAL_STOCK_WARNING_THRESHOLD) product.fbs_low_sku_count += 1;
    }
    product.last_synced_at = maxTextDate(product.last_synced_at, sku.last_synced_at);
  }

  const result = [...productsMap.values()].map((product) => withStockAlertStatus(product));
  return {
    rows: result,
    meta: {
      total: result.length,
      warning_count: result.filter((row) => row.alert_level !== "ok").length,
      last_synced_at: result.reduce((latest, row) => maxTextDate(latest, row.last_synced_at), "")
    }
  };
}

export function stockWarehouseRules() {
  return all(`
    SELECT *
    FROM stock_warehouse_rules
    ORDER BY enabled DESC, priority ASC, id ASC
  `);
}

export function createStockWarehouseRule(body = {}) {
  const pattern = requiredText(body.pattern, "匹配关键词");
  const stockType = normalizeStockType(body.stock_type);
  const result = db.prepare(`
    INSERT INTO stock_warehouse_rules (pattern, stock_type, priority, enabled, note)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(pattern) DO UPDATE SET
      stock_type = excluded.stock_type,
      priority = excluded.priority,
      enabled = excluded.enabled,
      note = excluded.note,
      updated_at = CURRENT_TIMESTAMP
  `).run(pattern, stockType, Number(body.priority || 100), body.enabled === undefined ? 1 : Number(body.enabled ? 1 : 0), body.note || "");
  reclassifyStockSnapshots();
  return { ok: true, id: Number(result.lastInsertRowid || 0), rules: stockWarehouseRules(), alerts: stockAlerts() };
}

export function updateStockWarehouseRule(id, body = {}) {
  const existing = get("SELECT * FROM stock_warehouse_rules WHERE id = ?", [Number(id)]);
  if (!existing) throw new Error("仓库映射规则不存在");
  db.prepare(`
    UPDATE stock_warehouse_rules
    SET pattern = ?, stock_type = ?, priority = ?, enabled = ?, note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    requiredText(body.pattern ?? existing.pattern, "匹配关键词"),
    normalizeStockType(body.stock_type ?? existing.stock_type),
    Number(body.priority ?? existing.priority ?? 100),
    body.enabled === undefined ? Number(existing.enabled || 0) : Number(body.enabled ? 1 : 0),
    body.note ?? existing.note ?? "",
    Number(id)
  );
  reclassifyStockSnapshots();
  return { ok: true, rules: stockWarehouseRules(), alerts: stockAlerts() };
}

export function deleteStockWarehouseRule(id) {
  db.prepare("UPDATE stock_warehouse_rules SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(Number(id));
  reclassifyStockSnapshots();
  return { ok: true, rules: stockWarehouseRules(), alerts: stockAlerts() };
}

export async function syncOzonStocks(body = {}, options = {}) {
  const targetShopId = nullable(body.shop_id);
  const productId = nullable(body.product_id);
  const activeShops = shops().filter((shop) => shop.status === "active" && (!targetShopId || Number(shop.id) === Number(targetShopId)));
  let fetched = 0;
  let upserted = 0;
  const errors = [];

  for (const shop of activeShops) {
    try {
      const filters = stockSyncFilters(shop.id, productId);
      let rows = await fetchOzonProductStocks(shop, { ...filters, signal: options.signal });
      if (!rows.length) rows = fallbackStockRowsFromOnlineProducts(shop.id, productId);
      fetched += rows.length;
      for (const row of rows) {
        upsertStockSnapshot(shop.id, row);
        upserted += 1;
      }
    } catch (error) {
      const fallbackRows = fallbackStockRowsFromOnlineProducts(shop.id, productId);
      if (fallbackRows.length) {
        fetched += fallbackRows.length;
        for (const row of fallbackRows) {
          upsertStockSnapshot(shop.id, row);
          upserted += 1;
        }
        errors.push(`${shop.name}: Ozon 接口失败，已使用本地在线商品库存缓存 (${error.message})`);
      } else {
        errors.push(`${shop.name}: ${error.message}`);
      }
    }
  }

  const status = errors.length ? "partial_error" : "ok";
  const message = `Fetched ${fetched}, upserted ${upserted}${errors.length ? `; ${errors.join(" | ")}` : ""}`;
  db.prepare("INSERT INTO sync_logs (job, status, message) VALUES ('ozon_stocks', ?, ?)").run(status, message);
  if (errors.length && upserted === 0) throw new Error(errors.join(" | "));
  return { fetched, upserted, errors, alerts: stockAlerts() };
}

export function shops() {
  return all("SELECT * FROM shops WHERE status != 'deleted' ORDER BY id");
}

export function people() {
  return all("SELECT * FROM people ORDER BY active DESC, id");
}

export function mappings() {
  return all(`
    SELECT sm.*, s.name AS shop_name, p.code AS product_code, p.name AS product_name,
      p.image_url AS product_image_url,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS inventory_id,
      pe.name AS person_name, op.name AS online_name, op.primary_image AS online_primary_image, op.image_url AS online_image_url
    FROM sku_mappings sm
    JOIN shops s ON s.id = sm.shop_id
    JOIN products p ON p.id = sm.product_id
    LEFT JOIN people pe ON pe.id = sm.person_id
    LEFT JOIN online_products op ON op.id = sm.online_product_id
    ORDER BY sm.id DESC
  `);
}

export function updateSkuMapping(id, body) {
  const mappingId = Number(id);
  const existing = get("SELECT * FROM sku_mappings WHERE id = ?", [mappingId]);
  if (!existing) throw new Error("SKU 绑定不存在");
  const productId = Number(body.product_id || existing.product_id);
  const product = get("SELECT id FROM products WHERE id = ? AND active = 1", [productId]);
  if (!product) throw new Error("库存产品不存在或已隐藏");
  const active = body.active === undefined ? existing.active : Number(body.active || 0);
  db.prepare(`
    UPDATE sku_mappings
    SET product_id = ?, person_id = ?, active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(productId, nullable(body.person_id), active, mappingId);
  if (existing.online_product_id) {
    db.prepare("UPDATE online_products SET product_id = ? WHERE id = ?").run(active ? productId : null, existing.online_product_id);
  }
  if (active) {
    db.prepare(`
      UPDATE order_items
      SET sku_mapping_id = ?
      WHERE ozon_sku = ? AND order_id IN (SELECT id FROM orders WHERE shop_id = ?)
    `).run(mappingId, existing.ozon_sku, existing.shop_id);
    recalculateOrderItemsForMapping(mappingId);
  } else {
    db.prepare("UPDATE order_items SET sku_mapping_id = NULL WHERE sku_mapping_id = ?").run(mappingId);
  }
  syncOutboundForOpenOrders();
  return { ok: true, id: mappingId };
}

export function deleteSkuMapping(id) {
  return updateSkuMapping(id, { active: 0, product_id: get("SELECT product_id FROM sku_mappings WHERE id = ?", [Number(id)])?.product_id });
}

export function orders() {
  const rows = all(`
    SELECT o.*, s.name AS shop_name, COUNT(oi.id) AS item_count,
      COALESCE(SUM(oi.quantity), 0) AS total_quantity,
      SUM(oi.sale_price * oi.quantity) AS revenue,
      SUM(oi.estimated_profit) AS estimated_profit,
      SUM(oi.actual_profit) AS actual_profit,
      COALESCE(SUM(opi.purchase_cost_cny), 0) AS profit_purchase_cost,
      COALESCE(SUM(opi.domestic_shipping_cny), 0) AS profit_domestic_shipping,
      COALESCE(SUM(opi.international_shipping_cny), 0) AS profit_international_shipping,
      COALESCE(SUM(opi.packaging_cost_cny), 0) AS profit_packaging_cost,
      COALESCE(SUM(opi.commission_fee_cny), 0) AS profit_commission_fee,
      COALESCE(SUM(opi.ozon_service_fee_cny), 0) AS profit_ozon_service_fee,
      COALESCE(SUM(opi.return_loss_cny), 0) AS profit_return_loss,
      GROUP_CONCAT(DISTINCT oi.ozon_sku) AS skus,
      GROUP_CONCAT(oi.ozon_sku || ':' || oi.quantity, '||') AS sku_quantities,
      GROUP_CONCAT(oi.ozon_sku || ':' || oi.sale_price || ':' || oi.quantity, '||') AS sku_prices,
      GROUP_CONCAT(oi.ozon_sku || ':' || COALESCE(NULLIF(oi.ozon_name, ''), NULLIF(op.name, ''), ''), '||') AS sku_names,
      GROUP_CONCAT(oi.ozon_sku || ':' || COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), ''), '||') AS sku_images,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN oi.ozon_sku || ':' || p.id END) AS sku_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN op.id IS NOT NULL THEN oi.ozon_sku || ':' || op.id END) AS sku_online_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN sm.id IS NOT NULL THEN oi.ozon_sku || ':' || sm.id END) AS sku_mapping_ids,
      GROUP_CONCAT(DISTINCT p.id) AS product_ids,
      GROUP_CONCAT(DISTINCT sm.offer_id) AS offer_ids,
      COUNT(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN 1 END) AS unbound_item_count,
      COALESCE(SUM(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN oi.quantity ELSE 0 END), 0) AS unbound_quantity,
      GROUP_CONCAT(DISTINCT CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN oi.ozon_sku END) AS unbound_skus,
      GROUP_CONCAT(DISTINCT COALESCE(CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END, 'UNBOUND')) AS product_codes,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END END) AS inventory_ids,
      GROUP_CONCAT(DISTINCT COALESCE(p.name, 'Unbound product')) AS product_names,
      GROUP_CONCAT(DISTINCT COALESCE(p.purchase_url, '')) AS purchase_urls,
      GROUP_CONCAT(DISTINCT COALESCE(p.purchase_cost, 0)) AS purchase_costs,
      GROUP_CONCAT(DISTINCT COALESCE(p.supplier_note, '')) AS supplier_notes,
      GROUP_CONCAT(DISTINCT COALESCE(p.shipping_method, '')) AS product_shipping_methods,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.package_weight_g, 0) END) AS package_weights,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.length_cm, 0) || 'x' || COALESCE(p.width_cm, 0) || 'x' || COALESCE(p.height_cm, 0) END) AS package_dimensions,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), p.image_url, '')) AS image_urls,
      COALESCE(om.mark_type, '') AS mark_type,
      COALESCE(om.note, '') AS mark_note,
      olp.printed_at AS printed_at,
      raw.raw_json AS raw_json
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN sku_mappings sm ON (
      (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
      AND sm.active = 1
    )
    LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
    LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    LEFT JOIN order_marks om ON om.order_id = o.id
    LEFT JOIN order_label_prints olp ON olp.order_id = o.id
    LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
    GROUP BY o.id
    ORDER BY o.ordered_at DESC
    LIMIT 10000
  `);
  return rows.map(enrichOrderLogistics);
}

export function ordersPaged(query = {}) {
  const pageSize = Math.min(Math.max(Number(query.pageSize || query.page_size || 30), 1), 100);
  const page = Math.max(Number(query.page || 1), 1);
  const base = orderBaseSql(query);
  const counts = orderPagedSqlCounts(base);
  const filtered = orderFilteredSql(query, base);
  const total = get(`SELECT COUNT(*) AS total FROM orders o ${filtered.joins} WHERE ${filtered.where}`, filtered.params)?.total || 0;
  const start = (page - 1) * pageSize;
  const sortMode = String(query.sortMode || query.sort_mode || "ordered");
  let rows;
  if (sortMode === "inventory") {
    const allIdRows = all(`
      SELECT o.id
      FROM orders o
      ${filtered.joins}
      WHERE ${filtered.where}
      GROUP BY o.id
      ${orderSqlSort(query)}
    `, filtered.params);
    rows = sortPagedOrders(orderRowsByIds(allIdRows.map((row) => row.id)), query).slice(start, start + pageSize);
  } else {
    const idRows = all(`
      SELECT o.id
      FROM orders o
      ${filtered.joins}
      WHERE ${filtered.where}
      GROUP BY o.id
      ${orderSqlSort(query)}
      LIMIT ? OFFSET ?
    `, [...filtered.params, pageSize, start]);
    rows = orderRowsByIds(idRows.map((row) => row.id));
  }
  return {
    rows,
    total,
    page,
    pageSize,
    counts,
    mode: "paged"
  };
}

export function exceptionWorkbench() {
  const tasks = [];
  const orderRows = orders().filter((row) => orderMatchesBaseQuery(row, {
    dateFrom: dateKeyDaysAgo(60),
    dateTo: exceptionTodayDateKey()
  }));
  for (const row of orderRows) {
    const work = orderTaskState(row);
    const context = exceptionOrderContext(row);
    const profitValue = Number(row.actual_profit || row.estimated_profit || 0);
    const printed = Boolean(row.printed_at);
    const canPrint = logisticsModeKey(row) !== "fbp";
    if (["unbound", "stock_issue"].includes(work.key)) {
      tasks.push(exceptionTask({
        type: work.key === "stock_issue" ? "order_stock_shortage" : "order_binding",
        level: work.key === "stock_issue" ? "danger" : "warning",
        title: work.key === "stock_issue" ? "订单库存不足" : "订单待绑定库存",
        subject: row.posting_number || row.order_number || `订单 ${row.id}`,
        meta: `${row.shop_name || ""} / ${formatDateText(row.ordered_at)}`,
        detail: work.key === "stock_issue" ? "已绑定库存但数量不足，需要采购或调整库存。" : "订单 SKU 还没有绑定实际库存，利润和出库都会不准。",
        action: "order-unbound",
        orderId: row.id,
        ...context
      }));
    }
    if (profitValue < 0 && !["cancelled", "unbound"].includes(work.key)) {
      tasks.push(exceptionTask({
        type: "profit",
        level: "danger",
        title: "订单利润为负",
        subject: row.posting_number || row.order_number || `订单 ${row.id}`,
        meta: `${row.shop_name || ""} / ¥${profitValue.toFixed(2)}`,
        detail: "通常是库存绑定、克重、佣金或物流规则异常，需要核验并重算利润。",
        action: "order-profit",
        orderId: row.id,
        ...context
      }));
    }
    const deadlineInfo = orderExceptionDeadlineInfo(row);
    if (deadlineInfo) {
      tasks.push(exceptionTask({
        type: "deadline",
        level: "danger",
        title: deadlineInfo.reason,
        subject: row.posting_number || row.order_number || `订单 ${row.id}`,
        meta: `${row.shop_name || ""} / ${deadlineInfo.meta}`,
        detail: deadlineInfo.detail,
        action: "order-overdue",
        orderId: row.id,
        deadline_reason: deadlineInfo.reason,
        ...context
      }));
    }
  }
  for (const row of stockAlerts().rows || []) {
    for (const warning of row.warnings || []) {
      if (!["local", "fbp", "fbs", "mapping"].includes(warning.type)) continue;
      tasks.push(exceptionTask({
        type: `stock_${warning.type}`,
        level: warning.level || "warning",
        title: warning.text || "库存预警",
        subject: row.product_name || row.inventory_id || `库存 ${row.product_id}`,
        meta: `${row.inventory_id || ""} / 本地 ${row.local_stock ?? 0}`,
        detail: row.suggestion || "需要人工核验库存和 SKU 绑定关系。",
        action: `stock-${warning.type}`,
        productId: row.product_id,
        image_url: row.image_url || "",
        product_name: row.product_name || row.inventory_id || "",
        inventory_id: row.inventory_id || "",
        sku_text: stockAlertSkuText(row)
      }));
    }
  }
  tasks.sort((a, b) => exceptionPriorityValue(b) - exceptionPriorityValue(a));
  const stateMap = exceptionTaskStateMap(tasks.map((task) => task.id));
  const visibleTasks = tasks.filter((task) => !["handled", "ignored"].includes(stateMap.get(task.id)?.status));
  return {
    rows: visibleTasks,
    total: visibleTasks.length,
    hidden_total: tasks.length - visibleTasks.length,
    counts: {
      danger: visibleTasks.filter((item) => item.level === "danger").length,
      warning: visibleTasks.filter((item) => item.level === "warning").length,
      info: visibleTasks.filter((item) => item.level === "info").length,
      order: visibleTasks.filter((item) => item.type.startsWith("order") || ["print", "profit", "deadline"].includes(item.type)).length,
      stock: visibleTasks.filter((item) => item.type.startsWith("stock")).length
    },
    generated_at: new Date().toISOString()
  };
}

export function updateExceptionTaskState(body = {}, userId = null) {
  const taskId = String(body.task_id || body.id || "").trim();
  if (!taskId) throw new Error("缺少异常任务 ID");
  const status = String(body.status || "handled").trim();
  if (!["open", "handled", "ignored"].includes(status)) throw new Error("异常任务状态不正确");
  if (status === "open") {
    db.prepare("DELETE FROM exception_task_states WHERE task_id = ?").run(taskId);
    return { ok: true, task_id: taskId, status };
  }
  db.prepare(`
    INSERT INTO exception_task_states (task_id, status, note, updated_by_person_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      status = excluded.status,
      note = excluded.note,
      updated_by_person_id = excluded.updated_by_person_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(taskId, status, String(body.note || ""), userId || null);
  return { ok: true, task_id: taskId, status };
}

function exceptionTaskStateMap(taskIds = []) {
  const ids = [...new Set(taskIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = all(`
    SELECT task_id, status, note, updated_at
    FROM exception_task_states
    WHERE task_id IN (${ids.map(() => "?").join(",")})
  `, ids);
  return new Map(rows.map((row) => [row.task_id, row]));
}

function exceptionTask(values) {
  return { id: randomTaskId(values), ...values };
}

function exceptionOrderContext(row) {
  const productName = firstCsvValue(row.product_names) || firstMappedValue(row.sku_names) || row.posting_number || "";
  const skuText = firstCsvValue(row.skus || row.unbound_skus);
  const inventoryId = firstCsvValue(row.inventory_ids || row.product_codes);
  const imageUrl = firstCsvValue(row.image_urls) || firstMappedValue(row.sku_images);
  const weight = firstCsvValue(row.package_weights);
  const dimensions = firstCsvValue(row.package_dimensions);
  return {
    image_url: imageUrl,
    product_name: productName === "Unbound product" ? "待绑定库存商品" : productName,
    sku_text: skuText,
    inventory_id: inventoryId && inventoryId !== "UNBOUND" ? inventoryId : "",
    dimensions_text: [weight ? `克重 ${weight}g` : "", dimensions && dimensions !== "0x0x0" ? `尺寸 ${dimensions}cm` : ""].filter(Boolean).join(" / "),
    profit_context_text: profitExceptionContextText(row),
    onlineProductId: Number(firstMappedId(row.sku_online_product_ids, skuText)) || undefined,
    productId: Number(firstCsvValue(row.product_ids)) || undefined
  };
}

function profitExceptionContextText(row) {
  const revenue = Number(row.revenue || 0);
  const profit = Number(row.actual_profit || row.estimated_profit || 0);
  const margin = revenue ? profit / revenue * 100 : 0;
  const shipping = shippingMethodText(row.product_shipping_methods);
  const costs = [
    ["采购", row.profit_purchase_cost],
    ["国内", row.profit_domestic_shipping],
    ["国际", row.profit_international_shipping],
    ["佣金", row.profit_commission_fee],
    ["Ozon服务估算", row.profit_ozon_service_fee],
    ["退货", row.profit_return_loss]
  ].map(([label, value]) => `${label}¥${roundMoney(value)}`).join(" / ");
  return `销售¥${roundMoney(revenue)} / 利润¥${roundMoney(profit)} / 利润率${roundMoney(margin)}% / 运送方式${shipping || "未标明"} / ${costs}`;
}

function shippingMethodText(value) {
  const labels = {
    air: "空运",
    air_land: "陆空",
    land: "陆运"
  };
  const methods = [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
  return methods.map((method) => labels[method] || method).join("+");
}

function firstCsvValue(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean)[0] || "";
}

function firstMappedValue(value) {
  const first = String(value || "").split("||").map((item) => item.trim()).filter(Boolean)[0] || "";
  const index = first.indexOf(":");
  return index >= 0 ? first.slice(index + 1).trim() : first;
}

function firstMappedId(value, preferredKey = "") {
  const entries = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  const preferred = entries.find((item) => preferredKey && item.startsWith(`${preferredKey}:`));
  const first = preferred || entries[0] || "";
  const index = first.indexOf(":");
  return index >= 0 ? first.slice(index + 1).trim() : first;
}

function stockAlertSkuText(row) {
  const skus = Array.isArray(row.skus) ? row.skus : [];
  return skus.slice(0, 3).map((item) => [item.shop_name, item.ozon_sku, item.name].filter(Boolean).join(" / ")).join("；");
}

function randomTaskId(values) {
  return [values.type, values.orderId || values.productId || values.subject || "", values.title || ""].join(":");
}

function exceptionPriorityValue(task) {
  const level = { danger: 3, warning: 2, info: 1 }[task.level] || 0;
  const typeBoost = task.type === "order_binding" ? 0.4 : task.type === "profit" ? 0.3 : 0;
  return level + typeBoost;
}

function orderTaskState(row) {
  if (orderMatchesStatusQuery(row, "cancelled")) return { key: "cancelled", label: "已取消/退货" };
  if (orderMatchesStatusQuery(row, "dispute")) return { key: "dispute", label: "有争议" };
  if (orderMatchesStatusQuery(row, "delivered")) return { key: "delivered", label: "已签收" };
  if (orderHasUnboundStockQuery(row)) return { key: "unbound", label: "待绑定库存" };
  if (orderMatchesStatusQuery(row, "delivering")) return { key: "delivering", label: "运输中" };
  if (orderMatchesStatusQuery(row, "awaiting_deliver")) return { key: "awaiting_deliver", label: "等待发运" };
  if (orderMatchesStatusQuery(row, "awaiting_packaging")) return { key: "awaiting_packaging", label: "等待备货" };
  return { key: "awaiting_packaging", label: "等待备货" };
}

function orderTaskOverdue(row) {
  if (orderMatchesStatusQuery(row, "cancelled") || orderMatchesStatusQuery(row, "delivered") || orderMatchesStatusQuery(row, "delivering") || orderMatchesStatusQuery(row, "awaiting_deliver")) return false;
  const days = Number(row.ship_days_remaining);
  if (Number.isFinite(days)) return days < 0;
  const deadline = String(row.shipment_deadline_at || "").slice(0, 10);
  return Boolean(deadline && deadline < exceptionTodayDateKey());
}

function orderExceptionDeadlineInfo(row) {
  if (orderMatchesStatusQuery(row, "cancelled") || orderMatchesStatusQuery(row, "delivered")) return null;
  const now = new Date();
  const deadline = parseDate(row.shipment_deadline_at);
  const shipped = orderMatchesStatusQuery(row, "delivering") || Boolean(row.tracking_number);
  if (!shipped && deadline && deadline < now) {
    return {
      reason: "发货超时",
      meta: `发货截止 ${formatDateText(row.shipment_deadline_at)}`,
      detail: "订单超过备货/发货截止时间仍未进入发运状态，需要优先处理。"
    };
  }
  if (!orderMatchesStatusQuery(row, "delivering")) return null;
  const orderedAt = parseDate(row.ordered_at);
  if (!orderedAt) return null;
  const shipping = exceptionShippingMethodKey(row);
  const threshold = shipping === "land" ? 20 : 15;
  const days = Math.floor((now.getTime() - orderedAt.getTime()) / (24 * 60 * 60 * 1000));
  if (days <= threshold) return null;
  const methodLabel = shipping === "land" ? "陆运" : "陆空";
  return {
    reason: `签收超时-${methodLabel}`,
    meta: `${methodLabel} ${days} 天 / 标准 ${threshold} 天`,
    detail: `订单已进入运输但超过 ${methodLabel} 预计签收时长，需核验物流节点。`
  };
}

function exceptionShippingMethodKey(row) {
  const text = `${row.product_shipping_methods || ""} ${row.delivery_method_name || ""} ${row.logistics_channel || ""} ${row.warehouse_name || ""}`.toLowerCase();
  if (text.includes("land") || text.includes("陆运")) return "land";
  return "air_land";
}

function exceptionTodayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function formatDateText(value) {
  return value ? String(value).replace("T", " ").slice(0, 16) : "-";
}

function orderRowsByIds(ids) {
  const cleanIds = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!cleanIds.length) return [];
  const rows = all(`
    SELECT o.*, s.name AS shop_name, COUNT(oi.id) AS item_count,
      COALESCE(SUM(oi.quantity), 0) AS total_quantity,
      SUM(oi.sale_price * oi.quantity) AS revenue,
      SUM(oi.estimated_profit) AS estimated_profit,
      SUM(oi.actual_profit) AS actual_profit,
      COALESCE(SUM(opi.purchase_cost_cny), 0) AS profit_purchase_cost,
      COALESCE(SUM(opi.domestic_shipping_cny), 0) AS profit_domestic_shipping,
      COALESCE(SUM(opi.international_shipping_cny), 0) AS profit_international_shipping,
      COALESCE(SUM(opi.packaging_cost_cny), 0) AS profit_packaging_cost,
      COALESCE(SUM(opi.commission_fee_cny), 0) AS profit_commission_fee,
      COALESCE(SUM(opi.ozon_service_fee_cny), 0) AS profit_ozon_service_fee,
      COALESCE(SUM(opi.return_loss_cny), 0) AS profit_return_loss,
      GROUP_CONCAT(DISTINCT oi.ozon_sku) AS skus,
      GROUP_CONCAT(oi.ozon_sku || ':' || oi.quantity, '||') AS sku_quantities,
      GROUP_CONCAT(oi.ozon_sku || ':' || oi.sale_price || ':' || oi.quantity, '||') AS sku_prices,
      GROUP_CONCAT(oi.ozon_sku || ':' || COALESCE(NULLIF(oi.ozon_name, ''), NULLIF(op.name, ''), ''), '||') AS sku_names,
      GROUP_CONCAT(oi.ozon_sku || ':' || COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), ''), '||') AS sku_images,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN oi.ozon_sku || ':' || p.id END) AS sku_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN op.id IS NOT NULL THEN oi.ozon_sku || ':' || op.id END) AS sku_online_product_ids,
      GROUP_CONCAT(DISTINCT CASE WHEN sm.id IS NOT NULL THEN oi.ozon_sku || ':' || sm.id END) AS sku_mapping_ids,
      GROUP_CONCAT(DISTINCT p.id) AS product_ids,
      GROUP_CONCAT(DISTINCT sm.offer_id) AS offer_ids,
      COUNT(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN 1 END) AS unbound_item_count,
      COALESCE(SUM(CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN oi.quantity ELSE 0 END), 0) AS unbound_quantity,
      GROUP_CONCAT(DISTINCT CASE WHEN oi.id IS NOT NULL AND p.id IS NULL THEN oi.ozon_sku END) AS unbound_skus,
      GROUP_CONCAT(DISTINCT COALESCE(CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END, 'UNBOUND')) AS product_codes,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END END) AS inventory_ids,
      GROUP_CONCAT(DISTINCT COALESCE(p.name, 'Unbound product')) AS product_names,
      GROUP_CONCAT(DISTINCT COALESCE(p.purchase_url, '')) AS purchase_urls,
      GROUP_CONCAT(DISTINCT COALESCE(p.purchase_cost, 0)) AS purchase_costs,
      GROUP_CONCAT(DISTINCT COALESCE(p.supplier_note, '')) AS supplier_notes,
      GROUP_CONCAT(DISTINCT COALESCE(p.shipping_method, '')) AS product_shipping_methods,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.package_weight_g, 0) END) AS package_weights,
      GROUP_CONCAT(DISTINCT CASE WHEN p.id IS NOT NULL THEN COALESCE(p.length_cm, 0) || 'x' || COALESCE(p.width_cm, 0) || 'x' || COALESCE(p.height_cm, 0) END) AS package_dimensions,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(oi.ozon_image_url, ''), NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), p.image_url, '')) AS image_urls,
      COALESCE(om.mark_type, '') AS mark_type,
      COALESCE(om.note, '') AS mark_note,
      olp.printed_at AS printed_at,
      raw.raw_json AS raw_json
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN sku_mappings sm ON (
      (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
      AND sm.active = 1
    )
    LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
    LEFT JOIN online_products op ON op.shop_id = o.shop_id AND op.ozon_sku = oi.ozon_sku
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    LEFT JOIN order_marks om ON om.order_id = o.id
    LEFT JOIN order_label_prints olp ON olp.order_id = o.id
    LEFT JOIN ozon_orders_raw raw ON raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
    WHERE o.id IN (${cleanIds.map(() => "?").join(",")})
    GROUP BY o.id
  `, cleanIds).map(enrichOrderLogistics);
  const order = new Map(cleanIds.map((id, index) => [String(id), index]));
  return rows.sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0));
}

function orderBaseSql(query = {}) {
  const where = ["1 = 1"];
  const params = [];
  const shopId = String(query.shopId || query.shop_id || "all");
  if (shopId !== "all") {
    where.push("o.shop_id = ?");
    params.push(Number(shopId));
  }
  const from = normalizeSyncDate(query.dateFrom || query.date_from);
  const to = normalizeSyncDate(query.dateTo || query.date_to);
  if (from) {
    where.push("o.ordered_at >= ?");
    params.push(`${from}T00:00:00.000`);
  }
  if (to) {
    where.push("o.ordered_at <= ?");
    params.push(`${to}T23:59:59.999`);
  }
  addOrderSearchSql(where, params, query);
  return { where: where.join(" AND "), params };
}

function orderFilteredSql(query, base) {
  const where = [base.where];
  const params = [...base.params];
  where.push(orderStatusSql(query.status || "all"));
  const mark = String(query.markFilter || query.mark_filter || "all");
  if (mark === "quality") {
    const prefixes = orderQualityPrefixes();
    const qualityParts = ["COALESCE((SELECT mark_type FROM order_marks WHERE order_id = o.id), '') = ?"];
    params.push("quality");
    for (const prefix of prefixes) {
      qualityParts.push("o.posting_number LIKE ?");
      params.push(`${prefix}%`);
    }
    where.push(`(${qualityParts.join(" OR ")})`);
  } else if (mark !== "all") {
    where.push("COALESCE((SELECT mark_type FROM order_marks WHERE order_id = o.id), '') = ?");
    params.push(mark);
  }
  const print = String(query.printFilter || query.print_filter || "all");
  if (print === "printed") where.push("EXISTS (SELECT 1 FROM order_label_prints olp WHERE olp.order_id = o.id)");
  if (print === "unprinted") where.push("NOT EXISTS (SELECT 1 FROM order_label_prints olp WHERE olp.order_id = o.id)");
  return { joins: "", where: where.filter(Boolean).join(" AND "), params };
}

function orderPagedSqlCounts(base) {
  const statuses = ["all", "awaiting_packaging", "awaiting_deliver", "delivering", "dispute", "delivered", "cancelled", "unbound"];
  const counts = {};
  for (const status of statuses) {
    const where = status === "all" ? base.where : `${base.where} AND ${orderStatusSql(status)}`;
    counts[status] = Number(get(`SELECT COUNT(*) AS count FROM orders o WHERE ${where}`, base.params)?.count || 0);
  }
  return counts;
}

function addOrderSearchSql(where, params, query) {
  const text = String(query.searchQuery || query.search_query || "").trim();
  if (!text) return;
  const like = `%${text.toLowerCase()}%`;
  const type = String(query.searchType || query.search_type || "order");
  if (type === "order") {
    where.push("(LOWER(o.posting_number) LIKE ? OR LOWER(COALESCE(o.order_number, '')) LIKE ?)");
    params.push(like, like);
    return;
  }
  if (type === "tracking") {
    where.push("(LOWER(COALESCE(o.tracking_number, '')) LIKE ? OR LOWER(COALESCE(o.logistics_status, '')) LIKE ? OR LOWER(COALESCE(o.tracking_stage, '')) LIKE ?)");
    params.push(like, like, like);
    return;
  }
  if (type === "sku") {
    where.push("EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND LOWER(oi.ozon_sku || ' ' || COALESCE(oi.ozon_name, '')) LIKE ?)");
    params.push(like);
    return;
  }
  if (type === "offer") {
    where.push("EXISTS (SELECT 1 FROM order_items oi LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id WHERE oi.order_id = o.id AND LOWER(COALESCE(sm.offer_id, '') || ' ' || oi.ozon_sku) LIKE ?)");
    params.push(like);
    return;
  }
  if (type === "product") {
    where.push(`EXISTS (
      SELECT 1 FROM order_items oi
      LEFT JOIN sku_mappings sm ON (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku)) AND sm.active = 1
      LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
      WHERE oi.order_id = o.id AND LOWER(COALESCE(p.name, '') || ' ' || COALESCE(p.code, '') || ' ' || COALESCE(p.selection_id, '') || ' ' || oi.ozon_sku) LIKE ?
    )`);
    params.push(like);
  }
}

function orderStatusSql(status) {
  if (status === "all") return "1 = 1";
  if (status === "unbound") return `EXISTS (
    SELECT 1 FROM order_items oi
    LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id AND sm.active = 1
    LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
    WHERE oi.order_id = o.id AND p.id IS NULL
  )`;
  const state = "LOWER(COALESCE(o.status, ''))";
  const stage = "LOWER(COALESCE(o.tracking_stage, ''))";
  const value = `(${state} || ' ' || ${stage} || ' ' || LOWER(COALESCE(o.logistics_status, '')) || ' ' || LOWER(COALESCE(o.tracking_number, '')))`;
  if (status === "awaiting_packaging") return orderSqlAnyExact([state, stage], ["awaiting_registration", "acceptance_in_progress", "awaiting_approve", "awaiting_packaging", "posting_created", "posting_awaiting_registration", "posting_acceptance_in_progress"]);
  if (status === "awaiting_deliver") return orderSqlAnyExact([state, stage], ["awaiting_deliver", "posting_registered", "sent_by_seller", "posting_ready_for_pickup", "posting_transferred_to_courier_service"]);
  if (status === "dispute") return `(${value} LIKE '%arbitration%' OR ${value} LIKE '%dispute%')`;
  if (status === "cancelled") return `(${value} LIKE '%cancel%' OR ${value} LIKE '%return%' OR ${value} LIKE '%not_accepted%')`;
  if (status === "delivered") return `(${value} LIKE '%delivered%' AND NOT (${orderStatusSql("cancelled")}))`;
  if (status === "delivering") return `(
    ${value} NOT LIKE '%awaiting_packaging%' AND ${value} NOT LIKE '%awaiting_deliver%' AND ${value} NOT LIKE '%pending_stock%'
    AND (${value} LIKE '%delivering%' OR ${value} LIKE '%transferring%' OR ${value} LIKE '%carriage%' OR ${value} LIKE '%pickup%' OR ${value} LIKE '%sorting%' OR ${value} LIKE '%customs%' OR ${value} LIKE '%shipped%' OR ${value} LIKE '%sent%' OR ${value} LIKE '%on_way%' OR ${value} LIKE '%posting_in_carriage%' OR ${value} LIKE '%posting_transferring%' OR ${value} LIKE '%发往%' OR ${value} LIKE '%已上网%' OR ${value} LIKE '%发走%')
  )`;
  return "1 = 1";
}

function orderSqlAnyExact(columns, values) {
  const terms = [];
  for (const column of columns) {
    terms.push(`${column} IN (${values.map((value) => `'${value}'`).join(",")})`);
  }
  return `(${terms.join(" OR ")})`;
}

function orderSqlSort(query) {
  const mode = String(query.sortMode || query.sort_mode || "ordered");
  if (mode === "inventory") return "ORDER BY o.ordered_at DESC";
  if (String(query.status || "") === "awaiting_packaging") return "ORDER BY o.ordered_at DESC";
  return "ORDER BY o.ordered_at DESC";
}

function orderMatchesBaseQuery(row, query) {
  const shopId = String(query.shopId || query.shop_id || "all");
  if (shopId !== "all" && String(row.shop_id) !== shopId) return false;
  const value = String(row.ordered_at || row.created_at || "").slice(0, 10);
  const from = String(query.dateFrom || query.date_from || "");
  const to = String(query.dateTo || query.date_to || "");
  if (from && (!value || value < from)) return false;
  if (to && (!value || value > to)) return false;
  return orderMatchesSearchQuery(row, query);
}

function orderMatchesSearchQuery(row, query) {
  const text = String(query.searchQuery || query.search_query || "").trim().toLowerCase();
  if (!text) return true;
  const type = String(query.searchType || query.search_type || "order");
  if (type === "sku") return `${row.skus || ""} ${row.product_codes || ""} ${row.product_names || ""}`.toLowerCase().includes(text);
  if (type === "order") return `${row.posting_number || ""} ${row.order_number || ""}`.toLowerCase().includes(text);
  if (type === "product") return `${row.product_ids || ""} ${row.inventory_ids || ""} ${row.product_codes || ""} ${row.product_names || ""}`.toLowerCase().includes(text);
  if (type === "offer") return `${row.offer_ids || ""} ${row.product_codes || ""}`.toLowerCase().includes(text);
  if (type === "tracking") return `${row.tracking_number || ""} ${row.logistics_channel || ""}`.toLowerCase().includes(text);
  if (type === "purchaseTracking") return `${row.purchase_tracking_numbers || ""} ${row.purchase_order_numbers || ""}`.toLowerCase().includes(text);
  return true;
}

function orderPagedStatusCounts(rows) {
  const statuses = ["all", "awaiting_packaging", "awaiting_deliver", "delivering", "dispute", "delivered", "cancelled", "unbound"];
  const counts = Object.fromEntries(statuses.map((status) => [status, 0]));
  counts.all = rows.length;
  for (const row of rows) {
    for (const status of statuses) {
      if (status !== "all" && orderMatchesStatusQuery(row, status)) counts[status] += 1;
    }
  }
  return counts;
}

function orderMatchesStatusQuery(row, status) {
  if (status === "all") return true;
  if (status === "unbound") return orderHasUnboundStockQuery(row);
  const values = [row.status, row.tracking_stage].map((value) => String(value || "").toLowerCase());
  if (status === "awaiting_packaging") return values.some((value) => ["awaiting_registration", "acceptance_in_progress", "awaiting_approve", "awaiting_packaging", "posting_created", "posting_awaiting_registration", "posting_acceptance_in_progress"].includes(value));
  if (status === "awaiting_deliver") return values.some((value) => ["awaiting_deliver", "posting_registered", "sent_by_seller", "posting_ready_for_pickup", "posting_transferred_to_courier_service"].includes(value));
  if (status === "delivering") {
    const text = [row.status, row.tracking_stage, row.logistics_status, row.delivery_method_name, row.logistics_channel].map((value) => String(value || "").toLowerCase()).join(" ");
    if (text.includes("awaiting_packaging") || text.includes("awaiting_deliver") || text.includes("pending_stock")) return false;
    return ["delivering", "transferring", "carriage", "pickup", "sorting", "customs", "shipped", "sent", "on_way", "posting_in_carriage", "posting_transferring", "发往", "已上网", "发走"].some((keyword) => text.includes(keyword));
  }
  if (status === "dispute") return values.some((value) => value.includes("arbitration") || value.includes("dispute"));
  if (status === "delivered") return values.some((value) => value.includes("delivered")) && !orderMatchesStatusQuery(row, "cancelled");
  if (status === "cancelled") return values.some((value) => value.includes("cancel") || value.includes("return") || value === "not_accepted" || value.includes("not_accepted"));
  return false;
}

function orderHasUnboundStockQuery(row) {
  if (Number(row.unbound_item_count || 0) > 0 || Number(row.unbound_quantity || 0) > 0) return true;
  if (String(row.unbound_skus || "").trim()) return true;
  return String(row.product_codes || "").toUpperCase().split(",").map((item) => item.trim()).includes("UNBOUND")
    || String(row.product_names || "").toLowerCase().includes("unbound product")
    || String(row.product_names || "").includes("未绑定");
}

function orderMatchesMarkQuery(row, filter) {
  const value = String(filter || "all");
  if (value === "all") return true;
  return String(row.mark_type || "") === value;
}

function orderMatchesPrintQuery(row, query) {
  const filter = String(query.printFilter || query.print_filter || "all");
  if (filter === "all") return true;
  const printed = Boolean(row.printed_at || row.label_printed_at || row.shipping_label_printed_at);
  return filter === "printed" ? printed : !printed;
}

function sortPagedOrders(rows, query) {
  const mode = String(query.sortMode || query.sort_mode || "ordered");
  const status = String(query.status || "all");
  return [...rows].sort((a, b) => {
    if (mode === "inventory") {
      const key = orderInventoryPagedSortKey(a).localeCompare(orderInventoryPagedSortKey(b), "zh-Hans", { numeric: true });
      if (key) return key;
    } else if (status === "awaiting_packaging") {
      const key = logisticsModeKey(a).localeCompare(logisticsModeKey(b));
      if (key) return key;
    }
    return orderTimestampPagedValue(b) - orderTimestampPagedValue(a);
  });
}

function orderInventoryPagedSortKey(row) {
  const modePrefix = logisticsModeKey(row) === "fbp" ? "z-fbp" : "a-fbs";
  const key = String(row.inventory_ids || row.product_names || row.product_codes || row.skus || "zz-empty").split(",").map((item) => item.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-Hans", { numeric: true }))[0] || "zz-empty";
  return `${modePrefix}-${key}`;
}

function logisticsModeKey(row) {
  const combined = `${row.warehouse_name || ""} ${row.delivery_method_name || ""}`.toLowerCase();
  return combined.includes("hun chun") || combined.includes("hunchun") || combined.includes("混春") || combined.includes("混川") || combined.includes("珲春") || combined.includes("风船") || combined.includes("風船") || combined.includes("fbp")
    ? "fbp"
    : "fbs";
}

function orderTimestampPagedValue(row) {
  const time = new Date(row.ordered_at || row.created_at || row.updated_at || "").getTime();
  return Number.isFinite(time) ? time : 0;
}

export function updateOrderMark(orderId, body = {}, userId = null) {
  const id = Number(orderId);
  const order = get("SELECT id FROM orders WHERE id = ?", [id]);
  if (!order) throw new Error("订单不存在");
  const markType = String(body.mark_type || "").trim();
  const note = String(body.note || "").trim();
  if (!markType && !note) {
    db.prepare("DELETE FROM order_marks WHERE order_id = ?").run(id);
    return { ok: true, id, mark_type: "", note: "" };
  }
  db.prepare(`
    INSERT INTO order_marks (order_id, mark_type, note, updated_by_person_id, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(order_id) DO UPDATE SET
      mark_type = excluded.mark_type,
      note = excluded.note,
      updated_by_person_id = excluded.updated_by_person_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(id, markType, note, nullable(userId));
  return { ok: true, id, mark_type: markType, note };
}

export function orderQualityRules() {
  return all("SELECT * FROM order_quality_rules ORDER BY active DESC, prefix ASC, id ASC");
}

let qualityPrefixCache = null;

function orderQualityPrefixes() {
  if (qualityPrefixCache) return qualityPrefixCache;
  qualityPrefixCache = all("SELECT prefix FROM order_quality_rules WHERE active != 0 ORDER BY prefix ASC")
    .map((row) => String(row.prefix || "").trim())
    .filter(Boolean);
  return qualityPrefixCache;
}

export async function orderPackageLabel(body = {}, userId = null) {
  const ids = Array.isArray(body.order_ids) ? body.order_ids.map(Number).filter(Boolean) : [];
  const postingNumbers = Array.isArray(body.posting_numbers) ? body.posting_numbers.map((item) => String(item || "").trim()).filter(Boolean) : [];
  if (!ids.length && !postingNumbers.length) throw new Error("请选择需要打印面单的订单");
  const rawRows = ids.length ? all(`
    SELECT o.id, o.shop_id, o.posting_number, s.name AS shop_name, s.ozon_client_id, s.api_key_hint
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    WHERE o.id IN (${ids.map(() => "?").join(",")})
  `, ids) : all(`
    SELECT o.id, o.shop_id, o.posting_number, s.name AS shop_name, s.ozon_client_id, s.api_key_hint
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    WHERE o.posting_number IN (${postingNumbers.map(() => "?").join(",")})
  `, postingNumbers);
  const rows = ids.length
    ? sortRowsByInput(rawRows, ids, "id")
    : sortRowsByInput(rawRows, postingNumbers, "posting_number");
  if (!rows.length) throw new Error("请选择需要打印面单的订单");
  if (rows.length > 80) throw new Error("单次最多打印 80 个面单，请分批选择");
  const buffers = await mapWithConcurrency(rows, 4, async (row) => {
    const shop = {
      id: row.shop_id,
      name: row.shop_name,
      ozon_client_id: row.ozon_client_id,
      api_key_hint: row.api_key_hint
    };
    return await fetchOzonPackageLabel(shop, [row.posting_number]);
  });
  const buffer = await mergePdfBuffers(buffers);
  const suffix = rows.length === 1 ? rows[0].posting_number : `${rows.length}-orders`;
  return { buffer, filename: `ozon-labels-${suffix}.pdf`, count: rows.length };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function sortRowsByInput(rows, values, key) {
  const order = new Map(values.map((value, index) => [String(value), index]));
  return [...rows].sort((a, b) => (order.get(String(a[key])) ?? 0) - (order.get(String(b[key])) ?? 0));
}

async function mergePdfBuffers(buffers) {
  if (buffers.length === 1) return buffers[0];
  const merged = await PDFDocument.create();
  for (const buffer of buffers) {
    const source = await PDFDocument.load(buffer);
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  return Buffer.from(await merged.save());
}

export function markOrderLabelsPrinted(body = {}, userId = null) {
  const ids = Array.isArray(body.order_ids) ? body.order_ids.map(Number).filter(Boolean) : [];
  if (!ids.length) throw new Error("请选择需要记录打印状态的订单");
  const rows = all(`SELECT id FROM orders WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
  if (!rows.length) throw new Error("订单不存在");
  const stmt = db.prepare(`
    INSERT INTO order_label_prints (order_id, printed_at, printed_by_person_id)
    VALUES (?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(order_id) DO UPDATE SET printed_at = CURRENT_TIMESTAMP, printed_by_person_id = excluded.printed_by_person_id
  `);
  for (const row of rows) stmt.run(row.id, nullable(userId));
  return { ok: true, count: rows.length };
}

export async function shipOrders(body = {}, userId = null) {
  const ids = Array.isArray(body.order_ids) ? body.order_ids.map(Number).filter(Boolean) : [];
  if (!ids.length) throw new Error("请选择需要备货的订单");
  const ordersToShip = all(`
    SELECT o.id, o.shop_id, o.posting_number, s.name AS shop_name, s.ozon_client_id, s.api_key_hint
    FROM orders o
    JOIN shops s ON s.id = o.shop_id
    WHERE o.id IN (${ids.map(() => "?").join(",")})
  `, ids);
  if (!ordersToShip.length) throw new Error("订单不存在");
  const shipped = [];
  for (const order of sortRowsByInput(ordersToShip, ids, "id")) {
    const statusText = `${order.status || ""} ${order.tracking_stage || ""}`.toLowerCase();
    if (statusText.includes("awaiting_deliver") || statusText.includes("delivering") || statusText.includes("delivered")) {
      throw new Error("这个订单可能已经备货过了，请刷新订单列表后再操作");
    }
    const items = all(`
      SELECT oi.ozon_sku, oi.quantity
      FROM order_items oi
      WHERE oi.order_id = ?
    `, [order.id]);
    const shop = {
      id: order.shop_id,
      name: order.shop_name,
      ozon_client_id: order.ozon_client_id,
      api_key_hint: order.api_key_hint
    };
    await shipOzonPosting(shop, order.posting_number, items);
    db.prepare(`
      UPDATE orders
      SET status = 'awaiting_deliver',
          tracking_stage = 'awaiting_deliver',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(order.id);
    shipped.push(order.id);
  }
  return { ok: true, count: shipped.length, order_ids: shipped };
}

export function saveOrderQualityRules(body = {}) {
  qualityPrefixCache = null;
  const prefixes = Array.isArray(body.prefixes) ? body.prefixes : String(body.prefixes || "").split(/[\s,，;；]+/);
  const cleaned = [...new Set(prefixes.map((item) => String(item || "").trim()).filter(Boolean))];
  db.prepare("UPDATE order_quality_rules SET active = 0, updated_at = CURRENT_TIMESTAMP").run();
  const stmt = db.prepare(`
    INSERT INTO order_quality_rules (prefix, label, note, active, updated_at)
    VALUES (?, '质检单', ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(prefix) DO UPDATE SET
      label = excluded.label,
      note = excluded.note,
      active = 1,
      updated_at = CURRENT_TIMESTAMP
  `);
  const note = String(body.note || "疑似 Ozon 仓库质检单：不要正常发货，按仓库要求拍照处理。");
  for (const prefix of cleaned) stmt.run(prefix, note);
  recalculateOrderCancelLossFlags();
  return { ok: true, rules: orderQualityRules() };
}

export function recalculateOrderCancelLossFlags() {
  const rows = all(`
    SELECT id, posting_number, order_number, status, logistics_status, tracking_stage,
      cancel_reason_id, cancel_reason, cancel_initiator, cancel_type, cancelled_after_ship
    FROM orders
    WHERE LOWER(COALESCE(status, '')) LIKE '%cancel%'
      OR LOWER(COALESCE(tracking_stage, '')) LIKE '%cancel%'
      OR LOWER(COALESCE(status, '')) LIKE '%return%'
      OR LOWER(COALESCE(tracking_stage, '')) LIKE '%return%'
      OR COALESCE(cancel_reason, '') != ''
  `);
  const stmt = db.prepare("UPDATE orders SET cancel_loss_applies = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (const row of rows) stmt.run(orderCancelLossApplies(row) ? 1 : 0, row.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { updated: rows.length };
}

export function orderDetail(id) {
  const order = get("SELECT o.*, s.name AS shop_name FROM orders o JOIN shops s ON s.id = o.shop_id WHERE o.id = ?", [id]);
  if (!order) return null;
  const items = all(`
    SELECT oi.*, sm.ozon_sku AS mapped_ozon_sku, sm.offer_id,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS product_code,
      p.name AS product_name, pe.name AS owner_name,
      p.shipping_method,
      p.package_weight_g,
      p.length_cm,
      p.width_cm,
      p.height_cm,
      p.return_rate,
      opi.sale_amount_cny,
      opi.purchase_cost_cny,
      opi.domestic_shipping_cny,
      opi.international_shipping_cny,
      opi.packaging_cost_cny,
      opi.commission_fee_cny,
      opi.ozon_service_fee_cny,
      opi.return_loss_cny,
      opi.advertising_cost_cny,
      opi.other_fee_cny,
      opi.gross_profit_cny,
      opi.net_profit_cny,
      opi.profit_status
    FROM order_items oi
    LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
    LEFT JOIN products p ON p.id = sm.product_id
    LEFT JOIN people pe ON pe.id = sm.person_id
    LEFT JOIN order_profit_items opi ON opi.order_item_id = oi.id
    WHERE oi.order_id = ?
  `, [id]);
  const finance = all(`
    SELECT service_type, service_name,
      COALESCE(SUM(amount), 0) AS amount,
      COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS fee_amount,
      COUNT(*) AS rows,
      MAX(operation_date) AS operation_date
    FROM ozon_finance_items
    WHERE shop_id = ? AND posting_number = ?
    GROUP BY service_type, service_name
    ORDER BY fee_amount DESC, ABS(amount) DESC
  `, [order.shop_id, order.posting_number]);
  return { order, items, finance };
}

function enrichOrderLogistics(row) {
  const payload = parseJson(row.raw_json) || {};
  const raw = payload.raw || payload;
  const deliveryMethod = raw.delivery_method || {};
  const analytics = raw.analytics_data || {};
  const deadline = raw.shipment_date_without_delay || raw.shipment_date || fallbackShipDeadline(row.ordered_at);
  const remaining = deadline ? daysBetween(new Date(), new Date(deadline)) : null;
  const finished = ["delivered", "cancelled", "canceled"].includes(String(row.status || "").toLowerCase());
  const result = {
    ...row,
    raw_json: undefined,
    delivery_schema: "FBS self-ship",
    warehouse_name: deliveryMethod.warehouse || analytics.warehouse || "",
    delivery_method_name: deliveryMethod.name || "",
    logistics_channel: deliveryMethod.tpl_provider || analytics.tpl_provider || row.tracking_number || "",
    shipment_deadline_at: deadline,
    ship_days_remaining: remaining,
    ship_deadline_status: finished ? "done" : remaining == null ? "unknown" : remaining < 0 ? "overdue" : remaining <= 1 ? "urgent" : "normal"
  };
  return result;
}

export function procurementSummary() {
  return all(`
    SELECT p.id AS product_id,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS code,
      p.name, p.image_url, p.purchase_url, p.supplier_note,
      SUM(pr.quantity) AS total_quantity,
      SUM(pr.amount + COALESCE(pr.shipping_amount, 0)) AS total_amount,
      GROUP_CONCAT(pe.name || ':' || pr.quantity || '浠?楼' || pr.amount, '||') AS requesters,
      GROUP_CONCAT(DISTINCT COALESCE(NULLIF(pr.purchase_url, ''), NULLIF(p.purchase_url, ''))) AS purchase_links,
      MIN(pr.created_at) AS earliest_created_at,
      MAX(CASE WHEN julianday('now') - julianday(pr.created_at) >= 3 THEN 1 ELSE 0 END) AS overdue
    FROM procurement_requests pr
    JOIN products p ON p.id = pr.product_id
    LEFT JOIN people pe ON pe.id = pr.person_id
    WHERE pr.status = 'submitted'
    GROUP BY p.id
    ORDER BY earliest_created_at ASC, total_quantity DESC
  `);
}

export function procurementRequests() {
  return all(`
    SELECT pr.*,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS product_code,
      p.name AS product_name, p.image_url AS product_image_url, p.alert_stock,
      COALESCE(stock.stock, 0) AS stock,
      COALESCE(incoming.incoming_stock, 0) AS incoming_stock,
      COALESCE(skus.skus, '') AS mapped_skus,
      COALESCE(p.purchase_url, '') AS product_purchase_url, p.source_platform AS product_source_platform,
      pe.name AS person_name,
      COALESCE(s.name, ps.name, '') AS supplier_name,
      po.order_no AS purchase_order_no,
      CASE WHEN pr.status = 'pending' AND julianday('now') - julianday(pr.created_at) >= 3 THEN 1 ELSE 0 END AS overdue
    FROM procurement_requests pr
    JOIN products p ON p.id = pr.product_id
    LEFT JOIN people pe ON pe.id = pr.person_id
    LEFT JOIN suppliers s ON s.id = pr.supplier_id
    LEFT JOIN suppliers ps ON ps.id = p.supplier_id
    LEFT JOIN purchase_orders po ON po.id = pr.purchase_order_id
    LEFT JOIN (
      SELECT product_id, SUM(quantity_delta) AS stock
      FROM inventory_movements
      WHERE status = 'posted'
      GROUP BY product_id
    ) stock ON stock.product_id = p.id
    LEFT JOIN (
      SELECT product_id, SUM(quantity) AS incoming_stock
      FROM (
        SELECT product_id, quantity FROM inbound_records WHERE status = 'pending_arrival'
        UNION ALL
        SELECT product_id, quantity FROM procurement_requests WHERE status = 'submitted'
      )
      GROUP BY product_id
    ) incoming ON incoming.product_id = p.id
    LEFT JOIN (
      SELECT product_id, GROUP_CONCAT(ozon_sku, ', ') AS skus
      FROM sku_mappings
      WHERE active = 1
      GROUP BY product_id
    ) skus ON skus.product_id = p.id
    WHERE pr.status NOT IN ('purchased', 'done')
      AND COALESCE(po.status, '') NOT IN ('purchased', 'partial_inbound', 'inbound_done')
    ORDER BY pr.created_at DESC
  `);
}

export function purchaseOrders() {
  return all(`
    SELECT po.*, pe.name AS creator_name,
      COUNT(poi.id) AS item_count,
      COALESCE(SUM(poi.actual_quantity), SUM(poi.requested_quantity), po.total_quantity, 0) AS total_quantity,
      COALESCE(SUM(poi.amount + COALESCE(poi.shipping_amount, 0)), po.total_amount, 0) AS total_amount,
      GROUP_CONCAT(p.name, '||') AS product_names,
      GROUP_CONCAT(COALESCE(p.image_url, ''), '||') AS product_image_urls
    FROM purchase_orders po
    LEFT JOIN people pe ON pe.id = po.created_by_person_id
    LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
    LEFT JOIN products p ON p.id = poi.product_id
    WHERE po.status != 'cancelled'
    GROUP BY po.id
    ORDER BY po.created_at DESC, po.id DESC
  `);
}

export function purchaseOrderDetail(id) {
  const order = get("SELECT po.*, pe.name AS creator_name FROM purchase_orders po LEFT JOIN people pe ON pe.id = po.created_by_person_id WHERE po.id = ?", [Number(id)]);
  if (!order) return null;
  const items = all(`
    SELECT poi.*,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS product_code,
      p.name AS product_name, p.image_url AS product_image_url,
      COALESCE(skus.skus, '') AS mapped_skus
    FROM purchase_order_items poi
    JOIN products p ON p.id = poi.product_id
    LEFT JOIN (
      SELECT product_id, GROUP_CONCAT(ozon_sku, ', ') AS skus
      FROM sku_mappings
      WHERE active = 1
      GROUP BY product_id
    ) skus ON skus.product_id = p.id
    WHERE poi.purchase_order_id = ?
    ORDER BY poi.id
  `, [Number(id)]);
  const requests = all(`
    SELECT pr.*, pe.name AS person_name,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS product_code,
      p.name AS product_name
    FROM procurement_requests pr
    JOIN products p ON p.id = pr.product_id
    LEFT JOIN people pe ON pe.id = pr.person_id
    WHERE pr.purchase_order_id = ?
    ORDER BY pr.created_at
  `, [Number(id)]);
  return { order, items, requests };
}

export function pendingInboundItems() {
  return all(`
    SELECT ir.id AS inbound_record_id, ir.quantity AS expected_quantity, ir.status AS inbound_status,
      ir.note AS inbound_note, ir.qc_status, ir.amount, ir.shipping_amount, ir.unit_cost, ir.purchase_url,
      po.id AS purchase_order_id, po.order_no,
      poi.id AS purchase_order_item_id, poi.inbound_quantity, poi.actual_quantity,
      (poi.actual_quantity - poi.inbound_quantity) AS remaining_quantity,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS product_code,
      p.id AS product_id, p.name AS product_name, p.image_url AS product_image_url,
      COALESCE(skus.skus, '') AS mapped_skus
    FROM inbound_records ir
    JOIN purchase_order_items poi ON poi.id = ir.purchase_order_item_id
    JOIN purchase_orders po ON po.id = poi.purchase_order_id
    JOIN products p ON p.id = poi.product_id
    LEFT JOIN (
      SELECT product_id, GROUP_CONCAT(ozon_sku, ', ') AS skus
      FROM sku_mappings
      WHERE active = 1
      GROUP BY product_id
    ) skus ON skus.product_id = p.id
    WHERE ir.status = 'pending_arrival'
    ORDER BY po.created_at DESC, ir.id DESC
  `);
}

export function inboundRecords() {
  return all(`
    SELECT ir.*, p.code AS product_code, p.name AS product_name, p.image_url AS product_image_url,
      pe.name AS person_name, po.order_no AS purchase_order_no
    FROM inbound_records ir
    JOIN products p ON p.id = ir.product_id
    LEFT JOIN people pe ON pe.id = ir.person_id
    LEFT JOIN purchase_orders po ON po.id = ir.purchase_order_id
    ORDER BY ir.created_at DESC
  `);
}

export function outboundRecords() {
  return all(`
    SELECT obr.*, p.code AS product_code, p.name AS product_name, p.image_url AS product_image_url,
      s.name AS shop_name, COALESCE(obr.ozon_sku, op.ozon_sku) AS ozon_sku, pe.name AS person_name,
      COALESCE(op.image_url, op.primary_image, p.image_url, '') AS image_urls,
      COALESCE(obr.order_item_id, im.related_order_item_id) AS order_item_id, 'deducted' AS row_kind,
      oi.sale_price AS sale_price,
      (oi.sale_price * obr.quantity) AS order_amount,
      o.ordered_at AS outbound_time
    FROM outbound_records obr
    JOIN products p ON p.id = obr.product_id
    LEFT JOIN shops s ON s.id = obr.shop_id
    LEFT JOIN online_products op ON op.id = obr.online_product_id
    LEFT JOIN people pe ON pe.id = obr.person_id
    LEFT JOIN inventory_movements im ON im.related_posting_number = obr.order_ref
      AND im.product_id = obr.product_id
      AND im.source_type = 'order_outbound'
      AND im.status = CASE WHEN obr.status = 'deducted' THEN 'posted' ELSE obr.status END
    LEFT JOIN order_items oi ON oi.id = COALESCE(obr.order_item_id, im.related_order_item_id)
    LEFT JOIN orders o ON o.posting_number = obr.order_ref
    ORDER BY COALESCE(o.ordered_at, obr.created_at) DESC, obr.id DESC
  `);
}
export function inventory() {
  return all(`
    SELECT im.*, p.code AS product_code, p.name AS product_name, s.name AS shop_name, pe.name AS owner_name
    FROM inventory_movements im
    JOIN products p ON p.id = im.product_id
    LEFT JOIN shops s ON s.id = im.shop_id
    LEFT JOIN people pe ON pe.id = im.owner_person_id
    ORDER BY im.created_at DESC, im.id DESC
    LIMIT 300
  `);
}

export function rawOzonOrders() {
  return all(`
    SELECT r.*, s.name AS shop_name
    FROM ozon_orders_raw r
    JOIN shops s ON s.id = r.store_id
    ORDER BY r.fetched_at DESC, r.id DESC
    LIMIT 200
  `);
}

export function profitItems() {
  return all(`
    SELECT opi.*, o.posting_number, oi.ozon_sku, p.code AS product_code, p.name AS product_name, s.name AS shop_name
    FROM order_profit_items opi
    JOIN order_items oi ON oi.id = opi.order_item_id
    JOIN orders o ON o.id = oi.order_id
    JOIN shops s ON s.id = o.shop_id
    LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
    LEFT JOIN products p ON p.id = sm.product_id
    ORDER BY opi.updated_at DESC, opi.id DESC
    LIMIT 300
  `);
}

export function inventoryCurrent() {
  return all(`
    SELECT ic.*, p.code AS product_code, p.name AS product_name, p.alert_stock
    FROM inventory_current ic
    JOIN products p ON p.id = ic.real_product_id
    ORDER BY ic.available_stock ASC, p.id DESC
  `);
}

export function orderExceptions() {
  return all(`
    SELECT oe.*, s.name AS shop_name, p.code AS product_code, p.name AS product_name
    FROM order_exceptions oe
    LEFT JOIN shops s ON s.id = oe.store_id
    LEFT JOIN order_items oi ON oi.id = oe.order_item_id
    LEFT JOIN sku_mappings sm ON sm.id = oi.sku_mapping_id
    LEFT JOIN products p ON p.id = sm.product_id
    ORDER BY oe.status = 'open' DESC, oe.created_at DESC, oe.id DESC
    LIMIT 300
  `);
}

export function createProduct(body) {
  const name = body.name?.trim();
  if (!name) throw new Error("Product name is required");
  const selectionId = body.selection_id || nextCode("SEL");
  const code = body.code || nextProductCode();
  const ownerPersonId = validPersonId(body.owner_person_id) || firstActivePersonId();
  const shouldCreateProcurement = ["1", "true", "yes"].includes(String(body.create_procurement_request || "").toLowerCase());
  const purchasePlan = shouldCreateProcurement ? normalizePurchasePlan(body) : null;
  const result = db.prepare(`
    INSERT INTO products
    (selection_id, code, name, image_url, purchase_url, supplier_note, source_platform, supplier_id, shipping_method,
     recommended_shipping_method, purchase_cost, domestic_shipping, handling_fee, purchase_quantity,
     package_weight_g, length_cm, width_cm, height_cm, listing_price_rub, air_sale_price_rmb, exchange_rate,
     target_margin, desired_profit_mode, desired_profit_value, return_rate, owner_person_id, created_by_person_id, product_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    selectionId,
    code,
    name,
    body.image_url || "",
    body.purchase_url || "",
    body.supplier_note || "",
    body.source_platform || "1688",
    nullable(body.supplier_id),
    body.shipping_method || recommendShipping(body),
    recommendShipping(body),
    purchasePlan ? purchasePlan.unitPurchaseCost : Number(body.purchase_cost || 0),
    purchasePlan ? purchasePlan.unitDomesticShipping : Number(body.domestic_shipping || 0),
    Number(body.handling_fee || 0),
    Number(body.purchase_quantity || 1),
    Number(body.package_weight_g || 0),
    Number(body.length_cm || 30),
    Number(body.width_cm || 20),
    Number(body.height_cm || 10),
    Number(body.listing_price_rub || 0),
    Number(body.air_sale_price_rmb || 0),
    Number(body.exchange_rate || currentExchangeRate().rate || 11.32),
    Number(body.desired_profit_mode === "margin" ? (Number(body.desired_profit_value || 20) > 1 ? Number(body.desired_profit_value || 20) / 100 : Number(body.desired_profit_value || 20)) : 0.2),
    body.desired_profit_mode || "margin",
    Number(body.desired_profit_value || 20),
    Number(body.return_rate || 0.05),
    ownerPersonId,
    ownerPersonId,
    body.product_type || "main"
  );
  const productId = Number(result.lastInsertRowid);
  const procurement = maybeCreateProcurementForProduct(productId, body, purchasePlan || normalizePurchasePlan(body));
  return { id: productId, code, procurement_request_id: procurement?.id || null };
}

export function previewProductCsvImport(body = {}) {
  const csv = String(body.csv || "");
  const parsed = parseCsv(csv);
  const rows = parsed.rows.map((row, index) => mapCsvProductRow(parsed.headers, row, index + 2));
  return {
    total: rows.length,
    valid: rows.filter((row) => row.ok).length,
    invalid: rows.filter((row) => !row.ok).length,
    rows
  };
}

export function commitProductCsvImport(body = {}) {
  const rows = Array.isArray(body.rows)
    ? body.rows.map((data, index) => ({ ok: Boolean(data?.name), data, index: index + 1, errors: data?.name ? [] : ["商品名称为空"] }))
    : previewProductCsvImport(body).rows;
  const result = { inserted: 0, skipped: 0, errors: [] };
  for (const row of rows) {
    if (!row.ok) {
      result.skipped += 1;
      result.errors.push({ index: row.index, message: row.errors?.join("；") || "数据不完整" });
      continue;
    }
    try {
      createProduct(row.data);
      result.inserted += 1;
    } catch (error) {
      result.skipped += 1;
      result.errors.push({ index: row.index, message: error.message });
    }
  }
  return result;
}

export function updateProduct(id, body) {
  const productId = Number(id);
  const existing = get("SELECT id, updated_at FROM products WHERE id = ? AND active = 1", [productId]);
  if (!existing) throw new Error("产品不存在或已隐藏");
  if (body.updated_at && String(body.updated_at) !== String(existing.updated_at || "")) {
    throw new Error("该产品已被其他人修改，请刷新后再编辑，避免覆盖同事的内容");
  }
  db.prepare(`
    UPDATE products SET
      name = ?, image_url = ?, purchase_url = ?, supplier_note = ?, source_platform = ?, supplier_id = ?, shipping_method = ?,
      purchase_cost = ?, domestic_shipping = ?, handling_fee = ?, purchase_quantity = ?,
      package_weight_g = ?, length_cm = ?, width_cm = ?, height_cm = ?,
      listing_price_rub = ?, air_sale_price_rmb = ?, exchange_rate = ?, target_margin = ?,
      desired_profit_mode = ?, desired_profit_value = ?, return_rate = ?, owner_person_id = ?, created_by_person_id = ?,
      product_type = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE id = ?
  `).run(
    body.name,
    body.image_url || "",
    body.purchase_url || "",
    body.supplier_note || "",
    body.source_platform || "1688",
    nullable(body.supplier_id),
    body.shipping_method || recommendShipping(body),
    Number(body.purchase_cost || 0),
    Number(body.domestic_shipping || 0),
    Number(body.handling_fee || 0),
    Number(body.purchase_quantity || 1),
    Number(body.package_weight_g || 0),
    Number(body.length_cm || 30),
    Number(body.width_cm || 20),
    Number(body.height_cm || 10),
    Number(body.listing_price_rub || 0),
    Number(body.air_sale_price_rmb || 0),
    Number(body.exchange_rate || currentExchangeRate().rate || 11.32),
    Number(body.desired_profit_mode === "margin" ? (Number(body.desired_profit_value || 20) > 1 ? Number(body.desired_profit_value || 20) / 100 : Number(body.desired_profit_value || 20)) : 0.2),
    body.desired_profit_mode || "margin",
    Number(body.desired_profit_value || 20),
    Number(body.return_rate || 0.05),
    nullable(body.owner_person_id) || 1,
    nullable(body.created_by_person_id) || nullable(body.owner_person_id) || 1,
    body.product_type || "main",
    productId
  );
}

export function deleteProduct(id) {
  db.prepare("UPDATE products SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(Number(id));
}

export function createPerson(body) {
  db.prepare("INSERT INTO people (name, username, role, active, password_hash) VALUES (?, ?, ?, ?, ?)").run(
    body.name,
    body.username || null,
    body.role || "operator",
    Number(body.active ?? 1),
    hashPassword(body.password || "123456")
  );
}

export function updatePerson(id, body) {
  const personId = Number(id);
  db.prepare("UPDATE people SET name = ?, username = ?, role = ?, active = ? WHERE id = ?")
    .run(body.name, body.username || null, body.role || "operator", Number(body.active ?? 1), personId);
  if (String(body.password || "").trim()) {
    db.prepare("UPDATE people SET password_hash = ? WHERE id = ?").run(hashPassword(String(body.password)), personId);
  }
}

export function deletePerson(id) {
  db.prepare("UPDATE people SET active = 0 WHERE id = ?").run(Number(id));
}

export function hardDeletePerson(id) {
  const personId = Number(id);
  if (!personId) throw new Error("Invalid person id");
  if (!get("SELECT id FROM people WHERE id = ?", [personId])) throw new Error("Person not found");

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE products SET owner_person_id = NULL WHERE owner_person_id = ?").run(personId);
    db.prepare("UPDATE products SET created_by_person_id = NULL WHERE created_by_person_id = ?").run(personId);
    db.prepare("UPDATE sku_mappings SET person_id = NULL WHERE person_id = ?").run(personId);
    db.prepare("UPDATE procurement_requests SET person_id = NULL WHERE person_id = ?").run(personId);
    db.prepare("UPDATE inbound_records SET person_id = NULL WHERE person_id = ?").run(personId);
    db.prepare("UPDATE outbound_records SET person_id = NULL WHERE person_id = ?").run(personId);
    db.prepare("UPDATE inventory_movements SET owner_person_id = NULL WHERE owner_person_id = ?").run(personId);
    db.prepare("DELETE FROM people WHERE id = ?").run(personId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function createShop(body) {
  db.prepare(`
    INSERT INTO shops (name, legal_entity, ozon_client_id, api_key_hint, payout_rate)
    VALUES (?, ?, ?, ?, ?)
  `).run(body.name, body.legal_entity || "", body.ozon_client_id || "", body.api_key_hint || "", Number(body.payout_rate || 0.33));
}

export function updateShop(id, body) {
  const existing = get("SELECT * FROM shops WHERE id = ?", [Number(id)]);
  if (!existing) throw new Error("Shop not found");
  db.prepare(`
    UPDATE shops SET name = ?, legal_entity = ?, ozon_client_id = ?, api_key_hint = ?, status = ?, payout_rate = ?
    WHERE id = ?
  `).run(
    body.name,
    body.legal_entity || "",
    body.ozon_client_id || "",
    body.api_key_hint || existing.api_key_hint || "",
    body.status || "active",
    Number(body.payout_rate || 0.33),
    Number(id)
  );
}

export function deleteShop(id) {
  db.prepare("UPDATE shops SET status = 'deleted' WHERE id = ?").run(Number(id));
}

export function createOnlineProduct(body) {
  db.prepare(`
    INSERT OR REPLACE INTO online_products (shop_id, ozon_sku, offer_id, name, image_url, sale_price, status, product_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(body.shop_id),
    body.ozon_sku,
    body.offer_id || "",
    body.name,
    body.image_url || "",
    Number(body.sale_price || 0),
    body.status || "online",
    nullable(body.product_id)
  );
}

export function updateOnlineProduct(id, body) {
  db.prepare(`
    UPDATE online_products SET shop_id = ?, ozon_sku = ?, offer_id = ?, name = ?, image_url = ?,
      sale_price = ?, status = ?, product_id = ?
    WHERE id = ?
  `).run(
    Number(body.shop_id),
    body.ozon_sku,
    body.offer_id || "",
    body.name,
    body.image_url || "",
    Number(body.sale_price || 0),
    body.status || "online",
    nullable(body.product_id),
    Number(id)
  );
}

export async function performOnlineProductAction(body = {}, userId = null) {
  const onlineProductId = Number(body.online_product_id || body.id || 0);
  const action = String(body.action || "").trim();
  if (!onlineProductId) throw new Error("缺少在线商品 ID");
  if (!["zero_stock", "archive", "zero_and_archive"].includes(action)) throw new Error("在线商品操作类型不正确");
  const online = get("SELECT * FROM online_products WHERE id = ?", [onlineProductId]);
  if (!online) throw new Error("在线商品不存在");
  const shop = get("SELECT * FROM shops WHERE id = ?", [online.shop_id]);
  if (!shop) throw new Error("店铺不存在");
  const actionId = recordOnlineProductAction({ online, action, status: "pending", request: body, userId });
  const result = { ok: true, action, online_product_id: onlineProductId, steps: [] };
  try {
    if (action === "zero_stock" || action === "zero_and_archive") {
      const zeroPayload = [{
        offer_id: online.offer_id || "",
        product_id: Number(online.ozon_product_id || 0),
        stock: 0,
        warehouse_id: Number(body.warehouse_id || 0)
      }];
      const zeroResult = await updateOzonProductStocks(shop, zeroPayload);
      db.prepare("UPDATE online_products SET status = 'zero_stock', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(onlineProductId);
      result.steps.push({ action: "zero_stock", ok: true, result: zeroResult });
    }
    if (action === "archive" || action === "zero_and_archive") {
      const archiveResult = await archiveOzonProducts(shop, [Number(online.ozon_product_id || 0)]);
      db.prepare("UPDATE online_products SET archived = 1, status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(onlineProductId);
      result.steps.push({ action: "archive", ok: true, result: archiveResult });
    }
    finishOnlineProductAction(actionId, "success", result, "");
    return result;
  } catch (error) {
    result.ok = false;
    result.error = error.message || String(error);
    finishOnlineProductAction(actionId, "failed", result, result.error);
    throw error;
  }
}

function recordOnlineProductAction({ online, action, status, request, userId }) {
  return db.prepare(`
    INSERT INTO online_product_actions
    (online_product_id, shop_id, action_type, status, request_json, created_by_person_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(online.id, online.shop_id, action, status, JSON.stringify(request || {}), userId || null).lastInsertRowid;
}

function finishOnlineProductAction(actionId, status, response, errorMessage) {
  db.prepare(`
    UPDATE online_product_actions
    SET status = ?, response_json = ?, error_message = ?
    WHERE id = ?
  `).run(status, JSON.stringify(response || {}), errorMessage || "", Number(actionId));
}

export function bindOnlineProduct(body) {
  const online = get("SELECT * FROM online_products WHERE id = ?", [Number(body.online_product_id)]);
  if (!online) throw new Error("Online product not found");
  const productId = Number(body.product_id);
  const existingMapping = get("SELECT * FROM sku_mappings WHERE shop_id = ? AND ozon_sku = ?", [online.shop_id, online.ozon_sku]);
  db.prepare("UPDATE online_products SET product_id = ? WHERE id = ?").run(productId, online.id);

  if (existingMapping) {
    db.prepare(`
      UPDATE sku_mappings
      SET product_id = ?, person_id = ?, online_product_id = ?, offer_id = ?, display_name = ?, active = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(productId, nullable(body.person_id), online.id, online.offer_id, online.name, existingMapping.id);
  } else {
    db.prepare(`
      INSERT INTO sku_mappings
      (shop_id, product_id, person_id, online_product_id, ozon_sku, offer_id, display_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(online.shop_id, productId, nullable(body.person_id), online.id, online.ozon_sku, online.offer_id, online.name);
  }

  const mapping = get("SELECT * FROM sku_mappings WHERE shop_id = ? AND ozon_sku = ?", [online.shop_id, online.ozon_sku]);
  if (mapping) recalculateOrderItemsForMapping(mapping.id);
  syncOutboundForOpenOrders();
  return { ok: true, mapping_id: mapping?.id || null, product_id: productId };
}

export function createProductFromOnlineProduct(body) {
  const online = get("SELECT * FROM online_products WHERE id = ?", [Number(body.online_product_id)]);
  if (!online) throw new Error("Online product not found");
  const existingMapping = get(`
    SELECT sm.*, p.code, p.name
    FROM sku_mappings sm
    JOIN products p ON p.id = sm.product_id
    WHERE sm.shop_id = ? AND sm.ozon_sku = ? AND sm.active = 1
  `, [online.shop_id, online.ozon_sku]);
  if (existingMapping) {
    db.prepare("UPDATE online_products SET product_id = ? WHERE id = ?").run(existingMapping.product_id, online.id);
    recalculateOrderItemsForMapping(existingMapping.id);
    syncOutboundForOpenOrders();
    return {
      id: existingMapping.product_id,
      code: existingMapping.code,
      reused: true,
      reason: "sku_already_bound",
      procurement_request_id: null
    };
  }

  if (online.product_id) {
    const product = get("SELECT id, code FROM products WHERE id = ? AND active = 1", [online.product_id]);
    if (product) {
      bindOnlineProduct({
        online_product_id: online.id,
        product_id: product.id,
        person_id: body.person_id || body.owner_person_id || 1
      });
      return {
        id: product.id,
        code: product.code,
        reused: true,
        reason: "online_product_already_linked",
        procurement_request_id: null
      };
    }
  }

  const attrs = parseJson(online.attributes_json) || {};
  const exchangeRate = Number(body.exchange_rate || currentExchangeRate().rate || 11.32);
  const salePriceRmb = Number(body.air_sale_price_rmb || 0) ||
    (exchangeRate ? Number(online.sale_price || 0) / exchangeRate : Number(online.sale_price || 0));
  const purchasePlan = normalizePurchasePlan(body);
  const product = createProduct({
    name: body.name || online.name,
    image_url: body.image_url || online.primary_image || online.image_url || firstJsonItem(online.images_json),
    purchase_url: body.purchase_url || "",
    supplier_note: body.supplier_note || `From Ozon SKU ${online.ozon_sku}${online.offer_id ? ` / Offer ${online.offer_id}` : ""}`,
    source_platform: body.source_platform || "supplier",
    shipping_method: body.shipping_method || "air_land",
    purchase_cost: purchasePlan.unitPurchaseCost,
    domestic_shipping: purchasePlan.unitDomesticShipping,
    handling_fee: 0,
    purchase_quantity: body.purchase_quantity || 1,
    package_weight_g: body.package_weight_g || inferWeightGrams(attrs),
    length_cm: body.length_cm || attrs.length || attrs.depth || 30,
    width_cm: body.width_cm || attrs.width || 20,
    height_cm: body.height_cm || attrs.height || 10,
    air_sale_price_rmb: salePriceRmb,
    listing_price_rub: Number(body.listing_price_rub || online.sale_price || 0),
    exchange_rate: exchangeRate,
    desired_profit_mode: body.desired_profit_mode || "margin",
    desired_profit_value: body.desired_profit_value || 20,
    return_rate: body.return_rate ?? 0.05,
    owner_person_id: body.owner_person_id || body.person_id || firstActivePersonId(),
    product_type: "main"
  });
  bindOnlineProduct({
    online_product_id: online.id,
    product_id: product.id,
    person_id: body.person_id || body.owner_person_id || firstActivePersonId()
  });
  const procurement = maybeCreateProcurementForProduct(product.id, body, purchasePlan);
  return { ...product, procurement_request_id: procurement?.id || null };
}

export function createProcurementRequest(body) {
  const result = db.prepare(`
    INSERT INTO procurement_requests
    (product_id, person_id, quantity, amount, shipping_amount, purchase_url, approval_status, status, needed_by, note, urgency, source_type, supplier_id)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', 'pending', ?, ?, ?, ?, ?)
  `).run(
    Number(body.product_id),
    validPersonId(body.person_id) || firstActivePersonId(),
    Number(body.quantity || 1),
    Number(body.amount || 0),
    Number(body.shipping_amount || 0),
    body.purchase_url || "",
    body.needed_by || null,
    body.note || "",
    body.urgency || "normal",
    body.source_type || "1688",
    nullable(body.supplier_id)
  );
  return { id: Number(result.lastInsertRowid) };
}

export function updateProcurementRequest(id, body) {
  db.prepare(`
    UPDATE procurement_requests SET product_id = ?, person_id = ?, quantity = ?, amount = ?,
      shipping_amount = ?, purchase_url = ?, approval_status = ?, status = ?, needed_by = ?, note = ?, urgency = ?, source_type = ?, supplier_id = ?,
      cancelled_at = CASE WHEN ? = 'cancelled' THEN COALESCE(cancelled_at, CURRENT_TIMESTAMP) ELSE cancelled_at END
    WHERE id = ?
  `).run(
    Number(body.product_id),
    validPersonId(body.person_id) || firstActivePersonId(),
    Number(body.quantity || 1),
    Number(body.amount || 0),
    Number(body.shipping_amount || 0),
    body.purchase_url || "",
    body.approval_status || "submitted",
    body.status || "pending",
    body.needed_by || null,
    body.note || "",
    body.urgency || "normal",
    body.source_type || "1688",
    nullable(body.supplier_id),
    body.status || "pending",
    Number(id)
  );
}

export function submitProcurementRequests(body = {}) {
  const ids = [...new Set((body.request_ids || []).map(Number).filter(Boolean))];
  if (!ids.length) throw new Error("Please select procurement requests to submit");
  const placeholders = ids.map(() => "?").join(",");
  const existing = all(`SELECT id, status FROM procurement_requests WHERE id IN (${placeholders})`, ids);
  if (existing.length !== ids.length) throw new Error("Some procurement requests no longer exist. Please refresh and try again.");
  const invalid = existing.filter((row) => row.status !== "pending");
  if (invalid.length) throw new Error("Only requests waiting for confirmation can be submitted");
  db.prepare(`
    UPDATE procurement_requests
    SET status = 'submitted', approval_status = 'submitted'
    WHERE id IN (${placeholders})
  `).run(...ids);
  return { ok: true, count: ids.length };
}

export function deleteProcurementRequest(id) {
  const requestId = Number(id);
  const request = get("SELECT * FROM procurement_requests WHERE id = ?", [requestId]);
  if (!request) throw new Error("Procurement request not found");
  if (!["pending", "submitted", "cancelled"].includes(request.status)) {
    throw new Error("Only unpurchased procurement requests can be deleted");
  }
  db.prepare("DELETE FROM procurement_requests WHERE id = ?").run(requestId);
  return { ok: true };
}

export function mergeProcurementRequests(body) {
  const ids = [...new Set((body.request_ids || []).map(Number).filter(Boolean))];
  if (!ids.length) throw new Error("Please select procurement requests to merge");
  const placeholders = ids.map(() => "?").join(",");
  const requests = all(`
    SELECT * FROM procurement_requests
    WHERE id IN (${placeholders}) AND status = 'submitted'
  `, ids);
  if (requests.length !== ids.length) throw new Error("Some procurement requests were already processed. Please refresh and try again.");
  const orderNo = nextPurchaseOrderNo();
  db.exec("BEGIN");
  try {
    const grouped = new Map();
    for (const request of requests) {
      const item = grouped.get(request.product_id) || {
        product_id: request.product_id,
        requested_quantity: 0,
        amount: 0,
        shipping_amount: 0,
        purchase_url: request.purchase_url || "",
        note: ""
      };
      item.requested_quantity += Number(request.quantity || 0);
      item.amount += Number(request.amount || 0);
      item.shipping_amount += Number(request.shipping_amount || 0);
      if (!item.purchase_url && request.purchase_url) item.purchase_url = request.purchase_url;
      item.note = [item.note, request.note].filter(Boolean).join("; ");
      grouped.set(request.product_id, item);
    }
    const totalQuantity = [...grouped.values()].reduce((sum, item) => sum + item.requested_quantity, 0);
    const totalAmount = [...grouped.values()].reduce((sum, item) => sum + item.amount + item.shipping_amount, 0);
    const orderRes = db.prepare(`
      INSERT INTO purchase_orders (order_no, created_by_person_id, status, total_quantity, total_amount, note)
      VALUES (?, ?, 'pending_purchase', ?, ?, ?)
    `).run(orderNo, validPersonId(body.person_id) || firstActivePersonId(), totalQuantity, totalAmount, body.note || "");
    const orderId = Number(orderRes.lastInsertRowid);
    const insertItem = db.prepare(`
      INSERT INTO purchase_order_items
      (purchase_order_id, product_id, requested_quantity, actual_quantity, unit_cost, amount, shipping_amount, purchase_url, status, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_purchase', ?)
    `);
    for (const item of grouped.values()) {
      insertItem.run(orderId, item.product_id, item.requested_quantity, item.requested_quantity,
        item.requested_quantity ? (item.amount + item.shipping_amount) / item.requested_quantity : 0, item.amount, item.shipping_amount, item.purchase_url, item.note);
    }
    db.prepare(`
      UPDATE procurement_requests
      SET status = 'merged', approval_status = 'merged', purchase_order_id = ?, merged_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders})
    `).run(orderId, ...ids);
    db.exec("COMMIT");
    return { id: orderId, order_no: orderNo };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function confirmPurchaseOrder(id, body = {}) {
  const orderId = Number(id);
  const order = get("SELECT * FROM purchase_orders WHERE id = ?", [orderId]);
  if (!order) throw new Error("Purchase order not found");
  if (!["pending_purchase", "purchased"].includes(order.status)) throw new Error("Current purchase order status cannot be confirmed as purchased");
  const items = all("SELECT * FROM purchase_order_items WHERE purchase_order_id = ?", [orderId]);
  db.exec("BEGIN");
  try {
    const overrides = new Map((body.items || []).map((item) => [Number(item.id), item]));
    let totalQuantity = 0;
    let totalAmount = 0;
    for (const item of items) {
      const input = overrides.get(item.id) || {};
      const actualQuantity = Math.max(0, Number(input.actual_quantity ?? item.actual_quantity ?? item.requested_quantity));
      const amount = Number(input.amount ?? (input.unit_cost != null ? Number(input.unit_cost) * actualQuantity : item.amount));
      const shippingAmount = Number(input.shipping_amount ?? item.shipping_amount ?? 0);
      const unitCost = actualQuantity ? (amount + shippingAmount) / actualQuantity : 0;
      const purchaseUrl = input.purchase_url ?? item.purchase_url ?? "";
      const note = input.note ?? item.note ?? "";
      db.prepare(`
        UPDATE purchase_order_items
        SET actual_quantity = ?, unit_cost = ?, amount = ?, shipping_amount = ?, purchase_url = ?, note = ?, status = 'purchased'
        WHERE id = ?
      `).run(actualQuantity, unitCost, amount, shippingAmount, purchaseUrl, note, item.id);
      const exists = get("SELECT id FROM inbound_records WHERE purchase_order_item_id = ? AND status = 'pending_arrival'", [item.id]);
      if (!exists && actualQuantity > 0) {
        db.prepare(`
          INSERT INTO inbound_records
          (product_id, person_id, quantity, amount, unit_cost, shipping_amount, purchase_url, status, note, purchase_order_id, purchase_order_item_id, qc_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_arrival', ?, ?, ?, 'pending')
        `).run(item.product_id, validPersonId(body.person_id) || firstActivePersonId(), actualQuantity, amount, unitCost, shippingAmount, purchaseUrl, note, orderId, item.id);
      }
      totalQuantity += actualQuantity;
      totalAmount += amount + shippingAmount;
    }
    db.prepare(`
      UPDATE purchase_orders
      SET status = 'purchased', total_quantity = ?, total_amount = ?, purchased_at = CURRENT_TIMESTAMP, note = COALESCE(NULLIF(?, ''), note)
      WHERE id = ?
    `).run(totalQuantity, totalAmount, body.note || "", orderId);
    db.prepare(`
      UPDATE procurement_requests
      SET status = 'purchased', approval_status = 'purchased'
      WHERE purchase_order_id = ? AND status = 'merged'
    `).run(orderId);
    db.exec("COMMIT");
    return { ok: true };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function cancelPurchaseOrder(id) {
  const orderId = Number(id);
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE purchase_orders SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
    db.prepare("UPDATE purchase_order_items SET status = 'cancelled' WHERE purchase_order_id = ?").run(orderId);
    db.prepare("UPDATE procurement_requests SET status = 'submitted', approval_status = 'submitted', purchase_order_id = NULL, merged_at = NULL WHERE purchase_order_id = ? AND status = 'merged'").run(orderId);
    db.exec("COMMIT");
    return { ok: true };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function updatePurchaseOrder(id, body) {
  const orderId = Number(id);
  const order = get("SELECT * FROM purchase_orders WHERE id = ?", [orderId]);
  if (!order) throw new Error("Purchase order not found");
  db.exec("BEGIN");
  try {
    // 更新采购单基本信息
    db.prepare(`
      UPDATE purchase_orders SET note = COALESCE(NULLIF(?, ''), note), total_amount = ?
      WHERE id = ?
    `).run(body.note || "", Number(body.total_amount ?? order.total_amount ?? 0), orderId);

    // 更新明细项
    if (body.items && Array.isArray(body.items)) {
      for (const item of body.items) {
        const itemId = Number(item.id);
        const existingItem = get("SELECT * FROM purchase_order_items WHERE id = ? AND purchase_order_id = ?", [itemId, orderId]);
        if (!existingItem) continue;
        const actualQty = Number(item.actual_quantity ?? existingItem.actual_quantity ?? 0);
        const amount = Number(item.amount ?? existingItem.amount ?? 0);
        const shippingAmount = Number(item.shipping_amount ?? existingItem.shipping_amount ?? 0);
        const unitCost = actualQty ? (amount + shippingAmount) / actualQty : 0;
        db.prepare(`
          UPDATE purchase_order_items
          SET actual_quantity = ?, amount = ?, shipping_amount = ?, unit_cost = ?, purchase_url = ?, note = ?
          WHERE id = ?
        `).run(actualQty, amount, shippingAmount, unitCost, item.purchase_url || existingItem.purchase_url || "", item.note || existingItem.note || "", itemId);

        // 同步更新关联的入库记录
        const inbound = get("SELECT * FROM inbound_records WHERE purchase_order_item_id = ? AND status = 'pending_arrival'", [itemId]);
        if (inbound) {
          db.prepare(`
            UPDATE inbound_records
            SET quantity = ?, amount = ?, shipping_amount = ?, unit_cost = ?, purchase_url = ?, note = ?
            WHERE id = ?
          `).run(actualQty, amount, shippingAmount, unitCost, item.purchase_url || inbound.purchase_url || "", item.note || inbound.note || "", inbound.id);
        }
      }
    }
    db.exec("COMMIT");
    return { ok: true };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function deletePurchaseOrder(id) {
  const orderId = Number(id);
  const order = get("SELECT * FROM purchase_orders WHERE id = ?", [orderId]);
  if (!order) throw new Error("Purchase order not found");
  db.exec("BEGIN");
  try {
    // 如果已确认采购，需要回滚库存
    const items = all("SELECT * FROM purchase_order_items WHERE purchase_order_id = ?", [orderId]);
    for (const item of items) {
      // 删除关联的入库记录（如果未入库）
      db.prepare("DELETE FROM inbound_records WHERE purchase_order_item_id = ? AND status = 'pending_arrival'").run(item.id);
      // 如果已入库，回滚库存
      const approvedInbound = all("SELECT * FROM inbound_records WHERE purchase_order_item_id = ? AND status = 'approved'", [item.id]);
      for (const inbound of approvedInbound) {
        deleteInboundInventoryMovement(inbound.id, inbound.product_id);
      }
    }
    // 恢复采购请求到采购清单
    db.prepare("UPDATE procurement_requests SET status = 'submitted', approval_status = 'submitted', purchase_order_id = NULL, merged_at = NULL WHERE purchase_order_id = ? AND status = 'merged'").run(orderId);
    // 删除明细和主表
    db.prepare("DELETE FROM purchase_order_items WHERE purchase_order_id = ?").run(orderId);
    db.prepare("DELETE FROM purchase_orders WHERE id = ?").run(orderId);
    db.exec("COMMIT");
    return { ok: true };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function createInboundRecord(body) {
  const quantity = Number(body.quantity || 0);
  const amount = Number(body.amount || 0);
  const shippingAmount = Number(body.shipping_amount || 0);
  const unitCost = quantity ? (amount + shippingAmount) / quantity : Number(body.unit_cost || 0);
  const status = body.status || "pending_arrival";
  const result = db.prepare(`
    INSERT INTO inbound_records (product_id, person_id, quantity, amount, unit_cost, shipping_amount, purchase_url, status, note, approved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(body.product_id),
    nullable(body.person_id) || 1,
    quantity,
    amount,
    unitCost,
    shippingAmount,
    body.purchase_url || "",
    status,
    body.note || "",
    status === "approved" ? new Date().toISOString() : null
  );
  const inboundId = Number(result.lastInsertRowid);
  if (status === "approved") {
    postInventory({
      product_id: body.product_id,
      owner_person_id: body.person_id,
      source_type: "purchase_inbound",
      source_ref: `inbound_${inboundId}`,
      quantity_delta: quantity,
      unit_cost: unitCost,
      amount: amount + shippingAmount,
      note: body.note
    });
  }
  return { id: inboundId };
}

export function updateInboundRecord(id, body) {
  const inboundId = Number(id);
  const existing = get("SELECT * FROM inbound_records WHERE id = ?", [inboundId]);
  if (!existing) throw new Error("Inbound record not found");
  const quantity = Number(body.quantity ?? existing.quantity ?? 0);
  const amount = Number(body.amount ?? existing.amount ?? 0);
  const shippingAmount = Number(body.shipping_amount ?? existing.shipping_amount ?? 0);
  const unitCost = quantity ? (amount + shippingAmount) / quantity : Number(body.unit_cost ?? existing.unit_cost ?? 0);
  const status = body.status || "pending_arrival";
  db.exec("BEGIN");
  try {
    db.prepare(`
      UPDATE inbound_records SET product_id = ?, person_id = ?, quantity = ?, amount = ?, unit_cost = ?,
        shipping_amount = ?, purchase_url = ?, status = ?, note = ?, qc_status = ?,
        approved_at = CASE WHEN ? = 'approved' THEN COALESCE(approved_at, ?) ELSE approved_at END
      WHERE id = ?
    `).run(
      Number(body.product_id),
      nullable(body.person_id) || 1,
      quantity,
      amount,
      unitCost,
      shippingAmount,
      body.purchase_url || "",
      status,
      body.note || "",
      body.qc_status || existing.qc_status || "pending",
      status,
      new Date().toISOString(),
      inboundId
    );

    if (existing.status === "approved" && status === "approved") {
      upsertInboundInventoryMovement(inboundId, {
        product_id: Number(body.product_id),
        owner_person_id: body.person_id,
        quantity,
        unitCost,
        amount: amount + shippingAmount,
        note: body.note
      });
      const diff = quantity - Number(existing.quantity || 0);
      if (existing.purchase_order_item_id && diff) {
        db.prepare(`
          UPDATE purchase_order_items
          SET inbound_quantity = MAX(0, inbound_quantity + ?),
            status = CASE WHEN MAX(0, inbound_quantity + ?) >= actual_quantity THEN 'inbound_done' ELSE 'partial_inbound' END
          WHERE id = ?
        `).run(diff, diff, existing.purchase_order_item_id);
        refreshPurchaseOrderStatus(existing.purchase_order_id);
      }
    } else if (existing.status !== "approved" && status === "approved") {
      postInventory({
        product_id: body.product_id,
        owner_person_id: body.person_id,
        source_type: "purchase_inbound",
        source_ref: `inbound_${inboundId}`,
        quantity_delta: quantity,
        unit_cost: unitCost,
        amount: amount + shippingAmount,
        note: body.note
      });
      if (existing.purchase_order_item_id) {
        db.prepare(`
          UPDATE purchase_order_items
          SET inbound_quantity = inbound_quantity + ?,
            status = CASE WHEN inbound_quantity + ? >= actual_quantity THEN 'inbound_done' ELSE 'partial_inbound' END
          WHERE id = ?
        `).run(quantity, quantity, existing.purchase_order_item_id);
        refreshPurchaseOrderStatus(existing.purchase_order_id);
      }
    } else if (existing.status === "approved" && status !== "approved") {
      deleteInboundInventoryMovement(inboundId, existing.product_id);
      if (existing.purchase_order_item_id) {
        db.prepare(`
          UPDATE purchase_order_items
          SET inbound_quantity = MAX(0, inbound_quantity - ?),
            status = CASE WHEN MAX(0, inbound_quantity - ?) <= 0 THEN 'purchased' ELSE 'partial_inbound' END
          WHERE id = ?
        `).run(Number(existing.quantity || 0), Number(existing.quantity || 0), existing.purchase_order_item_id);
        refreshPurchaseOrderStatus(existing.purchase_order_id);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function deleteInboundRecord(id) {
  const inboundId = Number(id);
  const existing = get("SELECT * FROM inbound_records WHERE id = ?", [inboundId]);
  if (!existing) throw new Error("Inbound record not found");
  db.exec("BEGIN");
  try {
    if (existing.status === "approved") {
      deleteInboundInventoryMovement(inboundId, existing.product_id);
      if (existing.purchase_order_item_id) {
        db.prepare(`
          UPDATE purchase_order_items
          SET inbound_quantity = MAX(0, inbound_quantity - ?),
            status = CASE WHEN MAX(0, inbound_quantity - ?) <= 0 THEN 'purchased' ELSE 'partial_inbound' END
          WHERE id = ?
        `).run(Number(existing.quantity || 0), Number(existing.quantity || 0), existing.purchase_order_item_id);
        refreshPurchaseOrderStatus(existing.purchase_order_id);
      }
    }
    db.prepare("DELETE FROM inbound_records WHERE id = ?").run(inboundId);
    db.exec("COMMIT");
    return { ok: true };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function createInventoryMovement(body) {
  postInventory(body);
}

function postInventory(body) {
  const quantityDelta = Number(body.quantity_delta || 0);
  const movementType = body.movement_type || movementTypeFromSource(body.source_type, quantityDelta);
  const res = db.prepare(`
    INSERT INTO inventory_movements
    (product_id, shop_id, sku_mapping_id, owner_person_id, source_type, source_ref, quantity_delta, unit_cost, amount,
     status, note, movement_type, related_posting_number, related_order_item_id, operator)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(body.product_id),
    nullable(body.shop_id),
    nullable(body.sku_mapping_id),
    nullable(body.owner_person_id) || nullable(body.person_id),
    body.source_type || "manual_adjustment",
    body.source_ref || null,
    quantityDelta,
    Number(body.unit_cost || 0),
    Number(body.amount || 0),
    body.status || "posted",
    body.note || "",
    movementType,
    body.related_posting_number || body.source_ref || null,
    nullable(body.related_order_item_id),
    body.operator || null
  );
  if ((body.status || "posted") === "posted") applyInventoryCurrent(Number(body.product_id), movementType, quantityDelta);
  return Number(res.lastInsertRowid);
}

export async function syncDemoOrders(body = {}, options = {}) {
  const targetShopId = nullable(body.shop_id);
  const activeShops = shops().filter((shop) => shop.status === "active" && (!targetShopId || shop.id === targetShopId));
  const from = normalizeSyncDate(body.from || body.date_from || body.dateFrom);
  const to = normalizeSyncDate(body.to || body.date_to || body.dateTo);
  if (from && to && from > to) throw new Error("结束日期不能早于开始日期");
  throwIfAborted(options.signal);
  let inserted = 0;
  let updated = 0;
  let fetched = 0;
  let requests = 0;
  const shopResults = [];
  const errors = [];
  for (const shop of activeShops) {
    try {
      throwIfAborted(options.signal);
      const result = await fetchOzonPostings(shop, { from, to, chunkDays: 14, signal: options.signal });
      throwIfAborted(options.signal);
      const postings = Array.isArray(result) ? result : result.postings || [];
      const shopStats = {
        shop_id: shop.id,
        shop_name: shop.name,
        fetched: postings.length,
        inserted: 0,
        updated: 0,
        inserted_items: 0,
        requests: result.requests || 0,
        ranges: result.ranges || 0
      };
      fetched += postings.length;
      requests += result.requests || 0;
      for (const posting of postings) {
        throwIfAborted(options.signal);
        const stats = upsertPosting(shop, posting);
        shopStats.inserted += stats.inserted;
        shopStats.updated += stats.updated;
        shopStats.inserted_items += stats.insertedItems;
      }
      inserted += shopStats.inserted_items;
      updated += shopStats.updated;
      shopResults.push(shopStats);
    } catch (error) {
      const message = `${shop.name}: ${error.message}`;
      errors.push(message);
      shopResults.push({ shop_id: shop.id, shop_name: shop.name, fetched: 0, inserted: 0, updated: 0, inserted_items: 0, requests: 0, ranges: 0, error: error.message });
    }
  }
  const status = errors.length ? "partial_error" : "ok";
  const message = `Range ${from || "last_30_days"}~${to || "now"}; fetched ${fetched}, inserted item(s) ${inserted}, updated order(s) ${updated}, requests ${requests}${errors.length ? `; ${errors.join(" | ")}` : ""}`;
  db.prepare("INSERT INTO sync_logs (job, status, message) VALUES ('ozon_orders', ?, ?)").run(status, message);
  syncOutboundForOpenOrders();
  if (errors.length && fetched === 0) throw new Error(errors.join(" | "));
  return { inserted, updated, fetched, requests, from: from || "", to: to || "", shops: shopResults, errors };
}

export async function syncOzonIncrementalOrders(body = {}, options = {}) {
  const targetShopId = nullable(body.shop_id);
  const activeShops = shops().filter((shop) => shop.status === "active" && (!targetShopId || shop.id === targetShopId));
  const recentDays = Math.min(Math.max(Number(body.recent_days || 7), 1), 60);
  const to = todayDateKey();
  const recentFrom = dateKeyDaysAgo(recentDays);
  const aggregate = emptySyncAggregate("incremental", recentFrom, to);

  for (const shop of activeShops) {
    throwIfAborted(options.signal);
    const ranges = [{ from: recentFrom, to, reason: "recent" }];
    const seen = new Set();
    for (const range of ranges) {
      throwIfAborted(options.signal);
      const key = `${range.from}~${range.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const result = await syncDemoOrders({ shop_id: shop.id, from: range.from, to: range.to }, options);
        mergeSyncAggregate(aggregate, result, range.reason || "open");
      } catch (error) {
        aggregate.errors.push(`${shop.name} ${range.from}~${range.to}: ${error.message}`);
        aggregate.shops.push({ shop_id: shop.id, shop_name: shop.name, fetched: 0, inserted: 0, updated: 0, inserted_items: 0, requests: 0, ranges: 0, error: error.message, reason: range.reason || "open" });
      }
    }
  }

  const status = aggregate.errors.length ? "partial_error" : "ok";
  const message = `Incremental sync; fetched ${aggregate.fetched}, inserted item(s) ${aggregate.inserted}, updated order(s) ${aggregate.updated}, requests ${aggregate.requests}${aggregate.errors.length ? `; ${aggregate.errors.join(" | ")}` : ""}`;
  db.prepare("INSERT INTO sync_logs (job, status, message) VALUES ('ozon_orders_incremental', ?, ?)").run(status, message);
  if (aggregate.errors.length && aggregate.fetched === 0) throw new Error(aggregate.errors.join(" | "));
  return aggregate;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error(reason || "本次拉取已取消");
}

export async function syncOzonOnlineProducts(body = {}) {
  const targetShopId = nullable(body.shop_id);
  const selectedIds = Array.isArray(body.online_product_ids)
    ? body.online_product_ids.map(Number).filter(Boolean)
    : [];
  const selectedRows = selectedIds.length
    ? all(`SELECT id, shop_id, ozon_product_id, ozon_sku, offer_id FROM online_products WHERE id IN (${selectedIds.map(() => "?").join(",")})`, selectedIds)
    : [];
  const selectedProductIds = new Set(selectedRows.map((row) => String(row.ozon_product_id || "")).filter(Boolean));
  const selectedSkus = new Set(selectedRows.map((row) => String(row.ozon_sku || "")).filter(Boolean));
  const selectedOffers = new Set(selectedRows.map((row) => String(row.offer_id || "")).filter(Boolean));
  const selectedShopIds = new Set(selectedRows.map((row) => Number(row.shop_id)).filter(Boolean));
  const activeShops = shops().filter((shop) => shop.status === "active" && (!targetShopId || shop.id === targetShopId));
  let fetched = 0;
  let upserted = 0;
  const errors = [];

  for (const shop of activeShops) {
    if (selectedRows.length && !selectedShopIds.has(Number(shop.id))) continue;
    try {
      const items = await fetchOzonProducts(shop);
      fetched += items.length;
      for (const item of items) {
        if (selectedRows.length && !selectedProductIds.has(String(item.ozon_product_id || "")) && !selectedSkus.has(String(item.ozon_sku || "")) && !selectedOffers.has(String(item.offer_id || ""))) continue;
        upsertOnlineProduct(shop, item);
        upserted += 1;
      }
    } catch (error) {
      errors.push(`${shop.name}: ${error.message}`);
    }
  }

  const status = errors.length ? "partial_error" : "ok";
  const message = `Fetched ${fetched}, upserted ${upserted}${errors.length ? `; ${errors.join(" | ")}` : ""}`;
  db.prepare("INSERT INTO sync_logs (job, status, message) VALUES ('ozon_online_products', ?, ?)").run(status, message);
  if (errors.length && upserted === 0) throw new Error(errors.join(" | "));
  return { fetched, upserted, errors };
}

export async function syncOzonFinance(body = {}, options = {}) {
  const targetShopId = nullable(body.shop_id);
  const activeShops = shops().filter((shop) => shop.status === "active" && (!targetShopId || Number(shop.id) === targetShopId));
  const from = body.from || dateKeyDaysAgo(30);
  const to = body.to || todayDateKey();
  let fetched = 0;
  let upserted = 0;
  const errors = [];
  for (const shop of activeShops) {
    try {
      const result = await fetchOzonFinanceTransactions(shop, { from, to, signal: options.signal });
      fetched += result.fetched || 0;
      for (const operation of result.operations || []) upserted += upsertFinanceOperation(shop.id, operation);
    } catch (error) {
      errors.push(`${shop.name}: ${error.message}`);
    }
  }
  const applied = applyOzonFinanceToOrders({ from, to });
  const status = errors.length ? "partial_error" : "ok";
  const message = `Fetched ${fetched}, upserted ${upserted}, applied ${applied.items}${errors.length ? `; ${errors.join(" | ")}` : ""}`;
  db.prepare("INSERT INTO sync_logs (job, status, message) VALUES ('ozon_finance', ?, ?)").run(status, message);
  if (errors.length && upserted === 0) throw new Error(errors.join(" | "));
  return { fetched, upserted, applied, errors };
}

export function ozonFinanceSummary() {
  const summary = get(`
    SELECT COUNT(DISTINCT operation_id) AS operations,
      COUNT(*) AS rows,
      COUNT(DISTINCT posting_number) AS postings,
      COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS fees,
      MAX(synced_at) AS last_synced_at
    FROM ozon_finance_items
  `);
  const recent = all(`
    SELECT ofi.posting_number, s.name AS shop_name,
      COUNT(*) AS rows,
      COALESCE(SUM(ofi.amount), 0) AS amount,
      COALESCE(SUM(CASE WHEN ofi.amount < 0 THEN -ofi.amount ELSE 0 END), 0) AS fee_amount,
      MAX(ofi.operation_date) AS operation_date
    FROM ozon_finance_items ofi
    JOIN shops s ON s.id = ofi.shop_id
    GROUP BY ofi.shop_id, ofi.posting_number
    ORDER BY operation_date DESC
    LIMIT 12
  `);
  return { summary, recent };
}

function upsertFinanceOperation(shopId, operation) {
  const rows = financeRowsForOperation(operation);
  let count = 0;
  for (const row of rows) {
    db.prepare(`
      INSERT INTO ozon_finance_items
      (shop_id, operation_id, posting_number, order_number, operation_type, operation_type_name, operation_date,
       service_type, service_name, amount, accruals_for_sale, sale_commission, delivery_charge, return_delivery_charge,
       currency_code, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(shop_id, operation_id, service_type) DO UPDATE SET
        posting_number = excluded.posting_number,
        order_number = excluded.order_number,
        operation_type = excluded.operation_type,
        operation_type_name = excluded.operation_type_name,
        operation_date = excluded.operation_date,
        service_name = excluded.service_name,
        amount = excluded.amount,
        accruals_for_sale = excluded.accruals_for_sale,
        sale_commission = excluded.sale_commission,
        delivery_charge = excluded.delivery_charge,
        return_delivery_charge = excluded.return_delivery_charge,
        currency_code = excluded.currency_code,
        raw_json = excluded.raw_json,
        synced_at = CURRENT_TIMESTAMP
    `).run(
      shopId,
      operation.operation_id || `${operation.posting_number}-${operation.operation_date}`,
      operation.posting_number || "",
      operation.order_number || "",
      operation.operation_type || "",
      operation.operation_type_name || "",
      operation.operation_date || "",
      row.service_type,
      row.service_name,
      row.amount,
      operation.accruals_for_sale || 0,
      operation.sale_commission || 0,
      operation.delivery_charge || 0,
      operation.return_delivery_charge || 0,
      operation.currency_code || "",
      operation.raw_json || ""
    );
    count += 1;
  }
  return count;
}

function financeRowsForOperation(operation) {
  const rows = [];
  if (Number(operation.sale_commission || 0)) rows.push({ service_type: "sale_commission", service_name: "Ozon 销售佣金", amount: Number(operation.sale_commission || 0) });
  if (Number(operation.delivery_charge || 0)) rows.push({ service_type: "delivery_charge", service_name: "Ozon 配送费用", amount: Number(operation.delivery_charge || 0) });
  if (Number(operation.return_delivery_charge || 0)) rows.push({ service_type: "return_delivery_charge", service_name: "退货配送费用", amount: Number(operation.return_delivery_charge || 0) });
  for (const [index, service] of (operation.services || []).entries()) {
    rows.push({ service_type: `service_${index}_${String(service.name || "").slice(0, 48)}`, service_name: service.name || "Ozon 服务费", amount: Number(service.price || 0) });
  }
  if (!rows.length) rows.push({ service_type: "operation_total", service_name: operation.operation_type_name || operation.operation_type || "Ozon 财务交易", amount: Number(operation.amount || 0) });
  return rows;
}

function applyOzonFinanceToOrders({ from = "", to = "" } = {}) {
  const rows = all(`
    SELECT o.id AS order_id,
      COALESCE(SUM(CASE WHEN ofi.amount < 0 THEN -ofi.amount ELSE 0 END), 0) AS fee_amount,
      COALESCE(SUM(CASE WHEN ofi.service_type = 'sale_commission' THEN ABS(ofi.amount) ELSE 0 END), 0) AS commission_fee,
      COALESCE(SUM(CASE WHEN ofi.service_type != 'sale_commission' AND ofi.amount < 0 THEN -ofi.amount ELSE 0 END), 0) AS service_fee
    FROM orders o
    JOIN ozon_finance_items ofi ON ofi.shop_id = o.shop_id AND ofi.posting_number = o.posting_number
    WHERE (? = '' OR substr(ofi.operation_date, 1, 10) >= ?)
      AND (? = '' OR substr(ofi.operation_date, 1, 10) <= ?)
    GROUP BY o.id
  `, [from, from, to, to]);
  let updated = 0;
  for (const row of rows) {
    const items = all("SELECT * FROM order_items WHERE order_id = ?", [row.order_id]);
    const totalSale = items.reduce((sum, item) => sum + Number(item.sale_price || 0) * Number(item.quantity || 1), 0);
    for (const item of items) {
      const itemSale = Number(item.sale_price || 0) * Number(item.quantity || 1);
      const share = totalSale > 0 ? itemSale / totalSale : (items.length ? 1 / items.length : 0);
      const platformFee = Number(row.fee_amount || 0) * share;
      const cost = (Number(item.frozen_purchase_cost || 0) + Number(item.frozen_domestic_shipping || 0) + Number(item.frozen_international_shipping || 0) + Number(item.frozen_handling_fee || 0)) * Number(item.quantity || 1);
      const actualProfit = itemSale - cost - platformFee - Number(item.aftersale_loss || 0);
      db.prepare("UPDATE order_items SET platform_fee_actual = ?, actual_profit = ?, settlement_state = 'accrued' WHERE id = ?").run(platformFee, actualProfit, item.id);
      db.prepare(`
        UPDATE order_profit_items
        SET commission_fee_cny = ?, ozon_service_fee_cny = ?, net_profit_cny = ?, profit_status = 'accrued', updated_at = CURRENT_TIMESTAMP
        WHERE order_item_id = ?
      `).run(Number(row.commission_fee || 0) * share, Number(row.service_fee || 0) * share, actualProfit, item.id);
      updated += 1;
    }
  }
  return { orders: rows.length, items: updated };
}

function upsertOnlineProduct(shop, item) {
  db.prepare(`
    INSERT INTO online_products
    (shop_id, ozon_sku, offer_id, ozon_product_id, name, image_url, primary_image, sale_price,
     currency_code, marketing_price, old_price, status, visibility, archived, is_discounted,
     images_json, barcodes_json, stocks_json, commissions_json, attributes_json, raw_json, ozon_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, ozon_sku) DO UPDATE SET
      offer_id = excluded.offer_id,
      ozon_product_id = excluded.ozon_product_id,
      name = excluded.name,
      image_url = excluded.image_url,
      primary_image = excluded.primary_image,
      sale_price = excluded.sale_price,
      currency_code = excluded.currency_code,
      marketing_price = excluded.marketing_price,
      old_price = excluded.old_price,
      status = excluded.status,
      visibility = excluded.visibility,
      archived = excluded.archived,
      is_discounted = excluded.is_discounted,
      images_json = excluded.images_json,
      barcodes_json = excluded.barcodes_json,
      stocks_json = excluded.stocks_json,
      commissions_json = excluded.commissions_json,
      attributes_json = excluded.attributes_json,
      raw_json = excluded.raw_json,
      ozon_updated_at = excluded.ozon_updated_at,
      synced_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    shop.id,
    item.ozon_sku,
    item.offer_id || "",
    item.ozon_product_id || "",
    item.name,
    item.image_url || "",
    item.primary_image || item.image_url || "",
    Number(item.sale_price || 0),
    item.currency_code || "RUB",
    Number(item.marketing_price || 0),
    Number(item.old_price || 0),
    item.status || "online",
    item.visibility || "",
    Number(item.archived || 0),
    Number(item.is_discounted || 0),
    item.images_json || "",
    item.barcodes_json || "",
    item.stocks_json || "",
    item.commissions_json || "",
    item.attributes_json || "",
    item.raw_json || "",
    item.ozon_updated_at || ""
  );
}

function upsertOnlineProductFromOrderItem(shop, item) {
  if (!item?.ozon_sku) return null;
  const existing = get("SELECT * FROM online_products WHERE shop_id = ? AND ozon_sku = ?", [shop.id, item.ozon_sku]);
  if (existing) {
    db.prepare(`
      UPDATE online_products
      SET offer_id = COALESCE(NULLIF(?, ''), offer_id),
        name = CASE WHEN name = '' OR name LIKE 'Ozon product %' THEN COALESCE(NULLIF(?, ''), name) ELSE name END,
        image_url = COALESCE(NULLIF(?, ''), image_url),
        primary_image = COALESCE(NULLIF(?, ''), primary_image),
        sale_price = CASE WHEN sale_price = 0 THEN ? ELSE sale_price END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(item.offer_id || "", item.name || "", item.image_url || "", item.image_url || "", Number(item.sale_price || 0), existing.id);
    return existing;
  }
  const result = db.prepare(`
    INSERT INTO online_products
    (shop_id, ozon_sku, offer_id, name, image_url, primary_image, sale_price, currency_code, status, visibility, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'RUB', 'historical', 'order_snapshot', ?)
  `).run(
    shop.id,
    item.ozon_sku,
    item.offer_id || "",
    item.name || `Ozon SKU ${item.ozon_sku}`,
    item.image_url || "",
    item.image_url || "",
    Number(item.sale_price || 0),
    JSON.stringify(item)
  );
  return { id: Number(result.lastInsertRowid), shop_id: shop.id, ozon_sku: item.ozon_sku };
}

function upsertPosting(shop, posting) {
  saveRawPosting(shop, posting);
  const exists = get("SELECT * FROM orders WHERE shop_id = ? AND posting_number = ?", [shop.id, posting.posting_number])
    || get("SELECT * FROM orders WHERE posting_number = ?", [posting.posting_number]);
  let orderId = exists?.id;
  const lifecycle = orderLifecycle(posting);
  const cancelLossApplies = orderCancelLossApplies(posting);
  let inserted = 0;
  let updated = 0;
  if (!orderId) {
    const res = db.prepare(`
      INSERT INTO orders
      (shop_id, posting_number, order_number, status, logistics_status, tracking_stage, ordered_at, delivered_at, accrued_at,
       buyer_region, tracking_number, external_tracking_url, cancel_reason_id, cancel_reason, cancel_initiator, cancel_type,
       cancelled_after_ship, cancel_loss_applies, sync_state, finalized_at, last_synced_at, last_status_changed_at, sync_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
    `).run(
      shop.id,
      posting.posting_number,
      posting.order_number,
      posting.status,
      posting.logistics_status,
      posting.tracking_stage || posting.status,
      posting.ordered_at,
      posting.delivered_at,
      posting.status === "delivered" ? posting.delivered_at : null,
      posting.buyer_region,
      posting.tracking_number,
      posting.external_tracking_url || null,
      posting.cancel_reason_id || null,
      posting.cancel_reason || "",
      posting.cancel_initiator || "",
      posting.cancel_type || "",
      Number(posting.cancelled_after_ship || 0),
      cancelLossApplies ? 1 : 0,
      lifecycle.syncState,
      lifecycle.finalizedAt,
      lifecycle.note
    );
    orderId = Number(res.lastInsertRowid);
    inserted = 1;
  } else {
    const statusChanged = String(exists.status || "") !== String(posting.status || "") || String(exists.tracking_stage || "") !== String(posting.tracking_stage || posting.status || "");
    db.prepare(`
      UPDATE orders SET
        shop_id = ?, order_number = ?, status = ?, logistics_status = ?, tracking_stage = ?,
        delivered_at = COALESCE(?, delivered_at), buyer_region = ?, tracking_number = ?,
        external_tracking_url = ?, cancel_reason_id = ?, cancel_reason = ?, cancel_initiator = ?, cancel_type = ?,
        cancelled_after_ship = ?, cancel_loss_applies = ?, sync_state = ?, finalized_at = COALESCE(finalized_at, ?),
        last_synced_at = CURRENT_TIMESTAMP,
        last_status_changed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_status_changed_at END,
        sync_note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      shop.id,
      posting.order_number,
      posting.status,
      posting.logistics_status,
      posting.tracking_stage || posting.status,
      posting.delivered_at,
      posting.buyer_region,
      posting.tracking_number,
      posting.external_tracking_url || null,
      posting.cancel_reason_id || null,
      posting.cancel_reason || "",
      posting.cancel_initiator || "",
      posting.cancel_type || "",
      Number(posting.cancelled_after_ship || 0),
      cancelLossApplies ? 1 : 0,
      lifecycle.syncState,
      lifecycle.finalizedAt,
      statusChanged ? 1 : 0,
      lifecycle.note,
      orderId
    );
    updated = 1;
  }

  let insertedItems = 0;
  for (const item of posting.items) {
    upsertOnlineProductFromOrderItem(shop, item);
    const existingItem = get("SELECT id FROM order_items WHERE order_id = ? AND ozon_sku = ?", [orderId, item.ozon_sku]);
    if (existingItem) {
      db.prepare(`
        UPDATE order_items
        SET ozon_name = COALESCE(NULLIF(?, ''), ozon_name),
          ozon_image_url = COALESCE(NULLIF(?, ''), ozon_image_url)
        WHERE id = ?
      `).run(item.name || "", item.image_url || "", existingItem.id);
      continue;
    }
    const mapping = get(`
      SELECT sm.*, op.commissions_json AS commissions_json
      FROM sku_mappings sm
      LEFT JOIN online_products op ON op.id = sm.online_product_id
      WHERE sm.shop_id = ? AND sm.ozon_sku = ? AND sm.active = 1
    `, [shop.id, item.ozon_sku]);
    const product = mapping ? get("SELECT * FROM products WHERE id = ?", [mapping.product_id]) : null;
    const estimated = product && mapping ? estimateItemProfit({ salePrice: item.sale_price, quantity: item.quantity, product, mapping }) : { commission: 0, profit: 0 };
    const settlement = posting.status === "delivered" ? "accrued" : "pending";

    const insertedItem = db.prepare(`
      INSERT INTO order_items
      (order_id, sku_mapping_id, ozon_sku, ozon_name, ozon_image_url, quantity, sale_price, frozen_purchase_cost, frozen_domestic_shipping,
       frozen_international_shipping, frozen_handling_fee, estimated_commission, platform_fee_actual, aftersale_loss,
       estimated_profit, actual_profit, settlement_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      mapping?.id || null,
      item.ozon_sku,
      item.name || "",
      item.image_url || "",
      item.quantity,
      item.sale_price,
      product?.purchase_cost || 0,
      product?.domestic_shipping || 0,
      estimated.freight || product?.international_shipping || 0,
      product?.handling_fee || 0,
      estimated.commission,
      settlement === "accrued" ? estimated.commission + (estimated.paymentFee || 0) + (estimated.withdrawalFee || 0) + (estimated.expectedReturnLoss || 0) : 0,
      0,
      estimated.profit,
      settlement === "accrued" ? estimated.profit : 0,
      settlement
    );
    const orderItemId = Number(insertedItem.lastInsertRowid);

    if (!mapping) {
      recordOrderException({
        store_id: shop.id,
        order_item_id: orderItemId,
        posting_number: posting.posting_number,
        ozon_sku: item.ozon_sku,
        exception_type: "UNMAPPED_SKU",
        message: `Ozon SKU ${item.ozon_sku} is not bound to a real product`
      });
    }

    if (product && mapping) {
      saveProfitItem({
        orderItemId,
        product,
        estimated,
        quantity: item.quantity,
        salePrice: item.sale_price,
        settlement
      });
    }

    if (product && mapping) {
      const qty = -Number(item.quantity);
      postInventory({
        product_id: product.id,
        shop_id: shop.id,
        sku_mapping_id: mapping.id,
        owner_person_id: mapping.person_id,
        source_type: "order_outbound",
        source_ref: posting.posting_number,
        quantity_delta: qty,
        unit_cost: product.purchase_cost,
        amount: Math.abs(qty) * product.purchase_cost,
        related_posting_number: posting.posting_number,
        related_order_item_id: orderItemId,
        note: "Ozon order outbound"
      });
      db.prepare(`
        INSERT INTO outbound_records (product_id, shop_id, online_product_id, order_ref, order_item_id, ozon_sku, person_id, quantity, reason, status, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'order', 'deducted', ?)
      `).run(product.id, shop.id, mapping.online_product_id, posting.posting_number, orderItemId, item.ozon_sku, mapping.person_id, item.quantity, "Created by Ozon sync");
    }
    insertedItems += 1;
  }
  accrueDeliveredItems(orderId);
  return { inserted, updated, insertedItems };
}

function orderLifecycle(posting) {
  const statusText = `${posting.status || ""} ${posting.substatus || ""} ${posting.tracking_stage || ""}`.toLowerCase();
  const orderedAt = parseDate(posting.ordered_at) || new Date();
  const ageDays = Math.floor((Date.now() - orderedAt.getTime()) / (24 * 60 * 60 * 1000));
  const isCancelled = statusText.includes("cancel");
  const isDelivered = statusText.includes("delivered") || statusText.includes("签收");
  if (isCancelled) {
    return { syncState: "final", finalizedAt: new Date().toISOString(), note: "cancelled order archived" };
  }
  if (isDelivered && ageDays >= 45) {
    return { syncState: "final", finalizedAt: new Date().toISOString(), note: "delivered order older than 45 days archived" };
  }
  if (!isDelivered && ageDays >= 60) {
    return { syncState: "exception", finalizedAt: null, note: "open logistics order older than 60 days" };
  }
  return { syncState: "open", finalizedAt: null, note: "" };
}

function orderCancelLossApplies(posting) {
  const statusText = `${posting.status || ""} ${posting.substatus || ""} ${posting.tracking_stage || ""}`.toLowerCase();
  const reasonText = `${posting.cancel_reason || ""} ${posting.cancel_reason_id || ""} ${posting.cancel_initiator || ""} ${posting.cancel_type || ""}`.toLowerCase();
  if (!statusText.includes("cancel") && !statusText.includes("return") && !statusText.includes("not_accepted")) return false;
  if (isQualityPosting(posting)) return false;
  if (reasonText.includes("质检") || reasonText.includes("quality inspection") || reasonText.includes("inspection") || reasonText.includes("проверка товара") || reasonText.includes("соответствие описанию")) return false;
  if (reasonText.includes("срок доставки")) return false;
  if ((reasonText.includes("平台") || reasonText.includes("platform") || reasonText.includes("system") || reasonText.includes("ozon")) && !statusText.includes("return") && !statusText.includes("delivered")) return false;
  if (Number(posting.cancelled_after_ship || 0) > 0) return true;
  return [
    "delivering",
    "transferring",
    "carriage",
    "pickup",
    "sorting",
    "customs",
    "shipped",
    "sent",
    "on_way",
    "posting_in_carriage",
    "posting_transferring",
    "delivered",
    "return"
  ].some((keyword) => statusText.includes(keyword));
}

function isQualityPosting(posting) {
  const postingNumber = String(posting.posting_number || posting.order_number || "").trim();
  if (!postingNumber) return false;
  return orderQualityPrefixes().some((prefix) => postingNumber.startsWith(prefix));
}

function emptySyncAggregate(mode, from, to) {
  return { mode, inserted: 0, updated: 0, fetched: 0, requests: 0, from, to, shops: [], errors: [] };
}

function mergeSyncAggregate(target, result, reason) {
  target.inserted += Number(result.inserted || 0);
  target.updated += Number(result.updated || 0);
  target.fetched += Number(result.fetched || 0);
  target.requests += Number(result.requests || 0);
  target.errors.push(...(result.errors || []));
  for (const shop of result.shops || []) target.shops.push({ ...shop, reason });
}

function openOrderSyncRanges(shopId, recentFrom, lookbackDays) {
  const rows = all(`
    SELECT DISTINCT substr(ordered_at, 1, 10) AS date_key
    FROM orders
    WHERE shop_id = ?
      AND COALESCE(sync_state, 'open') != 'final'
      AND substr(ordered_at, 1, 10) < ?
      AND substr(ordered_at, 1, 10) >= ?
    ORDER BY date_key
  `, [Number(shopId), recentFrom, dateKeyDaysAgo(lookbackDays)]);
  const dates = rows.map((row) => row.date_key).filter(Boolean);
  if (!dates.length) return [];
  const ranges = [];
  let start = dates[0];
  let previous = dates[0];
  for (const current of dates.slice(1)) {
    if (current === nextDateKey(previous)) {
      previous = current;
      continue;
    }
    ranges.push({ from: start, to: previous, reason: "open" });
    start = current;
    previous = current;
  }
  ranges.push({ from: start, to: previous, reason: "open" });
  return ranges;
}

export function recalculateOrderItemsForMapping(mappingId) {
  const mapping = get(`
    SELECT sm.*, op.commissions_json AS commissions_json
    FROM sku_mappings sm
    LEFT JOIN online_products op ON op.id = sm.online_product_id
    WHERE sm.id = ? AND sm.active = 1
  `, [Number(mappingId)]);
  if (!mapping) return { updated: 0 };
  const product = get("SELECT * FROM products WHERE id = ?", [mapping.product_id]);
  if (!product) return { updated: 0 };
  const rows = all(`
    SELECT oi.*, o.shop_id, o.status AS order_status
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.shop_id = ? AND oi.ozon_sku = ?
  `, [mapping.shop_id, mapping.ozon_sku]);
  let updated = 0;
  for (const item of rows) {
    const estimated = estimateItemProfit({ salePrice: item.sale_price, quantity: item.quantity, product, mapping });
    const settlement = item.order_status === "delivered" ? "accrued" : "pending";
    db.prepare(`
      UPDATE order_items SET
        sku_mapping_id = ?,
        frozen_purchase_cost = ?,
        frozen_domestic_shipping = ?,
        frozen_international_shipping = ?,
        frozen_handling_fee = ?,
        estimated_commission = ?,
        platform_fee_actual = CASE WHEN ? = 'accrued' THEN ? ELSE platform_fee_actual END,
        estimated_profit = ?,
        actual_profit = CASE WHEN ? = 'accrued' THEN ? ELSE actual_profit END,
        settlement_state = ?
      WHERE id = ?
    `).run(
      mapping.id,
      product.purchase_cost || 0,
      product.domestic_shipping || 0,
      estimated.freight || product.international_shipping || 0,
      product.handling_fee || 0,
      estimated.commission || 0,
      settlement,
      (estimated.commission || 0) + (estimated.paymentFee || 0) + (estimated.withdrawalFee || 0) + (estimated.expectedReturnLoss || 0),
      estimated.profit || 0,
      settlement,
      estimated.profit || 0,
      settlement,
      item.id
    );
    saveProfitItem({
      orderItemId: item.id,
      product,
      estimated,
      quantity: item.quantity,
      salePrice: item.sale_price,
      settlement
    });
    updated += 1;
  }
  return { updated };
}

export function recalculateOrderProfit(orderId) {
  const order = get("SELECT * FROM orders WHERE id = ?", [Number(orderId)]);
  if (!order) throw new Error("订单不存在");
  const rows = all(`
    SELECT oi.*, o.shop_id, o.status AS order_status
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.order_id = ?
  `, [Number(orderId)]);
  let updated = 0;
  let unbound = 0;
  for (const item of rows) {
    const mapping = get(`
      SELECT sm.*, op.commissions_json AS commissions_json
      FROM sku_mappings sm
      LEFT JOIN online_products op ON op.id = sm.online_product_id
      WHERE sm.active = 1
        AND sm.shop_id = ?
        AND sm.ozon_sku = ?
      ORDER BY CASE WHEN sm.id = ? THEN 0 ELSE 1 END, sm.id DESC
      LIMIT 1
    `, [order.shop_id, item.ozon_sku, Number(item.sku_mapping_id || 0)]);
    if (!mapping) {
      unbound += 1;
      continue;
    }
    const product = get("SELECT * FROM products WHERE id = ? AND active = 1", [mapping.product_id]);
    if (!product) {
      unbound += 1;
      continue;
    }
    const estimated = estimateItemProfit({ salePrice: item.sale_price, quantity: item.quantity, product, mapping });
    const settlement = item.order_status === "delivered" ? "accrued" : "pending";
    db.prepare(`
      UPDATE order_items SET
        sku_mapping_id = ?,
        frozen_purchase_cost = ?,
        frozen_domestic_shipping = ?,
        frozen_international_shipping = ?,
        frozen_handling_fee = ?,
        estimated_commission = ?,
        platform_fee_actual = CASE WHEN ? = 'accrued' THEN ? ELSE platform_fee_actual END,
        estimated_profit = ?,
        actual_profit = CASE WHEN ? = 'accrued' THEN ? ELSE actual_profit END,
        settlement_state = ?
      WHERE id = ?
    `).run(
      mapping.id,
      product.purchase_cost || 0,
      product.domestic_shipping || 0,
      estimated.freight || product.international_shipping || 0,
      product.handling_fee || 0,
      estimated.commission || 0,
      settlement,
      (estimated.commission || 0) + (estimated.paymentFee || 0) + (estimated.withdrawalFee || 0) + (estimated.expectedReturnLoss || 0),
      estimated.profit || 0,
      settlement,
      estimated.profit || 0,
      settlement,
      item.id
    );
    saveProfitItem({
      orderItemId: item.id,
      product,
      estimated,
      quantity: item.quantity,
      salePrice: item.sale_price,
      settlement
    });
    updated += 1;
  }
  syncOutboundForOpenOrders();
  return { ok: true, updated, unbound };
}

export function recalculateAllMappedOrderProfits() {
  const mappings = all("SELECT id FROM sku_mappings WHERE active = 1");
  let updated = 0;
  for (const mapping of mappings) {
    updated += recalculateOrderItemsForMapping(mapping.id).updated;
  }
  return { updated, mappings: mappings.length };
}

export function recalculateOrderProfitsForProduct(productId) {
  const product = get("SELECT id FROM products WHERE id = ? AND active = 1", [Number(productId)]);
  if (!product) throw new Error("库存产品不存在或已隐藏");
  const mappings = all("SELECT id FROM sku_mappings WHERE product_id = ? AND active = 1", [Number(productId)]);
  let updated = 0;
  for (const mapping of mappings) {
    updated += recalculateOrderItemsForMapping(mapping.id).updated;
  }
  syncOutboundForOpenOrders();
  return { ok: true, product_id: Number(productId), updated, mappings: mappings.length };
}

function accrueDeliveredItems(orderId) {
  const order = get("SELECT * FROM orders WHERE id = ?", [orderId]);
  if (!order || order.status !== "delivered") return;
  const items = all("SELECT * FROM order_items WHERE order_id = ?", [orderId]);
  for (const item of items) {
    const actualProfit = actualItemProfit(item);
    db.prepare("UPDATE order_items SET actual_profit = ?, settlement_state = 'accrued' WHERE id = ?").run(actualProfit, item.id);
    db.prepare(`
      UPDATE order_profit_items
      SET net_profit_cny = ?, profit_status = 'accrued', updated_at = CURRENT_TIMESTAMP
      WHERE order_item_id = ?
    `).run(actualProfit, item.id);
  }
}

function syncOutboundForOpenOrders() {
  const cancelledRows = all(`
    SELECT oi.id AS order_item_id, o.posting_number, sm.product_id
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN sku_mappings sm ON (
      (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
      AND sm.active = 1
    )
    WHERE LOWER(o.status) LIKE '%cancel%'
       OR LOWER(COALESCE(o.tracking_stage, '')) LIKE '%cancel%'
  `);
  for (const row of cancelledRows) {
    db.prepare(`
      UPDATE outbound_records
      SET status = 'cancelled', reason = 'cancelled_order', note = 'Order cancelled, outbound no longer active'
      WHERE order_ref = ? AND (? IS NULL OR product_id = ?)
    `).run(row.posting_number, row.product_id || null, row.product_id || null);
    db.prepare(`
      UPDATE inventory_movements
      SET status = 'cancelled', note = 'Cancelled order outbound'
      WHERE related_order_item_id = ? AND source_type = 'order_outbound'
    `).run(row.order_item_id);
    rebuildInventoryCurrentForProduct(row.product_id);
  }

  const rows = all(`
    SELECT oi.*, o.shop_id, o.posting_number, o.status AS order_status, o.tracking_stage,
      sm.id AS mapping_id, sm.product_id, sm.person_id, sm.online_product_id,
      p.purchase_cost
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN sku_mappings sm ON (
      (sm.id = oi.sku_mapping_id OR (sm.shop_id = o.shop_id AND sm.ozon_sku = oi.ozon_sku))
      AND sm.active = 1
    )
    LEFT JOIN products p ON p.id = sm.product_id
    WHERE LOWER(o.status) NOT LIKE '%cancel%'
      AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%'
  `);
  let deducted = 0;
  let pending = 0;
  for (const row of rows) {
    if (!row.mapping_id || !row.product_id) {
      recordOrderException({
        store_id: row.shop_id,
        order_item_id: row.id,
        posting_number: row.posting_number,
        ozon_sku: row.ozon_sku,
        exception_type: "OUTBOUND_UNBOUND_SKU",
        message: `Order is waiting for outbound, but Ozon SKU ${row.ozon_sku} is not bound to an inventory product`
      });
      pending += 1;
      continue;
    }
    if (Number(row.sku_mapping_id || 0) !== Number(row.mapping_id)) {
      db.prepare("UPDATE order_items SET sku_mapping_id = ? WHERE id = ?").run(row.mapping_id, row.id);
    }
    const existed = get(`
      SELECT id, status, product_id FROM inventory_movements
      WHERE related_order_item_id = ? AND source_type = 'order_outbound'
      LIMIT 1
    `, [row.id]);
    if (existed) {
      if (existed.status !== "posted" || Number(existed.product_id) !== Number(row.product_id)) {
        db.prepare(`
          UPDATE inventory_movements
          SET product_id = ?, shop_id = ?, sku_mapping_id = ?, owner_person_id = ?,
            quantity_delta = ?, unit_cost = ?, amount = ?, status = 'posted', note = 'Restored by outbound sync'
          WHERE id = ?
        `).run(
          row.product_id,
          row.shop_id,
          row.mapping_id,
          row.person_id,
          -Math.abs(Number(row.quantity || 1)),
          row.purchase_cost || row.frozen_purchase_cost || 0,
          Math.abs(Number(row.quantity || 1)) * Number(row.purchase_cost || row.frozen_purchase_cost || 0),
          existed.id
        );
        rebuildInventoryCurrentForProduct(existed.product_id);
        rebuildInventoryCurrentForProduct(row.product_id);
      }
      continue;
    }
    const qty = -Math.abs(Number(row.quantity || 1));
    postInventory({
      product_id: row.product_id,
      shop_id: row.shop_id,
      sku_mapping_id: row.mapping_id,
      owner_person_id: row.person_id,
      source_type: "order_outbound",
      source_ref: row.posting_number,
      quantity_delta: qty,
      unit_cost: row.purchase_cost || row.frozen_purchase_cost || 0,
      amount: Math.abs(qty) * Number(row.purchase_cost || row.frozen_purchase_cost || 0),
      related_posting_number: row.posting_number,
      related_order_item_id: row.id,
      note: "Created by outbound sync"
    });
    const outboundExists = get(`
      SELECT id FROM outbound_records
      WHERE (order_item_id = ? OR (order_item_id IS NULL AND order_ref = ? AND product_id = ? AND (COALESCE(ozon_sku, '') = '' OR ozon_sku = ?)))
        AND status != 'cancelled'
      LIMIT 1
    `, [row.id, row.posting_number, row.product_id, row.ozon_sku || ""]);
    if (outboundExists) {
      db.prepare(`
        UPDATE outbound_records
        SET shop_id = ?, online_product_id = ?, order_item_id = ?, ozon_sku = ?, person_id = ?, quantity = ?, reason = 'order', status = 'deducted', note = 'Updated by outbound sync'
        WHERE id = ?
      `).run(row.shop_id, row.online_product_id, row.id, row.ozon_sku, row.person_id, Math.abs(Number(row.quantity || 1)), outboundExists.id);
    } else {
      db.prepare(`
        INSERT INTO outbound_records (product_id, shop_id, online_product_id, order_ref, order_item_id, ozon_sku, person_id, quantity, reason, status, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'order', 'deducted', ?)
      `).run(row.product_id, row.shop_id, row.online_product_id, row.posting_number, row.id, row.ozon_sku, row.person_id, Math.abs(Number(row.quantity || 1)), "Created by outbound sync");
    }
    db.prepare(`
      UPDATE order_exceptions SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP
      WHERE store_id = ? AND posting_number = ? AND ozon_sku = ? AND exception_type IN ('UNMAPPED_SKU', 'OUTBOUND_UNBOUND_SKU')
    `).run(row.shop_id, row.posting_number, row.ozon_sku);
    deducted += 1;
  }
  return { deducted, pending };
}

function saveRawPosting(shop, posting) {
  db.prepare(`
    INSERT INTO ozon_orders_raw (store_id, posting_number, order_id, status, substatus, raw_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(store_id, posting_number) DO UPDATE SET
      order_id = excluded.order_id,
      status = excluded.status,
      substatus = excluded.substatus,
      raw_json = excluded.raw_json,
      fetched_at = CURRENT_TIMESTAMP
  `).run(
    shop.id,
    posting.posting_number,
    posting.order_id || posting.order_number || "",
    posting.status || "",
    posting.substatus || posting.logistics_status || "",
    JSON.stringify(posting)
  );
}

function saveProfitItem({ orderItemId, product, estimated, quantity, salePrice, settlement }) {
  const qty = Number(quantity || 1);
  const saleAmount = Number(salePrice || 0) * qty;
  const purchaseCost = Number(product.purchase_cost || 0) * qty;
  const domesticShipping = Number(product.domestic_shipping || 0) * qty;
  const internationalShipping = Number(estimated.freight ?? product.international_shipping ?? 0) * qty;
  const packagingCost = Number(product.handling_fee || 0) * qty;
  const commission = Number(estimated.commission || 0);
  const ozonServiceFee = Number(estimated.paymentFee || 0) + Number(estimated.withdrawalFee || 0);
  const returnLoss = Number(estimated.expectedReturnLoss || 0);
  const advertisingCost = Number(estimated.advertisingCost || 0);
  const grossProfit = saleAmount - purchaseCost - domesticShipping - internationalShipping - packagingCost - commission;
  const netProfit = Number(estimated.profit || 0);
  const commissionRate = saleAmount ? commission / saleAmount : 0;

  db.prepare(`
    INSERT INTO order_profit_items
    (order_item_id, sale_amount_cny, purchase_cost_cny, domestic_shipping_cny, international_shipping_cny,
     packaging_cost_cny, commission_rate, commission_fee_cny, ozon_service_fee_cny, return_loss_cny,
     advertising_cost_cny, other_fee_cny, gross_profit_cny, net_profit_cny, profit_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(order_item_id) DO UPDATE SET
      sale_amount_cny = excluded.sale_amount_cny,
      purchase_cost_cny = excluded.purchase_cost_cny,
      domestic_shipping_cny = excluded.domestic_shipping_cny,
      international_shipping_cny = excluded.international_shipping_cny,
      packaging_cost_cny = excluded.packaging_cost_cny,
      commission_rate = excluded.commission_rate,
      commission_fee_cny = excluded.commission_fee_cny,
      ozon_service_fee_cny = excluded.ozon_service_fee_cny,
      return_loss_cny = excluded.return_loss_cny,
      advertising_cost_cny = excluded.advertising_cost_cny,
      gross_profit_cny = excluded.gross_profit_cny,
      net_profit_cny = excluded.net_profit_cny,
      profit_status = excluded.profit_status,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    orderItemId,
    saleAmount,
    purchaseCost,
    domesticShipping,
    internationalShipping,
    packagingCost,
    commissionRate,
    commission,
    ozonServiceFee,
    returnLoss,
    advertisingCost,
    grossProfit,
    netProfit,
    settlement === "accrued" ? "accrued" : "estimated"
  );
}

function recordOrderException(body) {
  db.prepare(`
    INSERT INTO order_exceptions (store_id, order_item_id, posting_number, ozon_sku, exception_type, message)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(store_id, posting_number, ozon_sku, exception_type) DO UPDATE SET
      order_item_id = excluded.order_item_id,
      message = excluded.message,
      status = 'open'
  `).run(
    nullable(body.store_id),
    nullable(body.order_item_id),
    body.posting_number || "",
    body.ozon_sku || "",
    body.exception_type,
    body.message
  );
}

function applyInventoryCurrent(productId, movementType, quantityDelta) {
  db.prepare(`
    INSERT INTO inventory_current (real_product_id, available_stock, reserved_stock, damaged_stock, in_transit_stock)
    VALUES (?, 0, 0, 0, 0)
    ON CONFLICT(real_product_id) DO NOTHING
  `).run(productId);

  const deltas = inventoryDeltas(movementType, quantityDelta);
  db.prepare(`
    UPDATE inventory_current SET
      available_stock = available_stock + ?,
      reserved_stock = reserved_stock + ?,
      damaged_stock = damaged_stock + ?,
      in_transit_stock = in_transit_stock + ?,
      last_updated_at = CURRENT_TIMESTAMP
    WHERE real_product_id = ?
  `).run(deltas.available, deltas.reserved, deltas.damaged, deltas.inTransit, productId);
}

function inventoryDeltas(movementType, quantityDelta) {
  const qty = Number(quantityDelta || 0);
  switch (movementType) {
    case "ORDER_RESERVED":
      return { available: 0, reserved: Math.abs(qty), damaged: 0, inTransit: 0 };
    case "ORDER_SHIPPED":
      return { available: qty < 0 ? qty : -Math.abs(qty), reserved: 0, damaged: 0, inTransit: 0 };
    case "CANCEL_RESTORE":
      return { available: 0, reserved: -Math.abs(qty), damaged: 0, inTransit: 0 };
    case "RETURN_LOSS":
      return { available: 0, reserved: 0, damaged: Math.abs(qty), inTransit: 0 };
    case "RETURN_IN":
      return { available: Math.abs(qty), reserved: 0, damaged: 0, inTransit: 0 };
    case "PURCHASE_IN":
    case "MANUAL_ADJUST":
    default:
      return { available: qty, reserved: 0, damaged: 0, inTransit: 0 };
  }
}

function movementTypeFromSource(sourceType, quantityDelta) {
  if (sourceType === "purchase_inbound") return "PURCHASE_IN";
  if (sourceType === "order_outbound") return "ORDER_SHIPPED";
  if (sourceType === "return_loss") return "RETURN_LOSS";
  if (sourceType === "return_in") return "RETURN_IN";
  return quantityDelta >= 0 ? "MANUAL_ADJUST" : "ORDER_SHIPPED";
}

function parseCsv(csv) {
  const text = String(csv || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => String(value).trim() !== "")) rows.push(row);
  const headers = (rows.shift() || []).map(normalizeHeader);
  return { headers, rows: rows.filter((item) => item.some((value) => String(value).trim() !== "")) };
}

function mapCsvProductRow(headers, row, index) {
  const value = (name) => row[headers.indexOf(normalizeHeader(name))] ?? "";
  const warnings = [];
  const errors = [];
  const name = cleanCell(value("商品名称"));
  if (!name) errors.push("商品名称为空");
  const exchangeRate = numberCell(value("汇率"), currentExchangeRate().rate || 11.32);
  const saleRmb = numberCell(value("售价")) || numberCell(value("上架价格"));
  const listingRmb = numberCell(value("上架价格")) || saleRmb;
  const imageUrl = cleanCell(value("商品图片"));
  if (imageUrl && !/^https?:\/\//i.test(imageUrl) && !imageUrl.startsWith("data:image/")) warnings.push("商品图片不是可访问链接，可能无法显示缩略图");
  const personName = cleanCell(value("人员"));
  const ownerPersonId = personName ? personIdByName(personName) : firstActivePersonId();
  if (personName && !ownerPersonId) warnings.push(`未找到人员：${personName}，已使用默认负责人`);
  const productNote = cleanCell(value("商品备注"));
  const accessories = cleanCell(value("配件"));
  const supplierNote = [productNote, accessories ? `配件：${accessories}` : ""].filter(Boolean).join("；");
  const data = {
    name,
    image_url: imageUrl,
    purchase_url: cleanCell(value("货源")),
    supplier_note: supplierNote,
    source_platform: normalizeSourcePlatform(value("货源平台")),
    shipping_method: normalizeShippingMethod(value("配送方式")),
    purchase_cost: numberCell(value("采购单价")),
    domestic_shipping: numberCell(value("国内运费")),
    purchase_quantity: Math.max(1, Math.round(numberCell(value("采购数"), 1))),
    package_weight_g: numberCell(value("包装克重")),
    length_cm: numberCell(value("长"), 30),
    width_cm: numberCell(value("宽"), 20),
    height_cm: numberCell(value("高"), 10),
    air_sale_price_rmb: saleRmb,
    listing_price_rub: listingRmb && exchangeRate ? listingRmb * exchangeRate : 0,
    exchange_rate: exchangeRate,
    return_rate: rateCell(value("退货率"), 0.05),
    owner_person_id: ownerPersonId || firstActivePersonId(),
    desired_profit_mode: "margin",
    desired_profit_value: 20,
    product_type: "main"
  };
  return { index, ok: errors.length === 0, errors, warnings, data, raw: Object.fromEntries(headers.map((header, i) => [header, row[i] ?? ""])) };
}

function normalizeHeader(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim().replace(/\s+/g, "");
}

function cleanCell(value) {
  return String(value ?? "").trim();
}

function numberCell(value, fallback = 0) {
  const text = cleanCell(value).replace(/[￥¥,\s]/g, "");
  if (!text) return fallback;
  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

function rateCell(value, fallback = 0) {
  const text = cleanCell(value);
  if (!text) return fallback;
  const number = numberCell(text.replace("%", ""), fallback);
  return text.includes("%") || number > 1 ? number / 100 : number;
}

function personIdByName(name) {
  const text = cleanCell(name);
  if (!text) return null;
  return get("SELECT id FROM people WHERE name = ? OR username = ? ORDER BY active DESC, id LIMIT 1", [text, text])?.id || null;
}

function normalizeSourcePlatform(value) {
  const text = cleanCell(value).toLowerCase();
  if (text.includes("1688")) return "1688";
  if (text.includes("pdd") || text.includes("拼多多")) return "pdd";
  return text || "supplier";
}

function normalizeShippingMethod(value) {
  const text = cleanCell(value);
  if (text.includes("陆空")) return "air_land";
  if (text.includes("陆运")) return "land";
  if (text.includes("空运")) return "air";
  return text || "manual_review";
}

function recommendShipping(body) {
  const weight = Number(body.package_weight_g || 0);
  const l = Number(body.length_cm || 30);
  const w = Number(body.width_cm || 20);
  const h = Number(body.height_cm || 10);
  const longest = Math.max(l, w, h);
  const sum = l + w + h;
  if (weight <= 500 && longest <= 60 && sum <= 90) return "air_land";
  if (weight <= 30000 && longest <= 150 && sum <= 310) return "land";
  return "manual_review";
}

function nextCode(prefix) {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const row = get("SELECT COUNT(*) AS count FROM products WHERE selection_id LIKE ?", [`${prefix}-${date}-%`]);
  return `${prefix}-${date}-${String(Number(row?.count || 0) + 1).padStart(3, "0")}`;
}

function nextProductCode() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const row = get("SELECT COUNT(*) AS count FROM products WHERE code LIKE ?", [`P-${stamp}-%`]);
  return `P-${stamp}-${String(Number(row?.count || 0) + 1).padStart(3, "0")}`;
}

function nextPurchaseOrderNo() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const row = get("SELECT COUNT(*) AS count FROM purchase_orders WHERE order_no LIKE ?", [`PO-${date}-%`]);
  return `PO-${date}-${String(Number(row?.count || 0) + 1).padStart(3, "0")}`;
}

function refreshPurchaseOrderStatus(orderId) {
  if (!orderId) return;
  const summary = get(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN inbound_quantity >= actual_quantity AND actual_quantity > 0 THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN inbound_quantity > 0 AND inbound_quantity < actual_quantity THEN 1 ELSE 0 END) AS partial
    FROM purchase_order_items
    WHERE purchase_order_id = ?
  `, [Number(orderId)]);
  if (!summary?.total) return;
  const status = Number(summary.done || 0) === Number(summary.total)
    ? "inbound_done"
    : Number(summary.partial || 0) > 0 || Number(summary.done || 0) > 0
      ? "partial_inbound"
      : "purchased";
  db.prepare("UPDATE purchase_orders SET status = ? WHERE id = ? AND status != 'cancelled'").run(status, Number(orderId));
}

function upsertInboundInventoryMovement(inboundId, body) {
  const sourceRef = `inbound_${inboundId}`;
  const existingMovement = get(`
    SELECT id, product_id FROM inventory_movements
    WHERE source_type = 'purchase_inbound' AND source_ref = ?
    LIMIT 1
  `, [sourceRef]);
  if (existingMovement) {
    db.prepare(`
      UPDATE inventory_movements
      SET product_id = ?, owner_person_id = ?, quantity_delta = ?, unit_cost = ?, amount = ?, note = ?, status = 'posted'
      WHERE id = ?
    `).run(
      Number(body.product_id),
      nullable(body.owner_person_id) || null,
      Number(body.quantity || 0),
      Number(body.unitCost || 0),
      Number(body.amount || 0),
      body.note || "",
      existingMovement.id
    );
    rebuildInventoryCurrentForProduct(existingMovement.product_id);
    rebuildInventoryCurrentForProduct(body.product_id);
    return existingMovement.id;
  }
  const movementId = postInventory({
    product_id: body.product_id,
    owner_person_id: body.owner_person_id,
    source_type: "purchase_inbound",
    source_ref: sourceRef,
    quantity_delta: body.quantity,
    unit_cost: body.unitCost,
    amount: body.amount,
    note: body.note
  });
  rebuildInventoryCurrentForProduct(body.product_id);
  return movementId;
}

function deleteInboundInventoryMovement(inboundId, productId) {
  db.prepare(`
    DELETE FROM inventory_movements
    WHERE source_type = 'purchase_inbound' AND source_ref = ?
  `).run(`inbound_${inboundId}`);
  rebuildInventoryCurrentForProduct(productId);
}

function rebuildInventoryCurrentForProduct(productId) {
  if (!productId) return;
  const row = get(`
    SELECT COALESCE(SUM(quantity_delta), 0) AS available_stock
    FROM inventory_movements
    WHERE product_id = ? AND status = 'posted'
  `, [Number(productId)]);
  db.prepare(`
    INSERT INTO inventory_current (real_product_id, available_stock, last_updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(real_product_id) DO UPDATE SET
      available_stock = excluded.available_stock,
      last_updated_at = CURRENT_TIMESTAMP
  `).run(Number(productId), Number(row?.available_stock || 0));
}

function validPersonId(value) {
  const id = nullable(value);
  if (!id) return null;
  return get("SELECT id FROM people WHERE id = ?", [id]) ? id : null;
}

function firstActivePersonId() {
  return get("SELECT id FROM people WHERE active = 1 ORDER BY id LIMIT 1")?.id || null;
}

function normalizePurchasePlan(body) {
  const quantity = Math.max(1, Number(body.purchase_quantity || 1));
  const purchaseTotal = Number(body.purchase_total_amount ?? body.purchase_cost ?? 0);
  const domesticTotal = Number(body.domestic_shipping_total ?? body.domestic_shipping ?? 0);
  return {
    quantity,
    purchaseTotal,
    domesticTotal,
    amount: purchaseTotal,
    shippingAmount: domesticTotal,
    unitPurchaseCost: purchaseTotal / quantity,
    unitDomesticShipping: domesticTotal / quantity
  };
}

function maybeCreateProcurementForProduct(productId, body, plan = normalizePurchasePlan(body)) {
  if (!["1", "true", "yes"].includes(String(body.create_procurement_request || "").toLowerCase())) return null;
  const result = db.prepare(`
    INSERT INTO procurement_requests
    (product_id, person_id, quantity, amount, shipping_amount, purchase_url, approval_status, status, needed_by, note, urgency, source_type, supplier_id)
    VALUES (?, ?, ?, ?, ?, ?, 'submitted', 'pending', ?, ?, 'normal', ?, ?)
  `).run(
    Number(productId),
    validPersonId(body.person_id) || validPersonId(body.owner_person_id) || firstActivePersonId(),
    plan.quantity,
    plan.amount,
    plan.shippingAmount,
    body.purchase_url || "",
    body.needed_by || null,
    body.note || body.supplier_note || "Created from order stock creation",
    body.source_type || body.source_platform || "1688",
    nullable(body.supplier_id)
  );
  return { id: Number(result.lastInsertRowid), ...plan };
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stockSyncFilters(shopId, productId) {
  if (!productId) return {};
  const rows = all(`
    SELECT DISTINCT op.ozon_product_id, sm.offer_id
    FROM sku_mappings sm
    LEFT JOIN online_products op ON op.id = sm.online_product_id OR (op.shop_id = sm.shop_id AND op.ozon_sku = sm.ozon_sku)
    WHERE sm.active = 1 AND sm.shop_id = ? AND sm.product_id = ?
  `, [Number(shopId), Number(productId)]);
  return {
    productIds: rows.map((row) => Number(row.ozon_product_id || 0)).filter(Boolean),
    offerIds: rows.map((row) => row.offer_id).filter(Boolean)
  };
}

function fallbackStockRowsFromOnlineProducts(shopId, productId = null) {
  const params = [Number(shopId)];
  const productWhere = productId ? "AND sm.product_id = ?" : "";
  if (productId) params.push(Number(productId));
  const rows = all(`
    SELECT op.*, sm.product_id
    FROM online_products op
    LEFT JOIN sku_mappings sm ON sm.shop_id = op.shop_id AND sm.ozon_sku = op.ozon_sku AND sm.active = 1
    WHERE op.shop_id = ? ${productWhere}
  `, params);
  const result = [];
  for (const row of rows) {
    const stocks = parseJson(row.stocks_json) || [];
    const list = Array.isArray(stocks) ? stocks : [stocks];
    if (!list.length) continue;
    list.forEach((stock, index) => {
      const warehouseName = String(stock?.warehouse_name || stock?.name || stock?.source || stock?.delivery_schema || stock?.type || "Ozon");
      result.push({
        ozon_product_id: row.ozon_product_id || "",
        offer_id: row.offer_id || "",
        ozon_sku: row.ozon_sku,
        warehouse_id: String(stock?.warehouse_id || stock?.source_id || stock?.id || stock?.type || index),
        warehouse_name: warehouseName,
        stock_type: classifyStockSnapshot(stock, warehouseName),
        present: snapshotStockNumber(stock?.present ?? stock?.stock ?? stock?.quantity ?? stock?.available_stock ?? stock?.available),
        reserved: snapshotStockNumber(stock?.reserved ?? stock?.reserved_stock),
        available: snapshotStockNumber(stock?.available ?? stock?.free_to_sell_amount ?? stock?.present ?? stock?.stock ?? stock?.quantity),
        raw_json: JSON.stringify(stock || {})
      });
    });
  }
  return result;
}

function upsertStockSnapshot(shopId, row) {
  const online = get(`
    SELECT op.id AS online_product_id, sm.product_id
    FROM online_products op
    LEFT JOIN sku_mappings sm ON sm.shop_id = op.shop_id AND sm.ozon_sku = op.ozon_sku AND sm.active = 1
    WHERE op.shop_id = ? AND (op.ozon_sku = ? OR op.offer_id = ? OR op.ozon_product_id = ?)
    ORDER BY CASE WHEN op.ozon_sku = ? THEN 0 ELSE 1 END, op.id DESC
    LIMIT 1
  `, [
    Number(shopId),
    String(row.ozon_sku || ""),
    String(row.offer_id || ""),
    String(row.ozon_product_id || ""),
    String(row.ozon_sku || "")
  ]) || {};
  const stockType = resolveStockType(row);
  const normalizedSku = String(row.ozon_sku || row.offer_id || row.ozon_product_id || "");
  const warehouseId = String(row.warehouse_id || row.warehouse_name || "default");
  db.prepare(`
    DELETE FROM ozon_stock_snapshots
    WHERE shop_id = ? AND ozon_sku = ? AND warehouse_id = ? AND stock_type != ?
  `).run(Number(shopId), normalizedSku, warehouseId, stockType);
  db.prepare(`
    INSERT INTO ozon_stock_snapshots
    (shop_id, online_product_id, product_id, ozon_product_id, ozon_sku, offer_id, warehouse_id, warehouse_name, stock_type, present, reserved, available, raw_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(shop_id, ozon_sku, warehouse_id, stock_type) DO UPDATE SET
      online_product_id = excluded.online_product_id,
      product_id = excluded.product_id,
      ozon_product_id = excluded.ozon_product_id,
      offer_id = excluded.offer_id,
      warehouse_name = excluded.warehouse_name,
      present = excluded.present,
      reserved = excluded.reserved,
      available = excluded.available,
      raw_json = excluded.raw_json,
      synced_at = CURRENT_TIMESTAMP
  `).run(
    Number(shopId),
    online.online_product_id || null,
    online.product_id || null,
    String(row.ozon_product_id || ""),
    normalizedSku,
    String(row.offer_id || ""),
    warehouseId,
    String(row.warehouse_name || "Ozon"),
    stockType,
    snapshotStockNumber(row.present),
    snapshotStockNumber(row.reserved),
    snapshotStockNumber(row.available ?? row.present),
    row.raw_json || JSON.stringify(row)
  );
}

function classifyStockSnapshot(stock = {}, warehouseName = "") {
  const text = `${stock.stock_type || ""} ${stock.type || ""} ${stock.delivery_schema || ""} ${stock.source || ""} ${stock.warehouse_name || ""} ${stock.name || ""} ${warehouseName || ""}`.toLowerCase();
  if (text.includes("fbo") || text.includes("fbp") || text.includes("cel") || text.includes("cl ") || text.includes("hunchun") || text.includes("хуньчун") || text.includes("混春") || text.includes("混川") || text.includes("陆空") || text.includes("陆-空")) return "fbp_real";
  if (text.includes("fbs") || text.includes("rfbs") || text.includes("seller") || text.includes("virtual") || text.includes("自发")) return "fbs_virtual";
  return "unknown";
}

function resolveStockType(row = {}) {
  const text = `${row.stock_type || ""} ${row.type || ""} ${row.delivery_schema || ""} ${row.source || ""} ${row.warehouse_name || ""} ${row.name || ""} ${row.raw_json || ""}`.toLowerCase();
  const rules = stockWarehouseRules().filter((rule) => Number(rule.enabled) !== 0);
  for (const rule of rules) {
    const pattern = String(rule.pattern || "").trim().toLowerCase();
    if (pattern && text.includes(pattern)) return normalizeStockType(rule.stock_type);
  }
  return classifyStockSnapshot(row, row.warehouse_name);
}

function normalizeStockType(value) {
  const text = String(value || "").trim();
  if (["fbs_virtual", "fbp_real", "unknown"].includes(text)) return text;
  if (text.toLowerCase().includes("fbs")) return "fbs_virtual";
  if (text.toLowerCase().includes("fbp") || text.toLowerCase().includes("fbo")) return "fbp_real";
  return "unknown";
}

function reclassifyStockSnapshots() {
  const rows = all("SELECT id, stock_type, warehouse_name, raw_json FROM ozon_stock_snapshots");
  const stmt = db.prepare("UPDATE ozon_stock_snapshots SET stock_type = ? WHERE id = ?");
  for (const row of rows) {
    const raw = parseJson(row.raw_json) || {};
    const nextType = resolveStockType({ ...raw, warehouse_name: row.warehouse_name, stock_type: "" });
    if (nextType !== row.stock_type) stmt.run(nextType, row.id);
  }
}

function snapshotStockNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? Math.max(0, Math.round(num)) : 0;
}

function parseWarehouseBreakdown(value) {
  if (!value) return [];
  return String(value).split("||").filter(Boolean).map((part) => {
    const [name = "", present = "0", stockType = "unknown"] = part.split(":");
    const [presentQty = "0", availableQty = presentQty] = present.split("/");
    return {
      name,
      present: snapshotStockNumber(presentQty),
      available: snapshotStockNumber(availableQty),
      stock_type: stockType
    };
  });
}

function withStockAlertStatus(product) {
  const warnings = [];
  if (product.all_time_qty > 0 && product.local_stock <= product.alert_stock) warnings.push({ type: "local", level: "danger", text: "本地库存不足" });
  if (product.fbp_sku_count > 0 && product.fbp_zero_sku_count > 0) warnings.push({ type: "fbp", level: "danger", text: `${product.fbp_zero_sku_count} 个 FBP SKU 库存为空` });
  if (product.fbs_low_sku_count > 0) warnings.push({ type: "fbs", level: "warning", text: `${product.fbs_low_sku_count} 个 FBS 虚拟库存小于 ${FBS_VIRTUAL_STOCK_WARNING_THRESHOLD}` });
  if (!product.skus.length) warnings.push({ type: "mapping", level: "warning", text: "未绑定 Ozon SKU" });
  if (product.recent_7d_qty > product.prev_7d_qty * 1.3 && product.recent_7d_qty >= 3) warnings.push({ type: "trend_up", level: "info", text: "近 7 天出货加快" });
  if (product.prev_7d_qty >= 3 && product.recent_7d_qty < product.prev_7d_qty * 0.7) warnings.push({ type: "trend_down", level: "info", text: "近 7 天出货下降" });
  const alertLevel = warnings.some((item) => item.level === "danger") ? "danger" : warnings.some((item) => item.level === "warning") ? "warning" : warnings.some((item) => item.level === "info") ? "info" : "ok";
  return {
    ...product,
    trend_delta: product.recent_7d_qty - product.prev_7d_qty,
    trend_rate: product.prev_7d_qty > 0 ? (product.recent_7d_qty - product.prev_7d_qty) / product.prev_7d_qty : (product.recent_7d_qty > 0 ? 1 : 0),
    alert_level: alertLevel,
    warnings,
    suggestion: stockSuggestion(product, warnings)
  };
}

function stockSuggestion(product, warnings) {
  if (warnings.some((item) => item.type === "mapping")) return "先绑定 SKU，才能核验 Ozon 库存。";
  if (warnings.some((item) => item.type === "local")) return "这个产品已经出过单，本地真实库存不足，优先创建采购请求。";
  if (warnings.some((item) => item.type === "fbp")) return "曾经有 FBP 库存的 SKU 现在为空，检查是否需要补 FBP 仓。";
  if (warnings.some((item) => item.type === "fbs")) return `FBS 虚拟库存小于 ${FBS_VIRTUAL_STOCK_WARNING_THRESHOLD}，检查 Ozon 后台可售库存设置，避免忘记补虚拟库存后断单。`;
  if (warnings.some((item) => item.type === "trend_up")) return "出货速度上升，可以提高本地与 FBP 备货。";
  if (warnings.some((item) => item.type === "trend_down")) return "出货下降，减少 FBP 补货降低压货风险。";
  return "库存状态正常。";
}

function maxTextDate(a, b) {
  if (!a) return b || "";
  if (!b) return a || "";
  return String(a) > String(b) ? a : b;
}

function fallbackShipDeadline(orderedAt) {
  const ordered = new Date(orderedAt);
  if (Number.isNaN(ordered.getTime())) return null;
  ordered.setDate(ordered.getDate() + 6);
  return ordered.toISOString();
}

function daysBetween(from, to) {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

function firstJsonItem(value) {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed[0] || "" : "";
}

function inferWeightGrams(attrs) {
  const weight = Number(attrs.weight || 0);
  if (weight > 0) return String(attrs.weight_unit || "").toLowerCase().includes("kg") ? weight * 1000 : weight;
  return Number(attrs.volume_weight || 0) ? Number(attrs.volume_weight || 0) * 1000 : 0;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeSyncDate(value) {
  if (!value) return "";
  const date = new Date(String(value).includes("T") ? value : `${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return "";
  return String(value).slice(0, 10);
}

function todayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function dateKeyDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function nextDateKey(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function nullable(value) {
  if (value === undefined || value === null || value === "") return null;
  return Number(value);
}

// ==================== 供应商管理 ====================

export function suppliers() {
  return all(`
    SELECT s.*,
      (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id AND p.active = 1) AS product_count
    FROM suppliers s
    WHERE s.status = 'active'
    ORDER BY s.id DESC
  `);
}

export function createSupplier(body) {
  const name = String(body.name || "").trim();
  if (!name) throw new Error("供应商名称不能为空");
  const result = db.prepare(`
    INSERT INTO suppliers (name, contact_person, contact_phone, wechat_id, business_note, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(
    name,
    body.contact_person || "",
    body.contact_phone || "",
    body.wechat_id || "",
    body.business_note || ""
  );
  return { id: Number(result.lastInsertRowid), name };
}

export function updateSupplier(id, body) {
  const supplierId = Number(id);
  const existing = get("SELECT * FROM suppliers WHERE id = ?", [supplierId]);
  if (!existing) throw new Error("供应商不存在");
  db.prepare(`
    UPDATE suppliers SET
      name = ?, contact_person = ?, contact_phone = ?,
      wechat_id = ?, business_note = ?
    WHERE id = ?
  `).run(
    body.name || existing.name,
    body.contact_person ?? existing.contact_person,
    body.contact_phone ?? existing.contact_phone,
    body.wechat_id ?? existing.wechat_id,
    body.business_note ?? existing.business_note,
    supplierId
  );
}

export function deleteSupplier(id) {
  const supplierId = Number(id);
  const linkedProducts = get("SELECT COUNT(*) AS count FROM products WHERE supplier_id = ? AND active = 1", [supplierId]);
  if (linkedProducts && linkedProducts.count > 0) {
    throw new Error(`该供应商已绑定${linkedProducts.count}个产品，无法删除。请先解除绑定。`);
  }
  db.prepare("UPDATE suppliers SET status = 'inactive' WHERE id = ?").run(supplierId);
  return { ok: true };
}

export function logisticsRules() {
  return all("SELECT * FROM logistics_fee_rules ORDER BY enabled DESC, carrier, channel, min_weight_g, id");
}

export function createLogisticsRule(body) {
  const result = db.prepare(`
    INSERT INTO logistics_fee_rules
    (name, carrier, channel, mode, min_weight_g, max_weight_g, min_price_rub, max_price_rub, base_fee_cny, per_gram_cny, per_ticket_cny, enabled, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    requiredText(body.name, "规则名称不能为空"),
    body.carrier || "CEL",
    body.channel || "standard",
    body.mode || "per_gram",
    Number(body.min_weight_g || 0),
    Number(body.max_weight_g || 999999),
    Number(body.min_price_rub || 0),
    Number(body.max_price_rub || 999999999),
    Number(body.base_fee_cny || 0),
    Number(body.per_gram_cny || 0),
    Number(body.per_ticket_cny || 0),
    Number(body.enabled ?? 1),
    body.note || ""
  );
  return { id: Number(result.lastInsertRowid) };
}

export function updateLogisticsRule(id, body) {
  const existing = get("SELECT * FROM logistics_fee_rules WHERE id = ?", [Number(id)]);
  if (!existing) throw new Error("物流规则不存在");
  db.prepare(`
    UPDATE logistics_fee_rules
    SET name = ?, carrier = ?, channel = ?, mode = ?, min_weight_g = ?, max_weight_g = ?,
      min_price_rub = ?, max_price_rub = ?, base_fee_cny = ?, per_gram_cny = ?, per_ticket_cny = ?,
      enabled = ?, note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    requiredText(body.name ?? existing.name, "规则名称不能为空"),
    body.carrier ?? existing.carrier,
    body.channel ?? existing.channel,
    body.mode ?? existing.mode,
    Number(body.min_weight_g ?? existing.min_weight_g),
    Number(body.max_weight_g ?? existing.max_weight_g),
    Number(body.min_price_rub ?? existing.min_price_rub),
    Number(body.max_price_rub ?? existing.max_price_rub),
    Number(body.base_fee_cny ?? existing.base_fee_cny),
    Number(body.per_gram_cny ?? existing.per_gram_cny),
    Number(body.per_ticket_cny ?? existing.per_ticket_cny),
    Number(body.enabled ?? existing.enabled),
    body.note ?? existing.note,
    Number(id)
  );
  return { ok: true };
}

export function deleteLogisticsRule(id) {
  db.prepare("UPDATE logistics_fee_rules SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(Number(id));
  return { ok: true };
}

function requiredText(value, message) {
  const text = String(value || "").trim();
  if (!text) throw new Error(message);
  return text;
}
