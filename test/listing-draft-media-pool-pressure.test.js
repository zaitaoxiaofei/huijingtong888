import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {parse} from 'acorn';
import {resolveDevelopmentMeta} from '../src/services/product-development-meta.js';
import {listingTenantLookup} from '../src/services/listing-tenant-scope.js';
import {createListingFrozenReadScope} from '../src/services/listing-frozen-content.js';

const listing=readFileSync('src/services/listing-automation.js','utf8');
const media=readFileSync('src/services/media-migration-map.js','utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
const declarations=parse(listing,{ecmaVersion:'latest',sourceType:'module'}).body.map(n=>n.declaration||n).filter(n=>n.type==='FunctionDeclaration').map(n=>listing.slice(n.start,n.end)).join('\n');
const clone=value=>JSON.parse(JSON.stringify(value));
function boundedPool(handler){
 let active=0,peak=0,rejected=0,peakQueued=0;const waiting=[],calls=[];
 const run=(sql,params=[])=>new Promise((resolve,reject)=>{
  const work=()=>{active++;peak=Math.max(peak,active);calls.push({sql,params:Array.from(params)});setTimeout(async()=>{try{resolve(await handler(sql,params));}catch(e){reject(e);}finally{active--;waiting.shift()?.();}},2);};
  if(active<10)work();else if(waiting.length<64){waiting.push(work);peakQueued=Math.max(peakQueued,waiting.length);}else{rejected++;reject(Object.assign(new Error('Queue limit reached.'),{code:'DB_POOL_BUSY'}));}
 });
 return {run,calls,metrics:()=>({active,peak,rejected,peakQueued})};
}
function resolver(pool){
 return new Function('crypto','mysqlExecute','mysqlQuery',`${media}\nreturn {resolveMappedMediaInValue,resolvePreferredMediaUrls,ensureMediaMigrationMapTable,mediaSourceFingerprint};`)(crypto,pool.run,pool.run);
}
function draftRows(){return Array.from({length:100},(_,i)=>({id:i+1,tenant_id:'2',product_name:`Fixture ${i}`,status:'draft',
 created_at:new Date('2026-10-27T00:00:00Z'),source_urls_json:'[]',source_images_json:JSON.stringify(['https://source.invalid/old.jpg']),manual_facts_json:'{}',ai_payload_json:'{}',shop_copies_json:'[]',
 template_payload_json:JSON.stringify({editable_payload:{variants:[{offer_id:`S${i}`,images:i===0?[]:[`https://source.invalid/current-${i}.jpg`,'https://source.invalid/pending.jpg'],images_manually_edited:true}]}})}));}
function reader(pool,map,rows){
 const context=vm.createContext({URL,Buffer,Date,console,resolveDevelopmentMeta,listingTenantLookup,createListingFrozenReadScope,
  LOCAL_DICTIONARY_DISPLAY_ZH:new Map(),PRICE_STRATEGY_FINALIZED:'finalized',PRICE_STRATEGY_MULTIPLY_ON_PUBLISH:'multiply_on_publish',
  config:{listingMediaPublicBaseUrl:'https://erp.fixture.invalid'},mysqlQuery:pool.run,resolveMappedMediaInValue:map.resolveMappedMediaInValue});
 vm.runInContext(declarations,context);
 context.ensureListingAutomationSchema=async()=>{};context.ensureListingListReadSchema=async()=>{};
 let assembling=0,peakAssembly=0;
 context.assembleListingDraftStoredRow=async(_query,{tenantId,row})=>{assert.equal(tenantId,'2');assembling++;peakAssembly=Math.max(peakAssembly,assembling);try{await pool.run('ASSEMBLE_FROZEN_FIXTURE',[row.id]);return row;}finally{assembling--;}};
 return{context,peakAssembly:()=>peakAssembly};
}
for(const kind of ['legacy','paged_full','project'])test(`cold ${kind} 100-draft list stays within a 10-connection/64-queue pool and maps one page after current-image selection`,async()=>{
 const rows=draftRows();let ddl=0,mediaReads=0;const fingerprint=x=>crypto.createHash('sha256').update(x).digest('hex');
 const mappings=new Map(rows.slice(1).map((r,i)=>[fingerprint(`https://source.invalid/current-${i+1}.jpg`),{source_fingerprint:fingerprint(`https://source.invalid/current-${i+1}.jpg`),status:'verified',oss_url:`https://oss.fixture.invalid/${i+1}.jpg`} ]));
 mappings.set(fingerprint('https://source.invalid/pending.jpg'),{source_fingerprint:fingerprint('https://source.invalid/pending.jpg'),status:'uploaded',oss_url:'https://oss.fixture.invalid/not-verified.jpg'});
 mappings.set(fingerprint('https://source.invalid/old.jpg'),{source_fingerprint:fingerprint('https://source.invalid/old.jpg'),status:'verified',oss_url:'https://oss.fixture.invalid/old.jpg'});
 const pool=boundedPool(async(sql,params)=>{
  if(sql.includes('CREATE TABLE IF NOT EXISTS media_migration_map')){ddl++;return{};}
  if(sql.includes('FROM media_migration_map')){mediaReads++;assert.ok(params.length<=500);return Array.from(params,p=>mappings.get(p)).filter(Boolean);}
  if(sql==='ASSEMBLE_FROZEN_FIXTURE')return[];
  if(sql.includes('SELECT COUNT(*) AS total'))return[{total:100}];
  if(sql.includes('FROM listing_drafts'))return rows;
  throw Error('Unexpected fixture SQL');
 });
 const map=resolver(pool),read=reader(pool,map,rows),session={personId:8,tenant:{id:2,slug:'a'}};
 const actual=kind==='project'?await read.context.listingDraftProjectCandidates({},100,session):await read.context.listingDrafts(kind==='paged_full'?{paged:'1',pageSize:'100'}:{page:'1',pageSize:'1'},session);
 const output=Array.isArray(actual)?actual:actual.rows;
 assert.equal(output.length,100);
 assert.equal(ddl,1,'cold schema readiness is single-flight');
 assert.equal(mediaReads,1,'100 rows share one IN lookup instead of competing for 100 pool slots');
 assert.equal(pool.metrics().rejected,0);assert.ok(pool.metrics().peak<=4,JSON.stringify(pool.metrics()));assert.ok(read.peakAssembly()<=4);
 assert.deepEqual(clone(output[0].effective_images),[],'an explicitly empty manual image set never falls back to collection history');
 assert.deepEqual(clone(output[1].effective_images),['https://oss.fixture.invalid/1.jpg','https://source.invalid/pending.jpg']);
 assert.equal(output[1].created_at.toISOString(),'2026-10-27T00:00:00.000Z');
 assert.ok(!output[1].effective_images.includes('https://oss.fixture.invalid/old.jpg'));
});

test('large page media lookups use sequential bounded batches and do not cache stale verified status',async()=>{
 let ddl=0,lookups=0,verified=false;const pool=boundedPool(async(sql,params)=>{if(sql.includes('CREATE TABLE')){ddl++;return{};}lookups++;assert.ok(params.length<=500);return verified?[{source_fingerprint:crypto.createHash('sha256').update('https://source.invalid/0.jpg').digest('hex'),status:'verified',oss_url:'https://oss.fixture.invalid/now-verified.jpg'}]:[];});
 const map=resolver(pool),urls=Array.from({length:1201},(_,i)=>`https://source.invalid/${i}.jpg`);
 assert.equal((await map.resolvePreferredMediaUrls(urls)).length,1201);assert.equal(lookups,3);assert.equal(pool.metrics().peak,1);
 verified=true;assert.deepEqual(await map.resolvePreferredMediaUrls([urls[0]]),['https://oss.fixture.invalid/now-verified.jpg']);assert.equal(ddl,1);
});

test('concurrent cold media callers share schema initialization and a failed initialization or mapping query remains visible',async()=>{
 let ddl=0,fail=true;const pool=boundedPool(async(sql)=>{if(sql.includes('CREATE TABLE')){ddl++;if(fail)throw Object.assign(Error('schema failed'),{code:'ER_FIXTURE_SCHEMA'});return{};}throw Object.assign(Error('mapping failed'),{code:'ER_FIXTURE_MAPPING'});});
 const map=resolver(pool);
 const result=await Promise.allSettled(Array.from({length:100},()=>map.resolvePreferredMediaUrls(['/uploads/a.jpg'])));
 assert.ok(result.every(r=>r.status==='rejected'&&r.reason.code==='ER_FIXTURE_SCHEMA'));assert.equal(ddl,1);
 fail=false;await assert.rejects(map.resolvePreferredMediaUrls(['/uploads/a.jpg']),e=>e.code==='ER_FIXTURE_MAPPING');assert.equal(ddl,2);assert.equal(pool.metrics().rejected,0);
});
