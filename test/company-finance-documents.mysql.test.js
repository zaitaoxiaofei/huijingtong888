import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createCompanyFinanceDocuments } from '../src/services/company-finance-documents.js';

test('company import persistence, duplicate keys, closing, review and tenant isolation in independent MySQL', {skip:!process.env.TENANT_TEST_MYSQL_SOCKET},async()=>{
 const fixture=await createTenantMysqlFixture('company_docs');
 try{
  const q=fixture.query;
  await q("INSERT INTO tenants(id,slug,name,status) VALUES(2,'a','Tenant A','active'),(3,'b','Tenant B','active')");
  await q("INSERT INTO finance_companies(id,tenant_id,name) VALUES(20,2,'Company A'),(30,3,'Company B')");
  await q("INSERT INTO shops(id,name,tenant_id) VALUES(200,'Test Z',2),(300,'Test Foreign',3)");
  await q("INSERT INTO finance_shop_company_assignments(tenant_id,shop_id,company_id,effective_from) VALUES(2,200,20,'2026-01-01'),(3,300,30,'2026-01-01')");
  const b=new ExcelJS.Workbook(),sheet=b.addWorksheet('Statement');sheet.getCell('B2').value='Statement of services provided No. ЗВ - 123 dated 10/15/2026';sheet.getCell('B3').value='for the period from 10/1/2026 to 10/15/2026';sheet.getCell('B13').value='Star Products';sheet.getCell('F15').value='Amount including VAT (CNY)';sheet.getCell('B17').value='Total:';sheet.getCell('F17').value=249.02;
  const buffer=Buffer.from(await b.xlsx.writeBuffer());
  const a={personId:10,roles:['operations'],tenant:{id:2,slug:'a',role:'owner'}},foreign={...a,tenant:{id:3,slug:'b',role:'owner'}};
  const files={owned:async(url,s)=>{assert.equal(s.tenant.id,2);},read:async()=>({buffer,row:{original_name:'test.xlsx'}})};
  const service=createCompanyFinanceDocuments({query:q,execute:q,files,authorize:async s=>s,transaction:async worker=>{await fixture.connection.beginTransaction();try{const result=await worker({query:q,execute:q});await fixture.connection.commit();return result;}catch(e){await fixture.connection.rollback();throw e;}}});
  const input={company_id:20,shop_id:200,month:'2026-10',attachment_url:'/uploads/team-attachments/test.xlsx'};
  const first=await service.preview(input,a);await service.confirm({company_id:20,document_id:first.document.id},a);
  assert.equal((await service.preview(input,a)).duplicate,true);
  assert.equal((await service.report({company_id:20,month:'2026-10'},a)).metrics['星级商品推广费'],249.02);
  await assert.rejects(service.report({company_id:20,month:'2026-10'},foreign),{statusCode:404});
  await assert.rejects(service.confirm({company_id:30,document_id:first.document.id},foreign),{statusCode:404});
  await service.review({company_id:20,document_id:first.document.id,review_status:'needs_info',review_note:'补充合同'},a);
  const doc=(await q('SELECT * FROM finance_import_documents WHERE id=?',[first.document.id]))[0];assert.equal(doc.review_status,'needs_info');
  const p=typeof doc.payload_json==='string'?JSON.parse(doc.payload_json):doc.payload_json;assert.equal(p.review_history.length,1);
  const result=await service.export({company_id:20,month:'2026-10'},a);assert.ok(result.buffer.length>1000);
  await q("UPDATE finance_periods SET status='closed' WHERE company_id=20 AND tenant_id=2 AND month_key='2026-10'");
  await assert.rejects(service.confirm({company_id:20,document_id:first.document.id},a),/已关账/);
  await assert.rejects(service.preview(input,a),/已关账/);
 }finally{await fixture.cleanup();}
});
