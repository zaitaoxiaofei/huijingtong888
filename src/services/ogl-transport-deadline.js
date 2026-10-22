const DAY_MS = 24 * 60 * 60 * 1000;

function ruleDays(value, fallback, minimum) {
  if (value == null || String(value).trim() === '') return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= 365 ? number : fallback;
}

export function oglTransportDeadlineRule(env = process.env) {
  const preparationDays = ruleDays(env.OGL_PREPARATION_DAYS, 3, 1);
  const inboundDays = ruleDays(env.OGL_WAREHOUSE_INBOUND_DAYS, 3, 0);
  return { preparation_days: preparationDays, warehouse_inbound_days: inboundDays, total_days: preparationDays + inboundDays };
}

// MySQL DATETIME values are stored as UTC. A date without a known time is not
// precise enough for this deadline and must not silently become midnight.
export function oglTransportDeadlineAt(orderedAt, rule = oglTransportDeadlineRule()) {
  const value = typeof orderedAt === 'string' ? orderedAt.trim() : orderedAt;
  const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z` : value;
  if (!(normalized instanceof Date) && (typeof normalized !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized))) return null;
  const ordered = new Date(normalized).getTime();
  if (!Number.isFinite(ordered)) return null;
  return new Date(ordered + rule.total_days * DAY_MS).toISOString();
}
