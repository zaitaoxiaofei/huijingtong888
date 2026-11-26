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
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),"media-cache-"));t.after(()=>{
    assert.equal(path.dirname(path.resolve(cwd)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(cwd).startsWith("media-cache-"));
    return fs.rm(cwd,{recursive:true,force:true});
  });
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

function verifiedClient(body=content) {
  let downloads=0,aclChecks=0;
  return {
    get downloads(){return downloads;},get aclChecks(){return aclChecks;},
    async head(){return {res:{headers:{"content-length":String(body.length)}}};},
    async getACL(){aclChecks++;return {acl:"private"};},
    async getStream(){downloads++;return {stream:Readable.from([body])};}
  };
}

test("verified upload reuse performs one full readback and retains private ACL checks",async t=>{
  const {cwd,file}=await fixture(t),oss=verifiedClient(),options={cwd,env:{...env,STORAGE_VERIFIED_WRITES_ENABLED:"1"},client:oss,register:async()=>{},mark:async()=>{}};
  await archiveMediaCacheFile(file,options);assert.equal(oss.downloads,1);assert.equal(oss.aclChecks,1);
  await archiveMediaCacheFile(file,options);assert.equal(oss.downloads,2);assert.equal(oss.aclChecks,2);
});

test("archive still verifies the full body when lower-level verified writes are disabled",async t=>{
  const {cwd,file}=await fixture(t),oss=verifiedClient();
  await archiveMediaCacheFile(file,{cwd,env,client:oss,register:async()=>{},mark:async()=>{}});
  assert.equal(oss.downloads,1);assert.equal(oss.aclChecks,1);
});

test("readback acknowledgements cannot be reused or copied through stored metadata",async t=>{
  const {cwd,file}=await fixture(t),oss=verifiedClient(),options={cwd,env:{...env,STORAGE_VERIFIED_WRITES_ENABLED:"1"},client:oss,register:async()=>{},mark:async()=>{}};
  const stored=await putContentAddressedFile(file,{env:options.env,client:oss,prefix:"ai-task-media",extension:".png",privateObject:true});
  assert.equal(oss.downloads,1);
  await archiveMediaCacheFile(file,{...options,storedObject:{...stored}});assert.equal(oss.downloads,2);
  await archiveMediaCacheFile(file,{...options,storedObject:stored});assert.equal(oss.downloads,2);
  await archiveMediaCacheFile(file,{...options,storedObject:stored});assert.equal(oss.downloads,3);
});

test("a forged verification flag cannot make corrupt stored media trusted",async t=>{
  const {cwd,file}=await fixture(t);let marks=0;
  await assert.rejects(archiveMediaCacheFile(file,{cwd,env,client:client(Buffer.alloc(content.length)),storedObject:{...object,verified:true,bodyVerified:true},register:async()=>{},mark:async()=>marks++}),/checksum/);
  assert.equal(marks,0);
});

test("lower-level readback corruption prevents archive registration",async t=>{
  const {cwd,file}=await fixture(t),oss=verifiedClient(Buffer.alloc(content.length));let marks=0;
  await assert.rejects(archiveMediaCacheFile(file,{cwd,env:{...env,STORAGE_VERIFIED_WRITES_ENABLED:"1"},client:oss,register:async()=>{},mark:async()=>marks++}),/checksum|SHA256|differs/);
  assert.equal(oss.downloads,1);assert.equal(marks,0);assert.deepEqual(await fs.readFile(file),content);
});

test("a genuine readback proof cannot authorize a cache mapping outside media namespaces",async t=>{
  const {cwd,file}=await fixture(t),oss=verifiedClient();
  const stored=await putContentAddressedFile(file,{env:{...env,STORAGE_VERIFIED_WRITES_ENABLED:"1"},client:oss,prefix:"unrelated",extension:".png"});
  await assert.rejects(archiveMediaCacheFile(file,{cwd,env,client:oss,storedObject:stored,register:async()=>{},mark:async()=>{throw Error("Must not register");}}),/fingerprint/);
  assert.equal(oss.downloads,1);
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

test("existing local media does not query OSS or its recovery mapping",async t=>{
  const {cwd,file}=await fixture(t),unexpected=async()=>{throw Error("Existing local file must not download");};
  assert.equal(await restoreMediaCacheFile(file,{cwd,env,query:unexpected,client:{getStream:unexpected}}),true);
});

test("normalized paths share failures, clean partial files, and allow a successful retry",async t=>{
  const {cwd,file}=await fixture(t);await fs.unlink(file);let downloads=0,fail=true;
  const options={cwd,env,query:async()=>[{content_hash_sha256:hash,byte_size:content.length,oss_object_key:object.objectKey,oss_bucket:"test"}],client:{async getStream(){downloads++;return {stream:Readable.from((async function*(){yield content.subarray(0,4);if(fail)throw Error("Interrupted OSS stream");yield content.subarray(4);})())};}}};
  const alternate=path.dirname(file)+path.sep+"."+path.sep+path.basename(file);
  const results=await Promise.allSettled([file,alternate,file,alternate].map(p=>restoreMediaCacheFile(p,options)));
  assert.ok(results.every(result=>result.status==="rejected"&&/Interrupted OSS stream/.test(result.reason.message)));
  assert.equal(downloads,1);assert.deepEqual(await fs.readdir(path.dirname(file)),[]);
  fail=false;assert.equal(await restoreMediaCacheFile(alternate,options),true);assert.equal(downloads,2);
  assert.deepEqual(await fs.readFile(file),content);
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
  const link=path.join(cwd,"uploads","ai-generated","escape");await fs.symlink(outside,link,process.platform==="win32"?"junction":"dir");
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
