(function initUnifiedRuntime(global) {
  if (global.OzonUnifiedRuntime) return;
  const collectorTabs = new Set();
  const waitingCollectors = new Set();
  const preparations = [];
  let preparing = false;
  let collectorBadge = { text: '' };
  let analyticsBadge = { text: '' };

  function renderBadge() {
    const action = global.chrome?.action;
    if (!action) return;
    const badge = collectorBadge.text === 'NEW' ? collectorBadge : analyticsBadge.text === 'ON' ? analyticsBadge : { text: '' };
    action.setBadgeText({ text: badge.text || '' });
    if (badge.color) action.setBadgeBackgroundColor({ color: badge.color });
    action.setTitle({ title: '爆单ERP 采集与数据分析' });
  }

  function drainPreparations() {
    if (preparing) return;
    if (!preparations.length) {
      for (const attempt of [...waitingCollectors]) attempt();
      return;
    }
    if (collectorTabs.size) return;
    const entry = preparations.shift();
    preparing = true;
    clearTimeout(entry.timer);
    Promise.resolve().then(entry.run).then(entry.resolve, entry.reject).finally(() => {
      preparing = false;
      drainPreparations();
    });
  }

  global.OzonUnifiedRuntime = {
    tryAcquireCollectorTab(tabId) {
      if (preparing || preparations.length || collectorTabs.has(tabId)) return null;
      collectorTabs.add(tabId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        collectorTabs.delete(tabId);
        drainPreparations();
      };
    },
    withCollectorTab(tabId, run, { timeoutMs = 60000 } = {}) {
      return new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); waitingCollectors.delete(attempt); };
        const attempt = () => {
          const release = global.OzonUnifiedRuntime.tryAcquireCollectorTab(tabId);
          if (!release) return;
          cleanup();
          Promise.resolve().then(run).then(resolve, reject).finally(release);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(Object.assign(new Error('店铺数据同步正在使用 Seller 页面，请稍后重试商品取数'), { code: 'SELLER_TAB_BUSY' }));
        }, timeoutMs);
        waitingCollectors.add(attempt);
        attempt();
      });
    },
    withAnalyticsPreparation(run, { timeoutMs = 60000 } = {}) {
      return new Promise((resolve, reject) => {
        const entry = { run, resolve, reject };
        entry.timer = setTimeout(() => {
          const index = preparations.indexOf(entry);
          if (index < 0) return;
          preparations.splice(index, 1);
          reject(Object.assign(new Error('商品取数仍在执行，请稍后重试店铺数据同步'), { code: 'SELLER_TAB_BUSY' }));
          drainPreparations();
        }, timeoutMs);
        preparations.push(entry);
        drainPreparations();
      });
    },
    setCollectorBadge(value) { collectorBadge = value; renderBadge(); },
    setAnalyticsBadge(value) { analyticsBadge = value; renderBadge(); }
  };
})(globalThis);
