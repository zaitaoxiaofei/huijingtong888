// Only these read endpoints may be retried. Enrollment/price/removal writes
// must never be automatically repeated after an uncertain response.
const READ_PATHS = new Set(['/v1/actions', '/v2/actions/products', '/v2/actions/candidates', '/v1/actions/products', '/v1/actions/candidates']);

export function isPromotionRateLimit(error) {
  return Number(error?.status ?? error?.statusCode) === 429 || /rate.?limit|too many requests/i.test(String(error?.message ?? error ?? ''));
}

function waitForSlot(ms, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(signal.reason || new Error('请求已取消')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });
}

export function createOzonPromotionRequestQueue({ now = Date.now, wait = waitForSlot, intervalMs = 1100 } = {}) {
  const clients = new Map();
  return function run(clientId, path, request, { signal } = {}) {
    if (!READ_PATHS.has(path)) return request();
    const key = String(clientId);
    const state = clients.get(key) || { tail: Promise.resolve(), nextAt: 0 };
    clients.set(key, state);
    const check = () => { if (signal?.aborted) throw signal.reason || new Error('请求已取消'); };
    const result = state.tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        check();
        await wait(Math.max(0, state.nextAt - now()), signal);
        check();
        state.nextAt = now() + intervalMs;
        try { return await request(); }
        catch (error) {
          if (!isPromotionRateLimit(error) || attempt >= 2 || signal?.aborted) throw error;
          const retryAfter = Math.max(0, Number(error.retryAfterMs) || 0);
          state.nextAt = Math.max(state.nextAt, now() + Math.max(retryAfter, 2000 * (attempt + 1)));
        }
      }
    });
    state.tail = result.catch(() => {});
    return result;
  };
}
