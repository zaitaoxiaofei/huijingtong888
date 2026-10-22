import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribeGlobalUpdateEvents, broadcastGlobalEvent, broadcastGlobalUpdateStatus } from '../src/server/notifications.js';

const identity=(personId=7,tenantId=42,slug='company-a')=>({personId,tenant:{id:tenantId,slug,access_allowed:true}});
function connect(session, options={}) {
  const chunks=[];
  const res={writableEnded:false,destroyed:false,write(chunk){chunks.push(chunk);},end(){this.writableEnded=true;}};
  const unsubscribe=subscribeGlobalUpdateEvents(res,{person_id:99,tenant_id:99},session,options);
  chunks.length=0;
  return {res,unsubscribe,clear(){chunks.length=0;},text(){return chunks.join('');}};
}

test('actual SSE sender denies missing, revoked, expired, switched and mismatched sessions before writing data',async()=>{
  for(const current of [null,{personId:7,platform_role:'super_admin',tenant:null},identity(8),identity(7,99,'company-b'),{...identity(),tenant:{...identity().tenant,access_allowed:false}}, {...identity(),tenant:{...identity().tenant,access_allowed:undefined}}]){
    const client=connect(identity(),{authorize:async()=>current});
    try{
      await broadcastGlobalEvent('private-event',{private:'must-never-arrive'},{tenantId:42});
      assert.equal(client.text(),'');
      assert.equal(client.res.writableEnded,true);
    }finally{client.unsubscribe();}
  }
  const missing=connect(identity());
  try { await broadcastGlobalEvent('private-event',{private:'blocked'},{tenantId:42}); assert.equal(missing.text(),''); assert.equal(missing.res.writableEnded,true); }
  finally { missing.unsubscribe(); }
  const unavailable=connect(identity(),{authorize:async()=>{throw new Error('Session lookup unavailable');}});
  try { await broadcastGlobalEvent('private-event',{private:'blocked'},{tenantId:42}); assert.equal(unavailable.text(),''); assert.equal(unavailable.res.writableEnded,true); }
  finally { unavailable.unsubscribe(); }
});

test('queued events reauthorize individually, preserve payload snapshots, and stop after revocation',async()=>{
  let current=identity(),release,checks=0;
  const blocked=new Promise(resolve=>{release=resolve;});
  const client=connect(identity(),{authorize:async()=>{checks++;if(checks===1)await blocked;return current;}});
  try{
    const payload={value:'original'};
    const first=broadcastGlobalEvent('private-event',payload,{tenantId:42});
    payload.value='mutated';
    release();
    await first;
    assert.match(client.text(),/original/);
    assert.doesNotMatch(client.text(),/mutated/);
    client.clear();
    current=null;
    await broadcastGlobalEvent('private-event',{private:'revoked'},{tenantId:42});
    assert.equal(checks,2);
    assert.equal(client.text(),'');
    assert.equal(client.res.writableEnded,true);
  }finally{client.unsubscribe();}
});

test('unsubscribing during asynchronous authorization discards queued private data and public updates stay available',async()=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const client=connect(identity(),{authorize:()=>pending});
  const platform=connect({personId:1,tenant:null});
  try{
    broadcastGlobalUpdateStatus();
    assert.match(platform.text(),/event: update/);
    const delivery=broadcastGlobalEvent('private-event',{private:'closed-client'},{tenantId:42});
    await Promise.resolve();
    client.unsubscribe();client.clear();
    release(identity());
    await delivery;
    assert.equal(client.text(),'');
    assert.doesNotMatch(platform.text(),/closed-client/);
  }finally{client.unsubscribe();platform.unsubscribe();}
});
