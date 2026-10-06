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

// Procurement details must preserve every inbound batch. A purchase order item
// can be received in several deliveries, each with its own courier and inbound
// confirmation, so it must not share the summary view's de-duplication.
export function orderProcurementRecordDetails(batches = []) {
  return [...batches]
    .map((batch) => {
      const quantity = Number(batch.quantity ?? batch.purchase_quantity ?? 0);
      const amount = Number(batch.amount ?? batch.purchase_amount ?? 0);
      const shippingAmount = Number(batch.shipping_amount ?? batch.purchase_shipping_amount ?? 0);
      const received = Number(batch.purchase_received_quantity ?? (batch.status === "approved" ? quantity : 0));
      return {
        id: Number(batch.id || 0),
        productId: Number(batch.product_id || 0),
        purchaseOrderId: Number(batch.purchase_order_id || 0),
        productName: batch.product_name || "未记录商品",
        unit: batch.stock_unit || "件",
        personName: batch.person_name || "未记录",
        purchaseOrderNo: batch.purchase_order_no || "",
        purchasedAt: batch.purchased_at || batch.created_at || "",
        quantity,
        amount,
        shippingAmount,
        received,
        courierCompany: batch.courier_company || "",
        trackingNumber: batch.tracking_number || "",
        updatedAt: batch.updated_at || "",
        receivedAt: batch.received_at || batch.approved_at || "",
        approvedByPersonName: batch.approved_by_person_name || "未记录",
        status: batch.status || "pending_arrival",
        purchaseMode: batch.purchase_mode || "shortage_purchase"
      };
    })
    .sort((left, right) => {
      const rightTime = new Date(right.purchasedAt || 0).getTime() || 0;
      const leftTime = new Date(left.purchasedAt || 0).getTime() || 0;
      return rightTime - leftTime || right.id - left.id;
    });
}
