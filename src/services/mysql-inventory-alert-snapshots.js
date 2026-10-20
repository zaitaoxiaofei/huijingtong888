const DAY_MS = 24 * 60 * 60 * 1000;

function dateKeys(from, to) {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error("Invalid inventory sales refresh date range");
  const keys = [];
  for (let time = start; time <= end; time += DAY_MS) keys.push(new Date(time).toISOString().slice(0, 10));
  return keys;
}

export async function markInventoryAlertSkuDailyDirtyMysqlService(deps, dateKey) {
  const normalized = deps.normalizeDate(dateKey);
  if (!normalized) return;
  await deps.execute(`
    INSERT INTO inventory_alert_sku_daily_refresh (date_key, dirty, refreshed_at)
    VALUES (?, 1, NULL)
    ON DUPLICATE KEY UPDATE dirty = 1
  `, [normalized]);
  deps.invalidateCachePrefix?.("stock-alerts:product-sales:");
  deps.invalidateCachePrefix?.("stock-alerts:inventory-base:");
}

export async function refreshInventoryAlertSkuDailyMysqlService(deps, body = {}) {
  const rangeFrom = deps.normalizeDate(body.from) || deps.todayDateKey();
  const rangeTo = deps.normalizeDate(body.to) || deps.todayDateKey();
  const keys = dateKeys(rangeFrom, rangeTo);
  const dateSql = deps.chinaDateSql("o.ordered_at");
  for (const dateKey of keys) {
    const orderedAtFilter = deps.orderedAtUtcRange("o", dateKey, dateKey);
    await deps.transaction(async (connection) => {
      await connection.execute(`
        INSERT INTO inventory_alert_sku_daily_refresh (date_key, dirty, refreshed_at)
        VALUES (?, 1, NULL)
        ON DUPLICATE KEY UPDATE date_key = VALUES(date_key)
      `, [dateKey]);
      await connection.execute("SELECT date_key FROM inventory_alert_sku_daily_refresh WHERE date_key = ? FOR UPDATE", [dateKey]);
      await connection.execute("DELETE FROM inventory_alert_sku_daily WHERE date_key = ?", [dateKey]);
      await connection.execute(`
        INSERT INTO inventory_alert_sku_daily (date_key, shop_id, ozon_sku, item_quantity, fbs_item_quantity, refreshed_at)
        SELECT ${dateSql}, o.shop_id,
          COALESCE(NULLIF(oi.ozon_sku, ''), NULLIF(prior_mapping.ozon_sku, '')),
          COALESCE(SUM(oi.quantity), 0),
          COALESCE(SUM(CASE WHEN NOT EXISTS (
            SELECT 1 FROM ozon_orders_raw raw
            WHERE raw.store_id = o.shop_id AND raw.posting_number = o.posting_number
              AND raw.query_stock_location = 'FBP'
          ) THEN oi.quantity ELSE 0 END), 0), CURRENT_TIMESTAMP
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        LEFT JOIN sku_mappings prior_mapping ON prior_mapping.id = oi.sku_mapping_id
          AND prior_mapping.shop_id = o.shop_id
        WHERE ((LOWER(COALESCE(o.status, '')) NOT LIKE '%cancel%'
          AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%')
          OR ${deps.transportEvidenceSql("o")})
          AND COALESCE(NULLIF(oi.ozon_sku, ''), NULLIF(prior_mapping.ozon_sku, '')) IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM order_items newer
            LEFT JOIN sku_mappings newer_mapping ON newer_mapping.id = newer.sku_mapping_id
              AND newer_mapping.shop_id = o.shop_id
            WHERE newer.order_id = oi.order_id AND newer.id > oi.id
              AND COALESCE(NULLIF(newer.ozon_sku, ''), NULLIF(newer_mapping.ozon_sku, ''))
                = COALESCE(NULLIF(oi.ozon_sku, ''), NULLIF(prior_mapping.ozon_sku, ''))
          )
          ${orderedAtFilter.whereSql}
        GROUP BY ${dateSql}, o.shop_id,
          COALESCE(NULLIF(oi.ozon_sku, ''), NULLIF(prior_mapping.ozon_sku, ''))
      `, orderedAtFilter.params);
      await connection.execute(`
        UPDATE inventory_alert_sku_daily_refresh
        SET dirty = 0, refreshed_at = CURRENT_TIMESTAMP
        WHERE date_key = ?
      `, [dateKey]);
    });
  }
  deps.invalidateCache("stock-alerts:base:v2");
  deps.invalidateCachePrefix?.("stock-alerts:base:v3:");
  deps.invalidateCachePrefix?.("stock-alerts:product-sales:");
  deps.invalidateCachePrefix?.("stock-alerts:inventory-base:");
  const count = await deps.queryOne(
    "SELECT COUNT(*) AS count FROM inventory_alert_sku_daily WHERE date_key >= ? AND date_key <= ?",
    [rangeFrom, rangeTo]
  );
  return { from: rangeFrom, to: rangeTo, rows: Number(count?.count || 0) };
}
