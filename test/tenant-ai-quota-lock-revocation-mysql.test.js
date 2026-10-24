import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('AI quota mutex rechecks revocation after an actual MySQL lock wait, before charge and provider submission', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 60000
}, async t => {
  const fixture = await createTenantMysqlFixture('ai_quota_lock');
  fixture.useEnvironment();
  const { withAiTenantSession, reserveTenantAiRequest, withAiTenantRequestGuard, assertCurrentAiTenantPermission } = await import('../src/services/ai-tenant-context.js');
  const { withAiImageRuntimeSlot, aiImageRuntimeMetrics } = await import('../src/services/ai-image-runtime-limiter.js');
  const { closeMysqlPool } = await import('../src/mysql-pool.js');
  const lock = await mysql.createConnection({ socketPath: process.env.TENANT_TEST_MYSQL_SOCKET, user: 'root', database: fixture.database });
  const session = { personId: 7, tenant: { id: 2, slug: 'customer-a' } };
  let calls = 0;
  const source = await readFile(new URL('../src/services/ai-provider-settings.js', import.meta.url), 'utf8');
  const provider = vm.createContext({ reserveTenantAiRequest,
    resolveRuntimeConfig: async () => ({ provider: 'fixture', textModel: 'fixture' }),
    normalizeMessages: () => [{ role: 'user', content: 'fixture' }], finiteNumber: (value, fallback) => value ?? fallback,
    callOpenAiCompatibleChat: async () => { calls++; return { content: 'fixture', usage: {} }; } });
  vm.runInContext(source.match(/export async function chatWithAiProvider[\s\S]*?(?=export async function streamAiProviderResponse)/)[0].replace('export ', ''), provider);
  const request = () => withAiTenantSession(session, () => provider.chatWithAiProvider({ prompt: 'fixture' }));
  try {
    await fixture.query("INSERT INTO tenants(id,slug,name) VALUES(2,'customer-a','A')");
    await fixture.query("UPDATE tenants SET feature_flags_json=JSON_OBJECT('ai_internal_mode_reviewed',JSON_EXTRACT('true','$')) WHERE id=2");
    await fixture.query("INSERT INTO people(id,name,role) VALUES(7,'Operator','operations')");
    await fixture.query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(2,7,'member',JSON_ARRAY('operations'))");
    await fixture.query('INSERT INTO tenant_ai_limits(tenant_id,monthly_request_limit) VALUES(2,20)');
    await request();
    assert.equal(calls, 1);
    for (const scenario of ['member', 'duties', 'account', 'subscription']) await t.test(scenario, async () => {
      await fixture.query('UPDATE tenant_members SET active=1,business_roles_json=JSON_ARRAY(\'operations\') WHERE tenant_id=2');
      await fixture.query('UPDATE people SET active=1 WHERE id=7');
      await fixture.query("UPDATE tenants SET subscription_status='active',subscription_expires_at=NULL WHERE id=2");
      const before = await fixture.query('SELECT request_count,text_count,image_count FROM tenant_ai_usage WHERE tenant_id=2');
      await lock.beginTransaction();
      await lock.query('SELECT id FROM tenants WHERE id=2 FOR UPDATE');
      const pending = request();
      // Attach a handler immediately; assertions below still inspect the same rejection.
      pending.catch(() => {});
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 150; attempt++) {
          const [row] = await fixture.query("SELECT COUNT(*) n FROM performance_schema.data_locks WHERE OBJECT_SCHEMA=? AND LOCK_STATUS='WAITING'", [fixture.database]);
          if (Number(row.n)) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true, 'the provider request must actually wait on the enterprise quota mutex');
        if (scenario === 'member') await fixture.query('UPDATE tenant_members SET active=0 WHERE tenant_id=2');
        if (scenario === 'duties') await fixture.query("UPDATE tenant_members SET business_roles_json=JSON_ARRAY('packing') WHERE tenant_id=2");
        if (scenario === 'account') await fixture.query('UPDATE people SET active=0 WHERE id=7');
        if (scenario === 'subscription') await lock.query("UPDATE tenants SET subscription_status='expired' WHERE id=2");
        await lock.commit();
        await assert.rejects(pending, { code: 'TENANT_TASK_ACCESS_DENIED' });
        assert.equal(calls, 1, 'no provider request after access changed during the lock wait');
        assert.deepEqual(await fixture.query('SELECT request_count,text_count,image_count FROM tenant_ai_usage WHERE tenant_id=2'), before);
      } finally { await lock.rollback(); await pending.catch(() => {}); }
    });
    await fixture.query('UPDATE tenant_members SET active=1,business_roles_json=JSON_ARRAY(\'operations\') WHERE tenant_id=2');
    await fixture.query('UPDATE people SET active=1 WHERE id=7');
    await fixture.query("UPDATE tenants SET subscription_status='active',subscription_expires_at=NULL WHERE id=2");
    await t.test('nested request guards survive same-identity session wrappers, and receive the existing quota transaction', async () => {
      const checks = [];
      await withAiTenantSession(session, () => withAiTenantRequestGuard(({ connection }) => checks.push(['outer', Boolean(connection)]),
        () => withAiTenantRequestGuard(({ connection }) => checks.push(['inner', Boolean(connection)]),
          () => withAiTenantSession(session, () => reserveTenantAiRequest('text')))));
      assert.deepEqual(checks, [['outer', false], ['inner', false], ['outer', true], ['inner', true]]);
      await fixture.query("INSERT INTO people(id,name,role) VALUES(8,'Other operator','operations')");
      await fixture.query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(2,8,'member',JSON_ARRAY('operations'))");
      let inherited = false;
      await withAiTenantSession(session, () => withAiTenantRequestGuard(() => { inherited = true; },
        () => withAiTenantSession({ ...session, personId: 8 }, () => assertCurrentAiTenantPermission())));
      assert.equal(inherited, false, 'another persisted actor must not inherit the previous task resource guard');
    });
    await t.test('quota guard resource lock wait is followed by current locking membership validation', async () => {
      await fixture.query('CREATE TABLE review_ai_resources(id BIGINT PRIMARY KEY,tenant_id BIGINT)');
      await fixture.query('INSERT INTO review_ai_resources VALUES(1,2)');
      const before = await fixture.query('SELECT request_count,text_count,image_count FROM tenant_ai_usage WHERE tenant_id=2');
      const callsBefore = calls;
      await lock.beginTransaction();
      await lock.query('SELECT id FROM review_ai_resources WHERE id=1 FOR UPDATE');
      const pending = withAiTenantSession(session, () => withAiTenantRequestGuard(async ({connection,lock: resourceLock}={}) => {
        const sql = `SELECT tenant_id FROM review_ai_resources WHERE id=1${connection && resourceLock ? ' FOR SHARE' : ''}`;
        const rows = connection ? (await connection.execute(sql))[0] : await fixture.query(sql);
        assert.equal(Number(rows[0]?.tenant_id),2);
      },() => provider.chatWithAiProvider({prompt:'fixture'})));
      pending.catch(() => {});
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 150; attempt++) {
          const [row] = await fixture.query("SELECT COUNT(*) n FROM performance_schema.data_locks WHERE OBJECT_SCHEMA=? AND OBJECT_NAME='review_ai_resources' AND LOCK_STATUS='WAITING'",[fixture.database]);
          if (Number(row.n)) {waiting=true;break;}
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.equal(waiting,true,'quota guard must wait on the original resource before its final actor authorization');
        await fixture.query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7');
        await lock.commit();
        await assert.rejects(pending,{code:'TENANT_TASK_ACCESS_DENIED'});
        assert.equal(calls,callsBefore);
        assert.deepEqual(await fixture.query('SELECT request_count,text_count,image_count FROM tenant_ai_usage WHERE tenant_id=2'),before);
      } finally {
        await lock.rollback();
        await pending.catch(() => {});
        await fixture.query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7');
      }
    });
    for (const revoked of ['member', 'resource']) await t.test(`image runtime queue rechecks ${revoked} before invoking the provider`, async () => {
      await fixture.query('UPDATE tenant_members SET active=1 WHERE tenant_id=2');
      let releaseSlot, entered, resourceActive = true, imageCalls = 0;
      const started = new Promise(resolve => { entered = resolve; });
      const channel = { channelId: `queue-${revoked}`, maxConcurrency: 1, poolMaxConcurrency: 1 };
      const first = withAiImageRuntimeSlot(channel, async () => { entered(); await new Promise(resolve => { releaseSlot = resolve; }); });
      await started;
      const waiting = withAiTenantSession(session, () => withAiTenantRequestGuard(() => {
        if (!resourceActive) throw Object.assign(new Error('Original shop disabled'), { statusCode: 403 });
      }, () => withAiImageRuntimeSlot(channel, async () => { imageCalls++; })));
      waiting.catch(() => {});
      try {
        for (let attempt = 0; attempt < 150 && !aiImageRuntimeMetrics().waitingTotal; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(aiImageRuntimeMetrics().waitingTotal, 1);
        if (revoked === 'member') await fixture.query('UPDATE tenant_members SET active=0 WHERE tenant_id=2');
        else resourceActive = false;
        releaseSlot();
        await first;
        await assert.rejects(waiting, { statusCode: 403 });
        assert.equal(imageCalls, 0);
        assert.equal(aiImageRuntimeMetrics().activeTotal, 0);
        assert.equal(aiImageRuntimeMetrics().waitingTotal, 0);
      } finally { releaseSlot(); await first; await waiting.catch(() => {}); }
    });
  } finally { await lock.end(); await closeMysqlPool(); await fixture.cleanup(); }
});
