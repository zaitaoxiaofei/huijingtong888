import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveSourceValidator } from '../src/services/finance-archive-source.js';
const source = { sha256:'a'.repeat(64),folder_id:'realizationReports',language:'en',document_id:'123',document_type:'Report',section:'结算单据',list_date:'2026-10-31',ozon_company_id:'77',months:'2026-10',binding_token:'verified' };
const input = () => ({company_id:10,shop_id:4,month:'2026-10',archive_source:{...source}});
const ctx = {tenantId:1,companyId:10,s:{tenant:{id:1}}};
const context = () => ({tenant_id:1,shop:{id:4,ozon_company_id:'77'},bindings:[{month:'2026-10',company:{id:10}}],binding_token:'verified'});
test('sync source records canonical official directory metadata after checking tenant, shop and monthly company',async()=>{
 let request,session;
 const validate=createArchiveSourceValidator({readContext:async(q,s)=>{request=q;session=s;return context();}});
 const value=await validate(input(),ctx,source.sha256);
 assert.deepEqual(request,{ozon_company_id:'77',months:'2026-10'});assert.equal(session,ctx.s);
 assert.equal(value.folder_name,'销售报告');assert.equal(value.document_id,'123');assert.equal(value.list_month,'2026-10');
 assert.equal(value.binding_token,undefined);assert.equal(value.sha256,source.sha256);
});
test('wrong file checksum, stale bindings, wrong enterprise, wrong shop and missing company coverage are rejected',async()=>{
 const validate=createArchiveSourceValidator({readContext:async()=>context()});
 await assert.rejects(validate(input(),ctx,'b'.repeat(64)),/校验和/);
 for(const change of [c=>c.tenant_id=2,c=>c.shop.id=5,c=>c.bindings[0].company.id=11,c=>c.binding_token='changed',c=>c.bindings[0].error='缺失',c=>c.bindings=[]]){
  const c=context();change(c);
  await assert.rejects(createArchiveSourceValidator({readContext:async()=>c})(input(),ctx,source.sha256),/归属已变化/);
 }
 for(const mutation of [i=>i.archive_source.folder_id='unknown',i=>i.archive_source.language='xx',i=>i.archive_source.document_id='',i=>i.upload_type='manual-expense']){
  const i=input();mutation(i);await assert.rejects(validate(i,ctx,source.sha256));
 }
});
