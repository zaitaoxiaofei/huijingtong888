import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createPerformanceReadQueue, performanceResponseError, isPerformanceRateLimit } from '../src/services/ozon-performance-read-queue.js';
const source = readFileSync(new URL('../src/services/advertising-analytics.js', import.meta.url), 'utf8');
const declaration = name => source.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'))[0];
function fixture() {
  let time = 0; const waits = [];
  const wait = async ms => { waits.push(ms); time += ms; };
  return { waits, wait, now: () => time, run: createPerformanceReadQueue({ now: () => time, wait }) };
}
test('advertising GET requests share a bounded per-shop queue', async () => {
  const f = fixture(), calls = [];
  await Promise.all(Array.from({ length: 6 }, () => f.run(20, 'GET', async () => calls.push(f.now()))));
  assert.deepEqual(calls, [0,1000,2000,3000,4000,5000]);
});
test('429 GETs honor Retry-After, retry only three times, and allow later recovery', async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(f.run(20, 'GET', async () => { calls++; throw Object.assign(Error('quota'), { statusCode: 429, retryAfterMs: 6000 }); }));
  assert.equal(calls, 3); assert.deepEqual(f.waits, [0,6000,6000]);
  assert.equal(await f.run(20, 'GET', async () => 'ok'), 'ok');
});
test('campaign writes and report creation are never automatically retried by the GET queue', async () => {
  for (const method of ['POST','PUT','DELETE']) {
    const f = fixture(); let calls = 0;
    await assert.rejects(f.run(20, method, async () => { calls++; throw Object.assign(Error('quota'), { statusCode: 429 }); }));
    assert.equal(calls, 1); assert.equal(f.waits.length, 0);
  }
});
test('authorization failure or cancellation stops without sending another read', async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(f.run(20, 'GET', async () => { calls++; throw Object.assign(Error('denied'), { statusCode: 403 }); }));
  assert.equal(calls, 1);
  const controller = new AbortController();controller.abort(Error('cancelled'));
  await assert.rejects(f.run(20, 'GET', async () => calls++, { signal: controller.signal }), /cancelled/);
  assert.equal(calls, 1);
});
test('another shop is not blocked by an in-flight read', async () => {
  const f = fixture();let finish;
  const pending = f.run(20, 'GET', () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();await Promise.resolve();
  assert.equal(await f.run(30, 'GET', async () => 30), 30);finish(20);await pending;
});
test('HTTP error metadata retains numeric/date Retry-After and quota status', () => {
  const now = Date.parse('2026-11-12T00:00:00Z');
  for (const [value, delay] of [['5',5000],['Thu, 12 Nov 2026 00:00:10 GMT',10000],['bad',0]]) {
    const e = performanceResponseError('/api/client/statistics/report', { status: 429, headers: new Headers({ 'Retry-After': value }) }, { message: 'quota' }, now);
    assert.equal(e.statusCode, 429);assert.equal(e.retryAfterMs, delay);assert.equal(isPerformanceRateLimit(e), true);
  }
});
function transport({ revoke = false } = {}) {
  const f = fixture();let checks = 0;const calls = [];
  const context = vm.createContext({ AbortController,setTimeout,clearTimeout,Date,Number,String,Math,JSON,Error,
    PERFORMANCE_API_BASE:'https://api-performance.ozon.ru',PERFORMANCE_TIMEOUT_MS:60000,
    runPerformanceRead:f.run,performanceResponseError,
    assertAdvertisingShop:async id => { assert.equal(id,20);if (++checks > 1 && revoke) throw Object.assign(Error('revoked'),{statusCode:403}); },
    advertisingTenantScope:async()=>{throw Error('Missing shop');},
    fetch:async(url,options)=>{calls.push({url,method:options.method,body:options.body});return new Response(JSON.stringify(calls.length===1?{message:'quota'}:{products:[]}),{status:calls.length===1?429:200,headers:{'retry-after':'3'}});}
  });
  vm.runInContext(['performanceRequest','performanceRequestOnce'].map(declaration).join('\n'),context);
  return {context,calls,f};
}
test('production GET retry preserves the page and revalidates the current shop', async () => {
  const h=transport();await h.context.performanceRequest('/api/client/campaign/123/v2/products?page=2',null,{shop_id:20,method:'GET'});
  assert.equal(h.calls.length,2);assert.equal(h.calls[0].url,h.calls[1].url);assert.deepEqual(h.f.waits,[0,3000]);
});
test('revoking shop access after a rate limit prevents the next provider read', async () => {
  const h=transport({revoke:true});await assert.rejects(h.context.performanceRequest('/api/client/campaign',null,{shop_id:20}),/revoked/);
  assert.equal(h.calls.length,1);
});
test('production campaign mutation sends one request on a 429', async () => {
  const h=transport();await assert.rejects(h.context.performanceRequest('/api/client/campaign/123/products',{bids:[]},{shop_id:20,method:'PUT'}),/quota/);
  assert.equal(h.calls.length,1);assert.equal(h.f.waits.length,0);
});
function reportFixture(pollLimited) {
  const calls=[],waits=[];
  const context=vm.createContext({Number,Math,Array,String,Error,isPerformanceRateLimit,
    sleep:async ms=>waits.push(ms),logAdvertisingSyncEvent:async()=>{},
    performanceRequest:async(path,payload)=>{calls.push(path);if(pollLimited&&payload)return {UUID:'fixture-report'};throw Object.assign(Error('quota'),{statusCode:429,retryAfterMs:60000});}
  });
  vm.runInContext(['createAndFetchPerformanceReport','isActiveReportLimitError','classifyAdvertisingSyncError'].map(declaration).join('\n'),context);
  return {context,calls,waits};
}
test('report-creation quota exhaustion never switches endpoints to evade the same limit',async()=>{
  const h=reportFixture(false);
  await assert.rejects(h.context.createAndFetchPerformanceReport('fixture-token',{campaigns:['123'],dateFrom:'2026-11-01',dateTo:'2026-11-02',groupBy:'DATE'}),/quota/);
  assert.equal(h.calls.length,6);assert.ok(h.calls.every(path=>path==='/api/client/statistics/json'));
  assert.ok(h.waits.every(ms=>ms>=60000));
});
test('polling quota exhaustion does not create another report and preserves its UUID',async()=>{
  const h=reportFixture(true);
  await assert.rejects(h.context.createAndFetchPerformanceReport('fixture-token',{campaigns:['123'],dateFrom:'2026-11-01',dateTo:'2026-11-02',groupBy:'DATE'}),e=>e.reportUuid==='fixture-report'&&e.statusCode===429);
  assert.equal(h.calls.length,2);assert.equal(h.calls.filter(path=>path==='/api/client/statistics/json').length,1);
});


test('a partly read campaign catalog cannot become success after quota exhaustion', async () => {
  let calls = 0;
  const context = vm.createContext({ Map, String, isPerformanceRateLimit,
    normalizeCampaignResponse: data => data.list,
    performanceRequest: async () => { if (++calls === 1) return { list: [{ id: '123' }] }; throw Object.assign(Error('quota'), { statusCode: 429 }); }
  });
  vm.runInContext(declaration('fetchPerformanceCampaigns'),context);
  await assert.rejects(context.fetchPerformanceCampaigns('fixture-token'),e=>e.statusCode===429);
  assert.equal(calls,2);
});
test('rate-limited settings hydration does not convert known product settings into empty data', async () => {
  const campaign = { id: '123', productSettingsFetched: true, productSettings: [{ sku: '456', bidRub: 2.5 }] };
  const context = vm.createContext({ isPerformanceRateLimit,
    performanceRequest: async () => { throw Object.assign(Error('quota'),{statusCode:429}); }
  });
  vm.runInContext(declaration('hydrateCampaignProductSettings'),context);
  await assert.rejects(context.hydrateCampaignProductSettings('fixture-token',[campaign]),e=>e.statusCode===429);
  assert.deepEqual(campaign.productSettings,[{sku:'456',bidRub:2.5}]);
  assert.equal(campaign.productSettingsFetched,true);
});
