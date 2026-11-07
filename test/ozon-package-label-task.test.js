import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchOzonPackageLabelTask} from '../src/services/ozon-package-label-task.js';
const pdf=Buffer.from('%PDF-fixture');
const created={tasks:[{task_id:1,task_type:'big_label'},{task_id:2,task_type:'small_label'}]};
const complete={error:null,status:{code:'completed',printed_postings_count:1,unprinted_postings:[]},file_url:'https://ir-20.ozonstatic.cn/label.pdf'};
test('new create/get flow selects the small label and waits for the PDF without changing order IDs',async()=>{
 const calls=[];let polls=0,waits=0;
 const buffer=await fetchOzonPackageLabelTask(['order-A'],{request:async(path,body)=>{calls.push({path,body});return path.endsWith('/create')?created:++polls===1?{status:{code:'processing'}}:complete;},download:async url=>{assert.equal(url,complete.file_url);return pdf;},wait:async()=>{waits++;}});
 assert.equal(buffer,pdf);assert.equal(waits,1);assert.deepEqual(calls,[{path:'/v3/posting/fbs/package-label/create',body:{posting_numbers:['order-A']}},...Array.from({length:2},()=>({path:'/v2/posting/fbs/package-label/get',body:{task_id:2}}))]);
});
test('failed, incomplete and invalid PDF results fail closed',async()=>{
 for(const result of [{error:'not ready',status:{code:'failed'}},{...complete,status:{code:'completed',printed_postings_count:0,unprinted_postings:['order-A']}},{...complete,file_url:''}]){
  await assert.rejects(fetchOzonPackageLabelTask(['order-A'],{request:async path=>path.endsWith('/create')?created:result,download:async()=>{assert.fail('must not download incomplete output');}}));
 }
 await assert.rejects(fetchOzonPackageLabelTask(['order-A'],{request:async path=>path.endsWith('/create')?created:complete,download:async()=>Buffer.from('<html>error</html>')}),/不是有效 PDF/);
});
test('polling is bounded and a cancelled request never creates another task',async()=>{
 let polls=0;
 await assert.rejects(fetchOzonPackageLabelTask(['a'],{request:async path=>path.endsWith('/create')?created:(polls++,{status:{code:'processing'}}),download:async()=>pdf,wait:async()=>{}}),/仍在生成/);assert.equal(polls,30);
 const c=new AbortController();c.abort(Error('cancelled'));
 await assert.rejects(fetchOzonPackageLabelTask(['a'],{signal:c.signal,request:async()=>assert.fail('must not send'),download:async()=>pdf}),/cancelled/);
});
test('actual Ozon client uses migrated endpoints and downloads PDF without forwarding API credentials',async()=>{
 const {fetchOzonPackageLabel}=await import('../src/ozonClient.js');
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options={})=>{
  const target=String(url);calls.push({url:target,options});
  if(target.endsWith('/v3/posting/fbs/package-label/create'))return Response.json(created);
  if(target.endsWith('/v2/posting/fbs/package-label/get'))return Response.json(complete);
  assert.equal(target,complete.file_url);assert.equal(options.headers,undefined);return new Response(pdf);
 };
 try {
  const buffer=await fetchOzonPackageLabel({id:1,ozon_client_id:'migration-test',ozon_api_key:'fixture-key'},['A']);
  assert.deepEqual(buffer,pdf);assert.equal(calls.length,3);
  assert.deepEqual(JSON.parse(calls[0].options.body),{posting_numbers:['A']});assert.deepEqual(JSON.parse(calls[1].options.body),{task_id:2});
  assert.equal(calls[0].options.headers['Api-Key'],'fixture-key');
 }finally{globalThis.fetch=original;}
});
