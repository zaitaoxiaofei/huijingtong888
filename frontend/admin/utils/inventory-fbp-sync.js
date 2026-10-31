export async function synchronizeInventoryFbp(api, productId, {
  isCurrent = () => true, onProgress = () => {},
  wait = () => new Promise(resolve => setTimeout(resolve, 1500)), timeoutMs = 300000
} = {}) {
  if (!Number.isSafeInteger(Number(productId)) || Number(productId) <= 0) throw new Error('请选择需要同步的库存');
  const check = () => { if (!isCurrent()) throw Object.assign(new Error('库存或企业上下文已切换'), { name: 'AbortError' }); };
  check();
  let task = await api.post('/api/inventory-flow/sync', { product_id: Number(productId), background: true });
  check();
  const taskId = task.task_id, deadline = Date.now() + timeoutMs;
  if (!taskId) throw new Error('同步任务尚未建立，请重试');
  while (task.running) {
    onProgress('正在同步官方库存');
    if (Date.now() >= deadline) throw new Error('FBP 仍在后台同步，原快照保留；稍后可再次点击同步查看结果');
    await wait(); check();
    task = await api.get(`/api/inventory-flow/sync-status?product_id=${Number(productId)}`, { noCache: true });
    check();
    if (task.task_id !== taskId) throw new Error('同步任务已变更或服务已重启，请重试；原快照保留');
  }
  if (task.error) throw new Error(task.error);
  if (!task.result?.ok) throw new Error((task.result?.results || []).filter(r => !r.ok).map(r => `${r.shop_name || '店铺'}：${r.message}`).join('；') || '官方库存未同步完整，请重试或核对店铺授权');
  onProgress('正在重新核算预测');
  return task.result;
}
