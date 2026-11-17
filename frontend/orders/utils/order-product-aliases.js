// Order IDs, SKU IDs and virtual recipe IDs must never be used as product IDs.
export function orderAliasProducts(overview = {}, { includeParents = false } = {}) {
  const products = new Map();
  const add = (id, name, number) => {
    id = Number(id);
    if (!Number.isSafeInteger(id) || id <= 0 || products.has(id)) return;
    products.set(id, { product_id: id, product_name: name || '库存商品', inventory_number: number || '' });
  };
  if (includeParents) for (const parent of overview.parents || []) add(parent.productId, parent.name, parent.inventoryNumber);
  for (const item of overview.items || []) add(item.product_id, item.product_name, item.inventory_number);
  return [...products.values()];
}
