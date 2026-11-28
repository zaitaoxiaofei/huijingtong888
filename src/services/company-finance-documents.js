import { PAYOUT_ATTRIBUTION_SCHEMA, matchFinancePayouts, payoutEvidenceKey, summarizePayoutAttributions } from './finance-payout-attribution.js';
import {approvedH1Report} from './billing-approved-h1.js';
import {readCompanyPurchaseCosts,summarizePurchaseCostLines} from './company-purchase-costs.js';
import {financeDocumentLocation,normalizeFinanceSourceLocation} from '../shared/finance-document-locations.js';
import { recordedExpenseLines } from './finance-recorded-expenses.js';

import { paidPayrollAccruals } from "./finance-payroll-accruals.js";
import crypto from 'node:crypto';
import { validateArchiveSource } from './finance-archive-source.js';
import { createFinanceReconciliation } from './finance-reconciliation.js';
import { deduplicateFinanceCash } from './finance-cash-dedup.js';
import { parseOrderSalesJson } from './finance-order-sales.js';
import { FINANCE_FILE_CATEGORIES, financeDocumentCategories } from '../shared/finance-document-categories.js';
import { UPLOAD_TYPES, MANUAL_EXPENSE_METRICS, financeMatrix } from '../shared/company-finance-report.js';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { authorizeBusinessTaskSession, assertBusinessTaskPermission } from './business-task-tenant.js';
import { parseFinanceDocument, validateMonth, rounded } from './finance-document-parser.js';

export const FINANCE_DOCUMENT_SCHEMA=`CREATE TABLE IF NOT EXISTS finance_import_documents (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 tenant_id BIGINT UNSIGNED NOT NULL, company_id BIGINT UNSIGNED NOT NULL,
 shop_key BIGINT UNSIGNED NOT NULL DEFAULT 0, month_key CHAR(7) NOT NULL,
 attachment_url VARCHAR(600) NOT NULL, original_name VARCHAR(255) NOT NULL,
 sha256 CHAR(64) NOT NULL, business_key CHAR(64) NULL,
 parse_status VARCHAR(24) NOT NULL, payload_json JSON NOT NULL,
 review_status VARCHAR(24) NOT NULL DEFAULT 'pending', review_note VARCHAR(1000) NULL, revision INT UNSIGNED NOT NULL DEFAULT 0,
 created_by BIGINT UNSIGNED NOT NULL, confirmed_by BIGINT UNSIGNED NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, confirmed_at DATETIME NULL,
 UNIQUE KEY uk_finance_import_hash (tenant_id,company_id,shop_key,sha256),
 UNIQUE KEY uk_finance_import_business (tenant_id,company_id,shop_key,business_key),
 KEY idx_finance_import_month (tenant_id,company_id,month_key,parse_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;
const fail=(message,statusCode=400)=>{throw Object.assign(new Error(message),{statusCode});};
const id=(value,label)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)fail(`请先选择${label}（${({公司:'company_id',店铺:'shop_id',企业:'tenant_id',单据:'document_id'})[label]||'id'}），在公司设置中补齐归属后重试`);return n;};
const payload=row=>typeof row.payload_json==='string'?JSON.parse(row.payload_json):row.payload_json;
function range(input){
 const from=validateMonth(input.from||input.month),to=validateMonth(input.to||input.month||from);
 if(to<from||Number(to.slice(0,4))-Number(from.slice(0,4))>1)fail('请选择有效月度、季度或年度范围（from/to）');
 return {from,to};
}
const safeName=value=>String(value).replace(/[/\\\x00-\x1f:*?"<>|]/g,'_').replace(/^\.+/,'_').slice(0,180)||'未命名';
const neutral=value=>typeof value==='string'&&/^[=+\-@\t\r]/.test(value)?`'${value}`:value;
const mysqlQuery=async(...args)=>(await import('../mysql-pool.js')).mysqlQuery(...args);
const mysqlExecute=async(...args)=>(await import('../mysql-pool.js')).mysqlExecute(...args);
const mysqlTransaction=async worker=>(await import('../mysql-pool.js')).withMysqlTransaction(async connection=>worker({query:async(...args)=>(await connection.execute(...args))[0],execute:async(...args)=>(await connection.execute(...args))[0]}));
const tenantPrivateFiles={owned:async(...args)=>(await import('./tenant-private-files.js')).tenantPrivateFiles.owned(...args),read:async(...args)=>(await import('./tenant-private-files.js')).tenantPrivateFiles.read(...args)};
export function summarizeImportedDocuments(documents,period=null,{includePreview=false}={}){
 const metrics={};const lines=[];const cash=[];
 for(const doc of documents){
  if(doc.parse_status!=='confirmed'&&!(includePreview&&doc.parse_status==='preview'))continue;
  const p=payload(doc);
  for(const [i,line]of (p.facts||[]).entries()){
   if(period&&(doc.month_key<period.from||doc.month_key>period.to))continue;
   if(line.currency!=='CNY')continue;
   metrics[line.metric]=rounded((metrics[line.metric]||0)+line.amount);
   lines.push({...line,document_id:doc.id,line_index:i,shop_id:doc.shop_key,month:doc.month_key,parse_status:doc.parse_status,review_status:doc.review_status,display_name:p.display_name||doc.original_name,original_name:doc.original_name,attachment_url:doc.attachment_url,source_location:financeDocumentLocation(doc)});
  }
  for(const item of doc.parse_status==='confirmed'?(p.cash||[]):[])cash.push({...item,document_id:doc.id,shop_id:doc.shop_key,original_name:doc.original_name,attachment_url:doc.attachment_url});
 }
 const dedup=deduplicateFinanceCash(cash);return {metrics,lines,cash:dedup.cash,cash_duplicates:dedup.duplicates,cash_conflicts:dedup.conflicts};
}
export function reconcileImportedCash(documents,{from,to},attributions=[]){
 const summary=summarizeImportedDocuments(documents),cash=summary.cash;
 const inPeriod=r=>String(r.date).slice(0,7)>=from&&String(r.date).slice(0,7)<=to;
 const cash_duplicates=summary.cash_duplicates.filter(c=>c.sources.some(inPeriod)),cash_conflicts=summary.cash_conflicts.filter(c=>c.sources.some(inPeriod));
 const rows=cash.filter(r=>['entry','withdrawal'].includes(r.type)&&String(r.date).slice(0,7)>=from&&String(r.date).slice(0,7)<=to);
 const currencies=[...new Set(rows.map(r=>r.currency))];
 const allPayments=cash.filter(r=>r.type==='platform-payment');
 const payments=allPayments.filter(inPeriod);
 const conflictEntries=new Set(summary.cash_conflicts.filter(c=>c.sources.some(s=>s.type==='entry')).map(c=>c.reference));
 const entries=cash.filter(r=>r.type==='entry'&&!Number(r.shop_id)&&!conflictEntries.has(r.reference));
 const allMatches=matchFinancePayouts(allPayments,entries,attributions);
 const matches=allMatches.filter(row=>inPeriod(row.entry||row.payment));
 const shopEntries=summarizePayoutAttributions(rows,allMatches);
 const monthly=[];
 for(const month of [...new Set(rows.map(row=>row.date.slice(0,7)))].sort()){
  const events=rows.filter(row=>row.date.startsWith(month));
  for(const currency of new Set(events.map(row=>row.currency))){
   const incoming=events.filter(row=>row.type==='entry'&&row.currency===currency);
   const outgoing=events.filter(row=>row.type==='withdrawal'&&row.currency===currency);
   const sum=(list,field)=>list.length&&list.every(row=>row[field]!=null)?rounded(list.reduce((n,row)=>n+row[field],0)):null;
   const conflicted=cash_conflicts.some(c=>c.sources.some(row=>row.currency===currency&&row.date.startsWith(month)));
   monthly.push({month,currency,entry_count:incoming.length,withdrawal_count:outgoing.length,
    entries:conflicted?null:sum(incoming,'amount'),withdrawals:conflicted?null:sum(outgoing,'amount'),fees:conflicted?null:sum(outgoing,'fee'),
    listed_arrivals:[...new Set(outgoing.map(row=>row.listed_bank_currency).filter(Boolean))].map(bankCurrency=>({currency:bankCurrency,amount:conflicted?null:sum(outgoing.filter(row=>row.listed_bank_currency===bankCurrency),'listed_bank_amount')}))});
  }
 }
 const shopPayments=[];
 for(const shopId of new Set(payments.map(row=>Number(row.shop_id)).filter(Boolean))){
  const own=allMatches.filter(row=>Number(row.payment.shop_id)===shopId&&inPeriod(row.payment));
  for(const currency of new Set(own.map(row=>row.payment.currency))){
   const selected=own.filter(row=>row.payment.currency===currency);
   shopPayments.push({shop_id:shopId,currency,payment_count:selected.length,amount:rounded(selected.reduce((n,row)=>n+row.payment.amount,0)),candidate_count:selected.filter(row=>row.entry).length});
  }
 }
 return {monthly,shop_entries:shopEntries,shop_payments:shopPayments,matches,duplicates:cash_duplicates,conflicts:cash_conflicts,currencies:currencies.map(currency=>{
  const selected=rows.filter(r=>r.currency===currency),entries=selected.filter(r=>r.type==='entry'),withdrawals=selected.filter(r=>r.type==='withdrawal');
  const conflict=cash_conflicts.some(c=>c.sources.some(s=>s.currency===currency));
  const unknownFees=withdrawals.some(r=>r.fee==null);
  return {currency,complete:!conflict&&entries.length>0&&withdrawals.length>0&&!unknownFees,entries:conflict||!entries.length?null:rounded(entries.reduce((s,r)=>s+r.amount,0)),withdrawals:conflict||!withdrawals.length?null:rounded(withdrawals.reduce((s,r)=>s+r.amount,0)),fees:conflict||unknownFees||!withdrawals.length?null:rounded(withdrawals.reduce((s,r)=>s+(r.fee||0),0))};
 }),rows,bank_status:'missing',note:'收款与提现分别列示，不用差额认定损失；尚需平台转出匹配、期初期末余额及银行回单。'};
}
export function createCompanyFinanceDocuments({query=mysqlQuery,execute=mysqlExecute,files=tenantPrivateFiles,authorize=authorizeBusinessTaskSession,parse=parseFinanceDocument,transaction=mysqlTransaction,validateSource=validateArchiveSource,readPurchaseCosts=readCompanyPurchaseCosts,readMonthlyRealization=async(shop,options)=>(await import('../ozonClient.js')).fetchOzonMonthlyRealization(shop,options)}={}){
 let schema;
 async function ready(){if(!schema)schema=execute(FINANCE_DOCUMENT_SCHEMA).then(()=>execute(PAYOUT_ATTRIBUTION_SCHEMA)).catch(e=>{schema=null;throw e;});await schema;}
 async function actor(session){const s=await authorize(session);assertBusinessTaskPermission(s,'finance');return s;}
 async function company(input,session){
  const s=await actor(session),companyId=id(input.company_id,'公司'),tenantId=id(s.tenant.id,'企业');
  const [c]=await query(`SELECT id,name,tax_number FROM finance_companies WHERE id=? AND status!='deleted' AND (tenant_id=? OR (?=1 AND tenant_id IS NULL))`,[companyId,tenantId,s.tenant.slug==='default'?1:0]);
  if(!c)fail('公司不存在或不属于当前企业',404);return {s,c,tenantId,companyId};
 }
 async function shopsFor(ctx,period){return query(`SELECT DISTINCT s.id,s.name FROM finance_shop_company_assignments a JOIN shops s ON s.id=a.shop_id
 WHERE a.company_id=? AND (a.tenant_id=? OR (?=1 AND a.tenant_id IS NULL))
 AND (s.tenant_id=? OR (?=1 AND s.tenant_id IS NULL)) AND s.status!='deleted'
 AND a.effective_from<=LAST_DAY(CONCAT(?,'-01')) AND (a.effective_to IS NULL OR a.effective_to>=CONCAT(?,'-01'))`,[ctx.companyId,ctx.tenantId,ctx.s.tenant.slug==='default'?1:0,ctx.tenantId,ctx.s.tenant.slug==='default'?1:0,period.to,period.from]);}
 async function getDocs(ctx,period,reader=query,lock=false){
  await ready();
  // Shared cash files can contain multiple months. Keep once and filter events by their own dates.
  const rows=await reader(`SELECT * FROM finance_import_documents WHERE tenant_id=? AND company_id=? AND ((month_key>=? AND month_key<=?) OR (shop_key=0 AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.kind'))='collection-cash') OR JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.kind'))='platform-payments')${lock?' FOR SHARE':''}`,[ctx.tenantId,ctx.companyId,period.from,period.to]);
  // Sorting full JSON payloads in MySQL can exhaust sort_buffer_size after source archival.
  return rows.sort((a,b)=>String(a.month_key).localeCompare(String(b.month_key))||Number(a.id)-Number(b.id));
 }
 async function payoutAttributions(ctx,reader=query){
  return reader('SELECT entry_reference,payment_document_id,payment_source,shop_id FROM finance_payout_attributions WHERE tenant_id=? AND company_id=?',[ctx.tenantId,ctx.companyId]);
 }
 async function locked(ctx,month){
  const closed=await query(`SELECT id FROM finance_periods WHERE company_id=? AND month_key=? AND status='closed' AND (tenant_id=? OR (?=1 AND tenant_id IS NULL))`,[ctx.companyId,month,ctx.tenantId,ctx.s.tenant.slug==='default'?1:0]);
  if(closed.length)fail(`公司${month}已关账，请先由会计按既有流程处理关账状态`,409);
 }
 async function writePeriod(ctx,month,worker){
  return transaction(async db=>{
   // Reserve the existing company/month key. Closing uses the same period row,
   // so close and confirmation cannot pass each other between check and write.
   for(const key of [...new Set([month,...(ctx.cashMonths||[])])].sort()){
   await db.execute("INSERT IGNORE INTO finance_periods(tenant_id,company_id,month_key,status) VALUES(?,?,?,'preparing')",[ctx.s.tenant.slug==='default'?null:ctx.tenantId,ctx.companyId,key]);
   const [period]=await db.query('SELECT status FROM finance_periods WHERE company_id=? AND month_key=? FOR UPDATE',[ctx.companyId,key]);
   if(period?.status==='closed')fail(`公司${key}已关账，请先由会计按既有流程处理关账状态`,409);
   }
   if(ctx.archiveInput)await validateSource(ctx.archiveInput,ctx,ctx.archiveHash);
   return worker(db);
  });
 }
 const reconciler=createFinanceReconciliation({query,execute,getDocs,shopsFor,writePeriod});
 return {
  async orderSalesSource(input,session){
   const month=validateMonth(input.month),shopId=id(input.shop_id,'店铺');let initial;
   const guard=async()=>{
    const ctx=await company(input,session);const shops=await shopsFor(ctx,{from:month,to:month});
    if(!shops.some(s=>Number(s.id)===shopId))fail('所选店铺在该月不属于当前公司',403);
    const [shop]=await query("SELECT * FROM shops WHERE id=? AND status='active' AND (tenant_id=? OR (?=1 AND tenant_id IS NULL))",[shopId,ctx.tenantId,Number(ctx.s.tenant.slug==='default')]);
    if(!shop||shop.platform&&shop.platform!=='ozon')fail('请选择本公司已启用的Ozon店铺',403);
    const key=String(shop.ozon_api_key||shop.api_key||shop.api_key_hint||'');if(!key||key.startsWith('demo')||!shop.ozon_client_id)fail('店铺缺少Ozon API授权，请在公司与店铺设置中补齐Client-Id和API Key');
    if(initial&&(initial.client!==String(shop.ozon_client_id)||initial.key!==key))fail('店铺授权已变化，请重新读取',409);
    initial||={client:String(shop.ozon_client_id),key};return {shop,ctx};
   };
   const {shop}=await guard();
   const data=await readMonthlyRealization(shop,{year:Number(month.slice(0,4)),month:Number(month.slice(5)),beforeRequest:async()=>(await guard()).shop});
   const {ctx}=await guard();const bytes=Buffer.from(JSON.stringify(data));if(bytes.length>20*1024*1024)fail('官方逐单报告超过20MB，请联系管理员拆分读取');
   const parsed=parseOrderSalesJson(bytes,{month});if(!ctx.c.tax_number||parsed.buyer_tax_number!==ctx.c.tax_number)fail('官方报告税号与公司不符或公司税号未配置，请核对公司设置',409);
   return {data,filename:`Ozon_order_sales_${parsed.document_number}_${month}.json`,source:'Ozon /v1/finance/realization/posting',note:'仅仅读取官方原件，尚未上传、确认或调整账簿'};
  },
  async adjustments(input,session){const ctx=await company(input,session),period=range(input);return approvedH1Report(query,{tenantId:ctx.tenantId,companyId:ctx.companyId,...period,shopId:input.shop_id},input);},
  async reconcile(input,session){return reconciler.report(input,await company(input,session));},
  async calibrationPreview(input,session){return reconciler.preview(input,await company(input,session));},
  async calibrationConfirm(input,session){return reconciler.confirm(input,await company(input,session));},
  async lookup(input,session){
   const ctx=await company(input,session);validateMonth(input.month);
   if(!input.archive_source)fail('请从插件检查月份后同步原件');
   await validateSource(input,ctx);await ready();
   const rows=await query('SELECT * FROM finance_import_documents WHERE tenant_id=? AND company_id=? AND shop_key=? AND sha256=?',[ctx.tenantId,ctx.companyId,Number(input.shop_id),input.archive_source.sha256]);
   const doc=rows[0];return {document:doc?{id:doc.id,month_key:doc.month_key,parse_status:doc.parse_status,attachment_url:doc.attachment_url,payload_json:payload(doc)}:null,duplicate:Boolean(doc)};
  },
  async preview(input,session){
   const ctx=await company(input,session),shop=Number(input.shop_id||0);
   const uploadType=String(input.upload_type||'auto'),crossMonthCash=uploadType==='collection-cash'&&!input.month;
   let month=crossMonthCash?undefined:validateMonth(input.month);
   if(crossMonthCash&&(shop||input.related_document_id||input.archive_source))fail('连连跨月流水请选择公司共用并上传独立原件');
   if(!Number.isSafeInteger(shop)||shop<0)fail('店铺shop_id无效，请重新选择店铺或公司共用');
   if(shop&&!(await shopsFor(ctx,{from:month,to:month})).some(s=>Number(s.id)===shop))fail('所选店铺在该月不属于当前公司，请先检查公司与店铺归属',403);
   if(month)await locked(ctx,month);await ready();
   await files.owned(input.attachment_url,ctx.s,'finance');const file=await files.read(input.attachment_url,ctx.s);
   const source=await validateSource(input,ctx,crypto.createHash('sha256').update(file.buffer).digest('hex'));
   if(source){ctx.archiveInput=input;ctx.archiveHash=source.sha256;}
   const type=UPLOAD_TYPES.find(t=>t.value===uploadType);
   if(!type)fail('请选择有效上传类型（upload_type），再选择对应原件');
   if(type.shop&&!shop)fail('此类平台文件必须选择实际店铺（shop_id），不能归公司共用');
   if(type.shared&&shop)fail('连连流水请选择公司共用（shop_id=0），避免多个店铺重复入账');
   const sourceLocation=normalizeFinanceSourceLocation(input.source_location);
   const displayName=String(input.display_name||'').trim();if(displayName.length>180)fail('中文显示名称（display_name）不能超过180字');
   let linked=null;
   if(input.related_document_id){
    [linked]=await query('SELECT * FROM finance_import_documents WHERE id=? AND tenant_id=? AND company_id=?',[id(input.related_document_id,'单据'),ctx.tenantId,ctx.companyId]);
    if(linked&&linked.month_key!==month)fail('配套凭证请归档到原业务月份（month），开票日期可不同；请先修改上传业务月份');
    if(!linked||linked.parse_status!=='confirmed'||Number(linked.shop_key)!==shop)fail('关联单据必须是本公司、同一店铺或公司共用下的已确认业务，请重新选择');
    if(!['support','payroll'].includes(uploadType))fail('只有配套凭证可以关联已有业务，不能再次录入费用');
   }
   let p,status='preview';
   try{
    if(['support','payroll','manual-expense'].includes(uploadType)){
     p={kind:uploadType,month,facts:[],cash:[],controls:[],warnings:['人工分类的配套资料，未自动认定税前扣除资格']};
     if(uploadType==='manual-expense'){
      const m=input.manual||{},amount=Number(m.amount),note=String(m.note||'').trim();
      if(!MANUAL_EXPENSE_METRICS.includes(m.metric)||m.currency!=='CNY'||!Number.isFinite(amount)||amount===0||Math.abs(amount)>1e9||(amount<0&&m.metric!=='汇兑损益')||Math.abs(amount-rounded(amount))>0.000001)fail('请填写手工费用项目、CNY金额（最多两位小数；仅汇兑损益可为负）');
      if(!note||note.length>1000)fail('请填写费用用途及业务依据（manual.note，1—1000字），并附账单或付款记录');
      p.manual={metric:m.metric,amount,currency:'CNY',note};
      p.facts=[{metric:m.metric,amount,currency:'CNY',source:`人工录入，待会计核对：${note}`}];
      p.warnings.push('仅记录本次业务一次；后补发票选择“仅归档”并关联本单。采购支出、设备购置、预付押金不直接算费用。');
     }
    }else{
     p=await parse(file.buffer,file.row.original_name,{month,crossMonthCash});
     if(crossMonthCash)month=validateMonth(p.month);
     if(type.kinds&&!type.kinds.includes(p.kind))fail('所选上传类型与文件正文不匹配，请按预览结果重新选择类型；不按文件名猜测金额');
    }
    if(p.kind==='order-sales'&&!ctx.c.tax_number)fail('公司税号尚未配置，请在公司与店铺设置中补齐后上传逐单销售凭证');
    if(p.kind==='collection-cash'&&String(p.account_company_name||'').replace(/\s/g,'')!==String(ctx.c.name||'').replace(/\s/g,''))fail('连连导出抬头与所选公司名称不一致，请选择正确营业主体或核对公司设置');
    if(p.kind==='collection-cash'&&shop)fail('连连流水属于公司共用账户，请选择“公司共用”上传，避免三店重复导入');
    if((p.facts.length||p.kind==='order-sales')&&!shop&&uploadType!=='manual-expense')fail('平台销售与费用需要明确店铺（shop_id），请选择实际店铺后重试');
    if(p.buyer_tax_number&&ctx.c.tax_number&&p.buyer_tax_number!==ctx.c.tax_number)fail('文件购买方税号与所选公司不符，请核对公司主体');
   }catch(e){if(crossMonthCash)throw e;status='error';p={facts:[],cash:[],controls:[],warnings:[e.message],kind:'unparsed',month};}
   if(crossMonthCash)ctx.cashMonths=p.cash.map(row=>row.date.slice(0,7));
   if(source)p.archive_source=source;
   if(sourceLocation)p.source_location=sourceLocation;
   p.upload_type=uploadType;p.display_name=displayName;p.related_document_id=linked?.id||null;
   const hash=crypto.createHash('sha256').update(file.buffer).digest('hex');
   const existing=await query(`SELECT * FROM finance_import_documents WHERE tenant_id=? AND company_id=? AND shop_key=? AND (sha256=? OR (business_key IS NOT NULL AND business_key=?))`,[ctx.tenantId,ctx.companyId,shop,hash,p.business_key||null]);
   if(existing.length){
    const old=existing[0],previous=payload(old),changed=JSON.stringify(previous.facts)!==JSON.stringify(p.facts);
    if(old.sha256===hash&&previous.kind==='support'&&!(previous.facts||[]).length&&!(previous.cash||[]).length&&status==='preview'&&['collection-cash','order-sales'].includes(p.kind)&&uploadType===p.kind){
     // An original previously archived only as supporting evidence can be activated
     // through a new explicit preview/confirmation; its old classification remains audited.
     if(p.kind==='order-sales'&&old.month_key!==month)fail(`逐单原件已在${old.month_key}归档，与正文${month}不符，请先核对原归档记录，不能直接移动已确认凭证`,409);
     const revision=Number(old.revision||0);p.month=old.month_key;
     p.classification_history=[...(previous.classification_history||[]),{payload:previous,review_status:old.review_status,review_note:old.review_note,person_id:ctx.s.personId,at:new Date().toISOString()}];
     p.review_history=[...(previous.review_history||[])];
     if(old.review_status!=='pending')p.review_history.push({person_id:ctx.s.personId,status:'pending',note:'配套原件重新解析，须重新审核',at:new Date().toISOString()});
     const saved=await writePeriod(ctx,old.month_key,db=>db.execute("UPDATE finance_import_documents SET parse_status='preview',payload_json=?,business_key=?,review_status='pending',review_note=NULL,revision=revision+1 WHERE id=? AND tenant_id=? AND company_id=? AND revision=?",[JSON.stringify(p),p.business_key||null,old.id,ctx.tenantId,ctx.companyId,revision]));
     if(!saved.affectedRows)fail('原件已被修改，请刷新后重新预览',409);
     return {document:{...old,parse_status:'preview',payload_json:p,review_status:'pending',review_note:null,revision:revision+1},duplicate:true,reclassified:true};
    }
    if(uploadType==='manual-expense'&&input.expected_revision!=null&&status==='error')fail(p.warnings[0]);
    if(uploadType==='manual-expense'&&old.parse_status==='preview'&&previous.kind==='manual-expense'&&status==='preview'&&changed){
     if(input.expected_revision==null||Number(input.expected_revision)!==Number(old.revision||0))fail('手工费用草稿已存在或已被修改，请刷新并在“预览”中修改草稿，不要重新录一笔',409);
     if(old.month_key!==month)fail('手工费用草稿只能在原业务月份修改，请先核对月份');
     const revision=Number(old.revision||0);
     p.preview_history=[...(previous.preview_history||[]),{manual:previous.manual,facts:previous.facts,person_id:ctx.s.personId,at:new Date().toISOString()}];
     p.review_history=[...(previous.review_history||[])];
     if(old.review_status!=='pending')p.review_history.push({person_id:ctx.s.personId,status:'pending',note:'手工草稿已修改，原审核失效，请重新审核',at:new Date().toISOString()});
     const saved=await writePeriod(ctx,month,db=>db.execute("UPDATE finance_import_documents SET payload_json=?,review_status='pending',review_note=NULL,revision=revision+1 WHERE id=? AND tenant_id=? AND company_id=? AND parse_status='preview' AND revision=?",[JSON.stringify(p),old.id,ctx.tenantId,ctx.companyId,revision]));
     if(!saved.affectedRows)fail('草稿已被其他人修改或确认，请刷新后重试',409);
     return {document:{...old,payload_json:p,review_status:'pending',review_note:null,revision:revision+1},duplicate:true};
    }
    if(uploadType==='manual-expense'&&existing[0].parse_status!=='error'&&JSON.stringify(payload(existing[0]).facts)!==JSON.stringify(p.facts))fail('此原件已有不同的记账内容，请先核对已有记录，不能用同一原件重复录入或改写金额',409);
    if(existing[0].sha256!==hash&&!(p.kind==='order-sales'&&previous.kind==='order-sales'&&p.order_fingerprint===previous.order_fingerprint))fail('同编号业务已有不同内容原件，请人工核对并保留更正依据，不能重复累计',409);
    if(existing[0].parse_status==='error'&&status==='preview'){
     const old=existing[0],previous=payload(old),revision=Number(old.revision||0);
     if(!p.archive_source&&previous.archive_source)p.archive_source=previous.archive_source;
     if(!p.source_location&&previous.source_location)p.source_location=previous.source_location;
     p.previous_errors=[...(previous.previous_errors||[]),...(previous.warnings||[])];p.review_history=[...(previous.review_history||[])];
     if(old.review_status!=='pending')p.review_history.push({person_id:ctx.s.personId,status:'pending',note:'原件重新解析，须重新审核',at:new Date().toISOString()});
     const saved=await writePeriod(ctx,month,db=>db.execute("UPDATE finance_import_documents SET month_key=?,business_key=?,parse_status='preview',payload_json=?,review_status='pending',review_note=NULL,revision=revision+1 WHERE id=? AND tenant_id=? AND company_id=? AND parse_status='error' AND revision=?",[month,p.business_key||null,JSON.stringify(p),old.id,ctx.tenantId,ctx.companyId,revision]));
     if(!saved.affectedRows)fail('原件已被其他人重新解析或审核，请刷新后重试',409);
     return {document:{...old,month_key:month,parse_status:'preview',payload_json:p,review_status:'pending',review_note:null,revision:revision+1},duplicate:true};
    }
    return {document:{...existing[0],payload_json:payload(existing[0])},duplicate:true};}
   try{
    const saved=await writePeriod(ctx,month,db=>db.execute(`INSERT INTO finance_import_documents (tenant_id,company_id,shop_key,month_key,attachment_url,original_name,sha256,business_key,parse_status,payload_json,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[ctx.tenantId,ctx.companyId,shop,month,input.attachment_url,file.row.original_name,hash,p.business_key||null,status,JSON.stringify(p),ctx.s.personId]));
    return {document:{id:saved.insertId,shop_key:shop,month_key:month,original_name:file.row.original_name,attachment_url:input.attachment_url,parse_status:status,payload_json:p,review_status:'pending'},duplicate:false};
   }catch(e){if(e.code==='ER_DUP_ENTRY')fail('同一文件或业务正在导入，请刷新列表查看，不要再次确认',409);throw e;}
  },
  async confirm(input,session){
   const ctx=await company(input,session);await ready();
   const [doc]=await query('SELECT * FROM finance_import_documents WHERE id=? AND tenant_id=? AND company_id=?',[id(input.document_id,'单据'),ctx.tenantId,ctx.companyId]);
   if(!doc)fail('单据不存在或不属于当前公司',404);await locked(ctx,doc.month_key);
   if(doc.parse_status==='error')fail('文件解析失败或归属/期间不符，请按预览提示补正后重新上传');
   const cash=payload(doc);
   if(cash.kind==='collection-cash'&&cash.transaction_period)ctx.cashMonths=cash.cash.map(row=>row.date.slice(0,7));
   const revision=Number(doc.revision||0);
   if(payload(doc).kind==='manual-expense'&&Number(input.expected_revision||0)!==revision)fail('手工费用草稿已经修改，请刷新、重新预览后再确认',409);
   const saved=await writePeriod(ctx,doc.month_key,db=>db.execute("UPDATE finance_import_documents SET parse_status='confirmed',confirmed_by=?,confirmed_at=UTC_TIMESTAMP() WHERE id=? AND tenant_id=? AND company_id=? AND parse_status='preview' AND revision=?",[ctx.s.personId,doc.id,ctx.tenantId,ctx.companyId,revision]));
   if(!saved.affectedRows&&doc.parse_status==='preview')fail('单据已被修改或确认，请刷新后重新检查',409);return {ok:true};
  },
  async confirmPayouts(input,session){
   const ctx=await company(input,session),period=range(input);
   if(!Array.isArray(input.matches)||!input.matches.length||input.matches.length>500)fail('请选择 1 至 500 笔回款');
   const requested=new Map();
   for(const row of input.matches){
    const reference=row?.entry_reference,source=row?.payment_source;
    if(typeof reference!=='string'||!reference||reference.length>191||typeof source!=='string'||!source||source.length>80||requested.has(reference))fail('回款交易号或付款凭证明细无效或重复');
    requested.set(reference,payoutEvidenceKey({document_id:id(row.payment_document_id,'单据'),source}));
   }
   await ready();
   return transaction(async db=>{
    await db.query('SELECT id FROM finance_companies WHERE id=? FOR UPDATE',[ctx.companyId]);
    const documents=await getDocs(ctx,period,db.query,true),saved=await payoutAttributions(ctx,db.query);
    const matches=reconcileImportedCash(documents,period,saved).matches;
    const eligible=new Map(matches.filter(m=>['confirmed','amount_date_candidate'].includes(m.status))
     .map(m=>[String(m.entry.reference),m]));
    const additions=[];
    for(const [reference,evidence] of requested){
     const match=eligible.get(reference);
     if(!match||payoutEvidenceKey(match.payment)!==evidence)fail('回款或付款凭证已变化，或匹配不唯一，请刷新后核对',409);
     if(match.status==='amount_date_candidate')additions.push([reference,match.payment]);
    }
    for(const [reference,payment] of additions){
     await db.execute(`INSERT INTO finance_payout_attributions
      (tenant_id,company_id,entry_reference,payment_document_id,payment_source,shop_id,confirmed_by,confirmed_at)
      VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP())`,[ctx.tenantId,ctx.companyId,reference,payment.document_id,payment.source,payment.shop_id,ctx.s.personId]);
    }
    return {confirmed:additions.length,already_confirmed:requested.size-additions.length};
   });
  },
  async review(input,session){
   const ctx=await company(input,session);const statuses=['pending','accepted','needs_info','adjustment'];
   if(!statuses.includes(input.review_status)||String(input.review_note||'').length>1000)fail('请选择凭证审核状态，并将意见限制在1000字内');
   if(input.review_status!=='pending'&&!String(input.review_note||'').trim())fail('请填写会计审核依据或补件要求（review_note），不能只修改审核状态');
   const [doc]=await query('SELECT * FROM finance_import_documents WHERE id=? AND tenant_id=? AND company_id=?',[id(input.document_id,'单据'),ctx.tenantId,ctx.companyId]);if(!doc)fail('单据不存在',404);await locked(ctx,doc.month_key);
   const p=payload(doc);p.review_history=[...(p.review_history||[]),{person_id:ctx.s.personId,status:input.review_status,note:String(input.review_note||''),at:new Date().toISOString()}];
   const saved=await writePeriod(ctx,doc.month_key,db=>db.execute("UPDATE finance_import_documents SET review_status=?,review_note=?,payload_json=?,revision=revision+1 WHERE id=? AND tenant_id=? AND company_id=? AND revision=?",[input.review_status,String(input.review_note||''),JSON.stringify(p),doc.id,ctx.tenantId,ctx.companyId,Number(doc.revision||0)]));
   if(!saved.affectedRows)fail('审核意见已被其他人修改，请刷新后再填写',409);return {ok:true};
  },
  async report(input,session,{costRowsForExport=false}={}){
   const ctx=await company(input,session),period=range(input);
   if(input.period_mode&&period.from.slice(0,4)!==period.to.slice(0,4))fail('期间分类报表请在同一年度内选择范围（from/to），跨年资料请分别导出');
   const documents=await getDocs(ctx,period),shops=await shopsFor(ctx,period),summary=summarizeImportedDocuments(documents,period);
   // Reuse registered expenses and paid payroll; evidence never adds a second monetary row.
   const registered=await (query===mysqlQuery?async operation=>(await import('../mysql-pool.js')).withMysqlReadSnapshot(operation,{interactive:true}):async operation=>operation(query))(async read=>{
   const booked=await read(`SELECT e.id,e.shop_id,e.category,e.voucher_status,e.amount_cny,e.description,DATE_FORMAT(e.expense_date,'%Y-%m') month_key,e.source_type,e.source_id,i.detail_json
     FROM finance_expenses e LEFT JOIN finance_submission_items i ON e.source_type='finance_submission' AND i.id=e.source_id AND i.tenant_id=? AND i.company_id=e.company_id
     WHERE e.company_id=? AND (e.tenant_id=? OR (?=1 AND (e.tenant_id IS NULL OR e.tenant_id=0)))
       AND e.expense_date>=? AND e.expense_date<=LAST_DAY(CONCAT(?,'-01')) ORDER BY e.expense_date,e.id`,[ctx.tenantId,ctx.companyId,ctx.tenantId,ctx.s.tenant.slug==='default'?1:0,period.from+'-01',period.to]);
   const salaryTo=new Date(Date.UTC(Number(period.to.slice(0,4)),Number(period.to.slice(5)),0)).toISOString().slice(0,10);
   const paidWages=await paidPayrollAccruals({tenantId:ctx.tenantId,legacy:ctx.s.tenant.slug==='default',companyId:ctx.companyId,from:period.from+'-01',to:salaryTo},read);
   return {salary:booked.filter(e=>e.category==='salary').concat(paidWages.map(row=>({...row,month_key:row.expense_date.slice(0,7)}))),operating:booked.filter(e=>e.category!=='salary')};
   });
   for(const expense of registered.salary){
     const detail=expense.detail_json?(typeof expense.detail_json==='string'?JSON.parse(expense.detail_json):expense.detail_json):null;
     const reconciled=detail&&Number.isFinite(Number(detail.base))&&Number.isFinite(Number(detail.employer))&&Math.abs(rounded(Number(detail.base)+Number(detail.employer))-Number(expense.amount_cny))<0.005;
     const contributions=detail?.employer_items,keys=['pension','medical','supplementary_medical','unemployment','injury','housing_fund'];
     const known=contributions&&keys.every(k=>typeof contributions[k]==='number'&&Number.isFinite(contributions[k])&&contributions[k]>=0)&&Math.abs(rounded(keys.reduce((n,k)=>n+contributions[k],0))-Number(detail.employer))<0.005;
     const parts=reconciled&&known?[['工资',Number(detail.base)],['公司承担社保',rounded(Number(detail.employer)-contributions.housing_fund)],['公司承担公积金',contributions.housing_fund]]:reconciled?[['工资',Number(detail.base)],['公司承担缴费',Number(detail.employer)]]:[['工资',Number(expense.amount_cny)]];
     for(const [metric,amount] of parts){
       const line={metric,amount,currency:'CNY',month:expense.month_key,shop_id:0,expense_id:expense.id,payroll_item_id:expense.source_type==='finance_submission'?expense.source_id:null,source_type:'payroll',source:expense.description+(expense.salary_recognition==='paid_pending'?'；已发放按归属月计成本，待归档，不重复计费':'；已审批入账，发放登记不重复计费'),display_name:'工资管理 · '+expense.description,original_name:'工资费用记录',review_status:'pending',linked_evidence:[]};
       summary.lines.push(line);summary.metrics[metric]=rounded((summary.metrics[metric]||0)+amount);
     }
   }
   const vouchers=registered.operating.length?await query(`SELECT v.id,v.expense_id,v.voucher_number,v.review_status,CASE WHEN pf.id IS NOT NULL THEN v.attachment_url ELSE NULL END attachment_url
    FROM finance_vouchers v JOIN finance_expenses e ON e.id=v.expense_id AND e.company_id=v.company_id
    LEFT JOIN tenant_private_files pf ON pf.storage_name=SUBSTRING_INDEX(v.attachment_url,'/',-1) AND pf.tenant_id=? AND pf.purpose='finance'
    WHERE e.company_id=? AND e.category!='salary' AND (e.tenant_id=? OR (?=1 AND (e.tenant_id IS NULL OR e.tenant_id=0)))
    AND (v.tenant_id=? OR (?=1 AND (v.tenant_id IS NULL OR v.tenant_id=0)))
    AND e.expense_date>=? AND e.expense_date<=LAST_DAY(CONCAT(?,'-01'))`,[ctx.tenantId,ctx.companyId,ctx.tenantId,ctx.s.tenant.slug==='default'?1:0,ctx.tenantId,ctx.s.tenant.slug==='default'?1:0,period.from+'-01',period.to]):[];
   const registeredLines=recordedExpenseLines(registered.operating,vouchers);
   const collected=summarizeImportedDocuments(documents,period,{includePreview:true});
   for(const line of [...summary.lines.filter(l=>l.source_type==='payroll'),...registeredLines]){collected.lines.push({...line,parse_status:line.parse_status||'confirmed'});collected.metrics[line.metric]=rounded((collected.metrics[line.metric]||0)+line.amount);}
   const purchaseCosts=await readPurchaseCosts({query,documents,ctx,period});
   const appendCosts=(target,cost)=>{target.lines.push(...summarizePurchaseCostLines(cost.lines));if(cost.lines.length)target.metrics['已售商品采购成本']=cost.complete?cost.known_amount_cny:null;};
   appendCosts(collected,purchaseCosts.reference);appendCosts(summary,purchaseCosts.confirmed);
   const parsedCovered=new Set(documents.filter(d=>['confirmed','preview'].includes(d.parse_status)&&payload(d).kind==='sales').map(d=>Number(d.shop_key)));
   const covered=new Set(documents.filter(d=>d.parse_status==='confirmed'&&payload(d).kind==='sales').map(d=>Number(d.shop_key)));
   const evidence=new Map();
   for(const d of documents){
    const p=payload(d);if(d.parse_status!=='confirmed'||!p.related_document_id)continue;
    const key=Number(p.related_document_id),items=evidence.get(key)||[];
    items.push({document_id:d.id,original_name:d.original_name,display_name:p.display_name||d.original_name,attachment_url:d.attachment_url,review_status:d.review_status,source_location:financeDocumentLocation(d)});evidence.set(key,items);
   }
   for(const line of [...summary.lines,...collected.lines])line.linked_evidence=line.source_type==='payroll'
     ?documents.filter(d=>d.parse_status==='confirmed'&&d.month_key===line.month&&payload(d).kind==='payroll').map(d=>({document_id:d.id,original_name:d.original_name,display_name:'本月工资资料 · '+(payload(d).display_name||d.original_name),attachment_url:d.attachment_url,review_status:d.review_status,source_location:financeDocumentLocation(d)}))
     :['recorded-expense','purchase-cost'].includes(line.source_type)?line.linked_evidence:evidence.get(Number(line.document_id))||[];

   const year=period.from.slice(0,4),mode=['month','quarter','year'].includes(input.period_mode)?input.period_mode:'month';
   if(input.purchase_cost_details==='1'&&((input.cost_page!=null&&(!Number.isSafeInteger(Number(input.cost_page))||Number(input.cost_page)<1||Number(input.cost_page)>100000))||(input.cost_shop_id!=null&&(!Number.isSafeInteger(Number(input.cost_shop_id))||Number(input.cost_shop_id)<=0))))fail('请选择有效的成本明细页码和店铺（cost_page、cost_shop_id），请返回公司账单重新点击金额');
   const detailRows=purchaseCosts.reference.lines.filter(l=>!input.cost_shop_id||Number(l.shop_id)===Number(input.cost_shop_id)),costPage=Math.max(1,Math.floor(Number(input.cost_page)||1));
   const purchaseCostReport={...purchaseCosts.reference,lines:summarizePurchaseCostLines(purchaseCosts.reference.lines),issues:purchaseCosts.reference.issues.slice(0,100),issue_count:purchaseCosts.reference.issues.length};
   if(input.purchase_cost_details==='1'||costRowsForExport)purchaseCostReport.details={rows:costRowsForExport?detailRows:detailRows.slice((costPage-1)*50,costPage*50),total:detailRows.length,page:costPage};
   return {purchase_cost:purchaseCostReport,collected_summary:{metrics:collected.metrics,lines:collected.lines,matrix:financeMatrix(collected.lines,year,mode),pending_documents:documents.filter(d=>d.parse_status==='preview'&&(payload(d).facts||[]).length).length,error_documents:documents.filter(d=>d.parse_status==='error').length},matrix:financeMatrix(summary.lines,year,mode),company:ctx.c,period,shops,documents:documents.map(d=>{const p=payload(d);return {...d,payload_json:p.kind==='order-sales'?{...p,order_rows:undefined,order_row_count:p.order_rows?.length||0}:p,categories:financeDocumentCategories(d)};}),...summary,cash_reconciliation:reconcileImportedCash(documents,period,await payoutAttributions(ctx)),coverage:{shops_expected:shops.length,shops_with_sales:parsedCovered.size,shops_with_confirmed_sales:covered.size,company_complete:false},gaps:['参考汇总含已解析待核对资料；已确认金额另列，不与订单利润或月度账单再次累计','采购实际成本、库存月末快照和公司共用支出尚待核对','平台转出与收款需匹配，银行到账待补','凭证须经会计审核，未形成最终税前扣除额']};
  },
  async export(input,session){
   const ctx=await company(input,session),period=range(input),report=await this.report(input,ctx.s,{costRowsForExport:true});
   if(report.documents.length>500)fail('导出原件超过500份，请按月或季度缩小范围');
   const zip=new JSZip(),base=`${safeName(ctx.c.name)}/${period.from}_${period.to}`,book=new ExcelJS.Workbook();let bytes=0;
   const addSheet=(name,headers,rows)=>{const s=book.addWorksheet(name);s.addRow(headers);for(const r of rows)s.addRow(r.map(neutral));s.columns.forEach(c=>c.width=28);s.getRow(1).font={bold:true};};
   addSheet('参考汇总（待核对）',['项目',...report.collected_summary.matrix.periods.map(p=>p.label)],report.collected_summary.matrix.rows.flatMap(g=>[[g.name,...report.collected_summary.matrix.periods.map(p=>g.cells[p.id])],...g.children.map(c=>[`  ${c.name}`,...report.collected_summary.matrix.periods.map(p=>c.cells[p.id])])]));
   addSheet('参考金额原件依据',['月份','店铺ID','项目','金额CNY','金额状态','原件编号','原文件名','提取位置','费用记录编号','平台下载目录'],report.collected_summary.lines.map(l=>[l.month,l.shop_id,l.metric,l.amount,l.amount_status==='estimated'?'已登记（估算）':l.source_type==='recorded-expense'?'已登记':l.parse_status==='preview'?'待核对':'已确认',l.document_id,l.original_name,l.source,l.expense_id,l.source_location?.path||financeDocumentLocation(l).path]));

   addSheet('期间分类汇总',['项目',...report.matrix.periods.map(p=>p.label)],report.matrix.rows.flatMap(g=>[[g.name,...report.matrix.periods.map(p=>g.cells[p.id])],...g.children.map(c=>[`  ${c.name}`,...report.matrix.periods.map(p=>c.cells[p.id])])]));
   addSheet('公司已采集汇总',['项目','金额CNY','范围'],Object.entries(report.metrics).map(([k,v])=>[k,v,'已确认资料与已入账工资；公司未齐']));
   addSheet('店铺费用来源',['月份','店铺ID','项目','金额','币种','原件编号','原文件名','提取位置','费用编号','工资明细编号','平台下载目录'],report.lines.map(l=>[l.month,l.shop_id,l.metric,l.amount,l.currency,l.document_id,l.original_name,l.source,l.expense_id,l.payroll_item_id,l.source_location?.path||financeDocumentLocation(l).path]));
   addSheet('凭证审核',['原件编号','月份','原文件名','显示名称','文件分类','上传类型','关联业务编号','导入状态','会计审核','审核意见'],report.documents.map(d=>[d.id,d.month_key,d.original_name,d.payload_json.display_name,(d.categories||[]).map(id=>FINANCE_FILE_CATEGORIES.find(c=>c.id===id)?.name||id).join('、'),d.payload_json.upload_type||'auto',d.payload_json.related_document_id,d.parse_status,d.review_status,d.review_note]));
   addSheet('手工草稿修改历史',['原件编号','修改时间（北京时间）','经办人ID','原项目','原金额CNY','原用途'],report.documents.flatMap(d=>(d.payload_json.preview_history||[]).map(h=>[d.id,new Date(h.at).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}),h.person_id,h.manual?.metric,h.manual?.amount,h.manual?.note])));
   addSheet('会计审核历史',['原件编号','审核时间（北京时间）','经办人ID','状态','意见'],report.documents.flatMap(d=>(d.payload_json.review_history||[]).map(r=>[d.id,new Date(r.at).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}),r.person_id,r.status,r.note])));
   const adjustments=await reconciler.history(ctx,period);
   addSheet('逐单校准历史',['调整编号','月份','店铺ID','货件号','SKU','校准前CNY','校准后CNY','佣金原值CNY','佣金校准后CNY','确认人ID','确认时间（北京时间）','依据'],adjustments.map(r=>{const before=typeof r.before_json==='string'?JSON.parse(r.before_json):r.before_json,after=typeof r.after_json==='string'?JSON.parse(r.after_json):r.after_json;return [r.id,r.month_key,r.shop_id,r.posting_number,r.sku,before.effective?.net_revenue??before.baseline?.revenue,after.net_revenue,before.effective?.commission_fee??before.baseline?.commission,after.commission_fee,r.created_by,new Date(r.created_at).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}),r.reason];}));
   zip.file(`${base}/逐单校准历史.json`,JSON.stringify(adjustments,null,2));
   addSheet('缺件与限制',['待办'],report.gaps.map(g=>[g]));
   addSheet('收款与提现',['日期','类型','金额','原币','手续费原币','提现表列银行金额','表列银行币种','交易参考','原件编号'],report.cash_reconciliation.rows.map(r=>[r.date,r.type,r.amount,r.currency,r.fee,r.listed_bank_amount,r.listed_bank_currency,r.reference,r.document_id]));
   addSheet('入账归属汇总',['入账月份','店铺','币种','入账笔数','金额'],report.cash_reconciliation.shop_entries.map(r=>[r.month,report.shops.find(s=>Number(s.id)===r.shop_id)?.name||(r.shop_id?String(r.shop_id):'待核'),r.currency,r.count,r.amount]));
   addSheet('付款候选匹配',['店铺','平台付款日期','平台付款CNY','收款日期','收款CNH','连连交易号','Ozon原件','原件行','匹配状态'],report.cash_reconciliation.matches.map(r=>[report.shops.find(s=>Number(s.id)===Number(r.payment.shop_id))?.name,r.payment.date,r.payment.amount,r.entry?.date,r.entry?.amount,r.entry?.reference,r.payment.original_name,r.payment.source,r.status]));
   addSheet('文件内部核对',['原件编号','核对项目','差额','原币'],report.documents.flatMap(d=>(d.payload_json.controls||[]).map(c=>[d.id,c.name,c.difference??null,c.currency])));
   addSheet('采购成本匹配',['月份','店铺ID','货件号','SKU','销售数量','退回数量','采购成本CNY','状态','依据','原件编号','订单商品行'],report.purchase_cost.details.rows.map(l=>[l.month,l.shop_id,l.posting_number,l.sku,l.sold_quantity,l.returned_quantity,l.amount,l.amount_status,l.source,l.document_id,(l.item_ids||[]).join(',')]));
   zip.file(`${base}/00_公司汇总与明细.xlsx`,await book.xlsx.writeBuffer());
   const manifest=[];
   for(const doc of report.documents){
    const file=await files.read(doc.attachment_url,ctx.s);bytes+=file.buffer.length;if(bytes>200*1024*1024)fail('原件总量超过200MB，请缩小导出范围');
    if(crypto.createHash('sha256').update(file.buffer).digest('hex')!==doc.sha256)fail(`原件${doc.id}校验失败，停止导出`,409);
    const part=doc.review_status==='accepted'?'02_会计认可凭证':'03_待审及业务配套资料';
    const shop=report.shops.find(s=>Number(s.id)===Number(doc.shop_key));
    const category=payload(doc).kind==='manual-expense'?({'AI使用费':'12_AI与软件','软件订阅费':'12_AI与软件','场地租金':'13_场地费用','水电物业费':'13_场地费用','商品采购支出':'10_采购与库存','设备采购支出':'14_资产及预付款','押金及预付款':'14_资产及预付款'})[payload(doc).facts?.[0]?.metric]||'11_公司或店铺费用':({'sales':'01_销售与退货','order-sales':'01_销售与退货','star-service':'04_广告与推广','foreign-invoice':'04_广告与推广','platform-invoice':'90_多项费用综合凭证','platform-adjustment':'08_赔偿与售后扣款','recharged-service':'90_多项费用综合凭证','compensation':'08_赔偿','balance':'09_结算与回款','currency-settlement':'09_结算与回款','platform-payments':'09_结算与回款','collection-cash':'09_结算与回款'})[payload(doc).kind]||'99_业务配套';
    const filePath=`${base}/${part}/${payload(doc).kind==='collection-cash'?'公司共用跨月':doc.month_key}/${doc.shop_key?safeName(shop?.name||`店铺_${doc.shop_key}`):'公司共用'}/${category}/${doc.id}_${safeName(doc.original_name)}`;
    zip.file(filePath,file.buffer);manifest.push({id:doc.id,original_name:doc.original_name,display_name:payload(doc).display_name||'',categories:doc.categories||[],related_document_id:payload(doc).related_document_id||null,path:filePath,sha256:doc.sha256,archive_source:payload(doc).archive_source||null,source_location:financeDocumentLocation(doc),status:doc.parse_status,review:doc.review_status});
   }

   zip.file(`${base}/来源索引.json`,JSON.stringify(manifest,null,2));
   zip.file(`${base}/先读说明.txt`,'公司会计交接包（草稿）\n只包含已上传资料，其他店铺及公司共用费用未齐。原始文件按索引保存一次。\n平台销售退回冲减收入；服务书、发票、结算不得重复记费。\n会计认可不是税务审批。采购成本按官方逐单销售月份匹配ERP历史成本；缺项另列，不使用当前商品价格或采购付款总额补算。\n'+report.gaps.join('\n'));
   return {filename:`公司会计交接_${period.from}_${period.to}.zip`,buffer:await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'})};
  }
 };
}
export const companyFinanceDocuments=createCompanyFinanceDocuments();
