import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { TENANT_PURGE_SCHEMA } from '../src/services/tenant-lifecycle-schema.js';

export async function inspectTenantLifecycle(query) {
 const missing=[], incompatible=[];
 const starts=await query("SHOW COLUMNS FROM tenants LIKE 'subscription_started_at'");
 if(!starts.length)missing.push('tenants.subscription_started_at');
 else if(String(starts[0].Type).toLowerCase()!=='datetime'||starts[0].Null!=='YES')incompatible.push('tenants.subscription_started_at');
 for(const [table,fields,primary] of [
  ['tenant_purge_audit',['tenant_id','reason','actor_person_id','row_counts_json','purged_at'],'tenant_id'],
  ['tenant_purge_files',['id','tenant_id','kind','storage_name','status','last_error','last_attempt_at','created_at'],'id']
 ]){
  const present=await query('SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[table]);
  if(!present.length){missing.push(table);continue;}
  if(present[0].ENGINE!=='InnoDB')incompatible.push(`${table}.ENGINE`);
  const columns=await query(`SHOW COLUMNS FROM ${table}`);const names=new Set(columns.map(r=>r.Field));
  if(fields.some(name=>!names.has(name)))incompatible.push(table);
  const expected = table==='tenant_purge_audit' ? {tenant_id:['bigint unsigned',false],reason:['varchar(32)',false],actor_person_id:['bigint unsigned',true],row_counts_json:['json',false],purged_at:['datetime',false]}
    : {id:['bigint unsigned',false],tenant_id:['bigint unsigned',false],kind:['varchar(32)',false],storage_name:['varchar(255)',false],status:['varchar(24)',false],last_error:['varchar(500)',true],last_attempt_at:['datetime',true],created_at:['datetime',false]};
  for(const [name,[type,nullable]] of Object.entries(expected)){
    const column=columns.find(c=>c.Field===name);
    if(!column || String(column.Type).toLowerCase().replace(/bigint\(\d+\)/,'bigint')!==type || column.Null!==(nullable?'YES':'NO'))incompatible.push(`${table}.${name}`);
  }
  if(table==='tenant_purge_files'&&!String(columns.find(c=>c.Field==='id')?.Extra||'').includes('auto_increment'))incompatible.push('tenant_purge_files.id:auto_increment');
  const indexes=await query(`SHOW INDEX FROM ${table}`);
  const pk=indexes.filter(r=>r.Key_name==='PRIMARY').sort((a,b)=>Number(a.Seq_in_index)-Number(b.Seq_in_index));
  if(pk.length!==1||pk[0].Column_name!==primary)incompatible.push(`${table}.PRIMARY`);
  if(table==='tenant_purge_files'){
   const unique=indexes.filter(r=>r.Key_name==='uk_tenant_purge_file').sort((a,b)=>Number(a.Seq_in_index)-Number(b.Seq_in_index));
   if(unique.map(r=>r.Column_name).join(',')!=='tenant_id,kind,storage_name'||unique.some(r=>Number(r.Non_unique)!==0))incompatible.push('tenant_purge_files.uk_tenant_purge_file');
  }
 }
 const internal=await query("SELECT name FROM tenants WHERE slug='default'");
 const renamePending=internal[0]?.name==='默认企业';
 const deliveries=await query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tenant_login_deliveries'");
 let startsPending=0;
 if(deliveries.length){
  const rows=await query(`SELECT COUNT(*) AS n FROM tenants t JOIN tenant_login_deliveries d ON d.tenant_id=t.id
   WHERE t.updated_at=t.created_at AND t.subscription_status IN ('active','trial') ${starts.length?'AND t.subscription_started_at IS NULL':''}`);
  startsPending=Number(rows[0].n);
 }
 return {ok:!incompatible.length,ready:!missing.length&&!incompatible.length&&!renamePending&&!startsPending,
  missing,incompatible,rename_pending:renamePending,proven_start_backfill_count:startsPending};
}

export async function migrateTenantLifecycle({apply=false,database,socketPath,createConnection=mysql.createConnection}={}){
 if(!/^[a-zA-Z0-9_]{1,64}$/.test(database||''))throw Error('Explicit --database is required');
 if(apply&&!socketPath)throw Error('Apply requires explicit local --mysql-admin-socket');
 let pool;const connection=socketPath?await createConnection({socketPath,user:'root',database}):null;
 if(!connection){pool=await import('../src/mysql-pool.js');const {config}=await import('../src/config.js');if(database!==config.dbName)throw Error('Read-only database must match DB_NAME');}
 const query=connection?async(sql,params=[]) => (await connection.query(sql,params))[0]:pool.mysqlQuery;
 try{
  if(!apply)return{mode:'dry-run',changes_database:false,...await inspectTenantLifecycle(query)};
  const [lock]=await query("SELECT GET_LOCK('tenant_lifecycle_schema_v1',30) AS acquired");
  if(Number(lock?.acquired)!==1)throw Error('Lifecycle migration lock unavailable');
  try{
   const before=await inspectTenantLifecycle(query);if(before.incompatible.length)throw Error('Existing lifecycle schema is incompatible');
   if(before.missing.includes('tenants.subscription_started_at'))await query('ALTER TABLE tenants ADD COLUMN subscription_started_at DATETIME NULL');
   for(const sql of TENANT_PURGE_SCHEMA)await query(sql);
   await connection.beginTransaction();
   try{
    await query("UPDATE tenants SET name='汇进通企业' WHERE slug='default' AND name='默认企业'");
    if(before.proven_start_backfill_count)await query(`UPDATE tenants t JOIN tenant_login_deliveries d ON d.tenant_id=t.id
     SET t.subscription_started_at=t.created_at WHERE t.subscription_started_at IS NULL AND t.updated_at=t.created_at AND t.subscription_status IN ('active','trial')`);
    await connection.commit();
   }catch(error){await connection.rollback();throw error;}
   const after=await inspectTenantLifecycle(query);if(!after.ok||!after.ready)throw Error('Lifecycle migration verification failed');
   return{mode:'apply',changes_database:true,...after};
  }finally{await query("SELECT RELEASE_LOCK('tenant_lifecycle_schema_v1')");}
 }finally{if(connection)await connection.end();else await pool.closeMysqlPool();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const value=name=>process.argv.find(arg=>arg.startsWith(name+'='))?.slice(name.length+1);
 console.log(JSON.stringify(await migrateTenantLifecycle({apply:process.argv.includes('--apply'),database:value('--database'),socketPath:value('--mysql-admin-socket')})));
}
