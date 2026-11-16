import fs from 'node:fs/promises';
import mysql from 'mysql2/promise';
import {inspectWarehouseRepair,applyWarehouseRepair} from './lib/reviewed-warehouse-location.mjs';
const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith(`--${k}=`))?.slice(k.length+3),apply=args.includes('--apply');
let db;
try{
 const socketPath=value('mysql-admin-socket'),database=value('database'),plan=value('plan'),journal=value('journal');
 if(!socketPath||!database||!plan||(apply&&!journal))throw Error('Explicit socket, database, plan and apply journal required');
 const manifest=JSON.parse(await fs.readFile(plan,'utf8'));
 db=await mysql.createConnection({socketPath,user:'root',database,charset:'utf8mb4',dateStrings:true});
 await db.query("SET SESSION time_zone='+00:00'");await db.query('SET SESSION innodb_lock_wait_timeout=20');
 let result;
 if(apply){
  const [[lock]]=await db.query("SELECT GET_LOCK('ozon_warehouse_review_20261116',0) ok");if(lock.ok!==1)throw Error('Warehouse repair already running');
  result=await applyWarehouseRepair(db,manifest,{beforeCommit:async state=>{
   await fs.writeFile(journal,JSON.stringify({phase:'prepared',prepared_at:new Date().toISOString(),manifest,changes:state.changes,protected_digest:state.protected_digest,unchanged_digest:state.unchanged_digest,current_digest:state.current_digest},null,2),{flag:'wx',mode:0o600});
  }});
  const record=JSON.parse(await fs.readFile(journal,'utf8'));await fs.writeFile(journal,JSON.stringify({...record,phase:'committed',committed_at:new Date().toISOString(),result},null,2),{mode:0o600});
 }else{
  await db.query('START TRANSACTION READ ONLY');try{const state=await inspectWarehouseRepair(db,manifest);result={planned:state.changes.length,already:state.already.length,protected_count:state.protectedRows.length,warehouses:state.changes.reduce((n,c)=>(n[c.target]=(n[c.target]||0)+1,n),{}),unchanged_digest:state.unchanged_digest,protected_digest:state.protected_digest,current_digest:state.current_digest};}finally{await db.rollback();}
 }
 console.log(JSON.stringify({ok:true,mode:apply?'apply':'dry-run',...result}));
}catch(e){console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}
finally{if(db)await db.end();}
