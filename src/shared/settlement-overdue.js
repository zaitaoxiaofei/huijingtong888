export const SETTLEMENT_OVERDUE_DAYS = 30;
export function settlementOverdue(row, now = Date.now()) {
  if (String(row.profit_status || row.settlement_state || '').toLowerCase() === 'accrued') return false;
  const raw = row.delivered_at;
  if (!raw) return false;
  const value = raw instanceof Date ? raw.toISOString() : String(raw);
  const delivered = Date.parse(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/.test(value) && !/(?:Z|[+-]\d\d:?\d\d)$/.test(value) ? value.replace(' ', 'T') + 'Z' : value);
  return Number.isFinite(delivered) && now - delivered > SETTLEMENT_OVERDUE_DAYS * 86400000;
}
