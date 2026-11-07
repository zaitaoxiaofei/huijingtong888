import test from 'node:test';
import assert from 'node:assert/strict';
import {vehicleCatalogSeedingContext,seedWrite,flattenSeedWrites,native} from './helpers/vehicle-catalog-seeding.js';

function fixture(legacy=false,extra={}){
  const writes=[],reads=[],migrations=[];
  const context=vehicleCatalogSeedingContext({legacy,execute:async(sql,params)=>{writes.push({sql,params});return{};},query:async(sql,params)=>{reads.push({sql,params});return[{present:1}];},migrate:async(_connection,options)=>migrations.push(options),...extra});
  return{context,writes,reads,migrations};
}

test('regular catalog seeds preserve every legacy value and anchor position using batches of at most 100',async()=>{
  const before=fixture(true),after=fixture();await before.context.ensureVehicleCatalogSchema();await after.context.ensureVehicleCatalogSchema();
  assert.deepEqual(native(flattenSeedWrites(after.writes)),native(flattenSeedWrites(before.writes)));
  assert.deepEqual(native(after.reads),native(before.reads));assert.deepEqual(native(after.migrations),[{apply:true}]);
  const batches=after.writes.filter(call=>call.params.length>11);assert.ok(batches.length>1);
  for(const call of after.writes){assert.ok(seedWrite(call.sql));assert.ok(call.params.length/(call.sql.includes('aliases_json')?11:5)<=100);}
  const anchored=before.writes.filter(call=>call.sql.includes('aliases_json')).length;
  assert.deepEqual(native(after.writes.slice(-anchored*2)),native(before.writes.slice(-anchored*2)),'basic/anchored interleaving and SQL stay unchanged');
  const update=sql=>sql.slice(sql.indexOf('ON DUPLICATE KEY UPDATE')).replace(/\s+/g,' ').trim();
  for(const call of batches)assert.equal(update(call.sql),update(before.writes[0].sql),'do not broaden the duplicate update');
  assert.ok(after.writes.length<before.writes.length/2);
  const count=after.writes.length;await after.context.ensureVehicleCatalogSchema();assert.equal(after.writes.length,count,'ready catalog does not reseed');
});

test('concurrent ensure callers share one initialization and a failed batch can retry once',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);let migrations=0,attempts=0,fail=true;
  const calls=[];const context=vehicleCatalogSeedingContext({migrate:async()=>{migrations++;await gate;},execute:async(sql,params)=>{calls.push({sql,params});attempts++;if(fail&&attempts===2)throw Error('isolated batch failure');return{};}});
  const pending=Array.from({length:12},()=>context.ensureVehicleCatalogSchema());await Promise.resolve();assert.equal(migrations,1);release();
  const results=await Promise.allSettled(pending);assert.ok(results.every(result=>result.status==='rejected'));
  assert.equal(calls.length,2);assert.ok(calls.every(call=>!call.sql.includes('aliases_json')),'anchors must not pass a failed regular batch');
  fail=false;await Promise.all(Array.from({length:12},()=>context.ensureVehicleCatalogSchema()));assert.equal(migrations,2);
  const complete=fixture();await complete.context.ensureVehicleCatalogSchema();assert.deepEqual(native(calls.slice(2)),native(complete.writes));
  const count=calls.length;await context.ensureVehicleCatalogSchema();assert.equal(calls.length,count);
});

test('repeated seed identities remain in input order even across the 100-row boundary',async()=>{
  const rows=Array.from({length:205},(_,index)=>['SAME BRAND','same model',[String(index)]]),before=fixture(true),after=fixture();
  for(const row of rows)await before.context.seedRow(...row);await after.context.seedRows(rows);
  assert.deepEqual(after.writes.map(call=>call.params.length/5),[100,100,5]);
  assert.deepEqual(native(flattenSeedWrites(after.writes)),native(flattenSeedWrites(before.writes)));
  assert.deepEqual(JSON.parse(after.writes.at(-1).params.at(-1)),['204']);
});
