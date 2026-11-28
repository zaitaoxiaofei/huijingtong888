import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { createCompanyFinanceDocuments } from '../src/services/company-finance-documents.js';

const root = process.env.PAYOUT_TEST_ORIGINALS;
const entryFile = process.env.PAYOUT_TEST_ENTRY;
const withdrawalFile = process.env.PAYOUT_TEST_WITHDRAWAL;

test('Shanghai original payouts confirm once and split by actual collection month in isolated MySQL', {
 skip: !process.env.TENANT_TEST_MYSQL_SOCKET || !root || !entryFile || !withdrawalFile
}, async () => {
 const fixture = await createTenantMysqlFixture('payout_attribution');
 try {
  const q = fixture.query;
  for (const ddl of (await import('../src/services/finance-submissions-schema.js')).FINANCE_SUBMISSIONS_SCHEMA) await q(ddl);
  await q("INSERT INTO tenants(id,slug,name,status) VALUES(2,'a','Tenant A','active'),(3,'b','Tenant B','active')");
  await q("INSERT INTO finance_companies(id,tenant_id,name) VALUES(20,2,'上海汇境通国际贸易有限公司'),(30,3,'Other company')");
  await q("INSERT INTO shops(id,name,tenant_id) VALUES(41,'RuVibe Mart',2),(42,'RuVibe Mart S',2),(43,'RuVibe Mart X',2)");
  await q("INSERT INTO finance_shop_company_assignments(tenant_id,shop_id,company_id,effective_from) VALUES(2,41,20,'2026-01-01'),(2,42,20,'2026-01-01'),(2,43,20,'2026-01-01')");
  const files = new Map([
   ['entry',entryFile],['withdrawal',withdrawalFile],
   ['mart',join(root,'Mart','Payment_Report_01.01.2026-28.11.2026.xlsx')],
   ['s',join(root,'S','Payment_Report_14.03.2026-28.11.2026.xlsx')],
   ['x',join(root,'X','Payment_Report_01.01.2026-28.11.2026.xlsx')]
  ]);
  const service = createCompanyFinanceDocuments({
   query:q,execute:q,authorize:async s=>s,
   files:{
    owned:async()=>{},
    read:async url=>{const path=files.get(basename(url));return {buffer:await readFile(path),row:{original_name:basename(path)}};}
   },
   transaction:async worker=>{
    await fixture.connection.beginTransaction();
    try {
     const value=await worker({query:q,execute:q});
     await fixture.connection.commit();
     return value;
    } catch(error) {
     await fixture.connection.rollback();
     throw error;
    }
   }
  });
  const session={personId:10,roles:['admin'],tenant:{id:2,slug:'a',role:'owner'}};
  const period={company_id:20,from:'2026-01',to:'2026-12'};
  for (const [i,name] of [...files.keys()].entries()) {
   const shop=i>=2;
   const input={company_id:20,shop_id:shop?39+i:0,upload_type:shop?'settlement':'collection-cash',attachment_url:'/uploads/team-attachments/'+name};
   if(shop)input.month='2026-11';
   const {document}=await service.preview(input,session);
   assert.equal(document.parse_status,'preview',JSON.stringify(document.payload_json.warnings));
   await service.confirm({company_id:20,document_id:document.id},session);
  }
  const before=await service.report(period,session);
  assert.equal(before.cash_reconciliation.matches.length,36);
  assert.equal(before.cash_reconciliation.shop_entries.every(row=>row.shop_id===null),true);
  const matches=before.cash_reconciliation.matches.map(({entry,payment,status})=>{
   assert.equal(status,'amount_date_candidate');
   return {entry_reference:entry.reference,payment_document_id:payment.document_id,payment_source:payment.source};
  });
  const invalid={...matches.at(-1),payment_source:'changed row'};
  await assert.rejects(service.confirmPayouts({...period,matches:[...matches.slice(0,-1),invalid]},session),{statusCode:409});
  assert.equal((await q('SELECT COUNT(*) AS n FROM finance_payout_attributions'))[0].n,0);
  await assert.rejects(service.confirmPayouts({...period,matches},{...session,tenant:{...session.tenant,id:3}}),{statusCode:404});
  assert.deepEqual(await service.confirmPayouts({...period,matches},session),{confirmed:36,already_confirmed:0});
  assert.deepEqual(await service.confirmPayouts({...period,matches},session),{confirmed:0,already_confirmed:36});
  const after=await service.report(period,session);
  assert.deepEqual(after.metrics,before.metrics);
  assert.deepEqual(after.cash_reconciliation.currencies,before.cash_reconciliation.currencies);
  assert.deepEqual(after.cash_reconciliation.monthly,before.cash_reconciliation.monthly);
  assert.equal(after.cash_reconciliation.currencies[0].entries,575165.32);
  assert.equal(after.cash_reconciliation.currencies[0].fees,6638);
  assert.equal(after.cash_reconciliation.rows.length,53);
  assert.equal(after.cash_reconciliation.matches.every(m=>m.status==='confirmed'),true);
  const byShop=after.cash_reconciliation.shop_entries.reduce((acc,row)=>{
   const shop=acc.get(row.shop_id)||[0,0];shop[0]+=row.count;shop[1]+=Math.round(row.amount*100);acc.set(row.shop_id,shop);return acc;
  },new Map());
  assert.deepEqual(byShop,new Map([[41,[19,40599329]],[42,[9,9985770]],[43,[8,6931433]]]));
  for (const companyMonth of after.cash_reconciliation.monthly) {
   const groups=after.cash_reconciliation.shop_entries.filter(r=>r.month===companyMonth.month&&r.currency===companyMonth.currency);
   assert.equal(groups.reduce((sum,r)=>sum+r.count,0),companyMonth.entry_count);
   if(groups.length)assert.equal(groups.reduce((sum,r)=>sum+Math.round(r.amount*100),0),Math.round(companyMonth.entries*100));
  }
  assert.equal((await q('SELECT COUNT(*) AS n FROM finance_payout_attributions WHERE confirmed_by=10'))[0].n,36);
 } finally { await fixture.cleanup(); }
});
