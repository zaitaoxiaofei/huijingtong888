import { mysqlExecute, mysqlQuery } from "../mysql-pool.js";
import { broadcastGlobalEvent } from "../server/notifications.js";

let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;
  await mysqlExecute(`
    CREATE TABLE IF NOT EXISTS sku_order_trackers (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id BIGINT UNSIGNED NOT NULL,
      shop_id BIGINT UNSIGNED NOT NULL,
      ozon_sku VARCHAR(128) NOT NULL,
      owner_person_id BIGINT UNSIGNED NULL,
      decline_weeks TINYINT UNSIGNED NOT NULL DEFAULT 2,
      decline_percent DECIMAL(6,2) NOT NULL DEFAULT 20,
      active TINYINT(1) NOT NULL DEFAULT 1,
      last_notified_at DATETIME NULL,
      created_by_person_id BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_sku_order_tracker_tenant_shop_sku (tenant_id, shop_id, ozon_sku),
      KEY idx_sku_order_tracker_owner (owner_person_id, active),
      KEY idx_sku_order_tracker_tenant_active_shop (tenant_id, active, shop_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const columns = await mysqlQuery("SHOW COLUMNS FROM sku_order_trackers");
  if (!columns.some((column) => column.Field === "tenant_id")) {
    throw new Error("SKU 订单追踪租户隔离迁移尚未执行，请先运行 scripts/migrate-tenant-sku-order-trackers.mjs --apply");
  }
  const indexes = await mysqlQuery("SHOW INDEX FROM sku_order_trackers");
  const indexNames = new Set(indexes.map((index) => index.Key_name));
  if (!indexNames.has("uk_sku_order_tracker_tenant_shop_sku") || !indexNames.has("idx_sku_order_tracker_tenant_active_shop")) {
    throw new Error("SKU 订单追踪租户索引迁移未完成，请重新运行 scripts/migrate-tenant-sku-order-trackers.mjs --apply");
  }
  schemaReady = true;
}

async function resolveTenantContext(tenantId = "admin") {
  const isDefaultTenant = String(tenantId) === "admin";
  const rows = await mysqlQuery(
    isDefaultTenant
      ? "SELECT id, slug FROM tenants WHERE slug = 'default' AND status = 'active' LIMIT 1"
      : "SELECT id, slug FROM tenants WHERE id = ? AND status = 'active' LIMIT 1",
    isDefaultTenant ? [] : [Number(tenantId)]
  );
  const tenant = rows[0];
  if (!tenant || (isDefaultTenant && tenant.slug !== "default") || (!isDefaultTenant && tenant.slug === "default")) {
    throw new Error("当前企业上下文无效，无法读取 SKU 订单追踪");
  }
  return { id: Number(tenant.id), key: tenant.slug === "default" ? "admin" : String(tenant.id), isDefault: tenant.slug === "default" };
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function trendStatus(row) {
  const current = Number(row.week_1_sales || 0);
  const previous = Number(row.week_2_sales || 0);
  const oldest = Number(row.week_3_sales || 0);
  if (current > previous && previous > oldest && current >= 3) return "rising_star";
  if (current < previous && previous < oldest) return "continuous_decline";
  if (previous > 0 && current <= previous * 0.6) return "sharp_decline";
  return "stable";
}

async function notifyDecliningTrackers(rows) {
  const candidates = rows.filter((row) => {
    if (!Number(row.tracked) || !Number(row.owner_person_id)) return false;
    const current = Number(row.week_1_sales || 0);
    const previous = Number(row.week_2_sales || 0);
    const oldest = Number(row.week_3_sales || 0);
    const continuous = current < previous && (Number(row.decline_weeks || 2) <= 2 || previous < oldest);
    const drop = previous > 0 ? ((previous - current) / previous) * 100 : 0;
    const last = row.last_notified_at ? new Date(row.last_notified_at).getTime() : 0;
    return (!last || Date.now() - last >= 20 * 60 * 60 * 1000)
      && (continuous || drop >= Number(row.decline_percent || 20));
  });
  for (const row of candidates) {
    broadcastGlobalEvent("sku-order-tracking", {
      title: "SKU 单量持续下滑",
      message: `${row.shop_name} · ${row.ozon_sku} 近三周销量 ${row.week_3_sales} → ${row.week_2_sales} → ${row.week_1_sales}，请及时检查价格与跟卖情况。`,
      level: "warning",
      shop_id: row.shop_id,
      ozon_sku: row.ozon_sku,
      route: "/order-tracking"
    }, { personId: Number(row.owner_person_id) });
    await mysqlExecute("UPDATE sku_order_trackers SET last_notified_at = CURRENT_TIMESTAMP WHERE id = ?", [row.tracker_id]);
  }
}

function orderedAggregateSql(where, { isDefaultTenant = false } = {}) {
  const orderShopPredicate = isDefaultTenant
    ? "(order_shop.tenant_id = ? OR order_shop.tenant_id IS NULL)"
    : "order_shop.tenant_id = ?";
  const trackerTenantExpr = isDefaultTenant
    ? "COALESCE(s.tenant_id, (SELECT tenant_default.id FROM tenants tenant_default WHERE tenant_default.slug = 'default' LIMIT 1))"
    : "s.tenant_id";
  const inventoryJoins = isDefaultTenant
    ? `LEFT JOIN sku_mappings sm ON sm.shop_id = stats.shop_id AND sm.ozon_sku = stats.ozon_sku AND sm.active = 1
       LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1`
    : "";
  const inventoryFields = isDefaultTenant
    ? "sm.product_id AS inventory_product_id, p.code AS inventory_code, p.name AS inventory_name"
    : "NULL AS inventory_product_id, NULL AS inventory_code, NULL AS inventory_name";
  const inventoryImages = isDefaultTenant
    ? "NULLIF(p.image_url, '')"
    : "NULL";
  return `
    SELECT stats.shop_id, s.name AS shop_name, s.ozon_client_id AS analytics_store_id, stats.ozon_sku,
      COALESCE(NULLIF(op.name, ''), NULLIF(stats.order_product_name, ''), stats.ozon_sku) AS product_name,
      COALESCE(NULLIF(op.ozon_product_id, ''), NULLIF(stats.order_product_id, '')) AS ozon_product_id,
      COALESCE(NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), NULLIF(stats.order_image_url, ''), ${inventoryImages}) AS image_url,
      CONCAT_WS('||', NULLIF(op.primary_image, ''), NULLIF(op.image_url, ''), NULLIF(stats.order_image_url, ''), ${inventoryImages}) AS image_urls,
      COALESCE(op.sale_price, stats.order_sale_price, 0) AS sale_price, COALESCE(op.currency_code, 'RUB') AS currency_code,
      COALESCE(op.published_at, op.ozon_updated_at, op.synced_at) AS listed_at,
      stats.first_order_at, stats.latest_order_at, stats.total_sales, stats.week_1_sales, stats.week_2_sales, stats.week_3_sales,
      CASE WHEN LOWER(COALESCE(op.stocks_json, '')) LIKE '%fbo%' THEN 'FBO' WHEN LOWER(COALESCE(op.stocks_json, '')) LIKE '%fbp%' THEN 'FBP' ELSE 'FBS' END AS logistics_method,
      ${inventoryFields},
      tracker.id AS tracker_id, tracker.active AS tracked, tracker.owner_person_id, pe.name AS owner_name,
      tracker.decline_weeks, tracker.decline_percent, tracker.last_notified_at
    FROM (
      SELECT o.shop_id, oi.ozon_sku, MAX(oi.ozon_name) AS order_product_name, MAX(oi.ozon_product_id) AS order_product_id,
      MAX(oi.ozon_image_url) AS order_image_url, MAX(oi.sale_price) AS order_sale_price,
      MIN(o.ordered_at) AS first_order_at, MAX(o.ordered_at) AS latest_order_at,
      SUM(CASE WHEN LOWER(CONCAT_WS(' ', o.status, o.tracking_stage)) NOT LIKE '%cancel%' THEN oi.quantity ELSE 0 END) AS total_sales,
      SUM(CASE WHEN LOWER(CONCAT_WS(' ', o.status, o.tracking_stage)) NOT LIKE '%cancel%' AND DATE(CONVERT_TZ(o.ordered_at, '+00:00', '+08:00')) >= DATE_SUB(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+08:00')), INTERVAL 6 DAY) THEN oi.quantity ELSE 0 END) AS week_1_sales,
      SUM(CASE WHEN LOWER(CONCAT_WS(' ', o.status, o.tracking_stage)) NOT LIKE '%cancel%' AND DATE(CONVERT_TZ(o.ordered_at, '+00:00', '+08:00')) BETWEEN DATE_SUB(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+08:00')), INTERVAL 13 DAY) AND DATE_SUB(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+08:00')), INTERVAL 7 DAY) THEN oi.quantity ELSE 0 END) AS week_2_sales,
      SUM(CASE WHEN LOWER(CONCAT_WS(' ', o.status, o.tracking_stage)) NOT LIKE '%cancel%' AND DATE(CONVERT_TZ(o.ordered_at, '+00:00', '+08:00')) BETWEEN DATE_SUB(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+08:00')), INTERVAL 20 DAY) AND DATE_SUB(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+08:00')), INTERVAL 14 DAY) THEN oi.quantity ELSE 0 END) AS week_3_sales
      FROM orders o JOIN shops order_shop ON order_shop.id = o.shop_id AND order_shop.status != 'deleted' AND ${orderShopPredicate}
      JOIN order_items oi ON oi.order_id = o.id
      WHERE COALESCE(oi.ozon_sku, '') != '' GROUP BY o.shop_id, oi.ozon_sku
    ) stats
    JOIN shops s ON s.id = stats.shop_id
    LEFT JOIN online_products op ON op.shop_id = stats.shop_id AND op.ozon_sku = stats.ozon_sku
    ${inventoryJoins}
    LEFT JOIN sku_order_trackers tracker ON tracker.tenant_id = ${trackerTenantExpr} AND tracker.shop_id = stats.shop_id AND CONVERT(tracker.ozon_sku USING utf8mb4) COLLATE utf8mb4_unicode_ci = CONVERT(stats.ozon_sku USING utf8mb4) COLLATE utf8mb4_unicode_ci
    LEFT JOIN tenant_members tracker_owner ON tracker_owner.tenant_id = tracker.tenant_id AND tracker_owner.person_id = tracker.owner_person_id AND tracker_owner.active = 1
    LEFT JOIN people pe ON pe.id = tracker.owner_person_id AND tracker_owner.person_id IS NOT NULL
    WHERE ${where.join(" AND ")}`;
}

async function attachPageDetails(pageRows, tenantKey = "admin") {
  if (!pageRows.length) return;
  const keys = pageRows.map(() => "(?, ?)").join(",");
  const keyParams = pageRows.flatMap((row) => [row.shop_id, row.ozon_sku]);
  const analyticsSkuPlaceholders = pageRows.map(() => "?").join(",");
  const analyticsParams = pageRows.map((row) => row.ozon_sku);
  const [priceRows, analyticsRows] = await Promise.all([
    mysqlQuery(`
      SELECT o.shop_id, oi.ozon_sku, DATE_FORMAT(DATE_SUB(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+08:00')), INTERVAL (FLOOR(DATEDIFF(DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+08:00')), DATE(CONVERT_TZ(o.ordered_at, '+00:00', '+08:00'))) / 7) * 7) DAY), '%Y-%m-%d') AS week_start,
        ROUND(SUM(oi.sale_price * oi.quantity) / NULLIF(SUM(oi.quantity), 0), 2) AS avg_price
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE (o.shop_id, oi.ozon_sku) IN (${keys}) AND o.ordered_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 21 DAY)
      GROUP BY o.shop_id, oi.ozon_sku, week_start ORDER BY week_start`, keyParams),
    mysqlQuery(`
      SELECT m.store_id, m.sku, m.period_key, m.order_count, m.order_amount,
        m.impressions, m.card_views, m.add_to_cart, m.conversion_rate, m.captured_at
      FROM seller_analytics_product_metrics m
      WHERE m.tenant_id = ? AND m.period_key IN ('7d', '28d') AND m.sku IN (${analyticsSkuPlaceholders})
      ORDER BY m.captured_at DESC LIMIT 1000`, [tenantKey, ...analyticsParams]).catch(() => [])
  ]);
  const priceMap = new Map();
  for (const item of priceRows) {
    const key = `${item.shop_id}:${item.ozon_sku}`;
    if (!priceMap.has(key)) priceMap.set(key, []);
    priceMap.get(key).push({ date: item.week_start, value: Number(item.avg_price || 0) });
  }
  const analyticsMap = new Map();
  for (const item of analyticsRows) {
    const key = `${item.store_id}:${item.sku}:${item.period_key}`;
    if (!analyticsMap.has(key)) analyticsMap.set(key, item);
  }
  for (const row of pageRows) {
    const key = `${row.shop_id}:${row.ozon_sku}`;
    row.price_trend = priceMap.get(key) || [];
    const analyticsKey = `${row.analytics_store_id || ""}:${row.ozon_sku}`;
    row.analytics_7d = analyticsMap.get(`${analyticsKey}:7d`) || null;
    row.analytics_28d = analyticsMap.get(`${analyticsKey}:28d`) || null;
  }
}

export async function skuOrderTrackingList(query = {}, tenantId = "admin") {
  await ensureSchema();
  const tenant = await resolveTenantContext(tenantId);
  const page = positiveInt(query.page, 1);
  const pageSize = Math.min(positiveInt(query.pageSize || query.page_size, 30), 100);
  const offset = (page - 1) * pageSize;
  const scope = String(query.skuScope || query.sku_scope || "ordered") === "all" ? "all" : "ordered";
  const where = ["COALESCE(stats.ozon_sku, '') != ''", "s.status != 'deleted'"];
  const params = [];
  where.push(tenant.isDefault ? "(s.tenant_id = ? OR s.tenant_id IS NULL)" : "s.tenant_id = ?");
  params.push(tenant.id);
  const shopId = String(query.shopId || query.shop_id || "all");
  const keyword = String(query.keyword || "").trim().toLowerCase();
  const inventoryKeyword = String(query.inventoryKeyword || query.inventory_keyword || "").trim().toLowerCase();
  const status = String(query.status || "all");
  const tracked = String(query.tracked || "all");
  if (shopId !== "all") { where.push("stats.shop_id = ?"); params.push(Number(shopId)); }
  if (keyword) { where.push("LOWER(CONCAT_WS(' ', stats.ozon_sku, stats.order_product_name, op.name, op.offer_id, s.name)) LIKE ?"); params.push(`%${keyword}%`); }
  if (inventoryKeyword && tenant.isDefault) {
    where.push("(LOWER(CONCAT_WS(' ', p.name, p.code)) LIKE ? OR EXISTS (SELECT 1 FROM product_name_aliases pna WHERE pna.product_id = p.id AND pna.active = 1 AND LOWER(pna.alias_name) LIKE ?))");
    params.push(`%${inventoryKeyword}%`, `%${inventoryKeyword}%`);
  } else if (inventoryKeyword) {
    where.push("1 = 0");
  }
  if (tracked === "1") where.push("tracker.active = 1");
  if (tracked === "0") where.push("tracker.id IS NULL");

  const aggregateSql = orderedAggregateSql(where, { isDefaultTenant: tenant.isDefault });
  const risingSql = "week_1_sales > week_2_sales AND week_2_sales > week_3_sales AND week_1_sales >= 3";
  const decliningSql = "week_1_sales < week_2_sales AND week_2_sales < week_3_sales";
  const sharpSql = `NOT (${decliningSql}) AND week_2_sales > 0 AND week_1_sales <= week_2_sales * 0.6`;
  const trendWhere = { rising_star: risingSql, continuous_decline: decliningSql, sharp_decline: sharpSql, stable: `NOT (${risingSql}) AND NOT (${decliningSql}) AND NOT (${sharpSql})` }[status] || "1 = 1";
  let filteredSql = `SELECT * FROM (${aggregateSql}) sku_stats WHERE ${trendWhere}`;
  let filteredParams = [tenant.id, ...params];

  if (scope === "all") {
    const catalogWhere = ["op.archived = 0", "s.status != 'deleted'"];
    const catalogParams = [];
    catalogWhere.push(tenant.isDefault ? "(s.tenant_id = ? OR s.tenant_id IS NULL)" : "s.tenant_id = ?");
    catalogParams.push(tenant.id);
    if (shopId !== "all") { catalogWhere.push("op.shop_id = ?"); catalogParams.push(Number(shopId)); }
    if (keyword) { catalogWhere.push("LOWER(CONCAT_WS(' ', op.ozon_sku, op.name, op.offer_id, s.name)) LIKE ?"); catalogParams.push(`%${keyword}%`); }
    if (inventoryKeyword && tenant.isDefault) {
      catalogWhere.push("(LOWER(CONCAT_WS(' ', p.name, p.code)) LIKE ? OR EXISTS (SELECT 1 FROM product_name_aliases pna WHERE pna.product_id = p.id AND pna.active = 1 AND LOWER(pna.alias_name) LIKE ?))");
      catalogParams.push(`%${inventoryKeyword}%`, `%${inventoryKeyword}%`);
    } else if (inventoryKeyword) {
      catalogWhere.push("1 = 0");
    }
    if (tracked === "1") catalogWhere.push("tracker.active = 1");
    if (tracked === "0") catalogWhere.push("tracker.id IS NULL");
    filteredSql = `SELECT catalog.*, COALESCE(stats.total_sales, 0) total_sales, COALESCE(stats.week_1_sales, 0) week_1_sales, COALESCE(stats.week_2_sales, 0) week_2_sales, COALESCE(stats.week_3_sales, 0) week_3_sales, stats.first_order_at, stats.latest_order_at, COALESCE(stats.logistics_method, 'FBS') logistics_method
      FROM (SELECT op.shop_id, s.name shop_name, s.ozon_client_id analytics_store_id, op.ozon_sku, op.name product_name, op.ozon_product_id,
        COALESCE(NULLIF(op.primary_image,''), NULLIF(op.image_url,''), ${tenant.isDefault ? "NULLIF(p.image_url,'')" : "NULL"}) image_url, CONCAT_WS('||', NULLIF(op.primary_image,''), NULLIF(op.image_url,''), ${tenant.isDefault ? "NULLIF(p.image_url,'')" : "NULL"}) image_urls,
        op.sale_price, COALESCE(op.currency_code,'RUB') currency_code, COALESCE(op.published_at, op.ozon_updated_at, op.synced_at) listed_at,
        ${tenant.isDefault ? "sm.product_id inventory_product_id, p.code inventory_code, p.name inventory_name" : "NULL inventory_product_id, NULL inventory_code, NULL inventory_name"},
        tracker.id tracker_id, tracker.active tracked, tracker.owner_person_id, pe.name owner_name, tracker.decline_weeks, tracker.decline_percent, tracker.last_notified_at
        FROM online_products op JOIN shops s ON s.id=op.shop_id
        ${tenant.isDefault ? "LEFT JOIN sku_mappings sm ON sm.shop_id=op.shop_id AND sm.ozon_sku=op.ozon_sku AND sm.active=1 LEFT JOIN products p ON p.id=sm.product_id AND p.active=1" : ""}
        LEFT JOIN sku_order_trackers tracker ON tracker.tenant_id=${tenant.id} AND tracker.shop_id=op.shop_id AND CONVERT(tracker.ozon_sku USING utf8mb4) COLLATE utf8mb4_unicode_ci=CONVERT(op.ozon_sku USING utf8mb4) COLLATE utf8mb4_unicode_ci
        LEFT JOIN tenant_members tracker_owner ON tracker_owner.tenant_id=tracker.tenant_id AND tracker_owner.person_id=tracker.owner_person_id AND tracker_owner.active=1
        LEFT JOIN people pe ON pe.id=tracker.owner_person_id AND tracker_owner.person_id IS NOT NULL WHERE ${catalogWhere.join(" AND ")}) catalog
      LEFT JOIN (${orderedAggregateSql(["COALESCE(stats.ozon_sku, '') != ''"], { isDefaultTenant: tenant.isDefault })}) stats ON stats.shop_id=catalog.shop_id AND stats.ozon_sku=catalog.ozon_sku
      WHERE ${trendWhere}`;
    filteredParams = [...catalogParams, tenant.id];
  }

  const [countRows, pageRowsRaw] = await Promise.all([
    mysqlQuery(`SELECT COUNT(*) total FROM (${filteredSql}) counted`, filteredParams),
    mysqlQuery(`${filteredSql} ORDER BY total_sales DESC, shop_id, ozon_sku LIMIT ? OFFSET ?`, [...filteredParams, pageSize, offset])
  ]);
  const pageRows = pageRowsRaw.map((row) => ({ ...row, trend_status: trendStatus(row) }));
  await attachPageDetails(pageRows, tenant.key);
  await notifyDecliningTrackers(pageRows);
  return { rows: pageRows, total: Number(countRows[0]?.total || 0), page, pageSize, skuScope: scope };
}

export async function saveSkuOrderTracker(body = {}, currentPersonId = null, tenantId = "admin") {
  await ensureSchema();
  const tenant = await resolveTenantContext(tenantId);
  const shopId = positiveInt(body.shop_id || body.shopId, 0);
  const sku = String(body.ozon_sku || body.ozonSku || "").trim();
  if (!shopId || !sku) throw Object.assign(new Error("缺少店铺或 SKU，无法保存追踪配置。"), { status: 400 });
  const active = body.active === false || Number(body.active) === 0 ? 0 : 1;
  const ownerId = positiveInt(body.owner_person_id || body.ownerPersonId, 0) || null;
  const declineWeeks = Math.min(Math.max(positiveInt(body.decline_weeks || body.declineWeeks, 2), 2), 3);
  const declinePercent = Math.min(Math.max(Number(body.decline_percent || body.declinePercent || 20), 5), 90);
  const shops = await mysqlQuery(`SELECT id FROM shops WHERE id = ? AND status != 'deleted' AND ${tenant.isDefault ? "(tenant_id = ? OR tenant_id IS NULL)" : "tenant_id = ?"} LIMIT 1`, [shopId, tenant.id]);
  if (!shops[0]) throw Object.assign(new Error("店铺不存在、已停用或不属于当前企业，无法保存 SKU 追踪配置。"), { status: 404 });
  if (ownerId) {
    const members = await mysqlQuery("SELECT person_id FROM tenant_members WHERE tenant_id = ? AND person_id = ? AND active = 1 LIMIT 1", [tenant.id, ownerId]);
    if (!members[0]) throw Object.assign(new Error("负责人不属于当前企业，请重新选择本企业成员。"), { status: 400 });
  }
  await mysqlExecute(`INSERT INTO sku_order_trackers (tenant_id, shop_id, ozon_sku, owner_person_id, decline_weeks, decline_percent, active, created_by_person_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE owner_person_id=VALUES(owner_person_id), decline_weeks=VALUES(decline_weeks), decline_percent=VALUES(decline_percent), active=VALUES(active), updated_at=CURRENT_TIMESTAMP`,
  [tenant.id, shopId, sku, ownerId, declineWeeks, declinePercent, active, currentPersonId || null]);
  if (active && ownerId) broadcastGlobalEvent("sku-order-tracking", { title: "SKU 单量追踪已绑定", message: `${sku} 已由你负责，持续下滑时系统将发出预警。`, shop_id: shopId, ozon_sku: sku, route: "/order-tracking" }, { personId: ownerId });
  return { ok: true, shop_id: shopId, ozon_sku: sku, active: Boolean(active) };
}
