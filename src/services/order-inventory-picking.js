import { mysqlQuery } from "../mysql-pool.js";

export function groupInventoryPickingRows(rows) {
  const orders = new Map();
  for (const row of rows) {
    const id = Number(row.order_id);
    if (!orders.has(id)) orders.set(id, []);
    const items = orders.get(id);
    const existing = items.find((item) => item.sku === row.sku && item.product_id === Number(row.product_id));
    const quantity = Number(row.order_quantity) * Number(row.per_set_quantity);
    if (existing) existing.required_quantity += quantity;
    else items.push({
      sku: row.sku,
      parent_product_id: Number(row.parent_product_id || 0),
      product_id: Number(row.product_id),
      product_name: row.product_name || "",
      inventory_number: row.inventory_number || "",
      stock_unit: row.stock_unit || "个",
      per_set_quantity: Number(row.per_set_quantity),
      required_quantity: quantity
    });
  }
  return orders;
}

export async function orderInventoryPickingMysql(orderIds) {
  if (!orderIds.length) return new Map();
  const rows = await mysqlQuery(`
    SELECT oi.order_id, oi.ozon_sku AS sku, p.id AS parent_product_id,
      child.id AS product_id, child.name AS product_name, child.inventory_number, child.stock_unit,
      COALESCE(ri.quantity, pc.quantity) AS per_set_quantity, oi.quantity AS order_quantity
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    LEFT JOIN sku_mappings direct_mapping ON direct_mapping.id = oi.sku_mapping_id AND direct_mapping.active = 1
    LEFT JOIN sku_mappings sm ON sm.id = COALESCE(direct_mapping.id, (
      SELECT MIN(fallback_mapping.id) FROM sku_mappings fallback_mapping
      WHERE fallback_mapping.shop_id = o.shop_id AND fallback_mapping.ozon_sku = oi.ozon_sku AND fallback_mapping.active = 1
    ))
    LEFT JOIN products p ON p.id = sm.product_id AND p.active = 1
    LEFT JOIN sku_inventory_recipes recipe ON recipe.shop_id = o.shop_id AND recipe.ozon_sku = oi.ozon_sku AND recipe.active = 1
    LEFT JOIN sku_inventory_recipe_items ri ON ri.recipe_id = recipe.id
    LEFT JOIN product_components pc ON pc.product_id = p.id AND recipe.id IS NULL
    JOIN products child ON child.id = COALESCE(ri.product_id, pc.component_product_id)
    WHERE oi.order_id IN (${orderIds.map(() => "?").join(",")})
    ORDER BY oi.id, child.inventory_number_category, child.inventory_number_sequence
  `, orderIds);
  return groupInventoryPickingRows(rows);
}
