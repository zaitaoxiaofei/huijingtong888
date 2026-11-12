import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fetchDurablePerformanceReport, hasPerformanceReportRows } from '../src/services/ozon-performance-report.js';

const payload = { campaigns: ['123'], dateFrom: '2026-11-01', dateTo: '2026-11-02', groupBy: 'DATE' };
function fixture() {
  let stored, count = 0, time = 0;
  const calls = [], completed = [];
  const checkpoints = {
    async claim() {
      if (stored && (!stored.uuid || stored.next_poll_at > time)) throw Object.assign(Error('pending'), { code: 'OZON_AD_REPORT_PENDING' });
      if (stored) return { ...stored, resumed: true };
      stored = { attempt: ++count }; return { ...stored };
    },
    async save(handle, uuid) { stored.uuid = uuid; },
    async defer(handle, delay = 60000) { stored.next_poll_at = time + delay; },
    async unknown() { stored.state = 'unknown'; },
    async rejected() { stored = undefined; }
  };
  const options = { checkpoints, completed, signal: new AbortController().signal,
    request: async (path, body) => { calls.push([path, body]); return body ? { UUID: 'uuid-1' } : { status: 'ready', rows: [] }; },
    wait: async ms => { time += ms; }, ready: data => !data.status || data.status === 'ready',
    activeLimit: error => error.statusCode === 429, rateLimit: error => error.statusCode === 429,
    log: async () => {}, retryDelayMs: 5000, initialDelayMs: 2000, pollDelayMs: 3000, missingDelayMs: 3000, pollAttempts: 2
  };
  return { options, calls, completed, stored: () => stored, advance: ms => { time += ms; } };
}
test('ready report keeps its persisted UUID until the caller imports successfully', async () => {
  const f = fixture();
  assert.deepEqual(await fetchDurablePerformanceReport(payload, f.options), { status: 'ready', rows: [] });
  assert.equal(f.stored().uuid, 'uuid-1');assert.equal(f.completed[0].uuid, 'uuid-1');
});
test('a resumed UUID is queried without another create, including an import retry', async () => {
  const f = fixture();
  await fetchDurablePerformanceReport(payload, f.options);
  await fetchDurablePerformanceReport(payload, { ...f.options, completed: [] });
  assert.equal(f.calls.filter(([, body]) => body).length, 1);
  assert.equal(f.calls[2][0], '/api/client/statistics/report?UUID=uuid-1');
});
test('429 saves Retry-After and the original UUID; next run does not create again', async () => {
  const f = fixture(), request = f.options.request;
  f.options.request = async (path, body) => body ? request(path, body) : Promise.reject(Object.assign(Error('quota'), { statusCode: 429, retryAfterMs: 120000 }));
  await assert.rejects(fetchDurablePerformanceReport(payload, f.options), e => e.reportUuid === 'uuid-1');
  await assert.rejects(fetchDurablePerformanceReport(payload, f.options), e => e.code === 'OZON_AD_REPORT_PENDING');
  f.advance(120000);f.options.request = request;
  await fetchDurablePerformanceReport(payload, f.options);
  assert.equal(f.calls.filter(([, body]) => body).length, 1);
});
test('temporary 404 and status-only completion never create a replacement or publish empty data', async () => {
  for (const response of [{ status: 'ready' }, { status: 'running' }, null]) {
    const f = fixture(), request = f.options.request;
    f.options.request = async (path, body) => body ? request(path, body) : response || Promise.reject(Object.assign(Error('report not found'), { statusCode: 404 }));
    await assert.rejects(fetchDurablePerformanceReport(payload, f.options), e => e.code === 'OZON_AD_REPORT_PENDING' && e.reportUuid === 'uuid-1');
    assert.equal(f.calls.length, 1);assert.equal(f.completed.length, 0);assert.equal(f.stored().uuid, 'uuid-1');
  }
});
test('uncertain create failures and a missing UUID block blind resubmission across runs', async () => {
  for (const failure of [Error('timeout'), Object.assign(Error('server error'), { statusCode: 503 }), {}]) {
    const f = fixture();let calls = 0;
    f.options.request = async () => { calls++;if (failure instanceof Error) throw failure;return failure; };
    for (let i = 0; i < 2; i++) await assert.rejects(fetchDurablePerformanceReport(payload, f.options), e => e.code === 'OZON_AD_REPORT_PENDING');
    assert.equal(calls, 1);assert.equal(f.stored().state, 'unknown');
  }
});
test('only a definitive unsupported create endpoint permits the alternate endpoint', async () => {
  const f = fixture(), request = f.options.request;
  f.options.request = async (path, body) => {
    if (path === '/api/client/statistics/json') { f.calls.push([path, body]);throw Object.assign(Error('unsupported'), { statusCode: 404 }); }
    return request(path, body);
  };
  await fetchDurablePerformanceReport(payload, f.options);
  assert.deepEqual(f.calls.filter(([, body]) => body).map(([path]) => path), ['/api/client/statistics/json', '/api/client/statistics/products/json']);
});
test('revoked authorization stops polling immediately and retains the original receipt', async () => {
  const f = fixture(), request = f.options.request;let polls = 0;
  f.options.request = async (path, body) => { if (body) return request(path, body);polls++;throw Object.assign(Error('revoked'), { statusCode: 403 }); };
  await assert.rejects(fetchDurablePerformanceReport(payload, f.options), /revoked/);
  assert.equal(polls, 1);assert.equal(f.stored().uuid, 'uuid-1');
});
test('cancellation after receipt persistence retains the UUID for recovery', async () => {
  const f = fixture();
  f.options.wait = async () => { throw Error('cancelled'); };
  await assert.rejects(fetchDurablePerformanceReport(payload, f.options), /cancelled/);
  assert.equal(f.stored().uuid, 'uuid-1');assert.equal(f.completed.length, 0);
});
test('supported empty report bodies differ from status-only, raw text and malformed bodies', () => {
  for (const data of [[], { rows: [] }, { result: { rows: [] } }, { '123': { report: { rows: [] } } }]) assert.equal(hasPerformanceReportRows(data), true);
  for (const data of [null, {}, { status: 'done' }, { raw: '<html>error</html>' }, { '123': { report: {} } }]) assert.equal(hasPerformanceReportRows(data), false);
});
test('rolling-date recovery uses the original report window and settles only that window', async () => {
  const source = readFileSync(new URL('../src/services/advertising-analytics.js', import.meta.url), 'utf8');
  const declaration = source.match(/^async function fetchPerformanceSkuStats\([^]*?^}/m)[0];
  const seen = [];
  const context = vm.createContext({ Number, Math, String, Set, Array,
    splitDateRange: () => [{ from: '2026-11-03', to: '2026-11-04' }],
    createAndFetchPerformanceReport: async (token, body) => { seen.push(body);return { rows: [{ date: body.dateFrom }] }; },
    flattenPerformanceReportRows: report => report.rows
  });
  vm.runInContext(declaration, context);
  const result = await context.fetchPerformanceSkuStats('fake', { campaigns: [{ id: '123' }], saved_reports: [{ payload }], from: '2026-11-03', to: '2026-11-04' });
  assert.equal(seen.length, 1);assert.equal(seen[0].dateFrom, '2026-11-01');assert.equal(result[0].date, '2026-11-01');
  assert.equal(result.reportStats.settledReports[0].dateTo, '2026-11-02');
});
test('reducing the campaign batch size still resumes the entire original report', async () => {
  const source = readFileSync(new URL('../src/services/advertising-analytics.js', import.meta.url), 'utf8');
  const declaration = source.match(/^async function fetchPerformanceSkuStats\([^]*?^}/m)[0];
  const seen = [];
  const context = vm.createContext({ Number, Math, String, Set, Array,
    splitDateRange: () => [{ from: payload.dateFrom, to: payload.dateTo }],
    createAndFetchPerformanceReport: async (token, body) => { seen.push(body);return { rows: [] }; },
    flattenPerformanceReportRows: report => report.rows
  });
  vm.runInContext(declaration, context);
  await context.fetchPerformanceSkuStats('fake', { campaigns: [{ id: '123' }], saved_reports: [{ payload: { ...payload, campaigns: ['123','456'] } }],
    from: payload.dateFrom, to: payload.dateTo, campaign_chunk_size: 1 });
  assert.equal(seen.length, 1);assert.deepEqual(Array.from(seen[0].campaigns), ['123','456']);
});
test('cancelling quota backoff releases a definitively rejected creation claim', async () => {
  const f = fixture();
  f.options.request = async () => { throw Object.assign(Error('quota'), { statusCode: 429 }); };
  f.options.wait = async () => { throw Error('cancelled'); };
  await assert.rejects(fetchDurablePerformanceReport(payload, f.options), /cancelled/);
  assert.equal(f.stored(), undefined);
});
