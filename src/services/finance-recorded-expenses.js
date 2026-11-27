// Existing expense registrations are monetary sources; their invoices are evidence, not another expense.
const metrics={
 ai_tokens:'AI使用费',ai_subscription:'软件订阅费',software:'软件订阅费',rent:'场地租金',utilities:'水电物业费',internet:'网络费用',
 office:'办公耗材费',bank:'银行手续费',domestic_logistics:'国内物流费',domestic_shipping:'国内物流费',fbp_stocking_shipping:'国内物流费','物流':'国内物流费',
 subsidy:'加班及补贴',temporary_labor:'临时用工费',travel:'差旅费',team_building:'团建费',equipment_maintenance:'设备维修费',
 withdrawal:'提现手续费',currency_exchange:'换汇手续费',packaging:'包装耗材费',order_payment:'收单费补充更正',other:'其他费用'
};
export function recordedExpenseLines(expenses,vouchers=[]){
 const evidence=new Map();for(const v of vouchers){if(!v.attachment_url)continue;const list=evidence.get(Number(v.expense_id))||[];list.push({voucher_id:v.id,original_name:v.voucher_number||'费用配套凭证',display_name:v.voucher_number||'费用配套凭证',attachment_url:v.attachment_url,review_status:v.review_status==='approved'?'accepted':'pending'});evidence.set(Number(v.expense_id),list);}
 const seen=new Set();return expenses.filter(e=>e.category!=='salary').map(e=>{
  if(seen.has(Number(e.id)))throw new Error(`费用记录 #${e.id} 重复，请检查费用来源`);seen.add(Number(e.id));
  if(e.amount_cny==null||String(e.amount_cny).trim()===''||!Number.isFinite(Number(e.amount_cny)))throw new Error(`费用记录 #${e.id} 缺少有效人民币金额（amount_cny），请到月度账单核对费用登记`);
  return {metric:metrics[e.category]||`登记费用：${e.category||'未分类'}`,amount:Math.round(Number(e.amount_cny)*100)/100,currency:'CNY',month:e.month_key,shop_id:Number(e.shop_id||0),expense_id:Number(e.id),
   source_type:'recorded-expense',expense_source_type:e.source_type,source:`费用登记 #${e.id}：${e.description||e.category}`,display_name:e.description||e.category,original_name:'费用登记记录',
   parse_status:'recorded',amount_status:e.source_type==='user_cost_default'?'estimated':'recorded',review_status:e.voucher_status==='matched'?'accepted':'pending',linked_evidence:evidence.get(Number(e.id))||[]};
 });
}
