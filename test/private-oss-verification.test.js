import test from "node:test";
import assert from "node:assert/strict";
import {verifyPrivateOssObject} from "../src/services/object-storage.js";

const denied={getACL:async()=>{throw Object.assign(new Error("no read acl permission"),{status:403});}};
const storage={bucket:"fixture-bucket",region:"oss-cn-hangzhou"},key="ai-task-media/ab/abc.png";
test("private ACL is accepted without an anonymous request; public ACL is always refused",async()=>{
  let requests=0;const request=async()=>requests++;
  assert.equal((await verifyPrivateOssObject({getACL:async()=>({acl:"private"})},key,{request})).method,"object_acl");
  await assert.rejects(verifyPrivateOssObject({getACL:async()=>({acl:"public-read"})},key,{request}),/ACL/);assert.equal(requests,0);
});
test("missing GetObjectAcl permission requires actual unsigned origin read denial",async()=>{
  let cancelled=false;
  const result=await verifyPrivateOssObject(denied,key,{storage,request:async(url,options)=>{
    assert.equal(url,"https://fixture-bucket.oss-cn-hangzhou.aliyuncs.com/ai-task-media/ab/abc.png");
    assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.Range,"bytes=0-0");assert.equal(options.redirect,"error");
    return {status:403,headers:new Headers({"x-oss-request-id":"fixture-id"}),body:{cancel:async()=>{cancelled=true;}}};
  }});
  assert.equal(result.method,"unsigned_origin_read_denied");assert.equal(cancelled,true);
});
test("public, missing, redirected and non-OSS denial responses cannot prove privacy",async()=>{
  for(const [status,requestId] of [[200,true],[206,true],[404,true],[301,true],[403,false]]){
    await assert.rejects(verifyPrivateOssObject(denied,key,{storage,request:async()=>new Response(null,{status,headers:requestId?{"x-oss-request-id":"fixture"}:{}})}),/anonymous access/);
  }
  await assert.rejects(verifyPrivateOssObject(denied,key,{storage,request:async()=>{throw Error("network unavailable");}}),/network/);
});
test("unrelated ACL errors and unsafe origin paths fail closed",async()=>{
  await assert.rejects(verifyPrivateOssObject({getACL:async()=>{throw Object.assign(Error("server unavailable"),{status:500});}},key),/server/);
  for(const [selectedStorage,selectedKey] of [[{...storage,bucket:"untrusted.example"},key],[storage,"../private/file.png"],[storage,"ai-task-media/file.png?signature=secret"]]){
    await assert.rejects(verifyPrivateOssObject(denied,selectedKey,{storage:selectedStorage,request:async()=>{throw Error("must not request");}}),/Invalid private/);
  }
});
