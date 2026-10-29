import { cleanupCollectorHistory } from '../src/services/collector-history-retention.js';
import { closeMysqlPool } from '../src/mysql-pool.js';
const args=process.argv.slice(2);
if(args.some(arg=>arg!=='--apply'))throw new Error('Usage: node --env-file=.env scripts/cleanup-collector-history.mjs [--apply]');
try { console.log(JSON.stringify(await cleanupCollectorHistory({apply:args.includes('--apply')}),null,2)); }
finally { await closeMysqlPool(); }
