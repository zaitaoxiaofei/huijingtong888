import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveMonths, createFinanceDocumentArchiveContext } from '../src/services/finance-document-archive-context.js';
import { authorizeApiRequest } from '../src/server/authorization.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
const session = { personId: 1, roles: ['admin'], tenant: { id: 7, slug: 'tenant-seven', role: 'owner' } };
function fixture(rows, shops = [{ id: 4, name: 'A店', ozon_client_id: '77' }]) {
  const calls = [];
  const read = createFinanceDocumentArchiveContext({ authorize: async s => s, query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM shops')) { assert.deepEqual(params, ['77', 7, 0]); return shops; }
    assert.match(sql, /a\.tenant_id=\?/); assert.match(sql, /c\.tenant_id=\?/);
    assert.deepEqual(params.slice(0, 5), [4, 7, 0, 7, 0]); return rows;
  } });
  return { read, calls };
}
const assignment = (overrides = {}) => ({ company_id: 10, company_name: '公司甲', tax_number: 'TAX-A', effective_from: '2025-01-01', effective_to: null, ...overrides });
test('monthly grouping follows historical assignments and ignores client-supplied company identity', async () => {
  const db = fixture([assignment({ effective_to: '2025-06-30' }), assignment({ company_id: 20, company_name: '公司乙', effective_from: '2025-07-01' })]);
  const result = await db.read({ ozon_company_id: '77', months: '2025-01,2025-06,2025-07,2025-10', company_id: 999 }, session);
  assert.deepEqual(result.bindings.map(b => b.company.id), [10, 10, 20, 20]);
  assert.equal(result.shop.name, 'A店'); assert.equal(result.tenant_id, 7); assert.equal(result.binding_token.length, 64);
  assert.ok(db.calls.every(c => !c.sql.includes('api_key')));
});
test('missing, overlapping and mid-month assignments remain blocked per month', async () => {
  const db = fixture([assignment({ effective_from: '2025-02-15', effective_to: '2025-06-15' }), assignment({ company_id: 20, effective_from: '2025-06-16' })]);
  const result = await db.read({ ozon_company_id: '77', months: '2025-01,2025-02,2025-06,2025-07' }, session);
  assert.ok(result.bindings.slice(0, 3).every(b => b.error && !b.company));
  assert.equal(result.bindings[3].company.id, 20);
});
test('shop identity must uniquely match within the authorized enterprise', async () => {
  await assert.rejects(fixture([], []).read({ ozon_company_id: '77', months: '2025-01' }, session), /未绑定/);
  await assert.rejects(fixture([], [{ id: 4 }, { id: 5 }]).read({ ozon_company_id: '77', months: '2025-01' }, session), /多个店铺/);
});
test('equivalent legacy assignments merge only within one company and must cover the month without gaps', async () => {
  const input = { ozon_company_id: '77', months: '2025-01' };
  const duplicate = fixture([assignment({ effective_from: '1999-12-31' }), assignment({ effective_from: '2000-01-01' })]);
  assert.equal((await duplicate.read(input, session)).bindings[0].company.id, 10);
  assert.match(duplicate.calls[1].sql, /DATE_FORMAT\(a\.effective_from/);
  const adjacent = fixture([assignment({ effective_to: '2025-01-15' }), assignment({ effective_from: '2025-01-16' })]);
  assert.equal((await adjacent.read(input, session)).bindings[0].company.id, 10);
  const gap = fixture([assignment({ effective_to: '2025-01-14' }), assignment({ effective_from: '2025-01-16' })]);
  assert.match((await gap.read(input, session)).bindings[0].error, /不覆盖整月/);
  const conflict = fixture([assignment(), assignment({ company_id: 20 })]);
  assert.match((await conflict.read(input, session)).bindings[0].error, /跨主体重叠/);
});
test('membership and financial permission are checked again before reading metadata', async () => {
  const db = fixture([]);
  await assert.rejects(db.read({ ozon_company_id: '77', months: '2025-01' }, { roles: ['operator'], tenant: { id: 7, slug: 'tenant-seven', role: 'member' } }), /无权/);
  assert.equal(db.calls.length, 0);
  const denied = createFinanceDocumentArchiveContext({ authorize: async () => { throw new Error('revoked'); }, query: async () => assert.fail('No query allowed') });
  await assert.rejects(denied({}, session), /revoked/);
});
test('months are validated and deduplicated, and the binding token changes with the assignment', async () => {
  assert.deepEqual(archiveMonths('2025-02,2025-01,2025-01'), ['2025-01', '2025-02']);
  assert.throws(() => archiveMonths('2025-13'), /月份/);
  assert.throws(() => archiveMonths(''), /月份/);
  const a = await fixture([assignment()]).read({ ozon_company_id: '77', months: '2025-01' }, session);
  const b = await fixture([assignment({ company_id: 11 })]).read({ ozon_company_id: '77', months: '2025-01' }, session);
  assert.notEqual(a.binding_token, b.binding_token);
});
test('the new read route retains enterprise gates and grants no write route', () => {
  const parts = ['api', 'finance-center', 'document-archive-context'];
  assert.equal(tenantIsolationDecision(session, parts, 'GET').allowed, true);
  assert.equal(authorizeApiRequest({ method: 'GET', _session: session }, parts).allowed, true);
  assert.equal(tenantIsolationDecision(session, parts, 'POST').allowed, false);
  assert.equal(authorizeApiRequest({ method: 'GET', _session: { roles: ['operator'], tenant: { id: 7, slug: 'tenant-seven', role: 'member' } } }, parts).allowed, false);
});
