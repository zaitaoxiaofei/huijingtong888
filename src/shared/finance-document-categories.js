// File categories describe provenance; a multi-category original is still stored and counted once.
export const FINANCE_FILE_CATEGORIES=[
 {id:'sales',name:'销售与退款',examples:'销售报告、退货冲减、补贴明细',effect:'以销售报告确认金额；补贴配套明细不重复计入'},
 {id:'platform',name:'佣金与平台服务费',examples:'UTD综合发票、独立佣金凭证、平台服务书',effect:'按正文服务行分类，综合原件只记一次'},
 {id:'advertising',name:'广告与推广',examples:'点击广告费、星级推广服务书及同号发票',effect:'服务书确认费用；同号配套发票仅归档'},
 {id:'international',name:'国际物流',examples:'转收费报告、国际承运服务凭证',effect:'按报告项目记费，结算付款不再计费'},
 {id:'last-mile',name:'尾程派送',examples:'转收费报告中的last mile项目',effect:'与国际干线分列，不重复累计'},
 {id:'acquiring',name:'收单与支付手续费',examples:'收单服务报告、手续费明细',effect:'汇总报告与逐笔明细二选一记费'},
 {id:'adjustments',name:'赔偿与售后扣款',examples:'平台赔偿报告、客户部分补偿、缺件扣款',effect:'赔偿收入与卖家承担的扣款分列；不当作回款'},
 {id:'cash',name:'结算回款与财务费用',examples:'对账单、付款报告、连连流水、银行回单',effect:'回款及提现本金不算新收入；手续费与汇差另核'},
 {id:'purchase',name:'采购与库存',examples:'采购订单、采购发票、收货及月末库存',effect:'采购支出与已售成本分开，库存不一次费用化'},
 {id:'payroll',name:'工资社保',examples:'工资表、工资付款、社保公积金回单',effect:'金额在工资管理审核；本页工资附件仅归档'},
 {id:'premises',name:'场地设备与办公',examples:'租赁合同、设备发票、水电物业、办公耗材',effect:'费用、设备资产、预付押金按业务区分'},
 {id:'software',name:'AI与软件订阅',examples:'使用账单、订阅发票、付款依据',effect:'已消耗服务与预充值分开；补票不重复记费'},
 {id:'analysis',name:'辅助分析',examples:'费用分析报告、统计截图',effect:'只作核对依据，不增加收入或费用'},
 {id:'other',name:'其他及业务配套',examples:'执行明细、服务说明、未匹配配套发票',effect:'仅归档；是否需要补充或调整由会计审核'}
];
const metricCategory=metric=>{
 if(['已确认商品销售额','销售退回冲减额','合作伙伴补贴收入'].includes(metric))return 'sales';
 if(/赔偿|扣款|货损|退货处理/.test(metric))return 'adjustments';
 if(['点击广告费','星级商品推广费'].includes(metric))return 'advertising';
 if(metric==='国际物流费')return 'international';if(metric==='尾程派送费')return 'last-mile';
 if(metric==='一般收单支付服务费')return 'acquiring';
 if(/佣金|平台|货代合同|运输合同/.test(metric))return 'platform';
 if(/工资|补贴|社保|公积金/.test(metric))return 'payroll';
 if(/采购|已售商品/.test(metric))return 'purchase';
 if(/AI|软件/.test(metric))return 'software';
 if(/场地|租金|水电|物业|办公|设备|押金/.test(metric))return 'premises';
 if(/提现|银行|汇兑/.test(metric))return 'cash';return 'other';
};
export function financeDocumentCategories(doc){
 const p=typeof doc.payload_json==='string'?JSON.parse(doc.payload_json):doc.payload_json||{};
 const ids=new Set((p.facts||[]).map(l=>metricCategory(l.metric)));
 if(['balance','currency-settlement','platform-payments','collection-cash'].includes(p.kind))ids.add('cash');
 if(p.kind==='foreign-invoice'||p.kind==='star-service')ids.add('advertising');
 if(p.kind==='payroll'||p.upload_type==='payroll')ids.add('payroll');
 if(!ids.size){
  const name=String(doc.original_name||'').replaceAll('_',' '),display=String(p.display_name||'');
  if(/费用分析|辅助分析|суммах услуг/i.test(name+' '+display))ids.add('analysis');
  else if(/Payments report|补偿及缺件|CompensationReport/i.test(name+' '+display))ids.add('adjustments');
  else if(/Star products|ЗВ\s*-|广告与推广/i.test(name+' '+display))ids.add('advertising');
  else if(/эквайринг|收单/i.test(name+' '+display))ids.add('acquiring');
  else if(/loyalty|реализации товара/i.test(name))ids.add('sales');
  else if(/set off|入账截图|结算与回款/i.test(name+' '+display))ids.add('cash');
  else if(p.upload_type==='platform-fees'||/agency agreement|Re-invoiced services|instructions|ConsigInvoice|ExecutionJobAct/i.test(name))ids.add('platform');
  else ids.add('other');
 }
 return FINANCE_FILE_CATEGORIES.filter(c=>ids.has(c.id)).map(c=>c.id);
}
