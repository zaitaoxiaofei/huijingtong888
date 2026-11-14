import test from 'node:test';import assert from 'node:assert/strict';
import {readLegacyDailyFinance,planLegacyDailySettlement} from '../src/services/legacy-daily-accrual-settlement.js';
import {getProfitFormula} from '../src/services/profit-formulas/registry.js';
import {order,items,row,rows,siblings,plan,classifyCategory} from './helpers/legacy-daily-fixture.js';

test('legacy order consumes new signed income and allocated parent acquiring at archived operation FX',async()=>{
 const result=await plan();assert.equal(result.ok,true);assert.equal(result.items[0].otherFee,1);assert.equal(result.items[0].actualProfit,51);assert.equal(result.items[0].actualInternationalShipping,15);assert.equal(result.allocation.share,.5);
 const revised=rows().map(r=>{const raw=JSON.parse(r.raw_json);raw._erp_fx_archive.rate=20;r.raw_json=JSON.stringify(raw);for(const key of ['amount','accruals_for_sale','sale_commission','delivery_charge','return_delivery_charge'])r[key+'_cny']=r[key]/20;return r;});const next=await plan(revised);assert.equal(next.items[0].actualInternationalShipping,7.5);assert.equal(next.items[0].actualProfit,14);
});
test('each original income event counts once; CNY is never divided again',async()=>{
 const r=rows();r.push(row(5,'income',10,{currency:'CNY',income:10}));assert.equal((await plan(r)).items[0].itemSale,110);
});
test('mixed sources, incomplete operations, unknown currency, broken FX and wrong shops stay blocked',async()=>{
 for(const mutate of [r=>r[0].operation_id='legacy-1',r=>r[0].currency_code='',r=>r[0].amount_cny=999,r=>r[0].shop_id=6,r=>r[0].raw_json='{}',r=>r.push({...r[0]})]){
  const r=rows();mutate(r);await assert.rejects(async()=>{const p=await plan(r);if(!p.ok)throw Error(p.code);});
 }
 const r=rows();const raw=JSON.parse(r[0].raw_json);raw._normalization.reconciliation.total_amount=900;r[0].raw_json=JSON.stringify(raw);assert.equal((await plan(r)).code,'LEGACY_DAILY_OPERATION_INCOMPLETE');
});
test('missing actual collecting fee or purchase cost cannot turn an estimate into actual profit',async()=>{
 assert.equal((await plan(rows().slice(0,3))).code,'LEGACY_DAILY_FINAL_BILL_INCOMPLETE');
 assert.equal((await plan(rows(),[{...items[0],frozen_purchase_cost:0}])).code,'LEGACY_DAILY_PURCHASE_COST_PENDING');
});
test('allocation conserves cents and protects manual historical packaging costs',async()=>{
 const its=[{...items[0],sale_price:30,packaging_cost_cny:.3},{...items[0],id:12,sale_price:70,packaging_cost_cny:.5}];const p=await plan(rows(),its);assert.equal(p.items.reduce((s,r)=>s+r.itemSale,0),100);assert.equal(p.items.reduce((s,r)=>s+r.otherFee,0),1);assert.deepEqual(p.items.map(r=>r.packagingCost),[.3,.5]);
 assert.equal(getProfitFormula('V5').aggregateActualProfit,getProfitFormula('V1').aggregateActualProfit);
});

test('a proven earlier legacy parent acquiring fee can supplement later daily child bills',async()=>{
 const r=rows();r[3]={...r[3],operation_id:'legacy-acquiring-4',operation_date:'2026-11-10 00:00:00',raw_json:'{}',exchange_rate:10};
 assert.equal((await plan(r)).items[0].actualProfit,51);
 r[3].operation_date='2026-11-12 00:00:00';assert.equal((await plan(r)).code,'FX_FINANCE_SOURCE_MIXED');
 r[3].operation_date='2026-11-10 00:00:00';r[3].posting_number='100-200-1';assert.equal((await plan(r)).code,'FX_FINANCE_SOURCE_MIXED');
});
test('positive non-income credits are held for review instead of disappearing from actual profit',async()=>{
 const r=rows();r.push(row(8,'other',10));assert.equal((await plan(r)).code,'LEGACY_DAILY_CREDIT_REVIEW_REQUIRED');
});

test('a one-cent parent fee is conserved across three sibling postings',async()=>{
 const source=[row(4,'collecting_fee',-.1,{posting:'100-200'})];const siblings=[1,2,3].map(n=>({shop_id:5,posting_number:`100-200-${n}`,order_id:n,order_item_id:10+n,sale_price:100,quantity:1}));
 const shares=[];
 for(const n of [1,2,3]){const value=await readLegacyDailyFinance({order:{...order,posting_number:`100-200-${n}`},items,classifyCategory,query:async sql=>sql.includes('FROM ozon_finance_items')?source:sql.includes('FROM order_profit_daily_fx')?[JSON.parse(source[0].raw_json)._erp_fx_archive]:siblings});shares.push(-value.category_signed_totals_cny.collecting_fee);}
 assert.equal(Math.round(shares.reduce((a,b)=>a+b,0)*100)/100,.01);assert.deepEqual(shares.map(n=>n||0),[0,0,.01]);
});

test('explicit user confirmation is limited to the exact shop, operation and finance row',async()=>{
 const source=[{...row(4,'collecting_fee',-6.62,{posting:'100-200'}),operation_id:'old-acquiring',currency_code:'',exchange_rate:11.32,amount_cny:-.58,operation_date:'2026-11-10 00:00:00',raw_json:'{}'}];
 const evidence={shop_id:5,operation_id:'old-acquiring',finance_item_id:4,verified:true,currency_code:'RUB',source:'user_confirmation',reference:'chat:2026-11-14:confirmed old acquiring RUB'};
 const convert=(list,evidenceRows)=>getProfitFormula('V5').finance.convertLegacyDailyRows(list,{shopId:5,legacyCurrencyEvidence:evidenceRows});
 assert.equal(convert(source,[]).code,'FX_FINANCE_CURRENCY_UNKNOWN');
 const result=convert(source,[evidence]);assert.equal(result.ok,true);assert.equal(result.rows[0].amount_cny,-.58);assert.equal(result.source_rows[0].currency_reference,evidence.reference);
 for(const change of [{shop_id:6},{operation_id:'other'},{finance_item_id:99}])assert.equal(convert(source,[{...evidence,...change}]).code,'FX_FINANCE_CURRENCY_UNKNOWN');
 assert.equal(convert([{...source[0],currency_code:'CNY'}],[evidence]).code,'FX_FINANCE_CURRENCY_CONFLICT');
 assert.equal(convert([{...source[0],amount_cny:-6.62}],[evidence]).code,'LEGACY_DAILY_CONVERSION_MISMATCH');
 const daily={...rows()[0],currency_code:''};assert.equal(convert([daily],[{...evidence,finance_item_id:daily.id,operation_id:daily.operation_id}]).code,'FX_FINANCE_CURRENCY_UNKNOWN');
});

test('review holds override approval and prevent automatic finance from touching the excluded orders',async()=>{
 const {legacyDailyBatchDecision:decide}=await import('../src/services/legacy-daily-accrual-settlement.js');
 const policy={mode:'allowlist',allowed_order_ids:[1,2],held_order_ids:[2,3]};
 assert.equal(decide(policy,1),null);assert.equal(decide(policy,2),'LEGACY_DAILY_USER_HOLD');assert.equal(decide(policy,3,false),'LEGACY_DAILY_USER_HOLD');assert.equal(decide(policy,4),'LEGACY_DAILY_OUTSIDE_APPROVED_BATCH');assert.equal(decide(policy,4,false),null);
 assert.throws(()=>decide({...policy,held_order_ids:['bad']},1),/配置无效/);
});
