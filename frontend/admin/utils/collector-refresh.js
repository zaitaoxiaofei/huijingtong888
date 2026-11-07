export function collectorCategoryPending(row, now = Date.now()) {
  const issues = row.__qualityIssues || row.quality_issues || [];
  if (!issues.some(issue => /类目/.test(String(issue)))) return false;
  const text = String(row.collected_at || '').trim();
  const date = Date.parse(/^\d{4}-\d\d-\d\d \d\d:/.test(text) ? text.replace(' ', 'T') + 'Z' : text);
  return Number.isFinite(date) && date <= now && now - date < 180000;
}

export function createCollectorRefresh({ refresh, visible, pending, schedule = setTimeout, cancel = clearTimeout }) {
  let timer, stopped = false, running = false, attempts = 0;
  async function tick(force = false) {
    if (stopped || running || !visible() || (!force && (!pending() || attempts >= 24))) return;
    running = true;
    if (!force) attempts++;
    try { await refresh(); } finally { running = false; }
  }
  function loop() {
    timer = schedule(async () => {
      try { await tick(); } finally { if (!stopped) loop(); }
    }, 5000);
  }
  loop();
  return {
    focus() { attempts = 0; return tick(true); },
    stop() { stopped = true; cancel(timer); }
  };
}
