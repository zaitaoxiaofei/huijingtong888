import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {auditListingJsonDuplicates,applyListingJsonDuplicates,restoreListingJsonDuplicates} from "../src/services/listing-json-deduplication.js";

export async function runListingJsonStorage(args){
  const options=new Map();
  for(const argument of args){const m=/^--(mode|database|mysql-admin-socket|tenant-id|after-id|limit|manifest|output)=(.+)$/.exec(argument);if(!m||options.has(m[1]))throw new Error("Unknown or incomplete JSON maintenance option");options.set(m[1],m[2]);}
  const mode=options.get("mode")||"audit",database=options.get("database"),socketPath=options.get("mysql-admin-socket"),tenantId=options.get("tenant-id"),output=options.get("output");
  if(!["audit","apply","restore"].includes(mode)||!/^\w{1,64}$/.test(database||"")||!String(socketPath||"").startsWith("/")||!path.isAbsolute(output||"")||!/^(?:admin|[1-9][0-9]*)$/.test(tenantId||""))throw new Error("Explicit database, administrator socket, enterprise and absolute output required");
  if(mode!=="audit"&&!path.isAbsolute(options.get("manifest")||""))throw new Error("An explicit reviewed JSON manifest is required");
  const {default:mysql}=await import("mysql2/promise"),connection=await mysql.createConnection({socketPath,user:"root",database,dateStrings:true});
  const query=async(sql,params=[])=>(await connection.query(sql,params))[0];
  const transaction=async worker=>{await connection.beginTransaction();try{const result=await worker(query);await connection.commit();return result;}catch(error){await connection.rollback();throw error;}};
  try{
    await query("SET SESSION max_execution_time=20000");await query("SET SESSION innodb_lock_wait_timeout=5");
    if(mode==="audit")await query("SET SESSION TRANSACTION READ ONLY");
    let result;
    if(mode==="audit")result=await auditListingJsonDuplicates(query,{tenantId,afterId:Number(options.get("after-id")||0),limit:Number(options.get("limit")||200)});
    else{
      const file=options.get("manifest"),stat=await fs.lstat(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)throw new Error("Invalid JSON review manifest");
      const manifest=JSON.parse(await fs.readFile(file,"utf8"));if(manifest.tenant_id!==tenantId)throw new Error("Reviewed JSON manifest enterprise mismatch");
      try { result=mode==="apply"?await applyListingJsonDuplicates({query,transaction,plan:manifest}):await restoreListingJsonDuplicates({query,transaction,report:manifest}); }
      catch(error){
        if(error.partialReport){
          await fs.mkdir(path.dirname(output),{recursive:true,mode:0o700});
          await fs.writeFile(output,JSON.stringify({...error.partialReport,incomplete:true,error:error.message},null,2),{flag:"wx",mode:0o600});
        }
        throw error;
      }
    }
    await fs.mkdir(path.dirname(output),{recursive:true,mode:0o700});await fs.writeFile(output,JSON.stringify(result,null,2),{flag:"wx",mode:0o600});
    return mode==="audit"?{mode,manifest:output,sha256:result.sha256,sampled_rows:result.sampled_rows,duplicate_groups:result.groups.length,maximum_saving_bytes:result.maximum_saving_bytes,has_more:result.has_more,next_after_id:result.next_after_id}:{mode,result_file:output,updated_groups:result.updated?.length,restored:result.restored};
  }finally{await connection.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runListingJsonStorage(process.argv.slice(2)).then(x=>console.log(JSON.stringify(x))).catch(error=>{console.error(error.message);process.exitCode=1;});
