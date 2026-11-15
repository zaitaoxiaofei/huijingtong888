import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { createReadStream } from "node:fs";
import { MEDIA_CACHE_ROOTS, MEDIA_CACHE_EXTENSIONS, mediaCacheSource, archiveMediaCacheFile, verifyMediaObject, cacheSourceFingerprint } from "./media-cache-files.js";
import { auditMediaCacheReferences } from "./ai-media-retention.js";

export const MEDIA_CACHE_MANIFEST_VERSION = "oss-media-cache-v1";
export const mediaCacheManifestHash = manifest => crypto.createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(manifest).filter(([key])=>key!=="sha256")))).digest("hex");
export async function cacheFileFingerprint(filePath) {
  const before=await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Cache candidate is not a regular file");
  const hash=crypto.createHash("sha256");for await(const chunk of createReadStream(filePath))hash.update(chunk);
  const after=await fs.lstat(filePath);
  if (before.ino!==after.ino || before.size!==after.size || before.mtimeMs!==after.mtimeMs)throw new Error("Cache file changed during verification");
  return {size:after.size,mtimeMs:after.mtimeMs,ino:after.ino,device:after.dev,sha256:hash.digest("hex")};
}
export function mediaCacheAliases(source) {
  const match=/^\/uploads\/(ai-generated|ai-cropped)\/([^/]+)\/(.+)$/.exec(source);
  if(match)return [source,source.slice(1),`/api/ai/file/${encodeURIComponent(match[2])}/${match[1]==="ai-generated"?"generated":"cropped"}/${match[3]}`];
  const variant=/^\/uploads\/shop-variants\/([^/]+)\/(.+)$/.exec(source);
  if(variant)return [source,source.slice(1),`/api/asset-variant-engine/files/${encodeURIComponent(variant[1])}/${variant[2]}`];
  const cropper=/^\/uploads\/temp\/image-cropper\/([^/]+)\/(.+)$/.exec(source);
  if(cropper)return [source,source.slice(1),`/api/tools/image-cropper/file/${encodeURIComponent(cropper[1])}/${cropper[2]}`];
  if(source.startsWith("/uploads/shop-watermarks/"))return [source,source.slice(1),source.slice("/uploads/".length)];
  return [source,source.slice(1)];
}
async function safeFile(cwd,relativePath){
  const filePath=path.resolve(cwd,relativePath),source=mediaCacheSource(filePath,cwd);
  const root=await fs.realpath(path.resolve(cwd,"uploads",source.split("/")[2]));
  const real=await fs.realpath(filePath),relative=path.relative(root,real);
  if(relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error("Cache candidate escapes managed root");
  return filePath;
}
async function mapping(query,source){
  const [row]=await query("SELECT source_module,content_hash_sha256,byte_size,oss_object_key,oss_bucket,oss_url FROM media_migration_map WHERE source_fingerprint=? AND status='verified' LIMIT 1",[cacheSourceFingerprint(source)]);
  return row?{module:row.source_module,hashSha256:row.content_hash_sha256,size:Number(row.byte_size),objectKey:row.oss_object_key,bucket:row.oss_bucket,url:row.oss_url}:null;
}
async function filesIn(root,files,cutoff){
  const entries=await fs.readdir(root,{withFileTypes:true}).catch(error=>{if(error.code==="ENOENT")return [];throw error;});
  for(const entry of entries){
    if(entry.isSymbolicLink())continue;const file=path.join(root,entry.name);
    if(entry.isDirectory())await filesIn(file,files,cutoff);
    else if(entry.isFile()&&MEDIA_CACHE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())){
      const stat=await fs.lstat(file);if(stat.mtimeMs<=cutoff)files.push({file,mtime:stat.mtimeMs});
    }
    if(files.length>100000)throw new Error("Media cache inventory exceeds the scan bound");
  }
}
export async function auditMediaCache({cwd,query,storage,client,limit=200,retentionDays=7,now=Date.now(),scanReferences=auditMediaCacheReferences}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>5000||!Number.isSafeInteger(retentionDays)||retentionDays<1||retentionDays>3650)throw new Error("Invalid cache audit bounds");
  const [{database_name,server_uuid}]=await query("SELECT DATABASE() AS database_name,@@server_uuid AS server_uuid");
  const files=[];for(const area of MEDIA_CACHE_ROOTS)await filesIn(path.resolve(cwd,"uploads",area==="temp"?"temp/image-cropper":area),files,now-retentionDays*86400000);
  files.sort((a,b)=>a.mtime-b.mtime||a.file.localeCompare(b.file));const items=[];
  for(const {file}of files.slice(0,limit)){
    const relativePath=path.relative(cwd,file).split(path.sep).join("/");await safeFile(cwd,relativePath);
    const fingerprint=await cacheFileFingerprint(file),source=mediaCacheSource(file,cwd),object=await mapping(query,source);
    const item={relativePath,source,fingerprint,object,remote_verified:false};
    if(object&&object.bucket===storage.bucket&&object.size===fingerprint.size&&object.hashSha256===fingerprint.sha256){
      try{await verifyMediaObject(client,object);item.remote_verified=true;}catch(error){item.verification_error=error.message;}
    }
    items.push(item);
  }
  const references=await scanReferences({query,storage,sources:items.flatMap(item=>mediaCacheAliases(item.source))});
  const result={format:MEDIA_CACHE_MANIFEST_VERSION,reader_version:1,database:database_name,server_uuid,cwd:await fs.realpath(cwd),bucket:storage.bucket,
    generated_at:new Date(now).toISOString(),retention_days:retentionDays,inventory_candidates:files.length,has_more:files.length>limit,items,references};
  return {...result,sha256:mediaCacheManifestHash(result)};
}
export async function applyMediaCacheManifest({manifest,mode,cwd,query,storage,client,maintenance,archive=archiveMediaCacheFile,scanReferences=auditMediaCacheReferences}){
  if(!["archive","clean"].includes(mode)||manifest.format!==MEDIA_CACHE_MANIFEST_VERSION||manifest.sha256!==mediaCacheManifestHash(manifest))throw new Error("Invalid reviewed cache manifest");
  if(manifest.cwd!==await fs.realpath(cwd)||manifest.bucket!==storage.bucket)throw new Error("Cache manifest storage identity changed");
  const [identity]=await query("SELECT DATABASE() AS database_name,@@server_uuid AS server_uuid");
  if(manifest.database!==identity.database_name||manifest.server_uuid!==identity.server_uuid)throw new Error("Cache manifest database identity changed");
  if(!manifest.references.complete)throw new Error("Reference scan is incomplete; archive/clean refused");
  const report={mode,archived:0,deleted:0,reclaimed_bytes:0,retained:[]};
  // Archive adds durable copies and mappings only; it never changes business references.
  if(mode==="clean"){
    if(typeof maintenance!=="function")throw new Error("Reviewed offline maintenance is required for cache deletion");
    await maintenance();
    const current=await scanReferences({query,storage,sources:manifest.items.flatMap(item=>mediaCacheAliases(item.source))});
    if(!current.complete||JSON.stringify(current.references)!==JSON.stringify(manifest.references.references))throw new Error("Media references changed since audit");
  }
  for(const item of manifest.items){
    const file=await safeFile(cwd,item.relativePath),current=await cacheFileFingerprint(file);
    if(item.source!==mediaCacheSource(file,cwd))throw new Error("Reviewed source differs from cache path");
    if(JSON.stringify(current)!==JSON.stringify(item.fingerprint)){report.retained.push({source:item.source,reason:"file_changed"});continue;}
    if(mode==="archive"){
      await archive(file,{cwd,env:storage.env,client,sourceUrl:mediaCacheAliases(item.source).find(value=>value.startsWith("/api/"))||""});report.archived++;continue;
    }
    const object=await mapping(query,item.source);
    if(!item.remote_verified||!object||object.module!=="durable_media_cache"||JSON.stringify(object)!==JSON.stringify(item.object)){
      report.retained.push({source:item.source,reason:"verified_recoverable_mapping_required"});continue;
    }
    await verifyMediaObject(client,object);await maintenance();
    if(JSON.stringify(await cacheFileFingerprint(file))!==JSON.stringify(item.fingerprint))throw new Error("Cache file changed before deletion");
    await fs.unlink(file);report.deleted++;report.reclaimed_bytes+=item.fingerprint.size;
  }
  return report;
}
