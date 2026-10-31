// Partial dashboard updates must never erase a different section that is ready.
export function mergeDashboardSections(current = {}, patch = {}) {
  return {
    ...current,
    ...patch,
    snapshot: { ...current.snapshot, ...patch.snapshot },
    summary: { ...current.summary, ...patch.summary },
    commerce: {
      ...current.commerce,
      ...patch.commerce,
      advertising: { ...current.commerce?.advertising, ...patch.commerce?.advertising }
    },
    alerts: { ...current.alerts, ...patch.alerts }
  };
}
