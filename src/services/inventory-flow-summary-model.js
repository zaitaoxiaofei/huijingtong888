const number = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);

// Shared read model. Forecasts never post movements or change the ledger revision.
export function buildInventoryFlowSummary(ledger, forecast, orders = [], applications = []) {
  const physical = number(ledger.physical_estimate), demand = number(ledger.open_order_demand), locked = number(ledger.fbp_reserved);
  const complete = forecast && !forecast.stock_incomplete && !forecast.needs_review;
  const safety = complete ? number(forecast.safety_qty) : null;
  const free = [physical, demand, locked, safety].every(value => value !== null) && physical >= 0
    ? Math.max(0, physical - demand - locked - safety) : null;
  return {
    physical, order_demand: demand, locked, safety, free, unoccupied: number(ledger.available_estimate),
    protection_gap: free === null ? null : Math.max(0, demand + locked + safety - physical),
    incoming: number(ledger.incoming_quantity), incoming_assigned: number(ledger.current_incoming),
    order_shortage: number(ledger.current_shortage),
    local_days: forecast?.local_days ?? null, fbp_days: forecast?.fbp_days ?? null,
    safety_status: safety === null ? '待核对 SKU 绑定、官方库存及销量数据' : '预测保障，不含实际订单需求',
    safety_rows: (forecast?.skus || []).map(row => ({ shop_id: row.shop_id, shop_name: row.shop_name,
      ozon_sku: row.ozon_sku, per_set_quantity: row.per_set_quantity, daily_sales: row.daily_sales,
      local_daily_sales: row.local_daily_sales, coverage_days: row.coverage_days,
      available: row.available, synced_at: row.synced_at, status: row.status })),
    orders, applications,
    purchases: (ledger.purchases || []).filter(row => Number(row.pending_quantity) > 0).map(row => ({
      id: row.id, order_no: row.order_no, person_name: row.person_name,
      purchased_at: row.purchased_at, pending_quantity: row.pending_quantity
    })),
    requested: applications.reduce((sum, row) => sum + Number(row.requested_quantity || 0), 0),
    calculated_at: new Date().toISOString()
  };
}

