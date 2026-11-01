import { AsyncLocalStorage } from 'node:async_hooks';

const workload = new AsyncLocalStorage();
export function currentMysqlWorkload() {
  return workload.getStore() === 'background' ? 'background' : 'foreground';
}
export function withMysqlWorkload(priority, operation) {
  return workload.run(priority === 'background' ? 'background' : 'foreground', operation);
}

// Divide the existing budget rather than creating extra database connections.
export function mysqlWorkloadLimits(total) {
  const background = total > 1 ? Math.max(1, Math.floor(total / 3)) : 0;
  return { foreground: total - background, background };
}
