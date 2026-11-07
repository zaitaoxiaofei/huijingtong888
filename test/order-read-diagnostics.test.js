import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrderReadDiagnostics } from '../src/services/order-read-diagnostics.js';

function fixture(options = {}) {
  let time = 0;
  const lines = [];
  const diagnostics = createOrderReadDiagnostics('ordersPagedMysql', { clock: () => time, logger: line => lines.push(line), ...options });
  return { diagnostics, lines, advance(ms) { time += ms; }, read() { return JSON.parse(lines[0]); } };
}

test('sequential marks and measured operations preserve values and the original error', async () => {
  const f = fixture();
  f.advance(20); f.diagnostics.mark('scope');
  f.advance(30); f.diagnostics.mark('schema');
  const value = { rows: [1, 2] };
  assert.equal(await f.diagnostics.measure('core_sql', async () => { f.advance(80); return value; }), value);
  const error = new Error('private SQL error and tenant identifier');
  await assert.rejects(f.diagnostics.measure('enrich', async () => { f.advance(1000); throw error; }), actual => actual === error);
  f.diagnostics.finish({ rows: 2, failed: true });
  assert.deepEqual(f.read(), { event: 'order_read_slow', area: 'ordersPagedMysql', total_ms: 1130,
    stages: [{ name: 'scope', ms: 20 }, { name: 'schema', ms: 30 }, { name: 'core_sql', ms: 80 }, { name: 'enrich', ms: 1000 }], counts: { rows: 2, failed: true } });
});

test('only a slow total wall-clock duration logs and finishing is idempotent', () => {
  const fast = fixture(); fast.advance(999); fast.diagnostics.finish({ rows: 4 });
  fast.advance(5000); fast.diagnostics.finish({ rows: 5 }); assert.equal(fast.lines.length, 0);
  const slow = fixture(); slow.advance(1000); slow.diagnostics.finish({ rows: 3 });
  slow.advance(2000); slow.diagnostics.mark('metadata'); slow.diagnostics.finish({ rows: 9 });
  assert.equal(slow.lines.length, 1); assert.equal(slow.read().total_ms, 1000); assert.equal(slow.read().counts.rows, 3);
  const custom = fixture({ thresholdMs: 50 }); custom.advance(50); custom.diagnostics.finish(); assert.equal(custom.lines.length, 1);
});

test('only fixed areas, stages and finite numeric or boolean counters can reach the logger', async () => {
  const f = fixture();
  const privateText = 'SELECT private tenant=123 sku=SECRET order_name=Customer';
  assert.equal(await f.diagnostics.measure(privateText, () => 'result'), 'result');
  f.diagnostics.mark(privateText); f.diagnostics.mark({ toString() { throw Error('must not stringify'); } });
  f.advance(1000);
  const details = { rows: 8, page: 1, page_size: 50, include_counts: true, include_inventory: 0,
    summary_only: false, total: Infinity, count: NaN, failed: false, tenant: 123, query: privateText,
    sql: privateText, id: 123, name: 'Customer', error: new Error(privateText) };
  Object.defineProperty(details, 'unknownGetter', { enumerable: true, get() { throw Error('unknown properties must not be read'); } });
  f.diagnostics.finish(details);
  assert.deepEqual(f.read().counts, { rows: 8, page: 1, page_size: 50, include_counts: true, include_inventory: 0, summary_only: false, failed: false });
  assert.deepEqual(f.read().stages, []);
  assert.doesNotMatch(f.lines[0], /SELECT|private|tenant|123|sku|SECRET|Customer|query|error/);
  const lines = [];
  const unknown = createOrderReadDiagnostics(privateText, { thresholdMs: 0, logger: line => lines.push(line) });
  assert.equal(await unknown.measure('core_sql', async () => 42), 42); unknown.finish({ rows: 1 }); assert.deepEqual(lines, []);
  const strings = fixture({ thresholdMs: 0 }); strings.diagnostics.finish({ rows: privateText, page: -2, count: {}, failed: privateText });
  assert.deepEqual(strings.read().counts, {});
});

test('parallel measurements retain their own intervals without adding them to total time', async () => {
  const f = fixture();
  let releaseA, releaseB;
  const a = f.diagnostics.measure('quality', () => new Promise(resolve => { releaseA = resolve; }));
  const b = f.diagnostics.measure('fbp', () => new Promise(resolve => { releaseB = resolve; }));
  f.advance(1000); releaseA('a'); await a;
  f.advance(500); releaseB('b'); await b;
  f.diagnostics.mark('page_rows'); f.diagnostics.finish({ rows: 2 });
  assert.equal(f.read().total_ms, 1500);
  assert.deepEqual(f.read().stages, [{ name: 'quality', ms: 1000 }, { name: 'fbp', ms: 1500 }, { name: 'page_rows', ms: 1500 }]);
});

test('logger and clock failures never alter business results or original errors', async () => {
  const f = fixture({ thresholdMs: 0, logger() { throw Error('logger failed'); } });
  assert.equal(await f.diagnostics.measure('rows', () => 7), 7); assert.doesNotThrow(() => f.diagnostics.finish());
  const asyncLogger = fixture({ thresholdMs: 0, logger: async () => { throw Error('async logger failed'); } });
  asyncLogger.diagnostics.finish(); await Promise.resolve(); await Promise.resolve();
  let calls = 0;
  const lines = [];
  const broken = createOrderReadDiagnostics('ordersPagedMysql', { clock() { if (++calls > 1) throw Error('clock failed'); return 0; }, logger: line => lines.push(line), thresholdMs: 0 });
  const error = new Error('business error');
  await assert.rejects(broken.measure('core_sql', () => { throw error; }), actual => actual === error);
  broken.mark('rows'); broken.finish({ failed: true }); assert.deepEqual(lines, []);
  const invalidClock = createOrderReadDiagnostics('ordersPagedMysql', { clock: () => NaN, thresholdMs: 0, logger: line => lines.push(line) });
  assert.equal(await invalidClock.measure('rows', () => 8), 8); invalidClock.finish(); assert.deepEqual(lines, []);
  const initialFailure = createOrderReadDiagnostics('ordersPagedMysql', { clock() { throw Error('first clock'); }, logger: line => lines.push(line) });
  assert.equal(await initialFailure.measure('rows', () => 9), 9); initialFailure.finish(); assert.deepEqual(lines, []);
});

test('all three fixed areas and the integration stages are accepted without logging response data', async () => {
  for (const area of ['ordersPagedMysql','orderPageRowsMysql','orderRowsByIdsMysql']) {
    let time = 0;
    const lines = [];
    const d = createOrderReadDiagnostics(area, { clock: () => time, logger: line => lines.push(line), thresholdMs: 0 });
    for (const stage of ['id_selection','page_rows','core_sql','raw_payload','quality','fbp','ogl','billing','logistics_dictionary','profit_labels','logistics_rows','inventory_balances','metadata']) {
      await d.measure(stage, async () => { time++; return { private: 'never logged' }; });
    }
    d.finish({ rows: 3 });
    const row = JSON.parse(lines[0]); assert.equal(row.area, area); assert.equal(row.stages.length, 13); assert.doesNotMatch(lines[0], /private|never logged/);
  }
});
