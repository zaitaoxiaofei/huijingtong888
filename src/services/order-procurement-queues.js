export const PROCUREMENT_QUEUES = ['pending_purchase','purchase_in_transit','purchase_records_missing'];
export function procurementQueueOrderIds(coverage, status) {
  if (coverage.queue_ids && Object.hasOwn(coverage.queue_ids,status)) return coverage.queue_ids[status];
  return [...coverage.values()].filter(row => row.stock_location !== 'FBP').filter(row => status === 'pending_purchase'
    ? row.needs_fulfillment && row.items.some(item => item.product_id > 0 && (item.actionable_shortage_quantity ?? item.shortage_quantity) > 0)
    : status === 'purchase_in_transit' ? row.incoming_quantity > 0 || row.quantity_needs_review
      : row.entered_transport && (row.missing_record_quantity > 0 || row.missing_amount || row.quantity_needs_review))
    .map(row => Number(row.order_id)).filter(Number.isSafeInteger);
}
// Only the queue membership is needed by metadata SQL; keep complete receipt
// and allocation details inside the worker unless a detail caller asks for them.
export function compactProcurementCoverage(value) {
  return Object.assign(new Map(), {queue_ids:Object.fromEntries(PROCUREMENT_QUEUES.map(status=>[status,procurementQueueOrderIds(value,status)]))});
}
