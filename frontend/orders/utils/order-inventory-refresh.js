// A fast display hint only; the server resolves authoritative mappings again.
export function orderUsesInventoryProduct(row, productId) {
  const id = Number(productId);
  if (!Number.isSafeInteger(id) || id <= 0) return true;
  return (row.inventory_availability || []).some(fact => Number(fact.product_id) === id)
    || (row.inventory_picking_items || []).some(item => Number(item.product_id) === id || Number(item.parent_product_id) === id)
    || String(row.product_ids || '').split(',').some(value => Number(value) === id);
}
