import assert from 'node:assert/strict';
import test from 'node:test';

Object.assign(process.env, { DB_HOST: '127.0.0.1', DB_PORT: '1', DB_NAME: 'unused_auth_test', DB_USER: 'unused', DB_PASSWORD: 'unused', AUTH_RATE_LIMIT_MAX_ATTEMPTS: '4', AUTH_TRUSTED_PROXY_IPS: '10.2.3.4,not-an-address' });
const { createAuthHandler } = await import('../src/server/session.js');
const { getClientIp, clearRateLimit, consumeRateLimit, releaseRateLimit } = await import('../src/server/access.js');
const victim = { id: 201, active: 1, name: 'Victim fixture', username: 'victim', password_hash: 'fixture-hash', role: 'operations' };
const own = { ...victim, id: 202, username: 'own' };
const handler = createAuthHandler(req => req.body, {
  findPersonForLogin: async username => username === 'own' ? own : victim,
  verifyPassword: password => password === 'correct', isLegacyHash: () => false,
  createSession: async () => 'fixture-token', getSession: async () => ({ personId: 202, roles: ['operations'], tenant: { id: 2, slug: 'a', role: 'member' } })
});
const login = (username, password, remoteAddress, headers = {}) => handler({ method: 'POST', headers, socket: { remoteAddress }, body: { username, password } }, new URL('http://fixture.invalid/api/auth/login'))();

test('only a trusted proxy socket may supply one valid nginx X-Real-IP', () => {
  for (const remote of ['198.51.100.9', '::ffff:198.51.100.9']) {
    assert.equal(getClientIp({ socket: { remoteAddress: remote }, headers: { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2', 'x-real-ip': '3.3.3.3' } }), '198.51.100.9');
  }
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.2.3.4']) {
    assert.equal(getClientIp({ socket: { remoteAddress }, headers: { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2, 3.3.3.3', 'x-real-ip': '203.0.113.17' } }), '203.0.113.17');
    for (const real of ['', 'attacker', '1.1.1.1, 2.2.2.2']) assert.equal(getClientIp({ socket: { remoteAddress }, headers: { 'x-real-ip': real, 'x-forwarded-for': '1.1.1.1' } }), remoteAddress.replace(/^::ffff:/, ''));
  }
});

test('a successful account login cannot erase failed guesses against other accounts in the IP bucket', async t => {
  const ip = '198.51.100.71';
  t.after(() => { clearRateLimit(`auth:${ip}`); clearRateLimit('auth-account:id:201'); clearRateLimit('auth-account:id:202'); });
  assert.match((await login('victim', 'wrong', ip)).error, /密码错误/);
  assert.match((await login('victim', 'wrong', ip)).error, /密码错误/);
  assert.equal((await login('own', 'correct', ip)).ok, true);
  assert.match((await login('victim', 'wrong', ip)).error, /密码错误/);
  assert.match((await login('victim', 'wrong', ip)).error, /密码错误/);
  assert.equal((await login('victim', 'wrong', ip)).__status, 429);
});

test('successful own logins refund only their reservation and do not exhaust the failure allowance', async t => {
  const ip = '198.51.100.101';
  t.after(() => { clearRateLimit(`auth:${ip}`); clearRateLimit('auth-account:id:202'); });
  for (let index = 0; index < 12; index++) assert.equal((await login('own', 'correct', ip)).ok, true);
});

test('a slow successful attempt cannot refund someone else in a replacement rate window', () => {
  const key = 'auth:reservation-fixture';
  const first = consumeRateLimit(key, 1, 60000);
  releaseRateLimit(key, first.resetAt - 1);
  assert.equal(consumeRateLimit(key, 1, 60000).allowed, false);
  clearRateLimit(key);
});

test('one account is limited across distinct IPs and username aliases resolving to its real identity', async t => {
  const ips = Array.from({ length: 5 }, (_, index) => `198.51.100.${81 + index}`);
  t.after(() => { for (const ip of ips) clearRateLimit(`auth:${ip}`); clearRateLimit('auth-account:id:201'); });
  for (let index = 0; index < 4; index++) assert.match((await login(index % 2 ? 'VÍCTIM' : 'victim', 'wrong', ips[index])).error, /密码错误/);
  assert.equal((await login('Victim', 'wrong', ips[4])).__status, 429);
});

test('forged CF or forwarded headers cannot reset an untrusted direct peer login limit', async t => {
  const ip = '198.51.100.91';
  t.after(() => { clearRateLimit(`auth:${ip}`); clearRateLimit('auth-account:id:201'); });
  for (let index = 0; index < 4; index++) await login('victim', 'wrong', ip, { 'cf-connecting-ip': `203.0.113.${index + 1}`, 'x-forwarded-for': `192.0.2.${index + 1}` });
  assert.equal((await login('victim', 'wrong', ip, { 'cf-connecting-ip': '203.0.113.100', 'x-forwarded-for': '192.0.2.100' })).__status, 429);
});
