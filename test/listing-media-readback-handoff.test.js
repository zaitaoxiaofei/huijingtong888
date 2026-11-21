import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { Readable } from "node:stream";
import { parse } from "acorn";

process.env.DB_HOST ||= "127.0.0.1";
process.env.DB_NAME ||= "media_cache_test";
process.env.DB_USER ||= "test";
const { putContentAddressedObject, ossStorageConfig } = await import("../src/services/object-storage.js");
const { archiveMediaCacheFile, MEDIA_CACHE_ROOTS } = await import("../src/services/media-cache-files.js");
const source = await fs.readFile(new URL("../src/services/listing-automation.js", import.meta.url), "utf8");
const declarations = parse(source, { ecmaVersion: "latest", sourceType: "module" }).body.map(node => node.declaration || node);
const actualFunctions = ["writeListingMediaFile", "registerListingMediaAssetFromFile"].map(name => {
  const declaration=declarations.find(node=>node.type==="FunctionDeclaration"&&node.id.name===name);
  assert.ok(declaration, `Missing actual function ${name}`);
  return source.slice(declaration.start, declaration.end);
}).join("\n");

async function fixture(t, { verifiedWrites=true, corrupt=false } = {}) {
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),"listing-media-handoff-"));
  t.after(()=>{
    assert.equal(path.dirname(path.resolve(cwd)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(cwd).startsWith("listing-media-handoff-"));
    return fs.rm(cwd,{recursive:true,force:true});
  });
  const env={OSS_ENABLED:"true",OSS_REGION:"oss-cn-test",OSS_BUCKET:"test",OSS_ACCESS_KEY_ID:"id",OSS_ACCESS_KEY_SECRET:"secret",OSS_INTERNAL_READ:"true",STORAGE_VERIFIED_WRITES_ENABLED:verifiedWrites?"1":"0"};
  const content=Buffer.from("owned public listing image"),file=path.join(cwd,"uploads","shop-variants","task","image.png");
  await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);
  const objects=new Map(),registrations=[],mappings=[];let downloads=0,clients=0,archives=0,putResult;
  const client={
    async head(key){if(!objects.has(key))throw Object.assign(Error("missing"),{status:404});return {res:{headers:{"content-length":String(objects.get(key).length)}}};},
    async put(key,body,options){assert.equal(options.headers["x-oss-object-acl"],undefined,"Public listing ACL behavior must not change");objects.set(key,Buffer.from(body));},
    async getStream(key){downloads++;const body=objects.get(key);return {stream:Readable.from([corrupt?Buffer.alloc(body.length):body])};}
  };
  const context=vm.createContext({
    path:{...path,resolve:(...parts)=>path.resolve(cwd,...parts)},crypto,process:{cwd:()=>cwd},
    withMediaCacheLease:async work=>work(),ensureListingAutomationSchema:async()=>{},
    readCacheAwareFile:fs.readFile,LISTING_MEDIA_TYPES:new Map([[".png","image/png"]]),
    sanitizeListingMediaFilename:value=>String(value),MEDIA_CACHE_ROOTS,
    ossStorageConfig:()=>ossStorageConfig(env),
    createServerOssClient:()=>{clients++;return client;},
    putContentAddressedObject:async(body,options)=>{putResult=await putContentAddressedObject(body,{...options,env});return putResult;},
    archiveMediaCacheFile:async(filePath,options)=>{
      archives++;assert.equal(options.client,client);assert.equal(options.storedObject,putResult,"Handoff must retain the original in-process object identity");
      return archiveMediaCacheFile(filePath,{...options,cwd,env,register:async()=>{},mark:async row=>mappings.push(row)});
    },
    buildListingMediaPublishUrl:url=>url,
    ensureListingMediaPublicUrl:async()=>{throw Error("Existing OSS public URL must be reused");},
    registerListingMediaAsset:async(body,session)=>{registrations.push({body,session});return {id:1,...body};}
  });
  vm.runInContext(actualFunctions,context,{filename:"src/services/listing-automation.js"});
  return {context,file,content,client,registrations,mappings,get downloads(){return downloads;},get clients(){return clients;},get archives(){return archives;}};
}

test("public listing registration shares one original proof and one complete readback",async t=>{
  const f=await fixture(t),session={personId:7,tenant:{id:2}};
  const result=await f.context.registerListingMediaAssetFromFile({filePath:f.file,role:"main",original_name:"image.png"},session);
  assert.equal(f.clients,1);assert.equal(f.archives,1);assert.equal(f.downloads,1);assert.equal(f.mappings.length,1);
  assert.equal(f.registrations.length,1);assert.equal(f.registrations[0].session,session);
  assert.equal(result.local_path,"");assert.equal(result.source_path,"uploads/shop-variants/task/image.png");
  assert.equal(result.preview_url,result.publish_url);assert.match(result.publish_url,/^https:\/\/test\.oss-cn-test\.aliyuncs\.com\/listing-media\//);
  assert.equal(result.status,"public_ready");assert.equal(result.file_size,f.content.length);
  assert.equal("client" in result,false);assert.equal("storedObject" in result,false);assert.equal("verified" in result,false);
});

test("listing media writer keeps its original five-field return shape",async t=>{
  const f=await fixture(t);let stored;
  const result=await f.context.writeListingMediaFile("image.png",f.content,"image/png","listing-media",{client:f.client,onStored:object=>{stored=object;}});
  assert.deepEqual(Object.keys(result).sort(),["hashSha256","localPath","previewUrl","publishUrl","storageName"]);
  assert.equal(stored.objectKey,result.storageName);assert.equal(result.publishUrl,stored.url);assert.equal(f.downloads,1);
});

test("listing registration without lower-level readback still verifies the complete body once",async t=>{
  const f=await fixture(t,{verifiedWrites:false});
  await f.context.registerListingMediaAssetFromFile({filePath:f.file});
  assert.equal(f.downloads,1);assert.equal(f.mappings.length,1);assert.equal(f.registrations.length,1);
});

test("corrupted listing bodies never acquire a cache mapping or business registration",async t=>{
  for(const verifiedWrites of [true,false])await t.test(`verified writes ${verifiedWrites}`,async sub=>{
    const f=await fixture(sub,{verifiedWrites,corrupt:true});
    await assert.rejects(f.context.registerListingMediaAssetFromFile({filePath:f.file}),/checksum|differs/);
    assert.equal(f.downloads,1);assert.equal(f.mappings.length,0);assert.equal(f.registrations.length,0);
    assert.deepEqual(await fs.readFile(f.file),f.content);
  });
});
