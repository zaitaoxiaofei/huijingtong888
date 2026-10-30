const number = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value));
const key = row => `${row.shop_id}:${row.ozon_sku}`;

// Official available stock already excludes Ozon reservations. Never subtract
// orders again or add shipped/received stock to this sellable snapshot.
export function fbpSupplyState(forecast, official) {
  const rows = forecast?.skus || [];
  const known = rows.length > 0 && !forecast?.stock_incomplete && !official?.incomplete
    && rows.every(row => [row.available, row.fbp_target, row.per_set_quantity].every(v => number(v) !== null) && Number(row.per_set_quantity) > 0);
  const sum = fn => rows.reduce((total, row) => total + fn(row) * Number(row.per_set_quantity), 0);
  const state = { known, status: 'unknown', available: null, safety: null, shortage: null, in_transit: null, committed: null, replenish_quantity: null, rows: [] };
  if (!known) return state;
  state.rows = rows.map(row => ({ ...row,
    shortage: Math.max(0, Number(row.fbp_target) - Number(row.available)),
    replenish_quantity: Math.max(0, Number(row.fbp_target) - Number(row.available) - (number(row.in_transit) || 0) - (number(row.committed_qty) || 0))
  }));
  state.available = sum(r => Number(r.available));
  state.safety = sum(r => Number(r.fbp_target));
  state.shortage = sum(r => Math.max(0, Number(r.fbp_target) - Number(r.available)));
  state.in_transit = sum(r => number(r.in_transit) || 0);
  state.committed = sum(r => number(r.committed_qty) || 0);
  state.replenish_quantity = state.rows.reduce((total, row) => total + Math.ceil(row.replenish_quantity) * Number(row.per_set_quantity), 0);
  state.status = state.shortage > 0 ? state.replenish_quantity > 0 ? 'warning' : 'in_transit' : 'success';
  return state;
}

// A pending application and the forecast for the same shop/SKU are one need.
// Different shop/SKUs must remain separate even when they share a product.
export function fbpLocalSupplyNeed(applications, fbp) {
  const needs = new Map(); let unkeyed = 0;
  for (const row of applications || []) if (row.status === 'pending_review') {
    const quantity = number(row.requested_quantity) || 0;
    if (row.shop_id && row.ozon_sku) needs.set(key(row), (needs.get(key(row)) || 0) + quantity);
    else unkeyed += quantity;
  }
  if (fbp.known) for (const row of fbp.rows) needs.set(key(row), Math.max(needs.get(key(row)) || 0, Math.ceil(row.replenish_quantity) * Number(row.per_set_quantity)));
  return [...needs.values()].reduce((a,b)=>a+b,0) + unkeyed;
}
