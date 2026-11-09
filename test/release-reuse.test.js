import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dependencyIdentity, inspectDependencyCache, INSTALL_PROFILE } from "../scripts/lib/release-dependencies.mjs";
import { packageExternalFiles, materializeExternalFiles, validateExternalFiles } from "../scripts/lib/release-external-files.mjs";

const unix = { skip: process.platform === "win32" };
const runtime = { node:"22.23.2", abi:"127", platform:"linux", arch:"x64", libc:"2.39", npm:"10.9.8" };
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-reuse-"));
  try { await run(root); } finally { await fs.rm(root,{recursive:true,force:true}); }
}
async function source(root, bytes = "first tool") {
  await fs.mkdir(path.join(root,"tools"),{recursive:true});
  await fs.writeFile(path.join(root,"tools/mutool.exe"), bytes);
  await fs.writeFile(path.join(root,"package.json"), JSON.stringify({dependencies:{mysql2:"3.23.1"}}));
  await fs.writeFile(path.join(root,"package-lock.json"), '{"lockfileVersion":3}');
}
async function release(root, files) {
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,"deploy-manifest.json"),JSON.stringify({externalFiles:files}));
}

test("unchanged dependencies retain identity across app edits, but lock/runtime changes invalidate it", () => fixture(async root => {
  await source(root);
  const first = await dependencyIdentity(root,runtime);
  await fs.writeFile(path.join(root,"application.js"),"changed app only");
  assert.equal(await dependencyIdentity(root,runtime),first);
  for (const field of ["node","abi","platform","arch","libc","npm"]) assert.notEqual(await dependencyIdentity(root,{...runtime,[field]:"changed"}),first,field);
  await fs.writeFile(path.join(root,"package-lock.json"),'{"lockfileVersion":3,"new":true}');
  assert.notEqual(await dependencyIdentity(root,runtime),first);
  await fs.writeFile(path.join(root,"package.json"),'{"scripts":{"postinstall":"node application.js"}}');
  assert.equal(await dependencyIdentity(root,runtime),null,"root lifecycle must not be skipped by reuse");
}));

test("cache reuse refuses incomplete, mutable or mismatched entries without replacing them", unix, () => fixture(async root => {
  const key="a".repeat(64), entry=path.join(root,key), modules=path.join(entry,"node_modules"), receipt=path.join(entry,"receipt.json");
  const options={uid:process.getuid()};
  assert.equal(await inspectDependencyCache(root,key,options),null);
  await fs.mkdir(modules,{recursive:true});
  await assert.rejects(inspectDependencyCache(root,key,options),/Incomplete/);
  await fs.writeFile(receipt,JSON.stringify({key,profile:INSTALL_PROFILE}));
  await assert.rejects(inspectDependencyCache(root,key,options),/immutable/);
  await fs.chmod(entry,0o555);await fs.chmod(modules,0o555);
  await fs.chmod(receipt,0o444);
  try {
    assert.equal(await inspectDependencyCache(root,key,options),entry);
    await fs.chmod(receipt,0o644);await fs.writeFile(receipt,JSON.stringify({key:"b".repeat(64),profile:INSTALL_PROFILE}));await fs.chmod(receipt,0o444);
    await assert.rejects(inspectDependencyCache(root,key,options),/receipt mismatch/);
  } finally { await fs.chmod(entry,0o755);await fs.chmod(modules,0o755); }
}));

test("unchanged tool hashes need no second upload and old releases retain their exact bytes", unix, () => fixture(async root => {
  const sources=path.join(root,"source"), uploads=path.join(root,"uploads"), cache=path.join(root,"cache");
  const oldRelease=path.join(root,"old"), nextRelease=path.join(root,"next"), changedRelease=path.join(root,"changed");
  await fs.mkdir(sources);await source(sources);
  const files=await packageExternalFiles(sources,uploads);
  await release(oldRelease,files);
  await materializeExternalFiles(oldRelease,uploads,cache,{uid:process.getuid()});
  assert.equal(await fs.readFile(path.join(oldRelease,"tools/mutool.exe"),"utf8"),"first tool");
  assert.equal((await fs.stat(path.join(cache,files[0].sha256))).mode & 0o222,0);
  await fs.rm(uploads,{recursive:true}); // The next release has no uploaded tool.
  await release(nextRelease,files);
  await materializeExternalFiles(nextRelease,uploads,cache,{uid:process.getuid()});
  assert.equal(await fs.readlink(path.join(nextRelease,"tools/mutool.exe")),await fs.readlink(path.join(oldRelease,"tools/mutool.exe")));
  await source(sources,"second version");
  const changed=await packageExternalFiles(sources,uploads);
  assert.notEqual(changed[0].sha256,files[0].sha256);
  await release(changedRelease,changed);
  await materializeExternalFiles(changedRelease,uploads,cache,{uid:process.getuid()});
  assert.equal(await fs.readFile(path.join(changedRelease,"tools/mutool.exe"),"utf8"),"second version");
  assert.equal(await fs.readFile(path.join(oldRelease,"tools/mutool.exe"),"utf8"),"first tool");
}));

test("tool materialization refuses tampering, traversal, duplicates and an oversized gzip", unix, () => fixture(async root => {
  await source(root);
  const uploads=path.join(root,"uploads"), cache=path.join(root,"cache"), out=path.join(root,"release");
  const files=await packageExternalFiles(root,uploads);
  await release(out,files);
  await fs.appendFile(path.join(uploads,`${files[0].sha256}.gz`),"corrupt upload");
  await assert.rejects(materializeExternalFiles(out,uploads,cache,{uid:process.getuid()}),/checksum mismatch/);
  assert.equal((await fs.readdir(cache)).length,0);
  assert.throws(()=>validateExternalFiles([{...files[0],path:"../escape"}]),/Invalid/);
  assert.throws(()=>validateExternalFiles([files[0],files[0]]),/Invalid/);
  const valid=await packageExternalFiles(root,uploads);
  await release(out,[{...valid[0],size:1}]);
  await assert.rejects(materializeExternalFiles(out,uploads,cache,{uid:process.getuid()}),/exceeds declared size/);
  assert.equal((await fs.readdir(cache)).length,0);
}));

test("tool cache corruption never overwrites a blob used by another release", unix, () => fixture(async root => {
  await source(root);
  const uploads=path.join(root,"uploads"), cache=path.join(root,"cache"), out=path.join(root,"release");
  const files=await packageExternalFiles(root,uploads);await fs.mkdir(cache);
  const existing=path.join(cache,files[0].sha256);await fs.writeFile(existing,"damaged");await fs.chmod(existing,0o444);
  await release(out,files);
  await assert.rejects(materializeExternalFiles(out,uploads,cache,{uid:process.getuid()}),/failed verification/);
  assert.equal(await fs.readFile(existing,"utf8"),"damaged");
}));
