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
    item.local_available = part.product_local_available;
    item.physical_estimate = part.physical_stock_estimate;
    products.set(id, item);
  }
  const items = [...products.values()].sort((a, b) => Number(b.shortage_quantity || 0) - Number(a.shortage_quantity || 0));
  return {
    shopId: Number(row.shop_id), skus: (row.fbp_inventory || []).map(stock => String(stock.ozon_sku)),
    parents: (row.inventorySummaries || []).map(summary => ({
      id: summary.inventoryKey || `${summary.productId}-${summary.sku || ''}`,
      name: summary.productName, inventoryNumber: summary.inventoryNumber,
      quantity: summary.quantity, virtual: summary.inventoryMode === 'combo' || Number(summary.componentCount) > 0 || summary.pickingItems?.some(part => Number(part.product_id) !== Number(summary.productId)),
      localAvailable: localSets(summary, products, 'local_available'),
      localPhysical: localSets(summary, products, 'physical_estimate'),
      localLedger: summary.stock?.local,
      fbpStocks: [...new Set(summary.skus || [summary.sku])].filter(Boolean).map(sku =>
        (row.fbp_inventory || []).find(stock => String(stock.ozon_sku) === String(sku)) || { ozon_sku: sku, present: null, available: null }),
      children: (summary.pickingItems || []).map(part => ({
        ...part, quantity: part.required_quantity,
        // Coverage belongs to the product across this order, not each parent recipe.
        shortage: products.get(Number(part.product_id))?.shortage_quantity,
        review: products.get(Number(part.product_id))?.quantity_needs_review
      }))
    })),
    items, active: !!coverage?.needs_fulfillment && coverage.stock_location !== 'FBP',
    shortageCount: items.filter(item => item.shortage_quantity > 0).length,
    coveredCount: items.filter(item => item.shortage_quantity === 0 && !item.quantity_needs_review).length,
    review: !!(coverage?.inventory_needs_review || coverage?.quantity_needs_review || coverage?.missing_amount || coverage?.missing_record_quantity > 0)
  };
}

function localSets(summary, products, field) {
  const parts = summary.pickingItems?.length ? summary.pickingItems : [{ product_id: summary.productId, per_set_quantity: 1 }];
  const quantities = parts.map(part => {
    const value = products.get(Number(part.product_id))?.[field];
    const ratio = Number(part.per_set_quantity || (summary.quantity > 0 ? Number(part.required_quantity) / summary.quantity : 0));
    return value == null || !(ratio > 0) ? null : Math.floor(Math.max(0, Number(value)) / ratio);
  });
  return quantities.some(value => value === null) ? null : Math.min(...quantities);
}
