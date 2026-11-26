import crypto from 'node:crypto';
import {createReadStream} from 'node:fs';
import fs from 'node:fs/promises';
import {verifyPrivateOssObject} from './object-storage.js';

export async function writePrivateJsonFile(file,value){
 const named=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(named&&(!named.isFile()||named.isSymbolicLink()))throw Error('Unsafe private state file');
 const temporary=file+'.'+crypto.randomUUID()+'.tmp',handle=await fs.open(temporary,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}await fs.rename(temporary,file);
}

export async function streamFingerprint(stream,{maxBytes=2*1024**3}={}){
 const hash=crypto.createHash('sha256');let bytes=0;
 try{for await(const chunk of stream){bytes+=chunk.length;if(bytes>maxBytes)throw Error('Object exceeds verification byte budget');hash.update(chunk);}}
 finally{stream.destroy?.();}
 return {bytes,sha256:hash.digest('hex')};
}
export async function verifyPrivateObject(client,key,expected){
 await verifyPrivateOssObject(client,key);
 const got=await streamFingerprint((await client.getStream(key)).stream,{maxBytes:expected.bytes});
 if(got.bytes!==expected.bytes||got.sha256!==expected.sha256)throw Error('Private OSS object readback checksum differs from original');
 return got;
}
export async function persistPrivateObject(client,key,source,{expected,contentType='application/octet-stream',verify=verifyPrivateObject}={}){
 if(!expected||!Number.isSafeInteger(expected.bytes)||expected.bytes<0||expected.bytes>2*1024**3||!/^[a-f0-9]{64}$/.test(expected.sha256||''))throw Error('Invalid private object fingerprint');
 if(!/^database-archives\/[a-z0-9][a-z0-9/_.,-]*$/.test(key)||key.split('/').some(p=>p==='..'))throw Error('Invalid private archive namespace');
 let exists=false;try{await client.head(key);exists=true;}catch(e){if(Number(e.status||e.statusCode)!==404&&e.code!=='NoSuchKey')throw e;}
 if(!exists){const headers={'Content-Type':contentType,'x-oss-object-acl':'private','Cache-Control':'private, no-store'};
  if(Buffer.isBuffer(source))await client.put(key,source,{headers});
  else await client.putStream(key,createReadStream(source),{headers,contentLength:expected.bytes});
 }
 await verify(client,key,expected);return {object_key:key,...expected};
}
export async function immutableFileFingerprint(file){
 const before=await fs.lstat(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw Error('Archive source must be an ordinary single-link file');
 const body=await streamFingerprint(createReadStream(file));const after=await fs.lstat(file);
 const identity=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');if(identity(before)!==identity(after)||body.bytes!==after.size)throw Error('Archive source changed during read');
 return {...body,identity:identity(after)};
}
