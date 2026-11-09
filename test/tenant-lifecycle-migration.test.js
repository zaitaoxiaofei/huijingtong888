import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectTenantLifecycle, migrateTenantLifecycle } from '../scripts/migrate-tenant-lifecycle.mjs';
const fields={
 tenant_purge_audit:{tenant_id:['bigint unsigned','NO'],reason:['varchar(32)','NO'],actor_person_id:['bigint unsigned','YES'],row_counts_json:['json','NO'],purged_at:['datetime','NO']},
 tenant_purge_files:{id:['bigint unsigned','NO'],tenant_id:['bigint unsigned','NO'],kind:['varchar(32)','NO'],storage_name:['varchar(255)','NO'],status:['varchar(24)','NO'],last_error:['varchar(500)','YES'],last_attempt_at:['datetime','YES'],created_at:['datetime','NO']}
};
function fixture(ready=false){
 const state={starts:ready,tables:new Set(ready?Object.keys(fields):[]),name:ready?'汇进通企业':'默认企业',backfill:ready?0:1,badUnique:false,badColumn:false,badEngine:false};
 const mutations=[];
 async function query(sql,params=[]){
  if(sql.startsWith('SHOW COLUMNS FROM tenants'))return state.starts?[{Field:'subscription_started_at',Type:'datetime',Null:'YES'}]:[];
  if(sql.includes("TABLE_NAME='tenant_login_deliveries'"))return[{TABLE_NAME:'tenant_login_deliveries'}];
  if(sql.startsWith('SELECT TABLE_NAME'))return state.tables.has(params[0])?[{TABLE_NAME:params[0],ENGINE:state.badEngine?'MyISAM':'InnoDB'}]:[];
  if(sql.startsWith('SHOW COLUMNS FROM ')){const table=sql.split(' ').at(-1);return Object.entries(fields[table]).map(([Field,[Type,Null]])=>({Field,Type:state.badColumn&&Field==='row_counts_json'?'int':Type,Null,Extra:Field==='id'?'auto_increment':''}));}
  if(sql.startsWith('SHOW INDEX FROM ')){const table=sql.split(' ').at(-1);return[{Key_name:'PRIMARY',Column_name:table==='tenant_purge_files'?'id':'tenant_id',Seq_in_index:1,Non_unique:0},...(table==='tenant_purge_files'?['tenant_id','kind','storage_name'].map((Column_name,i)=>({Key_name:'uk_tenant_purge_file',Column_name,Seq_in_index:i+1,Non_unique:state.badUnique?1:0})):[])];}
  if(sql.startsWith('SELECT name'))return[{name:state.name}];
  if(sql.startsWith('SELECT COUNT(*)'))return[{n:state.backfill}];
  if(sql.includes('GET_LOCK'))return[{acquired:1}];
  if(sql.includes('RELEASE_LOCK'))return[];
  mutations.push(sql);
  if(sql.startsWith('ALTER TABLE'))state.starts=true;
  else if(sql.startsWith('CREATE TABLE'))state.tables.add(sql.match(/EXISTS (\w+)/)[1]);
  else if(sql.startsWith('UPDATE tenants SET name'))state.name='汇进通企业';
  else if(sql.startsWith('UPDATE tenants t JOIN')){assert.match(sql,/t\.updated_at=t\.created_at/);assert.match(sql,/t\.subscription_started_at IS NULL/);state.backfill=0;}
  else throw Error(sql);
  return[];
 }
 const connection={query:async(sql,params)=>[await query(sql,params)],beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},end:async()=>{}};
 return{state,query,mutations,connect:async()=>connection};
}
test('lifecycle dry run reports schema, internal rename and only source-proven starts without mutation',async()=>{
 const f=fixture();const report=await migrateTenantLifecycle({database:'erp_test',socketPath:'/test/mysql.sock',createConnection:f.connect});
 assert.equal(report.mode,'dry-run');assert.equal(report.changes_database,false);assert.equal(report.ready,false);
 assert.equal(report.rename_pending,true);assert.equal(report.proven_start_backfill_count,1);assert.equal(f.mutations.length,0);
});
test('reviewed lifecycle migration adds schema, renames only the old internal name and conservatively backfills proven starts',async()=>{
 const f=fixture();const report=await migrateTenantLifecycle({apply:true,database:'erp_test',socketPath:'/test/mysql.sock',createConnection:f.connect});
 assert.equal(report.ready,true);assert.equal(f.state.name,'汇进通企业');assert.equal(f.state.backfill,0);
 assert.ok(f.mutations.some(sql=>sql.includes("slug='default' AND name='默认企业'")));
 await assert.rejects(migrateTenantLifecycle({apply:true,database:'erp_test',createConnection:f.connect}),/socket/);
});
test('incompatible queue uniqueness, storage engine and column types refuse deployment instead of destructive repair',async()=>{
 for(const property of ['badUnique','badEngine','badColumn']){
  const f=fixture(true);f.state[property]=true;
  assert.equal((await inspectTenantLifecycle(f.query)).ok,false);
  await assert.rejects(migrateTenantLifecycle({apply:true,database:'erp_test',socketPath:'/test/mysql.sock',createConnection:f.connect}),/incompatible/);
  assert.equal(f.mutations.length,0);
 }
});
