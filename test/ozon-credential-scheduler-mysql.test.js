import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { credentialSchedulerFixture } from './helpers/credential-scheduler.js';
import { currentMysqlWorkload } from '../src/mysql-workload.js';

test('automatic credential checks eventually run, persist expiry and notify without bypassing pool pressure', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 60000
}, async () => {
  const database = await createTenantMysqlFixture('credential_schedule');
  const originalFetch = globalThis.fetch;
  let closeMysqlPool;
  try {
    database.useEnvironment();
    const q = database.query;
    const { ScheduledJobScheduler, registerScheduledJobs } = await import('../src/services/scheduled-jobs.js');
    const { runTenantScheduledWork } = await import('../src/services/tenant-scheduled-work.js');
    const { checkTenantOzonHealth, readOzonHealth } = await import('../src/services/ozon-credential-health-mysql.js');
    const pool = await import('../src/mysql-pool.js');
    ({ closeMysqlPool } = pool);
    await q('ALTER TABLE shops ADD COLUMN ozon_api_key TEXT NULL');
    await q("INSERT INTO tenants(id,slug,name,status,subscription_status) VALUES(2,'a','A','active','active')");
    await q("INSERT INTO people(id,name,role) VALUES(10,'Owner','operations')");
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(2,10,'owner',JSON_ARRAY('operations'))");
    await q("INSERT INTO shops(id,tenant_id,name,user_id,ozon_client_id,ozon_api_key) VALUES(20,2,'A shop',10,'fixture-client','fixture-key')");
    let probes = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api-seller.ozon.ru/v1/roles');
      assert.equal(options.headers['Client-Id'], 'fixture-client');
      assert.equal(currentMysqlWorkload(), 'background');
      probes++;
      return { ok: true, json: async () => ({ roles: [{ name: 'Admin', methods: ['/v1/roles'] }], expires_at: new Date(Date.now() + 3 * 86400000).toISOString() }) };
    };
    const key = 'ozon_credential_health';
    await registerScheduledJobs([{ key, name: 'Credential expiry', category: 'maintenance', priority: 'critical', intervalMinutes: 1440, initialDelaySeconds: 60, catchupEnabled: true, maxCatchupRuns: 1 }]);
    await q('UPDATE scheduled_jobs SET created_at=DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE), next_run_at=UTC_TIMESTAMP() WHERE job_key=?', [key]);
    const fixture = credentialSchedulerFixture({ check: checkTenantOzonHealth, runTenant: runTenantScheduledWork });
    const scheduler = new ScheduledJobScheduler({ handlers: { [key]: fixture.handler }, beforeRun: fixture.beforeRun });
    const claim = async () => {
      await q('UPDATE scheduled_jobs SET locked_at=UTC_TIMESTAMP(),locked_by=? WHERE job_key=?', ['fixture-claim', key]);
      return (await pool.mysqlQuery('SELECT * FROM scheduled_jobs WHERE job_key=?', [key]))[0];
    };
    const created = (await claim()).created_at;
    fixture.pressure(true);
    await scheduler.runClaimedJob(await claim(), 'scheduled');
    assert.equal(probes, 0);
    assert.equal((await q('SELECT COUNT(*) n FROM scheduled_job_runs WHERE job_key=?', [key]))[0].n, 0);
    const deferred = (await pool.mysqlQuery('SELECT * FROM scheduled_jobs WHERE job_key=?', [key]))[0];
    assert.equal(deferred.locked_by, null);
    assert.equal(deferred.last_success_at, null);
    assert.equal(deferred.created_at.getTime(), created.getTime());
    assert.ok(deferred.next_run_at.getTime() > Date.now());
    fixture.pressure(false);
    await scheduler.runClaimedJob(await claim(), 'scheduled');
    assert.equal(probes, 1);
    const job = (await pool.mysqlQuery('SELECT * FROM scheduled_jobs WHERE job_key=?', [key]))[0];
    assert.equal(job.last_status, 'success');
    assert.ok(job.last_success_at);
    assert.ok(job.next_run_at.getTime() > Date.now() + 23 * 3600000);
    assert.equal(job.locked_by, null);
    const [health] = await readOzonHealth(2);
    assert.equal(health.status, 'expiring');
    assert.ok(health.expires_at);
    const notices = await q("SELECT tenant_id,recipient_person_id FROM system_notifications WHERE notification_type='ozon_credential_health'");
    assert.equal(notices.length, 1);
    assert.equal(Number(notices[0].tenant_id), 2);
    assert.equal(Number(notices[0].recipient_person_id), 10);
    const runs = await q('SELECT status,mode FROM scheduled_job_runs WHERE job_key=?', [key]);
    assert.deepEqual(runs.map(row => [row.status, row.mode]), [['success', 'scheduled']]);
  } finally {
    globalThis.fetch = originalFetch;
    if (closeMysqlPool) await closeMysqlPool();
    await database.cleanup();
  }
});
