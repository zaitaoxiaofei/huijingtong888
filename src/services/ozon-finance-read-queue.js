const READ_PATHS = new Set(['/v1/finance/accrual/types', '/v1/finance/accrual/by-day', '/v1/finance/accrual/postings']);
const aborted = signal => signal?.reason || new Error('财务查询已取消');
function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(aborted(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer);reject(aborted(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort);resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Process-local pacing for the verified read-only financial POST methods.
// This interval is an internal conservative policy, not an Ozon rate-limit claim.
export function createOzonFinanceReadQueue({ now = Date.now, wait: pause = wait } = {}) {
  const clients = new Map();
  return function run(clientId, path, request, { signal } = {}) {
    if (!String(clientId || '').trim() || !READ_PATHS.has(path)) {
      return Promise.reject(new Error('财务查询队列仅接受已配置店铺的已适配账单读取'));
    }
    const key = String(clientId).trim();
    const state = clients.get(key) || { tail: Promise.resolve(), nextAt: 0 };
    clients.set(key, state);
    const check = () => { if (signal?.aborted) throw aborted(signal); };
    const result = state.tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        check();
        const delay = Math.max(0, state.nextAt - now());
        // Long platform cooldowns must not hold an HTTP request open for minutes.
        // Retain the cooldown and report it; later calls cannot send early either.
        if (delay > 15000) throw Object.assign(new Error(`Ozon 财务接口限流，请至少 ${Math.ceil(delay / 1000)} 秒后重试；已有账单保留。`), {
          statusCode: 429, code: 'OZON_FINANCE_RATE_LIMITED', retryAfterMs: delay, path
        });
        await pause(delay, signal);check();
        state.nextAt = now() + 1100;
        try { return await request(); }
        catch (error) {
          if (Number(error?.statusCode ?? error?.status) !== 429) throw error;
          const retryAfter = Number(error.retryAfterMs);
          state.nextAt = Math.max(state.nextAt, now() + Math.max(Number.isFinite(retryAfter) ? retryAfter : 0, 2000 * (attempt + 1)));
          if (attempt >= 2 || signal?.aborted) throw error;
        }
      }
    });
    // Keep only completion ordering, not the returned financial page in memory.
    state.tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
