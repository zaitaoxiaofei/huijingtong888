import { AsyncLocalStorage } from 'node:async_hooks';

const workload = new AsyncLocalStorage();
export function currentMysqlWorkload() {
  return workload.getStore() === 'background' ? 'background' : 'foreground';
}
export function withMysqlWorkload(priority, operation) {
  return workload.run(priority === 'background' ? 'background' : 'foreground', operation);
}

// Keep background scans serial: parallel ledger/history reads compete with
// interactive paging for database CPU and I/O even in separate pools.
// Divide the existing connection budget without adding connections.
export function mysqlWorkloadLimits(total) {
  const background = total > 1 ? 1 : 0;
  return { foreground: total - background, background };
}

let backgroundTransactionTail = Promise.resolve();
// Transactions keep their existing foreground connection and nested-read
// behavior, but scheduled writers must not fan out across that entire pool.
export function withMysqlTransactionPriority(operation) {
  const run = () => withMysqlWorkload('foreground', operation);
  if (currentMysqlWorkload() !== 'background') return run();
  const task = backgroundTransactionTail.catch(() => {}).then(run);
  backgroundTransactionTail = task.then(() => undefined, () => undefined);
  return task;
}
