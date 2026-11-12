import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const read = file => readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
const declarations = (source, name) => source.match(new RegExp('^(?:export )?(?:async )?function ' + name + '\\([^]*?^}', 'm'))[0].replace(/^export /, '');
const sqlSource = read('services/mysql-cutover.js');
const server = read('server.js');
function syncFixture(raw) {
  const logs = [];
  const context = vm.createContext({
    ensureMysqlCutoverEnabled() {}, orderOwnershipTenantScopeMysql: async () => ({ id: 2 }), assertOrderTaskAccessMysql: async () => {},
    syncOzonFinanceRawMysql: async () => ({ from: '2026-10-01', to: '2026-10-01', errors: [], warnings: [], fetched: 0, upserted: 0, shops: [], ...raw }),
    applyOzonFinanceToOrdersMysql: async () => ({ orders: 0, items: 0 }), mysqlExecute: async (sql, args) => logs.push(args)
  });
  vm.runInContext(declarations(sqlSource, 'syncOzonFinanceMysql'), context);
  return { run: () => context.syncOzonFinanceMysql({}, { tenantId: 2 }), logs };
}
test('daily financial sync keeps exclusion warnings in its response and saved status', async () => {
  const f = syncFixture({ warnings: ['Protected old dates require reconciliation'] });
  const result = await f.run();assert.equal(result.status, 'needs_reconciliation');assert.equal(f.logs[0][1], 'needs_reconciliation');
  assert.match(f.logs[0][2], /Protected old dates/);assert.equal(result.warnings.length, 1);
});
test('a successful empty financial read is still successful, while errors take precedence', async () => {
  const f = syncFixture({});assert.equal((await f.run()).status, 'ok');
  const g = syncFixture({ errors: ['partial import failure'], warnings: ['old range'], upserted: 1 });
  assert.equal((await g.run()).status, 'partial_error');
});
function handlerFixture(result) {
  const events = [];
  const context = vm.createContext({ Number, Math, Array, backgroundOzonFinanceSyncRunning: false, BACKGROUND_OZON_FINANCE_SYNC_DAYS: 14,
    claimBackgroundModuleLane: () => false, releaseBackgroundModuleLane() {}, rollingOrderSyncWindow: () => ({ from: '2026-10-01', to: '2026-10-01' }),
    logScheduledJobEvent: async event => events.push(event), runTenantScheduledWork: async () => result, console: { log() {}, error() {} }
  });
  vm.runInContext(declarations(server, 'runBackgroundOzonFinanceSync'), context);
  return { run: () => context.runBackgroundOzonFinanceSync(), events };
}
test('finance scheduled handler reports partial and an actionable warning instead of success', async () => {
  const f = handlerFixture({ errors: [], warnings: ['A: old dates were excluded'], fetched: 0, upserted: 0 });
  const result = await f.run();assert.equal(result.status, 'partial');assert.match(result.warning, /old dates were excluded/);
  assert.equal(f.events.at(-1).status, 'warning');assert.equal(f.events.at(-1).detail.warningCount, 1);
  assert.equal((await handlerFixture({ errors: [], warnings: [] }).run()).status, 'success');
});
test('cross-tenant scheduler preserves warnings with enterprise identity and rechecks active tenants', async () => {
  const calls = [];
  const context = vm.createContext({ Array, Number, Object, String, Error });
  vm.runInContext(declarations(read('services/tenant-scheduled-work.js'), 'runTenantScheduledWork'), context);
  const result = await context.runTenantScheduledWork(async id => ({ warnings: ['Same shop name: incomplete'], fetched: Number(id) }), async (sql, args) => {
    calls.push(args);return args?.length ? [{ id: args[0] }] : [{ id: 2 }, { id: 3 }];
  });
  assert.equal(result.warnings.length, 2);assert.match(result.warnings[0], /#2/);assert.match(result.warnings[1], /#3/);
  assert.equal(result.fetched, 5);assert.equal(calls.length, 3);
});
test('finance task summary retains bounded warnings and their full count', () => {
  const context = vm.createContext({ String, Number, Array, MAX_RESULT_ERRORS: 2, truncateText: (value, limit) => String(value).slice(0, limit) });
  vm.runInContext(declarations(read('services/scheduled-jobs.js'), 'summarizeScheduledJobResult'), context);
  const result = context.summarizeScheduledJobResult('ozon_finance_sync', { status: 'partial', warning: 'Needs reconciliation', warnings: ['A', 'B', 'C'] });
  assert.equal(result.warningCount, 3);assert.deepEqual(Array.from(result.warnings), ['A', 'B']);assert.equal(result.warning, 'Needs reconciliation');
});
