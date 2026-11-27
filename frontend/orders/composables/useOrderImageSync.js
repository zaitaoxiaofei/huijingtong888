import { onMounted, onScopeDispose, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { currentApiCacheScope } from '../../admin/utils/api.js';
import { syncOrderImages } from '../services/orders-service.js';

export function useOrderImageSync(onSaved) {
  const failed = ref(new Set()), busy = ref(new Set()), revisions = ref(new Map());
  const requests = new Map(); let disposed = false;
  const key = (orderId, itemId, url) => JSON.stringify([Number(orderId), Number(itemId), url || '']);
  function markFailed(orderId, itemId, url) { failed.value = new Set(failed.value).add(key(orderId, itemId, url)); }
  function needsSync(orderId, itemId, url) { return !url || failed.value.has(key(orderId, itemId, url)); }
  function imageKey(orderId, itemId, url) { return `${key(orderId, itemId, url)}:${revisions.value.get(`${Number(orderId)}:${Number(itemId)}`) || 0}`; }
  function reset() {
    for (const request of requests.values()) request.abort();
    requests.clear(); failed.value = new Set(); busy.value = new Set(); revisions.value = new Map();
  }
  async function syncImage(orderId, itemId = 0, platform) {
    const id = Number(orderId); if (!id || busy.value.has(id)) return;
    const scope = currentApiCacheScope(), controller = new AbortController();
    requests.set(id, controller); busy.value = new Set(busy.value).add(id);
    const timeout = window.setTimeout(() => controller.abort(), 60000);
    try {
      const result = await syncOrderImages(id, itemId, { signal: controller.signal, ...(platform === 'wb' ? { platform } : {}) });
      if (disposed || controller.signal.aborted || requests.get(id) !== controller || scope !== currentApiCacheScope()) return;
      await onSaved(result);
      if (disposed || requests.get(id) !== controller || scope !== currentApiCacheScope()) return;
      const usableItems = (result.items || []).filter(item => !item.error && item.image_url);
      if (usableItems.length) {
        const updatedIds = new Set(usableItems.map(item => Number(item.id)));
        if (!Number(itemId)) updatedIds.add(0);
        failed.value = new Set([...failed.value].filter(value => { const [order, item] = JSON.parse(value); return order !== id || !updatedIds.has(item); }));
        const next = new Map(revisions.value);
        for (const item of updatedIds) { const itemKey = `${id}:${item}`; next.set(itemKey, (next.get(itemKey) || 0) + 1); }
        revisions.value = next;
        if (Number(result.updated_count) > 0) ElMessage.success(`已补同步 ${result.updated_count} 张主图`);
        else ElMessage.info('主图地址未变化，已重新加载');
      }
      if (Number(result.failed_count) > 0) ElMessage.warning(result.items?.find(item => item.error)?.error || '部分主图未能补同步，请稍后重试');
      else if (!usableItems.length) ElMessage.info('暂未取得可用主图，请稍后重试');
    } catch (error) {
      if (!disposed && requests.get(id) === controller && scope === currentApiCacheScope()) ElMessage.error(error.name === 'AbortError' ? '补同步主图超时，请重试' : error.message || '补同步主图失败，请重试');
    } finally {
      window.clearTimeout(timeout);
      if (requests.get(id) === controller) { requests.delete(id); const next = new Set(busy.value); next.delete(id); busy.value = next; }
    }
  }
  onMounted(() => window.addEventListener('erp:auth-scope-changed', reset));
  onScopeDispose(() => { disposed = true; reset(); window.removeEventListener('erp:auth-scope-changed', reset); });
  return { busy, markFailed, needsSync, imageKey, syncImage };
}
