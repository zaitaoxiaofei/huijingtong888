import { createHash } from 'node:crypto';

const bucket = (limit = null, usage = null) => ({ limit, usage, remaining: limit === null || usage === null ? null : Math.max(0, limit - usage), reset_at: '' });
const invalid = () => Object.assign(new Error('WB 商品卡额度或分页数据不完整，请稍后刷新；未使用本地商品数量估算余额。'), { statusCode: 502 });
const integer = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// Limits are capacities, not remaining balances. Both live and trashed nmIDs
// consume capacity. Keep the expensive complete census off the HTTP read path.
export function createWbCardLimitsReader({ now = Date.now, ttl = 5 * 60 * 1000 } = {}) {
  const cache = new Map();
  return async function read(account, request) {
    const key = createHash('sha256').update(JSON.stringify([account.tenant_id, account.shop_id, account.environment, account.seller_id, account.token])).digest('hex');
    let entry = cache.get(key);
    if (!entry || now() - entry.started >= ttl && !entry.refreshing) {
      if (cache.size >= 100) {
        const disposable = [...cache].find(([, value]) => !value.refreshing);
        if (disposable) cache.delete(disposable[0]);
        else throw Object.assign(new Error('WB 额度正在核对，请稍后刷新。'), { statusCode: 429 });
      }
      entry = { started: now(), refreshing: true, value: null, error: '', task: null };
      cache.set(key, entry);
      // Coalesce concurrent reads before the first platform response arrives.
      entry.ready = (async () => {
        const result = await request(account, 'content', '/content/v2/cards/limits');
        if (result?.error === true || !integer(result?.data?.freeLimits) || !integer(result?.data?.paidLimits)) throw invalid();
        const { freeLimits, paidLimits } = result.data;
        if (!Number.isSafeInteger(freeLimits + paidLimits)) throw invalid();
        entry.value = { endpoint: '/content/v2/cards/limits', total: bucket(freeLimits + paidLimits), free_limit: freeLimits, paid_limit: paidLimits,
          daily_create: bucket(), daily_update: bucket(), daily_note: 'WB 商品卡额度接口未提供每日上新或更新额度，请到 WB 卖家后台核对。',
          fetched_at: new Date(now()).toISOString(), usage_fetched_at: '', usage_error: '' };
        entry.task = census().catch(() => { entry.value.usage_error = '已用数量核对未完成，请稍后刷新或到 WB 后台核对；总额度仍可查看。'; }).finally(() => { entry.refreshing = false; entry.started = now(); });
        async function census() {
          const signal = AbortSignal.timeout(15 * 60 * 1000), ids = new Set();
          for (const [path, timeKey] of [['/content/v2/get/cards/list', 'updatedAt'], ['/content/v2/get/cards/trash', 'trashedAt']]) {
            let cursor = { limit: 100 };
            const cursors = new Set();
            for (let page = 0; ; page++) {
              if (page >= 20000) throw invalid();
              signal.throwIfAborted();
              const settings = { sort: { ascending: true }, cursor, ...(timeKey === 'updatedAt' ? { filter: { withPhoto: -1 } } : {}) };
              const result = await request(account, 'content', path, { method: 'POST', body: { settings }, signal });
              if (result?.error === true || !Array.isArray(result?.cards) || !integer(result?.cursor?.total) || result.cursor.total !== result.cards.length || result.cards.length > 100) throw invalid();
              for (const card of result.cards) {
                if (!integer(card.nmID) || card.nmID === 0) throw invalid();
                ids.add(card.nmID);
              }
              if (result.cursor.total < 100) break;
              const next = result.cursor;
              const marker = JSON.stringify([next[timeKey], next.nmID]);
              if (!next[timeKey] || !integer(next.nmID) || !next.nmID || cursors.has(marker)) throw invalid();
              cursors.add(marker);
              cursor = { limit: 100, [timeKey]: next[timeKey], nmID: next.nmID };
            }
          }
          entry.value.total = bucket(freeLimits + paidLimits, ids.size);
          entry.value.usage_fetched_at = new Date(now()).toISOString();
        }
      })().catch(error => { cache.delete(key); throw error; });
    }
    await entry.ready;
    return { ...entry.value, refreshing: entry.refreshing };
  };
}
export const readWbCardLimits = createWbCardLimitsReader();
