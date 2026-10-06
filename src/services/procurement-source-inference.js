// Read-only accounting suggestions: never change stock, allocations or source records.
export function inferProcurementSources(snapshot) {
  const positive = value => Math.max(0, Number(value) || 0);
  const pools = (snapshot.batches || []).filter(b => b.status === 'approved')
    .map(b => ({ ...b, remaining: positive(b.unallocated_quantity) }))
    .sort((a, b) => String(a.purchased_at || a.created_at || '').localeCompare(String(b.purchased_at || b.created_at || '')) || Number(a.id) - Number(b.id));
  const suggestions = [], reserves = [];
  const take = (quantity, order, purpose) => {
    let missing = positive(quantity);
    for (const batch of pools) {
      const amount = Math.min(missing, batch.remaining);
      if (!amount) continue;
      batch.remaining -= amount; missing -= amount;
      const row = { batch_id: Number(batch.id), purchase_order_no: batch.purchase_order_no || '',
        quantity: amount, purpose, basis: 'suggested', source_label: '已收货批次',
        order_item_id: order?.order_item_id, posting_number: order?.posting_number,
        late_registration: purpose === 'history_candidate' && new Date(batch.approved_at || batch.purchased_at || 0).getTime() > new Date(order.transport_at || order.ordered_at || 0).getTime() };
      (order ? suggestions : reserves).push(row);
    }
    return missing;
  };
  const current = (snapshot.orders || []).filter(o => o.needs_fulfillment)
    .sort((a, b) => Number(b.allocation_priority || 0) - Number(a.allocation_priority || 0) || String(a.ordered_at || '').localeCompare(String(b.ordered_at || '')) || a.order_item_id - b.order_item_id);
  let currentUnmatched = 0, covered = 0;
  for (const order of current) {
    let needed = positive(order.stock_quantity); covered += needed;
    // These sources already consumed batch capacity in the coverage projection.
    for (const source of order.coverage_trace || []) {
      if (source.purpose !== 'source' || !source.batch_id) continue;
      const quantity = Math.min(needed, positive(source.quantity));
      if (!quantity) continue;
      suggestions.push({ ...source, quantity, purpose: 'stock_suggestion', basis: 'suggested', order_item_id: order.order_item_id, posting_number: order.posting_number });
      needed -= quantity;
    }
    currentUnmatched += take(needed, order, 'stock_suggestion');
  }
  // Keep all counted goods, including FBP reservations, out of historical proposals.
  const physicalUnmatched = take(positive(snapshot.physical_estimate) - covered, null, 'physical_reserve');
  let historicalUnmatched = 0;
  const history = (snapshot.orders || []).filter(o => o.entered_transport)
    .sort((a, b) => String(a.transport_at || a.ordered_at || '').localeCompare(String(b.transport_at || b.ordered_at || '')) || a.order_item_id - b.order_item_id);
  for (const order of history) historicalUnmatched += take(order.missing_record_quantity, order, 'history_candidate');
  return { suggestions, reserves, current_unmatched: currentUnmatched, physical_unmatched: physicalUnmatched,
    historical_unmatched: historicalUnmatched, unassigned_purchase_quantity: pools.reduce((sum, b) => sum + b.remaining, 0) };
}
