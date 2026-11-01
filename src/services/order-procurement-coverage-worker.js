import { parentPort } from 'node:worker_threads';
import { calculateOrderProcurementCoverage } from './order-procurement-coverage.js';
parentPort.on('message', input => {
  try {
    const value = calculateOrderProcurementCoverage(input);
    parentPort.postMessage({ entries: [...value], properties: { ...value } });
  }
  catch (error) { parentPort.postMessage({ error: error.message }); }
});
