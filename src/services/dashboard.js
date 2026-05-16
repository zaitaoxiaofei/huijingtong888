import { db } from "../db.js";

const DASHBOARD_LOW_STOCK_THRESHOLD = 5;

function all(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
}

function get(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.get(...params) : stmt.get(params);
}

function onlineProductStatusKey(row = {}) {
  const status = String(row.status || "").toLowerCase();
  const visibility = String(row.visibility || "").toLowerCase();
  if (Number(row.archived || 0) || status.includes("archive")) return "archived";
  if (status.includes("error") || status.includes("fail") || visibility.includes("failed") || visibility.includes("banned")) return "error";
  if (status.includes("moder") || status.includes("edit") || status.includes("validation") || visibility.includes("pending")) return "moderation";
  if (status.includes("ready") || status.includes("created") || visibility.includes("ready_to_supply") || visibility.includes("empty_stock")) return "ready";
  if (visibility.includes("hidden") || visibility.includes("blocked") || visibility.includes("removed_from_sale") || status.includes("hidden") || status.includes("offline")) return "hidden";
  if (status.includes("online") || status.includes("active") || status.includes("sell") || visibility.includes("in_sale") || visibility.includes("visible") || visibility.includes("moderated")) return "selling";
  return "other";
}

export function dashboard() {
  const fbpAlerts = all(`
    SELECT
      p.id AS product_id,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS inventory_id,
      p.name AS product_name,
      p.image_url AS product_image_url,
      p.alert_stock,
      COALESCE(ic.available_stock, 0) AS local_stock,
      sm.shop_id,
      s.name AS shop_name,
      sm.ozon_sku,
      sm.offer_id,
      COALESCE(op.name, sm.display_name, p.name, sm.ozon_sku) AS online_name,
      COALESCE(op.primary_image, op.image_url, p.image_url, '') AS image_url,
      COALESCE(stock.fbp_available, 0) AS fbp_available,
      COALESCE(stock.fbp_present, 0) AS fbp_present,
      COALESCE(stock.last_synced_at, '') AS last_synced_at
    FROM products p
    LEFT JOIN inventory_current ic ON ic.real_product_id = p.id
    JOIN sku_mappings sm ON sm.product_id = p.id AND sm.active = 1
    JOIN shops s ON s.id = sm.shop_id
    LEFT JOIN online_products op ON op.id = sm.online_product_id OR (op.shop_id = sm.shop_id AND op.ozon_sku = sm.ozon_sku)
    LEFT JOIN (
      SELECT
        shop_id,
        ozon_sku,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN present ELSE 0 END) AS fbp_present,
        SUM(CASE WHEN stock_type = 'fbp_real' THEN available ELSE 0 END) AS fbp_available,
        MAX(synced_at) AS last_synced_at
      FROM ozon_stock_snapshots
      GROUP BY shop_id, ozon_sku
    ) stock ON stock.shop_id = sm.shop_id AND stock.ozon_sku = sm.ozon_sku
    WHERE p.active = 1
      AND COALESCE(stock.fbp_present, 0) > 0
      AND COALESCE(stock.fbp_available, 0) < ?
    ORDER BY COALESCE(stock.fbp_available, 0) ASC, p.updated_at DESC, p.id DESC
  `, [DASHBOARD_LOW_STOCK_THRESHOLD]).map((row) => ({
    ...row,
    warning_level: Number(row.fbp_available || 0) <= 0 ? "danger" : "warning",
    warning_text: Number(row.fbp_available || 0) <= 0 ? "FBP 库存已空" : `FBP 库存低于 ${DASHBOARD_LOW_STOCK_THRESHOLD}`,
    display_name: row.product_name || row.online_name || row.ozon_sku || row.inventory_id
  }));

  const fbsAlerts = all(`
    SELECT
      op.id AS online_product_id,
      op.shop_id,
      s.name AS shop_name,
      op.ozon_sku,
      op.offer_id,
      op.name AS online_name,
      COALESCE(op.primary_image, op.image_url, p.image_url, '') AS image_url,
      op.product_id,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS inventory_id,
      p.name AS product_name,
      op.status,
      op.visibility,
      COALESCE(stock.fbs_available, 0) AS fbs_available,
      COALESCE(stock.fbs_present, 0) AS fbs_present,
      COALESCE(stock.last_synced_at, '') AS last_synced_at
    FROM online_products op
    JOIN shops s ON s.id = op.shop_id
    LEFT JOIN products p ON p.id = op.product_id
    LEFT JOIN (
      SELECT
        shop_id,
        ozon_sku,
        SUM(CASE WHEN stock_type = 'fbs_virtual' THEN present ELSE 0 END) AS fbs_present,
        SUM(CASE WHEN stock_type = 'fbs_virtual' THEN available ELSE 0 END) AS fbs_available,
        MAX(synced_at) AS last_synced_at
      FROM ozon_stock_snapshots
      GROUP BY shop_id, ozon_sku
    ) stock ON stock.shop_id = op.shop_id AND stock.ozon_sku = op.ozon_sku
    WHERE COALESCE(stock.fbs_present, 0) > 0
       OR COALESCE(stock.fbs_available, 0) < ?
    ORDER BY COALESCE(stock.fbs_available, 0) ASC, op.updated_at DESC, op.id DESC
  `, [DASHBOARD_LOW_STOCK_THRESHOLD])
    .map((row) => {
      const statusKey = onlineProductStatusKey(row);
      const available = Number(row.fbs_available || 0);
      const shouldWarn = available < 0 || (statusKey === "selling" && available < DASHBOARD_LOW_STOCK_THRESHOLD);
      if (!shouldWarn) return null;
      return {
        ...row,
        status_key: statusKey,
        warning_level: available < 0 ? "danger" : "warning",
        warning_text: available < 0 ? "FBS 库存小于 0" : `销售中且 FBS 库存低于 ${DASHBOARD_LOW_STOCK_THRESHOLD}`,
        display_name: row.product_name || row.online_name || row.ozon_sku || row.offer_id || `在线商品 #${row.online_product_id}`
      };
    })
    .filter(Boolean);

  const procurementRows = all(`
    SELECT
      pr.id,
      pr.product_id,
      pr.quantity,
      pr.amount,
      pr.shipping_amount,
      pr.source_type,
      pr.purchase_url,
      pr.note,
      pr.created_at,
      p.name AS product_name,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS product_code,
      p.image_url AS product_image_url,
      pe.name AS requester_name,
      su.name AS supplier_name
    FROM procurement_requests pr
    JOIN products p ON p.id = pr.product_id
    LEFT JOIN people pe ON pe.id = pr.person_id
    LEFT JOIN suppliers su ON su.id = pr.supplier_id
    WHERE pr.status = 'submitted'
    ORDER BY pr.created_at ASC, pr.id ASC
  `);

  const procurementGrouped = new Map();
  for (const row of procurementRows) {
    const productId = Number(row.product_id || 0);
    if (!productId) continue;
    if (!procurementGrouped.has(productId)) {
      procurementGrouped.set(productId, {
        product_id: productId,
        product_code: row.product_code || "",
        product_name: row.product_name || "",
        image_url: row.product_image_url || "",
        total_quantity: 0,
        request_count: 0,
        total_amount: 0,
        earliest_created_at: row.created_at || "",
        requester_names: new Set(),
        supplier_names: new Set()
      });
    }
    const item = procurementGrouped.get(productId);
    item.total_quantity += Number(row.quantity || 0);
    item.request_count += 1;
    item.total_amount += Number(row.amount || 0) + Number(row.shipping_amount || 0);
    if (!item.earliest_created_at || String(row.created_at || "") < String(item.earliest_created_at || "")) {
      item.earliest_created_at = row.created_at || "";
    }
    if (row.requester_name) item.requester_names.add(row.requester_name);
    if (row.supplier_name) item.supplier_names.add(row.supplier_name);
  }

  const procurementAlerts = [...procurementGrouped.values()]
    .map((row) => ({
      ...row,
      requester_names: [...row.requester_names],
      supplier_names: [...row.supplier_names]
    }))
    .sort((left, right) => String(left.earliest_created_at || "").localeCompare(String(right.earliest_created_at || "")));

  const summary = {
    urgent_count: fbpAlerts.filter((item) => item.warning_level === "danger").length + fbsAlerts.filter((item) => item.warning_level === "danger").length,
    warning_count: fbpAlerts.length + fbsAlerts.length,
    fbp_count: fbpAlerts.length,
    fbs_count: fbsAlerts.length,
    procurement_count: procurementAlerts.length
  };

  return {
    summary,
    alerts: {
      fbp: fbpAlerts,
      fbs: fbsAlerts,
      procurement: procurementAlerts
    }
  };
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
