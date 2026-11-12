export function isPerformanceRateLimit(error) {
  return Number(error?.statusCode ?? error?.status) === 429
    || /rate.?limit|too many requests/i.test(String(error?.message || ''));
}

export function performanceResponseError(path, response, data, now = Date.now()) {
  const raw = data?.message || data?.error || data?.raw || `HTTP ${response.status}`;
  const message = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
  const retryAfter = response.headers?.get?.('retry-after');
  const seconds = Number(retryAfter);
  const retryAfterMs = retryAfter == null ? 0 : Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter) - now) || 0;
  return Object.assign(new Error(`Performance API ${path} failed: ${message}`), { statusCode: response.status, retryAfterMs });
}

export function createPerformanceReadQueue({ now = Date.now, wait, intervalMs = 1000 } = {}) {
  const shops = new Map();
  return function run(shopId, method, request, { signal } = {}) {
    // Token, report creation, bid/budget changes and campaign operations retain
    // their existing explicit retry/confirmation policy. Only GET is retried here.
    if (method !== 'GET') return request();
    const key = String(shopId || 'unscoped');
    const state = shops.get(key) || { tail: Promise.resolve(), nextAt: 0 };
    shops.set(key, state);
    const check = () => { if (signal?.aborted) throw signal.reason || new Error('广告查询已取消'); };
    const result = state.tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        check(); await wait(Math.max(0, state.nextAt - now()), signal); check();
        state.nextAt = now() + intervalMs;
        try { return await request(); }
        catch (error) {
          if (!isPerformanceRateLimit(error) || attempt >= 2 || signal?.aborted) throw error;
          state.nextAt = Math.max(state.nextAt, now() + Math.max(Number(error.retryAfterMs) || 0, 2000 * (attempt + 1)));
        }
      }
    });
    state.tail = result.catch(() => {});
    return result;
  };
}
