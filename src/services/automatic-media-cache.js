import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {withExclusiveMediaCache,registeredMediaPids,mediaCoordinationRoot} from './media-cache-coordination.js';
import {mediaCacheSource,cacheSourceFingerprint,verifyMediaObject,MEDIA_CACHE_EXTENSIONS} from './media-cache-files.js';
import {cacheFileFingerprint} from './media-cache-maintenance.js';
import {archivePrivateJson} from './private-json-archive.js';

const ROOTS=['ai-generated','ai-cropped','shop-variants','temp/image-cropper'];
export async function assertMediaCacheParticipants({root,cwd,inspectProcesses=async()=>(await promisify(execFile)('ps',['-eo','pid=,comm=,args='],{maxBuffer:4*1024**2})).stdout}){
 const registered=await registeredMediaPids(root);
 for(const line of (await inspectProcesses()).split('\n')){const match=/^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);if(!match||Number(match[1])===process.pid)continue;const [,pid,command,args]=match;
  if(/^(?:node|nodejs|tsx|ts-node)$/.test(command.toLowerCase())&&!/PM2.*God Daemon/.test(args)){
   if(registered.has(Number(pid)))continue;
   // This exact release-owned archive CLI never reads or writes media files.
   if(/(?:^|\s)(?:scripts\/archive-mysql-binlogs\.mjs)(?:\s|$)/.test(args)&&await fs.realpath(`/proc/${pid}/cwd`).catch(()=>null)===await fs.realpath(cwd))continue;
   throw Error('Unregistered Node reader/worker; automatic cache eviction refused');
  }
  if(/^(?:ffmpeg|ffprobe)$/.test(command))throw Error('Media video child process active; automatic cache eviction refused');
  if(/python/i.test(command)&&/(?:image[-_]cropper|image[-_]enhanc|ratio|watermark|uploads\/(?:ai-|shop-variants|temp\/image-cropper))/.test(args))throw Error('Media child process active; automatic cache eviction refused');
 }
}
// Local replicas only. This service never deletes OSS objects, mappings, task
// metadata or business rows; permanent-object retention remains a separate tool.
export async function cleanupAutomaticMediaCache({cwd,query,client,storage,root=mediaCoordinationRoot(),inspectProcesses,gate,limit=20,maxBytes=128*1024**2,maxCacheBytes=1024**3,retentionHours=24,minIdleMinutes=60,timeBudgetMs=15000,afterSource='',now=Date.now,archive=archivePrivateJson}){
 if(process.env.MEDIA_CACHE_LIFECYCLE_ENABLED!=='1')throw Error('Automatic media cache lifecycle is disabled');
 if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1024**3||!Number.isSafeInteger(maxCacheBytes)||maxCacheBytes<1||!Number.isFinite(retentionHours)||retentionHours<1||!Number.isFinite(minIdleMinutes)||minIdleMinutes<1||minIdleMinutes>retentionHours*60||!Number.isFinite(timeBudgetMs)||timeBudgetMs<1||timeBudgetMs>25000||!storage?.bucket)throw Error('Invalid automatic cache bounds');
 const check=()=>assertMediaCacheParticipants({root,cwd,inspectProcesses});await check();const files=[],started=now();
 for(const relative of ROOTS){const area=path.resolve(cwd,'uploads',relative);const areaStat=await fs.lstat(area).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(!areaStat)continue;if(areaStat.isSymbolicLink()||!areaStat.isDirectory())throw Error('Unsafe managed cache root');const canonical=await fs.realpath(area);
  async function walk(directory){for(const item of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,item.name);if(item.isSymbolicLink())continue;if(item.isDirectory())await walk(file);else if(item.isFile()&&MEDIA_CACHE_EXTENSIONS.has(path.extname(file).toLowerCase())){const stat=await fs.lstat(file);if(stat.nlink!==1)continue;const source=mediaCacheSource(file,cwd),marker=await fs.stat(path.join(root,'access',cacheSourceFingerprint(source))).catch(e=>{if(e.code==='ENOENT')return null;throw e;});files.push({file,source,stat,age:Math.max(stat.mtimeMs,marker?.mtimeMs||0),canonical});if(files.length>100000)throw Error('Cache inventory bound exceeded');}}}
  await walk(area);
 }
 files.sort((a,b)=>a.age-b.age||a.source.localeCompare(b.source));const cursor=files.findIndex(f=>f.source===afterSource);if(cursor>=0)files.push(...files.splice(0,cursor+1));const report={format:'automatic-local-cache-eviction-v1',inventory_bytes:files.reduce((n,f)=>n+f.stat.size,0),target_bytes:maxCacheBytes,checked:0,deleted:0,reclaimed_bytes:0,retained:[],started_at:new Date(started).toISOString()};
 for(const file of files){if(report.deleted>=limit||report.checked>=2000||now()-started>timeBudgetMs)break;const ageMs=now()-file.age,overBudget=report.inventory_bytes-report.reclaimed_bytes>maxCacheBytes;
  if(ageMs<(overBudget?minIdleMinutes*60000:retentionHours*3600000))continue;if(report.reclaimed_bytes+file.stat.size>maxBytes)continue;report.checked++;report.next_source=file.source;
  const fingerprint=await cacheFileFingerprint(file.file),[mapping]=await query("SELECT source_module,content_hash_sha256,byte_size,oss_object_key,oss_bucket,oss_url FROM media_migration_map WHERE source_fingerprint=? AND status='verified' LIMIT 1",[cacheSourceFingerprint(file.source)]);
  const object=mapping&&{hashSha256:mapping.content_hash_sha256,size:Number(mapping.byte_size),objectKey:mapping.oss_object_key,bucket:mapping.oss_bucket,url:mapping.oss_url};
  if(!object||mapping.source_module!=='durable_media_cache'||object.bucket!==storage.bucket||object.size!==fingerprint.size||object.hashSha256!==fingerprint.sha256){report.retained.push({source:file.source,reason:'verified_mapping_required'});continue;}
  await verifyMediaObject(client,object);
  const recovery={format:'local-cache-recovery-v1',source:file.source,fingerprint,object,mapping,created_at:new Date(now()).toISOString()};
  const cloud=await archive(JSON.stringify(recovery),{namespace:'media-cache/admin',client});
  if(!cloud?.objectKey?.startsWith('database-archives/media-cache/admin/')||!/[a-f0-9]{64}/.test(cloud.sha256||''))throw Error('Durable cache recovery proof missing');
  const result=await withExclusiveMediaCache(async()=>{
   await check();
   const [currentMapping]=await query("SELECT source_module,content_hash_sha256,byte_size,oss_object_key,oss_bucket,oss_url FROM media_migration_map WHERE source_fingerprint=? AND status='verified' LIMIT 1",[cacheSourceFingerprint(file.source)]);
   if(JSON.stringify(currentMapping)!==JSON.stringify(mapping))return {status:'mapping_changed',deleted:0};const real=await fs.realpath(file.file);if(!real.startsWith(file.canonical+path.sep))throw Error('Cache file escaped managed root');if(JSON.stringify(await cacheFileFingerprint(file.file))!==JSON.stringify(fingerprint))return {status:'changed',deleted:0};
   if(JSON.stringify(await cacheFileFingerprint(file.file))!==JSON.stringify(fingerprint))throw Error('Cache file changed before eviction');
   await fs.unlink(file.file);await fs.rm(path.join(root,'access',cacheSourceFingerprint(file.source)),{force:true});return {status:'evicted',deleted:1,recovery:cloud};
  },{root,gate});
  if(result.deleted){report.deleted++;report.reclaimed_bytes+=fingerprint.size;(report.recovery_manifests||=[]).push(result.recovery);}else report.retained.push({source:file.source,reason:result.status});
 }
 report.cache_bytes_after=report.inventory_bytes-report.reclaimed_bytes;report.over_budget=report.cache_bytes_after>maxCacheBytes;report.completed_at=new Date(now()).toISOString();return report;
}
