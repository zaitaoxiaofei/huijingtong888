import fs from "node:fs/promises";
import path from "node:path";

// Only reproducible HTTP reference downloads, never uploaded originals/crops,
// watermark files, generated outputs or arbitrary files under uploads/temp.
export async function cleanupTemporaryImageCache({root,now=Date.now(),retentionHours=48,limit=200,protectedHashes=new Set()}={}){
  if(!path.isAbsolute(root||"")||!Number.isFinite(now)||!Number.isInteger(retentionHours)||retentionHours<24||retentionHours>8760||!Number.isInteger(limit)||limit<1||limit>2000)throw new Error("Invalid temporary image cache bounds");
  const entries=await fs.readdir(root,{withFileTypes:true}).catch(error=>{if(error.code==="ENOENT")return [];throw error;});
  const cutoff=now-retentionHours*3600000,report={deleted:0,reclaimedBytes:0,retentionHours};
  for(const entry of entries){
    if(report.deleted>=limit)break;
    const match=/^([a-f0-9]{64})\.(?:png|jpg|jpeg|webp)(?:\.[a-f0-9-]{36}\.(?:part|partial))?$/.exec(entry.name);
    if(!entry.isFile()||entry.isSymbolicLink()||!match||protectedHashes.has(match[1]))continue;
    const file=path.join(root,entry.name),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.mtimeMs>cutoff)continue;
    const current=await fs.lstat(file).catch(error=>{if(error.code==="ENOENT")return null;throw error;});
    if(!current||current.ino!==stat.ino||current.size!==stat.size||current.mtimeMs!==stat.mtimeMs)continue;
    await fs.unlink(file);report.deleted++;report.reclaimedBytes+=stat.size;
  }
  return report;
}
