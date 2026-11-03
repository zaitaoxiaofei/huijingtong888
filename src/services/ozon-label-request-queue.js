// Share the same per-client limiter between background prefetch and interactive printing.
export function createOzonLabelRequestQueue({ now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), intervalMs = 1100 } = {}) {
  const clients = new Map();
  return async function run(clientId, request, { signal } = {}) {
    const key = String(clientId);
    const state = clients.get(key) || { tail: Promise.resolve(), nextAt: 0 };
    clients.set(key, state);
    const check = () => { if (signal?.aborted) throw signal.reason || new Error('面单下载已取消'); };
    const result = state.tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        check();
        await wait(Math.max(0, state.nextAt - now()));
        check();
        state.nextAt = now() + intervalMs;
        try { return await request(); }
        catch (error) {
          if (!(Number(error?.statusCode) === 429 || /rate limit|too many requests/i.test(error?.message || '')) || attempt >= 2) throw error;
          state.nextAt = Math.max(state.nextAt, now() + Math.max(Number(error.retryAfterMs) || 0, 2000 * (attempt + 1)));
        }
      }
    });
    state.tail = result.catch(() => {});
    return result;
  };
}
