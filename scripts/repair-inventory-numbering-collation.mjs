import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const names=['products_inventory_number_insert','products_inventory_number_update'];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function fixNumberingTriggerCollation(sql){
 let count=0;
 const patched=sql.replace(/DECLARE (candidate_number|core_text|brand_text|brand_key_text|fitment_text) VARCHAR\((\d+)\)(?: CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci)?/g,(_,name,size)=>{count++;return `DECLARE ${name} VARCHAR(${size}) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`;});
 if(count!==5)throw Error('Unexpected numbering trigger variables; repair refused');
 return patched;
}
export async function inspectCollationRepair(db){
 const triggers=[];
 for(const name of names){const [[row]]=await db.query('SHOW CREATE TRIGGER '+name);const sql=row?.['SQL Original Statement'];if(!sql||!sql.includes('inventory_number_sequences_v2'))throw Error('Expected existing V2 trigger is missing');triggers.push({name,sql,sql_mode:row.sql_mode,collation:row.collation_connection,client:row.character_set_client,patched:fixNumberingTriggerCollation(sql)});}
 return{triggers,sha:hash(triggers),changed:triggers.filter(t=>t.sql!==t.patched).length};
}
export async function applyCollationRepair(db,{expectedSha,backupFile}){
 const before=await inspectCollationRepair(db);
 if(before.sha!==expectedSha)throw Error('Trigger definitions changed; inspect again before applying');
 if(!before.changed)return{ok:true,changed:0};
 if(!backupFile?.startsWith('/'))throw Error('An absolute backup file is required');
 await writeFile(backupFile,JSON.stringify({purpose:'inventory-numbering-collation-before',...before},null,2),{flag:'wx',mode:0o600});
 const [[session]]=await db.query('SELECT @@SESSION.sql_mode AS sql_mode,@@SESSION.collation_connection AS collation');
 await db.query('SET SESSION lock_wait_timeout=10');
 await db.query('LOCK TABLES products WRITE');
 let changed=[];
 try{
  const current=await inspectCollationRepair(db);if(current.sha!==expectedSha)throw Error('Trigger definitions changed while waiting for lock');
  for(const trigger of before.triggers){
   if(trigger.sql===trigger.patched)continue;
   if(!/^utf8mb4_[a-z0-9_]+$/.test(trigger.collation)||trigger.client!=='utf8mb4')throw Error('Unexpected trigger character set');
   await db.query('SET SESSION sql_mode=?',[trigger.sql_mode]);await db.query('SET NAMES utf8mb4 COLLATE '+trigger.collation);
   await db.query('DROP TRIGGER '+trigger.name);changed.push(trigger);
   await db.query(trigger.patched);
  }
  const after=await inspectCollationRepair(db);if(after.changed!==0)throw Error('Updated trigger definitions failed verification');
  return{ok:true,changed:changed.length,backup:backupFile,sha:after.sha,product_rows_changed:0};
 }catch(error){
  for(const trigger of changed.reverse()){
   await db.query('SET SESSION sql_mode=?',[trigger.sql_mode]);await db.query('SET NAMES utf8mb4 COLLATE '+trigger.collation);
   await db.query('DROP TRIGGER IF EXISTS '+trigger.name);await db.query(trigger.sql);
  }
  throw error;
 }finally{await db.query('UNLOCK TABLES');await db.query('SET SESSION sql_mode=?',[session.sql_mode]);if(/^utf8mb4_[a-z0-9_]+$/.test(session.collation))await db.query('SET NAMES utf8mb4 COLLATE '+session.collation);}
}
export async function runCollationRepair(args){
 const options=new Map();for(const arg of args){const m=/^--(database|mysql-admin-socket|expected-sha|backup-file|apply)(?:=(.*))?$/.exec(arg);if(!m||options.has(m[1])||(m[1]==='apply'?m[2]!==undefined:!m[2]))throw Error('Explicit database/socket required; optional --apply --expected-sha= --backup-file=');options.set(m[1],m[2]??true);}
 const database=options.get('database'),socketPath=options.get('mysql-admin-socket');
 if(!/^[A-Za-z0-9_]{1,64}$/.test(database||'')||!socketPath?.startsWith('/'))throw Error('Explicit database and local administrator socket required');
 const {default:mysql}=await import('mysql2/promise');const db=await mysql.createConnection({database,socketPath,user:'root'});
 try{if(options.has('apply'))return await applyCollationRepair(db,{expectedSha:options.get('expected-sha'),backupFile:options.get('backup-file')});const p=await inspectCollationRepair(db);return{mode:'read-only',changed:p.changed,sha:p.sha,product_rows_changed:0};}finally{await db.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runCollationRepair(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
