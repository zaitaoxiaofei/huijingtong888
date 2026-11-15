import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import OSS from "ali-oss";
import {ossStorageConfig} from "../src/services/object-storage.js";
import {auditMediaCache,applyMediaCacheManifest} from "../src/services/media-cache-maintenance.js";
import {verifyAiMediaRetentionMaintenance} from "./cleanup-ai-media-retention.mjs";

export async function runMediaCacheMaintenance(args){
  const options=new Map();
  for(const argument of args){const m=/^--(mode|database|mysql-admin-socket|output|manifest|limit|days|offline-maintenance)(?:=(.*))?$/.exec(argument);
    if(!m||options.has(m[1])||(m[1]==="offline-maintenance"?m[2]!==undefined:!m[2]))throw new Error("Unknown or incomplete cache maintenance option");options.set(m[1],m[2]??true);}
  const mode=options.get("mode")||"audit",database=options.get("database"),socketPath=options.get("mysql-admin-socket"),output=options.get("output");
  if(!["audit","archive","clean"].includes(mode)||!/^\w{1,64}$/.test(database||"")||!String(socketPath||"").startsWith("/")||!path.isAbsolute(output||""))throw new Error("Explicit database, administrator socket and absolute output are required");
  if(mode!=="audit"&&!path.isAbsolute(options.get("manifest")||""))throw new Error("A reviewed manifest is required");
  if(mode==="clean"&&!options.has("offline-maintenance"))throw new Error("Clean requires explicit offline maintenance");
  const {default:mysql}=await import("mysql2/promise"),connection=await mysql.createConnection({user:"root",socketPath,database,dateStrings:true});
  const query=async(sql,params=[])=>(await connection.query(sql,params))[0];
  try{
    const storage={...ossStorageConfig(),env:process.env};
    if(!storage.enabled)throw new Error("OSS is required for cache maintenance");
    const client=new OSS({region:storage.region,bucket:storage.bucket,accessKeyId:storage.accessKeyId,accessKeySecret:storage.accessKeySecret,stsToken:storage.stsToken||undefined,secure:true,timeout:60000});
    await query("SET SESSION max_execution_time=20000");
    if(mode==="audit")await query("SET SESSION TRANSACTION READ ONLY");
    const common={cwd:process.cwd(),query,storage,client};
    let result;
    if(mode==="audit")result=await auditMediaCache({...common,limit:Number(options.get("limit")||200),retentionDays:Number(options.get("days")||7)});
    else{
      const file=options.get("manifest"),stat=await fs.lstat(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32*1024*1024)throw new Error("Invalid cache manifest file");
      const manifest=JSON.parse(await fs.readFile(file,"utf8"));
      result=await applyMediaCacheManifest({...common,manifest,mode,maintenance:options.has("offline-maintenance")?()=>verifyAiMediaRetentionMaintenance({query}):null});
    }
    await fs.mkdir(path.dirname(output),{recursive:true,mode:0o700});await fs.writeFile(output,JSON.stringify(result,null,2),{flag:"wx",mode:0o600});
    return mode==="audit"?{mode,manifest:output,sha256:result.sha256,files:result.items.length,verified:result.items.filter(x=>x.remote_verified).length,reference_scan_complete:result.references.complete,has_more:result.has_more}:result;
  }finally{await connection.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runMediaCacheMaintenance(process.argv.slice(2)).then(x=>console.log(JSON.stringify(x))).catch(error=>{console.error(error.message);process.exitCode=1;});
