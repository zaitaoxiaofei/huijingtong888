import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPddInvoiceLedger,sanitizePddRow} from '../src/services/pdd-invoice-ledger.js';
import {isTenantScopedPluginRoute} from '../src/server/local-plugin-tenant.js';
const A={tenantId:10,tenantSlug:'customer-a',tokenId:1},B={tenantId:20,tenantSlug:'customer-b',tokenId:2};
const accountId='test-account-a',orderId='261118-123456789012345';
const row={id:orderId,status:'issued',product:'采购物料',invoiceAmountCents:18585,appliedAt:'2026-11-18',thumbnail:'https://img.pddpic.com/a.png',url:`https://mobile.pinduoduo.com/order.html?order_sn=${orderId}`};
async function harness(t){
 const accounts=new Map(),root=await fs.mkdtemp(path.join(os.tmpdir(),'pdd-ledger-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const query=async(sql,args)=>{
  if(sql.includes('FROM finance_companies'))return args[0]===10?[{id:101,name:'甲公司',tax_number:'91310113MA12345678'}]:[{id:201,name:'乙公司',tax_number:'91310113MA87654321'}];
  if(sql.includes('FROM pdd_invoice_accounts')){
   assert.match(sql,/tenant_id=\?/);
   return [...accounts.values()].filter(r=>r.tenant_id===args[0]&&(!sql.includes('account_id=?')||r.account_id===args[1])).map(r=>({...r}));
  }
  throw Error('Unexpected query '+sql);
 };
 const execute=async(sql,args)=>{
  if(sql.startsWith('CREATE TABLE'))return{};
  if(sql.startsWith('INSERT')){const [tenant,id,revision,json]=args;accounts.set(`${tenant}:${id}`,{tenant_id:tenant,account_id:id,revision,payload_json:json});return{};}
  if(sql.startsWith('UPDATE')){const [revision,json,tenant,id]=args;assert.match(sql,/tenant_id=\?/);Object.assign(accounts.get(`${tenant}:${id}`),{revision,payload_json:json});return{};}
  throw Error('Unexpected write '+sql);
 };
 let chain=Promise.resolve();const transaction=worker=>{const next=chain.then(()=>worker({query,execute}));chain=next.catch(()=>{});return next;};
 const objects=new Map(),storage={
  async put(tenant,id,file,bytes){const objectKey=`private/tenants/${tenant}/pdd-invoices/${id}/${file.sha256}.${file.ext}`;objects.set(objectKey,Buffer.from(bytes));return{driver:'oss',bucket:'test-private',region:'oss-cn-test',objectKey,versionId:'v1'};},
  async read(tenant,id,file){assert.ok(file.storage.objectKey.startsWith(`private/tenants/${tenant}/pdd-invoices/${id}/`));return objects.get(file.storage.objectKey);}
 };
 return {ledger:createPddInvoiceLedger({query,execute,transaction,root,storage}),accounts,root,objects,storage};
}
test('enterprise key scopes company, account and ledger storage; client tenant IDs are ignored',async t=>{
 const {ledger}=await harness(t);assert.equal((await ledger.companies(A)).companies[0].id,101);
 const saved=await ledger.save(A,{accountId,name:'采购一号',companyId:101,tenantId:20,revision:0,rows:[{...row,cookies:'secret',fingerprint:'secret',cloudFiles:[{id:'forged'}]}]});assert.equal(saved.revision,1);
 assert.equal((await ledger.list(B)).accounts.length,0);const state=await ledger.list(A);assert.equal(state.accounts[0].name,'采购一号');assert.equal(state.accounts[0].orders[0].cloudFiles.length,0);assert.ok(!JSON.stringify(state).includes('secret'));
 await assert.rejects(ledger.save(A,{accountId,name:'采购一号',companyId:201,revision:1,rows:[row]}),/不属于当前企业/);
 await assert.rejects(ledger.list({...A,tokenId:0}),/有效的企业/);
});
test('stale device revisions cannot overwrite newer cloud ledger or account name',async t=>{
 const {ledger}=await harness(t);const input={accountId,name:'采购一号',companyId:101,revision:0,rows:[row]};await ledger.save(A,input);
 await ledger.save(A,{...input,revision:1,name:'保留的采购名称',rows:[{...row,status:'submitted'}]});
 await assert.rejects(ledger.save(A,{...input,revision:1}),e=>e.statusCode===409);
 const remote=(await ledger.list(A)).accounts[0];assert.equal(remote.name,'保留的采购名称');assert.equal(remote.orders[0].status,'submitted');
});
test('system invoice files are deduplicated, tenant private, preserved by ledger updates and checksum verified',async t=>{
 const {ledger,objects}=await harness(t);const input={accountId,name:'采购一号',companyId:101,revision:0,rows:[row]};await ledger.save(A,input);
 const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('invoice-test')]);
 const upload={accountId,orderId,base64:bytes.toString('base64')};const a=await ledger.fileSave(A,upload),b=await ledger.fileSave(A,upload);assert.equal(a.file.id,b.file.id);assert.equal(b.revision,2);
 await assert.rejects(ledger.fileRead(B,{accountId,fileId:a.file.id}),e=>e.statusCode===404);
 await assert.rejects(ledger.fileSave(A,{...upload,base64:Buffer.from('<svg>script</svg>').toString('base64')}),/仅支持/);
 assert.equal((await ledger.fileRead(A,{accountId,fileId:a.file.id})).base64,upload.base64);
 await ledger.save(A,{...input,revision:2,rows:[{...row,cloudFiles:[]}]});assert.equal((await ledger.list(A)).accounts[0].orders[0].cloudFiles[0].id,a.file.id);
 objects.set(a.file.storage.objectKey,Buffer.from('corrupt'));await assert.rejects(ledger.fileRead(A,{accountId,fileId:a.file.id}),/校验失败/);
});
test('only narrow invoice routes are added and row metadata cannot carry arbitrary URLs or credentials',()=>{
 for(const [method,route] of [['GET','companies'],['GET','accounts'],['POST','accounts'],['POST','files'],['GET','files'],['POST','migrate-file']])assert.equal(isTenantScopedPluginRoute(method,['api','local-plugin','pdd-invoices',route]),true);
 assert.equal(isTenantScopedPluginRoute('DELETE',['api','local-plugin','pdd-invoices','accounts']),false);
 assert.equal(isTenantScopedPluginRoute('POST',['api','local-plugin','finance-center','companies']),false);
 const safe=sanitizePddRow({...row,applicationUrl:'https://evil.test',thumbnail:'javascript:alert(1)',fingerprint:'secret'});assert.equal(safe.applicationUrl,undefined);assert.equal(safe.thumbnail,undefined);assert.ok(!JSON.stringify(safe).includes('secret'));
});

test('legacy migration previews without writing, updates the index only after verification and retains the original',async t=>{
 const {ledger,accounts,root,objects}=await harness(t);await ledger.save(A,{accountId,name:'采购一号',companyId:101,revision:0,rows:[row]});
 const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('legacy')]);
 const {createHash,randomUUID}=await import('node:crypto');const file={id:randomUUID(),ext:'png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),name:'old.png'};
 const stored=accounts.get(`10:${accountId}`),data=JSON.parse(stored.payload_json);data.orders[0].cloudFiles=[file];stored.payload_json=JSON.stringify(data);
 await fs.mkdir(path.join(root,'10'));const filename=path.join(root,'10',file.id+'.png');await fs.writeFile(filename,bytes);
 const input={accountId,orderId,fileId:file.id};const preview=await ledger.migrateFile(A,input);assert.equal(preview.needsMigration,true);assert.equal(objects.size,0);assert.equal(stored.revision,1);
 const migrated=await ledger.migrateFile(A,{...input,apply:true});assert.equal(migrated.file.id,file.id);assert.equal(migrated.file.storage.driver,'oss');assert.equal(migrated.localRetained,true);assert.deepEqual(await fs.readFile(filename),bytes);
 assert.equal((await ledger.migrateFile(A,{...input,apply:true})).alreadyMigrated,true);assert.equal(stored.revision,2);
 await assert.rejects(ledger.migrateFile(B,{...input,apply:true}),e=>e.statusCode===404);
});
test('OSS failures leave ledger indexes untouched and never fall back to local disk',async t=>{
 const {ledger,storage,root}=await harness(t);await ledger.save(A,{accountId,name:'采购一号',companyId:101,revision:0,rows:[row]});
 storage.put=async()=>{throw Error('OSS unavailable');};const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('invoice')]);
 await assert.rejects(ledger.fileSave(A,{accountId,orderId,base64:bytes.toString('base64')}),/OSS unavailable/);
 const cloud=(await ledger.list(A)).accounts[0];assert.equal(cloud.revision,1);assert.equal(cloud.orders[0].cloudFiles.length,0);assert.deepEqual(await fs.readdir(root),[]);
});
