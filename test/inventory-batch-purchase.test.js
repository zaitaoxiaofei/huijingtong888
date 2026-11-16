import test from 'node:test';import assert from 'node:assert/strict';
import {purchaseBackfillPayload,submitPurchaseBackfills} from '../frontend/admin/utils/inventory-batch-purchase.js';
const row=()=>({product_id:1,ledger:{missing_purchase:3,revision:'r'},quantity:3,amount:15,shipping_amount:0,purchased_at:'2026-10-10',status:''});
test('backfill requires actual quantity, money and date; never increases physical stock',()=>{
 const p=purchaseBackfillPayload(row(),'key');assert.equal(p.inventory_effect,'already_accounted');assert.equal(p.reconcile_stock,undefined);
 for(const override of [{quantity:4},{amount:0},{purchased_at:''},{shipping_amount:-1}])assert.throws(()=>purchaseBackfillPayload({...row(),...override},'key'));
});
test('purchase partial retry preserves uncertain request key and skips completed rows',async()=>{
 const a=row(),b={...row(),product_id:2};for(const r of [a,b]){r.payload=purchaseBackfillPayload(r,String(r.product_id));r.preview={};}
 let fail=true;const keys=[];const api={post:async(_,p)=>{keys.push(p.request_key);if(p.product_id===2&&fail)throw Error('network');}};
 await submitPurchaseBackfills([a,b],api,()=>true);fail=false;await submitPurchaseBackfills([a,b],api,()=>true);assert.deepEqual(keys,['1','2','2']);
});
test('changed purchase ledger invalidates preview and requires reload',async()=>{
 const r=row();r.payload=purchaseBackfillPayload(r,'key');r.preview={};await submitPurchaseBackfills([r],{post:async()=>{throw Object.assign(Error('conflict'),{status:409});}},()=>true);assert.equal(r.ledger,null);assert.equal(r.preview,null);assert.equal(r.payload,null);
});

test('weighted goods average ignores freight and unknown price; missing orders group by Beijing order date',async()=>{
 const {historicalPurchaseAverage,purchaseBackfillGroups}=await import('../src/shared/purchase-backfill-defaults.js');
 const avg=historicalPurchaseAverage([{actual_quantity:10,amount:100,shipping_amount:99},{actual_quantity:30,amount:600},{actual_quantity:50,amount:0}]);
 assert.equal(avg.unit_cost,17.5);assert.equal(avg.quantity,40);assert.equal(historicalPurchaseAverage([]),null);
 const orders=[{order_item_id:1,entered_transport:true,stock_location:'LOCAL',ordered_at:'2026-10-01 17:00:00',missing_purchase_quantity:2},{order_item_id:2,entered_transport:true,stock_location:'LOCAL',ordered_at:'2026-10-01T08:00:00Z',missing_purchase_quantity:3},{order_item_id:3,entered_transport:false,missing_purchase_quantity:8},{order_item_id:4,entered_transport:true,stock_location:'FBP',missing_purchase_quantity:9},{order_item_id:5,entered_transport:true,stock_location:'LOCAL',missing_purchase_quantity:0}];
 const groups=purchaseBackfillGroups({orders});assert.deepEqual(groups.map(g=>[g.date,g.missing_quantity]),[['2026-10-01',3],['2026-10-02',2]]);
});
test('dated partial backfill is limited to selected uncovered orders and revalidates after preceding date group',async()=>{
 const a={...row(),order_item_ids:[1],order_date:'2026-10-10',missing_quantity:3,quantity:2};a.payload=purchaseBackfillPayload(a,'date-key');a.preview={local_before:0,local_after:0,allocations:[{order_item_id:1,quantity:2}]};
 let sent;await submitPurchaseBackfills([a],{get:async()=>({revision:'new-revision'}),post:async(path,body)=>{if(path.endsWith('/preview'))return a.preview;sent=body;}},()=>true);
 assert.equal(sent.purchase_date_basis,'order_date');assert.equal(sent.revision,'new-revision');assert.equal(sent.quantity,2);assert.equal(a.status,'success');
});
