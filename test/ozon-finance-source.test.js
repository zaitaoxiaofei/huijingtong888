import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fetchOzonFinanceTransactions } from '../src/ozonClient.js';

const SHOP = { id: 20, name: 'Fixture', ozon_client_id: 'fixture-client', ozon_api_key: 'fixture-key', status: 'active' };
const day = '2026-10-26';
const json = (data, status = 200) => ({ ok: status === 200, status, headers: new Headers(), text: async () => JSON.stringify(data) });
const receipt = { accrual_id: '17', date: day, accrued_category: 'POSTING', unit_number: '123-456-1',
  total_amount: { amount: '-5', currency: 'CNY' }, non_item_fee: [{ type_id: 1, accrued: { amount: '-5', currency: 'CNY' } }] };

test('default finance source uses daily types/accruals with original currency and stable operation identity', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
    return json(calls.length === 1 ? { accrual_types: [{ id: 1, name: 'Acquiring' }] } : { accruals: [receipt], last_id: '' });
  };
  const result = await fetchOzonFinanceTransactions(SHOP, { from: day, to: day });
  assert.deepEqual(calls, [{ path: '/v1/finance/accrual/types', body: {} }, { path: '/v1/finance/accrual/by-day', body: { date: day, last_id: '' } }]);
  assert.equal(result.source_endpoint, '/v1/finance/accrual/by-day');
  assert.equal(result.operations[0].operation_id, 'accrual_by_day:17');
  assert.equal(result.operations[0].rows[0].currency_code, 'CNY'); assert.equal(result.operations[0].rows[0].amount, -5);
});

test('explicit retired source and missing real credentials fail before network IO', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; }); let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
  await assert.rejects(fetchOzonFinanceTransactions(SHOP, { source: 'legacy', from: day, to: day }), { code: 'OZON_FINANCE_LEGACY_RETIRED' });
  await assert.rejects(fetchOzonFinanceTransactions({ id:1 }, { from: day, to: day }), { code: 'OZON_FINANCE_CREDENTIALS_MISSING' });
  assert.equal(calls,0);
});

test('daily throttling fails without old transaction endpoint fallback or fast retry', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; }); const paths = [];
  globalThis.fetch = async url => { paths.push(new URL(url).pathname); return json({message:'Too many requests'},429); };
  await assert.rejects(fetchOzonFinanceTransactions(SHOP, { from: day, to: day }), error=>error.statusCode===429);
  assert.deepEqual(paths,['/v1/finance/accrual/types']);
});

const source = readFileSync(new URL('../src/services/mysql-cutover.js',import.meta.url),'utf8');
const definition = source.match(/export async function syncOzonFinanceRawMysql\([^]*?\n}/)[0].replace('export ','');
function harness(legacyDay = '') {
  const requests = [], writes = [];
  const context=vm.createContext({
    ensureMysqlCutoverEnabled() {}, orderOwnershipTenantScopeMysql: async()=>({id:2}), assertOrderTaskAccessMysql: async()=>{},
    nullableNumber: value=>Number(value)||null, shopsMysql: async()=>[SHOP], activeShopForTenantMysql: async()=>SHOP,
    normalizeFinanceBackfillDateMysql: value=>String(value||'').slice(0,10), dateKeyDaysAgoMysql:()=>day,todayDateKeyMysql:()=>day,
    addDateKeyDaysMysql:(value,count)=>new Date(Date.parse(value+'T00:00:00Z')+count*86400000).toISOString().slice(0,10),
    getOrderProfitFxPolicy:()=>{throw new Error('source must not depend on profit policy');},
    mysqlQueryOne:async()=>({last_legacy_date:legacyDay}),mysqlQuery:async()=>[],mysqlExecute:async()=>{},
    fetchOzonFinanceTransactions:async(shop,options)=>{requests.push({shop,options});return {operations:[{operation_id:'accrual_by_day:17',source_endpoint:'/v1/finance/accrual/by-day',reconciliation:{ok:true}}],requests:2,fetched:1};},
    upsertFinanceOperationMysql:async(...args)=>{writes.push(args);return 1;}
  });
  vm.runInContext(definition,context);
  return { sync:context.syncOzonFinanceRawMysql,requests,writes };
}

test('raw bill ingestion does not inspect or require the profit FX activation policy',async()=>{
  const f=harness();const result=await f.sync({from:day,to:day},{tenantId:2});
  assert.equal(f.requests[0].options.source,'daily_accrual'); assert.equal(result.upserted,1); assert.equal(result.source_endpoint,'/v1/finance/accrual/by-day');
  assert.equal(f.writes[0][2].shop.id,20);
});

test('legacy date boundary is preserved and excluded ranges are explicitly reported',async()=>{
  const f=harness('2026-10-25');const result=await f.sync({from:'2026-10-24',to:day},{tenantId:2});
  assert.equal(f.requests[0].options.from,day);assert.equal(result.shops[0].legacy_through,'2026-10-25'); assert.equal(result.warnings.length,1);
  const g=harness(day);const skipped=await g.sync({from:'2026-10-24',to:day},{tenantId:2});
  assert.equal(g.requests.length,0);assert.equal(g.writes.length,0);assert.equal(skipped.shops[0].status,'skipped_legacy_range');assert.equal(skipped.warnings.length,1);
});
