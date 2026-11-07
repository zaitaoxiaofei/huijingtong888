// Valuation consumes the same free/physical projection as the inventory page.
// Do not infer virtual bundle stock here: these rows own actual stock movements.
const numeric = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
export function availableLocalCapitalRows(rows, states) {
  const byId = new Map(states.map(row => [Number(row.product_id), row]));
  return rows.map(row => {
    const state = byId.get(Number(row.product_id));
    const available = numeric(state?.free), physical = numeric(state?.physical_recorded);
    return { ...row, ledger_quantity: Number(row.quantity), physical_quantity: physical,
      available_quantity: available, quantity: available, valuation_basis: 'available',
      order_quantity: numeric(state?.order_quantity), locked_quantity: numeric(state?.locked_quantity),
      safety_quantity: numeric(state?.safety_target), availability_unknown: available == null,
      inventory_value: available == null ? null : available * Number(row.unit_cost || 0) };
  }).filter(row => row.quantity > 0 || row.physical_quantity > 0 || (row.availability_unknown && row.ledger_quantity !== 0));
}
export function localCapitalTotals(rows) {
  const unknown = rows.filter(row => row.availability_unknown).length;
  const quantity = rows.reduce((sum,row) => sum + (row.quantity ?? 0),0);
  const value = rows.reduce((sum,row) => sum + (row.inventory_value ?? 0),0);
  return { quantity: unknown ? null : quantity, value: unknown ? null : value,
    known_quantity: quantity, known_value: value, availability_unknown_count: unknown,
    item_count: rows.length, missing_cost_count: rows.filter(row => Number(row.cost_missing)).length,
    unmapped_count: rows.filter(row => !row.product_id).length,
    unclassified_count: rows.filter(row => Number(row.unclassified_movements)>0).length };
}
