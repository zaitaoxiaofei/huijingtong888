import test from 'node:test';import assert from 'node:assert/strict';
import {stocktakePayload,submitStocktakeRows,fillStocktakeQuantities} from '../frontend/admin/utils/inventory-batch-stocktake.js';
const row=()=>({product_id:1,ledger:{physical_estimate:-2,revision:'r1'},counted_quantity:3,reason_code:'missing_purchase',reason_note:'',status:'',payload:null});
test('batch fill supports zero and selected rows without overwriting uncertain or saved inputs',()=>{
 const a=row(),b={...row(),payload:{}},c={...row(),status:'success'};fillStocktakeQuantities([a,b,c],0);assert.equal(a.counted_quantity,0);assert.equal(b.counted_quantity,3);assert.equal(c.counted_quantity,3);assert.throws(()=>fillStocktakeQuantities([a],null));assert.throws(()=>stocktakePayload({...row(),counted_quantity:''},'key'));
});
test('all rows use one request and uncertain retries preserve identical batch identity',async()=>{
 const rows=[row(),{...row(),product_id:2}],state={},calls=[];let fail=true;
 const api={post:async(path,payload)=>{calls.push({path,payload:structuredClone(payload)});if(fail)throw Error('network');return{results:payload.items.map(i=>({product_id:i.product_id}))};}};
 await submitStocktakeRows(rows,api,()=>true,state);assert.equal(calls.length,1);assert.equal(rows[0].status,'error');fail=false;await submitStocktakeRows(rows,api,()=>true,state);assert.deepEqual(calls[0],calls[1]);assert.ok(rows.every(r=>r.status==='success'));
});
test('conflicts invalidate the complete batch for review and scope switches stop submissions',async()=>{
 const rows=[row(),{...row(),product_id:2}],state={};await submitStocktakeRows(rows,{post:async()=>{throw Object.assign(Error('conflict'),{status:409});}},()=>true,state);assert.equal(state.payload,null);assert.ok(rows.every(r=>r.ledger===null));await submitStocktakeRows([row()],{post:async()=>assert.fail('scope changed')},()=>false,{});
});
