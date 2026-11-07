import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { withMysqlWorkload } from '../../src/mysql-workload.js';

const source = readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
const fn = name => {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
export function credentialSchedulerFixture({ now: initial = Date.now(), check = async () => ({ checked: 1 }), runTenant = run => run('1') } = {}) {
  let now = initial, pressure = false;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({ Date: Clock, Math, Number, String, Set, console: { log() {} }, withMysqlWorkload,
    BACKGROUND_TASK_FOREGROUND_IDLE_MS: 20000, BACKGROUND_CRITICAL_JOB_MAX_DEFERRAL_MS: 300000,
    activeForegroundApiRequests: 1, lastForegroundApiAt: now,
    getMysqlPoolMetrics: () => ({ activeConnections: pressure ? 8 : 0, connectionLimit: 10 }),
    runTenantScheduledWork: runTenant, checkTenantOzonHealth: check });
  vm.runInContext(`${source.match(/const FOREGROUND_DEFERRAL_BOUNDED_JOBS = new Set\(\[[^]*?\]\);/)[0]}
    let oglMonitorFirstDueAt=0,dailyFxArchiveFirstDueAt=0;
    ${['criticalJobForegroundDeferralExpired', 'foregroundApiDeferral', 'databasePoolDeferral', 'backgroundJobDeferral', 'withForegroundApiDeferral'].map(fn).join('\n')}`, context);
  const handler = source.match(/ozon_credential_health: (withForegroundApiDeferral\([^\n]+),\n/)[1];
  const start = source.indexOf('  beforeRun: ({ key, mode, plannedFor');
  const before = source.slice(start, source.indexOf('  pollIntervalMs:', start)).trim().replace(/^beforeRun: /, '').replace(/,$/, '');
  vm.runInContext(`globalThis.handler=${handler};globalThis.beforeRun=${before};`, context);
  return { context, handler: context.handler, beforeRun: context.beforeRun, advance: ms => { now += ms; }, pressure: value => { pressure = value; }, now: () => new Date(now) };
}
