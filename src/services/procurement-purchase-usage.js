// Read-only accounting attribution. Unattributed receipts are not physical stock.
export function buildPurchaseUsage(snapshot = {}) {
  const purchases = new Map((snapshot.purchases || []).map(row => [Number(row.id), {
    ...row, shipped_usage: 0, current_usage: 0, usage_orders: [], usage_batches: []
  }]));
  const byBatch = new Map();
  for (const batch of snapshot.batches || []) {
    const purchase = purchases.get(Number(batch.purchase_order_item_id));
    if (!purchase) continue;
    purchase.usage_batches.push(batch);
    if (batch.status === 'approved') byBatch.set(Number(batch.id), purchase);
  }
  for (const order of snapshot.orders || []) {
    if (!order.entered_transport || order.stock_location === 'FBP') continue;
    for (const source of order.coverage_trace || []) {
      const purchase = byBatch.get(Number(source.batch_id));
      if (!purchase || source.purpose !== 'source') continue;
      const quantity = Number(source.quantity) || 0;
      purchase.shipped_usage += quantity;
      purchase.usage_orders.push({ ...order, ...source, usage_quantity: quantity, usage_kind: '已发订单' });
    }
  }
  for (const source of snapshot.source_inference?.suggestions || []) {
    const purchase = byBatch.get(Number(source.batch_id));
    if (!purchase || source.purpose !== 'stock_suggestion') continue;
    purchase.current_usage += Number(source.quantity) || 0;
    purchase.usage_orders.push({ ...source, usage_quantity: Number(source.quantity) || 0, usage_kind: '待发订单' });
  }
  for (const purchase of purchases.values()) {
    purchase.unattributed_usage = Math.max(0, Number(purchase.received_quantity || 0) - purchase.shipped_usage - purchase.current_usage);
    purchase.usage_needs_review = purchase.shipped_usage + purchase.current_usage > Number(purchase.received_quantity || 0);
  }
  return purchases;
}

export function availableHistoryBatches(snapshot = {}) {
  const protectedQuantities = new Map();
  for (const row of [...(snapshot.source_inference?.reserves || []), ...(snapshot.source_inference?.suggestions || [])
    .filter(row => row.purpose === 'stock_suggestion' && !row.already_allocated)]) {
    protectedQuantities.set(Number(row.batch_id), (protectedQuantities.get(Number(row.batch_id)) || 0) + Number(row.quantity));
  }
  return (snapshot.batches || []).filter(row => row.status === 'approved').map(row => ({ ...row,
    available_history_quantity: Math.max(0, Number(row.unallocated_quantity || 0) - (protectedQuantities.get(Number(row.id)) || 0))
  })).filter(row => row.available_history_quantity > 0);
}
