import { reactive } from 'vue';
import { apiClient, currentApiCacheScope } from './api.js';
export const productAliases = reactive(new Map());
const pending = new Map();
const revisions = new Map();
export function storeProductAlias(id, value) {
  const key = productAliasKey(id); revisions.set(key, (revisions.get(key) || 0) + 1); productAliases.set(key, { value });
}
let scheduled = false;
export const productAliasKey = id => `${currentApiCacheScope()}:${id}`;
export function loadProductAlias(id) {
  const scope = currentApiCacheScope(), key = productAliasKey(id);
  pending.set(key, { id, scope });
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(async () => {
    scheduled = false;
    const items = [...pending.values()]; pending.clear();
    const ids = [...new Set(items.filter(item => item.scope === currentApiCacheScope()).map(item => item.id))];
    for (let offset = 0; offset < ids.length; offset += 200) {
      const batch = ids.slice(offset, offset + 200), requestScope = currentApiCacheScope();
      const versions = new Map(batch.map(id => [id, revisions.get(`${requestScope}:${id}`) || 0]));
      const unchanged = id => versions.get(id) === (revisions.get(`${requestScope}:${id}`) || 0);
      try {
        const result = await apiClient.get(`/api/inventory-workflow/product-aliases?product_ids=${batch.join(',')}`, { noCache: true });
        if (requestScope !== currentApiCacheScope()) continue;
        const found = new Map(result.rows.map(row => [Number(row.product_id), row.product_alias || '']));
        for (const id of batch) if (unchanged(id)) productAliases.set(`${requestScope}:${id}`, found.has(id) ? { value: found.get(id) } : { error: '商品不可用' });
      } catch (error) {
        if (requestScope === currentApiCacheScope()) for (const id of batch) if (unchanged(id)) productAliases.set(`${requestScope}:${id}`, { error: error.message || '读取失败' });
      }
    }
  });
}
window.addEventListener('erp:auth-scope-changed', () => { productAliases.clear(); pending.clear(); revisions.clear(); });
