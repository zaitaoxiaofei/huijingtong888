import { submissionActor } from './finance-submissions.js';
import { mysqlQuery, mysqlExecute, withMysqlTransaction } from '../mysql-pool.js';
import { ensureFinanceCenterSchema } from './finance-center.js';
import { BILLING_COST_SCHEMA } from "./finance-billing-cost-schema.js";
const fail=(message,statusCode=400)=>{throw Object.assign(new Error(message),{statusCode});};
const money=value=>Math.round(Number(value)*100)/100;
export function createFinanceBillingCosts({query=mysqlQuery,execute=mysqlExecute,transaction=withMysqlTransaction,ensureFinance=ensureFinanceCenterSchema}={}){
 let ready;
 async function ensure(){if(!ready)ready=(async()=>{await ensureFinance();for(const ddl of BILLING_COST_SCHEMA)await execute(ddl);})().catch(error=>{ready=null;throw error;});await ready;}
 async function save(body,session){
  const actor=submissionActor(session,true),orderId=Number(body.order_id),companyId=Number(body.company_id),revision=Number(body.expected_revision),reason=String(body.reason||'').trim();
  const columns={other_fee:['other_fee_cny',null,'order_payment','订单手续费'],domestic_shipping_cost:['domestic_shipping_cny','frozen_domestic_shipping','domestic_shipping','国内运费'],packaging_cost:['packaging_cost_cny','frozen_handling_fee','packaging','包装费']},config=Object.hasOwn(columns,body.field)?columns[body.field]:null;
  if(!config||typeof body.reason!=='string'||![orderId,companyId].every(n=>Number.isSafeInteger(n)&&n>0)||!Number.isSafeInteger(revision)||revision<0||!reason||reason.length>500)fail('请选择订单、费用类型、归属公司，并填写更正原因（最多500字）');
  if(!['save','restore'].includes(body.action||'save'))fail('费用操作无效');
  const target=Number(body.amount),expectedBase=Number(body.expected_base);
  if(!['number','string'].includes(typeof body.expected_base)||body.expected_base===''||body.expected_base==null||!Number.isFinite(expectedBase)||expectedBase<0||body.action!=='restore'&&(!['number','string'].includes(typeof body.amount)||body.amount==null||body.amount===''||!Number.isFinite(target)||target<0||target>100000000))fail('请填写有效金额，刷新来源金额后重试');
  await ensure();
  return transaction(async connection=>{
   const run=async(sql,p=[])=>(await connection.execute(sql,p))[0];
   const [company]=await run(`SELECT id FROM finance_companies WHERE id=? AND status='active' AND (tenant_id=?${actor.legacy?' OR tenant_id IS NULL OR tenant_id=0':''}) FOR UPDATE`,[companyId,actor.tenantId]);if(!company)fail('公司不存在或不属于当前企业',404);
   const [order]=await run(`SELECT o.id,o.shop_id,o.posting_number,DATE_FORMAT(CONVERT_TZ(o.ordered_at,'+00:00','+08:00'),'%Y-%m-%d') expense_date FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.id=? AND (s.tenant_id=?${actor.legacy?' OR s.tenant_id IS NULL':''}) FOR UPDATE`,[orderId,actor.tenantId]);if(!order)fail('订单不存在或不属于当前企业',404);
   const assignments=await run(`SELECT company_id FROM finance_shop_company_assignments WHERE shop_id=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) AND (tenant_id=?${actor.legacy?' OR tenant_id IS NULL OR tenant_id=0':''}) FOR UPDATE`,[order.shop_id,order.expense_date,order.expense_date,actor.tenantId]);
   if(assignments.length!==1||Number(assignments[0].company_id)!==companyId)fail('订单日期的公司归属缺失或存在冲突，请先在公司设置中核对',409);
   const month=String(order.expense_date).slice(0,7);
   await run('INSERT IGNORE INTO finance_periods(tenant_id,company_id,month_key) VALUES(?,?,?)',[actor.legacy?null:actor.tenantId,companyId,month]);
   const [period]=await run('SELECT status FROM finance_periods WHERE company_id=? AND month_key=? FOR UPDATE',[companyId,month]);if(period?.status==='closed')fail('该月已关账，不能更正费用',409);
   const items=await run(`SELECT COALESCE(p.${config[0]},${config[1]?'i.'+config[1]+'*i.quantity':'0'},0) amount FROM order_items i LEFT JOIN order_profit_items p ON p.order_item_id=i.id WHERE i.order_id=? FOR UPDATE`,[orderId]);
   const base=money(items.reduce((n,row)=>n+Number(row.amount),0));if(base!==money(expectedBase))fail('来源费用已更新，请从对应订单费用明细重新打开后核对',409);
   const [before]=await run('SELECT * FROM finance_billing_cost_adjustments WHERE tenant_id=? AND order_id=? AND field=? FOR UPDATE',[actor.tenantId,orderId,body.field]);
   if((before?.expense_id?Number(before.revision):0)!==revision)fail('费用已被其他人更正，请刷新',409);
   if(before&&Number(before.company_id)!==companyId)fail('原更正记录的公司归属已变化，请先核对',409);
   const delta=body.action==='restore'?0:money(target-base),nextRevision=Number(before?.revision||0)+1;
   let id=before?.id;
   if(!id){const r=await run('INSERT INTO finance_billing_cost_adjustments(tenant_id,company_id,order_id,field,base_amount,delta) VALUES(?,?,?,?,?,?)',[actor.tenantId,companyId,orderId,body.field,base,delta]);id=Number(r.insertId);}
   let expenseId=before?.expense_id||null;
   if(expenseId){const linked=await run(`SELECT id FROM finance_expenses WHERE id=? AND source_type='billing_cost_adjustment' AND source_id=? AND company_id=? AND (tenant_id=?${actor.legacy?' OR tenant_id IS NULL OR tenant_id=0':''}) FOR UPDATE`,[expenseId,id,companyId,actor.tenantId]);if(linked.length!==1)fail('更正费用来源缺失或不一致，请先核对账单',409);const vouchers=await run('SELECT id FROM finance_vouchers WHERE expense_id=? LIMIT 1 FOR UPDATE',[expenseId]);if(vouchers.length)fail('更正费用已关联凭证，请先解除关联后修改',409);}
   if(delta===0){if(expenseId)await run("DELETE FROM finance_expenses WHERE id=? AND source_type='billing_cost_adjustment' AND source_id=?",[expenseId,id]);expenseId=null;}
   else if(expenseId)await run("UPDATE finance_expenses SET original_amount=?,amount_cny=?,description=? WHERE id=? AND source_type='billing_cost_adjustment' AND source_id=?",[delta,delta,`${order.posting_number} · ${config[3]}更正：${reason}`,expenseId,id]);
   else{const result=await run("INSERT INTO finance_expenses(tenant_id,company_id,shop_id,expense_date,category,description,currency_code,original_amount,exchange_rate,amount_cny,voucher_status,source_type,source_id,created_by) VALUES(?,?,?,?,?,?,'CNY',?,1,?,'missing','billing_cost_adjustment',?,?)",[actor.legacy?null:actor.tenantId,companyId,order.shop_id,order.expense_date,config[2],`${order.posting_number} · ${config[3]}更正：${reason}`,delta,delta,id,actor.personId]);expenseId=Number(result.insertId);}
   await run('UPDATE finance_billing_cost_adjustments SET base_amount=?,delta=?,expense_id=?,revision=? WHERE id=? AND tenant_id=?',[base,delta,expenseId,nextRevision,id,actor.tenantId]);
   await run('INSERT INTO finance_billing_cost_revisions(tenant_id,adjustment_id,before_json,after_json,reason,recorded_by) VALUES(?,?,?,?,?,?)',[actor.tenantId,id,before?JSON.stringify(before):null,JSON.stringify({base,delta,target:money(base+delta),expense_id:expenseId,revision:nextRevision,action:body.action||'save'}),reason,actor.personId]);
   return {ok:true,amount:money(base+delta),delta,revision:expenseId?nextRevision:0};
  });
 }
 return {save};
}
export const financeBillingCosts=createFinanceBillingCosts();
