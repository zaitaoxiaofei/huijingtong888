import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { parseFinanceDocument } from '../src/services/finance-document-parser.js';
import { createCompanyFinanceDocuments, reconcileImportedCash, summarizeImportedDocuments } from '../src/services/company-finance-documents.js';
import { authorizeApiRequest } from '../src/server/authorization.js';
import { tenantIsolationDecision } from '../src/server/tenant-isolation.js';
import { canAccessPage } from '../src/shared/permissions.js';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';

const session=(tenant=1)=>({personId:10,role:'admin',roles:['admin'],tenant:{id:tenant,slug:`tenant-${tenant}`,role:'owner',plan_code:'pro',subscription_status:'active'}});
async function workbook(rows){const b=new ExcelJS.Workbook(),s=b.addWorksheet('Report');rows.forEach((r,i)=>{if(r)s.getRow(i).values=r;});return Buffer.from(await b.xlsx.writeBuffer());}
function database(){
 const docs=[],files=new Map(),closed=new Set();let next=1;
 const query=async(sql,p=[])=>{
  if(sql.includes('FROM finance_companies'))return p[0]===p[1]?[{id:p[0],name:`Company ${p[0]}`,tax_number:''}]:[];
  if(sql.includes('FROM finance_shop_company_assignments'))return p[0]===p[1]?[{id:p[0]*10,name:'Example Z'}]:[];
  if(sql.includes('FROM finance_periods'))return closed.has(`${p[0]}:${p[1]}`)?[{id:1}]:[];
  if(sql.includes('FROM finance_import_documents')){
   assert.match(sql,/tenant_id=\?/);assert.match(sql,/company_id=\?/);
   if(sql.includes('WHERE id=?'))return docs.filter(d=>d.id===p[0]&&d.tenant_id===p[1]&&d.company_id===p[2]);
   if(sql.includes('sha256=?'))return docs.filter(d=>d.tenant_id===p[0]&&d.company_id===p[1]&&d.shop_key===p[2]&&(d.sha256===p[3]||(d.business_key&&d.business_key===p[4])));
   return docs.filter(d=>d.tenant_id===p[0]&&d.company_id===p[1]&&((d.month_key>=p[2]&&d.month_key<=p[3])||d.shop_key===0));
  }throw new Error('Unexpected query '+sql);
 };
 const execute=async(sql,p=[])=>{
  if(sql.startsWith('CREATE TABLE')||sql.startsWith('INSERT IGNORE INTO finance_periods'))return {};
  if(sql.startsWith('INSERT INTO finance_import_documents')){const keys=['tenant_id','company_id','shop_key','month_key','attachment_url','original_name','sha256','business_key','parse_status','payload_json','created_by'];const d=Object.fromEntries(keys.map((k,i)=>[k,p[i]]));d.id=next++;d.review_status='pending';docs.push(d);return {insertId:d.id};}
  if(sql.includes("SET parse_status='confirmed'")){const d=docs.find(d=>d.id===p[1]&&d.tenant_id===p[2]&&d.company_id===p[3]);if(d&&d.parse_status==='preview')d.parse_status='confirmed';return {affectedRows:d?1:0};}
  if(sql.includes('SET review_status=')){const d=docs.find(d=>d.id===p[3]&&d.tenant_id===p[4]&&d.company_id===p[5]);if(d){d.review_status=p[0];d.review_note=p[1];d.payload_json=p[2];}return {affectedRows:d?1:0};}
  throw new Error('Unexpected execute '+sql);
 };
 const privateFiles={owned:async(url,s)=>{if(files.get(url)?.tenant!==s.tenant.id)throw Object.assign(new Error('foreign attachment'),{statusCode:404});},read:async(url,s)=>{await privateFiles.owned(url,s);return files.get(url);}};
 const service=createCompanyFinanceDocuments({query,execute,files:privateFiles,authorize:async s=>s,transaction:async worker=>worker({query,execute})});return {service,docs,files,closed};
}
async function starFile(){const rows=[];rows[2]=[null,'Statement of services provided No. ЗВ - 123 dated 10/15/2026'];rows[3]=[null,'for the period from 10/1/2026 to 10/15/2026'];rows[13]=[null,'Star Products'];rows[15]=[null,'No.',null,null,null,'Amount including VAT (CNY)'];rows[17]=[null,'Total:',null,null,null,249.02];return workbook(rows);}

test('parser reads original document period and does not infer it from renamed filenames',async()=>{
 const buffer=await starFile();const p=await parseFinanceDocument(buffer,'renamed.xlsx',{month:'2026-10'});assert.equal(p.kind,'star-service');assert.equal(p.facts[0].amount,249.02);
 await assert.rejects(parseFinanceDocument(buffer,'202611.xlsx',{month:'2026-11'}),/正文期间/);
 await assert.rejects(parseFinanceDocument(buffer,'file.xlsx',{month:'2026-13'}),/业务月份/);
});
test('OOXML namespaced tags and rows without position attributes remain readable',async()=>{
 const z=new JSZip();z.file('xl/workbook.xml','<x:workbook xmlns:x="a" xmlns:r="b"><x:sheets><x:sheet r:id="s1"/></x:sheets></x:workbook>');
 z.file('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="s1" Target="/xl/worksheets/sheet1.xml"/></Relationships>');
 z.file('xl/worksheets/sheet1.xml','<worksheet><sheetData><row><c t="inlineStr"><is><t>support only</t></is></c></row></sheetData></worksheet>');
 const p=await parseFinanceDocument(await z.generateAsync({type:'nodebuffer'}),'source.xlsx',{month:'2026-10'});assert.equal(p.kind,'support');assert.equal(p.facts.length,0);
});
test('upload preview, confirm, re-upload, review and archive export preserve a single source and no duplicate amount',async()=>{
 const db=database(),s=session();const buffer=await starFile();db.files.set('/uploads/team-attachments/one.xlsx',{tenant:1,buffer,row:{original_name:'promotion.xlsx'}});
 const input={company_id:1,shop_id:10,month:'2026-10',attachment_url:'/uploads/team-attachments/one.xlsx'};
 const preview=await db.service.preview(input,s);assert.equal(preview.document.parse_status,'preview');
 assert.deepEqual((await db.service.report({company_id:1,month:'2026-10'},s)).metrics,{});
 await db.service.confirm({company_id:1,document_id:preview.document.id},s);await db.service.confirm({company_id:1,document_id:preview.document.id},s);
 assert.equal((await db.service.preview(input,s)).duplicate,true);assert.equal(db.docs.length,1);
 const report=await db.service.report({company_id:1,month:'2026-10'},s);assert.equal(report.metrics['星级商品推广费'],249.02);assert.equal(report.coverage.company_complete,false);
 await db.service.review({company_id:1,document_id:1,review_status:'accepted',review_note:'会计示例核对，凭证链待税务要求复查'},s);
 const archive=await db.service.export({company_id:1,month:'2026-10'},s),zip=await JSZip.loadAsync(archive.buffer);const names=Object.keys(zip.files).filter(n=>!zip.files[n].dir);
 assert.equal(names.filter(n=>n.endsWith('promotion.xlsx')).length,1);assert.ok(names.some(n=>n.includes('会计认可凭证')));assert.ok(names.some(n=>n.includes('00_公司汇总与明细.xlsx')));
 const payload=JSON.parse(db.docs[0].payload_json);assert.equal(payload.review_history.length,1);assert.equal(payload.review_history[0].person_id,10);
});
test('tenant A cannot upload against company B, attach B files, confirm B documents, read or export B company',async()=>{
 const db=database(),a=session(1),b=session(2),buffer=await starFile();db.files.set('/uploads/team-attachments/b.xlsx',{tenant:2,buffer,row:{original_name:'b.xlsx'}});
 for(const fn of ['report','export'])await assert.rejects(db.service[fn]({company_id:2,month:'2026-10'},a),/不属于/);
 await assert.rejects(db.service.preview({company_id:1,shop_id:10,month:'2026-10',attachment_url:'/uploads/team-attachments/b.xlsx'},a),/foreign attachment/);
 const doc=await db.service.preview({company_id:2,shop_id:20,month:'2026-10',attachment_url:'/uploads/team-attachments/b.xlsx'},b);
 await assert.rejects(db.service.confirm({company_id:1,document_id:doc.document.id},a),/不属于/);
 assert.equal((await db.service.report({company_id:1,month:'2026-10'},a)).documents.length,0);
});
test('closed months and incorrect shop ownership cannot be imported or confirmed',async()=>{
 const db=database();db.closed.add('1:2026-10');await assert.rejects(db.service.preview({company_id:1,shop_id:10,month:'2026-10'},session()),/已关账/);
 await assert.rejects(db.service.preview({company_id:1,shop_id:20,month:'2026-11'},session()),/不属于当前公司/);
});
test('unparseable uploads remain archived as errors and cannot enter financial totals',async()=>{
 const db=database();db.files.set('/uploads/team-attachments/broken.pdf',{tenant:1,buffer:Buffer.from('not a pdf'),row:{original_name:'broken.pdf'}});
 const doc=await db.service.preview({company_id:1,shop_id:10,month:'2026-10',attachment_url:'/uploads/team-attachments/broken.pdf'},session());assert.equal(doc.document.parse_status,'error');
 await assert.rejects(db.service.confirm({company_id:1,document_id:doc.document.id},session()),/解析失败/);assert.deepEqual((await db.service.report({company_id:1,month:'2026-10'},session())).metrics,{});
});
test('cash reconciliation preserves currencies, cross-month dates, ambiguous candidates and bank unknown',()=>{
 const doc={id:1,parse_status:'confirmed',payload_json:{cash:[{type:'entry',date:'2026-10-14 01:04',currency:'CNH',amount:100},{type:'withdrawal',date:'2026-10-14',currency:'CNH',amount:100,fee:1.2},{type:'withdrawal',date:'2026-11-05',currency:'CNH',amount:200,fee:2.4},{type:'platform-payment',date:'2026-10-13',currency:'CNY',amount:100}]}};
 const r=reconcileImportedCash([doc],{from:'2026-10',to:'2026-10'});assert.equal(r.currencies[0].fees,1.2);assert.equal(r.matches[0].status,'amount_date_candidate');assert.equal(r.bank_status,'missing');
 doc.payload_json.cash.push({type:'entry',date:'2026-10-14 02:00',currency:'CNH',amount:100});assert.equal(reconcileImportedCash([doc],{from:'2026-10',to:'2026-10'}).matches[0].status,'ambiguous');
});
test('preview and foreign-currency invoice facts never contribute to CNY totals',()=>{
 const s=summarizeImportedDocuments([{parse_status:'preview',payload_json:{facts:[{metric:'佣金',amount:99,currency:'CNY'}]}},{parse_status:'confirmed',payload_json:{facts:[{metric:'佣金',amount:99,currency:'RUB'}]}}]);assert.deepEqual(s.metrics,{});
});
test('new UI compiles and enterprise finance endpoints remain role gated',()=>{
 const filename='frontend/admin/views/finance/CompanyStatementsView.vue',source=readFileSync(filename,'utf8');const {descriptor,errors}=parse(source,{filename});assert.deepEqual(errors,[]);const script=compileScript(descriptor,{id:'company-statements'});assert.deepEqual(compileTemplate({source:descriptor.template.content,filename,id:'company-statements',compilerOptions:{bindingMetadata:script.bindings}}).errors,[]);
 assert.equal(canAccessPage(session(),'/finance/company-statements'),true);
 for(const [method,name]of [['GET','document-report'],['GET','document-export'],['POST','document-import']]){
  const parts=['api','finance-center',name];assert.equal(authorizeApiRequest({method,_session:session()},parts).allowed,true);assert.equal(tenantIsolationDecision(session(),parts,method).allowed,true);
  const member={...session(),roles:['operations'],role:'operations',tenant:{...session().tenant,role:'member'}};assert.equal(authorizeApiRequest({method,_session:member},parts).allowed,false);
 }
});
