const stamp = value => value ? new Date(typeof value === 'string' && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value.replace(' ', 'T') + 'Z' : value).getTime() : NaN;
export function fbpReceiptEvidence(row, baseline, stock, consumed = 0, now = Date.now()) {
  const remaining = Math.max(0, Number(row.quantity) - Number(row.listed_quantity));
  const known = baseline?.present != null && stock?.present != null && stamp(stock.synced_at) > stamp(baseline.synced_at);
  const inferred = known ? Math.max(0, Number(stock.present) - Number(baseline.present) + Number(consumed)) : null;
  const due = stamp(row.expected_arrival_at) || stamp(row.shipped_at) + 7 * 86400000;
  const overdue = remaining > 0 && Number.isFinite(due) && now > due;
  const suspected = remaining > 0 && inferred > 0;
  return { remaining, baseline_present: baseline?.present ?? null, baseline_at: baseline?.synced_at || null,
    official_present: stock?.present ?? null, official_synced_at: stock?.synced_at || null,
    recorded_consumption: known ? consumed : null, inferred_arrival: inferred,
    suspected, overdue, expected_arrival_at: Number.isFinite(due) ? new Date(due).toISOString() : null,
    review_label: !remaining ? '已逐项确认' : suspected ? (inferred >= Number(row.quantity) ? '疑似已入仓，待确认' : '疑似部分入仓，待确认') : overdue ? '到仓超时，需复核' : !known ? '缺少对比快照，人工核对' : '在途观察中' };
}

