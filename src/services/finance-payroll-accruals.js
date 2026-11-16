const mysqlQuery=async(...args)=>(await import('../mysql-pool.js')).mysqlQuery(...args);
// Read-only recognition of already-paid wages. Approval later replaces this
// expense with its posted finance_submission row in the same report.
export async function paidPayrollAccruals({tenantId,legacy=false,companyId=0,shopId='all',from,to},query=mysqlQuery) {
 if(!Number.isSafeInteger(Number(tenantId))||Number(tenantId)<=0)throw new Error('Invalid payroll accrual tenant');
 if(Number(shopId)>0)return []; // Company payroll is not silently allocated to shops.
 const params=[Number(tenantId),Number(tenantId),from,to];
 const where=["i.tenant_id=?",`(c.tenant_id=?${legacy?' OR c.tenant_id IS NULL OR c.tenant_id=0':''})`,"i.expense_date>=?","i.expense_date<=?","s.kind='payroll'","s.status='pending'","EXISTS(SELECT 1 FROM finance_payroll_payment_updates confirmed WHERE confirmed.tenant_id=i.tenant_id AND confirmed.item_id=i.id AND confirmed.paid_amount>0)"];
 if(Number(companyId)>0){where.push('i.company_id=?');params.push(Number(companyId));}
 const rows=await query(`SELECT i.id,i.company_id,i.amount,i.detail_json,DATE_FORMAT(i.expense_date,'%Y-%m-%d') expense_date,c.name company_name,p.paid_amount
  FROM finance_submission_items i JOIN finance_submissions s ON s.id=i.submission_id AND s.tenant_id=i.tenant_id
  JOIN finance_companies c ON c.id=i.company_id
  JOIN finance_imported_payroll_periods period ON period.tenant_id=i.tenant_id AND period.submission_id=i.submission_id AND period.company_id=i.company_id AND period.month_key=DATE_FORMAT(i.expense_date,'%Y-%m')
  JOIN finance_payroll_payment_updates p ON p.id=(SELECT MAX(last.id) FROM finance_payroll_payment_updates last WHERE last.tenant_id=i.tenant_id AND last.item_id=i.id)
  WHERE ${where.join(' AND ')}
   AND NOT EXISTS(SELECT 1 FROM finance_expenses posted WHERE posted.source_type='finance_submission' AND posted.source_id=i.id AND posted.company_id=i.company_id AND (posted.tenant_id=i.tenant_id${legacy?' OR posted.tenant_id IS NULL OR posted.tenant_id=0':''}))
   AND NOT EXISTS(SELECT 1 FROM finance_expenses old WHERE old.company_id=i.company_id AND old.category='salary' AND old.source_type IN ('payroll','payroll_period') AND old.expense_date>=DATE_FORMAT(i.expense_date,'%Y-%m-01') AND old.expense_date<=LAST_DAY(i.expense_date) AND (old.tenant_id=i.tenant_id${legacy?' OR old.tenant_id IS NULL OR old.tenant_id=0':''}))
  ORDER BY i.expense_date,i.company_id,i.id`,params);
 return rows.map(row=>{
  const detail=typeof row.detail_json==='string'?JSON.parse(row.detail_json):row.detail_json;
  return {id:`paid-payroll-${row.id}`,company_id:row.company_id,company_name:row.company_name,shop_id:null,shop_name:null,expense_date:row.expense_date,category:'salary',description:`${detail.month}工资 · ${detail.person_name}（${Number(row.paid_amount)>0?'已发':'已确认'}待归档）`,currency_code:'CNY',original_amount:Number(row.amount),exchange_rate:1,amount_cny:Number(row.amount),source_type:'finance_submission',source_id:row.id,voucher_status:'missing',salary_recognition:'paid_pending',paid_amount:Number(row.paid_amount),detail_json:row.detail_json};
 });
}
