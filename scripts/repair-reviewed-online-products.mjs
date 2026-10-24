import { readFile,writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import mysql from 'mysql2/promise';
import { inspectReviewedOnlineCleanup,applyReviewedOnlineCleanup,inspectOnlineCleanupJournal,rollbackReviewedOnlineCleanup } from './lib/reviewed-online-cleanup.mjs';

// Explicit local administrator socket only. Never load .env/application config.
let db;
try {
  const options=new Map(),bare=new Set(['apply','maintenance-confirmed']);
  for(const arg of process.argv.slice(2)) {
    const match=/^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if(!match||!['database','mysql-admin-socket','plan','output','apply','journal','rollback','maintenance-confirmed'].includes(match[1])||options.has(match[1])||(bare.has(match[1])?match[2]!==undefined:!match[2]))throw Error('Invalid, duplicate or non-bare flag');
    options.set(match[1],match[2]??true);
  }
  const database=options.get('database'),socketPath=options.get('mysql-admin-socket');
  if(!/^[a-zA-Z0-9_]{1,64}$/.test(database||'')||typeof socketPath!=='string'||!socketPath)throw Error('Explicit database and local administrator socket required');
  const actions=['apply','journal','rollback'].filter(key=>options.has(key));
  if(actions.length>1||((options.has('journal')||options.has('rollback'))===options.has('plan'))||options.has('maintenance-confirmed')&&!options.has('rollback'))throw Error('Choose one audit, apply, journal or rollback action');
  if(options.has('plan')&&!isAbsolute(options.get('plan')))throw Error('Absolute reviewed plan path required');
  if(options.has('output')&&!isAbsolute(options.get('output')))throw Error('Absolute output path required');
  db=await mysql.createConnection({socketPath,user:'root',database,supportBigNumbers:true,bigNumberStrings:true,dateStrings:true,jsonStrings:true});
  await db.query("SET SESSION time_zone='+00:00'");await db.query('SET SESSION max_execution_time=10000');
  let result;
  if(options.has('rollback'))result=await rollbackReviewedOnlineCleanup(db,options.get('rollback'),database,options.has('maintenance-confirmed'));
  else if(options.has('journal')){const state=await inspectOnlineCleanupJournal(db,options.get('journal'));result={repair_id:state.repair_id,phase:state.phase,mode:state.mode,archive:state.archive,shadow:state.shadow,undone:state.undone,references:state.references.map(ref=>({table:ref.table,rows:ref.ids.length}))};}
  else {
    const plan=JSON.parse(await readFile(options.get('plan'),'utf8'));
    if(options.has('apply'))result=await applyReviewedOnlineCleanup(db,plan,database);
    else {await db.query('START TRANSACTION READ ONLY');try{result=await inspectReviewedOnlineCleanup(db,plan);}finally{await db.rollback();}}
  }
  const text=JSON.stringify({ok:true,action:actions[0]||'audit',...result},null,2)+'\n';
  if(options.has('output'))await writeFile(options.get('output'),text,{mode:0o600,flag:'wx'});
  else process.stdout.write(text);
}catch(error){process.stderr.write(JSON.stringify({ok:false,code:error.code||'ONLINE_CLEANUP_REFUSED',error:error.safe?error.message:'Administrator cleanup refused; keep maintenance active and inspect the matching journal. Raw SQL and rows are intentionally redacted.'})+'\n');process.exitCode=1;}
finally{if(db)await db.end();}
