const AREAS = new Set(['ordersPagedMysql', 'orderPageRowsMysql', 'orderRowsByIdsMysql']);
const STAGES = new Set([
  'scope', 'schema', 'base', 'filters', 'coverage', 'counts', 'options', 'sort', 'ids', 'rows',
  'query', 'raw', 'fallback', 'enrich', 'logistics', 'inventory', 'picking', 'profit', 'cache',
  'serialize', 'id_selection', 'page_rows', 'core_sql', 'raw_payload', 'quality', 'fbp', 'ogl',
  'billing', 'logistics_dictionary', 'profit_labels', 'logistics_rows', 'inventory_balances', 'metadata'
]);
const COUNTS = ['rows', 'page', 'page_size', 'include_counts', 'include_inventory', 'summary_only', 'total', 'count', 'failed'];

// Marks measure successive intervals; measures have independent intervals and
// can overlap marks or parallel work. Their times must not be added together.
export function createOrderReadDiagnostics(area, { clock = Date.now, logger = console.warn, thresholdMs = 1000 } = {}) {
  let enabled = AREAS.has(area), finished = false;
  const stages = [];
  const now = () => {
    try {
      const value = clock();
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    } catch {}
    enabled = false;
    return 0;
  };
  const started = enabled ? now() : 0;
  let checkpoint = started;
  const threshold = typeof thresholdMs === 'number' && Number.isFinite(thresholdMs) ? Math.max(0, thresholdMs) : 1000;
  const record = (name, beginning) => {
    if (!enabled || finished || !STAGES.has(name)) return;
    const ended = now();
    if (enabled) stages.push({ name, ms: Math.max(0, ended - beginning) });
    return ended;
  };
  return {
    async measure(name, work) {
      if (!enabled || finished || !STAGES.has(name)) return work();
      const beginning = now();
      try { return await work(); }
      finally { record(name, beginning); }
    },
    mark(name) {
      const ended = record(name, checkpoint);
      if (ended !== undefined) checkpoint = ended;
    },
    finish(details = {}) {
      if (finished) return;
      finished = true;
      if (!enabled) return;
      const total_ms = Math.max(0, now() - started);
      if (!enabled || total_ms < threshold) return;
      try {
        const counts = {};
        for (const key of COUNTS) {
          const value = details?.[key];
          if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value) && value >= 0)) counts[key] = value;
        }
        const result = logger(JSON.stringify({ event: 'order_read_slow', area, total_ms, stages, counts }));
        if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
      } catch {}
    }
  };
}
