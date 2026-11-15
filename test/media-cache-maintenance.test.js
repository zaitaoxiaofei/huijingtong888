import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {Readable} from "node:stream";
process.env.DB_HOST||="127.0.0.1";process.env.DB_NAME||="media_maintenance_test";process.env.DB_USER||="test";
const {auditMediaCache,applyMediaCacheManifest,mediaCacheManifestHash}=await import("../src/services/media-cache-maintenance.js");
const content=Buffer.from("cache content"),hash=crypto.createHash("sha256").update(content).digest("hex");
async function fixture(t){
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),"cache-review-"));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const file=path.join(cwd,"uploads","ai-generated","test-task","output.png");await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);await fs.utimes(file,new Date(0),new Date(0));
  const row={source_module:"durable_media_cache",content_hash_sha256:hash,byte_size:content.length,oss_object_key:`ai-task-media/${hash.slice(0,2)}/${hash}.png`,oss_bucket:"test",oss_url:"https://test.invalid/media.png"};
  const query=async sql=>sql.includes("server_uuid")?[{database_name:"fixture",server_uuid:"fixture-uuid"}]:[row];
  const refs={complete:true,scanned:5,references:{"url:/uploads/ai-generated/test-task/output.png":["listing_drafts:1"]}};
  const options={cwd,query,storage:{bucket:"test",env:{}},client:{async getStream(){return{stream:Readable.from([content])};}},scanReferences:async()=>refs};
  return {file,row,refs,options,manifest:await auditMediaCache(options)};
}
test("review includes remote body verification and live business references",async t=>{
  const f=await fixture(t);assert.equal(f.manifest.items.length,1);assert.equal(f.manifest.items[0].remote_verified,true);
  assert.equal(f.manifest.sha256,mediaCacheManifestHash(f.manifest));assert.deepEqual(f.manifest.references,f.refs);
});
test("cache deletion requires offline maintenance and a complete fresh reference scan",async t=>{
  const f=await fixture(t);await assert.rejects(applyMediaCacheManifest({...f.options,manifest:f.manifest,mode:"clean"}),/offline/);
  await assert.rejects(applyMediaCacheManifest({...f.options,manifest:f.manifest,mode:"clean",maintenance:async()=>{},scanReferences:async()=>({...f.refs,complete:false})}),/references changed/i);
  assert.deepEqual(await fs.readFile(f.file),content);
});
test("reference changes and rewritten local content are retained",async t=>{
  const f=await fixture(t);
  await assert.rejects(applyMediaCacheManifest({...f.options,manifest:f.manifest,mode:"clean",maintenance:async()=>{},scanReferences:async()=>({...f.refs,references:{new:["listing_drafts:2"]}})}),/references changed/i);
  await fs.writeFile(f.file,"changed");const report=await applyMediaCacheManifest({...f.options,manifest:f.manifest,mode:"clean",maintenance:async()=>{}});
  assert.equal(report.deleted,0);assert.equal(report.retained[0].reason,"file_changed");
});
test("verified cache eviction keeps the OSS mapping and all business references",async t=>{
  const f=await fixture(t);let maintenanceChecks=0;
  const report=await applyMediaCacheManifest({...f.options,manifest:f.manifest,mode:"clean",maintenance:async()=>{maintenanceChecks++;}});
  assert.equal(report.deleted,1);assert.equal(report.reclaimed_bytes,content.length);assert.ok(maintenanceChecks>=2);
  await assert.rejects(fs.stat(f.file),{code:"ENOENT"});assert.equal(f.row.source_module,"durable_media_cache");assert.equal(Object.keys(f.refs.references).length,1);
});
test("unrecoverable legacy mappings and corrupt review files cannot delete local media",async t=>{
  const f=await fixture(t);f.row.source_module="listing_drafts";
  const report=await applyMediaCacheManifest({...f.options,manifest:f.manifest,mode:"clean",maintenance:async()=>{}});assert.equal(report.deleted,0);
  f.manifest.bucket="different";await assert.rejects(applyMediaCacheManifest({...f.options,manifest:f.manifest,mode:"clean"}),/Invalid reviewed/);
});
test("archive mode never deletes files and refuses to proceed on an incomplete review",async t=>{
  const f=await fixture(t);let archived=0;
  const report=await applyMediaCacheManifest({...f.options,manifest:f.manifest,mode:"archive",archive:async()=>archived++});assert.equal(archived,1);assert.equal(report.deleted,0);assert.deepEqual(await fs.readFile(f.file),content);
  f.manifest.references.complete=false;f.manifest.sha256=mediaCacheManifestHash(f.manifest);
  await assert.rejects(applyMediaCacheManifest({...f.options,manifest:f.manifest,mode:"archive",archive:async()=>archived++}),/incomplete/);
});
