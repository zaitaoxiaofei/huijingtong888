export function summarizeOrderSyncResult(result = {}) {
  const shops = Array.isArray(result.shops) ? result.shops : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const failedShopCount = shops.filter((shop) => shop?.error).length || errors.length;
  const firstError = String(errors[0] || shops.find((shop) => shop?.error)?.error || "未知原因");
  return {
    insertedOrders: shops.reduce((total, shop) => total + Number(shop?.inserted || 0), 0),
    failedShopCount,
    failureReason: firstError.length > 120 ? `${firstError.slice(0, 120)}…` : firstError
  };
}

// A complete posting number can be fetched even if no local child row exists.
export function exactPostingNumbers(searchType, value) {
  if (searchType !== 'order') return [];
  const numbers = [...new Set(String(value || '').trim().split(/[\s,;，；]+/).filter(Boolean))];
  return numbers.length && numbers.length <= 20 && numbers.every(number => /^\d+-\d+-\d+$/.test(number)) ? numbers : [];
}

// A start response has `queued`; later snapshots intentionally do not.
// Only the task's running state and final result determine completion.
export async function waitForOrderSyncTask(started, { wait, fetchStatus, onProgress }) {
  const taskId = String(started?.task_id || "");
  if (!taskId) throw new Error("订单同步未返回任务 ID，请刷新后核对同步状态");
  let task = started;
  while (task?.running) {
    const progress = task.progress || {};
    const fetched = Number(progress.fetched || 0);
    onProgress(`${progress.message || "订单同步已启动，正在获取进度…"}${fetched > 0 ? ` 已拉取 ${fetched} 单。` : ""}任务仍在执行，完成后显示最终数量。`);
    await wait();
    const status = await fetchStatus();
    if (String(status?.task_id || "") !== taskId) {
      throw new Error("同步任务状态已变化，可能因服务重启或其他页面启动了新任务；请刷新核对订单，本次不报同步成功");
    }
    task = status;
  }
  if (task?.error) throw new Error(task.error);
  if (!task?.result || typeof task.result !== "object") {
    throw new Error("尚未取得本次同步的最终结果，请刷新核对同步状态");
  }
  return task;
}
