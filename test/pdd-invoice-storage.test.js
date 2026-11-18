import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPddInvoiceStorage} from '../src/services/pdd-invoice-storage.js';
const bytes=Buffer.from('invoice-content'),file={sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length,ext:'pdf'};
const env={OSS_ENABLED:'true',OSS_REGION:'oss-cn-test',OSS_BUCKET:'test-private-bucket',OSS_ACCESS_KEY_ID:'test-id',OSS_ACCESS_KEY_SECRET:'test-secret'};
function harness(){
 const objects=new Map(),puts=[],gets=[],requests=[];let acl='private',anonymous=403;
 const client={
  async head(key){if(!objects.has(key))throw Object.assign(Error('missing'),{status:404});return{res:{headers:{'content-length':String(objects.get(key).length),'x-oss-version-id':'v1'}}};},
  async put(key,body,options){puts.push({key,options});objects.set(key,Buffer.from(body));},
  async get(key){gets.push(key);return{content:objects.get(key),res:{headers:{'x-oss-version-id':'v1'}}};},
  async getACL(){if(acl==='denied')throw Object.assign(Error('ACL metadata denied'),{status:403});return{acl};},async delete(key){objects.delete(key);}
 };
 const request=async(url,options)=>{requests.push({url,options});return{status:anonymous,ok:anonymous===200,headers:new Headers({'x-oss-request-id':'probe-id'}),body:{cancel:async()=>{}}};};
 return{storage:createPddInvoiceStorage({env,client,request}),objects,puts,requests,gets,setAcl:v=>acl=v,setAnonymous:v=>anonymous=v};
}
test('invoice storage uses private tenant/account OSS keys, validates bytes and never returns public URLs',async()=>{
 const h=harness(),storage=await h.storage.put(10,'account-001',file,bytes);
 assert.equal(storage.driver,'oss');assert.equal(storage.objectKey,`private/tenants/10/pdd-invoices/account-001/${file.sha256}.pdf`);assert.equal(storage.versionId,'v1');assert.equal(storage.url,undefined);
 assert.equal(h.puts[0].options.headers['x-oss-object-acl'],'private');assert.equal(h.puts[0].options.headers['Cache-Control'],'private, no-store');assert.ok(h.requests.every(r=>!r.options.headers.Authorization));
 assert.deepEqual(await h.storage.read(10,'account-001',{...file,storage}),bytes);
 await h.storage.put(10,'account-001',file,bytes);assert.equal(h.puts.length,1);
 await assert.rejects(h.storage.read(20,'account-001',{...file,storage}),/不一致/);
 await assert.rejects(h.storage.read(10,'account-002',{...file,storage}),/不一致/);
});
test('anonymous access, unreadable bytes, disabled OSS and another bucket all fail closed',async()=>{
 const h=harness();h.setAnonymous(200);await assert.rejects(h.storage.put(10,'account-001',file,bytes),/匿名访问/);assert.equal(h.objects.size,0);
 h.setAnonymous(403);const storage=await h.storage.put(10,'account-001',file,bytes);h.objects.set(storage.objectKey,Buffer.from('bad'));await assert.rejects(h.storage.read(10,'account-001',{...file,storage}),/大小校验/);
 await assert.rejects(h.storage.read(10,'account-001',{...file,storage:{...storage,bucket:'other-bucket'}}),/不一致/);
 await assert.rejects(createPddInvoiceStorage({env:{}}).put(10,'account-001',file,bytes),/未启用私有 OSS/);
});

test('public ACLs are rejected and no reference is returned',async()=>{
 const h=harness();h.setAcl('public-read');await assert.rejects(h.storage.put(10,'account-001',file,bytes),/私有权限校验/);assert.equal(h.objects.size,0);
});
test('backup manifest records private object references without copying credentials or file content',async()=>{
 const {pddInvoiceStorageManifest}=await import('../scripts/lib/pdd-invoice-storage-manifest.mjs');
 const h=harness(),storage=await h.storage.put(10,'account-001',file,bytes);
 const rows=[{tenant_id:10,account_id:'account-001',revision:2,payload_json:{name:'采购账号',fingerprint:'do-not-export',orders:[{id:'order-1',cloudFiles:[{id:'file-1',ext:'pdf',sha256:file.sha256,size:bytes.length,storage:{...storage,accessKeySecret:'do-not-export'}}]}]}}];
 const manifest=pddInvoiceStorageManifest(rows,10);assert.equal(manifest.fileCount,1);assert.equal(manifest.accounts[0].files[0].storage.objectKey,storage.objectKey);assert.ok(!JSON.stringify(manifest).includes('do-not-export'));
 assert.throws(()=>pddInvoiceStorageManifest(rows,20),/tenant mismatch/);
});

test('provider request errors do not leak credentials, request headers or file content',async()=>{
 const secret='must-not-appear';const storage=createPddInvoiceStorage({env,client:{head:async()=>{throw Object.assign(Error(secret),{code:'AccessDenied',request:{authorization:secret,body:secret}});}}});
 await assert.rejects(storage.put(10,'account-001',file,bytes),error=>!JSON.stringify(error).includes(secret)&&!error.message.includes(secret)&&error.message.includes('AccessDenied'));
});

test('least-privilege credentials can verify privacy by unsigned denial, but cannot leave a new public object',async()=>{
 const h=harness();h.setAcl('denied');await h.storage.put(10,'account-001',file,bytes);assert.equal(h.objects.size,1);
 const leak=harness();leak.setAcl('denied');leak.setAnonymous(200);await assert.rejects(leak.storage.put(10,'account-001',file,bytes),/匿名访问/);assert.equal(leak.objects.size,0);
});
