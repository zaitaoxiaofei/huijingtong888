import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchOzonReturns} from '../src/services/ozon-return-client.js';
const row=(id,state='MoneyReturned')=>({return_id:id,posting_number:'p-'+id,state:{state},product:{sku:1,name:'test'},client_name:'private',photo:'private',client_info:{phone:'private'}});
test('read both official endpoints, return_id cursor and safe field allowlist',async()=>{
  const calls=[];let guards=0;
  const result=await fetchOzonReturns({id:4},{beforeRequest:async()=>{guards++;return {id:4};},request:async(path,payload)=>{calls.push({path,payload});
    if(path.includes('/rfbs/'))return payload.last_id?{returns:[row(2)],has_next:false}:{returns:[row(1)],has_next:true};
    return {returns:[]};}});
  assert.equal(result.rows.length,2);assert.equal(calls[1].payload.last_id,1);assert.equal(guards,3);
  assert.equal(result.rows[0].client_name,undefined);assert.equal(result.rows[0].photo,undefined);
});
test('failed second endpoint cannot return a partially successful scan',async()=>{
  await assert.rejects(fetchOzonReturns({}, {request:async path=>{if(path.includes('/rfbs/'))return {returns:[row(1)],has_next:false};throw Error('HTTP 403');}}),/403/);
});
test('pagination loops, limits, invalid schemas and conflicting IDs stop the scan',async()=>{
  await assert.rejects(fetchOzonReturns({}, {request:async()=>({returns:[row(1)],has_next:true})}),/游标/);
  await assert.rejects(fetchOzonReturns({}, {maxPages:1,request:async()=>({returns:[row(1)],has_next:true})}),/上限/);
  await assert.rejects(fetchOzonReturns({}, {request:async()=>({})}),/结构/);
  await assert.rejects(fetchOzonReturns({}, {request:async()=>({returns:[row(1),row(1,'Cancelled')],has_next:false})}),/冲突/);
});
