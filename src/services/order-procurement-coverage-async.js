import { Worker } from 'node:worker_threads';
import { calculateOrderProcurementCoverage } from './order-procurement-coverage.js';
let tail = Promise.resolve();

// Full enterprise reconciliation can occupy the API event loop for seconds.
// Limit heavy calculations to one worker per process; ordinary saves stay local.
export function calculateOrderProcurementCoverageAsync(input) {
  if (input.demands.length < 1000) return Promise.resolve(calculateOrderProcurementCoverage(input));
  const task = tail.catch(() => {}).then(() => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./order-procurement-coverage-worker.js', import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('采购需求核算超时，请稍后重试')), 30000);
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!finished) finish(new Error(`采购需求核算进程退出（${code}）`)); });
    worker.once('message', result => finish(result.error ? new Error(result.error) : null,
      result.error ? undefined : Object.assign(new Map(result.entries), result.properties)));
    try { worker.postMessage(input); } catch (error) { finish(error); }
  }));
  tail = task.then(() => undefined, () => undefined);
  return task;
}
