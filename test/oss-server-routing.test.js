import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import OSS from 'ali-oss';
import { createServerOssClient, ossInternalEnabled } from '../src/services/oss-client.js';
import { readManagedOssObject, putContentAddressedObject, putContentAddressedFile,
  promoteManagedOssObjectUrl, consumeVerifiedContentAddressedBody, publicOssObjectUrl } from '../src/services/object-storage.js';

const storage = { region:'oss-cn-heyuan', bucket:'fixture-bucket', accessKeyId:'fixture-id', accessKeySecret:'fixture-secret' };
const env = { OSS_ENABLED:'true', OSS_REGION:storage.region, OSS_BUCKET:storage.bucket, OSS_ACCESS_KEY_ID:storage.accessKeyId,
  OSS_ACCESS_KEY_SECRET:storage.accessKeySecret, OSS_STS_TOKEN:storage.stsToken, OSS_INTERNAL_READ:'true', STORAGE_VERIFIED_WRITES_ENABLED:'1' };
const body = Buffer.from('verified image bytes');
const hash = crypto.createHash('sha256').update(body).digest('hex');
const url = publicOssObjectUrl({...storage,objectKey:`listing-media/${hash.slice(0,2)}/${hash}.png`});
const missing = () => Object.assign(new Error('missing'),{status:404});

async function mockedSdk(work, { failHead=false }={}) {
  const names=['head','get','getStream','getACL','put','putStream','copy'], previous=new Map(names.map(name=>[name,OSS.prototype[name]])), calls=[];
  const record=(client,op,key)=>{calls.push({client,op,key,internal:client.options.internal,endpoint:client.options.endpoint.hostname});};
  OSS.prototype.head=async function(key){record(this,'head',key);if(failHead)throw Object.assign(new Error('private endpoint unavailable'),{code:'ETIMEDOUT'});return{res:{headers:{'content-length':String(body.length),'content-type':'image/png'}}};};
  OSS.prototype.get=async function(key){record(this,'get',key);return{content:body,res:{headers:{'content-length':String(body.length),'content-type':'image/png'}}};};
  OSS.prototype.getStream=async function(key){record(this,'getStream',key);return{stream:Readable.from([body])};};
  OSS.prototype.getACL=async function(key){record(this,'getACL',key);return{acl:'private'};};
  for(const name of ['put','putStream','copy'])OSS.prototype[name]=async function(key){record(this,name,key);throw Error('Existing fixture must not upload or copy');};
  try{return await work(calls);}finally{for(const[name,method]of previous)OSS.prototype[name]=method;}
}

test('server client follows the configured network and preserves HTTPS, STS and public URLs',()=>{
  for(const flag of ['true',' TRUE ','1']){
    assert.equal(ossInternalEnabled({OSS_INTERNAL_READ:flag}),true);
    const client=createServerOssClient(storage,{env:{OSS_INTERNAL_READ:flag}});
    assert.equal(client.options.endpoint.hostname,'oss-cn-heyuan-internal.aliyuncs.com');
    assert.equal(client.options.endpoint.protocol,'https:');
  }
  for(const flag of [undefined,'false','0',''])assert.equal(createServerOssClient(storage,{env:{OSS_INTERNAL_READ:flag}}).options.endpoint.hostname,'oss-cn-heyuan.aliyuncs.com');
  assert.equal(createServerOssClient(storage,{env,internal:false}).options.internal,false);
  assert.equal(createServerOssClient({...storage,stsToken:'fixture-sts'},{env}).options.stsToken,'fixture-sts');
  assert.equal(url,`https://fixture-bucket.oss-cn-heyuan.aliyuncs.com/listing-media/${hash.slice(0,2)}/${hash}.png`);
});

test('managed proxy reads and content-addressed write/copy verification use the same internal policy',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'oss-route-'));
  t.after(async()=>{const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('oss-route-'));await fs.rm(target,{recursive:true,force:true});});
  const file=path.join(directory,'image.png');await fs.writeFile(file,body);
  await mockedSdk(async calls=>{
    const read=await readManagedOssObject(url,{env});assert.deepEqual(read.buffer,body);
    const object=await putContentAddressedObject(body,{env,extension:'.png'});
    const fromFile=await putContentAddressedFile(file,{env,extension:'.png',privateObject:true});
    const promoted=await promoteManagedOssObjectUrl(url.replace('/listing-media/','/ai-unused/'),{env});
    assert.equal(object.url,url);assert.equal(fromFile.url,url);assert.equal(promoted.url,url);
    assert.equal(calls.filter(call=>call.op==='getStream').length,3);
    assert.ok(calls.every(call=>call.internal===true&&call.endpoint==='oss-cn-heyuan-internal.aliyuncs.com'));
    assert.equal(calls.filter(call=>call.op==='getACL').length,1);
    for(const[index,stored]of [object,fromFile,promoted].entries()){
      const client=calls.filter(call=>call.op==='getStream')[index].client;
      assert.equal(consumeVerifiedContentAddressedBody(stored,{client}),true,'A successful full readback must issue a matching one-use acknowledgement');
      assert.equal(consumeVerifiedContentAddressedBody(stored,{client}),false);
    }
  });
});

test('server read failures stay on the configured endpoint, while local reads remain public',async()=>{
  await mockedSdk(async calls=>{
    await assert.rejects(readManagedOssObject(url,{env}),/private endpoint unavailable/);
    assert.equal(calls.length,1);assert.equal(calls[0].internal,true);
  },{failHead:true});
  await mockedSdk(async calls=>{
    await readManagedOssObject(url,{env:{...env,OSS_INTERNAL_READ:'false'}});
    assert.ok(calls.every(call=>call.internal===false&&call.endpoint==='oss-cn-heyuan.aliyuncs.com'));
  });
});

test('verification acknowledgements reject altered, copied, cross-client and expired results',async()=>{
  const client={head:async()=>{throw missing();},put:async()=>{},getStream:async()=>({stream:Readable.from([body])})};
  const put=()=>putContentAddressedObject(body,{env,client,extension:'.png'});
  for(const[field,value]of [['bucket','other-bucket'],['objectKey','listing-media/other.png'],['hashSha256','a'.repeat(64)],['size',body.length+1]]){
    const result=await put();result[field]=value;assert.equal(consumeVerifiedContentAddressedBody(result,{client}),false);
  }
  const copySource=await put();assert.equal(consumeVerifiedContentAddressedBody({...copySource},{client}),false);assert.equal(consumeVerifiedContentAddressedBody(copySource,{client}),true);
  const otherClient=await put();assert.equal(consumeVerifiedContentAddressedBody(otherClient,{client:{}}),false);assert.equal(consumeVerifiedContentAddressedBody(otherClient,{client}),false);
  const expired=await put(),now=Date.now;try{Date.now=()=>now()+60001;assert.equal(consumeVerifiedContentAddressedBody(expired,{client}),false);}finally{Date.now=now;}
  const unverified=await putContentAddressedObject(body,{env:{...env,STORAGE_VERIFIED_WRITES_ENABLED:'0'},client});assert.equal(consumeVerifiedContentAddressedBody(unverified,{client}),false);
});
