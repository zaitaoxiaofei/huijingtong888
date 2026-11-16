import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {immutableFileFingerprint,persistPrivateObject,verifyPrivateObject,writePrivateJsonFile as write} from './verified-private-object.js';

const logName=name=>/^binlog\.[0-9]{6,12}$/.test(name||'');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function identity(query){const [r]=await query('SELECT @@server_uuid AS uuid,@@datadir AS datadir');if(!/^[a-f0-9-]{36}$/.test(r?.uuid||'')||!path.isAbsolute(r.datadir||''))throw Error('Invalid MySQL archive identity');return r;}
async function noReplicas(query){if((await query('SHOW REPLICAS')).length)throw Error('Connected replicas prevent automatic binlog purge');const [r]=await query("SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE COMMAND LIKE 'Binlog Dump%'");if(Number(r.n))throw Error('Replication/CDC reader prevents automatic binlog purge');}
async function inventory(query){let status;try{status=await query('SHOW MASTER STATUS');}catch(e){if(e.code!=='ER_PARSE_ERROR')throw e;status=await query('SHOW BINARY LOG STATUS');}const [active]=status,logs=await query('SHOW BINARY LOGS');if(!active||!logName(active.File)||!logs.length||logs.some(r=>!logName(r.Log_name)||!Number.isSafeInteger(Number(r.File_size)))||logs.at(-1).Log_name!==active.File)throw Error('Invalid binary log inventory');for(let i=1;i<logs.length;i++)if(BigInt(logs[i].Log_name.split('.')[1])!==BigInt(logs[i-1].Log_name.split('.')[1])+1n)throw Error('Binary log inventory has a sequence gap');return {active,logs};}

// A checkpoint is only a retry optimization. Every PURGE rechecks local bytes,
// private cloud bytes, database identity, replication readers and prefix coverage.
export async function archiveClosedBinlogs({query,client,bucket,stateDirectory,keepClosed=2,maxFiles=4,maxBytes=512*1024**2,purge=false,expectedUuid,validateLog,verifyBaseline,now=()=>new Date()}){
 if(!Number.isSafeInteger(keepClosed)||keepClosed<1||keepClosed>100||!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>100||!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>4*1024**3||!path.isAbsolute(stateDirectory||'')||!bucket)throw Error('Invalid binlog archival bounds');
 if(typeof validateLog!=='function')throw Error('MySQL binlog checksum validator is required');
 const [expiry]=await query('SELECT @@binlog_expire_logs_seconds AS seconds,@@binlog_expire_logs_auto_purge AS auto_purge');if(purge&&(Number(expiry.seconds)!==0||Number(expiry.auto_purge)!==0))throw Error('Automatic expiry must be handed over explicitly before verified binlog purge');
 const id=await identity(query);if(expectedUuid&&id.uuid!==expectedUuid)throw Error('Reviewed MySQL UUID changed');await noReplicas(query);await fs.mkdir(stateDirectory,{recursive:true,mode:0o700});
 if((await fs.lstat(stateDirectory)).isSymbolicLink())throw Error('Symlink archive state refused');
 const stateFile=path.join(stateDirectory,'checkpoint.json');let saved={};try{const stat=await fs.lstat(stateFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024**2)throw Error('Invalid archive checkpoint');saved=JSON.parse(await fs.readFile(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(saved.uuid&&saved.uuid!==id.uuid||saved.bucket&&saved.bucket!==bucket)throw Error('Archive checkpoint database/bucket changed');
 const {active,logs}=await inventory(query);for(const old of saved.observed_logs||[])if(!logs.some(r=>r.Log_name===old)&&!saved.entries?.[old])throw Error('An unarchived binary log disappeared; restore chain requires review');const closed=logs.slice(0,-1),entries={},report={format:'automatic-binlog-archive-v1',uuid:id.uuid,bucket,started_at:now().toISOString(),active_log:active.File,archived_files:0,archived_bytes:0,purged_files:0,purged_bytes:0};let bytes=0;
 for(const row of closed){
  const file=path.join(id.datadir,row.Log_name),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==Number(row.File_size))throw Error('Binary log changed or unsafe source');
  const keyIdentity=[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':'),prior=saved.entries?.[row.Log_name];
  if(prior?.identity===keyIdentity&&prior.object_key===`database-archives/mysql-binlogs/${id.uuid}/${row.Log_name}-${prior.sha256}.binlog`&&/^[a-f0-9]{64}$/.test(prior.sha256)&&prior.bytes===stat.size){let present=true;try{await client.head(prior.object_key);}catch(e){if(Number(e.status||e.statusCode)===404||e.code==='NoSuchKey')present=false;else throw e;}if(present){entries[row.Log_name]=prior;continue;}}
  if(stat.size>maxBytes)throw Error('Closed binlog exceeds reviewed batch budget; original retained');
  if(report.archived_files>=maxFiles||bytes+stat.size>maxBytes){report.paused='batch_budget';break;}
  const fingerprint=await immutableFileFingerprint(file);await validateLog(file);const objectKey=`database-archives/mysql-binlogs/${id.uuid}/${row.Log_name}-${fingerprint.sha256}.binlog`;
  await persistPrivateObject(client,objectKey,file,{expected:fingerprint});assert.deepEqual(await immutableFileFingerprint(file),fingerprint);
  entries[row.Log_name]={name:row.Log_name,...fingerprint,object_key:objectKey};bytes+=fingerprint.bytes;report.archived_files++;report.archived_bytes+=fingerprint.bytes;
 }
 if(report.archived_files===0&&closed.length<=keepClosed){report.status='up_to_date';report.private_manifest=saved.private_manifest;report.completed_at=now().toISOString();await write(path.join(stateDirectory,'last-result.json'),report);return report;}
 if(purge&&typeof verifyBaseline!=='function')throw Error('Verified full-database recovery baseline required for purge');
 const baseline=purge?await verifyBaseline({uuid:id.uuid,logs,previous:saved.baseline}):saved.baseline||null;
 const manifest={...report,baseline,entries:Object.values(entries),retained_position:Number(active.Position),executed_gtid_set:String(active.Executed_Gtid_Set||'')};
 const body=Buffer.from(JSON.stringify(manifest)),manifestKey=`database-archives/mysql-binlogs/${id.uuid}/manifests/${sha(body)}.json`;
 const proof=await persistPrivateObject(client,manifestKey,body,{expected:{bytes:body.length,sha256:sha(body)},contentType:'application/json'});
 await write(stateFile,{uuid:id.uuid,bucket,entries,baseline,observed_logs:logs.map(r=>r.Log_name),private_manifest:proof});
 if(purge){
  const current=await inventory(query),eligible=current.logs.slice(0,-1).slice(0,-keepClosed);const selected=[];
  for(const row of eligible){if(!entries[row.Log_name])break;const entry=entries[row.Log_name];assert.equal(Number(row.File_size),entry.bytes);const local=await immutableFileFingerprint(path.join(id.datadir,row.Log_name));await validateLog(path.join(id.datadir,row.Log_name));assert.equal(local.sha256,entry.sha256);assert.equal(local.identity,entry.identity);await verifyPrivateObject(client,entry.object_key,entry);selected.push(entry);}
  if(selected.length){
   const boundary=current.logs[selected.length]?.Log_name;if(!logName(boundary)||boundary===current.logs[0].Log_name)throw Error('Invalid binlog purge boundary');
   await verifyPrivateObject(client,proof.object_key,proof);await noReplicas(query);assert.deepEqual(await identity(query),id);
   const fresh=await inventory(query);assert.deepEqual(fresh.logs.slice(0,selected.length).map(r=>[r.Log_name,Number(r.File_size)]),selected.map(r=>[r.name,r.bytes]));
   await write(path.join(stateDirectory,'pre-purge.json'),{private_manifest:proof,purge_to:boundary,files:selected.map(r=>r.name),checked_at:now().toISOString()});
   await query(`PURGE BINARY LOGS TO '${boundary}'`);const remaining=await inventory(query);if(remaining.logs.some(r=>selected.some(s=>s.name===r.Log_name)))throw Error('MySQL did not complete binlog purge');
   report.purged_files=selected.length;report.purged_bytes=selected.reduce((n,r)=>n+r.bytes,0);report.retained_boundary=boundary;
  }
 }
 report.private_manifest=proof;report.completed_at=now().toISOString();await write(path.join(stateDirectory,'last-result.json'),report);return report;
}
