import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {cleanupTemporaryImageCache} from "../src/services/temporary-image-cache.js";

test("temporary source cache expires bounded old downloads but retains originals, active and fresh files",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"source-cache-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const stale="a".repeat(64)+".png",protectedFile="b".repeat(64)+".jpg",fresh="c".repeat(64)+".webp";
  for(const name of [stale,protectedFile,fresh,"user-upload.png"]){await fs.writeFile(path.join(root,name),"image");if(name!==fresh)await fs.utimes(path.join(root,name),new Date(0),new Date(0));}
  await fs.symlink(path.join(root,"user-upload.png"),path.join(root,"d".repeat(64)+".png"));
  const report=await cleanupTemporaryImageCache({root,protectedHashes:new Set(["b".repeat(64)]),limit:1});
  assert.equal(report.deleted,1);await assert.rejects(fs.stat(path.join(root,stale)),{code:"ENOENT"});
  for(const name of [protectedFile,fresh,"user-upload.png"])assert.equal((await fs.stat(path.join(root,name))).isFile(),true);
});
test("temporary cache policy cannot target arbitrary paths or aggressive retention",async()=>{
  await assert.rejects(cleanupTemporaryImageCache({root:"relative"}),/Invalid/);
  await assert.rejects(cleanupTemporaryImageCache({root:"/tmp",retentionHours:1}),/Invalid/);
});
