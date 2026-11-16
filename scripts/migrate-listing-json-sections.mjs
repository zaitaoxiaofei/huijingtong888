import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import {auditListingSections,applyListingSections,restoreListingSections,listingSectionPlanHash} from '../src/services/listing-section-migration.js';
import {readPrivateJson,jsonArchiveHash} from '../src/services/private-json-archive.js';
import {decodeListingJsonSections} from '../src/services/listing-json-sections.js';

const arg=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
const mode=arg('mode')||'audit',tenant=arg('tenant'),table=arg('table'),file=arg('plan');
assert(['audit','apply','verify','restore'].includes(mode));
assert(arg('socket')?.startsWith('/')&&/^[A-Za-z0-9_]+$/.test(arg('database')||''),'Explicit local MySQL socket and database required');
if(['apply','restore'].includes(mode))assert(process.argv.includes('--write'),'Explicit --write required');
const db=await mysql.createConnection({socketPath:arg('socket'),database:arg('database'),user:'root',dateStrings:true});
const query=async(sql,p=[])=>(await db.query(sql,p))[0];
const transaction=async work=>{await db.beginTransaction();try{const r=await work(query);await db.commit();return r;}catch(e){await db.rollback();throw e;}};
const write=(p,value)=>fs.writeFile(p,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
try{
 await query('SET SESSION max_execution_time=20000');await query('SET SESSION innodb_lock_wait_timeout=5');
 if(['audit','verify'].includes(mode))await query('SET SESSION TRANSACTION READ ONLY');
 if(mode==='audit'){
  const out=path.resolve(arg('out')||'');assert(arg('out')&&path.isAbsolute(arg('out')),'Explicit output directory required');await fs.mkdir(out,{recursive:false,mode:0o700});
  const catalog={format:'listing-section-pages-v1',tenant_id:tenant,table,pages:[],rows:0,old_bytes:0,new_bytes:0};let afterId=Number(arg('after-id')||0);
  for(let page=1;page<=2000;page++){
   const plan=await auditListingSections(query,{tenantId:tenant,table,afterId,limit:10});
   const p=path.join(out,`page-${String(page).padStart(4,'0')}.json`);await write(p,plan);catalog.pages.push({file:p,sha256:plan.sha256});catalog.rows+=plan.rows;catalog.old_bytes+=plan.old_bytes;catalog.new_bytes+=plan.new_bytes;
   if(!process.argv.includes('--all')||!plan.has_more){catalog.complete=!plan.has_more;break;}assert(plan.next_after_id>afterId);afterId=plan.next_after_id;if(page===2000)throw Error('Audit page bound exceeded');
  }
  await write(path.join(out,'index.json'),catalog);console.log(JSON.stringify({mode,index:path.join(out,'index.json'),pages:catalog.pages.length,rows:catalog.rows,old_bytes:catalog.old_bytes,new_bytes:catalog.new_bytes,complete:catalog.complete}));
 }else{
  assert(file&&path.isAbsolute(file),'Explicit reviewed plan or result file required');
  const plan=JSON.parse(await fs.readFile(file,'utf8'));
  if(mode==='apply'){
   assert.equal(plan.sha256,listingSectionPlanHash(plan));
   const minFree=Number(arg('minimum-free-bytes')||3*1024**3),growthLimit=Number(arg('maximum-binlog-growth-bytes')||256*1024**2);
   assert(Number.isSafeInteger(minFree)&&minFree>=3*1024**3);assert(Number.isSafeInteger(growthLimit)&&growthLimit>0&&growthLimit<=256*1024**2);
   const originalLogs=new Map((await query('SHOW BINARY LOGS')).map(r=>[r.Log_name,Number(r.File_size)]));
   const journal=await fs.open(file+`.journal-${Date.now()}.jsonl`,'ax',0o600);
   const append=async value=>{await journal.write(JSON.stringify(value)+'\n');await journal.sync();};
   try{
    const result=await applyListingSections({query,transaction,plan,beforeUpdate:async proof=>{
     const disk=await fs.statfs('/');assert(Number(disk.bavail)*Number(disk.bsize)>minFree+proof.old_bytes*4,'Disk reserve reached; stop this batch');
     const logs=await query('SHOW BINARY LOGS'),growth=logs.reduce((n,r)=>n+Math.max(0,Number(r.File_size)-(originalLogs.get(r.Log_name)||0)),0);assert(growth<growthLimit,'Binlog growth budget reached; archive/verify closed logs before next batch');
     await append({phase:'before_update',database:plan.database,server_uuid:plan.server_uuid,tenant_id:plan.tenant_id,table:plan.table,...proof});
    },afterUpdate:proof=>append({phase:'committed',id:proof.id,field:proof.field,stored_sha256:proof.stored_sha256})});
    await write(file+'.result.json',result);console.log(JSON.stringify({mode,updated_fields:result.updated.length,retained_fields:result.retained.length,result:file+'.result.json'}));
   }catch(error){await write(file+`.partial-${Date.now()}.json`,{...error.partialReport,incomplete:true,error:error.message});throw error;}finally{await journal.close();}
  }else if(mode==='verify'){
   assert.equal(plan.format,'listing-section-result-v1');const [id]=await query('SELECT DATABASE() AS db,@@server_uuid AS uuid');assert.equal(plan.database,id.db);assert.equal(plan.server_uuid,id.uuid);
   let verified=0;const allowed={listing_drafts:['manual_facts_json','ai_payload_json'],listing_category_templates:['editable_payload_json','attributes_json']};assert(Object.hasOwn(allowed,plan.table));
   for(const item of plan.updated){assert(allowed[plan.table].includes(item.field));const original=await readPrivateJson(item.archive);assert.equal(jsonArchiveHash(original),item.original_sha256);
    const [row]=await query(`SELECT ${item.field} AS stored_value FROM ${plan.table} WHERE id=? AND COALESCE(tenant_id,'admin')=?`,[item.id,plan.tenant_id]);assert(row);assert.equal(jsonArchiveHash(row.stored_value),item.stored_sha256);assert.deepEqual(JSON.parse(decodeListingJsonSections(row.stored_value)),JSON.parse(original));verified++;
   }console.log(JSON.stringify({mode,verified_fields:verified,readback_and_roundtrip_equal:true}));
  }else{const free=await fs.statfs('/');assert(Number(free.bavail)*Number(free.bsize)>3*1024**3+plan.updated.reduce((n,x)=>n+x.old_bytes*4,0),'Recovery disk reserve reached');console.log(JSON.stringify(await restoreListingSections({query,transaction,report:plan})));}
 }
}finally{await db.end();}
