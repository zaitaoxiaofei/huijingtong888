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

let interactiveReads = 0;
const interactiveWaiters = new Set();
// Ordinary row reads do not depend on the background coverage calculation.
// Let an already running scan finish, then pause new scans until rows return.
export async function withMysqlInteractiveRead(operation) {
  interactiveReads++;
  try { return await operation(); }
  finally {
    if (--interactiveReads === 0) {
      for (const resume of interactiveWaiters) resume();
      interactiveWaiters.clear();
    }
  }
}
export async function waitForMysqlInteractiveReads() {
  if (currentMysqlWorkload() !== 'background' || !interactiveReads) return;
  // Bound the delay so a continuous stream of readers cannot starve workers.
  await new Promise(resolve => {
    const resume = () => { clearTimeout(timer); interactiveWaiters.delete(resume); resolve(); };
    const timer = setTimeout(resume, 2000);
    interactiveWaiters.add(resume);
  });
}

let backgroundReadTail = Promise.resolve();
// Queue background reads before acquiring a pooled connection. Waiting for
// interactive rows must not consume other background reads' acquire timeout.
export function withMysqlBackgroundReadAdmission(operation) {
  if (currentMysqlWorkload() !== 'background') return operation();
  const task = backgroundReadTail.catch(() => {}).then(operation);
  backgroundReadTail = task.then(() => undefined, () => undefined);
  return task;
}
