import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/services/mysql-cutover.js', import.meta.url), 'utf8');
const definition = source.match(/export async function backfillOzonFinanceMysql\([^]*?\n}/)[0].replace('export ', '');
function fixture(raw = {}) {
  const calls = [], logs = [];
  const shop = { id: 20, name: 'A', status: 'active' };
  const context = vm.createContext({ Number, Boolean, Math, Object,
    ensureMysqlCutoverEnabled() {}, orderOwnershipTenantScopeMysql: async () => ({ id: 2 }), assertOrderTaskAccessMysql: async () => {},
    nullableNumber: value => Number(value) || null, normalizeFinanceBackfillDateMysql: value => value || '', todayDateKeyMysql: () => '2026-11-01',
    shopsMysql: async () => [shop], activeShopForTenantMysql: async () => shop, earliestFinanceBackfillOrderDateMysql: async () => '2026-10-01',
    splitFinanceBackfillWindowsMysql: (from, to) => [{ from, to }], financeBackfillWindowCoverageMysql: async () => ({ finance_rows: 10 }),
    syncOzonFinanceRawMysql: async body => { calls.push(body);return { fetched: 0, upserted: 0, requests: 0, errors: [], warnings: [], shops: [], ...raw }; },
    applyOzonFinanceToOrdersMysql: async () => { throw Error('Profit application was not requested'); },
    mysqlExecute: async (sql, args) => logs.push(args)
  });
  vm.runInContext(definition, context);
  return { run: body => context.backfillOzonFinanceMysql({ shop_id: 20, from: '2026-10-01', to: '2026-11-01', ...body }, { tenantId: 2 }), calls, logs };
}
test('excluded legacy periods remain visible and cannot produce a complete success', async () => {
  const f = fixture({ warnings: ['Legacy overlap requires reconciliation'], source_endpoint: '/v1/finance/accrual/by-day',
    shops: [{ shop_id: 20, source_from: '2026-11-02', legacy_through: '2026-11-01', status: 'skipped_legacy_range' }] });
  const result = await f.run({ write: true });
  assert.equal(result.ok, false);assert.equal(result.status, 'needs_reconciliation');assert.equal(result.warnings.length, 1);
  const range = result.shops[0].ranges[0];assert.equal(range.status, 'needs_reconciliation');
  assert.equal(range.source_shops[0].legacy_through, '2026-11-01');assert.equal(range.source_endpoint, '/v1/finance/accrual/by-day');
  assert.equal(f.logs[0][1], 'needs_reconciliation');assert.match(f.logs[0][2], /Legacy overlap/);
});
test('partial source errors propagate even when some records were imported', async () => {
  const f = fixture({ fetched: 1, upserted: 1, errors: ['Provider page failed'] });
  const result = await f.run({ write: true });
  assert.equal(result.ok, false);assert.equal(result.status, 'partial_error');assert.equal(result.errors.length, 1);
  assert.equal(result.shops[0].ranges[0].status, 'partial_error');assert.equal(result.upserted, 1);
});
test('a successfully read empty result remains distinguishable from a skipped range', async () => {
  const f = fixture({ requests: 2, shops: [{ shop_id: 20, status: 'ok' }] });
  const result = await f.run({ write: true });assert.equal(result.ok, true);assert.equal(result.status, 'ok');assert.equal(result.requests, 2);
  assert.equal(result.warnings.length, 0);assert.equal(result.shops[0].ranges[0].status, 'ok');
});
test('dry-run coverage is audit-only and does not read Ozon or write sync logs', async () => {
  const f = fixture();const result = await f.run({ write: false });
  assert.equal(result.status, 'audit_only');assert.equal(f.calls.length, 0);assert.equal(f.logs.length, 0);
});
test('an explicitly foreign shop is rejected before any bill collection', async () => {
  const f = fixture();await assert.rejects(f.run({ shop_id: 30, write: true }), error => error.statusCode === 404);assert.equal(f.calls.length, 0);
});
