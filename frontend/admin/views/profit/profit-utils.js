export function formatMoney(value) {
  return Number(value || 0).toFixed(2);
}

export function formatInteger(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

export function formatDelta(value) {
  const amount = Number(value || 0);
  if (amount > 0) return `+${amount.toFixed(2)}`;
  if (amount < 0) return amount.toFixed(2);
  return "0.00";
}

export function formatPercent(numerator, denominator) {
  const base = Number(denominator || 0);
  if (!base) return "0.0%";
  return `${((Number(numerator || 0) / base) * 100).toFixed(1)}%`;
}

export function formatShortDate(value) {
  return String(value || "").slice(5, 10);
}

export function formatMonthLabel(value) {
  return String(value || "").slice(0, 7);
}

export function buildComparison(current = {}, previous = {}) {
  return {
    orderDelta: Number(current.order_count || 0) - Number(previous.order_count || 0),
    revenueDelta: Number(current.revenue || 0) - Number(previous.revenue || 0),
    profitDelta: Number(current.profit || 0) - Number(previous.profit || 0),
    effectiveOrderDelta: Number(current.effective_orders || 0) - Number(previous.effective_orders || 0)
  };
}
