import assert from 'node:assert/strict';
import test from 'node:test';
import OSS from 'ali-oss';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {gzipSync} from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {privateJsonArchiveClient,archivePrivateJson,readPrivateJson} from '../src/services/private-json-archive.js';
import {createPddInvoiceStorage} from '../src/services/pdd-invoice-storage.js';
import {cleanupVerifiedLocalMedia} from '../scripts/cleanup-verified-local-media.mjs';
import {persistPrivateObject} from '../src/services/verified-private-object.js';

const env={OSS_ENABLED:'true',OSS_REGION:'oss-cn-heyuan',OSS_BUCKET:'fixture-private-bucket',OSS_ACCESS_KEY_ID:'fixture-id',OSS_ACCESS_KEY_SECRET:'fixture-secret',OSS_INTERNAL_READ:'true'};
const sha=value=>createHash('sha256').update(value).digest('hex');

async function withSdkMethods(methods,run){
 const original=Object.fromEntries(Object.keys(methods).map(name=>[name,Object.getOwnPropertyDescriptor(OSS.prototype,name)]));
 for(const [name,method] of Object.entries(methods))Object.defineProperty(OSS.prototype,name,{configurable:true,writable:true,value:method});
 try{return await run();}finally{for(const [name,descriptor] of Object.entries(original)){if(descriptor)Object.defineProperty(OSS.prototype,name,descriptor);else delete OSS.prototype[name];}}
}

function sdkStore(){
 const objects=new Map(),calls=[],puts=[];
 const state={acl:'private',readError:null};
 const call=(client,operation)=>{calls.push({operation,internal:client.options.internal,host:client.options.endpoint.hostname,timeout:client.options.timeout,secure:client.options.secure});};
 return {objects,calls,puts,state,methods:{
  async head(key){call(this,'head');if(!objects.has(key))throw Object.assign(Error('missing'),{status:404});return{res:{headers:{'content-length':String(objects.get(key).length)}}};},
  async put(key,bytes,options){call(this,'put');puts.push(options);objects.set(key,Buffer.from(bytes));},
  async getACL(){call(this,'getACL');return{acl:state.acl};},
  async getStream(key){call(this,'getStream');if(state.readError)throw state.readError;return{stream:Readable.from([objects.get(key)])};},
  async get(key){call(this,'get');if(state.readError)throw state.readError;return{content:objects.get(key),res:{headers:{'x-oss-version-id':'fixture-version'}}};},
  async delete(key){call(this,'delete');objects.delete(key);}
 }};
}

test('private JSON forwards its own network configuration while local default remains public',()=>{
 for(const [flag,internal] of [['true',true],['1',true],['false',false],[undefined,false]]){
  const configured={...env};if(flag===undefined)delete configured.OSS_INTERNAL_READ;else configured.OSS_INTERNAL_READ=flag;
  const client=privateJsonArchiveClient(configured);
  assert.equal(client.options.internal,internal);
  assert.equal(client.options.endpoint.hostname,`oss-cn-heyuan${internal?'-internal':''}.aliyuncs.com`);
  assert.equal(client.options.secure,true);
  assert.equal(client.options.timeout,60000);
 }
});

test('private JSON keeps private ACL and byte verification on the selected internal client',async()=>{
 const h=sdkStore();await withSdkMethods(h.methods,async()=>{
  const client=privateJsonArchiveClient(env),text=JSON.stringify({keep:'original JSON',items:[1,2]});
  const saved=await archivePrivateJson(text,{namespace:'listing-drafts/2',client});
  assert.equal(h.calls.filter(call=>call.operation==='getStream').length,1,'archive acknowledgment verifies one actual remote body');
  assert.equal(await readPrivateJson(saved,{client}),text);
  assert.equal(h.puts[0].headers['x-oss-object-acl'],'private');
  assert.equal(h.puts[0].headers['Cache-Control'],'private, no-store');
  h.objects.set(saved.objectKey,Buffer.from('corrupt gzip'));
  await assert.rejects(archivePrivateJson(text,{namespace:'listing-drafts/2',client}),/checksum|byte budget|differs/);
  h.state.acl='public-read';
  await assert.rejects(archivePrivateJson(text,{namespace:'listing-drafts/2',client}),/ACL/);
  assert.ok(h.calls.every(call=>call.internal&&call.host==='oss-cn-heyuan-internal.aliyuncs.com'&&call.secure));
 });
});

test('private JSON read failures cannot switch to a public endpoint',async()=>{
 const h=sdkStore();await withSdkMethods(h.methods,async()=>{
  const client=privateJsonArchiveClient(env),text='{}';
  const saved=await archivePrivateJson(text,{namespace:'inventory-media/admin',client});
  h.calls.length=0;h.state.readError=Object.assign(Error('internal network unavailable'),{code:'ECONNRESET'});
  await assert.rejects(readPrivateJson(saved,{client}),error=>error.code==='ECONNRESET');
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].operation,'getStream');
  assert.equal(h.calls[0].internal,true);
 });
});

test('one-body JSON archive validation retains compressed identity and exact semantic checks',async()=>{
 const h=sdkStore();await withSdkMethods(h.methods,async()=>{
  const client=privateJsonArchiveClient(env),text=' {"original":true} ',saved=await archivePrivateJson(text,{namespace:'listing-drafts/2',client});
  const changedHeader=Buffer.from(h.objects.get(saved.objectKey));changedHeader[9]^=1;
  h.objects.set(saved.objectKey,changedHeader);
  await assert.rejects(archivePrivateJson(text,{namespace:'listing-drafts/2',client}),/compressed checksum/);
  const verify=async(decoded,body,expected,expectedHash=sha(decoded))=>{
   const objectKey=`database-archives/listing-drafts/2/${expectedHash}.json.gz`;
   h.objects.set(objectKey,body);
   return readPrivateJson({objectKey,sha256:expectedHash},{client,expectedCompressed:expected||{bytes:body.length,sha256:sha(body)}});
  };
  const body=gzipSync('{}');
  await assert.rejects(verify('{}',body,{bytes:body.length+1,sha256:sha(body)}),/compressed checksum/);
  await assert.rejects(verify('{}',Buffer.from('invalid gzip')),error=>error.code==='Z_DATA_ERROR');
  await assert.rejects(verify('not JSON',gzipSync('not JSON')),SyntaxError);
  await assert.rejects(verify('{}',body,null,sha('{"different":true}')),/checksum/);
  const oversized=gzipSync(Buffer.alloc(64*1024*1024+1,32));
  await assert.rejects(verify('',oversized),error=>error.code==='ERR_BUFFER_TOO_LARGE');
 });
});

test('ordinary verification markers cannot disable default shared private-object checks',async()=>{
 const h=sdkStore();await withSdkMethods(h.methods,async()=>{
  const client=privateJsonArchiveClient(env),bytes=Buffer.from('original'),key='database-archives/test/original.bin';
  h.objects.set(key,Buffer.from('tampered'));
  await assert.rejects(persistPrivateObject(client,key,bytes,{expected:{bytes:bytes.length,sha256:sha(bytes)},verified:true}),/checksum/);
  assert.equal(h.calls.filter(call=>call.operation==='getStream').length,1);
  assert.equal(h.calls.filter(call=>call.operation==='getACL').length,1);
 });
});

test('invoice internal reads preserve public anonymous privacy probes, hashes and size checks',async()=>{
 const h=sdkStore(),probes=[];await withSdkMethods(h.methods,async()=>{
  const request=async(url,options)=>{probes.push({url,options});return{status:403,headers:new Headers({'x-oss-request-id':'fixture'}),body:{cancel:async()=>{}}};};
  const storage=createPddInvoiceStorage({env,request}),bytes=Buffer.from('invoice bytes'),file={sha256:sha(bytes),size:bytes.length,ext:'pdf'};
  const saved=await storage.put(2,'account-001',file,bytes);
  assert.equal(saved.url,undefined);
  assert.equal(h.puts[0].headers['x-oss-object-acl'],'private');
  assert.deepEqual(await storage.read(2,'account-001',{...file,storage:saved}),bytes);
  assert.ok(h.calls.every(call=>call.internal&&call.timeout===15000&&call.host==='oss-cn-heyuan-internal.aliyuncs.com'));
  assert.ok(probes.every(probe=>new URL(probe.url).hostname==='fixture-private-bucket.oss-cn-heyuan.aliyuncs.com'&&probe.options.headers.Range==='bytes=0-0'));
  h.objects.set(saved.objectKey,Buffer.from(bytes.map(byte=>byte^1)));
  await assert.rejects(storage.read(2,'account-001',{...file,storage:saved}),/内容校验/);
  h.objects.set(saved.objectKey,Buffer.from('x'));
  await assert.rejects(storage.read(2,'account-001',{...file,storage:saved}),/大小校验/);
  h.state.acl='public-read';
  await assert.rejects(storage.put(2,'account-002',file,bytes),/私有权限校验/);
  assert.ok(!h.objects.has(saved.objectKey.replace('account-001','account-002')));
 });
});

test('invoice internal failures keep sanitized errors and never retry file bytes over public OSS',async()=>{
 const h=sdkStore();await withSdkMethods(h.methods,async()=>{
  const storage=createPddInvoiceStorage({env,request:async()=>({status:403,headers:new Headers({'x-oss-request-id':'fixture'}),body:{cancel:async()=>{}}})});
  const bytes=Buffer.from('invoice'),file={sha256:sha(bytes),size:bytes.length,ext:'pdf'},saved=await storage.put(2,'account-001',file,bytes);
  h.calls.length=0;h.state.readError=Object.assign(Error('sensitive upstream message'),{code:'ETIMEDOUT'});
  await assert.rejects(storage.read(2,'account-001',{...file,storage:saved}),error=>error.statusCode===502&&error.message.includes('ETIMEDOUT')&&!error.message.includes('sensitive'));
  assert.equal(h.calls.filter(call=>call.operation==='get').length,1);
  assert.ok(h.calls.every(call=>call.internal));
 });
});

test('legacy audit uses internal metadata, keeps returned URLs public, and never deletes files',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'oss-internal-audit-'));
 try{
  const file=path.join(cwd,'uploads','ai-generated','fixture.png'),bytes=Buffer.from('fixture');
  await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);const old=new Date(Date.now()-20*86400000);await fs.utimes(file,old,old);
  const calls=[];
  await withSdkMethods({head:async function(){calls.push({internal:this.options.internal,timeout:this.options.timeout});return{res:{headers:{'content-length':String(bytes.length)}}};}},async()=>{
   const result=await cleanupVerifiedLocalMedia({cwd,env});
   assert.equal(result.verified,1);assert.equal(result.deleted,0);assert.equal(result.safeForDeletion,false);
   assert.equal(new URL(result.items[0].ossUrl).hostname,'fixture-private-bucket.oss-cn-heyuan.aliyuncs.com');
  });
  assert.deepEqual(calls,[{internal:true,timeout:15000}]);
  await withSdkMethods({head:async function(){calls.push({internal:this.options.internal});throw Object.assign(Error('offline'),{code:'ECONNRESET'});}},async()=>{
   const result=await cleanupVerifiedLocalMedia({cwd,env});assert.equal(result.errors,1);assert.equal(result.deleted,0);
  });
  assert.equal(calls.length,2);assert.ok(calls.every(call=>call.internal));assert.deepEqual(await fs.readFile(file),bytes);
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});
