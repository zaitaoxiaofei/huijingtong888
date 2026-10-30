import test from 'node:test';
import assert from 'node:assert/strict';
import {createInventoryDemandSnapshot,waitForInventoryDemandJobs,INVENTORY_DEMAND_SNAPSHOT_VERSION,limitInventoryDemandQueries} from '../src/services/inventory-demand-snapshot.js';

function fixture(){
  let clock=1000000,epoch=0,fail=false,hold=null,calls=0;const disk=new Map();
  const query=async(sql,args)=>{
    if(sql.startsWith('SELECT'))return disk.has(args[0])?[disk.get(args[0])]:[];
    assert.ok(sql.includes('INSERT INTO inventory_demand_snapshots'));disk.set(args[0],{version:args[1],payload_json:args[2],calculated_at:args[3]+'Z'});
  };
  const options={query,now:()=>clock,revision:()=>epoch,products:async tenant=>[{product_id:tenant*10}],calculate:async(ids)=>{calls++;if(hold)await hold;if(fail)throw Error('database secret');return ids.map(product_id=>({product_id,physical:12,supply_plan:{required_purchase:2},requests:[{applicant_name:'private name'}],applications:[{order_no:'private order'}],demands:[{requests:[{applicant_name:'private name'}]}]}));}};
  return{disk,reader:()=>createInventoryDemandSnapshot(options),advance:n=>clock+=n,change:()=>epoch++,fail:()=>fail=true,recover:()=>fail=false,hold:p=>hold=p,calls:()=>calls};
}

test('initial reads return warming immediately, coalesce requests and persist no personnel identities',async()=>{
  const f=fixture(),read=f.reader();let release;f.hold(new Promise(r=>release=r));
  const first=await read(2);assert.equal(first.snapshot.available,false);assert.equal(first.snapshot.status,'warming');assert.deepEqual(first.rows,[]);
  await read(2,{fresh:true});await read(2);release();await waitForInventoryDemandJobs();
  const ready=await read(2);assert.equal(f.calls(),1);assert.equal(ready.rows[0].physical,12);assert.equal(ready.snapshot.status,'ready');
  assert.ok(!f.disk.get(2).payload_json.includes('private name'));assert.ok(!f.disk.get(2).payload_json.includes('private order'));
});

test('restart reads persisted data without waiting for rebuild; failures never clear last success',async()=>{
  const f=fixture(),first=f.reader();await first(2);await waitForInventoryDemandJobs();
  f.fail();let release;f.hold(new Promise(r=>release=r));
  const restarted=f.reader(),read=await restarted(2);assert.equal(read.snapshot.available,true);assert.equal(read.rows[0].physical,12);assert.equal(read.snapshot.status,'updating');
  release();await waitForInventoryDemandJobs();const failed=await restarted(2);assert.equal(failed.snapshot.status,'error');assert.equal(failed.rows[0].physical,12);assert.ok(!failed.snapshot.error.includes('secret'));
});

test('frequent invalidations serve last success, debounce rebuilding, allow manual repair and isolate tenants',async()=>{
  const f=fixture(),read=f.reader();await read(2);await waitForInventoryDemandJobs();
  f.change();const before=f.calls();for(let i=0;i<10;i++){f.change();const r=await read(2);assert.equal(r.rows[0].product_id,20);assert.equal(r.snapshot.refreshing,false);}assert.equal(f.calls(),before);
  await read(2,{fresh:true});await waitForInventoryDemandJobs();assert.equal(f.calls(),before+1);
  f.advance(60001);f.change();assert.equal((await read(2)).snapshot.status,'updating');await waitForInventoryDemandJobs();
  const other=await read(3);assert.equal(other.snapshot.available,false);assert.deepEqual(other.rows,[]);await waitForInventoryDemandJobs();assert.equal((await read(3)).rows[0].product_id,30);
});

test('incompatible or corrupt cache cannot masquerade as zero demand; new products mark snapshot incomplete',async()=>{
  const f=fixture();f.disk.set(2,{version:INVENTORY_DEMAND_SNAPSHOT_VERSION,payload_json:'broken',calculated_at:'2026-01-01T00:00:00Z'});
  const read=f.reader();assert.equal((await read(2)).snapshot.available,false);await waitForInventoryDemandJobs();
  assert.equal((await read(2,{productIds:[20,21]})).snapshot.incomplete,true);
  f.disk.set(3,{version:'old-formula',payload_json:JSON.stringify({rows:[{product_id:30,physical:999}]}),calculated_at:'2026-01-01T00:00:00Z'});
  assert.equal((await read(3)).snapshot.available,false);await waitForInventoryDemandJobs();
});

test('explicit refresh after a write during an old calculation schedules one follow-up',async()=>{
  const f=fixture(),read=f.reader();let release;f.hold(new Promise(r=>release=r));
  await read(2);await Promise.resolve();f.change();await read(2,{fresh:true});await read(2,{fresh:true});
  release();await waitForInventoryDemandJobs();assert.equal(f.calls(),2);assert.equal((await read(2)).snapshot.stale,false);
});

test('background calculation uses at most two query slots and releases slots on failure',async()=>{
  let active=0,peak=0;
  const query=limitInventoryDemandQueries(async n=>{active++;peak=Math.max(peak,active);try{await new Promise(r=>setImmediate(r));if(n===3)throw Error('failure');return n;}finally{active--;}});
  const results=await Promise.allSettled(Array.from({length:20},(_,i)=>query(i)));
  assert.equal(peak,2);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(await query(30),30);
});

test('a queued enterprise cooldown starts when its work actually starts',async()=>{
  const f=fixture(),read=f.reader();let release;f.hold(new Promise(r=>release=r));
  await read(2);await read(3);f.advance(60001);release();await waitForInventoryDemandJobs();
  f.change();const before=f.calls();assert.equal((await read(3)).snapshot.refreshing,false);assert.equal(f.calls(),before);
});
