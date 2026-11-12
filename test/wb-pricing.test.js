import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { wbLogisticsQuote, calculateWbQuote } from '../frontend/admin/utils/wb-pricing.js';
import { calculateProfit } from '../frontend/admin/utils/pricing-tool.js';
import { createWbPlatform } from '../src/services/wb-platform.js';
import { wbRoutePermission } from '../src/server/wb-paths.js';
import { authorizeApiRequest } from '../src/server/authorization.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
const tariff = JSON.parse(readFileSync(new URL('../src/data/wb/logistics-2026-11-11.json', import.meta.url)));
const hefei = tariff.rows.find(row => row.id === 382855);
const input = { saleCny: 100, purchaseCost: 20, weight: 201, length: 20, width: 10, height: 5,
  commissionRate: 20, exchangeRate: 12.4, domesticCost: 2, adRate: 5, returnRate: 10,
  returnLoss: 15, otherRate: 1, targetMargin: 20, discountRate: 30 };

test('WB source snapshot contains all 73 unique warehouses and matches original PDF checksum', () => {
  assert.equal(tariff.version, '2026-11-11');
  assert.equal(tariff.rows.length, 73);
  assert.equal(new Set(tariff.rows.map(row => row.id)).size, 73);
  assert.equal(createHash('sha256').update(readFileSync(new URL('../public/reference/wb-logistics-2026-11-11.pdf', import.meta.url))).digest('hex'), tariff.sha256);
  for (const rule of tariff.rows) {
    assert.equal(rule.light.length, 2); assert.equal(rule.heavy.length, 2);
    assert.ok(rule.maxSumCm > 0 && rule.maxSideCm > 0);
    assert.equal(rule.maxWeightG, rule.id === 357322 ? 20000 : 25000);
  }
});
test('WB rounds actual weight up by 100g before selecting the fee band', () => {
  for (const [weight, billed, freight] of [[1,100,7.8],[200,200,13.6],[201,300,19.4],[300,300,19.4],[301,400,25.2],[400,400,25.2]]) {
    const quote = wbLogisticsQuote(hefei, {...input,weight});
    assert.equal(quote.chargeableWeightG, billed); assert.equal(quote.freight, freight);
  }
  assert.equal(wbLogisticsQuote(hefei, {...input,weight:25000}).freight,1083);
  assert.throws(() => wbLogisticsQuote(hefei,{...input,weight:25001}),/25 公斤/);
  assert.throws(() => wbLogisticsQuote(tariff.rows.find(row=>row.id===357322),{...input,weight:20001}),/20 公斤/);
});
test('WB uses actual weight and enforces each warehouse dimensions', () => {
  assert.equal(wbLogisticsQuote(hefei,{...input,length:100,width:50,height:50}).chargeableWeightG,300);
  assert.throws(() => wbLogisticsQuote(hefei,{...input,length:116}),/单边≤115/);
  assert.throws(() => wbLogisticsQuote(hefei,{...input,length:100,width:60,height:41}),/三边和≤200/);
  assert.throws(() => wbLogisticsQuote(tariff.rows[0],{...input,length:61}),/单边≤60/);
  for (const weight of [0,-1,NaN,Infinity]) assert.throws(() => wbLogisticsQuote(hefei,{...input,weight}),/实重/);
});
test('WB profit and reverse pricing retain shared fees and reach the same target margin', () => {
  const pricing = calculateWbQuote('pricing',input,hefei);
  const profit = calculateWbQuote('profit',{...input,saleCny:pricing.saleCny},hefei);
  assert.equal(pricing.profit,profit.profit);
  assert.ok(Math.abs(pricing.margin-20)<0.03);
  assert.equal(profit.expectedReturnLoss,1.5);
  assert.deepEqual(profit,{...calculateProfit({...input,saleCny:pricing.saleCny,freight:19.4}),shipping:pricing.shipping});
  assert.throws(()=>calculateWbQuote('profit',{...input,commissionRate:null},hefei),/WB 类目佣金/);
  assert.ok(calculateWbQuote('pricing',{...input,commissionRate:0},hefei).saleCny>0);
});
test('WB commission access requires the exact route, enterprise context, and shop ownership', async () => {
  const member={roles:['operations'],tenant:{id:2,slug:'customer',role:'member'}};
  assert.equal(wbRoutePermission(['api','wb','pricing-commissions'],'GET'),'orders.read');
  assert.equal(wbRoutePermission(['api','wb','pricing-commissions','extra'],'GET'),null);
  assert.equal(tenantIsolationDecision(member,['api','wb','pricing-commissions'],'GET').allowed,true);
  assert.equal(authorizeApiRequest({method:'GET',_session:{platform_role:'super_admin'}},['api','wb','pricing-commissions']).allowed,false);
  const service=createWbPlatform({query:async()=>[],request:async()=>assert.fail('foreign credential accessed')});
  await assert.rejects(service.pricingCommissions(2,{shop_id:42}),error=>error.statusCode===404);
});
test('WB commissions use only kgvpChina, project safe fields, and share cached reads', async () => {
  let requests=0;
  const service=createWbPlatform({query:async()=>[{tenant_id:882,shop_id:883,token:'private',environment:'production',checked_at:'yes',seller_id:'s'}],request:async(a,service,path,options)=>{
    requests++; assert.equal(service,'common'); assert.equal(path,'/api/v1/tariffs/commission'); assert.equal(options.query.locale,'zh');
    return {report:[{subjectID:1,subjectName:'衣服',parentName:'服装',kgvpChina:20,kgvpMarketplace:99,private:'secret'},
      {subjectID:2,kgvpChina:null},{subjectID:3,kgvpMarketplace:30},{subjectID:4,kgvpChina:0}]};
  }});
  const [a,b]=await Promise.all([service.pricingCommissions(882,{shop_id:883}),service.pricingCommissions(882,{shop_id:883})]);
  assert.equal(requests,1); assert.deepEqual(a,b);
  assert.deepEqual(a.rows,[{id:1,category:'衣服',parent:'服装',rate:20},{id:4,category:'',parent:'',rate:0}]);
  assert.equal(JSON.stringify(a).includes('private'),false);
});
