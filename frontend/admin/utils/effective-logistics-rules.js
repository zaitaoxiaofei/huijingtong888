function parseBeijingDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
    ? text
    : `${text.replace(" ", "T")}+08:00`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isLogisticsRuleEffective(rule, at = new Date()) {
  if (!rule || Number(rule.enabled ?? 1) === 0) return false;
  const timestamp = parseBeijingDateTime(at)?.getTime() ?? null;
  if (!Number.isFinite(timestamp)) return false;
  const effectiveFrom = parseBeijingDateTime(rule.effective_from)?.getTime() ?? null;
  const effectiveTo = parseBeijingDateTime(rule.effective_to)?.getTime() ?? null;
  return (effectiveFrom === null || effectiveFrom <= timestamp)
    && (effectiveTo === null || timestamp < effectiveTo);
}

export function currentEffectiveLogisticsRules(rules = [], at = new Date()) {
  const effective = rules.filter((rule) => isLogisticsRuleEffective(rule, at));
  const byGroup = new Map();
  for (const rule of effective) {
    const groupId = Number(rule.version_group_id || rule.id || 0);
    const current = byGroup.get(groupId);
    const currentFrom = parseBeijingDateTime(current?.effective_from)?.getTime() ?? -Infinity;
    const candidateFrom = parseBeijingDateTime(rule.effective_from)?.getTime() ?? -Infinity;
    if (!current || candidateFrom > currentFrom || (candidateFrom === currentFrom && Number(rule.id || 0) > Number(current.id || 0))) {
      byGroup.set(groupId, rule);
    }
  }
  return [...byGroup.values()];
}

export function resolveCurrentLogisticsRule(rules = [], selectedRuleId, at = new Date()) {
  const selected = rules.find((rule) => Number(rule.id) === Number(selectedRuleId));
  if (!selected) return null;
  const groupId = Number(selected.version_group_id || selected.id || 0);
  return currentEffectiveLogisticsRules(rules, at)
    .find((rule) => Number(rule.version_group_id || rule.id || 0) === groupId) || null;
}
