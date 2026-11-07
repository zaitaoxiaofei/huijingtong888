import test from 'node:test';
import assert from 'node:assert/strict';
import { createOzonCredentialHealth, credentialVersion, expiryStage, publicHealth } from '../src/services/ozon-credential-health.js';
import { createOzonHealthRoutes } from '../src/server/routes/ozonHealth.js';
import { authorizeApiRequest } from '../src/server/authorization.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';

const DAY = 86400000, NOW = Date.parse('2026-11-04T08:00:00Z');
const shop = { id: 7, ozon_client_id: 'test-client', ozon_api_key: 'test-not-a-real-secret', health_tenant_id: 42 };
function fixture(fetchImpl, initial = {}) {
  let saved = initial, current = shop;
  const notices = [];
  const repository = { async mutate(candidate, update) {
    if (candidate.health_tenant_id !== current.health_tenant_id || credentialVersion(candidate) !== credentialVersion(current)) return null;
    const delta = update(saved);
    if (!delta) return null;
    saved = delta.value;
    if (delta.notice) notices.push(delta.notice);
    return delta.result || { saved: true };
  } };
  return { service: createOzonCredentialHealth({ repository, fetchImpl, now: () => NOW }), notices,
    state: () => saved, rotate: value => { current = value; saved = {}; } };
}
const response = (value, status = 200) => ({ ok: status === 200, status, json: async () => value });
const valid = days => ({ expires_at: new Date(NOW + days * DAY).toISOString(), roles: [{ name: 'Admin', methods: ['/v1/roles'] }] });

test('expiry thresholds use the official timestamp, including exact expiry and missing values', () => {
  for (const [days, stage] of [[31, ''], [30, 'within_30'], [14,'within_14'], [7,'within_7'], [3,'within_3'], [1,'within_1'], [0,'expired'], [-1,'expired']]) {
    assert.equal(expiryStage(new Date(NOW + days * DAY).toISOString(), NOW).stage, stage);
  }
  assert.equal(expiryStage(null, NOW).state, 'unknown_expiry');
  assert.equal(expiryStage('not-a-date', NOW).days, null);
});

test('roles probe is read-only, finite, and returns projected metadata without keys', async () => {
  const f = fixture(async (url, options) => {
    assert.equal(url, 'https://api-seller.ozon.ru/v1/roles');
    assert.equal(options.method, 'POST'); assert.equal(options.body, '{}');
    assert.equal(options.headers['Api-Key'], shop.ozon_api_key); assert.ok(options.signal);
    return response(valid(6));
  });
  const result = await f.service.check(shop);
  assert.equal(result.status, 'expiring'); assert.equal(result.days_remaining, 6);
  assert.equal(f.notices[0].stage, 'within_7'); assert.ok(f.notices[0].day);
  assert.doesNotMatch(JSON.stringify(result), /test-not-a-real-secret|version|fingerprint/);
  await f.service.check(shop); assert.equal(f.notices.length, 1, 'manual polling is throttled');
});

test('missing expiry stays unknown; unsupported schema and network errors never become expiry claims', async () => {
  for (const reply of [response({ roles: [] }), response({ roles: [], expires_at: 'bad' })]) {
    const f = fixture(async () => reply); await f.service.check(shop); assert.equal(f.state().check_state, 'unknown_expiry');
  }
  const prior = { version: credentialVersion(shop), ...valid(20), last_verified_at: '2026-11-03T00:00:00Z' };
  for (const fetch of [async () => { throw new Error(`network timeout ${shop.ozon_api_key}`); }, async () => response({ unexpected: true })]) {
    const f = fixture(fetch, prior); await f.service.check(shop);
    assert.equal(f.state().check_state, 'check_failed'); assert.equal(f.state().expires_at, prior.expires_at);
    assert.equal(f.state().last_verified_at, prior.last_verified_at);
    assert.doesNotMatch(JSON.stringify(f.state()), /test-not-a-real-secret/);
  }
});

test('invalid key, missing permission, unsigned offer and rate limit remain different states', async () => {
  for (const [status, message, expected] of [[401,'','invalid'],[403,'Api-Key expired','invalid'],[403,'Offer not signed','offer_required'],[403,'Permission denied','forbidden'],[429,'Too many requests','check_failed']]) {
    const f = fixture(async () => response({ message }, status));
    await f.service.check(shop); assert.equal(f.state().check_state, expected);
  }
});

test('replaced credentials and newer checks reject in-flight obsolete responses', async () => {
  let complete;
  const f = fixture(() => new Promise(resolve => { complete = resolve; }));
  const pending = f.service.check(shop); await new Promise(resolve => setImmediate(resolve));
  f.rotate({ ...shop, ozon_api_key: 'replacement-key' });
  complete(response(valid(1))); await pending;
  assert.deepEqual(f.state(), {}); assert.equal(f.notices.length, 0);
  let first;
  let calls = 0;
  const g = fixture(() => ++calls === 1 ? new Promise(resolve => { first = resolve; }) : Promise.resolve(response(valid(50))));
  const slow = g.service.check(shop); await new Promise(resolve => setImmediate(resolve));
  await g.service.check(shop, { force: true }); first(response(valid(1))); await slow;
  assert.equal(publicHealth(shop, g.state(), NOW).status, 'valid'); assert.equal(g.notices.length, 0);
});

test('sync failure preserves the last success and its coverage; late finishes cannot overwrite newer attempts', async () => {
  const f = fixture(async () => response(valid(40)));
  const startedAt = '2026-11-04T01:00:00Z';
  await f.service.recordSync(shop, 'stocks', { startedAt, success: true, coverage: 'all' });
  const prior = f.state().sync.stocks.last_success_at;
  await f.service.recordSync(shop, 'stocks', { startedAt: '2026-11-04T02:00:00Z', success: false, coverage: 'selected', error: Object.assign(new Error('Api-Key expired'), { statusCode: 401 }) });
  assert.equal(f.state().sync.stocks.last_success_at, prior); assert.equal(f.state().sync.stocks.last_success_coverage, 'all');
  assert.equal(f.state().check_state, 'invalid'); assert.equal(f.notices[0].status, 'invalid');
  await f.service.recordSync(shop, 'stocks', { startedAt, success: true, coverage: 'late' });
  assert.equal(f.state().sync.stocks.status, 'failed');
  assert.equal(publicHealth({ ...shop, ozon_api_key: 'changed' }, f.state(), NOW).sync.stocks.credential_changed, true);
});

test('each tenant can only read/check its own shops and staff cannot probe credentials', async () => {
  const calls = [], session = { personId: 1, tenant: { id: 42, slug: 'a', role: 'owner' } };
  const routes = createOzonHealthRoutes({ authorize: async value => value, readJson: async () => ({ shop_id: 7, tenant_id: 99 }),
    health: { readOzonHealth: async id => calls.push(id), checkOzonHealth: async (...args) => calls.push(args.slice(0,2)) } });
  await routes['GET /api/shops/ozon-health']({ _session: session });
  await routes['POST /api/shops/ozon-health']({ _session: session });
  assert.deepEqual(calls, [42, [42, 7]]);
  const staff = { ...session, tenant: { ...session.tenant, role: 'member' } };
  await assert.rejects(routes['POST /api/shops/ozon-health']({ _session: staff }), /仅企业/);
  for (const method of ['GET','POST']) {
    assert.equal(authorizeApiRequest({ method, _session: session }, ['api','shops','ozon-health']).allowed, true);
    assert.equal(authorizeApiRequest({ method, _session: staff }, ['api','shops','ozon-health']).allowed, false);
    assert.equal(tenantIsolationDecision(session, ['api','shops','ozon-health'], method).allowed, true);
  }
});
