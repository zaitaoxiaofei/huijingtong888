import assert from 'node:assert/strict';
import test from 'node:test';
import { credentialSchedulerFixture } from './helpers/credential-scheduler.js';
import { currentMysqlWorkload } from '../src/mysql-workload.js';

test('first health check survives repeated retries and a process restart under continuous foreground traffic', async () => {
  const start = Date.parse('2026-11-04T08:00:00Z');
  let checks = 0;
  const check = async () => { assert.equal(currentMysqlWorkload(), 'background'); checks++; return { checked: 6 }; };
  const fixture = credentialSchedulerFixture({ now: start, check });
  const createdAt = new Date(start - 60000);
  const context = () => ({ key: 'ozon_credential_health', mode: 'scheduled', plannedFor: fixture.now(), createdAt, intervalMinutes: 1440 });
  assert.equal(fixture.beforeRun(context()).reason, 'foreground_api_active');
  fixture.advance(299000);
  assert.equal(fixture.beforeRun(context()).reason, 'foreground_api_active');
  const restart = credentialSchedulerFixture({ now: start + 300000, check });
  const retried = { ...context(), plannedFor: restart.now() };
  assert.equal(restart.beforeRun(retried), null);
  assert.equal((await restart.handler(retried)).checked, 6);
  assert.equal(checks, 1);
});

test('after a successful check the next daily due time anchors fairness rather than each retry timestamp', () => {
  const fixture = credentialSchedulerFixture();
  const lastSuccessAt = new Date(fixture.now().getTime() - 86400000);
  const context = () => ({ key: 'ozon_credential_health', mode: 'scheduled', plannedFor: fixture.now(), createdAt: new Date(0), lastSuccessAt, intervalMinutes: 1440 });
  assert.equal(fixture.beforeRun(context()).reason, 'foreground_api_active');
  fixture.advance(300000);
  assert.equal(fixture.beforeRun(context()), null);
});

test('exceeding the foreground grace never bypasses database pressure or changes unrelated jobs', async () => {
  const fixture = credentialSchedulerFixture();
  const context = { key: 'ozon_credential_health', mode: 'scheduled', createdAt: new Date(fixture.now().getTime() - 3600000), plannedFor: fixture.now(), intervalMinutes: 1440 };
  fixture.pressure(true);
  assert.equal(fixture.beforeRun(context).reason, 'database_pool_pressure');
  assert.equal((await fixture.handler(context)).reason, 'database_pool_pressure');
  fixture.pressure(false);
  assert.equal(fixture.beforeRun({ ...context, key: 'unbounded_maintenance' }).reason, 'foreground_api_active');
});
