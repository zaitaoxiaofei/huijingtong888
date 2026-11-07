export function createCollectionRefreshGate({intervalMs = 20000, clock = Date.now} = {}) {
  let runId = '', completed = -1, refreshedAt = 0;
  return (before, after) => {
    if (!before?.id) return false;
    const now = clock();
    const count = Number(after?.completed_count || 0);
    const ended = !after || !['pending', 'running'].includes(after.status);
    if (!ended && (count === 0 || (runId === before.id && (count === completed || now - refreshedAt < intervalMs)))) return false;
    runId = before.id; completed = count; refreshedAt = now;
    return true;
  };
}
