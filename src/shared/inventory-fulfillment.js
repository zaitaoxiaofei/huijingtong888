// Ozon warehouse aliases must never consume the local FBS inventory pool.
export const isFbpInventory = value => ['FBP','FBO','OGR'].includes(String(value || '').trim().toUpperCase());
export const inventoryLocation = value => isFbpInventory(value) ? 'FBP' : 'LOCAL';

export function pendingInventoryOrders(rows = []) {
  const pending = rows.filter(row => Number(row.needs_fulfillment));
  return { order_count: new Set(pending.map(row => row.order_id)).size,
    quantity: pending.reduce((sum,row) => sum + Math.max(0,Number(row.quantity)||0),0) };
}
