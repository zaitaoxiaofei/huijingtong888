import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createOrderReadDiagnostics } from '../src/services/order-read-diagnostics.js';

const runtime = readFileSync(new URL('../src/services/mysql-runtime-services.js', import.meta.url), 'utf8');
const block = runtime.slice(runtime.indexOf('  procurementRequests: async'), runtime.indexOf('  procurementBindingSuggestions:'));
function fixture(run, logger) {
  let time = 0;
  const lines = [], calls = [];
  const context = vm.createContext({
    createOrderReadDiagnostics: area => createOrderReadDiagnostics(area, {
      clock: () => time, logger: logger || (line => lines.push(JSON.parse(line)))
    }),
    procurementRequestsMysql: async (...args) => { calls.push(args); return run(args, value => { time += value; }); }
  });
  return { handler: vm.runInContext(`({${block}}).procurementRequests`, context), lines, calls };
}

test('the real procurement facade records successive stages and only safe numeric counters', async () => {
  const rows = [{ private_customer: 'do-not-log', secret_order: 999 }];
  const response = { rows, total: 71, page: 2, pageSize: 30 };
  const f = fixture(async ([query, tenant, { diagnostics }], advance) => {
    assert.equal(tenant, 'private-tenant'); assert.equal(query.search, 'private-search');
    for (const stage of ['scope', 'schema', 'coverage', 'filters', 'page_ids', 'details', 'projection', 'workflow', 'gaps']) {
      advance(200); diagnostics.mark(stage);
    }
    return response;
  });
  assert.equal(await f.handler({ grouped: '1', search: 'private-search' }, 'private-tenant'), response);
  assert.equal(f.lines.length, 1);
  const line = f.lines[0];
  assert.equal(line.event, 'procurement_read_slow'); assert.equal(line.total_ms, 1800);
  assert.deepEqual(line.stages.map(stage => stage.name), ['scope', 'schema', 'coverage', 'filters', 'page_ids', 'details', 'projection', 'workflow', 'gaps']);
  assert.ok(line.stages.every(stage => stage.ms === 200));
  assert.deepEqual(line.counts, { rows: 1, page: 2, page_size: 30, total: 71, grouped: true });
  assert.doesNotMatch(JSON.stringify(line), /private|customer|search|secret|999/);
});

test('fast procurement reads remain silent and failed reads preserve their original exception', async () => {
  const fast = fixture(async (_args, advance) => { advance(20); return { rows: [] }; });
  assert.deepEqual(await fast.handler(), { rows: [] }); assert.deepEqual(fast.lines, []);
  const error = new Error('private SQL parameters');
  const failed = fixture(async ([,,{ diagnostics }], advance) => { advance(1100); diagnostics.mark('coverage'); throw error; });
  await assert.rejects(failed.handler({}, 2), value => value === error);
  assert.deepEqual(failed.lines[0].counts, { failed: true });
  assert.doesNotMatch(JSON.stringify(failed.lines), /parameters|SQL/);
});

test('logger failures cannot break successful procurement reads', async () => {
  const expected = { rows: [], total: 0 };
  const f = fixture(async (_args, advance) => { advance(2000); return expected; }, () => { throw Error('log unavailable'); });
  assert.equal(await f.handler({ grouped: '1' }, 2), expected);
});
