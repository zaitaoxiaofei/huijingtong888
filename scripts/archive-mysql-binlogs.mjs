import {verifyBinlogBaseline} from '../src/services/binlog-baseline.js';
import {realpathSync} from 'node:fs';
import {verifyMysqlBinlog} from './lib/verify-mysql-binlog.mjs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import OSS from 'ali-oss';
import {ossStorageConfig} from '../src/services/object-storage.js';
import {archiveClosedBinlogs} from '../src/services/binlog-archive.js';

export async function runBinlogArchive(args,env=process.env){
 if(args.some(a=>a!=='--write')||new Set(args).size!==args.length)throw Error('Only explicit --write is supported');
 if(env.BINLOG_ARCHIVE_ENABLED!=='1')return {status:'disabled',purged_files:0};
 const database=env.DB_NAME,socketPath=env.BINLOG_ARCHIVE_MYSQL_SOCKET||'/var/run/mysqld/mysqld.sock';if(!/^\w{1,64}$/.test(database||'')||!path.isAbsolute(socketPath))throw Error('Explicit database and administrator socket required');
 if(!/^[a-f0-9-]{36}$/.test(env.BINLOG_ARCHIVE_EXPECTED_UUID||''))throw Error('Reviewed MySQL UUID is required');
 const storage=ossStorageConfig(env);if(!storage.enabled)throw Error('OSS required for binlog archival');
 const {default:mysql}=await import('mysql2/promise'),db=await mysql.createConnection({user:'root',socketPath,database});
 try{const query=async(sql,params=[])=>(await db.query(sql,params))[0];
  const [locked]=await query("SELECT GET_LOCK('ozon.storage.binlog-archive',0) AS locked");if(Number(locked.locked)!==1)return {status:'busy',purged_files:0};
  try{
   const root=env.BINLOG_ARCHIVE_STATE_DIR||'/opt/ozon-erp/shared/storage-maintenance/binlogs';
   const client=new OSS({region:storage.region,bucket:storage.bucket,accessKeyId:storage.accessKeyId,accessKeySecret:storage.accessKeySecret,stsToken:storage.stsToken||undefined,internal:true,secure:true,timeout:180000});
   return await archiveClosedBinlogs({query,client,bucket:storage.bucket,stateDirectory:root,purge:args.includes('--write'),validateLog:file=>verifyMysqlBinlog(file,{binary:env.MYSQL_BINLOG_BIN||'/usr/bin/mysqlbinlog'}),expectedUuid:env.BINLOG_ARCHIVE_EXPECTED_UUID,verifyBaseline:details=>verifyBinlogBaseline({...details,client,key:env.BINLOG_ARCHIVE_BASELINE_MANIFEST_KEY,database}),keepClosed:Number(env.BINLOG_ARCHIVE_KEEP_CLOSED||2),maxFiles:Number(env.BINLOG_ARCHIVE_MAX_FILES||4),maxBytes:Number(env.BINLOG_ARCHIVE_MAX_BYTES||512*1024**2)});
  }finally{await query("SELECT RELEASE_LOCK('ozon.storage.binlog-archive')");}
 }finally{await db.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href)runBinlogArchive(process.argv.slice(2)).then(r=>console.log(JSON.stringify(r))).catch(async error=>{
 console.error(JSON.stringify({status:'failed',error:error.message,recovery_checkpoint:'inspect_pre_purge_proof'}));process.exitCode=1;
});
