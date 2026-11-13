const HOSTS = Object.freeze({
  marketplace: 'marketplace-api', content: 'content-api', prices: 'discounts-prices-api', calendar: 'dp-calendar-api', common: 'common-api'
});
const queues = new Map();
const nextAt = new Map();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createWbClient({ fetchImpl = fetch, sleep = wait, now = Date.now } = {}) {
  return async function request(account, service, path, { method = 'GET', body, query, signal, beforeRequest } = {}) {
    if (!HOSTS[service] || !path.startsWith('/') || path.startsWith('//') || path.includes('://')) throw new Error('WB 接口地址无效');
    if (!account?.token) throw Object.assign(new Error('缺少 WB API 授权，请到企业店铺编辑该 WB 店铺，填写 API Token 并检查授权。'), { statusCode: 409 });
    const readOnly=method==='GET'||(method==='POST'&&(['/api/v3/orders/status','/api/v3/orders/stickers','/content/v2/get/cards/list','/content/v2/get/cards/trash','/content/v2/cards/error/list'].includes(path)||/^\/api\/v3\/stocks\/\d+$/.test(path)));
    const environment = account.environment || 'production';
    if (!['production', 'sandbox'].includes(environment)) throw new Error('WB 接口环境无效');
    if (environment === 'sandbox' && ['calendar', 'common'].includes(service)) throw Object.assign(new Error('该 WB 能力未启用沙箱，请使用有对应权限的正式店铺。'), { statusCode: 409 });
    const base = `${HOSTS[service]}${environment === 'sandbox' ? '-sandbox' : ''}.wildberries.cn`;
    const url = new URL(`https://${base}${path}`);
    for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null && value !== '') {
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
    }
    const key = `${account.tenant_id}:${account.shop_id}:${environment}:${service}`;
    const prior = queues.get(key) || Promise.resolve();
    const run = prior.catch(() => {}).then(async () => {
      const delay = (nextAt.get(key) || 0) - now();
      if (delay > 10000) throw Object.assign(new Error('WB 请求额度尚未恢复，请稍后再试。'), { statusCode:429 });
      if (delay > 0) await sleep(delay);
      signal?.throwIfAborted();
      await beforeRequest?.();
      signal?.throwIfAborted();
      nextAt.set(key, now() + 1100);
      let response;
      try {
        response = await fetchImpl(url, { method, headers: { Authorization: account.token, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), redirect: 'error' });
      } catch {
        throw Object.assign(new Error(readOnly ? 'WB 接口暂未返回，请稍后重试。' : 'WB 未返回操作结果，请先同步核对平台状态，避免重复提交。'), { statusCode: 502, code: 'WB_RESULT_UNKNOWN' });
      }
      if (response.status === 429) {
        const retry = Math.max(1, Number(response.headers.get('X-Ratelimit-Retry') || response.headers.get('Retry-After') || 60));
        nextAt.set(key, now() + (Number.isFinite(retry) ? retry : 60) * 1000);
        throw Object.assign(new Error(`WB 请求频率受限，请稍后再试；本次未自动重发。`), { statusCode: 429 });
      }
      if (!response.ok) {
        const hint = response.status === 401 ? '授权已失效，请更新店铺 Token。' : response.status === 403 ? '授权权限或店铺履约资格不足，请核对 Token 类别及卖家后台。' : response.status === 409 ? '平台状态或必填标识不满足操作条件，请同步订单并核对报关及商品标识。' : `接口返回 ${response.status}，请核对商品、仓库或订单状态。`;
        throw Object.assign(new Error(`WB ${hint}`), { statusCode: response.status >= 500 ? 502 : response.status });
      }
      if (response.status === 204) return {};
      const text = await response.text();
      if (!text) return {};
      try { const value=JSON.parse(text); if(value?.error===true)throw Object.assign(new Error('WB 未接受该请求，请检查平台返回的业务状态。'),{statusCode:409}); return value; } catch(error) { if(error.statusCode)throw error; throw Object.assign(new Error('WB 返回格式异常，请稍后同步核对。'), { statusCode: 502 }); }
    });
    queues.set(key, run);
    try { return await run; } finally { if (queues.get(key) === run) queues.delete(key); }
  };
}
export const wbRequest = createWbClient();
