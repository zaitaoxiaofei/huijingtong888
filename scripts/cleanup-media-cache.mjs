import {realpathSync} from 'node:fs';
import {writePrivateJsonFile} from '../src/services/verified-private-object.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import OSS from 'ali-oss';
import {ossStorageConfig} from '../src/services/object-storage.js';
import {cleanupAutomaticMediaCache} from '../src/services/automatic-media-cache.js';
import {mediaCoordinationRoot} from '../src/services/media-cache-coordination.js';

export async function runAutomaticMediaCache(args,env=process.env){
 if(args.length!==1||args[0]!=='--write')throw Error('Explicit --write is required');
 if(env.MEDIA_CACHE_LIFECYCLE_ENABLED!=='1')return {status:'disabled',deleted:0};
 if(process.platform!=='linux')throw Error('Automatic media cache eviction requires Linux');
 const storage=ossStorageConfig(env);if(!storage.enabled)throw Error('OSS required for automatic media cache eviction');
 if(!/^\w{1,64}$/.test(env.DB_NAME||'')||!env.DB_USER)throw Error('Explicit cache database identity required');
 const {default:mysql}=await import('mysql2/promise');const db=await mysql.createConnection({host:env.DB_HOST,port:Number(env.DB_PORT||3306),user:env.DB_USER,password:env.DB_PASSWORD,database:env.DB_NAME,...(env.DB_SOCKET_PATH?{socketPath:env.DB_SOCKET_PATH}:{})});
 try{
 const directory=env.MEDIA_CACHE_STATE_DIR||'/opt/ozon-erp/shared/storage-maintenance/media-cache';await fs.mkdir(directory,{recursive:true,mode:0o700});if((await fs.lstat(directory)).isSymbolicLink())throw Error('Unsafe cache state directory');
 const output=path.join(directory,'last-result.json');let previous={};try{const stat=await fs.lstat(output);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024**2)throw Error('Invalid cache result');previous=JSON.parse(await fs.readFile(output,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const query=async(sql,p=[])=>(await db.query(sql,p))[0];
 const gate=async work=>{const [r]=await query("SELECT GET_LOCK('ozon.media.cache.handshake.v1',30) AS locked");if(Number(r.locked)!==1)throw Error('Cache coordination lock unavailable');try{return await work();}finally{await query("SELECT RELEASE_LOCK('ozon.media.cache.handshake.v1')");}};
 const client=new OSS({region:storage.region,bucket:storage.bucket,accessKeyId:storage.accessKeyId,accessKeySecret:storage.accessKeySecret,stsToken:storage.stsToken||undefined,internal:true,secure:true,timeout:12000});
  const report=await cleanupAutomaticMediaCache({cwd:process.cwd(),query,client,storage,root:mediaCoordinationRoot(),gate,afterSource:previous.next_source||'',limit:Number(env.MEDIA_CACHE_CLEANUP_LIMIT||20),maxBytes:Number(env.MEDIA_CACHE_CLEANUP_MAX_BYTES||128*1024**2),maxCacheBytes:Number(env.MEDIA_CACHE_MAX_BYTES||1024**3),retentionHours:Number(env.MEDIA_CACHE_RETENTION_HOURS||24),minIdleMinutes:Number(env.MEDIA_CACHE_MIN_IDLE_MINUTES||60)});
  await writePrivateJsonFile(output,report);return report;
 }finally{await db.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href)runAutomaticMediaCache(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(error=>{console.error(JSON.stringify({status:'failed',error:error.message}));process.exitCode=1;});
