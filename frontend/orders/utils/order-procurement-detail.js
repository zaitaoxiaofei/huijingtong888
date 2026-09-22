// A purchase item can have several receipt batches after partial delivery.
// Keep its original quantity/cost once, independent of this order's coverage.
export function orderPurchaseDetails(batches = []) {
  const purchases = new Map();
  for (const batch of batches) {
    const key = batch.purchase_order_item_id ? `item:${batch.purchase_order_item_id}` : `batch:${batch.id}`;
    if (purchases.has(key)) continue;
    const quantity = Number(batch.purchase_quantity ?? batch.quantity ?? 0);
    const received = Number(batch.purchase_received_quantity ?? (batch.status === 'approved' ? batch.quantity : 0));
    purchases.set(key, {
      key, productId: Number(batch.product_id || 0), productName: batch.product_name || '未记录', unit: batch.stock_unit || '件',
      personName: batch.person_name || '未记录', purchaseOrderNo: batch.purchase_order_no || '未记录',
      purchasedAt: batch.purchased_at || batch.created_at, quantity, received,
      pending: Math.max(0, quantity - received),
      amount: Number(batch.purchase_amount ?? batch.amount ?? 0),
      shippingAmount: Number(batch.purchase_shipping_amount ?? batch.shipping_amount ?? 0),
      purchaseUrl: batch.purchase_url || '', note: batch.purchase_note || '', orderNote: batch.order_note || ''
    });
  }
  return [...purchases.values()];
}
