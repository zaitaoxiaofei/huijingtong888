import { db } from "../db.js";
import { fetchOzonProductStocks } from "../ozonClient.js";

const FBS_VIRTUAL_STOCK_WARNING_THRESHOLD = 10;

function allLocal(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
}

export function stockAlerts() {
  const rows = allLocal(`
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
  return allLocal(`
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
  const existing = allLocal("SELECT * FROM stock_warehouse_rules WHERE id = ?", [Number(id)])[0];
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
  const activeShops = allLocal("SELECT * FROM shops WHERE status = 'active'")
    .filter((shop) => !targetShopId || Number(shop.id) === Number(targetShopId));
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
  return { status, fetched, upserted, errors, message, alerts: stockAlerts() };
}

export {
  inventory,
  inboundRecords,
  outboundRecords,
  createInboundRecord,
  updateInboundRecord,
  deleteInboundRecord,
  createInventoryMovement
} from "../services.js";

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

function stockSyncFilters(shopId, productId) {
  if (!productId) return {};
  const rows = allLocal(`
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
  const rows = allLocal(`
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
  const online = allLocal(`
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
  ])[0] || {};
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
  const rows = allLocal("SELECT id, stock_type, warehouse_name, raw_json FROM ozon_stock_snapshots");
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
    suggestion: stockSuggestion(warnings)
  };
}

function stockSuggestion(warnings) {
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

function dateKeyDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function nullable(value) {
  if (value === undefined || value === null || value === "") return null;
  return Number(value);
}
