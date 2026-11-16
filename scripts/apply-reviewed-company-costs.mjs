// Explicit, audited data entry. No application deployment, schema migration or transfer.
import fs from'node:fs/promises';import crypto from'node:crypto';
import{mysqlQuery,withMysqlTransaction,closeMysqlPool}from'../src/mysql-pool.js';
import{createFinanceSubmissions,submissionActor}from'../src/services/finance-submissions.js';
import{config}from'../src/config.js';
const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1],apply=args.includes('--apply');
try{
 if(!args.includes('--manifest')||!args.includes('--expected-sha'))throw Error('Explicit manifest and SHA required');const bytes=await fs.readFile(value('--manifest')),sha=crypto.createHash('sha256').update(bytes).digest('hex');if(sha!==value('--expected-sha'))throw Error('Manifest SHA mismatch');const plan=JSON.parse(bytes);
 if(!Number.isSafeInteger(plan.tenant_id)||plan.companies.length!==2||plan.expenses.length>500)throw Error('Manifest shape invalid');
 const base=`http://127.0.0.1:${config.port}`,login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:process.env.HEALTH_CHECK_USERNAME,password:process.env.HEALTH_CHECK_PASSWORD})});const auth=await login.json();if(!login.ok||!auth.token)throw Error('Health identity unavailable');const me=await(await fetch(base+'/api/auth/me',{headers:{Authorization:'Bearer '+auth.token}})).json(),session={...me,personId:Number(me.id)};const actor=submissionActor(session,true);if(actor.tenantId!==plan.tenant_id)throw Error('Enterprise mismatch');
 const names=await mysqlQuery('SELECT id,name,tenant_id FROM finance_companies WHERE id IN (?,?)',[...plan.companies.map(c=>c.id)]);for(const c of plan.companies){const row=names.find(r=>Number(r.id)===c.id);if(!row||row.name!==c.name||(row.tenant_id!=null&&Number(row.tenant_id)!==actor.tenantId))throw Error('Company identity mismatch');}
 let connection=null;const run=async(sql,p=[])=>(connection?(await connection.execute(sql,p))[0]:await mysqlQuery(sql,p));
 // Existing production tables are prerequisites; this task never creates schema.
 const required=['finance_submissions','finance_submission_items','finance_imported_payroll_periods','finance_payroll_payment_updates','finance_payroll_item_revisions'];for(const table of required){const r=await mysqlQuery('SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?',[table]);if(!Number(r[0].n))throw Error('Missing existing payroll schema');}
 const service=createFinanceSubmissions({query:run,execute:async sql=>{if(!/^CREATE TABLE/i.test(sql.trim()))throw Error('Unexpected schema write');return{};},ensureFinance:async()=>{},transaction:fn=>connection?fn(connection):withMysqlTransaction(fn)});
 const old=await service.detail(plan.payroll.void_id,session),current=await service.detail(plan.payroll.approve_id,session);
 if(old.kind!=='payroll'||current.kind!=='payroll'||Number(old.total_amount)!==plan.payroll.void_amount||Number(current.total_amount)!==plan.payroll.approve_amount)throw Error('Payroll amount or kind changed');
 if(!['pending','approved','voided'].includes(old.status)||!['pending','approved'].includes(current.status))throw Error('Payroll status changed');
 for(const row of old.items)if(Number(row.company_id)!==plan.companies[0].id||row.month<'2026-03'||row.month>'2026-06')throw Error('Old batch scope changed');
 if(current.item_count!==19||old.item_count!==8)throw Error('Payroll item counts changed');
 for(const e of plan.expenses)if(!plan.companies.some(c=>c.id===e.company_id)||!/^20\d{2}-\d{2}-\d{2}$/.test(e.expense_date)||!Number.isFinite(e.amount)||e.amount<0||e.source_type!=='user_cost_default'||!Number.isSafeInteger(e.source_id))throw Error('Expense manifest invalid');
 const reason='用户确认作废上海2026年3—6月旧批次，仅保留更正批次5；原有发放历史保留';
 const summary={manifest_sha256:sha,actor_id:actor.personId,tenant_id:actor.tenantId,void_submission:old.id,void_cost:Number(old.total_amount),approve_submission:current.id,approve_cost:Number(current.total_amount),expense_rows:plan.expenses.length,expense_amount:plan.expenses.reduce((n,r)=>n+Math.round(r.amount*100),0)/100,ai_policy_pending_separate_release:plan.ai_policy};
 if(!apply){console.log(JSON.stringify({dry_run:true,...summary},null,2));}
 else{
  if(!args.includes('--backup'))throw Error('A private before/after receipt path is required');
  const backup={manifest_sha256:sha,old,current,expenses_before:await mysqlQuery("SELECT * FROM finance_expenses WHERE source_type='user_cost_default' AND company_id IN (?,?)",plan.companies.map(c=>c.id)),payments_before:await mysqlQuery('SELECT p.* FROM finance_payroll_payment_updates p JOIN finance_submission_items i ON i.id=p.item_id AND i.tenant_id=p.tenant_id WHERE i.tenant_id=? AND i.submission_id IN (?,?)',[actor.tenantId,old.id,current.id])};await fs.writeFile(value('--backup'),JSON.stringify(backup,null,2),{mode:0o600,flag:'wx'});
  const result=await withMysqlTransaction(async c=>{connection=c;try{
   for(const company of plan.companies)await run('SELECT id FROM finance_companies WHERE id=? FOR UPDATE',[company.id]);
   if(old.status!=='voided')await service.voidPayroll({id:old.id,expected_revision:old.revision,reason},session);else if(old.review_note!==reason)throw Error('Old batch void reason differs');
   if(current.status==='pending')await service.review({id:current.id,status:'approved',expected_revision:current.revision,note:'用户确认九月更正批次为准；按各公司月份一次入账，保留原发放登记'},session);
   let inserted=0,reused=0;
   for(const e of plan.expenses){const [existing]=await run('SELECT * FROM finance_expenses WHERE source_type=? AND source_id=? FOR UPDATE',[e.source_type,e.source_id]);if(existing){if(Number(existing.company_id)!==e.company_id||Number(existing.amount_cny)!==e.amount||existing.category!==e.category||existing.description!==e.description)throw Error('Previously entered expense changed; refusing to overwrite');reused++;continue;}
    const month=e.expense_date.slice(0,7);await run('INSERT IGNORE INTO finance_periods(tenant_id,company_id,month_key) VALUES(?,?,?)',[actor.legacy?null:actor.tenantId,e.company_id,month]);const [period]=await run('SELECT status FROM finance_periods WHERE company_id=? AND month_key=? FOR UPDATE',[e.company_id,month]);if(period?.status==='closed')throw Error('Expense month is closed: '+month);
    await run("INSERT INTO finance_expenses(tenant_id,company_id,expense_date,category,description,currency_code,original_amount,exchange_rate,amount_cny,payment_reference,voucher_status,source_type,source_id,created_by) VALUES(?,?,?,?,?,'CNY',?,1,?,?,'missing',?,?,?)",[actor.legacy?null:actor.tenantId,e.company_id,e.expense_date,e.category,e.description,e.amount,e.amount,e.payment_reference,e.source_type,e.source_id,actor.personId]);inserted++;
   }
   const [wages]=await run("SELECT COUNT(*) rows_count,SUM(e.amount_cny) amount FROM finance_expenses e JOIN finance_submission_items i ON e.source_type='finance_submission' AND e.source_id=i.id WHERE i.tenant_id=? AND i.submission_id=?",[actor.tenantId,current.id]);if(Number(wages.rows_count)!==current.item_count||Number(wages.amount)!==plan.payroll.approve_amount)throw Error('Posted payroll does not reconcile');
   return{inserted,reused,payroll_rows:Number(wages.rows_count),payroll_amount:Number(wages.amount)};
  }finally{connection=null;}});
  const paidAfter=await mysqlQuery('SELECT p.* FROM finance_payroll_payment_updates p JOIN finance_submission_items i ON i.id=p.item_id AND i.tenant_id=p.tenant_id WHERE i.tenant_id=? AND i.submission_id IN (?,?)',[actor.tenantId,old.id,current.id]);if(paidAfter.length!==backup.payments_before.length)throw Error('Payment history count changed; inspect receipt');
  await fs.writeFile(value('--backup')+'.after.json',JSON.stringify({summary,result,payment_history_unchanged:JSON.stringify(paidAfter)===JSON.stringify(backup.payments_before)},null,2),{mode:0o600});console.log(JSON.stringify({applied:true,...summary,...result,payment_records_preserved:paidAfter.length},null,2));
 }
}catch(error){console.error(String(error.message));process.exitCode=1;}finally{await closeMysqlPool();}
