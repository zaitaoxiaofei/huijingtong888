import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_NAME ||= "media_cache_test";
process.env.DB_USER ||= "test";
const { archiveMediaCacheFile, restoreMediaCacheFile, restoreMediaCacheDirectory, verifyMediaObject, mediaCacheSource } = await import("../src/services/media-cache-files.js");
const {putContentAddressedFile}=await import("../src/services/object-storage.js");

const env = { OSS_ENABLED:"true", OSS_REGION:"oss-cn-test", OSS_BUCKET:"test", OSS_ACCESS_KEY_ID:"id", OSS_ACCESS_KEY_SECRET:"secret" };
const content = Buffer.from("durable original media"), hash = crypto.createHash("sha256").update(content).digest("hex");
const object = { hashSha256:hash, size:content.length, objectKey:`ai-task-media/${hash.slice(0,2)}/${hash}.png`, bucket:"test", url:"https://test.invalid/media.png" };
const client = body => ({ async getStream() { return { stream:Readable.from([body]) }; } });
async function fixture(t, area="ai-generated") {
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),"media-cache-"));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const file=path.join(cwd,"uploads",area,"test-task","image.png");await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);return {cwd,file};
}
test("archive verifies remote content and registers stable source aliases",async t=>{
  const {cwd,file}=await fixture(t),registered=[],verified=[];
  await archiveMediaCacheFile(file,{cwd,env,client:client(content),put:async()=>object,sourceUrl:"/api/ai/file/test-task/generated/image.png",register:async r=>registered.push(r),mark:async r=>verified.push(r)});
  assert.equal(registered.length,2);assert.equal(verified.length,2);assert.equal(verified[0].contentHashSha256,hash);
  assert.equal((await fs.readFile(file)).toString(),content.toString());
});
test("same-sized corrupted OSS body never becomes a verified archive",async t=>{
  const {cwd,file}=await fixture(t);let marks=0;
  await assert.rejects(archiveMediaCacheFile(file,{cwd,env,client:client(Buffer.alloc(content.length)),put:async()=>object,register:async()=>{},mark:async()=>marks++}),/checksum/);
  assert.equal(marks,0);assert.deepEqual(await fs.readFile(file),content);
});
test("an existing OSS fingerprint must describe the actual local file",async t=>{
  const {cwd,file}=await fixture(t);
  await assert.rejects(archiveMediaCacheFile(file,{cwd,env,client:client(content),storedObject:{...object,hashSha256:"a".repeat(64)}}),/Local media differs/);
});
test("cache removal is recoverable from the verified OSS mapping",async t=>{
  const {cwd,file}=await fixture(t);await fs.unlink(file);
  const query=async()=>[{content_hash_sha256:hash,byte_size:content.length,oss_object_key:object.objectKey,oss_bucket:"test"}];
  assert.equal(await restoreMediaCacheFile(file,{cwd,env,client:client(content),query}),true);assert.deepEqual(await fs.readFile(file),content);
});
test("a corrupt recovery leaves no truncated cache file or partial file",async t=>{
  const {cwd,file}=await fixture(t);await fs.unlink(file);
  await assert.rejects(restoreMediaCacheFile(file,{cwd,env,client:client(Buffer.alloc(content.length)),query:async()=>[{content_hash_sha256:hash,byte_size:content.length,oss_object_key:object.objectKey,oss_bucket:"test"}]}),/checksum/);
  await assert.rejects(fs.stat(file),{code:"ENOENT"});assert.deepEqual(await fs.readdir(path.dirname(file)),[]);
});
test("absent mapping and a different bucket cannot silently download another object",async t=>{
  const {cwd,file}=await fixture(t);await fs.unlink(file);
  assert.equal(await restoreMediaCacheFile(file,{cwd,env,query:async()=>[]}),false);
  await assert.rejects(restoreMediaCacheFile(file,{cwd,env,query:async()=>[{oss_bucket:"another"}]}),/bucket differs/);
});
test("concurrent cache reads share one verified download",async t=>{
  const {cwd,file}=await fixture(t);await fs.unlink(file);let downloads=0;
  const options={cwd,env,query:async()=>[{content_hash_sha256:hash,byte_size:content.length,oss_object_key:object.objectKey,oss_bucket:"test"}],client:{async getStream(){downloads++;return {stream:Readable.from([content])};}}};
  await Promise.all(Array.from({length:8},()=>restoreMediaCacheFile(file,options)));assert.equal(downloads,1);
});
test("ZIP directory recovery enumerates evicted owned files and rejects oversized recovery",async t=>{
  const {cwd,file}=await fixture(t);await fs.unlink(file);
  const query=async sql=>sql.includes("source_url LIKE")?[{source_url:mediaCacheSource(file,cwd)}]:[{content_hash_sha256:hash,byte_size:content.length,oss_object_key:object.objectKey,oss_bucket:"test"}];
  assert.equal(await restoreMediaCacheDirectory(path.dirname(file),{cwd,env,query,client:client(content)}),1);
  assert.deepEqual(await fs.readFile(file),content);
  await assert.rejects(restoreMediaCacheDirectory(path.dirname(file),{cwd,env,query:async()=>Array.from({length:1001},()=>({}))}),/bound/);
});
test("cache filesystem paths cannot escape through traversal or child symlinks",async t=>{
  const {cwd}=await fixture(t),outside=path.join(cwd,"private");await fs.mkdir(outside);await fs.writeFile(path.join(outside,"image.png"),content);
  const link=path.join(cwd,"uploads","ai-generated","escape");await fs.symlink(outside,link);
  assert.throws(()=>mediaCacheSource(path.join(cwd,"private","image.png"),cwd),/outside/);
  await assert.rejects(restoreMediaCacheFile(path.join(link,"image.png"),{cwd,env}),/escapes/);
});
test("OSS disabled is a persistence failure rather than permanent local fallback",async t=>{
  const {cwd,file}=await fixture(t);await assert.rejects(archiveMediaCacheFile(file,{cwd,env:{}}),/OSS 未启用/);
});
test("owned working media uploads use private OSS ACL and refuse an existing public object",async t=>{
  const {file}=await fixture(t);let headers;
  const storageClient={head:async()=>{throw Object.assign(new Error("missing"),{status:404});},putStream:async(key,stream,options)=>{for await(const chunk of stream){} headers=options.headers;},getACL:async()=>({acl:"private"})};
  await putContentAddressedFile(file,{env,client:storageClient,prefix:"ai-task-media",extension:".png",privateObject:true});
  assert.equal(headers["x-oss-object-acl"],"private");assert.equal(headers["Cache-Control"],"private, no-store");
  let uploads=0;
  await assert.rejects(putContentAddressedFile(file,{env,prefix:"ai-task-media",extension:".png",privateObject:true,client:{head:async()=>({}),putStream:async()=>uploads++,getACL:async()=>({acl:"public-read"})}}),/ACL/);
  assert.equal(uploads,0);
});
test("remote verification rejects oversized bodies and unexpected key namespaces",async()=>{
  await assert.rejects(verifyMediaObject(client(Buffer.alloc(content.length+1)),object),/size mismatch/);
  await assert.rejects(verifyMediaObject(client(content),{...object,objectKey:"private-finance/file.png"}),/fingerprint/);
});
