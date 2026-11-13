import {pathToFileURL} from 'node:url';
import {WB_SCHEMA} from '../src/services/wb-schema.js';
const descriptors={wb_publish_jobs:{columns:['id','tenant_id','shop_id','draft_id','draft_revision','person_id','environment','seller_id','review_hash','status','payload_json','state_json','message','lease_token','lease_until','next_run_at'],unique:['id','draft_id,draft_revision']},wb_catalog_cache:{columns:['tenant_id','environment','resource_key','locale','payload_json','checked_at'],unique:['tenant_id,environment,resource_key,locale']},wb_listing_templates:{columns:['id','tenant_id','name','subject_id','attributes_json','defaults_json','revision'],unique:['id','tenant_id,name']},wb_listing_drafts:{columns:['id','tenant_id','shop_id','template_id','vendor_code','payload_json','status','revision'],unique:['id','shop_id,vendor_code']}};
export async function inspectWbCatalogSchema(query){
 const missing=[],problems=[];
 for(const [name,expected] of Object.entries(descriptors)){
  const columns=await query('SELECT COLUMN_NAME,DATA_TYPE FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=?',[name]);
  if(!columns.length){missing.push(name);continue;}
  const names=new Set(columns.map(c=>c.COLUMN_NAME));for(const field of expected.columns)if(!names.has(field))problems.push(`${name}.${field}`);
  for(const c of columns)if(['payload_json','state_json','attributes_json','defaults_json'].includes(c.COLUMN_NAME)&&c.DATA_TYPE!=='json')problems.push(`${name}.${c.COLUMN_NAME}:type`);
  const keys=await query('SELECT INDEX_NAME,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND NON_UNIQUE=0 GROUP BY INDEX_NAME',[name]);
  for(const key of expected.unique)if(!keys.some(k=>k.cols===key))problems.push(`${name}:unique:${key}`);
 }
 return {ok:!problems.length,ready:!missing.length&&!problems.length,missing_tables:missing,problems};
}
export async function migrateWbCatalog(query,{apply=false}={}){
 const before=await inspectWbCatalogSchema(query);if(!before.ok)throw Error('WB listing schema incompatible; no changes applied');
 if(apply)for(const sql of WB_SCHEMA)if(Object.keys(descriptors).some(name=>sql.startsWith(`CREATE TABLE IF NOT EXISTS ${name} (`)))await query(sql);
 return {mode:apply?'apply':'dry-run',changes_database:apply,...(apply?await inspectWbCatalogSchema(query):before)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=new Map();for(const arg of process.argv.slice(2)){const m=/^--(database|mysql-admin-socket)=(.+)$/.exec(arg);if(m&&!args.has(m[1]))args.set(m[1],m[2]);else if(arg==='--apply'&&!args.has('apply'))args.set('apply',true);else throw Error('Unknown migration argument');}
 if(!/^[A-Za-z0-9_]{1,64}$/.test(args.get('database')||'')||!args.get('mysql-admin-socket')?.startsWith('/'))throw Error('Explicit database and administrator socket required');
 const {default:mysql}=await import('mysql2/promise');const connection=await mysql.createConnection({socketPath:args.get('mysql-admin-socket'),database:args.get('database'),user:'root'});
 try{await connection.query('SET SESSION lock_wait_timeout=10');if(!args.has('apply'))await connection.query('START TRANSACTION READ ONLY');console.log(JSON.stringify(await migrateWbCatalog(async(sql,p=[])=>(await connection.query(sql,p))[0],{apply:args.has('apply')})));}finally{await connection.end();}
}
