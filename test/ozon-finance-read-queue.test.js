import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createOzonFinanceReadQueue } from '../src/services/ozon-finance-read-queue.js';
import { fetchOzonDailyAccruals } from '../src/services/ozon-finance-accrual-client.js';
import { normalizeOzonFinanceAccrual } from '../src/services/ozon-finance-accruals.js';
const TYPES = '/v1/finance/accrual/types', DAY = '/v1/finance/accrual/by-day';
function clock() {
  let time = 0;const waits = [];
  return { waits, now: () => time, advance: ms => { time += ms; },
    run: createOzonFinanceReadQueue({ now: () => time, wait: async ms => { waits.push(ms);time += ms; } }) };
}
test('types and daily pages are serialized and paced by the same Client-Id', async () => {
  const f = clock(), starts = [];
  await Promise.all(Array.from({ length: 5 }, (_, index) => f.run('same-client', index % 2 ? DAY : TYPES, async () => starts.push(f.now()))));
  assert.deepEqual(starts, [0,1100,2200,3300,4400]);
});
test('a different client can read while another client is still waiting for its response', async () => {
  const f = clock();let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  const pending = f.run('A', TYPES, async () => { started();return new Promise(resolve => { release = resolve; }); });
  await begun;assert.equal(await f.run('B', DAY, async () => 'B'), 'B');release('A');assert.equal(await pending, 'A');
});
test('429 retries use Retry-After, stop after three attempts and retain the exhausted cooldown', async () => {
  const f = clock();let calls = 0;
  await assert.rejects(f.run('A', DAY, async () => { calls++;throw Object.assign(Error('quota'), { statusCode: 429, retryAfterMs: 5000 }); }));
  assert.equal(calls, 3);assert.deepEqual(f.waits, [0,5000,5000]);
  await f.run('A', TYPES, async () => { calls++; });assert.equal(calls, 4);assert.equal(f.now(), 16000);
});
test('long cooldowns fail promptly and prohibit another page from sending early', async () => {
  const f = clock();let calls = 0;
  await assert.rejects(f.run('A', DAY, async () => { calls++;throw Object.assign(Error('quota'), { statusCode: 429, retryAfterMs: 60000 }); }), e => e.retryAfterMs === 60000);
  await assert.rejects(f.run('A', TYPES, async () => { calls++; }), e => e.code === 'OZON_FINANCE_RATE_LIMITED');
  assert.equal(calls, 1);f.advance(60000);assert.equal(await f.run('A', DAY, async () => 'recovered'), 'recovered');
});
test('non-429 failures are never retried by this queue', async () => {
  for (const statusCode of [400,401,403,409,500,503]) {
    const f = clock();let calls = 0;
    await assert.rejects(f.run('A', DAY, async () => { calls++;throw Object.assign(Error('failed'), { statusCode }); }));assert.equal(calls, 1);
  }
});
test('mutations, unverified report methods and unscoped calls are rejected before sending', async () => {
  for (const [client,path] of [['A','/v2/products/stocks'],['A','/v1/finance/accrual/unverified'],['A','/v3/finance/transaction/list'],['',DAY]]) {
    let calls = 0;await assert.rejects(clock().run(client,path,async()=>calls++));assert.equal(calls, 0);
  }
});
test('aborting an already queued read prevents its provider call and leaves later reads usable', async () => {
  const f = clock(), controller = new AbortController();let calls = 0;
  controller.abort(Error('cancelled'));
  await assert.rejects(f.run('A', DAY, async () => calls++, { signal: controller.signal }), /cancelled/);
  assert.equal(calls, 0);assert.equal(await f.run('A', DAY, async () => 'ok'), 'ok');
});
test('default cooldown waiting is cancellable', async () => {
  const run = createOzonFinanceReadQueue(), controller = new AbortController();let calls = 0;
  await run('A', TYPES, async () => calls++);
  const pending = run('A', DAY, async () => calls++, { signal: controller.signal });
  setTimeout(() => controller.abort(Error('cancelled during wait')), 10);
  await assert.rejects(pending, /cancelled during wait/);assert.equal(calls, 1);
});
const source = readFileSync(new URL('../src/ozonClient.js', import.meta.url), 'utf8');
const declaration = name => source.match(new RegExp('^(?:export )?(?:async )?function ' + name + '\\([^]*?^}', 'm'))[0].replace(/^export /, '');
function transport(fetch) {
  const f = clock();
  class ClockDate extends Date { static now() { return f.now(); } }
  const context = vm.createContext({ Number, String, Math, JSON, Error, Date: ClockDate, AbortController, setTimeout, clearTimeout, fetch,
    OZON_API_BASE: 'https://api-seller.ozon.ru', OZON_REQUEST_TIMEOUT_MS: 45000, OZON_REQUEST_RETRIES: 2,
    FBS_LIST_PATH: '/v4/posting/fbs/list', FBP_LIST_PATH: '/v1/posting/fbp/list',
    runOzonFinanceRead: f.run, fetchOzonDailyAccruals, normalizeOzonFinanceAccrual,
    normalizeIsoStart: () => '2026-11-01', normalizeIsoEnd: () => '2026-11-01'
  });
  const names = ['fetchOzonFinanceTransactions','ozonRequest','ozonRequestOnce','hasRealOzonCredentials','ozonApiKey','isRetryableOzonError','isOzonRateLimitError','retryAfterMs','networkErrorMessage','sleep','throwIfAborted'];
  vm.runInContext(names.map(declaration).join('\n'), context);
  return { f, run: options => context.fetchOzonFinanceTransactions({ id: 20, ozon_client_id: 'test-client', ozon_api_key: 'test-key' }, { from: '2026-11-01', to: '2026-11-01', ...options }) };
}
const json = (value, status = 200, headers = {}) => ({ ok: status === 200, status, headers: new Headers(headers), text: async () => JSON.stringify(value) });
test('production finance transport retries the same page and preserves cursor and original financial facts', async () => {
  const calls = [];let limited = false;
  const h = transport(async (url, options) => {
    const path = new URL(url).pathname, payload = JSON.parse(options.body);calls.push({ path, payload });
    if (path === TYPES) return json({ accrual_types: [{ id: 1, name: 'Acquiring' }] });
    if (payload.last_id === 'next' && !limited) { limited = true;return json({ message: 'quota' }, 429, { 'Retry-After': '3' }); }
    return json({ accruals: payload.last_id ? [] : [{ accrual_id: '17', date: '2026-11-01', accrued_category: 'POSTING', unit_number: '123-456-1', total_amount: { amount: '-5', currency: 'CNY' }, non_item_fee: [{ type_id: 1, accrued: { amount: '-5', currency: 'CNY' } }] }], last_id: payload.last_id ? '' : 'next' });
  });
  const result = await h.run();assert.equal(result.operations.length, 1);assert.equal(calls.length, 4);
  assert.equal(result.operations[0].operation_id, 'accrual_by_day:17');assert.equal(result.operations[0].rows[0].currency_code, 'CNY');assert.equal(result.operations[0].rows[0].amount, -5);
  assert.deepEqual(calls[2], calls[3]);assert.equal(calls[3].payload.last_id, 'next');assert.ok(h.f.waits.includes(3000));
  assert.ok(calls.every(call => [TYPES,DAY].includes(call.path)));
});
test('revoking authorization during retry backoff prevents the next real HTTP read', async () => {
  let calls = 0;const h = transport(async () => { calls++;return json({ message: 'quota' }, 429); });
  await assert.rejects(h.run({ beforeRequest: async () => { if (h.f.now() >= 2000) throw Object.assign(Error('revoked'), { statusCode: 403 }); } }), /revoked/);
  assert.equal(calls, 1);
});
test('transport honors date-form Retry-After and does not keep a request open for a long cooldown', async () => {
  let calls = 0;const h = transport(async () => { calls++;return json({ message: 'quota' }, 429, { 'Retry-After': 'Thu, 01 Jan 1970 00:01:00 GMT' }); });
  await assert.rejects(h.run(), e => e.statusCode === 429 && e.retryAfterMs === 60000);assert.equal(calls, 1);
});
