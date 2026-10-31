import assert from 'node:assert/strict';
import test from 'node:test';
import {splitOzonPosting,shipOzonPosting,fetchOzonPostingByNumber} from '../src/ozonClient.js';
const shop={id:4,name:'Own store',ozon_client_id:'fixture-client',ozon_api_key:'fixture-secret'};
test('split uses only the split-without-preparation endpoint and never retries an uncertain mutation',async t=>{
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);const calls=[];
 globalThis.fetch=async(url,options)=>{calls.push({url:String(url),body:JSON.parse(options.body)});return new Response(JSON.stringify({message:'server failed'}),{status:503});};
 await assert.rejects(splitOzonPosting(shop,'PARENT',[{products:[{product_id:100,quantity:1}]}]),/server failed/);
 assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/v1/posting/fbs/split'));assert.deepEqual(calls[0].body,{posting_number:'PARENT',postings:[{products:[{product_id:100,quantity:1}]}]});
});
test('invalid or expired seller key has shop-specific recovery instructions without leaking credentials',async t=>{
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);
 for(const message of ['Api-key has expired, generate a new one','Invalid Api-Key, please check the key and try again']){
  globalThis.fetch=async()=>new Response(JSON.stringify({message}),{status:403});
  await assert.rejects(fetchOzonPostingByNumber(shop,'PARENT'),error=>error.statusCode===409&&error.code==='OZON_API_KEY_INVALID'&&error.message.includes('Own store')&&error.message.includes('企业店铺')&&!error.message.includes('fixture-secret'));
 }
});
