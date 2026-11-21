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
const { mediaCacheSource, cacheSourceFingerprint, restoreMediaCacheFile, restoreMediaCacheDirectory, listMediaCacheDirectorySources } = await import("../src/services/media-cache-files.js");
const source=await fs.readFile(new URL("../src/server/services/tools/imageCropperService.js",import.meta.url),"utf8");
const nodes=parse(source,{ecmaVersion:"latest",sourceType:"module"}).body.map(node=>node.declaration||node);
const names=["chooseInputDir","latestImageDirectory","listLocalImageFiles","normalizeCropFilenames","normalizeRelativeImagePath","sanitizePathPart","resolveScopedOutputDir","resolveTaskDir","listImageFiles","createTaskZip","createEnhancedTaskZip","createRatioTaskZip","createWatermarkedTaskZip","createScopedTaskZip","enhanceTaskCrops","convertTaskCropsToRatio","watermarkTaskCrops","createBatchName","scopedFilename","imageUrl","downloadRoute","scopedZipRoute"];
const functions=names.map(name=>{const node=nodes.find(item=>item.type==="FunctionDeclaration"&&item.id.name===name);assert.ok(node,name);return source.slice(node.start,node.end);}).join("\n");
const session={tenant:{id:2}},taskId="task-owned";

async function fixture(t,{lifecycleEnabled=true}={}){
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),"cropper-recovery-"));
  t.after(()=>{assert.equal(path.dirname(path.resolve(cwd)),path.resolve(os.tmpdir()));assert.ok(path.basename(cwd).startsWith("cropper-recovery-"));return fs.rm(cwd,{recursive:true,force:true});});
  const tempRoot=path.join(cwd,"uploads","temp","image-cropper"),taskDir=path.join(tempRoot,taskId);
  const env={OSS_ENABLED:"true",OSS_REGION:"oss-cn-test",OSS_BUCKET:"test",OSS_ACCESS_KEY_ID:"id",OSS_ACCESS_KEY_SECRET:"secret"};
  const mappings=new Map(),objects=new Map(),downloads=[],queries=[],processed=[],packages=[],corrupt=new Set();let overrideRows;
  const query=async(sql,params)=>{
    queries.push({sql,params});
    if(sql.includes("source_url LIKE")){
      if(overrideRows)return overrideRows;
      const prefix=params[0].slice(0,-1).replace(/!([!_%])/g,"$1");
      return [...mappings.values()].filter(row=>row.source_url.startsWith(prefix)).slice(0,1001);
    }
    const row=mappings.get(params[0]);return row?[row]:[];
  };
  const client={async getStream(key){const item=objects.get(key);assert.ok(item,`Unexpected OSS key ${key}`);downloads.push(item.relative);return {stream:Readable.from([corrupt.has(item.relative)?Buffer.alloc(item.body.length):item.body])};}};
  const options={cwd,env,query,client};
  const restore=file=>lifecycleEnabled?restoreMediaCacheFile(file,options):Promise.resolve(false);
  const processor=async(dir,_output,_task,filenames)=>{
    const actual=Array.from(filenames.length?filenames:await fs.readdir(dir)).filter(name=>/\.(png|jpe?g|webp)$/.test(name));
    for(const name of actual)await fs.readFile(path.join(dir,name));
    processed.push({dir,filenames:[...filenames],actual});
    return {images:actual.map(filename=>({filename,width:1,height:1}))};
  };
  const context=vm.createContext({
    fs,path,crypto,process:{env:{MEDIA_CACHE_LIFECYCLE_ENABLED:lifecycleEnabled?"1":"0"}},TEMP_ROOT:tempRoot,ALLOWED_EXTENSIONS:new Set([".png",".jpg",".jpeg",".webp"]),
    withMediaCacheLease:async work=>work(),
    assertImageCropperTaskOwner:async(id,viewer)=>{if(id!==taskId||viewer?.tenant?.id!==2)throw Object.assign(Error("foreign task"),{status:403});},
    listMediaCacheDirectorySources:root=>listMediaCacheDirectorySources(root,options),
    restoreMediaCacheDirectory:(root,extra)=>restoreMediaCacheDirectory(root,{...options,...extra}),
    statCacheAwareFile:async file=>{await restore(file);return fs.stat(file);},
    readCacheAwareFile:async file=>{await restore(file);return fs.readFile(file);},
    readCacheAwareDirectory:async(dir,...args)=>{if(lifecycleEnabled)await restoreMediaCacheDirectory(dir,options);return fs.readdir(dir,...args);},
    buildZip:files=>{packages.push(files);return Buffer.from(JSON.stringify(files.map(file=>({name:file.name,body:file.data.toString()}))));},
    runPythonEnhancer:processor,runPythonRatioCanvas:processor,
    runPythonWatermarker:(dir,output,_watermark,id,filenames)=>processor(dir,output,id,filenames),
    archiveMediaCacheFile:async()=>{},getShopForWatermark:async()=>({id:20}),getWatermarkFileForShop:async()=>({filePath:"fixture-logo"}),
    normalizeWatermarkOptions:value=>value,shopWatermarkDefaults:()=>({})
  });
  vm.runInContext(functions,context,{filename:"src/server/services/tools/imageCropperService.js"});
  return {cwd,taskDir,context,downloads,queries,processed,packages,corrupt,
    setRows(rows){overrideRows=rows;},
    async add(relative,{local=false,time=1000}={}){
      const file=path.join(taskDir,relative),body=Buffer.from(relative),hash=crypto.createHash("sha256").update(body).digest("hex");
      const source_url=mediaCacheSource(file,cwd),oss_object_key=`ai-task-media/${hash.slice(0,2)}/${hash}.png`;
      mappings.set(cacheSourceFingerprint(source_url),{source_url,created_ms:time,content_hash_sha256:hash,byte_size:body.length,oss_object_key,oss_bucket:"test"});
      objects.set(oss_object_key,{relative,body});
      if(local){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,body);}
      return file;
    }
  };
}

test("selected enhance, ratio and watermark inputs restore only requested images",async t=>{
  for(const method of ["enhanceTaskCrops","convertTaskCropsToRatio","watermarkTaskCrops"])await t.test(method,async sub=>{
    const f=await fixture(sub);await f.add("crops/selected/a.png");await f.add("crops/other/b.png");await f.add("watermarked/old/c.png");
    const result=await f.context[method]({taskId,shopId:20,filenames:["selected/a.png"]},session);
    assert.deepEqual(f.downloads,["crops/selected/a.png"]);assert.equal(f.processed.length,1);assert.deepEqual(f.processed[0].actual,["a.png"]);
    assert.equal(result.taskId,taskId);assert.equal(result.images.length,1);assert.match(result.zipUrl,/\/task-owned\//);
    assert.ok(!f.queries.some(call=>call.sql.includes("source_url LIKE")),"Explicit inputs must not recover whole directories");
  });
});

test("every selected ZIP restores only its requested scope and batch",async t=>{
  for(const [method,scope] of [["createTaskZip","crops"],["createEnhancedTaskZip","enhanced"],["createRatioTaskZip","ratio-3x4"],["createWatermarkedTaskZip","watermarked"]])await t.test(method,async sub=>{
    const f=await fixture(sub);await f.add(`${scope}/selected/a.png`);await f.add(`${scope}/selected/b.png`);await f.add(`${scope}/other/c.png`);await f.add("unrelated/d.png");
    const result=await f.context[method](taskId,"selected",session);
    assert.deepEqual(f.downloads.sort(),[`${scope}/selected/a.png`,`${scope}/selected/b.png`]);assert.equal(f.packages[0].length,2);
    assert.match(result.filename,/task-owned\.zip$/);assert.ok(Buffer.isBuffer(result.buffer));
    assert.ok(f.queries.filter(call=>call.sql.includes("source_url LIKE")).every(call=>call.params[0].includes(`/${scope}/selected/`)));
  });
});

test("unselected processing keeps scope priority and all images in the latest batch",async t=>{
  const f=await fixture(t);await f.add("watermarked/old/old.png",{time:1000});await f.add("watermarked/new/a.png",{time:2000});await f.add("watermarked/new/b.png",{time:2000});await f.add("crops/newest/other.png",{time:3000});
  await f.context.enhanceTaskCrops({taskId},session);
  assert.deepEqual(f.downloads.sort(),["watermarked/new/a.png","watermarked/new/b.png"]);
  assert.deepEqual(f.processed[0].filenames,[]);assert.deepEqual(f.processed[0].actual.sort(),["a.png","b.png"]);
});

test("directories containing local images retain modification-time priority",async t=>{
  const f=await fixture(t);await f.add("crops/older/a.png",{time:9000,local:true});await f.add("crops/newer/b.png",{time:1000,local:true});
  for(const [batch,time] of [["older",1000],["newer",2000]]){const dir=path.join(f.taskDir,"crops",batch);await fs.mkdir(dir,{recursive:true});await fs.utimes(dir,time,time);}
  await f.context.convertTaskCropsToRatio({taskId},session);
  assert.equal(path.basename(f.processed[0].dir),"newer");assert.deepEqual(f.processed[0].actual,["b.png"]);assert.deepEqual(f.downloads,[]);
});

test("eviction-updated empty directories cannot outrank a newer mapped batch",async t=>{
  const f=await fixture(t);await f.add("crops/old/a.png",{time:1000});await f.add("crops/new/b.png",{time:2000});
  const old=path.join(f.taskDir,"crops","old");await fs.mkdir(old,{recursive:true});await fs.utimes(old,9000,9000);
  await f.context.convertTaskCropsToRatio({taskId},session);
  assert.equal(path.basename(f.processed[0].dir),"new");assert.deepEqual(f.downloads,["crops/new/b.png"]);
});

test("unscoped ZIP keeps all batches in its scope and legacy flat enhanced ZIP remains flat",async t=>{
  const f=await fixture(t);await f.add("crops/first/a.png");await f.add("crops/second/b.png");await f.add("enhanced/flat.png");await f.add("enhanced/batch/unused.png");
  await f.context.createTaskZip(taskId,"",session);
  assert.deepEqual(f.downloads.sort(),["crops/first/a.png","crops/second/b.png"]);assert.equal(f.packages[0].length,2);
  f.downloads.length=0;
  await f.context.createEnhancedTaskZip(taskId,"",session);
  assert.deepEqual(f.downloads,["enhanced/flat.png"]);assert.deepEqual(Array.from(f.packages[1],file=>file.name),["flat.png"]);
});

test("recovery failure aborts processing or ZIP instead of silently omitting an image",async t=>{
  const f=await fixture(t);await f.add("crops/selected/a.png");await f.add("crops/selected/b.png");f.corrupt.add("crops/selected/b.png");
  await assert.rejects(f.context.createTaskZip(taskId,"selected",session),/checksum/);assert.equal(f.packages.length,0);
  await assert.rejects(f.context.enhanceTaskCrops({taskId,filenames:["selected/a.png","selected/b.png"]},session),/checksum/);assert.equal(f.processed.length,0);
  f.corrupt.clear();await f.context.createTaskZip(taskId,"selected",session);assert.equal(f.packages[0].length,2);
});

test("missing explicit selections never fall back to processing all available images",async t=>{
  const f=await fixture(t);await f.add("crops/selected/a.png");await f.add("crops/unrelated/other.png");
  await assert.rejects(f.context.enhanceTaskCrops({taskId,filenames:["selected/missing.png"]},session),error=>error.status===404);
  assert.deepEqual(f.downloads,[]);assert.equal(f.processed.length,0);
  await assert.rejects(f.context.enhanceTaskCrops({taskId,filenames:["selected/a.png","selected/missing.png"]},session),error=>error.status===404);
  assert.deepEqual(f.downloads,["crops/selected/a.png"]);assert.equal(f.processed.length,0);
});

test("cross-batch selections reject explicitly even when one requested batch is absent",async t=>{
  for(const missingSecond of [false,true])await t.test(`second batch absent ${missingSecond}`,async sub=>{
    const f=await fixture(sub);await f.add("crops/first/a.png");if(!missingSecond)await f.add("crops/second/b.png");
    await assert.rejects(f.context.enhanceTaskCrops({taskId,filenames:["first/a.png","second/b.png"]},session),error=>error.status===400);
    assert.equal(f.downloads.length,0);assert.equal(f.queries.length,0);assert.equal(f.processed.length,0);
  });
});

test("disabled cache lifecycle uses only existing local files without mapping or OSS dependencies",async t=>{
  const f=await fixture(t,{lifecycleEnabled:false});await f.add("crops/local/a.png",{local:true});await f.add("enhanced/flat.png",{local:true});
  await f.context.enhanceTaskCrops({taskId},session);
  assert.deepEqual(f.processed[0].actual,["flat.png"]);
  await f.context.createEnhancedTaskZip(taskId,"",session);assert.equal(f.packages[0].length,1);
  await f.context.createTaskZip(taskId,"local",session);assert.equal(f.packages[1].length,1);
  assert.equal(f.queries.length,0);assert.equal(f.downloads.length,0);
});

test("foreign tasks and invalid paths fail before cache metadata or object access",async t=>{
  const f=await fixture(t);
  for(const method of ["createTaskZip","createEnhancedTaskZip","createRatioTaskZip","createWatermarkedTaskZip"])await assert.rejects(f.context[method](taskId,"",{tenant:{id:3}}),/foreign/);
  for(const method of ["enhanceTaskCrops","convertTaskCropsToRatio","watermarkTaskCrops"])await assert.rejects(f.context[method]({taskId,shopId:20},{tenant:{id:3}}),/foreign/);
  await assert.rejects(f.context.createTaskZip(taskId,"../escape",session),error=>error.status===400);
  await assert.rejects(f.context.enhanceTaskCrops({taskId,filenames:["../outside.png"]},session),error=>error.status===400);
  assert.equal(f.queries.length,0);assert.equal(f.downloads.length,0);assert.equal(f.processed.length,0);
});

test("metadata discovery retains the 1000-file bound and validates every mapping prefix",async t=>{
  const f=await fixture(t);f.setRows(Array.from({length:1001},()=>({source_url:"unused"})));
  await assert.rejects(f.context.enhanceTaskCrops({taskId},session),/bound/);
  f.setRows([{source_url:"/uploads/temp/image-cropper/foreign/watermarked/a.png"}]);
  await assert.rejects(f.context.enhanceTaskCrops({taskId},session),/differs/);
  assert.equal(f.downloads.length,0);
});
