import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchOzonPostingAccruals, OZON_FINANCE_POSTINGS_ENDPOINT as POSTINGS } from '../src/services/ozon-finance-postings-client.js';
import { authorizeApiRequest } from '../src/server/authorization.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
const TYPES = '/v1/finance/accrual/types', number = '123-456-1';
const types = { accrual_types: [{ id: 1, name: 'Acquiring' }] };
const fee = () => ({ accrual_date: '2026-11-11', type_id: 1, accrued: { amount: '-2.500', currency: 'CNY' }, sku: null, quantity: null, seller_price: null });
const response = rows => ({ posting_accruals: [{ posting_number: number, accruals: rows }] });
const run = (data, options = {}) => fetchOzonPostingAccruals({ id: 20 }, { postingNumbers: [number], request: async path => path === TYPES ? types : data, ...options });

test('official postings contract uses typed POST payloads and preserves repeated rows and decimal amounts', async () => {
  const calls = [];
  const result = await run(response([fee(),fee()]), { postingNumbers: [number,number], request: async (path,body,options) => {
    calls.push({ path, body, method: options.method });return path === TYPES ? types : response([fee(),fee()]);
  } });
  assert.deepEqual(calls, [{ path: TYPES, body: {}, method: 'POST' }, { path: POSTINGS, body: { posting_numbers: [number] }, method: 'POST' }]);
  assert.equal(result.rows[0].accruals.length, 2);assert.equal(result.rows[0].accruals[0].accrued.amount, '-2.500');
  assert.equal(result.rows[0].accruals[0].type_name, 'Acquiring');assert.equal(result.read_only, true);assert.equal(result.source_endpoint, POSTINGS);
  assert.ok(!('operation_id' in result.rows[0].accruals[0]));assert.ok(!('total' in result));
});
test('missing postings stay unknown and differ from an explicitly returned empty list', async () => {
  const absent = await run({ posting_accruals: [] });assert.equal(absent.rows[0].status, 'not_returned');assert.equal(absent.rows[0].accruals, null);
  assert.deepEqual(absent.missing_posting_numbers, [number]);
  const empty = await run(response([]));assert.equal(empty.rows[0].status, 'returned_empty');assert.deepEqual(empty.rows[0].accruals, []);
  assert.match(empty.coverage_note, /母单/);
});
test('unknown fee types remain explicit and original currencies are not converted or summed', async () => {
  const result = await run(response([{ ...fee(), type_id: 9, accrued: { amount: '100.0000000000001', currency: 'USD' }, seller_price: { amount: '-7.23', currency: 'RUB' } }]));
  assert.equal(result.unknown_type_count, 1);assert.equal(result.rows[0].accruals[0].type_name, null);
  assert.equal(result.rows[0].accruals[0].accrued.amount, '100.0000000000001');assert.equal(result.rows[0].accruals[0].seller_price.currency, 'RUB');
});
test('lossless string SKU and negative correction quantities are retained; unsafe numeric SKU is rejected', async () => {
  const result = await run(response([{ ...fee(), sku: '9007199254740993', quantity: -1 }]));
  assert.equal(result.rows[0].accruals[0].sku, '9007199254740993');assert.equal(result.rows[0].accruals[0].quantity, -1);
  await assert.rejects(run(response([{ ...fee(), sku: Number.MAX_SAFE_INTEGER + 1 }])));
});
test('foreign and duplicate posting containers fail instead of being attributed to the requested order', async () => {
  for (const data of [{ posting_accruals: [{ posting_number: 'foreign', accruals: [fee()] }] }, { posting_accruals: [...response([]).posting_accruals,...response([]).posting_accruals] }]) await assert.rejects(run(data));
});
test('malformed report containers, fees, dates and money fail without empty success', async () => {
  for (const data of [{}, { posting_accruals: null }, { posting_accruals: [null] }, { posting_accruals: [{ posting_number: number }] }]) await assert.rejects(run(data));
  for (const row of [null, { ...fee(), accrual_date: '2026-02-30' }, { ...fee(), accrued: { amount: -5, currency: 'RUB' } },
    { ...fee(), accrued: { amount: 'NaN', currency: 'CNY' } }, { ...fee(), accrued: { amount: '1', currency: '' } },
    { ...fee(), type_id: undefined }, { ...fee(), quantity: '1' }]) await assert.rejects(run(response([row])));
});
test('invalid input and empty or invalid type dictionaries fail before report lookup', async () => {
  for (const postingNumbers of [[], [1], [''], Array.from({ length: 201 }, (_, i) => String(i))]) {
    let requests = 0;await assert.rejects(run(response([]), { postingNumbers, request: async () => { requests++;return types; } }));assert.equal(requests, 0);
  }
  for (const invalidTypes of [{}, { accrual_types: [] }, { accrual_types: [{ id: 1 }] }]) {
    let requests = 0;await assert.rejects(run(response([]), { request: async () => { requests++;return invalidTypes; } }));assert.equal(requests, 1);
  }
});
test('membership revocation after a response blocks the next read and no partial data escapes', async () => {
  let revoked = false, requests = 0;
  await assert.rejects(run(response([fee()]), { beforeRequest: async () => { if (revoked) throw Error('revoked'); }, request: async () => { requests++;revoked = true;return types; } }), /revoked/);
  assert.equal(requests, 1);
});
test('abort and source failures cannot fall back to daily accruals or manufacture zero costs', async () => {
  const controller = new AbortController();controller.abort(Error('cancelled'));let requests = 0;
  await assert.rejects(run(response([]), { signal: controller.signal, request: async () => requests++ }), /cancelled/);assert.equal(requests, 0);
  const paths = [];const quota = Object.assign(Error('quota'), { statusCode: 429 });
  await assert.rejects(run(response([]), { request: async path => { paths.push(path);throw quota; } }), error => error === quota);assert.deepEqual(paths, [TYPES]);
});
test('route authorization and tenant isolation admit only this exact enterprise-admin read', () => {
  const parts = ['api','finance-center','ozon-posting-accruals'];
  for (const [id,slug] of [[1,'default'],[2,'a']]) for (const role of ['owner','admin']) {
    const session = { personId: id, roles: ['operations'], tenant: { id,slug,role } };
    assert.equal(authorizeApiRequest({ method: 'POST', _session: session }, parts).allowed, true);
    assert.equal(tenantIsolationDecision(session, parts, 'POST').allowed, true);
    for (const method of ['GET','PUT','DELETE']) assert.equal(authorizeApiRequest({ method, _session: session }, parts).allowed, false);
    assert.equal(authorizeApiRequest({ method: 'POST', _session: session }, [...parts,'extra']).allowed, false);
  }
  for (const session of [{ roles: ['operations'],tenant:{ id:1,slug:'default',role:'member' } },
    { roles: ['admin'],tenant:{ id:2,slug:'a',role:'member' } }, { platform_role:'super_admin',roles:['admin'] }]) {
    assert.equal(authorizeApiRequest({ method:'POST',_session:session }, parts).allowed,false);assert.equal(tenantIsolationDecision(session,parts,'POST').allowed,false);
  }
});
