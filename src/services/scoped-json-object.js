import crypto from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import OSS from 'ali-oss';
import {ossStorageConfig,verifyPrivateOssObject} from './object-storage.js';
import {persistPrivateObject} from './verified-private-object.js';

const MARKER='_erp_oss_json_v1',MAX_BYTES=64*1024**2,THRESHOLD=256*1024;
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
function scope({kind,tenantId}){if(!['inventory-demand'].includes(kind)||!/^[1-9][0-9]*$/.test(String(tenantId)))throw Error('Explicit supported JSON object scope required');return `database-archives/application-json/${kind}/${tenantId}/`;}
function store(options){if(options.client)return options.client;const s=ossStorageConfig(options.env||process.env);if(!s.enabled)throw Error('OSS is required for large JSON storage');return new OSS({region:s.region,bucket:s.bucket,accessKeyId:s.accessKeyId,accessKeySecret:s.accessKeySecret,stsToken:s.stsToken||undefined,internal:true,secure:true,timeout:60000});}
export async function writeScopedJson(text,options){
 const prefix=scope(options);if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BYTES)throw Error('Large JSON size bound exceeded');const parsed=JSON.parse(text);if(parsed&&Object.hasOwn(parsed,MARKER))throw Error('Reserved object storage marker');
 if((options.env||process.env).LARGE_OBJECT_STORAGE_ENABLED!=='1'||Buffer.byteLength(text)<THRESHOLD)return text;
 // The read-model's refresh timestamp belongs in the small DB envelope. An
 // unchanged set of quantities must not upload a duplicate large object.
 const detach=options.kind==='inventory-demand'&&JSON.stringify(parsed)===text&&Object.keys(parsed).join(',')==='rows,full_calculated_at'&&Array.isArray(parsed.rows)&&typeof parsed.full_calculated_at==='string'&&parsed.full_calculated_at.length<=40&&Number.isFinite(Date.parse(parsed.full_calculated_at));
 const envelope=detach?{full_calculated_at:parsed.full_calculated_at}:null,stored=detach?JSON.stringify({rows:parsed.rows}):text;
 const body=gzipSync(stored,{level:6}),sha256=digest(stored),expected={bytes:body.length,sha256:digest(body)},key=prefix+sha256+'.json.gz';
 await persistPrivateObject(store(options),key,body,{expected,contentType:'application/gzip'});
 return JSON.stringify({[MARKER]:{kind:options.kind,tenant_id:String(options.tenantId),object_key:key,sha256,bytes:Buffer.byteLength(stored),compressed_bytes:body.length,compressed_sha256:expected.sha256,...(envelope?{envelope,original_sha256:digest(text),original_bytes:Buffer.byteLength(text)}:{})}});
}
export async function readScopedJson(text,options){
 const prefix=scope(options);if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BYTES)throw Error('Stored JSON size bound exceeded');let parsed;try{parsed=JSON.parse(text);}catch(error){if(text.includes(MARKER))throw error;return text;}if(!parsed||!Object.hasOwn(parsed,MARKER))return text;
 const ref=parsed[MARKER];if(Object.keys(parsed).length!==1||!ref||ref.kind!==options.kind||ref.tenant_id!==String(options.tenantId)||!/^[a-f0-9]{64}$/.test(ref.sha256||'')||ref.object_key!==prefix+ref.sha256+'.json.gz'||!Number.isSafeInteger(ref.bytes)||ref.bytes<1||ref.bytes>MAX_BYTES||!Number.isSafeInteger(ref.compressed_bytes)||ref.compressed_bytes<1||ref.compressed_bytes>MAX_BYTES+65536||!/^[a-f0-9]{64}$/.test(ref.compressed_sha256||''))throw Error('Invalid or cross-enterprise JSON object reference');
 const client=store(options),expected={bytes:ref.compressed_bytes,sha256:ref.compressed_sha256};await verifyPrivateOssObject(client,ref.object_key);
 const result=await client.getStream(ref.object_key),chunks=[];let size=0;try{for await(const b of result.stream){size+=b.length;if(size>expected.bytes)throw Error('JSON object compressed bound exceeded');chunks.push(b);}}finally{result.stream.destroy?.();}
 const compressed=Buffer.concat(chunks);if(size!==expected.bytes||digest(compressed)!==expected.sha256)throw Error('JSON object changed during read');const original=gunzipSync(compressed,{maxOutputLength:MAX_BYTES}).toString('utf8');if(Buffer.byteLength(original)!==ref.bytes||digest(original)!==ref.sha256)throw Error('JSON object recovery checksum mismatch');const value=JSON.parse(original);if(ref.envelope){if(Object.keys(ref.envelope).join(',')!=='full_calculated_at'||typeof ref.envelope.full_calculated_at!=='string'||ref.envelope.full_calculated_at.length>40||!Number.isSafeInteger(ref.original_bytes)||ref.original_bytes<1||ref.original_bytes>MAX_BYTES||!/^[a-f0-9]{64}$/.test(ref.original_sha256||'')||!Number.isFinite(Date.parse(ref.envelope.full_calculated_at))||Object.keys(value).join(',')!=='rows'||!Array.isArray(value.rows))throw Error('Invalid read-model envelope');const restored=JSON.stringify({...value,...ref.envelope});if(Buffer.byteLength(restored)!==ref.original_bytes||digest(restored)!==ref.original_sha256)throw Error('Read-model envelope recovery checksum mismatch');return restored;}return original;
}
