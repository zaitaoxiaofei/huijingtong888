const number = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value));
const key = row => `${row.shop_id}:${row.ozon_sku}`;

// Official available stock already excludes Ozon reservations. Never subtract
// orders again or add shipped/received stock to this sellable snapshot.
export function fbpSupplyState(forecast, official) {
  const rows = forecast?.skus || [];
  const known = rows.length > 0 && !forecast?.stock_incomplete && !official?.incomplete
    && rows.every(row => [row.available, row.fbp_target, row.per_set_quantity].every(v => number(v) !== null) && Number(row.per_set_quantity) > 0);
  const sum = fn => rows.reduce((total, row) => total + fn(row) * Number(row.per_set_quantity), 0);
  const missing = rows.filter(row => number(row.available) === null).length;
  const reason = !rows.length ? '未绑定可核算SKU' : missing ? `缺少 ${missing} 个SKU的FBP库存快照，请同步官方库存` : forecast?.stock_incomplete||official?.incomplete ? '官方FBP库存快照不完整，请同步官方库存' : !known ? 'SKU组成或预测目标待核实，请查看预测明细' : '';
  // Physical stock is a fact independent of the sales target. Available stock
  // excludes official reservations and must not be relabelled as physical stock.
  const physical = !forecast?.stock_incomplete && !official?.incomplete && rows.length
    ? number(forecast?.official_qty) ?? (rows.every(r => number(r.present) !== null && number(r.per_set_quantity) > 0) ? sum(r => Number(r.present)) : null) : null;
  const state = { known, physical, unknown_reason: reason, sku_count: rows.length, missing_stock_count: missing, status: 'unknown', available: null, safety: null, shortage: null, in_transit: null, committed: null, replenish_quantity: null, rows: [] };
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

// Remaining prediction per shop/SKU. Submitted units replace the same-SKU
// forecast, never another shop's deficit. Quantities for application are sets.
export function fbpForecastSuggestions(applications,fbp){
 if(!fbp?.known)return [];
 const pending=new Map();
 for(const r of applications||[])if(r.status==='pending_review'&&r.shop_id&&r.ozon_sku)pending.set(key(r),(pending.get(key(r))||0)+(number(r.requested_quantity)||0));
 return fbp.rows.map(r=>{const units=Number(r.per_set_quantity),submitted=pending.get(key(r))||0,remaining=Math.max(0,Math.ceil(r.replenish_quantity)*units-submitted);return{...r,pending_physical:submitted,forecast_physical:remaining,suggested_application_qty:Math.ceil(remaining/units)};});
}
