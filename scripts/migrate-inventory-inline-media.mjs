import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import mysql from 'mysql2/promise';
import {auditInventoryInlineMedia,applyInventoryInlineMedia,restoreInventoryInlineMedia} from '../src/services/inventory-inline-media-migration.js';
import {readPrivateJson,jsonArchiveHash} from '../src/services/private-json-archive.js';
import {prepareInventoryInlineMedia} from '../src/services/database-inline-media.js';

const arg=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3),mode=arg('mode')||'audit';
assert(['audit','apply','verify','restore'].includes(mode));assert(arg('socket')?.startsWith('/')&&/^[A-Za-z0-9_]+$/.test(arg('database')||''));
if(['apply','restore'].includes(mode))assert(process.argv.includes('--write'),'Explicit --write required');
const db=await mysql.createConnection({socketPath:arg('socket'),user:'root',database:arg('database'),dateStrings:true}),query=async(sql,p=[])=>(await db.query(sql,p))[0];
const transaction=async work=>{await db.beginTransaction();try{const r=await work(query);await db.commit();return r;}catch(e){await db.rollback();throw e;}};
const write=(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2),{mode:0o600,flag:'wx'});
try{
 await query('SET SESSION max_execution_time=20000');await query('SET SESSION innodb_lock_wait_timeout=5');
 if(['audit','verify'].includes(mode))await query('SET SESSION TRANSACTION READ ONLY');
 const file=arg('plan');
 if(mode==='audit'){
  const out=arg('out');assert(out&&path.isAbsolute(out));const plan=await auditInventoryInlineMedia(query,{tenantId:arg('tenant'),afterId:Number(arg('after-id')||0),limit:10});await write(out,plan);console.log(JSON.stringify({mode,plan:out,rows:plan.items.length,has_more:plan.has_more,next_after_id:plan.next_after_id,retained:plan.retained.length}));
 }else{
  assert(file&&path.isAbsolute(file));const plan=JSON.parse(await fs.readFile(file,'utf8'));
  if(mode==='apply'){
   const log=await fs.open(file+`.journal-${Date.now()}.jsonl`,'ax',0o600),initial=new Map((await query('SHOW BINARY LOGS')).map(r=>[r.Log_name,Number(r.File_size)]));
   const append=async data=>{await log.write(JSON.stringify(data)+'\n');await log.sync();};
   try{
    const result=await applyInventoryInlineMedia({query,transaction,plan,beforeUpdate:async proof=>{
     const free=await fs.statfs('/');assert(Number(free.bavail)*Number(free.bsize)>3*1024**3+proof.old_bytes*4,'Disk reserve reached');
     const growth=(await query('SHOW BINARY LOGS')).reduce((n,r)=>n+Math.max(0,Number(r.File_size)-(initial.get(r.Log_name)||0)),0);assert(growth<256*1024**2,'Binlog batch budget reached');
     await append({phase:'before_update',database:plan.database,server_uuid:plan.server_uuid,tenant_id:plan.tenant_id,...proof});
    },afterUpdate:proof=>append({phase:'committed',id:proof.id,new_sha256:proof.new_sha256})});
    await write(file+'.result.json',result);console.log(JSON.stringify({mode,updated:result.updated.length,retained:result.retained.length,result:file+'.result.json'}));
   }catch(error){await write(file+`.partial-${Date.now()}.json`,{...error.partialReport,incomplete:true,error:error.message});throw error;}finally{await log.close();}
  }else if(mode==='verify'){
   assert.equal(plan.format,'inventory-inline-media-result-v1');const [identity]=await query('SELECT DATABASE() AS db,@@server_uuid AS uuid');assert.equal(plan.database,identity.db);assert.equal(plan.server_uuid,identity.uuid);
   let verified=0;
   for(const item of plan.updated){
    assert(Number.isSafeInteger(item.id)&&item.id>0);const old=await readPrivateJson(item.archive);assert.equal(jsonArchiveHash(old),item.original_sha256);
    const prepared=await prepareInventoryInlineMedia(JSON.parse(old));
    const tenant=plan.tenant_id==='admin'?"(tenant_id IS NULL OR tenant_id=(SELECT id FROM tenants WHERE slug='default' AND status='active' LIMIT 1))":'tenant_id=?';
    const [row]=await query(`SELECT image_url,detail_image_urls FROM products WHERE id=? AND ${tenant}`,[item.id,...(plan.tenant_id==='admin'?[]:[Number(plan.tenant_id)])]);assert(row);
    const next={image_url:prepared.image_url,detail_image_urls:Array.isArray(prepared.detail_image_urls)?JSON.stringify(prepared.detail_image_urls):prepared.detail_image_urls};assert.deepEqual(row,next);assert.equal(jsonArchiveHash(JSON.stringify(next)),item.new_sha256);verified++;
   }console.log(JSON.stringify({mode,verified,original_media_readback_equal:true}));
  }else{const free=await fs.statfs('/');assert(Number(free.bavail)*Number(free.bsize)>3*1024**3+plan.updated.reduce((n,x)=>n+x.old_bytes*4,0),'Recovery disk reserve reached');console.log(JSON.stringify(await restoreInventoryInlineMedia({query,transaction,report:plan})));}
 }
}finally{await db.end();}
