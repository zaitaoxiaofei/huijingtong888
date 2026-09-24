// Reuse page coverage: opening the list must not request a ledger for every row.
export function inventoryOverview(row) {
  const coverage = row.procurement_coverage;
  const products = new Map();
  for (const summary of row.inventorySummaries || []) {
    const parts = summary.pickingItems?.length ? summary.pickingItems : [{
      product_id: summary.productId, product_name: summary.productName,
      inventory_number: summary.inventoryNumber, required_quantity: summary.quantity
    }];
    for (const part of parts) {
      const id = Number(part.product_id);
      if (!id) continue;
      const item = products.get(id) || { ...part, product_id: id, quantity: 0 };
      item.quantity += Number(part.required_quantity || 0);
      products.set(id, item);
    }
  }
  const covered = new Set();
  for (const part of coverage?.items || []) {
    const id = Number(part.product_id);
    if (!id) continue;
    const item = products.get(id) || { product_id: id, product_name: part.product_name };
    if (!covered.has(id)) {
      item.quantity = 0;
      item.stock_quantity = 0;
      item.incoming_quantity = 0;
      item.shortage_quantity = 0;
      covered.add(id);
    }
    for (const key of ['quantity', 'stock_quantity', 'incoming_quantity', 'shortage_quantity']) {
      item[key] = item[key] === undefined || part[key] === undefined ? undefined : item[key] + Number(part[key]);
    }
    item.quantity_needs_review ||= part.quantity_needs_review;
    products.set(id, item);
  }
  const items = [...products.values()].sort((a, b) => Number(b.shortage_quantity || 0) - Number(a.shortage_quantity || 0));
  return {
    items, active: !!coverage?.needs_fulfillment && coverage.stock_location !== 'FBP',
    shortageCount: items.filter(item => item.shortage_quantity > 0).length,
    coveredCount: items.filter(item => item.shortage_quantity === 0 && !item.quantity_needs_review).length,
    review: !!(coverage?.inventory_needs_review || coverage?.quantity_needs_review || coverage?.missing_amount || coverage?.missing_record_quantity > 0)
  };
}
