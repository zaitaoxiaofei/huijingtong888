import test from 'node:test';
import assert from 'node:assert/strict';
import {stocktakePayload,submitStocktakeRows} from '../frontend/admin/utils/inventory-batch-stocktake.js';
const row=()=>({product_id:1,ledger:{physical_estimate:-2,revision:'r1'},counted_quantity:3,reason_code:'missing_purchase',reason_note:'',status:'',payload:null});
test('batch requires actual counted quantities and valid reasons, never fills zero automatically',()=>{
 for(const counted_quantity of [null,'',-1,1.5,'x'])assert.throws(()=>stocktakePayload({...row(),counted_quantity},'key'));
 assert.throws(()=>stocktakePayload({...row(),ledger:null},'key'));
 assert.equal(stocktakePayload(row(),'key').revision,'r1');
});
test('batch retries uncertain outcomes with the same key, skips completed items and exposes partial failures',async()=>{
 const rows=[row(),{...row(),product_id:2}];const calls=[];let fail=true;
 const api={post:async(_,payload)=>{calls.push({...payload});if(payload.product_id===2&&fail)throw Error('network');}};
 await submitStocktakeRows(rows,api,()=>true);
 assert.equal(rows[0].status,'success');assert.equal(rows[1].status,'error');const key=rows[1].payload.request_key;
 fail=false;await submitStocktakeRows(rows,api,()=>true);
 assert.equal(calls.length,3);assert.equal(calls[2].request_key,key);assert.equal(rows[1].status,'success');
});
test('changed inventory requires fresh ledger and explicit reconfirmation; tenant changes stop writes',async()=>{
 const rows=[row(),{...row(),product_id:2}];let current=true,calls=0;
 await submitStocktakeRows(rows,{post:async()=>{calls++;throw Object.assign(Error('conflict'),{status:409});}},()=>current);
 assert.equal(rows[0].ledger,null);assert.equal(rows[0].payload,null);assert.equal(calls,2);
 current=false;await submitStocktakeRows([row()],{post:async()=>{calls++;}},()=>current);assert.equal(calls,2);
});
