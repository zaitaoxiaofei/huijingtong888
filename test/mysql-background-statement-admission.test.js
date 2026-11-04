import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {withMysqlWorkload,currentMysqlWorkload,withMysqlBackgroundReadAdmission,withMysqlTransactionPriority,mysqlWorkloadLimits,waitForMysqlInteractiveReads} from '../src/mysql-workload.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};

test('background writes queue behind scans before acquiring the single connection; interactive SQL stays live',async()=>{
 const hold=deferred(),started=deferred(),events=[];let backgroundActive=0;
 const context=vm.createContext({setTimeout,clearTimeout,performance,console,process,withMysqlBackgroundReadAdmission,withMysqlTransactionPriority,currentMysqlWorkload,mysqlWorkloadLimits,waitForMysqlInteractiveReads,config:{},mysql:{}});
 const source=readFileSync(new URL('../src/mysql-pool.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
 vm.runInContext(source,context);
 context.getMysqlConnection=async()=>{
  const background=currentMysqlWorkload()==='background';
  if(background){assert.equal(backgroundActive,0,'a queued write must not compete with the occupied background connection');backgroundActive++;}
  return{background,query:async(sql)=>{events.push(sql);if(sql==='scan'){started.resolve();await hold.promise;}return[[{ok:true}]];},execute:async(sql)=>{events.push(sql);if(sql==='failed write')throw Error('write fixture failed');return[{affectedRows:1}];},beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{}};
 };
 context.ensureMysqlSessionUtc=async()=>{};context.waitForMysqlInteractiveReads=async()=>{};
 context.releaseMysqlConnection=connection=>{if(connection.background)backgroundActive--;};
 const scan=withMysqlWorkload('background',()=>context.mysqlQuery('scan'));await started.promise;
 const writes=[withMysqlWorkload('background',()=>context.mysqlExecute('write')),withMysqlWorkload('background',()=>context.mysqlExecuteReadCommitted('snapshot'))];
 const settled=Promise.allSettled(writes);
 try{
  await withMysqlWorkload('foreground',()=>context.mysqlQuery('interactive'));
  assert.deepEqual(events,['scan','interactive']);
 }finally{hold.resolve();await scan;}
 const results=await settled;for(const result of results)assert.equal(result.status,'fulfilled',result.reason?.message);
 assert.deepEqual(events,['scan','interactive','write','SET TRANSACTION ISOLATION LEVEL READ COMMITTED','snapshot']);
 await assert.rejects(withMysqlWorkload('background',()=>context.mysqlExecute('failed write')),/write fixture failed/);
 await withMysqlWorkload('background',()=>context.mysqlExecute('after failure'));
 assert.equal(backgroundActive,0);assert.equal(events.at(-1),'after failure');
});

test('real single background connection survives a scan longer than acquire timeout while foreground SQL returns',{skip:!process.env.TENANT_TEST_MYSQL_SOCKET},async()=>{
 const {default:mysql}=await import('mysql2/promise');const {randomBytes}=await import('node:crypto');
 const socketPath=process.env.TENANT_TEST_MYSQL_SOCKET,database='ozon_admission_'+randomBytes(8).toString('hex');
 const admin=await mysql.createConnection({socketPath,user:'root'});let context,scan;
 try{
  const [[network]]=await admin.query('SELECT @@skip_networking disabled');assert.equal(Number(network.disabled),1);
  await admin.query(`CREATE DATABASE \`${database}\``);await admin.query(`CREATE TABLE \`${database}\`.events(id INT PRIMARY KEY)`);
  context=vm.createContext({mysql,setTimeout,clearTimeout,performance,console,process:{env:{...process.env,DB_SOCKET_PATH:socketPath}},withMysqlBackgroundReadAdmission,withMysqlTransactionPriority,currentMysqlWorkload,mysqlWorkloadLimits,waitForMysqlInteractiveReads,
   config:{dbClient:'mysql',dbUser:'root',dbName:database,dbPoolMax:2,dbPoolAcquireTimeoutMs:1000}});
  vm.runInContext(readFileSync(new URL('../src/mysql-pool.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,''),context);
  scan=withMysqlWorkload('background',()=>context.mysqlQuery('SELECT SLEEP(2)'));scan.catch(()=>{});
  const waitingAt=Date.now();while(context.getMysqlPoolMetrics().backgroundActive!==1){if(Date.now()-waitingAt>3000)throw Error('Scan did not acquire: '+JSON.stringify(context.getMysqlPoolMetrics()));await new Promise(r=>setTimeout(r,5));}
  const write=withMysqlWorkload('background',()=>context.mysqlExecute('INSERT INTO events VALUES (1)'));
  const snapshot=withMysqlWorkload('background',()=>context.mysqlExecuteReadCommitted('INSERT INTO events SELECT 2'));
  const done=Promise.allSettled([scan,write,snapshot]);
  const start=performance.now();await withMysqlWorkload('foreground',()=>context.mysqlQuery('SELECT 1'));
  assert.ok(performance.now()-start<1000,'foreground must not wait for the background scan');
  for(const result of await done)assert.equal(result.status,'fulfilled',result.reason?.message);
  const [[count]]=await admin.query(`SELECT COUNT(*) n FROM \`${database}\`.events`);assert.equal(count.n,2);
  assert.equal(context.getMysqlPoolMetrics().acquireTimeouts,0);
 }finally{if(scan)await Promise.allSettled([scan]);if(context)await context.closeMysqlPool();await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);await admin.end();}
});
