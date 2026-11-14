// Expand only current fulfillment demand. Shipped items keep recorded inventory
// consumption as their source of truth, even when today's composition changed.
export function expandCurrentProcurementDemands(demands, composition) {
  const rows = new Map();
  for (const row of demands) {
    if (!Number(row.needs_fulfillment) || Number(row.entered_transport) || row.stock_location === 'FBP') {
      rows.set(`history:${rows.size}`, row);
      continue;
    }
    let parts;
    try { parts = composition.isBundle && !composition.isBundle(Number(row.product_id))
      ? [{id: row.product_id, name: row.product_name, stock_unit: row.stock_unit, per_set_quantity: 1}]
      : composition.components(Number(row.product_id)); }
    catch (error) {
      throw Object.assign(new Error(`订单 ${row.posting_number} 的库存组成无法核算：${error.message}；请在库存管理修复套装组成后重试`), {statusCode: 409});
    }
    for (const part of parts) {
      const quantity = Number(row.quantity) * part.per_set_quantity;
      const key = `${row.order_item_id}:${part.id}`;
      const previous = rows.get(key);
      if (previous) previous.quantity += quantity;
      else rows.set(key, {...row, product_id: Number(part.id), product_name: part.name, stock_unit: part.stock_unit, quantity});
    }
  }
  return [...rows.values()];
}

export function procurementDemandAncestorIds(ids, edges) {
  const reverse = new Map();
  for (const edge of edges) {
    const child = Number(edge.component_product_id);
    if (!reverse.has(child)) reverse.set(child, []);
    reverse.get(child).push(Number(edge.product_id));
  }
  const result = new Set(ids.map(Number)), pending = [...result];
  for (let i = 0; i < pending.length; i++) for (const parent of reverse.get(pending[i]) || []) {
    if (!result.has(parent)) { result.add(parent); pending.push(parent); }
  }
  return [...result];
}
