import {persistPrivateObject} from './verified-private-object.js';
import crypto from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { createServerOssClient } from "./oss-client.js";
import { ossStorageConfig, verifyPrivateOssObject } from "./object-storage.js";

export const jsonArchiveHash = text => crypto.createHash("sha256").update(text).digest("hex");
const MAX_BYTES = 64 * 1024 * 1024;
export function privateJsonArchiveClient(env=process.env){
  const storage=ossStorageConfig(env);
  if(!storage.enabled)throw new Error("OSS is required for private JSON archival");
  return createServerOssClient(storage,{env});
}
export async function archivePrivateJson(text,{namespace,client=privateJsonArchiveClient()}={}){
  if(typeof text!=="string"||Buffer.byteLength(text)>MAX_BYTES||!/^(?:listing-(?:drafts|templates)|inventory-media|media-cache|inventory-demand)\/(?:admin|[1-9][0-9]*)$/.test(namespace||""))throw new Error("Invalid private JSON archive input");
  JSON.parse(text);
  const sha256=jsonArchiveHash(text),objectKey=`database-archives/${namespace}/${sha256}.json.gz`,compressed=gzipSync(text,{level:9});
  let original;
  await persistPrivateObject(client,objectKey,compressed,{expected:{bytes:compressed.length,sha256:jsonArchiveHash(compressed)},contentType:'application/gzip',verify:async(oss,key,expectedCompressed)=>{
    await verifyPrivateOssObject(oss,key);
    original=await readPrivateJson({objectKey:key,sha256},{client:oss,expectedCompressed});
  }});
  if(original!==text)throw new Error("Private JSON archive differs from original bytes");
  return {objectKey,sha256,originalBytes:Buffer.byteLength(text),compressedBytes:compressed.length};
}
export async function readPrivateJson({objectKey,sha256},{client=privateJsonArchiveClient(),expectedCompressed=null}={}){
  if(!/^database-archives\/(?:listing-(?:drafts|templates)|inventory-media|media-cache|inventory-demand)\/(?:admin|[1-9][0-9]*)\/[a-f0-9]{64}\.json\.gz$/.test(objectKey||"")||!objectKey.endsWith(`/${sha256}.json.gz`))throw new Error("Invalid private JSON archive reference");
  const result=await client.getStream(objectKey),chunks=[];let bytes=0;
  for await(const chunk of result.stream){bytes+=chunk.length;if(bytes>MAX_BYTES+65536)throw new Error("Compressed JSON archive exceeds byte bound");chunks.push(chunk);}
  const compressed=Buffer.concat(chunks);
  if(expectedCompressed&&(bytes!==expectedCompressed.bytes||jsonArchiveHash(compressed)!==expectedCompressed.sha256))throw new Error("Private JSON archive compressed checksum mismatch");
  const text=gunzipSync(compressed,{maxOutputLength:MAX_BYTES}).toString("utf8");
  if(jsonArchiveHash(text)!==sha256)throw new Error("Private JSON archive checksum mismatch");
  JSON.parse(text);return text;
}
