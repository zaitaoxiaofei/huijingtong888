import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/services/ai-tenant-context.js',import.meta.url),'utf8');
const implementation=source.slice(source.indexOf('export async function assertCurrentAiTenantPermission'),source.indexOf('export async function reserveTenantAiRequest')).replace('export ','');

test('resource waits finish before the final membership check, including free text without a wallet transaction',async()=>{
 for(const options of [{},{connection:{execute:async()=>[]},lock:true}]){
  let finish,entered,revoked=false;const waiting=new Promise(resolve=>{entered=resolve;});const events=[];
  const session={personId:7,tenant:{id:2,slug:'customer-a'}};
  const check=vm.runInNewContext(`(${implementation})`,{
   currentAiTenantSession:()=>session,
   context:{getStore:()=>({permission:'operations',beforeRequest:async()=>{events.push('guard');entered();await new Promise(resolve=>{finish=resolve;});}})},
   authorizeBusinessTaskSession:async()=>{events.push('authorize');if(revoked)throw Object.assign(new Error('revoked'),{code:'TENANT_TASK_ACCESS_DENIED'});return session;},
   assertBusinessTaskPermission(){}
  });
  const request=check(options);await waiting;revoked=true;finish();
  await assert.rejects(request,{code:'TENANT_TASK_ACCESS_DENIED'});assert.deepEqual(events,['guard','authorize']);
 }
});
