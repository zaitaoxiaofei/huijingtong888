import test from 'node:test';
import assert from 'node:assert/strict';
import {allocateBundlePurchaseTotal} from '../src/shared/purchase-bundle-total.js';
import {planPurchaseBundleReview} from '../src/shared/purchase-bundle-review.js';
const ctx={revision:'current',batch:{quantity:50,amount:225,shipping_amount:3},components:[{product_id:1,per_set_quantity:1,purchase_cost:3},{product_id:2,per_set_quantity:1,purchase_cost:1.875}]};
const input={revision:'current',allocation_mode:'total',mode:'whole',set_quantity:50,total_amount:228,note:'确认实际采购',allocation_confirmed:true};
const sum=rows=>rows.reduce((n,r)=>n+Math.round(r.amount*10000)+Math.round(r.shipping_amount*10000),0);
test('50 sets and a single 228 total produce physical quantities and conserve goods plus freight',()=>{
 const rows=allocateBundlePurchaseTotal(ctx,input);assert.deepEqual(rows.map(r=>r.quantity),[50,50]);assert.equal(sum(rows),2280000);
 const plan=planPurchaseBundleReview(ctx,input);assert.equal(plan.amount,225);assert.equal(plan.shipping_amount,3);
});
test('editing actual set count updates every component ratio without assuming old quantities',()=>{
 const context={...ctx,components:[{...ctx.components[0],per_set_quantity:2},ctx.components[1]]};
 const plan=planPurchaseBundleReview(context,{...input,set_quantity:7});assert.deepEqual(plan.items.map(r=>r.quantity),[14,7]);assert.equal(sum(plan.items),2280000);
});
test('partial purchase only requires selected quantities and one total, ignoring supplied per-item money',()=>{
 const body={...input,mode:'parts',total_amount:35,confirm_amount_change:true,items:[{product_id:2,quantity:7,amount:999999,shipping_amount:999}]};
 const plan=planPurchaseBundleReview(ctx,body);assert.equal(plan.items.length,1);assert.equal(plan.items[0].product_id,2);assert.equal(plan.items[0].quantity,7);assert.equal(sum(plan.items),350000);
});
test('a changed total still requires explicit acknowledgement in both modes',()=>{
 for(const mode of ['whole','parts']){
  const body={...input,mode,total_amount:230,items:[{product_id:1,quantity:4}]};
  assert.throws(()=>planPurchaseBundleReview(ctx,body),/确认/);
  assert.equal(sum(planPurchaseBundleReview(ctx,{...body,confirm_amount_change:true}).items),2300000);
 }
});
test('missing component costs use quantities and keep rounding exact, even for small totals',()=>{
 const context={...ctx,batch:{amount:1,shipping_amount:0},components:[{product_id:1,per_set_quantity:2,purchase_cost:null},{product_id:2,per_set_quantity:1,purchase_cost:9}]};
 const rows=allocateBundlePurchaseTotal(context,{...input,set_quantity:1,total_amount:0.01});assert.equal(sum(rows),100);assert.ok(rows.every(r=>r.amount>0));assert.ok(rows[0].amount>rows[1].amount);
 const many={batch:{amount:0.01,shipping_amount:0},components:Array.from({length:100},(_,i)=>({product_id:i+1,per_set_quantity:1}))};assert.equal(sum(allocateBundlePurchaseTotal(many,{...input,set_quantity:1,total_amount:0.0159})),159);
});
test('invalid quantities, foreign components, duplicate selections and invalid totals fail before allocation',()=>{
 for(const body of [{...input,set_quantity:0},{...input,set_quantity:1.5},{...input,total_amount:-1},{...input,total_amount:Infinity},{...input,total_amount:0},{...input,mode:'parts',items:[]},{...input,mode:'parts',items:[{product_id:99,quantity:1}]},{...input,mode:'parts',items:[{product_id:1,quantity:1},{product_id:1,quantity:2}]}])assert.throws(()=>allocateBundlePurchaseTotal(ctx,body));
 assert.throws(()=>planPurchaseBundleReview(ctx,{...input,revision:'stale'}),/变化/);
});
