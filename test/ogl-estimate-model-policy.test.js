import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {runInNewContext} from 'node:vm';
import {OGL_EFFECTIVE_FROM,selectOglOrderRule} from '../src/ogl-rates.js';import {getProfitFormula} from '../src/services/profit-formulas/registry.js';
const source=fs.readFileSync(new URL('../src/services/mysql-cutover.js',import.meta.url),'utf8');
const functions=['oglEstimateLogisticsRuleMysql','productForProfitEstimateMysql','productWithLogisticsRuleMysql','productWithOglOrderRateMysql'].map(name=>source.match(new RegExp('^async function '+name+'\\([^]*?^}|^function '+name+'\\([^]*?^}', 'm'))?.[0]).join('\n');
const rules=[{id:70,name:'OGL 陆运 Extra Small',carrier:'OGL',channel:'economy',min_weight_g:1,max_weight_g:500,min_price_rub:1,max_price_rub:1500,base_fee_cny:0,per_gram_cny:.0242,per_ticket_cny:2.8},{id:72,name:'OGL 陆运 Small',carrier:'OGL',channel:'economy',min_weight_g:1,max_weight_g:2000,min_price_rub:1501,max_price_rub:7000,base_fee_cny:0,per_gram_cny:.0242,per_ticket_cny:15.5}];
function fixture({carrier='OGL',value=1240.09,weight=300,dimensions=[30,20,10]}={}){
 const product={id:1041,tenant_id:1,logistics_rule_id:72,logistics_rule_carrier:carrier,purchase_cost:27,package_weight_g:weight,length_cm:dimensions[0],width_cm:dimensions[1],height_cm:dimensions[2],exchange_rate:12.4009};let actualCalls=0;const queries=[];
 const context=runInNewContext(`${functions};({productForProfitEstimateMysql})`,{OGL_EFFECTIVE_FROM,selectOglOrderRule,
  ensureLogisticsRuleFilterSchemaMysql:async()=>{},mysqlQueryOne:async()=>({...product}),getOrderProfitFxPolicy:async()=>false,
  normalizeMysqlDateTime:value=>String(value).replace('T',' ').replace('Z',''),
  readableLogisticsTenantScopeMysql:async(tenantId)=>({sql:'(candidate.tenant_id = ? OR (candidate.tenant_id IS NULL AND candidate.carrier = \'OGL\'))',params:[tenantId]}),
  mysqlQuery:async(sql,params)=>{queries.push({sql,params:Array.from(params)});return rules;},
  oglOrderParcelValueRubMysql:async()=>value,cbrCnyRateForDate:async()=>({rate:12.4009}),
  actualOrderLogisticsRuleMysql:async()=>{actualCalls++;return {...rules[0],id:39,name:'CEL 陆空标准 Extra Small',carrier:'CEL'};},
  productWithoutLogisticsRuleMysql:p=>p,
 });
 return {load:posting=>context.productForProfitEstimateMysql(1041,posting.ordered_at,posting),actualCalls:()=>actualCalls,queries,product};
}
const posting={order_id:1,ordered_at:'2026-11-13 06:01:04',delivery_method:'CEL FBP Standard',warehouse_name:'Hunchun 2',profitFxState:{orderFx:{rate:12.4009}}};
test('an OGL inventory estimate stays OGL when physical fulfillment is CEL FBP',async()=>{
 const f=fixture(),before=structuredClone(posting),product=await f.load(posting);
 assert.equal(product.logistics_rule_carrier,'OGL');assert.equal(product.logistics_rule_id,70);assert.equal(product.logistics_rule_source,'product_ogl_estimate');assert.equal(f.actualCalls(),0);assert.deepEqual(posting,before);
 const estimate=getProfitFormula('V1').estimateItemProfit({salePrice:100,quantity:1,product,mapping:{commission_low:.12,commission_high:.17}});assert.equal(estimate.freight,12.06);
 assert.deepEqual(f.queries[0].params,[1,'2026-11-13 06:01:04','2026-11-13 06:01:04']);assert.match(f.queries[0].sql,/WHERE \(candidate.tenant_id = \?/);
});
test('OGL estimate selects the band from order value rather than a saved low-price band or physical service class',async()=>{
 const f=fixture({value:2000}),p=await f.load({...posting,delivery_method:'CEL Extra Small'});assert.equal(p.logistics_rule_id,72);assert.equal(p.logistics_rule_carrier,'OGL');assert.equal(f.actualCalls(),0);
});
test('zero weight keeps the existing 10g floor without changing inventory weight',async()=>{
 const f=fixture({weight:0}),p=await f.load(posting);assert.equal(p.package_weight_g,0);assert.equal(f.product.package_weight_g,0);
 assert.equal(getProfitFormula('V1').estimateItemProfit({salePrice:100,quantity:1,product:p,mapping:{commission_low:.12,commission_high:.17}}).freight,5.04);
});
test('an invalid OGL estimate cannot silently fall back to CEL actual delivery rates',async()=>{
 const f=fixture({dimensions:[300,20,10]});await assert.rejects(f.load(posting),{statusCode:409});assert.equal(f.actualCalls(),0);
});
test('products that did not select OGL retain their existing estimation path',async()=>{
 const f=fixture({carrier:'CEL'}),p=await f.load(posting);assert.equal(p.logistics_rule_carrier,'CEL');assert.equal(f.actualCalls(),1);assert.equal(f.queries.length,0);
});
test('orders before OGL activation retain the historical carrier selection path',async()=>{
 const f=fixture(),p=await f.load({...posting,ordered_at:'2026-10-01 00:00:00'});assert.equal(p.logistics_rule_carrier,'CEL');assert.equal(f.actualCalls(),1);
});
