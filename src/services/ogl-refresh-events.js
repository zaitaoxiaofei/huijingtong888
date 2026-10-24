function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

// These are observations. Creation, confirmation, physical handover, withdrawal
// and every other business action must always remain separate audit events.
export function unchangedOglObservation(action, previous, details) {
  if (!["refresh", "official-sync"].includes(action) || previous == null) return false;
  let parsed = previous;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return false; }
  }
  return JSON.stringify(canonical(parsed)) === JSON.stringify(canonical(details));
}
