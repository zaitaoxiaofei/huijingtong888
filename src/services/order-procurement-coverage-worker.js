import {compactProcurementCoverage} from './order-procurement-queues.js';
import { parentPort } from 'node:worker_threads';
import { calculateOrderProcurementCoverage } from './order-procurement-coverage.js';
parentPort.on('message', input => {
  try {
    const full = calculateOrderProcurementCoverage(input);
    const value = input.queuesOnly ? compactProcurementCoverage(full) : full;
    parentPort.postMessage({ entries: [...value], properties: { ...value } });
  }
  catch (error) { parentPort.postMessage({ error: error.message }); }
});
