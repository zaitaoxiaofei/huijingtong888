import test from "node:test";
import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {gzipSync} from "node:zlib";
import {archivePrivateJson,readPrivateJson} from "../src/services/private-json-archive.js";

function store(){const objects=new Map(),calls=[];return {objects,calls,client:{
  async head(key){if(!objects.has(key))throw Object.assign(new Error("missing"),{status:404});},
  async put(key,data,options){calls.push(options);objects.set(key,Buffer.from(data));},
  async getACL(){return {acl:"private"};},
  async getStream(key){return {stream:Readable.from([objects.get(key)])};}
}};}
test("JSON originals are privately archived and verified byte-for-byte before compaction",async()=>{
  const {client,calls}=store(),text=' { "images": ["oss://asset"], "manual": {"note":"保留原文"} } ';
  const archive=await archivePrivateJson(text,{namespace:"listing-drafts/2",client});
  assert.equal(calls[0].headers["x-oss-object-acl"],"private");assert.equal(await readPrivateJson(archive,{client}),text);
});
test("existing public objects and corrupted archives cannot authorize database changes",async()=>{
  const {client,objects}=store(),text=JSON.stringify({keep:"unchanged"});
  const archive=await archivePrivateJson(text,{namespace:"listing-drafts/admin",client});
  objects.set(archive.objectKey,gzipSync(JSON.stringify({keep:"corrupted"})));
  await assert.rejects(archivePrivateJson(text,{namespace:"listing-drafts/admin",client}),/checksum/);
  client.getACL=async()=>({acl:"public-read"});await assert.rejects(archivePrivateJson(text,{namespace:"listing-drafts/admin",client}),/Private OSS object ACL verification failed/);
});
test("JSON archive keys and enterprise namespaces cannot escape their boundary",async()=>{
  const {client}=store();await assert.rejects(archivePrivateJson("{}",{namespace:"listing-drafts/../finance",client}),/Invalid/);
  await assert.rejects(readPrivateJson({objectKey:"private-finance/file.json.gz",sha256:"a".repeat(64)},{client}),/Invalid/);
});
