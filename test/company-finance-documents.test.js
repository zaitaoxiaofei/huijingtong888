import test from 'node:test';
import crypto from 'node:crypto';
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
function database(options={}){
 const docs=[],files=new Map(),closed=new Set();let next=1;
 const query=async(sql,p=[])=>{
  if(sql.includes('FROM finance_submission_items'))return [];
  if(sql.includes('FROM finance_expenses'))return (options.expenses||[]).filter(e=>e.company_id===p[0]&&e.tenant_id===p[1]);
  if(sql.includes('FROM finance_vouchers')){assert.match(sql,/e.company_id=\?/);assert.match(sql,/v.tenant_id=\?/);assert.match(sql,/pf.tenant_id=\?/);return options.vouchers||[];}
  if(sql.includes('FROM finance_companies'))return p[0]===p[1]?[{id:p[0],name:options.companyName||`Company ${p[0]}`,tax_number:''}]:[];
  if(sql.startsWith('SELECT shop_id,DATE_FORMAT'))return [{shop_id:10,effective_from:'2026-01-01',effective_to:null}];
  if(sql.includes('FROM orders o JOIN shops s')){assert.match(sql,/s.tenant_id=\?/);return options.items||[];}
  if(sql.includes('FROM finance_shop_company_assignments'))return p[0]===p[1]?[{id:p[0]*10,name:'Example Z'}]:[];
  if(sql.includes('FROM finance_reconciliation_adjustments')||sql.includes('FROM finance_payout_attributions'))return [];
  if(sql.includes('FROM ozon_orders_raw'))return [];
  if(sql.includes('FROM finance_periods'))return closed.has(`${p[0]}:${p[1]}`)?[{id:1}]:[];
  if(sql.includes('FROM finance_import_documents')){
   if(options.failJsonSort&&/ORDER BY month_key,id/.test(sql))throw Error('Out of sort memory');
   assert.match(sql,/tenant_id=\?/);assert.match(sql,/company_id=\?/);
   if(sql.includes('WHERE id=?'))return docs.filter(d=>d.id===p[0]&&d.tenant_id===p[1]&&d.company_id===p[2]);
   if(sql.includes('sha256=?'))return docs.filter(d=>d.tenant_id===p[0]&&d.company_id===p[1]&&d.shop_key===p[2]&&(d.sha256===p[3]||(d.business_key&&d.business_key===p[4])));
   return docs.filter(d=>d.tenant_id===p[0]&&d.company_id===p[1]&&((d.month_key>=p[2]&&d.month_key<=p[3])||(d.shop_key===0&&JSON.parse(d.payload_json).kind==='collection-cash')||JSON.parse(d.payload_json).kind==='platform-payments'));
  }throw new Error('Unexpected query '+sql);
 };
 const execute=async(sql,p=[])=>{
  if(sql.startsWith('CREATE TABLE')||sql.startsWith('INSERT IGNORE INTO finance_periods'))return {};
  if(sql.startsWith('INSERT INTO finance_import_documents')){const keys=['tenant_id','company_id','shop_key','month_key','attachment_url','original_name','sha256','business_key','parse_status','payload_json','created_by'];const d=Object.fromEntries(keys.map((k,i)=>[k,p[i]]));d.id=next++;d.review_status='pending';docs.push(d);return {insertId:d.id};}
  if(sql.includes("SET parse_status='confirmed'")){const d=docs.find(d=>d.id===p[1]&&d.tenant_id===p[2]&&d.company_id===p[3]);if(d&&d.parse_status==='preview'&&Number(d.revision||0)===p[4]){d.parse_status='confirmed';return {affectedRows:1};}return {affectedRows:0};}
  if(sql.includes('SET payload_json=?')){const d=docs.find(d=>d.id===p[1]&&d.tenant_id===p[2]&&d.company_id===p[3]&&d.parse_status==='preview'&&Number(d.revision||0)===p[4]);if(d){d.payload_json=p[0];d.review_status='pending';d.review_note=null;d.revision=Number(d.revision||0)+1;}return {affectedRows:d?1:0};}
  if(sql.includes("SET month_key=")){const d=docs.find(d=>d.id===p[3]);if(d){d.month_key=p[0];d.business_key=p[1];d.parse_status='preview';d.payload_json=p[2];d.revision=Number(d.revision||0)+1;}return {affectedRows:d?1:0};}
  if(sql.includes('SET review_status=')){const d=docs.find(d=>d.id===p[3]&&d.tenant_id===p[4]&&d.company_id===p[5]);if(d){d.review_status=p[0];d.review_note=p[1];d.payload_json=p[2];d.revision=Number(d.revision||0)+1;}return {affectedRows:d?1:0};}
  throw new Error('Unexpected execute '+sql);
 };
 const privateFiles={owned:async(url,s)=>{if(files.get(url)?.tenant!==s.tenant.id)throw Object.assign(new Error('foreign attachment'),{statusCode:404});},read:async(url,s)=>{await privateFiles.owned(url,s);return files.get(url);}};
 const service=createCompanyFinanceDocuments({query,execute,files:privateFiles,authorize:async s=>s,transaction:async worker=>worker({query,execute}),...options});return {service,docs,files,closed};
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
 const doc={id:1,parse_status:'confirmed',payload_json:{cash:[{type:'entry',date:'2026-10-14 01:04',currency:'CNH',amount:100,reference:'a'},{type:'withdrawal',date:'2026-10-14',currency:'CNH',amount:100,fee:1.2},{type:'withdrawal',date:'2026-11-05',currency:'CNH',amount:200,fee:2.4}]}};
 const platform={id:2,shop_key:10,parse_status:'confirmed',payload_json:{cash:[{type:'platform-payment',date:'2026-10-13',currency:'CNY',amount:100,source:'row 2'}]}};
 const r=reconcileImportedCash([doc,platform],{from:'2026-10',to:'2026-10'});assert.equal(r.currencies[0].fees,1.2);assert.equal(r.matches[0].status,'amount_date_candidate');assert.equal(r.bank_status,'missing');
 doc.payload_json.cash.push({type:'entry',date:'2026-10-14 02:00',currency:'CNH',amount:100,reference:'b'});assert.equal(reconcileImportedCash([doc,platform],{from:'2026-10',to:'2026-10'}).matches[0].status,'ambiguous');
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

test('typed uploads reject incorrect scope and mismatched report contents without recording facts',async()=>{
 const db=database(),s=session(),buffer=await starFile(),url='/uploads/team-attachments/typed.xlsx';db.files.set(url,{tenant:1,buffer,row:{original_name:'Акт услуг.xlsx'}});
 const input={company_id:1,shop_id:10,month:'2026-10',attachment_url:url};
 await assert.rejects(db.service.preview({...input,upload_type:'invalid'},s),/上传类型/);
 await assert.rejects(db.service.preview({...input,shop_id:0,upload_type:'sales'},s),/实际店铺/);
 await assert.rejects(db.service.preview({...input,upload_type:'collection-cash'},s),/公司共用/);
 const wrong=await db.service.preview({...input,upload_type:'sales'},s);assert.equal(wrong.document.parse_status,'error');assert.deepEqual(wrong.document.payload_json.facts,[]);
 const corrected=await db.service.preview({...input,upload_type:'platform-fees',display_name:'10月推广服务书'},s);assert.equal(corrected.document.parse_status,'preview');assert.equal(corrected.document.original_name,'Акт услуг.xlsx');
 await db.service.confirm({company_id:1,document_id:corrected.document.id},s);assert.equal((await db.service.report({company_id:1,month:'2026-10'},s)).metrics['星级商品推广费'],249.02);
});
test('company shared expenses and linked invoices are recorded once, with original Unicode names in ZIP',async()=>{
 const db=database(),s=session();
 for(const [name,data] of [['Счёт AI октябрь.png','payment'],['发票.pdf','invoice']])db.files.set('/uploads/team-attachments/'+name,{tenant:1,buffer:Buffer.from(data),row:{original_name:name}});
 const input={company_id:1,shop_id:0,month:'2026-10',upload_type:'manual-expense',attachment_url:'/uploads/team-attachments/Счёт AI октябрь.png',display_name:'10月AI费用',manual:{metric:'AI使用费',amount:123.45,currency:'CNY',note:'供应商本月实际使用账单'}};
 const d=await db.service.preview(input,s);await db.service.confirm({company_id:1,document_id:d.document.id},s);
 assert.equal((await db.service.preview(input,s)).duplicate,true);
 await assert.rejects(db.service.preview({...input,manual:{...input.manual,amount:234}},s),/不同的记账内容/);
 const evidence={company_id:1,shop_id:0,month:'2026-10',upload_type:'support',attachment_url:'/uploads/team-attachments/发票.pdf',related_document_id:d.document.id};
 await assert.rejects(db.service.preview({...evidence,month:'2026-11'},s),/原业务月份/);
 await assert.rejects(db.service.preview({...evidence,shop_id:10},s),/同一店铺/);
 const inv=await db.service.preview(evidence,s);await db.service.confirm({company_id:1,document_id:inv.document.id},s);
 const report=await db.service.report({company_id:1,from:'2026-01',to:'2026-12',period_mode:'quarter'},s);
 assert.equal(report.metrics['AI使用费'],123.45);assert.equal(report.lines.length,1);assert.equal(report.lines[0].linked_evidence[0].document_id,inv.document.id);assert.equal(report.matrix.periods.length,4);
 const nov=await db.service.report({company_id:1,month:'2026-11'},s);assert.deepEqual(nov.metrics,{});assert.equal(nov.lines.length,0);
 const zip=await JSZip.loadAsync((await db.service.export({company_id:1,from:'2026-01',to:'2026-12',period_mode:'quarter'},s)).buffer);
 assert.ok(Object.keys(zip.files).some(n=>n.endsWith('Счёт AI октябрь.png')));
 const reportBook=Object.keys(zip.files).find(n=>n.endsWith('00_公司汇总与明细.xlsx')),b=new ExcelJS.Workbook();await b.xlsx.load(await zip.file(reportBook).async('nodebuffer'));
 assert.equal(b.getWorksheet('期间分类汇总').columnCount,5);assert.equal(b.getWorksheet('期间分类汇总').getRow(1).getCell(5).value,'第4季度');
});
test('manual amounts require business evidence, and payroll/support documents do not post expenses',async()=>{
 const db=database(),s=session(),url='/uploads/team-attachments/a.png';db.files.set(url,{tenant:1,buffer:Buffer.from('receipt'),row:{original_name:'工资表.png'}});
 const input={company_id:1,shop_id:0,month:'2026-10',attachment_url:url};
 for(const manual of [{metric:'佣金',amount:100,currency:'CNY',note:'x'},{metric:'AI使用费',amount:100,currency:'RUB',note:'x'},{metric:'AI使用费',amount:-5,currency:'CNY',note:'x'},{metric:'AI使用费',amount:1.001,currency:'CNY',note:'x'},{metric:'AI使用费',amount:100,currency:'CNY',note:''}]){
  const d=await db.service.preview({...input,upload_type:'manual-expense',manual},s);assert.equal(d.document.parse_status,'error');assert.deepEqual(d.document.payload_json.facts,[]);
 }
 const payroll=await db.service.preview({...input,upload_type:'payroll'},s);await db.service.confirm({company_id:1,document_id:payroll.document.id},s);assert.deepEqual((await db.service.report({company_id:1,month:'2026-10'},s)).metrics,{});
});

test('manual draft changes require a matching revision, preserve history and stop after confirmation',async()=>{
 const db=database(),s=session(),url='/uploads/team-attachments/draft.png';db.files.set(url,{tenant:1,buffer:Buffer.from('draft receipt'),row:{original_name:'draft.png'}});
 const input={company_id:1,shop_id:0,month:'2026-10',attachment_url:url,upload_type:'manual-expense',manual:{metric:'AI使用费',amount:10,currency:'CNY',note:'原用途'}};
 const d=await db.service.preview(input,s);
 const changed={...input,manual:{...input.manual,amount:20,note:'更正为实际使用额'}};
 await assert.rejects(db.service.preview(changed,s),/草稿已存在/);
 const edited=await db.service.preview({...changed,expected_revision:0},s);assert.equal(edited.document.revision,1);assert.equal(edited.document.payload_json.preview_history[0].manual.amount,10);
 await assert.rejects(db.service.preview({...input,expected_revision:0},s),/草稿已存在/);
 assert.deepEqual((await db.service.report({company_id:1,month:'2026-10'},s)).metrics,{});
 await assert.rejects(db.service.confirm({company_id:1,document_id:d.document.id,expected_revision:0},s),/草稿已经修改/);
 await db.service.confirm({company_id:1,document_id:d.document.id,expected_revision:1},s);assert.equal((await db.service.report({company_id:1,month:'2026-10'},s)).metrics['AI使用费'],20);
 await assert.rejects(db.service.preview({...input,expected_revision:1},s),/不同的记账内容/);
});

test('editing a reviewed manual draft invalidates approval and retains its review history',async()=>{
 const db=database(),s=session(),url='/uploads/team-attachments/reviewed.png';db.files.set(url,{tenant:1,buffer:Buffer.from('reviewed receipt'),row:{original_name:'reviewed.png'}});
 const input={company_id:1,shop_id:0,month:'2026-10',attachment_url:url,upload_type:'manual-expense',manual:{metric:'AI使用费',amount:10,currency:'CNY',note:'实际服务费用'}};
 const d=await db.service.preview(input,s);await db.service.review({company_id:1,document_id:d.document.id,review_status:'accepted',review_note:'原金额资料核对'},s);
 const e=await db.service.preview({...input,manual:{...input.manual,amount:20},expected_revision:1},s);assert.equal(e.document.review_status,'pending');assert.equal(e.document.revision,2);assert.deepEqual(e.document.payload_json.review_history.map(h=>h.status),['accepted','pending']);
});

test('a whole-year payment original archived in October remains available for August cash reconciliation',async()=>{
 const db=database();db.docs.push({id:1,tenant_id:1,company_id:1,shop_key:10,month_key:'2026-10',original_name:'year-payment.xlsx',parse_status:'confirmed',payload_json:JSON.stringify({kind:'platform-payments',facts:[],cash:[{type:'platform-payment',date:'2026-08-24',amount:100,currency:'CNY'}]})});
 const report=await db.service.report({company_id:1,month:'2026-08'},session());assert.equal(report.documents.length,1);assert.equal(report.documents[0].month_key,'2026-10');assert.equal(report.cash_reconciliation.matches.length,1);assert.equal(report.cash_reconciliation.matches[0].payment.amount,100);assert.deepEqual(report.metrics,{});
});


test('plugin source upload stays pending, repeated sync finds the existing document, and confirmation keeps one amount',async()=>{
 const {createArchiveSourceValidator}=await import('../src/services/finance-archive-source.js');
 const context={tenant_id:1,shop:{id:10,ozon_company_id:'77'},bindings:[{month:'2026-10',company:{id:1}}],binding_token:'verified'};
 const validateSource=createArchiveSourceValidator({readContext:async()=>context});
 const db=database({validateSource}),buffer=await starFile();
 const hash=(await import('node:crypto')).createHash('sha256').update(buffer).digest('hex');
 db.files.set('/uploads/team-attachments/sync.xlsx',{tenant:1,buffer,row:{original_name:'sync.xlsx'}});
 const input={company_id:1,shop_id:10,month:'2026-10',attachment_url:'/uploads/team-attachments/sync.xlsx',archive_source:{sha256:hash,folder_id:'updWithAdditionalServices',language:'en',document_id:'123',ozon_company_id:'77',months:'2026-10',binding_token:'verified'}};
 assert.equal((await db.service.lookup(input,session())).document,null);
 const result=await db.service.preview(input,session());
 assert.equal(result.document.parse_status,'preview');assert.equal(result.document.payload_json.archive_source.document_id,'123');
 assert.deepEqual((await db.service.report({company_id:1,month:'2026-10'},session())).metrics,{});
 assert.equal((await db.service.lookup(input,session())).document.id,result.document.id);
 assert.equal((await db.service.preview(input,session())).duplicate,true);assert.equal(db.docs.length,1);
 await db.service.confirm({company_id:1,document_id:result.document.id},session());
 const report=await db.service.report({company_id:1,month:'2026-10'},session());
 assert.equal(report.metrics['星级商品推广费'],249.02);assert.equal(report.lines[0].document_id,result.document.id);
 context.binding_token='changed';await assert.rejects(db.service.lookup(input,session()),/归属已变化/);
});
test('plugin binding is rechecked after parsing and before a draft write',async()=>{
 const {createArchiveSourceValidator}=await import('../src/services/finance-archive-source.js');
 let token='verified';
 const validateSource=createArchiveSourceValidator({readContext:async()=>({tenant_id:1,shop:{id:10,ozon_company_id:'77'},bindings:[{month:'2026-10',company:{id:1}}],binding_token:token})});
 const buffer=await starFile(),hash=(await import('node:crypto')).createHash('sha256').update(buffer).digest('hex');
 const db=database({validateSource,parse:async(...args)=>{const p=await parseFinanceDocument(...args);token='changed';return p;}});
 db.files.set('/uploads/team-attachments/sync.xlsx',{tenant:1,buffer,row:{original_name:'sync.xlsx'}});
 await assert.rejects(db.service.preview({company_id:1,shop_id:10,month:'2026-10',attachment_url:'/uploads/team-attachments/sync.xlsx',archive_source:{sha256:hash,folder_id:'realizationReports',language:'en',document_id:'123',ozon_company_id:'77',months:'2026-10',binding_token:'verified'}},session()),/归属已变化/);
 assert.equal(db.docs.length,0);
});

test('collected summary exposes pending parsed amounts and evidence without posting or duplicating confirmed amounts',async()=>{
 const db=database(),s=session(),buffer=await starFile();db.files.set('/uploads/team-attachments/pending.xlsx',{tenant:1,buffer,row:{original_name:'pending.xlsx'}});
 const d=await db.service.preview({company_id:1,shop_id:10,month:'2026-10',attachment_url:'/uploads/team-attachments/pending.xlsx'},s);
 let report=await db.service.report({company_id:1,month:'2026-10'},s);
 assert.deepEqual(report.metrics,{});assert.equal(report.collected_summary.metrics['星级商品推广费'],249.02);
 assert.equal(report.collected_summary.pending_documents,1);assert.equal(report.collected_summary.lines[0].document_id,d.document.id);
 assert.equal(report.collected_summary.lines[0].shop_id,10);assert.equal(report.collected_summary.lines[0].parse_status,'preview');
 assert.equal(report.collected_summary.lines[0].attachment_url,'/uploads/team-attachments/pending.xlsx');
 assert.equal(report.collected_summary.matrix.rows.find(g=>g.id==='platform').pending_cells['2026-10'],true);
 const archive=await JSZip.loadAsync((await db.service.export({company_id:1,month:'2026-10'},s)).buffer);const b=new ExcelJS.Workbook();await b.xlsx.load(await archive.file(Object.keys(archive.files).find(n=>n.endsWith('00_公司汇总与明细.xlsx'))).async('nodebuffer'));
 assert.equal(b.getWorksheet('参考金额原件依据').getRow(2).getCell(5).value,'待核对');
 await db.service.confirm({company_id:1,document_id:d.document.id},s);report=await db.service.report({company_id:1,month:'2026-10'},s);
 assert.equal(report.metrics['星级商品推广费'],249.02);assert.equal(report.collected_summary.metrics['星级商品推广费'],249.02);assert.equal(report.collected_summary.pending_documents,0);
});
test('collected amounts exclude parse errors, support, other currency and out-of-period facts; cash remains confirmed-only',()=>{
 const docs=['preview','confirmed','error'].map((parse_status,i)=>({id:i+1,shop_key:10,month_key:'2026-10',parse_status,payload_json:{facts:[{metric:'佣金',amount:10,currency:'CNY'}],cash:[{type:'platform-payment',amount:10,currency:'CNY',date:'2026-10-01',reference:String(i)}]}}));
 docs.push({parse_status:'preview',month_key:'2026-11',payload_json:{facts:[{metric:'佣金',amount:99,currency:'CNY'}]}},{parse_status:'preview',month_key:'2026-10',payload_json:{kind:'support',facts:[]}},{parse_status:'preview',month_key:'2026-10',payload_json:{facts:[{metric:'佣金',amount:99,currency:'RUB'}]}});
 const summary=summarizeImportedDocuments(docs,{from:'2026-10',to:'2026-10'},{includePreview:true});assert.equal(summary.metrics['佣金'],20);assert.equal(summary.lines.length,2);assert.equal(summary.cash.length,1);
});

test('manual download directory survives preview, summary, deduplication and accountant export',async()=>{
 const db=database(),s=session(),buffer=await starFile(),url='/uploads/team-attachments/location.xlsx';db.files.set(url,{tenant:1,buffer,row:{original_name:'Акт услуг.xlsx'}});
 const input={company_id:1,shop_id:10,month:'2026-10',attachment_url:url,source_location:{platform:'ozon',folder_id:'agentReports',section:'报告'}};
 const first=await db.service.preview(input,s);assert.equal(first.document.payload_json.source_location.folder_name,'合作伙伴报告');
 await db.service.confirm({company_id:1,document_id:first.document.id},s);
 assert.equal((await db.service.preview(input,s)).duplicate,true);
 const report=await db.service.report({company_id:1,month:'2026-10'},s);assert.equal(report.lines[0].source_location.path,'Ozon Seller > 财务 > 文件 > 合作伙伴报告 > 报告');assert.equal(report.metrics['星级商品推广费'],249.02);
 const archive=await db.service.export({company_id:1,month:'2026-10'},s),zip=await JSZip.loadAsync(archive.buffer),index=JSON.parse(await Object.values(zip.files).find(f=>f.name.endsWith('来源索引.json')).async('string'));assert.equal(index[0].source_location.path,report.lines[0].source_location.path);
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(await Object.values(zip.files).find(f=>f.name.endsWith('00_公司汇总与明细.xlsx')).async('nodebuffer'));const sheet=workbook.getWorksheet('店铺费用来源');assert.equal(sheet.getRow(1).values.at(-1),'平台下载目录');assert.equal(sheet.getRow(2).values.at(-1),report.lines[0].source_location.path);
 await assert.rejects(db.service.preview({...input,source_location:{platform:'ozon',folder_id:'agentReports',section:'bad'}},s),/下载目录/);
});

test('existing salaries and software registrations enter collected summary once with original month and company scope',async()=>{
 const expense=(id,category,amount,extra={})=>({id,company_id:1,tenant_id:1,month_key:'2026-10',category,amount_cny:amount,description:category,source_type:'user_cost_default',...extra});
 const db=database({expenses:[expense(1,'salary',1000),expense(2,'ai_subscription',700),expense(3,'internet',100),expense(4,'rent',1000),expense(5,'utilities',300),expense(6,'ai_tokens',0),expense(7,'物流',100,{source_type:'finance_submission'}),expense(8,'software',999,{company_id:2,tenant_id:2})],vouchers:[{id:20,expense_id:2,voucher_number:'Software invoice',attachment_url:'/uploads/team-attachments/software.pdf',review_status:'approved'}]});
 const r=await db.service.report({company_id:1,month:'2026-10'},session());
 assert.equal(r.collected_summary.metrics['软件订阅费'],700);assert.equal(r.collected_summary.metrics['网络费用'],100);assert.equal(r.collected_summary.metrics['场地租金'],1000);assert.equal(r.collected_summary.metrics['水电物业费'],300);assert.equal(r.collected_summary.metrics['AI使用费'],0);assert.equal(r.collected_summary.metrics['国内物流费'],100);assert.equal(r.collected_summary.metrics['工资'],1000);
 const salary=r.collected_summary.lines.filter(l=>l.metric==='工资');assert.equal(salary.length,1);
 const software=r.collected_summary.lines.find(l=>l.metric==='软件订阅费');assert.equal(software.expense_id,2);assert.equal(software.month,'2026-10');assert.equal(software.shop_id,0);assert.equal(software.amount_status,'estimated');assert.equal(software.linked_evidence[0].attachment_url,'/uploads/team-attachments/software.pdf');
 assert.equal(r.collected_summary.lines.some(l=>l.expense_id===8),false);assert.equal(r.metrics['软件订阅费'],undefined);

});

test('company purchase reference joins report postings and exports rows without posting expenses or confirming previews',async()=>{
 const items=[{shop_id:10,order_id:1,item_id:2,posting_number:'1-2-3',ozon_sku:'9',quantity:1,purchase_cost_cny:12,frozen_purchase_cost:8}];const db=database({items});
 db.docs.push({id:77,tenant_id:1,company_id:1,shop_key:10,month_key:'2026-05',original_name:'order.json',attachment_url:'/uploads/team-attachments/order.json',parse_status:'preview',review_status:'pending',payload_json:JSON.stringify({kind:'order-sales',facts:[],order_rows:[{posting_number:'1-2-3',sku:'9',row_number:1,sold:100,returned:0,partner:0,partner_returned:0,bonus:0,bonus_returned:0,sold_quantity:1,returned_quantity:0,standard_fee:10,standard_fee_returned:0}]})});
 const raw=Buffer.from('official source fixture'),url='/uploads/team-attachments/order.json';db.docs[0].sha256=crypto.createHash('sha256').update(raw).digest('hex');db.files.set(url,{tenant:1,buffer:raw,row:{original_name:'order.json'}});
 const r=await db.service.report({company_id:1,from:'2026-01',to:'2026-12'},session());assert.equal(r.collected_summary.metrics['已售商品采购成本'],12);assert.equal(r.metrics['已售商品采购成本'],undefined);assert.equal(r.purchase_cost.complete,true);assert.equal(r.purchase_cost.lines[0].cost_row_count,1);assert.equal(db.docs[0].parse_status,'preview');assert.equal(r.documents[0].payload_json.order_rows,undefined);assert.equal(r.documents[0].payload_json.order_row_count,1);
 const detail=await db.service.report({company_id:1,month:'2026-05',purchase_cost_details:'1',cost_shop_id:10},session());assert.equal(detail.purchase_cost.details.rows[0].amount,12);assert.equal(detail.purchase_cost.details.rows[0].posting_number,'1-2-3');assert.equal(detail.purchase_cost.details.total,1);
 const exported=await db.service.export({company_id:1,month:'2026-05'},session()),zip=await JSZip.loadAsync(exported.buffer),book=new ExcelJS.Workbook();await book.xlsx.load(await Object.values(zip.files).find(f=>f.name.endsWith('00_公司汇总与明细.xlsx')).async('nodebuffer'));assert.equal(book.getWorksheet('采购成本匹配').getRow(2).getCell(7).value,12);assert.equal(db.docs[0].parse_status,'preview');
});


test('large original JSON is not filesorted in MySQL and document order remains month then id',async()=>{
 const db=database({failJsonSort:true});const padding='x'.repeat(1024*1024);
 for(const [id,month]of[[3,'2026-05'],[2,'2026-04'],[1,'2026-04']])db.docs.push({id,tenant_id:1,company_id:1,shop_key:10,month_key:month,original_name:id+'.json',parse_status:'preview',payload_json:JSON.stringify({kind:'support',facts:[],padding})});
 const r=await db.service.report({company_id:1,from:'2026-01',to:'2026-12'},session());assert.deepEqual(r.documents.map(d=>d.id),[1,2,3]);assert.equal(r.documents.every(d=>d.payload_json.padding.length===1024*1024),true);
});

test('company cash previews without a month and deduplicates overlapping exports by transaction date and number',async()=>{
 const db=database(),s=session();
 const header=['创建日期','交易单号','币种','金额','状态'];
 const a=['2026-03-20 10:00','entry-a','CNH','25.00','成功'];
 const b=['2026-05-01 10:00','entry-b','CNH','50.00','成功'];
 const input={company_id:1,shop_id:0,upload_type:'collection-cash'};
 for(const [i,rows] of [[1,[a,b]],[2,[a]]]){
  const url='/cash-'+i;
  db.files.set(url,{tenant:1,row:{original_name:'entry.xlsx'},buffer:await workbook([null,[null,'连连跨境支付入账记录查询'],[null,'名称：[Company 1]'],[null,...header],...rows.map(r=>[null,...r])])});
  const {document}=await db.service.preview({...input,attachment_url:url},s);
  assert.equal(document.month_key,i===1?'2026-05':'2026-03');
  assert.equal(document.payload_json.transaction_period.from,'2026-03-20');
  await db.service.confirm({company_id:1,document_id:document.id},s);
  assert.equal((await db.service.preview({...input,attachment_url:url},s)).duplicate,true);
 }
 const march=reconcileImportedCash(db.docs,{from:'2026-03',to:'2026-03'});
 assert.equal(march.currencies[0].entries,25);
 assert.equal(march.duplicates.length,1);
 assert.equal(march.currencies[0].withdrawals,null);
});

test('Shanghai original exports complete company preview and confirmation without a month',{skip:!process.env.LIANLIAN_TEST_ORIGINALS},async()=>{
 // Use the existing in-memory service fixture with an injected company name.
 const fixture=database({companyName:'上海汇境通国际贸易有限公司'});
 const originals=JSON.parse(process.env.LIANLIAN_TEST_ORIGINALS);
 for(const [i,path] of originals.entries()){
  const url='/original-'+i;
  fixture.files.set(url,{tenant:1,row:{original_name:path.split('/').at(-1)},buffer:readFileSync(path)});
  const input={company_id:1,shop_id:0,upload_type:'collection-cash',attachment_url:url};
  const {document}=await fixture.service.preview(input,session());
  assert.equal(document.payload_json.cash.length,[36,17][i]);
  await fixture.service.confirm({company_id:1,document_id:document.id},session());
  assert.equal((await fixture.service.preview(input,session())).duplicate,true);
 }
 const {currencies,rows}=reconcileImportedCash(fixture.docs,{from:'2026-01',to:'2026-11'});
 assert.deepEqual(currencies,[{currency:'CNH',complete:true,entries:575165.32,withdrawals:575165.32,fees:6638}]);
 assert.equal(Math.round(rows.reduce((a,r)=>a+(r.listed_bank_amount||0),0)*100),56852732);
});

test('payout attribution uses the collection month and rejects competing payment evidence',()=>{
 const wrap=(id,shop_key,cash)=>({id,shop_key,parse_status:'confirmed',payload_json:{cash}});
 const entry={type:'entry',reference:'12345678901234567890',date:'2026-11-01 00:01',currency:'CNH',amount:100};
 const payment={type:'platform-payment',date:'2026-10-31',currency:'CNY',amount:100,source:'第3行'};
 const docs=[wrap(1,0,[entry]),wrap(2,10,[payment]),wrap(3,0,[entry])];
 const month={from:'2026-11',to:'2026-11'};
 const candidates=reconcileImportedCash(docs,month);
 assert.equal(candidates.matches[0].status,'amount_date_candidate');
 assert.equal(candidates.currencies[0].entries,100);
 assert.deepEqual(candidates.shop_entries,[{month:'2026-11',shop_id:null,currency:'CNH',count:1,amount:100}]);
 const overlapping=[...docs,wrap(4,11,[payment])];
 const ambiguous=reconcileImportedCash(overlapping,{from:'2026-10',to:'2026-11'});
 assert.deepEqual(ambiguous.matches.map(m=>m.status),['ambiguous','ambiguous']);
 const saved={entry_reference:entry.reference,payment_document_id:2,payment_source:payment.source,shop_id:10};
 const confirmed=reconcileImportedCash(overlapping,month,[saved]);
 assert.deepEqual(confirmed.matches.map(m=>m.status),['confirmed']);
 assert.deepEqual(confirmed.shop_entries,[{month:'2026-11',shop_id:10,currency:'CNH',count:1,amount:100}]);
 const conflicting=[...docs,wrap(5,0,[{...entry,amount:110}])];
 assert.equal(reconcileImportedCash(conflicting,month,[saved]).shop_entries[0].shop_id,null);
});
