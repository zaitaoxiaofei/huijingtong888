export async function refreshInventoryAlertSkuDailyMysqlService(deps, body = {}) {
  const rangeFrom = deps.normalizeDate(body.from) || "2000-01-01";
  const rangeTo = deps.normalizeDate(body.to) || deps.todayDateKey();
  const orderedAtFilter = deps.orderedAtUtcRange("o", rangeFrom, rangeTo);
  await deps.execute("DELETE FROM inventory_alert_sku_daily WHERE date_key >= ? AND date_key <= ?", [rangeFrom, rangeTo]);
  await deps.execute(`
    INSERT INTO inventory_alert_sku_daily (date_key, shop_id, ozon_sku, item_quantity, refreshed_at)
    SELECT ${deps.chinaDateSql("o.ordered_at")}, o.shop_id, oi.ozon_sku, COALESCE(SUM(oi.quantity), 0), CURRENT_TIMESTAMP
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    WHERE LOWER(o.status) NOT LIKE '%cancel%'
      AND LOWER(COALESCE(o.tracking_stage, '')) NOT LIKE '%cancel%'
      AND oi.ozon_sku IS NOT NULL AND oi.ozon_sku <> ''
      ${orderedAtFilter.whereSql}
    GROUP BY ${deps.chinaDateSql("o.ordered_at")}, o.shop_id, oi.ozon_sku
    ON DUPLICATE KEY UPDATE item_quantity = VALUES(item_quantity), refreshed_at = VALUES(refreshed_at)
  `, orderedAtFilter.params);
  deps.invalidateCache("stock-alerts:base:v2");
  const count = await deps.queryOne(
    "SELECT COUNT(*) AS count FROM inventory_alert_sku_daily WHERE date_key >= ? AND date_key <= ?",
    [rangeFrom, rangeTo]
  );
  return { from: rangeFrom, to: rangeTo, rows: Number(count?.count || 0) };
}
