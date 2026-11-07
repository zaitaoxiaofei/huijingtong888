// Keep daily dispatch connected to an online collector while this monitor is open.
export function createDailyTrafficMonitor({refresh, wake, busy = () => false, schedule = setInterval, cancel = clearInterval}) {
  let timer = null, running = false, stopped = false;
  async function check() {
    if (stopped || running || busy()) return;
    running = true;
    try {
      await refresh();
      if (!stopped) wake();
    } finally { running = false; }
  }
  function start() {
    if (stopped || timer !== null) return;
    timer = schedule(() => { void check().catch(() => {}); }, 60000);
    void check().catch(() => {});
  }
  function stop() {
    stopped = true;
    if (timer !== null) cancel(timer);
    timer = null;
  }
  return {start, stop, check};
}
