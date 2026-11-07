const number = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
export function inventoryLocalEvidence(ledger = {}) {
  const action = ledger.stocktake_evidence || (ledger.actions || []).find(a => a.action_type === 'stocktake');
  let result = action?.result_json;
  if (typeof result === 'string') { try { result = JSON.parse(result); } catch { result = null; } }
  const counted = number(result?.physical_after ?? result?.counted_quantity);
  const book = number(ledger.physical_estimate);
  return {
    physical_quantity: book != null && book >= 0 ? book : null,
    book_quantity: book, ledger_quantity: number(ledger.local_stock),
    pending_deducted_quantity: number(ledger.open_order_deducted),
    last_counted_quantity: counted, last_counted_at: action?.created_at || null,
    change_since_count: book != null && counted != null ? book - counted : null,
    requires_count: book == null || book < 0
  };
}
