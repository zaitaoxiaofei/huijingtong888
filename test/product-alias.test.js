import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProductAlias } from '../src/shared/product-alias.js';
import { createProductAliasService } from '../src/services/product-alias.js';
import { authorizeApiRequest } from '../src/server/authorization.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
const session = roles => ({ personId: 7, roles, tenant: { id: 2, slug: 'a', role: 'member' } });
function fixture({ roles = ['procurement'], owned = true, current = '' } = {}) {
  const calls = [], actor = session(roles);
  const query = async (sql, args = []) => {
    calls.push({ sql, args });
    if (sql.includes('FROM tenants')) return [{ id: 2, slug: 'a' }];
    if (sql.includes('SELECT owned.*')) return owned ? [{ id: 23, tenant_id: 2, product_alias: current }] : [];
    if (sql.startsWith('UPDATE products')) { current = args[0]; return { affectedRows: 1 }; }
    if (sql.includes('SELECT p.id')) return [{ product_id: 23, product_alias: current }];
    throw Error(sql);
  };
  const service = createProductAliasService({ query, authorize: async s => s, transaction: fn => fn({ query: async (...args) => [await query(...args)] }) });
  return { service, actor, calls };
}
test('alias trims whitespace, supports Chinese and clearing, rejects non-text and excess length', () => {
  assert.equal(normalizeProductAlias('  国内星途揽月\n2024款  '), '国内星途揽月\n2024款');
  assert.equal(normalizeProductAlias('   '), '');
  assert.equal(normalizeProductAlias('🚗'.repeat(500)).length, 1000);
  for (const value of [null, undefined, {}, 5, '字'.repeat(501)]) assert.throws(() => normalizeProductAlias(value), { statusCode: 400 });
});
test('save, overwrite, reread and clear all use the same product field without touching stock or purchase data', async () => {
  const f = fixture();
  for (const [expected_alias, product_alias] of [['', '星途揽月'], ['星途揽月', '揽月2024款'], ['揽月2024款', '']]) {
    assert.equal((await f.service.save({ product_id: 23, expected_alias, product_alias }, f.actor)).product_alias, product_alias);
    assert.equal((await f.service.read({ product_ids: '23,23' }, f.actor)).rows[0].product_alias, product_alias);
  }
  assert.ok(f.calls.filter(c => c.sql.startsWith('UPDATE')).every(c => c.sql === 'UPDATE products SET product_alias=? WHERE id=?'));
  assert.match(f.calls.find(c => c.sql.includes('SELECT owned.*')).sql, /FOR UPDATE/);
});
test('stale editors cannot overwrite or clear a newly saved alias', async () => {
  const f = fixture({ current: '最新别名' });
  for (const product_alias of ['旧页面编辑', '']) await assert.rejects(f.service.save({ product_id: 23, expected_alias: '', product_alias }, f.actor), { statusCode: 409 });
  assert.ok(f.calls.every(c => !c.sql.startsWith('UPDATE')));
});
test('enterprise ownership is required for writes and batch reads remain tenant-scoped', async () => {
  const f = fixture({ owned: false });
  await assert.rejects(f.service.save({ product_id: 99, expected_alias: '', product_alias: 'a' }, f.actor), { statusCode: 404 });
  await f.service.read({ product_ids: '23,99' }, f.actor);
  const call = f.calls.find(c => c.sql.includes('SELECT p.id'));
  assert.match(call.sql, /p.tenant_id = \?/); assert.doesNotMatch(call.sql, /IS NULL/); assert.deepEqual(call.args, [23, 99, 2]);
});
test('fresh role checks reject read-only writes, allow warehouse and purchase editors, and reject invalid input', async () => {
  const reader = fixture({ roles: ['technical'] });
  await assert.rejects(reader.service.save({ product_id: 23, product_alias: 'a', expected_alias: '' }, reader.actor), { statusCode: 403 });
  for (const role of ['packing', 'procurement', 'admin']) {
    const f = fixture({ roles: [role] });
    await f.service.save({ product_id: 23, product_alias: '别名', expected_alias: '' }, f.actor);
  }
  const f = fixture();
  for (const product_ids of ['', '0', '1.2', '1,a', Array.from({ length: 201 }, (_, i) => i + 1).join(',')]) await assert.rejects(f.service.read({ product_ids }, f.actor), { statusCode: 400 });
  await assert.rejects(f.service.save({ product_id: 23, product_alias: 'a' }, f.actor), { statusCode: 400 });
});
test('only the exact alias route is admitted with matching business permissions', () => {
  const parts = ['api', 'inventory-workflow', 'product-aliases'];
  for (const role of ['packing', 'procurement']) for (const method of ['GET', 'POST']) {
    const actor = session([role]);
    assert.equal(tenantIsolationDecision(actor, parts, method).allowed, true);
    assert.equal(authorizeApiRequest({ method, _session: actor }, parts).allowed, true);
  }
  assert.equal(authorizeApiRequest({ method: 'POST', _session: session(['technical']) }, parts).allowed, false);
  assert.equal(tenantIsolationDecision(session(['packing']), [...parts, 'unreviewed'], 'POST').allowed, false);
});
