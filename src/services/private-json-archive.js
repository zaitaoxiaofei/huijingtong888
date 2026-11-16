import crypto from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import OSS from "ali-oss";
import { ossStorageConfig, verifyPrivateOssObject } from "./object-storage.js";

export const jsonArchiveHash = text => crypto.createHash("sha256").update(text).digest("hex");
const MAX_BYTES = 64 * 1024 * 1024;
export function privateJsonArchiveClient(env=process.env){
  const storage=ossStorageConfig(env);
  if(!storage.enabled)throw new Error("OSS is required for private JSON archival");
  return new OSS({region:storage.region,bucket:storage.bucket,accessKeyId:storage.accessKeyId,accessKeySecret:storage.accessKeySecret,stsToken:storage.stsToken||undefined,secure:true,timeout:60000});
}
export async function archivePrivateJson(text,{namespace,client=privateJsonArchiveClient()}={}){
  if(typeof text!=="string"||Buffer.byteLength(text)>MAX_BYTES||!/^(?:listing-(?:drafts|templates)|inventory-media)\/(?:admin|[1-9][0-9]*)$/.test(namespace||""))throw new Error("Invalid private JSON archive input");
  JSON.parse(text);
  const sha256=jsonArchiveHash(text),objectKey=`database-archives/${namespace}/${sha256}.json.gz`,compressed=gzipSync(text,{level:9});
  let exists=false;try{await client.head(objectKey);exists=true;}catch(error){if(Number(error.status||error.statusCode)!==404&&error.code!=="NoSuchKey")throw error;}
  if(!exists)await client.put(objectKey,compressed,{headers:{"Content-Type":"application/gzip","x-oss-object-acl":"private"}});
  await verifyPrivateOssObject(client,objectKey);
  const original=await readPrivateJson({objectKey,sha256},{client});
  if(original!==text)throw new Error("Private JSON archive differs from original bytes");
  return {objectKey,sha256,originalBytes:Buffer.byteLength(text),compressedBytes:compressed.length};
}
export async function readPrivateJson({objectKey,sha256},{client=privateJsonArchiveClient()}={}){
  if(!/^database-archives\/(?:listing-(?:drafts|templates)|inventory-media)\/(?:admin|[1-9][0-9]*)\/[a-f0-9]{64}\.json\.gz$/.test(objectKey||"")||!objectKey.endsWith(`/${sha256}.json.gz`))throw new Error("Invalid private JSON archive reference");
  const result=await client.getStream(objectKey),chunks=[];let bytes=0;
  for await(const chunk of result.stream){bytes+=chunk.length;if(bytes>MAX_BYTES+65536)throw new Error("Compressed JSON archive exceeds byte bound");chunks.push(chunk);}
  const text=gunzipSync(Buffer.concat(chunks),{maxOutputLength:MAX_BYTES}).toString("utf8");
  if(jsonArchiveHash(text)!==sha256)throw new Error("Private JSON archive checksum mismatch");
  JSON.parse(text);return text;
}
