import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('daily finance warnings survive real tenant aggregation and scheduled run persistence', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 120000
}, async () => {
  const fixture = await createTenantMysqlFixture('fin_coverage');
  fixture.useEnvironment();
  const { query } = fixture;
  const oldFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++;throw Error('Legacy protection must not call Ozon'); };
  const { closeMysqlPool, mysqlQuery } = await import('../src/mysql-pool.js');
  try {
    const { syncOzonFinanceMysql } = await import('../src/services/mysql-cutover.js');
    const { runTenantScheduledWork } = await import('../src/services/tenant-scheduled-work.js');
    const { ScheduledJobScheduler, registerScheduledJobs, logScheduledJobEvent } = await import('../src/services/scheduled-jobs.js');
    await query("INSERT INTO tenants(id,slug,name,status) VALUES(1,'default','Default','active'),(2,'a','A','active'),(3,'b','B','inactive')");
    await query("INSERT INTO shops(id,tenant_id,name,status,ozon_client_id,api_key_hint) VALUES(20,2,'A','active','test-client','test-key'),(30,3,'B','active','foreign-client','foreign-key')");
    await query("INSERT INTO ozon_finance_items(shop_id,operation_id,posting_number,operation_date,service_type,amount_cny) VALUES(20,'legacy-a','123-456-1','2026-10-25','legacy-fee',-9),(30,'legacy-b','789-123-1','2026-10-25','legacy-fee',-99)");
    const before = await query('SELECT * FROM ozon_finance_items ORDER BY id');
    const result = await syncOzonFinanceMysql({ shop_id: 20, from: '2026-10-25', to: '2026-10-25' }, { tenantId: 2 });
    assert.equal(result.status, 'needs_reconciliation');assert.equal(result.warnings.length, 1);
    const logs = await query("SELECT status FROM sync_logs WHERE tenant_id=2 AND job IN('ozon_finance_raw','ozon_finance')");
    assert.ok(logs.length >= 2);assert.ok(logs.every(log => log.status === 'needs_reconciliation'));

    const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    const handler = source.match(/^async function runBackgroundOzonFinanceSync\([^]*?^}/m)[0];
    const context = vm.createContext({ Number, Math, Array, backgroundOzonFinanceSyncRunning: false, BACKGROUND_OZON_FINANCE_SYNC_DAYS: 14,
      claimBackgroundModuleLane: () => false, releaseBackgroundModuleLane() {}, rollingOrderSyncWindow: () => ({ from: '2026-10-25', to: '2026-10-25' }),
      logScheduledJobEvent, runTenantScheduledWork, services: { syncOzonFinance: syncOzonFinanceMysql }, console: { log() {}, error() {} }
    });
    vm.runInContext(handler, context);
    await registerScheduledJobs([{ key: 'ozon_finance_sync', name: 'Fixture finance coverage', enabled: true, triggerType: 'interval', intervalMinutes: 360 }]);
    await query("UPDATE scheduled_jobs SET locked_at=UTC_TIMESTAMP(),locked_by='fixture-claim' WHERE job_key='ozon_finance_sync'");
    const [job] = await mysqlQuery("SELECT * FROM scheduled_jobs WHERE job_key='ozon_finance_sync'");
    const scheduler = new ScheduledJobScheduler({ handlers: { ozon_finance_sync: context.runBackgroundOzonFinanceSync } });
    await scheduler.runClaimedJob(job, 'manual');
    const [run] = await query("SELECT status,result_json FROM scheduled_job_runs WHERE job_key='ozon_finance_sync' ORDER BY id DESC LIMIT 1");
    assert.equal(run.status, 'partial');
    const saved = JSON.parse(run.result_json);assert.equal(saved.warningCount, 1);assert.match(saved.warning, /#2/);assert.match(saved.warnings[0], /旧流水/);
    const [state] = await query("SELECT last_status,last_error FROM scheduled_jobs WHERE job_key='ozon_finance_sync'");
    assert.equal(state.last_status, 'partial');assert.match(state.last_error, /旧流水/);
    assert.equal(providerCalls, 0);assert.deepEqual(await query('SELECT * FROM ozon_finance_items ORDER BY id'), before);
  } finally { globalThis.fetch = oldFetch;await closeMysqlPool();await fixture.cleanup(); }
});
