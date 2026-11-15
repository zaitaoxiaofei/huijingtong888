// Parse monetary rows from original platform text, with an independent printed-total check.
const fail=message=>{throw new Error(message);};
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
const moneyPattern=String.raw`-?(?:(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}|(?:\d{1,3}(?: \d{3})+|\d+),\d{2})`;
function number(value){const s=String(value).replace(/\s/g,'');const n=Number(s.includes('.')?s.replaceAll(',',''):s.replace(',','.'));if(!Number.isFinite(n))fail('金额无法识别');return n;}
const invoiceMetric=label=>{
 if(/Cost Per Click/i.test(label))return '点击广告费';
 if(/Electronic service for connection/i.test(label))return '平台物流连接服务费';
 if(/Ozon agency fee|Агентское вознаграждение за продажу/i.test(label))return '佣金';
 if(/Agency fee for the administration and management/i.test(label))return '国际货代合同管理服务费';
 if(/Services for the conclusion of a contract/i.test(label))return '国际运输合同缔约服务费';
 fail(`综合发票出现未支持项目：${label.slice(0,120)}，请人工核对`);
};
export function platformInvoiceFacts(flat){
 const end=flat.indexOf('In total for payment');if(end<0)fail('综合发票缺少打印合计');
 const body=flat.slice(0,end),rows=[...body.matchAll(/\b(\d{1,3})\s+([^0-9]+?)\s+-\s+642\s*pcs\b/g)];
 if(!rows.length)fail('综合发票没有可识别的商品/服务行');
 const facts=rows.map((r,i)=>{
  if(Number(r[1])!==i+1)fail('综合发票项目编号不连续，停止入账');
  const tail=body.slice(r.index+r[0].length,rows[i+1]?.index??body.length),nums=tail.match(new RegExp(moneyPattern,'g'));
  if(!nums||nums.length<3)fail('综合发票项目金额列不完整');
  return {metric:invoiceMetric(r[2].trim()),amount:round(number(nums.at(-1))),currency:'CNY',source:`发票项目${r[1]}：${r[2].trim()}`};
 });
 const total=flat.slice(end).match(/^In total for payment\s+(-?[\d,.]+)\s+(-?[\d,.]+|[—–-])\s+(-?[\d,.]+)/);
 if(!total||Math.abs(round(facts.reduce((n,f)=>n+f.amount,0))-number(total[3]))>0.01)fail('综合发票明细与打印总额不符，停止入账');
 return facts;
}
export function rechargedServiceFacts(flat){
 const start=flat.indexOf('Name of works'),end=flat.indexOf('Total services provided');if(start<0||end<0)fail('转收费报告缺少项目表或合计');const body=flat.slice(start,end);
 const rows=[...body.matchAll(/\b(\d+)\s+(Payment for acquiring services|Cross charging for international delivery services|Reinvoicing for last mile services)\s+(-?[\d ]+,\d{2})/g)];
 const facts=rows.map((m,i)=>{if(Number(m[1])!==i+1)fail('转收费项目编号不连续，存在未支持项目');return {metric:m[2].startsWith('Payment')?'一般收单支付服务费':m[2].startsWith('Reinvoicing')?'尾程派送费':'国际物流费',amount:round(number(m[3])),currency:'CNY',source:`转收费报告第${m[1]}项：${m[2]}`};});
 const total=body.match(/Total\s+([\d ]+,\d{2})/);if(!total||!facts.length||Math.abs(round(facts.reduce((n,f)=>n+f.amount,0))-number(total[1]))>0.01)fail('转收费报告明细与总额不符，停止入账');
 return facts;
}
export function paymentAdjustmentFacts(flat){
 const header=flat.match(/Payments report\s*[№#]\s*(\d+)\s+from\s+(\d{2}\.\d{2}\.20\d{2})/i),period=flat.match(/period from\s*(\d{2}\.\d{2}\.20\d{2})\s*to\s*(\d{2}\.\d{2}\.20\d{2})/i);
 if(!header||!period||!flat.includes('CNY'))fail('售后扣款报告缺少明确编号、开具日期、业务期间或CNY币种');
 const start=flat.indexOf('No. Shipment number'),end=flat.indexOf('Total payable');if(start<0||end<0)fail('售后扣款报告缺少应付总额');
 const value=String.raw`(-?[\d ]+,\d{2})`;
 const re=new RegExp(String.raw`\b(\d+)\s+([A-Za-z0-9-]+)\s+(\d{2}\.\d{2}\.20\d{2})\s+(.+?)\s+${value}\s+${value}\s+${value}\s+${value}\s+${value}`,'g');
 const rows=[...flat.slice(start,end).matchAll(re)];if(!rows.length)fail('售后扣款明细无法识别');
 const facts=rows.map((m,i)=>{
  if(Number(m[1])!==i+1)fail('售后扣款行号不连续');
  const type=m[4].trim(),metric=/^Частичная компенсация клиенту$/i.test(type)?'客户部分补偿扣款':/^Удержание за недовложение товара$/i.test(type)?'缺件扣款':null;
  const values=m.slice(5,10).map(number);if(!metric||values.slice(0,3).some(n=>n!==0)||values[3]!==values[4]||values[4]>=0)fail('售后报告含未支持的收入、费用或冲销类型，请人工核对');
  return {metric,amount:round(-values[4]),currency:'CNY',source:`报告第${m[1]}行，订单${m[2]}，发生日${m[3]}：${type}`};
 });
 const total=flat.slice(end).match(/^Total payable\s+(-?[\d ]+,\d{2})/);if(!total||Math.abs(round(facts.reduce((n,f)=>n+f.amount,0)+number(total[1])))>0.01)fail('售后扣款明细与打印应付总额不一致');
 // The source reuses a monthly number for two distinct half-month reports.
 return {facts,document_number:header[1],business_scope:[header[2],period[1],period[2]].join('|')};
}
