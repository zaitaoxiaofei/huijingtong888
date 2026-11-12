import test from 'node:test';
import assert from 'node:assert/strict';
import { createWbCardLimitsReader } from '../src/services/wb-card-limits.js';
import { createWbPlatform } from '../src/services/wb-platform.js';
import { createWbRoutes } from '../src/server/routes/wb.js';
import { wbRoutePermission } from '../src/server/wb-paths.js';
import { authorizeApiRequest } from '../src/server/authorization.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';

const account = { tenant_id: 2, shop_id: 30, environment: 'production', seller_id: 'seller-a', token: 'secret-a' };
const capacity = { data: { freeLimits: 600, paidLimits: 100 }, error: false };
const page = (ids, cursor = {}) => ({ cards: ids.map(nmID => ({ nmID })), cursor: { total: ids.length, ...cursor } });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('capacity is not remaining; complete live and trash pages are counted once per nmID, sizes do not consume extra cards', async () => {
  const read = createWbCardLimitsReader();
  const calls = [];
  const request = async (a, service, path, options) => {
    calls.push({ a, service, path, options });
    if (path.endsWith('/limits')) return capacity;
    if (path.endsWith('/list')) {
      assert.equal(options.body.settings.filter.withPhoto, -1);
      if (!options.body.settings.cursor.nmID) return page(Array.from({ length: 100 }, (_, i) => i + 1), { updatedAt: 'date', nmID: 100 });
      assert.deepEqual(options.body.settings.cursor, { limit: 100, updatedAt: 'date', nmID: 100 });
      return page([101]);
    }
    assert.equal(path, '/content/v2/get/cards/trash');
    return { ...page([101, 102]), cards: [{ nmID: 101, sizes: [{}, {}] }, { nmID: 102 }] };
  };
  const first = await read(account, request);
  assert.equal(first.total.limit, 700);
  assert.equal(first.total.remaining, null);
  await settle();
  const result = await read(account, request);
  assert.deepEqual(result.total, { limit: 700, usage: 102, remaining: 598, reset_at: '' });
  assert.equal(result.refreshing, false);
  assert.equal(result.daily_create.limit, null);
  assert.equal(result.daily_create.remaining, null);
  assert.equal(result.daily_update.limit, null);
  assert.equal(calls.length, 4);
});

test('trash uses trashedAt cursor and a full final page is followed to exhaustion', async () => {
  const read = createWbCardLimitsReader();
  const calls = [];
  const request = async (a, service, path, options) => {
    if (path.endsWith('/limits')) return capacity;
    if (path.endsWith('/list')) return page([]);
    calls.push(options.body.settings);
    return calls.length === 1 ? page(Array.from({ length: 100 }, (_, i) => i + 1), { trashedAt: 'trash-date', nmID: 100 }) : page([]);
  };
  await read(account, request); await settle();
  const result = await read(account, request);
  assert.equal(result.total.usage, 100);
  assert.deepEqual(calls[1].cursor, { limit: 100, trashedAt: 'trash-date', nmID: 100 });
  assert.equal(calls[0].filter, undefined);
});

test('empty shop and usage over capacity are valid, and zero paid capacity is preserved', async () => {
  for (const ids of [[], [1]]) {
    const read = createWbCardLimitsReader();
    const request = async (a, service, path) => path.endsWith('/limits') ? { data: { freeLimits: 0, paidLimits: 0 } } : page(ids);
    await read(account, request); await settle();
    const result = await read(account, request);
    assert.equal(result.total.remaining, 0);
    assert.equal(result.total.usage, ids.length);
    assert.equal(result.paid_limit, 0);
  }
});

test('malformed capacities fail closed rather than treating null or strings as zero', async () => {
  for (const data of [{}, { freeLimits: null, paidLimits: 0 }, { freeLimits: '600', paidLimits: 0 }, { freeLimits: -1, paidLimits: 0 }]) {
    const read = createWbCardLimitsReader();
    await assert.rejects(read(account, async () => ({ data })), /不完整/);
  }
});

test('failed, truncated or looping census never reports a partial remaining balance or leaks errors', async () => {
  for (const mode of ['403', 'missing-cursor', 'loop', 'truncated']) {
    const read = createWbCardLimitsReader();
    const request = async (a, service, path) => {
      if (path.endsWith('/limits')) return capacity;
      if (mode === '403') throw Error('secret-a');
      if (mode === 'missing-cursor') return { cards: [] };
      if (mode === 'truncated') return page([1], { total: 100 });
      return page(Array.from({ length: 100 }, (_, i) => i + 1), { updatedAt: 'same-date', nmID: 100 });
    };
    await read(account, request); await settle();
    const result = await read(account, request);
    assert.equal(result.total.limit, 700);
    assert.equal(result.total.usage, null);
    assert.equal(result.total.remaining, null);
    assert.equal(result.refreshing, false);
    assert.ok(result.usage_error);
    assert.ok(!JSON.stringify(result).includes('secret-a'));
  }
});

test('cache coalesces in-flight requests and separates enterprises, shop, credentials and environment', async () => {
  let now = 0, calls = 0, release;
  const read = createWbCardLimitsReader({ now: () => now, ttl: 100 });
  const gate = new Promise(resolve => { release = resolve; });
  const request = async (a, service, path) => { if (path.endsWith('/limits')) { calls++; await gate; return capacity; } return page([]); };
  const first = read(account, request), second = read(account, request);
  assert.equal(calls, 1); release();
  await Promise.all([first, second]); await settle();
  for (const change of [{ tenant_id: 3 }, { shop_id: 31 }, { token: 'new-secret' }, { environment: 'sandbox' }, { seller_id: 'seller-b' }]) {
    await read({ ...account, ...change }, request); await settle();
  }
  assert.equal(calls, 6);
  now = 99; await read(account, request); assert.equal(calls, 6);
  now = 101; await read(account, request); await settle(); assert.equal(calls, 7);
});

test('verified ownership is checked before any cached capacity can be returned', async () => {
  let requests = 0;
  const service = createWbPlatform({ query: async () => [], request: async () => { requests++; return capacity; } });
  await assert.rejects(service.cardLimits(3, { shop_id: 30 }), error => error.statusCode === 404);
  const unchecked = createWbPlatform({ query: async () => [account], request: async () => { requests++; return capacity; } });
  await assert.rejects(unchecked.cardLimits(2, { shop_id: 30 }), /检查授权/);
  assert.equal(requests, 0);
});

test('card limit route uses current authorized enterprise, exact read permission and no remote write gate', async () => {
  const session = { personId: 7, roles: ['operations'], tenant: { id: 2, slug: 'a', role: 'member' } };
  assert.equal(wbRoutePermission(['api', 'wb', 'card-limits'], 'GET'), 'orders.read');
  assert.equal(wbRoutePermission(['api', 'wb', 'card-limits', 'extra'], 'GET'), null);
  assert.equal(wbRoutePermission(['api', 'wb', 'card-limits'], 'POST'), null);
  assert.equal(authorizeApiRequest({ method: 'GET', _session: session }, ['api','wb','card-limits']).allowed, true);
  assert.equal(tenantIsolationDecision(session, ['api','wb','card-limits'], 'GET').allowed, true);
  assert.equal(authorizeApiRequest({ method: 'GET', _session: { platform_role: 'super_admin' } }, ['api','wb','card-limits']).allowed, false);
  const calls = [];
  const routes = createWbRoutes({ authorize: async () => session, platform: async () => ({ cardLimits: async (...args) => { calls.push(args); return {}; } }) });
  await routes['GET /api/wb/card-limits']({ _session: { tenant: { id: 99 } } }, new URL('http://local/api/wb/card-limits?shop_id=30&tenant_id=99'));
  assert.equal(calls[0][0], 2);
  assert.equal(calls[0][1].shop_id, '30');
});
