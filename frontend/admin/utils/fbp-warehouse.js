export function labelTarget(row) {
  if (row?._sourceItems?.length) return row._sourceItems.reduce((sum, item) => sum + labelTarget(item), 0);
  const qty = Math.max(0, Number(row?.final_qty ?? row?.approved_qty ?? row?.requested_qty ?? 0));
  return qty > 0 && row?.order?.status !== 'cancelled' ? qty + 2 : 0;
}
export function remainingLabels(row) {
  if (row?._sourceItems?.length) return row._sourceItems.reduce((sum, item) => sum + remainingLabels(item), 0);
  return Math.max(0, labelTarget(row) - Number(row?.barcode_printed_qty || 0));
}
export function buildWarehouseRows(orders) {
  const grouped = new Map();
  for (const order of orders) for (const item of order.items || []) {
    const key = String(item.product_id || item.inventory_id || item.inventory_number || `unmapped:${item.id}`);
    if (!grouped.has(key)) grouped.set(key, { inventory_key: key, inventory_id: item.inventory_number || item.inventory_id || '未映射库存',
      product_name: item.product_name, image_url: item.image_url, warehouse: item.warehouse,
      final_qty: 0, pending_dispatch_qty: 0, pending_receipt_qty: 0, printed_qty: 0, target_labels: 0, items: [] });
    const row = grouped.get(key), detail = { ...item, order };
    const qty = Math.max(0, Number(item.final_qty ?? item.approved_qty ?? 0));
    if (order.status !== 'cancelled') row.final_qty += qty;
    if (['approved', 'ozon_created'].includes(order.status)) row.pending_dispatch_qty += qty;
    row.printed_qty += Number(item.barcode_printed_qty || 0);
    row.target_labels += labelTarget(detail);
    row.items.push(detail);
  }
  for (const row of grouped.values()) {
    const facts = row.warehouse;
    row.local_stock = facts ? Math.max(0, facts.ledger_stock - Math.max(0, facts.reserved_fbp - row.pending_dispatch_qty)) : null;
    row.procurement_incoming = facts?.procurement_incoming;
    row.pending_receipt_qty = facts?.fbp_pending;
    row.last_shipped_qty = facts?.last_shipped_qty;
    row.last_shipped_at = facts?.last_shipped_at;
  }
  return [...grouped.values()].sort((a, b) => String(a.inventory_id).localeCompare(String(b.inventory_id)));
}
