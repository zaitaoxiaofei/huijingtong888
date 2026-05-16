import { db } from "../db.js";
import { syncOutboundForOpenOrders } from "./profit-maintenance.js";

function all(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
}

function get(sql, params = {}) {
  const stmt = db.prepare(sql);
  return Array.isArray(params) ? stmt.get(...params) : stmt.get(params);
}

function nullable(value) {
  if (value === undefined || value === null || value === "") return null;
  return Number(value);
}

function onlineProductsRuntime() {
  const runtime = globalThis.__ozonOnlineProductsRuntime;
  if (!runtime) throw new Error("Online products runtime is not configured");
  return runtime;
}

export function configureOnlineProductsRuntime(runtime) {
  globalThis.__ozonOnlineProductsRuntime = runtime;
}

function resolveOnlineProductZeroStockTargets(online = {}, body = {}) {
  const explicitWarehouseId = String(body.warehouse_id || "").trim();
  const snapshotRows = online.shop_id && online.ozon_sku
    ? all(`
      SELECT DISTINCT warehouse_id
      FROM ozon_stock_snapshots
      WHERE shop_id = ? AND ozon_sku = ?
      ORDER BY warehouse_id ASC
    `, [Number(online.shop_id), String(online.ozon_sku || "")])
    : [];
  const warehouseIds = explicitWarehouseId
    ? [explicitWarehouseId]
    : snapshotRows.map((row) => String(row.warehouse_id || "").trim()).filter(Boolean);
  const normalized = warehouseIds.length ? warehouseIds : [""];
  return normalized.map((warehouseId) => ({
    offer_id: String(online.offer_id || ""),
    product_id: Number(online.ozon_product_id || 0),
    stock: 0,
    warehouse_id: warehouseId
  }));
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

export function onlineProducts() {
  const runtime = onlineProductsRuntime();
  return all(`
    SELECT
      op.id, op.shop_id, op.ozon_sku, op.offer_id, op.ozon_product_id, op.name, op.image_url, op.primary_image,
      op.sale_price, op.currency_code, op.marketing_price, op.old_price, op.status, op.visibility, op.archived,
      op.is_discounted, op.images_json, op.barcodes_json, op.stocks_json, op.commissions_json, op.attributes_json, op.raw_json,
      CASE WHEN op.raw_json IS NOT NULL AND op.raw_json != '' THEN 1 ELSE 0 END AS has_raw_json,
      op.ozon_updated_at, op.product_id, op.synced_at, op.updated_at,
      s.name AS shop_name,
      CASE WHEN p.code LIKE 'P-%' THEN p.code ELSE 'P-' || strftime('%Y%m%d-%H%M%S', p.created_at) || '-' || printf('%03d', p.id) END AS product_code,
      p.name AS product_name
    FROM online_products op
    JOIN shops s ON s.id = op.shop_id
    LEFT JOIN products p ON p.id = op.product_id
    ORDER BY op.synced_at DESC, op.id DESC
  `).map((row) => {
    const fallback = runtime.onlineImageFallback(row.primary_image, row.image_url, row.images_json, row.raw_json);
    return {
      ...row,
      primary_image: fallback,
      image_url: fallback
    };
  });
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
  const runtime = onlineProductsRuntime();
  const onlineProductId = Number(body.online_product_id || body.id || 0);
  const action = String(body.action || "").trim();
  if (!onlineProductId) throw new Error("缺少在线商品 ID");
  if (!["archive", "zero_stock", "zero_then_archive"].includes(action)) throw new Error("当前动作不受支持");
  const online = get("SELECT * FROM online_products WHERE id = ?", [onlineProductId]);
  if (!online) throw new Error("在线商品不存在");
  const shop = get("SELECT * FROM shops WHERE id = ?", [online.shop_id]);
  if (!shop) throw new Error("店铺不存在");
  const actionId = recordOnlineProductAction({ online, action, status: "pending", request: body, userId });
  const result = { ok: true, action, online_product_id: onlineProductId, steps: [] };
  try {
    if (action === "zero_stock" || action === "zero_then_archive") {
      const stockTargets = resolveOnlineProductZeroStockTargets(online, body);
      const stockResult = await runtime.updateOzonProductStocks(shop, stockTargets);
      result.steps.push({ action: "zero_stock", ok: true, result: stockResult, targets: stockTargets });
    }
    if (action === "archive" || action === "zero_then_archive") {
      const archiveResult = await runtime.archiveOzonProducts(shop, [Number(online.ozon_product_id || 0)]);
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

export function bindOnlineProduct(body) {
  const runtime = onlineProductsRuntime();
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
  if (mapping) runtime.recalculateOrderItemsForMapping(mapping.id);
  syncOutboundForOpenOrders(runtime.profitMaintenanceDeps());
  runtime.refreshProfitAnalyticsSnapshots({});
  runtime.invalidateExceptionWorkbenchCache();
  return { ok: true, mapping_id: mapping?.id || null, product_id: productId };
}

export function createProductFromOnlineProduct(body) {
  const runtime = onlineProductsRuntime();
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
    runtime.recalculateOrderItemsForMapping(existingMapping.id);
    syncOutboundForOpenOrders(runtime.profitMaintenanceDeps());
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

  const spec = runtime.onlineProductSpec(online);
  const exchangeRate = Number(body.exchange_rate || runtime.currentExchangeRate().rate || 11.32);
  const salePriceRmb = Number(body.air_sale_price_rmb || 0) ||
    (exchangeRate ? Number(online.sale_price || 0) / exchangeRate : Number(online.sale_price || 0));
  const purchasePlan = runtime.normalizePurchasePlan(body);
  const product = runtime.createProduct({
    name: body.name || online.name,
    image_url: body.image_url || online.primary_image || online.image_url || runtime.firstJsonItem(online.images_json),
    purchase_url: body.purchase_url || "",
    supplier_note: body.supplier_note || `From Ozon SKU ${online.ozon_sku}${online.offer_id ? ` / Offer ${online.offer_id}` : ""}`,
    source_platform: body.source_platform || "supplier",
    shipping_method: body.shipping_method || "air_land",
    purchase_cost: purchasePlan.unitPurchaseCost,
    domestic_shipping: purchasePlan.unitDomesticShipping,
    handling_fee: 0,
    purchase_quantity: body.purchase_quantity || 1,
    package_weight_g: body.package_weight_g || spec.weight_g,
    length_cm: body.length_cm || spec.length_cm || 30,
    width_cm: body.width_cm || spec.width_cm || 20,
    height_cm: body.height_cm || spec.height_cm || 10,
    air_sale_price_rmb: salePriceRmb,
    listing_price_rub: Number(body.listing_price_rub || online.sale_price || 0),
    exchange_rate: exchangeRate,
    desired_profit_mode: body.desired_profit_mode || "margin",
    desired_profit_value: body.desired_profit_value || 20,
    return_rate: body.return_rate ?? 0.05,
    owner_person_id: body.owner_person_id || body.person_id || runtime.firstActivePersonId(),
    product_type: "main"
  });
  bindOnlineProduct({
    online_product_id: online.id,
    product_id: product.id,
    person_id: body.person_id || body.owner_person_id || runtime.firstActivePersonId()
  });
  const procurement = runtime.maybeCreateProcurementForProduct(product.id, body, purchasePlan);
  return { ...product, procurement_request_id: procurement?.id || null };
}

export async function syncOzonOnlineProducts(body = {}) {
  const runtime = onlineProductsRuntime();
  const targetShopId = runtime.nullable(body.shop_id);
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
  const activeShops = runtime.shops().filter((shop) => shop.status === "active" && (!targetShopId || shop.id === targetShopId));
  let fetched = 0;
  let upserted = 0;
  const errors = [];

  for (const shop of activeShops) {
    if (selectedRows.length && !selectedShopIds.has(Number(shop.id))) continue;
    try {
      const items = await runtime.fetchOzonProducts(shop);
      fetched += items.length;
      for (const item of items) {
        if (selectedRows.length && !selectedProductIds.has(String(item.ozon_product_id || "")) && !selectedSkus.has(String(item.ozon_sku || "")) && !selectedOffers.has(String(item.offer_id || ""))) continue;
        runtime.upsertOnlineProduct(shop, item);
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

export async function refreshOnlineProductImages(body = {}) {
  const runtime = onlineProductsRuntime();
  const selectedIds = Array.isArray(body.online_product_ids) ? body.online_product_ids.map(Number).filter(Boolean) : [];
  if (!selectedIds.length) return { fetched: 0, upserted: 0, errors: [] };

  const rows = all(`
    SELECT id, shop_id, ozon_product_id
    FROM online_products
    WHERE id IN (${selectedIds.map(() => "?").join(",")})
  `, selectedIds);
  const grouped = new Map();
  for (const row of rows) {
    const shopId = Number(row.shop_id || 0);
    const productId = Number(row.ozon_product_id || 0);
    if (!shopId || !productId) continue;
    const list = grouped.get(shopId) || [];
    list.push(productId);
    grouped.set(shopId, list);
  }

  let fetched = 0;
  let upserted = 0;
  const errors = [];
  for (const [shopId, productIds] of grouped.entries()) {
    const shop = get("SELECT * FROM shops WHERE id = ? AND status = 'active'", [shopId]);
    if (!shop) continue;
    try {
      const items = await runtime.fetchOzonProductsByIds(shop, productIds);
      fetched += items.length;
      for (const item of items) {
        runtime.upsertOnlineProduct(shop, item);
        upserted += 1;
      }
    } catch (error) {
      errors.push(`${shop.name}: ${error.message}`);
    }
  }

  const status = errors.length ? "partial_error" : "ok";
  const message = `Refreshed image payloads for ${selectedIds.length} selected row(s); fetched ${fetched}, upserted ${upserted}${errors.length ? `; ${errors.join(" | ")}` : ""}`;
  db.prepare("INSERT INTO sync_logs (job, status, message) VALUES ('ozon_online_product_images', ?, ?)").run(status, message);
  if (errors.length && upserted === 0) throw new Error(errors.join(" | "));
  return { fetched, upserted, errors };
}
