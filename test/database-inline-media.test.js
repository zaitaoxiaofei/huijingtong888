import test from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';
import {archiveInlineMedia,externalizeInlineMedia,prepareInventoryInlineMedia} from '../src/services/database-inline-media.js';
const png=Buffer.from('89504e470d0a1a0a00000000','hex'),url='data:image/png;base64,'+png.toString('base64');
const env={OSS_ENABLED:'true',OSS_REGION:'oss-cn-hangzhou',OSS_BUCKET:'test-bucket',OSS_ACCESS_KEY_ID:'key',OSS_ACCESS_KEY_SECRET:'secret'};
function fixture(){
 const objects=new Map();let puts=0;
 const client={
  async head(key){if(!objects.has(key))throw Object.assign(Error('missing'),{status:404});},
  async put(key,bytes){puts++;objects.set(key,Buffer.from(bytes));},
  async getStream(key){return {stream:Readable.from([objects.get(key)])};}
 };
 return {objects,get puts(){return puts;},client};
}
test('inline images become verified OSS URLs; repeated JSON references upload only once',async()=>{
 const f=fixture();const value={images:[url,url],variants:[{images:[url]}],manual:'保留文字'},out=await externalizeInlineMedia(value,{env,client:f.client});
 assert.equal(f.puts,1);assert.match(out.images[0],/^https:\/\/test-bucket\.oss-cn-hangzhou\.aliyuncs.com\/product-media\//);assert.equal(out.variants[0].images[0],out.images[0]);assert.equal(value.images[0],url);assert.equal(out.manual,'保留文字');
});
test('unconfigured OSS, corrupted remote bytes and invalid media refuse storage',async()=>{
 await assert.rejects(archiveInlineMedia(url,{env:{}}),/OSS/);
 const f=fixture();f.client.getStream=async()=>({stream:Readable.from([Buffer.from('corrupt')])});await assert.rejects(archiveInlineMedia(url,{env,client:f.client}),/checksum/);
 await assert.rejects(archiveInlineMedia('data:image/png;base64,YmFk',{env}),/文件类型/);
 await assert.rejects(archiveInlineMedia('data:image/svg+xml;base64,PHN2Zy8+',{env}),/请上传/);
});
test('authorization failure blocks upload and ordinary URL/partial updates retain their shape',async()=>{
 const f=fixture();await assert.rejects(archiveInlineMedia(url,{env,client:f.client,beforeRequest:async()=>{throw Error('revoked');}}),/revoked/);assert.equal(f.puts,0);
 const input={name:'Only text'};assert.deepEqual(await prepareInventoryInlineMedia(input,{env:{}}),input);
 const result=await prepareInventoryInlineMedia({image_url:'https://example.com/a.png',detail_image_urls:JSON.stringify([url])},{env,client:f.client});assert.equal(result.image_url,'https://example.com/a.png');assert.match(result.detail_image_urls[0],/^https:/);
});
