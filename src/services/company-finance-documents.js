import crypto from 'node:crypto';
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
export function summarizeImportedDocuments(documents){
 const metrics={};const lines=[];const cash=[];
 for(const doc of documents){
  if(doc.parse_status!=='confirmed')continue;
  const p=payload(doc);
  for(const [i,line]of (p.facts||[]).entries()){
   if(line.currency!=='CNY')continue;
   metrics[line.metric]=rounded((metrics[line.metric]||0)+line.amount);
   lines.push({...line,document_id:doc.id,line_index:i,shop_id:doc.shop_key,month:doc.month_key,original_name:doc.original_name,attachment_url:doc.attachment_url});
  }
  for(const item of p.cash||[])cash.push({...item,document_id:doc.id,shop_id:doc.shop_key,original_name:doc.original_name});
 }
 return {metrics,lines,cash};
}
export function reconcileImportedCash(documents,{from,to}){
 const {cash}=summarizeImportedDocuments(documents);
 const rows=cash.filter(r=>['entry','withdrawal'].includes(r.type)&&String(r.date).slice(0,7)>=from&&String(r.date).slice(0,7)<=to);
 const currencies=[...new Set(rows.map(r=>r.currency))];
 const payments=cash.filter(r=>r.type==='platform-payment'&&String(r.date).slice(0,7)>=from&&String(r.date).slice(0,7)<=to);
 const entries=cash.filter(r=>r.type==='entry');const used=new Set();
 const matches=payments.map(payment=>{
  const candidates=entries.filter((entry,i)=>!used.has(i)&&payment.currency==='CNY'&&entry.currency==='CNH'&&Math.abs(entry.amount-payment.amount)<0.005&&Math.abs(Date.parse(String(entry.date).slice(0,10)+'T00:00:00Z')-Date.parse(payment.date+'T00:00:00Z'))<=4*86400000);
  if(candidates.length!==1)return {payment,status:candidates.length?'ambiguous':'unmatched',entry:null};
  const entry=candidates[0];used.add(entries.indexOf(entry));return {payment,entry,status:'amount_date_candidate',note:'仅金额和日期候选匹配，需确认账户及店铺归属；不据此认定汇兑为零'};
 });
 return {matches,currencies:currencies.map(currency=>{
  const selected=rows.filter(r=>r.currency===currency),entries=selected.filter(r=>r.type==='entry'),withdrawals=selected.filter(r=>r.type==='withdrawal');
  return {currency,entries:rounded(entries.reduce((s,r)=>s+r.amount,0)),withdrawals:rounded(withdrawals.reduce((s,r)=>s+r.amount,0)),fees:rounded(withdrawals.reduce((s,r)=>s+(r.fee||0),0))};
 }),rows,bank_status:'missing',note:'收款与提现分别列示，不用差额认定损失；尚需平台转出匹配、期初期末余额及银行回单。'};
}
export function createCompanyFinanceDocuments({query=mysqlQuery,execute=mysqlExecute,files=tenantPrivateFiles,authorize=authorizeBusinessTaskSession,parse=parseFinanceDocument,transaction=mysqlTransaction}={}){
 let schema;
 async function ready(){if(!schema)schema=execute(FINANCE_DOCUMENT_SCHEMA).catch(e=>{schema=null;throw e;});await schema;}
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
 async function getDocs(ctx,period){
  await ready();
  // Shared cash files can contain multiple months. Keep once and filter events by their own dates.
  return query(`SELECT * FROM finance_import_documents WHERE tenant_id=? AND company_id=? AND ((month_key>=? AND month_key<=?) OR shop_key=0) ORDER BY month_key,id`,[ctx.tenantId,ctx.companyId,period.from,period.to]);
 }
 async function locked(ctx,month){
  const closed=await query(`SELECT id FROM finance_periods WHERE company_id=? AND month_key=? AND status='closed' AND (tenant_id=? OR (?=1 AND tenant_id IS NULL))`,[ctx.companyId,month,ctx.tenantId,ctx.s.tenant.slug==='default'?1:0]);
  if(closed.length)fail(`公司${month}已关账，请先由会计按既有流程处理关账状态`,409);
 }
 async function writePeriod(ctx,month,worker){
  return transaction(async db=>{
   // Reserve the existing company/month key. Closing uses the same period row,
   // so close and confirmation cannot pass each other between check and write.
   await db.execute("INSERT IGNORE INTO finance_periods(tenant_id,company_id,month_key,status) VALUES(?,?,?,'preparing')",[ctx.s.tenant.slug==='default'?null:ctx.tenantId,ctx.companyId,month]);
   const [period]=await db.query('SELECT status FROM finance_periods WHERE company_id=? AND month_key=? FOR UPDATE',[ctx.companyId,month]);
   if(period?.status==='closed')fail(`公司${month}已关账，请先由会计按既有流程处理关账状态`,409);
   return worker(db);
  });
 }
 return {
  async preview(input,session){
   const ctx=await company(input,session),month=validateMonth(input.month),shop=Number(input.shop_id||0);
   if(!Number.isSafeInteger(shop)||shop<0)fail('店铺shop_id无效，请重新选择店铺或公司共用');
   const shops=await shopsFor(ctx,{from:month,to:month});if(shop&&!shops.some(s=>Number(s.id)===shop))fail('所选店铺在该月不属于当前公司，请先检查公司与店铺归属',403);
   await locked(ctx,month);await ready();
   await files.owned(input.attachment_url,ctx.s,'finance');const file=await files.read(input.attachment_url,ctx.s);
   let p,status='preview';
   try{p=await parse(file.buffer,file.row.original_name,{month});
    if(p.kind==='collection-cash'&&shop)fail('连连流水属于公司共用账户，请选择“公司共用”上传，避免三店重复导入');
    if(p.facts.length&&!shop)fail('平台销售与费用需要明确店铺（shop_id），请选择实际店铺后重试');
    if(p.buyer_tax_number&&ctx.c.tax_number&&p.buyer_tax_number!==ctx.c.tax_number)fail('文件购买方税号与所选公司不符，请核对公司主体');
   }catch(e){status='error';p={facts:[],cash:[],controls:[],warnings:[e.message],kind:'unparsed',month};}
   const hash=crypto.createHash('sha256').update(file.buffer).digest('hex');
   const existing=await query(`SELECT * FROM finance_import_documents WHERE tenant_id=? AND company_id=? AND shop_key=? AND (sha256=? OR (business_key IS NOT NULL AND business_key=?))`,[ctx.tenantId,ctx.companyId,shop,hash,p.business_key||null]);
   if(existing.length){if(existing[0].sha256!==hash)fail('同编号业务已有不同内容原件，请人工核对并保留更正依据，不能重复累计',409);
    if(existing[0].parse_status==='error'&&status==='preview'){
     p.previous_errors=payload(existing[0]).warnings;
     await execute("UPDATE finance_import_documents SET month_key=?,business_key=?,parse_status='preview',payload_json=? WHERE id=? AND tenant_id=? AND company_id=? AND parse_status='error'",[month,p.business_key||null,JSON.stringify(p),existing[0].id,ctx.tenantId,ctx.companyId]);
     return {document:{...existing[0],month_key:month,parse_status:'preview',payload_json:p},duplicate:true};
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
   await writePeriod(ctx,doc.month_key,db=>db.execute("UPDATE finance_import_documents SET parse_status='confirmed',confirmed_by=?,confirmed_at=UTC_TIMESTAMP() WHERE id=? AND tenant_id=? AND company_id=? AND parse_status='preview'",[ctx.s.personId,doc.id,ctx.tenantId,ctx.companyId]));return {ok:true};
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
  async report(input,session){
   const ctx=await company(input,session),period=range(input),documents=await getDocs(ctx,period),shops=await shopsFor(ctx,period),summary=summarizeImportedDocuments(documents);
   const covered=new Set(documents.filter(d=>d.parse_status==='confirmed'&&payload(d).kind==='sales').map(d=>Number(d.shop_key)));
   return {company:ctx.c,period,shops,documents:documents.map(d=>({...d,payload_json:payload(d)})),...summary,cash_reconciliation:reconcileImportedCash(documents,period),coverage:{shops_expected:shops.length,shops_with_sales:covered.size,company_complete:false},gaps:['仅汇总已确认导入资料，不与现有订单利润再次累计','采购实际成本、库存月末快照和公司共用支出尚待核对','平台转出与收款需匹配，银行到账待补','凭证须经会计审核，未形成最终税前扣除额']};
  },
  async export(input,session){
   const ctx=await company(input,session),period=range(input),report=await this.report(input,ctx.s);
   if(report.documents.length>500)fail('导出原件超过500份，请按月或季度缩小范围');
   const zip=new JSZip(),base=`${safeName(ctx.c.name)}/${period.from}_${period.to}`,book=new ExcelJS.Workbook();let bytes=0;
   const addSheet=(name,headers,rows)=>{const s=book.addWorksheet(name);s.addRow(headers);for(const r of rows)s.addRow(r.map(neutral));s.columns.forEach(c=>c.width=28);s.getRow(1).font={bold:true};};
   addSheet('公司已采集汇总',['项目','金额CNY','范围'],Object.entries(report.metrics).map(([k,v])=>[k,v,'仅已确认导入资料；公司未齐']));
   addSheet('店铺费用来源',['月份','店铺ID','项目','金额','币种','原件编号','原文件名','提取位置'],report.lines.map(l=>[l.month,l.shop_id,l.metric,l.amount,l.currency,l.document_id,l.original_name,l.source]));
   addSheet('凭证审核',['原件编号','月份','文件名','导入状态','会计审核','审核意见'],report.documents.map(d=>[d.id,d.month_key,d.original_name,d.parse_status,d.review_status,d.review_note]));
   addSheet('会计审核历史',['原件编号','审核时间（北京时间）','经办人ID','状态','意见'],report.documents.flatMap(d=>(d.payload_json.review_history||[]).map(r=>[d.id,new Date(r.at).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}),r.person_id,r.status,r.note])));
   addSheet('缺件与限制',['待办'],report.gaps.map(g=>[g]));
   addSheet('收款与提现',['日期','类型','金额','原币','手续费原币','提现表列银行金额','表列银行币种','交易参考','原件编号'],report.cash_reconciliation.rows.map(r=>[r.date,r.type,r.amount,r.currency,r.fee,r.listed_bank_amount,r.listed_bank_currency,r.reference,r.document_id]));
   addSheet('付款候选匹配',['平台付款日期','平台付款CNY','收款日期','收款CNH','匹配状态'],report.cash_reconciliation.matches.map(r=>[r.payment.date,r.payment.amount,r.entry?.date,r.entry?.amount,r.status]));
   addSheet('文件内部核对',['原件编号','核对项目','差额','原币'],report.documents.flatMap(d=>(d.payload_json.controls||[]).map(c=>[d.id,c.name,c.difference??null,c.currency])));
   zip.file(`${base}/00_公司汇总与明细.xlsx`,await book.xlsx.writeBuffer());
   const manifest=[];
   for(const doc of report.documents){
    const file=await files.read(doc.attachment_url,ctx.s);bytes+=file.buffer.length;if(bytes>200*1024*1024)fail('原件总量超过200MB，请缩小导出范围');
    if(crypto.createHash('sha256').update(file.buffer).digest('hex')!==doc.sha256)fail(`原件${doc.id}校验失败，停止导出`,409);
    const part=doc.review_status==='accepted'?'02_会计认可凭证':'03_待审及业务配套资料';
    const shop=report.shops.find(s=>Number(s.id)===Number(doc.shop_key));
    const category=({'sales':'01_销售与退货','star-service':'04_广告与推广','foreign-invoice':'04_广告与推广','platform-invoice':'90_多项费用综合凭证','recharged-service':'90_多项费用综合凭证','compensation':'08_赔偿','balance':'09_结算与回款','currency-settlement':'09_结算与回款','platform-payments':'09_结算与回款','collection-cash':'09_结算与回款'})[payload(doc).kind]||'99_业务配套';
    const filePath=`${base}/${part}/${doc.shop_key?doc.month_key:'公司共用跨月'}/${doc.shop_key?safeName(shop?.name||`店铺_${doc.shop_key}`):'共用账户'}/${category}/${doc.id}_${safeName(doc.original_name)}`;
    zip.file(filePath,file.buffer);manifest.push({id:doc.id,path:filePath,sha256:doc.sha256,status:doc.parse_status,review:doc.review_status});
   }
   zip.file(`${base}/来源索引.json`,JSON.stringify(manifest,null,2));
   zip.file(`${base}/先读说明.txt`,'公司会计交接包（草稿）\n只包含已上传资料，其他店铺及公司共用费用未齐。原始文件按索引保存一次。\n平台销售退回冲减收入；服务书、发票、结算不得重复记费。\n会计认可不是税务审批。现有ERP采购成本未自动结转到本导入账簿，避免混用历史或当前成本。\n'+report.gaps.join('\n'));
   return {filename:`公司会计交接_${period.from}_${period.to}.zip`,buffer:await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'})};
  }
 };
}
export const companyFinanceDocuments=createCompanyFinanceDocuments();
