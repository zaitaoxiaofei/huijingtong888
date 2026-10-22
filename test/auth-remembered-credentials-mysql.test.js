import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('actual password writers invalidate every remembered device and unconsumed QR without restoring revoked tenants or platform grants', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL', timeout: 180000
}, async t => {
  const fixture = await createTenantMysqlFixture('auth_credential');
  let closeMysqlPool;
  try {
    fixture.useEnvironment();
    const { hashPassword } = await import('../src/auth-password.js');
    const { createAuthHandler } = await import('../src/server/session.js');
    const { createQrLoginSession, getQrMobileSession } = await import('../src/server/internal-qr-login.js');
    const { updatePersonPasswordMysql, getSessionMysql } = await import('../src/services/mysql-auth-session.js');
    ({ closeMysqlPool } = await import('../src/mysql-pool.js'));
    const q = fixture.query;
    await q("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await q("INSERT INTO people(id,name,username,role,password_hash) VALUES(7,'A fixture','credential-a','operations',?),(8,'B fixture','credential-b','operations',?),(9,'Platform fixture','credential-platform','admin',?)", [hashPassword('Initial-pass#2026'), hashPassword('Other-pass#2026'), hashPassword('Platform-pass#2026')]);
    await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(2,7,'member',JSON_ARRAY('operations')),(3,8,'member',JSON_ARRAY('operations'))");
    await q("INSERT INTO platform_grants(person_id,role,active,reason) VALUES(9,'super_admin',1,'Isolated fixture')");
    const handler = createAuthHandler(req => req.body || {}, { consumeRateLimit: () => ({ allowed: true }), clearRateLimit: () => {}, getClientIp: () => 'isolated-auth-fixture' });
    const invoke = (method, path, body = {}, headers = {}) => handler({ method, headers, socket: { remoteAddress: '127.0.0.1' }, body }, new URL(`http://fixture.invalid${path}`))();
    const challenge = () => { const qr = createQrLoginSession(new URL('http://fixture.invalid/api/auth/qr/start')); return { sid: qr.sid, secret: new URL(qr.confirmUrl).searchParams.get('secret') }; };
    const confirm = async (username, password, cookie = '') => {
      const qr = challenge();
      const result = await invoke('POST', '/api/auth/qr/confirm', { ...qr, username, password, tenant_id: 3 }, cookie ? { cookie } : {});
      return { qr, result, cookie: result.__cookies?.[0]?.value ? `erp_qr_mobile=${result.__cookies[0].value}` : '' };
    };

    await t.test('self-service password change invalidates two devices and two pending desktop confirmations', async () => {
      const first = await confirm('credential-a', 'Initial-pass#2026');
      const second = await confirm('credential-a', 'Initial-pass#2026');
      const logged = await invoke('POST', '/api/auth/login', { username: 'credential-a', password: 'Initial-pass#2026' });
      const changed = await invoke('POST', '/api/auth/change-password', { old_password: 'Initial-pass#2026', new_password: 'Updated-pass#2026' }, { authorization: `Bearer ${logged.token}` });
      assert.equal(changed.ok, true);
      for (const device of [first, second]) {
        const invalid = await confirm('credential-b', 'Other-pass#2026', device.cookie);
        assert.equal(invalid.result.__status, 401);
        assert.equal(invalid.result.__cookies[0].options.maxAge, 0);
        assert.equal(getQrMobileSession({ headers: { cookie: device.cookie } }), null);
        const status = await invoke('GET', `/api/auth/qr/status?sid=${device.qr.sid}`);
        assert.deepEqual(status, { status: 'expired' });
      }
      assert.equal((await q('SELECT token FROM sessions WHERE person_id=7')).length, 1);
      assert.ok(await getSessionMysql(logged.token));
    });

    await t.test('a direct administrator password writer invalidates credentials even if an old session row remains', async () => {
      const pending = await confirm('credential-a', 'Updated-pass#2026');
      const before = await q('SELECT token FROM sessions WHERE person_id=7');
      await updatePersonPasswordMysql(7, hashPassword('Admin-reset#2026'));
      assert.equal((await confirm('', '', pending.cookie)).result.__status, 401);
      assert.deepEqual(await invoke('GET', `/api/auth/qr/status?sid=${pending.qr.sid}`), { status: 'expired' });
      assert.equal((await q('SELECT token FROM sessions WHERE person_id=7')).length, before.length - 1, 'Rejected pending token must be destroyed');
      const page = await invoke('GET', `/api/auth/qr/confirm-page?sid=${challenge().sid}`, {}, { cookie: pending.cookie });
      assert.match(page.__html, /id="username"/);
    });

    await t.test('valid renewed credentials expose only current tenant identity and consume a challenge once', async () => {
      const first = await confirm('credential-a', 'Admin-reset#2026');
      const second = await confirm('credential-b', 'Other-pass#2026', first.cookie);
      assert.equal(second.result.ok, true);
      const status = await invoke('GET', `/api/auth/qr/status?sid=${second.qr.sid}`);
      assert.equal(status.status, 'confirmed');
      assert.equal(Number(status.user.id), 7);
      assert.equal(Number(status.user.tenant.id), 2);
      assert.equal(status.user.platform_role, null);
      assert.ok(!JSON.stringify(status).includes('credentialVersion'));
      assert.deepEqual(await invoke('GET', `/api/auth/qr/status?sid=${second.qr.sid}`), { status: 'expired' });
    });

    await t.test('revoked enterprise membership rejects pending credentials without joining default or B', async () => {
      const pending = await confirm('credential-a', 'Admin-reset#2026');
      await q('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=7');
      assert.deepEqual(await invoke('GET', `/api/auth/qr/status?sid=${pending.qr.sid}`), { status: 'expired' });
      await assert.rejects(confirm('credential-a', '', pending.cookie), /未加入任何企业/);
      assert.equal((await q('SELECT tenant_id FROM tenant_members WHERE person_id=7 AND active=1')).length, 0);
      await q('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=7');
    });

    await t.test('revoked explicit platform grant cannot be restored by a remembered identity', async () => {
      const pending = await confirm('credential-platform', 'Platform-pass#2026');
      await q('UPDATE platform_grants SET active=0 WHERE person_id=9');
      assert.deepEqual(await invoke('GET', `/api/auth/qr/status?sid=${pending.qr.sid}`), { status: 'expired' });
      await assert.rejects(confirm('', '', pending.cookie), /未加入任何企业/);
      assert.equal((await q('SELECT * FROM tenant_members WHERE person_id=9')).length, 0);
    });
  } finally {
    if (closeMysqlPool) await closeMysqlPool();
    await fixture.cleanup();
  }
});
