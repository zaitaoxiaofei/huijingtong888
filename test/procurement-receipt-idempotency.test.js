import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {newArrivalReceiptRequest,readNewArrivalReceipt} from '../src/services/procurement-receipt-idempotency.js';

test('receipt fingerprints preserve quantity, evidence, reason, revision and product while ignoring object key order',()=>{
 const body={product_id:2,receipt_mode:'new_arrival',expected_revision:'revision',request_key:randomUUID(),records:[{id:4,quantity:2,expected_quantity:5,reason:'partial',receipt_images_json:['/uploads/team-attachments/a.jpg']},{id:3,quantity:1,expected_quantity:1}]};
 const original=newArrivalReceiptRequest(body);
 assert.equal(newArrivalReceiptRequest({...body,records:[...body.records].reverse()}).hash,original.hash);
 for(const change of [
  {product_id:3},{expected_revision:'changed'},{receipt_mode:'invalid'},
  {records:[{...body.records[0],quantity:3},body.records[1]]},
  {records:[{...body.records[0],reason:'changed'},body.records[1]]},
  {records:[{...body.records[0],receipt_images_json:[]},body.records[1]]}
 ])assert.notEqual(newArrivalReceiptRequest({...body,...change}).hash,original.hash);
 assert.equal(newArrivalReceiptRequest({...body,receipt_mode:'historical'}),null);
 assert.equal(newArrivalReceiptRequest({...body,receipt_mode:undefined,counted_quantity:10}),null);
 assert.equal(newArrivalReceiptRequest({...body,request_key:undefined}),null);
 assert.throws(()=>newArrivalReceiptRequest({...body,request_key:'bad'}),{statusCode:400});
});

test('receipt replay scopes tenant and actor then rejects a reused key for different inventory or content',async()=>{
 const request={key:randomUUID(),hash:'same',productId:2},calls=[];
 const query=async(sql,args)=>{calls.push({sql,args});return[{product_id:2,detail_json:{hash:'same',result:{ok:true,count:1,ids:[4]}}}];};
 assert.deepEqual(await readNewArrivalReceipt(query,7,8,request),{ok:true,count:1,ids:[4],duplicate:true});
 assert.deepEqual(calls[0].args,[7,8,request.key]);assert.match(calls[0].sql,/tenant_id=\? AND person_id=\?/);assert.doesNotMatch(calls[0].sql,/product_id=\?/);
 await assert.rejects(readNewArrivalReceipt(query,7,8,{...request,productId:3}),{statusCode:409});
 await assert.rejects(readNewArrivalReceipt(query,7,8,{...request,hash:'changed'}),{statusCode:409});
 await readNewArrivalReceipt(query,7,8,request,{lock:true});assert.match(calls.at(-1).sql,/FOR UPDATE$/);
});
