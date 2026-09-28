// Read synchronized Ozon stock only. Displaying it must never post inventory movements.
export async function loadOrderFbpStocks(query, orderIds) {
  if (!orderIds.length) return new Map();
  const rows = await query(`SELECT scope.order_id, scope.shop_id, scope.ozon_sku,
    COUNT(stock.id) AS snapshot_count, SUM(stock.present) AS present,
    SUM(stock.available) AS available, SUM(stock.reserved) AS reserved,
    MIN(stock.synced_at) AS synced_at
    FROM (SELECT DISTINCT o.id AS order_id, o.shop_id, oi.ozon_sku
      FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.id IN (${orderIds.map(() => '?').join(',')})) scope
    LEFT JOIN ozon_stock_snapshots stock ON stock.shop_id = scope.shop_id
      AND stock.ozon_sku = scope.ozon_sku AND stock.stock_type = 'fbp_real'
    GROUP BY scope.order_id, scope.shop_id, scope.ozon_sku`, orderIds);
  const result = new Map();
  for (const row of rows) {
    const id = Number(row.order_id);
    if (!result.has(id)) result.set(id, []);
    result.get(id).push({ ...row, snapshot_count: Number(row.snapshot_count),
      present: Number(row.snapshot_count) ? Number(row.present) : null,
      available: Number(row.snapshot_count) ? Number(row.available) : null,
      reserved: Number(row.snapshot_count) ? Number(row.reserved) : null });
  }
  return result;
}

export function summarizeFbpInventory(mappings, snapshots) {
  const rows = mappings.flatMap(mapping => {
    const matched = snapshots.filter(stock => Number(stock.shop_id) === Number(mapping.shop_id) && String(stock.ozon_sku) === String(mapping.ozon_sku));
    return (matched.length ? matched : [null]).map(stock => ({ ...mapping,
      warehouse_name: stock?.warehouse_name || '未提供仓库', warehouse_id: stock?.warehouse_id || '',
      present: stock ? Number(stock.present) : null, available: stock ? Number(stock.available) : null,
      reserved: stock ? Number(stock.reserved) : null, synced_at: stock?.synced_at || null,
      inventory_quantity: stock ? Number(stock.present) * Number(mapping.per_set_quantity) : null,
      available_inventory_quantity: stock ? Number(stock.available) * Number(mapping.per_set_quantity) : null
    }));
  });
  return { rows, present: rows.length ? rows.reduce((sum, row) => sum + (row.inventory_quantity || 0), 0) : null,
    available: rows.length ? rows.reduce((sum, row) => sum + (row.available_inventory_quantity || 0), 0) : null,
    incomplete: !rows.length || rows.some(row => row.present === null) };
}

export async function loadProductFbpStocks(query, productId) {
  const mappings = await query(`SELECT candidates.shop_id, candidates.ozon_sku, shop.name AS shop_name,
      MAX(op.name) AS product_name, MAX(op.offer_id) AS offer_id,
      CASE WHEN recipe.id IS NULL AND sm.product_id = ? THEN 1
        ELSE SUM(COALESCE(ri.quantity, pc.quantity, 1)) END AS per_set_quantity
    FROM (
      SELECT shop_id, ozon_sku FROM sku_mappings WHERE active = 1
        AND (product_id = ? OR product_id IN (SELECT product_id FROM product_components WHERE component_product_id = ?))
      UNION
      SELECT r.shop_id, r.ozon_sku FROM sku_inventory_recipes r
        JOIN sku_inventory_recipe_items i ON i.recipe_id = r.id WHERE r.active = 1 AND i.product_id = ?
    ) candidates
    JOIN shops shop ON shop.id = candidates.shop_id
    LEFT JOIN sku_mappings sm ON sm.id = (SELECT MIN(m.id) FROM sku_mappings m
      WHERE m.active = 1 AND m.shop_id = candidates.shop_id AND m.ozon_sku = candidates.ozon_sku)
    LEFT JOIN sku_inventory_recipes recipe ON recipe.shop_id = candidates.shop_id AND recipe.ozon_sku = candidates.ozon_sku AND recipe.active = 1
    LEFT JOIN sku_inventory_recipe_items ri ON ri.recipe_id = recipe.id
    LEFT JOIN product_components pc ON pc.product_id = sm.product_id AND recipe.id IS NULL
    LEFT JOIN online_products op ON op.shop_id = candidates.shop_id AND op.ozon_sku = candidates.ozon_sku
    WHERE (recipe.id IS NULL AND sm.product_id = ?) OR COALESCE(ri.product_id, pc.component_product_id, sm.product_id) = ?
    GROUP BY candidates.shop_id, candidates.ozon_sku, shop.name, recipe.id, sm.product_id`, Array(6).fill(productId));
  if (!mappings.length) return summarizeFbpInventory([], []);
  const snapshots = await query(`SELECT shop_id, ozon_sku, warehouse_id, warehouse_name, present, available, reserved, synced_at
    FROM ozon_stock_snapshots WHERE stock_type = 'fbp_real' AND (${mappings.map(() => '(shop_id = ? AND ozon_sku = ?)').join(' OR ')})
    ORDER BY shop_id, ozon_sku, warehouse_id`, mappings.flatMap(row => [row.shop_id, row.ozon_sku]));
  return summarizeFbpInventory(mappings, snapshots);
}
