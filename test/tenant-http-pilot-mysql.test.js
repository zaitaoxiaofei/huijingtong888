import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/auth-password.js';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';

test('complete HTTP service keeps enterprise isolation through login, switching and restart', {
  skip: !process.env.TENANT_TEST_MYSQL_SOCKET && 'Requires isolated socket-only MySQL and dedicated port 8788', timeout: 240000
}, async t => {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(8788, '127.0.0.1', resolve));
  await new Promise(resolve => probe.close(resolve));
  const fixture = await createTenantMysqlFixture('http_pilot');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ozon-http-pilot-'));
  const base = 'http://127.0.0.1:8788', password = `Pilot-${randomUUID()}!`;
  let child, output = '', attachmentUrl;
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    child = null;
  };
  const start = async () => {
    output = '';
    child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))], {
      cwd: directory, windowsHide: true,
      env: { ...process.env, ...fixture.env, HOST: '127.0.0.1', APP_BASE_URL: base,
        SCHEDULED_JOBS_ENABLED: '0', DEPLOYMENT_CANDIDATE: '1', BACKGROUND_OZON_STOCK_SYNC_ENABLED: 'false',
        BACKGROUND_OZON_CATEGORY_SYNC_ENABLED: 'false', UPLOADS_ROOT: path.join(directory, 'uploads'), SITE_ACCESS_PASSWORD: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-16000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-16000); });
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      if (child.exitCode !== null) throw new Error(`Isolated HTTP startup failed: ${output}`);
      try {
        const response = await fetch(`${base}/api/ready`, { signal: AbortSignal.timeout(1500) });
        if (response.ok && (await response.json()).ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Isolated HTTP readiness timeout: ${output}`);
  };
  const request = async (url, token, method = 'GET', body) => {
    const response = await fetch(base + url, { method, signal: AbortSignal.timeout(20000),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data };
  };
  const login = async id => {
    const result = await request('/api/auth/login', '', 'POST', { username: `pilot${id}`, password });
    assert.equal(result.status, 200);
    assert.ok(result.data.token, `Fixture account ${id} should log in: ${result.data.error || ''}`);
    return result.data;
  };
  try {
    await fixture.query("INSERT INTO tenants(id,slug,name) VALUES(1,'default','Default'),(2,'a','A'),(3,'b','B')");
    for (const id of [1, 2, 3, 4, 5]) {
      await fixture.query('INSERT INTO people(id,name,username,password_hash,role) VALUES(?,?,?,?,?)', [id, `Pilot ${id}`, `pilot${id}`, hashPassword(password), id === 4 ? 'packing' : 'admin']);
      if (id !== 5) await fixture.query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,'member',JSON_ARRAY(?))", [id === 4 ? 1 : id, id, id === 4 ? 'packing' : 'admin']);
    }
    await fixture.query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(3,2,'member',JSON_ARRAY('admin'))");
    for (const id of [1, 2, 3]) {
      await fixture.query('INSERT INTO shops(id,tenant_id,name) VALUES(?,?,?)', [id * 10, id === 1 ? null : id, `HTTP own shop ${id}`]);
      await fixture.query('INSERT INTO products(id,tenant_id,name,code) VALUES(?,?,?,?)', [id * 10, id === 1 ? null : id, `HTTP own product ${id}`, `HTTP-${id}`]);
      await fixture.query("INSERT INTO orders(id,shop_id,posting_number,status,ordered_at) VALUES(?,?,?,'awaiting_packaging','2026-10-01')", [id * 10, id * 10, `HTTP-order-${id}`]);
      await fixture.query('INSERT INTO order_items(id,order_id,ozon_sku,quantity,sale_price) VALUES(?,?,?,?,?)', [id * 10, id * 10, `HTTP-sku-${id}`, 1, id * 100]);
    }
    await start();
    const sessions = new Map();
    await t.test('default staff and both customers still log in; an unjoined account cannot auto-enrol', async () => {
      for (const id of [1, 2, 3, 4]) sessions.set(id, await login(id));
      assert.equal(sessions.get(4).user.tenant.slug, 'default');
      const unjoined = await request('/api/auth/login', '', 'POST', { username: 'pilot5', password });
      assert.ok(!unjoined.data.token);
      assert.equal(Number((await fixture.query('SELECT COUNT(*) n FROM tenant_members WHERE person_id=5'))[0].n), 0);
    });
    await t.test('HTTP lists/details/mutations use session enterprise and ignore body/query tenant selectors', async () => {
      for (const id of [1, 2, 3, 4]) {
        const expected = id === 4 ? 1 : id, token = sessions.get(id).token;
        const list = await request('/api/orders?paged=1&includeRows=1&tenant_id=3', token);
        assert.equal(list.status, 200, JSON.stringify(list.data));
        assert.equal(Number(list.data.total), 1);
        assert.ok(!JSON.stringify(list.data).includes(`HTTP-order-${expected === 2 ? 3 : 2}`));
        const foreign = await request(`/api/orders/${expected === 2 ? 30 : 20}`, token);
        assert.equal(foreign.status, 404);
        const mark = await request('/api/orders/30/mark', token, 'PUT', { tenant_id: 3, mark_type: 'quality', note: 'must not write' });
        if (expected !== 3) assert.ok([403, 404].includes(mark.status), `Account ${id}, HTTP ${mark.status}: ${JSON.stringify(mark.data)}`);
      }
      const customers = await request('/api/people', sessions.get(2).token);
      assert.equal(customers.status, 200);
      assert.ok(!JSON.stringify(customers.data).includes('Pilot 4'));
      const privateAnonymous = await request('/uploads/team-attachments/unknown.pdf');
      assert.ok([401, 403, 404].includes(privateAnonymous.status));
    });
    await t.test('same login switches A to B and back without reusing a list or task cache', async () => {
      const token = sessions.get(2).token;
      for (const id of [3, 2]) {
        const switched = await request('/api/auth/switch-tenant', token, 'POST', { tenant_id: id });
        assert.equal(switched.status, 200, JSON.stringify(switched.data));
        const list = await request('/api/orders?paged=1&includeRows=1', token);
        assert.equal(list.status, 200);
        assert.ok(JSON.stringify(list.data).includes(`HTTP-order-${id}`));
        assert.ok(!JSON.stringify(list.data).includes(`HTTP-order-${id === 2 ? 3 : 2}`));
      }
      const noMembership = await request('/api/auth/switch-tenant', sessions.get(3).token, 'POST', { tenant_id: 2 });
      assert.ok(noMembership.status >= 400);
    });
    await t.test('image proxy refuses private network and metadata URLs before fetching or using cache', async () => {
      for (const target of [`${base}/uploads/team-attachments/private.png`, 'http://169.254.169.254/private.png', 'http://[::1]/private.png']) {
        const response = await request('/api/image-proxy?url=' + encodeURIComponent(target));
        assert.equal(response.status, 400);
      }
    });
    await t.test('real attachment upload and downloads require current enterprise for GET and HEAD', async () => {
      const form = new FormData();
      form.set('file', new Blob(['A enterprise private receipt'], { type: 'text/plain' }), 'receipt.txt');
      const uploaded = await fetch(`${base}/api/team/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${sessions.get(2).token}` }, body: form });
      assert.equal(uploaded.status, 200);
      const body = await uploaded.json();
      assert.equal(body.ok, true, body.error);
      attachmentUrl = body.url;
      const own = await fetch(base + attachmentUrl, { headers: { Authorization: `Bearer ${sessions.get(2).token}` } });
      assert.equal(own.status, 200);
      assert.equal(await own.text(), 'A enterprise private receipt');
      assert.match(own.headers.get('cache-control'), /no-store/);
      for (const method of ['GET','HEAD']) {
        const foreign = await fetch(base + attachmentUrl, { method, headers: { Authorization: `Bearer ${sessions.get(3).token}`, Range: 'bytes=0-12' } });
        assert.equal(foreign.status, 404);
        assert.notEqual(await foreign.text(), 'A enterprise private receipt');
      }
      const head = await fetch(base + attachmentUrl, { method: 'HEAD', headers: { Authorization: `Bearer ${sessions.get(2).token}` } });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      const anonymous = await fetch(base + attachmentUrl);
      assert.ok([401,403].includes(anonymous.status));
    });
    await t.test('restart preserves existing sessions and tenant ownership', async () => {
      await stop(); await start();
      for (const id of [1, 2, 3, 4]) {
        const response = await request('/api/orders?paged=1&includeRows=0', sessions.get(id).token);
        assert.equal(response.status, 200, JSON.stringify(response.data));
        assert.equal(Number(response.data.total), 1);
      }
      const restoredFile = await fetch(base + attachmentUrl, { headers: { Authorization: `Bearer ${sessions.get(2).token}` } });
      assert.equal(restoredFile.status, 200);
      assert.equal(await restoredFile.text(), 'A enterprise private receipt');
      await fixture.query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2');
      const revoked = await request('/api/orders?paged=1', sessions.get(2).token);
      assert.ok([401, 403].includes(revoked.status));
    });
  } finally {
    await stop();
    await fixture.cleanup();
    const absolute = path.resolve(directory), intended = path.resolve(os.tmpdir()) + path.sep;
    if (!absolute.startsWith(intended) || !path.basename(absolute).startsWith('ozon-http-pilot-')) throw new Error('Unexpected fixture cleanup directory');
    await rm(absolute, { recursive: true, force: true });
  }
});
