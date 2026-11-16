import test from 'node:test';import assert from 'node:assert/strict';
import{createBillingOverviewCache,billingSourceMutation}from'../src/services/billing-overview-cache.js';
import{billingMonthStatus}from'../src/shared/billing-profit.js';
test('overview snapshots isolate scope, expire, force refresh and never retain failed reads',async()=>{
 let time=0,n=0;const c=createBillingOverviewCache({now:()=>time,ttlMs:15});const load=async()=>({value:++n});
 assert.equal((await c.read('tenant1:company1',load)).value,1);const hit=await c.read('tenant1:company1',load);assert.equal(hit.overview_cache.hit,true);hit.value=100;
 assert.equal((await c.read('tenant1:company1',load)).value,1);assert.equal((await c.read('tenant2:company1',load)).value,2);
 time=16;assert.equal((await c.read('tenant1:company1',load)).value,3);c.invalidate();assert.equal((await c.read('tenant1:company1',load)).value,4);
 assert.equal((await c.read('tenant1:company1',load,{force:true})).value,5);
 await assert.rejects(c.read('error',()=>{throw Error('fail');}));assert.equal((await c.read('error',load)).value,6);
});
test('in-flight loads deduplicate but cannot repopulate an invalidated snapshot',async()=>{
 const c=createBillingOverviewCache();let resolve,n=0;const loader=()=>new Promise(r=>{n++;resolve=r;});const a=c.read('a',loader),b=c.read('a',loader);await Promise.resolve();assert.equal(n,1);c.invalidate();resolve({value:1});await Promise.all([a,b]);assert.equal((await c.read('a',async()=>({value:2}))).value,2);
});
test('source mutations include late refunds, payroll corrections, AI and assignments; reads are not writes',()=>{
 for(const sql of ["UPDATE orders SET status='returned'","DELETE FROM finance_expenses WHERE id=1","INSERT INTO finance_payroll_item_revisions VALUES(1)","UPDATE ozon_finance_items SET amount=3","UPDATE ai_image_usage_events SET requested_count=2","UPDATE finance_shop_assignments SET company_id=2"])assert.equal(billingSourceMutation(sql,{affectedRows:1}),true,sql);
 assert.equal(billingSourceMutation('SELECT * FROM orders'),false);assert.equal(billingSourceMutation('UPDATE orders SET status=1',{affectedRows:0}),false);assert.equal(billingSourceMutation('UPDATE unrelated_table SET x=1'),false);
});
test('only reconciled past months are completed; ended dates alone never complete a month',()=>{
 const known={net_profit:0,pending_order_count:0,reconciliation_pending_count:0,income_pending_count:0};assert.equal(billingMonthStatus(known,'2026-10','2026-11-16'),'completed');
 for(const key of ['pending_order_count','reconciliation_pending_count','income_pending_count'])assert.equal(billingMonthStatus({...known,[key]:1},'2026-10','2026-11-16'),'pending');
 assert.equal(billingMonthStatus({...known,net_profit:null},'2026-10','2026-11-16'),'pending');assert.equal(billingMonthStatus(known,'2026-11','2026-11-16'),'in_progress');assert.equal(billingMonthStatus(known,'2026-12','2026-11-16'),'not_started');
});
