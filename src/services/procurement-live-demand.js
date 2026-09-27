// Read-only projections: a missing request must not hide an order's actual shortage.
export function supplementLiveProcurementRows(rows, coverage) {
  const metadata = new Map(rows.map(row => [Number(row.product_id), row]));
  const actionable = new Set(rows.filter(row => ['pending', 'suggested', 'submitted'].includes(row.status)
    && !['purchased', 'partial_inbound', 'inbound_done'].includes(row.purchase_order_status)
    && row.operational_needs_fulfillment !== false).map(row => Number(row.product_id)));
  const extra = [];
  for (const order of coverage.values()) {
    if (!order.needs_fulfillment || order.stock_location === 'FBP') continue;
    for (const item of order.items) {
      const productId = Number(item.product_id);
      if (!(item.shortage_quantity > 0) || !metadata.has(productId) || actionable.has(productId)) continue;
      const product = metadata.get(productId);
      extra.push({ ...product, id: 0, product_id: productId, status: 'suggested', demand_type: 'real_order',
        purchase_order_id: null, purchase_order_status: '', person_id: null, person_name: '',
        source_order_id: order.order_id, source_order_item_id: item.order_item_id,
        source_posting_number: order.posting_number, operational_needs_fulfillment: true,
        quantity: item.shortage_quantity, amount: 0, shipping_amount: 0,
        created_at: order.transport_at, updated_at: order.transport_at, live_order_demand: true });
    }
  }
  return [...rows.filter(row => row.id), ...extra];
}
