export function vehicleTargetKey(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function parseQuickTargets(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[,\n;，；、|]+/);
  const seen = new Set();
  return values.map(item => String(item || "").trim()).filter(item => {
    const key = vehicleTargetKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function quickTargetHistory(target, history = []) {
  const key = vehicleTargetKey(target);
  return history.find(item => vehicleTargetKey(item.target_value) === key) || null;
}

export function quickTargetsFromQuery(query = {}) {
  if (query.caseTargetValues === undefined) return null;
  try {
    const values = JSON.parse(String(query.caseTargetValues));
    return Array.isArray(values) && values.every(value => typeof value === "string") ? parseQuickTargets(values) : [];
  } catch {
    return [];
  }
}

export function availableQuickTargets(models, source, history = []) {
  return parseQuickTargets(models.map(model => model.fullName)).filter(target => {
    const status = quickTargetHistory(target, history)?.status;
    return vehicleTargetKey(target) !== vehicleTargetKey(source) && !["completed", "in_progress"].includes(status);
  });
}
